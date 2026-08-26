"""從 MOPS 重大訊息的「說明」辨識現金增資事件與定價。

MOPS 說明看起來是自由文字,實際上多半是編號欄位:

    9.發行價格:每股發行價為新臺幣82元整
    16.現金增資認股基準日:115/09/02
    20.股款繳納期間:
    115/09/07~115/09/11(原股東及員工繳款)
    115/09/14~115/09/16(特定人繳款)

所以做法是**先切欄位再抽日期**,而不是在整段文字裡亂找關鍵詞 —— 後者會把
「主管機關申報生效日期」之類的無關日期抓進來(實測會錯得很離譜)。
沒有編號欄位的(例如催繳公告寫在「5.發生緣由」的散文裡)才退回關鍵詞視窗,
而且視窗版本認得「D1~D2」「自D1至D2」這種區間,一律取迄日。

抽出來的欄位(對應四項需求):
  announcedAt   1. 公告時間      ← 重訊本身的發言日期時間
  payDeadline   2. 最後繳費期限  ← 原股東/員工認股繳款期間的迄日
  chaseDeadline 3. 催繳 / 特定人繳費期限 (chaseKind 標明是哪一種)
  listingDate   4. 新股上市櫃時間
  price         增資定價(每股認購/發行價格)

保守起見抓不到就留空,不用鄰近日期硬猜;每欄附 evidence 原文方便人工核對。
"""
from __future__ import annotations

import re

# ── 分類 ──────────────────────────────────────────────────────────────
# 「新增資金貸與」也含「增資」兩字但跟募資無關,一定要先排掉
_EXCLUDE = re.compile(r"新增資金貸與|資金貸與|背書保證|增資子公司|對外投資|"
                      r"註銷庫藏股|配股配息")
_INCLUDE = re.compile(r"現金增資|現增|私募普通股|私募有價證券|募集發行新股|"
                      r"增資發行新股|股款繳納憑證")
# CB / 員工認股權轉換普通股的「增資基準日」是換股不是募資
_CB_CONV = re.compile(r"轉換公司債.{0,12}轉換普通股|員工認股權憑證轉換|限制員工權利新股", re.S)

STAGES = [
    ("listing",  re.compile(r"股款繳納憑證.{0,6}(上市|上櫃)|增資新股.{0,6}(上市|上櫃)|"
                            r"新股.{0,6}(上市|上櫃)買賣|股票發放", re.S)),
    ("chase",    re.compile(r"催繳")),
    ("paidIn",   re.compile(r"收足股款|股款.{0,6}收足|繳足")),
    ("pricing",  re.compile(r"認股基準日|訂定.{0,10}(發行|認購)價格|定價相關事宜|"
                            r"(發行|認購)價格.{0,10}(訂為|為|訂定)|增資基準日", re.S)),
    ("board",    re.compile(r"董事會決議.{0,12}(辦理|發行|通過).{0,10}(現金增資|增資|新股)|"
                            r"董事會決議.{0,20}私募", re.S)),
]

STAGE_LABEL = {
    "board": "董事會決議", "pricing": "定價/認股基準日", "chase": "催繳/特定人",
    "paidIn": "收足股款", "listing": "新股上市櫃", "other": "其他",
}


def is_capital_raise(title: str, detail: str = "") -> bool:
    if _EXCLUDE.search(title) or _CB_CONV.search(title):
        return False
    # 內文只在標題看不出來時才拿來判斷,免得「其他應敘明事項」提一句就誤判
    return bool(_INCLUDE.search(title) or
                (_INCLUDE.search(detail or "") and "增資" in title))


def stage_of(title: str, detail: str = "") -> str:
    for name, pat in STAGES:
        if pat.search(title):
            return name
    for name, pat in STAGES:
        if pat.search(detail or ""):
            return name
    return "other"


# ── 日期 / 區間 ───────────────────────────────────────────────────────
# 115/08/24、115年8月24日、115.08.24;年份限 1xx,避免把金額當日期
_DATE = r"(1\d{2})\s*[/年\.\-]\s*(\d{1,2})\s*[/月\.\-]\s*(\d{1,2})\s*日?"
_DATE_RE = re.compile(_DATE)
_RANGE_RE = re.compile(_DATE + r"\s*(?:起)?\s*[~～至到\-–—]\s*" + _DATE)


def _iso(y: str, m: str, d: str) -> str:
    y, m, d = int(y) + 1911, int(m), int(d)
    return f"{y}-{m:02d}-{d:02d}" if 1 <= m <= 12 and 1 <= d <= 31 else ""


def _last_date(text: str) -> str:
    """一段文字裡的「期限」:有區間取迄日,否則取最後一個日期。"""
    rm = list(_RANGE_RE.finditer(text))
    if rm:
        return _iso(*rm[-1].groups()[3:6])
    dm = list(_DATE_RE.finditer(text))
    return _iso(*dm[-1].groups()) if dm else ""


def _first_date(text: str) -> str:
    dm = _DATE_RE.search(text)
    return _iso(*dm.groups()) if dm else ""


