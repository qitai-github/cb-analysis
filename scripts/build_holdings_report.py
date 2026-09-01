# -*- coding: utf-8 -*-
"""把 holdings_review.json 產成 HTML 表格片段(給報告頁用)

輸出 scripts/output/_holdings_tables.html,含 <!--MAIN--> 與 <!--CB--> 兩段。
排序依 scripts/output/holdings_order.txt(每行一個代碼)決定,沒有就照原順序。
"""
import json
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTDIR = os.path.join(BASE, 'scripts', 'output')
data = json.load(open(os.path.join(OUTDIR, 'holdings_review.json'), encoding='utf-8'))
by = {r['code']: r for r in data}

orderfile = os.path.join(OUTDIR, 'holdings_order.txt')
if os.path.exists(orderfile):
    order = [ln.split()[0] for ln in open(orderfile, encoding='utf-8') if ln.strip()]
else:
    order = [r['code'] for r in data]

SEV = {}
sevfile = os.path.join(OUTDIR, 'holdings_sev.txt')
if os.path.exists(sevfile):
    for ln in open(sevfile, encoding='utf-8'):
        if ln.strip():
            c, s = ln.split()[:2]
            SEV[c] = s


def cl(v):
    return 'up' if v > 0 else ('down' if v < 0 else 'flat')


def fmt(v):
    return '{:,.2f}'.format(v) if v < 100 else '{:,.0f}'.format(v)


def main_row(r):
    h, i, m = r.get('holder', {}), r.get('inst', {}), r.get('margin', {})
    cbs = r.get('cbs', [])
    best = max((c['ratio'] or 0 for c in cbs), default=0)
    bestcode = ''
    for c in cbs:
        if (c['ratio'] or 0) == best:
            bestcode = c['cbCode']
            break
    cbtd = ('<td class="n faintcell">—</td>' if not best else
            '<td class="n%s">%.1fx <span class="faintcell">%s</span></td>'
            % (' up' if best >= 2 else '', best, bestcode))
    sev = SEV.get(r['code'], 'calm')
    return (
        '<tr><td><span class="dot %s"></span>%s</td><td>%s</td>'
        '<td class="n">%s</td><td class="n %s">%+.2f%%</td><td class="n %s">%+.1f%%</td>'
        '<td class="n %s">%+.1f%%</td><td class="n">%.2fx</td><td class="n">%.0f%%</td>'
        '<td class="n %s">%+d</td><td class="n %s">%+d</td>'
        '<td class="n %s">%+.2f</td><td class="n %s">%+.2f</td>'
        '<td class="n %s">%+.1f%%</td><td class="n">%s</td>%s</tr>'
    ) % (
        sev, r['code'], r['name'], fmt(r['close']),
        cl(r['chg1']), r['chg1'], cl(r['chg5']), r['chg5'], cl(r['chg20']), r['chg20'],
        r['volRatio'], r['posIn60'],
        cl(i.get('foreign5', 0)), i.get('foreign5', 0),
        cl(i.get('trust5', 0)), i.get('trust5', 0),
        cl(h.get('big100_chg1w', 0)), h.get('big100_chg1w', 0),
        cl(h.get('big100_chg4w', 0)), h.get('big100_chg4w', 0),
        cl(m.get('chg5pct', 0)), m.get('chg5pct', 0),
        '{:,}'.format(m.get('short', 0)), cbtd,
    )


MAIN_HEAD = ('<tr><th>代碼</th><th>名稱</th><th>收盤</th><th>當日</th><th>5日</th><th>20日</th>'
             '<th>量比</th><th>位階</th><th>外資5日</th><th>投信5日</th><th>大戶1週</th>'
             '<th>大戶4週</th><th>融資5日</th><th>券餘</th><th>CB最大量比</th></tr>')

CB_HEAD = ('<tr><th>CB</th><th>名稱</th><th>資料日</th><th>當日量</th><th>60日均量</th><th>倍數</th>'
           '<th>5日累量</th><th>CB價</th><th>5日</th><th>20日</th><th>外資5日</th></tr>')


def cb_rows():
    rows = []
    for code in order:
        r = by.get(code)
        if not r:
            continue
        for c in r.get('cbs', []):
            rows.append((c['ratio'] or 0, c, r))
    rows.sort(key=lambda x: -x[0])
    out = []
    for ratio, c, r in rows:
        if ratio < 1.5 and c['vol5'] < 300:
            continue
        out.append(
            '<tr><td class="n">%s</td><td>%s</td><td class="n faintcell">%s</td>'
            '<td class="n">%s</td><td class="n">%s</td><td class="n%s">%.2fx</td>'
            '<td class="n">%s</td><td class="n">%.1f</td><td class="n %s">%+.1f%%</td>'
            '<td class="n %s">%+.1f%%</td><td class="n %s">%+d</td></tr>'
            % (c['cbCode'], c['cbName'], c['date'],
               '{:,}'.format(c['vol']), '{:,.1f}'.format(c['volMA60']),
               ' up' if ratio >= 2 else '', ratio,
               '{:,}'.format(c['vol5']), c['close'],
               cl(c['chg5']), c['chg5'], cl(c['chg20']), c['chg20'],
               cl(c.get('cbForeign5', 0)), c.get('cbForeign5', 0)))
    return ''.join(out)


main = ('<div class="tablewrap"><table><thead>%s</thead><tbody>%s</tbody></table></div>'
        % (MAIN_HEAD, ''.join(main_row(by[c]) for c in order if c in by)))
cb = ('<div class="tablewrap"><table class="cbtable"><thead>%s</thead><tbody>%s</tbody></table></div>'
      % (CB_HEAD, cb_rows()))

with open(os.path.join(OUTDIR, '_holdings_tables.html'), 'w', encoding='utf-8') as f:
    f.write('<!--MAIN-->\n' + main + '\n<!--CB-->\n' + cb)
print('ok → scripts/output/_holdings_tables.html')
