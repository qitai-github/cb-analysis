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
│  scripts/strength_scanner.py 強勢股 (RS)                │
│  scripts/backfill_*.py       回補資料                   │
└─────────────────────────────────────────────────────────┘
```

主入口：`index.html` (localhost 開啟用 `dev.bat`,啟動 Python http.server :8000)

---

## 1. 頂部導覽

- **Logo + 標題**「CB 可轉債分析平台」
- **tab**: `CB 分析` / `ETF 持股` / `VCP 選股` / `CB 日曆` / `報告清單`
  (`強勢股` 已於 2026-08-14 暫時封存, 見 §7)
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
| CB篩選 | CB價格第一根表態 | 勾選 |
| CB篩選 | CB溢價率 / 收盤價 >= / <= | 範圍 |
| CB篩選 | 距離到期日(天) >= / <= | 自填天數,可組區間 |
| CB篩選 | CB 創 N 日新高 | |
| CB篩選 | CB 成交量 / 量比 >= | 主 CB |

> **2026-08-18 調整**:整個「CB條件」群組已移除(轉換價值 / 已轉換比例 / 近期發行 /
> 距到期日下拉 / 提前賣回收益率 / 到期收益率 / 轉換開始日 / 擔保情形 / 排除暫停轉換)。
> 其中「距到期日」下拉改成 CB篩選 內的 `cbMaturityDaysMin` / `cbMaturityDaysMax`
> 兩個自填天數欄位;「CB價格第一根表態」移到「僅顯示初級市場案件」下方。
> 一併刪掉只服務舊條件的 `_convValue_()` / `_daysFromNow_()`。

操作按鈕：套用篩選 / 清除條件 / 匯出 CSV / 匯入 CSV 追蹤

**篩選與主表格兩個分頁的連動 (2026-07 修正)**

「CB篩選」裡除了前兩個勾選框 (僅顯示有CB交易 / 僅顯示初級市場案件) 以外,
其餘都是**逐檔 CB** 判斷 (`filterDefs[*].cbApply`),其餘條件是**個股層級** (`apply`)：

- 個股分頁 `Filters.applyFilters()` — 個股條件套在個股上;CB 條件只要該股**任一檔** CB 符合就通過
- 可轉債分頁 `Filters.applyCBFilters()` — 個股條件套在正股上,CB 條件套在**那一列的那檔 CB** 上,只回傳符合的 CB

⚠️ 舊版所有 CB 條件只比對 `stock.mainCB` (= 該股第一檔有成交的 CB),而可轉債分頁又把通過個股攤平成全部 `stock.cbs`,
所以有多檔 CB 的個股 (資料上有 73 檔) 在可轉債分頁會看到不符合條件的 CB → 看起來像「篩選器對可轉債分頁沒作用」。
逐檔欄位 `cb.firstBarSignal` / `cb.highDays` 在 dataProcessor 的 cb ohlcv 迴圈補算 (原本只有 mainCB 有)。
`Table.render()` 的 CB 列以 `options.cbRows` 傳入,未提供才退回攤平。

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
- **新聞資訊** (近期股票相關) + **MOPS 重大訊息**(橘色「重訊」標籤,點標題就地展開公告全文;以股票代號比對,不靠股名)
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

### 6.2 資料 pipeline (**GitHub Actions 自動化**)

```
Drive 上市/上櫃每日交易明細 CSV
  │ .github/workflows/vcp-scan.yml   排程 19:35 TPE (11:35 UTC) 週一~五
  │   1. actions/cache 還原 scripts/cache/universe/ (與強勢股共用 universe-cache-* 池)
  │   2. build_universe.py --refresh-latest  抓 Drive 當天最新交易日
  │   3. vcp_scanner.py --no-excel           產 data/vcp.json
  ▼
