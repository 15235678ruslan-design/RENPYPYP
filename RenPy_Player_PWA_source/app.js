'use strict';

const DB_NAME = 'renpy-player-library';
const DB_VERSION = 1;
const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 700 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 600 * 1024 * 1024;
const MAX_FILES = 20000;
const APP_BASE = new URL('./', location.href);

const el = (id) => document.getElementById(id);
const state = { db: null, games: [], ascending: false, cancelImport: false, activeGame: null, toastTimer: null, registration: null };

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('games')) db.createObjectStore('games', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) {
        const store = db.createObjectStore('files', { keyPath: 'key' });
        store.createIndex('gameId', 'gameId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Не удалось открыть локальное хранилище.'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Ошибка локального хранилища.'));
  });
}

async function getAllGames() {
  const tx = state.db.transaction('games', 'readonly');
  return requestResult(tx.objectStore('games').getAll());
}

async function putGame(game) {
  const tx = state.db.transaction('games', 'readwrite');
  tx.objectStore('games').put(game);
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Не удалось сохранить игру.'));
    tx.onabort = () => reject(tx.error || new Error('Сохранение прервано.'));
  });
}

async function putGameFile(gameId, path, data) {
  const tx = state.db.transaction('files', 'readwrite');
  tx.objectStore('files').put({ key: `${gameId}:${path}`, gameId, path, data });
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Не удалось сохранить файл игры.'));
    tx.onabort = () => reject(tx.error || new Error('Сохранение файла прервано.'));
  });
}

async function removeGame(gameId) {
  const tx = state.db.transaction(['games', 'files'], 'readwrite');
  tx.objectStore('games').delete(gameId);
  const index = tx.objectStore('files').index('gameId');
  const cursorRequest = index.openKeyCursor(IDBKeyRange.only(gameId));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor) {
      tx.objectStore('files').delete(cursor.primaryKey);
      cursor.continue();
    }
  };
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Не удалось удалить игру.'));
    tx.onabort = () => reject(tx.error || new Error('Удаление отменено.'));
  });
}

async function cleanupFiles(gameId) {
  try {
    const tx = state.db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    const cursorRequest = store.index('gameId').openKeyCursor(IDBKeyRange.only(gameId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); }
    };
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (_) { /* Best effort cleanup after a failed import. */ }
}

function showToast(message) {
  const node = el('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.remove('show'), 3000);
}

function showMessage(title, message, icon = '!') {
  el('messageTitle').textContent = title;
  el('messageText').textContent = message;
  el('messageIcon').textContent = icon;
  el('messageModal').hidden = false;
}

function closeModal(id) { el(id).hidden = true; }

function escapePath(path) {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.some(part => part === '..' || part.includes('\0'))) return null;
  return parts.join('/');
}

