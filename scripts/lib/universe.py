"""全市場快取讀取 + 前處理（vcp_scanner / strength_scanner 共用）。

資料來源: build_universe.py 建的本地快取 scripts/cache/universe/<YYYYMMDD>.json
  {"date":"20260529","stocks":{"2330":{"n":"台積電","m":"TWSE",
                                       "o":..,"h":..,"l":..,"c":..,"v":..}, ...}}

本模組把每日快照拼成每檔時間序列，並做停牌 forward-fill、除權息斷點標記。
函式全部參數化（不依賴任何模組級 CONFIG），供不同 scanner 帶自己的門檻呼叫。
"""
from __future__ import annotations

import glob
import json
from pathlib import Path


def is_individual_stock(code: str) -> bool:
    """個股 = 4 碼純數字 (含 KY/F股)。排除 ETF(含 4 碼老 ETF 0050/0056… 皆以 00 開頭)、
    權證/TDR(碼長≠4 或含字母) 等。"""
    return len(code) == 4 and code.isdigit() and not code.startswith("00")


def load_universe(cache_dir: Path, as_of: str | None = None):
    """讀快取 → (使用到的日期 ascending, {code: series})。
    series = {name, market, dates[], o[], h[], l[], c[], v[]}（原始，未 forward-fill）。"""
    files = sorted(glob.glob(str(cache_dir / "*.json")))
    if not files:
        raise SystemExit(f"快取為空: {cache_dir} (先跑 build_universe.py)")
    dates = [Path(f).stem for f in files]
    if as_of:
        keep = [(f, d) for f, d in zip(files, dates) if d <= as_of]
        files = [f for f, _ in keep]
        dates = [d for _, d in keep]
    series: dict[str, dict] = {}
    for f, d in zip(files, dates):
        day = json.loads(Path(f).read_text(encoding="utf-8"))
        for code, s in day["stocks"].items():
            obj = series.get(code)
            if obj is None:
                obj = series[code] = {
                    "name": s["n"], "market": s["m"],
                    "dates": [], "o": [], "h": [], "l": [], "c": [], "v": [],
                }
            if s["n"]:
                obj["name"] = s["n"]
            obj["dates"].append(d)
            obj["o"].append(s["o"]); obj["h"].append(s["h"])
            obj["l"].append(s["l"]); obj["c"].append(s["c"])
            obj["v"].append(s["v"])
    return dates, series


def preprocess(s: dict, *, min_history: int, gap_break_pct: float) -> dict | None:
    """forward-fill 停牌(0) → 回傳清理後 series；歷史不足回 None。
    另標記除權息斷點 index 集合 s['breaks']（單日向下跳空 > gap_break_pct）。"""
    n = len(s["c"])
    if n < min_history:
        return None
    c = s["c"][:]; o = s["o"][:]; h = s["h"][:]; low = s["l"][:]; v = s["v"][:]
    last_c = None
    for i in range(n):
        if not c[i] or c[i] <= 0:
            if last_c is None:
                continue  # 開頭就停牌，稍後用第一個有效值回填
            c[i] = last_c
            o[i] = o[i] or last_c
            h[i] = h[i] or last_c
            low[i] = low[i] or last_c
            v[i] = v[i] or 0
        else:
            last_c = c[i]
    first_valid = next((x for x in c if x and x > 0), None)
    if first_valid is None:
        return None
    for i in range(n):
        if not c[i] or c[i] <= 0:
            c[i] = o[i] = h[i] = low[i] = first_valid
    breaks = set()
    for i in range(1, n):
        if c[i - 1] > 0:
            chg = (c[i] - c[i - 1]) / c[i - 1]
            if chg < -gap_break_pct:
                breaks.add(i)
    s2 = dict(s)
    s2["c"], s2["o"], s2["h"], s2["l"], s2["v"] = c, o, h, low, v
    s2["breaks"] = breaks
    return s2


def sma(arr: list[float], window: int, idx: int) -> float | None:
    """arr[idx] 為止、往回 window 根的簡單移動平均；資料不足回 None。"""
    if idx + 1 < window:
        return None
    seg = arr[idx + 1 - window: idx + 1]
    return sum(seg) / window
