#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CB 日報一鍵產生 + 上傳網頁。

流程:
  1. git 同步 data/ 到 origin/main 最新版(在 main 上 pull;不在 main 只簽出 data/)。
  2. scripts/daily_cb_scan.py —— CB 當日漲幅/量能前 N 檔 + 對應個股技術面/籌碼面/券商分點。
  3. scripts/build_daily_cb_rank_json.py —— 轉成 data/daily_cb_rank.json(+ 歸檔往期)。
     若 scripts/output/daily_commentary.json 存在就一併附上評論(不存在也能跑,只是網頁
     不顯示評論區塊 —— 要有文字評論請自己寫這個檔案,格式參考 signal_commentary.json)。
  4. git fetch + ff-only 對齊遠端,只 add data/daily_cb_rank.json 與 data/daily_cb_rank_history/,
     commit + push。跟 all-data.json 撞車(GHA 每天在推)時最多重試 3 次。

用法: PYTHONUTF8=1 python scripts/publish_daily_report.py [--top 100] [--no-push]
"""
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
ENV = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")


def run(cmd, **kw):
    return subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True,
                          encoding="utf-8", errors="replace", **kw)


def git_sync():
    print("[1/4] 同步 data/ 到最新...", flush=True)
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


def push_data():
    print("\n[4/4] 上傳網頁資料 (git add/commit/push)...", flush=True)
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

    git_sync()

    if not run_step("[2/4] 掃描 CB 漲幅/量能榜", ["scripts/daily_cb_scan.py", "--top", top]):
        print("\n中止:daily_cb_scan.py 失敗。")
        return 1
    if not run_step("[3/4] 產生網頁資料 data/daily_cb_rank.json", ["scripts/build_daily_cb_rank_json.py"]):
        print("\n中止:build_daily_cb_rank_json.py 失敗。")
        return 1

    if no_push:
        print("\n--no-push,不上傳,到此為止。")
        return 0
    return 0 if push_data() else 1


if __name__ == "__main__":
    sys.exit(main())
