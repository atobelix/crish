# Crish 多 Agent 协作功能需求设计

> 本文档是 `docs/multi-agent-repair/` 系列的第 04 章，承接 `00-方案总览.md`（第 7 轮落地）。
> 面向对象：后续实现 Agent（引擎 Rust、前端 UI React、提示词协议层）。
> 职责：把"多 Agent 协作"从现状壳（类型/表/UI 已接线、运行资产为零）推进到可运行、可恢复、可干预的功能集合。
> 每个能力必须回答三个问题：**隔离边界在哪、干预入口在哪、持久化在哪**。

## 1. 总则

### 1.1 现状对接点（第一波研究结论，实现前必须核对）

| 域 | 现状 | 位置 |
| --- | --- | --- |
| 类型 | SubagentRole 5 角色、SubagentCapabilityMode 4 档、RecursionGuardConfig（maxDepth=3 / maxSiblings=5 / maxConcurrent=6）、SubagentInstanceSnapshot 全套齐备 | `packages/shared-types/src/subagent.ts:5/13/23/36/65` |
| 表 | session_agents / session_agent_messages / session_meta（KV）建表完毕 | `crates/conex-db/src/lib.rs:327/473/361` |
| 运行资产 | **零**：无 run_subagent 工具（agent-tools 仅注册 8 个内置工具）、Rust 零发射 subagent-started/event/ended 事件、无压缩自动触发 | `crates/agent-tools/src/tools/mod.rs`（8 工具）、`crates/conex-compaction/src/lib.rs` |
| 系统提示词 | 请求构建处 `system_prompt: None` 恒为空，注入口存在但未接内容 | `apps/agent-workbench/src-tauri/src/engine.rs:220` |
| 事件 | EventRouter 已处理 subagent 三事件，Rust 侧无产出 | `apps/crish-desktop/src/api/chat-bridge/EventRouter.ts:475/488/500` |
| 命令 | 幽灵命令 `workbench_send_to_subagent` / `workbench_get_subagent_status` 双重守门（manifest 登记 + 前端零命中） | `apps/agent-workbench/src-tauri/src/command_manifest.rs:252-253`、`apps/agent-workbench/src/core/tauri-command-registry.ts:281` |
| 调度 | SessionTree 追加/分叉/恢复完备；RewindPlan 已实现；ApprovalGate 已实现；ControlBus L0-L3 已实现；PendingMessageQueue 已实现；重试器已实现 | `crates/orchestrator/src/session.rs:187/537/670`、`crates/session-loop/src/tool_events.rs:68`、`crates/session-loop/src/control.rs`、`crates/orchestrator/src/steering_queue.rs:111`、`crates/agent-provider/src/retry.rs` |
| 前端 | AgentCard / InlineAgentPanel / AgentTeamBoard / AgentBrowsePad 面板完整 | `apps/crish-desktop/src/components/agent-card/*.tsx` |

### 1.2 设计原则（P0）

| 编号 | 原则 | 含义与实现要求 |
| --- | --- | --- |
| P0.1 并行与隔离 | 子 agent 之间**无共享可变状态**；隔离边界经 SessionTree 分叉与 run 边界承载（第一版 isolationMode 仅 none，即进程内隔离 + 会话树隔离，不承诺 worktree/process 隔离） | 任何子 agent 的写操作不得直接落盘到共享文件而不经主 agent 编排；子 agent 的上下文只来自其 run 的注入内容 |
| P0.2 可编排可干预 | L0-L3 控制总线可打断一切：L1 软注入不打断流、L2 协作停止等安全点、L3 强停立即中断；主 agent 是唯一编排者，干预入口必须对主 agent 与用户同时开放 | 每个 run、每个等待、每个审批都挂到 ControlBus / PendingMessageQueue 可达 |
| P0.3 状态可持久化 | run / 事件 / pending / 配额 / 计数全部落库可恢复；任何中途退出的编排流，重启后能从库里恢复到等价状态 | 落库位置优先 session_agents / session_agent_messages / session_meta（KV）；事件走 events 表 |
| P0.4 简单可扩展 | 最小实现优先：不引入本轮不需要的抽象；能力先以"固定结构 + 可配置阈值"落地，配置一律可经 session_meta 或配置面覆盖，禁止硬编码魔法数 | 每一新增能力必须回答：隔离边界 / 干预入口 / 持久化位置，写不清三问的宁可不做 |

### 1.3 三问模板（每个能力规格末尾必须给出）

- **隔离边界**：该能力不越过的边界（状态、文件、并发）。
- **干预入口**：L0-L3 中哪一级、经哪个通道（ApprovalGate / ControlBus / PendingMessageQueue）。
- **持久化在哪**：落库表与键。

## 2. 能力规格 C1-C10

### C1 checkpoint 优先恢复

**目标**：子 agent 中断后优先从 checkpoint 恢复，而非重跑全量。

- **触发条件**：
  - run 中断（L3 强停、进程退出、网络阶梯全部失败）后，主 agent 决定续跑该子 agent；
  - run 关联的 checkpoint 存在且校验通过（会话树叶子与 session_agents 状态一致）。
- **行为**：
  1. 提示词协议层在子 agent 系统提示词中声明 checkpoint 约定：子 agent 必须周期性输出结构化检查点（当前目标、已完成步骤、文件清单、下一步），且明确"恢复时优先消费检查点再继续"；
  2. 引擎检测 checkpoint：续跑前读取会话树叶子节点的 payload，若命中检查点内容则把"检查点摘要 + 目标剩余部分"作为恢复输入注入，而不是回放全部历史消息；
  3. RewindPlan 接线：恢复路径复用 `plan_conversation_rewind` 产出回退计划，仅在会话树形态与检查点不一致时才触发回退（回退本身受 C3/C4 门禁约束）；
  4. 损坏降级：checkpoint 解析失败或与会话树校验不一致时，降级为"从最近完整消息重放 + 通知主 agent 检查点失效"，不中断恢复流程，不抛未分类错误。
