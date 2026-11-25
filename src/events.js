// 📅 Сборы (/вайп): карточки с записью ✅ ❌ ❓, напоминания и пинг опоздавших.
const path = require('path');
const store = require('./store');

const FILE = path.join(store.DATA, 'events.json');
let data = { nextId: 1, list: [], ...store.read(FILE, {}) };
const save = () => store.write(FILE, data);

// ---------- часовые пояса ----------
const TZ_ALIASES = {
  'мск': 'Europe/Moscow', 'москва': 'Europe/Moscow', 'msk': 'Europe/Moscow',
  'тбилиси': 'Asia/Tbilisi', 'грузия': 'Asia/Tbilisi', 'тби': 'Asia/Tbilisi',
  'киев': 'Europe/Kyiv', 'украина': 'Europe/Kyiv', 'минск': 'Europe/Minsk', 'беларусь': 'Europe/Minsk',
  'берлин': 'Europe/Berlin', 'европа': 'Europe/Berlin', 'cet': 'Europe/Berlin',
  'лондон': 'Europe/London', 'utc': 'UTC', 'gmt': 'UTC',
  'екб': 'Asia/Yekaterinburg', 'екатеринбург': 'Asia/Yekaterinburg', 'новосибирск': 'Asia/Novosibirsk',
  'алматы': 'Asia/Almaty', 'казахстан': 'Asia/Almaty', 'баку': 'Asia/Baku', 'ереван': 'Asia/Yerevan',
};

function resolveTz(input, fallback) {
  const t = String(input || '').trim().toLowerCase();
  if (!t) return fallback;
  if (TZ_ALIASES[t]) return TZ_ALIASES[t];
  const m = t.match(/^(?:utc|gmt|мск)?\s*([+-])\s*(\d{1,2})$/);
  if (m) {
    const n = Number(m[2]);
    if (t.startsWith('мск')) { // "мск+1" → UTC+4
      const total = 3 + (m[1] === '+' ? n : -n);
      return total === 0 ? 'UTC' : `Etc/GMT${total > 0 ? '-' : '+'}${Math.abs(total)}`;
    }
    return n === 0 ? 'UTC' : `Etc/GMT${m[1] === '+' ? '-' : '+'}${n}`; // у Etc/GMT знак наоборот
  }
  try { new Intl.DateTimeFormat('en', { timeZone: input }); return input; } catch { return null; }
}

// смещение пояса в мс для момента ts
function tzOffset(ts, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}
// локальное время в поясе tz → UTC ms
function zoned(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  let ts = guess - tzOffset(guess, tz);
  ts = guess - tzOffset(ts, tz); // поправка на переход времени
  return ts;
}
// сегодняшняя дата в поясе tz
function todayIn(tz, now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
    .formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { y: +p.year, mo: +p.month - 1, d: +p.day, wd };
}

const WEEKDAYS = { 'вс': 0, 'воскресенье': 0, 'пн': 1, 'понедельник': 1, 'вт': 2, 'вторник': 2, 'ср': 3, 'среда': 3, 'среду': 3,
  'чт': 4, 'четверг': 4, 'пт': 5, 'пятница': 5, 'пятницу': 5, 'сб': 6, 'суббота': 6, 'субботу': 6 };

/**
 * Разбор времени: «19:00», «завтра 19:00», «29.11 19:00», «29.11.2026 19:00-21:00», «пт 20:00», «через 2ч 30м».
 * Возвращает { start, end } (UTC ms) или { error }.
 */
