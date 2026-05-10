"""融資融券歷史回填 (TWSE + TPEX → Supabase + all-data.json marginTrading key)。

跑法 (從 scripts/ 目錄):
  python backfill_margin.py 20250101 20260508          # 整段
  python backfill_margin.py 20250101 20260508 --force  # 不 skip 已在 DB 的日期
  python backfill_margin.py 20250101 20260508 --no-json  # 只寫 DB

特性:
  - 直接打 TWSE/TPEX URL,跳過 Drive (省 placeholder 麻煩)
  - 跳週末/國定假日 (calendar_tw)
  - resume 模式: 已在 DB 的 trade_date 自動 skip
  - 每日 fetch 完立刻 upsert (Ctrl+C 安全,只會丟當前未寫日期)
  - JSON 一次性重組 (避免 340 次寫 9MB 的損耗)
  - parser header 日期防呆 (TWSE hiccup 回舊資料時 raise)
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

# Windows console UTF-8
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
from parsers import margin_trading  # noqa: E402

REPO_ROOT = SCRIPTS_DIR.parent
DATA_JSON = REPO_ROOT / "data" / "all-data.json"
CATEGORIES = margin_trading.CATEGORIES
SLEEP_BETWEEN_DATES = 4  # TWSE 防擋,每日 fetch 完間隔
ON_CONFLICT = "trade_date,market,stock_id"


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


def existing_dates_in_db(start: str, end: str) -> set[str]:
    """撈 stock_margin 在範圍內「兩個 market 都有資料」的 trade_date set (YYYYMMDD)。

    用於 resume:只 skip 雙市場都齊全的日期。某日只剩單市場 (例如之前
    測試 fail 留下的孤兒 row) 會被視為未完成,重跑會把缺的補上。
    """
    sb = supabase_client.get_client()
    by_date: dict[str, set[str]] = {}
    page_size = 1000
    offset = 0
    while True:
        resp = (sb.table("stock_margin")
                .select("trade_date,market")
                .gte("trade_date", _iso(start))
                .lte("trade_date", _iso(end))
                .range(offset, offset + page_size - 1)
                .execute())
        rows = resp.data or []
        if not rows:
            break
        for r in rows:
            d = r["trade_date"].replace("-", "")
            by_date.setdefault(d, set()).add(r["market"])
        if len(rows) < page_size:
            break
        offset += page_size
    # 只保留兩個 market 都有的日期
    return {d for d, ms in by_date.items() if {"TWSE", "TPEX"}.issubset(ms)}


# ── Fetch ────────────────────────────────────────────────────────────
def fetch_market(market: str, date: str) -> bytes | None:
    rule = fetch_stocks.SOURCE_RULES[f"MARGIN_{market}"]
    raw = fetch_stocks.fetch_source(rule, date)  # 已含重試 / 暖身
    if raw is None:
        return None
    return fetch_stocks.prepare_upload_bytes(rule, raw)  # MS950→UTF-8


# ── Whitelist ────────────────────────────────────────────────────────
def extract_whitelist(all_data: dict) -> set[str]:
    """從既有 stockTrading / cbInstitutional / marginTrading 取 stock_id 聯集。"""
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


def rebuild_margin_timeseries(existing_arr, accumulator: dict, wl: set[str]) -> list[list]:
    """重組 marginTrading 2D 陣列 (header + data rows)。

    保留 existing 內 backfill range 外的日期欄;range 內的全用 accumulator 重建。
    結果日期是 sorted 升冪。
    """
    backfill_set = set(accumulator.keys())

    # 既有 JSON 解析:取 range 外的日期 + 對應 (stock_id, category) → value
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

    # 合併日期 (sorted)
    all_dates = sorted(set(existing_dates) | backfill_set)

    # 合併 stock_id + 名稱 (white-list 過濾)
    stock_names: dict[str, str] = {}
    for sid, name in existing_names.items():
        if sid in wl:
            stock_names[sid] = name
    for by_market in accumulator.values():
        for parsed in by_market.values():
            for sid, name in parsed.stock_names.items():
                if sid in wl:
                    stock_names.setdefault(sid, name)

    # 建 2D 陣列
    out: list[list] = [["代號", "名稱", "類別"] + all_dates]
    for sid in sorted(stock_names.keys()):
        for j, cat in enumerate(CATEGORIES):
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
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("start", help="起始 YYYYMMDD (含)")
    p.add_argument("end",   help="結束 YYYYMMDD (含)")
    p.add_argument("--force", action="store_true",
                   help="不 skip 已在 DB 的日期 (覆寫)")
    p.add_argument("--no-json", action="store_true",
                   help="只寫 DB,不更新 all-data.json")
    p.add_argument("--sleep", type=int, default=SLEEP_BETWEEN_DATES,
                   help=f"日期間 sleep 秒數 (default {SLEEP_BETWEEN_DATES})")
    p.add_argument("--no-verify-ssl", action="store_true",
                   help="關閉 SSL 憑證驗證 (Windows cert chain 異常時用)")
    args = p.parse_args(argv)

    if args.no_verify_ssl:
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        # 包 fetch_stocks.make_session,讓回傳的 Session 默認 verify=False
        _orig_make_session = fetch_stocks.make_session
        def _ns(referer):
            s = _orig_make_session(referer)
            s.verify = False
            return s
        fetch_stocks.make_session = _ns
        print("⚠️  SSL 驗證已關閉 (--no-verify-ssl)")

    print(f"=== 融資融券回填 {args.start} → {args.end} ===")
    print(f"sleep={args.sleep}s  force={args.force}  no_json={args.no_json}\n")

    # Resume: 撈 DB 已有的日期
    if args.force:
        skip_set: set[str] = set()
    else:
        print("檢查 DB 已有日期...")
        skip_set = existing_dates_in_db(args.start, args.end)
        print(f"  → DB 已有 {len(skip_set)} 個日期,會 skip\n")

    dates = list(iter_trading_days(args.start, args.end))
    print(f"範圍內共 {len(dates)} 個交易日 (扣掉週末 + 國定假日)\n")

    accumulator: dict[str, dict] = {}  # {date: {market: ParsedSource}}
    failed: list[tuple[str, str, str]] = []
    n_skip = 0
    n_done = 0

    t0 = time.time()
    for i, date in enumerate(dates, 1):
        prefix = f"[{i:>3}/{len(dates)}] {date}"
        if date in skip_set:
            print(f"{prefix} ⏭  已在 DB,skip")
            n_skip += 1
            continue

        per_date_rows = []
        for market in ("TWSE", "TPEX"):
            try:
                blob = fetch_market(market, date)
            except Exception as e:
                print(f"{prefix} ❌ {market} fetch: {e}")
                failed.append((date, market, f"fetch: {e}"))
                continue
            if blob is None:
                print(f"{prefix} ⚠️  {market} 該日無資料")
                failed.append((date, market, "no data"))
                continue
            try:
                result = margin_trading.parse(blob, market=market, trade_date=date)
            except ValueError as e:
                print(f"{prefix} ❌ {market} parse: {e}")
                failed.append((date, market, f"parse: {e}"))
                continue
            print(f"{prefix} ✓ {market}: {len(result.db_rows):>4} rows")
            per_date_rows.extend(result.db_rows)
            accumulator.setdefault(date, {})[market] = result

        # 立刻 upsert 此日期 (Ctrl+C 安全)
        if per_date_rows:
            try:
                supabase_client.upsert_rows(
                    table="stock_margin",
                    rows=per_date_rows,
                    on_conflict=ON_CONFLICT,
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

    # Phase 2: JSON
    if not args.no_json and accumulator:
        print(f"\n=== Phase 2: 重組 all-data.json marginTrading ===")
        with open(DATA_JSON, encoding="utf-8") as fh:
            all_data = json.load(fh)
        wl = extract_whitelist(all_data)
        print(f"  white-list: {len(wl):,} 檔")
        new_arr = rebuild_margin_timeseries(
            all_data.get("marginTrading"), accumulator, wl)
        all_data["marginTrading"] = new_arr
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
