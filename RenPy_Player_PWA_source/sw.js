'use strict';

const CACHE_NAME = 'renpy-player-shell-v1';
const SHELL_FILES = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png', './assets/apple-touch-icon.png'];
const DB_NAME = 'renpy-player-library';
const DB_VERSION = 1;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB unavailable'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('games')) db.createObjectStore('games', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) {
        const store = db.createObjectStore('files', { keyPath: 'key' });
        store.createIndex('gameId', 'gameId', { unique: false });
      }
    };
  });
}

function contentType(path) {
  const ext = path.split('.').pop().toLowerCase();
  const types = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', wasm: 'application/wasm', zip: 'application/zip', data: 'application/octet-stream',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', txt: 'text/plain; charset=utf-8', xml: 'application/xml',
    map: 'application/json', bin: 'application/octet-stream'
  };
  return types[ext] || 'application/octet-stream';
}

function safeDecodePath(path) {
  try {
    const decoded = decodeURIComponent(path);
    const normalized = decoded.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.some(part => part === '.' || part === '..' || part.includes('\0'))) return null;
    return parts.join('/');
  } catch (_) { return null; }
}

async function serveGame(request, url, scopePath) {
  const prefix = `${scopePath}__game__/`;
  const rest = url.pathname.slice(prefix.length);
  const firstSlash = rest.indexOf('/');
  if (firstSlash <= 0) return new Response('Bad game route', { status: 400 });
  const gameId = rest.slice(0, firstSlash);
  let path = safeDecodePath(rest.slice(firstSlash + 1));
  if (!path) return new Response('Invalid game path', { status: 400 });
  if (path.endsWith('/')) path += 'index.html';
  const db = await openDatabase();
  try {
    const tx = db.transaction('files', 'readonly');
    const result = await new Promise((resolve, reject) => {
      const get = tx.objectStore('files').get(`${gameId}:${path}`);
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => reject(get.error);
    });
    if (!result) return new Response(`Game file not found: ${path}`, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    const data = result.data instanceof ArrayBuffer ? result.data : result.data.buffer;
    let status = 200;
    let body = data;
    const headers = new Headers({
      'Content-Type': contentType(path),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      'Cross-Origin-Resource-Policy': 'same-origin'
    });
    const range = request.headers.get('Range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        let start = match[1] ? Number(match[1]) : 0;
        let end = match[2] ? Number(match[2]) : data.byteLength - 1;
        if (!match[1] && match[2]) { const suffix = Number(match[2]); start = Math.max(0, data.byteLength - suffix); end = data.byteLength - 1; }
        if (start <= end && start < data.byteLength) {
          end = Math.min(end, data.byteLength - 1);
          body = data.slice(start, end + 1);
          status = 206;
          headers.set('Content-Range', `bytes ${start}-${end}/${data.byteLength}`);
        } else {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${data.byteLength}` } });
        }
      }
    }
    headers.set('Content-Length', String(body.byteLength));
    if (request.method === 'HEAD') body = null;
    return new Response(body, { status, headers });
  } finally {
    db.close();
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_FILES.map(path => new URL(path, self.registration.scope).href));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('renpy-player-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  const url = new URL(request.url);
  const scopePath = new URL(self.registration.scope).pathname;
  if (url.origin === self.location.origin && url.pathname.startsWith(`${scopePath}__game__/`)) {
    event.respondWith(serveGame(request, url, scopePath).catch(error => new Response(`Player error: ${error.message || error}`, { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })));
    return;
  }
  if (url.origin === self.location.origin && url.pathname.startsWith(scopePath)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      try { return await fetch(request); }
      catch (_) { return new Response('Нет подключения к сети. Открой главную страницу плеера после восстановления соединения.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
    })());
  }
});
