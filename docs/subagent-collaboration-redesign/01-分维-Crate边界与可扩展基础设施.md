# 分维 · Crate 边界与可扩展基础设施（2026-10-28）

> 服务于 [00-总方案](./00-总方案-子代理协作与生命周期架构.md)。
> 目标：把子代理从「散落在 8 个 crate 的实现细节」收敛为**一个可独立演进的领域 + 一层可替换的运行时基础设施**；用户改配置、开发者换实现，都不需要动调度骨架。

---

## 一、直接回答：现在是不是一个 crate？

**不是。** 子代理没有自己的 crate，逻辑分布如下：

| 层 | 位置 | 内容 |
| :--- | :--- | :--- |
| 工具契约 | `crates/agent-tools/src/tools/subagent/` | `SubagentSpawnRequest` / `capability_mode` / `TaskType` / 递归守卫 / 工具 schema |
| 工具面 | `crates/agent-tools/src/tools/{send_message,wait_subagents,kill_subagent}.rs` | 通信/等待/终止工具 |
| 提示词 | `crates/agent-tools/src/subagent_inject.rs` | 角色约束/权限指引/产出目录等注入段 |
| 工具集裁剪 | `crates/agent-tools/src/readonly.rs` | task_type → 白名单（但 capabilityMode 未消费） |
| 生产运行时 | `crates/conex-run/src/subagent_spawner/` | spawner / 生命周期 / 容量预留 / 落库 / 终态 |
| 恢复与编排 | `crates/orchestrator/src/{recovery,subagent_events,steering_queue}.rs` | 四级恢复阶梯 / 事件发射 / 跨 run 队列 |
| 持久化 | `crates/conex-db/src/{agents,sessions}.rs` | `session_agents` 行 |
| 壳层 | `apps/agent-workbench/src-tauri/src/{main,lifecycle_commands}.rs` | 命令注册/resume_subagent |

依赖方向（现状）：

```
conex-types (leaf)
   ↑
agent-tools ──────────────┐
   ↑                      │
conex-db ─────────────────┤   （conex-db 也依赖 agent-tools：工具类型复用）
   ↑                      │
session-loop ─────────────┤
   ↑                      │
orchestrator ─────────────┤
   ↑                      │
conex-run ────────────────┘
   ↑
agent-workbench (Tauri)
```

**由此产生的实际问题**（不是审美问题）：

1. **DTO 三份漂移**：`SubagentSpawnRequest`（工具层）→ `SubagentRunConfig`（运行层）→ `SessionAgent`（持久层）各有一套字段；新增 `capability/model` 时三处都要改，且已经出现「工具层有、运行层没有」的断层（`capabilityMode` 正是这样变成死字段的）。
2. **规则在错误的位置**：递归/容量/能力规则住在工具层（`agent-tools`），执行期却在 `conex-run`；两边各持一半，默认值无法被主 agent 运行时调整。
3. **运行时与宿主强耦合**：`subagent_spawner` 直接依赖 `CoreRunState`、`RunTaskOptions`、`LocalDb`、steering 队列；换一个宿主（daemon / 服务端 / 测试）只能复制代码。
4. **扩展只能改代码**：能力档、通信节奏、深度/并发都是编译期常量或散落 if，用户/开发者没有稳定的配置面与替换点。

---

## 二、目标结构：两个新 crate（领域 / 运行时）

```
crates/conex-agents            ← 纯领域（无 I/O，可单测、可 WASM）
   ├─ model     身份/配置/策略/能力/权限/消息/错误
   ├─ rules     纯函数：权限 min、能力升降、策略守卫、令牌桶、摘要聚合
   ├─ protocol  AgentMessage / AgentFault / AgentAction（serde wire）
   ├─ prompt    提示词段构建（纯函数）
   └─ ports     端口 trait（存储/启动/通知/模型/时钟/策略）

crates/conex-agent-runtime     ← 编排基础设施（可复用，不依赖宿主）
   ├─ registry   代理注册表（内存 + Store 端口）
   ├─ scheduler  准入/spawn 编排/容量与压力
   ├─ mailbox    即时/摘要双通道 + 节流 + 合并
   ├─ faults     错误管线 + 建议动作
   ├─ recovery   四级恢复阶梯编排
   └─ reconcile  启动对账 / interrupted / resumable

适配层（保持原位，变薄）：
   conex-run     实现 AgentLauncher / AgentStateSource（父权限/模型/拓扑）
   conex-db      实现 AgentStore
   orchestrator  实现 AgentTransport（steering 适配）+ fork 适配
   agent-tools   工具 schema 只做参数映射与调用端口，不含领域规则
   conex-types   公共 wire 事件（subagent-* / agent-fault）保持
   workbench     IPC 命令注册/映射
```

