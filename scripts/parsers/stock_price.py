"""個股交易:TWSE-Daily (Big5, 多區塊) + TPEx-EW (UTF-8) → stockTrading + stock_quotes。

時間序列類別 (對齊 js/config.js stockTrading.categories):
  ['成交股數', '開盤價', '最高價', '最低價', '收盤價']
"""

from __future__ import annotations

import csv
import io
from typing import Optional

from .common import (
    ParsedSource,
    clean_code,
    clean_name,
    parse_float,
    parse_int,
    to_iso_date,
)

CATEGORIES = ["成交股數", "開盤價", "最高價", "最低價", "收盤價"]
TIMESERIES_KEY = "stockTrading"
DB_TABLE = "stock_quotes"


def parse(csv_bytes: bytes, *, market: str, trade_date: str) -> ParsedSource:
    # 來源可能是 Big5 (GAS 寫進 Drive 的 raw) 或 UTF-8 (fetch_stocks scrape 後
    # prepare_upload_bytes 轉換的)。先試 UTF-8,失敗 fallback Big5。
    try:
        text = csv_bytes.decode("utf-8")
    except UnicodeDecodeError:
        text = csv_bytes.decode("big5", errors="replace")
    if market == "TWSE":
        return _parse_twse(text, trade_date)
    if market == "TPEX":
        return _parse_tpex(text, trade_date)
    raise ValueError(f"unknown market: {market!r}")


def _parse_twse(text: str, trade_date: str) -> ParsedSource:
    """TWSE-Daily MI_INDEX type=ALLBUT0999 多區塊 CSV;
    在某行找到個股區塊 header (證券代號, 證券名稱, ...),從下一列開始解析。

    Header 預期欄位:
      0  證券代號 (="0050")
      1  證券名稱
      2  成交股數
      3  成交筆數
      4  成交金額
      5  開盤價
      6  最高價
      7  最低價
      8  收盤價
      9  漲跌(+/-)            '+' / '-' / 'X' / ''
      10 漲跌價差              絕對值
      11-14 最後揭示買價/量/賣價/量
      15 本益比

    停牌或無交易的個股價格欄會是 '--' (parse_float → None)。
    """
    out = ParsedSource(
        db_table=DB_TABLE,
        timeseries_key=TIMESERIES_KEY,
        timeseries_categories=CATEGORIES,
        trade_date=trade_date,
    )
    reader = csv.reader(io.StringIO(text))
    in_section = False
    for row in reader:
        if not in_section:
            if (len(row) >= 2
                and "證券代號" in row[0]
                and "證券名稱" in row[1]):
                in_section = True
            continue
        if not row or len(row) < 11:
            continue
        code = clean_code(row[0])
        if not code or not code[0].isalnum():
            # 區塊結束 (footer / 空行)
            break
        name = clean_name(row[1])
        if not name:
            break
        volume_shares = parse_int(row[2])
        transactions = parse_int(row[3])
        turnover = parse_int(row[4])
        open_p = parse_float(row[5])
        high_p = parse_float(row[6])
        low_p = parse_float(row[7])
        close_p = parse_float(row[8])
        change_amt = _apply_sign(row[9], parse_float(row[10]))
        _emit(out, code, name, "TWSE", trade_date,
              open_p, high_p, low_p, close_p, change_amt,
              volume_shares, turnover, transactions)
    return out


def _parse_tpex(text: str, trade_date: str) -> ParsedSource:
    """TPEx-EW 格式:
      Line 0: 標題 (上櫃股票每日收盤行情...)
      Line 1: 產業類別:...
      Line 2: 資料日期:...
      Line 3: header (代號,名稱,收盤,漲跌,開盤,最高,最低,成交股數,成交金額(元),成交筆數,...)
      Line 4+: data

    漲跌欄已是含號字串 '+0.02' / '-0.04' / '0.00'。
    """
    out = ParsedSource(
        db_table=DB_TABLE,
        timeseries_key=TIMESERIES_KEY,
        timeseries_categories=CATEGORIES,
        trade_date=trade_date,
    )
    reader = csv.reader(io.StringIO(text))
    found_header = False
    for row in reader:
        if not found_header:
            if (len(row) >= 3
                and "代號" in row[0]
                and "名稱" in row[1]
                and "收盤" in row[2]):
                found_header = True
            continue
        if not row or len(row) < 10:
            continue
        code = clean_code(row[0])
        if not code or not code[0].isalnum():
            continue
        name = clean_name(row[1])
        if not name:
            continue
        close_p = parse_float(row[2])
        change_amt = parse_float(row[3])
        open_p = parse_float(row[4])
        high_p = parse_float(row[5])
        low_p = parse_float(row[6])
        volume_shares = parse_int(row[7])
        turnover = parse_int(row[8])
        transactions = parse_int(row[9])
        _emit(out, code, name, "TPEX", trade_date,
              open_p, high_p, low_p, close_p, change_amt,
              volume_shares, turnover, transactions)
    return out


def _apply_sign(sign_raw: str, change_abs: Optional[float]) -> Optional[float]:
    """TWSE 把漲跌符號與絕對值分兩欄,這裡組起來。

      '+' / 'X' (停牌) / '' → 直接用絕對值
      '-'                    → 取負
    """
    if change_abs is None:
        return None
    s = (sign_raw or "").strip().strip('"').strip()
    if s == "-":
        return -change_abs
    return change_abs


def _emit(out: ParsedSource, code: str, name: str, market: str, trade_date: str,
          open_p, high_p, low_p, close_p, change_amt,
          volume_shares, turnover, transactions) -> None:
    volume_lots = (volume_shares // 1000) if volume_shares is not None else None
    out.db_rows.append({
        "trade_date": to_iso_date(trade_date),
        "market": market,
        "stock_id": code,
        "stock_name": name,
        "open_price": open_p,
        "high_price": high_p,
        "low_price": low_p,
        "close_price": close_p,
        "change_amt": change_amt,
        "volume_shares": volume_shares,
        "volume_lots": volume_lots,
        "turnover": turnover,
        "transactions": transactions,
    })
    out.daily_values[code] = {
        "成交股數": volume_shares if volume_shares is not None else 0,
        "開盤價": open_p if open_p is not None else 0,
        "最高價": high_p if high_p is not None else 0,
        "最低價": low_p if low_p is not None else 0,
        "收盤價": close_p if close_p is not None else 0,
    }
    out.stock_names[code] = name
