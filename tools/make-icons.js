import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
const BG = [21, 23, 24];
const BAR = [241, 242, 240];
const CHEVRON = [91, 203, 134];
const SAMPLES = 4;

function segmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

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
  if (segmentDistance(x, y, 0.26, 0.32, 0.74, 0.32) <= 0.045) return BAR;
  if (segmentDistance(x, y, 0.28, 0.47, 0.5, 0.69) <= 0.065
    || segmentDistance(x, y, 0.5, 0.69, 0.72, 0.47) <= 0.065) return CHEVRON;
  return BG;
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
