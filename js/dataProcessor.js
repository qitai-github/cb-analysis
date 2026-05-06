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
   * 合併所有資料
   */
  function mergeAllData(rawResults) {
    const stockMap = new Map();
    let latestDataDate = '';

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

    // 3a. CB 每日交易明細 (CB 自身 OHLCV 時間序列)
    //     以 cbCode 為 key 儲存，稍後在計算衍生欄位時接到 mainCB
    let cbTradingByCode = null;
    if (rawResults.cbDailyTrading) {
      const { dates, stocks } = parseTimeSeries(rawResults.cbDailyTrading);
      cbTradingByCode = { dates, stocks };
    }

    // 3. CB 交易日報
    if (rawResults.cbDailyReport) {
      const cbDaily = parseCBDailyReport(rawResults.cbDailyReport);
      for (const cb of cbDaily) {
        if (!cb.stockCode) continue;
        const entry = getOrCreate(stockMap, cb.stockCode, '');
        if (!entry.cbs) entry.cbs = [];
        entry.cbs.push(cb);
      }
    }

    // 3b. CB Trading fallback — 新發行 CB 富邦交易日報可能延遲幾天才收錄,
    //     但 cbDailyTrading 已經有 OHLCV → 補一個最小 cb 物件,
    //     讓主表不會掉檔,後續 yuantaReport / cbDailyTrading 覆蓋會把細節填回來。
    //     cbName 優先用 yuantaReport.basicInfo (cbDailyTrading 來源偶有亂碼)。
    if (cbTradingByCode) {
      const yrBasic = rawResults.yuantaReport?.basicInfo || {};
      const seenCBs = new Set();
      for (const [, st] of stockMap) {
        if (!st.cbs) continue;
        for (const cb of st.cbs) {
          if (cb.cbCode) seenCBs.add(cb.cbCode);
        }
      }
      for (const [cbCode, cbEntry] of Object.entries(cbTradingByCode.stocks)) {
        if (seenCBs.has(cbCode)) continue;
        const stockCode = extractStockCode(cbCode);
        if (!stockCode) continue;
        const entry = getOrCreate(stockMap, stockCode, '');
        if (!entry.cbs) entry.cbs = [];
        const yr = yrBasic[cbCode] || {};
        const cbName = yr.cbName || cleanName(cbEntry.name) || '';
        entry.cbs.push({
          cbCode,
          cbName,
          stockCode,
          tradeType: '等價',
          close: null,
          change: 0
        });
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

    // 6. twsa 競拍開標統計表 (以 cbCode 為 key)
    const auctionMap = parseTwsaAuction(rawResults.twsaAuction);

    // 6b. 台股公司主檔 (以股票代碼為 key 的產業分類字串)
    const industryMap = parseStockIndustry(rawResults.stockIndustry);
    for (const [code, stock] of stockMap) {
      const ind = industryMap.get(code);
      if (ind) stock.industryCategory = ind;
    }

    // 6c. 新聞資訊 (以股票名稱對應到代碼)
    if (rawResults.stockNews) {
      // 建立 name → code 的對照表
      const nameToCode = new Map();
      for (const [code, stock] of stockMap) {
        if (stock.name) nameToCode.set(stock.name, code);
      }
      const newsItems = parseStockNews(rawResults.stockNews);
      for (const item of newsItems) {
        const code = nameToCode.get(item.stockName);
        if (!code) continue;
        const entry = stockMap.get(code);
        if (!entry) continue;
        if (!entry.news) entry.news = [];
        entry.news.push(item);
      }
    }

    // 7. CB三大法人 (以 cbCode 為 key 的 timeseries)
    let cbBondInstByCode = null;
    if (rawResults.cbBondInstitutional) {
      const { dates, stocks } = parseTimeSeries(rawResults.cbBondInstitutional);
      cbBondInstByCode = { dates, stocks };
    }

    // 8. 元大證選擇權報表 enrichment
    if (rawResults.yuantaReport) {
      mergeYuantaReport(stockMap, rawResults.yuantaReport);
    }

    // 9. 個股狀態 (VCP / 三線開花) — 由 parse_and_export 寫入 all-data.json
    applyStockStatus(stockMap, rawResults.stockStatus);

    // 計算衍生欄位
    for (const [, stock] of stockMap) {
      computeDerivedFields(stock, cbTradingByCode, auctionMap, cbBondInstByCode);
    }

    return { stockMap, latestDataDate };
  }

  /**
   * 把 VCP / 三線開花 結果掛到 stockMap 對應個股上
   * stockStatus 結構: { vcp: {date, stocks:{code:{...}}}, sanxian: {date, stocks:{...}} }
   */
  function applyStockStatus(stockMap, stockStatus) {
    if (!stockStatus || typeof stockStatus !== 'object') return;
    for (const [type, payload] of Object.entries(stockStatus)) {
      if (!payload || typeof payload.stocks !== 'object') continue;
      const date = payload.date || '';
      for (const [code, details] of Object.entries(payload.stocks)) {
        const entry = stockMap.get(code);
        if (!entry) continue;  // 只標示 CB 對應個股
        if (!entry.statusFlags) entry.statusFlags = {};
        entry.statusFlags[type] = { date, ...(details || {}) };
      }
    }
  }

  /**
   * 解析台股公司主檔 → Map<stockCode, industryCategoryString>
   * 欄位：A=代碼, B=股名, C=公司名, D/E/F...=產業分類 (可自動擴充 G 欄以後)
   * 多個分類以「、」串接，略過空字串與 "-"
   */
  function parseStockIndustry(rawData) {
    const map = new Map();
    if (!Array.isArray(rawData) || rawData.length < 2) return map;
    for (let i = 1; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row) continue;
      const code = String(row[0] || '').trim();
      if (!code) continue;
      const cats = [];
      for (let j = 3; j < row.length; j++) {
        const v = String(row[j] || '').trim();
        if (v && v !== '-') cats.push(v);
      }
      if (cats.length > 0) map.set(code, cats.join('、'));
    }
    return map;
  }

  /**
   * 解析新聞資訊 → Array<{ stockName, date, title, link }>
   * 欄位：A=時間, B=股票(名稱), C=標題, D=連結
   * 按時間倒序排列（最新在前）
   */
  function parseStockNews(rawData) {
    const items = [];
    if (!Array.isArray(rawData) || rawData.length < 2) return items;
    for (let i = 1; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row) continue;
      const date = String(row[0] || '').trim();
      const stockName = String(row[1] || '').trim();
      const title = String(row[2] || '').trim();
      const link = String(row[3] || '').trim();
      if (!stockName || !title) continue;
      items.push({ stockName, date, title, link });
    }
    // 按日期倒序（最新在前），用 Date 解析避免字串排序錯誤（如 4/8 > 4/18）
    items.sort((a, b) => new Date(b.date) - new Date(a.date));
    return items;
  }

  /**
   * 解析 twsa 競拍資料 → Map<cbCode, auctionObj>
   */
  function parseTwsaAuction(twsaData) {
    const map = new Map();
    if (!twsaData || !Array.isArray(twsaData.auction)) return map;
    for (const item of twsaData.auction) {
      const cbCode = item?.pdf?.stockId;
      if (!cbCode) continue;
      map.set(String(cbCode), item);
    }
    return map;
  }

  /**
   * 合併元大證選擇權報表資料到 stockMap
   */
  function mergeYuantaReport(stockMap, yr) {
    if (!yr) return;

    // 建立 conversionStop 以 cbCode 為 key 的查詢表
    const convStopMap = new Map();
    if (yr.conversionStop) {
      for (const item of yr.conversionStop) {
        if (!item.cbCode) continue;
        if (!convStopMap.has(item.cbCode)) convStopMap.set(item.cbCode, []);
        convStopMap.get(item.cbCode).push(item);
      }
    }

    // 建立 callRights 以 stockCode 為 key
    const callRightsMap = new Map();
    if (yr.callRights) {
      for (const item of yr.callRights) {
        if (!item.stockCode) continue;
        if (!callRightsMap.has(item.stockCode)) callRightsMap.set(item.stockCode, []);
        callRightsMap.get(item.stockCode).push(item);
      }
    }

    // 建立 priceAdjust 以 stockCode 為 key
    const priceAdjustMap = new Map();
    if (yr.priceAdjust) {
      for (const item of yr.priceAdjust) {
        if (!item.stockCode) continue;
        if (!priceAdjustMap.has(item.stockCode)) priceAdjustMap.set(item.stockCode, []);
        priceAdjustMap.get(item.stockCode).push(item);
      }
    }

    for (const [code, stock] of stockMap) {
      // 掛載事件
      const calls = callRightsMap.get(code);
      if (calls) stock.callRights = calls;
      const adjusts = priceAdjustMap.get(code);
      if (adjusts) stock.priceAdjust = adjusts;

      // 逐檔 CB enrichment
      if (!stock.cbs) continue;
      for (const cb of stock.cbs) {
        const cbCode = cb.cbCode;
        if (!cbCode) continue;

        // 報價單
        const q = yr.quotes?.[cbCode];
        if (q) {
          cb.tcri = q.tcri;
          cb.asoPremium = q.premium;
          cb.optionExpiry = q.optionExpiry;
          cb.vol120 = q.vol120;
          cb.vol240 = q.vol240;
          cb.outstandingPct = q.outstandingPct;
          cb.issueAmount = q.issueAmount;
          cb.remainYears = q.remainYears;
          cb.discountRate = q.discountRate;
          if (q.industry) cb.industry = q.industry;
        }

        // 基本資料
        const b = yr.basicInfo?.[cbCode];
        if (b) {
          // 名稱:basicInfo 是最乾淨來源,蓋過 cbDailyReport / cbDailyTrading 偶發亂碼
          if (b.cbName) cb.cbName = b.cbName;
          cb.couponRate = b.couponRate;
          cb.issueDate = b.issueDate;
          cb.listDate = b.listDate;
          cb.issueTotal = b.issueTotal;
          cb.actualTotal = b.actualTotal;
          cb.latestBalance = b.latestBalance;
          cb.repayYears = b.repayYears;
          cb.issueConvPrice = b.issueConvPrice;
          cb.underwriter = b.underwriter;
          cb.guarantee = b.guarantee;
          cb.nearestPutDate = b.nearestPutDate;
          cb.nearestPutPrice = b.nearestPutPrice;
          cb.nearestPutYield = b.nearestPutYield;
          cb.resetFormula = b.resetFormula;
          cb.callDate = b.callDate;
          if (b.convPrice && !cb.conversionPrice) cb.conversionPrice = b.convPrice;
          if (!cb.conversionPeriod && b.convStart && b.convEnd)
            cb.conversionPeriod = b.convStart + '~' + b.convEnd;
          if (!cb.maturityDate && b.maturityDate) cb.maturityDate = b.maturityDate;
          if (!cb.nextPutDate && b.nearestPutDate) cb.nextPutDate = b.nearestPutDate;
        }

        // 每日行情
        const d = yr.dailyMarket?.[cbCode];
        if (d) {
          cb.ytp = d.ytp;
          cb.ytm = d.ytm;
          cb.eps = d.eps;
          if (!cb.tcri && d.tcri) cb.tcri = d.tcri;
          if (!cb.guarantee && d.guarantee) cb.guarantee = d.guarantee;
          if (!cb.industry && d.industry) cb.industry = d.industry;
          cb.business = d.business;
        }

        // 流通在外餘額
        const o = yr.outstanding?.[cbCode];
        if (o) {
          cb.balThisWeek = o.thisWeek;
          cb.balLastWeek = o.lastWeek;
          cb.balChange = o.change;
          cb.balRemainPct = o.remainPct;
        }

        // 停止轉換
        const stops = convStopMap.get(cbCode);
        if (stops) cb.conversionStop = stops;
      }
    }
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
  function computeDerivedFields(stock, cbTradingByCode, auctionMap, cbBondInstByCode) {
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

      // 線型T & 第一根表態
      const ohlcv = buildOHLCVArray(stock);
      stock.tPatternDays = calcTPatternDays(ohlcv);
      stock.firstBarSignal = checkFirstBarSignal(ohlcv);
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

      // 轉換價和轉換起始日 (從主CB取)
      if (stock.mainCB) {
        stock.conversionPrice = stock.mainCB.conversionPrice || null;
        stock.conversionPeriod = extractConvStartDate(stock.mainCB.conversionPeriod);
      }

      // 附加競拍資料 (twsa)
      if (auctionMap) {
        for (const cb of stock.cbs) {
          const auction = auctionMap.get(String(cb.cbCode));
          if (auction) cb.auction = auction;
        }
      }
    }

    // === CB三大法人 ===
    if (cbBondInstByCode && stock.mainCB?.cbCode) {
      const cbInstEntry = cbBondInstByCode.stocks[stock.mainCB.cbCode];
      if (cbInstEntry) {
        stock.cbBondInstitutional = cbInstEntry.data;
        stock.cbBondInstitutionalDates = cbBondInstByCode.dates;
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

    // === CB 自身價格走勢 (cbDailyTrading) ===
    if (cbTradingByCode && stock.mainCB?.cbCode) {
      const cbEntry = cbTradingByCode.stocks[stock.mainCB.cbCode];
      if (cbEntry) {
        stock.cbTrading = cbEntry.data;       // { 收盤價:{date:val}, ... }
        stock.cbTradingDates = cbTradingByCode.dates;

        const cbOhlcv = buildCBOHLCVArray(cbEntry.data, cbTradingByCode.dates);
        if (cbOhlcv.length > 0) {
          stock.cbOhlcv = cbOhlcv;
          stock.cbFirstBarSignal = checkFirstBarSignal(cbOhlcv);
          stock.cbHighDays = calcNewHighDays(cbOhlcv);
          const last = cbOhlcv[cbOhlcv.length - 1];
          stock.cbLatestClose = last.close;
        }
      }
    }

    // === 用 cbDailyTrading 當日值覆蓋 cb.close/change/volume/amount ===
    //   原因: cbDailyReport Sheet 由 GAS 14:40 寫入,當日 CB raw CSV 可能還沒抓到
    //   → Sheet 殘留前一交易日 snapshot (見 80212 案例,Sheet 顯示 4/24 的 220,
    //   實際 4/27 收盤是 198)。
    //   cbDailyTrading 是時間序列,日期維度明確,挑最新有交易日的值最可靠。
    //   成交金額: Sheet 用 均價×volume×1000,我們沒 均價 timeseries,以 close 近似。
    if (cbTradingByCode && stock.cbs) {
      const dates = cbTradingByCode.dates;
      for (const cb of stock.cbs) {
        const cbEntry = cbTradingByCode.stocks[cb.cbCode];
        if (!cbEntry) continue;
        const closeMap = cbEntry.data['收盤價'] || {};
        const volMap = cbEntry.data['成交量(張)'] || {};
        // 找最新有實際成交的日期 (close > 0)
        let latestIdx = -1;
        for (let i = dates.length - 1; i >= 0; i--) {
          const c = closeMap[dates[i]];
          if (c != null && c !== 0) { latestIdx = i; break; }
        }
        if (latestIdx < 0) continue;
        const todayClose = closeMap[dates[latestIdx]];
        const todayVolume = volMap[dates[latestIdx]] ?? 0;
        // 前一交易日 close (有真實成交那天)
        let prevClose = null;
        for (let i = latestIdx - 1; i >= 0; i--) {
          const c = closeMap[dates[i]];
          if (c != null && c !== 0) { prevClose = c; break; }
        }
        cb.close = todayClose;
        cb.change = prevClose !== null ? +(todayClose - prevClose).toFixed(2) : 0;
        cb.volume = todayVolume;
        cb.amount = todayClose && todayVolume
          ? Math.round(todayClose * todayVolume * 1000)
          : null;
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

  // === 技術指標：線型T & 第一根表態 ===

  /**
   * 將 stock.trading 物件格式轉換為陣列格式
   * 回傳 [{date, open, high, low, close, volume}, ...]
   * volume 單位: 張 (已除以1000)
   *
   * 處理沒交易日 (close == null 或 0,例如停牌/冷門無成交):
   *   - 若已有前一日 close → 沿用當該日 OHLC,volume=0 (平頂蠟燭)
   *   - 若還沒任何 close → 略過,等第一筆成交再開始
   */
  function buildOHLCVArray(stock) {
    const dates = stock.tradingDates || [];
    if (dates.length === 0) return [];
    const arr = [];
    let prevClose = null;
    for (const d of dates) {
      const close = stock.trading['收盤價']?.[d];
      if (close == null || close === 0) {
        if (prevClose === null) continue;
        arr.push({
          date: d,
          open:  prevClose,
          high:  prevClose,
          low:   prevClose,
          close: prevClose,
          volume: 0
        });
        continue;
      }
      arr.push({
        date: d,
        open:   stock.trading['開盤價']?.[d] ?? close,
        high:   stock.trading['最高價']?.[d] ?? close,
        low:    stock.trading['最低價']?.[d] ?? close,
        close:  close,
        volume: (stock.trading['成交股數']?.[d] ?? 0) / 1000
      });
      prevClose = close;
    }
    return arr;
  }

  /**
   * 將 cbDailyTrading 的 category→{date:val} 結構轉成 OHLCV 陣列
   *
   * 處理沒交易日 (close == null 或 0):
   *   - 若已經有前一日 close → 沿用前一日 close 當該日 OHLC,volume=0 (平頂蠟燭)
   *   - 若還沒有任何 close (全段最初幾日就沒交易) → 略過,等第一筆有交易再開始
   */
  function buildCBOHLCVArray(dataObj, dates) {
    if (!dataObj || !dates || dates.length === 0) return [];
    const arr = [];
    let prevClose = null;
    for (const d of dates) {
      const close = dataObj['收盤價']?.[d];
      if (close == null || close === 0) {
        if (prevClose === null) continue;  // 暖機期,沒前值可沿用
        arr.push({
          date: d,
          open:  prevClose,
          high:  prevClose,
          low:   prevClose,
          close: prevClose,
          volume: 0
        });
        // 注意: prevClose 不更新 (因為今天沒成交)
        continue;
      }
      arr.push({
        date: d,
        open:   dataObj['開盤價']?.[d] ?? close,
        high:   dataObj['最高價']?.[d] ?? close,
        low:    dataObj['最低價']?.[d] ?? close,
        close:  close,
        volume: dataObj['成交量(張)']?.[d] ?? 0
      });
      prevClose = close;
    }
    return arr;
  }

  /**
   * 回傳「今天收盤價創幾日新高」— 今日收盤 >= 過去 N 日(不含今日)最高收盤的最大 N
   * 若今日未創新高回 0
   */
  function calcNewHighDays(data) {
    if (!data || data.length < 2) return 0;
    const idx = data.length - 1;
    const todayClose = data[idx].close;
    let days = 0;
    for (let i = idx - 1; i >= 0; i--) {
      if (data[i].close > todayClose) break;
      days++;
    }
    return days;
  }

  /**
   * 計算線型T連續天數 (從最新日往回數)
   * 條件: 每天 漲跌幅 < 前一天漲跌幅, 最低價 > 前一天最低價, 最高價 <= 前一天最高價
   */
  function calcTPatternDays(data) {
    if (data.length < 3) return 0;
    let count = 0;
    for (let i = data.length - 1; i >= 2; i--) {
      const today = data[i];
      const prev  = data[i - 1];
      const prev2 = data[i - 2];
      // 今日 vs 前一日 的漲跌幅
      const todayChange = prev.close ? ((today.close - prev.close) / prev.close * 100) : 0;
      const prevChange  = prev2.close ? ((prev.close - prev2.close) / prev2.close * 100) : 0;
      if (todayChange < prevChange && today.low > prev.low && today.high <= prev.high) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  // --- 第一根表態 技術指標計算 ---

  function sma(data, period, idx, key) {
    if (idx < period - 1) return 0;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[idx - i][key];
    return sum / period;
  }

  function stdDev(data, period, idx, mean, key) {
    if (idx < period - 1) return 0;
    let sumSq = 0;
    for (let i = 0; i < period; i++) {
      const diff = data[idx - i][key] - mean;
      sumSq += diff * diff;
    }
    return Math.sqrt(sumSq / period);
  }

  function calcKDJ(data, n, m1, m2) {
    const K = [], D = [];
    let kVal = 50, dVal = 50;
    for (let i = 0; i < data.length; i++) {
      if (i < n - 1) { K.push(50); D.push(50); continue; }
      let lowest = data[i].low, highest = data[i].high;
      for (let j = 0; j < n; j++) {
        if (data[i - j].low < lowest) lowest = data[i - j].low;
        if (data[i - j].high > highest) highest = data[i - j].high;
      }
      const rsv = (highest !== lowest) ? (data[i].close - lowest) / (highest - lowest) * 100 : 50;
      kVal = (2 / 3) * kVal + (1 / 3) * rsv;
      dVal = (2 / 3) * dVal + (1 / 3) * kVal;
      K.push(kVal);
      D.push(dVal);
    }
    return { K, D };
  }

  function calcDMI(data, n) {
    const PDI = [], MDI = [];
    let trSmooth = 0, pdmSmooth = 0, mdmSmooth = 0;
    for (let i = 0; i < data.length; i++) {
      if (i === 0) { PDI.push(0); MDI.push(0); continue; }
      const prevClose = data[i - 1].close;
      const prevHigh  = data[i - 1].high;
      const prevLow   = data[i - 1].low;
      const tr = Math.max(data[i].high - data[i].low, Math.abs(data[i].high - prevClose), Math.abs(data[i].low - prevClose));
      const up = data[i].high - prevHigh;
      const down = prevLow - data[i].low;
      const pdm = (up > down && up > 0) ? up : 0;
      const mdm = (down > up && down > 0) ? down : 0;
      if (i < n) {
        trSmooth += tr; pdmSmooth += pdm; mdmSmooth += mdm;
        PDI.push(0); MDI.push(0);
      } else if (i === n) {
        PDI.push(trSmooth ? (pdmSmooth / trSmooth) * 100 : 0);
        MDI.push(trSmooth ? (mdmSmooth / trSmooth) * 100 : 0);
      } else {
        trSmooth  = trSmooth  - (trSmooth  / n) + tr;
        pdmSmooth = pdmSmooth - (pdmSmooth / n) + pdm;
        mdmSmooth = mdmSmooth - (mdmSmooth / n) + mdm;
        PDI.push(trSmooth ? (pdmSmooth / trSmooth) * 100 : 0);
        MDI.push(trSmooth ? (mdmSmooth / trSmooth) * 100 : 0);
      }
    }
    return { PDI, MDI };
  }

  /**
   * 第一根表態 策略判斷
   * 五個維度同時亮燈: 能量(量能爆發) + 動能(KDJ金叉) + 乖離(收斂後發散) + 趨勢(DMI正向) + 壓力(布林突破)
   */
  function checkFirstBarSignal(data) {
    if (data.length < 30) return false;
    const idx = data.length - 1;
    const prev = idx - 1;

    // 1. 能量: volMA2 > volMA20
    const volMA2  = sma(data, 2,  idx, 'volume');
    const volMA20 = sma(data, 20, idx, 'volume');
    if (!(volMA2 > volMA20)) return false;

    // 2. 乖離: 今天 (bias6 - bias3) > 0，昨天 <= 0
    const ma3     = sma(data, 3, idx,  'close');
    const ma6     = sma(data, 6, idx,  'close');
    const bias3   = (data[idx].close - ma3) / ma3 * 100;
    const bias6   = (data[idx].close - ma6) / ma6 * 100;
    const prevMa3 = sma(data, 3, prev, 'close');
    const prevMa6 = sma(data, 6, prev, 'close');
    const prevBias3 = (data[prev].close - prevMa3) / prevMa3 * 100;
    const prevBias6 = (data[prev].close - prevMa6) / prevMa6 * 100;
    if (!((bias6 - bias3) > 0)) return false;
    if (!((prevBias6 - prevBias3) <= 0)) return false;

    // 3. 動能: KDJ(5,3,3) 金叉 — 今天 K>D, 昨天 K<=D
    const kdj = calcKDJ(data, 5, 3, 3);
    const jToday = 3 * kdj.K[idx] - 2 * kdj.D[idx];
    if (!(kdj.K[idx] > kdj.D[idx])) return false;
    if (!(jToday > kdj.D[idx])) return false;
    if (!(kdj.K[prev] <= kdj.D[prev])) return false;

    // 4. 趨勢: DMI(5) PDI > MDI
    const dmi = calcDMI(data, 5);
    if (!(dmi.PDI[idx] - dmi.MDI[idx] > 0)) return false;

    // 5. 壓力: 布林(7,2) 昨天 high < upper, 今天 close >= upper*0.99
    const bbUpper = [];
    for (let i = 0; i < data.length; i++) {
      const m = sma(data, 7, i, 'close');
      const sd = stdDev(data, 7, i, m, 'close');
      bbUpper.push(m + 2 * sd);
    }
    if (!(data[prev].high < bbUpper[prev])) return false;
    if (!(data[idx].close >= bbUpper[idx] * 0.99)) return false;

    // 6. 最低成交量門檻
    if (data[idx].volume < 500) return false;

    return true;
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

  /**
   * 清掉常見亂碼字 (Unicode replacement char + 末尾管線符號等)
   */
  function cleanName(name) {
    if (!name) return '';
    return String(name).replace(/�/g, '').replace(/[|｜]+$/, '').trim();
  }

  return {
    parseTimeSeries,
    parseCBDailyReport,
    parseFubonPrimary,
    parseYuantaPrimary,
    mergeAllData,
    parseNumber,
    extractStockCode
  };
})();
