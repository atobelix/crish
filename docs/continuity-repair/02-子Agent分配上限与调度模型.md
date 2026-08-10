# 02-子Agent分配上限与调度模型

> 分析域：子 agent 调度与上限（上限 / 并发 / 失败处理 / 自动恢复）
> 分析日期：2026-08-10（代码基线：当前仓库 HEAD）
> 分析方式：只读代码勘察，所有断言均附 文件:行号 证据

---

## 1. 结论先行

1. **「一轮最多 12 个子 Agent」在代码里不是「每轮累计派发 12 个」，而是「全会话未终态（running）子代理并发上限 12」**。真正的硬限制是 `DEFAULT_RECURSION_GUARD`：`max_depth=1 / max_siblings=5 / max_concurrent=12`（`crates/agent-tools/src/tools/subagent.rs:497-501`）。前序子代理完成后，同一轮仍可继续派发新子代理——累计可超过 12。文档口径与代码语义存在偏差，建议统一表述为「同时运行的子代理 ≤ 12（同父 ≤ 5）」。

2. **嵌套守卫（depth 1 强制）是双层实现**：工具面剔除 `run_subagent`（`subagent.rs:653-659`）+ 守卫层 `check_recursion_guard` 的 `NestingDenied`（`subagent.rs:593-598`），错误码 `subagent.nesting_denied`，文案「你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配」（`subagent.rs:555-557`）。深度按 parent_run_id 链计算（主 run=0、直接子代理=1，`apps/agent-workbench/src-tauri/src/subagent_spawner.rs:746-753`），并有 O(depth) 祖先链死锁检查（`subagent.rs:632-639`）。

3. **子代理是并行执行的**（每个子代理独立会话 + 独立 run 并发驱动；批量 `tasks` 派发为「无依赖平铺并行」）；主 agent 等待用 `wait_subagents` 三模式：`await-all`（等全部终态）/ `timer`（30s 默认到点返回，未完成保持运行）/ `parallel-work`（立即快照），超时硬上限 10 分钟（`wait_subagents.rs:46-85`）。

4. **网络中断目前只有「run 内自动重试 ≤3 次」这一层自动恢复**：瞬态 provider 错误（RateLimit/ServerError/Timeout/Network）在会话循环内重试 3 次（`session-loop/src/loop/handlers/stream_error.rs:62-95`，`loop/mod.rs:157,281`），重试耗尽后 run 以 failed 收场。**四级恢复阶梯（C7，recovery.rs）代码完整但生产未接线**（`recovery.rs:57-62` 明示 F2-08 遗留：生产二进制不触发阶梯 1/2），`resume_subagent` 命令面同样未接 IPC（`lifecycle_service()` 仅测试消费，`core_run_commands.rs:2107-2120`）。

5. **结论：子 agent 因网络中断时，当前系统不能让它「继续工作」**。它会：run 内重试 3 次 → failed → 释放并发记账 → 发 `subagent-ended`（Critical 必达落库）→ feed wait 通道 → 向主 agent steering 队列写入唤醒通知。主 agent 被通知后可**手动**重新 `run_subagent` 派发新任务，但没有自动重跑 / 自动续跑 / checkpoint；重启后子代理 run 一律中断归一 failed（`restore.rs:5-28`）。缺口集中在「C7 恢复阶梯接线」「resume/kill_all 命令面接 IPC」「wait 声明持久化真适配」「无 checkpoint」四处。

---

## 2. 现状事实（文件:行号证据）

### 2.1 上限与嵌套守卫

