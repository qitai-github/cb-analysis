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
         "market": "TWSE", "filename": "TWSE-Daily-{date}.csv",
         "scrape_key": "STOCK_PRICE_TWSE"},
        {"folder": "STOCK_PRICE_TPEX", "parser": stock_price,
         "market": "TPEX", "filename": "TPEx-EW-{date}.csv",
         "scrape_key": "STOCK_PRICE_TPEX"},
    ],
    "cbInstitutional": [
        # 個股法人 T86: Drive 只有 2026 起,2025 要爬 TWSE/TPEX 網站。
        # 本機 TPEX 常被擋 (anti-bot),GHA IP 可以。
        {"folder": "STOCK_INST_TWSE", "parser": stock_inst,
         "market": "TWSE", "filename": "TWSE_T86_{date}.csv",
         "scrape_key": "STOCK_INST_TWSE"},
        {"folder": "STOCK_INST_TPEX", "parser": stock_inst,
         "market": "TPEX", "filename": "TPEx_T86_{date}.csv",
         "scrape_key": "STOCK_INST_TPEX"},
    ],
    "marginTrading": [
        # 融資融券:Drive 從 2026-01-01 起有每日備份。
        # min_date 改成「Drive 不會有早於此日期的檔」,但 scrape 不受限制。
        {"folder": "MARGIN_TWSE", "parser": margin_trading,
         "market": "TWSE", "filename": "MI_MARGN_STOCK_{date}.csv",
         "drive_min_date": "20260101", "scrape_key": "MARGIN_TWSE"},
        {"folder": "MARGIN_TPEX", "parser": margin_trading,
         "market": "TPEX", "filename": "RSTA3106_{date}.csv",
         "drive_min_date": "20260101", "scrape_key": "MARGIN_TPEX"},
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


# 最早有效日落在「最後 N 個交易日」內 → 視為只有近期資料的新進股 (歷史幾乎全 0)
RECENT_FORWARD_WINDOW = 40


def update_cell(arr: list[list[Any]], sid: str, cat: str,
                date_col: int, value: Any) -> bool:
    """找 (sid, cat) 那一列 (含空白代號的延續列),把 date_col 那格更新。回 True/False。"""
    cur_code = ""
    for r in arr[1:]:
        if not r or len(r) < 3:
            continue
        c = str(r[0]).strip()
        if c:
            cur_code = c
        if cur_code != sid or str(r[2]).strip() != cat:
            continue
        while len(r) <= date_col:
            r.append("")
        r[date_col] = value
        return True
    return False


def forward_only_stocks(all_data: dict, target_stocks: set[str]) -> set[str]:
    """有 stockTrading 列、但收盤價只有最後 ~N 天有值的股。

    這種「日常 pipeline 加入後才有資料、之前全 0」的新進標的,existing_stocks
    會誤判為已存在而漏補,改由就地更新補回。已有完整歷史的股最早有效日在開頭,
    不會被誤抓;真正近期才上市的也只是補不到舊資料、無害。
    """
    arr = all_data.get("stockTrading") or []
    if len(arr) < 2:
        return set()
    hdr = [str(x) for x in arr[0]]
    date_cols = [i for i, x in enumerate(hdr) if x.isdigit() and len(x) == 8]
    if not date_cols:
        return set()
    cutoff = len(date_cols) - RECENT_FORWARD_WINDOW
    out: set[str] = set()
    cur_code = ""
    for r in arr[1:]:
        c = str(r[0]).strip()
        if c:
            cur_code = c
        if str(r[2]).strip() != "收盤價" or cur_code not in target_stocks:
            continue
        first_valid = next(
            (k for k, ci in enumerate(date_cols)
             if (r[ci] if ci < len(r) else "") not in (None, "", "-", "0", 0)),
            None)
        if first_valid is not None and first_valid >= cutoff:
            out.add(cur_code)
    return out


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
                     recent: int | None,
                     refill_stocks: set[str] = frozenset()) -> int:
    """回補單一 timeseries key。回傳異動的列/格數。

    missing  (完全沒列)        → append 整段新列
    to_update (有列但歷史殘缺) → 就地更新 cell,不新增列 (避免重複列)
    """
    sources = SOURCES[ts_key]
    parser_categories = sources[0]["parser"].CATEGORIES
    n_cats = len(parser_categories)

    existing = existing_stocks(all_data, ts_key, n_cats)
    missing = sorted(target_stocks - existing)
    # refill 只取「此 key 確實有列」的;沒列的本來就落在 missing → append
    to_update = sorted(refill_stocks & existing)
    fetch = sorted(set(missing) | set(to_update))
    if not fetch:
        log(f"\n[{ts_key}] missing=0 refill=0,跳過")
        return 0

    dates = header_dates(all_data, ts_key)
    if recent:
        dates = dates[-recent:]
    if not dates:
        log(f"\n[{ts_key}] 沒有日期可回補")
        return 0

    log(f"\n[{ts_key}] append {len(missing)} 檔 + refill {len(to_update)} 檔 "
        f"× {len(dates)} 天 × {len(sources)} 來源 = "
        f"{len(fetch)*len(dates)*len(sources)} 次查表")
    log(f"  append: {missing}")
    log(f"  refill: {to_update}")

    folder_map = drive.folder_map()

    # acc[sid][cat] = {date: value}
    acc: dict[str, dict[str, dict[str, Any]]] = {
        sid: {cat: {} for cat in parser_categories} for sid in fetch
    }
    names: dict[str, str] = {}

    missing_set = set(fetch)
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
            # 1) 先試 Drive (drive_min_date 之前的日期直接跳 Drive 改爬)
            drive_blocked = (src.get("drive_min_date")
                             and date < src["drive_min_date"])
            if folder_id and not drive_blocked:
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

    arr = all_data[ts_key]
    hdr = arr[0]
    hdr_str = [str(x) for x in hdr]
    n_cols = len(hdr)

    # ── append:完全沒列的新股,整段補上 ──────────────────────────────
    # 注意:row 必須跟 header 全範圍對齊 (不能只塞 dates 那段然後 padding),
    # 不然用 --recent N 時資料會錯位到 header 開頭。改用 header_full_dates 對齊。
    header_full_dates = [str(x) for x in hdr[3:]]
    new_rows = 0
    skipped = []
    for sid in missing:
        cat_data = acc[sid]
        if not any(cat_data[cat] for cat in parser_categories):  # 全無資料
            skipped.append(sid)
            continue
        name = names.get(sid, "")
        for i, cat in enumerate(parser_categories):
            row: list[Any] = [sid if i == 0 else "",
                              name if i == 0 else "",
                              cat]
            for d in header_full_dates:
                v = cat_data[cat].get(d)
                row.append(v if v is not None else "")
            while len(row) < n_cols:
                row.append("")
            arr.append(row)
            new_rows += 1

    # ── refill:有列但歷史殘缺,就地更新 cell ────────────────────────
    upd_cells = 0
    for sid in to_update:
        cat_data = acc[sid]
        for cat in parser_categories:
            for d, v in cat_data[cat].items():
                if v is None or d not in hdr_str:
                    continue
                if update_cell(arr, sid, cat, hdr_str.index(d), v):
                    upd_cells += 1

    log(f"  append {new_rows} rows + refill {upd_cells} cells"
        f"  (append {len(missing)-len(skipped)}/{len(missing)} 股有資料)")
    if skipped:
        log(f"  無任何資料 → 跳過: {skipped}")
    return new_rows + upd_cells


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--recent", type=int, default=None,
                   help="只回補最近 N 個交易日 (預設全部)")
    p.add_argument("--dry-run", action="store_true",
                   help="不寫回 all-data.json")
    p.add_argument("--include", type=str, default="",
                   help="額外納入的 stock id (逗號分隔),補在 primary market 之外")
    p.add_argument("--only", type=str, default="",
                   help="只回補這些 stock id (逗號分隔),忽略 primary market")
    args = p.parse_args(argv)

    if not DATA_JSON.exists():
        raise SystemExit(f"找不到 {DATA_JSON}")

    log(f"讀 {DATA_JSON.relative_to(REPO_ROOT)}")
    with open(DATA_JSON, "r", encoding="utf-8") as fh:
        all_data = json.load(fh)

    forced_refill: set[str] = set()
    if args.only:
        targets = set(s.strip() for s in args.only.split(",") if s.strip())
        log(f"--only 指定: {sorted(targets)} ({len(targets)} 檔)")
        forced_refill |= targets
    else:
        targets = primary_market_stocks(all_data)
        log(f"初級市場 + CBAS 已發行 對應股: {len(targets)} 檔")
        if args.include:
            extra = set(s.strip() for s in args.include.split(",") if s.strip())
            new = extra - targets
            log(f"--include 額外納入: {sorted(extra)} (新增 {len(new)} 檔)")
            targets |= extra
            forced_refill |= extra

    refill = forward_only_stocks(all_data, targets)
    if forced_refill:
        log(f"--only/--include 強制 refill: {sorted(forced_refill)}")
        refill |= forced_refill
    if refill:
        log(f"歷史殘缺(只有近期資料)需就地補的新進股: {sorted(refill)}")

    total = 0
    for key in SOURCES:
        total += backfill_one_key(all_data, key, targets, args.recent, refill)

    log(f"\n總計異動 {total} (append rows + refill cells)")

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
