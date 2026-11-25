// 🎯 Слежка за игроками через BattleMetrics (онлайн/оффлайн на любом сервере Rust).
// Позиции игроков BattleMetrics не знает — только кто сейчас на сервере.
const path = require('path');
const store = require('./store');

const API = 'https://api.battlemetrics.com';
const FILE = path.join(store.DATA, 'tracker.json');
const MAX_TARGETS = 25;
const KEEP_MS = 14 * 24 * 3600 * 1000; // историю сессий храним 2 недели
const TZ = process.env.TZ_DISPLAY || 'Asia/Tbilisi';

// data: { servers: { "<rust server key>": bmServerId }, bmNames: { bmId: name }, targets: [...] , nextId }
let data = { servers: {}, bmNames: {}, targets: [], nextId: 1, ...store.read(FILE, {}) };
const save = () => store.write(FILE, data);

// ---------- BattleMetrics API ----------
async function bm(p) {
  const headers = { Accept: 'application/json' };
  if (process.env.BATTLEMETRICS_TOKEN) headers.Authorization = `Bearer ${process.env.BATTLEMETRICS_TOKEN}`;
  const r = await fetch(API + p, { headers, signal: AbortSignal.timeout(15000) });
  if (r.status === 429) throw new Error('BattleMetrics: слишком много запросов, подожди минуту');
  if (r.status === 404) throw new Error('BattleMetrics: сервер не найден');
  if (!r.ok) throw new Error(`BattleMetrics ответил HTTP ${r.status}`);
  return r.json();
}

const mapServer = (s) => ({
  id: String(s.id),
  name: s.attributes?.name || '?',
  players: s.attributes?.players ?? 0,
  maxPlayers: s.attributes?.maxPlayers ?? 0,
  country: s.attributes?.country || '',
  status: s.attributes?.status || '',
});

async function searchServers(query) {
  const q = encodeURIComponent(String(query).slice(0, 100));
  const j = await bm(`/servers?filter[game]=rust&filter[search]=${q}&page[size]=10&sort=-players`);
  return (j.data || []).map(mapServer);
}

// сервер + список игроков онлайн
async function getServer(id) {
  const j = await bm(`/servers/${encodeURIComponent(id)}?include=player`);
  const srv = mapServer(j.data);
  srv.online = (j.included || []).filter((x) => x.type === 'player')
    .map((p) => ({ id: String(p.id), name: String(p.attributes?.name || '') }));
  data.bmNames[srv.id] = srv.name;
  return srv;
}

// "https://www.battlemetrics.com/servers/rust/1234567" или "1234567" → id
function parseServerRef(text) {
  const t = String(text || '').trim();
  const m = t.match(/battlemetrics\.com\/servers\/rust\/(\d+)/i) || t.match(/^(\d{3,})$/);
  return m ? m[1] : null;
}

// подобрать сервер BattleMetrics по названию из Rust+ (и онлайну)
async function autoDetect(rustName, rustPlayers) {
  const list = await searchServers(rustName);
  if (!list.length) return null;
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const exact = list.filter((s) => norm(s.name) === norm(rustName));
  const pool = exact.length ? exact : list;
  pool.sort((a, b) => Math.abs(a.players - rustPlayers) - Math.abs(b.players - rustPlayers));
  return exact.length ? pool[0] : null; // без точного совпадения не угадываем
}

// ---------- выбранный сервер для текущего сервера Rust+ ----------
function serverFor(rustKey) { return data.servers[rustKey] || null; }
function setServerFor(rustKey, bmId, name) {
  data.servers[rustKey] = String(bmId);
  if (name) data.bmNames[String(bmId)] = name;
  save();
}
const serverName = (bmId) => data.bmNames[bmId] || `#${bmId}`;

// ---------- цели ----------
const all = () => data.targets;
const forServer = (bmId) => data.targets.filter((t) => t.bmServerId === String(bmId));
const get = (id) => data.targets.find((t) => t.id === Number(id)) || null;
const norm = (s) => String(s || '').toLowerCase().trim();

function add({ name, bmServerId, base, note, addedBy }) {
  name = String(name || '').trim().slice(0, 64);
  if (!name) return { error: 'Укажи ник' };
  if (!bmServerId) return { error: 'Сначала выбери сервер (🌍 Сервер)' };
  if (data.targets.length >= MAX_TARGETS) return { error: `Максимум ${MAX_TARGETS} целей` };
  if (data.targets.some((t) => t.bmServerId === String(bmServerId) && norm(t.name) === norm(name))) return { error: 'Этот игрок уже в списке' };
  const t = {
    id: data.nextId++, name, bmServerId: String(bmServerId), bmPlayerId: null,
    base: String(base || '').trim().toUpperCase().slice(0, 8), note: String(note || '').trim().slice(0, 100),
    addedBy, online: null, since: Date.now(), firstSince: Date.now(), lastSeen: null, sessions: [],
  };
  data.targets.push(t);
  save();
  return { target: t };
}