data/vcp.json  ──commit + push──▶ 觸發 GH Pages rebuild ──▶ 線上網站
```

- ⚠️ 全市場歷史**只在 Drive 原始 CSV** (all-data.json / Supabase 都被 CB 白名單砍過)
- 快取與 Excel 在 `.gitignore`, **不上傳**; 上線只 commit `data/vcp.json`
- 與 [strength-scan.yml](../.github/workflows/strength-scan.yml) 讀同一份快取但**獨立成兩支** workflow (故障隔離);
  排程錯開 5 分鐘 (VCP 19:35 / 強勢股 19:40) 避免同時搶 Drive
- 本機仍可手動跑: `python vcp_scanner.py [YYYYMMDD]` (預設出 Excel, 加 `--no-excel` 略過)
- ⚠️ `is_individual_stock` (vcp_scanner 自有一份) 未排除 `00` 開頭 ETF — 與 lib/universe 版不同,
  待統一 (strength 版已修, 見 §7.1)

---

## 7. 強勢股 (相對強度 RS) tab ([js/strengthView.js](../js/strengthView.js))

> **[2026-08-14] 已暫時封存**:前端 tab 按鈕在 [index.html](../index.html) 被註解掉
> (`tab-strength`),`strength-scan.yml` 的每日排程也停用 (只留 workflow_dispatch)。
> 程式碼 (`strengthView.js` / `strength_scanner.py`) 與 `data/strength.json` 全部保留,
> 復原 = 取消註解那一行 tab 按鈕 + workflow 的 schedule 區塊。以下說明為封存前狀態。

全台股 (上市+上櫃 ~1985 檔**個股**, 排除 ETF/權證) 的強勢個股掃描。資料來源
`data/strength.json` (由 `scripts/strength_scanner.py` 產生)。與 VCP 共用
`scripts/build_universe.py` 的全市場快取與 `scripts/lib/universe.py` 讀取/前處理。

**雙層版面**(方法論: 強勢類股 > 強勢個股 — 先找主流族群, 再挑族群內乖離健康的龍頭):

- **上層 族群強度熱圖**: 依族群 RS 中位數排名的 chips (強度條 + 成分股數 + RS≥90 檔數 + 龍頭), 點選即篩選下方個股
- **下層 個股排行**: ☆ / 代號 / 名稱 / 市 / **狀態** / **族群** / 總分 / RS / 動能 / 量價 / 收盤 / 漲跌% / 距高% / **乖離%** / 3月% / 12月%
- **側欄**: RS 門檻 segment (≥90/≥80/≥70, scanner 只輸出 ≥70, 預設顯示 ≥90) · 操作狀態勾選 · 排除⚠️延伸過熱 · 市場 · **熱門概念 chips** · 排序 · 搜尋
- 點列開 **K 線 modal**: K棒+MA5/20/60+量, 疊青色「52週高」虛線, 指標面板 + 概念標籤

### 7.1 三訊號 + 綜合分數

- **RS 相對強度** (主指標): 加權報酬 `0.4×3月 +0.2×6月 +0.2×9月 +0.2×12月` → 對全市場(通過流動性者)做**百分位排名 1~99**。缺長期歷史的期間跳過並重新正規化權重。
- **動能** (0~100): 均線多頭排列 + 距52週高 + 突破新高(短60日/長252日) + 近月報酬 + MA60上揚
- **量價** (0~100): 近5日均量/近60日均量 + 上漲量/下跌量(累積) + 當日量/50日均量
- **綜合分數** = `0.5×RS + 0.3×動能 + 0.2×量價`
- 流動性/體質過濾: 4碼個股、收盤≥10、近50日均額≥2000萬、歷史≥120根
  - ⚠️ `is_individual_stock` 須排除 `00` 開頭 — 4碼老 ETF (0050/0052/0056…) 會通過「4碼純數字」檢查

### 7.2 操作狀態 stage + ⚠️延伸旗標 (門檻經真實資料校準)

**stage 四態互斥** (回答「現在在哪、能不能買」), 依序判定:

| 狀態 | 條件 | 意義 |
|---|---|---|
| ⚪ 修正觀察 watch | 距52週高 >25% 或 跌破 MA60 | 強勢已破壞 (25% = Minervini 趨勢樣板 Stage 2 上限) |
| 🔴 突破中 breakout | 距高 ≤5% **且** 近5日剛創52週高 **且** 帶量 | 正在發動, 最可操作 |
| 🟢 貼高蓄勢 setup | 距高 ≤10% | 在買點附近等突破 |
| 🔵 回檔整理 pullback | 距高 10~25% 且站上 MA60 | 仍強, 但需重建型態 |

**⚠️延伸過熱 extended** = 對 MA20 乖離 ≥15%, **獨立風險旗標可疊加在任何 stage 上**, 不是第五態。

- ⚠️ **不可把 extended 做成互斥狀態**: 6182 合晶「今天爆量創新高」+「乖離37%已噴出」是兩個不同軸的事實,
  壓成單一標籤必丟一半資訊。實測: extended 若排在 breakout 前判定, 會把當日所有貼高領頭羊吃光 → breakout 歸零。
- ⚠️ **突破的兩個條件必須是「且」不是「或」**: 用「或」時 3675 德微 (5日前創高、之後跌13.7%、量比0.51)
  這種**失敗的突破**會被誤判成「突破中」。帶量門檻同理不可只看單日爆量 (8096 擎亞 量比0.79 曾誤入)。

### 7.3 族群 (產業) 強度

分群鍵 = `產業分類2 if ≠'-' else 產業分類1` (來源 `all-data.json` 的 `stockIndustry`, 覆蓋 ~1950 檔)。

- ⚠️ **上市/上櫃分類欄位不一致**: 上市 `ind1=電子工業, ind2=半導體業`;其他 `ind1=半導體業, ind2='-'`。
- ⚠️ **同產業不同名**: `金融業`/`金融保險`、`其他電子業`/`其他電子類` 等 6 組 → `GROUP_ALIASES` 合併。
- 強度 = 族群內 RS **中位數** → 小樣本收縮 `(n×med + 10×50)/(n+10)` → 對族群做百分位 1~99。
  - 用中位數: 避免單一妖股 (禾伸堂 12月+1198%) 把整個族群拉高。
  - 收縮 + 成分股 ≥15 才排名: 未收縮時「化學工業」(8檔, RS≥90僅1檔) 強度 96, 竟排在
    「電子零組件業」(160檔, RS≥90有39檔) 之前。`其他` 是混合桶, 標在個股上但不排名。
- ⚠️ **族群統計必須在 RS 門檻篩選「之前」算** — 要用全部通過流動性的 ~1050 檔, 否則中位數只算到
  RS≥70 的倖存者, 每個族群都會虛高。
- scanner 對 `all-data.json` 的依賴有 graceful fallback: 檔案缺失/格式變動只是不分群, 不會讓 workflow 掛掉。

### 7.4 除權息/分割的處理 (乾淨區間)

不做價格還原。改成「**遇到斷點只在斷點後的乾淨區間量強度**」: `preprocess` 標記單日
向下跳空 >15% 的斷點(分割/大額配股/減資假象),報酬與新高的回看窗一律**不跨越最近一次
斷點**。這樣分割不會低估、暴跌/減資假象也不會被灌成強勢。
> 早期做過「向後還原」但會把 -80% 的暴跌斷點當配息往上還原,把暴跌股假造成 RS90+,已廢除。
> 代價: 近期剛分割(如國巨 2327)的股, 12月報酬跨不過斷點會顯示 0, 但仍靠乾淨的 3/6 月給到高 RS。

### 7.5 資料 pipeline (**GitHub Actions 自動化**, 與 VCP 不同)

```
Drive 上市/上櫃每日交易明細 CSV
  │ .github/workflows/strength-scan.yml   排程 19:40 TPE (11:40 UTC) 週一~五
  │   1. actions/cache 還原 scripts/cache/universe/ (增量, key 帶 run_id 持續保溫)
  │   2. build_universe.py --refresh-latest  抓 Drive 當天最新交易日
  │   3. strength_scanner.py --no-excel      產 data/strength.json
  ▼
