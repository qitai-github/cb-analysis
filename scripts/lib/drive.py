"""從 Google Drive 下載指定資料夾內的檔案 (給 parse_and_export.py 用)。

設計與 fetch_stocks.py 對稱:後者上傳 raw CSV,本模組下載剛剛被上傳的檔。

Dev mode: 設 `DRIVE_FROM_FIXTURES=1` 時,改從 scripts/tests/fixtures/ 讀同名檔,
方便本機沒 Drive 憑證也能 e2e 跑 parse_and_export.py。
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
from typing import Optional

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

SCOPES = ["https://www.googleapis.com/auth/drive"]
_FIXTURE_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"

_service = None


def _get_service():
    global _service
    if _service is not None:
        return _service
    raw = os.environ.get("GOOGLE_CREDENTIALS", "").strip()
    if not raw:
        raise SystemExit("缺少環境變數 GOOGLE_CREDENTIALS")
    info = json.loads(raw)
    creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    _service = build("drive", "v3", credentials=creds, cache_discovery=False)
    return _service


def folder_map() -> dict[str, str]:
    """從 DRIVE_FOLDERS env (JSON) 解析 folder_key → folder_id。"""
    raw = os.environ.get("DRIVE_FOLDERS", "").strip()
    if not raw:
        raise SystemExit("缺少環境變數 DRIVE_FOLDERS")
    return json.loads(raw)


def download(folder_id: str, filename: str) -> Optional[bytes]:
    """找 folder 內精確檔名的檔案,回傳 bytes;找不到回 None。

    DRIVE_FROM_FIXTURES=1 時改從 scripts/tests/fixtures/ 讀。
    """
    if os.environ.get("DRIVE_FROM_FIXTURES") == "1":
        path = _FIXTURE_DIR / filename
        if path.exists():
            return path.read_bytes()
        return None

    svc = _get_service()
    q = f"name = '{filename}' and '{folder_id}' in parents and trashed = false"
    res = svc.files().list(
        q=q,
        fields="files(id,name)",
        pageSize=5,
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()
    files = res.get("files", [])
    if not files:
        return None
    file_id = files[0]["id"]
    request = svc.files().get_media(fileId=file_id, supportsAllDrives=True)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _status, done = downloader.next_chunk()
    return buf.getvalue()
