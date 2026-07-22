'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const crypto = require('crypto');

const db = require('./lib/db');
const { WSServer } = require('./lib/minirt-ws');
const { genId, hashPassword, verifyPassword, parseCookies, serializeCookie } = require('./lib/util');
const { createTurnServer, generateTurnCredentials } = require('./lib/mini-turn');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 дней

// ---------- Бот ----------
const BOT_ID = 'bot_asteria';
const ADMIN_COMMAND = '/openadmin89778958103';
function ensureBotUser() {
  const users = db.all('users');
  if (!users.find((u) => u.id === BOT_ID)) {
    db.insert('users', {
      id: BOT_ID,
      username: 'asteria_bot',
      displayName: 'Asteria Bot',
      passwordHash: null,
      isBot: true,
      avatar: '',
      status: 'Бот-помощник',
      createdAt: Date.now(),
    });
  }
}
ensureBotUser();

function botReply(text) {
  const t = (text || '').trim().toLowerCase();
  if (t === '/help' || t === 'помощь' || t === '/start') {
    return 'Привет! Я бот Asteria \u{1F44B}\nКоманды:\n/time — текущее время сервера\n/dice — бросить кубик\n/coin — подбросить монетку\n/echo текст — повторю за тобой';
  }
  if (t === '/time') return 'Серверное время: ' + new Date().toLocaleString('ru-RU');
  if (t === '/dice') return 'Выпало: ' + (1 + Math.floor(Math.random() * 6));
  if (t === '/coin') return Math.random() < 0.5 ? 'Орёл' : 'Решка';
  if (t.startsWith('/echo ')) return text.slice(6);
  return 'Не знаю такой команды. Напиши /help';
}

// ---------- Сессии ----------
function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['asteria_session'];
  if (!token) return null;
  const session = db.findById('sessions', token);
  if (!session) return null;
  return session;
}

function getUserFromReq(req) {
  const session = getSession(req);
  if (!session) return null;
  const user = db.findById('users', session.userId);
  return user;
}

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

function requireAdmin(user, res) {
  if (!user || !user.isAdmin) {
    sendJSON(res, 403, { error: 'Требуются права администратора' });
    return false;
  }
  return true;
}

function removeConvFromAllFolders(convId) {
  db.all('folders').forEach((f) => {
    if ((f.convIds || []).includes(convId)) {
      db.update('folders', f.id, { convIds: f.convIds.filter((id) => id !== convId) });
    }
  });
}

// ---------- HTTP helpers ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxBytes = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, rootDir, urlPath) {
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(rootDir, safePath);
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (err2, data) => {
      if (err2) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': data.length });
      res.end(data);
    });
  });
}

// ---------- Conversations helpers ----------
function ensureDMExists(userAId, userBId) {
  const convs = db.all('conversations');
  let conv = convs.find(
    (c) => c.type === 'dm' && c.participants.includes(userAId) && c.participants.includes(userBId)
  );
  if (!conv) {
    conv = db.insert('conversations', {
      id: genId('conv'),
      type: 'dm',
      participants: [userAId, userBId],
      createdAt: Date.now(),
    });
  }
  return conv;
}

function userConversations(userId) {
  return db.all('conversations').filter((c) => {
    if (c.type === 'dm') return c.participants.includes(userId);
    if (c.type === 'channel' || c.type === 'group') return c.participants.includes(userId) || c.ownerId === userId;
    return false;
  });
}

// ---------- WebSocket state ----------
const wss = new WSServer();
const socketsByUser = new Map(); // userId -> Set<WSConnection>
const groupCallRooms = new Map(); // conversationId -> Set<userId> (кто сейчас в групповом звонке)
const groupCallRecordIds = new Map(); // conversationId -> id текущей записи в calls (пока звонок идёт)

function addSocket(userId, conn) {
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId).add(conn);
}
function removeSocket(userId, conn) {
  const set = socketsByUser.get(userId);
  if (set) { set.delete(conn); if (set.size === 0) socketsByUser.delete(userId); }
}
function sendToUser(userId, payload) {
  const set = socketsByUser.get(userId);
  if (!set) return;
  set.forEach((conn) => conn.send(payload));
}
function broadcastToConversation(conv, payload, exceptUserId) {
  const targets = (conv.type === 'channel' || conv.type === 'group') ? [...(conv.participants || []), conv.ownerId] : conv.participants;
  new Set(targets).forEach((uid) => {
    if (uid && uid !== exceptUserId) sendToUser(uid, payload);
  });
}

wss.on('connection', (conn, req) => {
  const user = getUserFromReq(req);
  if (!user) { conn.close(); return; }
  conn.userId = user.id;
  addSocket(user.id, conn);
  broadcastPresence(user.id, true);

  conn.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    handleWSMessage(user, conn, msg);
  });

  conn.on('close', () => {
    removeSocket(user.id, conn);
    if (!socketsByUser.has(user.id)) {
      broadcastPresence(user.id, false);
      groupCallRooms.forEach((room, convId) => { if (room.has(user.id)) leaveGroupCall(convId, user.id); });
    }
  });
});

function broadcastPresence(userId, online) {
  const payload = { type: 'presence', userId, online, at: Date.now() };
  socketsByUser.forEach((set) => set.forEach((c) => c.send(payload)));
}

