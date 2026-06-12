#!/usr/bin/env python3
"""Phase 0｜全市場 OHLCV 本地快取建置 (給 vcp_scanner.py 用)。

背景: parse_and_export.py 會把個股交易做 CB 白名單篩選 (連 db_rows 一起砍),
所以 all-data.json / Supabase 都只有 ~353 檔。全台股 (上市+上櫃 ~1800 檔) 的
完整歷史只存在 Drive 兩個資料夾的每日原始 CSV。本腳本把它們拼成本地時間序列快取。

來源 (Drive folder):
  STOCK_PRICE_TWSE   上市每日交易明細   TWSE-Daily-YYYYMMDD.csv
  STOCK_PRICE_TPEX   上櫃每日交易明細   TPEx-EW-YYYYMMDD.csv

快取格式: scripts/cache/universe/<YYYYMMDD>.json (每交易日一檔)
  {"date":"20260529","stocks":{"2330":{"n":"台積電","m":"TWSE",
                                       "o":..,"h":..,"l":..,"c":..,"v":..}, ...}}

用法:
  python build_universe.py                 # 增量: 只抓快取裡還沒有的交易日
  python build_universe.py --force         # 重抓全部 (覆蓋)
  python build_universe.py --days 60       # 只處理最近 60 個交易日 (測試用)
  python build_universe.py --refresh-latest  # 強制重抓最新一天 (當日盤後更新)

環境變數 (沿用 scripts/.env):
  GOOGLE_CREDENTIALS  Service Account JSON
  DRIVE_FOLDERS       JSON, 需含 STOCK_PRICE_TWSE / STOCK_PRICE_TPEX
                      (未設定時 fallback 用下方 _FALLBACK_FOLDERS)
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

# parser 沿用既有 (解析時本來就是全市場, 只是 pipeline 後面才白名單篩選)
from parsers import stock_price

SCRIPT_DIR = Path(__file__).resolve().parent
CACHE_DIR = SCRIPT_DIR / "cache" / "universe"
SCOPES = ["https://www.googleapis.com/auth/drive"]

# DRIVE_FOLDERS 沒設這兩個 key 時的 fallback (使用者提供的資料夾 ID)
_FALLBACK_FOLDERS = {
    "STOCK_PRICE_TWSE": "1MmT3hKTeIUFwXOuAboyPV9-hYKq-sh-s",
    "STOCK_PRICE_TPEX": "1EQnVyObf6XrcJujojHB3v3gspK5IMGxL",
}

# 檔名 → (market, YYYYMMDD)
_FILE_RE = {
    "TWSE": re.compile(r"TWSE-Daily-(\d{8})\.csv$", re.I),
    "TPEX": re.compile(r"TPEx-EW-(\d{8})\.csv$", re.I),
}

_thread_local = threading.local()
_creds_info: dict | None = None

# Windows cp950 console 無法輸出 emoji → 強制 utf-8
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass


# ── .env / 憑證 ───────────────────────────────────────────────────────
def load_env() -> None:
    env_path = SCRIPT_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def _service():
    """每個 thread 自己的 Drive service (httplib2 非 thread-safe)。"""
    svc = getattr(_thread_local, "svc", None)
    if svc is not None:
        return svc
    global _creds_info
    if _creds_info is None:
        raw = os.environ.get("GOOGLE_CREDENTIALS", "").strip()
        if not raw:
            raise SystemExit("缺少環境變數 GOOGLE_CREDENTIALS")
        _creds_info = json.loads(raw)
    creds = service_account.Credentials.from_service_account_info(
        _creds_info, scopes=SCOPES
    )
    svc = build("drive", "v3", credentials=creds, cache_discovery=False)
    _thread_local.svc = svc
    return svc


def folder_ids() -> dict[str, str]:
    raw = os.environ.get("DRIVE_FOLDERS", "").strip()
    mapping = {}
    if raw:
        try:
            mapping = json.loads(raw)
        except json.JSONDecodeError:
            mapping = {}
    out = {}
    for key, fb in _FALLBACK_FOLDERS.items():
        out[key] = mapping.get(key) or fb
    return out


# ── Drive 列檔 / 下載 ─────────────────────────────────────────────────
def list_folder(folder_id: str) -> list[dict]:
    svc = _service()
    files, tok = [], None
    while True:
        res = svc.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            fields="nextPageToken, files(id, name)",
            pageSize=1000,
            pageToken=tok,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()
        files.extend(res.get("files", []))
        tok = res.get("nextPageToken")
        if not tok:
            break
    return files


def download_bytes(file_id: str) -> bytes:
    svc = _service()
    request = svc.files().get_media(fileId=file_id, supportsAllDrives=True)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _status, done = downloader.next_chunk()
    return buf.getvalue()


# ── 一天的處理 ────────────────────────────────────────────────────────
def build_day(date_str: str, sources: dict[str, dict]) -> dict:
    """sources: {market: {'id':..,'name':..}} → 合併兩市場成一個 day dict。"""
    stocks: dict[str, dict] = {}
    for market, finfo in sources.items():
        raw = download_bytes(finfo["id"])
        parsed = stock_price.parse(raw, market=market, trade_date=date_str)
        for code, vals in parsed.daily_values.items():
            c = vals.get("收盤價") or 0
            o = vals.get("開盤價") or 0
            h = vals.get("最高價") or 0
            low = vals.get("最低價") or 0
            v = vals.get("成交股數") or 0
            # 全 0 = 停牌/無交易, 仍記錄 (scanner 端 forward-fill)
            stocks[code] = {
                "n": parsed.stock_names.get(code, ""),
                "m": market,
                "o": o, "h": h, "l": low, "c": c, "v": v,
            }
    return {"date": date_str, "stocks": stocks}


def write_day(day: dict) -> int:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / f"{day['date']}.json"
    path.write_text(
        json.dumps(day, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return len(day["stocks"])


# ── Main ─────────────────────────────────────────────────────────────
def collect_sources() -> dict[str, dict[str, dict]]:
    """回傳 {date_str: {market: {'id','name'}}}。"""
    fids = folder_ids()
    by_date: dict[str, dict[str, dict]] = {}
    for market, key in (("TWSE", "STOCK_PRICE_TWSE"), ("TPEX", "STOCK_PRICE_TPEX")):
        fid = fids[key]
        rx = _FILE_RE[market]
        files = list_folder(fid)
        n = 0
        for f in files:
            m = rx.search(f["name"])
            if not m:
                continue
            by_date.setdefault(m.group(1), {})[market] = f
            n += 1
        print(f"  {key}: {n} 個每日檔", flush=True)
    return by_date


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="重抓全部 (覆蓋既有快取)")
    ap.add_argument("--refresh-latest", action="store_true",
                    help="強制重抓最新一天 (盤後更新用)")
    ap.add_argument("--days", type=int, default=0,
                    help="只處理最近 N 個交易日 (0=全部)")
    ap.add_argument("--workers", type=int, default=8, help="下載並行數")
    args = ap.parse_args()

    load_env()
    print("📁 列出 Drive 每日交易明細...", flush=True)
    by_date = collect_sources()
    all_dates = sorted(by_date.keys())
    if not all_dates:
        print("❌ Drive 找不到任何每日交易檔", file=sys.stderr)
        return 2
    print(f"🗓️  Drive 共 {len(all_dates)} 個交易日 "
          f"({all_dates[0]} → {all_dates[-1]})", flush=True)

    if args.days > 0:
        all_dates = all_dates[-args.days:]

    existing = {p.stem for p in CACHE_DIR.glob("*.json")} if CACHE_DIR.exists() else set()
    latest = all_dates[-1]
    todo = []
    for d in all_dates:
        if args.force:
            todo.append(d)
        elif d == latest and args.refresh_latest:
            todo.append(d)
        elif d not in existing:
            todo.append(d)

    if not todo:
        print(f"✅ 快取已是最新 (本地 {len(existing)} 天),無需下載", flush=True)
        return 0
    print(f"⬇️  需處理 {len(todo)} 個交易日 "
          f"(本地已有 {len(existing)} 天)", flush=True)

    done, failed = 0, []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(build_day, d, by_date[d]): d for d in todo}
        for fut in as_completed(futs):
            d = futs[fut]
            try:
                day = fut.result()
                n = write_day(day)
                done += 1
                if done % 20 == 0 or done == len(todo):
                    print(f"  [{done}/{len(todo)}] {d}: {n} 檔", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"  ❌ {d}: {e}", file=sys.stderr, flush=True)
                failed.append(d)

    print(f"\n🏁 完成: 成功 {done} / 失敗 {len(failed)}", flush=True)
    if failed:
        print(f"   失敗日期: {failed}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
