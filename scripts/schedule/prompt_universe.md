你是這個專案（d:\97_Claude\股票網頁）的盤後掃描助理。排程已經幫你做完資料準備，現在請你完成「正向訊號榜」週報並發佈。

## 已經完成的事（不要重跑）
- 已 `git pull` 取得最新 `data/*.json`
- 已跑完 `scripts/positive_scan.py`，結果在 `scripts/output/positive_scan.json`
- 已存今日快照 `scripts/output/positive_scan_<YYYYMMDD>.json`，並登記進 `scripts/output/weekly_snapshots.txt`（週報快照帳本——對照基準永遠是帳本裡上一筆，不是檔案系統上最新的快照，避免被中途的臨時掃描污染）
- 已跑完 `scripts/build_positive_report.py`，表格片段在 `scripts/output/_tables.html`（含 `<!--A-->` `<!--B-->` `<!--C-->` 三段）
- 上一份週報快照的檔名寫在 `scripts/output/universe_prev_snapshot.txt`（可能是空的，代表沒有前次可比）

## 你的工作
1. 讀今日 `positive_scan.json` 與上一份快照，做**逐檔追蹤**：升級／降級／新進 70 分以上／掉出榜單的名單與分數變化。用 python 算，不要憑印象。
2. 產「新進 70 分以上」的表格片段（作法參考 `scripts/build_positive_report.py` 裡的 `row()` 與 `HEAD`），以及追蹤表格。
3. 以 `scripts/templates/universe_report_example.html` 為版型（CSS 直接沿用，**不要改動 CSS**）寫今天的報告，用佔位符插入表格。
4. 用 Artifact 發佈，`favicon` 用 🎯，`title` 用「正向訊號榜 <MMDD>」。
   **這份報告不可以用任何個股名稱命名**（不要叫「XX 型態榜」），一律用中性的「正向訊號榜」。
5. **寫評論給網頁**：把報告的文字內容另存成 `scripts/output/signal_commentary.json`，格式如下（網頁「週報」分頁會直接顯示，所以文字要能獨立閱讀，不要出現「如上表」這種指涉）：

```json
{
  "date": "YYYY-MM-DD",
  "title": "X 月 X 日正向訊號榜",
  "artifactUrl": "剛才發佈的 Artifact 網址",
  "lede": "這次最重要的變化，2-4 句",
  "stats": [{ "label": "80 分以上", "value": "N 檔", "note": "與上次比較" }],
  "highlights": [{ "code": "2455", "name": "全新", "score": 85.0, "tag": "新進 · 第一名",
                   "text": "命中/未命中哪幾項、籌碼細節", "cb": "對應 CB 的量比與 CB 價" }],
  "sections": [{ "heading": "上次名單追蹤", "body": "升降級與出局原因" }]
}
```
`highlights` 放 80 分以上的每一檔；`sections` 至少要有「上次名單追蹤」「新進名單」「要小心的型態」「評分方法」「使用前要知道的事」五段。

6. 更新網站資料：執行 `PYTHONUTF8=1 python scripts/build_signal_rank_json.py`，它會把掃描結果**加上上一步的評論**寫成 `data/signal_rank.json`，供網頁的「週報」分頁讀取。接著：
   - `git pull --rebase` （`data/all-data.json` 是單行 18MB 檔，每日 GHA 會推，先 pull 才不會衝突）
   - 只 commit `data/signal_rank.json`，訊息用 `data: 正向訊號榜 @ <YYYY-MM-DD HH:MM>`
   - `git push`

## 報告內容要求
- 開頭 lede 要講出**這次最重要的變化**（誰上來、誰掉下去），不是流水帳。
- 三級（80+／70-79／60-69）各自的檔數，以及與上次的增減。
- 80 分以上逐檔寫卡片：命中哪幾項、缺哪幾項、對應 CB 的量比與 CB 價變化。
- 追蹤區塊要說明掉分／出局的**原因**（是跌破月線被門檻擋掉，還是籌碼真的變壞）。
- 要提醒的失真情況：CB 均量低於 5 張時倍數沒有意義；個股量縮上漲（量比 < 0.5）分數會高但可信度低。
- 結尾寫清楚各資料來源的實際日期，以及「本頁為資料整理，非投資建議」。

## 注意
- 這是無人值守的排程執行，不要問問題，遇到缺資料就在報告中註明並繼續。
- 除了 `data/signal_rank.json` 之外，不要 commit 其他檔案。
- 最後在輸出中印出 Artifact 網址與 push 結果。
