'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../extension/lib/text.js');

// The overlap step exactly as written in the reference console script.
function referenceOverlap(out, lines) {
  let k = Math.min(out.length, lines.length);
  while (k > 0 && out.slice(-k).join('\n') !== lines.slice(0, k).join('\n')) k--;
  return k;
}

test('splitLines drops blank lines but keeps original spacing', () => {
  assert.deepEqual(T.splitLines('a\n\n  \n b \nc'), ['a', ' b ', 'c']);
  assert.deepEqual(T.splitLines(''), []);
  assert.deepEqual(T.splitLines(undefined), []);
});

test('hasTimestamp / countTimestamps', () => {
  assert.equal(T.hasTimestamp('Speaker 00:01:23'), true);
  assert.equal(T.hasTimestamp('no time here'), false);
  assert.equal(T.countTimestamps('1:23 a 12:34 b 01:02:03'), 3);
  assert.equal(T.countTimestamps('nothing'), 0);
});

test('findOverlap: partial overlap at various offsets', () => {
  const out = ['a', 'b', 'c', 'd', 'e'];
  assert.equal(T.findOverlap(out, ['e', 'f']), 1);
  assert.equal(T.findOverlap(out, ['d', 'e', 'f']), 2);
  assert.equal(T.findOverlap(out, ['b', 'c', 'd', 'e', 'f', 'g']), 4);
});

test('findOverlap: no overlap', () => {
  assert.equal(T.findOverlap(['a', 'b'], ['c', 'd']), 0);
});

test('findOverlap: full overlap (snapshot already collected)', () => {
  assert.equal(T.findOverlap(['a', 'b', 'c'], ['b', 'c']), 2);
  assert.equal(T.findOverlap(['a', 'b', 'c'], ['a', 'b', 'c']), 3);
});

test('findOverlap: empty inputs', () => {
  assert.equal(T.findOverlap([], ['a']), 0);
  assert.equal(T.findOverlap(['a'], []), 0);
  assert.equal(T.findOverlap([], []), 0);
});

test('mergeSnapshot appends only new lines and does not mutate inputs', () => {
  const out = ['A', '00:01', 'hello'];
  const lines = ['00:01', 'hello', 'B', '00:02', 'bye'];
  const r = T.mergeSnapshot(out, lines);
  assert.deepEqual(r.lines, ['A', '00:01', 'hello', 'B', '00:02', 'bye']);
  assert.equal(r.overlap, 2);
  assert.equal(r.added, 3);
  assert.deepEqual(out, ['A', '00:01', 'hello']);
});

test('mergeSnapshot keeps legitimately repeated lines inside a snapshot', () => {
  const r = T.mergeSnapshot(['x'], ['x', 'Yeah.', 'Yeah.', 'Yeah.']);
  assert.deepEqual(r.lines, ['x', 'Yeah.', 'Yeah.', 'Yeah.']);
});

test('mergeSnapshot keeps repeated blocks when the real overlap is longer than the repeat', () => {
  // Two identical entries (same speaker, timestamp and text) straddle the snapshot boundary.
  // The true overlap is 4 lines, so the longest match finds it and keeps the second copy.
  const block = ['Sam 00:05:12', 'Yeah.'];
  const out = ['Ann 00:05:01', 'So the proof...', ...block];
  const lines = ['Ann 00:05:01', 'So the proof...', ...block, ...block, 'Ann 00:05:20', 'Next.'];
  assert.deepEqual(T.mergeSnapshot(out, lines).lines, [...out, ...block, 'Ann 00:05:20', 'Next.']);
});

test('findOverlap matches the reference implementation on random inputs', () => {
  // Small alphabet so repeats and partial matches are common.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const pick = () => 'abc'[Math.floor(rnd() * 3)];
  for (let n = 0; n < 5000; n++) {
    const out = Array.from({ length: Math.floor(rnd() * 12) }, pick);
    const lines = Array.from({ length: Math.floor(rnd() * 12) }, pick);
    assert.equal(T.findOverlap(out, lines), referenceOverlap(out, lines), JSON.stringify({ out, lines }));
  }
});

test('sanitizeFilename removes illegal characters and trims', () => {
  assert.equal(T.sanitizeFilename('Lecture 7: Graphs / Trees?'), 'Lecture 7 Graphs Trees');
  assert.equal(T.sanitizeFilename('  a<b>c|d*e"f  '), 'a b c d e f');
  assert.equal(T.sanitizeFilename('name...'), 'name');
  assert.equal(T.sanitizeFilename('CON'), '_CON');
  assert.equal(T.sanitizeFilename(''), '');
  assert.equal(T.sanitizeFilename(null), '');
});