async function findZipDirectory(file) {
  if (file.size < 22) throw new Error('Файл слишком маленький и не похож на ZIP-архив.');
  const tailSize = Math.min(file.size, 65557);
  const tail = await file.slice(file.size - tailSize).arrayBuffer();
  const view = new DataView(tail);
  let eocd = -1;
  for (let i = view.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('В архиве не найдена ZIP-структура. Возможно, файл повреждён.');
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (disk || centralDisk || entriesDisk !== entryCount) throw new Error('Многотомные ZIP-архивы не поддерживаются.');
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 пока не поддерживается. Попробуй собрать игру заново обычным ZIP.');
  if (entryCount > MAX_FILES) throw new Error(`В архиве слишком много файлов (лимит ${MAX_FILES.toLocaleString('ru-RU')}).`);
  const absoluteOffset = file.size - tailSize + centralOffset;
  if (absoluteOffset + centralSize > file.size) throw new Error('Таблица ZIP-архива повреждена.');
  const centralBuffer = await file.slice(absoluteOffset, absoluteOffset + centralSize).arrayBuffer();
  const centralView = new DataView(centralBuffer);
  const decoder = new TextDecoder('utf-8');
  const entries = [];
  let offset = 0;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > centralView.byteLength || centralView.getUint32(offset, true) !== 0x02014b50) throw new Error('Не удалось прочитать список файлов ZIP.');
    const flags = centralView.getUint16(offset + 8, true);
    const method = centralView.getUint16(offset + 10, true);
    const crc = centralView.getUint32(offset + 16, true);
    const compressedSize = centralView.getUint32(offset + 20, true);
    const uncompressedSize = centralView.getUint32(offset + 24, true);
    const nameLength = centralView.getUint16(offset + 28, true);
    const extraLength = centralView.getUint16(offset + 30, true);
    const commentLength = centralView.getUint16(offset + 32, true);
    const startDisk = centralView.getUint16(offset + 34, true);
    const localOffset = centralView.getUint32(offset + 42, true);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > centralView.byteLength) throw new Error('ZIP-архив обрезан.');
    const nameBytes = centralBuffer.slice(offset + 46, offset + 46 + nameLength);
    const rawName = decoder.decode(nameBytes);
    const path = escapePath(rawName);
    const isDirectory = rawName.endsWith('/');
    if (path && !isDirectory) {
      if (flags & 1) throw new Error('Архив зашифрован паролем. Сними пароль и попробуй ещё раз.');
      if (startDisk !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 и многотомные записи не поддерживаются.');
      if (![0, 8].includes(method)) throw new Error(`Неизвестный метод сжатия в файле ${path}. Поддерживаются Stored и Deflate.`);
      entries.push({ path, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    }
    offset = recordEnd;
  }
  if (!entries.length) throw new Error('В архиве нет файлов для импорта.');
  return entries;
}

function crc32(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

async function inflateEntry(file, entry) {
  const localHeaderBuffer = await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer();
  const local = new DataView(localHeaderBuffer);
  if (local.byteLength < 30 || local.getUint32(0, true) !== 0x04034b50) throw new Error(`Повреждён заголовок файла ${entry.path}.`);
  const nameLength = local.getUint16(26, true);
  const extraLength = local.getUint16(28, true);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > file.size) throw new Error(`Файл ${entry.path} обрезан в архиве.`);
  const compressed = await file.slice(dataStart, dataEnd).arrayBuffer();
  let output;
  if (entry.method === 0) output = compressed;
  else {
    if (typeof DecompressionStream === 'undefined') throw new Error('Этот браузер не умеет распаковывать ZIP Deflate. Обнови iOS и Safari до последней версии.');
    try {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      output = await new Response(stream).arrayBuffer();
    } catch (error) {
      throw new Error(`Не удалось распаковать ${entry.path}: ${error.message || 'ошибка Deflate'}`);
    }
  }
  if (output.byteLength !== entry.uncompressedSize) throw new Error(`Размер распакованного файла ${entry.path} не совпадает с ZIP-описанием.`);
  // A full CRC pass over a very large game.data can block mobile Safari for too long.
  if (output.byteLength <= 32 * 1024 * 1024 && crc32(new Uint8Array(output)) !== entry.crc) throw new Error(`Проверка целостности не пройдена: ${entry.path}.`);
  return output;
}

function chooseGameRoot(entries) {
  const indexes = entries.filter(item => item.path.toLowerCase().endsWith('/index.html') || item.path.toLowerCase() === 'index.html');
  if (!indexes.length) throw new Error('Не найден index.html. Это не похоже на Web-сборку Ren\'Py.');
  const roots = indexes.map(index => index.path.includes('/') ? index.path.slice(0, index.path.lastIndexOf('/') + 1) : '');
  let best = roots[0];
  let bestScore = -1;
  for (const root of roots) {
    const paths = entries.filter(entry => entry.path.startsWith(root)).map(entry => entry.path.slice(root.length).toLowerCase());
    const hasWasm = paths.some(path => path.endsWith('.wasm'));
    const hasRenpyJs = paths.some(path => path.endsWith('renpy.js') || path.endsWith('renpy-pre.js'));
    const hasData = paths.some(path => /(^|\/)(game\.zip|game\.data)$/.test(path) || path.endsWith('.data'));
    const score = (hasWasm ? 10 : 0) + (hasRenpyJs ? 4 : 0) + (hasData ? 10 : 0) - root.split('/').filter(Boolean).length;
    if (score > bestScore) { best = root; bestScore = score; }
  }
  return best;
}

function makeIsolationPatch(gameId) {
  const idLiteral = JSON.stringify(gameId);
  return `<script>\n(function(){\n  var prefix='renpy-player:'+${idLiteral} + ':';\n  try {\n    var raw=window.localStorage;\n    var wrapped={\n      getItem:function(k){return raw.getItem(prefix+k);},\n      setItem:function(k,v){raw.setItem(prefix+k,String(v));},\n      removeItem:function(k){raw.removeItem(prefix+k);},\n      clear:function(){var keys=[];for(var i=0;i<raw.length;i++){var k=raw.key(i);if(k&&k.indexOf(prefix)===0)keys.push(k);}keys.forEach(function(k){raw.removeItem(k);});},\n      key:function(i){var keys=[];for(var n=0;n<raw.length;n++){var k=raw.key(n);if(k&&k.indexOf(prefix)===0)keys.push(k.slice(prefix.length));}return keys[i]||null;}\n    };\n    Object.defineProperty(wrapped,'length',{get:function(){var n=0;for(var i=0;i<raw.length;i++){var k=raw.key(i);if(k&&k.indexOf(prefix)===0)n++;}return n;}});\n    Object.defineProperty(window,'localStorage',{configurable:true,value:wrapped});\n  } catch(e) {}\n  try { var open=window.indexedDB.open.bind(window.indexedDB); window.indexedDB.open=function(name,version){return open(prefix+name,version);}; } catch(e) {}\n})();\n</script>`;
}

function injectIsolation(html, gameId) {
  const patch = makeIsolationPatch(gameId);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, match => match + patch);
  return patch + html;
}

