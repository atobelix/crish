# 07 — 包结构与迁移（Package & Migration）

> **分册**：v3-complete / 07  
> **读者**：平台/桌面集成 agent、包维护者、架构评审  
> **依赖**：[12-integration-contract.md](../12-integration-contract.md)、[08-integration.md](../08-integration.md)、[10-data-format.md](../10-data-format.md)、reference `js/markdown-editor/*`  
> **原则**：Markdown 为交换；Block 为运行时；**TypeScript 包**为交付与迁移的主路径。

---

## 0. 为何新建 `packages/conex-mdx`（TS）能降低迁移成本

### 0.1 现状痛点

| 现状 | 成本 |
|------|------|
| `reference/chat-composer-component/js/markdown-editor/*.js` IIFE + `window.Mdx*` | 无类型；桌面（`apps/crish-desktop`）需手工 script 顺序；难 tree-shake |
| 全局 `window.MarkdownEditor` | 与 React/Vite 生态摩擦；多实例靠纪律而非模块边界 |
| CSS 相对路径 `@import` | 宿主易漏 table.css / token |
| 可选能力（高亮、KaTeX、Mermaid）未分包 | 要么全无要么将来误打进主包 |
| 主软件已是 **pnpm workspace + TS + Vite**（`packages/*`、`apps/*`） | 再塞 vanilla 全局脚本 = 双栈构建与双套测试 |

### 0.2 TS 包的具体收益

1. **契约即类型**：`Doc` / `Block` / `TextRun` / `MarkdownEditorHandle` 从「文档里的接口」变成 `import type` 可编译检查；改 schema 时 desktop 与包 **同 PR 红灯**。  
2. **一次构建，多宿主**：Vite library mode → ESM（React 懒加载）+ 可选 IIFE 兼容层（reference HTML / 旧 demo）。  
3. **零/可选依赖策略可执行**：peerOptional + 动态 `import()`；主包保持轻。  
4. **与 monorepo 对齐**：同 `tsc`/`vitest`/`turbo` 流水线；不用为 reference 单独发明 CI。  
5. **迁移可增量**：先包内 dual-publish API，reference 改为消费 workspace 包；desktop 只加依赖与 10 行 mount。  
6. **销毁与 SSR 边界清晰**：模块作用域替代隐式全局；`destroy()` 可类型约束。

### 0.3 反方与回应

| 疑虑 | 回应 |
|------|------|
|「多一层 monorepo 包太重」 | 已有 `packages/logger`、`shared-types` 等；mdx 同级，不引入新仓库 |
|「先写完 vanilla 再转」 | 允许 short dual；但 **新功能优先 TS**，避免二次搬运 |
|「编辑器必须绑 React」 | **内核无 React**；可选 `@conex/mdx-react` 薄包装可后置 |

**结论（冻结）**：交付物 = `@conex/mdx`（名可微调），reference 为 demo/视觉实验室，**不再**作为 desktop 复制粘贴源。

---

## 1. 建议包目录树

路径：仓库根 `packages/conex-mdx/`（与 `packages/logger` 等并列）。

