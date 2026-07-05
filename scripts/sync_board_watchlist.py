#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
sync_board_watchlist.py — CB 日曆「董事會公告」個股 → Supabase「芭樂報告待跑」自動化

規則:
  讀 data/all-data.json 的 cbasCalendar.events,取 type=='board'(董事會公告)。
  股號 = cbCode 前 4 碼。對於「新出現(cbCode 未記錄於狀態檔)」的董事會公告:
    若該股 (a) 網頁尚無報告(不在 data/company_reports.json)
         且 (b) 不在 Supabase「芭樂報告待跑」
         且 (c) 不在 Supabase「芭樂報告完成」
    → 加入「芭樂報告待跑」。
  無論是否加入,該 cbCode 一律記入狀態檔 data/board_watchlist_state.json,
  故使用者事後手動從待跑移除的個股,不會因隔天再跑而被重新加入。
  新的 CB 期別(新 cbCode)仍會被視為新事件重新評估。

用法:
  python sync_board_watchlist.py            # 實跑
  python sync_board_watchlist.py --dry-run  # 只印不寫

環境變數 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY;本機可放 scripts/.env。
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
ALL_DATA = DATA / "all-data.json"
REPORT_INDEX = DATA / "company_reports.json"
STATE = DATA / "board_watchlist_state.json"

PEND = "芭樂報告待跑"
DONE = "芭樂報告完成"


def load_env():
    envf = HERE / ".env"
    if envf.exists():
        for line in envf.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("缺 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
    return url.rstrip("/"), key


def sb_get_codes(url, key, list_name):
    h = {"apikey": key, "Authorization": "Bearer " + key}
    q = url + "/rest/v1/public_watchlist?select=code&list_name=eq." + urllib.parse.quote(list_name)
    req = urllib.request.Request(q, headers=h)
    rows = json.loads(urllib.request.urlopen(req, timeout=60).read().decode())
    return set(str(r["code"]) for r in rows)


def sb_insert(url, key, list_name, codes):
    h = {"apikey": key, "Authorization": "Bearer " + key,
         "Content-Type": "application/json", "Prefer": "return=minimal"}
    payload = json.dumps([{"code": c, "list_name": list_name} for c in codes]).encode("utf-8")
    req = urllib.request.Request(url + "/rest/v1/public_watchlist", data=payload, headers=h, method="POST")
    return urllib.request.urlopen(req, timeout=60).status


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="只印不寫入 Supabase/狀態檔")
    args = ap.parse_args(argv)

    url, key = load_env()

    all_data = json.loads(ALL_DATA.read_text(encoding="utf-8"))
    events = ((all_data.get("cbasCalendar") or {}).get("events")) or []
    board = [e for e in events if e.get("type") == "board" and e.get("cbCode")]

    report_codes = set()
    if REPORT_INDEX.exists():
        idx = json.loads(REPORT_INDEX.read_text(encoding="utf-8"))
        report_codes = set(str(c) for c in (idx.get("stocks") or {}).keys())

    state = {"processed_cbcodes": []}
    if STATE.exists():
        try:
            state = json.loads(STATE.read_text(encoding="utf-8"))
        except Exception:
            pass
    processed = set(str(x) for x in state.get("processed_cbcodes", []))

    new_events = [e for e in board if str(e["cbCode"]) not in processed]
    print(f"董事會公告事件 {len(board)} 筆;其中新出現(未處理) {len(new_events)} 筆")

    pend = sb_get_codes(url, key, PEND)
    done = sb_get_codes(url, key, DONE)

    to_add = []
    seen = set()
    for e in sorted(new_events, key=lambda x: x.get("date", "")):
        code = str(e["cbCode"])[:4]
        if code in seen:
            continue
        reason = None
        if code in report_codes:
            reason = "已有報告"
        elif code in pend:
            reason = "已在待跑"
        elif code in done:
            reason = "已在完成"
        if reason:
            print(f"  跳過 {code} ({e.get('cbName','')}) — {reason}")
        else:
            to_add.append(code)
            seen.add(code)
            print(f"  ➕ 加入待跑 {code} ({e.get('cbName','')}, {e.get('date','')})")

    print(f"\n本次新增待跑: {len(to_add)} 檔 {to_add}")

    if args.dry_run:
        print("[dry-run] 不寫入 Supabase / 狀態檔")
        return 0

    if to_add:
        st = sb_insert(url, key, PEND, to_add)
        print(f"INSERT 待跑 status={st}")

    # 記錄所有新 cbCode(含跳過者),避免日後重複評估 / 使用者移除後被重加
    processed |= set(str(e["cbCode"]) for e in new_events)
    STATE.write_text(json.dumps({"processed_cbcodes": sorted(processed)}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"狀態檔更新: {STATE.name} 共 {len(processed)} 個 cbCode")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
