# -*- coding: utf-8 -*-
"""持股清單異常掃描 — 量能/法人/融資券/大戶/技術線型 + 對應 CB 量能

用法:
  PYTHONUTF8=1 python scripts/holdings_review.py 2301 3131 6187
  PYTHONUTF8=1 python scripts/holdings_review.py --csv "持股清單/CB篩選結果_20260828.csv"

輸出: scripts/output/holdings_review.json (+ 終端摘要)
"""
import csv
import json
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(BASE, 'data')


def load(name):
    with open(os.path.join(D, name), encoding='utf-8') as f:
        return json.load(f)


def to_f(x):
    try:
        return float(str(x).replace(',', ''))
    except Exception:
        return 0.0


def index_table(rows):
    """[代號,名稱,類別,...日期] → dates, {(code,cat): [float]}, {code: name}

    日期欄位理論上照時間排序,但來源(如融資融券的回補流程)偶爾會把單一日期
    附加在檔案最後而非插回正確位置(例如 ...0904,0826)。這裡強制依日期排序,
    避免下游的 [-5:]/[-21:] 這類「假設最後一欄=今天」的切片算到錯誤的日期。
    """
    hdr = rows[0]
    raw_dates = hdr[3:]
    order = sorted(range(len(raw_dates)), key=lambda i: raw_dates[i])
    dates = [raw_dates[i] for i in order]
    out, names = {}, {}
    cur_code = cur_name = ''
    for r in rows[1:]:
        # 合併儲存格:同一檔的第 2~n 個類別列,代號/名稱欄是空的 → 向下填補
        if str(r[0]).strip():
            cur_code, cur_name = str(r[0]).strip(), str(r[1]).strip()
        if not cur_code:
            continue
        vals = [to_f(x) for x in r[3:]]
        out[(cur_code, str(r[2]).strip())] = [vals[i] if i < len(vals) else 0.0 for i in order]
        names[cur_code] = cur_name
    return dates, out, names


def trim_zero_tail(series_list, total):
    """砍掉尾端全 0 的日期(尚未收盤/缺資料)"""
    n = total
    while n > 0 and all(s[n - 1] == 0 for s in series_list if len(s) >= n):
        n -= 1
    return n


def pct(a, b):
    return (a / b - 1) * 100 if b else 0.0


def ma(v, n):
    return sum(v[-n:]) / min(n, len(v)) if v else 0.0