依赖方向（单行、无环）：

```
conex-types
   ↑
conex-agents          ← 只依赖 conex-types + serde/async-trait/thiserror
   ↑
conex-agent-runtime   ← 只依赖 conex-agents + tokio/tracing（端口注入）
   ↑
orchestrator / conex-run / conex-db / agent-tools   ← 适配实现
   ↑
workbench
```

**为什么是两个而不是一个**：

- 领域（策略/协议/纯规则）必须无 tokio/db/tracing，才能被 daemon、服务端、前端模拟器复用，也才能用纯单测锁住语义；
- 运行时需要 async/队列/超时，且将来可能独立成服务；混在一个 crate 会把 I/O 依赖传染给领域；
- 两个是「领域 + 运行时」的标准分层，再多就是 crate 爆炸（不划算）。

**为什么不是一个 crate 里分模块**：`conex-run` 已经有 40+ 模块；子代理再堆进去只会继续与宿主耦合，无法解决「换宿主/换实现」的需求。独立 crate 才能把依赖方向钉死。

---

## 三、领域模型（conex-agents）

### 3.1 类型收敛（消灭三套 DTO）

| 现类型 | 目标 | 说明 |
| :--- | :--- | :--- |
| `SubagentSpawnRequest`（agent-tools） | `AgentSpec` | 工具无关的 spawn 输入：prompt/task_type/capability/model/paths/budget/parent |
| `SubagentRunConfig`（conex-run） | `AgentConfig` | 持久化的运行配置（替代字段快照，见 00 §4/§5） |
| `SessionAgent`（conex-types） | `AgentRecord` | 持久身份/状态；`SessionAgent` 作为行 DTO 保留并映射 |
| `RecursionGuardConfig` | `SpawnPolicy` | 主 agent 可调的字段（JSON） |
| `RecursionGuardRejection` | `AgentFault` 子集 | 统一错误信封 |
| `SubagentCapabilityMode` | 保留枚举 | 从 agent-tools 迁入 |
| `TaskType` | 保留枚举 | 迁入 |
| `SubagentEndedInfo` | `AgentTerminal` | wire 事件仍留在 conex-types |

原则：**领域 crate 定义唯一真源；适配层只做映射，不得再定义平行结构。**

### 3.2 端口（Ports）——开发者替换点

| 端口 | 职责 | 现实现 | 可替换场景 |
| :--- | :--- | :--- | :--- |
| `AgentStore` | 身份/状态/心跳/策略持久化 | conex-db | 服务端/内存测试 |
| `AgentLauncher` | 启动一个 agent run | conex-run `run_task_impl` | daemon / 远程执行 |
| `AgentStateSource` | 父当前权限/模型/拓扑/负载 | conex-run `CoreRunState` | 多宿主 |
| `AgentTransport` | 即时消息投递 + 唤醒 | orchestrator steering | WebSocket / IPC |
| `ModelResolver` | 模型名 → provider | engine `ProviderResolver` | 自定义模型路由 |
| `Clock` | 时间/定时器 | 系统时钟 | 测试/回放 |
| `PolicyStore` | 策略读写 | session_meta | 项目级配置中心 |
| `ToolCapabilityGate` | 能力→工具/命令判定 | readonly 白名单 | 企业自定义工具集 |

### 3.3 纯规则模块（无 I/O，必测）

- `permission::effective(parent, requested) -> PermissionMode`（min 规则）
- `capability::clamp(parent, requested)` / `can_transition(from,to)`
- `policy::admit(snapshot, policy) -> Result<(), AgentFault>`（深度/并发/环）
- `throttle::{TokenBucket, LongWindowCounter}`（即时/紧急双桶）
- `digest::{Aggregator, FlushDecision}`（按时间/条数/字节/父空闲）
- `fault::{classify, suggest_actions}`（错误 → 可执行建议）
- `prompt::{role, task_brief, parent_goal, capability_summary, collaboration_protocol, output_contract}`

