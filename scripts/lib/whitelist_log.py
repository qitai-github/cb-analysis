"""把每日白名單聯集記錄到 Google Sheet。

用 Service Account 直接寫(不走 gviz read-only API),需要 sheets scope。
Sheet 必須先把 SA email 加為「編輯者」否則 update 會 403。

Sheet 格式 (worksheet "Stock"):
  A=日期 | B=標的數 | C/D/E/.../ = 標的代號 (每檔一欄,排序)

例:
  2026-06-11 | 358 | 1101 | 1256 | 1295 | ... | 8996

行為:
  - 同一天再跑 → 先 clear 該列再寫 (避免昨日比較長的尾巴殘留)
  - 新的一天 → append 一列
"""

from __future__ import annotations

import json
import os
from typing import Iterable, Optional

from google.oauth2 import service_account
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

DEFAULT_SHEET_ID = "1Ia3noTeXnZFl2N6D-z5itUlqyAYHkYAtLl-ESFUn7bc"
DEFAULT_WORKSHEET = "Stock"
HEADER = ["日期", "標的數", "標的清單"]

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


def _col_letter(n: int) -> str:
    """1→A, 26→Z, 27→AA, 358→MT。給「個別一檔一欄」寫入用。"""
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(ord("A") + r) + s
    return s


def _get_dates_column(sheet_id: str, worksheet: str) -> list[str]:
    """只讀 A 欄 (日期) 用來找匹配 row。回傳 list (含 header)。"""
    rng = f"'{worksheet}'!A:A"
    resp = _svc().spreadsheets().values().get(
        spreadsheetId=sheet_id, range=rng,
        valueRenderOption="FORMATTED_VALUE"
    ).execute()
    vals = resp.get("values", [])
    return [(r[0] if r else "") for r in vals]


def _ensure_header(sheet_id: str, worksheet: str,
                   dates_col: list[str]) -> None:
    if dates_col:
        return
    rng = f"'{worksheet}'!A1:C1"
    _svc().spreadsheets().values().update(
        spreadsheetId=sheet_id, range=rng,
        valueInputOption="USER_ENTERED",
        body={"values": [HEADER]},
    ).execute()


def _clear_row(sheet_id: str, worksheet: str, row_idx: int) -> None:
    """清掉整列 (避免上次寫得比較長的尾巴殘留)。"""
    rng = f"'{worksheet}'!A{row_idx}:ZZ{row_idx}"
    _svc().spreadsheets().values().clear(
        spreadsheetId=sheet_id, range=rng, body={},
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
    # 每檔一欄: 日期 / 標的數 / 1101 / 1256 / ...
    row_data: list = [d, len(code_list), *code_list]
    end_col = _col_letter(len(row_data))

    dates_col = _get_dates_column(sheet_id, worksheet)
    _ensure_header(sheet_id, worksheet, dates_col)
    if not dates_col:
        dates_col = [HEADER[0]]  # 表示已有 header 但無資料

    # 找該日期 (跳過 header)
    target_row_idx = None
    for i, v in enumerate(dates_col[1:], start=2):
        if str(v).strip() == d:
            target_row_idx = i
            break

    if target_row_idx is not None:
        # 先清整列再寫,避免之前較長的尾巴殘留
        _clear_row(sheet_id, worksheet, target_row_idx)
        rng = f"'{worksheet}'!A{target_row_idx}:{end_col}{target_row_idx}"
        _svc().spreadsheets().values().update(
            spreadsheetId=sheet_id, range=rng,
            valueInputOption="USER_ENTERED",
            body={"values": [row_data]},
        ).execute()
        return {"mode": "update", "row": target_row_idx,
                "count": len(code_list)}

    # append 新列 — sheets API 自動找下一空列從 A 開始
    rng = f"'{worksheet}'!A:A"
    resp = _svc().spreadsheets().values().append(
        spreadsheetId=sheet_id, range=rng,
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": [row_data]},
    ).execute()
    upd = resp.get("updates", {}).get("updatedRange", "")
    return {"mode": "append", "row": upd,
            "count": len(code_list)}
