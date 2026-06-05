// 主應用程式
const App = (() => {
  let stockMap = null;
  let filteredData = [];
  let selectedStock = null;
  let latestDataDate = '';
  let currentTab = 'cb';   // 'cb' | 'etf' | 'calendar'
  let etfLoaded = false;
  let calendarLoaded = false;
  let rawCBIssuance = null; // 保留 CB 發行資訊供 ETF 交叉比對
  let rawCalendar = null;   // 保留 CBAS 日曆事件供日曆頁使用
  // twsa 競拍資料 — 給 PM 卡片按鈕 / CB 日曆統計表用。
  // 為了讓「CB 已開標但還沒掛牌」的檔(例: 47491 掛牌前)也能顯示開標資訊,
  // 不依賴 stock.cbs 是否已建立 → 直接以 cbCode 為 key 的全域 map 查詢。
  let auctionByCbCode = new Map();

  function _buildAuctionByCbCode(twsa) {
    const m = new Map();
    if (!twsa || !Array.isArray(twsa.auction)) return m;
    for (const it of twsa.auction) {
      const code = it?.pdf?.stockId;
      if (code) m.set(String(code), it);
    }
    return m;
  }

  async function init() {
    showLoading(true);

    // 嘗試從 localStorage 快取載入（瞬間顯示）
    const cached = SheetsAPI.loadFromStorage();
    if (cached) {
      updateStatus('從快取載入...');
      const result = DataProcessor.mergeAllData(cached.data);
      stockMap = result.stockMap;
      latestDataDate = result.latestDataDate;
      rawCBIssuance = cached.data.cbIssuance || null;
      rawCalendar = cached.data.cbasCalendar || null;
      auctionByCbCode = _buildAuctionByCbCode(cached.data.twsaAuction);
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
      rawCBIssuance = rawResults.cbIssuance || null;
      rawCalendar = rawResults.cbasCalendar || null;
      auctionByCbCode = _buildAuctionByCbCode(rawResults.twsaAuction);

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
        if (field.pairWith) continue;
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
    btnImport.textContent = '匯入 CSV';
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
    } else if (def.type === 'cb_select') {
      const label = document.createElement('label');
      label.textContent = def.label;
      label.className = 'filter-label';
      container.appendChild(label);
      const select = document.createElement('select');
      select.id = `filter-${key}`;
      select.className = 'filter-select';
      for (const opt of def.options) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        select.appendChild(option);
      }
      select.addEventListener('change', applyCurrentFilters);
      container.appendChild(select);
    } else if (def.type === 'range') {
      if (def.pairWith) return container;
      const label = document.createElement('label');
      label.textContent = def.label;
      label.className = 'filter-label';
      container.appendChild(label);
      const row = document.createElement('div');
      row.className = 'filter-range-row';
      const inputMin = document.createElement('input');
      inputMin.type = 'number';
      inputMin.id = `filter-${key}`;
      inputMin.className = 'filter-input';
      inputMin.placeholder = '下限';
      inputMin.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCurrentFilters(); });
      const sep = document.createElement('span');
      sep.className = 'range-sep';
      sep.textContent = '~';
      const pairKey = Object.keys(Filters.filterDefs).find(k => Filters.filterDefs[k].pairWith === key);
      const inputMax = document.createElement('input');
      inputMax.type = 'number';
      inputMax.id = pairKey ? `filter-${pairKey}` : `filter-${key}-max`;
      inputMax.className = 'filter-input';
      inputMax.placeholder = '上限';
      inputMax.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCurrentFilters(); });
      row.append(inputMin, sep, inputMax);
      container.appendChild(row);
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
    const optPublic = document.createElement('option');
    optPublic.value = '__public__';
    optPublic.textContent = '公用清單 🌐';
    select.appendChild(optPublic);
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
      // 公用清單（第一項，不可刪除）
      const pubRow = document.createElement('div');
      pubRow.className = 'wl-list-item';
      const pubLabel = document.createElement('span');
      pubLabel.className = 'wl-list-name';
      pubLabel.style.color = 'var(--accent)';
      pubLabel.textContent = `公用清單 🌐 (${PublicWatchlist.getAll().length})`;
      pubRow.appendChild(pubLabel);
      listContainer.appendChild(pubRow);
      // 個人清單
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
      else values[key] = el.value !== '' ? el.value : null;
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

    renderDetailTitle(stock);
    document.getElementById('detail-price-info').innerHTML = buildPriceInfoHTML(stock);
    document.getElementById('detail-cb-info').innerHTML = buildCBInfoHTML(stock);
    document.getElementById('detail-news-info').innerHTML = buildNewsHTML(stock);

    // 預設選的 CB (給 CB 技術分析 Modal 用)
    const tabCBs = (stock.cbs || []).filter(cb => cb.cbCode);
    selectedCBTab = stock.mainCB?.cbCode || tabCBs[0]?.cbCode || null;
  }

  // 詳情面板標題:星星 + 代號名稱 + VCP/三線 狀態徽章
  function renderDetailTitle(stock) {
    const titleEl = document.getElementById('detail-title');
    titleEl.innerHTML = '';

    const star = document.createElement('span');
    star.className = 'detail-star';
    const starred = Watchlist.has(stock.code);
    star.textContent = starred ? '★' : '☆';
    star.style.color = starred ? '#f59e0b' : 'var(--text-dim)';
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      Table.showStarMenu(star, stock.code);
    });

    const label = document.createElement('span');
    label.textContent = `${stock.code} ${stock.name}`;

    titleEl.append(star, label);

    // VCP / 三線 徽章 (stock 層級)
    const badgesHtml = buildStatusBadgesHTML(stock);
    if (badgesHtml) {
      const wrap = document.createElement('span');
      wrap.className = 'detail-title-badges';
      wrap.innerHTML = badgesHtml;
      titleEl.appendChild(wrap);
    }
  }

  // ============================================================
  // 技術分析 Modal (v2: K線 + 2 folder tabs × 3 sub-charts)
  // ============================================================
  let techActiveFolder = 'inst';  // 'inst' | 'margin'

  // === 額度勾選(統一/富邦/元大)— 個股 / CB 技術分析 modal 共用,
  //     用 localStorage 持久化,任一個 modal 改了另一個自動同步
  const QUOTA_STORAGE_KEY = 'tech_modal_quota_state';
  function getQuotaState() {
    try { return JSON.parse(localStorage.getItem(QUOTA_STORAGE_KEY)) || {}; }
    catch { return {}; }
  }
  function setQuotaValue(key, checked) {
    const state = getQuotaState();
    state[key] = !!checked;
    localStorage.setItem(QUOTA_STORAGE_KEY, JSON.stringify(state));
    syncQuotaUI();
  }
  function syncQuotaUI() {
    const state = getQuotaState();
    for (const cb of document.querySelectorAll('.tech-quota-group input[type="checkbox"]')) {
      cb.checked = !!state[cb.dataset.quota];
    }
  }
  function bindQuotaGroup(groupId) {
    const el = document.getElementById(groupId);
    if (!el || el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('input[type="checkbox"]') && t.dataset.quota) {
        setQuotaValue(t.dataset.quota, t.checked);
      }
    });
  }

  function openTechModal() {
    if (!selectedStock) return;
    document.getElementById('tech-modal').classList.add('show');
    bindTechFolderTabs();
    bindQuotaGroup('tech-quota-group-stock');
    syncQuotaUI();
    refreshTechModalForCurrentStock();
  }

  function bindTechFolderTabs() {
    const host = document.querySelector('#tech-modal .tech-folder-tabs');
    if (!host || host.dataset.bound === '1') return;
    host.dataset.bound = '1';
    host.addEventListener('click', (e) => {
      const btn = e.target.closest('.tech-folder-tab');
      if (!btn) return;
      const which = btn.dataset.folder;
      if (!which || which === techActiveFolder) return;
      techActiveFolder = which;
      syncTechFolderTab();
    });
  }

  function syncTechFolderTab() {
    document.querySelectorAll('#tech-modal .tech-folder-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.folder === techActiveFolder));
    document.querySelectorAll('#tech-modal .tech-folder-panel').forEach(p =>
      p.classList.toggle('hidden', p.dataset.panel !== techActiveFolder));
    // 切換 tab 後通知 Chart.js 重算大小 (因 panel 從 hidden → visible)
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  function refreshTechModalForCurrentStock() {
    if (!selectedStock) return;
    renderTechModalTitle();
    syncTechFolderTab();
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      Charts.renderTechPriceChart('tech-price-chart', selectedStock);
      // 法人 tab
      renderTechInstSub('tech-foreign-chart', '外資',   'tech-foreign-meta');
      renderTechInstSub('tech-invest-chart',  '投信',   'tech-invest-meta');
      renderTechInstSub('tech-dealer-chart',  '自營商', 'tech-dealer-meta');
      // 資券 tab
      renderTechBias();
      renderTechMarginSub('tech-margin-chart', '融資', 'tech-margin-meta');
      renderTechMarginSub('tech-short-chart',  '融券', 'tech-short-meta');
    }, 60)));
  }

  function renderTechInstSub(canvasId, which, metaId) {
    const meta = Charts.renderTechInstChart(canvasId, selectedStock, which);
    const el = document.getElementById(metaId);
    if (!el) return;
    if (!meta || meta.latest == null) { el.textContent = ''; return; }
    const sign = meta.latest > 0 ? '+' : '';
    const cum = meta.cumulative != null ? meta.cumulative.toLocaleString() : '-';
    el.innerHTML = `買賣超 <strong class="${cc(meta.latest)}">${sign}${meta.latest.toLocaleString()}張</strong>`
                 + ` &middot; 累積 <strong>${cum}張</strong>`;
  }

  function renderTechMarginSub(canvasId, which, metaId) {
    const meta = Charts.renderTechMarginChart(canvasId, selectedStock, which);
    const el = document.getElementById(metaId);
    if (!el) return;
    if (!meta || (meta.latestChange == null && meta.latestBalance == null)) {
      el.textContent = ''; return;
    }
    const c = meta.latestChange, b = meta.latestBalance;
    const sign = (c != null && c > 0) ? '+' : '';
    const chgHtml = c != null ? `<strong class="${cc(c)}">${sign}${c.toLocaleString()}張</strong>` : '-';
    const balHtml = b != null ? `<strong>${b.toLocaleString()}張</strong>` : '-';
    el.innerHTML = `${which}增減 ${chgHtml} &middot; ${which}餘額 ${balHtml}`;
  }

  function renderTechBias() {
    const meta = Charts.renderTechBiasChart('tech-bias-chart', selectedStock);
    const el = document.getElementById('tech-bias-meta');
    if (!el) return;
    if (!meta) { el.textContent = ''; return; }
    const fmt = (v) => v == null ? '-' : `<strong class="${cc(v)}">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</strong>`;
    el.innerHTML = `5日 ${fmt(meta.bias5)} &middot; 10日 ${fmt(meta.bias10)} &middot; 20日 ${fmt(meta.bias20)}`;
  }

  // 技術分析 Modal 標題:◀ ☆ 股號 股名 ▶ — 串接主畫面 filteredData 前後切換
  function renderTechModalTitle() {
    const titleEl = document.getElementById('tech-modal-title');
    if (!titleEl || !selectedStock) return;
    const idx = filteredData.findIndex(s => s.code === selectedStock.code);
    const canPrev = idx > 0;
    const canNext = idx >= 0 && idx < filteredData.length - 1;
    const fullLabel = `${selectedStock.code} ${selectedStock.name || ''}`;
    const starred = Watchlist.has(selectedStock.code);
    const starChar = starred ? '★' : '☆';
    const starColor = starred ? '#f59e0b' : 'var(--text-dim)';
    titleEl.innerHTML =
      `<button class="tech-nav-arrow" id="tech-nav-prev" ${canPrev ? '' : 'disabled'} title="上一檔">&#x25C0;</button>` +
      `<span class="tech-nav-center">` +
        `<button class="tech-nav-star" id="tech-nav-star" title="加入清單" style="color:${starColor}">${starChar}</button>` +
        `<span class="tech-nav-label" title="${fullLabel}">${fullLabel}</span>` +
      `</span>` +
      `<button class="tech-nav-arrow" id="tech-nav-next" ${canNext ? '' : 'disabled'} title="下一檔">&#x25B6;</button>`;
    const prev = document.getElementById('tech-nav-prev');
    const next = document.getElementById('tech-nav-next');
    const star = document.getElementById('tech-nav-star');
    if (prev) prev.addEventListener('click', () => navigateTechModal(-1));
    if (next) next.addEventListener('click', () => navigateTechModal(1));
    if (star) star.addEventListener('click', (e) => {
      e.stopPropagation();
      // 重用 Table.showStarMenu — 內部會以 star.getBoundingClientRect() 對位、
      // 勾選變更後直接更新 star.textContent 跟顏色 (跟主表 td 同邏輯)
      Table.showStarMenu(star, selectedStock.code);
    });
  }

  function navigateTechModal(dir) {
    if (!selectedStock) return;
    const idx = filteredData.findIndex(s => s.code === selectedStock.code);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= filteredData.length) return;
    const newStock = filteredData[newIdx];
    // 同步更新右側詳情面板 (showDetail 內含 selectedStock 賦值)
    showDetail(newStock);
    refreshTechModalForCurrentStock();
    // 並排模式下 CB 技術分析也要連動切到同一檔
    if (document.getElementById('cbtech-modal')?.classList.contains('show')) {
      const cbs = (newStock.cbs || []).filter(c => c.cbCode);
      selectedCBTab = newStock.mainCB?.cbCode || cbs[0]?.cbCode || null;
      refreshCBTechModal();
    }
  }

  function bindTechToggle(toggleId, onChange) {
    const host = document.getElementById(toggleId);
    if (!host || host.dataset.bound === '1') return;
    host.dataset.bound = '1';
    host.addEventListener('click', (e) => {
      const btn = e.target.closest('.tech-toggle-btn');
      if (!btn) return;
      const which = btn.dataset.which;
      if (!which) return;
      host.querySelectorAll('.tech-toggle-btn').forEach(b =>
        b.classList.toggle('active', b === btn));
      onChange(which);
    });
  }

  function syncTechToggle(toggleId, which) {
    const host = document.getElementById(toggleId);
    if (!host) return;
    host.querySelectorAll('.tech-toggle-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.which === which));
  }

  function closeTechModal(event) {
    if (event && event.target && event.target.id !== 'tech-modal') return;
    document.getElementById('tech-modal').classList.remove('show');
    Charts.destroyTech();
    exitTechSplitMode();
  }

  // 從個股技術分析 Modal 點「CB 技術分析」→ 兩個 Modal 並排對照
  function openCBTechFromStock() {
    enterTechSplitMode();
    openCBTechModal();
  }

  // 反方向:從 CB 技術分析 Modal 點「個股技術分析」→ 兩個 Modal 並排對照
  function openTechFromCB() {
    enterTechSplitMode();
    openTechModal();
  }

  function enterTechSplitMode() {
    document.getElementById('tech-modal')?.classList.add('split-mode');
    document.getElementById('cbtech-modal')?.classList.add('split-mode');
    // chart 容器寬度改變,通知 Chart.js 重新計算
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  function exitTechSplitMode() {
    document.getElementById('tech-modal')?.classList.remove('split-mode');
    document.getElementById('cbtech-modal')?.classList.remove('split-mode');
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  // ============================================================
  // CB 技術分析 Modal (v2: K線 + 2 folder tabs × 3 sub-charts)
  // ============================================================
  let cbTechActiveFolder = 'inst';  // 'inst' | 'extra'

  function openCBTechModal() {
    if (!selectedStock) return;
    const cbs = (selectedStock.cbs || []).filter(c => c.cbCode);
    if (cbs.length === 0) {
      alert('此股無 CB 交易資料');
      return;
    }
    if (!selectedCBTab || !cbs.some(c => c.cbCode === selectedCBTab)) {
      selectedCBTab = selectedStock.mainCB?.cbCode || cbs[0].cbCode;
    }

    document.getElementById('cbtech-modal').classList.add('show');
    bindCBTechFolderTabs();
    bindQuotaGroup('tech-quota-group-cb');
    syncQuotaUI();
    refreshCBTechModal();
  }

  function bindCBTechFolderTabs() {
    const host = document.querySelector('#cbtech-modal .tech-folder-tabs');
    if (!host || host.dataset.bound === '1') return;
    host.dataset.bound = '1';
    host.addEventListener('click', (e) => {
      const btn = e.target.closest('.tech-folder-tab');
      if (!btn) return;
      const which = btn.dataset.folder;
      if (!which || which === cbTechActiveFolder) return;
      cbTechActiveFolder = which;
      syncCBTechFolderTab();
    });
  }

  function syncCBTechFolderTab() {
    document.querySelectorAll('#cbtech-modal .tech-folder-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.folder === cbTechActiveFolder));
    document.querySelectorAll('#cbtech-modal .tech-folder-panel').forEach(p =>
      p.classList.toggle('hidden', p.dataset.panel !== cbTechActiveFolder));
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  // 三張 CB 圖共用的日期軸 (從 cb.ohlcv 取最近 N 個交易日)
  let cbTechSharedDates = [];

  function refreshCBTechModal() {
    if (!selectedStock) return;
    renderCBTechModalTitle();
    syncCBTechFolderTab();

    // 共用 X 軸 (CB ohlcv 日期 ∩ stock 收盤日期)
    const cb = (selectedStock.cbs || []).find(c => c.cbCode === selectedCBTab);
    const ohlcv = cb?.ohlcv || selectedStock.cbOhlcv || [];
    const stockCloses = selectedStock.trading?.['收盤價'] || {};
    const cbDateSet = new Set(ohlcv.map(r => r.date));
    const intersectDates = [];
    for (const d of Object.keys(stockCloses)) {
      if (cbDateSet.has(d)) intersectDates.push(d);
    }
    intersectDates.sort();
    cbTechSharedDates = intersectDates.slice(-APP_CONFIG.techAnalysisDays);

    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      try {
        const meta = Charts.renderCBTechPriceChart(
          'cbtech-price-chart', selectedStock, selectedCBTab, cbTechSharedDates);
        const priceMetaEl = document.getElementById('cbtech-price-meta');
        if (priceMetaEl) {
          priceMetaEl.textContent = meta?.latest
            ? `收 ${meta.latest.close?.toFixed(2)} · 量 ${meta.latest.volume?.toLocaleString() ?? '-'}`
            : '';
        }
      } catch (err) { console.error('[CBTech] price chart failed:', err); }

      // 法人 tab — 3 個 sub-charts
      renderCBTechInstSub('cbtech-foreign-chart', '外資',   'cbtech-foreign-meta');
      renderCBTechInstSub('cbtech-invest-chart',  '投信',   'cbtech-invest-meta');
      renderCBTechInstSub('cbtech-dealer-chart',  '自營商', 'cbtech-dealer-meta');

      // 溢價/餘額 tab — 2 個 sub-charts (第 3 格保留)
      renderCBTechPremium();
      renderCBTechBalance();
    }, 60)));
  }

  function renderCBTechInstSub(canvasId, which, metaId) {
    const meta = Charts.renderCBTechInstChart(
      canvasId, selectedStock, selectedCBTab, which, cbTechSharedDates);
    const el = document.getElementById(metaId);
    if (!el) return;
    if (!meta || meta.latest == null) { el.textContent = ''; return; }
    const sign = meta.latest > 0 ? '+' : '';
    const cum = meta.cumulative != null ? meta.cumulative.toLocaleString() : '-';
    el.innerHTML = `買賣超 <strong class="${cc(meta.latest)}">${sign}${meta.latest.toLocaleString()}張</strong>`
                 + ` &middot; 累積 <strong>${cum}張</strong>`;
  }

  function renderCBTechPremium() {
    const meta = Charts.renderCBTechExtraChart(
      'cbtech-premium-chart', selectedStock, selectedCBTab, 'premium', cbTechSharedDates);
    const el = document.getElementById('cbtech-premium-meta');
    if (!el) return;
    const v = meta?.latest;
    el.innerHTML = v == null
      ? ''
      : `當前溢價率 <strong class="${cc(v)}">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</strong>`;
  }

  function renderCBTechBalance() {
    const meta = Charts.renderCBTechExtraChart(
      'cbtech-balance-chart', selectedStock, selectedCBTab, 'balance', cbTechSharedDates);
    const el = document.getElementById('cbtech-balance-meta');
    if (!el) return;
    const d = meta?.latest;
    if (!d || (d.thisWeek == null && d.lastWeek == null)) { el.textContent = ''; return; }
    const chgSign = (d.change != null && d.change > 0) ? '+' : '';
    el.innerHTML = `本週 <strong>${d.thisWeek != null ? d.thisWeek.toLocaleString() : '-'}張</strong>`
                 + (d.change != null
                    ? ` &middot; 增減 <strong class="${cc(-d.change)}">${chgSign}${d.change.toLocaleString()}</strong>`
                    : '');
  }

  // CB Modal 標題:◀ [選中CB為主+其他CB為 pill] ▶
  //   - 無 CB → 顯示 stock code/name
  //   - 單 CB → 標題就是該 CB
  //   - 多 CB → tab 形式,active 為標題,其餘為 pill,點擊切換
  function renderCBTechModalTitle() {
    const el = document.getElementById('cbtech-modal-title');
    if (!el || !selectedStock) return;
    const idx = filteredData.findIndex(s => s.code === selectedStock.code);
    const canPrev = idx > 0;
    const canNext = idx >= 0 && idx < filteredData.length - 1;
    const cbs = (selectedStock.cbs || []).filter(c => c.cbCode);

    let midHtml;
    if (cbs.length === 0) {
      const fullLabel = `${selectedStock.code} ${selectedStock.name || ''}`;
      midHtml = `<span class="tech-nav-label" title="${fullLabel}">${fullLabel}</span>`;
    } else {
      // CB tabs (active 大、其他 pill 小);整段塞進 .tech-nav-label 同樣 280px 槽位,維持與個股 modal 對齊
      const pillsHtml = cbs.map(cb => {
        const active = cb.cbCode === selectedCBTab;
        const cls = 'cbtech-title-tab' + (active ? ' active' : '');
        return `<button class="${cls}" data-cbcode="${cb.cbCode}" title="${cb.cbCode} ${cb.cbName || ''}">${cb.cbCode} ${cb.cbName || ''}</button>`;
      }).join('');
      midHtml = `<span class="cbtech-title-tabs">${pillsHtml}</span>`;
    }

    el.innerHTML =
      `<button class="tech-nav-arrow" id="cbtech-nav-prev" ${canPrev ? '' : 'disabled'} title="上一檔">&#x25C0;</button>` +
      midHtml +
      `<button class="tech-nav-arrow" id="cbtech-nav-next" ${canNext ? '' : 'disabled'} title="下一檔">&#x25B6;</button>`;
    document.getElementById('cbtech-nav-prev')?.addEventListener('click', () => navigateCBTechModal(-1));
    document.getElementById('cbtech-nav-next')?.addEventListener('click', () => navigateCBTechModal(1));

    // CB tab 點擊 → 切換 selectedCBTab
    el.querySelectorAll('.cbtech-title-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.cbcode;
        if (!code || code === selectedCBTab) return;
        selectedCBTab = code;
        refreshCBTechModal();
      });
    });
  }

  function navigateCBTechModal(dir) {
    if (!selectedStock) return;
    const idx = filteredData.findIndex(s => s.code === selectedStock.code);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= filteredData.length) return;
    const newStock = filteredData[newIdx];
    showDetail(newStock);
    // 切換股票後重設 CB 選擇
    const cbs = (newStock.cbs || []).filter(c => c.cbCode);
    selectedCBTab = newStock.mainCB?.cbCode || cbs[0]?.cbCode || null;
    refreshCBTechModal();
    // 並排模式下個股技術分析也要連動切到同一檔
    if (document.getElementById('tech-modal')?.classList.contains('show')) {
      refreshTechModalForCurrentStock();
    }
  }

  function closeCBTechModal(event) {
    if (event && event.target && event.target.id !== 'cbtech-modal') return;
    document.getElementById('cbtech-modal').classList.remove('show');
    Charts.destroyCBTech();
    exitTechSplitMode();
  }

  // 目前選的 CB (給 CB 技術分析 Modal 使用)
  let selectedCBTab = null;

  function buildPriceInfoHTML(stock) {
    const cls = (stock.priceChange || 0) > 0 ? 'text-up' : (stock.priceChange || 0) < 0 ? 'text-down' : '';
    const sign = (stock.priceChange || 0) >= 0 ? '+' : '';

    return `
      <div class="cb-card">
        <div class="info-grid info-grid-sm">
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
        </div>
      </div>`;
  }

  function buildCBInfoHTML(stock) {
    if (!stock.cbs || stock.cbs.length === 0) {
      let html = '<div class="text-muted">無 CB 交易資料</div>';
      if (stock.callRights?.length > 0) html += buildCBEventsHTML(stock);
      if (stock.primaryMarket?.length > 0) html += buildPrimaryMarketHTML(stock);
      return html;
    }

    // 股票層級事件
    let html = '';
    if (stock.callRights?.length > 0 || stock.priceAdjust?.length > 0) {
      html += buildCBEventsHTML(stock);
    }

    html += '<div class="cb-list">';
    for (const cb of stock.cbs) {
      const cls = (cb.change || 0) > 0 ? 'text-up' : (cb.change || 0) < 0 ? 'text-down' : '';
      const changeSign = (cb.change || 0) >= 0 ? '+' : '';

      let cbPrem = null;
      if (cb.close && cb.conversionPrice && stock.latestClose) {
        const convVal = (100 / cb.conversionPrice) * stock.latestClose;
        cbPrem = ((cb.close - convVal) / convVal) * 100;
      }
      const premCls = cbPrem != null ? (cbPrem > 0 ? 'text-up' : cbPrem < 0 ? 'text-down' : '') : '';

      const auctionBtn = cb.auction
        ? `<button class="btn-auction" onclick="App.showAuctionModal('${cb.cbCode}')">CB開標統計表</button>`
        : '';

      // 事件標籤
      let badges = '';
      if (cb.conversionStop?.length > 0) {
        badges += '<span class="cb-badge cb-badge-warn">停止轉換</span>';
      }
      if (cb.callDate) {
        badges += '<span class="cb-badge cb-badge-danger">強制贖回</span>';
      }

      const f = (label, val, extra) => `<div class="info-item"><span class="info-label">${label}</span><span class="info-value${extra ? ' ' + extra : ''}">${val ?? '-'}</span></div>`;

      const balChgCls = cb.balChange > 0 ? 'text-down' : cb.balChange < 0 ? 'text-up' : '';
      const balChg = cb.balChange != null
        ? (cb.balChange > 0 ? '+' : '') + cb.balChange.toLocaleString()
        : null;

      html += `
        <div class="cb-card">
          <div class="cb-card-header">
            <span class="cb-code">${cb.cbCode}</span>
            <span class="cb-name">${cb.cbName || ''}</span>
            ${badges}
            ${auctionBtn}
          </div>
          <div class="info-grid info-grid-sm">
            ${f('收盤', cb.close?.toFixed(2), cls)}
            ${f('漲跌', cb.change != null ? changeSign + cb.change.toFixed(2) : null, cls)}
            ${f('成交量', cb.volume?.toLocaleString())}
            ${f('CB溢價率', cbPrem != null ? (cbPrem >= 0 ? '+' : '') + cbPrem.toFixed(2) + '%' : null, premCls)}
            ${f('成交金額', cb.amount ? Number(cb.amount).toLocaleString() : null)}

            ${f('轉換價', cb.conversionPrice?.toFixed(2))}
            ${f('發行總額', cb.actualTotal != null ? cb.actualTotal + '百萬' : null)}
            ${f('流通餘額', cb.outstandingPct != null ? cb.outstandingPct.toFixed(1) + '%' : null)}
            ${f('流通餘額(張)', cb.balThisWeek != null ? cb.balThisWeek.toLocaleString() : null)}
            ${f('餘額增減', balChg, balChgCls)}

            ${f('轉換期間', cb.conversionPeriod ? `<span style="font-size:11px">${cb.conversionPeriod}</span>` : null)}
            ${f('到期日', cb.maturityDate)}
            ${f('最近賣回日', cb.nearestPutDate)}
            ${f('賣回日', cb.nextPutDate)}
            ${f('擔保', cb.guarantee)}

            ${cb.business ? `<div class="info-item info-item-wide"><span class="info-label">經營項目</span><span class="info-value" style="font-size:11px">${cb.business}</span></div>` : ''}
          </div>
          ${buildCBDetailToggle(cb)}
        </div>`;
    }
    html += '</div>';

    if (stock.primaryMarket?.length > 0) html += buildPrimaryMarketHTML(stock);
    return html;
  }

  function buildCBEventsHTML(stock) {
    let html = '<div class="cb-events">';

    if (stock.callRights) {
      for (const cr of stock.callRights) {
        html += `<div class="cb-event cb-event-danger">
          <span class="cb-event-icon">!</span>
          <div class="cb-event-content">
            <strong>公司執行贖回權</strong>
            <span class="cb-event-date">${cr.reportDate || ''}</span>
            <div class="cb-event-detail">${cr.subject || ''}</div>
            ${cr.asoExpiry ? `<div class="cb-event-detail">ASO到期: ${cr.asoExpiry}</div>` : ''}
          </div>
        </div>`;
      }
    }

    if (stock.priceAdjust) {
      for (const pa of stock.priceAdjust) {
        html += `<div class="cb-event cb-event-info">
          <span class="cb-event-icon">i</span>
          <div class="cb-event-content">
            <strong>轉換價格調整 (${pa.type || ''})</strong>
            <span class="cb-event-date">${pa.reportDate || ''}</span>
            <div class="cb-event-detail">${pa.subject || ''}</div>
            ${pa.newPrice ? `<div class="cb-event-detail">新轉換價: <strong>${pa.newPrice}</strong></div>` : ''}
          </div>
        </div>`;
      }
    }

    html += '</div>';
    return html;
  }

  function buildCBDetailToggle(cb) {
    const hasDetail = cb.issueDate || cb.listDate || cb.couponRate != null ||
                      cb.remainYears != null || cb.issueConvPrice || cb.underwriter ||
                      cb.nearestPutPrice != null || cb.nearestPutYield != null ||
                      cb.callDate || cb.conversionStop?.length > 0;
    if (!hasDetail) return '';

    const f = (label, val, extra) => val ? `<div class="info-item"><span class="info-label">${label}</span><span class="info-value${extra ? ' ' + extra : ''}">${val}</span></div>` : '';

    let detail = '<div class="info-grid info-grid-sm">';
    detail += f('發行日', cb.issueDate);
    detail += f('掛牌日', cb.listDate);
    detail += f('票面利率', cb.couponRate != null ? cb.couponRate + '%' : null);
    detail += f('剩餘年期', cb.remainYears != null ? cb.remainYears.toFixed(2) + '年' : null);
    detail += f('發行時轉換價', cb.issueConvPrice);
    detail += f('承銷機構', cb.underwriter);
    detail += f('賣回價格', cb.nearestPutPrice);
    detail += f('賣回殖利率', cb.nearestPutYield != null ? cb.nearestPutYield + '%' : null);
    detail += f('強制贖回日', cb.callDate, 'text-down');

    if (cb.conversionStop?.length > 0) {
      for (const s of cb.conversionStop) {
        detail += `<div class="info-item info-item-wide"><span class="info-label">停止轉換</span><span class="info-value" style="font-size:11px">${s.startDate}~${s.endDate} (${s.reason})</span></div>`;
      }
    }
    detail += '</div>';

    return `<div class="cb-detail-toggle">
      <button class="btn-detail-toggle" onclick="this.parentElement.classList.toggle('open');this.textContent=this.parentElement.classList.contains('open')?'收起詳細':'更多資訊'">更多資訊</button>
      <div class="cb-detail-content">${detail}</div>
    </div>`;
  }

  // 狀態徽章 (VCP / 三線) — stock 層級,所有 CB 卡共用
  function buildStatusBadgesHTML(stock) {
    const flags = stock.statusFlags;
    if (!flags) return '';
    const mk = (cls, label, info) => {
      if (!info) return '';
      const streak = Number(info.streak) || 0;
      const text = streak > 0 ? `${label}·${streak}` : label;
      const tip = `${label} 連續 ${streak} 天 / 累計 ${info.total ?? streak} 天`;
      return `<span class="badge ${cls}" title="${tip}">${text}</span>`;
    };
    return mk('badge-vcp', 'VCP', flags.vcp)
         + mk('badge-sanxian', '三線', flags.sanxian);
  }

  // 初級市場資訊 — 三大階段 (近期掛牌 / 近期生效 / 董事會公告)
  // CBAS 為主、元大次之、富邦第三;備註合併三方
  const PM_STAGE_OF = {
    cbas_listed:    'listed',    fubon_listed: 'listed',  yuanta_listed: 'listed',
    cbas_effective: 'effective', fubon_filing: 'effective',
    cbas_board:     'board',     fubon_board:  'board',   yuanta_board:  'board'
  };
  const PM_SOURCE_OF = {
    cbas_listed: '統一', cbas_effective: '統一', cbas_board: '統一',
    yuanta_listed: '元大', yuanta_board: '元大',
    fubon_listed: '富邦', fubon_filing: '富邦', fubon_board: '富邦'
  };
  // 排序:CBAS 0 > 元大 1 > 富邦 2
  const PM_SOURCE_RANK = {
    cbas_listed: 0, cbas_effective: 0, cbas_board: 0,
    yuanta_listed: 1, yuanta_board: 1,
    fubon_listed: 2, fubon_filing: 2, fubon_board: 2
  };
  const PM_STAGE_LABEL = {
    listed: '近期掛牌', effective: '近期生效', board: '董事會公告'
  };
  const PM_STAGE_ORDER = ['listed', 'effective', 'board'];

  function buildPrimaryMarketHTML(stock) {
    // 已上市 CB (有價格) → 不再顯示初級市場
    const listedCBs = new Set(
      (stock.cbs || []).filter(c => c.close != null && c.cbCode).map(c => c.cbCode)
    );

    // 每檔 CB 只留一張卡。階段優先序 listed > effective > board,
    // 但「CBAS 分類權威最高」:CBAS 有給 stage 就用 CBAS 的
    // (fubon/yuanta 在 Google Sheet 上偶有 section 邊界錯,例如 30285
    //  增你強五其實是董事會公告,卻被 fubon 排到 fubon_listed)。
    // 同 CBAS 內若多個 stage (理論不會) 才用 PRIORITY 取最高。
    const PRIORITY = { listed: 0, effective: 1, board: 2 };
    const cbasStageOfCB = new Map();
    const otherStagesOfCB = new Map();
    for (const pm of (stock.primaryMarket || [])) {
      if (!pm || listedCBs.has(pm.cbCode)) continue;
      const stage = PM_STAGE_OF[pm.section];
      if (!stage) continue;
      const isCbas = String(pm.section || '').startsWith('cbas_');
      if (isCbas) {
        const prev = cbasStageOfCB.get(pm.cbCode);
        if (prev == null || PRIORITY[stage] < PRIORITY[prev]) {
          cbasStageOfCB.set(pm.cbCode, stage);
        }
      } else {
        if (!otherStagesOfCB.has(pm.cbCode)) otherStagesOfCB.set(pm.cbCode, []);
        otherStagesOfCB.get(pm.cbCode).push(stage);
      }
    }
    const topStageOfCB = new Map();
    const allCBs = new Set([...cbasStageOfCB.keys(), ...otherStagesOfCB.keys()]);
    for (const cb of allCBs) {
      if (cbasStageOfCB.has(cb)) {
        topStageOfCB.set(cb, cbasStageOfCB.get(cb));
      } else {
        const stages = otherStagesOfCB.get(cb) || [];
        let best = null, bestP = 99;
        for (const s of stages) {
          if (PRIORITY[s] < bestP) { best = s; bestP = PRIORITY[s]; }
        }
        if (best) topStageOfCB.set(cb, best);
      }
    }

    // 分組 (只保留 cbCode 的 top stage)
    const groups = new Map();
    for (const pm of (stock.primaryMarket || [])) {
      if (!pm || listedCBs.has(pm.cbCode)) continue;
      const stage = PM_STAGE_OF[pm.section];
      if (!stage || stage !== topStageOfCB.get(pm.cbCode)) continue;
      const key = stage + '|' + pm.cbCode;
      let g = groups.get(key);
      if (!g) {
        g = { stage, cbCode: pm.cbCode, cbName: pm.cbName || '', items: [] };
        groups.set(key, g);
      }
      g.items.push(pm);
      if (!g.cbName && pm.cbName) g.cbName = pm.cbName;
    }
    if (groups.size === 0) return '';

    const sorted = [...groups.values()].sort((a, b) =>
      (PM_STAGE_ORDER.indexOf(a.stage) - PM_STAGE_ORDER.indexOf(b.stage))
      || a.cbCode.localeCompare(b.cbCode)
    );

    let html = '<div class="primary-market-section"><h4>初級市場資訊</h4>';
    for (const grp of sorted) {
      // CBAS 排前面;前端 pickField 從第一個 items 開始找非空值
      grp.items.sort((a, b) =>
        (PM_SOURCE_RANK[a.section] ?? 99) - (PM_SOURCE_RANK[b.section] ?? 99));
      html += renderPMCard(grp, stock);
    }
    html += '</div>';
    return html;
  }

  /** 從 polling 字串 (例: "5/25-5/27競拍" / "5/27") 抽出截標日 → "YYYYMMDD"。
   *  年份用 latestDataDate 推斷 (跨年情境少見,先簡化處理)。 */
  function _parsePollingEndDate(polling) {
    if (!polling) return null;
    const matches = [...String(polling).matchAll(/(\d{1,2})\/(\d{1,2})/g)];
    if (matches.length === 0) return null;
    const last = matches[matches.length - 1];
    const m = String(last[1]).padStart(2, '0');
    const d = String(last[2]).padStart(2, '0');
    const year = latestDataDate && latestDataDate.length >= 4
      ? latestDataDate.substring(0, 4)
      : String(new Date().getFullYear());
    return year + m + d;
  }

  /** 截標日的前一交易日 (週末倒推到週五),回 "YYYYMMDD"。
   *  不考慮國定假日 — 假日撞到的話 MA5 會晚 1 天才浮出,可接受。 */
  function _expectedPrevTradingDay(endYmd) {
    const y = +endYmd.slice(0, 4), m = +endYmd.slice(4, 6) - 1, dd = +endYmd.slice(6, 8);
    const d = new Date(y, m, dd);
    d.setDate(d.getDate() - 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }

  /** 取截標日「前」5 個交易日的 MA5 (收盤價平均)。
   *  必須先確認資料涵蓋到截標日的前一交易日 — 否則拿出來的會是更舊的 5 天 → 失真。
   *  e.g. 5/28 截標,但 stock.tradingDates 最新只到 5/26 (5/27 收盤資料還沒進),
   *  就該回 null,不要顯示估價。 */
  function _ma5BeforeDate(stock, endDateYmd) {
    const dates = stock?.tradingDates || [];
    const closes = stock?.trading?.['收盤價'];
    if (!dates.length || !closes) return null;
    const eligible = dates.filter(d => d < endDateYmd);
    if (eligible.length < 5) return null;
    const need = _expectedPrevTradingDay(endDateYmd);
    if (eligible[eligible.length - 1] < need) return null;
    const last5 = eligible.slice(-5);
    let sum = 0, count = 0;
    for (const d of last5) {
      const v = closes[d];
      if (v != null) { sum += v; count++; }
    }
    return count === 5 ? sum / 5 : null;
  }

  function renderPMCard(grp, stock) {
    // 跨來源取第一個非空值 (items 已排好序:統一 > 元大 > 富邦)
    const pick = (...fields) => {
      for (const it of grp.items) {
        for (const f of fields) {
          const v = it[f];
          if (v != null && v !== '') return v;
        }
      }
      return null;
    };
    const f = (label, val) => (val == null || val === '')
      ? ''
      : `<div class="info-item"><span class="info-label">${label}</span><span class="info-value">${val}</span></div>`;
    const wide = (label, html) =>
      `<div class="info-item info-item-wide"><span class="info-label">${label}</span><span class="info-value" style="font-size:11px">${html}</span></div>`;

    const capital     = pick('capital');
    const tcriGuarantee = pick('tcriGuarantee', 'guarantee');
    const issueAmount = pick('issueAmount');
    const underwriter = pick('underwriter');
    const putCondition = pick('putCondition');
    const years       = pick('years');
    const premiumRate = pick('premiumRate', 'premium');
    const convPrice   = pick('convPrice', 'conversionPrice');
    const convValue   = pick('convValue');
    const listingDate = pick('listingDate');
    const opDate      = pick('opDate');
    const polling     = pick('polling', 'bidding');
    const announcementDate = pick('announcementDate');
    const filingDate  = pick('filingDate');
    const effectiveDate = pick('effectiveDate');

    // 備註 — 合併三家來源
    const remarks = grp.items
      .filter(it => it.remark)
      .map(it => `<span class="pm-remark-src">[${PM_SOURCE_OF[it.section] || ''}]</span> ${it.remark}`);
    const remarkHtml = remarks.length ? remarks.join('<br>') : null;

    let body = '';
    if (grp.stage === 'listed') {
      body =
        f('股本', capital) + f('TCRI/擔保', tcriGuarantee) +
        f('發行量(億)', issueAmount) + f('主辦券商', underwriter) +
        f('賣回條件', putCondition) + f('年期', years) +
        f('轉換溢價率', premiumRate) + f('轉換價', convPrice) +
        f('轉換價值', convValue) + f('掛牌日', listingDate) +
        f('拆解日', opDate) +
        (remarkHtml ? wide('備註', remarkHtml) : '') +
        f('詢圈/競拍', polling);
    } else if (grp.stage === 'effective') {
      body =
        f('股本', capital) + f('TCRI/擔保', tcriGuarantee) +
        f('發行量(億)', issueAmount) + f('主辦券商', underwriter) +
        f('(暫定)賣回條件', putCondition) + f('年期', years) +
        f('(暫定)溢價率', premiumRate) +
        (remarkHtml ? wide('備註', remarkHtml) : '') +
        f('詢圈/競拍', polling) + f('公告日', announcementDate) +
        f('送件日', filingDate) + f('預計生效日', effectiveDate);
    } else { // board
      body =
        f('股本', capital) + f('TCRI/擔保', tcriGuarantee) +
        f('發行量(億)', issueAmount) + f('主辦券商', underwriter) +
        f('(暫定)賣回條件', putCondition) + f('年期', years) +
        f('(暫定)溢價率', premiumRate) +
        (remarkHtml ? wide('備註', remarkHtml) : '') +
        f('詢圈/競拍', polling) + f('公告日', announcementDate);
    }

    // 有 twsa 競拍 PDF → 即使還沒掛牌也讓使用者點開開標統計表
    const auctionBtn = auctionByCbCode.has(grp.cbCode)
      ? `<button class="btn-auction" onclick="App.showAuctionModal('${grp.cbCode}')">CB開標統計表</button>`
      : '';

    // 得標預估價:截標日前 5 交易日 MA5 / 轉換價 × 100 × {1.20,1.25,1.30,1.35}
    const estimateHtml = _buildEstimateHtml(stock, convPrice, polling);

    return `<div class="cb-card">
      <div class="cb-card-header">
        <span class="cb-code">${grp.cbCode}</span>
        <span class="cb-name">${grp.cbName}</span>
        <span class="cb-type">${PM_STAGE_LABEL[grp.stage]}</span>
        ${auctionBtn}
      </div>
      <div class="info-grid info-grid-sm">${body}</div>
      ${estimateHtml}
    </div>`;
  }

  function _buildEstimateHtml(stock, convPrice, polling) {
    const convNum = Number(convPrice);
    if (!stock || !(convNum > 0) || !polling) return '';
    const endDate = _parsePollingEndDate(polling);
    if (!endDate) return '';
    const ma5 = _ma5BeforeDate(stock, endDate);
    if (ma5 == null) return '';
    const ratio = ma5 / convNum * 100;
    const fmtD = d => `${d.slice(0,4)}/${d.slice(4,6)}/${d.slice(6,8)}`;
    const e = m => (ratio * m).toFixed(2);
    return `<div class="pm-estimate">
      <div class="pm-estimate-title">得標預估價
        <span class="pm-estimate-meta">截標 ${fmtD(endDate)} · 前5日MA5 ${ma5.toFixed(2)} / 轉換價 ${convNum}</span>
      </div>
      <div class="pm-estimate-grid">
        <div><span class="pm-estimate-k">×1.20</span><span class="pm-estimate-v">${e(1.20)}</span></div>
        <div><span class="pm-estimate-k">×1.25</span><span class="pm-estimate-v">${e(1.25)}</span></div>
        <div><span class="pm-estimate-k">×1.30</span><span class="pm-estimate-v">${e(1.30)}</span></div>
        <div><span class="pm-estimate-k">×1.35</span><span class="pm-estimate-v">${e(1.35)}</span></div>
      </div>
    </div>`;
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

    html += `</tbody></table>`;
    return html;
  }

  function buildCBInstInfoHTML(stock, cbCode) {
    // 多 CB 切換: 優先用指定 cbCode 對應的 cb.bondInst*,fallback 回 stock 層級 (mainCB)
    let inst = null, dates = [];
    if (cbCode && stock.cbs) {
      const cb = stock.cbs.find(c => c.cbCode === cbCode);
      if (cb?.bondInstData) {
        inst = cb.bondInstData;
        dates = cb.bondInstDates || [];
      }
    }
    if (!inst) {
      inst = stock.cbBondInstitutional;
      dates = stock.cbBondInstitutionalDates || [];
    }
    if (!inst || dates.length === 0) {
      return '<div class="text-muted">無 CB 三大法人資料</div>';
    }

    const recent = dates.slice(-10).reverse();
    let html = `<table class="inst-summary-table"><thead><tr>
      <th>日期</th><th>外資(張)</th><th>投信(張)</th><th>自營商(張)</th><th>合計(張)</th>
    </tr></thead><tbody>`;

    for (const d of recent) {
      const f = inst['外資買賣超']?.[d] ?? null;
      const inv = inst['投信買賣超']?.[d] ?? null;
      const deal = inst['自營商買賣超']?.[d] ?? null;
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

  function buildMarginInfoHTML(stock) {
    const dates = stock.marginDates || [];
    if (!stock.margin || dates.length === 0) {
      return '<div class="text-muted">無融資融券資料</div>';
    }

    // 摘要 (今日餘額/增減)
    const mb  = stock.latestMarginBalance;
    const mc  = stock.latestMarginChange;
    const sb  = stock.latestShortBalance;
    const sc  = stock.latestShortChange;
    let html = `<div class="info-grid">
      <div class="info-item"><span class="info-label">融資餘額(張)</span><span class="info-value">${mb != null ? mb.toLocaleString() : '-'}</span></div>
      <div class="info-item"><span class="info-label">融資增減(張)</span><span class="info-value ${cc(mc)}">${fmtInst(mc)}</span></div>
      <div class="info-item"><span class="info-label">融券餘額(張)</span><span class="info-value">${sb != null ? sb.toLocaleString() : '-'}</span></div>
      <div class="info-item"><span class="info-label">融券增減(張)</span><span class="info-value ${cc(sc)}">${fmtInst(sc)}</span></div>
    </div>`;

    // 近10日明細
    const recent = dates.slice(-10).reverse();
    html += `<table class="inst-summary-table"><thead><tr>
      <th>日期</th><th>融資餘額</th><th>融資增減</th><th>融券餘額</th><th>融券增減</th>
    </tr></thead><tbody>`;
    for (const d of recent) {
      const a = stock.margin['融資餘額']?.[d] ?? null;
      const b = stock.margin['融資增減']?.[d] ?? null;
      const c = stock.margin['融券餘額']?.[d] ?? null;
      const e = stock.margin['融券增減']?.[d] ?? null;
      const dateLabel = d.length >= 8 ? d.substring(4, 6) + '/' + d.substring(6, 8) : d;
      html += `<tr>
        <td>${dateLabel}</td>
        <td>${a != null ? a.toLocaleString() : '-'}</td>
        <td class="${cc(b)}">${fmtInst(b)}</td>
        <td>${c != null ? c.toLocaleString() : '-'}</td>
        <td class="${cc(e)}">${fmtInst(e)}</td>
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
    // 一般情境:selectedStock.cbs 有對應 cb → 直接用 cb.auction (含 cbName)
    // 例外情境:CB 已開標但尚未掛牌 (例: 47491 → 還沒進 stock.cbs),
    //          fallback 到全域 auctionByCbCode,顯示用 pdf.stockName。
    let a = null, cbName = '';
    if (selectedStock?.cbs) {
      const cb = selectedStock.cbs.find(c => String(c.cbCode) === String(cbCode));
      if (cb?.auction) { a = cb.auction; cbName = cb.cbName || ''; }
    }
    if (!a) {
      a = auctionByCbCode.get(String(cbCode));
      if (a) cbName = a.pdf?.stockName || '';
    }
    if (!a) return;

    const pdf = a.pdf || {};
    const info = pdf.info || {};
    const priceRows = pdf.priceRows || [];

    document.getElementById('auction-modal-title').textContent =
      `${cbCode} ${cbName} 開標統計表`;

    const f = (label, val) => `<div class="info-item"><span class="info-label">${label}</span><span class="info-value">${val ?? '-'}</span></div>`;
    // 投標期間 "YYYY/MM/DD~YYYY/MM/DD" 太長,在 ~ 後斷成 2 行
    const fmtPeriod = (v) => {
      if (!v) return v;
      const m = String(v).match(/^(.+?~)(.+)$/);
      return m ? `${m[1]}<br>${m[2]}` : String(v);
    };

    let html = '<div class="info-grid info-grid-sm">' +
      f('發行公司', a['發行公司']) +
      f('主辦承銷商', a['主辦承銷商']) +
      f('發行性質', a['發行性質']) +
      f('承銷股數', a['承銷股數']) +
      f('競拍股數', a['競拍股數']) +
      f('投標期間', fmtPeriod(a['投標期間'])) +
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
      rawCBIssuance = rawResults.cbIssuance || null;
      rawCalendar = rawResults.cbasCalendar || null;
      auctionByCbCode = _buildAuctionByCbCode(rawResults.twsaAuction);
      etfLoaded = false; // 重新載入 ETF CB 交叉比對
      calendarLoaded = false;
      SheetsAPI.saveToStorage(rawResults);
      updateDateDisplay();
      applyCurrentFilters();
      // 若使用者停在 CB 日曆 tab,順手重畫一次帶入新 events + auction
      if (currentTab === 'calendar') initCalendarView();
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

  /** 分頁切換 */
  async function switchTab(tab) {
    if (tab === currentTab) return;
    currentTab = tab;

    // 更新 tab 按鈕樣式
    document.getElementById('tab-cb').classList.toggle('active', tab === 'cb');
    document.getElementById('tab-etf').classList.toggle('active', tab === 'etf');
    document.getElementById('tab-calendar').classList.toggle('active', tab === 'calendar');

    // 關閉 detail panel
    closeDetail();

    if (tab === 'cb') {
      buildFilterPanel();
      applyCurrentFilters();
    } else if (tab === 'etf') {
      await initETFView();
    } else if (tab === 'calendar') {
      initCalendarView();
    }
  }

  function initCalendarView() {
    if (!calendarLoaded) {
      Calendar.setData(rawCalendar, {
        onEventClick: openCBFromCalendar,
        onAuctionClick: openAuctionFromCalendar
      });
      Calendar.setAuctionList(_collectAuctionList());
      calendarLoaded = true;
    }
    Calendar.renderLegend('filter-panel');
    Calendar.render('main-table');
    const statusEl = document.getElementById('header-status');
    if (statusEl) {
      const n = (rawCalendar && rawCalendar.events) ? rawCalendar.events.length : 0;
      statusEl.textContent = `CB 日曆 | ${n} 筆事件`;
      statusEl.style.color = '';
    }
  }

  /** 蒐集所有 CB 的 auction 摘要 (給 CB 日曆側欄表格用)
   *  直接迭代 auctionByCbCode,不依賴 stockMap → 即使 CB 還沒掛牌
   *  (cbDailyTrading/Report 都還沒收錄) 也能列出。 */
  function _collectAuctionList() {
    const out = [];
    const _toNum = v => {
      if (v == null) return null;
      const n = Number(String(v).replace(/[,，]/g, ''));
      return isFinite(n) ? n : null;
    };
    for (const [cbCode, item] of auctionByCbCode) {
      const stockCode = String(cbCode).length >= 5 ? String(cbCode).substring(0, 4) : String(cbCode);
      const info = item.pdf?.info || {};
      out.push({
        stockCode,
        cbCode,
        cbName: item.pdf?.stockName || '',
        openDate: info.openDate || '',
        minWin: _toNum(info.minWin),
        avgWin: _toNum(info.avgWin),
        shares:  _toNum(item['競拍股數'])
      });
    }
    out.sort((a, b) => String(b.openDate).localeCompare(String(a.openDate)));
    return out;
  }

  /** 日曆事件點擊 → 切回 CB 分析並開該股詳情 */
  function openCBFromCalendar(cbCode) {
    if (!cbCode) return;
    const stockCode = String(cbCode).length >= 5
      ? String(cbCode).substring(0, 4) : String(cbCode);
    const stock = stockMap ? stockMap.get(stockCode) : null;
    if (!stock) return;
    switchTab('cb').then(() => showDetail(stock));
  }

  /** 日曆 auction 列點擊 → 設好 selectedStock 再開既有 auction modal
   *  (若 CB 尚未掛牌、stockMap 找不到對應股,selectedStock 留 null,
   *   showAuctionModal 會走 auctionByCbCode fallback) */
  function openAuctionFromCalendar(stockCode, cbCode) {
    if (!cbCode) return;
    const stock = (stockCode && stockMap) ? stockMap.get(stockCode) : null;
    selectedStock = stock || null;
    showAuctionModal(cbCode);
  }

  async function initETFView() {
    const statusEl = document.getElementById('header-status');
    if (!etfLoaded) {
      if (statusEl) statusEl.textContent = '載入 ETF 資料...';
      await ETFView.loadData();

      // 傳入 CB 發行資訊供交叉比對
      if (rawCBIssuance) {
        ETFView.setCBData(rawCBIssuance);
      }
      // 傳入 stockMap 供 ETF 詳情面板使用完整 CB 分析資料
      if (stockMap) {
        ETFView.setStockMap(stockMap);
      }
      etfLoaded = true;
    }

    const stats = ETFView.getStats();
    if (statusEl) statusEl.textContent = `ETF 持股分析 | ${stats.etfCount} 檔 ETF | ${stats.totalStocks} 檔持股`;

    ETFView.buildFilterPanel('filter-panel');
    ETFView.renderColumns('main-table');
  }

  return {
    init, closeDetail, getSelectedStock, refreshData, toggleMobileFilter,
    showAuctionModal, closeAuctionModal,
    openTechModal, closeTechModal,
    openCBTechModal, closeCBTechModal, openCBTechFromStock, openTechFromCB,
    switchTab, showDetail
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
