"""CB 每日交易: RSta0113.YYYYMMDD-C.csv (Big5) → cbDailyTrading + cb_quotes。

CSV 結構:
  TITLE,xxx
  DATADATE,xxx
  ALIGN,...
  HEADER,代號,名稱,交易,收市,漲跌,開市,最高,最低,筆數,單位,金額,均價,明日參價,明日漲停,明日跌停
  BODY,"代號","名稱","等價",close,...     ← 解析這列
  BODY,"","","議價",...                    ← 跳過

時間序列類別 (對應 all-data.json cbDailyTrading 既有順序):
  ['收盤價', '開盤價', '最高價', '最低價', '成交量(張)']

成交量單位是「張」,與來源 CSV header 「單位」(row[10]) 一致。
"""

from __future__ import annotations

import csv
import io

from .common import (
    ParsedSource,
    clean_code,
    clean_name,
    parse_float,
    parse_int,
    to_iso_date,
)

CATEGORIES = ["收盤價", "開盤價", "最高價", "最低價", "成交量(張)"]
TIMESERIES_KEY = "cbDailyTrading"
DB_TABLE = "cb_quotes"


def parse(csv_bytes: bytes, *, trade_date: str) -> ParsedSource:
    text = csv_bytes.decode("big5", errors="replace")
    out = ParsedSource(
        db_table=DB_TABLE,
        timeseries_key=TIMESERIES_KEY,
        timeseries_categories=CATEGORIES,
        trade_date=trade_date,
    )
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        # 只看 BODY 列;前綴行 (TITLE / DATADATE / ALIGN / HEADER) 全略過
        if not row or row[0] != "BODY" or len(row) < 16:
            continue
        # row[0]=BODY, [1]=代號, [2]=名稱, [3]=交易, [4]=收市, [5]=漲跌,
        # [6]=開市, [7]=最高, [8]=最低, [9]=筆數, [10]=單位, [11]=金額,
        # [12]=均價, [13]=明日參價, [14]=明日漲停, [15]=明日跌停
        trade_type = clean_name(row[3])
        if trade_type != "等價":
            continue
        code = clean_code(row[1])
        if not code or not code[0].isalnum():
            continue
        name = clean_name(row[2])
        if not name:
            continue
        close_p = parse_float(row[4])
        open_p = parse_float(row[6])
        high_p = parse_float(row[7])
        low_p = parse_float(row[8])
        volume_lots = parse_int(row[10])
        ref_p = parse_float(row[13])
        out.db_rows.append({
            "trade_date": to_iso_date(trade_date),
            "cb_id": code,
            "cb_name": name,
            "open_price": open_p,
            "high_price": high_p,
            "low_price": low_p,
            "close_price": close_p,
            "ref_price": ref_p,
            "volume_lots": volume_lots,
        })
        out.daily_values[code] = {
            "收盤價": close_p if close_p is not None else 0,
            "開盤價": open_p if open_p is not None else 0,
            "最高價": high_p if high_p is not None else 0,
            "最低價": low_p if low_p is not None else 0,
            "成交量(張)": volume_lots if volume_lots is not None else 0,
        }
        out.stock_names[code] = name
    return out
