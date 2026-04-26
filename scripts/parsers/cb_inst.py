"""CB 每日法人:ThreePrimaryCB_YYYYMMDD.csv (UTF-8) → cbBondInstitutional + cb_inst rows。

CSV 結構 (UTF-8):
  Line 0: 標題 "115年04月24日 三大法人日交易資訊..."
  Line 1: header "代號,名稱,外資及陸資買張數,...,三大法人買賣超張數" (12 欄)
  Line 2+: data

注意:
  - 數值單位是 "張",不是 "股"
  - header 有 typo:第 6 欄 "投信張數" 應為 "投信賣張數" (我們直接靠位置取值,無視 typo)

時間序列類別 (與 cbInstitutional 一致):
  ['外資買賣超', '投信買賣超', '自營商買賣超']
"""

from __future__ import annotations

import csv
import io

from .common import (
    ParsedSource,
    clean_code,
    clean_name,
    parse_int,
    to_iso_date,
)

CATEGORIES = ["外資買賣超", "投信買賣超", "自營商買賣超"]
TIMESERIES_KEY = "cbBondInstitutional"
DB_TABLE = "cb_inst"


def parse(csv_bytes: bytes, *, trade_date: str) -> ParsedSource:
    try:
        text = csv_bytes.decode("utf-8")
    except UnicodeDecodeError:
        text = csv_bytes.decode("big5", errors="replace")
    out = ParsedSource(
        db_table=DB_TABLE,
        timeseries_key=TIMESERIES_KEY,
        timeseries_categories=CATEGORIES,
        trade_date=trade_date,
    )
    reader = csv.reader(io.StringIO(text))
    for i, row in enumerate(reader):
        if i < 2:
            continue
        if not row or len(row) < 12:
            continue
        # cols: 0=代號 1=名稱
        # 2=外資及陸資買張 3=外資及陸資賣張 4=外資及陸資淨買張 ← foreign_net
        # 5=投信買張 6=投信賣張 7=投信淨買張 ← investment_net
        # 8=自營商買張 9=自營商賣張 10=自營淨買張 ← dealer_net
        # 11=三大法人買賣超張數 ← total
        code = clean_code(row[0])
        if not code or not code[0].isalnum():
            continue
        name = clean_name(row[1])
        if not name:
            continue
        foreign_net = parse_int(row[4])
        investment_net = parse_int(row[7])
        dealer_net = parse_int(row[10])
        total = parse_int(row[11])
        out.db_rows.append({
            "trade_date": to_iso_date(trade_date),
            "cb_id": code,
            "cb_name": name,
            "foreign_net": foreign_net,
            "investment_net": investment_net,
            "dealer_net": dealer_net,
            "total_inst_net": total,
        })
        out.daily_values[code] = {
            "外資買賣超": foreign_net if foreign_net is not None else 0,
            "投信買賣超": investment_net if investment_net is not None else 0,
            "自營商買賣超": dealer_net if dealer_net is not None else 0,
        }
        out.stock_names[code] = name
    return out
