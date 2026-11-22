// Ищет порт Rust+ на сервере: пробует порты и проверяет, отвечает ли Rust+ на getInfo.
// Запуск: npm run findport
require('dotenv').config();
const RustPlus = require('@liamcottle/rustplus.js');

const ip = process.env.RUST_IP;
const playerId = process.env.RUST_PLAYER_ID;
const token = process.env.RUST_PLAYER_TOKEN;
if (!ip || !playerId || !token) {
  console.log('Заполни в .env RUST_IP, RUST_PLAYER_ID и RUST_PLAYER_TOKEN');
  process.exit(1);
}

// Сначала самые частые варианты, потом диапазоны
const ports = [...new Set([
  28082, 28083, 28081, 28084, 28085, 28015, 28016, 28017, 28014, 28018, 28010, 28077, 28080, 28090,
  ...range(28000, 28250), ...range(27000, 27100), ...range(29000, 29100), ...range(12000, 12100),
])];
function range(a, b) { return Array.from({ length: b - a + 1 }, (_, i) => a + i); }

function tryPort(port) {
  return new Promise((resolve) => {
    const r = new RustPlus(ip, port, playerId, token);
    let done = false;
    const finish = (ok, info) => {
      if (done) return;
      done = true;
      try { r.disconnect(); } catch {}
      resolve(ok ? { port, info } : null);
    };
    const timer = setTimeout(() => finish(false), 4000);
    r.on('error', () => {});
    r.on('disconnected', () => { clearTimeout(timer); finish(false); });
    r.on('connected', async () => {
      try {
        const res = await r.sendRequestAsync({ getInfo: {} }, 4000);
        clearTimeout(timer);
        finish(true, res.info);
      } catch (e) {
        clearTimeout(timer);
        // ответил Rust+, но не принял токен — порт верный, токен нет
        if (e && typeof e.error === 'string') finish(true, { tokenError: e.error });
        else finish(false);
      }
    });
    r.connect();
  });
}

(async () => {
  console.log(`Ищу порт Rust+ на ${ip}, проверяю ${ports.length} портов (до ~1 мин)...`);
  const BATCH = 25;
  for (let i = 0; i < ports.length; i += BATCH) {
    const results = await Promise.all(ports.slice(i, i + BATCH).map(tryPort));
    const hit = results.find(Boolean);
    if (hit) {
      if (hit.info.tokenError) {
        console.log(`\nНашёл порт ${hit.port}, но сервер не принял токен (${hit.info.tokenError}).`);
        console.log('Сделай заново npm run pair и обнови RUST_PLAYER_TOKEN в .env');
      } else {
        console.log(`\n✅ НАШЁЛ! Порт Rust+: ${hit.port} (сервер: ${hit.info.name})`);
        console.log(`Впиши в .env:  RUST_PORT=${hit.port}`);
      }
      process.exit(0);
    }
    process.stdout.write(`.`);
  }
  console.log('\n❌ Ни один порт не ответил. Похоже, сервер закрыл Rust+ для внешних подключений.');
  process.exit(0);
})();
