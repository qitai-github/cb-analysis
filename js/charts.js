// 圖表繪製模組
const Charts = (() => {
  let priceChart = null;
  let instChart = null;
  let cbPriceChart = null;
  let cbInstChart = null;
  let marginChart = null;
  let techPriceChart = null;
  let cbTechPriceChart = null;

  // 技術分析 modal sub-charts 統一用 Map 管理 (key = canvasId)
  // 6 個:tech-foreign-chart / tech-invest-chart / tech-dealer-chart
  //      tech-bias-chart   / tech-margin-chart / tech-short-chart
  const techSubCharts = new Map();
  // 取乾淨 canvas:銷毀舊 chart 並 unregister,確保 new Chart() 不會撞「Canvas is already in use」
  function _claimTechSubCanvas(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const old = techSubCharts.get(canvasId);
    if (old) { old.destroy(); techSubCharts.delete(canvasId); }
    return canvas;
  }
  function _setTechSub(canvasId, chart) {
    if (chart) techSubCharts.set(canvasId, chart);
    else techSubCharts.delete(canvasId);
  }
  function _destroyTechSubs() {
    for (const c of techSubCharts.values()) c.destroy();
    techSubCharts.clear();
  }

  // CB 技術分析 modal sub-charts 也用 Map (key = canvasId)
  const cbTechSubCharts = new Map();
  function _claimCBTechSubCanvas(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const old = cbTechSubCharts.get(canvasId);
    if (old) { old.destroy(); cbTechSubCharts.delete(canvasId); }
    return canvas;
  }
  function _setCBTechSub(canvasId, chart) {
    if (chart) cbTechSubCharts.set(canvasId, chart);
    else cbTechSubCharts.delete(canvasId);
  }
  function _destroyCBTechSubs() {
    for (const c of cbTechSubCharts.values()) c.destroy();
    cbTechSubCharts.clear();
  }

  function _emptyChart_(canvas, msg) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = APP_CONFIG.colors.textMuted;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
  }

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

  // 從完整 ohlcv 算 MA,再依顯示用的 axisDates 查表回填
  // 用法: const { ma5, ma10, ma20, ma55 } = calcMAsByDates(ohlcv, axisDates, [5,10,20,55])
  // 比 calcMAArray(closeData.slice(...)) 好的點:
  //   1. MA55 在短視窗 (20-60 日) 也能填滿,不會全 null
  //   2. axisDates 不需連續 (CB tech 的 stock∩CB 日期交集也行)
  function calcMAsByDates(fullOhlcv, axisDates, periods) {
    const closes = fullOhlcv.map(r => r.close);
    const result = {};
    for (const p of periods) {
      const maArr = calcMAArray(closes, p);
      const byDate = new Map(fullOhlcv.map((r, i) => [r.date, maArr[i]]));
      result[`ma${p}`] = axisDates.map(d => byDate.get(d) ?? null);
    }
    return result;
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
          legend: { display: false },
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
          legend: { display: false },
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
          legend: { display: false },
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
          legend: { display: false },
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
    const recent = techSlice(ohlcv);
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

    // MA 從完整 ohlcv 算後依顯示日期回填 — MA55 在 60 日視窗內也能填滿
    const { ma5: ma5Data, ma10: ma10Data, ma20: ma20Data, ma55: ma55Data }
      = calcMAsByDates(ohlcv, recentDates, [5, 10, 20, 55]);

    const allPrices = [...highData, ...lowData, ...ma5Data, ...ma10Data, ...ma20Data, ...ma55Data].filter(v => v != null);
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
          { type: 'line', label: 'MA55', data: ma55Data, borderColor: '#10b981', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'bar',  label: '成交量', data: volumeData, backgroundColor: volumeColors, yAxisID: 'yVolume', order: 3, barPercentage: 0.6 }
        ]
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
    const canvas = _claimTechSubCanvas(canvasId);
    if (!canvas) return { latest: null, cumulative: null };

    const dates = stock.institutionalDates || [];
    if (!stock.institutional || dates.length === 0) {
      _emptyChart_(canvas, '無法人買賣超資料');
      return { latest: null, cumulative: null };
    }

    const key = which + '買賣超';
    const recentDates = techSlice(dates);
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

    const chart = new Chart(canvas, {
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
          legend: { display: false },
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
    _setTechSub(canvasId, chart);

    const latest = recentValues.length ? recentValues[recentValues.length - 1] : null;
    const cumLatest = cumulative.length ? cumulative[cumulative.length - 1] : null;
    return { latest, cumulative: cumLatest };
  }

  /**
   * Modal 融資 / 融券 圖 (二選一,各一張)
   *   bar  = 增減 (張)
   *   line = 餘額 (張)
   * @param {string} which '融資' | '融券'
   * @returns {{latestChange:number|null, latestBalance:number|null}}
   */
  function renderTechMarginChart(canvasId, stock, which) {
    const canvas = _claimTechSubCanvas(canvasId);
    if (!canvas) return { latestChange: null, latestBalance: null };

    const dates = stock.marginDates || [];
    if (!stock.margin || dates.length === 0) {
      _emptyChart_(canvas, '無融資融券資料');
      return { latestChange: null, latestBalance: null };
    }

    const changeKey = which + '增減';
    const balanceKey = which + '餘額';
    const recentDates = techSlice(dates);
    const labels = recentDates.map(d => formatDateLabel(d));
    const changeData  = recentDates.map(d => stock.margin[changeKey]?.[d] ?? null);
    const balanceData = recentDates.map(d => stock.margin[balanceKey]?.[d] ?? null);

    const lineColor = which === '融資' ? 'rgba(239,68,68,1)' : 'rgba(34,197,94,1)';
    const barColors = changeData.map(v => v == null
      ? 'rgba(148,163,184,0.4)'
      : (v >= 0 ? 'rgba(239,68,68,0.7)' : 'rgba(34,197,94,0.7)'));

    const chart = new Chart(canvas, {
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
          legend: { display: false },
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
    _setTechSub(canvasId, chart);

    const latestChange = changeData.length ? changeData[changeData.length - 1] : null;
    const latestBalance = balanceData.length ? balanceData[balanceData.length - 1] : null;
    return { latestChange, latestBalance };
  }

  /**
   * 乖離率 (BIAS) 圖 — 同圖 3 條線:5/10/20 日
   *   BIAS(N) = (today close - MA(N)) / MA(N) × 100%
   */
  function renderTechBiasChart(canvasId, stock) {
    const canvas = _claimTechSubCanvas(canvasId);
    if (!canvas) return { bias5: null, bias10: null, bias20: null };

    const ohlcv = stock.ohlcv || [];
    if (ohlcv.length === 0) {
      _emptyChart_(canvas, '無交易資料');
      return { bias5: null, bias10: null, bias20: null };
    }
    const recent = techSlice(ohlcv);
    const labels = recent.map(r => formatDateLabel(r.date));
    const closes = recent.map(r => r.close);
    const ma5 = calcMAArray(closes, 5);
    const ma10 = calcMAArray(closes, 10);
    const ma20 = calcMAArray(closes, 20);
    const bias = (c, m) => (c != null && m != null && m > 0) ? ((c - m) / m * 100) : null;
    const bias5  = closes.map((c, i) => bias(c, ma5[i]));
    const bias10 = closes.map((c, i) => bias(c, ma10[i]));
    const bias20 = closes.map((c, i) => bias(c, ma20[i]));

    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'BIAS5',  data: bias5,  borderColor: '#f59e0b', backgroundColor: 'transparent', borderWidth: 1.4, pointRadius: 0, pointHoverRadius: 3, tension: 0.15, spanGaps: false },
          { label: 'BIAS10', data: bias10, borderColor: '#3b82f6', backgroundColor: 'transparent', borderWidth: 1.4, pointRadius: 0, pointHoverRadius: 3, tension: 0.15, spanGaps: false },
          { label: 'BIAS20', data: bias20, borderColor: '#a855f7', backgroundColor: 'transparent', borderWidth: 1.4, pointRadius: 0, pointHoverRadius: 3, tension: 0.15, spanGaps: false }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            label: (ctx) => {
              const v = ctx.raw;
              return v == null ? `${ctx.dataset.label}: -`
                              : `${ctx.dataset.label}: ${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
            }
          }}
        },
        scales: {
          x: { ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(71,85,105,0.3)' } },
          y: { position: 'left', ticks: { color: APP_CONFIG.colors.text, callback: v => v.toFixed(1) + '%' }, grid: { color: 'rgba(71,85,105,0.3)' } }
        }
      }
    });
    _setTechSub(canvasId, chart);

    const last = (a) => a.slice().reverse().find(v => v != null) ?? null;
    return { bias5: last(bias5), bias10: last(bias10), bias20: last(bias20) };
  }

  // ── 大戶明細 (集保股權分散表) ────────────────────────────────────
  // 資料是「每週五」一筆,跟日 K 的時間軸對不上,所以這兩張圖**不吃 techSlice**,
  // 自己用 APP_CONFIG.holderWeeks 取最近 N 週。

  /** 把某幾個級距的比例/人數加總;整段都是 null 就回 null (缺資料 ≠ 0) */
  function _sumLevels(arr, idx) {
    let sum = 0, has = false;
    for (const i of idx) {
      const v = arr?.[i];
      if (v == null) continue;
      sum += v; has = true;
    }
    return has ? sum : null;
  }

  /** 取集保資料日 (通常是週五) 當天或之前最近一個交易日收盤 */
  function _closeAtOrBefore(ohlcv, date) {
    let out = null;
    for (const r of ohlcv) {
      if (r.date > date) break;
      if (r.close != null) out = r.close;
    }
    return out;
  }

  /** 依目前門檻整理出大戶明細序列 (兩張圖 + 明細表共用) */
  function buildHolderSeries(stock) {
    const rec = stock && stock.holders;
    if (!rec || !Array.isArray(rec.dates) || rec.dates.length === 0) return null;
    const weeks = APP_CONFIG.holderWeeks || 52;
    const n = rec.dates.length;
    const from = Math.max(0, n - weeks);
    const dates = rec.dates.slice(from);
    const bigIdx = holderBigIdx(APP_CONFIG.holderBigLots);
    const smallIdx = holderSmallIdx(APP_CONFIG.holderSmallLots);
    const ohlcv = stock.ohlcv || [];

    const big = [], small = [], bigPeople = [], smallPeople = [], price = [];
    for (let i = from; i < n; i++) {
      big.push(_sumLevels(rec.ratio?.[i], bigIdx));
      small.push(_sumLevels(rec.ratio?.[i], smallIdx));
      bigPeople.push(_sumLevels(rec.people?.[i], bigIdx));
      smallPeople.push(_sumLevels(rec.people?.[i], smallIdx));
      price.push(_closeAtOrBefore(ohlcv, rec.dates[i]));
    }
    const bigChg = big.map((v, i) => (i === 0 || v == null || big[i - 1] == null)
      ? null : v - big[i - 1]);
    return { dates, big, small, bigPeople, smallPeople, price, bigChg };
  }

  /**
   * 大戶 / 散戶 張數比例圖
   *   左軸 = 大戶持股% (橘)、右軸 = 散戶持股% (綠)、隱藏軸 = 股價 (灰)
   */
  function renderTechHolderChart(canvasId, stock) {
    const canvas = _claimTechSubCanvas(canvasId);
    if (!canvas) return null;
    const s = buildHolderSeries(stock);
    if (!s) {
      _emptyChart_(canvas, '無集保股權分散資料');
      return null;
    }
    const labels = s.dates.map(d => formatDateLabel(d));
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '大戶%', data: s.big, borderColor: '#f97316', backgroundColor: 'transparent',
            borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 3, tension: 0.15,
            yAxisID: 'yBig', spanGaps: true, order: 1 },
          { label: '散戶%', data: s.small, borderColor: '#10b981', backgroundColor: 'transparent',
            borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 3, tension: 0.15,
            yAxisID: 'ySmall', spanGaps: true, order: 2 },
          { label: '股價', data: s.price, borderColor: 'rgba(203,213,225,0.85)',
            backgroundColor: 'transparent', borderWidth: 1.2, pointRadius: 0,
            pointHoverRadius: 3, tension: 0.15, yAxisID: 'yPrice', spanGaps: true, order: 3 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => s.dates[items[0].dataIndex],
              label: (ctx) => {
                const v = ctx.raw;
                if (v == null) return `${ctx.dataset.label}: -`;
                return ctx.dataset.label === '股價'
                  ? `股價: ${Number(v).toFixed(2)}`
                  : `${ctx.dataset.label}: ${Number(v).toFixed(2)}%`;
              }
            }
          }
        },
        scales: {
          x: { ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45, autoSkipPadding: 12 },
               grid: { color: 'rgba(71,85,105,0.3)' } },
          // 大戶比例常常一整年只動 1~2%,刻度要到小數第 2 位才不會整排一樣
          yBig: { position: 'left',
                  ticks: { color: '#f97316', font: { size: 10 }, callback: v => v.toFixed(2) },
                  grid: { color: 'rgba(71,85,105,0.3)' } },
          ySmall: { position: 'right',
                    ticks: { color: '#10b981', font: { size: 10 }, callback: v => v.toFixed(2) },
                    grid: { display: false } },
          yPrice: { display: false }
        }
      }
    });
    _setTechSub(canvasId, chart);
    const i = s.dates.length - 1;
    return {
      date: s.dates[i], big: s.big[i], small: s.small[i],
      bigChg: s.bigChg[i], price: s.price[i], series: s
    };
  }

  /** 大戶 / 散戶「持股人數」圖 (左軸大戶人數、右軸散戶人數) */
  function renderTechHolderPeopleChart(canvasId, stock) {
    const canvas = _claimTechSubCanvas(canvasId);
    if (!canvas) return null;
    const s = buildHolderSeries(stock);
    if (!s) {
      _emptyChart_(canvas, '無集保股權分散資料');
      return null;
    }
    const labels = s.dates.map(d => formatDateLabel(d));
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '大戶人數', data: s.bigPeople, borderColor: '#f97316',
            backgroundColor: 'rgba(249,115,22,0.12)', borderWidth: 1.5, pointRadius: 0,
            pointHoverRadius: 3, tension: 0.15, fill: true, yAxisID: 'yBig', spanGaps: true },
          { label: '散戶人數', data: s.smallPeople, borderColor: '#10b981',
            backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0,
            pointHoverRadius: 3, tension: 0.15, yAxisID: 'ySmall', spanGaps: true }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => s.dates[items[0].dataIndex],
              label: (ctx) => ctx.raw == null ? `${ctx.dataset.label}: -`
                : `${ctx.dataset.label}: ${Number(ctx.raw).toLocaleString()} 人`
            }
          }
        },
        scales: {
          x: { ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45, autoSkipPadding: 12 },
               grid: { color: 'rgba(71,85,105,0.3)' } },
          yBig: { position: 'left',
                  ticks: { color: '#f97316', font: { size: 10 }, precision: 0,
                           callback: v => v.toLocaleString() },
                  grid: { color: 'rgba(71,85,105,0.3)' } },
          ySmall: { position: 'right',
                    ticks: { color: '#10b981', font: { size: 10 }, precision: 0,
                             callback: v => v.toLocaleString() },
                    grid: { display: false } }
        }
      }
    });
    _setTechSub(canvasId, chart);
    const i = s.dates.length - 1;
    return { date: s.dates[i], bigPeople: s.bigPeople[i], smallPeople: s.smallPeople[i], series: s };
  }

  function destroyTech() {
    if (techPriceChart)  { techPriceChart.destroy();  techPriceChart = null; }
    _destroyTechSubs();
  }

  // ============================================================
  // CB 技術分析 Modal 圖表
  // ============================================================

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
      : techSlice(ohlcv).map(r => r.date);
    const recent = axisDates.map(d => ohlcvMap.get(d) || { date: d, open: null, high: null, low: null, close: null, volume: null });
    const labels = axisDates.map(formatDateLabel);
    const openData = recent.map(r => r.open);
    const highData = recent.map(r => r.high);
    const lowData = recent.map(r => r.low);
    const closeData = recent.map(r => r.close);
    const volumeData = recent.map(r => r.volume);

    const volumeColors = recent.map(r => r.close >= r.open
      ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.4)');

    // MA 從完整 cb.ohlcv 算後依 axisDates 查表 — MA55 在短視窗也能填滿
    const { ma5, ma10, ma20, ma55 } = calcMAsByDates(ohlcv, axisDates, [5, 10, 20, 55]);

    const allPrices = [...highData, ...lowData, ...ma5, ...ma10, ...ma20, ...ma55].filter(v => v != null);
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
          { type: 'line', label: 'MA55', data: ma55, borderColor: '#10b981', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, yAxisID: 'yPrice', order: 1, tension: 0.1 },
          { type: 'bar',  label: '成交量', data: volumeData, backgroundColor: volumeColors, yAxisID: 'yVolume', order: 3, barPercentage: 0.6 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
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
    const canvas = _claimCBTechSubCanvas(canvasId);
    if (!canvas) return { latest: null, cumulative: null };

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
      : techSlice(dates);
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

    const chart = new Chart(canvas, {
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
          legend: { display: false },
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
    _setCBTechSub(canvasId, chart);

    const latest = recentValues.length ? recentValues[recentValues.length - 1] : null;
    const cumLatest = cumulative.length ? cumulative[cumulative.length - 1] : null;
    return { latest, cumulative: cumLatest };
  }

  /**
   * CB 溢價率 / 流通餘額 圖 (各自一張 canvas)
   *   premium: 用 cb.ohlcv + stock.trading + cb.conversionPrice 算每日溢價率%
   *   convvalue: 轉換價值 = 股價/轉換價 × 100,疊 CB 收盤線可看出溢價幅度
   *   balance: 只有本週/上週,用 ohlcv 日期軸 forward-fill 出每日 bar
   *   combo: 溢價率(右軸%) 疊 轉換價值/CB收盤(左軸元)
   * @param {string} which 'premium' | 'convvalue' | 'combo' | 'balance'
   */
  function renderCBTechExtraChart(canvasId, stock, cbCode, which, sharedDates) {
    const canvas = _claimCBTechSubCanvas(canvasId);
    if (!canvas) return { latest: null };

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
        : techSlice(ohlcv).map(r => r.date);
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

      const chart = new Chart(canvas, {
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
            legend: { display: false },
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
      _setCBTechSub(canvasId, chart);

      const lastPrem = premiums.filter(v => v != null).slice(-1)[0] ?? null;
      return { latest: lastPrem };
    } else if (which === 'combo') {
      // 疊圖:溢價率(右軸 %) + 轉換價值 & CB 收盤(左軸 元)
      const ohlcv = cb.ohlcv || [];
      const convPrice = cb.conversionPrice;
      if (!ohlcv.length || !convPrice) {
        _emptyChart_(canvas, '無法疊圖 (缺 CB 收盤或轉換價)');
        return { latest: null };
      }
      const ohlcvMap = new Map(ohlcv.map(r => [r.date, r]));
      const axisDates = sharedDates && sharedDates.length
        ? sharedDates
        : techSlice(ohlcv).map(r => r.date);
      const labels = axisDates.map(formatDateLabel);

      const convValues = [], cbCloses = [], premiums = [];
      for (const d of axisDates) {
        const r = ohlcvMap.get(d);
        const stockClose = stock.trading?.['收盤價']?.[d];
        const cv = (stockClose != null && stockClose > 0) ? (stockClose / convPrice) * 100 : null;
        const close = r?.close ?? null;
        convValues.push(cv);
        cbCloses.push(close);
        premiums.push((cv != null && cv > 0 && close != null) ? ((close - cv) / cv) * 100 : null);
      }

      const priceVals = convValues.concat(cbCloses).filter(v => v != null);
      let vMin = 0, vMax = 10;
      if (priceVals.length) {
        vMin = Math.min(...priceVals);
        vMax = Math.max(...priceVals);
        const span = Math.max(vMax - vMin, 1);
        vMin -= span * 0.1; vMax += span * 0.1;
      }
      const premVals = premiums.filter(v => v != null);
      let pMin = 0, pMax = 10;
      if (premVals.length) {
        pMin = Math.min(...premVals);
        pMax = Math.max(...premVals);
        const span = Math.max(pMax - pMin, 1);
        pMin -= span * 0.1; pMax += span * 0.1;
      }

      const chart = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: '溢價率(%)',
              data: premiums,
              yAxisID: 'yRight',
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59,130,246,0.15)',
              borderWidth: 1.8,
              pointRadius: 0, pointHoverRadius: 3,
              tension: 0.15, fill: true, spanGaps: false
            },
            {
              label: '轉換價值',
              data: convValues,
              yAxisID: 'y',
              borderColor: '#f59e0b',
              borderWidth: 1.8,
              pointRadius: 0, pointHoverRadius: 3,
              tension: 0.15, fill: false, spanGaps: false
            },
            {
              label: 'CB 收盤',
              data: cbCloses,
              yAxisID: 'y',
              borderColor: '#94a3b8',
              borderWidth: 1.2,
              borderDash: [4, 3],
              pointRadius: 0, pointHoverRadius: 3,
              tension: 0.15, fill: false, spanGaps: false
            }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: true, position: 'top', align: 'end',
              labels: { color: APP_CONFIG.colors.textMuted, boxWidth: 10, font: { size: 10 } }
            },
            tooltip: { callbacks: { label: (ctx) => {
              const v = ctx.raw;
              if (v == null) return `${ctx.dataset.label}: -`;
              return ctx.dataset.yAxisID === 'yRight'
                ? `溢價率: ${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
                : `${ctx.dataset.label}: ${v.toFixed(2)}`;
            }}}
          },
          scales: {
            x: { ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(71,85,105,0.3)' } },
            y: {
              position: 'left', min: vMin, max: vMax,
              ticks: { color: '#f59e0b', callback: v => v.toFixed(1) },
              grid: { color: 'rgba(71,85,105,0.3)' }
            },
            yRight: {
              position: 'right', min: pMin, max: pMax,
              ticks: { color: '#3b82f6', callback: v => v.toFixed(1) + '%' },
              grid: { display: false }
            }
          }
        }
      });
      _setCBTechSub(canvasId, chart);

      let lastPrem = null, lastConv = null, lastClose = null;
      for (let i = axisDates.length - 1; i >= 0; i--) {
        if (premiums[i] != null) {
          lastPrem = premiums[i]; lastConv = convValues[i]; lastClose = cbCloses[i];
          break;
        }
      }
      return { latest: lastPrem, convValue: lastConv, cbClose: lastClose, convPrice };
    } else if (which === 'convvalue') {
      // 轉換價值 = 股價 / 轉換價 × 100 (每張面額 100 元的換股價值),與 CB 收盤同單位可直接比較
      const ohlcv = cb.ohlcv || [];
      const convPrice = cb.conversionPrice;
      if (!convPrice) {
        _emptyChart_(canvas, '無法計算轉換價值 (缺轉換價)');
        return { latest: null };
      }
      const ohlcvMap = new Map(ohlcv.map(r => [r.date, r]));
      const axisDates = sharedDates && sharedDates.length
        ? sharedDates
        : techSlice(Object.keys(stock.trading?.['收盤價'] || {}).sort()).map(d => d);
      const labels = axisDates.map(formatDateLabel);
      const convValues = axisDates.map(d => {
        const stockClose = stock.trading?.['收盤價']?.[d];
        if (stockClose == null || !(stockClose > 0)) return null;
        return (stockClose / convPrice) * 100;
      });
      const cbCloses = axisDates.map(d => ohlcvMap.get(d)?.close ?? null);

      const allVals = convValues.concat(cbCloses).filter(v => v != null);
      let vMin = 0, vMax = 10;
      if (allVals.length) {
        vMin = Math.min(...allVals);
        vMax = Math.max(...allVals);
        const span = Math.max(vMax - vMin, 1);
        vMin -= span * 0.1;
        vMax += span * 0.1;
      }

      const chart = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: '轉換價值',
              data: convValues,
              borderColor: '#f59e0b',
              backgroundColor: 'rgba(245,158,11,0.15)',
              borderWidth: 1.8,
              pointRadius: 0,
              pointHoverRadius: 3,
              tension: 0.15,
              fill: true,
              spanGaps: false
            },
            {
              label: 'CB 收盤',
              data: cbCloses,
              borderColor: '#94a3b8',
              borderWidth: 1.2,
              borderDash: [4, 3],
              pointRadius: 0,
              pointHoverRadius: 3,
              tension: 0.15,
              fill: false,
              spanGaps: false
            }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: true, position: 'top', align: 'end',
              labels: { color: APP_CONFIG.colors.textMuted, boxWidth: 10, font: { size: 10 } }
            },
            tooltip: { callbacks: { label: (ctx) => {
              const v = ctx.raw;
              return v == null ? `${ctx.dataset.label}: -` : `${ctx.dataset.label}: ${v.toFixed(2)}`;
            }}}
          },
          scales: {
            x: { ticks: { color: APP_CONFIG.colors.textMuted, font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(71,85,105,0.3)' } },
            y: {
              position: 'left', min: vMin, max: vMax,
              ticks: { color: APP_CONFIG.colors.text, callback: v => v.toFixed(1) },
              grid: { color: 'rgba(71,85,105,0.3)' }
            },
            yRight: {
              position: 'right', min: vMin, max: vMax,
              ticks: { color: APP_CONFIG.colors.textMuted, callback: v => v.toFixed(1) },
              grid: { display: false }
            }
          }
        }
      });
      _setCBTechSub(canvasId, chart);

      let lastConv = null, lastClose = null, lastStockClose = null;
      for (let i = axisDates.length - 1; i >= 0; i--) {
        if (convValues[i] != null) {
          lastConv = convValues[i];
          lastStockClose = stock.trading?.['收盤價']?.[axisDates[i]] ?? null;
          lastClose = cbCloses[i];
          break;
        }
      }
      return { latest: lastConv, cbClose: lastClose, stockClose: lastStockClose, convPrice };
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
        : techSlice(ohlcv).map(r => r.date);
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

      const chart = new Chart(canvas, {
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
            legend: { display: false },
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
      _setCBTechSub(canvasId, chart);
      return { latest: { thisWeek, lastWeek, change } };
    }
  }

  function destroyCBTechSub(canvasId) {
    const old = cbTechSubCharts.get(canvasId);
    if (old) { old.destroy(); cbTechSubCharts.delete(canvasId); }
  }

  function destroyCBTech() {
    if (cbTechPriceChart) { cbTechPriceChart.destroy(); cbTechPriceChart = null; }
    _destroyCBTechSubs();
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
    renderTechPriceChart, renderTechInstChart, renderTechMarginChart, renderTechBiasChart,
    renderTechHolderChart, renderTechHolderPeopleChart, buildHolderSeries,
    destroyTech,
    renderCBTechPriceChart, renderCBTechInstChart, renderCBTechExtraChart,
    destroyCBTechSub, destroyCBTech,
    destroy
  };
})();
