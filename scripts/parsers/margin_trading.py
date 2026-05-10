"""融資融券:TWSE MI_MARGN + TPEx RSTA3106 → marginTrading + stock_margin rows。

DB 單位: 張 (兩邊原始 CSV 都已是「張」單位,不用換算)
時間序列類別 (與 buildOHLCV 等其他 timeseries 同一風格,4 個維度):
  ['融資餘額', '融資增減', '融券餘額', '融券增減']

TWSE / TPEX 融券語意對齊:
  TWSE 融券 [買進=回補, 賣出=建立]
  TPEX 融券 [券賣=建立, 券買=回補]   ← 順序相反
  → 統一存:
       short_sell_open  = 建立空頭 (TWSE 融券賣出 / TPEX 券賣)
       short_buy_close  = 回補空頭 (TWSE 融券買進 / TPEX 券買)
"""

from __future__ import annotations

import csv
import io
import re

from .common import (
    ParsedSource,
    clean_code,
    clean_name,
    parse_int,
    to_iso_date,
)

CATEGORIES = ["融資餘額", "融資增減", "融券餘額", "融券增減"]
TIMESERIES_KEY = "marginTrading"
DB_TABLE = "stock_margin"

# 從 header 抽 "115年05月08日" / "115/05/08" → YYYYMMDD
_ROC_RE = re.compile(r"(\d{2,3})\s*[年/]\s*(\d{1,2})\s*[月/]\s*(\d{1,2})")


def _check_header_date(text: str, expected: str, market: str) -> None:
    """從 CSV 前幾行抽出 ROC 日期,跟期望 trade_date 比對。
    不一致 raise — 防止 TWSE/TPEX 服務 hiccup 回舊日期 demo 資料,
    污染 Drive 跟 DB (踩過真實案例:5/8 query 收到 2017/12/18 資料)。
    """
    head = "\n".join(text.splitlines()[:5])
    m = _ROC_RE.search(head)
    if not m:
        raise ValueError(f"{market}: 找不到 header 日期 (前 5 行: {head!r})")
    roc_y, mm, dd = int(m.group(1)), int(m.group(2)), int(m.group(3))
    actual = f"{roc_y + 1911:04d}{mm:02d}{dd:02d}"
    if actual != expected:
        raise ValueError(
            f"{market}: header 日期 {actual} 不等於期望 {expected} "
            f"(可能 TWSE/TPEX 服務異常,回了舊資料)"
        )


def parse(csv_bytes: bytes, *, market: str, trade_date: str) -> ParsedSource:
    """market 必須是 'TWSE' 或 'TPEX',trade_date 為 YYYYMMDD。

    fetch_stocks.py 對這兩個 source 都用 save_mode='textBlob' (MS950 → UTF-8 寫進 Drive),
    所以這裡先試 UTF-8,失敗再 fallback 到 MS950 (兼容直接讀原始 MS950 bytes 的測試)。
    """
    try:
        text = csv_bytes.decode("utf-8")
    except UnicodeDecodeError:
        text = csv_bytes.decode("ms950", errors="replace")

    _check_header_date(text, trade_date, market)

    if market == "TWSE":
        return _parse_twse(text, trade_date)
    if market == "TPEX":
        return _parse_tpex(text, trade_date)
    raise ValueError(f"unknown market: {market!r}")


def _parse_twse(text: str, trade_date: str) -> ParsedSource:
    """TWSE MI_MARGN 格式 (16 欄):
      Line 0: 空白
      Line 1: '查無資料' (網頁 widget label,不是真的無資料)
      Line 2: 標題 '"115年05月08日 融資融券彙總 (股票)"'
      Line 3: 區段 header '"股票",,"融資",,,,,,"融券",,...'
      Line 4: 欄位 header
      Line 5: 合計列 (代號 = '　',跳過)
      Line 6+: 個股資料

    欄位 (0-indexed):
      0  代號
      1  名稱
      [融資] 2 買進  3 賣出  4 現金償還  5 前日餘額  6 今日餘額  7 次一營業日限額
      [融券] 8 買進  9 賣出  10 現券償還  11 前日餘額  12 今日餘額  13 次一營業日限額
      14 資券互抵
      15 註記
    """
    out = ParsedSource(
        db_table=DB_TABLE,
        timeseries_key=TIMESERIES_KEY,
        timeseries_categories=CATEGORIES,
        trade_date=trade_date,
    )
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        if not row or len(row) < 15:
            continue
        code = clean_code(row[0])
        if not code or not code[0].isalnum():
            continue  # 標題列 / 合計列 (代號 = '　' 全形空白)
        name = clean_name(row[1])
        if not name or name == "合計":
            continue

        m_buy   = parse_int(row[2])
        m_sell  = parse_int(row[3])
        m_repay = parse_int(row[4])
        m_prev  = parse_int(row[5])
        m_now   = parse_int(row[6])
        # TWSE 融券:8=買進(回補), 9=賣出(建立)
        s_close = parse_int(row[8])
        s_open  = parse_int(row[9])
        s_repay = parse_int(row[10])
        s_prev  = parse_int(row[11])
        s_now   = parse_int(row[12])
        offset  = parse_int(row[14])

        _emit(out, code, name, "TWSE", trade_date,
              margin_buy=m_buy, margin_sell=m_sell,
              margin_cash_repay=m_repay,
              margin_balance_prev=m_prev, margin_balance=m_now,
              short_sell_open=s_open, short_buy_close=s_close,
              short_share_repay=s_repay,
              short_balance_prev=s_prev, short_balance=s_now,
              net_offset=offset)
    return out


