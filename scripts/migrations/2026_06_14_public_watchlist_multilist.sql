-- 把 public_watchlist 從「單清單」改成「多清單」
-- 把 PK 從 code 換成 (list_name, code) 複合鍵
-- 現有資料全部歸到 '新天團'

-- 跑法:Supabase Dashboard → SQL Editor → 貼入執行
-- 失敗回滾:照下面 reverse 段反向跑

BEGIN;

-- 1) 加欄位,既有 row 自動補 '新天團'
ALTER TABLE public.public_watchlist
  ADD COLUMN IF NOT EXISTS list_name TEXT NOT NULL DEFAULT '新天團';

-- 2) 拆掉舊的 PK / UNIQUE (只看 code)
ALTER TABLE public.public_watchlist
  DROP CONSTRAINT IF EXISTS public_watchlist_pkey;
ALTER TABLE public.public_watchlist
  DROP CONSTRAINT IF EXISTS public_watchlist_code_key;

-- 3) 設複合 PK (list_name, code)
ALTER TABLE public.public_watchlist
  ADD PRIMARY KEY (list_name, code);

COMMIT;

-- ── Reverse (要回滾的話) ─────────────────────────────────────
-- BEGIN;
-- ALTER TABLE public.public_watchlist DROP CONSTRAINT IF EXISTS public_watchlist_pkey;
-- DELETE FROM public.public_watchlist WHERE list_name <> '新天團';
-- ALTER TABLE public.public_watchlist ADD PRIMARY KEY (code);
-- ALTER TABLE public.public_watchlist DROP COLUMN list_name;
-- COMMIT;
