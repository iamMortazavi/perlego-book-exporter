/**
 * @file Extension popup controller.
 * Manages accessible two-tab navigation (Capture & Export / Cached Library),
 * persistent user settings, tab-scoped live status updates, and library actions.
 */
'use strict';

const DEFAULT_SETTINGS = {
  formats: ['epub'],
  inlineHtmlImages: false,
  mode: 'auto',
  speed: 'balanced',
  autoScroll: true,
  rangeStart: '',
  rangeEnd: '',
};

const els = {
  bookTitle: document.getElementById('bookTitle'),
  readerBadge: document.getElementById('readerBadge'),
  tabCapture: document.getElementById('tab-capture'),
  tabLibrary: document.getElementById('tab-library'),
  libraryCountBadge: document.getElementById('libraryCountBadge'),
  panelCapture: document.getElementById('panel-capture'),
  panelLibrary: document.getElementById('panel-library'),
  fmtEpub: document.getElementById('fmtEpub'),
  fmtMarkdown: document.getElementById('fmtMarkdown'),
  fmtHtml: document.getElementById('fmtHtml'),
  inlineHtmlImages: document.getElementById('inlineHtmlImages'),
  captureMode: document.getElementById('captureMode'),
  captureSpeed: document.getElementById('captureSpeed'),
  rangeStart: document.getElementById('rangeStart'),
  rangeEnd: document.getElementById('rangeEnd'),
  autoScroll: document.getElementById('autoScroll'),
  phaseLabel: document.getElementById('phaseLabel'),
  progressMeta: document.getElementById('progressMeta'),
  progressBar: document.getElementById('progressBar'),
  statusText: document.getElementById('statusText'),
  skippedNote: document.getElementById('skippedNote'),
  primaryBtn: document.getElementById('primaryBtn'),
  stopBtn: document.getElementById('stopBtn'),
  exportCachedBtn: document.getElementById('exportCachedBtn'),
  copyLogsBtn: document.getElementById('copyLogsBtn'),
  clearCacheBtn: document.getElementById('clearCacheBtn'),
  storageSummary: document.getElementById('storageSummary'),
  libraryList: document.getElementById('libraryList'),
  refreshLibraryBtn: document.getElementById('refreshLibraryBtn'),
  clearAllBooksBtn: document.getElementById('clearAllBooksBtn'),
};

const tabs = [els.tabCapture, els.tabLibrary];
const panels = [els.panelCapture, els.panelLibrary];

let activeTabId = null;
let currentSnapshot = null;
let confirmClearTimer = null;
let confirmingClear = false;
let confirmClearAllTimer = null;
let confirmingClearAll = false;
let pollTimer = null;

function selectTab(selectedTab, { focus = false } = {}) {
  for (let i = 0; i < tabs.length; i++) {
    const isSelected = tabs[i] === selectedTab;
    tabs[i].setAttribute('aria-selected', String(isSelected));
    tabs[i].toggleAttribute('focusgroupstart', isSelected);
    panels[i].hidden = !isSelected;
  }
  if (focus) {
    selectedTab.focus();
  }
  if (selectedTab === els.tabLibrary) {
    refreshLibrary().catch(() => {});
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (ev) => {
    const idx = tabs.indexOf(tab);
    if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      selectTab(tabs[(idx + 1) % tabs.length], { focus: true });
    } else if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      selectTab(tabs[(idx - 1 + tabs.length) % tabs.length], { focus: true });
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      selectTab(tabs[0], { focus: true });
    } else if (ev.key === 'End') {
      ev.preventDefault();
      selectTab(tabs[tabs.length - 1], { focus: true });
    }
  });
}

