"""把個股法人 / 融資融券歷史 CSV 補到本機 Google Drive 同步資料夾。

背景:Service Account 無儲存配額,不能在 My Drive create 檔案,所以歷史回補
改寫本機桌面同步路徑,讓 Google Drive Desktop 同步上雲
(詳見 memory reference_drive_upload_via_local_sync)。

folder_key → 本機資料夾(Y:\我的雲端硬碟\Telegram Bot\ 下):
  STOCK_INST_TWSE  個股法人(上市)  上市法人  TWSE_T86_YYYYMMDD.csv
  STOCK_INST_TPEX  個股法人(上櫃)  上櫃法人  TPEx_T86_YYYYMMDD.csv
  MARGIN_TWSE      融資融券(上市)  上市融資  MI_MARGN_STOCK_YYYYMMDD.csv
  MARGIN_TPEX      融資融券(上櫃)  上櫃融資  RSTA3106_YYYYMMDD.csv

跑法 (從 scripts/ 目錄):
  python backfill_drive_local.py 20250101 20251231 --no-verify-ssl

選項:
  --sources k1,k2  只跑指定 folder_key(預設 4 個全跑)
  --force          覆蓋已存在的檔(預設 skip)
  --sleep N        每次 fetch 後 sleep 秒(default 3)
  --no-verify-ssl  關 SSL 驗證(Windows cert chain 問題時)

特性:
  - 跳週末 + 國定假日(calendar_tw),但 2025 農曆假日 API 可能抓不到,
    所以再用「資料列數」二次驗證:fetch 回 None 或資料列 < MIN_ROWS 不寫
    (避開 TPEx 假日回 header-only 空殼的坑)。
  - skip-if-exists,可安全重跑。
"""
from __future__ import annotations

import argparse
import re
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

import fetch_stocks  # noqa: E402
from lib import calendar_tw  # noqa: E402

LOCAL_ROOT = Path(r"Y:\我的雲端硬碟\Telegram Bot")

# folder_key → 本機子資料夾名
FOLDER_MAP = {
    "STOCK_INST_TWSE": "上市法人",
    "STOCK_INST_TPEX": "上櫃法人",
    "MARGIN_TWSE": "上市融資",
    "MARGIN_TPEX": "上櫃融資",
}

# 有效資料列門檻:真交易日數百~數千列;假日空殼 0 列
MIN_ROWS = 10
# 行首為 4~6 位股票代號(可能帶引號 / Excel 的 ="1101" 格式)
_ROW_RE = re.compile(r'^=?"?\d{4,6}"?[",]', re.MULTILINE)


def iter_trading_days(start: str, end: str):
    cur = datetime.strptime(start, "%Y%m%d").date()
    last = datetime.strptime(end, "%Y%m%d").date()
    while cur <= last:
        s = cur.strftime("%Y%m%d")
        if calendar_tw.is_trading_day(s):
            yield s
        cur += timedelta(days=1)


def count_data_rows(rule: dict, blob: bytes) -> int:
    """解碼後數有效股票資料列(用來判斷是不是空殼 / 假日)。"""
    enc = rule["encoding"] if rule["save_mode"] == "raw" else "utf-8"
    try:
        text = blob.decode(enc, errors="replace")
    except LookupError:
        text = blob.decode("utf-8", errors="replace")
    return len(_ROW_RE.findall(text))


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("start", help="起始 YYYYMMDD")
    p.add_argument("end", help="結束 YYYYMMDD")
    p.add_argument("--sources", default=",".join(FOLDER_MAP),
                   help="逗號分隔 folder_key,預設全跑")
    p.add_argument("--force", action="store_true", help="覆蓋已存在的檔")
    p.add_argument("--sleep", type=int, default=3, help="每次 fetch 後 sleep 秒")
    p.add_argument("--no-verify-ssl", action="store_true", help="關 SSL 驗證")
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

    keys = [k.strip() for k in args.sources.split(",") if k.strip()]
    for k in keys:
        if k not in FOLDER_MAP:
            print(f"❌ 未知 folder_key: {k} (可用: {list(FOLDER_MAP)})")
            return 2
    for k in keys:
        d = LOCAL_ROOT / FOLDER_MAP[k]
        if not d.is_dir():
            print(f"❌ 本機資料夾不存在: {d}")
            return 2

    dates = list(iter_trading_days(args.start, args.end))
    print(f"=== 回補 {keys} ===")
    print(f"範圍 {args.start} → {args.end}:{len(dates)} 個交易日 "
          f"(扣週末+國定假日;農曆假日靠列數驗證)")
    print(f"目標根目錄 {LOCAL_ROOT}\n")

    n_write = n_skip_exist = n_empty = 0
    failed: list[tuple[str, str, str]] = []
    t0 = time.time()

    for i, date in enumerate(dates, 1):
        prefix = f"[{i:>3}/{len(dates)}] {date}"
        for key in keys:
            rule = fetch_stocks.SOURCE_RULES[key]
            folder = LOCAL_ROOT / FOLDER_MAP[key]
            fname = rule["filename"](date)
            dst = folder / fname

            if dst.exists() and not args.force:
                n_skip_exist += 1
                continue

            try:
                raw = fetch_stocks.fetch_source(rule, date)
            except Exception as e:
                print(f"{prefix} ❌ {key} fetch: {e}")
                failed.append((date, key, f"fetch: {e}"))
                time.sleep(args.sleep)
                continue

            if raw is None:
                print(f"{prefix} ⚪ {key} 無資料 (假日/未開盤)")
                n_empty += 1
                time.sleep(args.sleep)
                continue

            blob = fetch_stocks.prepare_upload_bytes(rule, raw)
            rows = count_data_rows(rule, blob)
            if rows < MIN_ROWS:
                print(f"{prefix} ⚪ {key} 空殼 (僅 {rows} 列),不寫")
                n_empty += 1
                time.sleep(args.sleep)
                continue

            dst.write_bytes(blob)
            print(f"{prefix} ✅ {key} → {fname} ({rows} 列, {len(blob):,} bytes)")
            n_write += 1
            time.sleep(args.sleep)

    elapsed = time.time() - t0
    print(f"\n=== 完成 (耗時 {elapsed/60:.1f} 分) ===")
    print(f"寫入 {n_write} / 已存在skip {n_skip_exist} / "
          f"無資料或空殼 {n_empty} / 失敗 {len(failed)}")
    if failed:
        print(f"\n❌ 失敗清單 ({len(failed)} 筆,前 30):")
        for d, k, e in failed[:30]:
            print(f"  {d} {k}: {e}")
        return 1
    print("\n🏁 全部完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