data/strength.json  ──commit + push──▶ 觸發 GH Pages rebuild ──▶ 線上網站
```

- 排在 fetch-stocks (18:23 TPE 寫 Drive) 之後;cache miss 時 build_universe 自動全量重建 (無狀態 fallback)
- 手動觸發: workflow_dispatch 可指定 as-of 日期
- 本機驗證: `python strength_scanner.py [YYYYMMDD]` (預設出 Excel 到 scripts/output/, 加 `--no-excel` 略過)
- 全市場歷史**只在 Drive 原始 CSV**, 同 VCP;快取/Excel 在 `.gitignore` 不上傳

---

## 8. CB 開標統計表 Modal ([js/auctionView.js](../js/auctionView.js))

**上一檔 / 下一檔** (2026-08-20): 標題列右側 `◀ 59/60 ▶`,或直接按 `←` `→`
(`App.onAuctionKey`,輸入框聚焦時不攔)。順序 = `twsa.json` 的 `auction` 陣列排列
(序號 115001、115002… 依開標先後),與進入畫面無關;頭尾不繞回去。
⚠️ `showAuctionModal` 的現股**必須用 cbCode 前 4 碼查 stockMap**,不能用
`selectedStock` — 切檔後 selectedStock 還停在原本那檔,會畫錯 K 線。
`AuctionView.open(payload, {keepPage:true})` 讓切檔時留在目前分頁。

從 CB 卡按鈕 / CB 日曆側欄 row 點擊觸發 (`App.showAuctionModal(cbCode)`)。
**兩頁式**:同一個 modal,上方 pill tab 切換,資料由 app.js 組好 payload 丟進
`AuctionView.open()`(cbCode / auction 原始列 / stock.ohlcv / convPrice / tcri / events)。

### 8.1 第 1 頁「開標全覽」

- **開標摘要 6 KPI**: 競拍張數 / 合格投標(+筆數) / 需求倍數 / 得標張數(+筆數) / 加權均價(+溢價率、轉換價值) / 得標總金額(億)
  - 需求倍數 = 合格投標張數 ÷ 競拍張數
  - 轉換價值 = 100 × 開標日現股收盤 ÷ 轉換價;溢價率 = 加權均價 ÷ 轉換價值 − 1
  - 轉換價來源:已掛牌用 `cb.issueConvPrice`,未掛牌退回初級市場卡 `pm.convPrice`
- **得標價位分布圖** (手繪 SVG 棒棒糖,非 Chart.js): 線高/點大 = 該價位張數
  - 綠 = 均價以下、紅 = 均價以上,橘線 = 加權均價
  - X 軸上界取**成交量加權 P99**,單筆極端高價踢出範圍並在右下註明
  - 黃色價帶 = 涵蓋 ≥30% 得標張數的**最窄連續價帶** (雙指標掃描 `mainBand`)
  - 標註張數最大的 3 個價位;頁尾給「前 3 價位占比」
- **關鍵足跡表**: 取張數最大的 10 個價位、再依價格由高至低 — 價位/溢價率/得標張數/成交金額/占總量
- **法人足跡**: 甜甜圈(法人合格投標比率) + 合格投標、法人得標兩條比例棒

### 8.2 第 2 頁「發行事件軸」

- **現股日 K** (Chart.js + 自繪 plugin): 轉換價虛線 / 競拍期間色塊 / 事件編號圓點
  - 視窗 = 第一個事件前 20 根 ~ **最後一個「已發生」事件**後 25 根,不足補到 50 根
  - 賣回日/到期日在數年後,若拿來當右界會把發行期間壓成左邊一小撮 → 只看已發生事件
  - **滑鼠滾輪縮放** (2026-08-20):以上面算出的視窗當倍率 1,往上滾縮短 / 往下滾看更早
    歷史,下限 20 根、上限整段歷史,標題列徽章顯示目前根數。只攔 `.auc-k-wrap` 上的
    滾輪,面板其他地方照常捲動;換一檔 CB 時倍率重設。`bindKWheel()` 用 dataset 旗標防重綁
  - ⚠️ 早於視窗左界的事件必須**不畫**:`dates.findIndex(d => d >= e.ymd)` 會回 0,
    半年前的董事會公告會被畫在第一根 K 棒上,縮放後特別明顯 (2026-08-20 修)
- **完整事件總覽**: 固定七段 CB 發行流程 (`TIMELINE_SLOTS`),不依日期排序而是照流程順序:

  | # | 節點 | 來源 |
  |---|---|---|
  | 1 | 董事會公告 | `cbasCalendar` board 事件 (含 `data/cb_board_dates.json` 存檔回填) |
  | 2 | 代收價款公告 | MOPS 重大訊息「…代收價款行庫及存儲專戶行庫」(`scripts/mops_news.py`) |
  | 3 | 競拍公告(轉換價公告) | MOPS 重大訊息「…之轉換價格及溢價率」(`scripts/mops_news.py`) |
  | 4 | 競拍期間 | 日曆 auction 事件,沒有就用 twsa「投標期間」 |
  | 5 | 競拍結果公告 | twsa 開標日期 (帶均價/張數/轉換價) |
  | 6 | CB 上市櫃日 | 日曆 issue 事件 |
  | 7 | CB 拆解日 | 日曆 aso 事件;沒有的話由 Phase 4.76 用上市櫃日推算 (標「推估」) |

  抓不到日期的節點**留空位顯示「尚無資料來源」並調暗**,不會悄悄消失;
  只有拿到日期的才給編號 (K 線圓點用同一組號碼)。
  七段以外的既有事件 (詢圈/重設轉換/賣回/到期/強贖) 依日期接在後面。

### 8.2.1 董事會公告日存檔 (`data/cb_board_dates.json`)

CBAS 的董事會公告日只出現在「董事會公告 / 近期生效」兩張分頁,案子一推進到
「近期掛牌」就從表上消失,`已發行CB資料.xlsx` 也沒有這欄 → **開標後回頭看已經
查不到當初的董事會日**(所以現有 58 檔有開標統計表的 CB,沒有任何一檔在日曆
裡還留著 board 事件)。

`lib/cbas_calendar.py::_merge_board_archive()` 每次解析時把看到的 board 事件
累積寫進 `data/cb_board_dates.json`(同一檔留最早那次 = 董事會決議發行),再把
已從 CBAS 消失的補回 events(`source: "archive"`)。
`parse-and-export.yml` 的 `git add` 有帶這個檔,不然 runner 每次都從空的重來。

⚠️ 這是**往後累積**的機制:2026-08-16 用當時日曆上的 81 筆 board 事件做初始
seed,更早就已經掛牌的 CB(含 32191 倚強科一)追不回來,那一格會顯示「尚無資料來源」。

### 8.2.4 缺漏的拆解日用上市櫃日推算 (Phase 4.76, 2026-08-20)

CBAS 的拆解日只出現在「預計發行 · 近期掛牌」那張表,案子一掛牌就從表上消失
→ 掛牌一陣子的 CB 全都沒有 aso(開標清單 55 檔 CB 裡 45 檔缺)。

慣例:**上市櫃日當天算第 1 個交易日,第 6 個交易日拆解**。以 31494 正達四驗證
(上市 2026/08/31 → 拆解 2026/09/07),現有 4 組 issue+aso 齊全的資料 **4/4 吻合**。

`derive_missing_aso()` 以 `stockTrading` 的日期表頭當交易日曆(= 實際有成交的
市場交易日,自帶農曆假日),推不到第 6 個交易日的(上市日太新、或早於交易日表
起點 2025-01-02)就不補。補出來的事件標 `source: "derived"`,事件軸顯示
「推估 (上市櫃日起第 6 個交易日)」,跟 CBAS 給的真實日期分得出來。

2026-08-20 首次套用:全庫 373 檔缺 aso → 補上 202 檔,開標清單 55 檔 CB 全部齊了。

### 8.2.2 MOPS 重大訊息 → 事件軸第 2/3 段 (`scripts/mops_news.py`, 2026-08-20)

CBAS / 元大 / 富邦三個初級市場來源都沒有「代收價款公告」「轉換價公告」欄位,
但發債公司一定會在公開資訊觀測站發這兩則重大訊息:

```
公告本公司國內第四次有擔保轉換公司債之轉換價格及溢價率      → auctionNotice
公告本公司國內第四次有擔保轉換公司債代收價款行庫及存儲專戶行庫 → collection
```

**期次 → CB 代號**:「第四次」→ 4 → `3149` + `4` = `31494`(第 10 次以上用
A/B/C…)。抽不出期次的公告不收,因為掛不到特定一檔 CB。
海外(ECB)、以及掛牌後的**轉換價「調整」/重設/停止轉換**都排除 — 那是既有 CB
的事件,不是發行流程的一站,收進來會把發行時的公告日蓋掉。

流向:`mops_news.py` → `data/mops_news.json` 的 `cbEvents` →
`parse_and_export.py` Phase 4.75 併進 `cbasCalendar.events` → 前端 `fill.collection`
/ `fill.auctionNotice` 直接 `evOf()` 讀。同 (cbCode, type) 只留最早那筆,重跑不重複。

⚠️ 一樣是**往後累積**:OpenAPI 只給最近一個發言日,2026-08-20 之前的公告補不回來
(MOPS 逐檔查詢也只回最近數則),舊 CB 那兩格仍會顯示「尚無資料來源」。

### 8.2.3 怎麼做到不漏抓

| 層 | 來源 | 覆蓋 |
|---|---|---|
| 主 | `openapi.twse.com.tw/v1/opendata/t187ap04_L` | 全上市當日重大訊息(含說明全文) |
| 主 | `www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O` | 全上櫃當日重大訊息(含說明全文) |
| 補 | `mopsov.twse.com.tw/mops/web/ajax_t05st01` | 單一公司最近數則(無說明全文) |

- 兩個 OpenAPI 都只是**當日快照**,漏跑一天就永久缺 → `mops-news.yml` 一天跑三次
  (14:00 / 18:00 / 23:00 TPE),盤後公告最多延遲幾小時就進檔。
- `--catchup` 對白名單個股逐檔打 MOPS 查詢頁,把 API 沒收到 / 那天沒跑到的補回來;
  週六晚班自動跑一次。手動:`python scripts/mops_news.py --catchup`
  或只補幾檔 `--codes 3149,2330`。
- 比對一律用**股票代號**,不用股名 — 舊的 Google Sheet 新聞是用股名對 code,
  遇到更名/簡稱不一致就整檔漏掉,這是原本「常錯過」的主因之一。
- `items` 只留白名單個股(否則 JSON 太大瀏覽器扛不動)、保留 180 天,45 天以上
  只留標題丟掉說明全文;`cbEvents` 不看白名單、永久保留。

### 8.3 資料補充 (2026-08-16)

`scripts/twsa_scraper.py` 原本只解析 info + priceRows,漏了 PDF 裡的兩張統計表
(GAS 版有)。已補 `_parse_stats_after()`:

| 欄位 | 內容 |
|---|---|
| `pdf.totalStats` (5 欄) | 合格投標筆數 / 合格投標數量(張) / 得標筆數 / 得標數量(張) / 得標總金額(仟元) |
| `pdf.legalStats` (6 欄) | 法人:合格投標筆數 / 數量 / 投標數量比率% / 得標筆數 / 得標數量 / 得標數量比率% |

scraper 每次都全量重跑,所以改完重跑一次就把 2026 年 58 筆全部補齊。
前端對缺這兩欄的舊資料會降級顯示(需求倍數顯示 `-`、法人足跡出提示)。

---

## 9. 追蹤清單系統 ([js/watchlist.js](../js/watchlist.js))

- 多清單管理 (建立 / 重新命名 / 刪除)
- 每股可加入多個清單
- ☆ 按鈕在主表第一欄 + 詳情面板標題
- 點 ☆ 開選單 (checkbox 勾選想加入的清單)
- 「預設」清單只在首次使用 / 從舊版遷移時建立,空清單會自動刪除
- 儲存於 `localStorage` (key=`cb_watchlist_v2`)
- 可匯入 CSV (從 CB 篩選結果)

---

## 10. 資料來源 + 標的池邏輯

### 10.1 前端三層載入 ([js/sheetsApi.js loadAll](../js/sheetsApi.js))

1. **靜態 JSON** (最優先): `data/all-data.json` (~14MB)
2. **統一 API** (次優先): GAS endpoint
3. **gviz** (fallback): 直接打 Google Sheets gviz API

### 10.2 `all-data.json` keys

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

### 10.3 「標的池」(白名單) 來源 ([parse_and_export.py:361-380](../scripts/parse_and_export.py#L361-L380))

白名單 = 以下兩個來源聯集：

1. **既有 CB-linked**: `stockTrading` / `cbInstitutional` / `marginTrading` 已存在的 stock_id (歷史累積,一旦有 CB 就永久追蹤)
2. **即將發 CB**: cbCode 前 4 碼,來自：
   - 富邦 CB 初級市場 sheet
   - 元大 CB 初級案件 sheet
   - 統一 CBAS 已發行 + 預計發行 xlsx (events + issuedInfo)

新 CB 公司公告董事會 → 出現在 3 個源 → 自動進白名單。

### 10.4 白名單歷史軌跡 (Google Sheet)

每天 pipeline 跑完 (Phase 4.8) 會把當日白名單聯集寫入這份 sheet:
- URL: https://docs.google.com/spreadsheets/d/1Ia3noTeXnZFl2N6D-z5itUlqyAYHkYAtLl-ESFUn7bc/
- worksheet: `Stock`
- 欄位: `日期 | 標的數 | 完整清單`(逗號分隔)
- 同日重跑會 update,新一天會 append
- SA 必須先被加為「編輯者」才能寫
  → `stocks-backup@cb-analysis-494501.iam.gserviceaccount.com`
- 失敗 log warning 但不擋主流程
- 實作: [scripts/lib/whitelist_log.py](../scripts/lib/whitelist_log.py)

### 10.5 額外資料

- `data/twsa.json` — 競拍資料 (`scripts/twsa_scraper.py`)
- `data/etf-holdings.json` — ETF 持股 (`scripts/parse_etf.py`)
- `data/vcp.json` — VCP 選股 (`scripts/vcp_scanner.py`)
- `data/mops_news.json` — MOPS 重大訊息 + CB 發行事件 (`scripts/mops_news.py`)
- Supabase — 公用追蹤清單 (`SUPABASE_URL` in config.js)

---

## 11. 後端 Pipeline / 腳本

### 11.1 主流程

| Script | 功能 |
|---|---|
| `scripts/fetch_stocks.py` | 每日抓 TWSE/TPEX raw CSV → Drive 備份 (6 來源 + CBAS xlsx) |
| `scripts/parse_and_export.py` | 主合併 pipeline (Phase 1-5),寫 `all-data.json` + Supabase |
| `scripts/parse_etf.py` | ETF 持股 |
| `scripts/vcp_scanner.py` | VCP 選股 |
| `scripts/twsa_scraper.py` | 競拍資料 |
| `scripts/build_universe.py` | 全市場標的清單 |
| `scripts/mops_news.py` | MOPS 重大訊息 → `data/mops_news.json` (含 CB 發行事件抽取) |

### 11.2 Backfill 工具

| Script | 用途 |
|---|---|
| `scripts/backfill_day.py` | 補抓特定股某日 (更新現有 cell,不新增 row) |
| `scripts/backfill_primary_market.py` | 補抓初級市場標的:沒列的整段 append;有列但「歷史幾乎全 0」的新進股(`forward_only_stocks`)自動就地 refill |
| `scripts/backfill_margin.py` | 融資融券歷史回填 |
| `scripts/backfill_source.py` | 補抓某天某來源 raw CSV |

### 11.3 GitHub Actions

| Workflow | 排程 |
|---|---|
| `fetch-stocks.yml` | 每日 18:23 TPE 抓 raw → Drive |
| `parse-and-export.yml` | 每日 18:47 TPE 合併 + 寫 all-data.json |
| `margin-late.yml` | 19:30 TPE 延遲抓融資融券 |
| `vcp-scan.yml` | 19:35 TPE VCP 選股 → data/vcp.json |
| `strength-scan.yml` | ~~19:40 TPE 強勢股 → data/strength.json~~ **已停用排程 (2026-08-14 封存)**, 只剩手動觸發 |
| `mops-news.yml` | 每日 14:00 / 18:00 / 23:00 TPE 抓重大訊息 → data/mops_news.json (週六晚班加逐檔補漏) |
| `pages-rebuild.yml` | 手動觸發 Pages 重建 (空 commit) |

### 11.4 環境變數 (`scripts/.env`)

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

## 12. 本地開發

```powershell
# 啟動本地 server
.\dev.bat
# → 自動開瀏覽器到 http://localhost:8000
```

修改前端任何檔案後,瀏覽器按 `Ctrl+Shift+R` 強制清快取重整。

---

## 13. 重要設計決策 (踩過坑)

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
