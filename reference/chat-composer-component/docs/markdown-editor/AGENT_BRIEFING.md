# Agent Briefing — Markdown 编辑器设计/实现

> **每个参与本项目的子 agent 必须先读本文件**，再读自己的专题文档。  
> 路径：`reference/chat-composer-component/docs/markdown-editor/`

---

## 0. 2026-08-03 必读（先于一切专题）

| 文档 | 作用 |
|------|------|
| **[BANNED-VISUAL-UX.md](./BANNED-VISUAL-UX.md)** | 硬禁：全行激活 chrome、读/写两套皮、半吊子可编 |
| **[ux-readiness/12-FUSED-EDITOR-REFACTOR-SPEC.md](./ux-readiness/12-FUSED-EDITOR-REFACTOR-SPEC.md)** | **~2k 行执行真源**：Schema/工单/DoD/反模式（多 Agent 必读） |
| **[ux-readiness/11-SYSTEMIC-REFACTOR-PLAN.md](./ux-readiness/11-SYSTEMIC-REFACTOR-PLAN.md)** | 方向摘要：否决 block-per-row；PM 文档流 |
| ux-D10 / ux-D11 | `ux-readiness/08-decision-log.md` |

**禁止**再把「按行 enterEdit 换壳」当终局方案继续堆大功能。旧 IIFE 仅止血。

---

## 1. 你在做什么

为 Conex 设计（或实现）一套 **融合实时预览** Markdown 编辑器：

- Typora 式：所见即可编 + Markdown 可触达
- Notion 式块把手 / slash（`/` 与 `、`），**不要**全行激活描边
- 跨行选区、待办可勾、代码/公式/callout 在文档流内可交互
- 序列化真相仍是 GFM + Conex 扩展
- 首个宿主：对话流 `NotebookPanel`

这不是再写一个 `marked()` 包装，也不是「点一行换一皮」的行编辑器。

---

## 2. 全局上下文（必知）

### 2.1 仓库位置

- Reference 原型：`reference/chat-composer-component/`
- 对话流规格：`CONVERSATION_FLOW_SPEC.md`
- 当前 Notebook：`js/components/NotebookPanel.js`（无硬切换，但实时预览仍弱）
- 当前 MD：`js/markdown-lite.js`（极简，不适合块编辑）

### 2.2 产品调性

- 冷静、精致、Composer 同族 surface
- 中文产品：命令触发支持 **`/` 与 `、`（顿号）**
- 借 Notion 的 **块交互结构**，不借整套皮肤/品牌

### 2.3 已决决策（勿推翻）

| 议题 | 决策 |
|------|------|
| 预览/源码硬切换双模式 | **不做** 默认交互 |
| 编辑模型 | 块/行级；目标是实时渲染 |
| 序列化主格式 | Markdown（扩展语法需可往返） |
| 代码文件 | 不进 Notebook；Notebook 只服务文档类 artifact |
| 工具摘要行 | 文字与 chevron 在左簇（已改流 UI，编辑器控件也避免两端拉扯） |

### 2.4 开放/建议

| 议题 | 建议默认 |
|------|----------|
| 引擎基座 | 自研 Block Model + 轻量解析；或评估 ProseMirror/TipTap/Lexical **仅作参考**，reference 阶段可 vanilla 先验证交互 |
| 虚拟列表 | 文档 >500 块再强制；先设计 API 可插拔 |
| 协同 | 非目标 v1 |
| 表格编辑 | v1 必须可建表、改单元格；复杂合并表 v2 |

---

## 3. 写作规范（设计文档）

1. **UTF-8**；中文用工具写入，禁止 PowerShell 重定向中文导致 `?`。  
2. 每篇文档必须有：目标、非目标、数据形状、交互、边界情况、a11y、测试点、分期。  
3. 使用可实现的 TypeScript 类型草稿（即使 runtime 是 JS）。  
4. 引用其他文档用相对链接。  
5. 禁止空话；给状态机、伪代码、DOM 结构、CSS class 契约。  
6. 与 `README.md` 地图保持文件名一致；新增文件要回写 README 表。

---

## 4. 实现时额外注意

- **不要** 改坏对话流 Phase 0–2（Purpose/Permission/Subagent）除非任务明确。  
- Notebook 外壳（pin、拖顶栏、Esc）行为保留。  
- 块注册表优先：`registerBlockType({ type, parse, serialize, render, edit, slash })`。  
- 性能：输入路径禁止对全文 `innerHTML = render(all)`。  
- 安全：Markdown HTML 消毒；链接 `rel`；禁任意 script。  
- 测试：至少规划 parse/serialize 往返与 slash 插入用例。

---

## 5. 任务拆分约定

| 角色 | 负责文档 | 不越界 |
|------|----------|--------|
| Vision | `00-product-vision.md` | 不写引擎细节 |
| Architecture | `01-architecture.md` | 不列全 slash 词条 |
| Block catalog | `02-block-catalog.md` + `blocks/*` | 不写 DnD 物理 |
| Line renderer | `03-line-renderer.md` | 不写命令面板 UI |
| DnD | `04-dnd-reorder.md` | 不写扩展语法 |
| Slash | `05-slash-commands.md` | 不写表格单元格算法细节（可引用 catalog） |
| Extensions | `06-extensions.md` + `extensions/*` | 不写视觉 token 全集 |
| Visual | `07-visual-system.md` | 不写序列化算法 |
| Integration + Roadmap | `08` + `09` | 汇总依赖与 DoD |

并行时：**只写自己的文件**；交叉依赖用「见 xxx」占位，由整合轮合并。

---

## 6. 完成定义（单篇设计）

- [ ] 可独立交给实现 agent 开工而不靠口头补充  
- [ ] 含失败/空态/超长文档  
- [ ] 含与 Markdown 往返策略  
- [ ] 含 class 命名与 DOM 草图  
- [ ] 中文完整可读、无乱码  

---

## 7. 当前轮次目标

**设计轮**：把方案拆到可实施粒度；**本轮不强制写完整编辑器代码**（工具流小修除外）。  
实现轮在路线图评审后再开多 agent。
