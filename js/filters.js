// 篩選條件引擎
const Filters = (() => {
  const filterDefs = {
    keyword: {
      label: '關鍵字搜尋',
      type: 'text',
      placeholder: '代碼或名稱...',
      apply: (stock, val) => {
        if (!val) return true;
        const q = val.toLowerCase();
        return stock.code.includes(q) ||
          (stock.name || '').toLowerCase().includes(q) ||
          (stock.cbs || []).some(cb => cb.cbCode?.includes(q) || cb.cbName?.toLowerCase().includes(q));
      }
    },
    watchlistFilter: {
      label: '追蹤清單',
      type: 'watchlist_select',
      group: '基本',
      apply: (stock, val) => {
        if (!val) return true;
        if (val === '__all__') return Watchlist.isInAnyList(stock.code);
        return Watchlist.isInList(stock.code, val);
      }
    },

    // 個股篩選
    industryKeyword: {
      label: '產業搜尋',
      type: 'text',
      placeholder: '例：電子、食品...',
      group: '個股篩選',
      apply: (stock, val) => {
        if (!val) return true;
        const q = val.toLowerCase();
        if ((stock.industryCategory || '').toLowerCase().includes(q)) return true;
        return (stock.cbs || []).some(cb => (cb.business || '').toLowerCase().includes(q));
      }
    },
    tPatternDays: {
      label: '線型T >= N日',
      type: 'number',
      placeholder: '天數...',
      group: '個股篩選',
      apply: (stock, val) => !val || (stock.tPatternDays != null && stock.tPatternDays >= val)
    },
    firstBarSignal: {
      label: '第一根表態',
      type: 'checkbox',
      group: '個股篩選',
      apply: (stock, val) => !val || stock.firstBarSignal === true
    },

    // 成交量
    volumeMin: {
      label: '成交量 >=',
      type: 'number',
      group: '成交量',
      apply: (stock, val) => !val || (stock.latestVolume != null && stock.latestVolume >= val)
    },
    volumeRatioMin: {
      label: '量比(今/5日均) >=',
      type: 'number',
      group: '成交量',
      apply: (stock, val) => {
        if (!val) return true;
        if (!stock.latestVolume || !stock.avgVolume5) return false;
        return (stock.latestVolume / stock.avgVolume5) >= val;
      }
    },

    // 法人
    foreignAccumDays: {
      label: '法人累計天數',
      type: 'select',
      options: [1, 3, 5, 10, 20, 60, 120, 360],
      default: 1,
      group: '法人篩選',
      isHelper: true
    },
    foreignConsecutiveBuyMin: {
      label: '外資連續買超 >= N日',
      type: 'number',
      group: '法人篩選',
      apply: (stock, val) => {
        if (!val) return true;
        return (stock.foreignConsecutiveBuy || 0) >= val;
      }
    },
    investmentConsecutiveBuyMin: {
      label: '投信連續買超 >= N日',
      type: 'number',
      group: '法人篩選',
      apply: (stock, val) => {
        if (!val) return true;
        return (stock.investmentConsecutiveBuy || 0) >= val;
      }
    },
    bothBuying: {
      label: '外資與投信同買超',
      type: 'checkbox',
      group: '法人篩選',
      apply: (stock, val) => {
        if (!val) return true;
        return (stock.foreignConsecutiveBuy || 0) >= 1 && (stock.investmentConsecutiveBuy || 0) >= 1;
      }
    },

    // 融資融券
    marginBalanceMin: {
      label: '融資餘額(張) >=',
      type: 'number',
      group: '融資融券',
      apply: (stock, val) =>
        !val || (stock.latestMarginBalance != null && stock.latestMarginBalance >= val)
    },
    marginIncreasing: {
      label: '今日融資增加',
      type: 'checkbox',
      group: '融資融券',
      apply: (stock, val) =>
        !val || (stock.latestMarginChange != null && stock.latestMarginChange > 0)
    },
    shortIncreasing: {
      label: '今日融券增加',
      type: 'checkbox',
      group: '融資融券',
      apply: (stock, val) =>
        !val || (stock.latestShortChange != null && stock.latestShortChange > 0)
    },
    shortBalanceMin: {
      label: '融券餘額(張) >=',
      type: 'number',
      group: '融資融券',
      apply: (stock, val) =>
        !val || (stock.latestShortBalance != null && stock.latestShortBalance >= val)
    },

    // CB
    hasCB: {
      label: '僅顯示有CB交易',
      type: 'checkbox',
      group: 'CB篩選',
      apply: (stock, val) => !val || (stock.cbs?.length > 0)
    },
    hasPrimary: {
      label: '僅顯示初級市場案件',
      type: 'checkbox',
      group: 'CB篩選',
      apply: (stock, val) => !val || stock.hasPrimary
    },
    cbPremiumMin: {
      label: 'CB溢價率% >=',
      type: 'number',
      group: 'CB篩選',
      apply: (stock, val) => !val || (stock.cbPremiumRate != null && stock.cbPremiumRate >= val)
    },
    cbPremiumMax: {
      label: 'CB溢價率% <=',
      type: 'number',
      group: 'CB篩選',
      apply: (stock, val) => !val || (stock.cbPremiumRate != null && stock.cbPremiumRate <= val)
    },
    cbPriceMin: {
      label: 'CB收盤價 >=',
      type: 'number',
      group: 'CB篩選',
      apply: (stock, val) => !val || (stock.mainCB?.close != null && stock.mainCB.close >= val)
    },
    cbPriceMax: {
      label: 'CB收盤價 <=',
      type: 'number',
      group: 'CB篩選',
      apply: (stock, val) => !val || (stock.mainCB?.close != null && stock.mainCB.close <= val)
    },
    cbFirstBarSignal: {
      label: 'CB價格第一根表態',
      type: 'checkbox',
      group: 'CB篩選',
      apply: (stock, val) => !val || stock.cbFirstBarSignal === true
    },
    cbHighDaysMin: {
      label: 'CB價格創 N 日新高',
      type: 'number',
      placeholder: '天數...',
      group: 'CB篩選',
      apply: (stock, val) => !val || (stock.cbHighDays != null && stock.cbHighDays >= val)
    },

    // 可轉債條件篩選
    cbConvValueMin: {
      label: '轉換價值',
      type: 'range',
      unitLabel: '元',
      group: 'CB條件',
      field: 'min',
      apply: (stock, val) => {
        if (!val) return true;
        const cv = _convValue_(stock);
        return cv != null && cv >= val;
      }
    },
    cbConvValueMax: {
      label: '轉換價值',
      type: 'range',
      unitLabel: '元',
      group: 'CB條件',
      field: 'max',
      pairWith: 'cbConvValueMin',
      apply: (stock, val) => {
        if (!val) return true;
        const cv = _convValue_(stock);
        return cv != null && cv <= val;
      }
    },
    cbOutstandingPct: {
      label: '已轉換比例',
      type: 'cb_select',
      options: [
        { label: '-- 不限 --', value: '' },
        { label: '10%以下', value: '10' },
        { label: '20%以下', value: '20' },
        { label: '30%以下', value: '30' },
        { label: '50%以下', value: '50' }
      ],
      group: 'CB條件',
      apply: (stock, val) => {
        if (!val) return true;
        const pct = stock.mainCB?.outstandingPct;
        if (pct == null) return false;
        return (100 - pct) <= Number(val);
      }
    },
    cbRecentIssue: {
      label: '近期發行',
      type: 'cb_select',
      options: [
        { label: '-- 不限 --', value: '' },
        { label: '30天以內', value: '30' },
        { label: '60天以內', value: '60' },
        { label: '90天以內', value: '90' },
        { label: '180天以內', value: '180' }
      ],
      group: 'CB條件',
      apply: (stock, val) => {
        if (!val) return true;
        const d = stock.mainCB?.listDate || stock.mainCB?.issueDate;
        if (!d) return false;
        return _daysFromNow_(d) <= Number(val);
      }
    },
    cbMaturityDays: {
      label: '距到期日',
      type: 'cb_select',
      options: [
        { label: '-- 不限 --', value: '' },
        { label: '30天以內', value: '30' },
        { label: '90天以內', value: '90' },
        { label: '180天以內', value: '180' },
        { label: '1年以內', value: '365' },
        { label: '2年以內', value: '730' },
        { label: '3年以上', value: '-1095' }
      ],
      group: 'CB條件',
      apply: (stock, val) => {
        if (!val) return true;
        const d = stock.mainCB?.maturityDate;
        if (!d) return false;
        const days = _daysUntil_(d);
        const n = Number(val);
        if (n < 0) return days >= Math.abs(n);
        return days <= n;
      }
    },
    cbYtpMin: {
      label: '提前賣回收益率',
      type: 'cb_select',
      options: [
        { label: '-- 不限 --', value: '' },
        { label: '大於 0%', value: '0' },
        { label: '大於 1%', value: '1' },
        { label: '大於 3%', value: '3' },
        { label: '大於 5%', value: '5' }
      ],
      group: 'CB條件',
      apply: (stock, val) => {
        if (!val && val !== '0') return true;
        const ytp = stock.mainCB?.ytp;
        if (ytp == null) return false;
        return (ytp * 100) >= Number(val);
      }
    },
    cbYtmMin: {
      label: '到期收益率',
      type: 'cb_select',
      options: [
        { label: '-- 不限 --', value: '' },
        { label: '大於 0%', value: '0' },
        { label: '大於 1%', value: '1' },
        { label: '大於 3%', value: '3' },
        { label: '大於 5%', value: '5' }
      ],
      group: 'CB條件',
      apply: (stock, val) => {
        if (!val && val !== '0') return true;
        const ytm = stock.mainCB?.ytm;
        if (ytm == null) return false;
        return (ytm * 100) >= Number(val);
      }
    },
    cbConvStarted: {
      label: '轉換開始日',
      type: 'cb_select',
      options: [
        { label: '-- 不限 --', value: '' },
        { label: '已可轉換', value: 'started' },
        { label: '尚未可轉換', value: 'not_started' }
      ],
      group: 'CB條件',
      apply: (stock, val) => {
        if (!val) return true;
        const period = stock.mainCB?.conversionPeriod;
        if (!period) return false;
        const start = period.split(/[~～]/)[0]?.trim();
        if (!start) return false;
        const startDate = _parseDate_(start);
        if (!startDate) return false;
        if (val === 'started') return startDate <= new Date();
        return startDate > new Date();
      }
    },
    cbGuarantee: {
      label: '擔保情形',
      type: 'cb_select',
      options: [
        { label: '-- 不限 --', value: '' },
        { label: '有擔保', value: 'yes' },
        { label: '無擔保', value: 'no' }
      ],
      group: 'CB條件',
      apply: (stock, val) => {
        if (!val) return true;
        const g = stock.mainCB?.guarantee;
        if (val === 'yes') return !!g && g !== '無' && g !== '無擔保' && g !== '-';
        return !g || g === '無' || g === '無擔保' || g === '-';
      }
    },
    cbExcludeConvStop: {
      label: '排除暫停轉換',
      type: 'checkbox',
      group: 'CB條件',
      apply: (stock, val) => {
        if (!val) return true;
        return !stock.mainCB?.conversionStop || stock.mainCB.conversionStop.length === 0;
      }
    }
  };

  function _convValue_(stock) {
    if (!stock.conversionPrice || !stock.latestClose) return null;
    return (100 / stock.conversionPrice) * stock.latestClose;
  }

  function _daysFromNow_(dateStr) {
    const d = _parseDate_(dateStr);
    if (!d) return Infinity;
    return Math.abs(Math.floor((new Date() - d) / 86400000));
  }

  function _daysUntil_(dateStr) {
    const d = _parseDate_(dateStr);
    if (!d) return Infinity;
    return Math.floor((d - new Date()) / 86400000);
  }

  function _parseDate_(s) {
    if (!s) return null;
    s = String(s).trim();
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s);
    // YYY/MM/DD (民國)
    const m = s.match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
    if (m) return new Date(Number(m[1]) + 1911, Number(m[2]) - 1, Number(m[3]));
    return new Date(s) || null;
  }

  function applyFilters(stockMap, filters) {
    const results = [];
    for (const [code, stock] of stockMap) {
      let pass = true;
      for (const [key, def] of Object.entries(filterDefs)) {
        if (def.isHelper || !def.apply) continue;
        const val = filters[key];
        if (val === undefined || val === null || val === '' || val === false) continue;
        if (!def.apply(stock, val, filters)) { pass = false; break; }
      }
      if (pass) results.push(stock);
    }
    return results;
  }

  function sortResults(results, sortKey, ascending = true) {
    return results.sort((a, b) => {
      let va = getVal(a, sortKey);
      let vb = getVal(b, sortKey);
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string') return ascending ? va.localeCompare(vb) : vb.localeCompare(va);
      return ascending ? va - vb : vb - va;
    });
  }

  function getVal(obj, key) {
    if (!key) return null;
    return key.split('.').reduce((o, k) => o?.[k], obj) ?? null;
  }

  return { filterDefs, applyFilters, sortResults };
})();
