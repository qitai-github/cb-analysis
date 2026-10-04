# -*- coding: utf-8 -*-
"""CB「盤下鎖碼」偵測 — 盤面成交量很小,但三大法人(多為自營商 = 券商做 CBAS 拆解)淨買超很大

來源:網路上的觀察技巧(鄭大 CB 社團舉例晟田五 45415,2026-09-30:盤面成交量 309 張,
收盤後自營商淨買 1,375 張,約佔總發行 3,000 張的 46%)。
邏輯:特定人不會在盤面大張旗鼓對敲,而是盤下直接跟券商做 CBAS 拆解,所以
「盤面看起來冷門」+「法人籌碼卻大量吃進」= 值得追蹤的鎖碼訊號。

資料:
  - cbBondInstitutional: CB 本身的外資/投信/自營商買賣超(張,合併儲存格,代號欄會留空)
  - cbDailyTrading 成交量(張): 盤面成交量
  - cbasCalendar.issuedInfo[cb].balThisWeek: 目前發行餘額(張)

⚠️ 這只是「資料整理出的現象」:法人淨買 > 盤面量,不等於一定是特定人鎖碼
(也可能是券商避險部位調整、做市、被動配合);僅供研究,非投資建議。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from holdings_review import load, index_table, trim_zero_tail  # noqa: E402

# 門檻(2026-10-04 依 9/30~10/02 全市場分布訂定,見 scan() 註解)
MIN_NET = 100            # 單日法人淨買至少 100 張才算(避免小數字放大)
VOL_MULT = 1.5           # 法人淨買 ≥ 盤面成交量 × 1.5
BAL_PCT_1D = 3.0         # 或單日淨買 ≥ 發行餘額 3%
MIN_NET5 = 200           # 5 日累計版
BAL_PCT_5D = 8.0         # 5 日淨買 ≥ 發行餘額 8%


_SPLIT_CACHE = {}


def _split(ad):
    # index_table 要掃整張表,回測會對每個交易日各呼叫一次 → 以 ad 物件快取
    k = id(ad)
    if k not in _SPLIT_CACHE:
        dates_i, INS, names_i = index_table(ad['cbBondInstitutional'])
        dates_t, TR, names_t = index_table(ad['cbDailyTrading'])
        _SPLIT_CACHE.clear()
        _SPLIT_CACHE[k] = (dates_i, INS, dates_t, TR, {**names_t, **names_i})
    return _SPLIT_CACHE[k]


def scan(ad=None, asof=None):
    """回傳 (date, rows):rows 為所有「近 5 日有任何法人買賣」的 CB 指標,依單日淨買排序。

    每筆:cbCode cbName stock vol bal dealer1 foreign1 trust1 net1 net1PctBal volRatio1(net1/vol)
          net5 dealer5 vol5 net5PctBal net20 lock(bool) why(list)
    asof: 指定資料日(YYYYMMDD),預設用法人資料最後一個非全 0 的日期。
    """
    ad = ad or load('all-data.json')
    dates_i, INS, dates_t, TR, names = _split(ad)
    issued = (ad.get('cbasCalendar') or {}).get('issuedInfo') or {}

    codes = sorted({c for (c, cat) in INS if cat == '自營商買賣超'})
    if asof is None:
        series = [INS[(c, k)] for c in codes for k in ('外資買賣超', '投信買賣超', '自營商買賣超') if (c, k) in INS]
        n = trim_zero_tail(series, len(dates_i))
        asof = dates_i[n - 1]
    ii = dates_i.index(asof)
    # 盤面成交量要對到同一個日期
    tmap = {d: i for i, d in enumerate(dates_t)}
    if asof not in tmap:
        return asof, []
    ti = tmap[asof]

    rows = []
    for c in codes:
        d_ = INS.get((c, '自營商買賣超')) or [0] * len(dates_i)
        f_ = INS.get((c, '外資買賣超')) or [0] * len(dates_i)
        t_ = INS.get((c, '投信買賣超')) or [0] * len(dates_i)
        v_ = TR.get((c, '成交量(張)'))
        if v_ is None:
            continue
        lo5, lo20 = max(ii - 4, 0), max(ii - 19, 0)
        net = [d_[k] + f_[k] + t_[k] for k in range(len(dates_i))]
        net1, net5, net20 = net[ii], sum(net[lo5:ii + 1]), sum(net[lo20:ii + 1])
        if net5 == 0 and net20 == 0:
            continue
        # 盤面量:把法人日期位移到 CB 成交日期(兩表日期軸可能不同長度)
        vol1 = v_[ti]
        vol5 = sum(v_[tmap[d]] for d in dates_i[lo5:ii + 1] if d in tmap)
        info = issued.get(c) or {}
        bal = info.get('balThisWeek') or 0
        pct = lambda x: round(x / bal * 100, 1) if bal else None

        why = []
        lock = False
        if net1 >= MIN_NET and (net1 >= vol1 * VOL_MULT or (bal and net1 / bal * 100 >= BAL_PCT_1D)):
            if net1 >= vol1 * VOL_MULT:
                why.append('單日法人淨買 %d 張 ≥ 盤面量 %d 張的 %.1f 倍' % (net1, vol1, VOL_MULT))
            if bal and net1 / bal * 100 >= BAL_PCT_1D:
                why.append('單日淨買佔發行餘額 %.1f%%' % (net1 / bal * 100))
            lock = True
        if net5 >= MIN_NET5 and (net5 >= vol5 * VOL_MULT) and bal and net5 / bal * 100 >= BAL_PCT_5D:
            why.append('5 日累計淨買 %d 張(盤面 5 日量 %d 張),佔發行餘額 %.1f%%' % (net5, vol5, net5 / bal * 100))
            lock = True
        rows.append({
            'cbCode': c, 'cbName': names.get(c, ''), 'stock': c[:4],
            'date': asof, 'vol': round(vol1), 'bal': bal,
            'dealer1': round(d_[ii]), 'foreign1': round(f_[ii]), 'trust1': round(t_[ii]),
            'net1': round(net1), 'net1PctBal': pct(net1),
            'volRatio1': round(net1 / vol1, 1) if vol1 > 0 else None,
            'net5': round(net5), 'dealer5': round(sum(d_[lo5:ii + 1])), 'vol5': round(vol5),
            'net5PctBal': pct(net5), 'net20': round(net20), 'net20PctBal': pct(net20),
            'lock': lock, 'why': why,
        })
    rows.sort(key=lambda r: -r['net1'])
    return asof, rows


def flagged(rows, limit=30):
    """只取符合鎖碼條件者,依「單日淨買佔發行餘額」(無餘額者排後)排序。"""
    f = [r for r in rows if r['lock']]
    f.sort(key=lambda r: -(r['net1PctBal'] if r['net1PctBal'] is not None else -1))
    return f[:limit]


if __name__ == '__main__':
    asof = sys.argv[1] if len(sys.argv) > 1 else None
    d, rows = scan(asof=asof)
    fl = flagged(rows, 50)
    print('資料日 %s,法人有動作 CB %d 檔,符合盤下鎖碼 %d 檔' % (d, len(rows), sum(1 for r in rows if r['lock'])))
    for r in fl:
        print('%s %-8s 盤面%5d 自營%5d 淨買%5d (%s%% 餘額%s) 5日%5d | %s'
              % (r['cbCode'], r['cbName'], r['vol'], r['dealer1'], r['net1'],
                 r['net1PctBal'], r['bal'], r['net5'], '; '.join(r['why'])))
