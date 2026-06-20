# CB 可轉債分析平台 — 功能總覽

> 本檔記錄整個網頁(前端) + pipeline(後端) 的所有功能。修改功能時順手更新這份檔案。

---

## 0. 平台架構

```
┌─ 前端 (純 HTML/CSS/JS, 無框架, Chart.js v4) ────────────┐
│  index.html / js/* / css/style.css                      │
│  ↓ fetch                                                │
│  data/all-data.json (主要)  +  data/twsa.json (競拍)    │
│  + data/etf-holdings.json + Supabase (公用追蹤清單)     │
└─────────────────────────────────────────────────────────┘
            ↑ 每日寫入
┌─ 後端 pipeline (Python) ────────────────────────────────┐
│  scripts/fetch_stocks.py     抓 raw CSV/XLSX → Drive    │
│  scripts/parse_and_export.py 主合併 → all-data.json     │
│  scripts/parse_etf.py        ETF 持股                   │
│  scripts/vcp_scanner.py      VCP 選股                   │
│  scripts/backfill_*.py       回補資料                   │
└─────────────────────────────────────────────────────────┘
```

主入口：`index.html` (localhost 開啟用 `dev.bat`,啟動 Python http.server :8000)

---

## 1. 頂部導覽

- **Logo + 標題**「CB 可轉債分析平台」
- **4 個 tab**: `CB 分析` / `ETF 持股` / `VCP 選股` / `CB 日曆`
- **右上區**:
  - 資料日期 (從 stockTrading 末日推算)
  - 標的數狀態列
  - 手機版篩選 toggle (☰)
  - 重新載入按鈕 (↻) — 清快取 + 重抓 JSON

---

## 2. CB 分析 tab (主畫面)

### 2.1 左側篩選面板 ([js/filters.js](../js/filters.js))

| 群組 | 欄位 | 說明 |
|---|---|---|
| 基本 | 關鍵字搜尋 | 股號 / 股名 / CB 代碼 / CB 名稱 |
| 基本 | 追蹤清單 | 下拉選清單,顯示該清單內標的 |
| 個股篩選 | 產業搜尋 | 同時搜「產業分類」+「CB 經營項目」 |
| 個股篩選 | 線型T >= N日 | 連續 N 日符合 T 線型 |
| 個股篩選 | 第一根表態 | 量價突破訊號 |
| 狀態篩選 | 有 VCP / 三線 | 至少其中一個徽章 |
| 狀態篩選 | 新近 VCP / 三線 ≤ N 日 | streak 在 1~N 天 |
| 成交量 | 成交量(張) >= | 最新日 |
| 成交量 | 量比(今/5日均) >= | 流動性放大 |
| 法人篩選 | 法人累計天數 | 1/3/5/10/20/60/120/360 日下拉(影響表格欄) |
| 法人篩選 | 外資 / 投信 連續買超 >= N日 | 各別 |
| 法人篩選 | 外資 + 投信 同買超 | 勾選 |
| 融資融券 | 融資餘額 / 融券餘額 >= | 張 |
| 融資融券 | 今日 融資 / 融券 增加 | 勾選 |
| CB篩選 | 僅顯示有 CB 交易 | 排除尚未掛牌 |
| CB篩選 | 僅顯示初級市場案件 | 即將發 CB 的標的 |
| CB篩選 | CB溢價率 / 收盤價 >= / <= | 範圍 |
| CB篩選 | CB 第一根表態 | |
| CB篩選 | CB 創 N 日新高 | |
| CB篩選 | CB 成交量 / 量比 >= | 主 CB |
| CB條件 | 轉換價值 範圍 | |
| CB條件 | 已轉換比例 | 10/20/30/50% 以下 |
| CB條件 | 近期發行 | 30/60/90/180 天內 |
| CB條件 | 距到期日 | 30天~3年以上 |
| CB條件 | 提前賣回收益率 | 大於 0/1/3/5% |
| CB條件 | 到期收益率 | 大於 0/1/3/5% |
| CB條件 | 轉換開始日 | 已可 / 尚未可 轉換 |
| CB條件 | 擔保情形 | 有 / 無 擔保 |
| CB條件 | 排除暫停轉換 | 勾選 |

