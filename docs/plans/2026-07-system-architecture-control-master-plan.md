# Crish 系统架构中控方案

| Field | Value |
|-------|-------|
| Date | 2026-07-28 |
| Scope | 全栈：`crish-desktop` · `agent-workbench` · `agent-daemon` · `agent-orchestrator` · `agent-runtime` · `crates/*` |
| Status | **中控定稿** — 按底层逻辑分层；执行按多轮 × 并行 Agent（每轮 ≤8） |
| Related | `ARCHITECTURE.md` · `docs/architecture/session-pending-draft-adr.md` · `analysis/tool_hook_chain_improvement_plan.md` · `docs/plans/2026-07-shell-residual-optimization.md` · `docs/plans/2026-07-conversation-unit-shell.md` |
| Reference | `reference/pi`（AgentHarness hooks）· `reference/jcode`（lifecycle hooks / soft interrupt / crate 边界）· `reference/claudeCode`（query deps） |

---

## 0. 文档目的与使用方式

### 0.1 目的

在「性能下沉 Rust / 前端 shell 改造」已推进的前提下，从**系统底层逻辑**把 Crish 的架构、控制流、双真相、Hook、渲染与用户流程重新对齐为一份**可多轮并行实施的中控方案**。

本方案回答的不是「先修哪几个 bug」，而是：

1. 系统**应有几层真相、几条控制面**；
2. 当前**冲突 / 重复 / 半迁移**落在哪一层；
3. 每一层如何改到**可验收、可并行、可回滚**；
4. 用户感知问题（新建对话、重复消息、AI 多看、停不下来）如何映射到层。

### 0.2 布局原则（强制）

| 原则 | 说明 |
|------|------|
| **按底层逻辑布局** | 章节顺序 = 依赖方向（下→上）。不按 P0/P1 排序问题。 |
| **问题挂层，不挂情绪** | 每个用户症状都反向映射到具体层与契约。 |
| **执行与结构解耦** | 第 1–14 章描述**系统结构**；第 15 章起才是**轮次 × Agent 调度**。 |
| **每轮 ≤8 Agent** | 并行 Agent 文件所有权不交叉；一轮结束必过该层门禁再进下一轮。 |
| **可多轮展开** | 同一层可拆成多轮（契约 → 实现 → 接线 → 验收）。 |
| **引用 reference，不抄仓库** | pi / jcode 的 Hook、DI、软中断作**模式来源**；实现落在 conex 既有包边界内。 |

### 0.3 阅读路径

```
运维/调度 → 第 15–17 章（轮次表）
架构师     → 第 1–8 章（层模型）
前端       → 第 4、9–11、12 章
Runtime    → 第 5–8、13 章
全量实施   → 自第 15 章起按轮推进
```

---

## 1. 系统地图：进程、包、控制面

### 1.1 进程拓扑（产品真相）

```
┌─────────────────────────────────────────────────────────────┐
│  crish-desktop (React 19 + zustand)                         │
│  · 用户可见消息 / 侧栏 / shell layout / 流式投影            │
└───────────────┬─────────────────────────────┬───────────────┘
                │ WS (daemon client)          │ Tauri invoke
                ▼                             ▼
┌───────────────────────────┐   ┌─────────────────────────────┐
│  agent-daemon (Node)      │   │  agent-workbench src-tauri  │
│  · session / run / config │   │  · 窗口 / sidecar / PTY     │
│  · approval / MCP 网关    │   │  · FS / host / rust crates  │
└───────────────┬───────────┘   └──────────────┬──────────────┘
                │                              │
                ▼                              ▼
┌───────────────────────────┐   ┌─────────────────────────────┐
│ agent-orchestrator        │   │ crates/* (Rust 计算层)      │
│ · 会话树 / 事件存储       │   │ · markdown / stream / fs    │
│ · run lifecycle SM        │   │ · db / search / sandbox …   │
└───────────────┬───────────┘   └─────────────────────────────┘
                ▼
┌───────────────────────────┐
│ agent-runtime             │
│ · AgentSessionLoop (SM)   │
│ · provider / tools / hooks│
│ · context / compression   │
└───────────────────────────┘
```

### 1.2 四条控制面（必须显式分离）

| 控制面 ID | 名称 | 谁拥有 | 职责 | 当前混淆点 |
|-----------|------|--------|------|------------|
| **CP-UI** | 表现控制面 | `crish-desktop` | 布局、焦点、空态、加载、本地草稿 UI | 新建对话、empty state、shell unit |
| **CP-SESS** | 会话身份控制面 | desktop session store + daemon session meta | sessionId、draft、侧栏列表、folder 绑定 | Pending Draft ADR 与「空壳列表」并存 |
| **CP-RUN** | 运行控制面 | orchestrator run SM + runtime session SM | start / turn / tool / stop / cancel | 用户停 vs AI 停 vs maxTurns 硬切 |
| **CP-HOST** | 宿主控制面 | Tauri + crates | PTY、FS、md 渲染、IPC | 与 daemon 工具执行双通道 |

### 1.3 用户症状 → 控制面映射

| 用户描述 | 主控面 | 次控面 |
|----------|--------|--------|
| 新建对话点了弹不出来 / 侧栏三个空项目 | CP-SESS + CP-UI | — |
| AI 停不下来 / 不该停时被停 | CP-RUN | CP-UI（stop 按钮语义） |
| 无 Hook / 流程太死 | CP-RUN + Hook 平面（第 6 章） | Observability（第 13 章） |
| 消息重复 / 对话不完整 | CP-UI 投影 + 事件协议（第 9–11 章） | 持久化双真相（第 10 章） |
| AI 看到的比用户多 | 上下文投影（第 8 章） | 工具结果物化 / 隐藏块 |
| 前后端重复、逻辑冲突 | 第 2–3 章契约与组装 | Rust/TS 双实现（第 12 章） |

### 1.4 现状一句话（中控判断）

- **不是**「没有状态机」——`AgentSessionLoop`、`run-lifecycle`、draft ADR 都是 SM。
- **是**「**多条 SM + 多份真相 + 半完成 Hook + 半完成 DI 组装**」叠在一起，用户流程在 CP-UI / CP-SESS 缝上反复摔跤；AI 节奏在 CP-RUN 的硬上限与 Abort 语义上过粗。
- 性能下沉 `crates/*` 正确，但若**契约层未先统一**，下沉只会复制重复路径。

---

## 2. 真相源（Source of Truth）分层

> 任何「重复 / 不完整 / AI 多看」类 bug 的根，几乎都是**真相源未单一化**。

### 2.1 真相源矩阵

