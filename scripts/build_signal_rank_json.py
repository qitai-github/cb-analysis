# -*- coding: utf-8 -*-
"""把 positive_scan.json 轉成網頁用的 data/signal_rank.json（籌碼追蹤分頁）

會自動找 scripts/output/positive_scan_<YYYYMMDD>.json 的前一份快照做分數追蹤。

用法: PYTHONUTF8=1 python scripts/build_signal_rank_json.py
"""
import glob
import json
import os
import re
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, 'scripts', 'output')
DATA = os.path.join(BASE, 'data')

import sys
sys.path.insert(0, os.path.join(BASE, 'scripts'))
from positive_scan import CRITERIA  # noqa: E402


def tier_of(score):
    if score >= 80:
        return 'A'
    if score >= 70:
        return 'B'
    if score >= 60:
        return 'C'
    return 'D'          # 60 分以下:有過多頭門檻但訊號太少,網頁預設不顯示


def snapshots():
    """所有快照,依日期排序 → [(YYYYMMDD, path)]"""
    out = []
    for p in glob.glob(os.path.join(OUT, 'positive_scan_2*.json')):
        m = re.search(r'(\d{8})', os.path.basename(p))
        if m:
            out.append((m.group(1), p))
    return sorted(out)


def slim(r, prev_score=None):
    h = r.get('holder', {})
    i = r.get('inst', {})
    m = r.get('margin', {})
    cb = r.get('cbBest') or {}
    cb_detail = None
    if cb.get('code'):
        for c in r.get('cbs', []):
            if c['cbCode'] == cb['code']:
                cb_detail = c
                break
    d = {
        'code': r['code'], 'name': r['name'],
        'score': r['score'], 'tier': tier_of(r['score']),
        'close': r['close'], 'chg1': r['chg1'], 'chg5': r['chg5'], 'chg20': r['chg20'],
        'volRatio': r['volRatio'], 'vol': r['vol'], 'volMA20': r['volMA20'],
        'pos': r['posIn60'], 'ma20': r['ma20'], 'ma60': r['ma60'],
        'foreign5': i.get('foreign5', 0), 'trust5': i.get('trust5', 0),
        'foreign20': i.get('foreign20', 0), 'trust20': i.get('trust20', 0),
        'big4w': h.get('big100_chg4w', 0), 'big1w': h.get('big100_chg1w', 0),
        'big12w': h.get('big100_chg12w', 0), 'retail4w': h.get('retail_chg4w', 0),
        'margin5': m.get('chg5pct', 0), 'margin20': m.get('chg20pct', 0),
        'short': m.get('short', 0),
        'hits': [k for k, _, _ in CRITERIA if r['hits'][k]],
    }
    if cb_detail:
        d['cb'] = {
            'code': cb_detail['cbCode'], 'name': cb_detail['cbName'],
            'ratio': cb_detail['ratio'], 'vol': cb_detail['vol'],
            'close': cb_detail['close'], 'chg5': cb_detail['chg5'],
        }
    if prev_score is not None:
        d['prevScore'] = prev_score
        d['delta'] = round(r['score'] - prev_score, 1)
    return d


def main():
    cur_path = os.path.join(OUT, 'positive_scan.json')
    cur = json.load(open(cur_path, encoding='utf-8'))
    snaps = snapshots()

    today = datetime.now().strftime('%Y%m%d')
    prev_date, prev_map = None, {}
    for date, path in reversed(snaps):
        if date == today:
            continue
        prev_date = date
        prev_map = {r['code']: r['score'] for r in json.load(open(path, encoding='utf-8'))}
        break

    stocks = [slim(r, prev_map.get(r['code'])) for r in cur]
    stocks.sort(key=lambda x: -x['score'])

    cur_codes = {r['code'] for r in cur}
    dropped = [{'code': c, 'prevScore': s} for c, s in sorted(prev_map.items(), key=lambda x: -x[1])
               if c not in cur_codes and s >= 70]

    asof = cur[0].get('asOf') if cur else ''
    margin_date = next((r['margin']['date'] for r in cur if r.get('margin')), '')
    holder_date = next((r['holder']['date'] for r in cur if r.get('holder')), '')

    # 評論（週報的文字內容）— 由 claude 寫進 scripts/output/signal_commentary.json
    commentary = None
    cpath = os.path.join(OUT, 'signal_commentary.json')
    if os.path.exists(cpath):
        try:
            commentary = json.load(open(cpath, encoding='utf-8'))
        except Exception as e:
            print('警告:評論檔讀取失敗，本次不附評論（%s）' % e)

    payload = {
        '_meta': {
            'generatedAt': datetime.now().strftime('%Y-%m-%dT%H:%M:%S+08:00'),
            'asOf': asof, 'marginDate': margin_date, 'holderDate': holder_date,
            'prevDate': prev_date or '',
            'listed': len(stocks),
            'tierA': sum(1 for s in stocks if s['tier'] == 'A'),
            'tierB': sum(1 for s in stocks if s['tier'] == 'B'),
            'tierC': sum(1 for s in stocks if s['tier'] == 'C'),
            'tierD': sum(1 for s in stocks if s['tier'] == 'D'),
            'formula': '55 + 30 x 命中權重/16',
        },
        'criteria': [{'key': k, 'label': d, 'weight': w} for k, d, w in CRITERIA],
        'stocks': stocks,
        'dropped': dropped,
    }
    if commentary:
        payload['report'] = commentary

    out = os.path.join(DATA, 'signal_rank.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    print('評論: %s' % ('已附上' if commentary else '無（scripts/output/signal_commentary.json 不存在）'))
    print('寫入 %s（%d 檔，A%d B%d C%d D%d，前次快照 %s，掉出 %d 檔）'
          % (out, len(stocks), payload['_meta']['tierA'], payload['_meta']['tierB'],
             payload['_meta']['tierC'], payload['_meta']['tierD'],
             prev_date or '無', len(dropped)))


if __name__ == '__main__':
    main()
