// 表格渲染模組
const Table = (() => {
  let currentData = [];
  let currentCBData = null;   // 可轉債分頁的列 (已套過篩選),null = 尚未提供
  let currentSort = { key: 'code', asc: true };
  let currentPage = 0;
  let onRowClick = null;
  let currentTab = 'stock';   // 'stock' | 'cb'
  let currentContainerId = 'main-table';

  // 「個股」分頁:每一列 = 一檔個股
  const STOCK_COLUMNS = [
    { key: '_star', label: '☆', width: '32px', sticky: true, format: 'star', noSort: false },
    { key: 'code', label: '代碼', width: '60px', sticky: true },
    { key: 'name', label: '名稱', width: '85px', sticky: true },
    { key: 'vcpStreak',     label: 'VCP',  width: '60px', format: 'badge_vcp',     align: 'center' },
    { key: 'sanxianStreak', label: '三線', width: '60px', format: 'badge_sanxian', align: 'center' },
    { key: 'industryCategory', label: '產業分類', width: '105px', format: 'industry' },
    { key: 'latestClose', label: '收盤價', width: '65px', format: 'price', align: 'right' },
    { key: 'priceChangePercent', label: '漲跌%', width: '60px', format: 'percent_color', align: 'right' },
    { key: 'latestVolume', label: '成交量(張)', width: '75px', format: 'volume', align: 'right' },
    { key: 'avgVolume5',   label: '5日均量', width: '70px', format: 'volume', align: 'right' },
    { key: 'avgVolume20',  label: '20日均量', width: '75px', format: 'volume', align: 'right' },
    { key: 'foreign_1d', label: '外資1日', width: '70px', format: 'inst', align: 'right' },
    { key: 'investment_1d', label: '投信1日', width: '70px', format: 'inst', align: 'right' },
    { key: 'dealer_1d', label: '自營1日', width: '70px', format: 'inst', align: 'right' },
    { key: 'totalInst_1d', label: '法人合計', width: '70px', format: 'inst', align: 'right' },
    { key: 'latestMarginBalance', label: '融資餘額', width: '75px', format: 'volume', align: 'right' },
    { key: 'latestMarginChange',  label: '融資增減', width: '75px', format: 'inst',   align: 'right' },
    { key: 'latestShortBalance',  label: '融券餘額', width: '75px', format: 'volume', align: 'right' },
    { key: 'latestShortChange',   label: '融券增減', width: '75px', format: 'inst',   align: 'right' }
  ];

  // 「可轉債」分頁:每一列 = 一檔 CB (從所有個股的 stock.cbs 攤平)
  const CB_COLUMNS = [
    { key: 'cbCode', label: 'CB代號', width: '70px', sticky: true },
    { key: 'cbName', label: 'CB名稱', width: '95px', sticky: true },
    { key: 'industryCategory', label: '產業分類', width: '105px', format: 'industry' },
    { key: 'close', label: 'CB收盤價', width: '75px', format: 'price', align: 'right' },
    { key: 'priceChangePercent', label: '漲跌%', width: '65px', format: 'percent_color', align: 'right' },
    { key: 'volume', label: '成交量(張)', width: '75px', format: 'volume', align: 'right' },
    { key: 'avgVolume5',  label: '5日均量', width: '70px', format: 'volume', align: 'right' },
    { key: 'avgVolume20', label: '20日均量', width: '75px', format: 'volume', align: 'right' },
    { key: 'conversionPrice', label: '轉換價', width: '70px', format: 'price', align: 'right' },
    { key: 'premiumRate',  label: 'CB溢價率', width: '80px', format: 'percent_color', align: 'right' },
    { key: 'balThisWeek',  label: '流通餘額(張)', width: '95px', format: 'volume', align: 'right' },
    { key: 'balChange',    label: '餘額增減', width: '75px', format: 'inst',   align: 'right' },
    { key: 'nearestPutDate', label: '最近賣回日', width: '95px', format: 'date_roc' }
  ];

  function activeColumns() {
    return currentTab === 'cb' ? CB_COLUMNS : STOCK_COLUMNS;
  }

  // 給外部讀 (updateInstDays) — 只動股票欄位
  const columns = STOCK_COLUMNS;

  /**
   * CB 分頁的列。優先用呼叫端算好的逐檔 CB 篩選結果 (options.cbRows);
   * 沒提供時退回攤平目前個股的 cbs。
   */
  function cbRows(stocks) {
    const list = currentCBData !== null
      ? currentCBData.slice()
      : stocks.flatMap(s => (s.cbs || []).filter(cb => cb && cb.cbCode));
    return Filters.sortResults(list, currentSort.key, currentSort.asc);
  }

  function render(containerId, data, options = {}) {
    currentData = data;
    currentContainerId = containerId;
    if (options.cbRows !== undefined) currentCBData = options.cbRows;
    if (options.onRowClick) onRowClick = options.onRowClick;

    const container = document.getElementById(containerId);
    container.innerHTML = '';

    // === CB 分頁攤平,股票分頁保持原樣 ===
    const cols = activeColumns();
    const rows = currentTab === 'cb' ? cbRows(data) : data;

    // === 工具列:左邊 folder-tab,右邊 共 N 檔標的 ===
    const toolbar = document.createElement('div');
    toolbar.className = 'table-toolbar';

    const tabs = document.createElement('div');
    tabs.className = 'table-folder-tabs';
    for (const t of [{ k: 'stock', label: '個股' }, { k: 'cb', label: '可轉債' }]) {
      const btn = document.createElement('button');
      btn.className = 'table-folder-tab' + (currentTab === t.k ? ' active' : '');
      btn.textContent = t.label;
      btn.addEventListener('click', () => switchInnerTab(t.k));
      tabs.appendChild(btn);
    }

    const stats = document.createElement('div');
    stats.className = 'table-stats';
    stats.textContent = `共 ${rows.length} 檔${currentTab === 'cb' ? '可轉債' : '標的'}`;

    toolbar.append(tabs, stats);
    container.appendChild(toolbar);

    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrapper table-folder-panel';

    const table = document.createElement('table');
    table.className = 'data-table';

    // 表頭
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of cols) {
      const th = document.createElement('th');
      th.textContent = col.label;
      th.style.width = col.width;
      th.style.minWidth = col.width;
      if (col.sticky) th.className = 'sticky-col';
      if (col.align === 'right') th.classList.add('text-right');
      if (col.align === 'center') th.classList.add('text-center');
      th.dataset.sortKey = col.key;
      th.addEventListener('click', () => handleSort(col.key, containerId));
      if (currentSort.key === col.key) {
        th.classList.add(currentSort.asc ? 'sort-asc' : 'sort-desc');
      }
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // 表身
    const tbody = document.createElement('tbody');
    const pageSize = APP_CONFIG.pageSize;
    const start = currentPage * pageSize;
    const end = Math.min(start + pageSize, rows.length);

    for (let i = start; i < end; i++) {
      const item = rows[i];
      const tr = document.createElement('tr');
      tr.addEventListener('click', () => {
        if (!onRowClick) return;
        // CB 列 click → 開正股 detail panel (cb.stockRef 由 dataProcessor 寫入)
        onRowClick(item.stockRef || item);
      });

      for (const col of cols) {
        const td = document.createElement('td');
        if (col.sticky) td.className = 'sticky-col';
        if (col.align === 'right') td.classList.add('text-right');
        if (col.align === 'center') td.classList.add('text-center');
        const val = getVal(item, col.key);
        formatCell(td, val, col.format, item);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);
    container.appendChild(wrapper);

    if (rows.length > pageSize) {
      container.appendChild(createPager(rows.length, pageSize, containerId));
    }
  }

  function switchInnerTab(tab) {
    if (tab === currentTab) return;
    currentTab = tab;
    // 切換後 sort key 可能不在新欄位 → 重置
    const validKeys = new Set(activeColumns().map(c => c.key));
    if (!validKeys.has(currentSort.key)) {
      currentSort = { key: tab === 'cb' ? 'cbCode' : 'code', asc: true };
      currentData = Filters.sortResults(currentData, currentSort.key, true);
    }
    currentPage = 0;
    render(currentContainerId, currentData);
  }

  function handleSort(key, containerId) {
    if (currentSort.key === key) {
      currentSort.asc = !currentSort.asc;
    } else {
      currentSort = { key, asc: true };
    }
    currentPage = 0;
    // 股票分頁直接 sort stock 陣列;CB 分頁的 sort 由 cbRows() 在 render 時套用
    if (currentTab !== 'cb') {
      currentData = Filters.sortResults(currentData, key, currentSort.asc);
    }
    render(containerId, currentData);
  }

  function createPager(total, pageSize, containerId) {
    const totalPages = Math.ceil(total / pageSize);
    const pager = document.createElement('div');
    pager.className = 'pager';

    const info = document.createElement('span');
    info.className = 'pager-info';
    info.textContent = `第 ${currentPage + 1} / ${totalPages} 頁`;
    pager.appendChild(info);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'pager-buttons';

    const mkBtn = (text, fn, disabled) => {
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.className = 'pager-btn';
      btn.disabled = disabled;
      btn.addEventListener('click', fn);
      return btn;
    };

    btnGroup.append(
      mkBtn('⧪', () => { currentPage = 0; render(containerId, currentData); }, currentPage === 0),
      mkBtn('◂', () => { currentPage--; render(containerId, currentData); }, currentPage === 0),
      mkBtn('▸', () => { currentPage++; render(containerId, currentData); }, currentPage >= totalPages - 1),
      mkBtn('⧫', () => { currentPage = totalPages - 1; render(containerId, currentData); }, currentPage >= totalPages - 1)
    );
    pager.appendChild(btnGroup);
    return pager;
  }

  function formatCell(td, val, format, item) {
    if (format === 'star') {
      const starred = Watchlist.has(item.code);
      td.textContent = starred ? '★' : '☆';
      td.style.cursor = 'pointer';
      td.style.fontSize = '16px';
      td.style.textAlign = 'center';
      td.style.color = starred ? '#f59e0b' : 'var(--text-dim)';
      td.addEventListener('click', (e) => {
        e.stopPropagation();
        showStarMenu(td, item.code);
      });
      return;
    }

    if (format === 'status') {
      renderStatusBadges(td, item);
      return;
    }

    if (format === 'badge_vcp') {
      renderSingleBadge(td, item, 'vcp');
      return;
    }
    if (format === 'badge_sanxian') {
      renderSingleBadge(td, item, 'sanxian');
      return;
    }

    if (val == null || val === '') {
      td.textContent = '-';
      td.classList.add('text-muted');
      return;
    }

    switch (format) {
      case 'price':
        td.textContent = Number(val).toFixed(2);
        td.classList.add('text-right');
        break;
      case 'percent_color': {
        const pct = Number(val);
        td.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
        td.classList.add('text-right', pct > 0 ? 'text-up' : pct < 0 ? 'text-down' : 'text-neutral');
        break;
      }
      case 'change_color': {
        const chg = Number(val);
        td.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2);
        td.classList.add('text-right', chg > 0 ? 'text-up' : chg < 0 ? 'text-down' : 'text-neutral');
        break;
      }
      case 'volume':
        td.textContent = fmtVol(Number(val));
        td.classList.add('text-right');
        break;
      case 'inst': {
        const n = Number(val);
        td.textContent = n === 0 ? '0' : (n > 0 ? '+' : '') + fmtVol(n);
        td.classList.add('text-right', n > 0 ? 'text-up' : n < 0 ? 'text-down' : 'text-neutral');
        break;
      }
      case 'industry':
        td.textContent = String(val);
        td.title = String(val);
        td.classList.add('cell-industry');
        break;
      case 'date_roc':
        td.textContent = fmtRocDate(String(val));
        break;
      default:
        td.textContent = String(val);
    }
  }

  function fmtVol(v) {
    const sign = v < 0 ? '-' : '';
    return sign + Math.abs(v).toLocaleString();
  }

  function fmtRocDate(s) {
    if (!s) return '-';
    // 接受 "114/05/25" (民國) / "2028-05-25" (西元) / "2028/05/25" 等格式
    const m = s.match(/^(\d{2,4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (m) {
      const yy = parseInt(m[1], 10);
      const year = yy < 200 ? yy + 1911 : yy;
      return `${year}/${m[2].padStart(2,'0')}/${m[3].padStart(2,'0')}`;
    }
    return s;
  }

  function updateStarCell(td, code) {
    const starred = Watchlist.has(code) || PublicWatchlist.has(code);
    td.textContent = starred ? '★' : '☆';
    td.style.color = starred ? '#f59e0b' : 'var(--text-dim)';
  }

  function showStarMenu(td, code) {
    // 關閉已開啟的選單
    const existing = document.querySelector('.star-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'star-menu';

    const lists = Watchlist.getListNames();
    for (const name of lists) {
      const row = document.createElement('label');
      row.className = 'star-menu-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = Watchlist.isInList(code, name);
      cb.addEventListener('change', () => {
        if (cb.checked) Watchlist.addToList(code, name);
        else Watchlist.removeFromList(code, name);
        updateStarCell(td, code);
      });
      const span = document.createElement('span');
      span.textContent = name;
      row.append(cb, span);
      menu.appendChild(row);
    }

// 分隔線
const divider = document.createElement('div');
divider.className = 'star-menu-divider';
menu.appendChild(divider);

// 公用清單(多個)
for (const pubName of PublicWatchlist.getLists()) {
  const pubRow = document.createElement('label');
  pubRow.className = 'star-menu-item star-menu-item--public';
  const pubCb = document.createElement('input');
  pubCb.type = 'checkbox';
  pubCb.checked = PublicWatchlist.has(code, pubName);
  pubCb.addEventListener('change', async () => {
    pubCb.disabled = true;
    if (pubCb.checked) await PublicWatchlist.add(pubName, code);
    else await PublicWatchlist.remove(pubName, code);
    pubCb.disabled = false;
    updateStarCell(td, code);
  });
  const pubSpan = document.createElement('span');
  pubSpan.textContent = `🌟${pubName}`;
  const pubBadge = document.createElement('span');
  pubBadge.className = 'star-menu-public-badge';
  pubBadge.textContent = '共用';
  pubRow.append(pubCb, pubSpan, pubBadge);
  menu.appendChild(pubRow);
}

    
    // 用 fixed 定位，避免被 table-wrapper overflow 裁切
    const rect = td.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = rect.bottom + 'px';
    document.body.appendChild(menu);

    // 點擊外部關閉
    const close = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  }

  function getVal(obj, key) {
    if (!key) return null;
    if (key === '_star') return Watchlist.has(obj.code) ? 1 : 0;
    return key.split('.').reduce((o, k) => o?.[k], obj) ?? null;
  }

  // 狀態徽章設定 (對齊 status_sheets.SOURCES key)
  const STATUS_BADGES = {
    vcp:     { label: 'VCP',  cls: 'badge-vcp'     },
    sanxian: { label: '三線', cls: 'badge-sanxian' }
  };

  function renderStatusBadges(td, stock) {
    const flags = stock.statusFlags;
    if (!flags) {
      td.textContent = '';
      return;
    }
    td.classList.add('cell-status');
    for (const [type, badgeCfg] of Object.entries(STATUS_BADGES)) {
      const info = flags[type];
      if (!info) continue;
      const span = document.createElement('span');
      span.className = `badge ${badgeCfg.cls}`;
      const streak = Number(info.streak) || 0;
      span.textContent = streak > 0
        ? `${badgeCfg.label}·${streak}`
        : badgeCfg.label;
      span.title = buildStatusTooltip(type, info);
      td.appendChild(span);
    }
  }

  function renderSingleBadge(td, stock, type) {
    const info = stock.statusFlags?.[type];
    if (!info) {
      td.textContent = '';
      td.classList.add('text-muted');
      return;
    }
    td.classList.add('cell-status');
    const cfg = STATUS_BADGES[type];
    const span = document.createElement('span');
    span.className = `badge ${cfg.cls}`;
    const streak = Number(info.streak) || 0;
    span.textContent = streak > 0 ? `${cfg.label}·${streak}` : cfg.label;
    span.title = buildStatusTooltip(type, info);
    td.appendChild(span);
  }

  function buildStatusTooltip(type, info) {
    const lines = [];
    const head = type === 'vcp' ? 'VCP' : '三線開花';
    lines.push(`${head} — ${info.date || ''}`.trim());
    if (info.streak != null) {
      lines.push(`連續 ${info.streak} 天 / 累計 ${info.total ?? info.streak} 天`);
    }
    if (type === 'vcp') {
      if (info.gain20)              lines.push(`近20日漲幅: ${info.gain20}`);
      if (info.marketShort === 'O') lines.push('大盤淨空 ✓');
      if (info.consecShort === 'O') lines.push('連續淨空 ✓');
    } else if (type === 'sanxian') {
      if (info.close)   lines.push(`收盤股價: ${info.close}`);
      if (info.high55)  lines.push(`55日內最高: ${info.high55}`);
      if (info.diffPct) lines.push(`差距比: ${info.diffPct}`);
    }
    return lines.join('\n');
  }

  function updateInstDays(days) {
    for (const col of STOCK_COLUMNS) {
      if (col.label.startsWith('外資')) {
        col.label = `外資${days}日`;
        col.key = `foreign_${days}d`;
      } else if (col.label.startsWith('投信')) {
        col.label = `投信${days}日`;
        col.key = `investment_${days}d`;
      } else if (col.label.startsWith('自營')) {
        col.label = `自營${days}日`;
        col.key = `dealer_${days}d`;
      } else if (col.label === '法人合計') {
        col.key = `totalInst_${days}d`;
      }
    }
  }

  function getCurrentData() { return currentData; }

  return { render, updateInstDays, getCurrentData, columns, showStarMenu };
})();
