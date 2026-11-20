const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function decodeEntities(str) {
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&amp;/g, '&');
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeText(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

class ShimNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  appendChild(node) {
    if (!node) return node;
    if (node.nodeType === 11) {
      for (const ch of node.childNodes.slice()) {
        this.appendChild(ch);
      }
      node.childNodes = [];
      return node;
    }
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node) {
    const idx = this.childNodes.indexOf(node);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      node.parentNode = null;
    }
    return node;
  }

  replaceChild(newNode, oldNode) {
    const idx = this.childNodes.indexOf(oldNode);
    if (idx === -1) return oldNode;
    if (newNode.nodeType === 11) {
      const list = newNode.childNodes.slice();
      newNode.childNodes = [];
      for (const item of list) item.parentNode = this;
      this.childNodes.splice(idx, 1, ...list);
    } else {
      if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
      newNode.parentNode = this;
      this.childNodes.splice(idx, 1, newNode);
    }
    oldNode.parentNode = null;
    return oldNode;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  replaceWith(replacement) {
    if (!this.parentNode) return;
    this.parentNode.replaceChild(replacement, this);
  }
}

class ShimText extends ShimNode {
  constructor(value) {
    super(3);
    this.nodeValue = String(value ?? '');
  }

  get textContent() {
    return this.nodeValue;
  }
}

class ShimFragment extends ShimNode {
  constructor() {
    super(11);
  }
}

class ShimElement extends ShimNode {
  constructor(tagName, namespaceURI = null) {
    super(1);
    this.tagName = String(tagName);
    this.localName = this.tagName.toLowerCase();
    this.namespaceURI = namespaceURI;
    this._attrs = new Map();
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get attributes() {
    return Array.from(this._attrs.entries()).map(([name, value]) => ({ name, value }));
  }

  getAttribute(name) {
    const key = String(name);
    if (this._attrs.has(key)) return this._attrs.get(key);
    const lower = key.toLowerCase();
    for (const [k, v] of this._attrs.entries()) {
      if (k.toLowerCase() === lower) return v;
    }
    return null;
  }

  setAttribute(name, value) {
    this._attrs.set(String(name), String(value));
  }

  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }

  removeAttribute(name) {
    const lower = String(name).toLowerCase();
    for (const k of Array.from(this._attrs.keys())) {
      if (k.toLowerCase() === lower) this._attrs.delete(k);
    }
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent || '').join('');
  }

  set textContent(val) {
    this.childNodes = [];
    if (val !== '' && val !== null && val !== undefined) {
      this.appendChild(new ShimText(val));
    }
  }

  get innerHTML() {
    return this.childNodes.map((c) => serializeHtmlNode(c)).join('');
  }

  querySelectorAll(selector) {
    const groups = splitSelectors(selector);
    const matches = [];
    const seen = new Set();

    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          if (groups.some((g) => matchesChain(child, g)) && !seen.has(child)) {
            seen.add(child);
            matches.push(child);
          }
          walk(child);
        }
      }
    };
    walk(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getElementsByTagName(name) {
    const target = String(name).toLowerCase();
    const out = [];
    const walk = (node) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 1) {
          if (target === '*' || ch.localName === target) out.push(ch);
          walk(ch);
        }
      }
    };
    walk(this);
    return out;
  }
}

