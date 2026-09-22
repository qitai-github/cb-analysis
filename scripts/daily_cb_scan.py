# -*- coding: utf-8 -*-
"""CB 日報掃描 — 用週報規格(holdings_review.analyze + positive_scan 評分)跑當日榜單

榜單 A: CB 當日漲幅前 100 檔
榜單 B: CB 當日成交量前 100 檔
每檔 CB 對應個股做:技術面(均線/位階/量價)+ 籌碼面(法人/融資/大戶/券商分點)

用法: PYTHONUTF8=1 python scripts/daily_cb_scan.py [--top 100]
輸出: scripts/output/daily_cb_scan.json (+ 日期快照 daily_cb_scan_YYYYMMDD.json)
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from holdings_review import analyze, load, index_table, trim_zero_tail, BASE  # noqa: E402
from positive_scan import score_one, CRITERIA  # noqa: E402


def broker_today(date):
    """個股 → 當日券商買超前 5 / 賣超前 3 與買超集中度(前 5 名淨買 / 當日成交量)"""
    p = os.path.join(BASE, 'data', 'broker_daily', '%s.json' % date)
    if not os.path.exists(p):
        return {}
    with open(p, encoding='utf-8') as f:
        d = json.load(f)['stocks']
    out = {}
    for code, s in d.items():
        rows = sorted(([b[0], b[1] - b[2]] for b in s['b']), key=lambda x: -x[1])
        buy = [x for x in rows if x[1] > 0][:5]
        sell = [x for x in rows[::-1] if x[1] < 0][:3]
        vol = s.get('vol') or 0
        out[code] = {
            'buy': [[n, round(v)] for n, v in buy],
            'sell': [[n, round(v)] for n, v in sell],
            'top5NetPct': round(sum(v for _, v in buy) / vol * 100, 1) if vol else 0,
        }
    return out


def main():
    top = 100
    if '--top' in sys.argv:
        top = int(sys.argv[sys.argv.index('--top') + 1])

    ad = load('all-data.json')
    dates, CB, names = index_table(ad['cbDailyTrading'])
    codes = sorted({c for (c, cat) in CB if cat == '收盤價'})
    n = trim_zero_tail([CB[(c, '成交量(張)')] for c in codes if (c, '成交量(張)') in CB], len(dates))
    today, prev = dates[n - 1], dates[n - 2]

    cbrows = []
    for c in codes:
        cl, vl = CB.get((c, '收盤價')), CB.get((c, '成交量(張)'))
        if not cl or not vl or not cl[n - 1] or not cl[n - 2] or not vl[n - 1]:
            continue
        base = sum(vl[max(n - 61, 0):n - 1]) / max(min(60, n - 1), 1)
        cbrows.append({
            'cbCode': c, 'cbName': names.get(c, ''), 'stock': c[:4],
            'cbClose': cl[n - 1], 'cbPrev': cl[n - 2],
            'cbChg': round((cl[n - 1] / cl[n - 2] - 1) * 100, 2),
            'cbVol': round(vl[n - 1]), 'cbVolMA60': round(base, 1),
            'cbVolRatio': round(vl[n - 1] / base, 2) if base else None,
            'cbChg5': round((cl[n - 1] / cl[n - 6] - 1) * 100, 2) if cl[n - 6] else 0,
        })
    print('日期 %s (前一日 %s),有成交 CB %d 檔' % (today, prev, len(cbrows)))

    rankA = sorted(cbrows, key=lambda r: -r['cbChg'])[:top]
    rankB = sorted(cbrows, key=lambda r: -r['cbVol'])[:top]
    stocks = sorted({r['stock'] for r in rankA + rankB})
    print('榜單 A/B 合計個股 %d 檔,分析中...' % len(stocks))

    res = {r['code']: r for r in analyze(stocks)}
    brk = broker_today(today)
    for r in res.values():
        if r.get('ok'):
            score_one(r)          # 補 score/hits(資料不足則沒有)
            r['broker'] = brk.get(r['code'])

    def attach(rows):
        out = []
        for i, cb in enumerate(rows, 1):
            s = res.get(cb['stock'], {})
            out.append(dict(cb, rank=i, s=s))
        return out

    out = {'date': today, 'prev': prev, 'top': top, 'brokerDate': today if brk else None,
           'A': attach(rankA), 'B': attach(rankB)}
    o = os.path.join(BASE, 'scripts', 'output')
    with open(os.path.join(o, 'daily_cb_scan.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    with open(os.path.join(o, 'daily_cb_scan_%s.json' % today), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    okA = sum(1 for r in out['A'] if r['s'].get('ok'))
    okB = sum(1 for r in out['B'] if r['s'].get('ok'))
    print('A 榜個股資料完整 %d/%d;B 榜 %d/%d;券商分點 %s' % (okA, top, okB, top, '有' if brk else '無'))


if __name__ == '__main__':
    main()
