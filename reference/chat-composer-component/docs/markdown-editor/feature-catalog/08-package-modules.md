# 08 — 包模块与工程能力目录（Package Modules · Architecture Catalog）

> **分册**：feature-catalog / 08  
> **读者**：包维护者、桌面/Workbench 集成 agent、架构评审、多 Agent 实施编排  
> **语言**：中文 UTF-8  
> **目标交付**：`packages/conex-mdx`（**TypeScript 优先**，宿主集成友好、可 tree-shake、可迁移）  
> **依赖锚点**：[v3 07-package-migration](../v3-complete/07-package-migration.md) · [11-no-god-file-charter](../v3-complete/11-no-god-file-charter.md) · [11-system-architecture](../11-system-architecture.md) · [12-integration-contract](../12-integration-contract.md) · [08-ai-ports](../v3-complete/08-ai-ports.md) · [10-data-format](../10-data-format.md)  
> **原则**：Markdown 为交换；Block 为运行时；**模块有主、文件有顶、API 有面、端口可插**。  
> **本册范围**：架构边界、模块地图、公共 API、宿主适配、测试策略、工程能力「做到最好」、从 reference vanilla IIFE 迁移检查表。**不含**业务块视觉细则与具体实现补丁。

---

## 0. 一句话与成功判据

### 0.1 一句话

**把 reference 里的 vanilla IIFE 编辑器收成 monorepo 一等公民包 `@conex/mdx`：类型即契约、模块无上帝文件、公共面极小、可选能力 peer + 动态 import，Desktop / Workbench 只写薄适配器。**

### 0.2 成功判据（Definition of Done · 工程维）

| ID | 判据 | 验收 |
|----|------|------|
| P0 | 包可被 `apps/*` 以 `workspace:*` 解析并 `import { mount } from '@conex/mdx'` | tsc 绿、Vite resolve 绿 |
| P1 | 单文件行数策略生效；无新的 god file | CI 行数门或 review 清单 |
| P2 | 公共 API 仅 export 表内符号；内部路径不可被宿主依赖 | `exports` 字段 + 类型检查 |
| P3 | 核心包 **零运行时 dependencies**；mermaid/katex/prism 为 optional peer | package.json 审计 |
| P4 | tree-shake：未开 math/mermaid 时主 bundle 不含其实现 | size snapshot / rollup 分析 |
| P5 | Desktop 适配器 ≤ 1 个 React 文件 + token 覆盖；不 fork 内核 | 集成清单勾选 |
| P6 | 单元 / 往返 / 属性 / 视觉冒烟分层可跑 | vitest + 可选 playwright |
| P7 | reference 演示页改消费包（或 IIFE 单产物），不再复制粘贴源 | 迁移检查表 E 阶段完成 |

### 0.3 非目标

| 非目标 | 原因 |
|--------|------|
| 本册实现具体块渲染算法 | 见 blocks/*、v3 分册 |
| 把 React/ProseMirror 塞进核心 | 内核无框架；包装可后置 |
| 把 AI 模型调用写进包 | 仅 ports，见 08-ai-ports |
| 同步维护两套永久并行内核 | dual 期短；新功能只进 TS 包 |

---

## 1. 目标包定位：`packages/conex-mdx`

### 1.1 命名与坐标

| 项 | 值 |
|----|-----|
| 仓库路径 | `packages/conex-mdx/`（与 `packages/logger`、`shared-types` 同级） |
| npm 名 | `@conex/mdx`（可微调，冻结后勿改） |
| 主语言 | **TypeScript**（ESM 交付） |
| 内核框架 | **无** React / Vue / Solid |
| 可选子路径 | `./style.css` · `./iife` · 未来 `./react` |
| 主集成宿主 | Conex Desktop（Tauri + Vite + React）、Workbench WebView、reference 演示页 |

### 1.2 为何 TS 包优于继续复制 vanilla IIFE

| 维度 | vanilla IIFE（现状痛点） | `@conex/mdx`（目标） |
|------|--------------------------|----------------------|
| 类型 | 文档接口，无编译约束 | `Doc` / `Handle` 可 `import type`，改 schema 同 PR 红灯 |
| 加载 | 多 script 顺序脆弱 | 单 ESM 入口；IIFE 仅兼容层 |
| 体积 | 易把可选能力全打进页 | tree-shake + peer optional + 动态 import |
| 测试 | 独立脚本难进 turbo | 同 monorepo vitest/tsc |
| 多实例 | 靠纪律不挂 `window` 单例 | 模块作用域 + 每 mount 独立 handle |
| 迁移 | desktop 复制夹 = 双栈 | workspace 依赖 + 10 行 mount |

**冻结结论**：reference 是视觉/产品实验室；**desktop 不以 reference 源为复制源**，以包 dist/types 为真相。

### 1.3 与 monorepo 对齐约定

| 约定 | 说明 |
|------|------|
| 构建 | Vite library mode + `tsc` 声明；turbo `build`/`test` |
| 依赖 | `dependencies: {}`；peer optional 见 §7 |
| 样式 | `sideEffects: ["**/*.css"]`；导出 `@conex/mdx/style.css` |
| 版本 | 包 semver 与 `doc.version` **解耦**（数据契约走 migrate） |
| 日志 | 不依赖 `@conex/logger` 运行时（避免宿主耦合）；调试用可选 `onDebug` 回调 |

---

## 2. 分层架构（宿主可替换，内核稳定）

```
┌──────────────────────────────────────────────────────────────────┐
│ Host：Conex Desktop / Workbench / FilePreview / reference demo     │
│  持久化 · 路由 · 主题 token · AI Runtime · 上传 · 权限 · 文件树   │
└───────────────────────────────┬──────────────────────────────────┘
                                │ Adapter（薄）：mount / destroy / ports
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ Public Surface（@conex/mdx）                                       │
│  mount · parse · serialize · migrate · types · (可选) createEditor │
└───────────────────────────────┬──────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ EditorController（薄协调）                                         │
│  焦点 · IME · Transaction 调度 · viewOnly · 脏块 reconcile         │
└───┬────────┬────────┬────────┬────────┬────────┬─────────────────┘
    ▼        ▼        ▼        ▼        ▼        ▼
  Model   Registry  Parse   Serialize  UI Plugins  Ports
  History Blocks[]  MD→Doc  Doc→MD     slash/dnd/  AI / Media
                                       table/sel   / Highlight
```

