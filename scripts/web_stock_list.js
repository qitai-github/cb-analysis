// 輸出網頁「個股清單」的股票代號 (JSON 陣列)。直接載入前端 js/dataProcessor.js 跑
// mergeAllData,所以和網頁看到的標的完全一致 (含「無 CB 剔除」規則)。
// 用法: node scripts/web_stock_list.js  → stdout
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
for (const f of ['config.js', 'dataProcessor.js']) {
  // const 宣告不會掛到 context,改成 var 以便取用
  const src = fs.readFileSync(path.join(root, 'js', f), 'utf8').replace(/^const (APP_CONFIG|DataProcessor)\b/m, 'var $1');
  vm.runInContext(src, ctx, { filename: f });
}
const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'all-data.json'), 'utf8'));
const { stockMap } = vm.runInContext('DataProcessor', ctx).mergeAllData(raw);
process.stdout.write(JSON.stringify([...stockMap.keys()].filter(c => /^\d{4,6}[A-Z]?$/.test(c)).sort()));
