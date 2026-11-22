require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createRustClient } = require('./relay');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const accounts = require('./accounts');

const { toGrid } = require('./grid');
const dev = require('./switches');
const { startFcm } = require('./fcm');

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

async function toDiscord(text, color) {
  if (!channel) return;
  try {
    if (color) {
      await channel.send({ embeds: [new EmbedBuilder().setDescription(text).setColor(color).setTimestamp()] });
    } else {
      await channel.send({ content: text, allowedMentions: { parse: [] } });
    }
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
  team = next;
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
      return { lines: HELP };

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

const plain = (s) => s.replace(/[🟢🔴⚫👑🚨⚠️✏️🗑️]/gu, '').replace(/\s+/g, ' ').trim();


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

  const embed = new EmbedBuilder()
    .setTitle('🎛️ Пульт базы')
    .setDescription(lines.join('\n') + (rust ? '' : '\n\n⚠️ Бот сейчас не подключён к Rust+'))
    .setColor(rust ? 0x2ecc71 : 0x95a5a6)
    .setFooter({ text: 'Нажми кнопку, чтобы переключить' })
    .setTimestamp();

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

discord.on('interactionCreate', async (i) => {
  if (!i.isButton()) return;
  const who = i.member?.displayName || i.user.username;
  try {
    await i.deferUpdate();
    if (i.customId === 'refresh') {
      if (rust) for (const d of dev.byType(dev.TYPE.SWITCH)) { try { await refreshDevice(d); } catch {} }
    } else {
      if (!rust) return;
      let targets, value = null;
      if (i.customId.startsWith('all:')) {
        targets = dev.byType(dev.TYPE.SWITCH);
        value = i.customId === 'all:on';
      } else {
        const d = dev.get(Number(i.customId.slice(3)));
        if (!d) return i.followUp({ content: 'Этого переключателя больше нет', flags: MessageFlags.Ephemeral });
        targets = [d];
      }
      const done = [];
      for (const d of targets) {
        try {
          const v = value ?? !(switchState.has(d.id) ? switchState.get(d.id) : await refreshDevice(d));
          await setSwitch(d, v);
          done.push(`${d.name} ${stateText(v)}`);
        } catch (e) {
          await i.followUp({ content: `⚠️ ${d.name}: ${errText(e)}`, flags: MessageFlags.Ephemeral });
        }
        if (targets.length > 1) await new Promise((r) => setTimeout(r, 400));
      }
      if (done.length && cfg.toTeamChat) toTeamChat(`[BOT] ${who}: ${done.join(', ')}`);
    }
  } catch (e) {
    log('Кнопка: ошибка:', e.message || e);
  }
  updatePanel();
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
  toDiscord(`💬 **${msg.name}**: ${text}`);

  if (text.startsWith('!')) {
    try {
      const res = await runCommand(text, msg.name);
      if (res) {
        res.lines.forEach((l) => toTeamChat(`[BOT] ${plain(l)}`));
        if (!res.silentDiscord) toDiscord(res.lines.join('\n'));
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
        await m.reply({ content: res.lines.join('\n'), allowedMentions: { parse: [] } });
        if (res.action && cfg.toTeamChat) toTeamChat(`[BOT] ${plain(res.action)}`);
        return;
      }
    } catch (e) {
      log('Ошибка команды:', e?.stack || errText(e));
      return m.reply(`⚠️ ${errText(e)}`).catch((e2) => log('Не смог ответить в Discord:', e2.message));
    }
  }

  if (!rust) return m.react('⚠️').catch(() => {});
  toTeamChat(`[DS] ${name}: ${m.content.replace(/\s+/g, ' ')}`);
});

// ---------- подключение к Rust+ ----------
let currentClient = null;

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
      const ti = await r.sendRequestAsync({ getTeamInfo: {} });
      processTeam(ti.teamInfo, true);
      await pollEvents();
      await subscribeAll();
      updatePanel();
      toDiscord(`✅ Подключился к **${info.info.name}** — онлайн ${info.info.players}/${info.info.maxPlayers}, в пачке ${team.size} чел., устройств ${dev.all().length}. Команды: \`!help\``, 0x2ecc71);
    } catch (e) {
      log('Ошибка при старте:', e.message || e);
      toDiscord('⚠️ Подключился, но сервер не отдал данные. Проверь playerToken (мог смениться после вайпа — сделай Pair заново).');
    }
    timers.push(setInterval(pollTeam, cfg.teamPoll));
    timers.push(setInterval(pollEvents, cfg.eventsPoll));
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
