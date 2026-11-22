// Аккаунты Rust+ (твой и тиммейтов): data/accounts/<steamId>.json
// В каждом: fcm_credentials (чтобы ловить Pair), rustplus_auth_token (чтобы подключаться через relay)
const fs = require('fs');
const path = require('path');

const DIR = path.join(process.cwd(), 'data', 'accounts');
const accounts = new Map(); // steamId -> {steamId, name, exp, config}

// Rust+ токен: "<base64 JSON {steamId, iss, exp}>.<подпись>"
function decodeToken(token) {
  try {
    const t = String(token || '').includes('%') ? decodeURIComponent(token) : String(token || '');
    const json = JSON.parse(Buffer.from(t.split('.')[0], 'base64').toString('utf8'));
    return { steamId: String(json.steamId), exp: Number(json.exp) || 0 };
  } catch { return null; }
}

function validate(config) {
  if (!config || typeof config !== 'object') return 'это не файл аккаунта';
  if (!config.fcm_credentials?.gcm?.androidId) return 'в файле нет fcm_credentials';
  if (!config.rustplus_auth_token) return 'в файле нет rustplus_auth_token';
  if (!decodeToken(config.rustplus_auth_token)) return 'не смог прочитать rustplus_auth_token';
  return null;
}

function put(config, name) {
  const err = validate(config);
  if (err) return { error: err };
  const { steamId, exp } = decodeToken(config.rustplus_auth_token);
  const prev = accounts.get(steamId);
  const acc = { steamId, exp, name: name || prev?.name || steamId, config };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${steamId}.json`), JSON.stringify({ name: acc.name, ...config }, null, 2));
  accounts.set(steamId, acc);
  return { account: acc, isNew: !prev, changedFcm: prev?.config.fcm_credentials?.gcm?.androidId !== config.fcm_credentials.gcm.androidId };
}

function load() {
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const { name, ...config } = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
        if (validate(config)) continue;
        const { steamId, exp } = decodeToken(config.rustplus_auth_token);
        accounts.set(steamId, { steamId, exp, name: name || steamId, config });
      } catch {}
    }
  } catch {}

  // твой rustplus.config.json (после npm run register) — тоже аккаунт; обновляется при каждом запуске
  try {
    const own = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'rustplus.config.json'), 'utf8'));
    if (!validate(own)) {
      const { steamId } = decodeToken(own.rustplus_auth_token);
      const cur = accounts.get(steamId);
      if (!cur || cur.config.rustplus_auth_token !== own.rustplus_auth_token) put(own, cur?.name || 'владелец');
    }
  } catch {}
}

function remove(steamId) {
  if (!accounts.has(steamId)) return false;
  accounts.delete(steamId);
  try { fs.unlinkSync(path.join(DIR, `${steamId}.json`)); } catch {}
  return true;
}

const get = (steamId) => accounts.get(String(steamId)) || null;
const all = () => [...accounts.values()];
const authToken = (steamId) => get(steamId)?.config.rustplus_auth_token || null;
const daysLeft = (acc) => Math.floor((acc.exp * 1000 - Date.now()) / 86400000);

module.exports = { load, put, get, all, remove, authToken, daysLeft, decodeToken };
