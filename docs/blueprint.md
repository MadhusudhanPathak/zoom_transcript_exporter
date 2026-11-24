# Blueprint: "Zoom Transcript Exporter" Chromium Extension

**Audience:** an LLM coding agent that will build this extension end to end.
**Target browsers:** Brave, Edge, Chrome, and any other Chromium browser (Manifest V3).
**Goal for v1:** exact functional parity with the console script described below, packaged as a one-click extension.

---

## 1. Problem and use case

Students are given view-only access to Zoom cloud recordings. The recording page shows the video and a scrolling **transcript panel**, but the host has disabled transcript download. Select All (Ctrl+A) fails because the panel only renders the lines currently visible (a virtualized list), and a two-hour lecture is far too long to copy by hand or screenshot.

A console script already solves this. It finds the transcript panel, scrolls it from top to bottom in steps, collects the text that appears at each step, removes the overlap between steps, and downloads the result as `transcript.txt`. It worked in practice. The extension must turn that into a one-click tool anyone can use without opening DevTools.

**The extension only reads text the user can already see in their own browser session.** It makes no network requests, bypasses no authentication, and never touches the video or audio.

---

## 2. Scope

### In scope (v1)
- A toolbar button. Clicking it runs the extraction on the active tab.
- Auto-detect the scrollable transcript panel (same heuristic as the reference script).
- Scroll through the panel, collect lines, de-duplicate overlap, and download `.txt`.
- In-page progress indicator with a Cancel button.
- Clear error messages when the panel isn't found or the result looks empty.
- Works on Zoom recording pages (`*.zoom.us`, and `*.zoomgov.com` if cheap to support).

### Out of scope (v1)
- Downloading video or audio.
- Any server, account, analytics, or telemetry.
- Summarizing or sending the transcript to any AI service.
- Firefox or Safari support.

### Nice-to-have (v1.1, only after v1 passes all tests)
- Option to strip timestamps and/or speaker names.
- Export as `.vtt` or `.srt`.
- Manual "pick the panel" mode (click on the transcript to select it) when auto-detect fails.
- Copy to clipboard in addition to downloading.

---

## 3. Reference algorithm (source of truth for v1 behavior)

This is the script the user ran successfully. Reproduce its behavior; refactor into clean, testable functions but do not change the core logic without a test proving the change is better.

```javascript
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const boxes = [...document.querySelectorAll('*')].filter(e => {
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
  let out = [];
  while (true) {
    const lines = box.innerText.split('\n').filter(l => l.trim());
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
  console.log('Done:', out.length, 'lines');
})();
```

### How it works (the agent must understand this, not just copy it)
1. **Find the panel.** Look for elements that scroll vertically (`overflow-y: auto|scroll`), have much more content than visible height, are shorter than the window, and contain a timestamp pattern like `12:34`. Pick the one with the largest `scrollHeight`.
2. **Scroll to top**, wait for render.
3. **Loop:** read the currently rendered text, split into lines, drop blanks. Compare the start of this snapshot to the end of the collected output to find the longest overlap `k`, then append only the new lines (`lines.slice(k)`).
4. **Advance** by 70% of the panel height (so consecutive snapshots overlap), wait, repeat.
5. **Stop** when scrolled to the bottom (within 5 px).
6. **Download** the joined text as a `.txt` file via a Blob URL.

### Known weaknesses to address in the extension (without changing the output format)
- **Fixed sleeps** (400 ms) can be too short on slow machines or wasteful on fast ones. Replace with: after each scroll, wait for a `MutationObserver` change in the panel or a max timeout (e.g. 1500 ms), whichever comes first.
- **Overlap detection by text only** can wrongly drop genuinely repeated lines (for example two consecutive "Yeah." lines from the same speaker with the same timestamp format). Mitigation: compare in blocks that include timestamp and speaker lines where present; keep the same overall approach.
- **Stuck detection:** if `scrollTop` doesn't change after a scroll attempt, treat it as the end to avoid an infinite loop. Add a hard iteration cap (e.g. 5,000 steps).
- **Hidden or odd layouts:** if multiple candidate panels tie, prefer the one with the most timestamp matches in `innerText`.

---

## 4. Architecture

**Manifest V3, no background service worker needed for v1.** Keep it minimal.

```
zoom-transcript-exporter/
├── manifest.json
├── popup.html
├── popup.css
├── popup.js            # button handler; injects the extractor into the active tab
├── extractor.js        # self-contained function(s) injected into the page
├── lib/
│   └── overlap.js      # pure functions: mergeSnapshot(), stripTimestamps() (unit-testable)
├── icons/              # 16, 32, 48, 128 px PNGs
├── tests/
│   ├── fixtures/virtual-list.html   # mock virtualized transcript page
│   ├── overlap.test.js              # unit tests for pure logic
│   └── e2e.test.js                  # Playwright test loading the extension
├── README.md
└── PRIVACY.md
```

