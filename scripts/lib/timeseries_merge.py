"""把 ParsedSource.daily_values 合併進既有 all-data.json 內某 timeseries key。

既有 shape (與 js/dataProcessor.parseTimeSeries 對齊):
  [
    ["代號", "名稱", "類別", "20260101", "20260102", ..., "20260422"],
    ["0050", "元大台灣50",   "成交股數", "100", "200", ...],
    ["",     "",             "開盤價",    "87.6", "87.7", ...],
    ["",     "",             "最高價",    ...],
    ...                                                         (每檔 stock 連續 n_categories 列)
    ["00679B", "元大美債20年", "成交股數", ...],
    ...
  ]

合併策略:
  - trade_date 已在 dates 內 → 覆蓋該欄
  - trade_date 不在        → append 為最後一欄 (允許非排序;前端 dataProcessor 用 dict 存值)
  - stock 已存在            → 找到 block 後逐 category 寫入
  - stock 不存在            → 末尾 append 一個 n_categories 列的 block,代號/名稱只放第一列

未列在 daily_values 的舊 stock 不變 (含原本欄位空值)。
"""

from __future__ import annotations

from typing import Any

from parsers.common import ParsedSource


def merge(existing: list[list] | None, parsed: ParsedSource) -> list[list]:
    """主入口。回傳新的 2D 陣列 (deep copy 過,可安全寫進 JSON)。"""
    if not existing or len(existing) < 1:
        return _fresh(parsed)
    # deep copy(每列都是 mutable list,值為 immutable str/num)
    rows: list[list] = [list(r) for r in existing]
    cats = parsed.timeseries_categories
    n_cats = len(cats)
    target = parsed.trade_date

    header = rows[0]
    if len(header) < 3:
        return _fresh(parsed)
    dates = list(header[3:])

    # 找/建立 target 欄
    if target in dates:
        col = 3 + dates.index(target)
        new_col = False
    else:
        col = len(header)
        rows[0] = list(header) + [target]
        dates.append(target)
        new_col = True

    if new_col:
        # 把所有現有 data 列補一格 "0",後面會 overwrite 有資料的 stock
        for i in range(1, len(rows)):
            while len(rows[i]) < col:
                rows[i].append("0")
            rows[i].append("0")

    # 建 stock_id → block_start_index 索引
    block_start: dict[str, int] = {}
    i = 1
    while i < len(rows):
        first = str(rows[i][0]).strip() if rows[i] else ""
        if first:
            block_start[first] = i
        i += n_cats

    # 寫今天的值
    for sid, vals in parsed.daily_values.items():
        if sid in block_start:
            start = block_start[sid]
            for j in range(n_cats):
                if start + j >= len(rows):
                    break
                row = rows[start + j]
                cat = str(row[2]).strip() if len(row) > 2 else ""
                if cat in vals:
                    while len(row) <= col:
                        row.append("0")
                    row[col] = _format(vals[cat])
        else:
            name = parsed.stock_names.get(sid, "")
            for j, cat in enumerate(cats):
                new_row = ["", "", cat] + ["0"] * len(dates)
                if j == 0:
                    new_row[0] = sid
                    new_row[1] = name
                new_row[col] = _format(vals.get(cat, 0))
                rows.append(new_row)

    return rows


def _fresh(parsed: ParsedSource) -> list[list]:
    """從零造一個 timeseries,只有今天一欄。"""
    cats = parsed.timeseries_categories
    target = parsed.trade_date
    rows: list[list] = [["代號", "名稱", "類別", target]]
    for sid, vals in parsed.daily_values.items():
        name = parsed.stock_names.get(sid, "")
        for j, cat in enumerate(cats):
            new_row = ["", "", cat, _format(vals.get(cat, 0))]
            if j == 0:
                new_row[0] = sid
                new_row[1] = name
            rows.append(new_row)
    return rows


def _format(v: Any) -> str:
    """數字 → 字串 (整數值 float 去掉小數;對齊 GAS 既有輸出風格)。"""
    if v is None:
        return "0"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else str(v)
    return str(v)
