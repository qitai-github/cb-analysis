// 圖表繪製模組
const Charts = (() => {
  let priceChart = null;
  let instChart = null;

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
          {
            type: 'line',
            label: 'MA5',
            data: ma5Data,
            borderColor: '#f59e0b',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 3,
            yAxisID: 'yPrice',
            order: 1,
            tension: 0.1
          },
          {
            type: 'line',
            label: 'MA10',
            data: ma10Data,
            borderColor: '#3b82f6',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 3,
            yAxisID: 'yPrice',
            order: 1,
            tension: 0.1
          },
          {
            type: 'line',
            label: 'MA20',
            data: ma20Data,
            borderColor: '#a855f7',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 3,
            yAxisID: 'yPrice',
            order: 1,
            tension: 0.1
          },
          {
            type: 'bar',
            label: '成交量',
            data: volumeData,
            backgroundColor: volumeColors,
            yAxisID: 'yVolume',
            order: 3,
            barPercentage: 0.6
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            labels: { color: APP_CONFIG.colors.text, font: { size: 11 } }
          },
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
                if (ctx.dataset.label === '成交量') {
                  return `成交量: ${Number(ctx.raw).toLocaleString()} 張`;
                }
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

  function formatDateLabel(dateStr) {
    if (!dateStr || dateStr.length < 8) return dateStr;
    return dateStr.substring(4, 6) + '/' + dateStr.substring(6, 8);
  }

  function destroy() {
    if (priceChart) { priceChart.destroy(); priceChart = null; }
    if (instChart) { instChart.destroy(); instChart = null; }
  }

  return { renderPriceChart, renderInstChart, destroy };
})();
