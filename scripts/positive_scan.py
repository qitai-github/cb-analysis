# -*- coding: utf-8 -*-
"""全網頁個股 + CB 正向訊號評分

12 項正向條件:放量上攻 / 高位階 / 多頭排列 / 外資投信同買 / 大戶增散戶減 / 融資退場 / CB 跟量

分數 = 55 + 30 x 加權命中率
  80 分以上 = 全正向 | 70 分附近 = 一半正向 | 60 分附近 = 一些些正向

用法: PYTHONUTF8=1 python scripts/positive_scan.py [--min 60]
輸出: scripts/output/positive_scan.json
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from holdings_review import analyze, load, index_table, BASE  # noqa: E402

# (key, 說明, 權重)
CRITERIA = [
    ('vol',      '量能放大 ≥1.8x',        1.5),
    ('chg1',     '當日漲 ≥2%',            1.0),
    ('chg5',     '5 日漲 ≥5%',            1.0),
    ('chg20',    '20 日漲 ≥10%',          1.0),
    ('pos',      '60 日位階 ≥70%',        1.5),
    ('trend',    '多頭排列 收>月>季線',    1.5),
    ('foreign',  '外資 5 日買超',          1.5),
    ('trust',    '投信 5 日買超',          1.5),
    ('big',      '大戶 100 張+ 4 週增加',  2.0),
    ('retail',   '散戶 4 週減少',          1.0),
    ('margin',   '融資 5 日未增 / 減少',   1.0),
    ('cb',       'CB 量能放大 ≥2x',       1.5),
]
TOTAL_W = sum(w for _, _, w in CRITERIA)


def score_one(r):
    """回傳 (score, hits dict, detail dict)。資料不足回 None。"""
    if not r.get('ok'):
        return None
    base = r.get('volMA20') or 0
    if base < 50:                      # 日均量 <50 張,倍數失真、流動性太差
        return None
    inst = r.get('inst') or {}
    hold = r.get('holder') or {}
    marg = r.get('margin') or {}
    if not inst or not hold:
        return None

    cb_best = 0.0
    cb_best_code = ''
    for c in r.get('cbs', []):
        if c.get('ratio') and c['ratio'] > cb_best:
            cb_best, cb_best_code = c['ratio'], c['cbCode']

    hits = {
        'vol':     r['volRatio'] >= 1.8,
        'chg1':    r['chg1'] >= 2.0,
        'chg5':    r['chg5'] >= 5.0,
        'chg20':   r['chg20'] >= 10.0,
        'pos':     r['posIn60'] >= 70,
        'trend':   r['close'] > r['ma20'] > r['ma60'],
        'foreign': inst.get('foreign5', 0) >= base * 0.3,
        'trust':   inst.get('trust5', 0) >= base * 0.15,
        'big':     hold.get('big100_chg4w', 0) >= 0.5,
        'retail':  hold.get('retail_chg4w', 0) <= -0.3,
        'margin':  marg.get('chg5pct', 99) <= 0,
        'cb':      cb_best >= 2.0,
    }
    # 多頭門檻:跌破月線或 20 日仍為負報酬者,不論籌碼多好都不算「正向」
    r['bullGate'] = (r['close'] > r['ma20']) and (r['chg20'] >= 0)

    got = sum(w for k, _, w in CRITERIA if hits[k])
    score = 55 + 30 * got / TOTAL_W
    r['score'] = round(score, 1)
    r['hits'] = hits
    r['hitCount'] = sum(1 for v in hits.values() if v)
    r['cbBest'] = {'code': cb_best_code, 'ratio': round(cb_best, 2)} if cb_best_code else None
    return r


def main():
    minscore = 60.0
    if '--min' in sys.argv:
        minscore = float(sys.argv[sys.argv.index('--min') + 1])

    ad = load('all-data.json')
    _, ST, _ = index_table(ad['stockTrading'])
    codes = sorted({c for (c, cat) in ST if cat == '收盤價'})
    print('掃描 %d 檔...' % len(codes))

    rows = analyze(codes)
    allscored = [x for x in (score_one(r) for r in rows) if x]
    scored = [r for r in allscored if r['bullGate']]
    rejected = [r for r in allscored if not r['bullGate'] and r['score'] >= 70]
    scored.sort(key=lambda r: -r['score'])
    rejected.sort(key=lambda r: -r['score'])
    print('通過多頭門檻 %d / %d 檔;籌碼佳但線型未過關 %d 檔'
          % (len(scored), len(allscored), len(rejected)))

    out = os.path.join(BASE, 'scripts', 'output', 'positive_scan.json')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(scored, f, ensure_ascii=False, indent=1)

    tiers = {'80+ 全正向': [], '70-79 一半正向': [], '60-69 一些正向': []}
    for r in scored:
        if r['score'] >= 80:
            tiers['80+ 全正向'].append(r)
        elif r['score'] >= 70:
            tiers['70-79 一半正向'].append(r)
        elif r['score'] >= 60:
            tiers['60-69 一些正向'].append(r)

    for name, group in tiers.items():
        print('\n===== %s (%d 檔) =====' % (name, len(group)))
        for r in group:
            if r['score'] < minscore:
                continue
            names = [d for k, d, _ in CRITERIA if r['hits'][k]]
            cb = r['cbBest']
            print('%5.1f  %s %-6s 收%-9.2f %+6.2f%%/1D %+6.1f%%/5D %+6.1f%%/20D 量%.2fx 位階%3.0f%% | %s%s'
                  % (r['score'], r['code'], r['name'], r['close'], r['chg1'], r['chg5'], r['chg20'],
                     r['volRatio'], r['posIn60'], '、'.join(names),
                     ('  [CB %s %.1fx]' % (cb['code'], cb['ratio'])) if cb and cb['ratio'] >= 2 else ''))

    print('\n合計 %d 檔評分 → %s' % (len(scored), out))


if __name__ == '__main__':
    main()
