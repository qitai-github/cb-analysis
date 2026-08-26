#!/usr/bin/env python3
"""MOPS 重大訊息抓取器 → data/mops_news.json

為什麼不直接爬 mopsov.twse.com.tw 的查詢頁:那頁是 Big5 + ASP.NET,而且不指定
公司代號時只能查單日。同一份資料證交所/櫃買都有官方 OpenAPI,結構化又不會被擋,
所以主來源用 OpenAPI,MOPS 查詢頁只當「補漏」用。

來源:
  1. 上市 https://openapi.twse.com.tw/v1/opendata/t187ap04_L    (每日全上市重大訊息)
  2. 上櫃 https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O (每日全上櫃重大訊息)
     ↑ 兩者都只給「最近一個發言日」的快照 → 必須每天跑,不然那天就永久漏掉。
  3. 補漏 https://mopsov.twse.com.tw/mops/web/ajax_t05st01 (單一公司最近數則,Big5)
     --catchup 時對白名單個股逐檔查,把 1/2 漏掉或當天沒跑到的補回來。

輸出 data/mops_news.json:
  {
    "updatedAt": ISO,
    "latestDate": "YYYY-MM-DD",       # 這批抓到的最新發言日
    "items":    [ {code,name,market,date,time,title,clause,factDate,detail,src}, ... ],
    "cbEvents": [ {date,type,cbCode,cbName,stockCode,title}, ... ]   # 給發行事件軸用
  }

items 只留白名單個股 (all-data.json 有的 CB 對應股),否則 JSON 會膨脹到瀏覽器扛不動;
cbEvents 則不分白名單全留 — 新 CB 常常在還沒進白名單前就先公告轉換價。

跑法:
  python scripts/mops_news.py              # 每日:抓兩個 OpenAPI 併進 JSON
  python scripts/mops_news.py --catchup    # 加跑白名單逐檔補漏 (慢,約 200 檔)
  python scripts/mops_news.py --codes 3149,2330   # 只補指定幾檔
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import capital_raise  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "data" / "mops_news.json"
ALL_DATA = ROOT / "data" / "all-data.json"

TWSE_API = "https://openapi.twse.com.tw/v1/opendata/t187ap04_L"
TPEX_API = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O"
MOPS_AJAX = "https://mopsov.twse.com.tw/mops/web/ajax_t05st01"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

KEEP_DAYS = 180      # items 保留天數
DETAIL_DAYS = 45     # 超過這天數的只留標題,說明全文丟掉 (檔案大小)
TZ8 = timezone(timedelta(hours=8))


def log(msg: str) -> None:
    print(msg, flush=True)


# ── 共用小工具 ────────────────────────────────────────────────────────
def roc_to_iso(s: str) -> str:
    """民國 '1150811' / '115/08/11' → '2026-08-11';失敗回空字串。"""
    s = str(s or "").strip()
    m = re.match(r"^(\d{2,3})[/-]?(\d{2})[/-]?(\d{2})$", s)
    if not m:
        return ""
    y = int(m.group(1)) + 1911
    return f"{y}-{m.group(2)}-{m.group(3)}"


def hhmmss(s: str) -> str:
    """'70003' / '164236' → '07:00:03' / '16:42:36'。"""
    s = re.sub(r"\D", "", str(s or ""))
    if not s:
        return ""
    s = s.zfill(6)
    return f"{s[0:2]}:{s[2:4]}:{s[4:6]}"


def clean(s: str) -> str:
    return re.sub(r"[\r\n]+", "\n", str(s or "")).strip()


def _get(row: dict, *names: str):
    """OpenAPI 欄位名偶爾帶尾隨空白 (證交所的 '主旨 '),寬鬆比對。"""
    norm = {re.sub(r"\s", "", k): v for k, v in row.items()}
    for n in names:
        if n in norm:
            return norm[n]
    return ""


# ── 來源 1 / 2:OpenAPI ───────────────────────────────────────────────
def fetch_openapi(url: str, market: str) -> list:
    r = requests.get(url, headers={"User-Agent": UA, "Accept": "application/json"},
                     timeout=45)
    r.raise_for_status()
    rows = r.json()
    out = []
    for row in rows:
        code = str(_get(row, "公司代號", "SecuritiesCompanyCode")).strip()
        if not code:
            continue
        date = roc_to_iso(_get(row, "發言日期"))
        if not date:
            continue
        out.append({
            "code": code,
            "name": clean(_get(row, "公司名稱", "CompanyName")),
            "market": market,
            "date": date,
            "time": hhmmss(_get(row, "發言時間")),
            "title": clean(_get(row, "主旨")),
            "clause": clean(_get(row, "符合條款")),
            "factDate": roc_to_iso(_get(row, "事實發生日")),
            "detail": clean(_get(row, "說明")),
            "src": "openapi",
        })
    return out


# ── 來源 3:MOPS 單一公司查詢 (補漏) ──────────────────────────────────
_TR_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
_TD_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S | re.I)


def _td_text(html: str) -> str:
    """MOPS 的 td 裡常包一層 <pre><font>,標題文字在最裡面 → 先去標籤再收白。"""
    t = re.sub(r"<[^>]+>", " ", html)
    t = t.replace("&nbsp;", " ").replace("&amp;", "&")
    return re.sub(r"[ \t]+", " ", t).strip()


def fetch_mops_company(code: str, market: str, session) -> list:
    """MOPS 查詢頁:回傳該公司最近數則重大訊息 (無說明全文)。
    日期參數其實會被伺服器忽略 (固定回最近幾則),所以只當補漏用。"""
    now = datetime.now(TZ8)
    payload = {
        "encodeURIComponent": "1", "step": "1", "firstin": "1", "off": "1",
        "TYPEK": "sii" if market == "sii" else "otc",
        "co_id": code,
        "year": str(now.year - 1911), "month": f"{now.month:02d}", "day": f"{now.day:02d}",
    }
    r = session.post(MOPS_AJAX, data=payload, timeout=30,
                     headers={"User-Agent": UA,
                              "Content-Type": "application/x-www-form-urlencoded"})
    r.raise_for_status()
    # 現在的 mopsov 回 UTF-8 (舊版是 Big5,沒有 meta charset 可判) → 先試 UTF-8,
    # 解不乾淨再退回 Big5,免得哪天站方改回去就整批變亂碼。
    html = r.content.decode("utf-8", errors="replace")
    if html.count("�") > 20:
        html = r.content.decode("big5", errors="replace")
    out = []
    for tr in _TR_RE.findall(html):
        tds = [_td_text(x) for x in _TD_RE.findall(tr)]
        if len(tds) < 5:
            continue
        c, name, d, t, title = tds[0], tds[1], tds[2], tds[3], tds[4]
        if not re.fullmatch(r"\d{4,6}", c):
            continue
        date = roc_to_iso(d)
        if not date or not title:
            continue
        rec = {
            "code": c, "name": name, "market": market,
            "date": date, "time": t if re.fullmatch(r"[\d:]+", t) else "",
            "title": clean(title),
            "clause": "", "factDate": "", "detail": "", "src": "mops",
        }
        # 細節頁要 spoke_date / spoke_time / seq_no,這三個值只在該列的 onclick JS 裡
        km = _KEY_RE.search(tr)
        if km:
            rec["_seq"] = km.group(1)
            rec["_spokeTime"] = km.group(2)
            rec["_spokeDate"] = km.group(3)
        out.append(rec)
    return out


_KEY_RE = re.compile(r"seq_no\.value='(\d+)';.*?spoke_time\.value='(\d+)';"
                     r".*?spoke_date\.value='(\d+)'", re.S)


def fetch_mops_detail(rec: dict, session) -> str:
    """抓單一則重訊的「說明」全文。逐檔補漏的列表頁只有主旨,增資的繳款期限、
    定價都在說明裡 → 對疑似增資的公告才補抓,不然要打太多次。"""
    if not rec.get("_seq"):
        return ""
    r = session.post(MOPS_AJAX, timeout=30,
                     headers={"User-Agent": UA,
                              "Content-Type": "application/x-www-form-urlencoded"},
                     data={"firstin": "true", "step": "2", "off": "1",
                           "TYPEK": "sii" if rec["market"] == "sii" else "otc",
                           "co_id": rec["code"], "seq_no": rec["_seq"],
                           "spoke_date": rec["_spokeDate"],
                           "spoke_time": rec["_spokeTime"]})
    r.raise_for_status()
    html = r.content.decode("utf-8", errors="replace")
    if html.count("�") > 20:
        html = r.content.decode("big5", errors="replace")
    # 說明是表格最後一格,先轉純文字再從「說明」切到頁尾聲明
    txt = re.sub(r"<[^>]+>", "\n", html).replace("&nbsp;", " ")
    txt = re.sub(r"\n{2,}", "\n", txt)
    m = re.search(r"\n\s*說明\s*\n(.+?)(?:以上資料均由各公司|$)", txt, re.S)
    return clean(m.group(1)) if m else ""


# ── CB 事件抽取 ──────────────────────────────────────────────────────
_CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8,
           "九": 9, "十": 10}
# 第 10 次以上的 CB 代號用英文字母:10→A、11→B …
_SEQ_SUFFIX = {n: (str(n) if n <= 9 else chr(ord("A") + n - 10)) for n in range(1, 27)}


def _cn_to_int(s: str):
    s = s.strip()
    if s.isdigit():
        return int(s)
    if s in _CN_NUM:
        return _CN_NUM[s]
    m = re.match(r"^十([一二三四五六七八九])$", s)      # 十一 ~ 十九
    if m:
        return 10 + _CN_NUM[m.group(1)]
    m = re.match(r"^([二三四五六七八九])十([一二三四五六七八九])?$", s)
    if m:
        return _CN_NUM[m.group(1)] * 10 + (_CN_NUM[m.group(2)] if m.group(2) else 0)
    return None


def _cb_seq(title: str):
    """從「國內第四次有擔保轉換公司債」抽出 4。"""
    m = re.search(r"第\s*([0-9一二三四五六七八九十]{1,3})\s*次", title)
    return _cn_to_int(m.group(1)) if m else None


# 主旨關鍵字 → 事件型別。順序有意義,先命中先算。
_CB_RULES = [
    ("collection",    (r"代收價款", r"存儲專戶")),  # 「代收價款行庫及存儲專戶行庫」
    ("auctionNotice", (r"轉換價格", r"轉換價")),   # 「轉換價格及溢價率」
]
# 掛牌後的反稀釋轉換價調整長得跟發行時的轉換價公告很像,但那是既有 CB 的事件,
# 不是發行流程的一站 — 落到事件軸會把日期蓋掉,所以整則排除。
_CB_EXCLUDE = re.compile(r"調整|重設|變更|反稀釋|停止轉換|恢復轉換")


def extract_cb_event(rec: dict):
    """把一則重大訊息判成 CB 發行事件;不是的話回 None。

    只認「轉換公司債」且能抽到期次的公告 — 期次決定 CB 代號 (3149 + 第4次 → 31494),
    抽不到期次就沒辦法掛到某一檔 CB 上,寧可不收。海外 (ECB) 沒有 5 碼代號,排除。"""
    title = rec.get("title") or ""
    if "轉換公司債" not in title:
        return None
    if "海外" in title or "歐洲" in title:
        return None
    if _CB_EXCLUDE.search(title):
        return None
    seq = _cb_seq(title)
    if seq is None or seq not in _SEQ_SUFFIX:
        return None

    etype = None
    for t, pats in _CB_RULES:
        if any(re.search(p, title) for p in pats):
            etype = t
            break
    if etype is None:
        return None

    cb_code = f"{rec['code']}{_SEQ_SUFFIX[seq]}"
    return {
        "date": rec["date"],
        "type": etype,
        "cbCode": cb_code,
        "cbName": rec.get("name") or "",
        "stockCode": rec["code"],
        "title": title.replace("\n", ""),
        "src": "mops",
    }


# ── 合併 / 落檔 ──────────────────────────────────────────────────────
def load_prev() -> dict:
    if not OUTPUT.exists():
        return {"items": [], "cbEvents": [], "capitalRaise": []}
    try:
        d = json.loads(OUTPUT.read_text(encoding="utf-8"))
        d.setdefault("items", [])
        d.setdefault("cbEvents", [])
        d.setdefault("capitalRaise", [])
        return d
    except Exception as e:            # 壞檔不該讓當天的抓取整個失敗
        log(f"  ! 舊 mops_news.json 讀取失敗,視為空檔:{e}")
        return {"items": [], "cbEvents": [], "capitalRaise": []}


def whitelist_codes() -> set:
    """all-data.json 裡有的個股代號 (= 網頁真的會顯示的 CB 對應股)。"""
    if not ALL_DATA.exists():
        return set()
    try:
        d = json.loads(ALL_DATA.read_text(encoding="utf-8"))
    except Exception:
        return set()
    codes = set()
    for row in (d.get("stockTrading") or [])[1:]:
        if row and row[0]:
            codes.add(str(row[0]).strip())
    return codes


def _item_key(r: dict) -> tuple:
    return (r["code"], r["date"], r.get("time", ""), r.get("title", "")[:60])


def merge(prev: dict, fresh: list, white: set) -> dict:
    today = datetime.now(TZ8).date()
    keep_from = (today - timedelta(days=KEEP_DAYS)).isoformat()
    detail_from = (today - timedelta(days=DETAIL_DAYS)).isoformat()

    by_key = {}
    for r in prev.get("items", []):
        by_key[_item_key(r)] = r
    added = 0
    for r in fresh:
        if white and r["code"] not in white:
            continue                       # items 只留白名單,cbEvents 另外收
        k = _item_key(r)
        old = by_key.get(k)
        if old is None:
            by_key[k] = r
            added += 1
        elif not old.get("detail") and r.get("detail"):
            old.update(r)                  # MOPS 補漏那筆沒說明,之後 OpenAPI 補上

    items = [r for r in by_key.values() if r["date"] >= keep_from]
    for r in items:                      # 細節頁用的暫時欄位不落檔
        for k in [k for k in r if k.startswith("_")]:
            r.pop(k, None)
    for r in items:
        if r["date"] < detail_from:
            r["detail"] = ""
    items.sort(key=lambda r: (r["date"], r.get("time", "")), reverse=True)

    # cbEvents:不看白名單,永久保留 (量小,而且是事件軸的歷史)
    ev_by_key = {(e["cbCode"], e["type"], e["date"]): e
                 for e in prev.get("cbEvents", [])}
    ev_added = 0
    for r in fresh:
        ev = extract_cb_event(r)
        if not ev:
            continue
        k = (ev["cbCode"], ev["type"], ev["date"])
        if k not in ev_by_key:
            ev_by_key[k] = ev
            ev_added += 1
    cb_events = sorted(ev_by_key.values(), key=lambda e: (e["date"], e["cbCode"]))

    latest = max((r["date"] for r in items), default="")
    # ── 增資事件 ──
    # 跟 cbEvents 一樣不看白名單 (全市場都掃),但只留有抽到東西的,免得整片雜訊。
    # 說明全文之後會被 DETAIL_DAYS 清掉,所以抽出來的結果要獨立存,不能事後重算。
    cr_by_key = {(e.get("code"), e.get("date"), e.get("time"), e.get("stage")): e
                 for e in prev.get("capitalRaise", [])}
    cr_added = 0
    for r in fresh:
        ev = capital_raise.build_event(r)
        if not ev:
            continue
        if not (ev["payDeadline"] or ev["chaseDeadline"] or ev["listingDate"]
                or ev["price"] or ev["stage"] != "other"):
            continue
        k = (ev["code"], ev["date"], ev["time"], ev["stage"])
        old = cr_by_key.get(k)
        # 之後補抓到說明全文時,用資訊比較多的那筆覆蓋
        if old is None or (not old.get("hasDetail") and ev["hasDetail"]):
            cr_by_key[k] = ev
            cr_added += 1
    cap = sorted(cr_by_key.values(),
                 key=lambda e: (e.get("date") or "", e.get("time") or ""), reverse=True)

    log(f"  新增 {added:,} 則重大訊息、{ev_added} 筆 CB 事件、{cr_added} 筆增資事件 "
        f"(留存 items={len(items):,} / cbEvents={len(cb_events):,} / 增資={len(cap):,})")
    return {
        "updatedAt": datetime.now(TZ8).isoformat(timespec="seconds"),
        "latestDate": latest,
        "items": items,
        "cbEvents": cb_events,
        "capitalRaise": cap,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catchup", action="store_true",
                    help="對白名單個股逐檔查 MOPS 補漏 (慢)")
    ap.add_argument("--codes", default="",
                    help="只補這幾檔 (逗號分隔),隱含 --catchup")
    ap.add_argument("--sleep", type=float, default=0.6, help="補漏查詢間隔秒數")
    ap.add_argument("--rebuild", action="store_true",
                    help="把已存的 items 全部重掃一次增資事件 (改了抽取規則後用)")
    ap.add_argument("--details", type=int, default=80,
                    help="補漏時最多補抓幾則「疑似增資」公告的說明全文")
    args = ap.parse_args()

    white = whitelist_codes()
    log(f"[1/3] 白名單個股 {len(white):,} 檔 (來自 all-data.json)")

    fresh = []
    for url, market, label in ((TWSE_API, "sii", "上市"), (TPEX_API, "otc", "上櫃")):
        try:
            rows = fetch_openapi(url, market)
            fresh += rows
            d = rows[0]["date"] if rows else "-"
            log(f"[2/3] {label} OpenAPI {len(rows):,} 則 (發言日 {d})")
        except Exception as e:
            log(f"[2/3] ! {label} OpenAPI 失敗:{e}")

    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    if codes or args.catchup:
        targets = codes or sorted(white)
        log(f"[3/3] MOPS 逐檔補漏 {len(targets):,} 檔")
        s = requests.Session()
        ok = fail = 0
        detail_budget = args.details
        for i, code in enumerate(targets, 1):
            got = []
            for market in ("sii", "otc"):
                try:
                    got = fetch_mops_company(code, market, s)
                except Exception:
                    got = []
                if got:
                    break
            if got:
                # 增資的關鍵日期全在說明裡,列表頁沒有 → 只對疑似增資的補抓細節頁
                for rec in got:
                    if detail_budget <= 0 or rec.get("detail"):
                        continue
                    if not capital_raise.is_capital_raise(rec["title"]):
                        continue
                    try:
                        rec["detail"] = fetch_mops_detail(rec, s)
                        detail_budget -= 1
                        time.sleep(args.sleep)
                    except Exception:
                        pass
                fresh += got
                ok += 1
            else:
                fail += 1
            if i % 50 == 0:
                log(f"      {i}/{len(targets)} (ok={ok} miss={fail})")
            time.sleep(args.sleep)
        log(f"      補漏完成 ok={ok} miss={fail}")
    else:
        log("[3/3] 跳過逐檔補漏 (未指定 --catchup)")

    if not fresh:
        log("!! 沒抓到任何資料,保留舊檔不動")
        return 1

    prev = load_prev()
    if args.rebuild:
        # 抽取規則改過之後,舊資料要用新規則重算一次;說明還在的才重算得出來
        log(f"[rebuild] 重掃已存的 {len(prev.get('items', [])):,} 則")
        prev["capitalRaise"] = []
        fresh = list(prev.get("items", [])) + fresh
    out = merge(prev, fresh, white)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")),
                      encoding="utf-8")
    log(f"✓ 寫入 {OUTPUT} ({OUTPUT.stat().st_size/1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
