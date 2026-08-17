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
        // __public__ → 任一公用清單;__public__:清單名 → 指定公用清單
        if (val === '__public__') return PublicWatchlist.has(stock.code);
        if (val.startsWith('__public__:')) {
          const listName = val.slice('__public__:'.length);
          return PublicWatchlist.has(stock.code, listName);
        }
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

    // 狀態 (VCP / 三線開花)
    hasStatusFlag: {
      label: '有 VCP / 三線',
      type: 'checkbox',
      group: '狀態篩選',
      apply: (stock, val) => {
        if (!val) return true;
        const f = stock.statusFlags;
        return !!(f && (f.vcp || f.sanxian));
      }
    },
    recentStatusFlag: {
      label: '新近 VCP / 三線 ≤ N 日',
      type: 'number',
      placeholder: '天數...',
      group: '狀態篩選',
      apply: (stock, val) => {
        if (!val) return true;
        const n = Number(val);
        if (!(n > 0)) return true;
        const f = stock.statusFlags;
        if (!f) return false;
        const vcp = Number(f.vcp?.streak) || 0;
        const sx  = Number(f.sanxian?.streak) || 0;
        return (vcp >= 1 && vcp <= n) || (sx >= 1 && sx <= n);
      }
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
    cbFirstBarSignal: {
      label: 'CB價格第一根表態',
      type: 'checkbox',
      group: 'CB篩選',
      cbApply: (cb, val) => !val || cb.firstBarSignal === true
    },
    cbPremiumMin: {
      label: 'CB溢價率% >=',
      type: 'number',
      group: 'CB篩選',
      cbApply: (cb, val) => !val || (cb.premiumRate != null && cb.premiumRate >= val)
    },
    cbPremiumMax: {
      label: 'CB溢價率% <=',
      type: 'number',
      group: 'CB篩選',
      cbApply: (cb, val) => !val || (cb.premiumRate != null && cb.premiumRate <= val)
    },
    cbPriceMin: {
      label: 'CB收盤價 >=',
      type: 'number',
      group: 'CB篩選',
      cbApply: (cb, val) => !val || (cb.close != null && cb.close >= val)
    },
    cbPriceMax: {
      label: 'CB收盤價 <=',
      type: 'number',
      group: 'CB篩選',
      cbApply: (cb, val) => !val || (cb.close != null && cb.close <= val)
    },
    // 距離到期日 — 原本是「距到期日」下拉(30天以內/3年以上...),
    // 改成使用者自填天數的上下限,可組出任意區間
    cbMaturityDaysMin: {
      label: '距離到期日(天) >=',
      type: 'number',
      placeholder: '天數...',
      group: 'CB篩選',
      cbApply: (cb, val) => {
        if (!val) return true;
        if (!cb.maturityDate) return false;
        return _daysUntil_(cb.maturityDate) >= Number(val);
      }
    },
    cbMaturityDaysMax: {
      label: '距離到期日(天) <=',
      type: 'number',
      placeholder: '天數...',
      group: 'CB篩選',
      cbApply: (cb, val) => {
        if (!val) return true;
        if (!cb.maturityDate) return false;
        return _daysUntil_(cb.maturityDate) <= Number(val);
      }
    },
    cbHighDaysMin: {
      label: 'CB價格創 N 日新高',
      type: 'number',
      placeholder: '天數...',
      group: 'CB篩選',
      cbApply: (cb, val) => !val || (cb.highDays != null && cb.highDays >= val)
    },
    cbVolumeMin: {
      label: 'CB成交量 >=',
      type: 'number',
      group: 'CB篩選',
      cbApply: (cb, val) => !val || (cb.volume != null && cb.volume >= val)
    },
    cbVolumeRatioMin: {
      label: 'CB量比(今/5日均) >=',
      type: 'number',
      group: 'CB篩選',
      cbApply: (cb, val) => {
        if (!val) return true;
        const v = cb.volume;
        const ohlcv = cb.ohlcv;
        if (v == null || !Array.isArray(ohlcv) || ohlcv.length < 5) return false;
        // 5日均 = 含今日往前 5 個交易日
        const last5 = ohlcv.slice(-5);
        let sum = 0, count = 0;
        for (const row of last5) {
          if (row && row.volume != null) { sum += row.volume; count++; }
        }
        if (count < 5) return false;
        const avg = sum / count;
        if (!(avg > 0)) return false;
        return (v / avg) >= val;
      }
    }
  };


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

  /** 該筆篩選值是否等同「沒填」 */
  function isEmptyVal(val) {
    return val === undefined || val === null || val === '' || val === false;
  }

  /** 個股層級條件 (不含逐檔 CB 條件) 是否全部通過 */
  function passStockLevel(stock, filters) {
    for (const [key, def] of Object.entries(filterDefs)) {
      if (def.isHelper || def.cbApply || !def.apply) continue;
      const val = filters[key];
      if (isEmptyVal(val)) continue;
      if (!def.apply(stock, val, filters)) return false;
    }
    return true;
  }

  /** 單檔 CB 是否通過所有 CB 層級條件 */
  function passCBLevel(cb, stock, filters) {
    for (const [key, def] of Object.entries(filterDefs)) {
      if (def.isHelper || !def.cbApply) continue;
      const val = filters[key];
      if (isEmptyVal(val)) continue;
      if (!def.cbApply(cb, val, stock, filters)) return false;
    }
    return true;
  }

  /** 個股分頁:CB 條件只要該股「任一檔」CB 符合就算通過 */
  function applyFilters(stockMap, filters) {
    const results = [];
    for (const [code, stock] of stockMap) {
      if (!passStockLevel(stock, filters)) continue;
      if (hasCBCondition(filters)) {
        const cbs = stock.cbs || [];
        if (!cbs.some(cb => passCBLevel(cb, stock, filters))) continue;
      }
      results.push(stock);
    }
    return results;
  }

  function hasCBCondition(filters) {
    for (const [key, def] of Object.entries(filterDefs)) {
      if (def.cbApply && !isEmptyVal(filters[key])) return true;
    }
    return false;
  }

  /** 可轉債分頁:回傳逐檔 CB 的篩選結果 (個股條件套在正股上,CB 條件套在該檔 CB 上) */
  function applyCBFilters(stockMap, filters) {
    const rows = [];
    for (const [code, stock] of stockMap) {
      if (!passStockLevel(stock, filters)) continue;
      for (const cb of (stock.cbs || [])) {
        if (!cb || !cb.cbCode) continue;
        if (passCBLevel(cb, stock, filters)) rows.push(cb);
      }
    }
    return rows;
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

  return { filterDefs, applyFilters, applyCBFilters, sortResults };
})();
