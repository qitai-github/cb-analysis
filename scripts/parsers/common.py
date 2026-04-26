"""共用工具:代碼/名稱/數字解析、ParsedSource dataclass。"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

# Excel-import 防呆: ="0050" 或 =00400A
_EXCEL_PREFIX = re.compile(r'^="?(.*?)"?$')


def clean_code(raw: str) -> str:
    """清洗代碼。
    支援:
      ="00400A"  → 00400A   (TWSE Excel-formula prefix)
      "00679B"   → 00679B   (TPEx 已被 csv 模組去掉外層引號)
      00679B     → 00679B
    """
    s = (raw or "").strip()
    m = _EXCEL_PREFIX.match(s)
    if m:
        return m.group(1).strip()
    return s.strip('"').strip()


def clean_name(raw: str) -> str:
    """去頭尾空白與引號 (來源常有固定寬度 padding)。"""
    return (raw or "").strip().strip('"').strip()


def parse_int(raw: Any) -> Optional[int]:
    """容忍千分號/引號/空白/'--' 的整數解析。空值回 None。"""
    if raw is None:
        return None
    s = str(raw).strip().strip('"').replace(",", "").strip()
    if s in ("", "--", "-"):
        return None
    try:
        return int(s)
    except ValueError:
        try:
            return int(float(s))
        except ValueError:
            return None


def parse_float(raw: Any) -> Optional[float]:
    """同上,但回 float。"""
    if raw is None:
        return None
    s = str(raw).strip().strip('"').replace(",", "").strip()
    if s in ("", "--", "-"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def to_iso_date(yyyymmdd: str) -> str:
    """YYYYMMDD → YYYY-MM-DD (供 Supabase date 欄位用)。"""
    return f"{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:8]}"


@dataclass
class ParsedSource:
    """單一 CSV 解析結果。

    Attributes:
        db_table:               對應 Supabase 表名 ('stock_quotes' 等)
        db_rows:                可直接餵 supabase.table().upsert(rows) 的 dicts
        timeseries_key:         all-data.json 該來源在 root 的 key
                                ('stockTrading' / 'cbInstitutional' 等)
        timeseries_categories:  此來源在 timeseries 表的 "類別" 欄列舉,
                                順序須與既有 all-data.json 對齊。
                                (用於 step 3 合併時組 row 順序)
        daily_values:           {stock_id: {category: value}}
                                step 3 合併時把這些值寫到 trade_date 那一欄。
        stock_names:            {stock_id: name} (給 step 3 寫 timeseries 第一欄)
        trade_date:             YYYYMMDD
    """

    db_table: str
    db_rows: list[dict[str, Any]] = field(default_factory=list)
    timeseries_key: str = ""
    timeseries_categories: list[str] = field(default_factory=list)
    daily_values: dict[str, dict[str, Any]] = field(default_factory=dict)
    stock_names: dict[str, str] = field(default_factory=dict)
    trade_date: str = ""

    @property
    def row_count(self) -> int:
        return len(self.db_rows)
