// CSV 匯出模組
const ExportCSV = (() => {
  /**
   * 將目前篩選結果匯出為 CSV
   */
  function exportFiltered(data) {
    const headers = [
      '代碼', '名稱', '收盤價', '漲跌%', '成交量(張)',
      '外資5日', '投信5日', '自營5日', '法人合計',
      '融資餘額(張)', '融資增減(張)', '融券餘額(張)', '融券增減(張)'
    ];

    const rows = data.map(stock => [
      stock.code,
      stock.name,
      stock.latestClose != null ? stock.latestClose.toFixed(2) : '',
      stock.priceChangePercent != null ? stock.priceChangePercent.toFixed(2) : '',
      stock.latestVolume ?? '',
      stock.foreign_5d ?? '',
      stock.investment_5d ?? '',
      stock.dealer_5d ?? '',
      stock.totalInst_5d ?? '',
      stock.latestMarginBalance ?? '',
      stock.latestMarginChange ?? '',
      stock.latestShortBalance ?? '',
      stock.latestShortChange ?? ''
    ]);

    downloadCSV(headers, rows, `CB篩選結果_${getDateStr()}.csv`);
  }

  /**
   * 匯出詳細法人資料 (含時間序列)
   */
  function exportInstitutional(stock) {
    if (!stock.institutionalDates?.length) return;

    const dates = stock.institutionalDates;
    const headers = ['日期', '外資買賣超', '投信買賣超', '自營商買賣超', '合計'];
    const rows = dates.map(d => {
      const f = stock.institutional['外資買賣超']?.[d] ?? 0;
      const inv = stock.institutional['投信買賣超']?.[d] ?? 0;
      const deal = stock.institutional['自營商買賣超']?.[d] ?? 0;
      return [d, f, inv, deal, f + inv + deal];
    });

    downloadCSV(headers, rows, `${stock.code}_${stock.name}_法人資料_${getDateStr()}.csv`);
  }

  /**
   * 匯出個股交易明細 (含時間序列)
   */
  function exportTrading(stock) {
    if (!stock.tradingDates?.length) return;

    const dates = stock.tradingDates;
    const headers = ['日期', '開盤價', '最高價', '最低價', '收盤價', '成交股數'];
    const rows = dates.map(d => [
      d,
      stock.trading['開盤價']?.[d] ?? '',
      stock.trading['最高價']?.[d] ?? '',
      stock.trading['最低價']?.[d] ?? '',
      stock.trading['收盤價']?.[d] ?? '',
      stock.trading['成交股數']?.[d] ?? ''
    ]);

    downloadCSV(headers, rows, `${stock.code}_${stock.name}_交易明細_${getDateStr()}.csv`);
  }

  function downloadCSV(headers, rows, filename) {
    // 加 BOM 讓 Excel 正確辨識 UTF-8
    const BOM = '\uFEFF';
    const csv = BOM + [
      headers.map(escapeCSV).join(','),
      ...rows.map(row => row.map(escapeCSV).join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function escapeCSV(val) {
    const str = String(val ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function getDateStr() {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }

  return { exportFiltered, exportInstitutional, exportTrading };
})();
