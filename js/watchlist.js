// 追蹤標的 (星號) 模組 — localStorage 持久化
const Watchlist = (() => {
  const STORAGE_KEY = 'cb_watchlist';
  let watchSet = new Set();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) watchSet = new Set(JSON.parse(raw));
    } catch { watchSet = new Set(); }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...watchSet]));
  }

  function has(code) { return watchSet.has(code); }

  function toggle(code) {
    if (watchSet.has(code)) watchSet.delete(code);
    else watchSet.add(code);
    save();
  }

  function add(code) {
    watchSet.add(code);
    save();
  }

  function addBatch(codes) {
    for (const c of codes) watchSet.add(c);
    save();
  }

  function getAll() { return [...watchSet]; }

  // 初始載入
  load();

  return { has, toggle, add, addBatch, getAll };
})();