| 事实 | 证据 |
| :--- | :--- |
| 权威默认守卫：maxDepth=1 / maxSiblings=5 / maxConcurrent=12 | `crates/agent-tools/src/tools/subagent.rs:497-501`（`DEFAULT_RECURSION_GUARD`，注释：maxDepth=1 是「仅主 Agent 可派发」的最终防线，REQ-D08 kill 项；maxConcurrent=12 为 T-D-06 上限 12 对齐终态） |
| maxConcurrent 语义 = 全会话未终态子代理 run 数（预算只算子代理） | `subagent.rs:485-486` |
| 判定顺序：嵌套禁止 → 深度 → 兄弟 → 并发，全过才 Ok | `subagent.rs:589-618`（`check_recursion_guard`）；min=1 且 depth>1 优先命中 NestingDenied（593-598） |
| 拒绝结构错误码：depth/siblings/concurrent 复用 `subagent.depth_exceeded`；嵌套专用 `subagent.nesting_denied`；死锁专用 `subagent.deadlock_detected` | `subagent.rs:533-545` |
| NestingDenied 文案（含「所有子 Agent 由主 Agent 分配」指引） | `subagent.rs:555-557` |
| 工具面防护：子代理注册表剔除 run_subagent（防浪费非安全边界，安全边界在守卫层） | `subagent.rs:644-659`（`filter_out_subagent_spawner`，`SUBAGENT_SPAWNER_TOOL_NAME="run_subagent"`） |
| 祖先链死锁检查（目标会话已在祖先链上 → 拒绝，防循环 fork），O(depth) | `subagent.rs:620-639`（`check_ancestor_chain` / `DeadlockCheckInput`） |
| 引擎侧快照采集（单发）：depth=父 run 深度+1；兄弟=父 run 未终态计数；并发=全局原子计数 | `apps/agent-workbench/src-tauri/src/subagent_spawner.rs:743-764`（`spawn`） |
| 批量前瞻统一守卫（原子语义）：siblings/concurrent 按 N 预加后一次判定，任一拒绝 → 整体失败零 run | `subagent_spawner.rs:786-825`（`spawn_many`；契约语义见 `subagent.rs:789-812`） |
| 记账分配/释放：spawn 时 +1（`subagent_spawner.rs:393-424`），终态释放（`subagent_spawner.rs:506-526`） | 记账结构 `subagent_spawner.rs:107-137`（active_siblings / active_concurrent / run_depths / parents / flow_nodes） |
| 流式调度器（flow_graph）复用同一守卫做并发预算：快照 depth 恒 1、siblings=concurrent=在途数，预算满即等下一终态事件 | `crates/orchestrator/src/flow_graph.rs:997-1019`（T-D-01：流程节点是主 Agent 直接子节点，不受嵌套禁令影响） |
| 可配位：flow_max_concurrent / flow_max_siblings session_meta 键覆盖默认值 | `flow_graph.rs:689-693, 736-744` |
| 子代理状态机（TS 4 态）：pending(内存态) / running / completed / failed；落库首写即 running，被终止 run 归一 failed（写面不产生 stopped） | `subagent.rs:418-466`（`to_db_status` / `from_db_status`；DB CHECK 集 `running/completed/failed/stopped`，`subagent.rs:468-474`） |

### 2.2 并发执行与 wait_subagents 三模式

