// 強勢股視圖 — 讀 data/strength.json (strength_scanner.py 產出)
// 雙層:上層「族群強度熱圖」(點選篩選) + 下層個股排行 (狀態徽章 / ⚠️延伸 / 族群)
// 版面/表格沿用 vcp-* 視覺 class (純樣式共用)。
const StrengthView = (() => {
  const DATA_URL = 'data/strength.json';

  let data = null;              // { _meta, groups: [], stocks: [] }
  let chart = null;

  const STAGE_LABEL = {
    breakout: '突破中', setup: '貼高蓄勢', pullback: '回檔整理', watch: '修正觀察',
  };
  // 可操作性排序 (突破 → 蓄勢 → 回檔 → 觀察)
  const STAGE_ORDER = ['breakout', 'setup', 'pullback', 'watch'];
  const STAGE_HINT = {
    breakout: '距高≤5% + 近5日剛創高 + 帶量,正在發動',
    setup: '距高≤10%,在買點附近等突破',
    pullback: '距高10~25% 且站上季線,仍強但需重建型態',
    watch: '距高>25% 或跌破季線,強勢已破壞',
  };

  const RS_TIERS = [90, 80, 70];
  const MAX_THEME_CHIPS = 12;

  const filters = {
    rsMin: 90,
    market: 'all',
    stages: new Set(STAGE_ORDER),
    hideExtended: false,        // 排除 ⚠️延伸過熱 (追高風險)
    group: null,               // 點族群熱圖後鎖定的族群
    theme: null,               // 點概念 chip 後鎖定的概念
    keyword: '',
    sort: 'score',
  };

  async function loadData() {
    if (data) return data;
    const resp = await fetch(DATA_URL, { cache: 'no-store' });
    if (!resp.ok) throw new Error('讀取 strength.json 失敗: ' + resp.status);
    data = await resp.json();
    return data;
  }

  function getStats() {
    const m = data ? data._meta : {};
    const s90 = data ? data.stocks.filter(r => r.rs >= 90) : [];
    return {
      asOf: m.asOf || '',
      scanned: m.scanned || 0,
      output: m.output || (data ? data.stocks.length : 0),
      strong90: m.strong90 || 0,
      // _meta.byStage 是整份輸出 (RS≥70) 的計數；預設畫面只看 RS≥90,
      // 狀態列要跟使用者眼前看到的一致,故另算一份。
      byStage: m.byStage || {},
      breakout90: s90.filter(r => r.stage === 'breakout').length,
      extended: m.extended || 0,
      groups: data ? data.groups.length : 0,
    };
  }

  /** 只套 RS 門檻 (給族群熱圖 / 概念 chips 統計用,不受族群/概念自身選擇影響) */
  function rsScoped() {
    if (!data) return [];
    return data.stocks.filter(r => r.rs >= filters.rsMin);
  }

  function getFiltered() {
    if (!data) return [];
    const kw = filters.keyword.trim().toLowerCase();
    let rows = data.stocks.filter(r => {
      if (r.rs < filters.rsMin) return false;
      if (filters.market !== 'all' && r.market !== filters.market) return false;
      if (!filters.stages.has(r.stage)) return false;
      if (filters.hideExtended && r.extended) return false;
      if (filters.group && r.group !== filters.group) return false;
      if (filters.theme && !(r.themes || []).includes(filters.theme)) return false;
      if (kw) {
        const hay = (r.id + ' ' + r.name).toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
    const key = filters.sort;
    rows.sort((a, b) => {
      switch (key) {
        case 'rs': return b.rs - a.rs || b.score - a.score;
        case 'stage':
          return STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)
            || b.score - a.score;
        case 'mom': return b.momScore - a.momScore || b.score - a.score;
        case 'vol': return b.volScore - a.volScore || b.score - a.score;
        case 'distHigh': return a.distHigh - b.distHigh;
        case 'ret3m': return b.ret3m - a.ret3m;
        case 'ret12m': return b.ret12m - a.ret12m;
        default: return b.score - a.score;
      }
    });
    return rows;
  }

  // ── 側欄篩選 ──────────────────────────────────────────────────────
  function buildFilterPanel(containerId) {
    const panel = document.getElementById(containerId);
    if (!panel) return;
    const st = getStats();
    panel.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'vcp-filter';

    const summary = document.createElement('div');
    summary.className = 'vcp-filter-summary';
    summary.innerHTML =
      `<div class="vcp-sum-title">強勢股掃描</div>` +
      `<div class="vcp-sum-meta">資料日 ${fmtDate(st.asOf)}</div>` +
      `<div class="vcp-sum-meta">流動性通過 ${st.scanned} 檔 · RS≥90 <b>${st.strong90}</b></div>`;
    wrap.appendChild(summary);

    wrap.appendChild(groupTitle('相對強度 RS'));
    const rsRow = document.createElement('div');
    rsRow.className = 'vcp-seg';
    RS_TIERS.forEach(min => {
      const b = document.createElement('button');
      const n = data ? data.stocks.filter(r => r.rs >= min).length : 0;
      b.className = 'vcp-seg-btn' + (filters.rsMin === min ? ' active' : '');
      b.innerHTML = `≥${min}<span class="vcp-seg-n">${n}</span>`;
      b.onclick = () => { filters.rsMin = min; applyAndRender(); };
      rsRow.appendChild(b);
    });
    wrap.appendChild(rsRow);

    // 操作狀態
    wrap.appendChild(groupTitle('操作狀態'));
    const scoped = rsScoped();
    const stageBox = document.createElement('div');
    stageBox.className = 'vcp-check-group';
    STAGE_ORDER.forEach(s => {
      const n = scoped.filter(r => r.stage === s).length;
      const label = document.createElement('label');
      label.className = 'vcp-check';
      label.title = STAGE_HINT[s];
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = filters.stages.has(s);
      cb.onchange = () => {
        if (cb.checked) filters.stages.add(s); else filters.stages.delete(s);
        applyAndRender();
      };
      const span = document.createElement('span');
      span.innerHTML = `<span class="vcp-badge st-${s}">${STAGE_LABEL[s]}</span>` +
        ` <span class="vcp-seg-n">${n}</span>`;
      label.appendChild(cb);
      label.appendChild(span);
      stageBox.appendChild(label);
    });
    // ⚠️延伸過熱 排除
    const extLab = document.createElement('label');
    extLab.className = 'vcp-check';
    extLab.title = '對 MA20 乖離 ≥15%,已噴出,追高易被套';
    const extCb = document.createElement('input');
    extCb.type = 'checkbox';
    extCb.checked = filters.hideExtended;
    extCb.onchange = () => { filters.hideExtended = extCb.checked; applyAndRender(); };
    const extSpan = document.createElement('span');
    extSpan.innerHTML = `排除 <span class="vcp-badge str-ext">⚠️延伸過熱</span>` +
      ` <span class="vcp-seg-n">${scoped.filter(r => r.extended).length}</span>`;
    extLab.appendChild(extCb);
    extLab.appendChild(extSpan);
    stageBox.appendChild(extLab);
    wrap.appendChild(stageBox);

    // 市場
    wrap.appendChild(groupTitle('市場'));
    const mktRow = document.createElement('div');
    mktRow.className = 'vcp-seg';
    [['all', '全部'], ['TWSE', '上市'], ['TPEX', '上櫃']].forEach(([v, t]) => {
      const b = document.createElement('button');
      b.className = 'vcp-seg-btn' + (filters.market === v ? ' active' : '');
      b.textContent = t;
      b.onclick = () => { filters.market = v; applyAndRender(); };
      mktRow.appendChild(b);
    });
    wrap.appendChild(mktRow);

    // 熱門概念 chips
    const themes = topThemes(scoped, MAX_THEME_CHIPS);
    if (themes.length) {
      wrap.appendChild(groupTitle('熱門概念'));
      const box = document.createElement('div');
      box.className = 'str-chip-box';
      themes.forEach(([name, n]) => {
        const c = document.createElement('button');
        c.className = 'str-chip' + (filters.theme === name ? ' active' : '');
        c.innerHTML = `${name.replace(/概念股$/, '')}<span class="vcp-seg-n">${n}</span>`;
        c.onclick = () => {
          filters.theme = (filters.theme === name) ? null : name;
          applyAndRender();
        };
        box.appendChild(c);
      });
      wrap.appendChild(box);
    }

    // 排序
    wrap.appendChild(groupTitle('排序'));
    const sortSel = document.createElement('select');
    sortSel.className = 'vcp-select';
    [['score', '綜合分數 (高→低)'], ['stage', '操作狀態 (可操作優先)'],
     ['rs', '相對強度 RS'], ['distHigh', '距52週高 (近→遠)'],
     ['mom', '動能分'], ['vol', '量價分'],
     ['ret3m', '近3月報酬'], ['ret12m', '近12月報酬']]
      .forEach(([v, t]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        if (filters.sort === v) o.selected = true;
        sortSel.appendChild(o);
      });
    sortSel.onchange = () => { filters.sort = sortSel.value; applyAndRender(); };
    wrap.appendChild(sortSel);

    wrap.appendChild(groupTitle('搜尋'));
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'vcp-search';
    search.placeholder = '代號 / 名稱';
    search.value = filters.keyword;
    search.oninput = () => { filters.keyword = search.value; applyAndRender(); };
    wrap.appendChild(search);

    panel.appendChild(wrap);
  }

  function topThemes(rows, limit) {
    const c = new Map();
    rows.forEach(r => (r.themes || []).forEach(t => c.set(t, (c.get(t) || 0) + 1)));
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  function groupTitle(t) {
    const d = document.createElement('div');
    d.className = 'vcp-filter-group-title';
    d.textContent = t;
    return d;
  }

  // ── 主區:族群熱圖 + 個股表 ───────────────────────────────────────
  function renderColumns(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    container.appendChild(buildGroupHeatmap());
    container.appendChild(buildStockTable());
  }

  /** 上層:族群強度熱圖 (只列有排名的族群;點選 = 篩選下方個股) */
  function buildGroupHeatmap() {
    const sec = document.createElement('div');
    sec.className = 'str-groups';
    if (!data || !data.groups) return sec;

    const ranked = data.groups.filter(g => g.strength != null);
    const head = document.createElement('div');
    head.className = 'str-groups-head';
    head.innerHTML =
      `<span class="str-groups-title">族群強度</span>` +
      `<span class="vcp-sum-meta">依族群內 RS 中位數排名 · 點選可篩選下方個股</span>` +
      (filters.group ? `<button class="str-clear" id="str-clear-group">清除「${filters.group}」✕</button>` : '');
    sec.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'str-group-grid';
    ranked.forEach(g => {
      const b = document.createElement('button');
      const on = filters.group === g.name;
      b.className = 'str-group-chip' + (on ? ' active' : '');
      b.title = `${g.name} — 成分 ${g.count} 檔,RS 中位數 ${g.rsMedian},` +
        `RS≥90 ${g.rs90} 檔,龍頭 ${g.leader.id} ${g.leader.name} (RS${g.leader.rs})`;
      b.innerHTML =
        `<span class="sg-top"><span class="sg-name">${g.name}</span>` +
        `<span class="sg-strength">${g.strength}</span></span>` +
        `<span class="sg-bar"><i style="width:${g.strength}%;background:${strengthColor(g.strength)}"></i></span>` +
        `<span class="sg-meta">${g.count} 檔 · RS≥90 <b>${g.rs90}</b>` +
        ` · 龍頭 ${g.leader.name}</span>`;
      b.onclick = () => {
        filters.group = on ? null : g.name;
        applyAndRender();
      };
      grid.appendChild(b);
    });
    sec.appendChild(grid);
    setTimeout(() => {
      const btn = document.getElementById('str-clear-group');
      if (btn) btn.onclick = () => { filters.group = null; applyAndRender(); };
    }, 0);
    return sec;
  }

  function strengthColor(s) {
    // 弱(藍灰) → 強(琥珀紅)
    if (s >= 85) return '#ef4444';
    if (s >= 70) return '#f59e0b';
    if (s >= 50) return '#3b82f6';
    if (s >= 30) return '#64748b';
    return '#475569';
  }

  /** 下層:個股排行 */
  function buildStockTable() {
    const box = document.createElement('div');
    const rows = getFiltered();

    const head = document.createElement('div');
    head.className = 'vcp-table-head';
    const chips = [];
    if (filters.group) chips.push(`族群「${filters.group}」`);
    if (filters.theme) chips.push(`概念「${filters.theme}」`);
    head.innerHTML = `共 <b>${rows.length}</b> 檔符合` +
      (chips.length ? ` — ${chips.join(' · ')}` : '') + ` — 點列看 K 線`;
    box.appendChild(head);

    const table = document.createElement('table');
    table.className = 'vcp-table';
    table.innerHTML = `
      <thead><tr>
        <th></th><th>代號</th><th>名稱</th><th>市</th>
        <th>狀態</th><th>族群</th>
        <th class="num">總分</th><th class="num">RS</th>
        <th class="num">動能</th><th class="num">量價</th>
        <th class="num">收盤</th><th class="num">漲跌%</th>
        <th class="num">距高%</th><th class="num">乖離%</th>
        <th class="num">3月%</th><th class="num">12月%</th>
      </tr></thead>`;
    const tbody = document.createElement('tbody');

    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = 'vcp-row';
      const starred = (typeof Watchlist !== 'undefined' && Watchlist.has(r.id));
      tr.innerHTML = `
        <td class="vcp-star ${starred ? 'on' : ''}" data-code="${r.id}">${starred ? '★' : '☆'}</td>
        <td class="vcp-code">${r.id}</td>
        <td class="vcp-name">${r.name}</td>
        <td class="vcp-mkt">${r.market === 'TWSE' ? '市' : '櫃'}</td>
        <td class="str-stage-cell">${stageBadge(r)}</td>
        <td class="str-group-cell">${r.group || '-'}</td>
        <td class="num"><span class="vcp-score">${r.score}</span></td>
        <td class="num"><span class="str-rs ${rsCls(r.rs)}">${r.rs}</span></td>
        <td class="num">${Math.round(r.momScore)}</td>
        <td class="num">${Math.round(r.volScore)}</td>
        <td class="num">${fmtNum(r.close)}</td>
        <td class="num ${chgCls(r.chgPct)}">${fmtPct(r.chgPct)}</td>
        <td class="num">${(r.distHigh * 100).toFixed(1)}</td>
        <td class="num ${r.extended ? 'str-ext-num' : ''}">${(r.extMa20 * 100).toFixed(1)}</td>
        <td class="num ${chgCls(r.ret3m)}">${r.ret3m}</td>
        <td class="num ${chgCls(r.ret12m)}">${r.ret12m}</td>`;
      tr.querySelector('.vcp-star').onclick = (e) => {
        e.stopPropagation();
        if (typeof Watchlist !== 'undefined') {
          Watchlist.toggle(r.id);
          const el = e.currentTarget;
          const on = Watchlist.has(r.id);
          el.classList.toggle('on', on);
          el.textContent = on ? '★' : '☆';
        }
      };
      tr.onclick = () => openModal(r);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    box.appendChild(table);
    return box;
  }

  function stageBadge(r) {
    let out = `<span class="vcp-badge st-${r.stage}" title="${STAGE_HINT[r.stage]}">${STAGE_LABEL[r.stage]}</span>`;
    if (r.extended) {
      out += ` <span class="vcp-badge str-ext" title="對 MA20 乖離 ≥15%,已噴出,追高易被套">⚠️延伸</span>`;
    }
    return out;
  }

  function rsCls(rs) { return rs >= 90 ? 'rs-90' : (rs >= 80 ? 'rs-80' : 'rs-70'); }
  function chgCls(v) { return v > 0 ? 'up' : (v < 0 ? 'dn' : ''); }

  function applyAndRender() {
    buildFilterPanel('filter-panel');
    renderColumns('main-table');
  }

  // ── K 線 Modal ────────────────────────────────────────────────────
  let modalId = null;

  function openModal(r) {
    const modal = document.getElementById('strength-modal');
    if (!modal) return;
    modalId = r.id;

    const list = getFiltered();
    const idx = list.findIndex(x => x.id === r.id);
    const canPrev = idx > 0;
    const canNext = idx >= 0 && idx < list.length - 1;
    const starred = (typeof Watchlist !== 'undefined' && Watchlist.has(r.id));
    document.getElementById('strength-modal-title').innerHTML =
      `<button class="tech-nav-arrow" id="str-nav-prev" ${canPrev ? '' : 'disabled'} title="上一檔">&#x25C0;</button>` +
      `<span class="tech-nav-center">` +
        `<button class="tech-nav-star" id="str-nav-star" title="加入清單" style="color:${starred ? '#f59e0b' : 'var(--text-dim)'}">${starred ? '★' : '☆'}</button>` +
        `<span class="tech-nav-label">${r.id} ${r.name}</span>` +
        stageBadge(r) +
        `<span class="str-rs ${rsCls(r.rs)}">RS ${r.rs}</span>` +
      `</span>` +
      `<button class="tech-nav-arrow" id="str-nav-next" ${canNext ? '' : 'disabled'} title="下一檔">&#x25B6;</button>`;
    document.getElementById('str-nav-prev')?.addEventListener('click', () => navigate(-1));
    document.getElementById('str-nav-next')?.addEventListener('click', () => navigate(1));
    document.getElementById('str-nav-star')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof Watchlist === 'undefined') return;
      Watchlist.toggle(r.id);
      const on = Watchlist.has(r.id);
      e.currentTarget.textContent = on ? '★' : '☆';
      e.currentTarget.style.color = on ? '#f59e0b' : 'var(--text-dim)';
    });

    const info = document.getElementById('strength-modal-info');
    const ma = r.ma || {};
    const themes = (r.themes || []).slice(0, 5)
      .map(t => `<span class="str-chip static">${t.replace(/概念股$/, '')}</span>`).join('');
    info.innerHTML =
      `<div class="vcp-info-kv">` +
      `<span>族群 <b>${r.group || '-'}</b></span>` +
      `<span>綜合分 <b>${r.score}</b></span>` +
      `<span>RS <b>${r.rs}</b></span>` +
      `<span>動能分 <b>${Math.round(r.momScore)}</b></span>` +
      `<span>量價分 <b>${Math.round(r.volScore)}</b></span>` +
      `<span>收盤 <b>${fmtNum(r.close)}</b> (${fmtPct(r.chgPct)}%)</span>` +
      `</div>` +
      `<div class="vcp-info-kv">` +
      `<span>距52週高 <b>${(r.distHigh * 100).toFixed(1)}%</b></span>` +
      `<span>距高天數 <b>${r.daysSinceHigh}</b></span>` +
      `<span>MA20乖離 <b class="${r.extended ? 'str-ext-num' : ''}">${(r.extMa20 * 100).toFixed(1)}%</b></span>` +
      `<span>3月 <b>${r.ret3m}%</b></span>` +
      `<span>6月 <b>${r.ret6m}%</b></span>` +
      `<span>12月 <b>${r.ret12m}%</b></span>` +
      `</div>` +
      `<div class="vcp-info-kv">` +
      `<span>量比(5/60) <b>${r.volRatio}</b></span>` +
      `<span>累積比 <b>${r.accum}</b></span>` +
      `<span>連漲 <b>${r.consecUp}</b> 日</span>` +
      `<span class="vcp-sum-meta">MA20 ${fmtNum(ma.ma20)} · MA60 ${fmtNum(ma.ma60)} · MA120 ${fmtNum(ma.ma120)}</span>` +
      `</div>` +
      (themes ? `<div class="str-sig-row">${themes}</div>` : '');

    modal.classList.add('show');
    requestAnimationFrame(() => renderChart('strength-price-chart', r));
  }

  function closeModal(ev) {
    if (ev && ev.target && ev.target.id !== 'strength-modal' && ev.type === 'click') return;
    const modal = document.getElementById('strength-modal');
    if (modal) modal.classList.remove('show');
    if (chart) { chart.destroy(); chart = null; }
    modalId = null;
  }

  function navigate(dir) {
    if (modalId == null) return;
    const list = getFiltered();
    const idx = list.findIndex(x => x.id === modalId);
    if (idx < 0) return;
    const ni = idx + dir;
    if (ni < 0 || ni >= list.length) return;
    openModal(list[ni]);
  }

  // ── 畫圖 (candlestick + MA5/20/60 + 52週高線) ─────────────────────
  function renderChart(canvasId, r) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    if (chart) { chart.destroy(); chart = null; }

    const o = r.ohlc;
    const n = o.dates.length;
    const labels = o.dates.map(fmtMD);
    const closeData = o.c.slice();
    const volLots = o.v.map(v => Math.round((v || 0) / 1000));
    const volColors = o.c.map((c, i) =>
      c >= o.o[i] ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.4)');

    const maN = (p) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        if (i + 1 < p) { out.push(null); continue; }
        let s = 0; for (let k = i + 1 - p; k <= i; k++) s += closeData[k];
        out.push(s / p);
      }
      return out;
    };
    const ma5 = maN(5), ma20 = maN(20), ma60 = maN(60);

    const hi52 = r.hi52;
    const allP = [...o.h, ...o.l, hi52].filter(v => v != null);
    const pMin = Math.min(...allP) * 0.98;
    const pMax = Math.max(...allP) * 1.02;

    const C = (typeof APP_CONFIG !== 'undefined') ? APP_CONFIG.colors
      : { up: '#ef4444', down: '#22c55e', text: '#e2e8f0', textMuted: '#94a3b8' };

    const overlay = {
      id: 'strengthOverlay',
      afterDatasetsDraw(ch) {
        const { ctx, chartArea, scales } = ch;
        const xs = scales.x, yp = scales.yPrice;
        if (!yp) return;
        ctx.save();
        const bw = Math.max(2, Math.min(10, (chartArea.width / n) * 0.4));
        for (let i = 0; i < n; i++) {
          const op = o.o[i], hi = o.h[i], lo = o.l[i], cl = o.c[i];
          if (op == null) continue;
          const x = xs.getPixelForValue(i);
          const col = cl >= op ? C.up : C.down;
          ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, yp.getPixelForValue(hi));
          ctx.lineTo(x, yp.getPixelForValue(lo));
          ctx.stroke();
          const yo = yp.getPixelForValue(op), yc = yp.getPixelForValue(cl);
          ctx.fillRect(x - bw, Math.min(yo, yc), bw * 2, Math.abs(yo - yc) || 1);
        }
        if (hi52 != null) {
          const yH = yp.getPixelForValue(hi52);
          ctx.strokeStyle = '#22d3ee';
          ctx.lineWidth = 1.3;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(chartArea.left, yH);
          ctx.lineTo(chartArea.right, yH);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#22d3ee';
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText('52週高 ' + fmtNum(hi52), chartArea.right - 4, yH - 4);
        }
        ctx.restore();
      }
    };

    chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'MA5', data: ma5, borderColor: '#f59e0b', backgroundColor: 'transparent', borderWidth: 1.3, pointRadius: 0, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'line', label: 'MA20', data: ma20, borderColor: '#a855f7', backgroundColor: 'transparent', borderWidth: 1.3, pointRadius: 0, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'line', label: 'MA60', data: ma60, borderColor: '#3b82f6', backgroundColor: 'transparent', borderWidth: 1.3, pointRadius: 0, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'bar', label: '成交量', data: volLots, backgroundColor: volColors, yAxisID: 'yVolume', order: 3, barPercentage: 0.6 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              afterTitle: (items) => {
                if (!items.length) return '';
                const i = items[0].dataIndex;
                return `開:${fmtNum(o.o[i])} 高:${fmtNum(o.h[i])} 低:${fmtNum(o.l[i])} 收:${fmtNum(o.c[i])}`;
              },
              label: (ctx) => ctx.dataset.label === '成交量'
                ? `成交量: ${Number(ctx.raw).toLocaleString()} 張`
                : `${ctx.dataset.label}: ${fmtNum(ctx.raw)}`,
            },
          },
        },
        scales: {
          x: { ticks: { color: C.textMuted, font: { size: 10 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 14 }, grid: { color: 'rgba(71,85,105,0.25)' } },
          yPrice: { position: 'left', min: pMin, max: pMax, ticks: { color: C.text }, grid: { color: 'rgba(71,85,105,0.25)' } },
          yVolume: { position: 'right', grid: { display: false }, ticks: { color: C.textMuted, callback: v => v.toLocaleString() }, max: (Math.max(...volLots.filter(v => v > 0)) || 1) * 3 },
        },
      },
      plugins: [overlay],
    });
  }

  // ── helpers ──────────────────────────────────────────────────────
  function fmtNum(v) {
    if (v == null) return '-';
    return Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function fmtPct(v) {
    if (v == null) return '-';
    return (v > 0 ? '+' : '') + Number(v).toFixed(2);
  }
  function fmtDate(d) {
    if (!d || d.length < 8) return d || '';
    return d.slice(0, 4) + '/' + d.slice(4, 6) + '/' + d.slice(6, 8);
  }
  function fmtMD(d) {
    if (!d || d.length < 8) return d || '';
    return d.slice(4, 6) + '/' + d.slice(6, 8);
  }

  return { loadData, getStats, buildFilterPanel, renderColumns, openModal, closeModal };
})();