操作按鈕：套用篩選 / 清除條件 / 匯出 CSV / 匯入 CSV 追蹤

### 2.2 主表格 ([js/table.js](../js/table.js))

欄位：☆ / 代碼 / 名稱 / **VCP** / **三線** / 產業 / 收盤 / 漲跌% / 成交量(張) / **5日均量** / **20日均量** / 外資N日 / 投信N日 / 自營N日 / 法人合計 / 融資餘額 / 融資增減 / 融券餘額 / 融券增減

- 點欄位標題可排序 (狀態欄按 streak 數值)
- 點 ☆ 開啟追蹤清單選單 (可同時加多個清單)
- 點 row 開啟右側詳情面板

### 2.3 右側詳情面板 ([index.html:48-91](../index.html#L48-L91))

- **標題列**: ☆ + 代號 名稱 + VCP/三線 徽章
- **股價資訊** 卡片 (4 欄: 收盤 / 漲跌 / 漲跌% / 成交量) + **個股技術分析** 按鈕
- **CB 可轉債資訊** + **CB 技術分析** 按鈕
  - 每張 CB 卡: 收盤/漲跌/成交量/CB溢價率/成交金額/轉換價/發行總額/流通餘額/餘額增減/轉換期間/到期日/最近賣回日/賣回日/擔保/經營項目 + 「更多資訊」按鈕(展開承銷商/票面利率/剩餘年期/賣回價格/賣回殖利率/強制贖回日/停止轉換 細節)
  - 公司執行贖回權 / 轉換價格調整 事件條
  - **CB開標統計表** 按鈕 (有 auction PDF 才出現)
  - **得標預估價** 框 (有開標資料就顯示,**掛牌後仍保留**): 截標日前 5 交易日 MA5 / 轉換價 × 100 × {1.20,1.25,1.30,1.35}。截標日優先取開標「投標期間」末日,初級市場卡無 auction 時退回 polling 字串解析。轉換價用發行時原始價 (`issueConvPrice`)。實作 `_buildEstimateHtml` / `_auctionEndYmd`
  - **初級市場資訊**: CBAS 為主、元大次之、富邦第三,單一 CB 只顯示最新階段卡 (近期掛牌 > 近期生效 > 董事會公告),備註合併三方 [統一]/[元大]/[富邦]
- **新聞資訊** (近期股票相關)
- **投資重點儀表板** — 連結到 `investing.0099914.xyz/companies/<code>/`

---

## 3. 技術分析 Modal

### 3.1 個股技術分析 ([js/charts.js renderTech*](../js/charts.js), [js/app.js openTechModal](../js/app.js))

**標題列**:
- ◀ 股號 股名 ▶ — 置中,固定寬 280px,箭頭不跳動
- 左右箭頭切換 `filteredData` 內前後股票 (兩 modal 並排時連動同步)
- 右邊 `CB 技術分析` 按鈕 (點開後兩 modal 並排對照)
- ⚠️ header 左側「統一/富邦/元大額度」勾選 (未串接到主邏輯,待補)

**版面**: 上下兩區,**35% : 65%** 比例
- **上**: K 線 / 量能 + MA5/MA10/MA20 線 + 成交量 bar (色塊 legend 同列)
- **下**: 2 個檔案夾 tab 切換

| Tab | 3 個 sub-chart |
|---|---|
| 法人買賣 | 外資 / 投信 / 自營商 (bar=當日買賣超,line=累積持股,左軸=張,右軸=累積) |
| 資券 | 乖離率 5/10/20 三線 + 融資 (bar=增減,line=餘額) + 融券 |

時間軸: **60 個交易日** (`APP_CONFIG.techAnalysisDays`)

### 3.2 CB 技術分析

