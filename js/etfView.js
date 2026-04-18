// ETF 持股分析模組 — 7 欄佈局，每日變動比對
const ETFView = (() => {
  let etfData = null;
  let cbStockMap = null;       // stockCode → [cb, ...]
  let currentFilters = { onlyCB: false, keyword: '', showUnchanged: {} };
  const ETF_STATIC_URL = 'data/etf-holdings.json';

  // ETF 顯示順序
  const ETF_ORDER = ['00891', '00881', '00991A', '00981A', '00988A', '00982A', '00992A'];

  async function loadData() {
    if (etfData) return etfData;
    try {
      const resp = await fetch(ETF_STATIC_URL);
      etfData = await resp.json();
      return etfData;
    } catch (err) {
      console.error('[ETFView] 載入 ETF 資料失敗:', err);
      return null;
    }
  }

  function setCBData(cbIssuance) {
    cbStockMap = new Map();
    if (!cbIssuance) return;
    for (const cb of cbIssuance) {
      if (!cb.stockCode) continue;
      if (!cbStockMap.has(cb.stockCode)) cbStockMap.set(cb.stockCode, []);
      cbStockMap.get(cb.stockCode).push(cb);
    }
  }

  function getETFCodes() {
    if (!etfData || !etfData.etfs) return [];
    return ETF_ORDER.filter(c => etfData.etfs[c]);
  }

  /** 篩選單一 ETF 的持股 */
  function filterHoldings(holdings) {
    if (!holdings) return [];
    let list = holdings;

    if (currentFilters.onlyCB && cbStockMap) {
      list = list.filter(h => cbStockMap.has(h.code));
    }

    if (currentFilters.keyword) {
      const q = currentFilters.keyword.toLowerCase();
      list = list.filter(h =>
        h.code.toLowerCase().includes(q) ||
        (h.name || '').toLowerCase().includes(q)
      );
    }

    return list;
  }

  /** 排序持股：added/removed → increased/decreased → unchanged */
  function sortHoldings(holdings) {
    const priority = { added: 0, removed: 1, increased: 2, decreased: 3, unchanged: 4 };
    return [...holdings].sort((a, b) => {
      const pa = priority[a.change] ?? 4;
      const pb = priority[b.change] ?? 4;
      if (pa !== pb) return pa - pb;
      // 同類別按權重降序
      return (b.weight || 0) - (a.weight || 0);
    });
  }

  /** 建立篩選面板 */
  function buildFilterPanel(containerId) {
    const panel = document.getElementById(containerId);
    panel.innerHTML = '';

    // 搜尋
    const searchRow = document.createElement('div');
    searchRow.className = 'filter-search';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'filter-input';
    searchInput.placeholder = '搜尋代碼或名稱...';
    searchInput.id = 'etf-filter-keyword';
    searchInput.value = currentFilters.keyword;
    searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyAndRender(); });
    searchRow.appendChild(searchInput);
    panel.appendChild(searchRow);

    // CB 篩選
    const cbGroup = document.createElement('div');
    cbGroup.className = 'filter-group';
    const cbTitle = document.createElement('div');
    cbTitle.className = 'filter-group-title';
    cbTitle.textContent = 'CB 交叉比對';
    cbTitle.addEventListener('click', () => cbGroup.classList.toggle('collapsed'));
    cbGroup.appendChild(cbTitle);

    const cbContent = document.createElement('div');
    cbContent.className = 'filter-group-content';
    const cbLabel = document.createElement('label');
    cbLabel.className = 'filter-checkbox';
    const cbCheck = document.createElement('input');
    cbCheck.type = 'checkbox';
    cbCheck.id = 'etf-filter-onlyCB';
    cbCheck.checked = currentFilters.onlyCB;
    cbCheck.addEventListener('change', applyAndRender);
    cbLabel.appendChild(cbCheck);
    const cbSpan = document.createElement('span');
    cbSpan.textContent = '只顯示有 CB 的持股';
    cbLabel.appendChild(cbSpan);
    cbContent.appendChild(cbLabel);

    if (cbStockMap) {
      const allCodes = new Set();
      for (const code of getETFCodes()) {
        const etf = etfData.etfs[code];
        if (etf?.holdings) etf.holdings.forEach(h => allCodes.add(h.code));
      }
      const cbCount = [...allCodes].filter(c => cbStockMap.has(c)).length;
      const info = document.createElement('div');
      info.className = 'text-muted';
      info.style.fontSize = '11px';
      info.style.marginTop = '4px';
      info.textContent = `共 ${cbCount} 檔持股有對應 CB`;
      cbContent.appendChild(info);
    }

    cbGroup.appendChild(cbContent);
    panel.appendChild(cbGroup);

    // ETF 概覽
    const overviewGroup = document.createElement('div');
    overviewGroup.className = 'filter-group';
    const overviewTitle = document.createElement('div');
    overviewTitle.className = 'filter-group-title';
    overviewTitle.textContent = 'ETF 概覽';
    overviewTitle.addEventListener('click', () => overviewGroup.classList.toggle('collapsed'));
    overviewGroup.appendChild(overviewTitle);

    const overviewContent = document.createElement('div');
    overviewContent.className = 'filter-group-content';
    for (const code of getETFCodes()) {
      const etf = etfData.etfs[code];
      const changes = etf.changes || {};
      const row = document.createElement('div');
      row.style.cssText = 'font-size:11px;padding:3px 0;border-bottom:1px solid var(--border-dim);';

      let changeText = '';
      if (changes.added || changes.removed || changes.increased || changes.decreased) {
        const parts = [];
        if (changes.added) parts.push(`<span style="color:#22c55e">+${changes.added}</span>`);
        if (changes.removed) parts.push(`<span style="color:#ef4444">-${changes.removed}</span>`);
        if (changes.increased) parts.push(`<span style="color:#22c55e">↑${changes.increased}</span>`);
        if (changes.decreased) parts.push(`<span style="color:#ef4444">↓${changes.decreased}</span>`);
        changeText = parts.join(' ');
      }

      row.innerHTML = `<div style="display:flex;justify-content:space-between">
        <span style="color:var(--accent)">${code}</span>
        <span style="color:var(--text-muted)">${etf.holdingCount}檔 | $${etf.navPerUnit?.toFixed(2) || '-'}</span>
      </div>
      ${changeText ? `<div style="margin-top:1px">${changeText}</div>` : ''}
      <div style="color:var(--text-dim);font-size:10px">${etf.date || '-'}${etf.prevDate ? ' ← ' + etf.prevDate : ''}</div>`;
      overviewContent.appendChild(row);
    }
    overviewGroup.appendChild(overviewContent);
    panel.appendChild(overviewGroup);

    // 變動圖例
    const legendGroup = document.createElement('div');
    legendGroup.className = 'filter-group';
    const legendTitle = document.createElement('div');
    legendTitle.className = 'filter-group-title';
    legendTitle.textContent = '變動圖例';
    legendTitle.addEventListener('click', () => legendGroup.classList.toggle('collapsed'));
    legendGroup.appendChild(legendTitle);

    const legendContent = document.createElement('div');
    legendContent.className = 'filter-group-content';
    legendContent.innerHTML = `
      <div style="font-size:11px;line-height:1.8">
        <span class="etf-change-badge etf-change-added">新增</span> 新增持股<br>
        <span class="etf-change-badge etf-change-removed">刪除</span> 移除持股<br>
        <span class="etf-change-badge etf-change-increased">↑</span> 權重增加<br>
        <span class="etf-change-badge etf-change-decreased">↓</span> 權重減少<br>
        <span style="color:var(--text-dim)">其餘為未變動</span>
      </div>`;
    legendGroup.appendChild(legendContent);
    panel.appendChild(legendGroup);

    // 按鈕
    const btnRow = document.createElement('div');
    btnRow.className = 'filter-buttons';
    const btnApply = document.createElement('button');
    btnApply.textContent = '套用篩選';
    btnApply.className = 'btn btn-primary';
    btnApply.addEventListener('click', () => {
      applyAndRender();
      document.getElementById('filter-panel').classList.remove('mobile-open');
      const bd = document.getElementById('mobile-filter-backdrop');
      if (bd) bd.classList.remove('show');
    });
    const btnReset = document.createElement('button');
    btnReset.textContent = '清除條件';
    btnReset.className = 'btn btn-secondary';
    btnReset.addEventListener('click', () => {
      currentFilters = { onlyCB: false, keyword: '', showUnchanged: {} };
      buildFilterPanel(containerId);
      applyAndRender();
    });
    btnRow.append(btnApply, btnReset);
    panel.appendChild(btnRow);
  }

  function readFilterValues() {
    const kwEl = document.getElementById('etf-filter-keyword');
    if (kwEl) currentFilters.keyword = kwEl.value.trim();
    const cbEl = document.getElementById('etf-filter-onlyCB');
    if (cbEl) currentFilters.onlyCB = cbEl.checked;
  }

  function applyAndRender() {
    readFilterValues();
    renderColumns('main-table');
  }

  /** 渲染 7 欄 ETF 持股 */
  function renderColumns(containerId) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    const codes = getETFCodes();
    if (!codes.length) {
      container.innerHTML = '<div class="text-muted" style="padding:40px;text-align:center">無 ETF 資料</div>';
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'etf-columns-wrapper';

    for (const code of codes) {
      const etf = etfData.etfs[code];
      const col = buildETFColumn(code, etf);
      wrapper.appendChild(col);
    }

    container.appendChild(wrapper);
  }

  /** 建立單一 ETF 欄 */
  function buildETFColumn(etfCode, etf) {
    const col = document.createElement('div');
    col.className = 'etf-column';

    // 表頭
    const header = document.createElement('div');
    header.className = 'etf-column-header';
    const changes = etf.changes || {};
    let changeSummary = '';
    if (changes.added || changes.removed) {
      const parts = [];
      if (changes.added) parts.push(`<span style="color:#22c55e">+${changes.added}</span>`);
      if (changes.removed) parts.push(`<span style="color:#ef4444">-${changes.removed}</span>`);
      changeSummary = ` ${parts.join(' ')}`;
    }

    header.innerHTML = `
      <div class="etf-column-title">${etfCode}</div>
      <div class="etf-column-subtitle">${etf.name}</div>
      <div class="etf-column-meta">${etf.holdingCount}檔${changeSummary} | ${etf.date || '-'}</div>`;
    col.appendChild(header);

    // 篩選 & 排序持股
    let holdings = filterHoldings(etf.holdings || []);
    holdings = sortHoldings(holdings);

    // 分類：changed (added/removed/increased/decreased) vs unchanged
    const changedItems = holdings.filter(h => h.change && h.change !== 'unchanged');
    const unchangedItems = holdings.filter(h => !h.change || h.change === 'unchanged');

    // 表格
    const table = document.createElement('table');
    table.className = 'etf-col-table';

    // 表頭
    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
      <th>代碼</th>
      <th>名稱</th>
      <th class="num">股數</th>
      <th class="num">權重%</th>
    </tr>`;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    // 渲染有變動的
    for (const h of changedItems) {
      tbody.appendChild(buildHoldingRow(h, etfCode));
    }

    // 分隔線 + 展開按鈕
    if (unchangedItems.length > 0) {
      const showKey = etfCode;
      const isShown = currentFilters.showUnchanged[showKey];

      const sepRow = document.createElement('tr');
      sepRow.className = 'etf-unchanged-sep';
      const sepTd = document.createElement('td');
      sepTd.colSpan = 4;
      const sepBtn = document.createElement('button');
      sepBtn.className = 'etf-unchanged-btn';
      sepBtn.textContent = isShown
        ? `收合未變動 (${unchangedItems.length}檔)`
        : `展開未變動 (${unchangedItems.length}檔)`;
      sepBtn.addEventListener('click', () => {
        currentFilters.showUnchanged[showKey] = !currentFilters.showUnchanged[showKey];
        renderColumns('main-table');
      });
      sepTd.appendChild(sepBtn);
      sepRow.appendChild(sepTd);
      tbody.appendChild(sepRow);

      if (isShown) {
        for (const h of unchangedItems) {
          tbody.appendChild(buildHoldingRow(h, etfCode));
        }
      }
    }

    // 如果完全沒有資料
    if (changedItems.length === 0 && unchangedItems.length === 0) {
      const emptyRow = document.createElement('tr');
      emptyRow.innerHTML = '<td colspan="4" style="text-align:center;color:var(--text-dim);padding:20px">無符合條件的持股</td>';
      tbody.appendChild(emptyRow);
    }

    table.appendChild(tbody);
    col.appendChild(table);

    return col;
  }

  /** 建立單筆持股列 */
  function buildHoldingRow(h, etfCode) {
    const tr = document.createElement('tr');
    const hasCB = cbStockMap?.has(h.code);
    const change = h.change || 'unchanged';

    tr.className = `etf-row-${change}`;

    // 代碼
    const tdCode = document.createElement('td');
    tdCode.className = 'etf-cell-code';
    let codeHTML = h.code;

    // 變動標記
    if (change === 'added') {
      codeHTML = `<span class="etf-change-badge etf-change-added">新</span>${h.code}`;
    } else if (change === 'removed') {
      codeHTML = `<span class="etf-change-badge etf-change-removed">刪</span><s>${h.code}</s>`;
    } else if (change === 'increased') {
      codeHTML = `<span class="etf-change-badge etf-change-increased">↑</span>${h.code}`;
    } else if (change === 'decreased') {
      codeHTML = `<span class="etf-change-badge etf-change-decreased">↓</span>${h.code}`;
    }

    // CB 標記
    if (hasCB) {
      const cbList = cbStockMap.get(h.code);
      codeHTML += `<span class="etf-cb-badge" title="${cbList.map(c => c.cbCode).join(', ')}">${cbList.length}</span>`;
    }

    tdCode.innerHTML = codeHTML;
    tr.appendChild(tdCode);

    // 名稱
    const tdName = document.createElement('td');
    tdName.className = 'etf-cell-name';
    tdName.textContent = h.name || '';
    tdName.title = h.name || '';
    tr.appendChild(tdName);

    // 股數
    const tdShares = document.createElement('td');
    tdShares.className = 'num';
    if (h.shares != null) {
      tdShares.textContent = Math.round(h.shares).toLocaleString();
    } else {
      tdShares.textContent = '-';
      tdShares.style.color = 'var(--text-dim)';
    }
    tr.appendChild(tdShares);

    // 權重
    const tdWeight = document.createElement('td');
    tdWeight.className = 'num';
    if (h.weight != null) {
      let weightText = h.weight.toFixed(2) + '%';
      if (h.prevWeight != null && change !== 'added') {
        const diff = h.weight - h.prevWeight;
        if (Math.abs(diff) >= 0.005) {
          const sign = diff > 0 ? '+' : '';
          weightText += ` <span class="${diff > 0 ? 'text-up' : 'text-down'}" style="font-size:10px">(${sign}${diff.toFixed(2)})</span>`;
        }
      }
      tdWeight.innerHTML = weightText;
      if (h.weight >= 10) tdWeight.style.color = '#f59e0b';
      else if (h.weight >= 5) tdWeight.style.color = 'var(--accent)';
    } else if (change === 'removed' && h.prevWeight != null) {
      tdWeight.innerHTML = `<s style="color:var(--text-dim)">${h.prevWeight.toFixed(2)}%</s>`;
    } else {
      tdWeight.textContent = '-';
      tdWeight.style.color = 'var(--text-dim)';
    }
    tr.appendChild(tdWeight);

    // 點擊顯示詳情
    if (hasCB) {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => {
        const cbList = cbStockMap.get(h.code);
        showETFStockDetail(h, cbList, etfCode);
      });
    }

    return tr;
  }

  /** 顯示持股詳情 (CB 資訊) */
  function showETFStockDetail(item, cbList, etfCode) {
    const panel = document.getElementById('detail-panel');
    panel.classList.add('show');

    document.getElementById('detail-title').textContent = `${item.code} ${item.name}`;

    // ETF 持股資訊
    const priceInfo = document.getElementById('detail-price-info');
    let html = '<div class="info-grid">';

    // 所有 ETF 中此股票的權重
    for (const code of getETFCodes()) {
      const etf = etfData.etfs[code];
      if (!etf?.holdings) continue;
      const h = etf.holdings.find(x => x.code === item.code);
      if (h && h.weight != null) {
        let weightDisplay = h.weight.toFixed(2) + '%';
        if (h.prevWeight != null && h.change !== 'added') {
          const diff = h.weight - h.prevWeight;
          if (Math.abs(diff) >= 0.005) {
            const sign = diff > 0 ? '+' : '';
            const cls = diff > 0 ? 'text-up' : 'text-down';
            weightDisplay += ` <span class="${cls}">(${sign}${diff.toFixed(2)})</span>`;
          }
        }
        html += `<div class="info-item">
          <span class="info-label">${code} ${etf.name.substring(0, 4)}</span>
          <span class="info-value">${weightDisplay}</span>
        </div>`;
      }
    }

    html += '</div>';
    priceInfo.innerHTML = html;

    // CB 資訊
    const cbInfo = document.getElementById('detail-cb-info');
    if (cbList && cbList.length > 0) {
      let cbHtml = '<div class="cb-list">';
      for (const cb of cbList) {
        const f = (label, val) => val != null && val !== '' ? `<div class="info-item"><span class="info-label">${label}</span><span class="info-value">${val}</span></div>` : '';
        cbHtml += `<div class="cb-card">
          <div class="cb-card-header">
            <span class="cb-code">${cb.cbCode}</span>
            <span class="cb-name">${cb.title?.substring(0, 20) || ''}</span>
          </div>
          <div class="info-grid info-grid-sm">
            ${f('轉換價', cb.conversionPrice)}
            ${f('發行轉換價', cb.issueConversionPrice)}
            ${f('到期日', cb.maturityDate)}
            ${f('賣回權日', cb.nextPutDate)}
            ${f('轉換期間', cb.conversionPeriod)}
          </div>
        </div>`;
      }
      cbHtml += '</div>';
      cbInfo.innerHTML = cbHtml;
    } else {
      cbInfo.innerHTML = '<div class="text-muted">無 CB 資料</div>';
    }

    // 清空其他 detail 區塊
    document.getElementById('detail-inst-info').innerHTML = '';
    document.getElementById('detail-cb-inst-info').innerHTML = '';
    document.getElementById('detail-news-info').innerHTML = '';

    const chartIds = ['detail-price-chart', 'detail-cb-price-chart'];
    for (const id of chartIds) {
      const canvas = document.getElementById(id);
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }

  /** 取得統計資訊 */
  function getStats() {
    if (!etfData) return { etfCount: 0, totalStocks: 0 };
    return {
      etfCount: etfData._meta?.etfCount || 0,
      totalStocks: etfData._meta?.totalStocks || 0
    };
  }

  return {
    loadData,
    setCBData,
    buildFilterPanel,
    renderColumns,
    getETFCodes,
    getStats,
  };
})();
