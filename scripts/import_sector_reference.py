"""匯入參考用的「板塊」分類快照 → data/industry_chain/sectors.json

來源: 參考資料/tide/ (使用者自行下載存放的 latest.json + sector_groups.json)。
只取 大類 → 板塊 → 成員個股代號;不取任何說明文字。
快照式 (不會自動更新): 想更新時由使用者重新下載兩個檔放進該資料夾後重跑本腳本。
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / "參考資料" / "tide"
OUT = ROOT / "data" / "industry_chain" / "sectors.json"


def main():
    latest = json.loads((REF / "latest.json").read_text(encoding="utf-8"))
    groups = json.loads((REF / "sector_groups.json").read_text(encoding="utf-8"))
    members = {s["name"]: [str(c) for c in s["stocks"]] for s in latest["sectors"]}
    missing = [n for g in groups.values() for n in g if n not in members]
    extra = [n for n in members if not any(n in g for g in groups.values())]
    if missing or extra:
        print("警告: 大類與板塊對不上", {"missing": missing, "extra": extra})
    out = {"asOf": latest.get("date"), "groups": groups,
           "sectors": {n: members[n] for g in groups.values() for n in g if n in members}}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(groups)} 大類 / {len(out['sectors'])} 板塊 / 資料日 {out['asOf']} → {OUT.name}")


if __name__ == "__main__":
    main()
