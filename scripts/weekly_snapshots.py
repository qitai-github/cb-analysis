# -*- coding: utf-8 -*-
"""正向訊號榜「週報」快照分類帳 — scripts/output/weekly_snapshots.txt

問題:positive_scan.py 有時會被臨時呼叫(例如使用者要求「再跑一次全網頁掃描」),
這種 ad-hoc 快照不該被下一次「週報」拿來當對照基準,否則追蹤會比較到
不是上一份正式週報的資料。

做法:每次真正的「週報」(不論是週日 cron 還是使用者要求的手動執行)
產生快照後,把日期寫進這個純文字帳本(一行一個 YYYYMMDD,依時間序)。
下一次週報永遠讀這個帳本的最後一筆當「上一份週報」,不看檔案系統上
還有哪些 positive_scan_<日期>.json——那些可能是 ad-hoc 快照,不算數。
"""
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, 'scripts', 'output')
LEDGER = os.path.join(OUT, 'weekly_snapshots.txt')


def list_dates():
    """帳本裡所有日期,依時間序(舊→新)。"""
    if not os.path.exists(LEDGER):
        return []
    with open(LEDGER, encoding='utf-8') as f:
        return [ln.strip() for ln in f if ln.strip()]


def previous_report_date(today):
    """回傳帳本裡今天以前最後一筆日期,沒有就回 None。"""
    dates = [d for d in list_dates() if d < today]
    return dates[-1] if dates else None


def snapshot_path(date):
    return os.path.join(OUT, 'positive_scan_%s.json' % date)


def record(date):
    """把 date 標記為「這是一次正式週報」,附加進帳本(不重複)。"""
    dates = list_dates()
    if date in dates:
        return
    os.makedirs(OUT, exist_ok=True)
    with open(LEDGER, 'a', encoding='utf-8') as f:
        f.write(date + '\n')
