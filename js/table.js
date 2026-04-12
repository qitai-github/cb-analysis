// 表格渲染模組
const Table = (() => {
  let currentData = [];
  let currentSort = { key: 'code', asc: true };
  let currentPage = 0;
  let onRowClick = null;

  const columns = [
    { key: '_star', label: '\u2606', width: '36px', sticky: true, format: 'star', noSort: false },
    { key: 'code', label: '代碼', width: '70px', sticky: true },
    { key: 'name', label: '名稱', width: '100px', sticky: true },
    { key: 'industryCategory', label: '產業分類', width: '140px', format: 'industry' },
    { key: 'latestClose', label: '收盤價', width: '75px', format: 'price', align: 'right' },
    { key: 'priceChangePercent', label: '漲跌%', width: '70px', format: 'percent_color', align: 'right' },
    { key: 'latestVolume', label: '成交量(張)', width: '85px', format: 'volume', align: 'right' },
    { key: 'foreign_1d', label: '外資1日', width: '85px', format: 'inst', align: 'right' },
    { key: 'investment_1d', label: '投信1日', width: '85px', format: 'inst', align: 'right' },
    { key: 'dealer_1d', label: '自營1日', width: '85px', format: 'inst', align: 'right' },
    { key: 'totalInst_1d', label: '法人合計', width: '85px', format: 'inst', align: 'right' },
    { key: 'mainCB.cbCode', label: 'CB代碼', width: '75px' },
    { key: 'mainCB.close', label: 'CB價格', width: '75px', format: 'price', align: 'right' },
    { key: 'mainCB.change', label: 'CB漲跌', width: '70px', format: 'change_color', align: 'right' },
    { key: 'conversionPrice', label: '轉換價', width: '75px', format: 'price', align: 'right' },
    { key: 'cbPremiumRate', label: 'CB溢價%', width: '80px', format: 'percent_color', align: 'right' },
    { key: 'conversionPeriod', label: '轉換日期(起)', width: '100px' }
  ];

  function render(containerId, data, options = {}) {
    currentData = data;
    if (options.onRowClick) onRowClick = options.onRowClick;

    const container = document.getElementById(containerId);
    container.innerHTML = '';

    const stats = document.createElement('div');
    stats.className = 'table-stats';
    stats.textContent = `共 ${data.length} 檔標的`;
    container.appendChild(stats);

    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrapper';

    const table = document.createElement('table');
    table.className = 'data-table';

    // 表頭
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of columns) {
      const th = document.createElement('th');
      th.textContent = col.label;
      th.style.width = col.width;
      th.style.minWidth = col.width;
      if (col.sticky) th.className = 'sticky-col';
      if (col.align === 'right') th.classList.add('text-right');
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
    const end = Math.min(start + pageSize, data.length);

    for (let i = start; i < end; i++) {
      const stock = data[i];
      const tr = document.createElement('tr');
      tr.addEventListener('click', () => { if (onRowClick) onRowClick(stock); });

      for (const col of columns) {
        const td = document.createElement('td');
        if (col.sticky) td.className = 'sticky-col';
        if (col.align === 'right') td.classList.add('text-right');
        const val = getVal(stock, col.key);
        formatCell(td, val, col.format, stock);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);
    container.appendChild(wrapper);

    if (data.length > pageSize) {
      container.appendChild(createPager(data.length, pageSize, containerId));
    }
  }

  function handleSort(key, containerId) {
    if (currentSort.key === key) {
      currentSort.asc = !currentSort.asc;
    } else {
      currentSort = { key, asc: true };
    }
    currentPage = 0;
    currentData = Filters.sortResults(currentData, key, currentSort.asc);
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
      mkBtn('\u29EA', () => { currentPage = 0; render(containerId, currentData); }, currentPage === 0),
      mkBtn('\u25C2', () => { currentPage--; render(containerId, currentData); }, currentPage === 0),
      mkBtn('\u25B8', () => { currentPage++; render(containerId, currentData); }, currentPage >= totalPages - 1),
      mkBtn('\u29EB', () => { currentPage = totalPages - 1; render(containerId, currentData); }, currentPage >= totalPages - 1)
    );
    pager.appendChild(btnGroup);
    return pager;
  }

  function formatCell(td, val, format, stock) {
    if (format === 'star') {
      const starred = Watchlist.has(stock.code);
      td.textContent = starred ? '\u2605' : '\u2606';
      td.style.cursor = 'pointer';
      td.style.fontSize = '16px';
      td.style.textAlign = 'center';
      td.style.color = starred ? '#f59e0b' : 'var(--text-dim)';
      td.addEventListener('click', (e) => {
        e.stopPropagation();
        showStarMenu(td, stock.code);
      });
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
      default:
        td.textContent = String(val);
    }
  }

  function fmtVol(v) {
    const sign = v < 0 ? '-' : '';
    return sign + Math.abs(v).toLocaleString();
  }

  function updateStarCell(td, code) {
    const starred = Watchlist.has(code);
    td.textContent = starred ? '\u2605' : '\u2606';
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

  function updateInstDays(days) {
    columns[7].label = `外資${days}日`;
    columns[7].key = `foreign_${days}d`;
    columns[8].label = `投信${days}日`;
    columns[8].key = `investment_${days}d`;
    columns[9].label = `自營${days}日`;
    columns[9].key = `dealer_${days}d`;
    columns[10].key = `totalInst_${days}d`;
  }

  function getCurrentData() { return currentData; }

  return { render, updateInstDays, getCurrentData, columns };
})();
