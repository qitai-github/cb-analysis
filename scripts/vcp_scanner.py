#!/usr/bin/env python3
"""Phase 1｜VCP (Volatility Contraction Pattern) 全台股掃描器。

讀 build_universe.py 建的本地快取 (scripts/cache/universe/*.json),對每檔台股做:
  1. 前處理 (forward-fill 停牌、除權息斷點偵測)
  2. 流動性/體質過濾
  3. Minervini 趨勢樣板 (Stage 2 多頭前提)
  4. swing 轉折 + base 視窗
  5. 收斂序列 (depth 遞減)
  6. 量縮確認
  7. Pivot / stage (watch | setup | breakout)
  8. 誤判排除 (上升三角 / 純上升支撐)
  9. 三級 tier 評分 (loose / standard / strict) — 一次掃描, 前端可切換

輸出:
  data/vcp.json          通過股票 + 近 120 根 OHLC 切片 + 收斂/Pivot 標記 (前端用)
  scripts/output/vcp_<asOf>.xlsx   攤平表 (離線檢視, 對應 GPT)

用法:
  python vcp_scanner.py              # 用快取最新日期掃描
  python vcp_scanner.py 20260529     # 指定 as-of 日期
  python vcp_scanner.py --no-excel   # 不輸出 Excel
  python vcp_scanner.py --slice 120  # OHLC 切片長度 (預設 120)
"""
from __future__ import annotations

import argparse
import glob
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
CACHE_DIR = SCRIPT_DIR / "cache" / "universe"
OUT_JSON = REPO_ROOT / "data" / "vcp.json"
OUT_XLSX_DIR = SCRIPT_DIR / "output"

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass


# ── 參數 (集中可調) ───────────────────────────────────────────────────
CONFIG = {
    # 前處理 / 流動性
    "MIN_HISTORY_BARS": 200,      # 至少約 10 個月 (算 MA200)
    "MIN_CLOSE": 10.0,            # 收盤 < 10 元剔除
    "MIN_AVG_TURNOVER": 20_000_000,  # 近 50 日均成交金額 (元)
    "GAP_BREAK_PCT": 0.15,        # 單日跳空 >15% 視為斷點 (除權息), base 不可跨越

    # 趨勢樣板
    "DIST_52W_HIGH_MAX": 0.25,    # 收盤距 52 週高 ≤ 25%
    "DIST_52W_LOW_MIN": 0.30,     # 收盤 ≥ 52 週低 ×1.30
    "MA200_SLOPE_LOOKBACK": 22,   # MA200 向上判定回看天數

    # swing / base (壓力線觸碰模型)
    "ZIGZAG_PCT": 0.08,           # ZigZag 反轉門檻 (盤中高低, 只認 ≥8% 的波)
    "BASE_MAX_BARS": 130,         # base 視窗上限 (~6 個月)
    "CEILING_BAND": 0.05,         # 壓力線帶寬: 峰落在 ceiling×(1-此值)~ceiling 內算一次觸碰
    "CEILING_MIN_SPAN": 20,       # 壓力線首末觸碰須橫跨 ≥ 此交易日 (濾掉突破當下連續高點)

    # 突破量
    "BREAKOUT_VOL_MULT": 1.5,     # 突破日量 ≥ 50 日均量 ×1.5
    "BREAKOUT_BAND": 0.06,        # 現價在壓力線上方 ≤ 此值才算「剛突破」, 超過算 extended
    "CEILING_RECENT_MAX": 30,     # 壓力線最後一次觸碰須在近 N 交易日內 (濾掉陳年舊底)

    # 三級門檻 (一次掃描同時判定; tier=最嚴格通過的等級)
    # 核心形狀條件: 低點逐步墊高 (L1<L2<L3…) + 高點群「都≒等高」(帶寬)
    #   量縮 (volDryUp) 不再當硬門檻 — 仍會計算並納入分數排序
    #   LOW_VIOL_ALLOWED  允許幾次「低點未墊高」
    #   HIGH_BAND_MAX     所有高點須落在同一帶狀內: (max(H)-min(H))/max(H) ≤ 此值
    "PRESETS": {
        "loose": {
            "MIN_CONTRACTIONS": 2, "MAX_CONTRACTIONS": 5,
            "FIRST_CONTRACTION_MAX": 0.50, "TIGHT_MAX": 0.15,
            "NEAR_PIVOT_MAX": 0.10,
            "DEPTH_VIOLATIONS_ALLOWED": 1,
            "LOW_VIOL_ALLOWED": 1, "HIGH_BAND_MAX": 0.06,
        },
        "standard": {
            "MIN_CONTRACTIONS": 2, "MAX_CONTRACTIONS": 5,
            "FIRST_CONTRACTION_MAX": 0.45, "TIGHT_MAX": 0.12,
            "NEAR_PIVOT_MAX": 0.08,
            "DEPTH_VIOLATIONS_ALLOWED": 0,
            "LOW_VIOL_ALLOWED": 0, "HIGH_BAND_MAX": 0.04,
        },
        "strict": {
            "MIN_CONTRACTIONS": 2, "MAX_CONTRACTIONS": 5,
            "FIRST_CONTRACTION_MAX": 0.40, "TIGHT_MAX": 0.08,
            "NEAR_PIVOT_MAX": 0.06,
            "DEPTH_VIOLATIONS_ALLOWED": 0,
            "LOW_VIOL_ALLOWED": 0, "HIGH_BAND_MAX": 0.03,
        },
    },
}
TIER_ORDER = ["strict", "standard", "loose"]  # 由嚴到鬆


