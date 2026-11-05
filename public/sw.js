/* -------------------------------------------------------------
   LUUD Service Worker - Proteção contra recarregamento
   Trabalha em conjunto com o frontend para impedir abandono
   acidental durante partidas online.
------------------------------------------------------------- */

const CACHE_NAME = 'luud-v1';
const OFFLINE_URL = '/game.html';

// Lista de rotas que devem ser servidas offline
const STATIC_ASSETS = [
  '/',
  '/game.html',
  '/assets/luud.svg',
  '/assets/luud.png',
  '/assets/favicon.svg',
  '/assets/favicon.ico',
  '/manifest.json'
];

// Instala o Service Worker e faz cache dos arquivos estáticos
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Ativa o Service Worker e limpa caches antigos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Intercepta requisições de rede
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Para navegações (HTML), tenta a rede primeiro, depois o cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match(OFFLINE_URL);
      })
    );
    return;
  }

  // Para outros recursos, tenta o cache primeiro, depois a rede
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request);
    })
  );
});

// Comunicação com o cliente (página)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'GET_ABANDON_STATUS') {
    // Responde se há um abandono pendente
    event.ports[0].postMessage({
      hasPendingAbandon: !!sessionStorage.getItem('luud_pending_abandon')
    });
  }
});