def analyze(codes):
    ad = load('all-data.json')
    sh = load('shareholding.json')

    st_dates, ST, st_names = index_table(ad['stockTrading'])
    ins_dates, INS, _ = index_table(ad['cbInstitutional'])
    mg_dates, MG, _ = index_table(ad['marginTrading'])
    cb_dates, CB, cb_names = index_table(ad['cbDailyTrading'])
    cbi_dates, CBI, _ = index_table(ad['cbBondInstitutional'])

    cb_by_stock = {}
    for (code, cat) in CB:
        if cat == '成交量(張)':
            cb_by_stock.setdefault(code[:4], set()).add(code)

    results = []
    for code in codes:
        r = {'code': code, 'name': st_names.get(code, ''), 'flags': [], 'ok': True}
        close = ST.get((code, '收盤價'))
        vol = ST.get((code, '成交股數'))
        if not close or not vol:
            r['ok'] = False
            r['note'] = '無個股價量資料'
            results.append(r)
            continue

        n = trim_zero_tail([close, vol], len(st_dates))
        c = close[:n]
        v = [x / 1000 for x in vol[:n]]     # 股 → 張
        r['asOf'] = st_dates[n - 1]
        r['close'] = round(c[-1], 2)
        r['chg1'] = round(pct(c[-1], c[-2]), 2) if n >= 2 else 0
        r['chg5'] = round(pct(c[-1], c[-6]), 2) if n >= 6 else 0
        r['chg20'] = round(pct(c[-1], c[-21]), 2) if n >= 21 else 0
        r['vol'] = round(v[-1])
        base20 = sum(v[-21:-1]) / 20 if n >= 21 else ma(v[:-1], max(n - 1, 1))
        r['volMA20'] = round(base20)
        r['volRatio'] = round(v[-1] / base20, 2) if base20 else 0
        r['vol5avg'] = round(sum(v[-5:]) / 5)
        r['ma20'] = round(ma(c, 20), 2)
        r['ma60'] = round(ma(c, 60), 2)
        hi60, lo60 = max(c[-60:]), min(c[-60:])
        r['hi60'], r['lo60'] = round(hi60, 2), round(lo60, 2)
        r['posIn60'] = round((c[-1] - lo60) / (hi60 - lo60) * 100, 1) if hi60 > lo60 else 0

        if r['volRatio'] >= 2.5:
            r['flags'].append('爆量 %.1fx 月均量' % r['volRatio'])
        elif r['volRatio'] >= 1.8:
            r['flags'].append('放量 %.1fx' % r['volRatio'])
        elif r['volRatio'] <= 0.5:
            r['flags'].append('量縮 %.2fx' % r['volRatio'])
        if n >= 22:
            prev20 = ma(c[:-1], 20)
            prev60 = ma(c[:-1], 60)
            if c[-2] < prev20 and c[-1] > r['ma20']:
                r['flags'].append('站上月線')
            if c[-2] > prev20 and c[-1] < r['ma20']:
                r['flags'].append('跌破月線')
            if c[-2] < prev60 and c[-1] > r['ma60']:
                r['flags'].append('站上季線')
            if c[-2] > prev60 and c[-1] < r['ma60']:
                r['flags'].append('跌破季線')
        if c[-1] >= hi60 * 0.999:
            r['flags'].append('創 60 日新高')
        if c[-1] <= lo60 * 1.001:
            r['flags'].append('創 60 日新低')
        if abs(r['chg1']) >= 5:
            r['flags'].append('單日 %+.1f%%' % r['chg1'])

        # 三大法人 (股 → 張)
        fi, it, dl = (INS.get((code, k)) for k in ('外資買賣超', '投信買賣超', '自營商買賣超'))
        if fi and it and dl:
            m = trim_zero_tail([fi, it, dl], len(ins_dates))
            if m >= 20:
                f1, i1, d1 = (x[m - 1] / 1000 for x in (fi, it, dl))
                f5, i5, d5 = (sum(x[m - 5:m]) / 1000 for x in (fi, it, dl))
                r['inst'] = {
                    'date': ins_dates[m - 1],
                    'foreign1': round(f1), 'trust1': round(i1), 'dealer1': round(d1),
                    'foreign5': round(f5), 'trust5': round(i5), 'dealer5': round(d5),
                    'foreign20': round(sum(fi[m - 20:m]) / 1000),
                    'trust20': round(sum(it[m - 20:m]) / 1000),
                }
                net1 = f1 + i1 + d1
                if base20:
                    if net1 >= base20 * 0.15:
                        r['flags'].append('法人單日大買 %+.0f 張' % net1)
                    if net1 <= -base20 * 0.15:
                        r['flags'].append('法人單日大賣 %+.0f 張' % net1)
                thr = max(150, base20 * 0.4)
                if i5 >= thr:
                    r['flags'].append('投信 5 日買超 %+.0f 張' % i5)
                if i5 <= -thr:
                    r['flags'].append('投信 5 日賣超 %+.0f 張' % i5)
                if f5 >= max(500, base20 * 0.8):
                    r['flags'].append('外資 5 日買超 %+.0f 張' % f5)
                if f5 <= -max(500, base20 * 0.8):
                    r['flags'].append('外資 5 日賣超 %+.0f 張' % f5)

        # 融資融券
        mb, ms = MG.get((code, '融資餘額')), MG.get((code, '融券餘額'))
        if mb:
            m = trim_zero_tail([mb], len(mg_dates))
            if m >= 6:
                r['margin'] = {
                    'date': mg_dates[m - 1], 'bal': round(mb[m - 1]),
                    'chg1': round(mb[m - 1] - mb[m - 2]),
                    'chg5': round(mb[m - 1] - mb[m - 6]),
                    'chg5pct': round(pct(mb[m - 1], mb[m - 6]), 1),
                    'chg20pct': round(pct(mb[m - 1], mb[m - 21]), 1) if m >= 21 else 0,
                    'short': round(ms[m - 1]) if ms else 0,
                    'shortChg5': round(ms[m - 1] - ms[m - 6]) if ms else 0,
                }
                if r['margin']['chg5pct'] >= 10:
                    r['flags'].append('融資 5 日增 %.1f%%' % r['margin']['chg5pct'])
                if r['margin']['chg5pct'] <= -10:
                    r['flags'].append('融資 5 日減 %.1f%%' % r['margin']['chg5pct'])
                if ms and mb[m - 1] and ms[m - 1] / mb[m - 1] >= 0.25:
                    r['flags'].append('券資比 %.0f%%' % (ms[m - 1] / mb[m - 1] * 100))
                if ms and r['margin']['shortChg5'] > 0 and mb[m - 6] and \
                        r['margin']['shortChg5'] >= max(300, ms[m - 6] * 0.5):
                    r['flags'].append('融券 5 日暴增 %+d 張' % r['margin']['shortChg5'])

        # 集保大戶 / 散戶
        s = sh['stocks'].get(code)
        if s:
            ratio, sdates = s['ratio'], s['dates']
            cur = ratio[-1]
            p4 = ratio[-5] if len(ratio) >= 5 else ratio[0]
            p12 = ratio[-13] if len(ratio) >= 13 else ratio[0]
            big = lambda row: sum(row[9:])      # 100 張以上
            vbig = lambda row: sum(row[10:])    # 200 張以上
            ret = lambda row: sum(row[0:3])     # 10 張以下
            r['holder'] = {
                'date': sdates[-1],
                'big100': round(big(cur), 2),
                'big100_chg1w': round(big(cur) - big(ratio[-2]), 2) if len(ratio) >= 2 else 0,
                'big100_chg4w': round(big(cur) - big(p4), 2),
                'big100_chg12w': round(big(cur) - big(p12), 2),
                'big200': round(vbig(cur), 2),
                'big200_chg4w': round(vbig(cur) - vbig(p4), 2),
                'retail': round(ret(cur), 2),
                'retail_chg4w': round(ret(cur) - ret(p4), 2),
            }
            if r['holder']['big100_chg4w'] >= 1.0:
                r['flags'].append('大戶(100張+) 4 週 +%.2f%%' % r['holder']['big100_chg4w'])
            if r['holder']['big100_chg4w'] <= -1.0:
                r['flags'].append('大戶(100張+) 4 週 %.2f%%' % r['holder']['big100_chg4w'])

        # 對應 CB
        cbs = []
        for cbcode in sorted(cb_by_stock.get(code, [])):
            cv, cc = CB.get((cbcode, '成交量(張)')), CB.get((cbcode, '收盤價'))
            if not cv or not cc:
                continue
            m = trim_zero_tail([cv, cc], len(cb_dates))
            if m < 5:
                continue
            cvv, ccc = cv[:m], cc[:m]
            base = sum(cvv[-61:-1]) / 60 if m >= 61 else sum(cvv[:-1]) / max(m - 1, 1)
            item = {
                'cbCode': cbcode, 'cbName': cb_names.get(cbcode, ''), 'date': cb_dates[m - 1],
                'vol': round(cvv[-1]), 'volMA60': round(base, 1),
                'ratio': round(cvv[-1] / base, 2) if base else None,
                'vol5': round(sum(cvv[-5:])),
                'close': ccc[-1],
                'chg5': round(pct(ccc[-1], ccc[-6]), 2) if m >= 6 and ccc[-6] else 0,
                'chg20': round(pct(ccc[-1], ccc[-21]), 2) if m >= 21 and ccc[-21] else 0,
            }
            fi_ = CBI.get((cbcode, '外資買賣超'))
            if fi_:
                mm = trim_zero_tail([fi_], len(cbi_dates))
                item['cbForeign5'] = round(sum(fi_[max(mm - 5, 0):mm]))
                item['cbForeign20'] = round(sum(fi_[max(mm - 20, 0):mm]))
            cbs.append(item)
            if base and cvv[-1] >= max(base * 3, 30):
                r['flags'].append('CB %s 爆量 %.0f 張 (%.1fx)' % (cbcode, cvv[-1], item['ratio']))
            elif base and sum(cvv[-5:]) >= max(base * 5 * 2.5, 100):
                r['flags'].append('CB %s 近 5 日累量 %.0f 張放大' % (cbcode, sum(cvv[-5:])))
        r['cbs'] = cbs
        results.append(r)
    return results


