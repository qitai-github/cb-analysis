# -*- coding: utf-8 -*-
"""點名後追蹤 — 上一期報告點名的標的,到這一期實際表現如何(個股/對應 CB / 全市場中位數對照)

日報:昨天 highlights 的個股  → 今天
週報:上週 70 分以上的個股   → 這週
目的:驗證「價漲量增又籌碼健康」這類條件有沒有預測力,而不是只講當天現象。
樣本很小時只呈現事實,不下「有效/無效」的結論。
"""
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from holdings_review import load, index_table  # noqa: E402


def _chg(series, dates, d0, d1):
    if d0 not in dates or d1 not in dates:
        return None
    a, b = series[dates.index(d0)], series[dates.index(d1)]
    return round((b / a - 1) * 100, 2) if a and b else None


def followup(codes, from_date, to_date, ad=None):
    """codes: 個股代號。from_date/to_date: YYYYMMDD(以 from_date 收盤為基準)。

    回傳 dict: rows[{code,name,chg,cbChg}], n, up(上漲檔數), median(點名標的中位數%),
    market(全市場個股中位數%,作對照基準), beat(勝過全市場中位數的檔數)
    """
    ad = ad or load('all-data.json')
    dates, ST, names = index_table(ad['stockTrading'])
    cdates, CB, cnames = index_table(ad['cbDailyTrading'])
    cb_by_stock = {}
    for (c, cat) in CB:
        if cat == '收盤價':
            cb_by_stock.setdefault(c[:4], []).append(c)

    market = []
    for (c, cat), s in ST.items():
        if cat == '收盤價' and len(c) == 4:
            v = _chg(s, dates, from_date, to_date)
            if v is not None:
                market.append(v)
    mkt = round(statistics.median(market), 2) if market else None

    rows = []
    for code in codes:
        s = ST.get((code, '收盤價'))
        chg = _chg(s, dates, from_date, to_date) if s else None
        cbs = []
        for cb in sorted(cb_by_stock.get(code, [])):
            v = _chg(CB[(cb, '收盤價')], cdates, from_date, to_date)
            if v is not None:
                cbs.append((cb, v))
        rows.append({'code': code, 'name': names.get(code, ''), 'chg': chg,
                     'cbChg': max((v for _, v in cbs), key=abs) if cbs else None})
    ok = [r['chg'] for r in rows if r['chg'] is not None]
    return {
        'from': from_date, 'to': to_date, 'n': len(ok), 'rows': rows,
        'up': sum(1 for v in ok if v > 0),
        'median': round(statistics.median(ok), 2) if ok else None,
        'market': mkt,
        'beat': sum(1 for v in ok if mkt is not None and v > mkt),
        'marketN': len(market),
    }