```
packages/conex-mdx/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vite.config.ts              # library mode
├── vitest.config.ts
├── README.md                   # 包级：安装与最小示例（可后补；本分册已含规格）
├── src/
│   ├── index.ts                # 公共 ESM API
│   ├── compat/iife.ts          # window.MarkdownEditor 兼容层入口
│   ├── types/
│   │   ├── doc.ts              # Doc, Block, TextRun, InlineMark
│   │   ├── selection.ts
│   │   ├── editor.ts           # MountOptions, Handle, Callbacks
│   │   └── index.ts
│   ├── schema/
│   │   ├── version.ts          # VERSION = 2
│   │   ├── create-block.ts
│   │   ├── migrate.ts
│   │   └── clone.ts
│   ├── model/
│   │   ├── document-model.ts   # undo/redo, updateBlock…
│   │   └── history.ts
│   ├── parse/
│   │   ├── from-markdown.ts
│   │   ├── tokenize.ts
│   │   └── parse-inline.ts
│   ├── serialize/
│   │   ├── to-markdown.ts
│   │   └── serialize-inline.ts
│   ├── inline/                 # 见 04 分册
│   │   ├── toggle-mark.ts
│   │   ├── detect-delimiter.ts
│   │   ├── normalize.ts
│   │   └── dom-bridge.ts
│   ├── registry/
│   │   ├── block-registry.ts
│   │   └── builtin.ts
│   ├── blocks/                 # 每类型可拆文件
│   │   ├── paragraph.ts
│   │   ├── heading.ts
│   │   ├── list.ts
│   │   ├── code.ts
│   │   ├── table.ts
│   │   ├── callout.ts
│   │   └── …
│   ├── editor/
│   │   ├── create-editor.ts
│   │   ├── edit-session.ts
│   │   ├── keymap.ts
│   │   ├── ime.ts
│   │   ├── dnd.ts
│   │   └── slash.ts
│   ├── ui/
│   │   ├── selection-toolbar.ts
│   │   ├── table-chrome.ts
│   │   └── context-menu.ts
│   ├── motion/
│   │   ├── prefers-reduced-motion.ts
│   │   └── run-enter-leave.ts
│   ├── extensions/             # 可选注册
│   │   ├── wiki-link.ts
│   │   ├── file-chip.ts
│   │   └── highlight.ts
│   ├── ai/                     # 端口空壳，见 08-ai-ports
│   │   └── ports.ts
│   └── style/
│       └── inject.ts           # 可选：不推荐默认 inject；见 §6
├── styles/                     # 源 CSS（或从 reference 迁）
│   ├── index.css
│   ├── tokens.css
│   ├── base.css
│   ├── blocks.css
│   ├── table.css
│   ├── code.css
│   ├── chrome.css
│   ├── slash.css
│   ├── motion.css
│   └── sel-toolbar.css
├── dist/                       # build 产出（gitignore 可按 monorepo 惯例）
│   ├── index.js
│   ├── index.cjs               # 若需要
│   ├── index.d.ts
│   ├── mdx.css
│   └── mdx.iife.js             # 兼容层
└── tests/
    ├── roundtrip.test.ts
    ├── inline-marks.test.ts
    ├── ime.test.ts
    ├── migrate-doc.test.ts
    └── mount.dom.test.ts
```

### 1.1 package.json 要点（草稿）

```json
{
  "name": "@conex/mdx",
  "version": "0.1.0",
  "description": "Conex Markdown block editor (Doc v2, GFM + extensions)",
  "type": "module",
  "sideEffects": ["**/*.css"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./style.css": "./dist/mdx.css",
    "./iife": "./dist/mdx.iife.js",
    "./package.json": "./package.json"
  },
  "files": ["dist", "styles"],
  "scripts": {
    "build": "vite build && tsc -p tsconfig.build.json",
    "test": "vitest run",
    "dev": "vitest"
  },
  "peerDependencies": {
    "prismjs": "^1.29.0",
    "katex": "^0.16.0",
    "mermaid": "^10.0.0"
  },
  "peerDependenciesMeta": {
    "prismjs": { "optional": true },
    "katex": { "optional": true },
    "mermaid": { "optional": true },
    "shiki": { "optional": true }
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "workspace-or-root",
    "vite": "…",
    "vitest": "…",
    "jsdom": "…"
  }
}
```

**零运行时依赖**为目标：核心 parse/serialize/model/editor 不依赖 React、不依赖 lodash。  
高亮/公式/图：**peer optional + 动态 import**，见 §6。

---

## 2. 导出 API 与 `window.MarkdownEditor` 兼容层

### 2.1 现代 ESM API（主路径）

```ts
// @conex/mdx
export { mount, createEditor } from './editor/create-editor';
export { parse, serialize } from './parse-serialize';
export { migrate, createBlock, emptyDoc, cloneDoc, VERSION } from './schema';
export { toggleMark, parseInline, serializeInline } from './inline';
export type {
  Doc,
  Block,
  TextRun,
  InlineMark,
  MarkdownEditorHandle,
  MarkdownEditorMountOptions,
  MarkdownEditorCallbacks,
  ChangeMeta,
} from './types';
```

#### `mount` 签名（对齐 08/12，并增强）