| 层 | 职责 | 禁止 |
|----|------|------|
| Host / Adapter | 存盘、主题、AI 实现、文件打开 | 直接改 block DOM、绕过 model 写 text |
| Public Surface | 稳定符号、类型导出 | 泄漏内部路径、隐藏全局副作用 |
| Controller | 事件路由、会话、事务提交 | 具体 MD 语法、表格算法细节 |
| Model | Doc 真相、undo/redo | 碰 DOM、发网络 |
| Registry + Blocks | 类型行为注册 | 全局单例污染、跨类型 if-else 堆叠 |
| Parse / Serialize | 往返 | UI、history 策略 |
| UI Plugins | 菜单/拖拽/chrome | 绕过 model 改内容 |
| Ports | 能力插槽接口 | 内置模型密钥、内置云上传实现 |

---

## 3. 模块地图（NO god files）

### 3.1 强制宪章摘要

完整宪章见 [11-no-god-file-charter](../v3-complete/11-no-god-file-charter.md)。本册工程化落地如下。

| 规则 | 内容 |
|------|------|
| G1 | **禁止**单文件同时承担 parse + serialize + model + render + table + slash + dnd + AI + media |
| G2 | **禁止**向遗留 `editor.js` 堆新功能；只允许删减/接线；新逻辑进新模块 |
| G3 | **禁止** demo HTML 内联超长业务逻辑 |
| G4 | 实现 agent 只改 **所有权矩阵** 内路径；跨界由 orchestrator 合并 |
| G5 | 单文件默认 **≤ 400 行**；软顶 **500**；硬顶 **600**（超则必须拆，PR 说明例外） |
| G6 | 目录职责单一；同名「utils 垃圾桶」禁止超过 200 行无主题分区 |

### 3.2 目标源码树（TS 包）

路径：`packages/conex-mdx/`

```
packages/conex-mdx/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vite.config.ts
├── vitest.config.ts
├── README.md
├── src/
│   ├── index.ts                    # 公共 ESM 再导出（薄）
│   ├── compat/
│   │   └── iife.ts                 # window.MarkdownEditor 兼容
│   ├── types/
│   │   ├── doc.ts                  # Doc, Block, TextRun, marks
│   │   ├── selection.ts
│   │   ├── editor.ts               # MountOptions, Handle, Callbacks
│   │   ├── ports.ts                # AiPorts, MediaPorts 等
│   │   └── index.ts
│   ├── schema/
│   │   ├── version.ts
│   │   ├── create-block.ts
│   │   ├── migrate.ts
│   │   ├── validate.ts
│   │   └── clone.ts
│   ├── model/
│   │   ├── document-model.ts
│   │   ├── history.ts
│   │   └── transaction.ts
│   ├── parse/
│   │   ├── from-markdown.ts
│   │   ├── tokenize.ts
│   │   └── parse-inline.ts
│   ├── serialize/
│   │   ├── to-markdown.ts
│   │   └── serialize-inline.ts
│   ├── inline/
│   │   ├── toggle-mark.ts
│   │   ├── detect-delimiter.ts
│   │   ├── normalize.ts
│   │   └── dom-bridge.ts
│   ├── registry/
│   │   ├── block-registry.ts
│   │   └── builtin.ts
│   ├── blocks/                     # 每类型一文件（或 type 子目录）
│   │   ├── paragraph.ts
│   │   ├── heading.ts
│   │   ├── list.ts
│   │   ├── code.ts
│   │   ├── table.ts
│   │   ├── callout.ts
│   │   ├── media.ts
│   │   └── …
│   ├── editor/
│   │   ├── create-editor.ts        # mount 工厂
│   │   ├── controller.ts           # 薄控制器
│   │   ├── edit-session.ts
│   │   ├── keymap.ts
│   │   ├── ime.ts
│   │   ├── reconcile.ts            # 脏块 DOM 更新
│   │   ├── dnd.ts
│   │   └── slash.ts
│   ├── render/
│   │   ├── read-view.ts
│   │   └── code-read.ts
│   ├── edit/
│   │   ├── enter-exit.ts
│   │   ├── line-source.ts
│   │   ├── backspace-demote.ts
│   │   ├── promote-prefix.ts
│   │   └── code-source.ts
│   ├── ui/
│   │   ├── selection-toolbar.ts
│   │   ├── table-chrome.ts
│   │   ├── table-selection.ts
│   │   ├── context-menu.ts
│   │   └── code-highlight.ts       # 调度 peer，非全语言表
│   ├── motion/
│   │   ├── prefers-reduced-motion.ts
│   │   └── run-enter-leave.ts
│   ├── extensions/
│   │   ├── wiki-link.ts
│   │   ├── file-chip.ts
│   │   ├── math-katex.ts           # 动态 import katex
│   │   └── mermaid-block.ts        # 动态 import mermaid
│   ├── ai/
│   │   └── ports.ts                # 仅类型 + 入口接线，无模型
│   ├── util/
│   │   ├── esc.ts
│   │   ├── uid.ts
│   │   └── dom.ts
│   └── style/
│       └── inject.ts               # 默认关闭；无构建宿主才用
├── styles/
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
└── tests/
    ├── unit/
    ├── property/
    ├── visual/                     # 或 e2e 截图基线外置
    └── fixtures/
```

### 3.3 模块职责与行数预算

