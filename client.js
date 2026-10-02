/**
 * DSH client plugin - KaTeX Toolkit (merged).
 *
 * One Client module carrying the two features that used to be two separate plugins
 * (`@local/dsh-formula-copy` and `@local/dsh-katex-cache`). Merging them is not cosmetic: both
 * features were pure page behaviour with an empty Host half and a one-row patch, so two bundles
 * meant two module registrations, two patch rows and two install/verify cycles for no separation
 * of concerns. Here one registration installs two independently disposable mechanisms.
 *
 * FEATURE 1 - clean LaTeX copy. KaTeX renders every formula twice: a visible `.katex-html` arm and
 * a hidden `.katex-mathml` arm kept for assistive technology. A plain Ctrl+C over a selection that
 * contains a formula serialises BOTH arms, so the clipboard ends up doubled and line-fragmented.
 * A capturing `copy` listener rebuilds the clipboard from the TeX source and calls preventDefault(),
 * so the browser's own serialisation never runs. The TeX source is the element's `data-tex` when a
 * build still emits one, else the `<annotation encoding="application/x-tex">` node the shipped
 * KaTeX emitter does write. The selection is walked in document order rather than cloned, because
 * selecting part of a formula - the natural gesture, and the only way to copy from inside the
 * visible arm - produces a fragment with no `.katex` root. The rebuild is a single pass over the live
 * DOM: nothing is cloned, and the pass itself reports whether it met a formula, so the decision to
 * take over the clipboard needs no separate probe.
 *
 * FEATURE 2 - bounded render cache. The shipped renderer calls `katex.renderToString(value, {...})`
 * per render with no memo, so re-rendering a message re-parses every formula in it. The browser
 * module table resolves the same specifier the renderer uses, so `require('katex')` yields the very
 * instance whose `renderToString` is on the call path; wrapping it needs nothing patched inside
 * app.asar. The cache is keyed on the source plus every option, each encoded with its type: an
 * option explicitly set to `false` is NOT the same call as an absent option (KaTeX's own default for
 * `throwOnError` is true), and `0` cannot collide with `"0"`. Calls carrying object/function options
 * (`macros`, `globalGroup`, ...) are REFUSED rather than guessed at. Errors are never cached, so a
 * throwing call stays a throwing call and the strict retry of the shipped runtime stays a separate
 * entry. Bounded LRU, cap 2048 by default.
 *
 * Diagnostics (page console), kept under their original names so the earlier verification
 * instructions still work:
 *   window.__dshKatexToolkit = { id, version, features, copy, cache, disposed, dispose() }
 *   window.__dshFormulaCopy  = copy    // same object: { installed, mode, lastLength, lastText, at, skipped }
 *   window.__dshKatexCache   = cache   // same object: { installed, reason, hits, misses, size, limit, ... }
 * Every stand-down is recorded with a reason instead of failing silently: `cache.reason` when the
 * wrapper cannot be installed, `copy.skipped` when a copy was seen but not rewritten.
 *
 * Config (row `config:` forwarded by the Host; defaults apply when it is absent):
 *   { copy: true, cache: true, cacheLimit: 2048 }
 * The same switches are available at runtime as `window.__dshKatexToolkit.dispose()` (full teardown).
 */

