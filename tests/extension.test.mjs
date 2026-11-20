import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ShimDOMParser, ShimXMLSerializer, ShimDocument } from './dom-shim.mjs';

const require = createRequire(import.meta.url);
const asyncUtils = require('../src/utils/async.js');
const zipLib = require('../src/lib/zip.js');
const domCleaner = require('../src/utils/dom-cleaner.js');
const htmlExporter = require('../src/exporters/html.js');
const markdownExporter = require('../src/exporters/markdown.js');
const epubExporter = require('../src/exporters/epub.js');

const domParser = new ShimDOMParser();
const xmlSerializer = new ShimXMLSerializer();

// Valid 1x1 PNG (68 bytes)
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

test('srcset parser chooses highest resolution and handles commas in URLs', () => {
  const best = domCleaner.parseSrcsetBestUrl(
    'https://cdn.example.com/img?w=400,q=80 400w, https://cdn.example.com/img?w=1600,q=80 1600w, https://cdn.example.com/img?w=800,q=80 800w',
    'https://ereader.perlego.com/1/book/123'
  );
  assert.equal(best, 'https://cdn.example.com/img?w=1600,q=80');

  const density = domCleaner.parseSrcsetBestUrl('/assets/fig-1x.png 1x, /assets/fig-2x.png 2x', 'https://ereader.perlego.com/');
  assert.equal(density, 'https://ereader.perlego.com/assets/fig-2x.png');
});

test('magic-byte MIME detection overrides binary/octet-stream headers', () => {
  const pngInfo = domCleaner.detectImageMimeAndExt(new Uint8Array(TINY_PNG), 'binary/octet-stream', 'https://cdn.example.com/asset');
  assert.deepEqual(pngInfo, { mime: 'image/png', ext: 'png' });

  const jpgInfo = domCleaner.detectImageMimeAndExt(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'application/octet-stream', '');
  assert.deepEqual(jpgInfo, { mime: 'image/jpeg', ext: 'jpg' });

  const svgInfo = domCleaner.detectImageMimeAndExt(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), '', '');
  assert.deepEqual(svgInfo, { mime: 'image/svg+xml', ext: 'svg' });
});

test('DOM cleaner unwraps <picture>, strips scripts/buttons, and repairs opacity/height', () => {
  const rawHtml = `
    <div id="p0--0" class="chapter-loaded highlighter-context">
      <h1>1. Clean Architecture</h1>
      <button>Copy</button>
      <script>alert(1)</script>
      <picture>
        <source data-srcset="https://cdn.perlego.com/low.jpg 400w, https://cdn.perlego.com/high.jpg 1200w" />
        <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="Diagram" style="opacity: 0; object-fit: contain; height: 100%;" />
      </picture>
      <p>Body paragraph.</p>
    </div>
  `;

  const cleaned = domCleaner.cleanChapterHtml(rawHtml, {
    baseUrl: 'https://ereader.perlego.com/1/book/999',
    index: 0,
    domParser,
  });

  assert.equal(cleaned.title, '1. Clean Architecture');
  assert.deepEqual(cleaned.assetUrls, ['https://cdn.perlego.com/high.jpg']);
  assert.ok(!cleaned.html.includes('<script'));
  assert.ok(!cleaned.html.includes('<button'));
  assert.ok(!cleaned.html.includes('<picture'));
  assert.ok(cleaned.html.includes('https://cdn.perlego.com/high.jpg'));
  assert.ok(cleaned.html.includes('opacity: 1'));
  assert.ok(cleaned.html.includes('height: auto'));
});

test('Book context extraction extracts ID, clean title, and mode', () => {
  const doc = domParser.parseFromString(
    '<html><head><meta name="author" content="Ada Lovelace"></head><body><h1 data-test-locator="BookTitle">Algorithms Illustrated</h1><div data-test-locator="Epub-ChapterRow-Index-0">Ch 1</div></body></html>',
    'text/html'
  );
  const ctx = domCleaner.extractBookContext(doc, {
    pathname: '/1/book/456789',
    href: 'https://ereader.perlego.com/1/book/456789',
  });
  assert.equal(ctx.bookId, 'book-456789');
  assert.equal(ctx.title, 'Algorithms Illustrated');
  assert.equal(ctx.author, 'Ada Lovelace');
  assert.equal(ctx.detectedMode, 'epub');
  assert.equal(ctx.safeTitle, 'Algorithms Illustrated');
});

