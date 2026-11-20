/**
 * @file Draggable Shadow-DOM in-page status HUD.
 * Displays live progress, ETA, skipped-section warnings, quick export buttons,
 * and a filterable live diagnostic log viewer isolated from page styles.
 */
(() => {
  'use strict';

  const PD = (globalThis.PerlegoDownloader = globalThis.PerlegoDownloader || {});
  const HOST_ID = 'perlego-exporter-hud-host';

  let hostEl = null;
  let shadowRoot = null;
  let refs = null;
  let actionHandler = null;
  let minimized = false;
  let logCollapsed = false;
  let logFilter = 'all'; // 'all' | 'issues'
  let fullLogsCache = [];
  let lastRenderedLogId = 0;

  const HUD_CSS = `
    :host {
      all: initial;
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483646;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color-scheme: light dark;
    }
    .hud {
      --bg: #ffffff;
      --surface: #f6f8fa;
      --border: #d0d7de;
      --text: #1f2328;
      --muted: #656d76;
      --accent: #0969da;
      --accent-hover: #0550ae;
      --danger: #cf222e;
      --ok: #1a7f37;
      --warn: #9a6700;
      --warn-bg: #fff8c5;
      --track: #e1e4e8;
      --log-bg: #f6f8fa;
      display: flex;
      flex-direction: column;
      width: min(680px, calc(100vw - 32px));
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.24);
      overflow: hidden;
      font-size: 13px;
      line-height: 1.4;
    }
    .hud.is-logs-collapsed {
      width: 320px;
    }
    @media (prefers-color-scheme: dark) {
      .hud {
        --bg: #161b22;
        --surface: #21262d;
        --border: #30363d;
        --text: #e6edf3;
        --muted: #8b949e;
        --accent: #2f81f7;
        --accent-hover: #58a6ff;
        --danger: #f85149;
        --ok: #3fb950;
        --warn: #d29922;
        --warn-bg: #2e2410;
        --track: #30363d;
        --log-bg: #0d1117;
      }
    }
    @supports (color: light-dark(white, black)) {
      .hud {
        --bg: light-dark(#ffffff, #161b22);
        --surface: light-dark(#f6f8fa, #21262d);
        --border: light-dark(#d0d7de, #30363d);
        --text: light-dark(#1f2328, #e6edf3);
        --muted: light-dark(#656d76, #8b949e);
        --accent: light-dark(#0969da, #2f81f7);
        --accent-hover: light-dark(#0550ae, #58a6ff);
        --danger: light-dark(#cf222e, #f85149);
        --ok: light-dark(#1a7f37, #3fb950);
        --warn: light-dark(#9a6700, #d29922);
        --warn-bg: light-dark(#fff8c5, #2e2410);
        --track: light-dark(#e1e4e8, #30363d);
        --log-bg: light-dark(#f6f8fa, #0d1117);
      }
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      cursor: grab;
      user-select: none;
    }
    .header:active {
      cursor: grabbing;
    }
    .title {
      font-weight: 600;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .header-actions {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }
    .icon-btn {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      border-radius: 6px;
      height: 24px;
      min-width: 24px;
      padding: 0 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
    }
    .icon-btn:hover { background: var(--surface); }
    .columns {
      display: grid;
      grid-template-columns: 290px 1fr;
    }
    .hud.is-logs-collapsed .columns {
      grid-template-columns: 1fr;
    }
    .hud.is-minimized .columns {
      display: none;
    }
    @media (max-width: 640px) {
      .columns {
        grid-template-columns: 1fr;
      }
    }
    .body {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .log-col {
      display: flex;
      flex-direction: column;
      border-left: 1px solid var(--border);
      background: var(--log-bg);
      min-width: 0;
      max-height: 280px;
    }
    .hud.is-logs-collapsed .log-col {
      display: none;
    }
    @media (max-width: 640px) {
      .log-col {
        border-left: none;
        border-top: 1px solid var(--border);
        max-height: 180px;
      }
    }
    .log-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 6px 10px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      font-size: 11.5px;
      font-weight: 600;
    }
    .log-tools {
      display: flex;
      gap: 4px;
    }
    .log-btn {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      border-radius: 5px;
      padding: 2px 7px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .log-btn:hover { background: var(--surface); }
    .log-btn.is-active {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }
    .log-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      line-height: 1.45;
      display: flex;
      flex-direction: column;
      gap: 3px;
      user-select: text;
    }
    .log-line {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .log-ts {
      color: var(--muted);
      margin-right: 5px;
    }
    .log-lvl-info { color: var(--text); }
    .log-lvl-ok { color: var(--ok); }
    .log-lvl-warn { color: var(--warn); }
    .log-lvl-error { color: var(--danger); font-weight: 600; }
    .meta-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      color: var(--muted);
      gap: 8px;
    }
    .phase {
      font-weight: 600;
      color: var(--text);
    }
    .warn-pill {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--warn-bg);
      color: var(--warn);
    }
    .warn-pill[hidden] {
      display: none;
    }
    progress {
      appearance: none;
      border: 0 solid;
      overflow: clip;
      width: 100%;
      height: 8px;
      border-radius: 1e5px;
      background: var(--track);
      container-type: inline-size;
      --progress-bar-fill: var(--accent);
      --progress-bar-indeterminate-size: 30%;
      --progress-bar-indeterminate-animation-duration: 1.5s;
    }
    @media (prefers-reduced-motion: reduce) {
      progress {
        --progress-bar-indeterminate-animation-duration: 10s;
      }
    }
    progress:dir(rtl) {
      --progress-bar-indeterminate-animation: progress-bar-indeterminate var(--progress-bar-indeterminate-animation-duration) infinite linear reverse;
    }
    progress:indeterminate {
      --progress-bar-animation: var(
        --progress-bar-indeterminate-animation,
        progress-bar-indeterminate var(--progress-bar-indeterminate-animation-duration) infinite linear
      );
    }
    progress::-webkit-progress-bar {
      background: transparent;
    }
    progress::-webkit-progress-value {
      background: var(--progress-bar-fill);
      border-radius: 1e5px;
      transition: inline-size 0.25s ease;
      animation: var(--progress-bar-animation, revert-rule);
    }
    progress::-moz-progress-bar {
      background: var(--progress-bar-fill);
      border-radius: 1e5px;
      transition: inline-size 0.25s ease;
      animation: var(--progress-bar-animation, revert-rule);
    }
    @keyframes progress-bar-indeterminate {
      from, to {
        inline-size: var(--progress-bar-indeterminate-size);
        margin-right: auto;
      }
      from {
        translate: -100%;
      }
      to {
        translate: 100cqi;
      }
    }
    .status {
      font-size: 12px;
      color: var(--muted);
      word-break: break-word;
    }
    .actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .btn {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      flex: 1;
      text-align: center;
    }
    .btn:hover:not(:disabled) { filter: brightness(0.95); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }
    .btn-danger {
      color: var(--danger);
    }
    .quick-exports {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }
  `;

  function formatLogsAsText(logs) {
    return (logs || [])
      .map((l) => `[${l.ts}] [${String(l.level || 'info').toUpperCase()}] ${l.text}`)
      .join('\n');
  }

  async function copyLogsToClipboard(btn) {
    const text = formatLogsAsText(fullLogsCache);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.textContent = prev;
      }, 1800);
    }
  }

  function downloadLogsFile() {
    const text = formatLogsAsText(fullLogsCache);
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `perlego-exporter-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function ensureMounted() {
    if (hostEl && document.contains(hostEl)) return;
    hostEl = document.getElementById(HOST_ID);
    if (!hostEl) {
      hostEl = document.createElement('div');
      hostEl.id = HOST_ID;
      document.documentElement.appendChild(hostEl);
    }
    shadowRoot = hostEl.shadowRoot || hostEl.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = '';

    const style = document.createElement('style');
    style.textContent = HUD_CSS;

    const card = document.createElement('div');
    card.className = 'hud';
    if (minimized) card.classList.add('is-minimized');
    if (logCollapsed) card.classList.add('is-logs-collapsed');

    const header = document.createElement('div');
    header.className = 'header';
    const titleEl = document.createElement('span');
    titleEl.className = 'title';
    titleEl.textContent = 'Perlego Book Exporter';

    const headerActions = document.createElement('div');
    headerActions.className = 'header-actions';
    const toggleLogBtn = document.createElement('button');
    toggleLogBtn.type = 'button';
    toggleLogBtn.className = 'icon-btn';
    toggleLogBtn.title = 'Toggle Log Column';
    toggleLogBtn.textContent = logCollapsed ? 'Logs ▸' : 'Logs ▾';

    const minBtn = document.createElement('button');
    minBtn.type = 'button';
    minBtn.className = 'icon-btn';
    minBtn.title = 'Minimize';
    minBtn.textContent = minimized ? '+' : '–';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'icon-btn';
    closeBtn.title = 'Hide HUD';
    closeBtn.textContent = '×';
    headerActions.append(toggleLogBtn, minBtn, closeBtn);
    header.append(titleEl, headerActions);

    const columns = document.createElement('div');
    columns.className = 'columns';

    const body = document.createElement('div');
    body.className = 'body';

    const metaRow = document.createElement('div');
    metaRow.className = 'meta-row';
    const phaseEl = document.createElement('span');
    phaseEl.className = 'phase';
    phaseEl.textContent = 'Ready';
    const countsEl = document.createElement('span');
    countsEl.textContent = '0%';
    metaRow.append(phaseEl, countsEl);

    const progressEl = document.createElement('progress');
    progressEl.max = 100;
    progressEl.value = 0;
    progressEl.setAttribute('aria-label', 'Book export progress');

    const statusEl = document.createElement('div');
    statusEl.className = 'status';
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.textContent = '';

    const skippedEl = document.createElement('div');
    skippedEl.className = 'warn-pill';
    skippedEl.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'actions';
    const pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.className = 'btn btn-primary';
    pauseBtn.textContent = 'Pause';

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'btn btn-danger';
    stopBtn.textContent = 'Stop';
    actions.append(pauseBtn, stopBtn);

    const quickExports = document.createElement('div');
    quickExports.className = 'quick-exports';
    const expEpubBtn = document.createElement('button');
    expEpubBtn.type = 'button';
    expEpubBtn.className = 'btn';
    expEpubBtn.textContent = 'EPUB';

    const expMdBtn = document.createElement('button');
    expMdBtn.type = 'button';
    expMdBtn.className = 'btn';
    expMdBtn.textContent = 'MD';

    const expHtmlBtn = document.createElement('button');
    expHtmlBtn.type = 'button';
    expHtmlBtn.className = 'btn';
    expHtmlBtn.textContent = 'HTML';
    quickExports.append(expEpubBtn, expMdBtn, expHtmlBtn);

    body.append(metaRow, progressEl, statusEl, skippedEl, actions, quickExports);

    const logCol = document.createElement('div');
    logCol.className = 'log-col';

    const logHeader = document.createElement('div');
    logHeader.className = 'log-header';
    const logTitle = document.createElement('span');
    logTitle.textContent = 'Live Logs (0)';
    const logTools = document.createElement('div');
    logTools.className = 'log-tools';
    const filterIssuesBtn = document.createElement('button');
    filterIssuesBtn.type = 'button';
    filterIssuesBtn.className = 'log-btn';
    filterIssuesBtn.title = 'Toggle Warnings & Errors only';
    filterIssuesBtn.textContent = 'Issues';
    const copyLogBtn = document.createElement('button');
    copyLogBtn.type = 'button';
    copyLogBtn.className = 'log-btn';
    copyLogBtn.textContent = 'Copy';
    const saveLogBtn = document.createElement('button');
    saveLogBtn.type = 'button';
    saveLogBtn.className = 'log-btn';
    saveLogBtn.textContent = 'Save .log';
    const clearLogBtn = document.createElement('button');
    clearLogBtn.type = 'button';
    clearLogBtn.className = 'log-btn';
    clearLogBtn.textContent = 'Clear';
    logTools.append(filterIssuesBtn, copyLogBtn, saveLogBtn, clearLogBtn);
    logHeader.append(logTitle, logTools);

    const logList = document.createElement('div');
    logList.className = 'log-list';

    logCol.append(logHeader, logList);
    columns.append(body, logCol);
    card.append(header, columns);
    shadowRoot.append(style, card);

    // Enable smooth header dragging clamped to the viewport
    header.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('button')) return;
      ev.preventDefault();
      const rect = hostEl.getBoundingClientRect();
      const offsetX = ev.clientX - rect.left;
      const offsetY = ev.clientY - rect.top;
      hostEl.style.left = `${rect.left}px`;
      hostEl.style.top = `${rect.top}px`;
      hostEl.style.right = 'auto';
      hostEl.style.bottom = 'auto';
      header.setPointerCapture?.(ev.pointerId);

      const onMove = (moveEv) => {
        const w = hostEl.offsetWidth || rect.width;
        const h = hostEl.offsetHeight || rect.height;
        const maxLeft = Math.max(8, window.innerWidth - w - 8);
        const maxTop = Math.max(8, window.innerHeight - h - 8);
        const nextLeft = Math.max(8, Math.min(maxLeft, moveEv.clientX - offsetX));
        const nextTop = Math.max(8, Math.min(maxTop, moveEv.clientY - offsetY));
        hostEl.style.left = `${nextLeft}px`;
        hostEl.style.top = `${nextTop}px`;
      };
      const onUp = () => {
        header.removeEventListener('pointermove', onMove);
        header.removeEventListener('pointerup', onUp);
        header.removeEventListener('pointercancel', onUp);
      };
      header.addEventListener('pointermove', onMove);
      header.addEventListener('pointerup', onUp);
      header.addEventListener('pointercancel', onUp);
    });

    toggleLogBtn.addEventListener('click', () => {
      logCollapsed = !logCollapsed;
      card.classList.toggle('is-logs-collapsed', logCollapsed);
      toggleLogBtn.textContent = logCollapsed ? 'Logs ▸' : 'Logs ▾';
    });

    minBtn.addEventListener('click', () => {
      minimized = !minimized;
      card.classList.toggle('is-minimized', minimized);
      minBtn.textContent = minimized ? '+' : '–';
    });

    closeBtn.addEventListener('click', () => {
      hide();
    });

    pauseBtn.addEventListener('click', () => {
      actionHandler?.('togglePause');
    });
    stopBtn.addEventListener('click', () => {
      actionHandler?.('stop');
    });
    expEpubBtn.addEventListener('click', () => {
      actionHandler?.('exportFormat', 'epub');
    });
    expMdBtn.addEventListener('click', () => {
      actionHandler?.('exportFormat', 'markdown');
    });
    expHtmlBtn.addEventListener('click', () => {
      actionHandler?.('exportFormat', 'html');
    });
    filterIssuesBtn.addEventListener('click', () => {
      logFilter = logFilter === 'all' ? 'issues' : 'all';
      filterIssuesBtn.classList.toggle('is-active', logFilter === 'issues');
      lastRenderedLogId = 0;
      logList.innerHTML = '';
      renderLogs(fullLogsCache, true);
    });
    copyLogBtn.addEventListener('click', () => {
      copyLogsToClipboard(copyLogBtn);
    });
    saveLogBtn.addEventListener('click', () => {
      downloadLogsFile();
    });
    clearLogBtn.addEventListener('click', () => {
      lastRenderedLogId = 0;
      fullLogsCache = [];
      logList.innerHTML = '';
      logTitle.textContent = 'Live Logs (0)';
      actionHandler?.('clearLogs');
    });

    refs = {
      card,
      titleEl,
      phaseEl,
      countsEl,
      progressEl,
      statusEl,
      skippedEl,
      pauseBtn,
      stopBtn,
      expEpubBtn,
      expMdBtn,
      expHtmlBtn,
      logTitle,
      logList,
      filterIssuesBtn,
    };
  }

  function renderLogs(logs, forceRebuild = false) {
    if (!refs || !Array.isArray(logs)) return;
    fullLogsCache = logs;
    const issueCount = logs.filter((l) => l.level === 'warn' || l.level === 'error').length;
    refs.logTitle.textContent = logFilter === 'issues'
      ? `Issues (${issueCount}/${logs.length})`
      : `Live Logs (${logs.length})`;
    if (refs.filterIssuesBtn) {
      refs.filterIssuesBtn.textContent = issueCount > 0 ? `Issues (${issueCount})` : 'Issues';
    }

    if (logs.length === 0) {
      if (lastRenderedLogId !== 0 || forceRebuild) {
        refs.logList.innerHTML = '';
        lastRenderedLogId = 0;
      }
      return;
    }

    const listEl = refs.logList;
    const isNearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 36;
    const filtered = logFilter === 'issues'
      ? logs.filter((entry) => entry.level === 'warn' || entry.level === 'error')
      : logs;
    const newEntries = forceRebuild
      ? filtered.slice(-300)
      : filtered.filter((entry) => entry.id > lastRenderedLogId);

    if (newEntries.length === 0) return;

    const frag = document.createDocumentFragment();
    for (const entry of newEntries) {
      const line = document.createElement('div');
      line.className = `log-line log-lvl-${entry.level || 'info'}`;

      const tsSpan = document.createElement('span');
      tsSpan.className = 'log-ts';
      tsSpan.textContent = `[${entry.ts}]`;

      const msgSpan = document.createElement('span');
      msgSpan.textContent = entry.text;

      line.append(tsSpan, msgSpan);
      frag.appendChild(line);
      lastRenderedLogId = entry.id;
    }

    listEl.appendChild(frag);
    while (listEl.childNodes.length > 300) {
      listEl.removeChild(listEl.firstChild);
    }
    if (isNearBottom || forceRebuild) {
      listEl.scrollTop = listEl.scrollHeight;
    }
  }

  function setActionHandler(fn) {
    actionHandler = fn;
  }

  function formatEta(etaSeconds) {
    if (!Number.isFinite(etaSeconds) || etaSeconds <= 0) return '';
    if (etaSeconds < 60) return ` • ~${Math.ceil(etaSeconds)}s left`;
    const mins = Math.floor(etaSeconds / 60);
    const secs = Math.round(etaSeconds % 60);
    return ` • ~${mins}m ${secs}s left`;
  }

  function update(snapshot) {
    ensureMounted();
    if (!refs) return;

    if (snapshot.title) refs.titleEl.textContent = snapshot.title;
    refs.phaseEl.textContent = snapshot.phaseLabel || 'Working';

    const pct = Math.max(0, Math.min(100, Math.round(snapshot.progress || 0)));
    if (snapshot.indeterminate) {
      refs.progressEl.removeAttribute('value');
    } else {
      refs.progressEl.value = pct;
    }

    const countText = snapshot.totalItems > 0
      ? `${snapshot.currentItem || 0}/${snapshot.totalItems} (${pct}%)`
      : `${pct}%`;
    refs.countsEl.textContent = `${countText}${formatEta(snapshot.etaSeconds)}`;
    refs.statusEl.textContent = snapshot.message || '';

    const skipped = snapshot.skippedCount || 0;
    if (skipped > 0) {
      refs.skippedEl.hidden = false;
      refs.skippedEl.textContent = `${skipped} skipped section(s) — Resume will retry only missing items`;
    } else {
      refs.skippedEl.hidden = true;
    }

    const isRunning = snapshot.state === 'running';
    const isPaused = snapshot.state === 'paused';
    const isExporting = snapshot.state === 'exporting';

    refs.pauseBtn.disabled = !isRunning && !isPaused;
    refs.pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
    refs.stopBtn.disabled = !isRunning && !isPaused && !isExporting;

    const canExport = (snapshot.cachedCount || 0) > 0 && !isExporting && !isRunning;
    refs.expEpubBtn.disabled = !canExport;
    refs.expMdBtn.disabled = !canExport;
    refs.expHtmlBtn.disabled = !canExport;

    if (Array.isArray(snapshot.logs)) {
      renderLogs(snapshot.logs);
    }
  }

  function hide() {
    if (hostEl && hostEl.parentNode) {
      hostEl.parentNode.removeChild(hostEl);
    }
    hostEl = null;
    shadowRoot = null;
    refs = null;
    lastRenderedLogId = 0;
  }

  PD.hud = {
    setActionHandler,
    update,
    hide,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PD.hud;
  }
})();
