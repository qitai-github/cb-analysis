"""把 data/company_reports.json 列的所有 PNG + PDF 設成「知道連結的所有人」可檢視。

只動 png_id + pdf_id 兩種檔,sources/ 跟 notebook_id.txt 不會被公開。

需要 Service Account 對檔案有 Editor (或 Owner) 權限才能改 permission。

跑法 (從 scripts/):
  python share_company_reports_public.py                # 對所有檔設公開
  python share_company_reports_public.py --dry-run      # 只印不執行
  python share_company_reports_public.py --revoke       # 反向操作:取消公開
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
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

from googleapiclient.errors import HttpError  # noqa: E402

from lib import drive  # noqa: E402

REPO_ROOT = SCRIPTS_DIR.parent
REPORTS_JSON = REPO_ROOT / "data" / "company_reports.json"


def log(msg: str) -> None:
    print(msg, flush=True)


def list_anyone_permission(svc, file_id: str) -> str | None:
    """回傳 file 已存在的 type=anyone permission id (沒有就 None)。"""
    try:
        res = svc.permissions().list(
            fileId=file_id,
            fields="permissions(id,type,role)",
            supportsAllDrives=True,
        ).execute()
    except HttpError as e:
        log(f"    ⚠️  list permissions 失敗: {e.status_code}")
        return None
    for p in res.get("permissions", []):
        if p.get("type") == "anyone":
            return p.get("id")
    return None


def make_public(svc, file_id: str) -> str:
    """設成 anyone-with-link reader;回 'ok' / 'exists' / err msg。"""
    existing = list_anyone_permission(svc, file_id)
    if existing:
        return "exists"
    try:
        svc.permissions().create(
            fileId=file_id,
            body={"role": "reader", "type": "anyone"},
            supportsAllDrives=True,
            sendNotificationEmail=False,
        ).execute()
        return "ok"
    except HttpError as e:
        return f"fail({e.status_code})"


def revoke_public(svc, file_id: str) -> str:
    """移除 anyone permission;回 'ok' / 'none' / err msg。"""
    existing = list_anyone_permission(svc, file_id)
    if not existing:
        return "none"
    try:
        svc.permissions().delete(
            fileId=file_id,
            permissionId=existing,
            supportsAllDrives=True,
        ).execute()
        return "ok"
    except HttpError as e:
        return f"fail({e.status_code})"


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="只印不執行")
    p.add_argument("--revoke", action="store_true", help="反向:移除公開權限")
    p.add_argument("--input", type=str, default=str(REPORTS_JSON),
                   help="company_reports.json 路徑")
    args = p.parse_args(argv)

    path = Path(args.input)
    if not path.exists():
        raise SystemExit(f"找不到 {path}")

    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    stocks = data.get("stocks", {})
    log(f"讀 {path.relative_to(REPO_ROOT)}: {len(stocks)} 檔")

    svc = drive._get_service()
    action = "revoke_public" if args.revoke else "make_public"
    fn = revoke_public if args.revoke else make_public
    log(f"動作: {action}")

    counters = {"ok": 0, "exists": 0, "none": 0, "fail": 0, "skip": 0}
    t0 = time.time()

    for i, (code, info) in enumerate(sorted(stocks.items()), 1):
        for kind in ("png_id", "pdf_id"):
            fid = info.get(kind)
            if not fid:
                counters["skip"] += 1
                continue
            label = f"  [{i}/{len(stocks)}] {code} {kind:7}"
            if args.dry_run:
                log(f"{label} → (dry-run) {fid}")
                counters["skip"] += 1
                continue
            r = fn(svc, fid)
            if r == "ok":
                counters["ok"] += 1
            elif r in ("exists", "none"):
                counters[r] += 1
            else:
                counters["fail"] += 1
            log(f"{label} → {r}")

    log(f"\n總計 (耗時 {time.time()-t0:.0f}s):")
    for k, v in counters.items():
        log(f"  {k:7} = {v}")
    return 0 if counters["fail"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
