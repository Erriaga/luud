/* -------------------------------------------------------------
   LUUD Service Worker - PWA + reserva offline de assets
   Rede em primeiro lugar: o cache só serve reserva quando o
   dispositivo está sem internet. Nunca guarda respostas de /api/*
   (dados privados da conta não podem ficar em disco nem ser
   servidos desatualizados offline).
------------------------------------------------------------- */

// Versão do cache: ao alterar este valor os caches antigos (com ícones,
// logos, scripts velhos e respostas de API antigas) são apagados na
// próxima ativação.
const CACHE_NAME = 'luud-v4';
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

// Recursos que podem entrar no cache ao serem buscados com sucesso:
// apenas assets locais e o manifesto. A lista é fechada e pequena, então
// o cache tem limite natural (sem risco de crescimento descontrolado).
const CACHEABLE_PATTERN = /^\/(assets\/|manifest\.json$)/;

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

  // Para navegações (HTML), tenta a rede primeiro e, se responder,
  // atualiza a cópia offline do documento. Assim quem volta a ficar
  // sem internet recebe a versão mais recente que passou por aqui,
  // não a da época da instalação do Service Worker.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(OFFLINE_URL, copy));
          }
          return response;
        })
        .catch(() => {
          return caches.match(OFFLINE_URL);
        })
    );
    return;
  }

  // Para os demais recursos a rede vem primeiro: assim um ícone, logo ou
  // script atualizado aparece assim que é publicado (o cache só entra como
  // reserva quando o dispositivo está sem internet). Só guarda assets
  // locais e o manifesto — nunca /api/*.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Guarda no cache apenas o que é do próprio site e está na lista
        if (
          response && response.ok &&
          url.origin === self.location.origin &&
          CACHEABLE_PATTERN.test(url.pathname)
        ) {
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