```ts
export interface MarkdownEditorMountOptions {
  /** @deprecated 同 markdown；兼容 reference */
  markdown?: string;
  initialMarkdown?: string;
  doc?: Doc;
  viewOnly?: boolean;
  readOnly?: boolean;          // 别名策略：viewOnly || readOnly
  autosaveMs?: number;         // default 400
  placeholder?: string;
  density?: 'compact' | 'doc'; // data-mdx-density
  features?: {
    slash?: boolean;
    dnd?: boolean;
    selectionToolbar?: boolean;
    legacyExecCommand?: boolean; // default false after P2
    asYouTypeMarks?: boolean;    // default true
    tableMerge?: boolean;
  };
  extensions?: {
    highlight?: boolean;
    codeHighlight?: 'none' | 'prism' | 'shiki';
    math?: boolean;
    mermaid?: boolean;
  };
  onChange?: (md: string, doc: Doc, meta?: ChangeMeta) => void;
  onAutosave?: (md: string, meta: { revision: number; at: number }) => void;
  onOpenPath?: (path: string) => void;
  onOpenDoc?: (title: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export interface MarkdownEditorHandle {
  getMarkdown(): string;
  setMarkdown(md: string, opts?: { emit?: boolean; keepHistory?: boolean }): void;
  getDoc(): Doc;
  setDoc(doc: Doc, opts?: { emit?: boolean; keepHistory?: boolean }): void;
  flush(): void;
  focus(opts?: { blockId?: string; end?: boolean }): void;
  blur(): void;
  destroy(): void;
  isDirty(): boolean;
  undo(): boolean;
  redo(): boolean;
  setReadOnly(ro: boolean): void;
  readonly el: HTMLElement;
  readonly viewOnly: boolean;
}

export function mount(
  hostEl: HTMLElement,
  options?: MarkdownEditorMountOptions
): MarkdownEditorHandle;
```

### 2.2 兼容层：`window.MarkdownEditor`

reference 与可能的裸 HTML 宿主继续工作：

```ts
// src/compat/iife.ts
import { mount, parse, serialize, migrate } from '../index';

export interface LegacyMarkdownEditorGlobal {
  mount: typeof mount;
  parse: (md: string) => Doc;
  serialize: (doc: Doc) => string;
  migrate?: typeof migrate;
}

declare global {
  interface Window {
    MarkdownEditor?: LegacyMarkdownEditorGlobal;
    MdxSchema?: unknown; // 过渡期可选再导出
  }
}

const api: LegacyMarkdownEditorGlobal = {
  mount,
  parse,
  serialize,
  migrate,
};

if (typeof window !== 'undefined') {
  window.MarkdownEditor = api;
}

export default api;
```

Vite IIFE 配置：

```ts
// vite.config.ts 多入口之一
build: {
  lib: {
    entry: {
      index: 'src/index.ts',
      'mdx.iife': 'src/compat/iife.ts',
    },
    formats: ['es'],
  },
  // iife 格式单独 rollupOptions.output
}
```

### 2.3 行为兼容矩阵

| 旧 API | 新 API | 备注 |
|--------|--------|------|
| `MarkdownEditor.mount(el, opts)` | 同 | opts.markdown 保留 |
| `getMarkdown/setMarkdown` | 同 | |
| `getDoc/setDoc` | 同 | 经 migrate |
| `flush/destroy/focus` | 同 | |
| `viewOnly` / `el` | 同 | |
| `MarkdownEditor.parse/serialize` | 同 + 命名导出 | |
| `window.MdxModel` 等 | **不保证**长期 | 桌面勿依赖；测试可从包内部 import |
| script 多文件顺序 | **单文件 iife 或 ESM** | 顺序问题消失 |

### 2.4 废弃时间表

| 版本 | 策略 |
|------|------|
| 0.x | 兼容 `window.MarkdownEditor`；文档标 ESM 优先 |
| 1.0 | IIFE 仍发；内部 `Mdx*` 全局若有则移除 |
| 2.0 | 可仅 ESM（若无外部裸 HTML 用户） |

---

## 3. 从 reference vanilla 迁移步骤

### 阶段 A — 脚手架（0.5–1d）

1. 创建 `packages/conex-mdx` 与 package.json / tsconfig。  
2. Vite library + vitest 接通 turbo `build`/`test`。  
3. 导出空 `mount` throw `not implemented` 验证 desktop 能 resolve 包名。

### 阶段 B — 纯逻辑先迁（1–2d）

无 DOM 或少 DOM：

| 源文件 | 目标 |
|--------|------|
| `schema.js` | `src/schema/*` |
| `model.js` | `src/model/*` |
| `parse.js` | `src/parse/*` |
| `serialize.js` | `src/serialize/*` |
| `util.js` 的 esc/inline | `src/inline/*` + `src/util/esc.ts` |
| `registry.js` | `src/registry/*` |

