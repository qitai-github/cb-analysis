# -*- coding: utf-8 -*-
"""族群共振 — 日報/週報上榜的個股,在「細分板塊」(data/industry_chain/sectors.json,110 小分類)裡
是否同一族群多檔同時出現。同族群多檔同步上榜,比單檔孤立訊號更有參考價值。

附帶每個族群今日的成員漲跌中位數與近 5 日法人淨買(億元),來自 data/sector_flow.json 的 stk。

用法(程式內):
    from lib.sector_resonance import resonance
    rows = resonance(['2330', '3711', ...], min_hits=2)
"""
import json
import os
import statistics

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(BASE, 'data')


def _load(name):
    p = os.path.join(DATA, name)
    if not os.path.exists(p):
        return None
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def resonance(hit_codes, min_hits=2, top=10, names=None):
    """hit_codes: 上榜個股代號。回傳族群共振列表(依命中檔數、命中比例排序)。

    每筆:sector group hits(代號list) hitNames n(族群成員數) hitPct sectorPct(成員今日漲跌中位數%)
          net5(成員近 5 日法人淨買合計,億元) asOf
    """
    sec = _load('industry_chain/sectors.json')
    if not sec:
        return []
    sf = _load('sector_flow.json') or {}
    stk = sf.get('stk') or {}
    asof = (sf.get('sdates') or [''])[-1]
    g_of = {s: g for g, ss in (sec.get('groups') or {}).items() for s in ss}
    hit = {str(c) for c in hit_codes}

    out = []
    for sname, members in (sec.get('sectors') or {}).items():
        if '其他' in sname:          # 「半導體・其他」這類大雜燴板塊,命中沒有族群意義
            continue
        ms = [str(m) for m in members]
        hits = [m for m in ms if m in hit]
        if len(hits) < min_hits:
            continue
        pcts = [stk[m][1][-1] for m in ms if m in stk and stk[m][1]]
        nets = [sum(stk[m][2][-5:]) for m in ms if m in stk and stk[m][2]]
        out.append({
            'sector': sname, 'group': g_of.get(sname, ''),
            'hits': hits, 'hitNames': [names.get(h, h) for h in hits] if names else hits,
            'n': len(ms), 'hitPct': round(len(hits) / len(ms) * 100),
            'sectorPct': round(statistics.median(pcts), 2) if pcts else None,
            'net5': round(sum(nets), 1) if nets else None,
            'asOf': asof,
        })
    # 比例優先:小族群 3 檔中 2 檔上榜,比 100 檔大板塊裡 5 檔更有共振意義
    out.sort(key=lambda r: (-r['hitPct'], -len(r['hits'])))
    return out[:top]


def sector_of(code):
    """個股所屬細分板塊名稱列表。"""
    sec = _load('industry_chain/sectors.json') or {}
    return [s for s, ms in (sec.get('sectors') or {}).items() if str(code) in {str(m) for m in ms}]