# ── 快取讀取 → 每檔時間序列 ──────────────────────────────────────────
def is_individual_stock(code: str) -> bool:
    """個股 = 4 碼純數字 (含 KY/F股)。排除 ETF(00開頭5-6碼)/權證/TDR 等。"""
    return len(code) == 4 and code.isdigit()


def load_universe(as_of: str | None) -> tuple[list[str], dict[str, dict]]:
    """回傳 (使用到的日期 ascending, {code: series})。
    series = {name, market, dates[], o[],h[],l[],c[],v[]}。"""
    files = sorted(glob.glob(str(CACHE_DIR / "*.json")))
    if not files:
        raise SystemExit(f"快取為空: {CACHE_DIR} (先跑 build_universe.py)")
    dates = [Path(f).stem for f in files]
    if as_of:
        dates = [d for d in dates if d <= as_of]
        files = [f for f, d in zip(files, [Path(f).stem for f in files]) if d <= as_of]
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


# ── 前處理 ────────────────────────────────────────────────────────────
def preprocess(s: dict) -> dict | None:
    """forward-fill 停牌(0), 回傳清理後 series; 資料不足回 None。
    另標記除權息斷點 index 集合 s['breaks']。"""
    n = len(s["c"])
    if n < CONFIG["MIN_HISTORY_BARS"]:
        return None
    c = s["c"][:]; o = s["o"][:]; h = s["h"][:]; low = s["l"][:]; v = s["v"][:]
    last_c = None
    for i in range(n):
        if not c[i] or c[i] <= 0:
            if last_c is None:
                # 開頭就停牌, 用之後第一個有效值回填 (稍後處理)
                continue
            c[i] = last_c
            o[i] = o[i] or last_c
            h[i] = h[i] or last_c
            low[i] = low[i] or last_c
            v[i] = v[i] or 0
        else:
            last_c = c[i]
    # 開頭若仍有 0 (從未開盤前) → 用第一個有效收盤回填
    first_valid = next((x for x in c if x and x > 0), None)
    if first_valid is None:
        return None
    for i in range(n):
        if not c[i] or c[i] <= 0:
            c[i] = o[i] = h[i] = low[i] = first_valid
    # 除權息斷點: 單日跌幅 > GAP_BREAK_PCT (向下跳空)
    breaks = set()
    for i in range(1, n):
        if c[i - 1] > 0:
            chg = (c[i] - c[i - 1]) / c[i - 1]
            if chg < -CONFIG["GAP_BREAK_PCT"]:
                breaks.add(i)
    s2 = dict(s)
    s2["c"], s2["o"], s2["h"], s2["l"], s2["v"] = c, o, h, low, v
    s2["breaks"] = breaks
    return s2


# ── 指標 ──────────────────────────────────────────────────────────────
def sma(arr: list[float], window: int, idx: int) -> float | None:
    if idx + 1 < window:
        return None
    seg = arr[idx + 1 - window: idx + 1]
    return sum(seg) / window


