import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
const BG = [10, 13, 18];
const SAMPLES = 4;
// Four falling bars, matching public/icons/icon.svg (coordinates out of 512).
const BARS = [
  { x: 120, y: 128, color: [255, 93, 82] },
  { x: 200, y: 200, color: [242, 180, 65] },
  { x: 280, y: 270, color: [67, 209, 177] },
  { x: 360, y: 314, color: [67, 209, 177] },
].map((bar) => ({ left: bar.x / 512, right: (bar.x + 48) / 512, top: bar.y / 512, bottom: 384 / 512, color: bar.color }));

function insideRounded(x, y, radius) {
  const qx = Math.abs(x - 0.5) - (0.5 - radius);
  const qy = Math.abs(y - 0.5) - (0.5 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= radius;
}

function sample(u, v, maskable) {
  if (!maskable && !insideRounded(u, v, 0.22)) return null;
  const scale = maskable ? 0.72 : 1;
  const x = 0.5 + (u - 0.5) / scale;
  const y = 0.5 + (v - 0.5) / scale;
  const bar = BARS.find((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
  return bar ? bar.color : BG;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function renderPng(size, maskable) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let py = 0; py < size; py += 1) {
    raw[offset++] = 0;
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const color = sample((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size, maskable);
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            hits += 1;
          }
        }
      }
      raw[offset++] = hits ? Math.round(r / hits) : 0;
      raw[offset++] = hits ? Math.round(g / hits) : 0;
      raw[offset++] = hits ? Math.round(b / hits) : 0;
      raw[offset++] = Math.round((hits / (SAMPLES * SAMPLES)) * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'icon-192.png'), renderPng(192, false));
writeFileSync(path.join(outDir, 'icon-512.png'), renderPng(512, false));
writeFileSync(path.join(outDir, 'icon-maskable-512.png'), renderPng(512, true));
