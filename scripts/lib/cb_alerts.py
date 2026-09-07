"""CB 快訊:掃 all-data.json 的 CB 日交易 / 法人矩陣,挑符合條件的標的,
組一則獨立 Telegram 訊息。

送到哪支 bot:
  設了 TG_CB_BOT_TOKEN + TG_CB_CHAT_ID → 送這支(跟 pipeline 摘要分家)
  沒設 → fallback 用 pipeline 摘要那支 TG_BOT_TOKEN / TG_CHAT_ID

接在 parse_and_export.py Phase 5(寫回 all-data.json)之後呼叫:
    from lib import cb_alerts
    cb_alerts.scan_and_notify(all_data, trade_date)

門檻集中在檔案上方,要調就直接改這幾個常數。

本機驗(印訊息、不送 TG):
    cd scripts && PYTHONUTF8=1 python -m lib.cb_alerts
本機驗(真的送一則,讀 scripts/.env 的 TG_CB_* 或 fallback TG_*):
    cd scripts && PYTHONUTF8=1 python -m lib.cb_alerts --send
"""

from __future__ import annotations

import os
import sys
from typing import Any, Optional

from lib import telegram

# CB 快訊專用 bot / chat(要跟 pipeline 摘要分家就設這兩個環境變數);
# 沒設就 fallback 用 pipeline 摘要那支 TG_BOT_TOKEN / TG_CHAT_ID。
CB_BOT_TOKEN_ENV = "TG_CB_BOT_TOKEN"
CB_CHAT_ID_ENV = "TG_CB_CHAT_ID"

# Windows console UTF-8
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# ── 門檻(要調直接改) ────────────────────────────────────────────────
VOL_MA_DAYS = 20            # 均量回看的「交易日」數(不含當日)

# 條件 A:CB 大量(量能爆增)
BIGVOL_MIN_LOT = 500       # 當日成交量(張)下限
BIGVOL_MA_MULT = 3.0       # 當日量 / 均量 倍數下限

# 條件 B:CB 價漲量增
SURGE_PCT = 3.0            # 收盤漲幅 % 下限
SURGE_VOL_MIN_LOT = 100    # 當日成交量(張)下限
SURGE_VOL_MA_MULT = 2.0    # 當日量 / 均量 倍數下限

# 條件 C:法人單日大買
INST_MIN_LOT = 300        # 單一法人(外資/投信/自營商)單日買超張數下限

MAX_ITEMS_PER_SECT = 15    # 每個區塊最多列幾檔(避免訊息爆長)

_INST_CATS = ("外資買賣超", "投信買賣超", "自營商買賣超")


