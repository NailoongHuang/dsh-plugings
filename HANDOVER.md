# 交接单：手动安装 `@local/dsh-katex-toolkit`

> 面向操作者。读完这一页就能独立完成安装、验收与回滚，不需要再问我。
> 生成时间：2026-10-02 15:40（Asia/Shanghai）｜对应提交 `242d08d`

## 0. 现在这台机器处于什么状态

| | 状态 |
|---|---|
| 合并版 `@local/dsh-katex-toolkit` | **已写好、已推送，但还没安装**（profile 里没有它，`profiles/desktop/node_modules` 下也没有） |
| 旧 `@local/dsh-formula-copy` | **仍在装**（`dependencies` 里 `link:` + `dsh.profile.bundles` 一行） |
| 旧 `@local/dsh-katex-cache` | **仍在装**（同上） |
| 因此此刻生效的 | 仍是那两个旧插件，各自一份 copy 监听器 / 一份 cache 包装 |

## 1. 要装的东西

| 项 | 值 |
|---|---|
| 安装 spec | `C:\Users\xuanm\Desktop\dsh-setting\dsh-katex-toolkit`（**必须是绝对路径**，相对路径会被拒） |
| 包名 | `@local/dsh-katex-toolkit` |
| patch 行 id | `katex-toolkit` |
| 版本 | 包 `1.0.0`，客户端模块 `VERSION = 3` |
| 提供 | ① 复制含公式选区得到单份干净 LaTeX ② `katex.renderToString` 的有界渲染缓存 |

## 2. 安装步骤（GUI Plugins 面板，按顺序）

1. 左侧 **Plugins** 面板 → 安装新 bundle，spec 填上面的绝对路径。
   行 id `katex-toolkit` 已核对过，与现有 profile 的既有行**不冲突**。
2. **先确认新插件已启用**，再移除这两个：`@local/dsh-formula-copy`、`@local/dsh-katex-cache`。
   顺序有意义：先装新的再删旧的，中间不会出现数学渲染空窗。
3. `Ctrl+F5` 硬刷新页面（客户端模块是按页面加载的）。
4. 若面板提示需要重启应用，就重启。只装新 bundle 通常 HMR 即可；替换**已存在**的包才需要重启。

## 3. 装完立刻验收（4 步）

**① 控制台（F12）**

```js
window.__dshKatexToolkit
```

期望（关键字段）：

```js
{
  id: '@local/dsh-katex-toolkit',
  version: 3,
  features: { copy:  { enabled: true, active: true, reason: null },
              cache: { enabled: true, active: true, reason: null } },
  copy:  { installed: true, rewrites: 0, skipped: null, ... },
  cache: { installed: true, reason: null, limit: 2048,
           katexShape: 'module' | 'namespace.default', wrappedDepth: 1, ... },
  disposed: false
}
```

旧钩子必须仍指向同一批对象（两个都应为 `true`）：

```js
window.__dshFormulaCopy === window.__dshKatexToolkit.copy
window.__dshKatexCache  === window.__dshKatexToolkit.cache
```

**② 复制三个样例** —— 都必须粘贴成**单份**干净 LaTeX，display 公式独占一行：

| 选区 | 期望 |
|---|---|
| 拖选公式**内部**一部分（可见字形里） | 该公式的完整 TeX |
| 散文 + 行内公式 + 散文 | 散文，公式位置是 TeX |
| 整段 display 公式 | TeX 独占一行 |

每复制一次，看 `window.__dshKatexToolkit.copy` 的 `lastText` / `mode`（`inside-formula` 或 `range`）/ `rewrites` 是否变化。

**③ 反例**：复制**不含公式**的普通文字 → 行为与以前完全一致；
此时 `copy.skipped === 'selection has no formula'`（这是正常的"不处理"，不是故障）。

**④ 缓存**：打开一条**含公式的长消息**，滚动/重新展开让它重渲染，观察
`window.__dshKatexToolkit.cache.hits` 增长而 `misses` 基本不再增长。

## 4. 失败症状 → 原因 → 处置

