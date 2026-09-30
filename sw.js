const CACHE = 'pannelli-v4';   // v4 (30/09/2026): i dati arrivano dal Mac, non più da Google
const STATIC_ASSETS = [
  '/pannelli/',
  '/pannelli/index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
];

// Installazione: precache degli asset statici
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Attivazione: rimuovi cache vecchie
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Dati (dal Mac via Tailscale, o Google di riserva) → sempre dalla rete, mai in cache:
  // hanno un ?_= diverso a ogni lettura e con «cache first» la cache sarebbe cresciuta all'infinito.
  if (url.includes('script.google.com') || url.includes('.ts.net')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify(null), { headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // Google Fonts → cache first
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }))
    );
    return;
  }

  // Tutto il resto → cache first, poi network
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
