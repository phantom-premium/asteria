'use strict';
// Минимальный самодостаточный QR-кодер (без внешних пакетов и сетевых
// сервисов — консистентно с остальным проектом). Поддерживает byte-mode,
// уровень коррекции ошибок L, версии 1-6 (этого с большим запасом хватает
// для ссылок вида https://host:port/j/group_xxxxxxxxxx), маска всегда 0 —
// это НЕ влияет на читаемость QR сканерами (маска — это просто про
// визуальный баланс чёрных/белых модулей), только на теоретическую
// эффективность сжатия, так что фиксированная маска полностью безопасна.

// ---------- GF(256) арифметика для кодов Рида-Соломона ----------
const EXP_TABLE = new Array(256);
const LOG_TABLE = new Array(256);
for (let i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
for (let i = 8; i < 256; i++) {
  EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
}
for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i;
function gexp(n) { while (n < 0) n += 255; while (n >= 255) n -= 255; return EXP_TABLE[n]; }
function glog(n) { return LOG_TABLE[n]; }

function polyMultiply(a, b) {
  const result = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j] ^= gexp(glog(a[i]) + glog(b[j]));
    }
  }
  return result;
}

function generatorPoly(ecLength) {
  let a = [1];
  for (let i = 0; i < ecLength; i++) a = polyMultiply(a, [1, gexp(i)]);
  return a;
}

function computeECC(dataCodewords, ecCount) {
  const generator = generatorPoly(ecCount);
  const msgPoly = dataCodewords.concat(new Array(ecCount).fill(0));
  for (let i = 0; i < dataCodewords.length; i++) {
    const coef = msgPoly[i];
    if (coef !== 0) {
      const ratio = glog(coef) - glog(generator[0]);
      for (let j = 0; j < generator.length; j++) {
        msgPoly[i + j] ^= gexp(glog(generator[j]) + ratio);
      }
    }
  }
  return msgPoly.slice(dataCodewords.length);
}

// ---------- Таблица версий (уровень коррекции L, одноблочные — версии 1-6) ----------
const VERSIONS = [
  null,
  { size: 21, dataCw: 19, ecCw: 7, align: null },
  { size: 25, dataCw: 34, ecCw: 10, align: 18 },
  { size: 29, dataCw: 55, ecCw: 15, align: 22 },
  { size: 33, dataCw: 80, ecCw: 20, align: 26 },
  { size: 37, dataCw: 108, ecCw: 26, align: 30 },
  { size: 41, dataCw: 136, ecCw: 36, align: 34 },
];

function pickVersion(byteLen) {
  for (let v = 1; v < VERSIONS.length; v++) {
    const cap = VERSIONS[v].dataCw * 8;
    if (12 + 8 * byteLen <= cap) return v;
  }
  return null; // строка слишком длинная для этого мини-кодера
}

