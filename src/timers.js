// Таймеры: !timer 10m печь  → через 10 минут напоминание. Сохраняются в data/timers.json (переживают перезапуск)
const path = require('path');
const store = require('./store');

const FILE = path.join(process.cwd(), 'data', 'timers.json');
const MAX = 15;
const MAX_MS = 24 * 3600 * 1000;

let list = []; // [{id, name, at, who}]
let nextId = 1;
const handles = new Map();
let onFire = () => {};

function save() { store.write(FILE, list); }

// "10m", "1h30m", "90s", "2ч", "15м", "1ч 20мин", "10" (минуты)
function parseDuration(str) {
  const s = String(str || '').toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * 60000;
  const re = /(\d+(?:[.,]\d+)?)(h|ч|час|часа|часов|m|м|мин|min|s|с|сек|sec)/g;
  let total = 0, matched = '', mm;
  while ((mm = re.exec(s))) {
    const n = parseFloat(mm[1].replace(',', '.'));
    const u = mm[2];
    total += /^(h|ч)/.test(u) ? n * 3600000 : /^(s|с)/.test(u) ? n * 1000 : n * 60000;
    matched += mm[0];
  }
  return matched === s && total > 0 ? Math.round(total) : null;
}

function fmtLeft(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}ч ${m}м`;
  if (m) return s ? `${m}м ${s}с` : `${m}м`;
  return `${s}с`;
}

function schedule(t) {
  const delay = Math.max(0, t.at - Date.now());
  handles.set(t.id, setTimeout(() => {
    handles.delete(t.id);
    list = list.filter((x) => x.id !== t.id);
    save();
    onFire(t);
  }, delay));
}

function init(fireCallback) {
  onFire = fireCallback;
  list = store.read(FILE, []);
  if (!Array.isArray(list)) list = [];
  nextId = list.reduce((a, t) => Math.max(a, t.id), 0) + 1;
  list.forEach(schedule); // просроченные за время выключения сработают сразу
}

function add(durationStr, name, who) {
  const ms = parseDuration(durationStr);
  if (!ms) return { error: 'Не понял время. Примеры: !timer 10m печь, !timer 1h30m, !timer 45s' };
  if (ms > MAX_MS) return { error: 'Максимум 24 часа' };
  if (list.length >= MAX) return { error: `Слишком много таймеров (макс ${MAX}). Удалить: !timer del <номер>` };
  const t = { id: nextId++, name: (name || 'таймер').slice(0, 60), at: Date.now() + ms, who };
  list.push(t);
  save();
  schedule(t);
  return { timer: t, ms };
}

function remove(q) {
  const s = String(q || '').toLowerCase();
  const t = list.find((x) => String(x.id) === s) || list.find((x) => x.name.toLowerCase() === s);
  if (!t) return null;
  clearTimeout(handles.get(t.id));
  handles.delete(t.id);
  list = list.filter((x) => x.id !== t.id);
  save();
  return t;
}

const all = () => [...list].sort((a, b) => a.at - b.at);

module.exports = { init, add, remove, all, parseDuration, fmtLeft };
