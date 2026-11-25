// Настройки бота, которые меняются из Discord (кнопка ⚙️ Настройки). Хранятся в data/settings.json
const path = require('path');
const store = require('./store');

const FILE = path.join(store.DATA, 'settings.json');

const EVENT_TYPES = {
  cargo: '🚢 Карго',
  heli: '🚁 Патрульный вертолёт',
  ch47: '🚁 Чинук',
  crate: '📦 Запертый ящик',
  explosion: '💥 Взрыв (сбит heli/Брэдли)',
};

const DEFAULTS = {
  notifyDeaths: true,     // 💀 смерти пачки
  notifyOnline: true,     // 🟢/⚫ зашёл/вышел
  notifyTeam: true,       // ➕/➖ вступил/покинул команду
  notifyEvents: true,     // ивенты карты (общий выключатель)
  events: Object.keys(EVENT_TYPES), // какие именно ивенты
  toTeamChat: (process.env.POST_TO_TEAMCHAT || 'true') === 'true', // дублировать уведомления в тим-чат
  bridgeToDiscord: true,  // тим-чат → Discord
  bridgeToGame: true,     // Discord → тим-чат
  alarmPing: true,        // @everyone при срабатывании аларма
  notifyTracker: true,    // 🎯 уведомления слежки (враг зашёл/вышел)
  accessRole: (process.env.ACCESS_ROLE || '').trim(), // роль с доступом (ID или название)
  publicButtons: true,    // обычными кнопками (пульт, карта, время, пачка, таймеры) могут пользоваться все
};

let data = { ...DEFAULTS, ...store.read(FILE, {}) };

const get = () => data;
function set(patch) {
  data = { ...data, ...patch };
  store.write(FILE, data);
  return data;
}
function toggle(key) {
  if (typeof DEFAULTS[key] !== 'boolean') return data;
  return set({ [key]: !data[key] });
}

module.exports = { get, set, toggle, EVENT_TYPES, DEFAULTS };
