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
 * visible arm - produces a fragment with no `.katex` root.
 *
 * FEATURE 2 - bounded render cache. The shipped renderer calls `katex.renderToString(value, {...})`
 * per render with no memo, so re-rendering a message re-parses every formula in it. The browser
 * module table resolves the same specifier the renderer uses, so `require('katex')` yields the very
 * instance whose `renderToString` is on the call path; wrapping it needs nothing patched inside
 * app.asar. The cache is keyed on the source plus every scalar option that changes the output, and
 * REFUSES calls carrying object/function options (`macros`, `globalGroup`, ...) instead of guessing.
 * Errors are never cached, so a throwing call stays a throwing call and the strict retry of the
 * shipped runtime stays a separate entry. Bounded LRU, cap 2048 by default.
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
  const VERSION = 3;
  const DEFAULTS = { copy: true, cache: true, cacheLimit: 2048 };
  const ANNOTATION = 'annotation[encoding="application/x-tex"]';
  const MATH = '.katex-display, .katex';

  /** LaTeX source of one formula element: `data-tex` first, then the MathML annotation. */
  function texOf(element) {
    const direct = element.getAttribute && element.getAttribute('data-tex');
    if (direct) return direct;
    const annotation = element.querySelector(ANNOTATION);
    return annotation ? annotation.textContent : null;
  }

  function elementOf(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement || null;
  }

  function isDisplay(element) {
    return Boolean(element.closest && element.closest('.katex-display'));
  }

  function emit(element, out) {
    const tex = texOf(element);
    const value = tex === null ? element.textContent : tex;
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

  /** Document-order text of `range`, with every formula the range touches replaced by its TeX. */
  function serialize(range, out = []) {
    const root = elementOf(range.commonAncestorContainer);
    if (!root) return out.join('');
    const intersects = (node) => {
      try {
        return range.intersectsNode(node);
      } catch {
        return true;
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
        emit(node, out);
        return;
      }
      for (const child of node.childNodes) walk(child);
    };
    walk(root);
    return out.join('');
  }

  function rebuild(range) {
    const single = formulaFor(range);
    if (single) {
      const out = [];
      emit(single, out);
      return out.join('');
    }
    return serialize(range);
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
      const probe = range.cloneContents();
      const hasMath =
        formulaFor(range) !== null ||
        Boolean(probe && probe.querySelector && probe.querySelector(MATH)) ||
        Boolean(probe && probe.querySelector && probe.querySelector(ANNOTATION));
      if (!hasMath) return record({ skipped: 'selection has no formula' });
      if (!event.clipboardData) return record({ skipped: 'no clipboardData on the event' });
      let text;
      try {
        text = rebuild(range);
      } catch (error) {
        return record({ skipped: 'rebuild threw: ' + (error && error.message) });
      }
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

  /** Key of a cacheable call, or null when the call must bypass the cache to stay exact. */
  function keyOf(tex, options) {
    if (typeof tex !== 'string') return null;
    const parts = [];
    let display = false;
    if (options && typeof options === 'object') {
      for (const name of Object.keys(options)) {
        const value = options[name];
        if (value === undefined || value === null || value === false || value === '') continue;
        const type = typeof value;
        if (type === 'object' || type === 'function') return null; // macros/globalGroup/... change output
        if (name === 'displayMode') {
          display = value === true;
          continue;
        }
        parts.push(name + '=' + String(value));
      }
    }
    parts.sort();
    return (display ? 'D\u0000' : 'I\u0000') + parts.join('\u0001') + '\u0000' + tex;
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
      cacheLimit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULTS.cacheLimit,
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
