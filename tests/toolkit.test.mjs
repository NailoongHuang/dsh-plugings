/**
 * Merged-artifact test for dsh-katex-toolkit/client.js.
 *
 * WHAT IS CHECKED, AND WHY. The merged bundle carries two features that used to be two plugins:
 *   1. clean LaTeX copy for a selection that contains math (a DOM rewrite, proven against the shim
 *      over KaTeX's real two-arm markup), and
 *   2. a bounded cache wrapping `katex.renderToString` in the browser module table (pure logic plus
 *      the interop/error-path traps that made v1 of the standalone cache silently useless).
 * On top of both, this file checks the properties only a MERGE can break: one module registration,
 * one copy listener, one wrapper depth, independent feature toggles, and disposal that restores the
 * original `renderToString`.
 *
 * Usage: node tests/toolkit.test.mjs   (exit 0 = every case as expected)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyEvent, el, fakeKatex, formula, makeDocument, makeRange, text } from './dom-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = '@local/dsh-katex-toolkit';
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

let failures = 0;
function check(name, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : '   [' + detail + ']'}`);
  if (!condition) failures++;
}

const newPage = () => ({ w: {}, document: makeDocument() });

/** Load client.js into a page, apply it, and keep the cleanup list. `page` may be reused to model a re-apply. */
function loadToolkit({ page = newPage(), moduleTable = {}, config, withRequire = true } = {}) {
  let entry = null;
  page.w.__ModuleLoader__ = { load: (registered) => { entry = registered; } };
  new Function('window', 'document', source)(page.w, page.document);
  if (!entry) throw new Error('client.js registered no module');
  const requireFn = withRequire
    ? (spec) => {
      if (!(spec in moduleTable)) throw new Error(`Cannot find module '${spec}'`);
      return moduleTable[spec];
    }
    : undefined;
  const api = entry.factory(requireFn);
  const cleanups = [];
  const ctx = { effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup; } };
  api.apply(ctx, config);
  return { ...page, entry, api, cleanup: () => { for (const fn of cleanups.splice(0).reverse()) fn(); } };
}

/** A page with only the copy feature, plus a selection built on it. */
function copyCase(build, select) {
  const page = newPage();
  loadToolkit({ page, config: { cache: false } });
  const root = build();
  const range = select(root);
  page.w.getSelection = () => ({ isCollapsed: false, rangeCount: 1, getRangeAt: () => range });
  return {
    page,
    root,
    range,
    report: () => page.w.__dshKatexToolkit?.copy,
    fire() {
      const { state, event } = copyEvent();
      page.document.dispatch('copy', event);
      return state;
    },
  };
}

// ---------------------------------------------------------------- A. one module, both features
console.log('\n# merge: one module, both features');
{
  const page = newPage();
  const { katex } = fakeKatex();
  const loaded = loadToolkit({ page, moduleTable: { katex } });
  const toolkit = page.w.__dshKatexToolkit;
  check('registers exactly one module, under the package name', loaded.entry.id === SPEC, String(loaded.entry.id));
  check('one load activates both features', toolkit?.features?.copy?.active === true && toolkit?.features?.cache?.active === true, JSON.stringify(toolkit?.features));
  check('the copy listener is registered exactly once', page.document.count('copy') === 1, `count=${page.document.count('copy')}`);
  check('legacy console hooks still point at the feature reports',
    page.w.__dshFormulaCopy === toolkit?.copy && page.w.__dshKatexCache === toolkit?.cache);
  toolkit?.dispose?.();
  check('dispose removes the copy listener and marks the report', page.document.count('copy') === 0 && toolkit?.disposed === true);
}
{
  const page = newPage();
  loadToolkit({ page });
  check('the cache reports a missing module instead of pretending', page.w.__dshKatexToolkit?.cache?.installed === false && /Cannot find module/.test(page.w.__dshKatexToolkit?.cache?.reason ?? ''), JSON.stringify(page.w.__dshKatexToolkit?.cache));
  check('…and that is not reported as an active feature', page.w.__dshKatexToolkit?.features?.cache?.active === false, JSON.stringify(page.w.__dshKatexToolkit?.features?.cache));
}
{
  const page = newPage();
  loadToolkit({ page, withRequire: false });
  check('a factory called without require() still installs the copy fix',
    page.w.__dshKatexToolkit?.features?.copy?.active === true && page.w.__dshKatexToolkit?.cache?.installed === false,
    JSON.stringify(page.w.__dshKatexToolkit?.features));
}

