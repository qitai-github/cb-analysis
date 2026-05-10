"""通用歷史回填工具:任一 source (margin / inst / price / cb_inst / cb_price)
從 TWSE/TPEX 直接 scrape → Supabase + all-data.json timeseries key。

跑法 (從 scripts/ 目錄):
  python backfill_source.py inst    20250101 20260508 --no-verify-ssl
  python backfill_source.py margin  20250101 20260508 --no-verify-ssl
  python backfill_source.py price   20250101 20260508 --no-verify-ssl
  python backfill_source.py cb_inst 20250101 20260508 --no-verify-ssl
  python backfill_source.py cb_price 20250101 20260508 --no-verify-ssl

選項:
  --force          不 skip 已在 DB 的日期 (覆寫)
  --no-json        只寫 DB,不更新 all-data.json
  --no-verify-ssl  關 SSL 驗證 (Windows cert chain 問題時用)
  --sleep N        日期間 sleep 秒數 (default 4)

特性與 backfill_margin.py 一致:
  - 跳 Drive 直接 scrape
  - 跳週末 + 國定假日
  - resume: 雙 market 都齊 (or cb 類單 source 有資料) 才算 done
  - 每日 fetch 完立刻 upsert (Ctrl+C 安全)
  - JSON 一次性重組
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

try:
    from dotenv import load_dotenv
    load_dotenv(SCRIPTS_DIR / ".env", override=False)
except ImportError:
    pass

import fetch_stocks  # noqa: E402
from lib import calendar_tw, supabase_client  # noqa: E402
from parsers import cb_inst, cb_price, margin_trading, stock_inst, stock_price  # noqa: E402

REPO_ROOT = SCRIPTS_DIR.parent
DATA_JSON = REPO_ROOT / "data" / "all-data.json"
SLEEP_BETWEEN_DATES = 4

# ── source 設定 ──────────────────────────────────────────────────────
# 每筆:
#   parser: parser module (有 .parse(blob, **kwargs) → ParsedSource)
#   fetches: [(market_label_or_None, fetch_stocks.SOURCE_RULES key)] 1 或 2 項
#   id_field: DB PK 中的 stock_id 欄名 (resume 用) — 'stock_id' 或 'cb_id'
#   has_market: True = 雙 market source (resume 要兩邊都齊)
#                False = 單 source (有任一 row 就算 done)
SOURCE_CONFIGS = {
    "margin": {
        "parser": margin_trading,
        "fetches": [("TWSE", "MARGIN_TWSE"), ("TPEX", "MARGIN_TPEX")],
        "id_field": "stock_id",
        "has_market": True,
    },
    "inst": {
        "parser": stock_inst,
        "fetches": [("TWSE", "STOCK_INST_TWSE"), ("TPEX", "STOCK_INST_TPEX")],
        "id_field": "stock_id",
        "has_market": True,
    },
    "price": {
        "parser": stock_price,
        "fetches": [("TWSE", "STOCK_PRICE_TWSE"), ("TPEX", "STOCK_PRICE_TPEX")],
        "id_field": "stock_id",
        "has_market": True,
    },
    "cb_inst": {
        "parser": cb_inst,
        "fetches": [(None, "CB_INST")],
        "id_field": "cb_id",
        "has_market": False,
    },
    "cb_price": {
        "parser": cb_price,
        "fetches": [(None, "CB_PRICE")],
        "id_field": "cb_id",
        "has_market": False,
    },
}

# parser 不一定有 timeseries_key/categories/db_table 屬性,
# 從 module 取常數;但回 fallback 到第一筆 ParsedSource。
def _module_attr(p, names: tuple[str, ...]):
    for n in names:
        v = getattr(p, n, None)
        if v is not None:
            return v
    return None


# ── 日期 / DB 工具 ─────────────────────────────────────────────────────
def iter_trading_days(start: str, end: str):
    cur = datetime.strptime(start, "%Y%m%d").date()
    last = datetime.strptime(end, "%Y%m%d").date()
    while cur <= last:
        s = cur.strftime("%Y%m%d")
        if calendar_tw.is_trading_day(s):
            yield s
        cur += timedelta(days=1)


def _iso(d: str) -> str:
    return f"{d[:4]}-{d[4:6]}-{d[6:8]}"


def existing_dates_in_db(table: str, start: str, end: str, has_market: bool) -> set[str]:
    """回傳 range 內「已完成」的 trade_date set (YYYYMMDD)。
    has_market=True → 兩個 market 都有才算 done。
    has_market=False → 任一 row 即算 done。
    """
    sb = supabase_client.get_client()
    sel = "trade_date,market" if has_market else "trade_date"
    by_date: dict[str, set[str]] = {}
    page_size = 1000
    offset = 0
    while True:
        resp = (sb.table(table)
                .select(sel)
                .gte("trade_date", _iso(start))
                .lte("trade_date", _iso(end))
                .range(offset, offset + page_size - 1)
                .execute())
        rows = resp.data or []
        if not rows:
            break
        for r in rows:
            d = r["trade_date"].replace("-", "")
            if has_market:
                by_date.setdefault(d, set()).add(r["market"])
            else:
                by_date.setdefault(d, set()).add("_")
        if len(rows) < page_size:
            break
        offset += page_size
    if has_market:
        return {d for d, ms in by_date.items() if {"TWSE", "TPEX"}.issubset(ms)}
    return set(by_date.keys())


# ── Fetch ────────────────────────────────────────────────────────────
def fetch_one(rule_key: str, date: str) -> bytes | None:
    rule = fetch_stocks.SOURCE_RULES[rule_key]
    raw = fetch_stocks.fetch_source(rule, date)
    if raw is None:
        return None
    return fetch_stocks.prepare_upload_bytes(rule, raw)


# ── White-list ───────────────────────────────────────────────────────
def extract_whitelist(all_data: dict) -> set[str]:
    wl: set[str] = set()
    for key in ("stockTrading", "cbInstitutional", "marginTrading"):
        ts = all_data.get(key) or []
        if len(ts) < 2:
            continue
        for row in ts[1:]:
            if not row:
                continue
            sid = str(row[0]).strip() if row else ""
            if sid:
                wl.add(sid)
    return wl


# ── JSON rebuild ─────────────────────────────────────────────────────
def _format_value(v) -> str:
    if v is None:
        return "0"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, str):
        return v
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else str(v)
    return str(v)


def rebuild_timeseries(existing_arr, accumulator: dict, categories: list[str],
                       wl: set[str] | None) -> list[list]:
    """重組 timeseries 2D 陣列 (header + data)。

    保留 existing 內 backfill range 外的日期欄;range 內的全用 accumulator 重建。
    結果日期升冪。wl=None 表示不過濾 (cb 類沒 white-list 概念,直接全進)。
    """
    backfill_set = set(accumulator.keys())

    existing_dates: list[str] = []
    existing_values: dict[tuple[str, str], dict[str, str]] = {}
    existing_names: dict[str, str] = {}
    if existing_arr and len(existing_arr) > 1:
        header = existing_arr[0]
        existing_dates = [d for d in header[3:] if d and d not in backfill_set]
        cur_sid = ""
        cur_name = ""
        for row in existing_arr[1:]:
            if not row or len(row) < 4:
                continue
            sid = str(row[0]).strip() if row[0] else ""
            name = str(row[1]).strip() if row[1] else ""
            cat = str(row[2]).strip() if len(row) > 2 else ""
            if sid:
                cur_sid = sid
            if name:
                cur_name = name
            if cur_sid:
                existing_names[cur_sid] = cur_name
            if not cur_sid or not cat:
                continue
            for d, v in zip(header[3:], row[3:]):
                if d in backfill_set or not d:
                    continue
                existing_values.setdefault((cur_sid, cat), {})[d] = v

    all_dates = sorted(set(existing_dates) | backfill_set)

    stock_names: dict[str, str] = {}
    for sid, name in existing_names.items():
        if wl is None or sid in wl:
            stock_names[sid] = name
    for by_market in accumulator.values():
        for parsed in by_market.values():
            for sid, name in parsed.stock_names.items():
                if wl is None or sid in wl:
                    stock_names.setdefault(sid, name)

    out: list[list] = [["代號", "名稱", "類別"] + all_dates]
    for sid in sorted(stock_names.keys()):
        for j, cat in enumerate(categories):
            row = ["", "", cat]
            if j == 0:
                row[0] = sid
                row[1] = stock_names[sid]
            for d in all_dates:
                v = None
                if d in backfill_set:
                    for parsed in (accumulator.get(d) or {}).values():
                        dv = parsed.daily_values.get(sid)
                        if dv and cat in dv:
                            v = dv[cat]
                            break
                else:
                    v = existing_values.get((sid, cat), {}).get(d)
                row.append(_format_value(v))
            out.append(row)
    return out


# ── Main ─────────────────────────────────────────────────────────────
def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("source", choices=sorted(SOURCE_CONFIGS.keys()),
                   help="要回補的 source")
    p.add_argument("start", help="起始 YYYYMMDD")
    p.add_argument("end", help="結束 YYYYMMDD")
    p.add_argument("--force", action="store_true",
                   help="不 skip 已在 DB 的日期")
    p.add_argument("--no-json", action="store_true",
                   help="只寫 DB,不更新 all-data.json")
    p.add_argument("--no-verify-ssl", action="store_true",
                   help="關 SSL 驗證 (Windows cert chain 問題時用)")
    p.add_argument("--sleep", type=int, default=SLEEP_BETWEEN_DATES,
                   help=f"日期間 sleep 秒 (default {SLEEP_BETWEEN_DATES})")
    args = p.parse_args(argv)

    if args.no_verify_ssl:
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        _orig = fetch_stocks.make_session
        def _ns(referer):
            s = _orig(referer)
            s.verify = False
            return s
        fetch_stocks.make_session = _ns
        print("⚠️  SSL 驗證已關閉 (--no-verify-ssl)")

    cfg = SOURCE_CONFIGS[args.source]
    parser_mod = cfg["parser"]
    db_table = _module_attr(parser_mod, ("DB_TABLE",))
    ts_key   = _module_attr(parser_mod, ("TIMESERIES_KEY",))
    cats     = _module_attr(parser_mod, ("CATEGORIES",))
    if not (db_table and ts_key and cats):
        print(f"❌ {args.source} parser 缺常數 (DB_TABLE/TIMESERIES_KEY/CATEGORIES)")
        return 2
    on_conflict = (
        "trade_date,market," + cfg["id_field"] if cfg["has_market"]
        else "trade_date," + cfg["id_field"]
    )

    print(f"=== 回填 {args.source} ({db_table} / {ts_key}) "
          f"{args.start} → {args.end} ===")
    print(f"sleep={args.sleep}s  force={args.force}  no_json={args.no_json}")
    print(f"sources: {[k for _, k in cfg['fetches']]}")
    print(f"categories: {cats}\n")

    if args.force:
        skip_set: set[str] = set()
    else:
        print("檢查 DB 已有日期...")
        skip_set = existing_dates_in_db(db_table, args.start, args.end, cfg["has_market"])
        print(f"  → DB 已有 {len(skip_set)} 個完整日期,會 skip\n")

    dates = list(iter_trading_days(args.start, args.end))
    print(f"範圍內共 {len(dates)} 個交易日 (扣掉週末 + 國定假日)\n")

    accumulator: dict[str, dict] = {}
    failed: list[tuple[str, str, str]] = []
    n_done = 0
    n_skip = 0

    t0 = time.time()
    for i, date in enumerate(dates, 1):
        prefix = f"[{i:>3}/{len(dates)}] {date}"
        if date in skip_set:
            print(f"{prefix} ⏭  已在 DB,skip")
            n_skip += 1
            continue

        per_date_rows = []
        for market, rule_key in cfg["fetches"]:
            label = market or "single"
            try:
                blob = fetch_one(rule_key, date)
            except Exception as e:
                print(f"{prefix} ❌ {label} fetch: {e}")
                failed.append((date, label, f"fetch: {e}"))
                continue
            if blob is None:
                print(f"{prefix} ⚠️  {label} 該日無資料")
                failed.append((date, label, "no data"))
                continue
            kwargs = {"trade_date": date}
            if cfg["has_market"]:
                kwargs["market"] = market
            try:
                result = parser_mod.parse(blob, **kwargs)
            except Exception as e:
                print(f"{prefix} ❌ {label} parse: {e}")
                failed.append((date, label, f"parse: {e}"))
                continue
            print(f"{prefix} ✓ {label}: {len(result.db_rows):>4} rows")
            per_date_rows.extend(result.db_rows)
            accumulator.setdefault(date, {})[label] = result

        if per_date_rows:
            try:
                supabase_client.upsert_rows(
                    table=db_table,
                    rows=per_date_rows,
                    on_conflict=on_conflict,
                )
                n_done += 1
            except Exception as e:
                print(f"{prefix} ❌ DB upsert: {e}")
                failed.append((date, "DB", str(e)))

        if i < len(dates):
            time.sleep(args.sleep)

    elapsed = time.time() - t0
    print(f"\n=== Phase 1 完成 (耗時 {elapsed/60:.1f} 分) ===")
    print(f"處理 {n_done} 日 / skip {n_skip} 日 / 失敗 {len(failed)} 筆")

    if not args.no_json and accumulator:
        print(f"\n=== Phase 2: 重組 all-data.json {ts_key} ===")
        with open(DATA_JSON, encoding="utf-8") as fh:
            all_data = json.load(fh)
        # cb 類沒 white-list (CB 量小);個股類用 white-list
        wl = extract_whitelist(all_data) if cfg["id_field"] == "stock_id" else None
        if wl is not None:
            print(f"  white-list (個股): {len(wl):,} 檔")
        new_arr = rebuild_timeseries(all_data.get(ts_key), accumulator, cats, wl)
        all_data[ts_key] = new_arr
        with open(DATA_JSON, "w", encoding="utf-8") as fh:
            json.dump(all_data, fh, ensure_ascii=False, separators=(",", ":"))
        size_mb = DATA_JSON.stat().st_size / 1024 / 1024
        print(f"  ✓ {len(new_arr)-1} 列 ({len(new_arr[0])-3} 個日期欄)")
        print(f"  ✓ JSON 大小: {size_mb:.2f} MB")
    elif args.no_json:
        print("\n--no-json,跳過 JSON 重組")
    else:
        print("\n沒有新資料,JSON 不變")

    if failed:
        print(f"\n❌ 失敗清單 ({len(failed)} 筆,前 30 顯示):")
        for d, m, e in failed[:30]:
            print(f"  {d} {m}: {e}")
        return 1

    print("\n🏁 全部完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
