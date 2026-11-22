// Рисует карту сервера с сеткой, пачкой и ивентами → JPEG
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

GlobalFonts.registerFromPath(path.join(__dirname, '..', 'assets', 'Roboto-Bold.ttf'), 'RobotoBold');

const CELL = 146.25;
const T = { EXPLOSION: 2, CH47: 4, CARGO: 5, CRATE: 6, HELI: 8 };
const EVENT_STYLE = {
  [T.CARGO]: { color: '#1abc9c', label: 'Карго' },
  [T.HELI]: { color: '#e67e22', label: 'Вертолёт' },
  [T.CH47]: { color: '#f1c40f', label: 'Чинук' },
  [T.CRATE]: { color: '#9b59b6', label: 'Ящик' },
  [T.EXPLOSION]: { color: '#e74c3c', label: 'Взрыв' },
};

function letters(n) {
  let s = ''; n += 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * @param map      ответ getMap (width, height, jpgImage, oceanMargin)
 * @param mapSize  размер мира из getInfo
 * @param members  участники пачки [{name, x, y, isOnline, isAlive}]
 * @param markers  маркеры карты [{type, x, y}]
 */
async function renderMap({ map, mapSize, members = [], markers = [] }) {
  const img = await loadImage(Buffer.from(map.jpgImage));
  const W = img.width, H = img.height, m = map.oceanMargin || 0;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const px = (x) => m + (x / mapSize) * (W - 2 * m);
  const py = (y) => H - (m + (y / mapSize) * (H - 2 * m));
  const unit = W / 100; // базовый размер элементов

  // сетка
  const cells = Math.ceil(mapSize / CELL);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = Math.max(1, unit * 0.08);
  for (let i = 0; i <= cells; i++) {
    const wx = Math.min(i * CELL, mapSize);
    ctx.beginPath(); ctx.moveTo(px(wx), py(0)); ctx.lineTo(px(wx), py(mapSize)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px(0), py(mapSize - wx)); ctx.lineTo(px(mapSize), py(mapSize - wx)); ctx.stroke();
  }
  ctx.font = `${Math.round(unit * 0.9)}px RobotoBold`;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.textBaseline = 'top';
  for (let c = 0; c < cells; c++) {
    for (let r = 0; r < cells; r++) {
      ctx.fillText(`${letters(c)}${r}`, px(c * CELL) + unit * 0.2, py(mapSize - r * CELL) + unit * 0.15);
    }
  }

  const label = (text, x, y, color) => {
    ctx.font = `${Math.round(unit * 1.5)}px RobotoBold`;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = unit * 0.35;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };
  const dot = (x, y, r, color) => {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = r * 0.35; ctx.strokeStyle = '#000'; ctx.stroke();
  };

  // ивенты
  for (const mk of markers) {
    const st = EVENT_STYLE[mk.type];
    if (!st) continue;
    const x = px(mk.x), y = py(mk.y);
    ctx.save();
    ctx.translate(x, y); ctx.rotate(Math.PI / 4);
    ctx.fillStyle = st.color; ctx.strokeStyle = '#000'; ctx.lineWidth = unit * 0.2;
    const s = unit * 1.1;
    ctx.fillRect(-s / 2, -s / 2, s, s); ctx.strokeRect(-s / 2, -s / 2, s, s);
    ctx.restore();
    label(st.label, x + unit * 1.2, y, st.color);
  }

  // пачка
  for (const p of members) {
    const x = px(p.x), y = py(p.y);
    if (!p.isAlive) {
      ctx.strokeStyle = '#e74c3c'; ctx.lineWidth = unit * 0.45;
      const s = unit * 0.8;
      ctx.beginPath(); ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s); ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s); ctx.stroke();
      label(`${p.name} (мёртв)`, x + unit * 1.2, y, '#ff8a80');
    } else {
      const color = p.isOnline ? '#2ecc71' : '#bdc3c7';
      dot(x, y, unit * 0.8, color);
      label(p.name, x + unit * 1.2, y, color);
    }
  }

  return canvas.encode('jpeg', 85);
}

module.exports = { renderMap };