- **边界/例外**：
  - checkpoint 只读不写：子 agent 不能写入 checkpoint，checkpoint 由引擎在安全点采集；
  - system 消息永不进入检查点内容（对齐 C9）；
  - 恢复后与恢复前的 run 必须保持 `subagent_run_id` 相同（同一实例续跑），不得新建实例冒充。
- **分层归属**：引擎 Rust（检测与采集：session-loop 安全点 / orchestrator 恢复路径）；提示词协议层（检查点格式与声明）。
- **对接点**：
  - 检查点采集：`crates/session-loop/src/safe_point.rs`（安全点既有机制，C1 在其上追加检查点持久化）；
  - 恢复接线：`crates/orchestrator/src/restore.rs`、`crates/orchestrator/src/session.rs:537`（RewindPlan）；
  - 会话树读回：`crates/orchestrator/src/session.rs:331`（read_branch_path）。
- **独占写集 / 禁止触碰**：独占 `crates/orchestrator/src/restore.rs`（恢复路径）与 `crates/session-loop/src/safe_point.rs`（检查点采集追加）；`crates/orchestrator/src/session.rs` 只读引用（read_branch_path，session.rs 主写权归 C6）；engine.rs 上下文构建只读（主体归 C10，C1 只经注入点挂载）。
- **验收标准（可测断言）**：
  1. 构造含检查点叶子节点的会话树，续跑后断言引擎注入内容含检查点摘要且不含检查点之前的历史消息；
  2. 注入损坏检查点 JSON，断言恢复不 panic、返回降级标记、主 agent 收到"检查点失效"通知；
  3. 断言续跑前后 `subagent_run_id` 不变；
  4. 断言 checkpoint 内容不含任何 system 角色消息。

### C2 子 agent 创建时间注入 + git 回退谨慎指引

**目标**：子 agent 知道"自己创建于哪个时间点"，从而在 git 操作上保持谨慎，避免无谓的大面积回退。

- **触发条件**：
  - 子 agent run 上下文构建时（每次构建，恒成立）；
  - 子 agent 即将执行 git 回退类操作时（指引生效点）。
- **行为**：
  1. 引擎在子 agent 系统提示词中注入 `started_at`（创建时间戳，取 session_agents.started_at），并注明"该时间点是隔离边界的一部分"；
  2. 提示词协议层给出 git 回退谨慎指引：
     - 若目标 ref 的年代明显早于 started_at（判定阈值可配，默认"早于 24 小时"），优先采用**单文件修复**（在子 agent 自己的文件域内直接改文件），不整体回退；
     - 只有单文件修复失败、且确需整体回退时，才发起整体回退，并走 C3 门禁；
  3. 指引随上下文注入，子 agent 的回退决策在工具调用层被 C3/C4 复查。
- **边界/例外**：
  - started_at 只注入、不强制；强制面由 C3/C4 门禁承担（本能力是提示词层软约束）；
  - 恢复后的续跑 run，started_at 仍取首次创建时间，不因续跑刷新。
- **分层归属**：提示词协议层（指引文本与结构）；引擎 Rust（started_at 注入与目标 ref 年代计算辅助字段）。
- **对接点**：
  - 注入点：`apps/agent-workbench/src-tauri/src/engine.rs:218-233`（build_context，现 `system_prompt: None`，C2 起注入）；
  - started_at 来源：`crates/conex-db/src/lib.rs:1049`（load_session_agents 查询列）;
  - ref 年代计算：复用 `apps/agent-workbench/src-tauri/src/git.rs` 既有 git 能力。
- **独占写集 / 禁止触碰**：独占 engine.rs 内 C2 声明的 started_at 注入段；engine.rs build_context 主体归 C10（只读经注入点挂载）；conex-db 表结构只读（查询走既有接口）；`apps/agent-workbench/src-tauri/src/git.rs` 既有能力只读复用。
- **验收标准**：
  1. 注入后断言系统提示词包含 started_at 且等于库内 session_agents.started_at；
  2. 断言续跑 run 注入的 started_at 不变化；
  3. 提示词协议层命中"早于阈值"条件时，输出固定指引片段（可作快照断言）；
  4. 整体回退工具调用被路由到 C3 审批（联测）。

### C3 大面积 git 回退审批门禁

**目标**：大面积回退必须经审批，未经审批不执行，拒绝不崩溃。

- **触发条件**：任意子 agent（含主 agent 自身）发起 git 回退类工具调用，且满足任一阈值：
  - 涉及文件数 ≥ `max_revert_files`（默认 10）；
  - 涉及行数 ≥ `max_revert_lines`（默认 300）；
  - 目标 ref 年代 ≥ `max_revert_ref_age_hours`（默认 24 小时，即回到"最近 24 小时以前"）。
  - 三阈值均可配（配置面 + session_meta 键：`revert_max_files` / `revert_max_lines` / `revert_max_ref_age_hours`）。
