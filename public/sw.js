// ─── FriendlyRival Service Worker ────────────────────────────────────────────
const CACHE_NAME = 'friendlyrival-v1';

// Fișiere de bază care se cachează pentru funcționare offline
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/ball.svg',
];

// Install — cachează assets de bază
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate — șterge cache-urile vechi
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — Network first, fallback la cache
// Openfootball și Supabase merg mereu live (network first)
// Assets statice merg din cache dacă nu e internet
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls merg mereu pe network
  if (
    url.hostname.includes('supabase') ||
    url.hostname.includes('githubusercontent') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('anthropic')
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Assets statice — cache first, fallback network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cachează răspunsurile valide
        if (response && response.status === 200 && response.type === 'basic') {
          const toCache = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
        }
        return response;
      }).catch(() => {
        // Offline fallback pentru navigare
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
      });
    })
  );
});

// Push notifications (pentru viitor — ex: "Meciul începe în 30 min!")
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'FriendlyRival', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
