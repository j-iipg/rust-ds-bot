// Подключение к Rust+ через relay Facepunch (с ноября 2026 прямые подключения к серверу отключены).
// wss://companion-rust.facepunch.com/socket/<server id>?v=<ms>
// subprotocols: ["rustplus.auth.v1", base64url(<Rust+ auth token>)]
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const protobuf = require('protobufjs');
const RustPlus = require('@liamcottle/rustplus.js');

const PROTO = path.join(path.dirname(require.resolve('@liamcottle/rustplus.js')), 'rustplus.proto');

// Rust+ auth token: из .env (RUST_AUTH_TOKEN) или из rustplus.config.json (после npm run register)
function loadAuthToken() {
  let t = process.env.RUST_AUTH_TOKEN;
  if (!t) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'rustplus.config.json'), 'utf8'));
      t = cfg.rustplus_auth_token;
    } catch {}
  }
  if (!t) return null;
  t = t.trim();
  if (t.includes('%')) { try { t = decodeURIComponent(t); } catch {} }
  return t;
}

class RelayRustPlus extends RustPlus {
  constructor(serverId, authToken, playerId, playerToken) {
    super('relay', 0, playerId, playerToken);
    this.serverId = serverId;
    this.authToken = authToken;
  }

  connect() {
    protobuf.load(PROTO).then((root) => {
      if (this.websocket) this.disconnect();
      this.AppRequest = root.lookupType('rustplus.AppRequest');
      this.AppMessage = root.lookupType('rustplus.AppMessage');
      this.emit('connecting');

      const url = `wss://companion-rust.facepunch.com/socket/${this.serverId}?v=${Date.now()}`;
      const authProto = Buffer.from(this.authToken, 'utf8').toString('base64url');
      this.websocket = new WebSocket(url, ['rustplus.auth.v1', authProto], {
        headers: { origin: 'https://app.playrust.com' },
      });

      this.websocket.on('open', () => this.emit('connected'));
      this.websocket.on('error', (e) => this.emit('error', e));
      this.websocket.on('unexpected-response', (req, res) => {
        this.emit('error', new Error(`relay ответил HTTP ${res.statusCode}` +
          (res.statusCode === 401 || res.statusCode === 403 ? ' — Rust+ токен устарел, сделай npm run register' : '')));
        try { this.websocket.terminate(); } catch {}
        this.emit('disconnected');
      });
      this.websocket.on('message', (data) => {
        const message = this.AppMessage.decode(data);
        if (message.response && message.response.seq && this.seqCallbacks[message.response.seq]) {
          const cb = this.seqCallbacks[message.response.seq];
          const handled = cb(message);
          delete this.seqCallbacks[message.response.seq];
          if (handled) return;
        }
        this.emit('message', message);
      });
      this.websocket.on('close', () => this.emit('disconnected'));
    });
  }
}

// Создаёт клиент: через relay, если задан RUST_SERVER_ID, иначе напрямую по ip:port
function createRustClient(env) {
  if (env.RUST_SERVER_ID) {
    const auth = loadAuthToken();
    if (!auth) throw new Error('Нет Rust+ токена: выполни npm run register (создаст rustplus.config.json)');
    return { client: new RelayRustPlus(env.RUST_SERVER_ID, auth, env.RUST_PLAYER_ID, env.RUST_PLAYER_TOKEN), label: `relay ${env.RUST_SERVER_ID}` };
  }
  return { client: new RustPlus(env.RUST_IP, env.RUST_PORT, env.RUST_PLAYER_ID, env.RUST_PLAYER_TOKEN), label: `${env.RUST_IP}:${env.RUST_PORT}` };
}

module.exports = { createRustClient, loadAuthToken };
