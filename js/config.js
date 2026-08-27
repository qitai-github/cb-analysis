// 投資重點一頁式儀表板（外部站台,iframe 內嵌 / 連結用）
// 換股票時不用改這裡,程式會自動接上當前股票代號 → .../companies/<code>/
const INVEST_DASHBOARD_BASE = 'https://investing.0099914.xyz/companies/';

// Supabase 設定（公用追蹤清單）
const SUPABASE_URL = 'https://rfdsmmrhesysqsqmwbnu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmZHNtbXJoZXN5c3FzcW13Ym51Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxMjI1OTMsImV4cCI6MjA5MjY5ODU5M30.X-9D4Um5LnXHmYW14WPBI4WThfVlicJpMWelEmqM6_I';

// Google Sheets 資料來源設定
const DATA_SOURCES = {
  // 1. CB法人資料 - 三大法人每日買賣超 (時間序列)
  cbInstitutional: {
    sheetId: '1oulqms1FJo4QYzgP4UQyABjFfHpguiBq4a2p6AWJHaU',
    gid: '1046567092',
    name: 'CB法人資料',
    type: 'timeseries',
    categories: ['外資買賣超', '投信買賣超', '自營商買賣超']
  },

  // 2. CB對應個股每日交易明細 - 股價量資料 (時間序列)
  stockTrading: {
    sheetId: '1yijLlFRR_RiUEBQ6zzGuP9Wj4wSIHwbYD3tz-L0hFy0',
    gid: '749753136',
    name: 'CB對應個股每日交易明細',
    type: 'timeseries',
    categories: ['成交股數', '開盤價', '最高價', '最低價', '收盤價']
  },

  // 6. CB每日交易明細 (CB 自身的成交/收盤價)
  cbDailyTrading: {
    sheetId: '1RBdEvyRSE55paVWRjV4-MG3l2m4bPtUjyqpnHKVppbo',
    gid: '1832010025',
    name: 'CB每日交易明細',
    type: 'timeseries'
  },

  // 7. CB三大法人 (CB 本身的法人買賣超 timeseries)
  cbBondInstitutional: {
    sheetId: '1fVmPcxRP3izWYMuhI1y2pPObr0DJ_CetUUeCfWp4OiA',
    gid: '2077160446',
    name: 'CB三大法人',
    type: 'timeseries',
    categories: ['外資買賣超', '投信買賣超', '自營商買賣超']
  },

  // 3. CB交易日報 - CB即時交易資訊
  cbDailyReport: {
    sheetId: '1kAExOpabAvR2gsbTyNoM_oGWSZXHkiFm_60FH_6DTbw',
    gid: '803170134',
    name: 'CB交易日報',
    type: 'table'
  },

  // 4. 富邦證券CB初級市場資訊
  fubonPrimary: {
    sheetId: '1kAExOpabAvR2gsbTyNoM_oGWSZXHkiFm_60FH_6DTbw',
    gid: '953953291',
    name: '富邦CB初級市場',
    type: 'table'
  },

  // 5. 元大證債券部CB初級案件彙整表
  yuantaPrimary: {
    sheetId: '1kAExOpabAvR2gsbTyNoM_oGWSZXHkiFm_60FH_6DTbw',
    gid: '1557790812',
    name: '元大CB初級案件',
    type: 'table'
  },

  // 8. 台股公司主檔 (代碼/股名/公司名/產業分類1/產業分類2/產品組合...)
  stockIndustry: {
    sheetId: '1JdhzgbEWFlJwYA_7WYxhQxYIV2gadvXfK4-zv0timvA',
    gid: '699020116',
    name: '台股公司主檔',
    type: 'table'
  },

  // 9. 新聞資訊 (時間/股票名稱/標題/連結)
  stockNews: {
    sheetId: '1kAExOpabAvR2gsbTyNoM_oGWSZXHkiFm_60FH_6DTbw',
    gid: '1094399736',
    name: '新聞資訊',
    type: 'table'
  }
};

// Google Apps Script 部署 URL (CB發行資訊彙整API)
// 部署 google_apps_script.js 後將網址貼在這裡
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyvdzJSF9bda934pUnjsbpMB-InFeoBfnVEWtbLFttve97q25sIjywdWVe7O2EVh9pK/exec';

// 靜態 JSON 資料路徑（由 GAS exportToGitHub 每日更新）
const STATIC_DATA_URL = 'data/all-data.json';

