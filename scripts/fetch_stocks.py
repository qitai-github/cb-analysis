#!/usr/bin/env python3
"""GitHub Actions 備援:6 類每日 CSV → Google Drive (Service Account).

與 GAS AutoRepair.gs 的 SOURCE_RULES 平行對應。當 GAS 路徑因 307 / bot 偵測
失敗時,由 GitHub Actions 在非 Google 雲端 IP 上重抓,存進相同 Drive 資料夾
(同名覆蓋),讓下游 GAS pipeline 透明無感。

涵蓋來源 (folder_key):
  STOCK_INST_TWSE    個股法人(上市)    TWSE_T86_YYYYMMDD.csv       Big5 raw
  STOCK_INST_TPEX    個股法人(上櫃)    TPEx_T86_YYYYMMDD.csv       Big5 raw
  STOCK_PRICE_TWSE   個股交易(上市)    TWSE-Daily-YYYYMMDD.csv     MS950→UTF-8
  STOCK_PRICE_TPEX   個股交易(上櫃)    TPEx-EW-YYYYMMDD.csv        MS950→UTF-8
  CB_PRICE           CB每日交易        RSta0113.YYYYMMDD-C.csv     Big5 raw
  CB_INST            CB每日法人        ThreePrimaryCB_YYYYMMDD.csv Big5→UTF-8

環境變數:
  GOOGLE_CREDENTIALS  Service Account JSON (整份內容字串)
  DRIVE_FOLDERS       JSON,key = 上列 folder_key,value = Drive folder ID
                      範例: {"STOCK_INST_TWSE":"10_WWPDk...","CB_PRICE":"1A7..."}
                      未列出的 key 會被跳過 (允許只備援部分來源)
  FETCH_DATE          可選:YYYYMMDD 強制抓指定日期,未設則抓今天 (Asia/Taipei)
  SOURCES             可選:以逗號分隔的 folder_key 清單,只跑這幾個。空白 = 全跑
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

import requests
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaInMemoryUpload

TAIPEI = timezone(timedelta(hours=8))
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)

MAX_RETRIES = 5
# 2 / 4 / 8 / 16 / 32s,第 1 次不等
BACKOFFS = [0, 2, 4, 8, 16]


# ── SOURCE_RULES 與 GAS AutoRepair.gs SOURCE_RULES 對應 ──────────────
def _slash(d: str) -> str:
    return f"{d[:4]}/{d[4:6]}/{d[6:]}"


def _tpex_cb_price_url(d: str) -> str:
    y, m = d[:4], d[4:6]
    return (
        "https://www.tpex.org.tw/storage/bond_zone/tradeinfo/cb/"
        f"{y}/{y}{m}/RSta0113.{d}-C.csv"
    )


SOURCE_RULES: dict[str, dict] = {
    "STOCK_INST_TWSE": {
        "label": "個股法人(上市)",
        "url": lambda d: (
            "https://www.twse.com.tw/rwd/zh/fund/T86"
            f"?date={d}&selectType=ALLBUT0999&response=csv"
        ),
        "filename": lambda d: f"TWSE_T86_{d}.csv",
        "referer": "https://www.twse.com.tw/zh/fund/T86",
        "encoding": "big5",
        "min_len": 500,
        "save_mode": "raw",
        "must_contain": None,
    },
    "STOCK_INST_TPEX": {
        "label": "個股法人(上櫃)",
        "url": lambda d: (
            "https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade"
            f"?type=Daily&sect=AL&date={urllib.parse.quote(_slash(d), safe='')}"
            "&id=&response=csv"
        ),
        "filename": lambda d: f"TPEx_T86_{d}.csv",
        "referer": "https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade",
        "encoding": "big5",
        "min_len": 500,
        "save_mode": "raw",
        "must_contain": None,
    },
    "STOCK_PRICE_TWSE": {
        "label": "個股交易(上市)",
        "url": lambda d: (
            "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX"
            f"?date={d}&type=ALLBUT0999&response=csv"
        ),
        "filename": lambda d: f"TWSE-Daily-{d}.csv",
        "referer": "https://www.twse.com.tw/zh/afterTrading/MI_INDEX",
        "encoding": "ms950",
        "min_len": 1000,
        "save_mode": "textBlob",
        "must_contain": "證券代號",
    },
    "STOCK_PRICE_TPEX": {
        "label": "個股交易(上櫃)",
        "url": lambda d: (
            "https://www.tpex.org.tw/www/zh-tw/afterTrading/otc"
            f"?date={_slash(d)}&type=EW&id=&response=csv&order=0&sort=asc"
        ),
        "filename": lambda d: f"TPEx-EW-{d}.csv",
        "referer": "https://www.tpex.org.tw/www/zh-tw/afterTrading/otc",
        "encoding": "ms950",
        "min_len": 500,
        "save_mode": "textBlob",
        "must_contain": None,
    },
    "CB_PRICE": {
        "label": "CB每日交易",
        "url": _tpex_cb_price_url,
        "filename": lambda d: f"RSta0113.{d}-C.csv",
        # 靜態 CSV,不需 cookie
        "referer": None,
        "encoding": "big5",
        "min_len": 100,
        "save_mode": "raw",
        "must_contain": None,
    },
    "CB_INST": {
        "label": "CB每日法人",
        "url": lambda d: (
            "https://www.tpex.org.tw/www/zh-tw/bond/newCb3itrade"
            f"?type=Daily&date={d[:4]}%2F{d[4:6]}%2F{d[6:]}"
            "&id=&response=csv&order=8&sort=desc"
        ),
        "filename": lambda d: f"ThreePrimaryCB_{d}.csv",
        "referer": "https://www.tpex.org.tw/www/zh-tw/bond/newCb3itrade",
        "encoding": "big5",
        "min_len": 100,
        "save_mode": "createFile",  # 在 Python 這邊等同 textBlob(都 UTF-8)
        "must_contain": None,
    },
}


# ── HTTP ─────────────────────────────────────────────────────────────
def make_session(referer: Optional[str]) -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        "Accept": "text/csv,text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    })
    if referer:
        s.headers["Referer"] = referer
        # 主動暖身:拿 session cookie
        try:
            s.get(referer, timeout=30)
        except requests.RequestException as e:
            print(f"⚠️ warmup 失敗 ({referer}): {e}", flush=True)
    return s


def fetch_source(rule: dict, date_str: str) -> Optional[bytes]:
    """回傳 raw bytes (伺服器原始編碼) 或 None (當日無資料 / 假日)。失敗拋例外。"""
    url = rule["url"](date_str)
    encoding = rule["encoding"]
    min_len = rule["min_len"]
    must_contain = rule.get("must_contain")

    sess = make_session(rule["referer"])
    last = ""

    for attempt in range(1, MAX_RETRIES + 1):
        if BACKOFFS[attempt - 1]:
            time.sleep(BACKOFFS[attempt - 1])
        try:
            r = sess.get(url, timeout=30, allow_redirects=True)
        except requests.RequestException as e:
            last = f"exception: {e}"
            print(f"⚠️ retry {attempt}/{MAX_RETRIES}: {last}", flush=True)
            continue

        if r.status_code != 200:
            last = f"HTTP {r.status_code}"
            # 重新暖身後重試
            if rule["referer"]:
                try:
                    sess.get(rule["referer"], timeout=30)
                except requests.RequestException:
                    pass
            print(f"⚠️ retry {attempt}/{MAX_RETRIES}: {last}", flush=True)
            continue

        # 解碼一份 sample 用於驗證
        try:
            sample = r.content.decode(encoding, errors="replace")
        except LookupError:
            sample = r.content.decode("utf-8", errors="replace")

        trimmed = sample.lstrip()
        if trimmed.startswith("<"):
            last = f"回應是 HTML (前 60 字: {trimmed[:60]!r})"
            if rule["referer"]:
                try:
                    sess.get(rule["referer"], timeout=30)
                except requests.RequestException:
                    pass
            print(f"⚠️ retry {attempt}/{MAX_RETRIES}: {last}", flush=True)
            continue

        if len(sample) < min_len:
            last = f"內容過短 (len={len(sample)})"
            print(f"⚠️ retry {attempt}/{MAX_RETRIES}: {last}", flush=True)
            continue

        if "查詢無資料" in sample:
            print(
                f"ℹ️ {rule['label']} {date_str}: 查詢無資料 (假日 / 尚未開盤)",
                flush=True,
            )
            return None

        if must_contain and must_contain not in sample:
            last = f"CSV 缺欄位「{must_contain}」"
            print(f"⚠️ retry {attempt}/{MAX_RETRIES}: {last}", flush=True)
            continue

        return r.content

    raise RuntimeError(f"放棄 {rule['label']} {date_str}: {last}")


def prepare_upload_bytes(rule: dict, raw: bytes) -> bytes:
    """依 save_mode 決定上傳 bytes:raw 保留原編碼,其餘轉 UTF-8。"""
    if rule["save_mode"] == "raw":
        return raw
    try:
        text = raw.decode(rule["encoding"], errors="replace")
    except LookupError:
        text = raw.decode("utf-8", errors="replace")
    return text.encode("utf-8")


# ── Google Drive ─────────────────────────────────────────────────────
def drive_service():
    creds_json = os.environ["GOOGLE_CREDENTIALS"]
    info = json.loads(creds_json)
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/drive"]
    )
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def upload(
    service,
    folder_id: str,
    filename: str,
    data: bytes,
    mime: str = "text/csv",
) -> None:
    q = (
        f"name = '{filename}' and '{folder_id}' in parents "
        "and trashed = false"
    )
    try:
        existing = (
            service.files()
            .list(
                q=q,
                fields="files(id)",
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            )
            .execute()
            .get("files", [])
        )
    except HttpError as e:
        raise RuntimeError(f"Drive list 失敗: {e}") from e

    media = MediaInMemoryUpload(data, mimetype=mime, resumable=False)
    if existing:
        fid = existing[0]["id"]
        service.files().update(
            fileId=fid, media_body=media, supportsAllDrives=True
        ).execute()
        print(f"♻️ 覆蓋: {filename} (id={fid})", flush=True)
    else:
        service.files().create(
            body={"name": filename, "parents": [folder_id]},
            media_body=media,
            supportsAllDrives=True,
        ).execute()
        print(f"✅ 新建: {filename}", flush=True)


# ── Main ─────────────────────────────────────────────────────────────
def target_date() -> datetime:
    override = os.environ.get("FETCH_DATE", "").strip()
    if override:
        return datetime.strptime(override, "%Y%m%d").replace(tzinfo=TAIPEI)
    return datetime.now(TAIPEI)


def selected_keys(folder_map: dict[str, str]) -> list[str]:
    requested = os.environ.get("SOURCES", "").strip()
    if requested:
        keys = [k.strip() for k in requested.split(",") if k.strip()]
    else:
        keys = list(SOURCE_RULES.keys())
    out = []
    for k in keys:
        if k not in SOURCE_RULES:
            print(f"⚠️ 未知來源 {k},跳過", flush=True)
            continue
        if k not in folder_map or not folder_map[k]:
            print(f"⚠️ {k} 無 Drive 資料夾設定,跳過", flush=True)
            continue
        out.append(k)
    return out


def main() -> int:
    folder_map_raw = os.environ.get("DRIVE_FOLDERS", "").strip()
    if not folder_map_raw:
        print("❌ 必須設定 DRIVE_FOLDERS (JSON)", file=sys.stderr)
        return 2
    try:
        folder_map: dict[str, str] = json.loads(folder_map_raw)
    except json.JSONDecodeError as e:
        print(f"❌ DRIVE_FOLDERS JSON 解析失敗: {e}", file=sys.stderr)
        return 2

    d = target_date()
    dstr = d.strftime("%Y%m%d")
    print(f"🗓️  目標日期: {d.strftime('%Y-%m-%d (%A)')}", flush=True)

    # 非交易日 (週末/國定假日) skip — 但若使用者明確指定 FETCH_DATE 仍照跑
    if not os.environ.get("FETCH_DATE", "").strip():
        try:
            from lib.calendar_tw import is_trading_day
            if not is_trading_day(dstr):
                print(f"ℹ️ {dstr} 非交易日 (週末/國定假日),跳過", flush=True)
                return 0
        except Exception as e:  # noqa: BLE001
            print(f"⚠️ 假日檢查失敗 (照跑): {e}", file=sys.stderr)

    keys = selected_keys(folder_map)
    if not keys:
        print("❌ 沒有任何可執行的來源", file=sys.stderr)
        return 2
    print(f"🎯 將處理 {len(keys)} 個來源: {keys}", flush=True)

    svc = drive_service()
    failed: list[str] = []

    for i, key in enumerate(keys):
        rule = SOURCE_RULES[key]
        folder_id = folder_map[key]
        print(f"\n=== [{i+1}/{len(keys)}] {rule['label']} ({key}) ===", flush=True)
        try:
            raw = fetch_source(rule, dstr)
        except Exception as e:
            print(f"❌ 抓取失敗: {e}", file=sys.stderr, flush=True)
            failed.append(key)
            continue
        if raw is None:
            continue  # 當日無資料
        try:
            upload(svc, folder_id, rule["filename"](dstr), prepare_upload_bytes(rule, raw))
        except Exception as e:
            print(f"❌ 上傳失敗: {e}", file=sys.stderr, flush=True)
            failed.append(key)

        # 來源間 3s 間隔,降低被擋機率
        if i < len(keys) - 1:
            time.sleep(3)

    if failed:
        print(f"\n❌ 完成但有失敗: {failed}", file=sys.stderr, flush=True)
        return 1
    print("\n🏁 全部完成", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
