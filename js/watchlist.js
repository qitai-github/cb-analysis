// 追蹤清單模組 — 支援多個命名清單，localStorage 持久化
const Watchlist = (() => {
  const STORAGE_KEY = 'cb_watchlist_v2';
  const OLD_STORAGE_KEY = 'cb_watchlist';

  // { lists: { "預設": ["2301","2368"], "觀察中": ["3037"] }, order: ["預設","觀察中"] }
  let data = { lists: {}, order: [] };
  let activeList = ''; // 目前選擇的清單名稱（篩選用）

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        data = JSON.parse(raw);
        if (!data.lists) data.lists = {};
        if (!data.order) data.order = Object.keys(data.lists);
      } else {
        // 從舊版遷移
        migrate();
      }
    } catch {
      data = { lists: {}, order: [] };
    }
    // 確保至少有一個預設清單
    if (data.order.length === 0) {
      data.lists['預設'] = [];
      data.order = ['預設'];
      save();
    }
  }

  function migrate() {
    try {
      const old = localStorage.getItem(OLD_STORAGE_KEY);
      if (old) {
        const codes = JSON.parse(old);
        data.lists['預設'] = Array.isArray(codes) ? codes : [];
        data.order = ['預設'];
        save();
      } else {
        data.lists['預設'] = [];
        data.order = ['預設'];
      }
    } catch {
      data.lists['預設'] = [];
      data.order = ['預設'];
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  // === 清單管理 ===
  function getListNames() { return [...data.order]; }

  function addList(name) {
    name = name.trim();
    if (!name || data.lists[name]) return false;
    data.lists[name] = [];
    data.order.push(name);
    save();
    return true;
  }

  function removeList(name) {
    if (!data.lists[name]) return false;
    delete data.lists[name];
    data.order = data.order.filter(n => n !== name);
    if (activeList === name) activeList = '';
    // 確保至少保留一個清單
    if (data.order.length === 0) {
      data.lists['預設'] = [];
      data.order = ['預設'];
    }
    save();
    return true;
  }

  // === 股票與清單關聯 ===
  function addToList(code, listName) {
    if (!data.lists[listName]) return;
    if (!data.lists[listName].includes(code)) {
      data.lists[listName].push(code);
      save();
    }
  }

  function removeFromList(code, listName) {
    if (!data.lists[listName]) return;
    data.lists[listName] = data.lists[listName].filter(c => c !== code);
    save();
  }

  function isInList(code, listName) {
    return data.lists[listName]?.includes(code) || false;
  }

  function isInAnyList(code) {
    return data.order.some(name => data.lists[name]?.includes(code));
  }

  // === 星號操作（向下相容 + 多清單） ===
  function has(code) {
    return isInAnyList(code);
  }

  function toggle(code) {
    const list = activeList || data.order[0] || '預設';
    if (isInList(code, list)) {
      removeFromList(code, list);
    } else {
      addToList(code, list);
    }
  }

  function add(code) {
    const list = activeList || data.order[0] || '預設';
    addToList(code, list);
  }

  function addBatch(codes) {
    const list = activeList || data.order[0] || '預設';
    if (!data.lists[list]) return;
    for (const c of codes) {
      if (!data.lists[list].includes(c)) data.lists[list].push(c);
    }
    save();
  }

  function getAll() {
    const all = new Set();
    for (const name of data.order) {
      for (const c of (data.lists[name] || [])) all.add(c);
    }
    return [...all];
  }

  function getCodesInList(listName) {
    return data.lists[listName] ? [...data.lists[listName]] : [];
  }

  // === Active list（篩選用） ===
  function setActiveList(name) { activeList = name; }
  function getActiveList() { return activeList; }

  // 初始載入
  load();

  return {
    has, toggle, add, addBatch, getAll,
    getListNames, addList, removeList,
    addToList, removeFromList, isInList, isInAnyList,
    getCodesInList, setActiveList, getActiveList
  };
})();
