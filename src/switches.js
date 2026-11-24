// Хранилище привязанных устройств: data/devices.json
// { "<entityId>": { "name": "свет", "type": 1 } }   type: 1 = Smart Switch, 2 = Smart Alarm
const fs = require('fs');
const path = require('path');
const store = require('./store');

const DIR = path.join(process.cwd(), 'data');
const LEGACY = path.join(DIR, 'devices.json');
const TYPE = { SWITCH: 1, ALARM: 2, STORAGE: 3 };

// у каждого сервера свой список устройств: data/devices-<serverId>.json
let FILE = LEGACY;
let devices = {};
function setServer(serverId) {
  FILE = path.join(DIR, `devices-${serverId || 'default'}.json`);
  if (!fs.existsSync(FILE) && fs.existsSync(LEGACY)) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.renameSync(LEGACY, FILE); // старый общий список переносим на текущий сервер
  }
  devices = store.read(FILE, {});
}

function save() { store.write(FILE, devices); }

const norm = (s) => String(s || '').trim().toLowerCase();

function all() { return Object.entries(devices).map(([id, d]) => ({ id: Number(id), ...d })); }
function byType(type) { return all().filter((d) => d.type === type); }
function get(id) { return devices[id] ? { id: Number(id), ...devices[id] } : null; }

function findByName(name) {
  const n = norm(name);
  return all().find((d) => norm(d.name) === n || String(d.id) === n) || null;
}

function uniqueName(base) {
  let name = base, i = 2;
  while (findByName(name)) name = `${base}${i++}`;
  return name;
}

// добавить, если ещё нет; возвращает {device, isNew}
function add(id, type, owner) {
  if (devices[id]) {
    if (owner && devices[id].owner !== String(owner)) { devices[id].owner = String(owner); save(); }
    return { device: get(id), isNew: false };
  }
  const base = type === TYPE.ALARM ? 'аларм' : type === TYPE.SWITCH ? 'свитч' : 'ящик';
  devices[id] = { name: uniqueName(base), type, owner: owner ? String(owner) : undefined };
  save();
  return { device: get(id), isNew: true };
}

function rename(oldName, newName) {
  const d = findByName(oldName);
  if (!d) return { error: `Не нашёл «${oldName}»` };
  if (!newName || /\s/.test(newName.trim())) return { error: 'Новое имя — одно слово, без пробелов' };
  const other = findByName(newName);
  if (other && other.id !== d.id) return { error: `Имя «${newName}» уже занято` };
  devices[d.id].name = newName.trim();
  save();
  return { device: get(d.id) };
}

function remove(name) {
  const d = findByName(name);
  if (!d) return null;
  delete devices[d.id];
  save();
  return d;
}

function clear() { const n = Object.keys(devices).length; devices = {}; save(); return n; }

module.exports = { clear, setServer, TYPE, all, byType, get, findByName, add, rename, remove };
