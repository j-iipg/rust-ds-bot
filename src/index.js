require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createRustClient } = require('./relay');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  ActivityType, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const accounts = require('./accounts');

const { toGrid } = require('./grid');
const dev = require('./switches');
const { startFcm } = require('./fcm');
const { renderMap } = require('./map');
const reminders = require('./timers');

// ---------- конфиг ----------
const cfg = {
  discordToken: process.env.DISCORD_TOKEN,
  channelId: process.env.DISCORD_CHANNEL_ID,
  ip: process.env.RUST_IP,
  port: process.env.RUST_PORT,
  playerId: process.env.RUST_PLAYER_ID,
  playerToken: process.env.RUST_PLAYER_TOKEN,
  toTeamChat: (process.env.POST_TO_TEAMCHAT || 'true') === 'true',
  teamPoll: Number(process.env.TEAM_POLL_SECONDS || 5) * 1000,
  eventsPoll: Number(process.env.EVENTS_POLL_SECONDS || 10) * 1000,
};
// Текущий сервер: data/server.json (сохраняется при Pair в игре) важнее, чем .env
const SERVER_FILE = path.join(process.cwd(), 'data', 'server.json');
let server = {
  RUST_SERVER_ID: process.env.RUST_SERVER_ID,
  RUST_IP: process.env.RUST_IP,
  RUST_PORT: process.env.RUST_PORT,
  RUST_PLAYER_ID: process.env.RUST_PLAYER_ID,
  RUST_PLAYER_TOKEN: process.env.RUST_PLAYER_TOKEN,
  name: null,
};
try { Object.assign(server, JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'))); } catch {}

for (const k of ['discordToken', 'channelId']) {
  if (!cfg[k]) { console.error(`Не заполнено в .env: ${k}`); process.exit(1); }
}
if (!server.RUST_PLAYER_ID || !server.RUST_PLAYER_TOKEN || (!server.RUST_SERVER_ID && !server.RUST_IP)) {
  console.log('Сервер Rust ещё не привязан — зайди в игру и нажми Rust+ → Pair with server, бот подхватит сам.');
}

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// ---------- время в игре ----------
const hhmm = (h) => { const x = ((h % 24) + 24) % 24; return `${String(Math.floor(x)).padStart(2, '0')}:${String(Math.floor((x % 1) * 60)).padStart(2, '0')}`; };
function timeInfo(t) {
  const isDay = t.time >= t.sunrise && t.time < t.sunset;
  const gameHoursLeft = isDay ? t.sunset - t.time : ((t.sunrise - t.time) + 24) % 24;
  // примерно: dayLengthMinutes — длина суток в реальных минутах, ночь идёт быстрее в timeScale раз
  const perHour = (t.dayLengthMinutes || 60) / 24;
  const realMin = Math.round(gameHoursLeft * perHour / (isDay ? 1 : (t.timeScale || 1)));
  return { isDay, clock: hhmm(t.time), realMin, edge: hhmm(isDay ? t.sunset : t.sunrise) };
}
const gameClock = (t) => { const ti = timeInfo(t); return `${ti.isDay ? '☀️' : '🌙'} ${ti.clock}`; };

// ---------- состояние ----------
let rust = null;
let channel = null;
let mapSize = 0;
let team = new Map();      // steamId -> {name, isOnline, isAlive, x, y}
let markers = null;        // id -> {type, x, y}; null = ещё не инициализировано
let timers = [];
const sentEcho = new Map(); // текст -> время отправки (чтобы не зациклить мост)

const grid = (x, y) => toGrid(x, y, mapSize);

// ---------- Discord ----------
const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel], // нужно, чтобы получать личные сообщения (для !link)
});

// ---------- оформление ----------
const COLOR = { info: 0x5865f2, ok: 0x2ecc71, bad: 0xe74c3c, warn: 0xe67e22, muted: 0x95a5a6, chat: 0x2b2d31, gold: 0xf1c40f };
let serverInfo = null;   // последний getInfo: { name, players, maxPlayers, queuedPlayers }
let lastTime = null;     // последний getTime

const footer = () => ({ text: `Rust Bot • ${serverInfo?.name || server.name || 'сервер не привязан'}` });

function card({ title, desc, color = COLOR.info, author, fields, image } = {}) {
  const e = new EmbedBuilder().setColor(color).setFooter(footer()).setTimestamp();
  if (author) e.setAuthor({ name: author });
  if (title) e.setTitle(title);
  if (desc) e.setDescription(String(desc).slice(0, 4000));
  if (fields?.length) e.addFields(fields);
  if (image) e.setImage(image);
  return e;
}

// подпись-категория по первому эмодзи сообщения
const CATEGORY = [
  [/^💀/, 'СМЕРТЬ'], [/^(🟢|⚫)/, 'ОНЛАЙН'], [/^(➕|➖)/, 'КОМАНДА'], [/^(🚢|🚁|📦|💥)/, 'ИВЕНТ НА КАРТЕ'],
  [/^🚨/, 'ТРЕВОГА'], [/^⏰/, 'ТАЙМЕР'], [/^🔗/, 'ПРИВЯЗКА'], [/^👤/, 'АККАУНТЫ'], [/^(✅|🔌|🔄)/, 'СТАТУС'], [/^⚠️/, 'ВНИМАНИЕ'],
];

async function toDiscord(text, color) {
  if (!channel) return;
  const cat = CATEGORY.find(([re]) => re.test(text))?.[1];
  try {
    await channel.send({ embeds: [card({ desc: text, color: color || COLOR.info, author: cat })], allowedMentions: { parse: [] } });
  } catch (e) { log('Discord send error:', e.message); }
}

async function chatToDiscord(name, text) {
  if (!channel) return;
  try {
    await channel.send({ embeds: [new EmbedBuilder().setColor(COLOR.chat).setAuthor({ name: `💬 ${name}` }).setDescription(text.slice(0, 4000))], allowedMentions: { parse: [] } });
  } catch (e) { log('Discord send error:', e.message); }
}

// ---------- очередь в тим-чат (Rust+ не любит спам запросами) ----------
const teamQueue = [];
let sending = false;
function toTeamChat(text) {
  if (!rust) return;
  teamQueue.push(text.slice(0, 128));
  if (!sending) pumpTeamQueue();
}
async function pumpTeamQueue() {
  sending = true;
  while (teamQueue.length && rust) {
    const msg = teamQueue.shift();
    sentEcho.set(msg, Date.now());
    try { await rust.sendRequestAsync({ sendTeamMessage: { message: msg } }); }
    catch (e) { log('Team chat send error:', e.message || e); }
    await new Promise(r => setTimeout(r, 1500));
  }
  sending = false;
}

// Уведомление: в Discord (с эмодзи/цветом) и, если включено, в тим-чат
function notify(discordText, gameText, color) {
  toDiscord(discordText, color);
  if (cfg.toTeamChat && gameText) toTeamChat(gameText);
}

