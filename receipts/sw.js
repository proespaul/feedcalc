/* The Receipts app moved to https://proespaul.github.io/receipts/ — this worker just steps aside. */
self.addEventListener('install', function (e) { e.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k.indexOf('household-receipts-') === 0; }).map(function (k) { return caches.delete(k); })); })
    .then(function () { return self.registration.unregister(); }).then(function () { return self.clients.claim(); }));
});
