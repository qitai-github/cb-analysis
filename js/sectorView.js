/* sectorView.js — 「產業族群」分頁:全市場資金流向 + 產業鏈樹狀圖。
 * 資料: data/sector_flow.json (每日群組成交/占比,GHA 每日更新)
 *       data/industry_chain.json (自訂 6 族群 → 角色 → 個股)
 *       data/industry_classification.json (XQ 大產業 / 細分群組 / 成員)
 * 台股慣例: 紅漲綠跌。 */
const SectorView = (() => {
  let flow = null, chain = null, cls = null;
  let opts = {};
  const st = { mode: 'flow', cluster: 'pcb', kind: 'cluster', sort: 'delta', sel: null, selStock: null, onlyCB: false, kw: '', showAll: false };
  let chart = null;
  const KIND_LABEL = { cluster: '自訂族群', role: '族群×角色', main: '大產業', group: '細分群組' };
  const ROLE_COLOR = ['#14b8a6', '#3b82f6', '#a855f7', '#f59e0b', '#ef4444', '#22c55e'];

  async function loadData() {
    if (flow) return;
    const get = async (u) => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); };
    [flow, chain, cls] = await Promise.all([get('data/sector_flow.json'), get('data/industry_chain.json'), get('data/industry_classification.json')]);
  }

  // ── 資料輔助 ────────────────────────────────────────────────────
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const fmt = (v, d = 2) => (v == null || isNaN(v) ? '-' : Number(v).toFixed(d));
  const sign = (v, d = 2) => (v > 0 ? '+' : '') + fmt(v, d);
  const cls_ = (v) => (v > 0 ? 'sec-up' : v < 0 ? 'sec-down' : '');
  const nameOf = (c) => (chain.stocks[c] && chain.stocks[c].name) || (cls.stocks[c] && cls.stocks[c].name) || c;
  const today = (c) => (flow.latest && flow.latest[c]) || [0, 0];
  const gMap = () => (flow._gm || (flow._gm = Object.fromEntries(flow.groups.map(g => [g.kind + ':' + g.id, g]))));

  function metrics(g) {
    const s = g.share, n = s.length;
    const base = avg(s.slice(Math.max(0, n - 21), n - 1));
    return {
      share: s[n - 1], delta: s[n - 1] - base,
      d5: avg(s.slice(n - 5)) - base,
      amt: g.amt[n - 1], pct: g.pct[n - 1], pct5: g.pct.slice(n - 5).reduce((a, b) => a + b, 0), up: g.up[n - 1],
    };
  }

  function members(kind, id) {
    if (kind === 'cluster' || kind === 'role') {
      const [cl, role] = id.split('.');
      return Object.entries(chain.stocks)
        .filter(([, m]) => m.memberships.some(x => x.cluster === cl && (kind === 'cluster' || x.role === role)))
        .map(([c]) => c);
    }
    if (kind === 'main') return Object.entries(cls.stocks).filter(([, s]) => s.main === id).map(([c]) => c);
    return (cls.members && cls.members[id]) || [];
  }
  const cbOk = (c) => !st.onlyCB || !opts.hasCB || opts.hasCB(c);

  function spark(arr, w = 90, h = 24) {
    const a = arr.slice(-60), mn = Math.min(...a), mx = Math.max(...a), r = (mx - mn) || 1;
    const pts = a.map((v, i) => `${(i / (a.length - 1) * w).toFixed(1)},${(h - 2 - (v - mn) / r * (h - 4)).toFixed(1)}`).join(' ');
    return `<svg class="sec-spark" width="${w}" height="${h}"><polyline fill="none" stroke="#60a5fa" stroke-width="1.5" points="${pts}"/></svg>`;
  }

  // ── 側欄 ────────────────────────────────────────────────────────
  const autoIds = () => (flow._auto || (flow._auto = new Set(chain.taxonomy.filter(c => c.auto).map(c => c.id))));
  function renderSidebar(el) {
    const item = (c) => {
      const g = gMap()['cluster:' + c.id], m = g && metrics(g);
      return `<div class="sec-nav ${st.mode === 'chain' && st.cluster === c.id ? 'active' : ''}" data-cluster="${c.id}">
        <span>${c.name}</span><span class="sec-nav-d ${m ? cls_(m.delta) : ''}">${m ? sign(m.delta, 1) : ''}</span></div>`;
    };
    const themed = chain.taxonomy.filter(c => !c.auto), autos = chain.taxonomy.filter(c => c.auto);
    const autoOpen = autos.some(c => c.id === st.cluster && st.mode === 'chain');
    el.innerHTML = `<div class="sec-side">
      <div class="sec-side-title">產業族群</div>
      <div class="sec-nav ${st.mode === 'flow' ? 'active' : ''}" data-flow="1"><span>📊 全市場資金流向</span></div>
      <div class="sec-side-sub">主題產業鏈 (${themed.length})</div>${themed.map(item).join('')}
      <details class="sec-auto" ${autoOpen ? 'open' : ''}><summary class="sec-side-sub">全市場各產業 (${autos.length})</summary>${autos.map(item).join('')}</details>
      <div class="sec-side-note">右側數字 = 今日成交占比較前 20 日均的增減 (百分點)。主題鏈為人工設計的上中下游;各產業鏈的角色對應細分群組。</div></div>`;
    el.querySelectorAll('[data-cluster]').forEach(n => n.onclick = () => { st.mode = 'chain'; st.cluster = n.dataset.cluster; st.selStock = null; render(); });
    el.querySelector('[data-flow]').onclick = () => { st.mode = 'flow'; render(); };
  }

  // ── 全市場資金流向 ───────────────────────────────────────────────
  function renderFlow(root) {
    const date = flow.dates[flow.dates.length - 1];
    const rows = flow.groups.filter(g => g.kind === st.kind && g.n >= 3 && !((g.kind === 'cluster' || g.kind === 'role') && autoIds().has(g.id.split('.')[0]))).map(g => ({ g, m: metrics(g) }));
    const key = { delta: r => -r.m.delta, amt: r => -r.m.amt, pct: r => -r.m.pct, d5: r => -r.m.d5 }[st.sort];
    rows.sort((a, b) => key(a) - key(b));
    const lim = st.kind === 'group' && !st.showAll ? 60 : rows.length;
    const kw = st.kw.trim();
    const shown = rows.filter(r => !kw || r.g.name.includes(kw)).slice(0, kw ? 999 : lim);
    root.innerHTML = `
      <div class="sec-head"><div><div class="sec-title">全市場資金流向</div>
        <div class="sec-sub">資料日 ${date.replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3')} · 全市場成交 ${fmt(flow.market_amt[flow.market_amt.length - 1], 0)} 億 · 占比 = 群組成交 ÷ 全市場成交</div></div>
        <div class="sec-chips">${Object.entries(KIND_LABEL).map(([k, l]) => `<button class="sec-chip ${st.kind === k ? 'on' : ''}" data-kind="${k}">${l}</button>`).join('')}</div></div>
      <div class="sec-tools"><input class="sec-input" id="sec-kw" placeholder="搜尋群組名稱" value="${st.kw}">
        <select class="sec-input" id="sec-sort"><option value="delta">排序: 占比增減 (今日 vs 20日均)</option><option value="d5">排序: 5日均占比增減</option><option value="amt">排序: 今日成交金額</option><option value="pct">排序: 今日漲跌</option></select>
        ${st.kind === 'group' && !kw ? `<button class="sec-chip" id="sec-all">${st.showAll ? '只看前 60' : '顯示全部 ' + rows.length}</button>` : ''}
        ${st.kind === 'group' ? '<span class="sec-note">細分群組互相重疊,占比不可加總</span>' : ''}</div>
      <div class="sec-tbl-wrap"><table class="sec-tbl"><thead><tr><th>群組</th><th>檔數</th><th>今日成交(億)</th><th>占比%</th><th>vs20日均</th><th>5日均vs20日</th><th>漲跌%</th><th>5日累計%</th><th>上漲家數</th><th>占比走勢(60日)</th></tr></thead><tbody>
      ${shown.map(({ g, m }) => `<tr class="sec-row ${st.sel === g.kind + ':' + g.id ? 'sel' : ''}" data-k="${g.kind}:${g.id}">
        <td class="sec-name">${g.name}</td><td>${g.n}</td><td>${fmt(m.amt, 0)}</td><td>${fmt(m.share)}</td>
        <td class="${cls_(m.delta)}">${sign(m.delta)}</td><td class="${cls_(m.d5)}">${sign(m.d5)}</td>
        <td class="${cls_(m.pct)}">${sign(m.pct)}</td><td class="${cls_(m.pct5)}">${sign(m.pct5)}</td><td>${m.up}%</td><td>${spark(g.share)}</td></tr>`).join('')}
      </tbody></table></div><div id="sec-detail"></div>`;
    root.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { st.kind = b.dataset.kind; st.sel = null; st.showAll = false; render(); });
    root.querySelector('#sec-sort').value = st.sort;
    root.querySelector('#sec-sort').onchange = (e) => { st.sort = e.target.value; render(); };
    const kwEl = root.querySelector('#sec-kw');
    kwEl.onchange = () => { st.kw = kwEl.value; render(); };
    const all = root.querySelector('#sec-all'); if (all) all.onclick = () => { st.showAll = !st.showAll; render(); };
    root.querySelectorAll('.sec-row').forEach(r => r.onclick = () => { st.sel = r.dataset.k; render(); });
    if (st.sel && gMap()[st.sel]) renderGroupDetail(root.querySelector('#sec-detail'), gMap()[st.sel]);
  }

  function renderGroupDetail(el, g) {
    const m = metrics(g);
    const codes = members(g.kind, g.id).filter(cbOk).sort((a, b) => today(b)[0] - today(a)[0]);
    el.innerHTML = `<div class="sec-card"><div class="sec-card-h"><b>${g.name}</b>
        <span class="sec-sub">${g.n} 檔 · 今日占比 ${fmt(m.share)}% (${sign(m.delta)}pt) · 漲跌 ${sign(m.pct)}%</span>
        ${opts.hasCB ? `<label class="sec-cb"><input type="checkbox" id="sec-cbonly" ${st.onlyCB ? 'checked' : ''}> 只看有 CB</label>` : ''}</div>
      <div class="sec-chart"><canvas id="sec-chart"></canvas></div>
      ${memberTable(codes, g)}</div>`;
    const cb = el.querySelector('#sec-cbonly'); if (cb) cb.onchange = () => { st.onlyCB = cb.checked; render(); };
    bindStockRows(el);
    drawChart(el.querySelector('#sec-chart'), g);
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function drawChart(canvas, g) {
    if (chart) chart.destroy();
    if (typeof Chart === 'undefined') return;
    const labels = flow.dates.map(d => d.slice(4, 6) + '/' + d.slice(6));
    chart = new Chart(canvas, { type: 'line', data: { labels, datasets: [
      { label: '占比%', data: g.share, borderColor: '#60a5fa', backgroundColor: 'rgba(96,165,250,.12)', fill: true, pointRadius: 0, tension: .25, yAxisID: 'y' },
      { label: '漲跌%', data: g.pct, borderColor: '#fbbf24', pointRadius: 0, borderWidth: 1, yAxisID: 'y2' }] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: '#94a3b8' } } },
        scales: { x: { ticks: { color: '#64748b', maxTicksLimit: 10 }, grid: { display: false } },
          y: { ticks: { color: '#94a3b8' }, grid: { color: '#1e293b' } },
          y2: { position: 'right', ticks: { color: '#fbbf24' }, grid: { display: false } } } } });
  }

  function memberTable(codes, g) {
    const roleOf = (c) => {
      if (!g || !['cluster', 'role'].includes(g.kind)) return '';
      const cl = g.id.split('.')[0], ms = chain.stocks[c].memberships.find(x => x.cluster === cl);
      const cd = chain.taxonomy.find(t => t.id === cl), r = cd && cd.roles.find(x => x.id === (ms && ms.role));
      return r ? r.name : '角色待定';
    };
    const showRole = g && ['cluster', 'role'].includes(g.kind);
    return `<div class="sec-tbl-wrap"><table class="sec-tbl"><thead><tr><th>代碼</th><th>名稱</th>${showRole ? '<th>角色</th>' : ''}<th>細分群組</th><th>成交(億)</th><th>漲跌%</th></tr></thead><tbody>
      ${codes.map(c => { const t = today(c), grp = (cls.stocks[c] ? cls.stocks[c].groups.map(x => cls.groups[x].name) : []).slice(0, 4).join('·');
        return `<tr class="sec-srow" data-code="${c}"><td>${c}</td><td class="sec-name">${nameOf(c)}${opts.hasCB && opts.hasCB(c) ? ' <span class="sec-cbtag">CB</span>' : ''}</td>${showRole ? `<td>${roleOf(c)}</td>` : ''}
        <td class="sec-dim">${grp}</td><td>${fmt(t[0], 1)}</td><td class="${cls_(t[1])}">${sign(t[1])}</td></tr>`; }).join('')}
      </tbody></table></div>`;
  }
  function bindStockRows(el) {
    el.querySelectorAll('.sec-srow').forEach(r => r.onclick = () => {
      const c = r.dataset.code;
      if (st.mode === 'chain') { st.selStock = c; render(); } else if (opts.openStock) opts.openStock(c);
    });
  }

  // ── 產業鏈樹狀圖 ─────────────────────────────────────────────────
  function renderChain(root) {
    const cd = chain.taxonomy.find(c => c.id === st.cluster);
    const cg = gMap()['cluster:' + cd.id], cm = metrics(cg);
    const all = members('cluster', cd.id).filter(cbOk);
    const byRole = {};
    for (const c of all) {
      const ms = chain.stocks[c].memberships.find(x => x.cluster === cd.id);
      (byRole[(ms && ms.role) || '_'] = byRole[(ms && ms.role) || '_'] || []).push(c);
    }
    const roles = cd.roles.map((r, i) => ({ ...r, color: ROLE_COLOR[i % ROLE_COLOR.length], codes: byRole[r.id] || [] })).filter(r => r.codes.length);
    if (byRole._) roles.push({ id: '_', name: '角色待定', color: '#64748b', codes: byRole._ });
    const card = (c, color) => { const t = today(c); const ms = chain.stocks[c].memberships.find(x => x.cluster === cd.id);
      return `<div class="sec-stock ${st.selStock === c ? 'sel' : ''}" data-code="${c}" style="--rc:${color}">
        <div class="sec-stock-t"><b>${c} ${nameOf(c)}</b><span class="${cls_(t[1])}">${sign(t[1])}%</span></div>
        <div class="sec-stock-s">${(ms.subs || []).slice(0, 3).join('·')}</div></div>`; };
    root.innerHTML = `
      <div class="sec-head"><div><div class="sec-title">${cd.name}產業鏈</div>
        <div class="sec-sub">從產業角色探索個股關聯 · 今日占比 ${fmt(cm.share)}% (${sign(cm.delta)}pt) · 漲跌 ${sign(cm.pct)}% · ${all.length} 檔</div></div>
        ${opts.hasCB ? `<div class="sec-chips"><button class="sec-chip ${!st.onlyCB ? 'on' : ''}" data-cb="0">全部成員</button><button class="sec-chip ${st.onlyCB ? 'on' : ''}" data-cb="1">只看有 CB</button></div>` : ''}</div>
      <div class="sec-layout"><div class="sec-main">
        <div class="sec-tree"><div class="sec-root">${cd.name}</div><div class="sec-trunk"></div>
          <div class="sec-roles">${roles.map(r => { const rg = gMap()['role:' + cd.id + '.' + r.id], rm = rg && metrics(rg); const top = r.codes.sort((a, b) => today(b)[0] - today(a)[0]);
            return `<div class="sec-role" style="--rc:${r.color}"><div class="sec-role-h"><b>${r.name}</b><span>${r.codes.length} 檔${rm ? ` · 占比 ${fmt(rm.share)}% <i class="${cls_(rm.delta)}">${sign(rm.delta, 1)}</i>` : ''}</span></div>
              ${top.slice(0, 8).map(c => card(c, r.color)).join('')}${top.length > 8 ? `<div class="sec-more">另有 ${top.length - 8} 檔 (見下表)</div>` : ''}</div>`; }).join('')}</div>
          <div class="sec-note">連線代表分類歸屬,不代表直接供貨關係;每角色卡片依今日成交金額排序</div></div>
        <div class="sec-card"><div class="sec-card-h"><b>族群成員</b><span class="sec-sub">點列選取個股</span></div>
          ${memberTable(all.sort((a, b) => today(b)[0] - today(a)[0]), cg)}</div>
        <div class="sec-card"><div class="sec-card-h"><b>${cd.name} 資金占比走勢</b></div><div class="sec-chart"><canvas id="sec-chart"></canvas></div></div>
      </div>
      <aside class="sec-aside">${stockSummary(st.selStock, cd)}</aside></div>`;
    root.querySelectorAll('[data-cb]').forEach(b => b.onclick = () => { st.onlyCB = b.dataset.cb === '1'; render(); });
    root.querySelectorAll('.sec-stock').forEach(n => n.onclick = () => { st.selStock = n.dataset.code; render(); });
    bindStockRows(root);
    root.querySelectorAll('[data-open]').forEach(b => b.onclick = () => opts.openStock && opts.openStock(b.dataset.open));
    drawChart(root.querySelector('#sec-chart'), cg);
  }

  function stockSummary(code, cd) {
    if (!code) return '<div class="sec-side-title">個股摘要</div><div class="sec-note">點選左側個股卡片或成員列,查看所屬族群與當日價量。</div>';
    const s = chain.stocks[code], t = today(code), x = cls.stocks[code];
    const ms = s.memberships.map(m => { const c = chain.taxonomy.find(k => k.id === m.cluster), r = c.roles.find(k => k.id === m.role);
      return `<div class="sec-ms"><b>${c.name}</b> › ${r ? r.name : '角色待定'}<div class="sec-chips-s">${(m.subs || []).map(u => `<span class="sec-tag">${u}</span>`).join('')}</div></div>`; }).join('');
    const hasCB = opts.hasCB && opts.hasCB(code);
    return `<div class="sec-side-title">個股摘要</div><div class="sec-big">${code} ${s.name}</div>
      <div class="sec-sub">${x ? cls.groups[x.main].name : s.industry1} · 今日成交 ${fmt(t[0], 1)} 億 · <span class="${cls_(t[1])}">${sign(t[1])}%</span></div>
      <div class="sec-h3">業務分類</div>${ms}
      <div class="sec-h3">細分群組</div><div class="sec-chips-s">${(x ? x.groups : []).map(g => `<span class="sec-tag">${cls.groups[g].name}</span>`).join('')}</div>
      ${hasCB ? `<button class="sec-btn" data-open="${code}">對應 CB / 個股分析</button>` : '<div class="sec-note">此股目前無對應 CB</div>'}`;
  }

  // ── 進入點 ──────────────────────────────────────────────────────
  let els = null;
  function render() {
    if (chart) { chart.destroy(); chart = null; }
    renderSidebar(els.side);
    (st.mode === 'flow' ? renderFlow : renderChain)(els.main);
  }
  function mount(sideId, mainId, o) {
    opts = o || {};
    els = { side: document.getElementById(sideId), main: document.getElementById(mainId) };
    render();
  }
  function getStats() { return { asOf: flow ? flow.dates[flow.dates.length - 1] : '', groups: flow ? flow.groups.length : 0 }; }
  return { loadData, mount, getStats };
})();
