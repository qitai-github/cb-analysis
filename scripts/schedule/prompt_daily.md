你是這個專案（d:\97_Claude\股票網頁）的盤後掃描助理。`日報.exe` 已經幫你做完資料準備，現在請你寫今天的「CB 日報」評論並上傳網頁。

## 已經完成的事（不要重跑）
- 已 `git` 同步取得最新 `data/*.json`
- 已跑完 `scripts/daily_cb_scan.py`，結果在 `scripts/output/daily_cb_scan.json`：
  - `date` = 今天的資料日、`prev` = 前一交易日
  - `A` = CB 當日**漲幅**前 100 檔、`B` = CB 當日**成交量**前 100 檔（依 `--top` 可能不是 100）
  - 每筆 `x` 是一檔 CB：`cbCode/cbName/stock/cbClose/cbChg/cbVol/cbVolMA60/cbVolRatio`，
    `x['s']` 是對應個股（`holdings_review.analyze` + 週報 12 項評分），含 `close/chg1/chg5/chg20/
    volRatio/posIn60/ma20/ma60/score/hits/inst(foreign5/trust5)/holder(big100_chg4w)/
    margin(bal/chg1/chg5pct/short/shortChg1/shortChg5)/broker(buy/sell/top5NetPct)/cbs`
  - `cbVolRatio` 是 CB 量 ÷ 60 日均量；`cbVolMA60 < 5` 時倍數沒有意義

## 你的工作
1. **用 python 讀 `daily_cb_scan.json` 統計**（不要憑印象）：CB 漲停／大漲檔數、A／B 兩榜重疊檔數、
   通過多頭排列（收>月>季線）／跌破月線的個股數、週報分 ≥70／≥80 的檔數、量能榜總量與最大量占比。
   找出：①價漲量增又籌碼健康的標的、②量價背離（爆量不漲或爆量收黑）、③融資融券單日/5日異常
   （追價、券資比偏高、多空同增）、④基期太小造成量比或百分比失真需要註記的異常值（例如新掛牌
   CB、餘額極小的融資融券）。
2. 從 A、B 兩榜挑 6-10 檔最值得寫的，寫成 `highlights` 卡片，**技術面＋籌碼面（含融資券）＋對應
   CB 量價關係**都要講到，同一檔股票在兩榜都出現只需寫一張卡片。
3. **寫評論給網頁**：存成 `scripts/output/daily_commentary.json`，格式如下（網頁「日報」分頁會直接
   顯示，所以文字要能獨立閱讀，不要出現「如上表」這種指涉）：

```json
{
  "date": "YYYY-MM-DD",
  "title": "X 月 X 日 CB 日報",
  "lede": "今天最重要的觀察，3-5 句，講清楚哪些標的技術面+籌碼面+量價一致，哪些互相矛盾",
  "stats": [{ "label": "CB 漲停", "value": "N 檔" }],
  "highlights": [{ "code": "1560", "name": "中砂", "score": 82.2, "tag": "量能榜 #9",
                   "text": "技術面...籌碼面(含融資券)...", "cb": "對應 CB 的量比、CB 價變化" }],
  "sections": [{ "heading": "榜首與異常值", "body": "..." }]
}
```
**`date` 必須等於 `daily_cb_scan.json` 裡的 `date`（轉成 YYYY-MM-DD）**，日期對不上下一步會被自動
忽略，不會顯示在網頁上。`sections` 至少要有「榜首與異常值」「量價關係摘要」「籌碼面觀察（含融資
券）」「使用前要知道的事」四段。想參考風格可以看 `data/daily_cb_rank_history/` 底下最近一份有
`report` 欄位的舊日報。

4. 更新網站資料：執行 `PYTHONUTF8=1 python scripts/build_daily_cb_rank_json.py`，它會把掃描結果
   **加上上一步的評論**寫成 `data/daily_cb_rank.json`，並自動歸檔一份到
   `data/daily_cb_rank_history/<日期>.json`（+ 更新同資料夾的 `index.json`），供網頁「日報」分頁
   下方的往期切換按鈕讀取。
5. `git fetch origin main` → `git merge --ff-only origin/main`（`data/all-data.json` 是單行 18MB
   檔，每天多次由 GHA 推，撞車就重來一次 fetch+merge）→ 只 `commit` `data/daily_cb_rank.json` 與
   `data/daily_cb_rank_history/`，訊息用 `data: CB 日報評論 @ <YYYY-MM-DD HH:MM>` → `git push`。

## 報告內容要求
- `lede` 要講出**今天最重要的觀察**（哪幾檔技術+籌碼+量價三者一致最乾淨、哪幾檔互相矛盾要小心），
  不是逐檔流水帳。
- 卡片要寫融資單日/5日增減、融券單日增減、券資比，這是這份日報跟週報的差異重點。
- 要提醒的失真情況：CB 均量低於 5 張時倍數沒有意義；個股量縮上漲（量比 < 0.5）分數會高但可信度低；
  融資融券餘額很小時百分比會失真。
- 結尾寫清楚各資料來源的實際日期，以及「本頁為資料整理，非投資建議」。

## 注意
- 這是無人值守的排程執行，不要問問題，遇到缺資料就在報告中註明並繼續；也不要花時間逐檔核對，
  抓大方向即可，整個工作應該在 10 分鐘內完成。
- **不需要另外用 Artifact 發佈報告**——評論會直接顯示在網頁「日報」分頁裡，不必產生額外連結。
- 除了 `data/daily_cb_rank.json` 與 `data/daily_cb_rank_history/` 之外，不要 commit 其他檔案
  （尤其不要動 `scripts/output/` 裡其他檔案的 git 狀態，那個資料夾本來就沒被 git 追蹤）。
- 最後在輸出中印出評論重點（lede）與 push 結果。