**標題列**: ◀ CB代號 CB名 ▶,多 CB 時用 tab pills 切換 (active 藍底)

**版面**: 同上下結構
- **上**: CB K 線 / 量能
- **下**: 2 個檔案夾 tab

| Tab | 3 個 sub-chart |
|---|---|
| 法人買賣 | CB 外資 / CB 投信 / CB 自營商 |
| 溢價/餘額 | CB 溢價率 / 流通餘額 / (保留空格) |

**共用 X 軸**: `cb.ohlcv ∩ stock.trading` 日期交集,排除非交易日

### 3.3 並排對照模式

- 任一 modal header 點對方按鈕 → 雙開
- 兩個 modal 各佔 49vw,任一關閉自動退出並排
- 左右箭頭切股票時雙邊連動

### 3.4 簡易報告 & 企業報告 (詳情面板 / 股價資訊)

詳情面板「股價資訊」標題列右側有兩顆按鈕:

| 按鈕 | 行為 | 來源 |
|---|---|---|
| `簡易報告` | iframe 內嵌 `investing.0099914.xyz/companies/{code}/` (對方已開放 frame-ancestors) | 外部一頁式投資儀表板 |
| `📄` | Modal 顯示 Drive 企業報告 PNG;header 一顆「📕 完整報告 PDF」按鈕,點開新分頁看 PDF | Drive `我的雲端硬碟/Telegram Bot/企業報告/` |

**📄 企業報告流程**:
- 後端 [build_company_reports_index.py](../scripts/build_company_reports_index.py) 掃 Drive 根 folder `1pck7m3BIKw69CtvByhhMV6D_wmbhHW1w`
- 每個子資料夾命名 `{name}{4-6位股號}/`,內含 `V1/`, `V2/`... 子資料夾 (新版本→更大號碼)
- 挑最大 Vn,從內找 `{code}.png` (簡易報告) 跟 `{code}_報告.pdf` (完整報告) 的 file id
- 寫 [data/company_reports.json](../data/company_reports.json): `{ stocks: { "3324": {png_id, pdf_id, version, folder_name}, ... }, _meta: {...} }`
- 整合到 `parse_and_export.py` **Phase 4.9**,每日 pipeline 自動重建索引
- 前端 [sheetsApi.js](../js/sheetsApi.js) `loadAll()` 併發載入,塞進 `data.companyReports`
- [app.js openCompanyReportModal](../js/app.js) 查 code → 動態組 thumbnail URL: `https://drive.google.com/thumbnail?id={png_id}&sz=w1600`,PDF 開 `https://drive.google.com/file/d/{pdf_id}/view`
- 找不到 → 顯示「此標的尚未產出企業報告」

**Service Account 要求**: `stocks-backup@cb-analysis-494501.iam.gserviceaccount.com` 需有「企業報告/」folder Viewer 權限

---

## 4. CB 日曆 tab ([js/calendar.js](../js/calendar.js))

- **月曆**: 6 週 × 7 天,事件以 chip 顯示
- **9 種事件類型** (左側 legend 可勾選):
  - CB發行日 / CB拆解日 (預設開)
  - CB詢圈期間 / CB競拍期間 / 董事會公告日
  - CB到期日 / CB賣回日 / 強制贖回日 / 重設轉換日
- 點 chip → 切回 CB 分析並開該股詳情
- **左側下方 CB 開標統計表**: 開標日 / CB名稱 / 最低 / 平均 / 競拍張
  - 按開標日新到舊排序
  - 點 row 開啟既有 auction modal
  - 背景 silentRefresh 完成後自動 re-render