// ---------- пачка: смерти, онлайн, вход/выход из команды ----------
function processTeam(teamInfo, silent = false) {
  const next = new Map();
  for (const m of teamInfo.members || []) {
    const id = String(m.steamId);
    const cur = { name: m.name, isOnline: m.isOnline, isAlive: m.isAlive, x: m.x, y: m.y };
    next.set(id, cur);
    const prev = team.get(id);
    if (silent) continue;

    if (!prev) {
      if (team.size) notify(`➕ **${cur.name}** вступил в команду`, `[BOT] ${cur.name} вступил в команду`, 0x3498db);
      continue;
    }
    if (prev.isAlive && !cur.isAlive) {
      const where = grid(cur.x, cur.y);
      const sleeping = !cur.isOnline ? ' (был оффлайн — убили спящего)' : '';
      notify(`💀 **${cur.name}** умер в **${where}**${sleeping}`,
             `[BOT] ${cur.name} умер в ${where}${sleeping}`, 0xe74c3c);
    }
    if (!prev.isOnline && cur.isOnline) {
      notify(`🟢 **${cur.name}** зашёл на сервер`, `[BOT] ${cur.name} зашёл`, 0x2ecc71);
    }
    if (prev.isOnline && !cur.isOnline) {
      notify(`⚫ **${cur.name}** вышел с сервера (${grid(cur.x, cur.y)})`, `[BOT] ${cur.name} вышел`, 0x95a5a6);
    }
  }
  if (!silent) {
    for (const [id, prev] of team) {
      if (!next.has(id)) notify(`➖ **${prev.name}** покинул команду`, `[BOT] ${prev.name} покинул команду`, 0x3498db);
    }
  }
  const changed = next.size !== team.size || [...next].some(([id, c]) => team.get(id)?.isOnline !== c.isOnline);
  team = next;
  if (changed || silent) updateMenu();
}

async function pollTeam() {
  try {
    const res = await rust.sendRequestAsync({ getTeamInfo: {} });
    processTeam(res.teamInfo);
  } catch (e) { log('getTeamInfo error:', e.message || e); }
}

// ---------- ивенты карты ----------
const T = { EXPLOSION: 2, CH47: 4, CARGO: 5, CRATE: 6, HELI: 8 };
const WATCH = new Set(Object.values(T));

function markerAppeared(m) {
  const g = grid(m.x, m.y);
  switch (m.type) {
    case T.CARGO: return notify(`🚢 Карго появилось (${g})`, `[BOT] Карго появилось (${g})`, 0x1abc9c);
    case T.HELI: return notify(`🚁 Патрульный вертолёт залетел (${g})`, `[BOT] Патрульный вертолёт (${g})`, 0xe67e22);
    case T.CH47: return notify(`🚁 Чинук летит (${g})`, `[BOT] Чинук (${g})`, 0xf1c40f);
    case T.CRATE: return notify(`📦 Запертый ящик в **${g}**`, `[BOT] Запертый ящик в ${g}`, 0x9b59b6);
    case T.EXPLOSION: return notify(`💥 Взрыв в **${g}** — сбит вертолёт или Брэдли`, `[BOT] Взрыв в ${g} (heli/брэдли)`, 0xc0392b);
  }
}
function markerGone(m) {
  switch (m.type) {
    case T.CARGO: return notify('🚢 Карго уплыло', '[BOT] Карго уплыло', 0x1abc9c);
    case T.HELI: return notify('🚁 Патрульный вертолёт пропал (улетел или сбит)', '[BOT] Вертолёт пропал', 0xe67e22);
  }
}

async function pollEvents() {
  try {
    const res = await rust.sendRequestAsync({ getMapMarkers: {} });
    const now = new Map();
    for (const m of res.mapMarkers.markers || []) {
      if (WATCH.has(m.type)) now.set(String(m.id), { type: m.type, x: m.x, y: m.y });
    }
    if (markers) {
      for (const [id, m] of now) if (!markers.has(id)) markerAppeared(m);
      for (const [id, m] of markers) if (!now.has(id)) markerGone(m);
    }
    markers = now; // первый опрос — тихий, только запоминаем что уже есть на карте
  } catch (e) { log('getMapMarkers error:', e.message || e); }
}

// ---------- токены аккаунтов на сервере ----------
// playerToken у каждого аккаунта свой для каждого сервера: data/tokens-<serverId>.json { steamId: token }
const tokensFile = (sid) => path.join(process.cwd(), 'data', `tokens-${sid}.json`);
function readTokens(sid) { try { return JSON.parse(fs.readFileSync(tokensFile(sid), 'utf8')); } catch { return {}; } }
function saveToken(sid, steamId, token) {
  if (!sid || !steamId || token === undefined) return;
  const t = readTokens(sid);
  t[String(steamId)] = String(token);
  fs.mkdirSync(path.dirname(tokensFile(sid)), { recursive: true });
  fs.writeFileSync(tokensFile(sid), JSON.stringify(t, null, 2));
}

// Подключения от имени других аккаунтов (для устройств, которые привязал тиммейт)
const pool = new Map(); // steamId -> { client, ready }
function clientFor(steamId) {
  const primary = String(server.RUST_PLAYER_ID);
  if (!steamId || String(steamId) === primary || !server.RUST_SERVER_ID) {
    return rust ? Promise.resolve(rust) : Promise.reject(new Error('бот сейчас не подключён к Rust+'));
  }
  steamId = String(steamId);
  if (pool.has(steamId)) return pool.get(steamId).ready;
  const token = readTokens(server.RUST_SERVER_ID)[steamId];
  const auth = accounts.authToken(steamId);
  const who = accounts.get(steamId)?.name || steamId;
  if (!token || !auth) return Promise.reject(new Error(`нет данных аккаунта ${who} — пусть сделает Pair with server`));
  const { client } = createRustClient({ ...server, RUST_PLAYER_ID: steamId, RUST_PLAYER_TOKEN: token }, auth);
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`аккаунт ${who} не подключился`)), 15000);
    client.on('connected', () => { clearTimeout(t); resolve(client); });
  });
  ready.catch(() => pool.delete(steamId));
  client.on('error', (e) => log(`Rust+ (${who}) ошибка:`, e.message || e));
  client.on('message', (m) => { if (m.broadcast?.entityChanged) onEntityChanged(m.broadcast.entityChanged); });
  client.on('disconnected', () => pool.delete(steamId));
  pool.set(steamId, { client, ready });
  client.connect();
  return ready;
}
function closePool() {
  for (const { client } of pool.values()) { client.switching = true; try { client.disconnect(); } catch {} }
  pool.clear();
}

// ---------- переключатели и алармы ----------
const switchState = new Map(); // entityId -> true/false

const errText = (e) => {
  const s = e?.error || e?.message || String(e);
  if (s === 'not_found') return 'не найден (сломан или отвязан?)';
  if (s === 'rate_limit') return 'слишком часто, подожди пару секунд';
  return s;
};
const stateText = (v) => (v === true ? 'ВКЛ' : v === false ? 'ВЫКЛ' : '?');

// getEntityInfo заодно подписывает бота на изменения этого устройства
async function refreshDevice(d) {
  const c = await clientFor(d.owner);
  const res = await c.sendRequestAsync({ entityId: d.id, getEntityInfo: {} });
  const v = !!res.entityInfo?.payload?.value;
  if (d.type === dev.TYPE.SWITCH) switchState.set(d.id, v);
  return v;
}

