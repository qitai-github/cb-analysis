# -*- coding: utf-8 -*-
"""全網頁正向訊號榜 — 進入點(工作排程器「CB週報_週六14點」每週六 14:00 經 run_universe.cmd 執行,也可由 週報.exe 手動觸發)

流程:
  0. 觸發 GitHub Actions「TDCC Shareholding Weekly」並等它跑完(--no-tdcc 可跳過)
  1. 同步 data/ 到 origin/main 最新版(見 sync_data())
  2. positive_scan.py 掃全部有 CB 的個股 → positive_scan.json + 當日快照
  3. build_positive_report.py 產表格片段
  4. 交給 claude -p 寫報告(含與上一份快照的追蹤),存 reports/weekly/<日期>.html 並 push

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
from lib import notify  # noqa: E402


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


def git(args, timeout=600):
    p = subprocess.run(['git'] + args, cwd=BASE, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=timeout)
    return p.returncode, (p.stdout or '') + (p.stderr or '')


def sync_data():
    """把 data/ 目錄同步到 origin/main 最新版本,不管目前簽出哪個分支。

    2026-09-07 發生過:本機停留在一個已合併進 main 的舊功能分支上,
    `git pull --ff-only` 只更新那個分支自己的追蹤,完全抓不到 GHA
    每天推到 main 的 data/*.json。這裡改成:在 main 上就正常 pull;
    不在 main 上就只把 data/ 目錄簽出成 origin/main 的版本,不動其他
    檔案、不切換分支,避免影響其他分支上可能還在進行的工作。
    """
    git(['fetch', 'origin', 'main'], timeout=120)
    _, branch = git(['branch', '--show-current'], timeout=30)
    branch = branch.strip()
    if branch == 'main':
        git(['pull', '--ff-only'], timeout=600)
        return
    log('注意:目前不在 main 分支(現為 "%s"),只把 data/ 同步到 origin/main 最新版,不切換分支' % branch)
    rc, out = git(['checkout', 'origin/main', '--', 'data/'], timeout=120)
    if rc != 0:
        log('data/ 同步失敗,後續分析可能用到舊資料: %s' % out[:400])


def main():
    no_claude = '--no-claude' in sys.argv
    log('===== 每週正向訊號榜開始 =====')

    if '--no-tdcc' not in sys.argv:
        # 集保股權分散表要先更新,同步下來的 data/shareholding.json 才是本週最新
        from gha_dispatch import dispatch_and_wait
        dispatch_and_wait('tdcc-shareholding.yml', 'TDCC Shareholding Weekly', timeout=1200, log=log)

    log('同步 data/ ...')
    sync_data()

    # 對照基準永遠是「上一份週報」,不是檔案系統上最新的快照
    # (中途若有人臨時跑 positive_scan.py,那份快照不算數,除非它也被記錄成週報)
    today = datetime.now().strftime('%Y%m%d')
    prev_date = WS.previous_report_date(today)
    prev = WS.snapshot_path(prev_date) if prev_date else None
    log('上一份週報快照: %s' % (os.path.basename(prev) if prev else '(無,帳本是空的)'))

    if sh([sys.executable, os.path.join('scripts', 'positive_scan.py'), '--min', '70']) != 0:
        log('positive_scan 失敗,中止')
        notify.alert('週報失敗:positive_scan 掃描失敗', '詳見 scripts/output/schedule_universe.log')
        raise SystemExit(1)

    snap = os.path.join(OUT, 'positive_scan_%s.json' % today)
    shutil.copy(os.path.join(OUT, 'positive_scan.json'), snap)
    log('快照存檔 %s' % os.path.basename(snap))
    WS.record(today)
    log('已登記為本次週報快照(scripts/output/weekly_snapshots.txt)')

    # weekly_diff 預設讀這個檔決定上一份週報快照,所以要先寫、再算差異
    with open(os.path.join(OUT, 'universe_prev_snapshot.txt'), 'w', encoding='utf-8') as f:
        f.write((os.path.basename(prev) if prev else '') + '\n')

    sh([sys.executable, os.path.join('scripts', 'build_positive_report.py')])
    # 升級/降級/新進/掉榜(含原因)、點名後追蹤、族群共振、盤下鎖碼 — 由腳本算好,claude 只引用不重算
    if sh([sys.executable, os.path.join('scripts', 'weekly_diff.py')]) != 0:
        log('weekly_diff 失敗(claude 將無權威差異表可引用)')
        notify.alert('週報警告:weekly_diff 失敗', '評論可能沒有權威的「與上次比較」資料,請檢查後重跑')

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
    problems = post_check(today, p.returncode)
    if problems:
        log('週報產出檢查未通過: ' + ' / '.join(problems))
        notify.alert('週報未完整發佈 %s' % today, '\n'.join('- ' + x for x in problems)
                     + '\n可重新雙擊 週報.exe,或看 scripts/output/schedule_universe.log')
    else:
        log('週報產出檢查通過(signal_rank.json、reports/weekly 頁面、評論對帳)')
    log('===== 完成 =====')


def post_check(today, rc):
    """claude 跑完後的驗收:沒做到就回傳問題清單(呼叫端會 Telegram 告警)"""
    problems = []
    if rc != 0:
        problems.append('claude -p 回傳非 0(%s)' % rc)
    try:
        d = json.load(open(os.path.join(BASE, 'data', 'signal_rank.json'), encoding='utf-8'))
        rep = d.get('report') or {}
        rdate = (rep.get('date') or '').replace('-', '')
        if not rep:
            problems.append('data/signal_rank.json 沒有附評論')
        elif not rdate or rdate > today or (datetime.strptime(today, '%Y%m%d')
                                            - datetime.strptime(rdate, '%Y%m%d')).days > 3:
            problems.append('評論日期 %s 看起來不是這次(今天 %s)' % (rdate or '空', today))
        url = rep.get('artifactUrl') or ''
        if not url:
            problems.append('artifactUrl 是空的(網頁看不到「看完整報告」)')
        elif not os.path.exists(os.path.join(BASE, 'reports', 'weekly', os.path.basename(url))):
            problems.append('完整報告頁不存在: reports/weekly/%s' % os.path.basename(url))
    except Exception as e:
        problems.append('讀 data/signal_rank.json 失敗: %s' % e)
    # 還有沒 push 的變動 → claude 沒推完
    _, st = git(['status', '--porcelain', '--', 'data/signal_rank.json', 'data/signal_rank_history',
                 'reports/weekly'], timeout=60)
    if st.strip():
        problems.append('還有未 commit/push 的週報檔案')
    # 評論數字對帳(ERROR = 文字引用了不符資料的分數/名單)
    v = subprocess.run([sys.executable, os.path.join(BASE, 'scripts', 'verify_commentary.py'), 'weekly'],
                       cwd=BASE, capture_output=True, text=True, encoding='utf-8', errors='replace',
                       env=dict(os.environ, PYTHONUTF8='1'))
    if v.returncode != 0:
        problems.append('評論對帳有誤: ' + ' | '.join(l for l in v.stdout.splitlines()
                                                    if l.startswith('ERROR'))[:400])
    return problems


if __name__ == '__main__':
    main()
