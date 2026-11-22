// Перевод координат Rust+ (x, y; начало — левый нижний угол) в квадрат карты, например "G12"
const CELL = 146.25;

function letters(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function toGrid(x, y, mapSize) {
  if (!mapSize) return `${Math.round(x)}, ${Math.round(y)}`;
  if (x < 0 || y < 0 || x > mapSize || y > mapSize) return 'за картой';
  const col = Math.floor(x / CELL);
  const row = Math.floor((mapSize - y) / CELL);
  return `${letters(col)}${row}`;
}

module.exports = { toGrid };
