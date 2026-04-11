#!/usr/bin/env python3
"""TWSA scraper: 競拍公告 + 詢圈公告 + PDF 解析 → data/twsa.json

流程:
  1. GET 首頁 → 取 __VIEWSTATE / cookies
  2. POST 切到「競拍公告」→ 解析 gvResult 表
  3. 每一列 POST imgbtnReportFileName → 302 取得 FileDownload.ashx → 下載 PDF
     → pdfplumber 解析文字 → 抽出股票資料
     (每次 POST 都會讓 __VIEWSTATE 失效,所以每下載一筆就重新切換分頁刷新 state)
  4. POST 切到「詢圈公告」→ 解析
  5. 合併寫入 data/twsa.json
"""
import io
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

import pdfplumber
import requests
from bs4 import BeautifulSoup

BASE_URL = "https://web.twsa.org.tw/edoc2/default.aspx"
DL_BASE = "https://web.twsa.org.tw/edoc2/"
YEAR_VALUE = "2026"  # 115 年
OUTPUT = Path(__file__).resolve().parent.parent / "data" / "twsa.json"

AUCTION_HEADERS = [
    "序號", "發行公司", "主辦承銷商", "發行性質",
    "承銷股數", "競拍股數", "投標期間", "最低承銷價格",
    "公告檔", "開標統計表",
]


def new_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/122.0.0.0 Safari/537.36"
        ),
    })
    return s