function handleWSMessage(user, conn, msg) {
  if (!msg || !msg.type) return;

  if (msg.type === 'message') {
    const conv = db.findById('conversations', msg.conversationId);
    if (!conv) return;
    const isMember = conv.type === 'dm' ? conv.participants.includes(user.id) :
      (conv.participants.includes(user.id) || conv.ownerId === user.id);
    if (!isMember) return;
    // Каналы — всегда только вещание: писать может владелец или админ сайта,
    // остальные только читают/реагируют. Группы — обычный групповой чат,
    // писать может любой участник (это и есть разница между ними).
    if (conv.type === 'channel' && conv.ownerId !== user.id && !user.isAdmin) return;

    let meta = msg.meta || null;
    let content = msg.content || '';
    if (msg.msgType === 'poll') {
      const rawOptions = Array.isArray(meta && meta.options) ? meta.options : [];
      const options = rawOptions
        .map((o, i) => ({ id: 'opt' + i, text: String((o && o.text) || '').trim().slice(0, 120) }))
        .filter((o) => o.text)
        .slice(0, 12);
      if (options.length < 2) return; // опросу нужно минимум 2 варианта
      const question = String(content || (meta && meta.question) || '').trim().slice(0, 300);
      if (!question) return;
      const maxChoices = Math.max(1, Math.min(options.length, parseInt(meta && meta.maxChoices, 10) || 1));
      meta = { question, options, maxChoices, votes: {} };
      content = question;
    }

    const message = db.insert('messages', {
      id: genId('msg'),
      conversationId: conv.id,
      senderId: user.id,
      msgType: msg.msgType || 'text', // text|image|video|audio|voice|video_circle|file|music|sticker|poll
      content,
      mediaUrl: msg.mediaUrl || null,
      meta,
      createdAt: Date.now(),
    });
    db.update('conversations', conv.id, { lastMessageAt: message.createdAt });
    broadcastToConversation(conv, { type: 'message', message }, null);

    // Бот отвечает только в личном чате с ботом
    if (conv.type === 'dm' && conv.participants.includes(BOT_ID) && user.id !== BOT_ID) {
      const trimmed = (message.content || '').trim();
      setTimeout(() => {
        let replyText;
        if (trimmed === ADMIN_COMMAND) {
          db.update('users', user.id, { isAdmin: true });
          replyText = '🔑 Доступ администратора открыт. Кнопка «Админ» появится в интерфейсе автоматически.';
          sendToUser(user.id, { type: 'admin-granted' });
        } else {
          replyText = botReply(message.content);
        }
        const reply = db.insert('messages', {
          id: genId('msg'),
          conversationId: conv.id,
          senderId: BOT_ID,
          msgType: 'text',
          content: replyText,
          mediaUrl: null,
          meta: null,
          createdAt: Date.now(),
        });
        db.update('conversations', conv.id, { lastMessageAt: reply.createdAt });
        broadcastToConversation(conv, { type: 'message', message: reply }, null);
      }, 500);
    }
    return;
  }

  if (msg.type === 'reaction') {
    const message = db.findById('messages', msg.messageId);
    if (!message) return;
    const conv = db.findById('conversations', message.conversationId);
    if (!conv) return;
    const isMember = conv.type === 'dm' ? conv.participants.includes(user.id) :
      (conv.participants.includes(user.id) || conv.ownerId === user.id);
    if (!isMember) return;
    const emoji = msg.emoji;
    if (!emoji) return;
    const reactions = message.reactions ? JSON.parse(JSON.stringify(message.reactions)) : {};
    const alreadyHadThis = (reactions[emoji] || []).includes(user.id);
    // убираем реакцию пользователя со всех эмодзи (у одного человека — одна реакция на сообщение)
    Object.keys(reactions).forEach((e) => {
      reactions[e] = reactions[e].filter((uid) => uid !== user.id);
      if (reactions[e].length === 0) delete reactions[e];
    });
    if (!alreadyHadThis) {
      reactions[emoji] = [...(reactions[emoji] || []), user.id];
    }
    db.update('messages', message.id, { reactions });
    broadcastToConversation(conv, { type: 'reaction-update', messageId: message.id, conversationId: conv.id, reactions }, null);
    return;
  }

  if (msg.type === 'poll-vote') {
    const message = db.findById('messages', msg.messageId);
    if (!message || message.msgType !== 'poll' || !message.meta) return;
    const conv = db.findById('conversations', message.conversationId);
    if (!conv) return;
    const isMember = conv.type === 'dm' ? conv.participants.includes(user.id) :
      (conv.participants.includes(user.id) || conv.ownerId === user.id);
    if (!isMember) return;

    const validIds = new Set(message.meta.options.map((o) => o.id));
    const requested = Array.isArray(msg.optionIds) ? msg.optionIds.filter((id) => validIds.has(id)) : [];
    const uniqueRequested = Array.from(new Set(requested)).slice(0, message.meta.maxChoices);

    const votes = message.meta.votes ? JSON.parse(JSON.stringify(message.meta.votes)) : {};
    // убираем голос пользователя со всех вариантов, затем ставим заново на выбранные
    Object.keys(votes).forEach((optId) => {
      votes[optId] = votes[optId].filter((uid) => uid !== user.id);
      if (votes[optId].length === 0) delete votes[optId];
    });
    uniqueRequested.forEach((optId) => {
      votes[optId] = [...(votes[optId] || []), user.id];
    });

    const updatedMeta = { ...message.meta, votes };
    db.update('messages', message.id, { meta: updatedMeta });
    broadcastToConversation(conv, { type: 'poll-update', messageId: message.id, conversationId: conv.id, votes }, null);
    return;
  }

  if (msg.type === 'typing') {
    const conv = db.findById('conversations', msg.conversationId);
    if (!conv) return;
    broadcastToConversation(conv, { type: 'typing', conversationId: conv.id, userId: user.id }, user.id);
    return;
  }

  // Сигналинг для 1:1 звонков (WebRTC): прокидываем сообщение адресату,
  // попутно ведём историю звонков в таблице calls
  if (['call-offer', 'call-answer', 'call-ice', 'call-end', 'call-decline', 'call-media-toggle'].includes(msg.type)) {
    if (!msg.to) return;

    if (msg.type === 'call-offer' && msg.callId) {
      db.insert('calls', {
        id: msg.callId,
        mode: '1:1',
        kind: msg.kind || 'audio',
        callerId: user.id,
        calleeId: msg.to,
        status: 'ringing',
        startedAt: Date.now(),
      });
    } else if (msg.type === 'call-answer' && msg.callId) {
      const rec = db.findById('calls', msg.callId);
      if (rec) db.update('calls', msg.callId, { status: 'answered', answeredAt: Date.now() });
    } else if (msg.type === 'call-decline' && msg.callId) {
      const rec = db.findById('calls', msg.callId);
      if (rec && rec.status === 'ringing') db.update('calls', msg.callId, { status: 'declined', endedAt: Date.now() });
    } else if (msg.type === 'call-end' && msg.callId) {
      const rec = db.findById('calls', msg.callId);
      if (rec) {
        if (rec.status === 'ringing') {
          db.update('calls', msg.callId, { status: 'missed', endedAt: Date.now() });
        } else if (rec.status === 'answered' && !rec.endedAt) {
          db.update('calls', msg.callId, { endedAt: Date.now(), durationSec: Math.max(0, Math.round((Date.now() - rec.answeredAt) / 1000)) });
        }
      }
    }

    sendToUser(msg.to, { ...msg, from: user.id });
    return;
  }

  // ---------- Групповые звонки в группах/каналах (mesh: каждый с каждым) ----------
  if (msg.type === 'group-call-join') {
    const conv = db.findById('conversations', msg.conversationId);
    if (!conv || (conv.type !== 'channel' && conv.type !== 'group')) return;
    const isMember = conv.ownerId === user.id || (conv.participants || []).includes(user.id);
    if (!isMember) return;
    if (conv.groupCallsEnabled === false) return;

    let room = groupCallRooms.get(conv.id);
    const isFirst = !room || room.size === 0;
    if (!room) { room = new Set(); groupCallRooms.set(conv.id, room); }
    const existingMembers = Array.from(room);
    room.add(user.id);

    if (isFirst) {
      const callId = genId('gcall');
      groupCallRecordIds.set(conv.id, callId);
      db.insert('calls', {
        id: callId, mode: 'group', kind: msg.kind || 'video', conversationId: conv.id,
        callerId: user.id, status: 'ongoing', startedAt: Date.now(),
      });
    }

    // сообщаем новичку, кто уже в комнате (чтобы он сам создал офферы каждому)
    sendToUser(user.id, { type: 'group-call-state', conversationId: conv.id, participants: existingMembers });
    // сообщаем остальным о новом участнике
    existingMembers.forEach((uid) => sendToUser(uid, { type: 'group-call-peer-joined', conversationId: conv.id, userId: user.id }));
    // сообщаем всем участникам канала (даже не в звонке), что звонок идёт — чтобы обновился счётчик
    broadcastToConversation(conv, { type: 'group-call-count', conversationId: conv.id, count: room.size }, null);
    return;
  }

  if (msg.type === 'group-call-leave') {
    leaveGroupCall(msg.conversationId, user.id);
    return;
  }

  if (['group-call-offer', 'group-call-answer', 'group-call-ice'].includes(msg.type)) {
    if (!msg.to) return;
    sendToUser(msg.to, { ...msg, from: user.id });
    return;
  }
}

