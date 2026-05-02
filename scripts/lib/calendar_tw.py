"""台股交易日判斷 (週末 + TWSE 官方休市日)。

資料來源: https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule
動態抓官方公告,不用每年手動更新國定假日清單。

行為:
  is_trading_day("20260101") -> False  (元旦)
  is_trading_day("20260104") -> False  (週日)
  is_trading_day("20260105") -> True   (週一非休市)

API 失敗時 fallback 為 True (寧可跑也不要錯過真實交易日)。
"""

from __future__ import annotations

import functools
from datetime import datetime
from typing import Set

import requests

TWSE_HOLIDAY_URL = "https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule"
TIMEOUT = 15


@functools.lru_cache(maxsize=1)
def fetch_holidays() -> Set[str]:
    """從 TWSE OpenAPI 抓休市日,回傳 YYYYMMDD set。process 內 cached。"""
    try:
        r = requests.get(TWSE_HOLIDAY_URL, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️ TWSE 假日 API 失敗: {exc} (fallback: 一律視為交易日)")
        return set()

    out: Set[str] = set()
    for item in data:
        # 格式:Date = "115/01/01" (民國年/月/日)
        roc = (item.get("Date") or "").strip()
        parts = roc.split("/")
        if len(parts) != 3:
            continue
        try:
            year = int(parts[0]) + 1911
            mm = int(parts[1])
            dd = int(parts[2])
            out.add(f"{year:04d}{mm:02d}{dd:02d}")
        except ValueError:
            continue
    return out


def is_trading_day(yyyymmdd: str) -> bool:
    """檢查 yyyymmdd 是否為台股交易日。

    規則:
      - 週六/週日 → False
      - 在 TWSE 官方休市日清單 → False
      - 其他 → True
      - 解析失敗 → True (保守:寧可跑)
    """
    try:
        d = datetime.strptime(yyyymmdd, "%Y%m%d").date()
    except ValueError:
        return True
    if d.weekday() >= 5:  # Sat=5, Sun=6
        return False
    return yyyymmdd not in fetch_holidays()