async function subscribeAll() {
  for (const d of dev.all()) {
    try { await refreshDevice(d); } catch (e) { log(`Устройство ${d.name}: ${errText(e)}`); }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function setSwitch(d, value) {
  const c = await clientFor(d.owner);
  await c.sendRequestAsync({ entityId: d.id, setEntityValue: { value } });
  switchState.set(d.id, value);
  updatePanel();
  updateMenu();
}

function onEntityChanged(ch) {
  const d = dev.get(ch.entityId);
  if (!d) return;
  const v = !!ch.payload?.value;
  if (d.type === dev.TYPE.SWITCH) { switchState.set(d.id, v); updatePanel(); }
  if (d.type === dev.TYPE.ALARM && v) {
    notify(`🚨 **Сработал аларм «${d.name}»!**`, `[BOT] !!! Сработал аларм ${d.name} !!!`, 0xff0000);
  }
}

// привязка из игры (смотришь на устройство → зажать E → Pair)
function onPairing(body, account) {
  const who = account?.name || body.playerId;
  if (body.id && body.playerId && body.playerToken !== undefined) saveToken(body.id, body.playerId, body.playerToken);

  if (body.type === 'server') {
    if (!body.id) return;
    const sameServer = body.id === server.RUST_SERVER_ID;
    const isPrimary = String(body.playerId) === String(server.RUST_PLAYER_ID);
    if (!sameServer || (isPrimary && String(body.playerToken) !== String(server.RUST_PLAYER_TOKEN)) || !rust) {
      switchServer(body, who);
    } else if (!isPrimary) {
      toDiscord(`🔗 **${who}** привязал свой аккаунт к этому серверу — теперь может привязывать переключатели`, 0x3498db);
    }
    return;
  }
  if (body.type !== 'entity' || !body.entityId) return;
  if (body.id && server.RUST_SERVER_ID && body.id !== server.RUST_SERVER_ID) {
    toDiscord(`⚠️ ${who} привязал устройство на другом сервере. Сначала сделайте Rust+ → Pair with server на нужном сервере.`);
    return;
  }
  const id = Number(body.entityId);
  const type = Number(body.entityType);
  if (type === dev.TYPE.STORAGE) {
    toDiscord('📦 Storage Monitor пока не поддерживается — привязывай Smart Switch или Smart Alarm.');
    return;
  }
  const { device, isNew } = dev.add(id, type, body.playerId);
  if (!isNew) { if (rust) refreshDevice(device).catch(() => {}).finally(updatePanel); return; }
  const kind = type === dev.TYPE.ALARM ? 'Smart Alarm' : 'Smart Switch';
  notify(`🔗 **${who}** привязал **${kind}** → имя **${device.name}**\nПереименовать: \`!name ${device.name} новое_имя\``,
         `[BOT] Привязан ${kind}: ${device.name}. Переименовать: !name ${device.name} имя`, 0x3498db);
  if (rust) refreshDevice(device).catch(() => {}).finally(updatePanel);
  else updatePanel();
}

const HELP = [
  '!menu — главное меню с кнопками в Discord',
  '!map — карта с пачкой и ивентами',
  '!time — время в игре, сколько до ночи/утра',
  '!timer 10m печь — напоминание (!timers — список, !timer del <номер>)',
  '!link — добавить свой аккаунт (файл в ЛС боту), чтобы привязывать без владельца',
  '!accounts — привязанные аккаунты и сколько дней живут токены',
  '!team — кто в пачке, онлайн и где',
  '!leader <ник> — передать лидерство',
  '!panel — пульт с кнопками в Discord',
  '!sw — список переключателей и алармов',
  '!on <имя> / !off <имя> — включить / выключить (можно all)',
  '!t <имя> — переключить',
  '!name <старое> <новое> — переименовать',
  '!del <имя> — удалить из списка',
];

// Выполняет команду. Возвращает { lines: [...], action: 'короткая строка для тим-чата' } или null, если это не команда.
async function runCommand(text, who) {
  const [rawCmd, ...args] = text.slice(1).trim().split(/\s+/);
  const cmd = (rawCmd || '').toLowerCase();
  const needRust = () => { if (!rust) throw new Error('бот сейчас не подключён к Rust+'); };

  switch (cmd) {
    case 'help': case 'помощь': case 'команды':
      return { lines: [
        '**В Discord** всё на кнопках — главное меню выше (если пропало: `!menu`).',
        '',
        '**В тим-чате игры:**',
        ...HELP.map((h) => `\`${h.split(' — ')[0]}\` — ${h.split(' — ').slice(1).join(' — ')}`),
      ] };

    case 'menu': case 'меню': {
      if (!channel) return { lines: ['Discord ещё не готов'] };
      await postMenu();
      return { lines: ['🏠 Меню отправлено в Discord'], silentDiscord: true };
    }

    case 'sw': case 'свитчи': case 'switches': {
      needRust();
      const list = dev.all().filter((d) => d.type !== dev.TYPE.STORAGE);
      if (!list.length) return { lines: ['Нет привязанных устройств. В игре: смотри на Smart Switch → зажми E → Pair'] };
      const lines = [];
      for (const d of list) {
        try {
          const v = await refreshDevice(d);
          lines.push(d.type === dev.TYPE.ALARM ? `🚨 ${d.name}: аларм` : `${v ? '🟢' : '🔴'} ${d.name}: ${stateText(v)}`);
        } catch (e) { lines.push(`⚠️ ${d.name}: ${errText(e)}`); }
      }
      return { lines };
    }

    case 'on': case 'вкл': case 'off': case 'выкл': case 't': case 'toggle': {
      needRust();
      const name = args.join(' ');
      if (!name) return { lines: [`Укажи имя: !${cmd} свет (список: !sw)`] };
      const targets = name.toLowerCase() === 'all' || name.toLowerCase() === 'все'
        ? dev.byType(dev.TYPE.SWITCH)
        : [dev.findByName(name)].filter(Boolean);
      if (!targets.length) return { lines: [`Не нашёл «${name}». Список: !sw`] };
      const lines = [];
      for (const d of targets) {
        if (d.type !== dev.TYPE.SWITCH) { lines.push(`${d.name} — это не переключатель`); continue; }
        try {
          let value;
          if (cmd === 't' || cmd === 'toggle') value = !(switchState.has(d.id) ? switchState.get(d.id) : await refreshDevice(d));
          else value = cmd === 'on' || cmd === 'вкл';
          await setSwitch(d, value);
          lines.push(`${value ? '🟢' : '🔴'} ${d.name}: ${stateText(value)}`);
        } catch (e) { lines.push(`⚠️ ${d.name}: ${errText(e)}`); }
        if (targets.length > 1) await new Promise((r) => setTimeout(r, 400));
      }
      return { lines, action: `${who}: ${lines.join(', ')}` };
    }

    case 'panel': case 'пульт': {
      if (!channel) return { lines: ['Discord ещё не готов'] };
      await postPanel();
      return { lines: ['🎛️ Пульт отправлен в Discord-канал'], silentDiscord: true };
    }

    case 'team': case 'пачка': {
      needRust();
      const res = await rust.sendRequestAsync({ getTeamInfo: {} });
      const leader = String(res.teamInfo.leaderSteamId);
      return { lines: (res.teamInfo.members || []).map((m) =>
        `${m.isOnline ? '🟢' : '⚫'} ${m.name}${String(m.steamId) === leader ? ' 👑' : ''} — ${m.isAlive ? grid(m.x, m.y) : 'мёртв'}`) };
    }

    case 'leader': case 'лидер': {
      needRust();
      const name = args.join(' ').toLowerCase();
      if (!name) return { lines: ['Пример: !leader Gleb'] };
      const res = await rust.sendRequestAsync({ getTeamInfo: {} });
      const members = res.teamInfo.members || [];
      const target = members.find((m) => m.name.toLowerCase() === name) || members.find((m) => m.name.toLowerCase().includes(name));
      if (!target) return { lines: [`Не нашёл «${args.join(' ')}» в пачке`] };
      if (String(res.teamInfo.leaderSteamId) !== String(server.RUST_PLAYER_ID)) {
        return { lines: ['⚠️ Передать лидерство может только лидер, а аккаунт бота сейчас не лидер'] };
      }
      await rust.sendRequestAsync({ promoteToLeader: { steamId: target.steamId } });
      return { lines: [`👑 Лидер теперь ${target.name}`], action: `${who}: лидер теперь ${target.name}` };
    }

    case 'map': case 'карта': {
      needRust();
      const sid = server.RUST_SERVER_ID || server.RUST_IP;
      if (!mapCache || mapCache.sid !== sid) {
        const res = await rust.sendRequestAsync({ getMap: {} }, 30000);
        mapCache = { sid, map: res.map };
      }
      const [ti, mk] = await Promise.all([
        rust.sendRequestAsync({ getTeamInfo: {} }),
        rust.sendRequestAsync({ getMapMarkers: {} }),
      ]);
      let timeStr = '';
      try { const { time: t } = await rust.sendRequestAsync({ getTime: {} }); lastTime = t; const ti = timeInfo(t); timeStr = `${ti.isDay ? 'День' : 'Ночь'} ${ti.clock}`; } catch {}
      const members = ti.teamInfo.members || [];
      const jpg = await renderMap({
        map: mapCache.map, mapSize, members,
        markers: mk.mapMarkers.markers || [],
        title: serverInfo?.name || server.name || 'Rust',
        subtitle: [timeStr, serverInfo && `Онлайн ${serverInfo.players}/${serverInfo.maxPlayers}`].filter(Boolean).join('   •   '),
        monuments: mapCache.map.monuments || [],
      });
      const online = members.filter((x) => x.isOnline).length;
      const embed = card({
        title: '🗺️ Карта сервера',
        desc: members.map((x) => `${x.isOnline ? '🟢' : '⚫'} **${x.name}** — ${x.isAlive ? grid(x.x, x.y) : '💀 мёртв'}`).join('\n') || 'Пачка пустая',
        color: COLOR.ok, image: 'attachment://map.jpg',
      }).setFooter({ text: `Пачка онлайн: ${online}/${members.length} • запросил ${who}` });
      return { lines: ['🗺️ Карта отправлена в Discord'], files: [{ attachment: jpg, name: 'map.jpg' }], embeds: [embed] };
    }

    case 'time': case 'время': {
      needRust();
      const { time: t } = await rust.sendRequestAsync({ getTime: {} });
      lastTime = t;
      const ti = timeInfo(t);
      return { lines: [`${ti.isDay ? '☀️' : '🌙'} В игре **${ti.clock}** — до ${ti.isDay ? 'ночи' : 'утра'} ≈ **${ti.realMin} мин** (${ti.isDay ? 'закат' : 'рассвет'} в ${ti.edge})`],
               color: ti.isDay ? COLOR.gold : 0x34495e };
    }

    case 'timer': case 'таймер': {
      if (!args.length) return { lines: ['Пример: !timer 10m печь  ·  !timers — список  ·  !timer del 1'] };
      if (['del', 'удалить', 'stop', 'стоп'].includes(args[0].toLowerCase())) {
        const t = reminders.remove(args.slice(1).join(' '));
        return { lines: [t ? `🗑️ Таймер «${t.name}» удалён` : 'Не нашёл таймер. Список: !timers'] };
      }
      const r = reminders.add(args[0], args.slice(1).join(' '), who);
      if (r.error) return { lines: [`⚠️ ${r.error}`] };
      updateMenu();
      return { lines: [`⏰ Таймер #${r.timer.id} «${r.timer.name}» — через ${reminders.fmtLeft(r.ms)}`] };
    }

    case 'timers': case 'таймеры': {
      const list = reminders.all();
      if (!list.length) return { lines: ['Таймеров нет. Поставить: !timer 10m печь'] };
      return { lines: list.map((t) => `⏰ #${t.id} ${t.name} — через ${reminders.fmtLeft(t.at - Date.now())} (${t.who})`) };
    }

    case 'accounts': case 'аккаунты': {
      const list = accounts.all();
      if (!list.length) return { lines: ['Нет аккаунтов'] };
      return { lines: list.map((a) => {
        const d = accounts.daysLeft(a);
        const main = String(a.steamId) === String(server.RUST_PLAYER_ID) ? ' ⭐ основной' : '';
        return `${d <= 2 ? '⚠️' : '👤'} ${a.name} (${a.steamId}) — токен ещё ${d} дн.${main}`;
      }) };
    }

    case 'unlink': {
      const q = args.join(' ').toLowerCase();
      const a = accounts.all().find((x) => x.steamId === q || x.name.toLowerCase() === q);
      if (!a) return { lines: ['Не нашёл аккаунт. Список: !accounts'] };
      stopFcm(a.steamId);
      accounts.remove(a.steamId);
      return { lines: [`🗑️ Аккаунт ${a.name} удалён`] };
    }

    case 'name': case 'имя': {
      if (args.length !== 2) return { lines: ['Пример: !name свитч свет'] };
      const r = dev.rename(args[0], args[1]);
      if (!r.error) updatePanel();
      return { lines: [r.error ? `⚠️ ${r.error}` : `✏️ Теперь называется «${r.device.name}»`] };
    }

    case 'del': case 'удалить': {
      const d = dev.remove(args.join(' '));
      if (d) { switchState.delete(d.id); updatePanel(); }
      return { lines: [d ? `🗑️ «${d.name}» удалён из списка` : 'Не нашёл такое устройство'] };
    }
  }
  return null;
}

const CMD_TITLE = {
  help: '❓ Помощь', sw: '🎛️ Устройства', on: '🎛️ Переключатели', off: '🎛️ Переключатели', t: '🎛️ Переключатели', toggle: '🎛️ Переключатели',
  team: '👥 Пачка', leader: '👑 Лидер', time: '🕒 Время в игре', timer: '⏰ Таймер', timers: '⏰ Таймеры',
  accounts: '👤 Аккаунты', unlink: '👤 Аккаунты', name: '✏️ Переименование', del: '🗑️ Удаление', map: '🗺️ Карта',
};
const cmdKey = (text) => (text.slice(1).trim().split(/\s+/)[0] || '').toLowerCase();
const resultCard = (text, res) => card({ title: res.title || CMD_TITLE[cmdKey(text)], desc: res.lines.join('\n'), color: res.color || COLOR.info });

const plain = (s) => s.replace(/[🟢🔴⚫👑🚨⚠️✏️🗑️⏰☀️🌙🗺️]/gu, '').replace(/\s+/g, ' ').trim();


// ---------- пульт с кнопками ----------
const PANEL_FILE = path.join(process.cwd(), 'data', 'panel.json');
let panelMsgId = null;
try { panelMsgId = JSON.parse(fs.readFileSync(PANEL_FILE, 'utf8')).messageId || null; } catch {}
function savePanel() {
  fs.mkdirSync(path.dirname(PANEL_FILE), { recursive: true });
  fs.writeFileSync(PANEL_FILE, JSON.stringify({ messageId: panelMsgId }));
}

function buildPanel() {
  const switches = dev.byType(dev.TYPE.SWITCH).slice(0, 20);
  const alarms = dev.byType(dev.TYPE.ALARM);
  const lines = switches.map((d) => {
    const v = switchState.get(d.id);
    return `${v === true ? '🟢' : v === false ? '🔴' : '⚪'} **${d.name}** — ${stateText(v)}`;
  });
  if (alarms.length) lines.push('', ...alarms.map((d) => `🚨 ${d.name} — аларм`));
  if (!lines.length) lines.push('Нет устройств. В игре: смотри на Smart Switch → зажми **E** → **Pair**');

  const embed = card({
    title: '🎛️ Пульт базы',
    desc: lines.join('\n') + (rust ? '' : '\n\n⚠️ Бот сейчас не подключён к Rust+'),
    color: rust ? COLOR.ok : COLOR.muted,
  }).setFooter({ text: `Нажми кнопку, чтобы переключить • ${footer().text}` });

  const rows = [];
  for (let i = 0; i < switches.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(switches.slice(i, i + 5).map((d) => {
      const v = switchState.get(d.id);
      return new ButtonBuilder()
        .setCustomId(`sw:${d.id}`)
        .setLabel(d.name.slice(0, 80))
        .setStyle(v === true ? ButtonStyle.Success : v === false ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setDisabled(!rust);
    })));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('all:on').setLabel('Все ВКЛ').setEmoji('🟢').setStyle(ButtonStyle.Secondary).setDisabled(!rust || !switches.length),
    new ButtonBuilder().setCustomId('all:off').setLabel('Все ВЫКЛ').setEmoji('🔴').setStyle(ButtonStyle.Secondary).setDisabled(!rust || !switches.length),
    new ButtonBuilder().setCustomId('refresh').setLabel('Обновить').setEmoji('🔄').setStyle(ButtonStyle.Primary),
  ));
  return { embeds: [embed], components: rows };
}

// создать новый пульт (старый удаляется)
async function postPanel() {
  if (!channel) return;
  if (panelMsgId) {
    try { await (await channel.messages.fetch(panelMsgId)).delete(); } catch {}
  }
  const msg = await channel.send(buildPanel());
  panelMsgId = msg.id;
  savePanel();
}

// обновить существующий пульт (с небольшой задержкой, чтобы не дёргать Discord на каждое изменение)
let panelTimer = null;
function updatePanel() {
  if (!panelMsgId || !channel) return;
  clearTimeout(panelTimer);
  panelTimer = setTimeout(async () => {
    try {
      const msg = await channel.messages.fetch(panelMsgId);
      await msg.edit(buildPanel());
    } catch (e) {
      if (e.code === 10008) { panelMsgId = null; savePanel(); } // сообщение удалили
      else log('Пульт: не смог обновить:', e.message);
    }
  }, 800);
}

// ---------- главное меню (дашборд с кнопками) ----------
const MENU_FILE = path.join(process.cwd(), 'data', 'menu.json');
let menuMsgId = null;
try { menuMsgId = JSON.parse(fs.readFileSync(MENU_FILE, 'utf8')).messageId || null; } catch {}
function saveMenu() {
  fs.mkdirSync(path.dirname(MENU_FILE), { recursive: true });
  fs.writeFileSync(MENU_FILE, JSON.stringify({ messageId: menuMsgId }));
}

const btn = (id, label, emoji, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

function buildMenu() {
  const members = [...team.values()];
  const online = members.filter((m) => m.isOnline).length;
  const sw = dev.byType(dev.TYPE.SWITCH), al = dev.byType(dev.TYPE.ALARM);
  const swOn = sw.filter((d) => switchState.get(d.id) === true).length;
  const t = lastTime ? timeInfo(lastTime) : null;

  const embed = card({
    title: '🏠 Rust Bot — главное меню',
    desc: rust
      ? `🟢 **Подключён** к **${serverInfo?.name || server.name || 'серверу'}**`
      : '🔴 **Нет связи с Rust+** — жду подключения…',
    color: rust ? COLOR.ok : COLOR.muted,
    fields: [
      { name: '🌍 Сервер', value: serverInfo ? `${serverInfo.players}/${serverInfo.maxPlayers}${serverInfo.queuedPlayers ? ` (+${serverInfo.queuedPlayers} в очереди)` : ''}` : '—', inline: true },
      { name: '👥 Пачка', value: members.length ? `${online}/${members.length} онлайн` : '—', inline: true },
      { name: t?.isDay === false ? '🌙 Время' : '☀️ Время', value: t ? `${t.clock} • до ${t.isDay ? 'ночи' : 'утра'} ~${t.realMin} мин` : '—', inline: true },
      { name: '🎛️ Переключатели', value: sw.length ? `${swOn} вкл / ${sw.length}` : 'нет', inline: true },
      { name: '🚨 Алармы', value: al.length ? String(al.length) : 'нет', inline: true },
      { name: '⏰ Таймеры', value: String(reminders.all().length), inline: true },
    ],
  }).setFooter({ text: `${footer().text} • обновляется само` });

  const rows = [
    new ActionRowBuilder().addComponents(
      btn('m:map', 'Карта', '🗺️', ButtonStyle.Primary),
      btn('m:team', 'Пачка', '👥', ButtonStyle.Primary),
      btn('m:time', 'Время', '🕒', ButtonStyle.Primary),
      btn('m:panel', 'Пульт', '🎛️', ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(
      btn('m:timer', 'Таймер', '⏰'),
      btn('m:timers', 'Таймеры', '📋'),
      btn('m:devices', 'Устройства', '⚙️'),
      btn('m:accounts', 'Аккаунты', '👤'),
      btn('m:help', 'Помощь', '❓'),
    ),
  ];
  return { embeds: [embed], components: rows };
}

async function postMenu() {
  if (!channel) return;
  if (menuMsgId) { try { await (await channel.messages.fetch(menuMsgId)).delete(); } catch {} }
  const msg = await channel.send(buildMenu());
  menuMsgId = msg.id;
  saveMenu();
}

let menuTimer = null;
function updateMenu() {
  if (!menuMsgId || !channel) return;
  clearTimeout(menuTimer);
  menuTimer = setTimeout(async () => {
    try { await (await channel.messages.fetch(menuMsgId)).edit(buildMenu()); }
    catch (e) {
      if (e.code === 10008) { menuMsgId = null; saveMenu(); }
      else log('Меню: не смог обновить:', e.message);
    }
  }, 1500);
}

// статус бота в Discord + данные для меню (раз в минуту)
async function refreshStatus() {
  if (!rust) {
    discord.user?.setPresence({ status: 'idle', activities: [{ name: 'Нет связи с Rust+', type: ActivityType.Watching }] });
    updateMenu();
    return;
  }
  try { serverInfo = (await rust.sendRequestAsync({ getInfo: {} })).info; } catch {}
  try { lastTime = (await rust.sendRequestAsync({ getTime: {} })).time; } catch {}
  if (serverInfo) {
    discord.user?.setPresence({
      status: 'online',
      activities: [{ name: `Rust • ${serverInfo.players}/${serverInfo.maxPlayers}${lastTime ? ` • ${gameClock(lastTime)}` : ''}`, type: ActivityType.Playing }],
    });
  }
  updateMenu();
}

// ---------- кнопки, меню выбора, окна ввода ----------
const eph = (embed, extra = {}) => ({ embeds: [embed], flags: MessageFlags.Ephemeral, ...extra });

async function runAsCard(i, text, who, { update = false, extraComponents } = {}) {
  const res = await runCommand(text, who);
  const payload = res.files
    ? { embeds: res.embeds || [], files: res.files }
    : { embeds: [resultCard(text, res)] };
  if (extraComponents) payload.components = extraComponents;
  if (res.action && cfg.toTeamChat) toTeamChat(`[BOT] ${plain(res.action)}`);
  if (update) return i.update(payload);
  if (i.deferred || i.replied) return i.editReply(payload);
  return i.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

function devicePicker() {
  const list = dev.all().filter((d) => d.type !== dev.TYPE.STORAGE).slice(0, 25);
  if (!list.length) return [];
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId('dev_pick').setPlaceholder('Выбери устройство…')
    .addOptions(list.map((d) => ({
      label: d.name.slice(0, 100), value: String(d.id),
      emoji: d.type === dev.TYPE.ALARM ? '🚨' : switchState.get(d.id) ? '🟢' : '🔴',
      description: d.type === dev.TYPE.ALARM ? 'Smart Alarm' : 'Smart Switch',
    }))))];
}

function deviceCard(d) {
  const v = switchState.get(d.id);
  const owner = d.owner ? (accounts.get(d.owner)?.name || d.owner) : '—';
  const embed = card({
    title: `${d.type === dev.TYPE.ALARM ? '🚨' : '🎛️'} ${d.name}`,
    color: d.type === dev.TYPE.ALARM ? COLOR.bad : v ? COLOR.ok : COLOR.muted,
    fields: [
      { name: 'Тип', value: d.type === dev.TYPE.ALARM ? 'Smart Alarm' : 'Smart Switch', inline: true },
      ...(d.type === dev.TYPE.SWITCH ? [{ name: 'Состояние', value: stateText(v), inline: true }] : []),
      { name: 'Привязал', value: owner, inline: true },
    ],
  });
  const buttons = [];
  if (d.type === dev.TYPE.SWITCH) buttons.push(btn(`dev_tog:${d.id}`, v ? 'Выключить' : 'Включить', v ? '🔴' : '🟢', v ? ButtonStyle.Danger : ButtonStyle.Success));
  buttons.push(btn(`dev_ren:${d.id}`, 'Переименовать', '✏️'), btn(`dev_del:${d.id}`, 'Удалить', '🗑️', ButtonStyle.Danger));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons), ...devicePicker()] };
}

