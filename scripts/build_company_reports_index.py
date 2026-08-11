"""掃 Drive「企業報告/」資料夾,拼 data/company_reports.json。

Drive 結構:
  Telegram Bot/企業報告/{name}{4位股號}/
                          ├── V1/  ├── {code}.png      (簡易報告)
                          │        └── {code}_報告.pdf (完整報告)
                          ├── V2/  (如有新版本)
                          ├── sources/
                          └── notebook_id.txt

每個 stock 挑最新 Vn (數字最大) 抓 png + pdf 的 file id。

env:
  GOOGLE_CREDENTIALS  service account JSON (跟 fetch/parse 共用)
  COMPANY_REPORTS_FOLDER_ID  企業報告/ 根 folder id (可選,預設用內建常數)

跑法 (從 scripts/):
  python build_company_reports_index.py
  python build_company_reports_index.py --dry-run    # 不寫檔
  python build_company_reports_index.py --verbose    # 印每個 stock
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Windows console UTF-8
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

try:
    from dotenv import load_dotenv
    load_dotenv(SCRIPTS_DIR / ".env", override=False)
except ImportError:
    pass

from lib import drive  # noqa: E402

REPO_ROOT = SCRIPTS_DIR.parent
OUT_JSON = REPO_ROOT / "data" / "company_reports.json"

# 預設「企業報告/」根 folder id (使用者提供)
DEFAULT_ROOT_FOLDER_ID = "1pck7m3BIKw69CtvByhhMV6D_wmbhHW1w"

FOLDER_MIME = "application/vnd.google-apps.folder"
CODE_RE = re.compile(r"(\d{4,6})$")  # 子資料夾名尾的股號
V_RE = re.compile(r"^V(\d+)$", re.I)


def log(msg: str) -> None:
    print(msg, flush=True)


def pick_latest_v(subfolders: list[dict]) -> dict | None:
    """從子資料夾列表挑出 V{n} 中 n 最大的。"""
    vs = []
    for f in subfolders:
        m = V_RE.match(f["name"])
        if m:
            vs.append((int(m.group(1)), f))
    if not vs:
        return None
    vs.sort(key=lambda t: t[0], reverse=True)
    return vs[0][1]


def find_files(files: list[dict], code: str) -> tuple[str | None, str | None]:
    """在 V 資料夾的檔案列表裡找 {code}.png 與 {code}_報告.pdf 的 file id。

    容錯:也接受 {code}*.png / {code}*.pdf 開頭包含 code 的檔。
    """
    png_id: str | None = None
    pdf_id: str | None = None
    exact_png = f"{code}.png"
    exact_pdf_main = f"{code}_報告.pdf"

    for f in files:
        name = f["name"]
        nlow = name.lower()
        if not png_id:
            if name == exact_png or (nlow.endswith(".png") and code in name):
                png_id = f["id"]
        if not pdf_id:
            if name == exact_pdf_main or (
                    nlow.endswith(".pdf") and code in name and "報告" in name):
                pdf_id = f["id"]
        if png_id and pdf_id:
            break
    # PDF 容錯:沒有「報告」字眼但有 pdf 也接受
    if not pdf_id:
        for f in files:
            if f["name"].lower().endswith(".pdf") and code in f["name"]:
                pdf_id = f["id"]
                break
    return png_id, pdf_id


def build_index(root_folder_id: str, verbose: bool = False) -> dict:
    log(f"掃 Drive folder: {root_folder_id}")
    companies = drive.list_children(root_folder_id, mime_filter=FOLDER_MIME)
    log(f"  ↳ 共 {len(companies)} 個子資料夾")

    stocks: dict[str, dict] = {}
    overview: dict | None = None      # 產業鏈總覽(無股號的特殊報告)
    skipped_no_code = 0
    skipped_no_v = 0
    skipped_no_files = 0

    for i, c in enumerate(companies, 1):
        folder_name = c["name"]
        m = CODE_RE.search(folder_name)
        if not m:
            # 特例:「_產業鏈總覽」無股號,取最新 V 的 png + _報告.pdf 當總覽卡片
            if "產業鏈總覽" in folder_name:
                sub = drive.list_children(c["id"], mime_filter=FOLDER_MIME)
                lv = pick_latest_v(sub)
                if lv:
                    vf = drive.list_children(lv["id"])
                    o_png = next((f["id"] for f in vf if f["name"].lower().endswith(".png")), None)
                    o_pdf = next((f["id"] for f in vf if f["name"].endswith("_報告.pdf")), None)
                    if o_png or o_pdf:
                        overview = {"png_id": o_png, "pdf_id": o_pdf, "version": lv["name"],
                                    "folder_name": folder_name, "title": "台股產業鏈交叉分析 2026H2"}
                        ovmap = {}
                        for vs_ in sub:
                            if not V_RE.match(vs_["name"]):
                                continue
                            vf_ = vf if vs_["id"] == lv["id"] else drive.list_children(vs_["id"])
                            vp = next((f["id"] for f in vf_ if f["name"].lower().endswith(".png")), None)
                            vd = next((f["id"] for f in vf_ if f["name"].endswith("_報告.pdf")), None)
                            if vp or vd:
                                ovmap[vs_["name"]] = {"png_id": vp, "pdf_id": vd}
                        if len(ovmap) > 1:
                            overview["versions"] = ovmap
                        log(f"  [{i}/{len(companies)}] {folder_name}/{lv['name']} → 產業鏈總覽 [{'png' if o_png else ''}{'+pdf' if o_pdf else ''}]")
            else:
                if verbose:
                    log(f"  [{i}/{len(companies)}] {folder_name} → 找不到股號,skip")
                skipped_no_code += 1
            continue
        code = m.group(1)

        # 列子資料夾找最新 V
        sub = drive.list_children(c["id"], mime_filter=FOLDER_MIME)
        latest_v = pick_latest_v(sub)
        if not latest_v:
            if verbose:
                log(f"  [{i}/{len(companies)}] {folder_name} → 沒有 Vn,skip")
            skipped_no_v += 1
            continue

        # 列 V 內檔案
        v_files = drive.list_children(latest_v["id"])
        png_id, pdf_id = find_files(v_files, code)
        if not png_id and not pdf_id:
            if verbose:
                log(f"  [{i}/{len(companies)}] {folder_name}/{latest_v['name']} "
                    f"→ 找不到 png/pdf,skip")
            skipped_no_files += 1
            continue

        stocks[code] = {
            "png_id": png_id,
            "pdf_id": pdf_id,
            "version": latest_v["name"],
            "folder_name": folder_name,
        }
        # 多版本:若有 >1 個 V 資料夾,收各版本 png/pdf 供 modal 切換
        if len(sub) > 1:
            vmap = {}
            for vs_ in sub:
                if not V_RE.match(vs_["name"]):
                    continue
                vf_ = v_files if vs_["id"] == latest_v["id"] else drive.list_children(vs_["id"])
                vpng, vpdf = find_files(vf_, code)
                if vpng or vpdf:
                    vmap[vs_["name"]] = {"png_id": vpng, "pdf_id": vpdf}
            if len(vmap) > 1:
                stocks[code]["versions"] = vmap
        if verbose:
            tag = []
            if png_id:
                tag.append("png")
            if pdf_id:
                tag.append("pdf")
            log(f"  [{i}/{len(companies)}] {folder_name} → {code} "
                f"({latest_v['name']}) [{'+'.join(tag)}]")

    # 注入官方簡稱(給報告清單頁用):data/stock_names.json = {code: 簡稱}(由 TWSE/TPEx 日檔產)
    try:
        names_path = Path(__file__).resolve().parent.parent / "data" / "stock_names.json"
        if names_path.exists():
            names = json.loads(names_path.read_text(encoding="utf-8"))
            n_named = 0
            for code, info in stocks.items():
                if code in names:
                    info["name"] = names[code]; n_named += 1
            log(f"注入簡稱: {n_named}/{len(stocks)} (data/stock_names.json)")
    except Exception as e:
        log(f"注入簡稱失敗(略過): {e}")

    tz_tw = timezone(timedelta(hours=8))
    out = {
        "_meta": {
            "updated_at": datetime.now(tz_tw).strftime("%Y%m%d %H:%M"),
            "folder_id": root_folder_id,
            "total_subfolders": len(companies),
            "ok": len(stocks),
            "skipped_no_code": skipped_no_code,
            "skipped_no_v": skipped_no_v,
            "skipped_no_files": skipped_no_files,
        },
        "stocks": stocks,
    }
    if overview:
        out["overview"] = overview
    return out


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--folder", type=str,
                   default=os.environ.get("COMPANY_REPORTS_FOLDER_ID")
                           or DEFAULT_ROOT_FOLDER_ID,
                   help="企業報告/ 根 folder id")
    p.add_argument("--dry-run", action="store_true", help="不寫 JSON")
    p.add_argument("--verbose", "-v", action="store_true", help="逐檔印 log")
    args = p.parse_args(argv)

    t0 = time.time()
    out = build_index(args.folder, verbose=args.verbose)

    log(f"\n總計 {out['_meta']['ok']:,} / {out['_meta']['total_subfolders']:,} "
        f"成功 (耗時 {time.time()-t0:.0f}s)")
    log(f"  skipped: no_code={out['_meta']['skipped_no_code']}  "
        f"no_v={out['_meta']['skipped_no_v']}  "
        f"no_files={out['_meta']['skipped_no_files']}")

    if args.dry_run:
        log("\n--dry-run, 不寫 JSON")
        log(json.dumps(out["_meta"], ensure_ascii=False, indent=2))
        return 0

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    size_kb = OUT_JSON.stat().st_size / 1024
    log(f"\n✓ {OUT_JSON.relative_to(REPO_ROOT)} ({size_kb:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