- **行为**：
  1. ApprovalGate 拦截：在 `ApprovalGate` trait 的判定点（`crates/session-loop/src/tool_events.rs:68`）增加"回退面积检查"预处理器，命中阈值即生成审批请求，附：文件数、行数、目标 ref、目标 ref 年代、发起者（哪个 run）；
  2. CommandPolicy 兜底：命令级策略在工具执行层再查一次（防绕过审批路径直达执行器），不匹配策略的调用直接返回拒绝结果；
  3. 审批通过才执行；拒绝时工具返回结构化失败（含拒绝原因与"请缩小回退范围或改用单文件修复"指引），run 正常结束，不得 panic、不得把拒绝当引擎故障；
  4. **审批人=用户**：审批请求的裁决权归用户（主 Agent 仅转呈并等待用户明确同意，不得单方面批准），与 05 手册 §2.2「用户明确同意」语义一致；
  5. 审批请求/结果写 events 表（可审计），拒绝记录同样落库。
- **边界/例外**：
  - 阈值内（未触发任何一条）的回退不拦，保持零打扰；
  - C4 的"连续回退必审批"独立于本能力叠加生效；
  - 审批超时（默认 60s，可配）视为拒绝并落库。
- **分层归属**：引擎 Rust（ApprovalGate 扩展 + CommandPolicy + 落库）。
- **对接点**：
  - 拦截点：`crates/session-loop/src/tool_events.rs:68`（ApprovalGate trait）、`crates/session-loop/src/tool_exec.rs:99`（approval 注入）；
  - 既有实现参照：`apps/agent-workbench/src-tauri/src/core_run_commands.rs:119`（ApprovalGateImpl，先发后等防死锁）；
  - 配置面：`crates/agent-tools/src/tools/mod.rs`（BuiltinToolConfig 追加回退阈值字段）。
- **独占写集 / 禁止触碰**：独占 `crates/session-loop/src/tool_events.rs`（ApprovalGate 扩展 + 回退面积预处理器）、`crates/session-loop/src/tool_exec.rs`（审批注入）、agent-tools 配置面回退阈值字段；C4 只读经判定钩子挂载（不并写 tool_events.rs 主体）。
- **验收标准**：
  1. 构造超阈值回退调用，断言产生审批请求且工具不执行；
  2. 拒绝审批后断言返回结构化拒绝结果、run 状态正常、events 表落库；
  3. 低于全部阈值的回退不触发审批（断言无审批事件）；
  4. 修改 session_meta 阈值键后行为随之变化（可配性断言）；
  5. 无审批通道注入时（approval=None）阈值检查仍生效（CommandPolicy 兜底断言）。

### C4 连续 git 回退计数

**目标**：短时间内连续回退必须逐次审批，杜绝"分多次小额回退绕过 C3"。

- **触发条件**：同一会话内发起 git 回退类工具调用，且满足：
  - 本次是最近时窗内的第 ≥2 次回退（第二次起无论面积必审批）；或
  - 单次面积已触发 C3。
- **行为**：
  1. 引擎维护会话级连续回退计数：每次回退调用（含被拒与通过）计数 +1，记录最近回退时间戳；
  2. 计数持久化到 `session_meta`（键：`revert_streak_count` / `revert_last_at`），重启可恢复；
  3. 时窗归零：距上次回退超过 `revert_streak_window_seconds`（默认 600s，可配）则计数清零；
  4. 第 2 次起的每次回退一律走 C3 审批通道，即使面积在阈值内；
  5. 计数变更随审批事件一并写入 events 表。
- **边界/例外**：
  - 只统计实际发起回退（成功、被拒、审批中）的调用；纯查询 git 状态的调用不计数；
  - 时窗归零检查在每次调用前执行（惰性归零，不依赖定时器）。
- **分层归属**：引擎 Rust（计数与归零逻辑 + 持久化）。
- **对接点**：
  - 计数读写：`crates/conex-db/src/lib.rs:1204`（get_session_meta）/ `:1223`（set_session_meta）；
  - 判定注入点：与 C3 共用工具执行前的策略预处理器（`crates/session-loop/src/tool_events.rs:68` 附近）。
- **独占写集 / 禁止触碰**：独占计数模块（新增文件，经 C3 提供的判定钩子挂载）与 session_meta 键 `revert_*`；`crates/session-loop/src/tool_events.rs`、`tool_exec.rs` 只读（不并写 C3 独占文件主体）；conex-db 表结构只读。
- **验收标准**：
  1. 同会话两次小额回退（面积低于 C3 阈值），断言第二次触发审批；
  2. 窗口内 3 次回退产生 2 个审批请求，记录断言 `revert_streak_count` 递增；
  3. 超时窗后再次回退，断言计数已归零、不触发连续回退审批；
  4. 模拟重启后读取 session_meta，断言计数恢复且行为一致；
  5. 纯 git 状态查询断言不改变计数。

### C5 探索类 agent 文档配额

**目标**：探索类（researcher 角色）agent 产出的"文档"（入库的独立文档实体）每会话至多 1 份，且必须由主 agent 分配。

- **触发条件**：researcher 角色的子 agent 请求创建/提交文档（写入文档实体，非普通消息）。
- **行为**：
  1. 会话级配额计数：每会话 `explore_docs_quota`（默认 1，session_meta 键可配）——探索类 agent 最多产出 1 份文档；
  2. 必须主 agent 分配：创建文档的授权令牌（配额凭证）只能由主 agent 在 run 的注入内容中给出；子 agent 无权自我授予；
  3. 超配额：返回结构化错误（含"配额已用尽，请把发现以消息形式回报主 agent"），run 不中断；
  4. 配额计数与消耗记录持久化（session_meta 键：`explore_docs_consumed`，附最近消耗者 run 信息）。
