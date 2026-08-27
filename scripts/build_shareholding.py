#!/usr/bin/env python3
"""集保股權分散表 → data/shareholding.json (只留網頁上的標的)。

輸入 (兩種來源合併,同日期以每週 CSV 為準):
  1. 每週全市場 CSV — Drive 同步資料夾 `股權分散表/TDCC_OD_1-5_YYYYMMDD.csv`
     (由 fetch_tdcc.py 每週五抓)
  2. 逐檔歷史回補快取 — scripts/cache/tdcc/{code}.json (由 backfill_tdcc.py 產)

輸出 data/shareholding.json:
{
  "_meta": {generatedAt, latestDate, dates:[...], stocks:N, source},
  "levels": [{n, label, loLots, hiLots}, ... 15 級],
  "stocks": { "1438": {dates:[...], ratio:[[15 個 %], ...],
                       people:[[15 個 人數], ...],
                       totalShares:[...], totalPeople:[...]} }
}

用法:
  python build_shareholding.py                 # 本機全部重建 (掃 Drive 資料夾 + 回補快取)
  python build_shareholding.py --weeks 60      # 只留最近 60 週
  # GitHub Actions 增量模式:拿現有 JSON 當基底,只把新抓的那份 CSV 併進去
  python build_shareholding.py --merge --csv /tmp/x.csv --no-local-dir
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent
OUT = ROOT / "data" / "shareholding.json"
ALL_DATA = ROOT / "data" / "all-data.json"
CACHE_DIR = BASE / "cache" / "tdcc"
DEFAULT_LOCAL_DIR = r"Y:\我的雲端硬碟\Telegram Bot\股權分散表"
TAIPEI = timezone(timedelta(hours=8))

# 集保 15 級距,單位「張」(1 張 = 1000 股);hiLots=None 代表無上限
LEVELS = [
    {"n": 1,  "label": "1-999 股",           "loLots": 0,    "hiLots": 1},
    {"n": 2,  "label": "1-5 張",             "loLots": 1,    "hiLots": 5},
    {"n": 3,  "label": "5-10 張",            "loLots": 5,    "hiLots": 10},
    {"n": 4,  "label": "10-15 張",           "loLots": 10,   "hiLots": 15},
    {"n": 5,  "label": "15-20 張",           "loLots": 15,   "hiLots": 20},
    {"n": 6,  "label": "20-30 張",           "loLots": 20,   "hiLots": 30},
    {"n": 7,  "label": "30-40 張",           "loLots": 30,   "hiLots": 40},
    {"n": 8,  "label": "40-50 張",           "loLots": 40,   "hiLots": 50},
    {"n": 9,  "label": "50-100 張",          "loLots": 50,   "hiLots": 100},
    {"n": 10, "label": "100-200 張",         "loLots": 100,  "hiLots": 200},
    {"n": 11, "label": "200-400 張",         "loLots": 200,  "hiLots": 400},
    {"n": 12, "label": "400-600 張",         "loLots": 400,  "hiLots": 600},
    {"n": 13, "label": "600-800 張",         "loLots": 600,  "hiLots": 800},
    {"n": 14, "label": "800-1000 張",        "loLots": 800,  "hiLots": 1000},
    {"n": 15, "label": "1000 張以上",        "loLots": 1000, "hiLots": None},
]
N_LEVELS = len(LEVELS)


def universe_codes() -> set[str]:
    """網頁上的個股 = all-data.json stockTrading 的股票代號。"""
    if not ALL_DATA.exists():
        raise SystemExit(f"❌ 找不到 {ALL_DATA}")
    with ALL_DATA.open(encoding="utf-8") as f:
        data = json.load(f)
    rows = data.get("stockTrading") or []
    codes = {str(r[0]).strip() for r in rows[1:] if r and str(r[0]).strip()}
    codes = {c for c in codes if re.fullmatch(r"\d{4,6}[A-Z]?", c)}
    return codes


def parse_week_csv(path: Path, codes: set[str], out: dict) -> str | None:
    """把一份全市場 CSV 塞進 out[code][date]。回傳資料日期。"""
    text = path.read_bytes().decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    date = None
    for row in reader:
        code = (row.get("證券代號") or "").strip()
        if code not in codes:
            continue
        d = (row.get("資料日期") or "").strip()
        if not (len(d) == 8 and d.isdigit()):
            continue
        date = date or d
        try:
            lvl = int(row.get("持股分級") or 0)
        except ValueError:
            continue
        rec = out[code].setdefault(
            d, {"ratio": [None] * N_LEVELS, "people": [None] * N_LEVELS,
                "totalShares": None, "totalPeople": None},
        )
        people = _int(row.get("人數"))
        shares = _int(row.get("股數"))
        ratio = _float(row.get("占集保庫存數比例%"))
        if 1 <= lvl <= N_LEVELS:
            rec["ratio"][lvl - 1] = ratio
            rec["people"][lvl - 1] = people
        elif lvl == 17:  # 合計
            rec["totalShares"] = shares
            rec["totalPeople"] = people
    return date


def _int(v) -> int | None:
    try:
        return int(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _float(v) -> float | None:
    try:
        return round(float(str(v).replace(",", "").strip()), 2)
    except (TypeError, ValueError):
        return None


def load_existing(out: dict) -> int:
    """把現有的 data/shareholding.json 讀回 out (增量模式的基底)。

    GitHub Actions 上沒有 Drive 同步資料夾、也沒有回補快取,只能靠 repo 裡
    已經 commit 的 JSON 當歷史,再把當週那份 CSV 疊上去。
    """
    if not OUT.exists():
        print("ℹ️ 還沒有 data/shareholding.json,從零開始")
        return 0
    try:
        data = json.loads(OUT.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"⚠️ 現有 JSON 讀取失敗 ({e}),從零開始")
        return 0
    n = 0
    for code, rec in (data.get("stocks") or {}).items():
        dates = rec.get("dates") or []
        for i, d in enumerate(dates):
            out[code][d] = {
                "ratio": _at(rec.get("ratio"), i) or [None] * N_LEVELS,
                "people": _at(rec.get("people"), i) or [None] * N_LEVELS,
                "totalShares": _at(rec.get("totalShares"), i),
                "totalPeople": _at(rec.get("totalPeople"), i),
            }
            n += 1
    print(f"  📥 現有 JSON 讀回 {len(data.get('stocks') or {})} 檔 / {n} 個 (檔,日期)")
    return n


def _at(arr, i):
    return arr[i] if isinstance(arr, list) and i < len(arr) else None


def load_cache(codes: set[str], out: dict) -> int:
    """逐檔回補快取 (backfill_tdcc.py)。已有的日期不覆蓋 (CSV 優先)。"""
    if not CACHE_DIR.is_dir():
        return 0
    n = 0
    for f in sorted(CACHE_DIR.glob("*.json")):
        code = f.stem
        if code not in codes:
            continue
        try:
            rec = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            print(f"⚠️ 快取壞檔,跳過: {f.name}")
            continue
        for d, v in (rec.get("dates") or {}).items():
            if d in out[code]:
                continue
            out[code][d] = {
                "ratio": v.get("ratio") or [None] * N_LEVELS,
                "people": v.get("people") or [None] * N_LEVELS,
                "totalShares": v.get("totalShares"),
                "totalPeople": v.get("totalPeople"),
            }
            n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description="集保股權分散表 → data/shareholding.json")
    ap.add_argument("--weeks", type=int, default=0,
                    help="只留最近 N 週 (0 = 全留)")
    ap.add_argument("--dir", default=os.environ.get("TDCC_LOCAL_DIR", DEFAULT_LOCAL_DIR),
                    help="每週 CSV 所在資料夾")
    ap.add_argument("--merge", action="store_true",
                    help="拿現有 data/shareholding.json 當基底做增量 (GitHub Actions 用)")
    ap.add_argument("--csv", action="append", default=[],
                    help="額外指定要併進來的 CSV (可重複)")
    ap.add_argument("--no-local-dir", action="store_true",
                    help="不掃 Drive 同步資料夾 (雲端沒有那顆磁碟)")
    args = ap.parse_args()

    codes = universe_codes()
    print(f"🎯 網頁標的 {len(codes)} 檔")

    out: dict[str, dict[str, dict]] = defaultdict(dict)

    if args.merge:
        load_existing(out)

    files: list[Path] = []
    if not args.no_local_dir:
        src_dir = Path(args.dir)
        files = sorted(src_dir.glob("TDCC_OD_1-5_*.csv")) if src_dir.is_dir() else []
        if not files:
            print(f"⚠️ {src_dir} 找不到 TDCC_OD_1-5_*.csv (先跑 fetch_tdcc.py)")
    files += [Path(c) for c in args.csv]
    for f in files:
        d = parse_week_csv(f, codes, out)
        print(f"  📄 {f.name} → 資料日期 {d}")

    if not args.no_local_dir:
        n_cache = load_cache(codes, out)
        if n_cache:
            print(f"  🗃️ 回補快取補進 {n_cache} 個 (檔,日期)")

    stocks: dict[str, dict] = {}
    all_dates: set[str] = set()
    for code, by_date in out.items():
        dates = sorted(by_date)
        if args.weeks > 0:
            dates = dates[-args.weeks:]
        if not dates:
            continue
        stocks[code] = {
            "dates": dates,
            "ratio": [by_date[d]["ratio"] for d in dates],
            "people": [by_date[d]["people"] for d in dates],
            "totalShares": [by_date[d]["totalShares"] for d in dates],
            "totalPeople": [by_date[d]["totalPeople"] for d in dates],
        }
        all_dates.update(dates)

    payload = {
        "_meta": {
            "generatedAt": datetime.now(TAIPEI).isoformat(timespec="seconds"),
            "source": "TDCC OpenData 1-5 (每週) + qryStock 歷史回補",
            "dates": sorted(all_dates),
            "latestDate": max(all_dates) if all_dates else None,
            "stocks": len(stocks),
        },
        "levels": LEVELS,
        "stocks": stocks,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size = OUT.stat().st_size
    print(f"\n✅ {OUT} — {len(stocks)} 檔 / {len(all_dates)} 個資料日期 / {size:,} bytes")
    if all_dates:
        print(f"   最新資料日期 {max(all_dates)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
