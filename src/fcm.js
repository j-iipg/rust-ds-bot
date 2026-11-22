// Слушает пуш-уведомления Rust+ (как npm run pair), чтобы ловить привязку переключателей/алармов.
const fs = require('fs');
const path = require('path');
const PushReceiverClient = require('@liamcottle/push-receiver/src/client');

function startFcm(onPairing, log) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'rustplus.config.json'), 'utf8'));
  } catch {
    log('FCM: нет rustplus.config.json — привязка переключателей не будет работать (сделай npm run register)');
    return null;
  }
  if (!config.fcm_credentials) {
    log('FCM: в rustplus.config.json нет fcm_credentials — сделай npm run register');
    return null;
  }

  const { androidId, securityToken } = config.fcm_credentials.gcm;
  const client = new PushReceiverClient(androidId, securityToken, []);
  const startedAt = Date.now();

  client.on('ON_DATA_RECEIVED', (data) => {
    try {
      const get = (k) => (data.appData || []).find((x) => x.key === k)?.value;
      const bodyRaw = get('body');
      if (!bodyRaw) return;
      // FCM может заново прислать старые уведомления при запуске — их пропускаем
      const sent = Number(data.sent || 0);
      if (sent && sent < startedAt - 60 * 1000) return;
      const body = JSON.parse(bodyRaw);
      onPairing(body);
    } catch (e) {
      log('FCM: не смог разобрать уведомление:', e.message);
    }
  });
  client.on('connect', () => log('FCM: слушаю привязку переключателей'));
  client.connect().catch((e) => log('FCM ошибка:', e.message || e));
  return client;
}

module.exports = { startFcm };
