# Privacy Policy

**Last updated:** November 20, 2026

**Perlego Book Exporter Pro** is designed to operate 100% locally inside your browser.

## Data Collection & Transmission

- **No telemetry or analytics**: This extension does not collect, log, sell, or transmit usage analytics, browsing history, or personal information to any developer server or third party.
- **Local storage only**:
  - User preferences (selected formats, speed preset, mode, and optional section range) are stored locally in `chrome.storage.local`.
  - Captured book sections and metadata are cached locally in the browser's `IndexedDB` (`PerlegoDownloaderDB`) under `https://ereader.perlego.com` so captures can pause, resume, and export offline. You can delete individual books or clear all cached data at any time from the extension's **Library** tab.
- **Direct network requests**: The extension only communicates with `https://*.perlego.com/*` and `https://*.cloudfront.net/*` (using your active browser session when required) to fetch book images and SVG assets for embedding into your local EPUB or HTML exports.

## Permissions Explained

| Permission | Purpose |
| :--- | :--- |
| `storage` & `unlimitedStorage` | Save extension preferences and cache large books locally in IndexedDB without quota truncation. |
| `scripting` | Inject the capture and export modules on demand when you interact with the extension on a Perlego reader tab. |
| `tabs` | Verify the active tab URL is on `*.perlego.com` and scope progress badges and status messages to the correct tab. |
| `notifications` | Show an optional desktop notification when an export completes. |
| Host permissions (`https://*.perlego.com/*`, `https://*.cloudfront.net/*`) | Read active reader chapters on Perlego and download book images/SVG pages for offline EPUB and HTML embedding. |
