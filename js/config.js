// Google Sheets 資料來源設定
const DATA_SOURCES = {
  // 1. CB法人資料 - 三大法人每日買賣超 (時間序列)
  cbInstitutional: {
    sheetId: '1oulqms1FJo4QYzgP4UQyABjFfHpguiBq4a2p6AWJHaU',
    gid: '450965581',
    name: 'CB法人資料',
    type: 'timeseries',
    categories: ['外資買賣超', '投信買賣超', '自營商買賣超']
  },

  // 2. CB對應個股每日交易明細 - 股價量資料 (時間序列)
  stockTrading: {
    sheetId: '1yijLlFRR_RiUEBQ6zzGuP9Wj4wSIHwbYD3tz-L0hFy0',
    gid: '656366568',
    name: 'CB對應個股每日交易明細',
    type: 'timeseries',
    categories: ['成交股數', '開盤價', '最高價', '最低價', '收盤價']
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
