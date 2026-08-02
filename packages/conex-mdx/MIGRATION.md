# @conex/mdx — 迁移检查表（阶段 A–F）

> **源**：`reference/chat-composer-component/js/markdown-editor/*` + `css/markdown-editor/*`  
> **目标**：`packages/conex-mdx`  
> **规格**：feature-catalog [08-package-modules.md](../../reference/chat-composer-component/docs/markdown-editor/feature-catalog/08-package-modules.md) §8  
> **细节**：v3-complete [07-package-migration.md](../../reference/chat-composer-component/docs/markdown-editor/v3-complete/07-package-migration.md)

**规则**：dual 期短；**新功能只进 TS 包路径（或 reference 内已拆好的模块文件）**，禁止向 `editor.js` 堆逻辑。本脚手架完成 **阶段 A 子集**（目录 + 类型 + stub），**不** bulk 拷贝 JS。

---

## 阶段总览

| 阶段 | 名称 | 主要产出 | 可集成？ | 脚手架状态 |
|------|------|----------|----------|------------|
| **A** | 脚手架 | package.json、类型、空 mount | resolve / import type | **部分完成**（见下） |
| **B** | 纯逻辑 | schema/model/parse/serialize/inline | 数据层 | ☐ |
| **C** | 编辑器壳 | controller 拆分、ui、styles | 灰发 | ☐ |
| **D** | v3 能力在包内 | marks/table/motion/ports… | 功能完整 | ☐ |
| **E** | reference 消费包 | demo 改依赖；去双源 | 演示=包 | ☐ |
| **F** | 清理 | 全局最小化；文档改 npm | 1.0 准备 | ☐ |

---

## 阶段 A — 脚手架

| # | 检查项 | 状态 |
|---|--------|------|
| A1 | 创建 `packages/conex-mdx` 与 `package.json`（name `@conex/mdx`） | ☑ 本脚手架 |
| A2 | `exports`：`.`（后续补 `./style.css`、`./iife`） | ☑ `.` → `src/index.ts`；style/iife 待 build |
| A3 | `peerDependencies` + `peerDependenciesMeta` optional | ☑ 已声明 |
| A4 | `sideEffects: ["**/*.css"]` | ☑ |
| A5 | Vite library + tsc 声明管道 | ☐ 后续（当前 typecheck 用 tsc noEmit） |
| A6 | vitest + turbo pipeline 注册 | ☐ 见文末 workspace 说明 |
| A7 | 空 `mount` 抛 not implemented / stub | ☑ `src/index.ts` |
| A8 | README 最小安装与端口说明 | ☑ |

**Workspace 注册（需人工/调度一次）**：

根目录 `package.json` 的 `workspaces` 当前是**显式列表**（非 `packages/*` glob）。接入时：

1. 在 `workspaces` 数组追加 `"packages/conex-mdx"`
2. （可选）`typecheck` script 追加 `&& tsc --noEmit -p packages/conex-mdx`
3. 根目录执行 `npm install` 以链接 workspace
4. 宿主：`"@conex/mdx": "*"` 或 `"workspace:*"`（视包管理器；本仓为 npm workspaces）

在未写入 workspaces 前，仍可用相对路径 `import type { Doc } from '../../../packages/conex-mdx/src/index.ts'` 做类型预挂。

---

## 阶段 B — 纯逻辑迁移

| # | 源（reference） | 目标 | ☐ |
|---|-----------------|------|---|
| B1 | `schema.js` | `src/schema/*` | ☐ |
| B2 | `model.js` | `src/model/*` | ☐ |
| B3 | `parse.js` | `src/parse/*` | ☐ |
| B4 | `serialize.js` | `src/serialize/*` | ☐ |
| B5 | `util.js`（esc/inline） | `src/util/*` + `src/inline/*` | ☐ |
| B6 | `registry.js` | `src/registry/*` | ☐ |
| B7 | `tests/markdown-editor/roundtrip.test.js` | `tests/` 双跑或迁 TS | ☐ |
| B8 | 黄金 MD fixtures 入库 | `tests/fixtures` | ☐ |
| B9 | **无 DOM** 单测在 node 绿 | ☐ |

---

## 阶段 C — 编辑器壳（拆 god file）