def trend_template(s: dict) -> dict | None:
    """Minervini 趨勢樣板。通過回傳指標 dict, 否則 None。"""
    c, h, low = s["c"], s["h"], s["l"]
    i = len(c) - 1
    close = c[i]
    ma50 = sma(c, 50, i)
    ma150 = sma(c, 150, i)
    ma200 = sma(c, 200, i)
    if None in (ma50, ma150, ma200):
        return None
    ma200_prev = sma(c, 200, i - CONFIG["MA200_SLOPE_LOOKBACK"])
    if ma200_prev is None:
        return None
    win = min(252, len(c))
    hi52 = max(h[-win:])
    lo52 = min(x for x in low[-win:] if x > 0)
    cond = (
        close > ma50 > ma150 > ma200
        and ma200 > ma200_prev
        and close <= hi52 * (1 + 1e-9)
        and (hi52 - close) / hi52 <= CONFIG["DIST_52W_HIGH_MAX"]
        and close >= lo52 * (1 + CONFIG["DIST_52W_LOW_MIN"])
    )
    if not cond:
        return None
    return {
        "ma50": ma50, "ma150": ma150, "ma200": ma200,
        "hi52": hi52, "lo52": lo52,
        "rsApprox": close / lo52,  # 距 52 週低的倍數 (粗略動能)
    }


def zigzag_hl(h: list[float], low: list[float], start: int, end: int, pct: float):
    """百分比 ZigZag (用盤中高低點)。上升段追 max(high), 下降段追 min(low),
    反轉幅度 ≥ pct 才確認轉折。回傳交替的 [(idx, 'H'|'L', price)], 含終端極值。
    高點記盤中最高、低點記盤中最低 (才抓得到觸頂插針, 如 3491 3/3 的 1895)。"""
    direction = 0          # 0 未定, 1 上升中(找高), -1 下降中(找低)
    ext_hi, ext_hi_i = h[start], start
    ext_lo, ext_lo_i = low[start], start
    pivots = []
    for i in range(start + 1, end + 1):
        if h[i] > ext_hi:
            ext_hi, ext_hi_i = h[i], i
        if low[i] < ext_lo:
            ext_lo, ext_lo_i = low[i], i
        if direction >= 0 and low[i] <= ext_hi * (1 - pct):
            pivots.append((ext_hi_i, "H", ext_hi))
            direction = -1
            ext_lo, ext_lo_i = low[i], i
        elif direction <= 0 and h[i] >= ext_lo * (1 + pct):
            pivots.append((ext_lo_i, "L", ext_lo))
            direction = 1
            ext_hi, ext_hi_i = h[i], i
    if direction == 1:
        pivots.append((ext_hi_i, "H", ext_hi))
    elif direction == -1:
        pivots.append((ext_lo_i, "L", ext_lo))
    return pivots


def detect_contractions(s: dict):
    """壓力線觸碰模型。回傳 (base_start_idx, contractions[], pivot=ceiling) 或 None。

    1. 用盤中高低 ZigZag 找轉折峰/谷
    2. 由高往低,取第一個「≥2 次觸碰且首末橫跨 ≥CEILING_MIN_SPAN」的價位當壓力線(ceiling)
       — 觸碰 = 峰落在 ceiling×(1−CEILING_BAND) ~ ceiling 內;天然忽略中途未觸頂的雜峰
    3. 每次觸頂 = 一波;該波低點 = 此觸頂到下一觸頂(或現在)之間的最低盤中低點
    pivot = ceiling (突破買點)。
    """
    h, low, c = s["h"], s["l"], s["c"]
    n = len(c)
    base_lo = max(0, n - CONFIG["BASE_MAX_BARS"])
    # base 不可跨越除權息斷點
    breaks = s.get("breaks", set())
    for b in sorted(breaks):
        if base_lo < b <= n - 1:
            base_lo = max(base_lo, b)
    if n - 1 - base_lo < 15:
        return None
    swings = zigzag_hl(h, low, base_lo, n - 1, CONFIG["ZIGZAG_PCT"])
    peaks = [(idx, px) for idx, t, px in swings if t == "H"]
    if len(peaks) < 2:
        return None

    band = CONFIG["CEILING_BAND"]
    min_span = CONFIG["CEILING_MIN_SPAN"]
    touches = None
    for cand in sorted({px for _, px in peaks}, reverse=True):   # 由高往低
        grp = sorted([(idx, px) for idx, px in peaks
                      if cand * (1 - band) <= px <= cand * 1.001])
        if (len(grp) >= 2
                and (grp[-1][0] - grp[0][0]) >= min_span
                and (n - 1 - grp[-1][0]) <= CONFIG["CEILING_RECENT_MAX"]):
            touches = grp
            break
    if not touches:
        return None
    ceiling = max(px for _, px in touches)

    contractions = []
    for k in range(len(touches)):
        hi_idx, hi = touches[k]
        b = touches[k + 1][0] if k + 1 < len(touches) else n - 1
        seg = low[hi_idx:b + 1]
        lo = min(seg)
        lo_idx = hi_idx + seg.index(lo)
        depth = (hi - lo) / hi if hi > 0 else 0
        contractions.append({
            "high": hi, "highIdx": hi_idx,
            "low": lo, "lowIdx": lo_idx, "depth": depth,
        })
    base_start = touches[0][0]
    return base_start, contractions, ceiling


