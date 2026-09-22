# -*- coding: utf-8 -*-
"""把 scripts/output/daily_cb_scan.json 轉成網頁用的 data/daily_cb_rank.json（日報分頁）

用法: PYTHONUTF8=1 python scripts/build_daily_cb_rank_json.py
會附上 scripts/output/daily_commentary.json（若存在)，並歸檔一份到
data/daily_cb_rank_history/<日期>.json（+ index.json),供網頁「日報」分頁
往期切換用。
"""
import json
import os
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, 'scripts', 'output')
DATA = os.path.join(BASE, 'data')


def slim(x):
    s = x.get('s') or {}
    if not s.get('ok'):
        return {'rank': x['rank'], 'cbCode': x['cbCode'], 'cbName': x['cbName'],
                'stock': x['stock'], 'cbClose': x['cbClose'], 'cbChg': x['cbChg'],
                'cbVol': x['cbVol'], 'cbVolRatio': x.get('cbVolRatio'), 'ok': False}
    i, h, m, b = s.get('inst', {}), s.get('holder', {}), s.get('margin', {}), s.get('broker') or {}
    return {
        'rank': x['rank'], 'cbCode': x['cbCode'], 'cbName': x['cbName'],
        'stock': x['stock'], 'name': s.get('name', ''),
        'cbClose': x['cbClose'], 'cbChg': x['cbChg'], 'cbVol': x['cbVol'],
        'cbVolMA60': x['cbVolMA60'], 'cbVolRatio': x.get('cbVolRatio'),
        'ok': True,
        'close': s['close'], 'chg1': s['chg1'], 'chg5': s['chg5'], 'chg20': s['chg20'],
        'volRatio': s['volRatio'], 'pos': s['posIn60'], 'ma20': s['ma20'], 'ma60': s['ma60'],
        'score': s.get('score'),
        'foreign5': i.get('foreign5', 0), 'trust5': i.get('trust5', 0),
        'big4w': h.get('big100_chg4w', 0),
        'marginChg1': m.get('chg1', 0), 'marginChg5pct': m.get('chg5pct', 0),
        'shortChg1': m.get('shortChg1', 0), 'shortBal': m.get('short', 0),
        'marginBal': m.get('bal', 0),
        'brokerBuy': (b.get('buy') or [])[:2], 'top5NetPct': b.get('top5NetPct'),
    }


def main():
    src = os.path.join(OUT, 'daily_cb_scan.json')
    d = json.load(open(src, encoding='utf-8'))

    # 評論是人工(或 claude -p)針對「今天」寫的敘述文字,跟週報一樣用 scripts/output/
    # daily_commentary.json 供應;但日報若靠 exe 排程無人值守執行,舊評論檔會一直留在
    # scripts/output/ 底下——沒有日期比對就會把昨天的文字誤貼到今天的資料上,所以只有
    # 評論檔的 date 對得上這次掃描的日期才附上,否則視同沒有評論(不擋資料照樣更新)。
    commentary = None
    cpath = os.path.join(OUT, 'daily_commentary.json')
    if os.path.exists(cpath):
        try:
            c = json.load(open(cpath, encoding='utf-8'))
            c_date = (c.get('date') or '').replace('-', '')
            if c_date == d['date']:
                commentary = c
            else:
                print('警告:daily_commentary.json 日期(%s)跟今天(%s)對不上，本次不附評論'
                      % (c_date or '無', d['date']))
        except Exception as e:
            print('警告:評論檔讀取失敗，本次不附評論（%s）' % e)

    payload = {
        '_meta': {
            'generatedAt': datetime.now().strftime('%Y-%m-%dT%H:%M:%S+08:00'),
            'date': d['date'], 'prevDate': d['prev'], 'top': d['top'],
            'brokerDate': d.get('brokerDate'),
            'cbCountA': len(d['A']), 'cbCountB': len(d['B']),
        },
        'A': [slim(x) for x in d['A']],
        'B': [slim(x) for x in d['B']],
    }
    if commentary:
        payload['report'] = commentary

    out = os.path.join(DATA, 'daily_cb_rank.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    print('評論: %s' % ('已附上' if commentary else '無（scripts/output/daily_commentary.json 不存在）'))
    print('寫入 %s（A %d 檔 / B %d 檔，日期 %s）' % (out, len(payload['A']), len(payload['B']), d['date']))

    archive_history(payload, d['date'])


def archive_history(payload, date):
    hist_dir = os.path.join(DATA, 'daily_cb_rank_history')
    os.makedirs(hist_dir, exist_ok=True)
    hist_path = os.path.join(hist_dir, '%s.json' % date)
    with open(hist_path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))

    index_path = os.path.join(hist_dir, 'index.json')
    entries = []
    if os.path.exists(index_path):
        try:
            entries = json.load(open(index_path, encoding='utf-8'))
        except Exception:
            entries = []
    entries = [e for e in entries if e['date'] != date]
    rep = payload.get('report') or {}
    entries.append({'date': date, 'title': rep.get('title') or ('%s CB 日報' % date)})
    entries.sort(key=lambda e: e['date'], reverse=True)
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(entries, f, ensure_ascii=False, separators=(',', ':'))
    print('歸檔往期日報 %s（共 %d 筆）' % (hist_path, len(entries)))


if __name__ == '__main__':
    main()
