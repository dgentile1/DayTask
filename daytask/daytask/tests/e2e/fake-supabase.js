// In-page stand-in for supabase-js. Every query goes to a shared Python-side DB via window.__db.
(function () {
  const realtime = [];
  window.__notify = () => realtime.forEach((cb) => cb({}));
  window.supabase = {
    createClient() {
      // Offline: behave like supabase-js when fetch fails.
      const call = (payload) => (navigator.onLine
        ? window.__db(JSON.stringify(payload)).then((r) => JSON.parse(r))
        : Promise.resolve({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' } }));
      class Q {
        constructor(t) { this.p = { t, action: 'select', f: [], single: false, limit: null, payload: null }; }
        select() { return this; }
        insert(row) { this.p.action = 'insert'; this.p.payload = row; return this; }
        update(row) { this.p.action = 'update'; this.p.payload = row; return this; }
        upsert(row) { this.p.action = 'upsert'; this.p.payload = row; return this; }
        delete() { this.p.action = 'delete'; return this; }
        eq(c, v) { this.p.f.push(['eq', c, v]); return this; }
        in(c, v) { this.p.f.push(['in', c, v]); return this; }
        or(e) { this.p.f.push(['or', e]); return this; }
        order() { return this; }
        limit(n) { this.p.limit = n; return this; }
        single() { this.p.single = true; return this; }
        then(res, rej) { return call(this.p).then(res, rej); }
      }
      const session = { user: { id: 'u1' } };
      return {
        auth: {
          // Offline, an expired sign-in can't refresh: no session (the app must open from the device copy).
          getSession: async () => ({ data: { session: navigator.onLine ? session : null }, error: null }),
          getUser: async () => ({ data: { user: session.user }, error: null }),
          onAuthStateChange() {},
          signInWithPassword: async () => ({ data: { session }, error: null }),
          signOut: async () => ({ error: null }),
        },
        from: (t) => new Q(t),
        channel() {
          const ch = { on(_a, _b, cb) { realtime.push(cb); return ch; }, subscribe(cb) {
            setTimeout(() => cb('SUBSCRIBED'), 0);
            let seen = null;
            setInterval(async () => {
              if (!navigator.onLine) return;
              const v = JSON.parse(await window.__db(JSON.stringify({ t: '__version' })));
              if (seen !== null && v !== seen) window.__notify();
              seen = v;
            }, 250);
            return ch;
          } };
          return ch;
        },
        removeChannel() {},
      };
    },
  };
})();
