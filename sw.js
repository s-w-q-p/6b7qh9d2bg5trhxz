/*
 * オフライン用の Service Worker。アプリのファイルだけを端末に保存し、以後は通信なしで開けるようにする。
 * 入力した売上データは扱わない（保存もしない）。
 *
 * アプリのファイルを更新したら CACHE_VERSION を上げる。次に開いたとき新しいファイルに入れ替わる。
 */
const CACHE_VERSION = 'sales-report-v4';
const FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/calculations.js',
  './js/report-layout.js',
  './js/report-template.js',
  './js/report-export.js',
  './js/app.js',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then(function (cache) {
        // 更新時に古いファイルを拾わないよう、ブラウザのキャッシュを通さずに取り直す
        return cache.addAll(FILES.map(function (url) {
          return new Request(url, { cache: 'reload' });
        }));
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key !== CACHE_VERSION;
            })
            .map(function (key) {
              return caches.delete(key);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

// 保存したファイルを優先して返す（通信しない）。保存にないものだけ通信で取りに行く。
self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(function (cached) {
      if (cached) return cached;
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html').then(function (page) {
          return page || fetch(event.request);
        });
      }
      return fetch(event.request);
    })
  );
});
