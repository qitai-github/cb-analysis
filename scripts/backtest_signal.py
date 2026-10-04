# -*- coding: utf-8 -*-
"""訊號回測 — 檢驗報告用的條件到底有沒有預測力(只陳述事實 + 樣本數,不下過度結論)

三組檢驗:
  1. 盤下鎖碼:2026 全年每個資料日觸發的 CB(事件去重:5 日內同一檔只算第一次),
     之後 5/10/20 個交易日的 CB 與對應個股報酬,對照同期全部 CB 中位數(超額)。
  2. 週報分級:每份正式週報快照(positive_scan_*.json)A/B/C 級,之後 5 日與至最新資料日的個股報酬,
     對照同期網站內 CB 個股中位數。
  3. 日報分數:daily_cb_scan_*.json 榜單內個股的週報分(≥70/60-69/<60或無),之後 1/3/5 日報酬。

限制(輸出會一併寫出):週報/日報分數無法用歷史資料重算(只存了每次當下的快照),所以樣本是
「快照累積多久就有多少」;盤下鎖碼可用 2026 全年資料重建,樣本相對大。進場假設=訊號日收盤價,
未計手續費/滑價/流動性(CB 盤面量小,實際成交困難是重點風險)。

用法: PYTHONUTF8=1 python scripts/backtest_signal.py   → scripts/output/backtest_signal.json
"""
import glob
import json
import os
import statistics
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, 'scripts', 'output')
sys.path.insert(0, os.path.join(BASE, 'scripts'))
from holdings_review import load, index_table, trim_zero_tail  # noqa: E402
from lib import cb_offmarket  # noqa: E402


def agg(vals):
    v = [x for x in vals if x is not None]
    if not v:
        return {'n': 0}
    return {'n': len(v), 'mean': round(sum(v) / len(v), 2), 'median': round(statistics.median(v), 2),
            'win': round(sum(1 for x in v if x > 0) / len(v) * 100)}


def fwd(series, i, h):
    """第 i 日收盤 → 第 i+h 日收盤的報酬%,資料不足或價為 0 回 None"""
    if series is None or i + h >= len(series) or not series[i] or not series[i + h]:
        return None
    return (series[i + h] / series[i] - 1) * 100


def median_of(vals):
    v = [x for x in vals if x is not None]
    return round(statistics.median(v), 2) if v else None


