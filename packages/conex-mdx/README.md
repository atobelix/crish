# `@conex/mdx`

Conex Markdown 块编辑器（Doc schema v2）— **W10 迁移脚手架**。

> **现状**：包内仅有**类型契约 + stub API**。  
> **真实运行时**仍在 reference vanilla IIFE：  
> `reference/chat-composer-component/js/markdown-editor/*`  
> 完整端口迁移前，宿主演示/功能开发请继续挂 reference；本包用于类型预挂与分模块迁入，降低后续重写成本。

规格锚点：

- [feature-catalog/08-package-modules.md](../../reference/chat-composer-component/docs/markdown-editor/feature-catalog/08-package-modules.md)
- [MIGRATION.md](./MIGRATION.md)（阶段 A–F）
- [ARCHITECTURE.md](./ARCHITECTURE.md)（模块所有权）

---

## 安装（monorepo）

根 `package.json` 的 `workspaces` 为**显式列表**。接入本包：

```jsonc
// package.json（仓库根）
{
  "workspaces": [
    // …existing
    "packages/conex-mdx"
  ]
}
```

然后：

```bash
npm install
```

宿主 `apps/crish-desktop`（或其它 app）依赖：

```json
{
  "dependencies": {
    "@conex/mdx": "*"
  }
}
```

未写入 workspaces 时可用相对路径仅 import type：

```ts
import type { Doc, MountOptions, AiPort } from '../../../packages/conex-mdx/src/index.ts';
```

---

## 宿主如何挂载（目标 API）

```ts
import { mount, type MountOptions, type MarkdownEditorHandle } from '@conex/mdx';
// 目标态样式（阶段 C 后）：
// import '@conex/mdx/style.css';

const el = document.getElementById('editor')!;

const options: MountOptions = {
  markdown: '# Hello\n',
  viewOnly: false,
  autosaveMs: 800,
  onChange: (md, doc) => {
    /* 同步到 store；默认只存 MD 字符串 */
  },
  onAutosave: (md) => {
    /* invoke 写盘 */
  },
  onOpenPath: (path) => {
    /* 打开文件预览 */
  },
  onOpenDoc: (title) => {
    /* wiki-link → 打开笔记 */
  },
  ai: {
    rewrite: async (req) => ({ text: req.context.selectionText ?? '' }),
    summarize: async (req) => ({ text: '…' }),
    continue: async (req) => ({ text: '' }),
    review: async () => ({ findings: [] }),
  },
  uploadImage: async ({ file, name }) => {
    /* 宿主上传，返回可写入 MD 的 url */
    return { url: 'asset://…', alt: name };
  },
  // 或：media: { uploadImage: … }
  features: {
    slash: true,
    dnd: true,
    selectionToolbar: false,
    ai: true,
  },
};

// ⚠ 脚手架阶段会直接 throw — 见下节 dual 运行时
const handle: MarkdownEditorHandle = mount(el, options);

// handle.getMarkdown() / setMarkdown / destroy / flush …
```

### React 薄适配器（示意，属 Host 侧，不进包内核）

```tsx
useEffect(() => {
  const handle = mount(ref.current!, options);
  return () => handle.destroy();
}, []);
```

纪律：适配器内 **禁止** parse/表格/IME 实现；只接线 ports 与生命周期。

---

## Ports 一览

| Port | 方向 | 包内 | 宿主 |
|------|------|------|------|
| `ai`（`AiPort`） | 入 | 收集上下文、应用替换、busy/undo UI | 模型、鉴权、限流 |
| `uploadImage` / `media.uploadImage` | 入 | 占位与进度钩子 | 实际上传与 URL |
| `onOpenPath(path)` | 出 | 文件 chip / 路径链点击 | 打开预览或编辑器 |
| `onOpenDoc(title)` | 出 | wiki-link | 打开笔记 |

- `ai === undefined` 或 `features.ai === false` → AI 入口隐藏/禁用，不报错刷屏。  
- 编辑器 **从不** 内置 API Key / 云上传实现。

类型定义见 [`src/types.ts`](./src/types.ts)。

---

## Dual 运行时（脚手架期）

| 场景 | 用法 |
|------|------|
| 生产编辑能力 / demo HTML | 继续 reference IIFE `MarkdownEditor.mount` |
| Desktop 类型预挂、契约评审 | `import type` from `@conex/mdx` |
| `mount` / `parse` / `serialize` 运行时 | **尚未实现**（throw）；待 MIGRATION B–C |

`src/index.ts` 文件头注释写明：完成端口前 runtime 仍以 reference 为准。

---

## reference IIFE 脚本顺序 → 包模块映射

reference 页面当前需按序加载多 script（摘自 `js/markdown-editor/index.js` 头注释）。迁移后变为单 ESM / 可选 IIFE 产物。

| # | reference 脚本 | 目标包模块 |
|---|----------------|------------|
| 1 | `util.js` | `src/util/*` + `src/inline/*` |
| 2 | `ui/code-highlight.js` | `src/ui/code-highlight.ts`（peer 调度） |
| 3 | `schema.js` | `src/schema/*` |
| 4 | `model.js` | `src/model/*` |
| 5 | `parse.js` | `src/parse/*` |
| 6 | `serialize.js` | `src/serialize/*` |
| 7 | `registry.js` | `src/registry/*` |
| 8 | `ui/line-source.js` | `src/edit/line-source.ts` |
| 9 | `edit/height-lock.js` · `ime-guard.js` · `demotion.js` | `src/edit/*` |
| 10 | `blocks/text-read.js` · `code-read.js` · `code-edit.js` | `src/blocks/*` · `src/render/*` |
| 11 | `table/selection.js` · `merge.js` · `context-menu.js` · `clipboard-tsv.js` | `src/ui/*` / `blocks/table/*` |
| 12 | `ui/table-chrome.js` · `code-chrome.js` | `src/ui/*` |
| 13 | `ui/selection-toolbar.js`（可选） | `src/ui/selection-toolbar.ts` |
| 14 | `editor.js` | **拆分** → `src/editor/*` + `render/*` + `edit/*`（禁止整文件永久化） |
| 15 | `index.js`（`MarkdownEditor.mount`） | `src/index.ts` + `src/compat/iife.ts` |
| CSS | `css/markdown-editor/*` | `styles/*` → 未来 `dist/mdx.css` / `@conex/mdx/style.css` |

全局兼容（过渡）：

| 旧全局 | 新路径 |
|--------|--------|
| `window.MarkdownEditor.mount` | ESM `mount` + 可选 `./iife` |
| `parse` / `serialize` | 同名 ESM |
| `window.MdxModel` 等 | **不承诺**；桌面禁止依赖 |

---

## 工程约定

| 项 | 值 |
|----|-----|
| npm 名 | `@conex/mdx` |
| 内核框架 | **无** React（宿主自写薄包装） |
| 运行时 dependencies | **零**（可选 peer：prism/katex/mermaid） |
| 行数门 | 默认 ≤400，硬顶 600；见 ARCHITECTURE.md |
| 数据 | Markdown 为交换；Block 为运行时；`doc.version` ≠ 包 semver |

---

## 相关路径

| 路径 | 说明 |
|------|------|
| `src/index.ts` | 公共导出 + stub |
| `src/types.ts` | `Doc` / `Block` / `MountOptions` / `AiPort` / `UploadImagePort` |
| `MIGRATION.md` | A–F 勾选清单 |
| `ARCHITECTURE.md` | 所有权矩阵与依赖方向 |
| `reference/chat-composer-component/js/markdown-editor/` | 当前实现源 |