| 数据类 | 权威真相 (SoT) | 投影 / 缓存 | 禁止 |
|--------|----------------|-------------|------|
| **会话身份** (id, folder, title meta) | daemon session registry + desktop `sessions[]` 合并规则（以 ADR 为准） | 侧栏、shell openTabs | UI 自 mint 与 daemon 双 mint 无协调 |
| **草稿态** | `PENDING_DRAFT` + `draftFolder`（desktop only） | empty state / composer | 草稿写入 `sessions[]` |
| **用户可见消息正文** | desktop session messages（产品文档已写） | ChatMessageList | 用引擎空壳 **覆盖** 本地 messages |
| **引擎事件流** | runtime → daemon event log | `sessionEventHydrate` / stream store | 与本地消息无 id 对齐地双 append |
| **运行状态** (running/approval/cancelled) | orchestrator run SM | UI ribbons / stop 按钮 | UI 本地猜状态 |
| **工具结果（模型上下文）** | runtime conversation engine messages | 压缩 / blob 外置 | 前端裁切后回灌引擎 |
| **工具结果（用户 UI）** | 投影自事件 + 本地 toolCall 字段 | Tool cards | 与模型上下文 **假定 1:1 全文** |
| **右坞 / layout** | workspaceShell + layoutTree | BinaryTree | Phase1 全局 toolColumn 覆盖 multi-unit |
| **PTY 进程** | Tauri pty registry | TerminalCard | ensure + create 双通道 |
| **Markdown HTML** | `conex-markdown`（Rust）优先 | 前端缓存 | 再维护一套完整 TS 渲染真源 |

### 2.2 双真相冲突模式（当前）

```
模式 A — 双写消息
  send: UI 乐观 append user msg
  stream: daemon events → hydrate 再 append / patch
  若 messageId 不稳定 → 重复气泡

模式 B — 双 SoT 会话列表
  desktop sessions[] 有 3 个空项目会话
  draft ADR 要求草稿不进列表
  旧 createSession 路径仍 mint 空壳 → 侧栏有、点开无 empty/draft 态

模式 C — 模型上下文 ⊃ UI 可见
  tool output 全量进 conversation
  UI 只显示摘要 / 失败静默 / thinking 块被滤
  用户觉得「AI 知道的更多」——这是设计事实，但必须可解释、可开关

模式 D — 停机语义分裂
  UI Stop → cancel run
  maxTurns / shouldStopAfterTurn / AbortSignal / soft interrupt 队列
  无统一「谁有权结束 turn / run」
```

### 2.3 本章目标结构（逻辑完成态）

1. 每类数据只有一个 **Write Authority**。
2. 所有其它层只能 **Read + Project**。
3. 跨层传输必须有 **稳定 id**（sessionId、runId、messageId、toolCallId、traceId）。
4. 合并规则写进契约测试，不允许「再加一个 if 保本地」。

---

## 3. 契约层（Protocol & Types）

### 3.1 契约面清单

| 契约 | 位置（目标/现状） | 内容 |
|------|-------------------|------|
| **Daemon WS API** | `agent-daemon` protocol + validators | session CRUD、run start/cancel、event stream |
| **AgentEvent** | `@crish/shared-types` + runtime event-protocol | delta / tool / approval / end |
| **Canonical Event** | `event-architecture/canonical-event` | 投影到 UI 的中间形 |
| **Provider Stream** | `provider-stream-contract` | 多厂商归一 |
| **Session Draft** | `session-pending-draft-adr` | 哨兵 id、commit 点 |
| **Shell TabSurface** | workspace-shell types | rightDock、openTabs |
| **Tauri commands** | workbench registry + capabilities | invoke 名与 payload |
| **Rust crate API** | `crates/conex-*` + FFI/invoke 包装 | md / stream / db … |

### 3.2 重复与冲突（契约层）

| 现象 | 说明 |
|------|------|
| **两套 session 创建语义** | UI `createSession` vs daemon `session.create` vs draft commit |
| **两套 run 取消** | hard abort vs soft interrupt（jcode 有文档，conex 偏 hard） |
| **两套 hook 叙事** | `AgentHooks`（turn） vs `ToolHook`（tool） vs analysis 里的统一链；实现迁移中 |
| **两套 markdown** | 历史 TS 路径注释残留 + `conex-markdown` |
| **两套消息身份** | 本地 uuid vs 引擎 message id vs stream key |

### 3.3 契约层完成态

- **单一 SessionIdentity 协议**：`draft | local | engine` 三角状态显式，禁止隐式转换。
- **单一 MessageIdentity**：`clientMessageId`（UI 生成）+ `engineMessageId`（可选映射表）。
- **单一 RunControl 协议**：`request_stop` / `force_cancel` / `steer` / `soft_inject` 分事件。
- **单一 Hook 事件目录**（见第 6 章），与 jcode 的 observer/gate 二分对齐。
- **契约测试**：golden JSON + 属性测（id 稳定、合并幂等）。

---

## 4. 会话生命周期与新建对话（CP-SESS + CP-UI）

### 4.1 逻辑状态机（目标）

```
                    ┌──────────────────┐
         enterDraft │                  │ leaveDraft / openHistory
     ──────────────►│  DRAFT           │◄────────────────────────
                    │  active=__pending│
                    │  sessions 无新项  │
                    └────────┬─────────┘
                             │ commitDraftIfNeeded (首条发送)
                             ▼
                    ┌──────────────────┐
                    │  ACTIVE_SESSION  │
                    │  real sessionId  │
                    │  侧栏出现        │
                    └────────┬─────────┘
                             │ close / archive
                             ▼
                    ┌──────────────────┐
                    │  ARCHIVED / GONE │
                    └──────────────────┘
```

### 4.2 当前断裂点（与用户「新建出错」对齐）

| 断裂 | 表现 | 层 |
|------|------|-----|
| **B1 空壳仍进列表** | 侧栏 3 个「新项目对话」，无真实 messages | CP-SESS 旧路径未关死 |
| **B2 点击激活失败** | 点侧栏 → activeSessionId 变了但 empty/draft UI 不匹配 | CP-UI empty kind 与 draft 判定分叉 |
| **B3 shell tab 与 session 脱节** | openTabs 有 GENERAL「对话」草稿，leaf 绑另一 session | workspace-shell binding |
| **B4 项目 folder 过早绑定** | 三个项目各一个空壳 | 违背 ADR「commit 时绑定」 |
| **B5 水合竞争** | hydrate / daemon sync 覆盖或清空 | 第 10 章 |
| **B6 多入口新建** | Ctrl+N、侧栏 +、strip +、FirstRun、openNewDraftTab | 入口未全部走 `enterDraftMode` |

### 4.3 逻辑目标行为（用户流程）

1. 用户点「新建」→ **仅** `enterDraftMode(folder?)` + shell `openNewDraftTab`；**不** `createSession`。
2. 侧栏 **不出现** 新条目；主区显示 **ChatEmptyState 欢迎 / 草稿**。
3. 首条发送 → `commitDraftIfNeeded` mint 真 session → 侧栏出现 → 流开始。
4. 若用户在草稿态切换项目 → 只改 `draftFolder`，不 mint。
5. 历史会话点击 → 激活该 id；若消息未加载 → **loading 空态**，不是「新建对话」空态。
6. 禁止「空 shell + shouldList=true」回归。

