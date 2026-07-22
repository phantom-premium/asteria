'use strict';

// Фикс для мобильных браузеров: 100vh не учитывает появляющуюся/скрывающуюся
// адресную строку и системную панель навигации, из-за чего интерфейс "уезжает"
// под них. Считаем реальную высоту через innerHeight (и visualViewport, если
// доступен — он точнее всего отражает видимую область с учётом клавиатуры).
function setRealViewportHeight() {
  const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  document.documentElement.style.setProperty('--vh', (h * 0.01) + 'px');
}
setRealViewportHeight();
window.addEventListener('resize', setRealViewportHeight);
window.addEventListener('orientationchange', () => setTimeout(setRealViewportHeight, 250));
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', setRealViewportHeight);
}

// ---------- Тема оформления ----------
// state.user.theme (когда пользователь авторизован) — источник истины,
// привязан к аккаунту и приходит с сервера при каждом открытии вкладки
// (см. onAuthed). localStorage используется только как кэш для мгновенной
// отрисовки правильной темы ДО того, как придёт ответ /api/me — чтобы не
// было вспышки не той темы при открытии новой вкладки.
const THEME_STORAGE_KEY = 'asteria_theme_pref';
let currentThemePref = 'light';

function resolveTheme(pref) {
  if (!pref || pref === 'system') {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  return pref;
}

function applyThemePref(pref) {
  currentThemePref = pref || 'light';
  document.documentElement.dataset.theme = resolveTheme(currentThemePref);
  try { localStorage.setItem(THEME_STORAGE_KEY, currentThemePref); } catch (e) {}
  if (typeof highlightActiveThemeSwatch === 'function') highlightActiveThemeSwatch();
}

// применяем как можно раньше — до логина, до ответа сервера
try { applyThemePref(localStorage.getItem(THEME_STORAGE_KEY) || 'light'); } catch (e) { applyThemePref('light'); }

// если выбран режим «как в системе» — переключаемся вживую при смене темы ОС
if (window.matchMedia) {
  const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemThemeChange = () => { if (currentThemePref === 'system') applyThemePref('system'); };
  if (systemThemeQuery.addEventListener) systemThemeQuery.addEventListener('change', onSystemThemeChange);
  else if (systemThemeQuery.addListener) systemThemeQuery.addListener(onSystemThemeChange);
}

const state = {
  user: null,
  conversations: [],
  folders: [],
  activeFolderId: null,
  activeSection: 'chats',
  activeConvId: null,
  messages: {}, // convId -> [messages]
  usersById: {},
  ws: null,
  peerConn: null,
  localStream: null,
  currentCallPeerId: null,
  circleRecorder: null,
  circleChunks: [],
  circleStream: null,
  voiceRecorder: null,
  voiceChunks: [],
  voiceStream: null,
  voiceStartedAt: 0,
  voiceTimerInt: null,
  typingTimeout: null,
  pendingImageFile: null,
  micOn: true,
  camOn: true,
  hasCamera: false,
  currentFacingMode: 'user',
  remoteCamOn: false,
  callStartedAt: 0,
  callTimerInt: null,
};

const STICKERS = ['😀','😂','😍','😎','🥳','😢','😡','👍','👎','🔥','🎉','❤️','💯','🙏','👀','🤔','😴','🤩','😱','👏','🚀','✨','🌟','🍕','☕','🐱','🐶','⚡','🌈','🎵'];
const REACTIONS = ['👍','👎','❤️','😂','😮','😢','🔥'];

function $(sel) { return document.querySelector(sel); }
function showModal(sel) { const el = typeof sel === 'string' ? $(sel) : sel; if (el) { document.body.appendChild(el); el.classList.remove('hidden'); } return el; }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

function avatarStyle(user) {
  if (user && user.avatar) return `background-image:url('${user.avatar}')`;
  return '';
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Синяя галочка у верифицированных админом пользователей — рисуется рядом с
// именем везде, где имя выводится через innerHTML (шапка чата, сообщения,
// профиль, поиск людей, админ-панель и т.д.)
function verifiedBadge(u) {
  return u && u.isVerified ? '<span class="verified-badge" title="Аккаунт подтверждён администратором">✔️</span>' : '';
}

function isMobile() { return window.matchMedia('(max-width: 860px)').matches; }

// Универсальный helper: различает обычное нажатие (onTap) и удержание (onLongPress).
// Работает и с мышью, и с тачем через Pointer Events.
function attachLongPress(el, onLongPress, onTap, duration = 480) {
  let timer = null, longFired = false, moved = false, sx = 0, sy = 0;
  const clear = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    longFired = false; moved = false;
    sx = e.clientX; sy = e.clientY;
    clear();
    timer = setTimeout(() => { longFired = true; onLongPress(e); }, duration);
  });
  el.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) { moved = true; clear(); }
  });
  el.addEventListener('pointerup', () => { clear(); if (!longFired && !moved) onTap(); });
  el.addEventListener('pointerleave', clear);
  el.addEventListener('pointercancel', clear);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // если было удержание — гасим последующий click, чтобы не сработали вложенные обработчики (например, лайтбокс)
  el.addEventListener('click', (e) => { if (longFired) { e.preventDefault(); e.stopPropagation(); } }, true);
}

async function getMedia(constraints, opts = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (!opts.silent) alert('Браузер не поддерживает доступ к камере/микрофону, либо сайт открыт не по HTTPS/localhost.');
    throw new Error('getUserMedia unsupported');
  }
  try {
    // Само обращение к getUserMedia — это то, что показывает нативный запрос
    // браузера «Сайт хочет использовать вашу камеру/микрофон». Просто вызываем
    // его с нужными constraints и ждём решения пользователя.
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (opts.silent) throw err;
    let msg = 'Не удалось получить доступ к камере/микрофону.';
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      msg = 'Доступ запрещён. Разрешите доступ к камере/микрофону для этого сайта в настройках браузера (значок 🔒/ⓘ рядом с адресом) и попробуйте снова.';
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      msg = 'Камера или микрофон не найдены на этом устройстве.';
    } else if (err.name === 'NotReadableError') {
      msg = 'Камера или микрофон уже используются другим приложением.';
    } else if (err.name === 'SecurityError') {
      msg = 'Браузер блокирует доступ к камере/микрофону вне HTTPS. Откройте сайт по localhost или включите флаг для локального IP (см. README).';
    }
    alert(msg);
    throw err;
  }
}

/* ---------------- AUTH ---------------- */

$all('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $all('.auth-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const isLogin = tab.dataset.tab === 'login';
    $('#loginForm').classList.toggle('hidden', !isLogin);
    $('#registerForm').classList.toggle('hidden', isLogin);
  });
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    const { user } = await api('/api/login', {
      method: 'POST',
      body: { username: $('#loginUsername').value.trim(), password: $('#loginPassword').value },
    });
    onAuthed(user);
    await handleDeepLinkIfPresent();
  } catch (err) { $('#loginError').textContent = err.message; }
});

$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#regError').textContent = '';
  try {
    const { user } = await api('/api/register', {
      method: 'POST',
      body: {
        username: $('#regUsername').value.trim(),
        password: $('#regPassword').value,
        displayName: $('#regDisplayName').value.trim(),
      },
    });
    onAuthed(user);
    await handleDeepLinkIfPresent();
  } catch (err) { $('#regError').textContent = err.message; }
});

async function checkSession() {
  try {
    const { user } = await api('/api/me');
    onAuthed(user);
    await handleDeepLinkIfPresent();
  } catch (e) {
    $('#authScreen').classList.remove('hidden');
    $('#appScreen').classList.add('hidden');
  }
}

// Свой фон в чатах, привязанный к аккаунту: пусто/undefined — используем
// встроенный по умолчанию (см. --chat-wallpaper в :root, style.css); если у
// пользователя есть загруженная картинка — подставляем её через инлайн-стиль,
// который перекрывает значение из :root для всего документа.
function applyWallpaperPref(url) {
  if (url) document.documentElement.style.setProperty('--chat-wallpaper', `url('${url}')`);
  else document.documentElement.style.removeProperty('--chat-wallpaper');
}

function onAuthed(user) {
  state.user = user;
  applyThemePref(user.theme || 'light');
  applyWallpaperPref(user.chatWallpaper || '');
  $('#authScreen').classList.add('hidden');
  $('#appScreen').classList.remove('hidden');
  renderMyAvatar();
  $('#adminNavBtn').classList.toggle('hidden', !user.isAdmin);
  $('#openAdminFromSettingsBtn').classList.toggle('hidden', !user.isAdmin);
  connectWS();
  loadConversations();
  loadStories();
  requestNotificationPermission();
  switchSection('chats');
}

/* ---------------- НАВИГАЦИЯ ПО РАЗДЕЛАМ (Чаты/Звонки/Настройки/Админ) ---------------- */

function switchSection(name) {
  const previous = state.activeSection;
  const subpages = ['profile', 'channel'];
  if (subpages.includes(name) && !subpages.includes(previous)) state.subpageReturnSection = previous || 'chats';
  state.activeSection = name;
  ['chats', 'calls', 'settings', 'admin', 'profile', 'channel'].forEach((s) => {
    $('#section' + s.charAt(0).toUpperCase() + s.slice(1)).classList.toggle('hidden', s !== name);
  });
  $all('.nav-rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.section === name));
  $all('.bottom-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.section === name));

  if (name === 'calls') loadCallHistory();
  if (name === 'settings') openSettingsPage();
  if (name === 'admin') openAdminPanel();
}

$all('.nav-rail-btn[data-section]').forEach((btn) => btn.addEventListener('click', () => switchSection(btn.dataset.section)));
$all('.bottom-nav-btn[data-section]').forEach((btn) => btn.addEventListener('click', () => switchSection(btn.dataset.section)));
$('#myAvatar').addEventListener('click', () => switchSection('settings'));
$('#adminBackBtn').addEventListener('click', () => switchSection('chats'));
$('#profileBackBtn').addEventListener('click', () => switchSection(state.subpageReturnSection || 'chats'));
$('#channelBackBtn').addEventListener('click', () => switchSection(state.subpageReturnSection || 'chats'));
$('#openAdminFromSettingsBtn').addEventListener('click', () => switchSection('admin'));

function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function notifyNewMessage(message) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (message.senderId === state.user.id) return;
  const isViewingThisChat = state.activeSection === 'chats' && state.activeConvId === message.conversationId && document.visibilityState === 'visible' && document.hasFocus();
  if (isViewingThisChat) return;
  const conv = state.conversations.find((c) => c.id === message.conversationId);
  const title = conv ? (conv.type === 'channel' ? `📢 ${conv.name}` : conv.type === 'group' ? `👥 ${conv.name}` : (conv.peer ? (conv.peerNickname || conv.peer.displayName) : 'Asteria')) : 'Asteria';
  const body = previewText(message);
  try {
    const n = new Notification(title, { body, tag: message.conversationId, renotify: true });
    n.onclick = () => {
      window.focus();
      switchSection('chats');
      openConversation(message.conversationId);
      n.close();
    };
  } catch (e) { /* уведомления недоступны — просто игнорируем */ }
}

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
});