---

## 四、运行时基础设施（conex-agent-runtime）

- **Registry**：`AgentRecord` 的内存索引 + Store 端口；按 session/parent/depth 查询；心跳与对账。
- **Scheduler**：准入（policy）→ 预留 → 启动（Launcher 端口）→ 记账；批量原子语义保留；压力快照（active/siblings/provider_pressure/queue_depth）随拒绝返回。
- **Mailbox**：`instant` / `digest` 两通道；消息合并（dedupe_key）；双令牌桶；摘要 flush；投递走 `AgentTransport` 端口（不直接依赖 steering）。
- **FaultPipeline**：统一信封 → 工具结果 / 终态事件 / 即时消息 / 摘要四条出口；确保「错误必达、过程可丢」。
- **Recovery**：四级阶梯从 orchestrator 迁入（依赖 Store/Clock/Launcher 端口）；fork 由 `AgentTransport`/`ForkStrategy` 适配。
- **Reconcile**：启动时扫描非终态记录 → interrupted/resumable → 一条摘要通知；不自动重派（策略可开）。

运行时**不认识** Tauri、SessionLoop、CoreRunState；一切宿主细节通过端口注入。这样它可以直接被单测驱动，也便于未来做独立的多 agent 服务。

---

## 五、配置体系（用户/开发者自定义）

### 5.1 三层解析（后层只能收窄）

```
App 默认（内置常量/配置文件）
  → Session 策略（session_meta.agent_policy，主 agent 可改）
    → Spawn 覆盖（request 的 capability/model/paths/budget，只能 ≤ 上层）
```

- `AgentPolicy` 带 `schema_version`，未知字段容忍、缺失取默认；校验失败返回 `agent.config_invalid` + 字段路径。
- 主 agent 工具 `configure_agents` 只能改 Session 层；App 默认由桌面设置/配置文件提供；Spawn 覆盖由 `run_subagent` 调用方提供。

### 5.2 Profile（预设而非硬编码）

- **通信档位**：`quiet`（摘要 5min/50 条，即时 1/min）、`normal`（90s/20 条/8KB，3/min）、`verbose`（30s/10 条，6/min）；紧急桶三档同默认（可单独覆写）。
- **能力预设**：`reader` / `writer` / `executor` / `full`，映射到 capability + task_type + 工具集；企业/项目可增删条目（数据驱动，不写 match 分支）。
- **模型别名**：`fast` / `balanced` / `deep` → 具体模型（用户可改），spawn 可指定别名或模型名。

### 5.3 开发者扩展点

1. 实现端口（新 Store / 新 Launcher / 新 Transport / 新 Resolver）。
2. 注册 capability 预设与工具白名单（配置，不改代码）。
3. 订阅运行时事件（`on_spawn` / `on_terminal` / `on_fault`），用于审计/观测/自定义 UI。
4. 自定义恢复策略（实现 `RecoveryStrategy` 端口，替换四级阶梯）。
5. 不自建插件运行时、不自建消息中间件——扩展点是 trait + 配置，不是脚本沙箱。

---

## 六、抽象纪律（防止再次分裂）

1. **领域无 I/O**：`conex-agents` 禁止出现 tokio/db/tracing/tauri/session-loop 依赖（CI `cargo tree` 断言）。
2. **规则纯函数化**：准入/权限/能力/节流/摘要全部可单测，不依赖运行时。
3. **DTO 单一真源**：工具层/运行层/持久层的结构体只能映射，不得复制字段；新增字段只改领域模型 + 适配映射。
4. **错误单向映射**：领域 `AgentFault` → 工具 `ToolError` / IPC `CoreError` / 事件 payload；反向不成立。
5. **事件契约留 conex-types**：公共 wire（subagent-started/event/ended、agent-fault）仍是跨端契约；领域内部消息不进 wire。
6. **适配层薄**：`conex-run` 只做「启动 + 父状态读取 + 终态上报」，业务判断全部下沉运行时。
7. **不新增常量化策略**：深度/并发/通信/预算默认值只能出现在 `AgentPolicy::default()` 一处。

