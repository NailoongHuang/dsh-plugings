# dsh-katex-toolkit

A single [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) client bundle that fixes
two long-standing problems with KaTeX-rendered math in the DSH Web UI:

1. **Copying math mangled it.** KaTeX renders every formula twice — a visible `.katex-html` arm and a
   hidden `.katex-mathml` arm kept for assistive technology. A plain `Ctrl+C` over a selection that
   contains a formula serialised *both* arms, so the clipboard got doubled, line-fragmented text.
2. **Every render re-parsed every formula.** The shipped markdown renderer calls
   `katex.renderToString(value, {...})` per render with no memo, so re-rendering a long message
   re-parsed all of its math on the main thread.

It replaces two earlier single-purpose bundles (`@local/dsh-formula-copy` and
`@local/dsh-katex-cache`) with one module, one patch row, and one activation.

## What it does

**Clean LaTeX copy.** A capturing `copy` listener rebuilds the clipboard from the TeX source and calls
`preventDefault()`, so the browser's own two-arm serialisation never runs. The TeX source is the
element's `data-tex` when a build still emits one, otherwise the
`<annotation encoding="application/x-tex">` node the shipped KaTeX emitter writes. The selection is
walked in document order rather than cloned, because selecting *part* of a formula — the natural
gesture, and the only way to copy from inside the visible arm — produces a fragment with no `.katex`
root. Selections without math are left entirely to the browser.