| 模块目录 | 单一职责 | 软顶（行/文件） | 硬顶 | 备注 |
|----------|----------|-----------------|------|------|
| `types/` | 公共与半公共类型 | 300 | 400 | 可按域拆文件 |
| `schema/` | Doc 版本、migrate、校验 | 350 | 500 | migrate 可按版本拆 |
| `model/` | 文档真相 + history | 400 | 550 | history 独立文件 |
| `parse/` / `serialize/` | MD 往返 | 400 | 600 | 表/列表可子模块 |
| `inline/` | TextRun / marks | 350 | 500 | 与 DOM bridge 分离 |
| `registry/` | 注册表 + builtin 装载 | 250 | 400 | 不写具体块 HTML |
| `blocks/*` | 单类型 parse/serialize/read/edit | 350 | 500 | table 可拆 `table/*.ts` |
| `editor/controller` | 路由与协调 | 400 | 500 | **禁止**重回 god |
| `editor/*` 其余 | 单关注点（IME/keymap/…） | 300 | 450 | |
| `render/` · `edit/` | 读/写表面 | 350 | 500 | |
| `ui/*` | 浮层 chrome | 350 | 500 | table-chrome 可再拆 |
| `extensions/*` | 可选扩展 | 300 | 450 | peer 加载集中在此 |
| `ai/` | 端口接线 | 200 | 300 | 无 HTTP |
| `compat/` | IIFE 全局 | 150 | 250 | 薄 |
| `index.ts` | re-export | 80 | 120 | 禁止业务逻辑 |
| `util/*` | 纯函数工具 | 200 | 300 | 禁止藏业务状态 |

**超顶处理**：先拆子文件 → 再拆子目录 → 最后才允许「评审批准的临时例外」（标注 issue 与拆除日期）。

### 3.4 所有权矩阵（多 Agent 并行）

| 所有权 ID | 路径 glob | 主责 | 可只读依赖 | 禁止写入 |
|-----------|-----------|------|------------|----------|
| O-Types | `src/types/**` | Schema/API agent | — | 业务实现细节塞进类型垃圾场 |
| O-Schema | `src/schema/**` | Schema agent | types | editor/ui |
| O-Model | `src/model/**` | Model agent | types, schema | parse 语法、DOM |
| O-Parse | `src/parse/**`, `src/serialize/**` | Parse agent | types, schema, blocks 钩子 | ui、controller 事件 |
| O-Inline | `src/inline/**` | Inline agent | types | table 专用逻辑 |
| O-Blocks | `src/blocks/**`, `src/registry/**` | Blocks agent | types, schema | host adapter |
| O-Editor | `src/editor/**`, `src/render/**`, `src/edit/**` | Editor agent | model, registry | 具体 peer 全量语言表 |
| O-UI | `src/ui/**`, `src/motion/**` | UI agent | types, editor 事件 | model 内部结构硬编码 |
| O-Ext | `src/extensions/**`, `src/ai/**` | Ext/Ports agent | types/ports | 核心 parse 改破坏往返 |
| O-Style | `styles/**` | Visual agent | tokens 契约 | 改 TS 逻辑 |
| O-Compat | `src/compat/**`, `src/index.ts` | Integration agent | public API | 扩大全局污染面 |
| O-Test | `tests/**` | QA agent | 全部 public + 内部测试导出 | 生产路径「顺手修功能」越权 |
| O-Host | `apps/**` 适配器、reference 消费侧 | Desktop agent | 仅 `@conex/mdx` public | `packages/conex-mdx/src/**` 内核 |

**冲突文件**（如 `types/editor.ts`、`registry/builtin.ts`）：一轮只允许一个 writer；其它 agent 提补丁说明给 orchestrator。

### 3.5 依赖方向（允许 / 禁止）

```
types ← schema ← model
              ↖ parse/serialize
types ← registry ← blocks
types ← editor ← render/edit/ui/motion
types ← extensions / ai（只依赖 ports 类型 + registry 注册 API）
compat → public index（单向）
host adapter → 仅 public index + style.css
```

| 禁止依赖 | 原因 |
|----------|------|
| `blocks` → `ui` 具体浮层 | 块定义应可无 UI 单测 |
| `parse` → `editor` | 往返必须纯 |
| `model` → `extensions/mermaid` | 可选能力污染真相层 |
| `host` → `src/**` 深路径 | 破坏封装与 semver |
| 循环：`ui` ↔ `model` 直接互 import | 经 controller 事务 |

---

## 4. 公共 API 表面（Public Surface）

### 4.1 设计原则

1. **小而稳**：宿主 90% 场景只用 `mount` + `getMarkdown`/`setMarkdown` + `destroy`。  
2. **Doc 可选**：`getDoc`/`setDoc` 服务离线加速与高级工具，不强制。  
3. **viewOnly 一等**：文件预览与编辑共用内核；UI **不**刷「只读」水印文案（产品约定）。  
4. **ports 可插**：AI / 媒体 / 打开路径 — 宿主注入，包内不实现云。  
5. **实验隔离**：不稳定 API 挂 `experimental` 或文档 `@experimental`，不进硬 semver 承诺。

### 4.2 推荐导出清单

| 符号 | 类别 | 稳定性 | 说明 |
|------|------|--------|------|
| `mount` | 工厂 | 稳定 | 主入口；返回 `MarkdownEditorHandle` |
| `createEditor` | 工厂 | 稳定（可选别名） | 与 mount 同义或无 DOM 预创建（若需要） |
| `parse` | 纯函数 | 稳定 | MD → Doc |
| `serialize` | 纯函数 | 稳定 | Doc → MD |
| `migrate` | 纯函数 | 稳定 | 旧 Doc → 当前 version |
| `createBlock` / `emptyDoc` / `cloneDoc` | 纯函数 | 稳定 | schema 助手 |
| `VERSION` | 常量 | 稳定 | Doc schema 版本（非包 semver） |
| `toggleMark` 等 inline 助手 | 纯函数 | 半稳定 | 高级宿主/测试 |
| `type Doc, Block, TextRun, …` | 类型 | 稳定 | 契约 |
| `type MarkdownEditorHandle` | 类型 | 稳定 | 实例面 |
| `type MarkdownEditorMountOptions` | 类型 | 稳定 | 挂载选项 |
| `type AiPorts` 等 | 类型 | 稳定 | 端口 |
| `window.MarkdownEditor`（IIFE） | 兼容 | 0.x–1.x | 见 §4.6 |

**不导出（宿主禁止依赖）**：`DocumentModel` 类细节、内部 `reconcile`、未文档化的 `Mdx*` 全局、深路径 `src/editor/ime`。

