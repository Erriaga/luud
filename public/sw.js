/* -------------------------------------------------------------
   LUUD Service Worker - Proteção contra recarregamento
   Trabalha em conjunto com o frontend para impedir abandono
   acidental durante partidas online.
------------------------------------------------------------- */

// Versão do cache: ao alterar este valor os caches antigos (com ícones,
// logos e scripts velhos) são apagados na próxima ativação.
const CACHE_NAME = 'luud-v3';
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
  if (event.request.method !== 'GET') return;

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

  // Para os demais recursos a rede vem primeiro: assim um ícone, logo ou
  // script atualizado aparece assim que é publicado (o cache só entra como
  // reserva quando o dispositivo está sem internet).
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Guarda no cache apenas o que é do próprio site
        if (response && response.ok && url.origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => cached || Response.error());
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