/* ---------------- WEBSOCKET ---------------- */

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/`);
  state.ws = ws;
  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    handleWSEvent(msg);
  });
  ws.addEventListener('close', () => { setTimeout(connectWS, 2000); });
}

function handleWSEvent(msg) {
  if (msg.type === 'message') {
    const convId = msg.message.conversationId;
    if (!state.messages[convId]) state.messages[convId] = [];
    state.messages[convId].push(msg.message);
    bumpConversation(convId, msg.message);
    if (state.activeConvId === convId) appendMessageBubble(msg.message);
    else renderConvList();
    notifyNewMessage(msg.message);
  } else if (msg.type === 'message-edit') {
    const convId = msg.message.conversationId;
    const list = state.messages[convId];
    if (list) {
      const idx = list.findIndex((m) => m.id === msg.message.id);
      if (idx !== -1) list[idx] = msg.message;
    }
    if (state.activeConvId === convId) renderMessages();
    const cIdx = state.conversations.findIndex((c) => c.id === convId);
    if (cIdx !== -1 && state.conversations[cIdx].pinnedMessage && state.conversations[cIdx].pinnedMessage.id === msg.message.id) {
      state.conversations[cIdx].pinnedMessage = msg.message;
      if (state.activeConvId === convId) renderPinnedBar(state.conversations[cIdx]);
    }
  } else if (msg.type === 'pin-update') {
    const cIdx = state.conversations.findIndex((c) => c.id === msg.conversationId);
    if (cIdx !== -1) {
      state.conversations[cIdx] = { ...state.conversations[cIdx], pinnedMessage: msg.pinnedMessage, pinnedMessageId: msg.pinnedMessage ? msg.pinnedMessage.id : null };
      if (state.activeConvId === msg.conversationId) renderPinnedBar(state.conversations[cIdx]);
    }
  } else if (msg.type === 'message-delete') {
    const list = state.messages[msg.conversationId];
    if (list) {
      const idx = list.findIndex((m) => m.id === msg.messageId);
      if (idx !== -1) list.splice(idx, 1);
    }
    if (state.activeConvId === msg.conversationId) renderMessages();
  } else if (msg.type === 'reaction-update') {
    const list = state.messages[msg.conversationId];
    if (list) {
      const m = list.find((mm) => mm.id === msg.messageId);
      if (m) m.reactions = msg.reactions;
    }
    if (state.activeConvId === msg.conversationId) renderMessages();
  } else if (msg.type === 'poll-update') {
    const list = state.messages[msg.conversationId];
    if (list) {
      const m = list.find((mm) => mm.id === msg.messageId);
      if (m && m.meta) m.meta = { ...m.meta, votes: msg.votes };
    }
    if (state.activeConvId === msg.conversationId) renderMessages();
  } else if (msg.type === 'conversation-updated') {
    mergeConversation(msg.conversation);
  } else if (msg.type === 'conversation-deleted') {
    state.conversations = state.conversations.filter((c) => c.id !== msg.conversationId);
    if (state.activeConvId === msg.conversationId) {
      closeActiveChat();
      alert('Этот чат/канал был удалён');
    }
    renderConvList();
  } else if (msg.type === 'admin-granted') {
    state.user.isAdmin = true;
    $('#adminNavBtn').classList.remove('hidden');
    $('#openAdminFromSettingsBtn').classList.remove('hidden');
    alert('🔑 Вам выданы права администратора! В меню слева (или в Настройках на телефоне) появился раздел «Админ».');
  } else if (msg.type === 'admin-revoked') {
    state.user.isAdmin = false;
    $('#adminNavBtn').classList.add('hidden');
    $('#openAdminFromSettingsBtn').classList.add('hidden');
    if (state.activeSection === 'admin') switchSection('chats');
  } else if (msg.type === 'account-deleted') {
    alert('Ваш аккаунт был удалён администратором.');
    location.reload();
  } else if (msg.type === 'typing') {
    if (state.activeConvId === msg.conversationId) {
      $('#typingIndicator').classList.remove('hidden');
      clearTimeout(state.typingTimeout);
      state.typingTimeout = setTimeout(() => $('#typingIndicator').classList.add('hidden'), 2000);
    }
  } else if (msg.type === 'presence') {
    const c = state.conversations.find((c) => c.peer && c.peer.id === msg.userId);
    if (c) { c.peer.online = msg.online; if (state.activeConvId === c.id) renderChatHeader(c); }
  } else if (['call-offer','call-answer','call-ice','call-end','call-decline','call-media-toggle'].includes(msg.type)) {
    handleCallSignal(msg);
  } else if (msg.type === 'group-call-count') {
    const conv = state.conversations.find((c) => c.id === msg.conversationId);
    if (conv) conv.groupCallCount = msg.count;
    if (state.activeConvId === msg.conversationId) updateGroupCallButton(conv);
  } else if (['group-call-state','group-call-peer-joined','group-call-peer-left','group-call-offer','group-call-answer','group-call-ice'].includes(msg.type)) {
    handleGroupCallSignal(msg);
  }
}

function mergeConversation(patch) {
  const conv = state.conversations.find((c) => c.id === patch.id);
  if (conv) Object.assign(conv, patch);
  renderConvList();
  if (state.activeConvId === patch.id) {
    renderChatHeader(conv || patch);
    updateComposerVisibility(conv || patch);
  }
}

function bumpConversation(convId, message) {
  let conv = state.conversations.find((c) => c.id === convId);
  if (conv) { conv.lastMessage = message; conv.lastMessageAt = message.createdAt; }
  sortConversations();
  renderConvList();
}

/* ---------------- CONVERSATIONS ---------------- */

async function loadConversations() {
  const { conversations } = await api('/api/conversations');
  state.conversations = conversations;
  sortConversations();
  await loadFolders();
  renderFolderTabs();
  renderConvList();
}

function isPinned(conv) {
  return !!(conv.pinnedBy || []).includes(state.user.id);
}

function sortConversations() {
  state.conversations.sort((a, b) => {
    const pa = isPinned(a) ? 1 : 0;
    const pb = isPinned(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.lastMessageAt || 0) - (a.lastMessageAt || 0);
  });
}

async function togglePin(conv) {
  const pinned = !isPinned(conv);
  try {
    const { conversation } = await api(`/api/conversations/${conv.id}/pin`, { method: 'POST', body: { pinned } });
    mergeConversation(conversation);
    sortConversations();
    renderConvList();
  } catch (err) { alert(err.message); }
}

function convTitle(conv) {
  if (conv.type === 'channel' || conv.type === 'group') return conv.name;
  return conv.peer ? (conv.peerNickname || conv.peer.displayName) : '?';
}

function visibleConversations() {
  if (!state.activeFolderId) return state.conversations;
  const folder = state.folders.find((f) => f.id === state.activeFolderId);
  if (!folder) return state.conversations;
  const idSet = new Set(folder.convIds || []);
  return state.conversations.filter((c) => idSet.has(c.id));
}

function buildConvItem(conv) {
  const pinned = isPinned(conv);
  const div = document.createElement('div');
  div.className = 'conv-item' + (conv.id === state.activeConvId ? ' active' : '') + (pinned ? ' pinned' : '');
  const av = document.createElement('div');
  av.className = 'avatar';
  const title = convTitle(conv);
  const dmAvatarUrl = conv.type === 'dm' && conv.peer ? conv.peer.avatar : '';
  const chAvatarUrl = (conv.type === 'channel' || conv.type === 'group') ? conv.avatar : '';
  const avatarUrl = dmAvatarUrl || chAvatarUrl;
  if (avatarUrl) {
    av.style.cssText = avatarStyle(conv.type === 'dm' ? conv.peer : conv);
  } else {
    av.textContent = initials(title);
  }
  div.appendChild(av);
  const meta = document.createElement('div');
  meta.className = 'conv-meta';
  const preview = conv.lastMessage ? previewText(conv.lastMessage) : (conv.type === 'channel' ? 'Канал' : conv.type === 'group' ? 'Группа' : 'Нет сообщений');
  const nameBadge = conv.type === 'dm' ? verifiedBadge(conv.peer) : '';
  const typeIcon = conv.type === 'channel' ? ' 📢' : conv.type === 'group' ? ' 👥' : '';
  meta.innerHTML = `<div class="conv-name"><span>${pinned ? '📌 ' : ''}${escapeHtml(title)}${nameBadge}${typeIcon}</span></div><div class="conv-last">${escapeHtml(preview)}</div>`;
  div.appendChild(meta);

  const pinBtn = document.createElement('button');
  pinBtn.className = 'conv-pin-btn';
  pinBtn.title = pinned ? 'Открепить' : 'Закрепить';
  pinBtn.textContent = pinned ? '📌' : '📍';
  pinBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePin(conv); });
  div.appendChild(pinBtn);

  attachLongPress(div, (e) => openConvContextMenu(e, conv), () => openConversation(conv.id));
  return div;
}

function renderConvList() {
  const el = $('#convList');
  el.innerHTML = '';
  visibleConversations().forEach((conv) => el.appendChild(buildConvItem(conv)));
}

// ---- Единый поиск: свои чаты (локально) + глобальный поиск по каналам ----
let chatsSearchChannelsCache = null;
let chatsSearchDebounce = null;
function chatsSearchActive() { return $('#chatsGlobalSearchInput').value.trim().length > 0; }
async function runChatsSearch() {
  const q = $('#chatsGlobalSearchInput').value.trim();
  const resEl = $('#chatsSearchResults');
  if (!q) {
    resEl.classList.add('hidden');
    $('#chatsDefaultView').classList.remove('hidden');
    return;
  }
  $('#chatsDefaultView').classList.add('hidden');
  resEl.classList.remove('hidden');
  const qLower = q.toLowerCase();

  const localMatches = state.conversations.filter((c) => convTitle(c).toLowerCase().includes(qLower));

  if (!chatsSearchChannelsCache) {
    try { chatsSearchChannelsCache = (await api('/api/channels')).channels; } catch (e) { chatsSearchChannelsCache = []; }
  }
  const localIds = new Set(state.conversations.map((c) => c.id));
  const channelMatches = chatsSearchChannelsCache.filter((c) => !localIds.has(c.id) && c.name.toLowerCase().includes(qLower));

  resEl.innerHTML = '';
  if (localMatches.length) {
    const hdr = document.createElement('div');
    hdr.className = 'chat-header-sub';
    hdr.style.padding = '8px';
    hdr.textContent = 'Ваши чаты';
    resEl.appendChild(hdr);
    localMatches.forEach((conv) => resEl.appendChild(buildConvItem(conv)));
  }
  if (channelMatches.length) {
    const hdr = document.createElement('div');
    hdr.className = 'chat-header-sub';
    hdr.style.padding = '8px';
    hdr.textContent = 'Каналы (глобальный поиск)';
    resEl.appendChild(hdr);
    channelMatches.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'channel-row';
      row.innerHTML = `<div class="avatar" style="${c.avatar ? avatarStyle(c) : ''}">${c.avatar ? '' : initials(c.name)}</div><div>${escapeHtml(c.name)} 📢</div>`;
      row.addEventListener('click', async () => {
        await api(`/api/conversations/${c.id}/subscribe`, { method: 'POST' });
        await loadConversations();
        $('#chatsGlobalSearchInput').value = '';
        runChatsSearch();
        openConversation(c.id);
      });
      resEl.appendChild(row);
    });
  }
  if (!localMatches.length && !channelMatches.length) {
    resEl.innerHTML = '<div class="chat-header-sub" style="padding:8px;">Ничего не найдено</div>';
  }
}
$('#chatsGlobalSearchInput').addEventListener('input', () => {
  clearTimeout(chatsSearchDebounce);
  chatsSearchDebounce = setTimeout(runChatsSearch, 200);
});

function openConvContextMenu(evt, conv) {
  const menu = $('#convContextMenu');
  const pinned = isPinned(conv);
  menu.innerHTML = `<button data-act="pin">${pinned ? '📌 Открепить' : '📌 Закрепить'}</button>`;
  menu.querySelector('[data-act="pin"]').addEventListener('click', () => {
    togglePin(conv);
    closeConvContextMenu();
  });
  $('#convContextBackdrop').classList.remove('hidden');
  menu.classList.remove('hidden');
  const x = evt.clientX || 40;
  const y = evt.clientY || 40;
  requestAnimationFrame(() => {
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
  });
}

function closeConvContextMenu() {
  $('#convContextMenu').classList.add('hidden');
  $('#convContextBackdrop').classList.add('hidden');
}
$('#convContextBackdrop').addEventListener('click', closeConvContextMenu);

/* ---------------- FOLDERS (папки чатов) ---------------- */

async function loadFolders() {
  const { folders } = await api('/api/folders');
  state.folders = folders;
  if (state.activeFolderId && !folders.find((f) => f.id === state.activeFolderId)) {
    state.activeFolderId = null;
  }
}

function renderFolderTabs() {
  const el = $('#folderTabs');
  el.innerHTML = '';
  const allTab = document.createElement('button');
  allTab.className = 'folder-tab' + (state.activeFolderId ? '' : ' active');
  allTab.textContent = 'Все чаты';
  allTab.addEventListener('click', () => { state.activeFolderId = null; renderFolderTabs(); renderConvList(); });
  el.appendChild(allTab);

  state.folders.forEach((f) => {
    const tab = document.createElement('button');
    tab.className = 'folder-tab' + (state.activeFolderId === f.id ? ' active' : '');
    tab.textContent = f.name;
    tab.addEventListener('click', () => { state.activeFolderId = f.id; renderFolderTabs(); renderConvList(); });
    el.appendChild(tab);
  });
}

function renderFoldersInSettings() {
  const el = $('#foldersListSettings');
  el.innerHTML = '';
  if (!state.folders.length) {
    el.innerHTML = '<div class="chat-header-sub" style="padding:8px;">Пока нет ни одной папки</div>';
  }
  state.folders.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.innerHTML = `
      <div class="grow">
        <div class="name">🗂 ${escapeHtml(f.name)}</div>
        <div class="sub">${(f.convIds || []).length} чатов</div>
      </div>
      <button class="btn-secondary" data-open-folder="${f.id}">Изменить</button>
    `;
    el.appendChild(row);
  });
  el.querySelectorAll('[data-open-folder]').forEach((btn) => {
    btn.addEventListener('click', () => openFolderEditModal(btn.dataset.openFolder));
  });
}

$('#createFolderBtn').addEventListener('click', () => {
  openFolderEditModal(null);
});

let editingFolderId = null;
function openFolderEditModal(folderId) {
  editingFolderId = folderId;
  const folder = folderId ? state.folders.find((f) => f.id === folderId) : null;
  $('#folderNameInput').value = folder ? folder.name : '';
  $('#deleteFolderBtn').classList.toggle('hidden', !folder);
  const checklist = $('#folderConvChecklist');
  checklist.innerHTML = '';
  const selectedIds = new Set(folder ? (folder.convIds || []) : []);
  state.conversations.forEach((conv) => {
    const row = document.createElement('div');
    row.className = 'folder-conv-check-row';
    const title = convTitle(conv);
    const favSubject = conv.type === 'dm' ? conv.peer : conv;
    const favUrl = favSubject && favSubject.avatar;
    row.innerHTML = `<label><input type="checkbox" value="${conv.id}" ${selectedIds.has(conv.id) ? 'checked' : ''}><span class="avatar" style="width:28px;height:28px;font-size:12px;${favUrl ? avatarStyle(favSubject) : ''}">${favUrl ? '' : initials(title)}</span>${escapeHtml(title)}</label>`;
    checklist.appendChild(row);
  });
  showModal('#folderEditModal');
}

$('#saveFolderBtn').addEventListener('click', async () => {
  const name = $('#folderNameInput').value.trim();
  if (!name) { alert('Укажите название папки'); return; }
  const convIds = $all('#folderConvChecklist input[type=checkbox]:checked').map((c) => c.value);
  try {
    if (editingFolderId) {
      await api(`/api/folders/${editingFolderId}`, { method: 'PATCH', body: { name, convIds } });
    } else {
      await api('/api/folders', { method: 'POST', body: { name, convIds } });
    }
    $('#folderEditModal').classList.add('hidden');
    await loadFolders();
    renderFolderTabs();
    renderConvList();
    renderFoldersInSettings();
  } catch (err) { alert(err.message); }
});

$('#deleteFolderBtn').addEventListener('click', async () => {
  if (!editingFolderId) return;
  if (!confirm('Удалить эту папку? Сами чаты при этом не удаляются.')) return;
  try {
    await api(`/api/folders/${editingFolderId}`, { method: 'DELETE' });
    $('#folderEditModal').classList.add('hidden');
    if (state.activeFolderId === editingFolderId) state.activeFolderId = null;
    await loadFolders();
    renderFolderTabs();
    renderConvList();
    renderFoldersInSettings();
  } catch (err) { alert(err.message); }
});

function previewText(m) {
  const map = { text: m.content, image: '📷 Фото', video: '🎬 Видео', file: '📄 Файл', music: '🎵 Музыка', voice: '🎙 Голосовое', video_circle: '⭕ Видео-сообщение', sticker: '😊 Стикер', poll: '📊 Опрос' };
  return map[m.msgType] || m.content || '';
}

async function openConversation(convId) {
  state.activeConvId = convId;
  $('#chatEmpty').classList.add('hidden');
  $('#chatActive').classList.remove('hidden');
  if (isMobile()) {
    $('#sectionChats').classList.add('chat-open');
    $('#appScreen').classList.add('chat-open');
  }
  renderConvList();
  const conv = state.conversations.find((c) => c.id === convId);
  renderChatHeader(conv);
  updateComposerVisibility(conv);
  if (!state.messages[convId]) {
    const { messages } = await api(`/api/conversations/${convId}/messages`);
    state.messages[convId] = messages;
  }
  renderMessages();
}

function closeActiveChat() {
  state.activeConvId = null;
  $('#chatEmpty').classList.remove('hidden');
  $('#chatActive').classList.add('hidden');
  $('#sectionChats').classList.remove('chat-open');
  $('#appScreen').classList.remove('chat-open');
  renderConvList();
}

$('#backToListBtn').addEventListener('click', () => {
  $('#sectionChats').classList.remove('chat-open');
  $('#appScreen').classList.remove('chat-open');
});

function canPostInConv(conv) {
  if (!conv) return false;
  if (conv.type === 'dm' || conv.type === 'group') return true;
  return conv.ownerId === state.user.id || !!state.user.isAdmin;
}
function isSubscribedTo(conv) {
  if (!conv || (conv.type !== 'channel' && conv.type !== 'group')) return true;
  return (conv.participants || []).includes(state.user.id);
}

function updateComposerVisibility(conv) {
  const showBar = conv && conv.type === 'channel' && isSubscribedTo(conv) && !canPostInConv(conv);
  $('#composer').classList.toggle('hidden', !!showBar);
  $('#channelSubscribedBar').classList.toggle('hidden', !showBar);
  updateSendOrRecordButton();
}

$('#unsubscribeFromBarBtn').addEventListener('click', async () => {
  if (!state.activeConvId) return;
  if (!confirm('Отписаться от этого канала?')) return;
  await api(`/api/conversations/${state.activeConvId}/unsubscribe`, { method: 'POST' });
  state.conversations = state.conversations.filter((c) => c.id !== state.activeConvId);
  closeActiveChat();
});

function renderChatHeader(conv) {
  const title = convTitle(conv);
  const sub = conv.type === 'channel' ? `${(conv.participants||[]).length} подписчиков` : conv.type === 'group' ? `${(conv.participants||[]).length} участников` : (conv.peer && conv.peer.online ? 'в сети' : (conv.peer && conv.peer.isBot ? 'бот' : 'не в сети'));
  const badge = conv.type === 'dm' ? verifiedBadge(conv.peer) : '';
  const headerAvatarSubject = conv.type === 'dm' ? conv.peer : conv;
  const headerAvatarUrl = headerAvatarSubject && headerAvatarSubject.avatar;
  $('#chatHeaderInfo').innerHTML = `<div class="avatar" style="${headerAvatarUrl ? avatarStyle(headerAvatarSubject) : ''}">${headerAvatarUrl ? '' : initials(title)}</div><div><div class="chat-header-name">${escapeHtml(title)}${badge}</div><div class="chat-header-sub">${escapeHtml(sub)}</div></div>`;
  renderPinnedBar(conv);
  const canCall = conv.type === 'dm' && conv.peer && !conv.peer.isBot;
  $('#audioCallBtn').style.display = canCall ? '' : 'none';
  $('#videoCallBtn').style.display = canCall ? '' : 'none';
  updateGroupCallButton(conv);
}

$('#chatHeaderInfo').addEventListener('click', () => {
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  if (!conv) return;
  if (conv.type === 'dm') openProfilePage(conv.peer.id);
  else openChannelPage(conv.id);
});

// Кто может закреплять/откреплять сообщения в этом чате: в личных чатах —
// любой участник, в каналах — только владелец канала или админ сайта.
function canPinInConversation(conv) {
  if (!conv) return false;
  if (conv.type === 'dm' || conv.type === 'group') return true;
  if (conv.type === 'channel') return conv.ownerId === state.user.id || state.user.isAdmin;
  return false;
}

function renderPinnedBar(conv) {
  const bar = $('#pinnedMessageBar');
  const pinned = conv.pinnedMessage;
  if (!pinned) {
    bar.classList.add('hidden');
    bar.onclick = null;
    return;
  }
  bar.classList.remove('hidden');
  const senderName = pinned.senderId === state.user.id ? 'Вы' : (findKnownUser(pinned.senderId) || {}).displayName || 'Сообщение';
  $('#pinnedMessageText').innerHTML = `<b>${escapeHtml(senderName)}:</b> ${escapeHtml(previewText(pinned))}`;
  $('#unpinMessageBtn').classList.toggle('hidden', !canPinInConversation(conv));
  bar.onclick = (e) => {
    if (e.target.closest('#unpinMessageBtn')) return;
    scrollToMessage(pinned.id);
  };
}

$('#unpinMessageBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!state.activeConvId) return;
  await togglePinMessage(state.activeConvId, null);
});

async function togglePinMessage(conversationId, messageId) {
  try {
    const { conversation } = await api(`/api/conversations/${conversationId}/pin-message`, { method: 'POST', body: { messageId } });
    const idx = state.conversations.findIndex((c) => c.id === conversationId);
    if (idx !== -1) state.conversations[idx] = { ...state.conversations[idx], pinnedMessage: conversation.pinnedMessage, pinnedMessageId: conversation.pinnedMessageId };
    if (state.activeConvId === conversationId) renderPinnedBar(state.conversations[idx] || conversation);
  } catch (e) { alert(e.message); }
}

function scrollToMessage(messageId) {
  const el = document.querySelector(`.msg-row[data-msg-id="${messageId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('msg-flash');
  setTimeout(() => el.classList.remove('msg-flash'), 1200);
}

