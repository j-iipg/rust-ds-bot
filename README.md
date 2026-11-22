# rust-ds-bot

Аналог Rust+, только в Discord. Бот подключается к серверу Rust через Rust+ и пишет в Discord и в тим-чат игры:

- 💀 смерти пачки с квадратом на карте («Глеб умер в G12»), в том числе спящих
- 🟢 кто зашёл/вышел, вступил/покинул команду
- 🚢 ивенты: карго, патрульный вертолёт, чинук, запертый ящик, взрыв (сбит heli/Брэдли)
- 💬 мост чата: тим-чат ↔ Discord-канал
- 💡 управление Smart Switch из тим-чата и Discord — работает у всех тиммейтов
- 🚨 Smart Alarm: при срабатывании кричит в Discord и тим-чат

## Смена сервера

Пока бот запущен, зайди на новый сервер → Esc → Rust+ → **Pair with server** — бот сам переключится на него (сохраняется в `data/server.json`). У каждого сервера свой список переключателей.

## Аккаунты тиммейтов (чтобы всё работало без тебя)

Каждый тиммейт может добавить свой Rust+ аккаунт — тогда он сам привязывает сервер и переключатели.

1. Тиммейт ставит Node.js и Google Chrome.
2. В cmd: `npx @liamcottle/rustplus.js fcm-register --config-file rust-account.json` → входит через Steam.
3. Пишет боту **в личку** `!link` и прикладывает файл `rust-account.json`.
4. Заходит на сервер → Esc → Rust+ → **Pair with server**, дальше E → Pair на переключателях.

Переключатели, которые привязал тиммейт, работают через его аккаунт. `!accounts` — список и сколько живут токены (~14 дней; за 2 дня бот напомнит). Обновить свой токен на хостинге: на ПК `npm run register` и отправь боту в личку `!link` + `rustplus.config.json`.

## Хостинг (VDS с Ubuntu или Raspberry Pi)

```bash
# 1. Node.js и git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
# 2. Бот
git clone https://github.com/j-iipg/rust-ds-bot.git && cd rust-ds-bot && npm install
nano .env            # вставь содержимое своего .env с ПК
# 3. Запуск 24/7 с автозапуском
sudo npm install -g pm2
pm2 start src/index.js --name rust-bot
pm2 save && pm2 startup   # выполни команду, которую он покажет
```

Потом в Discord отправь боту в личку `!link` + свой `rustplus.config.json` с ПК (Chrome на сервере не нужен) и сделай в игре **Pair with server**.

- Логи: `pm2 logs rust-bot` · перезапуск: `pm2 restart rust-bot`
- Обновить: `git pull && npm install && pm2 restart rust-bot`
- На ПК бота выключи, чтобы не работали два одновременно.

## Переключатели и алармы

1. Бот должен быть запущен. В игре смотри на Smart Switch / Smart Alarm → зажми **E** → **Pair**.
2. Бот сам добавит устройство и напишет его имя (`свитч`, `аларм`…).
3. Команды (в тим-чате игры или в Discord-канале):

| Команда | Что делает |
|---|---|
| `!panel` | пульт с кнопками в Discord |
| `!sw` | список устройств и их состояние |
| `!on свет` / `!off свет` | включить / выключить (`!on all` — все) |
| `!t свет` | переключить |
| `!name свитч свет` | переименовать |
| `!del свет` | удалить из списка |
| `!team` | кто в пачке, онлайн, где стоит, кто лидер |
| `!leader ник` | передать лидерство (если аккаунт бота — лидер) |
| `!accounts` | аккаунты и сколько живут токены |
| `!link` | (в личку боту, с файлом) добавить аккаунт |
| `!help` | помощь |

Привязывает устройства только аккаунт бота, а управлять могут все: тиммейты — через тим-чат, остальные — через Discord-канал. Список хранится в `data/devices.json`.

## Установка (Windows)

1. Поставь **Node.js 20+** и **Google Chrome**.
2. `git clone https://github.com/j-iipg/rust-ds-bot.git && cd rust-ds-bot && npm install`
3. **Discord**: discord.com/developers → New Application → Bot → Reset Token. Включи **Message Content Intent**. Пригласи бота (OAuth2 → URL Generator → `bot`, права: Send Messages, Embed Links, Read Message History, Add Reactions). Скопируй ID канала.
4. **Rust+**:
   - `npm run register` — откроется Chrome, войди через Steam
   - `npm run pair` — не закрывай; в игре Esc → Rust+ → **Pair with server**
   - в консоли появится `body` с `"id"`, `"playerId"`, `"playerToken"`
5. Скопируй `.env.example` → `.env` и заполни: `RUST_SERVER_ID` = `id`, плюс `RUST_PLAYER_ID` и `RUST_PLAYER_TOKEN`.

> С ноября 2026 Facepunch отключил прямые подключения Rust+ — бот ходит через relay `companion-rust.facepunch.com/socket/<id>` с Rust+ токеном из `rustplus.config.json`. Токен живёт ~14 дней: если бот пишет про HTTP 401/403 — снова `npm run register`.
6. Запусти `start.bat` (сам перезапускает бота при падении) или `npm start`.

## Важно

- Привязанный аккаунт должен быть в той же команде — бот видит только свою пачку.
- Сообщения в тим-чат идут от имени привязанного ника.
- После вайпа может понадобиться заново `npm run pair`.
- Раз в ~2 недели: `npm run register` (обновить Rust+ токен).
- `POST_TO_TEAMCHAT=false` в `.env` — уведомления только в Discord (мост чата работает).
- `.env` и `rustplus.config.json` содержат токены — не коммить их (уже в `.gitignore`).