### 4.3 Handle 表面（实例 API）

| 方法 / 属性 | 必须 | 语义 |
|-------------|------|------|
| `getMarkdown()` | ✓ | 当前序列化 MD |
| `setMarkdown(md, opts?)` | ✓ | 重置内容；`emit`/`keepHistory` 可控 |
| `getDoc()` | ✓ | 深拷贝或只读快照策略文档化 |
| `setDoc(doc, opts?)` | ✓ | 经 `migrate`；非法 doc 抛或校验失败回调 |
| `flush()` | ✓ | 立即提交未落盘编辑态 + 触发 pending autosave |
| `destroy()` | ✓ | 卸监听、清 timer、移 DOM 子树约定 |
| `focus` / `blur` | ✓ | 可带 `blockId` |
| `isDirty()` | ✓ | 相对 last flush/set 基线 |
| `undo` / `redo` | ✓ | 返回是否成功 |
| `setReadOnly(ro)` / `viewOnly` | ✓ | 运行时切换预览/编辑 |
| `el` | ✓ | 根元素只读引用 |
| `getSelectionSnapshot?` | 可选 | AI/工具栏；可 experimental |

### 4.4 MountOptions 表面（分组）

| 分组 | 字段示例 | 职责 |
|------|----------|------|
| 内容 | `markdown` / `initialMarkdown` / `doc` | 初始源；MD 优先 |
| 模式 | `viewOnly` / `readOnly` / `density` | 预览与密度 |
| 节奏 | `autosaveMs` / `placeholder` | 防抖写盘 |
| 功能旗标 | `features.slash` / `dnd` / `selectionToolbar` / `asYouTypeMarks` / `tableMerge` / `ai` | 按面板裁剪 |
| 扩展 | `extensions.codeHighlight` / `math` / `mermaid` | 触发 peer 动态加载 |
| 回调 | `onChange` / `onAutosave` / `onDirtyChange` | 宿主状态 |
| 导航端口 | `onOpenPath` / `onOpenDoc` | 文件/双链 |
| 能力端口 | `ai` / `media`（若定义） | 可插拔 |
| 主题 | CSS 变量由宿主覆盖；选项内不塞色板大对象 | 样式隔离 |

### 4.5 Ports 表面

| Port | 方向 | 包内职责 | 宿主职责 |
|------|------|----------|----------|
| `onOpenPath(path)` | 出 | 点击文件 chip / 路径链时调用 | 打开预览或编辑器 |
| `onOpenDoc(title)` | 出 | wiki-link | 打开笔记 |
| `ai.rewrite/summarize/continue/review` | 入 | 收集上下文、应用替换、undo、busy UI | 模型、鉴权、限流 |
| `media.upload?`（若启用） | 入 | 展示占位与进度钩子 | 实际上传与 URL |
| `extensions.*` 加载失败 | 内 | 降级为源码/纯文本 | 保证 peer 安装或接受降级 |

**纪律**：缺省 `ai === undefined` → 相关入口隐藏或禁用，不报错刷屏。

### 4.6 viewOnly 契约

| 项 | 行为 |
|----|------|
| 输入 | 不出现编辑 caret；不挂 slash/dnd 编辑把手（或只读把手策略文档化） |
| 交互 | 链接/双链/文件 chip 仍可点（走 ports） |
| 代码/公式/图 | 读态渲染；不进入源码编辑 |
| API | `getMarkdown` 仍可用；`setMarkdown` 允许宿主换文 |
| UI 文案 | **不**展示「只读模式」标签（产品） |

### 4.7 IIFE 兼容表面

| 旧全局 | 新路径 | 备注 |
|--------|--------|------|
| `MarkdownEditor.mount` | 同 + ESM `mount` | 主兼容 |
| `parse` / `serialize` | 同 | |
| `migrate` | 同 | 建议暴露 |
| `window.MdxModel` 等 | **不承诺** | 桌面禁止依赖 |
| 多文件 script 顺序 | 单 `mdx.iife.js` | 顺序问题消失 |

废弃时间表：0.x 双轨 → 1.0 保留 IIFE → 2.0 可仅 ESM（若无裸 HTML 用户）。

---

## 5. 宿主适配器：Conex Desktop / Workbench

### 5.1 适配器定位

适配器是 **Host 侧薄胶层**，不属于包内核。目标：

- 把 React 生命周期 ↔ `mount`/`destroy`  
- 把应用 store 的 MD 字符串 ↔ `setMarkdown`/`onChange`  
- 把 AI Runtime ↔ `options.ai`  
- 把文件树/预览 ↔ `onOpenPath` / `onOpenDoc`  
- 把设计 token ↔ `.mdx-editor` CSS 变量  

**禁止**：在适配器里实现 parse、表格合并、IME 细节。

### 5.2 Desktop（Tauri + React）推荐结构

| 文件（宿主侧示例） | 职责 |
|--------------------|------|
| `MarkdownEditorHost.tsx` | ref + useEffect mount/destroy；props 同步 |
| `mdx-ai-bridge.ts` | 将桌面 Agent/模型 API 适配为 `AiPorts` |
| `mdx-theme.css` 或 token 覆盖段 | `--mdx-body` 等与 app 主题对齐 |
| 路由/面板入口 | Notebook body、文件预览 MD 分支 |

### 5.3 最小接线清单（工作量最小化）

| # | 任务 | 完成 |
|---|------|------|
| 1 | `"@conex/mdx": "workspace:*"` | ☐ |
| 2 | 一次 `import '@conex/mdx/style.css'` | ☐ |
| 3 | `MarkdownEditorHost`：mount / destroy / StrictMode 双调用防护 | ☐ |
| 4 | `value`/`onChange` ↔ markdown；外部更新 `emit: false` | ☐ |
| 5 | `onAutosave` 或防抖 `onChange` → 现有写盘命令 | ☐ |
| 6 | `onOpenPath` → 文件预览管线 | ☐ |
| 7 | `viewOnly` 用于 MD 预览替换 markdown-lite（可选） | ☐ |
| 8 | 主题 token 覆盖；**禁止**父级 `opacity` 叠正文 | ☐ |
| 9 | `features` 按面板裁剪（预览关 slash/dnd） | ☐ |
| 10 | 冒烟：打开笔记、中文 IME、保存、销毁无泄漏 | ☐ |

