"""全台股產業族群資金流向: 產業分類 × 每日成交明細 → data/sector_flow.json

分類 (kind):
  main     XQ 大產業 (電子/生技醫療保健/...,互不重疊,加總=全市場)
  group    XQ 細分群組 (一檔可屬多群組,族群間會重疊,不可加總)
  cluster  自訂族群 (data/industry_chain.json: PCB/半導體/散熱/網通/電源/自動化)
  role     自訂族群 × 產業角色 (id = cluster.role)
每個群組每日: amt 成交金額(億) / share 占全市場成交% / pct 成交值加權漲跌% / up 上漲家數比%

價量來源: Drive 每日原始 CSV (STOCK_PRICE_TWSE / STOCK_PRICE_TPEX,與 build_universe.py 同一組資料夾),
  走 Service Account (GOOGLE_CREDENTIALS / DRIVE_FOLDERS),GitHub Actions 與本機相同。

增量: 讀既有 sector_flow.json,只下載「比最後一日新」的交易日並附加,保留最近 --days 日。
  分類 (群組集合) 改變或 --rebuild → 自動全量重建視窗內所有交易日。

用法: python build_sector_flow.py [--days 120] [--rebuild]
"""
import argparse
import json
import re
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_universe as bu  # noqa: E402  Drive 列檔/下載/憑證沿用
from parsers import stock_price  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
XQ = ROOT / "data" / "industry_classification.json"
CHAIN = ROOT / "data" / "industry_chain.json"
OUT = ROOT / "data" / "sector_flow.json"
MIN_ROWS = {"TWSE": 800, "TPEX": 500}  # 假日/抓取失敗的空殼檔用列數擋掉


def drive_days():
    """{market: {YYYYMMDD: file_id}}"""
    fid = bu.folder_ids()
    out = {}
    for mk, key in (("TWSE", "STOCK_PRICE_TWSE"), ("TPEX", "STOCK_PRICE_TPEX")):
        pat = bu._FILE_RE[mk]
        out[mk] = {m.group(1): f["id"] for f in bu.list_folder(fid[key]) if (m := pat.search(f["name"]))}
    return out


