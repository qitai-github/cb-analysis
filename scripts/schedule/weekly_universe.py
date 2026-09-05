# -*- coding: utf-8 -*-
"""每週日 17:00 全網頁正向訊號榜 — 排程進入點

流程:
  1. git pull --ff-only
  2. positive_scan.py 掃全部有 CB 的個股 → positive_scan.json + 當日快照
  3. build_positive_report.py 產表格片段
  4. 交給 claude -p 寫報告(含與上一份快照的追蹤) + 發佈 Artifact

單獨測試: PYTHONUTF8=1 python scripts/schedule/weekly_universe.py --no-claude
"""
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(BASE, 'scripts', 'output')
LOG = os.path.join(OUT, 'schedule_universe.log')

sys.path.insert(0, os.path.join(BASE, 'scripts'))
import weekly_snapshots as WS  # noqa: E402


def log(msg):
    line = '[%s] %s' % (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), msg)
    print(line, flush=True)
    os.makedirs(OUT, exist_ok=True)
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(line + '\n')


def sh(args, timeout=1800):
    env = dict(os.environ, PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
    p = subprocess.run(args, cwd=BASE, env=env, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=timeout)
    if p.stdout:
        log(p.stdout.strip()[-3000:])
    if p.returncode != 0:
        log('exit=%d %s' % (p.returncode, (p.stderr or '')[-800:]))
    return p.returncode


def main():
    no_claude = '--no-claude' in sys.argv
    log('===== 每週正向訊號榜開始 =====')

    log('git pull ...')
    subprocess.run(['git', 'pull', '--ff-only'], cwd=BASE, capture_output=True,
                   text=True, encoding='utf-8', errors='replace', timeout=600)

    # 對照基準永遠是「上一份週報」,不是檔案系統上最新的快照
    # (中途若有人臨時跑 positive_scan.py,那份快照不算數,除非它也被記錄成週報)
    today = datetime.now().strftime('%Y%m%d')
    prev_date = WS.previous_report_date(today)
    prev = WS.snapshot_path(prev_date) if prev_date else None
    log('上一份週報快照: %s' % (os.path.basename(prev) if prev else '(無,帳本是空的)'))

    if sh([sys.executable, os.path.join('scripts', 'positive_scan.py'), '--min', '70']) != 0:
        log('positive_scan 失敗,中止')
        raise SystemExit(1)

    snap = os.path.join(OUT, 'positive_scan_%s.json' % today)
    shutil.copy(os.path.join(OUT, 'positive_scan.json'), snap)
    log('快照存檔 %s' % os.path.basename(snap))
    WS.record(today)
    log('已登記為本次週報快照(scripts/output/weekly_snapshots.txt)')

    sh([sys.executable, os.path.join('scripts', 'build_positive_report.py')])

    with open(os.path.join(OUT, 'universe_prev_snapshot.txt'), 'w', encoding='utf-8') as f:
        f.write((os.path.basename(prev) if prev else '') + '\n')

    if no_claude:
        log('--no-claude,到此為止')
        return

    log('交給 claude 產報告 ...')
    with open(os.path.join(BASE, 'scripts', 'schedule', 'prompt_universe.md'),
              encoding='utf-8') as f:
        text = f.read()
    p = subprocess.run(['claude', '-p', '--permission-mode', 'bypassPermissions',
                        '--model', 'opus'],
                       cwd=BASE, input=text, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=3600)
    log(('claude 輸出:\n' + (p.stdout or ''))[-4000:])
    if p.stderr:
        log('claude stderr: %s' % p.stderr[-1000:])
    log('===== 完成 =====')


if __name__ == '__main__':
    main()
