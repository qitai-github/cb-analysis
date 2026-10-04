// Google Sheets 資料抓取模組
const SheetsAPI = (() => {
  const cache = new Map();

  /**
   * 從 Google Sheets gviz API 抓取 JSON 資料
   */
  async function fetchWithTimeout(url, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error(`請求超時 (${Math.round(timeoutMs/1000)}秒)`);
      throw err;
    }
  }

  async function fetchSheet(sheetId, gid, range) {
    const cacheKey = `${sheetId}_${gid}_${range || 'all'}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.time < APP_CONFIG.cacheExpiry) {
      return cached.data;
    }

    let url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
    if (range) url += `&range=${range}`;

    const response = await fetchWithTimeout(url);
    const text = await response.text();

    const jsonStr = text.match(/google\.visualization\.Query\.setResponse\((.+)\);?$/s);
    if (!jsonStr) throw new Error(`無法解析回應: ${sheetId}`);

    const json = JSON.parse(jsonStr[1]);
    if (json.status === 'error') {
      throw new Error(`Sheets 錯誤: ${json.errors?.[0]?.message}`);
    }

    const data = parseGvizTable(json.table);
    cache.set(cacheKey, { data, time: Date.now() });
    return data;
  }

  /**
   * 解析 gviz table JSON
   */
  function parseGvizTable(table) {
    const result = [];

    if (table.cols?.length > 0) {
      const headers = table.cols.map(col => col.label || '');
      if (headers.some(h => h !== '')) {
        result.push(headers);
      }
    }

    if (table.rows) {
      for (const row of table.rows) {
        const cells = row.c.map(cell => {
          if (!cell) return '';
          if (cell.f !== undefined && cell.f !== null) return cell.f;
          if (cell.v !== undefined && cell.v !== null) return String(cell.v);
          return '';
        });
        result.push(cells);
      }
    }

    return result;
  }

  /**
   * 從 Google Apps Script 取得 CB 發行資訊
   */
  async function fetchCBIssuance() {
    if (!APPS_SCRIPT_URL) {
      console.warn('未設定 APPS_SCRIPT_URL，跳過 CB 發行資訊載入');
      return null;
    }

    const cacheKey = 'cb_issuance_all';
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.time < APP_CONFIG.cacheExpiry) {
      return cached.data;
    }

    try {
      const response = await fetch(APPS_SCRIPT_URL);
      const json = await response.json();
      if (json.status === 'ok') {
        cache.set(cacheKey, { data: json.data, time: Date.now() });
        return json.data;
      }
      console.error('CB發行資訊 API 錯誤:', json.message);
      return null;
    } catch (err) {
      console.error('CB發行資訊載入失敗:', err);
      return null;
    }
  }

  /**
   * 統一 API：一次請求取得所有資料 (Apps Script ?mode=all)
   */
  async function fetchUnifiedAPI() {
    if (!APPS_SCRIPT_URL) throw new Error('未設定 APPS_SCRIPT_URL');
    const url = APPS_SCRIPT_URL + '?mode=all';
    const response = await fetchWithTimeout(url, 90000);
    const json = await response.json();
    if (json.status !== 'ok') throw new Error(json.message || 'API 錯誤');
    return json.data;
  }

  /**
   * 批次載入所有資料來源
   * 優先使用統一 API (1 次請求)，失敗則 fallback 到 gviz (6 次請求)
   */
  async function loadAll(onProgress) {
    // === 最優先：靜態 JSON 檔案 ===
    if (typeof STATIC_DATA_URL !== 'undefined' && STATIC_DATA_URL) {
      try {
        if (onProgress) onProgress(0, 1, '載入資料中...');
        const resp = await fetchWithTimeout(STATIC_DATA_URL, 15000);
        const data = await resp.json();
        if (data && Object.keys(data).length > 1) {
          data._errors = [];
          // 附加資料真正併發載入 — 各自失敗不影響主流程
          const loadJson = async (key, url, timeout) => {
            try {
              const r = await fetchWithTimeout(url, timeout);
              data[key] = await r.json();
            } catch (e) {
              console.warn(`[loadAll] ${url} 載入失敗:`, e.message);
            }
          };
          // 靜態 JSON 可能尚未包含此 key 時才改走 Google Sheets
          const loadSheet = async (key) => {
            if (data[key]) return;
            try {
              const s = DATA_SOURCES[key];
              data[key] = await fetchSheet(s.sheetId, s.gid);
            } catch (e) {
              console.warn(`[loadAll] ${key} 載入失敗:`, e.message);
            }
          };
          await Promise.all([
            loadJson('twsaAuction', 'data/twsa.json', 10000),
            loadSheet('stockIndustry'),
            loadJson('mopsNews', 'data/mops_news.json', 10000),
            loadJson('stockCapital', 'data/stock_capital.json', 10000),
            loadJson('shareholding', 'data/shareholding.json', 20000),
            loadJson('companyReports', 'data/company_reports.json', 10000),
          ]);
          if (onProgress) onProgress(1, 1, '完成');
          console.log('[loadAll] 靜態JSON載入成功');
          return data;
        }
      } catch (err) {
        console.warn('[loadAll] 靜態JSON失敗，改用統一API:', err.message);
      }
    }

    // === 次優先：統一 API ===
    try {
      if (onProgress) onProgress(0, 1, '統一API載入中...');
      const data = await fetchUnifiedAPI();
      data._errors = [];
      if (onProgress) onProgress(1, 1, '完成');
      console.log('[loadAll] 統一API載入成功');
      return data;
    } catch (err) {
      console.warn('[loadAll] 統一API失敗，改用 gviz:', err.message);
    }

    // === Fallback：gviz 逐一載入 ===
    const sources = Object.entries(DATA_SOURCES);
    const results = {};
    const errors = [];
    let loaded = 0;
    const total = sources.length + 1;

    const promises = sources.map(async ([key, source]) => {
      try {
        const data = await fetchSheet(source.sheetId, source.gid);
        results[key] = data;
      } catch (err) {
        console.error(`載入 ${source.name} 失敗:`, err);
        errors.push(source.name);
        results[key] = null;
      }
      loaded++;
      if (onProgress) onProgress(loaded, total, source.name);
    });

    const issuancePromise = (async () => {
      try {
        results.cbIssuance = await fetchCBIssuance();
      } catch (err) {
        console.error('CB發行資訊載入失敗:', err);
        results.cbIssuance = null;
      }
      loaded++;
      if (onProgress) onProgress(loaded, total, 'CB發行資訊');
    })();

    await Promise.all([...promises, issuancePromise]);
    results._errors = errors;
    return results;
  }

  /**
   * 一般新聞改成開詳情才載入:優先 data/stock_news.json,沒有就退回 Google Sheet。
   */
  async function fetchStockNews() {
    try {
      const r = await fetchWithTimeout('data/stock_news.json', 20000);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const rows = await r.json();
      if (Array.isArray(rows)) return rows;
    } catch (e) {
      console.warn('[fetchStockNews] stock_news.json 失敗,改用 Sheet:', e.message);
    }
    const src = DATA_SOURCES.stockNews;
    return fetchSheet(src.sheetId, src.gid);
  }

  function clearCache() {
    cache.clear();
  }

  // === localStorage 持久快取 ===
  const STORAGE_KEY = 'cb_data_cache';
  const STORAGE_EXPIRY = 60 * 60 * 1000; // 1 小時過期

  // 整包資料序列化後約 20MB,遠超 localStorage 約 5MB 上限,寫入必定失敗卻白花主執行緒時間,
  // 故不再寫入;僅清掉舊版殘留 key。自選清單 (cb_watchlist_v2) 是獨立 key,不受影響。
  function saveToStorage() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const payload = JSON.parse(raw);
      if (Date.now() - payload.time > STORAGE_EXPIRY) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  function clearStorage() {
    localStorage.removeItem(STORAGE_KEY);
  }

  return { fetchSheet, fetchCBIssuance, fetchStockNews, loadAll, clearCache, saveToStorage, loadFromStorage, clearStorage };
})();
