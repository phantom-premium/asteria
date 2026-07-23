// Минимальный STUN/TURN-сервер без внешних зависимостей (RFC 5389 / RFC 5766,
// только то, что реально нужно браузерному WebRTC: Binding, Allocate,
// Refresh, CreatePermission, Send/Data indication, длительные "credentials").
//
// Зачем это вообще нужно: пока мессенджер жил в локальной сети, браузерам
// ничего не мешало соединяться напрямую (host-кандидаты по локальным IP).
// В глобальной сети между двумя обычными интернет-подключениями почти всегда
// стоит NAT, и одного STUN (который лишь узнаёт "снаружи" видимый адрес)
// часто недостаточно — если у одной из сторон "симметричный" NAT/файрвол,
// прямое соединение не устанавливается вообще, и звонок просто не соединяется.
// Проблема решается TURN-сервером: он выступает промежуточным ретранслятором
// трафика, когда прямая связь невозможна. Чтобы не тащить в проект внешние
// пакеты и не зависеть от сторонних сервисов, реализован свой TURN-сервер на
// голом `dgram`, тем же духом, что и свой WebSocket в minirt-ws.js.
'use strict';
const dgram = require('dgram');
const crypto = require('crypto');

const MAGIC_COOKIE = 0x2112a442;
const REALM = 'asteria';

// ---------- STUN message helpers (RFC 5389) ----------
const TYPES = {
  BINDING_REQUEST: 0x0001,
  BINDING_RESPONSE: 0x0101,
  ALLOCATE_REQUEST: 0x0003,
  ALLOCATE_RESPONSE: 0x0103,
  ALLOCATE_ERROR: 0x0113,
  REFRESH_REQUEST: 0x0004,
  REFRESH_RESPONSE: 0x0104,
  REFRESH_ERROR: 0x0114,
  CREATE_PERMISSION_REQUEST: 0x0008,
  CREATE_PERMISSION_RESPONSE: 0x0108,
  CREATE_PERMISSION_ERROR: 0x0118,
  SEND_INDICATION: 0x0016,
  DATA_INDICATION: 0x0017,
};

const ATTR = {
  MAPPED_ADDRESS: 0x0001,
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  UNKNOWN_ATTRIBUTES: 0x000a,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  XOR_MAPPED_ADDRESS: 0x0020,
  LIFETIME: 0x000d,
  SOFTWARE: 0x8022,
};

function pad4(n) { return (4 - (n % 4)) % 4; }

function parseMessage(buf) {
  if (buf.length < 20) return null;
  const type = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  const cookie = buf.readUInt32BE(4);
  if (cookie !== MAGIC_COOKIE) return null;
  const transactionId = buf.slice(8, 20);
  if (buf.length < 20 + length) return null;
  const attrs = {};
  let offset = 20;
  const end = 20 + length;
  while (offset + 4 <= end) {
    const attrType = buf.readUInt16BE(offset);
    const attrLen = buf.readUInt16BE(offset + 2);
    const valStart = offset + 4;
    if (valStart + attrLen > end) break;
    const value = buf.slice(valStart, valStart + attrLen);
    attrs[attrType] = value;
    offset = valStart + attrLen + pad4(attrLen);
  }
  return { type, transactionId, attrs, raw: buf };
}

function encodeAttr(type, value) {
  const len = value.length;
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(len, 2);
  const padding = Buffer.alloc(pad4(len));
  return Buffer.concat([header, value, padding]);
}

function xorAddress(addr, port, transactionId) {
  // IPv4 only — достаточно для WebRTC-медиа в подавляющем большинстве случаев.
  const parts = addr.split('.').map(Number);
  const buf = Buffer.alloc(8);
  buf.writeUInt8(0, 0);
  buf.writeUInt8(0x01, 1); // family IPv4
  const xport = port ^ (MAGIC_COOKIE >>> 16);
  buf.writeUInt16BE(xport, 2);
  const cookieBuf = Buffer.alloc(4);
  cookieBuf.writeUInt32BE(MAGIC_COOKIE, 0);
  for (let i = 0; i < 4; i++) buf[4 + i] = parts[i] ^ cookieBuf[i];
  return buf;
}