function timerList() {
  const list = reminders.all();
  const embed = card({
    title: '⏰ Таймеры',
    desc: list.length ? list.map((t) => `**#${t.id} ${t.name}** — через ${reminders.fmtLeft(t.at - Date.now())} • ${t.who}`).join('\n') : 'Таймеров нет',
    color: COLOR.gold,
  });
  const components = [new ActionRowBuilder().addComponents(btn('m:timer', 'Новый таймер', '➕', ButtonStyle.Success))];
  if (list.length) components.unshift(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId('timer_del').setPlaceholder('🗑️ Удалить таймер…')
    .addOptions(list.slice(0, 25).map((t) => ({ label: `#${t.id} ${t.name}`.slice(0, 100), value: String(t.id), description: `через ${reminders.fmtLeft(t.at - Date.now())}` })))));
  return { embeds: [embed], components };
}

async function handlePanelButton(i, who) {
  await i.deferUpdate();
  if (i.customId === 'refresh') {
    if (rust) for (const d of dev.byType(dev.TYPE.SWITCH)) { try { await refreshDevice(d); } catch {} }
    return;
  }
  if (!rust) return;
  let targets, value = null;
  if (i.customId.startsWith('all:')) {
    targets = dev.byType(dev.TYPE.SWITCH);
    value = i.customId === 'all:on';
  } else {
    const d = dev.get(Number(i.customId.slice(3)));
    if (!d) return i.followUp(eph(card({ desc: 'Этого переключателя больше нет', color: COLOR.warn })));
    targets = [d];
  }
  const done = [];
  for (const d of targets) {
    try {
      const v = value ?? !(switchState.has(d.id) ? switchState.get(d.id) : await refreshDevice(d));
      await setSwitch(d, v);
      done.push(`${d.name} ${stateText(v)}`);
    } catch (e) {
      await i.followUp(eph(card({ desc: `⚠️ ${d.name}: ${errText(e)}`, color: COLOR.warn })));
    }
    if (targets.length > 1) await new Promise((r) => setTimeout(r, 400));
  }
  if (done.length && cfg.toTeamChat) toTeamChat(`[BOT] ${who}: ${done.join(', ')}`);
}