// ---------------------------------------------------------------- B. clean LaTeX copy
console.log('\n# copy: one clean TeX source per formula');
{
  const inline = formula('E=mc^2');
  const display = formula('S=\\ln\\Omega', { display: true });
  const displayVisible = display.querySelector('.katex-html').childNodes[0];
  const build = () => el('p', {}, text('Before '), inline, text(' after '), display);

  const inside = copyCase(build, (root) => {
    const arm = root.childNodes[1].querySelector('.katex-html').childNodes[0];
    return makeRange(root, arm, 1, arm, 3);
  });
  const insideState = inside.fire();
  check('a selection inside a formula is rewritten to its TeX', insideState.prevented && insideState.data === 'E=mc^2', JSON.stringify(insideState.data));
  check('…and the report says how', inside.report()?.lastLength === 6 && inside.report()?.mode === 'inside-formula', JSON.stringify(inside.report()));

  const across = copyCase(build, (root) => makeRange(root, root.childNodes[0], 0, root.childNodes[2], 6));
  check('text + inline formula keeps the surrounding text', across.fire().data === 'Before E=mc^2 after');

  const withDisplay = copyCase(build, (root) => makeRange(root, root.childNodes[0], 0, displayVisible, displayVisible.data.length));
  check('a display formula is emitted as TeX on its own line', withDisplay.fire().data === 'Before E=mc^2 after \nS=\\ln\\Omega\n', JSON.stringify(withDisplay.fire().data));

  const plain = copyCase(build, (root) => makeRange(root, root.childNodes[0], 0, root.childNodes[0], 6));
  const plainState = plain.fire();
  check('a selection with no formula is left to the browser', plainState.prevented === false && plainState.data === null);
  check('…and the reason is recorded', plain.report()?.skipped === 'selection has no formula', JSON.stringify(plain.report()));

  const legacy = formula('E=mc^2', { dataTex: 'E = mc^{2}' });
  const legacyCase = copyCase(() => el('p', {}, legacy), (root) => {
    const arm = root.childNodes[0].querySelector('.katex-html').childNodes[0];
    return makeRange(root, arm, 1, arm, 3);
  });
  check('data-tex wins over the annotation when the build emits it', legacyCase.fire().data === 'E = mc^{2}', JSON.stringify(legacyCase.fire().data));
}

