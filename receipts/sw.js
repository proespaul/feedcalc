/* sw.js — Household Receipts service worker
 * 1. Caches the app so it opens with no signal.
 * 2. On Android, finishes sending queued receipts in the background (Background Sync). */
const VERSION = 'v1.2.0';   // bump on every release so phones pick up the new files
const CACHE = 'household-receipts-' + VERSION;
const ASSETS = [
  './', './index.html', './core.js', './manifest.json',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'
];

importScripts('./core.js');

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // Add one by one so a single missing icon can't block the whole install
      return Promise.all(ASSETS.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf('household-receipts-') === 0 && k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // backend + anything external: straight to network

  // Android share sheet → "Receipts": the photos / screenshots / PDFs arrive here as a form POST
  if (req.method === 'POST' && /\/share-target\/?$/.test(url.pathname)) {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    // Network first (so updates arrive), cached app if there is no signal
    event.respondWith(
      fetchWithTimeout(req, 4000).then(function (res) {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        }
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (hit) { return hit || caches.match('./'); });
      })
    );
    return;
  }

  // Everything else same-origin: cache first, refresh in the background
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      const refresh = fetch(req).then(function (res) {
        if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(req, res.clone()); });
        return res;
      }).catch(function () { return hit; });
      return hit || refresh;
    })
  );
});

function handleShare(req) {
  return req.formData().then(function (fd) {
    const files = fd.getAll('photos').filter(function (f) { return f && f.size > 0 && (/^image\//.test(f.type || '') || f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '')); });
    let chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return self.ReceiptsCore.inboxAdd(f, { name: f.name || 'shared.jpg', lastModified: f.lastModified || Date.now(), type: f.type });
      });
    });
    return chain.then(function () { return files.length; });
  }).catch(function () { return 0; }).then(function (n) {
    // 303 so the browser follows with a GET and opens the app
    return Response.redirect('./?shared=' + n, 303);
  });
}

function fetchWithTimeout(req, ms) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    fetch(req).then(function (r) { clearTimeout(t); resolve(r); }, function (e) { clearTimeout(t); reject(e); });
  });
}

// Android Chrome: Background Sync fires when the phone gets signal back, even if the app is closed
self.addEventListener('sync', function (event) {
  if (event.tag !== 'sync-receipts') return;
  event.waitUntil(
    self.ReceiptsCore.syncAll().then(function (out) {
      return notifyClients({ type: 'synced', result: out }).then(function () {
        if (out.remaining > 0 && !out.noConfig) throw new Error('still remaining'); // ask the browser to try again later
      });
    })
  );
});

self.addEventListener('message', function (event) {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'SYNC_NOW') {
    event.waitUntil(self.ReceiptsCore.syncAll().then(function (out) { return notifyClients({ type: 'synced', result: out }); }));
  }
});

function notifyClients(msg) {
  return self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(function (list) {
    list.forEach(function (c) { c.postMessage(msg); });
  });
}