/* ---------------- PROFILE PAGE ---------------- */

async function openProfilePage(userId) {
  const { user } = await api(`/api/users/${userId}`);
  const el = $('#profileViewContent');
  el.innerHTML = `
    <div class="my-avatar big" style="${avatarStyle(user)}">${user.avatar ? '' : initials(user.displayName)}</div>
    <div class="profile-name">${escapeHtml(user.displayName)}${verifiedBadge(user)}${user.isBot ? ' 🤖' : ''}</div>
    <div class="profile-username">@${escapeHtml(user.username)}</div>
    ${user.status ? `<div class="profile-status">${escapeHtml(user.status)}</div>` : ''}
    <div class="profile-meta">${user.online ? 'в сети' : 'На платформе с ' + fmtDate(user.createdAt)}</div>
    ${!user.isBot ? `<button class="btn-secondary" id="profileShareBtn">Поделиться профилем</button>` : ''}
  `;
  switchSection('profile');
  const shareBtn = $('#profileShareBtn');
  if (shareBtn) shareBtn.addEventListener('click', () => openShareModal(user.displayName, buildProfileLink(user.username)));
}

/* ---------------- CHANNEL PAGE ---------------- */

let channelEditAvatarUrl = '';

async function openChannelPage(convId) {
  const conv = state.conversations.find((c) => c.id === convId);
  if (!conv) return;
  const isOwner = conv.ownerId === state.user.id;
  const isAdmin = !!state.user.isAdmin;
  const isGroup = conv.type === 'group';
  const el = $('#channelViewContent');
  channelEditAvatarUrl = conv.avatar || '';
  $('#channelModalTitle').textContent = isGroup ? 'Группа' : 'Канал';

  const memberWord = isGroup ? 'участников' : 'подписчиков';
  const postingNote = isGroup ? '· писать могут все участники' : '· писать может только владелец';
  let html = `
    <div class="channel-info-row">
      <div class="avatar" id="channelInfoAvatar" style="${avatarStyle(conv)}">${conv.avatar ? '' : initials(conv.name)}</div>
      <div>
        <div class="channel-info-name">${escapeHtml(conv.name)}</div>
        <div class="channel-info-sub">${(conv.participants||[]).length} ${memberWord} ${postingNote}</div>
      </div>
    </div>`;

  if (conv.inviteCode) {
    const link = buildInviteLink(conv.inviteCode);
    html += `
      <div class="modal-subtitle">Пригласительная ссылка</div>
      <div class="compose-invite-link">${escapeHtml(link)}</div>
      <div class="settings-avatar-actions" style="flex-direction:row;">
        <button class="btn-secondary" id="channelCopyInviteBtn">Скопировать</button>
        <button class="btn-secondary" id="channelShareInviteBtn">Поделиться</button>
      </div>
      ${isOwner || isAdmin ? `<input type="text" id="channelEditInviteCode" value="${escapeHtml(conv.inviteCode)}" placeholder="Код ссылки">` : ''}`;
  }

  if (isOwner || isAdmin) {
    html += `
      <div class="channel-edit-fields">
        <div class="settings-avatar-actions" style="flex-direction:row;">
          <button class="btn-secondary" id="channelChangeAvatarBtn">Изменить фото</button>
          <button class="btn-danger" id="channelRemoveAvatarBtn">Удалить фото</button>
          <input type="file" id="channelAvatarInput" accept="image/*" class="hidden">
        </div>
        <input type="text" id="channelEditName" value="${escapeHtml(conv.name)}" placeholder="${isGroup ? 'Название группы' : 'Название канала'}">
        ${isGroup ? `<label class="checkbox-row"><input type="checkbox" id="channelEditGroupCalls" ${conv.groupCallsEnabled !== false ? 'checked' : ''}> Разрешить групповые звонки</label>` : ''}
        <button class="btn-primary" id="channelSaveBtn">Сохранить изменения</button>
      </div>
      <div class="channel-actions">
        <button class="btn-danger" id="channelDeleteBtn">${isGroup ? 'Удалить группу' : 'Удалить канал'}</button>
      </div>`;
  } else {
    const subscribed = isSubscribedTo(conv);
    const label = isGroup ? (subscribed ? '✓ Вы в группе — покинуть' : 'Вступить') : (subscribed ? '✓ Вы подписаны — отписаться' : 'Подписаться');
    html += `<div class="channel-actions">
      <button class="btn-secondary" id="channelSubToggleBtn">${label}</button>
    </div>`;
  }

  el.innerHTML = html;
  switchSection('channel');

  const copyInviteBtn = $('#channelCopyInviteBtn');
  if (copyInviteBtn) copyInviteBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(buildInviteLink(conv.inviteCode));
    copyInviteBtn.textContent = 'Скопировано!';
    setTimeout(() => { copyInviteBtn.textContent = 'Скопировать'; }, 1500);
  });
  const shareInviteBtn = $('#channelShareInviteBtn');
  if (shareInviteBtn) shareInviteBtn.addEventListener('click', () => openShareModal(conv.name, buildInviteLink(conv.inviteCode)));

  const changeAvBtn = $('#channelChangeAvatarBtn');
  if (changeAvBtn) changeAvBtn.addEventListener('click', () => $('#channelAvatarInput').click());
  const avInput = $('#channelAvatarInput');
  if (avInput) avInput.addEventListener('change', async () => {
    const file = avInput.files[0];
    if (!file) return;
    channelEditAvatarUrl = await uploadFile(file, 'avatar');
    const prev = $('#channelInfoAvatar');
    prev.style.cssText = `background-image:url('${channelEditAvatarUrl}')`;
    prev.textContent = '';
  });
  const removeAvBtn = $('#channelRemoveAvatarBtn');
  if (removeAvBtn) removeAvBtn.addEventListener('click', () => {
    channelEditAvatarUrl = '';
    const prev = $('#channelInfoAvatar');
    prev.style.cssText = '';
    prev.textContent = initials(conv.name);
  });

  const saveBtn = $('#channelSaveBtn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const name = $('#channelEditName').value.trim();
    const groupCallsCheckbox = $('#channelEditGroupCalls');
    const groupCallsEnabled = groupCallsCheckbox ? groupCallsCheckbox.checked : undefined;
    if (!name) return;
    const inviteEl = $('#channelEditInviteCode');
    const patchBody = { name, avatar: channelEditAvatarUrl };
    if (groupCallsEnabled !== undefined) patchBody.groupCallsEnabled = groupCallsEnabled;
    if (inviteEl && inviteEl.value.trim()) patchBody.inviteCode = inviteEl.value.trim();
    let conversation;
    try {
      ({ conversation } = await api(`/api/conversations/${convId}`, { method: 'PATCH', body: patchBody }));
    } catch (e) { alert(e.message || 'Не удалось сохранить'); return; }
    mergeConversation(conversation);
    switchSection(state.subpageReturnSection || 'chats');
  });
  const delBtn = $('#channelDeleteBtn');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm(`${isGroup ? 'Удалить группу' : 'Удалить канал'} «${conv.name}» безвозвратно?`)) return;
    await api(`/api/conversations/${convId}`, { method: 'DELETE' });
    state.conversations = state.conversations.filter((c) => c.id !== convId);
    switchSection(state.subpageReturnSection || 'chats');
    closeActiveChat();
  });
  const subBtn = $('#channelSubToggleBtn');
  if (subBtn) subBtn.addEventListener('click', async () => {
    if (isSubscribedTo(conv)) {
      if (!confirm(isGroup ? 'Покинуть эту группу?' : 'Отписаться от этого канала?')) return;
      await api(`/api/conversations/${convId}/unsubscribe`, { method: 'POST' });
      state.conversations = state.conversations.filter((c) => c.id !== convId);
      switchSection(state.subpageReturnSection || 'chats');
      closeActiveChat();
    } else {
      const { conversation } = await api(`/api/conversations/${convId}/subscribe`, { method: 'POST' });
      mergeConversation(conversation);
      switchSection(state.subpageReturnSection || 'chats');
    }
  });
}

/* ---------------- MESSAGES RENDER ---------------- */

function renderMessages() {
  const el = $('#messages');
  el.innerHTML = '';
  const list = state.messages[state.activeConvId] || [];
  list.forEach((m) => el.appendChild(renderMessageBubble(m)));
  el.scrollTop = el.scrollHeight;
}

// Добавляет одно новое сообщение с мягкой анимацией появления, не трогая
// уже отрисованные сообщения (чтобы список не "дёргался" целиком при каждом
// новом сообщении — анимируется только то, что реально только что пришло).
function appendMessageBubble(m) {
  const el = $('#messages');
  const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  const row = renderMessageBubble(m);
  row.classList.add('msg-enter');
  el.appendChild(row);
  if (wasNearBottom) el.scrollTop = el.scrollHeight;
}

function renderMessageBubble(m) {
  const row = document.createElement('div');
  row.className = 'msg-row' + (m.senderId === state.user.id ? ' mine' : '');
  row.dataset.msgId = m.id;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  let inner = '';
  const senderName = m.senderId === state.user.id ? '' : `<div class="sender">${escapeHtml(senderLabel(m.senderId))}${verifiedBadge(findKnownUser(m.senderId))}</div>`;
  if (m.senderId !== state.user.id && !senderIsKnown(m.senderId)) {
    ensureUserCached(m.senderId).then((u) => {
      if (!u) return;
      const el = row.querySelector('.sender');
      if (el) el.innerHTML = escapeHtml(u.displayName) + verifiedBadge(u);
    });
  }
  if (m.msgType === 'text') inner = `<span class="msg-text">${escapeHtml(m.content)}</span>`;
  else if (m.msgType === 'sticker') inner = `<div class="sticker-emoji">${m.content}</div>`;
  else if (m.msgType === 'image') inner = `<img src="${m.mediaUrl}" data-lightbox="1">${m.content ? `<div class="msg-text">${escapeHtml(m.content)}</div>` : ''}`;
  else if (m.msgType === 'video') inner = `<video src="${m.mediaUrl}" controls></video>`;
  else if (m.msgType === 'video_circle') inner = `<video class="circle-video" src="${m.mediaUrl}" controls></video>`;
  else if (m.msgType === 'voice') inner = `<audio src="${m.mediaUrl}" controls></audio>`;
  else if (m.msgType === 'music') inner = `<div>🎵 ${escapeHtml((m.meta && m.meta.name) || 'Трек')}</div><audio src="${m.mediaUrl}" controls></audio>`;
  else if (m.msgType === 'file') inner = `<a class="file-chip" href="${m.mediaUrl}" target="_blank" style="color:inherit;text-decoration:none;">📄 ${escapeHtml((m.meta && m.meta.name) || 'Файл')}</a>`;
  else if (m.msgType === 'poll') inner = renderPollBubble(m);
  const editedTag = m.edited ? '<span class="edited-tag">(изменено)</span>' : '';
  bubble.innerHTML = senderName + inner + `<div class="time">${fmtTime(m.createdAt)}${editedTag}</div>`;

  // клики по вариантам опроса
  if (m.msgType === 'poll') {
    bubble.querySelectorAll('.poll-option').forEach((optEl) => {
      optEl.addEventListener('click', () => votePoll(m.id, optEl.dataset.opt));
    });
  }

  // реакции
  if (m.reactions && Object.keys(m.reactions).length) {
    const rr = document.createElement('div');
    rr.className = 'reactions-row';
    Object.entries(m.reactions).forEach(([emoji, uids]) => {
      const pill = document.createElement('span');
      pill.className = 'reaction-pill' + (uids.includes(state.user.id) ? ' mine' : '');
      pill.textContent = `${emoji} ${uids.length}`;
      pill.addEventListener('click', () => sendReaction(m.id, emoji));
      rr.appendChild(pill);
    });
    bubble.appendChild(rr);
  }

  row.appendChild(bubble);

  // ховер-действия
  const actions = document.createElement('div');
  actions.className = 'msg-hover-actions';
  const reactBtn = document.createElement('button');
  reactBtn.textContent = '😊';
  reactBtn.title = 'Реакция';
  reactBtn.addEventListener('click', (e) => openReactionPicker(e, m.id));
  actions.appendChild(reactBtn);

  const isMine = m.senderId === state.user.id;
  if (isMine && m.msgType === 'text') {
    const editBtn = document.createElement('button');
    editBtn.textContent = '✏️';
    editBtn.title = 'Изменить';
    editBtn.addEventListener('click', () => startEditMessage(row, m));
    actions.appendChild(editBtn);
  }
  if (isMine || state.user.isAdmin) {
    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑';
    delBtn.title = 'Удалить';
    delBtn.addEventListener('click', () => deleteMessage(m.id));
    actions.appendChild(delBtn);
  }
  row.appendChild(actions);

  // долгое нажатие на само сообщение — реакции + изменить/удалить, с размытием фона
  attachLongPress(bubble, () => openMsgContextMenu(bubble, row, m), () => {});

  // лайтбокс на фото
  const img = bubble.querySelector('img[data-lightbox]');
  if (img) img.addEventListener('click', () => openLightbox(m.mediaUrl));

  return row;
}

function openMsgContextMenu(bubble, row, m) {
  const rect = bubble.getBoundingClientRect();
  const overlay = $('#msgContextOverlay');
  const cloneWrap = $('#msgContextCloneWrap');
  const menu = $('#msgContextMenu');

  // клон сообщения остаётся резким поверх размытого фона
  cloneWrap.innerHTML = '';
  const clone = bubble.cloneNode(true);
  // Важно: без этого max-width:60% у .bubble применяется ПОВТОРНО уже
  // относительно ширины обёртки (которая и так равна исходной ширине
  // пузыря) — пузырь схлопывался до 60% от самого себя, текст и реакции
  // вылезали за края. Фиксируем точные размеры и снимаем ограничение.
  clone.style.maxWidth = 'none';
  clone.style.width = rect.width + 'px';
  clone.style.minHeight = rect.height + 'px';
  clone.style.boxSizing = 'border-box';
  cloneWrap.appendChild(clone);
  cloneWrap.style.left = rect.left + 'px';
  cloneWrap.style.top = rect.top + 'px';
  cloneWrap.style.width = rect.width + 'px';

  const reactionsEl = $('#msgContextReactions');
  reactionsEl.innerHTML = '';
  REACTIONS.forEach((emoji) => {
    const b = document.createElement('button');
    b.textContent = emoji;
    b.addEventListener('click', () => { sendReaction(m.id, emoji); closeMsgContextMenu(); });
    reactionsEl.appendChild(b);
  });

  const actionsEl = $('#msgContextActions');
  actionsEl.innerHTML = '';
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  if (canPinInConversation(conv)) {
    const isPinnedNow = conv && conv.pinnedMessage && conv.pinnedMessage.id === m.id;
    const pinBtn = document.createElement('button');
    pinBtn.textContent = isPinnedNow ? '📌 Открепить' : '📌 Закрепить';
    pinBtn.addEventListener('click', () => { closeMsgContextMenu(); togglePinMessage(conv.id, isPinnedNow ? null : m.id); });
    actionsEl.appendChild(pinBtn);
  }
  const isMine = m.senderId === state.user.id;
  if (isMine && m.msgType === 'text') {
    const editBtn = document.createElement('button');
    editBtn.textContent = '✏️ Изменить';
    editBtn.addEventListener('click', () => { closeMsgContextMenu(); startEditMessage(row, m); });
    actionsEl.appendChild(editBtn);
  }
  if (isMine || state.user.isAdmin) {
    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑 Удалить';
    delBtn.className = 'danger';
    delBtn.addEventListener('click', () => { closeMsgContextMenu(); deleteMessage(m.id); });
    actionsEl.appendChild(delBtn);
  }

  overlay.classList.remove('hidden');

  requestAnimationFrame(() => {
    const menuW = menu.offsetWidth, menuH = menu.offsetHeight;
    let top = rect.bottom + 10;
    if (top + menuH > window.innerHeight - 10) top = Math.max(10, rect.top - menuH - 10);
    let left = m.senderId === state.user.id ? rect.right - menuW : rect.left;
    left = Math.max(10, Math.min(left, window.innerWidth - menuW - 10));
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
  });
}