带单测：从 `tests/markdown-editor/roundtrip.test.js` 迁/双跑。

### 阶段 C — 编辑器壳（2–4d）

| 源 | 目标 |
|----|------|
| `editor.js` | `src/editor/*` 拆分（过大，禁止单文件 2k 行永久化） |
| `ui/selection-toolbar.js` | `src/ui/selection-toolbar.ts` |
| `ui/table-chrome.js` | `src/ui/table-chrome.ts` |
| `index.js` | `src/index.ts` + compat |

并行：CSS 从 `css/markdown-editor` 拷到 `packages/conex-mdx/styles`，build 打 `dist/mdx.css`。

### 阶段 D — v3 能力在包内做（持续）

- 04 行内实时 marks  
- 05 动效  
- 03 表格合并  
- 代码块 read/edit 单壳  

**规则**：新功能不进 reference 独苗；reference 只 **依赖包** 或 symlink。

### 阶段 E — reference 改消费包（0.5d）

1. `markdown-editor.html` / `index.html`：  
   - 开发：Vite alias `@conex/mdx`  
   - 或 script `dist/mdx.iife.js` + `dist/mdx.css`  
2. 删除或薄包装旧 `js/markdown-editor/*`（可留 re-export 防外链）。  
3. 演示页回归 IME、slash、表格。

### 阶段 F — 清理

- 全局 `window.Mdx*` 仅 compat 需要的最小集。  
- 文档 12 集成契约改为「npm 依赖 @conex/mdx」。

---

## 4. 主软件（Tauri / desktop）集成 — 工作量最小化清单

宿主假设：`apps/crish-desktop`（Vite + React + Tauri）。

### 4.1 最小改动清单（勾选即用）

| # | 任务 | 估计 | 说明 |
|---|------|------|------|
| 1 | workspace 依赖 `"@conex/mdx": "workspace:*"` | 15m | package.json |
| 2 | 全局或路由级 `import '@conex/mdx/style.css'` | 15m | 一次 |
| 3 | 薄包装组件 `MarkdownEditorHost.tsx` | 1–2h | useRef + useEffect mount/destroy |
| 4 | props：`value`/`onChange` ↔ get/setMarkdown | 1h | debounce 已在包内 autosave 可关 |
| 5 | `onOpenPath` 接文件树/预览 | 1h | 已有预览管线则回调桥接 |
| 6 | 卸载 `destroy` + 严格 Mode 双调用防护 | 30m | ref 持有 handle |
| 7 | viewOnly 用于文件预览 MD | 30m | 替换部分 markdown-lite 预览可选 |
| 8 | 主题 token 覆盖 | 1h | `.app .mdx-root { --mdx-body: … }` |
| 9 | 功能旗标（slash/dnd）按面板 | 30m | features |
| 10 | 冒烟测：打开笔记、中文输入、保存 md | 2h | Playwright 可选 |

**刻意不做（避免膨胀）：**

- 不把 Doc JSON 强塞进现有 store（除非要离线加速）— 默认 **只存 MD 字符串**。  
- 不在首版接 Shiki/Mermaid；`extensions.codeHighlight: 'none'`。  
- 不重写 Notebook 外壳 pin/drag — 只换 body 挂载点。  
- 不引入 ProseMirror 并行引擎。

### 4.2 React 包装示例（参考，非强制进包）

```tsx
import { useEffect, useRef } from 'react';
import { mount, type MarkdownEditorHandle } from '@conex/mdx';
import '@conex/mdx/style.css';

export function ConexMdxEditor(props: {
  markdown: string;
  onChange?: (md: string) => void;
  viewOnly?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<MarkdownEditorHandle | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const api = mount(el, {
      markdown: props.markdown,
      viewOnly: props.viewOnly,
      onChange: (md) => props.onChange?.(md),
    });
    apiRef.current = api;
    return () => {
      api.destroy();
      apiRef.current = null;
    };
    // 仅挂载一次；外部 markdown 用下行 effect 推入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    if (api.getMarkdown() !== props.markdown) {
      api.setMarkdown(props.markdown, { emit: false });
    }
  }, [props.markdown]);

  return <div ref={hostRef} className="conex-mdx-host" />;
}
```

### 4.3 Tauri 特有注意

