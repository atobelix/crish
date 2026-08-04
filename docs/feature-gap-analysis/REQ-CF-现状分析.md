# 模块 C（定时调度与反应式唤醒）+ 模块 F（搜索、读取与防截断工具）——需求现状分析

> **文档版本**：v1.0
> **创建日期**：2026-08-04
> **文档性质**：现状调查与差距分析（Feature Gap Analysis）
> **上游需求**：`docs/feature-gap-analysis/REQ-agent-engine-capabilities.md` 第四章（模块 C：REQ-C01~C05）与第七章（模块 F：REQ-F01~F03）
> **适用范围**：Rust 内核（`crates/`）、Tauri 壳层（`apps/agent-workbench/`）、React 前端（`apps/crish-desktop/`）
> **配套文档**：本文为"模块 C + 模块 F"的现状分析；其余模块的现状分析见 `docs/feature-gap-analysis/` 同名系列文档

---

## 目录

- [一、调查范围与方法](#一调查范围与方法)
- [二、需求全景与现状结论速览](#二需求全景与现状结论速览)
- [三、现状架构地图](#三现状架构地图)
- [四、模块 C：定时调度与反应式唤醒引擎](#四模块-c定时调度与反应式唤醒引擎)
- [五、模块 F：搜索、读取与防截断工具体系](#五模块-f搜索读取与防截断工具体系)
- [六、模块总结：判定表、真 Gap 清单与优先级建议](#六模块总结判定表真-gap-清单与优先级建议)
- [附录 A — 证据文件清单](#附录-a--证据文件清单)

---

## 一、调查范围与方法

### 1.1 调查范围

本文覆盖两条需求线：

| 模块 | 需求编号 | 需求名称 | 优先级 | 需求文档位置 |
| :---: | :---: | :--- | :---: | :--- |
| C | REQ-C01 | 单次定时器（One-shot Timer） | P1 | REQ-agent-engine-capabilities.md:283-298 |
| C | REQ-C02 | 智能早退条件（TimerCondition） | P1 | REQ-agent-engine-capabilities.md:301-319 |
| C | REQ-C03 | 周期性 Cron 调度（Recurring Cron） | P1 | REQ-agent-engine-capabilities.md:322-338 |
| C | REQ-C04 | 反应式唤醒机制（Reactive Wakeup） | P0 | REQ-agent-engine-capabilities.md:342-364 |
| C | REQ-C05 | AI 等待策略自动选择 | P2 | REQ-agent-engine-capabilities.md:367-382 |
| F | REQ-F01 | 全局符号与引用检索（Grep Search） | P0 | REQ-agent-engine-capabilities.md:711-730 |
| F | REQ-F02 | 完整文件读取与防截断机制 | P1（重点） | REQ-agent-engine-capabilities.md:733-766 |
| F | REQ-F03 | 目录结构列举 | P0 | REQ-agent-engine-capabilities.md:770-785 |

### 1.2 调查对象（证据文件）

| 部件 | 文件 | 与本任务的相关性 |
| :--- | :--- | :--- |
| 三模式等待工具 | `crates/agent-tools/src/tools/wait_subagents.rs` | REQ-C01/C05 的直接现状：await-all / timer / parallel-work 三模式、10 分钟硬上限、事件驱动等待原语、dispatch_* 持久化 |
| 控制总线 | `crates/session-loop/src/control.rs` | L0-L3 控制协议、soft_inject / steer / followUp 分环注入——反应式唤醒的注入通道 |
| 输入队列 | `crates/session-loop/src/input.rs` | force / steer / followUp 三环，AI 被唤醒后消息进入 run 的入口 |
| 钩子注册表 | `crates/session-loop/src/hooks.rs` | 14 种插件钩子事件（session/turn/tool/compaction/error/subagent/model）——观察型事件面 |
| DAG 调度器 | `crates/orchestrator/src/flow_graph.rs` | 合成唤醒（不轮询）、终态事件驱动推进、并发预算 |
| 子代理事件源 | `crates/orchestrator/src/subagent_events.rs` | subagent-started / subagent-event / subagent-ended 唯一发射方 |
| 恢复阶梯 | `crates/orchestrator/src/recovery.rs` | 四级恢复阶梯 + 阶梯 2 经 steering 队列与落库通知唤醒主 agent |
| 待处理消息队列 | `crates/orchestrator/src/steering_queue.rs` | replaceOrEnqueue 分组去重、批量推送语义 |
| 事件队列 | `crates/orchestrator/src/events.rs` | sequence 分配 + 持久化分流（背压落地） |
| 域事件契约 | `crates/conex-types/src/events.rs` | 31 种域事件、背压三级分级函数 |
| 搜索工具 | `crates/agent-tools/src/tools/search.rs` | REQ-F01 现状：grep_search / fuzzy_find |
| 文件系统工具 | `crates/agent-tools/src/tools/fs.rs` | REQ-F02/F03 现状：read_file / list_dir / file_stat |
| 工具共享助手 | `crates/agent-tools/src/tools/mod.rs` | clamp_text（截断）、decode_text（解码）、BuiltinToolConfig（接线面） |
| run 驱动 | `apps/agent-workbench/src-tauri/src/core_run_commands.rs` | drive_run_loop、RunProducer、审批门——run 级唤醒的壳层接线 |
| 引擎装配 | `apps/agent-workbench/src-tauri/src/engine.rs` | 内置工具注册（默认配置）、SessionLoopProducer |
| 前端定时面板 | `apps/crish-desktop/src/components/settings/ScheduledTasksPanel.tsx` | 前端定时任务 UI 现状 |
| 前端调度 API | `apps/crish-desktop/src/api/workflow-api/workflowScheduler.ts` | 调度类型定义（manual/daily/intervalMinutes）、cron 校验器 |
| 前端运行 API | `apps/crish-desktop/src/api/workflow-api/workflowRunner.ts` | Tauri 下 workflow 命令为幽灵命令的显式声明 |

### 1.3 调查方法

- 以需求文档的"详细规格 + 验收标准"为基准，逐条对照现状代码，给出**现状证据（文件:行号）→ 判定 → 差距 → 怎么做**四段式结论。
- 判定分四级：**已满足**（验收项全部达成）/ **部分覆盖**（核心语义存在、个别规格项缺失或未接线）/ **缺口**（无对应实现或仅空壳）/ **不适用**（需求与现有架构冲突，需架构裁决）。
- 建议一律落到现有架构（事件总线、控制总线 L0-L3、输入三环、session_meta 键命名空间、BuiltinToolConfig 注入），不另起炉灶；凡涉及"反过度设计"原则的，标注最小实现路径。

---

## 二、需求全景与现状结论速览

### 2.1 速览判定表

| 需求 | 优先级 | 现状判定 | 一句话结论 |
| :---: | :---: | :---: | :--- |
| REQ-C01 单次定时器 | P1 | **缺口** | 无独立定时器工具；wait_subagents 的 timer 模式仅是"子代理等待窗"子集，且引擎侧未接线 |
| REQ-C02 早退条件 | P1 | **缺口** | 无 TimerCondition 概念；wait 原语内嵌"指定任务终态即返回"，无 any 语义、无冲突检测 |
| REQ-C03 Cron 调度 | P1 | **缺口** | 前端有完整面板与 cron 校验器，但引擎显式拒绝 cron 下发且 workflow 命令在 Tauri 下是幽灵命令——纯死 UI |
| REQ-C04 反应式唤醒 | P0 | **部分覆盖** | run 内事件驱动完备（终态/子代理/用户消息/恢复通知），但定时器/Cron 两类唤醒源缺失、无会话级 idle 待命、唤醒摘要无标准化注入 |
| REQ-C05 等待策略 | P2 | **部分覆盖** | 三模式等待工具契约 + 事件驱动原语 + dispatch_* 持久化已齐，但通道未接线、无兜底 watchdog、无策略自动选择 |
| REQ-F01 Grep | P0 | **部分覆盖** | 正则/glob/大小写/上限截断全有；缺文件级（grep -l）模式与"排除式 glob"语法 |
| REQ-F02 防截断读取 | P1（重点） | **缺口** | 只有字符预算截断（maxBytes + truncated 标记）；无行号范围、无完整行边界截断、无 ContentOffset 续读 |
| REQ-F03 目录列举 | P0 | **基本满足** | 深度 1、类型/大小/mtime 齐全；差"目录子项数量"与"相对路径"字段 |

### 2.2 三句话摘要

1. **模块 C 的整体现状是"事件驱动底座已就绪，时间驱动能力为零"**：31 种域事件、背压三级、L0-L3 控制总线、L1 注入环、DAG 合成唤醒、恢复阶梯通知——反应式唤醒的骨架全部在库；但"定时器/Cron"这两个时间维度唤醒源在 Rust 内核中零实现，前端定时任务面板是连不到引擎的空壳。
2. **模块 F 是"搜索已达标、读取防截断缺核心"**：grep_search 与 REQ-F01 的差距只有两个小参数；read_file 则整体缺失 REQ-F02 的关键机制（行号范围、完整行边界、ContentOffset 续读）——这正是需求文档标注"AI 读到一半被截断导致误判"要解决的痛点。
3. **落地的公共底座是"wait_subagents 接线 + 定时器注册表"**：三模式等待通道契约已在 agent-tools 定义（SubagentWaitChannel），引擎侧实现后，C01 定时器、C02 早退、C05 兜底 watchdog 都在这根线上生长；F 模块则可完全独立先行。

---

## 三、现状架构地图

> 本节描述与模块 C/F 相关的现有架构部件，作为后文逐条需求判定的共同事实基础。所有结论均可复核，引用统一为 `文件路径:行号`。

### 3.1 事件体系：31 种域事件 + 背压三级（已就绪）

#### 3.1.1 事件契约（conex-types）

- `AgentEvent` 是 31 种域事件的 serde tagged enum，顶层 `type` 为 kebab-case 事件名，字段全部 camelCase（`crates/conex-types/src/events.rs:285-604`）。
- 事件类型名注册表：`engine_event_type_names!` 宏统一展开 `type_name()` 与 `ALL_TYPE_NAMES`（`crates/conex-types/src/events.rs:611-664`），与 `contracts/engine-events.json` 注册表由 `tests/registry_drift.rs` 双向锁定——新增事件必须在两处登记。
- 事件信封：`AgentEventEnvelope`（runId / sequence / schemaVersion 由 emit 层统一注入，`crates/conex-types/src/events.rs:713-800`）。

#### 3.1.2 背压三级（M7）

- `BackpressureLevel` 三档：Delta（增量可丢）/ Soft（尽力投递）/ Critical（必达落库）（`crates/conex-types/src/events.rs:173-182`）。
- 静态分级函数 `event_backpressure`（`crates/conex-types/src/events.rs:676-685`）：
  - Delta：`message-delta`、`subagent-event` 的 progress 类；
  - Soft：`subagent-event` 的 message / tool 类；
  - Critical：其余全部（含 subagent-started / subagent-ended、终态、审批、审计）。
- 子代理事件类别：`SubagentEventKind`（progress / message / tool，`crates/conex-types/src/events.rs:121-130`），kind 级分级 `subagent_event_kind_backpressure`（`crates/conex-types/src/events.rs:690-695`）。

#### 3.1.3 事件序列与持久化分流（EventQueue）

- `EventQueue::push` 分配会话级原子序列号，持久化事件同步等待落库、非持久化（delta）直接返回不阻塞 drive loop（`crates/orchestrator/src/events.rs:106-200`）。
- `event_class` 分类（`crates/orchestrator/src/events.rs:47-57`）与 `event_backpressure` 同源，双护栏锁定。

**对本任务的意义**：模块 C 需要的"唤醒事件源"（后台命令完成 → `run-terminal`、子 Agent 消息 → `subagent-*`、恢复通知 → `recovery-*`）在事件注册表中均已有类型位；定时器到期 / Cron 触发的**新事件类型**如需落库，须走注册表登记流程（`crates/conex-types/src/events.rs:606-610`）。

### 3.2 控制总线与输入队列：唤醒注入通道（已就绪）

#### 3.2.1 L0-L3 控制协议（control.rs）

- `ControlKind` 六变体：continue / soft_inject / steer / follow_up / cooperative_stop / force_cancel（`crates/session-loop/src/control.rs:32-45`）。
- `ControlLevel` L0-L3：L0 continue（不入队）、L1 soft inject（steer 环 / followUp 环）、L2 cooperative_stop、L3 force_cancel（`crates/session-loop/src/control.rs:48-59`，映射见 `level_for_kind` :62-69）。
- `ControlBus` 队列面：`request` 入队补 id/level/created_at（:231-247）；`drain_as_action` 聚合优先级 force_cancel > cooperative_stop > soft_inject（:363-420）。
- L1 分环：`inject_ring_for_kind` —— steer（下一安全点）/ followUp（仅 run idle）（`crates/session-loop/src/control.rs:77-83`、RingChoice :111-117）。

#### 3.2.2 输入三环（input.rs）

- `AgentInputQueue` 三环：force（可中断）/ steer（安全点）/ followUp（仅 idle）（`crates/session-loop/src/input.rs:36-45`、:96-103），容量 1000（:19）。
- awaiting-input 处理：安全点检查 → dequeue → 无输入则 `NoInput` → stop 收场（run 结束）（`crates/session-loop/src/loop/handlers/awaiting_input.rs:14-32`）。

**对本任务的意义**：定时器 / Cron 到期"注入 Prompt 唤醒 AI"的标准通道已经存在——`ControlBus::request_follow_up`（`crates/session-loop/src/control.rs:289-302`）恰好是"仅 run idle 消费"的 followUp 环，语义与"AI 无事可做时被唤醒"完全吻合；若需要在 run 运行中不打断地提示，则用 `request_steer`（:253-266）。恢复阶梯 2 已经验证过这条路径（见 3.4）。

### 3.3 调度与等待：DAG 合成唤醒 + 三模式等待原语

#### 3.3.1 DAG 依赖图调度器（flow_graph.rs）

- `FlowScheduler`：终态事件驱动推进，**不轮询**（模块文档 `crates/orchestrator/src/flow_graph.rs:11-13`、:21-24、`advance` :918-1090；`on_subagent_terminal` :1096-1210）。
- 合成唤醒：综合节点（gate/verify/critique 类）全部前置就绪时产 `FlowWakeup`（:512-523），`wakeup_sent` 幂等防死观测（:413-415、:955-966）；唤醒事件经 `take_wakeups` 队列由引擎侧消费（:847-850），引擎侧经 L1 注入通知主 agent 或自动排队综合 run。
- 并发预算：`ConcurrencyBudget` reserve/release（:432-487）、跨重启 recompute 防 double-charge（:481-486）。
- 持久化：`flow_*` 键命名空间（声明 / 状态 / 预算，:663-678），`FlowMetaStore` 抽象经 `LocalDb` 实现（:681-702）。
- 子代理事件发射：spawn 成功发 `subagent-started`、收口发 `subagent-ended`（`SubagentEventEmitter` 挂载 :805-810，发射点 :1010-1037、:1134-1171）。

#### 3.3.2 三模式等待原语（wait_subagents.rs）

- `WaitMode` 三模式：await-all（等全部终态）/ timer（到点返回未完成列表）/ parallel-work（立即返回快照）（`crates/agent-tools/src/tools/wait_subagents.rs:40-72`）。
- 常量：`MAX_WAIT_TIMEOUT_MS = 600_000`（10 分钟硬上限，:75）、`DEFAULT_TIMER_WAIT_MS = 30_000`（timer 缺省 30s，:78）。
- 事件驱动等待原语 `wait_for_terminal_events`：消费 `SubagentTerminalEvent` 流直到全部终态或超时（:233-305）——终态事件幂等去重、非等待名单事件忽略、流关闭 fail-open。
- 调度声明持久化：`DispatchDeclaration`（mode / wait_ms / subagent_ids / dispatched_at_ms）落 session_meta `dispatch_*` 键（:83-89、:124-199），`remaining_wait_ms` / `is_expired` 支持重启恢复（:138-147）。
- 通道契约：`SubagentWaitChannel` trait 四方法——persist_declaration / snapshot / wait_for_terminal / inject（:366-389）；工具本体 `WaitSubagentsTool`（:394-596），通道未接线时返回结构化 `common.unsupported` 错误（:533-538）。
- 运行中注入：`inject` 参数经目标 run 的 L1 steer 环（`request_subagent_inject`，`crates/session-loop/src/control.rs:275-286`；消息构造 `subagent_inject_message` :95-108）。

**关键现状事实**：`wait_subagents` 在工具注册表中以默认配置注册（`crates/agent-tools/src/tools/mod.rs:110-112`，`BuiltinToolConfig::default` 中 `subagent_wait_channel = None`，:60-71）；生产装配 `EngineHandle::new` 用 `register_builtin_tools`（`apps/agent-workbench/src-tauri/src/engine.rs:617`），即**引擎侧尚未实现任何通道**，子 Agent 等待链路整体处于"契约已定义、接线未完成"状态。

### 3.4 恢复阶梯与待处理消息队列：跨 run 唤醒的样板

- 四级恢复阶梯（模块文档 `crates/orchestrator/src/recovery.rs:7-31`）：L1 自动重试（镜像 agent-provider retry 语义，:108-236）→ L2 主 agent 激活（软注入）→ L3 重分配/fork → L4 上报用户。
- 阶梯 2 的唤醒实现：`build_steering_entry` 构造 steering 条目（`:371-380`），group_id = `recovery-<run_id>`（`:354-356`，replaceOrEnqueue 去重），通知落库 `recover_notifications`（`:82`、:336-351），主 agent 激活指令经 L1 steer 环送达（模块文档 :15-20）。
- `PendingMessageQueue`：跨 run steering 队列，分组 replaceOrEnqueue 去重（`crates/orchestrator/src/steering_queue.rs:6`、:111、:145）、`transfer_follow_up` 转 followUp 环（:16）、`drain_nudges`（:219）。
- 恢复预算制：操作指纹 + Episode 预算（`crates/orchestrator/src/recovery.rs:244-329`），重启不重放授权。

**对本任务的意义**：这是"引擎侧事件 → steering 条目 → 落库 → 跨 run 注入主 agent"的现成样板——REQ-C05 的兜底唤醒通知与 REQ-C03 的 Cron 通知都可以复用同一模式，无需新造轮子。

### 3.5 工具层：搜索与文件工具现状

#### 3.5.1 grep_search / fuzzy_find（search.rs）

- `grep_search` 入参：query / path / regex / glob / caseSensitive / maxMatches（默认 200）/ maxFiles（默认 2000）/ maxFileBytes（默认 512,000）（`crates/agent-tools/src/tools/search.rs:57-71`、默认值 :18-20）。
- 执行语义：递归遍历（gitignore 感知 + SKIP_DIRS 排除 + 深度上限 16，:194-238）、二进制跳过（:132-134）、行内列号（:152）、结果截断 truncated 标记（:155-163）。
- 自研 glob 匹配器 `glob_match`：`*` 不跨分隔符、`**` 可跨、`?` 单字符（:241-268）。
- `fuzzy_find`：复用 conex-search 目录索引 + 模糊打分（:323-325），limit 默认 20 上限 100（:317-319）。

#### 3.5.2 read_file / list_dir / file_stat（fs.rs）

- `read_file`：仅 path + maxBytes（默认 256,000）两个参数（`crates/agent-tools/src/tools/fs.rs:32-40`、:18），字符预算截断 `clamp_text`（`crates/agent-tools/src/tools/mod.rs:384-390`）——**在字符边界截断，可能切断行中间**；truncated 布尔标记（fs.rs:94、:125）；二进制文件拒绝返回错误（fs.rs:86-91）。
- `list_dir`：深度 1 直接子项（read_dir，fs.rs:352-375），DirEntry 字段 name/type/isFile/isDirectory/size/mtime（:288-296），目录排前按名排序（:377）。
- `file_stat`：单路径元数据（:405-478）。

### 3.6 前端与壳层：定时任务面板与 workflow 幽灵命令

- 前端定时任务面板 `ScheduledTasksPanel`（主对话区嵌入，`apps/crish-desktop/src/components/settings/ScheduledTasksPanel.tsx:31-206`）：预设行 + WorkflowForm 表单 + WorkflowList + RunHistoryList，共享状态 `useWorkflowsState`。
- 调度类型定义：manual / daily（HH:mm + IANA 时区）/ intervalMinutes（1 分 ~ 7 天）（`apps/crish-desktop/src/api/workflow-api/workflowScheduler.ts:6-18`）。
- cron 校验器完整存在（5 字段、步进/区间/列表，:99-205），但注释明确"引擎当前不下发 cron"（:166-167），且 `validateWorkflowSchedule` 对合法 cron 显式返回错误"引擎暂不支持 cron 调度"（:301-312）。
- **幽灵命令事实**：`workflowRunner.ts` 模块文档（`apps/crish-desktop/src/api/workflow-api/workflowRunner.ts:4-7`）明确声明"Tauri 下无 workflow 引擎（list/create/update/delete/trigger-workflow、list-workflow-runs 均为幽灵命令，Rust 侧无）"；运行类函数全部恒返回空表或 `ok:false`（:27-87）。对 Rust 侧 `crates/` 与 `apps/agent-workbench/src-tauri/` 的全局检索确认：workflow 相关命令与定时器引擎**零实现**（见附录 A）。

### 3.7 关键结构代码摘录（任务书拆解速查）

> 本节摘录与模块 C/F 直接相关的核心数据结构与契约签名，供后续任务书拆解时直接引用，避免重复翻阅源码。

#### 3.7.1 三模式等待（wait_subagents.rs）

```rust
// crates/agent-tools/src/tools/wait_subagents.rs:40-51
pub enum WaitMode {
    AwaitAll,      // 等待全部已发子代理到达终态后再规划下一步
    Timer,         // 等待固定时间窗（dispatch_wait_ms，默认 30s）后唤醒
    ParallelWork,  // 分发后立即返回，主 agent 转入并行工作
}
// :75  pub const MAX_WAIT_TIMEOUT_MS: u64 = 600_000;  // 10 分钟硬上限
// :78  pub const DEFAULT_TIMER_WAIT_MS: u64 = 30_000; // timer 缺省 30s
```

#### 3.7.2 等待通道契约（wait_subagents.rs:366-389）

```rust
#[async_trait]
pub trait SubagentWaitChannel: Send + Sync + std::fmt::Debug {
    async fn persist_declaration(&self, declaration: &DispatchDeclaration)
        -> Result<(), SubagentWaitError>;                 // dispatch_* 键落 session_meta
    async fn snapshot(&self, subagent_ids: &[String])
        -> Result<Vec<SubagentWaitStatus>, SubagentWaitError>; // 非阻塞状态摘要
    async fn wait_for_terminal(&self, subagent_ids: &[String], timeout_ms: Option<u64>)
        -> Result<SubagentWaitResult, SubagentWaitError>; // 事件驱动阻塞等待
    async fn inject(&self, subagent_id: &str, prompt: &str)
        -> Result<(), SubagentWaitError>;                 // L1 steer 环注入
}
```

#### 3.7.3 L0-L3 控制协议（control.rs:32-59）

```rust
pub enum ControlKind { Continue, SoftInject, Steer, FollowUp, CooperativeStop, ForceCancel }
pub enum ControlLevel { L0, L1, L2, L3 }
// 分环：steer → 下一安全点；followUp → 仅 run idle（inject_ring_for_kind，:77-83）
// 注入通道：request_steer（:253-266）/ request_follow_up（:289-302）/
//          request_subagent_inject（:275-286）
```

#### 3.7.4 事件背压三级（events.rs:173-182、:676-695）

```rust
pub enum BackpressureLevel { Delta, Soft, Critical }
// Delta：message-delta、subagent-event progress（可丢不落库）
// Soft：subagent-event message/tool（尽力投递）
// Critical：subagent-started/ended、终态、审批、审计（必达落库）
```

#### 3.7.5 read_file 现状入参（fs.rs:32-40）

```rust
"properties": {
    "path": { "type": "string", "description": "工作区文件路径（相对或绝对）" },
    "maxBytes": { "type": "number", "description": "返回内容字符数上限，默认 256000" }
}
// 无 startLine / endLine / contentOffset / maxLines —— REQ-F02 全部待补
```

#### 3.7.6 grep_search 现状入参（search.rs:57-71）

```rust
"properties": {
    "query": { "type": "string" },                                    // 必填
    "path": { "type": "string" },                                     // 缺省工作区根
    "regex": { "type": "boolean" },                                   // 缺省 false
    "glob": { "type": "string" },                                     // 正例过滤
    "caseSensitive": { "type": "boolean" },                           // 缺省 true
    "maxMatches": { "type": "number" },                               // 默认 200
    "maxFiles": { "type": "number" },                                 // 默认 2000
    "maxFileBytes": { "type": "number" }                              // 默认 512000
}
// 缺 matchPerLine（文件级模式）与排除 glob
```

#### 3.7.7 钩子事件 14 变体（hooks.rs:59-106）

```rust
pub enum HookEventKind {
    SessionStart, SessionEnd, TurnStart, TurnEnd,
    ToolPre, ToolPost, ToolError,
    ContextCompactStart, ContextCompactEnd,
    ErrorOccurred,
    ModelBeforeRequest, ModelAfterResponse,
    SubagentStart, SubagentEnd,
}
// 冻结测试：hook_kind_names_frozen_14（hooks.rs:1118-1154）与 hooks.ts 双向锁定
// 注意：钩子是"观察型事件面"，非 AI 唤醒通道——唤醒走控制总线 L1 环
```

#### 3.7.8 前端调度类型（workflowScheduler.ts:6-9）

```typescript
export type WorkflowSchedule =
  | { type: 'manual' }
  | { type: 'daily'; time: string; timezone: string }        // HH:mm + IANA 时区
  | { type: 'intervalMinutes'; intervalMinutes: number };    // 1 ~ 10080 分钟
// cron 校验器存在（:169-205）但 validateWorkflowSchedule 显式拒绝下发（:301-312）
```

### 3.8 事件面与唤醒面的分工澄清（重要）

调查中确认一个容易混淆的架构分层，任务书拆解时必须遵守：

- **钩子事件（hooks.rs 14 事件）是插件观测面**：`HookRegistry::dispatch` 广播给注册 handler（hooks.rs:505-632），handler 是插件代码，**不直接唤醒 AI**；发射点在 `tool_exec.rs:746-757`（tool.pre）、:881/:941/:1000（tool.post）、:1012（tool.error）及 `loop/mod.rs`（session/turn/compact/error）。
- **控制总线（control.rs L0-L3）是 AI 唤醒面**：注入 `ControlBus::request_steer / request_follow_up` → 输入队列 steer/followUp 环（input.rs:36-45）→ awaiting-input 或安全点消费（awaiting_input.rs:14-32）。定时器 / Cron / 恢复通知等"唤醒 AI"的动作一律走此面。
- **域事件（events.rs 31 事件）是数据面**：`AgentEvent` 入 `EventQueue`（orchestrator/src/events.rs:106-200）落库并广播给前端（runId/sequence 信封，conex-types/src/events.rs:713-800）。事件可以**旁路触发**控制总线注入（如恢复阶梯 2 的 steering 条目 → 落库 + L1 注入），但事件本身不直接唤醒 AI。

---

## 四、模块 C：定时调度与反应式唤醒引擎

### 4.1 REQ-C01：单次定时器（One-shot Timer）

#### 4.1.1 现状证据

**没有独立的定时器工具**。现状中唯一带"timer"语义的是 `wait_subagents` 的 timer 等待模式：

- `WaitMode::Timer` 定义："等待固定时间窗（dispatch_wait_ms，默认 30s，可配）后唤醒主 agent 规划，未完成任务保持运行"（`crates/agent-tools/src/tools/wait_subagents.rs:47-51`）。
- timer 缺省等待窗 30s（`DEFAULT_TIMER_WAIT_MS`，:78；执行路径 :504-509）；超时硬上限 10 分钟（`MAX_WAIT_TIMEOUT_MS`，:75；超限参数报错 :497-502）。
- 到期语义由事件驱动等待原语承载：`tokio::time::timeout_at(deadline, rx.recv())` 到点返回 `timed_out=true`（:248-253、:268-271）。
- 工具级缺口事实：该 timer 只能挂在"已分发子代理清单"上（`subagentIds` 必填，:468-486），没有面向任意场景的 `DurationSeconds + Prompt` 倒计时参数。
- **未接线事实**：`WaitSubagentsTool` 依赖 `SubagentWaitChannel`，通道为 None 时返回 `common.unsupported`（:533-538）；生产装配用默认配置注册（`crates/agent-tools/src/tools/mod.rs:60-71`、:110-112；`apps/agent-workbench/src-tauri/src/engine.rs:617`）。
- 到期后的"Prompt 通知"通道存在：L1 followUp 环（仅 idle 消费，`crates/session-loop/src/control.rs:289-302`）与 PendingNudgeChannel（run 内不注入，排入下一条用户消息，`crates/session-loop/src/steering/nudge.rs:10-12`）。

#### 4.1.2 判定

**缺口**。判定依据：

- 验收 1"定时器到期后 AI 收到包含 Prompt 内容的唤醒通知"：无任何工具能注册一个独立倒计时并到期注入 Prompt——wait_subagents 的 timer 模式是工具调用内的阻塞等待（yield 语义），不是"后台静默运行不阻塞"的定时器。
- 验收 2"定时器运行期间不阻塞 AI 的其他操作"：wait_subagents 的 await-all / timer 是阻塞等待通道，与验收语义不符（parallel-work 虽不阻塞但不设定时）。
- 通道路径（control.rs 的 followUp 环、nudge.rs 的 PendingNudgeChannel）已存在，缺口集中在"定时器本体的注册/到期/持久化"。

##### REQ-C01 验收标准逐项对照

| 验收项（需求文档:296-297） | 现状 | 说明 |
| :--- | :---: | :--- |
| 定时器到期后 AI 收到包含 Prompt 内容的唤醒通知 | ❌ | 无独立定时器；wait timer 到期只返回未完成列表，无 Prompt 注入 |
| 定时器运行期间不阻塞 AI 的其他操作 | ❌ | wait timer 是工具调用内阻塞等待（yield 单次返回），非后台静默运行 |

#### 4.1.3 差距清单

1. 无 `set_timer` 类工具：缺 `DurationSeconds`（等待秒数）+ `Prompt`（到期提示内容）入参；REQ 参数即规格（REQ-agent-engine-capabilities.md:291）。
2. 无引擎侧定时器注册表：缺"注册 → 后台 tokio sleep → 到期取回 Prompt 并注入"的执行器；到期注入走哪一环（followUp / steer / 下一条用户消息）需定夺。
3. 无定时器持久化：重启后定时器是否存活、剩余时间如何计算无机制（wait_subagents 有 dispatch_* 持久化先例可对齐，:83-89、:150-168）。
4. 无显式取消接口（REQ-C02 依赖它）。

#### 4.1.4 建议（落地到现有架构）

1. **新增 `set_timer` 工具**（agent-tools），入参 `durationSeconds` + `prompt`（可选 `timerId` 便于取消），工具本体只做"入参校验 + 声明持久化 + 委托通道"，完全对齐 `WaitSubagentsTool` 的形态（`crates/agent-tools/src/tools/wait_subagents.rs:394-596`）。
2. **定义 `TimerChannel` trait 并在引擎侧实现**：`register(seconds, prompt) -> timer_id` / `cancel(timer_id)`；实现方持 tokio sleep 任务，到期后经 `ControlBus::request_follow_up` 注入（仅 idle 消费、天然不打断当前工作，`crates/session-loop/src/control.rs:289-302`）——与恢复阶梯 2 的 L1 注入路径同构（`crates/orchestrator/src/recovery.rs:15-20`）。
3. **持久化对齐 dispatch_* 模式**：session_meta `timer_*` 键（timer 声明 JSON：id / 到期时刻 / prompt），重启后 `remaining_wait` 计算复用 `DispatchDeclaration::remaining_wait_ms` 的写法（`crates/agent-tools/src/tools/wait_subagents.rs:138-147`）。
4. **接线点**：`BuiltinToolConfig` 增加 `timer_channel` 字段（对齐 `subagent_wait_channel`，`crates/agent-tools/src/tools/mod.rs:54-57`），`EngineHandle::new` 装配时注入（`apps/agent-workbench/src-tauri/src/engine.rs:616-624` 处）。
5. 到期事件如需前端可观测，登记新事件 `timer-fired`（走注册表流程，`crates/conex-types/src/events.rs:606-610` + `contracts/engine-events.json`）；若仅注入 Prompt 不落事件，可省去登记。

### 4.2 REQ-C02：智能早退条件（TimerCondition）

#### 4.2.1 现状证据

**没有 TimerCondition 概念**。最接近的语义内嵌在 wait 原语中：

- `wait_for_terminal_events` 的"提前返回"条件固定为：等待名单内的子代理全部到达终态（`crates/agent-tools/src/tools/wait_subagents.rs:244-247` 的 `ids.iter().all(...)` 检查），收到终态事件即记录（:261-266）——这等价于 TimerCondition 的"`<task-id>`"特例，且只针对子代理终态事件。
- **没有 `"any"` 语义**：收到"任何来源消息"即取消定时器（REQ-agent-engine-capabilities.md:311）无对应实现——wait 原语会显式忽略非等待名单子代理的终态事件（:261-266 的 `if ids.contains(...)` 过滤）。
- **没有冲突约束**：REQ 要求"不允许同时存在多个会被同一个 sender 触发早退的定时器（防止语义冲突）"（:313）。现状的 dispatch_* 声明是单键覆盖（`to_meta_pairs` :150-168），"重复设置"是静默覆盖而不是"拒绝并返回错误提示"。
- 无显式取消定时器接口。

#### 4.2.2 判定

**缺口**。判定依据：

- 验收 1"TimerCondition=any 时收到任意消息后定时器被取消"：无实现。
- 验收 2"TimerCondition=<task-id> 时仅指定任务的消息能触发早退"：wait 原语有类似语义（指定子代理终态事件），但限定于子代理域，无法指定任意 task-id（如后台命令、任意 run）。
- 验收 3"重复设置冲突条件时系统拒绝并返回错误"：无实现（现有声明是覆盖语义）。

##### REQ-C02 验收标准逐项对照

| 验收项（需求文档:315-317） | 现状 | 说明 |
| :--- | :---: | :--- |
| TimerCondition="any" 时收到任意消息后定时器被取消 | ❌ | wait 原语显式忽略非等待名单事件（wait_subagents.rs:261-266） |
| TimerCondition="<task-id>" 时仅指定任务的消息能触发早退 | ⚠️ | 有近似语义（指定子代理终态即返回），但限定子代理域、无通用 task-id |
| 重复设置冲突条件时系统拒绝并返回错误提示 | ❌ | dispatch_* 单键覆盖是静默覆盖（:150-168），非拒绝报错 |

#### 4.2.3 差距清单

1. `timerCondition` 参数枚举缺失：`"never"` / `"any"` / `"<task-id>"` / `"<agent-id>"`（REQ-agent-engine-capabilities.md:309-312）。
2. 早退触发源映射表缺失：引擎侧需要"sender → timer_id"注册表，事件到达时查表取消。
3. 冲突检测缺失：同 sender 已有一个活跃定时器时，新注册必须拒绝（对齐验收 3）。
4. 事件 → sender 的归一化规则缺失：什么事件算"来自 task-id 的消息"（subagent-ended？run-terminal？）需要定义。

#### 4.2.4 建议（落地到现有架构）

1. **在 `set_timer` 工具上直接加 `timerCondition` 参数**（never/any/`<sender-id>`），不单独造工具——`TimerCondition` 是定时器的一个属性而非独立能力。
2. **引擎侧 `TimerRegistry` 维护两张表**：`timers: HashMap<timer_id, (expiry, prompt, condition)>` 与 `early_exit: HashMap<sender, timer_id>`；注册时查 `early_exit` 命中即返回结构化冲突错误（复用 `SubagentWaitError` 风格，`crates/agent-tools/src/tools/wait_subagents.rs:318-350`）。
3. **早退判定挂到事件消费点**：引擎侧的事件流（subagent-ended / run-terminal，`crates/conex-types/src/events.rs:487-496`、:592-603）在入 `EventQueue` 的同时旁路检查 `early_exit` 表；命中 → 取消对应 timer，并跳过到期注入（避免重复唤醒）。
4. sender 归一化规则：task-id 事件取事件体 `subagent_id` / `run_id` 字段；`any` 则所有非本定时器产出的注入类消息都触发——实现上可在注入消息的 metadata 打上 `timer-<id>` 标记用于排除自身（对齐 `subagent_inject_message` 的 id 语义，`crates/session-loop/src/control.rs:95-108`）。

### 4.3 REQ-C03：周期性 Cron 调度（Recurring Cron）

#### 4.3.1 现状证据

**前端层面（存在但连不上引擎）**：

- 定时任务面板完整存在：`ScheduledTasksPanel`（`apps/crish-desktop/src/components/settings/ScheduledTasksPanel.tsx:31-206`），含预设行（:132-146）、表单（:164-179）、列表（:181-197）、运行历史（:199-203）。
- 调度类型定义齐全：manual / daily / intervalMinutes（`apps/crish-desktop/src/api/workflow-api/workflowScheduler.ts:6-9`），时区校验（:58-69）、间隔分钟校验（:75-97）。
- **cron 校验器完整存在但被拒绝下发**：`validateCronExpression` 支持 5 字段全语法（:99-205），但 `validateWorkflowSchedule` 对 cron 显式返回 `"引擎暂不支持 cron 调度，请改用「每天」或「间隔分钟」"`（:301-312）；模块注释明示"引擎当前不下发 cron"（:166-167）。
- **幽灵命令事实**：`workflowRunner.ts` 声明 Tauri 下 list/create/update/delete/trigger-workflow、list-workflow-runs 全部不可用（`apps/crish-desktop/src/api/workflow-api/workflowRunner.ts:4-7`），`listWorkflows` 恒返回空表（:27-29）、`createWorkflow` 恒 `ok:false`（:31-39）、`triggerWorkflow` 恒 `ok:false`（:60-69）、`listWorkflowRuns` 恒空（:83-87）。

**引擎层面（零实现）**：

- 对 `crates/` 全部 Rust 源码检索 `workflow|Workflow`：无任何匹配；检索 `cron|Cron|timer|Timer`：全部命中集中在 wait_subagents.rs 的等待模式（见附录 A 证据）。
- `apps/agent-workbench/src-tauri/src/` 检索 `scheduled|cron`：零命中；命令清单为 78 条（74 注册 + 4 登记先行），无 workflow 命令（`command_manifest.rs:62`，模块文档 :12-14 有幽灵命令拦截测试）。
- 引擎无任何"到点触发一个 run"的执行器；run 只能由用户消息驱动（`drive_run_loop` 经 `RunProducer::produce` 启动，`apps/agent-workbench/src-tauri/src/core_run_commands.rs:110-120`、:1133）。

#### 4.3.2 判定

**缺口**。判定依据：

- 验收 1"Cron 表达式正确解析并按时触发"：解析器只有前端 TS 版且只用于校验展示；Rust 侧无解析器、无触发执行器。
- 验收 2"MaxIterations 到达后 Cron 自动停止"：无。
- 验收 3"IsDaemon=true 的 Cron 在 AI 当前任务结束后仍继续运行"：无；且整个 workflow 命令面是幽灵命令，前端面板是"死 UI"。

##### REQ-C03 验收标准逐项对照

| 验收项（需求文档:335-337） | 现状 | 说明 |
| :--- | :---: | :--- |
| Cron 表达式正确解析并按时触发 | ❌ | 解析器仅前端 TS 版且拒绝下发（workflowScheduler.ts:301-312）；Rust 侧零实现 |
| MaxIterations 到达后 Cron 自动停止 | ❌ | 无迭代计数机制 |
| IsDaemon=true 的 Cron 在 AI 当前任务结束后仍继续运行 | ❌ | 无跨 run 常驻任务；workflow 命令面为幽灵命令（workflowRunner.ts:4-7） |

#### 4.3.3 差距清单

1. Rust 侧无 cron 表达式解析器（5 段式：分 时 日 月 周）。
2. 无调度注册表与触发执行器（下次触发时间计算、到时发射）。
3. 无 `MaxIterations` / `IsDaemon` 语义（IsDaemon=true 需要"跨 run 常驻 + 到时拉起独立 run"）。
4. 前端 workflow API 与 Rust 命令面无桥（幽灵命令悬空）。
5. 前端面板的 daily / intervalMinutes 同样连不上引擎（不只是 cron）。

#### 4.3.4 建议（落地到现有架构）

1. **Rust 侧实现 cron 解析纯函数**：`cron` 表达式解析 + 下次触发时刻计算，落 `conex-types`（无依赖纯逻辑，便于测试锁定；前端校验器可作为测试对照——两个实现共享同一语义）。解析器只做"解析 + 计算"，不做调度。
2. **引擎侧新增 `SchedulerRegistry`**：持有 `Vec<CronTask>`（表达式 + prompt + max_iterations + is_daemon + 已触发次数），为每个任务维护一个 tokio sleep 任务；到期后：
   - `IsDaemon=false`：经 `ControlBus::request_follow_up` 在当前会话注入（对齐 C01 通道）；
   - `IsDaemon=true`：调用现成的 run 启动通道（`SessionLoopProducer` + `drive_run_loop`，`apps/agent-workbench/src-tauri/src/core_run_commands.rs:110-120`、:1133-1226）拉起独立 run。
3. **持久化对齐 `flow_*` / `recover_*` 先例**：session_meta `sched_*` 键命名空间（任务声明 + 下次触发时刻 + 已触发计数），重启后按下次触发时刻重建 sleep 任务。
4. **命令面补齐**：在 Tauri 侧实装 workflow 命令（create-workflow / list-workflows / update-workflow / delete-workflow / trigger-workflow / list-workflow-runs）并在 `command_manifest.rs` 登记（消除幽灵命令，:12-14 的拦截测试会强制登记）；前端 `workflowRunner.ts` 从"恒不可用"改为真实 IPC（可保留现有 TS 类型面，只换实现）。
5. **IsDaemon 边界**：IsDaemon=true 的 Cron 属于"独立常驻任务"，其会话生命周期管理（新会话 or 复用会话）需与 REQ-B/D 模块的生命周期语义对齐，建议在任务书中与模块 B 的守护进程语义一并裁决。

### 4.4 REQ-C04：反应式唤醒机制（Reactive Wakeup）

#### 4.4.1 现状证据（6 类唤醒事件逐项对照）

**① 后台命令完成**：

- run 级终态事件 `run-terminal` 存在（`crates/conex-types/src/events.rs:487-496`），Critical 级必达落库；run 收口在 `drive_run_loop`（`apps/agent-workbench/src-tauri/src/core_run_commands.rs:1226` 附近，收口入队 + 信封注入）。
- 命令级（模块 A 的"后台命令"）完成通知：现状命令执行是同步 shell（`workbench_run_shell`，`apps/agent-workbench/src-tauri/src/process.rs:57`），命令完成 → 工具返回，无独立事件；模块 A/B 的"后台任务 + 日志持久化"本身未实装（属另一条需求线）。

**② 子 Agent 发送消息**：

- 三事件契约齐备：`subagent-started` / `subagent-event` / `subagent-ended`（`crates/conex-types/src/events.rs:560-603`），唯一发射方 `SubagentEventEmitter`（`crates/orchestrator/src/subagent_events.rs:1-30`），FlowScheduler 已挂载发射（`crates/orchestrator/src/flow_graph.rs:805-810`、:1010-1037、:1134-1171）。
- 主 agent 侧消费：`wait_for_terminal_events` 事件驱动等待（`crates/agent-tools/src/tools/wait_subagents.rs:233-305`），DAG 调度器经 `on_subagent_terminal` 推进（`crates/orchestrator/src/flow_graph.rs:1096-1210`）。
- **批量推送基础存在**：`ControlDrainAction::SoftInject` 聚合全部 L1 消息一次性注入（`crates/session-loop/src/control.rs:389-417`）；跨 run 批量经 `PendingMessageQueue`（replaceOrEnqueue，`crates/orchestrator/src/steering_queue.rs:6`、:145）。

**③ 定时器到期**：无（REQ-C01 缺口，见 4.1）。

**④ Cron 调度触发**：无（REQ-C03 缺口，见 4.3）。

**⑤ 用户发送新消息**：

- 天然支持：awaiting-input 状态安全点检查 → input_queue dequeue（`crates/session-loop/src/loop/handlers/awaiting_input.rs:14-32`）；三环入队（force/steer/followUp，`crates/session-loop/src/input.rs:36-45`）。
- 注意：run 无输入即 NoInput → stop 收场（awaiting_input.rs:27-31），"等待用户消息"的休眠发生在 run 结束后（壳层），引擎内无会话级 idle 态。

**⑥ 进程异常检测**：

- 资源监控（REQ-A04）未实装，无"疑似卡死/异常退出"通知。
- 邻近能力：恢复阶梯 2 对网络类错误做"停摆通知 + L1 注入"（`crates/orchestrator/src/recovery.rs:359-368` 的 steering 文案、:15-20 模块文档）——是"异常检测 → 唤醒"的现成范式。

**"AI 在无事可做时不消耗计算资源"现状**：

- run 内：状态机事件驱动（`loop/mod.rs` 的 `dispatch_once`，:501-526 各 handler 分派），无轮询；无输入即结束 run（awaiting_input.rs:27-31）。
- run 外：壳层 `drive_run_loop` 收口后无"待命"（`core_run_commands.rs:1133-1226`）；子代理等待只能靠 wait_subagents（未接线）或结束 run 等用户。

**唤醒时上下文注入摘要现状**：

- 注入通道齐备（L1 steer / followUp 环，`crates/session-loop/src/control.rs:253-302`；steering 消息构造 `build_steering_message`，`crates/session-loop/src/steering/nudge.rs:86-90` 附近）。
- 摘要文本有零散实现：恢复阶梯 2 的 `steering_text`（`crates/orchestrator/src/recovery.rs:359-368"子代理 xx（run xx）停摆：…"`）——但没有"事件类型 → 摘要模板"的统一映射。

**严禁轮询的现状**：

- DAG 合成唤醒明确"不轮询：每次终态事件内部触发 advance"（`crates/orchestrator/src/flow_graph.rs:21-24`、:911-913）；wait 原语优先事件而非轮询（`crates/agent-tools/src/tools/wait_subagents.rs:12-13` 模块文档）。符合 REQ 的严禁项。

#### 4.4.2 判定

**部分覆盖**。判定依据：

- 验收 1"AI 在无事可做时不消耗计算资源"：run 级成立（事件驱动状态机 + 无输入即停），但"AI 会话处于待命、等待子代理/后台任务"的场景没有独立的会话级 idle 态——run 结束后 AI 并不"休眠待唤醒"，而是彻底结束，后续唤醒只能靠用户开新 run 或（未接线的）wait 通道。
- 验收 2"6 种事件均能正确唤醒 AI"：现状覆盖 ①（run-terminal，run 级）、②（subagent 事件，等待期间）、⑤（用户消息）；③④ 缺失（C01/C03 缺口）；⑥ 缺资源监控（模块 A 范围），邻近的恢复通知已有。
- 验收 3"唤醒时上下文中包含事件摘要信息"：通道与零散文案存在，无标准化映射，且子代理等待期间的事件"只记录不打断"（`crates/agent-tools/src/tools/wait_subagents.rs:229-231`）——主 agent 需要主动 wait 才能拿到摘要。

##### REQ-C04 验收标准逐项对照

| 验收项（需求文档:361-363） | 现状 | 说明 |
| :--- | :---: | :--- |
| AI 在无事可做时不消耗计算资源 | ⚠️ | run 级成立（事件驱动状态机，loop/mod.rs:501-526）；会话级待命态缺失 |
| 6 种事件均能正确唤醒 AI | ⚠️ | 覆盖 ①run-terminal、②subagent 事件、⑤用户消息；③④ 缺失（C01/C03）；⑥ 归模块 A |
| 唤醒时上下文中包含事件摘要信息 | ⚠️ | 注入通道齐（control.rs:253-302）；摘要映射未标准化（零散 steering_text） |

#### 4.4.3 差距清单

1. 唤醒源缺口：定时器（C01）、Cron（C03）两类时间事件缺失——补齐后 6 类中 5 类有引擎支持（⑥归模块 A）。
2. 会话级 idle 待命缺失：主 agent "没有立即需要处理的工作时"不能停在"可被事件唤醒"的状态，run 直接收场。
3. 唤醒摘要注入无标准化：缺"事件 → Prompt 摘要模板"映射与批量推送的收口（REQ 验收 3、REQ-D07 批量推送：REQ-agent-engine-capabilities.md:357-358、:598）。
4. 子代理完成唤醒依赖主 agent 主动 wait：wait 通道未接线，主 agent 无法在等待期间被 subagent-ended 自动唤醒（D07 验收 1 依赖此）。

#### 4.4.4 建议（落地到现有架构）

1. **唤醒源补齐**：落地 C01（定时器）+ C03（Cron）即为 ③④ 补位；⑥ 与模块 A 的 `resource-monitor` 联动（任务书中与 A04 一并排期）。
2. **会话级 idle 待命（最小实现）**：在壳层 `drive_run_loop` 收口处增加"待命检查"——若 `PendingMessageQueue` 非空（子代理完成、恢复通知、定时器到期均有队列条目）或存在活跃定时器/Cron 任务，则自动续开一轮 run（复用 `RunProducer` 现成通道，`apps/agent-workbench/src-tauri/src/core_run_commands.rs:110-120`），把队列条目经 L1 环注入。这是"run 结束 → 被事件拉回"的最小闭环，不引入独立守护线程。
3. **唤醒摘要标准化**：定义 `WakeupSummary` 映射（事件类型 → 中文摘要模板），落 `crates/conex-types` 或引擎侧小模块；文案风格对齐 `steering_text`（`crates/orchestrator/src/recovery.rs:359-368"任务 <ID> 已运行 <耗时>…"` 类模板）。摘要经 `RuntimeSteering` 事件（`crates/conex-types/src/events.rs:439-445`）或 steering 消息注入，AI 无需手动查询。
4. **批量推送收口**：跨 run 待处理消息统一经 `PendingMessageQueue`（replaceOrEnqueue + drain，`crates/orchestrator/src/steering_queue.rs:145`、:219）批量排入，run 内 L1 消息经 `ControlDrainAction::SoftInject` 聚合（`crates/session-loop/src/control.rs:389-417`）——两者均已存在，只需在 idle 续 run 路径上串联。
5. **接线 wait 通道**：实现 `SubagentWaitChannel`（见 4.5 建议），使子代理完成事件能直接唤醒等待中的主 agent，与 idle 续 run 互为补充。

### 4.5 REQ-C05：AI 等待策略自动选择

#### 4.5.1 现状证据

**三模式等待工具（规格层）**：

- `wait_subagents` 三模式即"等待策略"的显式形态：await-all（等全部终态再规划）/ timer（到点返回未完成列表，未完成任务保持运行）/ parallel-work（立即返回快照，主 agent 转并行工作）（`crates/agent-tools/src/tools/wait_subagents.rs:40-51`，工具描述 :412-417）。
- 模式执行分支（:563-580）：parallel-work / timeoutMs=0 → 非阻塞快照（`snapshot`）；await-all / timer → 事件驱动阻塞等待（`wait_for_terminal`）。
- 兜底防护参数：`MAX_WAIT_TIMEOUT_MS` 10 分钟硬上限（:75），timer 缺省 30s（:78）——这是"超时兜底检查"的等待窗，但只存在于工具调用内。
- 声明持久化与重启恢复：`dispatch_*` 键（:83-89）+ `DispatchDeclaration`（:124-199），`dispatched_at_ms` 落库后 `remaining_wait_ms` 可算剩余（:138-147）——为"重启后继续等待"提供了数据基础。
- 运行中注入：`inject`（:388、:554-559），经 L1 steer 环送达目标子代理（`crates/session-loop/src/control.rs:275-286`）——"等待期间不打断地调整"已有通道。

**策略自动选择（规格要求但现状无）**：

- REQ 要求系统"辅助 AI 选择最优等待策略"（REQ-agent-engine-capabilities.md:374-376）：有并行工作 → 继续处理 + 反应式唤醒；无事可做必须等待 → 定时器 + TimerCondition 指向任务 ID 的双保险。现状的 mode 完全由 AI 显式传参（`:487-491` 解析 mode，无任何系统建议/注入），也无"任务完成即唤醒"的定时器（C02 缺口）。
- 兜底防护（REQ 验收 2：系统级"N 分钟未被事件唤醒 → 自动兜底唤醒"，REQ-agent-engine-capabilities.md:377）：**无任何实现**。dispatch_* 声明虽然记录了"在等待什么、从何时起"，但没有 watchdog 任务消费它。

**未接线事实**（复用 4.1 的结论）：`SubagentWaitChannel` 无引擎侧实现（`crates/agent-tools/src/tools/mod.rs:60-71`、:110-112；`apps/agent-workbench/src-tauri/src/engine.rs:617`）——三模式等待在 Tauri 生产中整体返回 `common.unsupported`（wait_subagents.rs:533-538）。

#### 4.5.2 判定

**部分覆盖**。判定依据：

- 验收 1"AI 在无事可做 + 等待命令场景下正确设置定时器"：规格面有 timer 模式 + inject 通道，但：a) 通道未接线不可用；b) 无 TimerCondition（C02）无法实现"任务完成即唤醒"；c) 无策略建议辅助。
- 验收 2"系统兜底防护在超时后正确触发唤醒通知"：无实现。

##### REQ-C05 验收标准逐项对照

| 验收项（需求文档:380-381） | 现状 | 说明 |
| :--- | :---: | :--- |
| AI 在"无事可做 + 等待命令"场景下正确设置定时器 | ⚠️ | timer 模式规格存在但通道未接线（wait_subagents.rs:533-538）；无 TimerCondition 组合（C02） |
| 系统兜底防护在超时后正确触发唤醒通知 | ❌ | 无 watchdog 消费 dispatch_* 声明（:138-147 的剩余等待计算无人调用） |

#### 4.5.3 差距清单

1. `SubagentWaitChannel` 引擎侧实现缺失（wait_for_terminal 的 mpsc 接线 + snapshot 读 session_agents 行 + persist_declaration 落库 + inject 走 ControlBus）——C01/C05 公共底座。
2. 兜底 watchdog 缺失：无"活跃后台任务 + N 分钟无事件 → 自动唤醒"的机制。
3. 策略自动选择缺失：无"检测到等待场景 → 建议/默认注入策略"的辅助（P2 级，可后置）。
4. 双保险组合（timer + TimerCondition=task-id）依赖 C02 落地。

#### 4.5.4 建议（落地到现有架构）

1. **实现 `SubagentWaitChannel`（引擎侧）**：实现点建议放 `apps/agent-workbench/src-tauri`（或 orchestrator 扩展），方法逐一对齐契约：
   - `wait_for_terminal`：订阅 `subagent-ended` 事件流映射为 `SubagentTerminalEvent` 灌入 mpsc，直接复用测试替身同构的消费逻辑（`crates/agent-tools/src/tools/wait_subagents.rs:686-739` 的 EventStreamChannel 即实现模板）；
   - `snapshot`：读 session_agents 行（复用 orchestrator 的 SessionTree / persist 层，`crates/orchestrator/src/session.rs`）；
   - `persist_declaration`：写 session_meta `dispatch_*` 键（conex-db 既有接口）；
   - `inject`：经目标 run 的 `ControlBus::request_subagent_inject`（`crates/session-loop/src/control.rs:275-286`）。
2. **兜底 watchdog（最小实现）**：引擎侧每会话一个 tokio 任务，周期检查 `dispatch_*` 声明（`dispatched_at_ms` + `wait_ms`，wait_subagents.rs:138-147）：存在未终态声明且超过 N 分钟（可配，默认 10 分钟对齐硬上限，:75）无任何事件唤醒 → 经 `PendingMessageQueue` 写入 steering 条目（对齐 recovery 阶梯 2 的 `build_steering_entry` 模式，`crates/orchestrator/src/recovery.rs:371-380`）并随 idle 续 run 注入（见 4.4.4 建议 2）。文案模板："您有一个运行中的后台任务 <ID>，已运行 <时长>，请检查状态。"（对齐 REQ-agent-engine-capabilities.md:377）。
3. **策略辅助（P2）**：在 `run_subagent` / `wait_subagents` 工具描述中固化"推荐模式选择"提示（await-all vs timer vs parallel-work 的适用场景），由 AI 自行选择，系统不做强制——符合"反过度设计"。
4. 双保险组合 = C01 set_timer（timerCondition 指向任务 id）+ C02 早退，任务书可将 C01/C02/C05 串成一个实现单元。

---

## 五、模块 F：搜索、读取与防截断工具体系

### 5.1 REQ-F01：全局符号与引用检索（Grep Search）

#### 5.1.1 现状证据

**grep_search 已具备的能力**：

- 精确文本 / 正则双模式：`regex` 布尔参数（默认 false 子串匹配，`crates/agent-tools/src/tools/search.rs:97`、:105-112 正则编译，:139-147 命中判定）。
- 大小写不敏感：`caseSensitive` 参数默认 true（:64、:99），置 false 走小写化比较（:143-147）。
- glob 过滤：`glob` 参数（:63、:98），`walk_files` 内正例过滤（:220-234）；自研 `glob_match` 支持 `*` / `**` / `?`（:241-268）。
- 结果上限：`maxMatches` 默认 200（:18、:65、:100），超出置 `truncated=true` 并在返回头标注（:155-163、:166-170）。
- 防护参数：`maxFiles` 默认 2000（:19、:101、:204-206）、`maxFileBytes` 默认 512,000（:20、:102、:125-127）、递归深度上限 16（:22、:201）。
- 默认排除：`SKIP_DIRS`（.git / node_modules / dist / build / .next / .turbo / .cache / target，:25-34）在 walk 时按路径组件过滤（:211-219）；WalkBuilder 开启 gitignore 感知（:196-201）。
- 输出结构：path / line / column / text（`GrepMatch`，:39-44），文本视图对齐 grep -nI 风格（:166-179）。

**与 REQ-F01 规格的逐项对照**（REQ-agent-engine-capabilities.md:719-724）：

- "文件级匹配（MatchPerLine=false）仅返回文件名列表（类似 grep -l）"：**无此模式**——每次调用都返回行级 matches，无 files-only 形态。
- "行级匹配（MatchPerLine=true）返回文件名+行号+行内容"：✓ 有。
- "大小写不敏感搜索（CaseInsensitive）"：✓ 有（caseSensitive=false 语义等价）。
- "Glob 过滤（Includes）如 *.rs、!**/node_modules/* 排除依赖目录"：**部分**——正例 glob 有；`!` 前缀排除式 glob 语法**无**（SKIP_DIRS 是固定内置排除，不可由调用方扩展）。
- "结果上限（如 50 条），超出时提示 AI 缩小搜索范围"：上限有（默认 200 可调），`truncated: true` 标注有；但返回文案只有数据（"matches: N / truncated: true"），**无"请缩小搜索范围"的引导提示**——AI 能否理解取决于模型，规格要求的提示未显式给出。

**fuzzy_find（超规格能力）**：文件名模糊查找（子序列打分 + 目录索引，`crates/agent-tools/src/tools/search.rs:271-356`），与 REQ-F01 不冲突，是额外补充。

#### 5.1.2 判定

**部分覆盖**。判定依据：

- 验收 1"精确文本和正则两种模式均正常工作"：✓ 已满足（测试覆盖：search.rs:423-445）。
- 验收 2"Glob 过滤正确生效"：✓ 正例过滤已满足（测试 :448-472）；规格中的排除式 `!**/node_modules/*` 语法未实现——但 SKIP_DIRS 已内建排除 node_modules，实际场景多数可覆盖。
- 验收 3"结果上限后的提示清晰"：部分——truncated 标记有、引导文案无。

##### REQ-F01 验收标准逐项对照

| 验收项（需求文档:727-729） | 现状 | 说明 |
| :--- | :---: | :--- |
| 精确文本和正则两种模式均正常工作 | ✅ | regex 参数 + 子串模式（search.rs:97、:105-112、:139-147），测试覆盖 :423-445 |
| Glob 过滤正确生效 | ⚠️ | 正例 glob 满足（:220-234，测试 :448-472）；`!` 排除语法无（SKIP_DIRS 内建兜底） |
| 结果上限后的提示清晰 | ⚠️ | truncated 标记有（:155-163）；缺"请缩小搜索范围"引导文案 |

#### 5.1.3 差距清单

1. 无 `matchPerLine`（或等价）文件级模式：缺 grep -l 形态。
2. 无排除式 glob：`!` 前缀语法不支持（内建 SKIP_DIRS 可兜底常见场景）。
3. truncated 提示可增强："超出结果上限，请缩小搜索范围"引导文案。

#### 5.1.4 建议（落地到现有架构）

1. **`grep_search` 增加 `matchPerLine` 布尔参数**（默认 true 保持现状）：false 时只收集命中的文件路径（去重）+ 每文件命中行数，输出 `files` 数组替代行级 `matches`；实现改动集中在 execute 的结果收拢处（`crates/agent-tools/src/tools/search.rs:149-164`），遍历与匹配逻辑复用。
2. **glob 支持 `!` 前缀排除**：`walk_files` 在正例判定（:220-234）之前先解析排除 glob——参数可扩展为 `includeGlobs` / `excludeGlobs` 数组，或单个 glob 字符串支持 `!` 前缀（需与前端 TS 版语义对齐；建议数组形态，避免自造语法）。排除判定优先于 SKIP_DIRS 与正例过滤，命中排除即 `continue`。
3. **truncated 提示文案**：`header` 在 `truncated: true` 行后追加"结果已达上限，请缩小搜索范围或增加 maxMatches"（:166-170），一行改动。
4. 默认值说明：REQ 示例 50 条与现状默认 200 条不冲突（参数可配，规格用"如"字示例），保持 200 不动，文档标注即可。

### 5.2 REQ-F02：完整文件读取与防截断机制（重点需求）

#### 5.2.1 现状证据

**read_file 现状**（`crates/agent-tools/src/tools/fs.rs:21-129`）：

- 入参仅 `path` + `maxBytes`（schema :32-40；`DEFAULT_READ_MAX_BYTES = 256_000`，:18）——**无 StartLine / EndLine 行号参数，无 ContentOffset 续读参数**。
- 截断：`clamp_text` 按**字符数**截断到 maxBytes（:94；`crates/agent-tools/src/tools/mod.rs:384-390`），返回 `truncated: true` 布尔 + 文本头部说明（fs.rs:98-106、:125）。
- **截断点无行边界保证**：`text.chars().take(limit)` 在任意字符处切断（tools/mod.rs:388），文件中间某行的后半截可能丢失——直接违反 REQ 的"关键要求：截断点应在最近的完整行边界处"（REQ-agent-engine-capabilities.md:756）。
- 二进制处理：含 NUL 判定为二进制并**报错拒绝**（fs.rs:86-91；`decode_text` :295-334 的 NUL 检查 :320-327），不返回任何内容——REQ 要求"返回完整文件内容（base64 编码或文件引用）"（:760）未满足。
- 编码处理完整（BOM 探测 utf-8 / utf-16le / utf-16be，fs.rs 依赖 tools/mod.rs:295-334），UTF-16 文件可正常读——这是行号续读实现时要注意的点（须按解码后文本切行，而非原始字节）。

**与 REQ-F02 规格的逐项对照**（REQ-agent-engine-capabilities.md:743-760）：

- "2.1 行号范围读取：StartLine / EndLine 闭区间"：**无**。
- "单次最大读取行数设上限（如 800 行）"：**无**（只有字符预算）。
- "省略 StartLine/EndLine 默认读开头 800 行或全部"：**无**（现状默认全文件 + 字符截断）。
- "2.2 字节级防截断续读：单次返回字节上限（如 46080）"：有等价物（maxBytes 字符上限，256,000）——**注意**：现状默认 256,000 字符远大于 REQ 示例 46080 bytes，说明本项目上下文窗口预算比示例宽松，实现时应保持项目默认、规格上限可配。
- "content_truncated: true 标注 + ContentOffset 续读"：`truncated` 字段存在（语义接近）但**无 ContentOffset，无续读能力**。
- "截断点不切行中间"：**违反**（见上）。
- "2.3 二进制支持：base64 或文件引用"：**无**（报错拒绝）。

#### 5.2.2 判定

**缺口**。判定依据：

- 验收 1"行号范围读取正确返回指定行"：无实现。
- 验收 2"字节截断时标注 content_truncated 并提供续读偏移量"：截断标注有（truncated），续读偏移量无。
- 验收 3"截断点在完整行边界"：违反（clamp_text 字符边界）。
- 验收 4"AI 通过 ContentOffset 续读后能获取完整剩余内容"：无实现。
- 二进制：报错拒绝，不满足"返回内容"要求。

这是需求文档中 P1 级**重点需求**（🔑，REQ-agent-engine-capabilities.md:735-736），核心痛点正是"AI 读到一半被截断导致误判"——现状截断甚至可能在行中间切断，误判风险更高。

##### REQ-F02 验收标准逐项对照

| 验收项（需求文档:763-766） | 现状 | 说明 |
| :--- | :---: | :--- |
| 行号范围读取正确返回指定行 | ❌ | 无 startLine/endLine 参数（fs.rs:32-40） |
| 字节截断时标注 content_truncated 并提供续读偏移量 | ❌ | truncated 字段存在；contentOffset 无 |
| 截断点在完整行边界，不切断行中间 | ❌ | clamp_text 字符边界截断（tools/mod.rs:388）——重点需求核心验收项违反 |
| AI 通过 ContentOffset 续读后能获取完整剩余内容 | ❌ | 无续读机制 |
| （规格 2.3）二进制文件返回内容 | ❌ | 报错拒绝（fs.rs:86-91），未提供 base64 / 文件引用 |

#### 5.2.3 差距清单

1. 行号范围参数（startLine / endLine，1-indexed 闭区间）缺失。
2. 最大行数上限（800 行）缺失。
3. ContentOffset 续读机制缺失（含字段契约：`content_truncated` / `contentOffset`）。
4. 完整行边界截断缺失（当前字符边界）。
5. 二进制文件读取支持缺失（base64 或文件引用，二选一）。
6. 行号语义与编码交互未定义（UTF-16 文件按解码后行切分）。

#### 5.2.4 建议（落地到现有架构）

**改造集中在 `ReadFileTool::execute`（`crates/agent-tools/src/tools/fs.rs:59-128`），不改外部接线**：

1. **入参扩展**：`startLine` / `endLine`（可选，1-indexed 闭区间）、`contentOffset`（可选，续读偏移——建议语义为"已返回的字符数"或"已返回行数"，二选一并写死在 schema 描述；REQ 以字节为粒度但项目现以字符预算，**建议以行数为粒度**：`contentOffset` = 已返回的完整行数，语义最稳，天然满足"不切行中间"）、`maxLines`（可选，默认 800 对齐 REQ）。
2. **读取逻辑重写为"行优先"**：
   - 解码（复用 `decode_text`，tools/mod.rs:295-334）→ 按 `\n` 切行（保留行尾判定，UTF-16 解码后同为 Rust 字符串，切行无编码障碍）；
   - 应用 startLine/endLine 行号窗口 → 应用 contentOffset 行偏移 → 在窗口内按行数上限（maxLines）与字符预算（maxBytes）双重钳制；
   - **字符预算截断时回退到最近完整行边界**（从预算位置向前找到行首），保证每行完整；
   - 还有剩余 → `content_truncated: true` + 返回 `nextContentOffset`（= 本批已覆盖的行数），AI 传回即可续读。
3. **输出契约**：保留现有 `text` / `truncated` / `lineCount` 等字段（前端/测试兼容），新增 `content_truncated`、`contentOffset`、`nextContentOffset`、`startLine`/`endLine`（回显）。
4. **二进制支持（最小实现）**：建议采用"文件引用"形态——返回 `binary: true` + path + size + encoding，附"请使用 file_stat / 查看器打开"提示；若需求坚持 base64，再按 maxBytes 钳制返回小文件 base64（大文件仍走引用）。**裁决建议**：REQ 允许二选一（REQ-agent-engine-capabilities.md:760），"文件引用"成本最低且不冲击上下文窗口。
5. **测试补位**：行号窗口边界、行边界截断（构造超长单行验证不切断）、contentOffset 续读闭环（读两次拼成全文）、UTF-16 文件行号读取——对齐现有测试风格（fs.rs:495-558）。

### 5.3 REQ-F03：目录结构列举

#### 5.3.1 现状证据

**list_dir 现状**（`crates/agent-tools/src/tools/fs.rs:299-402`）：

- 深度 1：`std::fs::read_dir` 只列直接子项（:352-375），无递归——✓ 满足"不递归"。
- 条目字段：name / type（directory|file|other）/ isFile / isDirectory / size / mtime（`DirEntry`，:288-296）——✓ 满足"类型、文件大小"。
- 排序：按 kind + 名称（目录排前，:377），text 视图带 `/` 前缀标记目录（:379-394）。
- 非目录路径报错（:344-349）。

**与 REQ-F03 规格的逐项对照**（REQ-agent-engine-capabilities.md:777-780）：

- "输出：每个子项的相对路径"：`name` 只有条目名，**无相对路径字段**（text 视图是纯文件名列表）——规格要求相对路径，现状以 name 呈现，语义差距小但字段缺失。
- "类型（文件/目录）"：✓ 有。
- "文件大小（若为文件）"：✓ 有（size 字段，目录时为 0）。
- "子项数量（若为目录）"：**无**——不计算每个子目录的直接子项数。
- "仅列出直接子项（深度 1）"：✓ 有。

#### 5.3.2 判定

**基本满足**。判定依据：

- 验收 1"正确列出文件与目录并区分类型"：✓ 已满足（测试 fs.rs:617-638）。
- 验收 2"不递归展开子目录"：✓ 已满足。

##### REQ-F03 验收标准逐项对照

| 验收项（需求文档:783-784） | 现状 | 说明 |
| :--- | :---: | :--- |
| 正确列出文件与目录并区分类型 | ✅ | kind/isFile/isDirectory 字段（fs.rs:288-296），测试 :617-638 |
| 不递归展开子目录 | ✅ | read_dir 深度 1（:352-375） |

#### 5.3.3 差距清单

1. 无"相对路径"字段（只有 name）。
2. 无"目录子项数量"字段（规格要求目录条目附带子项数）。

#### 5.3.4 建议（落地到现有架构）

1. **DirEntry 增加 `path` 字段**：相对目录根的相对路径（复用 `display_path` 的显示逻辑，`crates/agent-tools/src/tools/mod.rs` 导出；实现即在 read_dir 循环内构造 `dir.join(name)` 的 rel 形态，fs.rs:355-375）。
2. **目录条目增加 `count` 字段**：对目录条目调用一次 `read_dir` 计数直接子项数（成本可控，深度 1 场景下子目录通常不多）；实现注意错误宽容（读失败的目录 count=0 或 -1 标记）。
3. 保持 text 视图不变（AI 可读性优先），新增字段只进 JSON 结构——避免破坏现有测试与前端展示。

---

## 六、模块总结：判定表、真 Gap 清单与优先级建议

### 6.1 整体判定表

| 需求 | 优先级 | 判定 | 现状等级 | 关键证据 |
| :---: | :---: | :---: | :---: | :--- |
| REQ-C01 单次定时器 | P1 | 缺口 | 0 / 3（工具不存在；wait timer 子集且未接线） | wait_subagents.rs:47-51、:533-538；tools/mod.rs:60-71；engine.rs:617 |
| REQ-C02 早退条件 | P1 | 缺口 | 0.5 / 3（wait 原语内嵌"指定子代理终态即返回"，无 any、无冲突检测） | wait_subagents.rs:244-266、:150-168 |
| REQ-C03 Cron 调度 | P1 | 缺口 | 0.5 / 3（前端面板 + cron 校验器齐，引擎零实现，命令幽灵化） | workflowScheduler.ts:301-312；workflowRunner.ts:4-7、:27-87 |
| REQ-C04 反应式唤醒 | P0 | 部分覆盖 | 2 / 3（run 级事件驱动完备；定时器/Cron 唤醒源缺；无会话级 idle；摘要未标准化） | events.rs:487-496、:560-603；control.rs:253-302；flow_graph.rs:21-24 |
| REQ-C05 等待策略 | P2 | 部分覆盖 | 1.5 / 3（三模式契约 + 持久化齐；通道未接线；无兜底 watchdog；无策略辅助） | wait_subagents.rs:40-51、:124-199；recovery.rs:371-380 |
| REQ-F01 Grep | P0 | 部分覆盖 | 2.5 / 3（双模式/大小写/glob/上限全有；缺文件级模式、排除 glob、引导文案） | search.rs:57-71、:155-170、:211-234 |
| REQ-F02 防截断读取 | P1（重点） | 缺口 | 0.5 / 3（字符预算截断 + truncated 标记有；行号/行边界/续读全缺；二进制拒绝） | fs.rs:32-40、:86-91；tools/mod.rs:384-390 |
| REQ-F03 目录列举 | P0 | 基本满足 | 2.5 / 3（深度 1 / 类型 / 大小 / mtime 齐；缺相对路径与目录计数） | fs.rs:288-296、:352-377 |

### 6.2 真 Gap 清单（按实现顺序分组）

**第一梯队：工具级独立小改造（无引擎依赖，可立即开工）**

| # | Gap | 落点 | 工作量估计 |
| :---: | :--- | :--- | :---: |
| G1 | REQ-F02 防截断：行号范围 + maxLines + 完整行边界 + ContentOffset 续读 + 二进制文件引用 | `crates/agent-tools/src/tools/fs.rs` ReadFileTool（:59-128）+ 测试 | 中（核心改造） |
| G2 | REQ-F01 文件级模式（matchPerLine=false）+ 排除 glob（excludeGlobs） + truncated 引导文案 | `crates/agent-tools/src/tools/search.rs`（:149-170、:220-234）+ 测试 | 小 |
| G3 | REQ-F03 相对路径字段 + 目录子项计数 | `crates/agent-tools/src/tools/fs.rs` DirEntry（:288-296）+ list_dir（:355-375）+ 测试 | 小 |

**第二梯队：模块 C 公共底座（C01/C02/C05 共用的接线面）**

| # | Gap | 落点 | 工作量估计 |
| :---: | :--- | :--- | :---: |
| G4 | `SubagentWaitChannel` 引擎侧实现（wait_for_terminal / snapshot / persist_declaration / inject） | `apps/agent-workbench/src-tauri`（或 orchestrator 扩展）+ `BuiltinToolConfig` 注入（tools/mod.rs:54-57、engine.rs:617） | 中 |
| G5 | `set_timer` 工具 + `TimerChannel` + TimerRegistry（到期经 followUp 环注入，`timer_*` 持久化） | 新工具 + `crates/session-loop/src/control.rs:289-302` 注入 + session_meta | 中 |
| G6 | TimerCondition（never/any/sender + 冲突检测 + 早退查表） | 并入 G5 的 TimerRegistry | 小-中 |

**第三梯队：唤醒收口与时间调度（依赖第二梯队）**

| # | Gap | 落点 | 工作量估计 |
| :---: | :--- | :--- | :---: |
| G7 | 会话级 idle 待命：drive_run_loop 收口后查 PendingMessageQueue / 活跃定时器 → 自动续 run + L1 注入 | `apps/agent-workbench/src-tauri/src/core_run_commands.rs:1133-1226` + `crates/orchestrator/src/steering_queue.rs` | 中 |
| G8 | 唤醒摘要标准化映射（事件 → Prompt 模板，含批量推送收口） | `crates/conex-types` 新类型或引擎侧小模块 + RuntimeSteering 事件（events.rs:439-445） | 小-中 |
| G9 | Cron 引擎：解析器（conex-types 纯函数）+ SchedulerRegistry + MaxIterations / IsDaemon + workflow 命令实装与登记 | `crates/conex-types` + `apps/agent-workbench` + `command_manifest.rs:62` + 前端 workflowRunner.ts 去幽灵化 | 大 |
| G10 | 兜底 watchdog：dispatch_* 声明超 N 分钟未终态 → steering 条目唤醒（REQ-C05 验收 2） | 引擎侧 tokio 任务 + recovery.rs:371-380 模式复用 | 小（依赖 G4） |

### 6.3 优先级与实施路线建议

```
Phase 0（F 模块，独立先行，1 周内）：
 ├── G1 REQ-F02 防截断读取（行号/行边界/ContentOffset）——重点需求，AI 误判根因
 ├── G2 REQ-F01 grep 文件级模式 + 排除 glob
 └── G3 REQ-F03 目录字段补齐

Phase 1（C 模块底座，1-1.5 周）：
 ├── G4 SubagentWaitChannel 引擎接线——解锁整个子代理等待链路
 ├── G5 set_timer + TimerRegistry（REQ-C01）
 └── G6 TimerCondition + 冲突检测（REQ-C02）

Phase 2（唤醒收口，1-1.5 周）：
 ├── G7 会话级 idle 待命 + 自动续 run（REQ-C04 验收 1/2 补齐）
 ├── G8 唤醒摘要标准化（REQ-C04 验收 3）
 └── G10 兜底 watchdog（REQ-C05 验收 2）

Phase 3（Cron，按需 1-2 周）：
 └── G9 Cron 引擎 + workflow 命令实装（REQ-C03）
```

### 6.4 需要架构裁决的开放问题

1. **contentOffset 粒度**：REQ 以字节为粒度（REQ-agent-engine-capabilities.md:755），本项目 read_file 现以字符为预算单位（fs.rs:18）——建议以**行数**为续读粒度（天然完整行边界），需在需求侧确认或记录偏差。
2. **二进制读取形态**：REQ 允许 base64 或文件引用二选一（:760），建议文件引用（不冲击上下文），需确认。
3. **Cron 的 IsDaemon=true 会话归属**：独立常驻任务的 run 归属哪个会话、生命周期如何管理，与模块 B 守护进程语义联动裁决（见 4.3.4 建议 5）。
4. **会话级 idle 与 run 收场的边界**：G7 的"自动续 run"与"AI 本应结束对话"如何区分（无任何待处理队列/定时器时不得续 run），实现需以 PendingMessageQueue 空 + 定时器表空为硬条件。

### 6.5 任务书拆解建议（G1-G10 → 子 Agent 任务卡）

> 按 AGENTS.md 子 Agent 调度规则（一轮最多 12 个子 Agent；同文件串行），给出每个 Gap 的任务卡要素。文件冲突注意项：G1 与 G3 同改 `crates/agent-tools/src/tools/fs.rs`、G2 改 `search.rs`——**同文件任务必须串行**。

| 任务卡 | 对应 Gap | 输入文档 | 产出路径 | 验收要点 | 冲突注意 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| PE-CF-01 | G1（F02 防截断） | 本文 5.2 + REQ-F02 | `crates/agent-tools/src/tools/fs.rs` + 测试 | 行号窗口正确；截断在完整行边界；contentOffset 续读闭环 | 与 PE-CF-03 同文件串行 |
| PE-CF-02 | G2（F01 grep 增强） | 本文 5.1 + REQ-F01 | `crates/agent-tools/src/tools/search.rs` + 测试 | matchPerLine=false 只返文件列表；excludeGlobs 生效 | 与 PE-CF-01/03 独立 |
| PE-CF-03 | G3（F03 字段补齐） | 本文 5.3 + REQ-F03 | `crates/agent-tools/src/tools/fs.rs` + 测试 | DirEntry 含 path 与 count 字段 | 与 PE-CF-01 同文件串行 |
| PE-CF-04 | G4（wait 通道接线） | 本文 4.5.4 + wait_subagents.rs:366-389 | `apps/agent-workbench/src-tauri` 或 orchestrator + 集成测试 | 四方法全实现；未接线时报错消失 | 依赖引擎 run 通道 |
| PE-CF-05 | G5+G6（set_timer + TimerCondition） | 本文 4.1/4.2 + REQ-C01/C02 | agent-tools 新工具 + 引擎侧 TimerRegistry + 测试 | 到期注入 Prompt；any/sender 早退；冲突拒绝 | 依赖 PE-CF-04 的注入通道 |
| PE-CF-06 | G7（会话级 idle 续 run） | 本文 4.4.4 + REQ-C04 | `apps/agent-workbench/src-tauri/src/core_run_commands.rs` + 测试 | 队列非空自动续 run；空队列不续 | 依赖 PE-CF-05 |
| PE-CF-07 | G8（唤醒摘要标准化） | 本文 4.4.4 + REQ-C04 验收 3 | `crates/conex-types` 新类型 + 注入接线 + 测试 | 6 类事件各有摘要模板；摘要随唤醒注入 | 依赖 PE-CF-06 |
| PE-CF-08 | G9（Cron 引擎 + 命令实装） | 本文 4.3 + REQ-C03 | `crates/conex-types` 解析器 + workbench 调度器 + 前端桥 + 测试 | 5 段式解析正确；MaxIterations 停止；IsDaemon 常驻 | 与模块 B 生命周期裁决先行 |
| PE-CF-09 | G10（兜底 watchdog） | 本文 4.5 + REQ-C05 验收 2 | 引擎侧 tokio 任务 + steering 注入 + 测试 | 超 N 分钟未终态触发兜底唤醒；配置项生效 | 依赖 PE-CF-04 |

**执行顺序建议**：Phase 0（PE-CF-01/02/03 可并行，文件错开）→ Phase 1（PE-CF-04 → PE-CF-05）→ Phase 2（PE-CF-06/07 → PE-CF-09）→ Phase 3（PE-CF-08，需先完成裁决问题 3）。

---

## 附录 A — 证据文件清单

### A.1 直接证据文件

| 文件 | 行号引用 | 说明 |
| :--- | :--- | :--- |
| `crates/agent-tools/src/tools/wait_subagents.rs` | :40-72、:75-78、:83-89、:124-199、:206-216、:233-305、:318-350、:366-389、:394-596 | 三模式等待 + 事件驱动原语 + 通道契约 |
| `crates/agent-tools/src/tools/search.rs` | :18-34、:47-71、:89-191、:194-268、:271-356 | grep_search / fuzzy_find 全实现 |
| `crates/agent-tools/src/tools/fs.rs` | :18-47、:59-129、:285-402、:405-478 | read_file / list_dir / file_stat |
| `crates/agent-tools/src/tools/mod.rs` | :40-71、:74-114、:295-334、:384-390 | BuiltinToolConfig / clamp_text / decode_text |
| `crates/session-loop/src/control.rs` | :32-83、:95-117、:209-421 | L0-L3 控制总线与注入环 |
| `crates/session-loop/src/input.rs` | :19、:36-45、:96-103 | 输入三环 |
| `crates/session-loop/src/hooks.rs` | :59-106、:137-277、:390-703 | 14 事件钩子注册表 |
| `crates/session-loop/src/loop/handlers/awaiting_input.rs` | :14-32 | run 无输入收场 |
| `crates/session-loop/src/steering/nudge.rs` | :10-12、:45-90 | nudge 通道与 steering 消息构造 |
| `crates/orchestrator/src/flow_graph.rs` | :11-28、:512-523、:847-850、:918-1090、:1096-1210 | DAG 调度 + 合成唤醒 |
| `crates/orchestrator/src/subagent_events.rs` | :1-30、:101-160 | 子代理事件唯一发射方 |
| `crates/orchestrator/src/recovery.rs` | :7-31、:336-380 | 恢复阶梯与阶梯 2 通知 |
| `crates/orchestrator/src/steering_queue.rs` | :6-21、:111、:145、:219 | PendingMessageQueue |
| `crates/orchestrator/src/events.rs` | :47-57、:106-200 | EventQueue 序列与持久化分流 |
| `crates/conex-types/src/events.rs` | :121-182、:285-604、:606-664、:676-695、:713-800 | 31 事件契约 + 背压分级 |
| `apps/agent-workbench/src-tauri/src/engine.rs` | :610-639 | 内置工具注册（默认配置） |
| `apps/agent-workbench/src-tauri/src/core_run_commands.rs` | :102-120、:132-262、:1133-1226 | drive_run_loop / RunProducer / 审批门 |
| `apps/agent-workbench/src-tauri/src/process.rs` | :57、:296-311 | shell 执行（同步形态） |
| `apps/agent-workbench/src-tauri/src/command_manifest.rs` | :62（命令清单） | 无 workflow 命令 |
| `apps/crish-desktop/src/components/settings/ScheduledTasksPanel.tsx` | :31-206 | 前端定时任务面板 |
| `apps/crish-desktop/src/api/workflow-api/workflowScheduler.ts` | :6-18、:99-205、:245-322 | 调度类型 + cron 校验（拒绝下发） |
| `apps/crish-desktop/src/api/workflow-api/workflowRunner.ts` | :4-7、:27-87、:118-140 | workflow 幽灵命令声明 |

### A.2 检索证据

- `rg "workflow|Workflow" crates/`：零命中——Rust 内核无 workflow 实现。
- `rg "cron|Cron|timer|Timer" crates/`：全部命中集中在 `wait_subagents.rs` 与 `tools/mod.rs` 的等待模式注释与实现——无独立定时器/Cron 代码。
- `rg "scheduled|cron" apps/agent-workbench/src-tauri/src/`：零命中——Tauri 壳层无调度命令。
- `rg "SubagentWaitChannel|SubagentSpawner" apps/`：零命中——引擎侧通道实现缺失（仅 crates 内契约与测试）。

### A.3 需求文档对照

- 模块 C：`docs/feature-gap-analysis/REQ-agent-engine-capabilities.md:277-383`
- 模块 F：`docs/feature-gap-analysis/REQ-agent-engine-capabilities.md:705-786`
- 优先级总览：`docs/feature-gap-analysis/REQ-agent-engine-capabilities.md:858-920`

---

> **文档结束**
> 本文档为模块 C + 模块 F 的现状分析结论，供排期与子 Agent 任务书拆解使用；所有建议均以"落地到现有架构、不另起炉灶"为约束，具体实现细节在任务书中细化。