def extract_vcp_tail(contractions, max_n: int, viol_allowed: int):
    """從最後一波往回取「深度遞減的尾段」= VCP 收斂序列。
    越早(左)的波應越深; 允許 viol_allowed 次例外。最多 max_n 波。"""
    if not contractions:
        return []
    tail = [contractions[-1]]
    violations = 0
    for k in range(len(contractions) - 2, -1, -1):
        cand = contractions[k]
        if cand["depth"] >= tail[0]["depth"] - 1e-9:
            tail.insert(0, cand)
        elif violations < viol_allowed:
            violations += 1
            tail.insert(0, cand)
        else:
            break
        if len(tail) >= max_n:
            break
    return tail


def depth_decrease_violations(contractions) -> int:
    v = 0
    for j in range(1, len(contractions)):
        if contractions[j]["depth"] > contractions[j - 1]["depth"] + 1e-9:
            v += 1
    return v


def rising_low_violations(contractions) -> int:
    """低點未逐步墊高 (L_k 應 > L_{k-1}) 的次數。"""
    v = 0
    for j in range(1, len(contractions)):
        if contractions[j]["low"] <= contractions[j - 1]["low"]:
            v += 1
    return v


def high_band(contractions) -> float:
    """高點群帶寬 = (最高高點 − 最低高點) / 最高高點。
    VCP 要求所有高點 H1≒H2≒H3 都等高 → 帶寬須 ≤ HIGH_BAND_MAX。"""
    highs = [ct["high"] for ct in contractions]
    hi = max(highs)
    return (hi - min(highs)) / hi if hi > 0 else 1.0


def vol_dryup(s: dict, contractions) -> float:
    """最後一波均量 / 第一波均量。"""
    v = s["v"]

    def avg_vol(ct):
        a, b = ct["highIdx"], ct["lowIdx"]
        seg = [x for x in v[a:b + 1] if x > 0]
        return sum(seg) / len(seg) if seg else 0.0

    first = avg_vol(contractions[0])
    last = avg_vol(contractions[-1])
    return (last / first) if first > 0 else 1.0