// ---------------------------------------------------------------- C. bounded render cache
console.log('\n# cache: reuse, bound, interop, honest refusal');
{
  const { katex, state } = fakeKatex();
  const original = katex.renderToString;
  const page = newPage();
  loadToolkit({ page, moduleTable: { katex } });
  const toolkit = page.w.__dshKatexToolkit;
  check('installs onto the module-table entry', toolkit?.cache?.installed === true, JSON.stringify(toolkit?.cache));
  check('the default cap is 2048', toolkit?.cache?.limit === 2048, String(toolkit?.cache?.limit));
  katex.renderToString('E=mc^2', { displayMode: false, throwOnError: true });
  katex.renderToString('E=mc^2', { displayMode: false, throwOnError: true });
  katex.renderToString('E=mc^2', { displayMode: true, throwOnError: true });
  check('repeats of one formula parse once', state.calls === 2, `real renders=${state.calls}`);
  check('hits and misses are counted', toolkit?.cache?.hits === 1 && toolkit?.cache?.misses === 2, JSON.stringify({ hits: toolkit?.cache?.hits, misses: toolkit?.cache?.misses }));
  check('display and inline are different entries', toolkit?.cache?.size === 2, `size=${toolkit?.cache?.size}`);
  check('…and the wrapper is on the call path', katex.renderToString !== original);
  toolkit?.dispose?.();
  check('disposal restores the original renderToString', katex.renderToString === original);
}
{
  const { katex } = fakeKatex();
  const page = newPage();
  loadToolkit({ page, moduleTable: { katex: { default: katex } } });
  katex.renderToString('x^2', { displayMode: false });
  check('a namespace-shaped table entry ({default: katex}) still installs', page.w.__dshKatexToolkit?.cache?.installed === true, JSON.stringify(page.w.__dshKatexToolkit?.cache));
  check('…and it records which shape it took', page.w.__dshKatexToolkit?.cache?.katexShape === 'namespace.default', String(page.w.__dshKatexToolkit?.cache?.katexShape));
}
{
  const { katex } = fakeKatex();
  loadToolkit({ page: newPage(), moduleTable: { katex } });
  let firstThrew = false;
  try { katex.renderToString('BAD', { displayMode: false, throwOnError: true }); } catch { firstThrew = true; }
  const fallback = katex.renderToString('BAD', { displayMode: false, throwOnError: false });
  let secondThrew = false;
  try { katex.renderToString('BAD', { displayMode: false, throwOnError: true }); } catch { secondThrew = true; }
  check('a formula that throws under throwOnError keeps throwing', firstThrew && secondThrew, `first=${firstThrew} second=${secondThrew}`);
  check('…while the strict fallback is cached separately', fallback.includes('|F|'), fallback);
}
{
  const { katex } = fakeKatex();
  const page = newPage();
  loadToolkit({ page, moduleTable: { katex }, config: { cacheLimit: 64 } });
  const toolkit = page.w.__dshKatexToolkit;
  for (let i = 0; i < 70; i++) katex.renderToString('f' + i, { displayMode: false });
  check('the configured cap holds', toolkit?.cache?.size === 64 && toolkit?.cache?.limit === 64, JSON.stringify({ size: toolkit?.cache?.size, limit: toolkit?.cache?.limit }));
  const before = toolkit?.cache?.misses ?? 0;
  katex.renderToString('f0', { displayMode: false });
  check('the oldest entry was evicted (LRU)', toolkit?.cache?.misses === before + 1, `misses ${before} -> ${toolkit?.cache?.misses}`);
  const recent = toolkit?.cache?.misses ?? 0;
  katex.renderToString('f69', { displayMode: false });
  check('the newest entry is still a hit', toolkit?.cache?.misses === recent, `misses ${recent} -> ${toolkit?.cache?.misses}`);
}
{
  const { katex } = fakeKatex();
  Object.freeze(katex);
  const page = newPage();
  loadToolkit({ page, moduleTable: { katex } });
  check('a frozen export is reported, not faked', page.w.__dshKatexToolkit?.cache?.installed === false && /frozen|did not take|failed/i.test(page.w.__dshKatexToolkit?.cache?.reason ?? ''), JSON.stringify(page.w.__dshKatexToolkit?.cache));
  check('…and the copy feature still works from the same bundle', page.w.__dshKatexToolkit?.features?.copy?.active === true);
}

// ---------------------------------------------------------------- D. merge guarantees
console.log('\n# merge: toggles, re-apply, no double work');
{
  const page = newPage();
  const { katex } = fakeKatex();
  loadToolkit({ page, moduleTable: { katex }, config: { copy: false } });
  check('copy can be switched off without touching the cache', page.w.__dshKatexToolkit?.features?.copy?.active === false && page.w.__dshKatexToolkit?.features?.cache?.active === true, JSON.stringify(page.w.__dshKatexToolkit?.features));
  check('…and no copy listener is registered then', page.document.count('copy') === 0, `count=${page.document.count('copy')}`);
  check('…and the reason is explicit', page.w.__dshKatexToolkit?.features?.copy?.reason === 'disabled by config', String(page.w.__dshKatexToolkit?.features?.copy?.reason));
}
{
  const { katex } = fakeKatex();
  const page = newPage();
  loadToolkit({ page, moduleTable: { katex } });
  const firstReport = page.w.__dshKatexToolkit;
  loadToolkit({ page, moduleTable: { katex } });
  const secondReport = page.w.__dshKatexToolkit;
  check('re-applying the module disposes the previous instance', firstReport?.disposed === true && secondReport !== firstReport);
  check('…so exactly one copy listener survives', page.document.count('copy') === 1, `count=${page.document.count('copy')}`);
  check('…and katex is wrapped exactly once', katex.renderToString.__dshToolkitDepth === 1, `depth=${katex.renderToString.__dshToolkitDepth}`);
}

