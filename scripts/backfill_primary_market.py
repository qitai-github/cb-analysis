"""回補初級市場 / CBAS 已發行 對應股的歷史 stockTrading + cbInstitutional 資料。

背景:
  parse_and_export.py 的 filter_to_whitelist 把 stockTrading / cbInstitutional
  限縮到「白名單」(以前只有已上 CB 的股),所以從沒上過 CB 的初級市場標的
  即使 CSV 中有資料也被丟掉,主表面板看不到歷史股價和法人。

  本腳本一次性回補:
    1. 找出 missing = 初級市場相關 stockCode \\ 既有 stockTrading
    2. 從 Drive 撈每個歷史日期的 CSV (TWSE/TPEX 個股交易 + 個股法人)
    3. 抽出 missing 股的 daily values
    4. 把新 rows 接到 all-data.json 的 stockTrading / cbInstitutional

跑法 (從 scripts/):
  python backfill_primary_market.py             # 全部歷史
  python backfill_primary_market.py --recent 60 # 只回補最近 60 個交易日
  python backfill_primary_market.py --dry-run   # 不寫 JSON
"""

from __future__ import annotations

import argparse
import json
import os
import re
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

# 讀 .env (GOOGLE_CREDENTIALS / DRIVE_FOLDERS) — 手動 parse 避免 dotenv 截多行
def _load_env() -> None:
    env_path = SCRIPTS_DIR / ".env"
    if not env_path.exists():
        return
    txt = env_path.read_text(encoding="utf-8")
    m = re.search(r"GOOGLE_CREDENTIALS=(\{.*?\})\nDRIVE_FOLDERS=", txt, re.DOTALL)
    if m:
        os.environ["GOOGLE_CREDENTIALS"] = json.dumps(
            json.loads(m.group(1), strict=False))
    m2 = re.search(r"DRIVE_FOLDERS=(\{.*?\})\s*$", txt, re.DOTALL | re.MULTILINE)
    if m2:
        os.environ["DRIVE_FOLDERS"] = m2.group(1)


_load_env()

from lib import drive  # noqa: E402
from parsers import margin_trading, stock_inst, stock_price  # noqa: E402
import fetch_stocks  # noqa: E402  (拿 SOURCE_RULES + fetch_source 做 scrape fallback)

# TPEx 憑證偶爾缺 Subject Key Identifier 害 SSL handshake 失敗 + 30 秒 retry。
# 只在 backfill 走 scrape 時放寬,Drive API 不走 requests 不受影響。
import requests as _req  # noqa: E402
import urllib3 as _ul3  # noqa: E402
_ul3.disable_warnings(_ul3.exceptions.InsecureRequestWarning)
_orig_request = _req.Session.request
def _request_no_verify(self, method, url, **kw):
    kw.setdefault("verify", False)
    return _orig_request(self, method, url, **kw)
_req.Session.request = _request_no_verify

REPO_ROOT = SCRIPTS_DIR.parent
DATA_JSON = REPO_ROOT / "data" / "all-data.json"

# 每個 timeseries 對應的多個 (folder_key, parser, market, filename_tpl[, scrape_key])
# scrape_key 有設 → Drive miss 時自動 fallback 去 fetch_stocks.SOURCE_RULES 那邊直接爬。
SOURCES: dict[str, list[dict[str, Any]]] = {
    "stockTrading": [
        {"folder": "STOCK_PRICE_TWSE", "parser": stock_price,
         "market": "TWSE", "filename": "TWSE-Daily-{date}.csv"},
        {"folder": "STOCK_PRICE_TPEX", "parser": stock_price,
         "market": "TPEX", "filename": "TPEx-EW-{date}.csv"},
    ],
    "cbInstitutional": [
        {"folder": "STOCK_INST_TWSE", "parser": stock_inst,
         "market": "TWSE", "filename": "TWSE_T86_{date}.csv"},
        {"folder": "STOCK_INST_TPEX", "parser": stock_inst,
         "market": "TPEX", "filename": "TPEx_T86_{date}.csv"},
    ],
    "marginTrading": [
        # 融資融券 Drive 只有最近 ~2 週,其餘走 fetch_stocks 直接爬 TWSE/TPEx
        {"folder": "MARGIN_TWSE", "parser": margin_trading,
         "market": "TWSE", "filename": "MI_MARGN_STOCK_{date}.csv",
         "scrape_key": "MARGIN_TWSE"},
        {"folder": "MARGIN_TPEX", "parser": margin_trading,
         "market": "TPEX", "filename": "RSTA3106_{date}.csv",
         "scrape_key": "MARGIN_TPEX"},
    ],
}


