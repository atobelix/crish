# @conex/mdx — 模块所有权与架构地图

> **波次**：W10（feature-catalog / 08）  
> **原则**：无上帝文件 · 模块有主 · API 有面 · 端口可插  
> **权威规格**：[feature-catalog/08-package-modules.md](../../reference/chat-composer-component/docs/markdown-editor/feature-catalog/08-package-modules.md)  
> **宪章**：[v3-complete/11-no-god-file-charter.md](../../reference/chat-composer-component/docs/markdown-editor/v3-complete/11-no-god-file-charter.md)

本文件是脚手架阶段的**模块主人图**。实现 agent 只改自己所有权路径；跨界由 orchestrator 合并。

---

## 1. 分层（宿主可替换，内核稳定）

```
Host（Desktop / Workbench / FilePreview / reference demo）
  └─ Adapter（薄）：mount / destroy / ports
       └─ Public Surface（@conex/mdx）
            └─ EditorController
                 ├─ Model / History
                 ├─ Registry + Blocks
                 ├─ Parse / Serialize
                 ├─ UI Plugins（slash / dnd / table / sel）
                 └─ Ports（AI / Media / OpenPath）
```

| 层 | 职责 | 禁止 |
|----|------|------|
| Host / Adapter | 存盘、主题、AI 实现、文件打开 | 直接改 block DOM、绕过 model 写 text |
| Public Surface | 稳定符号、类型导出 | 泄漏内部路径 |
| Controller | 事件路由、事务提交 | 具体 MD 语法、表格算法 |
| Model | Doc 真相、undo/redo | 碰 DOM、发网络 |
| Ports | 能力插槽接口 | 内置密钥、内置云上传 |

---

## 2. 目标源码树（迁移到位后）

当前脚手架只含 `src/index.ts` + `src/types.ts`。下列目录为 **阶段 B–D 迁入目标**，禁止再堆进单文件 `editor.ts`。

```
packages/conex-mdx/
├── package.json
├── ARCHITECTURE.md          # 本文件
├── MIGRATION.md
├── README.md
├── src/
│   ├── index.ts             # 公共 re-export（薄，≤120 行）
│   ├── types.ts             # 脚手架合并类型；后拆 types/*
│   ├── types/               # O-Types
│   ├── schema/              # O-Schema
│   ├── model/               # O-Model
│   ├── parse/ · serialize/  # O-Parse
│   ├── inline/              # O-Inline
│   ├── registry/ · blocks/  # O-Blocks
│   ├── editor/ · render/ · edit/  # O-Editor
│   ├── ui/ · motion/        # O-UI
│   ├── extensions/ · ai/    # O-Ext
│   ├── util/
│   └── compat/iife.ts       # O-Compat
├── styles/                  # O-Style（从 css/markdown-editor 迁）
└── tests/                   # O-Test
```

---

## 3. 所有权矩阵（多 Agent 并行）

| 所有权 ID | 路径 glob | 主责 | 可只读依赖 | 禁止写入 |
|-----------|-----------|------|------------|----------|
| **O-Types** | `src/types/**`、`src/types.ts` | Schema/API agent | — | 业务实现塞进类型垃圾场 |
| **O-Schema** | `src/schema/**` | Schema agent | types | editor/ui |
| **O-Model** | `src/model/**` | Model agent | types, schema | parse 语法、DOM |
| **O-Parse** | `src/parse/**`, `src/serialize/**` | Parse agent | types, schema, blocks 钩子 | ui、controller 事件 |
| **O-Inline** | `src/inline/**` | Inline agent | types | table 专用逻辑 |
| **O-Blocks** | `src/blocks/**`, `src/registry/**` | Blocks agent | types, schema | host adapter |
| **O-Editor** | `src/editor/**`, `src/render/**`, `src/edit/**` | Editor agent | model, registry | peer 全量语言表 |
| **O-UI** | `src/ui/**`, `src/motion/**` | UI agent | types, editor 事件 | model 内部硬编码 |
| **O-Ext** | `src/extensions/**`, `src/ai/**` | Ext/Ports agent | types/ports | 核心 parse 破坏往返 |
| **O-Style** | `styles/**` | Visual agent | tokens 契约 | 改 TS 逻辑 |
| **O-Compat** | `src/compat/**`, `src/index.ts` | Integration agent | public API | 扩大全局污染面 |
| **O-Test** | `tests/**` | QA agent | public + 测试导出 | 生产路径「顺手修功能」 |
| **O-Host** | `apps/**` 适配器、reference 消费侧 | Desktop agent | 仅 `@conex/mdx` public | `packages/conex-mdx/src/**` 内核 |