function decodeXorAddress(buf) {
  if (!buf || buf.length < 8) return null;
  const family = buf.readUInt8(1);
  if (family !== 0x01) return null;
  const cookieBuf = Buffer.alloc(4);
  cookieBuf.writeUInt32BE(MAGIC_COOKIE, 0);
  const port = buf.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16);
  const octets = [0, 1, 2, 3].map((i) => buf[4 + i] ^ cookieBuf[i]);
  return { address: octets.join('.'), port };
}

function buildMessage(type, transactionId, attrList, integrityKey) {
  let attrsBuf = Buffer.concat(attrList.map((a) => encodeAttr(a.type, a.value)));
  if (integrityKey) {
    // MESSAGE-INTEGRITY считается так, как будто в length уже учтён сам
    // 24-байтовый атрибут (заголовок 4 + HMAC-SHA1 20 байт), но ничего после него.
    const lenWithMI = attrsBuf.length + 24;
    const header = Buffer.alloc(20);
    header.writeUInt16BE(type, 0);
    header.writeUInt16BE(lenWithMI, 2);
    header.writeUInt32BE(MAGIC_COOKIE, 4);
    transactionId.copy(header, 8);
    const toSign = Buffer.concat([header, attrsBuf]);
    const hmac = crypto.createHmac('sha1', integrityKey).update(toSign).digest();
    attrsBuf = Buffer.concat([attrsBuf, encodeAttr(ATTR.MESSAGE_INTEGRITY, hmac)]);
  }
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(attrsBuf.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, attrsBuf]);
}

function verifyIntegrity(msg, key) {
  const mi = msg.attrs[ATTR.MESSAGE_INTEGRITY];
  if (!mi) return false;
  // Пересобираем заголовок так, будто сообщение заканчивалось сразу после
  // атрибута MESSAGE-INTEGRITY (см. RFC 5389 §15.4).
  const miOffsetInAttrs = msg.raw.indexOf(mi) - 4; // offset of attr header within full buffer
  const lenForSig = miOffsetInAttrs + 24 - 20;
  const header = Buffer.alloc(20);
  header.writeUInt16BE(msg.type, 0);
  header.writeUInt16BE(lenForSig, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  msg.transactionId.copy(header, 8);
  const body = msg.raw.slice(20, miOffsetInAttrs);
  const toSign = Buffer.concat([header, body]);
  const expected = crypto.createHmac('sha1', key).update(toSign).digest();
  return expected.length === mi.length && crypto.timingSafeEqual(expected, mi);
}

function errorAttr(code, reason) {
  const buf = Buffer.alloc(4 + Buffer.byteLength(reason));
  buf.writeUInt8(0, 0);
  buf.writeUInt8(0, 1);
  buf.writeUInt8(Math.floor(code / 100), 2);
  buf.writeUInt8(code % 100, 3);
  buf.write(reason, 4, 'utf8');
  return buf;
}

// ---------- TURN REST API-style credentials (как у coturn с use-auth-secret) ----------
// username = "<unix-время-истечения>:<id-пользователя>"
// credential (пароль) = base64(HMAC-SHA1(secret, username))
function generateTurnCredentials(secret, userId, ttlSeconds = 6 * 3600) {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiry}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, ttl: ttlSeconds };
}

function isUsernameValid(username) {
  const idx = username.indexOf(':');
  if (idx === -1) return false;
  const expiry = parseInt(username.slice(0, idx), 10);
  if (!expiry || Number.isNaN(expiry)) return false;
  return expiry > Math.floor(Date.now() / 1000);
}

function longTermKey(username, password) {
  return crypto.createHash('md5').update(`${username}:${REALM}:${password}`).digest();
}