- **边界/例外**：
  - 配额按"会话"计数，不按 run 计数；同一子 agent 多次续跑共享同一配额；
  - 非 researcher 角色的子 agent 不受此配额约束（但受 C6 编排与文件域互斥约束）；
  - 主 agent 自身不消耗此配额。
- **分层归属**：引擎 Rust（配额计数与授权校验）；提示词协议层（凭证格式声明）。
- **对接点**：
  - 配额持久化：`crates/conex-db/src/lib.rs:1204/1223`（session_meta）；
  - 授权注入：与 C2 共用上下文构建入口（`apps/agent-workbench/src-tauri/src/engine.rs:218`）；
  - 角色判定：`packages/shared-types/src/subagent.ts:5`（SubagentRole）。
- **独占写集 / 禁止触碰**：独占配额校验模块（新增）与 session_meta 键 `explore_docs_*`；engine.rs 注入点只读挂载（主体归 C10）；`packages/shared-types/src/subagent.ts` 只读引用。
- **验收标准**：
  1. researcher agent 无凭证创建文档断言被拒，错误信息含配额语义；
  2. 持主 agent 凭证创建 1 份后，第二次创建断言返回"配额已用尽"；
  3. 重启后断言配额消耗数恢复、不可超额；
  4. 非 researcher 角色创建文档断言不受配额限制；
  5. 配额键经 session_meta 调大后行为随之变化。

### C6 主 agent 编排 agent 流（依赖图）

**目标**：主 agent 以依赖图编排子 agent 执行序列，支持 after/parallel 声明、并发上限、失败策略、重启恢复。

- **触发条件**：主 agent 发起编排声明（含依赖图）或续跑一个未完成的编排。
- **行为**：
  1. 依赖图声明：每个子 agent 任务声明 `after: string[]`（前置任务 id 列表）与 `parallel: boolean`（是否允许与同层任务并发）；无 after 且 parallel 的任务可并发启动；
  2. 前置完成才启动后置：仅当前置任务状态为 completed 时才启动依赖它的任务；running/pending/failed 均不启动；
  3. 并发上限：并发运行任务数 ≤ `maxConcurrent`（RecursionGuardConfig，默认 6，`packages/shared-types/src/subagent.ts:36`）；兄弟并发 ≤ `maxSiblings`（默认 5）；
  4. 重启可恢复：编排声明、每任务状态、启动顺序全部落库（session_agents 行 + 编排声明存 session_meta），重启后按图重新推进（结合 C1 恢复）；
  5. 前置 failed 策略可配：`on_failed` ∈ { `abort`（后续不启动）、`skip`（跳过前置、后置照常）、`retry_once`（前置重试一次再判）}，默认 `abort`；策略存 session_meta 键 `flow_on_failed`；
  6. 主 agent 是唯一编排者：子 agent 无权修改依赖图。
- **边界/例外**：
  - 依赖图只推进不回溯：已 completed 的任务不会被再次启动（除非显式 fork 出新 run，见 C7 阶梯 3）；
  - 环检测：声明时做环检测（复用 DeadlockCheckInput 思路，`packages/shared-types/src/subagent.ts:75`），检测到环拒绝声明并返回错误；
  - 并发预算按会话全局计数（含主 agent 自身 run？否——预算只算子 agent run）。
- **分层归属**：引擎 Rust（调度器：依赖图推进、并发记账、状态持久化）；UI React（AgentTeamBoard 展示依赖图，只读展示，不承载逻辑）。
- **对接点**：
  - 会话树与状态：`crates/orchestrator/src/session.rs:187`（SessionTree）、`crates/conex-db/src/lib.rs:327`（session_agents 表）；
  - 并发默认值：`packages/shared-types/src/subagent.ts:36`（DEFAULT_RECURSION_GUARD）；
  - 展示面：`apps/crish-desktop/src/components/agent-card/AgentTeamBoard.tsx:219`。
- **独占写集 / 禁止触碰**：独占 `crates/orchestrator/src/session.rs`（SessionTree 编排推进）、agent-tools 的 run_subagent 注册与 session_agents 落库（本轮 conex-db 唯一写面）、session_meta 键 `flow_on_failed` 与编排声明；C1（read_branch_path）、C7（fork）只读引用冻结接口。
- **验收标准**：
  1. 声明 A→B 依赖，断言 B 在 A completed 前不启动；
  2. 并发启动 10 个 parallel 任务，断言并发峰值 ≤ maxConcurrent；
  3. 前置 failed 且策略 abort：断言后置不启动、编排进入终态（部分完成）；
  4. 前置 failed 且策略 skip：断言后置正常启动；
  5. 含环声明断言被拒绝且不产生任何 run；
  6. 中断后重启，断言未完成的后置任务按图恢复启动、已完成的不会重复启动。

### C7 网络波动恢复阶梯

**目标**：子 agent run 遇网络波动，按四级阶梯逐级恢复，最终不可恢复时留痕并上报用户决策。