function splitSelectors(selector) {
  const parts = [];
  let current = '';
  let inBracket = false;
  let quote = '';
  for (const ch of String(selector)) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '[') {
      inBracket = true;
      current += ch;
    } else if (ch === ']') {
      inBracket = false;
      current += ch;
    } else if (ch === ',' && !inBracket) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function matchesSimple(el, sel) {
  let rem = sel.trim();
  if (!rem) return false;

  const tagMatch = rem.match(/^([a-zA-Z0-9_-]+)/);
  if (tagMatch) {
    if (el.localName !== tagMatch[1].toLowerCase()) return false;
    rem = rem.slice(tagMatch[0].length);
  }

  while (rem.length > 0) {
    if (rem.startsWith('#')) {
      const m = rem.match(/^#([a-zA-Z0-9_-]+)/);
      if (!m) return false;
      if (el.getAttribute('id') !== m[1]) return false;
      rem = rem.slice(m[0].length);
    } else if (rem.startsWith('.')) {
      const m = rem.match(/^\.([a-zA-Z0-9_-]+)/);
      if (!m) return false;
      const cls = (el.getAttribute('class') || '').split(/\s+/);
      if (!cls.includes(m[1])) return false;
      rem = rem.slice(m[0].length);
    } else if (rem.startsWith('[')) {
      const end = rem.indexOf(']');
      if (end === -1) return false;
      const expr = rem.slice(1, end);
      rem = rem.slice(end + 1);
      const attrMatch = expr.match(/^([a-zA-Z0-9_-]+)(?:([*^$]?=)["']?([^"']*)["']?)?$/);
      if (!attrMatch) return false;
      const [, attrName, op, expected] = attrMatch;
      const actual = el.getAttribute(attrName);
      if (actual === null) return false;
      if (op === '=' && actual !== expected) return false;
      if (op === '*=' && !actual.includes(expected)) return false;
      if (op === '^=' && !actual.startsWith(expected)) return false;
      if (op === '$=' && !actual.endsWith(expected)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function matchesChain(el, chain) {
  const parts = chain.trim().split(/\s+/);
  if (!matchesSimple(el, parts[parts.length - 1])) return false;
  let cur = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (cur && cur.nodeType === 1) {
      if (matchesSimple(cur, parts[i])) {
        found = true;
        cur = cur.parentNode;
        break;
      }
      cur = cur.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

function serializeHtmlNode(node) {
  if (node.nodeType === 3) return escapeText(node.nodeValue);
  if (node.nodeType !== 1) return '';
  const tag = node.localName;
  const attrs = node.attributes
    .map((a) => ` ${a.name}="${escapeAttr(a.value)}"`)
    .join('');
  if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
  const inner = node.childNodes.map(serializeHtmlNode).join('');
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

function serializeXmlNode(node, parentNs = null) {
  if (node.nodeType === 3) return escapeText(node.nodeValue);
  if (node.nodeType !== 1) return '';
  const tag = node.tagName;
  const parts = [];
  if (node.namespaceURI && node.namespaceURI !== parentNs) {
    parts.push(` xmlns="${escapeAttr(node.namespaceURI)}"`);
  }
  for (const a of node.attributes) {
    parts.push(` ${a.name}="${escapeAttr(a.value)}"`);
  }
  if (node.childNodes.length === 0) {
    return `<${tag}${parts.join('')} />`;
  }
  const inner = node.childNodes.map((c) => serializeXmlNode(c, node.namespaceURI || parentNs)).join('');
  return `<${tag}${parts.join('')}>${inner}</${tag}>`;
}

function parseAttributes(rawAttrs) {
  const attrs = [];
  const regex = /([a-zA-Z_:][a-zA-Z0-9._:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = regex.exec(rawAttrs)) !== null) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs.push([name, decodeEntities(value)]);
  }
  return attrs;
}

function parseMarkup(markup, isXml) {
  const doc = new ShimDocument();
  const root = new ShimElement(isXml ? 'root' : 'document');
  const stack = [root];
  const tokenRegex = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^<>]*?)?)(\/?)>/gi;

  let lastIndex = 0;
  let match;
  while ((match = tokenRegex.exec(markup)) !== null) {
    if (match.index > lastIndex) {
      const text = decodeEntities(markup.slice(lastIndex, match.index));
      stack[stack.length - 1].appendChild(new ShimText(text));
    }
    lastIndex = tokenRegex.lastIndex;

    const full = match[0];
    if (full.startsWith('<!--') || full.startsWith('<?') || full.startsWith('<!')) {
      continue;
    }

    const isClose = full.startsWith('</');
    const tagName = match[1];
    const lowerTag = tagName.toLowerCase();
    const rawAttrs = match[2] || '';
    const selfClose = match[3] === '/' || (!isXml && VOID_TAGS.has(lowerTag));

    if (isClose) {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].localName === lowerTag) {
          stack.length = i;
          break;
        }
      }
    } else {
      const el = new ShimElement(isXml ? tagName : lowerTag);
      for (const [k, v] of parseAttributes(rawAttrs)) {
        if (k === 'xmlns') el.namespaceURI = v;
        else el.setAttribute(k, v);
      }
      if (!el.namespaceURI && stack[stack.length - 1].namespaceURI) {
        el.namespaceURI = stack[stack.length - 1].namespaceURI;
      }
      stack[stack.length - 1].appendChild(el);
      if (!selfClose) {
        stack.push(el);
      }
    }
  }

  if (lastIndex < markup.length) {
    const tail = decodeEntities(markup.slice(lastIndex));
    stack[stack.length - 1].appendChild(new ShimText(tail));
  }

  if (isXml) {
    const docEl = root.children[0] || new ShimElement('html', 'http://www.w3.org/1999/xhtml');
    doc.documentElement = docEl;
    doc.childNodes = [docEl];
  } else {
    const htmlEl = root.querySelector('html') || new ShimElement('html');
    const bodyEl = root.querySelector('body') || htmlEl;
    if (!root.querySelector('body')) {
      for (const ch of root.childNodes.slice()) {
        bodyEl.appendChild(ch);
      }
    }
    doc.documentElement = htmlEl;
    doc.body = bodyEl;
  }

  return doc;
}

export class ShimDocument {
  constructor() {
    this.documentElement = null;
    this.body = null;
    this.childNodes = [];
    this.title = '';
  }

  createElement(tag) {
    return new ShimElement(String(tag).toLowerCase());
  }

  createElementNS(ns, tag) {
    return new ShimElement(tag, ns);
  }

  createTextNode(text) {
    return new ShimText(text);
  }

  createDocumentFragment() {
    return new ShimFragment();
  }

  querySelector(selector) {
    return (this.documentElement || this.body)?.querySelector(selector) || null;
  }

  querySelectorAll(selector) {
    return (this.documentElement || this.body)?.querySelectorAll(selector) || [];
  }

  getElementsByTagName(name) {
    const target = String(name).toLowerCase();
    const out = [];
    const root = this.documentElement || this.body;
    if (!root) return out;
    if (target === '*' || root.localName === target) out.push(root);
    return out.concat(root.getElementsByTagName(name));
  }
}

export class ShimDOMParser {
  parseFromString(str, type) {
    if (type === 'application/xml' || type === 'text/xml' || type === 'application/xhtml+xml') {
      return parseMarkup(String(str || ''), true);
    }
    return parseMarkup(String(str || ''), false);
  }
}

export class ShimXMLSerializer {
  serializeToString(docOrNode) {
    const root = docOrNode?.documentElement || docOrNode;
    return serializeXmlNode(root, null);
  }
}
