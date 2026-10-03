"""產業族群資料庫: 台股公司主檔 + taxonomy + curated → data/industry_chain.json

主檔來源 = all-data.json 的 stockIndustry (Google Sheet「台股公司主檔」: 產業分類1/2 + 最多46個概念股標籤)。
主檔的概念標籤是新聞題材,不是供應鏈角色,所以只用來產生「候選」(candidates),
真正的歸屬 (族群+角色+細分) 只來自 data/industry_chain/curated.json。

用法: python scripts/build_industry_chain.py   (輸出覆蓋率報告)
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "all-data.json"
DIR = ROOT / "data" / "industry_chain"
OUT = ROOT / "data" / "industry_chain.json"

# 候選規則: 概念標籤關鍵字 / 產業分類 → 族群。只產生候選,供人工/AI 後續確認角色。
TAG_RULES = {
    "pcb": ["HDI", "IC基板", "軟板", "載板", "PCB", "ABF", "銅箔基板"],
    "semi": ["台積", "CoWoS", "先進封裝", "半導體", "封測", "晶圓"],
    "thermal": ["散熱", "液冷", "水冷"],
    "network": ["5G", "低軌衛星", "光通訊", "矽光", "CPO", "交換器", "網通", "WiFi", "Wi-Fi"],
    "power": ["電源", "BBU", "儲能", "電池", "缺電"],
    "automation": ["機器人", "自動化", "工業4.0", "智慧製造", "智慧工廠"],
}
INDUSTRY_RULES = {"半導體業": "semi", "通信網路業": "network", "電機機械": "automation"}


def load_master():
    rows = json.loads(SRC.read_text(encoding="utf-8"))["stockIndustry"][1:]
    for r in rows:
        tags = [t for t in r[5:] if t and t != "-"]
        yield {
            "code": r[0].strip(),
            "name": r[1].strip(),
            "industry1": r[3],
            "industry2": "" if r[4] == "-" else r[4],
            "tags": tags,
        }


def assign_from_xq(tax, stocks):
    """XQ 細分群組 → 族群/角色 (xq_mapping.json)。人工 curated 已有同族群者優先,不覆蓋。"""
    xq_path = ROOT / "data" / "industry_classification.json"
    if not xq_path.exists():
        return
    xq = json.loads(xq_path.read_text(encoding="utf-8"))
    mapping = json.loads((DIR / "xq_mapping.json").read_text(encoding="utf-8"))
    gname = {g: v["name"] for g, v in xq["groups"].items()}
    order = {c["id"]: [r["id"] for r in c["roles"]] for c in tax["clusters"]}
    # 群組名稱 → [(cluster, role)]  (名稱可對應多個 id,所以用名稱比對)
    by_name = defaultdict(list)
    for cl, roles in mapping.items():
        if cl == "note":
            continue
        for role, names in roles.items():
            for n in names:
                by_name[n].append((cl, None if role == "null" else role))
    for code, m in stocks.items():
        x = xq["stocks"].get(code)
        if not x:
            continue
        m["xq_groups"] = [gname[g] for g in x["groups"]]
        hits = defaultdict(lambda: defaultdict(list))  # cluster -> role -> [group names]
        for g in x["groups"]:
            for cl, role in by_name.get(gname[g], []):
                hits[cl][role].append(gname[g])
        for cl, roles in hits.items():
            if any(e["cluster"] == cl for e in m["memberships"]):
                continue
            ranked = sorted((r for r in roles if r), key=lambda r: (-len(roles[r]), order[cl].index(r)))
            subs = [n for r in roles for n in roles[r]]
            m["memberships"].append({"cluster": cl, "role": ranked[0] if ranked else None,
                                     "subs": subs, "basis": "xq", "confidence": "med" if ranked else "low"})


def auto_chains(xq, stocks, max_roles=14, min_n=3):
    """每個 XQ 大產業自動生成一條鏈: 角色 = 該大產業下檔數最多的細分群組 (其餘併「其他」)。
    一檔只歸一個角色 (取它所屬群組中檔數最多者),所以各角色互不重疊、可加總。"""
    gname = {g: v["name"] for g, v in xq["groups"].items()}
    size = {g: len(v) for g, v in xq["members"].items()}
    by_main = defaultdict(list)
    for code, x in xq["stocks"].items():
        by_main[x["main"]].append(code)
    clusters = []
    for mid, codes in sorted(by_main.items(), key=lambda kv: -len(kv[1])):
        cnt = defaultdict(int)
        for c in codes:
            for g in xq["stocks"][c]["groups"]:
                cnt[g] += 1
        roles = [g for g, n in sorted(cnt.items(), key=lambda kv: -kv[1]) if n >= min_n][:max_roles]
        rank = {g: i for i, g in enumerate(roles)}
        cid = "m" + mid
        for c in codes:
            mine = [g for g in xq["stocks"][c]["groups"] if g in rank]
            role = min(mine, key=lambda g: rank[g]) if mine else "other"
            subs = [gname[g] for g in xq["stocks"][c]["groups"]][:3]
            stocks[c]["memberships"].append({"cluster": cid, "role": role, "subs": subs,
                                             "basis": "xq", "confidence": "low"})
        rl = [{"id": g, "name": gname[g]} for g in roles]
        if any(m["memberships"][-1]["role"] == "other" for m in (stocks[c] for c in codes) if m["memberships"][-1]["cluster"] == cid):
            rl.append({"id": "other", "name": "其他"})
        clusters.append({"id": cid, "name": gname[mid], "icon": "folder", "auto": True, "roles": rl})
    return clusters


def main():
    tax = json.loads((DIR / "taxonomy.json").read_text(encoding="utf-8"))
    curd = json.loads((DIR / "curated.json").read_text(encoding="utf-8"))
    cur, refs = curd["entries"], curd.get("source_refs", {})
    valid = {c["id"]: {r["id"] for r in c["roles"]} for c in tax["clusters"]}

    stocks = {m["code"]: m for m in load_master()}
    xq_path = ROOT / "data" / "industry_classification.json"
    xq = json.loads(xq_path.read_text(encoding="utf-8")) if xq_path.exists() else None
    if xq:  # 全市場: 主檔 (CB 對應個股) 以外的 XQ 個股也納入
        for code, x in xq["stocks"].items():
            stocks.setdefault(code, {"code": code, "name": x.get("name", code), "industry1": "", "industry2": "", "tags": []})
    for m in stocks.values():
        m["memberships"] = []
        m["candidates"] = []

    for e in cur:
        if e["cluster"] not in valid or e["role"] not in valid[e["cluster"]]:
            sys.exit(f"curated 錯誤: {e}")
        if e["code"] not in stocks:
            sys.exit(f"curated 代號不在主檔: {e['code']}")
        ms = {k: e[k] for k in ("cluster", "role", "subs", "basis", "confidence") if k in e}
        if e.get("sources"):
            ms["sources"] = [refs.get(k, k).replace("{code}", e["code"]) for k in e["sources"]]
        stocks[e["code"]]["memberships"].append(ms)

    assign_from_xq(tax, stocks)
    auto = auto_chains(xq, stocks) if xq else []
    tax["clusters"] = tax["clusters"] + auto

    cand = defaultdict(list)
    for code, m in stocks.items():
        hit = set()
        for cl, kws in TAG_RULES.items():
            if any(k.lower() in t.lower() for t in m["tags"] for k in kws):
                hit.add(cl)
        if m["industry1"] in INDUSTRY_RULES:
            hit.add(INDUSTRY_RULES[m["industry1"]])
        done = {x["cluster"] for x in m["memberships"]}
        m["candidates"] = sorted(hit - done)
        for cl in m["candidates"]:
            cand[cl].append(code)

    slim = {c: {k: v for k, v in m.items() if k not in ("tags", "candidates", "xq_groups")} for c, m in stocks.items()}
    OUT.write_text(json.dumps({"taxonomy": tax["clusters"], "stocks": slim},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"主檔 {len(stocks)} 檔 | 已確認 {sum(1 for m in stocks.values() if m['memberships'])} 檔")
    for c in tax["clusters"]:
        n_ok = sum(1 for m in stocks.values() if any(x["cluster"] == c["id"] for x in m["memberships"]))
        n_norole = sum(1 for m in stocks.values() if any(x["cluster"] == c["id"] and not x.get("role") for x in m["memberships"]))
        print(f"  {c['name']:8s} 已歸屬 {n_ok:3d} (角色待定 {n_norole:2d}) | 規則候選 {len(cand[c['id']]):3d}")


if __name__ == "__main__":
    main()