# ── 單檔評估 ──────────────────────────────────────────────────────────
def evaluate(code: str, raw: dict):
    s = preprocess(raw)
    if s is None:
        return None
    c, h, low, v = s["c"], s["h"], s["l"], s["c"]  # noqa
    i = len(s["c"]) - 1
    close = s["c"][i]
    if close < CONFIG["MIN_CLOSE"]:
        return None
    # 流動性: 近 50 日均成交金額 (收盤 × 股數)
    seg_c = s["c"][-50:]; seg_v = s["v"][-50:]
    turnover = sum(cc * vv for cc, vv in zip(seg_c, seg_v)) / len(seg_c)
    if turnover < CONFIG["MIN_AVG_TURNOVER"]:
        return None

    tt = trend_template(s)
    if tt is None:
        return None

    det = detect_contractions(s)
    if det is None:
        return None
    base_start_full, contractions_all, pivot = det

    dist_to_pivot = (pivot - close) / pivot if pivot > 0 else 1.0
    above = -dist_to_pivot               # >0 = 現價在壓力線上方
    ma_vol50 = sum(s["v"][-50:]) / 50
    vol_surge = s["v"][i] >= ma_vol50 * CONFIG["BREAKOUT_VOL_MULT"]
    # 突破 = 剛站上壓力線 (0~BREAKOUT_BAND 上方) 且帶量; 遠離壓力線上方則算 extended
    breakout = (0 <= above <= CONFIG["BREAKOUT_BAND"]) and vol_surge

    # 逐級 (strict→standard→loose) 取尾段並判定; 取「最嚴格通過」者為 tier
    tier = None
    contractions = None
    dryup = None
    for name in TIER_ORDER:
        p = CONFIG["PRESETS"][name]
        tail = extract_vcp_tail(contractions_all, p["MAX_CONTRACTIONS"],
                                p["DEPTH_VIOLATIONS_ALLOWED"])
        ncon = len(tail)
        if ncon < p["MIN_CONTRACTIONS"]:
            continue
        fc = tail[0]["depth"]
        lc = tail[-1]["depth"]
        dry = vol_dryup(s, tail)
        viol = depth_decrease_violations(tail)
        low_viol = rising_low_violations(tail)   # 低點要逐步墊高
        hband = high_band(tail)                   # 高點群須都落在同一帶狀內
        ok = (
            ncon <= p["MAX_CONTRACTIONS"]
            and fc <= p["FIRST_CONTRACTION_MAX"]
            and lc <= p["TIGHT_MAX"]
            and viol <= p["DEPTH_VIOLATIONS_ALLOWED"]
            and low_viol <= p["LOW_VIOL_ALLOWED"]
            and hband <= p["HIGH_BAND_MAX"]
            and dist_to_pivot <= p["NEAR_PIVOT_MAX"]
        )
        if ok:
            tier = name
            contractions = tail
            dryup = dry
            break
    if tier is None:
        return None

    base_start = contractions[0]["highIdx"]
    last_contraction = contractions[-1]["depth"]
    violations = depth_decrease_violations(contractions)
    ncon = len(contractions)

    # stage
    near = CONFIG["PRESETS"]["loose"]["NEAR_PIVOT_MAX"]
    bband = CONFIG["BREAKOUT_BAND"]
    if dist_to_pivot > near:
        stage = "watch"               # 遠在壓力線下方
    elif dist_to_pivot >= 0:
        stage = "setup"               # 貼在壓力線下方待突破
    elif above <= bband:
        stage = "breakout" if vol_surge else "setup"   # 剛站上壓力線
    else:
        stage = "extended"            # 已突破且遠離壓力線上方 (延伸)

    score = compute_score(ncon, last_contraction, dryup, dist_to_pivot,
                          violations, tt["rsApprox"])

    return {
        "id": code, "name": s["name"], "market": s["market"],
        "tier": tier, "stage": stage, "score": score,
        "pivot": round(pivot, 2), "lastClose": round(close, 2),
        "distToPivot": round(dist_to_pivot, 4),
        "baseStart": s["dates"][base_start], "baseLen": i - base_start + 1,
        "contractions": [
            {"high": round(ct["high"], 2), "highDate": s["dates"][ct["highIdx"]],
             "low": round(ct["low"], 2), "lowDate": s["dates"][ct["lowIdx"]],
             "depth": round(ct["depth"], 4)}
            for ct in contractions
        ],
        "volDryUp": round(dryup, 3), "tight": last_contraction <= 0.08,
        "rsApprox": round(tt["rsApprox"], 3),
        "_base_start_idx": base_start,
        "_contraction_idx": [(ct["highIdx"], ct["lowIdx"]) for ct in contractions],
    }


def compute_score(ncon, last_contraction, dryup, dist, violations, rs) -> int:
    score = 0.0
    score += min(ncon, 4) / 4 * 25                    # 波數
    score += max(0, 1 - last_contraction / 0.15) * 25  # 越緊越好
    score += max(0, 1 - dryup / 0.9) * 20              # 量縮
    score += max(0, 1 - abs(dist) / 0.10) * 15         # 越貼 pivot (上下都扣分)
    score += (0 if violations else 1) * 10             # 乾淨遞減
    score += min(max(rs - 1.0, 0) / 1.5, 1) * 5        # 動能
    return round(max(0, min(100, score)))


