// VCP 選股視圖 — 讀 data/vcp.json (vcp_scanner.py 產出)
// 全市場個股 VCP screener + 點擊看 K 線收斂圖 (Pivot / 收斂區塊疊圖)
const VCPView = (() => {
  const DATA_URL = 'data/vcp.json';

  let vcpData = null;            // { _meta, stocks: [] }
  let vcpChart = null;

  // tier 嚴格度排序 (數字越大越嚴格)
  const TIER_RANK = { strict: 3, standard: 2, loose: 1 };
  const TIER_LABEL = { strict: '嚴格', standard: '標準', loose: '寬鬆' };
  const STAGE_LABEL = { breakout: '突破', setup: '待突破', extended: '已突破', watch: '觀察' };
  const STAGE_ORDER = ['breakout', 'setup', 'extended', 'watch'];

  const filters = {
    tier: 'loose',               // 顯示 ≥ 此嚴格度 (預設全部)
    stages: new Set(['breakout', 'setup', 'extended', 'watch']),
    keyword: '',
    sort: 'score',               // score | distToPivot | rsApprox
  };

  async function loadData() {
    if (vcpData) return vcpData;
    const resp = await fetch(DATA_URL, { cache: 'no-store' });
    if (!resp.ok) throw new Error('讀取 vcp.json 失敗: ' + resp.status);
    vcpData = await resp.json();
    return vcpData;
  }

  function getStats() {
    const m = vcpData ? vcpData._meta : {};
    return {
      asOf: m.asOf || '',
      scanned: m.scanned || 0,
      passed: m.passed || 0,
      byTier: m.byTier || {},
      byStage: m.byStage || {},
    };
  }

  // ── 篩選 + 排序 ──────────────────────────────────────────────────
  function getFiltered() {
    if (!vcpData) return [];
    const minRank = TIER_RANK[filters.tier] || 1;
    const kw = filters.keyword.trim().toLowerCase();
    let rows = vcpData.stocks.filter(r => {
      if ((TIER_RANK[r.tier] || 0) < minRank) return false;
      if (!filters.stages.has(r.stage)) return false;
      if (kw) {
        const hay = (r.id + ' ' + r.name).toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
    const key = filters.sort;
    rows.sort((a, b) => {
      if (key === 'distToPivot') return a.distToPivot - b.distToPivot;
      if (key === 'rsApprox') return b.rsApprox - a.rsApprox;
      return b.score - a.score;   // 預設分數高→低
    });
    return rows;
  }

  // ── 篩選面板 ──────────────────────────────────────────────────────
  function buildFilterPanel(containerId) {
    const panel = document.getElementById(containerId);
    if (!panel) return;
    const st = getStats();
    panel.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'vcp-filter';

    // 摘要
    const summary = document.createElement('div');
    summary.className = 'vcp-filter-summary';
    summary.innerHTML =
      `<div class="vcp-sum-title">VCP 掃描結果</div>` +
      `<div class="vcp-sum-meta">資料日 ${fmtDate(st.asOf)}</div>` +
      `<div class="vcp-sum-meta">掃描 ${st.scanned} 檔個股 · 通過 <b>${st.passed}</b></div>`;
    wrap.appendChild(summary);

    // 嚴格度 (segmented)
    wrap.appendChild(groupTitle('嚴格度'));
    const tierRow = document.createElement('div');
    tierRow.className = 'vcp-seg';
    ['strict', 'standard', 'loose'].forEach(t => {
      const b = document.createElement('button');
      const n = (st.byTier[t] || 0);
      // 累計數 (≥該嚴格度)
      const cum = ['strict', 'standard', 'loose']
        .filter(x => TIER_RANK[x] >= TIER_RANK[t])
        .reduce((s, x) => s + (st.byTier[x] || 0), 0);
      b.className = 'vcp-seg-btn' + (filters.tier === t ? ' active' : '');
      b.innerHTML = `${TIER_LABEL[t]}<span class="vcp-seg-n">${cum}</span>`;
      b.onclick = () => { filters.tier = t; applyAndRender(); };
      tierRow.appendChild(b);
    });
    wrap.appendChild(tierRow);

    // 狀態
    wrap.appendChild(groupTitle('狀態'));
    const stageBox = document.createElement('div');
    stageBox.className = 'vcp-check-group';
    STAGE_ORDER.forEach(s => {
      const label = document.createElement('label');
      label.className = 'vcp-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = filters.stages.has(s);
      cb.onchange = () => {
        if (cb.checked) filters.stages.add(s); else filters.stages.delete(s);
        applyAndRender();
      };
      const span = document.createElement('span');
      span.innerHTML = `<span class="vcp-badge stage-${s}">${STAGE_LABEL[s]}</span>` +
        ` <span class="vcp-seg-n">${st.byStage[s] || 0}</span>`;
      label.appendChild(cb);
      label.appendChild(span);
      stageBox.appendChild(label);
    });
    wrap.appendChild(stageBox);

    // 排序
    wrap.appendChild(groupTitle('排序'));
    const sortSel = document.createElement('select');
    sortSel.className = 'vcp-select';
    [['score', '分數 (高→低)'], ['distToPivot', '距 Pivot (近→遠)'], ['rsApprox', '動能 (強→弱)']]
      .forEach(([v, t]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        if (filters.sort === v) o.selected = true;
        sortSel.appendChild(o);
      });
    sortSel.onchange = () => { filters.sort = sortSel.value; applyAndRender(); };
    wrap.appendChild(sortSel);

    // 搜尋
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

  function groupTitle(t) {
    const d = document.createElement('div');
    d.className = 'vcp-filter-group-title';
    d.textContent = t;
    return d;
  }

  // ── 主表格 ────────────────────────────────────────────────────────
  function renderColumns(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const rows = getFiltered();
    container.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'vcp-table-head';
    head.innerHTML = `共 <b>${rows.length}</b> 檔符合 — 點列看收斂圖`;
    container.appendChild(head);

    const table = document.createElement('table');
    table.className = 'vcp-table';
    table.innerHTML = `
      <thead><tr>
        <th></th><th>代號</th><th>名稱</th><th>市</th>
        <th>等級</th><th>狀態</th><th class="num">分數</th>
        <th class="num">收盤</th><th class="num">Pivot</th><th class="num">距%</th>
        <th class="num">波</th><th>收斂深度</th><th class="num">量縮</th>
      </tr></thead>`;
    const tbody = document.createElement('tbody');

    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = 'vcp-row';
      const depths = r.contractions.map(c => Math.round(c.depth * 100)).join('→');
      const starred = (typeof Watchlist !== 'undefined' && Watchlist.has(r.id));
      tr.innerHTML = `
        <td class="vcp-star ${starred ? 'on' : ''}" data-code="${r.id}">${starred ? '★' : '☆'}</td>
        <td class="vcp-code">${r.id}</td>
        <td class="vcp-name">${r.name}</td>
        <td class="vcp-mkt">${r.market === 'TWSE' ? '市' : '櫃'}</td>
        <td><span class="vcp-badge tier-${r.tier}">${TIER_LABEL[r.tier]}</span></td>
        <td><span class="vcp-badge stage-${r.stage}">${STAGE_LABEL[r.stage]}</span></td>
        <td class="num"><span class="vcp-score">${r.score}</span></td>
        <td class="num">${fmtNum(r.lastClose)}</td>
        <td class="num">${fmtNum(r.pivot)}</td>
        <td class="num ${r.distToPivot <= 0 ? 'up' : ''}">${(r.distToPivot * 100).toFixed(1)}</td>
        <td class="num">${r.contractions.length}</td>
        <td class="vcp-depths">${depths}</td>
        <td class="num">${r.volDryUp.toFixed(2)}</td>`;
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
    container.appendChild(table);
  }

  function applyAndRender() {
    buildFilterPanel('filter-panel');
    renderColumns('main-table');
  }

  // ── K 線收斂圖 Modal ──────────────────────────────────────────────
  let modalId = null;          // 目前 modal 開的股票代號 (給上一檔/下一檔導航)

  function openModal(r) {
    const modal = document.getElementById('vcp-modal');
    if (!modal) return;
    modalId = r.id;

    // ◀ ☆ 代號名稱+徽章 ▶ — 串接目前篩選+排序後的清單前後切換
    const list = getFiltered();
    const idx = list.findIndex(x => x.id === r.id);
    const canPrev = idx > 0;
    const canNext = idx >= 0 && idx < list.length - 1;
    const starred = (typeof Watchlist !== 'undefined' && Watchlist.has(r.id));
    document.getElementById('vcp-modal-title').innerHTML =
      `<button class="tech-nav-arrow" id="vcp-nav-prev" ${canPrev ? '' : 'disabled'} title="上一檔">&#x25C0;</button>` +
      `<span class="tech-nav-center">` +
        `<button class="tech-nav-star" id="vcp-nav-star" title="加入清單" style="color:${starred ? '#f59e0b' : 'var(--text-dim)'}">${starred ? '★' : '☆'}</button>` +
        `<span class="tech-nav-label">${r.id} ${r.name}</span>` +
        `<span class="vcp-badge tier-${r.tier}">${TIER_LABEL[r.tier]}</span>` +
        `<span class="vcp-badge stage-${r.stage}">${STAGE_LABEL[r.stage]}</span>` +
      `</span>` +
      `<button class="tech-nav-arrow" id="vcp-nav-next" ${canNext ? '' : 'disabled'} title="下一檔">&#x25B6;</button>`;
    document.getElementById('vcp-nav-prev')?.addEventListener('click', () => navigate(-1));
    document.getElementById('vcp-nav-next')?.addEventListener('click', () => navigate(1));
    document.getElementById('vcp-nav-star')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof Watchlist === 'undefined') return;
      Watchlist.toggle(r.id);
      const on = Watchlist.has(r.id);
      e.currentTarget.textContent = on ? '★' : '☆';
      e.currentTarget.style.color = on ? '#f59e0b' : 'var(--text-dim)';
    });

    // 收斂明細
    const info = document.getElementById('vcp-modal-info');
    const rows = r.contractions.map((c, i) =>
      `<tr><td>第${i + 1}波</td><td>${c.highDate.slice(4)}</td><td>${fmtNum(c.high)}</td>` +
      `<td>${c.lowDate.slice(4)}</td><td>${fmtNum(c.low)}</td>` +
      `<td class="num">${(c.depth * 100).toFixed(1)}%</td></tr>`).join('');
    info.innerHTML =
      `<div class="vcp-info-kv">` +
      `<span>Pivot <b>${fmtNum(r.pivot)}</b></span>` +
      `<span>收盤 <b>${fmtNum(r.lastClose)}</b></span>` +
      `<span>距 Pivot <b>${(r.distToPivot * 100).toFixed(1)}%</b></span>` +
      `<span>量縮比 <b>${r.volDryUp.toFixed(2)}</b></span>` +
      `<span>base <b>${r.baseLen}</b> 日</span>` +
      `<span>分數 <b>${r.score}</b></span></div>` +
      `<table class="vcp-info-table"><thead><tr>` +
      `<th>收斂</th><th>高點日</th><th>高</th><th>低點日</th><th>低</th><th class="num">深度</th>` +
      `</tr></thead><tbody>${rows}</tbody></table>`;

    modal.classList.add('show');
    // 等 layout 完成再畫 (canvas 尺寸)
    requestAnimationFrame(() => renderVCPChart('vcp-price-chart', r));
  }

  function closeModal(ev) {
    if (ev && ev.target && ev.target.id !== 'vcp-modal' && ev.type === 'click') return;
    const modal = document.getElementById('vcp-modal');
    if (modal) modal.classList.remove('show');
    if (vcpChart) { vcpChart.destroy(); vcpChart = null; }
    modalId = null;
  }

  /** 上一檔(-1)/下一檔(+1) — 走目前篩選+排序後的清單 */
  function navigate(dir) {
    if (modalId == null) return;
    const list = getFiltered();
    const idx = list.findIndex(x => x.id === modalId);
    if (idx < 0) return;
    const ni = idx + dir;
    if (ni < 0 || ni >= list.length) return;
    openModal(list[ni]);
  }

  // ── 畫圖 (沿用現有 candlestick 畫法 + VCP 疊圖) ───────────────────
  function renderVCPChart(canvasId, r) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    if (vcpChart) { vcpChart.destroy(); vcpChart = null; }

    const o = r.ohlc;
    const n = o.dates.length;
    const labels = o.dates.map(fmtMD);
    const closeData = o.c.slice();
    const volLots = o.v.map(v => Math.round((v || 0) / 1000));
    const volColors = o.c.map((c, i) =>
      c >= o.o[i] ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.4)');

    const ma = (p) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        if (i + 1 < p) { out.push(null); continue; }
        let s = 0; for (let k = i + 1 - p; k <= i; k++) s += closeData[k];
        out.push(s / p);
      }
      return out;
    };
    const ma5 = ma(5), ma10 = ma(10), ma20 = ma(20);

    const allP = [...o.h, ...o.l, r.pivot].filter(v => v != null);
    const pMin = Math.min(...allP) * 0.99;
    const pMax = Math.max(...allP) * 1.01;

    const C = (typeof APP_CONFIG !== 'undefined') ? APP_CONFIG.colors
      : { up: '#ef4444', down: '#22c55e', text: '#e2e8f0', textMuted: '#94a3b8' };
    const zones = (r.markers && r.markers.contractionZones) || [];
    const pivot = r.markers ? r.markers.pivotLine : r.pivot;

    // 收斂高低點 ZigZag 連線點位: H1→L1→H2→L2→… (x=切片index, y=價)
    const cons = r.contractions || [];
    const zz = [];
    zones.forEach((z, k) => {
      const ct = cons[k];
      if (!ct) return;
      zz.push({ x: z[0], y: ct.high });
      zz.push({ x: z[1], y: ct.low });
    });

    // 收斂區塊 + Pivot 線 疊圖 plugin
    const overlay = {
      id: 'vcpOverlay',
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        const xs = scales.x, yp = scales.yPrice;
        if (!yp) return;
        ctx.save();
        // 收斂區塊 (交替色帶)
        zones.forEach((z, idx) => {
          const x1 = xs.getPixelForValue(z[0]);
          const x2 = xs.getPixelForValue(z[1]);
          ctx.fillStyle = idx % 2 === 0
            ? 'rgba(59,130,246,0.10)' : 'rgba(168,85,247,0.10)';
          ctx.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
        });
        ctx.restore();
      },
      afterDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        const xs = scales.x, yp = scales.yPrice;
        if (!yp) return;
        ctx.save();
        // K 棒
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
        // Pivot 線 (金色虛線)
        const yPiv = yp.getPixelForValue(pivot);
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(chartArea.left, yPiv);
        ctx.lineTo(chartArea.right, yPiv);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#fbbf24';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('Pivot ' + fmtNum(pivot), chartArea.right - 4, yPiv - 4);

        // 收斂高低點連線 (螢光黃 ZigZag) — 把偵測到的 H/L 依序連起來
        if (zz.length >= 2) {
          ctx.strokeStyle = '#eaff00';
          ctx.lineWidth = 2.5;
          ctx.lineJoin = 'round';
          ctx.beginPath();
          zz.forEach((p, k) => {
            const px = xs.getPixelForValue(p.x);
            const py = yp.getPixelForValue(p.y);
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          });
          ctx.stroke();
          ctx.fillStyle = '#eaff00';
          zz.forEach(p => {
            const px = xs.getPixelForValue(p.x);
            const py = yp.getPixelForValue(p.y);
            ctx.beginPath();
            ctx.arc(px, py, 3.5, 0, Math.PI * 2);
            ctx.fill();
          });
        }
        ctx.restore();
      }
    };

    vcpChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'MA5', data: ma5, borderColor: '#f59e0b', backgroundColor: 'transparent', borderWidth: 1.3, pointRadius: 0, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'line', label: 'MA10', data: ma10, borderColor: '#3b82f6', backgroundColor: 'transparent', borderWidth: 1.3, pointRadius: 0, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'line', label: 'MA20', data: ma20, borderColor: '#a855f7', backgroundColor: 'transparent', borderWidth: 1.3, pointRadius: 0, yAxisID: 'yPrice', order: 1, tension: 0.1 },
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