- **触发条件**：子 agent run 的 provider 流出现网络类错误（rate-limit / 5xx / 网络 / 超时——对齐 `crates/agent-provider/src/retry.rs` 的瞬态类分类）。
- **行为**：
  1. **阶梯 1：自动重试（引擎内）**。复用 `crates/agent-provider/src/retry.rs` 指数退避（默认 750ms 起、8s 封顶、总预算 60s）在引擎内重试，重试不改变 run 语义、不计入 run 失败；
  2. **阶梯 2：主 agent 介入（软注入）**。重试预算耗尽后，经 PendingMessageQueue（`crates/orchestrator/src/steering_queue.rs:111`）写入 steering 条目通知主 agent（内容：哪个 run、已重试次数、剩余状态）；主 agent 经 L1 steer 环（`crates/session-loop/src/control.rs` 的 steer 注入、`crates/session-loop/src/safe_point.rs` 安全点）注入激活指令（继续等待 / 降低要求 / 取消）；
  3. **阶梯 3：重分配或 fork**。主 agent 决定不等待时，基于 `SessionTree.fork`（`crates/orchestrator/src/session.rs:239`）+ `session_agents.subagent_path_json` 记录工作流重试：fork 出新分支承接同一目标，新 run 写入 fork 分支；原 run 状态置 failed 并留事件；此后按 C6 重新调度（受并发预算约束）；
  4. **阶梯 4：上报用户**。阶梯 3 后仍失败的，如实上报"卡在哪一步、试过什么（各阶梯尝试记录）、建议怎么办"，连同全部留痕交用户决策（与 05 手册第 5 节第 4 级语义一致）。
- **边界/例外**：
  - 阶梯 1 只处理瞬态类错误；auth / quota / context_length 等不进入本阶梯（与 retry.rs 语义一致，context_length 由 C9 压缩处理）；
  - 流已产出内容后的中途错误不重试（对齐 retry.rs 既有规则），直接进阶梯 2；
  - 阶梯 2 的通知必须落库（pending 条目），重启后主 agent 仍可见；
  - 阶梯 3 的 fork 粒度默认"整 run 目标"，细粒度 fork 列入开放问题；
  - 阶梯 4 上报前必须保留全部重试与重分配留痕（events 表），作为用户决策依据。
- **分层归属**：引擎 Rust（阶梯 1 复用 retry.rs；阶梯 2 写 steering 条目；阶梯 3 调 SessionTree.fork + 落库；阶梯 4 生成上报事件）。
- **对接点**：
  - 重试：`crates/agent-provider/src/retry.rs`（RetryPolicy / provider_stream）；
  - 通知：`crates/orchestrator/src/steering_queue.rs:111`（PendingMessageQueue）；
  - 注入：`crates/session-loop/src/control.rs`（L1 steer / follow_up）、`crates/session-loop/src/safe_point.rs`；
  - fork：`crates/orchestrator/src/session.rs:239`；路径持久化：`crates/conex-db/src/lib.rs:338`（subagent_path_json）。
- **独占写集 / 禁止触碰**：独占 `crates/orchestrator/src/steering_queue.rs` 写入侧与阶梯 3 fork 记录逻辑（经 session.rs 冻结接口）；`crates/agent-provider/src/retry.rs` 既有模块只读复用；`crates/session-loop/src/control.rs`（归 C8）与 `crates/orchestrator/src/session.rs`（归 C6）只读。
- **验收标准**：
  1. 注入 2 次瞬态错误，断言阶梯 1 内自动恢复、无 steering 条目产生；
  2. 重试预算耗尽，断言产生 steering 条目且主 agent 可读取；
  3. 主 agent 注入"继续等待"后断言 run 恢复执行；
  4. 主 agent 触发重分配，断言 fork 出新 run、subagent_path_json 记录路径、原 run 状态 failed、events 有留痕；
  5. 重启后断言未处理的阶梯 2 通知仍在队列；
  6. 阶梯 3 后仍失败，断言 run 状态 failed、留痕完整、产生用户可见的上报事件（阶梯 4）。

### C8 分发后调度模式

**目标**：主 agent 分发任务后，以三种模式之一调度等待与注入，执行期可干预不打断流。

- **触发条件**：主 agent 启动一次分发（一次发出多个子 agent run），选择调度模式。
- **行为**：
  1. 三模式：
     - `await-all`：主 agent 等待全部已发子 agent 到达终态（completed/failed）后再规划下一步；期间收到任何子 agent 事件只记录、不打断；
     - `timer`：等待固定时间窗（`dispatch_wait_ms`，默认 30s，可配）后唤醒主 agent 规划，未完成的任务保持运行；
     - `parallel-work`：主 agent 分发后立即转入自己的并行工作（不空等），子 agent 事件经 L1 注入带回；
  2. 执行期可注入不打断流：三种模式下，任何子 agent 事件 / steering 通知都经 L1 软注入（steer 环）回到主 agent，不触发 L2/L3；
  3. `await-all` 语义：主 agent 在收到全部终态事件前不发起新一轮规划（后续规划内容由主 agent 自行决定）；
  4. 模式选择与模式上下文落库（session_meta 键：`dispatch_mode` / `dispatch_wait_ms`），重启恢复。
- **边界/例外**：
  - 三种模式都是主 agent 视角的等待策略，不改变子 agent 自身调度（C6 依赖图）与并发预算；
  - L3 强停任何时刻可打断主 agent 等待（控制总线优先）；
  - 事件注入只带摘要（事件类型 + run 状态 + 简述），不全量回放。
- **分层归属**：引擎 Rust（模式状态机与注入通道）；提示词协议层（模式声明与等待语义）。
- **对接点**：
  - 注入通道：`crates/session-loop/src/control.rs`（L1）、`crates/session-loop/src/stream.rs`（事件流）；
  - 事件信封：`apps/crish-desktop/src/api/chat-bridge/EventRouter.ts:475/488/500`（前端已接，Rust 需对齐同一信封产出）；
  - 等待状态持久化：`crates/conex-db/src/lib.rs:1204/1223`（session_meta）。