### 4.4 与 shell 的耦合（逻辑）

- Draft tab 的 `sessionId === PENDING_DRAFT`。
- `UnitSessionTabStrip` / `activateTab` 必须识别 draft，不要求 layout leaf 已有 bound session。
- 关闭 draft tab = leaveDraft，不是 close 真 session。

### 4.5 验收（本层）

- 连点新建 10 次 → 侧栏仍 0 新空壳（或仅 1 个 draft tab 语义）。
- 三项目切换草稿 → 0 空壳堆积。
- 点历史会话 → 消息完整加载，无「弹不出来新建」。
- 契约测覆盖 ADR 硬接口 1–5。

---

## 5. 运行控制与 AI 自主节奏（CP-RUN）

### 5.1 问题本质

用户要求：

> 给 AI 指令后，它应能**自主控制干活节奏**——想停时能停；不想停时，我们不应强行停。

这不是 UI 问题，是 **Run 控制语义过粗**：

| 现有手段 | 行为 | 问题 |
|----------|------|------|
| `AbortController` / cancel run | 硬中断 | 丢部分结果、打断工具 |
| `maxTurns` / `shouldStopForMaxTurns` | 硬上限 | 任务未完成被迫停 |
| `shouldStopAfterTurn` hook | 可选 | 未成为产品级「自主停」策略 |
| steering / input queue | 有 | 与 soft interrupt 未产品化 |
| UI Stop 按钮 | 通常 = cancel | 用户「暂停」与「终止」未分 |

### 5.2 目标控制语义（逻辑模型）

引入 **四级控制**（名称固定，便于协议与 UI）：

| 级别 | 名称 | 谁发起 | 效果 | AI 是否继续 |
|------|------|--------|------|-------------|
| **L0** | Continue | AI / loop | 下一 turn | 是 |
| **L1** | Soft inject | 用户 | 队列消息，在安全点注入 | **是**（不杀当前 stream） |
| **L2** | Cooperative stop | AI 或策略 hook | 当前 turn 正常收尾，`endReason=stop` | 否（干净停） |
| **L3** | Force cancel | 用户 / 系统 | abort provider + tools | 否（硬停） |

**原则**：

1. **默认用户 Stop = L2（协作停）**，长按或二次确认为 L3。
2. **AI 自主停** = model 无 tool call + 无 pending input + hook `shouldStopAfterTurn` 或 end_turn 信号 → L2。
3. **禁止**用 L3 实现「AI 自己觉得差不多了」——那是 L2。
4. **maxTurns** 从「硬杀」改为：**先 L2 提示 + 可选用户续跑 / 策略提高预算**（产品可配置 hard ceiling）。
5. 参考 jcode `SOFT_INTERRUPT`：仅在 provider 空闲安全点注入。

### 5.3 与状态机的关系

当前已有：

- `AgentSessionLoop` + `createAgentSessionMachine`
- orchestrator `run-lifecycle`（queued…completed/failed）

目标不是再造第三套 SM，而是：

```
Orchestrator Run SM     ← 进程级 run 生命周期（对外 API）
        │
        ▼
Runtime Session SM      ← turn / tool / provider 内部
        │
        ├── ControlIntent 队列（L1/L2/L3）
        └── Hook 平面（是否 L2 自主停、是否允许续跑）
```

**ControlIntent** 成为一等事件，写入 event log，可观测、可测。

### 5.4 「流程太确定化」的正确拆解

| 确定化（应保留） | 过死（应打开） |
|------------------|----------------|
| 状态合法转移 | 每步写死业务策略 |
| 工具 schema / 审批门槛 | 无 hook 的硬编码 stop |
| 消息顺序与 id | 固定 maxTurns 无协商 |
| 安全 fail-closed 边界 | 无法 soft inject / 续跑 |

打开方式 = **Hook + 策略对象**，不是拆掉 SM。

### 5.5 验收（本层）

- 模型输出 end_turn 且无 tool → 自然 L2，不触发 L3 abort 日志。
- 用户点 Stop → 当前 tool 可配置 drain 后 L2；Force → L3。
- 流式中发第二条用户消息 → L1 队列，不 cancel（可配置）。
- maxTurns 触达 → 事件 `budget_exhausted` + UI 续跑，而非静默死。

---

## 6. Hook 与扩展平面

### 6.1 现状

| 能力 | 状态 |
|------|------|
| `AgentHooks`（before/after tool, shouldStopAfterTurn, prepareNextTurn, onError） | 有类型 + ExtensionRegistry 组合 |
| `ToolHook` / 审批流水线 | 有设计文与部分实现；与 AgentHooks **迁移中** |
| 外部进程 hook（jcode 式） | **无** |
| 对话前后 / 性能探测 hook | **无一等入口**（散落 metrics） |
| plugin-sdk | 骨架级 |

用户判断「没有 Hook」在产品意义上成立：**没有稳定、文档化、可挂载的生命周期钩子目录**。

### 6.2 目标：双通道 Hook（对齐 pi + jcode）

#### 6.2.1 进程内 Hook（pi AgentHarness 风格）

```
observe(all) — 只读、不可挡、用于 perf / health / telemetry
on(type)     — 可参与语义（gate / 改写 / stop 建议）
emit(event)  — 仅 loop / runtime 调用
```

事件类型（逻辑目录，可分期落地）：

| Event type | 时机 | 结果类型 | 用途例 |
|------------|------|----------|--------|
| `session.start` / `session.end` | 会话激活/关闭 | void | 健康探测 |
| `turn.start` / `turn.end` | 每 turn | `{ stop?: boolean }` | 自主节奏、perf |
| `context.build` | 组 prompt 前 | `{ messages? }` | 注入/裁剪上下文 |
| `provider.call.start/end` | 调模型 | void / metrics | 延迟 |
| `tool.pre` / `tool.post` | 工具前后 | `{ block? }` / `{ output? }` | 审批、审计 |
| `stream.delta` | 可选采样 | void | 前端不直连 |
| `run.control` | L1/L2/L3 | void | 观测控制 |
| `error` | 错误 | `retry\|skip\|abort` | 恢复 |

#### 6.2.2 进程外 Hook（jcode 风格，可选后期）

- Observer：detach，失败不影响 agent。
- Gate：`pre_tool` exit 2 阻止；fail-open 默认。

先做进程内；进程外作为 Extension 后端一种实现。

### 6.3 与状态机的挂载点

```
INITIALIZED
  → emit session.start / turn.start
AWAITING_MODEL
  → emit context.build → provider.call
STREAMING
  → (optional) stream observers
TOOLS
  → tool.pre → execute → tool.post
TURN_COMPLETE
  → shouldStop / turn.end → 若 continue 则 prepareNextTurn
END
  → session.end / run.control finalize
```

### 6.4 内置 Hook 包（产品）