def log(msg: str) -> None:
    print(msg, flush=True)


# ── 從 all-data.json 算出 missing stocks ──────────────────────────────
def _stock4(cb: Any) -> str | None:
    s = str(cb or "").strip()
    if s.isdigit() and len(s) >= 4:
        return s[:4]
    return None


def primary_market_stocks(all_data: dict) -> set[str]:
    """所有初級市場 / CBAS 已發行 對應股 (cbCode 前 4 碼)。"""
    codes: set[str] = set()
    for r in (all_data.get("fubonPrimary") or []):
        if r:
            c = _stock4(r[0] if len(r) > 0 else "")
            if c: codes.add(c)
    for r in (all_data.get("yuantaPrimary") or []):
        if r:
            c = _stock4(r[2] if len(r) > 2 else "")
            if c: codes.add(c)
    cal = all_data.get("cbasCalendar") or {}
    for ev in (cal.get("events") or []):
        c = _stock4(ev.get("cbCode"))
        if c: codes.add(c)
    for cb in (cal.get("issuedInfo") or {}):
        c = _stock4(cb)
        if c: codes.add(c)
    return codes


def existing_stocks(all_data: dict, key: str, n_cats: int) -> set[str]:
    arr = all_data.get(key) or []
    if len(arr) < 2:
        return set()
    out = set()
    i = 1
    while i < len(arr):
        sid = str(arr[i][0]).strip() if arr[i] else ""
        if sid: out.add(sid)
        i += n_cats
    return out


def header_dates(all_data: dict, key: str) -> list[str]:
    arr = all_data.get(key) or []
    if not arr: return []
    hdr = arr[0]
    return [str(x) for x in hdr[3:]
            if str(x).isdigit() and len(str(x)) == 8]