# ── 欄位切割 ──────────────────────────────────────────────────────────
# 「20.股款繳納期間:」與「(5)預定股款繳納憑證上櫃日期:」兩種編號都吃
_FIELD_RE = re.compile(r"(?:^|\n)\s*(?:(\d{1,2})\.|\((\d{1,2})\))\s*"
                       r"([^:：\n]{2,45})[:：]", re.M)


def parse_fields(detail: str) -> list[tuple[str, str]]:
    """回傳 [(欄位名, 值), ...];值一路吃到下一個編號欄位為止。"""
    if not detail:
        return []
    ms = list(_FIELD_RE.finditer(detail))
    out = []
    for i, m in enumerate(ms):
        end = ms[i + 1].start() if i + 1 < len(ms) else len(detail)
        out.append((m.group(3).strip(), detail[m.end():end].strip()))
    return out


def _field(fields: list[tuple[str, str]], *keywords: str) -> tuple[str, str]:
    """名稱含關鍵詞、**而且值不是空的**才算命中 —— 「20.股款繳納期間:」底下常常
    再拆成「(1)原股東…(2)特定人…」子欄位,母欄位本身是空的,不跳過會誤判成沒資料。"""
    for name, val in fields:
        if any(k in name for k in keywords) and val.strip():
            return name, val
    return "", ""


# 句尾:句號/分號/空行,或「下一個編號欄位」—— 不擋編號的話視窗會吃進下一格的日期
_SENT_END = re.compile(r"[。;；]|\n\s*\n|\n\s*\d{1,2}\.")


def _sentence(text: str, start: int, width: int) -> str:
    """從 start 取到句尾 (。/;/空行) 或 width 字為止 —— 視窗不切句子的話會吃到
    下一段的日期 (實測催繳公告會把「繳款期限」抓成下一句的「催繳迄日」)。"""
    seg = text[start: start + width]
    m = _SENT_END.search(seg)
    return seg[: m.start()] if m else seg


def _clause_before(text: str, pos: int, back: int) -> str:
    """關鍵詞前面「同一子句」的文字:往前 back 字,再砍到最近的句尾/欄位編號。
    給「115年09月08日劃撥至集保帳戶」這種日期寫在關鍵詞前面的句型用 ——
    不砍到子句邊界的話會撈到上一格的日期。"""
    if back <= 0:
        return ""
    pre = text[max(0, pos - back): pos]
    cuts = [m.end() for m in _SENT_END.finditer(pre)]
    return pre[cuts[-1]:] if cuts else pre


def _window(text: str, pat: re.Pattern, width: int = 120,
            require: str = "", exclude: str = "", back: int = 0,
            date_back: bool = False) -> str:
    """沒有編號欄位時的退路:掃過關鍵詞的每一次出現,取句內日期最晚的那段。
    (公告常有「原訂…順延至…」兩句,要的是比較晚那個)

    require / exclude:句子裡必須有 / 不能有的字。實測需要這兩道濾網 ——
      · 找繳款期限時要排掉「特定人」那句,不然會拿到特定人的迄日
      · 找催繳迄日時要排掉「…劃撥至集保帳戶」那句,那是撥券日不是繳款期限
    back:關鍵詞往前也吃幾個字 —— 「115年09月04日劃撥至集保帳戶」日期在詞前面。"""
    ex = re.compile(exclude) if exclude else None
    best_seg, best_date = "", ""
    for m in pat.finditer(text):
        # 日期只從關鍵詞往後取(往前那段拿來切句會把欄位編號當句尾,整段被砍掉);
        # require / exclude 則連同前文一起判斷,才看得到「原特定人…調整繳款期間」
        seg = _sentence(text, m.start(), width)
        pre = _clause_before(text, m.start(), back)
        ctx = pre + seg
        if require and require not in ctx:
            continue
        if ex and ex.search(ctx):
            continue
        # 預設只從關鍵詞往後取日期(往前那段拿來切句會把欄位編號當句尾);
        # date_back=True 時才允許回頭在同一子句裡找 —— 「…09月08日劃撥至集保」
        d = _last_date(seg)
        if not d and date_back:
            d, seg = _last_date(pre), pre + seg
        if d and d > best_date:
            best_seg, best_date = seg, d
    return best_seg


_P_PAY = re.compile(r"認股繳款期[間限]|股款繳納期[間限]|繳款期[間限]|繳納股款期[間限]")
_P_CHASE = re.compile(r"催繳")
_P_SPEC = re.compile(r"特定人")
# re.S 必要:MOPS 會在句中硬斷行(「劃撥至該股 / 東及員工之集保帳戶」),不跨行就配不到
_P_LIST = re.compile(r"股款繳納憑證.{0,8}(?:上市|上櫃)|(?:增資)?新股.{0,8}(?:上市|上櫃)|"
                     r"劃撥.{0,24}集保|撥券", re.S)
_P_PRICE = re.compile(r"(?:每股)?(?:認購|發行|承購)價(?:格|為)?(?:訂為|為|:|：)?\s*"
                      r"(?:新台幣|新臺幣|NT\$?|NTD)?\s*([\d,]+(?:\.\d+)?)\s*元")


