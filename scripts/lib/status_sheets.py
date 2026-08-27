"""個股狀態抓取 (新高 / 強勢 / 三線開花) → dict[stock_code, details]。

資料來源: 藏鋒資本趨勢選股 https://jacky99714.github.io/ZF_TrendPicking/
  - data/index.json          → {generated_at, months[], stocks:{id:{n,m,i,e,ms}}}
  - data/months/YYYY-MM.json → [{d, id, t, s, h, r, g}, ...]

欄位語意 (對齊該站前端):
  t = 'vcp' → 強勢/新高 系列, 旗標 s=強勢, h=新高
  t = 'sx'  → 三線開花
  r = 近20日漲幅(%), g = 差距比

抓法:
  只取近 MONTHS_BACK 個月的 month json (同一份 JSON 三個 key 共用,module 內快取),
  以「出現日期集合」算 streak (從最新交易日往回連續上榜天數) 與 total。

跑法 (smoke):
  python -m lib.status_sheets
"""

from __future__ import annotations

import sys
from typing import Any, Optional

import requests

# Windows console UTF-8
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

BASE_URL = "https://jacky99714.github.io/ZF_TrendPicking/data"
TIMEOUT = 60
MONTHS_BACK = 3          # 近 3 個月 (~60 交易日) 足夠算 streak,也不用扛 20+MB
MARKET = "tw"            # 只要台股 (該站另有美股 'us')

# 三個狀態欄位。matcher: 一筆 month record 是否算這個狀態
SOURCES: dict[str, dict[str, Any]] = {
    "newhigh": {
        "name": "新高",
        "matcher": lambda e: e.get("t") == "vcp" and bool(e.get("h")),
        "fields": {"r": "gain20"},
    },
    "strong": {
        "name": "強勢",
        "matcher": lambda e: e.get("t") == "vcp" and bool(e.get("s")),
        "fields": {"r": "gain20"},
    },
    "sanxian": {
        "name": "三線開花",
        "matcher": lambda e: e.get("t") == "sx",
        "fields": {"r": "gain20", "g": "diffPct"},
    },
}

# module 內快取:三個 key 共用同一份下載
_CACHE: dict[str, Any] = {"index": None, "months": {}}


def _get_json(path: str) -> Any:
    r = requests.get(f"{BASE_URL}/{path}", timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()


def _load_index() -> dict[str, Any]:
    if _CACHE["index"] is None:
        idx = _get_json("index.json")
        if not isinstance(idx, dict) or not idx.get("months"):
            raise RuntimeError("index.json 格式異常 (無 months)")
        _CACHE["index"] = idx
    return _CACHE["index"]


def _load_month(month: str) -> list[dict]:
    if month not in _CACHE["months"]:
        data = _get_json(f"months/{month}.json")
        if not isinstance(data, list):
            raise RuntimeError(f"{month}.json 格式異常 (非 list)")
        _CACHE["months"][month] = data
    return _CACHE["months"][month]


def _load_records() -> tuple[list[dict], dict[str, Any]]:
    """近 MONTHS_BACK 個月、市場 = MARKET 的所有紀錄 + index。"""
    idx = _load_index()
    stocks_meta = idx.get("stocks") or {}
    months = list(idx["months"])[:MONTHS_BACK]   # index.months 已是新→舊
    records: list[dict] = []
    for m in months:
        for e in _load_month(m):
            meta = stocks_meta.get(e.get("id"))
            if not meta or meta.get("m") != MARKET:
                continue
            records.append(e)
    if not records:
        raise RuntimeError(f"近 {MONTHS_BACK} 個月無任何 {MARKET} 紀錄")
    return records, idx


def _stringify(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, float):
        if v.is_integer():
            return str(int(v))
        return f"{v:.4f}".rstrip("0").rstrip(".")
    return str(v).strip()


def _is_valid_code(s: str) -> bool:
    return s.isdigit() and 4 <= len(s) <= 6


def fetch_one(key: str) -> dict[str, Any]:
    """單一狀態 → {date, stocks, sheetsScanned}。失敗 raise RuntimeError。

    date          = 最新交易日 (YYYY-MM-DD)
    sheetsScanned = 掃到的交易日數
    stocks[code]  = {..明細.., streak, total}
      - streak: 從最新交易日往回連續上榜天數 (今天首上榜=1)
      - total : 在時間範圍內累計上榜天數
    """
    spec = SOURCES[key]
    try:
        records, _ = _load_records()
    except requests.RequestException as e:
        raise RuntimeError(f"{spec['name']}: 下載失敗: {e}") from e

    matcher = spec["matcher"]
    fields = spec["fields"]

    all_dates = sorted({e["d"] for e in records if e.get("d")}, reverse=True)
    if not all_dates:
        raise RuntimeError(f"{spec['name']}: 無任何交易日")
    latest = all_dates[0]

    # 每檔的「上榜日期集合」+ 最新日的明細
    appearance: dict[str, set[str]] = {}
    latest_row: dict[str, dict] = {}
    for e in records:
        if not matcher(e):
            continue
        code = _stringify(e.get("id"))
        if not _is_valid_code(code):
            continue
        d = e.get("d")
        if not d:
            continue
        appearance.setdefault(code, set()).add(d)
        if d == latest:
            latest_row[code] = e

    if not latest_row:
        raise RuntimeError(f"{spec['name']}: 最新日 {latest} 無資料")

    stocks: dict[str, dict[str, Any]] = {}
    for code, e in latest_row.items():
        item: dict[str, Any] = {}
        for src_key, field_name in fields.items():
            val = _stringify(e.get(src_key))
            if val:
                item[field_name] = val
        appear_set = appearance.get(code, set())
        streak = 0
        for d in all_dates:
            if d in appear_set:
                streak += 1
            else:
                break
        item["streak"] = streak
        item["total"] = len(appear_set)
        stocks[code] = item

    return {"date": latest, "stocks": stocks, "sheetsScanned": len(all_dates)}


def fetch_all() -> dict[str, dict[str, Any]]:
    """抓三個狀態,個別失敗不影響其他。回傳 dict 會省略失敗的 key。"""
    out: dict[str, dict[str, Any]] = {}
    for key in SOURCES:
        try:
            out[key] = fetch_one(key)
        except Exception as e:  # noqa: BLE001
            print(f"⚠️ status_sheets[{key}]: {e}", file=sys.stderr, flush=True)
    return out


# ── Smoke test ────────────────────────────────────────────────────────
def _smoke() -> int:
    for key in SOURCES:
        try:
            res = fetch_one(key)
            print(f"[{key}] date={res['date']} days={res['sheetsScanned']} "
                  f"stocks={len(res['stocks'])}")
            top = sorted(res["stocks"].items(),
                         key=lambda kv: kv[1].get("streak", 0), reverse=True)[:5]
            for code, details in top:
                s, t = details.get("streak"), details.get("total")
                print(f"  {code}: streak={s} total={t} {details}")
        except Exception as e:
            print(f"[{key}] FAIL: {e}")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(_smoke())
