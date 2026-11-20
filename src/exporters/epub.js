/**
 * @file EPUB 3.0 archive builder.
 * Generates strict XHTML chapters with MathML/SVG support, nested TOC (`nav.xhtml` & `toc.ncx`),
 * EPUB 3 landmarks, Dublin Core metadata, RTL spine progression, and OCF ZIP packaging.
 */
(() => {
  'use strict';

  const PD = (globalThis.PerlegoDownloader = globalThis.PerlegoDownloader || {});

  const XHTML_NS = 'http://www.w3.org/1999/xhtml';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

  const DROP_TAGS = new Set([
    'script',
    'style',
    'noscript',
    'iframe',
    'frame',
    'frameset',
    'form',
    'input',
    'textarea',
    'select',
    'option',
    'button',
    'canvas',
    'video',
    'audio',
    'source',
    'track',
  ]);

  const ALLOWED_XHTML_TAGS = new Set([
    'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote',
    'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'dd', 'del',
    'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'i', 'img',
    'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 'rp',
    'rt', 'ruby', 's', 'samp', 'section', 'small', 'span', 'strong', 'sub',
    'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time',
    'tr', 'u', 'ul', 'var', 'wbr',
  ]);

  const ALLOWED_HTML_ATTRS = new Set([
    'id', 'class', 'dir', 'lang', 'title', 'href', 'src', 'alt',
    'colspan', 'rowspan', 'scope', 'start', 'type', 'headers', 'datetime', 'cite',
  ]);

  const LINK_HINT_ATTRS = new Set([
    'data-originalid',
    'data-pd-scroll-target',
    'data-pd-scroll-chapter',
  ]);

  const EPUB_CORE_IMAGE_MIMES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
  ]);

  function stripInvalidXmlChars(str) {
    return String(str ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  }

  function escapeXml(str) {
    return stripInvalidXmlChars(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pad4(n) {
    return String(n).padStart(4, '0');
  }

  function formatEpubModifiedTimestamp(date = new Date()) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  function sanitizeXmlId(rawId, usedIds) {
    let candidate = String(rawId || '').trim().replace(/[^A-Za-z0-9._:-]/g, '_');
    if (!candidate || !/^[A-Za-z_]/.test(candidate)) {
      candidate = `id_${candidate || 'item'}`;
    }
    let unique = candidate;
    let counter = 2;
    while (usedIds.has(unique)) {
      unique = `${candidate}_${counter++}`;
    }
    usedIds.add(unique);
    return unique;
  }

  function decodeDataImageUrl(dataUrl) {
    const match = String(dataUrl || '').match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) return null;
    const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
    if (!EPUB_CORE_IMAGE_MIMES.has(mime)) return null;
    const extMap = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
    };
    const base64 = match[2].replace(/\s+/g, '');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { bytes, mime, ext: extMap[mime] || 'png', dataUrl };
  }

  function cloneSvgIntoXml(sourceEl, xmlDoc, usedIds, state) {
    state.hasSvg = true;
    const localName = (sourceEl.localName || sourceEl.tagName || 'svg').toLowerCase();
    const out = xmlDoc.createElementNS(SVG_NS, localName);

    for (const attr of Array.from(sourceEl.attributes || [])) {
      const name = attr.name;
      if (/^on/i.test(name) || name === 'xmlns' || name.startsWith('xmlns:')) continue;
      if (!/^[A-Za-z_:][A-Za-z0-9._:-]*$/.test(name)) continue;
      if (name === 'id') {
        out.setAttribute('id', sanitizeXmlId(attr.value, usedIds));
      } else {
        out.setAttribute(name, stripInvalidXmlChars(attr.value));
      }
    }

    for (const child of Array.from(sourceEl.childNodes || [])) {
      if (child.nodeType === 3) {
        out.appendChild(xmlDoc.createTextNode(stripInvalidXmlChars(child.nodeValue)));
      } else if (child.nodeType === 1) {
        const cTag = (child.tagName || '').toLowerCase();
        if (!DROP_TAGS.has(cTag)) {
          out.appendChild(cloneSvgIntoXml(child, xmlDoc, usedIds, state));
        }
      }
    }
    return out;
  }

  function cloneMathMlIntoXml(sourceEl, xmlDoc, usedIds, state) {
    state.hasMathml = true;
    const localName = (sourceEl.localName || sourceEl.tagName || 'math').toLowerCase();
    const out = xmlDoc.createElementNS(MATHML_NS, localName);

    for (const attr of Array.from(sourceEl.attributes || [])) {
      const name = attr.name;
      if (/^on/i.test(name) || name === 'xmlns' || name.startsWith('xmlns:')) continue;
      if (!/^[A-Za-z_:][A-Za-z0-9._:-]*$/.test(name)) continue;
      if (name === 'id') {
        out.setAttribute('id', sanitizeXmlId(attr.value, usedIds));
      } else {
        out.setAttribute(name, stripInvalidXmlChars(attr.value));
      }
    }

    for (const child of Array.from(sourceEl.childNodes || [])) {
      if (child.nodeType === 3) {
        out.appendChild(xmlDoc.createTextNode(stripInvalidXmlChars(child.nodeValue)));
      } else if (child.nodeType === 1) {
        const cTag = (child.tagName || '').toLowerCase();
        if (!DROP_TAGS.has(cTag)) {
          out.appendChild(cloneMathMlIntoXml(child, xmlDoc, usedIds, state));
        }
      }
    }
    return out;
  }

  function cloneNodeIntoXhtml(sourceNode, xmlDoc, ctx) {
    if (!sourceNode) return null;
    if (sourceNode.nodeType === 3) {
      const text = stripInvalidXmlChars(sourceNode.nodeValue);
      return text ? xmlDoc.createTextNode(text) : null;
    }
    if (sourceNode.nodeType !== 1) return null;

    const tag = (sourceNode.tagName || '').toLowerCase();
    if (DROP_TAGS.has(tag)) return null;

    if (tag === 'svg') {
      return cloneSvgIntoXml(sourceNode, xmlDoc, ctx.usedIds, ctx.state);
    }

    if (tag === 'math') {
      return cloneMathMlIntoXml(sourceNode, xmlDoc, ctx.usedIds, ctx.state);
    }

    if (tag === 'object') {
      const assetKey = sourceNode.getAttribute('data-asset-url') || sourceNode.getAttribute('data') || '';
      const localAsset = ctx.assetHrefMap.get(assetKey);
      if (localAsset) {
        const img = xmlDoc.createElementNS(XHTML_NS, 'img');
        img.setAttribute('src', `../${localAsset.href}`);
        img.setAttribute('alt', `Page ${ctx.index + 1}`);
        img.setAttribute('class', 'pd-page-image');
        return img;
      }
      // Fall back to cloning children inside a span/div
      const fallbackFrag = xmlDoc.createDocumentFragment();
      for (const child of Array.from(sourceNode.childNodes || [])) {
        const cloned = cloneNodeIntoXhtml(child, xmlDoc, ctx);
        if (cloned) fallbackFrag.appendChild(cloned);
      }
      return fallbackFrag;
    }

    if (tag === 'img') {
      let src = (sourceNode.getAttribute('src') || '').trim();
      const fallbackSrc = (sourceNode.getAttribute('data-fallback-src') || '').trim();
      if (!src && !fallbackSrc) return null;

      if (src.startsWith('data:image/') && !ctx.assetHrefMap.has(src)) {
        const decoded = decodeDataImageUrl(src);
        if (decoded && typeof ctx.registerAsset === 'function') {
          ctx.registerAsset(src, decoded);
        }
      }

      const localAsset = ctx.assetHrefMap.get(src) || (fallbackSrc ? ctx.assetHrefMap.get(fallbackSrc) : null);
      if (localAsset) {
        src = `../${localAsset.href}`;
        if (localAsset.isCover) {
          ctx.state.hasCoverImage = true;
        }
      } else if (/^https?:\/\//i.test(src)) {
        ctx.state.hasRemoteResources = true;
      } else if (/^https?:\/\//i.test(fallbackSrc)) {
        src = fallbackSrc;
        ctx.state.hasRemoteResources = true;
      } else {
        return null;
      }

      const img = xmlDoc.createElementNS(XHTML_NS, 'img');
      img.setAttribute('src', src);
      img.setAttribute('alt', stripInvalidXmlChars(sourceNode.getAttribute('alt') || ''));
      const title = sourceNode.getAttribute('title');
      if (title) img.setAttribute('title', stripInvalidXmlChars(title));
      return img;
    }

    if (!ALLOWED_XHTML_TAGS.has(tag)) {
      // Unwrap unknown custom tags cleanly while preserving child text/nodes
      const frag = xmlDoc.createDocumentFragment();
      for (const child of Array.from(sourceNode.childNodes || [])) {
        const cloned = cloneNodeIntoXhtml(child, xmlDoc, ctx);
        if (cloned) frag.appendChild(cloned);
      }
      return frag;
    }

    const outEl = xmlDoc.createElementNS(XHTML_NS, tag);
    for (const attr of Array.from(sourceNode.attributes || [])) {
      const name = attr.name.toLowerCase();
      if (ctx.preserveLinkHints && LINK_HINT_ATTRS.has(name)) {
        outEl.setAttribute(name, stripInvalidXmlChars(attr.value));
        continue;
      }
      if (ctx.preserveLinkHints && name === 'onclick') {
        const scrollMatch = attr.value.match(
          /scrollWithinBook\(\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]\s*\)/i
        );
        if (scrollMatch) {
          if (scrollMatch[1].trim() && !outEl.getAttribute('data-pd-scroll-target')) {
            outEl.setAttribute('data-pd-scroll-target', stripInvalidXmlChars(scrollMatch[1].trim()));
          }
          if (scrollMatch[2].trim() && !outEl.getAttribute('data-pd-scroll-chapter')) {
            outEl.setAttribute('data-pd-scroll-chapter', stripInvalidXmlChars(scrollMatch[2].trim()));
          }
        }
        continue;
      }
      if (!ALLOWED_HTML_ATTRS.has(name)) continue;
      if (name === 'href' && /^javascript:/i.test(attr.value.trim())) continue;
      if (name === 'id') {
        const rawParts = attr.value.trim().split(/\s+/);
        outEl.setAttribute('id', sanitizeXmlId(rawParts[0], ctx.usedIds));
        if (ctx.preserveLinkHints && rawParts.length > 1 && !outEl.getAttribute('data-originalid')) {
          outEl.setAttribute('data-originalid', stripInvalidXmlChars(rawParts.slice(1).join(' ')));
        }
      } else if (name === 'lang') {
        outEl.setAttribute('lang', stripInvalidXmlChars(attr.value));
      } else {
        outEl.setAttribute(name, stripInvalidXmlChars(attr.value));
      }
    }

    for (const child of Array.from(sourceNode.childNodes || [])) {
      const cloned = cloneNodeIntoXhtml(child, xmlDoc, ctx);
      if (cloned) outEl.appendChild(cloned);
    }

    return outEl;
  }

  function serializeXhtmlDoc(xmlDoc, serializer) {
    let serialized = serializer.serializeToString(xmlDoc);
    if (!serialized.startsWith('<?xml')) {
      serialized = `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
    }
    return serialized.replace(/^(<\?xml[^?]*\?>\s*)/, '$1<!DOCTYPE html>\n');
  }

  /**
   * Converts raw chapter HTML into a guaranteed well-formed EPUB 3 XHTML document.
   */
  function htmlToXhtmlChapter({
    html,
    title,
    index,
    language = 'en',
    dir = 'ltr',
    assetHrefMap,
    registerAsset,
    domParser,
    xmlSerializer,
    deferSerialization = false,
    preserveLinkHints = false,
  }) {
    const parser = domParser || (typeof DOMParser !== 'undefined' ? new DOMParser() : null);
    const serializer = xmlSerializer || (typeof XMLSerializer !== 'undefined' ? new XMLSerializer() : null);
    if (!parser || (!deferSerialization && !serializer)) {
      throw new Error('DOMParser and XMLSerializer are required for EPUB generation');
    }

    const safeLang = escapeXml(language || 'en');
    const dirAttr = dir === 'rtl' ? ' dir="rtl"' : '';
    const htmlDoc = parser.parseFromString(String(html || ''), 'text/html');
    const xmlDoc = parser.parseFromString(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        `<html xmlns="${XHTML_NS}" xml:lang="${safeLang}" lang="${safeLang}"${dirAttr}>` +
        '<head><meta charset="utf-8" /><title></title>' +
        '<link rel="stylesheet" type="text/css" href="../styles/book.css" /></head>' +
        '<body></body></html>',
      'application/xml'
    );

    const titleEl = xmlDoc.getElementsByTagName('title')[0];
    if (titleEl) {
      titleEl.appendChild(xmlDoc.createTextNode(stripInvalidXmlChars(title || `Chapter ${index + 1}`)));
    }

    const bodyEl = xmlDoc.getElementsByTagName('body')[0];
    const section = xmlDoc.createElementNS(XHTML_NS, 'section');
    section.setAttribute('class', 'chapter');

    const state = { hasSvg: false, hasMathml: false, hasRemoteResources: false, hasCoverImage: false };
    const ctx = {
      index,
      assetHrefMap,
      registerAsset,
      usedIds: new Set(),
      state,
      preserveLinkHints,
    };

    for (const child of Array.from(htmlDoc.body.childNodes || [])) {
      const cloned = cloneNodeIntoXhtml(child, xmlDoc, ctx);
      if (cloned) section.appendChild(cloned);
    }

    if (!section.firstChild) {
      const emptyP = xmlDoc.createElementNS(XHTML_NS, 'p');
      section.appendChild(emptyP);
    }
    bodyEl.appendChild(section);

    if (deferSerialization) {
      return {
        doc: xmlDoc,
        xhtml: '',
        hasSvg: state.hasSvg,
        hasMathml: state.hasMathml,
        hasRemoteResources: state.hasRemoteResources,
        hasCoverImage: state.hasCoverImage,
      };
    }

    return {
      xhtml: serializeXhtmlDoc(xmlDoc, serializer),
      hasSvg: state.hasSvg,
      hasMathml: state.hasMathml,
      hasRemoteResources: state.hasRemoteResources,
      hasCoverImage: state.hasCoverImage,
    };
  }

  function resolveEpubInternalLinks(chapters) {
    if (!PD.domCleaner?.resolveBookLinks || !Array.isArray(chapters) || chapters.length === 0) {
      return { resolvedCount: 0, totalLinks: 0 };
    }
    return PD.domCleaner.resolveBookLinks(chapters, {
      targetHrefFor: (linkChIdx, targetChIdx, targetId) => {
        if (linkChIdx === targetChIdx && targetId) {
          return `#${targetId}`;
        }
        const targetCh = chapters[targetChIdx];
        const relFile = targetCh?.id ? `${targetCh.id}.xhtml` : `ch-${pad4(targetChIdx + 1)}.xhtml`;
        return targetId ? `${relFile}#${targetId}` : relFile;
      },
    });
  }

  const EPUB_CSS = `
    body {
      font-family: Georgia, serif;
      line-height: 1.65;
      margin: 1.2em;
    }
    h1, h2, h3, h4 {
      font-family: system-ui, -apple-system, sans-serif;
      line-height: 1.25;
      margin-top: 1.4em;
      margin-bottom: 0.5em;
    }
    img, svg {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 1em auto;
      page-break-inside: avoid;
    }
    pre, code {
      font-family: monospace;
      font-size: 0.88em;
    }
    pre {
      white-space: pre-wrap;
      padding: 0.8em;
      border: 1px solid #d0d7de;
      border-radius: 4px;
      page-break-inside: avoid;
    }
    blockquote {
      margin: 1em 0;
      padding-left: 1em;
      border-left: 3px solid #888;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1em 0;
    }
    th, td {
      border: 1px solid #ccc;
      padding: 0.4em 0.6em;
      text-align: left;
    }
  `;

  function buildContainerXml() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  }

  function buildTocTree(chapters) {
    const roots = [];
    const stack = [];
    let maxDepth = 1;

    for (const ch of chapters) {
      const level = Math.max(0, Math.min(4, Number.isFinite(ch.level) ? ch.level : 0));
      const node = { ch, level, children: [] };

      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      if (stack.length === 0) {
        roots.push(node);
      } else {
        stack[stack.length - 1].children.push(node);
      }
      stack.push(node);
      if (stack.length > maxDepth) {
        maxDepth = stack.length;
      }
    }

    return { roots, maxDepth };
  }

  function renderNavNodes(nodes, indent) {
    return nodes
      .map((node) => {
        const link = `<a href="${escapeXml(node.ch.href)}">${escapeXml(node.ch.title)}</a>`;
        if (node.children.length === 0) {
          return `${indent}<li>${link}</li>`;
        }
        const inner = renderNavNodes(node.children, `${indent}    `);
        return `${indent}<li>${link}\n${indent}  <ol>\n${inner}\n${indent}  </ol>\n${indent}</li>`;
      })
      .join('\n');
  }

  function findFirstContentChapter(chapters, coverChapterHref) {
    for (const ch of chapters) {
      if (coverChapterHref && ch.href === coverChapterHref) continue;
      const t = String(ch.title || '').toLowerCase();
      if (/^(?:cover|half\s*title|title\s*page|copyright|dedication|table of contents|contents|list of )/.test(t)) {
        continue;
      }
      return ch;
    }
    return chapters[0] || null;
  }

  function buildNavXhtml(title, chapters, { language = 'en', dir = 'ltr', coverChapterHref = '' } = {}) {
    const { roots } = buildTocTree(chapters);
    const itemsXml = renderNavNodes(roots, '      ');
    const safeLang = escapeXml(language || 'en');
    const dirAttr = dir === 'rtl' ? ' dir="rtl"' : '';

    const landmarks = [];
    if (coverChapterHref) {
      landmarks.push(`      <li><a epub:type="cover" href="${escapeXml(coverChapterHref)}">Cover</a></li>`);
    }
    landmarks.push('      <li><a epub:type="toc" href="nav.xhtml">Table of Contents</a></li>');
    const startCh = findFirstContentChapter(chapters, coverChapterHref);
    if (startCh) {
      landmarks.push(`      <li><a epub:type="bodymatter" href="${escapeXml(startCh.href)}">Start of Content</a></li>`);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="${XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${safeLang}" lang="${safeLang}"${dirAttr}>
<head>
  <meta charset="utf-8" />
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="styles/book.css" />
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
${itemsXml}
    </ol>
  </nav>
  <nav epub:type="landmarks" id="landmarks" hidden="">
    <h2>Landmarks</h2>
    <ol>
${landmarks.join('\n')}
    </ol>
  </nav>
</body>
</html>`;
  }

  function buildTocNcx(bookUuid, title, chapters) {
    const { roots, maxDepth } = buildTocTree(chapters);
    let playOrder = 0;

    function renderNcxNodes(nodes, indent) {
      return nodes
        .map((node) => {
          playOrder += 1;
          const curOrder = playOrder;
          const childrenXml = node.children.length > 0
            ? `\n${renderNcxNodes(node.children, `${indent}  `)}`
            : '';
          return `${indent}<navPoint id="navPoint-${curOrder}" playOrder="${curOrder}">
${indent}  <navLabel><text>${escapeXml(node.ch.title)}</text></navLabel>
${indent}  <content src="${escapeXml(node.ch.href)}"/>${childrenXml}
${indent}</navPoint>`;
        })
        .join('\n');
    }

    const navPoints = renderNcxNodes(roots, '    ');

    return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${escapeXml(bookUuid)}"/>
    <meta name="dtb:depth" content="${maxDepth}"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`;
  }

  function formatDisplayTitle(meta = {}) {
    const rawTitle = String(meta.title || 'Perlego Book').trim();
    const yearStr = String(meta.year || '').trim();
    if (!yearStr) return rawTitle;
    const escapedYear = yearStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\(${escapedYear}\\)$`).test(rawTitle)
      ? rawTitle
      : `${rawTitle} (${yearStr})`;
  }

  function detectCoverUrlFromFirstItem(firstItem, parser) {
    if (!firstItem || !parser) return '';
    const rawTitle = String(firstItem.title || '');
    const rawHtml = String(firstItem.html || '');
    const looksLikeCover =
      /^cover\b/i.test(rawTitle) ||
      /\bcover\b/i.test(rawTitle) ||
      /id=["'][^"']*cover/i.test(rawHtml) ||
      /alt=["']Cover:/i.test(rawHtml);
    if (!looksLikeCover) return '';

    const doc = parser.parseFromString(rawHtml, 'text/html');
    const coverImg =
      doc?.body?.querySelector?.('img[alt^="Cover"], img[alt^="cover"]') ||
      doc?.body?.querySelector?.('[id*="cover"] img, [id*="Cover"] img, [class*="cover"] img, [class*="Cover"] img') ||
      doc?.body?.querySelector?.('img');
    return coverImg ? (coverImg.getAttribute('src') || '').trim() : '';
  }

  function buildContentOpf({
    bookUuid,
    meta,
    displayTitle,
    chapters,
    assets,
    coverAsset,
    coverChapterHref = '',
  }) {
    const modified = formatEpubModifiedTimestamp();
    const language = escapeXml(String(meta.language || 'en').trim() || 'en');
    const dir = meta.dir === 'rtl' ? 'rtl' : 'ltr';
    const yearStr = String(meta.year || '').trim();
    const isbnXml = meta.isbn
      ? `\n    <dc:identifier id="isbn-id">urn:isbn:${escapeXml(meta.isbn)}</dc:identifier>`
      : '';
    const authorXml = meta.author
      ? `\n    <dc:creator>${escapeXml(meta.author)}</dc:creator>`
      : '';
    const publisherXml = meta.publisher
      ? `\n    <dc:publisher>${escapeXml(meta.publisher)}</dc:publisher>`
      : '';
    const dateXml = yearStr
      ? `\n    <dc:date>${escapeXml(yearStr)}</dc:date>`
      : '';
    const coverMetaXml = coverAsset
      ? `\n    <meta name="cover" content="${escapeXml(coverAsset.id)}"/>`
      : '';

    const manifestItems = [
      '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
      '    <item id="css" href="styles/book.css" media-type="text/css"/>',
    ];

    for (const ch of chapters) {
      const props = [];
      if (ch.hasSvg) props.push('svg');
      if (ch.hasMathml) props.push('mathml');
      if (ch.hasRemoteResources) props.push('remote-resources');
      const propAttr = props.length ? ` properties="${props.join(' ')}"` : '';
      manifestItems.push(
        `    <item id="${escapeXml(ch.id)}" href="${escapeXml(ch.href)}" media-type="application/xhtml+xml"${propAttr}/>`
      );
    }

    for (const asset of assets) {
      const propAttr = asset.isCover ? ' properties="cover-image"' : '';
      manifestItems.push(
        `    <item id="${escapeXml(asset.id)}" href="${escapeXml(asset.href)}" media-type="${escapeXml(asset.mime)}"${propAttr}/>`
      );
    }

    const spineItems = chapters
      .map((ch) => `    <itemref idref="${escapeXml(ch.id)}"/>`)
      .join('\n');

    const spineDirAttr = dir === 'rtl' ? ' page-progression-direction="rtl"' : '';
    const effectiveCoverHref = coverChapterHref || (chapters[0]?.href || '');
    const guideXml =
      coverAsset && effectiveCoverHref
        ? `\n  <guide>\n    <reference type="cover" title="Cover" href="${escapeXml(effectiveCoverHref)}"/>\n  </guide>`
        : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${language}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:${escapeXml(bookUuid)}</dc:identifier>${isbnXml}
    <dc:title>${escapeXml(displayTitle || meta.title || 'Perlego Book')}</dc:title>${authorXml}${publisherXml}${dateXml}${coverMetaXml}
    <dc:language>${language}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
${manifestItems.join('\n')}
  </manifest>
  <spine toc="ncx"${spineDirAttr}>
${spineItems}
  </spine>${guideXml}
</package>`;
  }

  /**
   * Builds EPUB 3.0 archive entries (exposed separately for Node testing & createZip).
   */
  async function buildEpubEntries({
    meta = {},
    items = [],
    assetMap = new Map(),
    onProgress,
    signal,
    domParser,
    xmlSerializer,
  }) {
    if (!PD.zip) {
      throw new Error('PD.zip is required for EPUB archive generation');
    }
    if (signal?.aborted) {
      throw PD.async?.createAbortError ? PD.async.createAbortError() : new Error('Aborted');
    }

    const parser = domParser || (typeof DOMParser !== 'undefined' ? new DOMParser() : null);
    const yieldCtrl = PD.async?.createYieldController
      ? PD.async.createYieldController(50)
      : null;

    const language = String(meta.language || 'en').trim() || 'en';
    const dir = meta.dir === 'rtl' ? 'rtl' : 'ltr';
    const coverUrl =
      String(meta.coverUrl || '').trim() ||
      detectCoverUrlFromFirstItem(items[0], parser);

    const assetHrefMap = new Map();
    const registeredAssets = [];
    let coverAsset = null;
    let imgCounter = 1;

    function registerAsset(url, asset) {
      if (!asset || !asset.bytes || !EPUB_CORE_IMAGE_MIMES.has(asset.mime)) return null;
      if (assetHrefMap.has(url)) return assetHrefMap.get(url);
      const isCover = Boolean(coverUrl && url === coverUrl && !coverAsset);
      const id = isCover ? 'cover-image' : `img-${pad4(imgCounter)}`;
      const href = isCover ? `images/cover.${asset.ext}` : `images/${id}.${asset.ext}`;
      if (!isCover) {
        imgCounter += 1;
      }
      const entry = {
        id,
        href,
        mime: asset.mime,
        bytes: asset.bytes,
        store: asset.mime !== 'image/svg+xml',
        isCover,
      };
      if (isCover) {
        coverAsset = entry;
      }
      assetHrefMap.set(url, entry);
      registeredAssets.push(entry);
      return entry;
    }

    for (const [url, asset] of assetMap.entries()) {
      registerAsset(url, asset);
    }

    const serializer = xmlSerializer || (typeof XMLSerializer !== 'undefined' ? new XMLSerializer() : null);
    if (!serializer) {
      throw new Error('XMLSerializer is required for EPUB generation');
    }

    const chapters = [];
    let coverChapterHref = '';
    for (let i = 0; i < items.length; i++) {
      if (signal?.aborted) {
        throw PD.async?.createAbortError ? PD.async.createAbortError() : new Error('Aborted');
      }
      const item = items[i];
      const chTitle = item.title || `Section ${i + 1}`;
      const chId = `ch-${pad4(i + 1)}`;
      const chHref = `chapters/${chId}.xhtml`;
      const { doc, hasSvg, hasMathml, hasRemoteResources, hasCoverImage } = htmlToXhtmlChapter({
        html: item.html || '',
        title: chTitle,
        index: i,
        language,
        dir,
        assetHrefMap,
        registerAsset,
        domParser: parser,
        xmlSerializer: serializer,
        deferSerialization: true,
        preserveLinkHints: true,
      });

      if (hasCoverImage && !coverChapterHref) {
        coverChapterHref = chHref;
      }

      chapters.push({
        id: chId,
        href: chHref,
        title: chTitle,
        level: Number.isFinite(item.level) ? item.level : 0,
        doc,
        xhtml: '',
        hasSvg,
        hasMathml,
        hasRemoteResources,
      });

      if (typeof onProgress === 'function') {
        onProgress(i + 1, items.length);
      }
      if (yieldCtrl) {
        await yieldCtrl.maybeYield(signal);
      }
    }

    if (coverAsset && !coverChapterHref && chapters.length > 0) {
      coverChapterHref = chapters[0].href;
    }

    // Two-pass book-wide link resolution across all chapter XHTML documents
    resolveEpubInternalLinks(chapters);

    for (const ch of chapters) {
      if (signal?.aborted) {
        throw PD.async?.createAbortError ? PD.async.createAbortError() : new Error('Aborted');
      }
      ch.xhtml = serializeXhtmlDoc(ch.doc, serializer);
      ch.doc = null;
      if (yieldCtrl) {
        await yieldCtrl.maybeYield(signal);
      }
    }

    const displayTitle = formatDisplayTitle(meta);
    const bookUuid =
      typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `perlego-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const entries = [
      // Mandatory uncompressed first entry for OCF / EPUB 3
      { path: 'mimetype', data: 'application/epub+zip', store: true },
      { path: 'META-INF/container.xml', data: buildContainerXml() },
      { path: 'OEBPS/styles/book.css', data: EPUB_CSS },
      {
        path: 'OEBPS/nav.xhtml',
        data: buildNavXhtml(displayTitle, chapters, { language, dir, coverChapterHref }),
      },
      { path: 'OEBPS/toc.ncx', data: buildTocNcx(bookUuid, displayTitle, chapters) },
      {
        path: 'OEBPS/content.opf',
        data: buildContentOpf({
          bookUuid,
          meta: { ...meta, language, dir },
          displayTitle,
          chapters,
          assets: registeredAssets,
          coverAsset,
          coverChapterHref,
        }),
      },
    ];

    for (const ch of chapters) {
      entries.push({ path: `OEBPS/${ch.href}`, data: ch.xhtml });
    }

    for (const asset of registeredAssets) {
      entries.push({
        path: `OEBPS/${asset.href}`,
        data: asset.bytes,
        store: asset.store,
      });
    }

    return entries;
  }

  /**
   * Builds a spec-compliant EPUB 3.0 Blob.
   * @returns {Promise<Blob>}
   */
  async function buildEpubArchive(options) {
    const entries = await buildEpubEntries(options);
    return PD.zip.createZip(entries, {
      mimeType: 'application/epub+zip',
      signal: options?.signal,
    });
  }

  PD.epubExporter = {
    escapeXml,
    formatEpubModifiedTimestamp,
    htmlToXhtmlChapter,
    resolveEpubInternalLinks,
    buildEpubEntries,
    buildEpubArchive,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PD.epubExporter;
  }
})();