test('sanitizeFilename caps length at 120 characters', () => {
  assert.equal(T.sanitizeFilename('x'.repeat(500)).length, 120);
});

test('formatDuration', () => {
  assert.equal(T.formatDuration(0), '0s');
  assert.equal(T.formatDuration(44_600), '45s');
  assert.equal(T.formatDuration(187_000), '3m 07s');
  assert.equal(T.formatDuration(3_720_000), '1h 02m');
  assert.equal(T.formatDuration(-5), '0s');
});

test('estimateRemainingMs', () => {
  assert.equal(T.estimateRemainingMs(10_000, 0.5), 10_000);
  assert.equal(T.estimateRemainingMs(30_000, 0.75), 10_000);
  assert.equal(T.estimateRemainingMs(5_000, 1), 0);
  assert.equal(T.estimateRemainingMs(1_000, 0.5), null); // too early
  assert.equal(T.estimateRemainingMs(10_000, 0.01), null); // too little progress
  assert.equal(T.estimateRemainingMs(10_000, 0), null);
});

test('cleanSourceUrl drops query (passcodes) and fragment', () => {
  assert.equal(
    T.cleanSourceUrl('https://us02web.zoom.us/rec/share/AbC123?pwd=secret&startTime=1#x'),
    'https://us02web.zoom.us/rec/share/AbC123',
  );
  assert.equal(T.cleanSourceUrl('chrome://extensions'), '');
  assert.equal(T.cleanSourceUrl('not a url'), '');
  assert.equal(T.cleanSourceUrl(undefined), '');
});

test('findDateInText recognises common date formats', () => {
  assert.equal(T.findDateInText('Recorded Nov 12, 2026 09:58 AM by host'), 'Nov 12, 2026 09:58 AM');
  assert.equal(T.findDateInText('Date: September 3rd 2026'), 'September 3rd 2026');
  assert.equal(T.findDateInText('12 Nov 2026, 14:05'), '12 Nov 2026, 14:05');
  assert.equal(T.findDateInText('on 2026-11-12 09:58:00 UTC'), '2026-11-12 09:58:00');
  assert.equal(T.findDateInText('11/12/2026 9:58 PM'), '11/12/2026 9:58 PM');
  assert.equal(T.findDateInText('starts at 10:30, no date'), null);
  assert.equal(T.findDateInText('© 2026 Zoom'), null);
});

test('timestampSpan prefers timestamp-only lines and ignores times in speech', () => {
  const lines = ['Ann', '00:00:03', "Let's meet at 3:30 tomorrow, everyone, and bring the slides.", 'Bob', '01:52:10', 'Bye.'];
  assert.deepEqual(T.timestampSpan(lines), { first: '00:00:03', last: '01:52:10' });
  assert.deepEqual(T.timestampSpan(['Ann 00:01', 'Hello', 'Bob 12:34', 'Bye at 5:00 then.']), { first: '00:01', last: '12:34' });
  assert.equal(T.timestampSpan(['no times here']), null);
});

test('buildHeader includes known fields only', () => {
  const lines = ['Ann', '00:00:03', 'Hi', 'Bob', '00:10:00', 'Bye'];
  assert.deepEqual(
    T.buildHeader({ title: 'Lecture 7', recorded: 'Nov 12, 2026', source: 'https://x.zoom.us/rec/play/1', exported: 'today', lines }),
    [
      'Title: Lecture 7',
      'Recorded: Nov 12, 2026',
      'Source: https://x.zoom.us/rec/play/1',
      'Exported: today',
      'Timestamps: 00:00:03 to 00:10:00',
      'Lines: 6',
      '='.repeat(60),
      '',
    ],
  );
  const partial = T.buildHeader({ lines: ['a'], partial: true });
  assert.deepEqual(partial, ['Lines: 1', 'Note: partial transcript (the export was cancelled before the end).', '='.repeat(60), '']);
});

test('buildFilename', () => {
  assert.equal(T.buildFilename('Week 3 - Recursion'), 'Week 3 - Recursion - transcript.txt');
  assert.equal(T.buildFilename(''), 'transcript.txt');
  assert.equal(T.buildFilename('???'), 'transcript.txt');
});