test('Markdown exporter handles YAML frontmatter, TOC, tables, nested lists, fenced code, and TeX math', async () => {
  const md = await markdownExporter.buildMarkdownDocument({
    meta: {
      title: 'Systems Engineering',
      author: 'Grace Hopper',
      bookId: 'book-101',
      url: 'https://ereader.perlego.com/1/book/101',
    },
    items: [
      {
        index: 0,
        title: 'Foundations',
        html: `
          <h1>Foundations</h1>
          <p>Intro with <strong>bold</strong>, <em>italic</em>, and <code>inline()</code>.</p>
          <ul>
            <li>Outer 1
              <ol>
                <li>Nested A</li>
                <li>Nested B</li>
              </ol>
            </li>
            <li>Outer 2</li>
          </ul>
          <pre><code class="language-js">const x = 1;\n\nconsole.log(x);</code></pre>
          <table>
            <thead><tr><th>Col A</th><th>Col | B</th></tr></thead>
            <tbody><tr><td>Val 1</td><td>Val 2</td></tr></tbody>
          </table>
          <math display="block"><semantics><annotation encoding="application/x-tex">E = mc^2</annotation></semantics></math>
        `,
      },
    ],
    domParser,
  });

  assert.ok(md.startsWith('---\ntitle: "Systems Engineering"\nauthor: "Grace Hopper"'));
  assert.ok(md.includes('1. [Foundations](#section-1)'));
  assert.ok(md.includes('# Foundations'));
  assert.ok(md.includes('**bold**'));
  assert.ok(md.includes('- Outer 1\n  1. Nested A\n  2. Nested B\n- Outer 2'));
  assert.ok(md.includes('```js\nconst x = 1;\n\nconsole.log(x);\n```'));
  assert.ok(md.includes('| Col A | Col \\| B |\n| --- | --- |\n| Val 1 | Val 2 |'));
  assert.ok(md.includes('$$\nE = mc^2\n$$'));
});

test('HTML exporter embeds offline data URLs when inlineImages is enabled', async () => {
  const assetMap = new Map([
    [
      'https://cdn.perlego.com/fig1.png',
      {
        bytes: new Uint8Array(TINY_PNG),
        mime: 'image/png',
        ext: 'png',
        dataUrl: domCleaner.bytesToDataUrl(new Uint8Array(TINY_PNG), 'image/png'),
      },
    ],
  ]);

  const html = await htmlExporter.buildHtmlDocument({
    meta: { title: 'Offline Book', author: 'Alan Turing' },
    items: [
      {
        index: 0,
        title: 'Chapter 1',
        html: '<p>Look:</p><img src="https://cdn.perlego.com/fig1.png" alt="Figure 1">',
      },
    ],
    assetMap,
    inlineImages: true,
    domParser,
  });

  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('<meta name="color-scheme" content="light dark">'));
  assert.ok(html.includes('data:image/png;base64,iVBORw0KGgo'));
  assert.ok(!html.includes('https://cdn.perlego.com/fig1.png'));
});

