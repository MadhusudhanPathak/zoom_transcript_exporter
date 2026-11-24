// End-to-end tests: load the real extension into Chromium and export from the mock recording page.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test: base, expect, chromium } = require('@playwright/test');

const ROOT = path.join(__dirname, '..', '..');
const EXTENSION_SRC = path.join(ROOT, 'extension');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
// Fake origin. Every request is answered by context.route below, so nothing touches the network.
const ORIGIN = 'http://zte.test';

/**
 * Copy the extension and add two TEST-ONLY manifest entries:
 *  - host access to the fixture origin. Under automation nobody clicks the toolbar
 *    button, so activeTab is never granted; this stands in for that grant.
 *  - an empty service worker, only so the test can read the extension's ID.
 * The shipped manifest is checked separately (tests/unit/manifest.test.js).
 */
function prepareExtensionCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zte-ext-'));
  fs.cpSync(EXTENSION_SRC, dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [`${ORIGIN}/*`];
  manifest.background = { service_worker: 'test-sw.js' };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'test-sw.js'), '// test only\n');
  return dir;
}

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const extDir = prepareExtensionCopy();
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', // full Chromium build: required for extensions in headless mode
      headless: !process.env.HEADED,
      acceptDownloads: true,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });

    // Serve fixtures from the fake origin and record any other request as a violation.
    const violations = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      // The extension's own packaged files (popup.js, …) are local, not network traffic.
      if (url.protocol === 'chrome-extension:') return route.continue();
      if (url.origin === ORIGIN) {
        const file = path.join(FIXTURES, path.basename(url.pathname));
        if (url.pathname.endsWith('.html') && fs.existsSync(file)) {
          return route.fulfill({ path: file, contentType: 'text/html; charset=utf-8' });
        }
        return route.fulfill({ status: 404, body: '' });
      }
      violations.push(url.href);
      return route.abort();
    });

    await use(context);
    await context.close();
    fs.rmSync(extDir, { recursive: true, force: true });
    expect(violations, 'requests outside the fixture origin').toEqual([]);
  },

  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    await use(new URL(worker.url()).host);
  },
});

