// Renders the PNG app icons from the same shapes as public/icons/icon.svg:
// a dashed target line, and a price line that dives under it and ends in a dot.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
const BG = [15, 13, 20];
const LINE = [201, 196, 212];
const MINT = [94, 224, 138];
const SAMPLES = 4;
const n = (value) => value / 512;

// Dashed target line: dashes 44 long with 32 gaps from x=104 to x=408, rounded ends.
const DASHES = [];
for (let x = 104; x < 408; x += 76) DASHES.push([n(x), n(210), n(Math.min(x + 44, 408)), n(210)]);
const PRICE = [[112, 118, 250, 168], [250, 168, 320, 344], [320, 344, 388, 366]].map((s) => s.map(n));
const DOT = { x: n(398), y: n(370), r: n(40) };

function segmentDistance(x, y, [ax, ay, bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
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
  if (Math.hypot(x - DOT.x, y - DOT.y) <= DOT.r) return MINT;
  if (PRICE.some((segment) => segmentDistance(x, y, segment) <= n(20))) return MINT;
  if (DASHES.some((segment) => segmentDistance(x, y, segment) <= n(11))) return LINE;
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
