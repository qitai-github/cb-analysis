#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CB 日報一鍵產生 + 跑評論 + 上傳網頁。

流程:
  1. git 同步 data/ 到 origin/main 最新版(在 main 上 pull;不在 main 只簽出 data/)。
  2. scripts/daily_cb_scan.py —— CB 當日漲幅/量能前 N 檔 + 對應個股技術面/籌碼面/券商分點。
  3. 呼叫 `claude -p`(headless,見 scripts/schedule/prompt_daily.md)分析今天的
     daily_cb_scan.json,寫 scripts/output/daily_commentary.json(今天日期),
     ——它自己會做第 4、5 步(build json + push),所以這步成功的話流程就結束了。
     這步會被跳過或失敗時(找不到 claude CLI、逾時、拒絕執行),不擋住下面的數字上傳,
     只是網頁「日報」分頁這次不會有文字評論。
  4. (claude 沒跑或跑失敗時的備援) scripts/build_daily_cb_rank_json.py —— 轉成
     data/daily_cb_rank.json(+ 歸檔往期)。scripts/output/daily_commentary.json 存在
     且日期對得上才會附評論。
  5. (備援) git fetch + ff-only 對齊遠端,只 add data/daily_cb_rank.json 與
     data/daily_cb_rank_history/,commit + push。跟 all-data.json 撞車(GHA 常常在推)
     時最多重試 3 次。

