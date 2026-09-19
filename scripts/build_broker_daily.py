#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""券商進出 CSV(Drive 本機同步資料夾)→ data/broker_daily/YYYYMMDD.json + index.json

網頁「籌碼日報」tab 用。每檔每日只留買超 Top30 / 賣超 Top30 券商(依淨張數),
格式:[券商名, 買張, 賣張, 買金額(千元), 賣金額(千元)],前端可跨日加總算買均價/損益。
另存 vol(當日總成交張數 = 全部券商買進股數 / 1000)。

用法: PYTHONUTF8=1 python scripts/build_broker_daily.py [--keep 30]
"""
import argparse, csv, glob, json, os, re
from collections import defaultdict

DRIVE = r"Y:\我的雲端硬碟\Telegram Bot"
DIRS = [os.path.join(DRIVE, "上市券商進出"), os.path.join(DRIVE, "上櫃券商進出")]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "broker_daily")
TOP = 30


def load_day(files):
    agg = defaultdict(lambda: defaultdict(lambda: [0, 0, 0.0, 0.0]))  # stock -> broker -> [buy, sell, buyAmt, sellAmt]
    date = None
    for f in files:
        with open(f, encoding="utf-8-sig", newline="") as fh:
            for r in csv.DictReader(fh):
                try:
                    p = float(r["price"]); b = int(float(r["buy_shares"])); s = int(float(r["sell_shares"]))
                except (ValueError, KeyError, TypeError):
                    continue
                date = r["date"]
                a = agg[r["stock_code"].strip()][r["broker_name"].strip()]
                a[0] += b; a[1] += s; a[2] += p * b; a[3] += p * s
    stocks = {}
    for code, brokers in agg.items():
        vol = sum(a[0] for a in brokers.values()) / 1000
        rows = [[n, round(a[0] / 1000), round(a[1] / 1000), round(a[2] / 1e3, 1), round(a[3] / 1e3, 1)]
                for n, a in brokers.items()]  # 金額單位: 千元
        by_net = sorted(rows, key=lambda x: x[1] - x[2])
        keep = {id(x): x for x in by_net[:TOP] + by_net[-TOP:]}
        stocks[code] = {"vol": round(vol), "b": list(keep.values())}
    return date, stocks


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--keep", type=int, default=30)
    keep = ap.parse_args().keep
    days = defaultdict(list)
    for d in DIRS:
        for f in glob.glob(os.path.join(d, "BrokerBS_*_*.csv")):
            m = re.search(r"_(\d{8})\.csv$", f)
            if m: days[m.group(1)].append(f)
    os.makedirs(OUT, exist_ok=True)
    for day in sorted(days):
        date, stocks = load_day(days[day])
        with open(os.path.join(OUT, f"{day}.json"), "w", encoding="utf-8") as fh:
            json.dump({"date": day, "stocks": stocks}, fh, ensure_ascii=False, separators=(",", ":"))
        print(day, len(stocks), "檔")
    have = sorted(os.path.basename(f)[:8] for f in glob.glob(os.path.join(OUT, "2*.json")))
    for old in have[:-keep]:
        os.remove(os.path.join(OUT, old + ".json"))
    have = have[-keep:]
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"dates": have}, fh)
    print("index:", have)

if __name__ == "__main__":
    main()
