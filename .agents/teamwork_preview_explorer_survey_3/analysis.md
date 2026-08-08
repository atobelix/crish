# 多Agent迭代修复文档体系需求调查与规范结构分析报告

## 摘要与执行概述

本报告由 **Explorer 3 — 多 Agent 修复框架需求调查员** 撰写，旨在对 Conex 项目中“基于多 Agent 协同的自上而下软件需求迭代修复方案”的构建需求进行深度探究与规范结构设计。本报告全面梳理了 **R1（基准需求文档）**、**R2（四轮次协同编写与六阶段修复全链路）**、**R3（解耦子 Agent 提示词手册）** 以及 **验收标准（Acceptance Criteria）**，为后续 Agent 团队编写生产级多 Agent 修复方案文档体系提供精确的规范蓝图与逻辑支撑。

---

## 1. R1：Tiptap Chat Composer 迁移基准软件需求规范（SRS）结构设计

针对 `reference/chat-composer-tiptap` 独立原型至主项目 `apps/crish-desktop` 的无缝迁移需求，基准 SRS 需覆盖以下核心技术规范与 UI/UX 约束：

### 1.1 架构与技术栈融合规范
- **原型基线 (`reference/chat-composer-tiptap`)**：
  - React 19 + Tiptap 3.x (`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-placeholder`, `@tiptap/extension-task-list`, `@tiptap/extension-task-item`)。
  - 块级拖拽引擎：`tiptap-extension-global-drag-handle`。
  - 斜杠命令 (`/` Slash Menu)：基于 `@tiptap/suggestion` + `tippy.js` 弹出渲染。
  - 样式规范：Tailwind CSS / Typography 插件。
- **主项目目标环境 (`apps/crish-desktop`)**：
  - Tauri WebView2 + React 19 + CSS Modules / Global Design System (`chat-composer.css`) + Zustand 状态树。
  - 分层解耦契约：前端 UI 仅通过 `storeAccess` / IPC transport 与引擎交互，严禁逆向依赖。

### 1.2 核心功能需求拆解
1. **块级富文本与 Markdown 混合渲染 (Block-Level Hybrid Editor)**：
   - 支持 H1-H4 标题、段落、无序/有序列表、代码块、引用块的实时转换与内联 Markdown 解析。
2. **Notion 式块拖拽 handle (Global Drag Handle)**：
   - 适配 `tiptap-extension-global-drag-handle`，实现 Hover 显示拖拽柄 (`GripVertical`)，支持块级重排与跨层级平退。
3. **交互式任务列表 (Interactive Task List)**：
   - 结合 `TaskList` 和 `TaskItem` 扩展，支持嵌套 Checkbox 勾选与状态持久化。
4. **斜杠命令菜单 (Slash Command Palette)**：
   - 输入 `/` 时通过 `tippy.js` 弹窗定位，支持键盘上下键选择与 Enter 确认，快速插入各种 Block 元素。
5. **上下文与附件协同 (Attachment & Context Bar Integration)**：
   - 集成 `ComposerAttachmentBar` 与 `PermissionModeMenu`，支持文件拖拽、图片预览及模式切换。

### 1.3 界面与交互硬性约束 (`AGENTS.md` 规范)
1. **禁用原生 HTML `title` 属性**：
   - Hover 提示必须统一下载并使用项目自定义 `<Tooltip>` 组件（如从 `@/components/settings/SettingsUI` 导入），维持圆角胶囊设计与柔和阴影。
2. **输入框 Focus 状态对比度控制 (Focus Contrast Guardrail)**：
   - 严禁添加重度 `box-shadow`。
   - 输入框激活/Focus 边框色变程度不得超过基准背景与文字对比度的 **10%**（推荐 **3% ~ 6%** 柔和混合 `color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`；落地空态输入框变色 ≤5%）。
3. **依赖与循环依赖红线 (CI Coupling Assertions)**：
   - 全局硬阻断循环依赖 (`no-circular`)，扫描耗时控制在 2 秒以内；单 UI 组件文件限 500 行以内。

---

## 2. R2：四轮次协同编写框架与六阶段修复全链路映射

多 Agent 协同修复方案必须严格遵循四轮次演进与六阶段闭环逻辑，形成自上而下的文档生成链：