用法: PYTHONUTF8=1 python scripts/publish_daily_report.py [--top 100] [--no-push] [--no-claude]
"""
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
ENV = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
CLAUDE_TIMEOUT = 1800  # 秒;比週報短,日報分析量小很多


def run(cmd, **kw):
    return subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True,
                          encoding="utf-8", errors="replace", **kw)


def git_sync():
    print("[1/5] 同步 data/ 到最新...", flush=True)
    f = run(["git", "fetch", "origin", "main"], timeout=120)
    if f.returncode != 0:
        print("  [警告] git fetch 失敗,沿用本機現有資料:", f.stderr.strip()[-300:])
        return
    branch = run(["git", "branch", "--show-current"], timeout=30).stdout.strip()
    if branch == "main":
        r = run(["git", "pull", "--ff-only"], timeout=600)
    else:
        print(f"  目前在分支 \"{branch}\",只同步 data/ 到 origin/main 最新版")
        r = run(["git", "checkout", "origin/main", "--", "data/"], timeout=120)
    if r.returncode != 0:
        print("  [警告] 同步失敗,沿用本機現有資料:", (r.stderr.strip() or r.stdout.strip())[-300:])
    else:
        print("  " + ((r.stdout.strip() or "已是最新").splitlines()[-1]))


def run_step(label, args):
    print(f"\n{label}...", flush=True)
    r = subprocess.run([sys.executable, *args], cwd=str(ROOT), capture_output=True,
                       text=True, encoding="utf-8", errors="replace", env=ENV)
    if r.stdout.strip():
        print("  " + r.stdout.strip().replace("\n", "\n  "))
    if r.returncode != 0:
        print("  [失敗]", (r.stderr.strip() or "?")[-800:])
        return False
    return True


def run_claude_commentary():
    """呼叫 `claude -p` 分析今天的掃描結果、寫評論、build json、commit+push 一次做完
    (見 prompt_daily.md)。回傳 True 表示這步已經把整個流程(含 push)跑完,外層不用再做。
    找不到 claude CLI、逾時、或它自己失敗,都回傳 False,交給外層的備援(純數字上傳)接手。
    """
    print("\n[3/5] 呼叫 claude -p 分析並寫評論...", flush=True)
    if not shutil.which("claude"):
        print("  找不到 claude CLI,跳過評論,只上傳數字。")
        return False
    prompt_path = SCRIPTS / "schedule" / "prompt_daily.md"
    if not prompt_path.exists():
        print("  找不到 prompt_daily.md,跳過評論。")
        return False
    text = prompt_path.read_text(encoding="utf-8")
    try:
        p = subprocess.run(["claude", "-p", "--permission-mode", "bypassPermissions", "--model", "opus"],
                           cwd=str(ROOT), input=text, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=CLAUDE_TIMEOUT)
    except subprocess.TimeoutExpired:
        print(f"  [警告] claude -p 超過 {CLAUDE_TIMEOUT}s 沒結束,跳過評論,只上傳數字。")
        return False
    except Exception as e:
        print(f"  [警告] claude -p 執行失敗({e}),跳過評論,只上傳數字。")
        return False
    if p.stdout.strip():
        print("  " + p.stdout.strip()[-3000:].replace("\n", "\n  "))
    if p.returncode != 0:
        print("  [警告] claude -p 回傳非 0({}),跳過評論,只上傳數字。".format(p.returncode))
        if p.stderr.strip():
            print("  " + p.stderr.strip()[-500:])
        return False
    # claude 應該已經自己 build + push 了;驗證兩件事,任一不成立就交給外層備援補跑:
    #   ① data/daily_cb_rank.json 的 _meta.date 真的是今天掃描的日期(不是它半途放棄、
    #      沒重新 build,舊檔案還留在那)
    #   ② 沒有未 commit/push 的殘留變動
    import json
    try:
        scan_date = json.loads((SCRIPTS / "output" / "daily_cb_scan.json").read_text(encoding="utf-8"))["date"]
        rank_date = json.loads((ROOT / "data" / "daily_cb_rank.json").read_text(encoding="utf-8"))["_meta"]["date"]
    except Exception as e:
        print(f"  [警告] 驗證 claude 產出時讀檔失敗({e}),交給備援流程處理。")
        return False
    if rank_date != scan_date:
        print(f"  claude 沒有把 data/daily_cb_rank.json 更新到今天的日期({rank_date} != {scan_date}),交給備援流程處理。")
        return False
    diff = run(["git", "status", "--porcelain", "--", "data/daily_cb_rank.json", "data/daily_cb_rank_history"])
    if diff.stdout.strip():
        print("  claude 執行完但還有未 push 的變動,交給備援流程處理。")
        return False
    print("  claude 已完成評論 + 上傳。")
    return True


def push_data():
    print("\n[備援] 上傳網頁資料 (git add/commit/push)...", flush=True)
    for attempt in range(1, 4):
        f = run(["git", "fetch", "origin", "main"])
        if f.returncode != 0:
            print("  [失敗] git fetch:", f.stderr.strip()[-300:])
            return False
        m = run(["git", "merge", "--ff-only", "origin/main"])
        if m.returncode != 0:
            print("  [失敗] 無法快轉到遠端最新版(本機有未提交的修改跟遠端撞到?):",
                  (m.stderr.strip() or m.stdout.strip())[-300:])
            return False
        run(["git", "add", "-A", "data/daily_cb_rank.json", "data/daily_cb_rank_history"])
        if run(["git", "diff", "--cached", "--quiet", "--", "data/daily_cb_rank.json",
                "data/daily_cb_rank_history"]).returncode == 0:
            print("  網頁資料沒有變動,不需 push。")
            return True
        c = run(["git", "commit", "-m", f"data: CB 日報 @ {datetime.now():%Y-%m-%d %H:%M}",
                 "--", "data/daily_cb_rank.json", "data/daily_cb_rank_history"])
        if c.returncode != 0:
            print("  [失敗] commit:", c.stderr.strip()[-300:])
            return False
        p = run(["git", "push", "origin", "HEAD:main"])
        if p.returncode == 0:
            print("  已 push,網頁「日報」分頁資料更新完成。")
            return True
        run(["git", "reset", "--soft", "HEAD~1"])  # 被搶先推了 → 撤掉本次 commit,重新對齊再來
        print(f"  push 撞車,重試第 {attempt} 次...")
    print("  [失敗] git push 多次失敗,請稍後單獨執行 scripts\\publish_daily_report.py")
    return False


def main():
    top = "100"
    if "--top" in sys.argv:
        top = sys.argv[sys.argv.index("--top") + 1]
    no_push = "--no-push" in sys.argv
    no_claude = "--no-claude" in sys.argv

    git_sync()

    if not run_step("[2/5] 掃描 CB 漲幅/量能榜", ["scripts/daily_cb_scan.py", "--top", top]):
        print("\n中止:daily_cb_scan.py 失敗。")
        return 1

    if no_push:
        run_step("[3/5] 產生網頁資料 data/daily_cb_rank.json", ["scripts/build_daily_cb_rank_json.py"])
        print("\n--no-push,不上傳,到此為止。")
        return 0

    if not no_claude and run_claude_commentary():
        return 0   # claude 自己已經 build + push 完了

    # 備援:claude 沒跑、失敗、或 --no-claude —— 至少把數字資料上傳,不能讓評論步驟卡住整個流程
    if not run_step("[4/5] 產生網頁資料 data/daily_cb_rank.json", ["scripts/build_daily_cb_rank_json.py"]):
        print("\n中止:build_daily_cb_rank_json.py 失敗。")
        return 1
    return 0 if push_data() else 1


if __name__ == "__main__":
    sys.exit(main())