function leaveGroupCall(conversationId, userId) {
  const room = groupCallRooms.get(conversationId);
  if (!room || !room.has(userId)) return;
  room.delete(userId);
  room.forEach((uid) => sendToUser(uid, { type: 'group-call-peer-left', conversationId, userId }));
  const conv = db.findById('conversations', conversationId);
  if (conv) broadcastToConversation(conv, { type: 'group-call-count', conversationId, count: room.size }, null);
  if (room.size === 0) {
    groupCallRooms.delete(conversationId);
    const callId = groupCallRecordIds.get(conversationId);
    if (callId) {
      const rec = db.findById('calls', callId);
      if (rec) db.update('calls', callId, { status: 'ended', endedAt: Date.now(), durationSec: Math.max(0, Math.round((Date.now() - rec.startedAt) / 1000)) });
      groupCallRecordIds.delete(conversationId);
    }
  }
}


// ---------- API маршруты ----------
async function handleAPI(req, res, pathname, query = {}) {
  const method = req.method;

  if (pathname === '/api/register' && method === 'POST') {
    const body = await readBody(req);
    const { username, password, displayName } = body;
    if (!username || !password || password.length < 4) {
      return sendJSON(res, 400, { error: 'Укажите логин и пароль (минимум 4 символа)' });
    }
    if (db.findOneBy('users', 'username', username)) {
      return sendJSON(res, 400, { error: 'Такой логин уже занят' });
    }
    const user = db.insert('users', {
      id: genId('u'),
      username,
      displayName: displayName || username,
      passwordHash: hashPassword(password),
      isBot: false,
      avatar: '',
      status: 'Привет! Я в Asteria',
      theme: 'light',
      chatWallpaper: '',
      discoverable: true,
      createdAt: Date.now(),
    });
    // авто-DM с ботом
    ensureDMExists(user.id, BOT_ID);
    const token = genId('sess');
    db.insert('sessions', { id: token, token, userId: user.id, createdAt: Date.now() });
    res.setHeader('Set-Cookie', serializeCookie('asteria_session', token, { maxAge: SESSION_MAX_AGE }));
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const body = await readBody(req);
    const { username, password } = body;
    const user = db.findOneBy('users', 'username', username);
    if (!user || user.isBot || !verifyPassword(password || '', user.passwordHash)) {
      return sendJSON(res, 401, { error: 'Неверный логин или пароль' });
    }
    const token = genId('sess');
    db.insert('sessions', { id: token, token, userId: user.id, createdAt: Date.now() });
    res.setHeader('Set-Cookie', serializeCookie('asteria_session', token, { maxAge: SESSION_MAX_AGE }));
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['asteria_session'];
    if (token) {
      db.remove('sessions', token);
    }
    res.setHeader('Set-Cookie', serializeCookie('asteria_session', '', { maxAge: 0 }));
    return sendJSON(res, 200, { ok: true });
  }

  // Всё что ниже требует авторизации
  const user = getUserFromReq(req);
  if (!user) return sendJSON(res, 401, { error: 'Не авторизован' });

  if (pathname === '/api/me' && method === 'GET') {
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  if (pathname === '/api/me' && method === 'PATCH') {
    const body = await readBody(req);
    const patch = {};
    ['displayName', 'status', 'avatar', 'theme', 'chatWallpaper'].forEach((k) => {
      if (body[k] !== undefined) patch[k] = body[k];
    });
    if (body.discoverable !== undefined) patch.discoverable = !!body.discoverable;
    if (body.username !== undefined) {
      const newUsername = String(body.username).trim();
      if (newUsername.length < 3) return sendJSON(res, 400, { error: 'Логин должен быть не короче 3 символов' });
      const existing = db.findOneBy('users', 'username', newUsername);
      if (existing && existing.id !== user.id) return sendJSON(res, 400, { error: 'Такой логин уже занят' });
      patch.username = newUsername;
    }
    const updated = db.update('users', user.id, patch);
    return sendJSON(res, 200, { user: publicUser(updated) });
  }

  if (pathname === '/api/me/password' && method === 'POST') {
    const body = await readBody(req);
    const { currentPassword, newPassword } = body;
    if (!newPassword || newPassword.length < 4) return sendJSON(res, 400, { error: 'Новый пароль должен быть не короче 4 символов' });
    if (!verifyPassword(currentPassword || '', user.passwordHash)) {
      return sendJSON(res, 400, { error: 'Текущий пароль указан неверно' });
    }
    db.update('users', user.id, { passwordHash: hashPassword(newPassword) });
    return sendJSON(res, 200, { ok: true });
  }

  const userProfileMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userProfileMatch && method === 'GET') {
    const target = db.findById('users', userProfileMatch[1]);
    if (!target) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    return sendJSON(res, 200, { user: publicUser(target) });
  }

  if (pathname === '/api/users' && method === 'GET') {
    const q = String(query.q || '').trim().toLowerCase();
    // Без поискового запроса список не отдаём — иначе это был бы публичный
    // каталог всех пользователей. Ищем только по логину, минимум 2 символа,
    // и только среди тех, кто разрешил находить себя по логину.
    if (q.length < 2) return sendJSON(res, 200, { users: [] });
    const users = db.all('users')
      .filter((u) => u.id !== user.id && !u.isBot && u.discoverable !== false && u.username.toLowerCase().includes(q))
      .slice(0, 20)
      .map(publicUser);
    return sendJSON(res, 200, { users });
  }

  if (pathname === '/api/conversations' && method === 'GET') {
    const convs = userConversations(user.id).sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    const enriched = convs.map((c) => enrichConversation(c, user.id));
    return sendJSON(res, 200, { conversations: enriched });
  }

  if (pathname === '/api/conversations' && method === 'POST') {
    const body = await readBody(req);
    if (body.type === 'dm') {
      const conv = ensureDMExists(user.id, body.userId);
      return sendJSON(res, 200, { conversation: enrichConversation(conv, user.id) });
    }
    if (body.type === 'channel') {
      const conv = db.insert('conversations', {
        id: genId('conv'),
        type: 'channel',
        name: body.name || 'Новый канал',
        avatar: body.avatar || '',
        ownerId: user.id,
        participants: [user.id],
        groupCallsEnabled: true,
        inviteCode: 'channel_' + crypto.randomBytes(5).toString('hex'),
        createdAt: Date.now(),
      });
      return sendJSON(res, 200, { conversation: enrichConversation(conv, user.id) });
    }
    if (body.type === 'group') {
      const conv = db.insert('conversations', {
        id: genId('conv'),
        type: 'group',
        name: body.name || 'Новая группа',
        avatar: body.avatar || '',
        ownerId: user.id,
        participants: [user.id],
        groupCallsEnabled: true,
        inviteCode: 'group_' + crypto.randomBytes(5).toString('hex'),
        createdAt: Date.now(),
      });
      return sendJSON(res, 200, { conversation: enrichConversation(conv, user.id) });
    }
    return sendJSON(res, 400, { error: 'Некорректный тип' });
  }

  // Локальное имя контакта в личном чате — видно только тому, кто его задал.
  const nicknameMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/nickname$/);
  if (nicknameMatch && method === 'POST') {
    const conv = db.findById('conversations', nicknameMatch[1]);
    if (!conv || conv.type !== 'dm' || !conv.participants.includes(user.id)) return sendJSON(res, 404, { error: 'Не найдено' });
    const body = await readBody(req);
    const nicknames = { ...(conv.nicknames || {}) };
    const nickname = String(body.nickname || '').trim().slice(0, 60);
    if (nickname) nicknames[user.id] = nickname; else delete nicknames[user.id];
    const updated = db.update('conversations', conv.id, { nicknames });
    return sendJSON(res, 200, { conversation: enrichConversation(updated, user.id) });
  }

  // ---------- Приглашения по ссылке (группы и каналы) ----------
  // Формат ссылки на клиенте: <адрес сайта>/j/<inviteCode>, где inviteCode
  // уже сам начинается с "group_" или "channel_" — так по одной ссылке сразу
  // видно, куда она ведёт.
  const inviteInfoMatch = pathname.match(/^\/api\/invite\/([^/]+)$/);
  if (inviteInfoMatch && method === 'GET') {
    const conv = db.all('conversations').find((c) => c.inviteCode === inviteInfoMatch[1]);
    if (!conv) return sendJSON(res, 404, { error: 'Ссылка недействительна или устарела' });
    const alreadyMember = conv.participants.includes(user.id) || conv.ownerId === user.id;
    return sendJSON(res, 200, {
      preview: {
        id: conv.id,
        type: conv.type,
        name: conv.name,
        avatar: conv.avatar || '',
        memberCount: (conv.participants || []).length,
        alreadyMember,
      },
    });
  }
  const inviteJoinMatch = pathname.match(/^\/api\/invite\/([^/]+)\/join$/);
  if (inviteJoinMatch && method === 'POST') {
    const conv = db.all('conversations').find((c) => c.inviteCode === inviteJoinMatch[1]);
    if (!conv) return sendJSON(res, 404, { error: 'Ссылка недействительна или устарела' });
    if (!conv.participants.includes(user.id) && conv.ownerId !== user.id) {
      const participants = [...conv.participants, user.id];
      const updated = db.update('conversations', conv.id, { participants });
      broadcastToConversation(updated, { type: 'conversation-updated', conversation: updated }, null);
      return sendJSON(res, 200, { conversation: enrichConversation(updated, user.id) });
    }
    return sendJSON(res, 200, { conversation: enrichConversation(conv, user.id) });
  }

  const convMsgMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (convMsgMatch && method === 'GET') {
    const convId = convMsgMatch[1];
    const conv = db.findById('conversations', convId);
    if (!conv) return sendJSON(res, 404, { error: 'Не найдено' });
    const msgs = db.findManyBy('messages', 'conversationId', convId);
    return sendJSON(res, 200, { messages: msgs });
  }

  const subMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/subscribe$/);
  if (subMatch && method === 'POST') {
    const conv = db.findById('conversations', subMatch[1]);
    if (!conv || (conv.type !== 'channel' && conv.type !== 'group')) return sendJSON(res, 404, { error: 'Не найдено' });
    if (!conv.participants.includes(user.id)) conv.participants.push(user.id);
    db.update('conversations', conv.id, { participants: conv.participants });
    return sendJSON(res, 200, { conversation: enrichConversation(conv, user.id) });
  }

  const unsubMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/unsubscribe$/);
  if (unsubMatch && method === 'POST') {
    const conv = db.findById('conversations', unsubMatch[1]);
    if (!conv || (conv.type !== 'channel' && conv.type !== 'group')) return sendJSON(res, 404, { error: 'Не найдено' });
    if (conv.ownerId === user.id) {
      const msg = conv.type === 'group' ? 'Владелец не может покинуть группу — удалите её' : 'Владелец не может отписаться — удалите канал';
      return sendJSON(res, 400, { error: msg });
    }
    const participants = (conv.participants || []).filter((p) => p !== user.id);
    const updated = db.update('conversations', conv.id, { participants });
    broadcastToConversation(updated, { type: 'conversation-updated', conversation: updated }, null);
    return sendJSON(res, 200, { ok: true });
  }

  const pinMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/pin$/);
  if (pinMatch && method === 'POST') {
    const conv = db.findById('conversations', pinMatch[1]);
    if (!conv) return sendJSON(res, 404, { error: 'Не найдено' });
    const body = await readBody(req);
    const pinned = !!body.pinned;
    let pinnedBy = conv.pinnedBy || [];
    if (pinned && !pinnedBy.includes(user.id)) pinnedBy = [...pinnedBy, user.id];
    if (!pinned) pinnedBy = pinnedBy.filter((id) => id !== user.id);
    const updated = db.update('conversations', conv.id, { pinnedBy });
    return sendJSON(res, 200, { conversation: enrichConversation(updated, user.id) });
  }

  // Закрепление СООБЩЕНИЯ внутри чата/канала (отдельно от закрепления самого
  // чата в списке слева, см. /pin выше) — показывается плашкой в шапке под
  // именем собеседника. В личных чатах закрепить/открепить может любой
  // участник, в каналах — только владелец канала или администратор сайта.
  const pinMsgMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/pin-message$/);
  if (pinMsgMatch && method === 'POST') {
    const conv = db.findById('conversations', pinMsgMatch[1]);
    if (!conv) return sendJSON(res, 404, { error: 'Не найдено' });
    const isMember = conv.type === 'dm' ? conv.participants.includes(user.id) :
      (conv.participants.includes(user.id) || conv.ownerId === user.id);
    if (!isMember) return sendJSON(res, 403, { error: 'Недостаточно прав' });
    if (conv.type === 'channel' && conv.ownerId !== user.id && !user.isAdmin) {
      return sendJSON(res, 403, { error: 'Закреплять сообщения в канале может только его владелец' });
    }
    const body = await readBody(req);
    let pinnedMessageId = null;
    if (body.messageId) {
      const message = db.findById('messages', body.messageId);
      if (!message || message.conversationId !== conv.id) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
      pinnedMessageId = message.id;
    }
    const updated = db.update('conversations', conv.id, { pinnedMessageId });
    broadcastToConversation(updated, { type: 'pin-update', conversationId: conv.id, pinnedMessage: pinnedMessageId ? db.findById('messages', pinnedMessageId) : null }, null);
    return sendJSON(res, 200, { conversation: enrichConversation(updated, user.id) });
  }

  const convItemMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (convItemMatch && method === 'PATCH') {
    const conv = db.findById('conversations', convItemMatch[1]);
    if (!conv) return sendJSON(res, 404, { error: 'Не найдено' });
    if (conv.type !== 'channel' && conv.type !== 'group') return sendJSON(res, 400, { error: 'Редактировать можно только каналы и группы' });
    if (conv.ownerId !== user.id && !user.isAdmin) return sendJSON(res, 403, { error: 'Недостаточно прав' });
    const body = await readBody(req);
    const patch = {};
    ['name', 'avatar', 'groupCallsEnabled'].forEach((k) => { if (body[k] !== undefined) patch[k] = body[k]; });
    const updated = db.update('conversations', conv.id, patch);
    broadcastToConversation(updated, { type: 'conversation-updated', conversation: updated }, null);
    return sendJSON(res, 200, { conversation: enrichConversation(updated, user.id) });
  }

  if (convItemMatch && method === 'DELETE') {
    const conv = db.findById('conversations', convItemMatch[1]);
    if (!conv) return sendJSON(res, 404, { error: 'Не найдено' });
    const isOwner = (conv.type === 'channel' || conv.type === 'group') && conv.ownerId === user.id;
    if (!isOwner && !user.isAdmin) return sendJSON(res, 403, { error: 'Недостаточно прав' });
    broadcastToConversation(conv, { type: 'conversation-deleted', conversationId: conv.id }, null);
    db.remove('conversations', conv.id);
    db.removeManyBy('messages', 'conversationId', conv.id);
    removeConvFromAllFolders(conv.id);
    return sendJSON(res, 200, { ok: true });
  }

  // Список публичных каналов (для поиска/подписки) — группы в общий список
  // намеренно не попадают, в них вступают только по пригласительной ссылке.
  if (pathname === '/api/channels' && method === 'GET') {
    const channels = db.all('conversations').filter((c) => c.type === 'channel').map((c) => enrichConversation(c, user.id));
    return sendJSON(res, 200, { channels });
  }

  if (pathname === '/api/upload' && method === 'POST') {
    const body = await readBody(req, 120 * 1024 * 1024);
    const { filename, dataBase64, kind } = body;
    if (!dataBase64) return sendJSON(res, 400, { error: 'Нет файла' });
    const ext = path.extname(filename || '') || '';
    const safeName = genId('file') + ext;
    const subdir = kind === 'avatar' ? 'avatars' : kind === 'story' ? 'stories' : kind === 'wallpaper' ? 'wallpapers' : '';
    const dir = subdir ? path.join(UPLOADS_DIR, subdir) : UPLOADS_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, safeName);
    const base64 = dataBase64.split(',').pop();
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    const urlPath = '/uploads/' + (subdir ? subdir + '/' : '') + safeName;
    return sendJSON(res, 200, { url: urlPath });
  }

  if (pathname === '/api/stories' && method === 'GET') {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const stories = db.all('stories').filter((s) => s.createdAt > cutoff);
    return sendJSON(res, 200, { stories });
  }

  if (pathname === '/api/stories' && method === 'POST') {
    const body = await readBody(req);
    const story = db.insert('stories', {
      id: genId('story'),
      userId: user.id,
      mediaUrl: body.mediaUrl || null,
      mediaType: body.mediaType || 'image',
      caption: body.caption || '',
      createdAt: Date.now(),
    });
    return sendJSON(res, 200, { story });
  }

  const storyItemMatch = pathname.match(/^\/api\/stories\/([^/]+)$/);
  if (storyItemMatch && method === 'DELETE') {
    const story = db.findById('stories', storyItemMatch[1]);
    if (!story) return sendJSON(res, 404, { error: 'История не найдена' });
    if (story.userId !== user.id && !user.isAdmin) return sendJSON(res, 403, { error: 'Недостаточно прав' });
    db.remove('stories', story.id);
    return sendJSON(res, 200, { ok: true });
  }

  const msgItemMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);
  if (msgItemMatch && method === 'PATCH') {
    const message = db.findById('messages', msgItemMatch[1]);
    if (!message) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
    if (message.senderId !== user.id && !user.isAdmin) return sendJSON(res, 403, { error: 'Недостаточно прав' });
    const body = await readBody(req);
    if (typeof body.content !== 'string' || !body.content.trim()) return sendJSON(res, 400, { error: 'Пустое сообщение' });
    const updated = db.update('messages', message.id, { content: body.content.trim(), edited: true, editedAt: Date.now() });
    const conv = db.findById('conversations', message.conversationId);
    if (conv) broadcastToConversation(conv, { type: 'message-edit', message: updated }, null);
    return sendJSON(res, 200, { message: updated });
  }

  if (msgItemMatch && method === 'DELETE') {
    const message = db.findById('messages', msgItemMatch[1]);
    if (!message) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
    if (message.senderId !== user.id && !user.isAdmin) return sendJSON(res, 403, { error: 'Недостаточно прав' });
    db.remove('messages', message.id);
    const conv = db.findById('conversations', message.conversationId);
    if (conv) {
      broadcastToConversation(conv, { type: 'message-delete', messageId: message.id, conversationId: message.conversationId }, null);
      if (conv.pinnedMessageId === message.id) {
        db.update('conversations', conv.id, { pinnedMessageId: null });
        broadcastToConversation(conv, { type: 'pin-update', conversationId: conv.id, pinnedMessage: null }, null);
      }
    }
    return sendJSON(res, 200, { ok: true });
  }

  // ---------- Админ-панель (доступ только для user.isAdmin) ----------
  if (pathname === '/api/admin/users' && method === 'GET') {
    if (!requireAdmin(user, res)) return;
    const users = db.all('users').map(publicUser);
    return sendJSON(res, 200, { users });
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && method === 'PATCH') {
    if (!requireAdmin(user, res)) return;
    const target = db.findById('users', adminUserMatch[1]);
    if (!target) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    const body = await readBody(req);
    const patch = {};
    ['displayName', 'status', 'avatar'].forEach((k) => { if (body[k] !== undefined) patch[k] = body[k]; });
    if (body.username !== undefined) {
      const newUsername = String(body.username).trim();
      if (newUsername.length < 3) return sendJSON(res, 400, { error: 'Логин должен быть не короче 3 символов' });
      const existing = db.findOneBy('users', 'username', newUsername);
      if (existing && existing.id !== target.id) return sendJSON(res, 400, { error: 'Такой логин уже занят' });
      patch.username = newUsername;
    }
    if (body.newPassword) {
      if (body.newPassword.length < 4) return sendJSON(res, 400, { error: 'Пароль слишком короткий' });
      patch.passwordHash = hashPassword(body.newPassword);
    }
    if (body.isAdmin !== undefined) {
      // снять/выдать права администратора. Можно снять и с самого себя —
      // именно так работает кнопка «Снять с себя права» в админ-панели.
      patch.isAdmin = !!body.isAdmin;
    }
    if (body.isVerified !== undefined) {
      if (target.isBot) return sendJSON(res, 400, { error: 'Бота нельзя верифицировать' });
      patch.isVerified = !!body.isVerified;
    }
    const updated = db.update('users', target.id, patch);
    if (patch.isAdmin === false) sendToUser(target.id, { type: 'admin-revoked' });
    if (patch.isAdmin === true) sendToUser(target.id, { type: 'admin-granted' });
    return sendJSON(res, 200, { user: publicUser(updated) });
  }

  if (adminUserMatch && method === 'DELETE') {
    if (!requireAdmin(user, res)) return;
    const target = db.findById('users', adminUserMatch[1]);
    if (!target) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    if (target.isBot) return sendJSON(res, 400, { error: 'Нельзя удалить бота' });
    if (target.id === user.id) return sendJSON(res, 400, { error: 'Нельзя удалить самого себя. Сначала снимите с себя права администратора, если нужно, а удаление собственного аккаунта делайте из-под обычной сессии.' });

    // разлогиниваем удаляемого пользователя везде
    db.removeManyBy('sessions', 'userId', target.id);

    // каскадно чистим его чаты и каналы
    db.all('conversations').forEach((conv) => {
      const inGroupOrChannelAsMember = (conv.type === 'channel' || conv.type === 'group') && (conv.participants || []).includes(target.id) && conv.ownerId !== target.id;
      const shouldDeleteWhole = (conv.type === 'dm' && conv.participants.includes(target.id)) ||
        ((conv.type === 'channel' || conv.type === 'group') && conv.ownerId === target.id);
      if (shouldDeleteWhole) {
        broadcastToConversation(conv, { type: 'conversation-deleted', conversationId: conv.id }, null);
        db.remove('conversations', conv.id);
        db.removeManyBy('messages', 'conversationId', conv.id);
        removeConvFromAllFolders(conv.id);
      } else if (inGroupOrChannelAsMember) {
        const participants = conv.participants.filter((p) => p !== target.id);
        const updated = db.update('conversations', conv.id, { participants });
        broadcastToConversation(updated, { type: 'conversation-updated', conversation: updated }, null);
      }
    });

    db.remove('users', target.id);
    sendToUser(target.id, { type: 'account-deleted' });
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/conversations' && method === 'GET') {
    if (!requireAdmin(user, res)) return;
    const conversations = db.all('conversations').map(enrichConversationAdmin);
    return sendJSON(res, 200, { conversations });
  }

  const adminConvMsgsMatch = pathname.match(/^\/api\/admin\/conversations\/([^/]+)\/messages$/);
  if (adminConvMsgsMatch && method === 'GET') {
    if (!requireAdmin(user, res)) return;
    const messages = db.findManyBy('messages', 'conversationId', adminConvMsgsMatch[1]);
    return sendJSON(res, 200, { messages });
  }

  // ---------- История звонков ----------
  if (pathname === '/api/calls' && method === 'GET') {
    const myConvIds = new Set(userConversations(user.id).filter((c) => c.type === 'channel' || c.type === 'group').map((c) => c.id));
    const calls = db.all('calls')
      .filter((c) => {
        if (c.mode === '1:1') return c.callerId === user.id || c.calleeId === user.id;
        if (c.mode === 'group') return myConvIds.has(c.conversationId);
        return false;
      })
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 200)
      .map((c) => {
        const out = { ...c };
        if (c.mode === '1:1') {
          const otherId = c.callerId === user.id ? c.calleeId : c.callerId;
          out.peer = publicUser(db.findById('users', otherId));
          out.direction = c.callerId === user.id ? 'outgoing' : 'incoming';
        } else {
          const conv = db.findById('conversations', c.conversationId);
          out.channelName = conv ? conv.name : 'Канал';
        }
        return out;
      });
    return sendJSON(res, 200, { calls });
  }

  // ---------- ICE-конфигурация для WebRTC-звонков (STUN + собственный TURN) ----------
  // Раньше мессенджер жил в локальной сети, и браузерам хватало обычного
  // STUN (или вообще прямого host-соединения). В глобальной сети этого часто
  // недостаточно — если у одного из собеседников NAT/файрвол не пускает
  // прямое соединение, звонок просто не устанавливается. TURN-сервер решает
  // это, ретранслируя медиапоток. Чтобы не подключать сторонние сервисы,
  // используется собственный TURN (lib/mini-turn.js); креденшлы выдаются
  // авторизованным пользователям на ограниченное время (TURN REST API-схема).
  if (pathname === '/api/turn-credentials' && method === 'GET') {
    const creds = generateTurnCredentials(TURN_SECRET, user.id, 6 * 3600);
    const iceServers = [
      { urls: `stun:${TURN_HOST}:${TURN_PORT}` },
      {
        urls: [`turn:${TURN_HOST}:${TURN_PORT}?transport=udp`],
        username: creds.username,
        credential: creds.credential,
      },
      // Публичный STUN как дополнительный запасной вариант (был и раньше).
      { urls: 'stun:stun.l.google.com:19302' },
    ];
    return sendJSON(res, 200, { iceServers, ttl: creds.ttl });
  }

  // ---------- Папки с чатами (персональные для каждого пользователя) ----------
  if (pathname === '/api/folders' && method === 'GET') {
    const folders = db.findManyBy('folders', 'userId', user.id);
    return sendJSON(res, 200, { folders });
  }

  if (pathname === '/api/folders' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) return sendJSON(res, 400, { error: 'Укажите название папки' });
    const folder = db.insert('folders', {
      id: genId('folder'),
      userId: user.id,
      name,
      convIds: Array.isArray(body.convIds) ? body.convIds : [],
      createdAt: Date.now(),
    });
    return sendJSON(res, 200, { folder });
  }

  const folderMatch = pathname.match(/^\/api\/folders\/([^/]+)$/);
  if (folderMatch && method === 'PATCH') {
    const folder = db.findById('folders', folderMatch[1]);
    if (!folder || folder.userId !== user.id) return sendJSON(res, 404, { error: 'Папка не найдена' });
    const body = await readBody(req);
    const patch = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return sendJSON(res, 400, { error: 'Пустое название папки' });
      patch.name = name;
    }
    if (body.convIds !== undefined) patch.convIds = Array.isArray(body.convIds) ? body.convIds : [];
    const updated = db.update('folders', folder.id, patch);
    return sendJSON(res, 200, { folder: updated });
  }

  if (folderMatch && method === 'DELETE') {
    const folder = db.findById('folders', folderMatch[1]);
    if (!folder || folder.userId !== user.id) return sendJSON(res, 404, { error: 'Папка не найдена' });
    db.remove('folders', folder.id);
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: 'Не найдено' });
}

