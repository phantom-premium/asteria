'use strict';
// Генерирует самоподписанный TLS-сертификат для запуска Asteria по HTTPS.
// HTTPS нужен для того, чтобы:
//  - браузер не показывал предупреждение "не защищено" в адресной строке
//    (после того как вы один раз примете сертификат вручную);
//  - камера, микрофон и запись голосовых/кружков вообще работали — браузеры
//    разрешают доступ к камере/микрофону только в "безопасном контексте", то
//    есть по HTTPS или на localhost. Это касается и локальной сети, и (тем
//    более) публичного адреса в интернете — без HTTPS сайт снаружи открыть
//    можно, а вот позвонить или записать голосовое или кружок — нет.
//
// Запуск вручную:  node generate-cert.js
// Требует установленный openssl (есть по умолчанию на Linux и macOS;
// на Windows — в комплекте с Git for Windows, либо через WSL). Сервер тоже
// пытается сделать это сам при старте, если сертификата ещё нет и openssl
// доступен — см. server.js.
//
// Если сервер развёрнут в интернете под своим доменом или публичным IP —
// укажите его переменной окружения PUBLIC_HOST (можно несколько через
// запятую), чтобы он тоже попал в сертификат:
//   PUBLIC_HOST=messenger.example.com node generate-cert.js

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CERT_DIR = path.join(__dirname, 'certs');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');
const CONF_PATH = path.join(CERT_DIR, 'openssl.cnf');

function localIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  Object.values(nets).forEach((ifaces) => (ifaces || []).forEach((i) => {
    if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  }));
  return ips;
}

function hasOpenssl() {
  try {
    execSync('openssl version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

// extraHosts: массив строк — доменов или IP, которые нужно дополнительно
// включить в сертификат (например публичный адрес сервера в интернете).
function generateCert(extraHosts = [], opts = {}) {
  const quiet = !!opts.quiet;
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const logErr = (...a) => console.error(...a);

  if (!hasOpenssl()) {
    logErr('❌ Не найден openssl в PATH.');
    logErr('   Установите его, чтобы получить HTTPS (нужен для звонков, голосовых и кружков):');
    logErr('   • Linux: обычно уже установлен (проверьте `apt install openssl`)');
    logErr('   • macOS: обычно уже установлен (или `brew install openssl`)');
    logErr('   • Windows: идёт в комплекте с "Git for Windows" (Git Bash), либо используйте WSL');
    return false;
  }

  if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    log('ℹ️  Сертификат уже существует в certs/. Если адрес сервера изменился (новый IP или домен)');
    log('    и HTTPS перестал открываться по новому адресу — удалите папку certs/ и запустите скрипт снова.');
    return true;
  }

  const ips = localIPs();
  const sanSet = new Set(['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)]);
  extraHosts.filter(Boolean).forEach((h) => {
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
    sanSet.add(isIp ? `IP:${h}` : `DNS:${h}`);
  });
  const sanEntries = Array.from(sanSet);
  const sanString = sanEntries.join(',');

  const conf = `[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = Asteria

[v3_req]
subjectAltName = ${sanString}
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
basicConstraints = critical, CA:TRUE
`;
  fs.writeFileSync(CONF_PATH, conf);

  log('🔐 Генерирую самоподписанный сертификат для адресов:');
  sanEntries.forEach((s) => log('   ' + s));

  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes ` +
      `-keyout "${KEY_PATH}" -out "${CERT_PATH}" -config "${CONF_PATH}"`,
      { stdio: quiet ? 'ignore' : 'inherit' }
    );
  } catch (e) {
    logErr('❌ Не удалось создать сертификат:', e.message);
    return false;
  }

  log('\n✅ Готово! Сертификат сохранён в certs/cert.pem и certs/key.pem');
  log('⚠️  При первом заходе по HTTPS браузер покажет предупреждение "Соединение не защищено" —');
  log('   это ожидаемо для самоподписанного сертификата. Нажмите "Дополнительно" → "Всё равно перейти".');
  log('   Приняв его один раз для конкретного адреса, дальше камера/микрофон будут работать как обычно.');
  return true;
}

if (require.main === module) {
  const extra = (process.env.PUBLIC_HOST || process.env.PUBLIC_IP || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const ok = generateCert(extra);
  if (ok) {
    console.log('\nЗапустите (или перезапустите) сервер: node server.js');
    console.log('HTTPS включится автоматически на порту 3443 (можно поменять переменной HTTPS_PORT).');
  }
  process.exit(ok ? 0 : 1);
}

module.exports = { generateCert, hasOpenssl, CERT_DIR, KEY_PATH, CERT_PATH };
