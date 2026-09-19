#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重新產生「券商進出」要追蹤的標的清單(CB 連結標的),並產出上櫃用的瀏覽器主控台腳本。

來源: 網頁個股清單 (scripts/web_stock_list.js,與前端一致;失敗退回 all-data.json 的 cbIssuance),用 scripts/cache/universe/
最新一份快照判斷市場別(TWSE=上市 / TPEX=上櫃)。

輸出:
  scripts/cache/broker_targets.json          {"date":..., "twse":[...], "tpex":[...], "unknown":[...]}
  scripts/broker_scan_tpex_console.js         給人工在 TPEx 頁面按 F12 貼上執行用,內嵌 tpex 清單

用法: PYTHONUTF8=1 python gen_broker_targets.py
CB 連結標的清單不常變動(新 CB 發行才會變),建議每週或每次跑上櫃抓取前重跑一次即可。
"""
from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_DIR = SCRIPTS_DIR.parent
TAIPEI = timezone(timedelta(hours=8))

JS_TEMPLATE = r"""// ============================================================
// TPEx(上櫃)券商買賣日報表 — 瀏覽器主控台自動查詢腳本
// 由 scripts/gen_broker_targets.py 產生,勿手動改股票清單(改股票清單請重跑產生器)
// 產生時間: {GEN_TIME}
//
// 使用方式:
//   1. 用你平常的 Chrome(不要用無痕、不要關掉擴充功能)開:
//        https://www.tpex.org.tw/zh-tw/mainboard/trading/info/brokerBS.html
//   2. 頁面上方會有一個「我不是機器人」小方塊(Cloudflare),等它變成綠勾勾
//      (通常幾秒內自動過,若跳出圖案驗證就照做一次)。
//      畫面上方出現紅色「驗證失敗」就重新整理頁面再等一次。
//   3. 按 F12 打開開發人員工具,切到 Console(主控台)分頁。
//   4. 把這個檔案整份內容貼進去,按 Enter 執行。
//   5. 看到「開始查詢 N 檔...」代表開始跑了,會自動一檔一檔查、不用再手動點。
//      跑完(約幾分鐘,依檔數而定)瀏覽器會自動跳出下載一個 .json 檔。
//   6. 把下載的 .json 檔放到專案的
//        scripts/output/broker_tpex_raw/ 資料夾,
//      然後跑:
//        PYTHONUTF8=1 python broker_ingest_tpex.py <下載的檔名>.json
//      它會轉成 CSV 存到「上櫃券商進出」資料夾。
//
// 如果中途畫面又跳出「驗證失敗」,腳本會在 console 印出來、自動暫停,
// 你人工重新整理頁面驗證過後,再貼一次本腳本重跑(已查到的股票下次會跳過)。
// ============================================================
(async function () {{
  const CODES = {CODES_JSON};

  if (typeof jQuery === 'undefined') {{
    console.error('找不到 jQuery,請確認你是在 brokerBS.html 頁面上執行本腳本。');
    return;
  }}

  // 監聽真正的查詢 API 呼叫,把每一檔的原始回應存下來(不依賴畫面上的表格結構)
  const captured = Object.assign({{}}, window.__PRELOADED || {{}});
  const origPost = jQuery.post.bind(jQuery);
  jQuery.post = function (url, data, cb, type) {{
    return origPost(url, data, function (resp) {{
      const code = data && data.code;
      if (code) captured[code] = resp;
      if (cb) cb(resp);
    }}, type);
  }};

  function setCode(code) {{
    const $input = jQuery('input[name="code"]');
    const el = $input[0];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, code);
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  }}

  function sleep(ms) {{ return new Promise((r) => setTimeout(r, ms)); }}

  // 等 Cloudflare 驗證權杖重新產生(每查完一檔,頁面會自動重置驗證,約需數秒)
  async function waitToken(maxMs) {{
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {{
      const v = jQuery('input[name="cf-turnstile-response"]').val();
      if (v) return true;
      await sleep(300);
    }}
    return false;
  }}

  let done = 0, skipped = 0, stopped = false;
  console.log(`開始查詢 ${{CODES.length}} 檔...`);
  for (const code of CODES) {{
    if (captured[code] && captured[code].tables) {{ skipped++; continue; }}
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {{
      if (!(await waitToken(25000))) {{
        try {{ turnstile.reset('#myWidget'); }} catch (e) {{}}
        if (!(await waitToken(25000))) break;
      }}
      setCode(code);
      await sleep(300);
      delete captured[code];
      jQuery('#tables-form button[type=submit]').trigger('click');
      const t0 = Date.now();
      while (!captured[code] && Date.now() - t0 < 10000) await sleep(200);
      const r = captured[code];
      if (r && r.tables && r.tables.length) ok = true;
      else {{ delete captured[code]; await sleep(1500); }}
    }}
    if (!ok) {{
      console.warn(`[暫停] ${{code}} 連續失敗(${{jQuery('#tables-message').text()}}),` +
        `請重新整理頁面、等驗證綠勾後再貼一次本腳本(已抓到的 ${{Object.keys(captured).length}} 檔不會重抓)。`);
      stopped = true;
      break;
    }}
    done++;
    if (done % 10 === 0) console.log(`... 已查 ${{done}}/${{CODES.length}}`);
    await sleep(800 + Math.random() * 700);
  }}

  console.log(`本次查詢結束:成功 ${{Object.keys(captured).length}} 檔,新增 ${{done}} 檔,${{stopped ? '中途暫停' : '全部完成'}}。`);

  // 給自動化驅動程式(broker_scan_tpex_auto.py)取回結果用;人工貼上時沒設 __NO_DOWNLOAD,照常下載
  window.__brokerCaptured = captured; window.__brokerStopped = stopped; window.__brokerDone = true;
  if (window.__NO_DOWNLOAD) return;

  const blob = new Blob([JSON.stringify({{ date: new Date().toISOString().slice(0, 10).replace(/-/g, ''), results: captured }}, null, 0)],
    {{ type: 'application/json' }});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `BrokerBS_TPEX_raw_${{new Date().toISOString().slice(0, 10).replace(/-/g, '')}}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  console.log('已觸發下載,請把檔案存到 scripts/output/broker_tpex_raw/ 後跑 broker_ingest_tpex.py。');
}})();
"""


def web_stock_codes():
    """網頁個股清單 (與前端 mergeAllData 完全一致,由 web_stock_list.js 輸出)"""
    try:
        r = subprocess.run(["node", str(SCRIPTS_DIR / "web_stock_list.js")],
                           capture_output=True, text=True, encoding="utf-8", timeout=120)
        codes = json.loads(r.stdout) if r.returncode == 0 else []
    except (OSError, ValueError, subprocess.SubprocessError):
        return []
    return sorted(str(c) for c in codes)


def main():
    all_data_path = REPO_DIR / "data" / "all-data.json"
    data = json.loads(all_data_path.read_text(encoding="utf-8"))
    cb_codes = web_stock_codes()
    if not cb_codes:  # node 不可用 → 退回 CB 發行清單 (含已到期標的)
        print("[警告] 無法取得網頁標的清單,改用 cbIssuance")
        cb_codes = sorted({c["stockCode"] for c in data.get("cbIssuance", []) if c.get("stockCode")})

    universe_dir = SCRIPTS_DIR / "cache" / "universe"
    files = sorted(universe_dir.glob("*.json"))
    if not files:
        raise SystemExit("找不到 scripts/cache/universe/*.json,先跑 build_universe.py")
    snap = json.loads(files[-1].read_text(encoding="utf-8"))
    market = {code: s.get("m") for code, s in snap.get("stocks", {}).items()}

    twse = [c for c in cb_codes if market.get(c) == "TWSE"]
    tpex = [c for c in cb_codes if market.get(c) == "TPEX"]
    unknown = [c for c in cb_codes if c not in market]

    out = {
        "generated_at": datetime.now(TAIPEI).isoformat(),
        "source_universe_snapshot": files[-1].name,
        "twse": twse,
        "tpex": tpex,
        "unknown": unknown,
    }
    cache_dir = SCRIPTS_DIR / "cache"
    cache_dir.mkdir(exist_ok=True)
    targets_path = cache_dir / "broker_targets.json"
    targets_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"寫入 {targets_path}: TWSE {len(twse)} 檔, TPEX {len(tpex)} 檔, 未知市場 {len(unknown)} 檔")

    js = JS_TEMPLATE.format(
        GEN_TIME=datetime.now(TAIPEI).strftime("%Y-%m-%d %H:%M"),
        CODES_JSON=json.dumps(tpex + unknown, ensure_ascii=False),
    )
    js_path = SCRIPTS_DIR / "broker_scan_tpex_console.js"
    js_path.write_text(js, encoding="utf-8")
    print(f"寫入 {js_path}")


if __name__ == "__main__":
    main()