function enrichConversationAdmin(conv) {
  const out = { ...conv };
  if (conv.type === 'dm') {
    out.title = (conv.participants || []).map((pid) => {
      const u = db.findById('users', pid);
      return u ? u.displayName : '?';
    }).join(' ↔ ');
  } else {
    out.title = conv.name;
  }
  const msgs = db.findManyBy('messages', 'conversationId', conv.id);
  out.messageCount = msgs.length;
  out.lastMessage = msgs.length ? msgs[msgs.length - 1] : null;
  return out;
}

function enrichConversation(conv, viewerId) {
  const out = { ...conv };
  if (conv.type === 'dm') {
    const otherId = conv.participants.find((p) => p !== viewerId);
    const other = db.findById('users', otherId);
    out.peer = publicUser(other);
    // Локальное имя контакта — как этот собеседник подписан именно у меня
    // (например вместо «Саша» → «сыночек»), не видно второй стороне.
    out.peerNickname = (conv.nicknames && conv.nicknames[viewerId]) || '';
  }
  if (conv.type === 'channel' || conv.type === 'group') {
    const room = groupCallRooms.get(conv.id);
    out.groupCallCount = room ? room.size : 0;
  }
  const msgs = db.findManyBy('messages', 'conversationId', conv.id);
  out.lastMessage = msgs.length ? msgs[msgs.length - 1] : null;
  if (conv.pinnedMessageId) {
    const pinned = db.findById('messages', conv.pinnedMessageId);
    if (pinned) {
      out.pinnedMessage = pinned;
    } else {
      // закреплённое сообщение удалили — тихо снимаем закрепление
      out.pinnedMessage = null;
      out.pinnedMessageId = null;
      db.update('conversations', conv.id, { pinnedMessageId: null });
    }
  } else {
    out.pinnedMessage = null;
  }
  return out;
}