- **資料來源**: 統一 CBAS (`lib/cbas_calendar.py`) 為主來源,**元大「發行案件」(`lib/yuanta_issuance.py`) 補充 + 核對**
  - 元大每天更新,常比統一更早收錄新案並補上掛牌/拆解日
  - 統一缺的 (cbCode,type) 事件用元大補進去 (每筆標 `source:'yuanta'`),統一已有則保留統一、不覆蓋
  - 核對摘要寫在 `cbasCalendar.yuantaCrosscheck` ({consistent, supplied, mismatches[], onlyYuanta[]}),並推送到 Telegram (`↳ 元大核對 補充N 不符N 僅元大N`)
  - 來源檔:Drive `CB發行案件-元大` folder,檔名 `CB發行案件彙整-元大債券{民國YYYMMDD}.xlsx`,挑日期最大那份

---

## 5. ETF 持股 tab ([js/etfView.js](../js/etfView.js))

- 14 檔 ETF 持股對比 (5 欄 grid)
- 與 CB 發行資訊交叉比對

---

## 6. VCP 選股 tab ([js/vcpView.js](../js/vcpView.js))

全台股 (上市+上櫃 ~1990 檔**個股**, 排除 ETF/權證) 的 VCP (Volatility Contraction
Pattern) 掃描。資料來源 `data/vcp.json` (由 `scripts/vcp_scanner.py` 產生)。

- **screener 表格**: ☆ / 代號 / 名稱 / 市 / 等級 / 狀態 / 分數 / 收盤 / Pivot / 距% / 波數 / 收斂深度 / 量縮
- **三級 tier** (一次掃描同時判定, 前端即時切換): 嚴格(高點帶寬≤3%) / 標準(≤4%) / 寬鬆(≤6%)
- **狀態 stage**: 突破(剛站上壓力線+帶量) / 待突破(貼壓力線下方) / 已突破(延伸) / 觀察
- 點列開 **K 線收斂圖 modal**: K棒+MA+量, 疊「壓力線(Pivot)金線」+「收斂區塊」+ 收斂明細表

### 6.1 偵測模型 (壓力線觸碰)

1. 盤中高低點 ZigZag (≥8% 反轉) 找轉折峰/谷;**反轉須在比極值更晚的交易日確認**
   (單根大振幅 K 棒不可同日製造一高一低)
2. 由高往低找壓力線 (ceiling),須全部滿足:
   - 觸碰 ≥2 次、首末橫跨 ≥20 日、最後觸碰在近 30 交易日內
   - **相鄰觸碰間隔 ≤35 日** (砍 V 型反彈, 如 2880)
   - **收斂期間高點不得高於壓力線 >6%** (砍被貫穿洗盤, 如 4722)
3. 每次觸頂 = 一波收斂;**低點只取高點「之後」的日子最低** (同日高低不重複取)
4. **Pivot = 有確認回檔的收斂波高點最高值** (不含突破當下尚無回檔的高點, 如 6672)
5. 共同條件: 高點群等高(帶寬) + 低點逐步墊高 + 深度遞減 (量縮僅計分不過濾)
6. 趨勢前提: Minervini 趨勢樣板 (收盤>MA50>MA150>MA200、距52週高≤25%…)
7. **嚴格級額外**: ≥3 波 + 帶寬≤3% + 現價距「近6個月高點」≤20%
8. stage 純看價格相對 Pivot: breakout(剛站上0~6%) / setup(下方0~near) /
   extended(上方>6%) / watch(下方>near);是否帶量另記於 `volSurge`

### 6.2 資料 pipeline (本機手動, 使用者要求時才跑)

```
Drive 上市/上櫃每日交易明細 CSV
  │ scripts/build_universe.py   抓 Drive → 本機快取 scripts/cache/universe/ (64MB, 不上傳)
  ▼  (增量: 只補快取沒有的交易日)
全市場 OHLCV 快取 (本機)
  │ scripts/vcp_scanner.py      讀快取 → 偵測 → data/vcp.json (+ scripts/output Excel)
  ▼
data/vcp.json  ──commit + push──▶ GitHub repo ──▶ 線上網站讀取
```

- ⚠️ 全市場歷史**只在 Drive 原始 CSV** (all-data.json / Supabase 都被 CB 白名單砍過)
- 快取與 Excel 在 `.gitignore`, **不上傳**; 上線只 commit `data/vcp.json`

