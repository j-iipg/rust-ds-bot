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

// названия монументов (token из Rust+ → по-русски); неизвестные и туннели не подписываем
const MONUMENTS = {
  airfield_display_name: 'Аэропорт', bandit_camp: 'Бандитка', dome_monument_name: 'Купол', excavator: 'Экскаватор',
  fishing_village_display_name: 'Рыб. деревня', large_fishing_village_display_name: 'Рыб. деревня', gas_station: 'Заправка',
  harbor_display_name: 'Порт', harbor_2_display_name: 'Порт', junkyard_display_name: 'Свалка', large_oil_rig: 'Большая вышка',
  oil_rig_small: 'Малая вышка', launchsite: 'Космодром', lighthouse_display_name: 'Маяк', military_tunnels_display_name: 'Военные туннели',
  mining_outpost_display_name: 'Шахта', outpost: 'Аутпост', power_plant_display_name: 'Электростанция',
  satellite_dish_display_name: 'Спутники', sewer_display_name: 'Канализация', stables_a: 'Конюшня', stables_b: 'Конюшня',
  supermarket: 'Магазин', swamp_c: 'Болото', train_yard_display_name: 'Депо', underwater_lab: 'Подводная лаба',
  water_treatment_plant_display_name: 'Водоочистка', arctic_base_a: 'Арктическая база', ferryterminal: 'Паромный терминал',
  missile_silo_monument: 'Ракетная шахта', mining_quarry_hqm_display_name: 'Карьер МВК', mining_quarry_stone_display_name: 'Карьер камня',
  mining_quarry_sulfur_display_name: 'Карьер серы', AbandonedMilitaryBase: 'Заброш. база', abandonedmilitarybase: 'Заброш. база',
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
async function renderMap({ map, mapSize, members = [], markers = [], monuments = [], title = 'Rust', subtitle = '' }) {
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
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
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

  // монументы
  ctx.textAlign = 'center';
  for (const mo of monuments) {
    const name = MONUMENTS[mo.token];
    if (!name) continue;
    const x = px(mo.x), y = py(mo.y);
    ctx.font = `${Math.round(unit * 1.1)}px RobotoBold`;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = unit * 0.3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(name, x, y);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(name, x, y);
  }
  ctx.textAlign = 'left';

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

  // шапка
  const barH = unit * 5;
  const grad = ctx.createLinearGradient(0, 0, 0, barH);
  grad.addColorStop(0, 'rgba(10,12,16,0.92)'); grad.addColorStop(1, 'rgba(10,12,16,0.65)');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, barH);
  ctx.fillStyle = '#ce422b'; ctx.fillRect(0, barH - unit * 0.25, W, unit * 0.25); // фирменная полоска Rust
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = `${Math.round(unit * 2.1)}px RobotoBold`;
  ctx.fillText(title.slice(0, 60), unit * 1.5, barH * 0.4);
  if (subtitle) {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `${Math.round(unit * 1.3)}px RobotoBold`;
    ctx.fillText(subtitle, unit * 1.5, barH * 0.78);
  }

  // легенда
  const items = [
    ['dot', '#2ecc71', 'Онлайн'], ['dot', '#bdc3c7', 'Оффлайн'], ['x', '#e74c3c', 'Мёртв'],
    ...Object.values(EVENT_STYLE).map((e) => ['dia', e.color, e.label]),
  ];
  const lh = unit * 2, lw = unit * 14, lx = unit * 1.2, ly = H - unit * 1.2 - lh * items.length - unit;
  ctx.fillStyle = 'rgba(10,12,16,0.8)';
  ctx.beginPath(); ctx.roundRect(lx, ly, lw, lh * items.length + unit, unit * 0.8); ctx.fill();
  items.forEach(([kind, color, text], k) => {
    const cx = lx + unit * 1.5, cy = ly + unit * 0.5 + lh * k + lh / 2;
    if (kind === 'dot') { ctx.beginPath(); ctx.arc(cx, cy, unit * 0.55, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); }
    else if (kind === 'x') {
      ctx.strokeStyle = color; ctx.lineWidth = unit * 0.3; const q = unit * 0.5;
      ctx.beginPath(); ctx.moveTo(cx - q, cy - q); ctx.lineTo(cx + q, cy + q); ctx.moveTo(cx + q, cy - q); ctx.lineTo(cx - q, cy + q); ctx.stroke();
    } else {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.PI / 4); ctx.fillStyle = color; const q = unit * 0.8; ctx.fillRect(-q / 2, -q / 2, q, q); ctx.restore();
    }
    ctx.fillStyle = '#fff'; ctx.font = `${Math.round(unit * 1.2)}px RobotoBold`; ctx.textBaseline = 'middle';
    ctx.fillText(text, cx + unit * 1.3, cy);
  });

  return canvas.encode('jpeg', 88);
}

module.exports = { renderMap };
