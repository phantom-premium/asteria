'use strict';
// Генерирует самоподписанный TLS-сертификат для запуска Asteria по HTTPS
// в локальной сети. HTTPS нужен для того, чтобы:
//  - браузер не показывал предупреждение "не защищено" в адресной строке
//    (после того как вы один раз примете сертификат вручную);
//  - камера и микрофон работали не только на localhost, но и когда другие
//    люди в сети заходят по вашему IP (браузеры разрешают доступ к камере/
//    микрофону только в "безопасном контексте" — https или localhost).
//
// Запуск:  node generate-cert.js
// Требует установленный openssl (есть по умолчанию на Linux и macOS;
// на Windows — в комплекте с Git for Windows, либо через WSL).

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

if (!hasOpenssl()) {
  console.error('❌ Не найден openssl в PATH.');
  console.error('   Установите его и запустите скрипт снова:');
  console.error('   • Linux: обычно уже установлен (проверьте `apt install openssl`)');
  console.error('   • macOS: обычно уже установлен (или `brew install openssl`)');
  console.error('   • Windows: идёт в комплекте с "Git for Windows" (Git Bash), либо используйте WSL');
  console.error('\nБез сертификата сервер продолжит работать по обычному HTTP — это не страшно, просто');
  console.error('без HTTPS-адреса, звонков/камеры на телефонах по не-localhost IP и без зелёного замка.');
  process.exit(1);
}

if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
  console.log('ℹ️  Сертификат уже существует в certs/. Если IP-адрес компьютера изменился');
  console.log('    и HTTPS перестал открываться по новому адресу — удалите папку certs/ и запустите скрипт снова.');
  process.exit(0);
}

const ips = localIPs();
const sanEntries = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)];
const sanString = sanEntries.join(',');

const conf = `[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = Asteria Local Network

[v3_req]
subjectAltName = ${sanString}
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
basicConstraints = critical, CA:TRUE
`;
fs.writeFileSync(CONF_PATH, conf);

console.log('🔐 Генерирую самоподписанный сертификат для адресов:');
sanEntries.forEach((s) => console.log('   ' + s));

try {
  execSync(
    `openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes ` +
    `-keyout "${KEY_PATH}" -out "${CERT_PATH}" -config "${CONF_PATH}"`,
    { stdio: 'inherit' }
  );
} catch (e) {
  console.error('❌ Не удалось создать сертификат:', e.message);
  process.exit(1);
}

console.log('\n✅ Готово! Сертификат сохранён в certs/cert.pem и certs/key.pem');
console.log('   Запустите (или перезапустите) сервер: node server.js');
console.log('   HTTPS включится автоматически на порту 3443 (можно поменять переменной HTTPS_PORT).');
console.log('\n⚠️  При первом заходе по HTTPS браузер покажет предупреждение "Соединение не защищено" —');
console.log('   это ожидаемо для самоподписанного сертификата. Нажмите "Дополнительно" → "Всё равно перейти".');
console.log('   Если IP-адрес компьютера в сети позже изменится — удалите папку certs/ и запустите скрипт заново.');
