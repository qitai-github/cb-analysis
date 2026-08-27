/* scatterView.js — 「分布圖」分頁:每日 CB 收盤結果的散布圖
 * 橫軸 = CB 收盤價,縱軸 = CB 溢價率(%),一點 = 一檔可轉債。
 * 可用雙滑軌篩選 CB 價格 / 溢價率範圍,點擊點會開該檔 CB 對應個股的詳情面板。
 */
const ScatterView = (() => {
  let chart = null;
  // 使用者拉過的範圍(null = 尚未設定,套用資料全距)
  let priceRange = null;    // { min, max }
  let premiumRange = null;
  let lastBounds = null;    // 資料全距 { pMin, pMax, rMin, rMax }

  // 依「產業別」分色。industryCategory 是「電機機械、CoWoS概念股、…」這種串,
  // 第一段才是真正的產業別,後面是概念股標籤 → 只取第一段。
  const PALETTE = [
    '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4',
    '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#8b5cf6', '#eab308',
    '#f43f5e', '#10b981', '#0ea5e9', '#d946ef'
  ];
  // 顏色重複時用不同形狀再區分一次
  const SHAPES = ['circle', 'triangle', 'rect', 'rectRot', 'star', 'crossRot'];
  const OTHER = '其他';
  const MAX_GROUPS = 16;   // 超過的併入「其他」

  // CB 價格分帶(分色模式 = price 時用)
  const BANDS = [
    { label: 'CB < 100',   test: v => v < 100,             color: '#22c55e' },
    { label: 'CB 100–110', test: v => v >= 100 && v < 110, color: '#3b82f6' },
    { label: 'CB 110–130', test: v => v >= 110 && v < 130, color: '#f59e0b' },
    { label: 'CB ≥ 130',   test: v => v >= 130,            color: '#ef4444' }
  ];

  let pointMode = 'dot';        // 'dot' | 'bubble' — 小點 or 依發行總額的氣泡(圈內標 CB 代號/名稱)
  let amtStats = null;          // { min, max } 發行總額(百萬),算氣泡半徑用
  const BUBBLE_R = { min: 7, max: 34 };   // 氣泡半徑範圍 (px)
  let industryFilter = '';      // '' = 全部產業;否則只畫該產業的 CB
  let colorMode = 'industry';   // 'industry' | 'price' — 分色依據,切換後記住
  let groups = [];              // [{ key, color, shape, n }] — 由資料+模式算出

  function industryOf(cb) {
    const s = cb && cb.industryCategory;
    if (!s) return OTHER;
    return String(s).split('、')[0].trim() || OTHER;
  }

  /** 依目前 colorMode 建立分組,並在每個點寫上所屬分組 index (p.gi) */
  function buildGroups(pts) {
    if (colorMode === 'price') return buildPriceGroups(pts);
    return buildIndustryGroups(pts);
  }

  /** 價格帶分組 */
  function buildPriceGroups(pts) {
    groups = BANDS.map(b => ({ key: b.label, color: b.color, shape: 'circle', n: 0 }));
    for (const p of pts) {
      const i = BANDS.findIndex(b => b.test(p.x));
      p.gi = i;
      if (i >= 0) groups[i].n++;
    }
  }

  /** 依出現檔數由多到少建立產業分組(尾巴併成「其他」)*/
  function buildIndustryGroups(pts) {
    const count = new Map();
    for (const p of pts) {
      const k = industryOf(p.cb);
      count.set(k, (count.get(k) || 0) + 1);
    }
    const sorted = [...count.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const keep = sorted.filter(k => k !== OTHER).slice(0, MAX_GROUPS);
    const hasOther = sorted.length > keep.length;
    const keys = hasOther ? keep.concat([OTHER]) : keep;
    const keepSet = new Set(keep);
    groups = keys.map((k, i) => (k === OTHER
      ? { key: OTHER, color: '#64748b', shape: 'circle', n: 0 }
      : { key: k, color: PALETTE[i % PALETTE.length], shape: SHAPES[Math.floor(i / PALETTE.length) % SHAPES.length], n: count.get(k) || 0 }));
    // 每個點先算好所屬分組 index,update() 只要比對數字
    const idx = new Map(groups.map((g, i) => [g.key, i]));
    const otherIdx = idx.has(OTHER) ? idx.get(OTHER) : -1;
    for (const p of pts) {
      const k = industryOf(p.cb);
      p.gi = keepSet.has(k) ? idx.get(k) : otherIdx;
      if (p.gi === otherIdx && otherIdx >= 0 && !keepSet.has(k)) groups[otherIdx].n++;
    }
  }

  const num = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);

  /** 取出同時有收盤價 + 溢價率的 CB 列 */
  function validPoints(cbRows) {
    const out = [];
    for (const cb of cbRows || []) {
      const x = num(cb.close), y = num(cb.premiumRate);
      if (x === null || y === null) continue;
      out.push({ x, y, cb });
    }
    return out;
  }

  /** 發行總額 (百萬元)。元大 basicInfo 的 actualTotal 為主,沒有就退回 issueTotal */
  function issueAmount(cb) {
    const a = num(cb && cb.actualTotal);
    if (a !== null && a > 0) return a;
    const b = num(cb && cb.issueTotal);
    return (b !== null && b > 0) ? b : null;
  }

  /** 依發行總額算氣泡半徑:用 sqrt 讓「面積」正比於金額,不然大案子會大得太誇張 */
  function bubbleRadius(amt) {
    if (!amtStats || amt == null) return BUBBLE_R.min;
    const { min, max } = amtStats;
    if (!(max > min)) return (BUBBLE_R.min + BUBBLE_R.max) / 2;
    const t = Math.sqrt((amt - min) / (max - min));
    return BUBBLE_R.min + t * (BUBBLE_R.max - BUBBLE_R.min);
  }

  /** 每個點先算好兩種模式要用的半徑 */
  function computeRadii(pts) {
    const amts = pts.map(p => issueAmount(p.cb)).filter(a => a !== null);
    amtStats = amts.length ? { min: Math.min(...amts), max: Math.max(...amts) } : null;
    for (const p of pts) {
      p.amt = issueAmount(p.cb);
      p.r = p.amt == null ? BUBBLE_R.min : bubbleRadius(p.amt);
    }
  }

  const roundDown = (v, step) => Math.floor(v / step) * step;
  const roundUp   = (v, step) => Math.ceil(v / step) * step;

  /**
   * @param {HTMLElement} panel  要塞內容的容器 (已在 DOM 上)
   * @param {Array} cbRows       已套過篩選的逐檔 CB
   * @param {Object} options     { onRowClick }
   */
  function render(panel, cbRows, options = {}) {
    destroy();
    panel.innerHTML = '';
    panel.classList.add('scatter-panel');

    const pts = validPoints(cbRows);
    if (!pts.length) {
      panel.innerHTML = '<div class="scatter-empty">目前篩選條件下沒有可畫的 CB(需同時有收盤價與溢價率)</div>';
      return;
    }

    // === 資料全距(滑軌上下限)===
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const pMin = roundDown(Math.min(...xs), 5);
    const pMax = roundUp(Math.max(...xs), 5);
    const rMin = roundDown(Math.min(...ys), 10);
    const rMax = roundUp(Math.max(...ys), 10);
    const bounds = { pMin, pMax, rMin, rMax };

    // 資料全距變了(換篩選 / 換日期)→ 重設滑軌;否則沿用使用者拉的範圍
    const same = lastBounds && ['pMin', 'pMax', 'rMin', 'rMax'].every(k => lastBounds[k] === bounds[k]);
    if (!same) { priceRange = null; premiumRange = null; }
    lastBounds = bounds;
    if (!priceRange)   priceRange   = { min: pMin, max: pMax };
    if (!premiumRange) premiumRange = { min: rMin, max: rMax };
    // 夾回合法區間
    priceRange   = { min: Math.max(pMin, Math.min(priceRange.min, pMax)),   max: Math.min(pMax, Math.max(priceRange.max, pMin)) };
    premiumRange = { min: Math.max(rMin, Math.min(premiumRange.min, rMax)), max: Math.min(rMax, Math.max(premiumRange.max, rMin)) };

    // === 版面 ===
    panel.innerHTML =
      '<div class="scatter-controls">' +
        industrySelectHtml(pts) +
        sliderHtml('price', 'CB 價格', pMin, pMax, 1, priceRange, '') +
        sliderHtml('prem', '溢價率', rMin, rMax, 1, premiumRange, '%') +
        '<div class="scatter-mode">' +
          '<span class="scatter-mode-label">樣式</span>' +
          '<button type="button" class="scatter-pt-btn" data-pt="dot">小點</button>' +
          '<button type="button" class="scatter-pt-btn" data-pt="bubble">氣泡</button>' +
        '</div>' +
        '<div class="scatter-mode">' +
          '<span class="scatter-mode-label">分色</span>' +
          '<button type="button" class="scatter-mode-btn" data-mode="industry">產業</button>' +
          '<button type="button" class="scatter-mode-btn" data-mode="price">價格帶</button>' +
        '</div>' +
        '<div class="scatter-count" id="scatter-count"></div>' +
        '<button class="scatter-reset" id="scatter-reset" type="button">重設範圍</button>' +
      '</div>' +
      '<div class="scatter-legend" id="scatter-legend"></div>' +
      '<div class="scatter-canvas-wrap"><canvas id="scatter-canvas"></canvas></div>' +
      '<div class="scatter-hint">「產業」下拉可只看單一產業;點擊任一點可開啟該檔 CB 對應個股的詳情面板;點上方圖例可隱藏/顯示該分組;「分色」可切換依產業或依 CB 價格帶上色;「樣式」切到氣泡時,圈圈大小 = 發行總額,圈內直接標 CB 代號與名稱。</div>';

    const indSel = panel.querySelector('#scatter-industry');
    if (indSel) {
      indSel.addEventListener('change', () => {
        industryFilter = indSel.value;
        update(pts, panel);
      });
    }

    bindSlider(panel, 'price', () => update(pts, panel));
    bindSlider(panel, 'prem',  () => update(pts, panel));
    panel.querySelector('#scatter-reset').addEventListener('click', () => {
      priceRange = { min: pMin, max: pMax };
      premiumRange = { min: rMin, max: rMax };
      setSlider(panel, 'price', priceRange);
      setSlider(panel, 'prem', premiumRange);
      industryFilter = '';
      if (indSel) indSel.value = '';
      groups.forEach((g, i) => chart && chart.setDatasetVisibility(i, true));
      renderLegend(panel);
      update(pts, panel);
    });

    panel.querySelectorAll('.scatter-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.mode === colorMode) return;
        colorMode = btn.dataset.mode;
        paintModeBtns(panel);
        regroup(pts, panel);
      });
    });
    panel.querySelectorAll('.scatter-pt-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.pt === pointMode) return;
        pointMode = btn.dataset.pt;
        paintModeBtns(panel);
        if (chart) {
          chart.data.datasets = datasetsFromGroups();
          update(pts, panel);
        }
      });
    });
    paintModeBtns(panel);

    computeRadii(pts);
    buildGroups(pts);
    buildChart(panel, options);
    renderLegend(panel);
    update(pts, panel);
  }

  /** 產業下拉:選項 = 這批資料裡有的產業別 (依檔數排序,含檔數) */
  function industrySelectHtml(pts) {
    const count = new Map();
    for (const p of pts) {
      const k = industryOf(p.cb);
      count.set(k, (count.get(k) || 0) + 1);
    }
    const list = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    // 上次選的產業這批資料沒有 → 退回全部
    if (industryFilter && !count.has(industryFilter)) industryFilter = '';
    const opts = ['<option value="">— 全部產業 (' + pts.length + ') —</option>']
      .concat(list.map(([k, n]) =>
        '<option value="' + k + '"' + (k === industryFilter ? ' selected' : '') + '>' + k + ' (' + n + ')</option>'));
    return '' +
      '<div class="scatter-ind">' +
        '<span class="scatter-ind-label">產業</span>' +
        '<select id="scatter-industry" class="scatter-ind-select">' + opts.join('') + '</select>' +
      '</div>';
  }

  /** 雙滑軌(兩個 range input 疊在同一條軌道上)*/
  function sliderHtml(id, label, min, max, step, cur, unit) {
    return '' +
      '<div class="scatter-slider" data-slider="' + id + '" data-min="' + min + '" data-max="' + max + '" data-unit="' + unit + '">' +
        '<div class="scatter-slider-head">' +
          '<span class="scatter-slider-label">' + label + '</span>' +
          '<span class="scatter-slider-val" id="scatter-' + id + '-val">' + cur.min + unit + ' ~ ' + cur.max + unit + '</span>' +
        '</div>' +
        '<div class="scatter-slider-track">' +
          '<div class="scatter-slider-fill" id="scatter-' + id + '-fill"></div>' +
          '<input type="range" id="scatter-' + id + '-lo" min="' + min + '" max="' + max + '" step="' + step + '" value="' + cur.min + '">' +
          '<input type="range" id="scatter-' + id + '-hi" min="' + min + '" max="' + max + '" step="' + step + '" value="' + cur.max + '">' +
        '</div>' +
      '</div>';
  }

  function bindSlider(panel, id, onChange) {
    const lo = panel.querySelector('#scatter-' + id + '-lo');
    const hi = panel.querySelector('#scatter-' + id + '-hi');
    const handler = (which) => {
      let a = Number(lo.value), b = Number(hi.value);
      if (a > b) {
        if (which === 'lo') { a = b; lo.value = a; } else { b = a; hi.value = b; }
      }
      const range = { min: a, max: b };
      if (id === 'price') priceRange = range; else premiumRange = range;
      paintSlider(panel, id, range);
      onChange();
    };
    lo.addEventListener('input', () => handler('lo'));
    hi.addEventListener('input', () => handler('hi'));
    paintSlider(panel, id, id === 'price' ? priceRange : premiumRange);
  }

  function setSlider(panel, id, range) {
    panel.querySelector('#scatter-' + id + '-lo').value = range.min;
    panel.querySelector('#scatter-' + id + '-hi').value = range.max;
    paintSlider(panel, id, range);
  }

  function paintSlider(panel, id, range) {
    const box = panel.querySelector('.scatter-slider[data-slider="' + id + '"]');
    if (!box) return;
    const min = Number(box.dataset.min), max = Number(box.dataset.max), unit = box.dataset.unit || '';
    const span = (max - min) || 1;
    const fill = panel.querySelector('#scatter-' + id + '-fill');
    if (fill) {
      fill.style.left = ((range.min - min) / span * 100) + '%';
      fill.style.right = ((max - range.max) / span * 100) + '%';
    }
    const val = panel.querySelector('#scatter-' + id + '-val');
    if (val) val.textContent = range.min + unit + ' ~ ' + range.max + unit;
  }

  /** 氣泡模式:在圈圈裡畫兩行字 (上 = CB 代號,下 = CB 名稱)。
   *  圈太小塞不下就不畫;字寬超過直徑先縮字、再退成只畫代號;
   *  重疊時大圈優先,會撞到已畫標籤的就跳過。 */
  const bubbleLabelPlugin = {
    id: 'scatterBubbleLabel',
    afterDatasetsDraw(c) {
      if (pointMode !== 'bubble') return;
      const ctx = c.ctx;

      // 先把所有可見的點收起來,由大到小畫標籤;疊在一起時大的優先,
      // 小的如果會撞到已畫的字就跳過 (不然密集區會糊成一團看不懂)
      const cands = [];
      for (let di = 0; di < c.data.datasets.length; di++) {
        if (!c.isDatasetVisible(di)) continue;
        const els = c.getDatasetMeta(di).data || [];
        const raws = c.data.datasets[di].data || [];
        for (let i = 0; i < els.length; i++) {
          const el = els[i], raw = raws[i];
          if (!el || !raw || el.skip) continue;
          const cb = raw.cb || {};
          if (!cb.cbCode && !cb.cbName) continue;
          cands.push({ x: el.x, y: el.y, r: raw.r || BUBBLE_R.min, code: String(cb.cbCode || ''), name: String(cb.cbName || '') });
        }
      }
      cands.sort((a, b) => b.r - a.r);

      const taken = [];
      const hits = (box) => taken.some(t =>
        box.x1 < t.x2 && box.x2 > t.x1 && box.y1 < t.y2 && box.y2 > t.y1);

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const p of cands) {
        if (p.r < 10) continue;                       // 圈太小塞不下字
        let size = Math.max(8, Math.min(13, Math.round(p.r * 0.52)));
        const maxW = p.r * 1.75;
        const longest = p.name.length > p.code.length ? p.name : p.code;
        const widthOf = (txt, sz) => { ctx.font = '600 ' + sz + 'px sans-serif'; return ctx.measureText(txt).width; };
        while (size > 8 && widthOf(longest, size) > maxW) size--;
        const twoLines = p.r >= 13 && widthOf(p.name, size) <= maxW && !!p.name;
        const w = Math.max(widthOf(p.code, size), twoLines ? widthOf(p.name, size) : 0);
        const h = twoLines ? size * 2.2 : size * 1.2;
        const box = { x1: p.x - w / 2 - 1, x2: p.x + w / 2 + 1, y1: p.y - h / 2 - 1, y2: p.y + h / 2 + 1 };
        if (hits(box)) continue;
        taken.push(box);
        ctx.font = '600 ' + size + 'px sans-serif';
        ctx.fillStyle = '#f8fafc';
        ctx.shadowColor = 'rgba(15,23,42,0.95)';
        ctx.shadowBlur = 3;
        if (twoLines) {
          ctx.fillText(p.code, p.x, p.y - size * 0.55);
          ctx.fillText(p.name, p.x, p.y + size * 0.6);
        } else {
          ctx.fillText(p.code, p.x, p.y);
        }
        ctx.shadowBlur = 0;
      }
      ctx.restore();
    }
  };

  function buildChart(panel, options) {
    const canvas = panel.querySelector('#scatter-canvas');
    if (!canvas || typeof Chart === 'undefined') return;
    chart = new Chart(canvas.getContext('2d'), {
      type: 'scatter',
      plugins: [bubbleLabelPlugin],
      data: {
        datasets: datasetsFromGroups()
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        onClick: (evt, els) => {
          if (!els.length || !options.onRowClick) return;
          const p = chart.data.datasets[els[0].datasetIndex].data[els[0].index];
          if (p && p.cb) options.onRowClick(p.cb.stockRef || p.cb);
        },
        onHover: (evt, els) => {
          if (evt.native && evt.native.target) evt.native.target.style.cursor = els.length ? 'pointer' : 'default';
        },
        scales: {
          x: {
            title: { display: true, text: 'CB 收盤價', color: '#94a3b8' },
            ticks: { color: '#94a3b8' },
            grid: { color: 'rgba(71,85,105,0.25)' }
          },
          y: {
            title: { display: true, text: 'CB 溢價率 (%)', color: '#94a3b8' },
            ticks: { color: '#94a3b8', callback: v => v + '%' },
            grid: { color: 'rgba(71,85,105,0.25)' }
          }
        },
        plugins: {
          legend: { display: false },   // 用外部 HTML 圖例 (產業多,canvas 內會被裁掉)
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const cb = (ctx.raw && ctx.raw.cb) || {};
                const lines = [
                  (cb.cbCode || '') + ' ' + (cb.cbName || ''),
                  'CB 收盤 ' + ctx.parsed.x.toFixed(2),
                  '溢價率 ' + ctx.parsed.y.toFixed(2) + '%'
                ];
                if (cb.conversionPrice != null) lines.push('轉換價 ' + Number(cb.conversionPrice).toFixed(2));
                if (ctx.raw && ctx.raw.amt != null) lines.push('發行總額 ' + Number(ctx.raw.amt).toLocaleString() + ' 百萬');
                if (cb.volume != null) lines.push('成交量 ' + Number(cb.volume).toLocaleString() + ' 張');
                if (cb.industryCategory) lines.push(String(cb.industryCategory).split('、')[0]);
                return lines;
              }
            }
          }
        }
      }
    });
  }

  function paintModeBtns(panel) {
    panel.querySelectorAll('.scatter-mode-btn').forEach(b =>
      b.classList.toggle('on', b.dataset.mode === colorMode));
    panel.querySelectorAll('.scatter-pt-btn').forEach(b =>
      b.classList.toggle('on', b.dataset.pt === pointMode));
  }

  /** 切換分色依據:重算分組後換掉 datasets(不重建 chart,座標軸/滑軌都不動) */
  function regroup(pts, panel) {
    buildGroups(pts);
    if (!chart) return;
    chart.data.datasets = datasetsFromGroups();
    chart.update('none');
    // dataset 顯示狀態是按 index 記的,換過分組後一律全部顯示,避免沿用到別組的隱藏狀態
    chart.data.datasets.forEach((_, i) => chart.setDatasetVisibility(i, true));
    renderLegend(panel);
    update(pts, panel);
  }

  /** 由 groups 產生 Chart.js datasets(空資料,由 update() 填) */
  function datasetsFromGroups() {
    const bubble = pointMode === 'bubble';
    return groups.map(g => ({
      label: g.key,
      data: [],
      // 氣泡會互相蓋到,底色調淡一點才看得出重疊
      backgroundColor: g.color + (bubble ? '66' : 'cc'),
      borderColor: g.color,
      borderWidth: bubble ? 1.5 : 1,
      // 氣泡模式一律圓形 (要在圈內塞兩行字)
      pointStyle: bubble ? 'circle' : g.shape,
      pointRadius: bubble
        ? (ctx) => (ctx.raw && ctx.raw.r) || BUBBLE_R.min
        : (g.shape === 'circle' ? 4 : 5),
      pointHoverRadius: bubble
        ? (ctx) => ((ctx.raw && ctx.raw.r) || BUBBLE_R.min) + 2
        : (g.shape === 'circle' ? 7 : 8)
    }));
  }

  /** 外部 HTML 圖例:一個產業一顆 chip,點擊切換顯示/隱藏 */
  function renderLegend(panel) {
    const box = panel.querySelector('#scatter-legend');
    if (!box || !chart) return;
    box.innerHTML = groups.map((g, i) =>
      '<button type="button" class="scatter-lg' + (chart.isDatasetVisible(i) ? '' : ' off') + '" data-i="' + i + '">' +
        '<span class="scatter-lg-dot" style="background:' + g.color + '"></span>' +
        g.key + ' <span class="scatter-lg-n">' + g.n + '</span>' +
      '</button>').join('');
    box.querySelectorAll('.scatter-lg').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        chart.setDatasetVisibility(i, !chart.isDatasetVisible(i));
        btn.classList.toggle('off', !chart.isDatasetVisible(i));
        chart.update();
      });
    });
  }

  /** 套用滑軌範圍 → 依產業分組餵給各 dataset */
  function update(pts, panel) {
    if (!chart) return;
    const inRange = pts.filter(p =>
      p.x >= priceRange.min && p.x <= priceRange.max &&
      p.y >= premiumRange.min && p.y <= premiumRange.max &&
      (!industryFilter || industryOf(p.cb) === industryFilter));

    const buckets = groups.map(() => []);
    for (const p of inRange) {
      if (p.gi >= 0) buckets[p.gi].push(p);
    }
    // 氣泡模式:同一組內大的先畫 (畫在底層),小的才不會被整個蓋掉
    if (pointMode === 'bubble') buckets.forEach(b => b.sort((p, q) => (q.r || 0) - (p.r || 0)));
    groups.forEach((g, i) => { chart.data.datasets[i].data = buckets[i]; });
    // X/Y 軸跟著滑軌走(留一點邊)
    const padX = Math.max(1, (priceRange.max - priceRange.min) * 0.03);
    const padY = Math.max(1, (premiumRange.max - premiumRange.min) * 0.03);
    chart.options.scales.x.min = priceRange.min - padX;
    chart.options.scales.x.max = priceRange.max + padX;
    chart.options.scales.y.min = premiumRange.min - padY;
    chart.options.scales.y.max = premiumRange.max + padY;
    chart.update();

    const countEl = panel.querySelector('#scatter-count');
    if (countEl) countEl.textContent = '顯示 ' + inRange.length + ' / ' + pts.length + ' 檔';
  }

  function destroy() {
    if (chart) { chart.destroy(); chart = null; }
  }

  return { render, destroy };
})();
