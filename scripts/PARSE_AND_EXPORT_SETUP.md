# parse_and_export.py 設定指南

本管線在 `fetch_stocks.py` 跑完後接力:把 6 CSV 解析 → 寫 Supabase + 合併 `data/all-data.json` → git push → Telegram 通知。

> **目前進度:Step 1 (Supabase schema + 連線 smoke)** 已完成。
> Step 2 / 3 / 4 待後續實作。

---

## Step 1 設定步驟 (現在執行這段)

### 1-1. 建立 Supabase 專案

1. 進 https://supabase.com,免費註冊 (用 GitHub 登入最快)
2. **New project**
   - Name: 隨意 (例 `cb-analysis`)
   - Database password: 自設一組強密碼,**自己保管好** (這個密碼用於直連 Postgres,不會被 client lib 用到)
   - Region: **East Asia (Tokyo)** (台灣連最快)
   - Pricing plan: **Free**
3. 等 1~2 分鐘建立完成

### 1-2. 取得 URL + service_role key

進專案後,左下角 ⚙ **Project Settings → API**:

| 欄位 | 寫到 .env |
|---|---|
| Project URL | `SUPABASE_URL` |
| Project API keys → **service_role** (secret) | `SUPABASE_SERVICE_ROLE_KEY` |

> ⚠️ `service_role` 會 bypass RLS,**只在 server-side / GitHub Actions** 用,不要放進前端網頁。

### 1-3. 建立 schema

左側 `SQL Editor` → `+ New query` → 把 [`sql/001_schema.sql`](sql/001_schema.sql) 整段貼進去 → **Run**

執行成功後左側 `Table Editor` 應看到 5 張表:
- `stock_quotes`
- `stock_inst`
- `cb_quotes`
- `cb_inst`
- `fetch_runs`

### 1-4. 本機執行 smoke test 驗證連線

```bash
cd scripts
pip install -r requirements-stocks.txt   # 第一次 / 多了 supabase 套件需重跑
```

把 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 加進 `.env` (參考 `.env.example`),然後:

**Windows PowerShell**:
```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim("'`""), 'Process')
  }
}
python -m lib.supabase_client smoke
```

**Bash (Git Bash / WSL)**:
```bash
set -a; source .env; set +a
python -m lib.supabase_client smoke
```

預期輸出:
```
=== Supabase smoke test ===
URL: https://xxxxxxxxxxxx.supabase.co
→ insert 測試列到 fetch_runs...
✓ inserted id=1
→ select 讀回...
✓ 讀回 source=__smoke__, status=ok
→ 檢查 4 張業務表存在...
✓ stock_quotes 可訪問
✓ stock_inst 可訪問
✓ cb_quotes 可訪問
✓ cb_inst 可訪問
→ 刪除測試列...
✓ 已刪除 id=1

🎉 smoke test 全通過
```

如果上面跑得起來,Step 1 就 OK,接著進 Step 2。

---

## Step 2 完成 — 4 個 CSV parser

`parsers/` 4 個模組 + `tests/test_parsers.py` 18/18 通過。

驗證:
```powershell
cd scripts
python -m unittest tests.test_parsers -v
```

## Step 3 完成 — 主編排 parse_and_export.py

整合 fetcher → parser → 白名單篩選 → DB upsert → 合併 all-data.json + 5 個 Sheet key。

### 3-1 本機驗證 (用 fixture 模擬 Drive)

不用 Drive 憑證,完整跑一遍 (DB 跳過、Sheet 跳過、JSON 寫到 temp):

**Windows PowerShell**:
```powershell
cd scripts
$env:DRIVE_FROM_FIXTURES = "1"
$env:DRIVE_FOLDERS = '{"STOCK_INST_TWSE":"x","STOCK_INST_TPEX":"x","STOCK_PRICE_TWSE":"x","STOCK_PRICE_TPEX":"x","CB_PRICE":"x","CB_INST":"x"}'

python parse_and_export.py 20260424 --skip-db --skip-sheet --out-json $env:TEMP\test.json
```

預期輸出最後幾行:
```
⊕ stockTrading: 1,656 列 (header + 331 stocks × 5 categories)
⊕ cbInstitutional: 994 列 (header + 323 stocks × 3 categories)
⊕ cbDailyTrading: 1,856 列 (header + 366 stocks × 5 categories)
⊕ cbBondInstitutional: 1,108 列 (header + 177 stocks × 3 categories)
✓ 已寫 ...test.json (8.52 MB)
🏁 全部完成
```

關鍵點:**JSON 大小應接近 production 的 8.48 MB**,不是 39 MB (代表白名單篩選有作用)。

```powershell
Remove-Item Env:DRIVE_FROM_FIXTURES   # 結束 dev 模式
```

### 3-2 真實 Drive 跑 (需 GOOGLE_CREDENTIALS + DRIVE_FOLDERS)

把 `scripts/.env` 內 `GOOGLE_CREDENTIALS` / `DRIVE_FOLDERS` 兩行填入(從 `FETCH_STOCKS_SETUP.md` 那邊用過的值複製過來;與 fetch_stocks.py 共用同一份 SA。)

```powershell
# 載入 .env
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim("'`""), 'Process')
  }
}

