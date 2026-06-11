"""把每日白名單聯集記錄到 Google Sheet。

用 Service Account 直接寫(不走 gviz read-only API),需要 sheets scope。
Sheet 必須先把 SA email 加為「編輯者」否則 update 會 403。

Sheet 格式 (worksheet "Stock"):
  日期         | 標的數 | 完整清單(逗號分隔)
  2026-06-05  | 360   | 1101,1102,...
  2026-06-04  | 359   | 1101,1102,...

行為:
  - 同一天再跑 → update 該列 (用日期當 key)
  - 新的一天 → append 一列
"""

from __future__ import annotations

import json
import os
from typing import Iterable, Optional

from google.oauth2 import service_account
from googleapiclient.discovery import build

# drive scope 已涵蓋多數情境,但為了寫 sheet 顯式加 spreadsheets
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

DEFAULT_SHEET_ID = "1Ia3noTeXnZFl2N6D-z5itUlqyAYHkYAtLl-ESFUn7bc"
DEFAULT_WORKSHEET = "Stock"
HEADER = ["日期", "標的數", "完整清單"]

_service = None


def _svc():
    global _service
    if _service is not None:
        return _service
    raw = os.environ.get("GOOGLE_CREDENTIALS", "").strip()
    if not raw:
        raise SystemExit("缺少環境變數 GOOGLE_CREDENTIALS")
    info = json.loads(raw)
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=SCOPES)
    _service = build("sheets", "v4", credentials=creds,
                     cache_discovery=False)
    return _service


def _get_all_rows(sheet_id: str, worksheet: str) -> list[list[str]]:
    """讀整個 worksheet,回 2D list (含 header)。"""
    rng = f"'{worksheet}'!A:C"
    resp = _svc().spreadsheets().values().get(
        spreadsheetId=sheet_id, range=rng,
        valueRenderOption="FORMATTED_VALUE"
    ).execute()
    return resp.get("values", [])


def _ensure_header(sheet_id: str, worksheet: str,
                   rows: list[list[str]]) -> None:
    """若 worksheet 是空的,寫入 header。"""
    if rows:
        return
    rng = f"'{worksheet}'!A1:C1"
    _svc().spreadsheets().values().update(
        spreadsheetId=sheet_id, range=rng,
        valueInputOption="USER_ENTERED",
        body={"values": [HEADER]},
    ).execute()


def write_daily(trade_date: str, codes: Iterable[str], *,
                sheet_id: Optional[str] = None,
                worksheet: Optional[str] = None) -> dict:
    """trade_date 格式 YYYYMMDD 或 YYYY-MM-DD;codes 可重複,內部會 sort+dedup。
    回傳 {'mode':'update'|'append', 'row':N, 'count':N}.
    """
    sheet_id = sheet_id or DEFAULT_SHEET_ID
    worksheet = worksheet or DEFAULT_WORKSHEET

    # 正規化日期 YYYY-MM-DD
    d = str(trade_date).strip().replace("/", "-")
    if len(d) == 8 and d.isdigit():
        d = f"{d[:4]}-{d[4:6]}-{d[6:]}"

    code_list = sorted({str(c).strip() for c in codes if str(c).strip()})
    row_data = [d, len(code_list), ",".join(code_list)]

    rows = _get_all_rows(sheet_id, worksheet)
    _ensure_header(sheet_id, worksheet, rows)
    if not rows:
        rows = [HEADER]

    # 找該日期是否已存在 (跳過 header row)
    target_row_idx = None  # 1-based 列號 (Sheet 規格)
    for i, r in enumerate(rows[1:], start=2):
        if r and str(r[0]).strip() == d:
            target_row_idx = i
            break

    if target_row_idx is not None:
        rng = f"'{worksheet}'!A{target_row_idx}:C{target_row_idx}"
        _svc().spreadsheets().values().update(
            spreadsheetId=sheet_id, range=rng,
            valueInputOption="USER_ENTERED",
            body={"values": [row_data]},
        ).execute()
        return {"mode": "update", "row": target_row_idx,
                "count": len(code_list)}

    # append 新列
    rng = f"'{worksheet}'!A:C"
    resp = _svc().spreadsheets().values().append(
        spreadsheetId=sheet_id, range=rng,
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": [row_data]},
    ).execute()
    # updates.updatedRange 形如 'Stock'!A361:C361
    upd = resp.get("updates", {}).get("updatedRange", "")
    return {"mode": "append", "row": upd,
            "count": len(code_list)}
