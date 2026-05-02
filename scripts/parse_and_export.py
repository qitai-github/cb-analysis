"""Step 3 主編排:
  1. 從 Drive 下載 6 個 CSV (假設 fetch_stocks.py 剛跑完)
  2. 跑 4 個 parser → db_rows + daily_values
  3. Upsert 到 Supabase (4 張表)
  4. 讀既有 data/all-data.json,合併 4 個 timeseries key (今日 column)
  5. 從 Google Sheet 讀 5 個非-CSV key 覆蓋
  6. 寫回 data/all-data.json
  7. 寫 fetch_runs 監控紀錄

跑法 (從 scripts/ 目錄):
  python parse_and_export.py                   # 抓今天 (台北)
  python parse_and_export.py 20260424          # 補抓特定日期
  python parse_and_export.py --dry-run         # 不寫 DB / 不寫 JSON
  python parse_and_export.py --skip-db         # 不寫 Supabase
  python parse_and_export.py --skip-sheet      # 跳過 5 個 Sheet (debug)
  python parse_and_export.py --skip-json       # 不寫 data/all-data.json

Dev mode (本機沒 Drive 憑證時):
  $env:DRIVE_FROM_FIXTURES = "1"
  python parse_and_export.py 20260424 --skip-db --skip-sheet
  → CSV 改從 scripts/tests/fixtures/ 讀,只寫本地 JSON
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

# Windows console UTF-8
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# 讓 `python parse_and_export.py` 在 scripts/ 跑得起來
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

# 自動載入 scripts/.env (本機開發用; GitHub Actions 已注入 secrets 不會被覆蓋)
try:
    from dotenv import load_dotenv
    load_dotenv(SCRIPTS_DIR / ".env", override=False)
except ImportError:
    pass  # 沒裝 python-dotenv 也能跑,前提是 env 已外部設好

from lib import drive, sheets, supabase_client, telegram, timeseries_merge  # noqa: E402
from parsers import cb_inst, cb_price, stock_inst, stock_price  # noqa: E402

# 直接爬網頁的 fallback (當 Drive 沒檔時用,例如當日 TWSE T86 16:00 才公布,
# GAS HealthCheck 隔天 09:30 才抓)。fetch_stocks.py 有完整的 anti-bot 邏輯
# (referer 暖身/cookie/重試),這裡 import 來重用。
import fetch_stocks  # noqa: E402

REPO_ROOT = SCRIPTS_DIR.parent
DATA_JSON = REPO_ROOT / "data" / "all-data.json"
TAIPEI = timezone(timedelta(hours=8))

# ── 6 CSV 來源 ────────────────────────────────────────────────────────
SOURCES = [
    {
        "folder_key": "STOCK_INST_TWSE",
        "filename": "TWSE_T86_{date}.csv",
        "parser": stock_inst,
        "kwargs": {"market": "TWSE"},
        "label": "個股法人(上市)",
    },
    {
        "folder_key": "STOCK_INST_TPEX",
        "filename": "TPEx_T86_{date}.csv",
        "parser": stock_inst,
        "kwargs": {"market": "TPEX"},
        "label": "個股法人(上櫃)",
    },
    {
        "folder_key": "STOCK_PRICE_TWSE",
        "filename": "TWSE-Daily-{date}.csv",
        "parser": stock_price,
        "kwargs": {"market": "TWSE"},
        "label": "個股交易(上市)",
    },
    {
        "folder_key": "STOCK_PRICE_TPEX",
        "filename": "TPEx-EW-{date}.csv",
        "parser": stock_price,
        "kwargs": {"market": "TPEX"},
        "label": "個股交易(上櫃)",
    },
    {
        "folder_key": "CB_PRICE",
        "filename": "RSta0113.{date}-C.csv",
        "parser": cb_price,
        "kwargs": {},
        "label": "CB 每日交易",
    },
    {
        "folder_key": "CB_INST",
        "filename": "ThreePrimaryCB_{date}.csv",
        "parser": cb_inst,
        "kwargs": {},
        "label": "CB 每日法人",
    },
]

# ── 5 個 Sheet 來源 (對齊 js/config.js DATA_SOURCES) ──────────────────
SHEET_SOURCES = [
    {"key": "cbDailyReport",
     "sheet_id": "1kAExOpabAvR2gsbTyNoM_oGWSZXHkiFm_60FH_6DTbw",
     "gid": "803170134", "name": "CB交易日報"},
    {"key": "fubonPrimary",
     "sheet_id": "1kAExOpabAvR2gsbTyNoM_oGWSZXHkiFm_60FH_6DTbw",
     "gid": "953953291", "name": "富邦CB初級"},
    {"key": "yuantaPrimary",
     "sheet_id": "1kAExOpabAvR2gsbTyNoM_oGWSZXHkiFm_60FH_6DTbw",
     "gid": "1557790812", "name": "元大CB初級"},
    {"key": "stockIndustry",
     "sheet_id": "1JdhzgbEWFlJwYA_7WYxhQxYIV2gadvXfK4-zv0timvA",
     "gid": "699020116", "name": "公司主檔"},
    {"key": "stockNews",
     "sheet_id": "1kAExOpabAvR2gsbTyNoM_oGWSZXHkiFm_60FH_6DTbw",
     "gid": "1094399736", "name": "新聞資訊"},
]

CONFLICT_KEY = {
    "stock_quotes": "trade_date,market,stock_id",
    "stock_inst":   "trade_date,market,stock_id",
    "cb_quotes":    "trade_date,cb_id",
    "cb_inst":      "trade_date,cb_id",
}

# 個股 timeseries 必須過濾,否則 T86 把全部權證都塞進來會把 JSON 從 8MB 暴衝到 39MB
# 且 Supabase free tier 撐不住。CB 來源量小,不過濾。
FILTERED_TIMESERIES_KEYS = {"stockTrading", "cbInstitutional"}


# ── 共用工具 ──────────────────────────────────────────────────────────
def log(msg: str) -> None:
    ts = datetime.now(TAIPEI).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def parse_date_arg(arg: Optional[str]) -> str:
    if arg:
        s = arg.replace("-", "")
        if len(s) != 8 or not s.isdigit():
            raise SystemExit(f"日期格式錯誤: {arg!r}; 預期 YYYYMMDD")
        return s
    return datetime.now(TAIPEI).strftime("%Y%m%d")


def _to_iso(yyyymmdd: str) -> str:
    return f"{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:8]}"


def _record(trade_date: str, source: str, phase: str, status: str,
            *, count: Optional[int] = None, error: Optional[str] = None,
            enabled: bool = True) -> None:
    """寫 fetch_runs;不影響主流程。enabled=False 時 silent skip。"""
    if not enabled:
        return
    if not os.environ.get("SUPABASE_URL"):
        return
    try:
        supabase_client.record_run(
            trade_date=_to_iso(trade_date),
            source=source, phase=phase, status=status,
            row_count=count, error_msg=error,
        )
    except Exception:
        pass


# ── Phase 1: Drive 下載 + 解析 ────────────────────────────────────────
def fetch_and_parse(trade_date: str, *, record_db: bool):
    """回傳 (parsed_results, source_states)。

    parsed_results: dict[timeseries_key, ParsedSource] — 同 ts_key 已合併
    source_states:  list of {folder_key, label, fetch, parse, rows} — 給 TG 摘要用
    """
    folder_map = drive.folder_map()
    parsed: dict[str, Any] = {}
    states: list[dict[str, Any]] = []

    for spec in SOURCES:
        fk = spec["folder_key"]
        st: dict[str, Any] = {
            "folder_key": fk, "label": spec["label"],
            "fetch": "skip", "parse": "skip", "rows": None,
        }
        states.append(st)

        filename = spec["filename"].format(date=trade_date)
        folder_id = folder_map.get(fk)
        if not folder_id:
            log(f"  ⚠️  {fk}: 缺 DRIVE_FOLDERS 對應,跳過")
            continue

        log(f"  ↓ {spec['label']}: {filename}")
        blob: bytes | None = None
        source_kind = "drive"  # 'drive' or 'scrape'
        try:
            blob = drive.download(folder_id, filename)
        except Exception as e:
            log(f"     ✗ Drive 下載失敗: {e}")

        # Drive 沒檔 → fallback 直接爬網頁 (用 fetch_stocks 既有的 anti-bot 邏輯)
        if blob is None:
            log(f"     ↳ Drive 沒檔,改直接爬網頁...")
            try:
                rule = fetch_stocks.SOURCE_RULES[fk]
                raw = fetch_stocks.fetch_source(rule, trade_date)
                if raw is None:
                    log(f"     ✗ 直接爬: 該日無資料 (假日 / 尚未公布)")
                    st["fetch"] = "fail"
                    _record(trade_date, fk, "fetch", "fail",
                            error="not in Drive and source returned no data",
                            enabled=record_db)
                    continue
                blob = fetch_stocks.prepare_upload_bytes(rule, raw)
                source_kind = "scrape"
                log(f"     ✓ 直接爬成功 ({len(blob):,} bytes)")
            except Exception as e:
                log(f"     ✗ 直接爬失敗: {e}")
                st["fetch"] = "fail"
                _record(trade_date, fk, "fetch", "fail",
                        error=f"drive miss + scrape fail: {e}",
                        enabled=record_db)
                continue
        else:
            log(f"     ↳ {len(blob):,} bytes (drive)")

        st["fetch"] = "ok" if source_kind == "drive" else "scrape"

        try:
            result = spec["parser"].parse(
                blob, trade_date=trade_date, **spec["kwargs"])
        except Exception as e:
            log(f"     ✗ 解析失敗: {e}")
            log(traceback.format_exc())
            st["parse"] = "fail"
            _record(trade_date, fk, "parse", "fail",
                    error=str(e), enabled=record_db)
            continue
        st["parse"] = "ok"
        st["rows"] = result.row_count
        log(f"     ✓ parsed {result.row_count:,} rows")
        _record(trade_date, fk, "parse", "ok",
                count=result.row_count, enabled=record_db)

        ts_key = result.timeseries_key
        if ts_key in parsed:
            existing = parsed[ts_key]
            existing.db_rows.extend(result.db_rows)
            existing.daily_values.update(result.daily_values)
            existing.stock_names.update(result.stock_names)
        else:
            parsed[ts_key] = result

    return parsed, states


# ── Phase 2: Supabase upsert ──────────────────────────────────────────
def upsert_all(trade_date: str, parsed: dict, *, record_db: bool) -> list[dict]:
    """回傳 db_states: list of {table, status, rows}。"""
    states: list[dict] = []
    for ts_key, result in parsed.items():
        n_rows = len(result.db_rows)
        if n_rows == 0:
            log(f"  ⚠️  {result.db_table}: 0 rows,跳過 upsert")
            states.append({"table": result.db_table, "status": "skip", "rows": 0})
            continue
        try:
            written = supabase_client.upsert_rows(
                table=result.db_table,
                rows=result.db_rows,
                on_conflict=CONFLICT_KEY[result.db_table],
            )
            log(f"  ✓ {result.db_table}: upserted {written:,} rows")
            _record(trade_date, result.db_table, "upsert", "ok",
                    count=written, enabled=record_db)
            states.append({"table": result.db_table, "status": "ok", "rows": written})
        except Exception as e:
            log(f"  ✗ {result.db_table} upsert 失敗: {e}")
            log(traceback.format_exc())
            _record(trade_date, result.db_table, "upsert", "fail",
                    error=str(e), enabled=record_db)
            states.append({"table": result.db_table, "status": "fail", "rows": None})
    return states


def _existing_stock_ids(existing: list, n_cats: int) -> set[str]:
    """從既有 timeseries 萃取 stock_id 集合,當作篩選白名單。"""
    if not existing or len(existing) < 2:
        return set()
    out: set[str] = set()
    i = 1
    while i < len(existing):
        sid = str(existing[i][0]).strip() if existing[i] else ""
        if sid:
            out.add(sid)
        i += n_cats
    return out


def filter_to_whitelist(parsed: dict, all_data: dict) -> None:
    """對 stockTrading / cbInstitutional 做白名單篩選 (in-place)。

    篩選來源:既有 all-data.json 該 key 內的 stock_id 集合
              ∪ stockTrading 與 cbInstitutional 兩 key 的聯集
              (兩者個股集合應相同,聯集是雙保險)
    """
    # 先建總白名單 (兩個 key 的既有 stock_id 聯集)
    whitelist: set[str] = set()
    for ts_key in FILTERED_TIMESERIES_KEYS:
        result = parsed.get(ts_key)
        existing = all_data.get(ts_key)
        n_cats = len(result.timeseries_categories) if result else 3
        whitelist |= _existing_stock_ids(existing or [], n_cats)

    if not whitelist:
        log("  ⚠️  既有 all-data.json 無白名單 stock_id,跳過篩選 (首次跑)")
        return

    log(f"  白名單 (CB-linked stocks): {len(whitelist):,} 檔")

    for ts_key in FILTERED_TIMESERIES_KEYS:
        result = parsed.get(ts_key)
        if not result:
            continue
        before_dv = len(result.daily_values)
        before_db = len(result.db_rows)
        result.daily_values = {
            sid: vals for sid, vals in result.daily_values.items()
            if sid in whitelist
        }
        result.db_rows = [r for r in result.db_rows if r["stock_id"] in whitelist]
        result.stock_names = {
            sid: name for sid, name in result.stock_names.items()
            if sid in whitelist
        }
        log(f"  ↳ {ts_key}: 個股 {before_dv:,} → {len(result.daily_values):,}, "
            f"DB rows {before_db:,} → {len(result.db_rows):,}")


# ── Phase 3: 合併 4 個 timeseries 進 all-data.json ─────────────────────
def merge_into_alldata(all_data: dict, parsed: dict) -> None:
    for ts_key, result in parsed.items():
        existing = all_data.get(ts_key)
        merged = timeseries_merge.merge(existing, result)
        all_data[ts_key] = merged
        log(f"  ⊕ {ts_key}: {len(merged):,} 列 "
            f"(header + {len(result.daily_values):,} stocks "
            f"× {len(result.timeseries_categories)} categories)")


# ── Phase 4: 從 Sheet 讀 5 個非-CSV key ────────────────────────────────
def fetch_sheets(trade_date: str, all_data: dict, *,
                 record_db: bool) -> list[dict]:
    """回傳 sheet_states: list of {key, name, status, rows}。"""
    states: list[dict] = []
    for spec in SHEET_SOURCES:
        log(f"  ↓ Sheet {spec['name']} ({spec['key']})")
        try:
            arr = sheets.fetch(spec["sheet_id"], spec["gid"])
            all_data[spec["key"]] = arr
            log(f"     ✓ {len(arr):,} 列")
            _record(trade_date, spec["key"], "fetch", "ok",
                    count=len(arr), enabled=record_db)
            states.append({"key": spec["key"], "name": spec["name"],
                           "status": "ok", "rows": len(arr)})
        except Exception as e:
            log(f"     ✗ {e}")
            _record(trade_date, spec["key"], "fetch", "fail",
                    error=str(e), enabled=record_db)
            states.append({"key": spec["key"], "name": spec["name"],
                           "status": "fail", "rows": None})
    return states


# ── 主入口 ────────────────────────────────────────────────────────────
def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("date", nargs="?", default=None,
                   help="YYYYMMDD,空白為今天 (Asia/Taipei)")
    p.add_argument("--dry-run", action="store_true",
                   help="= --skip-db --skip-json (仍會抓資料 + 解析)")
    p.add_argument("--skip-db", action="store_true",
                   help="不寫 Supabase (data + fetch_runs 全跳過)")
    p.add_argument("--skip-sheet", action="store_true",
                   help="跳過 5 個 Sheet 抓取 (debug)")
    p.add_argument("--skip-json", action="store_true",
                   help="不寫 data/all-data.json")
    p.add_argument("--out-json", default=None,
                   help="改寫到指定路徑 (測試用,不動 production data/all-data.json)")
    p.add_argument("--no-notify", action="store_true",
                   help="不送 Telegram 通知")
    args = p.parse_args(argv)
    if args.dry_run:
        args.skip_db = True
        args.skip_json = True

    trade_date = parse_date_arg(args.date)
    record_db = not args.skip_db
    out_json = Path(args.out_json) if args.out_json else DATA_JSON

    # 非交易日 (週末/國定假日) skip — 但若使用者明確指定 date 仍照跑
    if not args.date:
        try:
            from lib.calendar_tw import is_trading_day
            if not is_trading_day(trade_date):
                log(f"ℹ️ {trade_date} 非交易日 (週末/國定假日),跳過 (含 TG)")
                return 0
        except Exception as e:  # noqa: BLE001
            log(f"⚠️ 假日檢查失敗 (照跑): {e}")

    t0 = time.time()
    log(f"=== parse_and_export 開始 / 目標日期 {trade_date} ===")
    log(f"flags: skip_db={args.skip_db} skip_sheet={args.skip_sheet} "
        f"skip_json={args.skip_json}  drive_fixtures={os.environ.get('DRIVE_FROM_FIXTURES')!r}")

    # 收尾要用的狀態 (即使中途出錯,finally 也送 TG)
    summary: dict[str, Any] = {
        "trade_date": trade_date,
        "sources": [], "db": [], "sheets": [],
        "json": {"status": "skip"},
        "elapsed_s": 0.0,
        "dry_run": args.dry_run,
    }

    try:
        # Phase 1: fetch + parse
        log("[Phase 1] 從 Drive 下載 6 個 CSV + 解析")
        parsed, summary["sources"] = fetch_and_parse(trade_date, record_db=record_db)
        if not parsed:
            log("❌ 沒有任何 source 解析成功;abort")
            return 2

        # Phase 1.5: 讀既有 JSON + 白名單
        log("[Phase 1.5] 讀既有 all-data.json + 篩選白名單")
        if DATA_JSON.exists():
            size_mb = DATA_JSON.stat().st_size / 1024 / 1024
            log(f"  讀 {DATA_JSON.relative_to(REPO_ROOT)} ({size_mb:.2f} MB)")
            with open(DATA_JSON, "r", encoding="utf-8") as fh:
                all_data: dict = json.load(fh)
        else:
            log(f"  ⚠️  {DATA_JSON} 不存在,從零建")
            all_data = {}
        filter_to_whitelist(parsed, all_data)

        # Phase 2: DB upsert
        if args.skip_db:
            log("[Phase 2] --skip-db,Supabase upsert 跳過")
        else:
            log("[Phase 2] Supabase upsert")
            summary["db"] = upsert_all(trade_date, parsed, record_db=True)

        # Phase 3: 合併 timeseries
        log("[Phase 3] 合併 4 個 timeseries 進 all-data.json")
        merge_into_alldata(all_data, parsed)

        # Phase 4: Sheet
        if args.skip_sheet:
            log("[Phase 4] --skip-sheet,Sheet 抓取跳過")
        else:
            log("[Phase 4] 從 Sheet 讀 5 個非-CSV key")
            summary["sheets"] = fetch_sheets(trade_date, all_data, record_db=record_db)

        # Phase 5: 寫回 JSON
        if args.skip_json:
            log("[Phase 5] --skip-json,JSON 寫回跳過")
            summary["json"] = {"status": "skip"}
        else:
            log(f"[Phase 5] 寫回 {out_json}")
            try:
                out_json.parent.mkdir(parents=True, exist_ok=True)
                with open(out_json, "w", encoding="utf-8") as fh:
                    json.dump(all_data, fh, ensure_ascii=False, separators=(",", ":"))
                size_mb = out_json.stat().st_size / 1024 / 1024
                try:
                    shown = out_json.relative_to(REPO_ROOT)
                except ValueError:
                    shown = out_json
                log(f"  ✓ 已寫 {shown} ({size_mb:.2f} MB)")
                _record(trade_date, "all-data.json", "export", "ok",
                        count=len(all_data), enabled=record_db)
                summary["json"] = {"status": "ok", "size_mb": size_mb,
                                   "path": str(out_json)}
            except Exception as e:
                log(f"  ✗ JSON 寫入失敗: {e}")
                summary["json"] = {"status": "fail", "error": str(e)}

        # 收尾
        dt = time.time() - t0
        summary["elapsed_s"] = dt

        # 判斷退出碼
        any_fail = (
            any(s.get("fetch") == "fail" or s.get("parse") == "fail"
                for s in summary["sources"])
            or any(s.get("status") == "fail" for s in summary["db"])
            or any(s.get("status") == "fail" for s in summary["sheets"])
            or summary["json"].get("status") == "fail"
        )
        if any_fail:
            log(f"⚠️  完成但有失敗 (耗時 {dt:.1f}s)")
            return 3
        log(f"🏁 全部完成 (耗時 {dt:.1f}s)")
        return 0

    finally:
        # 通知 — 即使中途 raise 也送
        summary["elapsed_s"] = time.time() - t0
        if not args.no_notify:
            try:
                telegram.send_pipeline_summary(summary)
            except Exception as e:  # noqa: BLE001
                log(f"⚠️ TG 通知本身爆了: {e}")


if __name__ == "__main__":
    sys.exit(main())
