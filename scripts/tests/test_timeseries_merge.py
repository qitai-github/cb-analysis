"""timeseries_merge 單元測試。

跑法 (從 scripts/):
  python -m unittest tests.test_timeseries_merge -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from lib import timeseries_merge  # noqa: E402
from parsers.common import ParsedSource  # noqa: E402


def _make_parsed(trade_date: str, daily_values, names=None):
    return ParsedSource(
        db_table="stock_inst",
        timeseries_key="cbInstitutional",
        timeseries_categories=["外資買賣超", "投信買賣超", "自營商買賣超"],
        daily_values=daily_values,
        stock_names=names or {sid: sid for sid in daily_values},
        trade_date=trade_date,
    )


class FreshBuildTest(unittest.TestCase):
    def test_empty_existing_builds_from_scratch(self):
        parsed = _make_parsed("20260424", {
            "0050": {"外資買賣超": 1000, "投信買賣超": 200, "自營商買賣超": 300},
        }, names={"0050": "元大台灣50"})
        out = timeseries_merge.merge(None, parsed)
        # 1 header + 3 categories
        self.assertEqual(len(out), 4)
        self.assertEqual(out[0], ["代號", "名稱", "類別", "20260424"])
        self.assertEqual(out[1], ["0050", "元大台灣50", "外資買賣超", "1000"])
        self.assertEqual(out[2], ["", "", "投信買賣超", "200"])
        self.assertEqual(out[3], ["", "", "自營商買賣超", "300"])


class AppendNewDateTest(unittest.TestCase):
    def setUp(self):
        # 既有:0050 兩天的資料 (20260422, 20260423)
        self.existing = [
            ["代號", "名稱", "類別", "20260422", "20260423"],
            ["0050", "元大台灣50", "外資買賣超", "100", "200"],
            ["", "", "投信買賣超", "10", "20"],
            ["", "", "自營商買賣超", "1", "2"],
        ]

    def test_append_today_extends_header(self):
        parsed = _make_parsed("20260424", {
            "0050": {"外資買賣超": 999, "投信買賣超": 99, "自營商買賣超": 9},
        }, names={"0050": "元大台灣50"})
        out = timeseries_merge.merge(self.existing, parsed)
        self.assertEqual(out[0], ["代號", "名稱", "類別", "20260422", "20260423", "20260424"])
        # 既有 0050 三列各加一格
        self.assertEqual(out[1], ["0050", "元大台灣50", "外資買賣超", "100", "200", "999"])
        self.assertEqual(out[2], ["", "", "投信買賣超", "10", "20", "99"])
        self.assertEqual(out[3], ["", "", "自營商買賣超", "1", "2", "9"])

    def test_existing_unchanged_when_stock_absent_today(self):
        # 今天的 daily_values 沒包 0050 (例如停牌或抓資料失敗) → 仍 append "0"
        parsed = _make_parsed("20260424", {})
        out = timeseries_merge.merge(self.existing, parsed)
        self.assertEqual(out[1], ["0050", "元大台灣50", "外資買賣超", "100", "200", "0"])
        self.assertEqual(out[2], ["", "", "投信買賣超", "10", "20", "0"])

    def test_new_stock_appends_block(self):
        parsed = _make_parsed("20260424", {
            "0050": {"外資買賣超": 1, "投信買賣超": 2, "自營商買賣超": 3},
            "1101": {"外資買賣超": 11, "投信買賣超": 22, "自營商買賣超": 33},
        }, names={"0050": "元大台灣50", "1101": "台泥"})
        out = timeseries_merge.merge(self.existing, parsed)
        # header 加一欄 + 0050 三列 + 1101 三列 = 7
        self.assertEqual(len(out), 7)
        # 1101 block (新 append):前兩個既有日期應為 "0",今天才有值
        # 找 1101 那列
        idx = next(i for i, r in enumerate(out) if r[0] == "1101")
        self.assertEqual(out[idx], ["1101", "台泥", "外資買賣超", "0", "0", "11"])
        self.assertEqual(out[idx + 1], ["", "", "投信買賣超", "0", "0", "22"])
        self.assertEqual(out[idx + 2], ["", "", "自營商買賣超", "0", "0", "33"])


class OverwriteSameDateTest(unittest.TestCase):
    def test_rerun_same_day_overwrites(self):
        existing = [
            ["代號", "名稱", "類別", "20260422", "20260423"],
            ["0050", "元大台灣50", "外資買賣超", "100", "999"],  # 999 是錯的,要被覆蓋
            ["", "", "投信買賣超", "10", "888"],
            ["", "", "自營商買賣超", "1", "777"],
        ]
        parsed = _make_parsed("20260423", {
            "0050": {"外資買賣超": 200, "投信買賣超": 20, "自營商買賣超": 2},
        }, names={"0050": "元大台灣50"})
        out = timeseries_merge.merge(existing, parsed)
        # header 不變
        self.assertEqual(out[0], ["代號", "名稱", "類別", "20260422", "20260423"])
        self.assertEqual(out[1], ["0050", "元大台灣50", "外資買賣超", "100", "200"])
        self.assertEqual(out[2], ["", "", "投信買賣超", "10", "20"])
        self.assertEqual(out[3], ["", "", "自營商買賣超", "1", "2"])


class FloatFormattingTest(unittest.TestCase):
    def test_int_valued_float_renders_as_int(self):
        parsed = _make_parsed("20260424", {
            "X": {"外資買賣超": 99.0, "投信買賣超": 99.5, "自營商買賣超": 0},
        })
        out = timeseries_merge.merge(None, parsed)
        # 99.0 → "99",99.5 → "99.5"
        self.assertEqual(out[1][3], "99")
        self.assertEqual(out[2][3], "99.5")
        self.assertEqual(out[3][3], "0")

    def test_none_renders_zero(self):
        parsed = _make_parsed("20260424", {
            "X": {"外資買賣超": None, "投信買賣超": 1, "自營商買賣超": 2},
        })
        out = timeseries_merge.merge(None, parsed)
        self.assertEqual(out[1][3], "0")


class CategoryOrderToleranceTest(unittest.TestCase):
    """既有 block 的 category 順序若被 GAS 寫成不同順序,parser 仍應按 cat 名稱配對。"""

    def test_swapped_category_order_in_existing(self):
        existing = [
            ["代號", "名稱", "類別", "20260423"],
            # 順序故意: 自營/外資/投信 (不照 parser 的順序)
            ["0050", "元大台灣50", "自營商買賣超", "1"],
            ["", "", "外資買賣超", "100"],
            ["", "", "投信買賣超", "10"],
        ]
        parsed = _make_parsed("20260424", {
            "0050": {"外資買賣超": 999, "投信買賣超": 99, "自營商買賣超": 9},
        }, names={"0050": "元大台灣50"})
        out = timeseries_merge.merge(existing, parsed)
        # 同樣 swapped 順序,只是補一欄
        self.assertEqual(out[1][3:], ["1", "9"])    # 自營商
        self.assertEqual(out[2][3:], ["100", "999"])  # 外資
        self.assertEqual(out[3][3:], ["10", "99"])    # 投信


if __name__ == "__main__":
    unittest.main()
