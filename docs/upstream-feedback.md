# 反馈稿：DSH 网页端 KaTeX 集成的两个问题

用途：直接复制到 **DeepSeek Harness 自带反馈入口**。
下面三个版本按需取用：**① 短版**（表单字数有限时用）→ **② 完整版**（表单允许长文，或后续被追问细节时用）→ **③ 英文版**（备）。
所有技术结论都在本机 `resources\app.asar` 内逐文件核对过，证据在完整版里。

---

## ① 短版（约 900 字，适合表单）

**标题：网页端两处 KaTeX 集成问题——复制含公式的文本会重复断行；渲染函数每次重渲染都重新解析**

正文：

我在 DSH 桌面版 **0.2.0-rc.2**（Windows，Web 客户端）上遇到两个可稳定复现的问题，都只需要几行客户端代码就能修掉。我在本地用纯客户端插件绕开了它们（不修改 `app.asar`），如果对你们有用可以提供；但根因在客户端本身。

**问题一：复制含公式的选区，粘贴出来是双份、断行的乱文本。**

原因：每个公式被输出成两层 DOM —— 隐藏的无障碍层 `.katex-mathml`（内含 `<annotation encoding="application/x-tex">` 的 TeX 源码）与可见层 `.katex-html`（`aria-hidden="true"`）。客户端既没有 `copy` 处理器，也没有限制隐藏层的选中行为，浏览器默认序列化会把两层一起复制。

复现：任意消息里选中一个公式（或含公式的一段话）→ `Ctrl+C` → 粘贴，得到 MathML 源码与可见字形的混杂，公式出现两次。

最小修法（任一即可）：

1. 加一行 CSS：`.katex-mathml, .katex-mathml * { user-select: none; -webkit-user-select: none; }`
2. 加一个捕获阶段的 `copy` 处理器，用注解里的 TeX 重建 `text/plain`；
3. 打包 KaTeX 官方的 `copy-tex` 扩展。

注意：出货包**不发** `data-tex` 属性（全包 0 命中），所以只能从注解节点读 TeX。

**问题二：`katex.renderToString` 没有记忆化，每次重渲染都会重新解析该消息里的所有公式。**

出货代码在 `@deepseek-ai/dsh-client-ui-primitives` 的 `renderTexToReact` 里：先用 `{ displayMode, throwOnError: true }` 调一次，失败再用 `{ displayMode, strict: "ignore", throwOnError: false }` 调一次。整个函数没有缓存，长会话里逐键输入与滚动的延迟随公式数量增长。

建议：按调用结果记忆化。两点提醒 ——

- 键必须覆盖**所有**选项（KaTeX 按属性查找读选项，所以"显式 `false`"与"没写这个选项"不是同一次调用）；
- 上面两种调用形态**不能共用缓存条目**：一个在畸形公式上抛错，另一个返回回退 HTML。键若把假值折叠掉，就会把"本该抛错"变成"静默成功"（我第一版实现正是这么错的，后来靠测试才发现）。

**另有一条文档建议**：markdown 管线只识别 `$...$` 与 `$$...$$`；从文档里粘 `\(...\)` / `\[...\]` 会被转义搞坏，`$$` 块还必须写成一行。用户很容易踩，建议在文档里注明（或在解析前做一次分隔符归一化）。

附：我做的客户端插件 `dsh-katex-toolkit`（MIT，不碰 `app.asar`，56 条行为测试）——
<https://github.com/NailoongHuang/dsh-plugings>

---

## ② 完整版（含证据与验证方法）

**标题：网页端两处 KaTeX 集成问题：复制含公式文本会重复断行；`katex.renderToString` 无记忆化**

### 环境

- DSH Desktop **0.2.0-rc.2**，Windows。
- Web 客户端 bundle 位于 `resources\app.asar` 内：
  `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/*`（含 KaTeX 发射端，文件名带内容哈希）
  与 `dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js`（渲染调用点）。
- 下面每条结论都是从这两个文件里读出来的，复现命令见文末。

### 问题一：复制含公式的选区 → 双份、断行

**复现**：任意含公式的消息里，选中一个公式内部一小段（或整段含公式的正文）→ `Ctrl+C` → 粘贴。

**观察**：剪贴板里公式出现两次，且被换行切碎；纯文本部分正常。

**根因**：与官方 KaTeX 一致，每个公式输出两条臂：

- 隐藏无障碍臂：class `katex-mathml`，内含 `<annotation encoding="application/x-tex">` 的 TeX 源；
- 可见臂：class `katex-html`，带 `aria-hidden="true"`。

客户端没有 `copy` 处理器，也没有对隐藏臂做选中限制，浏览器默认序列化会把两条臂都写进剪贴板。
出货发射端原文（`dsh-web-frontend/dist/assets/vendor-*.js`）：

```js
var o = new F("annotation", [new Se(t)]);
o.setAttribute("encoding", "application/x-tex");
// ...
var m = a ? "katex" : "katex-mathml";                        // 隐藏臂
B(["katex-html"], i).setAttribute("aria-hidden", "true");    // 可见臂
```

补充一个写修复时会踩的点：出货包**不输出 `data-tex`**（整包 0 命中），只能读注解节点。

**建议修法（任一）**：

1. 一行 CSS：`.katex-mathml, .katex-mathml * { user-select: none; -webkit-user-select: none; }`
2. 捕获阶段 `copy` 处理器：把选区序列化成纯文本时，遇到 `.katex`/`.katex-display` 就换成注解里的 TeX
   （注意：选区只落在公式内部一部分时，克隆出来的片段**没有** `.katex` 根节点，按克隆片段判断会漏判 ——
   建议按文档序遍历实时 DOM，并保留块级换行）；