| 症状 | 可能原因 | 处置 |
|---|---|---|
| 控制台**没有** `window.__dshKatexToolkit` | 客户端模块没被加载：bundle 未启用 / 没硬刷新 / 行未插入 | 面板确认 bundle 已启用 → `Ctrl+F5` → 仍无：把插件详情截图 + 控制台报错给我。**这是整个交付里唯一没有实机验证过的环节**（`inject: []` + `immediately: true` 是否被 loader 接受） |
| `features.cache.active === false`，`cache.reason` 有文字 | 模块表里没有 `katex`，或该导出被冻结/不可写 | 把 `cache.reason` 原文发我。**功能 ① 仍然可用**，这不是全局故障 |
| `features.copy.active === true` 但粘贴没变化 | 选区里没有 `.katex`（正常），或 copy 事件被上游 handler 抢先 | 看 `copy.skipped`：`selection has no formula` 属正常；若 `lastText` 有值而粘贴仍是双份 → 事件被别的 handler 消费，报我 |
| 粘贴还是两倍 / 断行 | 插件没生效 | 回到第 1 行排查 |
| `cache.hits` 一直 0 | 消息没有重渲染，或插件没生效 | 换一条长消息滚动/重新展开 |
| 出现两层监听 / 两层包装 | 两个旧 bundle 没删干净 | 面板移除旧的两个 + `Ctrl+F5`。合并版只会 dispose **自己**的上一个实例，管不到别的模块 |

## 5. 回滚

Plugins 面板 remove `@local/dsh-katex-toolkit` → `Ctrl+F5`。
页面回到原生行为：`dispose()` 只在仍持有该 wrapper 时还原 `renderToString`，copy 监听器被移除。
两个旧的 `link:` bundle 目录仍在原处，需要时可重新安装。

## 6. 已知边界（交接必须说清，别当成已验证）

- 合并版**从未在真实页面运行过**。现有证据是：48 条行为用例（`node tests/toolkit.test.mjs`，exit 0）、
  结构一致性校验（`node scripts/verify.mjs`）、以及对着出货包复核过选择器
  （`app.asar` 内 `vendor-CCJJTK99.js` 仍发 `annotation` + `encoding="application/x-tex"` + `katex-mathml` 臂）。
- `inject: []` + `immediately: true` 只有**契约级**证据（官方插件模板的 `dsh.client` 形状；
  `inject` 的语义是"依赖的客户端模块"），没有实机加载证据。
- 运行实例 `http://127.0.0.1:19387` 需要鉴权（返回 401），所以我没能读取启动载荷做交叉验证。
- 上一轮的对抗性独立审查子代理**退出了但没回传结果**，那次审查是我自己做的，**不构成独立复核**。
  不过其中修复的缺陷都有"先失败后通过"的复现记录，见提交 `242d08d`。

## 7. 位置与证据

| 项 | 值 |
|---|---|
| 本地目录 | `C:\Users\xuanm\Desktop\dsh-setting\dsh-katex-toolkit` |
| GitHub | <https://github.com/NailoongHuang/dsh-plugings> |
| 当前提交 | `242d08d`（本地与远端一致） |
| 自测 | `node tests/toolkit.test.mjs` → 48 例全过；`node scripts/verify.mjs` → structure OK |
| 打包清单 | `npm pack --dry-run` → 8 个文件 / 10.8 KB：`index.js`、`client.js`、`cordis.patch.yml`、`package.json`、`locale/en.json`、`locale/zh.json`、`README.md`、`LICENSE` |

## 8. 装完之后的善后（可选）

- 三份 `SUPERSEDED.md` 已就位并指向合并版，防止以后误装旧件：
  `_migration\bundles\dsh-formula-copy\`、`_migration\bundles\dsh-katex-cache\`、
  `_migration\pending\formula-copy-plugin\`（最后一个是从未安装过的 v1 草稿）。
- 确认 profile 的 `dependencies` 与 `dsh.profile.bundles` 里**已经没有**那两个旧包之后，
  这两个 `_migration\bundles\dsh-*` 目录才可以删（它们目前是 `link:` 的目标，删早了会让 profile 解析失败）。
- 验收完成后回我一句结果即可：控制台里 `window.__dshKatexToolkit` 的 `features` 部分，
  以及三个复制样例是否都干净。若 `features.cache.active === false`，把 `cache.reason` 一并发我。
