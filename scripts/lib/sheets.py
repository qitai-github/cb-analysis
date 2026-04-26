"""從 Google Sheet gviz API 讀公開 sheet (含被分享給瀏覽者的) → 2D array。

行為與 js/sheetsApi.js parseGvizTable 一致:
  - 第一列 cols.label (若不全為空)
  - 後續每列 row.c[*]:有 f 用 f,否則用 v 轉字串,皆無則 ''

不需要任何認證 — sheet 必須是「知道連結的人皆可查看」。
"""

from __future__ import annotations

import json
import re
from typing import Any

import requests

GVIZ_URL_TPL = (
    "https://docs.google.com/spreadsheets/d/{sheet_id}"
    "/gviz/tq?tqx=out:json&gid={gid}"
)
TIMEOUT = 30


def fetch(sheet_id: str, gid: str) -> list[list[str]]:
    """主入口。失敗 (HTTP / JSON / API status=error) 一律拋 RuntimeError。"""
    url = GVIZ_URL_TPL.format(sheet_id=sheet_id, gid=gid)
    r = requests.get(url, timeout=TIMEOUT)
    r.raise_for_status()
    text = r.text
    # gviz 回應形如 google.visualization.Query.setResponse({...});
    m = re.search(r"\((.+)\)\s*;?\s*$", text, re.DOTALL)
    if not m:
        raise RuntimeError(
            f"無法解析 gviz 回應 (前 200 字: {text[:200]!r})"
        )
    data = json.loads(m.group(1))
    if data.get("status") == "error":
        msg = (data.get("errors") or [{}])[0].get("message", "unknown")
        raise RuntimeError(f"gviz API 錯誤: {msg}")
    return _parse_table(data.get("table") or {})


def _parse_table(table: dict[str, Any]) -> list[list[str]]:
    out: list[list[str]] = []
    cols = table.get("cols") or []
    if cols:
        headers = [str(c.get("label") or "") for c in cols]
        if any(headers):
            out.append(headers)
    for row in (table.get("rows") or []):
        cells = []
        for cell in (row.get("c") or []):
            if not cell:
                cells.append("")
                continue
            if cell.get("f") is not None:
                cells.append(str(cell["f"]))
            elif cell.get("v") is not None:
                cells.append(str(cell["v"]))
            else:
                cells.append("")
        out.append(cells)
    return out
