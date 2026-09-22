#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""個股單季 EPS (含 QoQ / YoY) → data/eps.json

網頁「EPS」tab 用,做法與 scripts/build_revenue.py 對稱(同一個 GitHub Actions
workflow revenue-fetch.yml 觸發,每月 1~15 日一起跑),只是頻率是「季」不是「月」:
只抓「網站標的池」內的股號 (data/all-data.json 的 stockTrading / marginTrading /
cbInstitutional 三表 union,FEATURES.md 10.3),不是全市場。

兩段式來源:
  1) 快速路徑 (每次都跑): TWSE OpenAPI 整批單季 EPS t187ap14_L (只有上市;上櫃/興櫃
     找不到對應 bulk dataset,一律靠路徑 2 FinMind 補),單季全市場一次拿齊。
  2) 回補/更新路徑: FinMind TaiwanStockFinancialStatements (type=EPS 那幾列即單季
     EPS,已驗證非累計數字),逐檔拉完整歷史。用「這檔股號目前最新一季 < 這個時間點
     照公告截止日推算應該要有的季別」判斷是否過期 (stale),過期或從沒抓過的才排進
     這一輪回補名單——不像 revenue 是「抓過一次就永久跳過」,EPS 每季都要再確認一次
     有沒有新一季公告。

data/eps.json 格式:
  {"1514": {"n": "亞力", "q": {"2026-2": 0.71, ...}}, ...}   # value 單位:元/股,q 索引 1~4

用法:
  PYTHONUTF8=1 python scripts/build_eps.py                # 例行:整批更新 + 回補過期/新入白名單的股號
  PYTHONUTF8=1 python scripts/build_eps.py --full          # 強制標的池內全部股號重拉 FinMind 完整歷史
  PYTHONUTF8=1 python scripts/build_eps.py --codes 1514,3105  # 只處理指定股號(測試用,忽略標的池限制)
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
OUT_PATH = os.path.join(BASE, "..", "data", "eps.json")

TAIPEI = timezone(timedelta(hours=8))
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

TWSE_BULK_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap14_L"  # 上市單季 EPS,無上櫃對應 bulk
FINMIND_FULL_START = "2018-01-01"  # 全量回補起始日,與 revenue 一致


def site_universe():
    """網站標的池 = data/all-data.json 的 stockTrading / marginTrading / cbInstitutional
    三表 union (FEATURES.md 10.3)。每表第一列是表頭,第一欄是股號。
    回傳 (股號 set, 股號→名稱 dict)。與 build_revenue.py 的同名函式邏輯相同。"""
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


def expected_quarter(today):
    """粗估「這個時間點市場上應該已經看得到的最新一季」,用季報截止日推算
    (Q1 5/15、Q2 8/14、Q3 11/14、年報/Q4 3/31),抓公告後留約 1 個月緩衝才更新期望值。
    只用來判斷某檔股號的 EPS 資料是否『看起來過期』,不用來核實實際公告日。"""
    y, m = today.year, today.month
    if m <= 3:
        return y - 1, 3
    if m <= 5:
        return y - 1, 4
    if m <= 8:
        return y, 1
    if m <= 11:
        return y, 2
    return y, 3


def _get_json_status(url, retries=4, timeout=30):
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
    """路徑 1: TWSE OpenAPI 整批單季 EPS (只有上市),只挑 allowed 內的股號寫回 data。"""
    rows, _ = _get_json_status(TWSE_BULK_URL)
    touched = 0
    for r in rows or []:
        code = (r.get("公司代號") or "").strip()
        yy = (r.get("年度") or "").strip()
        qq = (r.get("季別") or "").strip()
        eps = r.get("基本每股盈餘(元)")
        name = (r.get("公司名稱") or "").strip()
        if not code or code not in allowed or not yy or qq not in ("1", "2", "3", "4") or eps in (None, "", "-"):
            continue
        try:
            year = int(yy) + 1911
            eps_v = round(float(eps), 2)
        except (ValueError, TypeError):
            continue
        entry = data.setdefault(code, {"n": name, "q": {}})
        if name:
            entry["n"] = name
        entry["q"][f"{year}-{qq}"] = eps_v
        touched += 1
    return touched


def latest_quarter(entry):
    keys = list((entry or {}).get("q", {}).keys())
    if not keys:
        return None
    pairs = [tuple(int(x) for x in k.split("-")) for k in keys]
    return max(pairs)


def finmind_backfill(data, codes, names, sleep_s):
    """路徑 2: 對 codes 逐檔拉 FinMind 完整單季 EPS 歷史,merge 進 data (in place)。
    失敗時保留原本 data[code] 不覆蓋掉;連續配額錯誤提早結束,剩下的下次執行再補。"""
    ok = err = 0
    consecutive_quota_fail = 0
    for i, code in enumerate(codes):
        url = (
            "https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements"
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
        q = {}
        for r in rows:
            if r.get("type") != "EPS" or r.get("value") is None:
                continue
            d = r.get("date") or ""  # 季末日 "YYYY-MM-DD"
            try:
                y = int(d[:4])
                mo = int(d[5:7])
            except (ValueError, TypeError):
                continue
            qtr = {3: 1, 6: 2, 9: 3, 12: 4}.get(mo)
            if not qtr:
                continue
            q[f"{y}-{qtr}"] = round(float(r["value"]), 2)
        entry = data.setdefault(code, {"n": names.get(code, ""), "q": {}})
        entry["n"] = names.get(code, entry.get("n", ""))
        if q:
            entry["q"].update(q)
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
    data = {c: v for c, v in data.items() if c in site_codes}

    print("路徑 1/2: TWSE OpenAPI 整批單季 EPS (上市) ...")
    touched = bulk_update(data, site_codes)
    print(f"  更新 {touched} 筆股號x季")

    exp = expected_quarter(datetime.now(TAIPEI).date())
    MIN_HISTORY_Q = 5  # 路徑 1 bulk 只給當季 1 筆,即使「不算過期」也還沒做過 FinMind 全歷史回補
    if args.codes:
        want = [c.strip() for c in args.codes.split(",") if c.strip()]
    elif args.full:
        want = sorted(site_codes)
    else:
        want = sorted(
            c for c in site_codes
            if (latest_quarter(data.get(c)) or (0, 0)) < exp
            or len(data.get(c, {}).get("q", {})) < MIN_HISTORY_Q
        )

    if want:
        print(f"路徑 2/2: FinMind 回補/更新完整歷史,共 {len(want)} 檔 (期望最新季 {exp[0]}-Q{exp[1]}) ...")
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