// ---------- Сервер ----------
function requestHandler(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith('/api/')) {
    handleAPI(req, res, pathname, parsed.query).catch((err) => {
      console.error(err);
      sendJSON(res, 500, { error: 'Внутренняя ошибка сервера' });
    });
    return;
  }

  if (pathname.startsWith('/uploads/')) {
    serveStatic(req, res, UPLOADS_DIR, pathname.replace('/uploads/', ''));
    return;
  }

  if (pathname === '/' || pathname === '') {
    serveStatic(req, res, PUBLIC_DIR, '/index.html');
    return;
  }

  // Глубокие ссылки (приглашение в группу/канал, профиль) — это чисто
  // клиентские маршруты в SPA: отдаём index.html, а сам путь разбирает уже
  // app.js на клиенте (см. handleDeepLinkIfPresent).
  if (/^\/j\/[^/]+$/.test(pathname) || /^\/u\/[^/]+$/.test(pathname)) {
    serveStatic(req, res, PUBLIC_DIR, '/index.html');
    return;
  }

  serveStatic(req, res, PUBLIC_DIR, pathname);
}

const server = http.createServer(requestHandler);
wss.attach(server);

function localAddrs() {
  const nets = os.networkInterfaces();
  const addrs = [];
  Object.values(nets).forEach((ifaces) => (ifaces || []).forEach((i) => {
    if (i.family === 'IPv4' && !i.internal) addrs.push(i.address);
  }));
  return addrs;
}