| 事实 | 证据 |
| :--- | :--- |
| 子代理 = 独立会话 + 独立 run（parent_id 链），经 `SubagentRunLauncher::launch` → `run_task_impl` 同通道启动，与主 agent run 并发驱动 | `subagent_spawner.rs:88-95, 349-375`（`RunTaskOptions` 携带 subagent_config + parent_run_id） |
| 单发/批量互斥：prompt 与 tasks 二选一（防歧义）；tasks 批量 = 一次创建 N 个并行子代理 | `subagent.rs:1143-1156, 918-954`（schema），`execute_many` 965-1048 |
| 批量原子语义由引擎 spawn_many 承担（前瞻守卫 + 逐条落库启动）；启动失败（非守卫）为灾难性路径，行归一 failed 兜底 | `subagent_spawner.rs:776-825`，`spawn_unchecked` 失败路径 376-391 |
| wait_subagents 三模式（yield 语义：单次返回、主 agent 串起后续行动，不阻塞引擎循环） | `crates/agent-tools/src/tools/wait_subagents.rs:46-58`（AwaitAll / Timer / ParallelWork 注释语义） |
| timeout 硬上限 10 分钟（600000ms，超限参数报错）；timer 默认 30s；timeoutMs=0 强制非阻塞快照 | `wait_subagents.rs:82, 85, 657-673` |
| 事件驱动等待：消费 subagent-ended 事件流（mpsc），重复事件幂等、名单外忽略、事件流关闭 fail-open、超时 timed_out（未完成保持 running 返回） | `wait_subagents.rs:378-459`（`wait_for_terminal_events`） |
| 调度声明持久化（dispatch_mode / dispatch_wait_ms / dispatch_agents / dispatch_dispatched_at / dispatch_outputs，session_meta 键），重启可恢复「等待什么」与剩余等待 | `wait_subagents.rs:89-99, 277-353`（`DispatchDeclaration::to_meta_pairs` / `from_meta_pairs`） |
| 终态产出收集：write_claims 持有者记录 → outputFiles（path/summary/bytes），引擎强制不依赖 AI 自觉 | `wait_subagents.rs:145-186, 746-766` |
| 等待期间可注入（inject：L1 steer 环投递，不打断子代理执行） | `wait_subagents.rs:600-607, 674-694, 717-723` |
| 子代理 run 收口**不参与** idle 待命续 run（一次性任务，防自续循环）；steering 条目留在队列由主 agent 会话收口消费 | `apps/agent-workbench/src-tauri/src/core_run_commands.rs:2861-2872` |
| 等待通道生产实现（Workbench `WaitChannel`）：内存 MemoryWaitStore（conex-db 真适配登记遗留）、EventStreamBroadcast、NoopControlBusResolver（inject 生产未接线 → 结构化 InjectFailed） | `apps/agent-workbench/src-tauri/src/wait_channel.rs:1-37, 104-115, 25-32` |

### 2.3 run 生命周期终态机与失败记录

| 事实 | 证据 |
| :--- | :--- |
| run 状态机 9 态：queued → initializing → running → awaiting-approval → cancelling → completed/failed/cancelled；终态拒绝再转移；Unknown 为死态 | `crates/orchestrator/src/run.rs:113-188`（转移表 138-187；is_terminal 130-135） |
| 终态映射单一权威：stop→completed / max-turns→failed / aborted→cancelled / error→failed；已取消一律 cancelled | `run.rs:613-648`（`map_agent_end_to_terminal` / `map_outcome_to_terminal`；max-turns=failed 为 D1 裁决） |
| 失败转移链：running/awaiting-approval/cancelling → RuntimeError → failed | `run.rs:588-599`（`terminal_path`） |
| 引擎内瞬态重试阶梯（生产已接线）：RateLimit/ServerError/Timeout/Network → `transient_retry` 重进 provider 循环，上限 `transient_retry_limit=3`（默认） | `crates/session-loop/src/loop/handlers/stream_error.rs:1-15, 47-95`；`crates/session-loop/src/loop/mod.rs:157, 281` |
| 流已产出内容后中途错误不重试（重试会重复已流出内容）；不可重试错误 → fatal_provider_error → run 以 error 收场 | `stream_error.rs:75-77, 81-95`；分类语义 `crates/agent-provider/src/retry.rs:151-159`（is_transient 集）、`retry.rs:325-336`（produced_content） |
| 子代理 run 终态统一收口：drive_run_loop 收口 / finalize_failed 失败路径 → `on_subagent_run_terminal` → `SubagentSpawnerImpl::on_subagent_terminal` | `core_run_commands.rs:2844-2852, 3066-3073, 2087-2101`；`subagent_spawner.rs:486-660` |
| on_subagent_terminal 五步：1) 记账释放 2) 行终态更新（status/ended_at/summary，产出保留）3) `subagent-ended` 发射（Critical 必达落库）4) wait 通道 feed 5) steering 通知（主 agent 下一 run 唤醒） | `subagent_spawner.rs:506-512, 528-569, 571-612, 614-622, 626-651` |
| subagent-ended 信封：subagentId / subagentRunId / status（completed|failed）/ summary / endedAt；背压 Critical（EventQueue 落库不丢） | `crates/orchestrator/src/subagent_events.rs:84-96, 153-162, 207-217, 336-366` |
| steering 条目 `subagent-terminal-<run_id>` 入 PendingMessageQueue，主 agent 收口经 decide_idle_resume 自动续 run 消费 | `subagent_spawner.rs:626-651`；`core_run_commands.rs:2861-2872, 2505`（decide_idle_resume） |
| watchdog 兜底：存在 dispatch 声明且 10 分钟无任何事件唤醒 → 兜底 steering 条目提醒主 agent（REQ-C05） | `apps/agent-workbench/src-tauri/src/watchdog.rs:1-16, 39-44`（默认 N=10 分钟对齐 MAX_WAIT_TIMEOUT_MS） |
| 子代理终态事件到达壳层即 mark_wakeup（长等待中防 watchdog 误报） | `core_run_commands.rs:2092-2095` |
| 重启恢复：in-flight run（queued/initializing/running/awaiting-approval/cancelling/completing）→ 终态 interrupted（failed，reason=daemon-restarted，审计事件 run-interrupted）；session_agents 残留 running 行 kill_all 语义归一 failed（P1-3） | `crates/orchestrator/src/restore.rs:5-28, 48-55` |