| 包 | 类型 | 作用 |
|----|------|------|
| `perf-span` | observe | turn/tool/provider 耗时 |
| `health-probe` | observe | 连续错误率、队列深度 |
| `autonomy-stop` | on turn.end | 模型明确完成后建议 L2 |
| `budget-guard` | on turn.end | token/turn 预算协商 |
| `audit-tool` | on tool.pre/post | 安全审计 |
| `ui-mirror` | observe（经 daemon） | 不直接碰 React |

### 6.5 验收

- 无扩展时行为 = 今日 baseline（兼容）。
- 注册 observe hook 可拿到 turn 时序而不改结果。
- gate hook 可 block 工具且模型收到错误文本。
- 文档：`docs/hooks.md` 事件表 + 示例。

---

## 7. 组装与 DI（Composition Root）

### 7.1 参考对照

| 系统 | 模式 | 启示 |
|------|------|------|
| **pi** | Agent + Harness + hooks 注入；deps 显式 | 循环依赖少；测试可 faux |
| **jcode** | crate 边界 + app-core 组装；文档 `CRATE_OWNERSHIP` | Rust 侧模块清晰 |
| **claudeCode** | `query/deps.ts` 显式依赖 | 避免全局单例隐式抓取 |
| **conex 现状** | `AgentSessionLoop` 构造器长参数列表 + 部分全局 store | **半 DI**：能测，但 daemon/UI 组装分散 |

### 7.2 问题不是「没有 DI 框架」

引入 Nest/Inversify **不是**目标。目标是：

1. **Composition Root** 明确（daemon 启动一处、runtime 创建一处、desktop bootstrap 一处）。
2. 核心服务 **接口 + 实现** 可替换（provider、session store、hook registry、clock、id factory）。
3. 禁止深层 `getState()` 隐式耦合（desktop 已有较多 zustand 直取）。

### 7.3 目标组装图

```
DesktopCompositionRoot
  ├── SessionService (draft, commit, list)
  ├── ShellService (tabs, dock)
  ├── RunClient (daemon WS)
  ├── ProjectionPipeline (events → UI)
  └── HostClient (tauri invoke)

DaemonCompositionRoot
  ├── SessionRegistry
  ├── RunSupervisor (orchestrator)
  ├── RuntimeFactory → AgentSessionLoop(deps)
  ├── HookRegistry
  └── ProviderGateway

RuntimeDeps (显式)
  ├── conversation, contextManager, providerGateway
  ├── tools, approvalPipeline
  ├── hooks, inputQueue, steering
  ├── clock, id, eventSink
  └── abort / controlBus
```

### 7.4 与「流程太确定」的关系

DI/组装的意义是：**策略与管线可替换**，状态机骨架稳定。  
例如：`StopPolicy`、`BudgetPolicy`、`ContextPolicy` 作为注入策略，而不是写死在 loop 分支。

### 7.5 验收

- Runtime 单测不启真实 daemon 即可跑 loop（faux provider + faux tools）。
- 替换 `StopPolicy` 不改 session-loop 主文件大段逻辑。
- 文档一张组装图 + 禁止依赖列表（UI 不得 import runtime 内部路径等，已有则强化）。

---

## 8. 上下文投影：AI 所见 vs 用户所见

### 8.1 逻辑上应有两套视图

| 视图 | 消费者 | 内容 |
|------|--------|------|
| **ModelView** | provider messages | system + 历史 + tool 全量/压缩后 + 隐藏推理策略 |
| **UserView** | Chat UI | 用户消息 + 助手可见文本 + 工具卡片摘要 + 审批 UI |

**AI「看到更多」在 agent 产品中是常态**（工具原始输出、system prompt、memory、压缩摘要）。问题在于：

1. 用户无法理解差异 → 信任崩塌；
2. 投影 bug 导致 UserView **丢块** 或 **重复**，而 ModelView 正常；
3. 错误地把 ModelView 字段直接当 UI 渲染，或反过来裁切后写回 ModelView。

### 8.2 当前风险点

| 点 | 说明 |
|----|------|
| tool output 预算 / blob 外置 | 模型侧可能是 URI，UI 未解析则「不完整」 |
| thinking / reasoning 块 | 模型链路有，UI 折叠或滤掉 |
| steering / synthesis nudge | 注入模型但不一定展示 |
| 压缩后历史 | 模型看 summary，用户仍看旧全文或相反 |
| 多 unit 错绑 session | UI 显示 A，请求发 B |

### 8.3 目标结构

```
ConversationEngine (ModelView SoT)
        │
        ├── ContextProjection → provider payload
        └── UserProjection    → daemon events / UI DTO
                │
                └── 禁止回流写 ModelView（除显式 user edit/rewind）
```

产品能力（分期）：

- 「查看模型上下文」调试面板（dev / 高级用户）。
- 工具卡片「展开原始输出」。
- 压缩边界在 UI 用分隔条标明「以下为摘要」。

### 8.4 验收

- 同一 runId：ModelView 消息数 ≥ UserView 可见块数时，差集可分类（hidden_thinking / tool_raw / system / nudge）。
- 无「UI 无助手回复但 run completed」的静默（至少错误/空回复占位）。
- 单测：投影纯函数，给定 engine messages → user DTO 稳定。

---

## 9. 流式事件协议与写路径

### 9.1 目标写路径（唯一）

```
Provider stream
  → runtime normalizer (provider-stream-contract)
  → AgentEvent (shared-types)
  → daemon fan-out (WS)
  → desktop:
        streamingStore  (热路径，仅 processing 行)
        session messages (冷路径，commit 终态 / tool 批)
```

### 9.2 禁止的写路径

| 禁止 | 原因 |
|------|------|
| UI 与 hydrate **双 append 同语义消息**无幂等键 | 重复气泡 |
| stream 每 token 写 immer session.messages | 性能 + 重复 reconcile |
| 本地乐观 user msg **无 clientMessageId**，引擎回显再插一条 | 双用户气泡 |
| 多 listener 各自 setState 同一 text | 双渲染 |

### 9.3 幂等键规则

| 实体 | 幂等键 |
|------|--------|
| user message | `clientMessageId`（发送前生成） |
| assistant message | `runId + turnIndex` 或 engine id |
| tool call | `toolCallId` |
| stream text | `assistantMessageId` → streamingStore.byKey |
| approval | `toolCallId` |

### 9.4 与 Rust `conex-stream` / markdown

- 热路径文本仍可在 JS；**完成态 HTML** 走 `conex-markdown`。
- stream 分帧策略保留 `StreamRenderBuffer`；与协议幂等无关但影响「不完整感」（丢帧/覆盖）。

### 9.5 验收

- 同一事件重放 2 次 → UI 消息条数不变。
- 流式中刷新（若支持 resume）→ 不双份。
- 属性测：任意事件序列，最终 messages 按 id 唯一。

---

## 10. 持久化与水合（Hydration）

### 10.1 路径现状（逻辑）

