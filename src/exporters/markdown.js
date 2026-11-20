/**
 * @file GitHub-Flavored Markdown (GFM) exporter.
 * Converts captured DOM chapters into structured Markdown with YAML frontmatter,
 * indented TOC, internal section links, tables, definition lists, code fences, and TeX math.
 */
(() => {
  'use strict';

  const PD = (globalThis.PerlegoDownloader = globalThis.PerlegoDownloader || {});

  function escapeYamlString(value) {
    return JSON.stringify(String(value ?? ''));
  }

  function wrapInlineEmphasis(text, marker) {
    const raw = String(text || '');
    if (!raw.trim()) return raw;
    const leading = raw.match(/^\s*/)[0];
    const trailing = raw.match(/\s*$/)[0];
    const core = raw.trim();
    return `${leading}${marker}${core}${marker}${trailing}`;
  }

  function formatInlineCode(text) {
    const raw = String(text || '').replace(/\r?\n/g, ' ');
    if (!raw) return '';
    const matches = raw.match(/`+/g) || [];
    let maxRun = 0;
    for (const m of matches) {
      if (m.length > maxRun) maxRun = m.length;
    }
    const fence = '`'.repeat(maxRun + 1);
    const needsPad = raw.startsWith('`') || raw.endsWith('`');
    return needsPad ? `${fence} ${raw} ${fence}` : `${fence}${raw}${fence}`;
  }

  function extractCodeLanguage(preEl) {
    const targets = [preEl, preEl.querySelector?.('code')].filter(Boolean);
    for (const el of targets) {
      const cls = el.getAttribute?.('class') || '';
      const match = cls.match(/(?:^|\s)(?:language|lang)-([a-zA-Z0-9_+-]+)/);
      if (match) return match[1].toLowerCase();
    }
    return '';
  }

  function renderChildren(node, ctx) {
    let out = '';
    const children = node.childNodes || [];
    for (let i = 0; i < children.length; i++) {
      out += nodeToMarkdown(children[i], ctx);
    }
    return out;
  }

  function escapeMdLinkText(text) {
    return String(text || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/([\[\]])/g, '\\$1')
      .trim();
  }

  function formatMdUrl(url) {
    const clean = String(url || '').trim();
    if (!clean) return '';
    return /[\s()]/.test(clean) ? `<${clean}>` : clean;
  }

  function tableToMarkdown(tableEl, ctx) {
    const captionEl = tableEl.querySelector?.('caption');
    const captionText = captionEl ? renderChildren(captionEl, ctx).replace(/\s+/g, ' ').trim() : '';

    const rows = Array.from(tableEl.querySelectorAll?.('tr') || []);
    if (rows.length === 0) return captionText ? `\n\n**${captionText}**\n\n` : '';

    const matrix = [];
    for (const row of rows) {
      const cells = Array.from(row.children || []).filter((c) => {
        const tag = (c.tagName || '').toLowerCase();
        return tag === 'th' || tag === 'td';
      });
      if (cells.length === 0) continue;
      matrix.push(
        cells.map((cell) => {
          const inner = renderChildren({ childNodes: cell.childNodes }, { ...ctx, inTable: true });
          return inner
            .replace(/\r?\n+/g, '<br>')
            .replace(/\|/g, '\\|')
            .replace(/\s+/g, ' ')
            .trim();
        })
      );
    }

    if (matrix.length === 0) return captionText ? `\n\n**${captionText}**\n\n` : '';
    const colCount = Math.max(...matrix.map((r) => r.length));
    const padRow = (r) => {
      const padded = r.slice();
      while (padded.length < colCount) padded.push('');
      return `| ${padded.join(' | ')} |`;
    };

    const header = padRow(matrix[0]);
    const separator = `| ${new Array(colCount).fill('---').join(' | ')} |`;
    const bodyRows = matrix.slice(1).map(padRow);
    const captionPrefix = captionText ? `**${captionText}**\n\n` : '';
    return `\n\n${captionPrefix}${[header, separator, ...bodyRows].join('\n')}\n\n`;
  }

  function listToMarkdown(listEl, ordered, ctx) {
    const depth = ctx.listDepth || 0;
    const startAttr = ordered ? parseInt(listEl.getAttribute?.('start') || '1', 10) : 1;
    let counter = Number.isFinite(startAttr) ? startAttr : 1;
    const items = Array.from(listEl.children || []).filter(
      (el) => (el.tagName || '').toLowerCase() === 'li'
    );

    const lines = [];
    for (const li of items) {
      const prefix = ordered ? `${counter++}. ` : '- ';
      const contIndent = '  ';
      const raw = renderChildren(li, { ...ctx, listDepth: depth + 1 })
        .replace(/^\n+|\n+$/g, '');
      const subLines = raw.split('\n');
      const firstLine = subLines[0] ? subLines[0].trim() : '';
      const rest = subLines.slice(1).map((line) => (line ? `${contIndent}${line}` : ''));
      lines.push(`${prefix}${firstLine}${rest.length ? '\n' + rest.join('\n') : ''}`);
    }

    if (depth === 0) {
      return `\n\n${lines.join('\n')}\n\n`;
    }
    return `\n${lines.join('\n')}`;
  }

  function extractMathTex(el) {
    const direct = el.getAttribute?.('data-tex') || el.getAttribute?.('alttext');
    if (direct && direct.trim()) return direct.trim();
    const ann = el.querySelector?.(
      'annotation[encoding="application/x-tex"], annotation[encoding="TeX"], annotation[encoding="text/x-tex"]'
    );
    if (ann?.textContent?.trim()) return ann.textContent.trim();
    return '';
  }

  function nodeToMarkdown(node, ctx = {}) {
    if (!node) return '';
    if (node.nodeType === 3) {
      // Text node
      if (ctx.inPre) return node.nodeValue || '';
      const text = (node.nodeValue || '').replace(/[\t\r\n ]+/g, ' ');
      return text;
    }
    if (node.nodeType !== 1) return '';

    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'button') {
      return '';
    }

    // MathML or TeX-annotated blocks
    if (tag === 'math' || node.hasAttribute?.('data-tex')) {
      const tex = extractMathTex(node);
      if (tex) {
        const isBlock = node.getAttribute?.('display') === 'block';
        return isBlock ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
      }
    }

    if (tag === 'pre') {
      const lang = extractCodeLanguage(node);
      const codeEl = node.querySelector?.('code') || node;
      const codeText = (codeEl.textContent || '').replace(/^\n+|\n+$/g, '');
      const backtickRuns = codeText.match(/`+/g) || [];
      let maxRun = 2;
      for (const r of backtickRuns) {
        if (r.length > maxRun) maxRun = r.length;
      }
      const fence = '`'.repeat(maxRun + 1);
      return `\n\n${fence}${lang}\n${codeText}\n${fence}\n\n`;
    }

    if (tag === 'code' || tag === 'kbd' || tag === 'samp') {
      return formatInlineCode(node.textContent || '');
    }

    if (tag === 'mark') {
      return wrapInlineEmphasis(renderChildren(node, ctx), '==');
    }

    if (tag === 'br') return '  \n';
    if (tag === 'hr') return '\n\n---\n\n';

    if (/^h([1-6])$/.test(tag)) {
      const level = parseInt(tag.slice(1), 10);
      const text = renderChildren(node, ctx).replace(/\s+/g, ' ').trim();
      if (!text) return '';
      return `\n\n${'#'.repeat(level)} ${text}\n\n`;
    }

    if (tag === 'p') {
      const text = renderChildren(node, ctx).trim();
      return text ? `\n\n${text}\n\n` : '';
    }

    if (tag === 'strong' || tag === 'b') {
      return wrapInlineEmphasis(renderChildren(node, ctx), '**');
    }

    if (tag === 'em' || tag === 'i') {
      return wrapInlineEmphasis(renderChildren(node, ctx), '*');
    }

    if (tag === 'del' || tag === 's' || tag === 'strike') {
      return wrapInlineEmphasis(renderChildren(node, ctx), '~~');
    }

    if (tag === 'sup') {
      const text = renderChildren(node, ctx).trim();
      if (!text) return '';
      return /\s/.test(text) ? `<sup>${text}</sup>` : `^${text}^`;
    }

    if (tag === 'sub') {
      const text = renderChildren(node, ctx).trim();
      return text ? `<sub>${text}</sub>` : '';
    }

    if (tag === 'a') {
      const href = (node.getAttribute?.('href') || '').trim();
      const rawLabel = renderChildren(node, ctx).trim();
      const text = rawLabel || href;
      if (!href || /^javascript:/i.test(href)) return text;
      return `[${escapeMdLinkText(text)}](${formatMdUrl(href)})`;
    }

    if (tag === 'img') {
      const src = (node.getAttribute?.('src') || '').trim();
      if (!src) return '';
      const alt = escapeMdLinkText(node.getAttribute?.('alt') || '');
      return `![${alt}](${formatMdUrl(src)})`;
    }

    if (tag === 'object') {
      const dataUrl = (node.getAttribute?.('data-asset-url') || node.getAttribute?.('data') || '').trim();
      const fallbackText = renderChildren(node, ctx).trim();
      const imgMd = dataUrl ? `![Page ${(ctx.sectionIndex ?? 0) + 1}](${formatMdUrl(dataUrl)})` : '';
      if (imgMd && fallbackText) return `\n\n${imgMd}\n\n${fallbackText}\n\n`;
      if (imgMd) return `\n\n${imgMd}\n\n`;
      return fallbackText;
    }

    if (tag === 'figure') {
      const captionEl = node.querySelector?.('figcaption');
      let bodyMd = '';
      for (const child of Array.from(node.childNodes || [])) {
        if (child === captionEl) continue;
        bodyMd += nodeToMarkdown(child, ctx);
      }
      const captionText = captionEl ? renderChildren(captionEl, ctx).trim() : '';
      const combined = captionText
        ? `${bodyMd.trim()}\n*${captionText}*`
        : bodyMd.trim();
      return combined ? `\n\n${combined}\n\n` : '';
    }

    if (tag === 'blockquote' || tag === 'aside') {
      const inner = renderChildren(node, ctx).trim();
      if (!inner) return '';
      const quoted = inner
        .split('\n')
        .map((line) => (line.trim() ? `> ${line}` : '>'))
        .join('\n');
      return `\n\n${quoted}\n\n`;
    }

    if (tag === 'dl') {
      const inner = renderChildren(node, ctx).trim();
      return inner ? `\n\n${inner}\n\n` : '';
    }

    if (tag === 'dt') {
      const text = renderChildren(node, ctx).replace(/\s+/g, ' ').trim();
      return text ? `\n\n**${text}**\n` : '';
    }

    if (tag === 'dd') {
      const text = renderChildren(node, ctx).trim();
      return text ? `: ${text}\n` : '';
    }

    if (tag === 'ul') return listToMarkdown(node, false, ctx);
    if (tag === 'ol') return listToMarkdown(node, true, ctx);
    if (tag === 'table') return tableToMarkdown(node, ctx);

    if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'main' || tag === 'header' || tag === 'footer') {
      const inner = renderChildren(node, ctx);
      if (!inner.trim()) return '';
      if (ctx.inTable) return inner;
      const startsWithBlock = /^\s*\n/.test(inner);
      const endsWithBlock = /\n\s*$/.test(inner);
      return `${startsWithBlock ? '' : '\n'}${inner}${endsWithBlock ? '' : '\n'}`;
    }

    return renderChildren(node, ctx);
  }

  /**
   * Normalizes blank lines outside fenced code blocks so fenced code blocks stay verbatim.
   */
  function normalizeMarkdownSpacing(md) {
    const lines = String(md || '').split('\n');
    const out = [];
    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;
    let blankRun = 0;

    for (const line of lines) {
      const fenceMatch = line.match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (!inFence) {
          inFence = true;
          fenceChar = marker[0];
          fenceLen = marker.length;
        } else if (marker[0] === fenceChar && marker.length >= fenceLen && line.trim() === marker) {
          inFence = false;
        }
        blankRun = 0;
        out.push(line.replace(/[ \t]+$/g, ''));
        continue;
      }

      if (inFence) {
        out.push(line);
        continue;
      }

      const trimmed = line.replace(/[ \t]+$/g, '');
      if (trimmed === '') {
        blankRun += 1;
        if (blankRun <= 1) out.push('');
      } else {
        blankRun = 0;
        out.push(trimmed);
      }
    }

    return out.join('\n').trim() + '\n';
  }

  /**
   * Builds a clean GitHub-Flavored Markdown document with YAML frontmatter, hierarchical TOC,
   * and resolved internal section links.
   * @param {{ meta: object, items: Array<object>, signal?: AbortSignal, domParser?: DOMParser }} params
   * @returns {Promise<string>}
   */
  async function buildMarkdownDocument({ meta = {}, items = [], signal, domParser }) {
    if (signal?.aborted) {
      throw PD.async?.createAbortError ? PD.async.createAbortError() : new Error('Aborted');
    }
    const parser = domParser || (typeof DOMParser !== 'undefined' ? new DOMParser() : null);
    if (!parser) {
      throw new Error('DOMParser is required for Markdown export');
    }

    const yieldCtrl = PD.async?.createYieldController
      ? PD.async.createYieldController(50)
      : null;

    const title = meta.title || 'Perlego Book';
    const frontmatterLines = [
      '---',
      `title: ${escapeYamlString(title)}`,
      meta.subtitle ? `subtitle: ${escapeYamlString(meta.subtitle)}` : null,
      `author: ${escapeYamlString(meta.author || '')}`,
      meta.publisher ? `publisher: ${escapeYamlString(meta.publisher)}` : null,
      meta.year ? `year: ${escapeYamlString(String(meta.year))}` : null,
      meta.isbn ? `isbn: ${escapeYamlString(meta.isbn)}` : null,
      meta.language ? `language: ${escapeYamlString(meta.language)}` : null,
      `book_id: ${escapeYamlString(meta.bookId || '')}`,
      `source_url: ${escapeYamlString(meta.url || '')}`,
      `exported_at: ${escapeYamlString(new Date().toISOString())}`,
      `sections: ${items.length}`,
      '---',
    ].filter(Boolean);
    const frontmatter = frontmatterLines.join('\n');

    const prepared = [];
    for (let i = 0; i < items.length; i++) {
      if (signal?.aborted) {
        throw PD.async?.createAbortError ? PD.async.createAbortError() : new Error('Aborted');
      }
      const item = items[i];
      const sectionTitle = (item.title || `Section ${i + 1}`).replace(/[\[\]\r\n]/g, ' ').trim();
      const level = Math.max(0, Math.min(3, Number.isFinite(item.level) ? item.level : 0));
      const doc = parser.parseFromString(String(item.html || ''), 'text/html');
      prepared.push({
        index: item.index,
        title: sectionTitle,
        level,
        sectionId: `section-${i + 1}`,
        doc,
      });
      if (yieldCtrl) {
        await yieldCtrl.maybeYield(signal);
      }
    }

    if (PD.domCleaner?.resolveBookLinks && prepared.length > 0) {
      PD.domCleaner.resolveBookLinks(prepared, {
        targetHrefFor: (_linkChIdx, targetChIdx) =>
          `#${prepared[targetChIdx]?.sectionId || `section-${targetChIdx + 1}`}`,
      });
    }

    const tocLines = ['## Table of Contents', ''];
    const sections = [];

    for (let i = 0; i < prepared.length; i++) {
      if (signal?.aborted) {
        throw PD.async?.createAbortError ? PD.async.createAbortError() : new Error('Aborted');
      }
      const entry = prepared[i];
      const indent = '  '.repeat(entry.level);
      const bullet = entry.level === 0 ? `${i + 1}. ` : '- ';
      tocLines.push(`${indent}${bullet}[${entry.title}](#${entry.sectionId})`);

      const mdBody = normalizeMarkdownSpacing(
        nodeToMarkdown(entry.doc.body, { sectionIndex: i })
      );
      entry.doc = null;

      // Avoid repeating heading if chapter already begins with the exact same title
      const firstHeadingMatch = mdBody.match(/^#{1,6}\s+(.+)/);
      const startsWithSameTitle =
        firstHeadingMatch &&
        firstHeadingMatch[1].trim().toLowerCase() === entry.title.toLowerCase();

      const headerBlock = startsWithSameTitle
        ? `<a id="${entry.sectionId}"></a>\n\n`
        : `<a id="${entry.sectionId}"></a>\n\n## ${entry.title}\n\n`;

      sections.push(`${headerBlock}${mdBody.trim()}`);

      if (yieldCtrl) {
        await yieldCtrl.maybeYield(signal);
      }
    }

    const parts = [
      frontmatter,
      '',
      `# ${title}`,
      '',
      tocLines.join('\n'),
      '',
      '---',
      '',
      sections.join('\n\n---\n\n'),
      '',
    ];

    return parts.join('\n');
  }

  PD.markdownExporter = {
    nodeToMarkdown,
    normalizeMarkdownSpacing,
    buildMarkdownDocument,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PD.markdownExporter;
  }
})();
