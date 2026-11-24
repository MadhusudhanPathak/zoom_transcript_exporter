'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..', '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

test('manifest requests only activeTab and scripting', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.content_scripts, undefined);
});

test('every file referenced by the manifest exists', () => {
  const files = [manifest.action.default_popup, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  for (const f of files) assert.ok(fs.existsSync(path.join(EXT, f)), `missing ${f}`);
});

test('extension code has no remote code, eval, or network calls', () => {
  const src = ['extractor.js', 'popup.js', 'lib/text.js', 'popup.html']
    .map((f) => fs.readFileSync(path.join(EXT, f), 'utf8'))
    .join('\n');
  for (const pattern of [/\beval\s*\(/, /new Function\s*\(/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /https?:\/\/[^\s'"]*\.(js|css)\b/]) {
    assert.doesNotMatch(src, pattern);
  }
});