function closeMsgContextMenu() {
  $('#msgContextOverlay').classList.add('hidden');
}
$('#msgContextOverlay').addEventListener('click', (e) => {
  if (e.target === $('#msgContextOverlay')) closeMsgContextMenu();
});

// Ищет пользователя среди уже известных данных (личные чаты, кеш) — без похода
// на сервер. Используется для быстрого показа имени там, где это возможно.
function findKnownUser(userId) {
  const conv = state.conversations.find((c) => c.peer && c.peer.id === userId);
  if (conv) return conv.peer;
  return state.usersById[userId] || null;
}

function senderIsKnown(senderId) {
  if (senderId === state.user.id) return true;
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  if (conv && conv.peer && conv.peer.id === senderId) return true;
  return !!state.usersById[senderId];
}

function senderLabel(senderId) {
  if (senderId === state.user.id) return state.user.displayName;
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  if (conv && conv.peer && conv.peer.id === senderId) return conv.peer.displayName;
  const u = state.usersById[senderId];
  return u ? u.displayName : 'Пользователь';
}

/* ---------------- MESSAGE EDIT / DELETE ---------------- */

function startEditMessage(row, m) {
  const bubble = row.querySelector('.bubble');
  const original = bubble.innerHTML;
  bubble.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'msg-edit-box';
  box.innerHTML = `<textarea>${escapeHtml(m.content)}</textarea><div class="msg-edit-actions"><button class="btn-secondary" data-act="cancel">Отмена</button><button class="btn-primary" data-act="save">Сохранить</button></div>`;
  bubble.appendChild(box);
  const textarea = box.querySelector('textarea');
  textarea.focus();
  box.querySelector('[data-act="cancel"]').addEventListener('click', () => renderMessages());
  box.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const content = textarea.value.trim();
    if (!content) return;
    try {
      await api(`/api/messages/${m.id}`, { method: 'PATCH', body: { content } });
    } catch (err) { alert(err.message); }
  });
}

async function deleteMessage(id) {
  if (!confirm('Удалить это сообщение?')) return;
  try {
    await api(`/api/messages/${id}`, { method: 'DELETE' });
  } catch (err) { alert(err.message); }
}

/* ---------------- REACTIONS ---------------- */

function sendReaction(messageId, emoji) {
  if (!state.ws || state.ws.readyState !== 1) return;
  state.ws.send(JSON.stringify({ type: 'reaction', messageId, emoji }));
  $('#reactionPicker').classList.add('hidden');
}

function openReactionPicker(evt, messageId) {
  const picker = $('#reactionPicker');
  picker.innerHTML = '';
  REACTIONS.forEach((emoji) => {
    const b = document.createElement('button');
    b.textContent = emoji;
    b.addEventListener('click', () => sendReaction(messageId, emoji));
    picker.appendChild(b);
  });
  const rect = evt.target.getBoundingClientRect();
  picker.style.top = (rect.top - 46 + window.scrollY) + 'px';
  picker.style.left = Math.max(8, rect.left - 100) + 'px';
  picker.classList.remove('hidden');
  evt.stopPropagation();
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#reactionPicker')) $('#reactionPicker').classList.add('hidden');
});

/* ---------------- LIGHTBOX ---------------- */

function openLightbox(src) {
  $('#lightboxImg').src = src;
  $('#lightbox').classList.remove('hidden');
}
$('#lightboxClose').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
$('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') $('#lightbox').classList.add('hidden'); });

/* ---------------- SEND MESSAGE ---------------- */

function sendWSMessage(msgType, content, mediaUrl, meta) {
  if (!state.activeConvId) return;
  state.ws.send(JSON.stringify({
    type: 'message', conversationId: state.activeConvId, msgType, content: content || '', mediaUrl: mediaUrl || null, meta: meta || null,
  }));
}

$('#sendBtn').addEventListener('click', sendTextMessage);
$('#messageInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTextMessage(); });
$('#messageInput').addEventListener('input', () => {
  updateSendOrRecordButton();
  if (state.activeConvId && state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({ type: 'typing', conversationId: state.activeConvId }));
  }
});

function updateSendOrRecordButton() {
  const hasText = $('#messageInput').value.trim().length > 0;
  $('#sendBtn').classList.toggle('hidden', !hasText);
  $('#recordBtn').classList.toggle('hidden', hasText);
}

function sendTextMessage() {
  const input = $('#messageInput');
  const text = input.value.trim();
  if (!text || !state.activeConvId) return;
  sendWSMessage('text', text);
  input.value = '';
  updateSendOrRecordButton();
}

/* ---------------- ATTACHMENTS ---------------- */

$('#attachBtn').addEventListener('click', () => { $('#attachMenu').classList.toggle('hidden'); $('#stickerPanel').classList.add('hidden'); });
$all('#attachMenu button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('#attachMenu').classList.add('hidden');
    const kind = btn.dataset.kind;
    if (kind === 'poll') { openPollCreateModal(); return; }
    const map = { image: '#fileInputImage', video: '#fileInputVideo', file: '#fileInputFile', music: '#fileInputMusic' };
    $(map[kind]).click();
  });
});

/* ---------------- POLLS (опросы) ---------------- */

const POLL_MAX_OPTIONS = 12;
let pollOptionCount = 0;

function pollOptionRow(index, value) {
  const row = document.createElement('div');
  row.className = 'poll-option-row';
  row.dataset.index = index;
  row.innerHTML = `
    <input type="text" class="poll-option-input" placeholder="Вариант ${index + 1}" maxlength="120" value="${escapeHtml(value || '')}">
    <button type="button" class="poll-option-remove" title="Удалить вариант">✕</button>
  `;
  row.querySelector('.poll-option-remove').addEventListener('click', () => {
    row.remove();
    refreshPollOptionUI();
  });
  return row;
}

function refreshPollOptionUI() {
  const rows = $all('#pollOptionsList .poll-option-row');
  pollOptionCount = rows.length;
  // нельзя удалить меньше 2 вариантов
  rows.forEach((row) => {
    row.querySelector('.poll-option-remove').classList.toggle('hidden', rows.length <= 2);
  });
  $('#pollAddOptionBtn').classList.toggle('hidden', rows.length >= POLL_MAX_OPTIONS);

  // пересобираем список "максимум вариантов" под текущее число опций
  const select = $('#pollMaxChoicesSelect');
  const prevValue = select.value;
  select.innerHTML = '';
  for (let i = 2; i <= Math.max(2, rows.length); i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = i === rows.length ? `${i} (любой вариант из всех)` : String(i);
    select.appendChild(opt);
  }
  if ([...select.options].some((o) => o.value === prevValue)) select.value = prevValue;
}

function openPollCreateModal() {
  $('#pollQuestionInput').value = '';
  $('#pollError').textContent = '';
  $('#pollMultipleCheckbox').checked = false;
  $('#pollMaxChoicesRow').classList.add('hidden');
  const list = $('#pollOptionsList');
  list.innerHTML = '';
  list.appendChild(pollOptionRow(0));
  list.appendChild(pollOptionRow(1));
  refreshPollOptionUI();
  showModal('#pollCreateModal');
}

$('#pollAddOptionBtn').addEventListener('click', () => {
  const list = $('#pollOptionsList');
  const count = $all('#pollOptionsList .poll-option-row').length;
  if (count >= POLL_MAX_OPTIONS) return;
  list.appendChild(pollOptionRow(count));
  refreshPollOptionUI();
  list.lastElementChild.querySelector('input').focus();
});

$('#pollMultipleCheckbox').addEventListener('change', () => {
  $('#pollMaxChoicesRow').classList.toggle('hidden', !$('#pollMultipleCheckbox').checked);
});

$('#pollSendBtn').addEventListener('click', () => {
  $('#pollError').textContent = '';
  const question = $('#pollQuestionInput').value.trim();
  if (!question) { $('#pollError').textContent = 'Введите вопрос'; return; }
  const options = $all('#pollOptionsList .poll-option-input')
    .map((inp) => inp.value.trim())
    .filter(Boolean);
  if (options.length < 2) { $('#pollError').textContent = 'Нужно минимум 2 варианта ответа'; return; }
  if (options.length > POLL_MAX_OPTIONS) { $('#pollError').textContent = `Максимум ${POLL_MAX_OPTIONS} вариантов`; return; }
  const multiple = $('#pollMultipleCheckbox').checked;
  const maxChoices = multiple ? parseInt($('#pollMaxChoicesSelect').value, 10) || options.length : 1;

  sendWSMessage('poll', question, null, {
    question,
    options: options.map((text) => ({ text })),
    maxChoices,
  });
  $('#pollCreateModal').classList.add('hidden');
});

function pollUserVotes(m) {
  const votes = (m.meta && m.meta.votes) || {};
  return Object.keys(votes).filter((optId) => votes[optId].includes(state.user.id));
}

function totalPollVoters(m) {
  const votes = (m.meta && m.meta.votes) || {};
  const uniq = new Set();
  Object.values(votes).forEach((arr) => arr.forEach((uid) => uniq.add(uid)));
  return uniq.size;
}

function renderPollBubble(m) {
  const meta = m.meta || { options: [], votes: {}, maxChoices: 1 };
  const votes = meta.votes || {};
  const totalVoters = totalPollVoters(m);
  const mySelections = pollUserVotes(m);

  let html = `<div class="poll-bubble">
    <div class="poll-question">📊 ${escapeHtml(meta.question || m.content)}</div>
    <div class="poll-meta-line">${meta.maxChoices > 1 ? `Можно выбрать до ${meta.maxChoices}` : 'Один вариант ответа'}</div>`;

  meta.options.forEach((opt) => {
    const count = (votes[opt.id] || []).length;
    const pct = totalVoters ? Math.round((count / totalVoters) * 100) : 0;
    const mine = mySelections.includes(opt.id);
    html += `
      <div class="poll-option${mine ? ' mine' : ''}" data-opt="${opt.id}">
        <div class="poll-option-fill" style="width:${pct}%"></div>
        <div class="poll-option-top">
          <span class="poll-option-text"><span class="poll-option-check"></span>${escapeHtml(opt.text)}</span>
          <span class="poll-option-pct">${totalVoters ? pct + '%' : ''}</span>
        </div>
      </div>`;
  });

  html += `<div class="poll-total-votes">${totalVoters ? totalVoters + ' ' + pluralVotes(totalVoters) : 'Пока никто не проголосовал'}</div></div>`;
  return html;
}

function pluralVotes(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'голос';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'голоса';
  return 'голосов';
}

