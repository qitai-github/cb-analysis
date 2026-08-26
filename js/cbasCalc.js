/**
 * CBAS 追價計算機 (左側面板)
 *
 * 交易情境:盤中要決定「這檔 CB 還能不能追、最多追到幾元」。溢價率要 CB價 與
 * 股價兩者才算得出來,但網頁只有昨收,所以由使用者輸入個股即時股價,計算機用
 * 該股每一檔 CB 的轉換價換算出可下單上限。
 *
 * 判斷規則 (使用者的框架):
 *     CB價 + 溢價率(百分點) < 180
 *   這條線等價於使用者原本的分段表 —— 130+50 / 140+40 / 150+30 / 160+20 皆為 180,
 *   差別只在分段表是離散的,這條線連續、且兩端自然延伸,不必另外定義邊界。
 *
 * 閉式解:
 *   轉換價值 CV = 100 / 轉換價 × 股價
 *   溢價率(%)   = (P - CV) / CV × 100
 *   代入 P + (P - CV)/CV × 100 < 180
 *     → P × (1 + 100/CV) < 280
 *     → P < 280 × CV / (CV + 100)
 */
const CBASCalc = (function () {
  'use strict';

  const LINE = 180;      // CB價 + 溢價(百分點) 的上限
  const PAR  = 100;      // CB 面額

  // 判斷規則預設不顯示,在股號欄輸入通關詞才展開 (再輸入一次收回)。
  // 只是避免旁人一眼看到自己的框架,不是保密機制 —— 規則本身寫在這支 js 裡。
  const UNLOCK_WORD = 'balasong';
  const UNLOCK_KEY = 'cbasCalcRuleUnlocked';

  let getStock = null;   // (code) => stock | null
  let listStocks = null; // () => [{code, name}]
  let lastQuery = { code: '', price: '' };

  function ruleUnlocked() {
    try { return localStorage.getItem(UNLOCK_KEY) === '1'; } catch (e) { return false; }
  }

  function setRuleUnlocked(on) {
    try { localStorage.setItem(UNLOCK_KEY, on ? '1' : '0'); } catch (e) { /* 無痕模式等 */ }
  }

  function ruleHtml() {
    return `
      <details class="calc-rule" open>
        <summary>判斷規則</summary>
        <div>CB價 + 溢價(百分點) &lt; ${LINE}</div>
        <div class="calc-dim">120-130 &lt;50%　130-140 &lt;40%<br>140-150 &lt;30%　150-160 &lt;20%</div>
        <div class="calc-dim">上限 = ${LINE + PAR}×轉換價值 ÷ (轉換價值+${PAR})</div>
      </details>`;
  }

  /** 依解鎖狀態決定規則區塊要不要進 DOM (鎖住時整段不渲染) */
  function paintRule(box) {
    const slot = box.querySelector('#calc-rule-slot');
    if (slot) slot.innerHTML = ruleUnlocked() ? ruleHtml() : '';
  }

  /** 可下單上限:P + (P-CV)/CV×100 = LINE 的解 */
  function priceCeiling(cv) {
    if (!cv || cv <= 0) return null;
    return (LINE + PAR) * cv / (cv + PAR);
  }

  function premiumPct(price, cv) {
    if (!cv || cv <= 0 || price == null) return null;
    return (price - cv) / cv * 100;
  }

  /** 上限落在哪個 10 元級距 → 對應使用者原本講法的門檻 */
  function bandLabel(ceiling) {
    const lo = Math.floor(ceiling / 10) * 10;
    return `${lo}-${lo + 10} 區間,溢價門檻 <${LINE - (lo + 10)}%`;
  }

  function calc(stock, stockPrice) {
    const cbs = (stock && stock.cbs) ? stock.cbs : [];
    return cbs
      .filter(cb => cb.conversionPrice > 0)
      .map(cb => {
        const cv = PAR / cb.conversionPrice * stockPrice;
        const ceiling = priceCeiling(cv);
        const now = cb.close != null && cb.close > 0 ? cb.close : null;
        return {
          cbCode: cb.cbCode,
          cbName: cb.cbName || '',
          convPrice: cb.conversionPrice,
          cv: cv,
          ceiling: ceiling,
          ceilingPremium: premiumPct(ceiling, cv),
          now: now,
          nowPremium: now != null ? premiumPct(now, cv) : null,
          room: (now != null && ceiling != null) ? ceiling - now : null,
          belowPar: ceiling != null && ceiling < PAR
        };
      });
  }

  function fmt(v, d) {
    return v == null ? '-' : v.toFixed(d == null ? 2 : d);
  }

  function renderResult(stock, stockPrice) {
    const rows = calc(stock, stockPrice);
    if (rows.length === 0) {
      return '<div class="calc-empty">這檔股票沒有可用的 CB 轉換價</div>';
    }
    let html = '';
    for (const r of rows) {
      // 昨收僅供參考 (盤中請以實際委買賣價為準),所以判斷語氣用「參考」
      let verdict = '', vcls = '';
      if (r.now != null) {
        if (r.now < r.ceiling) {
          verdict = `可追 (還有 ${fmt(r.room)} 元空間)`;
          vcls = 'calc-ok';
        } else {
          verdict = `已超過上限 ${fmt(r.now - r.ceiling)} 元`;
          vcls = 'calc-no';
        }
      }
      html += `
        <div class="calc-card">
          <div class="calc-card-head">
            <span class="calc-cb">${r.cbCode} ${r.cbName}</span>
            <span class="calc-conv">轉換價 ${fmt(r.convPrice)}</span>
          </div>
          <div class="calc-ceiling">
            <span class="calc-ceiling-label">可下單上限</span>
            <span class="calc-ceiling-val${r.belowPar ? ' calc-no' : ''}">${fmt(r.ceiling)}</span>
          </div>
          <div class="calc-sub">轉換價值 ${fmt(r.cv)}　上限溢價 ${fmt(r.ceilingPremium, 1)}%</div>
          <div class="calc-sub calc-dim">${bandLabel(r.ceiling)}</div>
          ${r.belowPar
            ? '<div class="calc-warn">上限低於面額 100,實務上不可追</div>'
            : ''}
          ${r.now != null
            ? `<div class="calc-now">CB 昨收 ${fmt(r.now)}(溢價 ${fmt(r.nowPremium, 1)}%)
                 <span class="${vcls}">${verdict}</span></div>`
            : '<div class="calc-sub calc-dim">無 CB 收盤價可比對</div>'}
        </div>`;
    }
    return html;
  }

  function run(container) {
    const codeEl = container.querySelector('#calc-code');
    const priceEl = container.querySelector('#calc-price');
    const out = container.querySelector('#calc-result');
    const raw = (codeEl.value || '').trim();

    // 通關詞:切換規則區塊,不當股號查詢
    if (raw.toLowerCase() === UNLOCK_WORD) {
      const on = !ruleUnlocked();
      setRuleUnlocked(on);
      paintRule(container);
      codeEl.value = '';
      lastQuery = { code: '', price: priceEl.value };
      out.innerHTML = `<div class="calc-empty">判斷規則已${on ? '顯示' : '隱藏'}</div>`;
      return;
    }

    const price = parseFloat(priceEl.value);
    lastQuery = { code: raw, price: priceEl.value };

    if (!raw) { out.innerHTML = '<div class="calc-empty">請輸入股號</div>'; return; }
    if (!(price > 0)) { out.innerHTML = '<div class="calc-empty">請輸入個股即時股價</div>'; return; }

    // 允許直接貼「3141 晶宏」或「3141」;也接受打股名
    const code = raw.split(/\s+/)[0];
    let stock = getStock ? getStock(code) : null;
    if (!stock && listStocks) {
      const hit = listStocks().find(s => s.name === raw || s.name === code);
      if (hit) stock = getStock(hit.code);
    }
    if (!stock) {
      out.innerHTML = `<div class="calc-empty">查無「${raw}」,或這檔沒有 CB</div>`;
      return;
    }
    out.innerHTML =
      `<div class="calc-stockline">${stock.code || code} ${stock.name || ''}　股價 ${fmt(price)}</div>`
      + renderResult(stock, price);
  }

  /** 把計算機掛到左側面板最上方 */
  function render(panel) {
    const box = document.createElement('div');
    box.className = 'calc-panel';
    box.innerHTML = `
      <div class="calc-head">
        <span>CBAS 追價計算機</span>
        <button type="button" class="calc-toggle" title="收合/展開">−</button>
      </div>
      <div class="calc-body">
        <div class="calc-inputs">
          <input id="calc-code" type="text" placeholder="股號 (如 3141)" list="calc-stock-list"
                 autocomplete="off" value="${lastQuery.code}">
          <input id="calc-price" type="number" step="0.01" placeholder="個股即時股價"
                 value="${lastQuery.price}">
        </div>
        <datalist id="calc-stock-list"></datalist>
        <div id="calc-result"></div>
        <div id="calc-rule-slot"></div>
      </div>`;
    panel.appendChild(box);

    // 股號候選
    if (listStocks) {
      const dl = box.querySelector('#calc-stock-list');
      dl.innerHTML = listStocks()
        .map(s => `<option value="${s.code}">${s.code} ${s.name}</option>`)
        .join('');
    }

    const doRun = () => run(box);
    box.querySelector('#calc-code').addEventListener('change', doRun);
    box.querySelector('#calc-price').addEventListener('input', doRun);
    for (const id of ['#calc-code', '#calc-price']) {
      box.querySelector(id).addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); doRun(); }
      });
    }
    box.querySelector('.calc-toggle').addEventListener('click', () => {
      const body = box.querySelector('.calc-body');
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      box.querySelector('.calc-toggle').textContent = hidden ? '−' : '+';
    });

    paintRule(box);

    if (lastQuery.code && lastQuery.price) doRun();
  }

  function init(opts) {
    getStock = opts.getStock;
    listStocks = opts.listStocks;
  }

  return { init, render, priceCeiling, premiumPct, calc, LINE };
})();
