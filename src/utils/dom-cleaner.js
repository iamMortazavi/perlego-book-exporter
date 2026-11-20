/**
 * @file HTML sanitization, asset discovery, metadata enrichment, and link resolution.
 * Cleans Perlego reader markup, extracts ISBN/publisher/language/RTL metadata,
 * downloads assets with retry/fallback, and resolves book-wide internal hyperlinks.
 */
(() => {
  'use strict';

  const PD = (globalThis.PerlegoDownloader = globalThis.PerlegoDownloader || {});

  function sanitizeFilename(input) {
    const cleaned = String(input || '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140)
      .replace(/[. -]+$/g, '')
      .trim();
    return cleaned || 'Perlego Book';
  }

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function formatBookFilename(meta = {}) {
    const rawTitle = String(meta.title || 'Perlego Book').trim();
    const year = String(meta.year || '').trim();
    const combined =
      year && !new RegExp(`\\(${escapeRegExp(year)}\\)$`).test(rawTitle)
        ? `${rawTitle} (${year})`
        : rawTitle;
    return sanitizeFilename(combined);
  }

  /**
   * Extracts book ID, title, author, and detected format from the Perlego reader DOM.
   * @param {Document} [doc]
   * @param {Location|{ pathname?: string, href?: string }} [loc]
   */
  function extractBookContext(
    doc = typeof document !== 'undefined' ? document : null,
    loc = typeof location !== 'undefined' ? location : { pathname: '/', href: '' }
  ) {
    const pathname = String(loc?.pathname || '/');
    const href = String(loc?.href || '');
    const idMatch = pathname.match(/\/book\/(\d+)/i);
    const bookId = idMatch
      ? `book-${idMatch[1]}`
      : `path-${sanitizeFilename(pathname.replace(/^\//, '')).replace(/\s+/g, '-')}`;

    let title = '';
    let author = '';
    let detectedMode = 'auto';

    if (doc) {
      const titleSelectors = [
        '[data-test-locator*="BookTitle"]',
        '[data-test-locator*="book-title"]',
        '[data-test-locator="reader-book-title"]',
        'header h1',
        'h1',
      ];
      for (const sel of titleSelectors) {
        const el = doc.querySelector?.(sel);
        const text = el?.textContent?.trim();
        if (text) {
          title = text.replace(/\s+/g, ' ');
          break;
        }
      }
      if (!title && doc.title) {
        title = String(doc.title)
          .replace(/\s*[|\-–—]\s*Perlego.*$/i, '')
          .replace(/^Read\s+|\s+online$/gi, '')
          .trim();
      }

      const authorSelectors = [
        '[data-test-locator*="Author"]',
        '[data-test-locator*="author"]',
      ];
      for (const sel of authorSelectors) {
        const el = doc.querySelector?.(sel);
        const text = el?.textContent?.trim();
        if (text) {
          author = text.replace(/\s+/g, ' ');
          break;
        }
      }
      if (!author) {
        const metaAuthor = doc.querySelector?.('meta[name="author"]');
        if (metaAuthor?.getAttribute) {
          author = (metaAuthor.getAttribute('content') || '').trim();
        }
      }

      if (doc.querySelector?.('[data-test-locator^="Epub-ChapterRow-Index-"]')) {
        detectedMode = 'epub';
      } else if (
        doc.querySelector?.(
          '[id^="p"][id$="--0"] object, [data-test-locator="pagetion-total-chapter-numbers"], [data-test-locator^="Epub-ChapterRow-Page-"], [data-test-locator^="Pdf-"]'
        )
      ) {
        detectedMode = 'pdf';
      }
    }

    const finalTitle = title || `Perlego ${bookId}`;
    return {
      bookId,
      title: finalTitle,
      safeTitle: sanitizeFilename(finalTitle),
      author,
      url: href,
      detectedMode,
    };
  }

  function resolveUrl(rawUrl, baseUrl = 'https://ereader.perlego.com/') {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) return '';
    if (/^(data:|blob:)/i.test(trimmed)) return trimmed;
    if (/^javascript:/i.test(trimmed)) return '';
    try {
      return new URL(trimmed, baseUrl).href;
    } catch {
      return trimmed;
    }
  }

  function isBlankPlaceholderUrl(url) {
    return /^data:image\/gif;base64,R0lGODlhAQAB/i.test(url) || url === 'about:blank';
  }

  /**
   * Parses a `srcset` or `data-srcset` string and picks the highest resolution URL.
   * Handles commas inside query parameters safely by splitting only on comma + whitespace.
   * @param {string} srcset
   * @param {string} [baseUrl]
   * @returns {string}
   */
  function parseSrcsetBestUrl(srcset, baseUrl = 'https://ereader.perlego.com/') {
    const raw = String(srcset || '').trim();
    if (!raw) return '';

    const parts = raw.split(/,\s+/);
    let bestUrl = '';
    let bestScore = -1;

    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i].trim();
      if (!segment) continue;

      const tokens = segment.split(/\s+/);
      const urlPart = tokens[0];
      const resolved = resolveUrl(urlPart, baseUrl);
      if (!resolved || isBlankPlaceholderUrl(resolved)) continue;

      let score = i * 0.001; // slight preference for later candidate if equal
      if (tokens[1]) {
        const desc = tokens[1].toLowerCase();
        const num = parseFloat(desc);
        if (!Number.isNaN(num)) {
          if (desc.endsWith('w')) score = num;
          else if (desc.endsWith('x')) score = num * 1000;
        }
      } else {
        score = 1000 + i * 0.001;
      }

      if (score > bestScore) {
        bestScore = score;
        bestUrl = resolved;
      }
    }

    return bestUrl;
  }

  function pickImageUrlsFromPicture(pictureEl, baseUrl) {
    const preferred = [];
    const fallbackImg = [];
    const webp = [];
    const seen = new Set();

    const pushCandidate = (bucket, url) => {
      if (!url || isBlankPlaceholderUrl(url) || seen.has(url)) return;
      seen.add(url);
      bucket.push(url);
    };

    const sources = pictureEl.querySelectorAll('source');
    for (const src of sources) {
      const type = (src.getAttribute('type') || '').toLowerCase();
      const bucket = type.includes('webp') ? webp : preferred;
      const dataSrcset = src.getAttribute('data-srcset');
      if (dataSrcset) pushCandidate(bucket, parseSrcsetBestUrl(dataSrcset, baseUrl));
      const srcset = src.getAttribute('srcset');
      if (srcset) pushCandidate(bucket, parseSrcsetBestUrl(srcset, baseUrl));
      const dataSrc = src.getAttribute('data-src');
      if (dataSrc) pushCandidate(bucket, resolveUrl(dataSrc, baseUrl));
      const directSrc = src.getAttribute('src');
      if (directSrc) pushCandidate(bucket, resolveUrl(directSrc, baseUrl));
    }

    const innerImg = pictureEl.querySelector('img');
    if (innerImg) {
      const dataSrcset = innerImg.getAttribute('data-srcset');
      if (dataSrcset) pushCandidate(fallbackImg, parseSrcsetBestUrl(dataSrcset, baseUrl));
      const srcset = innerImg.getAttribute('srcset');
      if (srcset) pushCandidate(fallbackImg, parseSrcsetBestUrl(srcset, baseUrl));
      const dataSrc = innerImg.getAttribute('data-src');
      if (dataSrc) pushCandidate(fallbackImg, resolveUrl(dataSrc, baseUrl));
      const directSrc = innerImg.getAttribute('src');
      if (directSrc) pushCandidate(fallbackImg, resolveUrl(directSrc, baseUrl));
    }

    const ordered = [...preferred, ...fallbackImg, ...webp];
    return {
      primaryUrl: ordered[0] || '',
      fallbackUrl: ordered[1] || '',
    };
  }

  function pickBestImageUrlFromPicture(pictureEl, baseUrl) {
    return pickImageUrlsFromPicture(pictureEl, baseUrl).primaryUrl;
  }

  function cleanImageStyle(styleText) {
    if (!styleText) return '';
    let cleaned = String(styleText)
      .replace(/opacity\s*:\s*0(?:\.0+)?\s*;?/gi, 'opacity: 1;');
    if (/object-fit\s*:\s*contain/i.test(cleaned)) {
      cleaned = cleaned.replace(/height\s*:\s*100%\s*;?/gi, 'height: auto;');
    }
    return cleaned.trim();
  }

  function getDOMParser(customParser) {
    if (customParser) return customParser;
    if (typeof DOMParser !== 'undefined') return new DOMParser();
    throw new Error('DOMParser is not available in this environment');
  }

  /**
   * Normalizes and cleans raw Perlego chapter/page HTML using real DOM parsing.
   * @param {string} rawHtml
   * @param {{ baseUrl?: string, index?: number, domParser?: DOMParser }} [options]
   * @returns {{ html: string, title: string, assetUrls: string[] }}
   */
  function cleanChapterHtml(rawHtml, options = {}) {
    const {
      baseUrl = 'https://ereader.perlego.com/',
      index = 0,
      domParser,
    } = options;

    const parser = getDOMParser(domParser);
    const doc = parser.parseFromString(String(rawHtml || ''), 'text/html');
    const body = doc.body;
    const assetSet = new Set();
    const assetFallbacks = {};

    // Preserve Perlego scrollWithinBook() and composite ID hints before stripping scripts/attributes
    for (const el of Array.from(body.getElementsByTagName('*'))) {
      const rawId = el.getAttribute('id');
      if (rawId && /\s/.test(rawId.trim())) {
        const parts = rawId.trim().split(/\s+/);
        el.setAttribute('id', parts[0]);
        if (parts.length > 1 && !el.getAttribute('data-originalid')) {
          el.setAttribute('data-originalid', parts.slice(1).join(' '));
        }
      }

      const onclick = el.getAttribute('onclick');
      if (onclick) {
        const scrollMatch = onclick.match(
          /scrollWithinBook\(\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]\s*\)/i
        );
        if (scrollMatch) {
          const targetId = scrollMatch[1].trim();
          const chapterIdx = scrollMatch[2].trim();
          const tag = (el.localName || el.tagName || '').toLowerCase();
          const nestedLinks = tag === 'a' ? [el] : Array.from(el.querySelectorAll('a'));
          const targets = nestedLinks.length > 0 ? nestedLinks : [el];
          for (const t of targets) {
            if (targetId && !t.getAttribute('data-pd-scroll-target')) {
              t.setAttribute('data-pd-scroll-target', targetId);
            }
            if (chapterIdx && !t.getAttribute('data-pd-scroll-chapter')) {
              t.setAttribute('data-pd-scroll-chapter', chapterIdx);
            }
          }
        }
        el.removeAttribute('onclick');
      }
    }

    // Remove interactive / non-book clutter
    const removeSelectors = [
      'script',
      'noscript',
      'iframe',
      'button',
      '[data-test-locator*="Toolbar"]',
      '.highlighter-popover',
      '#perlego-exporter-hud-host',
    ];
    for (const sel of removeSelectors) {
      for (const el of Array.from(body.querySelectorAll(sel))) {
        el.remove();
      }
    }

    // Resolve <picture> elements cleanly into single <img> tags
    for (const pic of Array.from(body.querySelectorAll('picture'))) {
      const { primaryUrl, fallbackUrl } = pickImageUrlsFromPicture(pic, baseUrl);
      if (!primaryUrl) {
        pic.remove();
        continue;
      }
      const origImg = pic.querySelector('img');
      const newImg = doc.createElement('img');
      newImg.setAttribute('src', primaryUrl);
      if (fallbackUrl && fallbackUrl !== primaryUrl) {
        newImg.setAttribute('data-fallback-src', fallbackUrl);
        if (/^https?:\/\//i.test(primaryUrl) && /^https?:\/\//i.test(fallbackUrl)) {
          assetFallbacks[primaryUrl] = fallbackUrl;
        }
      }
      newImg.setAttribute('alt', origImg?.getAttribute('alt') || '');
      const titleAttr = origImg?.getAttribute('title');
      if (titleAttr) newImg.setAttribute('title', titleAttr);
      const classAttr = origImg?.getAttribute('class') || pic.getAttribute('class');
      if (classAttr) newImg.setAttribute('class', classAttr);
      const cleanedStyle = cleanImageStyle(origImg?.getAttribute('style') || '');
      if (cleanedStyle) newImg.setAttribute('style', cleanedStyle);
      newImg.setAttribute('loading', 'lazy');
      newImg.setAttribute('decoding', 'async');
      pic.replaceWith(newImg);
    }

    // Normalize all remaining <img> tags
    for (const img of Array.from(body.querySelectorAll('img'))) {
      const candidate =
        parseSrcsetBestUrl(img.getAttribute('data-srcset'), baseUrl) ||
        parseSrcsetBestUrl(img.getAttribute('srcset'), baseUrl) ||
        resolveUrl(img.getAttribute('data-src'), baseUrl) ||
        resolveUrl(img.getAttribute('src'), baseUrl);

      if (!candidate || isBlankPlaceholderUrl(candidate)) {
        img.remove();
        continue;
      }

      img.setAttribute('src', candidate);
      if (!img.hasAttribute('alt')) img.setAttribute('alt', '');
      img.removeAttribute('data-src');
      img.removeAttribute('data-srcset');
      img.removeAttribute('srcset');

      const cleanedStyle = cleanImageStyle(img.getAttribute('style') || '');
      if (cleanedStyle) img.setAttribute('style', cleanedStyle);
      else img.removeAttribute('style');

      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');

      if (/^https?:\/\//i.test(candidate)) {
        assetSet.add(candidate);
      }
    }

    // Normalize PDF <object data="..."> tags
    for (const obj of Array.from(body.querySelectorAll('object'))) {
      const dataUrl = resolveUrl(obj.getAttribute('data') || obj.getAttribute('data-src'), baseUrl);
      if (dataUrl) {
        obj.setAttribute('data', dataUrl);
        obj.setAttribute('data-asset-url', dataUrl);
        if (/^https?:\/\//i.test(dataUrl)) {
          assetSet.add(dataUrl);
        }
      }
      const cleanedStyle = cleanImageStyle(obj.getAttribute('style') || '');
      if (cleanedStyle) obj.setAttribute('style', cleanedStyle);
    }

    // Clean opacity: 0 on any wrapper elements left behind by Perlego lazy reveal
    for (const el of Array.from(body.querySelectorAll('[style*="opacity"]'))) {
      const cleaned = cleanImageStyle(el.getAttribute('style') || '');
      if (cleaned) el.setAttribute('style', cleaned);
    }

    // Extract heading title
    let title = '';
    const headingEl = body.querySelector('h1, h2, h3, [role="heading"]');
    if (headingEl) {
      title = headingEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
    }
    if (!title) {
      title = `Section ${index + 1}`;
    }

    return {
      html: body.innerHTML,
      title,
      assetUrls: Array.from(assetSet),
      assetFallbacks,
    };
  }

  const MIME_EXT_MAP = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
  };

  /**
   * Detects real MIME type and file extension from magic bytes first, then header/URL.
   * Prevents CloudFront `binary/octet-stream` headers from breaking EPUB packaging.
   * @param {Uint8Array} bytes
   * @param {string} [headerContentType]
   * @param {string} [url]
   * @returns {{ mime: string, ext: string }}
   */
  function detectImageMimeAndExt(bytes, headerContentType = '', url = '') {
    if (bytes && bytes.length >= 4) {
      // JPEG: FF D8 FF
      if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return { mime: 'image/jpeg', ext: 'jpg' };
      }
      // PNG: 89 50 4E 47
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return { mime: 'image/png', ext: 'png' };
      }
      // GIF: 47 49 46 38
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return { mime: 'image/gif', ext: 'gif' };
      }
      // WEBP: RIFF....WEBP
      if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
      ) {
        return { mime: 'image/webp', ext: 'webp' };
      }
      // PDF: %PDF
      if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
        return { mime: 'application/pdf', ext: 'pdf' };
      }
      // SVG text signature
      const headLen = Math.min(bytes.length, 300);
      let headStr = '';
      for (let i = 0; i < headLen; i++) {
        headStr += String.fromCharCode(bytes[i]);
      }
      if (/<svg[\s>]/i.test(headStr)) {
        return { mime: 'image/svg+xml', ext: 'svg' };
      }
    }

    const cleanHeader = String(headerContentType || '').split(';')[0].trim().toLowerCase();
    if (cleanHeader && MIME_EXT_MAP[cleanHeader]) {
      const normalizedMime = cleanHeader === 'image/jpg' ? 'image/jpeg' : cleanHeader;
      return { mime: normalizedMime, ext: MIME_EXT_MAP[cleanHeader] };
    }

    const pathMatch = String(url || '').split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i);
    if (pathMatch) {
      const ext = pathMatch[1].toLowerCase();
      if (ext === 'jpeg' || ext === 'jpg') return { mime: 'image/jpeg', ext: 'jpg' };
      if (ext === 'png') return { mime: 'image/png', ext: 'png' };
      if (ext === 'gif') return { mime: 'image/gif', ext: 'gif' };
      if (ext === 'webp') return { mime: 'image/webp', ext: 'webp' };
      if (ext === 'svg') return { mime: 'image/svg+xml', ext: 'svg' };
      if (ext === 'pdf') return { mime: 'application/pdf', ext: 'pdf' };
    }

    return { mime: 'image/jpeg', ext: 'jpg' };
  }

  function bytesToBase64(bytes) {
    const CHUNK = 0x8000;
    const parts = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return btoa(parts.join(''));
  }

  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  function bytesToDataUrl(bytes, mime) {
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
  }

  /**
   * Creates an asset record whose `dataUrl` is computed lazily on first access,
   * avoiding base64 RAM overhead during EPUB-only exports.
   */
  function createLazyAssetEntry(bytes, mime, ext) {
    let cachedDataUrl = null;
    return {
      bytes,
      mime,
      ext,
      get dataUrl() {
        if (cachedDataUrl === null) {
          cachedDataUrl = bytesToDataUrl(bytes, mime);
        }
        return cachedDataUrl;
      },
    };
  }

  async function fetchSingleUrlBytes(url, { fetchImpl, backgroundFetcher, signal, retries = 2 }) {
    const attemptOnce = async () => {
      let bytes = null;
      let contentType = '';
      let transientError = null;

      if (fetchImpl) {
        const isExternalCdn = /^https:\/\/(?:(?:api|cdn)[^/]*\.perlego\.com|[^/]+\.cloudfront\.net)\//i.test(url);
        const attempts = isExternalCdn
          ? [
              { credentials: 'omit', cache: 'force-cache' },
              { credentials: 'include' },
            ]
          : [{ credentials: 'include' }];

        for (const fetchOpts of attempts) {
          if (signal?.aborted) throw PD.async.createAbortError();
          try {
            let fetchSignal = signal;
            if (typeof AbortSignal?.timeout === 'function') {
              const timeoutSignal = AbortSignal.timeout(15000);
              fetchSignal =
                signal && typeof AbortSignal?.any === 'function'
                  ? AbortSignal.any([signal, timeoutSignal])
                  : (signal || timeoutSignal);
            }
            const res = await fetchImpl(url, { ...fetchOpts, signal: fetchSignal });
            if (res.ok) {
              contentType = res.headers.get('content-type') || '';
              bytes = new Uint8Array(await res.arrayBuffer());
              if (bytes.byteLength > 0) return { bytes, contentType };
              bytes = null;
            } else if (res.status === 429 || res.status >= 500) {
              transientError = new Error(`HTTP ${res.status}`);
            }
          } catch (err) {
            if (err?.name === 'AbortError' && signal?.aborted) throw err;
            transientError = err;
          }
        }
      }

      if (!bytes && typeof backgroundFetcher === 'function') {
        if (signal?.aborted) throw PD.async.createAbortError();
        try {
          const bgRes = await backgroundFetcher(url);
          if (bgRes?.ok && bgRes.base64) {
            contentType = bgRes.contentType || '';
            bytes = base64ToUint8Array(bgRes.base64);
            if (bytes.byteLength > 0) return { bytes, contentType };
          } else if (bgRes?.status === 429 || (bgRes?.status && bgRes.status >= 500)) {
            transientError = new Error(bgRes.error || `HTTP ${bgRes.status}`);
          }
        } catch (err) {
          if (err?.name === 'AbortError' && signal?.aborted) throw err;
          transientError = err;
        }
      }

      if (transientError) {
        throw transientError;
      }
      return null;
    };

    if (typeof PD.async?.retryWithBackoff === 'function' && retries > 0) {
      try {
        return await PD.async.retryWithBackoff(attemptOnce, {
          retries,
          baseDelayMs: 250,
          maxDelayMs: 2000,
          signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
        return null;
      }
    }

    try {
      return await attemptOnce();
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      return null;
    }
  }

  /**
   * Fetches unique asset URLs in parallel using bounded worker pool + optional background fallback,
   * automatic retry with backoff, per-asset fallback URLs, AbortSignal, and lazy dataUrl encoding.
   * @param {string[]} urls
   * @param {{ concurrency?: number, retries?: number, signal?: AbortSignal, fallbackMap?: Map<string, string>|Record<string, string>, onProgress?: (done: number, total: number) => void, backgroundFetcher?: (url: string) => Promise<{ ok: boolean, status?: number, contentType?: string, base64?: string, error?: string }>, fetchImpl?: typeof fetch }} [options]
   * @returns {Promise<Map<string, { bytes: Uint8Array, mime: string, ext: string, dataUrl: string }>>}
   */
  async function fetchAssetsParallel(urls, options = {}) {
    const {
      concurrency = 6,
      retries = 2,
      signal,
      fallbackMap,
      onProgress,
      backgroundFetcher,
      fetchImpl = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null,
    } = options;

    if (signal?.aborted) {
      throw PD.async?.createAbortError ? PD.async.createAbortError() : new Error('Aborted');
    }

    const uniqueUrls = Array.from(new Set(
      (urls || []).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
    ));
    const assetMap = new Map();
    if (uniqueUrls.length === 0) return assetMap;

    const mapPool = PD.async?.mapPool;
    if (!mapPool) {
      throw new Error('PD.async.mapPool is required for fetchAssetsParallel');
    }

    const getFallbackUrl = (primaryUrl) => {
      if (!fallbackMap) return '';
      if (fallbackMap instanceof Map) return fallbackMap.get(primaryUrl) || '';
      return fallbackMap[primaryUrl] || '';
    };

    await mapPool(
      uniqueUrls,
      concurrency,
      async (url) => {
        let fetched = await fetchSingleUrlBytes(url, {
          fetchImpl,
          backgroundFetcher,
          signal,
          retries,
        });

        let resolvedFromUrl = url;
        if (!fetched) {
          const fallbackUrl = getFallbackUrl(url);
          if (fallbackUrl && fallbackUrl !== url && /^https?:\/\//i.test(fallbackUrl)) {
            fetched = await fetchSingleUrlBytes(fallbackUrl, {
              fetchImpl,
              backgroundFetcher,
              signal,
              retries: Math.min(1, retries),
            });
            if (fetched) {
              resolvedFromUrl = fallbackUrl;
            }
          }
        }

        if (!fetched || !fetched.bytes || fetched.bytes.byteLength === 0) {
          console.warn('[PerlegoExporter] Skipping unreachable asset:', url);
          return;
        }

        const { mime, ext } = detectImageMimeAndExt(fetched.bytes, fetched.contentType, resolvedFromUrl);
        assetMap.set(url, createLazyAssetEntry(fetched.bytes, mime, ext));
      },
      onProgress,
      signal
    );

    return assetMap;
  }

  function cleanAuthorCandidate(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (/^iD\b|\b0000-\d{4}-\d{4}-[\dX]{4}\b/i.test(text)) return '';
    return text.replace(/[.;,\s]+$/, '').trim();
  }

  function extractPublicationYear(text, body = null) {
    const years = [];
    const maxYear = new Date().getFullYear() + 1;
    const pushValid = (rawYear) => {
      const n = parseInt(rawYear, 10);
      if (n >= 1900 && n <= maxYear) years.push(n);
    };

    // 1. Dedicated Springer/Palgrave copyright lines often place the year at the end of a long license string
    if (body?.querySelectorAll) {
      for (const el of Array.from(body.querySelectorAll('.CopyrightLine, [class*="CopyrightLine"]'))) {
        const lineText = (el.textContent || '').replace(/\s+/g, ' ');
        for (const m of lineText.matchAll(/\b((?:19|20)\d{2})\b/g)) {
          pushValid(m[1]);
        }
      }
    }

    // Strip UK statutory references like "Copyright, Designs and Patents Act 1988" before pattern matching
    const clean = String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/Copyright,\s*Designs and Patents Act\s+\d{4}/gi, '')
      .replace(/\bAct\s+(?:19|20)\d{2}\b/gi, '');

    const publishedRe =
      /\b(?:(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|revised|updated|new|\d+(?:st|nd|rd|th))\s+)?(?:edition\s+)?published(?:\s+in)?(?:\s+by\s+[A-Za-z0-9 &.,'-]{1,60}?)?\s+((?:19|20)\d{2})\b/gi;
    for (const m of clean.matchAll(publishedRe)) {
      pushValid(m[1]);
    }

    const copyrightRe =
      /(?:©|copyright(?:\s*\(c\))?)(?:(?![;\n]|\b(?:all rights|isbn|doi|act)\b).){0,200}?\b((?:19|20)\d{2})\b/gi;
    for (const m of clean.matchAll(copyrightRe)) {
      pushValid(m[1]);
    }

    if (years.length === 0) return '';
    return String(Math.max(...years));
  }

  function extractStructuredAuthors(body) {
    if (!body?.querySelectorAll) return '';
    const namedNodes = Array.from(
      body.querySelectorAll('.BookAuthors .AuthorName, .BookAuthorGroup .AuthorName, .CopyrightPageOriginators .AuthorName')
    );
    if (namedNodes.length > 0) {
      const seen = new Set();
      const names = [];
      for (const node of namedNodes) {
        const cand = cleanAuthorCandidate(node.textContent);
        if (cand && !seen.has(cand.toLowerCase())) {
          seen.add(cand.toLowerCase());
          names.push(cand);
        }
      }
      if (names.length > 0) return names.join(', ');
    }

    const authorNodes = Array.from(
      body.querySelectorAll('.author, .author1, .author2, [class*="author"], [data-test-locator*="Author"], [data-test-locator*="author"]')
    );
    for (const node of authorNodes) {
      // Skip composite nodes that wrap affiliations
      if (node.querySelector?.('.Affiliation, .AffiliationText')) continue;
      const cand = cleanAuthorCandidate(node.textContent);
      if (cand) return cand;
    }
    return '';
  }

  function extractHeadingWithoutSubtitle(el) {
    let main = '';
    let sub = '';
    const walk = (node) => {
      if (node.nodeType === 3) {
        main += node.nodeValue || '';
        return;
      }
      if (node.nodeType !== 1) return;
      const cls = (node.getAttribute?.('class') || '').toLowerCase().split(/\s+/);
      if (cls.includes('subtitle') || cls.includes('sub-title') || cls.includes('booksubtitle')) {
        sub += (sub ? ' ' : '') + (node.textContent || '').trim();
        return;
      }
      for (const ch of Array.from(node.childNodes || [])) {
        walk(ch);
      }
    };
    walk(el);
    return {
      mainTitle: main.replace(/\s+/g, ' ').trim(),
      nestedSub: sub.replace(/\s+/g, ' ').trim(),
    };
  }

  function extractNormalizedText(node) {
    if (!node) return '';
    const parts = [];
    const walk = (n) => {
      if (n.nodeType === 3) {
        parts.push(n.nodeValue || '');
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = (n.localName || n.tagName || '').toLowerCase();
      const isBlock = /^(div|p|section|article|address|header|footer|li|h[1-6]|tr|td|th|br)$/.test(tag);
      if (isBlock) parts.push(' ');
      for (const ch of Array.from(n.childNodes || [])) {
        walk(ch);
      }
      if (isBlock) parts.push(' ');
    };
    walk(node);
    return parts.join('').replace(/\s+/g, ' ').trim();
  }

  function extractIsbn(text) {
    const clean = String(text || '').replace(/\s+/g, ' ');
    const isbn13Matches = clean.matchAll(/\bISBN(?:-13)?[:\s]*((?:97[89][-\s]?)(?:\d[-\s]?){9}\d)\b/gi);
    for (const m of isbn13Matches) {
      const digits = m[1].replace(/[^0-9]/g, '');
      if (digits.length === 13) return digits;
    }
    const isbn10Matches = clean.matchAll(/\bISBN(?:-10)?[:\s]*((?:\d[-\s]?){9}[\dX])\b/gi);
    for (const m of isbn10Matches) {
      const digits = m[1].replace(/[^0-9X]/gi, '').toUpperCase();
      if (digits.length === 10) return digits;
    }
    return '';
  }

  function extractPublisher(text, body = null) {
    if (body?.querySelector) {
      const pubEl = body.querySelector('.PublisherName, .ImprintName, .publisher, [class*="PublisherName"]');
      const pubText = (pubEl?.textContent || '').replace(/\s+/g, ' ').trim();
      if (pubText && pubText.length >= 2 && pubText.length <= 90) {
        return pubText.replace(/[.,;:\s]+$/, '');
      }
    }
    const clean = String(text || '').replace(/\s+/g, ' ');
    const patterns = [
      /\bunder\s+exclusive\s+license\s+to\s+([A-Z][A-Za-z0-9 &.,'-]{2,70}?)(?=\s+(?:19|20)\d{2}\b|[.,;]|$)/i,
      /\bpublished\s+(?:(?:in\s+)?(?:19|20)\d{2}\s+)?by\s+([A-Z][A-Za-z0-9 &.,'-]{2,70}?)(?=\s*(?:\.|,|;|\b(?:19|20)\d{2}\b|\ban\s+imprint\b|\ba\s+division\b|\bAll\s+rights\b|$))/i,
      /\bprinted\s+and\s+published\s+by\s+([A-Z][A-Za-z0-9 &.,'-]{2,70}?)(?=[.,;]|$)/i,
    ];
    for (const re of patterns) {
      const m = clean.match(re);
      if (m && m[1]) {
        const cand = m[1].replace(/[.,;:\s]+$/, '').trim();
        if (cand.length >= 2 && cand.length <= 80 && !/^(?:the\s+author|permission)/i.test(cand)) {
          return cand;
        }
      }
    }
    return '';
  }

  const RTL_LANG_RE = /^(?:fa|ar|he|iw|ur|ps|sd|yi|dv)(?:[-_]|$)/i;

  function detectBookLanguageAndDir(meta = {}, items = [], domParser = null) {
    const rawMetaLang = String(meta.language || '').trim();
    if (rawMetaLang) {
      const normalized = rawMetaLang.split(/[_-]/)[0].toLowerCase();
      return {
        language: rawMetaLang,
        dir: RTL_LANG_RE.test(normalized) ? 'rtl' : 'ltr',
      };
    }

    const parser = domParser || (typeof DOMParser !== 'undefined' ? new DOMParser() : null);
    let sampleText = '';
    const sampleItems = Array.isArray(items) ? items.slice(0, Math.min(items.length, 6)) : [];
    for (const item of sampleItems) {
      const html = String(item?.html || '');
      const langMatch = html.match(/\b(?:xml:)?lang\s*=\s*["']([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?)["']/i);
      if (langMatch && langMatch[1]) {
        const lang = langMatch[1].trim();
        return {
          language: lang,
          dir: RTL_LANG_RE.test(lang) ? 'rtl' : 'ltr',
        };
      }
      if (parser && sampleText.length < 1500) {
        const doc = parser.parseFromString(html, 'text/html');
        sampleText += ' ' + extractNormalizedText(doc?.body);
      } else if (sampleText.length < 1500) {
        sampleText += ' ' + html.replace(/<[^>]+>/g, ' ');
      }
    }

    const persianChars = (sampleText.match(/[\u067E\u0686\u0698\u06AF\u06A9\u06CC]/g) || []).length;
    const arabicChars = (sampleText.match(/[\u0600-\u06FF]/g) || []).length;
    const hebrewChars = (sampleText.match(/[\u0590-\u05FF]/g) || []).length;
    const latinChars = (sampleText.match(/[A-Za-z]/g) || []).length;

    if (arabicChars > 40 && arabicChars > latinChars * 0.5) {
      const lang = persianChars >= 3 ? 'fa' : 'ar';
      return { language: lang, dir: 'rtl' };
    }
    if (hebrewChars > 40 && hebrewChars > latinChars * 0.5) {
      return { language: 'he', dir: 'rtl' };
    }
    return { language: 'en', dir: 'ltr' };
  }

  /**
   * Enriches book metadata (title, subtitle, author, year, publisher, isbn, language, dir, coverUrl)
   * from captured front-matter HTML.
   * @param {object} meta
   * @param {Array<object>} items
   * @param {DOMParser} [domParser]
   */
  function enrichBookMetadata(meta = {}, items = [], domParser) {
    const parser = domParser || (typeof DOMParser !== 'undefined' ? new DOMParser() : null);
    const { language: detectedLang, dir: detectedDir } = detectBookLanguageAndDir(meta, items, parser);
    if (!parser || !Array.isArray(items) || items.length === 0) {
      return { ...meta, language: meta.language || detectedLang, dir: meta.dir || detectedDir };
    }

    let title = String(meta.title || '').trim();
    let subtitle = String(meta.subtitle || '').trim();
    let author = String(meta.author || '').trim();
    let year = String(meta.year || '').trim();
    let publisher = String(meta.publisher || '').trim();
    let isbn = String(meta.isbn || '').trim();
    let coverUrl = String(meta.coverUrl || '').trim();

    let coverTitle = '';
    let coverAuthor = '';
    let coverPublisher = '';
    let copyrightAuthor = '';
    const foundYears = [];

    const frontMatter = items.slice(0, Math.min(items.length, 8));
    for (let i = 0; i < frontMatter.length; i++) {
      const item = frontMatter[i];
      const itemTitle = String(item?.title || '');
      const doc = parser.parseFromString(String(item?.html || ''), 'text/html');
      const body = doc?.body;
      if (!body) continue;

      const bodyText = extractNormalizedText(body);
      const isCoverSec =
        i === 0 ||
        /^cover/i.test(itemTitle) ||
        Boolean(body.querySelector('[id*="cover"], [id*="Cover"], [class*="cover"], img[alt^="Cover"], img[alt^="cover"]'));

      if (!coverUrl && isCoverSec) {
        const coverImg =
          body.querySelector('img[alt^="Cover"], img[alt^="cover"]') ||
          body.querySelector('[id*="cover"] img, [id*="Cover"] img, [class*="cover"] img, [class*="Cover"] img') ||
          (/^cover/i.test(itemTitle) ? body.querySelector('img') : null);
        if (coverImg) {
          coverUrl = (coverImg.getAttribute('src') || '').trim();
          const alt = (coverImg.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
          const writtenMatch = alt.match(/\b(?:written|edited)\s+by\s+(.+?)(?:,\s*published\b|$)/i);
          if (writtenMatch) {
            coverAuthor = cleanAuthorCandidate(writtenMatch[1]);
          }
          const titleMatch = alt.match(/^Cover:\s*(.+?),\s*(?:written|edited)\s+by\b/i);
          if (titleMatch) {
            coverTitle = titleMatch[1].trim();
          }
          const pubAltMatch = alt.match(/\bpublished\s+by\s+([^.]+?)(?:\.|$)/i);
          if (pubAltMatch) {
            coverPublisher = pubAltMatch[1].trim();
          }
        }
      }

      const isTitlePage =
        (/title/i.test(itemTitle) && !/half/i.test(itemTitle)) ||
        Boolean(
          body.querySelector(
            'section[id*="titlepage"], section[class*="titlepage"], section.tp, .BookTitlePage, .MainTitleSection, .BookFrontmatter'
          )
        ) ||
        Boolean(body.querySelector('.BookAuthors .AuthorName, .BookTitle'));

      if (isTitlePage) {
        const h1 = body.querySelector('h1, .title, .title0, .BookTitle');
        if (h1) {
          const { mainTitle: mainHeading, nestedSub } = extractHeadingWithoutSubtitle(h1);
          if (nestedSub && !subtitle) subtitle = nestedSub;
          if (!subtitle) {
            const siblingSub = body.querySelector('.subtitle, .sub-title, .BookSubTitle');
            if (siblingSub) subtitle = (siblingSub.textContent || '').replace(/\s+/g, ' ').trim();
          }
          if (mainHeading && !/^contents$/i.test(mainHeading)) {
            const isGenericTitle = !title || /^Perlego\s+(book|path)-/i.test(title);
            const hasGluedSubtitle =
              subtitle &&
              title.replace(/\s+/g, '').toLowerCase() ===
                `${mainHeading}${subtitle}`.replace(/\s+/g, '').toLowerCase();
            if (isGenericTitle || hasGluedSubtitle) {
              title = mainHeading;
            }
          }
        }

        const structuredAuthor = extractStructuredAuthors(body);
        const currentAuthorLooksDirty =
          Boolean(author) && /(?:University|School of|Department|USA|Italy|UK|, MI|, CA)\b/i.test(author);
        if (structuredAuthor && (!author || currentAuthorLooksDirty)) {
          author = structuredAuthor;
        }
      }

      const isCopyrightPage =
        /copyright|legal|front\s*matter|untitled/i.test(itemTitle) ||
        Boolean(
          body.querySelector(
            '[id*="copyright"], [class*="copyright"], [class*="Copyright"], [class*="legal"], .BookFrontmatter'
          )
        ) ||
        /©|\bfirst published\b|\bedition published\b|\bpublished\s+(?:19|20)\d{2}\b|\bISBN\b/i.test(bodyText);

      if (isCopyrightPage) {
        const found = extractPublicationYear(bodyText, body);
        if (found) foundYears.push(parseInt(found, 10));
        if (!isbn) {
          isbn = extractIsbn(bodyText);
        }
        if (!publisher) {
          publisher = extractPublisher(bodyText, body);
        }
        if (!author || /(?:University|School of|Department|USA)\b/i.test(author)) {
          const origAuthor = extractStructuredAuthors(body);
          if (origAuthor) {
            author = origAuthor;
          }
        }
        if (!copyrightAuthor) {
          const copyMatch = bodyText.match(/(?:©|copyright(?:\s*\(c\))?)\s*(?:19|20)\d{2}\s+(?:by\s+)?([^.]+?)(?:\s+The right of\b|\s+All rights reserved\b|$)/i);
          if (copyMatch) {
            const cleanedCopy = cleanAuthorCandidate(copyMatch[1]);
            if (cleanedCopy && !/^(?:Taylor\s*&\s*Francis|Routledge|Springer|The Editor)/i.test(cleanedCopy)) {
              copyrightAuthor = cleanedCopy;
            }
          }
        }
      }
    }

    if (!year && foundYears.length > 0) {
      year = String(Math.max(...foundYears));
    }
    if (!author) author = copyrightAuthor || coverAuthor;
    if (!publisher) publisher = coverPublisher;
    if ((!title || /^Perlego\s+(book|path)-/i.test(title)) && coverTitle) {
      title = coverTitle;
    }

    return {
      ...meta,
      title: title || meta.title || 'Perlego Book',
      subtitle,
      author,
      year,
      publisher,
      isbn,
      language: meta.language || detectedLang,
      dir: meta.dir || detectedDir,
      coverUrl,
    };
  }

  /**
   * Converts a non-JPEG raster cover asset (such as WebP) to JPEG for universal EPUB reader support.
   * Gracefully returns the original asset when running in environments without Canvas APIs.
   */
  async function ensureJpegCoverAsset(asset) {
    if (!asset || !asset.bytes || asset.mime === 'image/jpeg' || asset.mime === 'image/svg+xml') {
      return asset;
    }
    if (typeof Blob === 'undefined' || typeof createImageBitmap !== 'function') {
      return asset;
    }

    let bitmap = null;
    try {
      const srcBlob = new Blob([asset.bytes], { type: asset.mime || 'image/webp' });
      bitmap = await createImageBitmap(srcBlob);
      const width = Math.max(1, bitmap.width || 1);
      const height = Math.max(1, bitmap.height || 1);

      let jpegBlob = null;
      if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(bitmap, 0, 0, width, height);
          jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
        }
      } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(bitmap, 0, 0, width, height);
          jpegBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
        }
      }

      if (!jpegBlob || jpegBlob.size === 0) return asset;
      const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
      return createLazyAssetEntry(jpegBytes, 'image/jpeg', 'jpg');
    } catch {
      return asset;
    } finally {
      try {
        bitmap?.close?.();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  const ROMAN_VALUES = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

  function parseRomanNumeral(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!/^(?=[ivxlcdm])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/.test(s)) {
      return null;
    }
    let total = 0;
    for (let i = 0; i < s.length; i++) {
      const val = ROMAN_VALUES[s[i]];
      const next = ROMAN_VALUES[s[i + 1]] || 0;
      total += val < next ? -val : val;
    }
    return total > 0 ? total : null;
  }

  function extractIdSuffix(rawId) {
    const m = String(rawId || '').match(/^.+?--\d+_(.+)$/);
    return m ? m[1] : '';
  }

  function normalizeLinkKey(raw) {
    let s = String(raw || '')
      .replace(/[\u200b\u00ad\ufeff]/g, '')
      .replace(/(\d)([A-Za-zÀ-ÖØ-öø-ÿ])/g, '$1 $2')
      .replace(/([A-Za-zÀ-ÖØ-öø-ÿ])(\d)/g, '$1 $2');
    if (typeof s.normalize === 'function') {
      s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
    return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function stripLeadingSectionNumber(norm) {
    return String(norm || '')
      .replace(/^(?:(?:chapter|ch|part|section|appendix|figure|fig|table|tab|box|x)\s+)?(?:[0-9]+|[ivxlcdm]+)(?:\s+[0-9]+)*\s+/i, '')
      .trim();
  }

  function buildSuffixCandidates(rawSuf, preferCallout = false) {
    const clean = String(rawSuf || '').replace(/^_+/, '').trim();
    if (!clean) return [];
    const seen = new Set();
    const out = [];
    const push = (val) => {
      const v = String(val || '').trim();
      if (v && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    };

    const strippedX = clean.replace(/^x[mn]/, '').replace(/^x/, '');
    if (preferCallout) {
      push(strippedX);
      push(strippedX.replace(/^_+/, ''));
      if (!strippedX.startsWith('R_')) push(`R_${strippedX}`);
      if (!strippedX.endsWith('b')) push(`${strippedX}b`);
      push(clean);
      if (!clean.startsWith('R_')) push(`R_${clean}`);
      if (!clean.endsWith('b')) push(`${clean}b`);
      push(`b1${clean}`);
    } else {
      push(clean);
      if (clean.startsWith('R_')) {
        const noR = clean.slice(2).replace(/^_+/, '');
        push(noR);
        const lastSeg = noR.match(/((?:ref|en|fn|fig|tab|tbl|note|bib|sec)[A-Za-z0-9_.-]+)$/i);
        if (lastSeg) push(lastSeg[1]);
      }
      if (clean.endsWith('b') && clean.length > 1) {
        push(clean.slice(0, -1));
      }
      const noBookPrefix = clean.match(/^b\d+(.+)$/);
      if (noBookPrefix) push(noBookPrefix[1]);
      push(`R_${clean}`);
      push(`${clean}b`);
      push(strippedX);
      push(rawSuf);
    }
    return out;
  }

  function isElementRelated(elA, elB) {
    if (!elA || !elB) return false;
    if (elA === elB) return true;
    for (let cur = elA.parentNode; cur && cur.nodeType === 1; cur = cur.parentNode) {
      if (cur === elB) return true;
    }
    for (let cur = elB.parentNode; cur && cur.nodeType === 1; cur = cur.parentNode) {
      if (cur === elA) return true;
    }
    return false;
  }

  function getAncestorWithId(el) {
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentNode) {
      const id = cur.getAttribute?.('id');
      if (id) return cur;
    }
    return null;
  }

  function getContextFlags(el, chapterTitle) {
    const lowerTitle = String(chapterTitle || '').toLowerCase();
    let inNav = false;
    let inToc = /^(?:table of )?contents\b/.test(lowerTitle);
    let inLof = /list of figures|illustrations/.test(lowerTitle);
    let inLot = /list of tables/.test(lowerTitle);
    let inIndex = /^index\b/.test(lowerTitle);
    let inRefs = /^(?:references|bibliography|reference list|notes)\b/.test(lowerTitle);

    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentNode) {
      const tag = (cur.localName || cur.tagName || '').toLowerCase();
      const cls = (cur.getAttribute?.('class') || '').toLowerCase();
      const id = (cur.getAttribute?.('id') || '').toLowerCase();
      if (tag === 'nav') inNav = true;
      if (/(?:^|\b|_)(?:toc|contents?)(?:\b|_|\d)/.test(cls) || /(?:^|_)toc(?:--|$)/.test(id)) {
        inToc = true;
      }
      if (/tocfigure|loi|lof/.test(cls)) inLof = true;
      if (/toctable|lot/.test(cls)) inLot = true;
      if (/\bindex\b/.test(cls) || /^index--/.test(id)) inIndex = true;
      if (/reference|biblio/.test(cls) || /_rf\d+|bib/.test(id)) inRefs = true;
    }
    return { inNav, inToc: inToc || inNav, inLof, inLot, inIndex, inRefs };
  }

  function parsePrevSiblingText(aEl) {
    const parent = aEl.parentNode;
    if (!parent?.childNodes) return '';
    const siblings = Array.from(parent.childNodes);
    const idx = siblings.indexOf(aEl);
    if (idx <= 0) return '';
    let buf = '';
    for (let i = idx - 1; i >= 0 && buf.length < 100; i--) {
      const node = siblings[i];
      if (node.nodeType === 3) {
        buf = (node.nodeValue || '') + buf;
      } else if (node.nodeType === 1) {
        const tag = (node.localName || node.tagName || '').toLowerCase();
        if (tag === 'a') break;
        buf = extractNormalizedText(node) + ' ' + buf;
      }
    }
    return buf.trim();
  }

  function extractPrecedingTextInParent(aEl) {
    const parent = aEl.parentNode;
    if (!parent?.childNodes) return '';
    const siblings = Array.from(parent.childNodes);
    const idx = siblings.indexOf(aEl);
    if (idx <= 0) return '';
    let buf = '';
    for (let i = Math.max(0, idx - 6); i < idx; i++) {
      const n = siblings[i];
      buf += n.nodeType === 3 ? (n.nodeValue || '') : extractNormalizedText(n) + ' ';
    }
    return buf.slice(-90);
  }

  function normalizeSurnameToken(raw) {
    let surname = String(raw || '').trim();
    if (typeof surname.normalize === 'function') {
      surname = surname.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
    surname = surname.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!surname || /^(?:chapter|section|figure|table|part|edition|volume|vol|page|copyright|first|second|third|see|the|and|for|from|with|al|et)$/.test(surname)) {
      return '';
    }
    return surname;
  }

  function extractAuthorYearCandidates(text) {
    const cleaned = String(text || '').replace(/[\u200b\u00ad\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return [];
    const seen = new Set();
    const out = [];
    const push = (rawSur, rawYear) => {
      const surname = normalizeSurnameToken(rawSur);
      const year = String(rawYear || '').toLowerCase();
      if (!surname || !year) return;
      const key = `${surname}:${year}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ surname, year });
      }
    };

    const leadMatch = cleaned.match(/^([A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,40})[^0-9]{0,90}?\b((?:19|20)\d{2}[a-z]?)\b/);
    if (leadMatch) push(leadMatch[1], leadMatch[2]);

    const directBeforeYear = cleaned.matchAll(/([A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,40})(?:\s+et\s+al\.?)?[,.\s(]+((?:19|20)\d{2}[a-z]?)\)?/gi);
    for (const m of directBeforeYear) {
      push(m[1], m[2]);
    }
    return out;
  }

  function extractAuthorSurnameAndYear(text) {
    return extractAuthorYearCandidates(text)[0] || null;
  }

  /**
   * Two-pass cross-chapter & in-chapter link resolver for Perlego DOM exports.
   * Indexes exact IDs, Perlego `--N_origId` suffixes, print page anchors (`_p82`),
   * figures/tables, numbered sections, chapter/part headings, and bibliography entries,
   * then repairs `#fragment` and click-only (`scrollWithinBook` / suffix / TOC / Index) links.
   *
   * @param {Array<{ index?: number, title?: string, doc: Document }>} chapters
   * @param {{ targetHrefFor?: (linkChIdx: number, targetChIdx: number, targetId: string) => string }} [options]
   */
  function resolveBookLinks(chapters = [], options = {}) {
    if (!Array.isArray(chapters) || chapters.length === 0) return { resolvedCount: 0, totalLinks: 0 };

    const targetHrefFor =
      typeof options.targetHrefFor === 'function'
        ? options.targetHrefFor
        : (linkChIdx, targetChIdx, targetId) => {
            if (linkChIdx === targetChIdx && targetId) return `#${targetId}`;
            const file = `ch-${String(targetChIdx + 1).padStart(4, '0')}.xhtml`;
            return targetId ? `${file}#${targetId}` : file;
          };

    const chExactMaps = chapters.map(() => new Map());
    const chSuffixMaps = chapters.map(() => new Map());
    const chHrefFragMaps = chapters.map(() => new Map());
    const globalExactMap = new Map();
    const globalSuffixMap = new Map();
    const hrefFragMap = new Map();
    const pageMap = new Map();
    const figTableMap = new Map();
    const sectionCodeMap = new Map();
    const chapterNumMap = new Map();
    const partNumMap = new Map();
    const headingMap = new Map(); // norm -> Array<{ chIdx, id, isHeading }>
    const headingPrefixMap = new Map(); // 5-word prefix -> Array<{ chIdx, id, isHeading }>
    const bibMap = new Map(); // `${surname}:${year}` -> Array<{ chIdx, id }>

    const addToBucket = (map, key, val) => {
      if (!key) return;
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      list.push(val);
    };

    const registerHeading = (normText, chIdx, id, isHeading) => {
      if (!normText || !id) return;
      addToBucket(headingMap, normText, { chIdx, id, isHeading });
      const noNum = stripLeadingSectionNumber(normText);
      if (noNum && noNum !== normText && noNum.length > 3) {
        addToBucket(headingMap, noNum, { chIdx, id, isHeading });
      }
      const words = normText.split(' ').filter(Boolean);
      if (words.length >= 4) {
        addToBucket(headingPrefixMap, words.slice(0, 6).join(' '), { chIdx, id, isHeading });
      }
      if (noNum) {
        const noNumWords = noNum.split(' ').filter(Boolean);
        if (noNumWords.length >= 4) {
          addToBucket(headingPrefixMap, noNumWords.slice(0, 6).join(' '), { chIdx, id, isHeading });
        }
      }
    };

    const getChapterRoot = (doc) =>
      doc?.body || doc?.getElementsByTagName?.('body')?.[0] || doc?.documentElement;

    // Pass 1: Index all element IDs, suffixes, print page anchors, figures/tables, headings, chapters, and bibliography items
    for (let chIdx = 0; chIdx < chapters.length; chIdx++) {
      const ch = chapters[chIdx];
      const doc = ch?.doc;
      const root = getChapterRoot(doc);
      if (!root) continue;

      const chTitle = String(ch.title || doc.getElementsByTagName?.('title')?.[0]?.textContent || '').trim();
      const chCtx = getContextFlags(root, chTitle);
      const isFrontNavChapter = chCtx.inToc || chCtx.inLof || chCtx.inLot || chCtx.inIndex;
      const chHeadingId = (() => {
        for (const tag of ['h1', 'h2', 'section', 'div']) {
          const el = doc.getElementsByTagName?.(tag)?.[0];
          const eid = el?.getAttribute?.('id');
          if (eid) return eid;
        }
        return '';
      })();

      if (chTitle) {
        const normCt = normalizeLinkKey(chTitle);
        if (normCt) {
          addToBucket(headingMap, normCt, { chIdx, id: chHeadingId, isHeading: true });
          if (normCt === 'contents') {
            addToBucket(headingMap, 'table of contents', { chIdx, id: chHeadingId, isHeading: true });
          } else if (normCt === 'table of contents') {
            addToBucket(headingMap, 'contents', { chIdx, id: chHeadingId, isHeading: true });
          }
          if (!isFrontNavChapter) {
            const noNumCt = stripLeadingSectionNumber(normCt);
            if (noNumCt && noNumCt !== normCt && noNumCt.length > 3) {
              addToBucket(headingMap, noNumCt, { chIdx, id: chHeadingId, isHeading: true });
            }
          }
        }
        const chNumMatch =
          chTitle.match(/^(?:chapter|ch\.?)\s+(\d+|[A-Z])\b/i) ||
          (!isFrontNavChapter ? chTitle.match(/^(\d{1,2})\s+[A-Z]/) : null);
        if (chNumMatch && !chapterNumMap.has(chNumMatch[1].toLowerCase())) {
          chapterNumMap.set(chNumMatch[1].toLowerCase(), { chIdx, id: chHeadingId });
        }
        const partMatch = chTitle.match(/^part\s+([ivxlcdm]+|\d+)\b/i);
        if (partMatch && !isFrontNavChapter) {
          const rawPart = partMatch[1].toLowerCase();
          if (!partNumMap.has(rawPart)) partNumMap.set(rawPart, { chIdx, id: chHeadingId });
          const romanVal = parseRomanNumeral(rawPart);
          if (romanVal && !partNumMap.has(String(romanVal))) {
            partNumMap.set(String(romanVal), { chIdx, id: chHeadingId });
          }
        }
      }

      const elements = Array.from(root.getElementsByTagName?.('*') || []);
      for (const el of elements) {
        const tag = (el.localName || el.tagName || '').toLowerCase();
        const rawId = el.getAttribute?.('id') || '';
        const origIdAttr = el.getAttribute?.('data-originalid') || '';

        if (rawId) {
          const entry = { chIdx, id: rawId, el };
          if (!chExactMaps[chIdx].has(rawId)) chExactMaps[chIdx].set(rawId, entry);
          if (!globalExactMap.has(rawId)) globalExactMap.set(rawId, entry);

          if (tag === 'a') {
            const aHref = (el.getAttribute?.('href') || '').trim();
            if (aHref.startsWith('#')) {
              const fragKey = aHref.slice(1).trim();
              if (fragKey) {
                addToBucket(chHrefFragMaps[chIdx], fragKey, entry);
                addToBucket(hrefFragMap, fragKey, entry);
              }
            }
          }

          const sufList = [];
          const suf = extractIdSuffix(rawId);
          if (suf) {
            sufList.push(suf);
            const stripped = suf.replace(/^_+/, '');
            if (stripped && stripped !== suf) sufList.push(stripped);
          }
          if (origIdAttr) {
            for (const tok of origIdAttr.trim().split(/\s+/)) {
              if (tok) {
                sufList.push(tok);
                const stripped = tok.replace(/^_+/, '');
                if (stripped && stripped !== tok) sufList.push(stripped);
              }
            }
          }

          for (const s of sufList) {
            addToBucket(chSuffixMaps[chIdx], s, { chIdx, id: rawId, el, suf: s });
            addToBucket(globalSuffixMap, s, { chIdx, id: rawId, el, suf: s });

            // Print page anchor detection (e.g., _p82, _page_82, _Page_vii, _pg12, _px)
            const pm = s.match(/^(?:p|page_|pg|xp|page)([0-9]+|[ivxlcdmIVXLCDM]+)$/i);
            if (pm) {
              const rawPage = pm[1].toLowerCase();
              const normPage = /^\d+$/.test(rawPage) ? String(parseInt(rawPage, 10)) : rawPage;
              if (!pageMap.has(normPage)) {
                pageMap.set(normPage, { chIdx, id: rawId });
              }
            }

            // Section code ID suffix (e.g., _sec1_3_1)
            const sm = s.match(/^sec(?:tion)?[-._]?(\d+(?:[._-]\d+)+)$/i);
            if (sm && tag !== 'a') {
              const code = sm[1].replace(/[_-]+/g, '.');
              if (!sectionCodeMap.has(code)) sectionCodeMap.set(code, { chIdx, id: rawId });
            }

            // Figure / Table / Box ID suffix (e.g., _fig1_1, _c13-fig-0001, _tab2_1, _boxed-text-002)
            const fm = s.match(/^(?:[a-z]+\d*[-_])?(fig(?:ure)?|tab(?:le)?|tbl|box(?:ed-text)?)[-._]?0*(\d+(?:[._-]0*\d+)*)$/i);
            if (fm && tag !== 'a') {
              const kindRaw = fm[1].toLowerCase();
              const kind = kindRaw.startsWith('t') ? 'tab' : kindRaw.startsWith('b') ? 'box' : 'fig';
              const num = fm[2].replace(/[_-]+/g, '.').replace(/\.0+(\d)/g, '.$1');
              const key = `${kind}:${num}`;
              if (!figTableMap.has(key)) figTableMap.set(key, { chIdx, id: rawId });
            }
          }
        }

        // Index visible headings, captions, figure/table labels, and bibliography items (outside TOC/Index lists)
        const elCtx = isFrontNavChapter ? chCtx : getContextFlags(el, chTitle);
        if (elCtx.inToc || elCtx.inLof || elCtx.inLot || elCtx.inIndex) continue;

        const isHeading = /^h[1-6]$/.test(tag) || tag === 'figcaption' || tag === 'caption';
        const cls = (el.getAttribute?.('class') || '').toLowerCase();
        const looksCaptionOrHeading =
          isHeading || /(?:caption|title|head|label|part|chapter)/.test(cls);

        if (rawId && (isHeading || looksCaptionOrHeading || /^(?:p|div|li|span)$/.test(tag))) {
          const text = extractNormalizedText(el);
          if (text && text.length >= 2 && text.length <= 260) {
            if (isHeading || tag !== 'a') {
              registerHeading(normalizeLinkKey(text), chIdx, rawId, isHeading);
            }

            // Capture explicit Figure / Table / Box captions even without figure-specific ID suffix
            const figTextMatch = text.match(/^(Figures?|Figs?\.?|Tables?|Tabs?\.?|Box)\s+(\d+(?:\.\d+)*)\b/i);
            if (figTextMatch) {
              const kind = figTextMatch[1].toLowerCase().startsWith('t')
                ? 'tab'
                : figTextMatch[1].toLowerCase().startsWith('b')
                  ? 'box'
                  : 'fig';
              const anchorEl = getAncestorWithId(el);
              if (anchorEl) {
                const key = `${kind}:${figTextMatch[2]}`;
                if (!figTableMap.has(key)) figTableMap.set(key, { chIdx, id: anchorEl.getAttribute('id') });
              }
            }

            // Capture numbered section headings (e.g., 1.1 Aim and Objectives)
            const secTextMatch = text.match(/^(\d+(?:\.\d+)+)\s+[A-Za-z]/);
            if (secTextMatch && (isHeading || /head|title/.test(cls))) {
              if (!sectionCodeMap.has(secTextMatch[1])) {
                sectionCodeMap.set(secTextMatch[1], { chIdx, id: rawId });
              }
            }

            // Capture Part headings inside non-TOC chapters
            const partTextMatch = text.match(/^Part\s+([IVXLCDM]+|\d+)\b/i);
            if (partTextMatch && (isHeading || /(?:^|\b)(?:part|head|title)(?:\b|_|-)/i.test(cls))) {
              const rp = partTextMatch[1].toLowerCase();
              if (!partNumMap.has(rp)) partNumMap.set(rp, { chIdx, id: rawId });
              const rv = parseRomanNumeral(rp);
              if (rv && !partNumMap.has(String(rv))) partNumMap.set(String(rv), { chIdx, id: rawId });
            }

            // Capture Bibliography / Reference entries
            if (
              tag === 'li' ||
              elCtx.inRefs ||
              /(?:ref|bib)/.test(cls) ||
              /(?:ref|r\d+|bib)/.test(extractIdSuffix(rawId))
            ) {
              if (tag !== 'a' && !el.querySelector?.('ul, ol')) {
                const refInfo = extractAuthorSurnameAndYear(text);
                if (refInfo) {
                  addToBucket(bibMap, `${refInfo.surname}:${refInfo.year}`, { chIdx, id: rawId });
                }
              }
            }
          }
        }
      }
    }

    if (!headingMap.has('begin reading') && chapterNumMap.has('1')) {
      const ch1 = chapterNumMap.get('1');
      addToBucket(headingMap, 'begin reading', { chIdx: ch1.chIdx, id: ch1.id, isHeading: true });
    }

    const pickBestSuffixHit = (candidates, linkEl, linkChIdx) => {
      for (const cand of candidates) {
        const localHits = chSuffixMaps[linkChIdx]?.get(cand);
        if (localHits) {
          for (const hit of localHits) {
            if (!isElementRelated(hit.el, linkEl)) return hit;
          }
        }
      }
      for (const cand of candidates) {
        const globalHits = globalSuffixMap.get(cand);
        if (globalHits) {
          for (const hit of globalHits) {
            if (!isElementRelated(hit.el, linkEl)) return hit;
          }
        }
      }
      return null;
    };

    const pickHeadingHit = (normKey, preferredChIdx, excludeChIdx) => {
      if (!normKey) return null;
      const fromBuckets = (map, key) => {
        const hits = map.get(key);
        if (!hits || hits.length === 0) return null;
        const valid = hits.filter((h) => h.chIdx !== excludeChIdx);
        const pool = valid.length > 0 ? valid : hits;
        if (preferredChIdx !== null && preferredChIdx !== undefined) {
          const samePreferredHeading = pool.find((h) => h.chIdx === preferredChIdx && h.isHeading);
          if (samePreferredHeading) return samePreferredHeading;
          const samePreferred = pool.find((h) => h.chIdx === preferredChIdx);
          if (samePreferred) return samePreferred;
        }
        return pool.find((h) => h.isHeading) || pool[0];
      };

      let hit = fromBuckets(headingMap, normKey);
      if (hit) return hit;

      const noNum = stripLeadingSectionNumber(normKey);
      if (noNum && noNum.length > 3 && noNum !== normKey) {
        hit = fromBuckets(headingMap, noNum);
        if (hit) return hit;
      }

      const words = normKey.split(' ').filter(Boolean);
      if (words.length >= 4) {
        hit = fromBuckets(headingPrefixMap, words.slice(0, 6).join(' '));
        if (hit) return hit;
      }
      if (noNum) {
        const noNumWords = noNum.split(' ').filter(Boolean);
        if (noNumWords.length >= 4) {
          hit = fromBuckets(headingPrefixMap, noNumWords.slice(0, 6).join(' '));
          if (hit) return hit;
        }
      }
      return null;
    };

    // Pass 2: Resolve all <a> elements across all chapters and strip helper attributes
    let resolvedCount = 0;
    let totalLinks = 0;

    for (let chIdx = 0; chIdx < chapters.length; chIdx++) {
      const ch = chapters[chIdx];
      const doc = ch?.doc;
      const root = getChapterRoot(doc);
      if (!root) continue;

      const chTitle = String(ch.title || doc.getElementsByTagName?.('title')?.[0]?.textContent || '').trim();
      const chCtx = getContextFlags(root, chTitle);
      let tocChapterHint = null;
      let prevParent = null;
      let prevKind = '';

      const anchors = Array.from(root.getElementsByTagName?.('a') || []);
      for (const aEl of anchors) {
        const rawHref = (aEl.getAttribute?.('href') || '').trim();
        const scrollTarget = (aEl.getAttribute?.('data-pd-scroll-target') || '').trim();
        const scrollChapterStr = (aEl.getAttribute?.('data-pd-scroll-chapter') || '').trim();
        const scrollChapterIdx = /^\d+$/.test(scrollChapterStr) ? parseInt(scrollChapterStr, 10) : null;

        if (rawHref && !rawHref.startsWith('#') && !/^javascript:/i.test(rawHref)) {
          totalLinks += 1;
          continue;
        }

        const innerText = extractNormalizedText(aEl).replace(/[\u200b\u00ad\ufeff]/g, '').trim();
        if (aEl.parentNode !== prevParent) {
          prevParent = aEl.parentNode;
          prevKind = '';
        } else {
          const between = parsePrevSiblingText(aEl);
          if (!/^(?:,|;|and|or|&|–|-|—|\/|to|\s)*$/i.test(between)) {
            prevKind = '';
          }
        }

        let targetHit = null;
        let resolvedKind = '';

        if (rawHref.startsWith('#')) {
          totalLinks += 1;
          let frag = rawHref.slice(1).trim();
          try {
            frag = decodeURIComponent(frag);
          } catch {
            // Keep raw fragment if percent-decoding fails
          }
          if (frag) {
            const localExact = chExactMaps[chIdx].get(frag);
            if (localExact && !isElementRelated(localExact.el, aEl)) {
              targetHit = localExact;
            } else {
              const sufCands = buildSuffixCandidates(frag, false);
              targetHit = pickBestSuffixHit(sufCands, aEl, chIdx);
              if (!targetHit) {
                const globalExact = globalExactMap.get(frag);
                if (globalExact && !isElementRelated(globalExact.el, aEl)) {
                  targetHit = globalExact;
                }
              }
              if (!targetHit) {
                const pairedKeys = [];
                if (/^R_/i.test(frag)) {
                  pairedKeys.push(frag.slice(2));
                } else if (/^r(?=(?:fn|en|note|c\d|fig|tab|tbl|box|sec|ref))/i.test(frag)) {
                  pairedKeys.push(frag.slice(1), frag.replace(/^r_?/i, ''));
                } else {
                  pairedKeys.push(`r${frag}`, `r_${frag}`, `R_${frag}`);
                }
                for (const pk of pairedKeys) {
                  if (!pk) continue;
                  const pool = chHrefFragMaps[chIdx].get(pk) || hrefFragMap.get(pk);
                  if (pool) {
                    const hit = pool.find((h) => !isElementRelated(h.el, aEl));
                    if (hit) {
                      targetHit = hit;
                      break;
                    }
                  }
                }
              }
            }
          }
        } else {
          // Click-only / unlinked <a>
          const aCtx = getContextFlags(aEl, chTitle);
          const ownId = aEl.getAttribute?.('id') || '';
          const ownSuf = extractIdSuffix(ownId);
          const origAttr = aEl.getAttribute?.('data-originalid') || '';
          const childSufs = [];
          for (const child of Array.from(aEl.getElementsByTagName?.('*') || [])) {
            const cSuf = extractIdSuffix(child.getAttribute?.('id') || '');
            if (cSuf) childSufs.push(cSuf);
          }

          const isReturnLink =
            /\breturn\s+to\s+text\b|[⏎↩↑]/i.test(innerText) ||
            /^x/.test(ownSuf) ||
            childSufs.some((s) => /^x/.test(s));

          // 1. Direct ID hints (`scrollTarget`, `data-originalid`, own suffix, child suffix, or enclosing entry for Return links)
          const rawHints = [];
          if (scrollTarget) rawHints.push(scrollTarget);
          if (origAttr) rawHints.push(...origAttr.trim().split(/\s+/));
          if (ownSuf) rawHints.push(ownSuf);
          rawHints.push(...childSufs);

          for (const hint of rawHints) {
            if (targetHit) break;
            const cands = buildSuffixCandidates(hint, isReturnLink);
            const exact = chExactMaps[chIdx].get(hint) || globalExactMap.get(hint);
            if (exact && !isElementRelated(exact.el, aEl)) {
              targetHit = exact;
              break;
            }
            targetHit = pickBestSuffixHit(cands, aEl, chIdx);
          }

          if (!targetHit && (isReturnLink || aCtx.inRefs || chCtx.inRefs)) {
            for (let cur = aEl.parentNode; cur && cur.nodeType === 1; cur = cur.parentNode) {
              const tag = (cur.localName || cur.tagName || '').toLowerCase();
              const ancSuf = extractIdSuffix(cur.getAttribute?.('id') || '');
              if (ancSuf) {
                targetHit = pickBestSuffixHit(buildSuffixCandidates(ancSuf, true), cur, chIdx);
                if (targetHit) break;
              }
              if (tag === 'li' || tag === 'aside' || tag === 'p') break;
            }
          }

          // 2. Continuation bare numbers (e.g., "Chapters 1 and <a>2</a>" or "Figures 2.1 and <a>2.2</a>")
          if (!targetHit && prevKind && /^\d+(?:\.\d+)*$/.test(innerText)) {
            if (prevKind === 'chapter' && chapterNumMap.has(innerText)) {
              targetHit = chapterNumMap.get(innerText);
              resolvedKind = 'chapter';
            } else if ((prevKind === 'fig' || prevKind === 'tab' || prevKind === 'box') && figTableMap.has(`${prevKind}:${innerText}`)) {
              targetHit = figTableMap.get(`${prevKind}:${innerText}`);
              resolvedKind = prevKind;
            }
          }

          // 3. Explicit Figure / Table / Box references or List of Figures / Tables entries
          if (!targetHit) {
            const ftMatch = innerText.match(/^(Figures?|Figs?\.?|Tables?|Tabs?\.?|Box(?:ed text)?)\s+(\d+(?:\.\d+)*)\b/i);
            if (ftMatch) {
              const kind = ftMatch[1].toLowerCase().startsWith('t')
                ? 'tab'
                : ftMatch[1].toLowerCase().startsWith('b')
                  ? 'box'
                  : 'fig';
              targetHit = figTableMap.get(`${kind}:${ftMatch[2]}`) || null;
              if (targetHit) resolvedKind = kind;
            } else if ((aCtx.inLof || aCtx.inLot) && /^(\d+(?:\.\d+)+)\b/.test(innerText)) {
              const num = innerText.match(/^(\d+(?:\.\d+)+)\b/)[1];
              const kind = aCtx.inLot ? 'tab' : 'fig';
              targetHit = figTableMap.get(`${kind}:${num}`) || figTableMap.get(`${aCtx.inLot ? 'fig' : 'tab'}:${num}`) || null;
              if (targetHit) resolvedKind = kind;
            }
          }

          // 4. Explicit Chapter / Part / Section references
          if (!targetHit) {
            const chMatch = innerText.match(/^(?:Chapters?|Chs?\.?)\s+(\d+|[A-Z])\b/i);
            if (chMatch) {
              targetHit = chapterNumMap.get(chMatch[1].toLowerCase()) || null;
              if (targetHit) resolvedKind = 'chapter';
            }
          }
          if (!targetHit) {
            const partMatch = innerText.match(/^Part\s+([IVXLCDM]+|\d+)\b/i);
            if (partMatch) {
              targetHit = partNumMap.get(partMatch[1].toLowerCase()) || null;
              if (!targetHit) {
                const rv = parseRomanNumeral(partMatch[1]);
                if (rv) targetHit = partNumMap.get(String(rv)) || null;
              }
            }
          }
          if (!targetHit) {
            const secMatch = innerText.match(/^(?:Section\s+)?(\d+(?:\.\d+)+)\b/i);
            if (secMatch && sectionCodeMap.has(secMatch[1])) {
              const codeHit = sectionCodeMap.get(secMatch[1]);
              if (scrollChapterIdx === null || codeHit.chIdx === scrollChapterIdx || aCtx.inToc || !/^\d+\.\d+$/.test(innerText)) {
                targetHit = codeHit;
              }
            }
          }

          // 5. Print page-number links (`82`, `255–8`, `295n48`, `viii.`) -> exact page break anchor
          if (!targetHit && innerText) {
            const pageMatch = innerText.match(
              /^(?:Index\s+)?([0-9]+|[ivxlcdm]+)\.?$/i
            ) || (
              (aCtx.inIndex || aCtx.inToc || scrollChapterIdx !== null)
                ? innerText.match(/^([0-9]+|[ivxlcdm]+)(?:\s*[-–—]\s*[0-9ivxlcdm]+|\s*[nNfFtT]\.?[0-9]*|[a-z])?$/i)
                : null
            );
            if (pageMatch) {
              const token = pageMatch[1].toLowerCase();
              const isValidPageToken = /^\d+$/.test(token)
                ? !(aCtx.inToc === false && aCtx.inIndex === false && /^\d{4}$/.test(token) && parseInt(token, 10) >= 1800)
                : Boolean(parseRomanNumeral(token));
              if (isValidPageToken) {
                const normPage = /^\d+$/.test(token) ? String(parseInt(token, 10)) : token;
                const pHit = pageMap.get(normPage);
                if (pHit) {
                  targetHit = pHit;
                }
              }
            }
          }

          // 6. Heading / Chapter title matching
          if (!targetHit && innerText) {
            const normIn = normalizeLinkKey(innerText);
            if (normIn && normIn.length >= 3) {
              const excludeSelfToc = aCtx.inToc || aCtx.inLof || aCtx.inLot ? chIdx : -1;
              const preferredCh = scrollChapterIdx !== null && scrollChapterIdx >= 0 && scrollChapterIdx < chapters.length
                ? scrollChapterIdx
                : tocChapterHint;
              targetHit = pickHeadingHit(normIn, preferredCh, excludeSelfToc);
            }
          }

          // 7. Numbered chapter entry in TOC (`1  Defining Digital Advertising...`)
          if (!targetHit && aCtx.inToc) {
            const numChap = innerText.match(/^(?:x\s+)?(\d{1,2})\s+\S/);
            if (numChap && chapterNumMap.has(numChap[1])) {
              targetHit = chapterNumMap.get(numChap[1]);
              resolvedKind = 'chapter';
            }
          }

          // 8. Author-year citations in prose (`Schumann & Thorson, 1999`, `William Lazer (1962)`, `Hunt 1976a`, `1991`)
          if (!targetHit && innerText && !chCtx.inRefs) {
            const refCandidates = extractAuthorYearCandidates(innerText);
            if (refCandidates.length === 0 && /^\(?(?:19|20)\d{2}[a-z]?\)?$/.test(innerText)) {
              const yearOnly = innerText.replace(/[^0-9a-z]/gi, '').toLowerCase();
              const prevText = extractPrecedingTextInParent(aEl);
              const surMatches = Array.from(prevText.matchAll(/\b([A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]{1,30})\b/g));
              for (let sIdx = surMatches.length - 1; sIdx >= 0; sIdx--) {
                const candidateSur = normalizeSurnameToken(surMatches[sIdx][1]);
                if (!candidateSur) continue;
                const bHits = bibMap.get(`${candidateSur}:${yearOnly}`);
                if (bHits && bHits.length > 0) {
                  targetHit = bHits.find((h) => h.chIdx === chIdx) || bHits[0];
                  break;
                }
              }
            } else {
              for (const refInfo of refCandidates) {
                const bHits = bibMap.get(`${refInfo.surname}:${refInfo.year}`);
                if (bHits && bHits.length > 0) {
                  targetHit = bHits.find((h) => h.chIdx === chIdx) || bHits[0];
                  break;
                }
              }
            }
          }

          // 9. Fallback to `data-pd-scroll-chapter` if present and valid
          if (!targetHit && scrollChapterIdx !== null && scrollChapterIdx >= 0 && scrollChapterIdx < chapters.length) {
            targetHit = { chIdx: scrollChapterIdx, id: '' };
          }
        }

        if (targetHit && targetHit.chIdx >= 0 && targetHit.chIdx < chapters.length) {
          const newHref = targetHrefFor(chIdx, targetHit.chIdx, targetHit.id || '');
          if (newHref) {
            aEl.setAttribute('href', newHref);
            resolvedCount += 1;
          }
          if (chCtx.inToc || getContextFlags(aEl, chTitle).inToc) {
            tocChapterHint = targetHit.chIdx;
          }
          prevKind = resolvedKind || prevKind;
        } else {
          prevKind = resolvedKind || '';
        }
      }

      // Clean up temporary internal routing attributes so exported XHTML/HTML stays valid and clean
      for (const el of Array.from(root.getElementsByTagName?.('*') || [])) {
        el.removeAttribute?.('data-originalid');
        el.removeAttribute?.('data-pd-scroll-target');
        el.removeAttribute?.('data-pd-scroll-chapter');
      }
    }

    return { resolvedCount, totalLinks };
  }

  PD.domCleaner = {
    sanitizeFilename,
    formatBookFilename,
    extractBookContext,
    extractIsbn,
    extractPublisher,
    detectBookLanguageAndDir,
    enrichBookMetadata,
    isBlankPlaceholderUrl,
    parseSrcsetBestUrl,
    pickImageUrlsFromPicture,
    pickBestImageUrlFromPicture,
    cleanChapterHtml,
    detectImageMimeAndExt,
    ensureJpegCoverAsset,
    bytesToBase64,
    base64ToUint8Array,
    bytesToDataUrl,
    createLazyAssetEntry,
    fetchAssetsParallel,
    resolveBookLinks,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PD.domCleaner;
  }
})();
