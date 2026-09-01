# -*- coding: utf-8 -*-
"""每週日 17:00 全網頁正向訊號榜 — 排程進入點

流程:
  1. git pull --ff-only
  2. positive_scan.py 掃全部有 CB 的個股 → positive_scan.json + 當日快照
  3. build_positive_report.py 產表格片段
  4. 交給 claude -p 寫報告(含與上一份快照的追蹤) + 發佈 Artifact

單獨測試: PYTHONUTF8=1 python scripts/schedule/weekly_universe.py --no-claude
"""
import glob
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(BASE, 'scripts', 'output')
LOG = os.path.join(OUT, 'schedule_universe.log')


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

    # 保留上一份快照供追蹤用
    snaps = sorted(glob.glob(os.path.join(OUT, 'positive_scan_2*.json')))
    prev = snaps[-1] if snaps else None
    log('上一份快照: %s' % (os.path.basename(prev) if prev else '(無)'))

    if sh([sys.executable, os.path.join('scripts', 'positive_scan.py'), '--min', '70']) != 0:
        log('positive_scan 失敗,中止')
        raise SystemExit(1)

    today = datetime.now().strftime('%Y%m%d')
    snap = os.path.join(OUT, 'positive_scan_%s.json' % today)
    shutil.copy(os.path.join(OUT, 'positive_scan.json'), snap)
    log('快照存檔 %s' % os.path.basename(snap))

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