const LINK_GUIDE = [
  '**1.** Поставь [Node.js](https://nodejs.org) (LTS) и Google Chrome',
  '**2.** Win+R → `cmd` → вставь:\n`npx @liamcottle/rustplus.js fcm-register --config-file rust-account.json`',
  '**3.** В открывшемся Chrome войди через Steam',
  '**4.** Напиши боту **в личку** `!link` и приложи файл `rust-account.json`',
  '**5.** В игре: Esc → Rust+ → **Pair with server**',
  '',
  '⚠️ Файл — ключ к твоему Rust+. Только в личку боту!',
].join('\n');

discord.on('interactionCreate', async (i) => {
  const who = i.member?.displayName || i.user.username;
  try {
    // --- окна ввода ---
    if (i.isModalSubmit()) {
      if (i.customId === 'timer_modal') {
        const dur = i.fields.getTextInputValue('dur').replace(/\s+/g, '');
        const name = i.fields.getTextInputValue('name').trim() || 'таймер';
        await runAsCard(i, `!timer ${dur} ${name}`, who);
        return updateMenu();
      }
      if (i.customId.startsWith('dev_ren_modal:')) {
        const id = i.customId.split(':')[1];
        const newName = i.fields.getTextInputValue('name').trim().replace(/\s+/g, '_');
        const r = dev.rename(id, newName);
        if (!r.error) updatePanel();
        const d = dev.get(Number(id));
        if (r.error || !d) return i.reply(eph(card({ desc: `⚠️ ${r.error || 'Устройство пропало'}`, color: COLOR.warn })));
        return i.isFromMessage() ? i.update(deviceCard(d)) : i.reply({ ...deviceCard(d), flags: MessageFlags.Ephemeral });
      }
      return;
    }

    // --- выпадающие списки ---
    if (i.isStringSelectMenu()) {
      if (i.customId === 'dev_pick') {
        const d = dev.get(Number(i.values[0]));
        if (!d) return i.update({ embeds: [card({ desc: 'Устройство пропало', color: COLOR.warn })], components: devicePicker() });
        if (rust) { try { await refreshDevice(d); } catch {} }
        return i.update(deviceCard(dev.get(d.id)));
      }
      if (i.customId === 'timer_del') {
        reminders.remove(i.values[0]);
        updateMenu();
        return i.update(timerList());
      }
      if (i.customId === 'leader_pick') {
        return runAsCard(i, `!leader ${i.values[0]}`, who, { update: true, extraComponents: [] });
      }
      return;
    }

    if (!i.isButton()) return;
    const id = i.customId;

    // --- пульт ---
    if (id.startsWith('sw:') || id.startsWith('all:') || id === 'refresh') {
      await handlePanelButton(i, who);
      return updatePanel();
    }

    // --- устройства ---
    if (id.startsWith('dev_tog:')) {
      const d = dev.get(Number(id.split(':')[1]));
      if (!d) return i.update({ embeds: [card({ desc: 'Устройство пропало', color: COLOR.warn })], components: devicePicker() });
      try {
        const v = !(switchState.has(d.id) ? switchState.get(d.id) : await refreshDevice(d));
        await setSwitch(d, v);
        if (cfg.toTeamChat) toTeamChat(`[BOT] ${who}: ${d.name} ${stateText(v)}`);
      } catch (e) { return i.reply(eph(card({ desc: `⚠️ ${errText(e)}`, color: COLOR.warn }))); }
      return i.update(deviceCard(dev.get(d.id)));
    }
    if (id.startsWith('dev_ren:')) {
      const d = dev.get(Number(id.split(':')[1]));
      if (!d) return i.reply(eph(card({ desc: 'Устройство пропало', color: COLOR.warn })));
      return i.showModal(new ModalBuilder().setCustomId(`dev_ren_modal:${d.id}`).setTitle('Переименовать устройство')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('name').setLabel('Новое имя (одно слово)').setStyle(TextInputStyle.Short)
          .setValue(d.name).setMaxLength(30).setRequired(true))));
    }
    if (id.startsWith('dev_del:')) {
      const d = dev.remove(id.split(':')[1]);
      if (d) { switchState.delete(d.id); updatePanel(); updateMenu(); }
      return i.update({ embeds: [card({ title: '🗑️ Удалено', desc: d ? `«${d.name}» удалён из списка` : 'Уже удалено', color: COLOR.muted })], components: devicePicker() });
    }

    // --- главное меню ---
    switch (id) {
      case 'm:map':
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        return runAsCard(i, '!map', who);
      case 'm:time':
        return runAsCard(i, '!time', who);
      case 'm:team': {
        if (!rust) return i.reply(eph(card({ desc: '⚠️ Бот сейчас не подключён к Rust+', color: COLOR.warn })));
        const res = await rust.sendRequestAsync({ getTeamInfo: {} });
        const members = res.teamInfo.members || [];
        const leader = String(res.teamInfo.leaderSteamId);
        const embed = card({
          title: '👥 Пачка',
          desc: members.map((m) => `${m.isOnline ? '🟢' : '⚫'} **${m.name}**${String(m.steamId) === leader ? ' 👑' : ''} — ${m.isAlive ? `📍 ${grid(m.x, m.y)}` : '💀 мёртв'}`).join('\n') || 'Пачка пустая',
          color: COLOR.info,
        }).setFooter({ text: `Онлайн: ${members.filter((m) => m.isOnline).length}/${members.length} • ${footer().text}` });
        const components = [];
        if (leader === String(server.RUST_PLAYER_ID) && members.length > 1) {
          components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
            .setCustomId('leader_pick').setPlaceholder('👑 Передать лидерство…')
            .addOptions(members.filter((m) => String(m.steamId) !== leader).slice(0, 25).map((m) => ({ label: m.name.slice(0, 100), value: m.name.slice(0, 100) })))));
        }
        return i.reply(eph(embed, { components }));
      }
      case 'm:panel':
        await postPanel();
        return i.reply(eph(card({ desc: '🎛️ Пульт отправлен в канал ⬇️', color: COLOR.ok })));
      case 'm:timer':
        return i.showModal(new ModalBuilder().setCustomId('timer_modal').setTitle('Новый таймер').addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dur').setLabel('Через сколько (10m, 1h30m, 45s)')
            .setStyle(TextInputStyle.Short).setPlaceholder('10m').setRequired(true).setMaxLength(20)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Название')
            .setStyle(TextInputStyle.Short).setPlaceholder('печь').setRequired(false).setMaxLength(60)),
        ));
      case 'm:timers':
        return i.reply({ ...timerList(), flags: MessageFlags.Ephemeral });
      case 'm:devices': {
        const picker = devicePicker();
        const list = dev.all().filter((d) => d.type !== dev.TYPE.STORAGE);
        return i.reply(eph(card({
          title: '⚙️ Устройства',
          desc: list.length
            ? list.map((d) => `${d.type === dev.TYPE.ALARM ? '🚨' : switchState.get(d.id) ? '🟢' : '🔴'} **${d.name}**`).join('\n') + '\n\nВыбери устройство ниже, чтобы переключить, переименовать или удалить.'
            : 'Нет устройств.\nВ игре: смотри на Smart Switch / Smart Alarm → зажми **E** → **Pair**',
          color: COLOR.info,
        }), { components: picker }));
      }
      case 'm:accounts': {
        const res = await runCommand('!accounts', who);
        return i.reply(eph(resultCard('!accounts', res), {
          components: [new ActionRowBuilder().addComponents(btn('m:linkhelp', 'Как добавить свой аккаунт', '➕', ButtonStyle.Success))],
        }));
      }
      case 'm:linkhelp':
        return i.reply(eph(card({ title: '➕ Добавить свой Rust+ аккаунт', desc: LINK_GUIDE, color: COLOR.ok })));
      case 'm:help':
        return runAsCard(i, '!help', who);
    }
  } catch (e) {
    log('Кнопка: ошибка:', e?.stack || e?.message || e);
    const payload = eph(card({ desc: `⚠️ ${errText(e)}`, color: COLOR.warn }));
    try { (i.deferred || i.replied) ? await i.editReply(payload) : await i.reply(payload); } catch {}
  }
});

