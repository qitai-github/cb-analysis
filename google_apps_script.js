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
  cbInstitutional: { sheetId: '1oulqms1FJo4QYzgP4UQyABjFfHpguiBq4a2p6AWJHaU', gid: 1046567092 },
  stockTrading:    { sheetId: '1yijLlFRR_RiUEBQ6zzGuP9Wj4wSIHwbYD3tz-L0hFy0', gid: 749753136 },
  cbDailyReport:   { sheetId: '1kAExOpabAvR2gsbTyNoM_oGWSZXHkiFm_60FH_6DTbw', gid: 803170134 },
  fubonPrimary:    { sheetId: '1kAExOpabAvR2gsbTyNoM_oGWSZXHkiFm_60FH_6DTbw', gid: 953953291 },
  yuantaPrimary:   { sheetId: '1kAExOpabAvR2gsbTyNoM_oGWSZXHkiFm_60FH_6DTbw', gid: 1557790812 },
  cbDailyTrading:  { sheetId: '1RBdEvyRSE55paVWRjV4-MG3l2m4bPtUjyqpnHKVppbo', gid: 1832010025 },
  cbBondInstitutional: { sheetId: '1fVmPcxRP3izWYMuhI1y2pPObr0DJ_CetUUeCfWp4OiA', gid: 2077160446 },
  stockIndustry:   { sheetId: '1JdhzgbEWFlJwYA_7WYxhQxYIV2gadvXfK4-zv0timvA', gid: 699020116 },
  stockNews:       { sheetId: '1kAExOpabAvR2gsbTyNoM_oGWSZXHkiFm_60FH_6DTbw', gid: 1094399736 }
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
 * 一次性讀取 A1:D10 區塊 (提升 6 倍效能，避免超時)
 */
function getAllCBIssuanceInfo() {
  const ss = SpreadsheetApp.openById(ISSUANCE_SHEET_ID);
  const sheets = ss.getSheets();
  const results = [];

  for (const sheet of sheets) {
    try {
      const name = sheet.getName();
      // 一次性讀取 A1:D10 區塊 (提升 6 倍效能)
      const values = sheet.getRange('A1:D10').getValues();

      // --- 嚴格對位區 ---
      const a1 = values[0][0];  // A1: 標題
      const b2 = values[1][1];  // B2: 網址 (含 bond_id)
      const d7 = values[6][3];  // D7: 發行時轉(交)換價格
      const d8 = values[7][3];  // D8: 轉(交)換期間
      const d9 = values[8][3];  // D9: 最新轉(交)換價格
      const d10 = values[9][3]; // D10: 下一次賣回權日期
      const a8 = values[7][0];  // A8: 到期日期
      // -----------------

      // 1. 取得 Bond ID
      const bondIdMatch = String(b2).match(/bond_id=(\d+)/);
      const bondId = bondIdMatch ? bondIdMatch[1] : '';

      // 2. 解析價格 (通用數字抓取 Regex)
      const extractPrice = (val) => {
        if (!val) return null;
        const match = String(val).replace(/,/g, '').match(/([\d]+\.?\d*)/);
        return match ? parseFloat(match[1]) : null;
      };

      const issueConvPrice = extractPrice(d7); // 發行價格
      const convPrice = extractPrice(d9);      // 最新價格

      // 3. 解析期間 (移除前綴)
      const convPeriod = String(d8).replace(/轉\(交\)換期間[：:]\s*/, '').trim();

      // 4. 解析日期 (抓取 yyy/mm/dd 格式)
      const extractDate = (val) => {
        const match = String(val).match(/(\d{2,3}\/\d{2}\/\d{2})/);
        return match ? match[1] : '';
      };

      const maturityDate = extractDate(a8);  // 到期日
      const nextPutDate = extractDate(d10);  // 賣回日

      results.push({
        cbCode: bondId,
        stockCode: bondId ? bondId.substring(0, 4) : '',
        sheetName: name,
        title: String(a1),
        conversionPeriod: convPeriod,
        conversionPrice: convPrice,
        issueConversionPrice: issueConvPrice,
        maturityDate,
        nextPutDate
      });
    } catch (e) {
      // 遇到異常的分頁跳過，不中斷整體執行
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

// === GitHub 靜態 JSON 匯出 ===
// Token 存放在 Script Properties 中（不可寫在程式碼裡）
// 設定方式：Apps Script 編輯器 → 專案設定(齒輪) → 指令碼屬性 → 新增
//   屬性名稱: GITHUB_TOKEN    值: 你的 GitHub Personal Access Token
const GITHUB_OWNER = 'qitai-github';
const GITHUB_REPO = 'cb-analysis';
const GITHUB_FILE_PATH = 'data/all-data.json';

/**
 * 將所有資料匯出為 JSON 並推送到 GitHub
 *
 * 設定定時觸發：
 * 1. 觸發條件 → + 新增觸發條件
 * 2. 選擇函式：exportToGitHub
 * 3. 事件來源：時間驅動
 * 4. 類型：每日計時器 → 下午 7 點到 8 點
 */
function exportToGitHub() {
  Logger.log('[exportToGitHub] 開始匯出...');
  const startTime = new Date().getTime();

  const scriptProps = PropertiesService.getScriptProperties();
  const GITHUB_TOKEN = scriptProps.getProperty('GITHUB_TOKEN');

  if (!GITHUB_TOKEN) {
    Logger.log('[exportToGitHub] 錯誤：未設定 GITHUB_TOKEN');
    return;
  }

  // 優先從快取取得資料，避免在匯出時又觸發昂貴的 Sheets 讀取
  const data = getAllDataCached();
  const jsonStr = JSON.stringify(data);

  // 檢查資料是否為空（防止覆蓋錯誤）
  if (!data || Object.keys(data).length === 0) {
    Logger.log('[exportToGitHub] 錯誤：抓取到的資料為空，停止匯出');
    return;
  }

  const contentB64 = Utilities.base64Encode(Utilities.newBlob(jsonStr).getBytes());

  // 1. 取得現有檔案的 SHA
  let sha = '';
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;

  try {
    const getResp = UrlFetchApp.fetch(apiUrl, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + GITHUB_TOKEN },
      muteHttpExceptions: true
    });
    if (getResp.getResponseCode() === 200) {
      sha = JSON.parse(getResp.getContentText()).sha;
    }
  } catch (e) {
    Logger.log('[exportToGitHub] 取得 SHA 失敗: ' + e.message);
  }

  // 2. 推送到 GitHub
  const payload = {
    message: 'Update Data: ' + Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm'),
    content: contentB64
  };
  if (sha) payload.sha = sha;

  const putResp = UrlFetchApp.fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = putResp.getResponseCode();
  const elapsed = (new Date().getTime() - startTime) / 1000;
  Logger.log(`[exportToGitHub] 完成，狀態碼: ${code}，耗時: ${elapsed} 秒`);
}