function votePoll(messageId, optionId) {
  const list = state.messages[state.activeConvId] || [];
  const m = list.find((mm) => mm.id === messageId);
  if (!m) return;
  const meta = m.meta || {};
  const current = pollUserVotes(m);
  let next;
  if ((meta.maxChoices || 1) <= 1) {
    next = current.includes(optionId) ? [] : [optionId];
  } else if (current.includes(optionId)) {
    next = current.filter((id) => id !== optionId);
  } else {
    if (current.length >= meta.maxChoices) {
      alert(`Можно выбрать не более ${meta.maxChoices} вариантов`);
      return;
    }
    next = [...current, optionId];
  }
  state.ws.send(JSON.stringify({ type: 'poll-vote', messageId, optionIds: next }));
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadFile(file, kind) {
  const dataBase64 = await fileToBase64(file);
  const { url } = await api('/api/upload', { method: 'POST', body: { filename: file.name, dataBase64, kind } });
  return url;
}

// Фото — через предпросмотр
$('#fileInputImage').addEventListener('change', () => {
  const file = $('#fileInputImage').files[0];
  if (!file) return;
  state.pendingImageFile = file;
  $('#imagePreviewImg').src = URL.createObjectURL(file);
  $('#imagePreviewCaption').value = '';
  showModal('#imagePreviewModal');
  $('#fileInputImage').value = '';
});
$('#imagePreviewSendBtn').addEventListener('click', async () => {
  if (!state.pendingImageFile) return;
  const file = state.pendingImageFile;
  const caption = $('#imagePreviewCaption').value.trim();
  $('#imagePreviewModal').classList.add('hidden');
  const url = await uploadFile(file, 'image');
  sendWSMessage('image', caption, url, { name: file.name, size: file.size, mime: file.type });
  state.pendingImageFile = null;
});

async function handleFileInput(inputEl, msgType) {
  inputEl.addEventListener('change', async () => {
    const file = inputEl.files[0];
    if (!file) return;
    const url = await uploadFile(file, msgType);
    sendWSMessage(msgType, '', url, { name: file.name, size: file.size, mime: file.type });
    inputEl.value = '';
  });
}
handleFileInput($('#fileInputVideo'), 'video');
handleFileInput($('#fileInputFile'), 'file');
handleFileInput($('#fileInputMusic'), 'music');

/* ---------------- STICKERS ---------------- */

const stickerPanel = $('#stickerPanel');
STICKERS.forEach((s) => {
  const b = document.createElement('button');
  b.textContent = s;
  b.addEventListener('click', () => { sendWSMessage('sticker', s); stickerPanel.classList.add('hidden'); });
  stickerPanel.appendChild(b);
});
$('#stickerBtn').addEventListener('click', () => { stickerPanel.classList.toggle('hidden'); $('#attachMenu').classList.add('hidden'); });

document.addEventListener('click', (e) => {
  if (!e.target.closest('#attachBtn') && !e.target.closest('#attachMenu')) $('#attachMenu').classList.add('hidden');
  if (!e.target.closest('#stickerBtn') && !e.target.closest('#stickerPanel')) stickerPanel.classList.add('hidden');
});

/* ---------------- VOICE MESSAGES ---------------- */


async function startVoiceRecording() {
  try {
    const stream = await getMedia({ audio: true });
    state.voiceStream = stream;
    state.voiceChunks = [];
    const rec = new MediaRecorder(stream);
    state.voiceRecorder = rec;
    rec.ondataavailable = (e) => { if (e.data.size) state.voiceChunks.push(e.data); };
    rec.start();
    state.voiceStartedAt = Date.now();
    $('#voiceRecordingBar').classList.remove('hidden');
    state.voiceTimerInt = setInterval(() => {
      const sec = Math.floor((Date.now() - state.voiceStartedAt) / 1000);
      $('#voiceTimer').textContent = `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
    }, 500);
  } catch (e) { alert('Нет доступа к микрофону: ' + e.message); }
}

function stopVoiceRecording(send) {
  const rec = state.voiceRecorder;
  if (!rec) return;
  rec.onstop = async () => {
    clearInterval(state.voiceTimerInt);
    $('#voiceRecordingBar').classList.add('hidden');
    state.voiceStream.getTracks().forEach((t) => t.stop());
    if (send && state.voiceChunks.length) {
      const blob = new Blob(state.voiceChunks, { type: 'audio/webm' });
      const file = new File([blob], 'voice.webm', { type: 'audio/webm' });
      const url = await uploadFile(file, 'voice');
      sendWSMessage('voice', '', url, {});
    }
  };
  rec.stop();
}

/* ---------------- VIDEO CIRCLE (кружки) ---------------- */

async function sendCircleVideo() {
  const blob = new Blob(state.circleChunks, { type: 'video/webm' });
  const file = new File([blob], 'circle.webm', { type: 'video/webm' });
  const url = await uploadFile(file, 'circle');
  sendWSMessage('video_circle', '', url, {});
  closeCircleModal();
}

function closeCircleModal() {
  $('#circleRecordModal').classList.add('hidden');
  if (state.circleStream) state.circleStream.getTracks().forEach((t) => t.stop());
  state.circleStream = null;
}

/* ---------------- ОБЪЕДИНЁННАЯ КНОПКА: голосовое / видео-кружок ----------------
   Раньше это были 2 отдельные кнопки рядом с кнопкой отправки — на маленьких
   мобильных экранах места на всё не хватало, и кнопка отправки сжималась или
   вообще пропадала за край экрана. Теперь это одна кнопка: короткий тап
   переключает режим (голосовое ⇄ кружок), нажатие и удержание — начинает
   запись в текущем режиме, отпускание — останавливает и отправляет (свайп
   вверх во время удержания — отмена, как в Telegram). Кнопка вообще не
   показывается, пока в поле ввода есть текст — тогда видна только кнопка
   отправки. */
let recordMode = 'voice'; // 'voice' | 'circle'
let recordHoldTimer = null;
let recordActive = false; // true, когда порог удержания пройден и запись реально идёт
let recordStartX = 0, recordStartY = 0;
const RECORD_HOLD_MS = 350;
const RECORD_CANCEL_DRAG_PX = 70;

function updateRecordBtnUi() {
  const btn = $('#recordBtn');
  if (recordMode === 'voice') {
    btn.textContent = '🎙';
    btn.title = 'Голосовое сообщение — нажмите и удерживайте (тап — переключить на видео-кружок)';
  } else {
    btn.textContent = '⭕';
    btn.title = 'Видео-кружок — нажмите и удерживайте (тап — переключить на голосовое)';
  }
}
updateRecordBtnUi();

async function beginHoldRecording() {
  recordActive = true;
  if (recordMode === 'voice') {
    await startVoiceRecording();
  } else {
    showModal('#circleRecordModal');
    $('#circleRecordBtn').classList.add('hidden');
    try {
      const stream = await getMedia({ video: { facingMode: state.currentFacingMode || 'user' }, audio: true });
      state.circleStream = stream;
      $('#circlePreview').srcObject = stream;
      state.circleChunks = [];
      const rec = new MediaRecorder(stream);
      state.circleRecorder = rec;
      rec.ondataavailable = (e) => { if (e.data.size) state.circleChunks.push(e.data); };
      rec.start();
      state.circleAutoStopTimer = setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, 15000);
    } catch (e) {
      alert('Нет доступа к камере: ' + e.message);
      recordActive = false;
      closeCircleModal();
      $('#circleRecordBtn').classList.remove('hidden');
    }
  }
}

function endHoldRecording(send) {
  if (!recordActive) return;
  recordActive = false;
  if (recordMode === 'voice') {
    stopVoiceRecording(send);
  } else {
    clearTimeout(state.circleAutoStopTimer);
    const rec = state.circleRecorder;
    $('#circleRecordBtn').classList.remove('hidden');
    if (!rec || rec.state === 'inactive') { closeCircleModal(); return; }
    rec.onstop = async () => {
      if (send && state.circleChunks.length) await sendCircleVideo();
      else closeCircleModal();
    };
    rec.stop();
  }
}

const recordBtnEl = $('#recordBtn');
recordBtnEl.addEventListener('pointerdown', (e) => {
  if (e.button !== undefined && e.button !== 0) return;
  recordStartX = e.clientX; recordStartY = e.clientY;
  try { recordBtnEl.setPointerCapture(e.pointerId); } catch (err) {}
  clearTimeout(recordHoldTimer);
  recordHoldTimer = setTimeout(beginHoldRecording, RECORD_HOLD_MS);
});
recordBtnEl.addEventListener('pointerup', (e) => {
  clearTimeout(recordHoldTimer);
  if (recordActive) {
    const draggedUp = (recordStartY - e.clientY) > RECORD_CANCEL_DRAG_PX;
    endHoldRecording(!draggedUp);
  } else {
    // короткий тап — переключаем режим
    recordMode = recordMode === 'voice' ? 'circle' : 'voice';
    updateRecordBtnUi();
  }
});
recordBtnEl.addEventListener('pointercancel', () => { clearTimeout(recordHoldTimer); if (recordActive) endHoldRecording(false); });
recordBtnEl.addEventListener('contextmenu', (e) => e.preventDefault());

/* ---------------- MODALS generic ---------------- */

$all('.modal-close').forEach((btn) => btn.addEventListener('click', () => {
  const id = btn.dataset.close;
  $('#' + id).classList.add('hidden');
  if (id === 'circleRecordModal') closeCircleModal();
}));

/* ---------------- SETTINGS (теперь отдельный раздел, не модалка) ---------------- */

function renderMyAvatar() {
  const av = $('#myAvatar');
  av.textContent = state.user.avatar ? '' : initials(state.user.displayName);
  av.style.cssText = avatarStyle(state.user);
  const av2 = $('#settingsAvatarPreview');
  av2.textContent = state.user.avatar ? '' : initials(state.user.displayName);
  av2.style.cssText = avatarStyle(state.user);
  const av3 = $('#settingsHeaderAvatar');
  if (av3) {
    av3.textContent = state.user.avatar ? '' : initials(state.user.displayName);
    av3.style.cssText = avatarStyle(state.user);
  }
  const hdrName = $('#settingsHeaderName');
  if (hdrName) hdrName.textContent = state.user.displayName || '';
  const hdrSub = $('#settingsHeaderSub');
  if (hdrSub) {
    const parts = [];
    if (state.user.username) parts.push('@' + state.user.username);
    if (state.user.status) parts.push(state.user.status);
    hdrSub.textContent = parts.join(' • ');
  }
}

/* ---------------- НАСТРОЙКИ: список пунктов и дочерние страницы ---------------- */

const SETTINGS_SUBPAGES = {
  profile:       { title: 'Мой профиль',          el: 'subPageProfile' },
  wallet:        { title: 'Кошелёк',               el: 'subPageWallet' },
  favorites:     { title: 'Избранное',             el: 'subPageFavorites' },
  devices:       { title: 'Устройства',            el: 'subPageDevices' },
  folders:       { title: 'Папки с чатами',        el: 'subPageFolders' },
  notifications: { title: 'Уведомления и звуки',   el: 'subPageNotifications' },
  privacy:       { title: 'Конфиденциальность',    el: 'subPagePrivacy' },
  storage:       { title: 'Данные и память',       el: 'subPageStorage' },
  appearance:    { title: 'Оформление',            el: 'subPageAppearance' },
  powersaving:   { title: 'Энергосбережение',      el: 'subPagePowerSaving' },
  language:      { title: 'Язык',                  el: 'subPageLanguage' },
};

function populateProfileViewInfo() {
  const u = state.user;
  $('#profileHeroName').textContent = u.displayName || '';
  $('#profileHeroUsername').textContent = u.username ? '@' + u.username : '';
  $('#profileInfoUsername').textContent = u.username ? '@' + u.username : '—';
  $('#profileInfoStatus').textContent = u.status || '—';
  $('#profileInfoJoined').textContent = u.createdAt ? fmtDate(u.createdAt) : '—';
}
function setProfileEditMode(on) {
  $('#profileViewMode').classList.toggle('hidden', on);
  $('#profileEditMode').classList.toggle('hidden', !on);
  $('#profileEditToggleBtn').textContent = on ? 'Готово' : 'Изм.';
  if (on) {
    $('#settingsDisplayName').value = state.user.displayName || '';
    $('#settingsUsername').value = state.user.username || '';
    $('#settingsStatus').value = state.user.status || '';
    $('#settingsError').textContent = '';
  }
}
$('#profileEditToggleBtn').addEventListener('click', async () => {
  const isEditing = !$('#profileEditMode').classList.contains('hidden');
  if (isEditing) {
    const ok = await saveProfileSettings();
    if (!ok) return; // остаёмся в режиме редактирования, показываем ошибку
    setProfileEditMode(false);
  } else {
    setProfileEditMode(true);
  }
});
$('#profileQrBtn').addEventListener('click', () => {
  openShareModal(state.user.displayName, buildProfileLink(state.user.username));
});

function openSettingsSubpage(key) {
  if (key === 'calls') { switchSection('calls'); return; }
  const cfg = SETTINGS_SUBPAGES[key];
  if (!cfg) return;
  $('#settingsMainView').classList.add('hidden');
  $('#settingsSubView').classList.remove('hidden');
  $('#settingsSubTitle').textContent = cfg.title;
  $all('.settings-sub-page').forEach((p) => p.classList.add('hidden'));
  $('#' + cfg.el).classList.remove('hidden');
  $('#profileEditToggleBtn').classList.toggle('hidden', key !== 'profile');
  if (key === 'profile') {
    populateProfileViewInfo();
    setProfileEditMode(false);
  }
  if (key === 'privacy') {
    $('#discoverableCheckbox').checked = state.user.discoverable !== false;
    $('#passwordError').textContent = '';
    $('#currentPasswordInput').value = '';
    $('#newPasswordInput').value = '';
    $all('#passwordStrength span').forEach((b) => b.className = '');
    $all('.password-toggle-eye').forEach((btn) => { const inp = $('#' + btn.dataset.toggle); if (inp) inp.type = 'password'; btn.textContent = '👁'; });
  }
  if (key === 'folders') renderFoldersInSettings();
  if (key === 'appearance') highlightActiveThemeSwatch();
  if (key === 'notifications') $('#notificationsStatus').textContent = '';
}
function closeSettingsSubpage() {
  $('#settingsSubView').classList.add('hidden');
  $('#settingsMainView').classList.remove('hidden');
}
$all('[data-settings-page]').forEach((btn) => btn.addEventListener('click', () => openSettingsSubpage(btn.dataset.settingsPage)));
$('#settingsSubBackBtn').addEventListener('click', closeSettingsSubpage);
$('#changePhotoRow').addEventListener('click', () => $('#avatarInput').click());
$('#enableNotificationsBtn').addEventListener('click', () => {
  if (!('Notification' in window)) { $('#notificationsStatus').textContent = 'Уведомления не поддерживаются этим браузером'; return; }
  Notification.requestPermission().then((perm) => {
    $('#notificationsStatus').style.color = perm === 'granted' ? 'var(--accent-2)' : 'var(--danger)';
    $('#notificationsStatus').textContent = perm === 'granted' ? 'Уведомления включены ✓' : 'Уведомления отклонены';
  });
});
$('#powerSavingCheckbox').addEventListener('change', (e) => {
  $('#powerSavingValue').textContent = e.target.checked ? 'Вкл.' : 'Выкл.';
});

function openSettingsPage() {
  closeSettingsSubpage();
  renderMyAvatar();
  $('#discoverableCheckbox').checked = state.user.discoverable !== false;
}
$('#changeAvatarBtn').addEventListener('click', () => $('#avatarInput').click());
$('#avatarInput').addEventListener('change', async () => {
  const file = $('#avatarInput').files[0];
  if (!file) return;
  const url = await uploadFile(file, 'avatar');
  state.user.avatar = url;
  renderMyAvatar();
});
$('#removeAvatarBtn').addEventListener('click', () => {
  state.user.avatar = '';
  renderMyAvatar();
});

$('#changeWallpaperBtn').addEventListener('click', () => $('#wallpaperInput').click());
$('#wallpaperInput').addEventListener('change', async () => {
  const file = $('#wallpaperInput').files[0];
  if (!file) return;
  $('#wallpaperInput').value = '';
  const url = await uploadFile(file, 'wallpaper');
  applyWallpaperPref(url);
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: { chatWallpaper: url } });
    state.user = user;
  } catch (e) { alert('Не удалось сохранить фон: ' + e.message); }
});
$('#removeWallpaperBtn').addEventListener('click', async () => {
  applyWallpaperPref('');
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: { chatWallpaper: '' } });
    state.user = user;
  } catch (e) { alert('Не удалось сбросить фон: ' + e.message); }
});

function highlightActiveThemeSwatch() {
  $all('.theme-swatch').forEach((s) => s.classList.toggle('active', s.dataset.themeValue === currentThemePref));
}
$all('.theme-swatch').forEach((btn) => {
  btn.addEventListener('click', async () => {
    applyThemePref(btn.dataset.themeValue);
    // сохраняем сразу в аккаунт, а не только при нажатии общей кнопки
    // «Сохранить» в настройках — иначе тема визуально «слетает» при
    // следующем открытии вкладки, если человек забыл сохранить остальное.
    if (state.user) {
      try {
        const { user } = await api('/api/me', { method: 'PATCH', body: { theme: currentThemePref } });
        state.user = user;
      } catch (e) { /* останется хотя бы в localStorage на этом устройстве */ }
    }
  });
});

async function saveProfileSettings() {
  $('#settingsError').textContent = '';
  const patch = {
    displayName: $('#settingsDisplayName').value.trim(),
    username: $('#settingsUsername').value.trim(),
    status: $('#settingsStatus').value.trim(),
    avatar: state.user.avatar || '',
    theme: currentThemePref,
    discoverable: $('#discoverableCheckbox').checked,
  };
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: patch });
    state.user = user;
    renderMyAvatar();
    populateProfileViewInfo();
    loadConversations();
    return true;
  } catch (err) { $('#settingsError').textContent = err.message; return false; }
}
$('#saveSettingsBtn').addEventListener('click', saveProfileSettings);
$all('.password-toggle-eye').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $('#' + btn.dataset.toggle);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? '👁' : '🙈';
  });
});

const newPasswordEl = $('#newPasswordInput');
if (newPasswordEl) {
  newPasswordEl.addEventListener('input', () => {
    const val = newPasswordEl.value;
    const bars = $all('#passwordStrength span');
    let score = 0;
    if (val.length >= 4) score++;
    if (val.length >= 8) score++;
    if (/[0-9]/.test(val) && /[a-zA-Zа-яА-Я]/.test(val)) score++;
    if (/[^a-zA-Zа-яА-Я0-9]/.test(val) || val.length >= 12) score++;
    const cls = score <= 1 ? 'on-weak' : score <= 2 ? 'on-mid' : 'on-strong';
    bars.forEach((b, i) => { b.className = (i < score && val) ? cls : ''; });
  });
}

$('#changePasswordBtn').addEventListener('click', async () => {
  $('#passwordError').textContent = '';
  const currentPassword = $('#currentPasswordInput').value;
  const newPassword = $('#newPasswordInput').value;
  try {
    await api('/api/me/password', { method: 'POST', body: { currentPassword, newPassword } });
    $('#currentPasswordInput').value = '';
    $('#newPasswordInput').value = '';
    $all('#passwordStrength span').forEach((b) => b.className = '');
    $('#passwordError').style.color = 'var(--accent-2)';
    $('#passwordError').textContent = 'Пароль изменён ✓';
  } catch (err) {
    $('#passwordError').style.color = 'var(--danger)';
    $('#passwordError').textContent = err.message;
  }
});

/* ---------------- ССЫЛКИ И QR (шаринг звонков/профилей/групп/каналов) ---------------- */

function buildInviteLink(code) { return `${location.origin}/j/${code}`; }
function buildProfileLink(username) { return `${location.origin}/u/${username}`; }

function renderQrInto(el, text) {
  el.innerHTML = '';
  if (window.AsteriaQR) {
    try { el.innerHTML = window.AsteriaQR.toSVG(text, 5, 3); }
    catch (e) { el.textContent = ''; }
  }
}

function openShareModal(title, link) {
  $('#shareModalTitle').textContent = title || 'Поделиться';
  $('#shareModalLink').textContent = link;
  renderQrInto($('#shareModalQr'), link);
  $('#shareModalCopyBtn').textContent = 'Скопировать ссылку';
  $('#shareModalCopyBtn').onclick = () => {
    navigator.clipboard.writeText(link).catch(() => {});
    $('#shareModalCopyBtn').textContent = 'Скопировано!';
    setTimeout(() => { $('#shareModalCopyBtn').textContent = 'Скопировать ссылку'; }, 1500);
  };
  const nativeBtn = $('#shareModalNativeBtn');
  if (navigator.share) {
    nativeBtn.classList.remove('hidden');
    nativeBtn.onclick = () => navigator.share({ title, url: link }).catch(() => {});
  } else {
    nativeBtn.classList.add('hidden');
  }
  showModal('#shareModal');
}

/* ---------------- ПОЛНОЭКРАННЫЙ ФЛОУ: создать чат / группу / канал ---------------- */

let composeStack = ['composeMenuScreen'];
let composeFoundUser = null;

function composeShowScreen(id) {
  $all('.compose-screen').forEach((s) => s.classList.add('hidden'));
  $('#' + id).classList.remove('hidden');
}

function openComposeFlow() {
  composeStack = ['composeMenuScreen'];
  composeShowScreen('composeMenuScreen');
  $('#composeFlow').classList.remove('hidden');
  $('#composeUserSearchInput').value = '';
  renderComposeUserResults([]);
  $('#composeChannelsList').classList.add('hidden');
  $('#composeGroupName').value = '';
  $('#composeGroupForm').classList.remove('hidden');
  $('#composeGroupDone').classList.add('hidden');
  $('#composeChannelName').value = '';
  $('#composeChannelForm').classList.remove('hidden');
  $('#composeChannelDone').classList.add('hidden');
}
function closeComposeFlow() { $('#composeFlow').classList.add('hidden'); }

$('#newChatBtn').addEventListener('click', openComposeFlow);
$('#composeCloseBtn').addEventListener('click', closeComposeFlow);
$all('.compose-list-item[data-compose-target]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.composeTarget;
    composeStack.push(target);
    composeShowScreen(target);
  });
});
$all('[data-compose-back]').forEach((btn) => {
  btn.addEventListener('click', () => {
    composeStack.pop();
    composeShowScreen(composeStack[composeStack.length - 1] || 'composeMenuScreen');
  });
});

// ---- Создать чат: поиск по логину/почте, локальное имя контакта ----
function renderComposeUserResults(users) {
  const usersEl = $('#composeUserResults');
  usersEl.innerHTML = '';
  if (!users.length) {
    const q = $('#composeUserSearchInput').value.trim();
    usersEl.innerHTML = `<div class="chat-header-sub" style="padding:8px;">${q.length < 2 ? 'Введите минимум 2 символа логина или почты' : 'Никто не найден — либо неверно, либо человек скрыл поиск по себе'}</div>`;
    return;
  }
  users.forEach((u) => {
    state.usersById[u.id] = u;
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `<div class="avatar" style="${u.avatar ? avatarStyle(u) : ''}">${u.avatar ? '' : initials(u.displayName)}</div><div><div>${escapeHtml(u.displayName)}${verifiedBadge(u)}</div><div class="chat-header-sub">@${escapeHtml(u.username)}</div></div>`;
    row.addEventListener('click', () => {
      composeFoundUser = u;
      $('#composeContactPreview').innerHTML = `<div class="avatar" style="${u.avatar ? avatarStyle(u) : ''}">${u.avatar ? '' : initials(u.displayName)}</div><div><div>${escapeHtml(u.displayName)}${verifiedBadge(u)}</div><div class="chat-header-sub">@${escapeHtml(u.username)}</div></div>`;
      $('#composeNicknameInput').value = '';
      composeStack.push('composeAddContactScreen');
      composeShowScreen('composeAddContactScreen');
    });
    usersEl.appendChild(row);
  });
}

let composeSearchDebounce = null;
$('#composeUserSearchInput').addEventListener('input', () => {
  clearTimeout(composeSearchDebounce);
  const q = $('#composeUserSearchInput').value.trim();
  if (q.length < 2) { renderComposeUserResults([]); return; }
  composeSearchDebounce = setTimeout(async () => {
    try {
      const { users } = await api(`/api/users?q=${encodeURIComponent(q)}`);
      renderComposeUserResults(users.filter((u) => u.id !== state.user.id));
    } catch (e) { renderComposeUserResults([]); }
  }, 300);
});

$('#composeShowChannelsBtn').addEventListener('click', async () => {
  const listEl = $('#composeChannelsList');
  if (!listEl.classList.contains('hidden')) { listEl.classList.add('hidden'); return; }
  const { channels } = await api('/api/channels');
  listEl.innerHTML = '';
  channels.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'channel-row';
    const subscribed = (c.participants || []).includes(state.user.id);
    row.innerHTML = `<div class="avatar" style="${c.avatar ? avatarStyle(c) : ''}">${c.avatar ? '' : initials(c.name)}</div><div>${escapeHtml(c.name)} 📢${subscribed ? ' · вы подписаны' : ''}</div>`;
    row.addEventListener('click', async () => {
      if (!subscribed) await api(`/api/conversations/${c.id}/subscribe`, { method: 'POST' });
      closeComposeFlow();
      await loadConversations();
      openConversation(c.id);
    });
    listEl.appendChild(row);
  });
  listEl.classList.remove('hidden');
});

$('#composeAddContactBtn').addEventListener('click', async () => {
  if (!composeFoundUser) return;
  const { conversation } = await api('/api/conversations', { method: 'POST', body: { type: 'dm', userId: composeFoundUser.id } });
  const nickname = $('#composeNicknameInput').value.trim();
  if (nickname) await api(`/api/conversations/${conversation.id}/nickname`, { method: 'POST', body: { nickname } });
  closeComposeFlow();
  await loadConversations();
  openConversation(conversation.id);
});

// ---- Создать группу ----
$('#composeCreateGroupBtn').addEventListener('click', async () => {
  const name = $('#composeGroupName').value.trim();
  if (!name) return;
  const { conversation } = await api('/api/conversations', { method: 'POST', body: { type: 'group', name } });
  await loadConversations();
  const link = buildInviteLink(conversation.inviteCode);
  $('#composeGroupInviteLink').textContent = link;
  renderQrInto($('#composeGroupQr'), link);
  $('#composeGroupForm').classList.add('hidden');
  $('#composeGroupDone').classList.remove('hidden');
  $('#composeCopyGroupLinkBtn').onclick = () => {
    navigator.clipboard.writeText(link).catch(() => {});
    $('#composeCopyGroupLinkBtn').textContent = 'Скопировано!';
    setTimeout(() => { $('#composeCopyGroupLinkBtn').textContent = 'Скопировать ссылку'; }, 1500);
  };
  $('#composeShareGroupBtn').onclick = () => openShareModal(name, link);
  $('#composeGroupOpenBtn').onclick = () => { closeComposeFlow(); openConversation(conversation.id); };
});

// ---- Создать канал ----
$('#composeCreateChannelBtn').addEventListener('click', async () => {
  const name = $('#composeChannelName').value.trim();
  if (!name) return;
  const { conversation } = await api('/api/conversations', { method: 'POST', body: { type: 'channel', name } });
  await loadConversations();
  const link = buildInviteLink(conversation.inviteCode);
  $('#composeChannelInviteLink').textContent = link;
  renderQrInto($('#composeChannelQr'), link);
  $('#composeChannelForm').classList.add('hidden');
  $('#composeChannelDone').classList.remove('hidden');
  $('#composeCopyChannelLinkBtn').onclick = () => {
    navigator.clipboard.writeText(link).catch(() => {});
    $('#composeCopyChannelLinkBtn').textContent = 'Скопировано!';
    setTimeout(() => { $('#composeCopyChannelLinkBtn').textContent = 'Скопировать ссылку'; }, 1500);
  };
  $('#composeShareChannelBtn').onclick = () => openShareModal(name, link);
  $('#composeChannelOpenBtn').onclick = () => { closeComposeFlow(); openConversation(conversation.id); };
});

/* ---------------- ГЛУБОКИЕ ССЫЛКИ: приглашение в группу/канал, профиль ---------------- */

async function handleDeepLinkIfPresent() {
  const inviteMatch = location.pathname.match(/^\/j\/([^/]+)$/);
  const profileMatch = location.pathname.match(/^\/u\/([^/]+)$/);
  if (!inviteMatch && !profileMatch) return;
  history.replaceState({}, '', '/');
  if (inviteMatch) {
    try {
      const { preview } = await api(`/api/invite/${inviteMatch[1]}`);
      const kindWord = preview.type === 'group' ? 'группу' : 'канал';
      if (preview.alreadyMember) {
        await loadConversations();
        openConversation(preview.id);
        return;
      }
      if (!confirm(`Вступить в ${kindWord} «${preview.name}» (${preview.memberCount} участников)?`)) return;
      await api(`/api/invite/${inviteMatch[1]}/join`, { method: 'POST' });
      await loadConversations();
      openConversation(preview.id);
    } catch (e) { alert(e.message || 'Ссылка недействительна или устарела'); }
  } else if (profileMatch) {
    try {
      const { users } = await api(`/api/users?q=${encodeURIComponent(profileMatch[1])}`);
      const exact = users.find((u) => u.username === profileMatch[1]);
      if (exact) openProfilePage(exact.id);
      else alert('Пользователь не найден');
    } catch (e) { alert('Пользователь не найден'); }
  }
}

/* ---------------- STORIES ---------------- */

// Точечно подгружает и кеширует профиль по ID — вместо публичного каталога всех
// пользователей. Используется для отображения имён людей, с которыми уже есть
// общий контекст (история, звонок, участник канала), а не для поиска/просмотра.
async function ensureUserCached(userId) {
  if (!userId) return null;
  if (state.usersById[userId]) return state.usersById[userId];
  try {
    const { user } = await api(`/api/users/${userId}`);
    state.usersById[userId] = user;
    return user;
  } catch (e) {
    return null;
  }
}

async function loadStories() {
  const { stories } = await api('/api/stories');
  state.usersById[state.user.id] = state.user;
  const authorIds = [...new Set(stories.map((s) => s.userId))];
  await Promise.all(authorIds.map(ensureUserCached));
  renderStories(stories);
}

function renderStories(stories) {
  const byUser = {};
  stories.forEach((s) => { (byUser[s.userId] = byUser[s.userId] || []).push(s); });
  const el = $('#storiesStrip');
  el.innerHTML = '';

  const mine = document.createElement('div');
  mine.className = 'story-item';
  const mineHasPhoto = !!state.user.avatar;
  mine.innerHTML = `<div class="story-avatar story-add"><div class="story-avatar-inner" style="${mineHasPhoto ? avatarStyle(state.user) : ''}">${mineHasPhoto ? '' : (byUser[state.user.id] ? initials(state.user.displayName) : '＋')}</div></div><span>Ваша история</span>`;
  mine.addEventListener('click', () => {
    if (byUser[state.user.id]) viewStories(byUser[state.user.id], state.user);
    else openCreateStoryModal();
  });
  el.appendChild(mine);

  Object.keys(byUser).forEach((uid) => {
    if (uid === state.user.id) return;
    const u = state.usersById[uid] || { displayName: '?' };
    const item = document.createElement('div');
    item.className = 'story-item';
    item.innerHTML = `<div class="story-avatar"><div class="story-avatar-inner" style="${u.avatar ? avatarStyle(u) : ''}">${u.avatar ? '' : initials(u.displayName)}</div></div><span>${escapeHtml(u.displayName)}</span>`;
    item.addEventListener('click', () => viewStories(byUser[uid], u));
    el.appendChild(item);
  });
}

function viewStories(stories, user) {
  let idx = 0;
  const modal = $('#storyModal');
  const viewer = $('#storyViewer');
  function render() {
    if (!stories.length) { modal.classList.add('hidden'); return; }
    const s = stories[idx];
    const isMine = s.userId === state.user.id;
    viewer.innerHTML = `<button class="story-close">✕</button>` +
      (s.mediaType === 'video' ? `<video src="${s.mediaUrl}" autoplay controls></video>` : `<img src="${s.mediaUrl}">`) +
      (isMine ? `<button class="story-delete-btn" title="Удалить историю">🗑</button>` : '') +
      (s.caption ? `<div class="story-caption">${escapeHtml(s.caption)}</div>` : '');
    viewer.querySelector('.story-close').addEventListener('click', () => modal.classList.add('hidden'));
    const delBtn = viewer.querySelector('.story-delete-btn');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Удалить эту историю?')) return;
        try {
          await api(`/api/stories/${s.id}`, { method: 'DELETE' });
          stories.splice(idx, 1);
          if (idx >= stories.length) idx = 0;
          render();
          loadStories();
        } catch (err) { alert(err.message); }
      });
    }
    viewer.addEventListener('click', (e) => {
      if (e.target.closest('.story-close') || e.target.closest('.story-delete-btn')) return;
      idx = (idx + 1) % stories.length;
      render();
    }, { once: true });
  }
  render();
  showModal(modal);
}

let storyPickedFile = null;
function openCreateStoryModal() {
  storyPickedFile = null;
  $('#storyPreviewWrap').innerHTML = '';
  $('#storyCaption').value = '';
  showModal('#createStoryModal');
}
$('#storyPickFileBtn').addEventListener('click', () => $('#storyFileInput').click());
$('#storyFileInput').addEventListener('change', () => {
  const file = $('#storyFileInput').files[0];
  if (!file) return;
  storyPickedFile = file;
  const url = URL.createObjectURL(file);
  $('#storyPreviewWrap').innerHTML = file.type.startsWith('video') ? `<video src="${url}" controls></video>` : `<img src="${url}">`;
});
$('#publishStoryBtn').addEventListener('click', async () => {
  if (!storyPickedFile) { alert('Выберите фото или видео'); return; }
  const url = await uploadFile(storyPickedFile, 'story');
  await api('/api/stories', { method: 'POST', body: { mediaUrl: url, mediaType: storyPickedFile.type.startsWith('video') ? 'video' : 'image', caption: $('#storyCaption').value.trim() } });
  $('#createStoryModal').classList.add('hidden');
  loadStories();
});

/* ---------------- ИСТОРИЯ ЗВОНКОВ (раздел «Звонки») ---------------- */

async function loadCallHistory() {
  try {
    const { calls } = await api('/api/calls');
    renderCallHistory(calls);
  } catch (err) {
    $('#callsList').innerHTML = '<div class="calls-empty">Не удалось загрузить историю звонков</div>';
  }
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderCallHistory(calls) {
  const el = $('#callsList');
  el.innerHTML = '';
  if (!calls.length) {
    el.innerHTML = '<div class="calls-empty">Пока нет звонков — история появится здесь</div>';
    return;
  }
  calls.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'call-history-row';
    if (c.mode === '1:1') {
      const name = c.peer ? c.peer.displayName : 'Неизвестный';
      const dirIcon = c.direction === 'outgoing' ? '↗' : '↙';
      let icon = dirIcon, statusText = 'Звонок', statusClass = '';
      if (c.status === 'missed') { icon = '✕'; statusText = c.direction === 'outgoing' ? 'Не ответили' : 'Пропущенный'; statusClass = 'missed'; }
      else if (c.status === 'declined') { icon = '✕'; statusText = 'Отклонён'; statusClass = 'missed'; }
      else if (c.status === 'answered') { statusText = c.durationSec != null ? formatDuration(c.durationSec) : 'Разговор'; }
      const kindIcon = c.kind === 'video' ? '🎥' : '📞';
      row.innerHTML = `
        <div class="avatar" style="${c.peer ? avatarStyle(c.peer) : ''}">${c.peer && c.peer.avatar ? '' : initials(name)}</div>
        <div class="grow">
          <div class="name">${escapeHtml(name)} <span class="call-icon">${kindIcon}</span></div>
          <div class="sub ${statusClass}">${icon} ${escapeHtml(statusText)}</div>
        </div>
        <div class="time">${fmtTime(c.startedAt)}</div>
        ${c.peer ? `<button class="redial-btn" data-redial="${c.peer.id}" data-kind="${c.kind}" title="Перезвонить">${kindIcon}</button>` : ''}
      `;
    } else {
      const durationText = c.durationSec != null ? formatDuration(c.durationSec) : (c.status === 'ongoing' ? 'Идёт сейчас' : '');
      row.innerHTML = `
        <div class="avatar">🎧</div>
        <div class="grow">
          <div class="name">${escapeHtml(c.channelName || 'Канал')} <span class="call-icon">👥</span></div>
          <div class="sub">Групповой звонок${durationText ? ' · ' + escapeHtml(durationText) : ''}</div>
        </div>
        <div class="time">${fmtTime(c.startedAt)}</div>
      `;
    }
    el.appendChild(row);
  });
  el.querySelectorAll('[data-redial]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await redialUser(btn.dataset.redial, btn.dataset.kind);
    });
  });
}

async function redialUser(userId, kind) {
  const { conversation } = await api('/api/conversations', { method: 'POST', body: { type: 'dm', userId } });
  await loadConversations();
  switchSection('chats');
  await openConversation(conversation.id);
  startCall(kind || 'audio');
}

/* ---------------- CALLS (WebRTC) ---------------- */

// В локальной сети браузерам почти всегда хватало прямого соединения (или
// одного публичного STUN). В глобальной сети между двумя обычными интернет-
// подключениями почти всегда стоит NAT, и без TURN-релея звонок у части
// пользователей просто не будет соединяться. Поэтому конфигурация ICE теперь
// подтягивается с сервера (свой TURN + STUN, см. /api/turn-credentials) и
// периодически обновляется, а не зашита в один статический STUN-адрес.
let RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; // резерв, пока не подтянули настоящий
let rtcConfigFetchedAt = 0;
async function ensureRtcConfig() {
  const fresh = Date.now() - rtcConfigFetchedAt < 3 * 60 * 60 * 1000; // креды живут 6ч на сервере, обновляем с запасом
  if (fresh) return RTC_CONFIG;
  try {
    const data = await api('/api/turn-credentials');
    if (data && Array.isArray(data.iceServers) && data.iceServers.length) {
      RTC_CONFIG = { iceServers: data.iceServers };
      rtcConfigFetchedAt = Date.now();
    }
  } catch (e) {
    // Сервер недоступен/не авторизованы — останемся на резервном публичном STUN,
    // звонки в пределах одной сети (или без строгого NAT) всё равно сработают.
  }
  return RTC_CONFIG;
}

$('#audioCallBtn').addEventListener('click', () => startCall('audio'));
$('#videoCallBtn').addEventListener('click', () => startCall('video'));
$('#hangupBtn').addEventListener('click', endCall);
$('#acceptCallBtn').addEventListener('click', acceptIncomingCall);
$('#declineCallBtn').addEventListener('click', declineIncomingCall);
$('#toggleMicBtn').addEventListener('click', toggleMic);
$('#toggleCamBtn').addEventListener('click', toggleCam);
$('#flipCamBtn').addEventListener('click', flipCamera);

let pendingOffer = null;
// Кандидаты ICE, пришедшие раньше, чем наш RTCPeerConnection готов их принять
// (пока идёт «звонок» на экране входящего вызова, или пока не установлено
// remoteDescription) — раньше такие кандидаты просто терялись, из-за чего
// звонок иногда не мог соединиться (чёрный экран без звука). Теперь они
// складываются в очередь и применяются, как только соединение готово.
let pendingCallIce = [];

function queueOrApplyCallIce(candidate) {
  if (!candidate) return;
  if (state.peerConn && state.peerConn.remoteDescription) {
    state.peerConn.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  } else {
    pendingCallIce.push(candidate);
  }
}

function flushPendingCallIce() {
  if (!state.peerConn || !pendingCallIce.length) return;
  const queued = pendingCallIce;
  pendingCallIce = [];
  queued.forEach((c) => state.peerConn.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
}

function toggleMic() {
  if (!state.localStream) return;
  state.micOn = !state.micOn;
  state.localStream.getAudioTracks().forEach((t) => { t.enabled = state.micOn; });
  $('#toggleMicBtn').classList.toggle('off', !state.micOn);
  if (state.currentCallPeerId) state.ws.send(JSON.stringify({ type: 'call-media-toggle', to: state.currentCallPeerId, kind: 'audio', enabled: state.micOn }));
}

function toggleCam() {
  if (!state.localStream) return;
  const tracks = state.localStream.getVideoTracks();
  if (!tracks.length) return;
  state.camOn = !state.camOn;
  tracks.forEach((t) => { t.enabled = state.camOn; });
  $('#toggleCamBtn').classList.toggle('off', !state.camOn);
  // при выключении своей камеры прячем собственный превью-квадрат, при включении — возвращаем
  $('#localVideo').classList.toggle('hidden', !state.camOn);
  if (state.currentCallPeerId) state.ws.send(JSON.stringify({ type: 'call-media-toggle', to: state.currentCallPeerId, kind: 'video', enabled: state.camOn }));
}

async function flipCamera() {
  if (!state.localStream || !state.hasCamera) return;
  const oldTrack = state.localStream.getVideoTracks()[0];
  if (!oldTrack) return;
  const nextFacing = state.currentFacingMode === 'environment' ? 'user' : 'environment';
  try {
    const newStream = await getMedia({ video: { facingMode: nextFacing }, audio: false }, { silent: true });
    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) return;
    newTrack.enabled = state.camOn;
    if (state.peerConn) {
      const sender = state.peerConn.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
    }
    state.localStream.removeTrack(oldTrack);
    oldTrack.stop();
    state.localStream.addTrack(newTrack);
    $('#localVideo').srcObject = state.localStream;
    state.currentFacingMode = nextFacing;
  } catch (e) {
    alert('Не удалось переключить камеру: ' + (e.message || 'неизвестная ошибка'));
  }
}

// Аудио- и видеозвонок технически устроены одинаково: у обоих сразу
// запрашивается доступ и к микрофону, и к камере (если камера есть), просто
// для «аудиозвонка» видеодорожка сразу выключается (enabled=false). Это даёт
// возможность включить камеру прямо во время разговора без пересоздания
// соединения — трек уже согласован, его достаточно просто «включить».
async function acquireCallMedia() {
  try {
    const stream = await getMedia({ video: { facingMode: state.currentFacingMode || 'user' }, audio: true }, { silent: true });
    state.hasCamera = stream.getVideoTracks().length > 0;
    return stream;
  } catch (e) {
    state.hasCamera = false;
    return await getMedia({ video: false, audio: true });
  }
}

function attachPeerConnectionHandlers(pc) {
  pc.onicecandidate = (e) => { if (e.candidate) state.ws.send(JSON.stringify({ type: 'call-ice', to: state.currentCallPeerId, candidate: e.candidate })); };
  pc.ontrack = (e) => { $('#remoteVideo').srcObject = e.streams[0]; };
}

async function startCall(kind) {
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  if (!conv || !conv.peer) return;
  state.currentCallPeerId = conv.peer.id;
  state.currentCallId = genCallId();
  pendingCallIce = [];
  state.currentFacingMode = 'user';
  state.localStream = await acquireCallMedia();
  state.micOn = true;
  state.camOn = state.hasCamera && kind === 'video';
  state.remoteCamOn = kind === 'video';
  state.localStream.getVideoTracks().forEach((t) => { t.enabled = state.camOn; });
  await ensureRtcConfig();
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.peerConn = pc;
  state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
  attachPeerConnectionHandlers(pc);
  showCallOverlay(conv.peer, kind, true);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  state.ws.send(JSON.stringify({ type: 'call-offer', to: state.currentCallPeerId, sdp: offer, kind, callId: state.currentCallId }));
}

function genCallId() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('call_' + Date.now() + '_' + Math.random().toString(36).slice(2));
}

function handleCallSignal(msg) {
  if (msg.type === 'call-offer') {
    // если уже идёт другой звонок — просто отклоняем новый, чтобы не путать состояние
    if (state.currentCallPeerId || !$('#callOverlay').classList.contains('hidden')) {
      state.ws.send(JSON.stringify({ type: 'call-decline', to: msg.from }));
      return;
    }
    pendingOffer = msg;
    const peerUser = findKnownUser(msg.from);
    const name = peerUser ? peerUser.displayName : 'Неизвестный';
    $('#incomingPeerName').textContent = name;
    $('#incomingText').textContent = `Входящий ${msg.kind === 'video' ? 'видео' : 'аудио'}звонок…`;
    const av = $('#incomingAvatarBig');
    av.textContent = peerUser && peerUser.avatar ? '' : initials(name);
    av.style.cssText = peerUser ? avatarStyle(peerUser) : '';
    if (!peerUser) {
      ensureUserCached(msg.from).then((u) => {
        if (!u || pendingOffer !== msg) return;
        $('#incomingPeerName').textContent = u.displayName;
        av.textContent = u.avatar ? '' : initials(u.displayName);
        av.style.cssText = avatarStyle(u);
      });
    }
    showModal('#incomingCall');
  } else if (msg.type === 'call-answer') {
    if (state.peerConn) {
      state.peerConn.setRemoteDescription(new RTCSessionDescription(msg.sdp)).then(flushPendingCallIce).catch(() => {});
    }
    $('#callStatus').textContent = 'Соединено';
    startCallTimer();
    syncMediaStateToPeer();
  } else if (msg.type === 'call-ice') {
    queueOrApplyCallIce(msg.candidate);
  } else if (msg.type === 'call-end' || msg.type === 'call-decline') {
    // ключевой фикс: если собеседник отменил вызов до того, как мы ответили,
    // нужно закрыть и экран входящего звонка, и очистить pendingOffer —
    // иначе кнопка «Принять» попытается ответить на уже мёртвый вызов.
    pendingOffer = null;
    $('#incomingCall').classList.add('hidden');
    cleanupCall();
  } else if (msg.type === 'call-media-toggle') {
    if (msg.kind === 'video') {
      state.remoteCamOn = msg.enabled;
      updateRemoteVideoVisibility();
    } else {
      flashCallStatus(`Собеседник ${msg.enabled ? 'включил' : 'выключил'} микрофон`);
    }
  }
}

function updateRemoteVideoVisibility() {
  $('#remoteVideo').classList.toggle('hidden', !state.remoteCamOn);
  $('#callAvatarBig').classList.toggle('hidden', !!state.remoteCamOn);
}

// сообщаем собеседнику наше текущее состояние камеры сразу после соединения —
// это подстраховка на случай, если он успел переключить что-то ещё до ответа
function syncMediaStateToPeer() {
  if (!state.currentCallPeerId) return;
  state.ws.send(JSON.stringify({ type: 'call-media-toggle', to: state.currentCallPeerId, kind: 'video', enabled: state.camOn }));
}

function flashCallStatus(text) {
  const el = $('#callStatus');
  const prev = el.dataset.timerRunning === '1' ? null : el.textContent;
  el.textContent = text;
  setTimeout(() => { if (el.dataset.timerRunning !== '1' && prev !== null) el.textContent = prev; }, 2000);
}

async function acceptIncomingCall() {
  if (!pendingOffer) return;
  $('#incomingCall').classList.add('hidden');
  state.currentCallPeerId = pendingOffer.from;
  state.currentCallId = pendingOffer.callId;
  pendingCallIce = [];
  state.currentFacingMode = 'user';
  state.localStream = await acquireCallMedia();
  state.micOn = true;
  state.camOn = state.hasCamera && pendingOffer.kind === 'video';
  state.remoteCamOn = pendingOffer.kind === 'video';
  state.localStream.getVideoTracks().forEach((t) => { t.enabled = state.camOn; });
  await ensureRtcConfig();
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.peerConn = pc;
  state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
  attachPeerConnectionHandlers(pc);
  await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer.sdp));
  flushPendingCallIce();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  state.ws.send(JSON.stringify({ type: 'call-answer', to: state.currentCallPeerId, sdp: answer, callId: state.currentCallId }));
  const peerUser = findKnownUser(pendingOffer.from);
  showCallOverlay(peerUser || { displayName: 'Собеседник' }, pendingOffer.kind, false);
  startCallTimer();
  syncMediaStateToPeer();
  pendingOffer = null;
}

function declineIncomingCall() {
  if (pendingOffer) state.ws.send(JSON.stringify({ type: 'call-decline', to: pendingOffer.from, callId: pendingOffer.callId }));
  pendingOffer = null;
  $('#incomingCall').classList.add('hidden');
}

function showCallOverlay(peerUser, kind, outgoing) {
  const name = peerUser.displayName || 'Собеседник';
  $('#callPeerName').textContent = name;
  $('#callStatus').textContent = outgoing ? 'Вызов…' : 'Соединение…';
  $('#callStatus').dataset.timerRunning = '0';
  const av = $('#callAvatarBig');
  av.textContent = peerUser.avatar ? '' : initials(name);
  av.style.cssText = avatarStyle(peerUser);
  showModal('#callOverlay');
  $('#toggleMicBtn').classList.remove('off');
  $('#toggleCamBtn').classList.toggle('off', !state.camOn);

  const hasCamera = !!state.hasCamera;
  $('#toggleCamBtn').classList.toggle('hidden', !hasCamera);
  $('#flipCamBtn').classList.toggle('hidden', !hasCamera);

  // сбрасываем роли «большой экран / перетаскиваемый PIP» на дефолт для нового звонка
  state.pipSwapped = false;
  $('#remoteVideo').classList.add('vid-big'); $('#remoteVideo').classList.remove('vid-pip');
  $('#localVideo').classList.add('vid-pip'); $('#localVideo').classList.remove('vid-big');
  resetPipPosition();

  const localVideo = $('#localVideo');
  localVideo.srcObject = state.localStream;
  localVideo.classList.toggle('hidden', !state.camOn);

  updateRemoteVideoVisibility();
}

/* ---- Перетаскиваемый и меняемый местами PIP (свой/чужой вид в звонке) ---- */

function resetPipPosition() {
  ['remoteVideo', 'localVideo'].forEach((id) => {
    const el = $('#' + id);
    el.style.left = ''; el.style.top = ''; el.style.right = '';
  });
}

function swapPipVideos() {
  ['remoteVideo', 'localVideo'].forEach((id) => {
    const el = $('#' + id);
    el.classList.toggle('vid-big');
    el.classList.toggle('vid-pip');
  });
  resetPipPosition();
  state.pipSwapped = !state.pipSwapped;
}

function setupPipDraggable(el) {
  let dragging = false, moved = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
  el.addEventListener('pointerdown', (e) => {
    if (!el.classList.contains('vid-pip')) return;
    dragging = true; moved = false;
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    const rect = el.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    if (!moved) return;
    const screen = el.closest('.call-screen') || document.body;
    const bounds = screen.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    let newLeft = Math.max(bounds.left + 8, Math.min(startLeft + dx, bounds.right - w - 8));
    let newTop = Math.max(bounds.top + 8, Math.min(startTop + dy, bounds.bottom - h - 8));
    el.style.left = (newLeft - bounds.left) + 'px';
    el.style.top = (newTop - bounds.top) + 'px';
    el.style.right = 'auto';
  });
  function finishDrag() {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    if (!moved) swapPipVideos();
  }
  el.addEventListener('pointerup', finishDrag);
  el.addEventListener('pointercancel', finishDrag);
}
setupPipDraggable($('#remoteVideo'));
setupPipDraggable($('#localVideo'));

function startCallTimer() {
  state.callStartedAt = Date.now();
  $('#callStatus').dataset.timerRunning = '1';
  clearInterval(state.callTimerInt);
  state.callTimerInt = setInterval(() => {
    const sec = Math.floor((Date.now() - state.callStartedAt) / 1000);
    $('#callStatus').textContent = `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
  }, 1000);
}

function endCall() {
  if (state.currentCallPeerId) state.ws.send(JSON.stringify({ type: 'call-end', to: state.currentCallPeerId, callId: state.currentCallId }));
  cleanupCall();
}

function cleanupCall() {
  if (state.peerConn) { state.peerConn.close(); state.peerConn = null; }
  pendingCallIce = [];
  if (state.localStream) { state.localStream.getTracks().forEach((t) => t.stop()); state.localStream = null; }
  clearInterval(state.callTimerInt);
  state.callTimerInt = null;
  state.currentCallPeerId = null;
  state.currentCallId = null;
  state.hasCamera = false;
  state.pipSwapped = false;
  resetPipPosition();
  $('#callOverlay').classList.add('hidden');
  $('#remoteVideo').srcObject = null;
  $('#localVideo').srcObject = null;
  $('#remoteVideo').classList.add('hidden');
  $('#localVideo').classList.add('hidden');
  $('#callAvatarBig').classList.remove('hidden');
  if (state.activeSection === 'calls') loadCallHistory();
}

/* ---------------- ГРУППОВЫЕ ЗВОНКИ В КАНАЛАХ (mesh: каждый с каждым) ---------------- */

let groupCall = null; // { conversationId, localStream, pcs: Map<userId, RTCPeerConnection>, micOn, camOn, hasCamera, facingMode }

function updateGroupCallButton(conv) {
  const btn = $('#groupCallBtn');
  if (!conv || conv.type !== 'group' || conv.groupCallsEnabled === false) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
  const count = conv.groupCallCount || 0;
  btn.textContent = count > 0 ? `🎧 ${count}` : '🎧';
  btn.title = count > 0 ? `Присоединиться (сейчас ${count})` : 'Начать групповой звонок';
}

$('#groupCallBtn').addEventListener('click', () => {
  const conv = state.conversations.find((c) => c.id === state.activeConvId);
  if (conv) startOrJoinGroupCall(conv);
});

$('#groupCallShareBtn').addEventListener('click', () => {
  if (!groupCall) return;
  const conv = state.conversations.find((c) => c.id === groupCall.conversationId);
  if (!conv || !conv.inviteCode) return;
  openShareModal(`Звонок в «${conv.name}»`, buildInviteLink(conv.inviteCode));
});

async function startOrJoinGroupCall(conv) {
  if (groupCall) { alert('Вы уже участвуете в другом групповом звонке. Сначала покиньте его.'); return; }
  if (state.currentCallPeerId) { alert('Сначала завершите обычный звонок.'); return; }
  await ensureRtcConfig();
  let localStream;
  try {
    localStream = await acquireCallMedia();
  } catch (e) { return; }
  groupCall = {
    conversationId: conv.id,
    localStream,
    pcs: new Map(),
    micOn: true,
    camOn: state.hasCamera,
    hasCamera: state.hasCamera,
    facingMode: 'user',
  };
  localStream.getVideoTracks().forEach((t) => { t.enabled = groupCall.camOn; });

  $('#groupCallTitle').textContent = conv.name;
  $('#groupCallStatus').textContent = 'Подключение…';
  $('#groupCallGrid').innerHTML = '';
  $('#groupToggleMicBtn').classList.remove('off');
  $('#groupToggleCamBtn').classList.toggle('off', !groupCall.camOn);
  $('#groupToggleCamBtn').classList.toggle('hidden', !groupCall.hasCamera);
  $('#groupFlipCamBtn').classList.toggle('hidden', !groupCall.hasCamera);
  addOrUpdateGroupTile('self', state.user, localStream, true, !groupCall.camOn);
  showModal('#groupCallOverlay');

  state.ws.send(JSON.stringify({ type: 'group-call-join', conversationId: conv.id, kind: groupCall.hasCamera ? 'video' : 'audio' }));
}

function addOrUpdateGroupTile(userId, userObj, stream, isSelf, camOff) {
  let tile = document.getElementById('gc-tile-' + userId);
  const name = userObj ? userObj.displayName : 'Участник';
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'group-call-tile';
    tile.id = 'gc-tile-' + userId;
    $('#groupCallGrid').appendChild(tile);
  }
  const showVideo = stream && stream.getVideoTracks().length && !camOff;
  tile.innerHTML = showVideo
    ? `<video autoplay playsinline ${isSelf ? 'muted' : ''}></video><div class="tile-label">${isSelf ? '' : '🔊 '}${escapeHtml(name)}</div>`
    : `<div class="tile-avatar">${initials(name)}</div><div class="tile-label">${escapeHtml(name)} <span class="tile-muted">🎙 выкл. камеры</span></div>`;
  if (showVideo) tile.querySelector('video').srcObject = stream;
}

function removeGroupTile(userId) {
  const tile = document.getElementById('gc-tile-' + userId);
  if (tile) tile.remove();
}

function createGroupPeerConnection(peerId) {
  ensureRtcConfig(); // не блокируем — просто освежаем креды в фоне, если истекают
  const pc = new RTCPeerConnection(RTC_CONFIG);
  groupCall.localStream.getTracks().forEach((t) => pc.addTrack(t, groupCall.localStream));
  pc.onicecandidate = (e) => {
    if (e.candidate) state.ws.send(JSON.stringify({ type: 'group-call-ice', conversationId: groupCall.conversationId, to: peerId, candidate: e.candidate }));
  };
  pc.ontrack = (e) => {
    const peerUser = findKnownUser(peerId);
    addOrUpdateGroupTile(peerId, peerUser, e.streams[0], false, false);
    if (!peerUser) {
      ensureUserCached(peerId).then((u) => {
        if (u && groupCall && groupCall.pcs.has(peerId)) addOrUpdateGroupTile(peerId, u, e.streams[0], false, false);
      });
    }
  };
  groupCall.pcs.set(peerId, pc);
  return pc;
}

async function handleGroupCallSignal(msg) {
  if (!groupCall || msg.conversationId !== groupCall.conversationId) {
    // сигнал по звонку, в котором мы не участвуем (например, уже вышли) — игнорируем
    if (msg.type !== 'group-call-state') return;
  }
  if (msg.type === 'group-call-state') {
    if (!groupCall) return;
    $('#groupCallStatus').textContent = msg.participants.length ? `Участников: ${msg.participants.length + 1}` : 'Ожидание собеседников…';
    for (const peerId of msg.participants) {
      const pc = createGroupPeerConnection(peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.ws.send(JSON.stringify({ type: 'group-call-offer', conversationId: groupCall.conversationId, to: peerId, sdp: offer }));
    }
  } else if (msg.type === 'group-call-offer') {
    if (!groupCall) return;
    const pc = groupCall.pcs.get(msg.from) || createGroupPeerConnection(msg.from);
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    state.ws.send(JSON.stringify({ type: 'group-call-answer', conversationId: groupCall.conversationId, to: msg.from, sdp: answer }));
  } else if (msg.type === 'group-call-answer') {
    if (!groupCall) return;
    const pc = groupCall.pcs.get(msg.from);
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  } else if (msg.type === 'group-call-ice') {
    if (!groupCall) return;
    const pc = groupCall.pcs.get(msg.from);
    if (pc && msg.candidate) pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
  } else if (msg.type === 'group-call-peer-joined') {
    if (!groupCall) return;
    $('#groupCallStatus').textContent = `Участников: ${groupCall.pcs.size + 2}`;
    // ждём офер от нового участника — сами не звоним, чтобы не было дублей соединений
  } else if (msg.type === 'group-call-peer-left') {
    if (!groupCall) return;
    const pc = groupCall.pcs.get(msg.userId);
    if (pc) { pc.close(); groupCall.pcs.delete(msg.userId); }
    removeGroupTile(msg.userId);
    $('#groupCallStatus').textContent = `Участников: ${groupCall.pcs.size + 1}`;
  }
}

function toggleGroupMic() {
  if (!groupCall) return;
  groupCall.micOn = !groupCall.micOn;
  groupCall.localStream.getAudioTracks().forEach((t) => { t.enabled = groupCall.micOn; });
  $('#groupToggleMicBtn').classList.toggle('off', !groupCall.micOn);
}

function toggleGroupCam() {
  if (!groupCall) return;
  const tracks = groupCall.localStream.getVideoTracks();
  if (!tracks.length) return;
  groupCall.camOn = !groupCall.camOn;
  tracks.forEach((t) => { t.enabled = groupCall.camOn; });
  $('#groupToggleCamBtn').classList.toggle('off', !groupCall.camOn);
  addOrUpdateGroupTile('self', state.user, groupCall.localStream, true, !groupCall.camOn);
}

async function flipGroupCamera() {
  if (!groupCall || !groupCall.hasCamera) return;
  const oldTrack = groupCall.localStream.getVideoTracks()[0];
  if (!oldTrack) return;
  const nextFacing = groupCall.facingMode === 'environment' ? 'user' : 'environment';
  try {
    const newStream = await getMedia({ video: { facingMode: nextFacing }, audio: false }, { silent: true });
    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) return;
    newTrack.enabled = groupCall.camOn;
    groupCall.pcs.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(newTrack);
    });
    groupCall.localStream.removeTrack(oldTrack);
    oldTrack.stop();
    groupCall.localStream.addTrack(newTrack);
    groupCall.facingMode = nextFacing;
    addOrUpdateGroupTile('self', state.user, groupCall.localStream, true, !groupCall.camOn);
  } catch (e) {
    alert('Не удалось переключить камеру: ' + (e.message || 'неизвестная ошибка'));
  }
}