---

## 7. CB 開標統計表 Modal

從 CB 卡按鈕 / CB 日曆側欄 row 點擊觸發。

- **發行資訊**: 發行公司 / 主辦承銷商 / 發行性質 / 承銷股數 / 競拍股數 / 投標期間 (`~` 後斷成 2 行) / 最低承銷價 / 競拍方式 / 最低/最高/平均得標價 / 公開承銷價 / 開標日期
- **得標明細表**: 序號 / 價格 / 股數(千股) / 金額(千元)

---

## 8. 追蹤清單系統 ([js/watchlist.js](../js/watchlist.js))

- 多清單管理 (建立 / 重新命名 / 刪除)
- 每股可加入多個清單
- ☆ 按鈕在主表第一欄 + 詳情面板標題
- 點 ☆ 開選單 (checkbox 勾選想加入的清單)
- 「預設」清單只在首次使用 / 從舊版遷移時建立,空清單會自動刪除
- 儲存於 `localStorage` (key=`cb_watchlist_v2`)
- 可匯入 CSV (從 CB 篩選結果)

---

## 9. 資料來源 + 標的池邏輯

### 9.1 前端三層載入 ([js/sheetsApi.js loadAll](../js/sheetsApi.js))

1. **靜態 JSON** (最優先): `data/all-data.json` (~14MB)
2. **統一 API** (次優先): GAS endpoint
3. **gviz** (fallback): 直接打 Google Sheets gviz API

### 9.2 `all-data.json` keys

```
cbDailyTrading       CB 自身 OHLCV
cbBondInstitutional  CB 自身三大法人
stockTrading         CB 對應股每日交易 (★ 白名單篩選)
cbInstitutional      CB 對應股三大法人 (★ 白名單篩選)
marginTrading        融資融券 (★ 白名單篩選)
cbDailyReport        CB 交易日報
fubonPrimary         富邦 CB 初級市場
yuantaPrimary        元大 CB 初級案件
stockNews            新聞
stockIndustry        台股公司主檔 (產業)
cbIssuance           CB 發行資訊
yuantaReport         元大選擇權 (basicInfo, 競拍, 流通餘額...)
stockStatus          VCP / 三線開花
cbasCalendar         CBAS 日曆 (events, issuedInfo, plannedPrimary, yuantaCrosscheck)
_meta                pipeline 時間戳
```

### 9.3 「標的池」(白名單) 來源 ([parse_and_export.py:361-380](../scripts/parse_and_export.py#L361-L380))

白名單 = 以下兩個來源聯集：

1. **既有 CB-linked**: `stockTrading` / `cbInstitutional` / `marginTrading` 已存在的 stock_id (歷史累積,一旦有 CB 就永久追蹤)
2. **即將發 CB**: cbCode 前 4 碼,來自：
   - 富邦 CB 初級市場 sheet
   - 元大 CB 初級案件 sheet
   - 統一 CBAS 已發行 + 預計發行 xlsx (events + issuedInfo)

新 CB 公司公告董事會 → 出現在 3 個源 → 自動進白名單。

### 9.4 白名單歷史軌跡 (Google Sheet)

每天 pipeline 跑完 (Phase 4.8) 會把當日白名單聯集寫入這份 sheet:
- URL: https://docs.google.com/spreadsheets/d/1Ia3noTeXnZFl2N6D-z5itUlqyAYHkYAtLl-ESFUn7bc/
- worksheet: `Stock`
- 欄位: `日期 | 標的數 | 完整清單`(逗號分隔)
- 同日重跑會 update,新一天會 append
- SA 必須先被加為「編輯者」才能寫
  → `stocks-backup@cb-analysis-494501.iam.gserviceaccount.com`
- 失敗 log warning 但不擋主流程
- 實作: [scripts/lib/whitelist_log.py](../scripts/lib/whitelist_log.py)

### 9.5 額外資料