### 2.4 自动重跑 / 续跑 / 恢复现状

| 事实 | 证据 |
| :--- | :--- |
| C7 四级恢复阶梯已实现：阶梯 1 引擎内自动重试（镜像 retry.rs 分类与退避 750ms 起/8s 封顶/60s 预算）→ 阶梯 2 主 agent 激活（steering + `recover_notifications` 落库）→ 阶梯 3 fork 重派（SessionTree::fork + 三态上下文继承 Verbatim/Summarized/New，24h 窗口 + 80% 占比守卫）→ 阶梯 4 上报用户（`recover_needs_user`） | `crates/orchestrator/src/recovery.rs:7-31, 113-243`（`ladder1_decision` 205-243）、`391-394`（FORK_WINDOW_MS / FORK_VERBATIM_MAX_RATIO）、`341-375`（通知与文案） |
| 恢复预算制：操作指纹（subagent_id+任务哈希 FNV-1a）+ Episode 预算（每会话每指纹默认 3 次，`recover_max_episodes` 可配，`recover_episodes` 落库），超预算禁止自动恢复直接阶梯 4 | `recovery.rs:33-37, 251-336` |
| **C7 生产未接线（最关键事实）**：`recovery.rs:57-62` 明示——「上述引擎侧接线点当前无调用方——子代理 run 失败时生产二进制不触发阶梯 1/2（仅 tests 与 lifecycle resume 命令面消费）。接线需引擎侧基础设施：每会话 RecoveryCoordinator 生命周期 + provider 流错误分类钩子，且按 F2-27 走 spawn_blocking。属 I6 遗留 L1–L3 大件」 | `recovery.rs:57-62`；生产代码（apps/agent-workbench）中**零** RecoveryCoordinator 引用（全仓 grep 仅命中注释与测试） |
| 显式恢复命令 `resume_subagent`：原 run 置 failed → `fork_and_reassign` fork 新 run（同样三态上下文继承 + Episode 预算 + 幂等：同指纹已 fork 不重复 spawn） | `crates/orchestrator/src/lifecycle.rs:1-17, 226-303`（`resume`）、`77-88`（ResumeOutcome::Forked/NeedsUser） |
| `kill_all`（批量 L3 强停 running 子代理，行归一 failed，无递归） | `lifecycle.rs:149-224` |
| **命令面未接 IPC**：`core_run_commands.rs:2107-2120` 的 `lifecycle_service()` 仅测试消费（881-8939 测试域），无任何命令/IPC 面调用 | `core_run_commands.rs:2103`（注释 T-D-12 命令面消费）、`8891`（测试）；生产命令面 grep 无命中 |
| 无 checkpoint：子代理状态机无任何「暂停/可恢复」中间态；「续跑」语义 = fork 新 run（同一 subagent_run_id 续跑不变是 C1 约束，但失败后系统不会自动续） | `subagent.rs:418-466`；`subagent_events.rs:55`（「同一 run 续跑不变，C1 硬约束」） |
| wait 声明持久化仅内存实现（MemoryWaitStore），跨重启不恢复；conex-db 真适配登记遗留 | `wait_channel.rs:104-115, 22-23` |

