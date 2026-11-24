// Надёжное хранение данных:
//  - секретные файлы (токены) шифруются AES-256-GCM ключом DATA_KEY из .env
//  - запись атомарная (через временный файл), чтобы файл не побился при сбое
//  - папка data — права 700, файлы — 600 (читает только владелец)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

// ключ шифрования: DATA_KEY в .env (64 hex-символа). Если нет — создаём и дописываем в .env
let KEY = null;
function key() {
  if (KEY) return KEY;
  let hex = (process.env.DATA_KEY || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    hex = crypto.randomBytes(32).toString('hex');
    const envFile = path.join(ROOT, '.env');
    try {
      fs.appendFileSync(envFile, `\n# Ключ шифрования данных бота. НЕ меняй и не удаляй, иначе токены придётся привязывать заново\nDATA_KEY=${hex}\n`);
      try { fs.chmodSync(envFile, 0o600); } catch {}
      console.log('Создан ключ шифрования DATA_KEY (записан в .env)');
    } catch (e) {
      console.log('Не смог записать DATA_KEY в .env:', e.message);
    }
    process.env.DATA_KEY = hex;
  }
  KEY = Buffer.from(hex, 'hex');
  return KEY;
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { enc: 'aes-256-gcm', v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(box) {
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  const out = Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]);
  return JSON.parse(out.toString('utf8'));
}

function atomicWrite(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

/** Прочитать JSON. Для secret-файлов старые незашифрованные версии читаются и сразу перешифровываются. */
function read(file, fallback, { secret = false } = {}) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  if (raw && raw.enc === 'aes-256-gcm') {
    try { return decrypt(raw); } catch {
      console.log(`⚠️ Не смог расшифровать ${path.relative(ROOT, file)} — неверный DATA_KEY? Файл пропущен.`);
      return fallback;
    }
  }
  if (secret) { try { write(file, raw, { secret: true }); } catch {} } // миграция на шифрование
  return raw;
}

function write(file, obj, { secret = false } = {}) {
  atomicWrite(file, JSON.stringify(secret ? encrypt(obj) : obj, null, 2));
}

function remove(file) { try { fs.unlinkSync(file); } catch {} }

module.exports = { DATA, ensureDir, read, write, remove, key };
