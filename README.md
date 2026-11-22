# rust-ds-bot

Аналог Rust+, только в Discord. Бот подключается к серверу Rust через Rust+ и пишет в Discord и в тим-чат игры:

- 💀 смерти пачки с квадратом на карте («Глеб умер в G12»), в том числе спящих
- 🟢 кто зашёл/вышел, вступил/покинул команду
- 🚢 ивенты: карго, патрульный вертолёт, чинук, запертый ящик, взрыв (сбит heli/Брэдли)
- 💬 мост чата: тим-чат ↔ Discord-канал

## Установка (Windows)

1. Поставь **Node.js 20+** и **Google Chrome**.
2. `git clone https://github.com/j-iipg/rust-ds-bot.git && cd rust-ds-bot && npm install`
3. **Discord**: discord.com/developers → New Application → Bot → Reset Token. Включи **Message Content Intent**. Пригласи бота (OAuth2 → URL Generator → `bot`, права: Send Messages, Embed Links, Read Message History, Add Reactions). Скопируй ID канала.
4. **Rust+**:
   - `npm run register` — откроется Chrome, войди через Steam
   - `npm run pair` — не закрывай; в игре Esc → Rust+ → **Pair with server**
   - в консоли появятся `ip`, `port`, `playerId`, `playerToken`
5. Скопируй `.env.example` → `.env` и заполни.
6. Запусти `start.bat` (сам перезапускает бота при падении) или `npm start`.

## Важно

- Привязанный аккаунт должен быть в той же команде — бот видит только свою пачку.
- Сообщения в тим-чат идут от имени привязанного ника.
- После вайпа может понадобиться заново `npm run pair`.
- `POST_TO_TEAMCHAT=false` в `.env` — уведомления только в Discord (мост чата работает).
- `.env` и `rustplus.config.json` содержат токены — не коммить их (уже в `.gitignore`).