def _f(x: Any) -> Optional[float]:
    try:
        return float(str(x).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _explode(matrix: Optional[list]) -> tuple[list[str], dict[str, dict]]:
    """把 [代號,名稱,類別,<日期欄...>] 寬表拆成
        (dates, {code: {"name": str, "cats": {類別: [值...]}}})
    代號/名稱只出現在該檔第一列,其餘同檔的列為空字串 → 用 last-seen 補。"""
    if not matrix or len(matrix) < 2:
        return [], {}
    dates = [str(x) for x in matrix[0][3:]]
    out: dict[str, dict] = {}
    cur: Optional[str] = None
    for row in matrix[1:]:
        code = str(row[0]).strip()
        if code:
            cur = code
            out.setdefault(code, {"name": str(row[1]).strip(), "cats": {}})
        if cur is None:
            continue
        out[cur]["cats"][str(row[2]).strip()] = row[3:]
    return dates, out


def _prev_close(series: list, i: int) -> Optional[float]:
    """從 i-1 往前找第一個 > 0 的收盤(跳過停牌/0 欄)。"""
    for k in range(i - 1, -1, -1):
        v = _f(series[k])
        if v and v > 0:
            return v
    return None


def scan(all_data: dict, trade_date: str) -> dict:
    dates_t, rows_t = _explode(all_data.get("cbDailyTrading"))
    if not dates_t:
        return {}
    ti = len(dates_t) - 1          # 寬表最後一欄 = 最新交易日
    tdate = dates_t[ti]

    bigvol: list[tuple] = []
    surge: list[tuple] = []
    for code, rec in rows_t.items():
        vol = rec["cats"].get("成交量(張)")
        close = rec["cats"].get("收盤價")
        if not vol or ti >= len(vol):
            continue
        v_today = _f(vol[ti])
        if not v_today or v_today <= 0:
            continue

        window = [_f(x) for x in vol[max(0, ti - VOL_MA_DAYS):ti]]
        window = [x for x in window if x and x > 0]
        ma = sum(window) / len(window) if window else 0.0
        mult = (v_today / ma) if ma else 0.0
        name = rec["name"]

        if v_today >= BIGVOL_MIN_LOT and mult >= BIGVOL_MA_MULT:
            bigvol.append((code, name, v_today, ma, mult))

        if close and ti < len(close):
            c_today = _f(close[ti])
            c_prev = _prev_close(close, ti)
            if c_today and c_prev:
                pct = (c_today / c_prev - 1) * 100
                if (pct >= SURGE_PCT and v_today >= SURGE_VOL_MIN_LOT
                        and mult >= SURGE_VOL_MA_MULT):
                    surge.append((code, name, pct, c_today, v_today, mult))

    # 條件 C:法人單日大買
    dates_i, rows_i = _explode(all_data.get("cbBondInstitutional"))
    inst: list[tuple] = []
    idate = None
    if dates_i:
        ii = dates_i.index(tdate) if tdate in dates_i else len(dates_i) - 1
        idate = dates_i[ii]
        for code, rec in rows_i.items():
            for cat in _INST_CATS:
                series = rec["cats"].get(cat)
                if not series or ii >= len(series):
                    continue
                val = _f(series[ii])
                if val is not None and val >= INST_MIN_LOT:
                    inst.append((code, rec["name"], cat.replace("買賣超", ""), val))

    return {
        "date": tdate,
        "inst_date": idate,
        "bigvol": sorted(bigvol, key=lambda x: -x[4]),
        "surge": sorted(surge, key=lambda x: -x[2]),
        "inst": sorted(inst, key=lambda x: -x[3]),
    }


def _iso(d: str) -> str:
    return f"{d[:4]}-{d[4:6]}-{d[6:8]}" if d and len(d) == 8 else (d or "?")


def format_msg(r: dict) -> Optional[str]:
    if not r:
        return None
    bigvol, surge, inst = r["bigvol"], r["surge"], r["inst"]
    if not (bigvol or surge or inst):
        return None

    L = [f"🔔 *CB 快訊*  `{_iso(r['date'])}`", ""]

    if bigvol:
        L.append(f"*💥 CB 大量*  量≥{BIGVOL_MIN_LOT:,}張 且 "
                 f"≥{BIGVOL_MA_MULT:g}×{VOL_MA_DAYS}日均量")
        for code, name, v, _ma, mult in bigvol[:MAX_ITEMS_PER_SECT]:
            L.append(f"  `{code}` {name}  {v:,.0f}張  ({mult:.1f}×)")
        if len(bigvol) > MAX_ITEMS_PER_SECT:
            L.append(f"  … 另 {len(bigvol) - MAX_ITEMS_PER_SECT} 檔")
        L.append("")

    if surge:
        L.append(f"*📈 價漲量增*  漲≥{SURGE_PCT:g}% 且 "
                 f"量≥{SURGE_VOL_MA_MULT:g}×均量、≥{SURGE_VOL_MIN_LOT:,}張")
        for code, name, pct, c, v, _m in surge[:MAX_ITEMS_PER_SECT]:
            L.append(f"  `{code}` {name}  +{pct:.1f}%  收{c:g}  {v:,.0f}張")
        if len(surge) > MAX_ITEMS_PER_SECT:
            L.append(f"  … 另 {len(surge) - MAX_ITEMS_PER_SECT} 檔")
        L.append("")

    if inst:
        note = ""
        if r.get("inst_date") and r["inst_date"] != r["date"]:
            note = f"  (資料日 {_iso(r['inst_date'])})"
        L.append(f"*🏦 法人單日大買*  單一法人 ≥{INST_MIN_LOT:,}張{note}")
        for code, name, who, val in inst[:MAX_ITEMS_PER_SECT]:
            L.append(f"  `{code}` {name}  {who} +{val:,.0f}張")
        if len(inst) > MAX_ITEMS_PER_SECT:
            L.append(f"  … 另 {len(inst) - MAX_ITEMS_PER_SECT} 檔")
        L.append("")

    return "\n".join(L).rstrip()


def scan_and_notify(all_data: dict, trade_date: str, *,
                    send: bool = True) -> dict:
    """掃 + 送。回傳 status dict 供 log / summary。絕不拋例外給呼叫端。"""
    try:
        r = scan(all_data, trade_date)
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️ CB 快訊 scan 例外: {exc}", file=sys.stderr)
        return {"status": "fail", "error": str(exc)}

    msg = format_msg(r)
    if not msg:
        return {"status": "empty"}

    counts = {"bigvol": len(r["bigvol"]), "surge": len(r["surge"]),
              "inst": len(r["inst"])}
    if not send:
        print(msg)
        return {"status": "dry", **counts}

    token = os.environ.get(CB_BOT_TOKEN_ENV, "").strip() or None
    chat_id = os.environ.get(CB_CHAT_ID_ENV, "").strip() or None
    ok = telegram.send(msg, token=token, chat_id=chat_id)
    return {"status": "ok" if ok else "fail",
            "bot": "cb" if token else "pipeline", **counts}


# ── 本機 CLI ────────────────────────────────────────────────────────
def _cli() -> int:
    import json
    from pathlib import Path

    try:
        from dotenv import load_dotenv
        load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)
    except ImportError:
        pass

    do_send = "--send" in sys.argv[1:]
    data_json = Path(__file__).resolve().parents[2] / "data" / "all-data.json"
    all_data = json.loads(data_json.read_text(encoding="utf-8"))
    res = scan_and_notify(all_data, "", send=do_send)
    print("\n>>>", res)
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
