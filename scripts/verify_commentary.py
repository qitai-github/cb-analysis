# -*- coding: utf-8 -*-
"""評論檔對帳 — claude -p 寫完評論後、build 之前執行,抓「數字誤引」

用法:
  PYTHONUTF8=1 python scripts/verify_commentary.py daily    # 查 daily_commentary.json vs daily_cb_scan.json
  PYTHONUTF8=1 python scripts/verify_commentary.py weekly   # 查 signal_commentary.json vs weekly_diff.json

檢查項目(ERROR=必須修正,WARN=請人工再看一眼):
  共通  date 對得上資料日;sections 必要段落存在;highlights 的 code/name/score 與資料一致
  daily 文字裡「個股名 … NN.N 分」的分數必須等於該股今日分數(或點名追蹤裡的前值)
  weekly highlights 必須恰為 80 分以上全部;stats 的「80 分以上」檔數對得上;
         文字裡「個股名 … NN.N 分」只能是本週分或上週分(weekly_diff 裡的 score/prevScore);
         artifactUrl 非空且 reports/weekly/<日期>.html 存在
結束碼:有 ERROR → 1,否則 0。
"""
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, 'scripts', 'output')
errors, warns = [], []


def err(m):
    errors.append(m)


def warn(m):
    warns.append(m)


