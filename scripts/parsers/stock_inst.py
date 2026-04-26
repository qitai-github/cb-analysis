"""個股法人:TWSE_T86 (Big5) + TPEx_T86 (Big5) → cbInstitutional + stock_inst rows。

DB 單位: 股 (shares)
時間序列類別 (對齊 js/config.js cbInstitutional.categories):
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
TIMESERIES_KEY = "cbInstitutional"
DB_TABLE = "stock_inst"


def parse(csv_bytes: bytes, *, market: str, trade_date: str) -> ParsedSource:
    """market 必須是 'TWSE' 或 'TPEX',trade_date 為 YYYYMMDD。"""
    text = csv_bytes.decode("big5", errors="replace")
    if market == "TWSE":
        return _parse_twse(text, trade_date)
    if market == "TPEX":
        return _parse_tpex(text, trade_date)
    raise ValueError(f"unknown market: {market!r}")


def _parse_twse(text: str, trade_date: str) -> ParsedSource:
    """TWSE T86 格式:
      Line 0: 標題 "115年04月24日 三大法人買賣超日報"
      Line 1: 欄位 header
      Line 2+: 個股資料 (證券代號 ="0050" 形式)

    欄位 (0-indexed):
      0  證券代號                                              (="0050")
      1  證券名稱
      2  外陸資買進股數(不含外資自營商)
      3  外陸資賣出股數(不含外資自營商)
      4  外陸資買賣超股數(不含外資自營商)
      5  外資自營商買進股數
      6  外資自營商賣出股數
      7  外資自營商買賣超股數
      8  投信買進股數
      9  投信賣出股數
      10 投信買賣超股數
      11 自營商買賣超股數 (合計)
      12-14 自營商(自行買賣) 買/賣/買賣超
      15-17 自營商(避險) 買/賣/買賣超
      18 三大法人買賣超股數
    """
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
        if not row or len(row) < 19:
            continue
        code = clean_code(row[0])
        if not code or not code[0].isalnum():
            continue
        name = clean_name(row[1])
        if not name:
            continue
        f1 = parse_int(row[4]) or 0  # 外陸資 (不含外資自營)
        f2 = parse_int(row[7]) or 0  # 外資自營商
        foreign_net = f1 + f2
        investment_net = parse_int(row[10])
        dealer_net = parse_int(row[11])
        total = parse_int(row[18])
        _emit(out, code, name, "TWSE", trade_date,
              foreign_net, investment_net, dealer_net, total)
    return out


def _parse_tpex(text: str, trade_date: str) -> ParsedSource:
    """TPEx T86 格式 (24 欄):
      Line 0: 標題
      Line 1: header
      Line 2+: data

    欄位 (0-indexed):
      0  代號
      1  名稱
      2-4   外資及陸資(不含外資自營商) 買/賣/買賣超
      5-7   外資自營商 買/賣/買賣超
      8-10  外資及陸資 買/賣/買賣超 (合計) ← 直接用 col 10
      11-13 投信 買/賣/買賣超          ← col 13
      14-16 自營商(自行買賣) 買/賣/買賣超
      17-19 自營商(避險) 買/賣/買賣超
      20-22 自營商 買/賣/買賣超 (合計)  ← col 22
      23    三大法人買賣超合計          ← col 23
    """
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
        if not row or len(row) < 24:
            continue
        code = clean_code(row[0])
        if not code or not code[0].isalnum():
            continue
        name = clean_name(row[1])
        if not name:
            continue
        foreign_net = parse_int(row[10])
        investment_net = parse_int(row[13])
        dealer_net = parse_int(row[22])
        total = parse_int(row[23])
        _emit(out, code, name, "TPEX", trade_date,
              foreign_net, investment_net, dealer_net, total)
    return out


def _emit(out: ParsedSource, code: str, name: str, market: str, trade_date: str,
          foreign_net, investment_net, dealer_net, total) -> None:
    out.db_rows.append({
        "trade_date": to_iso_date(trade_date),
        "market": market,
        "stock_id": code,
        "stock_name": name,
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
