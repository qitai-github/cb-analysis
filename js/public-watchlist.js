// 公用追蹤清單模組 — 以 Supabase 為後端,所有使用者共享
//
// Schema: public_watchlist (list_name TEXT, code TEXT, PK(list_name, code))
// 多清單支援:每個 (list_name, code) 是一個 row
//
// 寫死的清單名稱請見 PUBLIC_LIST_NAMES。要新增/改名 → 改這裡 + Supabase 不用動。
const PublicWatchlist = (() => {
  const TABLE = 'public_watchlist';

  // 寫死的公用清單清單 — 想新增清單名稱在這加一行即可
  const PUBLIC_LIST_NAMES = [
    '新天團',
    '芭樂可轉長線',
    '芭樂現股波段',
    '芭樂報告待跑',
    '芭樂報告完成',
  ];

  // cache: Map<list_name, Set<code>>
  const cache = new Map(PUBLIC_LIST_NAMES.map(n => [n, new Set()]));
  let ready = false;
  let listeners = [];

  function headers() {
    return {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
    };
  }

  function apiUrl(params = '') {
    return `${SUPABASE_URL}/rest/v1/${TABLE}${params}`;
  }

  async function load() {
    try {
      const res = await fetch(apiUrl('?select=list_name,code'), { headers: headers() });
      if (!res.ok) throw new Error(await res.text());
      const rows = await res.json();
      // 清空 cache 重建
      for (const set of cache.values()) set.clear();
      for (const r of rows) {
        const name = r.list_name || '新天團';  // 舊資料兼容
        if (!cache.has(name)) cache.set(name, new Set());
        cache.get(name).add(r.code);
      }
      // 確保所有寫死清單名都存在 (空集也要有 key)
      for (const n of PUBLIC_LIST_NAMES) {
        if (!cache.has(n)) cache.set(n, new Set());
      }
      ready = true;
      notify();
    } catch (e) {
      console.warn('[PublicWatchlist] 載入失敗', e);
    }
  }

  async function add(listName, code) {
    if (!cache.has(listName)) cache.set(listName, new Set());
    cache.get(listName).add(code);
    notify();
    try {
      const res = await fetch(apiUrl(), {
        method: 'POST',
        headers: { ...headers(), 'Prefer': 'resolution=ignore-duplicates' },
        body: JSON.stringify({ list_name: listName, code })
      });
      if (!res.ok) {
        const txt = await res.text();
        if (!txt.includes('duplicate') && !txt.includes('unique')) {
          throw new Error(txt);
        }
      }
    } catch (e) {
      console.warn('[PublicWatchlist] 新增失敗', e);
      cache.get(listName)?.delete(code);
      notify();
    }
  }

  async function remove(listName, code) {
    cache.get(listName)?.delete(code);
    notify();
    try {
      const url = apiUrl(
        `?list_name=eq.${encodeURIComponent(listName)}` +
        `&code=eq.${encodeURIComponent(code)}`
      );
      const res = await fetch(url, { method: 'DELETE', headers: headers() });
      if (!res.ok) throw new Error(await res.text());
    } catch (e) {
      console.warn('[PublicWatchlist] 刪除失敗', e);
      cache.get(listName)?.add(code);
      notify();
    }
  }

  // 是否在指定清單 (listName 省略 → 是否在「任一」公用清單)
  function has(code, listName) {
    if (listName) return cache.get(listName)?.has(code) ?? false;
    for (const set of cache.values()) if (set.has(code)) return true;
    return false;
  }

  // 取得清單內所有 code (listName 省略 → 所有公用清單聯集)
  function getAll(listName) {
    if (listName) return [...(cache.get(listName) || [])];
    const all = new Set();
    for (const set of cache.values()) for (const c of set) all.add(c);
    return [...all];
  }

  function getLists() { return [...PUBLIC_LIST_NAMES]; }
  function isReady() { return ready; }
  function onChange(fn) { listeners.push(fn); }
  function notify() { for (const fn of listeners) fn(); }

  load();

  return {
    load, add, remove, has, getAll, getLists, isReady, onChange,
    PUBLIC_LIST_NAMES,
  };
})();