---

## 3. 三张能力表

### 表 1：上限 / 嵌套守卫能力

| 能力 | 值 | 实现 | 状态 |
| :--- | :--- | :--- | :--- |
| 嵌套深度上限 | maxDepth=1（仅主 Agent 可派发） | `subagent.rs:497-501, 593-598` | 已接线（生产 spawner 快照采集 `subagent_spawner.rs:743-764`） |
| 嵌套拒绝结构化错误 | `subagent.nesting_denied` + 指引文案 | `subagent.rs:542-543, 555-557`；引擎映射 `subagent_spawner.rs:267-274` | 已接线 |
| 工具面防护 | 子代理工具注册表剔除 run_subagent | `subagent.rs:653-659` | 已接线（引擎侧按发起者装配） |
| 祖先链死锁检测 | O(depth)，64 级护栏 | `subagent.rs:632-639`；`subagent_spawner.rs:715-733` | 已接线 |
| 兄弟并发上限 | maxSiblings=5（同父未终态） | `subagent.rs:483-484, 605-610` | 已接线 |
| 全局并发上限 | maxConcurrent=12（全会话未终态子代理） | `subagent.rs:485-486, 611-616`；`subagent_spawner.rs:129-131`（AtomicUsize） | 已接线（含批量前瞻 N 预加，`subagent_spawner.rs:806-818`） |
| 批量原子语义 | 任一守卫拒绝 → 整体失败零 run | `subagent_spawner.rs:786-825`；契约 `subagent.rs:789-812` | 已接线（引擎覆写默认非原子实现） |
| 配置开关 | flow_max_concurrent / flow_max_siblings（session_meta） | `flow_graph.rs:689-693, 736-744` | 仅 flow 域可配；run_subagent 工具路径固定默认值（`subagent_spawner.rs:108-110` 注释） |

### 表 2：并行 / 等待能力

| 能力 | 语义 | 实现 | 状态 |
| :--- | :--- | :--- | :--- |
| 子代理并发执行 | 每子代理独立会话+run 并行驱动 | `subagent_spawner.rs:349-375`（launch）；批量 `tasks` 平铺并行 | 已接线 |
| await-all | 等全部指定子代理终态（completed/failed）再规划；事件只记录不打断 | `wait_subagents.rs:48-51, 727-744` | 已接线（事件驱动） |
| timer | 到点返回未完成列表，未完成任务保持运行（缺省 30s） | `wait_subagents.rs:52-54, 85, 669-673` | 已接线 |
| parallel-work | 立即返回快照，主 agent 转并行工作 | `wait_subagents.rs:55-58, 727-732` | 已接线 |
| 超时硬上限 | 10 分钟（600000ms），超限参数报错 | `wait_subagents.rs:82, 661-666` | 已接线 |
| 非阻塞快照 | timeoutMs=0 / 省略 | `wait_subagents.rs:657-667` | 已接线 |
| 等待期间注入 | L1 steer 环，不打断执行 | `wait_subagents.rs:600-607, 717-723` | 通道契约在；生产 resolver 未接线（`wait_channel.rs:29-32` Noop 恒 None → InjectFailed） |
| 事件驱动等待 | subagent-ended 流消费，幂等/名单外忽略/closed fail-open | `wait_subagents.rs:378-459` | 已接线（EventStreamBroadcast feed `subagent_spawner.rs:614-622`） |
| 调度声明持久化 | dispatch_* 键，重启恢复「等待什么」 | `wait_subagents.rs:277-353` | 契约在；生产后端仅内存（`wait_channel.rs:104-115`） |
| 产出清单 | outputFiles（path/summary/bytes），write_claims 引擎强制 | `wait_subagents.rs:145-186, 746-766` | 已接线 |

### 表 3：失败处理 / 恢复能力