def main():
    ad = load('all-data.json')
    sd, ST, _ = index_table(ad['stockTrading'])
    cd, CB, _ = index_table(ad['cbDailyTrading'])
    st_close = {c: v for (c, k), v in ST.items() if k == '收盤價'}
    cb_close = {c: v for (c, k), v in CB.items() if k == '收盤價'}
    sn = trim_zero_tail(list(st_close.values()), len(sd))
    cnn = trim_zero_tail(list(cb_close.values()), len(cd))
    sdates, cdates = sd[:sn], cd[:cnn]
    sidx = {d: i for i, d in enumerate(sdates)}
    cidx = {d: i for i, d in enumerate(cdates)}
    res = {'limits': '進場=訊號日收盤;未計成本/滑價/流動性;樣本小者僅供參考;不構成投資建議'}

    # ── 1. 盤下鎖碼 ──────────────────────────────────────────
    ins_dates = cb_offmarket._split(ad)[0]
    base_cache = {}

    def cb_base(d, h):
        k = (d, h)
        if k not in base_cache:
            i = cidx[d]
            base_cache[k] = median_of([fwd(s, i, h) for s in cb_close.values()]) or 0.0
        return base_cache[k]

    events, last_flag = [], {}
    for d in ins_dates:
        if d not in cidx:
            continue
        _, rows = cb_offmarket.scan(ad, d)
        for r in rows:
            if not r['lock']:
                continue
            code = r['cbCode']
            li = last_flag.get(code)
            last_flag[code] = cidx[d]
            if li is not None and cidx[d] - li <= 5:
                continue                       # 5 日內重複觸發 → 同一事件,不重算
            ev = {'cb': code, 'name': r['cbName'], 'date': d, 'net1': r['net1'], 'vol': r['vol'],
                  'pctBal': r['net1PctBal']}
            for h in (5, 10, 20):
                a = fwd(cb_close.get(code), cidx[d], h)
                ev['cb%d' % h] = None if a is None else round(a, 2)
                ev['cbX%d' % h] = None if a is None else round(a - cb_base(d, h), 2)
                b = fwd(st_close.get(r['stock']), sidx[d], h) if d in sidx else None
                ev['stk%d' % h] = None if b is None else round(b, 2)
            events.append(ev)
    res['offmarket'] = {
        'events': len(events),
        'dates': [ins_dates[0], ins_dates[-1]],
        'forward': {str(h): {'cb': agg([e['cb%d' % h] for e in events]),
                             'cbExcessVsAllCB': agg([e['cbX%d' % h] for e in events]),
                             'stock': agg([e['stk%d' % h] for e in events])} for h in (5, 10, 20)},
        'strong(淨買>=1.5倍盤面量)': {str(h): agg([e['cbX%d' % h] for e in events
                                              if e['vol'] and e['net1'] >= 1.5 * e['vol']]) for h in (5, 10, 20)},
        'detail': events,
    }

    # ── 2. 週報分級(快照) ──────────────────────────────────
    weekly = []
    for f in sorted(glob.glob(os.path.join(OUT, 'positive_scan_2026*.json'))):
        snap = json.load(open(f, encoding='utf-8'))
        if not snap or snap[0]['asOf'] not in sidx:
            continue
        d0 = snap[0]['asOf']
        i0 = sidx[d0]
        left = len(sdates) - 1 - i0
        universe = [s for c, s in st_close.items() if len(c) == 4]
        row = {'file': os.path.basename(f), 'asOf': d0,
               'market5': median_of([fwd(s, i0, 5) for s in universe]),
               'marketToLatest': median_of([fwd(s, i0, left) for s in universe]) if left > 0 else None,
               'tiers': {}}
        for name, lo, hi in (('A', 80, 999), ('B', 70, 80), ('C', 60, 70)):
            codes = [r['code'] for r in snap if lo <= r['score'] < hi]
            row['tiers'][name] = {
                'n': len(codes),
                'fwd5': agg([fwd(st_close.get(c), i0, 5) for c in codes]),
                'toLatest': agg([fwd(st_close.get(c), i0, left) for c in codes]) if left > 0 else {'n': 0}}
        weekly.append(row)
    res['weekly'] = weekly

    # ── 3. 日報榜單個股分數 ──────────────────────────────────
    buckets = ('≥70', '60-69', '<60或無分')
    daily = {b: {1: [], 3: [], 5: []} for b in buckets}
    mk_d = {1: [], 3: [], 5: []}
    for f in sorted(glob.glob(os.path.join(OUT, 'daily_cb_scan_2026*.json'))):
        d = json.load(open(f, encoding='utf-8'))
        if d['date'] not in sidx:
            continue
        i0 = sidx[d['date']]
        seen = set()
        for x in d['A'] + d['B']:
            c = x['stock']
            if c in seen or c not in st_close:
                continue
            seen.add(c)
            sc = (x['s'] or {}).get('score')
            b = buckets[0] if sc and sc >= 70 else buckets[1] if sc and sc >= 60 else buckets[2]
            for h in (1, 3, 5):
                daily[b][h].append(fwd(st_close[c], i0, h))
        for h in (1, 3, 5):
            mk_d[h] += [fwd(s, i0, h) for c, s in st_close.items() if len(c) == 4]
    res['daily'] = {'market': {str(h): agg(mk_d[h]) for h in (1, 3, 5)},
                    'byScore': {b: {str(h): agg(v) for h, v in hs.items()} for b, hs in daily.items()},
                    'note': '同一檔跨日重複上榜會重複計入(日報樣本非獨立);僅少數資料日'}

    with open(os.path.join(OUT, 'backtest_signal.json'), 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, indent=1)

    o = res['offmarket']
    print('== 盤下鎖碼 %s~%s:事件 %d 件(去重)' % (o['dates'][0], o['dates'][1], o['events']))
    for h in ('5', '10', '20'):
        fw = o['forward'][h]
        print('  +%2s日  CB %s | CB超額 %s | 個股 %s' % (h, fw['cb'], fw['cbExcessVsAllCB'], fw['stock']))
    print('== 週報分級(快照)')
    for w in weekly:
        print('  %s 市場5日 %s 至今 %s' % (w['asOf'], w['market5'], w['marketToLatest']),
              {k: (v['n'], v['fwd5'].get('mean'), v['toLatest'].get('mean')) for k, v in w['tiers'].items()})
    print('== 日報榜單分數 市場:', res['daily']['market'])
    for b, hs in res['daily']['byScore'].items():
        print('  ', b, {h: (v.get('n'), v.get('mean')) for h, v in hs.items()})


if __name__ == '__main__':
    main()