- `data/twsa.json` — 競拍資料 (`scripts/twsa_scraper.py`)
- `data/etf-holdings.json` — ETF 持股 (`scripts/parse_etf.py`)
- `data/vcp.json` — VCP 選股 (`scripts/vcp_scanner.py`)
- Supabase — 公用追蹤清單 (`SUPABASE_URL` in config.js)

---

## 10. 後端 Pipeline / 腳本

### 10.1 主流程

| Script | 功能 |
|---|---|
| `scripts/fetch_stocks.py` | 每日抓 TWSE/TPEX raw CSV → Drive 備份 (6 來源 + CBAS xlsx) |
| `scripts/parse_and_export.py` | 主合併 pipeline (Phase 1-5),寫 `all-data.json` + Supabase |
| `scripts/parse_etf.py` | ETF 持股 |
| `scripts/vcp_scanner.py` | VCP 選股 |
| `scripts/twsa_scraper.py` | 競拍資料 |
| `scripts/build_universe.py` | 全市場標的清單 |

### 10.2 Backfill 工具

| Script | 用途 |
|---|---|
| `scripts/backfill_day.py` | 補抓特定股某日 (更新現有 cell,不新增 row) |
| `scripts/backfill_primary_market.py` | 補抓初級市場標的:沒列的整段 append;有列但「歷史幾乎全 0」的新進股(`forward_only_stocks`)自動就地 refill |
| `scripts/backfill_margin.py` | 融資融券歷史回填 |
| `scripts/backfill_source.py` | 補抓某天某來源 raw CSV |

### 10.3 GitHub Actions

| Workflow | 排程 |
|---|---|
| `fetch-stocks.yml` | 每日抓 raw |
| `parse-and-export.yml` | 每日合併 + 寫 JSON |
| `margin-late.yml` | 延遲抓融資融券 |

### 10.4 環境變數 (`scripts/.env`)

```
GOOGLE_CREDENTIALS={...JSON...}
DRIVE_FOLDERS={
  "STOCK_INST_TWSE": "...",
  "STOCK_INST_TPEX": "...",
  "STOCK_PRICE_TWSE": "...",
  "STOCK_PRICE_TPEX": "...",
  "CB_PRICE": "...",
  "CB_INST": "...",
  "MARGIN_TWSE": "...",
  "MARGIN_TPEX": "...",
  "CBAS_CALENDAR": "1qAauB30BsCZ2_dHMJ_3qlTfr5IhK0Q2s"
}
```

GitHub Actions 對應同名 Secret (改本機 .env 不會影響雲端,反之亦然)。

---

## 11. 本地開發

```powershell
# 啟動本地 server
.\dev.bat
# → 自動開瀏覽器到 http://localhost:8000
```

修改前端任何檔案後,瀏覽器按 `Ctrl+Shift+R` 強制清快取重整。

---

## 12. 重要設計決策 (踩過坑)

- **Service Account 無 Drive 儲存配額** → 可 update 既有檔,不能 create 新檔。CBAS xlsx 走「GAS 先建空殼 → SA 覆蓋」
- **TPEx SSL Subject Key Identifier 缺失** → 強制 `verify=False`
- **`scripts/.env` 多行 JSON dotenv 會截掉** → 手動 regex parse
- **TWSE 量太小那天會把 OHLC 標 `--`** → parser 視為 None,前端 fallback 用前一日 close 畫平頂蠟燭 (`buildOHLCVArray`)
- **CB 法人資料單位是「張」,不是「股」** → `renderCBTechInstChart` 不能除 1000
- **`timeseries_merge.py` 補抓日期會 append 到末尾** (非排序) → 前端 `parseTimeSeries` 回傳前 sort dates 修補
- **Chart.js v4「Canvas already in use」** → sub-charts 用 Map 管理,`_claimTechSubCanvas` helper 在 `new Chart()` 前 destroy 舊的

---

## 修改本檔的時機

加新功能 / 改變現有功能行為時,**順手** 更新對應段落。檔案位置:
`docs/FEATURES.md`