| 点 | 建议 |
|----|------|
| 文件写盘 | onChange/onAutosave → 现有 fs 命令；包内不碰 Rust |
| 路径打开 | onOpenPath → 复用 desktop 文件预览 |
| 安全 | 包内已 escape HTML；href sanitize；仍禁止宿主把未可信 HTML 当 markdown 绕过 |
| 剪贴板 | 用浏览器 API；无需 Tauri plugin |
| 多 WebView | 每 view 独立 mount；无 window 单例状态 |

---

## 5. 构建：tsc / Vite library、CSS 打包

### 5.1 Vite library 要点

```ts
// vite.config.ts（示意）
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'ConexMdx',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: [/^prismjs/, /^katex/, /^mermaid/, /^shiki/],
      output: {
        assetFileNames: (asset) =>
          asset.name?.endsWith('.css') ? 'mdx.css' : 'assets/[name][extname]',
      },
    },
    sourcemap: true,
    target: 'es2022',
  },
});
```

- `tsc -p tsconfig.build.json` 发 `.d.ts`（`emitDeclarationOnly` 或 vite-plugin-dts）。  
- IIFE 第二 product：`mdx.iife.js`，`inlineDynamicImports: true`，external 仍可对可选 peer 保留全局。

### 5.2 CSS 打包

| 策略 | 做法 | 推荐 |
|------|------|------|
| A. 单文件 `mdx.css` | Vite 处理 `import './styles/index.css'` 从 entry 侧链 或单独 entry `styles/index.css` | **推荐** |
| B. 运行时 inject | `inject.ts` 插 style 标签 | 仅无构建宿主；默认关 |
| C. 宿主自己 @import 源码 | 暴露 `styles/` | 进阶主题定制 |

`sideEffects: ["**/*.css"]` 防止被 tree-shake 掉。

Token：包内 `tokens.css` 提供 fallback；宿主 flow/design tokens **已存在则覆盖**，与 visual-system 契约一致。

### 5.3 monorepo 脚本

根 `package.json` / turbo：

- `turbo run build --filter=@conex/mdx`  
- desktop `dependsOn: ["^build"]` 确保类型与 dist 就绪  

---

## 6. 依赖策略：零核心依赖 + 可选 peer

### 6.1 核心

```
dependencies: {} 
```

允许的例外（若必要再议）：

- 无 `prosemirror-*` / `tip-tap` 默认依赖（体积与架构锁定）  
- 无 `lodash`（手写 clamp/uid）

### 6.2 可选 peer 与加载

| 能力 | Peer | 加载方式 | 失败降级 |
|------|------|----------|----------|
| 代码高亮 | `prismjs` 或 `shiki` | `extensions.codeHighlight` + 动态 import | 纯文本 + 语言标签 |
| 公式 | `katex` | 块 type math / `$` 扩展 | 显示源码 |
| 图 | `mermaid` | 块 mermaid | 显示源码 + 错误占位 |
| React 包装 | `react` | 未来子路径 `@conex/mdx/react` | 不进核心 |

```ts
async function highlightCode(code: string, lang: string, engine: 'prism' | 'shiki') {
  if (engine === 'prism') {
    const Prism = (await import('prismjs')).default;
    // 按需再 import 语言组件
    return Prism.highlight(code, Prism.languages[lang] || Prism.languages.plain, lang);
  }
  // shiki…
}
```

**禁止**把 prism 全语言表静态打进主包。

### 6.3 包体积目标（经验值）

| 产物 | gzip 目标 |
|------|-----------|
| `index.js` 核心（无高亮） | ≤ 40–60KB（初期可放宽到 80KB，盯拆分） |
| `mdx.css` | ≤ 15–25KB |
| `mdx.iife.js` | 略大于 ESM |

CI 可加 size snapshot（P2）。

---

## 7. 版本与 SemVer

### 7.1 版本号语义

| 变化 | 版本 |
|------|------|
| 破坏：`mount` 参数改名删除、Doc 字段不经 migrate 就挂、CSS 强制类名删除 | **MAJOR** |
| 兼容：新块类型、新 mark、新 features 旗标、新可选 peer | **MINOR** |
| 修 bug、动效微调、文档 | **PATCH** |
| 0.x 期间 | 允许 MINOR 含小破坏，但须 CHANGELOG 置顶；**Doc.version 与包版本解耦** |

### 7.2 Doc.version vs 包版本

| 字段 | 含义 |
|------|------|
| `doc.version`（现 2） | **数据契约**；`migrate()` 负责升级 |
| `@conex/mdx` semver | **代码 API / 行为** |

规则：

