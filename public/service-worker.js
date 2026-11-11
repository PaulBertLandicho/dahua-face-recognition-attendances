const CACHE_NAME = 'mf-attendance-v4';
const OFFLINE_URL = '/offline.html';

const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/image/logosidebar.jpg',
  OFFLINE_URL,
];

// Explicit model files to pre-cache so face-api.js models are available offline
const MODEL_FILES = [
  '/models/face_landmark_68_model-shard1',
  '/models/face_landmark_68_model-weights_manifest.json',
  '/models/face_recognition_model-shard1',
  '/models/face_recognition_model-shard2',
  '/models/face_recognition_model-weights_manifest.json',
  '/models/ssd_mobilenetv1_model-shard1',
  '/models/ssd_mobilenetv1_model-shard2',
  '/models/ssd_mobilenetv1_model-weights_manifest.json',
  '/models/tiny_face_detector_model-shard1',
  '/models/tiny_face_detector_model-weights_manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(ASSETS_TO_CACHE.concat(MODEL_FILES)).catch((err) => {
        console.warn('[SW] Cache addAll warning:', err);
      })
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) return caches.delete(k);
          return null;
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Navigation requests: Network-first, fallback to cached /index.html (loads SPA offline)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => {
          return caches.match('/index.html').then((indexRes) => {
            return indexRes || caches.match('/') || caches.match(OFFLINE_URL);
          });
        })
    );
    return;
  }

  // 2. Cache-first for models, static JS/CSS bundles, images, wasm
  if (
    url.pathname.startsWith('/models') ||
    url.pathname.startsWith('/static') ||
    url.pathname.startsWith('/image') ||
    url.pathname.endsWith('.wasm') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.jpeg') ||
    url.pathname.endsWith('.json')
  ) {
    event.respondWith(
      caches.match(req).then((cacheRes) => {
        if (cacheRes) return cacheRes;
        return fetch(req)
          .then((res) => {
            if (!res || res.status !== 200) return res;
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
            return res;
          })
          .catch(() => null);
      })
    );
    return;
  }

  // 3. Default fallback: network, then cache
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

// Background sync: when service worker receives a sync event, notify clients
self.addEventListener('sync', (event) => {
  if (!event.tag) return;
  if (event.tag === 'sync-offline-queue') {
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: 'SYNC_OFFLINE_QUEUE_REQUEST', tag: event.tag });
        }
      })
    );
  }
});

// Allow runtime clients to message the SW
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