// 應用程式設定
const APP_CONFIG = {
  defaultRecentDays: 20,
  techAnalysisDays: 60,
  institutionalAccumDays: [1, 3, 5, 10, 20, 60, 120, 360],
  cacheExpiry: 15 * 60 * 1000,
  pageSize: 50,
  colors: {
    up: '#ef4444',
    down: '#22c55e',
    neutral: '#9ca3af',
    bg: '#0f172a',
    bgCard: '#1e293b',
    bgHover: '#334155',
    border: '#475569',
    text: '#e2e8f0',
    textMuted: '#94a3b8',
    accent: '#3b82f6'
  }
};

// ── 技術分析 modal 的時間視窗 ────────────────────────────────────────
// techAnalysisDays   視窗長度 (滑鼠滾輪縮放, 20~240)
// techAnalysisOffset 視窗右緣距離最新一筆的根數 (0 = 貼齊最新, 越大越往左看歷史)
//
// 個股 K / CB K / 法人 / 資券 所有 sub-chart 都吃同一組參數,
// 一律用 techSlice() 取窗,避免各處 slice(-days) 各自為政。
APP_CONFIG.techAnalysisOffset = 0;

/** 依目前的視窗長度 + 左右位移取出陣列片段 (arr 需為由舊到新排序) */
function techSlice(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const days = APP_CONFIG.techAnalysisDays;
  const off = Math.max(0, Math.min(APP_CONFIG.techAnalysisOffset || 0,
                                   Math.max(0, arr.length - days)));
  const end = arr.length - off;
  return arr.slice(Math.max(0, end - days), end);
}

/** offset 的合法上限 (資料長度 - 視窗長度),不足一個視窗就是 0 */
function techMaxOffset(len) {
  return Math.max(0, (len || 0) - APP_CONFIG.techAnalysisDays);
}

// ── 集保股權分散表 (大戶明細) ────────────────────────────────────────
// data/shareholding.json 的 15 個持股分級,單位「張」(1 張 = 1000 股)。
// hiLots = null 代表無上限。順序必須與 JSON 的 ratio / people 陣列一致
// (build_shareholding.py 的 LEVELS)。
const HOLDER_LEVELS = [
  { n: 1,  label: '1-999 股',   loLots: 0,    hiLots: 1 },
  { n: 2,  label: '1-5 張',     loLots: 1,    hiLots: 5 },
  { n: 3,  label: '5-10 張',    loLots: 5,    hiLots: 10 },
  { n: 4,  label: '10-15 張',   loLots: 10,   hiLots: 15 },
  { n: 5,  label: '15-20 張',   loLots: 15,   hiLots: 20 },
  { n: 6,  label: '20-30 張',   loLots: 20,   hiLots: 30 },
  { n: 7,  label: '30-40 張',   loLots: 30,   hiLots: 40 },
  { n: 8,  label: '40-50 張',   loLots: 40,   hiLots: 50 },
  { n: 9,  label: '50-100 張',  loLots: 50,   hiLots: 100 },
  { n: 10, label: '100-200 張', loLots: 100,  hiLots: 200 },
  { n: 11, label: '200-400 張', loLots: 200,  hiLots: 400 },
  { n: 12, label: '400-600 張', loLots: 400,  hiLots: 600 },
  { n: 13, label: '600-800 張', loLots: 600,  hiLots: 800 },
  { n: 14, label: '800-1000 張',loLots: 800,  hiLots: 1000 },
  { n: 15, label: '1000 張以上',loLots: 1000, hiLots: null }
];

// 大戶 / 散戶門檻選項 (必須落在級距邊界上,否則切不乾淨)
const HOLDER_BIG_THRESHOLDS = [200, 400, 600, 800, 1000];
const HOLDER_SMALL_THRESHOLDS = [10, 50, 100, 200, 400];

// 目前選的門檻 (大戶 > N 張 / 散戶 < N 張),兩個 modal 共用
APP_CONFIG.holderBigLots = 1000;
APP_CONFIG.holderSmallLots = 50;   // 分級 1-9 (集保定義的散戶)
// 大戶明細顯示幾週 (集保每週一筆)
APP_CONFIG.holderWeeks = 52;

/** 大戶 = loLots >= N 的級距 index;散戶 = hiLots <= N 的級距 index */
function holderBigIdx(lots) {
  return HOLDER_LEVELS.map((l, i) => [l, i]).filter(([l]) => l.loLots >= lots).map(([, i]) => i);
}
function holderSmallIdx(lots) {
  return HOLDER_LEVELS.map((l, i) => [l, i])
    .filter(([l]) => l.hiLots != null && l.hiLots <= lots).map(([, i]) => i);
}
