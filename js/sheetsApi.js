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
          // 併發載入 twsa 競拍資料 (靜態 JSON，失敗不影響主流程)
          try {
            const twsaResp = await fetchWithTimeout('data/twsa.json', 10000);
            data.twsaAuction = await twsaResp.json();
          } catch (e) {
            console.warn('[loadAll] twsa.json 載入失敗:', e.message);
          }
          // 併發載入台股公司主檔 (產業分類) — 靜態 JSON 可能尚未包含此 key
          if (!data.stockIndustry) {
            try {
              const s = DATA_SOURCES.stockIndustry;
              data.stockIndustry = await fetchSheet(s.sheetId, s.gid);
            } catch (e) {
              console.warn('[loadAll] stockIndustry 載入失敗:', e.message);
            }
          }
          // 併發載入新聞資訊 — 靜態 JSON 可能尚未包含此 key
          if (!data.stockNews) {
            try {
              const s = DATA_SOURCES.stockNews;
              data.stockNews = await fetchSheet(s.sheetId, s.gid);
            } catch (e) {
              console.warn('[loadAll] stockNews 載入失敗:', e.message);
            }
          }
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

  function clearCache() {
    cache.clear();
  }

  // === localStorage 持久快取 ===
  const STORAGE_KEY = 'cb_data_cache';
  const STORAGE_EXPIRY = 60 * 60 * 1000; // 1 小時過期

  function saveToStorage(rawResults) {
    try {
      const payload = {
        data: rawResults,
        time: Date.now()
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      // localStorage 滿了就忽略
      console.warn('localStorage 儲存失敗:', e);
    }
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

  return { fetchSheet, fetchCBIssuance, loadAll, clearCache, saveToStorage, loadFromStorage, clearStorage };
})();