// ---------- аккаунты: FCM и !link ----------
const fcmClients = new Map(); // steamId -> PushReceiverClient
function runFcm(acc) {
  stopFcm(acc.steamId);
  fcmClients.set(acc.steamId, startFcm(acc, onPairing, log));
}
function stopFcm(steamId) {
  const c = fcmClients.get(steamId);
  if (c) { try { c.destroy(); } catch {} fcmClients.delete(steamId); }
}

async function handleLink(m) {
  const file = m.attachments.first();
  const inGuild = !!m.guild;
  if (inGuild) m.delete().catch(() => {}); // файл с ключами — убираем из канала
  const reply = (text) => (inGuild ? m.channel.send(`<@${m.author.id}> ${text}`) : m.reply(text)).catch(() => {});
  if (!file) {
    return reply([
      'Как добавить свой аккаунт:',
      '1. Поставь Node.js (nodejs.org) и Google Chrome',
      '2. В cmd: `npx @liamcottle/rustplus.js fcm-register --config-file rust-account.json`',
      '3. Войди через Steam в открывшемся Chrome',
      '4. Пришли мне **в личку** файл `rust-account.json` с текстом `!link`',
    ].join('\n'));
  }
  try {
    const res = await fetch(file.url);
    const config = JSON.parse(await res.text());
    const name = m.member?.displayName || m.author.globalName || m.author.username;
    const r = accounts.put(config, name);
    if (r.error) return reply(`⚠️ Не подошёл файл: ${r.error}`);
    runFcm(r.account);
    log(`Добавлен аккаунт ${r.account.name} (${r.account.steamId})`);
    // если бот ещё ни разу не подключился (не было токена) — пробуем сейчас
    if (!rust && !currentClient) setTimeout(connectRust, 1000);
    reply(`✅ Аккаунт **${r.account.name}** добавлен, токен живёт ещё ${accounts.daysLeft(r.account)} дн.\n` +
          'Теперь зайди на сервер → Esc → Rust+ → **Pair with server**. После этого можешь привязывать переключатели (E → Pair).');
    toDiscord(`👤 **${r.account.name}** ${r.isNew ? 'добавил' : 'обновил'} свой Rust+ аккаунт`, 0x3498db);
  } catch (e) {
    reply(`⚠️ Не смог прочитать файл: ${e.message}`);
  }
}