/** Open a fixture page. */
async function openFixture(context, query, file = 'virtual-list.html') {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/${file}${query ? `?${query}` : ''}`);
  return page;
}

/**
 * Do what clicking "Export transcript" in the popup does: call the popup's
 * exportFromTab() for `page`'s tab. Then close the popup and bring the page to the
 * front, as happens for a real user.
 * `times` > 1 fires several exports at once (double-click test).
 * `header` defaults to false here so most tests can compare the file to the transcript exactly.
 */
async function clickExport(context, extensionId, page, { times = 1, header = false } = {}) {
  const popup = await openPopup(context, extensionId);
  const outcomes = await popup.evaluate(
    async ({ url, times, options }) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
      // eslint-disable-next-line no-undef
      return Promise.all(Array.from({ length: times }, () => exportFromTab(tab, options)));
    },
    { url: page.url(), times, options: { header } },
  );
  await closePopup(popup, page);
  return times === 1 ? outcomes[0] : outcomes;
}

/** What clicking "Select transcript manually" in the popup does. */
async function clickPick(context, extensionId, page, { header = false } = {}) {
  const popup = await openPopup(context, extensionId);
  const outcome = await popup.evaluate(
    async ({ url, options }) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
      // eslint-disable-next-line no-undef
      return pickFromTab(tab, options);
    },
    { url: page.url(), options: { header } },
  );
  await closePopup(popup, page);
  return outcome;
}

async function openPopup(context, extensionId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return popup;
}

async function closePopup(popup, page) {
  await popup.close();
  await page.bringToFront();
}

async function readDownload(download) {
  return fs.readFileSync(await download.path(), 'utf8');
}

const overlay = (page) => page.locator('#zte-overlay-host');

/** Run the reference console script (from the blueprint) in the page and return its download. */
async function runReferenceScript(page) {
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const boxes = [...document.querySelectorAll('*')].filter((e) => {
      const o = getComputedStyle(e).overflowY;
      return (o === 'auto' || o === 'scroll') &&
        e.scrollHeight > e.clientHeight + 200 &&
        e.clientHeight < window.innerHeight &&
        /\d{1,2}:\d{2}/.test(e.innerText);
    });
    const box = boxes.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (!box) return console.log('Transcript panel not found');
    box.scrollTop = 0;
    await sleep(500);
    const out = [];
    while (true) {
      const lines = box.innerText.split('\n').filter((l) => l.trim());
      let k = Math.min(out.length, lines.length);
      while (k > 0 && out.slice(-k).join('\n') !== lines.slice(0, k).join('\n')) k--;
      out.push(...lines.slice(k));
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 5) break;
      box.scrollTop += box.clientHeight * 0.7;
      await sleep(400);
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out.join('\n')], { type: 'text/plain' }));
    a.download = 'transcript.txt';
    a.click();
  });
  return readDownload(await downloadPromise);
}

// ---------------------------------------------------------------------------

const CASES = [
  { name: 'virtualized list', query: 'variant=basic&count=600' },
  { name: 'repeated identical lines', query: 'variant=repeated&count=600' },
  { name: 'lazy (delayed) rendering', query: 'variant=lazy&count=150&delay=500' },
  { name: 'non-virtualized list', query: 'variant=plain&count=300' },
  { name: 'smooth-scrolling panel', query: 'variant=basic&count=200&smooth=1' },
];

for (const c of CASES) {
  test(`exports every entry exactly once, in order: ${c.name}`, async ({ context, extensionId }) => {
    const page = await openFixture(context, c.query);
    const expected = await page.evaluate(() => window.fixture.expectedLines());
    const downloadPromise = page.waitForEvent('download', { timeout: 150_000 });

    expect(await clickExport(context, extensionId, page)).toEqual({ state: 'started' });
    await expect(overlay(page)).toContainText('Keep this tab open');
    await expect(overlay(page)).toContainText(/Time taken: \d+s · Time left: /);
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('Lecture 7 Graph Algorithms - transcript.txt');
    const lines = (await readDownload(download)).split('\n');
    expect(lines.length).toBe(expected.length);
    expect(lines).toEqual(expected);

    await expect(overlay(page)).toContainText(`${expected.length.toLocaleString('en-US')} lines saved in `);
    // The panel is scrolled back to where it started.
    expect(await page.evaluate(() => window.fixture.panel.scrollTop)).toBe(0);
    // The overlay auto-dismisses.
    await expect(overlay(page)).toHaveCount(0, { timeout: 10_000 });
  });
}

test('repeated-lines fixture really contains identical consecutive entries', async ({ context }) => {
  const page = await openFixture(context, 'variant=repeated&count=600');
  const dupes = await page.evaluate(() =>
    window.fixture.entries.filter((e, i, all) => i > 0 && JSON.stringify(e) === JSON.stringify(all[i - 1])).length,
  );
  expect(dupes).toBeGreaterThan(5);
});

test('output matches the reference console script (parity)', async ({ context, extensionId }) => {
  const query = 'variant=repeated&count=300';
  const referencePage = await openFixture(context, query);
  const reference = await runReferenceScript(referencePage);
  await referencePage.close();

  const page = await openFixture(context, query);
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  await clickExport(context, extensionId, page);
  const ours = await readDownload(await downloadPromise);

  expect(ours).toBe(reference);
});

test('the reference script loses lines on lazy rendering, which the extension handles', async ({ context }) => {
  // Evidence for replacing fixed sleeps with mutation-based waits (blueprint section 3).
  const page = await openFixture(context, 'variant=lazy&count=150&delay=500');
  const expected = await page.evaluate(() => window.fixture.expectedLines());
  const reference = (await runReferenceScript(page)).split('\n');
  expect(reference.length).toBeLessThan(expected.length);
});

test('finds a transcript inside a same-origin iframe', async ({ context, extensionId }) => {
  const page = await openFixture(context, '', 'iframe.html');
  const frame = page.frames().find((f) => f.url().includes('virtual-list.html'));
  await frame.waitForFunction(() => window.fixture);
  const expected = await frame.evaluate(() => window.fixture.expectedLines());
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });

  expect(await clickExport(context, extensionId, page)).toEqual({ state: 'started' });
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Lecture 8 Iframe Player - transcript.txt');
  expect((await readDownload(download)).split('\n')).toEqual(expected);
});

test('shows a time-left estimate once it has enough data', async ({ context, extensionId }) => {
  const page = await openFixture(context, 'variant=basic&count=3000');
  await clickExport(context, extensionId, page);
  await expect(overlay(page)).toContainText(/Time left: about \d/, { timeout: 10_000 });
  await overlay(page).getByRole('button', { name: 'Cancel' }).click();
});

test('pauses while the tab is in the background, then finishes with nothing lost', async ({ context, extensionId }) => {
  const page = await openFixture(context, 'variant=basic&count=400');
  const expected = await page.evaluate(() => window.fixture.expectedLines());
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  const scrollTop = () => page.evaluate(() => window.fixture.panel.scrollTop);

  await clickExport(context, extensionId, page);
  await expect(overlay(page)).toContainText('lines collected');
  await page.waitForTimeout(800);

  // Headless Chromium never marks background tabs as hidden, so simulate it the way the
  // extractor sees it: override document.hidden in the extension's isolated world and fire
  // the visibilitychange event the browser would fire.
  const extPage = await context.newPage();
  await extPage.goto(`chrome-extension://${extensionId}/popup.html`);
  const setHidden = (hidden) =>
    extPage.evaluate(
      async ({ url, hidden }) => {
        const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [hidden],
          func: (h) => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
            document.dispatchEvent(new Event('visibilitychange'));
          },
        });
      },
      { url: page.url(), hidden },
    );

  // Tab goes to the background: the export must pause, not keep scrolling blind.
  await setHidden(true);
  await expect(overlay(page)).toContainText('Paused: this tab is in the background');
  await expect(overlay(page)).toContainText('Time left: paused');
  const pausedAt = await scrollTop();
  await page.waitForTimeout(1500);
  expect(await scrollTop()).toBe(pausedAt);

  // Tab comes back: it resumes and the result is complete.
  await setHidden(false);
  await extPage.close();
  await page.bringToFront();
  await expect(overlay(page)).toContainText('Keep this tab open');
  expect((await readDownload(await downloadPromise)).split('\n')).toEqual(expected);
});