```
localStorage / Rust DB (迁移中)
  → sessionPersistence
  → sessions[]
  → daemon sync (merge)
  → UI
```

用户「列表有、点开空/错」常在此层。

### 10.2 规则

1. **hydrate 不得删除** 有本地 messages 的会话正文换空引擎壳。
2. **draft 永不 persist 为 sessions[] 条目**。
3. **engine 仅补 meta**（title、remote id），消息以本地为准（ARCHITECTURE.md）。
4. 迁移：localStorage → rust db 单向、可观测、可回滚标记。

### 10.3 验收

- 杀进程重启：侧栏数量 = 可持久化会话；点开 messages 完整。
- 仅远端 ghost 不覆盖本地正文（已有测则锁死扩展）。

---

## 11. 前端渲染身份与列表（UserView）

### 11.1 问题逻辑模型

```
数据重复 ──► 第 9 章幂等
渲染重复 ──► React key / 双订阅 / Strict 双 mount（dev）
列表重复 ──► sidebar dedupe / 多 section 同 id
不完整   ──► 虚拟列表测高错误 / 过滤 bar / 投影丢块 / 流未 commit
```

### 11.2 渲染管道（目标）

```
messages[] (SoT)
  → filter (msg filter bar)  // 纯派生
  → virtualizer window
  → row:
       user: stable key = message.id
       assistant: key = message.id
         ├── streaming? streamingStore text : message.text
         └── tools: toolCallId keys
  → markdown: streaming plain / done async HTML (Rust)
```

### 11.3 必须遵守的身份规则

1. **禁止** `key={index}`。
2. **禁止** 同一 message.id 在列表出现两次（数据层先杀）。
3. streaming 与 final **同一 DOM 行**，不是 stream 行 + final 行。
4. 侧栏：`Map(sessionId)` dedupe；draft 不进 list。
5. 虚拟列表：高度缓存按 message.id；内容变长 invalidate 该 id。

### 11.4 与性能的关系

- `streamingStore` 行级订阅正确方向。
- 仍须避免：ChatCard 整树订 messages + 双订 streamText；tool 批写 immer 导致 Virtualizer 全量。
- Unit strip / layout 另见 shell 方案；本中控只要求 **session 绑 leaf 正确**，否则渲染「不完整」是错会话。

### 11.5 验收

- 对抗测：随机事件 + 重放 → 无重复 id。
- 长会话 1k 消息：滚动无空洞、无永久空白行。
- 流结束：一行内 plain→html，无闪出第二气泡。

---

## 12. 计算下沉与前后端重复（Rust / TS）

### 12.1 crates 职责（逻辑边界）

| Crate | 应负责 | 不应负责 |
|-------|--------|----------|
| `conex-markdown` | MD→安全 HTML、高亮、缓存 | 会话状态 |
| `conex-stream` | 流式缓冲/协议辅助 | UI 状态 |
| `conex-db` | 本地会话存储 | 业务策略 |
| `conex-fs` / `diff` / `search` | 宿主侧能力 | 模型 tool 策略 |
| `conex-sandbox` | 隔离执行 | 审批产品逻辑 |
| `conex-ipc` | 传输 | 领域事件语义 |
| `conex-types` | 共享类型 | — |

### 12.2 重复消除原则

1. **算法类**（md、diff、search）：Rust 为 SoT，TS 仅 FFI/适配。
2. **策略类**（停不停、批不批）：留 TS/runtime，可测。
3. **禁止** TS 与 Rust 各维护一份「真」markdown 渲染。
4. 下沉前必须有 **契约测**（同一 fixture 两端输出一致）。

### 12.3 与 shell/PTY

见 `2026-07-shell-residual-optimization.md`；中控只要求：PTY 生命周期、session 绑定与 CP-HOST 一致，不在 UI 双 spawn。

---

## 13. 可观测性与健康（横切）

### 13.1 与 Hook 的关系

Hook observe 通道 = 业务时序；Metrics/Tracing = 聚合。

最小信号集：

| 信号 | 来源层 |
|------|--------|
| `session_draft_enter/commit` | CP-SESS |
| `run_control{L1,L2,L3}` | CP-RUN |
| `turn_duration_ms` | Hook |
| `tool_block_total` | Hook |
| `message_dedupe_hit` | 投影 |
| `hydrate_conflict` | 持久化 |
| `stream_frame_ms` | UI |
| `pty_orphan_count` | Host |

### 13.2 健康探测（用户要的「流程健康」）

- 连续 N 次 tool error → health hook 告警。
- 侧栏空壳数 > 0 → 不变量失败（dev assert / 遥测）。
- run completed 但 UserView 无 assistant text → 投影告警。

---

## 14. 质量门禁与不变量（跨层）

### 14.1 全局不变量（任何轮次不得破坏）

1. **I-DRAFT**：draft 不在 `sessions[]`。  
2. **I-MSG-ID**：同一 session 内 message.id 唯一。  
3. **I-RUN-END**：终态 run 不再产生 delta（或 delta 被忽略）。  
4. **I-PROJ**：UserView 不得写回 ModelView（除 rewind API）。  
5. **I-STOP**：L2 不走 provider abort；L3 才 abort。  
6. **I-SHELL**：1 session ≤ 1 chat leaf（multi-unit）。  
7. **I-PTY**：1 session ≤ 1 live ptyId（registry）。  

### 14.2 每层门禁

| 层 | 门禁 |
|----|------|
| 契约 | schema / golden |
| 会话 | ADR 测 + UI 流测 |
| Run | loop 测 + control intent 测 |
| Hook | 无 hook = baseline；有 hook 可挡 |
| 投影 | 差集分类测 |
| 流 | 幂等重放 |
| 持久化 | 往返测 |
| 渲染 | 对抗 + virtualizer perf |
| Rust | fixture 一致 |

---

## 15. 多轮执行机制（中控调度）

### 15.1 总规则

1. **轮次按层推进**（可在一层内多轮），不跳过下层契约去改上层 UI 止痛。  
2. **每轮 ≤8 Agent**，表格式派发；文件所有权互斥。  
3. **轮末集成官**（可算第 9 角色，但不计入 8 的并行改码 Agent）：merge、跑门禁、写 Progress。  
4. **失败回滚单位** = 单 Agent 文件集，不整轮 revert，除非契约测红。  
5. **与 shell 残留方案并行**：Shell 专项可插在「层 11/12 相关轮」或独立轨道，但 **session/draft 轮优先于 shell 花活**。

### 15.2 轨道划分

| 轨道 | 内容 | 依赖 |
|------|------|------|
| **Track A** | 契约 · 会话 · 新建对话 | 无 |
| **Track B** | Run 控制 · Hook · DI 组装 | A 契约稳定 |
| **Track C** | 事件 · 投影 · 渲染 · 持久化 | A 的 message id |
| **Track D** | Rust 对齐 · PTY/shell 残留 · 观测 | C 热路径清晰后可并行部分 |
| **Track E** | 出门 QA · 文档 | A–D 阶段性完成 |