function leaveGroupCallLocal() {
  if (!groupCall) return;
  state.ws.send(JSON.stringify({ type: 'group-call-leave', conversationId: groupCall.conversationId }));
  groupCall.pcs.forEach((pc) => pc.close());
  groupCall.localStream.getTracks().forEach((t) => t.stop());
  groupCall = null;
  $('#groupCallOverlay').classList.add('hidden');
  $('#groupCallGrid').innerHTML = '';
  if (state.activeSection === 'calls') loadCallHistory();
}

$('#groupToggleMicBtn').addEventListener('click', toggleGroupMic);
$('#groupToggleCamBtn').addEventListener('click', toggleGroupCam);
$('#groupFlipCamBtn').addEventListener('click', flipGroupCamera);
$('#groupHangupBtn').addEventListener('click', leaveGroupCallLocal);

/* ---------------- ADMIN PANEL (теперь отдельный раздел) ---------------- */

$('#adminRevokeSelfBtn').addEventListener('click', async () => {
  if (!confirm('Снять с себя права администратора? Раздел «Админ» пропадёт, вернуть доступ можно будет снова написав боту команду.')) return;
  try {
    await api(`/api/admin/users/${state.user.id}`, { method: 'PATCH', body: { isAdmin: false } });
    state.user.isAdmin = false;
    $('#adminNavBtn').classList.add('hidden');
    $('#openAdminFromSettingsBtn').classList.add('hidden');
    switchSection('chats');
  } catch (err) { alert(err.message); }
});