| 能力 | 语义 | 实现 | 状态 |
| :--- | :--- | :--- | :--- |
| run 内瞬态自动重试 | RateLimit/ServerError/Timeout/Network 重试 ≤3 次（默认），流已产出内容不重试 | `stream_error.rs:62-95`；`loop/mod.rs:157,281` | **已接线**（主/子 agent run 同待遇） |
| 失败终态记录 | run → failed（end_reason=error / max-turns）；子代理行 → failed + ended_at | `run.rs:613-648`；`subagent_spawner.rs:528-569` | 已接线 |
| 终态事件通知 | subagent-ended Critical 必达落库（events 表） | `subagent_events.rs:207-217, 336-366` | 已接线 |
| 主 agent 唤醒 | steering 条目 `subagent-terminal-<run_id>` → idle 续 run 自动消费 | `subagent_spawner.rs:626-651`；`core_run_commands.rs:2861-2872` | 已接线（主 agent 会话收口） |
| wait 订阅者唤醒 | EventStreamBroadcast feed → wait_for_terminal 立即返回 | `subagent_spawner.rs:614-622` | 已接线 |
| 失联兜底 | watchdog 10 分钟无唤醒 → steering 提醒 | `watchdog.rs:1-16, 39-44` | 已接线 |
| 重启后子代理恢复 | **不恢复**：run 中断归一 failed（daemon-restarted），session_agents running 行归一 failed | `restore.rs:5-28, 48-55` | 已接线（行为即「中断」） |
| C7 阶梯 1 自动重试（跨 run 级） | 预算内自动重试（750ms 起/8s 封顶/60s） | `recovery.rs:113-243` | **未接线**（`recovery.rs:57-62`，F2-08） |
| C7 阶梯 2 主 agent 激活 | steering + recover_notifications 落库 | `recovery.rs:341-375` | **未接线** |
| C7 阶梯 3 fork 重派 | SessionTree::fork + 三态上下文继承 + Episode 预算 | `recovery.rs:389-420+`；`lifecycle.rs:226-303` | **未接线**（resume_subagent 命令面无 IPC 调用方） |
| C7 阶梯 4 上报用户 | recover_needs_user + 全留痕 | `recovery.rs:28-31` | **未接线** |
| checkpoint | 无任何 checkpoint / 进度快照机制 | `subagent.rs:418-466`（状态机无暂停态） | 不存在 |

---

## 4. 缺口与风险

1. **C7 恢复阶梯生产未接线（最大缺口，F2-08）**。恢复所需的全部算法（重试分类/退避、Episode 预算、fork 三态继承、通知落库）都在 `recovery.rs`，但生产二进制在子代理 run 失败时**不触发任何一级**（`recovery.rs:57-62`）。后果：网络中断超过 run 内 3 次重试后，子代理直接 failed，唯一出路是主 agent 收到通知后**手动**重新派发——与 AGENTS.md「空返回重派纪律」一致，但完全依赖主 agent 的提示词纪律，无系统兜底。
2. **resume_subagent / kill_all 命令面未接 IPC**。`lifecycle.rs` 的消费端逻辑（fork 重派、批量强停、Episode 预算、幂等）已完整，但 `core_run_commands.rs:2107-2120` 的 `lifecycle_service()` 只在测试中被调用（T-D-12 命令面欠账）。主 agent 无法工具化触发「重派」。
3. **无 checkpoint / 进度续接**。子代理状态机无暂停态；失败后工作产物仅靠文件系统保留（产出清单可由 write_claims 收集），对话上下文只能靠 fork 继承（verbatim ≤24h+≤80%），任务本身必须从头重跑。长任务（大调研、多文件实现）中断损失大。
4. **wait 声明与产出清单持久化仅内存**。`MemoryWaitStore`（`wait_channel.rs:104-115`）不跨重启；`DispatchDeclaration::from_meta_pairs`（`wait_subagents.rs:326-352`）的恢复能力没有生产后端支撑——主 agent 等待期间应用重启，重启后「等待什么」丢失，只有 watchdog 能在失联 10 分钟后兜底提醒，但无法精确恢复等待集合。
5. **文档口径与代码语义偏差**。AGENTS.md「一轮最多 12 个子 Agent」≠ 代码「未终态并发 ≤ 12」。同轮内若子代理陆续完成，可派发第 13、14……个。且 maxSiblings=5 意味着单次批量派发超过 5 个会直接并发拒绝（批量前瞻预加也计入）。口径需对齐，避免主 agent 按错误预期编排。
6. **失败→通知的时间窗**。steering 通知依赖主 agent 有下一 run 收口来消费；若主 agent 正阻塞在长工具调用或无 idle 续 run 条件，通知延迟；watchdog 10 分钟兜底在默认场景足够，但不是实时。
7. **恢复机制本身的并发/配额红线冲突面**：C7 阶梯 3 fork 重派若接线，必须与 RecursionGuard（12/5/1）和探索类文档配额（`explore_quota.rs:8-9`「同一子代理多次续跑共享同一配额」）协同——fork 新 run 会重新进入并发记账，需先释放旧 run 记账；文档配额按会话计数天然共享（fork 后 session_id 不变时语义自洽），但需验证。

