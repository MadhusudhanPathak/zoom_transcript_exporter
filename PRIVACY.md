# Privacy policy: Zoom Transcript Exporter

**Short version: the extension collects, stores and sends nothing.**

- **When it runs:** only when you click its toolbar button and then **Export transcript**. It has no background process and does nothing on pages you don't click it on.
- **What it reads:** the transcript text that is already displayed in the page you're viewing. It does not read the video, audio, cookies, passwords or form fields.
- **Where the data goes:** the text is processed locally in your browser tab and saved as a `.txt` file to your computer through your browser's normal download. Nothing is sent anywhere.
- **Network:** the extension makes no network requests. It uses no servers, analytics, telemetry, ads, or third-party scripts, fonts or libraries.
- **Storage:** it remembers one setting, whether to add a header to the file, in the browser's local storage for the extension's popup. It stores no transcripts, history, URLs or identifiers.
- **File header:** when enabled, the saved file starts with the page title, the date shown on the page, the recording's address and the export time. The address is saved **without** its query part, so a passcode in the link (`?pwd=…`) is never written to the file.
- **Permissions:**
  - `activeTab` gives temporary access to the tab you click it on, only at that moment.
  - `scripting` lets it run the export code in that tab.

  It doesn't request `downloads`, `storage`, `tabs`, or access to all websites.

Questions or concerns: open an issue at <https://github.com/MadhusudhanPathak/zoom_transcript_exporter/issues>.