def _parse_tpex(text: str, trade_date: str) -> ParsedSource:
    """TPEx RSTA3106 格式 (20 欄):
      Line 0: 標題 '上櫃股票融資融券餘額'
      Line 1: '資料日期:115/05/08'
      Line 2: 欄位 header
      Line 3+: 個股資料

    欄位 (0-indexed):
      0 代號
      1 名稱
      [融資] 2 前資餘額  3 資買  4 資賣  5 現償  6 資餘額
              7 資屬證金  8 資使用率(%)  9 資限額
      [融券] 10 前券餘額  11 券賣  12 券買  13 券償  14 券餘額
              15 券屬證金  16 券使用率(%)  17 券限額
      18 資券相抵
      19 備註
    """
    out = ParsedSource(
        db_table=DB_TABLE,
        timeseries_key=TIMESERIES_KEY,
        timeseries_categories=CATEGORIES,
        trade_date=trade_date,
    )
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        if not row or len(row) < 19:
            continue
        code = clean_code(row[0])
        if not code or not code[0].isalnum():
            continue
        name = clean_name(row[1])
        if not name or name == "合計":
            continue

        m_prev  = parse_int(row[2])
        m_buy   = parse_int(row[3])
        m_sell  = parse_int(row[4])
        m_repay = parse_int(row[5])
        m_now   = parse_int(row[6])
        # TPEX 融券: 11=券賣(建立), 12=券買(回補)
        s_open  = parse_int(row[11])
        s_close = parse_int(row[12])
        s_repay = parse_int(row[13])
        s_now   = parse_int(row[14])
        s_prev  = parse_int(row[10])
        offset  = parse_int(row[18])

        _emit(out, code, name, "TPEX", trade_date,
              margin_buy=m_buy, margin_sell=m_sell,
              margin_cash_repay=m_repay,
              margin_balance_prev=m_prev, margin_balance=m_now,
              short_sell_open=s_open, short_buy_close=s_close,
              short_share_repay=s_repay,
              short_balance_prev=s_prev, short_balance=s_now,
              net_offset=offset)
    return out


def _emit(out: ParsedSource, code: str, name: str, market: str, trade_date: str,
          *, margin_buy, margin_sell, margin_cash_repay,
          margin_balance_prev, margin_balance,
          short_sell_open, short_buy_close, short_share_repay,
          short_balance_prev, short_balance, net_offset) -> None:
    out.db_rows.append({
        "trade_date": to_iso_date(trade_date),
        "market": market,
        "stock_id": code,
        "stock_name": name,
        "margin_buy":          margin_buy,
        "margin_sell":         margin_sell,
        "margin_cash_repay":   margin_cash_repay,
        "margin_balance_prev": margin_balance_prev,
        "margin_balance":      margin_balance,
        "short_sell_open":     short_sell_open,
        "short_buy_close":     short_buy_close,
        "short_share_repay":   short_share_repay,
        "short_balance_prev":  short_balance_prev,
        "short_balance":       short_balance,
        "net_offset":          net_offset,
    })

    # 增減 = 今日 - 前日 (None 視為 0,確保 timeseries 有值)
    m_now  = margin_balance if margin_balance is not None else 0
    m_prev = margin_balance_prev if margin_balance_prev is not None else 0
    s_now  = short_balance if short_balance is not None else 0
    s_prev = short_balance_prev if short_balance_prev is not None else 0
    out.daily_values[code] = {
        "融資餘額": m_now,
        "融資增減": m_now - m_prev,
        "融券餘額": s_now,
        "融券增減": s_now - s_prev,
    }
    out.stock_names[code] = name