---

## 5. 建议：子 agent 失败后的自动恢复 / 重派机制设计

> 约束对齐声明：以下设计全部保持 AGENTS.md 三条红线——12 并发上限与嵌套禁令只增不减、配额红线（探索类文档每会话 1 份）不绕过、测试资产门禁不受影响。所有条目为并列问题（同权），「实施顺序」仅为依赖关系排序，不代表砍项。

### 5.1 设计目标

把「子代理因网络中断失败」从「仅通知主 agent 手动重派」升级为「**阶梯式自动恢复 + 显式重派命令面**」，且**不产生任何自派发能力**（恢复决策永远由主 agent / 系统守卫作出，子代理自身依旧无 run_subagent）。

### 5.2 模块与机制建议（按依赖顺序）

**① C7 阶梯 1 接线：run 级失败后的跨 run 自动重试（引擎内，不新增 run）**
- 位置：`apps/agent-workbench/src-tauri/src/core_run_commands.rs` 的 `finalize_failed`（3066-3073 已处理子代理终态收口）前方，或 engine 的 provider 流错误分类钩子处——仅当 `active.subagent.is_some()` 时触发 `RecoveryCoordinator::on_subagent_run_failure`（`recovery.rs:914`）。
- 机制：复用 `ladder1_decision`（`recovery.rs:205-243`）——瞬态错误且预算内 → 不收敛 run，按退避（750ms 起/8s 封顶/60s 总预算）自动重进同一任务（与 stream_error.rs 的 run 内 3 次重试互补：run 内先重试，跨 run 阶梯兜底；重试不计入 run 失败，`recovery.rs:13-14`）。
- 约束：重试**不 spawn 新 run**（不消费 RecursionGuard 并发预算）；失败即释放记账、进入阶梯 2。
- 依赖：每会话 `RecoveryCoordinator` 实例生命周期 + `RecoveryStore`（session_meta 适配，`recovery.rs:54-55` 已有抽象）+ `spawn_blocking`（F2-27，RecoveryStore 为同步 SQLite trait）。

**② C7 阶梯 2 接线：主 agent 激活通知（不改编排权）**
- 机制：阶梯 1 预算耗尽 → `escalate`（`recovery.rs:15-20`）写 steering（分组 `recovery-<run_id>` 去重）+ 落库 `recover_notifications`（重启后 `restore_steering_notifications` 重排，`recovery.rs:52-53`）。
- 与现有 `subagent-terminal-<run_id>` 通知叠加不冲突；通知只提醒，**不自动 fork**（编排权留在主 agent，对齐「所有子 Agent 由主 Agent 分配」）。

**③ resume_subagent / kill_all 命令面接 IPC（T-D-12 欠账清偿）**
- 机制：把 `SubagentLifecycleService`（`lifecycle.rs:131-136`）暴露为显式 IPC 命令（对齐现有 workbench 命令面模式）；主 agent 工具化触发「重派」= `resume`（fork_and_reassign，`lifecycle.rs:243-303`），幂等防重复 fork。
- 约束：重派的新 run 走 `SubagentSpawner::spawn` 全流程 → 自然受 12/5/1 守卫约束（`subagent_spawner.rs:743-773`）；fork 前旧 run 置 failed 已释放记账（`lifecycle.rs:227-233` 语义）。Episode 预算（默认 3，`recovery.rs:284-286`）防无限重派。

