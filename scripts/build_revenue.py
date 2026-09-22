#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""個股月營收 (含 MoM / YoY) → data/revenue.json

網頁「營收」tab 用。只抓「網站標的池」內的股號(data/all-data.json 的
stockTrading / marginTrading / cbInstitutional 三表 union,即 FEATURES.md 10.3
的白名單,約 4xx 檔),不是全市場 2000+ 檔——標的池本來就會隨 CB 白名單自動增減,
不需要額外維護清單。

兩段式來源:
  1) 快速路徑 (每次都跑): TWSE OpenAPI 整批月營收 t187ap05_L(上市) + t187ap05_P(上櫃),
     單月全市場一次拿齊、免逐檔打,但只挑標的池內的股號寫入;這兩個 dataset 都掛在
     openapi.twse.com.tw,不會撞到 tpex.org.tw 的 Cloudflare 封鎖
     (見 reference_tpex_cloudflare_block.md)。
  2) 回補路徑 (只對「還沒有資料」的股號跑一次): FinMind TaiwanStockMonthRevenue,
     逐檔拉完整歷史。第一次執行約 4xx 檔 (~3-5 分鐘),之後每天只剩新入白名單的
     少數幾檔要打 FinMind,平時執行只靠路徑 1,秒級完成。

data/revenue.json 格式:
  {"1514": {"n": "亞力", "m": {"2026-8": 78123, ...}}, ...}   # m 值單位:千元
  月營收月份缺一年前同月資料時前端 YoY 顯示 "-",不特別處理。

用法:
  PYTHONUTF8=1 python scripts/build_revenue.py                # 例行:整批更新 + 回補新入白名單的股號
  PYTHONUTF8=1 python scripts/build_revenue.py --full          # 強制標的池內全部股號重拉 FinMind 完整歷史
  PYTHONUTF8=1 python scripts/build_revenue.py --codes 1514,3105  # 只處理指定股號(測試用,忽略標的池限制)
