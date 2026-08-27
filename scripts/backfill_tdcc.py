#!/usr/bin/env python3
"""集保股權分散表「歷史」回補 — 逐檔查 TDCC 網站的週資料。

集保 OpenData 1-5 只給**最新一週**,要畫一年的大戶/散戶走勢就得靠
https://www.tdcc.com.tw/portal/zh/smWeb/qryStock 逐檔逐週查 (網站保留約 1 年 / 51 週)。

- 一次請求 = 一檔 × 一個資料日期 → 全部標的 ≈ 414 × 51 ≈ 21,000 次,慢慢跑
  (預設 0.4 秒間隔,約 2.5 小時)。**可中斷、可續跑**:結果寫在
  scripts/cache/tdcc/{code}.json,已抓過的 (檔,日期) 會自動跳過。
- 跑完記得 `python build_shareholding.py` 重建網頁用的 JSON。

用法:
  python backfill_tdcc.py --weeks 52            # 全部標的、最近 52 週
  python backfill_tdcc.py --codes 1438,2330     # 只補這幾檔
  python backfill_tdcc.py --weeks 12 --delay 0.6
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE = Path(__file__).resolve().parent
CACHE_DIR = BASE / "cache" / "tdcc"
URL = "https://www.tdcc.com.tw/portal/zh/smWeb/qryStock"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)
N_LEVELS = 15


class TdccSession:
    """帶 SYNCHRONIZER_TOKEN 的查詢 session (token 會過期,失敗就重開)。"""

    def __init__(self) -> None:
        self.s = None
        self.token = ""
        self.dates: list[str] = []
        self.renew()

    def renew(self) -> None:
        s = requests.Session()
        s.verify = False  # TDCC 憑證缺 Subject Key Identifier,同 TPEx
        s.headers["User-Agent"] = UA
        r = s.get(URL, timeout=30)
        r.raise_for_status()
        m = re.search(r'name="SYNCHRONIZER_TOKEN" value="([^"]+)"', r.text)
        if not m:
            raise RuntimeError("抓不到 SYNCHRONIZER_TOKEN")
        self.s, self.token = s, m.group(1)
        self.dates = re.findall(r'<option value="(\d{8})"', r.text)

    def query(self, code: str, date: str) -> dict | None:
        """查一檔一週。SYNCHRONIZER_TOKEN 是一次性的,每次都從回應裡換新的。"""
        payload = {
            "SYNCHRONIZER_TOKEN": self.token,
            "SYNCHRONIZER_URI": "/portal/zh/smWeb/qryStock",
            "method": "submit",
            "firDate": self.dates[0] if self.dates else date,
            "scaDate": date,
            "sqlMethod": "StockNo",
            "stockNo": code,
            "stockName": "",
        }
        r = self.s.post(URL, data=payload, timeout=40, headers={"Referer": URL})
        r.raise_for_status()
        m = re.search(r'name="SYNCHRONIZER_TOKEN" value="([^"]+)"', r.text)
        if m:
            self.token = m.group(1)
        return parse_result(r.text)


def parse_result(html: str) -> dict | None:
    """把結果表轉成 {ratio, people, totalShares, totalPeople}。

    ⚠️ 網頁版與 OpenData CSV 的列數不一樣:CSV 固定 17 列 (16=差異數調整、17=合計),
    網頁有的股票只有 16 列 (沒有差異數調整,合計就變成第 16 列)。
    所以合計/差異數一律**看分級名稱**,不看序號。
    """
    for table in re.findall(r"<table.*?</table>", html, re.S):
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", table, re.S)
        cells = [
            [
                re.sub(r"\s+", " ", re.sub("<[^>]+>", "", c)).strip()
                for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)
            ]
            for row in rows
        ]
        body = [c for c in cells if len(c) >= 5 and c[0].isdigit()]
        if len(body) < N_LEVELS:
            continue
        rec = {
            "ratio": [None] * N_LEVELS,
            "people": [None] * N_LEVELS,
            "totalShares": None,
            "totalPeople": None,
        }
        for c in body:
            label = c[1].replace("　", "")
            people, shares, ratio = _int(c[2]), _int(c[3]), _float(c[4])
            if "合計" in label:
                rec["totalPeople"] = people
                rec["totalShares"] = shares
                continue
            if "差異" in label:
                continue
            lvl = int(c[0])
            if 1 <= lvl <= N_LEVELS:
                rec["people"][lvl - 1] = people
                rec["ratio"][lvl - 1] = ratio
        return rec
    return None


def _int(v):
    try:
        return int(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _float(v):
    try:
        return round(float(str(v).replace(",", "").strip()), 2)
    except (TypeError, ValueError):
        return None


def load_cache(code: str) -> dict:
    f = CACHE_DIR / f"{code}.json"
    if not f.exists():
        return {"code": code, "dates": {}}
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"code": code, "dates": {}}


def save_cache(code: str, rec: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / f"{code}.json").write_text(
        json.dumps(rec, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="集保股權分散表歷史回補")
    ap.add_argument("--codes", default="", help="逗號分隔股號;空白 = 網頁全部標的")
    ap.add_argument("--weeks", type=int, default=52, help="回補最近 N 週 (預設 52)")
    ap.add_argument("--delay", type=float, default=0.4, help="每次請求間隔秒數")
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 檔 (測試用)")
    args = ap.parse_args()

    if args.codes.strip():
        codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    else:
        sys.path.insert(0, str(BASE))
        from build_shareholding import universe_codes  # noqa: WPS433
        codes = sorted(universe_codes())
    if args.limit > 0:
        codes = codes[: args.limit]

    sess = TdccSession()
    dates = sess.dates[: args.weeks] if args.weeks > 0 else sess.dates
    print(f"🎯 {len(codes)} 檔 × {len(dates)} 週 (最新 {dates[0]} ~ 最舊 {dates[-1]})")
    print(f"   預估 {len(codes) * len(dates) * args.delay / 60:.0f} 分鐘 (已抓過的會跳過)")

    fetched = skipped = failed = 0
    for i, code in enumerate(codes, 1):
        rec = load_cache(code)
        todo = [d for d in dates if d not in rec["dates"]]
        skipped += len(dates) - len(todo)
        if not todo:
            continue
        got = 0
        for d in todo:
            data = None
            for attempt in range(3):
                try:
                    data = sess.query(code, d)
                    if data is not None:
                        break
                    print(f"  ⚠️ {code} {d} 無結果 (第 {attempt+1} 次),換 token 重試")
                except Exception as e:  # noqa: BLE001
                    print(f"  ⚠️ {code} {d} 第 {attempt+1} 次失敗: {str(e)[:80]}")
                time.sleep(1.5 + attempt * 2)
                try:
                    sess.renew()
                except Exception:  # noqa: BLE001
                    pass
            if data is None:
                failed += 1
            else:
                rec["dates"][d] = data
                fetched += 1
                got += 1
            time.sleep(args.delay)
        if got:
            save_cache(code, rec)
        print(f"[{i}/{len(codes)}] {code}: +{got} 週 (累計 {len(rec['dates'])} 週)",
              flush=True)

    print(f"\n🏁 新抓 {fetched} · 跳過 {skipped} · 失敗 {failed}")
    print("   接著跑: python build_shareholding.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
