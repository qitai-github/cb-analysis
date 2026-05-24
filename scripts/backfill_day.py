"""補抓特定股 (已存在於 all-data.json) 某幾天的資料 — 覆蓋現有儲存格,不新增 row。

用途:
  pipeline 抓單日資料偶爾會漏 (GAS / TWSE timeout),導致某股某日全 0,
  K 線出現空洞。這支腳本針對性重抓 (stock, date) 單日,
  把 stockTrading / cbInstitutional / marginTrading 的對應 cell 蓋回去。

  跟 backfill_primary_market.py 不同:
    - primary_market: 新增「從來沒抓過」的股票整段歷史 (append new rows)
    - day:           更新「已抓過但某日漏」的儲存格 (update cells in place)

跑法 (從 scripts/):
  python backfill_day.py --stock 1472 --date 20260521
  python backfill_day.py --stocks 1472,2436 --date 20260521
  python backfill_day.py --stock 1472 --dates 20260521,20260522
  python backfill_day.py --stock 1472 --date 20260521 --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

# Windows console UTF-8
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

# 重用 primary 腳本的 .env / SOURCES / 路徑常數
from backfill_primary_market import (  # noqa: E402
    DATA_JSON, REPO_ROOT, SOURCES, _load_env  # _load_env 已在 import 時 run
)
from lib import drive  # noqa: E402
import fetch_stocks  # noqa: E402


def log(msg: str) -> None:
    print(msg, flush=True)


def update_cell(arr: list[list[Any]], sid: str, cat: str,
                date_col: int, value: Any) -> bool:
    """找 (sid, cat) 那一列,把 date_col 那格更新為 value。回 True/False。"""
    cur_code = ""
    for r in arr[1:]:
        if not r or len(r) < 3:
            continue
        c = str(r[0]).strip()
        if c:
            cur_code = c
        if cur_code != sid:
            continue
        if str(r[2]).strip() != cat:
            continue
        # 對到了
        while len(r) <= date_col:
            r.append("")
        r[date_col] = value
        return True
    return False


def backfill_day_one_key(all_data: dict, ts_key: str,
                         stocks: list[str], dates: list[str]) -> int:
    sources = SOURCES[ts_key]
    arr = all_data.get(ts_key) or []
    if len(arr) < 1:
        log(f"\n[{ts_key}] all-data.json 沒有此欄位,跳過")
        return 0
    hdr_str = [str(x) for x in arr[0]]

    folder_map = drive.folder_map()
    updated = 0

    for date in dates:
        if date not in hdr_str:
            log(f"\n[{ts_key}] {date} 不在 header,跳過")
            continue
        date_col = hdr_str.index(date)
        log(f"\n[{ts_key}] {date} (col {date_col}) — stocks={stocks}")

        for src in sources:
            folder_id = folder_map.get(src["folder"])
            blob = None
            src_label = f"{src['market']}/{src['folder']}"

            # 1) Drive
            if folder_id:
                fname = src["filename"].format(date=date)
                try:
                    blob = drive.download(folder_id, fname)
                except Exception as e:  # noqa: BLE001
                    log(f"  [{src_label}] drive miss: {str(e)[:60]}")
            # 2) scrape fallback (主要給 margin)
            if blob is None and src.get("scrape_key"):
                rule = fetch_stocks.SOURCE_RULES[src["scrape_key"]]
                try:
                    raw = fetch_stocks.fetch_source(rule, date)
                except Exception as e:  # noqa: BLE001
                    log(f"  [{src_label}] scrape fail: {str(e)[:60]}")
                    continue
                if raw is None:
                    log(f"  [{src_label}] scrape returned None")
                    continue
                blob = fetch_stocks.prepare_upload_bytes(rule, raw)
            if blob is None:
                continue

            try:
                result = src["parser"].parse(
                    blob, market=src["market"], trade_date=date)
            except Exception as e:  # noqa: BLE001
                log(f"  [{src_label}] parse fail: {str(e)[:60]}")
                continue

            for sid in stocks:
                vals = result.daily_values.get(sid)
                if not vals:
                    continue
                wrote_cats: list[str] = []
                for cat, val in vals.items():
                    if val is None:
                        continue
                    if update_cell(arr, sid, cat, date_col, val):
                        updated += 1
                        wrote_cats.append(cat)
                if wrote_cats:
                    log(f"  [{src_label}] {sid}: ✓ {wrote_cats}")
                else:
                    log(f"  [{src_label}] {sid}: 有資料但找不到對應 row (新股?)")

    return updated


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    g_s = p.add_mutually_exclusive_group(required=True)
    g_s.add_argument("--stock", type=str, help="單一股號")
    g_s.add_argument("--stocks", type=str,
                     help="多股,逗號分隔 e.g. 1472,2436")
    g_d = p.add_mutually_exclusive_group(required=True)
    g_d.add_argument("--date", type=str, help="單一日期 YYYYMMDD")
    g_d.add_argument("--dates", type=str,
                     help="多日,逗號分隔 e.g. 20260521,20260522")
    p.add_argument("--keys", type=str,
                   default="stockTrading,cbInstitutional,marginTrading",
                   help="要回補哪幾個 timeseries (逗號分隔)")
    p.add_argument("--dry-run", action="store_true",
                   help="不寫回 all-data.json")
    args = p.parse_args(argv)

    stocks = ([args.stock] if args.stock
              else [s.strip() for s in args.stocks.split(",") if s.strip()])
    dates = ([args.date] if args.date
             else [d.strip() for d in args.dates.split(",") if d.strip()])
    keys = [k.strip() for k in args.keys.split(",") if k.strip()]

    bad_d = [d for d in dates if not (d.isdigit() and len(d) == 8)]
    if bad_d:
        raise SystemExit(f"date 格式錯誤 (要 YYYYMMDD): {bad_d}")
    bad_k = [k for k in keys if k not in SOURCES]
    if bad_k:
        raise SystemExit(f"未知 timeseries key: {bad_k}, 支援: {list(SOURCES)}")

    if not DATA_JSON.exists():
        raise SystemExit(f"找不到 {DATA_JSON}")

    log(f"讀 {DATA_JSON.relative_to(REPO_ROOT)}")
    with open(DATA_JSON, "r", encoding="utf-8") as fh:
        all_data = json.load(fh)

    log(f"目標股: {stocks}")
    log(f"目標日: {dates}")
    log(f"目標 keys: {keys}")

    t0 = time.time()
    total = 0
    for key in keys:
        total += backfill_day_one_key(all_data, key, stocks, dates)

    log(f"\n總計更新 {total} 個 cell ({time.time()-t0:.0f}s)")

    if args.dry_run:
        log("--dry-run, 不寫 JSON")
        return 0
    if total == 0:
        log("沒有任何 cell 被更新, 不重寫 JSON")
        return 0

    log(f"\n寫回 {DATA_JSON.relative_to(REPO_ROOT)}")
    with open(DATA_JSON, "w", encoding="utf-8") as fh:
        json.dump(all_data, fh, ensure_ascii=False, separators=(",", ":"))
    out_size = DATA_JSON.stat().st_size / 1024 / 1024
    log(f"  ✓ {out_size:.2f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
