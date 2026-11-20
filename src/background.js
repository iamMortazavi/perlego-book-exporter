/**
 * @file Manifest V3 background service worker.
 * Handles content-script injection, per-tab progress badge updates,
 * HTTPS asset proxying via host_permissions, and desktop notifications.
 */
'use strict';

const CONTENT_FILES = [
  'src/utils/async.js',
  'src/lib/zip.js',
  'src/storage/db.js',
  'src/utils/dom-cleaner.js',
  'src/exporters/html.js',
  'src/exporters/markdown.js',
  'src/exporters/epub.js',
  'src/ui/hud.js',
  'src/content-main.js',
];

const MAX_ASSET_BYTES = 50 * 1024 * 1024; // 50 MB safety cap per asset

function isPerlegoUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'ereader.perlego.com' || parsed.hostname.endsWith('.perlego.com'))
    );
  } catch {
    return false;
  }
}

function isExternalCdnUrl(url) {
  return /^https:\/\/(?:(?:api|cdn)[^/]*\.perlego\.com|[^/]+\.cloudfront\.net)\//i.test(url);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(''));
}

async function updateTabBadge(tabId, snapshot) {
  if (!tabId || !snapshot || !chrome.action?.setBadgeText) return;
  try {
    const status = snapshot.state;
    if (status === 'running') {
      const pct = Math.max(0, Math.min(100, Math.round(snapshot.progress || 0)));
      const text = snapshot.indeterminate ? '...' : `${pct}%`;
      await chrome.action.setBadgeText({ tabId, text });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#0969da' });
    } else if (status === 'paused') {
      await chrome.action.setBadgeText({ tabId, text: 'II' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d29922' });
    } else if (status === 'exporting') {
      await chrome.action.setBadgeText({ tabId, text: 'EXP' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#8250df' });
    } else if (snapshot.phaseLabel === 'Error') {
      await chrome.action.setBadgeText({ tabId, text: '!' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#cf222e' });
    } else if (snapshot.phaseLabel === 'Completed') {
      await chrome.action.setBadgeText({ tabId, text: 'OK' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#1a7f37' });
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch {
    // Tab may have closed
  }
}

async function ensureContentScripts(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'PD_PING' });
    if (ping?.initialized) {
      return ping;
    }
  } catch {
    // Content scripts are not injected in this tab yet
  }

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: CONTENT_FILES,
  });

  return chrome.tabs.sendMessage(tabId, { type: 'PD_PING' });
}

async function handleEnsureAndSend(payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { ok: false, error: 'No active browser tab found.' };
  }
  if (!isPerlegoUrl(tab.url)) {
    return {
      ok: false,
      notReader: true,
      tabId: tab.id,
      error: 'Open a Perlego book on ereader.perlego.com first.',
    };
  }

  await ensureContentScripts(tab.id);
  const response = await chrome.tabs.sendMessage(tab.id, payload);
  return { ok: true, tabId: tab.id, data: response };
}

async function handleFetchBinary(url) {
  if (!url || !/^https:\/\//i.test(url)) {
    return { ok: false, error: 'Invalid or non-HTTPS asset URL' };
  }

  const attempts = isExternalCdnUrl(url)
    ? [{ credentials: 'omit' }, { credentials: 'include' }]
    : [{ credentials: 'include' }];

  let lastError = 'Fetch failed';
  let lastStatus = 0;

  for (const fetchOpts of attempts) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        ...fetchOpts,
        signal: controller.signal,
      });
      lastStatus = res.status;
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        if (res.status === 401 || res.status === 403) {
          continue;
        }
        return { ok: false, status: res.status, error: lastError };
      }

      const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_ASSET_BYTES) {
        return { ok: false, error: `Asset exceeds ${MAX_ASSET_BYTES} byte safety limit` };
      }

      const contentType = res.headers.get('content-type') || '';
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength === 0) {
        lastError = 'Empty response body';
        continue;
      }
      if (buffer.byteLength > MAX_ASSET_BYTES) {
        return { ok: false, error: `Asset exceeds ${MAX_ASSET_BYTES} byte safety limit` };
      }

      return {
        ok: true,
        contentType,
        base64: arrayBufferToBase64(buffer),
      };
    } catch (err) {
      lastError = err?.message || 'Fetch failed';
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, status: lastStatus, error: lastError };
}

async function handleNotify(title, message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icons/icon-128.png'),
      title: title || 'Perlego Book Exporter Pro',
      message: message || 'Export finished.',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'Notification failed' };
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url && !isPerlegoUrl(changeInfo.url)) {
    try {
      await chrome.action.setBadgeText({ tabId, text: '' });
    } catch {
      // Ignore if tab closed
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return undefined;
  if (sender?.id && sender.id !== chrome.runtime.id) {
    return undefined;
  }

  if (message.type === 'PD_STATE_UPDATE') {
    if (sender?.tab?.id && message.snapshot) {
      updateTabBadge(sender.tab.id, message.snapshot).catch(() => {});
    }
    return undefined;
  }

  if (message.type === 'PD_ENSURE_AND_SEND') {
    (async () => {
      try {
        sendResponse(await handleEnsureAndSend(message.payload));
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === 'PD_FETCH_BINARY') {
    (async () => {
      try {
        sendResponse(await handleFetchBinary(message.url));
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === 'PD_NOTIFY') {
    (async () => {
      sendResponse(await handleNotify(message.title, message.message));
    })();
    return true;
  }

  return undefined;
});