# ── 主邏輯 ────────────────────────────────────────────────────────────
def backfill_one_key(all_data: dict, ts_key: str, target_stocks: set[str],
                     recent: int | None) -> int:
    """回補單一 timeseries key。回傳新增的 rows 數。"""
    sources = SOURCES[ts_key]
    parser_categories = sources[0]["parser"].CATEGORIES
    n_cats = len(parser_categories)

    # 算出 missing = target_stocks \ existing
    existing = existing_stocks(all_data, ts_key, n_cats)
    missing = sorted(target_stocks - existing)
    if not missing:
        log(f"\n[{ts_key}] missing = 0,跳過")
        return 0

    dates = header_dates(all_data, ts_key)
    if recent:
        dates = dates[-recent:]
    if not dates:
        log(f"\n[{ts_key}] 沒有日期可回補")
        return 0

    log(f"\n[{ts_key}] missing {len(missing)} 檔 × {len(dates)} 天 "
        f"× {len(sources)} 來源 = {len(missing)*len(dates)*len(sources)} 次查表")
    log(f"  目標股: {missing}")

    folder_map = drive.folder_map()

    # acc[sid][cat] = {date: value}
    acc: dict[str, dict[str, dict[str, Any]]] = {
        sid: {cat: {} for cat in parser_categories} for sid in missing
    }
    names: dict[str, str] = {}

    missing_set = set(missing)
    t0 = time.time()
    fail_dates: list[tuple[str, str]] = []

    for i, date in enumerate(dates):
        if i and i % 20 == 0:
            elapsed = time.time() - t0
            pct = (i / len(dates)) * 100
            eta = elapsed / i * (len(dates) - i)
            log(f"  [{i}/{len(dates)}] {pct:.0f}%  elapsed={elapsed:.0f}s  ETA={eta:.0f}s")

        for src in sources:
            folder_id = folder_map.get(src["folder"])
            blob = None
            # 1) 先試 Drive
            if folder_id:
                fname = src["filename"].format(date=date)
                try:
                    blob = drive.download(folder_id, fname)
                except Exception as e:  # noqa: BLE001
                    fail_dates.append((date, f"drive: {str(e)[:40]}"))

            # 2) Drive 沒檔 + scrape_key 有設 → 直接爬 TWSE/TPEx
            if blob is None and src.get("scrape_key"):
                rule = fetch_stocks.SOURCE_RULES[src["scrape_key"]]
                try:
                    raw = fetch_stocks.fetch_source(rule, date)
                except Exception as e:  # noqa: BLE001
                    fail_dates.append((date, f"scrape: {str(e)[:40]}"))
                    continue
                if raw is None:
                    continue  # 該日無資料 (假日 / 尚未公布)
                blob = fetch_stocks.prepare_upload_bytes(rule, raw)

            if blob is None:
                continue
            try:
                result = src["parser"].parse(
                    blob, market=src["market"], trade_date=date)
            except Exception as e:  # noqa: BLE001
                fail_dates.append((date, f"parse fail: {str(e)[:40]}"))
                continue
            for sid in missing_set:
                vals = result.daily_values.get(sid)
                if not vals: continue
                nm = result.stock_names.get(sid)
                if nm: names.setdefault(sid, nm)
                for cat, val in vals.items():
                    if val is None: continue
                    acc[sid][cat][date] = val

    log(f"  完成 {len(dates)} 天,耗時 {time.time()-t0:.0f}s, "
        f"download fail {len(fail_dates)} 次")

    # 把 acc 整成 rows,append 到 all_data[ts_key]
    arr = all_data[ts_key]
    hdr = arr[0]
    n_cols = len(hdr)

    new_rows = 0
    skipped = []
    for sid in missing:
        cat_data = acc[sid]
        # 有任一 category 有值才寫
        if not any(cat_data[cat] for cat in parser_categories):
            skipped.append(sid)
            continue
        name = names.get(sid, "")
        for i, cat in enumerate(parser_categories):
            row: list[Any] = [sid if i == 0 else "",
                              name if i == 0 else "",
                              cat]
            for d in dates:
                v = cat_data[cat].get(d)
                row.append(v if v is not None else "")
            while len(row) < n_cols:
                row.append("")
            arr.append(row)
            new_rows += 1

    log(f"  寫入 {new_rows} rows  ({len(missing)-len(skipped)}/{len(missing)} 股有資料)")
    if skipped:
        log(f"  無任何資料 → 跳過: {skipped}")
    return new_rows


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--recent", type=int, default=None,
                   help="只回補最近 N 個交易日 (預設全部)")
    p.add_argument("--dry-run", action="store_true",
                   help="不寫回 all-data.json")
    args = p.parse_args(argv)

    if not DATA_JSON.exists():
        raise SystemExit(f"找不到 {DATA_JSON}")

    log(f"讀 {DATA_JSON.relative_to(REPO_ROOT)}")
    with open(DATA_JSON, "r", encoding="utf-8") as fh:
        all_data = json.load(fh)

    targets = primary_market_stocks(all_data)
    log(f"初級市場 + CBAS 已發行 對應股: {len(targets)} 檔")

    total = 0
    for key in SOURCES:
        total += backfill_one_key(all_data, key, targets, args.recent)

    log(f"\n總計新增 {total} rows")

    if args.dry_run:
        log("--dry-run,不寫 JSON")
        return 0

    out_size = 0
    log(f"\n寫回 {DATA_JSON.relative_to(REPO_ROOT)}")
    with open(DATA_JSON, "w", encoding="utf-8") as fh:
        json.dump(all_data, fh, ensure_ascii=False, separators=(",", ":"))
    out_size = DATA_JSON.stat().st_size / 1024 / 1024
    log(f"  ✓ {out_size:.2f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
