// Минимальная реализация WebSocket-сервера без внешних зависимостей.
// Поддерживает text-фреймы (JSON), close/ping/pong, достаточно для чата/звонков.
'use strict';
const crypto = require('crypto');
const EventEmitter = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, data]);
}

class WSConnection extends EventEmitter {
  constructor(socket, userId) {
    super();
    this.socket = socket;
    this.userId = userId;
    this.alive = true;
    this._buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this.emit('close'));
    socket.on('error', () => { try { socket.destroy(); } catch (e) {} });
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    this._parse();
  }

  _parse() {
    while (true) {
      if (this._buffer.length < 2) return;
      const b0 = this._buffer[0];
      const b1 = this._buffer[1];
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this._buffer.length < offset + 2) return;
        len = this._buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this._buffer.length < offset + 8) return;
        len = Number(this._buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey;
      if (masked) {
        if (this._buffer.length < offset + 4) return;
        maskKey = this._buffer.slice(offset, offset + 4);
        offset += 4;
      }

      if (this._buffer.length < offset + len) return; // wait for more data

      let payload = this._buffer.slice(offset, offset + len);
      if (masked) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
        payload = unmasked;
      }

      this._buffer = this._buffer.slice(offset + len);

      if (opcode === 0x8) { // close
        this.close();
        return;
      } else if (opcode === 0x9) { // ping
        this._writeRaw(encodeFrame(payload, 0xA)); // pong
      } else if (opcode === 0x1 || opcode === 0x2) { // text / binary
        this.emit('message', payload.toString('utf8'));
      }
      // continue loop in case buffer has more frames
    }
  }

  _writeRaw(buf) {
    try { this.socket.write(buf); } catch (e) {}
  }

  send(obj) {
    const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
    this._writeRaw(encodeFrame(str, 0x1));
  }

  close() {
    try { this._writeRaw(encodeFrame(Buffer.alloc(0), 0x8)); this.socket.end(); } catch (e) {}
    this.emit('close');
  }
}

class WSServer extends EventEmitter {
  attach(httpServer) {
    httpServer.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (!key || (req.headers['upgrade'] || '').toLowerCase() !== 'websocket') {
        socket.destroy();
        return;
      }
      const accept = acceptKey(key);
      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '', ''
      ].join('\r\n');
      socket.write(headers);
      const conn = new WSConnection(socket, null);
      this.emit('connection', conn, req);
    });
  }
}

module.exports = { WSServer };