test('EPUB 3 generator produces valid OCF ZIP passing unzip -t and strict XML validation', async () => {
  const imgUrl = 'https://cdn.perlego.com/cover-diagram.png';
  const assetMap = new Map([
    [
      imgUrl,
      {
        bytes: new Uint8Array(TINY_PNG),
        mime: 'image/png',
        ext: 'png',
        dataUrl: domCleaner.bytesToDataUrl(new Uint8Array(TINY_PNG), 'image/png'),
      },
    ],
  ]);

  const entries = await epubExporter.buildEpubEntries({
    meta: { title: 'Designing Distributed Systems & APIs', author: 'Martin Fowler' },
    items: [
      {
        index: 0,
        title: 'Chapter 1: Intro & Scope',
        html: `<div id="123"><h1 id="123">Intro &amp; Scope</h1><p>Text with <br>break and image:</p><img src="${imgUrl}" alt="Diagram"><script>bad()</script></div>`,
      },
      {
        index: 1,
        title: 'Chapter 2: Reliability',
        html: '<h2>Reliability</h2><blockquote><p>Keep it simple.</p></blockquote><p>Done.</p>',
      },
    ],
    assetMap,
    domParser,
    xmlSerializer,
  });

  const zipBytes = await zipLib.createZipBytes(entries);

  // Verify OCF requirement: local file header (30 bytes) + "mimetype" (8 bytes) + "application/epub+zip" (20 bytes)
  const magic = Buffer.from(zipBytes.slice(0, 4)).toString('binary');
  assert.equal(magic, 'PK\x03\x04');
  const method = new DataView(zipBytes.buffer).getUint16(8, true);
  const extraLen = new DataView(zipBytes.buffer).getUint16(28, true);
  assert.equal(method, 0, 'mimetype must be stored uncompressed');
  assert.equal(extraLen, 0, 'mimetype extra field length must be 0');
  assert.equal(Buffer.from(zipBytes.slice(30, 38)).toString('ascii'), 'mimetype');
  assert.equal(Buffer.from(zipBytes.slice(38, 58)).toString('ascii'), 'application/epub+zip');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perlego-epub-test-'));
  const epubPath = path.join(tmpDir, 'test-book.epub');
  fs.writeFileSync(epubPath, zipBytes);

  try {
    // 1. Verify CRC and ZIP structure with system `unzip -t`
    const unzipOut = execFileSync('unzip', ['-t', epubPath], { encoding: 'utf8' });
    assert.ok(unzipOut.includes('No errors detected'), unzipOut);

    // 2. Verify every XML/XHTML file inside the EPUB parses strictly with Python xml.etree.ElementTree
    const pyScript = `
import sys, zipfile, xml.etree.ElementTree as ET
epub = sys.argv[1]
with zipfile.ZipFile(epub, 'r') as zf:
    names = zf.namelist()
    assert names[0] == 'mimetype', f'Expected mimetype first, got {names[0]}'
    assert zf.getinfo('mimetype').compress_type == zipfile.ZIP_STORED
    assert 'OEBPS/images/img-0001.png' in names
    xml_files = [n for n in names if n.endswith(('.xml', '.opf', '.ncx', '.xhtml'))]
    assert len(xml_files) >= 6
    for name in xml_files:
        data = zf.read(name)
        ET.fromstring(data)
    opf = ET.fromstring(zf.read('OEBPS/content.opf'))
    assert opf.attrib.get('version') == '3.0'
print('XML_VALIDATION_OK', len(xml_files))
`;
    const pyOut = execFileSync('python3', ['-c', pyScript, epubPath], { encoding: 'utf8' });
    assert.ok(pyOut.includes('XML_VALIDATION_OK'), pyOut);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('async mapPool preserves order and bounds concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const progressCalls = [];

  const result = await asyncUtils.mapPool(
    input,
    3,
    async (n) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await asyncUtils.sleep(10);
      active -= 1;
      return n * 10;
    },
    (done, total) => progressCalls.push([done, total])
  );

  assert.deepEqual(result, [10, 20, 30, 40, 50, 60, 70, 80]);
  assert.ok(maxActive <= 3, `Expected max concurrency <= 3, got ${maxActive}`);
  assert.equal(progressCalls.length, 8);
});

test('Front-matter metadata enrichment extracts year, author, clean title, cover, and OPF cover-image tags', async () => {
  const coverUrl = 'https://cdn.perlego.com/cover.jpg';
  const items = [
    {
      index: 0,
      title: 'Cover Page',
      html: `<div id="cover--0"><img src="${coverUrl}" alt="Cover: Qualitative Marketing Research: Understanding Consumer Behaviour, written by Dominika Maison, published by Routledge." /></div>`,
    },
    {
      index: 1,
      title: 'Title Page',
      html: `<section id="titlepage--0_titlepage"><h1 id="titlepage--4_tp">Qualitative Marketing Research<span class="subtitle">Understanding Consumer Behaviour</span></h1><div class="author1">Dominika Maison</div></section>`,
    },
    {
      index: 2,
      title: 'Copyright Page',
      html: `<section id="copy--0"><div>Second edition published 2026 by Routledge</div><div>© 2026 Dominika Maison</div><div>Copyright, Designs and Patents Act 1988. First edition published 2018</div></section>`,
    },
  ];

  const enriched = domCleaner.enrichBookMetadata(
    { bookId: 'book-999', title: 'Qualitative Marketing ResearchUnderstanding Consumer Behaviour', author: '' },
    items,
    domParser
  );

  assert.equal(enriched.title, 'Qualitative Marketing Research');
  assert.equal(enriched.subtitle, 'Understanding Consumer Behaviour');
  assert.equal(enriched.author, 'Dominika Maison');
  assert.equal(enriched.year, '2026');
  assert.equal(enriched.coverUrl, coverUrl);
  assert.equal(domCleaner.formatBookFilename(enriched), 'Qualitative Marketing Research (2026)');

  const assetMap = new Map([
    [
      coverUrl,
      {
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
        mime: 'image/jpeg',
        ext: 'jpg',
        dataUrl: 'data:image/jpeg;base64,/9j/4AAQ',
      },
    ],
  ]);

  const entries = await epubExporter.buildEpubEntries({
    meta: enriched,
    items,
    assetMap,
    domParser,
    xmlSerializer,
  });
  const byPath = new Map(entries.map((e) => [e.path, e.data]));
  assert.ok(byPath.has('OEBPS/images/cover.jpg'));
  const opf = String(byPath.get('OEBPS/content.opf'));
  assert.ok(opf.includes('<dc:title>Qualitative Marketing Research (2026)</dc:title>'));
  assert.ok(opf.includes('<dc:creator>Dominika Maison</dc:creator>'));
  assert.ok(opf.includes('<dc:date>2026</dc:date>'));
  assert.ok(opf.includes('<meta name="cover" content="cover-image"/>'));
  assert.ok(opf.includes('id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"'));
  assert.ok(opf.includes('<guide>\n    <reference type="cover" title="Cover" href="chapters/ch-0001.xhtml"/>\n  </guide>'));
});

test('Metadata enrichment handles Springer/Palgrave copyright lines, affiliation-free authors, and latest edition year', () => {
  // 1. Springer/Palgrave with separate Title/Copyright and dirty initial author
  const springerEnriched = domCleaner.enrichBookMetadata(
    {
      bookId: 'book-201',
      title: 'Foundations of Consumer Behavior',
      author: 'Richard P. BagozziRoss School of Business, University of Michigan, Ann Arbor, MI, USA',
    },
    [
      { index: 0, title: 'Untitled Chapter', html: '<div id="p0--0"><img src="https://cdn.example/c.webp" alt="Cover: ..." /></div>' },
      {
        index: 2,
        title: 'Foundations of Consumer Behavior',
        html: '<div class="BookAuthors"><span class="AuthorName">Richard\u00a0P.\u00a0Bagozzi</span> and <span class="AuthorName">Attila\u00a0Yaprak</span></div>',
      },
      {
        index: 3,
        title: 'Untitled Subchapter',
        html: '<div class="CopyrightPageOriginators"><div class="Author"><span class="AuthorName">Richard P. Bagozzi</span><div class="Affiliation"><div class="AffiliationText">Ross School of Business</div></div></div></div><div class="CopyrightLine">© The Editor(s) (if applicable) and The Author(s), under exclusive license to Springer Nature Switzerland AG 2025</div>',
      },
    ],
    domParser
  );
  assert.equal(springerEnriched.year, '2025');
  assert.equal(springerEnriched.author, 'Richard P. Bagozzi, Attila Yaprak');
  assert.equal(domCleaner.formatBookFilename(springerEnriched), 'Foundations of Consumer Behavior (2025)');

  // 2. Single Front Matter combining Title + Copyright + series blurb with "1350 and 1950"
  const godfatherEnriched = domCleaner.enrichBookMetadata(
    { bookId: 'book-202', title: 'Godfather Marketing', author: '' },
    [
      { index: 0, title: 'Cover', html: '<img src="https://cdn.example/gm.webp" alt="Cover image" />' },
      {
        index: 1,
        title: 'Front Matter',
        html: '<div class="BookFrontmatter"><div class="SeriesInformationText">Between 1350 and 1950...</div><div class="BookTitlePage"><div class="BookAuthors"><span class="AuthorName">Gianluigi\u00a0Guido</span></div></div><div class="CopyrightPage"><div class="CopyrightLine">© The Author(s), under exclusive license to Springer Nature Switzerland AG 2024</div></div></div>',
      },
    ],
    domParser
  );
  assert.equal(godfatherEnriched.year, '2024');
  assert.equal(godfatherEnriched.author, 'Gianluigi Guido');

  // 3. Multi-edition book picking latest publication year (2015 over 2010)
  const huntEnriched = domCleaner.enrichBookMetadata(
    { bookId: 'book-203', title: 'Marketing Theory', author: 'Shelby D. Hunt' },
    [
      {
        index: 3,
        title: 'Copyright Page',
        html: '<div>First published 2010 by M.E. Sharpe</div><div>Published 2015 by Routledge</div><div>HF5415.H869 2009</div>',
      },
    ],
    domParser
  );
  assert.equal(huntEnriched.year, '2015');
});

test('DOM cleaner prefers non-WebP sources and preserves Perlego scroll/composite-ID hints', () => {
  const rawHtml = `
    <div>
      <picture>
        <source type="image/webp" data-srcset="https://cdn.perlego.com/img.webp" />
        <source type="image/jpeg" data-srcset="https://cdn.perlego.com/img.jpg" />
        <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="Figure" />
      </picture>
      <a id="contents--22 R_24031-0501_ch001" onclick="javascript: window.scrollWithinBook('target_sec', '1')">Chapter 1</a>
    </div>
  `;
  const cleaned = domCleaner.cleanChapterHtml(rawHtml, { domParser });
  assert.deepEqual(cleaned.assetUrls, ['https://cdn.perlego.com/img.jpg']);
  assert.ok(cleaned.html.includes('data-fallback-src="https://cdn.perlego.com/img.webp"'));
  assert.ok(cleaned.html.includes('id="contents--22"'));
  assert.ok(cleaned.html.includes('data-originalid="R_24031-0501_ch001"'));
  assert.ok(cleaned.html.includes('data-pd-scroll-target="target_sec"'));
  assert.ok(cleaned.html.includes('data-pd-scroll-chapter="1"'));
  assert.ok(!cleaned.html.includes('onclick='));
});

test('EPUB 3 and HTML exporters resolve #fragment suffixes, Index page numbers, TOC links, Figures, and Citations', async () => {
  const tocCleaned = domCleaner.cleanChapterHtml(`
    <nav id="Toc--0">
      <h1>Contents</h1>
      <ol>
        <li><a id="Toc--10_R_ch001" onclick="javascript: window.scrollWithinBook('', '1')">1 Foundations</a></li>
        <li><a id="Toc--12" onclick="javascript: window.scrollWithinBook('', '1')">Figure 1.1 Architecture</a></li>
      </ol>
    </nav>
  `, { index: 0, domParser });

  const ch1Cleaned = domCleaner.cleanChapterHtml(`
    <div id="ch1--0">
      <h1 id="ch1--2_ch001">1 Foundations</h1>
      <span id="ch1--10_p82"></span>
      <p>See endnote <a href="#en1_1" id="ch1--11_R_en1_1">1</a> and citation <a id="c1--11_r1_18b">Schumann &amp; Thorson, 1999</a>.</p>
      <figure id="ch1--20_fig1_1"><figcaption id="ch1--21">Figure 1.1 Architecture</figcaption></figure>
      <ol>
        <li id="ch1--328_en1_1">First endnote body.</li>
        <li id="c1--328_r1_18">Schumann, D., &amp; Thorson, E. (1999). Advertising. <a id="c1--330"><span id="c1--331_xr1_18b">Return to text.</span></a></li>
      </ol>
    </div>
  `, { index: 1, domParser });

  const indexCleaned = domCleaner.cleanChapterHtml(`
    <div id="Index--0">
      <h1>Index</h1>
      <p>Attribution, <a id="Index--14" onclick="javascript: window.scrollWithinBook('', '1')">82</a></p>
    </div>
  `, { index: 2, domParser });

  const items = [
    { index: 0, title: 'Contents', html: tocCleaned.html },
    { index: 1, title: '1 Foundations', html: ch1Cleaned.html },
    { index: 2, title: 'Index', html: indexCleaned.html },
  ];

  const entries = await epubExporter.buildEpubEntries({
    meta: { title: 'Test Links Book', year: '2026' },
    items,
    domParser,
    xmlSerializer,
  });
  const byPath = new Map(entries.map((e) => [e.path, String(e.data)]));

  const ch0 = byPath.get('OEBPS/chapters/ch-0001.xhtml');
  const ch1 = byPath.get('OEBPS/chapters/ch-0002.xhtml');
  const ch2 = byPath.get('OEBPS/chapters/ch-0003.xhtml');

  // TOC resolves across chapters via original ID and Figure number
  assert.ok(ch0.includes('href="ch-0002.xhtml#ch1--2_ch001"'), ch0);
  assert.ok(ch0.includes('href="ch-0002.xhtml#ch1--20_fig1_1"'), ch0);

  // In-chapter #fragment resolves to prefixed ID, citation resolves to bib item, and return link points back to citation
  assert.ok(ch1.includes('href="#ch1--328_en1_1"'), ch1);
  assert.ok(ch1.includes('href="#c1--328_r1_18"'), ch1);
  assert.ok(ch1.includes('href="#c1--11_r1_18b"'), ch1);

  // Index page link jumps directly to exact print page anchor (_p82), NOT just top of ch-0002.xhtml
  assert.ok(ch2.includes('href="ch-0002.xhtml#ch1--10_p82"'), ch2);

  // Temporary hint attributes must be cleaned up before XHTML output
  assert.ok(!ch0.includes('data-originalid') && !ch2.includes('data-pd-scroll-chapter'));

  // Standalone HTML5 output also resolves internal links cleanly
  const htmlDocStr = await htmlExporter.buildHtmlDocument({
    meta: { title: 'Test Links Book', year: '2026' },
    items,
    domParser,
  });
  assert.ok(htmlDocStr.includes('href="#ch1--10_p82"'));
  assert.ok(htmlDocStr.includes('href="#ch1--328_en1_1"'));
  assert.ok(htmlDocStr.includes('href="#c1--328_r1_18"'));
});

test('resolveBookLinks + epubExporter resolves stripped paired #fn_ <-> #rfn_ and #cXX-fig <-> #rcXX-fig links', async () => {
  const pairedItems = [
    {
      id: 'ch-paired-1',
      title: 'Chapter 2',
      label: 'Chapter 2',
      level: 0,
      html: [
        '<section>',
        '<p>See note<a id="c002--17" href="#fn_2_abc">1</a> and figure ref <a id="c002--18" href="#c02-fig-1">Figure 2.1</a>.</p>',
        '<figure><figcaption><a id="c002--99" href="#rc02-fig-1">Figure 2.1</a> Chart caption</figcaption></figure>',
        '<aside><p><a id="c002--260" href="#rfn_2_abc">1</a> Endnote body text.</p></aside>',
        '</section>',
      ].join(''),
    },
  ];
  const entries = await epubExporter.buildEpubEntries({
    meta: { title: 'Paired Links Book', year: '2026' },
    items: pairedItems,
    domParser,
    xmlSerializer,
  });
  const byPath = new Map(entries.map((e) => [e.path, String(e.data)]));
  const ch = byPath.get('OEBPS/chapters/ch-0001.xhtml');
  assert.ok(ch.includes('href="#c002--260"'), ch);
  assert.ok(ch.includes('href="#c002--17"'), ch);
  assert.ok(ch.includes('href="#c002--99"'), ch);
  assert.ok(ch.includes('href="#c002--18"'), ch);
});

test('EPUB 3 preserves MathML, nested hierarchical TOC, landmarks, publisher/ISBN, and RTL metadata', async () => {
  const persianBody =
    '<p>این یک متن نمونه به زبان فارسی برای بررسی تشخیص خودکار زبان و جهت راست‌به‌چپ در خروجی کتاب است و شامل کلمات کافی فارسی می‌باشد.</p>';
  const items = [
    {
      index: 0,
      level: 0,
      title: 'Copyright',
      html: '<section class="copyright"><p>Published 2026 by O\'Reilly Media. ISBN: 978-1-098-12345-6.</p></section>',
    },
    {
      index: 1,
      level: 0,
      title: 'Chapter 1: Equations',
      html: `<h1>Equations</h1>${persianBody}<math display="block"><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow></math>`,
    },
    {
      index: 2,
      level: 1,
      title: '1.1 Sub-section',
      html: '<h2>Sub-section</h2><p>Nested level 1.</p>',
    },
    {
      index: 3,
      level: 2,
      title: '1.1.1 Deep section',
      html: '<h3>Deep</h3><p>Nested level 2.</p>',
    },
  ];

  const meta = domCleaner.enrichBookMetadata({ title: 'Physics Handbook' }, items, domParser);
  assert.equal(meta.isbn, '9781098123456');
  assert.equal(meta.publisher, "O'Reilly Media");
  assert.equal(meta.language, 'fa');
  assert.equal(meta.dir, 'rtl');

  const entries = await epubExporter.buildEpubEntries({
    meta,
    items,
    domParser,
    xmlSerializer,
  });

  const byPath = new Map(entries.map((e) => [e.path, String(e.data)]));
  const opf = byPath.get('OEBPS/content.opf');
  const nav = byPath.get('OEBPS/nav.xhtml');
  const ncx = byPath.get('OEBPS/toc.ncx');
  const ch2 = byPath.get('OEBPS/chapters/ch-0002.xhtml');

  assert.ok(opf.includes('<dc:publisher>O&#39;Reilly Media</dc:publisher>'), opf);
  assert.ok(opf.includes('<dc:identifier id="isbn-id">urn:isbn:9781098123456</dc:identifier>'), opf);
  assert.ok(opf.includes('<dc:language>fa</dc:language>'), opf);
  assert.ok(opf.includes('page-progression-direction="rtl"'), opf);
  assert.ok(opf.includes('id="ch-0002" href="chapters/ch-0002.xhtml" media-type="application/xhtml+xml" properties="mathml"'), opf);
  assert.ok(ch2.includes('xmlns="http://www.w3.org/1998/Math/MathML"'), ch2);
  assert.ok(ch2.includes('dir="rtl"'), ch2);
  assert.ok(nav.includes('epub:type="landmarks"'), nav);
  assert.ok(nav.includes('epub:type="bodymatter" href="chapters/ch-0002.xhtml"'), nav);
  assert.ok(ncx.includes('<meta name="dtb:depth" content="3"/>'), ncx);

  // Validate full EPUB ZIP XML strictness via Python ElementTree
  const zipBytes = await zipLib.createZipBytes(entries);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perlego-epub-v41-'));
  const epubPath = path.join(tmpDir, 'math-rtl.epub');
  fs.writeFileSync(epubPath, zipBytes);
  try {
    const pyOut = execFileSync(
      'python3',
      [
        '-c',
        `import sys, zipfile, xml.etree.ElementTree as ET
with zipfile.ZipFile(sys.argv[1]) as zf:
    for n in zf.namelist():
        if n.endswith(('.xml', '.opf', '.ncx', '.xhtml')):
            ET.fromstring(zf.read(n))
print('STRICT_OK')`,
        epubPath,
      ],
      { encoding: 'utf8' }
    );
    assert.ok(pyOut.includes('STRICT_OK'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fetchAssetsParallel retries transient failures, uses fallback URLs, provides lazy dataUrl, and respects AbortSignal', async () => {
  let primaryCalls = 0;
  let retryCalls = 0;
  const mockFetch = async (url) => {
    if (url === 'https://cdn.example.com/flaky.png') {
      retryCalls += 1;
      if (retryCalls === 1) {
        return { ok: false, status: 503, headers: new Headers() };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength),
      };
    }
    if (url === 'https://cdn.example.com/broken.jpg') {
      primaryCalls += 1;
      return { ok: false, status: 404, headers: new Headers() };
    }
    if (url === 'https://cdn.example.com/fallback.png') {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength),
      };
    }
    return { ok: false, status: 404, headers: new Headers() };
  };

  const assetMap = await domCleaner.fetchAssetsParallel(
    ['https://cdn.example.com/flaky.png', 'https://cdn.example.com/broken.jpg'],
    {
      concurrency: 2,
      retries: 1,
      fetchImpl: mockFetch,
      fallbackMap: {
        'https://cdn.example.com/broken.jpg': 'https://cdn.example.com/fallback.png',
      },
    }
  );

  assert.equal(retryCalls, 2);
  assert.ok(primaryCalls >= 1);
  assert.equal(assetMap.size, 2);
  const recovered = assetMap.get('https://cdn.example.com/broken.jpg');
  assert.equal(recovered.mime, 'image/png');
  assert.ok(recovered.dataUrl.startsWith('data:image/png;base64,'));

  // AbortSignal cancellation check
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => domCleaner.fetchAssetsParallel(['https://cdn.example.com/flaky.png'], { signal: ac.signal, fetchImpl: mockFetch }),
    (err) => err?.name === 'AbortError'
  );
  await assert.rejects(
    () => zipLib.createZipBytes([{ path: 'a.txt', data: 'hello' }], { signal: ac.signal }),
    (err) => err?.name === 'AbortError'
  );
});

