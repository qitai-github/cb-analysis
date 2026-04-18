// ETF 持股分析模組
const ETFView = (() => {
  let etfData = null;       // 原始 ETF JSON 資料
  let mergedList = [];       // 合併後的持股清單 (用於排序/篩選)
  let cbStockCodes = null;   // CB 對應的股票代碼集合
  let currentSort = { key: 'count', asc: false };
  let currentFilters = { etfs: {}, onlyCB: false, keyword: '' };

  const ETF_STATIC_URL = 'data/etf-holdings.json';

  async function loadData() {
    if (etfData) return etfData;
    try {
      const resp = await fetch(ETF_STATIC_URL);
      etfData = await resp.json();
      buildMergedList();
      return etfData;
    } catch (err) {
      console.error('[ETFView] 載入 ETF 資料失敗:', err);
      return null;
    }
  }

  /** 從 CB 資料建立 stockCode 集合，用於交叉比對 */
  function setCBData(cbIssuance) {
    cbStockCodes = new Map();
    if (!cbIssuance) return;
    for (const cb of cbIssuance) {
      if (!cb.stockCode) continue;
      if (!cbStockCodes.has(cb.stockCode)) {
        cbStockCodes.set(cb.stockCode, []);
      }
      cbStockCodes.get(cb.stockCode).push(cb);
    }
  }

  function buildMergedList() {
    if (!etfData || !etfData.merged) return;
    mergedList = Object.entries(etfData.merged).map(([code, info]) => ({
      code,
      name: info.name,
      etfs: info.etfs,
      count: info.count,
    }));
  }

  /** 取得 ETF 代碼列表 */
  function getETFList() {
    if (!etfData || !etfData.etfs) return [];
    return Object.entries(etfData.etfs).map(([code, info]) => ({
      code,
      name: info.name,
      date: info.date,
      holdingCount: info.holdingCount,
      navPerUnit: info.navPerUnit,
    }));
  }

  /** 篩選 + 排序 */
  function getFilteredData() {
    if (!mergedList.length) return [];

    // 選取的 ETF (未勾選任何等於全選)
    const selectedETFs = Object.entries(currentFilters.etfs)
      .filter(([, checked]) => checked)
      .map(([code]) => code);
    const hasETFFilter = selectedETFs.length > 0;

    let list = mergedList.filter(item => {
      // ETF 勾選篩選
      if (hasETFFilter) {
        const hasAny = selectedETFs.some(etf => item.etfs[etf] != null);
        if (!hasAny) return false;
      }

      // 只顯示有 CB 的
      if (currentFilters.onlyCB && cbStockCodes) {
        if (!cbStockCodes.has(item.code)) return false;
      }

      // 關鍵字
      if (currentFilters.keyword) {
        const q = currentFilters.keyword.toLowerCase();
        if (!item.code.includes(q) && !(item.name || '').toLowerCase().includes(q)) return false;
      }

      return true;
    });

    // 排序
    const { key, asc } = currentSort;
    list.sort((a, b) => {
      let va, vb;
      if (key === 'code') { va = a.code; vb = b.code; }
      else if (key === 'name') { va = a.name; vb = b.name; }
      else if (key === 'count') { va = a.count; vb = b.count; }
      else if (key === 'hasCB') {
        va = cbStockCodes?.has(a.code) ? 1 : 0;
        vb = cbStockCodes?.has(b.code) ? 1 : 0;
      } else if (key.startsWith('etf_')) {
        const etfCode = key.substring(4);
        va = a.etfs[etfCode] ?? -1;
        vb = b.etfs[etfCode] ?? -1;
      } else { va = 0; vb = 0; }

      if (typeof va === 'string') {
        const cmp = va.localeCompare(vb);
        return asc ? cmp : -cmp;
      }
      return asc ? va - vb : vb - va;
    });

    return list;
  }

  /** 建立 ETF 篩選面板 */
  function buildFilterPanel(containerId) {
    const panel = document.getElementById(containerId);
    panel.innerHTML = '';

    const etfs = getETFList();

    // 關鍵字搜尋
    const searchRow = document.createElement('div');
    searchRow.className = 'filter-search';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'filter-input';
    searchInput.placeholder = '搜尋代碼或名稱...';
    searchInput.id = 'etf-filter-keyword';
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyAndRender(); });
    searchRow.appendChild(searchInput);
    panel.appendChild(searchRow);

    // ETF 選擇
    const etfGroup = document.createElement('div');
    etfGroup.className = 'filter-group';
    const etfTitle = document.createElement('div');
    etfTitle.className = 'filter-group-title';
    etfTitle.textContent = 'ETF 選擇';
    etfTitle.addEventListener('click', () => etfGroup.classList.toggle('collapsed'));
    etfGroup.appendChild(etfTitle);

    const etfContent = document.createElement('div');
    etfContent.className = 'filter-group-content';

    for (const etf of etfs) {
      const label = document.createElement('label');
      label.className = 'filter-checkbox';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `etf-check-${etf.code}`;
      cb.checked = currentFilters.etfs[etf.code] || false;
      cb.addEventListener('change', applyAndRender);
      label.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = `${etf.code} ${etf.name}`;
      span.style.fontSize = '12px';
      label.appendChild(span);
      etfContent.appendChild(label);
    }

    etfGroup.appendChild(etfContent);
    panel.appendChild(etfGroup);

    // CB 交叉比對
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

    if (cbStockCodes) {
      const cbInfo = document.createElement('div');
      cbInfo.className = 'text-muted';
      cbInfo.style.fontSize = '11px';
      cbInfo.style.marginTop = '4px';
      const cbCount = mergedList.filter(m => cbStockCodes.has(m.code)).length;
      cbInfo.textContent = `共 ${cbCount} 檔持股有對應 CB`;
      cbContent.appendChild(cbInfo);
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
    for (const etf of etfs) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;padding:2px 0;';
      row.innerHTML = `<span style="color:var(--accent)">${etf.code}</span>
        <span style="color:var(--text-muted)">${etf.holdingCount}檔 | $${etf.navPerUnit?.toFixed(2) || '-'}</span>`;
      overviewContent.appendChild(row);
    }
    overviewGroup.appendChild(overviewContent);
    panel.appendChild(overviewGroup);

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
      currentFilters = { etfs: {}, onlyCB: false, keyword: '' };
      buildFilterPanel(containerId);
      applyAndRender();
    });
    btnRow.append(btnApply, btnReset);
    panel.appendChild(btnRow);
  }

  function readFilterValues() {
    const etfs = getETFList();
    for (const etf of etfs) {
      const el = document.getElementById(`etf-check-${etf.code}`);
      if (el) currentFilters.etfs[etf.code] = el.checked;
    }
    const kwEl = document.getElementById('etf-filter-keyword');
    if (kwEl) currentFilters.keyword = kwEl.value.trim();
    const cbEl = document.getElementById('etf-filter-onlyCB');
    if (cbEl) currentFilters.onlyCB = cbEl.checked;
  }

  function applyAndRender() {
    readFilterValues();
    renderTable('main-table');
  }

  /** 渲染 ETF 持股表格 */
  function renderTable(containerId) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    const data = getFilteredData();
    const etfList = getETFList();

    // 選取的 ETF (未勾選任何等於全顯示)
    const selectedETFs = Object.entries(currentFilters.etfs)
      .filter(([, checked]) => checked)
      .map(([code]) => code);
    const displayETFs = selectedETFs.length > 0
      ? etfList.filter(e => selectedETFs.includes(e.code))
      : etfList;

    // 統計
    const stats = document.createElement('div');
    stats.className = 'table-stats';
    stats.textContent = `共 ${data.length} 檔持股`;
    container.appendChild(stats);

    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrapper';

    const table = document.createElement('table');
    table.className = 'data-table etf-table';

    // 表頭
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    const fixedCols = [
      { key: 'code', label: '代碼', width: '70px', sticky: true },
      { key: 'name', label: '名稱', width: '100px', sticky: true },
      { key: 'count', label: '持有ETF數', width: '80px' },
      { key: 'hasCB', label: 'CB', width: '50px' },
    ];

    for (const col of fixedCols) {
      const th = document.createElement('th');
      th.textContent = col.label;
      th.style.width = col.width;
      th.style.minWidth = col.width;
      if (col.sticky) th.className = 'sticky-col';
      th.style.cursor = 'pointer';
      th.dataset.sortKey = col.key;
      if (currentSort.key === col.key) {
        th.classList.add(currentSort.asc ? 'sort-asc' : 'sort-desc');
      }
      th.addEventListener('click', () => handleSort(col.key));
      headerRow.appendChild(th);
    }

    // ETF 欄位
    for (const etf of displayETFs) {
      const th = document.createElement('th');
      th.innerHTML = `<div style="font-size:10px;line-height:1.2">${etf.code}<br>${etf.name.substring(0, 4)}</div>`;
      th.style.width = '80px';
      th.style.minWidth = '80px';
      th.style.textAlign = 'right';
      th.style.cursor = 'pointer';
      th.dataset.sortKey = 'etf_' + etf.code;
      if (currentSort.key === 'etf_' + etf.code) {
        th.classList.add(currentSort.asc ? 'sort-asc' : 'sort-desc');
      }
      th.addEventListener('click', () => handleSort('etf_' + etf.code));
      headerRow.appendChild(th);
    }

    thead.appendChild(headerRow);
    table.appendChild(thead);

    // 表身
    const tbody = document.createElement('tbody');
    for (const item of data) {
      const tr = document.createElement('tr');
      const hasCB = cbStockCodes?.has(item.code);
      const cbList = hasCB ? cbStockCodes.get(item.code) : [];

      // 代碼
      const tdCode = document.createElement('td');
      tdCode.className = 'sticky-col';
      tdCode.textContent = item.code;
      tdCode.style.fontWeight = '600';
      if (hasCB) tdCode.style.color = 'var(--accent)';
      tr.appendChild(tdCode);

      // 名稱
      const tdName = document.createElement('td');
      tdName.className = 'sticky-col';
      tdName.textContent = item.name;
      tdName.style.maxWidth = '100px';
      tdName.style.overflow = 'hidden';
      tdName.style.textOverflow = 'ellipsis';
      tr.appendChild(tdName);

      // 持有 ETF 數
      const tdCount = document.createElement('td');
      tdCount.textContent = item.count;
      tdCount.style.textAlign = 'center';
      if (item.count >= 4) tdCount.style.color = 'var(--accent)';
      tr.appendChild(tdCount);

      // CB 標記
      const tdCB = document.createElement('td');
      if (hasCB) {
        tdCB.innerHTML = `<span class="etf-cb-badge" title="${cbList.map(c => c.cbCode + ' 轉換價:' + c.conversionPrice).join('\n')}">${cbList.length}</span>`;
      } else {
        tdCB.textContent = '-';
        tdCB.style.color = 'var(--text-dim)';
      }
      tdCB.style.textAlign = 'center';
      tr.appendChild(tdCB);

      // 各 ETF 權重
      for (const etf of displayETFs) {
        const td = document.createElement('td');
        td.style.textAlign = 'right';
        const weight = item.etfs[etf.code];
        if (weight != null) {
          td.textContent = weight.toFixed(2) + '%';
          // 權重越高顏色越深
          if (weight >= 10) td.style.color = '#f59e0b';
          else if (weight >= 5) td.style.color = 'var(--accent)';
          else td.style.color = 'var(--text)';
        } else {
          td.textContent = '-';
          td.style.color = 'var(--text-dim)';
        }
        tr.appendChild(td);
      }

      // 點擊展開 CB 詳情
      if (hasCB) {
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => showETFStockDetail(item, cbList));
      }

      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    wrapper.appendChild(table);
    container.appendChild(wrapper);
  }

  function handleSort(key) {
    if (currentSort.key === key) {
      currentSort.asc = !currentSort.asc;
    } else {
      currentSort = { key, asc: key === 'code' || key === 'name' };
    }
    renderTable('main-table');
  }

  /** 顯示 ETF 持股的詳細資訊（包含 CB 資訊） */
  function showETFStockDetail(item, cbList) {
    const panel = document.getElementById('detail-panel');
    panel.classList.add('show');

    document.getElementById('detail-title').textContent = `${item.code} ${item.name}`;

    // 股價資訊 — 此處簡化顯示 ETF 持股資訊
    const priceInfo = document.getElementById('detail-price-info');
    let html = '<div class="info-grid">';
    const etfList = getETFList();
    for (const etf of etfList) {
      const w = item.etfs[etf.code];
      if (w != null) {
        html += `<div class="info-item">
          <span class="info-label">${etf.code} ${etf.name.substring(0, 4)}</span>
          <span class="info-value" style="color:var(--accent)">${w.toFixed(2)}%</span>
        </div>`;
      }
    }
    html += `<div class="info-item">
      <span class="info-label">持有 ETF 數</span>
      <span class="info-value">${item.count}</span>
    </div>`;
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

    // 清空 chart
    const chartIds = ['detail-price-chart', 'detail-cb-price-chart'];
    for (const id of chartIds) {
      const canvas = document.getElementById(id);
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }

  return {
    loadData,
    setCBData,
    buildFilterPanel,
    renderTable,
    getETFList,
    getFilteredData,
  };
})();