function parseOptionalInt(val) {
  const n = parseInt(String(val || '').trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function readOptionsFromUI() {
  const formats = [];
  if (els.fmtEpub.checked) formats.push('epub');
  if (els.fmtMarkdown.checked) formats.push('markdown');
  if (els.fmtHtml.checked) formats.push('html');

  return {
    formats,
    inlineHtmlImages: els.inlineHtmlImages.checked,
    mode: els.captureMode.value,
    speed: els.captureSpeed.value,
    autoScroll: els.autoScroll.checked,
    rangeStart: parseOptionalInt(els.rangeStart.value),
    rangeEnd: parseOptionalInt(els.rangeEnd.value),
  };
}

async function saveSettings() {
  const opts = readOptionsFromUI();
  await chrome.storage.local.set({ pdSettings: opts });
}

async function loadSettings() {
  const { pdSettings } = await chrome.storage.local.get('pdSettings');
  const s = { ...DEFAULT_SETTINGS, ...(pdSettings || {}) };
  const formats = Array.isArray(s.formats) ? s.formats : DEFAULT_SETTINGS.formats;

  els.fmtEpub.checked = formats.includes('epub');
  els.fmtMarkdown.checked = formats.includes('markdown');
  els.fmtHtml.checked = formats.includes('html');
  els.inlineHtmlImages.checked = Boolean(s.inlineHtmlImages);
  els.captureMode.value = s.mode || 'auto';
  els.captureSpeed.value = s.speed || 'balanced';
  els.autoScroll.checked = s.autoScroll !== false;
  els.rangeStart.value = s.rangeStart || '';
  els.rangeEnd.value = s.rangeEnd || '';
}

async function sendToActiveReader(payload) {
  const res = await chrome.runtime.sendMessage({
    type: 'PD_ENSURE_AND_SEND',
    payload,
  });
  if (res?.tabId) {
    activeTabId = res.tabId;
  }
  return res;
}

function formatModeLabel(mode) {
  if (mode === 'epub') return 'ePUB';
  if (mode === 'pdf') return 'PDF';
  return 'Reader';
}

function formatEta(etaSeconds) {
  if (!Number.isFinite(etaSeconds) || etaSeconds <= 0) return '';
  if (etaSeconds < 60) return ` • ~${Math.ceil(etaSeconds)}s`;
  const mins = Math.floor(etaSeconds / 60);
  const secs = Math.round(etaSeconds % 60);
  return ` • ~${mins}m ${secs}s`;
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function renderSnapshot(snap) {
  currentSnapshot = snap;
  if (!snap) return;

  const title = snap.bookContext?.title || 'Perlego Book';
  const detectedMode = snap.mode && snap.mode !== 'auto'
    ? snap.mode
    : snap.bookContext?.detectedMode;

  els.bookTitle.textContent = title;
  els.readerBadge.textContent = formatModeLabel(detectedMode);
  els.readerBadge.classList.add('is-ready');

  els.phaseLabel.textContent = snap.phaseLabel || 'Ready';
  const pct = Math.max(0, Math.min(100, Math.round(snap.progress || 0)));

  if (snap.indeterminate) {
    els.progressBar.removeAttribute('value');
  } else {
    els.progressBar.value = pct;
  }

  const baseMeta = snap.totalItems > 0
    ? `${snap.currentItem || 0}/${snap.totalItems} (${pct}%)`
    : `${pct}%`;
  els.progressMeta.textContent = `${baseMeta}${formatEta(snap.etaSeconds)}`;

  els.statusText.textContent = snap.message || (
    snap.cachedCount > 0
      ? `${snap.cachedCount} cached sections ready to resume or export.`
      : 'Ready to capture and export.'
  );

  const skipped = snap.skippedCount || 0;
  if (skipped > 0) {
    els.skippedNote.hidden = false;
    els.skippedNote.textContent = `${skipped} section(s) skipped — click Resume to retry only missing items.`;
  } else {
    els.skippedNote.hidden = true;
  }

  const isRunning = snap.state === 'running';
  const isPaused = snap.state === 'paused';
  const isExporting = snap.state === 'exporting';
  const isBusy = isRunning || isPaused || isExporting;

  if (isRunning) {
    els.primaryBtn.textContent = 'Pause';
    els.primaryBtn.disabled = false;
    els.stopBtn.hidden = false;
  } else if (isPaused) {
    els.primaryBtn.textContent = 'Resume';
    els.primaryBtn.disabled = false;
    els.stopBtn.hidden = false;
  } else if (isExporting) {
    els.primaryBtn.textContent = 'Exporting...';
    els.primaryBtn.disabled = true;
    els.stopBtn.hidden = false;
  } else {
    els.primaryBtn.textContent = snap.cachedCount > 0
      ? 'Resume Capture & Export'
      : 'Start Capture & Export';
    els.primaryBtn.disabled = false;
    els.stopBtn.hidden = true;
  }

  const cached = snap.cachedCount || 0;
  els.exportCachedBtn.textContent = `Export Cached (${cached})`;
  els.exportCachedBtn.disabled = cached === 0 || isExporting || isRunning;
  els.clearCacheBtn.disabled = isBusy;
  els.copyLogsBtn.disabled = false;

  managePolling(isBusy);
}

function renderNotReader(message) {
  els.bookTitle.textContent = 'Not on Perlego reader';
  els.readerBadge.textContent = 'Offline';
  els.readerBadge.classList.remove('is-ready');
  els.phaseLabel.textContent = 'Waiting';
  els.progressMeta.textContent = '—';
  els.progressBar.value = 0;
  els.statusText.textContent = message || 'Open a book on ereader.perlego.com first.';
  els.skippedNote.hidden = true;
  els.primaryBtn.disabled = true;
  els.exportCachedBtn.disabled = true;
  els.clearCacheBtn.disabled = true;
  els.copyLogsBtn.disabled = true;
  els.stopBtn.hidden = true;
  els.clearAllBooksBtn.disabled = true;
  els.refreshLibraryBtn.disabled = true;
  els.libraryList.innerHTML = '<p class="empty-state">Open any page on ereader.perlego.com to manage your cached library.</p>';
  managePolling(false);
}

function renderLibrary(books = [], storage = {}, activeBookId = '') {
  els.libraryCountBadge.textContent = String(books.length);
  els.clearAllBooksBtn.disabled = books.length === 0;
  els.refreshLibraryBtn.disabled = false;

  if (storage?.usage > 0) {
    const quotaPart = storage.quota > 0 ? ` / ${formatBytes(storage.quota)}` : '';
    els.storageSummary.textContent = `${formatBytes(storage.usage)}${quotaPart}`;
  } else {
    const totalBytes = books.reduce((sum, b) => sum + (b.sizeBytes || 0), 0);
    els.storageSummary.textContent = totalBytes > 0 ? `~${formatBytes(totalBytes)}` : `${books.length} book(s)`;
  }

  els.libraryList.innerHTML = '';
  if (books.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'No cached books yet. Capture a book to build your offline cache.';
    els.libraryList.appendChild(p);
    return;
  }

  const isBusy = currentSnapshot?.state === 'running' || currentSnapshot?.state === 'exporting';

  for (const book of books) {
    const row = document.createElement('div');
    row.className = 'book-row';
    if (book.bookId === activeBookId) row.classList.add('is-current');

    const top = document.createElement('div');
    top.className = 'book-row-top';

    const titleEl = document.createElement('div');
    titleEl.className = 'book-row-title';
    titleEl.textContent = book.title || book.bookId;

    const modeBadge = document.createElement('span');
    modeBadge.className = 'badge';
    modeBadge.textContent = formatModeLabel(book.mode);

    top.append(titleEl, modeBadge);

    const metaEl = document.createElement('div');
    metaEl.className = 'book-row-meta';
    const captured = book.capturedCount || 0;
    const total = book.totalItems ? `/${book.totalItems}` : '';
    const sizeText = book.sizeBytes ? ` • ${formatBytes(book.sizeBytes)}` : '';
    const dateText = book.updatedAt ? ` • ${new Date(book.updatedAt).toLocaleDateString()}` : '';
    metaEl.textContent = `${captured}${total} sections${sizeText}${dateText}`;

    const actions = document.createElement('div');
    actions.className = 'book-row-actions';

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn btn-sm btn-primary';
    exportBtn.textContent = 'Export';
    exportBtn.disabled = captured === 0 || isBusy;
    exportBtn.addEventListener('click', async () => {
      const opts = readOptionsFromUI();
      if (opts.formats.length === 0) {
        selectTab(els.tabCapture);
        els.statusText.textContent = 'Select at least one output format first.';
        return;
      }
      selectTab(els.tabCapture);
      const res = await sendToActiveReader({
        type: 'PD_EXPORT_BOOK',
        bookId: book.bookId,
        options: opts,
      });
      if (!res?.ok || res?.data?.ok === false) {
        els.statusText.textContent = res?.data?.error || res?.error || 'Library export failed.';
        return;
      }
      if (res.data?.snapshot) renderSnapshot(res.data.snapshot);
      managePolling(true);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-sm btn-ghost';
    delBtn.textContent = 'Delete';
    delBtn.disabled = isBusy;
    delBtn.addEventListener('click', async () => {
      const res = await sendToActiveReader({
        type: 'PD_DELETE_BOOK',
        bookId: book.bookId,
      });
      if (res?.ok && res.data?.ok) {
        renderLibrary(res.data.books || [], res.data.storage || {}, activeBookId);
        if (res.data.snapshot) renderSnapshot(res.data.snapshot);
      }
    });

    actions.append(exportBtn, delBtn);
    row.append(top, metaEl, actions);
    els.libraryList.appendChild(row);
  }
}

async function refreshLibrary() {
  try {
    const res = await sendToActiveReader({ type: 'PD_LIST_BOOKS' });
    if (!res?.ok || !res.data?.ok) {
      return;
    }
    renderLibrary(res.data.books || [], res.data.storage || {}, res.data.activeBookId || '');
  } catch {
    // Ignore when not on Perlego
  }
}

function managePolling(shouldPoll) {
  if (shouldPoll && pollTimer === null) {
    pollTimer = setInterval(refreshStatus, 1000);
  } else if (!shouldPoll && pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function refreshStatus() {
  try {
    const res = await sendToActiveReader({ type: 'PD_GET_STATUS' });
    if (!res?.ok) {
      renderNotReader(res?.error);
      return;
    }
    if (res.data) {
      renderSnapshot(res.data);
    }
  } catch (err) {
    renderNotReader(err?.message || 'Unable to connect to tab.');
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'PD_STATE_UPDATE' && message.snapshot) {
    if (activeTabId !== null && sender?.tab?.id && sender.tab.id !== activeTabId) {
      return;
    }
    renderSnapshot(message.snapshot);
  }
});

for (const input of [
  els.fmtEpub,
  els.fmtMarkdown,
  els.fmtHtml,
  els.inlineHtmlImages,
  els.captureMode,
  els.captureSpeed,
  els.rangeStart,
  els.rangeEnd,
  els.autoScroll,
]) {
  input.addEventListener('change', () => {
    saveSettings().catch(() => {});
  });
}

els.primaryBtn.addEventListener('click', async () => {
  const opts = readOptionsFromUI();
  if (opts.formats.length === 0) {
    els.statusText.textContent = 'Select at least one output format (EPUB, Markdown, or HTML).';
    return;
  }

  const state = currentSnapshot?.state;
  if (state === 'running') {
    const res = await sendToActiveReader({ type: 'PD_PAUSE' });
    if (res?.data?.snapshot) renderSnapshot(res.data.snapshot);
    return;
  }
  if (state === 'paused') {
    const res = await sendToActiveReader({ type: 'PD_RESUME' });
    if (res?.data?.snapshot) renderSnapshot(res.data.snapshot);
    return;
  }

  await saveSettings();
  const res = await sendToActiveReader({
    type: 'PD_START',
    options: opts,
  });
  if (!res?.ok || res?.data?.ok === false) {
    els.statusText.textContent = res?.data?.error || res?.error || 'Could not start capture.';
    return;
  }
  if (res.data?.snapshot) {
    renderSnapshot(res.data.snapshot);
  }
  managePolling(true);
});

els.stopBtn.addEventListener('click', async () => {
  const res = await sendToActiveReader({ type: 'PD_STOP' });
  if (res?.data?.snapshot) {
    renderSnapshot(res.data.snapshot);
  }
});

els.exportCachedBtn.addEventListener('click', async () => {
  const opts = readOptionsFromUI();
  if (opts.formats.length === 0) {
    els.statusText.textContent = 'Select at least one output format first.';
    return;
  }
  await saveSettings();
  const res = await sendToActiveReader({
    type: 'PD_EXPORT_CACHED',
    options: opts,
  });
  if (!res?.ok || res?.data?.ok === false) {
    els.statusText.textContent = res?.data?.error || res?.error || 'Export failed.';
    return;
  }
  if (res.data?.snapshot) {
    renderSnapshot(res.data.snapshot);
  }
  managePolling(true);
});

els.copyLogsBtn.addEventListener('click', async () => {
  const res = await sendToActiveReader({ type: 'PD_GET_LOGS' });
  const text = res?.data?.text || '';
  if (!text) {
    els.statusText.textContent = 'No logs recorded yet for this tab.';
    return;
  }
  await navigator.clipboard.writeText(text);
  const prev = els.copyLogsBtn.textContent;
  els.copyLogsBtn.textContent = 'Copied!';
  setTimeout(() => {
    els.copyLogsBtn.textContent = prev;
  }, 1800);
});

els.clearCacheBtn.addEventListener('click', async () => {
  if (!confirmingClear) {
    confirmingClear = true;
    els.clearCacheBtn.textContent = 'Click again to confirm';
    els.clearCacheBtn.classList.add('is-confirming');
    confirmClearTimer = setTimeout(() => {
      confirmingClear = false;
      els.clearCacheBtn.textContent = 'Clear Cache';
      els.clearCacheBtn.classList.remove('is-confirming');
    }, 3000);
    return;
  }

  clearTimeout(confirmClearTimer);
  confirmingClear = false;
  els.clearCacheBtn.textContent = 'Clear Cache';
  els.clearCacheBtn.classList.remove('is-confirming');

  const res = await sendToActiveReader({ type: 'PD_CLEAR_CACHE', allBooks: false });
  if (res?.data?.snapshot) {
    renderSnapshot(res.data.snapshot);
    refreshLibrary().catch(() => {});
  } else {
    els.statusText.textContent = res?.error || 'Cache cleared.';
  }
});

els.refreshLibraryBtn.addEventListener('click', () => {
  refreshLibrary().catch(() => {});
});

els.clearAllBooksBtn.addEventListener('click', async () => {
  if (!confirmingClearAll) {
    confirmingClearAll = true;
    els.clearAllBooksBtn.textContent = 'Confirm Clear All';
    els.clearAllBooksBtn.classList.add('is-confirming');
    confirmClearAllTimer = setTimeout(() => {
      confirmingClearAll = false;
      els.clearAllBooksBtn.textContent = 'Clear All Books';
      els.clearAllBooksBtn.classList.remove('is-confirming');
    }, 3000);
    return;
  }

  clearTimeout(confirmClearAllTimer);
  confirmingClearAll = false;
  els.clearAllBooksBtn.textContent = 'Clear All Books';
  els.clearAllBooksBtn.classList.remove('is-confirming');

  const res = await sendToActiveReader({ type: 'PD_CLEAR_CACHE', allBooks: true });
  if (res?.data?.snapshot) {
    renderSnapshot(res.data.snapshot);
  }
  await refreshLibrary();
});

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await refreshStatus();
  await refreshLibrary();
});
