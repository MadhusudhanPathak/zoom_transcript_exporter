# Zoom Transcript Exporter v1.0.0

Save the transcript of a Zoom cloud recording as a `.txt` file in one click. It works in Microsoft Edge, Google Chrome, Brave and other Chromium browsers.

On a Zoom recording page you can't copy the whole transcript, because the panel only shows the lines near where you've scrolled. This extension scrolls through the panel for you, collects every line once, and downloads the result.

## What's included

- One-click export of the transcript panel to `<recording title> - transcript.txt`, with speaker names and timestamps included.
- A progress card on the page that shows lines collected, percentage, **time taken** and **estimated time left**, with a **Cancel** button.
- A clear reminder to keep the tab open and in front during the export. If you switch tabs anyway, the export pauses and resumes when you come back, so no lines are lost.
- Handles transcripts that render slowly or only partly, and keeps genuinely repeated lines such as two "Yeah." lines in a row.
- After a cancel you can save the lines collected so far, or nothing is saved.
- **Optional header** at the top of the file: title, recording date, link to the recording (with any passcode removed), export time, first and last timestamps, and line count. It's on by default; untick it in the popup for the plain transcript.
- **Select transcript manually**: if the transcript isn't found automatically, or the wrong list is exported, click this and then click the transcript on the page.

## Install

Download **`zoom-transcript-exporter-1.0.0.zip`** below and unzip it.

The extension isn't in a web store yet, so you load it in developer mode:

1. Open `edge://extensions` (Edge), `chrome://extensions` (Chrome) or `brave://extensions` (Brave).
2. Turn on **Developer mode**. In Edge it's in the left sidebar; in Chrome and Brave it's at the top right.
3. Click **Load unpacked** and select the unzipped folder, the one that contains `manifest.json`.
4. Click the puzzle-piece icon in the toolbar and pin **Zoom Transcript Exporter**.

Keep the unzipped folder where it is. The browser loads the extension from it.

## Use

1. Open the Zoom recording and enter the passcode if asked.
2. Open the transcript panel so it's visible, and **pause the video**.
3. Click the extension icon, then **Export transcript**.
4. **Keep the tab open and in front** until the card says **Done**. The file is saved to your Downloads folder.

If the popup says it couldn't find the transcript, click **Select transcript manually**, then click anywhere inside the transcript list. Press **Esc** to cancel.

## Privacy

The extension runs only when you click it. It reads only the transcript text already shown on the page and saves it to your computer. It makes no network requests and collects or sends nothing. It stores only your header on/off choice. Its only permissions are `activeTab` and `scripting`.

## Please use responsibly

This tool exports text you're already allowed to see in your own browser. It does not bypass passcodes, sign-in or any access controls, and it never touches the video or audio. Follow your institution's and the meeting host's rules about recordings and transcripts.

## Verify the download (optional)

`SHA256SUMS.txt` contains the zip's SHA-256 checksum. On Windows, in PowerShell:

```powershell
Get-FileHash .\zoom-transcript-exporter-1.0.0.zip -Algorithm SHA256
```

The hash should match the one in `SHA256SUMS.txt`, ignoring upper/lower case.

## License and source

Free software under the [GNU General Public License v3.0](https://github.com/MadhusudhanPathak/zoom_transcript_exporter/blob/main/LICENSE). A copy of the license is included in the zip. Source code, issues and full documentation: <https://github.com/MadhusudhanPathak/zoom_transcript_exporter>.