test('Markdown exporter v4.1 handles enriched frontmatter, <dl>, captions, div separation, and internal links', async () => {
  const md = await markdownExporter.buildMarkdownDocument({
    meta: {
      title: 'Clean Guide',
      subtitle: 'Practical Patterns',
      author: 'Jane Doe',
      publisher: 'Tech Press',
      year: '2026',
      isbn: '9781234567890',
      language: 'en',
    },
    items: [
      {
        index: 0,
        level: 0,
        title: 'Overview',
        html: '<div>First block</div><div>Second block</div><p>Jump to <a href="#target_1">Section [2]</a> and press <kbd>Cmd+K</kbd> with <mark>highlight</mark>.</p>',
      },
      {
        index: 1,
        level: 1,
        title: 'Glossary',
        html: '<h2 id="ch2--1_target_1">Glossary</h2><dl><dt>EPUB</dt><dd>Electronic Publication format</dd></dl><table><caption>Summary Table</caption><tr><th>Key</th><th>Val</th></tr><tr><td>A</td><td>1</td></tr></table>',
      },
    ],
    domParser,
  });

  assert.ok(md.includes('subtitle: "Practical Patterns"'), md);
  assert.ok(md.includes('publisher: "Tech Press"'), md);
  assert.ok(md.includes('isbn: "9781234567890"'), md);
  assert.ok(md.includes('  - [Glossary](#section-2)'), md);
  assert.ok(md.includes('First block\n\nSecond block'), md);
  assert.ok(md.includes('[Section \\[2\\]](#section-2)'), md);
  assert.ok(md.includes('`Cmd+K`'), md);
  assert.ok(md.includes('==highlight=='), md);
  assert.ok(md.includes('**EPUB**\n: Electronic Publication format'), md);
  assert.ok(md.includes('**Summary Table**'), md);
});

test('HTML exporter v4.1 emits RTL attributes, enriched metadata, and dark-mode-toggle reader controls', async () => {
  const html = await htmlExporter.buildHtmlDocument({
    meta: {
      title: 'کتاب نمونه',
      subtitle: 'زیرعنوان',
      author: 'نویسنده',
      publisher: 'نشر نمونه',
      year: '2026',
      isbn: '9781234567890',
      language: 'fa',
      dir: 'rtl',
    },
    items: [
      { index: 0, level: 0, title: 'فصل اول', html: '<p>سلام دنیا</p>' },
      { index: 1, level: 1, title: 'بخش ۱.۱', html: '<p>ادامه متن</p>' },
    ],
    domParser,
  });

  assert.ok(html.includes('<html lang="fa" dir="rtl">'), html);
  assert.ok(html.includes(':root:has(> head > meta[name="color-scheme"][content="dark"])'), html);
  assert.ok(html.includes('id="pdThemeSelect"'), html);
  assert.ok(html.includes('id="pdPrintBtn"'), html);
  assert.ok(html.includes('class="pd-toc-lvl-1"'), html);
  assert.ok(html.includes('ISBN 9781234567890'), html);
});
