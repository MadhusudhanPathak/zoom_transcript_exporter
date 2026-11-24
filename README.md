# Zoom Transcript Exporter

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/MadhusudhanPathak/zoom_transcript_exporter)](https://github.com/MadhusudhanPathak/zoom_transcript_exporter/releases/latest)

A browser extension for Microsoft Edge, Google Chrome, Brave and other Chromium browsers that saves the transcript of a Zoom cloud recording as a `.txt` file in one click.

On a Zoom recording page, the transcript panel only shows the lines near your scroll position, so you can't select and copy the whole thing. This extension scrolls through the panel for you, collects every line exactly once, and downloads the result.

> **Responsible use.** This tool only exports text you can already see in your own browser session. It does not bypass passcodes, sign-in, or any access controls, and it never touches the video or audio. Follow your institution's and the host's rules on recordings and transcripts.

## Features

- **One click.** Finds the transcript panel automatically and saves `<recording title> - transcript.txt`.
- **Complete and in order.** Every line appears once, and genuinely repeated lines (two "Yeah."s in a row) are kept.
- **Progress on the page.** Lines collected, percentage, time taken, estimated time left, and a **Cancel** button.
- **Safe to look away.** If you switch tabs, the export pauses and resumes when you come back, so no lines are lost.
- **Optional header.** Adds the title, recording date, link (with any passcode removed), export time, timestamp range and line count.
- **Manual fallback.** If the transcript isn't found automatically, click **Select transcript manually**, then click the transcript.
- **Private.** No network requests, no tracking, no accounts. It only asks for `activeTab` and `scripting`. See [PRIVACY.md](PRIVACY.md).

## Install

The extension isn't in a web store yet, so it's installed in developer mode.

1. Download `zoom-transcript-exporter-<version>.zip` from the [latest release](https://github.com/MadhusudhanPathak/zoom_transcript_exporter/releases/latest) and unzip it. Keep the folder where it is; the browser loads the extension from it.
2. Open `edge://extensions`, `chrome://extensions` or `brave://extensions`.
3. Turn on **Developer mode**. In Edge it's in the left sidebar; in Chrome and Brave it's at the top right.
4. Click **Load unpacked** and select the unzipped folder, the one that contains `manifest.json`.
5. Click the puzzle-piece icon in the toolbar and pin **Zoom Transcript Exporter**.

Working from a clone of this repository instead? Load the **`extension/`** folder.

**Updating:** download the new zip, replace the folder's contents, and click **Reload** on the extension's card.

## Use

1. Open the Zoom recording and enter the passcode if asked.
2. Open the transcript panel so it's visible, and **pause the video** so Zoom doesn't auto-scroll the transcript during the export.
3. Click the extension icon, then **Export transcript**.
4. A progress card appears in the bottom-right corner of the page. **Keep the tab open and in front** until it says **Done**. The file is then saved to your Downloads folder.

**Cancel** stops the export. Nothing is saved unless you click **Save N lines** to keep what was collected so far.

### If the transcript isn't found

Click **Select transcript manually** in the popup. A bar at the top of the page asks you to click the transcript. The list under your pointer is outlined. Click anywhere inside the transcript list and the export starts. Press **Esc** to cancel.

If the popup also mentions an **embedded frame**, see [Transcript inside an iframe](#transcript-inside-an-iframe).

## Output format

One line per transcript line, in order, with speaker names and timestamps included, as UTF-8 plain text.

By default the file starts with a header. Untick **Add a header with recording details** in the popup to get the transcript alone. The popup remembers your choice.

```text
Title: Lecture 7: Graph Algorithms
Recorded: Nov 12, 2026 09:58 AM
Source: https://us02web.zoom.us/rec/play/AbC123
Exported: Nov 24, 2026, 2:05 PM
Timestamps: 00:00:03 to 01:52:10
Lines: 2431
============================================================

Dr. Alvarez
00:00:03
Good morning, everyone…
```

| Field | Meaning |
| --- | --- |
| Title | The browser tab's title |
| Recorded | The first date shown on the page outside the transcript (left out if none is found) |
| Source | The recording's address **without** its `?…` part. Zoom links can carry the passcode as `?pwd=…`, which must not end up in a file you might share. The address can still open the recording for anyone who has the passcode, so share files with care. |
| Timestamps | First and last timestamps in the transcript, which give the recording's length |
| Lines | Number of transcript lines below the header |

## Privacy

The extension runs only when you click it. It reads only the transcript text already displayed on the page and saves it to your computer. It makes no network requests and collects or sends nothing. It stores only your header on/off choice. Details are in [PRIVACY.md](PRIVACY.md).

## Transcript inside an iframe

The extension can read the tab you click it on, and only at that moment (`activeTab`). It looks inside all frames of that tab. If Zoom ever puts the transcript in a frame from a **different website**, the extension may not be allowed in, and the popup will mention an embedded frame. The fix is to add this line to `manifest.json` and reload the extension:

```json
"host_permissions": ["https://*.zoom.us/*", "https://*.zoomgov.com/*"]
```

It isn't included by default because it hasn't been needed, and leaving it out keeps the permissions minimal.

## Development

The extension is plain JavaScript (Manifest V3) with no build step. Node 22+ is needed only for the tests and tooling.

```sh
npm install                       # dev dependency: @playwright/test
npx playwright install chromium   # once: the browser used by the e2e tests
npm test                          # unit tests (node:test)
npm run test:e2e                  # end-to-end tests: real extension in Chromium against mock pages
npm run test:all                  # both
npm run icons                     # regenerate extension/icons/*.png
npm run package                   # build Release/zoom-transcript-exporter-<version>.zip + SHA256SUMS.txt
```

`HEADED=1 npm run test:e2e` shows the browser while the tests run.

```text
extension/              the extension itself (load this folder unpacked)
  manifest.json         MV3; permissions: activeTab, scripting
  popup.html/.css/.js   popup UI; injects the extractor and starts an export or pick mode
  extractor.js          page-side code: detection, scroll loop, overlay, pick mode, header, download
  lib/text.js           pure helpers shared by extractor.js and the unit tests
  icons/                generated by tools/make-icons.js
tests/
  unit/                 node:test unit tests
  e2e/                  Playwright end-to-end tests
  fixtures/             mock recording pages (virtualized, lazy, repeated lines, iframe, …)
tools/                  icon generator and zip packager (no dependencies)
Release/                files attached to GitHub releases
docs/blueprint.md       the original design brief
AGENTS.md               architecture, decisions and conventions for contributors and coding agents
```

### How it works

1. **Find the panel.** In every frame, look for elements that:
   - scroll vertically,
   - hide at least 200 px of content,
   - are shorter than the window,
   - and contain a timestamp such as `12:34`.

   The tallest one wins. Zoom's class names aren't used, because they change.
2. **Scroll and collect.** Starting at the top, read the panel's rendered text, then scroll 70% of its height so consecutive readings overlap. Each reading is merged by finding the longest overlap with what's already collected and appending only the new lines.
3. **Wait for rendering, not a fixed time.** After each scroll, a `MutationObserver` waits for the list to re-render and settle (up to 1.5 s).
4. **Guards.**
   - If a reading doesn't overlap the previous one, rows were skipped, so it backs up and reads again.
   - The export pauses while the tab is hidden.
   - It stops at the bottom, or when scrolling has no effect, or after 5,000 steps.
5. **Save.** Restore the panel's scroll position, add the optional header, and download a UTF-8 text file through a Blob URL.

### Making a release

1. Bump `version` in `extension/manifest.json` and `package.json`.
2. Run `npm run test:all`, then `npm run package`.
3. Update `Release/RELEASE_NOTES.md`.
4. On GitHub, go to **Releases → Draft a new release**. Create the tag `v<version>`, paste `RELEASE_NOTES.md` as the description, and attach the `.zip` and `SHA256SUMS.txt` from `Release/`.

### Manual test checklist (real Zoom recording)

- [ ] The popup opens. On `edge://`, `chrome://` or `brave://` pages its buttons are disabled with a hint.
- [ ] **Export transcript:**
  - the card shows the bold "keep this tab open" warning
  - the percentage rises and the time taken counts up
  - a time-left estimate appears within a few seconds
  - the panel scrolls
- [ ] Switch tabs for a few seconds, then come back: the card shows **Paused**, then the export continues.
- [ ] A `.txt` file downloads, and its name matches the page title.
- [ ] Spot-check the start, middle and end of the file against the panel for missing or doubled lines.
- [ ] With the header on, check:
  - **Recorded** shows the recording's date
  - **Source** has no `?pwd=`
- [ ] With the header off: the file has no header, and the popup remembers the setting.
- [ ] **Select transcript manually:**
  - hovering outlines the transcript
  - clicking it exports
  - **Esc** cancels and the page works normally again
- [ ] With the transcript panel closed, Export shows "Couldn't find the transcript panel…".
- [ ] **Cancel:** the export stops within about a second and the panel returns to where it was.
- [ ] Export while an export is already running: the popup says one is already running.
- [ ] DevTools → Network: no requests during an export.

### Known limitations

- If the video is playing, Zoom may auto-scroll the transcript and fight the export. Pause first.
- Transcripts inside shadow DOM or cross-origin iframes aren't detected automatically (see above).
- The **Recorded** date is the first date shown on the page, which is a heuristic.

## Contributing

Issues and pull requests are welcome. Please run `npm run test:all` before opening a pull request, and read [AGENTS.md](AGENTS.md) for the design decisions and the rules the code keeps:

- no network requests
- minimal permissions
- one-line-per-line output parity
- passcodes never written to files

## License

Copyright (C) 2026 the Zoom Transcript Exporter contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License, version 3, as published by the Free Software Foundation. It is distributed in the hope that it will be useful, but **without any warranty**; without even the implied warranty of merchantability or fitness for a particular purpose. See [LICENSE](LICENSE) for the full text.
