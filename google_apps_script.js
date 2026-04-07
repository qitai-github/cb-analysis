/**
 * Google Apps Script - CB 可轉債分析平台 統一 API
 *
 * 部署步驟：
 * 1. 前往 https://script.google.com/ 建立新專案
 * 2. 將此程式碼貼上
 * 3. 點選「部署」→「新增部署作業」
 * 4. 類型選「網頁應用程式」
 * 5. 執行身份：「我」
 * 6. 存取權限：「所有人」
 * 7. 部署後取得網址，貼到 config.js 的 APPS_SCRIPT_URL
 *
 * API 用法：
 *   ?mode=all      → 回傳所有資料（5張表 + CB發行資訊），前端只需 1 次請求
 *   ?mode=issuance → 僅回傳 CB 發行資訊（預設，向下相容）
 *   ?mode=flush    → 清除伺服器快取，強制重新讀取
 */

const ISSUANCE_SHEET_ID = '1-9O7y6LCc7mMaM_QBZCeywj8q96EOXFr3PigERJXZJU';

// 所有資料來源 (對應 config.js 的 DATA_SOURCES)
const SHEET_SOURCES = {
  cbInstitutional: { sheetId: '1oulqms1FJo4QYzgP4UQyABjFfHpguiBq4a2p6AWJHaU', gid: 450965581 },
  stockTrading:    { sheetId: '1yijLlFRR_RiUEBQ6zzGuP9Wj4wSIHwbYD3tz-L0hFy0', gid: 656366568 },
  cbDailyReport:   { sheetId: '1pZL7SHhojT2FtB00cDWyZ1b7HSPhQF5Nkf4oIaTTNqc', gid: 1519719436 },
  fubonPrimary:    { sheetId: '1kAExOpabAvR2gsbTyNoM_oGWSZXHkiFm_60FH_6DTbw', gid: 953953291 },
  yuantaPrimary:   { sheetId: '1kAExOpabAvR2gsbTyNoM_oGWSZXHkiFm_60FH_6DTbw', gid: 1557790812 }
};

// === 伺服器端快取設定 ===
const SERVER_CACHE_TTL = 21600; // 6 小時 (秒) — CacheService 最大值
const CACHE_KEY_PREFIX = 'cb_api_';

