#!/usr/bin/env python3
"""強勢個股掃描器 — 全台股相對強度(RS)+ 動能創新高 + 量價齊揚。

讀 build_universe.py 建的本地快取 (scripts/cache/universe/*.json)，對每檔個股：
  1. 前處理 (forward-fill 停牌、標記除權息斷點)  [lib.universe.preprocess]
  2. 除權息「向後還原」— 大額配息/減資的向下跳空會把長期報酬算歪，
     用斷點比例把歷史價回推成連續序列 (adj_c/adj_h)，供 RS 與均線計算
  3. 流動性/體質過濾 (收盤≥10、近50日均額≥門檻、歷史≥門檻根)
  4. 三訊號：
       RS  ─ 加權報酬 0.4×3月 +0.2×6月 +0.2×9月 +0.2×12月 → 全市場百分位 1~99
       動能 ─ 均線多頭排列(收>MA20>MA60>MA120)、距52週高、突破新高、MA 上揚
       量價 ─ 近5日均量/近60日均量、上漲量/下跌量(累積)、當日爆量
  5. 綜合分數 = 0.5×RS + 0.3×動能 + 0.2×量價 (0~100)
  6. 只輸出 RS ≥ RS_OUTPUT_MIN 的股票 + 近 slice 根 OHLC 切片(前端迷你K線)

輸出:
  data/strength.json               RS≥門檻股票 + 各訊號分數 + OHLC 切片 (前端用)
  scripts/output/strength_<asOf>.xlsx   攤平排行表 (離線檢視)

用法:
  python strength_scanner.py              # 用快取最新日期掃描
  python strength_scanner.py 20260708     # 指定 as-of 日期
  python strength_scanner.py --no-excel   # 不輸出 Excel (CI 用)
  python strength_scanner.py --slice 120  # OHLC 切片長度 (預設 120)
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import universe as U  # noqa: E402

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
CACHE_DIR = SCRIPT_DIR / "cache" / "universe"
OUT_JSON = REPO_ROOT / "data" / "strength.json"
ALL_DATA_JSON = REPO_ROOT / "data" / "all-data.json"   # 產業別來源 (stockIndustry)
OUT_XLSX_DIR = SCRIPT_DIR / "output"

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass


# ── 參數 (集中可調) ───────────────────────────────────────────────────
CONFIG = {
    # 前處理 / 流動性
    "MIN_HISTORY_BARS": 120,          # 至少 ~6 個月 (算 MA120 + 半年報酬)
    "MIN_CLOSE": 10.0,                # 收盤 < 10 元剔除
    "MIN_AVG_TURNOVER": 20_000_000,   # 近 50 日均成交金額 (元)
    "GAP_BREAK_PCT": 0.15,            # 單日向下跳空 >15% 視為除權息斷點

    # RS 加權報酬 (交易日) 與權重 — 缺歷史時只用可算的期間並重新正規化
    "RS_PERIODS": [(63, 0.4), (126, 0.2), (189, 0.2), (252, 0.2)],
    "RS_MIN_PERIOD": 63,              # 至少要能算 3 個月報酬才納入排名
    "RS_OUTPUT_MIN": 70,             # 只輸出 RS ≥ 此值 (前端預設再篩 ≥90)

    # 動能
    "DIST_52W_HIGH_FULL": 0.0,        # 距高 0% = 滿分
    "DIST_52W_HIGH_ZERO": 0.25,       # 距高 ≥25% = 0 分
    "NEWHIGH_LOOKBACK_SHORT": 60,     # 短波段新高回看
    "NEWHIGH_LOOKBACK_LONG": 252,     # 52 週新高回看
    "MA_SLOPE_LOOKBACK": 21,          # MA 上揚判定回看天數

    # 量價
    "VOL_FAST": 5,                    # 近期量均線
    "VOL_SLOW": 60,                   # 基準量均線
    "ACCUM_LOOKBACK": 25,             # 上漲量/下跌量統計視窗
    "TURNOVER_MA": 50,                # 流動性均額視窗

    # 綜合分數權重
    "W_RS": 0.5, "W_MOM": 0.3, "W_VOL": 0.2,

    # 操作狀態 stage (依序判定, 互斥四態) — 門檻經真實資料校準, 見 docs/FEATURES.md §7.2
    "STAGE_WATCH_DIST": 0.25,        # 距52週高 >25% 或跌破 MA60 → 修正觀察
                                     #   (25% = Minervini 趨勢樣板的 Stage 2 上限)
    "STAGE_BREAKOUT_DIST": 0.05,     # 突破: 距高 ≤5%
    "STAGE_BREAKOUT_DAYS": 5,        #   「且」近5日內剛創過52週高 (必須同時成立!
                                     #    用「或」會把 5 天前創高、之後暴跌 14% 的
                                     #    失敗突破 (如 3675 德微) 誤判成正在突破)
    "STAGE_BREAKOUT_VOLRATIO": 1.3,  #   且帶量: 5/60 量比 ≥1.3
    "STAGE_BREAKOUT_TODAY": 1.5,     #        或 當日量/50日均量 ≥1.5
    "STAGE_SETUP_DIST": 0.10,        # 距高 ≤10% → 貼高蓄勢; 10~25% → 回檔整理

    # ⚠️ 延伸過熱 = 獨立風險旗標, 可疊加在任何 stage 上 (不是第五種狀態)
    #   刻意不做成互斥狀態: 「今天爆量創新高」與「乖離37%已噴出」是兩個不同軸的
    #   事實, 壓成單一標籤必然丟掉一半資訊 (如 6182 合晶 兩者皆是)。
    "EXT_HOT_MA20": 0.15,            # 對 MA20 乖離 ≥15% → 已噴出, 追高風險大

    # 族群 (產業) 強度
    "GROUP_MIN_MEMBERS": 15,      # 成分股 <此數不給強度排名 (5~8 檔的中位數太噪:
                                  #   金融業僅5檔、RS≥90掛零, 卻能拿到強度 90)
    "GROUP_SHRINK_K": 10,         # 小樣本收縮: 把中位數往市場中位(50)拉, 樣本越小拉越多
}

STAGES = ["breakout", "setup", "pullback", "watch"]

# 上市/上櫃對同一產業用不同名稱 → 合併同義字 (否則同產業被拆成兩個族群)
GROUP_ALIASES = {
    "其他電子類": "其他電子業",
    "居家生活類": "居家生活",
    "數位雲端類": "數位雲端",
    "綠能環保類": "綠能環保",
    "運動休閒類": "運動休閒",
    "金融業": "金融保險",
}
# 混合垃圾桶: 仍標在個股上, 但不給族群強度排名 (成分互不相關, 強度無意義)
GROUP_NO_RANK = {"其他"}


def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


# ── 產業別 / 概念股 (來自 all-data.json 的 stockIndustry) ──────────────
def load_industry() -> dict[str, dict]:
    """{code: {'group':次產業, 'themes':[概念股...]}}；任何異常都回 {} (不分群但不炸)。

    ⚠️ 上市/上櫃分類欄位不一致:
      上市 → 產業分類1='電子工業', 產業分類2='半導體業'  (細分在 ind2)
      其他 → 產業分類1='半導體業', 產業分類2='-'         (細分在 ind1)
    故分群鍵 = ind2 if ind2 not in ('','-') else ind1。
    """
    if not ALL_DATA_JSON.exists():
        print("⚠️ 找不到 data/all-data.json → 不做族群分群", file=sys.stderr, flush=True)
        return {}
    try:
        rows = json.loads(ALL_DATA_JSON.read_text(encoding="utf-8")).get("stockIndustry")
    except Exception as e:  # noqa: BLE001
        print(f"⚠️ 讀 all-data.json 失敗 ({e}) → 不做族群分群", file=sys.stderr, flush=True)
        return {}
    if not rows or len(rows) < 2:
        return {}
    hdr = rows[0]
    try:
        i_code = hdr.index("代號")
        i_i1 = hdr.index("產業分類1")
        i_i2 = hdr.index("產業分類2")
    except (ValueError, AttributeError):
        print("⚠️ stockIndustry 欄位不符預期 → 不做族群分群", file=sys.stderr, flush=True)
        return {}
    out: dict[str, dict] = {}
    for r in rows[1:]:
        if len(r) <= i_i2:
            continue
        code = str(r[i_code]).strip()
        i1 = str(r[i_i1] or "").strip()
        i2 = str(r[i_i2] or "").strip()
        group = i2 if i2 and i2 != "-" else i1
        group = GROUP_ALIASES.get(group, group)
        themes = [str(t).strip() for t in r[i_i2 + 1:]
                  if t and str(t).strip() not in ("", "-")]
        if code and group and group != "-":
            out[code] = {"group": group, "themes": themes}
    return out


# ── 操作狀態 stage ────────────────────────────────────────────────────
def classify_stage(close: float, ma60: float | None, dist_high: float,
                   ext_ma20: float, days_since_high: int,
                   vol_ratio: float, today_mult: float) -> tuple[str, bool]:
    """回傳 (stage, extended)。stage 四態互斥；extended 是可疊加的風險旗標。

    stage — 位置/動作 (「現在在哪、正在做什麼」)
      watch    修正觀察: 距高 >25% 或跌破 MA60 → 強勢已破壞
      breakout 突破中  : 距高 ≤5% 且 近5日剛創高 且 帶量 → 正在發動, 最可操作
      setup    貼高蓄勢: 距高 ≤10% → 在買點附近等突破
      pullback 回檔整理: 距高 10~25% 且站上 MA60 → 仍強, 但需重建型態

    extended — 風險 (「追進去會不會被套」)
      對 MA20 乖離 ≥15% → 已噴出。與 stage 正交, 例如 6182 合晶 = 突破中 + ⚠️延伸
    """
    extended = ext_ma20 >= CONFIG["EXT_HOT_MA20"]

    if dist_high > CONFIG["STAGE_WATCH_DIST"] or (ma60 and close < ma60):
        return "watch", extended

    vol_ok = (vol_ratio >= CONFIG["STAGE_BREAKOUT_VOLRATIO"]
              or today_mult >= CONFIG["STAGE_BREAKOUT_TODAY"])
    # 「貼著高點」與「剛創過高」須同時成立 — 否則是失敗突破
    fresh = (dist_high <= CONFIG["STAGE_BREAKOUT_DIST"]
             and days_since_high <= CONFIG["STAGE_BREAKOUT_DAYS"])
    if fresh and vol_ok:
        return "breakout", extended
    if dist_high <= CONFIG["STAGE_SETUP_DIST"]:
        return "setup", extended
    return "pullback", extended


# ── 乾淨區間 ──────────────────────────────────────────────────────────
def clean_start(s: dict) -> int:
    """最近一次除權息/分割/減資斷點之後的 index；無斷點回 0。
    報酬與新高一律只在此之後量測，避免跨越價格不連續點(分割會低估、暴跌/減資
    假象會高估)。斷點兩邊分屬不同「價格制度」，不做跨區間比較。"""
    breaks = s.get("breaks")
    return max(breaks) if breaks else 0


# ── 訊號計算 ──────────────────────────────────────────────────────────
def period_return(c: list[float], period: int, i: int, floor: int = 0) -> float | None:
    """i 往回 period 根的報酬；起點若早於 floor(乾淨區間起點)或無效則回 None。"""
    j = i - period
    if j < floor or j < 0 or c[j] <= 0:
        return None
    return c[i] / c[j] - 1.0


def rs_raw_return(c: list[float], i: int, floor: int) -> float | None:
    """加權報酬；缺歷史或跨斷點的期間跳過，權重重新正規化。"""
    total_w, acc = 0.0, 0.0
    got_min = False
    for period, w in CONFIG["RS_PERIODS"]:
        r = period_return(c, period, i, floor)
        if r is None:
            continue
        if period <= CONFIG["RS_MIN_PERIOD"]:
            got_min = True
        acc += w * r
        total_w += w
    if not got_min or total_w == 0:
        return None
    return acc / total_w


def momentum(s: dict, floor: int) -> dict:
    c, h = s["c"], s["h"]
    i = len(c) - 1
    close = c[i]
    ma20 = U.sma(c, 20, i)
    ma60 = U.sma(c, 60, i)
    ma120 = U.sma(c, 120, i)
    # 52 週高：回看窗不跨斷點
    win_start = max(floor, i - CONFIG["NEWHIGH_LOOKBACK_LONG"] + 1)
    win = h[win_start:i + 1]
    hi52 = max(win)
    dist_high = (hi52 - close) / hi52 if hi52 > 0 else 1.0
    # 距上次創 52 週高幾個交易日 (今天創高 = 0)
    days_since_high = len(win) - 1 - max(k for k, v in enumerate(win) if v >= hi52 - 1e-9)
    ext_ma20 = (close - ma20) / ma20 if ma20 else 0.0

    # 均線多頭排列 (逐條計分)
    align_bits = 0
    if ma20 and close > ma20:
        align_bits += 1
    if ma20 and ma60 and ma20 > ma60:
        align_bits += 1
    if ma60 and ma120 and ma60 > ma120:
        align_bits += 1
    ma_aligned = align_bits == 3

    # 突破新高 (盤中高)；短窗同樣不跨斷點
    short_start = max(floor, i - CONFIG["NEWHIGH_LOOKBACK_SHORT"] + 1)
    new_high_short = h[i] >= max(h[short_start:i + 1]) - 1e-9
    new_high_long = h[i] >= hi52 - 1e-9

    # MA60 上揚
    ma60_prev = U.sma(c, 60, i - CONFIG["MA_SLOPE_LOOKBACK"])
    ma_rising = bool(ma60 and ma60_prev and ma60 > ma60_prev)

    ret1m = period_return(c, 21, i, floor) or 0.0

    d0, d1 = CONFIG["DIST_52W_HIGH_FULL"], CONFIG["DIST_52W_HIGH_ZERO"]
    score = 0.0
    score += align_bits / 3 * 30
    score += clamp((d1 - dist_high) / (d1 - d0)) * 25
    score += 20 if new_high_long else (12 if new_high_short else 0)
    score += clamp(ret1m / 0.20) * 15
    score += 10 if ma_rising else 0

    return {
        "score": round(clamp(score, 0, 100), 1),
        "distHigh": round(dist_high, 4),
        "daysSinceHigh": days_since_high,
        "extMa20": round(ext_ma20, 4),
        "ma60Raw": ma60,
        "maAligned": ma_aligned,
        "aboveMa": {
            "ma20": bool(ma20 and close > ma20),
            "ma60": bool(ma60 and close > ma60),
            "ma120": bool(ma120 and close > ma120),
        },
        "newHigh": {"short": bool(new_high_short), "long": bool(new_high_long)},
        "maRising": ma_rising,
        "hi52": round(hi52, 2),
        "ma": {
            "ma20": round(ma20, 2) if ma20 else None,
            "ma60": round(ma60, 2) if ma60 else None,
            "ma120": round(ma120, 2) if ma120 else None,
        },
    }


def volume_price(s: dict) -> dict:
    c, v = s["c"], s["v"]
    i = len(c) - 1
    fast_w = min(CONFIG["VOL_FAST"], len(v))
    slow_w = min(CONFIG["VOL_SLOW"], len(v))
    vfast = sum(v[-fast_w:]) / fast_w if fast_w else 0
    vslow = sum(v[-slow_w:]) / slow_w if slow_w else 0
    vol_ratio = (vfast / vslow) if vslow > 0 else 0.0

    # 累積: 上漲日量 vs 下跌日量
    lb = min(CONFIG["ACCUM_LOOKBACK"], len(c) - 1)
    up_vol, dn_vol = 0.0, 0.0
    for j in range(i - lb + 1, i + 1):
        if j <= 0:
            continue
        if c[j] > c[j - 1]:
            up_vol += v[j]
        elif c[j] < c[j - 1]:
            dn_vol += v[j]
    accum = (up_vol / dn_vol) if dn_vol > 0 else (2.0 if up_vol > 0 else 1.0)

    # 當日量 vs 50日均量
    ma_w = min(CONFIG["TURNOVER_MA"], len(v))
    v_ma = sum(v[-ma_w:]) / ma_w if ma_w else 0
    today_mult = (v[i] / v_ma) if v_ma > 0 else 0.0

    score = 0.0
    score += clamp((vol_ratio - 0.8) / (2.0 - 0.8)) * 45
    score += clamp((accum - 0.8) / (1.8 - 0.8)) * 35
    score += clamp((today_mult - 1.0) / 1.0) * 20

    return {
        "score": round(clamp(score, 0, 100), 1),
        "volRatio": round(vol_ratio, 2),
        "accum": round(accum, 2),
        "todayMult": round(today_mult, 2),
    }


def avg_turnover(s: dict) -> float:
    c, v = s["c"], s["v"]
    w = min(CONFIG["TURNOVER_MA"], len(c))
    if w == 0:
        return 0.0
    return sum(c[k] * v[k] for k in range(len(c) - w, len(c))) / w


# ── 每檔評估 ──────────────────────────────────────────────────────────
def evaluate(code: str, raw: dict, industry: dict[str, dict] | None = None) -> dict | None:
    s = U.preprocess(raw, min_history=CONFIG["MIN_HISTORY_BARS"],
                     gap_break_pct=CONFIG["GAP_BREAK_PCT"])
    if s is None:
        return None
    i = len(s["c"]) - 1
    close = s["c"][i]
    if close < CONFIG["MIN_CLOSE"]:
        return None
    if avg_turnover(s) < CONFIG["MIN_AVG_TURNOVER"]:
        return None

    floor = clean_start(s)
    rs_raw = rs_raw_return(s["c"], i, floor)
    if rs_raw is None:
        return None

    mom = momentum(s, floor)
    vol = volume_price(s)

    prev = s["c"][i - 1] if i >= 1 and s["c"][i - 1] > 0 else close
    chg_pct = (close - prev) / prev * 100 if prev > 0 else 0.0

    # 連續上漲根數
    consec = 0
    for j in range(i, 0, -1):
        if s["c"][j] > s["c"][j - 1]:
            consec += 1
        else:
            break

    stage, extended = classify_stage(
        close, mom["ma60Raw"], mom["distHigh"], mom["extMa20"],
        mom["daysSinceHigh"], vol["volRatio"], vol["todayMult"])
    meta = (industry or {}).get(code) or {}

    return {
        "id": code, "name": s["name"], "market": s["market"],
        "group": meta.get("group", ""), "themes": meta.get("themes", [])[:6],
        "stage": stage, "extended": extended,
        "daysSinceHigh": mom["daysSinceHigh"], "extMa20": mom["extMa20"],
        "close": round(close, 2), "chgPct": round(chg_pct, 2),
        "rsRaw": rs_raw,  # 暫存原始加權報酬，稍後轉百分位
        "ret3m": round((period_return(s["c"], 63, i, floor) or 0) * 100, 1),
        "ret6m": round((period_return(s["c"], 126, i, floor) or 0) * 100, 1),
        "ret12m": round((period_return(s["c"], 252, i, floor) or 0) * 100, 1),
        "momScore": mom["score"], "volScore": vol["score"],
        "distHigh": mom["distHigh"], "maAligned": mom["maAligned"],
        "aboveMa": mom["aboveMa"], "newHigh": mom["newHigh"],
        "maRising": mom["maRising"], "hi52": mom["hi52"], "ma": mom["ma"],
        "volRatio": vol["volRatio"], "accum": vol["accum"],
        "todayMult": vol["todayMult"], "consecUp": consec,
    }


def assign_rs_percentile(records: list[dict]) -> None:
    """把 rsRaw 轉成全市場百分位 RS 1~99 (就地寫入 record['rs'])。"""
    n = len(records)
    if n == 0:
        return
    order = sorted(range(n), key=lambda k: records[k]["rsRaw"])
    for rank, k in enumerate(order):
        frac = rank / (n - 1) if n > 1 else 1.0
        records[k]["rs"] = round(1 + 98 * frac)


def composite(rec: dict) -> int:
    score = (CONFIG["W_RS"] * rec["rs"]
             + CONFIG["W_MOM"] * rec["momScore"]
             + CONFIG["W_VOL"] * rec["volScore"])
    return round(clamp(score, 0, 100))


def compute_groups(records: list[dict]) -> list[dict]:
    """族群強度。**必須在 RS 門檻篩選前呼叫** — 要用全部通過流動性的個股, 否則
    中位數只算到 RS≥70 的倖存者, 每個族群都會虛高。

    強度 = 族群內 RS 的「中位數」→ 小樣本收縮 → 再對族群做百分位 (1~99)。

    - 用中位數而非平均: 避免一兩檔妖股 (如 +1198% 的禾伸堂) 把整個族群拉高,
      我們要的是「這族群整體在漲」而不是「這族群有一檔在飛」。
    - 小樣本收縮 (empirical Bayes): adj = (n×med + K×50) / (n+K)。
      8 檔的族群中位數太噪 — 未收縮時「化學工業」(8檔, RS≥90 僅1檔) 強度 96,
      竟排在「電子零組件業」(160檔, RS≥90 有39檔) 之前。
    - 成分股 < GROUP_MIN_MEMBERS 或屬 GROUP_NO_RANK 者不排名 (strength=None)。
    """
    by: dict[str, list[dict]] = {}
    for r in records:
        if r.get("group"):
            by.setdefault(r["group"], []).append(r)

    k_shrink = CONFIG["GROUP_SHRINK_K"]
    groups = []
    for name, mem in by.items():
        rs_list = [m["rs"] for m in mem]
        n = len(rs_list)
        med = statistics.median(rs_list)
        leader = max(mem, key=lambda m: m["rs"])
        groups.append({
            "name": name,
            "count": n,
            "rsMedian": round(med, 1),
            "_adj": (n * med + k_shrink * 50) / (n + k_shrink),
            "rs90": sum(1 for x in rs_list if x >= 90),
            "leader": {"id": leader["id"], "name": leader["name"], "rs": leader["rs"]},
            "strength": None,
        })

    ranked = [g for g in groups
              if g["count"] >= CONFIG["GROUP_MIN_MEMBERS"]
              and g["name"] not in GROUP_NO_RANK]
    ranked.sort(key=lambda g: g["_adj"])
    n = len(ranked)
    for k, g in enumerate(ranked):
        g["strength"] = round(1 + 98 * (k / (n - 1))) if n > 1 else 99

    for g in groups:
        g.pop("_adj", None)
    groups.sort(key=lambda g: (g["strength"] is None, -(g["strength"] or 0)))
    return groups


# ── 輸出 ──────────────────────────────────────────────────────────────
def attach_slice(rec: dict, raw: dict, slice_len: int) -> None:
    n = len(raw["c"])
    start = max(0, n - slice_len)
    rec["ohlc"] = {
        "dates": raw["dates"][start:],
        "o": raw["o"][start:], "h": raw["h"][start:],
        "l": raw["l"][start:], "c": raw["c"][start:], "v": raw["v"][start:],
    }


def write_excel(records: list[dict], as_of: str) -> Path:
    from openpyxl import Workbook
    OUT_XLSX_DIR.mkdir(parents=True, exist_ok=True)
    wb = Workbook()
    ws = wb.active
    ws.title = "Strength"
    stage_label = {"breakout": "突破中", "setup": "貼高蓄勢",
                   "pullback": "回檔整理", "watch": "修正觀察"}
    headers = ["代號", "名稱", "市場", "狀態", "延伸過熱", "族群",
               "總分", "RS", "動能分", "量價分",
               "收盤", "漲跌%", "距52週高%", "距高天數", "MA20乖離%",
               "3月%", "6月%", "12月%", "均線多頭", "創52週高", "量比", "累積比", "連漲"]
    ws.append(headers)
    for r in sorted(records, key=lambda x: -x["score"]):
        ws.append([
            r["id"], r["name"], r["market"], stage_label.get(r["stage"], r["stage"]),
            "⚠️" if r["extended"] else "",
            r.get("group", ""), r["score"], r["rs"],
            r["momScore"], r["volScore"], r["close"], r["chgPct"],
            round(r["distHigh"] * 100, 1), r["daysSinceHigh"],
            round(r["extMa20"] * 100, 1),
            r["ret3m"], r["ret6m"], r["ret12m"],
            "✓" if r["maAligned"] else "", "✓" if r["newHigh"]["long"] else "",
            r["volRatio"], r["accum"], r["consecUp"],
        ])
    path = OUT_XLSX_DIR / f"strength_{as_of}.xlsx"
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
    dates, uni = U.load_universe(CACHE_DIR, args.as_of)
    as_of = dates[-1]
    if not args.include_etf:
        uni = {c: s for c, s in uni.items() if U.is_individual_stock(c)}
    print(f"   as-of {as_of}, 共 {len(uni)} 檔"
          f"{'(含ETF)' if args.include_etf else '(只個股)'}, "
          f"{len(dates)} 個交易日", flush=True)

    industry = load_industry()
    print(f"🏷️  產業別: {len(industry)} 檔有分類", flush=True)

    print("🔍 計算強勢訊號...", flush=True)
    records = []
    for code, raw in uni.items():
        try:
            rec = evaluate(code, raw, industry)
        except Exception as e:  # noqa: BLE001
            print(f"  ⚠️ {code}: {e}", file=sys.stderr)
            continue
        if rec:
            records.append(rec)

    # RS 百分位需先看過「全部通過流動性的股票」，再依 RS 門檻篩選
    assign_rs_percentile(records)
    for r in records:
        r["score"] = composite(r)
        r.pop("rsRaw", None)

    # ⚠️ 族群強度必須在 RS 篩選「之前」算 (要全體 1050 檔, 不是 RS≥70 的倖存者)
    groups = compute_groups(records)

    scanned = len(records)
    records = [r for r in records if r["rs"] >= CONFIG["RS_OUTPUT_MIN"]]
    records.sort(key=lambda x: -x["score"])
    for r in records:
        attach_slice(r, uni[r["id"]], args.slice)

    strong90 = sum(1 for r in records if r["rs"] >= 90)
    by_stage = {s: sum(1 for r in records if r["stage"] == s) for s in STAGES}
    n_ext = sum(1 for r in records if r["extended"])
    print(f"✅ 通過流動性 {scanned} 檔 → 輸出 RS≥{CONFIG['RS_OUTPUT_MIN']} "
          f"共 {len(records)} 檔 (其中 RS≥90: {strong90})", flush=True)
    print(f"   stage: {by_stage}  ⚠️延伸旗標: {n_ext} 檔", flush=True)
    print(f"   族群: {len(groups)} 個 (有排名 "
          f"{sum(1 for g in groups if g['strength'] is not None)})", flush=True)

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    out = {
        "_meta": {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "asOf": as_of, "scanned": scanned, "output": len(records),
            "strong90": strong90, "byStage": by_stage, "extended": n_ext,
            "params": CONFIG,
        },
        "groups": groups,
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
            print("⚠️ Excel 寫入被拒 (檔案可能開啟中), 跳過 — JSON 已輸出",
                  file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