test('no panel: reports "not found" and downloads nothing', async ({ context, extensionId }) => {
  const page = await openFixture(context, 'variant=none');
  let downloaded = false;
  page.on('download', () => (downloaded = true));

  expect(await clickExport(context, extensionId, page)).toEqual({ state: 'not-found', inaccessibleFrames: 0 });
  await page.waitForTimeout(1500);
  expect(downloaded).toBe(false);
  await expect(overlay(page)).toHaveCount(0);
});

test('empty transcript: shows the "looks empty" message and downloads nothing', async ({ context, extensionId }) => {
  const page = await openFixture(context, 'variant=empty');
  let downloaded = false;
  page.on('download', () => (downloaded = true));

  expect(await clickExport(context, extensionId, page)).toEqual({ state: 'started' });
  await expect(overlay(page)).toContainText('The transcript looks empty', { timeout: 15_000 });
  expect(downloaded).toBe(false);
});

test('cancel stops the loop quickly and offers the partial transcript', async ({ context, extensionId }) => {
  const page = await openFixture(context, 'variant=basic&count=3000');
  const expected = await page.evaluate(() => window.fixture.expectedLines());
  let downloads = 0;
  page.on('download', () => downloads++);

  expect(await clickExport(context, extensionId, page)).toEqual({ state: 'started' });
  await expect(overlay(page)).toContainText('lines collected');
  await page.waitForTimeout(1000);

  const cancelledAt = Date.now();
  await overlay(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(overlay(page)).toContainText('Export cancelled.', { timeout: 1500 });
  expect(Date.now() - cancelledAt).toBeLessThan(1500);

  // The loop has stopped: the panel is back at its original position and stays there.
  expect(await page.evaluate(() => window.fixture.panel.scrollTop)).toBe(0);
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.fixture.panel.scrollTop)).toBe(0);
  expect(downloads).toBe(0);

  // The partial transcript is only saved when asked for, and is a clean prefix of the full one.
  const downloadPromise = page.waitForEvent('download');
  await overlay(page).getByRole('button', { name: /^Save [\d,]+ lines$/ }).click();
  const partial = (await readDownload(await downloadPromise)).split('\n');
  expect(partial.length).toBeGreaterThan(0);
  expect(partial.length).toBeLessThan(expected.length);
  expect(partial).toEqual(expected.slice(0, partial.length));
  await expect(overlay(page)).toHaveCount(0);
});

test('clicking Export twice does not start two jobs', async ({ context, extensionId }) => {
  const page = await openFixture(context, 'variant=basic&count=3000');

  const outcomes = await clickExport(context, extensionId, page, { times: 2 });
  expect(outcomes.map((o) => o.state).sort()).toEqual(['running', 'started']);
  // A later click while the job is still running is refused too.
  expect(await clickExport(context, extensionId, page)).toEqual({ state: 'running' });
  await expect(overlay(page)).toHaveCount(1);

  await overlay(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(overlay(page)).toContainText('Export cancelled.');
});

// ---------------------------------------------------------------------------
// File header
// ---------------------------------------------------------------------------

test('header: recording details above the transcript, passcode stripped from the link', async ({ context, extensionId }) => {
  const page = await openFixture(context, 'variant=basic&count=200&pwd=SECRET');
  const expected = await page.evaluate(() => window.fixture.expectedLines());
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });

  expect(await clickExport(context, extensionId, page, { header: true })).toEqual({ state: 'started' });
  const file = (await readDownload(await downloadPromise)).split('\n');

  const sep = file.indexOf('='.repeat(60));
  expect(sep).toBeGreaterThan(0);
  const header = file.slice(0, sep);
  expect(header[0]).toBe('Title: Lecture 7: Graph Algorithms');
  expect(header[1]).toBe('Recorded: Nov 12, 2026 09:58 AM');
  expect(header[2]).toBe(`Source: ${ORIGIN}/virtual-list.html`);
  expect(header[3]).toMatch(/^Exported: .*2026/);
  expect(header[4]).toBe(`Timestamps: ${expected[1]} to ${expected[expected.length - 2]}`);
  expect(header[5]).toBe(`Lines: ${expected.length}`);
  expect(file.join('\n')).not.toContain('SECRET');
  // One blank line, then the transcript unchanged.
  expect(file[sep + 1]).toBe('');
  expect(file.slice(sep + 2)).toEqual(expected);
});

