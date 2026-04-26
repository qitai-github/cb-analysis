-- ──────────────────────────────────────────────────────────────────────
-- 台股每日資料 schema
-- 跑法: 在 Supabase Dashboard → SQL Editor 整段貼進去執行 (idempotent)
-- 所有 table 都用 (trade_date, ...) 為 PK,upsert 重複日期時會覆蓋
-- ──────────────────────────────────────────────────────────────────────

-- ── stock_quotes: 個股每日 OHLCV (TWSE+TPEX) ─────────────────────────
create table if not exists stock_quotes (
    trade_date    date    not null,
    market        text    not null check (market in ('TWSE','TPEX')),
    stock_id      text    not null,
    stock_name    text,
    open_price    numeric,
    high_price    numeric,
    low_price     numeric,
    close_price   numeric,
    change_amt    numeric,
    volume_shares bigint,                           -- 成交股數
    volume_lots   bigint,                           -- 成交張數 (= 股數/1000)
    turnover      bigint,                           -- 成交金額(元)
    transactions  integer,                          -- 成交筆數
    fetched_at    timestamptz default now(),
    primary key (trade_date, market, stock_id)
);
create index if not exists idx_stock_quotes_id_date
    on stock_quotes (stock_id, trade_date desc);

-- ── stock_inst: 個股每日三大法人 ──────────────────────────────────────
create table if not exists stock_inst (
    trade_date     date not null,
    market         text not null check (market in ('TWSE','TPEX')),
    stock_id       text not null,
    stock_name     text,
    foreign_net    bigint,                          -- 外資買賣超(股)
    investment_net bigint,                          -- 投信買賣超
    dealer_net     bigint,                          -- 自營合計 (self+hedge)
    total_inst_net bigint,                          -- 三大法人合計
    fetched_at     timestamptz default now(),
    primary key (trade_date, market, stock_id)
);
create index if not exists idx_stock_inst_id_date
    on stock_inst (stock_id, trade_date desc);

-- ── cb_quotes: CB 每日 OHLCV ─────────────────────────────────────────
create table if not exists cb_quotes (
    trade_date  date not null,
    cb_id       text not null,
    cb_name     text,
    open_price  numeric,
    high_price  numeric,
    low_price   numeric,
    close_price numeric,
    ref_price   numeric,                            -- 明日參價 (close 為空時 fallback)
    volume_lots bigint,
    fetched_at  timestamptz default now(),
    primary key (trade_date, cb_id)
);
create index if not exists idx_cb_quotes_id_date
    on cb_quotes (cb_id, trade_date desc);

-- ── cb_inst: CB 每日三大法人 ─────────────────────────────────────────
create table if not exists cb_inst (
    trade_date     date not null,
    cb_id          text not null,
    cb_name        text,
    foreign_net    bigint,
    investment_net bigint,
    dealer_net     bigint,
    total_inst_net bigint,
    fetched_at     timestamptz default now(),
    primary key (trade_date, cb_id)
);
create index if not exists idx_cb_inst_id_date
    on cb_inst (cb_id, trade_date desc);

-- ── fetch_runs: 每次執行的監控紀錄 ────────────────────────────────────
create table if not exists fetch_runs (
    id          bigserial primary key,
    run_at      timestamptz default now(),
    trade_date  date not null,
    source      text not null,                      -- folder_key 或 'all-data.json'
    phase       text not null,                      -- 'fetch' | 'parse' | 'upsert' | 'export' | 'smoke'
    status      text not null,                      -- 'ok' | 'fail' | 'skip'
    row_count   integer,
    error_msg   text
);
create index if not exists idx_fetch_runs_run_at
    on fetch_runs (run_at desc);
create index if not exists idx_fetch_runs_date_source
    on fetch_runs (trade_date desc, source);
