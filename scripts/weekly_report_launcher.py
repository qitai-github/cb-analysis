#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""週報.exe 的啟動器 —— 雙擊即可跑完「正向訊號榜」週報整個流程並上傳網頁。

流程全部交給既有的 scripts/schedule/weekly_universe.py(工作排程器每週六 14:00
也跑這支腳本，這個 exe 只是方便手動雙擊)：
  1. git 同步 data/ 到最新
  2. positive_scan.py —— 全市場有 CB 的個股 12 項正向條件評分
  3. build_positive_report.py —— 產表格片段
  4. 交給 claude -p(headless，見 scripts/schedule/prompt_universe.md)：跟上一份
     週報做逐檔追蹤、**把完整報告 HTML 存到 reports/weekly/<日期>.html**(不用 Artifact)、
     把評論(含該頁網址 artifactUrl)寫進 data/signal_rank.json、commit + push

跟 券商進出.exe / 日報.exe 用同一種打包方式:exe 只是啟動器，實際呼叫 scripts/
內的 Python，所以 exe 必須留在專案根目錄(跟 scripts/、data/ 同一層)。

跟日報不同：週報要多存一份完整報告頁 reports/weekly/<日期>.html，並把網址寫進評論的
artifactUrl(網頁「看完整報告」按鈕的唯一來源)；claude -p 沒跑完就不會 push，
網頁週報分頁不會被半吊子的資料覆蓋。失敗時請看 scripts/output/schedule_universe.log 或直接重新
雙擊一次。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

if getattr(sys, "frozen", False):
    ROOT = Path(sys.executable).resolve().parent
else:
    ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts" if (ROOT / "scripts").exists() else Path(__file__).resolve().parent


def find_python() -> str:
    import shutil
    for cand in (os.environ.get("BROKER_PYTHON"), shutil.which("python"), r"C:\Python314\python.exe"):
        if cand and Path(cand).exists():
            return cand
    raise SystemExit("找不到 Python,請安裝 Python 或設定環境變數 BROKER_PYTHON")


def main():
    py = find_python()
    print("=" * 60)
    print(" 正向訊號榜 週報 一鍵產生 + 上傳")
    print("=" * 60)
    print("會呼叫 claude -p 分析、產生 reports/weekly 完整報告頁,預計 10~30 分鐘,請不要關閉本視窗。\n")
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    r = subprocess.run([py, "-u", str(SCRIPTS / "schedule" / "weekly_universe.py")],
                       cwd=str(ROOT), env=env)
    print()
    if r.returncode == 0:
        print("完成。網頁「CB 分析」→「週報」分頁已更新,細節見上面 claude 的輸出"
              "(或 scripts\\output\\schedule_universe.log)。")
    else:
        print("[失敗] 請檢查上面的錯誤訊息,或稍後單獨執行 "
              "scripts\\schedule\\weekly_universe.py")
    input("按 Enter 關閉視窗...")


if __name__ == "__main__":
    main()