### manifest.json (starting point)

```json
{
  "manifest_version": 3,
  "name": "Zoom Transcript Exporter",
  "version": "0.1.0",
  "description": "Export the transcript panel of a Zoom recording you can already view as a text file.",
  "action": { "default_popup": "popup.html", "default_title": "Export transcript" },
  "permissions": ["activeTab", "scripting"],
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" }
}
```

### Permission decisions
- Use `activeTab` + `scripting`. This grants access only to the tab the user clicks the button on, and only at that moment. No broad host permissions, which keeps the privacy story simple.
- **Verify early** that `chrome.scripting.executeScript({ target: { tabId, allFrames: true } })` reaches the frame containing the transcript. Zoom pages may place the player or panel in an iframe. If `activeTab` does not cover that frame, fall back to adding `"host_permissions": ["https://*.zoom.us/*", "https://*.zoomgov.com/*"]` and document why.
- Do **not** request `downloads`, `storage`, `tabs`, or `<all_urls>`. Downloading works through a Blob URL and an anchor click inside the page, exactly like the reference script.

### Execution flow
1. User opens a Zoom recording page and clicks the extension icon.
2. `popup.js` calls `chrome.scripting.executeScript` with `allFrames: true`, injecting `extractor.js`.
3. In each frame, the extractor first checks whether a transcript panel exists (cheap detection). Frames without one return immediately with `{found: false}`.
4. The frame with the panel runs the extraction loop and shows a small progress overlay (see below).
5. When finished (or cancelled), it triggers the download and removes the overlay. The popup can close at any time without killing the job, because the work runs in the page.

### Why the UI lives in the page, not the popup
Extension popups close when they lose focus, which would hide progress and the Cancel button during a long scroll. So the extractor injects a small overlay into the page.