```
+-----------------------------------------------------------------------------------+
|                            四轮次协同编写演进框架                                 |
+-----------------------------------------------------------------------------------+
| Round 1: 架构初稿与修复生命周期映射 (Draft Architecture & Lifecycle Definition)  |
|   └─> 建立全局视图，定义 6 阶段基线流程与文件域互斥规则                           |
+-----------------------------------------------------------------------------------+
                                         │ (作为 Round 2 输入)
                                         ▼
+-----------------------------------------------------------------------------------+
| Round 2: 方案综合、冲突解决与维度拆解 (Synthesis, Conflict Resolution & Breakdown)|
|   └─> 解决组件命名/状态流冲突，生成 ADR，按维度拆解为子计划                       |
+-----------------------------------------------------------------------------------+
                                         │ (作为 Round 3 输入)
                                         ▼
+-----------------------------------------------------------------------------------+
| Round 3: 六阶段维度深度细化 (Granular Refinement Across 6 Stages)                |
|   └─> 针对每个维度，详述 (1)识别 (2)分解 (3)分配 (4)修复 (5)汇总 (6)验证           |
+-----------------------------------------------------------------------------------+
                                         │ (作为 Round 4 输入)
                                         ▼
+-----------------------------------------------------------------------------------+
| Round 4: 综合评审、反过度设计审计与终验 (Comprehensive Review & Audit)           |
|   └─> 布局合规性审查、反过度设计红线校验、静态断言检查、最终定稿                  |
+-----------------------------------------------------------------------------------+
```

### 2.1 四轮次（Rounds 1-4）递进定义

#### Round 1：需求分析与方案初稿 (Draft Architecture)
- **目标**：基于 R1 SRS 及现有 `crish-desktop` 代码，梳理迁移全景图，产出架构初稿。
- **核心产出**：主方案骨架、迁移影响面矩阵、初始 6 阶段生命周期映射。

#### Round 2：方案综合与维度拆解 (Synthesis & Conflict Resolution)
- **目标**：评审 Round 1 初稿，识别架构与接口冲突（如 ProseMirror DOM 节点与 React Virtual DOM 的冲突、样式污染等），制定 ADR，并按维度拆解方案。
- **维度拆解**：
  1. **Core Migration Dimension**：Tiptap 核心包引入与扩展配置。
  2. **Component & UI Dimension**：`ComposerField` 替换、`SlashMenu` / `Tooltip` 适配。
  3. **State & IPC Dimension**：Zustand sessionStore 与编辑器内容双向同步。
  4. **Quality & Test Dimension**：Vitest 单元测试与 Playwright 视觉回放。

#### Round 3：维度方案细化 (Granular Operational Refinement)
- **目标**：将 Round 2 拆解的各个维度方案推演为具体可执行的 6 阶段细致指南，确保子 Agent 能无歧义执行。

#### Round 4：方案评审与完善 (Final Comprehensive Audit)
- **目标**：对照反过度设计红线（`ANTI_OVERENGINEERING_GUARDRAILS.md`）与 CI 治理断言，进行逻辑闭环审查与格式标准化，输出生产级终稿。

---

### 2.2 修复生命周期 6 阶段（6 Repair Lifecycle Stages）精确规范

无论是总体方案还是维度分册，必须统一包含以下 6 个逻辑阶段：

#### 阶段 1：问题识别 (Problem Identification)
- **定位**：确定迁移或修复过程中的代码缺失、类型不匹配、样式冲突或测试失败。
- **方法**：使用 `grep_search` 查找陈旧 API、`vitest` 捕获断言失败、CDP 9222 检查 DOM 渲染异常。
- **输出**：带 `文件路径:行号` 的问题清单及影响面评估。

#### 阶段 2：任务分解 (Task Decomposition)
- **定位**：将复杂问题拆解为原子化、独立且单一职责的子任务（Single Responsibility Principle）。
- **原则**：构建 DAG 任务依赖树，明确任务的前置依赖与后置影响，确保每个任务可在 400 行代码变更内完成。

#### 阶段 3：Agent 分配与负载均衡 (Agent Allocation & Workload Balancing)
- **上限限制**：单轮次最多分配 **6 个子 Agent**（Agent 1 ~ Agent 6）。
- **分配机制**：
  - **文件域互斥（File Domain Isolation）**：同类文件或相同模块严禁多 Agent 同时写入，避免 Git 冲突。
  - **负载均衡（Load Balancing）**：根据子任务估计工作量（轻量 1 次工具调用，重量多文件编辑）均匀派发。
  - **无人员与绝对时间硬编码**：禁止出现“小明在 14:00 执行”等硬编码，仅基于角色槽位（Role Slots）与依赖关系触发。

