#!/usr/bin/env python3
"""每週抓集保「股權分散表」(TDCC OpenData 1-5) → Google Drive 股權分散表資料夾。

來源: https://opendata.tdcc.com.tw/getOD.ashx?id=1-5
      每週更新一次 (資料日期 = 上一個週五),欄位:
      資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%
      持股分級 1~15 = 級距,16 = 差異數調整,17 = 合計。

存檔位置 (二擇一,預設走本機同步路徑):
  1. 本機 Google Drive 同步資料夾 (預設)
     Y:\\我的雲端硬碟\\Telegram Bot\\股權分散表\\TDCC_OD_1-5_YYYYMMDD.csv
     ⚠️ Service Account 沒有 Drive 儲存配額,**不能在「我的雲端硬碟」建新檔**,
        每週都是新檔名 → 只能靠本機同步資料夾寫入 (見 docs/FEATURES.md §13)
  2. `--drive-api`:走 Service Account (只有在 Drive 上已存在同名檔時能覆蓋)

環境變數:
  TDCC_LOCAL_DIR      覆寫本機同步資料夾路徑
  TDCC_DRIVE_FOLDER   Drive folder id (預設 133xYbjvZXpj7cFLMWIjzkRfYBnipe1VE)
  GOOGLE_CREDENTIALS  只有 --drive-api 才需要

用法:
  python fetch_tdcc.py              # 本機:抓最新一週 → 存 Drive 同步資料夾 → 重建 JSON
  python fetch_tdcc.py --no-build   # 只存檔,不重建 JSON
  python fetch_tdcc.py --force      # 已存在同名檔也覆蓋
  python fetch_tdcc.py --cloud      # GitHub Actions:不碰 Drive,增量併進現有 JSON
                                    #   (Drive 存檔那半由 GAS TdccShareholding.gs 負責)
"""
from __future__ import annotations

import argparse
import csv
import io
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE = Path(__file__).resolve().parent
OD_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5"
DEFAULT_LOCAL_DIR = r"Y:\我的雲端硬碟\Telegram Bot\股權分散表"
DEFAULT_FOLDER_ID = "133xYbjvZXpj7cFLMWIjzkRfYBnipe1VE"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)
MAX_RETRIES = 5
BACKOFFS = [0, 3, 6, 12, 24]
MIN_BYTES = 500_000  # 全市場 ~4000 檔 × 17 級距,正常 2MB 以上


def fetch_csv() -> bytes:
    last = ""
    for attempt in range(1, MAX_RETRIES + 1):
        if BACKOFFS[attempt - 1]:
            time.sleep(BACKOFFS[attempt - 1])
        try:
            r = requests.get(
                OD_URL, timeout=120, headers={"User-Agent": UA}, verify=False
            )
        except requests.RequestException as e:
            last = f"exception: {e}"
            print(f"⚠️ retry {attempt}/{MAX_RETRIES}: {last}", flush=True)
            continue
        if r.status_code != 200:
            last = f"HTTP {r.status_code}"
            print(f"⚠️ retry {attempt}/{MAX_RETRIES}: {last}", flush=True)
            continue
        if len(r.content) < MIN_BYTES:
            last = f"內容過短 (len={len(r.content)})"
            print(f"⚠️ retry {attempt}/{MAX_RETRIES}: {last}", flush=True)
            continue
        head = r.content[:200].decode("utf-8-sig", errors="replace")
        if "證券代號" not in head:
            last = f"缺欄位「證券代號」(前 80 字: {head[:80]!r})"
            print(f"⚠️ retry {attempt}/{MAX_RETRIES}: {last}", flush=True)
            continue
        return r.content
    raise RuntimeError(f"放棄下載股權分散表: {last}")


def data_date(raw: bytes) -> str:
    """從內容取資料日期 (整份同一天,取第一列即可,順便驗證格式)。"""
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8-sig", errors="replace")))
    for row in reader:
        d = (row.get("資料日期") or "").strip()
        if len(d) == 8 and d.isdigit():
            return d
        break
    raise RuntimeError("無法從 CSV 取得資料日期")


def save_local(raw: bytes, filename: str, force: bool) -> Path:
    dirpath = Path(os.environ.get("TDCC_LOCAL_DIR", DEFAULT_LOCAL_DIR))
    if not dirpath.is_dir():
        raise RuntimeError(
            f"本機 Drive 同步資料夾不存在: {dirpath}\n"
            "  → 確認 Google Drive 桌面版已掛載,或用 TDCC_LOCAL_DIR 指定路徑,"
            "或改用 --drive-api"
        )
    target = dirpath / filename
    if target.exists() and not force:
        print(f"ℹ️ 已存在,跳過寫入: {target} ({target.stat().st_size:,} bytes)")
        return target
    target.write_bytes(raw)
    print(f"✅ 已寫入: {target} ({len(raw):,} bytes)")
    return target


def save_drive_api(raw: bytes, filename: str) -> None:
    """SA 覆蓋既有檔 (新檔名會失敗 — SA 無儲存配額)。"""
    sys.path.insert(0, str(BASE))
    from fetch_stocks import drive_service, upload  # noqa: WPS433

    folder = os.environ.get("TDCC_DRIVE_FOLDER", DEFAULT_FOLDER_ID)
    upload(drive_service(), folder, filename, raw, mime="text/csv")


def main() -> int:
    ap = argparse.ArgumentParser(description="抓 TDCC 股權分散表 → Drive")
    ap.add_argument("--drive-api", action="store_true",
                    help="改走 Service Account 上傳 (只能覆蓋既有檔)")
    ap.add_argument("--force", action="store_true", help="已存在同名檔也覆蓋")
    ap.add_argument("--no-build", action="store_true",
                    help="不重建 data/shareholding.json")
    ap.add_argument("--cloud", action="store_true",
                    help="雲端模式:不寫 Drive,直接把這份 CSV 增量併進現有 JSON")
    args = ap.parse_args()

    print("🗂️  下載集保股權分散表 (TDCC OpenData 1-5) ...", flush=True)
    raw = fetch_csv()
    dstr = data_date(raw)
    filename = f"TDCC_OD_1-5_{dstr}.csv"
    print(f"📅 資料日期: {dstr} · {len(raw):,} bytes", flush=True)

    tmp_csv = None
    if args.cloud:
        # 雲端沒有 Drive 同步磁碟,SA 又不能建新檔 → 這裡只管 JSON,
        # Drive 存檔交給 GAS (GoogleAppScript/統一監控Phase1/TdccShareholding.gs.txt)
        fd, tmp_csv = tempfile.mkstemp(prefix="tdcc_", suffix=".csv")
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        print(f"☁️ 雲端模式:不寫 Drive,暫存 {tmp_csv}")
    elif args.drive_api:
        save_drive_api(raw, filename)
    else:
        save_local(raw, filename, args.force)

    if not args.no_build:
        print("\n🔧 重建 data/shareholding.json ...", flush=True)
        cmd = [sys.executable, str(BASE / "build_shareholding.py")]
        if args.cloud:
            cmd += ["--merge", "--no-local-dir", "--csv", tmp_csv]
        rc = subprocess.call(cmd, cwd=str(BASE))
        if tmp_csv:
            try:
                os.unlink(tmp_csv)
            except OSError:
                pass
        if rc != 0:
            print("❌ build_shareholding.py 失敗", file=sys.stderr)
            return rc
    print("\n🏁 完成", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