function remove(id) {
  const t = get(id);
  if (!t) return null;
  data.targets = data.targets.filter((x) => x.id !== t.id);
  save();
  return t;
}

function findByName(name, bmServerId) {
  const n = norm(name);
  const list = bmServerId ? forServer(bmServerId) : data.targets;
  return list.find((t) => norm(t.name) === n) || list.find((t) => norm(t.name).includes(n)) || null;
}

function setBase(id, base, note) {
  const t = get(id);
  if (!t) return null;
  if (base !== undefined) t.base = String(base).trim().toUpperCase().slice(0, 8);
  if (note !== undefined) t.note = String(note).trim().slice(0, 100);
  save();
  return t;
}

// ---------- опрос ----------
// Возвращает события [{ target, type: 'online'|'offline'|'first', session }]
async function poll() {
  const events = [];
  const servers = [...new Set(data.targets.map((t) => t.bmServerId))];
  for (const sid of servers) {
    let srv;
    try { srv = await getServer(sid); } catch (e) { events.push({ error: e.message, bmServerId: sid }); continue; }
    const byId = new Map(srv.online.map((p) => [p.id, p]));
    const now = Date.now();
    for (const t of data.targets.filter((x) => x.bmServerId === sid)) {
      // ищем по id игрока (переживает смену ника), иначе по нику
      let p = t.bmPlayerId ? byId.get(t.bmPlayerId) : null;
      if (!p) p = srv.online.find((x) => norm(x.name) === norm(t.name));
      if (p && !t.bmPlayerId) t.bmPlayerId = p.id;
      if (p && p.name && p.name !== t.name) t.name = p.name; // сменил ник — обновим
      const isOn = !!p;
      if (t.online === null) {
        t.online = isOn; t.since = now;
        if (isOn) t.sessions.push([now, null]);
        events.push({ target: t, type: 'first' });
      } else if (isOn !== t.online) {
        const prevSince = t.since;
        t.online = isOn; t.since = now;
        if (isOn) t.sessions.push([now, null]);
        else {
          const last = t.sessions[t.sessions.length - 1];
          if (last && last[1] === null) last[1] = now;
          t.lastSeen = now;
        }
        events.push({ target: t, type: isOn ? 'online' : 'offline', duration: now - prevSince });
      }
      if (isOn) t.lastSeen = now;
      t.sessions = t.sessions.filter((s) => (s[1] ?? now) > now - KEEP_MS).slice(-300);
    }
  }
  save();
  return events;
}

// ---------- статистика ----------
function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d}д ${h}ч`;
  if (h) return `${h}ч ${mm}м`;
  return `${mm}м`;
}

function hourOf(ts) {
  return Number(new Intl.DateTimeFormat('ru-RU', { hour: 'numeric', hour12: false, timeZone: TZ }).format(new Date(ts))) % 24;
}

// доля онлайна по часам суток за последние 7 дней
function hourly(t) {
  const now = Date.now(), from = now - 7 * 24 * 3600 * 1000;
  const on = new Array(24).fill(0), seen = new Array(24).fill(0);
  const tracked = Math.max(from, t.firstSince || from);
  for (let ts = Math.ceil(tracked / 3600000) * 3600000; ts < now; ts += 3600000) {
    const h = hourOf(ts);
    seen[h]++;
    if (t.sessions.some(([a, b]) => a <= ts && (b ?? now) >= ts)) on[h]++;
  }
  return on.map((v, h) => (seen[h] ? v / seen[h] : null));
}

function stats(t) {
  const now = Date.now();
  const day = now - 24 * 3600 * 1000;
  let today = 0;
  for (const [a, b] of t.sessions) today += Math.max(0, Math.min(b ?? now, now) - Math.max(a, day));
  const h = hourly(t);
  const bars = '▁▂▃▄▅▆▇█';
  const graph = h.map((v) => (v === null ? '·' : bars[Math.min(7, Math.round(v * 7))])).join('');
  // самая длинная «тихая» полоса (онлайн < 15%) — когда обычно оффлайн
  let best = null;
  if (h.filter((v) => v !== null).length >= 24) {
    for (let s = 0; s < 24; s++) {
      let len = 0;
      while (len < 24 && h[(s + len) % 24] !== null && h[(s + len) % 24] < 0.15) len++;
      if (len >= 3 && (!best || len > best.len)) best = { start: s, len };
    }
  }
  const pad = (x) => String(x).padStart(2, '0');
  return {
    today,
    graph,
    quiet: best ? `${pad(best.start)}:00–${pad((best.start + best.len) % 24)}:00` : null,
    sessions: t.sessions.length,
  };
}

module.exports = {
  TZ, searchServers, getServer, parseServerRef, autoDetect, serverFor, setServerFor, serverName,
  all, forServer, get, add, remove, findByName, setBase, poll, stats, fmtDur,
};
