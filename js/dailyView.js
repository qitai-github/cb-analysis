/* dailyView.js — 「日報」分頁
 *
 * 讀 data/daily_cb_rank.json（scripts/daily_cb_scan.py → build_daily_cb_rank_json.py 產出）。
 * 用週報同一套技術面/籌碼面規格,只是對象改成「CB 當日漲幅前 N 檔」與「CB 當日量能前 N 檔」
 * 兩個排行榜,對應個股附上技術面、籌碼面(含融資券、券商分點)欄位。
 * 版面沿用 signalView.js 的 CSS class(視覺與「週報」一致)。
 */
const DailyView = (() => {
  const DATA_URL = 'data/daily_cb_rank.json';
  const HISTORY_INDEX_URL = 'data/daily_cb_rank_history/index.json';
  const HISTORY_DIR = 'data/daily_cb_rank_history/';

  let data = null;
  let onRowClick = null;

  let historyIndex = null;
  const historyCache = {};
  let activeDate = null;

  function current() { return activeDate ? historyCache[activeDate] : data; }

  const state = {
    rank: 'A',       // A = 漲幅榜, B = 量能榜
    keyword: '',
  };

  async function loadData() {
    if (data) return data;
    const resp = await fetch(DATA_URL, { cache: 'no-store' });
    if (!resp.ok) throw new Error('讀取 daily_cb_rank.json 失敗: ' + resp.status);
    data = await resp.json();
    try {
      const hResp = await fetch(HISTORY_INDEX_URL, { cache: 'no-store' });
      if (hResp.ok) historyIndex = await hResp.json();
    } catch (e) { /* 沒有往期資料就不顯示切換列 */ }
    return data;
  }

  async function loadHistory(dateStr) {
    if (historyCache[dateStr]) return historyCache[dateStr];
    const resp = await fetch(HISTORY_DIR + dateStr + '.json', { cache: 'no-store' });
    if (!resp.ok) throw new Error('讀取往期日報失敗: ' + resp.status);
    historyCache[dateStr] = await resp.json();
    return historyCache[dateStr];
  }

  function isLoaded() { return !!data; }

  function getFiltered() {
    const d = current();
    if (!d) return [];
    const rows = d[state.rank] || [];
    const kw = state.keyword.trim().toLowerCase();
    if (!kw) return rows;
    return rows.filter(r => (r.cbCode + ' ' + r.stock + ' ' + (r.name || '')).toLowerCase().includes(kw));
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
      empty.innerHTML = '日報資料尚未產生（<code>data/daily_cb_rank.json</code>）。<br>'
        + '請先執行 <code>python scripts/daily_cb_scan.py</code> 再執行 '
        + '<code>python scripts/build_daily_cb_rank_json.py</code>。';
      container.appendChild(empty);
      return;
    }

    container.appendChild(buildHeader());
    const switcher = buildDateSwitcher(container);
    if (switcher) container.appendChild(switcher);
    const commentary = buildCommentary();
    if (commentary) container.appendChild(commentary);
    container.appendChild(buildControls(container));
    container.appendChild(buildTable(getFiltered()));
  }

  function buildHeader() {
    const m = current()._meta;
    const head = el('div', 'signal-head');

    const left = el('div', 'signal-head-left');
    left.appendChild(el('h3', 'signal-title', '日報 · CB 漲幅／量能排行'));
    const sub = el('div', 'signal-sub');
    sub.textContent = `CB 當日漲幅／成交量前 ${m.top} 檔　`
      + `價量/CB/法人 ${fmtDate(m.date)}　券商分點 ${fmtDate(m.brokerDate)}　`
      + `前一交易日 ${fmtDate(m.prevDate)}`;
    left.appendChild(sub);
    head.appendChild(left);

    const tiers = el('div', 'signal-tiers');
    const boxA = el('div', 'signal-tier-box');
    boxA.append(el('div', 'signal-tier-n', String(m.cbCountA || 0)), el('div', 'signal-tier-l', '漲幅榜檔數'));
    const boxB = el('div', 'signal-tier-box');
    boxB.append(el('div', 'signal-tier-n', String(m.cbCountB || 0)), el('div', 'signal-tier-l', '量能榜檔數'));
    tiers.append(boxA, boxB);
    head.appendChild(tiers);
    return head;
  }

  // 評論(日報文字)— 由 scripts/output/daily_commentary.json 併進 daily_cb_rank.json,格式與週報評論相同
  function buildCommentary() {
    const rep = current().report;
    if (!rep) return null;

    const box = el('div', 'signal-report');

    const bar = el('div', 'signal-report-bar');
    const h = el('div', 'signal-report-h');
    h.appendChild(el('span', 'signal-report-title', rep.title || '日報評論'));
    if (rep.date) h.appendChild(el('span', 'signal-report-date', rep.date));
    bar.appendChild(h);
    if (rep.artifactUrl) {
      const link = el('a', 'btn-tech-analysis', '📄 看完整報告');
      link.href = rep.artifactUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      bar.appendChild(link);
    }
    box.appendChild(bar);

    const body = el('div', 'signal-report-body');
    if (rep.lede) body.appendChild(el('p', 'signal-report-lede', rep.lede));

    if (rep.stats && rep.stats.length) {
      const grid = el('div', 'signal-report-stats');
      for (const st of rep.stats) {
        const cell = el('div', 'signal-report-stat');
        cell.appendChild(el('div', 'signal-report-stat-l', st.label));
        cell.appendChild(el('div', 'signal-report-stat-v', st.value));
        if (st.note) cell.appendChild(el('div', 'signal-report-stat-n', st.note));
        grid.appendChild(cell);
      }
      body.appendChild(grid);
    }

    if (rep.highlights && rep.highlights.length) {
      const cards = el('div', 'signal-report-cards');
      for (const hl of rep.highlights) {
        const card = el('div', 'signal-report-card');
        const top = el('div', 'signal-report-card-top');
        const sc = el('span', 'signal-report-card-score', Number(hl.score).toFixed(1));
        top.appendChild(sc);
        top.appendChild(el('span', 'signal-report-card-code', hl.code));
        top.appendChild(el('span', 'signal-report-card-name', hl.name));
        if (hl.tag) top.appendChild(el('span', 'signal-report-card-tag', hl.tag));
        card.appendChild(top);
        if (hl.text) card.appendChild(el('p', 'signal-report-card-text', hl.text));
        if (hl.cb) card.appendChild(el('div', 'signal-report-card-cb', hl.cb));
        card.addEventListener('click', () => onRowClick && onRowClick(hl.code));
        cards.appendChild(card);
      }
      body.appendChild(cards);
    }

    if (rep.sections && rep.sections.length) {
      const secs = el('div', 'signal-report-secs');
      for (const sec of rep.sections) {
        const s1 = el('div', 'signal-report-sec');
        s1.appendChild(el('h4', 'signal-report-sec-h', sec.heading));
        s1.appendChild(el('p', 'signal-report-sec-b', sec.body));
        secs.appendChild(s1);
      }
      body.appendChild(secs);
    }

    box.appendChild(body);
    return box;
  }

  function buildControls(container) {
    const bar = el('div', 'signal-controls');
    const rerender = () => render(container);

    const rankWrap = el('div', 'signal-ctrl-group');
    rankWrap.appendChild(el('span', 'signal-ctrl-label', '榜單'));
    for (const [k, label] of [['A', 'CB 漲幅榜'], ['B', 'CB 量能榜']]) {
      const btn = el('button', 'signal-chip' + (state.rank === k ? ' active' : ''), label);
      btn.type = 'button';
      btn.addEventListener('click', () => { state.rank = k; rerender(); });
      rankWrap.appendChild(btn);
    }
    bar.appendChild(rankWrap);

    const search = el('input', 'signal-search');
    search.type = 'text';
    search.placeholder = 'CB 代碼／個股代碼或名稱…';
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
    ['#', 'right'], ['CB', 'left'], ['個股', 'left'], ['CB價', 'right'], ['CB漲跌', 'right'],
    ['CB量', 'right'], ['CB量比', 'right'], ['股當日', 'right'], ['5日', 'right'], ['20日', 'right'],
    ['股量比', 'right'], ['位階', 'right'], ['均線', 'left'], ['外資5日', 'right'], ['投信5日', 'right'],
    ['大戶4週', 'right'], ['融資日增', 'right'], ['融資5日', 'right'], ['融券日增', 'right'],
    ['券資比', 'right'], ['週報分', 'right'], ['券商買超前2', 'left'], ['前5集中', 'right'],
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

  function trendLabel(r) {
    if (r.close > r.ma20 && r.ma20 > r.ma60) return '多頭';
    if (r.close < r.ma20) return '月線下';
    return '整理';
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
      tr.dataset.code = r.stock;

      tr.appendChild(el('td', 'text-right', String(r.rank)));
      const cbCell = el('td', null, r.cbCode);
      cbCell.title = r.cbName || '';
      tr.appendChild(cbCell);

      if (!r.ok) {
        tr.appendChild(el('td', null, '（無個股資料）'));
        const rest = el('td', 'signal-none');
        rest.colSpan = COLS.length - 2;
        rest.textContent = '—';
        tr.appendChild(rest);
        tbody.appendChild(tr);
        continue;
      }

      tr.appendChild(el('td', null, `${r.stock} ${r.name}`));
      tr.appendChild(el('td', 'text-right', r.cbClose >= 100
        ? Math.round(r.cbClose).toLocaleString() : r.cbClose.toFixed(1)));
      tr.appendChild(el('td', 'text-right ' + sign(r.cbChg), fmtPct(r.cbChg)));
      tr.appendChild(el('td', 'text-right', Math.round(r.cbVol).toLocaleString()));

      const vr = el('td', 'text-right');
      if (r.cbVolRatio == null || r.cbVolMA60 < 5) {
        vr.textContent = '—';
        vr.classList.add('sig-dim');
        vr.title = 'CB 60 日均量 <5 張,倍數失真';
      } else {
        vr.textContent = r.cbVolRatio.toFixed(2) + 'x';
        if (r.cbVolRatio >= 2) vr.classList.add('sig-up');
      }
      tr.appendChild(vr);

      tr.appendChild(el('td', 'text-right ' + sign(r.chg1), fmtPct(r.chg1)));
      tr.appendChild(el('td', 'text-right ' + sign(r.chg5), fmtPct(r.chg5)));
      tr.appendChild(el('td', 'text-right ' + sign(r.chg20), fmtPct(r.chg20)));

      const svr = el('td', 'text-right', r.volRatio.toFixed(2) + 'x');
      if (r.volRatio >= 1.8) svr.classList.add('sig-up');
      else if (r.volRatio <= 0.5) svr.classList.add('sig-dim');
      tr.appendChild(svr);

      tr.appendChild(el('td', 'text-right', Math.round(r.pos) + '%'));
      tr.appendChild(el('td', null, trendLabel(r)));
      tr.appendChild(el('td', 'text-right ' + sign(r.foreign5), fmtNum(r.foreign5)));
      tr.appendChild(el('td', 'text-right ' + sign(r.trust5), fmtNum(r.trust5)));

      const big = el('td', 'text-right ' + sign(r.big4w), (r.big4w > 0 ? '+' : '') + r.big4w.toFixed(2));
      tr.appendChild(big);

      // 融資增加對籌碼是負面 → 顏色反過來(跟週報一致)
      tr.appendChild(el('td', 'text-right ' + sign(-r.marginChg1), fmtNum(r.marginChg1)));
      const m5 = el('td', 'text-right ' + sign(-r.marginChg5pct),
        Math.abs(r.marginChg5pct) < 500 ? fmtPct(r.marginChg5pct) : '—');
      tr.appendChild(m5);
      tr.appendChild(el('td', 'text-right ' + sign(r.shortChg1), fmtNum(r.shortChg1)));
      const ratio = r.marginBal ? (r.shortBal / r.marginBal * 100) : 0;
      tr.appendChild(el('td', 'text-right', r.marginBal ? Math.round(ratio) + '%' : '—'));

      const sc = el('td', 'text-right signal-score', r.score ? r.score.toFixed(1) : '—');
      tr.appendChild(sc);

      const brk = (r.brokerBuy || []).map(b => `${(b[0] || '?').slice(0, 4)} ${b[1] > 0 ? '+' : ''}${b[1]}`).join('、');
      const brkCell = el('td', null, brk || '—');
      tr.appendChild(brkCell);
      tr.appendChild(el('td', 'text-right', r.top5NetPct != null ? Math.round(r.top5NetPct) + '%' : '—'));

      tr.addEventListener('click', () => onRowClick && onRowClick(r.stock));
      tbody.appendChild(tr);
    }
  }

  const MAX_DAYS = 10;

  function buildDateSwitcher(container) {
    if (!historyIndex || historyIndex.length === 0) return null;
    const dates = historyIndex.map(e => e.date).slice(0, MAX_DAYS);
    if (dates.length < 2) return null;

    const bar = el('div', 'crm-ver-bar signal-week-bar');
    bar.appendChild(el('span', null, '日報：'));

    dates.forEach((dateStr, i) => {
      const isActive = activeDate ? activeDate === dateStr : i === 0;
      const btn = el('button', 'crm-ver-btn' + (isActive ? ' on' : ''),
        `${fmtDate(dateStr)}${i === 0 ? '（最新）' : ''}`);
      btn.type = 'button';
      btn.disabled = isActive;
      btn.addEventListener('click', async () => {
        if (i === 0) {
          activeDate = null;
        } else {
          try {
            await loadHistory(dateStr);
            activeDate = dateStr;
          } catch (e) {
            alert('讀取往期日報失敗：' + e.message);
            return;
          }
        }
        render(container);
      });
      bar.appendChild(btn);
    });
    return bar;
  }

  return { loadData, isLoaded, render, getFiltered };
})();
