require('dotenv').config();
const { createRustClient } = require('./relay');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { toGrid } = require('./grid');

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
const required = ['discordToken', 'channelId', 'playerId', 'playerToken'];
if (!process.env.RUST_SERVER_ID) required.push('ip', 'port');
for (const k of required) {
  if (!cfg[k]) { console.error(`Не заполнено в .env: ${k}`); process.exit(1); }
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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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

// ---------- мост чата ----------
function onTeamMessage(msg) {
  const text = msg.message;
  // пропускаем то, что отправил сам бот
  const t = sentEcho.get(text);
  if (t && Date.now() - t < 60000) { sentEcho.delete(text); return; }
  toDiscord(`💬 **${msg.name}**: ${text}`);
}

discord.on('messageCreate', (m) => {
  if (m.author.bot || m.channelId !== cfg.channelId || !m.content) return;
  if (!rust) return m.react('⚠️').catch(() => {});
  const name = m.member?.displayName || m.author.username;
  toTeamChat(`[DS] ${name}: ${m.content.replace(/\s+/g, ' ')}`);
});

// ---------- подключение к Rust+ ----------
function connectRust() {
  let r, label;
  try {
    ({ client: r, label } = createRustClient(process.env));
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
      toDiscord(`✅ Подключился к **${info.info.name}** — онлайн ${info.info.players}/${info.info.maxPlayers}, в пачке ${team.size} чел.`, 0x2ecc71);
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
  });

  r.on('error', (e) => log('Rust+ ошибка:', e.message || e));

  r.on('disconnected', () => {
    if (rust === r) toDiscord('🔌 Отключился от Rust+, переподключаюсь через 20 сек...', 0x95a5a6);
    log('Rust+ отключён');
    rust = null;
    markers = null;
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
  connectRust();
});

process.on('unhandledRejection', (e) => log('unhandledRejection:', e?.message || e));
discord.login(cfg.discordToken);