function checkExpiry() {
  for (const a of accounts.all()) {
    const d = accounts.daysLeft(a);
    if (d <= 2) toDiscord(`⚠️ Rust+ токен аккаунта **${a.name}** ${d < 0 ? 'истёк' : `истекает через ${d} дн.`} — обнови: \`npm run register\` (или новый файл через \`!link\`)`, 0xe67e22);
  }
}

// ---------- мост чата ----------
async function onTeamMessage(msg) {
  const text = msg.message;
  // пропускаем то, что отправил сам бот
  const t = sentEcho.get(text);
  if (t && Date.now() - t < 60000) { sentEcho.delete(text); return; }
  chatToDiscord(msg.name, text);

  if (text.startsWith('!')) {
    try {
      const res = await runCommand(text, msg.name);
      if (res) {
        res.lines.forEach((l) => toTeamChat(`[BOT] ${plain(l)}`));
        if (res.files && channel) channel.send({ embeds: res.embeds || [], files: res.files }).catch((e) => log('Discord файл:', e.message));
        else if (!res.silentDiscord && channel) channel.send({ embeds: [resultCard(text, res)] }).catch(() => {});
      }
    } catch (e) { toTeamChat(`[BOT] Ошибка: ${errText(e)}`); }
  }
}

discord.on('messageCreate', async (m) => {
  if (m.author.bot) return;
  const cmd0 = (m.content || '').trim().split(/\s+/)[0].toLowerCase();
  if (cmd0 === '!link' && (!m.guild || m.channelId === cfg.channelId)) return handleLink(m);
  if (!m.guild) {
    if (m.content) m.reply('В личке я понимаю только `!link` (с файлом аккаунта). Остальные команды — в канале бота.').catch(() => {});
    return;
  }
  if (m.channelId !== cfg.channelId || !m.content) return;
  if (m.content.startsWith('!')) log(`Команда из Discord от ${m.author.username}: ${m.content}`);
  const name = m.member?.displayName || m.author.username;

  if (m.content.startsWith('!')) {
    try {
      const res = await runCommand(m.content, name);
      if (res) {
        if (res.silentDiscord) { m.delete().catch(() => {}); return; }
        if (res.files) {
          await m.reply({ embeds: res.embeds || [], files: res.files, allowedMentions: { parse: [] } });
          return;
        }
        await m.reply({ embeds: [resultCard(m.content, res)], allowedMentions: { parse: [] } });
        if (res.action && cfg.toTeamChat) toTeamChat(`[BOT] ${plain(res.action)}`);
        return;
      }
    } catch (e) {
      log('Ошибка команды:', e?.stack || errText(e));
      return m.reply({ embeds: [card({ desc: `⚠️ ${errText(e)}`, color: COLOR.warn })] }).catch((e2) => log('Не смог ответить в Discord:', e2.message));
    }
  }

  if (!rust) return m.react('⚠️').catch(() => {});
  toTeamChat(`[DS] ${name}: ${m.content.replace(/\s+/g, ' ')}`);
});