**Bounded render cache.** `katex.renderToString` is wrapped through the browser module table, so the
same instance the renderer calls is the one being wrapped — nothing inside `app.asar` is patched. The
key covers the source plus every option **encoded with its type**: an option explicitly set to `false`
is a different entry from an absent option (KaTeX's own default for `throwOnError` is *true*, so
sharing an entry would serve the strict fallback's HTML to a call that must have thrown), and `0`
cannot collide with `"0"`. Calls carrying object/function options (`macros`, `globalGroup`, …)
**bypass** the cache instead of being guessed at. Errors are never cached, so a throwing call keeps
throwing and the shipped runtime's strict retry stays a distinct entry. The cache is a bounded LRU,
2048 entries by default.

Nothing is patched on disk: the previous generation of these fixes edited hashed files inside
`app.asar`, which every app update silently discarded. A bundle survives updates.

## Install

This package is a DSH *bundle*: `package.json` declares `dsh.bundle.patch`, and `cordis.patch.yml`
inserts one row named `katex-toolkit`.

Install it from the **Plugins** panel (or a profile's `plugin_manager` / `install_bundle`), using the
**absolute path** of this directory as the spec — relative paths are rejected. The installer writes the
profile's `package.json`, patch layer and `node_modules` itself; do not hand-edit those.

```
Plugins panel → install spec: <absolute path to this directory>
```

Then hard-reload the page (`Ctrl+F5`); client modules are loaded per page.

## Configuration

The row's `config` is honoured when the Host forwards it; the defaults are used otherwise:

```yaml
- insert:
    - id: katex-toolkit
      name: '@local/dsh-katex-toolkit'
      config:
        copy: true          # install the clean-copy listener
        cache: true         # wrap katex.renderToString
        cacheLimit: 2048    # LRU capacity; must be a positive integer
```

The two features are independent: disabling one leaves the other fully active, and neither ever
changes the other's behaviour.

## Verify

Page console, after a hard reload:

```js
window.__dshKatexToolkit
// { id, version, features, copy, cache, disposed, dispose() }
```

* `features.copy.active` / `features.cache.active` — whether each feature is installed. When one is
  not, its `reason` says why; nothing is ever reported as active while doing nothing.
* `copy.skipped` — set when a copy event was seen but deliberately not rewritten
  (`selection has no formula`, `no clipboardData on the event`, …).
* `copy.lastText` — the last rebuilt clipboard text.
* `cache.hits` / `cache.misses` / `cache.size` — re-render a message and watch `hits` grow while
  `misses` stops.

The two original diagnostic names are kept as aliases for the older instructions:
`window.__dshFormulaCopy` and `window.__dshKatexCache` point at the same objects.

Manual copy check — all three must paste as **one** clean LaTeX source:

| Selection | Expected |
|---|---|
| Part of a formula (drag inside the visible glyphs) | that formula's TeX |
| Prose + inline formula + prose | the prose with the formula's TeX in place |
| A display formula | its TeX on its own line |

## Tests

```bash
node tests/toolkit.test.mjs   # 48 behavioural cases, no dependencies
node scripts/verify.mjs       # manifest ↔ patch ↔ client-module consistency
```

The tests run the real `client.js` against a small DOM shim over KaTeX's actual two-arm markup and a
fake module table that models the shipped call sites (including the `strict: 'ignore'` retry). They
cover, among other things, that a selection inside a formula is rewritten, that display math keeps its
own line, that `data-tex` wins over the annotation, that the LRU bound holds and evicts oldest-first,
that a throwing formula keeps throwing, that a frozen or missing `katex` export is reported rather
than faked, and that disposal restores the original `renderToString`.

## Migrating from the two older bundles

The merged bundle is a **replacement**: install it and remove `@local/dsh-formula-copy` and
`@local/dsh-katex-cache`, otherwise the old copy listener and the old cache wrapper stay active
alongside the new ones (duplicate wrapping still works, but the console hooks then report whichever
instance ran last).

In the Plugins panel: install this directory, then remove the two older bundles, then reload. The row
id `katex-toolkit` does not collide with any existing profile row, so installing first is safe.

## Layout

| Path | Role |
|---|---|
| `index.js` | Host half — empty by design; both features are page behaviour owned by the Client module |
| `client.js` | The Client module: both features, registered as one `@local/dsh-katex-toolkit` factory |
| `cordis.patch.yml` | Inserts the single `katex-toolkit` row |
| `locale/en.json`, `locale/zh.json` | Display title/description for the Plugins panel |
| `tests/toolkit.test.mjs` | Behavioural suite (Node, no dependencies) |
| `tests/dom-shim.mjs` | Minimal DOM/KaTeX stand-in used by the suite |
| `scripts/verify.mjs` | Structural checks: manifest, patch rows, module id, locale, row-id collisions |

## Compatibility

* Client-side only: works on the DSH Web UI and Desktop (both render through the same page bundle).
* Depends on nothing but the `katex` entry of the browser module table; if that entry is missing or
  frozen the cache stands down and says so, while the copy fix keeps working.
* Uninstall/reload returns the page to stock behaviour — the wrapper restores the original function.

## 中文速览

一个 DSH 客户端 bundle，把原来两个插件（`@local/dsh-formula-copy`、`@local/dsh-katex-cache`）合并成
一个，同时修两个问题：

- **复制公式变成两倍、断行碎片** —— KaTeX 每个公式渲染两层（可见的 `.katex-html` 与无障碍用的隐藏
  `.katex-mathml`），普通 `Ctrl+C` 会把两层都序列化。本插件在捕获阶段接管 `copy`，用 TeX 源码重建剪贴板
  并 `preventDefault()`；TeX 优先取 `data-tex`，回落 `annotation[encoding="application/x-tex"]`。按文档序
  遍历选区而不是克隆片段，所以**只选中公式一部分**也能正确改写。不含公式的选区完全不动。
- **长消息里每个公式都在重复解析** —— 通过浏览器模块表包装 `katex.renderToString`（不碰 `app.asar`），
  键包含所有影响输出的标量选项；带 `macros` 之类对象/函数选项的调用直接绕过缓存而不是猜；错误不缓存；
  有界 LRU，默认 2048。

安装：**Plugins 面板 → 安装 spec 填本目录的绝对路径**（相对路径会被拒）。然后 `Ctrl+F5`。
如果你之前装过上面那两个旧插件，**先安装本插件、再移除它们**（否则监听器与包装会各叠一层）。

验证（页面控制台）：`window.__dshKatexToolkit` → `features.copy.active` / `features.cache.active`；
`copy.skipped` 说明某次复制为什么没被改写；`cache.hits` 在重复渲染时增长而 `misses` 不再增长。
旧的 `window.__dshFormulaCopy` / `window.__dshKatexCache` 仍指向同一批对象。

自测：`node tests/toolkit.test.mjs`（48 例）、`node scripts/verify.mjs`（结构一致性）。

## License

MIT — see [LICENSE](LICENSE).
