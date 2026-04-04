// 資料解析與正規化模組
const DataProcessor = (() => {

  /**
   * 解析時間序列資料 (法人資料 / 個股交易明細)
   * 格式: [代碼, 名稱, 類別, 日期1值, 日期2值, ...]
   */
  function parseTimeSeries(rawData) {
    if (!rawData || rawData.length < 2) return { dates: [], stocks: {} };

    const headerRow = rawData[0];
    const dates = headerRow.slice(3).map(d => String(d).trim()).filter(d => d);

    const stocks = {};
    let currentCode = '';
    let currentName = '';

    for (let i = 1; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row || row.length < 4) continue;

      const code = String(row[0]).trim();
      const name = String(row[1]).trim();
      const category = String(row[2]).trim();

      if (code) currentCode = code;
      if (name) currentName = name;
      if (!currentCode || !category) continue;

      if (!stocks[currentCode]) {
        stocks[currentCode] = { code: currentCode, name: currentName, data: {} };
      }

      const values = {};
      for (let j = 0; j < dates.length && j + 3 < row.length; j++) {
        const val = parseNumber(row[j + 3]);
        if (val !== null) values[dates[j]] = val;
      }
      stocks[currentCode].data[category] = values;
    }

    return { dates, stocks };
  }

  /**
   * 解析 CB 交易日報
   * 規則:
   * - 只保留「等價」交易，排除「議價」
   * - 若收市價為空，使用明日參價
   * - 若漲跌為空，使用 0
   */
  function parseCBDailyReport(rawData) {
    if (!rawData || rawData.length < 2) return [];

    const results = [];

    for (let i = 0; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row) continue;

      const marker = String(row[0]).trim().toUpperCase();
      if (marker === 'HEADER') continue;

      const code = String(row[1] || '').trim();
      const name = String(row[2] || '').trim();
      const tradeType = String(row[3] || '').trim();

      if (!code || !name) continue;
      // 排除議價
      if (tradeType === '議價') continue;

      // 收市價: 優先使用收市，若無則用明日參價
      let close = parseNumber(row[4]);
      const refPrice = parseNumber(row[13]);
      if (close === null && refPrice !== null) {
        close = refPrice;
      }

      // 漲跌: 若無則設為 0
      let change = parseNumber(row[5]);
      if (change === null) change = 0;

      results.push({
        cbCode: code,
        cbName: name.trim(),
        stockCode: extractStockCode(code),
        tradeType,
        close,
        change,
        open: parseNumber(row[6]),
        high: parseNumber(row[7]),
        low: parseNumber(row[8]),
        trades: parseNumber(row[9]),
        volume: parseNumber(row[10]),
        amount: parseNumber(row[11]),
        avgPrice: parseNumber(row[12]),
        refPrice,
        limitUp: parseNumber(row[14]),
        limitDown: parseNumber(row[15])
      });
    }

    return results;
  }

  /**
   * 從原始資料中依關鍵字分割出多個區段
   * 回傳 [{title, keywordRow, endRow}, ...]
   * 只記錄關鍵字所在列, 資料範圍 = keywordRow+1 ~ endRow (exclusive)
   * 每個區段內再靠 isValidCode 過濾非資料列 (標題、表頭、空白)
   */
  function detectSections(rawData, sectionKeywords) {
    const found = []; // {name, row}
    const matched = new Set(); // 避免同一關鍵字重複匹配

    for (let i = 0; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row) continue;
      const rowText = row.map(c => String(c || '').trim()).join('');
      for (const kw of sectionKeywords) {
        if (matched.has(kw.name)) continue;
        if (rowText.includes(kw.keyword)) {
          found.push({ title: kw.name, keywordRow: i });
          matched.add(kw.name);
          break;
        }
      }
    }

    // 計算每個區段的結束列
    for (let i = 0; i < found.length; i++) {
      found[i].endRow = (i + 1 < found.length)
        ? found[i + 1].keywordRow   // 到下一個關鍵字列之前
        : rawData.length;
    }

    return found;
  }

  /**
   * 判斷是否為有效的標的代號 (4~6碼數字)
   */
  function isValidCode(val) {
    const code = String(val || '').trim();
    return code.length >= 4 && code.length <= 6 && /^\d+$/.test(code);
  }

  /**
   * 解析富邦 CB 初級市場資訊 (含 3 個區段)
   * 區段1: 初級市場資訊 (已掛牌)
   * 區段2: 送件標的
   * 區段3: 董事會通過發行標的
   */
  function parseFubonPrimary(rawData) {
    if (!rawData || rawData.length < 4) return [];

    // 用表頭列的獨特關鍵字來區分三個區段
    // 順序很重要: OP交易 先匹配 (避免賣回條件也匹配到 listed 表頭)
    const sections = detectSections(rawData, [
      { keyword: 'OP交易', name: 'fubon_listed' },
      { keyword: '賣回條件', name: 'fubon_filing' },
      { keyword: '公告日期', name: 'fubon_board' }
    ]);

    // 若未偵測到任何區段，嘗試舊邏輯 (向下相容)
    if (sections.length === 0) {
      return parseFubonPrimaryFlat(rawData);
    }

    const results = [];

    for (const sec of sections) {
      for (let i = sec.keywordRow + 1; i < sec.endRow; i++) {
        const row = rawData[i];
        if (!row) continue;
        const code = String(row[0] || '').trim();
        if (!isValidCode(code)) continue;

        const item = {
          cbCode: code,
          stockCode: extractStockCode(code),
          cbName: String(row[1] || '').trim(),
          source: '富邦',
          section: sec.title
        };

        if (sec.title === 'fubon_listed') {
          // A:標的代號 B:發行標的 C:發行期間(年) D:發行金額(億)
          // E:賣回條件 F:溢價率 G:承銷商 H:TCRI/擔保 I:詢圈/競拍
          // J:掛牌日 K:轉換價 L:可拆解選擇權日 M:比例 N:備註
          item.issueAmount = parseNumber(row[3]);
          item.guarantee = String(row[7] || '').trim();
          item.bidding = String(row[8] || '').trim();
          item.premium = parseNumber(row[5]);
          item.conversionPrice = parseNumber(row[10]);
          item.listingDate = String(row[9] || '').trim();
          item.opDate = String(row[11] || '').trim();
          item.remark = String(row[13] || '').trim();
        } else if (sec.title === 'fubon_filing') {
          // A:標的代號 B:發行標的 C:發行期間(年) D:發行金額(億)
          // H:TCRI/擔保 I:詢圈/競拍 F:溢價率
          // J:送件日 K:生效日 L:備註
          item.issueAmount = parseNumber(row[3]);
          item.guarantee = String(row[7] || '').trim();
          item.bidding = String(row[8] || '').trim();
          item.premium = parseNumber(row[5]);
          item.years = parseNumber(row[2]);
          item.filingDate = String(row[9] || '').trim();
          item.effectiveDate = String(row[10] || '').trim();
          item.remark = String(row[11] || '').trim();
        } else if (sec.title === 'fubon_board') {
          // A:標的代號 B:發行標的 C:發行期間(年) D:發行金額(億)
          // E:公告日期 G:TCRI/擔保 H:詢圈/競拍 I:產業別
          // J:資本額(億) K:備註
          item.issueAmount = parseNumber(row[3]);
          item.guarantee = String(row[6] || '').trim();
          item.bidding = String(row[7] || '').trim();
          item.years = parseNumber(row[2]);
          item.industry = String(row[8] || '').trim();
          item.capital = parseNumber(row[9]);
          item.announcementDate = String(row[4] || '').trim();
          item.remark = String(row[10] || '').trim();
        }

        results.push(item);
      }
    }

    return results;
  }

  /** 舊版富邦平面解析 (向下相容) */
  function parseFubonPrimaryFlat(rawData) {
    const results = [];
    for (const row of rawData) {
      if (!row) continue;
      const code = String(row[0] || '').trim();
      if (!isValidCode(code)) continue;
      results.push({
        cbCode: code,
        stockCode: extractStockCode(code),
        cbName: String(row[1] || '').trim(),
        issueAmount: parseNumber(row[3]),
        guarantee: String(row[7] || '').trim(),
        conversionPrice: parseNumber(row[10]),
        listingDate: String(row[9] || '').trim(),
        source: '富邦',
        section: 'fubon_listed'
      });
    }
    return results;
  }

  /**
   * 解析元大 CB 初級案件彙整表 (含 2 個區段)
   * 區段1: 初級案件彙整表 (已生效/掛牌)
   * 區段2: 董事會決議公告
   *
   * 元大初級案件欄位 (A~U):
   *   A=序號, B=詢圈/競拍, C=標的代號, D=發行標的, E=TCRI/擔保,
   *   F=發行量, G=?, H=?, I=生效日, J=?, K=?,
   *   L=轉換價, M=掛牌日, N=可拆解選擇權日, R=股本, U=備註
   *
   * 元大董事會決議公告欄位:
   *   A=序號, B=詢圈/競拍, C=標的代號, D=發行標的, E=TCRI/擔保,
   *   F=發行量, G=?, H=到期日, I=董事會通過, J=股本, U=備註
   */
  function parseYuantaPrimary(rawData) {
    if (!rawData || rawData.length < 3) return [];

    const sections = detectSections(rawData, [
      { keyword: '元大證債券部CB初級案件彙整表', name: 'yuanta_listed' },
      { keyword: '董事會決議公告', name: 'yuanta_board' }
    ]);

    if (sections.length === 0) {
      return parseYuantaPrimaryFlat(rawData);
    }

    const results = [];

    for (const sec of sections) {
      for (let i = sec.keywordRow + 1; i < sec.endRow; i++) {
        const row = rawData[i];
        if (!row) continue;

        // C 欄 (index 2) = 標的代號
        const codeCol = String(row[2] || '').trim();
        if (!isValidCode(codeCol)) continue;

        const item = {
          cbCode: codeCol,
          stockCode: extractStockCode(codeCol),
          cbName: String(row[3] || '').trim(),       // D 欄
          bidding: String(row[1] || '').trim(),       // B 欄
          guarantee: String(row[4] || '').trim(),     // E 欄
          issueAmount: parseNumber(row[5]),            // F 欄
          source: '元大',
          section: sec.title
        };

        if (sec.title === 'yuanta_listed') {
          item.effectiveDate = String(row[8] || '').trim();  // I 欄
          item.conversionPrice = parseNumber(row[11]);        // L 欄
          item.listingDate = String(row[12] || '').trim();    // M 欄
          item.opDate = String(row[13] || '').trim();         // N 欄
          item.capital = parseNumber(row[17]);                 // R 欄
          item.remark = String(row[20] || '').trim();         // U 欄
        } else if (sec.title === 'yuanta_board') {
          item.maturityDate = String(row[7] || '').trim();    // H 欄
          item.announcementDate = String(row[8] || '').trim();// I 欄 (董事會通過)
          item.capital = parseNumber(row[9]);                  // J 欄
          item.remark = String(row[20] || '').trim();         // U 欄
        }

        results.push(item);
      }
    }

    return results;
  }

  /** 舊版元大平面解析 (向下相容) */
  function parseYuantaPrimaryFlat(rawData) {
    const results = [];
    for (const row of rawData) {
      if (!row) continue;
      const codeCol = String(row[2] || '').trim();
      if (!isValidCode(codeCol)) continue;
      results.push({
        cbCode: codeCol,
        stockCode: extractStockCode(codeCol),
        cbName: String(row[3] || '').trim(),
        bidding: String(row[1] || '').trim(),
        guarantee: String(row[4] || '').trim(),
        issueAmount: parseNumber(row[5]),
        conversionPrice: parseNumber(row[11]),
        listingDate: String(row[12] || '').trim(),
        source: '元大',
        section: 'yuanta_listed'
      });
    }
    return results;
  }

  /**
   * 解析 CB 發行資訊 (來自 Apps Script API)
   * 回傳以 cbCode 為 key 的 Map
   */
  function parseCBIssuance(issuanceData) {
    const map = new Map();
    if (!issuanceData || !Array.isArray(issuanceData)) return map;

    for (const item of issuanceData) {
      if (!item.cbCode) continue;
      map.set(item.cbCode, {
        cbCode: item.cbCode,
        stockCode: item.stockCode,
        conversionPrice: item.conversionPrice,
        conversionPeriod: item.conversionPeriod,
        maturityDate: item.maturityDate,
        issueConversionPrice: item.issueConversionPrice,
        title: item.title
      });
    }

    return map;
  }

  /**
   * 合併所有資料
   */
  function mergeAllData(rawResults) {
    const stockMap = new Map();
    let latestDataDate = '';

    // 解析 CB 發行資訊
    const issuanceMap = parseCBIssuance(rawResults.cbIssuance);

    // 1. 法人資料
    if (rawResults.cbInstitutional) {
      const { dates, stocks } = parseTimeSeries(rawResults.cbInstitutional);
      if (dates.length > 0 && dates[dates.length - 1] > latestDataDate) {
        latestDataDate = dates[dates.length - 1];
      }
      for (const [code, stock] of Object.entries(stocks)) {
        const entry = getOrCreate(stockMap, code, stock.name);
        entry.institutional = stock.data;
        entry.institutionalDates = dates;
      }
    }

    // 2. 個股交易明細
    if (rawResults.stockTrading) {
      const { dates, stocks } = parseTimeSeries(rawResults.stockTrading);
      if (dates.length > 0 && dates[dates.length - 1] > latestDataDate) {
        latestDataDate = dates[dates.length - 1];
      }
      for (const [code, stock] of Object.entries(stocks)) {
        const entry = getOrCreate(stockMap, code, stock.name);
        entry.trading = stock.data;
        entry.tradingDates = dates;
      }
    }

    // 3. CB 交易日報
    if (rawResults.cbDailyReport) {
      const cbDaily = parseCBDailyReport(rawResults.cbDailyReport);
      for (const cb of cbDaily) {
        if (!cb.stockCode) continue;

        // 從發行資訊補充轉換價和轉換期間
        const issuance = issuanceMap.get(cb.cbCode);
        if (issuance) {
          cb.conversionPrice = issuance.conversionPrice;
          cb.conversionPeriod = issuance.conversionPeriod;
          cb.maturityDate = issuance.maturityDate;
        }

        const entry = getOrCreate(stockMap, cb.stockCode, '');
        if (!entry.cbs) entry.cbs = [];
        entry.cbs.push(cb);
      }
    }

    // 4. 富邦初級市場
    if (rawResults.fubonPrimary) {
      const fubon = parseFubonPrimary(rawResults.fubonPrimary);
      for (const item of fubon) {
        if (!item.stockCode) continue;
        const entry = getOrCreate(stockMap, item.stockCode, '');
        if (!entry.primaryMarket) entry.primaryMarket = [];
        entry.primaryMarket.push(item);
      }
    }

    // 5. 元大初級案件
    if (rawResults.yuantaPrimary) {
      const yuanta = parseYuantaPrimary(rawResults.yuantaPrimary);
      for (const item of yuanta) {
        if (!item.stockCode) continue;
        const entry = getOrCreate(stockMap, item.stockCode, '');
        if (!entry.primaryMarket) entry.primaryMarket = [];
        entry.primaryMarket.push(item);
      }
    }

    // 計算衍生欄位
    for (const [, stock] of stockMap) {
      computeDerivedFields(stock, issuanceMap);
    }

    return { stockMap, latestDataDate };
  }

  function getOrCreate(map, code, name) {
    if (!map.has(code)) {
      map.set(code, {
        code,
        name: name || '',
        institutional: {},
        trading: {},
        cbs: [],
        primaryMarket: [],
        institutionalDates: [],
        tradingDates: []
      });
    }
    const entry = map.get(code);
    if (!entry.name && name) entry.name = name;
    return entry;
  }

  /**
   * 計算衍生欄位
   */
  function computeDerivedFields(stock, issuanceMap) {
    const tradingDates = stock.tradingDates || [];
    const instDates = stock.institutionalDates || [];

    // === 股價 ===
    if (tradingDates.length > 0) {
      const latestDate = tradingDates[tradingDates.length - 1];
      const prevDate = tradingDates.length > 1 ? tradingDates[tradingDates.length - 2] : null;

      stock.latestClose = stock.trading['收盤價']?.[latestDate] ?? null;
      // 成交量: 股→張 (÷1000)
      const rawVolume = stock.trading['成交股數']?.[latestDate] ?? null;
      stock.latestVolume = rawVolume != null ? Math.round(rawVolume / 1000) : null;
      stock.latestHigh = stock.trading['最高價']?.[latestDate] ?? null;
      stock.latestLow = stock.trading['最低價']?.[latestDate] ?? null;
      stock.latestOpen = stock.trading['開盤價']?.[latestDate] ?? null;

      if (prevDate && stock.trading['收盤價']?.[prevDate]) {
        const prevClose = stock.trading['收盤價'][prevDate];
        stock.priceChange = stock.latestClose - prevClose;
        stock.priceChangePercent = prevClose ? ((stock.latestClose - prevClose) / prevClose * 100) : null;
      }

      stock.ma5 = calcMA(stock.trading['收盤價'], tradingDates, 5);
      stock.ma10 = calcMA(stock.trading['收盤價'], tradingDates, 10);
      stock.ma20 = calcMA(stock.trading['收盤價'], tradingDates, 20);
      const rawAvgVol5 = calcMA(stock.trading['成交股數'], tradingDates, 5);
      stock.avgVolume5 = rawAvgVol5 != null ? Math.round(rawAvgVol5 / 1000) : null;
    }

    // === 法人累計 (股→張 ÷1000) ===
    if (instDates.length > 0) {
      for (const days of APP_CONFIG.institutionalAccumDays) {
        const suffix = `${days}d`;
        const rawF = calcAccum(stock.institutional['外資買賣超'], instDates, days);
        const rawI = calcAccum(stock.institutional['投信買賣超'], instDates, days);
        const rawD = calcAccum(stock.institutional['自營商買賣超'], instDates, days);
        stock[`foreign_${suffix}`] = rawF != null ? Math.round(rawF / 1000) : null;
        stock[`investment_${suffix}`] = rawI != null ? Math.round(rawI / 1000) : null;
        stock[`dealer_${suffix}`] = rawD != null ? Math.round(rawD / 1000) : null;
        stock[`totalInst_${suffix}`] =
          (stock[`foreign_${suffix}`] || 0) +
          (stock[`investment_${suffix}`] || 0) +
          (stock[`dealer_${suffix}`] || 0);
      }

      // === 連續買超天數 ===
      stock.foreignConsecutiveBuy = calcConsecutiveBuy(stock.institutional['外資買賣超'], instDates);
      stock.investmentConsecutiveBuy = calcConsecutiveBuy(stock.institutional['投信買賣超'], instDates);
    }

    // === CB 相關 ===
    if (stock.cbs && stock.cbs.length > 0) {
      stock.cbCount = stock.cbs.length;
      // 主要 CB: 優先選有收盤價的等價交易
      stock.mainCB = stock.cbs.find(cb => cb.close) || stock.cbs[0];

      // 從發行資訊取得轉換價 (如果 CB 交易日報沒有)
      for (const cb of stock.cbs) {
        if (!cb.conversionPrice) {
          const issuance = issuanceMap.get(cb.cbCode);
          if (issuance?.conversionPrice) {
            cb.conversionPrice = issuance.conversionPrice;
            cb.conversionPeriod = issuance.conversionPeriod;
          }
        }
      }

      // 轉換價和轉換起始日 (從主CB取)
      if (stock.mainCB) {
        stock.conversionPrice = stock.mainCB.conversionPrice || null;
        stock.conversionPeriod = extractConvStartDate(stock.mainCB.conversionPeriod);
      }
    }

    // 初級市場
    if (stock.primaryMarket && stock.primaryMarket.length > 0) {
      stock.hasPrimary = true;
      const latest = stock.primaryMarket[stock.primaryMarket.length - 1];
      stock.latestPrimary = latest;
      // 初級市場的轉換價做為備用
      if (!stock.conversionPrice && latest.conversionPrice) {
        stock.conversionPrice = latest.conversionPrice;
      }
    }

    // === CB 溢價率 ===
    // 公式: (CB市價 - 轉換價值) / 轉換價值 × 100%
    // 轉換價值 = (面額100 / 轉換價) × 股價
    if (stock.mainCB?.close && stock.conversionPrice && stock.latestClose) {
      const conversionValue = (100 / stock.conversionPrice) * stock.latestClose;
      stock.cbPremiumRate = ((stock.mainCB.close - conversionValue) / conversionValue) * 100;
    }
  }

  // === 工具函數 ===

  function calcMA(dataObj, dates, period) {
    if (!dataObj || dates.length < period) return null;
    const recentDates = dates.slice(-period);
    let sum = 0, count = 0;
    for (const d of recentDates) {
      const v = dataObj[d];
      if (v !== undefined && v !== null) { sum += v; count++; }
    }
    return count > 0 ? sum / count : null;
  }

  /**
   * 計算連續買超天數 (從最近日期往回數)
   */
  function calcConsecutiveBuy(dataObj, dates) {
    if (!dataObj || dates.length === 0) return 0;
    let count = 0;
    for (let i = dates.length - 1; i >= 0; i--) {
      const v = dataObj[dates[i]];
      if (v !== undefined && v !== null && v > 0) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * 從轉換期間字串提取起始日期
   * "113/11/16～116/08/15" → "113/11/16"
   */
  function extractConvStartDate(period) {
    if (!period) return '';
    const str = String(period).trim();
    const match = str.match(/(\d{2,3}\/\d{1,2}\/\d{1,2})/);
    return match ? match[1] : str;
  }

  function calcAccum(dataObj, dates, period) {
    if (!dataObj) return null;
    const recentDates = dates.slice(-period);
    let sum = 0;
    for (const d of recentDates) {
      const v = dataObj[d];
      if (v !== undefined && v !== null) sum += v;
    }
    return sum;
  }

  function parseNumber(val) {
    if (val === null || val === undefined || val === '') return null;
    const str = String(val).replace(/,/g, '').replace(/\s/g, '').replace(/'/g, '').replace(/^\+/, '');
    const num = Number(str);
    return isNaN(num) ? null : num;
  }

  /**
   * 從 CB 代碼提取股票代碼 (前4碼)
   */
  function extractStockCode(cbCode) {
    if (!cbCode) return '';
    const code = String(cbCode).trim();
    if (code.length >= 5) return code.substring(0, 4);
    return code;
  }

  return {
    parseTimeSeries,
    parseCBDailyReport,
    parseFubonPrimary,
    parseYuantaPrimary,
    parseCBIssuance,
    mergeAllData,
    parseNumber,
    extractStockCode
  };
})();