- 新增可选块字段：`doc.version` 可不动或 +0.1 政策写在 10-data-format；包 **MINOR**。  
- 删除块类型 / 改 runs 必选：`doc.version` **MAJOR 语义 +1**（3）；包 **MAJOR**；migrate 必备。  
- 纯编辑器 bugfix：包 PATCH；doc.version 不变。

### 7.3 兼容承诺

1. `getMarkdown()` / `setMarkdown()` 作为 **稳定表面**（1.0 后）。  
2. `migrate` 对 version 1→2→… **只增不删** 旧迁移函数。  
3. CSS 类前缀 `mdx-` 稳定；`is-*` 状态类稳定。  
4. 实验 API 挂 `experimental` 命名空间或文档标 `@experimental`，不进 semver 硬保证。

### 7.4 CHANGELOG 模板

```md
## [0.2.0] - YYYY-MM-DD
### Added
- as-you-type highlight ==
### Changed
- selection toolbar 默认非 execCommand
### Fixed
- IME compositionend 双 history
### Migration
- 无数据迁移；宿主无需改 MD
```

---

## 8. 测试与质量门

| 层 | 工具 | 范围 |
|----|------|------|
| 单元 | vitest | parse/serialize/runs/toggleMark/migrate |
| DOM | vitest + jsdom 或 happy-dom | mount、toolbar、简单 input |
| 往返 | golden MD 文件 | GFM + 扩展 |
| 类型 | tsc | public exports |
| 集成 | desktop Playwright（抽检） | 中文 IME 真浏览器更准 |

门禁建议：`turbo` 中 mdx 包 test 失败阻断 desktop 发版（与 shared-types 同级）。

---

## 9. 安全与 CSP

| 项 | 要求 |
|----|------|
| HTML | 始终 escape 文本；白名单标签 |
| 链接 | 禁 `javascript:` / `data:` 危险导航（配置允许 data 图可另开） |
| 动态 import peer | 路径固定包名，不拼接用户字符串当模块路径 |
| CSS | 无用户自定义任意 style 注入 |

---

## 10. 风险与缓解

| 风险 | 缓解 |
|------|------|
| editor.js 过大难迁 | 按功能切开；先测后搬 |
| 双轨 reference + 包漂移 | E 阶段起 reference 只消费包 |
| peer 动态 import 在 Tauri 打包失败 | 测 Vite external + 显式依赖放 desktop |
| 类型过严阻塞 demo | 内部 `LooseBlock` 与 public 类型分层 |
| CSS 与 flow 双份 token | 仅 fallback；注释对齐表 |

---

## 11. 里程碑建议

| 里程碑 | 产出 | 可集成？ |
|--------|------|----------|
| M0 | 包脚手架 + 空 mount | 否 |
| M1 | parse/serialize/model + 测试 | 数据层可复用 |
| M2 | mount 编辑段落 + history + IME | **桌面可灰** |
| M3 | slash + dnd + toolbar（无 execCommand） | 体验可用 |
| M4 | 表合并 + marks live + motion | v3 完整 |
| M5 | 1.0 API freeze + CHANGELOG | 正式依赖 |

---

## 12. 论证小结（给评审）

1. **desktop 已是 TS monorepo** — 再维护一套全局 JS 编辑器是双税。  
2. **类型化 Doc/Handle** — 集成错误前移到编译期，减少「挂上了但 onChange 不对」的联调。  
3. **兼容层保留 `window.MarkdownEditor`** — reference 与文档示例不瞬间作废。  
4. **零核心依赖 + 可选 peer** — 主软件包体与安全边界可控。  
5. **最小集成清单 ≤ 1–2 人日量级接线**（不含编辑器功能本身）— 符合「工作量最小化」。  
6. **SemVer + doc.version 解耦** — 数据与代码进化不互相绑架。

---

## 13. 参考锚点

| 路径 | 角色 |
|------|------|
| `reference/.../js/markdown-editor/index.js` | 现 `window.MarkdownEditor` |
| `docs/markdown-editor/12-integration-contract.md` | 旧集成步骤 |
| `docs/markdown-editor/10-data-format.md` | Doc v2 真相 |
| `packages/logger` 等 | monorepo 包范例 |
| `apps/crish-desktop` | 主集成目标 |

---

**文档结束（07）** · 实施排期与其它分册依赖见合成后的 [10-implementation-plan.md](./10-implementation-plan.md)。
