# -*- coding: utf-8 -*-
"""daily_cb_scan.json → 日報 HTML(CSS 沿用週報版型)。

用法: python scripts/build_daily_cb_report.py [commentary_fragment.html]
片段內可用 {{TABLE_A}} {{TABLE_B}} 佔位符;輸出 scripts/output/daily_cb_report_<date>.html
"""
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, 'scripts', 'output')
d = json.load(open(os.path.join(OUT, 'daily_cb_scan.json'), encoding='utf-8'))
tpl = open(os.path.join(BASE, 'scripts', 'templates', 'universe_report_example.html'), encoding='utf-8').read()
head = tpl[:tpl.index('</style>') + len('</style>')]
mmdd = d['date'][4:6].lstrip('0') + '/' + d['date'][6:].lstrip('0')
head = re.sub(r'<title>.*?</title>', '<title>CB 日報 %s</title>' % d['date'][4:], head)


def cls(v):
    return 'up' if v > 0 else ('down' if v < 0 else 'flat')


def trend(s):
    if s['close'] > s['ma20'] > s['ma60']:
        return '多頭'
    return '月線下' if s['close'] < s['ma20'] else '整理'


def row(x):
    s = x['s']
    if not s.get('ok'):
        return '<tr><td class="n">%d</td><td class="n">%s</td><td>%s</td><td colspan="21">無個股資料</td></tr>' % (x['rank'], x['cbCode'], x['cbName'])
    i, h, m, b = s.get('inst', {}), s.get('holder', {}), s.get('margin', {}), s.get('broker') or {}
    vr = x['cbVolRatio']
    vrs = '—' if (vr is None or x['cbVolMA60'] < 5) else '%.1fx' % vr
    brk = '、'.join('%s %+d' % (n[:4] or '?', v) for n, v in (b.get('buy') or [])[:2]) or '—'
    sc = s.get('score')
    return ('<tr><td class="n">%d</td><td class="n">%s</td><td>%s</td>'
            '<td class="n">%.1f</td><td class="n %s">%+.1f%%</td><td class="n">%d</td><td class="n">%s</td>'
            '<td class="n %s">%+.1f%%</td><td class="n %s">%+.1f%%</td><td class="n %s">%+.1f%%</td>'
            '<td class="n">%.2fx</td><td class="n">%.0f%%</td><td>%s</td>'
            '<td class="n %s">%+d</td><td class="n %s">%+d</td><td class="n %s">%s</td>'
            '<td class="n %s">%s</td><td class="n %s">%s</td><td class="n %s">%s</td><td class="n">%s</td>'
            '<td class="n score">%s</td><td>%s</td><td class="n">%s</td></tr>') % (
        x['rank'], x['cbCode'], s['name'], x['cbClose'], cls(x['cbChg']), x['cbChg'], x['cbVol'], vrs,
        cls(s['chg1']), s['chg1'], cls(s['chg5']), s['chg5'], cls(s['chg20']), s['chg20'],
        s['volRatio'], s['posIn60'], trend(s),
        cls(i.get('foreign5', 0)), i.get('foreign5', 0), cls(i.get('trust5', 0)), i.get('trust5', 0),
        cls(h.get('big100_chg4w', 0)), ('%+.2f' % h['big100_chg4w']) if h else '—',
        cls(-(m.get('chg1', 0))), ('%+d' % m['chg1']) if m else '—',
        cls(-(m.get('chg5pct', 0))), ('%+.0f%%' % m['chg5pct']) if m and abs(m['chg5pct']) < 500 else '—',
        cls(m.get('shortChg1', 0)), ('%+d' % m['shortChg1']) if m else '—',
        ('%.0f%%' % (m['short'] / m['bal'] * 100)) if m and m['bal'] else '—',
        ('%.1f' % sc) if sc else '—', brk, ('%.0f%%' % b['top5NetPct']) if b else '—')


HEAD = ('<tr><th>#</th><th>CB</th><th>個股</th><th>CB價</th><th>CB漲跌</th><th>CB量</th><th>CB量比</th>'
        '<th>股當日</th><th>5日</th><th>20日</th><th>股量比</th><th>位階</th><th>均線</th>'
        '<th>外資5日</th><th>投信5日</th><th>大戶4週</th><th>融資日增</th><th>融資5日</th><th>融券日增</th><th>券資比</th><th>週報分</th>'
        '<th>券商買超前2(張)</th><th>前5集中</th></tr>')


def table(rows):
    return '<div class="tablewrap"><table><thead>%s</thead><tbody>%s</tbody></table></div>' % (
        HEAD, ''.join(row(x) for x in rows))


frag = open(sys.argv[1], encoding='utf-8').read() if len(sys.argv) > 1 else '{{TABLE_A}}{{TABLE_B}}'
body = frag.replace('{{TABLE_A}}', table(d['A'])).replace('{{TABLE_B}}', table(d['B']))
out = os.path.join(OUT, 'daily_cb_report_%s.html' % d['date'])
open(out, 'w', encoding='utf-8').write(head + '\n<div class="wrap">\n' + body + '\n</div>\n')
print(out, len(body))
