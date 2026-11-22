// Слушает пуш-уведомления Rust+ для аккаунта (как npm run pair), чтобы ловить Pair сервера/устройств.
const PushReceiverClient = require('@liamcottle/push-receiver/src/client');

function startFcm(account, onPairing, log) {
  const { androidId, securityToken } = account.config.fcm_credentials.gcm;
  const client = new PushReceiverClient(androidId, securityToken, []);
  const startedAt = Date.now();

  client.on('ON_DATA_RECEIVED', (data) => {
    try {
      // FCM может заново прислать старые уведомления при запуске — их пропускаем
      const sent = Number(data.sent || 0);
      if (sent && sent < startedAt - 60 * 1000) return;
      const bodyRaw = (data.appData || []).find((x) => x.key === 'body')?.value;
      if (!bodyRaw) return;
      onPairing(JSON.parse(bodyRaw), account);
    } catch (e) {
      log(`FCM (${account.name}): не смог разобрать уведомление:`, e.message);
    }
  });
  client.on('connect', () => log(`FCM: слушаю привязки аккаунта ${account.name}`));
  client.connect().catch((e) => log(`FCM ошибка (${account.name}):`, e.message || e));
  return client;
}

module.exports = { startFcm };