轨道可交错，但 **单轮内 Agent 不跨轨道抢同一文件**。

---

## 16. 轮次详表（可执行）

> 下列为**逻辑完备**的默认排期。实施时可合并轮次，但**不得打乱层间依赖**。  
> 每轮格式：目标 · Agent（≤8）· 所有权 · 轮末门禁。

---

### Round A0 — 中控冻结与基线度量

**目标**：冻结本文件为调度真源；采集体征，禁止大改。

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| A0-1 | `baseline-invariants` | 整理 I-* 为可运行测脚手架（可先 skip） | `tests/` 或 desktop invariants |
| A0-2 | `map-create-session-paths` | 枚举所有 createSession/enterDraft/openNewDraft 入口 | 分析 md 产出 |
| A0-3 | `map-message-write-paths` | 枚举所有 append/patch messages 路径 | 分析 md |
| A0-4 | `map-stop-cancel-paths` | 枚举 stop/cancel/abort/maxTurns | 分析 md |
| A0-5 | `map-hook-call-sites` | AgentHooks/ToolHook 实际调用点 | 分析 md |
| A0-6 | `map-rust-ts-dup` | md/stream/db 双实现清单 | 分析 md |
| A0-7 | `capture-ux-repro` | 新建对话 3 空壳复现步骤（tauri-mcp） | scripts / 笔记 |
| A0-8 | `progress-ledger` | 建立 `docs/plans/progress/system-control-ledger.md` | docs |

**门禁**：8 份地图齐；无代码强制。

---

### Round A1 — 契约：SessionIdentity + MessageIdentity

**目标**：身份协议与类型落地。

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| A1-1 | `types-session-identity` | draft/local/engine 状态类型 | shared-types |
| A1-2 | `types-message-identity` | clientMessageId 映射 | shared-types |
| A1-3 | `types-run-control` | L1/L2/L3 事件类型 | shared-types |
| A1-4 | `daemon-validator-session` | 校验器对齐 | agent-daemon validators |
| A1-5 | `desktop-id-factory` | 统一 id 工厂 | crish-desktop api |
| A1-6 | `contract-tests-identity` | golden / 属性测 | tests |
| A1-7 | `docs-contract` | 契约章节同步 ARCHITECTURE | docs |
| A1-8 | `forbid-raw-create` | lint/grep 门禁：禁止裸 createSession 用户路径 | scripts/ci |

**门禁**：类型编译过；身份测绿。

---

### Round A2 — 会话生命周期：关死空壳路径

**目标**：ADR 硬接口成为唯一路径。

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| A2-1 | `enter-draft-only` | 所有「新建」→ enterDraftMode | desktop session/store/shortcuts/sidebar |
| A2-2 | `kill-empty-shell-list` | 侧栏过滤 + hydrate 净化 | session list / persistence |
| A2-3 | `commit-draft-send` | 发送链路 commitDraftIfNeeded | chat send hooks |
| A2-4 | `shell-draft-tab` | openNewDraftTab / activate draft | workspace-shell |
| A2-5 | `empty-state-kinds` | empty kind 与 draft/history/loading 对齐 | ChatEmptyState / resolveEmpty |
| A2-6 | `daemon-create-align` | daemon 创建与 commit 对齐 | agent-daemon handlers |
| A2-7 | `tests-draft-adr` | ADR 测补全 | tests |
| A2-8 | `mcp-new-chat-qa` | tauri-mcp 新建流程脚本 | scripts |

**门禁**：I-DRAFT 绿；新建连点无空壳；点历史不进错 empty。

---

### Round A3 — 会话：点击激活与加载完整

**目标**：「点了弹不出来」归零。

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| A3-1 | `activate-session-atomic` | 激活 = setActive + bind shell + load 标志原子 | storeAccess / session |
| A3-2 | `messages-loading-candidate` | loading 态不闪 empty | chat invariants |
| A3-3 | `hydrate-no-clobber` | sync 不覆盖本地 messages | sessionDaemonSync |
| A3-4 | `sidebar-click-path` | 侧栏点击唯一路径 | useSidebarSessionList |
| A3-5 | `strip-click-path` | unit strip 与侧栏一致 | UnitSessionTabStrip |
| A3-6 | `project-folder-bind` | folder 仅 commit 绑 | draftFolder |
| A3-7 | `tests-activate` | 激活竞态测 | tests |
| A3-8 | `mcp-sidebar-3-ghosts` | 复现包清零验收 | scripts |

**门禁**：三幽灵会话场景消除；激活 100% 出正确 UI。

---

### Round B0 — Run 控制语义设计落地（代码骨架）

**目标**：L0–L3 进入 runtime/orchestrator 类型与分发，不改全 UI。

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| B0-1 | `control-intent-types` | 已有则接线 | shared-types / runtime |
| B0-2 | `control-bus` | ControlIntent 队列 | runtime session-loop |
| B0-3 | `map-l2-end` | 自然 stop → L2 | agent-session SM |
| B0-4 | `map-l3-abort` | force cancel → abort | orchestrator |
| B0-5 | `soft-inject-queue` | L1 安全点注入（对齐 jcode） | inputQueue / steering |
| B0-6 | `maxturns-budget` | budget 事件非静默杀 | session-loop |
| B0-7 | `tests-control` | 控制语义测 | runtime tests |
| B0-8 | `docs-run-control` | 文档 | docs |

**门禁**：单测覆盖 L1/L2/L3 路径。

---

### Round B1 — UI 与 daemon 的 Stop / 续跑

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| B1-1 | `ui-stop-l2` | 默认 Stop = cooperative | Chat chrome / ribbons |
| B1-2 | `ui-force-l3` | 强制停止入口 | 同上 |
| B1-3 | `daemon-control-api` | WS 控制消息 | daemon |
| B1-4 | `continue-after-budget` | 续跑 API | daemon + UI |
| B1-5 | `steer-during-run` | 运行中发送 = L1 | useChatStream / send |
| B1-6 | `status-ribbon-truth` | 状态只信 run SM | ChatStatusRibbons |
| B1-7 | `tests-e2e-control` | 集成测 | tests |
| B1-8 | `mcp-stop-continue` | 手测脚本 | scripts |

**门禁**：不该停时无 L3 日志；该停时有 L2 endReason。

---

### Round B2 — Hook 平面 v1（进程内）

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| B2-1 | `hook-event-catalog` | 事件类型实现 | runtime/hooks |
| B2-2 | `hook-registry-v2` | observe/on/emit | runtime/hooks |
| B2-3 | `wire-session-loop` | 挂载点 | session-loop |
| B2-4 | `migrate-agent-hooks` | 旧 AgentHooks 适配器 | hooks |
| B2-5 | `tool-hook-unify` | 与 ToolHook/审批对齐 | tool-executor / approval |
| B2-6 | `builtin-perf-health` | 内置 observe 包 | runtime |
| B2-7 | `tests-hooks` | baseline 兼容 + gate | tests |
| B2-8 | `docs-hooks` | docs/hooks.md | docs |

