"""4 個 CSV parser 對 6 個 fixture 的 spot-check。

跑法 (從 scripts/ 目錄):
  python -m unittest tests.test_parsers -v

或:
  python -m unittest discover -s tests -v

不需要 pytest。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

# 讓 `python -m unittest tests.test_parsers` 在 scripts/ 跑得起來
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from parsers import cb_inst, cb_price, margin_trading, stock_inst, stock_price  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
DATE = "20260424"


def _load(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def _find(rows, **kw):
    """從 rows 找第一個符合所有 kw 的 dict。"""
    for r in rows:
        if all(r.get(k) == v for k, v in kw.items()):
            return r
    return None


class StockInstTwseTest(unittest.TestCase):
    def setUp(self):
        self.result = stock_inst.parse(
            _load("TWSE_T86_20260424.csv"), market="TWSE", trade_date=DATE)

    def test_basic_shape(self):
        r = self.result
        self.assertEqual(r.db_table, "stock_inst")
        self.assertEqual(r.timeseries_key, "cbInstitutional")
        self.assertEqual(r.timeseries_categories,
                         ["外資買賣超", "投信買賣超", "自營商買賣超"])
        self.assertEqual(r.trade_date, "20260424")
        self.assertGreater(len(r.db_rows), 100, "TWSE 上市應有上百檔")

    def test_0050_values(self):
        r = _find(self.result.db_rows, stock_id="0050")
        self.assertIsNotNone(r, "0050 必須存在於 TWSE T86")
        self.assertEqual(r["market"], "TWSE")
        self.assertEqual(r["stock_name"], "元大台灣50")
        self.assertEqual(r["trade_date"], "2026-04-24")
        # 外陸資 (col 4) + 外資自營 (col 7) = 31,238,205 + 0
        self.assertEqual(r["foreign_net"], 31_238_205)
        # 投信買賣超 (col 10)
        self.assertEqual(r["investment_net"], 777_000)
        # 自營商合計 (col 11)
        self.assertEqual(r["dealer_net"], 21_704_999)
        # 三大法人 (col 18)
        self.assertEqual(r["total_inst_net"], 53_720_204)

    def test_daily_values_shape(self):
        dv = self.result.daily_values.get("0050")
        self.assertIsNotNone(dv)
        self.assertEqual(set(dv.keys()),
                         {"外資買賣超", "投信買賣超", "自營商買賣超"})
        self.assertEqual(dv["投信買賣超"], 777_000)


class StockInstTpexTest(unittest.TestCase):
    def setUp(self):
        self.result = stock_inst.parse(
            _load("TPEx_T86_20260424.csv"), market="TPEX", trade_date=DATE)

    def test_basic_shape(self):
        self.assertEqual(self.result.db_table, "stock_inst")
        self.assertGreater(len(self.result.db_rows), 100)

    def test_00679b_values(self):
        r = _find(self.result.db_rows, stock_id="00679B")
        self.assertIsNotNone(r)
        self.assertEqual(r["market"], "TPEX")
        # 外資及陸資合計 (col 10)
        self.assertEqual(r["foreign_net"], 10_419_233)
        # 投信買賣超 (col 13)
        self.assertEqual(r["investment_net"], 0)
        # 自營商合計 (col 22)
        self.assertEqual(r["dealer_net"], 502_617)
        # 三大法人 (col 23)
        self.assertEqual(r["total_inst_net"], 10_921_850)


class StockPriceTwseTest(unittest.TestCase):
    def setUp(self):
        self.result = stock_price.parse(
            _load("TWSE-Daily-20260424.csv"), market="TWSE", trade_date=DATE)

    def test_basic_shape(self):
        r = self.result
        self.assertEqual(r.db_table, "stock_quotes")
        self.assertEqual(r.timeseries_key, "stockTrading")
        self.assertEqual(r.timeseries_categories,
                         ["成交股數", "開盤價", "最高價", "最低價", "收盤價"])
        self.assertGreater(len(r.db_rows), 100, "TWSE 個股應有上百檔")

    def test_0050_values(self):
        r = _find(self.result.db_rows, stock_id="0050")
        self.assertIsNotNone(r)
        self.assertEqual(r["market"], "TWSE")
        self.assertAlmostEqual(r["open_price"], 87.60)
        self.assertAlmostEqual(r["high_price"], 89.95)
        self.assertAlmostEqual(r["low_price"], 87.55)
        self.assertAlmostEqual(r["close_price"], 89.95)
        self.assertAlmostEqual(r["change_amt"], 3.60)
        self.assertEqual(r["volume_shares"], 129_885_911)
        self.assertEqual(r["volume_lots"], 129_885)  # 整除 1000

    def test_change_sign_negative(self):
        # 抽一檔肯定下跌的 (TWSE 列出指數會有 + / -;個股 fixture 也應有 -)
        for r in self.result.db_rows:
            if r.get("change_amt") is not None and r["change_amt"] < 0:
                return
        self.fail("整份 fixture 找不到任何 change_amt < 0,_apply_sign 可能沒接到 -")


class StockPriceTpexTest(unittest.TestCase):
    def setUp(self):
        self.result = stock_price.parse(
            _load("TPEx-EW-20260424.csv"), market="TPEX", trade_date=DATE)

    def test_basic_shape(self):
        self.assertEqual(self.result.db_table, "stock_quotes")
        self.assertGreater(len(self.result.db_rows), 50)

    def test_00687b_values(self):
        r = _find(self.result.db_rows, stock_id="00687B")
        self.assertIsNotNone(r)
        self.assertEqual(r["market"], "TPEX")
        self.assertAlmostEqual(r["close_price"], 28.02)
        self.assertAlmostEqual(r["change_amt"], 0.02)
        self.assertAlmostEqual(r["open_price"], 28.07)
        self.assertEqual(r["volume_shares"], 21_162_000)
        self.assertEqual(r["volume_lots"], 21_162)

    def test_change_sign_negative(self):
        # TPEx-EW 漲跌欄已含 -,parse_float 應正確 keep 負號
        r = _find(self.result.db_rows, stock_id="00679B")
        self.assertIsNotNone(r)
        self.assertEqual(r["change_amt"], 0.0)  # fixture 顯示 "0.00"


class CBPriceTest(unittest.TestCase):
    def setUp(self):
        self.result = cb_price.parse(
            _load("RSta0113.20260424-C.csv"), trade_date=DATE)

    def test_basic_shape(self):
        r = self.result
        self.assertEqual(r.db_table, "cb_quotes")
        self.assertEqual(r.timeseries_key, "cbDailyTrading")
        self.assertEqual(r.timeseries_categories,
                         ["收盤價", "開盤價", "最高價", "最低價", "成交量(張)"])
        self.assertGreater(len(r.db_rows), 10)

    def test_11011_values(self):
        r = _find(self.result.db_rows, cb_id="11011")
        self.assertIsNotNone(r)
        self.assertEqual(r["cb_name"], "台泥一永")
        self.assertAlmostEqual(r["close_price"], 99.00)
        self.assertAlmostEqual(r["open_price"], 98.65)
        self.assertAlmostEqual(r["high_price"], 99.00)
        self.assertAlmostEqual(r["low_price"], 98.65)
        self.assertAlmostEqual(r["ref_price"], 99.00)
        self.assertEqual(r["volume_lots"], 3)

    def test_yi_jia_skipped(self):
        """每個 CB 都有「等價」+「議價」兩列,parser 應只保留等價。
        因此 (trade_date, cb_id) 唯一,db_rows 不應有重複 cb_id。"""
        ids = [r["cb_id"] for r in self.result.db_rows]
        self.assertEqual(len(ids), len(set(ids)),
                         "重複 cb_id 表示議價沒被過濾")

    def test_no_trade_close_is_none(self):
        # 12561 鮮活果汁一KY 收市為空,parser 應給 close_price=None,但 ref_price=98.30
        r = _find(self.result.db_rows, cb_id="12561")
        self.assertIsNotNone(r)
        self.assertIsNone(r["close_price"])
        self.assertAlmostEqual(r["ref_price"], 98.30)


class CBInstTest(unittest.TestCase):
    def setUp(self):
        self.result = cb_inst.parse(
            _load("ThreePrimaryCB_20260424.csv"), trade_date=DATE)

    def test_basic_shape(self):
        r = self.result
        self.assertEqual(r.db_table, "cb_inst")
        self.assertEqual(r.timeseries_key, "cbBondInstitutional")
        self.assertEqual(r.timeseries_categories,
                         ["外資買賣超", "投信買賣超", "自營商買賣超"])
        self.assertGreater(len(r.db_rows), 10)

    def test_32608_values(self):
        r = _find(self.result.db_rows, cb_id="32608")
        self.assertIsNotNone(r)
        self.assertEqual(r["cb_name"], "威剛八")
        self.assertEqual(r["foreign_net"], 0)
        self.assertEqual(r["investment_net"], 0)
        self.assertEqual(r["dealer_net"], -147)
        self.assertEqual(r["total_inst_net"], -147)

    def test_37022_mixed_sign(self):
        # 37022 大聯大二: 外資 +6, 投信 0, 自營 -17, 總 -11
        r = _find(self.result.db_rows, cb_id="37022")
        self.assertIsNotNone(r)
        self.assertEqual(r["foreign_net"], 6)
        self.assertEqual(r["dealer_net"], -17)
        self.assertEqual(r["total_inst_net"], -11)


class MarginTradingTwseTest(unittest.TestCase):
    DATE_LOCAL = "20260508"

    def setUp(self):
        self.result = margin_trading.parse(
            _load("MI_MARGN_STOCK_20260508.csv"),
            market="TWSE", trade_date=self.DATE_LOCAL)

    def test_basic_shape(self):
        r = self.result
        self.assertEqual(r.db_table, "stock_margin")
        self.assertEqual(r.timeseries_key, "marginTrading")
        self.assertEqual(r.timeseries_categories,
                         ["融資餘額", "融資增減", "融券餘額", "融券增減"])
        self.assertEqual(r.trade_date, "20260508")
        self.assertGreater(len(r.db_rows), 500, "TWSE 上市應有上千檔")

    def test_skips_summary_row(self):
        # 「合計」列代號是全形空白,不該進 db_rows
        names = [r["stock_name"] for r in self.result.db_rows]
        self.assertNotIn("合計", names)

    def test_1101_values(self):
        r = _find(self.result.db_rows, stock_id="1101")
        self.assertIsNotNone(r, "1101 必須存在")
        self.assertEqual(r["market"], "TWSE")
        self.assertEqual(r["stock_name"], "台泥")
        self.assertEqual(r["trade_date"], "2026-05-08")
        # 融資 1,481 / 398 / 12 / 31,054 → 32,125
        self.assertEqual(r["margin_buy"], 1481)
        self.assertEqual(r["margin_sell"], 398)
        self.assertEqual(r["margin_cash_repay"], 12)
        self.assertEqual(r["margin_balance_prev"], 31054)
        self.assertEqual(r["margin_balance"], 32125)
        # 融券:TWSE col 8=買進(回補)=12 / col 9=賣出(建立)=3
        self.assertEqual(r["short_buy_close"], 12)
        self.assertEqual(r["short_sell_open"], 3)
        self.assertEqual(r["short_share_repay"], 0)
        self.assertEqual(r["short_balance_prev"], 116)
        self.assertEqual(r["short_balance"], 107)
        self.assertEqual(r["net_offset"], 10)

    def test_1101_daily_values(self):
        dv = self.result.daily_values.get("1101")
        self.assertIsNotNone(dv)
        self.assertEqual(set(dv.keys()),
                         {"融資餘額", "融資增減", "融券餘額", "融券增減"})
        self.assertEqual(dv["融資餘額"], 32125)
        self.assertEqual(dv["融資增減"], 32125 - 31054)   # +1071
        self.assertEqual(dv["融券餘額"], 107)
        self.assertEqual(dv["融券增減"], 107 - 116)        # -9


class MarginTradingTpexTest(unittest.TestCase):
    DATE_LOCAL = "20260508"

    def setUp(self):
        self.result = margin_trading.parse(
            _load("RSTA3106_20260508.csv"),
            market="TPEX", trade_date=self.DATE_LOCAL)

    def test_basic_shape(self):
        self.assertEqual(self.result.db_table, "stock_margin")
        self.assertEqual(self.result.timeseries_key, "marginTrading")
        self.assertGreater(len(self.result.db_rows), 100)

    def test_00679b_values(self):
        # ETF 元大美債20年: 4980 + 62 - 109 - 0 = 4933 / 17 + 0 - 16 - 0 = 1
        r = _find(self.result.db_rows, stock_id="00679B")
        self.assertIsNotNone(r)
        self.assertEqual(r["market"], "TPEX")
        self.assertEqual(r["stock_name"], "元大美債20年")
        self.assertEqual(r["margin_balance_prev"], 4980)
        self.assertEqual(r["margin_buy"], 62)
        self.assertEqual(r["margin_sell"], 109)
        self.assertEqual(r["margin_cash_repay"], 0)
        self.assertEqual(r["margin_balance"], 4933)
        # TPEX 融券: col 11=券賣(建立)=0, col 12=券買(回補)=16
        self.assertEqual(r["short_sell_open"], 0)
        self.assertEqual(r["short_buy_close"], 16)
        self.assertEqual(r["short_share_repay"], 0)
        self.assertEqual(r["short_balance_prev"], 17)
        self.assertEqual(r["short_balance"], 1)
        self.assertEqual(r["net_offset"], 0)

    def test_00679b_daily_values(self):
        dv = self.result.daily_values.get("00679B")
        self.assertIsNotNone(dv)
        self.assertEqual(dv["融資餘額"], 4933)
        self.assertEqual(dv["融資增減"], 4933 - 4980)      # -47
        self.assertEqual(dv["融券餘額"], 1)
        self.assertEqual(dv["融券增減"], 1 - 17)           # -16


class MarginTradingHeaderDateGuardTest(unittest.TestCase):
    """防止 TWSE/TPEX 服務異常回舊日期資料 (踩過 5/8 收到 2017/12/18 案例)。"""

    def test_twse_wrong_date_raises(self):
        # 拿真實 5/8 fixture 但帶 trade_date='20260507' 進來
        with self.assertRaises(ValueError) as ctx:
            margin_trading.parse(
                _load("MI_MARGN_STOCK_20260508.csv"),
                market="TWSE", trade_date="20260507")
        self.assertIn("不等於期望 20260507", str(ctx.exception))

    def test_tpex_wrong_date_raises(self):
        with self.assertRaises(ValueError) as ctx:
            margin_trading.parse(
                _load("RSTA3106_20260508.csv"),
                market="TPEX", trade_date="20260507")
        self.assertIn("不等於期望 20260507", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
