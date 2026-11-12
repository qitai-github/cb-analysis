# -*- coding: utf-8 -*-
"""補跑歷史日報/週報用:環境變數 CB_ASOF=YYYYMMDD 時,把 data/*.json 截到該日(含)為止。

沒設 CB_ASOF 時所有函式原樣回傳,不影響每日排程。
用法:  CB_ASOF=20261109 PYTHONUTF8=1 python scripts/daily_cb_scan.py
"""
import os


def asof():
    v = (os.environ.get('CB_ASOF') or '').strip().replace('-', '')
    return v or None


def _is_date(x):
    s = str(x)
    return len(s) == 8 and s.isdigit()


def _cut_table(rows, d):
    """[代號,名稱,類別,...日期] 表:丟掉 > d 的日期欄"""
    hdr = rows[0]
    keep = [i for i, h in enumerate(hdr) if i < 3 or not _is_date(h) or str(h) <= d]
    if len(keep) == len(hdr):
        return rows
    return [[r[i] for i in keep if i < len(r)] for r in rows]


def apply(name, obj):
    d = asof()
    if not d or obj is None:
        return obj
    base = os.path.basename(name)
    if base == 'all-data.json':
        for k, v in list(obj.items()):
            if isinstance(v, list) and v and isinstance(v[0], list) and len(v[0]) > 3 \
                    and any(_is_date(h) for h in v[0][3:]):
                obj[k] = _cut_table(v, d)
    elif base == 'shareholding.json':
        for s in obj.get('stocks', {}).values():
            n = sum(1 for x in s['dates'] if str(x) <= d)
            for k in list(s):
                if isinstance(s[k], list) and len(s[k]) == len(s['dates']):
                    s[k] = s[k][:n]
            s['dates'] = s['dates'][:n]
    elif base == 'sector_flow.json':
        n = sum(1 for x in obj.get('dates', []) if str(x) <= d)
        L = len(obj.get('dates', []))
        obj['dates'] = obj['dates'][:n]
        if isinstance(obj.get('market_amt'), list) and len(obj['market_amt']) == L:
            obj['market_amt'] = obj['market_amt'][:n]
        for g in obj.get('groups') or []:
            for k, v in list(g.items()):
                if isinstance(v, list) and len(v) == L:
                    g[k] = v[:n]
        sd = obj.get('sdates') or []
        m = sum(1 for x in sd if str(x) <= d)
        obj['sdates'] = sd[:m]
        for code, arrs in (obj.get('stk') or {}).items():
            obj['stk'][code] = [a[:m] if isinstance(a, list) and len(a) == len(sd) else a for a in arrs]
    return obj
