// 圖表繪製模組
const Charts = (() => {
  let priceChart = null;
  let instChart = null;
  let cbPriceChart = null;
  let cbInstChart = null;
  let marginChart = null;
  let techPriceChart = null;
  let techInstChart = null;
  let techMarginChart = null;
  let cbTechPriceChart = null;
  let cbTechInstChart = null;
  let cbTechExtraChart = null;

  /**
   * 計算移動平均線陣列
   */
  function calcMAArray(data, period) {
    return data.map((val, i) => {
      if (i < period - 1) return null;
      let sum = 0, count = 0;
      for (let j = i - period + 1; j <= i; j++) {
        if (data[j] != null) { sum += data[j]; count++; }
      }
      return count === period ? sum / count : null;
    });
  }

  /**
   * 繪製 K 棒走勢圖 (含上下影線、MA均線、成交量)
   */
  function renderPriceChart(canvasId, stock) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (priceChart) priceChart.destroy();

    const dates = stock.tradingDates || [];
    const recentDates = dates.slice(-APP_CONFIG.defaultRecentDays);
    const labels = recentDates.map(d => formatDateLabel(d));

    const openData = recentDates.map(d => stock.trading['開盤價']?.[d] ?? null);
    const highData = recentDates.map(d => stock.trading['最高價']?.[d] ?? null);
    const lowData = recentDates.map(d => stock.trading['最低價']?.[d] ?? null);
    const closeData = recentDates.map(d => stock.trading['收盤價']?.[d] ?? null);
    const volumeData = recentDates.map(d => {
      const raw = stock.trading['成交股數']?.[d] ?? null;
      return raw != null ? Math.round(raw / 1000) : null;
    });

    // 成交量顏色: 漲紅跌綠
    const volumeColors = recentDates.map((d, i) => {
      const o = openData[i], c = closeData[i];
      if (o == null || c == null) return 'rgba(148,163,184,0.4)';
      return c >= o ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.4)';
    });

    // MA 均線
    const ma5Data = calcMAArray(closeData, 5);
    const ma10Data = calcMAArray(closeData, 10);
    const ma20Data = calcMAArray(closeData, 20);

    // 計算 Y 軸範圍 (含所有價格資料)
    const allPrices = [...highData, ...lowData, ...ma5Data, ...ma10Data, ...ma20Data].filter(v => v != null);
    const priceMin = allPrices.length > 0 ? Math.min(...allPrices) * 0.995 : 0;
    const priceMax = allPrices.length > 0 ? Math.max(...allPrices) * 1.005 : 100;

    // K 棒繪製插件
    const candlestickPlugin = {
      id: 'candlestick',
      afterDatasetsDraw(chart) {
        const ctx = chart.ctx;
        const xScale = chart.scales.x;
        const yPrice = chart.scales.yPrice;
        if (!yPrice) return;

        const barWidth = Math.max(3, Math.min(12, (chart.chartArea.width / recentDates.length) * 0.4));
        ctx.save();

        for (let i = 0; i < recentDates.length; i++) {
          const o = openData[i], h = highData[i], l = lowData[i], c = closeData[i];
          if (o == null || h == null || l == null || c == null) continue;

          const x = xScale.getPixelForValue(i);
          const yOpen = yPrice.getPixelForValue(o);
          const yHigh = yPrice.getPixelForValue(h);
          const yLow = yPrice.getPixelForValue(l);
          const yClose = yPrice.getPixelForValue(c);

          const isUp = c >= o;
          const color = isUp ? APP_CONFIG.colors.up : APP_CONFIG.colors.down;

          // 上下影線
          ctx.beginPath();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.moveTo(x, yHigh);
          ctx.lineTo(x, yLow);
          ctx.stroke();

          // K 棒實體
          const bodyTop = Math.min(yOpen, yClose);
          const bodyHeight = Math.abs(yOpen - yClose) || 1;
          ctx.fillStyle = color;
          ctx.fillRect(x - barWidth, bodyTop, barWidth * 2, bodyHeight);
        }

        ctx.restore();
      }
    };

    priceChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'MA5',  data: ma5Data,  borderColor: '#f59e0b', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'line', label: 'MA10', data: ma10Data, borderColor: '#3b82f6', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'line', label: 'MA20', data: ma20Data, borderColor: '#a855f7', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'bar',  label: '成交量', data: volumeData, backgroundColor: volumeColors, yAxisID: 'yVolume', order: 3, barPercentage: 0.6 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: APP_CONFIG.colors.text, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              afterTitle: (items) => {
                if (!items.length) return '';
                const i = items[0].dataIndex;
                const o = openData[i], h = highData[i], l = lowData[i], c = closeData[i];
                if (o == null) return '';
                return `開:${o.toFixed(2)}  高:${h.toFixed(2)}  低:${l.toFixed(2)}  收:${c.toFixed(2)}`;
              },
              label: (ctx) => {
                if (ctx.dataset.label === '成交量') return `成交量: ${Number(ctx.raw).toLocaleString()} 張`;
                return `${ctx.dataset.label}: ${Number(ctx.raw).toFixed(2)}`;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 },
            grid: { color: 'rgba(71,85,105,0.3)' }
          },
          yPrice: {
            position: 'left',
            min: priceMin,
            max: priceMax,
            ticks: { color: APP_CONFIG.colors.text },
            grid: { color: 'rgba(71,85,105,0.3)' }
          },
          yVolume: {
            position: 'right',
            ticks: { color: APP_CONFIG.colors.textMuted, callback: v => v.toLocaleString() },
            grid: { display: false },
            max: Math.max(...volumeData.filter(v => v !== null)) * 3
          }
        }
      },
      plugins: [candlestickPlugin]
    });
  }

  /**
   * 繪製法人買賣超走勢圖 (固定顏色)
   */
  function renderInstChart(canvasId, stock) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (instChart) instChart.destroy();

    const dates = stock.institutionalDates || [];
    const recentDates = dates.slice(-APP_CONFIG.defaultRecentDays);
    const labels = recentDates.map(d => formatDateLabel(d));

    const toLots = v => v != null ? Math.round(v / 1000) : null;
    const foreignData = recentDates.map(d => toLots(stock.institutional['外資買賣超']?.[d] ?? null));
    const investData = recentDates.map(d => toLots(stock.institutional['投信買賣超']?.[d] ?? null));
    const dealerData = recentDates.map(d => toLots(stock.institutional['自營商買賣超']?.[d] ?? null));

    instChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: '外資',
            data: foreignData,
            backgroundColor: 'rgba(34,197,94,0.7)',
            borderColor: 'rgba(34,197,94,1)',
            borderWidth: 1,
            stack: 'inst'
          },
          {
            label: '投信',
            data: investData,
            backgroundColor: 'rgba(251,146,60,0.7)',
            borderColor: 'rgba(251,146,60,1)',
            borderWidth: 1,
            stack: 'inst'
          },
          {
            label: '自營商',
            data: dealerData,
            backgroundColor: 'rgba(168,85,247,0.7)',
            borderColor: 'rgba(168,85,247,1)',
            borderWidth: 1,
            stack: 'inst'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: APP_CONFIG.colors.text, font: { size: 11 } }
          },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${Number(ctx.raw).toLocaleString()} 張`
            }
          }
        },
        scales: {
          x: {
            ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 },
            grid: { color: 'rgba(71,85,105,0.3)' }
          },
          y: {
            stacked: true,
            ticks: {
              color: APP_CONFIG.colors.text,
              callback: v => v.toLocaleString()
            },
            grid: { color: 'rgba(71,85,105,0.3)' }
          }
        }
      }
    });
  }

  /**
   * 繪製 CB 自身價格 K 線走勢圖
   * @param {string} canvasId
   * @param {object} stock
   * @param {string} [cbCode] 指定 CB 代碼 (多 CB 切換用);未給用 mainCB
   */
  function renderCBPriceChart(canvasId, stock, cbCode) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (cbPriceChart) { cbPriceChart.destroy(); cbPriceChart = null; }

    let ohlcv = null;
    if (cbCode && stock.cbs) {
      const cb = stock.cbs.find(c => c.cbCode === cbCode);
      ohlcv = cb?.ohlcv || null;
    }
    if (!ohlcv) ohlcv = stock.cbOhlcv;
    if (!ohlcv || ohlcv.length === 0) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = APP_CONFIG.colors.textMuted;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('無 CB 交易資料', canvas.width / 2, canvas.height / 2);
      return;
    }

    const recent = ohlcv.slice(-APP_CONFIG.defaultRecentDays);
    const labels = recent.map(r => formatDateLabel(r.date));
    const openData = recent.map(r => r.open);
    const highData = recent.map(r => r.high);
    const lowData = recent.map(r => r.low);
    const closeData = recent.map(r => r.close);
    const volumeData = recent.map(r => r.volume);

    const volumeColors = recent.map(r => r.close >= r.open
      ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.4)');

    const ma5Data = calcMAArray(closeData, 5);
    const ma10Data = calcMAArray(closeData, 10);
    const ma20Data = calcMAArray(closeData, 20);

    const allPrices = [...highData, ...lowData, ...ma5Data, ...ma10Data, ...ma20Data].filter(v => v != null);
    const priceMin = allPrices.length > 0 ? Math.min(...allPrices) * 0.995 : 0;
    const priceMax = allPrices.length > 0 ? Math.max(...allPrices) * 1.005 : 100;

    const candlestickPlugin = {
      id: 'cbCandlestick',
      afterDatasetsDraw(chart) {
        const ctx = chart.ctx;
        const xScale = chart.scales.x;
        const yPrice = chart.scales.yPrice;
        if (!yPrice) return;
        const barWidth = Math.max(3, Math.min(12, (chart.chartArea.width / recent.length) * 0.4));
        ctx.save();
        for (let i = 0; i < recent.length; i++) {
          const o = openData[i], h = highData[i], l = lowData[i], c = closeData[i];
          if (o == null || h == null || l == null || c == null) continue;
          const x = xScale.getPixelForValue(i);
          const yOpen = yPrice.getPixelForValue(o);
          const yHigh = yPrice.getPixelForValue(h);
          const yLow = yPrice.getPixelForValue(l);
          const yClose = yPrice.getPixelForValue(c);
          const isUp = c >= o;
          const color = isUp ? APP_CONFIG.colors.up : APP_CONFIG.colors.down;
          ctx.beginPath();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.moveTo(x, yHigh);
          ctx.lineTo(x, yLow);
          ctx.stroke();
          const bodyTop = Math.min(yOpen, yClose);
          const bodyHeight = Math.abs(yOpen - yClose) || 1;
          ctx.fillStyle = color;
          ctx.fillRect(x - barWidth, bodyTop, barWidth * 2, bodyHeight);
        }
        ctx.restore();
      }
    };

    cbPriceChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'MA5',  data: ma5Data,  borderColor: '#f59e0b', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'line', label: 'MA10', data: ma10Data, borderColor: '#3b82f6', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'line', label: 'MA20', data: ma20Data, borderColor: '#a855f7', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'bar',  label: '成交量', data: volumeData, backgroundColor: volumeColors, yAxisID: 'yVolume', order: 3, barPercentage: 0.6 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: APP_CONFIG.colors.text, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              afterTitle: (items) => {
                if (!items.length) return '';
                const i = items[0].dataIndex;
                const o = openData[i], h = highData[i], l = lowData[i], c = closeData[i];
                if (o == null) return '';
                return `開:${o.toFixed(2)}  高:${h.toFixed(2)}  低:${l.toFixed(2)}  收:${c.toFixed(2)}`;
              },
              label: (ctx) => {
                if (ctx.dataset.label === '成交量') return `成交量: ${Number(ctx.raw).toLocaleString()} 張`;
                return `${ctx.dataset.label}: ${Number(ctx.raw).toFixed(2)}`;
              }
            }
          }
        },
        scales: {
          x: { ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(71,85,105,0.3)' } },
          yPrice: { position: 'left', min: priceMin, max: priceMax, ticks: { color: APP_CONFIG.colors.text }, grid: { color: 'rgba(71,85,105,0.3)' } },
          yVolume: {
            position: 'right',
            ticks: { color: APP_CONFIG.colors.textMuted, callback: v => v.toLocaleString() },
            grid: { display: false },
            max: (Math.max(...volumeData.filter(v => v != null && v > 0)) || 1) * 3
          }
        }
      },
      plugins: [candlestickPlugin]
    });
  }

  /**
   * 繪製 CB 三大法人買賣超走勢圖
   */
  function renderCBInstChart(canvasId, stock) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (cbInstChart) { cbInstChart.destroy(); cbInstChart = null; }

    const dates = stock.cbBondInstitutionalDates || [];
    const inst = stock.cbBondInstitutional;
    if (!inst || dates.length === 0) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = APP_CONFIG.colors.textMuted;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('無 CB 三大法人資料', canvas.width / 2, canvas.height / 2);
      return;
    }

    const recentDates = dates.slice(-APP_CONFIG.defaultRecentDays);
    const labels = recentDates.map(d => formatDateLabel(d));
    const toLots = v => v != null ? Math.round(v / 1000) : null;
    const foreignData = recentDates.map(d => toLots(inst['外資買賣超']?.[d] ?? null));
    const investData = recentDates.map(d => toLots(inst['投信買賣超']?.[d] ?? null));
    const dealerData = recentDates.map(d => toLots(inst['自營商買賣超']?.[d] ?? null));

    cbInstChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: '外資', data: foreignData, backgroundColor: 'rgba(34,197,94,0.7)', borderColor: 'rgba(34,197,94,1)', borderWidth: 1, stack: 'inst' },
          { label: '投信', data: investData, backgroundColor: 'rgba(251,146,60,0.7)', borderColor: 'rgba(251,146,60,1)', borderWidth: 1, stack: 'inst' },
          { label: '自營商', data: dealerData, backgroundColor: 'rgba(168,85,247,0.7)', borderColor: 'rgba(168,85,247,1)', borderWidth: 1, stack: 'inst' }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: APP_CONFIG.colors.text, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${Number(ctx.raw).toLocaleString()} 張`
            }
          }
        },
        scales: {
          x: {
            ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 },
            grid: { color: 'rgba(71,85,105,0.3)' }
          },
          y: {
            stacked: true,
            ticks: { color: APP_CONFIG.colors.text, callback: v => v.toLocaleString() },
            grid: { color: 'rgba(71,85,105,0.3)' }
          }
        }
      }
    });
  }

  /**
   * 繪製融資融券走勢圖
   *   bar: 融資增減 (紅) / 融券增減 (青) — 左軸,signed
   *   line: 融資餘額 (紅虛線) / 融券餘額 (青虛線) — 右軸,趨勢
   */
  function renderMarginChart(canvasId, stock) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (marginChart) { marginChart.destroy(); marginChart = null; }

    const dates = stock.marginDates || [];
    if (!stock.margin || dates.length === 0) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = APP_CONFIG.colors.textMuted;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('無融資融券資料', canvas.width / 2, canvas.height / 2);
      return;
    }

    const recentDates = dates.slice(-APP_CONFIG.defaultRecentDays);
    const labels = recentDates.map(d => formatDateLabel(d));

    const marginChange  = recentDates.map(d => stock.margin['融資增減']?.[d] ?? null);
    const shortChange   = recentDates.map(d => stock.margin['融券增減']?.[d] ?? null);
    const marginBalance = recentDates.map(d => stock.margin['融資餘額']?.[d] ?? null);
    const shortBalance  = recentDates.map(d => stock.margin['融券餘額']?.[d] ?? null);

    marginChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            label: '融資增減',
            data: marginChange,
            backgroundColor: 'rgba(239,68,68,0.7)',
            borderColor: 'rgba(239,68,68,1)',
            borderWidth: 1,
            yAxisID: 'yChange',
            order: 3
          },
          {
            type: 'bar',
            label: '融券增減',
            data: shortChange,
            backgroundColor: 'rgba(34,197,94,0.7)',
            borderColor: 'rgba(34,197,94,1)',
            borderWidth: 1,
            yAxisID: 'yChange',
            order: 3
          },
          {
            type: 'line',
            label: '融資餘額',
            data: marginBalance,
            borderColor: 'rgba(239,68,68,1)',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [4, 3],
            pointRadius: 0,
            pointHoverRadius: 3,
            yAxisID: 'yBalance',
            order: 1,
            tension: 0.1
          },
          {
            type: 'line',
            label: '融券餘額',
            data: shortBalance,
            borderColor: 'rgba(34,197,94,1)',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [4, 3],
            pointRadius: 0,
            pointHoverRadius: 3,
            yAxisID: 'yBalance',
            order: 1,
            tension: 0.1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: APP_CONFIG.colors.text, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.raw;
                if (v == null) return `${ctx.dataset.label}: -`;
                const sign = (ctx.dataset.label.includes('增減') && v > 0) ? '+' : '';
                return `${ctx.dataset.label}: ${sign}${Number(v).toLocaleString()} 張`;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 },
            grid: { color: 'rgba(71,85,105,0.3)' }
          },
          yChange: {
            position: 'left',
            ticks: { color: APP_CONFIG.colors.text, callback: v => v.toLocaleString() },
            grid: { color: 'rgba(71,85,105,0.3)' }
          },
          yBalance: {
            position: 'right',
            ticks: { color: APP_CONFIG.colors.textMuted, callback: v => v.toLocaleString() },
            grid: { display: false }
          }
        }
      }
    });
  }

  function formatDateLabel(dateStr) {
    if (!dateStr || dateStr.length < 8) return dateStr;
    return dateStr.substring(4, 6) + '/' + dateStr.substring(6, 8);
  }

  // ============================================================
  // 技術分析 Modal 專用圖表
  // ============================================================

  /** Modal K 線:用 stock.ohlcv (含「冷門無成交日→沿用前一日 close」fallback) */
  function renderTechPriceChart(canvasId, stock) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (techPriceChart) { techPriceChart.destroy(); techPriceChart = null; }

    const ohlcv = stock.ohlcv || [];
    if (ohlcv.length === 0) {
      _emptyChart_(canvas, '無交易資料');
      return;
    }
    const recent = ohlcv.slice(-APP_CONFIG.techAnalysisDays);
    const recentDates = recent.map(r => r.date);
    const labels = recentDates.map(d => formatDateLabel(d));

    const openData = recent.map(r => r.open);
    const highData = recent.map(r => r.high);
    const lowData = recent.map(r => r.low);
    const closeData = recent.map(r => r.close);
    // ohlcv.volume 已經除過 1000 (張),不需再除
    const volumeData = recent.map(r => r.volume);

    const volumeColors = recent.map(r => {
      if (r.open == null || r.close == null) return 'rgba(148,163,184,0.4)';
      return r.close >= r.open ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.4)';
    });

    const ma5Data = calcMAArray(closeData, 5);
    const ma10Data = calcMAArray(closeData, 10);
    const ma20Data = calcMAArray(closeData, 20);

    const allPrices = [...highData, ...lowData, ...ma5Data, ...ma10Data, ...ma20Data].filter(v => v != null);
    const priceMin = allPrices.length > 0 ? Math.min(...allPrices) * 0.995 : 0;
    const priceMax = allPrices.length > 0 ? Math.max(...allPrices) * 1.005 : 100;

    const candlestickPlugin = {
      id: 'techCandlestick',
      afterDatasetsDraw(chart) {
        const ctx = chart.ctx;
        const xScale = chart.scales.x;
        const yPrice = chart.scales.yPrice;
        if (!yPrice) return;
        const barWidth = Math.max(3, Math.min(12, (chart.chartArea.width / recentDates.length) * 0.4));
        ctx.save();
        for (let i = 0; i < recentDates.length; i++) {
          const o = openData[i], h = highData[i], l = lowData[i], c = closeData[i];
          if (o == null || h == null || l == null || c == null) continue;
          const x = xScale.getPixelForValue(i);
          const yOpen = yPrice.getPixelForValue(o);
          const yHigh = yPrice.getPixelForValue(h);
          const yLow = yPrice.getPixelForValue(l);
          const yClose = yPrice.getPixelForValue(c);
          const isUp = c >= o;
          const color = isUp ? APP_CONFIG.colors.up : APP_CONFIG.colors.down;
          ctx.beginPath();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.moveTo(x, yHigh);
          ctx.lineTo(x, yLow);
          ctx.stroke();
          const bodyTop = Math.min(yOpen, yClose);
          const bodyHeight = Math.abs(yOpen - yClose) || 1;
          ctx.fillStyle = color;
          ctx.fillRect(x - barWidth, bodyTop, barWidth * 2, bodyHeight);
        }
        ctx.restore();
      }
    };

    techPriceChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'MA5',  data: ma5Data,  borderColor: '#f59e0b', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'line', label: 'MA10', data: ma10Data, borderColor: '#3b82f6', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'line', label: 'MA20', data: ma20Data, borderColor: '#a855f7', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'bar',  label: '成交量', data: volumeData, backgroundColor: volumeColors, yAxisID: 'yVolume', order: 3, barPercentage: 0.6 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: APP_CONFIG.colors.text, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              afterTitle: (items) => {
                if (!items.length) return '';
                const i = items[0].dataIndex;
                const o = openData[i], h = highData[i], l = lowData[i], c = closeData[i];
                if (o == null) return '';
                return `開:${o.toFixed(2)}  高:${h.toFixed(2)}  低:${l.toFixed(2)}  收:${c.toFixed(2)}`;
              },
              label: (ctx) => {
                if (ctx.dataset.label === '成交量') return `成交量: ${Number(ctx.raw).toLocaleString()} 張`;
                return `${ctx.dataset.label}: ${Number(ctx.raw).toFixed(2)}`;
              }
            }
          }
        },
        scales: {
          x: { ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(71,85,105,0.3)' } },
          yPrice: { position: 'left', min: priceMin, max: priceMax, ticks: { color: APP_CONFIG.colors.text }, grid: { color: 'rgba(71,85,105,0.3)' } },
          yVolume: {
            position: 'right',
            ticks: { color: APP_CONFIG.colors.textMuted, callback: v => v.toLocaleString() },
            grid: { display: false },
            max: (Math.max(...volumeData.filter(v => v != null && v > 0)) || 1) * 3
          }
        }
      },
      plugins: [candlestickPlugin]
    });
  }

  /**
   * Modal 法人圖:外資 / 投信 / 自營商 (擇一)
   *   bar  = 當日買賣超 (張)
   *   line = 累積買賣超 (張) — 持股趨勢
   * @param {string} which '外資' | '投信' | '自營商'
   * @returns {{latest:number|null, cumulative:number|null}}
   */
  function renderTechInstChart(canvasId, stock, which) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return { latest: null, cumulative: null };
    if (techInstChart) { techInstChart.destroy(); techInstChart = null; }

    const dates = stock.institutionalDates || [];
    if (!stock.institutional || dates.length === 0) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = APP_CONFIG.colors.textMuted;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('無法人買賣超資料', canvas.width / 2, canvas.height / 2);
      return { latest: null, cumulative: null };
    }

    const key = which + '買賣超';
    const recentDates = dates.slice(-APP_CONFIG.techAnalysisDays);
    const labels = recentDates.map(d => formatDateLabel(d));
    const toLots = v => v != null ? Math.round(v / 1000) : null;

    // 累積:從整段歷史 ( 不只 recent ) 算,line 才有合理的位移
    let runningTotal = 0;
    for (let i = 0; i < dates.length - recentDates.length; i++) {
      const v = toLots(stock.institutional[key]?.[dates[i]] ?? null);
      if (v != null) runningTotal += v;
    }
    const recentValues = recentDates.map(d => toLots(stock.institutional[key]?.[d] ?? null));
    const cumulative = [];
    let acc = runningTotal;
    for (const v of recentValues) {
      if (v != null) acc += v;
      cumulative.push(acc);
    }

    const colorMap = {
      '外資':   { bar: 'rgba(34,197,94,0.7)',  line: 'rgba(34,197,94,1)' },
      '投信':   { bar: 'rgba(251,146,60,0.7)', line: 'rgba(251,146,60,1)' },
      '自營商': { bar: 'rgba(168,85,247,0.7)', line: 'rgba(168,85,247,1)' }
    };
    const col = colorMap[which] || colorMap['外資'];

    const barColors = recentValues.map(v => v == null
      ? 'rgba(148,163,184,0.4)'
      : (v >= 0 ? 'rgba(239,68,68,0.7)' : 'rgba(34,197,94,0.7)'));

    techInstChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            label: which + '買賣超(張)',
            data: recentValues,
            backgroundColor: barColors,
            borderWidth: 0,
            yAxisID: 'yBar',
            order: 3
          },
          {
            type: 'line',
            label: '累積持股(張)',
            data: cumulative,
            borderColor: col.line,
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 3,
            yAxisID: 'yLine',
            order: 1,
            tension: 0.15
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: APP_CONFIG.colors.text, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.raw;
                if (v == null) return `${ctx.dataset.label}: -`;
                const sign = ctx.dataset.label.includes('買賣超') && v > 0 ? '+' : '';
                return `${ctx.dataset.label}: ${sign}${Number(v).toLocaleString()} 張`;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 },
            grid: { color: 'rgba(71,85,105,0.3)' }
          },
          yBar: {
            position: 'left',
            ticks: { color: APP_CONFIG.colors.text, callback: v => v.toLocaleString() },
            grid: { color: 'rgba(71,85,105,0.3)' }
          },
          yLine: {
            position: 'right',
            ticks: { color: APP_CONFIG.colors.textMuted, callback: v => v.toLocaleString() },
            grid: { display: false }
          }
        }
      }
    });

    const latest = recentValues.length ? recentValues[recentValues.length - 1] : null;
    const cumLatest = cumulative.length ? cumulative[cumulative.length - 1] : null;
    return { latest, cumulative: cumLatest };
  }

  /**
   * Modal 融資/融券圖
   *   bar  = 融資增減 / 融券增減 (張)
   *   line = 融資餘額 / 融券餘額 (張)
   * @param {string} which '融資' | '融券'
   * @returns {{latestChange:number|null, latestBalance:number|null}}
   */
  function renderTechMarginChart(canvasId, stock, which) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return { latestChange: null, latestBalance: null };
    if (techMarginChart) { techMarginChart.destroy(); techMarginChart = null; }

    const dates = stock.marginDates || [];
    if (!stock.margin || dates.length === 0) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = APP_CONFIG.colors.textMuted;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('無融資融券資料', canvas.width / 2, canvas.height / 2);
      return { latestChange: null, latestBalance: null };
    }

    const changeKey = which + '增減';
    const balanceKey = which + '餘額';
    const recentDates = dates.slice(-APP_CONFIG.techAnalysisDays);
    const labels = recentDates.map(d => formatDateLabel(d));
    const changeData  = recentDates.map(d => stock.margin[changeKey]?.[d] ?? null);
    const balanceData = recentDates.map(d => stock.margin[balanceKey]?.[d] ?? null);

    const lineColor = which === '融資' ? 'rgba(239,68,68,1)' : 'rgba(34,197,94,1)';
    const barColors = changeData.map(v => v == null
      ? 'rgba(148,163,184,0.4)'
      : (v >= 0 ? 'rgba(239,68,68,0.7)' : 'rgba(34,197,94,0.7)'));

    techMarginChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            label: changeKey + '(張)',
            data: changeData,
            backgroundColor: barColors,
            borderWidth: 0,
            yAxisID: 'yBar',
            order: 3
          },
          {
            type: 'line',
            label: balanceKey + '(張)',
            data: balanceData,
            borderColor: lineColor,
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 3,
            yAxisID: 'yLine',
            order: 1,
            tension: 0.15
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: APP_CONFIG.colors.text, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.raw;
                if (v == null) return `${ctx.dataset.label}: -`;
                const sign = ctx.dataset.label.includes('增減') && v > 0 ? '+' : '';
                return `${ctx.dataset.label}: ${sign}${Number(v).toLocaleString()} 張`;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 },
            grid: { color: 'rgba(71,85,105,0.3)' }
          },
          yBar: {
            position: 'left',
            ticks: { color: APP_CONFIG.colors.text, callback: v => v.toLocaleString() },
            grid: { color: 'rgba(71,85,105,0.3)' }
          },
          yLine: {
            position: 'right',
            ticks: { color: APP_CONFIG.colors.textMuted, callback: v => v.toLocaleString() },
            grid: { display: false }
          }
        }
      }
    });

    const latestChange = changeData.length ? changeData[changeData.length - 1] : null;
    const latestBalance = balanceData.length ? balanceData[balanceData.length - 1] : null;
    return { latestChange, latestBalance };
  }

  function destroyTech() {
    if (techPriceChart)  { techPriceChart.destroy();  techPriceChart = null; }
    if (techInstChart)   { techInstChart.destroy();   techInstChart = null; }
    if (techMarginChart) { techMarginChart.destroy(); techMarginChart = null; }
  }

  // ============================================================
  // CB 技術分析 Modal 圖表
  // ============================================================

  function _emptyChart_(canvas, msg) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = APP_CONFIG.colors.textMuted;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
  }

  /** CB K 線圖 (Modal 內 — 60 日)
   *  @param {string[]} [sharedDates] 三張圖共用的日期軸 (YYYYMMDD);
   *         有給就以此為準,沒給的日期 → null (留空)
   */
  function renderCBTechPriceChart(canvasId, stock, cbCode, sharedDates) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return { latest: null, dates: [] };
    if (cbTechPriceChart) { cbTechPriceChart.destroy(); cbTechPriceChart = null; }

    let ohlcv = null;
    if (cbCode && stock.cbs) {
      const cb = stock.cbs.find(c => c.cbCode === cbCode);
      ohlcv = cb?.ohlcv || null;
    }
    if (!ohlcv) ohlcv = stock.cbOhlcv;
    if (!ohlcv || ohlcv.length === 0) {
      _emptyChart_(canvas, '無 CB 交易資料');
      return { latest: null, dates: [] };
    }

    // 用 sharedDates 為軸 (若無則自取 ohlcv 最後 N 天)
    const ohlcvMap = new Map(ohlcv.map(r => [r.date, r]));
    const axisDates = sharedDates && sharedDates.length
      ? sharedDates
      : ohlcv.slice(-APP_CONFIG.techAnalysisDays).map(r => r.date);
    const recent = axisDates.map(d => ohlcvMap.get(d) || { date: d, open: null, high: null, low: null, close: null, volume: null });
    const labels = axisDates.map(formatDateLabel);
    const openData = recent.map(r => r.open);
    const highData = recent.map(r => r.high);
    const lowData = recent.map(r => r.low);
    const closeData = recent.map(r => r.close);
    const volumeData = recent.map(r => r.volume);

    const volumeColors = recent.map(r => r.close >= r.open
      ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.4)');

    const ma5 = calcMAArray(closeData, 5);
    const ma10 = calcMAArray(closeData, 10);
    const ma20 = calcMAArray(closeData, 20);

    const allPrices = [...highData, ...lowData, ...ma5, ...ma10, ...ma20].filter(v => v != null);
    const priceMin = allPrices.length ? Math.min(...allPrices) * 0.995 : 0;
    const priceMax = allPrices.length ? Math.max(...allPrices) * 1.005 : 100;

    const candlestick = {
      id: 'cbTechCandlestick',
      afterDatasetsDraw(chart) {
        const ctx = chart.ctx, xScale = chart.scales.x, yPrice = chart.scales.yPrice;
        if (!yPrice) return;
        const barW = Math.max(3, Math.min(12, (chart.chartArea.width / recent.length) * 0.4));
        ctx.save();
        for (let i = 0; i < recent.length; i++) {
          const o = openData[i], h = highData[i], l = lowData[i], c = closeData[i];
          if (o == null) continue;
          const x = xScale.getPixelForValue(i);
          const yO = yPrice.getPixelForValue(o), yH = yPrice.getPixelForValue(h);
          const yL = yPrice.getPixelForValue(l), yC = yPrice.getPixelForValue(c);
          const color = c >= o ? APP_CONFIG.colors.up : APP_CONFIG.colors.down;
          ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1;
          ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
          const top = Math.min(yO, yC), hgt = Math.abs(yO - yC) || 1;
          ctx.fillStyle = color;
          ctx.fillRect(x - barW, top, barW * 2, hgt);
        }
        ctx.restore();
      }
    };

    cbTechPriceChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'MA5',  data: ma5,  borderColor: '#f59e0b', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'line', label: 'MA10', data: ma10, borderColor: '#3b82f6', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'line', label: 'MA20', data: ma20, borderColor: '#a855f7', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'bar',  label: '成交量', data: volumeData, backgroundColor: volumeColors, yAxisID: 'yVolume', order: 3, barPercentage: 0.6 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: APP_CONFIG.colors.text, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              afterTitle: (items) => {
                if (!items.length) return '';
                const i = items[0].dataIndex;
                const o = openData[i], h = highData[i], l = lowData[i], c = closeData[i];
                if (o == null) return '';
                return `開:${o.toFixed(2)}  高:${h.toFixed(2)}  低:${l.toFixed(2)}  收:${c.toFixed(2)}`;
              },
              label: (ctx) => ctx.dataset.label === '成交量'
                ? `成交量: ${Number(ctx.raw).toLocaleString()} 張`
                : `${ctx.dataset.label}: ${Number(ctx.raw).toFixed(2)}`
            }
          }
        },
        scales: {
          x: { ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(71,85,105,0.3)' } },
          yPrice: { position: 'left', min: priceMin, max: priceMax, ticks: { color: APP_CONFIG.colors.text }, grid: { color: 'rgba(71,85,105,0.3)' } },
          yVolume: { position: 'right',
            ticks: { color: APP_CONFIG.colors.textMuted, callback: v => v.toLocaleString() },
            grid: { display: false },
            max: (Math.max(...volumeData.filter(v => v != null && v > 0)) || 1) * 3
          }
        }
      },
      plugins: [candlestick]
    });

    const lastWithData = [...recent].reverse().find(r => r.close != null);
    return {
      latest: lastWithData ? { close: lastWithData.close, volume: lastWithData.volume } : null,
      dates: axisDates
    };
  }

  /** CB 三大法人 toggle 圖 (Modal 內) */
  function renderCBTechInstChart(canvasId, stock, cbCode, which, sharedDates) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return { latest: null, cumulative: null };
    if (cbTechInstChart) { cbTechInstChart.destroy(); cbTechInstChart = null; }

    let inst = null, dates = [];
    if (cbCode && stock.cbs) {
      const cb = stock.cbs.find(c => c.cbCode === cbCode);
      if (cb?.bondInstData) { inst = cb.bondInstData; dates = cb.bondInstDates || []; }
    }
    if (!inst) { inst = stock.cbBondInstitutional; dates = stock.cbBondInstitutionalDates || []; }
    if (!inst || dates.length === 0) {
      _emptyChart_(canvas, '無 CB 法人資料');
      return { latest: null, cumulative: null };
    }

    const key = which + '買賣超';
    const recentDates = sharedDates && sharedDates.length
      ? sharedDates
      : dates.slice(-APP_CONFIG.techAnalysisDays);
    const labels = recentDates.map(d => formatDateLabel(d));
    // CB 法人資料源單位已是「張」,不需要 /1000 (stock-level 才需要)
    const toLots = v => v != null ? Math.round(v) : null;

    // 累積:從整段歷史開頭算起,直到 recentDates 的第一天前
    const earliestRecent = recentDates[0];
    let running = 0;
    for (const d of dates) {
      if (earliestRecent && d >= earliestRecent) break;
      const v = toLots(inst[key]?.[d] ?? null);
      if (v != null) running += v;
    }
    const recentValues = recentDates.map(d => toLots(inst[key]?.[d] ?? null));
    const cumulative = [];
    let acc = running;
    for (const v of recentValues) {
      if (v != null) acc += v;
      cumulative.push(acc);
    }

    const lineColorMap = {
      '外資':   'rgba(34,197,94,1)',
      '投信':   'rgba(251,146,60,1)',
      '自營商': 'rgba(168,85,247,1)'
    };
    const lineColor = lineColorMap[which] || 'rgba(34,197,94,1)';
    const barColors = recentValues.map(v => v == null
      ? 'rgba(148,163,184,0.4)'
      : (v >= 0 ? 'rgba(239,68,68,0.7)' : 'rgba(34,197,94,0.7)'));

    cbTechInstChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { type: 'bar', label: which + '買賣超(張)', data: recentValues, backgroundColor: barColors, borderWidth: 0, yAxisID: 'yBar', order: 3 },
          { type: 'line', label: '累積持股(張)', data: cumulative, borderColor: lineColor, backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, yAxisID: 'yLine', order: 1, tension: 0.15 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: APP_CONFIG.colors.text, font: { size: 11 } } },
          tooltip: { callbacks: { label: (ctx) => {
            const v = ctx.raw;
            if (v == null) return `${ctx.dataset.label}: -`;
            const sign = ctx.dataset.label.includes('買賣超') && v > 0 ? '+' : '';
            return `${ctx.dataset.label}: ${sign}${Number(v).toLocaleString()} 張`;
          }}}
        },
        scales: {
          x: { ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(71,85,105,0.3)' } },
          yBar: { position: 'left', ticks: { color: APP_CONFIG.colors.text, callback: v => v.toLocaleString() }, grid: { color: 'rgba(71,85,105,0.3)' } },
          yLine: { position: 'right', ticks: { color: APP_CONFIG.colors.textMuted, callback: v => v.toLocaleString() }, grid: { display: false } }
        }
      }
    });

    const latest = recentValues.length ? recentValues[recentValues.length - 1] : null;
    const cumLatest = cumulative.length ? cumulative[cumulative.length - 1] : null;
    return { latest, cumulative: cumLatest };
  }

  /**
   * CB 溢價率 / 流通餘額 切換圖 (Modal 內)
   *   premium: 用 cb.ohlcv + stock.trading + cb.conversionPrice 算每日溢價率%
   *   balance: 只有本週/上週 2 個點,畫成 bar 對照
   * @param {string} which 'premium' | 'balance'
   */
  function renderCBTechExtraChart(canvasId, stock, cbCode, which, sharedDates) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return { latest: null };
    if (cbTechExtraChart) { cbTechExtraChart.destroy(); cbTechExtraChart = null; }

    const cb = (stock.cbs || []).find(c => c.cbCode === cbCode);
    if (!cb) { _emptyChart_(canvas, '無 CB 資料'); return { latest: null }; }

    if (which === 'premium') {
      const ohlcv = cb.ohlcv || [];
      const convPrice = cb.conversionPrice;
      if (!ohlcv.length || !convPrice) {
        _emptyChart_(canvas, '無法計算溢價率 (缺 CB 收盤或轉換價)');
        return { latest: null };
      }
      const ohlcvMap = new Map(ohlcv.map(r => [r.date, r]));
      const axisDates = sharedDates && sharedDates.length
        ? sharedDates
        : ohlcv.slice(-APP_CONFIG.techAnalysisDays).map(r => r.date);
      const labels = axisDates.map(formatDateLabel);
      const premiums = axisDates.map(d => {
        const r = ohlcvMap.get(d);
        const stockClose = stock.trading['收盤價']?.[d];
        if (!r || r.close == null || stockClose == null) return null;
        const convValue = (100 / convPrice) * stockClose;
        if (!(convValue > 0)) return null;
        return ((r.close - convValue) / convValue) * 100;
      });

      // 算 Y 軸範圍,左右軸都用同樣 min/max → X 軸寬度與其他兩張圖對齊
      const validPrems = premiums.filter(v => v != null);
      let pMin = 0, pMax = 10;
      if (validPrems.length) {
        pMin = Math.min(...validPrems);
        pMax = Math.max(...validPrems);
        const span = Math.max(pMax - pMin, 1);
        pMin -= span * 0.1;
        pMax += span * 0.1;
      }

      cbTechExtraChart = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'CB溢價率(%)',
            data: premiums,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59,130,246,0.15)',
            borderWidth: 1.8,
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0.15,
            fill: true,
            spanGaps: false   /* 假日 / 缺資料 → 線段斷開,不連到下一個點 */
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: APP_CONFIG.colors.text, font: { size: 11 } } },
            tooltip: { callbacks: { label: (ctx) => {
              const v = ctx.raw;
              return v == null ? '-' : `溢價率: ${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
            }}}
          },
          scales: {
            x: { ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(71,85,105,0.3)' } },
            y: {
              position: 'left', min: pMin, max: pMax,
              ticks: { color: APP_CONFIG.colors.text, callback: v => v.toFixed(1) + '%' },
              grid: { color: 'rgba(71,85,105,0.3)' }
            },
            yRight: {
              position: 'right', min: pMin, max: pMax,
              ticks: { color: APP_CONFIG.colors.textMuted, callback: v => v.toFixed(1) + '%' },
              grid: { display: false }
            }
          }
        }
      });

      const lastPrem = premiums.filter(v => v != null).slice(-1)[0] ?? null;
      return { latest: lastPrem };
    } else { // balance
      // 資料源只有 本週/上週 2 個週報快照。
      // 為了「每日一根 bar」,用 cb.ohlcv 的日期軸,
      // 最近 5 個交易日 = balThisWeek,更早 = balLastWeek,
      // 再用「複製前一天」(forward-fill) 補滿空缺。
      const thisWeek = cb.balThisWeek;
      const lastWeek = cb.balLastWeek;
      const change = cb.balChange;
      if (thisWeek == null && lastWeek == null) {
        _emptyChart_(canvas, '無流通餘額資料');
        return { latest: null };
      }
      const ohlcv = cb.ohlcv || [];
      const axisDates = sharedDates && sharedDates.length
        ? sharedDates
        : ohlcv.slice(-APP_CONFIG.techAnalysisDays).map(r => r.date);
      if (axisDates.length === 0) {
        _emptyChart_(canvas, '無 CB 交易日期可對齊');
        return { latest: { thisWeek, lastWeek, change } };
      }
      const labels = axisDates.map(formatDateLabel);
      const n = axisDates.length;
      const thisWeekStart = Math.max(0, n - 5);
      const data = axisDates.map((_, i) =>
        i >= thisWeekStart ? (thisWeek ?? lastWeek) : (lastWeek ?? thisWeek)
      );
      // Forward-fill (從左到右,空缺用前一天)
      let lastVal = null;
      for (let i = 0; i < data.length; i++) {
        if (data[i] == null) data[i] = lastVal;
        else lastVal = data[i];
      }
      const barColors = data.map((_, i) =>
        i >= thisWeekStart ? 'rgba(59,130,246,0.8)' : 'rgba(148,163,184,0.6)'
      );

      // Y 軸固定 0 ~ 發行張數 (= cb.actualTotal 百萬 × 10) → 視覺上能看出餘額佔發行的比例
      // actualTotal 缺值時退回 data 最大值 * 1.1
      const issueLots = (cb.actualTotal != null && cb.actualTotal > 0)
        ? cb.actualTotal * 10
        : null;
      const validBals = data.filter(v => v != null);
      const dataMax = validBals.length ? Math.max(...validBals) : 0;
      const bMin = 0;
      const bMax = issueLots != null
        ? Math.max(issueLots, dataMax)
        : (dataMax > 0 ? dataMax * 1.1 : 1000);

      cbTechExtraChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: '流通餘額(張)',
            data,
            backgroundColor: barColors,
            borderWidth: 0,
            barPercentage: 0.7
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: APP_CONFIG.colors.text, font: { size: 11 } } },
            tooltip: { callbacks: {
              label: (ctx) => {
                const v = ctx.raw;
                if (v == null) return '流通餘額: -';
                const tag = ctx.dataIndex >= thisWeekStart ? '本週' : '上週';
                return `流通餘額(${tag}): ${Number(v).toLocaleString()} 張`;
              }
            }}
          },
          scales: {
            x: {
              ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 },
              grid: { color: 'rgba(71,85,105,0.3)' }
            },
            y: {
              position: 'left', min: bMin, max: bMax,
              ticks: { color: APP_CONFIG.colors.text, callback: v => v.toLocaleString() },
              grid: { color: 'rgba(71,85,105,0.3)' }
            },
            yRight: {
              position: 'right', min: bMin, max: bMax,
              ticks: { color: APP_CONFIG.colors.textMuted, callback: v => v.toLocaleString() },
              grid: { display: false }
            }
          }
        }
      });
      return { latest: { thisWeek, lastWeek, change } };
    }
  }

  function destroyCBTech() {
    if (cbTechPriceChart) { cbTechPriceChart.destroy(); cbTechPriceChart = null; }
    if (cbTechInstChart)  { cbTechInstChart.destroy();  cbTechInstChart  = null; }
    if (cbTechExtraChart) { cbTechExtraChart.destroy(); cbTechExtraChart = null; }
  }

  function destroy() {
    if (priceChart) { priceChart.destroy(); priceChart = null; }
    if (instChart) { instChart.destroy(); instChart = null; }
    if (cbPriceChart) { cbPriceChart.destroy(); cbPriceChart = null; }
    if (cbInstChart) { cbInstChart.destroy(); cbInstChart = null; }
    if (marginChart) { marginChart.destroy(); marginChart = null; }
    destroyTech();
    destroyCBTech();
  }

  return {
    renderPriceChart, renderInstChart, renderCBPriceChart, renderCBInstChart, renderMarginChart,
    renderTechPriceChart, renderTechInstChart, renderTechMarginChart, destroyTech,
    renderCBTechPriceChart, renderCBTechInstChart, renderCBTechExtraChart, destroyCBTech,
    destroy
  };
})();