3. 打包 KaTeX 官方 `copy-tex` 扩展。

### 问题二：`renderTexToReact` 无缓存

出货原文（`@deepseek-ai/dsh-client-ui-primitives/lib/index.js`）：

```js
function renderTexToReact(value, displayMode) {
  let html;
  try {
    html = katex.renderToString(value, { displayMode, throwOnError: true });
  } catch (error) {
    try {
      html = katex.renderToString(value, { displayMode, strict: "ignore", throwOnError: false });
    } catch { /* 返回 katex-error span */ }
  }
  // ...
}
```

没有记忆化 ⇒ 每次重渲染（长会话里逐键输入、滚动、流式追加）都对该消息里**每个**公式重新走一遍 KaTeX 解析，
全部在主线程上。我在这台机器上的长会话里，逐键延迟随消息内公式数量增长。

**建议**：对调用结果做有界 LRU 记忆化。两条从实现里得到的经验：

- 键必须包含**每一个**选项及其类型。KaTeX 是按属性查找读选项的，默认值也在 KaTeX 内部，
  所以 `{throwOnError: false}` 与"没有 `throwOnError`"是**不同**的调用（后者默认 `true`）；
  同时 `0` 与 `"0"`、`false` 与 `"false"` 不能撞键。对象/函数类选项（`macros`、`globalGroup` 等）
  建议直接绕过缓存而不是猜。
- 上面两种调用形态必须分开缓存：`{throwOnError:true}` 在畸形公式上抛错，
  `{strict:"ignore", throwOnError:false}` 返回回退 HTML。键若折叠假值，就会把后者的结果喂给前者，
  让"本该抛错"变成"静默成功"。

### 文档/UX 建议（次要）

markdown 管线只识别 `$...$`（行内）与 `$$...$$`（块级），且 `$$` 块必须写在**一行**源码里；
LaTeX 文档常用的 `\(...\)` / `\[...\]` 不被识别，还会被 markdown 转义破坏。用户从论文/笔记里
粘公式时几乎必然踩到。建议在文档中显著说明，或在解析前做一次分隔符归一化（把 `\(`→`$`、`\[`→`$$`）。

### 我做的绕行方案（供参考，MIT）

`dsh-katex-toolkit`：一个纯客户端 bundle（`dsh.client`，宿主半部为空，一行 patch），不修改 `app.asar`，
因此跟随版本升级不会被覆盖。

- 干净复制：捕获阶段 `copy`，按文档序遍历选区，公式替换为注解里的 TeX，保留块级换行，不含公式的选区不动；
- 有界渲染缓存：通过浏览器模块表包装 `katex.renderToString`，键按「选项名 + 类型 + 值」编码，
  对象/函数选项绕过，错误不缓存，默认上限 2048；
- `copy` / `cache` / `cacheLimit` 可配置，诊断字段诚实（`installed` + `reason`），可幂等卸载；
- 56 条行为测试（`node tests/toolkit.test.mjs`），覆盖上面提到的两种调用形态、错误路径、LRU 边界、
  以及"选区只落在公式内部"这类退化 DOM。

仓库：<https://github.com/NailoongHuang/dsh-plugings>

### 验证方法

`app.asar` 是普通归档，任何 asar 解包器都可读，无需启动应用：

1. 解出 `dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js`，
   搜 `renderToString` 即可看到上面两种调用形态；
2. 在 `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/` 里搜
   `application/x-tex`、`katex-mathml`、`katex-html`、`data-tex`，可复核发射端与"不发 `data-tex`"这一条。

---

## ③ 英文版（备）

**Title: Two KaTeX integration issues in the DSH web client — duplicated math on copy, and no memo around `katex.renderToString`**

On DSH Desktop 0.2.0-rc.2 (Windows) I hit two reproducible problems, both fixable client-side in a few
lines. I work around them locally with a client-only bundle (no `app.asar` patching); the right fix is
upstream.

**1. Copying a selection that contains math yields doubled, line-fragmented text.** Every formula is
emitted as two arms — a hidden a11y arm (`.katex-mathml`, carrying the TeX source in
`<annotation encoding="application/x-tex">`) and a visible arm (`.katex-html`, `aria-hidden="true"`).
There is no `copy` handler and no `user-select` rule on the hidden arm, so the browser serialises both.
Minimal fixes, any one: add `.katex-mathml, .katex-mathml * { user-select: none; -webkit-user-select: none; }`;
add a capture-phase `copy` listener that rebuilds `text/plain` from the annotation; or ship KaTeX's
`copy-tex`. Note the shipped build emits **no** `data-tex` attribute (0 hits), so the annotation is the
only source.

**2. `renderTexToReact` memoises nothing**, so every re-render re-parses every formula in the message.
Shipped code: `katex.renderToString(value, { displayMode, throwOnError: true })`, and on failure
`katex.renderToString(value, { displayMode, strict: "ignore", throwOnError: false })`. Two cautions if
you memoise: the key must cover **every** option (an explicit `false` is a different call from an absent
option — KaTeX defaults `throwOnError` to `true`), and those two call shapes must not share an entry
(one throws on malformed input, the other returns fallback HTML).

**Minor docs item:** the markdown pipeline accepts only `$...$` and `$$...$$`; `\(...\)` / `\[...\]` are
not recognised and get mangled, and a `$$` block must be on one source line.

My workaround, if useful: `dsh-katex-toolkit` (MIT, client-only, 56 tests) —
<https://github.com/NailoongHuang/dsh-plugings>
