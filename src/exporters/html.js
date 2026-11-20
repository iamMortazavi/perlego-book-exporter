/**
 * @file Standalone print-ready HTML5 exporter.
 * Produces a self-contained offline reader with optional inline images, hierarchical TOC,
 * RTL support, 3-state color-scheme toggle, font scaling, and print stylesheet.
 */
(() => {
  'use strict';

  const PD = (globalThis.PerlegoDownloader = globalThis.PerlegoDownloader || {});

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function inlineAssetsInBody(doc, body, assetMap) {
    if (!body || !assetMap || assetMap.size === 0) return;
    for (const img of Array.from(body.querySelectorAll('img'))) {
      const src = img.getAttribute('src');
      const fallbackSrc = img.getAttribute('data-fallback-src');
      const asset = (src ? assetMap.get(src) : null) || (fallbackSrc ? assetMap.get(fallbackSrc) : null);
      if (asset?.dataUrl) {
        img.setAttribute('src', asset.dataUrl);
      }
      img.removeAttribute('data-fallback-src');
    }

    for (const obj of Array.from(body.querySelectorAll('object'))) {
      const dataUrl = obj.getAttribute('data-asset-url') || obj.getAttribute('data');
      const asset = dataUrl ? assetMap.get(dataUrl) : null;
      if (asset?.dataUrl && asset.mime.startsWith('image/')) {
        const img = doc.createElement('img');
        img.setAttribute('src', asset.dataUrl);
        img.setAttribute('alt', 'Page image');
        img.setAttribute('class', 'pd-page-image');
        obj.replaceWith(img);
      }
    }
  }

  function inlineHtmlAssets(rawHtml, assetMap, options = {}) {
    if (!assetMap || assetMap.size === 0) return rawHtml;
    const parser = options.domParser || (typeof DOMParser !== 'undefined' ? new DOMParser() : null);
    if (!parser) return rawHtml;

    const doc = parser.parseFromString(String(rawHtml || ''), 'text/html');
    inlineAssetsInBody(doc, doc.body, assetMap);
    return doc.body.innerHTML;
  }

  const HTML_STYLES = `
    :root {
      color-scheme: light dark;
      --bg: #fafafa;
      --surface: #ffffff;
      --text: #1b1f23;
      --muted: #57606a;
      --border: #d0d7de;
      --accent: #0969da;
      --code-bg: #f6f8fa;
      --reader-font-size: 18px;
    }
    :root:has(> head > meta[name="color-scheme"][content="dark"]) {
      color-scheme: dark;
      --bg: #0d1117;
      --surface: #161b22;
      --text: #e6edf3;
      --muted: #8b949e;
      --border: #30363d;
      --accent: #58a6ff;
      --code-bg: #1f242c;
    }
    :root:has(> head > meta[name="color-scheme"][content="light"]) {
      color-scheme: light;
      --bg: #fafafa;
      --surface: #ffffff;
      --text: #1b1f23;
      --muted: #57606a;
      --border: #d0d7de;
      --accent: #0969da;
      --code-bg: #f6f8fa;
    }
    @media (prefers-color-scheme: dark) {
      :root:not(:has(> head > meta[name="color-scheme"][content="light"])) {
        --bg: #0d1117;
        --surface: #161b22;
        --text: #e6edf3;
        --muted: #8b949e;
        --border: #30363d;
        --accent: #58a6ff;
        --code-bg: #1f242c;
      }
    }
    @supports (color: light-dark(white, black)) {
      :root {
        --bg: light-dark(#fafafa, #0d1117);
        --surface: light-dark(#ffffff, #161b22);
        --text: light-dark(#1b1f23, #e6edf3);
        --muted: light-dark(#57606a, #8b949e);
        --border: light-dark(#d0d7de, #30363d);
        --accent: light-dark(#0969da, #58a6ff);
        --code-bg: light-dark(#f6f8fa, #1f242c);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px 16px 64px;
      background: var(--bg);
      color: var(--text);
      font-family: Georgia, "Times New Roman", serif;
      font-size: var(--reader-font-size);
      line-height: 1.75;
    }
    .pd-toolbar {
      max-width: 820px;
      margin: 0 auto 14px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
    }
    .pd-toolbar-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .pd-toolbar label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }
    .pd-toolbar select,
    .pd-toolbar button {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .pd-toolbar button:hover,
    .pd-toolbar select:hover {
      border-color: var(--accent);
    }
    .pd-container {
      max-width: 820px;
      margin: 0 auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 40px 48px;
    }
    .pd-meta-banner {
      border-bottom: 1px solid var(--border);
      padding-bottom: 20px;
      margin-bottom: 28px;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .pd-meta-banner h1 {
      margin: 0 0 6px;
      font-size: 1.9rem;
      line-height: 1.25;
    }
    .pd-meta-subtitle {
      margin: 0 0 8px;
      font-size: 1.05rem;
      color: var(--muted);
      font-weight: 500;
    }
    .pd-meta-sub {
      color: var(--muted);
      font-size: 0.9rem;
      margin: 0;
    }
    .pd-toc {
      margin-bottom: 32px;
      padding: 14px 18px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--code-bg);
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 0.92rem;
    }
    .pd-toc summary {
      cursor: pointer;
      font-weight: 600;
    }
    .pd-toc ol {
      margin: 10px 0 0;
      padding-inline-start: 22px;
      max-height: 360px;
      overflow-y: auto;
    }
    .pd-toc li.pd-toc-lvl-1 {
      margin-inline-start: 16px;
      list-style-type: circle;
    }
    .pd-toc li.pd-toc-lvl-2 {
      margin-inline-start: 32px;
      list-style-type: square;
    }
    .pd-toc a {
      color: var(--accent);
      text-decoration: none;
    }
    .pd-toc a:hover { text-decoration: underline; }
    .pd-section {
      padding-top: 12px;
      margin-bottom: 40px;
    }
    .pd-section + .pd-section {
      border-top: 1px solid var(--border);
      padding-top: 32px;
    }
    img, svg, object.pd-page-image {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 16px auto;
    }
    pre, code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: var(--code-bg);
      border-radius: 4px;
    }
    code { padding: 2px 5px; font-size: 0.88em; }
    pre {
      padding: 14px 16px;
      overflow-x: auto;
      font-size: 0.86em;
      line-height: 1.5;
    }
    pre code { background: none; padding: 0; }
    blockquote {
      margin: 16px 0;
      padding: 8px 18px;
      border-inline-start: 4px solid var(--accent);
      color: var(--muted);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 18px 0;
      font-size: 0.92em;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 8px 10px;
      text-align: start;
    }
    th { background: var(--code-bg); font-weight: 600; }
    @media (max-width: 640px) {
      .pd-container { padding: 24px 18px; }
      body { font-size: 16px; }
    }
    @media print {
      .pd-toolbar, .pd-toc { display: none; }
      body { background: #ffffff; color: #000000; padding: 0; }
      .pd-container { border: none; padding: 0; max-width: 100%; background: #ffffff; }
      .pd-section + .pd-section { break-before: page; border-top: none; }
      figure, pre, table, blockquote, img { break-inside: avoid; }
    }
  `;

  const READER_FOUC_SCRIPT = `<script>try{var s=localStorage.getItem("pd-color-scheme");if(s==="light"||s==="dark"){document.querySelector('meta[name="color-scheme"]').content=s;}}catch(e){}</script>`;

  const READER_CONTROLS_SCRIPT = `<script>
(function(){
  var meta=document.querySelector('meta[name="color-scheme"]');
  var sel=document.getElementById('pdThemeSelect');
  var dec=document.getElementById('pdFontDec');
  var inc=document.getElementById('pdFontInc');
  var prt=document.getElementById('pdPrintBtn');
  var size=18;
  try{
    var saved=localStorage.getItem('pd-color-scheme');
    if(sel) sel.value=(saved==='light'||saved==='dark')?saved:'system';
    var fs=parseInt(localStorage.getItem('pd-font-size')||'',10);
    if(fs>=14&&fs<=28){size=fs;document.documentElement.style.setProperty('--reader-font-size',size+'px');}
  }catch(e){}
  function applyScheme(val){
    if(val==='light'||val==='dark'){
      meta.content=val;
      try{localStorage.setItem('pd-color-scheme',val);}catch(e){}
    }else{
      meta.content='light dark';
      try{localStorage.removeItem('pd-color-scheme');}catch(e){}
    }
  }
  if(sel) sel.addEventListener('change',function(){applyScheme(sel.value);});
  window.addEventListener('storage',function(ev){
    if(ev.key==='pd-color-scheme'){
      var v=(ev.newValue==='light'||ev.newValue==='dark')?ev.newValue:'system';
      if(sel) sel.value=v;
      meta.content=v==='system'?'light dark':v;
    }
  });
  function setSize(next){
    size=Math.max(14,Math.min(28,next));
    document.documentElement.style.setProperty('--reader-font-size',size+'px');
    try{localStorage.setItem('pd-font-size',String(size));}catch(e){}
  }
  if(dec) dec.addEventListener('click',function(){setSize(size-2);});
  if(inc) inc.addEventListener('click',function(){setSize(size+2);});
  if(prt) prt.addEventListener('click',function(){window.print();});
})();
</script>`;

  /**
   * Builds a standalone, print-ready HTML5 document from captured sections.
   * @param {{ meta: object, items: Array<object>, assetMap?: Map, inlineImages?: boolean, signal?: AbortSignal, domParser?: DOMParser }} params
   * @returns {Promise<string>}
   */
  async function buildHtmlDocument({
    meta = {},
    items = [],
    assetMap,
    inlineImages = false,
    signal,
    domParser,
  }) {
    if (signal?.aborted) {
      throw PD.async?.createAbortError ? PD.async.createAbortError() : new Error('Aborted');
    }
    const title = meta.title || 'Perlego Book';
    const subtitle = meta.subtitle || '';
    const author = meta.author || '';
    const language = String(meta.language || 'en').trim() || 'en';
    const dir = meta.dir === 'rtl' ? 'rtl' : 'ltr';
    const yieldCtrl = PD.async?.createYieldController
      ? PD.async.createYieldController(50)
      : null;

    const parser = domParser || (typeof DOMParser !== 'undefined' ? new DOMParser() : null);
    const canResolveLinks = Boolean(parser && PD.domCleaner?.resolveBookLinks);
    const tocEntries = [];
    const preparedSections = [];

    for (let i = 0; i < items.length; i++) {
      if (signal?.aborted) {
        throw PD.async?.createAbortError ? PD.async.createAbortError() : new Error('Aborted');
      }
      const item = items[i];
      const sectionTitle = item.title || `Section ${i + 1}`;
      const sectionId = `section-${i + 1}`;
      const level = Math.max(0, Math.min(2, Number.isFinite(item.level) ? item.level : 0));
      const lvlClass = level > 0 ? ` class="pd-toc-lvl-${level}"` : '';
      tocEntries.push(
        `<li${lvlClass}><a href="#${sectionId}">${escapeHtml(sectionTitle)}</a></li>`
      );

      let htmlBody = item.html || '';
      let doc = null;
      if (canResolveLinks) {
        doc = parser.parseFromString(String(htmlBody), 'text/html');
        if (inlineImages && assetMap && assetMap.size > 0) {
          inlineAssetsInBody(doc, doc.body, assetMap);
        }
      } else if (inlineImages && assetMap && assetMap.size > 0) {
        htmlBody = inlineHtmlAssets(htmlBody, assetMap, { domParser: parser });
      }
      preparedSections.push({
        index: item.index,
        title: sectionTitle,
        sectionId,
        htmlBody,
        doc,
      });

      if (yieldCtrl) {
        await yieldCtrl.maybeYield(signal);
      }
    }

    if (canResolveLinks) {
      PD.domCleaner.resolveBookLinks(preparedSections, {
        targetHrefFor: (_linkChIdx, targetChIdx, targetId) =>
          `#${targetId || preparedSections[targetChIdx]?.sectionId || `section-${targetChIdx + 1}`}`,
      });
    }

    const sectionBlocks = preparedSections.map((sec) => {
      const bodyMarkup = sec.doc ? sec.doc.body.innerHTML : sec.htmlBody;
      sec.doc = null;
      return `<section id="${sec.sectionId}" class="pd-section" data-index="${escapeHtml(sec.index)}">\n${bodyMarkup}\n</section>`;
    });

    const metaParts = [];
    if (author) metaParts.push(`By ${escapeHtml(author)}`);
    if (meta.publisher) metaParts.push(escapeHtml(meta.publisher));
    if (meta.year) metaParts.push(`Published ${escapeHtml(String(meta.year))}`);
    if (meta.isbn) metaParts.push(`ISBN ${escapeHtml(meta.isbn)}`);
    metaParts.push(`${items.length} sections`);
    metaParts.push(`Exported ${escapeHtml(new Date().toISOString().slice(0, 10))}`);

    const subtitleHtml = subtitle
      ? `\n      <p class="pd-meta-subtitle">${escapeHtml(subtitle)}</p>`
      : '';
    const docTitle = meta.year && !String(title).includes(`(${meta.year})`)
      ? `${title} (${meta.year})`
      : title;
    const dirAttr = dir === 'rtl' ? ' dir="rtl"' : '';

    return `<!DOCTYPE html>
<html lang="${escapeHtml(language)}"${dirAttr}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  ${READER_FOUC_SCRIPT}
  <title>${escapeHtml(docTitle)}</title>
  <style>${HTML_STYLES}</style>
</head>
<body>
  <div class="pd-toolbar" role="region" aria-label="Reader controls">
    <div class="pd-toolbar-group">
      <label for="pdThemeSelect">Theme</label>
      <select id="pdThemeSelect" aria-label="Color scheme">
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </div>
    <div class="pd-toolbar-group">
      <button type="button" id="pdFontDec" aria-label="Decrease font size">A−</button>
      <button type="button" id="pdFontInc" aria-label="Increase font size">A+</button>
      <button type="button" id="pdPrintBtn">Print / Save PDF</button>
    </div>
  </div>
  <main class="pd-container">
    <header class="pd-meta-banner">
      <h1>${escapeHtml(title)}</h1>${subtitleHtml}
      <p class="pd-meta-sub">${metaParts.join(' &bull; ')}</p>
    </header>
    <details class="pd-toc">
      <summary>Table of Contents (${items.length})</summary>
      <ol>${tocEntries.join('\n')}</ol>
    </details>
    ${sectionBlocks.join('\n')}
  </main>
  ${READER_CONTROLS_SCRIPT}
</body>
</html>`;
  }

  PD.htmlExporter = {
    escapeHtml,
    inlineHtmlAssets,
    buildHtmlDocument,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PD.htmlExporter;
  }
})();