| # | 检查项 | ☐ |
|---|--------|---|
| C1 | `editor.js` **按职责切开**迁入 `editor/`、`render/`、`edit/`、`ui/`，禁止整文件 2k 行永久化 | ☐ |
| C2 | `ui/selection-toolbar.js` → `ui/selection-toolbar.ts` | ☐ |
| C3 | `ui/table-chrome.js` → `ui/table-chrome.ts` | ☐ |
| C4 | `ui/code-highlight.js` → 调度层 + peer | ☐ |
| C5 | `index.js` → `src/index.ts` + `compat/iife.ts` | ☐ |
| C6 | CSS `css/markdown-editor` → `styles/`，产出 `dist/mdx.css` | ☐ |
| C7 | 行数门：controller ≤ 硬顶 | ☐ |
| C8 | mount 可编辑段落 + history + IME 基线 | ☐ |
| C9 | destroy 泄漏检查 | ☐ |

---

## 阶段 D — v3 能力只进包

| # | 检查项 | ☐ |
|---|--------|---|
| D1 | 行内实时 marks 在包内 | ☐ |
| D2 | 表格合并与 TSV 等在包内 | ☐ |
| D3 | motion + reduced-motion | ☐ |
| D4 | 代码块 read/edit 单壳 | ☐ |
| D5 | AI ports 接线（无模型） | ☐ |
| D6 | **规则**：新功能不进 reference 独苗 | ☐ |
| D7 | mermaid/katex 动态 import 通路 | ☐ |

---

## 阶段 E — reference 改消费包

| # | 检查项 | ☐ |
|---|--------|---|
| E1 | `markdown-editor.html` 等改为 ESM alias 或 `mdx.iife.js` | ☐ |
| E2 | 旧 `js/markdown-editor/*` 删除或薄 re-export | ☐ |
| E3 | 演示回归：IME、slash、表、viewOnly | ☐ |
| E4 | 文档 12 集成契约改为依赖 `@conex/mdx` | ☐ |
| E5 | 无「半旧半新」双实现同时修 bug | ☐ |

---

## 阶段 F — 清理与 1.0 准备

| # | 检查项 | ☐ |
|---|--------|---|
| F1 | `window.Mdx*` 仅 compat 最小集 | ☐ |
| F2 | public export 清单冻结 | ☐ |
| F3 | size snapshot 基线 | ☐ |
| F4 | CHANGELOG 与 migrate 说明 | ☐ |
| F5 | Desktop 正式依赖；去掉临时 copy | ☐ |
| F6 | 所有权矩阵与行数门写入 CONTRIBUTING 或 README | ☐ |

---

## 文件映射速查

| reference 路径 | 包路径 |
|----------------|--------|
| `js/markdown-editor/index.js` | `src/index.ts` + `compat/iife.ts` |
| `js/markdown-editor/schema.js` | `src/schema/*` |
| `js/markdown-editor/model.js` | `src/model/*` |
| `js/markdown-editor/parse.js` | `src/parse/*` |
| `js/markdown-editor/serialize.js` | `src/serialize/*` |
| `js/markdown-editor/registry.js` | `src/registry/*` |
| `js/markdown-editor/editor.js` | `src/editor/*` + `render/*` + `edit/*`（**拆分**） |
| `js/markdown-editor/ui/*` | `src/ui/*` |
| `js/markdown-editor/edit/*` | `src/edit/*` |
| `js/markdown-editor/blocks/*` | `src/blocks/*` |
| `js/markdown-editor/table/*` | `src/ui/` 或 `blocks/table/*` |
| `js/markdown-editor/util.js` | `src/util/*` + `inline/*` |
| `css/markdown-editor/*` | `styles/*` → `dist/mdx.css` |
| `tests/markdown-editor/*` | `packages/conex-mdx/tests/*` |

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| editor.js 难拆 | 先测后搬；按事件域切片；禁止边搬边加功能 |
| 双轨漂移 | E 起 reference 只消费包；D 起新功能只进包 |
| peer 在 Tauri 打包失败 | app 显式依赖；Vite external 联调 |
| IME 回归 | 真浏览器用例必跑 |
| 行数门被「临时」永久化 | 例外必须带拆除 issue 与日期 |

---

## 签字栏（人工）

| 角色 | 确认项 | 签名/日期 |
|------|--------|-----------|
| 包维护者 | A–F 检查表；无 god file | |
| 桌面集成 | Desktop 清单 10 项；IME/保存冒烟 | |
| QA | 单元/属性/往返门禁绿 | |
| 架构评审 | 公共 API 与 ports 冻结 | |
