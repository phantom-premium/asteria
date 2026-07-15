'use strict';
// Хранилище на SQLite (встроенный модуль node:sqlite, доступен с Node.js 22.5+,
// экспериментальный, но не требует установки внешних пакетов).
// Каждая "коллекция" — это таблица с колонками id (TEXT PRIMARY KEY) и data (JSON).
// Так сохраняется тот же простой интерфейс (all/insert/update/remove/findById),
// но данные теперь лежат в настоящей БД: поддерживают конкурентный доступ,
// не боятся резкого обрыва записи, и с ними проще расти дальше (индексы, SQL-запросы).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'asteria.db');
const db = new DatabaseSync(DB_PATH);

// WAL — чтобы чтение и запись не блокировали друг друга при нескольких пользователях одновременно
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const TABLES = ['users', 'sessions', 'conversations', 'messages', 'stories', 'folders', 'calls'];

TABLES.forEach((t) => {
  db.exec(`CREATE TABLE IF NOT EXISTS ${t} (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_created_at ON ${t}(created_at)`);
});
// Отдельный индекс для быстрой выборки сообщений по чату (по JSON-полю conversationId)
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(json_extract(data, '$.conversationId'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(json_extract(data, '$.username'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(json_extract(data, '$.token'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(json_extract(data, '$.userId'))`);

function assertTable(name) {
  if (!TABLES.includes(name)) throw new Error(`Неизвестная таблица: ${name}`);
}

const stmtCache = {};
function prep(sql) {
  if (!stmtCache[sql]) stmtCache[sql] = db.prepare(sql);
  return stmtCache[sql];
}

function all(name) {
  assertTable(name);
  const rows = prep(`SELECT data FROM ${name} ORDER BY created_at ASC`).all();
  return rows.map((r) => JSON.parse(r.data));
}

function findById(name, id) {
  assertTable(name);
  if (!id) return null;
  const row = prep(`SELECT data FROM ${name} WHERE id = ?`).get(id);
  return row ? JSON.parse(row.data) : null;
}

function insert(name, obj) {
  assertTable(name);
  if (!obj.id) throw new Error('insert: объект должен иметь поле id');
  prep(`INSERT INTO ${name} (id, data, created_at) VALUES (?, ?, ?)`)
    .run(obj.id, JSON.stringify(obj), obj.createdAt || Date.now());
  return obj;
}

function update(name, id, patch) {
  assertTable(name);
  const current = findById(name, id);
  if (!current) return null;
  const merged = Object.assign({}, current, patch);
  prep(`UPDATE ${name} SET data = ? WHERE id = ?`).run(JSON.stringify(merged), id);
  return merged;
}

function remove(name, id) {
  assertTable(name);
  const res = prep(`DELETE FROM ${name} WHERE id = ?`).run(id);
  return res.changes > 0;
}

// Специальный хелпер: найти сессию/пользователя и т.п. по произвольному JSON-полю,
// без выгрузки всей таблицы в память (используется для поиска по username, token и т.д.)
function findOneBy(name, field, value) {
  assertTable(name);
  const row = prep(`SELECT data FROM ${name} WHERE json_extract(data, '$.' || ?) = ?`).get(field, value);
  return row ? JSON.parse(row.data) : null;
}

function findManyBy(name, field, value) {
  assertTable(name);
  const rows = prep(`SELECT data FROM ${name} WHERE json_extract(data, '$.' || ?) = ? ORDER BY created_at ASC`).all(field, value);
  return rows.map((r) => JSON.parse(r.data));
}

function removeManyBy(name, field, value) {
  assertTable(name);
  const res = prep(`DELETE FROM ${name} WHERE json_extract(data, '$.' || ?) = ?`).run(field, value);
  return res.changes;
}

module.exports = { all, insert, update, remove, findById, findOneBy, findManyBy, removeManyBy };