$all('.modal-tab[data-atab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    $all('.modal-tab[data-atab]').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const t = tab.dataset.atab;
    $('#adminUsersTab').classList.toggle('hidden', t !== 'users');
    $('#adminChatsTab').classList.toggle('hidden', t !== 'chats');
  });
});

async function openAdminPanel() {
  await Promise.all([renderAdminUsers(), renderAdminChats()]);
}

async function renderAdminUsers() {
  const { users } = await api('/api/admin/users');
  users.forEach((u) => { state.usersById[u.id] = u; });
  const el = $('#adminUsersTab');
  el.innerHTML = '';
  users.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'admin-user-row';
    const canDelete = !u.isBot && u.id !== state.user.id;
    row.innerHTML = `
      <div class="avatar" style="${u.avatar ? avatarStyle(u) : ''}">${u.avatar ? '' : initials(u.displayName)}</div>
      <div class="grow">
        <div class="name">${escapeHtml(u.displayName)}${verifiedBadge(u)} ${u.isAdmin ? '<span class="admin-badge">admin</span>' : ''} ${u.isBot ? '🤖' : ''}</div>
        <div class="sub">@${escapeHtml(u.username)}</div>
      </div>
      ${!u.isBot ? `<button class="btn-secondary" data-verify="${u.id}">${u.isVerified ? 'Снять галочку' : '✔️ Верифицировать'}</button>` : ''}
      <button class="btn-secondary" data-edit="${u.id}">Изменить</button>
      ${canDelete ? `<button class="btn-danger" data-del="${u.id}">Удалить</button>` : ''}
    `;
    el.appendChild(row);
  });
  el.querySelectorAll('[data-verify]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const u = users.find((x) => x.id === btn.dataset.verify);
      try {
        await api(`/api/admin/users/${btn.dataset.verify}`, { method: 'PATCH', body: { isVerified: !u.isVerified } });
        renderAdminUsers();
      } catch (err) { alert(err.message); }
    });
  });
  el.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openAdminEditUser(btn.dataset.edit, users));
  });
  el.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const u = users.find((x) => x.id === btn.dataset.del);
      if (!confirm(`Удалить аккаунт «${u.displayName}» (@${u.username}) безвозвратно? Его чаты и каналы тоже будут удалены.`)) return;
      try {
        await api(`/api/admin/users/${btn.dataset.del}`, { method: 'DELETE' });
        renderAdminUsers();
      } catch (err) { alert(err.message); }
    });
  });
}