- **独占写集 / 禁止触碰**：独占 `crates/session-loop/src/control.rs`（L1 steer 注入通道）、模式状态机（新增模块）、session_meta 键 `dispatch_*`；PendingMessageQueue 读取只读（写入侧归 C7）；前端 EventRouter 只读对齐信封（`apps/crish-desktop/src/api/chat-bridge/EventRouter.ts:475/488/500`）。
- **验收标准**：
  1. await-all 下断言主 agent 在全部终态事件到达前不发起下一轮规划；
  2. timer 模式断言到时唤醒，未完成 run 保持 running；
  3. parallel-work 模式断言分发后主 agent 立即恢复执行自身工作；
  4. 等待期间注入 L1 消息断言不打断任何 run（无 L2/L3 事件）；
  5. 重启后断言模式与剩余等待语义恢复。

### C9 AI 压缩摘要

**目标**：上下文超预算时，由 AI 生成结构化压缩摘要替代占位符；生成失败降级为占位符；system 消息永不参与压缩。

- **触发条件**：上下文 token 估算超过预算（对齐 `crates/conex-compaction/src/lib.rs` 的 max_tokens 触发判断；阈值默认 85% 预算水位线，可配，session_meta 键 `compact_threshold_ratio`）。
- **行为**：
  1. 默认 AI 写压缩文档：触发压缩时调用 AI 生成结构化摘要（固定模板，见下），替换被压缩段落的 `[Compacted N...]` 占位符；
  2. max_tokens 可配：摘要产出上限 `compact_summary_max_tokens`（默认 1500，可配），超限截断（截断发生在段落边界）；
  3. 格式化压缩模板（固定结构，不得省略字段）：
     ```
     ## 压缩摘要
     - 任务目标：<本轮/子任务目标一句话>
     - 已完成：<要点列表，每条 ≤ 30 字>
     - 待办：<要点列表>
     - 关键决策：<决策点与理由，每条 ≤ 50 字>
     - 文件清单：<涉及文件路径列表>
     ```
  4. 生成失败回退占位符：AI 调用失败（超时 / 预算 / provider 错误）时回退为既有 `[Compacted N...]` 占位符，不阻塞会话循环，事件记录降级事实；
  5. system 消息永不参与压缩：压缩只作用于非 system 段；system 段的完整性由 C10 另行保障。
- **边界/例外**：
  - 压缩不删除数据：被压缩段落仅从发送给 provider 的请求中省略，原始消息保留在 events / session_messages 库中；
  - 每次压缩事件落库（events 表，payload 含压缩范围、摘要、是否降级）；
  - 压缩摘要本身不再被压缩（防递归）。
- **分层归属**：引擎 Rust（触发、调用、模板落库）；提示词协议层（模板格式）。
- **对接点**：
  - 触发与算法骨架：`crates/conex-compaction/src/lib.rs`（CompactionEngine::compact）；
  - 触发点：`crates/session-loop/src/loop/handlers/prepare_turn.rs`（上下文构建前）与 provider 请求构建处（`apps/agent-workbench/src-tauri/src/engine.rs:218`）；
  - 事件落库：`crates/conex-db/src/lib.rs`（append_event）。
- **独占写集 / 禁止触碰**：独占 `crates/conex-compaction/src/lib.rs`（压缩算法与模板落库）与 session_meta 键 `compact_*`；events 表只读（走既有 append_event 接口）；engine.rs 触发点经 C10 冻结的构建入口挂载。
- **验收标准**：
  1. 注入超预算上下文，断言产出结构化摘要且含五个固定字段；
  2. 断言被压缩段落的原始消息仍可从库中读取；
  3. 模拟摘要生成失败，断言回退占位符、循环不中断、事件记录降级；
  4. 断言 system 角色消息在任何压缩路径下完整保留；
  5. 修改 max_tokens 与阈值键后断言触发行为随之变化。

### C10 系统上下文重注入

**目标**：MCP / skill / agent 定义在每次上下文构建时以"压缩后内容"重新注入，独立于压缩预算；禁用后不注入。

- **触发条件**：每次上下文构建（任何 run 的 prepare_turn / build_context，恒成立，除非全局禁用）。
- **行为**：
  1. 重注入：MCP 工具集、skill 内容、agent 定义在每次上下文构建时重新读取并注入，注入内容为"压缩后"版本（经 C9 同款摘要流程产出的精简形态），不与会话历史共享压缩预算；
  2. 独立性：系统段（system 角色）的字节级一致——同一配置两次构建，system 段字节完全相同（可断言）；压缩不触碰 system 段（C9 第 5 条），故 C10 直接依赖 C9 的隔离保证；
  3. 禁用开关：`system_reinject_enabled`（session_meta 键，默认 true）为 false 时不注入系统上下文（除 C2 的 started_at 等必要字段外），用于排查与省 token 场景；
  4. 注入顺序固定：agent 定义 → skill → MCP 工具声明 → 会话相关注入（started_at 等），顺序变化视为协议变更（快照断言）。
- **边界/例外**：
  - 系统段字节级一致不包含动态字段（时间戳类）——动态字段必须显式标记为 `@dynamic`，不在一致性断言范围内；
  - 注入体积设上限（`system_reinject_max_bytes`，默认 32KB，可配），超限部分按优先级截断（agent 定义 > skill > MCP）；
  - 禁用开关只影响注入动作，不影响 C2 started_at 等必需字段的注入。
- **分层归属**：引擎 Rust（重注入与字节一致性）；提示词协议层（注入结构声明）。
- **对接点**：
  - 构建入口：`apps/agent-workbench/src-tauri/src/engine.rs:218-233`（build_context，system_prompt 现为 None，C10 在此实装）；
  - MCP 桥：`crates/agent-tools/src/mcp/bridge.rs`（工具集读取）；
  - skill 读取：`apps/agent-workbench/src-tauri/src/fs_commands/skills.rs`（既有读取面）。
