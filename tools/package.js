#!/usr/bin/env node
/*
 * Zips the extension/ folder into Release/zoom-transcript-exporter-<version>.zip and
 * writes Release/SHA256SUMS.txt. These are the files to attach to a GitHub release.
 * Minimal ZIP writer (deflate + CRC from node:zlib) so packaging needs no dependencies
 * and works the same on Windows, macOS and Linux.
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const RELEASE = path.join(ROOT, 'Release');
const { version } = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const ZIP_NAME = `zoom-transcript-exporter-${version}.zip`;
const OUT = path.join(RELEASE, ZIP_NAME);

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.name.startsWith('.')) return [];
    return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

// Zip entry name → file on disk. The GPL licence text must travel with every copy,
// so the repository's LICENSE goes into the zip alongside the extension files.
const entries = new Map(listFiles(SRC).sort().map((name) => [name, path.join(SRC, name)]));
entries.set('LICENSE', path.join(ROOT, 'LICENSE'));
const files = [...entries.keys()];
const locals = [];
const centrals = [];
let offset = 0;
// Fixed DOS timestamp (1980-01-01) so the same sources always produce the same zip.
const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1;

for (const name of files) {
  const data = fs.readFileSync(entries.get(name));
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const crc = zlib.crc32(data) >>> 0;
  const nameBuf = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  locals.push(local, nameBuf, deflated);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBuf);

  offset += local.length + nameBuf.length + deflated.length;
}

const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

fs.mkdirSync(RELEASE, { recursive: true });
// Remove zips from earlier versions so Release/ only holds what belongs in this release.
for (const f of fs.readdirSync(RELEASE)) {
  if (/^zoom-transcript-exporter-.*\.zip$/.test(f) && f !== ZIP_NAME) fs.rmSync(path.join(RELEASE, f));
}
const zip = Buffer.concat([...locals, ...centrals, end]);
fs.writeFileSync(OUT, zip);
const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
fs.writeFileSync(path.join(RELEASE, 'SHA256SUMS.txt'), `${sha256}  ${ZIP_NAME}\n`);
console.log(`wrote ${path.relative(ROOT, OUT)} (${files.length} files)`);
console.log(`sha256 ${sha256}`);