# Sheet 跳過,先確認 Drive + parser + DB 串得起來,JSON 寫到 temp
python parse_and_export.py 20260424 --skip-sheet --out-json $env:TEMP\test.json

# 全套真跑 (會覆寫 data/all-data.json,先確保 git 是 clean 的可以隨時還原)
python parse_and_export.py 20260424
```

### 白名單篩選說明

`stockTrading` / `cbInstitutional` 用既有 `data/all-data.json` 的 stock_id 集合做白名單,跟 GAS 行為對齊 (~331 檔 CB-linked 個股)。否則 TWSE T86 會塞進 14K+ 權證,JSON 從 8MB 變 39MB 且 Supabase free tier 撐不住。

**新 CB 出現但 underlying stock 不在既有白名單時,該股會被丟棄。** 之後手動補:
1. 手動加入既有 all-data.json 該 key (給該 stock 一個全 0 的 block),或
2. 等下游 GAS Sheet pipeline 把該 stock 加進去,Python 下次跑就會帶。

### Flag 對照表

| Flag | 用途 |
|---|---|
| `--dry-run`     | = `--skip-db --skip-json` (仍抓 + 解析,適合 debug) |
| `--skip-db`     | 不寫 Supabase (data + fetch_runs 都不寫) |
| `--skip-sheet`  | 跳過 5 個 Sheet 抓取 |
| `--skip-json`   | 不寫 JSON |
| `--out-json X`  | 改寫到 X (不覆蓋 production data/all-data.json) |
| (env) `DRIVE_FROM_FIXTURES=1` | Drive 改吃 scripts/tests/fixtures/ |

## Step 4 完成 — Telegram + GitHub Actions

### 4-1 取得 Telegram chat_id

如果你還不知道 chat_id:
1. 跟你的 bot 先傳一句訊息 (任何字)
2. 瀏覽器開: `https://api.telegram.org/bot<TG_BOT_TOKEN>/getUpdates`
3. 找回應 JSON 內的 `result[*].message.chat.id`,那串數字就是

把 `TG_BOT_TOKEN` / `TG_CHAT_ID` 填進 `scripts/.env`。

### 4-2 本機驗 bot 通

```powershell
cd scripts
python -m lib.telegram smoke
```

預期:Telegram 收到一則 sample 訊息 (含 6 來源 + 4 DB + 5 Sheet 的假資料)。
Console 印 `=== preview ===` 然後 `=== sending to TG ... === OK`。

收不到訊息常見原因:
- bot token / chat_id 錯了 → `getUpdates` 重新確認
- 你還沒主動跟 bot 對話過 → bot 沒辦法主動私訊

### 4-3 GitHub Secrets — 把 6 個值搬上去

Repo → **Settings → Secrets and variables → Actions → New repository secret**,加這 6 個:

| Name | 來源 |
|---|---|
| `GOOGLE_CREDENTIALS` | scripts/.env 同名值 (整段壓單行 JSON) |
| `DRIVE_FOLDERS` | scripts/.env 同名值 |
| `SUPABASE_URL` | scripts/.env 同名值 |
| `SUPABASE_SERVICE_ROLE_KEY` | scripts/.env 同名值 |
| `TG_BOT_TOKEN` | scripts/.env 同名值 |
| `TG_CHAT_ID` | scripts/.env 同名值 |

> ⚠️ 貼 secret 時不要包外層引號,直接貼 raw value。`GOOGLE_CREDENTIALS` 整段 JSON 是一行,貼進去就好。

### 4-4 手動跑一次驗證

Repo → **Actions** 頁籤 → 左側選 **Parse + Export** → 右側 **Run workflow** → 填 `date = 20260424` (或留空抓今天) → Run

預期:
1. 不到 1 分鐘跑完
2. Telegram 收到一則「✅ 台股管線」訊息
3. Repo 多一個 commit `Update data/all-data.json @ ...`(by github-actions[bot])

### 4-5 自動排程

`fetch-stocks.yml` 已是 Mon-Fri 18:00 TPE 自動跑。`parse-and-export.yml` 用 `workflow_run` 接在它後面,會自動跟著跑——**不用另外設 cron**。

如果 `fetch-stocks.yml` 從沒成功跑過 (因為以前缺 SECRETS),Step 4-3 加完 6 個 secret 後,下個工作日 18:00 兩條 workflow 就會接力跑起來。

