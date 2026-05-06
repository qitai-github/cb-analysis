"""Telegram bot 通知 helper。

Markdown V1 (普通 *bold* / `code`)。失敗時 silent (印 stderr,不拋例外)。

跑法 (本機驗 bot 通):
  python -m lib.telegram smoke
"""

from __future__ import annotations

import os
import sys
from typing import Any, Optional

import requests

# Windows console UTF-8 (印 emoji 會炸)
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

API_TPL = "https://api.telegram.org/bot{token}/sendMessage"
TIMEOUT = 15
TG_MSG_LIMIT = 4096


def _truncate(text: str, limit: int = TG_MSG_LIMIT) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 30] + "\n\n... (訊息截斷)"


def send(text: str, *, parse_mode: str = "Markdown") -> bool:
    """送一則訊息。回傳 True/False;通知失敗印 stderr,絕不拋例外。"""
    token = os.environ.get("TG_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TG_CHAT_ID", "").strip()
    if not token or not chat_id:
        print("⚠️ TG_BOT_TOKEN / TG_CHAT_ID 未設定,通知跳過", file=sys.stderr)
        return False
    try:
        r = requests.post(
            API_TPL.format(token=token),
            json={
                "chat_id": chat_id,
                "text": _truncate(text),
                "parse_mode": parse_mode,
                "disable_web_page_preview": True,
            },
            timeout=TIMEOUT,
        )
        if r.status_code == 200:
            return True
        # parse_mode 失敗 (Markdown 解析錯) 退化成純文字再試一次
        if r.status_code == 400 and parse_mode:
            r2 = requests.post(
                API_TPL.format(token=token),
                json={
                    "chat_id": chat_id,
                    "text": _truncate(text),
                    "disable_web_page_preview": True,
                },
                timeout=TIMEOUT,
            )
            if r2.status_code == 200:
                return True
            print(f"⚠️ Telegram retry 仍失敗 {r2.status_code}: {r2.text[:200]}",
                  file=sys.stderr)
            return False
        print(f"⚠️ Telegram send 失敗 {r.status_code}: {r.text[:200]}",
              file=sys.stderr)
        return False
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️ Telegram send 例外: {exc}", file=sys.stderr)
        return False


def format_pipeline_summary(s: dict[str, Any]) -> str:
    """組訊息。s 結構:
      trade_date: 'YYYYMMDD'
      sources:    list of dict {label, folder_key, fetch, parse, rows}
                  fetch/parse: 'ok' / 'fail' / 'skip',rows: int|None
      db:         list of dict {table, status, rows}
      sheets:     list of dict {key, name, status, rows}
      json:       {status, size_mb, path}
      elapsed_s:  float
      dry_run:    bool
    """
    td = s["trade_date"]
    td_iso = f"{td[:4]}-{td[4:6]}-{td[6:8]}" if len(td) == 8 else td

    # 整體狀態
    has_fail = (
        any(x.get("fetch") == "fail" or x.get("parse") == "fail" for x in s.get("sources", []))
        or any(x.get("status") == "fail" for x in s.get("db", []))
        or any(x.get("status") == "fail" for x in s.get("sheets", []))
        or s.get("json", {}).get("status") == "fail"
    )
    headline = "⚠️ *PARTIAL*" if has_fail else "✅"
    if s.get("dry_run"):
        headline = "🧪 *DRY RUN*"

    lines = [f"{headline} 台股管線  `{td_iso}`", ""]

    # 抓+解析
    sources = s.get("sources", [])
    if sources:
        lines.append("*抓+解析:*")
        ok_count = sum(1 for x in sources
                       if x.get("fetch") == "ok" and x.get("parse") == "ok")
        if ok_count == len(sources):
            lines.append(f"  ✅ {len(sources)} 來源全部 OK")
        else:
            for x in sources:
                fkey = x["folder_key"]
                label = x.get("label", fkey)
                fp = x.get("fetch")
                pp = x.get("parse")
                if fp == "fail":
                    lines.append(f"  ❌ {label}  fetch fail")
                elif pp == "fail":
                    lines.append(f"  ❌ {label}  parse fail")
                elif pp == "ok":
                    lines.append(f"  ✅ {label}  {x.get('rows', 0):,}")
                else:
                    lines.append(f"  ⚠️ {label}  {fp}/{pp}")
        lines.append("")

    # DB
    db = s.get("db", [])
    if db:
        lines.append("*Supabase:*")
        for x in db:
            mark = {"ok": "✅", "fail": "❌", "skip": "⚠️"}.get(x["status"], "?")
            rows = x.get("rows")
            if rows is not None:
                lines.append(f"  {mark} {x['table']:13s}  {rows:,}")
            else:
                lines.append(f"  {mark} {x['table']:13s}  {x['status']}")
        lines.append("")

    # Sheet
    sheets = s.get("sheets", [])
    if sheets:
        ok_sheets = [x for x in sheets if x.get("status") == "ok"]
        if len(ok_sheets) == len(sheets):
            parts = " / ".join(f"{x['name']} {x['rows']:,}" for x in sheets)
            lines.append(f"*Sheet:* ✅ {parts}")
        else:
            lines.append("*Sheet:*")
            for x in sheets:
                mark = {"ok": "✅", "fail": "❌"}.get(x.get("status"), "?")
                lines.append(f"  {mark} {x['name']}  {x.get('rows', '-')}")
        lines.append("")

    # 個股狀態 sheet (VCP / 三線開花)
    status_sheets = s.get("status_sheets", [])
    if status_sheets:
        ok_st = [x for x in status_sheets if x.get("status") == "ok"]
        if len(ok_st) == len(status_sheets):
            parts = " / ".join(f"{x['name']} {x['rows']:,}" for x in status_sheets)
            lines.append(f"*狀態:* ✅ {parts}")
        else:
            lines.append("*狀態:*")
            for x in status_sheets:
                mark = {"ok": "✅", "fail": "❌"}.get(x.get("status"), "?")
                lines.append(f"  {mark} {x['name']}  {x.get('rows', '-')}")
        lines.append("")

    # yuantaReport (元大證選擇權 xlsx)
    yr = s.get("yuanta_report") or {}
    if yr.get("status") and yr["status"] != "skip":
        if yr["status"] == "ok":
            lines.append(
                f"*元大證選擇權:* ✅ `{yr.get('reportDate','?')}` "
                f"基本{yr.get('basicCount',0):,} 贖回{yr.get('callRights',0)} "
                f"停轉{yr.get('conversionStop',0)}"
            )
        else:
            lines.append(f"*元大證選擇權:* ❌ {yr.get('error','unknown')}")
        lines.append("")

    # JSON
    j = s.get("json")
    if j:
        mark = {"ok": "✅", "fail": "❌", "skip": "⚠️"}.get(j["status"], "?")
        sz = j.get("size_mb")
        if sz is not None:
            lines.append(f"*JSON:* {mark} `data/all-data.json`  {sz:.2f} MB")
        else:
            lines.append(f"*JSON:* {mark} {j['status']}")
        lines.append("")

    # Footer
    lines.append(f"⏱ {s.get('elapsed_s', 0):.1f}s")
    return "\n".join(lines)