- Render the overlay inside a **Shadow DOM** so Zoom's CSS cannot break it and it cannot break Zoom's page.
- Content: "Exporting transcript… 1,240 lines collected (63%)", a progress bar, and a **Cancel** button.
- Progress percentage = `scrollTop / (scrollHeight - clientHeight)`.
- On completion show "Done, N lines saved", then auto-dismiss after a few seconds.
- Cancel sets a flag the loop checks every iteration; on cancel, offer to download what was collected so far (default: don't download, to avoid confusion).

---

## 5. Detailed requirements

### 5.1 Panel detection
- Implement `findTranscriptPanel(root = document)` using the reference heuristic.
- Return `null` if nothing matches. Never throw.
- Tie-break by timestamp-match count, then by `scrollHeight`.
- Do **not** hard-code Zoom class names or IDs as the primary strategy, because they change. A Zoom-specific selector may be tried first as an optimization, but the heuristic must remain the fallback.

### 5.2 Extraction loop
- Scroll to top, wait for render.
- Each iteration: snapshot `innerText`, split lines, filter blanks, merge via `mergeSnapshot(out, lines)` (longest suffix/prefix overlap).
- Step size: 70% of `clientHeight`.
- Wait after each scroll: resolve on the first DOM mutation in the panel or after the timeout.
- End conditions: reached bottom (within 5 px), or `scrollTop` unchanged after scroll, or iteration cap hit, or cancelled.
- After reaching the bottom, do one final snapshot so the last lines aren't missed.
- Restore the panel's original scroll position when done (nice touch; low risk).

### 5.3 Output
- Plain text, one line per transcript line, same ordering and content the reference script produces. This is the parity requirement.
- Filename: `<sanitized page title> - transcript.txt`, falling back to `transcript.txt`. Sanitize characters illegal in filenames and cap the length at about 120 characters.
- Use `text/plain;charset=utf-8`. Revoke the Blob URL after the click.

### 5.4 Errors and messages (shown in the overlay or popup)
| Situation | Message |
|---|---|
| No panel found in any frame | "Couldn't find the transcript panel. Open the transcript tab so it's visible, then try again." |
| Panel found but ≤ 3 lines collected | "The transcript looks empty or didn't load. Scroll the panel once manually and retry." |
| Cancelled | "Export cancelled." |
| Unexpected exception | "Something went wrong. See the console for details." (log the error with a `[ZTE]` prefix) |

### 5.5 Popup UI
- Title, one-sentence instructions ("Open the recording, make sure the transcript panel is visible, then click Export."), and an **Export transcript** button.
- Disable the button and show a hint if the active tab isn't a supported page (for example a `chrome://` URL), where injection would fail.
- Keep the design plain and accessible: keyboard-focusable button, sufficient contrast, support light and dark via `prefers-color-scheme`.

### 5.6 Non-functional
- Zero network requests. Zero external scripts, fonts, or CDNs.
- No `eval`, no remote code (MV3 requirement).
- Must not noticeably freeze the page: keep per-iteration work small and yield to the event loop between steps.
- Handle a 2-hour lecture (roughly 1,000 to 3,000 transcript entries) in under about two minutes on a typical laptop.
- Idempotent: running twice shouldn't create two overlays or two concurrent loops (guard with a `window.__zteRunning` flag).

---

## 6. Build plan for the agent (do these in order)

1. **Scaffold** the project structure and `manifest.json`. Load it unpacked and confirm the popup opens.
2. **Write `lib/overlap.js`** with `mergeSnapshot()` and (stub) `stripTimestamps()` as pure functions. Write unit tests first: overlap at various offsets, no overlap, full overlap, repeated identical lines, empty inputs.
3. **Build the test fixture** `tests/fixtures/virtual-list.html`: a page with a scrollable panel that renders only about 20 transcript entries at a time (virtualized), with timestamps like `00:01:23`, speaker names, and text. Include a variant with repeated identical lines and a variant that loads content lazily with a delay.
4. **Write `extractor.js`**: detection, loop, overlay, download. Keep it self-contained, since injected functions can't import modules.
5. **Wire `popup.js`** to inject the extractor with `allFrames: true` and handle per-frame results.
6. **Playwright e2e test:** launch Chromium with the extension loaded, open the fixture, trigger the extraction, and assert the downloaded file equals the full expected transcript (line count and exact content, in order, no duplicates, no missing lines).
7. **Manual test on a real Zoom recording** (the user will do this; provide a short checklist in the README).
8. **Polish:** icons, error messages, README, PRIVACY.md.
9. **Package** as a zip for distribution.

---

## 7. Acceptance tests (definition of done)

- [ ] On the virtualized fixture, output contains every entry exactly once, in order.
- [ ] On the repeated-lines fixture, legitimate repeated lines are preserved.
- [ ] On the lazy-loading fixture, no lines are lost despite delayed rendering.
- [ ] If the panel is absent, the user sees the "couldn't find" message and nothing is downloaded.
- [ ] Cancel stops the loop within about one second and removes the overlay.
- [ ] Clicking Export twice doesn't start two jobs.
- [ ] The extension works when loaded unpacked in Brave and Edge (manual check).
- [ ] The manifest requests only `activeTab` and `scripting` (plus `*.zoom.us` host permissions only if the iframe check in section 4 forced it).
- [ ] No network requests are made (verify in the e2e test by failing on any request not to the fixture origin).
- [ ] On the user's real Zoom recording, output matches what the original console script produced (line count within a small tolerance, same format).

---

## 8. Installation instructions to include in the README

**Developer-mode install (works in Brave, Edge, Chrome):**
1. Go to `brave://extensions`, `edge://extensions`, or `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `zoom-transcript-exporter` folder.
4. Pin the extension from the puzzle-piece menu.

**Use:**
1. Open the Zoom recording and enter the passcode.
2. Make sure the transcript panel is visible.
3. Click the extension icon, then **Export transcript**.
4. Wait for the progress overlay to finish. A `.txt` file downloads.

---

## 9. Privacy and responsible-use notes

- **PRIVACY.md** should state plainly: the extension runs only when the user clicks it, reads only the transcript text already displayed on the page, processes it locally, and saves a file to the user's computer. It collects, stores, and transmits nothing.
- **README disclaimer:** this tool exports text the user is already authorized to view. Users are responsible for following their institution's and the host's rules on recordings and transcripts. It does not bypass passcodes, authentication, or any access controls.
- If the extension is ever published to the Chrome Web Store or Edge Add-ons, the single-purpose description and minimal permissions above are what reviewers look for. Brave installs from the Chrome Web Store.

---

## 10. Constraints and instructions for the coding agent

- Use **plain JavaScript** (ES2022). No build step, framework, or bundler for v1. The project should load unpacked with zero setup.
- Dev dependencies are allowed only for tests (for example Vitest or Node's built-in test runner, plus Playwright).
- Comment the non-obvious parts (overlap merge, why the overlay uses Shadow DOM, why sleeps became mutation waits).
- Prefer small pure functions over one big async blob, so each piece is testable.
- Don't add features outside section 2 "In scope" until all acceptance tests pass.
- If a requirement conflicts with reality (for example `activeTab` doesn't reach an iframe), choose the least-privilege fix, document the decision in the README, and continue.
- At the end, output: the full file tree, how to run the tests, how to load the extension, and a list of any assumptions or deviations from this blueprint.

---

## 11. Assumptions made (change these if wrong)

1. v1 = exact parity with the script: **timestamps and speaker names included**, output as `.txt`.
2. Distribution is **personal and sideloaded** (developer mode), with optional later publishing.
3. Only **Zoom cloud recording pages** matter. No other video platforms.
4. Chromium only. No Firefox or Safari.
5. No settings page for v1. The one button is the whole interface.
