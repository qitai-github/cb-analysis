# -*- coding: utf-8 -*-
"""週報「與上次比較」預先算好 — 升級/降級/新進/掉榜(含原因)、點名後追蹤、族群共振、盤下鎖碼

為什麼要有這支:claude -p 自己在對話裡比對兩份快照,過去發生過「誤引更早的舊數字/舊分級」。
改成由腳本算出權威的差異表(scripts/output/weekly_diff.json),claude 只負責解讀與寫評論,
數字一律照這份檔案引用,不自己重算。

用法: PYTHONUTF8=1 python scripts/weekly_diff.py [--cur positive_scan.json] [--prev positive_scan_YYYYMMDD.json]
預設 cur = scripts/output/positive_scan.json,prev = universe_prev_snapshot.txt 指的那份快照(空=無前次)。
輸出: scripts/output/weekly_diff.json
"""
import json
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, 'scripts', 'output')
sys.path.insert(0, os.path.join(BASE, 'scripts'))
from positive_scan import CRITERIA  # noqa: E402
from lib import sector_resonance, pick_followup, cb_offmarket  # noqa: E402
from holdings_review import load  # noqa: E402

LABEL = {k: d for k, d, _ in CRITERIA}


def tier(score):
    return 'A' if score >= 80 else 'B' if score >= 70 else 'C' if score >= 60 else 'D'


