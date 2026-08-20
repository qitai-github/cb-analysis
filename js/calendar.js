// CB 日曆檢視模組 — 把 cbasCalendar 事件排進月曆
const Calendar = (() => {
  let data = null;            // { reportDate, events: [...] }
  let eventsByDate = null;    // Map<'YYYY-MM-DD', event[]>
  let viewYear = 0;
  let viewMonth = 0;          // 0-11
  let containerId = 'main-table';
  let onEventClick = null;
  let onAuctionClick = null;
  let auctionList = [];       // [{stockCode, cbCode, cbName, openDate, avgWin}]

  // 事件型別設定 (key 對齊 cbas_calendar.py)
  const EVENT_TYPES = [
    { key: 'issue',        label: 'CB發行日',   color: '#2563eb', def: true  },
    { key: 'aso',          label: 'CB拆解日',   color: '#ea7c17', def: true  },
    { key: 'bookbuilding', label: 'CB詢圈期間', color: '#64748b', def: false },
    { key: 'auction',      label: 'CB競拍期間', color: '#38bdf8', def: false },
    { key: 'board',        label: '董事會公告日', color: '#475569', def: false },
    { key: 'collection',   label: '代收價款公告', color: '#a78bfa', def: false },
    { key: 'auctionNotice',label: '轉換價公告',   color: '#eab308', def: false },
    { key: 'maturity',     label: 'CB到期日',   color: '#a855f7', def: false },
    { key: 'putback',      label: 'CB賣回日',   color: '#14b8a6', def: false },
    { key: 'forcedRedeem', label: '強制贖回日', color: '#ef4444', def: false },
    { key: 'resetConv',    label: '重設轉換日', color: '#eab308', def: false }
  ];
  const TYPE_MAP = Object.fromEntries(EVENT_TYPES.map(t => [t.key, t]));
  const enabledTypes = new Set(EVENT_TYPES.filter(t => t.def).map(t => t.key));

  const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

  function setData(cbasCalendar, options = {}) {
    data = cbasCalendar || { events: [] };
    if (options.onEventClick) onEventClick = options.onEventClick;
    if (options.onAuctionClick) onAuctionClick = options.onAuctionClick;
    buildIndex();
    // 預設顯示當月
    const now = new Date();
    viewYear = now.getFullYear();
    viewMonth = now.getMonth();
  }

  function setAuctionList(list) {
    auctionList = Array.isArray(list) ? list : [];
  }

  function hasData() {
    return !!(data && Array.isArray(data.events) && data.events.length > 0);
  }

  /** 把事件 (含區間) 展開成 Map<dateISO, event[]> */
  function buildIndex() {
    eventsByDate = new Map();
    if (!data || !Array.isArray(data.events)) return;
    for (const ev of data.events) {
      if (!ev.date) continue;
      const days = ev.endDate && ev.endDate !== ev.date
        ? expandRange(ev.date, ev.endDate)
        : [ev.date];
      for (const d of days) {
        if (!eventsByDate.has(d)) eventsByDate.set(d, []);
        eventsByDate.get(d).push(ev);
      }
    }
  }

  function expandRange(startISO, endISO) {
    const out = [];
    const start = new Date(startISO + 'T00:00:00');
    const end = new Date(endISO + 'T00:00:00');
    if (isNaN(start) || isNaN(end) || end < start) return [startISO];
    const cur = new Date(start);
    let guard = 0;
    while (cur <= end && guard++ < 90) {
      out.push(isoOf(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }

  function isoOf(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  function shiftMonth(delta) {
    viewMonth += delta;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    else if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    render(containerId);
  }

  function gotoToday() {
    const now = new Date();
    viewYear = now.getFullYear();
    viewMonth = now.getMonth();
    render(containerId);
  }

  function render(cId) {
    containerId = cId || containerId;
    const host = document.getElementById(containerId);
    if (!host) return;

    if (!hasData()) {
      host.innerHTML = '<div class="cal-empty">尚無 CBAS 日曆資料</div>';
      return;
    }

    const todayISO = isoOf(new Date());
    const first = new Date(viewYear, viewMonth, 1);
    const startWeekday = first.getDay();          // 0=Sun
    const gridStart = new Date(viewYear, viewMonth, 1 - startWeekday);

    let html = '<div class="cal-wrap">';

    // 月份導覽
    html += `<div class="cal-nav">
      <button class="cal-nav-btn" onclick="Calendar.prev()">&#x2039;</button>
      <span class="cal-nav-title">${viewYear} 年 ${viewMonth + 1} 月</span>
      <button class="cal-nav-btn" onclick="Calendar.next()">&#x203A;</button>
      <button class="cal-today-btn" onclick="Calendar.today()">今天</button>
    </div>`;

    // 星期表頭
    html += '<div class="cal-grid">';
    for (const w of WEEKDAYS) html += `<div class="cal-weekday">${w}</div>`;

    // 6 週 × 7 天
    for (let i = 0; i < 42; i++) {
      const cur = new Date(gridStart);
      cur.setDate(gridStart.getDate() + i);
      const iso = isoOf(cur);
      const inMonth = cur.getMonth() === viewMonth;
      const isToday = iso === todayISO;
      const cls = 'cal-cell'
        + (inMonth ? '' : ' cal-other')
        + (isToday ? ' cal-today' : '');

      html += `<div class="${cls}">`;
      html += `<div class="cal-daynum">${cur.getDate()}</div>`;

      const evs = (eventsByDate.get(iso) || [])
        .filter(e => enabledTypes.has(e.type));
      for (const ev of evs) {
        const t = TYPE_MAP[ev.type];
        if (!t) continue;
        const isRange = ev.endDate && ev.endDate !== ev.date;
        const tip = `${t.label} | ${ev.cbCode} ${ev.cbName || ''}`
          + (isRange ? ` (${ev.date}~${ev.endDate})` : '');
        html += `<div class="cal-chip" style="background:${t.color}" `
          + `title="${tip}" data-cb="${ev.cbCode}" `
          + `onclick="Calendar.clickEvent('${ev.cbCode}')">`
          + `${ev.cbCode} ${ev.cbName || ''}</div>`;
      }
      html += '</div>';
    }
    html += '</div></div>';

    host.innerHTML = html;
  }

  function renderLegend(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    let html = '<div class="cal-legend"><h3 class="cal-legend-title">事件類型</h3>';
    for (const t of EVENT_TYPES) {
      const checked = enabledTypes.has(t.key) ? 'checked' : '';
      html += `<label class="cal-legend-item">
        <input type="checkbox" ${checked}
               onchange="Calendar.toggleType('${t.key}', this.checked)">
        <span class="cal-legend-dot" style="background:${t.color}"></span>
        <span class="cal-legend-label">${t.label}</span>
      </label>`;
    }
    if (data && data.reportDate) {
      const rd = String(data.reportDate);
      const pretty = rd.length === 8
        ? `${rd.slice(0,4)}/${rd.slice(4,6)}/${rd.slice(6,8)}` : rd;
      html += `<div class="cal-legend-meta">資料日期：${pretty}</div>`;
    }
    html += '</div>';

    // CB 開標統計表 — 列出有 auction PDF 的 CB,點 row 開 auction modal
    if (auctionList.length > 0) {
      html += '<div class="cal-auction-list"><h3 class="cal-legend-title">CB 開標統計表</h3>';
      html += '<table class="cal-auction-table"><thead><tr>'
            + '<th>開標日</th>'
            + '<th>CB名稱</th>'
            + '<th class="text-right">最低</th>'
            + '<th class="text-right">平均</th>'
            + '<th class="text-right">競拍張</th>'
            + '</tr></thead><tbody>';
      const fmtPrice = v => v != null ? Number(v).toFixed(2) : '-';
      const fmtShares = v => v != null ? Number(v).toLocaleString() : '-';
      for (const a of auctionList) {
        html += `<tr class="cal-auction-row" `
              + `onclick="Calendar.clickAuction('${a.stockCode}', '${a.cbCode}')" `
              + `title="${a.cbCode} ${a.cbName || ''}">`
              + `<td>${_fmtOpenDate(a.openDate)}</td>`
              + `<td>${a.cbName || ''}</td>`
              + `<td class="text-right">${fmtPrice(a.minWin)}</td>`
              + `<td class="text-right">${fmtPrice(a.avgWin)}</td>`
              + `<td class="text-right">${fmtShares(a.shares)}</td>`
              + `</tr>`;
      }
      html += '</tbody></table></div>';
    }

    panel.innerHTML = html;
  }

  function _fmtOpenDate(d) {
    if (!d) return '-';
    const s = String(d).trim();
    // 接受 YYYY-MM-DD / YYYY/MM/DD / YYYYMMDD,只回傳 MM/DD (年份省)
    let m, dd;
    if (/^\d{8}$/.test(s)) { m = s.slice(4,6); dd = s.slice(6,8); }
    else {
      const parts = s.split(/[-/]/);
      if (parts.length === 3) { m = parts[1].padStart(2,'0'); dd = parts[2].padStart(2,'0'); }
      else return s;
    }
    return `${m}/${dd}`;
  }

  function toggleType(key, on) {
    if (on) enabledTypes.add(key);
    else enabledTypes.delete(key);
    render(containerId);
  }

  function clickEvent(cbCode) {
    if (typeof onEventClick === 'function') onEventClick(cbCode);
  }

  function clickAuction(stockCode, cbCode) {
    if (typeof onAuctionClick === 'function') onAuctionClick(stockCode, cbCode);
  }

  return {
    setData, setAuctionList, render, renderLegend, hasData,
    prev: () => shiftMonth(-1),
    next: () => shiftMonth(1),
    today: gotoToday,
    toggleType, clickEvent, clickAuction
  };
})();