def extract(title: str, detail: str) -> dict:
    detail = detail or ""
    fields = parse_fields(detail)
    text = f"{title}\n{detail}"
    # 關鍵詞視窗只掃說明本文 —— 標題那句沒有上下文,常常配到「事實發生日」
    body = detail if detail.strip() else text

    # ── 2. 最後繳費期限 / 3. 特定人 ──
    pay = spec = ""
    pay_ev = spec_ev = ""
    # 繳款期間可能是一格 (內含兩行) 也可能被拆成兩個子欄位 → 兩種都掃
    for name, val in fields:
        if not _P_PAY.search(name) or not _DATE_RE.search(val):
            continue
        for line in ([val] if "\n" not in val.strip() else val.splitlines()):
            if not _DATE_RE.search(line):
                continue
            who = f"{name}{line}"
            if "特定人" in who:
                if not spec:
                    spec, spec_ev = _last_date(line), f"{name}:{line}".strip()[:60]
            elif not pay:
                pay, pay_ev = _last_date(line), f"{name}:{line}".strip()[:60]
    if not pay:
        # back=60:「原特定人股款繳納期間…調整繳款期間為…」這種寫法,關鍵詞前
        # 60 字才看得到「特定人」三個字,不夠遠就會把特定人的迄日當成一般繳款期限
        seg = _window(body, _P_PAY, exclude="特定人|催繳", back=60)
        if seg:
            pay, pay_ev = _last_date(seg), re.sub(r"\s+", "", seg)[:60]
    if not spec:
        # 只有同一句裡真的在講繳款才算,不然「洽特定人認購」那句會亂配日期
        seg = _window(body, _P_SPEC, 120, require="繳")
        if seg:
            spec, spec_ev = _last_date(seg), re.sub(r"\s+", "", seg)[:60]

    # ── 3. 催繳 ──
    chase = chase_ev = ""
    fname, fval = _field(fields, "催繳")
    if fval:
        chase, chase_ev = _last_date(fval), fval.strip()[:60]
    else:
        seg = _window(body, _P_CHASE, exclude="劃撥|集保|撥券")
        if seg:
            chase, chase_ev = _last_date(seg), re.sub(r"\s+", "", seg)[:60]

    # 催繳與特定人是同一格,兩個都有就取比較晚的(流程上比較後面)
    kind = ""
    if chase and spec:
        kind, chase_final, chase_final_ev = (
            ("催繳", chase, chase_ev) if chase >= spec else ("特定人", spec, spec_ev))
    elif chase:
        kind, chase_final, chase_final_ev = "催繳", chase, chase_ev
    elif spec:
        kind, chase_final, chase_final_ev = "特定人", spec, spec_ev
    else:
        chase_final = chase_final_ev = ""

    # ── 4. 新股上市櫃 ──
    listing = list_ev = ""
    fname, fval = _field(fields, "股款繳納憑證上市", "股款繳納憑證上櫃", "憑證上市",
                         "憑證上櫃", "新股上市", "新股上櫃", "上市買賣", "上櫃買賣")
    if fval:
        listing, list_ev = _first_date(fval), f"{fname}:{fval}".strip()[:60]
    else:
        seg = _window(body, _P_LIST, 90, back=60, date_back=True)
        if seg:
            listing, list_ev = _first_date(seg), re.sub(r"\s+", "", seg)[:60]

    # ── 認股 / 增資基準日 ──
    fname, fval = _field(fields, "認股基準日", "增資基準日")
    base = _first_date(fval) if fval else ""

    # ── 定價 ──
    price = ""
    fname, fval = _field(fields, "發行價格", "認購價格", "每股價格")
    pm = _P_PRICE.search(fval) if fval else _P_PRICE.search(text)
    if not pm and fval:
        dm = re.search(r"([\d,]+(?:\.\d+)?)\s*元", fval)
        pm = dm
    if pm:
        try:
            price = f"{float(pm.group(1).replace(',', '')):g}"
        except ValueError:
            price = ""

    return {
        "payDeadline": pay, "payEvidence": pay_ev,
        "chaseDeadline": chase_final, "chaseEvidence": chase_final_ev,
        "chaseKind": kind,
        "listingDate": listing, "listingEvidence": list_ev,
        "baseDate": base,
        "price": price,
    }


def build_event(rec: dict) -> dict | None:
    """一則重訊 → 一筆增資事件;不是增資就回 None。rec = mops_news 的 item。"""
    title = (rec.get("title") or "").replace("\n", "")
    detail = rec.get("detail") or ""
    if not is_capital_raise(title, detail):
        return None
    got = extract(title, detail)
    return {
        "code": rec.get("code"), "name": rec.get("name"), "market": rec.get("market"),
        "date": rec.get("date"), "time": rec.get("time", ""),
        "announcedAt": f"{rec.get('date','')} {rec.get('time','')}".strip(),
        "stage": stage_of(title, detail),
        "title": title,
        "hasDetail": bool(detail),
        **got,
    }