function setProgress(percent, text) {
  el('progressBar').style.width = `${Math.max(0, Math.min(100, percent))}%`;
  el('progressText').textContent = text;
}

function showProgress(title, text) {
  el('progressTitle').textContent = title;
  setProgress(0, text);
  el('progressModal').hidden = false;
}

function base64SafeTitle(title) {
  return title.replace(/\.zip$/i, '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Новая игра';
}

async function importZip(file) {
  if (!file || !/\.zip$/i.test(file.name)) throw new Error('Выбери ZIP-архив Web-сборки Ren\'Py.');
  if (file.size > MAX_ZIP_BYTES) throw new Error('Архив больше 1 ГБ. Для iPhone это слишком тяжёлая загрузка в этой версии плеера.');
  if (file.size < 22) throw new Error('Файл пустой или слишком маленький.');
  state.cancelImport = false;
  showProgress('Проверяем ZIP-архив…', 'Читаем структуру игры.');
  const entries = await findZipDirectory(file);
  const root = chooseGameRoot(entries);
  const selected = entries.filter(item => item.path.startsWith(root)).map(item => ({ ...item, path: item.path.slice(root.length) })).filter(item => item.path && !item.path.endsWith('/'));
  const hasIndex = selected.some(item => item.path.toLowerCase() === 'index.html');
  const hasWasm = selected.some(item => item.path.toLowerCase().endsWith('.wasm'));
  const hasGameData = selected.some(item => /(^|\/)(game\.zip|game\.data)$/.test(item.path.toLowerCase()) || item.path.toLowerCase().endsWith('.data'));
  if (!hasIndex || !hasWasm || !hasGameData) {
    throw new Error('Похоже, это не готовая Ren\'Py Web-сборка. Нужны index.html, файл .wasm и game.zip (или game.data). На компьютере открой Ren\'Py Launcher → выбери проект → Web → Build Web Application и перенеси созданный *-web.zip.');
  }
  const unpackedTotal = selected.reduce((sum, item) => sum + item.uncompressedSize, 0);
  const oversized = selected.find(item => item.uncompressedSize > MAX_SINGLE_FILE_BYTES);
  if (oversized) throw new Error(`Файл ${oversized.path} больше 600 МБ. Для надёжного импорта на iPhone уменьши размер игры.`);
  if (unpackedTotal > MAX_UNPACKED_BYTES) throw new Error('Распакованный размер игры превышает 900 МБ. Раздели контент или уменьши размер сборки.');
  if (selected.length > MAX_FILES) throw new Error('В игре слишком много файлов.');
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      const free = (estimate.quota || 0) - (estimate.usage || 0);
      if (free && unpackedTotal > free * 0.9) throw new Error('В браузере недостаточно доступного хранилища. Освободи место на iPhone и попробуй снова.');
    } catch (error) { if (error.message.includes('недостаточно')) throw error; }
  }
  const gameId = (crypto.randomUUID ? crypto.randomUUID() : `g${Date.now()}${Math.random().toString(16).slice(2)}`).replace(/[^a-zA-Z0-9-]/g, '');
  const game = { id: gameId, name: base64SafeTitle(file.name), sourceName: file.name, addedAt: Date.now(), size: unpackedTotal, fileCount: selected.length, mainFile: 'index.html' };
  let stored = 0;
  try {
    for (let i = 0; i < selected.length; i++) {
      if (state.cancelImport) throw new Error('Импорт отменён.');
      const entry = selected[i];
      let data = await inflateEntry(file, entry);
      if (entry.path.toLowerCase() === 'index.html') {
        const decoder = new TextDecoder('utf-8');
        const encoder = new TextEncoder();
        const html = injectIsolation(decoder.decode(data), gameId);
        data = encoder.encode(html).buffer;
      }
      await putGameFile(gameId, entry.path, data);
      stored += 1;
      if (i % 4 === 0 || i === selected.length - 1) {
        const pct = Math.round((stored / selected.length) * 100);
        setProgress(pct, `Сохранено ${stored.toLocaleString('ru-RU')} из ${selected.length.toLocaleString('ru-RU')} файлов…`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    await putGame(game);
  } catch (error) {
    await cleanupFiles(gameId);
    throw error;
  }
  closeModal('progressModal');
  await refreshGames();
  showToast('Игра добавлена в библиотеку.');
}

function formatBytes(bytes) {
  if (!bytes) return '0 МБ';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} ГБ` : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} МБ`;
}

function formatDate(timestamp) {
  try { return new Date(timestamp).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch (_) { return ''; }
}

function createGameCard(game) {
  const card = document.createElement('article');
  card.className = 'game-card';
  const cover = document.createElement('div');
  cover.className = 'game-cover';
  const chip = document.createElement('span');
  chip.className = 'cover-chip';
  chip.textContent = 'REN\'PY WEB';
  const letter = document.createElement('span');
  letter.className = 'cover-letter';
  letter.textContent = game.name.slice(0, 1).toUpperCase();
  cover.append(chip, letter);
  const content = document.createElement('div');
  content.className = 'card-content';
  const name = document.createElement('div');
  name.className = 'game-name'; name.textContent = game.name; name.title = game.name;
  const details = document.createElement('div');
  details.className = 'game-details';
  const size = document.createElement('span'); size.textContent = formatBytes(game.size);
  const date = document.createElement('span'); date.textContent = formatDate(game.addedAt);
  details.append(size, date);
  const actions = document.createElement('div'); actions.className = 'card-actions';
  const launch = document.createElement('button'); launch.className = 'launch-button'; launch.type = 'button'; launch.textContent = '▶ Играть'; launch.addEventListener('click', () => launchGame(game));
  const remove = document.createElement('button'); remove.className = 'delete-button'; remove.type = 'button'; remove.textContent = '⋯'; remove.setAttribute('aria-label', `Удалить ${game.name}`); remove.title = 'Удалить игру';
  remove.addEventListener('click', async () => {
    if (!confirm(`Удалить «${game.name}» из библиотеки и стереть её локальные файлы?`)) return;
    try { await removeGame(game.id); await refreshGames(); showToast('Игра удалена.'); }
    catch (error) { showMessage('Не удалось удалить', error.message); }
  });
  actions.append(launch, remove);
  content.append(name, details, actions);
  card.append(cover, content);
  return card;
}

async function refreshGames() {
  state.games = await getAllGames();
  state.games.sort((a, b) => state.ascending ? a.addedAt - b.addedAt : b.addedAt - a.addedAt);
  el('gameCount').textContent = state.games.length;
  el('emptyState').hidden = state.games.length !== 0;
  el('gameGrid').replaceChildren(...state.games.map(createGameCard));
}

function getGameURL(game) {
  const segments = ['__game__', game.id, game.mainFile || 'index.html'].map(segment => encodeURIComponent(segment));
  return new URL(segments.join('/'), APP_BASE).href;
}

async function launchGame(game) {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
    showMessage('Нужна перезагрузка', 'Плеер подключает локальный игровой сервер при первом открытии. Обнови страницу и нажми «Играть» ещё раз.');
    return;
  }
  state.activeGame = game;
  el('playingTitle').textContent = game.name;
  el('gameFrame').src = getGameURL(game);
  el('playerScreen').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeGame() {
  el('gameFrame').src = 'about:blank';
  el('playerScreen').hidden = true;
  document.body.style.overflow = '';
  state.activeGame = null;
}

async function registerWorker() {
  if (!('serviceWorker' in navigator)) {
    showMessage('Нужен современный браузер', 'Для запуска Web-игр и установки плеера нужен актуальный Safari или другой браузер с поддержкой Service Worker.');
    return;
  }
  try {
    state.registration = await navigator.serviceWorker.register(new URL('sw.js', APP_BASE), { scope: APP_BASE.pathname, updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      const reloadKey = 'renpy-player-sw-reload';
      if (!sessionStorage.getItem(reloadKey)) {
        sessionStorage.setItem(reloadKey, '1');
        location.reload();
      } else {
        showToast('Обнови страницу, чтобы включить запуск игр.');
      }
    } else {
      sessionStorage.removeItem('renpy-player-sw-reload');
    }
  } catch (error) {
    showMessage('Не удалось включить офлайн-режим', `Плеер должен быть открыт через HTTPS. Детали: ${error.message || error}`);
  }
}

function bindEvents() {
  const openPicker = () => el('zipInput').click();
  el('addButton').addEventListener('click', openPicker);
  el('emptyAddButton').addEventListener('click', openPicker);
  el('zipInput').addEventListener('change', async event => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try { await importZip(file); }
    catch (error) { closeModal('progressModal'); showMessage('Не удалось добавить игру', error.message || 'Неизвестная ошибка'); }
  });
  el('cancelImport').addEventListener('click', () => { state.cancelImport = true; });
  el('messageClose').addEventListener('click', () => closeModal('messageModal'));
  el('installHelp').addEventListener('click', () => { el('helpModal').hidden = false; });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.close)));
  el('aboutButton').addEventListener('click', () => showMessage('Что запускает плеер', 'Только готовые Ren\'Py Web/HTML5-сборки: ZIP должен содержать index.html, файл .wasm и game.zip или game.data. Обычные Windows/Linux/macOS-сборки, исходники .rpy и отдельные .rpa здесь не запускаются. Web-порт Ren\'Py имеет ограничения: нет Python threading и произвольных сетевых запросов; видео и звук зависят от форматов браузера.', 'i'));
  el('sortButton').addEventListener('click', () => {
    state.ascending = !state.ascending;
    el('sortButton').innerHTML = state.ascending ? 'Старые <span>↑</span>' : 'Новые <span>↓</span>';
    refreshGames();
  });
  el('closeGame').addEventListener('click', closeGame);
  el('reloadGame').addEventListener('click', () => { if (state.activeGame) el('gameFrame').src = getGameURL(state.activeGame); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !el('playerScreen').hidden) closeGame(); });
}

async function start() {
  bindEvents();
  try {
    state.db = await openDatabase();
    await refreshGames();
    await registerWorker();
  } catch (error) {
    showMessage('Проблема с хранилищем', `Не удалось открыть библиотеку игр. Выйди из приватного режима Safari и попробуй снова. ${error.message || ''}`);
  }
}

start();