### 5.4 Workbench / 多 WebView

| 点 | 建议 |
|----|------|
| 多实例 | 每 WebView / 每面板独立 `mount`；状态在 handle 闭包 |
| 全局 | 不依赖 `window.MarkdownEditor` 业务状态 |
| CSP | 动态 import peer 使用固定说明符；脚本 nonce 随宿主 |
| 销毁 | 面板关闭必 `destroy`；清 autosave timer |

### 5.5 Tauri 边界

| 点 | 包内 | 宿主 |
|----|------|------|
| 文件系统 | 不碰 | `onChange` → invoke 写盘 |
| 剪贴板 | 浏览器 API | 特殊权限按需 |
| 安全 | escape、链接消毒 | 不把不可信 HTML 当 MD 绕过 |
| 可选 peer | external + 动态 import | desktop package.json 显式依赖需要的 peer |

### 5.6 适配器反模式

| 反模式 | 后果 | 纠正 |
|--------|------|------|
| 复制 `js/markdown-editor` 进 app | 双栈漂移 | workspace 依赖包 |
| 适配器内 `innerHTML` 改块 | 破坏 model/history | 只经 handle API |
| 把 Doc JSON 强塞全局 store | 序列化双源 | 默认只存 MD |
| 首包静态 import mermaid | 体积与启动恶化 | 扩展旗标 + 动态 import |
| 不调 `destroy` | 监听器泄漏 | effect cleanup |

---

## 6. 测试策略（unit / visual / property）

### 6.1 金字塔

```
        ╱╲
       ╱ E2E ╲          少量：Desktop Playwright 中文 IME / 保存
      ╱────────╲
     ╱  Visual  ╲       截图或 DOM 快照：块外观、表格 chrome、toolbar
    ╱────────────╲
   ╱   DOM/Mount  ╲     vitest + happy-dom/jsdom：mount、focus、destroy
  ╱────────────────╲
 ╱  Unit + Property ╲   parse/serialize/marks/migrate/history 纯逻辑
╱────────────────────╲
```

### 6.2 单元测试（Unit）

| 域 | 用例焦点 | 工具 |
|----|----------|------|
| schema | createBlock、migrate 1→2、validate 失败路径 | vitest |
| parse | GFM 标题/列表/表/代码围栏/任务列表 | vitest + fixtures |
| serialize | 与 parse 对称；转义边界 | vitest |
| inline | toggleMark、嵌套 normalize、空 run 合并 | vitest |
| model/history | undo 合并策略、事务原子性 | vitest |
| registry | 未知 type 降级/报错策略 | vitest |
| util/esc | XSS 向量字符串 | vitest |

**门禁**：`turbo test --filter=@conex/mdx` 失败阻断依赖该包的 app 发版。

### 6.3 属性测试（Property-based）

| 属性 ID | 陈述 | 建议生成器 |
|---------|------|------------|
| P-RT1 | `serialize(parse(md))` 在正规化规则下稳定（idempotent 二轮） | 随机 GFM 子集 |
| P-RT2 | `parse(serialize(doc))` 在规范 Doc 上结构等价（忽略 id 策略若文档约定重写） | 随机 Block 树 |
| P-MIG | `migrate` 幂等：`migrate(migrate(d)) == migrate(d)` | 旧 version 样本 |
| P-ESC | 任意用户文本经 esc 后不引入可执行标签 | 模糊字符串 |
| P-HIST | 任意合法 op 序列 undo 到空/基线不抛 | op 列表 |
| P-MARK | toggle 两次回到语义等价 runs | runs + 选区 |

工具可选：`fast-check` 与 vitest 集成。失败时缩小 counterexample 并入库 `tests/fixtures/property-regressions/`。

### 6.4 DOM / 挂载测试

| 场景 | 断言 |
|------|------|
| mount 空文档 | 根 `.mdx-editor` 存在；可输入 |
| setMarkdown | 块数与类型符合 |
| viewOnly | 无 contenteditable 编辑表面（或策略一致） |
| destroy | 再操作 handle 安全 no-op 或明确抛；监听移除 |
| 多实例 | 两 mount 互不串 doc |
| onChange | 编辑触发；`emit: false` 的 set 不触发 |

### 6.5 视觉测试（Visual）

| 层 | 做法 | 频率 |
|----|------|------|
| 组件 DOM 快照 | 关键块 read-view HTML 结构快照（稳定 class） | PR |
| 截图基线 | Playwright/Chromatic 类：段落、表、代码、callout、暗色 | 日或主分支 |
| 动效 | `prefers-reduced-motion` 开/关两条路径 | 抽检 |
| 主题 | token 覆盖后对比度抽检 | 发版 |

**纪律**：视觉断言绑 **稳定 class / data-\***，不绑临时生成 id；动画中帧不入基线。

### 6.6 往返与黄金文件（Golden）

| 套件 | 路径建议 | 内容 |
|------|----------|------|
| GFM 核心 | `tests/fixtures/gfm/*.md` | 常见语法 |
| Conex 扩展 | `tests/fixtures/conex/*.md` | callout、wiki-link、file-chip |
| 表格合并 | `tests/fixtures/table-merge/*` | 导出策略样本 |
| 回归 | `tests/fixtures/regressions/*` | 线上/property 缩小样例 |

流程：parse → serialize → parse；结构 diff + 必要时规范化 MD diff。

### 6.7 集成 / E2E（宿主）

| 用例 | 环境 |
|------|------|
| 中文 IME 连续输入不丢字、不双 history | 真浏览器 / Playwright |
| 保存后重开 MD 一致 | Desktop |
| 预览 viewOnly 可点内链 | Desktop FilePreview |
| 可选：开启 mermaid 后代码块降级与成功 | 装 peer 的 job |

### 6.8 质量门一览

