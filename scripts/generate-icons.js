const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function render(size) {
  const pixels = Array.from({ length: size }, () => Array.from({ length: size }, () => [0, 0, 0, 255]));
  const cx = size / 2;
  const cy = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / (size / 2);
      const dy = (y - cy) / (size / 2);
      const r = Math.sqrt(dx * dx + dy * dy);
      const t = clamp(1 - r, 0, 1);
      const rr = Math.floor(8 + 30 * t + 50 * (t ** 2));
      const gg = Math.floor(12 + 35 * t + 30 * (t ** 2));
      const bb = Math.floor(30 + 90 * t + 60 * (t ** 2));
      pixels[y][x] = [rr, gg, bb, 255];
    }
  }

  const margin = Math.floor(size * 0.12);
  const radius = Math.floor(size * 0.18);
  const x0 = margin, y0 = margin, x1 = size - margin, y1 = size - margin;

  function insideRoundedRect(x, y) {
    if (x >= x0 + radius && x <= x1 - radius && y >= y0 && y <= y1) return true;
    if (y >= y0 + radius && y <= y1 - radius && x >= x0 && x <= x1) return true;
    const corners = [
      [x0 + radius, y0 + radius],
      [x1 - radius, y0 + radius],
      [x0 + radius, y1 - radius],
      [x1 - radius, y1 - radius]
    ];
    return corners.some(([cx2, cy2]) => ((x - cx2) ** 2 + (y - cy2) ** 2) <= radius ** 2);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!insideRoundedRect(x, y)) continue;
      const base = [18, 24, 48, 240];
      const [pr, pg, pb] = pixels[y][x];
      const a = base[3] / 255;
      pixels[y][x] = [
        Math.floor(base[0] * a + pr * (1 - a)),
        Math.floor(base[1] * a + pg * (1 - a)),
        Math.floor(base[2] * a + pb * (1 - a)),
        255
      ];
    }
  }

  function drawLine(ax, ay, bx, by, width, color) {
    const w2 = width * width;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - width));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + width));
    const minY = Math.max(0, Math.floor(Math.min(ay, by) - width));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by) + width));
    const vx = bx - ax;
    const vy = by - ay;
    const vv = vx * vx + vy * vy + 1e-9;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        let t = ((x - ax) * vx + (y - ay) * vy) / vv;
        t = clamp(t, 0, 1);
        const px = ax + t * vx;
        const py = ay + t * vy;
        if ((x - px) ** 2 + (y - py) ** 2 <= w2) {
          pixels[y][x] = color;
        }
      }
    }
  }

  const white = [238, 244, 255, 255];
  const accent = [20, 196, 182, 255];
  drawLine(size * 0.30, size * 0.72, size * 0.30, size * 0.28, size * 0.05, white);
  drawLine(size * 0.70, size * 0.72, size * 0.70, size * 0.28, size * 0.05, white);
  drawLine(size * 0.30, size * 0.28, size * 0.70, size * 0.72, size * 0.05, white);
  drawLine(size * 0.64, size * 0.34, size * 0.40, size * 0.66, size * 0.03, accent);

  return pixels;
}

function pngChunk(tag, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const name = Buffer.from(tag, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(require('zlib').crc32 ? require('zlib').crc32(Buffer.concat([name, data])) : 0, 0);
  // Manual CRC32 fallback
  if (!require('zlib').crc32) {
    let c = 0xffffffff;
    const buf = Buffer.concat([name, data]);
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  }
  return Buffer.concat([len, name, data, crc]);
}

function encodePng(pixels) {
  const height = pixels.length;
  const width = pixels[0].length;

  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixels[y][x];
      const i = 1 + x * 4;
      row[i] = r;
      row[i + 1] = g;
      row[i + 2] = b;
      row[i + 3] = a;
    }
    rows.push(row);
  }

  const raw = Buffer.concat(rows);
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function encodeIco(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, pngBuffer]);
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function run() {
  const outDir = path.join(process.cwd(), '.generated-icons');
  ensureDir(outDir);

  const png512 = encodePng(render(512));
  const png256 = encodePng(render(256));
  const ico = encodeIco(png256, 256);

  fs.writeFileSync(path.join(outDir, 'icon.png'), png512);
  fs.writeFileSync(path.join(outDir, 'icon-256.png'), png256);
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);

  console.log('Generated icons in .generated-icons/');
}

run();