"""
import argparse
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
NAMES_PATH = os.path.join(BASE, "..", "data", "stock_names.json")
ALLDATA_PATH = os.path.join(BASE, "..", "data", "all-data.json")
OUT_PATH = os.path.join(BASE, "..", "data", "revenue.json")

TAIPEI = timezone(timedelta(hours=8))
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

TWSE_BULK_URLS = [
    "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",  # 上市
    "https://openapi.twse.com.tw/v1/opendata/t187ap05_P",  # 上櫃
]
FINMIND_FULL_START = "2018-01-01"  # 全量回補起始日 (~8 年,檔案大小/耗時的折衷)


def site_universe():
    """網站標的池 = data/all-data.json 的 stockTrading / marginTrading / cbInstitutional
    三表 union (FEATURES.md 10.3)。每表第一列是表頭,第一欄是股號。
    回傳 (股號 set, 股號→名稱 dict)。"""
    with open(ALLDATA_PATH, encoding="utf-8") as f:
        d = json.load(f)
    codes = set()
    names = {}
    for key in ("stockTrading", "marginTrading", "cbInstitutional"):
        rows = d.get(key) or []
        for r in rows[1:]:
            if not r or not r[0]:
                continue
            code = str(r[0]).strip()
            if not code.isdigit() or not (4 <= len(code) <= 6):
                continue
            codes.add(code)
            if len(r) > 1 and r[1] and code not in names:
                names[code] = str(r[1]).strip()
    return codes, names


def _get_json(url, retries=4, timeout=30):
    data, _ = _get_json_status(url, retries=retries, timeout=timeout)
    return data


def _get_json_status(url, retries=4, timeout=30):
    """回傳 (json 或 None, HTTP 狀態碼或 None)。402/403 通常是配額問題,重試沒用,直接回傳。"""
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
                return json.load(r), r.status
        except urllib.error.HTTPError as e:
            if e.code in (402, 403) or i == retries - 1:
                print(f"  ERR {url}: HTTP {e.code}")
                return None, e.code
            time.sleep(1.5 * (i + 1))
        except Exception as e:
            if i == retries - 1:
                print(f"  ERR {url}: {e}")
                return None, None
            time.sleep(1.5 * (i + 1))
    return None, None


def bulk_update(data, allowed):
    """路徑 1: TWSE OpenAPI 整批月營收,只挑 allowed 內的股號寫回 data (in place)。
    回傳更新到的股號x月份數。"""
    touched = 0
    for url in TWSE_BULK_URLS:
        rows = _get_json(url)
        if not rows:
            continue
        for r in rows:
            code = (r.get("公司代號") or "").strip()
            ym = (r.get("資料年月") or "").strip()  # 民國 yyy+mm,如 "11508"
            rev = r.get("營業收入-當月營收")
            name = (r.get("公司名稱") or "").strip()
            if not code or code not in allowed or len(ym) < 4 or rev in (None, "", "-"):
                continue
            try:
                year = int(ym[:-2]) + 1911
                month = int(ym[-2:])
                rev_k = round(float(rev))  # TWSE 原始單位已是千元
            except (ValueError, TypeError):
                continue
            entry = data.setdefault(code, {"n": name, "m": {}})
            if name:
                entry["n"] = name
            entry["m"][f"{year}-{month}"] = rev_k
            touched += 1
    return touched


def finmind_backfill(data, codes, names, sleep_s):
    """路徑 2: 對 codes 逐檔拉 FinMind 完整歷史,merge 進 data (in place)。
    失敗時保留原本 data[code] (可能是路徑 1 已經寫入的當月資料),不覆蓋掉。
    連續 402/403 (配額用盡/被擋) 視為整輪都沒救,提早結束省時間,剩下的下次執行再補。"""
    ok = err = 0
    consecutive_quota_fail = 0
    for i, code in enumerate(codes):
        url = (
            "https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMonthRevenue"
            f"&data_id={code}&start_date={FINMIND_FULL_START}"
        )
        res, status = _get_json_status(url, retries=1, timeout=20)
        if status in (402, 403):
            consecutive_quota_fail += 1
            err += 1
            if consecutive_quota_fail >= 5:
                print(f"  連續 {consecutive_quota_fail} 檔配額錯誤 ({status}),提早結束本輪回補"
                      f" (剩 {len(codes) - i - 1} 檔下次執行再補)")
                break
            time.sleep(sleep_s)
            continue
        consecutive_quota_fail = 0
        rows = (res or {}).get("data") or []
        m = {}
        for r in rows:
            y, mo, rev = r.get("revenue_year"), r.get("revenue_month"), r.get("revenue")
            if not y or not mo or rev is None:
                continue
            m[f"{y}-{mo}"] = round(rev / 1000)
        # 200 OK (無論有沒有資料) 才算「已處理過」標記 _bf,配額錯誤 (402/403) 完全不碰 entry,
        # 讓它保留 code not in data 或 _bf 缺失的狀態,下次執行會再排進 want 重試。
        entry = data.setdefault(code, {"n": names.get(code, ""), "m": {}})
        entry["n"] = names.get(code, entry.get("n", ""))
        entry["_bf"] = True
        if m:
            entry["m"].update(m)
            ok += 1
        else:
            err += 1
        if (i + 1) % 100 == 0:
            print(f"  FinMind 回補 ...{i + 1}/{len(codes)} (成功 {ok})")
        time.sleep(sleep_s)
    return ok, err


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="強制標的池內全部股號重拉 FinMind 完整歷史")
    ap.add_argument("--codes", default="", help="只處理指定股號(逗號分隔,測試用,忽略標的池限制)")
    ap.add_argument("--sleep", type=float, default=0.35, help="FinMind 逐檔間隔秒數")
    args = ap.parse_args()

    site_codes, site_names = site_universe()
    if os.path.exists(NAMES_PATH):
        with open(NAMES_PATH, encoding="utf-8") as f:
            for c, n in json.load(f).items():
                site_names.setdefault(c, n)
    print(f"網站標的池: {len(site_codes)} 檔")

    data = {}
    if os.path.exists(OUT_PATH):
        with open(OUT_PATH, encoding="utf-8") as f:
            data = json.load(f)
    data.pop("_meta", None)
    data = {c: v for c, v in data.items() if c in site_codes}  # 標的池只增不減時仍會有股號被踢出白名單,順手清掉

    print("路徑 1/2: TWSE OpenAPI 整批月營收 ...")
    touched = bulk_update(data, site_codes)
    print(f"  更新 {touched} 筆股號x月份")

    if args.codes:
        want = [c.strip() for c in args.codes.split(",") if c.strip()]
    elif args.full:
        want = sorted(site_codes)
    else:
        # 回補「從沒成功打過 FinMind」的股號:新入白名單的,或上次因配額 402/403 被跳過的
        want = sorted(c for c in site_codes if not data.get(c, {}).get("_bf"))

    if want:
        print(f"路徑 2/2: FinMind 回補完整歷史,共 {len(want)} 檔 ...")
        ok, err = finmind_backfill(data, want, site_names, args.sleep)
        print(f"  完成: 成功 {ok}, 無資料 {err}")
    else:
        print("路徑 2/2: 無需回補")

    data["_meta"] = {"updated": datetime.now(TAIPEI).strftime("%Y-%m-%d %H:%M:%S")}
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    tmp = OUT_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, OUT_PATH)
    print(f"寫出 {OUT_PATH},共 {len(data) - 1} 檔")


if __name__ == "__main__":
    main()