| 门 | 命令/动作 | 阻断级别 |
|----|-----------|----------|
| 类型 | `tsc -p tsconfig.build.json` | 硬 |
| 单元+属性 | `vitest run` | 硬 |
| 行数/god file | lint script 或 review 清单 | 硬（超硬顶） |
| 包体积 | size snapshot 核心 gzip | 软→硬（M4 后） |
| 视觉 | 主分支基线 | 软（波动需人工） |
| public export 快照 | `exports` + api-extractor 可选 | 软→硬 1.0 |

---

## 7. 工程能力目录（Feature Catalog · 做到最好）

> 本节是 **工程维能力清单**，每项给出「做到最好」的目标态、验收与反模式。产品块能力见 v3 feature-matrix；此处聚焦 **包质量与 DX**。

### 7.1 DX（开发者体验）— 做到最好

| 能力 | 做到最好 | 验收 |
|------|----------|------|
| 类型即文档 | 公共类型完整 JSDoc；MountOptions 分组清晰 | IDE 悬停可集成 |
| 错误信息 | 非法 doc/容器给出可行动信息（缺 root、version 不支持） | 单测快照文案 |
| 严格模式友好 | React StrictMode 双 mount 不双写泄漏 | DOM 测 |
| 调试钩子 | 可选 `onDebug`/`experimental.getInternals` 仅 dev | 生产默认无 |
| monorepo 一致 | 与 logger/shared-types 同 turbo 体验 | `pnpm --filter @conex/mdx test` |
| 示例最短 | README 10 行可跑；reference 为活文档 | 新人 15 分钟挂上 |
| CHANGELOG | 每 MINOR 含 Migration 小节 | 发版检查表 |
| 源码映射 | sourcemap 开启；包内路径稳定 | 断点可进 dist |

**反模式**：无类型 any 铺地；错误 silent fail；README 只链内部 2k 行规格无最小示例。

### 7.2 模块化与可维护性 — 做到最好

| 能力 | 做到最好 | 验收 |
|------|----------|------|
| 无上帝文件 | §3 行数门 + 所有权矩阵 | CI/评审 |
| 注册表扩展 | 新块 = 新文件 + register，不改 controller 巨型 switch | 加块 PR diff 局部 |
| 纯核心 | parse/serialize/model 无 DOM 可选跑 | node 环境单测 |
| 副作用边界 | CSS sideEffects 声明；JS 默认无顶层 DOM | 导入类型不触 DOM |
| 兼容层隔离 | IIFE 单独入口，不污染 ESM 树 | rollup 图 |

### 7.3 Tree-shake 与分包 — 做到最好

| 能力 | 做到最好 | 验收 |
|------|----------|------|
| ESM 友好 | `exports` 明确；避免侧效 re-export 大桶 | 未用扩展不进 bundle |
| 扩展懒加载 | mermaid/katex/prism 动态 `import()` | 网络面板无预载 |
| 功能旗标 | `features`/`extensions` 决定注册，不加载死代码路径 | 关 slash 可不挂监听 |
| CSS 单文件可选 | 默认 `mdx.css`；进阶可源码 styles | 宿主一次 import |
| 体积目标 | 核心 JS gzip ≤ 40–60KB（初期 ≤80KB）；CSS ≤ 15–25KB | size CI |
| external peers | Vite `external` 正则 peer | 主包无 mermaid 源码 |

**反模式**：`import * as Everything`；在 `index.ts` 静态 import 全部 extensions。

### 7.4 Peer 依赖策略（mermaid / katex / 高亮）— 做到最好

| 能力 | Peer | 加载 | 失败降级 |
|------|------|------|----------|
| 代码高亮 | `prismjs` 或 `shiki`（optional） | `extensions.codeHighlight` | 纯文本 + 语言标签 |
| 数学 | `katex`（optional） | math 块 / `$` 扩展开启时 | 显示源码 |
| 图 | `mermaid`（optional） | mermaid 块可见时 | 源码 + 错误占位 |
| React 包装 | `react`（未来子路径） | `@conex/mdx/react` | 不进核心 |

| 做到最好细则 | 说明 |
|--------------|------|
| `peerDependenciesMeta.optional: true` | 未安装不警告阻断安装（视包管理器） |
| 语言组件按需 | 禁止 Prism 全语言表静态打入 |
| 版本下界写清 | 文档 + peer 范围；CI 抽测一对主流版本 |
| 不拼接用户字符串为 import 路径 | 安全 |
| 宿主显式依赖 | Desktop 若开启 mermaid，在 app 的 package.json 声明 |

### 7.5 运行时可靠与安全 — 做到最好

| 能力 | 做到最好 |
|------|----------|
| XSS | 文本 escape；白名单标签；链接禁 `javascript:` |
| IME | composition 一等；不在 composition 中拆 history |
| 销毁完备 | 监听、ResizeObserver、timer、浮层 portal 全清 |
| 多实例 | 无隐藏全局 doc 单例 |
| CSP | 不依赖 inline 事件处理器字符串 |
| 用户样式 | 不执行用户任意 style 注入为默认能力 |

### 7.6 API 稳定与版本 — 做到最好

| 能力 | 做到最好 |
|------|----------|
| 稳定面 | `mount` / markdown get-set / destroy / viewOnly |
| Doc 迁移 | migrate 只增不删旧路径 |
| CSS 前缀 | `mdx-` 稳定；状态 class 文档化 |
| semver | 破坏 = MAJOR；新旗标 = MINOR；doc.version 解耦 |
| 实验 API | 命名空间或标注，不进硬保证 |

### 7.7 可观测与性能 — 做到最好

| 能力 | 做到最好 |
|------|----------|
| 脏块 reconcile | 禁止全文 innerHTML 热路径 |
| 大文档钩子 | 预留虚拟化宿主 class/data；P1 可开 |
| autosave 合并 | 默认防抖；`flush` 强制 |
| 输入热路径 | 避免每键全量 serialize 到宿主（可 doc 脏标 + 防抖 MD） |
| 性能探针 | 可选 `performance.mark` 包在 dev flag |

### 7.8 无障碍与国际化 — 做到最好

