-- ──────────────────────────────────────────────────────────────────────
-- 融資融券 (margin trading) schema
-- 對應 parsers/margin_trading.py + parse_and_export.py 的 marginTrading key
-- 跑法: Supabase Dashboard → SQL Editor 整段貼進去 (idempotent)
-- ──────────────────────────────────────────────────────────────────────

-- ── stock_margin: 個股每日融資融券餘額 (TWSE+TPEX) ────────────────────
-- 單位: 張 (TWSE 跟 TPEX 兩邊原始 CSV 都已是張,不用換算)
-- TWSE 融券欄位順序 = 買進 / 賣出 (回補 / 建立)
-- TPEX 融券欄位順序 = 券賣 / 券買 (顛倒,parser 已對齊到統一語意)
--   short_sell_open  = 融券「賣出」(建立空頭) → TWSE 融券賣出 / TPEX 券賣
--   short_buy_close  = 融券「買進」(回補空頭) → TWSE 融券買進 / TPEX 券買
create table if not exists stock_margin (
    trade_date           date    not null,
    market               text    not null check (market in ('TWSE','TPEX')),
    stock_id             text    not null,
    stock_name           text,
    margin_buy           bigint,  -- 融資買進 (張)
    margin_sell          bigint,  -- 融資賣出
    margin_cash_repay    bigint,  -- 融資現金償還
    margin_balance_prev  bigint,  -- 前日融資餘額
    margin_balance       bigint,  -- 今日融資餘額
    short_sell_open      bigint,  -- 融券賣出 (建立)
    short_buy_close      bigint,  -- 融券買進 (回補)
    short_share_repay    bigint,  -- 融券現券償還
    short_balance_prev   bigint,  -- 前日融券餘額
    short_balance        bigint,  -- 今日融券餘額
    net_offset           bigint,  -- 資券互抵 / 資券相抵
    fetched_at           timestamptz default now(),
    primary key (trade_date, market, stock_id)
);
create index if not exists idx_stock_margin_id_date
    on stock_margin (stock_id, trade_date desc);
