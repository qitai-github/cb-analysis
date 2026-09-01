/* signalView.js — 「週報」分頁
 *
 * 讀 data/signal_rank.json（scripts/positive_scan.py → build_signal_rank_json.py 產出）。
 * 全市場有 CB 的個股，用 12 項正向條件打分：分數 = 55 + 30 × 命中權重/16。
 * 分三級顯示：A 80+ / B 70-79 / C 60-69（60 分以下預設不顯示）。
 * 有前一次快照時會顯示分數變化與掉出榜單的名單。
 */
const SignalView = (() => {
  const DATA_URL = 'data/signal_rank.json';

  let data = null;
  let onRowClick = null;

  const state = {
    tiers: new Set(['A', 'B']),   // 預設看 70 分以上
    keyword: '',
    cbOnly: false,                // 只看 CB 量比 ≥2
    sort: 'score',                // score | delta | chg5 | volRatio | big4w
  };

  const TIER_META = {
    A: { label: '80+ 全正向', color: '#22c55e' },
    B: { label: '70–79 一半正向', color: '#3b82f6' },
    C: { label: '60–69 一些正向', color: '#94a3b8' },
    D: { label: '60 以下', color: '#64748b' },
  };

  // 訊號標籤的短名（key 對應 signal_rank.json 的 criteria）
  const SHORT = {
    vol: '放量', chg1: '日漲', chg5: '5日漲', chg20: '20日漲', pos: '高位階',
    trend: '多頭排列', foreign: '外資買', trust: '投信買', big: '大戶增',
    retail: '散戶減', margin: '融資退', cb: 'CB放量',
  };

  async function loadData() {
    if (data) return data;
    const resp = await fetch(DATA_URL, { cache: 'no-store' });
    if (!resp.ok) throw new Error('讀取 signal_rank.json 失敗: ' + resp.status);
    data = await resp.json();
    return data;
  }

  function isLoaded() { return !!data; }

  function getFiltered() {
    if (!data) return [];
    const kw = state.keyword.trim().toLowerCase();
    let rows = data.stocks.filter(r => {
      if (!state.tiers.has(r.tier)) return false;
      if (state.cbOnly && !(r.cb && r.cb.ratio >= 2)) return false;
      if (kw && !(r.code + ' ' + r.name).toLowerCase().includes(kw)) return false;
      return true;
    });
    const k = state.sort;
    rows.sort((a, b) => {
      if (k === 'delta') return (b.delta || -99) - (a.delta || -99);
      if (k === 'chg5') return b.chg5 - a.chg5;
      if (k === 'volRatio') return b.volRatio - a.volRatio;
      if (k === 'big4w') return b.big4w - a.big4w;
      return b.score - a.score;
    });
    return rows;
  }

  // ── 小工具 ────────────────────────────────────────────────────
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const sign = v => (v > 0 ? 'sig-up' : v < 0 ? 'sig-down' : 'sig-flat');
  const fmtPct = v => (v > 0 ? '+' : '') + v.toFixed(1) + '%';
  const fmtNum = v => (v > 0 ? '+' : '') + Math.round(v).toLocaleString();
  const fmtDate = s => (s && s.length === 8 ? `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6)}` : s || '—');

  // ── 版面 ──────────────────────────────────────────────────────
  function render(container, options = {}) {
    if (options.onRowClick) onRowClick = options.onRowClick;
    container.innerHTML = '';

    if (!data) {
      const empty = el('div', 'signal-empty');
      empty.innerHTML = '週報資料尚未產生（<code>data/signal_rank.json</code>）。<br>'
        + '請先執行 <code>python scripts/positive_scan.py</code> 再執行 '
        + '<code>python scripts/build_signal_rank_json.py</code>。';
      container.appendChild(empty);
      return;
    }

    container.appendChild(buildHeader());
    container.appendChild(buildControls(container));
    container.appendChild(buildTable(getFiltered()));
    const dropped = buildDropped();
    if (dropped) container.appendChild(dropped);
  }

  function buildHeader() {
    const m = data._meta;
    const head = el('div', 'signal-head');

    const left = el('div', 'signal-head-left');
    left.appendChild(el('h3', 'signal-title', '週報 · 正向訊號榜'));
    const sub = el('div', 'signal-sub');
    sub.textContent = `12 項正向條件加權評分（${m.formula}）　`
      + `價量/法人 ${fmtDate(m.asOf)}　融資券 ${fmtDate(m.marginDate)}　集保 ${fmtDate(m.holderDate)}`
      + (m.prevDate ? `　對照 ${fmtDate(m.prevDate)}` : '');
    left.appendChild(sub);
    head.appendChild(left);

    const tiers = el('div', 'signal-tiers');
    for (const t of ['A', 'B', 'C']) {
      const box = el('div', 'signal-tier-box');
      const n = el('div', 'signal-tier-n', String(m['tier' + t] || 0));
      n.style.color = TIER_META[t].color;
      box.append(n, el('div', 'signal-tier-l', TIER_META[t].label));
      tiers.appendChild(box);
    }
    head.appendChild(tiers);
    return head;
  }

  function buildControls(container) {
    const bar = el('div', 'signal-controls');
    const rerender = () => render(container);

    const tierWrap = el('div', 'signal-ctrl-group');
    tierWrap.appendChild(el('span', 'signal-ctrl-label', '分級'));
    for (const t of ['A', 'B', 'C']) {
      const btn = el('button', 'signal-chip' + (state.tiers.has(t) ? ' active' : ''),
        TIER_META[t].label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (state.tiers.has(t)) state.tiers.delete(t); else state.tiers.add(t);
        if (state.tiers.size === 0) state.tiers.add(t);   // 至少留一個
        rerender();
      });
      tierWrap.appendChild(btn);
    }
    bar.appendChild(tierWrap);

    const cbBtn = el('button', 'signal-chip' + (state.cbOnly ? ' active' : ''), '只看 CB 放量 ≥2x');
    cbBtn.type = 'button';
    cbBtn.addEventListener('click', () => { state.cbOnly = !state.cbOnly; rerender(); });
    bar.appendChild(cbBtn);

    const sortWrap = el('div', 'signal-ctrl-group');
    sortWrap.appendChild(el('span', 'signal-ctrl-label', '排序'));
    const sel = el('select', 'signal-select');
    const opts = [['score', '分數'], ['delta', '分數變化'], ['chg5', '5 日漲跌'],
      ['volRatio', '量比'], ['big4w', '大戶 4 週']];
    for (const [v, label] of opts) {
      const o = el('option', null, label);
      o.value = v;
      if (state.sort === v) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { state.sort = sel.value; rerender(); });
    sortWrap.appendChild(sel);
    bar.appendChild(sortWrap);

    const search = el('input', 'signal-search');
    search.type = 'text';
    search.placeholder = '代碼或名稱…';
    search.value = state.keyword;
    search.addEventListener('input', () => {
      state.keyword = search.value;
      const tbody = container.querySelector('.signal-table tbody');
      if (tbody) fillRows(tbody, getFiltered());
      const stat = container.querySelector('.signal-count');
      if (stat) stat.textContent = `共 ${getFiltered().length} 檔`;
    });
    bar.appendChild(search);

    bar.appendChild(el('div', 'signal-count', `共 ${getFiltered().length} 檔`));
    return bar;
  }

  const COLS = [
    ['分數', 'right'], ['變化', 'right'], ['代碼', 'left'], ['名稱', 'left'],
    ['收盤', 'right'], ['當日', 'right'], ['5日', 'right'], ['20日', 'right'],
    ['量比', 'right'], ['位階', 'right'], ['外資5日', 'right'], ['投信5日', 'right'],
    ['大戶4週', 'right'], ['融資5日', 'right'], ['CB量比', 'right'], ['命中訊號', 'left'],
  ];

  function buildTable(rows) {
    const wrap = el('div', 'signal-table-wrap');
    const table = el('table', 'signal-table');
    const thead = el('thead');
    const tr = el('tr');
    for (const [label, align] of COLS) {
      const th = el('th', align === 'right' ? 'text-right' : null, label);
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
    const tbody = el('tbody');
    fillRows(tbody, rows);
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function fillRows(tbody, rows) {
    tbody.innerHTML = '';
    if (!rows.length) {
      const tr = el('tr');
      const td = el('td', 'signal-none', '沒有符合條件的標的');
      td.colSpan = COLS.length;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (const r of rows) {
      const tr = el('tr', 'signal-row');
      tr.dataset.code = r.code;

      const score = el('td', 'text-right signal-score');
      score.textContent = r.score.toFixed(1);
      score.style.color = TIER_META[r.tier].color;
      tr.appendChild(score);

      const delta = el('td', 'text-right ' + (r.delta === undefined ? 'sig-flat' : sign(r.delta)));
      delta.textContent = r.delta === undefined ? '—' : (r.delta > 0 ? '+' : '') + r.delta.toFixed(1);
      if (r.prevScore !== undefined) delta.title = `上次 ${r.prevScore.toFixed(1)} 分`;
      tr.appendChild(delta);

      tr.appendChild(el('td', null, r.code));
      tr.appendChild(el('td', null, r.name));
      tr.appendChild(el('td', 'text-right', r.close >= 100
        ? Math.round(r.close).toLocaleString() : r.close.toFixed(2)));
      tr.appendChild(el('td', 'text-right ' + sign(r.chg1), fmtPct(r.chg1)));
      tr.appendChild(el('td', 'text-right ' + sign(r.chg5), fmtPct(r.chg5)));
      tr.appendChild(el('td', 'text-right ' + sign(r.chg20), fmtPct(r.chg20)));

      const vr = el('td', 'text-right', r.volRatio.toFixed(2) + 'x');
      if (r.volRatio >= 2) vr.classList.add('sig-up');
      else if (r.volRatio <= 0.5) vr.classList.add('sig-dim');
      vr.title = `成交 ${r.vol.toLocaleString()} 張 / 20 日均量 ${r.volMA20.toLocaleString()} 張`;
      tr.appendChild(vr);

      tr.appendChild(el('td', 'text-right', Math.round(r.pos) + '%'));
      tr.appendChild(el('td', 'text-right ' + sign(r.foreign5), fmtNum(r.foreign5)));
      tr.appendChild(el('td', 'text-right ' + sign(r.trust5), fmtNum(r.trust5)));

      const big = el('td', 'text-right ' + sign(r.big4w), (r.big4w > 0 ? '+' : '') + r.big4w.toFixed(2));
      big.title = `1 週 ${r.big1w > 0 ? '+' : ''}${r.big1w} / 12 週 ${r.big12w > 0 ? '+' : ''}${r.big12w}`;
      tr.appendChild(big);

      // 融資增加對籌碼是負面 → 顏色反過來
      const mg = el('td', 'text-right ' + sign(-r.margin5), fmtPct(r.margin5));
      mg.title = `20 日 ${r.margin20 > 0 ? '+' : ''}${r.margin20}%`;
      tr.appendChild(mg);

      const cb = el('td', 'text-right');
      if (r.cb) {
        cb.textContent = r.cb.ratio.toFixed(1) + 'x';
        if (r.cb.ratio >= 2) cb.classList.add('sig-up');
        cb.title = `${r.cb.code} ${r.cb.name}　${r.cb.vol.toLocaleString()} 張`
          + `　CB 價 ${r.cb.close}（5 日 ${r.cb.chg5 > 0 ? '+' : ''}${r.cb.chg5}%）`;
      } else {
        cb.textContent = '—';
        cb.classList.add('sig-dim');
      }
      tr.appendChild(cb);

      const hits = el('td', 'signal-hits');
      for (const k of r.hits) {
        const chip = el('span', 'signal-hit', SHORT[k] || k);
        hits.appendChild(chip);
      }
      tr.appendChild(hits);

      tr.addEventListener('click', () => onRowClick && onRowClick(r.code));
      tbody.appendChild(tr);
    }
  }

  function buildDropped() {
    if (!data.dropped || !data.dropped.length) return null;
    const box = el('div', 'signal-dropped');
    const names = data.dropped
      .map(d => `${d.code}（上次 ${d.prevScore.toFixed(1)}）`).join('、');
    box.innerHTML = `<b>掉出榜單</b>（上次 70 分以上、這次未入榜）：${names}`
      + '<div class="signal-dropped-note">未入榜多半是跌破月線或 20 日轉為負報酬被門檻擋掉，'
      + '不一定是籌碼變壞。</div>';
    return box;
  }

  return { loadData, isLoaded, render, getFiltered };
})();