def _arg(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None


def _load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def main():
    cur_path = _arg('--cur') or os.path.join(OUT, 'positive_scan.json')
    prev_path = _arg('--prev')
    if not prev_path:
        p = os.path.join(OUT, 'universe_prev_snapshot.txt')
        name = open(p, encoding='utf-8').read().strip() if os.path.exists(p) else ''
        prev_path = os.path.join(OUT, name) if name else None

    cur = _load(cur_path)
    cmap = {r['code']: r for r in cur}
    asof = cur[0]['asOf'] if cur else ''
    prev = _load(prev_path) if prev_path and os.path.exists(prev_path) else []
    pmap = {r['code']: r for r in prev}
    prev_asof = prev[0]['asOf'] if prev else ''
    gp = os.path.join(OUT, 'positive_rejected.json')
    gated = {r['code']: r for r in _load(gp)} if os.path.exists(gp) else {}
    # 跟 cur 同一輪產出才可信(asOf 一致),否則可能是舊檔
    gated = {c: r for c, r in gated.items() if r.get('asOf') == asof}

    def slim(r):
        return {'code': r['code'], 'name': r['name'], 'score': r['score'], 'tier': tier(r['score']),
                'chg1': r['chg1'], 'chg5': r['chg5'], 'chg20': r['chg20'], 'volRatio': r['volRatio'],
                'hits': [LABEL[k] for k, _, _ in CRITERIA if r['hits'][k]],
                'miss': [LABEL[k] for k, _, _ in CRITERIA if not r['hits'][k]]}

    def tiers(m):
        return {t: sum(1 for r in m.values() if tier(r['score']) == t) for t in 'ABC'}

    out = {
        'asOf': asof, 'prevAsOf': prev_asof,
        'curFile': os.path.basename(cur_path), 'prevFile': os.path.basename(prev_path) if prev_path else '',
        'tiers': tiers(cmap), 'prevTiers': tiers(pmap) if prev else None,
        'ge70': sum(1 for r in cmap.values() if r['score'] >= 70),
        'prevGe70': sum(1 for r in pmap.values() if r['score'] >= 70) if prev else None,
        'ge80': sum(1 for r in cmap.values() if r['score'] >= 80),
        'prevGe80': sum(1 for r in pmap.values() if r['score'] >= 80) if prev else None,
        'note': '所有數字以本檔為準;prevScore/delta 為「上一份正式週報」對照,不得改用其他快照。',
    }

    new70, promoted, demoted, dropped, steady = [], [], [], [], []
    for c, r in cmap.items():
        if r['score'] < 70:
            continue
        s = slim(r)
        p = pmap.get(c)
        if p is None or p['score'] < 70:
            s['prevScore'] = p['score'] if p else None
            s['prevStatus'] = ('上次 %.1f 分(%s級)' % (p['score'], tier(p['score']))) if p else '上次不在榜(未過多頭門檻或無資料)'
            new70.append(s)
            continue
        s['prevScore'], s['delta'] = p['score'], round(r['score'] - p['score'], 1)
        s['gained'] = [LABEL[k] for k, _, _ in CRITERIA if r['hits'][k] and not p['hits'][k]]
        s['lost'] = [LABEL[k] for k, _, _ in CRITERIA if not r['hits'][k] and p['hits'][k]]
        if tier(r['score']) < tier(p['score']):        # 'A' < 'B':等級往上
            s['prevTier'] = tier(p['score']); promoted.append(s)
        elif tier(r['score']) > tier(p['score']):
            s['prevTier'] = tier(p['score']); demoted.append(s)
        else:
            steady.append(s)

    for c, p in pmap.items():
        if p['score'] < 70:
            continue
        r = cmap.get(c)
        if r is not None and r['score'] >= 70:
            continue
        d = {'code': c, 'name': p['name'], 'prevScore': p['score'], 'prevTier': tier(p['score'])}
        if r is not None:                         # 仍在榜但掉到 70 以下 → 籌碼/量價真的變差
            d.update(nowScore=r['score'], reason='分數降到 %.1f(仍過多頭門檻),籌碼或量價轉弱' % r['score'],
                     lost=[LABEL[k] for k, _, _ in CRITERIA if p['hits'][k] and not r['hits'][k]], kind='score')
        elif c in gated:                          # 被多頭門檻擋掉
            g = gated[c]
            why = []
            if g['close'] <= g['ma20']:
                why.append('收盤 %.2f 跌破月線 %.2f' % (g['close'], g['ma20']))
            if g['chg20'] < 0:
                why.append('20 日報酬 %.1f%% 為負' % g['chg20'])
            d.update(nowScore=g['score'], reason='被多頭門檻擋掉:' + '、'.join(why) + '(籌碼分數仍有 %.1f)' % g['score'],
                     kind='gate')
        else:
            d.update(reason='本週無法評分(資料不足或日均量 <50 張)', kind='nodata')
        dropped.append(d)

    for lst in (new70, promoted, demoted, steady):
        lst.sort(key=lambda x: -x['score'])
    dropped.sort(key=lambda x: -x['prevScore'])
    out.update(new70=new70, promoted=promoted, demoted=demoted, dropped=dropped, steady=steady)

    ad = load('all-data.json')
    names = {r['code']: r['name'] for r in cur}
    codes70 = [r['code'] for r in cmap.values() if r['score'] >= 70]
    out['resonance'] = sector_resonance.resonance(codes70, min_hits=2, top=12, names=names)

    if prev and prev_asof and asof and prev_asof != asof:
        try:
            fu = {}
            for label, thr in (('ge70', 70), ('ge80', 80)):
                codes = [c for c, p in pmap.items() if p['score'] >= thr]
                fu[label] = pick_followup.followup(codes, prev_asof, asof, ad)
            out['followup'] = fu
        except Exception as e:
            print('警告:點名追蹤失敗(%s)' % e)

    try:
        # 本週(最近 5 個資料日)每天的盤下鎖碼觸發,聯集;同一檔出現幾天一起列
        import holdings_review as H
        dates, _, _ = H.index_table(ad['cbBondInstitutional'])
        n = H.trim_zero_tail([v for k, v in H.index_table(ad['cbBondInstitutional'])[1].items()], len(dates))
        week = dates[max(n - 5, 0):n]
        seen = {}
        for d in week:
            _, rows = cb_offmarket.scan(ad, d)
            for r in cb_offmarket.flagged(rows, 50):
                e = seen.setdefault(r['cbCode'], dict(r, days=[]))
                e['days'].append(d)
                if r['net1'] > e['net1']:
                    e.update({k: r[k] for k in ('date', 'vol', 'net1', 'net1PctBal', 'dealer1')})
        out['offmarket'] = {'week': week, 'flagged': sorted(seen.values(), key=lambda r: -len(r['days']))}
    except Exception as e:
        print('警告:盤下鎖碼週彙整失敗(%s)' % e)

    path = os.path.join(OUT, 'weekly_diff.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print('weekly_diff: 本次 %s(A%d B%d C%d)vs 上次 %s;新進70+ %d、升級 %d、降級 %d、掉出 %d → %s'
          % (asof, out['tiers']['A'], out['tiers']['B'], out['tiers']['C'], prev_asof or '無',
             len(new70), len(promoted), len(demoted), len(dropped), path))


if __name__ == '__main__':
    main()