**冲突文件**（`types`、`registry/builtin`）：一轮只允许一个 writer。

---

## 4. 依赖方向

```
types ← schema ← model
              ↖ parse/serialize
types ← registry ← blocks
types ← editor ← render/edit/ui/motion
types ← extensions / ai（ports 类型 + registry API）
compat → public index（单向）
host adapter → 仅 public index + style.css
```

| 禁止 | 原因 |
|------|------|
| `blocks` → `ui` 具体浮层 | 块定义应可无 UI 单测 |
| `parse` → `editor` | 往返必须纯 |
| `model` → `extensions/mermaid` | 可选能力污染真相层 |
| `host` → `src/**` 深路径 | 破坏封装 |
| `ui` ↔ `model` 直接互 import | 经 controller 事务 |

---

## 5. 行数门（no god files）

| 规则 | 内容 |
|------|------|
| G1 | **禁止**单文件同时 parse + serialize + model + render + table + slash + dnd + AI |
| G2 | **禁止**向遗留 `editor.js` / 未来 `editor/controller.ts` 堆新功能超顶 |
| G5 | 默认 **≤ 400 行**；软顶 **500**；硬顶 **600**（超则必须拆） |
| G6 | util 垃圾桶禁止超过 200 行无主题分区 |
| `index.ts` | re-export 硬顶 **120** 行，禁止业务逻辑 |

| 模块 | 软顶 | 硬顶 |
|------|------|------|
| types / schema / model | 300–400 | 400–550 |
| parse / serialize / blocks | 350–400 | 500–600 |
| editor/controller | 400 | **500** |
| ai/ports 接线 | 200 | 300 |
| compat/iife | 150 | 250 |

---

## 6. reference 脚本 → 包模块（速查）

| reference（现状运行时） | 目标包路径 | 所有权 |
|-------------------------|------------|--------|
| `js/markdown-editor/index.js` | `src/index.ts` + `compat/iife.ts` | O-Compat |
| `schema.js` | `src/schema/*` | O-Schema |
| `model.js` | `src/model/*` | O-Model |
| `parse.js` / `serialize.js` | `src/parse/*` / `src/serialize/*` | O-Parse |
| `registry.js` | `src/registry/*` | O-Blocks |
| `editor.js` | **拆分** → `editor/*` + `render/*` + `edit/*` | O-Editor |
| `ui/*` | `src/ui/*` | O-UI |
| `edit/*` | `src/edit/*` | O-Editor |
| `blocks/*` | `src/blocks/*` | O-Blocks |
| `table/*` | `src/ui/table-*` 或 `blocks/table/*` | O-UI / O-Blocks |
| `util.js` | `src/util/*` + `inline/*` | O-Inline / util |
| `css/markdown-editor/*` | `styles/*` | O-Style |

完整检查表见 [MIGRATION.md](./MIGRATION.md)。

---

## 7. 公共 API 面（稳定）

仅从 `src/index.ts` 导出宿主可用符号：

- 工厂：`mount` / `createEditor`
- 纯函数：`parse` / `serialize` / `migrate` / `emptyDoc` / `VERSION`
- 类型：`Doc` / `Block` / `MountOptions` / `MarkdownEditorHandle` / `AiPort` / `UploadImagePort` …

**不导出**：`DocumentModel` 细节、内部 `reconcile`、深路径模块。

---

## 8. 维护约定

| 项 | 约定 |
|----|------|
| 变更触发 | 新增公共导出、行数门调整、所有权路径变更 |
| 语言 | 中文说明 + 代码标识符英文 |
| 脚手架阶段 | 新功能仍优先进 reference **按模块文件**落地，并在 MIGRATION 映射表登记目标路径；**禁止**扩大 `editor.js` 上帝文件 |