**门禁**：无 hook = 旧行为；有 gate 可挡 tool。

---

### Round B3 — Composition Root / 轻量 DI

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| B3-1 | `runtime-deps-object` | RuntimeDeps 显式 | runtime |
| B3-2 | `daemon-composition` | 组装一处 | daemon |
| B3-3 | `desktop-composition` | bootstrap 服务注册表 | desktop bootstrap-services |
| B3-4 | `stop-budget-policies` | 可注入策略 | runtime |
| B3-5 | `faux-provider-path` | 测用 faux | testing |
| B3-6 | `reduce-getstate` | 关键路径去隐式 getState | desktop 指定目录 |
| B3-7 | `tests-compose` | 组装测 | tests |
| B3-8 | `docs-compose` | 组装图 | docs |

**门禁**：Runtime 可无 daemon 单测跑通最小 loop。

---

### Round C0 — 事件幂等与双写收敛

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| C0-1 | `client-message-id-send` | 发送带 clientMessageId | chat send |
| C0-2 | `hydrate-upsert` | hydrate upsert by id | sessionEventHydrate |
| C0-3 | `stream-single-writer` | streamingStore 唯一热写 | useStreamCallbacks |
| C0-4 | `commit-once` | 终态单次 commit | stream end |
| C0-5 | `daemon-event-ids` | 事件带稳定 id | daemon/runtime |
| C0-6 | `dedupe-metrics` | dedupe_hit 指标 | observability |
| C0-7 | `property-tests-events` | 重放幂等 | tests |
| C0-8 | `fix-double-user-bubble` | 对抗双用户气泡 | tests |

**门禁**：I-MSG-ID；重放不增条。

---

### Round C1 — UserView 投影与「AI 多看」可解释

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| C1-1 | `user-projection-pure` | engine→UI DTO 纯函数 | runtime 或 desktop api |
| C1-2 | `hidden-bucket-classify` | thinking/tool_raw/nudge | 同上 |
| C1-3 | `tool-card-expand-raw` | UI 展开原始输出 | components |
| C1-4 | `compression-marker` | 摘要边界 UI | components |
| C1-5 | `dev-model-view-panel` | 调试面板（feature flag） | desktop |
| C1-6 | `no-writeback` | 禁止 UI 写 ModelView 审计 | tests/lint |
| C1-7 | `tests-projection` | 差集测 | tests |
| C1-8 | `docs-two-views` | 产品说明 | docs |

**门禁**：差集可分类；无静默空完成。

---

### Round C2 — 渲染列表：重复与不完整

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| C2-1 | `list-key-audit` | 全 chat 列表 key 审计修复 | message list/row |
| C2-2 | `single-row-stream-final` | stream/final 同行 | ChatAssistant* |
| C2-3 | `virtualizer-height-id` | 高度按 id | MessageVirtualizer |
| C2-4 | `sidebar-dedupe` | 列表 dedupe 锁死 | sidebar |
| C2-5 | `filter-derived` | 过滤纯派生 | filter bar |
| C2-6 | `double-subscribe-fix` | stream 单订阅 | MessageContent/row |
| C2-7 | `tests-render-adversarial` | 重复/空洞 | tests |
| C2-8 | `perf-stream-budget` | 帧预算 | perf tests |

**门禁**：对抗测无重复；长列表无永久空洞。

---

### Round C3 — 持久化水合

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| C3-1 | `persist-no-draft` | draft 不落盘 sessions | persistence |
| C3-2 | `rust-db-path` | rust db 主路径 | sessionRustDb / crates |
| C3-3 | `merge-rules-lock` | daemon merge 规则 | sessionDaemonSync |
| C3-4 | `migrate-oneshot` | 迁移可观测 | migrateFromLocalStorage |
| C3-5 | `tests-roundtrip` | 杀进程往返 | tests |
| C3-6 | `shell-dock-persist` | tab rightDock（可选） | workspace-shell |
| C3-7 | `docs-persistence` | 文档 | docs |
| C3-8 | `qa-restart` | 手测 | scripts |

**门禁**：重启后点开完整。

---

### Round D0 — Rust/TS 对齐与性能残余

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| D0-1 | `md-rust-sot` | 完成态仅 Rust md | desktop + crates |
| D0-2 | `remove-dead-ts-md` | 死路径删除 | desktop api |
| D0-3 | `fixture-parity` | 同 fixture 一致 | tests |
| D0-4 | `stream-crate-use` | conex-stream 接线评估/落地 | crates + desktop |
| D0-5 | `strip-subscribe-narrow` | unit strip 订阅 | UnitSessionTabStrip |
| D0-6 | `tool-stream-lite-store` | tool 增量轻 store | hooks |
| D0-7 | `sash-memo` | resize memo | binary-tree |
| D0-8 | `perf-report` | 更新 perf-report | docs/perf |

**门禁**：无悬空 import；关键 perf 场景不回退。

---

### Round D1 — Shell/PTY 残留（并入中控轨道）

> 细节真源：`2026-07-shell-residual-optimization.md` S0–S2。本轮只调度，不重复写细项。

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| D1-1 | `tool-column-multi` | 全局折叠不藏 per-session tool | adapterShape / flatten |
| D1-2 | `expand-preserve-split` | 投影保留 tool 子树 | adapterShape |
| D1-3 | `update-dock-always` | updateRightDock 按 session | workspaceShellStore |
| D1-4 | `pty-single-ensure` | 单 session 单 PTY | pty* / Terminal |
| D1-5 | `pty-leaf-session` | leafSessionId | TreeLeafPanel / Terminal |
| D1-6 | `d5-strip-drag` | 条带拖拽 | UnitSessionTabStrip |
| D1-7 | `dead-unified-topbar` | 删死代码 | binary-tree |
| D1-8 | `shell-tests` | 定向 vitest | tests |

**门禁**：shell 方案 S0 验收 + I-SHELL + I-PTY。

---

### Round D2 — 可观测性与健康

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| D2-1 | `metrics-core-signals` | 第 13 章信号 | runtime + desktop |
| D2-2 | `health-hook-pack` | 内置 health | hooks |
| D2-3 | `dev-overlay` | 可选 dev 健康条 | desktop |
| D2-4 | `empty-shell-assert` | dev 不变量 | desktop |
| D2-5 | `silent-complete-alert` | 空完成告警 | projection |
| D2-6 | `traceid-end-to-end` | traceId 贯穿 | runtime/daemon |
| D2-7 | `tests-metrics` | 测 | tests |
| D2-8 | `docs-observability` | 文档 | docs |

**门禁**：关键路径有 span；空壳可被探测。

---

### Round E0 — 集成与回归