**④ wait 声明持久化后端真适配（conex-db session_meta）**
- 机制：`MemoryWaitStore`（`wait_channel.rs:104-115`）换 session_meta 真适配，键形状已冻结（`wait_subagents.rs:89-99` 的 dispatch_* / dispatch_outputs，序列化/解析函数齐备）；watchdog 与 wait 声明共享同一数据面（`wait_channel.rs:34-37` 注释已在设计中）。
- 收益：主 agent 等待期间应用重启，重启后「等待什么」与产出清单可精确恢复，watchdog 判定跨重启一致。

**⑤ 远期：checkpoint / 轻量续跑**
- 最小可用形态：fork 重派时的「任务 + 上下文 + 产出清单」整体携带——上下文继承已有（三态，`recovery.rs` fork 语义），产出清单已有（write_claims → `SubagentOutput`，`wait_subagents.rs:145-186`），缺的是把产出清单随 ForkRecord 落库并在新 run 注入「已完成工作清单 + 断点位置」提示词段（对齐 T-EG-10 的产出通知模式）。完整 checkpoint（含中间消息序列）属大件，需单独方案评审。

### 5.3 风险与护栏

- 重派并发护栏：fork 新 run 必须显式走 spawn 守卫（不允许绕过 check_recursion_guard 直接启动），保证 12 上限在恢复路径同样生效。
- 嵌套禁令护栏：恢复机制的所有触发面只在「主 agent 命令面 / 引擎守卫层」，子代理工具注册表依旧剔除 run_subagent（`subagent.rs:653-659`），C7 阶梯 2 通知不携带任何自动 spawn 能力。
- 配额护栏：探索类文档配额按会话计数（`explore_quota.rs:8-9`、`explore_docs_credential_section`），fork 重派若沿用同一 session_id 则配额语义自动延续，无需改配额模块；若采用新会话（branch）需在 spawn 时透传配额快照。
- 测试资产：recovery.rs 既有 40+ 测试（`recovery.rs:1456-2233` 测试域）与 lifecycle 测试（`lifecycle.rs:305+`）可直接作为接线验收的回归面；新增接线测试挂 `crates/orchestrator/tests/` 与 workbench 测试域。
- 文档口径：同步修正 AGENTS.md「一轮最多 12 个」表述为「同时运行（未终态）子代理 ≤ 12、同父 ≤ 5、深度仅 1」。

---

## 附：关键文件速查

| 文件 | 角色 |
| :--- | :--- |
| `crates/agent-tools/src/tools/subagent.rs` | 子代理契约 / RecursionGuard / 状态机 / run_subagent 工具（叶子 crate，纯逻辑） |
| `crates/agent-tools/src/tools/wait_subagents.rs` | 三模式等待 / 事件驱动原语 / dispatch 声明 / 产出清单 |
| `apps/agent-workbench/src-tauri/src/subagent_spawner.rs` | 生产 spawner：守卫快照采集 / 记账 / 落库 / run 启动 / 终态统一收口 |
| `apps/agent-workbench/src-tauri/src/wait_channel.rs` | 生产等待通道（WaitStore / EventStreamBroadcast / ControlBusResolver） |
| `apps/agent-workbench/src-tauri/src/core_run_commands.rs` | run 生命周期驱动 / 子代理终态收口接线 / idle 续 run / 失败收口 |
| `crates/orchestrator/src/run.rs` | run 状态机（9 态）/ 终态映射 |
| `crates/orchestrator/src/subagent_events.rs` | subagent-started/event/ended 唯一发射方（Critical 必达） |
| `crates/orchestrator/src/recovery.rs` | C7 四级恢复阶梯 + Episode 预算（**生产未接线**） |
| `crates/orchestrator/src/lifecycle.rs` | kill_all / resume_subagent（**命令面未接 IPC**） |
| `crates/orchestrator/src/restore.rs` | 重启恢复（in-flight → interrupted；session_agents 归一 failed） |
| `crates/session-loop/src/loop/handlers/stream_error.rs` | run 内瞬态重试阶梯（生产已接线，上限 3） |