def load(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def all_text(c):
    parts = [c.get('title', ''), c.get('lede', '')]
    for h in c.get('highlights', []):
        parts += [h.get('text', ''), h.get('cb', ''), h.get('tag', '')]
    for s in c.get('sections', []):
        parts.append(s.get('body', ''))
    return '\n'.join(parts)


def check_scores_in_text(text, valid):
    """valid: {股名: {可接受的分數}}。抓「股名後 14 字內第一個 NN.N 分」"""
    for name, ok in valid.items():
        if len(name) < 2:
            continue
        for m in re.finditer(re.escape(name) + r'[^。;\n]{0,14}?(\d{2}\.\d)\s*分', text):
            v = float(m.group(1))
            if all(abs(v - x) > 0.05 for x in ok):
                err('文字裡 %s 的分數 %.1f 對不上資料(可接受: %s)' % (name, v, sorted(ok)))


def check_daily():
    scan = load(os.path.join(OUT, 'daily_cb_scan.json'))
    c = load(os.path.join(OUT, 'daily_commentary.json'))
    if (c.get('date') or '').replace('-', '') != scan['date']:
        err('date %s 不等於掃描日 %s(網頁會忽略這份評論)' % (c.get('date'), scan['date']))
    need = ['榜首與異常值', '量價關係摘要', '籌碼面觀察', '使用前要知道的事']
    heads = ' '.join(s.get('heading', '') for s in c.get('sections', []))
    for n in need:
        if n not in heads:
            err('sections 缺少「%s」段' % n)
    by = {}
    for x in scan['A'] + scan['B']:
        by.setdefault(x['stock'], x)
    valid = {}
    for h in c.get('highlights', []):
        x = by.get(h['code'])
        if not x:
            err('highlight %s %s 不在今日 A/B 榜單' % (h['code'], h['name'])); continue
        s = x['s']
        if s.get('name') and s['name'] != h['name']:
            err('highlight %s 名稱 %s ≠ 資料 %s' % (h['code'], h['name'], s['name']))
        if s.get('score') is not None and abs(float(h['score']) - s['score']) > 0.05:
            err('highlight %s %s 分數 %.1f ≠ 資料 %.1f' % (h['code'], h['name'], float(h['score']), s['score']))
    for code, x in by.items():
        s = x['s']
        if s.get('name') and s.get('score') is not None:
            valid.setdefault(s['name'], set()).add(s['score'])
    check_scores_in_text(all_text(c), valid)
    # 失真旗標沒在「使用前要知道的事」提過 → 提醒
    flagged = {f.split('(')[0] for x in scan['A'] + scan['B'] for f in x.get('flags', [])}
    tail = ' '.join(s.get('body', '') for s in c.get('sections', []) if '使用前' in s.get('heading', ''))
    for k, kw in (('個股量縮上漲', '量縮'), ('CB基期過小', '基期'), ('融資餘額<300張', '融資')):
        if k in flagged and kw not in tail:
            warn('今日有「%s」旗標,但「使用前要知道的事」沒提到「%s」' % (k, kw))
    om = (scan.get('offmarket') or {}).get('flagged') or []
    if om and '盤下' not in all_text(c) and '鎖碼' not in all_text(c):
        warn('今日偵測到 %d 檔盤下鎖碼,評論完全沒提(可在 sections 加一段)' % len(om))


def check_weekly():
    diff = load(os.path.join(OUT, 'weekly_diff.json'))
    c = load(os.path.join(OUT, 'signal_commentary.json'))
    asof = diff['asOf']
    need = ['上次名單追蹤', '新進名單', '要小心的型態', '評分方法', '使用前要知道的事']
    heads = ' '.join(s.get('heading', '') for s in c.get('sections', []))
    for n in need:
        if n not in heads:
            err('sections 缺少「%s」段' % n)
    cur = {}
    for k in ('new70', 'promoted', 'demoted', 'steady'):
        for r in diff[k]:
            cur[r['code']] = r
    a80 = {code for code, r in cur.items() if r['score'] >= 80}
    hl = {h['code'] for h in c.get('highlights', [])}
    if a80 != hl:
        err('highlights 應恰為 80 分以上全部:多了 %s、少了 %s' % (sorted(hl - a80), sorted(a80 - hl)))
    for h in c.get('highlights', []):
        r = cur.get(h['code'])
        if r and abs(float(h['score']) - r['score']) > 0.05:
            err('highlight %s 分數 %.1f ≠ 資料 %.1f' % (h['code'], float(h['score']), r['score']))
    for st in c.get('stats', []):
        if '80' in st.get('label', '') and re.search(r'\d+', st.get('value', '')):
            n = int(re.search(r'\d+', st['value']).group())
            if n != diff['ge80']:
                err('stats「%s」=%s 但資料 80 分以上為 %d 檔' % (st['label'], st['value'], diff['ge80']))
    valid = {}
    for k in ('new70', 'promoted', 'demoted', 'steady', 'dropped'):
        for r in diff[k]:
            ok = valid.setdefault(r['name'], set())
            for f in ('score', 'prevScore', 'nowScore'):
                if r.get(f) is not None:
                    ok.add(r[f])
    check_scores_in_text(all_text(c), valid)
    url = c.get('artifactUrl') or ''
    if not url:
        err('artifactUrl 是空字串(網頁「看完整報告」按鈕不會出現)')
    else:
        m = re.search(r'reports/weekly/(\d{8})\.html', url)
        if not m or not os.path.exists(os.path.join(BASE, 'reports', 'weekly', m.group(1) + '.html')):
            err('artifactUrl 指向的 reports/weekly 檔案不存在: %s' % url)
    if (c.get('date') or '').replace('-', '') < asof:
        warn('評論 date %s 早於資料日 %s' % (c.get('date'), asof))
    dn = ' '.join(r['name'] for r in diff['dropped'])
    txt = all_text(c)
    miss = [r['name'] for r in diff['dropped'][:5] if r['name'] not in txt]
    if miss:
        warn('上次 70+ 掉榜名單前幾名沒被提到: %s' % '、'.join(miss))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode not in ('daily', 'weekly'):
        print(__doc__); sys.exit(2)
    try:
        (check_daily if mode == 'daily' else check_weekly)()
    except FileNotFoundError as e:
        err('缺少檔案: %s' % e.filename)
    for w in warns:
        print('WARN  ' + w)
    for e in errors:
        print('ERROR ' + e)
    print('對帳完成:%d 個錯誤、%d 個提醒' % (len(errors), len(warns)))
    sys.exit(1 if errors else 0)


if __name__ == '__main__':
    main()