- **独占写集 / 禁止触碰**：独占 `apps/agent-workbench/src-tauri/src/engine.rs` 的 build_context（注入顺序冻结、重注入、禁用开关）与 `crates/agent-tools/src/mcp/bridge.rs`、`fs_commands/skills.rs` 注入读取面；C1/C2/C5 只读经注入点挂载；session_meta 键 `system_reinject_*`。
- **验收标准**：
  1. 两次构建断言 system 段字节一致（相等比较）；
  2. 修改 skill 内容后断言下次构建 system 段随之变化；
  3. 修改 skill 内容后断言历史消息（会话段）不变化；
  4. 禁用开关置 false 断言不注入系统上下文（除必需字段）；
  5. 注入内容超上限断言按优先级截断且记录截断事件。

## 3. 依赖关系图

```
C10（系统上下文重注入）──支撑──▶ C2（started_at 注入与回退指引）
   │                                C2 ──触发──▶ C3（大面积回退审批）
   │                                             │
   │                                             ▼
   │                                          C4（连续回退计数，叠加于 C3）
   │
   │──支撑──▶ C1（checkpoint 优先恢复：检查点注入与恢复走同一上下文通道）
   │                                             │
   C9（AI 压缩摘要，C10 的压缩后注入依赖 C9 模板）  │
   │                                             ▼
   C9 与 C10 必须同轮设计（C9 产出压缩格式，C10 消费压缩后系统段）
   │                                          C7 阶梯 3（重分配/fork）复用 C1 的恢复判定
   │
   C6（依赖图编排） ◀─── 同调度核心 ───▶ C8（分发后调度模式）
   │                       │
   │                       └── C7 阶梯 2（主 agent 介入）依赖 C8 的 L1 注入通道
   │
   C7 阶梯 1（自动重试）复用 agent-provider/retry.rs，独立于上述链条
   │
   C5（探索类文档配额）独立，仅依赖注入通道（C10 提供）与 session_meta 持久化
```

**依赖要点**：
- C9/C10 必须同轮设计：C10 的"压缩后系统段"格式由 C9 的模板决定，二者拆分轮次会破坏字节级一致断言；
- C3 是 C4 的前提（C4 叠加在 C3 的审批通道上）；
- C6 与 C8 共享调度核心（依赖图推进 + 等待模式），分轮实现会重复造调度状态机；
- C7 阶梯 2 依赖 C8 的注入通道（L1 steer 环），阶梯 3 依赖 C1 的恢复判定与 SessionTree.fork；
- C1/C2/C10 共享上下文构建入口（engine.rs build_context），实现顺序上必须先立该入口（先 Tool Context）。

## 4. 实现顺序建议

按逻辑执行顺序排列，与主修复方案各轮次衔接（第 7 轮内部再分子步，仍是"先地基后功能"）：

| 步 | 内容 | 对应能力 | 理由与衔接 |
| --- | --- | --- | --- |
| 1 | **Tool Context 先行**：system_prompt 注入通道实装（engine.rs:220 由 None 变为可注入），同时冻结注入顺序（C10 第 4 条） | C10、C2、C1 的公共地基 | 所有提示词层能力都走这个口，先立口再谈内容 |
| 2 | **权限引擎**：ApprovalGate 扩展 + CommandPolicy 兜底 + 配置面（阈值键） | C3、C4 | 回退安全是运行期风险面，先于调度功能落地 |
| 3 | **run_subagent 工具**：注册进 agent-tools（8 工具变 9+），接 session_agents 落库与状态机 | C6 的前置、C7 阶梯 3 的载体 | 没有 spawn 入口，编排与恢复无从谈起 |
| 4 | **事件契约**：Rust 侧发射 subagent-started/event/ended，信封对齐 EventRouter.ts:475/488/500 | C8、C6 | 前端已消费，Rust 产出补齐即接通；为调度器提供反馈通道 |
| 5 | **调度器**：依赖图推进（C6）+ 三模式等待（C8）+ 恢复（C1 接线） | C6、C8、C1 | 依赖第 3、4 步的 run 与事件 |
| 6 | **恢复与重试**：C7 阶梯 1-4（复用 retry.rs 与 SessionTree.fork） | C7 | 依赖调度器就位后才能"重分配" |
| 7 | **压缩与配额**：C9（AI 摘要 + 模板 + 降级）、C10 强化（压缩后系统段一致性）、C5（文档配额） | C9、C10、C5 | 压缩与配额是优化与治理面，放最后，不阻塞调度主链路 |

衔接说明：
- 主修复方案的第 7 轮（Agent 功能实现）以"可运行的多 Agent 调度能力"为验收，本顺序的第 5 步完成即达主方案第 7 轮验收；第 6、7 步为增强项，可在第 7 轮内并行推进或顺延至下一轮。
- 每步完成都必须跑对应验收断言（第 2 节各能力验收标准），并过治理门禁（构建 / lint / typecheck / 测试）。

**第 7 轮并行实现文件域互斥建议**：若第 7 轮内多 Agent 并行实现各能力，按各能力「独占写集 / 禁止触碰」声明划分文件域，关键共用点硬性约定：