def read_csv_codes(path):
    with open(path, encoding='utf-8-sig') as f:
        return [row['代碼'].strip() for row in csv.DictReader(f) if row.get('代碼', '').strip()]


def main():
    args = sys.argv[1:]
    if args and args[0] == '--csv':
        codes = read_csv_codes(args[1])
    elif args and args[0] == '--file':
        codes = open(args[1], encoding='utf-8').read().split()
    else:
        codes = args
    codes = [c.strip() for c in codes if c.strip()]
    if not codes:
        print('usage: holdings_review.py <code>... | --csv file.csv | --file codes.txt')
        return

    res = analyze(codes)
    os.makedirs(os.path.join(BASE, 'scripts', 'output'), exist_ok=True)
    out = os.path.join(BASE, 'scripts', 'output', 'holdings_review.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, indent=1)

    for r in res:
        if not r.get('ok'):
            print('%s %s — %s' % (r['code'], r['name'], r.get('note')))
            continue
        print('%s %s 收%.2f (%+.1f%%/1D %+.1f%%/5D %+.1f%%/20D) 量%d張 %.2fx 位階%.0f%%'
              % (r['code'], r['name'], r['close'], r['chg1'], r['chg5'], r['chg20'],
                 r['vol'], r['volRatio'], r['posIn60']))
        if r['flags']:
            print('   * ' + ' | '.join(r['flags']))
    print('\n-> ' + out)


if __name__ == '__main__':
    main()