#### 阶段 4：并行修复 (Parallel Repair)
- **定位**：子 Agent 在隔离的工作区内独立执行修复动作。
- **协同纪律**：
  - **Checkpoint 优先恢复与 Git 安全**：单文件修复优先，禁止未经授权的大面积 `git reset`。
  - **Liveness 心跳**：长任务每 5 分钟更新 `progress.md` 时间戳。
  - **只写自身目录**：子 Agent 仅在 `.agents/<agent_id>/` 写入元数据，代码修改直接作用于指定文件域。

#### 阶段 5：结果汇总 (Result Aggregation)
- **定位**：收集各 Agent 的 `handoff.md` 与代码变更，进行交叉校验与合规性检查。
- **汇总逻辑**：消除信息冗余，核对接口契约变动，确保无破坏性变更引入。

#### 阶段 6：验证门禁 (Verification Gate)
- **定位**：独立验证修复结果的正确性与系统稳定性。
- **执行套件**：
  1. TypeScript 类型检查：`npm run typecheck`。
  2. Vitest 单元测试：`npx vitest run src`（确保不引入新的基线回归）。
  3. CI 行数与循环依赖扫描：`npm run check:zindex` 等脚本。
  4. 布局合规性检查：确认 `.agents/` 仅包含 markdown 元数据，无源代码泄露。

---

## 3. R3 与 Acceptance Criteria：解耦子 Agent 指导材料与提示词手册设计

为保障方案的高复用性与内化能力，必须将**通用修复逻辑**与**子 Agent 提示词模板**完全解耦：

### 3.1 解耦架构设计
- **主方案文档 (`multi_agent_repair_plan.md`)**：专注于业务逻辑、阶段推演、依赖拓扑与验证门禁，不掺杂具体的 LLM 系统提示词。
- **子 Agent 提示词手册 (`subagent_prompt_manual.md`)**：独立收录各类 Agent（如 Explorer、Planner、Implementer、Auditor）的标准 Prompt 模板，包含变量插值占位符（如 `{TASK_SPEC}`, `{FILE_DOMAIN}`, `{TARGET_BRANCH}`）。

### 3.2 提示词模板结构规范（5 核心要素）
独立提示词手册中的每个模板需严格包含以下 5 个结构化要素：
1. **Role & Identity**：明确 Agent 的角色定位与权限边界（如“只读分析”或“指定文件域写权限”）。
2. **Context & Inputs**：明确输入的上游文档路径与关联代码库范围。
3. **Operational Constraints**：操作红线（如禁用硬编码时间、限制 6 个 Agent 内、禁止修改 `.agents/` 以外的非分配文件）。
4. **Step-by-Step Instructions**：从任务接收、`DISPATCH.md` 记录、`BRIEFING.md` 初始化到具体代码/分析执行的标准化步骤。
5. **Output Standard**：强制要求 5 组件 `handoff.md`（Observation, Logic Chain, Caveats, Conclusion, Verification Method）及 `progress.md` 心跳更新。

---

## 4. 关键质量参数与可行性防爆策略

### 4.1 逻辑执行顺序与零硬编码 (Pure Logical Execution Order)
- **消除绝对时间戳**：文档中所有的流程流转均采用状态驱动（如“当 Stage 1 完成并产出 `problem_list.md` 后，触发 Stage 2”）而非时刻驱动。
- **消除具体人员指称**：以 Agent 编号（Agent 1 - Agent 6）和角色名称代指执行主体。

### 4.2 深度系统融合 (Deep System Integration)
- **关联 Conex 真实治理红线**：方案直接嵌入 `ANTI_OVERENGINEERING_GUARDRAILS.md`、`AGENTS.md` 中的 6 条 CI 治理断言，以及 Chrome DevTools Protocol (CDP 9222) 调试纪律。
- **无缝衔接代码基线**：直接对接 `apps/crish-desktop/src/components/chat-composer/` 的原有样式与 Store。

### 4.3 千行级文档扩展能力与布局合规性 (Scalability & Layout Compliance)
- **模块化文件架构**：将整体方案拆分为总览（00）、分轮次指南（01-03）、功能设计（04）、安全约束（05）与提示词手册（06），支持扩充至数千行而维持清晰条理。
- **`.agents/` 目录合规性**：严格确保 `.agents/` 仅存储 plan、progress、briefing、handoff 等 markdown 元数据，严禁在 `.agents/` 目录下放置任何 TypeScript/Rust 源代码或测试文件。

---

## 5. 结论与下一步落地建议

本调查报告确认了 Conex 项目多 Agent 修复方案的完整规范与逻辑链条。后续负责编写主方案及分册的 Agent 应依据本报告定义的 SRS 结构、4 轮次演进模型、6 阶段生命周期以及解耦提示词手册要求进行文档撰写。
