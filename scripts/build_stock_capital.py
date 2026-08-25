# -*- coding: utf-8 -*-
"""全上市櫃個股股本 (實收資本額) → data/stock_capital.json

來源 (公開 OpenAPI,免金鑰):
  上市 https://openapi.twse.com.tw/v1/opendata/t187ap03_L      (上市公司基本資料)
  上櫃 https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O   (上櫃公司基本資料)

兩支都是 MOPS t187ap03「公司基本資料」,含「實收資本額」(元) 與「已發行普通股數」。
註:TPEx 的 www.tpex.org.tw 一般網頁會被 Cloudflare 擋,但 /openapi/ 這條沒有。

輸出 data/stock_capital.json:
  {"_meta": {...}, "data": {"2303": {"name":"聯電","capital":1257.0094,"shares":...,"market":"上市"}}}
  capital 單位為「億元」(與元大 CB 發行案件彙整表的股本欄同單位),小數 4 位。

跑法:
  python scripts/build_stock_capital.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "stock_capital.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

SOURCES = [
    {
        "market": "上市",
        "url": "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
        "code": "公司代號",
        "name": "公司簡稱",
        "capital": "實收資本額",
        "shares": "已發行普通股數或TDR原股發行股數",
    },
    {
        "market": "上櫃",
        "url": "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
        "code": "SecuritiesCompanyCode",
        "name": "CompanyAbbreviation",
        "capital": "Paidin.Capital.NTDollars",
        "shares": "IssueShares",
    },
]


def _num(v) -> float | None:
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def fetch(src: dict) -> dict[str, dict]:
    r = requests.get(src["url"], headers={"User-Agent": UA, "Accept": "application/json"},
                     timeout=60)
    r.raise_for_status()
    out: dict[str, dict] = {}
    for row in r.json():
        code = str(row.get(src["code"], "")).strip()
        capital = _num(row.get(src["capital"]))
        if not code or not capital:
            continue
        shares = _num(row.get(src["shares"]))
        out[code] = {
            "name": str(row.get(src["name"], "")).strip(),
            "capital": round(capital / 1e8, 4),   # 元 → 億元
            "shares": int(shares) if shares else None,
            "market": src["market"],
        }
    return out


def main() -> None:
    data: dict[str, dict] = {}
    counts = {}
    for src in SOURCES:
        try:
            got = fetch(src)
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] {src['market']} 抓取失敗:{exc!r}")
            counts[src["market"]] = 0
            continue
        counts[src["market"]] = len(got)
        data.update(got)

    if not data:
        raise SystemExit("兩個來源都失敗,不覆寫既有檔案")

    now = datetime.now(timezone(timedelta(hours=8)))
    payload = {
        "_meta": {
            "updatedAt": now.strftime("%Y-%m-%d %H:%M:%S+08:00"),
            "unit": "億元",
            "counts": counts,
            "sources": [s["url"] for s in SOURCES],
        },
        "data": data,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    size_kb = OUT.stat().st_size / 1024
    print(f"上市 {counts.get('上市', 0)} 檔 + 上櫃 {counts.get('上櫃', 0)} 檔 "
          f"= {len(data)} 檔 → {OUT} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
