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
from lib import cb_offmarket, sector_resonance, pick_followup  # noqa: E402


def distortion_flags(cb, s):
    """掃描階段就把「數字會失真/需要小心」的情況打旗標,不留給評論文字去記得提醒。"""
    f = []
    if cb.get('cbVolMA60') is not None and cb['cbVolMA60'] < 5 and cb['cbVol'] > 0:
        f.append('CB基期過小(60日均量<5張,量比無意義)')
    if cb.get('cbVolRatio') and cb['cbVolRatio'] >= 3 and cb['cbVolMA60'] >= 5 and cb['cbChg'] <= 0:
        f.append('CB爆量不漲')
    if s.get('ok'):
        if s['volRatio'] < 0.5 and s['chg1'] > 0:
            f.append('個股量縮上漲(量比%.2f,可信度低)' % s['volRatio'])
        if s['volRatio'] >= 2 and s['chg1'] < 0:
            f.append('個股爆量收黑(量比%.1f)' % s['volRatio'])
        m = s.get('margin') or {}
        if m and m.get('bal', 0) < 300:
            f.append('融資餘額<300張(百分比失真)')
        if m and m.get('short', 0) < 50 and abs(m.get('shortChg1', 0)) >= 50:
            f.append('融券基期小(單日增減放大)')
        if not s.get('score'):
            f.append('日均量<50張或資料不足(無週報分)')
    return f


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


def extras(ad, today, prev, stocks, res):
    """盤下鎖碼 / 族群共振 / 昨日點名追蹤 — 每項各自包 try,失敗不擋主流程"""
    out = {}
    try:
        d, rows = cb_offmarket.scan(ad, today)
        out['offmarket'] = {'date': d, 'scanned': len(rows), 'flagged': cb_offmarket.flagged(rows, 30),
                            # 5 日累計淨買最大者(不一定單日觸發),供「持續吃貨」觀察
                            'accum5': sorted((r for r in rows if r['net5'] > 0 and r['net5PctBal']),
                                             key=lambda r: -r['net5PctBal'])[:10]}
        print('盤下鎖碼:法人有動作 CB %d 檔,觸發 %d 檔' % (len(rows), len(out['offmarket']['flagged'])))
    except Exception as e:
        print('警告:盤下鎖碼偵測失敗(%s)' % e)
    try:
        names = {c: (res.get(c) or {}).get('name', '') for c in stocks}
        out['resonance'] = sector_resonance.resonance(stocks, min_hits=2, top=10, names=names)
    except Exception as e:
        print('警告:族群共振失敗(%s)' % e)
    try:
        hp = os.path.join(BASE, 'data', 'daily_cb_rank_history', '%s.json' % prev)
        if os.path.exists(hp):
            hl = (json.load(open(hp, encoding='utf-8')).get('report') or {}).get('highlights') or []
            codes = [h['code'] for h in hl]
            if codes:
                fu = pick_followup.followup(codes, prev, today, ad)
                fu['source'] = '前一交易日日報 highlights'
                out['followup'] = fu
                print('昨日點名 %d 檔今日:上漲 %d、勝全市場中位數 %d(中位數 %s%% vs 市場 %s%%)'
                      % (fu['n'], fu['up'], fu['beat'], fu['median'], fu['market']))
    except Exception as e:
        print('警告:昨日點名追蹤失敗(%s)' % e)
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
            out.append(dict(cb, rank=i, s=s, flags=distortion_flags(cb, s)))
        return out

    out = {'date': today, 'prev': prev, 'top': top, 'brokerDate': today if brk else None,
           'A': attach(rankA), 'B': attach(rankB)}
    out.update(extras(ad, today, prev, stocks, res))
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
