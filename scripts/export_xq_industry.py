"""從本機 XQ (XQLite) 的 SymbolCache.db 匯出「產業結構」→ data/industry_chain/xq_industry.json

唯讀 (immutable) 讀取,不連網、不碰 XQ 登入。XQ 資料屬廠商授權內容,輸出檔已列入 .gitignore,不要 commit/公開。
結構: 台股 FullID(2330.TW) → Industry 表: MainIndustry(大產業,如 電子) + SubIndustry(細分群組 id 逗號分隔)
      Groups 表 id 前綴 '1-' = 商品分類; GroupRelation 提供 大產業→細分群組 父子關係
"""
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

DB = "file:///C:/SysJust/XQLite/SvrData/SymbolCache/SymbolCache.db?mode=ro&immutable=1"
OUT = Path(__file__).resolve().parent.parent / "data" / "industry_classification.json"


def dec(b):
    if b is None or isinstance(b, (int, float)):
        return b
    for enc in ("utf-8", "cp950"):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            pass
    return b.decode("latin1")


def main():
    c = sqlite3.connect(DB, uri=True)
    c.text_factory = bytes

    def q(sql):
        return [tuple(dec(x) for x in r) for r in c.execute(sql)]

    name = {i[2:]: n for i, n in q("select ID,Name from Groups where ID like '1-G%'")}
    parent = {ch[2:]: p[2:] for p, ch in q("select ID,ChildID from GroupRelation where ID like '1-G%'")}

    stocks = defaultdict(lambda: {"main": None, "groups": []})
    for fid, main_id, sub in q("select FullID,MainIndustry,SubIndustry from Industry where FullID like '%.TW'"):
        if not main_id:
            continue
        s = stocks[fid[:-3]]
        s["main"] = main_id
        s["groups"] = [g for g in sub.split(",") if g]

    for fid, nm in q("select ID,Name from Product where FullID like '%.TW'"):
        if fid in stocks:
            stocks[fid]["name"] = nm

    used = {g for s in stocks.values() for g in s["groups"]} | {s["main"] for s in stocks.values()}
    groups = {g: {"name": name.get(g, g), "parent": parent.get(g)} for g in used}
    members = defaultdict(list)
    for code, s in stocks.items():
        for g in s["groups"]:
            members[g].append(code)

    OUT.write_text(json.dumps({"source": "XQ SymbolCache.db", "groups": groups,
                               "stocks": stocks, "members": members},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"台股 {len(stocks)} 檔 | 群組 {len(groups)} | 有細分群組 {sum(1 for s in stocks.values() if s['groups'])} 檔")


if __name__ == "__main__":
    main()
