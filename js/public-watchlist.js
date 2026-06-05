// 公用追蹤清單模組 — 以 Supabase 為後端，所有使用者共享
const PublicWatchlist = (() => {
  const TABLE = 'public_watchlist';
  let cache = new Set();
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
      const res = await fetch(apiUrl('?select=code'), { headers: headers() });
      if (!res.ok) throw new Error(await res.text());
      const rows = await res.json();
      cache = new Set(rows.map(r => r.code));
      ready = true;
      notify();
    } catch (e) {
      console.warn('[PublicWatchlist] 載入失敗', e);
    }
  }

  async function add(code) {
    cache.add(code);
    notify();
    try {
      const res = await fetch(apiUrl(), {
        method: 'POST',
        headers: { ...headers(), 'Prefer': 'resolution=ignore-duplicates' },
        body: JSON.stringify({ code })
      });
      if (!res.ok) {
        const txt = await res.text();
        if (!txt.includes('duplicate') && !txt.includes('unique')) {
          throw new Error(txt);
        }
      }
    } catch (e) {
      console.warn('[PublicWatchlist] 新增失敗', e);
      cache.delete(code);
      notify();
    }
  }

  async function remove(code) {
    cache.delete(code);
    notify();
    try {
      const res = await fetch(apiUrl(`?code=eq.${encodeURIComponent(code)}`), {
        method: 'DELETE',
        headers: headers()
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (e) {
      console.warn('[PublicWatchlist] 刪除失敗', e);
      cache.add(code);
      notify();
    }
  }

  function has(code) { return cache.has(code); }
  function getAll() { return [...cache]; }
  function isReady() { return ready; }
  function onChange(fn) { listeners.push(fn); }
  function notify() { for (const fn of listeners) fn(); }

  load();

  return { load, add, remove, has, getAll, isReady, onChange };
})();
