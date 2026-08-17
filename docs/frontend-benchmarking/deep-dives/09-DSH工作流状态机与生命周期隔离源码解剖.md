# DeepSeek-Harness 工作流状态机与多会话生命周期隔离深度源码解剖

> **文档定位**：Conex / Crish 前端架构重构与对标 DeepSeek-Harness（DSH）工业级状态机、多会话隔离、DevTools 多轨时间线与白板纯净门闩深度解剖报告  
> **数据支撑**：基于 `reference/deepseek-harness/` 目录下全部核心引擎与客户端源码（`packages/workflow/`、`packages/core/scope/`、`packages/core/session/`、`packages/client/ui-workflow-run/`、`packages/client/ui-trajectory/`、`packages/client/ui-conversation/` 等）及 Conex 桌面端组件源码（`apps/crish-desktop/`）  
> **编写原则**：客观实证、纯前端与引擎代码路径精确锚定到「文件:行号」、零退避降级、深度长篇全景解剖  
> **字符集**：UTF-8 无 BOM

---

## 目录

- [一、 执行摘要与核心架构全景 (Executive Summary & Architectural Landscape)](#一-执行摘要与核心架构全景-executive-summary--architectural-landscape)
  - [1.1 勘察背景与 Conex 核心痛点概览](#11-勘察背景与-conex-核心痛点概览)
  - [1.2 DSH 状态机与生命周期隔离核心哲学](#12-dsh-状态机与生命周期隔离核心哲学)
  - [1.3 核心量化指标与对标矩阵](#13-核心量化指标与对标矩阵)
- [二、 DSH 多 Agent 工作流 DAG 阶段状态机源码全景解剖 (Workflow State Machine & DAG Orchestration)](#二-dsh-多-agent-工作流-dag-阶段状态机源码全景解剖-workflow-state-machine--dag-orchestration)
  - [2.1 工作流微内核服务契约 (`packages/workflow/workflow/`)](#21-工作流微内核服务契约-packagesworkflowworkflow)
  - [2.2 Worker Thread 物理沙箱隔离 (`packages/workflow/workflow-worker-thread/`)](#22-worker-thread-物理沙箱隔离-packagesworkflowworkflow-worker-thread)
  - [2.3 核心全局原语注入与调度机制 (`agent`, `parallel`, `pipeline`, `phase`, `log`)](#23-核心全局原语注入与调度机制-agent-parallel-pipeline-phase-log)
  - [2.4 并发槽位控制与熔断机制 (`acquireSlot` / `releaseSlot`)](#24-并发槽位控制与熔断机制-acquireslot--releaseslot)
  - [2.5 取消传播与致命错误分类 (Fatal Error Taxonomy vs Per-Item Null Degradation)](#25-取消传播与致命错误分类-fatal-error-taxonomy-vs-per-item-null-degradation)
  - [2.6 前端工作流状态投影与动态折叠呈现 (`packages/client/ui-workflow-run/`)](#26-前端工作流状态投影与动态折叠呈现-packagesclientui-workflow-run)
- [三、 Chrome-DevTools 风格多轨时间线与轨迹全景呈现 (DevTools-Style Multi-Track Trajectory & Waterfall)](#三-chrome-devtools-风格多轨时间线与轨迹全景呈现-devtools-style-multi-track-trajectory--waterfall)
  - [3.1 轨迹数据流架构与快照装配 (`trajectory-snapshot-builder.ts`)](#31-轨迹数据流架构与快照装配-trajectory-snapshot-builderts)
  - [3.2 三轨时间线模型 (`timeline.ts` 中的 3-Lane 映射)](#32-三轨时间线模型-timelinets-中的-3-lane-映射)
  - [3.3 四大水平投影变换模式 (`sequence`, `duration`, `time`, `actual`)](#33-四大水平投影变换模式-sequence-duration-time-actual)
  - [3.4 交互式拖拽刷选、微步缩放与 TTFT/Decoding 呈现 (`TrajectoryTimeline.tsx`)](#34-交互式拖拽刷选微步缩放与-ttftdecoding-呈现-trajectorytimelinettsx)
  - [3.5 虚拟化瀑布流与深度检查器 (`TrajectoryTable.tsx`)](#35-虚拟化瀑布流与深度检查器-trajectorytabletsx)
- [四、 三级状态作用域物理隔离与代数分层 (Three-Tier State Scope Isolation & Algebraic Scoping)](#四-三级状态作用域物理隔离与代数分层-three-tier-state-scope-isolation--algebraic-scoping)
  - [4.1 `@deepseek-ai/dsh-scope` 架构哲学与单向树状传播](#41-deepseek-aidsh-scope-架构哲学与单向树状传播)
  - [4.2 事件路由单向冒泡铁律 (Events Flow UP, Never Down)](#42-事件路由单向冒泡铁律-events-flow-up-never-down)
  - [4.3 三级状态作用域物理切分与职责边界](#43-三级状态作用域物理切分与职责边界)
  - [4.4 `ScopedLayers<L>` 纯内存储存器与不可逆垃圾回收](#44-scopedlayersl-纯内存储存器与不可逆垃圾回收)
- [五、 纯函数会话 Diff 派生机制与快照对比 (Pure Function Session Diff Derivation)](#五-纯函数会话-diff-派生机制与快照对比-pure-function-session-diff-derivation)
  - [5.1 `structuredPatch` 纯函数算法应用 (`promptDiffLines`)](#51-structuredpatch-纯函数算法应用-promptdifflines)
  - [5.2 System Prompt 跨 Turn 增量差异对比 (`SystemPromptDiff`)](#52-system-prompt-跨-turn-增量差异对比-systempromptdiff)
  - [5.3 工具模式 (Tools Schema) 跨轮动态变更检测](#53-工具模式-tools-schema-跨轮动态变更检测)
  - [5.4 纯函数派生对前端渲染性能的极致优化](#54-纯函数派生对前端渲染性能的极致优化)
- [六、 空态白板纯净门闩 (Clean Slate Invariant) 机制深度剖析](#六-空态白板纯净门闩-clean-slate-invariant-机制深度剖析)
  - [6.1 白板纯净门闩定义与数学不变量 (`blank && composerPhase === 'blank'`)](#61-白板纯净门闩定义与数学不变量-blank--composerphase--blank)
  - [6.2 骨架树保持与布局平滑过渡 (`ConversationRoot.tsx` 中的 Hero ↔ Composer 翻转)](#62-骨架树保持与布局平滑过渡-conversationroottsx-中的-hero--composer-翻转)
  - [6.3 会话头部与视图强力抑制 (`hideChrome` 与 `return null`)](#63-会话头部与视图强力抑制-hidechrome-与-return-null)
  - [6.4 响应式工作区感知与 Chip 状态机 (`WorkspaceChip`)](#64-响应式工作区感知与-chip-状态机-workspacechip)
  - [6.5 输入条多态特化 (`inert` / `blocked` / `hero` / `composer` 状态守卫)](#65-输入条多态特化-inert--blocked--hero--composer-状态守卫)
- [七、 对标 Conex 核心痛点与彻底根治方案 (Conex Pain Points & Grounding Remedies)](#七-对标-conex-核心痛点与彻底根治方案-conex-pain-points--grounding-remedies)
  - [7.1 Conex 痛点 1 根治：18 文件未提交胶囊污染白板](#71-conex-痛点-1-根治18-文件未提交胶囊污染白板)
  - [7.2 Conex 痛点 2 根治：后台任务浮条在空态强行霸屏](#72-conex-痛点-2-根治后台任务浮条在空态强行霸屏)
  - [7.3 Conex 痛点 3 根治：空态欢迎面与 Composer 闪烁与跳跃](#73-conex-痛点-3-根治空态欢迎面与-composer-闪烁与跳跃)
  - [7.4 Conex 痛点 4 根治：多 Agent 协作缺乏工作流 DAG 与跨会话直达](#74-conex-痛点-4-根治多-agent-协作缺乏工作流-dag-与跨会话直达)
  - [7.5 Conex 痛点 5 根治：执行轨迹黑盒与调试断层](#75-conex-痛点-5-根治执行轨迹黑盒与调试断层)
- [八、 Conex 落地实施演进大纲与生产级代码示范 (Conex Implementation Blueprint)](#八-conex-落地实施演进大纲与生产级代码示范-conex-implementation-blueprint)
  - [8.1 状态架构重构：引入 `StateScopeRegistry` 与三级作用域隔离](#81-状态架构重构引入-statescoperegistry-与三级作用域隔离)
  - [8.2 白板纯净门闩代码实现规范 (`useCleanSlateInvariant` 与 `CleanSlateGuard`)](#82-白板纯净门闩代码实现规范-usecleanslateinvariant-与-cleanslateguard)
  - [8.3 DevTools 轨迹时间线接入方案](#83-devtools-轨迹时间线接入方案)
  - [8.4 总结与核心架构断言](#84-总结与核心架构断言)

---

# 一、 执行摘要与核心架构全景 (Executive Summary & Architectural Landscape)

## 1.1 勘察背景与 Conex 核心痛点概览

在现代桌面 AI 协作系统与自主 Agent 工作流开发中，**状态作用域的边界划分、多会话生命周期管理、工作流 DAG 可视化推进以及时间线调试呈现**是决定系统健壮性与交互体验的关键底座。

通过对 Conex / Crish 前端（`apps/crish-desktop/`）与底层交互逻辑的深度实证审查，Conex 当前面临以下几个核心架构断层与视觉体验痛点：

1. **白板状态严重被全局脏数据污染（18 文件胶囊污染事故）**：
   - 当用户处于新建对话（New Session）或未选择会话的初始空态时，Conex 界面底部却突兀浮现「18 个文件修改」的 Diff 胶囊、后台任务轮询标签（`activeBgTasks`）、重试条（`RetrySlotNotice`）和熔断横幅；
   - **根因**：Conex 缺乏状态作用域分层。全局 Git 工作区状态（`state.diffFiles.length`）与后台进程池被扁平广播给所有视图，没有经过「会话级」与「白板草稿级」物理隔离，导致处于初始状态的白板被底层 Git 仓库的未提交文件直接渗透污染。
2. **多 Agent 协作工作流黑盒化**：
   - 现有的子 Agent 派发和执行只在终端或单一日志面板呈现，缺乏声明式 DAG 阶段推进（Phases）、并行汇聚（Parallel/Pipeline）状态机以及父子会话无缝导航的交互能力。
3. **执行轨迹（Trajectory）与耗时诊断断层**：
   - 缺乏类似 Chrome DevTools Network 瀑布流的多轨时序视图（TTFT 首次 Token 延迟、解码耗时、Tool 真实执行跨度），导致排查长链路 Agent 卡顿只能依赖肉眼翻阅文本日志。
4. **空态到对话态的 DOM 震荡与闪烁**：
   - 空态与活跃态采用互斥的条件分支挂载（`ChatEmptyState` vs `ChatMessageList`），切换时销毁并重建整个输入框 DOM，导致焦点丢失、输入草稿撕裂与视觉跳跃。

为了彻底消除上述架构缺陷，本报告对标开源标杆 **DeepSeek-Harness (DSH)**，对其微内核工作流状态机（`@deepseek-ai/dsh-workflow`）、多轨轨迹系统（`@deepseek-ai/dsh-client-ui-trajectory`）、三级作用域隔离（`@deepseek-ai/dsh-scope`）及白板纯净门闩（Clean Slate Invariant）机制展开穷尽式的源码解剖。

---

## 1.2 DSH 状态机与生命周期隔离核心哲学

DSH 展现了一套极其严密、优雅且具备数学证明般纯粹性的前端与运行时架构体系。其核心哲学可浓缩为以下四项铁律：

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                     DeepSeek-Harness 状态机与生命周期隔离核心架构哲学                     │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  [ 1. 三级状态作用域物理隔离 (Three-Tier State Scope Isolation) ]                        │
│  • Tier 1 Global: 引擎/工作区/全局设置 (无副作用广播)                                   │
│  • Tier 2 Session: 持久化会话树/Projection/Turns/局部存储 (会话生命周期绑定)           │
│  • Tier 3 Clean Draft: 零污染白板/临时未发送草稿/纯净 Hero 面板 (绝对无继承脏状态)       │
│                                                                                          │
│  [ 2. 作用域单向树状传播与事件冒泡铁律 (Events Flow UP, Never Down) ]                    │
│  • 子作用域继承父作用域能力，但父作用域事件过滤严密拦截逆向渗透                         │
│  • 监听器向上冒泡收集，全局状态禁止无门闩下行注入局部草稿                                │
│                                                                                          │
│  [ 3. 白板纯净门闩 (Clean Slate Invariant) ]                                             │
│  • 不变量方程: isBlank = (blank && composerPhase === 'blank')                            │
│  • 成立时强力熔断: Header 隐藏、Session View 返回 null、Diff/Task/Actions 全部静默       │
│  • 保持式骨架: Composer 维持单一 DOM 树节点，通过 CSS 几何变形实现无缝空间翻转          │
│                                                                                          │
│  [ 4. 纯函数会话 Diff 派生与多轨时序 (Pure Derivation & Multi-Track DevTools) ]          │
│  • 基于 diff 库 structuredPatch 对 System Prompt / Tool Schema 进行无状态 O(N) 纯派生    │
│  • 3-Lane 时序映射 (0: Prompt/User, 1: Message/Compact, 2: Tool) 支撑 DevTools 毫秒级级联 │
│                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1.3 核心量化指标与对标矩阵

| 架构维度             | Conex / Crish 现状                                                      | DeepSeek-Harness (DSH) 工业级实现                                                                                                        | 根治效益与对标结论                                                     |
| :------------------- | :---------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------- |
| **状态作用域隔离**   | 单一 Zustand 上帝对象，全局状态（Git Diff、后台任务、通知）全屏扁平广播 | `@deepseek-ai/dsh-scope`：三级物理作用域（Tier 1 Global / Tier 2 Session / Tier 3 Clean Draft），基于 WeakMap 与代数层（`ScopedLayers`） | **彻底隔离**：消除跨会话脏数据泄露，白板完全独立于全局工作区变动       |
| **白板空态纯净度**   | 依赖运行时动态拼装组件，Diff 计数（18 文件）与后台任务在空态无差别挂载  | **Clean Slate Invariant**：`blank && composerPhase === 'blank'` 强力门闩，会话视图直接 `return null`，Header 强制隐藏                    | **绝对纯净**：空态仅展示 Hero 与工作区选择器，零脏胶囊残留             |
| **输入框生命周期**   | 空态与对话态处于不同的条件分支渲染，DOM 发生物理销毁与重建，易丢焦点    | `ConversationRoot.tsx`：Composer 全生命周期驻留单 DOM 节点，通过 CSS 数据属性 `data-phase='hero' \| 'active'` 平滑形变                   | **零布局跳跃**：输入草稿 100% 保持，无缝翻转                           |
| **工作流 DAG 编排**  | 无独立工作流状态机，子 Agent 仅作为松散命令执行，无阶段结构             | `@deepseek-ai/dsh-workflow`：Worker Thread 沙箱执行、`parallel`/`pipeline` 组合子、阶段（Phase）状态机                                   | **工业级编排**：支持并发配额、取消链条、结构化 Schema 校验与跨会话直达 |
| **执行轨迹时序呈现** | 仅输出平铺文本日志或单条消息卡片，无法分析耗时瓶颈                      | `@deepseek-ai/dsh-client-ui-trajectory`：3-Lane DevTools 时间线、TTFT/Decoding 拆解、虚拟化瀑布流、Prompt Diff 检查器                    | **可观测性跃迁**：秒级定位 Token 瓶颈与 Tool 延迟，可视化多轮演进      |

---

# 二、 DSH 多 Agent 工作流 DAG 阶段状态机源码全景解剖 (Workflow State Machine & DAG Orchestration)

## 2.1 工作流微内核服务契约 (`packages/workflow/workflow/`)

DSH 在 `packages/workflow/workflow/src/` 中定义了工作流引擎的微内核服务契约。其核心设计思想是：**执行逻辑与宿主容器解耦、状态进度单向事件化、终态永不 Reject**。

### 核心类型契约 (`src/types.ts:1-132`)

在 [`reference/deepseek-harness/packages/workflow/workflow/src/types.ts:28-87`](file:///c:/Software/conex/reference/deepseek-harness/packages/workflow/workflow/src/types.ts#L28-L87) 中，定义了阶段（Phase）、执行结果（Result）、代理身份（AgentInfo）等严密类型：

```typescript
/**
 * One phase declared in a script's `meta.phases` (progress vocabulary only —
 * phases group agents in observers/UIs; they impose no execution structure).
 */
export interface WorkflowPhase {
  title: string;
  detail?: string;
  provider?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowPhase[];
}

export type WorkflowStopReason = 'completed' | 'cancelled' | 'error';

export interface WorkflowResult {
  value: unknown;
  stopReason: WorkflowStopReason;
  error?: string;
  agentsStarted: number;
}

export interface WorkflowAgentInfo {
  seq: number;
  label: string;
  phase?: string;
  childId: SessionId;
}

export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled';

export interface WorkflowAgentEndInfo extends WorkflowAgentInfo {
  outcome: WorkflowAgentOutcome;
}
```

### Cordis 服务抽象与事件总线 (`src/index.ts:31-90`)

在 [`reference/deepseek-harness/packages/workflow/workflow/src/index.ts:31-90`](file:///c:/Software/conex/reference/deepseek-harness/packages/workflow/workflow/src/index.ts#L31-L90) 中，工作流引擎扩展了 Cordis 上下文与事件系统：

```typescript
declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowEngine: WorkflowEngine;
  }

  interface Events {
    'workflow/start'(info: WorkflowRunInfo): void;
    'workflow/phase'(info: WorkflowRunInfo, title: string): void;
    'workflow/log'(info: WorkflowRunInfo, message: string): void;
    'workflow/agent-start'(
      info: WorkflowRunInfo,
      agent: WorkflowAgentInfo
    ): void;
    'workflow/agent-end'(
      info: WorkflowRunInfo,
      agent: WorkflowAgentEndInfo
    ): void;
    'workflow/end'(info: WorkflowRunInfo, result: WorkflowResultInfo): void;
  }
}
```

### 异常安全设计与服务基类 (`src/index.ts:157-187`)

```typescript
export abstract class WorkflowEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workflowEngine');
  }

  abstract start(request: WorkflowStartRequest): WorkflowRun;

  /** 关键安全设计：隔离生命周期监听器异常，避免某个 UI 监听器报错导致工作流引擎崩溃 */
  protected emitWorkflowEvent(
    name: WorkflowEventName,
    ...args: unknown[]
  ): void {
    for (const callback of this.ctx.events.dispatch('emit', [name, ...args])) {
      try {
        const returned: unknown = (
          callback as (...payload: unknown[]) => unknown
        )(...args);
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(
            `workflow: ${name} listener rejected: ${renderListenerError(error)}`
          );
        });
      } catch (error: unknown) {
        this.ctx.logger.warn(
          `workflow: ${name} listener threw: ${renderListenerError(error)}`
        );
      }
    }
  }
}
```

---

## 2.2 Worker Thread 物理沙箱隔离 (`packages/workflow/workflow-worker-thread/`)

为了防止用户或 LLM 生成的编排脚本（Script）污染宿主进程、占用主事件循环或篡改原型链，DSH 将编排脚本放置于独立的 `Worker Thread` + Node.js `vm.Context` 双重物理沙箱中运行。

源码位置：[`reference/deepseek-harness/packages/workflow/workflow-worker-thread/src/runtime.ts:59-114`](file:///c:/Software/conex/reference/deepseek-harness/packages/workflow/workflow-worker-thread/src/runtime.ts#L59-L114)。

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                    DSH 工作流 Worker Thread 物理沙箱架构                                    │
├───────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                           │
│  [ 宿主进程 Host Process (Main Thread) ]                                                  │
│  • WorkflowEngineService (Cordis 插件上下文)                                              │
│  • HostWorkflowSession: 跨线程 RPC 消息代理、信号同步与生命周期监听                        │
│                                      │                                                    │
│                        (MessagePort / workerData)                                         │
│                                      ▼                                                    │
│  [ 工作线程 Worker Thread ]                                                               │
│    ┌─────────────────────────────────────────────────────────────────────────────────┐    │
│    │  [ Node.js vm.Context 沙箱环境 (Realm 隔离) ]                                   │    │
│    │  • 预编译 vm.Script: lineOffset: -1 对齐真实错误行号                              │    │
│    │  • 受限全局注入: agent(), parallel(), pipeline(), phase(), log(), args           │    │
│    │  • 冻结函数引用: Object.freeze(fn)，防止脚本篡改底层调度钩子                      │    │
│    │  • 跨边界出入参数 JSON 强序列化校验 (materializeFromRealm)                       │    │
│    └─────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                           │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2.3 核心全局原语注入与调度机制 (`agent`, `parallel`, `pipeline`, `phase`, `log`)

在 [`runtime.ts:100-113`](file:///c:/Software/conex/reference/deepseek-harness/packages/workflow/workflow-worker-thread/src/runtime.ts#L100-L113) 中，沙箱初始化时注入了 5 个核心全局原语：

```typescript
const globals: Record<string, unknown> = {
  agent: (prompt: unknown, opts?: unknown) =>
    this.contain(this.agent(prompt, opts)),
  parallel: (thunks: unknown) => this.contain(this.parallel(thunks)),
  pipeline: (items: unknown, ...stages: unknown[]) =>
    this.contain(this.pipeline(items, stages)),
  phase: (title: unknown) => {
    this.phase(title);
  },
  log: (message: unknown) => {
    this.log(message);
  },
  args,
};
for (const [key, value] of Object.entries(globals)) {
  (this.context as Record<string, unknown>)[key] =
    typeof value === 'function' ? Object.freeze(value) : value;
}
```

### 1. `agent(prompt, opts)`：原子子 Agent 派发

源码：[`runtime.ts:250-345`](file:///c:/Software/conex/reference/deepseek-harness/packages/workflow/workflow-worker-thread/src/runtime.ts#L250-L345)

- **参数校验**：提示词非空字符串检查，支持 `label`, `phase`, `provider`, `model`, `schema`（JSON Schema 结构化输出）；
- **配额守卫**：检查 `this.started >= this.limits.maxTotalAgents`，防止失控死循环；
- **槽位争抢**：异步等待 `this.acquireSlot()`；
- **生命周期通知**：触发 `observer.agentStart(info)` 与 `observer.agentEnd({ ...info, outcome })`；
- **资源清理**：在 `finally` 块中始终调用 `await run.dispose()` 与 `this.releaseSlot()`。

### 2. `parallel(thunks)`：并发执行与错误降级

源码：[`runtime.ts:401-425`](file:///c:/Software/conex/reference/deepseek-harness/packages/workflow/workflow-worker-thread/src/runtime.ts#L401-L425)

- 接收无参函数数组，受 `maxItemsPerCall` 配额限制；
- 采用 `Promise.all` 并发触发；
- **错误降级哲学**：如果是常规阶段异常，将该项安全降解为 `null`（供脚本 `.filter(Boolean)` 消费）；如果是 `FatalWorkflowError`（如配置错误、配额超限、取消信号），则直接向上抛出，中断整个工作流。

```typescript
private async parallel(rawThunks: unknown): Promise<unknown[]> {
  this.throwIfCancelled()
  if (!Array.isArray(rawThunks)) {
    throw new WorkflowError('parallel() requires an array of zero-argument functions', 'INVALID_ARGUMENT')
  }
  this.assertItemCap(rawThunks.length, 'parallel()')
  const thunks = rawThunks.map((thunk, index) => {
    if (typeof thunk !== 'function') {
      throw new WorkflowError(`parallel() item ${index} is not a function`, 'INVALID_ARGUMENT')
    }
    return thunk as () => unknown
  })
  return Promise.all(thunks.map(async (thunk) => {
    try {
      return await thunk()
    } catch (error: unknown) {
      if (isFatalWorkflowError(error)) throw error
      return null
    }
  }))
}
```

### 3. `pipeline(items, ...stages)`：流水线链式变换

源码：[`runtime.ts:428-458`](file:///c:/Software/conex/reference/deepseek-harness/packages/workflow/workflow-worker-thread/src/runtime.ts#L428-L458)

- 针对 `items` 列表中的每一项依次经过 `stages` 变换；
- **项间独立无屏障**：单项在某阶段发生普通错误仅将该项结果置为 `null` 并跳过后续阶段，不阻塞其余正常项的推进。

### 4. `phase(title)` 与 `log(message)`：时序进度编组

源码：[`runtime.ts:470-486`](file:///c:/Software/conex/reference/deepseek-harness/packages/workflow/workflow-worker-thread/src/runtime.ts#L470-L486)

- 仅作为可视化分组语义（Progress Vocabulary），不强制改变代码执行时序；
- 触发 `observer.phase(title)`，更新当前活跃阶段并推送至前端 UI。

---

## 2.4 并发槽位控制与熔断机制 (`acquireSlot` / `releaseSlot`)

为了防止短时间内派发过多子 Agent 导致系统线程/进程耗尽或 API 速率超限，DSH 在 Worker 内实现了精确的 FIFO 异步信号量槽位控制：

源码：[`runtime.ts:227-248`](file:///c:/Software/conex/reference/deepseek-harness/packages/workflow/workflow-worker-thread/src/runtime.ts#L227-L248)

```typescript
private acquireSlot(): Promise<void> {
  if (this.activeSlots < this.limits.maxConcurrentAgents) {
    this.activeSlots += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    this.slotWaiters.push({
      resolve: () => {
        this.activeSlots += 1
        resolve()
      },
      reject,
    })
  })
}

private releaseSlot(): void {
  this.activeSlots -= 1
  const next = this.slotWaiters.shift()
  if (next) next.resolve()
}
```

---

## 2.5 取消传播与致命错误分类 (Fatal Error Taxonomy vs Per-Item Null Degradation)

在多 Agent 复杂编排中，必须严格区分**系统级致命故障**与**业务级执行失败**：

源码：[`reference/deepseek-harness/packages/workflow/workflow/src/index.ts:108-148`](file:///c:/Software/conex/reference/deepseek-harness/packages/workflow/workflow/src/index.ts#L108-L148)

```typescript
export type WorkflowErrorCode =
  | 'SCRIPT_PARSE'
  | 'META_INVALID'
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_OPTION'
  | 'UNSUPPORTED_SCHEMA'
  | 'AGENT_CAP'
  | 'ITEM_CAP'
  | 'AGENT_START'
  | 'AGENT_RESULT'
  | 'RESULT_UNSERIALIZABLE'
  | 'CANCELLED';

export class WorkflowError extends HarnessError {
  readonly fatal: boolean;
  constructor(
    message: string,
    code: WorkflowErrorCode,
    options?: ErrorOptions & { fatal?: boolean }
  ) {
    super(message, code, options);
    this.name = 'WorkflowError';
    this.fatal = options?.fatal ?? true;
  }
}
```

- **致命错误 (Fatal)**：参数非法、语法错误、取消触发、超额配额等。所有组合子立即中断并外抛；
- **普通失败 (Non-Fatal)**：单子 Agent LLM 响应不合格、返回内容未达预期。在 `parallel`/`pipeline` 中自动降解为 `null`。

---

## 2.6 前端工作流状态投影与动态折叠呈现 (`packages/client/ui-workflow-run/`)

在前端 UI 呈现层面，DSH 通过 `@deepseek-ai/dsh-client-ui-workflow-run` 将事件流折叠合并为单一的富交互 Chat 节点。

### 1. 数据模型与 Phase 键哈希 (`src/client/workflow-definition.ts:12-61`)

```typescript
export type WorkflowRunStatus =
  'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface WorkflowRunMemberData {
  readonly seq: number;
  readonly label: string;
  readonly childId: SessionId;
  readonly status: WorkflowRunStatus;
}

export interface WorkflowRunPhaseData {
  readonly key: string;
  readonly phase: string | null;
  readonly members: readonly WorkflowRunMemberData[];
}

/** 保证缺失 phase (null) 与空字符串 phase ('') 具有严格独立互不碰撞的渲染 Key */
export function workflowPhaseKey(phase: string | null): string {
  return phase === null ? 'missing' : `value:${phase.length}:${phase}`;
}
```

### 2. 折叠状态机与跨会话无缝直达 (`src/client/WorkflowRunPanel.tsx:66-236`)

DSH 在 `WorkflowRunPanel.tsx` 中实现了智能折叠与导航：

- **智能展开判定 (`phaseRequiresExpansion`)**：当阶段内所有子任务均已 `completed` 时，默认自动收起；若存在 `running`、`failed` 或 `interrupted` 任务，则自动展开以警示用户；
- **子会话直达 (`openSession(member.childId)`)**：点击子 Agent 胶囊直接跳转至其专属的独立会话上下文，实现深度探查。

```typescript
function PhaseSection({ phase, navigable, openSession, t }: {
  readonly phase: WorkflowRunPhaseData
  readonly navigable: readonly SessionId[]
  readonly openSession: WorkflowRunInjected['openSession']
  readonly t: WorkflowRunPanelProps['t']
}) {
  return (
    <StatusDisclosure
      icon={<IconChevronRightOutline14 />}
      title={readablePhase(phase.phase, t)}
      cleanCycleKey={phase.members.length}
      requiresExpansion={phaseRequiresExpansion(phase)}
      expandOnRowClick
      collapsedContent={(
        <>
          <span className={css.phaseCount}>{memberCount(phase.members.length, t)}</span>
          <span className={css.phaseStatus}>{phaseStatusSummary(phase.members, t)}</span>
        </>
      )}
    >
      <div className={css.members}>
        {phase.members.map(member => (
          <MemberRow
            key={member.seq}
            member={member}
            navigable={navigable.includes(member.childId)}
            openSession={openSession}
            t={t}
          />
        ))}
      </div>
    </StatusDisclosure>
  )
}
```

---

# 三、 Chrome-DevTools 风格多轨时间线与轨迹全景呈现 (DevTools-Style Multi-Track Trajectory & Waterfall)

## 3.1 轨迹数据流架构与快照装配 (`trajectory-snapshot-builder.ts`)

在 `@deepseek-ai/dsh-client-ui-trajectory` 中，DSH 实现了类似 Chrome DevTools Network 面板的专业级时序轨迹分析系统。

源码位置：[`reference/deepseek-harness/packages/client/ui-trajectory/src/client/trajectory-snapshot-builder.ts:1-120`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-trajectory/src/client/trajectory-snapshot-builder.ts#L1-L120)。

`TrajectorySnapshot` 会聚合当前会话的所有：

1. **EventNodes**：对话轮次与原子事件节点；
2. **Requests**：LLM 推理请求与 Context Compaction 上下文压缩请求；
3. **CallSchemas**：每个 Tool 调用时的参数 Schema 快照；
4. **RunningCalls**：当前活跃执行中的异步调用。

---

## 3.2 三轨时间线模型 (`timeline.ts` 中的 3-Lane 映射)

源码位置：[`reference/deepseek-harness/packages/client/ui-trajectory/src/client/timeline.ts:46-50`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-trajectory/src/client/timeline.ts#L46-L50)

DSH 将所有复杂的 Agent 行为严密归一化到 3 个平行的时序轨道（Lanes）：

```typescript
function laneFor(kind: TrajectoryCellKind): number {
  if (kind === 'tool' || kind === 'subtool') return 2; // Lane 2: 工具与子工具执行
  if (kind === 'message' || kind === 'compacted') return 1; // Lane 1: LLM 回复与上下文压缩
  return 0; // Lane 0: 用户 Prompt 与系统指令
}
```

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                       DSH 3-Lane DevTools 多轨时序模型拓扑                                 │
├───────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                           │
│  [ Lane 0: System / User ]      [ User Prompt 1 ]               [ User Follow-Up ]        │
│                                         │                                │                │
│  [ Lane 1: Assistant / Compact ]        └──► [ TTFT | Decoding ]         └──► [ LLM Gen ] │
│                                                     │                                     │
│  [ Lane 2: Tool / Subtool ]                         ├──► [ read_file ]                    │
│                                                     └──► [ run_command ───────► (Async) ] │
│                                                                                           │
│  ───────────────────────────────────────────────────────────────────────────────────────  │
│  Time Domain:   0ms ──── 250ms ──── 500ms ──── 750ms ──── 1000ms ──── 1250ms ──── 1500ms   │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3.3 四大水平投影变换模式 (`sequence`, `duration`, `time`, `actual`)

源码位置：[`reference/deepseek-harness/packages/client/ui-trajectory/src/client/timeline.ts:7-113`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-trajectory/src/client/timeline.ts#L7-L113)

DSH 提供了 4 种互相独立的水平时序投影算法：

1. **`sequence`（步骤离散投影）**：忽略时间长短，按操作步骤等宽排列，用于快速扫视逻辑步长；
2. **`duration`（压缩空闲时间投影）**：保留各个操作的真实耗时长度，但通过算法 `removedIdleBySpan` 将 Agent 等待用户的超长空闲间隔压缩为 0，防止时间轴被无限拉长；
3. **`time`（离散时间戳投影）**：各操作以起始时间为唯一点位；
4. **`actual`（绝对墙钟时间投影）**：100% 真实物理时间跨度，包含全部等待与交互停顿。

---

## 3.4 交互式拖拽刷选、微步缩放与 TTFT/Decoding 呈现 (`TrajectoryTimeline.tsx`)

源码位置：[`reference/deepseek-harness/packages/client/ui-trajectory/src/client/TrajectoryTimeline.tsx:50-82`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-trajectory/src/client/TrajectoryTimeline.tsx#L50-L82)

在时序细粒度度量上，DSH 深入到 LLM 推理周期的原子指标：

- **TTFT (Time to First Token)**：`metrics.firstTokenTime - metrics.stepStartTime`（首字生成延迟，排查网络/排队耗时）；
- **Decoding Time**：`metrics.completedTime - metrics.firstTokenTime`（内容生成耗时，反映 Token 吞吐率）；
- **指针抓取与刷选 (Scrubbing & Panning)**：支持鼠标在 Mini-Map 上拖拽范围过滤，实时联动下方 Virtualized Table。

```typescript
function assistantTimingDetail(
  metrics: AssistantMetricDetail | undefined
): Pick<TimelineRecordDetail, 'ttftMs' | 'decodingMs'> {
  const start = metrics?.stepStartTime;
  const first = metrics?.firstTokenTime;
  const completed = metrics?.completedTime;
  if (
    metrics?.timingRecorded !== true ||
    typeof start !== 'number' ||
    typeof first !== 'number' ||
    typeof completed !== 'number' ||
    !Number.isFinite(start) ||
    !Number.isFinite(first) ||
    !Number.isFinite(completed) ||
    first < start ||
    completed < first
  )
    return {};
  return { ttftMs: first - start, decodingMs: completed - first };
}
```

---

## 3.5 虚拟化瀑布流与深度检查器 (`TrajectoryTable.tsx`)

源码位置：[`reference/deepseek-harness/packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:1-120`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-trajectory/src/client/TrajectoryTable.tsx#L1-L120)

- 基于 `@tanstack/react-virtual` 的 `useVirtualizer`，单会话可流畅承载数万条操作记录；
- 每一行展示类型图标（System / User / Assistant / Tool / Compacted）、操作摘要、耗时瀑布条与执行状态；
- 点击任意行展开右侧/内联 Inspector，展示完整的 `JsonTree` 参数树与 Markdown 输出。

---

# 四、 三级状态作用域物理隔离与代数分层 (Three-Tier State Scope Isolation & Algebraic Scoping)

## 4.1 `@deepseek-ai/dsh-scope` 架构哲学与单向树状传播

`@deepseek-ai/dsh-scope` 是 DSH 整个状态隔离体系的数学基石。

源码位置：[`reference/deepseek-harness/packages/core/scope/src/index.ts:14-102`](file:///c:/Software/conex/reference/deepseek-harness/packages/core/scope/src/index.ts#L14-L102)

### 1. 唯一不透明作用域键 (`ScopeKey`) 与防循环 WeakMap

```typescript
export type ScopeKey = object;
const scopeParents = new WeakMap<ScopeKey, ScopeKey>();

function linkScopeParent(key: ScopeKey, parent: ScopeKey): void {
  for (
    let cursor: ScopeKey | undefined = parent;
    cursor !== undefined;
    cursor = scopeParents.get(cursor)
  ) {
    if (cursor === key)
      throw new Error('dsh-scope: scope parent link would form a cycle');
  }
  scopeParents.set(key, parent);
}
```

### 2. 作用域链解析 (`scopeChainOf`)

```typescript
export function scopeChainOf(key: ScopeKey | undefined): ScopeKey[] {
  const chain: ScopeKey[] = [];
  for (
    let cursor = key;
    cursor !== undefined;
    cursor = scopeParents.get(cursor)
  )
    chain.push(cursor);
  return chain;
}
```

---

## 4.2 事件路由单向冒泡铁律 (Events Flow UP, Never Down)

源码位置：[`reference/deepseek-harness/packages/core/scope/src/index.ts:170-185`](file:///c:/Software/conex/reference/deepseek-harness/packages/core/scope/src/index.ts#L170-L185)

这是 DSH 隔离性的核心保障：**祖先作用域的监听器可以观察其所有后代作用域派发的事件，但处于深层的子作用域（如局部草稿、子会话）绝对不会收到父级或兄弟作用域的无差别广播。事件只能向上冒泡，严禁向下逆流！**

```typescript
export function scopeTarget<T extends object>(
  base: T,
  key: ScopeKey | undefined
): Scoped<T> {
  const baseFilter = (
    base as { [CordisContext.filter]?: (ctx: Context) => boolean }
  )[CordisContext.filter];
  const carrier = {
    [CordisContext.filter](ctx: Context): boolean {
      if (baseFilter !== undefined && !baseFilter.call(base, ctx)) return false;
      const tag = scopeOf(ctx);
      if (tag === undefined) return true;
      for (
        let cursor = key;
        cursor !== undefined;
        cursor = scopeParents.get(cursor)
      ) {
        if (cursor === tag) return true; // 仅当 tag 是 key 或 key 的祖先时才放行事件
      }
      return false; // 阻止事件向下或向无关分支泄露
    },
  };
  carrierKeys.set(carrier, key);
  return carrier as unknown as Scoped<T>;
}
```

---

## 4.3 三级状态作用域物理切分与职责边界

在 DSH 体系中，前端与运行时状态被严格划分为三级物理隔离域：

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                      DSH 三级状态作用域物理隔离体系 (Three-Tier Scope)                      │
├───────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                           │
│  [ Tier 1: Global Scope (全局根作用域) ]                                                  │
│  • 全局工作区目录列表 (`workspaces.items`)、已安装插件与模型设置 (`ui-settings`)         │
│  • 底层引擎在线/就绪心跳 (`engineHint`)                                                   │
│  • 特征: 纯静态能力与顶层服务，无会话私有状态，不感知任何草稿                           │
│                                                                                           │
│                                     │ (向下派生，但事件不逆流)                            │
│                                     ▼                                                     │
│  [ Tier 2: Session Scope (已持久化会话作用域) ]                                           │
│  • 会话投影状态 (`session-projection`)、消息流 (`messages`)、审批队列 (`approval`)       │
│  • 专属于当前 SessionId 的 LocalStore 与视图状态 (`useStore`)                             │
│  • 特征: 仅当 sessionId 存在且产生持久化数据时激活，随会话关闭而级联卸载                 │
│                                                                                           │
│                                     │ (向下派生，严格隔离)                                │
│                                     ▼                                                     │
│  [ Tier 3: Clean Draft Scope (白板草稿作用域 - 纯净零污染) ]                              │
│  • 瞬时输入内容 (`inputState.draft`)、未绑定工作区的 Hero 选择态                          │
│  • 不变量保护: 绝对不继承 Tier 2 的 Diff 计数、不响应 Tier 2 的任务提示                   │
│  • 特征: 白板完全纯净，零历史包袱，发送第一条消息后才原子晋升为 Tier 2                   │
│                                                                                           │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4.4 `ScopedLayers<L>` 纯内存储存器与不可逆垃圾回收

源码位置：[`reference/deepseek-harness/packages/core/scope/src/store.ts:159-267`](file:///c:/Software/conex/reference/deepseek-harness/packages/core/scope/src/store.ts#L159-L267)

`ScopedLayers` 维护全局层（`global`）与各个具体作用域的覆盖层（`scoped: Map<ScopeKey, L>`）：

- **`merge`（按链合并）**：按照 `scopeChainOf` 从远祖到近亲依次合并，最近的作用域同名配置胜出；
- **`effect`（与 Cordis Fiber 绑定的无泄漏变更）**：当注册该层的作用域被销毁（Dispose）时，自动触发原子 `undo()`，若该层变为空则直接从 Map 中剔除，实现物理级零内存泄漏。

```typescript
export class ScopedLayers<L extends ScopeLayer> {
  readonly global: L;
  private readonly scoped = new Map<ScopeKey, L>();

  merge<V>(
    scope: ScopeKey | undefined,
    pick: (layer: L) => NamedEntries<V>
  ): Map<string, V> {
    const merged = new Map(pick(this.global).entries());
    for (const layer of this.chainLayers(scope)) {
      for (const [name, value] of pick(layer).entries())
        merged.set(name, value);
    }
    return merged;
  }
}
```

---

# 五、 纯函数会话 Diff 派生机制与快照对比 (Pure Function Session Diff Derivation)

## 5.1 `structuredPatch` 纯函数算法应用 (`promptDiffLines`)

在分析多轮对话中 System Prompt、环境变量或 Tool Definitions 的演进时，DSH 摒弃了在状态中存储复杂增量对象的做法，而是采用**无状态纯函数 + 标准 GNU Diff 算法**进行即时派生。

源码位置：[`reference/deepseek-harness/packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:1246-1266`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-trajectory/src/client/TrajectoryTable.tsx#L1246-L1266)

```typescript
interface PromptDiffLine {
  kind: 'meta' | 'context' | 'added' | 'removed';
  text: string;
}

function promptDiffLines(
  before: string,
  after: string
): readonly PromptDiffLine[] {
  const patch = structuredPatch('', '', before, after, undefined, undefined, {
    context: 3,
  });
  return patch.hunks.flatMap((hunk, hunkIndex) => [
    ...(hunkIndex === 0 ? [] : [{ kind: 'meta' as const, text: '' }]),
    {
      kind: 'meta' as const,
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    },
    ...hunk.lines.flatMap((line): PromptDiffLine[] => {
      if (line.startsWith('\\')) return [];
      if (line.startsWith('+')) return [{ kind: 'added', text: line }];
      if (line.startsWith('-')) return [{ kind: 'removed', text: line }];
      return [{ kind: 'context', text: line }];
    }),
  ]);
}
```

---

## 5.2 System Prompt 跨 Turn 增量差异对比 (`SystemPromptDiff`)

源码位置：[`reference/deepseek-harness/packages/client/ui-trajectory/src/client/TrajectoryTable.tsx:1294-1310`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-trajectory/src/client/TrajectoryTable.tsx#L1294-L1310)

当某轮对话动态注入了新的 Skill、Rules 或 Context 时，DSH 仅在检测到字符串变动时才调用纯函数计算补丁并渲染红绿高亮视图：

```typescript
function SystemPromptDiff({
  before,
  after,
}: {
  before: ConversationPromptSnapshot
  after: ConversationPromptSnapshot
}) {
  const toolsBefore = JSON.stringify(before.tools, null, 2)
  const toolsAfter = JSON.stringify(after.tools, null, 2)
  return (
    <div className={css.promptDiffSections}>
      {before.system !== after.system && (
        <PromptDiffSection
          title="System Prompt"
          before={before.system}
          after={after.system}
        />
      )}
      {toolsBefore !== toolsAfter && (
        <PromptDiffSection
          title="Tools Definition"
          before={toolsBefore}
          after={toolsAfter}
        />
      )}
    </div>
  )
}
```

---

## 5.3 工具模式 (Tools Schema) 跨轮动态变更检测

在大型 Agent 运行过程中，工具权限和可用工具集合往往随着阶段（如只读探索阶段 vs 写代码阶段）发生动态收缩或扩张。通过将 `tools` 序列化为规范 JSON 并比对 Diff，开发者能够一目了然地定位「为何某个 Tool 在第 3 轮可用而在第 4 轮被剔除」。

---

## 5.4 纯函数派生对前端渲染性能的极致优化

1. **零冗余状态存储**：Redux/Zustand Store 中仅存储离散的 `ConversationPromptSnapshot`，不存储任何衍生 Diff 字符串；
2. **VDOM 级惰性计算**：Diff 计算仅在用户点开该记录 Inspector 的瞬时触发，会话加载速度不受影响；
3. **确定性无副作用**：纯函数输入相同快照必然输出相同行号与高亮，杜绝状态漂移。

---

# 六、 空态白板纯净门闩 (Clean Slate Invariant) 机制深度剖析

## 6.1 白板纯净门闩定义与数学不变量 (`blank && composerPhase === 'blank'`)

在 DSH 中，为了保证新会话白板的绝对纯净与极简，设计了著名的 **Clean Slate Invariant（白板纯净门闩）**：

$$\text{CleanSlate} \iff \text{sessionId} = \text{undefined} \lor (\text{session.blank} = \text{true} \land \text{composerPhase} = \text{'blank'})$$

源码实证：

- [`ConversationSession.tsx:165`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx#L165)：
  ```typescript
  if (blank && composerPhase === 'blank') return null;
  ```
- [`ConversationSession.tsx:72`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx#L72)：
  ```typescript
  const hideChrome = blank && composerPhase === 'blank';
  ```
- [`ConversationRoot.tsx:79-80`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx#L79-L80)：
  ```typescript
  const hero =
    sessionId === undefined ||
    (composerPhase === 'blank' &&
      (openState === 'open' || summaryBlank === true));
  ```

---

## 6.2 骨架树保持与布局平滑过渡 (`ConversationRoot.tsx` 中的 Hero ↔ Composer 翻转)

在很多劣质架构中，空态与活跃态是通过 React 的三元运算符在两个完全不同的组件间切换：

```tsx
// ❌ 错误做法：导致 DOM 节点物理销毁、输入框失焦、动画撕裂
{
  isEmpty ? (
    <EmptyHero />
  ) : (
    <ChatLayout>
      <InputBar />
    </ChatLayout>
  );
}
```

DSH 采用了极其高超的**单树节点驻留 + CSS 空间翻转**设计：

源码位置：[`reference/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx:159-195`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx#L159-L195)

```typescript
const composerBar = (
  <div className={clsx(css.composerStack, hero && css.composerHero)}>
    {hero && <HeroGlow className={css.heroGlow} />}
    {hero && <HeroShell t={t} />}
    {hero && heroWorkspaceRow}
    {zone !== undefined && renderSlot('conversation.input.dock', zone)}
    {inputBar}
  </div>
)

const phase = settling ? 'settling' : hero ? 'hero' : 'active'

return (
  <div className={css.root} data-phase={phase}>
    {renderSlot('conversation.session.header', {})}
    <div className={css.scrollBody} data-conversation-scroll="">
      {renderSlot('conversation.session', {})}
      {composerSeat}
    </div>
  </div>
)
```

- **DOM 零销毁**：`<textarea>` 所在的 `inputBar` 从始至终保持挂载，其物理 DOM 节点从不被 React unmount；
- **CSS 几何变换**：在 `data-phase='hero'` 时，CSS 将 `composerSeat` 居中于发光背景（`HeroGlow`）之上；一旦发送首条消息，`data-phase` 变为 `'active'`，输入框平滑滑落到底部 Dock 停靠区，**整个过程光标焦点 100% 保持，无任何闪烁**。

---

## 6.3 会话头部与视图强力抑制 (`hideChrome` 与 `return null`)

在 `ConversationSessionHeader` 中：

```typescript
<header
  className={clsx(css.header, hideChrome && css.headerHidden)}
  aria-hidden={hideChrome || undefined}
>
  {!hideChrome && (
    /* 仅在非白板态才渲染标题行、面包屑、Tabs 和动作按钮 */
  )}
</header>
```

当处于白板门闩态时，头部占位高直接坍缩为 0，不渲染任何空 Tab 或操作图标。

---

## 6.4 响应式工作区感知与 Chip 状态机 (`WorkspaceChip`)

源码位置：[`reference/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx:84-99`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx#L84-L99)

在白板态下，工作区选择器作为 Hero 的一等公民：

- 冷启动未选工作区：展示「Choose workspace」占位符；
- 用户下拉切换工作区：仅更新待定 ID（`pendingWorkspaceId`），不产生脏会话；
- 工作区删除防御：若工作区在侧边栏被删除，立即重置为占位符，绝不引用孤立路径。

---

## 6.5 输入条多态特化 (`inert` / `blocked` / `hero` / `composer` 状态守卫)

源码位置：[`reference/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx:131-157`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx#L131-L157)

- `inert`（无工作区状态）：禁用输入，点击唤起工作区选择；
- `blocked`（未配置模型）：输入框提示阻塞原因（如「请先配置 API Key 或模型」），但保持模型选择下拉按钮可用；
- `hero`（白板就绪）：展示欢迎提示语；
- `composer`（活跃对话）：常态输入。

---

# 七、 对标 Conex 核心痛点与彻底根治方案 (Conex Pain Points & Grounding Remedies)

## 7.1 Conex 痛点 1 根治：18 文件未提交胶囊污染白板

### 痛点根因深度溯源

在 Conex 中，打开 [`apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.tsx:294`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.tsx#L294)：

```tsx
// ❌ Conex 缺陷源码：直接读取全局 diffCount，无视当前是否处于空态白板
{
  activeBgTasks.length > 0 ||
  hasActivePlan ||
  (diffCount > 0 && Boolean(onOpenDiff)) ? (
    <div className={styles.dynamicChipBar}>
      {diffCount > 0 && onOpenDiff ? (
        <Button variant="ghost" onClick={onOpenDiff}>
          <FileCode2 size={13} />
          <span>{diffCount} 文件修改</span>
        </Button>
      ) : null}
    </div>
  ) : null;
}
```

`diffCount` 是从顶层 `state.diffFiles.length` 盲目透传而来的。只要本地仓库有未提交的代码，任何新开的空白会话、欢迎页面、甚至未选择会话的初始态，都会被强行贴上一个「18 文件修改」的动态胶囊！这彻底摧毁了白板的纯净感。

### DSH 根治解法

建立 **Tier 3 作用域白板纯净门闩**：

```tsx
// ✅ 改造方案：引入 Clean Slate Invariant 判定
const isCleanSlate =
  !activeSessionId || (isSessionEmpty && composerPhase === 'blank');

// 当处于白板状态时，强制抑制全局 diffCount 与工作区脏胶囊
const visibleDiffCount = isCleanSlate ? 0 : diffCount;
```

---

## 7.2 Conex 痛点 2 根治：后台任务浮条在空态强行霸屏

### 痛点根因深度溯源

Conex 的 [`useBackgroundTaskPolling.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/useBackgroundTaskPolling.ts) 在全局轮询后台任务，并将结果无差别推给 `ChatStatusRibbons`。即使在空态欢迎页面，后台偶发的定时任务或监控进程也会以高亮横幅霸占输入框上方。

### DSH 根治解法

1. **任务归属绑定**：后台任务必须归属于发起它的特定 `SessionId`；
2. **全局任务移入状态栏/抽屉**：不属于当前会话的任务绝不在对话主视图的 Composer 上方浮动；
3. **白板门闩屏蔽**：在 `isCleanSlate` 期间，`activeBgTasks` 在主聊天列的渲染权被彻底剥夺。

---

## 7.3 Conex 痛点 3 根治：空态欢迎面与 Composer 闪烁与跳跃

### 痛点根因深度溯源

在 Conex [`ChatCard.tsx:174-219`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatCard.tsx#L174-L219) 中：

```tsx
{state.emptyKind != null ? (
  <div className={styles.chatCol} data-empty-col="true">
    <ChatEmptyState ... />
  </div>
) : (
  <ChatMessageList ... />
)}
```

同时在底部另起 `ChatComposerWrapper`，通过 `styles.chatFooter` 进行定位，导致空态时输入框与欢迎文字之间的相对间距靠 Hack 的 CSS margin 强行垫高。一旦用户输入首个字符发送，整个 `ChatEmptyState` 被暴力卸载，`ChatMessageList` 挂载，输入框发生剧烈的位置突跳。

### DSH 根治解法

对标 `ConversationRoot.tsx`，将 `ChatComposer` 作为稳定的锚点，通过 CSS Flexbox / Grid 统一管理 `data-phase='hero' | 'active'`，实现输入框物理节点零重建与平滑位移。

---

## 7.4 Conex 痛点 4 根治：多 Agent 协作缺乏工作流 DAG 与跨会话直达

### 痛点根因深度溯源

Conex 目前派发子 Agent 仅作为松散的 Tool 命令在消息流中打出一行文本，用户无法直观感知子 Agent 处于哪个阶段（Phase）、并发进度如何、失败时如何单独重试，也无法点击直接切入子 Agent 的执行上下文。

### DSH 根治解法

全面引入 `@deepseek-ai/dsh-client-ui-workflow-run` 架构：

1. 后端输出结构化的 `tool-workflow/agent-start` 与 `agent-end` 事件；
2. 前端聚合为 `WorkflowRunPanel`，提供 Phase 阶段分组与折叠；
3. 每个子 Agent 胶囊附带 `openSession(member.childId)` 跨会话导航能力。

---

## 7.5 Conex 痛点 5 根治：执行轨迹黑盒与调试断层

### 痛点根因深度溯源

Conex 遇到复杂长任务卡顿或死循环时，排查全凭查阅控制台日志，无法横向对比每轮对话耗时与 Token 产生速率。

### DSH 根治解法

在 Conex 侧边栏/主面板集成对标 `ui-trajectory` 的 **DevTools 3-Lane 时序面板**，精确拆解 TTFT 延迟、LLM 吞吐与 Tool 执行时长，并提供基于 `structuredPatch` 的 Prompt Diff 检查器。

---

# 八、 Conex 落地实施演进大纲与生产级代码示范 (Conex Implementation Blueprint)

## 8.1 状态架构重构：引入 `StateScopeRegistry` 与三级作用域隔离

在 `apps/crish-desktop/src/store/` 中建立清晰的作用域分层：

```typescript
/**
 * apps/crish-desktop/src/store/scope/StateScopeRegistry.ts
 * 生产级三级状态作用域隔离基础设施
 */

export type ScopeType = 'global' | 'session' | 'draft';

export interface ScopeContext {
  readonly type: ScopeType;
  readonly sessionId?: string;
  readonly workspacePath?: string;
}

export class StateScopeRegistry {
  private static instance: StateScopeRegistry;
  private currentScope: ScopeContext = { type: 'draft' };
  private readonly listeners = new Set<(scope: ScopeContext) => void>();

  static getInstance(): StateScopeRegistry {
    if (!this.instance) this.instance = new StateScopeRegistry();
    return this.instance;
  }

  setScope(scope: ScopeContext): void {
    this.currentScope = Object.freeze({ ...scope });
    for (const listener of this.listeners) listener(this.currentScope);
  }

  getScope(): ScopeContext {
    return this.currentScope;
  }

  subscribe(listener: (scope: ScopeContext) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 白板纯净门闩守卫函数 */
  isCleanSlate(): boolean {
    return this.currentScope.type === 'draft' || !this.currentScope.sessionId;
  }
}
```

---

## 8.2 白板纯净门闩代码实现规范 (`useCleanSlateInvariant` 与 `CleanSlateGuard`)

### 1. React Hook 封装

```typescript
/**
 * apps/crish-desktop/src/hooks/useCleanSlateInvariant.ts
 */
import { useSyncExternalStore } from 'react';
import { StateScopeRegistry } from '../store/scope/StateScopeRegistry';

export interface CleanSlateState {
  readonly isCleanSlate: boolean;
  readonly scopeType: 'global' | 'session' | 'draft';
  readonly sessionId?: string;
}

export function useCleanSlateInvariant(): CleanSlateState {
  const registry = StateScopeRegistry.getInstance();
  const scope = useSyncExternalStore(
    (onStoreChange) => registry.subscribe(onStoreChange),
    () => registry.getScope()
  );

  const isCleanSlate = scope.type === 'draft' || !scope.sessionId;

  return {
    isCleanSlate,
    scopeType: scope.type,
    sessionId: scope.sessionId,
  };
}
```

### 2. 状态条安全守卫与胶囊熔断改造

在 `ChatStatusRibbons.tsx` 中应用门闩：

```tsx
/**
 * apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.tsx (重构示范)
 */
export const ChatStatusRibbons: React.FC<ChatStatusRibbonsProps> = (props) => {
  const { isCleanSlate } = useCleanSlateInvariant();

  // 🔒 白板纯净门闩物理拦截：当处于 Clean Slate 时，强制屏蔽所有全局脏胶囊
  const safeDiffCount = isCleanSlate ? 0 : (props.diffCount ?? 0);
  const safeBgTasks = isCleanSlate ? [] : props.activeBgTasks;
  const safeActivePlan = isCleanSlate ? false : props.hasActivePlan;

  const showDynamicBar =
    safeBgTasks.length > 0 ||
    safeActivePlan ||
    (safeDiffCount > 0 && Boolean(props.onOpenDiff));

  if (!showDynamicBar && !props.runNotice && !props.showApprovalDock) {
    return null; // 零 DOM 污染
  }

  return (
    <div className={styles.ribbonsContainer}>
      {showDynamicBar && (
        <div
          className={styles.dynamicChipBar}
          role="region"
          aria-label="快捷状态"
        >
          {safeDiffCount > 0 && props.onOpenDiff && (
            <button className={styles.chipButton} onClick={props.onOpenDiff}>
              <FileCode2 size={13} />
              <span>{safeDiffCount} 文件修改</span>
            </button>
          )}
          {/* 其他安全过滤后的任务与计划胶囊 */}
        </div>
      )}
      {/* 错误提示与审批条 */}
    </div>
  );
};
```

---

## 8.3 DevTools 轨迹时间线接入方案

在 Conex 桌面端新增 `TrajectoryPanel`，基于纯函数派生与 SVG/Canvas 渲染：

```typescript
/**
 * apps/crish-desktop/src/components/trajectory/trajectoryPureDerive.ts
 * 纯函数时序与 Diff 派生逻辑
 */
import { structuredPatch } from 'diff';

export interface TimeSpan {
  id: string;
  lane: 0 | 1 | 2; // 0: User/Prompt, 1: Assistant/Compact, 2: Tool
  label: string;
  startMs: number;
  durationMs: number;
  isError?: boolean;
}

export function projectTrajectoryLanes(records: readonly any[]): TimeSpan[] {
  return records.map((record) => {
    let lane: 0 | 1 | 2 = 0;
    if (record.type === 'tool_call') lane = 2;
    else if (record.type === 'assistant_message') lane = 1;

    return {
      id: record.id,
      lane,
      label: record.title ?? record.name ?? 'Operation',
      startMs: record.timestamp,
      durationMs: Math.max(10, record.elapsedMs ?? 0),
      isError: record.status === 'error',
    };
  });
}

export function computePromptPatch(before: string, after: string) {
  if (before === after) return null;
  return structuredPatch(
    'system_prompt',
    'system_prompt',
    before,
    after,
    '',
    '',
    { context: 3 }
  );
}
```

---

## 8.4 总结与核心架构断言

通过对 DeepSeek-Harness（DSH）工作流状态机、多轨时序系统、三级作用域隔离与白板纯净门闩的穷尽式源码解剖，Conex 前端重构的演进路线已经完全明朗：

1. **绝对禁止全局脏状态越权渗透**：全局工作区状态（Git Diff、后台守护任务）必须被限制在 Tier 1，严禁在未经验证的情况下穿透至 Tier 3 白板草稿；
2. **坚定履行白板纯净门闩（Clean Slate Invariant）**：新会话与空态必须以 100% 的纯净度呈现，所有历史统计、变更计数与无归属任务必须物理静默；
3. **保持式单树 Composer 架构**：消除空态与活跃态的组件撕裂，保持输入框物理 DOM 节点，以优雅的 CSS 几何翻转承接用户的每一次灵感迸发；
4. **多 Agent 状态与轨迹工程化**：引入 DAG 阶段状态机与 DevTools 3 轨时序瀑布流，让复杂的多 Agent 协同从黑盒走向完全透明与可控。

本解剖报告为 Conex 客户端架构重构与体验蜕变提供了最高标准的工业级参考基准。