// ---------------------------------------------------------------- E. cache entries that must not be shared
// A cache whose key ignores an option serves one call's output to another call whose output or
// throw behaviour differs. `throwOnError` is the sharp edge: KaTeX defaults it to TRUE, so
// `throwOnError: false` (the shipped strict retry) and an absent option are NOT the same call.
console.log('\n# cache: entries that must not be shared');
{
  const { katex } = fakeKatex();
  loadToolkit({ page: newPage(), moduleTable: { katex } });
  const fallback = katex.renderToString('BAD', { displayMode: false, throwOnError: false });
  check('the strict fallback is produced and cached', fallback.includes('|F|'), fallback);
  let threw = false;
  try { katex.renderToString('BAD', { displayMode: false }); } catch { threw = true; }
  check("a call relying on KaTeX's default throwOnError still throws", threw, 'the fallback was served to a call that must have thrown');
}
{
  const { katex, state } = fakeKatex();
  loadToolkit({ page: newPage(), moduleTable: { katex } });
  katex.renderToString('x', { displayMode: false, trust: false });
  katex.renderToString('x', { displayMode: false });
  check('an option explicitly false is not conflated with the option being absent', state.calls === 2, `real renders=${state.calls}`);
}
{
  const { katex, state } = fakeKatex();
  loadToolkit({ page: newPage(), moduleTable: { katex } });
  katex.renderToString('x', { displayMode: false, maxSize: 0 });
  katex.renderToString('x', { displayMode: false, maxSize: '0' });
  check('a number and its string form are different entries', state.calls === 2, `real renders=${state.calls}`);
}
{
  const { katex, state } = fakeKatex();
  loadToolkit({ page: newPage(), moduleTable: { katex } });
  katex.renderToString('x', { displayMode: false, strict: 'ignore' });
  katex.renderToString('x', { displayMode: false, strict: 'warn' });
  check('different scalar values are different entries', state.calls === 2, `real renders=${state.calls}`);
}
{
  const { katex, state } = fakeKatex();
  loadToolkit({ page: newPage(), moduleTable: { katex } });
  katex.renderToString('x', { displayMode: false, macros: { '\\R': '\\mathbb{R}' } });
  katex.renderToString('x', { displayMode: false, macros: { '\\R': '\\mathbb{Z}' } });
  check('object options are never cached (no guessing)', state.calls === 2, `real renders=${state.calls}`);
}
{
  const { katex, state } = fakeKatex();
  loadToolkit({ page: newPage(), moduleTable: { katex } });
  katex.renderToString('x', { displayMode: false, throwOnError: true });
  katex.renderToString('x', { displayMode: false, throwOnError: true });
  check('identical calls still hit, so the fix does not disable caching', state.calls === 1, `real renders=${state.calls}`);
}

// ---------------------------------------------------------------- F. copy edges
console.log('\n# copy: partial selections, no cloning, no leakage');
{
  const inline = formula('E=mc^2');
  const build = () => el('p', {}, text('Before '), inline, text(' after '));
  const partial = copyCase(build, (root) => {
    const arm = root.childNodes[1].querySelector('.katex-html').childNodes[0];
    return makeRange(root, root.childNodes[0], 3, arm, 2);
  });
  check('a formula partially selected is emitted whole, and its tail does not leak',
    partial.fire().data === 'ore E=mc^2', JSON.stringify(partial.fire().data));
}
{
  const inline = formula('E=mc^2');
  const build = () => el('p', {}, text('Before '), inline, text(' after '));
  const fromInside = copyCase(build, (root) => {
    const arm = root.childNodes[1].querySelector('.katex-html').childNodes[0];
    return makeRange(root, arm, 1, root.childNodes[2], 4);
  });
  check('a selection running from inside a formula into prose keeps both, and the prose before it does not leak',
    fromInside.fire().data === 'E=mc^2 aft', JSON.stringify(fromInside.fire().data));
}
{
  const inline = formula('E=mc^2');
  const build = () => el('p', {}, text('Before '), inline, text(' after '));
  const noClone = copyCase(build, (root) => {
    const arm = root.childNodes[1].querySelector('.katex-html').childNodes[0];
    return makeRange(root, arm, 1, arm, 3);
  });
  let clones = 0;
  const original = noClone.range.cloneContents.bind(noClone.range);
  noClone.range.cloneContents = () => { clones += 1; return original(); };
  const state = noClone.fire();
  check('the copy path never clones the selection', clones === 0, `cloneContents calls=${clones}`);
  check('…and still rewrote the clipboard', state.data === 'E=mc^2' && state.prevented, JSON.stringify(state.data));
}

console.log(`\n${failures === 0 ? 'all cases as expected' : failures + ' case(s) failed'}`);
process.exit(failures === 0 ? 0 : 1);