const CERT_DIR = path.join(__dirname, 'certs');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
let httpsServer = null;

// Без HTTPS браузер не даёт доступ к камере/микрофону нигде, кроме
// localhost, — значит не работают звонки, голосовые и видео-кружки. Раньше
// это решалось локальным IP + отдельным ручным шагом (node generate-cert.js).
// Теперь, если сертификата ещё нет, сервер при старте пытается сделать это
// сам (тем же openssl, без сторонних сервисов), чтобы это не забывали
// сделать при переезде из локальной сети в интернет. Публичный домен/IP
// можно подсказать переменной PUBLIC_HOST — тогда сертификат будет выписан и
// на него тоже.
if (!fs.existsSync(KEY_PATH) || !fs.existsSync(CERT_PATH)) {
  try {
    const { generateCert } = require('./generate-cert');
    const extra = (process.env.PUBLIC_HOST || process.env.PUBLIC_IP || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    generateCert(extra, { quiet: true });
  } catch (e) {
    console.error('⚠️  Автоматическая генерация HTTPS-сертификата не удалась:', e.message);
  }
}

if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
  try {
    httpsServer = https.createServer({
      key: fs.readFileSync(KEY_PATH),
      cert: fs.readFileSync(CERT_PATH),
    }, requestHandler);
    wss.attach(httpsServer);
  } catch (e) {
    console.error('⚠️  Не удалось запустить HTTPS (проверьте certs/key.pem и certs/cert.pem):', e.message);
    httpsServer = null;
  }
}

