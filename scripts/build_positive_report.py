# -*- coding: utf-8 -*-
"""把 positive_scan.json 產成 HTML 報告(給 Artifact 發佈用) — 正向訊號榜"""
import json
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, 'scripts'))
from positive_scan import CRITERIA  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(BASE, 'scripts', 'output', 'positive_report.html')
data = json.load(open(os.path.join(BASE, 'scripts', 'output', 'positive_scan.json'), encoding='utf-8'))

A = [r for r in data if r['score'] >= 80]
B = [r for r in data if 70 <= r['score'] < 80]
C = [r for r in data if 60 <= r['score'] < 70]

LABEL = {k: d for k, d, _ in CRITERIA}
SHORT = {
    'vol': '放量', 'chg1': '日漲', 'chg5': '5日漲', 'chg20': '20日漲', 'pos': '高位階',
    'trend': '多頭排列', 'foreign': '外資買', 'trust': '投信買', 'big': '大戶增',
    'retail': '散戶減', 'margin': '融資退', 'cb': 'CB放量',
}
ORDER = [k for k, _, _ in CRITERIA]


def cls(v, inv=False):
    if v > 0:
        return 'down' if inv else 'up'
    if v < 0:
        return 'up' if inv else 'down'
    return 'flat'


def chips(r):
    out = []
    for k in ORDER:
        on = r['hits'][k]
        out.append('<span class="chip%s" title="%s">%s</span>' % ('' if on else ' off', LABEL[k], SHORT[k]))
    return ''.join(out)


def cbcell(r):
    cb = r.get('cbBest')
    if not cb or not cb['ratio']:
        return '<td class="n faintcell">—</td>'
    hot = ' up' if cb['ratio'] >= 2 else ''
    return '<td class="n%s">%s <span class="faintcell">%s</span></td>' % (hot, ('%.1fx' % cb['ratio']), cb['code'])


def row(r):
    h = r.get('holder', {})
    i = r.get('inst', {})
    return (
        '<tr>'
        '<td class="n score">%.1f</td>'
        '<td class="n">%s</td><td>%s</td>'
        '<td class="n">%s</td>'
        '<td class="n %s">%+.1f%%</td>'
        '<td class="n %s">%+.1f%%</td>'
        '<td class="n %s">%+.1f%%</td>'
        '<td class="n">%.2fx</td>'
        '<td class="n">%.0f%%</td>'
        '<td class="n %s">%+d</td>'
        '<td class="n %s">%+d</td>'
        '<td class="n %s">%+.2f</td>'
        '%s'
        '<td class="chips">%s</td>'
        '</tr>'
    ) % (
        r['score'], r['code'], r['name'],
        ('{:,.2f}'.format(r['close']) if r['close'] < 100 else '{:,.0f}'.format(r['close'])),
        cls(r['chg1']), r['chg1'], cls(r['chg5']), r['chg5'], cls(r['chg20']), r['chg20'],
        r['volRatio'], r['posIn60'],
        cls(i.get('foreign5', 0)), i.get('foreign5', 0),
        cls(i.get('trust5', 0)), i.get('trust5', 0),
        cls(h.get('big100_chg4w', 0)), h.get('big100_chg4w', 0),
        cbcell(r), chips(r),
    )


HEAD = ('<tr><th>分數</th><th>代碼</th><th>名稱</th><th>收盤</th><th>當日</th><th>5日</th><th>20日</th>'
        '<th>量比</th><th>位階</th><th>外資5日</th><th>投信5日</th><th>大戶4週</th><th>CB 最大量比</th>'
        '<th>命中訊號</th></tr>')


def table(rows):
    return ('<div class="tablewrap"><table><thead>%s</thead><tbody>%s</tbody></table></div>'
            % (HEAD, ''.join(row(r) for r in rows)))


with open(os.path.join(BASE, 'scripts', 'output', '_tables.html'), 'w', encoding='utf-8') as f:
    f.write('<!--A-->\n' + table(A) + '\n<!--B-->\n' + table(B) + '\n<!--C-->\n' + table(C))

print('A=%d B=%d C=%d → scripts/output/_tables.html' % (len(A), len(B), len(C)))
