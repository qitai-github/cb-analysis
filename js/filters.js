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
    watchlistOnly: {
      label: '僅顯示追蹤標的',
      type: 'checkbox',
      group: '基本',
      apply: (stock, val) => !val || Watchlist.has(stock.code)
    },

    // 股價篩選
    tPatternDays: {
      label: '線型T >= N日',
      type: 'number',
      placeholder: '天數...',
      group: '股價篩選',
      apply: (stock, val) => !val || (stock.tPatternDays != null && stock.tPatternDays >= val)
    },
    firstBarSignal: {
      label: '第一根表態',
      type: 'checkbox',
      group: '股價篩選',
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
    }
  };

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
