# Changelog

All notable changes to **Perlego Book Exporter Pro** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.1.0] - 2026-11-20

### Added
- **Cached Library Manager**: New accessible two-tab Popup UI (`Capture & Export` and `Library`) with storage usage reporting, per-book direct export, individual deletion, and two-step clear-all confirmation.
- **EPUB 3 MathML Preservation**: Clones `<math>` elements into the official `http://www.w3.org/1998/Math/MathML` namespace and declares `properties="mathml"` in `content.opf`.
- **Nested Hierarchical TOC & EPUB 3 Landmarks**: Generates nested `<ol>` navigation in `nav.xhtml`, nested `<navPoint>` with accurate `dtb:depth` in `toc.ncx`, and EPUB 3 `landmarks` (`cover`, `toc`, `bodymatter`).
- **Richer Metadata & Automatic RTL Support**: Extracts publisher and ISBN-13/10 from front matter and detects book language & text direction (`dir="rtl"`, `page-progression-direction="rtl"`) for Persian, Arabic, and Hebrew titles.
- **Section / Page Range Capture**: Optional `From`–`To` inputs in the popup to capture or export specific chapter or page ranges.
- **Per-Tab Action Badge**: Live toolbar progress indicator (`%`, `II`, `EXP`, `OK`, `!`) scoped per tab and cleared automatically on navigation away from Perlego.
- **Interactive Standalone HTML5 Reader Toolbar**: Print-hidden toolbar with 3-state color-scheme override (`System` / `Light` / `Dark`) synced to `<meta name="color-scheme">`, font-size controls (`A−` / `A+`), and **Print / Save PDF** button.
- **Draggable Shadow-DOM HUD & Log Filter**: Draggable HUD header clamped to viewport bounds, skipped-section badge, and an **Issues** filter button for warnings/errors.
- **Repository Tooling & CI**: Added `package.json`, `scripts/check.mjs`, `scripts/pack.mjs`, and GitHub Actions CI workflow.

### Fixed
- **Memory Optimization**: Switched `dataUrl` on fetched assets to a lazy getter, eliminating ~60% RAM overhead during EPUB-only exports.
- **Full `AbortSignal` Cancellation**: Threaded `AbortSignal` through `mapPool`, `fetchAssetsParallel`, `createZipParts`, and all exporters so clicking **Stop** halts active work immediately.
- **Pause-Safe Cached Export**: Separated `exportAbortController` from capture cancellation and restored `paused` state cleanly after exporting cached sections mid-capture.
- **Resilient Asset Recovery**: Added exponential backoff retries for transient `429`/`5xx` errors and automatic fallback to `<picture>` `data-fallback-src` URLs.
- **IndexedDB Transaction Safety**: Rewrote `saveBookMeta` as a single callback-driven transaction to prevent `TransactionInactiveError`.
- **Multi-Tab & SPA Isolation**: Scoped `PD_STATE_UPDATE` broadcasts per `tabId`, omitted bulky log arrays from 150 ms IPC updates, and reset stale idle state on SPA book navigation.
- **Multi-Format Download Reliability**: Spaced consecutive Blob downloads by 350 ms so Chromium does not drop secondary files.
- **PDF & Detached TOC Resilience**: Rejected blank-placeholder GIF frames in PDF capture, added a targeted scroll-into-view recovery pass for missed PDF pages, and re-acquired disconnected TOC click targets.
- **Markdown Quality**: Resolved cross-chapter links to `#section-N`, separated sibling `<div>` blocks, escaped link brackets, and added `<dl>/<dt>/<dd>`, `<table><caption>`, `<mark>`, and `<kbd>` support.

## [4.0.0] - 2026-11-14

### Added
- Complete Manifest V3 architecture with zero runtime dependencies.
- Multi-format export to EPUB 3, GitHub-Flavored Markdown, and standalone HTML5.
- Event-driven `MutationObserver` capture and $O(1)$ per-book IndexedDB cache.
- Built-in PKZIP / OCF writer using native `CompressionStream('deflate-raw')`.
- Two-pass cross-chapter hyperlink resolver for footnotes, citations, figures, tables, and print page anchors.
- Shadow-DOM in-page progress HUD with live logs and quick export actions.