// ---------- подключение к Rust+ ----------
let currentClient = null;
let mapCache = null; // { sid, map } — картинка карты не меняется до вайпа

function switchServer(body, who) {
  server = {
    RUST_SERVER_ID: body.id,
    RUST_PLAYER_ID: body.playerId,
    RUST_PLAYER_TOKEN: body.playerToken,
    RUST_IP: body.ip || '',
    RUST_PORT: body.port || '',
    name: body.name,
  };
  fs.mkdirSync(path.dirname(SERVER_FILE), { recursive: true });
  fs.writeFileSync(SERVER_FILE, JSON.stringify(server, null, 2));
  toDiscord(`🔄 ${who ? `**${who}** привязал` : 'Привязан'} сервер **${body.name}** — переключаюсь на него...`, 0x3498db);
  log(`Переключаюсь на сервер ${body.name} (${body.id})`);

  // отключаемся от старого сервера и сразу подключаемся к новому
  timers.forEach(clearInterval);
  timers = [];
  rust = null;
  markers = null;
  team = new Map();
  switchState.clear();
  closePool();
  if (currentClient) {
    currentClient.switching = true;
    try { currentClient.disconnect(); } catch {}
  }
  connectRust();
}

function connectRust() {
  if (!server.RUST_PLAYER_ID || !server.RUST_PLAYER_TOKEN || (!server.RUST_SERVER_ID && !server.RUST_IP)) {
    log('Жду привязку сервера (Rust+ → Pair with server в игре)');
    return;
  }
  dev.setServer(server.RUST_SERVER_ID || `${server.RUST_IP}_${server.RUST_PORT}`);
  let r, label;
  try {
    ({ client: r, label } = createRustClient(server, accounts.authToken(server.RUST_PLAYER_ID)));
  } catch (e) {
    log(e.message);
    toDiscord(`⚠️ ${e.message}`);
    return;
  }
  log(`Подключаюсь к Rust+ (${label})...`);

  r.on('connected', async () => {
    rust = r;
    log('Rust+ подключён');
    try {
      const info = await r.sendRequestAsync({ getInfo: {} });
      mapSize = info.info.mapSize;
      serverInfo = info.info;
      const ti = await r.sendRequestAsync({ getTeamInfo: {} });
      processTeam(ti.teamInfo, true);
      await pollEvents();
      await subscribeAll();
      updatePanel();
      toDiscord(`✅ Подключился к **${info.info.name}** — онлайн ${info.info.players}/${info.info.maxPlayers}, в пачке ${team.size} чел., устройств ${dev.all().length}`, 0x2ecc71);
      if (!menuMsgId) await postMenu().catch((e) => log('Меню:', e.message));
    } catch (e) {
      log('Ошибка при старте:', e.message || e);
      toDiscord('⚠️ Подключился, но сервер не отдал данные. Проверь playerToken (мог смениться после вайпа — сделай Pair заново).');
    }
    timers.push(setInterval(pollTeam, cfg.teamPoll));
    timers.push(setInterval(pollEvents, cfg.eventsPoll));
    timers.push(setInterval(refreshStatus, 60000));
    refreshStatus();
  });

  r.on('message', (message) => {
    const b = message.broadcast;
    if (!b) return;
    if (b.teamMessage) onTeamMessage(b.teamMessage.message);
    if (b.teamChanged) processTeam(b.teamChanged.teamInfo);
    if (b.entityChanged) onEntityChanged(b.entityChanged);
  });

  r.on('error', (e) => log('Rust+ ошибка:', e.message || e));

  currentClient = r;
  r.on('disconnected', () => {
    if (r.switching) return; // переключаемся на другой сервер — переподключение сделает switchServer
    if (rust === r) toDiscord('🔌 Отключился от Rust+, переподключаюсь через 20 сек...', 0x95a5a6);
    log('Rust+ отключён');
    rust = null;
    markers = null;
    closePool();
    updatePanel();
    refreshStatus();
    timers.forEach(clearInterval);
    timers = [];
    setTimeout(connectRust, 20000);
  });

  r.connect();
}

discord.once('clientReady', async () => {
  log(`Discord: вошёл как ${discord.user.tag}`);
  try {
    channel = await discord.channels.fetch(cfg.channelId);
  } catch {
    console.error('Не нашёл канал DISCORD_CHANNEL_ID — проверь ID и что бот добавлен на сервер');
    process.exit(1);
  }
  reminders.init((t) => {
    notify(`⏰ **Таймер «${t.name}»** — время вышло! (поставил ${t.who})`,
           `[BOT] ТАЙМЕР «${t.name}» — время вышло! (${t.who})`, 0xf1c40f);
    updateMenu();
  });
  refreshStatus();
  accounts.load();
  for (const a of accounts.all()) runFcm(a);
  if (!accounts.all().length) log('Нет ни одного Rust+ аккаунта — выполни npm run register');
  connectRust();
  checkExpiry();
  setInterval(checkExpiry, 12 * 3600 * 1000);
});

process.on('unhandledRejection', (e) => log('unhandledRejection:', e?.stack || e?.message || e));
process.on('uncaughtException', (e) => log('uncaughtException:', e?.stack || e?.message || e));
discord.login(cfg.discordToken);
