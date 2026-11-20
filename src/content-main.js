/**
 * @file Perlego reader capture controller and message router.
 * Orchestrates ePUB chapter capture, PDF auto-scroll capture, IndexedDB caching,
 * multi-format export pipelines, and Shadow-DOM HUD synchronization.
 */
(() => {
  'use strict';

  const PD = (globalThis.PerlegoDownloader = globalThis.PerlegoDownloader || {});
  if (typeof window !== 'undefined' && window !== window.top) {
    return;
  }
  if (PD.controllerInitialized) {
    return;
  }
  PD.controllerInitialized = true;

  const SPEED_PRESETS = {
    turbo: { settleMs: 40, timeoutMs: 9000, scrollStepMs: 90 },
    balanced: { settleMs: 120, timeoutMs: 12000, scrollStepMs: 180 },
    safe: { settleMs: 300, timeoutMs: 18000, scrollStepMs: 350 },
  };

  const state = {
    status: 'idle', // 'idle' | 'running' | 'paused' | 'exporting'
    activeBookId: '',
    mode: 'auto',
    phaseLabel: 'Ready',
    message: '',
    progress: 0,
    currentItem: 0,
    totalItems: 0,
    cachedCount: 0,
    skippedCount: 0,
    etaSeconds: 0,
    indeterminate: false,
    startedAt: 0,
    itemsCompletedInRun: 0,
    lastBroadcastAt: 0,
    abortController: null,
    exportAbortController: null,
    pauseResolvers: [],
    lastOptions: {
      mode: 'auto',
      formats: ['epub'],
      speed: 'balanced',
      autoScroll: true,
      inlineHtmlImages: false,
      rangeStart: null,
      rangeEnd: null,
    },
    logs: [],
    nextLogId: 1,
  };

  const MAX_LOGS = 600;

  function formatLogTimestamp() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  function addLog(level, text) {
    const entry = {
      id: state.nextLogId++,
      ts: formatLogTimestamp(),
      level: level || 'info',
      text: String(text || ''),
    };
    state.logs.push(entry);
    if (state.logs.length > MAX_LOGS) {
      state.logs.splice(0, state.logs.length - MAX_LOGS);
    }
    const prefix = `[PerlegoExporter][${entry.level.toUpperCase()}]`;
    if (level === 'error') console.error(prefix, entry.text);
    else if (level === 'warn') console.warn(prefix, entry.text);
    else console.log(prefix, entry.text);
  }

  function formatLogsAsText() {
    return state.logs
      .map((l) => `[${l.ts}] [${l.level.toUpperCase()}] ${l.text}`)
      .join('\n');
  }

  function syncActiveBookContext(bookContext) {
    if (state.activeBookId && bookContext.bookId && state.activeBookId !== bookContext.bookId) {
      if (state.status === 'idle') {
        state.mode = 'auto';
        state.phaseLabel = 'Ready';
        state.message = '';
        state.progress = 0;
        state.currentItem = 0;
        state.totalItems = 0;
        state.skippedCount = 0;
        state.etaSeconds = 0;
        state.indeterminate = false;
      }
    }
    if (bookContext.bookId) {
      state.activeBookId = bookContext.bookId;
    }
  }

  function buildSnapshot({ includeLogs = false } = {}) {
    const bookContext = PD.domCleaner.extractBookContext();
    syncActiveBookContext(bookContext);
    let warnCount = 0;
    let errorCount = 0;
    for (const l of state.logs) {
      if (l.level === 'warn') warnCount += 1;
      else if (l.level === 'error') errorCount += 1;
    }
    const snap = {
      initialized: true,
      bookContext,
      state: state.status,
      mode: state.mode,
      phaseLabel: state.phaseLabel,
      message: state.message,
      progress: state.progress,
      currentItem: state.currentItem,
      totalItems: state.totalItems,
      cachedCount: state.cachedCount,
      skippedCount: state.skippedCount,
      etaSeconds: state.etaSeconds,
      indeterminate: state.indeterminate,
      title: bookContext.title,
      logCount: state.logs.length,
      warnCount,
      errorCount,
    };
    if (includeLogs) {
      snap.logs = state.logs;
    }
    return snap;
  }

  function broadcastState(force = false) {
    const now = Date.now();
    if (!force && now - state.lastBroadcastAt < 150) {
      return;
    }
    state.lastBroadcastAt = now;
    const ipcSnapshot = buildSnapshot({ includeLogs: false });
    if (state.status !== 'idle' || force) {
      PD.hud?.update({ ...ipcSnapshot, logs: state.logs });
    }
    try {
      chrome.runtime.sendMessage({ type: 'PD_STATE_UPDATE', snapshot: ipcSnapshot }).catch(() => {});
    } catch {
      // Popup closed; ignore
    }
  }

  function updateEta(doneInRun, remaining) {
    if (doneInRun < 2 || remaining <= 0 || !state.startedAt) {
      state.etaSeconds = 0;
      return;
    }
    const elapsedSec = (Date.now() - state.startedAt) / 1000;
    const rate = doneInRun / Math.max(0.1, elapsedSec);
    state.etaSeconds = remaining / rate;
  }

  async function waitWhilePaused(signal) {
    if (state.status !== 'paused') return;
    broadcastState(true);
    await new Promise((resolve, reject) => {
      const onAbort = () => reject(PD.async.createAbortError());
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      state.pauseResolvers.push(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  function resumeFromPause() {
    if (state.status === 'paused') {
      state.status = 'running';
      state.phaseLabel = 'Resuming...';
      const resolvers = state.pauseResolvers.splice(0);
      for (const r of resolvers) r();
      broadcastState(true);
    }
  }

  function pauseCapture() {
    if (state.status === 'running') {
      state.status = 'paused';
      state.phaseLabel = 'Paused';
      state.message = 'Paused. Click Resume or export cached chapters.';
      broadcastState(true);
    }
  }

  function stopCapture() {
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
    if (state.exportAbortController) {
      state.exportAbortController.abort();
      state.exportAbortController = null;
    }
    const resolvers = state.pauseResolvers.splice(0);
    for (const r of resolvers) r();
    state.status = 'idle';
    state.indeterminate = false;
    state.etaSeconds = 0;
    state.phaseLabel = 'Stopped';
    state.message = `Stopped with ${state.cachedCount} cached sections.`;
    broadcastState(true);
  }

  async function backgroundFetchBinary(url) {
    return chrome.runtime.sendMessage({ type: 'PD_FETCH_BINARY', url });
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function normalizeRange(options = {}) {
    const startRaw = parseInt(options.rangeStart, 10);
    const endRaw = parseInt(options.rangeEnd, 10);
    const rangeStart = Number.isFinite(startRaw) && startRaw >= 1 ? startRaw : null;
    const rangeEnd = Number.isFinite(endRaw) && endRaw >= 1 ? endRaw : null;
    if (rangeStart && rangeEnd && rangeEnd < rangeStart) {
      return { rangeStart: rangeEnd, rangeEnd: rangeStart };
    }
    return { rangeStart, rangeEnd };
  }

  function isPositionInRange(oneBasedPos, range) {
    if (range.rangeStart && oneBasedPos < range.rangeStart) return false;
    if (range.rangeEnd && oneBasedPos > range.rangeEnd) return false;
    return true;
  }

  const EPUB_TOC_SELECTOR = [
    '[data-test-locator^="Epub-ChapterRow-Index-"]',
    '[data-test-locator^="Epub-SubChapterRow-"]',
    '[data-test-locator^="Epub-SubSubChapterRow-"]',
    '[data-test-locator^="Pdf-SubChapterRow-Page-"]',
    '[data-test-locator^="Pdf-SubSubChapterRow-Page-"]',
  ].join(', ');

  function detectTocRowLevel(locator) {
    if (/SubSubChapterRow/i.test(locator)) return 2;
    if (/SubChapterRow/i.test(locator)) return 1;
    return 0;
  }

  function parseEpubTocRows(rootDoc = typeof document !== 'undefined' ? document : null) {
    if (!rootDoc?.querySelectorAll) return new Map();
    const rows = rootDoc.querySelectorAll(EPUB_TOC_SELECTOR);
    const tocMap = new Map();
    for (const row of rows) {
      const attr = row.getAttribute('data-test-locator') || '';
      const m = attr.match(/(?:Index-|Page-|-)(\d+)$/);
      if (!m) continue;
      const idx = parseInt(m[1], 10);
      if (tocMap.has(idx)) continue;
      const clickTarget = row.querySelector('[tabindex="0"]') || row.querySelector('div') || row;
      const rawTitle = (row.textContent || '').replace(/\s+/g, ' ').trim();
      tocMap.set(idx, {
        index: idx,
        level: detectTocRowLevel(attr),
        title: rawTitle || `Chapter ${idx + 1}`,
        clickTarget,
      });
    }
    return tocMap;
  }

  async function expandCollapsedTocItems(tocPanel, signal, clickedSet = new WeakSet()) {
    if (!tocPanel?.querySelectorAll) return 0;
    let expandedCount = 0;
    for (let pass = 0; pass < 5; pass++) {
      if (signal?.aborted) throw PD.async.createAbortError();
      const toggles = Array.from(tocPanel.querySelectorAll('[aria-expanded="false"]')).filter(
        (el) => !clickedSet.has(el)
      );
      if (toggles.length === 0) break;
      for (const toggle of toggles) {
        clickedSet.add(toggle);
        if (typeof toggle.click === 'function') {
          toggle.click();
        }
        expandedCount += 1;
      }
      await PD.async.sleep(80, signal);
    }
    if (expandedCount > 0) {
      addLog('info', `Expanded ${expandedCount} collapsed TOC section(s).`);
    }
    return expandedCount;
  }

  function findChapterDomElements(index) {
    const exact = document.getElementById(`p${index}--0`);
    if (exact && exact.classList.contains('chapter-loaded') && exact.innerHTML.trim().length > 0) {
      const multi = Array.from(document.querySelectorAll(`[id^="p${index}--"].chapter-loaded`));
      if (multi.length > 1) {
        multi.sort((a, b) => {
          const sa = parseInt((a.id.split('--')[1] || '0'), 10);
          const sb = parseInt((b.id.split('--')[1] || '0'), 10);
          return sa - sb;
        });
        return multi;
      }
      return [exact];
    }
    return null;
  }

  async function openTableOfContents(signal) {
    let panel = document.querySelector('[data-test-locator="ToolbarPanel"]');
    if (panel) return panel;

    const btn = document.querySelector('button[data-test-locator="Icon-TOC"]');
    if (!btn) return null;

    btn.click();
    panel = await PD.async.waitForCondition(
      () => document.querySelector('[data-test-locator="ToolbarPanel"]'),
      { timeoutMs: 5000, pollIntervalMs: 50, signal }
    );
    return panel;
  }

  function hasPdfIndicators() {
    return Boolean(
      document.querySelector('div[data-test-locator="pagetion-total-chapter-numbers"]') ||
      document.querySelector('[data-test-locator^="Epub-ChapterRow-Page-"]') ||
      document.querySelector('[data-test-locator^="Pdf-"]') ||
      document.querySelector('[id^="p"][id$="--0"] object')
    );
  }

  function summarizeDomChapterNodes() {
    const nodes = Array.from(document.querySelectorAll('[id^="p"][id*="--"]'));
    if (nodes.length === 0) return 'none';
    return nodes
      .slice(0, 10)
      .map((n) => `${n.id}(cls="${n.className}",len=${n.innerHTML.length})`)
      .join(', ');
  }

  function logTocDiagnostics(tocPanel, tocMap) {
    if (!tocPanel) {
      addLog('warn', 'ToolbarPanel element not found after clicking TOC icon.');
    } else {
      const locators = Array.from(tocPanel.querySelectorAll('[data-test-locator]'))
        .map((el) => el.getAttribute('data-test-locator'))
        .filter(Boolean);
      const prefixes = new Map();
      for (const loc of locators) {
        const prefix = loc.replace(/\d+$/, '*');
        prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1);
      }
      const summary = Array.from(prefixes.entries())
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
      addLog('info', `TOC locators inside panel: ${summary || 'none'}`);
    }

    const keys = Array.from(tocMap.keys()).sort((a, b) => a - b);
    if (keys.length > 0) {
      const gaps = [];
      for (let expected = keys[0]; expected <= keys[keys.length - 1]; expected++) {
        if (!tocMap.has(expected)) gaps.push(expected);
      }
      addLog(
        'info',
        `Discovered ${keys.length} TOC chapter/sub-chapter items (range ${keys[0]}..${keys[keys.length - 1]}).` +
          (gaps.length ? ` Gaps at: [${gaps.slice(0, 20).join(', ')}]` : '')
      );
    }
  }

  async function waitForChapterImagesHydrated(chapterNodes, signal) {
    const hasPendingPlaceholders = () => {
      for (const node of chapterNodes) {
        const imgs = node.querySelectorAll?.('img');
        if (!imgs) continue;
        for (const img of imgs) {
          const src = (img.getAttribute('src') || '').trim();
          const hasAltSrc = Boolean(
            img.getAttribute('data-src') ||
            img.getAttribute('data-srcset') ||
            img.getAttribute('srcset')
          );
          if (!hasAltSrc && (!src || PD.domCleaner.isBlankPlaceholderUrl(src))) {
            return true;
          }
        }
      }
      return false;
    };

    if (!hasPendingPlaceholders()) return;
    await PD.async.waitForCondition(() => !hasPendingPlaceholders(), {
      timeoutMs: 800,
      pollIntervalMs: 80,
      signal,
    });
  }

  async function runEpubCapture(bookContext, options, signal) {
    const preset = SPEED_PRESETS[options.speed] || SPEED_PRESETS.balanced;
    const range = normalizeRange(options);
    state.mode = 'epub';
    state.skippedCount = 0;
    state.phaseLabel = 'Opening TOC';
    state.message = 'Discovering book chapters...';
    state.indeterminate = true;
    addLog(
      'info',
      `Starting ePUB capture: "${bookContext.title}" (${bookContext.bookId}), speed=${options.speed}` +
        (range.rangeStart || range.rangeEnd ? `, range=${range.rangeStart || 1}..${range.rangeEnd || 'end'}` : '')
    );
    broadcastState(true);

    const tocPanel = await openTableOfContents(signal);
    const clickedTocToggles = new WeakSet();
    if (tocPanel) {
      await PD.async.sleep(150, signal);
      await expandCollapsedTocItems(tocPanel, signal, clickedTocToggles);
    }

    let tocMap = parseEpubTocRows();
    logTocDiagnostics(tocPanel, tocMap);

    if (tocMap.size === 0) {
      if (options.mode === 'auto' && hasPdfIndicators()) {
        addLog('warn', 'No ePUB TOC chapter/sub-chapter items; detected PDF indicators, switching to PDF mode.');
        state.message = 'Detected fixed-layout PDF book. Switching to PDF capture...';
        broadcastState(true);
        return runPdfCapture(bookContext, options, signal);
      }
      addLog('error', 'No ePUB chapters found in TOC.');
      throw new Error('No ePUB chapters found. Open the book reader or try PDF mode.');
    }

    const capturedSet = await PD.db.getCapturedIndices(bookContext.bookId);
    state.cachedCount = capturedSet.size;
    if (capturedSet.size > 0) {
      addLog('info', `Found ${capturedSet.size} cached chapters in IndexedDB.`);
    }
    state.indeterminate = false;

    const processedSet = new Set();
    const skippedSet = new Set();
    let maxKnownCount = tocMap.size;
    state.startedAt = Date.now();
    state.itemsCompletedInRun = 0;

    await PD.db.saveBookMeta({
      bookId: bookContext.bookId,
      title: bookContext.title,
      author: bookContext.author,
      url: bookContext.url,
      mode: 'epub',
      totalItems: maxKnownCount,
      capturedCount: capturedSet.size,
    });

    while (true) {
      if (signal.aborted) throw PD.async.createAbortError();
      await waitWhilePaused(signal);

      // Re-scan TOC in case Perlego virtualizes long TOC lists as items are clicked
      const liveTocPanel = document.querySelector('[data-test-locator="ToolbarPanel"]');
      if (liveTocPanel) {
        await expandCollapsedTocItems(liveTocPanel, signal, clickedTocToggles);
      }
      const freshToc = parseEpubTocRows();
      for (const [k, v] of freshToc.entries()) {
        tocMap.set(k, v);
      }
      const allSorted = Array.from(tocMap.keys()).sort((a, b) => a - b);
      const targetIndices = allSorted.filter((_idx, pos) => isPositionInRange(pos + 1, range));
      maxKnownCount = Math.max(targetIndices.length, processedSet.size);
      state.totalItems = maxKnownCount;

      const nextIndex = targetIndices.find((idx) => !processedSet.has(idx));
      if (nextIndex === undefined) {
        break;
      }
      processedSet.add(nextIndex);

      if (capturedSet.has(nextIndex)) {
        state.currentItem = processedSet.size;
        state.progress = maxKnownCount > 0 ? Math.floor((processedSet.size / maxKnownCount) * 100) : 100;
        state.phaseLabel = 'Resuming (cached)';
        state.message = `Skipped cached chapter ${nextIndex + 1}`;
        broadcastState();
        continue;
      }

      let entry = tocMap.get(nextIndex);
      state.phaseLabel = 'Capturing ePUB';
      state.message = `Loading: ${entry.title}`;
      broadcastState();

      const clickEntrySafely = async () => {
        if (!entry.clickTarget?.isConnected) {
          await openTableOfContents(signal);
          const refreshed = parseEpubTocRows();
          if (refreshed.has(nextIndex)) {
            entry = refreshed.get(nextIndex);
            tocMap.set(nextIndex, entry);
          }
        }
        entry.clickTarget?.scrollIntoView?.({ block: 'nearest' });
        entry.clickTarget?.click?.();
      };

      let chapterNodes = findChapterDomElements(nextIndex);
      if (!chapterNodes) {
        await clickEntrySafely();
        chapterNodes = await PD.async.waitForCondition(
          () => findChapterDomElements(nextIndex),
          { timeoutMs: preset.timeoutMs, pollIntervalMs: 50, signal }
        );
      }

      // Single clean retry if first load timed out
      if (!chapterNodes) {
        addLog('warn', `ch#${nextIndex} "${entry.title}" timed out on 1st try; DOM=[${summarizeDomChapterNodes()}]. Retrying...`);
        await clickEntrySafely();
        chapterNodes = await PD.async.waitForCondition(
          () => findChapterDomElements(nextIndex),
          { timeoutMs: preset.timeoutMs, pollIntervalMs: 60, signal }
        );
      }

      if (!chapterNodes) {
        skippedSet.add(nextIndex);
        state.skippedCount = skippedSet.size;
        addLog('error', `SKIPPED ch#${nextIndex} "${entry.title}" after 2nd timeout; DOM=[${summarizeDomChapterNodes()}]`);
        state.currentItem = processedSet.size;
        state.progress = maxKnownCount > 0 ? Math.floor((processedSet.size / maxKnownCount) * 100) : 100;
        broadcastState(true);
        continue;
      }

      // Wait one animation frame + preset settle delay + lazy placeholder check
      await new Promise((r) => requestAnimationFrame(r));
      await PD.async.sleep(preset.settleMs, signal);
      await waitForChapterImagesHydrated(chapterNodes, signal);

      const rawHtml = chapterNodes.map((n) => n.outerHTML).join('\n');
      const cleaned = PD.domCleaner.cleanChapterHtml(rawHtml, {
        baseUrl: location.href,
        index: nextIndex,
      });

      const finalTitle = entry.title && !/^Chapter\s+\d+$/i.test(entry.title)
        ? entry.title
        : (cleaned.title || entry.title);

      state.cachedCount = await PD.db.putItem({
        bookId: bookContext.bookId,
        index: nextIndex,
        title: finalTitle,
        level: entry.level || 0,
        html: cleaned.html,
        assetUrls: cleaned.assetUrls,
        assetFallbacks: cleaned.assetFallbacks,
      });
      capturedSet.add(nextIndex);
      state.itemsCompletedInRun += 1;

      addLog(
        'ok',
        `Captured ch#${nextIndex} "${finalTitle}" (${(cleaned.html.length / 1024).toFixed(1)} KB, ${cleaned.assetUrls.length} assets, nodes=${chapterNodes.length})`
      );

      state.currentItem = processedSet.size;
      state.progress = maxKnownCount > 0 ? Math.floor((processedSet.size / maxKnownCount) * 100) : 100;
      const remainingUncached = targetIndices.filter((i) => !processedSet.has(i) && !capturedSet.has(i)).length;
      updateEta(state.itemsCompletedInRun, remainingUncached);
      broadcastState();
    }

    await PD.db.saveBookMeta({
      bookId: bookContext.bookId,
      title: bookContext.title,
      author: bookContext.author,
      url: bookContext.url,
      mode: 'epub',
      totalItems: tocMap.size,
      capturedCount: state.cachedCount,
    });
  }

  function detectPdfTotalPages() {
    const pageCounter = document.querySelector('div[data-test-locator="pagetion-total-chapter-numbers"]');
    if (pageCounter) {
      const nums = (pageCounter.textContent || '').match(/\d+/g);
      if (nums && nums.length > 0) {
        return Math.max(...nums.map((n) => parseInt(n, 10)));
      }
    }
    const tocPages = document.querySelectorAll('[data-test-locator*="-Page-"]');
    let maxPage = 0;
    for (const el of tocPages) {
      const attr = el.getAttribute('data-test-locator') || '';
      const m = attr.match(/-Page-(\d+)/);
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    }
    return maxPage;
  }

  function extractPdfTocTitles() {
    const map = new Map();
    const rows = document.querySelectorAll(
      '[data-test-locator^="Epub-ChapterRow-Page-"], [data-test-locator^="Pdf-ChapterRow-Page-"], [data-test-locator^="Pdf-SubChapterRow-Page-"], [data-test-locator^="Pdf-SubSubChapterRow-Page-"]'
    );
    for (const row of rows) {
      const attr = row.getAttribute('data-test-locator') || '';
      const m = attr.match(/-Page-(\d+)/);
      if (!m) continue;
      const pageNum = parseInt(m[1], 10);
      const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && !map.has(pageNum)) {
        map.set(pageNum, text);
      }
    }
    return map;
  }

  function findScrollableReaderContainer() {
    const sample = document.querySelector('[id^="p"][id$="--0"]');
    let cur = sample ? sample.parentElement : document.querySelector('main');
    while (cur && cur !== document.documentElement) {
      const style = getComputedStyle(cur);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        cur.scrollHeight > cur.clientHeight + 50
      ) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function extractPdfPageHtml(containerEl) {
    const hasObject = containerEl.querySelector('object[data]');
    const hasSvg = containerEl.querySelector('svg');
    const imgs = Array.from(containerEl.querySelectorAll('img[src], picture source'));
    const hasRealImg = imgs.some((el) => {
      const candidate =
        el.getAttribute('data-srcset') ||
        el.getAttribute('srcset') ||
        el.getAttribute('data-src') ||
        el.getAttribute('src') ||
        '';
      const trimmed = candidate.trim();
      return Boolean(trimmed) && !PD.domCleaner.isBlankPlaceholderUrl(trimmed);
    });
    const canvas = containerEl.querySelector('canvas');

    if (hasObject || hasRealImg || hasSvg) {
      return containerEl.innerHTML;
    }
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      try {
        const clone = containerEl.cloneNode(true);
        const origCanvases = containerEl.querySelectorAll('canvas');
        const cloneCanvases = clone.querySelectorAll('canvas');
        for (let i = 0; i < origCanvases.length; i++) {
          const dataUrl = origCanvases[i].toDataURL('image/png');
          const img = document.createElement('img');
          img.setAttribute('src', dataUrl);
          img.setAttribute('alt', 'Page render');
          cloneCanvases[i]?.replaceWith(img);
        }
        return clone.innerHTML;
      } catch {
        // Tainted canvas; fall through
      }
    }
    return null;
  }

  async function runPdfCapture(bookContext, options, signal) {
    const preset = SPEED_PRESETS[options.speed] || SPEED_PRESETS.balanced;
    const range = normalizeRange(options);
    state.mode = 'pdf';
    state.skippedCount = 0;

    await openTableOfContents(signal);
    const totalPages = detectPdfTotalPages();
    const tocTitles = extractPdfTocTitles();
    if (!totalPages || totalPages <= 0) {
      throw new Error('Could not determine total PDF page count.');
    }

    const startPage = Math.max(1, Math.min(totalPages, range.rangeStart || 1));
    const endPage = Math.max(startPage, Math.min(totalPages, range.rangeEnd || totalPages));
    const targetCount = endPage - startPage + 1;

    const capturedSet = await PD.db.getCapturedIndices(bookContext.bookId);
    const countCapturedInRange = () => {
      let count = 0;
      for (const idx of capturedSet) {
        if (idx >= startPage && idx <= endPage) count += 1;
      }
      return count;
    };

    state.cachedCount = capturedSet.size;
    state.totalItems = targetCount;
    state.currentItem = countCapturedInRange();
    state.progress = Math.floor((state.currentItem / targetCount) * 100);
    state.indeterminate = false;
    state.startedAt = Date.now();
    state.itemsCompletedInRun = 0;

    addLog(
      'info',
      `Starting PDF capture: "${bookContext.title}" (${totalPages} total pages, range ${startPage}..${endPage})`
    );

    await PD.db.saveBookMeta({
      bookId: bookContext.bookId,
      title: bookContext.title,
      author: bookContext.author,
      url: bookContext.url,
      mode: 'pdf',
      totalItems: totalPages,
      capturedCount: capturedSet.size,
    });

    const pendingWrites = new Set();
    let scanScheduled = false;

    async function scanVisiblePages() {
      if (signal.aborted || state.status === 'paused') return;
      const pageNodes = document.querySelectorAll('[id^="p"][id$="--0"]');
      for (const node of pageNodes) {
        const match = node.id.match(/^p(\d+)--0$/);
        if (!match) continue;
        const pageNum = parseInt(match[1], 10);
        if (pageNum < startPage || pageNum > endPage) continue;
        if (capturedSet.has(pageNum) || pendingWrites.has(pageNum)) continue;

        const rawPageHtml = extractPdfPageHtml(node);
        if (!rawPageHtml) continue;

        pendingWrites.add(pageNum);
        const cleaned = PD.domCleaner.cleanChapterHtml(rawPageHtml, {
          baseUrl: location.href,
          index: pageNum - 1,
        });
        const pageTitle = tocTitles.get(pageNum) || `Page ${pageNum}`;

        try {
          state.cachedCount = await PD.db.putItem({
            bookId: bookContext.bookId,
            index: pageNum,
            title: pageTitle,
            level: 0,
            html: cleaned.html,
            assetUrls: cleaned.assetUrls,
            assetFallbacks: cleaned.assetFallbacks,
          });
          capturedSet.add(pageNum);
          state.itemsCompletedInRun += 1;
          const inRangeCount = countCapturedInRange();
          state.currentItem = inRangeCount;
          state.progress = Math.floor((inRangeCount / targetCount) * 100);
          updateEta(state.itemsCompletedInRun, targetCount - inRangeCount);
          state.message = `Captured page ${pageNum} (${inRangeCount}/${targetCount})`;
          broadcastState();
        } finally {
          pendingWrites.delete(pageNum);
        }
      }
    }

    function scheduleScan() {
      if (scanScheduled || signal.aborted) return;
      scanScheduled = true;
      setTimeout(() => {
        scanScheduled = false;
        scanVisiblePages().catch(() => {});
      }, 60);
    }

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    window.addEventListener('scroll', scheduleScan, { passive: true, capture: true });

    try {
      await scanVisiblePages();

      if (options.autoScroll !== false) {
        state.phaseLabel = 'Auto-scrolling PDF';
        state.message = `Auto-scrolling pages ${startPage}–${endPage}...`;
        broadcastState(true);

        const scroller = findScrollableReaderContainer();
        if (startPage > 1) {
          const startEl = document.getElementById(`p${startPage}--0`);
          startEl?.scrollIntoView?.({ block: 'start' });
          await PD.async.sleep(preset.scrollStepMs, signal);
        }
        let stagnantRounds = 0;

        while (countCapturedInRange() < targetCount && !signal.aborted) {
          await waitWhilePaused(signal);
          await scanVisiblePages();
          if (countCapturedInRange() >= targetCount) break;

          const prevTop = scroller.scrollTop;
          const step = Math.max(300, Math.floor((scroller.clientHeight || 800) * 0.78));
          scroller.scrollTop = Math.min(scroller.scrollHeight, prevTop + step);

          await PD.async.sleep(preset.scrollStepMs, signal);
          await scanVisiblePages();

          if (Math.abs(scroller.scrollTop - prevTop) < 2) {
            stagnantRounds += 1;
            if (stagnantRounds >= 6) {
              break;
            }
          } else {
            stagnantRounds = 0;
          }
        }

        // Recovery pass: jump directly to any missed page placeholders
        const missingPages = [];
        for (let p = startPage; p <= endPage; p++) {
          if (!capturedSet.has(p)) missingPages.push(p);
        }
        if (missingPages.length > 0 && !signal.aborted) {
          addLog('warn', `Attempting recovery for ${missingPages.length} missed PDF page(s)...`);
          state.phaseLabel = 'Recovering missed pages';
          broadcastState(true);
          for (const p of missingPages.slice(0, 25)) {
            if (signal.aborted) throw PD.async.createAbortError();
            await waitWhilePaused(signal);
            const node = document.getElementById(`p${p}--0`);
            if (node) {
              node.scrollIntoView({ block: 'center' });
              await PD.async.sleep(preset.scrollStepMs + 160, signal);
              await scanVisiblePages();
            }
          }
        }

        const finalMissing = [];
        for (let p = startPage; p <= endPage; p++) {
          if (!capturedSet.has(p)) finalMissing.push(p);
        }
        if (finalMissing.length > 0) {
          state.skippedCount = finalMissing.length;
          addLog(
            'warn',
            `PDF capture finished with ${finalMissing.length} missing page(s): [${finalMissing.slice(0, 20).join(', ')}]`
          );
        }
      } else {
        state.phaseLabel = 'Manual PDF capture';
        state.message = `Scroll through the book (${countCapturedInRange()}/${targetCount} captured).`;
        broadcastState(true);

        while (countCapturedInRange() < targetCount && !signal.aborted) {
          await waitWhilePaused(signal);
          await PD.async.sleep(250, signal);
          await scanVisiblePages();
        }
      }
    } finally {
      observer.disconnect();
      window.removeEventListener('scroll', scheduleScan, { capture: true });
    }
  }

  function collectFallbackMapFromItems(items) {
    const fallbackMap = new Map();
    for (const item of items) {
      if (item.assetFallbacks && typeof item.assetFallbacks === 'object') {
        for (const [primary, fallback] of Object.entries(item.assetFallbacks)) {
          if (primary && fallback && !fallbackMap.has(primary)) {
            fallbackMap.set(primary, fallback);
          }
        }
      }
      // Backward compatibility for cached items captured before v4.1
      if (typeof item.html === 'string' && item.html.includes('data-fallback-src=')) {
        const re = /<img\b[^>]*\bsrc="([^"]+)"[^>]*\bdata-fallback-src="([^"]+)"/gi;
        let m;
        while ((m = re.exec(item.html)) !== null) {
          if (m[1] && m[2] && !fallbackMap.has(m[1])) {
            fallbackMap.set(m[1], m[2]);
          }
        }
      }
    }
    return fallbackMap;
  }

  async function exportBook(bookContext, options, signal, { restoreStatus = 'idle' } = {}) {
    const formats = Array.isArray(options.formats) && options.formats.length > 0
      ? options.formats
      : ['epub'];
    const targetBookId = options.bookId || bookContext.bookId;
    const isCurrentTabBook = targetBookId === bookContext.bookId;

    state.status = 'exporting';
    state.phaseLabel = 'Preparing export';
    state.indeterminate = true;
    broadcastState(true);

    let items = await PD.db.getBookItems(targetBookId);
    if (!items || items.length === 0) {
      throw new Error('No captured chapters/pages found in cache to export.');
    }

    const range = normalizeRange(options);
    if (range.rangeStart || range.rangeEnd) {
      const filtered = items.filter((_it, idx) => isPositionInRange(idx + 1, range));
      if (filtered.length > 0) {
        items = filtered;
      }
    }

    const storedMeta = (await PD.db.getBookMeta(targetBookId)) || {};
    const baseMeta = isCurrentTabBook
      ? {
          ...bookContext,
          ...storedMeta,
          title: bookContext.title || storedMeta.title || 'Perlego Book',
          author: bookContext.author || storedMeta.author || '',
        }
      : {
          bookId: targetBookId,
          ...storedMeta,
          title: storedMeta.title || targetBookId,
          author: storedMeta.author || '',
        };
    const meta = PD.domCleaner.enrichBookMetadata(baseMeta, items);
    if (meta.author || meta.year || meta.publisher || meta.isbn) {
      addLog(
        'info',
        `Metadata: "${meta.title}"${meta.author ? ` by ${meta.author}` : ''}${meta.year ? ` (${meta.year})` : ''}${meta.publisher ? ` • ${meta.publisher}` : ''}${meta.isbn ? ` • ISBN ${meta.isbn}` : ''}`
      );
    }

    const needsAssets =
      formats.includes('epub') ||
      (formats.includes('html') && Boolean(options.inlineHtmlImages));

    let assetMap = new Map();
    if (needsAssets) {
      const allUrls = [];
      for (const item of items) {
        if (Array.isArray(item.assetUrls)) {
          for (const url of item.assetUrls) allUrls.push(url);
        }
      }
      if (allUrls.length > 0) {
        const fallbackMap = collectFallbackMapFromItems(items);
        state.indeterminate = false;
        state.phaseLabel = 'Fetching offline assets';
        state.progress = 0;
        state.currentItem = 0;
        state.totalItems = new Set(allUrls).size;
        state.message = `Downloading ${state.totalItems} images/pages in parallel...`;
        addLog('info', `Fetching ${state.totalItems} unique offline assets...`);
        broadcastState(true);

        assetMap = await PD.domCleaner.fetchAssetsParallel(allUrls, {
          concurrency: 6,
          retries: 2,
          signal,
          fallbackMap,
          backgroundFetcher: backgroundFetchBinary,
          onProgress: (done, total) => {
            state.currentItem = done;
            state.totalItems = total;
            state.progress = Math.floor((done / total) * 100);
            state.message = `Downloaded asset ${done}/${total}`;
            broadcastState();
          },
        });
        const failedAssets = state.totalItems - assetMap.size;
        if (failedAssets > 0) {
          addLog('warn', `Assets downloaded: ${assetMap.size}/${state.totalItems} (${failedAssets} failed/skipped).`);
        } else {
          addLog('ok', `All ${assetMap.size} assets downloaded successfully.`);
        }
      }
    }

    if (formats.includes('epub') && meta.coverUrl && assetMap.has(meta.coverUrl)) {
      const origCover = assetMap.get(meta.coverUrl);
      const jpegCover = await PD.domCleaner.ensureJpegCoverAsset(origCover);
      if (jpegCover && jpegCover !== origCover) {
        assetMap.set(meta.coverUrl, jpegCover);
        addLog('info', `Converted cover image from ${origCover.mime} to JPEG for reader compatibility.`);
      }
    }

    if (signal?.aborted) throw PD.async.createAbortError();

    const safeName = PD.domCleaner.formatBookFilename(meta);
    let downloadsTriggered = 0;
    const downloadWithSpacing = async (blob, filename) => {
      if (downloadsTriggered > 0) {
        await PD.async.sleep(350, signal);
      }
      triggerBlobDownload(blob, filename);
      downloadsTriggered += 1;
    };

    if (formats.includes('epub')) {
      state.phaseLabel = 'Building EPUB 3';
      state.indeterminate = false;
      state.progress = 0;
      state.message = 'Packaging XHTML chapters and assets...';
      addLog('info', `Building EPUB 3 (${items.length} sections, ${assetMap.size} embedded assets)...`);
      broadcastState(true);

      const epubBlob = await PD.epubExporter.buildEpubArchive({
        meta,
        items,
        assetMap,
        signal,
        onProgress: (done, total) => {
          state.currentItem = done;
          state.totalItems = total;
          state.progress = Math.floor((done / total) * 100);
          broadcastState();
        },
      });
      addLog('ok', `EPUB 3 ready: ${safeName}.epub (${(epubBlob.size / 1024).toFixed(1)} KB)`);
      await downloadWithSpacing(epubBlob, `${safeName}.epub`);
    }

    if (formats.includes('markdown')) {
      state.phaseLabel = 'Building Markdown';
      state.indeterminate = true;
      state.message = 'Converting DOM to GitHub-Flavored Markdown...';
      addLog('info', `Building Markdown (${items.length} sections)...`);
      broadcastState(true);

      const mdText = await PD.markdownExporter.buildMarkdownDocument({ meta, items, signal });
      const mdBlob = new Blob([mdText], { type: 'text/markdown;charset=utf-8' });
      addLog('ok', `Markdown ready: ${safeName}.md (${(mdBlob.size / 1024).toFixed(1)} KB)`);
      await downloadWithSpacing(mdBlob, `${safeName}.md`);
    }

    if (formats.includes('html')) {
      state.phaseLabel = 'Building HTML';
      state.indeterminate = true;
      state.message = 'Generating standalone print-ready HTML...';
      addLog('info', `Building HTML5 (${items.length} sections, inlineImages=${Boolean(options.inlineHtmlImages)})...`);
      broadcastState(true);

      const htmlText = await PD.htmlExporter.buildHtmlDocument({
        meta,
        items,
        assetMap,
        inlineImages: Boolean(options.inlineHtmlImages),
        signal,
      });
      const htmlBlob = new Blob([htmlText], { type: 'text/html;charset=utf-8' });
      addLog('ok', `HTML5 ready: ${safeName}.html (${(htmlBlob.size / 1024).toFixed(1)} KB)`);
      await downloadWithSpacing(htmlBlob, `${safeName}.html`);
    }

    state.status = restoreStatus;
    state.indeterminate = false;
    state.progress = restoreStatus === 'paused' ? state.progress : 100;
    state.etaSeconds = 0;
    state.phaseLabel = restoreStatus === 'paused' ? 'Paused' : 'Completed';
    const skipNote = state.skippedCount > 0 ? ` (${state.skippedCount} skipped)` : '';
    state.message = `Exported ${items.length} sections (${formats.join(', ').toUpperCase()})${skipNote}.`;
    broadcastState(true);

    try {
      chrome.runtime.sendMessage({
        type: 'PD_NOTIFY',
        title: 'Perlego Export Complete',
        message: `${meta.title} exported (${formats.join(', ').toUpperCase()})`,
      }).catch(() => {});
    } catch {
      // Ignore notification error
    }
  }

  async function startJob(options) {
    if (state.status === 'running' || state.status === 'paused' || state.status === 'exporting') {
      return { ok: false, error: 'A capture or export job is already active.' };
    }

    state.lastOptions = { ...state.lastOptions, ...options };
    const controller = new AbortController();
    state.abortController = controller;
    state.status = 'running';
    state.progress = 0;
    state.skippedCount = 0;
    state.etaSeconds = 0;
    const signal = controller.signal;

    const bookContext = PD.domCleaner.extractBookContext();
    state.activeBookId = bookContext.bookId;
    broadcastState(true);

    try {
      const requestedMode = options.mode || 'auto';
      if (requestedMode === 'pdf' || (requestedMode === 'auto' && bookContext.detectedMode === 'pdf')) {
        await runPdfCapture(bookContext, state.lastOptions, signal);
      } else {
        await runEpubCapture(bookContext, state.lastOptions, signal);
      }

      if (!signal.aborted) {
        await exportBook(bookContext, state.lastOptions, signal, { restoreStatus: 'idle' });
      }
      return { ok: true };
    } catch (err) {
      if (err?.name === 'AbortError') {
        addLog('warn', 'Capture job aborted by user.');
        return { ok: true, aborted: true };
      }
      state.status = 'idle';
      state.indeterminate = false;
      state.etaSeconds = 0;
      state.phaseLabel = 'Error';
      state.message = err?.message || String(err);
      addLog('error', `Job error: ${state.message}`);
      broadcastState(true);
      return { ok: false, error: state.message };
    } finally {
      if (state.abortController === controller) {
        state.abortController = null;
      }
    }
  }

  async function exportCachedOnly(options) {
    if (state.status === 'exporting' || state.status === 'running') {
      return { ok: false, error: 'Pause or wait for the active job before exporting.' };
    }
    const previousStatus = state.status === 'paused' ? 'paused' : 'idle';
    const mergedOpts = { ...state.lastOptions, ...options };
    if (!options?.bookId) {
      state.lastOptions = mergedOpts;
    }
    const controller = new AbortController();
    state.exportAbortController = controller;
    const bookContext = PD.domCleaner.extractBookContext();

    try {
      await exportBook(bookContext, mergedOpts, controller.signal, { restoreStatus: previousStatus });
      return { ok: true };
    } catch (err) {
      if (err?.name === 'AbortError') {
        state.status = previousStatus;
        state.indeterminate = false;
        state.phaseLabel = previousStatus === 'paused' ? 'Paused' : 'Stopped';
        state.message = 'Export cancelled.';
        broadcastState(true);
        return { ok: true, aborted: true };
      }
      state.status = previousStatus;
      state.indeterminate = false;
      state.phaseLabel = 'Error';
      state.message = err?.message || String(err);
      addLog('error', `Export error: ${state.message}`);
      broadcastState(true);
      return { ok: false, error: state.message };
    } finally {
      if (state.exportAbortController === controller) {
        state.exportAbortController = null;
      }
    }
  }

  PD.hud?.setActionHandler((action, payload) => {
    if (action === 'togglePause') {
      if (state.status === 'running') pauseCapture();
      else if (state.status === 'paused') resumeFromPause();
    } else if (action === 'stop') {
      stopCapture();
    } else if (action === 'clearLogs') {
      state.logs = [];
      state.nextLogId = 1;
    } else if (action === 'exportFormat') {
      exportCachedOnly({
        formats: [payload],
        inlineHtmlImages: state.lastOptions.inlineHtmlImages,
      });
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      try {
        switch (message?.type) {
          case 'PD_PING':
          case 'PD_GET_STATUS': {
            const bookContext = PD.domCleaner.extractBookContext();
            syncActiveBookContext(bookContext);
            const indices = await PD.db.getCapturedIndices(bookContext.bookId);
            state.cachedCount = indices.size;
            sendResponse(buildSnapshot({ includeLogs: false }));
            break;
          }
          case 'PD_START': {
            if (state.status === 'running' || state.status === 'paused' || state.status === 'exporting') {
              sendResponse({ ok: false, error: 'A capture or export job is already active.' });
              break;
            }
            const opts = message.options || {};
            startJob(opts).catch((err) => {
              console.error('[PerlegoExporter] Job error:', err);
            });
            sendResponse({ ok: true, started: true, snapshot: buildSnapshot({ includeLogs: false }) });
            break;
          }
          case 'PD_PAUSE': {
            pauseCapture();
            sendResponse({ ok: true, snapshot: buildSnapshot({ includeLogs: false }) });
            break;
          }
          case 'PD_RESUME': {
            resumeFromPause();
            sendResponse({ ok: true, snapshot: buildSnapshot({ includeLogs: false }) });
            break;
          }
          case 'PD_STOP': {
            stopCapture();
            sendResponse({ ok: true, snapshot: buildSnapshot({ includeLogs: false }) });
            break;
          }
          case 'PD_EXPORT_CACHED': {
            if (state.status === 'exporting' || state.status === 'running') {
              sendResponse({ ok: false, error: 'Pause or finish active capture before exporting.' });
              break;
            }
            const opts = message.options || {};
            exportCachedOnly(opts).catch((err) => {
              console.error('[PerlegoExporter] Export error:', err);
            });
            sendResponse({ ok: true, started: true, snapshot: buildSnapshot({ includeLogs: false }) });
            break;
          }
          case 'PD_LIST_BOOKS': {
            const bookContext = PD.domCleaner.extractBookContext();
            const [books, storage] = await Promise.all([
              PD.db.listBooks(),
              PD.db.getStorageEstimate(),
            ]);
            sendResponse({
              ok: true,
              books,
              storage,
              activeBookId: bookContext.bookId,
            });
            break;
          }
          case 'PD_DELETE_BOOK': {
            if (!message.bookId) {
              sendResponse({ ok: false, error: 'Missing bookId' });
              break;
            }
            await PD.db.clearBook(message.bookId);
            const bookContext = PD.domCleaner.extractBookContext();
            if (message.bookId === bookContext.bookId) {
              state.cachedCount = 0;
              state.currentItem = 0;
              state.progress = 0;
              state.skippedCount = 0;
            }
            const [books, storage] = await Promise.all([
              PD.db.listBooks(),
              PD.db.getStorageEstimate(),
            ]);
            sendResponse({
              ok: true,
              books,
              storage,
              snapshot: buildSnapshot({ includeLogs: false }),
            });
            break;
          }
          case 'PD_EXPORT_BOOK': {
            if (state.status === 'exporting' || state.status === 'running') {
              sendResponse({ ok: false, error: 'Pause or finish active capture before exporting.' });
              break;
            }
            if (!message.bookId) {
              sendResponse({ ok: false, error: 'Missing bookId' });
              break;
            }
            const opts = { ...(message.options || {}), bookId: message.bookId };
            exportCachedOnly(opts).catch((err) => {
              console.error('[PerlegoExporter] Library export error:', err);
            });
            sendResponse({ ok: true, started: true, snapshot: buildSnapshot({ includeLogs: false }) });
            break;
          }
          case 'PD_GET_LOGS': {
            sendResponse({ ok: true, text: formatLogsAsText(), logs: state.logs });
            break;
          }
          case 'PD_CLEAR_LOGS': {
            state.logs = [];
            state.nextLogId = 1;
            broadcastState(true);
            sendResponse({ ok: true });
            break;
          }
          case 'PD_CLEAR_CACHE': {
            const bookContext = PD.domCleaner.extractBookContext();
            if (message.allBooks) {
              await PD.db.clearAll();
            } else {
              await PD.db.clearBook(bookContext.bookId);
              PD.db.deleteLegacyDB();
            }
            state.cachedCount = 0;
            state.currentItem = 0;
            state.progress = 0;
            state.skippedCount = 0;
            state.phaseLabel = 'Cache cleared';
            state.message = message.allBooks ? 'All cached books cleared.' : 'Book cache cleared.';
            broadcastState(true);
            sendResponse({ ok: true, snapshot: buildSnapshot({ includeLogs: false }) });
            break;
          }
          default:
            sendResponse({ ok: false, error: 'Unknown message type' });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  });
})();