function encodeDataCodewords(bytes, dataCw) {
  const bits = [];
  const push = (num, len) => { for (let i = len - 1; i >= 0; i--) bits.push((num >>> i) & 1); };
  push(4, 4); // byte mode
  push(bytes.length, 8); // char count indicator (версии 1-9)
  for (let i = 0; i < bytes.length; i++) push(bytes[i], 8);
  const totalBits = dataCw * 8;
  const termLen = Math.min(4, totalBits - bits.length);
  for (let i = 0; i < termLen; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const padBytes = [0xEC, 0x11];
  let pi = 0;
  while (codewords.length < dataCw) { codewords.push(padBytes[pi % 2]); pi++; }
  return codewords;
}

// ---------- Формат-инфо (BCH(15,5)) ----------
const G15 = 0x537;
const G15_MASK = 0x5412;
function bchDigitCount(data) { let d = 0; while (data !== 0) { d++; data >>>= 1; } return d; }
function bchTypeInfo(data) {
  let d = data << 10;
  while (bchDigitCount(d) - bchDigitCount(G15) >= 0) {
    d ^= (G15 << (bchDigitCount(d) - bchDigitCount(G15)));
  }
  return ((data << 10) | d) ^ G15_MASK;
}

function buildMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  const version = pickVersion(bytes.length);
  if (!version) throw new Error('Строка слишком длинная для QR-кода этой версии');
  const info = VERSIONS[version];
  const n = info.size;
  const modules = Array.from({ length: n }, () => new Array(n).fill(null));
  const reserved = Array.from({ length: n }, () => new Array(n).fill(false));

  function set(r, c, dark, isReserved) {
    modules[r][c] = dark;
    if (isReserved) reserved[r][c] = true;
  }

  function placeFinder(r0, c0) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const inRing = (r >= 0 && r <= 6 && c >= 0 && c <= 6) &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, inRing, true);
      }
    }
  }
  placeFinder(0, 0);
  placeFinder(0, n - 7);
  placeFinder(n - 7, 0);

  // timing patterns
  for (let c = 8; c < n - 8; c++) set(6, c, c % 2 === 0, true);
  for (let r = 8; r < n - 8; r++) set(r, 6, r % 2 === 0, true);

  // alignment pattern (одна, версии 2-6)
  if (info.align) {
    const p = info.align;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
        set(p + dr, p + dc, dark, true);
      }
    }
  }

  // dark module (всегда тёмный)
  set(n - 8, 8, true, true);

  // резервируем область формат-инфо (значения проставим позже). Важно:
  // помечаем именно в modules[][] (не только в reserved[][]) — иначе цикл
  // расстановки данных ниже посчитает эти клетки пустыми (null) и запишет
  // туда биты данных, которые потом будут молча затёрты форматной инфой.
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) set(8, i, false, true);
    if (!reserved[i][8]) set(i, 8, false, true);
  }
  for (let i = 0; i < 8; i++) {
    set(8, n - 1 - i, false, true);
    set(n - 1 - i, 8, false, true);
  }

  // ---------- данные ----------
  const dataCw = encodeDataCodewords(bytes, info.dataCw);
  const ecc = computeECC(dataCw, info.ecCw);
  const allCw = dataCw.concat(ecc);
  const dataBits = [];
  allCw.forEach((byte) => { for (let i = 7; i >= 0; i--) dataBits.push((byte >>> i) & 1); });

  let bitIndex = 0;
  let dir = -1;
  let row = n - 1;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    while (true) {
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (modules[row][cc] === null) {
          let dark = bitIndex < dataBits.length ? !!dataBits[bitIndex] : false;
          bitIndex++;
          if ((row + cc) % 2 === 0) dark = !dark; // маска 0
          modules[row][cc] = dark;
        }
      }
      row += dir;
      if (row < 0 || row >= n) { row -= dir; dir = -dir; break; }
    }
  }

  // ---------- формат-инфо: EC level L = 0b01, mask = 0b000 ----------
  const typeData = (1 << 3) | 0;
  const bits15 = bchTypeInfo(typeData);
  for (let i = 0; i < 15; i++) {
    const mod = ((bits15 >> i) & 1) === 1;
    if (i < 6) modules[i][8] = mod;
    else if (i < 8) modules[i + 1][8] = mod;
    else modules[n - 15 + i][8] = mod;
  }
  for (let i = 0; i < 15; i++) {
    const mod = ((bits15 >> i) & 1) === 1;
    if (i < 8) modules[8][n - i - 1] = mod;
    else if (i < 9) modules[8][15 - i - 1 + 1] = mod;
    else modules[8][15 - i - 1] = mod;
  }
  modules[n - 8][8] = true;

  return { n, modules };
}

function toSVG(text, moduleSize = 6, margin = 4) {
  const { n, modules } = buildMatrix(text);
  const size = (n + margin * 2) * moduleSize;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (modules[r][c]) {
        const x = (c + margin) * moduleSize, y = (r + margin) * moduleSize;
        path += `M${x},${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/></svg>`;
}

function renderToCanvas(text, canvas, moduleSize = 6, margin = 4) {
  const { n, modules } = buildMatrix(text);
  const size = (n + margin * 2) * moduleSize;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (modules[r][c]) ctx.fillRect((c + margin) * moduleSize, (r + margin) * moduleSize, moduleSize, moduleSize);
    }
  }
  return canvas;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildMatrix, toSVG, renderToCanvas, VERSIONS };
} else {
  window.AsteriaQR = { buildMatrix, toSVG, renderToCanvas, VERSIONS };
}