function parseWhen(text, tz, now = Date.now()) {
  let s = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*в\s+(?=\d)/g, ' ');
  if (!s) return { error: 'Укажи время' };

  const rel = s.match(/^через\s+(.+)$/);
  if (rel) {
    let ms = 0, ok = false;
    for (const m of rel[1].matchAll(/(\d+(?:[.,]\d+)?)\s*(ч|час|часа|часов|h|м|мин|минут|минуты|m|д|дн|дня|дней|d)/g)) {
      const n = parseFloat(m[1].replace(',', '.'));
      ms += /^(ч|h)/.test(m[2]) ? n * 3600000 : /^(д|d)/.test(m[2]) ? n * 86400000 : n * 60000;
      ok = true;
    }
    if (!ok) return { error: 'Не понял «через …». Пример: через 2ч 30м' };
    return { start: Math.round(now + ms), end: null };
  }

  const tm = s.match(/(\d{1,2})[:.](\d{2})(?:\s*[-–—]\s*(\d{1,2})[:.](\d{2}))?\s*$/);
  if (!tm) return { error: 'Не понял время. Примеры: «завтра 19:00», «29.11 19:00-21:00», «пт 20:00», «через 2ч»' };
  const [h, mi] = [+tm[1], +tm[2]];
  if (h > 23 || mi > 59) return { error: 'Неверное время' };
  const datePart = s.slice(0, tm.index).trim();

  const today = todayIn(tz, now);
  let y = today.y, mo = today.mo, d = today.d, explicitDay = false;
  let dm;
  if (!datePart || datePart === 'сегодня') { /* сегодня (или завтра, если время прошло) */ }
  else if (datePart === 'завтра') { d += 1; explicitDay = true; }
  else if (datePart === 'послезавтра') { d += 2; explicitDay = true; }
  else if ((dm = datePart.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/))) {
    d = +dm[1]; mo = +dm[2] - 1; explicitDay = true;
    if (dm[3]) y = dm[3].length === 2 ? 2000 + +dm[3] : +dm[3];
    else if (zoned(y, mo, d, h, mi, tz) < now - 3600000) y += 1; // дата уже прошла — значит в следующем году
  } else if (WEEKDAYS[datePart] !== undefined) {
    let add = (WEEKDAYS[datePart] - today.wd + 7) % 7;
    if (add === 0 && zoned(y, mo, d, h, mi, tz) <= now) add = 7;
    d += add; explicitDay = true;
  } else {
    return { error: `Не понял дату «${datePart}». Можно: сегодня, завтра, пт, 29.11` };
  }

  let start = zoned(y, mo, d, h, mi, tz);
  if (!explicitDay && start <= now) start = zoned(y, mo, d + 1, h, mi, tz); // «19:00», а уже 20:00 → завтра
  let end = null;
  if (tm[3] !== undefined) {
    end = zoned(y, mo, d, +tm[3], +tm[4], tz) + (start - zoned(y, mo, d, h, mi, tz));
    if (end <= start) end += 86400000; // 23:00-01:00
  }
  if (start < now - 60000) return { error: 'Это время уже прошло' };
  if (start > now + 60 * 86400000) return { error: 'Слишком далеко — максимум 60 дней' };
  return { start, end };
}

// ---------- хранение ----------
const all = () => data.list;
const get = (id) => data.list.find((e) => e.id === Number(id)) || null;

function create(ev) {
  const e = { id: data.nextId++, yes: [], no: [], maybe: [], reminded: false, started: false, createdAt: Date.now(), ...ev };
  data.list.push(e);
  save();
  return e;
}
function update(id, patch) {
  const e = get(id);
  if (!e) return null;
  Object.assign(e, patch);
  save();
  return e;
}
function remove(id) {
  const e = get(id);
  data.list = data.list.filter((x) => x.id !== Number(id));
  save();
  return e;
}

// записаться: list = 'yes' | 'no' | 'maybe'. Повторное нажатие — отписаться.
function vote(id, userId, list) {
  const e = get(id);
  if (!e) return { error: 'Сбор уже удалён' };
  const was = ['yes', 'no', 'maybe'].find((k) => e[k].includes(userId));
  for (const k of ['yes', 'no', 'maybe']) e[k] = e[k].filter((u) => u !== userId);
  if (was === list) { save(); return { event: e, removed: true }; }
  if (list === 'yes' && e.max && e.yes.length >= e.max) {
    if (was) e[was].push(userId);
    save();
    return { error: `Мест нет (${e.max}/${e.max}) — нажми ❓, если вдруг освободится` };
  }
  e[list].push(userId);
  save();
  return { event: e };
}

// старые сборы (больше суток после начала/конца) убираем
function cleanup(now = Date.now()) {
  const before = data.list.length;
  data.list = data.list.filter((e) => (e.end || e.start) > now - 86400000);
  if (data.list.length !== before) save();
}

module.exports = { resolveTz, parseWhen, all, get, create, update, remove, vote, cleanup, TZ_ALIASES };
