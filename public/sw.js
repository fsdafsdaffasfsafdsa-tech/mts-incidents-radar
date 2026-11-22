// Service worker нужен только для того, чтобы Радар можно было установить приложением: установленному приложению
// браузер разрешает звук сразу, без щелчка, — Джарвис говорит с первой секунды. Ничего не кэшируем: всегда свежая
// версия с сервера, поток событий и API идут напрямую.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request));
});