def load_day(d, files):
    rows = {}
    for mk in ("TWSE", "TPEX"):
        res = stock_price.parse(bu.download_bytes(files[mk][d]), market=mk, trade_date=d)
        if len(res.db_rows) < MIN_ROWS[mk]:
            return None
        for r in res.db_rows:
            rows[r["stock_id"]] = r
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=120)
    ap.add_argument("--rebuild", action="store_true")
    args = ap.parse_args()
    bu.load_env()
    n_days = args.days

    xq = json.loads(XQ.read_text(encoding="utf-8"))
    gname = {g: v["name"] for g, v in xq["groups"].items()}
    chain = json.loads(CHAIN.read_text(encoding="utf-8")) if CHAIN.exists() else None
    role_name = {}
    if chain:
        for c in chain["taxonomy"]:
            for r in c["roles"]:
                role_name[(c["id"], r["id"])] = (c["name"], r["name"])

    # 群組 → 成員 (kind, id) → set(code)
    members = defaultdict(set)
    meta = {}
    for code, s in xq["stocks"].items():
        k = ("main", s["main"])
        members[k].add(code)
        meta[k] = gname[s["main"]]
        for g in s["groups"]:
            members[("group", g)].add(code)
            meta[("group", g)] = gname[g]
    if chain:
        for code, m in chain["stocks"].items():
            if code not in xq["stocks"]:
                continue
            for ms in m["memberships"]:
                members[("cluster", ms["cluster"])].add(code)
                if ms.get("role"):
                    members[("role", f"{ms['cluster']}.{ms['role']}")].add(code)
        for c in chain["taxonomy"]:
            meta[("cluster", c["id"])] = c["name"]
        for (cid, rid), (cn, rn) in role_name.items():
            meta[("role", f"{cid}.{rid}")] = f"{cn}｜{rn}"

    keys = {f"{k[0]}:{k[1]}" for k in members}
    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() and not args.rebuild else None
    if old and {f"{g['kind']}:{g['id']}" for g in old["groups"]} != keys:
        print("分類 (群組集合) 與既有輸出不同 → 全量重建")
        old = None

    files = drive_days()
    avail = sorted(set(files["TWSE"]) & set(files["TPEX"]))
    last = old["dates"][-1] if old else ""
    todo = [d for d in avail if d > last] if old else avail[-(n_days + 30):]  # 全量時多取些,空殼日會被剔除

    def fetch(d):
        return d, load_day(d, files)
    with ThreadPoolExecutor(max_workers=6) as ex:
        loaded = [(d, r) for d, r in ex.map(fetch, todo) if r is not None]
    if old and not loaded:
        print(f"沒有新的交易日 (最後一日 {last}),不更新")
        return

    days = list(old["dates"]) if old else []
    total_amt = list(old["market_amt"]) if old else []
    series = defaultdict(lambda: defaultdict(list))
    if old:
        for g in old["groups"]:
            for f in ("amt", "share", "pct", "up"):
                series[(g["kind"], g["id"])][f] = list(g[f])

    latest = {}
    for d, rows in loaded:
        stk = {}
        for code in xq["stocks"]:
            r = rows.get(code)
            if not r or not r["turnover"] or r["close_price"] is None or r["change_amt"] is None:
                continue
            prev = r["close_price"] - r["change_amt"]
            if prev <= 0:
                continue
            stk[code] = (r["turnover"], r["change_amt"] / prev * 100)
        mkt = sum(a for a, _ in stk.values()) or 1
        latest = {c: [round(a / 1e8, 3), round(p, 2)] for c, (a, p) in stk.items()}  # 最新一日個股 [成交億, 漲跌%]
        days.append(d)
        total_amt.append(round(mkt / 1e8, 1))
        for k, codes in members.items():
            vals = [stk[c] for c in codes if c in stk]
            amt = sum(a for a, _ in vals)
            sr = series[k]
            sr["amt"].append(round(amt / 1e8, 2))
            sr["share"].append(round(amt / mkt * 100, 3))
            sr["pct"].append(round(sum(a * p for a, p in vals) / amt, 2) if amt else 0)
            sr["up"].append(round(sum(1 for _, p in vals if p > 0) / len(vals) * 100) if vals else 0)

    cut = max(0, len(days) - n_days)
    days, total_amt = days[cut:], total_amt[cut:]
    groups = []
    for k, sr in series.items():
        groups.append({"kind": k[0], "id": k[1], "name": meta[k], "n": len(members[k]),
                       **{f: v[cut:] for f, v in sr.items()}})
    OUT.write_text(json.dumps({"dates": days, "market_amt": total_amt, "latest": latest, "groups": groups},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # 摘要: 今日占比 vs 前20日平均占比
    print(f"{days[0]}~{days[-1]} 共 {len(days)} 日 | 全市場今日成交 {total_amt[-1]:.0f} 億 | {len(groups)} 群組")
    for kind in ("main", "cluster", "role"):
        rows = []
        for g in groups:
            if g["kind"] != kind or g["n"] < 3:
                continue
            base = sum(g["share"][-21:-1]) / max(1, len(g["share"][-21:-1]))
            rows.append((g["share"][-1] - base, g))
        rows.sort(key=lambda x: -x[0])
        print(f"\n[{kind}] 今日占比較前20日均 增/減")
        for dlt, g in rows[:5] + rows[-3:]:
            print(f"  {g['name'][:14]:14s} n={g['n']:4d} 成交{g['amt'][-1]:7.0f}億 占比{g['share'][-1]:5.2f}% ({dlt:+.2f}pt) 漲跌{g['pct'][-1]:+.2f}%")


if __name__ == "__main__":
    main()
