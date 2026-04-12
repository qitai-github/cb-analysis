// 主應用程式
const App = (() => {
  let stockMap = null;
  let filteredData = [];
  let selectedStock = null;
  let latestDataDate = '';

  async function init() {
    showLoading(true);

    // 嘗試從 localStorage 快取載入（瞬間顯示）
    const cached = SheetsAPI.loadFromStorage();
    if (cached) {
      updateStatus('從快取載入...');
      const result = DataProcessor.mergeAllData(cached.data);
      stockMap = result.stockMap;
      latestDataDate = result.latestDataDate;
      updateDateDisplay();
      showLoading(false);
      buildFilterPanel();
      applyCurrentFilters();
      // 背景靜默更新
      silentRefresh();
      return;
    }

    updateStatus('正在載入資料...');

    try {
      const rawResults = await SheetsAPI.loadAll((loaded, total, name) => {
        updateStatus(`載入中 (${loaded}/${total}): ${name}`);
      });

      updateStatus('正在處理資料...');
      const result = DataProcessor.mergeAllData(rawResults);
      stockMap = result.stockMap;
      latestDataDate = result.latestDataDate;

      // 顯示更新日期
      updateDateDisplay();

      showLoading(false);

      // 顯示載入結果
      const errors = rawResults._errors || [];
      if (errors.length > 0) {
        document.getElementById('header-status').textContent =
          `共 ${stockMap.size} 檔標的 (${errors.join('、')} 載入失敗)`;
        document.getElementById('header-status').style.color = '#f59e0b';
      } else {
        document.getElementById('header-status').textContent = `共 ${stockMap.size} 檔標的`;
      }

      applyCurrentFilters();
      buildFilterPanel();

      // 畫面顯示後才背景存快取（不卡 UI）
      setTimeout(() => SheetsAPI.saveToStorage(rawResults), 100);

    } catch (err) {
      console.error('初始化失敗:', err);
      updateStatus('載入失敗: ' + err.message);
      showLoading(false);
    }
  }

  function updateDateDisplay() {
    const el = document.getElementById('header-date');
    if (!el) return;
    if (latestDataDate) {
      const d = String(latestDataDate).replace(/\//g, '').replace(/-/g, '');
      if (d.length >= 8) {
        el.textContent = `資料日期: ${d.substring(0, 4)}/${d.substring(4, 6)}/${d.substring(6, 8)}`;
      } else {
        el.textContent = `資料日期: ${latestDataDate}`;
      }
    }
  }

  function buildFilterPanel() {
    const panel = document.getElementById('filter-panel');
    panel.innerHTML = '';

    const groups = {};
    for (const [key, def] of Object.entries(Filters.filterDefs)) {
      const group = def.group || '基本';
      if (!groups[group]) groups[group] = [];
      groups[group].push({ key, ...def });
    }

    // 關鍵字搜尋
    const searchRow = document.createElement('div');
    searchRow.className = 'filter-search';
    searchRow.appendChild(createFilterInput('keyword', Filters.filterDefs.keyword));
    panel.appendChild(searchRow);

    // 追蹤標的勾選 (基本組)
    if (groups['基本']) {
      for (const field of groups['基本']) {
        if (field.key === 'keyword') continue;
        const wrapper = document.createElement('div');
        wrapper.style.marginBottom = '8px';
        wrapper.appendChild(createFilterInput(field.key, field));
        panel.appendChild(wrapper);
      }
    }

    // 各分組 (預設收合)
    for (const [groupName, fields] of Object.entries(groups)) {
      if (groupName === '基本') continue;

      const group = document.createElement('div');
      group.className = 'filter-group collapsed';

      const title = document.createElement('div');
      title.className = 'filter-group-title';
      title.textContent = groupName;
      title.addEventListener('click', () => group.classList.toggle('collapsed'));
      group.appendChild(title);

      const content = document.createElement('div');
      content.className = 'filter-group-content';
      for (const field of fields) {
        const wrapper = document.createElement('div');
        wrapper.className = 'filter-item';
        wrapper.appendChild(createFilterInput(field.key, field));
        content.appendChild(wrapper);
      }
      group.appendChild(content);
      panel.appendChild(group);
    }

    // 按鈕
    const btnRow = document.createElement('div');
    btnRow.className = 'filter-buttons';

    const btnApply = document.createElement('button');
    btnApply.textContent = '套用篩選';
    btnApply.className = 'btn btn-primary';
    btnApply.addEventListener('click', () => {
      applyCurrentFilters();
      // 手機版：只有按套用按鈕才收起篩選面板
      document.getElementById('filter-panel').classList.remove('mobile-open');
      var bd = document.getElementById('mobile-filter-backdrop');
      if (bd) bd.classList.remove('show');
    });

    const btnReset = document.createElement('button');
    btnReset.textContent = '清除條件';
    btnReset.className = 'btn btn-secondary';
    btnReset.addEventListener('click', resetFilters);

    const btnExport = document.createElement('button');
    btnExport.textContent = '匯出 CSV';
    btnExport.className = 'btn btn-accent';
    btnExport.addEventListener('click', () => ExportCSV.exportFiltered(filteredData));

    const btnImport = document.createElement('button');
    btnImport.textContent = '匯入 CSV 追蹤';
    btnImport.className = 'btn btn-secondary';
    btnImport.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv';
      input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          const text = ev.target.result;
          const lines = text.trim().split('\n');
          if (lines.length < 2) return;
          const codes = [];
          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            const code = cols[0] && cols[0].trim();
            if (code && /^\d+$/.test(code)) codes.push(code);
          }
          if (codes.length === 0) {
            alert('CSV 中未找到有效的股票代碼');
            return;
          }
          Watchlist.addBatch(codes);
          alert(`已將 ${codes.length} 檔標的加入追蹤：${codes.join(', ')}`);
          applyCurrentFilters();
        };
        reader.readAsText(file);
      });
      input.click();
    });

    btnRow.append(btnApply, btnReset, btnExport, btnImport);
    panel.appendChild(btnRow);

    // 追蹤清單管理區
    panel.appendChild(buildWatchlistManager());
  }

  function createFilterInput(key, def) {
    const container = document.createElement('div');
    container.className = 'filter-input-wrapper';

    if (def.type === 'checkbox') {
      const label = document.createElement('label');
      label.className = 'filter-checkbox';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = `filter-${key}`;
      input.addEventListener('change', applyCurrentFilters);
      label.appendChild(input);
      const span = document.createElement('span');
      span.textContent = def.label;
      label.appendChild(span);
      container.appendChild(label);
    } else if (def.type === 'watchlist_select') {
      const label = document.createElement('label');
      label.textContent = def.label;
      label.className = 'filter-label';
      container.appendChild(label);
      const select = document.createElement('select');
      select.id = `filter-${key}`;
      select.className = 'filter-select';
      rebuildWatchlistSelect(select);
      select.addEventListener('change', () => {
        const v = select.value;
        Watchlist.setActiveList(v && v !== '__all__' ? v : '');
        applyCurrentFilters();
      });
      container.appendChild(select);
    } else if (def.type === 'select') {
      const label = document.createElement('label');
      label.textContent = def.label;
      label.className = 'filter-label';
      container.appendChild(label);
      const select = document.createElement('select');
      select.id = `filter-${key}`;
      select.className = 'filter-select';
      for (const opt of def.options) {
        const option = document.createElement('option');
        option.value = opt;
        option.textContent = opt;
        if (opt == def.default) option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener('change', () => {
        Table.updateInstDays(Number(select.value));
        applyCurrentFilters();
      });
      container.appendChild(select);
    } else {
      const label = document.createElement('label');
      label.textContent = def.label;
      label.className = 'filter-label';
      container.appendChild(label);
      const input = document.createElement('input');
      input.type = def.type;
      input.id = `filter-${key}`;
      input.className = 'filter-input';
      if (def.placeholder) input.placeholder = def.placeholder;
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCurrentFilters(); });
      container.appendChild(input);
    }

    return container;
  }

  function rebuildWatchlistSelect(select) {
    if (!select) select = document.getElementById('filter-watchlistFilter');
    if (!select) return;
    const prev = select.value;
    select.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = '— 全部 —';
    select.appendChild(optAll);
    const optAny = document.createElement('option');
    optAny.value = '__all__';
    optAny.textContent = '所有追蹤';
    select.appendChild(optAny);
    for (const name of Watchlist.getListNames()) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
    select.value = prev || '';
  }

  function buildWatchlistManager() {
    const section = document.createElement('div');
    section.className = 'watchlist-manager';

    const title = document.createElement('div');
    title.className = 'wl-manager-title';
    title.textContent = '追蹤清單管理';
    section.appendChild(title);

    const addRow = document.createElement('div');
    addRow.className = 'wl-add-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'filter-input wl-add-input';
    input.placeholder = '新增清單名稱...';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doAdd();
    });
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary wl-add-btn';
    btn.textContent = '+';
    btn.addEventListener('click', doAdd);
    addRow.append(input, btn);
    section.appendChild(addRow);

    const listContainer = document.createElement('div');
    listContainer.id = 'wl-list-container';
    section.appendChild(listContainer);

    function doAdd() {
      const name = input.value.trim();
      if (!name) return;
      if (Watchlist.addList(name)) {
        input.value = '';
        renderListItems();
        rebuildWatchlistSelect();
      } else {
        alert('清單名稱已存在');
      }
    }

    function renderListItems() {
      listContainer.innerHTML = '';
      for (const name of Watchlist.getListNames()) {
        const row = document.createElement('div');
        row.className = 'wl-list-item';
        const label = document.createElement('span');
        label.className = 'wl-list-name';
        const count = Watchlist.getCodesInList(name).length;
        label.textContent = `${name} (${count})`;
        row.appendChild(label);
        const delBtn = document.createElement('button');
        delBtn.className = 'wl-del-btn';
        delBtn.textContent = '\u00d7';
        delBtn.title = `刪除「${name}」`;
        delBtn.addEventListener('click', () => {
          if (!confirm(`確定刪除清單「${name}」？\n清單內的 ${count} 檔標的將不再追蹤。`)) return;
          Watchlist.removeList(name);
          renderListItems();
          rebuildWatchlistSelect();
          applyCurrentFilters();
        });
        row.appendChild(delBtn);
        listContainer.appendChild(row);
      }
    }

    renderListItems();
    return section;
  }

  function getFilterValues() {
    const values = {};
    for (const key of Object.keys(Filters.filterDefs)) {
      const el = document.getElementById(`filter-${key}`);
      if (!el) continue;
      if (el.type === 'checkbox') values[key] = el.checked;
      else if (el.type === 'number') values[key] = el.value ? Number(el.value) : null;
      else values[key] = el.value || null;
    }
    return values;
  }

  function applyCurrentFilters() {
    if (!stockMap) return;
    const filters = getFilterValues();
    filteredData = Filters.applyFilters(stockMap, filters);
    filteredData = Filters.sortResults(filteredData, 'code', true);
    Table.render('main-table', filteredData, { onRowClick: showDetail });
  }

  function resetFilters() {
    for (const key of Object.keys(Filters.filterDefs)) {
      const el = document.getElementById(`filter-${key}`);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = false;
      else if (el.tagName === 'SELECT') {
        const def = Filters.filterDefs[key];
        el.value = def.default || el.options[0]?.value || '';
      } else el.value = '';
    }
    applyCurrentFilters();
  }

  function showDetail(stock) {
    selectedStock = stock;
    const panel = document.getElementById('detail-panel');
    panel.classList.add('show');

    document.getElementById('detail-title').textContent = `${stock.code} ${stock.name}`;
    document.getElementById('detail-price-info').innerHTML = buildPriceInfoHTML(stock);
    document.getElementById('detail-cb-info').innerHTML = buildCBInfoHTML(stock);
    document.getElementById('detail-inst-info').innerHTML = buildInstInfoHTML(stock);
    document.getElementById('detail-cb-inst-info').innerHTML = buildCBInstInfoHTML(stock);
    document.getElementById('detail-news-info').innerHTML = buildNewsHTML(stock);

    setTimeout(() => {
      Charts.renderPriceChart('detail-price-chart', stock);
      Charts.renderInstChart('detail-inst-chart', stock);
      Charts.renderCBPriceChart('detail-cb-price-chart', stock);
      Charts.renderCBInstChart('detail-cb-inst-chart', stock);
    }, 100);
  }

  function buildPriceInfoHTML(stock) {
    const cls = (stock.priceChange || 0) > 0 ? 'text-up' : (stock.priceChange || 0) < 0 ? 'text-down' : '';
    const sign = (stock.priceChange || 0) >= 0 ? '+' : '';

    return `
      <div class="info-grid">
        <div class="info-item">
          <span class="info-label">收盤價</span>
          <span class="info-value ${cls}">${stock.latestClose?.toFixed(2) ?? '-'}</span>
        </div>
        <div class="info-item">
          <span class="info-label">漲跌</span>
          <span class="info-value ${cls}">${stock.priceChange != null ? sign + stock.priceChange.toFixed(2) : '-'}</span>
        </div>
        <div class="info-item">
          <span class="info-label">漲跌%</span>
          <span class="info-value ${cls}">${stock.priceChangePercent != null ? sign + stock.priceChangePercent.toFixed(2) + '%' : '-'}</span>
        </div>
        <div class="info-item">
          <span class="info-label">成交量(張)</span>
          <span class="info-value">${stock.latestVolume?.toLocaleString() ?? '-'}</span>
        </div>
        <div class="info-item"><span class="info-label">開盤</span><span class="info-value">${stock.latestOpen?.toFixed(2) ?? '-'}</span></div>
        <div class="info-item"><span class="info-label">最高</span><span class="info-value">${stock.latestHigh?.toFixed(2) ?? '-'}</span></div>
        <div class="info-item"><span class="info-label">最低</span><span class="info-value">${stock.latestLow?.toFixed(2) ?? '-'}</span></div>
        <div class="info-item"><span class="info-label">MA5</span><span class="info-value">${stock.ma5?.toFixed(2) ?? '-'}</span></div>
        <div class="info-item"><span class="info-label">MA10</span><span class="info-value">${stock.ma10?.toFixed(2) ?? '-'}</span></div>
        <div class="info-item"><span class="info-label">MA20</span><span class="info-value">${stock.ma20?.toFixed(2) ?? '-'}</span></div>
      </div>`;
  }

  function buildCBInfoHTML(stock) {
    if (!stock.cbs || stock.cbs.length === 0) {
      let html = '<div class="text-muted">無 CB 交易資料</div>';
      if (stock.primaryMarket?.length > 0) html += buildPrimaryMarketHTML(stock);
      return html;
    }

    let html = '<div class="cb-list">';
    for (const cb of stock.cbs) {
      const cls = (cb.change || 0) > 0 ? 'text-up' : (cb.change || 0) < 0 ? 'text-down' : '';
      const changeSign = (cb.change || 0) >= 0 ? '+' : '';

      // CB 溢價率 (每檔 CB 個別計算)
      let cbPrem = null;
      if (cb.close && cb.conversionPrice && stock.latestClose) {
        const convVal = (100 / cb.conversionPrice) * stock.latestClose;
        cbPrem = ((cb.close - convVal) / convVal) * 100;
      }
      const premCls = cbPrem != null ? (cbPrem > 0 ? 'text-up' : cbPrem < 0 ? 'text-down' : '') : '';

      const auctionBtn = cb.auction
        ? `<button class="btn-auction" onclick="App.showAuctionModal('${cb.cbCode}')">CB開標統計表</button>`
        : '';

      html += `
        <div class="cb-card">
          <div class="cb-card-header">
            <span class="cb-code">${cb.cbCode}</span>
            <span class="cb-name">${cb.cbName}</span>
            ${auctionBtn}
          </div>
          <div class="info-grid info-grid-sm">
            <div class="info-item">
              <span class="info-label">收盤</span>
              <span class="info-value ${cls}">${cb.close?.toFixed(2) ?? '-'}</span>
            </div>
            <div class="info-item">
              <span class="info-label">漲跌</span>
              <span class="info-value ${cls}">${changeSign}${cb.change.toFixed(2)}</span>
            </div>
            <div class="info-item">
              <span class="info-label">轉換價</span>
              <span class="info-value">${cb.conversionPrice?.toFixed(2) ?? '-'}</span>
            </div>
            <div class="info-item">
              <span class="info-label">CB溢價率</span>
              <span class="info-value ${premCls}">${cbPrem != null ? (cbPrem >= 0 ? '+' : '') + cbPrem.toFixed(2) + '%' : '-'}</span>
            </div>
            <div class="info-item">
              <span class="info-label">成交量</span>
              <span class="info-value">${cb.volume?.toLocaleString() ?? '-'}</span>
            </div>
            <div class="info-item">
              <span class="info-label">成交金額</span>
              <span class="info-value">${cb.amount ? Number(cb.amount).toLocaleString() : '-'}</span>
            </div>
            <div class="info-item">
              <span class="info-label">轉換期間</span>
              <span class="info-value" style="font-size:11px">${cb.conversionPeriod || '-'}</span>
            </div>
            <div class="info-item">
              <span class="info-label">到期日</span>
              <span class="info-value">${cb.maturityDate || '-'}</span>
            </div>
            <div class="info-item">
              <span class="info-label">賣回權日</span>
              <span class="info-value">${cb.nextPutDate || '-'}</span>
            </div>
          </div>
        </div>`;
    }
    html += '</div>';

    if (stock.primaryMarket?.length > 0) html += buildPrimaryMarketHTML(stock);
    return html;
  }

  function buildPrimaryMarketHTML(stock) {
    // 依 section 分組顯示
    const sectionLabels = {
      'fubon_listed': '富邦 初級市場',
      'fubon_filing': '富邦 送件標的',
      'fubon_board': '富邦 董事會通過',
      'yuanta_listed': '元大 初級案件',
      'yuanta_board': '元大 董事會決議'
    };

    // 按 section 分組
    const grouped = {};
    for (const pm of stock.primaryMarket) {
      const sec = pm.section || 'unknown';
      if (!grouped[sec]) grouped[sec] = [];
      grouped[sec].push(pm);
    }

    let html = '<div class="primary-market-section"><h4>初級市場資訊</h4>';

    for (const [secKey, items] of Object.entries(grouped)) {
      const secLabel = sectionLabels[secKey] || secKey;

      for (const pm of items) {
        html += `<div class="cb-card">
          <div class="cb-card-header">
            <span class="cb-code">${pm.cbCode}</span>
            <span class="cb-name">${pm.cbName}</span>
            <span class="cb-type">${secLabel}</span>
          </div>
          <div class="info-grid info-grid-sm">`;

        html += buildPrimaryFields(pm, secKey);

        html += `</div></div>`;
      }
    }

    html += '</div>';
    return html;
  }

  function buildPrimaryFields(pm, section) {
    const f = (label, val) => `<div class="info-item"><span class="info-label">${label}</span><span class="info-value">${val ?? '-'}</span></div>`;

    switch (section) {
      case 'fubon_listed':
        return f('發行金額(億)', pm.issueAmount) +
          f('TCRI/擔保', pm.guarantee) +
          f('詢圈/競拍', pm.bidding) +
          f('溢價率', pm.premium) +
          f('轉換價', pm.conversionPrice) +
          f('掛牌日', pm.listingDate) +
          f('可拆解選擇權日', pm.opDate) +
          f('備註', pm.remark);

      case 'fubon_filing':
        return f('發行金額(億)', pm.issueAmount) +
          f('TCRI/擔保', pm.guarantee) +
          f('詢圈/競拍', pm.bidding) +
          f('溢價率', pm.premium) +
          f('發行期間(年)', pm.years) +
          f('送件日', pm.filingDate) +
          f('生效日', pm.effectiveDate) +
          f('備註', pm.remark);

      case 'fubon_board':
        return f('產業別', pm.industry) +
          f('資本額(億)', pm.capital) +
          f('發行金額(億)', pm.issueAmount) +
          f('TCRI/擔保', pm.guarantee) +
          f('詢圈/競拍', pm.bidding) +
          f('發行期間(年)', pm.years) +
          f('公告日期', pm.announcementDate) +
          f('備註', pm.remark);

      case 'yuanta_listed':
        return f('股本', pm.capital) +
          f('詢圈/競拍', pm.bidding) +
          f('TCRI/擔保', pm.guarantee) +
          f('發行量', pm.issueAmount) +
          f('生效日', pm.effectiveDate) +
          f('轉換價', pm.conversionPrice) +
          f('掛牌日', pm.listingDate) +
          f('可拆解選擇權日', pm.opDate) +
          f('備註', pm.remark);

      case 'yuanta_board':
        return f('股本', pm.capital) +
          f('詢圈/競拍', pm.bidding) +
          f('TCRI/擔保', pm.guarantee) +
          f('發行量', pm.issueAmount) +
          f('董事會通過', pm.announcementDate) +
          f('到期日', pm.maturityDate) +
          f('備註', pm.remark);

      default:
        return f('TCRI/擔保', pm.guarantee) +
          f('轉換價', pm.conversionPrice) +
          f('掛牌日', pm.listingDate);
    }
  }

  function buildInstInfoHTML(stock) {
    let html = `<div class="inst-consecutive">
      <span>外資連買: <strong class="${cc(stock.foreignConsecutiveBuy)}">${stock.foreignConsecutiveBuy || 0}日</strong></span>
      <span>投信連買: <strong class="${cc(stock.investmentConsecutiveBuy)}">${stock.investmentConsecutiveBuy || 0}日</strong></span>
    </div>`;

    // 近10日每日買賣超明細
    const instDates = (stock.institutionalDates || []).slice(-10).reverse();
    html += `<table class="inst-summary-table"><thead><tr>
      <th>日期</th><th>外資(張)</th><th>投信(張)</th><th>自營商(張)</th><th>合計(張)</th>
    </tr></thead><tbody>`;

    for (const d of instDates) {
      const rawF = stock.institutional['外資買賣超']?.[d] ?? null;
      const rawI = stock.institutional['投信買賣超']?.[d] ?? null;
      const rawD = stock.institutional['自營商買賣超']?.[d] ?? null;
      const f = rawF != null ? Math.round(rawF / 1000) : null;
      const inv = rawI != null ? Math.round(rawI / 1000) : null;
      const deal = rawD != null ? Math.round(rawD / 1000) : null;
      const total = (f || 0) + (inv || 0) + (deal || 0);
      const dateLabel = d.length >= 8 ? d.substring(4, 6) + '/' + d.substring(6, 8) : d;
      html += `<tr>
        <td>${dateLabel}</td>
        <td class="${cc(f)}">${fmtInst(f)}</td>
        <td class="${cc(inv)}">${fmtInst(inv)}</td>
        <td class="${cc(deal)}">${fmtInst(deal)}</td>
        <td class="${cc(total)}"><strong>${fmtInst(total)}</strong></td>
      </tr>`;
    }

    html += `</tbody></table>
      <div class="detail-export-buttons">
        <button class="btn btn-sm btn-accent" onclick="ExportCSV.exportInstitutional(App.getSelectedStock())">匯出法人資料</button>
        <button class="btn btn-sm btn-accent" onclick="ExportCSV.exportTrading(App.getSelectedStock())">匯出交易明細</button>
      </div>`;
    return html;
  }

  function buildCBInstInfoHTML(stock) {
    const inst = stock.cbBondInstitutional;
    const dates = stock.cbBondInstitutionalDates || [];
    if (!inst || dates.length === 0) {
      return '<div class="text-muted">無 CB 三大法人資料</div>';
    }

    const recent = dates.slice(-10).reverse();
    let html = `<table class="inst-summary-table"><thead><tr>
      <th>日期</th><th>外資(張)</th><th>投信(張)</th><th>自營商(張)</th><th>合計(張)</th>
    </tr></thead><tbody>`;

    for (const d of recent) {
      const rawF = inst['外資買賣超']?.[d] ?? null;
      const rawI = inst['投信買賣超']?.[d] ?? null;
      const rawD = inst['自營商買賣超']?.[d] ?? null;
      const f = rawF != null ? Math.round(rawF / 1000) : null;
      const inv = rawI != null ? Math.round(rawI / 1000) : null;
      const deal = rawD != null ? Math.round(rawD / 1000) : null;
      const total = (f || 0) + (inv || 0) + (deal || 0);
      const dateLabel = d.length >= 8 ? d.substring(4, 6) + '/' + d.substring(6, 8) : d;
      html += `<tr>
        <td>${dateLabel}</td>
        <td class="${cc(f)}">${fmtInst(f)}</td>
        <td class="${cc(inv)}">${fmtInst(inv)}</td>
        <td class="${cc(deal)}">${fmtInst(deal)}</td>
        <td class="${cc(total)}"><strong>${fmtInst(total)}</strong></td>
      </tr>`;
    }
    html += `</tbody></table>`;
    return html;
  }

  function buildNewsHTML(stock) {
    const news = stock.news;
    if (!news || news.length === 0) {
      return '<div class="text-muted">無相關新聞</div>';
    }

    let html = '<div class="news-list">';
    for (const item of news) {
      const dateStr = item.date || '';
      html += `<div class="news-item">
        <span class="news-date">${dateStr}</span>
        <a class="news-title" href="${item.link}" target="_blank" rel="noopener">${item.title}</a>
      </div>`;
    }
    html += '</div>';
    return html;
  }

  function showAuctionModal(cbCode) {
    if (!selectedStock || !selectedStock.cbs) return;
    const cb = selectedStock.cbs.find(c => String(c.cbCode) === String(cbCode));
    if (!cb || !cb.auction) return;

    const a = cb.auction;
    const pdf = a.pdf || {};
    const info = pdf.info || {};
    const priceRows = pdf.priceRows || [];

    document.getElementById('auction-modal-title').textContent =
      `${cb.cbCode} ${cb.cbName} 開標統計表`;

    const f = (label, val) => `<div class="info-item"><span class="info-label">${label}</span><span class="info-value">${val ?? '-'}</span></div>`;

    let html = '<div class="info-grid info-grid-sm">' +
      f('發行公司', a['發行公司']) +
      f('主辦承銷商', a['主辦承銷商']) +
      f('發行性質', a['發行性質']) +
      f('承銷股數', a['承銷股數']) +
      f('競拍股數', a['競拍股數']) +
      f('投標期間', a['投標期間']) +
      f('最低承銷價格', a['最低承銷價格']) +
      f('競拍方式', info.auctionType) +
      f('最低得標價', info.minWin) +
      f('最高得標價', info.maxWin) +
      f('平均得標價', info.avgWin) +
      f('公開承銷價', info.pubOffer) +
      f('開標日期', info.openDate) +
      '</div>';

    if (priceRows.length > 0) {
      html += `<h4 style="margin-top:16px">得標明細</h4>
        <div class="auction-table-wrap"><table class="inst-summary-table">
          <thead><tr><th>序號</th><th>價格</th><th>股數(千股)</th><th>金額(千元)</th></tr></thead>
          <tbody>`;
      for (const row of priceRows) {
        html += `<tr><td>${row[0] ?? '-'}</td><td>${row[1] ?? '-'}</td><td>${row[2] ?? '-'}</td><td>${row[3] ?? '-'}</td></tr>`;
      }
      html += '</tbody></table></div>';
    }

    document.getElementById('auction-modal-body').innerHTML = html;
    document.getElementById('auction-modal').classList.add('show');
  }

  function closeAuctionModal(event) {
    // 若是事件觸發：只有點擊背景遮罩 (#auction-modal 本身) 時才關閉
    if (event && event.target && event.target.id !== 'auction-modal') return;
    document.getElementById('auction-modal').classList.remove('show');
  }

  function cc(v) { return v == null || v === 0 ? 'text-neutral' : v > 0 ? 'text-up' : 'text-down'; }

  function fmtInst(v) {
    if (v == null) return '-';
    const sign = v > 0 ? '+' : '';
    return sign + v.toLocaleString();
  }

  function closeDetail() {
    document.getElementById('detail-panel').classList.remove('show');
    Charts.destroy();
    selectedStock = null;
  }

  function showLoading(show) {
    document.getElementById('loading-overlay').style.display = show ? 'flex' : 'none';
  }

  function updateStatus(msg) {
    const loadingText = document.getElementById('loading-text');
    if (loadingText) loadingText.textContent = msg;
    const headerStatus = document.getElementById('header-status');
    if (headerStatus) headerStatus.textContent = msg;
  }

  function getSelectedStock() { return selectedStock; }

  /** 背景靜默更新：不顯示 loading，完成後刷新畫面 */
  async function silentRefresh() {
    try {
      SheetsAPI.clearCache();
      const rawResults = await SheetsAPI.loadAll();
      const result = DataProcessor.mergeAllData(rawResults);
      stockMap = result.stockMap;
      latestDataDate = result.latestDataDate;
      SheetsAPI.saveToStorage(rawResults);
      updateDateDisplay();
      applyCurrentFilters();
      console.log('[silentRefresh] 背景更新完成');
    } catch (err) {
      console.warn('[silentRefresh] 背景更新失敗:', err);
    }
  }

  async function refreshData() {
    // 先清除伺服器端快取
    if (typeof APPS_SCRIPT_URL !== 'undefined' && APPS_SCRIPT_URL) {
      try { await fetch(APPS_SCRIPT_URL + '?mode=flush'); } catch(e) {}
    }
    SheetsAPI.clearCache();
    SheetsAPI.clearStorage();
    init();
  }

  function toggleMobileFilter() {
    const sidebar = document.getElementById('filter-panel');
    const backdrop = document.getElementById('mobile-filter-backdrop');
    const isOpen = sidebar.classList.toggle('mobile-open');
    if (backdrop) backdrop.classList.toggle('show', isOpen);
  }

  return { init, closeDetail, getSelectedStock, refreshData, toggleMobileFilter, showAuctionModal, closeAuctionModal };
})();

document.addEventListener('DOMContentLoaded', App.init);
