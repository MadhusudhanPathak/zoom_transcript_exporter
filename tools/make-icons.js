#!/usr/bin/env node
/*
 * Generates extension/icons/{16,32,48,128}.png with no dependencies.
 * Design: a rounded indigo square with three "transcript lines" and a download arrow.
 * Shapes are signed-distance functions sampled 4x4 per pixel for anti-aliasing.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const BG = [59, 91, 219]; // #3b5bdb
const FG = [255, 255, 255];

// Shapes in a 0..1 unit square. Each returns true if (x, y) is inside.
const roundedRect = (x0, y0, x1, y1, r) => (x, y) => {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const triangle = (ax, ay, bx, by, cx, cy) => (x, y) => {
  const s = (px, py, qx, qy) => (x - qx) * (py - qy) - (px - qx) * (y - qy);
  const d1 = s(ax, ay, bx, by), d2 = s(bx, by, cx, cy), d3 = s(cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

const background = roundedRect(0, 0, 1, 1, 0.2);
const foreground = [
  roundedRect(0.18, 0.22, 0.82, 0.32, 0.05), // text line 1
  roundedRect(0.18, 0.41, 0.70, 0.51, 0.05), // text line 2
  roundedRect(0.18, 0.60, 0.46, 0.70, 0.05), // text line 3
  roundedRect(0.64, 0.52, 0.74, 0.72, 0.02), // arrow shaft
  triangle(0.53, 0.68, 0.85, 0.68, 0.69, 0.86), // arrow head
];

function render(size) {
  const SS = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!background(x, y)) continue;
          bg++;
          if (foreground.some((f) => f(x, y))) fg++;
        }
      }
      const i = (py * size + px) * 4;
      const a = bg / (SS * SS);
      const t = bg ? fg / bg : 0; // share of the covered area that is foreground
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(BG[c] * (1 - t) + FG[c] * t);
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `${size}.png`);
  fs.writeFileSync(file, encodePng(size, render(size)));
  console.log('wrote', path.relative(process.cwd(), file));
}