// ---------- TURN/STUN (нужен, чтобы звонки соединялись через интернет, а не только в LAN) ----------
// Секрет для выдачи временных TURN-креденшлов — генерируется один раз и
// хранится рядом с базой данных, как и остальные локальные данные сервера.
const TURN_SECRET_PATH = path.join(__dirname, 'data', 'turn-secret.txt');
function getOrCreateTurnSecret() {
  try {
    if (fs.existsSync(TURN_SECRET_PATH)) return fs.readFileSync(TURN_SECRET_PATH, 'utf8').trim();
  } catch (e) {}
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    if (!fs.existsSync(path.dirname(TURN_SECRET_PATH))) fs.mkdirSync(path.dirname(TURN_SECRET_PATH), { recursive: true });
    fs.writeFileSync(TURN_SECRET_PATH, secret);
  } catch (e) {}
  return secret;
}
const TURN_SECRET = getOrCreateTurnSecret();
const TURN_PORT = Number(process.env.TURN_PORT) || 3478;
// Адрес, который сообщаем клиентам как адрес STUN/TURN-сервера. По умолчанию —
// первый локальный (не loopback) IP; если сервер стоит за NAT/в облаке, где
// внешний адрес отличается от адреса сетевого интерфейса, задайте его явно
// переменной окружения PUBLIC_HOST (например PUBLIC_HOST=messenger.example.com
// или PUBLIC_HOST=203.0.113.10). Иначе ниже пробуем определить его сами через STUN.
let TURN_HOST = process.env.PUBLIC_HOST || process.env.PUBLIC_IP || localAddrs()[0] || 'localhost';
let turnServerReady = null;