let adminEditingUserId = null;
function openAdminEditUser(userId, users) {
  const u = users.find((x) => x.id === userId);
  if (!u) return;
  adminEditingUserId = userId;
  $('#adminEditDisplayName').value = u.displayName || '';
  $('#adminEditUsername').value = u.username || '';
  $('#adminEditStatus').value = u.status || '';
  $('#adminEditPassword').value = '';
  $('#adminEditError').textContent = '';
  const av = $('#adminEditAvatarPreview');
  av.textContent = u.avatar ? '' : initials(u.displayName);
  av.style.cssText = avatarStyle(u);
  av.dataset.avatarUrl = u.avatar || '';
  showModal('#adminEditUserModal');
}
$('#adminChangeAvatarBtn').addEventListener('click', () => $('#adminAvatarInput').click());
$('#adminAvatarInput').addEventListener('change', async () => {
  const file = $('#adminAvatarInput').files[0];
  if (!file) return;
  const url = await uploadFile(file, 'avatar');
  const av = $('#adminEditAvatarPreview');
  av.dataset.avatarUrl = url;
  av.style.cssText = `background-image:url('${url}')`;
  av.textContent = '';
});
$('#adminSaveUserBtn').addEventListener('click', async () => {
  $('#adminEditError').textContent = '';
  const patch = {
    displayName: $('#adminEditDisplayName').value.trim(),
    username: $('#adminEditUsername').value.trim(),
    status: $('#adminEditStatus').value.trim(),
    avatar: $('#adminEditAvatarPreview').dataset.avatarUrl || '',
  };
  const newPassword = $('#adminEditPassword').value;
  if (newPassword) patch.newPassword = newPassword;
  try {
    await api(`/api/admin/users/${adminEditingUserId}`, { method: 'PATCH', body: patch });
    $('#adminEditUserModal').classList.add('hidden');
    renderAdminUsers();
  } catch (err) { $('#adminEditError').textContent = err.message; }
});

async function renderAdminChats() {
  const { conversations } = await api('/api/admin/conversations');
  const el = $('#adminChatsTab');
  el.innerHTML = '';
  conversations.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'admin-chat-row';
    row.innerHTML = `
      <div class="avatar">${initials(c.title || c.name || '?')}</div>
      <div class="grow">
        <div class="name">${escapeHtml(c.title || c.name)} ${c.type === 'channel' ? '📢' : c.type === 'group' ? '👥' : ''}</div>
        <div class="sub">${c.messageCount} сообщений</div>
      </div>
      <button class="btn-secondary" data-view="${c.id}">Просмотреть</button>
    `;
    el.appendChild(row);
  });
  el.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => openAdminChatView(btn.dataset.view, conversations));
  });
}

async function openAdminChatView(convId, conversations) {
  const conv = conversations.find((c) => c.id === convId);
  $('#adminChatViewTitle').textContent = conv ? (conv.title || conv.name) : 'Чат';
  const { messages } = await api(`/api/admin/conversations/${convId}/messages`);
  const el = $('#adminChatMessages');
  el.innerHTML = '';
  messages.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'admin-msg-row';
    const sender = state.usersById[m.senderId];
    const label = sender ? sender.displayName : m.senderId;
    row.innerHTML = `
      <div>
        <div><b>${escapeHtml(label)}:</b> ${escapeHtml(previewText(m))}</div>
        <div class="admin-msg-meta">${fmtTime(m.createdAt)} · ${fmtDate(m.createdAt)}</div>
      </div>
      <button data-del="${m.id}">Удалить</button>
    `;
    el.appendChild(row);
  });
  el.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Удалить сообщение?')) return;
      await api(`/api/messages/${btn.dataset.del}`, { method: 'DELETE' });
      openAdminChatView(convId, conversations);
      renderAdminChats();
    });
  });
  showModal('#adminChatViewModal');
}

/* ---------------- INIT ---------------- */
checkSession();
