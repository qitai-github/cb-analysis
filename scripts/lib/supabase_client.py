"""Supabase client wrapper.

提供:
  get_client()              取得已認證的 supabase Client (service_role key)
  upsert_rows(...)          通用 upsert + 失敗時拋例外
  record_run(...)           寫一筆 fetch_runs 監控紀錄

Smoke test (本機驗證連線 + schema 都對):
  python -m scripts.lib.supabase_client smoke
或從 scripts/ 目錄:
  python -c "from lib.supabase_client import smoke; smoke()"
"""

from __future__ import annotations

import os
import sys
from datetime import date
from typing import Any, Iterable, Optional

# Windows 預設 console 是 cp950,印不了 unicode 符號 (✓ ✗ 等)。強制 UTF-8 輸出。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

try:
    from supabase import Client, create_client
except ImportError as exc:  # noqa: BLE001
    raise SystemExit(
        "缺少 supabase 套件。請執行: pip install -r scripts/requirements-stocks.txt"
    ) from exc


_client: Optional[Client] = None


def get_client() -> Client:
    """讀環境變數,回傳一個已認證的 Client (process 內 cached)。"""
    global _client
    if _client is not None:
        return _client

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url:
        raise SystemExit("缺少環境變數 SUPABASE_URL")
    if not key:
        raise SystemExit("缺少環境變數 SUPABASE_SERVICE_ROLE_KEY")

    _client = create_client(url, key)
    return _client


def upsert_rows(
    table: str,
    rows: list[dict[str, Any]],
    on_conflict: str,
    *,
    batch_size: int = 500,
) -> int:
    """分批 upsert; 回傳寫入列數。失敗會拋例外。"""
    if not rows:
        return 0
    client = get_client()
    written = 0
    for start in range(0, len(rows), batch_size):
        chunk = rows[start : start + batch_size]
        client.table(table).upsert(chunk, on_conflict=on_conflict).execute()
        written += len(chunk)
    return written


def record_run(
    *,
    trade_date: str | date,
    source: str,
    phase: str,
    status: str,
    row_count: Optional[int] = None,
    error_msg: Optional[str] = None,
) -> None:
    """寫一筆 fetch_runs。任何欄位錯了寧可印 stderr 也不讓主流程 fail。"""
    if isinstance(trade_date, date):
        trade_date = trade_date.isoformat()
    payload = {
        "trade_date": trade_date,
        "source": source,
        "phase": phase,
        "status": status,
        "row_count": row_count,
        "error_msg": error_msg,
    }
    try:
        get_client().table("fetch_runs").insert(payload).execute()
    except Exception as exc:  # noqa: BLE001
        print(f"⚠️ record_run 寫入失敗 (不影響主流程): {exc}", file=sys.stderr)


# ── Smoke test ────────────────────────────────────────────────────────
def smoke() -> int:
    # 讓 `python -m lib.supabase_client smoke` 自動讀 scripts/.env
    try:
        from pathlib import Path
        from dotenv import load_dotenv
        load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)
    except ImportError:
        pass
    """連線 + 寫 fetch_runs + 讀回 + 刪除。回傳 exit code。"""
    print("=== Supabase smoke test ===", flush=True)
    print(f"URL: {os.environ.get('SUPABASE_URL', '<未設定>')}")
    client = get_client()

    # 1. insert 一筆 smoke row 並拿 id
    print("→ insert 測試列到 fetch_runs...")
    res = (
        client.table("fetch_runs")
        .insert(
            {
                "trade_date": date.today().isoformat(),
                "source": "__smoke__",
                "phase": "smoke",
                "status": "ok",
                "row_count": 0,
                "error_msg": None,
            }
        )
        .execute()
    )
    if not res.data:
        print("❌ insert 沒回傳資料", file=sys.stderr)
        return 1
    inserted_id = res.data[0]["id"]
    print(f"✓ inserted id={inserted_id}")

    # 2. select 讀回
    print("→ select 讀回...")
    sel = client.table("fetch_runs").select("*").eq("id", inserted_id).execute()
    if not sel.data or sel.data[0]["source"] != "__smoke__":
        print("❌ select 找不到剛插入的列", file=sys.stderr)
        return 1
    print(f"✓ 讀回 source={sel.data[0]['source']}, status={sel.data[0]['status']}")

    # 3. 確認 4 張業務表存在 (count head 即可)
    print("→ 檢查 4 張業務表存在...")
    for table in ("stock_quotes", "stock_inst", "cb_quotes", "cb_inst"):
        try:
            client.table(table).select("trade_date", count="exact", head=True).execute()
            print(f"✓ {table} 可訪問")
        except Exception as exc:  # noqa: BLE001
            print(f"❌ {table} 訪問失敗: {exc}", file=sys.stderr)
            return 1

    # 4. 清掉 smoke row
    print("→ 刪除測試列...")
    client.table("fetch_runs").delete().eq("id", inserted_id).execute()
    print(f"✓ 已刪除 id={inserted_id}")

    print("\n🎉 smoke test 全通過")
    return 0


def _entry(argv: Iterable[str]) -> int:
    args = list(argv)
    if len(args) >= 2 and args[1] == "smoke":
        return smoke()
    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_entry(sys.argv))