- `crates/session-loop/src/tool_events.rs`、`tool_exec.rs`（审批判定与注入路径）：**C3 独占**；C4 只读经 C3 提供的判定钩子挂载，不并写文件主体；
- `crates/orchestrator/src/session.rs`（SessionTree）：**C6 独占**；C1（read_branch_path）、C7（fork）只读引用冻结接口；
- `crates/orchestrator/src/restore.rs`：**C1 独占**；C6/C7 只读；
- engine.rs 上下文构建（build_context）：**C10 独占**（注入顺序冻结、重注入、禁用开关）；C1/C2/C5 只读经注入点挂载；
- `session_meta` 读写走既有封装：**各能力独占自己声明的键命名空间**（C4: `revert_*`、C5: `explore_docs_*`、C6: `flow_on_failed`/编排声明、C8: `dispatch_*`、C9: `compact_*`、C10: `system_reinject_*`）；
- conex-db 表结构（session_agents / session_agent_messages / session_meta / events）：本轮**只读**，**C6 为唯一写面**（新增表/列先登记 C6 统一落盘）；
- `crates/orchestrator/src/steering_queue.rs`：**C7 独占写入**、C8 只读消费；`crates/session-loop/src/control.rs`（L1 steer 环）：**C8 独占**、C7 经其通道注入；
- `crates/conex-compaction/src/lib.rs`：**C9 独占**；`crates/agent-provider/src/retry.rs`：既有冻结模块，C7 只读复用。

### 4.1 第 7 轮验收命令清单

全量门禁（各能力合入前必跑，第 7 轮收尾统一复跑）：

```powershell
cargo test -p session-loop -p orchestrator -p agent-tools -p conex-db
npm run typecheck
npm run test:desktop-helpers
npx knip
```

各能力关键测试（对应第 2 节各能力验收标准，实现/回归时按能力定位执行）：

| 能力 | 关键测试名 | 断言要点 |
| --- | --- | --- |
| C1 | checkpoint 恢复测试 | 续跑注入检查点摘要、损坏检查点降级不 panic、subagent_run_id 不变、无 system 消息 |
| C2 | started_at 注入测试 | 系统提示词含 started_at 且等于库内 session_agents.started_at；续跑不刷新 |
| C3 | shell 危险命令产生 approval 事件测试（含大面积回退超阈值） | 超阈值回退/危险命令工具不执行、产生 approval 事件、审批人=用户裁决 |
| C4 | 连续回退计数测试 | 第二次小额回退必审批、时窗归零、重启恢复计数 |
| C5 | 探索类文档配额测试 | 无凭证拒绝、二次创建超配额、重启不超额 |
| C6 | 依赖图调度测试 | 前置完成后置启动、并发峰值 ≤ maxConcurrent、环拒绝、重启恢复 |
| C7 | 恢复阶梯测试 | 瞬态错误自动重试（750ms/8s/60s 预算）、steering 通知、fork 留痕、阶梯 4 上报用户 |
| C8 | 调度模式测试 | await-all 不提前规划、timer 到时唤醒、parallel-work 立即返回 |
| C9 | 压缩摘要测试 | 五字段模板、降级占位符、system 段不参与压缩 |
| C10 | 系统上下文重注入测试 | system 段字节级一致、禁用开关生效、注入上限截断 |

## 5. 开放问题清单

| 编号 | 问题 | 现状 | 建议裁决时点 |
| --- | --- | --- | --- |
| Q1 | 阈值定义归属：C3 的 revert 阈值与 C9 的压缩阈值，最终落在配置面（BuiltinToolConfig / 全局配置）还是 session_meta？ | 本文暂定两者均可覆盖（默认值在配置面、运行时覆盖走 session_meta），需统一裁决避免双权威 | 第 2 步（权限引擎）动手前 |
| Q2 | C5 配额计数域：按会话计数（本文）还是按"会话 + agent 定义"组合计数？探索类 agent 重定义后旧配额是否保留？ | 暂定会话级；agent 定义变更时配额跟随会话保留 | 第 7 步（配额实现）动手前 |
| Q3 | C6 依赖图存储位置：编入 session_meta 单键（KV 序列化）还是新建独立表？依赖图达到什么规模需要独立表？ | 暂定 session_meta 单键 JSON；若单次编排任务数预计 > 20 则应建表 | 第 5 步（调度器）动手前 |
| Q4 | C7 阶梯 3 fork 粒度：整 run 目标（本文）还是可指定"目标内子目标"细粒度 fork？细粒度需 subagent_path_json 扩展 schema | 暂定整 run 目标，细粒度推迟 | 第 6 步（恢复与重试）实现后评估 |
| Q5 | C9 AI 摘要调用方：摘要由引擎内部经 agent-provider 调用（复用同一 provider 配置）还是由主 agent 以子 run 形式生成？ | 暂定引擎内部调用，独立小预算；若 provider 并发受限则改主 agent 通道 | 第 7 步（压缩实现）动手前 |
| Q6 | C10 注入体积上限：默认 32KB 是否合适？MCP 工具集超限时截断优先级（agent 定义 > skill > MCP）是否可接受？ | 暂定 32KB + 上述优先级；需实测典型 skill 体积校准 | 第 1 步（Tool Context）实现后校准 |
| Q7 | 压缩触发时机：prepare_turn 前估算与 provider 返回 context_length 错误时的二次触发，两个触发点的水位线是否应不同？ | 暂定同一水位线；若二次触发频繁则拆双水位线 | 第 7 步（压缩实现）后评估 |
| Q8 | 连续回退计数（C4）跨会话还是仅本会话？fork 出的子分支是否继承父分支计数？ | 暂定仅本会话、fork 不继承；若出现"换会话绕过"则需会话族共享计数 | 第 2 步（权限引擎）验收后评估 |
