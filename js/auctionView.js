/* CB 開標統計表 Modal — 兩頁式視圖
 *
 *   第 1 頁「開標全覽」   : 開標摘要 KPI + 得標價位分布圖 + 關鍵足跡表 + 法人足跡
 *   第 2 頁「發行事件軸」 : 現股 K 線 (標轉換價 / 競拍期間 / 事件點) + 完整事件總覽
 *
 * 兩頁共用同一個 modal 視窗,上方 tab 切換。資料由 App.showAuctionModal 組好後
 * 用 open(payload) 丟進來,本模組不直接碰全域資料。
 *
 * payload:
 *   cbCode, cbName, auction   (twsa.json 的一列, 內含 pdf.info/priceRows/totalStats/legalStats)
 *   stock                     (對應現股, 需要 .ohlcv;可為 null → 第 2 頁只出事件表)
 *   convPrice                 (轉換價, 可 null → 不算溢價率/不畫轉換價線)
 *   events                    (cbasCalendar 中屬於這檔 CB 的事件, 可空陣列)
 */
const AuctionView = (() => {
  let cur = null;          // 目前這檔的 payload + 衍生統計
  let page = 'summary';    // 'summary' | 'timeline'
  let chart = null;        // 第 2 頁的 Chart.js 實例
  let kZoom = 1;           // K 線視窗縮放倍率 (滑鼠滾輪,1 = 依事件自動算出的範圍)
  let kWheelPending = null;

  // 事件型別 → 顯示名稱 (對齊 calendar.js 的 EVENT_TYPES)
  const EVENT_LABEL = {
    issue: 'CB 上市櫃日', aso: 'CB 拆解日', bookbuilding: '詢圈期間',
    auction: '競拍期間', board: '董事會公告', maturity: 'CB 到期日',
    putback: 'CB 賣回日', forcedRedeem: '強制贖回日', resetConv: '重設轉換日',
    collection: '代收價款公告', auctionNotice: '競拍公告(轉換價公告)'
  };
  const EVENT_COLOR = {
    issue: '#2563eb', aso: '#ea7c17', bookbuilding: '#64748b',
    auction: '#38bdf8', board: '#94a3b8', maturity: '#a855f7',
    putback: '#14b8a6', forcedRedeem: '#ef4444', resetConv: '#eab308',
    result: '#f59e0b', collection: '#a78bfa', auctionNotice: '#eab308'
  };

  /* ---------- 小工具 ---------- */

  function num(v) {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/[,，%\s]/g, ''));
    return isFinite(n) ? n : null;
  }
  function fmtInt(v) { return v == null ? '-' : Math.round(v).toLocaleString(); }
  function fmtNum(v, d = 2) { return v == null ? '-' : v.toFixed(d); }
  function fmtPct(v, d = 1) { return v == null ? '-' : (v >= 0 ? '+' : '') + v.toFixed(d) + '%'; }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  /** "2026/08/14" 或 "2026-08-14" → "YYYYMMDD" */
  function toYmd(s) {
    const m = String(s || '').match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    return m ? m[1] + m[2].padStart(2, '0') + m[3].padStart(2, '0') : null;
  }
  /** "YYYYMMDD" → "MM/DD" */
  function mmdd(ymd) {
    return ymd && ymd.length === 8 ? ymd.slice(4, 6) + '/' + ymd.slice(6, 8) : '-';
  }
  function ymdSlash(ymd) {
    return ymd && ymd.length === 8
      ? ymd.slice(0, 4) + '/' + ymd.slice(4, 6) + '/' + ymd.slice(6, 8) : '-';
  }

  /** 主辦承銷商 — PDF 裡是簡稱 (「群益金鼎」),表格欄位是全名,優先用簡稱 */
  function uw(p) {
    return p.auction?.pdf?.info?.underwriter || p.auction?.['主辦承銷商'] || '';
  }

  /* ---------- 統計推導 ---------- */

  /** 把 priceRows 與兩張統計表整理成畫面要用的數字。
   *  totalStats / legalStats 是 2026-08 才補進 scraper 的欄位,舊資料可能沒有
   *  → 一律容忍 null,對應區塊自己降級顯示。 */
  function derive(p) {
    const pdf = p.auction?.pdf || {};
    const info = pdf.info || {};
    const rows = (pdf.priceRows || [])
      .map(r => ({ price: num(r[1]), lots: num(r[2]), amt: num(r[3]) }))
      .filter(r => r.price != null && r.lots != null && r.lots > 0);

    const sumLots = rows.reduce((a, r) => a + r.lots, 0);
    const sumAmt = rows.reduce((a, r) => a + (r.amt || 0), 0);   // 仟元

    const ts = pdf.totalStats || [];
    const ls = pdf.legalStats || [];
    const bidLots = num(ts[1]);            // 合格投標數量 (張)
    const winLots = num(ts[3]) ?? (sumLots || null);
    const winAmt = num(ts[4]) ?? (sumAmt || null);
    const auctionLots = num(p.auction?.['競拍股數']);
    const avg = num(info.avgWin);

    // 轉換價值 / 溢價率 — 用開標日(取不到就最後一筆)的現股收盤價
    let convValue = null, premium = null, refClose = null, refCloseDate = null;
    const ohlcv = p.stock?.ohlcv || [];
    if (ohlcv.length) {
      const openYmd = toYmd(info.openDate);
      let bar = null;
      if (openYmd) {
        for (const b of ohlcv) { if (String(b.date) <= openYmd) bar = b; else break; }
      }
      bar = bar || ohlcv[ohlcv.length - 1];
      if (bar && bar.close != null) { refClose = bar.close; refCloseDate = String(bar.date); }
    }
    if (refClose != null && p.convPrice) {
      convValue = 100 * refClose / p.convPrice;
      if (avg != null && convValue > 0) premium = (avg / convValue - 1) * 100;
    }

    return {
      info, rows, sumLots, sumAmt,
      bidCount: num(ts[0]), bidLots, winCount: num(ts[2]), winLots, winAmt,
      auctionLots, avg,
      cover: (bidLots && auctionLots) ? bidLots / auctionLots : null,
      legal: ls.length >= 6 ? {
        bidCount: num(ls[0]), bidLots: num(ls[1]), bidRatio: num(ls[2]),
        winCount: num(ls[3]), winLots: num(ls[4]), winRatio: num(ls[5])
      } : null,
      convValue, premium, refClose, refCloseDate
    };
  }

  /** 成交量加權分位數 — 用來把單筆零星的超高價踢出 X 軸範圍 */
  function weightedQuantile(rows, q) {
    if (!rows.length) return null;
    const sorted = [...rows].sort((a, b) => a.price - b.price);
    const total = sorted.reduce((a, r) => a + r.lots, 0);
    let acc = 0;
    for (const r of sorted) {
      acc += r.lots;
      if (acc >= total * q) return r.price;
    }
    return sorted[sorted.length - 1].price;
  }

  /** 最窄的連續價帶,涵蓋 ≥ ratio 的得標張數 (雙指標掃描) */
  function mainBand(rows, ratio) {
    if (!rows.length) return null;
    const sorted = [...rows].sort((a, b) => a.price - b.price);
    const total = sorted.reduce((a, r) => a + r.lots, 0);
    const need = total * ratio;
    let best = null, lo = 0, acc = 0;
    for (let hi = 0; hi < sorted.length; hi++) {
      acc += sorted[hi].lots;
      while (acc - sorted[lo].lots >= need) { acc -= sorted[lo].lots; lo++; }
      if (acc >= need) {
        const w = sorted[hi].price - sorted[lo].price;
        if (!best || w < best.width) {
          best = { lo: sorted[lo].price, hi: sorted[hi].price, width: w, lots: acc, share: acc / total };
        }
      }
    }
    return best;
  }

  /* ---------- 第 1 頁:開標全覽 ---------- */

  function kpi(label, value, sub, cls) {
    return `<div class="auc-kpi">
      <div class="auc-kpi-label">${esc(label)}</div>
      <div class="auc-kpi-value ${cls || ''}">${value}</div>
      ${sub ? `<div class="auc-kpi-sub">${sub}</div>` : ''}
    </div>`;
  }

  /** 得標價位分布 — 手繪 SVG 棒棒糖圖 (線越高、點越大 = 該價位張數越多) */
  function distChart(d) {
    const rows = d.rows;
    if (rows.length < 2) return '';

    // X 軸上界取成交量加權 P99,單筆極端高價不擠壓主要價帶
    const pMin = Math.min(...rows.map(r => r.price));
    const pCut = weightedQuantile(rows, 0.99);
    const pMaxAll = Math.max(...rows.map(r => r.price));
    const pMax = Math.max(pCut, d.avg ?? pCut);
    const outliers = rows.filter(r => r.price > pMax);
    const shown = rows.filter(r => r.price <= pMax);
    const span = (pMax - pMin) || 1;

    const W = 1000, H = 260, padL = 24, padR = 24, padT = 42, padB = 34;
    const iw = W - padL - padR, ih = H - padT - padB;
    const x = v => padL + (v - pMin) / span * iw;
    const maxLots = Math.max(...shown.map(r => r.lots));
    const h = v => Math.max(4, Math.sqrt(v / maxLots) * ih * 0.88);
    const rad = v => Math.max(2.2, Math.sqrt(v / maxLots) * 11);

    const band = mainBand(rows, 0.30);
    let svg = '';

    // 主要成交量價帶底色 — 高度只到價帶內最高的那根,整條拉到頂會變成一塊擋住圖的灰盒
    if (band) {
      const bx = x(Math.max(band.lo, pMin)), bw = Math.max(6, x(Math.min(band.hi, pMax)) - bx);
      const inBand = shown.filter(r => r.price >= band.lo && r.price <= band.hi);
      const bh = (inBand.length ? Math.max(...inBand.map(r => h(r.lots))) : ih) + 16;
      svg += `<rect x="${bx - 4}" y="${(padT + ih - bh).toFixed(1)}" width="${bw + 8}" height="${bh.toFixed(1)}"
        fill="rgba(245,158,11,0.09)" stroke="rgba(245,158,11,0.3)" stroke-width="1"
        stroke-dasharray="4 3" rx="3"/>`;
    }
    // 基準線
    svg += `<line x1="${padL}" y1="${padT + ih}" x2="${W - padR}" y2="${padT + ih}"
      stroke="#334155" stroke-width="1"/>`;

    // 棒棒糖 (小的先畫,大的疊在上面)
    const order = [...shown].sort((a, b) => a.lots - b.lots);
    for (const r of order) {
      const above = d.avg != null && r.price > d.avg;
      const col = above ? '#ef4444' : '#22c55e';
      const px = x(r.price), py = padT + ih - h(r.lots);
      svg += `<line x1="${px.toFixed(1)}" y1="${(padT + ih).toFixed(1)}" x2="${px.toFixed(1)}" y2="${py.toFixed(1)}"
        stroke="${col}" stroke-width="1.6" opacity="0.85"/>`;
      svg += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${rad(r.lots).toFixed(1)}"
        fill="${col}" opacity="0.95"><title>${fmtNum(r.price)} 元 · ${fmtInt(r.lots)} 張</title></circle>`;
    }

    // 均價線
    if (d.avg != null && d.avg >= pMin && d.avg <= pMax) {
      const ax = x(d.avg);
      svg += `<line x1="${ax.toFixed(1)}" y1="${padT - 14}" x2="${ax.toFixed(1)}" y2="${padT + ih}"
        stroke="#f59e0b" stroke-width="1.6"/>`;
      svg += `<text x="${ax.toFixed(1)}" y="${padT - 20}" fill="#f59e0b" font-size="15"
        text-anchor="middle" font-weight="600">均價 ${fmtNum(d.avg)}</text>`;
    }

    // 標註張數最大的 3 個價位
    const top3 = [...shown].sort((a, b) => b.lots - a.lots).slice(0, 3);
    for (const r of top3) {
      const above = d.avg != null && r.price > d.avg;
      const col = above ? '#ef4444' : '#22c55e';
      const px = x(r.price), py = padT + ih - h(r.lots) - rad(r.lots) - 8;
      const tw = 58, ty = Math.max(padT - 2, py - 14);
      svg += `<rect x="${(px - tw / 2).toFixed(1)}" y="${ty.toFixed(1)}" width="${tw}" height="19" rx="4"
        fill="#0f172a" stroke="${col}" stroke-width="1"/>`;
      svg += `<text x="${px.toFixed(1)}" y="${(ty + 13.5).toFixed(1)}" fill="${col}" font-size="13"
        text-anchor="middle">${fmtNum(r.price)}</text>`;
    }

    // X 軸兩端刻度
    svg += `<text x="${padL}" y="${H - 10}" fill="#94a3b8" font-size="13">${fmtNum(pMin)}</text>`;
    svg += `<text x="${W - padR}" y="${H - 10}" fill="#94a3b8" font-size="13" text-anchor="end">${fmtNum(pMax)}</text>`;

    const top3Share = d.sumLots
      ? [...rows].sort((a, b) => b.lots - a.lots).slice(0, 3).reduce((a, r) => a + r.lots, 0) / d.sumLots * 100
      : null;

    return `<div class="auc-card auc-dist">
      <div class="auc-card-head">
        <span class="auc-card-title">得標價位分布</span>
        <span class="auc-legend">
          <i class="dot" style="--c:#22c55e"></i>均價以下
          <i class="dot" style="--c:#ef4444"></i>均價以上
          <i class="swatch"></i>主要成交量價帶
        </span>
      </div>
      <div class="auc-dist-hint">線越高、點越大 = 該價位張數越多</div>
      <div class="auc-dist-scroll">
        <svg class="auc-dist-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${svg}</svg>
      </div>
      ${outliers.length ? `<div class="auc-dist-note">最高價 ${fmtNum(pMaxAll)} 為極端值,未納入比例</div>` : ''}
      <div class="auc-dist-foot">
        ${band ? `主要成交量價帶 <b>${fmtNum(band.lo)}–${fmtNum(band.hi)}</b>(至少 30% 得標張數)` : ''}
        ${band && top3Share != null ? '<span class="sep">|</span>' : ''}
        ${top3Share != null ? `前 3 價位占 <b>${top3Share.toFixed(1)}%</b>` : ''}
      </div>
    </div>`;
  }

  /** 關鍵足跡 — 取張數最大的 10 個價位,再依價格由高至低列出 */
  function footprintTable(d) {
    if (!d.rows.length) return '';
    const top = [...d.rows].sort((a, b) => b.lots - a.lots).slice(0, 10)
      .sort((a, b) => b.price - a.price);
    const maxLots = Math.max(...top.map(r => r.lots));
    let html = `<div class="auc-card auc-foot">
      <div class="auc-card-head">
        <span class="auc-card-title">關鍵足跡</span>
        <span class="auc-card-note">依價格由高至低</span>
      </div>
      <table class="auc-table">
        <thead><tr><th></th><th>價位</th><th>溢價率</th><th>得標張數</th><th>成交金額</th><th>占總量</th></tr></thead>
        <tbody>`;
    for (const r of top) {
      const prem = d.convValue ? (r.price / d.convValue - 1) * 100 : null;
      const share = d.sumLots ? r.lots / d.sumLots * 100 : null;
      const isMax = r.lots === maxLots;
      const above = d.avg != null && r.price > d.avg;
      html += `<tr class="${isMax ? 'is-max' : ''}">
        <td class="auc-dotcell"><i class="dot" style="--c:${isMax ? '#f59e0b' : (above ? '#ef4444' : '#22c55e')}"></i></td>
        <td class="auc-mono">${fmtNum(r.price)}</td>
        <td class="auc-mono ${prem == null ? '' : (prem >= 0 ? 'text-up' : 'text-down')}">${prem == null ? '-' : fmtPct(prem)}</td>
        <td class="auc-mono">${fmtInt(r.lots)} 張</td>
        <td class="auc-mono">${r.amt != null ? (r.amt / 100000).toFixed(2) + '億' : '-'}</td>
        <td class="auc-mono auc-share">${share == null ? '-' : share.toFixed(1) + '%'}</td>
      </tr>`;
    }
    return html + '</tbody></table></div>';
  }

  /** 法人足跡 — 甜甜圈 (法人合格投標比率) + 投標/得標兩條比例棒 */
  function legalPanel(d) {
    if (!d.legal) {
      return `<div class="auc-card auc-legal">
        <div class="auc-card-head"><span class="auc-card-title">法人足跡</span></div>
        <div class="auc-empty">此筆開標統計表未取得法人投標/得標資料<br>(2026-08 之後重抓的檔案才有)</div>
      </div>`;
    }
    const L = d.legal;
    const bidRatio = L.bidRatio ?? (L.bidLots && d.bidLots ? L.bidLots / d.bidLots * 100 : null);
    const winRatio = L.winRatio ?? (L.winLots && d.winLots ? L.winLots / d.winLots * 100 : null);
    const R = 46, C = 2 * Math.PI * R;
    const frac = Math.max(0, Math.min(100, bidRatio ?? 0)) / 100;

    return `<div class="auc-card auc-legal">
      <div class="auc-card-head">
        <span class="auc-card-title">法人足跡</span>
        <span class="auc-card-note">投標意願與最後得標分開看</span>
      </div>
      <div class="auc-donut-wrap">
        <svg viewBox="0 0 120 120" class="auc-donut">
          <circle cx="60" cy="60" r="${R}" fill="none" stroke="#334155" stroke-width="13"/>
          <circle cx="60" cy="60" r="${R}" fill="none" stroke="#f59e0b" stroke-width="13"
            stroke-dasharray="${(C * frac).toFixed(1)} ${C.toFixed(1)}"
            stroke-linecap="round" transform="rotate(-90 60 60)"/>
          <text x="60" y="58" text-anchor="middle" fill="#e2e8f0" font-size="20" font-weight="700">
            ${bidRatio == null ? '-' : bidRatio.toFixed(1) + '%'}</text>
          <text x="60" y="76" text-anchor="middle" fill="#94a3b8" font-size="11">法人合格投標</text>
        </svg>
      </div>
      <div class="auc-bar-block">
        <div class="auc-bar-label">合格投標</div>
        <div class="auc-bar-nums">${fmtInt(L.bidLots)} <span>/</span> ${fmtInt(d.bidLots)}</div>
        <div class="auc-bar"><span style="width:${Math.min(100, bidRatio ?? 0)}%;background:#f59e0b"></span></div>
        <div class="auc-bar-pct" style="color:#f59e0b">${bidRatio == null ? '-' : bidRatio.toFixed(1) + '%'}</div>
      </div>
      <div class="auc-bar-block">
        <div class="auc-bar-label">法人得標</div>
        <div class="auc-bar-nums">${fmtInt(L.winLots)} <span>/</span> ${fmtInt(d.winLots)}</div>
        <div class="auc-bar"><span style="width:${Math.min(100, winRatio ?? 0)}%;background:#ef4444"></span></div>
        <div class="auc-bar-pct" style="color:#ef4444">${winRatio == null ? '-' : winRatio.toFixed(1) + '%'}</div>
      </div>
    </div>`;
  }

  function renderSummary() {
    const p = cur, d = cur.derived, info = d.info;
    const a = p.auction || {};
    const issueEv = (p.events || []).find(e => e.type === 'issue');
    const asoEv = (p.events || []).find(e => e.type === 'aso');

    const meta = [
      a['發行性質'] || info.secType,
      p.tcri ? `TCRI ${p.tcri}` : null,
      issueEv ? `上市櫃日 ${issueEv.date.replace(/-/g, '/')}` : null,
      asoEv ? `拆解日 ${asoEv.date.replace(/-/g, '/')}` : null
    ].filter(Boolean).join(' · ');

    const avgSub = [
      d.premium != null ? `溢價率 <b class="${d.premium >= 0 ? 'text-up' : 'text-down'}">${fmtPct(d.premium)}</b>` : null,
      d.convValue != null ? `轉換價值 ${fmtNum(d.convValue)}` : null
    ].filter(Boolean).join(' <span class="sep">|</span> ');

    let html = `<div class="auc-head">
      <div class="auc-head-main">
        <span class="auc-head-code">${esc(p.cbCode)}</span>
        <span class="auc-head-name">${esc(p.cbName || info.stockName || '')}</span>
        <span class="auc-head-tag">競拍結果</span>
        ${uw(p) ? `<span class="auc-head-uw">${esc(uw(p))}主辦</span>` : ''}
      </div>
      ${meta ? `<div class="auc-head-meta">${esc(meta)}</div>` : ''}
    </div>

    <div class="auc-card">
      <div class="auc-card-head">
        <span class="auc-card-title">開標摘要</span>
        <span class="auc-card-note">${a['投標期間'] ? '投標期間 ' + esc(a['投標期間']) : ''}</span>
      </div>
      <div class="auc-kpi-grid">
        ${kpi('競拍張數', fmtInt(d.auctionLots) + ' <small>張</small>')}
        ${kpi('合格投標', (d.bidLots == null ? '-' : fmtInt(d.bidLots) + ' <small>張</small>'),
              d.bidCount != null ? `${fmtInt(d.bidCount)} 筆` : '')}
        ${kpi('需求倍數', d.cover == null ? '-' : d.cover.toFixed(2) + ' <small>倍</small>', '', 'is-hot')}
        ${kpi('得標張數', fmtInt(d.winLots) + ' <small>張</small>',
              d.winCount != null ? `${fmtInt(d.winCount)} 筆` : '')}
        ${kpi('加權均價', fmtNum(d.avg), avgSub, 'is-accent')}
        ${kpi('得標總金額', d.winAmt == null ? '-' : (d.winAmt / 100000).toFixed(1) + ' <small>億</small>', '', 'is-gold')}
      </div>
      <div class="auc-subline">
        最低得標 ${info.minWin || '-'} <span class="sep">|</span>
        最高得標 ${info.maxWin || '-'} <span class="sep">|</span>
        公開承銷 ${info.pubOffer || '-'} <span class="sep">|</span>
        最低承銷 ${a['最低承銷價格'] || info.minOffer || '-'} <span class="sep">|</span>
        競拍方式 ${info.auctionType || '-'}
      </div>
    </div>`;

    html += distChart(d);
    html += `<div class="auc-two-col">${footprintTable(d)}${legalPanel(d)}</div>`;
    html += `<div class="auc-footnote">
      <span>開標日 ${info.openDate || '-'}</span>
      <span>價位為開標表彙總,不代表同一投標人</span>
    </div>`;
    return html;
  }

  /* ---------- 第 2 頁:發行事件軸 ---------- */

  /** CB 從董事會到拆解的固定七段流程 — 不論有沒有資料都照這個順序排,
   *  抓不到日期的那段留空位顯示「待補」,讓缺口看得出來而不是悄悄消失。
   *
   *  2 代收價款公告 / 3 競拍公告(轉換價公告) 三個初級市場來源 (CBAS 日曆、元大、
   *  富邦初級卡) 都沒有欄位,改由 MOPS 重大訊息公告抽出 (scripts/mops_news.py →
   *  parse_and_export Phase 4.75 併進 cbasCalendar.events),所以這裡跟其他段
   *  一樣直接讀 events。抓不到就仍然留白顯示「尚無資料來源」。 */
  const TIMELINE_SLOTS = [
    { key: 'board', label: '董事會公告', color: '#94a3b8' },
    { key: 'collection', label: '代收價款公告', color: '#a78bfa' },
    { key: 'auctionNotice', label: '競拍公告(轉換價公告)', color: '#eab308' },
    { key: 'auction', label: '競拍期間', color: '#38bdf8' },
    { key: 'result', label: '競拍結果公告', color: '#f59e0b' },
    { key: 'issue', label: 'CB 上市櫃日', color: '#2563eb' },
    { key: 'aso', label: 'CB 拆解日', color: '#ea7c17' }
  ];
  // 七段以外的事件 (賣回/到期/強贖/重設/詢圈) 接在後面,依日期排
  const EXTRA_TYPES = ['bookbuilding', 'resetConv', 'putback', 'maturity', 'forcedRedeem'];

  function buildTimeline() {
    const p = cur, info = cur.derived.info;
    const evOf = (type) => (p.events || []).find(e => e.type === type);

    const fill = {
      board: () => {
        const e = evOf('board');
        return e ? { ymd: toYmd(e.date) } : null;
      },
      // MOPS 重大訊息:「…代收價款行庫及存儲專戶行庫」
      collection: () => {
        const e = evOf('collection');
        return e ? { ymd: toYmd(e.date), note: 'MOPS 公告' } : null;
      },
      // MOPS 重大訊息:「…之轉換價格及溢價率」
      auctionNotice: () => {
        const e = evOf('auctionNotice');
        return e ? { ymd: toYmd(e.date), note: 'MOPS 公告' } : null;
      },
      auction: () => {
        const e = evOf('auction');
        if (e) {
          const s = toYmd(e.date), t = toYmd(e.endDate);
          return { ymd: s, endYmd: t, note: t ? `${mmdd(s)}–${mmdd(t)}` : '' };
        }
        // 日曆沒有就用 twsa 的「投標期間」
        const period = p.auction?.['投標期間'];
        if (!period) return null;
        const parts = String(period).split('~');
        const s = toYmd(parts[0]), t = toYmd(parts[parts.length - 1]);
        return s ? { ymd: s, endYmd: t, note: t ? `${mmdd(s)}–${mmdd(t)}` : '' } : null;
      },
      result: () => {
        const ymd = toYmd(info.openDate);
        if (!ymd) return null;
        const note = [
          info.avgWin ? `均價 ${info.avgWin}` : null,
          cur.derived.winLots != null ? `${fmtInt(cur.derived.winLots)} 張` : null,
          p.convPrice ? `轉換價 ${p.convPrice}` : null
        ].filter(Boolean).join('｜');
        return { ymd, note };
      },
      issue: () => {
        const e = evOf('issue');
        return e ? { ymd: toYmd(e.date) } : null;
      },
      aso: () => {
        const e = evOf('aso');
        if (!e) return null;
        // source==='derived' 是 pipeline 用上市櫃日推的 (第 6 個交易日),
        // 不是公告值 → 標出來,免得跟 CBAS 給的真實日期混在一起看。
        return { ymd: toYmd(e.date), note: e.source === 'derived' ? '推估 (上市櫃日起第 6 個交易日)' : '' };
      }
    };

    const out = [];
    for (const slot of TIMELINE_SLOTS) {
      const got = fill[slot.key]();
      out.push({
        type: slot.key, label: slot.label, color: slot.color,
        ymd: got?.ymd || null, endYmd: got?.endYmd || null, note: got?.note || ''
      });
    }

    // 七段以外的既有事件 (多半是掛牌後的賣回/到期)
    const extras = (p.events || [])
      .filter(e => EXTRA_TYPES.includes(e.type) && toYmd(e.date))
      .map(e => ({
        type: e.type, label: EVENT_LABEL[e.type] || e.type,
        color: EVENT_COLOR[e.type] || '#94a3b8',
        ymd: toYmd(e.date), endYmd: toYmd(e.endDate), note: ''
      }))
      .sort((a, b) => a.ymd.localeCompare(b.ymd));
    out.push(...extras);

    // 只有拿到日期的才給編號 (K 線上的圓點也用這個號)
    let n = 0;
    for (const e of out) e.no = e.ymd ? ++n : null;
    return out;
  }

  /** 給 K 線用:只取有日期的事件,依日期排 */
  function datedEvents() {
    return cur.timeline.filter(e => e.ymd).sort((a, b) => a.ymd.localeCompare(b.ymd));
  }

  function renderTimeline() {
    const p = cur;
    const tl = cur.timeline;
    const a = p.auction || {};

    let html = `<div class="auc-head">
      <div class="auc-head-main">
        <span class="auc-head-code">${esc(p.cbCode)}</span>
        <span class="auc-head-name">${esc(p.cbName || '')}</span>
        <span class="auc-head-tag is-blue">發行事件軸</span>
      </div>
      <div class="auc-head-meta">${esc([uw(p) ? uw(p) + '主辦' : null, a['發行性質']].filter(Boolean).join(' · '))}</div>
    </div>`;

    if (p.stock?.ohlcv?.length) {
      html += `<div class="auc-card auc-kchart">
        <div class="auc-card-head">
          <span class="auc-card-title">現股走勢 ${esc(p.stock.code || '')} ${esc(p.stock.name || '')}</span>
          <span class="auc-k-days" id="auction-k-days" title="滑鼠滾輪可調整時間範圍">–</span>
          <span class="auc-card-note">K 棒上圓點對應下方事件編號 · 滾輪縮放</span>
        </div>
        <div class="auc-k-wrap"><canvas id="auction-k-chart"></canvas></div>
      </div>`;
    } else {
      html += `<div class="auc-card"><div class="auc-empty">查無對應現股的日 K 資料</div></div>`;
    }

    const missing = tl.filter(e => !e.ymd).length;
    html += `<div class="auc-card">
      <div class="auc-card-head"><span class="auc-card-title">完整事件總覽</span>
      <span class="auc-card-note">依 CB 發行流程排序,事件日以公告上架日為準</span></div>
      <div class="auc-tl-grid">`;
    for (const e of tl) {
      if (!e.ymd) {
        html += `<div class="auc-tl-item is-empty">
          <span class="auc-tl-no is-empty">–</span>
          <div>
            <div class="auc-tl-label">${esc(e.label)}</div>
            <div class="auc-tl-date">尚無資料來源</div>
          </div>
        </div>`;
        continue;
      }
      html += `<div class="auc-tl-item">
        <span class="auc-tl-no" style="background:${e.color}">${e.no}</span>
        <div>
          <div class="auc-tl-label" style="color:${e.color}">${esc(e.label)}</div>
          <div class="auc-tl-date">${ymdSlash(e.ymd)}${e.note ? ' <span class="sep">|</span> ' + esc(e.note) : ''}</div>
        </div>
      </div>`;
    }
    html += '</div>';
    if (missing) {
      html += `<div class="auc-tl-foot">灰色項目為該來源 (CBAS 日曆 / 元大 / 富邦 / MOPS 重大訊息) 尚無對應公告,補到資料後會自動帶入</div>`;
    }
    html += '</div>';
    return html;
  }

  /** K 線區的滑鼠滾輪縮放 — 跟個股技術分析同樣的手感:
   *  往上滾 = 縮短時間 (zoom in)、往下滾 = 拉長時間 (看更早歷史)。
   *  只攔 K 線容器上的滾輪,面板其他地方照常捲動。
   *  容器每次 paint 都會重畫,所以用 dataset 旗標避免重複綁。 */
  function bindKWheel(baseSpan, total) {
    const wrap = document.querySelector('.auc-k-wrap');
    if (!wrap || wrap.dataset.wheelBound === '1') return;
    wrap.dataset.wheelBound = '1';
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const next = kZoom * (e.deltaY > 0 ? 1.15 : 1 / 1.15);
      // 下限 20 根、上限吃滿整段歷史,換算成倍率再夾住
      const lo = 20 / baseSpan, hi = Math.max(1, total / baseSpan);
      const clamped = Math.max(lo, Math.min(hi, next));
      if (Math.abs(clamped - kZoom) < 1e-6) return;
      kZoom = clamped;
      if (kWheelPending) cancelAnimationFrame(kWheelPending);
      kWheelPending = requestAnimationFrame(() => {
        kWheelPending = null;
        renderKChart();
      });
    }, { passive: false });
  }

  /** 現股日 K + 轉換價線 + 競拍期間色塊 + 事件編號圓點 */
  function renderKChart() {
    const canvas = document.getElementById('auction-k-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (chart) { chart.destroy(); chart = null; }

    const all = cur.stock.ohlcv;
    const tl = datedEvents();
    if (!all.length) return;
    // 視窗:第一個事件前 20 根 ~ 最後一個事件後 15 根 (不足就往回補到 60 根)
    const firstYmd = tl.length ? tl[0].ymd : null;
    let si = firstYmd ? all.findIndex(b => String(b.date) >= firstYmd) : -1;
    si = si < 0 ? Math.max(0, all.length - 60) : Math.max(0, si - 20);
    // 結束點只看「已經發生」的事件 — 賣回日/到期日動輒 3~5 年後,
    // 拿它當右界會把發行期間壓成左邊一小撮。
    const lastBar = String(all[all.length - 1].date);
    const past = tl.filter(e => e.ymd <= lastBar);
    const lastYmd = past.length ? past[past.length - 1].ymd : null;
    let ei = lastYmd ? all.findIndex(b => String(b.date) > lastYmd) : -1;
    ei = ei < 0 ? all.length : Math.min(all.length, ei + 25);
    // 事件都擠在近期時視窗會太短、K 棒被拉得很胖 → 至少湊到 50 根
    if (ei - si < 50) si = Math.max(0, ei - 50);
    // 滾輪縮放:以上面算出來的「事件視窗」當基準倍率 1,往左邊擴/縮;
    // 左邊到頂了還要放大就往右邊吃 (賣回/到期日那個方向)。
    const baseSpan = Math.max(ei - si, 20);
    const span = Math.max(20, Math.min(all.length, Math.round(baseSpan * kZoom)));
    si = Math.max(0, ei - span);
    if (ei - si < span) ei = Math.min(all.length, si + span);
    const bars = all.slice(si, Math.max(ei, si + 20));
    if (!bars.length) return;
    const daysBadge = document.getElementById('auction-k-days');
    if (daysBadge) daysBadge.textContent = `${bars.length} 根`;
    bindKWheel(baseSpan, all.length);

    const dates = bars.map(b => String(b.date));
    const labels = dates.map(d => d.slice(4, 6) + '/' + d.slice(6, 8));
    const O = bars.map(b => b.open), Hh = bars.map(b => b.high),
      L = bars.map(b => b.low), C = bars.map(b => b.close);

    const prices = [...Hh, ...L].filter(v => v != null);
    if (cur.convPrice) prices.push(cur.convPrice);
    const pad = (Math.max(...prices) - Math.min(...prices)) * 0.08 || 1;
    const yMin = Math.min(...prices) - pad, yMax = Math.max(...prices) + pad;

    // 事件 → 落在哪一根 K 棒 (取當天或之後第一根有交易的)。
    // 早於視窗左界的事件要整個丟掉 — findIndex 會回 0,不擋的話董事會公告
    // 那種半年前的事件會被畫在第一根 K 棒上,縮放後看起來像發生在窗內。
    const marks = [];
    for (const e of tl) {
      if (e.ymd < dates[0]) continue;
      const i = dates.findIndex(d => d >= e.ymd);
      if (i < 0) continue;
      marks.push({ i, no: e.no, color: e.color, price: C[i] ?? O[i] });
    }
    const auctionEv = tl.find(e => e.type === 'auction');
    // 競拍色塊整段都在視窗左邊就不畫;只有起點在左邊界外則貼齊左緣 (from=0)
    const bandEnd = auctionEv ? (auctionEv.endYmd || auctionEv.ymd) : null;
    const bandRange = (auctionEv && bandEnd >= dates[0]) ? {
      from: Math.max(0, dates.findIndex(d => d >= auctionEv.ymd)),
      to: auctionEv.endYmd ? dates.findIndex(d => d >= auctionEv.endYmd) : -1
    } : null;

    const plugin = {
      id: 'auctionK',
      beforeDatasetsDraw(ch) {
        const { ctx, chartArea, scales } = ch;
        if (!bandRange || bandRange.from < 0) return;
        const to = bandRange.to >= 0 ? bandRange.to : bandRange.from;
        const x1 = scales.x.getPixelForValue(bandRange.from);
        const x2 = scales.x.getPixelForValue(to);
        ctx.save();
        ctx.fillStyle = 'rgba(245,158,11,0.12)';
        ctx.fillRect(x1 - 3, chartArea.top, Math.max(6, x2 - x1 + 6), chartArea.bottom - chartArea.top);
        ctx.strokeStyle = 'rgba(245,158,11,0.55)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x1 - 3, chartArea.top, Math.max(6, x2 - x1 + 6), chartArea.bottom - chartArea.top);
        ctx.restore();
      },
      afterDatasetsDraw(ch) {
        const { ctx, chartArea, scales } = ch;
        const y = scales.y;
        const bw = Math.max(2, Math.min(11, (chartArea.width / bars.length) * 0.4));
        ctx.save();
        // K 棒
        for (let i = 0; i < bars.length; i++) {
          if (O[i] == null || C[i] == null || Hh[i] == null || L[i] == null) continue;
          const col = C[i] >= O[i] ? '#ef4444' : '#22c55e';
          const px = scales.x.getPixelForValue(i);
          ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px, y.getPixelForValue(Hh[i]));
          ctx.lineTo(px, y.getPixelForValue(L[i]));
          ctx.stroke();
          const yo = y.getPixelForValue(O[i]), yc = y.getPixelForValue(C[i]);
          ctx.fillRect(px - bw, Math.min(yo, yc), bw * 2, Math.abs(yo - yc) || 1);
        }
        // 轉換價
        if (cur.convPrice) {
          const yv = y.getPixelForValue(cur.convPrice);
          ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1.3; ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(chartArea.left, yv); ctx.lineTo(chartArea.right, yv);
          ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = '#f59e0b'; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
          ctx.fillText('轉換價 ' + cur.convPrice, chartArea.right - 4, yv - 4);
        }
        // 事件編號
        for (const m of marks) {
          if (m.price == null) continue;
          const px = scales.x.getPixelForValue(m.i);
          const py = y.getPixelForValue(m.price) - 16;
          ctx.beginPath();
          ctx.arc(px, py, 8, 0, Math.PI * 2);
          ctx.fillStyle = m.color || '#94a3b8';
          ctx.fill();
          ctx.fillStyle = '#0f172a'; ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(m.no), px, py + 0.5);
        }
        ctx.restore();
      }
    };

    chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '收盤', data: C, borderColor: 'rgba(0,0,0,0)',
          pointRadius: 0, borderWidth: 0
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { color: 'rgba(51,65,85,0.4)' }, ticks: { color: '#94a3b8', maxTicksLimit: 10, font: { size: 10 } } },
          y: {
            min: yMin, max: yMax, position: 'right',
            grid: { color: 'rgba(51,65,85,0.4)' },
            ticks: { color: '#94a3b8', font: { size: 10 } }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) => {
                const i = c.dataIndex;
                return `開 ${fmtNum(O[i])}  高 ${fmtNum(Hh[i])}  低 ${fmtNum(L[i])}  收 ${fmtNum(C[i])}`;
              }
            }
          }
        }
      },
      plugins: [plugin]
    });
  }

  /* ---------- 對外 ---------- */

  /** opts.keepPage:左右鍵切換下一檔時沿用目前分頁 —— 在事件軸一檔一檔翻的時候
   *  被彈回「開標全覽」很煩。一般開啟 (從卡片點進來) 仍然從第 1 頁開始。 */
  function open(payload, opts = {}) {
    cur = payload;
    cur.derived = derive(payload);
    cur.timeline = buildTimeline();
    if (!opts.keepPage) page = 'summary';
    kZoom = 1;                 // 換一檔就回到依事件自動算的範圍
    document.getElementById('auction-modal-title').textContent =
      `${payload.cbCode} ${payload.cbName || ''} 開標統計表`;
    document.getElementById('auction-modal').classList.add('show');
    paint();
  }

  function paint() {
    for (const t of ['summary', 'timeline']) {
      document.getElementById('auc-tab-' + t)?.classList.toggle('active', page === t);
    }
    const body = document.getElementById('auction-modal-body');
    body.scrollTop = 0;
    if (page === 'summary') {
      if (chart) { chart.destroy(); chart = null; }
      body.innerHTML = renderSummary();
    } else {
      body.innerHTML = renderTimeline();
      requestAnimationFrame(renderKChart);
    }
  }

  function switchPage(p) {
    if (!cur || p === page) return;
    page = p;
    paint();
  }

  function close(event) {
    if (event && event.target && event.target.id !== 'auction-modal') return;
    if (chart) { chart.destroy(); chart = null; }
    document.getElementById('auction-modal').classList.remove('show');
  }

  return { open, switchPage, close };
})();