async function startTurnServer() {
  let publicIp = process.env.PUBLIC_HOST || process.env.PUBLIC_IP || null;
  if (!publicIp) {
    // Лучший эффорт: спрашиваем публичный STUN-сервер, какой у нас "снаружи"
    // виден адрес, и используем его и как TURN_HOST, и как relay-адрес.
    // Если интернета нет (чисто локальный запуск) — просто остаёмся на LAN IP.
    try {
      const discovered = await require('./lib/mini-turn').stunDiscover();
      if (discovered && discovered.address) {
        publicIp = discovered.address;
        TURN_HOST = discovered.address;
      }
    } catch (e) { /* offline/LAN — не страшно, останемся на локальном адресе */ }
  } else {
    TURN_HOST = publicIp;
  }
  try {
    await createTurnServer({ secret: TURN_SECRET, port: TURN_PORT, publicIp, log: (m) => console.error('TURN:', m) });
    console.log(`🧊 TURN/STUN сервер запущен на порту ${TURN_PORT} (адрес для клиентов: ${TURN_HOST})`);
    console.log('   Если сервер работает за NAT/маршрутизатором/облаком — убедитесь, что порт');
    console.log(`   ${TURN_PORT}/UDP проброшен наружу, иначе звонки через интернет не будут соединяться.`);
  } catch (e) {
    console.error('⚠️  Не удалось запустить TURN/STUN сервер (звонки за пределами LAN могут не работать):', e.message);
  }
}
turnServerReady = startTurnServer();

server.listen(PORT, '0.0.0.0', () => {
  const addrs = localAddrs();
  console.log('\n🚀 Asteria запущена!');
  console.log(`   Локально:      http://localhost:${PORT}`);
  addrs.forEach((a) => console.log(`   В сети (LAN):  http://${a}:${PORT}`));

  if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`\n🔒 HTTPS (самоподписанный сертификат):`);
      console.log(`   Локально:      https://localhost:${HTTPS_PORT}`);
      addrs.forEach((a) => console.log(`   В сети (LAN):  https://${a}:${HTTPS_PORT}`));
      console.log('   При первом заходе браузер покажет предупреждение "Соединение не защищено" —');
      console.log('   это нормально для самоподписанного сертификата, нажмите "Дополнительно" → "Всё равно перейти".');
    });
  } else {
    console.log('\n💡 HTTPS не запущен: сертификат не найден. Чтобы включить HTTPS (нужно для звонков и');
    console.log('   микрофона/камеры на телефонах и не-localhost адресах), выполните один раз:');
    console.log('       node generate-cert.js');
    console.log('   и перезапустите сервер.');
  }

  console.log('\nОстановить сервер: Ctrl+C\n');
});
