/**
 * Minimal DOM used by the toolkit tests.
 *
 * WHY A SHIM AND NOT jsdom: no DOM implementation is installed on this machine, and the two
 * behaviours under test are DOM *semantics* — KaTeX's two-arm markup, `Range.intersectsNode`,
 * `Range.cloneContents` built from the lowest common ancestor, and `closest`/`matches`. The shim
 * models exactly those, over KaTeX's real markup shape, so the assertions are the strings and the
 * node counts a user would see.
 */
export class TextNode {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
    this.parentElement = null;
  }
  get textContent() {
    return this.data;
  }
  get childNodes() {
    return [];
  }
}

export class Element {
  constructor(tag, attrs = {}, children = []) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.childNodes = children;
    for (const child of children) child.parentElement = this;
  }
  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }
  get classList() {
    const names = String(this.attrs.class ?? '').split(/\s+/).filter(Boolean);
    return { contains: (name) => names.includes(name) };
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  setAttribute(name, value) {
    this.attrs[name] = value;
  }
  matches(selector) {
    return selector.split(',').some((part) => matchesSimple(this, part.trim()));
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.nodeType === 1 && node.matches(selector)) return node;
    }
    return null;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      for (const child of node.childNodes ?? []) {
        if (child.nodeType !== 1) continue;
        if (child.matches(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
}

function matchesSimple(el, selector) {
  if (!el || el.nodeType !== 1) return false;
  const attr = /^([a-zA-Z-]+)?\[([\w-]+)="([^"]*)"\]$/.exec(selector);
  if (attr) {
    if (attr[1] && el.tagName !== attr[1].toUpperCase()) return false;
    return el.attrs[attr[2]] === attr[3];
  }
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  return el.tagName === selector.toUpperCase();
}

export const text = (data) => new TextNode(data);
export const el = (tag, attrs, ...children) => new Element(tag, attrs, children);

/**
 * KaTeX's shipped shape: a hidden mathml arm carrying the TeX annotation, plus a visible html arm.
 * `dataTex` adds the legacy `data-tex` attribute some builds used to emit.
 */
export function formula(tex, { display = false, dataTex = null } = {}) {
  const visible = tex.replace(/[\\{}^_]/g, '');
  const attrs = { class: 'katex' };
  if (dataTex) attrs['data-tex'] = dataTex;
  const katex = el('span', attrs,
    el('span', { class: 'katex-mathml' }, el('annotation', { encoding: 'application/x-tex' }, text(tex))),
    el('span', { class: 'katex-html', 'aria-hidden': 'true' }, text(visible)));
  return display ? el('span', { class: 'katex-display' }, katex) : katex;
}

function offsets(root) {
  const map = new Map();
  let at = 0;
  const walk = (node) => {
    const start = at;
    if (node.nodeType === 3) at += node.data.length;
    else for (const child of node.childNodes) walk(child);
    map.set(node, [start, at]);
  };
  walk(root);
  return map;
}

/** A Range that models the properties the copy fix depends on. */
export function makeRange(root, startNode, startOffset, endNode, endOffset) {
  const off = offsets(root);
  const selStart = off.get(startNode)[0] + startOffset;
  const selEnd = off.get(endNode)[0] + endOffset;
  const chain = (node) => {
    const out = [];
    for (let x = node; x; x = x.parentElement) out.push(x);
    return out;
  };
  const endChain = new Set(chain(endNode));
  const common = chain(startNode).find((node) => endChain.has(node)) ?? root;
  return {
    startContainer: startNode,
    startOffset,
    endContainer: endNode,
    endOffset,
    commonAncestorContainer: common,
    intersectsNode(node) {
      const span = off.get(node);
      if (!span) return false;
      return span[0] < selEnd && span[1] > selStart;
    },
    comparePoint(node, offset) {
      const span = off.get(node);
      if (!span) return 0;
      const at = span[0] + offset;
      if (at < selStart) return -1;
      if (at > selEnd) return 1;
      return 0;
    },
    cloneContents() {
      const holder = new Element('div', {});
      const attach = (children) => {
        holder.childNodes = children;
        for (const child of holder.childNodes) child.parentElement = holder;
        return holder;
      };
      if (common.nodeType === 3) return attach([new TextNode(common.data.slice(startOffset, endOffset))]);
      const fullyInside = (node) => {
        const span = off.get(node);
        return span[0] >= selStart && span[1] <= selEnd;
      };
      const intersects = (node) => {
        const span = off.get(node);
        return span[0] < selEnd && span[1] > selStart;
      };
      const deep = (node) => {
        if (node.nodeType === 3) return new TextNode(node.data);
        const copy = new Element(node.tagName.toLowerCase(), { ...node.attrs });
        copy.childNodes = node.childNodes.map(deep);
        for (const child of copy.childNodes) child.parentElement = copy;
        return copy;
      };
      const clip = (node) => {
        if (node.nodeType === 3) {
          const base = off.get(node)[0];
          return new TextNode(node.data.slice(Math.max(0, selStart - base), Math.min(node.data.length, selEnd - base)));
        }
        if (fullyInside(node)) return deep(node);
        const copy = new Element(node.tagName.toLowerCase(), { ...node.attrs });
        copy.childNodes = node.childNodes
          .filter(intersects)
          .map(clip)
          .filter((child) => child.nodeType === 1 || child.data.length > 0);
        for (const child of copy.childNodes) child.parentElement = copy;
        return copy;
      };
      return attach(common.childNodes.filter(intersects).map(clip));
    },
  };
}

/** A document that records listeners, so "exactly one copy listener" is observable. */
export function makeDocument() {
  const handlers = new Map();
  return {
    body: new Element('body', {}),
    createElement: (tag) => new Element(tag, {}),
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      handlers.get(type)?.delete(fn);
    },
    count(type) {
      return handlers.get(type)?.size ?? 0;
    },
    dispatch(type, event) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn(event);
    },
  };
}

/** One Ctrl+C: records what the handler wrote and whether it cancelled the browser default. */
export function copyEvent() {
  const state = { data: null, prevented: false };
  return {
    state,
    event: {
      clipboardData: { setData: (_type, value) => { state.data = value; } },
      preventDefault: () => { state.prevented = true; },
    },
  };
}

/** A KaTeX stand-in that models the shipped call sites, including the strict retry. */
export function fakeKatex() {
  const state = { calls: 0 };
  const katex = {
    renderToString(tex, options = {}) {
      state.calls++;
      // KaTeX's own default for throwOnError is TRUE, so an absent option must behave like true.
      // Modelling that is what makes a cache that conflates `throwOnError:false` with no option
      // option at all visible as the bug it is.
      const throwOnError = options.throwOnError === undefined ? true : Boolean(options.throwOnError);
      if (throwOnError && tex.includes('BAD')) throw new Error('KaTeX parse error: BAD');
      return `<${tex}|${options.displayMode ? 'D' : 'I'}|${throwOnError ? 'T' : 'F'}|${options.strict ?? '-'}>`;
    },
  };
  return { katex, state };
}