def extract_state(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    def val(name: str) -> str:
        el = soup.find("input", {"name": name})
        return el["value"] if el and el.has_attr("value") else ""
    return {
        "__VIEWSTATE": val("__VIEWSTATE"),
        "__VIEWSTATEGENERATOR": val("__VIEWSTATEGENERATOR"),
        "__EVENTVALIDATION": val("__EVENTVALIDATION"),
    }


def get_home(s: requests.Session):
    r = s.get(BASE_URL, timeout=30)
    r.raise_for_status()
    return r.text, extract_state(r.text)


def post_switch_tab(s, state, event_target, radio_value):
    payload = {
        "__EVENTTARGET": event_target,
        "__EVENTARGUMENT": "",
        "__LASTFOCUS": "",
        **state,
        "ctl00$cphMain$ddlYear": YEAR_VALUE,
        "ctl00$cphMain$rblReportType": radio_value,
    }
    r = s.post(BASE_URL, data=payload, timeout=30)
    r.raise_for_status()
    return r.text, extract_state(r.text)


def parse_auction_table(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", id="ctl00_cphMain_gvResult")
    if not table:
        return []
    rows = []
    for tr in table.find_all("tr"):
        mark = (tr.get("bgcolor") or "") + (tr.get("style") or "")
        if not re.search(r"(C5D6E4|E8EDF4)", mark, re.I):
            continue
        cells = [td.get_text(strip=True) for td in tr.find_all(["td", "th"])]
        report_btn = ""
        for inp in tr.find_all("input"):
            name = inp.get("name", "")
            if "imgbtnReportFileName" in name:
                report_btn = name
                break
        rows.append({"cells": cells, "report_btn": report_btn})
    return rows


def parse_bookbuilding_table(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", id="ctl00_cphMain_gvResult")
    if not table:
        return {"headers": [], "rows": []}
    headers: list[str] = []
    rows: list[list[str]] = []
    for tr in table.find_all("tr"):
        mark = (tr.get("bgcolor") or "") + (tr.get("style") or "")
        if re.search(r"4979A6", mark, re.I):
            headers = [c.get_text(strip=True) for c in tr.find_all(["th", "td"])]
        elif re.search(r"(C5D6E4|E8EDF4)", mark, re.I):
            rows.append([td.get_text(strip=True) for td in tr.find_all("td")])
    return {"headers": headers, "rows": rows}


def resolve_pdf_url(s, state, btn_name, radio_value="Auction") -> str | None:
    payload = {
        "__EVENTTARGET": "",
        "__EVENTARGUMENT": "",
        **state,
        "ctl00$cphMain$ddlYear": YEAR_VALUE,
        "ctl00$cphMain$rblReportType": radio_value,
        f"{btn_name}.x": "5",
        f"{btn_name}.y": "5",
    }
    r = s.post(BASE_URL, data=payload, allow_redirects=False, timeout=30)
    if r.status_code not in (301, 302):
        return None
    loc = r.headers.get("Location")
    if not loc:
        return None
    # DownloadPath=D:\WebAppUpload\... 含反斜線, URL 不合法,手動 encode
    loc = loc.replace("\\", "%5C")
    return urljoin(DL_BASE, loc)


def download_pdf(s, url) -> bytes:
    r = s.get(url, timeout=60)
    r.raise_for_status()
    return r.content


def pdf_to_text(pdf_bytes: bytes) -> str:
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        raw = "\n".join((p.extract_text() or "") for p in pdf.pages)
    # pdfplumber 對這份 PDF 的 CID 字型會把常用漢字還原成 CJK Radicals Supplement
    # (U+2E80–U+2EFF) 區的部首字,例如「二」→「⼆」「高」→「⾼」。
    # NFKC 正規化可以一次把這些部首字對應回正常漢字。
    return unicodedata.normalize("NFKC", raw)


KV_PATTERNS = [
    ("auctionType", r"競拍方式[:：]\s*(\S+)"),
    ("underwriter", r"主辦承銷商[:：]\s*(\S+)"),
    ("minOffer",    r"最低承銷價格[:：]\s*([\d.,]+)"),
    ("minWin",      r"最低得標價格[:：]\s*([\d.,]+)"),
    ("maxWin",      r"最高得標價格[:：]\s*([\d.,]+)"),
    ("pubOffer",    r"公開承銷價格[:：]\s*([\d.,]+)"),
    ("avgWin",      r"得標加權平均價格[:：]\s*([\d.,]+)"),
    ("openDate",    r"開標日期[:：]\s*([\d/]+)"),
    ("printTime",   r"印表時間[:：]\s*([\d/: ]+)"),
]


def parse_pdf_text(text: str) -> dict | None:
    m = re.search(r"([^\s(（]+)\s*[(（](\d{4,6})[)）]\s*([^\n]*)", text)
    if not m:
        return None
    info = {}
    for key, pat in KV_PATTERNS:
        mm = re.search(pat, text)
        info[key] = mm.group(1).strip() if mm else ""

    price_rows: list[list] = []
    seen: set[int] = set()
    for pm in re.finditer(
        r"(?m)^\s*(\d{1,4})\s+([\d,]+\.\d{2,4})\s+([\d,]+)\s+([\d,]+\.\d{1,2})",
        text,
    ):
        seq = int(pm.group(1))
        if seq in seen:
            continue
        seen.add(seq)
        price_rows.append([seq, pm.group(2), pm.group(3), pm.group(4)])
    price_rows.sort(key=lambda r: r[0])

    return {
        "stockId": m.group(2).strip(),
        "stockName": m.group(1).strip(),
        "secType": m.group(3).strip(),
        "info": info,
        "priceRows": price_rows,
    }


def scrape_auction(s, state):
    html, state = post_switch_tab(
        s, state, "ctl00$cphMain$rblReportType$1", "Auction"
    )
    rows = parse_auction_table(html)
    print(f"[Auction] 找到 {len(rows)} 筆", flush=True)

    out = []
    for i, r in enumerate(rows, 1):
        row = {}
        for idx, v in enumerate(r["cells"]):
            key = AUCTION_HEADERS[idx] if idx < len(AUCTION_HEADERS) else f"col{idx}"
            row[key] = v

        pdf_data = None
        if r["report_btn"]:
            try:
                pdf_url = resolve_pdf_url(s, state, r["report_btn"], "Auction")
                if pdf_url:
                    pdf_bytes = download_pdf(s, pdf_url)
                    pdf_data = parse_pdf_text(pdf_to_text(pdf_bytes))
                    print(
                        f"  [{i}/{len(rows)}] {row.get('發行公司','?')} → "
                        f"{pdf_data.get('stockId') if pdf_data else 'parse失敗'}",
                        flush=True,
                    )
                else:
                    print(f"  [{i}/{len(rows)}] 無 PDF URL", flush=True)
            except Exception as e:
                print(f"  [{i}/{len(rows)}] 錯誤: {e}", file=sys.stderr, flush=True)
            # 每次 PDF 點擊都會讓 __VIEWSTATE 過期,重新切分頁刷新
            try:
                html, state = post_switch_tab(
                    s, state, "ctl00$cphMain$rblReportType$1", "Auction"
                )
            except Exception as e:
                print(f"  重新刷新 state 失敗: {e}", file=sys.stderr, flush=True)
        row["pdf"] = pdf_data
        out.append(row)
    return out, state


def scrape_bookbuilding(s, state):
    html, state = post_switch_tab(
        s, state, "ctl00$cphMain$rblReportType$2", "BookBuilding"
    )
    bb = parse_bookbuilding_table(html)
    print(f"[BookBuilding] 找到 {len(bb['rows'])} 筆", flush=True)
    return bb, state


def main():
    s = new_session()
    _, state = get_home(s)

    auction, state = scrape_auction(s, state)
    bookbuilding, state = scrape_bookbuilding(s, state)

    result = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "year": "115",
        "auction": auction,
        "bookBuilding": bookbuilding,
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        f"[OK] 寫入 {OUTPUT}: 競拍 {len(auction)} 筆 / "
        f"詢圈 {len(bookbuilding['rows'])} 筆",
        flush=True,
    )


if __name__ == "__main__":
    main()
