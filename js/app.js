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
  let curAuctionCode = null;   // 開標統計表 modal 目前顯示的 CB (左右鍵切換用)
  // 企業報告索引 (Drive 簡易報告 PNG + 完整報告 PDF) — code → {png_id, pdf_id, version, folder_name}
  let companyReportsByCode = {};
  let companyReportOverview = null;   // 產業鏈總覽(無股號的置頂報告)

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
      companyReportsByCode = (cached.data.companyReports && cached.data.companyReports.stocks) || {};
      companyReportOverview = (cached.data.companyReports && cached.data.companyReports.overview) || null;
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
      companyReportsByCode = (rawResults.companyReports && rawResults.companyReports.stocks) || {};
      companyReportOverview = (rawResults.companyReports && rawResults.companyReports.overview) || null;

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

    // CBAS 追價計算機 (置頂,盤中最常用)
    if (typeof CBASCalc !== 'undefined') {
      CBASCalc.init({
        getStock: (code) => (stockMap ? stockMap.get(String(code)) : null),
        listStocks: () => (stockMap
          ? [...stockMap.values()]
              .filter(s => s.cbs && s.cbs.length > 0)
              .map(s => ({ code: s.code, name: s.name || '' }))
          : [])
      });
      CBASCalc.render(panel);
    }

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
    // 公用清單 — 每個都一個 option,value 是 __public__:清單名
    for (const pubName of PublicWatchlist.getLists()) {
      const opt = document.createElement('option');
      opt.value = `__public__:${pubName}`;
      opt.textContent = `🌟${pubName}`;
      select.appendChild(opt);
    }
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
      // 公用清單(置頂,不可刪除)
      for (const pubName of PublicWatchlist.getLists()) {
        const pubRow = document.createElement('div');
        pubRow.className = 'wl-list-item';
        const pubLabel = document.createElement('span');
        pubLabel.className = 'wl-list-name';
        pubLabel.style.color = 'var(--accent)';
        const cnt = PublicWatchlist.getAll(pubName).length;
        pubLabel.textContent = `🌟${pubName} (${cnt})`;
        pubRow.appendChild(pubLabel);
        listContainer.appendChild(pubRow);
      }
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
    // 可轉債分頁是逐檔 CB,要另外套一次篩選 (CB 條件比對該檔 CB 而非個股的 mainCB)
    const cbRows = Filters.applyCBFilters(stockMap, filters);
    Table.render('main-table', filteredData, { onRowClick: showDetail, cbRows });
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
    renderCapitalRaise(stock);

    // 預設選的 CB (給 CB 技術分析 Modal 用)
    const tabCBs = (stock.cbs || []).filter(cb => cb.cbCode);
    selectedCBTab = stock.mainCB?.cbCode || tabCBs[0]?.cbCode || null;
  }

  // === 投資重點一頁式儀表板 (iframe 內嵌於 Modal;對方已開放 frame-ancestors) ===
  // 代號自動接當前股票:.../companies/<code>/
  function investDashboardURL(code) {
    return `${INVEST_DASHBOARD_BASE}${encodeURIComponent(code)}/`;
  }

  // 點「投資儀表板」→ 彈出 Modal,內嵌當前股票的一頁式儀表板
  function openInvestModal() {
    if (!selectedStock) return;
    const url = investDashboardURL(selectedStock.code);
    document.getElementById('invest-modal-title').textContent =
      `${selectedStock.code} ${selectedStock.name} · 簡易報告`;
    document.getElementById('invest-modal-body').innerHTML =
      `<iframe class="invest-frame" title="投資重點一頁式儀表板" loading="lazy" ` +
      `referrerpolicy="no-referrer-when-downgrade" src="${url}"></iframe>`;
    document.getElementById('invest-modal').classList.add('show');
  }

  function closeInvestModal(event) {
    // 只有點背景遮罩 (#invest-modal 本身) 才關閉
    if (event && event.target && event.target.id !== 'invest-modal') return;
    document.getElementById('invest-modal').classList.remove('show');
    document.getElementById('invest-modal-body').innerHTML = '';  // 卸載 iframe
  }

  // === 企業報告 (Drive 簡易報告 PNG + 完整報告 PDF) ===
  // 點 📄 → 彈 modal,內嵌 PNG;header 有「下載完整報告 PDF」按鈕
  function openCompanyReportModal() {
    if (!selectedStock) return;
    // 統一走 openReportModalFor(支援多版本切換)
    openReportModalFor(selectedStock.code, selectedStock.name);
  }

  function closeCompanyReportModal(event) {
    if (event && event.target && event.target.id !== 'company-report-modal') return;
    document.getElementById('company-report-modal').classList.remove('show');
    document.getElementById('company-report-modal-body').innerHTML = '';
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
    APP_CONFIG.techAnalysisOffset = 0;   // 每次開窗都從最新一天看起
    document.getElementById('tech-modal').classList.add('show');
    bindTechFolderTabs();
    bindTechWheel();
    bindQuotaGroup('tech-quota-group-stock');
    syncQuotaUI();
    updateTechDaysBadge();
    refreshTechModalForCurrentStock();
  }

  // ── 技術分析 modal 的時間視窗操作 ────────────────────────────────
  //   滾輪         縮放視窗長度 (APP_CONFIG.techAnalysisDays, 20~240)
  //   Shift+滾輪   左右平移
  //   拖曳圖面     左右平移 (往右拖 = 看更早的歷史)
  //   ← / →        左右平移 (按住 Shift 一次半個視窗)
  //   個股 / CB 兩個 modal 共用同一組參數,所以並排時會同步移動。
  let _techWheelPending = null;
  function bindTechWheel() {
    for (const id of ['tech-modal', 'cbtech-modal']) {
      const modal = document.getElementById(id);
      if (!modal || modal.dataset.wheelBound === '1') continue;
      modal.dataset.wheelBound = '1';
      modal.addEventListener('wheel', onTechWheel, { passive: false });
      bindTechDrag(modal);
    }
    if (!document.body.dataset.techKeyBound) {
      document.body.dataset.techKeyBound = '1';
      document.addEventListener('keydown', onTechKey);
    }
  }

  /** 目前顯示中那組資料的長度 — 用來夾住 offset 不讓視窗滑出資料範圍 */
  function _techDataLen() {
    let len = 0;
    if (document.getElementById('tech-modal')?.classList.contains('show')) {
      len = Math.max(len, selectedStock?.ohlcv?.length || 0);
    }
    if (document.getElementById('cbtech-modal')?.classList.contains('show')) {
      const cb = (selectedStock?.cbs || []).find(c => c.cbCode === selectedCBTab);
      len = Math.max(len, (cb?.ohlcv || selectedStock?.cbOhlcv || []).length);
    }
    return len;
  }

  /** 平移 n 根 K 棒 (n>0 = 往過去看) */
  function panTechWindow(n) {
    const max = techMaxOffset(_techDataLen());
    const cur = APP_CONFIG.techAnalysisOffset || 0;
    const next = Math.max(0, Math.min(max, cur + n));
    if (next === cur) return false;
    APP_CONFIG.techAnalysisOffset = next;
    updateTechDaysBadge();
    scheduleTechRedraw();
    return true;
  }

  function scheduleTechRedraw() {
    if (_techWheelPending) cancelAnimationFrame(_techWheelPending);
    _techWheelPending = requestAnimationFrame(() => {
      _techWheelPending = null;
      if (document.getElementById('tech-modal')?.classList.contains('show')) {
        refreshTechModalForCurrentStock();
      }
      if (document.getElementById('cbtech-modal')?.classList.contains('show')) {
        refreshCBTechModal();
      }
    });
  }

  /** 一根 K 棒的像素寬 — 優先讀 Chart.js 實際的繪圖區,拿不到才用容器估算 */
  function _techBarWidth(container) {
    const canvas = container.querySelector('canvas');
    const ch = canvas && typeof Chart !== 'undefined' ? Chart.getChart(canvas) : null;
    const n = ch?.data?.labels?.length;
    if (ch?.chartArea && n) return Math.max(1, ch.chartArea.width / n);
    return Math.max(2, container.getBoundingClientRect().width / APP_CONFIG.techAnalysisDays);
  }

  /** 拖曳平移 — pointer events + setPointerCapture,滑出圖外也不會斷
   *  (跟開標統計表「發行事件軸」那張 K 線同一套操作邏輯) */
  function bindTechDrag(modal) {
    let dragging = false, startX = 0, startOffset = 0, pxPerBar = 8;
    const body = modal.querySelector('.auction-modal-body') || modal;

    body.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // 只在圖表區域啟動,避免壓到 folder tab / 額度勾選框
      const box = e.target.closest('.chart-container');
      if (!box) return;
      pxPerBar = _techBarWidth(box);
      dragging = true;
      startX = e.clientX;
      startOffset = APP_CONFIG.techAnalysisOffset || 0;
      body.classList.add('tech-panning');
      try { body.setPointerCapture(e.pointerId); } catch (_) { /* 不支援就算了 */ }
      e.preventDefault();
    });

    body.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // 往右拖 (dx>0) = 內容跟著手走 = 視窗往更早的時間退 → offset 變大
      const bars = Math.round((e.clientX - startX) / pxPerBar);
      const max = techMaxOffset(_techDataLen());
      const next = Math.max(0, Math.min(max, startOffset + bars));
      if (next === (APP_CONFIG.techAnalysisOffset || 0)) return;
      APP_CONFIG.techAnalysisOffset = next;
      updateTechDaysBadge();
      scheduleTechRedraw();
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      body.classList.remove('tech-panning');
      try { body.releasePointerCapture(e.pointerId); } catch (_) { /* 已釋放 */ }
    };
    body.addEventListener('pointerup', endDrag);
    body.addEventListener('pointercancel', endDrag);
  }

  function onTechKey(e) {
    const open = document.getElementById('tech-modal')?.classList.contains('show') ||
                 document.getElementById('cbtech-modal')?.classList.contains('show');
    if (!open) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const step = e.shiftKey ? Math.max(1, Math.round(APP_CONFIG.techAnalysisDays / 2)) : 1;
    if (e.key === 'ArrowLeft') { if (panTechWindow(step)) e.preventDefault(); }
    else if (e.key === 'ArrowRight') { if (panTechWindow(-step)) e.preventDefault(); }
  }

  /** 回到最新 (offset 歸零) */
  function resetTechWindow() {
    if (!APP_CONFIG.techAnalysisOffset) return;
    APP_CONFIG.techAnalysisOffset = 0;
    updateTechDaysBadge();
    scheduleTechRedraw();
  }
  function onTechWheel(e) {
    e.preventDefault();
    // Shift + 滾輪 → 左右平移 (一次四分之一個視窗)
    if (e.shiftKey) {
      // 方向對齊「發行事件軸」那張 K 線:往下捲 = 往新的一端,往上捲 = 往舊的一端
      const step = Math.max(1, Math.round(APP_CONFIG.techAnalysisDays / 4));
      panTechWindow(e.deltaY > 0 ? -step : step);
      return;
    }
    const cur = APP_CONFIG.techAnalysisDays;
    // scroll up (deltaY<0) → 縮短時間 (zoom in)
    // scroll down (deltaY>0) → 拉長時間 (zoom out,看更早歷史)
    const ratio = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    let next = Math.round(cur * ratio);
    next = Math.max(20, Math.min(240, next));
    if (next === cur) return;
    APP_CONFIG.techAnalysisDays = next;
    // 視窗拉長後 offset 可能超出上限,夾回來,不然右邊會空一段
    const max = techMaxOffset(_techDataLen());
    if ((APP_CONFIG.techAnalysisOffset || 0) > max) APP_CONFIG.techAnalysisOffset = max;
    updateTechDaysBadge();
    scheduleTechRedraw();
  }
  function updateTechDaysBadge() {
    const off = APP_CONFIG.techAnalysisOffset || 0;
    const txt = off > 0
      ? `${APP_CONFIG.techAnalysisDays} 日 · \u2190${off}`
      : `${APP_CONFIG.techAnalysisDays} 日`;
    for (const id of ['tech-days-badge', 'cbtech-days-badge']) {
      const b = document.getElementById(id);
      if (!b) continue;
      b.textContent = txt;
      b.classList.toggle('is-panned', off > 0);
      b.title = off > 0
        ? `已往左移 ${off} 根 — 點一下回到最新`
        : '滾輪縮放 (20~240 日);拖曳圖面 / Shift+滾輪 / \u2190 \u2192 可左右移動';
      if (b.dataset.resetBound !== '1') {
        b.dataset.resetBound = '1';
        b.addEventListener('click', resetTechWindow);
      }
    }
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
      // 大戶明細 tab (集保股權分散表,每週一筆)
      buildHolderSegs();
      renderTechHolders();
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

  // ── 大戶明細 tab (集保股權分散表) ──────────────────────────────
  // 資料每週五一筆 (集保 OpenData 1-5 + 歷史回補),門檻選項一定要落在
  // 集保級距邊界上 (見 config.js HOLDER_LEVELS),不然級距切不乾淨。

  function buildHolderSegs() {
    const defs = [
      ['holder-seg-big', HOLDER_BIG_THRESHOLDS, 'holderBigLots', 'big'],
      ['holder-seg-small', HOLDER_SMALL_THRESHOLDS, 'holderSmallLots', 'small']
    ];
    for (const [hostId, opts, key, kind] of defs) {
      const host = document.getElementById(hostId);
      if (!host) continue;
      if (host.dataset.bound !== '1') {
        host.dataset.bound = '1';
        host.innerHTML = opts.map(v =>
          `<button type="button" class="holder-seg-btn ${kind}" data-lots="${v}"` +
          ` title="集保持股分級 ${holderLevelRange(kind, v)}">${v}</button>`
        ).join('');
        host.addEventListener('click', (e) => {
          const btn = e.target.closest('.holder-seg-btn');
          if (!btn) return;
          const lots = Number(btn.dataset.lots);
          if (!lots || APP_CONFIG[key] === lots) return;
          APP_CONFIG[key] = lots;
          syncHolderSegs();
          renderTechHolders();
        });
      }
    }
    syncHolderSegs();
  }

  // 門檻對應到哪幾個集保分級 (提示用):大戶 >1000 張 = 分級 15、散戶 <50 張 = 分級 1-9
  function holderLevelRange(kind, lots) {
    const idx = kind === 'big' ? holderBigIdx(lots) : holderSmallIdx(lots);
    if (idx.length === 0) return '-';
    const a = HOLDER_LEVELS[idx[0]].n, b = HOLDER_LEVELS[idx[idx.length - 1]].n;
    return a === b ? `${a}` : `${a}-${b}`;
  }

  function syncHolderSegs() {
    document.querySelectorAll('#holder-seg-big .holder-seg-btn').forEach(b =>
      b.classList.toggle('active', Number(b.dataset.lots) === APP_CONFIG.holderBigLots));
    document.querySelectorAll('#holder-seg-small .holder-seg-btn').forEach(b =>
      b.classList.toggle('active', Number(b.dataset.lots) === APP_CONFIG.holderSmallLots));
  }

  function renderTechHolders() {
    if (!selectedStock) return;
    const main = Charts.renderTechHolderChart('tech-holder-chart', selectedStock);
    const people = Charts.renderTechHolderPeopleChart('tech-holder-people-chart', selectedStock);

    const metaEl = document.getElementById('tech-holder-meta');
    const srcEl = document.getElementById('holder-source-meta');
    const peopleEl = document.getElementById('tech-holder-people-meta');
    const tblMeta = document.getElementById('tech-holder-table-meta');
    const wrap = document.getElementById('holder-table-wrap');

    if (!main) {
      if (metaEl) metaEl.textContent = '';
      if (peopleEl) peopleEl.textContent = '';
      if (tblMeta) tblMeta.textContent = '';
      if (srcEl) srcEl.textContent = '集保股權分散表 · 無此標的資料';
      if (wrap) wrap.innerHTML = '<div class="holder-empty">無集保股權分散資料</div>';
      return;
    }

    const pct = (v) => v == null ? '-' : `${v.toFixed(2)}%`;
    const chg = (v) => v == null ? '-'
      : `<strong class="${cc(v)}">${v > 0 ? '+' : ''}${v.toFixed(2)}%</strong>`;
    if (metaEl) {
      metaEl.innerHTML = `大戶 <strong style="color:#f97316">${pct(main.big)}</strong>`
        + ` (${chg(main.bigChg)}) &middot; 散戶 <strong style="color:#10b981">${pct(main.small)}</strong>`;
    }
    if (peopleEl && people) {
      const n = (v) => v == null ? '-' : v.toLocaleString();
      peopleEl.innerHTML = `大戶 <strong style="color:#f97316">${n(people.bigPeople)}</strong> 人`
        + ` &middot; 散戶 <strong style="color:#10b981">${n(people.smallPeople)}</strong> 人`;
    }
    if (srcEl) {
      srcEl.textContent = `集保 · 資料日 ${fmtHolderDate(main.date)}`;
    }

    const s = main.series;
    if (tblMeta) tblMeta.textContent = `近 ${s.dates.length} 週`;
    if (wrap) {
      const rows = [];
      for (let i = s.dates.length - 1; i >= 0; i--) {
        rows.push(
          `<tr><td>${fmtHolderDate(s.dates[i])}</td>` +
          `<td class="num" style="color:#f97316">${pct(s.big[i])}</td>` +
          `<td class="num">${chg(s.bigChg[i])}</td>` +
          `<td class="num" style="color:#10b981">${pct(s.small[i])}</td>` +
          `<td class="num">${s.bigPeople[i] == null ? '-' : s.bigPeople[i].toLocaleString()}</td>` +
          `<td class="num">${s.price[i] == null ? '-' : s.price[i].toFixed(2)}</td></tr>`
        );
      }
      wrap.innerHTML =
        '<table class="holder-table"><thead><tr>' +
        `<th>日期</th><th class="num">大戶持股%</th><th class="num">大戶增減%</th>` +
        `<th class="num">散戶持股%</th><th class="num">大戶人數</th><th class="num">股價</th>` +
        '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
    }
  }

  function fmtHolderDate(d) {
    if (!d || d.length < 8) return d || '-';
    return `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
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

    if (!document.getElementById('tech-modal')?.classList.contains('show')) {
      APP_CONFIG.techAnalysisOffset = 0;   // 單開 CB 窗時歸位;並排開啟則沿用個股窗的位移
    }
    document.getElementById('cbtech-modal').classList.add('show');
    bindCBTechFolderTabs();
    bindTechWheel();
    bindQuotaGroup('tech-quota-group-cb');
    syncQuotaUI();
    updateTechDaysBadge();
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
    cbTechSharedDates = techSlice(intersectDates);

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

      // 有開標資料 → 顯示得標預估價 (掛牌後仍保留)。轉換價用發行時原始價較準
      const cbEstimateHtml = cb.auction
        ? _buildEstimateHtml(stock, cb.issueConvPrice ?? cb.conversionPrice, _auctionEndYmd(cb.auction))
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

      // 股本(億) — 主來源 data/stock_capital.json (MOPS t187ap03 實收資本額,全上市櫃
      // 皆有且為最新值)。抓不到才退回元大「CB發行案件彙整」的股本欄 (只有近期案件,
      // 且是送件當時的股本):先比對同一檔 CB,再退回同股票其他發行案。
      const capital = (() => {
        if (stock.capital != null) return stock.capital;
        const pm = stock.primaryMarket;
        if (!pm) return null;
        const hit = pm.find(it => it.cbCode === cb.cbCode && it.capital != null)
                 || pm.find(it => it.capital != null);
        return hit ? hit.capital : null;
      })();

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
            ${capital != null ? f('股本', capital.toLocaleString(undefined, { maximumFractionDigits: 2 }) + '億') : ''}

            ${cb.business ? `<div class="info-item info-item-wide"><span class="info-label">經營項目</span><span class="info-value" style="font-size:11px">${cb.business}</span></div>` : ''}
          </div>
          ${cbEstimateHtml}
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

  /** 從開標資料的「投標期間」("YYYY/MM/DD~YYYY/MM/DD") 抽截標日 → "YYYYMMDD"。
   *  比 polling 字串可靠,且 CB 掛牌後仍保留 → 估價框可長期存在。 */
  function _auctionEndYmd(auction) {
    const period = auction && auction['投標期間'];
    if (!period) return null;
    const parts = String(period).split('~');
    const end = (parts[parts.length - 1] || '').trim();
    const m = end.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (!m) return null;
    return m[1] + String(m[2]).padStart(2, '0') + String(m[3]).padStart(2, '0');
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
    // 截標日優先用開標資料的投標期間 (較準),沒有才退回 polling 字串解析
    const pmAuction = auctionByCbCode.get(String(grp.cbCode));
    const pmEndDate = (pmAuction && _auctionEndYmd(pmAuction)) || _parsePollingEndDate(polling);
    const estimateHtml = _buildEstimateHtml(stock, convPrice, pmEndDate);

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

  function _buildEstimateHtml(stock, convPrice, endDate) {
    const convNum = Number(convPrice);
    if (!stock || !(convNum > 0) || !endDate) return '';
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

  /** 重大訊息是外部文字,直接塞進 innerHTML 之前一律轉義 */
  function esc(v) {
    return String(v ?? '').replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ── 增資進度 ────────────────────────────────────────────────────
   * 資料是 scripts/lib/capital_raise.py 從 MOPS 重大訊息「說明」抽出來的,
   * 抓不到的欄位一律留白不猜 → 這裡也就照實顯示「-」。
   * 同一案會有多則公告 (董事會決議 → 定價 → 催繳 → 收足 → 上市櫃),
   * 一律最新在上,把最新一則的關鍵日期放大成摘要。 */
  const RAISE_STAGE = {
    board: '董事會決議', pricing: '定價/認股基準日', chase: '催繳/特定人',
    paidIn: '收足股款', listing: '新股上市櫃', other: '其他'
  };

  function renderCapitalRaise(stock) {
    const sec = document.getElementById('detail-raise-section');
    const box = document.getElementById('detail-raise-info');
    if (!sec || !box) return;
    const list = (stock.capitalRaise || []).slice()
      .sort((a, b) => String(b.announcedAt).localeCompare(String(a.announcedAt)));
    if (!list.length) { sec.classList.add('hidden'); box.innerHTML = ''; return; }
    sec.classList.remove('hidden');

    // 摘要:各欄位取「最近一則有值的」,因為定價在定價公告、上市櫃日在收足公告
    const pick = (k) => (list.find(e => e[k]) || {})[k] || '';
    const kpi = [
      ['增資定價', pick('price') ? pick('price') + ' 元' : '-'],
      ['最後繳費期限', pick('payDeadline') || '-'],
      [(list.find(e => e.chaseDeadline)?.chaseKind || '催繳/特定人') + '期限',
        pick('chaseDeadline') || '-'],
      ['新股上市櫃', pick('listingDate') || '-']
    ];
    let html = '<div class="raise-kpi">' + kpi.map(([k, v]) =>
      `<div class="raise-kpi-item"><span class="raise-kpi-label">${esc(k)}</span>` +
      `<span class="raise-kpi-value${v === '-' ? ' is-empty' : ''}">${esc(v)}</span></div>`
    ).join('') + '</div>';

    html += '<div class="raise-list">';
    for (const e of list) {
      const bits = [
        e.price ? `定價 ${e.price}` : null,
        e.payDeadline ? `繳款至 ${e.payDeadline}` : null,
        e.chaseDeadline ? `${e.chaseKind || '催繳'} 至 ${e.chaseDeadline}` : null,
        e.listingDate ? `上市櫃 ${e.listingDate}` : null
      ].filter(Boolean).join('　');
      html += `<div class="raise-item">
        <div class="raise-item-head">
          <span class="raise-date">${esc(e.announcedAt || e.date || '')}</span>
          <span class="raise-stage">${esc(RAISE_STAGE[e.stage] || e.stage)}</span>
          ${e.hasDetail ? '' : '<span class="raise-nodetail" title="這則只抓到主旨,說明全文還沒補到">無說明</span>'}
        </div>
        <div class="raise-title">${esc(e.title || '')}</div>
        ${bits ? `<div class="raise-bits">${esc(bits)}</div>` : ''}
      </div>`;
    }
    html += '</div>';
    box.innerHTML = html;
  }

  function buildNewsHTML(stock) {
    const news = stock.news;
    if (!news || news.length === 0) {
      return '<div class="text-muted">無相關新聞</div>';
    }

    let html = '<div class="news-list">';
    for (const item of news) {
      const dateStr = item.date || '';
      // MOPS 重大訊息沒有外部連結,但有公告說明全文 → 點標題就地展開
      if (item.source === 'mops') {
        const detail = item.detail
          ? `<details class="news-detail"><summary>${esc(item.title)}</summary><pre>${esc(item.detail)}</pre></details>`
          : `<span class="news-title">${esc(item.title)}</span>`;
        html += `<div class="news-item is-mops">
          <span class="news-date">${esc(dateStr)}</span>
          <span class="news-badge">重訊</span>
          ${detail}
        </div>`;
        continue;
      }
      html += `<div class="news-item">
        <span class="news-date">${dateStr}</span>
        <a class="news-title" href="${item.link}" target="_blank" rel="noopener">${item.title}</a>
      </div>`;
    }
    html += '</div>';
    return html;
  }

  function showAuctionModal(cbCode, opts = {}) {
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

    // 現股 — 一律用 cbCode 前 4 碼查,不能用 selectedStock 當主要來源:
    // 左右鍵切到別檔 CB 時 selectedStock 還停在原本那檔,會把別人的 K 線畫上去。
    const stockCode = String(cbCode).length >= 5
      ? String(cbCode).substring(0, 4) : String(cbCode);
    const stock = (stockMap ? stockMap.get(stockCode) : null) || null;

    // 轉換價:已掛牌 CB 用發行時原始價,還沒掛牌就找初級市場卡
    let convPrice = null, tcri = null;
    const cbObj = stock?.cbs?.find(c => String(c.cbCode) === String(cbCode));
    if (cbObj) {
      const v = Number(cbObj.issueConvPrice ?? cbObj.conversionPrice);
      if (isFinite(v) && v > 0) convPrice = v;
    }
    for (const pm of (stock?.primaryMarket || [])) {
      if (String(pm.cbCode) !== String(cbCode)) continue;
      if (convPrice == null) {
        const v = Number(pm.convPrice ?? pm.conversionPrice);
        if (isFinite(v) && v > 0) convPrice = v;
      }
      if (tcri == null && pm.tcriGuarantee) {
        const m = String(pm.tcriGuarantee).match(/\d+/);
        if (m) tcri = m[0];
      }
    }

    const events = (rawCalendar?.events || [])
      .filter(e => String(e.cbCode) === String(cbCode));

    curAuctionCode = String(cbCode);
    syncAuctionNav();
    AuctionView.open({
      cbCode: String(cbCode),
      cbName,
      auction: a,
      stock: stock ? { code: stock.code, name: stock.name, ohlcv: stock.ohlcv || [] } : null,
      convPrice, tcri, events
    }, { keepPage: !!opts.keepPage });
  }

  function closeAuctionModal(event) {
    AuctionView.close(event);
    curAuctionCode = null;
  }

  /* ── 開標統計表:上一檔 / 下一檔 ─────────────────────────────────
   * 順序直接沿用 twsa.json 的排列 (序號 115001, 115002 … = 依開標先後),
   * 所以左右鍵是照「今年第幾檔競拍」在翻,跟你從哪個畫面點進來無關。 */
  function auctionCodes() {
    return [...auctionByCbCode.keys()];
  }

  function stepAuction(delta) {
    const list = auctionCodes();
    if (!list.length || !curAuctionCode) return;
    const i = list.indexOf(String(curAuctionCode));
    if (i < 0) return;
    const next = list[i + delta];
    if (!next) return;              // 頭尾不繞回去,免得不知道自己翻到哪
    showAuctionModal(next, { keepPage: true });
  }

  function syncAuctionNav() {
    const list = auctionCodes();
    const i = list.indexOf(String(curAuctionCode));
    const pos = document.getElementById('auc-nav-pos');
    const prev = document.getElementById('auc-nav-prev');
    const next = document.getElementById('auc-nav-next');
    if (pos) pos.textContent = i < 0 ? '–' : `${i + 1} / ${list.length}`;
    if (prev) prev.disabled = i <= 0;
    if (next) next.disabled = i < 0 || i >= list.length - 1;
  }

  function onAuctionKey(e) {
    if (!curAuctionCode) return;
    if (!document.getElementById('auction-modal')?.classList.contains('show')) return;
    // 使用者正在輸入框裡打字時不要搶方向鍵
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepAuction(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepAuction(1); }
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
      companyReportsByCode = (rawResults.companyReports && rawResults.companyReports.stocks) || {};
      companyReportOverview = (rawResults.companyReports && rawResults.companyReports.overview) || null;
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
    // 用 optional chaining:某些 tab 只存在於本機版 index.html (未上線),
    // 缺按鈕時不能讓整個 switchTab 拋錯,否則所有分頁都切不動。
    for (const t of ['cb', 'etf', 'vcp', 'strength', 'calendar', 'reports']) {
      document.getElementById(`tab-${t}`)?.classList.toggle('active', tab === t);
    }

    // 關閉 detail panel
    closeDetail();

    if (tab === 'cb') {
      buildFilterPanel();
      applyCurrentFilters();
    } else if (tab === 'etf') {
      await initETFView();
    } else if (tab === 'vcp') {
      await initVCPView();
    } else if (tab === 'strength') {
      await initStrengthView();
    } else if (tab === 'calendar') {
      initCalendarView();
    } else if (tab === 'reports') {
      initReportsView();
    }
  }

  function initReportsView() {
    if (typeof ReportsView === 'undefined') return;
    ReportsView.render('filter-panel', 'main-table', companyReportsByCode, {
      onOpen: (code, name) => openReportModalFor(code, name),
      stockName: (code) => (stockMap && stockMap[code] && stockMap[code].name) || null,
      overview: companyReportOverview,
      onOpenOverview: () => openReportModalFor('', (companyReportOverview && companyReportOverview.title) || '台股產業鏈交叉分析', companyReportOverview)
    });
    const statusEl = document.getElementById('header-status');
    if (statusEl) {
      const n = Object.keys(companyReportsByCode || {}).length;
      statusEl.textContent = `報告清單 | ${n} 檔有企業報告`;
      statusEl.style.color = '';
    }
  }

  /** 由報告清單頁直接以 code+name 開啟企業報告 modal(不依賴 selectedStock),支援多版本切換 */
  function openReportModalFor(code, name, infoArg) {
    const info = infoArg || companyReportsByCode[code];
    const titleEl = document.getElementById('company-report-modal-title');
    if (titleEl) titleEl.textContent = `${(code ? code + ' ' : '')}${name || ''} · 企業報告`;
    if (!info) {
      const pdfBtn0 = document.getElementById('company-report-pdf-btn');
      if (pdfBtn0) pdfBtn0.style.display = 'none';
      const bodyEl0 = document.getElementById('company-report-modal-body');
      if (bodyEl0) bodyEl0.innerHTML = `<div class="company-report-empty"><p>📂 此標的尚未產出企業報告</p><p class="dim">Drive 企業報告/ 內找不到 <code>${code}</code> 對應的資料夾</p></div>`;
      document.getElementById('company-report-modal')?.classList.add('show');
      return;
    }
    // 多版本(info.versions):由新到舊排序,預設顯示最新
    const verMap = (info.versions && Object.keys(info.versions).length > 1) ? info.versions : null;
    const verKeys = verMap ? Object.keys(verMap).sort((a, b) =>
      (parseInt(b.replace(/\D/g, '')) || 0) - (parseInt(a.replace(/\D/g, '')) || 0)) : null;
    _renderReportVersion(code, info, verMap, (verKeys ? verKeys[0] : info.version));
    document.getElementById('company-report-modal')?.classList.add('show');
  }

  /** 渲染指定版本的報告(png + PDF 按鈕 + 版本切換列) */
  function _renderReportVersion(code, info, verMap, ver) {
    const bodyEl = document.getElementById('company-report-modal-body');
    const pdfBtn = document.getElementById('company-report-pdf-btn');
    // 該版本的 png/pdf:優先 verMap[ver],否則用 info 本身(latest)
    const v = (verMap && verMap[ver]) || { png_id: info.png_id, pdf_id: info.pdf_id };
    if (pdfBtn) {
      if (v.pdf_id) {
        pdfBtn.style.display = '';
        pdfBtn.onclick = () => window.open(`https://drive.google.com/file/d/${v.pdf_id}/view`, '_blank', 'noopener');
        pdfBtn.title = `${ver} · ${info.folder_name}`;
      } else { pdfBtn.style.display = 'none'; }
    }
    if (!bodyEl) return;
    // 版本切換列(多版本才顯示)
    let verBar = '';
    if (verMap) {
      const keys = Object.keys(verMap).sort((a, b) => (parseInt(b.replace(/\D/g,''))||0) - (parseInt(a.replace(/\D/g,''))||0));
      verBar = `<div class="crm-ver-bar">版本：${keys.map(k =>
        `<button class="crm-ver-btn${k===ver?' on':''}" data-ver="${k}">${k}${k===keys[0]?'（最新）':''}</button>`).join('')}</div>`;
    }
    let imgHtml;
    if (v.png_id) {
      const pngUrl = `https://lh3.googleusercontent.com/d/${v.png_id}=w4000`;
      const pngFallback = `https://drive.google.com/thumbnail?id=${v.png_id}&sz=w4000`;
      const pngLargeUrl = `https://drive.google.com/file/d/${v.png_id}/view`;
      imgHtml = `
        <a href="${pngLargeUrl}" target="_blank" rel="noopener" title="點擊在 Drive 開啟原圖">
          <img src="${pngUrl}" alt="${code} 簡易報告" class="company-report-img" referrerpolicy="no-referrer"
               onerror="if(!this.dataset.fallback){this.dataset.fallback=1;this.src='${pngFallback}';}else{this.style.display='none';}">
        </a>`;
    } else {
      imgHtml = `<div class="company-report-empty"><p>📄 此版本尚無簡易報告 PNG</p>${v.pdf_id ? '<p class="dim">可透過上方按鈕開啟 PDF</p>' : ''}</div>`;
    }
    bodyEl.innerHTML = verBar + imgHtml;
    // 綁定版本切換
    bodyEl.querySelectorAll('.crm-ver-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); _renderReportVersion(code, info, verMap, btn.dataset.ver); });
    });
  }

  let vcpLoaded = false;
  async function initVCPView() {
    const statusEl = document.getElementById('header-status');
    try {
      if (!vcpLoaded) {
        if (statusEl) statusEl.textContent = '載入 VCP 掃描結果...';
        await VCPView.loadData();
        vcpLoaded = true;
      }
      const st = VCPView.getStats();
      if (statusEl) {
        statusEl.textContent = `VCP 選股 | 資料日 ${st.asOf} | 通過 ${st.passed} 檔`;
        statusEl.style.color = '';
      }
      VCPView.buildFilterPanel('filter-panel');
      VCPView.renderColumns('main-table');
    } catch (err) {
      console.error('[VCP] 載入失敗', err);
      const mt = document.getElementById('main-table');
      if (mt) mt.innerHTML = '<div style="padding:24px;color:#94a3b8">VCP 資料尚未產生 (data/vcp.json)。請先執行 scripts/vcp_scanner.py。</div>';
      if (statusEl) statusEl.textContent = 'VCP 資料未就緒';
    }
  }

  let strengthLoaded = false;
  async function initStrengthView() {
    const statusEl = document.getElementById('header-status');
    try {
      if (!strengthLoaded) {
        if (statusEl) statusEl.textContent = '載入強勢股掃描結果...';
        await StrengthView.loadData();
        strengthLoaded = true;
      }
      const st = StrengthView.getStats();
      if (statusEl) {
        statusEl.textContent = `強勢股 | 資料日 ${st.asOf} | RS≥90 ${st.strong90} 檔 | 其中突破中 ${st.breakout90} 檔`;
        statusEl.style.color = '';
      }
      StrengthView.buildFilterPanel('filter-panel');
      StrengthView.renderColumns('main-table');
    } catch (err) {
      console.error('[Strength] 載入失敗', err);
      const mt = document.getElementById('main-table');
      if (mt) mt.innerHTML = '<div style="padding:24px;color:#94a3b8">強勢股資料尚未產生 (data/strength.json)。請先執行 scripts/strength_scanner.py。</div>';
      if (statusEl) statusEl.textContent = '強勢股資料未就緒';
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
    showAuctionModal, closeAuctionModal, stepAuction, onAuctionKey,
    openTechModal, closeTechModal,
    openCBTechModal, closeCBTechModal, openCBTechFromStock, openTechFromCB,
    switchTab, showDetail,
    openInvestModal, closeInvestModal,
    openCompanyReportModal, closeCompanyReportModal
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
// 開標統計表開著時,← → 切換上一檔 / 下一檔
document.addEventListener('keydown', App.onAuctionKey);