# ── 輸出 ──────────────────────────────────────────────────────────────
def attach_slice(rec: dict, raw: dict, slice_len: int) -> dict:
    """加上近 slice_len 根 OHLC + 標記 index (相對切片)。"""
    n = len(raw["c"])
    start = max(0, n - slice_len)
    base_idx = rec.pop("_base_start_idx")
    con_idx = rec.pop("_contraction_idx")
    rec["ohlc"] = {
        "dates": raw["dates"][start:],
        "o": raw["o"][start:], "h": raw["h"][start:],
        "l": raw["l"][start:], "c": raw["c"][start:], "v": raw["v"][start:],
    }
    rec["markers"] = {
        "pivotLine": rec["pivot"],
        "baseStartIdx": max(0, base_idx - start),
        "contractionZones": [[max(0, a - start), max(0, b - start)] for a, b in con_idx],
    }
    return rec


def write_excel(records: list[dict], as_of: str) -> Path:
    from openpyxl import Workbook
    OUT_XLSX_DIR.mkdir(parents=True, exist_ok=True)
    wb = Workbook()
    ws = wb.active
    ws.title = "VCP"
    headers = ["代號", "名稱", "市場", "tier", "stage", "score",
               "收盤", "Pivot", "距Pivot%", "波數", "首波深%", "末波深%",
               "量縮比", "baseLen", "rsApprox"]
    ws.append(headers)
    for r in sorted(records, key=lambda x: -x["score"]):
        cons = r["contractions"]
        ws.append([
            r["id"], r["name"], r["market"], r["tier"], r["stage"], r["score"],
            r["lastClose"], r["pivot"], round(r["distToPivot"] * 100, 2),
            len(cons), round(cons[0]["depth"] * 100, 1), round(cons[-1]["depth"] * 100, 1),
            r["volDryUp"], r["baseLen"], r["rsApprox"],
        ])
    path = OUT_XLSX_DIR / f"vcp_{as_of}.xlsx"
    wb.save(path)
    return path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("as_of", nargs="?", default=None, help="as-of 日期 YYYYMMDD")
    ap.add_argument("--slice", type=int, default=120, help="OHLC 切片長度")
    ap.add_argument("--no-excel", action="store_true")
    ap.add_argument("--include-etf", action="store_true",
                    help="連 ETF/權證一起掃 (預設只掃 4 碼個股)")
    args = ap.parse_args()

    print("📂 載入全市場快取...", flush=True)
    dates, universe = load_universe(args.as_of)
    as_of = dates[-1]
    if not args.include_etf:
        universe = {c: s for c, s in universe.items() if is_individual_stock(c)}
    print(f"   as-of {as_of}, 共 {len(universe)} 檔"
          f"{'(含ETF)' if args.include_etf else '(只個股)'}, "
          f"{len(dates)} 個交易日", flush=True)

    print("🔍 掃描 VCP...", flush=True)
    records = []
    for code, raw in universe.items():
        try:
            rec = evaluate(code, raw)
        except Exception as e:  # noqa: BLE001
            print(f"  ⚠️ {code}: {e}", file=sys.stderr)
            continue
        if rec:
            records.append(rec)

    by_tier = {t: sum(1 for r in records if r["tier"] == t) for t in TIER_ORDER}
    by_stage = {}
    for r in records:
        by_stage[r["stage"]] = by_stage.get(r["stage"], 0) + 1
    print(f"✅ 通過 {len(records)} 檔  tier={by_tier}  stage={by_stage}", flush=True)

    # 附切片 (排序後取全部; 切片只給通過股票)
    for r in records:
        attach_slice(r, universe[r["id"]], args.slice)
    records.sort(key=lambda x: -x["score"])

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    out = {
        "_meta": {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "asOf": as_of, "scanned": len(universe), "passed": len(records),
            "byTier": by_tier, "byStage": by_stage,
            "params": CONFIG,
        },
        "stocks": records,
    }
    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")
    size_mb = OUT_JSON.stat().st_size / 1024 / 1024
    print(f"💾 {OUT_JSON.relative_to(REPO_ROOT)} ({size_mb:.2f} MB)", flush=True)

    if not args.no_excel:
        try:
            xlsx = write_excel(records, as_of)
            print(f"📊 {xlsx.relative_to(REPO_ROOT)}", flush=True)
        except PermissionError:
            print("⚠️ Excel 寫入被拒 (檔案可能正開啟中), 跳過 — JSON 已輸出",
                  file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