def send_pipeline_summary(s: dict[str, Any]) -> bool:
    return send(format_pipeline_summary(s))


# ── Smoke test ────────────────────────────────────────────────────────
def _smoke() -> int:
    # 讓 `python -m lib.telegram smoke` 自動讀 scripts/.env
    try:
        from pathlib import Path
        from dotenv import load_dotenv
        load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)
    except ImportError:
        pass
    sample = {
        "trade_date": "20260424",
        "sources": [
            {"folder_key": "STOCK_INST_TWSE", "label": "個股法人(上市)",
             "fetch": "ok", "parse": "ok", "rows": 14858},
            {"folder_key": "STOCK_INST_TPEX", "label": "個股法人(上櫃)",
             "fetch": "ok", "parse": "ok", "rows": 5458},
            {"folder_key": "STOCK_PRICE_TWSE", "label": "個股交易(上市)",
             "fetch": "ok", "parse": "ok", "rows": 1354},
            {"folder_key": "STOCK_PRICE_TPEX", "label": "個股交易(上櫃)",
             "fetch": "ok", "parse": "ok", "rows": 1004},
            {"folder_key": "CB_PRICE", "label": "CB 每日交易",
             "fetch": "ok", "parse": "ok", "rows": 366},
            {"folder_key": "CB_INST", "label": "CB 每日法人",
             "fetch": "ok", "parse": "ok", "rows": 177},
        ],
        "db": [
            {"table": "stock_inst", "status": "ok", "rows": 323},
            {"table": "stock_quotes", "status": "ok", "rows": 331},
            {"table": "cb_quotes", "status": "ok", "rows": 366},
            {"table": "cb_inst", "status": "ok", "rows": 177},
        ],
        "sheets": [
            {"key": "cbDailyReport", "name": "CB日報", "status": "ok", "rows": 734},
            {"key": "fubonPrimary", "name": "富邦", "status": "ok", "rows": 58},
            {"key": "yuantaPrimary", "name": "元大", "status": "ok", "rows": 61},
            {"key": "stockIndustry", "name": "公司", "status": "ok", "rows": 1951},
            {"key": "stockNews", "name": "新聞", "status": "ok", "rows": 7638},
        ],
        "json": {"status": "ok", "size_mb": 8.57},
        "elapsed_s": 21.9,
        "dry_run": False,
    }
    print("=== preview ===")
    print(format_pipeline_summary(sample))
    print()
    print("=== sending to TG ... ===")
    ok = send_pipeline_summary(sample)
    print("OK" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "smoke":
        sys.exit(_smoke())
    print(__doc__)