---

## 七、迁移步骤（行为不变，逐阶段可回滚）

### S1 · 抽领域（风险最低）—— **已落地（2026-10-28）**
1. ✅ 新建 `crates/conex-agents`（deps: conex-types, serde, serde_json, async-trait, thiserror；`cargo tree` 实测无 tokio/conex-db/tauri）。
2. ✅ 迁入：`TaskType`/`SubagentCapabilityMode`/`SubagentRole`/`SubagentState`（含能力钳制 `clamp_to_parent`、默认能力档）/`SpawnPolicy` 与守卫纯函数/`AgentPolicy`+`CommPolicy` 预设/`AgentFault`+`AgentAction`/`Clock`+`PolicyStore` 端口。
3. ✅ `agent-tools`：删除 `guard.rs` 与 defs 中的重复枚举；门面 re-export 领域类型；守卫测试改为策略语义。
4. ✅ `conex-run`：`RecursionGuardConfig` → `SpawnPolicy`；旧 16 硬上限删除（默认数量不限，深度默认 1，主 agent 可调）。
5. ✅ `orchestrator`：flow 调度预算改为可选上限（默认不限，`flow_*` 元数据可设）。
6. 待办（S1.2）：提示词段构建（`subagent_inject.rs`）迁入领域 `prompt` 模块；`SubagentRunConfig` → `AgentConfig`；`SubagentSpawnRequest` → `AgentSpec`。DB v14 字段与 `SessionAgent` 映射已在 P3 落地。
7. 验收（2026-10-28 实测）：`conex-agents` 11、`agent-tools` 682、`conex-run` 397（+1 已知遗留 e2e）、`orchestrator` 258 全绿；`cargo check --workspace` 通过；`cargo tree -p conex-agents` 无 tokio/db/tauri。
8. 运行时可调策略已接线：`SubagentSpawnerImpl::set_policy` / `policy()`（主 agent `configure_agents` 的落点）。
9. 迁移增量：`SpawnPolicy` 默认数量不限，容量类测试显式设置有界策略；生产 16 硬上限已删除。

### S2 · 抽运行时
1. 新建 `crates/conex-agent-runtime`（deps: conex-agents, async-trait, tokio, tracing）。
2. 迁入 registry/scheduler/mailbox/faults/recovery/reconcile；以端口替换 `CoreRunState`/`LocalDb`/steering 直连。
3. `conex-run` 实现 `AgentLauncher`/`AgentStateSource`；`conex-db` 实现 `AgentStore`；`orchestrator` 实现 `AgentTransport`。
4. 验收：原有 spawn/恢复/终态测试全绿；新增「端口替换测试」（InMemory 实现跑通全链路）。

### S3 · 配置与自定义面
1. `AgentPolicy` JSON schema + 三层解析 + profile 预设。
2. `configure_agents` 工具与 IPC；`session_meta` 持久化与恢复。
3. 文档：用户配置手册 + 开发者端口手册；契约漂移门禁（JSON → TS 类型生成）。

---

## 八、风险与对策

| 风险 | 对策 |
| :--- | :--- |
| crate 拆分引入循环依赖 | 依赖单向（types → agents → runtime → adapters）；CI `cargo tree` 断言 |
| 迁移期双份代码漂移 | 每阶段删除源实现，不做长期兼容层；DTO 只映射不复刻 |
| 运行时与现有 `CoreRunState` 深耦合 | 先端口化「启动/父状态/终态/队列」四个面，其余暂留适配层 |
| 过度抽象 | 只保留 8 个端口；新增端口须有第二个实现场景，否则用配置 |
| 编译时间上升 | 领域 crate 无重依赖；运行时只依赖 tokio/tracing |

---

## 九、明确不做

- 不引入 actor 框架、消息中间件、插件运行时、脚本沙箱。
- 不做多进程/多机 agent 调度（端口预留，不在本战役实现）。
- 不把工具 schema 放进领域 crate（工具层依赖 Tool trait，反向会成环）。
- 不在适配层复制领域 DTO 或策略默认值。

---

*本分维为结构设计，未实施。建议先做 S1（纯领域抽取，行为零变化），再按 00 总案 P0→P3 推进功能。*