// ---------------------------------------------------------------------------
// Manual pick mode
// ---------------------------------------------------------------------------

const picker = (page) => page.locator('#zte-picker-host');

/** Centre of an element in page coordinates (works for elements inside iframes too). */
async function centreOf(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('pick mode: exports a panel that automatic detection cannot find', async ({ context, extensionId }) => {
  // No timestamps and no chat: the heuristic finds nothing.
  const page = await openFixture(context, 'variant=basic&count=200&ts=0&chat=0');
  const expected = await page.evaluate(() => window.fixture.expectedLines());
  // Count clicks that reach the page, to prove pick mode swallows them.
  await page.evaluate(() => {
    window.pageClicks = 0;
    document.addEventListener('click', () => window.pageClicks++);
  });

  expect((await clickExport(context, extensionId, page)).state).toBe('not-found');
  expect(await clickPick(context, extensionId, page)).toEqual({ state: 'picking' });
  await expect(picker(page)).toContainText('Click anywhere inside the transcript list');

  // Hovering the list highlights it.
  const panel = await centreOf(page.locator('#panel'));
  await page.mouse.move(panel.x, panel.y);
  await expect(picker(page)).toContainText('Click to export this list');

  // Clicking something that doesn't scroll explains why and stays in pick mode.
  const video = await centreOf(page.locator('#video'));
  await page.mouse.click(video.x, video.y);
  await expect(picker(page)).toContainText("This area doesn't scroll");
  await expect(overlay(page)).toHaveCount(0);

  // Clicking the list exports it.
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  await page.mouse.click(panel.x, panel.y);
  await expect(picker(page)).toHaveCount(0);
  expect((await readDownload(await downloadPromise)).split('\n')).toEqual(expected);
  expect(await page.evaluate(() => window.pageClicks)).toBe(0);
});

test('pick mode: Esc cancels without exporting', async ({ context, extensionId }) => {
  const page = await openFixture(context, 'variant=basic&count=200&ts=0&chat=0');
  expect(await clickPick(context, extensionId, page)).toEqual({ state: 'picking' });
  await expect(picker(page)).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);

  // Clicks work normally again and nothing is exported.
  const panel = await centreOf(page.locator('#panel'));
  await page.mouse.click(panel.x, panel.y);
  await page.waitForTimeout(500);
  await expect(overlay(page)).toHaveCount(0);
});

test('pick mode: picking inside an iframe exports it and ends pick mode in every frame', async ({ context, extensionId }) => {
  const page = await openFixture(context, '', 'iframe.html');
  const frame = page.frames().find((f) => f.url().includes('virtual-list.html'));
  await frame.waitForFunction(() => window.fixture);
  const expected = await frame.evaluate(() => window.fixture.expectedLines());

  expect(await clickPick(context, extensionId, page)).toEqual({ state: 'picking' });
  await expect(picker(page)).toContainText('Click anywhere inside the transcript list'); // banner in the top frame

  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  const panel = await centreOf(page.frameLocator('#player').locator('#panel'));
  await page.mouse.move(panel.x, panel.y);
  await page.mouse.click(panel.x, panel.y);

  // The top frame's banner disappears because the iframe told it picking is over.
  await expect(picker(page)).toHaveCount(0);
  await expect(page.frameLocator('#player').locator('#zte-picker-host')).toHaveCount(0);
  expect((await readDownload(await downloadPromise)).split('\n')).toEqual(expected);
});

test('pick mode is refused while an export is running', async ({ context, extensionId }) => {
  const page = await openFixture(context, 'variant=basic&count=3000');
  expect(await clickExport(context, extensionId, page)).toEqual({ state: 'started' });
  expect(await clickPick(context, extensionId, page)).toEqual({ state: 'running' });
  await expect(picker(page)).toHaveCount(0);
  await overlay(page).getByRole('button', { name: 'Cancel' }).click();
});