| 能力 | 做到最好 |
|------|----------|
| 键盘 | slash/菜单箭头/Esc 关闭完整 |
| 焦点 | 浮层焦点陷阱与归还 |
| 中文 | `/` 与 `、` 触发；IME 不丢字 |
| 文案 | UI 字符串可后续 i18n 插槽（P1）；默认中英策略文档化 |
| reduced-motion | 动效系统遵从系统偏好 |

### 7.9 工程能力总表（优先级）

| ID | 能力 | 优先级 | 状态目标 |
|----|------|--------|----------|
| E1 | TS 公共契约 + Handle | P0 | M2 起硬 |
| E2 | 无 god file / 行数门 | P0 | 全程 |
| E3 | 零 core dependencies | P0 | 全程 |
| E4 | optional peer + 动态 import | P0 | M3 |
| E5 | tree-shake 扩展 | P0 | M3 |
| E6 | 单元 + 往返黄金 | P0 | M1 |
| E7 | 属性测试核心不变量 | P1 | M2–M3 |
| E8 | DOM mount 测 | P1 | M2 |
| E9 | 视觉基线 | P1 | M4 |
| E10 | size CI | P1 | M4 |
| E11 | api-extractor / export 快照 | P2 | 1.0 |
| E12 | `@conex/mdx/react` 官方薄包装 | P2 | 按需 |
| E13 | 虚拟化大文档 | P2 | 性能证据后 |
| E14 | i18n 插槽 | P2 | 产品需要时 |

---

## 8. 从 reference vanilla IIFE 迁移检查表

> 源：`reference/chat-composer-component/js/markdown-editor/*` + `css/markdown-editor/*`  
> 目标：`packages/conex-mdx`  
> 细节阶段划分对齐 [07-package-migration](../v3-complete/07-package-migration.md)。

### 8.1 阶段总览

| 阶段 | 名称 | 主要产出 | 可集成？ |
|------|------|----------|----------|
| A | 脚手架 | package.json、vite、空 mount | resolve 仅 |
| B | 纯逻辑 | schema/model/parse/serialize/inline | 数据层 |
| C | 编辑器壳 | controller 拆分、ui、styles | 灰发 |
| D | v3 能力在包内 | marks/table/motion/… | 功能完整 |
| E | reference 消费包 | demo 改依赖；去双源 | 演示=包 |
| F | 清理 | 全局最小化；文档改 npm | 1.0 准备 |

### 8.2 阶段 A — 脚手架

| # | 检查项 | ☐ |
|---|--------|---|
| A1 | 创建 `packages/conex-mdx` 目录与 `package.json`（name `@conex/mdx`） | ☐ |
| A2 | `exports`：`.`、`./style.css`、可选 `./iife` | ☐ |
| A3 | `peerDependencies` + `peerDependenciesMeta` optional | ☐ |
| A4 | `sideEffects: ["**/*.css"]` | ☐ |
| A5 | Vite library + tsc 声明管道接通 | ☐ |
| A6 | vitest 接通；turbo pipeline 注册 | ☐ |
| A7 | 空 `mount` 抛 `not implemented` 或返回 stub；desktop 可 resolve | ☐ |
| A8 | README 最小安装说明（可短） | ☐ |

### 8.3 阶段 B — 纯逻辑迁移

| # | 源（reference） | 目标 | ☐ |
|---|-----------------|------|---|
| B1 | `schema.js` | `src/schema/*` | ☐ |
| B2 | `model.js` | `src/model/*` | ☐ |
| B3 | `parse.js` | `src/parse/*` | ☐ |
| B4 | `serialize.js` | `src/serialize/*` | ☐ |
| B5 | `util.js`（esc/inline） | `src/util/*` + `src/inline/*` | ☐ |
| B6 | `registry.js` | `src/registry/*` | ☐ |
| B7 | `tests/.../roundtrip.test.js` | `tests/` 双跑或迁 TS | ☐ |
| B8 | 黄金 MD fixtures 入库 | `tests/fixtures` | ☐ |
| B9 | **无 DOM** 单测在 node 绿 | ☐ |

### 8.4 阶段 C — 编辑器壳（拆 god file）

| # | 检查项 | ☐ |
|---|--------|---|
| C1 | `editor.js` **按职责切开**迁入 `editor/`、`render/`、`edit/`、`ui/`，禁止整文件 2k 行永久化 | ☐ |
| C2 | `ui/selection-toolbar.js` → `ui/selection-toolbar.ts` | ☐ |
| C3 | `ui/table-chrome.js` → `ui/table-chrome.ts` | ☐ |
| C4 | `ui/code-highlight.js` → 调度层 + peer | ☐ |
| C5 | `index.js` → `src/index.ts` + `compat/iife.ts` | ☐ |
| C6 | CSS 从 `css/markdown-editor` → `packages/conex-mdx/styles`，产出 `dist/mdx.css` | ☐ |
| C7 | 行数门：controller ≤ 硬顶；CI 或清单记录 | ☐ |
| C8 | mount 可编辑段落 + history + IME 基线 | ☐ |
| C9 | destroy 泄漏检查（监听计数/假 stub） | ☐ |

### 8.5 阶段 D — v3 能力只进包

| # | 检查项 | ☐ |
|---|--------|---|
| D1 | 行内实时 marks 在包内实现/完善 | ☐ |
| D2 | 表格合并与 TSV 等在包内 | ☐ |
| D3 | motion 系统与 reduced-motion | ☐ |
| D4 | 代码块 read/edit 单壳 | ☐ |
| D5 | AI ports 接线（无模型） | ☐ |
| D6 | **规则**：新功能不进 reference 独苗 | ☐ |
| D7 | 扩展 mermaid/katex 动态 import 通路 | ☐ |

### 8.6 阶段 E — reference 改消费包

| # | 检查项 | ☐ |
|---|--------|---|
| E1 | `markdown-editor.html` / 相关页改为 ESM alias 或 `mdx.iife.js` | ☐ |
| E2 | 旧 `js/markdown-editor/*` 删除或薄 re-export，防外链断裂 | ☐ |
| E3 | 演示回归：IME、slash、表、预览 viewOnly | ☐ |
| E4 | 文档 12 集成契约改为「依赖 `@conex/mdx`」 | ☐ |
| E5 | 确认无「半旧半新」双实现同时修 bug | ☐ |

