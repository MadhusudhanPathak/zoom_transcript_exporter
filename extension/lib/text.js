/*
 * Pure text helpers. No DOM access, no side effects.
 *
 * This file is used in two places:
 *   1. Injected into the page (before extractor.js) by chrome.scripting.executeScript.
 *      Injected files are classic scripts, so there is no import/export; the helpers
 *      are attached to globalThis.ZTEText instead.
 *   2. Loaded by the Node unit tests through module.exports.
 * Keeping one copy means the tested code is exactly the shipped code.
 */
(function (root) {
  'use strict';

  // Same pattern the reference console script uses to decide "this looks like a transcript".
  const TIMESTAMP_TEST = /\d{1,2}:\d{2}/;
  // Counting variant used only to break ties between candidate panels (matches 1:23, 12:34, 01:02:03).
  const TIMESTAMP_ALL = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

  /** Split rendered text into lines, dropping blank ones. Lines are kept untrimmed (reference parity). */
  function splitLines(text) {
    return String(text ?? '').split('\n').filter((l) => l.trim());
  }

  function hasTimestamp(text) {
    return TIMESTAMP_TEST.test(String(text ?? ''));
  }

  function countTimestamps(text) {
    const m = String(text ?? '').match(TIMESTAMP_ALL);
    return m ? m.length : 0;
  }

  /**
   * Length of the longest suffix of `out` that equals a prefix of `lines`.
   *
   * Why: a virtualized list only renders the rows near the viewport. We scroll by 70% of
   * the panel height, so each new snapshot starts with rows we already collected. The
   * longest suffix/prefix match tells us where the old rows end and the new ones begin.
   * Preferring the *longest* match matters: a short match (e.g. one "Yeah." line) could be
   * a coincidence, while the true overlap is usually several rows long.
   *
   * Behaviourally identical to the reference script's
   *   while (k > 0 && out.slice(-k).join('\n') !== lines.slice(0, k).join('\n')) k--;
   * (lines never contain '\n', so element-wise equality == joined equality), but it
   * avoids building two strings per candidate k.
   */
  function findOverlap(out, lines) {
    for (let k = Math.min(out.length, lines.length); k > 0; k--) {
      const offset = out.length - k;
      let i = 0;
      while (i < k && out[offset + i] === lines[i]) i++;
      if (i === k) return k;
    }
    return 0;
  }

  /**
   * Merge a new snapshot into the collected output.
   * Returns a new array; inputs are not modified.
   */
  function mergeSnapshot(out, lines) {
    const overlap = findOverlap(out, lines);
    const added = lines.slice(overlap);
    return { lines: out.concat(added), overlap, added: added.length };
  }

  const MAX_BASENAME = 120;
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  /** Make a string safe to use as a file name on Windows, macOS and Linux. Returns '' if nothing usable is left. */
  function sanitizeFilename(name) {
    let s = String(name ?? '')
      // Characters illegal on Windows (and '/' everywhere), plus control characters.
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (s.length > MAX_BASENAME) s = s.slice(0, MAX_BASENAME).trim();
    // Windows rejects names ending in a dot or space.
    s = s.replace(/[. ]+$/, '');
    if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
    return s;
  }

  /** "<sanitized title> - transcript.txt", or "transcript.txt" when the title is unusable. */
  function buildFilename(title) {
    const base = sanitizeFilename(title);
    return base ? `${base} - transcript.txt` : 'transcript.txt';
  }

  /** Human-friendly duration: "45s", "3m 07s", "1h 02m". */
  function formatDuration(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const pad = (n) => String(n).padStart(2, '0');
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${pad(s % 60)}s`;
    return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
  }

  /**
   * Estimated time left, extrapolated linearly from the time spent so far.
   * Returns null while there's too little data for a meaningful estimate.
   */
  function estimateRemainingMs(activeMs, progress) {
    if (!(progress > 0) || !(activeMs > 0)) return null;
    if (progress >= 1) return 0;
    if (progress < 0.02 || activeMs < 2000) return null;
    return (activeMs * (1 - progress)) / progress;
  }

  // ---------------------------------------------------------------------------
  // File header
  // ---------------------------------------------------------------------------

  /**
   * The recording's address without query string or fragment. Zoom share links can carry
   * the passcode in `?pwd=…`, and that must never end up in a file people pass around.
   */
  function cleanSourceUrl(url) {
    try {
      const u = new URL(String(url));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return `${u.origin}${u.pathname}`;
    } catch {
      return '';
    }
  }

  const MONTH =
    '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const CLOCK = '(?:,?\\s+(?:at\\s+)?\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s?[AaPp]\\.?[Mm]\\.?)?)?';
  const DATE_RE = new RegExp(
    [
      `\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}${CLOCK}`, // Nov 12, 2026 09:58 AM
      `\\b\\d{1,2}\\s+${MONTH}\\.?,?\\s+\\d{4}${CLOCK}`, // 12 Nov 2026 09:58
      `\\b\\d{4}-\\d{2}-\\d{2}(?:[ T]\\d{2}:\\d{2}(?::\\d{2})?)?`, // 2026-11-12 09:58
      `\\b\\d{1,2}/\\d{1,2}/\\d{4}${CLOCK}`, // 11/12/2026 9:58 AM
    ].join('|'),
    'i',
  );

  /** First calendar date (with time, if adjacent) in `text`, exactly as written, or null. */
  function findDateInText(text) {
    const m = String(text ?? '').match(DATE_RE);
    return m ? m[0].trim() : null;
  }

  const TS_ONLY = /^\d{1,2}:\d{2}(?::\d{2})?$/;
  const TS_EDGE = /^(\d{1,2}:\d{2}(?::\d{2})?)\b|\b(\d{1,2}:\d{2}(?::\d{2})?)$/;

  /**
   * First and last transcript timestamps, or null.
   * Prefers lines that are only a timestamp. Otherwise uses short lines (such as
   * "Speaker 00:01:23") that start or end with one. This avoids picking up times mentioned
   * in speech ("let's meet at 3:30 tomorrow, everyone").
   */
  function timestampSpan(lines) {
    const pick = (match) => {
      const found = [];
      for (const raw of lines) {
        const t = match(raw.trim());
        if (t) found.push(t);
      }
      return found.length ? { first: found[0], last: found[found.length - 1] } : null;
    };
    return (
      pick((l) => (TS_ONLY.test(l) ? l : null)) ||
      pick((l) => {
        if (l.length > 60) return null;
        const m = l.match(TS_EDGE);
        return m ? m[1] || m[2] : null;
      })
    );
  }

  /**
   * Header lines placed above the transcript. Fields that are unknown are left out.
   * @param {{title?: string, recorded?: string|null, source?: string, exported?: string, lines: string[], partial?: boolean}} info
   */
  function buildHeader({ title, recorded, source, exported, lines, partial = false }) {
    const out = [];
    if (title && title.trim()) out.push(`Title: ${title.trim()}`);
    if (recorded) out.push(`Recorded: ${recorded}`);
    if (source) out.push(`Source: ${source}`);
    if (exported) out.push(`Exported: ${exported}`);
    const span = timestampSpan(lines);
    if (span) out.push(`Timestamps: ${span.first} to ${span.last}`);
    out.push(`Lines: ${lines.length}`);
    if (partial) out.push('Note: partial transcript (the export was cancelled before the end).');
    out.push('='.repeat(60), '');
    return out;
  }

  const api = {
    cleanSourceUrl,
    findDateInText,
    timestampSpan,
    buildHeader,
    formatDuration,
    estimateRemainingMs,
    splitLines,
    hasTimestamp,
    countTimestamps,
    findOverlap,
    mergeSnapshot,
    sanitizeFilename,
    buildFilename,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZTEText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
