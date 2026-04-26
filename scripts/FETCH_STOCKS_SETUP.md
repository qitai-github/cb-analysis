# fetch_stocks.py 設定指南

GitHub Actions 備援,**平行於** GAS 主路徑 (`統一監控Phase1/AutoRepair.gs`)。
當 GAS 因 307 / bot 偵測失敗時,由這裡在 GitHub 的 IP 上重抓,同名覆蓋到相同
Drive 資料夾,讓下游 GAS pipeline 透明無感。

涵蓋 6 個來源 (與 `CFG.DRIVE` 完全對應):

| folder_key | 用途 | 檔名 |
|---|---|---|
| `STOCK_INST_TWSE` | 個股法人(上市) | `TWSE_T86_YYYYMMDD.csv` |
| `STOCK_INST_TPEX` | 個股法人(上櫃) | `TPEx_T86_YYYYMMDD.csv` |
| `STOCK_PRICE_TWSE` | 個股交易(上市) | `TWSE-Daily-YYYYMMDD.csv` |
| `STOCK_PRICE_TPEX` | 個股交易(上櫃) | `TPEx-EW-YYYYMMDD.csv` |
| `CB_PRICE` | CB每日交易 | `RSta0113.YYYYMMDD-C.csv` |
| `CB_INST` | CB每日法人 | `ThreePrimaryCB_YYYYMMDD.csv` |

其中 `STOCK_INST_TWSE` 主路徑沒有 OpenAPI 可降級,備援價值最大。

## 1. 建立 Google Service Account

1. [GCP Console](https://console.cloud.google.com/) → 選/新建專案
2. APIs & Services → Library → **Google Drive API** → Enable
3. IAM & Admin → Service Accounts → **Create Service Account**
   - Name: `stocks-backup` (隨意)
   - Role: 不用指定 (Drive 權限靠共用資料夾授權,不靠 IAM)
4. 建好的 SA → Keys → **Add Key → JSON** → 下載 `.json`

## 2. 把 6 個 Drive 資料夾共用給 SA

SA 本身沒有「我的雲端硬碟」,必須把目標資料夾個別分享給它:

1. 打開下載的 `.json`,記 `client_email` 欄位 (`...@your-project.iam.gserviceaccount.com`)
2. 到 Google Drive,找 GAS `CFG.DRIVE` 裡 6 個資料夾 (見
   [Config.gs.txt](../GoogleAppScript/統一監控Phase1/Config.gs.txt))
3. 每個資料夾都「共用」→ 貼上 SA email → 權限 **編輯者**
4. 從資料夾網址抓 ID:`drive.google.com/drive/folders/【這段就是 ID】`

只備援部分來源也行,未列在 `DRIVE_FOLDERS` 的 key 會被自動跳過。

## 3. 本機測試

```bash
cd scripts
cp .env.example .env
# 編輯 .env 填入 GOOGLE_CREDENTIALS 與 DRIVE_FOLDERS 的 6 個 folder ID

pip install -r requirements-stocks.txt

# 載入 .env 並執行 (Windows PowerShell)
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') {
    $env:($matches[1].Trim()) = $matches[2].Trim("'")
  }
}
python fetch_stocks.py

# 只跑指定來源測試
$env:SOURCES = "STOCK_INST_TWSE,CB_INST"
python fetch_stocks.py

# 指定日期補抓
$env:FETCH_DATE = "20260422"
python fetch_stocks.py
```

## 4. GitHub Actions Secrets

Repo → Settings → Secrets and variables → Actions → **New repository secret**

| Name | Value |
|------|-------|
| `GOOGLE_CREDENTIALS` | SA JSON 整份內容 (**完整貼,包含 `{` 和 `}`,不要加引號**) |
| `DRIVE_FOLDERS` | 6 個 folder ID 的 JSON,格式見 [.env.example](.env.example)。**貼 JSON 字串本身,不要加外層引號** |

## 5. 啟用 workflow

- 自動:週一到週五 18:00 Taipei (10:00 UTC),
  見 [`.github/workflows/fetch-stocks.yml`](../.github/workflows/fetch-stocks.yml)
- 手動:Actions tab → Fetch Stocks Backup → **Run workflow**
  - `date`:填 YYYYMMDD 補抓特定日期
  - `sources`:填 `STOCK_INST_TWSE,CB_INST` 只跑這幾個,空白則 6 個全跑

## 6. 除錯

- `♻️ 覆蓋: ...` = GAS 已抓到,Python 覆蓋同名檔 (預期行為)
- `✅ 新建: ...` = GAS 那天漏抓,備援成功救回
- `ℹ️ ... 查詢無資料` = 200 但假日 / 非交易日 (正常)
- `⚠️ retry ...` = 當次 attempt 失敗,看原因判斷
  - `HTTP 307` = bot 偵測,已自動重新暖身重試
  - `回應是 HTML` = cookie 失效 / captcha 頁,已重新暖身
  - `內容過短` = 回到 200 但 body 太小
- `❌ 抓取失敗: 放棄 ... 5 次重試仍失敗` = 5 次都沒過,看前面 retry 訊息推斷根因

## 編碼與 saveMode 對齊 GAS

Python 依 `save_mode` 決定上傳 bytes:

| save_mode | 對應 GAS | Python 處理 |
|---|---|---|
| `raw` | `folder.createFile(blob)` 保留 Big5 | 原始 bytes 直上傳 |
| `textBlob` | `folder.createFile(Utilities.newBlob(text, "text/csv", ...))` | 解碼 MS950 → UTF-8 bytes |
| `createFile` | `folder.createFile(name, text, MimeType.CSV)` UTF-8 | 解碼 Big5 → UTF-8 bytes |

下游 GAS parser (`processTwseT86` 等) 對 `raw` 模式有 UTF-8 fallback,就算
Python 誤存 UTF-8 也能讀,但為求保險仍按原 saveMode 分類存。