| Agent | ID | 任务 | 所有权 |
|-------|-----|------|--------|
| E0-1 | `gate-invariants` | I-* 全开 | tests |
| E0-2 | `gate-typecheck` | desktop + core | ci |
| E0-3 | `gate-vitest-targeted` | 相关包 | ci |
| E0-4 | `mcp-user-journey` | 新建→发送→工具→停→重启 | scripts |
| E0-5 | `mcp-multi-unit` | 双 unit 对话 | scripts |
| E0-6 | `doc-sync-all` | ARCHITECTURE + plan status | docs |
| E0-7 | `ledger-close` | 关闭 ledger 项 | docs |
| E0-8 | `release-notes` | 变更说明 | docs |

**门禁**：用户旅程脚本绿；文档与代码一致。

---

### Round E1 — 缓冲轮（按需）

用于 A/B/C/D 失败回流、扩展进程外 Hook、ModelView 面板产品化等。Agent 表临时组，仍 ≤8。

---

## 17. Agent 角色模板（每轮复用）

| 角色 | 职责 |
|------|------|
| **Implementer** | 按所有权改代码 |
| **Tester** | 只加测、不改产品逻辑（可并行） |
| **Docs** | 只文档 |
| **Integrator** | 轮末：合并冲突、跑门禁、更新 ledger（建议人类或单 Agent 串行） |
| **Explorer** | 只读地图（A0） |

派发提示词最小集：

1. 本轮目标与不变量  
2. 文件所有权（只写这些路径）  
3. 禁止事项（不跨层止痛）  
4. 验收命令  
5. 完成后更新 ledger 一行  

---

## 18. 与既有方案的关系

| 文档 | 关系 |
|------|------|
| `2026-07-conversation-unit-shell.md` | Shell UI 轨道；并入 D1 |
| `2026-07-shell-residual-optimization.md` | Shell/PTY P0 细节；D1 执行真源 |
| `tool_hook_chain_improvement_plan.md` | Tool 链细节；服从第 6–7 章目录 |
| `session-pending-draft-adr.md` | 会话法源；A2/A3 强制执行 |
| `ARCHITECTURE.md` | 产品真相；每轮文档 Agent 同步 |
| 历史 ULTIMATE/SYSTEMATIC 大计划 | **不覆盖本中控**；仅考古 |

冲突时：**本中控的层模型与不变量优先**；细节执行可引用专项文。

---

## 19. 风险与反模式

| 反模式 | 为什么禁止 |
|--------|------------|
| 先改 UI 空态文案掩盖空壳 | 不修 CP-SESS |
| 再引入一套全局 event bus 绕过 SM | 第三控制面 |
| 为「灵活」拆掉 session-loop SM | 失去可推理性 |
| 全量上 DI 容器框架 | 过重；要 Composition Root |
| 强制 UserView = ModelView | 破坏 agent 能力 |
| 一轮改遍前后端 | 所有权冲突、无法回滚 |
| 性能优化复制业务逻辑到 Rust | 双策略 |

---

## 20. 成功图像（逻辑完成态）

1. **新建对话**：永远 draft→commit；侧栏无幽灵；点击必出正确主区。  
2. **AI 节奏**：L2 自主/协作停；L3 仅强制；L1 可注入；maxTurns 可协商。  
3. **Hook**：observe/on/emit 目录稳定；perf/health/audit 可挂。  
4. **组装**：RuntimeDeps / 双 Composition Root；策略可替换。  
5. **消息**：幂等 id；无重复气泡；虚拟列表完整。  
6. **双视图**：AI 多看可解释、可展开；投影单向。  
7. **下沉**：算法 Rust SoT；策略 TS；无死双实现。  
8. **Shell/PTY**：与会话绑定一致，无孤儿进程。  
9. **门禁**：I-* 自动化；用户旅程 mcp 可重复。  

---

## 21. 进度账本（模板）

维护文件：`docs/plans/progress/system-control-ledger.md`（**进度真源**；勿在本文件复制全表）

| Round | Date | Agents done | Gate | Notes |
|-------|------|-------------|------|-------|
| A0–A3, B0–B2, C0–C3, D1 | 2026-07-28 | — | **done** | 见 ledger |
| B3, D0, D2, E0 | 2026-07-29 | — | **partial** | Wave 4 收紧 residual；E0 未全量门禁 |
| Wave 4 | 2026-07-29 | 8/8 | **done** | tool.pre/post、删 session-actions、strip/sash、PTY exit kill_all、restore ADR、ModelView debug、D0 dead md、D2 metrics |
| Wave 5 | 2026-07-29 | — | **in progress** | E0 集成 + B3/D0/D2 residual；完整行见 ledger |

---

## 22. 附录

### 22.1 用户问题索引

| # | 用户原话 | 本方案章节 |
|---|----------|------------|
| 1 | 新建对话出错 / 侧栏空项目 | §4, Rounds A2–A3 |
| 2 | AI 自主节奏 / 不该停别停 | §5, Rounds B0–B1 |
| 3 | 缺乏 Hook / 是否状态机 | §5–6, B2；是 SM + 应有 Hook |
| 4 | DI（pi / jcode） | §7, B3 |
| 5 | 流程太确定 | §5.4, §7.4 |
| 6 | 消息重复 / 渲染重复 / 不完整 | §9–11, C0–C2 |
| 7 | AI 比用户看的多 | §8, C1 |
| 8 | 前后端冲突重复 | §2–3, §12, D0 |
| 9 | 性能还可做 | §11.4, §12, D0–D1 |
| 10 | 多轮 ≤8 Agent | §15–17 |

### 22.2 关键代码锚点（实施时）

| 区域 | 路径 |
|------|------|
| Session loop | `packages/agent-runtime/src/session-loop/` |
| Hooks | `packages/agent-runtime/src/hooks/` |
| Run SM | `packages/agent-runtime/src/state-machine/` |
| Draft ADR | `docs/architecture/session-pending-draft-adr.md` |
| Desktop stream | `apps/crish-desktop/src/hooks/chat-stream/` |
| Session sync | `apps/crish-desktop/src/api/sessionDaemonSync.ts` |
| Shell | `apps/crish-desktop/src/store/workspace-shell/` |
| Rust | `crates/conex-*` |
| Ref hooks | `reference/pi/packages/agent/docs/hooks.md` |
| Ref soft int | `reference/jcode/docs/SOFT_INTERRUPT.md` |
| Ref lifecycle hooks | `reference/jcode/docs/HOOKS.md` |

### 22.3 建议启动命令（调度官）

```text
1. 开 Round A0（8 explorer，只读地图）
2. 确认 A0 地图与本中控无矛盾
3. Round A1 → A2 → A3（会话用户流程优先）
4. 并行条件满足后：B0 与 C0 可分两周交错
5. Shell D1 可在 A3 后门禁绿后插入
6. 每轮更新 system-control-ledger.md
```

---

**文档结束。**  
实施时以本文件为中控；专项 shell/PTY/tool-hook 文作子程序。若产品决策与默认冲突（例如默认 Stop=L3），只改 §5.2 表并波及 B1，不推翻层模型。