// ---------- Сервер ----------
function createTurnServer({ secret, port = 3478, publicIp = null, log = () => {} }) {
  const sock = dgram.createSocket('udp4');
  const nonces = new Map(); // nonce -> createdAt (для простоты не привязываем к клиенту)
  const allocations = new Map(); // clientKey ("ip:port") -> { relaySocket, permissions: Set<ip>, timer }

  function clientKey(rinfo) { return `${rinfo.address}:${rinfo.port}`; }

  function freshNonce() {
    const nonce = crypto.randomBytes(16).toString('hex');
    nonces.set(nonce, Date.now());
    return nonce;
  }

  function send(msg, rinfo) { sock.send(msg, rinfo.port, rinfo.address); }

  function challenge(type, transactionId, rinfo, errCode = 401, reason = 'Unauthorized') {
    const nonce = freshNonce();
    const msg = buildMessage(type, transactionId, [
      { type: ATTR.ERROR_CODE, value: errorAttr(errCode, reason) },
      { type: ATTR.REALM, value: Buffer.from(REALM) },
      { type: ATTR.NONCE, value: Buffer.from(nonce) },
    ]);
    send(msg, rinfo);
  }

  // Проверяет long-term credentials по нашей REST-схеме и возвращает
  // {ok, key, userId} — либо шлёт 401/438 сама и возвращает {ok:false}.
  function authenticate(msg, rinfo, requestType, respErrType) {
    const usernameBuf = msg.attrs[ATTR.USERNAME];
    const nonceBuf = msg.attrs[ATTR.NONCE];
    if (!usernameBuf || !nonceBuf || !msg.attrs[ATTR.MESSAGE_INTEGRITY]) {
      challenge(respErrType, msg.transactionId, rinfo);
      return { ok: false };
    }
    const username = usernameBuf.toString('utf8');
    const nonce = nonceBuf.toString('utf8');
    if (!nonces.has(nonce) || !isUsernameValid(username)) {
      challenge(respErrType, msg.transactionId, rinfo, 438, 'Stale Nonce');
      return { ok: false };
    }
    const userId = username.slice(username.indexOf(':') + 1);
    // Пересчитываем ожидаемый credential той же HMAC-схемой, что и при выдаче
    // (generateTurnCredentials), по фактическому username из запроса.
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    const key = longTermKey(username, credential);
    if (!verifyIntegrity(msg, key)) {
      challenge(respErrType, msg.transactionId, rinfo, 401, 'Unauthorized');
      return { ok: false };
    }
    return { ok: true, key, userId };
  }

  function handleBinding(msg, rinfo) {
    const xored = xorAddress(rinfo.address, rinfo.port);
    const resp = buildMessage(TYPES.BINDING_RESPONSE, msg.transactionId, [
      { type: ATTR.XOR_MAPPED_ADDRESS, value: xored },
    ]);
    send(resp, rinfo);
  }

  function handleAllocate(msg, rinfo) {
    const auth = authenticate(msg, rinfo, TYPES.ALLOCATE_REQUEST, TYPES.ALLOCATE_ERROR);
    if (!auth.ok) return;
    const ck = clientKey(rinfo);
    let alloc = allocations.get(ck);
    if (!alloc) {
      const relaySocket = dgram.createSocket('udp4');
      alloc = { relaySocket, permissions: new Set(), key: auth.key, clientRinfo: rinfo };
      relaySocket.on('message', (data, peerInfo) => {
        if (!alloc.permissions.has(peerInfo.address)) return; // без CreatePermission — не ретранслируем
        const dataIndication = buildMessage(TYPES.DATA_INDICATION, crypto.randomBytes(12), [
          { type: ATTR.XOR_PEER_ADDRESS, value: xorAddress(peerInfo.address, peerInfo.port) },
          { type: ATTR.DATA, value: data },
        ]);
        send(dataIndication, alloc.clientRinfo);
      });
      relaySocket.bind(0, () => {
        allocations.set(ck, alloc);
        respondAllocateOk(msg, rinfo, alloc);
      });
      return;
    }
    respondAllocateOk(msg, rinfo, alloc);
  }

  function respondAllocateOk(msg, rinfo, alloc) {
    scheduleExpiry(alloc, clientKey(rinfo), 600);
    const relayPort = alloc.relaySocket.address().port;
    const resp = buildMessage(TYPES.ALLOCATE_RESPONSE, msg.transactionId, [
      { type: ATTR.XOR_RELAYED_ADDRESS, value: xorAddress(publicIp || rinfo.address, relayPort) },
      { type: ATTR.XOR_MAPPED_ADDRESS, value: xorAddress(rinfo.address, rinfo.port) },
      { type: ATTR.LIFETIME, value: uint32(600) },
    ], alloc.key);
    send(resp, rinfo);
  }

  function scheduleExpiry(alloc, ck, seconds) {
    if (alloc.timer) clearTimeout(alloc.timer);
    if (seconds <= 0) {
      try { alloc.relaySocket.close(); } catch (e) {}
      allocations.delete(ck);
      return;
    }
    alloc.timer = setTimeout(() => {
      try { alloc.relaySocket.close(); } catch (e) {}
      allocations.delete(ck);
    }, seconds * 1000);
  }

  function uint32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; }

  function handleRefresh(msg, rinfo) {
    const auth = authenticate(msg, rinfo, TYPES.REFRESH_REQUEST, TYPES.REFRESH_ERROR);
    if (!auth.ok) return;
    const ck = clientKey(rinfo);
    const alloc = allocations.get(ck);
    const lifetimeBuf = msg.attrs[ATTR.LIFETIME];
    const lifetime = lifetimeBuf ? lifetimeBuf.readUInt32BE(0) : 600;
    if (!alloc) {
      const resp = buildMessage(TYPES.REFRESH_RESPONSE, msg.transactionId, [
        { type: ATTR.LIFETIME, value: uint32(0) },
      ], auth.key);
      send(resp, rinfo);
      return;
    }
    scheduleExpiry(alloc, ck, lifetime);
    const resp = buildMessage(TYPES.REFRESH_RESPONSE, msg.transactionId, [
      { type: ATTR.LIFETIME, value: uint32(lifetime) },
    ], auth.key);
    send(resp, rinfo);
  }

  function handleCreatePermission(msg, rinfo) {
    const auth = authenticate(msg, rinfo, TYPES.CREATE_PERMISSION_REQUEST, TYPES.CREATE_PERMISSION_ERROR);
    if (!auth.ok) return;
    const ck = clientKey(rinfo);
    const alloc = allocations.get(ck);
    if (!alloc) { challenge(TYPES.CREATE_PERMISSION_ERROR, msg.transactionId, rinfo, 437, 'Allocation Mismatch'); return; }
    const peer = decodeXorAddress(msg.attrs[ATTR.XOR_PEER_ADDRESS]);
    if (peer) alloc.permissions.add(peer.address);
    const resp = buildMessage(TYPES.CREATE_PERMISSION_RESPONSE, msg.transactionId, [], auth.key);
    send(resp, rinfo);
  }

  function handleSendIndication(msg, rinfo) {
    const ck = clientKey(rinfo);
    const alloc = allocations.get(ck);
    if (!alloc) return;
    const peer = decodeXorAddress(msg.attrs[ATTR.XOR_PEER_ADDRESS]);
    const data = msg.attrs[ATTR.DATA];
    if (!peer || !data || !alloc.permissions.has(peer.address)) return;
    alloc.relaySocket.send(data, peer.port, peer.address);
  }

  sock.on('message', (buf, rinfo) => {
    let msg;
    try { msg = parseMessage(buf); } catch (e) { return; }
    if (!msg) return;
    switch (msg.type) {
      case TYPES.BINDING_REQUEST: return handleBinding(msg, rinfo);
      case TYPES.ALLOCATE_REQUEST: return handleAllocate(msg, rinfo);
      case TYPES.REFRESH_REQUEST: return handleRefresh(msg, rinfo);
      case TYPES.CREATE_PERMISSION_REQUEST: return handleCreatePermission(msg, rinfo);
      case TYPES.SEND_INDICATION: return handleSendIndication(msg, rinfo);
      default: return;
    }
  });

  sock.on('error', (e) => log('TURN/STUN socket error: ' + e.message));

  return new Promise((resolve) => {
    sock.bind(port, '0.0.0.0', () => resolve(sock));
  });
}

// Best-effort определение "внешнего" (публичного) IP-адреса сервера: шлём
// обычный STUN Binding Request на публичный STUN-сервер и смотрим, какой
// адрес он видит. Нужно только чтобы TURN сразу из коробки давал клиентам
// снаружи правильный relay-адрес; если запрос не удаётся (нет интернета,
// сервер полностью в закрытой сети) — просто возвращаем null, ничего не ломая.
function stunDiscover(host = 'stun.l.google.com', port = 19302, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch (e) {}
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.once('error', () => { clearTimeout(timer); finish(null); });
    sock.once('message', (buf) => {
      clearTimeout(timer);
      try {
        const msg = parseMessage(buf);
        const xored = msg && (msg.attrs[ATTR.XOR_MAPPED_ADDRESS] || msg.attrs[ATTR.MAPPED_ADDRESS]);
        finish(xored ? decodeXorAddress(xored) : null);
      } catch (e) { finish(null); }
    });
    const txId = crypto.randomBytes(12);
    const req = buildMessage(TYPES.BINDING_REQUEST, txId, []);
    sock.send(req, port, host, (err) => { if (err) finish(null); });
  });
}

module.exports = { createTurnServer, generateTurnCredentials, stunDiscover, REALM };