### 8.7 阶段 F — 清理与 1.0 准备

| # | 检查项 | ☐ |
|---|--------|---|
| F1 | `window.Mdx*` 仅保留 compat 最小集 | ☐ |
| F2 | public export 清单冻结；实验 API 标注 | ☐ |
| F3 | size snapshot 基线入库 | ☐ |
| F4 | CHANGELOG 与 migrate 说明 | ☐ |
| F5 | Desktop 正式依赖；去掉临时 copy | ☐ |
| F6 | 所有权矩阵与行数门写入 CONTRIBUTING 或包 README | ☐ |

### 8.8 文件映射速查（reference → 包）

| reference 路径 | 包路径 |
|----------------|--------|
| `js/markdown-editor/index.js` | `src/index.ts` + `compat/iife.ts` |
| `js/markdown-editor/schema.js` | `src/schema/*` |
| `js/markdown-editor/model.js` | `src/model/*` |
| `js/markdown-editor/parse.js` | `src/parse/*` |
| `js/markdown-editor/serialize.js` | `src/serialize/*` |
| `js/markdown-editor/registry.js` | `src/registry/*` |
| `js/markdown-editor/editor.js` | `src/editor/*` + `render/*` + `edit/*`（拆分） |
| `js/markdown-editor/ui/*` | `src/ui/*` |
| `js/markdown-editor/util.js` | `src/util/*` + `inline/*` |
| `css/markdown-editor/*` | `styles/*` → `dist/mdx.css` |
| `tests/markdown-editor/*` | `packages/conex-mdx/tests/*` |

### 8.9 迁移风险与缓解

| 风险 | 缓解 |
|------|------|
| editor.js 难拆 | 先测后搬；按事件域切片；禁止边搬边加功能 |
| 双轨漂移 | E 阶段起 reference 只消费包；D 阶段新功能只进包 |
| peer 在 Tauri 打包失败 | app 显式依赖；Vite external 联调 |
| 类型过严卡 demo | 内部 Loose 类型 vs public 严格类型分层 |
| CSS 与 app token 双份 | 包内仅 fallback；宿主覆盖表文档化 |
| IME 回归 | 真浏览器用例必跑，不单靠 jsdom |
| 行数门被「临时」永久化 | 例外必须带拆除 issue 与日期 |

### 8.10 迁移完成签字栏（人工）

| 角色 | 确认项 | 签名/日期 |
|------|--------|-----------|
| 包维护者 | A–F 检查表全勾；无 god file | |
| 桌面集成 | Desktop 清单 10 项；IME/保存冒烟 | |
| QA | 单元/属性/往返门禁绿；视觉抽检 | |
| 架构评审 | 公共 API 面与 ports 冻结说明 | |

---

## 9. 与周边文档的关系

| 文档 | 关系 |
|------|------|
| [07-package-migration](../v3-complete/07-package-migration.md) | 迁移步骤与 package.json 草稿的详细版；本册补 **模块门禁、所有权、测试金字塔、工程能力目录** |
| [11-no-god-file-charter](../v3-complete/11-no-god-file-charter.md) | 宪章原文；本册给行数数字与所有权矩阵 |
| [11-system-architecture](../11-system-architecture.md) | 运行时分层与块模型；本册给包边界与交付形态 |
| [12-integration-contract](../12-integration-contract.md) | 旧 IIFE 集成；迁移后以本册 §4–§5 与 07 为准回写 |
| [08-ai-ports](../v3-complete/08-ai-ports.md) | AI 端口语义细节 |
| [10-data-format](../10-data-format.md) | Doc 字段真相 |
| CROSSCUTTING | 全局决策（前缀 `mdx-`、D 编号）冲突时以冻结决策 + 本册工程门禁为准 |

---

## 10. 里程碑（工程视角）

| 里程碑 | 工程产出 | 宿主可做什么 |
|--------|----------|--------------|
| M0 | 脚手架 + exports | 挂依赖、resolve |
| M1 | 纯逻辑 + 往返测 | 离线 parse/serialize 工具 |
| M2 | mount 编辑 + history + IME + 行数门 | Desktop 灰发笔记 |
| M3 | slash/dnd/toolbar + peer 懒加载 | 体验可用；可选高亮 |
| M4 | v3 表/marks/motion + size/视觉 | 功能完整候选 |
| M5 | API freeze + 迁移 F 完成 | 1.0 正式依赖 |

---

## 11. 评审用论证摘要

1. **Desktop 已是 TS monorepo** — 继续以全局 JS 夹作为交付物是双税。  
2. **类型化 Handle/Doc** — 集成错误前移到编译期。  
3. **无上帝文件 + 所有权矩阵** — 多 Agent 可并行且可回滚。  
4. **公共面极小、ports 可插** — 内核稳，宿主换 AI/FS 无 fork。  
5. **零 core 依赖 + optional peer** — 体积、安全、CSP 可控；mermaid/katex 做到最好的姿势是懒加载与降级。  
6. **测试金字塔含 property** — 往返与 migrate 不变量可机器守门。  
7. **迁移检查表可勾选** — 从 reference IIFE 到包可审计、可签字。

---

## 12. 本册维护

| 项 | 约定 |
|----|------|
| 变更触发 | 新增公共导出、调整行数门、peer 策略变更、迁移阶段定义变更 |
| 作者 | 架构 / 包维护 agent |
| 语言 | 中文 UTF-8 为主；标识符与路径保持代码原名 |
| 禁止 | 本册堆业务块视觉像素说明（放到 visual / blocks 分册） |

---

**文档结束（feature-catalog / 08-package-modules）**  
**目标包**：`packages/conex-mdx`（`@conex/mdx`）  
**关键词**：无上帝文件 · 公共 API · ports · Desktop 适配器 · unit/visual/property · tree-shake · peer mermaid/katex · IIFE 迁移检查表 · 做到最好
