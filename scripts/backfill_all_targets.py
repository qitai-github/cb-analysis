"""把 all-data.json 裡「網頁上所有標的」的 stockTrading / cbInstitutional /
marginTrading 三個 timeseries,從 header 最早日期 (2025-01-02) 起全部就地補齊。

作法:收集三個 key 內出現過的所有股票代號 → 當成 backfill_primary_market 的
`--only` 目標 (強制 refill 全部),逐日從 Drive 直讀 CSV 重填每一格。
download 是「每日一次」不分股數,所以補全部標的的成本≈補單一標的。

跑法 (從 scripts/):
  python backfill_all_targets.py            # 真跑 (會覆寫 all-data.json)
  python backfill_all_targets.py --dry-run  # 只看計畫不寫檔
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import backfill_primary_market as bpm  # noqa: E402

KEYS = ("stockTrading", "cbInstitutional", "marginTrading")


def all_target_ids(all_data: dict) -> list[str]:
    ids: set[str] = set()
    for k in KEYS:
        for r in (all_data.get(k) or [])[1:]:
            c = str(r[0]).strip() if r else ""
            if c.isdigit() and len(c) >= 4:
                ids.add(c)
    return sorted(ids)


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    with open(bpm.DATA_JSON, encoding="utf-8") as fh:
        all_data = json.load(fh)
    ids = all_target_ids(all_data)
    print(f"網頁上所有標的: {len(ids)} 檔 → 強制 refill 全部 header 日期 (2025-01-02 起)")
    args = ["--only", ",".join(ids)]
    if "--dry-run" in argv:
        args.append("--dry-run")
    return bpm.main(args)


if __name__ == "__main__":
    sys.exit(main())