(function () {
  const SPEC = '@local/dsh-katex-toolkit';
  const VERSION = 4;
  const DEFAULTS = { copy: true, cache: true, cacheLimit: 2048 };
  const ANNOTATION = 'annotation[encoding="application/x-tex"]';
  const MATH = '.katex-display, .katex';
  /** Elements whose boundary is a paragraph/line break when a selection is serialised. */
  const BLOCK = /^(?:ARTICLE|BLOCKQUOTE|DIV|H1|H2|H3|H4|H5|H6|HR|LI|OL|P|PRE|SECTION|TABLE|TR|UL)$/;

  /** LaTeX source of one formula element: `data-tex` first, then the MathML annotation. */
  function texOf(element) {
    const direct = element.getAttribute && element.getAttribute('data-tex');
    if (direct && direct.trim()) return direct.trim();
    const annotation = element.querySelector(ANNOTATION);
    const tex = annotation && annotation.textContent ? annotation.textContent.trim() : '';
    return tex || null; // an empty annotation is no source at all, not an empty formula
  }

  function elementOf(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement || null;
  }

  function isDisplay(element) {
    return Boolean(element.closest && element.closest('.katex-display'));
  }

  /**
   * When no TeX source exists at all, copy what the user can actually SEE (the visible arm) rather
   * than the element's whole text, which would append the hidden arm and reintroduce the doubling
   * this feature exists to remove.
   */
  function visibleText(element) {
    const visible = element.querySelector('.katex-html');
    return visible ? visible.textContent : element.textContent;
  }

  function emit(element, out) {
    const tex = texOf(element);
    const value = tex === null ? visibleText(element) : tex;
    out.push(isDisplay(element) ? '\n' + value + '\n' : value);
  }

  /** The one formula a selection sits inside, when the whole selection is inside a single formula. */
  function formulaFor(range) {
    const from = elementOf(range.startContainer);
    const to = elementOf(range.endContainer);
    const start = from && from.closest ? from.closest(MATH) : null;
    const end = to && to.closest ? to.closest(MATH) : null;
    return start && start === end ? start : null;
  }

  /**
   * Document-order text of `range`, with every formula the range touches replaced by its TeX.
   * `state.sawMath` records whether a formula was actually met, which is what decides whether this
   * copy is ours at all - no cloned fragment is needed to answer that question.
   */
  function serialize(range, state, out = []) {
    const root = elementOf(range.commonAncestorContainer);
    if (!root) return out.join('');
    const intersects = (node) => {
      if (typeof range.intersectsNode === 'function') {
        try {
          return range.intersectsNode(node);
        } catch {
          /* fall through to the boundary comparison */
        }
      }
      // Fallback when Range.intersectsNode is missing or throws: a node intersects unless it starts
      // after the range ends or ends before it starts. Answering `true` unconditionally would glue
      // text from OUTSIDE the selection onto the clipboard.
      try {
        const last = node.nodeType === 3 ? node.data.length : node.childNodes.length;
        return range.comparePoint(node, 0) !== 1 && range.comparePoint(node, last) !== -1;
      } catch {
        return true; // nothing left to compare with; the text slices still respect the boundaries
      }
    };
    const walk = (node) => {
      if (node.nodeType === 3) {
        if (!intersects(node)) return;
        const from = node === range.startContainer ? range.startOffset : 0;
        const to = node === range.endContainer ? range.endOffset : node.data.length;
        if (to > from) out.push(node.data.slice(from, to));
        return;
      }
      if (node.nodeType !== 1 || !intersects(node)) return;
      if (node.matches && node.matches(MATH)) {
        state.sawMath = true;
        emit(node, out);
        return;
      }
      if (node.tagName === 'BR') {
        out.push('\n');
        return;
      }
      // Block boundaries become paragraph breaks. Without them a multi-paragraph selection that
      // contains one formula is pasted as a single run-on line - and preventDefault() has already
      // suppressed the browser's own, correct, serialisation.
      const block = BLOCK.test(node.tagName || '');
      if (block) out.push('\n');
      for (const child of node.childNodes) walk(child);
      if (block) out.push('\n');
    };
    walk(root);
    return out.join('');
  }

  /** Tidy rebuilt text: block breaks survive, but never as leading/trailing noise. */
  function finish(text) {
    return text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
  }

  /** Rebuilt clipboard text for `range`; `state.sawMath` reports whether any formula was touched. */
  function rebuild(range, state) {
    const single = formulaFor(range);
    if (single) {
      state.sawMath = true;
      const out = [];
      emit(single, out);
      return finish(out.join(''));
    }
    return finish(serialize(range, state));
  }

  /**
   * Install the capturing copy listener.
   * @returns cleanup that removes it.
   */
  function installCopy(report) {
    const record = (patch) => {
      report.installed = true;
      for (const key of Object.keys(patch)) report[key] = patch[key];
    };
    const onCopy = (event) => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return record({ skipped: 'no selection' });
      }
      let range;
      try {
        range = selection.getRangeAt(0);
      } catch {
        return record({ skipped: 'no range' });
      }
      const math = { sawMath: false };
      let text;
      try {
        text = rebuild(range, math);
      } catch (error) {
        return record({ skipped: 'rebuild threw: ' + (error && error.message) });
      }
      if (!math.sawMath) return record({ skipped: 'selection has no formula' });
      if (!event.clipboardData) return record({ skipped: 'no clipboardData on the event' });
      if (typeof text !== 'string' || text.length === 0) return record({ skipped: 'rebuild produced nothing' });
      event.preventDefault();
      event.clipboardData.setData('text/plain', text);
      record({
        mode: formulaFor(range) ? 'inside-formula' : 'range',
        lastLength: text.length,
        lastText: text.slice(0, 200),
        at: Date.now(),
        rewrites: (report.rewrites || 0) + 1,
        skipped: null,
      });
    };
    document.addEventListener('copy', onCopy, true);
    report.installed = true;
    return () => document.removeEventListener('copy', onCopy, true);
  }

  /**
   * Key of a cacheable call, or null when the call must bypass the cache to stay exact.
   *
   * Every own option is encoded WITH ITS TYPE. Two rules earn their keep:
   *   - An option explicitly set to `false` (or `null`, or `''`) is not the same call as an absent
   *     option: KaTeX merges the caller's object over its defaults, so `{throwOnError:false}` forces
   *     the non-throwing path while an absent `throwOnError` uses KaTeX's default of TRUE. Sharing an
   *     entry between them would serve the strict fallback's HTML to a call that must have thrown -
   *     the exact class of bug this cache previously had.
   *   - The type tag keeps `0` apart from `"0"` and `false` from `"false"`.
   * `undefined` is the one value that is genuinely indistinguishable from the key being absent.
   */
  function keyOf(tex, options) {
    if (typeof tex !== 'string') return null;
    const parts = [];
    if (options && typeof options === 'object') {
      const seen = new Set();
      // KaTeX reads options by property lookup, so an INHERITED option still changes the output and
      // belongs in the key. Object.prototype itself is skipped, so a polluted global object cannot
      // make every call uncacheable.
      for (let bag = options; bag && bag !== Object.prototype; bag = Object.getPrototypeOf(bag)) {
        for (const name of Object.keys(bag)) {
          if (seen.has(name)) continue;
          seen.add(name);
          const value = bag[name];
          if (value === undefined) continue;
          const type = typeof value;
          if (type === 'object' || type === 'function') return null; // macros/globalGroup/... change the output
          // JSON keeps the separator unforgeable: a value containing the join character is escaped.
          parts.push(JSON.stringify([name, type, String(value)]));
        }
      }
    }
    parts.sort();
    return parts.join('\u0001') + '\u0000' + tex;
  }

  /**
   * Wrap `katex.renderToString` with a bounded cache.
   * @returns cleanup that restores the original function (only if this wrapper is still installed).
   */
  function installCache(require, report, limit) {
    if (typeof require !== 'function') {
      report.reason = 'the Client factory received no require(), so the module table is unreachable';
      return () => {};
    }
    let mod = null;
    try {
      mod = require('katex');
    } catch (error) {
      report.reason = 'require("katex") failed: ' + (error && error.message);
    }
    const direct = mod && typeof mod.renderToString === 'function' ? mod : null;
    const namespaced = direct ? null : mod && mod.default && typeof mod.default.renderToString === 'function' ? mod.default : null;
    const katex = direct || namespaced;
    if (!katex) {
      if (!report.reason) report.reason = 'neither require("katex") nor its .default exposes renderToString';
      return () => {};
    }
    report.katexShape = direct ? 'module' : 'namespace.default';

    const original = katex.renderToString;
    const cache = new Map();
    const patched = function renderToStringCached(tex, options) {
      const key = keyOf(tex, options);
      if (key === null) {
        report.uncacheable++;
        return original.call(this, tex, options);
      }
      if (cache.has(key)) {
        const hit = cache.get(key);
        cache.delete(key); // re-insert: Map iteration order is the LRU order
        cache.set(key, hit);
        report.hits++;
        return hit;
      }
      const out = original.call(this, tex, options); // a throwing call never reaches the set below
      cache.set(key, out);
      if (cache.size > limit) cache.delete(cache.keys().next().value);
      report.misses++;
      report.size = cache.size;
      return out;
    };
    patched.__dshToolkitWrapped = true;
    patched.__dshToolkitDepth = ((original && original.__dshToolkitDepth) || 0) + 1;

    try {
      katex.renderToString = patched;
    } catch (error) {
      report.reason = 'assigning katex.renderToString failed: ' + (error && error.message);
    }
    report.installed = katex.renderToString === patched;
    report.wrappedDepth = patched.__dshToolkitDepth;
    if (!report.installed && !report.reason) report.reason = 'assignment did not take (frozen module export?)';
    report.size = cache.size;
    return () => {
      if (katex.renderToString === patched) katex.renderToString = original;
    };
  }

  function normalizeConfig(config) {
    const source = config && typeof config === 'object' ? config : {};
    const limit = Number(source.cacheLimit);
    return {
      copy: source.copy !== false,
      cache: source.cache !== false,
      // A positive but fractional capacity would floor to 0, i.e. a cache that evicts every entry
      // immediately while still reporting itself installed - so require a whole number.
      cacheLimit: Number.isInteger(limit) && limit > 0 ? limit : DEFAULTS.cacheLimit,
    };
  }

  window.__ModuleLoader__.load({
    id: SPEC,
    factory(require) {
      return {
        inject: [],
        apply(ctx, config) {
          const options = normalizeConfig(config);

          // A re-apply (HMR, or the module loaded twice) must leave exactly ONE active instance:
          // dispose the previous one first. Its own teardown is idempotent and only restores state
          // it still owns, so this cannot clobber the instance being installed.
          const previous = window.__dshKatexToolkit;
          if (previous && typeof previous.dispose === 'function' && !previous.disposed) {
            try {
              previous.dispose();
            } catch {
              /* the stale instance is being replaced either way */
            }
          }

          const copy = {
            installed: false, version: VERSION, rewrites: 0, mode: null,
            lastLength: null, lastText: null, at: null, skipped: null,
          };
          const cache = {
            installed: false, reason: null, hits: 0, misses: 0, uncacheable: 0,
            size: 0, limit: options.cacheLimit, katexShape: null, wrappedDepth: 0,
          };
          const features = {
            copy: { enabled: options.copy, active: false, reason: options.copy ? null : 'disabled by config' },
            cache: { enabled: options.cache, active: false, reason: options.cache ? null : 'disabled by config' },
          };
          const disposers = [];
          const toolkit = {
            id: SPEC,
            version: VERSION,
            features,
            copy,
            cache,
            disposed: false,
            dispose() {
              if (toolkit.disposed) return;
              toolkit.disposed = true;
              for (const cleanup of disposers.splice(0).reverse()) {
                try {
                  cleanup();
                } catch {
                  /* one failing teardown must not strand the others */
                }
              }
              features.copy.active = false;
              features.cache.active = false;
              // The legacy hook objects stay reachable after teardown, so they must not keep
              // claiming to be installed once the listener and the wrapper are gone.
              copy.installed = false;
              cache.installed = false;
            },
          };
          window.__dshKatexToolkit = toolkit;
          window.__dshFormulaCopy = copy;
          window.__dshKatexCache = cache;

          const effect = (fn) => {
            const run = () => {
              const cleanup = fn();
              return typeof cleanup === 'function' ? cleanup : () => {};
            };
            if (ctx && typeof ctx.effect === 'function') {
              ctx.effect(() => {
                const cleanup = run();
                disposers.push(cleanup);
                return cleanup;
              });
            } else {
              disposers.push(run());
            }
          };

          if (options.copy) {
            effect(() => {
              const cleanup = installCopy(copy);
              features.copy.active = true;
              features.copy.reason = null;
              return cleanup;
            });
          }
          if (options.cache) {
            effect(() => {
              const cleanup = installCache(require, cache, options.cacheLimit);
              features.cache.active = cache.installed;
              features.cache.reason = cache.installed ? null : cache.reason;
              return cleanup;
            });
          }
        },
      };
    },
  });
})();
