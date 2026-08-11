/* reportsView.js — 「報告清單」頁面:列出所有有企業報告的個股,點列開報告 modal。
 * 資料來源:company_reports.json(由 app.js 載入後以 companyReportsByCode 傳入)。 */
const ReportsView = (() => {
  let _reports = {};
  let _opts = {};
  let _keyword = '';
  let _sort = 'code';        // code | name | version
  let _verFilter = 'all';    // all | V1 | V2

  // folder_name 去尾股號 → 公司名(如「金利食安7743」→「金利食安」)
  function nameFromFolder(folder, code) {
    if (!folder) return code;
    return folder.replace(new RegExp(code + '$'), '').replace(/\d{4,6}$/, '') || folder;
  }

  function rows() {
    const out = [];
    for (const code of Object.keys(_reports)) {
      const info = _reports[code] || {};
      // 優先用 company_reports.json 注入的官方簡稱(info.name),再退回網站 stockMap、最後解析資料夾名
      const name = info.name || (_opts.stockName && _opts.stockName(code)) || nameFromFolder(info.folder_name, code);
      out.push({ code, name, version: info.version || 'V1',
                 hasPng: !!info.png_id, hasPdf: !!info.pdf_id });
    }
    return out;
  }

  function filtered() {
    let r = rows();
    if (_verFilter !== 'all') r = r.filter(x => x.version === _verFilter);
    const kw = _keyword.trim().toLowerCase();
    if (kw) r = r.filter(x => (x.code + ' ' + x.name).toLowerCase().includes(kw));
    r.sort((a, b) => {
      if (_sort === 'name') return a.name.localeCompare(b.name, 'zh-Hant');
      if (_sort === 'version') return (b.version).localeCompare(a.version) || (a.code - b.code);
      return (a.code - b.code) || a.code.localeCompare(b.code);
    });
    return r;
  }

  function buildFilterPanel(containerId) {
    const p = document.getElementById(containerId);
    if (!p) return;
    const all = rows();
    const v2 = all.filter(x => x.version === 'V2').length;
    p.innerHTML = `
      <div class="rv-panel">
        <div class="rv-sum"><span class="rv-sum-n">${all.length}</span> 檔有企業報告</div>
        <div class="rv-sub">V1 ${all.length - v2} · V2 ${v2}</div>
        <input id="rv-search" class="rv-search" type="text" placeholder="搜尋股號或名稱…" value="${_keyword}">
        <div class="rv-group-label">版本</div>
        <div class="rv-btns" id="rv-ver">
          ${['all','V1','V2'].map(v => `<button class="rv-chip${_verFilter===v?' on':''}" data-v="${v}">${v==='all'?'全部':v}</button>`).join('')}
        </div>
        <div class="rv-group-label">排序</div>
        <div class="rv-btns" id="rv-sort">
          ${[['code','股號'],['name','名稱'],['version','版本']].map(([s,l]) => `<button class="rv-chip${_sort===s?' on':''}" data-s="${s}">${l}</button>`).join('')}
        </div>
        <div class="rv-hint">點任一列開啟企業報告(簡易圖)，開啟後可再按「完整報告 PDF」。</div>
      </div>`;
    const search = document.getElementById('rv-search');
    if (search) {
      search.oninput = () => { _keyword = search.value; renderTable(); };
      search.onkeyup = (e) => { if (e.key === 'Escape') { _keyword=''; search.value=''; renderTable(); } };
    }
    p.querySelector('#rv-ver')?.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      _verFilter = b.dataset.v; buildFilterPanel(containerId); renderTable();
    });
    p.querySelector('#rv-sort')?.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      _sort = b.dataset.s; buildFilterPanel(containerId); renderTable();
    });
  }

  let _mainId = 'main-table';
  function renderTable() {
    const host = document.getElementById(_mainId);
    if (!host) return;
    const r = filtered();
    const body = r.map(x => `
      <tr class="rv-row" data-code="${x.code}" data-name="${x.name}">
        <td class="rv-code">${x.code}</td>
        <td class="rv-name">${x.name || '—'}</td>
        <td class="rv-ver-cell"><span class="rv-badge${x.version==='V2'?' v2':''}">${x.version}</span></td>
      </tr>`).join('');
    const ov = _opts.overview;
    const ovCard = ov ? `
      <div class="rv-featured" id="rv-featured">
        <div class="rv-feat-badge">📌 置頂</div>
        <div class="rv-feat-main">
          <div class="rv-feat-title">${ov.title || '台股產業鏈交叉分析'}</div>
          <div class="rv-feat-sub">跨產業供應鏈交叉分析總覽 · ${ov.version || ''}</div>
        </div>
        <div class="rv-feat-cta">開啟總覽 →</div>
      </div>` : '';
    host.innerHTML = `
      <div class="rv-wrap">
        ${ovCard}
        <div class="rv-count">共 ${r.length} 檔</div>
        <table class="rv-table">
          <thead><tr><th>股號</th><th>名稱</th><th>版本</th></tr></thead>
          <tbody>${body || '<tr><td colspan="3" class="rv-empty">查無符合的報告</td></tr>'}</tbody>
        </table>
      </div>`;
    const feat = host.querySelector('#rv-featured');
    if (feat && _opts.onOpenOverview) feat.addEventListener('click', () => _opts.onOpenOverview());
    host.querySelectorAll('.rv-row').forEach(tr => {
      tr.addEventListener('click', () => {
        if (_opts.onOpen) _opts.onOpen(tr.dataset.code, tr.dataset.name);
      });
    });
  }

  function render(filterPanelId, mainTableId, reportsByCode, opts) {
    _reports = reportsByCode || {};
    _opts = opts || {};
    _mainId = mainTableId || 'main-table';
    buildFilterPanel(filterPanelId);
    renderTable();
  }

  return { render };
})();
window.ReportsView = ReportsView;
