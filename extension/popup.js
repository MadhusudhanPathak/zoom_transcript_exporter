/*
 * Popup: decides whether the active tab can be scripted, injects the extractor into all of
 * its frames, and either starts the export in the frame that holds the transcript panel or
 * switches the page into "click the transcript" pick mode.
 * The export itself runs in the page (see extractor.js), so this popup can close at any time.
 */
'use strict';

const POPUP_MESSAGES = {
  notFound:
    "Couldn't find the transcript panel. Open the transcript tab so it's visible and try again, or use Select transcript manually.",
  frames:
    'Part of this page is in an embedded frame the extension may not be allowed to read. See the README section "Transcript inside an iframe".',
  running: 'An export is already running on this page.',
  started: 'Export started. Keep the tab open and in front until it finishes. You can close this popup.',
  picking: 'Now click anywhere inside the transcript list on the page. Press Esc to cancel.',
  unsupported: "Extensions can't run on this page. Open a Zoom recording in a normal tab.",
  notZoom: "This doesn't look like a Zoom page, but you can still try.",
  noAccess: "The extension wasn't allowed to read this page. Reload the page and try again.",
  unexpected: 'Something went wrong. See the console for details.',
};

// Pages where browsers block extension scripts. Injection would fail, so we disable the buttons up front.
const BLOCKED_URL = [
  /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|extension|devtools|view-source|chrome-search|chrome-untrusted):/i,
  /^https:\/\/chromewebstore\.google\.com\//i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^https:\/\/microsoftedge\.microsoft\.com\/addons/i,
];
const ZOOM_URL = /^https:\/\/([a-z0-9-]+\.)*(zoom\.us|zoomgov\.com)(\/|$)/i;

// The header checkbox is remembered in the popup's own localStorage (an extension page),
// so no "storage" permission is needed. It holds only this one on/off value.
const HEADER_PREF_KEY = 'zte.header';

/** 'blocked' | 'zoom' | 'other' | 'unknown' (URL not visible to us) */
function classifyUrl(url) {
  if (!url) return 'unknown';
  if (BLOCKED_URL.some((re) => re.test(url))) return 'blocked';
  if (ZOOM_URL.test(url)) return 'zoom';
  return 'other';
}

/** Options passed to the page. `title` and `url` come from the tab, so they're right even when the transcript is in an iframe. */
function pageOptions(tab, { header = true } = {}) {
  return { title: tab.title || '', url: tab.url || '', header };
}

/** Inject lib/text.js + extractor.js into every frame (the extractor guards against double definition). */
async function injectAll(tab) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['lib/text.js', 'extractor.js'] });
}

/** Ask every frame whether it has a transcript panel / a running export. */
async function probeFrames(tab) {
  const probes = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => (globalThis.__zte ? globalThis.__zte.detect() : { found: false }),
  });
  return probes.filter((p) => p && p.result);
}

/**
 * Find the transcript in `tab` and start exporting it.
 * Resolves to { state: 'started' | 'running' | 'not-found' | 'error', ... }.
 * Kept free of UI code so the e2e tests can call it directly.
 */
async function exportFromTab(tab, options) {
  await injectAll(tab);
  const results = await probeFrames(tab);
  if (results.some((p) => p.result.running)) return { state: 'running' };

  const hits = results.filter((p) => p.result.found);
  if (!hits.length) {
    const inaccessibleFrames = results.reduce((n, p) => n + (p.result.inaccessibleFrames || 0), 0);
    return { state: 'not-found', inaccessibleFrames };
  }

  // Start in the best frame: same ranking as inside a frame (tallest list, then most timestamps).
  hits.sort((a, b) => b.result.scrollHeight - a.result.scrollHeight || b.result.timestamps - a.result.timestamps);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [hits[0].frameId] },
    func: (opts) => globalThis.__zte.start(opts),
    args: [pageOptions(tab, options)],
  });
  if (result && result.started) return { state: 'started' };
  return { state: (result && result.reason) || 'error' };
}

/**
 * Put every frame of `tab` into pick mode: the user then clicks the transcript to export it.
 * Resolves to { state: 'picking' | 'running' | 'error' }.
 */
async function pickFromTab(tab, options) {
  await injectAll(tab);
  const results = await probeFrames(tab);
  if (results.some((p) => p.result.running)) return { state: 'running' };
  const started = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: (opts) => (globalThis.__zte ? globalThis.__zte.startPicking(opts) : { started: false }),
    args: [pageOptions(tab, options)],
  });
  return started.some((r) => r && r.result && r.result.started) ? { state: 'picking' } : { state: 'error' };
}

// ---------------------------------------------------------------------------
// UI wiring (skipped when this file is loaded outside the popup)
// ---------------------------------------------------------------------------

function setStatus(text, kind = '') {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = kind;
}

function setHint(text) {
  const el = document.getElementById('hint');
  el.textContent = text || '';
  el.hidden = !text;
}

function describeError(err) {
  console.error('[ZTE]', err);
  const denied = /cannot access|cannot be scripted|permission/i.test(String(err && err.message));
  return denied ? POPUP_MESSAGES.noAccess : POPUP_MESSAGES.unexpected;
}

async function initPopup() {
  const exportBtn = document.getElementById('export');
  const pickBtn = document.getElementById('pick');
  const headerBox = document.getElementById('header');
  const buttons = [exportBtn, pickBtn];
  const setBusy = (busy) => buttons.forEach((b) => (b.disabled = busy));

  headerBox.checked = localStorage.getItem(HEADER_PREF_KEY) !== '0';
  headerBox.addEventListener('change', () => localStorage.setItem(HEADER_PREF_KEY, headerBox.checked ? '1' : '0'));
  const options = () => ({ header: headerBox.checked });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const kind = classifyUrl(tab && tab.url);
  if (!tab || kind === 'blocked') {
    setBusy(true);
    setHint(POPUP_MESSAGES.unsupported);
    return;
  }
  if (kind === 'other') setHint(POPUP_MESSAGES.notZoom);

  exportBtn.addEventListener('click', async () => {
    setBusy(true);
    setStatus('Looking for the transcript…');
    try {
      const outcome = await exportFromTab(tab, options());
      switch (outcome.state) {
        case 'started':
          setStatus(POPUP_MESSAGES.started, 'ok');
          setTimeout(() => window.close(), 2500);
          return; // keep the buttons disabled
        case 'running':
          setStatus(POPUP_MESSAGES.running);
          return;
        case 'not-found':
          setStatus(POPUP_MESSAGES.notFound, 'error');
          if (outcome.inaccessibleFrames) setHint(POPUP_MESSAGES.frames);
          pickBtn.classList.add('suggested');
          break;
        default:
          setStatus(POPUP_MESSAGES.unexpected, 'error');
      }
    } catch (err) {
      setStatus(describeError(err), 'error');
    }
    setBusy(false);
  });

  pickBtn.addEventListener('click', async () => {
    setBusy(true);
    try {
      const outcome = await pickFromTab(tab, options());
      if (outcome.state === 'picking') {
        setStatus(POPUP_MESSAGES.picking, 'ok');
        // Close so the user can click the page (a click on the page would close it anyway).
        setTimeout(() => window.close(), 1800);
        return;
      }
      setStatus(outcome.state === 'running' ? POPUP_MESSAGES.running : POPUP_MESSAGES.unexpected, outcome.state === 'running' ? '' : 'error');
    } catch (err) {
      setStatus(describeError(err), 'error');
    }
    setBusy(false);
  });
}

if (document.getElementById('export')) {
  initPopup().catch((err) => setStatus(describeError(err), 'error'));
}
