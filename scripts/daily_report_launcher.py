#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""日報.exe 的啟動器 —— 雙擊即可跑完「CB 日報」整個流程並上傳網頁。

流程全部交給 publish_daily_report.py:
  1. git 同步 data/ 到最新
  2. scripts/daily_cb_scan.py —— CB 當日漲幅/量能前 100 檔 + 對應個股技術面/籌碼面
  3. scripts/build_daily_cb_rank_json.py —— 產生 data/daily_cb_rank.json(+ 歸檔往期)
  4. git commit + push,網頁「日報」分頁立刻看得到

跟 券商進出.exe 用同一種打包方式:exe 只是啟動器,實際呼叫 scripts/ 內的 Python,
所以 exe 必須留在專案根目錄(跟 scripts/、data/ 同一層)。

這個 exe 只更新「日報」表格資料(數字),不會自動寫評論文字。如果想像
scripts/schedule/prompt_universe.md 那樣附一段分析評論,自己編輯
scripts/output/daily_commentary.json(date 要等於今天),重跑一次即可;
日期對不上的舊評論會被自動忽略,不會誤貼到新的一天。
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
    print(" CB 日報 一鍵產生 + 上傳")
    print("=" * 60)
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    r = subprocess.run([py, "-u", str(SCRIPTS / "publish_daily_report.py")],
                       cwd=str(ROOT), env=env)
    print()
    if r.returncode == 0:
        print("完成。網頁「CB 分析」→「日報」分頁已更新。")
    else:
        print("[失敗] 請檢查上面的錯誤訊息,或稍後單獨執行 scripts\\publish_daily_report.py")
    input("按 Enter 關閉視窗...")


if __name__ == "__main__":
    main()
