# -*- coding: utf-8 -*-
"""每日 22:00 持股清單體檢 — 排程進入點

流程:
  1. (週一~五) gh workflow run margin-late.yml,等它跑完 → 確保當日融資融券已入庫
  2. git pull --ff-only 取得 GHA 推的最新 data/*.json
  3. 找最新的 持股清單/CB篩選結果_*.csv,跑 holdings_review.py
  4. 產表格片段,交給 claude -p 寫報告 + 發佈 Artifact

單獨測試: PYTHONUTF8=1 python scripts/schedule/daily_holdings.py --no-claude
"""
import glob
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(BASE, 'scripts', 'output')
LOG = os.path.join(OUT, 'schedule_holdings.log')
REPO_SLUG = 'qitai-github/cb-analysis'
WORKFLOW = 'margin-late.yml'
WATCH_TIMEOUT = 25 * 60          # gh run watch 最長等 25 分鐘


def log(msg):
    line = '[%s] %s' % (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), msg)
    print(line, flush=True)
    os.makedirs(OUT, exist_ok=True)
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(line + '\n')


def run(cmd, timeout=600, check=False):
    """執行外部指令,回傳 (returncode, stdout+stderr)"""
    try:
        p = subprocess.run(cmd, cwd=BASE, capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=timeout)
    except subprocess.TimeoutExpired:
        log('TIMEOUT: %s' % ' '.join(cmd))
        return 124, 'timeout'
    except FileNotFoundError:
        log('NOT FOUND: %s' % cmd[0])
        return 127, 'not found'
    out = (p.stdout or '') + (p.stderr or '')
    if p.returncode != 0:
        log('  exit=%d %s' % (p.returncode, out.strip()[:400]))
        if check:
            raise SystemExit(p.returncode)
    return p.returncode, out


def trigger_margin_late():
    """觸發 Margin Late 並等它結束。回傳狀態字串(寫進報告的資料註記)"""
    if datetime.now().weekday() >= 5:
        log('週末,不觸發 Margin Late(無交易資料)')
        return 'weekend-skipped'

    rc, out = run(['gh', 'auth', 'status'], timeout=60)
    if rc != 0:
        log('gh 未登入,跳過觸發;改用 workflow 自己的 21:10 cron 結果')
        return 'gh-not-authenticated'

    before = latest_run_id()
    log('觸發 %s ...' % WORKFLOW)
    rc, out = run(['gh', 'workflow', 'run', WORKFLOW, '--repo', REPO_SLUG], timeout=120)
    if rc != 0:
        return 'dispatch-failed'

    # 等新的 run 出現(GitHub 排隊約需數秒)
    run_id = None
    for _ in range(20):
        time.sleep(6)
        rid = latest_run_id()
        if rid and rid != before:
            run_id = rid
            break
    if not run_id:
        log('等不到新的 run id,略過等待直接往下走')
        return 'run-not-found'

    log('等待 run %s 完成...' % run_id)
    rc, out = run(['gh', 'run', 'watch', str(run_id), '--repo', REPO_SLUG,
                   '--exit-status', '--interval', '20'], timeout=WATCH_TIMEOUT)
    log('run %s 結束,exit=%d' % (run_id, rc))
    return 'ok' if rc == 0 else 'workflow-failed'


def latest_run_id():
    rc, out = run(['gh', 'run', 'list', '--workflow', WORKFLOW, '--repo', REPO_SLUG,
                   '--limit', '1', '--json', 'databaseId'], timeout=90)
    if rc != 0:
        return None
    try:
        data = json.loads(out.strip().splitlines()[-1])
        return data[0]['databaseId'] if data else None
    except Exception:
        return None


def latest_csv():
    files = glob.glob(os.path.join(BASE, '持股清單', 'CB篩選結果_*.csv'))
    if not files:
        return None
    def datekey(p):
        m = re.search(r'(\d{8})', os.path.basename(p))
        return m.group(1) if m else '00000000'
    return max(files, key=datekey)


def main():
    no_claude = '--no-claude' in sys.argv
    log('===== 每日持股體檢開始 =====')

    margin_status = trigger_margin_late()
    log('Margin Late 狀態: %s' % margin_status)

    log('git pull ...')
    run(['git', 'pull', '--ff-only'], timeout=600)

    csv = latest_csv()
    if not csv:
        log('找不到 持股清單/CB篩選結果_*.csv,中止')
        raise SystemExit(1)
    csv_date = re.search(r'(\d{8})', os.path.basename(csv)).group(1)
    today = datetime.now().strftime('%Y%m%d')
    if csv_date != today:
        log('注意:最新清單是 %s,不是今天 %s(仍用它繼續)' % (csv_date, today))

    env = dict(os.environ, PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
    log('掃描持股清單 %s' % os.path.basename(csv))
    p = subprocess.run([sys.executable, os.path.join('scripts', 'holdings_review.py'),
                        '--csv', csv], cwd=BASE, env=env, capture_output=True,
                       text=True, encoding='utf-8', errors='replace', timeout=1800)
    log(p.stdout.strip()[-3000:] if p.stdout else '(無輸出)')
    if p.returncode != 0:
        log('holdings_review 失敗: %s' % (p.stderr or '')[-800:])
        raise SystemExit(1)

    # 預設排序/分級檔:先照 CSV 順序、全部 calm,交給 claude 依訊號重寫
    data = json.load(open(os.path.join(OUT, 'holdings_review.json'), encoding='utf-8'))
    with open(os.path.join(OUT, 'holdings_order.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(r['code'] for r in data) + '\n')
    with open(os.path.join(OUT, 'holdings_sev.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join('%s calm' % r['code'] for r in data) + '\n')

    with open(os.path.join(OUT, 'margin_status.txt'), 'w', encoding='utf-8') as f:
        f.write(margin_status + '\n' + csv_date + '\n')

    if no_claude:
        log('--no-claude,到此為止')
        return

    log('交給 claude 產報告 ...')
    prompt = os.path.join(BASE, 'scripts', 'schedule', 'prompt_holdings.md')
    with open(prompt, encoding='utf-8') as f:
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
