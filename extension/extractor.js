/*
 * Zoom Transcript Exporter: page-side code.
 *
 * Injected by popup.js into every frame of the active tab, right after lib/text.js.
 * It runs in the extension's isolated world, so it shares the DOM with the page but not
 * the page's JavaScript globals. It defines globalThis.__zte once per frame:
 *
 *   __zte.detect()        cheap check: is there a transcript panel in this frame?
 *   __zte.start({title})  start the export in this frame (returns immediately)
 *
 * The long-running work happens here in the page, not in the popup, because the popup
 * closes as soon as it loses focus. Progress and Cancel live in an in-page overlay.
 */
(() => {
  'use strict';

  if (globalThis.__zte) return; // already injected into this frame by an earlier click

  const T = globalThis.ZTEText;
  const LOG = '[ZTE]';

  const CONFIG = {
    stepRatio: 0.7, // scroll 70% of the panel per step, so consecutive snapshots overlap
    bottomTolerance: 5, // px; "at the bottom" when within this distance
    maxIterations: 5000, // hard cap; a 2-hour lecture needs a few hundred
    renderTimeoutMs: 1500, // max wait for the panel to re-render after a scroll
    fastTimeoutMs: 250, // max wait once we've learned the panel doesn't re-render on scroll
    quietMs: 80, // after the first DOM change, wait until changes stop for this long
    fastModeAfter: 3, // consecutive scrolls without DOM changes before switching to fastTimeoutMs
    gapRetries: 3, // how often to back up when a snapshot doesn't overlap the previous one
    minLines: 3, // at or below this many lines the result is treated as "empty"
  };

  const MESSAGES = {
    empty: "The transcript looks empty or didn't load. Scroll the panel once manually and retry.",
    cancelled: 'Export cancelled.',
    unexpected: 'Something went wrong. See the console for details.',
  };

  // ---------------------------------------------------------------------------
  // Panel detection
  // ---------------------------------------------------------------------------

  /**
   * Every element that looks like a scrollable transcript list. Same heuristic as the reference script:
   * it scrolls vertically, has at least 200px of hidden content, is shorter than the window
   * (which rules out the page's own scroller), and its text contains a timestamp.
   * Zoom's class names change, so we don't rely on them.
   */
  function findCandidates(root = document) {
    const view = root.defaultView || window;
    const candidates = [];
    for (const el of root.querySelectorAll('*')) {
      // Cheapest checks first. innerText is the expensive one, so it runs last.
      if (!(el.scrollHeight > el.clientHeight + 200) || !(el.clientHeight < view.innerHeight)) continue;
      const overflowY = view.getComputedStyle(el).overflowY;
      if (overflowY !== 'auto' && overflowY !== 'scroll') continue;
      const text = el.innerText;
      if (!T.hasTimestamp(text)) continue;
      candidates.push({ el, scrollHeight: el.scrollHeight, timestamps: T.countTimestamps(text) });
    }
    return candidates;
  }

  /**
   * The most likely transcript panel, or null. Never throws.
   * Largest scrollHeight wins, as in the reference. A virtualized list reports the full
   * transcript height, so it beats any wrapper around it. Ties go to the element with
   * more timestamps.
   */
  function findTranscriptPanel(root = document) {
    try {
      const candidates = findCandidates(root);
      candidates.sort((a, b) => b.scrollHeight - a.scrollHeight || b.timestamps - a.timestamps);
      return candidates[0] || null;
    } catch (err) {
      console.warn(LOG, 'Panel detection failed', err);
      return null;
    }
  }

  /** Cross-origin iframes we can't look into. Reported to the popup to help explain a "not found" result. */
  function countInaccessibleFrames() {
    let n = 0;
    for (const f of document.querySelectorAll('iframe, frame')) {
      try {
        if (!f.contentDocument) n++;
      } catch {
        n++;
      }
    }
    return n;
  }

  // ---------------------------------------------------------------------------
  // Waiting for the panel to render
  // ---------------------------------------------------------------------------

  /**
   * Resolve once the panel has re-rendered after a scroll.
   *
   * The reference script slept a fixed 400 ms. That's too short when rendering is slow
   * or lazy, and wasted time when it's fast. Instead we watch the panel's DOM: after the
   * first change, wait until changes stop for `quietMs`, so a render split across several
   * commits isn't snapshotted halfway. If nothing changes, give up after `timeoutMs`.
   * Attribute changes are ignored, because Zoom highlights the current line with a class
   * and that would keep resetting the quiet timer.
   *
   * Resolves to true if the DOM changed, false on timeout. Resolves early if `signal` aborts.
   */
  function waitForRender(el, { timeoutMs, quietMs, signal }) {
    return new Promise((resolve) => {
      let mutated = false;
      let done = false;
      let quietTimer = 0;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        observer.disconnect();
        signal?.removeEventListener('abort', finish);
        resolve(mutated);
      };
      const observer = new MutationObserver(() => {
        mutated = true;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      });
      observer.observe(el, { childList: true, subtree: true, characterData: true });
      const maxTimer = setTimeout(finish, timeoutMs);
      if (signal?.aborted) finish();
      else signal?.addEventListener('abort', finish);
    });
  }

  /** Resolve when the tab is visible again (or `signal` aborts). */
  function waitUntilVisible(signal) {
    return new Promise((resolve) => {
      const done = () => {
        document.removeEventListener('visibilitychange', onChange);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const onChange = () => {
        if (!document.hidden) done();
      };
      if (!document.hidden || signal?.aborted) return resolve();
      document.addEventListener('visibilitychange', onChange);
      signal?.addEventListener('abort', done);
    });
  }

  // ---------------------------------------------------------------------------
  // Extraction loop
  // ---------------------------------------------------------------------------

  /**
   * Scroll `box` from top to bottom, collecting every rendered line exactly once.
   * Returns { status: 'done' | 'cancelled' | 'capped', lines: string[] }.
   * `onPause(true|false)` is called when the export pauses/resumes because the tab is hidden.
   */
  async function extractTranscript(box, { signal, onProgress, onPause, config = CONFIG } = {}) {
    const originalTop = box.scrollTop;
    // 'instant' overrides any CSS `scroll-behavior: smooth`. A smooth scroll would leave
    // scrollTop unchanged when we read it back, which looks like being stuck.
    const scrollTo = (top) => box.scrollTo({ top, behavior: 'instant' });
    const snapshot = () => T.splitLines(box.innerText);
    const atBottom = () => box.scrollTop + box.clientHeight >= box.scrollHeight - config.bottomTolerance;
    const progress = () => {
      const max = box.scrollHeight - box.clientHeight;
      return max > 0 ? Math.min(1, Math.max(0, box.scrollTop / max)) : 1;
    };

    // If several scrolls in a row cause no DOM change, the list isn't virtualized (everything
    // is already rendered). Waiting the full timeout each step would then be wasted, so we
    // switch to a short timeout until a change shows up again.
    let scrollsWithoutRender = 0;
    const settle = async ({ patient = false } = {}) => {
      const fast = !patient && scrollsWithoutRender >= config.fastModeAfter;
      const mutated = await waitForRender(box, {
        timeoutMs: fast ? config.fastTimeoutMs : config.renderTimeoutMs,
        quietMs: config.quietMs,
        signal,
      });
      scrollsWithoutRender = mutated ? 0 : scrollsWithoutRender + 1;
    };

    // Browsers stop rendering hidden tabs: scroll events aren't dispatched and the list
    // doesn't re-render, so snapshots taken in a background tab would be stale and lines
    // would be lost. While the tab is hidden we pause, and we look again once it's back.
    const pauseWhileHidden = async () => {
      if (!document.hidden || signal?.aborted) return false;
      onPause?.(true);
      await waitUntilVisible(signal);
      onPause?.(false);
      return true;
    };
    const settleVisible = async (opts) => {
      await settle(opts);
      while (!signal?.aborted && (await pauseWhileHidden())) await settle({ patient: true });
    };

    let out = [];
    try {
      await pauseWhileHidden();
      if (box.scrollTop !== 0) {
        scrollTo(0);
        await settleVisible();
      }
      out = snapshot();

      for (let i = 0; ; i++) {
        await pauseWhileHidden();
        if (signal?.aborted) return { status: 'cancelled', lines: out };
        if (i >= config.maxIterations) {
          console.warn(LOG, `Stopped after ${config.maxIterations} steps (iteration cap).`);
          return { status: 'capped', lines: out };
        }
        onProgress?.({ lines: out.length, progress: progress() });

        if (atBottom()) {
          // Final snapshot, so the last rows aren't missed. Wait patiently first. Some lists
          // load more rows when you reach the end; if the panel grew, keep going.
          const heightBefore = box.scrollHeight;
          await settleVisible({ patient: true });
          out = T.mergeSnapshot(out, snapshot()).lines;
          if (box.scrollHeight > heightBefore + config.bottomTolerance && !atBottom()) continue;
          break;
        }

        const before = box.scrollTop;
        scrollTo(before + box.clientHeight * config.stepRatio);
        await settleVisible();
        if (signal?.aborted) continue; // handled at the top of the loop

        if (Math.abs(box.scrollTop - before) < 1) {
          // Scrolling had no effect, so treat this as the end to avoid looping forever.
          out = T.mergeSnapshot(out, snapshot()).lines;
          break;
        }

        let lines = snapshot();
        let overlap = T.findOverlap(out, lines);

        // Gap guard. We move less than one panel height per step, so the old and new views
        // always share at least one row. Zero overlap means the list skipped rows (it hadn't
        // finished rendering, or it rendered past them). Back up halfway and look again
        // instead of silently dropping lines.
        for (let r = 0; overlap === 0 && out.length && lines.length && r < config.gapRetries; r++) {
          if (signal?.aborted) break;
          scrollTo((before + box.scrollTop) / 2);
          await settleVisible({ patient: true });
          lines = snapshot();
          overlap = T.findOverlap(out, lines);
        }
        if (signal?.aborted) continue;

        out = out.concat(lines.slice(overlap));
      }

      onProgress?.({ lines: out.length, progress: 1 });
      return { status: 'done', lines: out };
    } finally {
      // Put the panel back where the user had it.
      scrollTo(originalTop);
    }
  }

  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------

  const OWN_HOSTS = new Set(['zte-overlay-host', 'zte-picker-host']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);

  /**
   * The first calendar date shown on the page outside the transcript panel (Zoom shows the
   * recording date near the title), or null. Text inside the panel is skipped, because a
   * date mentioned in the lecture is not the recording date.
   */
  function findRecordedDate(panel) {
    if (!document.body) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (node === panel || OWN_HOSTS.has(node.id) || SKIP_TAGS.has(node.tagName.toUpperCase())) {
          return NodeFilter.FILTER_REJECT; // skips the whole subtree
        }
        return NodeFilter.FILTER_SKIP;
      },
    });
    for (let n = walker.nextNode(), i = 0; n && i < 20000; n = walker.nextNode(), i++) {
      const date = T.findDateInText(n.data);
      if (date) return date;
    }
    return null;
  }

  /** The text that goes into the file: optional header, then the transcript lines. */
  function buildFileText(lines, { header, title, url, recorded, partial }) {
    if (!header) return lines.join('\n');
    const head = T.buildHeader({
      title,
      recorded,
      source: T.cleanSourceUrl(url),
      exported: new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
      lines,
      partial,
    });
    return [...head, ...lines].join('\n');
  }

  function downloadText(text, title) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = T.buildFilename(title);
    // The anchor is deliberately never attached to the document (as in the reference
    // script). Page-level click handlers, such as an SPA router, can't intercept it.
    a.click();
    // Revoke a little later. Revoking right after click() can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // ---------------------------------------------------------------------------
  // Progress overlay
  // ---------------------------------------------------------------------------

  const OVERLAY_CSS = `
    :host { all: initial; }
    .card {
      box-sizing: border-box; width: 340px; padding: 14px 16px; border-radius: 10px;
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #ffffff; color: #1f2328; border: 1px solid #d0d7de;
      box-shadow: 0 8px 24px rgba(0,0,0,.18);
    }
    .title { font-weight: 600; margin: 0 0 8px; }
    .warn {
      margin: 0 0 10px; padding: 8px 10px; border-radius: 6px;
      font-weight: 700; font-size: 14.5px; line-height: 1.35;
      background: #fff8c5; color: #3b2300; border: 1px solid #d4a72c;
    }
    .warn.paused { background: #ffebe9; color: #82071e; border-color: #ff8182; }
    .msg { margin: 0 0 8px; }
    .time { margin: 0 0 10px; font-size: 13px; color: #59636e; font-variant-numeric: tabular-nums; }
    .bar { height: 6px; border-radius: 3px; background: #e6e8eb; overflow: hidden; margin-bottom: 8px; }
    .fill { height: 100%; width: 0%; background: #3b5bdb; transition: width .15s linear; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    button {
      font: inherit; padding: 5px 12px; border-radius: 6px; cursor: pointer;
      border: 1px solid #d0d7de; background: #f6f8fa; color: inherit;
    }
    button.primary { background: #3b5bdb; border-color: #3b5bdb; color: #fff; }
    button:focus-visible { outline: 2px solid #3b5bdb; outline-offset: 2px; }
    [hidden] { display: none !important; }
    .card.error .title { color: #cf222e; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1f2329; color: #e6edf3; border-color: #3d444d; box-shadow: 0 8px 24px rgba(0,0,0,.5); }
      .bar { background: #2d333b; }
      .warn { background: #3b2e00; color: #f2cc60; border-color: #9e6a03; }
      .warn.paused { background: #490202; color: #ffa198; border-color: #da3633; }
      .time { color: #9198a1; }
      .fill, button.primary { background: #5c7cfa; border-color: #5c7cfa; }
      button { background: #2d333b; border-color: #3d444d; }
      .card.error .title { color: #ff7b72; }
    }
  `;

  /**
   * A small card in the page's corner. It is rendered inside a Shadow DOM, so Zoom's CSS
   * can't restyle it and our CSS can't leak into Zoom's page. `all: initial` on the host
   * also blocks inherited styles from the page.
   */
  function createOverlay({ onCancel }) {
    document.getElementById('zte-overlay-host')?.remove();
    const host = document.createElement('div');
    host.id = 'zte-overlay-host';
    host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${OVERLAY_CSS}</style>
      <div class="card" role="status" aria-live="polite">
        <p class="title">Exporting transcript…</p>
        <p class="warn"></p>
        <p class="msg">Starting…</p>
        <div class="bar" role="progressbar" aria-label="Export progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="fill"></div>
        </div>
        <p class="time" aria-live="off"></p>
        <div class="actions">
          <button type="button" data-action="save" hidden></button>
          <button type="button" class="primary" data-action="cancel">Cancel</button>
          <button type="button" data-action="close" hidden>Close</button>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = (sel) => shadow.querySelector(sel);
    const card = $('.card');
    const title = $('.title');
    const warn = $('.warn');
    const msg = $('.msg');
    const bar = $('.bar');
    const fill = $('.fill');
    const time = $('.time');
    const cancelBtn = $('[data-action="cancel"]');
    const closeBtn = $('[data-action="close"]');
    const saveBtn = $('[data-action="save"]');
    let dismissTimer = 0;

    // Clock. "Time taken" is wall-clock time. The "time left" estimate uses only active
    // time, so a pause in a background tab doesn't inflate it.
    const startedAt = Date.now();
    let pausedTotal = 0;
    let pausedSince = 0;
    let lastProgress = 0;
    const elapsed = () => Date.now() - startedAt;
    const active = () => elapsed() - pausedTotal - (pausedSince ? Date.now() - pausedSince : 0);
    const renderTime = () => {
      let left;
      if (pausedSince) left = 'paused';
      else {
        const ms = T.estimateRemainingMs(active(), lastProgress);
        left = ms == null ? 'estimating…' : `about ${T.formatDuration(ms)}`;
      }
      time.textContent = `Time taken: ${T.formatDuration(elapsed())} · Time left: ${left}`;
    };
    const ticker = setInterval(renderTime, 1000);

    const setWarning = (paused) => {
      warn.classList.toggle('paused', paused);
      warn.textContent = paused
        ? 'Paused: this tab is in the background. Come back to this tab to continue.'
        : "Keep this tab open and in front until the export finishes. Don't close it or switch to another tab.";
    };
    setWarning(false);
    renderTime();

    const remove = () => {
      clearTimeout(dismissTimer);
      clearInterval(ticker);
      host.remove();
    };
    cancelBtn.addEventListener('click', () => {
      cancelBtn.disabled = true;
      msg.textContent = 'Cancelling…';
      onCancel();
    });
    closeBtn.addEventListener('click', remove);

    /** Switch to a final state: hide the progress UI, show Close, auto-dismiss. */
    const finish = (heading, text, { isError = false, dismissMs = 4000 } = {}) => {
      clearInterval(ticker);
      card.classList.toggle('error', isError);
      title.textContent = heading;
      msg.textContent = text;
      warn.hidden = true;
      time.hidden = true;
      bar.hidden = true;
      cancelBtn.hidden = true;
      closeBtn.hidden = false;
      clearTimeout(dismissTimer);
      dismissTimer = setTimeout(remove, dismissMs);
    };

    return {
      progress({ lines, progress }) {
        lastProgress = progress;
        const pct = Math.round(progress * 100);
        msg.textContent = `${lines.toLocaleString()} lines collected (${pct}%)`;
        fill.style.width = `${pct}%`;
        bar.setAttribute('aria-valuenow', String(pct));
        renderTime();
      },
      paused(isPaused) {
        if (isPaused && !pausedSince) pausedSince = Date.now();
        if (!isPaused && pausedSince) {
          pausedTotal += Date.now() - pausedSince;
          pausedSince = 0;
        }
        setWarning(isPaused);
        renderTime();
      },
      done(count) {
        finish('Done', `${count.toLocaleString()} lines saved in ${T.formatDuration(elapsed())}.`);
      },
      cancelled(count, onSave) {
        finish(MESSAGES.cancelled, count ? 'You can save the lines collected so far.' : '', { dismissMs: 8000 });
        if (count && onSave) {
          // Saving a partial transcript is opt-in, so a cancel never produces a surprise download.
          saveBtn.textContent = `Save ${count.toLocaleString()} lines`;
          saveBtn.hidden = false;
          saveBtn.addEventListener('click', () => {
            onSave();
            remove();
          });
        }
      },
      error(text) {
        finish("Couldn't export", text, { isError: true, dismissMs: 12000 });
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Manual pick mode: fallback for when detection fails or picks the wrong list
  // ---------------------------------------------------------------------------

  const PICKER_CSS = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    .box {
      position: fixed; box-sizing: border-box; pointer-events: none; border-radius: 4px;
      border: 3px solid #3b5bdb; background: rgba(59, 91, 219, .12);
    }
    .tip {
      position: fixed; pointer-events: none; white-space: nowrap; padding: 4px 8px; border-radius: 4px;
      font: 600 12.5px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #3b5bdb; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.25);
    }
    .tip.bad { background: #cf222e; }
    .banner {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%); pointer-events: auto;
      display: flex; align-items: center; gap: 14px; max-width: calc(100vw - 32px); box-sizing: border-box;
      padding: 10px 12px 10px 16px; border-radius: 10px; background: #1f2328; color: #fff;
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,.35);
    }
    .banner p { margin: 0; }
    .banner button {
      font: inherit; padding: 5px 12px; border-radius: 6px; cursor: pointer; white-space: nowrap;
      border: 1px solid #57606a; background: #2d333b; color: #fff;
    }
    .banner button:focus-visible { outline: 2px solid #8fa8ff; outline-offset: 2px; }
  `;

  /** Innermost element at or above `node` that scrolls vertically, or null. Crosses shadow roots. */
  function scrollableAncestor(node) {
    let el = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (el) {
      // The page's own scroller is never the transcript (same rule as automatic detection).
      if (el === document.documentElement || el === document.body) return null;
      const { overflowY } = getComputedStyle(el);
      if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
      const root = el.getRootNode();
      el = el.parentElement || (root instanceof ShadowRoot ? root.host : null);
    }
    return null;
  }

  // Pick mode runs in every frame at once, because the transcript may be in any of them.
  // When one frame finishes (pick or cancel), it tells the others via postMessage: up to
  // the top frame, and from each frame down to its children. The message carries no data.
  const PICK_END = '__zte_pick_end__';
  let stopPicking = null; // set while pick mode is active in this frame

  function notifyChildFrames() {
    for (let i = 0; i < window.frames.length; i++) window.frames[i].postMessage(PICK_END, '*');
  }

  function broadcastPickEnd() {
    notifyChildFrames();
    if (window.top !== window) window.top.postMessage(PICK_END, '*');
  }

  function enterPickMode(options) {
    stopPicking?.();
    const isTop = window.top === window;
    const host = document.createElement('div');
    host.id = 'zte-picker-host';
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    const shadow = host.attachShadow({ mode: 'open' });
    // The instruction banner only goes in the top frame, so the user sees exactly one.
    shadow.innerHTML = `
      <style>${PICKER_CSS}</style>
      <div class="box" hidden></div>
      <div class="tip" hidden></div>
      ${isTop ? `<div class="banner" role="dialog" aria-label="Select the transcript">
        <p><strong>Click anywhere inside the transcript list</strong> to export it.</p>
        <button type="button">Cancel (Esc)</button>
      </div>` : ''}`;
    document.documentElement.appendChild(host);
    const box = shadow.querySelector('.box');
    const tip = shadow.querySelector('.tip');
    let current = null;

    const isOwn = (e) => e.composedPath().includes(host);
    const highlight = (el) => {
      current = el;
      box.hidden = !el;
      if (!el) return;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    const showTip = (text, bad, x, y) => {
      tip.textContent = text;
      tip.classList.toggle('bad', bad);
      tip.hidden = false;
      tip.style.left = `${Math.max(4, Math.min(x + 14, window.innerWidth - tip.offsetWidth - 8))}px`;
      tip.style.top = `${y + 34 > window.innerHeight ? y - 30 : y + 18}px`;
    };
    const finish = () => {
      end();
      broadcastPickEnd();
    };

    // While picking, clicks select the panel instead of operating the page. Events on our
    // own banner are let through so its Cancel button works.
    const block = (e) => {
      if (isOwn(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const onMove = (e) => {
      if (isOwn(e)) return;
      const el = scrollableAncestor(e.composedPath()[0]);
      highlight(el);
      showTip(el ? 'Click to export this list' : 'Not a scrolling list', !el, e.clientX, e.clientY);
    };
    const onClick = (e) => {
      if (isOwn(e)) return;
      block(e);
      const el = scrollableAncestor(e.composedPath()[0]);
      if (!el) {
        showTip("This area doesn't scroll. Click inside the transcript list.", true, e.clientX, e.clientY);
        return;
      }
      finish();
      if (!window.__zteRunning) begin(el, options);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      block(e);
      finish();
    };
    const onScroll = () => highlight(current);
    const onMessage = (e) => {
      if (e.data !== PICK_END) return;
      notifyChildFrames();
      end();
    };

    const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick', 'contextmenu'];
    const listeners = [
      ['mousemove', onMove, true],
      ['click', onClick, true],
      ['keydown', onKey, true],
      ['scroll', onScroll, true],
      ['message', onMessage, false],
      ...BLOCKED.map((type) => [type, block, true]),
    ];
    for (const [type, fn, capture] of listeners) window.addEventListener(type, fn, capture);
    shadow.querySelector('.banner button')?.addEventListener('click', finish);

    function end() {
      for (const [type, fn, capture] of listeners) window.removeEventListener(type, fn, capture);
      host.remove();
      if (stopPicking === end) stopPicking = null;
    }
    stopPicking = end;
  }

  // ---------------------------------------------------------------------------
  // Entry points called by the popup
  // ---------------------------------------------------------------------------

  /** Fill in defaults for the options the popup sends. */
  function exportOptions({ title, url, header } = {}) {
    return { title: title || document.title, url: url || location.href, header: header !== false };
  }

  /** Run an export of `box` in this frame, guarded by the one-job-per-frame flag. */
  function begin(box, options) {
    window.__zteRunning = true;
    run(box, options).finally(() => {
      window.__zteRunning = false;
    });
  }

  async function run(box, { title, url, header }) {
    const controller = new AbortController();
    const overlay = createOverlay({ onCancel: () => controller.abort() });
    const save = (lines, partial = false) => {
      const recorded = header ? findRecordedDate(box) : null;
      downloadText(buildFileText(lines, { header, title, url, recorded, partial }), title);
    };
    try {
      const result = await extractTranscript(box, {
        signal: controller.signal,
        onProgress: (p) => overlay.progress(p),
        onPause: (isPaused) => overlay.paused(isPaused),
      });
      if (result.status === 'cancelled') {
        overlay.cancelled(result.lines.length, () => save(result.lines, true));
        return;
      }
      if (result.lines.length <= CONFIG.minLines) {
        overlay.error(MESSAGES.empty);
        return;
      }
      save(result.lines);
      overlay.done(result.lines.length);
    } catch (err) {
      console.error(LOG, err);
      overlay.error(MESSAGES.unexpected);
    }
  }

  globalThis.__zte = {
    /** Cheap probe run in every frame. The popup picks the frame with the best match. */
    detect() {
      const panel = findTranscriptPanel();
      if (!panel) return { found: false, running: !!window.__zteRunning, inaccessibleFrames: countInaccessibleFrames() };
      return {
        found: true,
        running: !!window.__zteRunning,
        scrollHeight: panel.scrollHeight,
        timestamps: panel.timestamps,
      };
    },

    /**
     * Start an export in this frame. Returns at once; the job keeps running after the popup closes.
     * options: { title, url, header } (header defaults to true).
     */
    start(options) {
      // Guard against double clicks and a second popup: one job per frame.
      if (window.__zteRunning) return { started: false, reason: 'running' };
      const panel = findTranscriptPanel();
      if (!panel) return { started: false, reason: 'not-found' };
      stopPicking?.();
      begin(panel.el, exportOptions(options));
      return { started: true };
    },

    /** Let the user click the transcript to choose it. Same options as start(). */
    startPicking(options) {
      if (window.__zteRunning) return { started: false, reason: 'running' };
      enterPickMode(exportOptions(options));
      return { started: true };
    },
  };
})();