function doGet(e) {
  const mode = (e && e.parameter && e.parameter.mode) || 'issuance';

  try {
    let data;

    if (mode === 'flush') {
      flushServerCache();
      return jsonResponse({ status: 'ok', message: 'cache cleared' });
    }

    if (mode === 'all') {
      data = getAllDataCached();
    } else {
      data = getAllCBIssuanceInfo();
    }

    return jsonResponse({ status: 'ok', data, timestamp: new Date().toISOString() });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// === 伺服器快取邏輯 ===

/**
 * 帶快取的 getAllData
 * CacheService 單一 key 上限 100KB，資料大時需分塊儲存
 */
function getAllDataCached() {
  const cache = CacheService.getScriptCache();

  // 嘗試從快取讀取
  const meta = cache.get(CACHE_KEY_PREFIX + 'meta');
  if (meta) {
    try {
      const { chunks } = JSON.parse(meta);
      const keys = [];
      for (let i = 0; i < chunks; i++) {
        keys.push(CACHE_KEY_PREFIX + 'chunk_' + i);
      }
      const parts = cache.getAll(keys);
      // 確認所有 chunk 都在
      if (Object.keys(parts).length === chunks) {
        let jsonStr = '';
        for (let i = 0; i < chunks; i++) {
          jsonStr += parts[CACHE_KEY_PREFIX + 'chunk_' + i];
        }
        return JSON.parse(jsonStr);
      }
    } catch (e) {
      Logger.log('快取讀取失敗，重新載入: ' + e.message);
    }
  }

  // 快取未命中，從 Sheets 讀取
  const data = getAllData();

  // 寫入快取 (分塊，每塊 90KB 以內)
  try {
    const jsonStr = JSON.stringify(data);
    const CHUNK_SIZE = 90000; // 90KB per chunk (留餘量)
    const chunks = Math.ceil(jsonStr.length / CHUNK_SIZE);
    const cacheEntries = {};

    for (let i = 0; i < chunks; i++) {
      cacheEntries[CACHE_KEY_PREFIX + 'chunk_' + i] = jsonStr.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    }

    cache.putAll(cacheEntries, SERVER_CACHE_TTL);
    cache.put(CACHE_KEY_PREFIX + 'meta', JSON.stringify({ chunks, time: new Date().toISOString() }), SERVER_CACHE_TTL);
  } catch (e) {
    Logger.log('快取寫入失敗: ' + e.message);
  }

  return data;
}

function flushServerCache() {
  const cache = CacheService.getScriptCache();
  // 清除所有已知的 chunk keys
  const keysToRemove = [CACHE_KEY_PREFIX + 'meta'];
  for (let i = 0; i < 20; i++) {
    keysToRemove.push(CACHE_KEY_PREFIX + 'chunk_' + i);
  }
  cache.removeAll(keysToRemove);
}

/**
 * 統一 API：一次讀取所有資料來源
 * 回傳格式與前端 loadAll() 的 results 相同
 */
function getAllData() {
  const result = {};

  for (const [key, source] of Object.entries(SHEET_SOURCES)) {
    try {
      result[key] = readSheetByGid(source.sheetId, source.gid);
    } catch (err) {
      Logger.log('讀取 ' + key + ' 失敗: ' + err.message);
      result[key] = null;
    }
  }

  // CB 發行資訊
  try {
    result.cbIssuance = getAllCBIssuanceInfo();
  } catch (err) {
    Logger.log('讀取 CB 發行資訊失敗: ' + err.message);
    result.cbIssuance = null;
  }

  return result;
}

/**
 * 依 spreadsheetId + gid 讀取整張工作表
 * 回傳 2D 字串陣列 (與 gviz parseGvizTable 格式相容)
 */
function readSheetByGid(spreadsheetId, gid) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheets = ss.getSheets();
  for (const sheet of sheets) {
    if (sheet.getSheetId() == gid) {
      return sheet.getDataRange().getDisplayValues();
    }
  }
  return [];
}

/**
 * CB 發行資訊 (從個別分頁讀取關鍵欄位)
 */
function getAllCBIssuanceInfo() {
  const ss = SpreadsheetApp.openById(ISSUANCE_SHEET_ID);
  const sheets = ss.getSheets();
  const results = [];

  for (const sheet of sheets) {
    try {
      const name = sheet.getName();

      const a1 = sheet.getRange('A1').getValue();
      const d7 = sheet.getRange('D7').getValue();
      const d8 = sheet.getRange('D8').getValue();
      const d9 = sheet.getRange('D9').getValue();
      const a8 = sheet.getRange('A8').getValue();
      const d6 = sheet.getRange('D6').getValue();
      const d10 = sheet.getRange('D10').getValue();
      const b2 = sheet.getRange('B2').getValue();

      const bondIdMatch = String(b2).match(/bond_id=(\d+)/);
      const bondId = bondIdMatch ? bondIdMatch[1] : '';

      let convPeriod = '';
      const d8Str = String(d8);
      const d7Str = String(d7);
      if (d8Str.includes('轉') && d8Str.includes('期間')) {
        convPeriod = d8Str.replace(/轉\(交\)換期間[：:]\s*/, '');
      } else if (d7Str.includes('轉') && d7Str.includes('期間')) {
        convPeriod = d7Str.replace(/轉\(交\)換期間[：:]\s*/, '');
      }

      let convPrice = null;
      const d9Str = String(d9);
      if (d9Str.includes('轉') && d9Str.includes('價格')) {
        const priceMatch = d9Str.match(/([\d,]+\.?\d*)\s*元/);
        if (priceMatch) convPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
      }

      let issueConvPrice = null;
      const d6Str = String(d6);
      const issuePriceMatch = d6Str.match(/([\d,]+\.?\d*)\s*元/);
      if (issuePriceMatch) issueConvPrice = parseFloat(issuePriceMatch[1].replace(/,/g, ''));

      let maturityDate = '';
      const a8Str = String(a8);
      const maturityMatch = a8Str.match(/(\d{2,3}\/\d{2}\/\d{2})/);
      if (maturityMatch) maturityDate = maturityMatch[1];

      let nextPutDate = '';
      const d10Str = String(d10);
      const putDateMatch = d10Str.match(/(\d{2,3}\/\d{2}\/\d{2})/);
      if (putDateMatch) nextPutDate = putDateMatch[1];

      const stockCode = bondId ? bondId.substring(0, 4) : '';

      results.push({
        cbCode: bondId,
        stockCode,
        sheetName: name,
        title: String(a1),
        conversionPeriod: convPeriod,
        conversionPrice: convPrice,
        issueConversionPrice: issueConvPrice,
        maturityDate,
        nextPutDate
      });
    } catch (e) {
      continue;
    }
  }

  return results;
}

// 測試用
function testRun() {
  const data = getAllCBIssuanceInfo();
  Logger.log(JSON.stringify(data.slice(0, 3), null, 2));
  Logger.log('Total sheets: ' + data.length);
}

function testAllData() {
  const data = getAllData();
  for (const [key, val] of Object.entries(data)) {
    if (Array.isArray(val)) {
      Logger.log(key + ': ' + val.length + ' rows');
    } else if (val && typeof val === 'object') {
      Logger.log(key + ': object with ' + Object.keys(val).length + ' keys');
    }
  }
}

/**
 * 定時暖機：每小時自動刷新快取，確保使用者永遠不會碰到冷啟動
 *
 * 設定步驟：
 * 1. 在 Apps Script 編輯器，點左側「觸發條件」（鬧鐘圖示）
 * 2. 點「+ 新增觸發條件」
 * 3. 選擇函式：warmUpCache
 * 4. 事件來源：時間驅動
 * 5. 類型：每小時 (或每 30 分鐘 更佳)
 * 6. 儲存
 */
function warmUpCache() {
  Logger.log('[warmUp] 開始刷新快取...');
  const startTime = new Date().getTime();
  flushServerCache();
  getAllDataCached();
  const elapsed = (new Date().getTime() - startTime) / 1000;
  Logger.log('[warmUp] 快取刷新完成，耗時 ' + elapsed + ' 秒');
}
