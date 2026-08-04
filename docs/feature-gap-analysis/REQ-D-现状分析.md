# 模块 D — 多 Agent 协同调度框架：需求现状分析

> 文档类型：需求现状分析（写文档任务）
> 需求来源：`docs/feature-gap-analysis/REQ-agent-engine-capabilities.md` 第五部分（REQ-D01~D08）
> 调查范围：`crates/agent-tools`（run_subagent / 写路径互斥 / 只读裁剪 / 配额 / 等待）、`crates/orchestrator`（DAG 调度 / 子代理事件 / 恢复阶梯 / 事件队列）、`crates/session-loop`（钩子事件面 / 控制总线）、`crates/conex-db`（session_agents / session_meta / events 表）、`crates/agent-provider`（模型配置）、`crates/conex-types`（AgentEvent / 背压分级）、`packages/shared-types`（SubagentDefinition 等 TS 契约）、`apps/crish-desktop`（AgentCard / AgentTeamBoard / InlineAgentPanel）
> 编写日期：2026-08-04
> 判定符号约定：✅ = 已实现（含验收标准达成）；🟡 = 部分实现（存在明确差距）；❌ = 未实现 / 缺口

---

## 目录

1. [模块 D 总体结论摘要](#0-模块-d-总体结论摘要)
2. [REQ-D01 动态 Prompt 子 Agent 派发](#1-req-d01-动态-prompt-子-agent-派发)
3. [REQ-D02 子 Agent 工作区隔离策略](#2-req-d02-子-agent-工作区隔离策略)
4. [REQ-D03 子 Agent 默认使用当前模型](#3-req-d03-子-agent-默认使用当前模型)
5. [REQ-D04 自定义 Agent 类型定义](#4-req-d04-自定义-agent-类型定义)
6. [REQ-D05 DAG 依赖图自动调度引擎](#5-req-d05-dag-依赖图自动调度引擎)
7. [REQ-D06 Agent 间全局事件总线](#6-req-d06-agent-间全局事件总线)
8. [REQ-D07 事件驱动无轮询唤醒](#7-req-d07-事件驱动无轮询唤醒)
9. [REQ-D08 子 Agent 生命周期管理](#8-req-d08-子-agent-生命周期管理)
10. [模块 D 总结](#9-模块-d-总结)

---

## 0. 模块 D 总体结论摘要

| 需求 | 判定 | 一句话结论 |
| :--- | :---: | :--- |
| REQ-D01 动态派发 | 🟡 部分 | run_subagent 单发已完整；Role 为固定 5 枚举（非 2-5 字自定义标签）、无批量派发参数、并发上限 6 与"一轮 12"约定不一致 |
| REQ-D02 工作区隔离 | ❌ 缺 | 只有写路径互斥（write_paths）+ 只读工具裁剪；隔离模式恒为 `none`，share/branch 未实现 |
| REQ-D03 默认当前模型 | 🟡 部分 | 继承语义天然满足（全局单例配置）；多模型并行完全缺失（无开关、无 per-run 覆盖） |
| REQ-D04 自定义 Agent 类型 | 🟡 部分 | SubagentDefinition 骨架已有；缺 task_type / enable_write_tools / allowed_write_paths 硬拦截等 7 项 |
| REQ-D05 DAG 调度 | ✅ 已实现 | flow_graph 完整：环检测 / gate / on_failed 三策略 / 并发预算 / 重启恢复 / 合成唤醒；缺前端可视化（可选） |
| REQ-D06 全局事件总线 | 🟡 部分 | 基础设施远超需求（序列 + 落库 + 背压分级）；但无"自定义 topic Pub/Sub"语义；且与需求"纯内存"冲突（见 §6.4 专业判断） |
| REQ-D07 事件驱动唤醒 | ✅ 已实现 | wait_subagents 三模式 + 事件驱动等待 + L1 注入 + 合成唤醒，无轮询 |
| REQ-D08 生命周期管理 | 🟡 部分 | list/kill(L3)/resume(fork 三态) 已实现；kill_all 无专门入口；maxDepth=3 与"子 Agent 不允许嵌套"冲突（需改 1） |

真 gap 清单与优先级建议见 [第 9 节](#9-模块-d-总结)。

---

## 1. REQ-D01 动态 Prompt 子 Agent 派发

### 1.1 需求原文要点

- 派发参数：`Prompt`（必填）、`Role`（2-5 字角色标签）、`TypeName`（Agent 类型名）。
- 每个子 Agent 获得全局唯一 `ConversationId`，用于后续通信与追踪。
- 支持单次调用批量派发 N 个并行子 Agent。
- 单轮调度上限遵守项目约定（当前为 12 个）。

### 1.2 现状证据

**（1）run_subagent 工具已注册并完整实现单发派发**

工具定义与入参 schema 位于 `crates/agent-tools/src/tools/subagent.rs:435-504`：

```
prompt（必填）、agentId / role / capabilityMode / allowedTools / timeoutMs / description / mode（均可选）
```

- `subagent.rs:456-498`：input_schema 声明上述 8 个参数，`required: ["prompt"]`。
- `subagent.rs:517-597`：execute 解析入参并装配 `SubagentSpawnRequest`，经 `SubagentSpawner` trait 通道送出（`subagent.rs:400-407`）；出站信封返回 `subagentId / subagentRunId / sessionId / status / summary`（`subagent.rs:589-595`）。
- 一次调用恰好 spawn **一个**子代理，无批量数组参数。

**（2）唯一 ConversationId 的现状形态：三 id 模型**

`SubagentSpawnResult`（`subagent.rs:336-351`）返回：

- `subagent_id`：`session_agents.agent_id`（主键之一，schema.rs:65）；
- `subagent_run_id`：`session_agents.subagent_run_id`（同一 run 续跑不变，C1 硬约束，`subagent.rs:339-341`）；
- `session_id`：子代理独立会话 id（对应"全局唯一 ConversationId"语义）。

落库表 `session_agents`（`crates/conex-db/src/schema.rs:50-66`）完整记录父子链与深度：

```
agent_id / subagent_run_id / parent_session_id / parent_run_id / parent_tool_call_id / depth / subagent_path_json …
```

- `depth` 列（`schema.rs:63`）：沿 parent_id 链数，主会话 = 0，直接子代理 = 1；
- `subagent_path_json`（`schema.rs:64`）：工作流路径记录（恢复阶梯 fork 用）。

**（3）Role 现状：固定 5 枚举，非 2-5 字自由标签**

`SubagentRole`（`subagent.rs:36-47`）仅 5 个枚举：`researcher / implementer / reviewer / debugger / planner`；TS 侧同型（`packages/shared-types/src/subagent.ts:5-6`）。

- 工具 schema 中 role 是 enum（`subagent.rs:467-471`），传入 `"wizard"` 之类自由标签会被拒绝（测试 `subagent.rs:705-717`：`tool_rejects_unknown_role_and_capability`）。
- 角色仅"展示与过滤"（`subagent.rs:34` 注释），不影响调度——调度只看 capabilityMode（`subagent.ts:8-12` 禁令 21：禁止 role 与 capabilityMode 双维度）。
- 人读展示名由 description/mode/id 兜底（前端 `AgentTeamBoard.tsx:92-95`：`agentTitle` = description → mode → id → "子智能体"）。

**（4）递归守卫：派发上限的实际约束**

`DEFAULT_RECURSION_GUARD`（`subagent.rs:184-188`，TS 同值 `subagent.ts:36-42`）：

```
maxDepth = 3（沿 parent_id 链深度）
maxSiblings = 5（同父 run 下未终态子代理数）
maxConcurrent = 6（全会话未终态子代理 run 数）
```

守卫检查纯函数 `check_recursion_guard`（`subagent.rs:253-276`）：深度 → 兄弟 → 并发依次判定；`check_ancestor_chain`（`subagent.rs:290-297`）做 O(depth) 祖先链死锁检测。拒绝时零 run（`SubagentSpawnError::GuardRejected`，`subagent.rs:356-358`）。

**（5）批量派发的半成品：wait_subagents 是"批量等"，不是"批量发"**

`crates/agent-tools/src/tools/wait_subagents.rs:41-72` 提供三模式等待（await-all / timer / parallel-work），输入是**已分发**的子代理 id 列表（`wait_subagents.rs:424` schema：`subagentIds` 数组）。它解决"多个子代理的聚合等待"，但派发本身仍是一次一个。

**（6）引擎侧接线现状**

`SubagentSpawner` 生产实现尚未在 `apps/agent-workbench` 落地（grep 全仓仅测试域实现：`subagent.rs:1150` DbSpawner、`orchestrator/tests/flow_scheduler.rs:112`、`orchestrator/tests/multi_agent.rs:155`、`orchestrator/src/recovery.rs:1410`）；`BuiltinToolConfig.subagent_spawner`（`crates/agent-tools/src/tools/mod.rs:50-57`）默认 None，未接线时工具返回 `common.unsupported`（`subagent.rs:559-564`）。

### 1.3 判定

**🟡 部分实现。** 单发派发 + 唯一 id + 父子链 + 深度记账全部就绪（契约层完整、引擎接线位明确）；但三处与需求规格不一致：

1. **Role 不可自由指定**：需求要求 2-5 字角色标签（如"Rust 内核分析师"），现状是 5 个固定枚举，无法表达任意标签；
2. **无批量派发参数**：需求要求"一次调用创建 N 个并行子 Agent"，现状单次 spawn 一个（批量并行只能靠主 Agent 多轮调用或 DAG 调度器）；
3. **并发上限冲突**：需求说"单轮调度上限遵守项目约定（当前 12 个）"，但 `maxConcurrent=6`、`maxSiblings=5`（`subagent.rs:185-187`），上限 6 < 12。

### 1.4 差距与建议

| # | 差距 | 建议（落地到现有架构） |
| :--- | :--- | :--- |
| 1 | Role 固定枚举 | **方案 A（推荐，低成本）**：保持 `SubagentRole` 枚举不动（禁令 21 的调度语义），在 `SubagentSpawnRequest` 增加 `display_label: Option<String>`（2-5 字自由文本，仅展示），落 `session_agents` 新列或复用 `description`；前端 `agentTitle`（`AgentTeamBoard.tsx:92-95`）改为 label 优先。**方案 B（高成本，不推荐）**：Role 改字符串 + 注册表校验，破坏禁令 21 的"调度只看 capabilityMode"契约。 |
| 2 | 无批量派发 | 在 run_subagent schema 增加 `tasks: Array<{prompt, role?, description?}>` 批量分支（一次调用 N 个 spawn，逐一生效守卫，任一拒绝则整体失败零 run，对齐 `declare_flow` 的 staged-clone 原子语义 `flow_graph.rs:866-909`）；或文档层面明确"批量派发走 DAG 调度器（REQ-D05）"，工具保持单发。建议后者为主、前者为 P2。 |
| 3 | 上限 6 vs 约定 12 | 冲突裁决：**以用户裁决为准把"12"定为会话级硬上限**，将 `maxConcurrent` 提至 12、`maxSiblings` 保持 5（兄弟并发仍应小于全局并发）；同时更新 `AGENTS.md` 调度规则与 `subagent.ts:36-42` / `subagent.rs:184-188` 的默认值并同步测试（`subagent.rs:832-920` 的边界值测试）。 |
| 4 | 引擎侧 spawner 未接线 | 引擎侧（apps/agent-workbench）实现 `SubagentSpawner`：守卫快照采集（深度沿 parent_run_id 链）→ session_agents 落库 → 独立 run 启动（经 core_run_task 同通道）→ 终态事件回传 FlowScheduler（`subagent.rs:388-407` 契约职责清单）。这是 D01 落地的前提，优先级最高。 |

---

## 2. REQ-D02 子 Agent 工作区隔离策略

### 2.1 需求原文要点

三种隔离模式：

- `inherit`（默认）：共享同一工作区；
- `share`：类似 Git Worktree，独立分支上下文但共享底层仓库存储；
- `branch`：完全隔离的 Git 分支空间，终止时自动清理。

验收：三种模式均可正确创建；branch 修改不影响主工作区；branch 终止后正确清理。

### 2.2 现状证据

**（1）隔离模式类型已定义但恒为 none**

`packages/shared-types/src/subagent.ts:19-20`：

```ts
/** 隔离模式（ROUND-09 §3 第一版仅 none，worktree/process 推迟） */
export type SubagentIsolationMode = 'none';
```

Rust 侧 `SubagentSpawnRequest`（`subagent.rs:303-332`）**没有** isolation 字段；`SubagentDefinition.isolationMode?`（`subagent.ts:61`）存在但唯一合法值是 `'none'`。

**（2）现状替代机制一：写路径互斥（不是隔离，是防冲突）**

`crates/agent-tools/src/write_paths.rs` 实现"引擎级写互斥"：

- `WritePathRegistry`（`write_paths.rs:129-140`）：会话级注册表（一个会话一个，`Mutex<Vec<WritePathClaim>>`）；
- `claim`（`write_paths.rs:172-223`）：多路径原子声明，冲突检测与插入同锁区间（防 TOCTOU）；同持有者豁免（子代理可写自己声明范围内，`write_paths.rs:195-198`）；
- Overlaps 前缀语义（`write_paths.rs:333-341`）：`a/b/c.txt` 与 `a/b/` 冲突、`a/b` 与 `a/bc` 不冲突、Windows 大小写折叠（`write_paths.rs:344-355`）；
- TTL 防悬挂（`write_paths.rs:40`：默认 60s 无活动自动释放；`expire_stale` `write_paths.rs:265-275`）；
- 接线：写类工具执行前经 `claim_write_guard`（`write_paths.rs:303-318`）声明；子代理 spawn 时持有守卫到 run 结束（`write_paths.rs:5-8` 模块头注释）；
- 冲突返回结构化错误 `tool.write_path_conflict`（谁占用/何时/有效期，`write_paths.rs:79-109`），由主 Agent 编排串行。

语义定位：这是"**防止并行修改同一文件**"（需求 REQ-D02 的动机句），但实现方式是**互斥拒绝**而非**空间隔离**——冲突时子代理写失败，而不是各自有独立副本。

**（3）现状替代机制二：只读工具集裁剪**

`crates/agent-tools/src/readonly.rs`：

- 只读白名单 6 工具（`readonly.rs:27-34`：read_file / list_dir / file_stat / grep_search / fuzzy_find / diff_text）；
- 写类 4 工具整体剔除（`readonly.rs:19-24`：write_file / delete_file / delete_dir / shell_command）；
- 白名单语义 fail-closed（`readonly.rs:40-48`：白名单外的工具一律剔除，防未来新写工具漏网）；
- 挂接：capabilityMode = read-only 的子代理用 `filter_readonly_registry` 裁剪后的注册表（`readonly.rs:10-13`）。

这为"只读任务"提供了**工具面隔离**（不是文件面隔离）。

**（4）仓库中 Worktree 相关讨论**

`docs/organization/C3-triple-comparison.md` 等对比文档提到 worktree 语义；`subagent.ts:19-20` 明确标注 "worktree/process 推迟"——即设计时已知、有意推迟。

**（5）branch 清理 / 合并链路**

无任何 Git 分支创建、切换、合并、清理代码（引擎侧 git.rs 仅文件操作级，无 worktree 抽象）。

### 2.3 判定

**❌ 未实现（需求三分之二缺失）。** 现状覆盖：

- `inherit` ≈ ✅（缺省行为 = 共享工作区 + 写互斥兜底，冲突时报错而非隔离）；
- `share` ❌（无 Git Worktree 抽象，无分支上下文概念）；
- `branch` ❌（无分支创建/清理/合并，无"终止自动清理"）。

验收标准三项（三模式可创建 / branch 不影响主工作区 / branch 终止清理）全部未达成。

### 2.4 差距与建议

| # | 差距 | 建议（落地到现有架构） |
| :--- | :--- | :--- |
| 1 | 隔离模式类型只有 none | 把 `SubagentIsolationMode` 扩展为 `'inherit' \| 'share' \| 'branch'`（`subagent.ts:19-20`），`SubagentSpawnRequest` 增加 `isolation_mode: Option<SubagentIsolationMode>`（`subagent.rs:303-332`），落 `session_agents` 新列 `isolation_mode`（schema.rs:50-66 加列，走 migrate.rs 迁移）。 |
| 2 | 无 worktree 抽象 | **评估结论（登记推迟）**：`share`/`branch` 依赖 Git Worktree，需要：① 引擎侧新增 worktree 管理器（创建/登记/清理/合并）；② spawn 前检查仓库状态（脏工作区禁建）；③ 子代理 run 的 workspace_root 指向 worktree 路径；④ 终态时 branch 自动清理（有未合并产出时保留并通知）；⑤ 恢复阶梯 3 fork（recovery.rs:382-457）与 worktree 的交互语义。**工作量估约 2 个完整任务卡，收益在单用户桌面场景有限**（当前写互斥 + 只读裁剪已覆盖大部分冲突场景）。建议按 P2 登记，先以"写路径互斥 + 只读裁剪 + allowed_write_paths（REQ-D04 引入后）"作为隔离的务实中间态。 |
| 3 | 冲突即失败体验粗糙 | 短期增强：`tool.write_path_conflict` 错误（`write_paths.rs:79-109`）已带"谁占用/何时"，可进一步在子代理侧提供"冲突路径自动重试/等待持有者释放"（wait_subagents 等待窗内重试），把互斥从"立即失败"升级为"短窗等待"，接近 share 模式体验。 |

---

## 3. REQ-D03 子 Agent 默认使用当前模型

### 3.1 需求原文要点

- 默认行为：子 Agent 自动使用与主控 Agent 相同的模型；
- 多模型模式（高级）：需用户在设置界面显式开启；开启后可按子 Agent 指定模型；也可由 AI 自动配置（如"用轻量模型做搜索"）；
- 未开启时 `Model` 派发参数无效或被忽略。

### 3.2 现状证据

**（1）模型配置是进程级全局单例，run 启动时统一解析**

- `crates/agent-provider/src/config.rs:95-110`：`ProviderConfig { provider_id, endpoint, base_url, model, api_key_ref, stream, extra }`——**一个全局配置，无 per-session / per-run 的 model 字段**；
- 解析顺序（`config.rs:229-249` `resolve`）：env 覆盖 → 持久化值 → 内置默认；`model` 取 `first_env_value(MODEL_ENV_VARS).or(persisted.model)`（`config.rs:234`）；
- 引擎侧单例：`apps/agent-workbench/src-tauri/src/config/provider.rs:190-195` `effective_model()`（runtime → persisted → env）；
- run 启动装配：`core_run_commands.rs:1554`（with_cache_tracking 用 `config.model` 作归因）。

**（2）子代理 spawn 契约中无 model 字段**

`SubagentSpawnRequest`（`subagent.rs:303-332`）字段全表：agent_id / prompt / role / capability_mode / allowed_tools / timeout_ms / description / mode / parent_session_id / parent_run_id / parent_tool_call_id / flow_node_id / is_composite——**没有 model / provider 字段**。

**（3）子代理 run 的模型来源 = 与主 agent 相同**

子代理 run 走 core_run_task 同通道启动（`subagent.rs:394-396` 注释：独立 run 启动走 core_run_task 同通道），模型解析同样来自全局单例 → **所有 run（主/子）天然共享当前模型**。

**（4）多模型相关的既有线索**

- `session.last_model`（`core_run_commands.rs:2514`）只做会话级展示记录，不参与子代理派发；
- 前端 provider 设置（`config/provider.rs:475-526`）只写全局配置；
- 无"多模型并行"设置开关的任何代码痕迹。

### 3.3 判定

**🟡 部分实现。**

- ✅ **默认继承**：验收标准 1（默认全部同模型）与验收标准 2（多模型未开启时 Model 参数被忽略——因为根本没有 Model 参数）天然满足；
- ❌ **多模型模式**：验收标准 3（开启后可为不同子 Agent 指定不同模型）完全缺失——无设置界面开关、无 per-subagent 覆盖、无 AI 自动配置。

### 3.4 差距与建议

| # | 差距 | 建议（落地到现有架构） |
| :--- | :--- | :--- |
| 1 | 无 per-run 模型覆盖通道 | `SubagentSpawnRequest` 增加 `model_override: Option<String>`（+ 可选 `provider_override`）；引擎侧 spawn 子代理 run 时把覆盖值注入 ProviderCall 装配位（`core_run_commands.rs` run 启动处，`config/resolution.rs` 的 `RuntimeProviderConfig` 结构上加可选覆盖层），未指定则沿用全局解析（默认继承语义不变）。 |
| 2 | 无多模型开关 | 设置界面（前端 provider 设置 + `config/provider.rs`）增加"多模型并行"布尔开关；关闭时引擎侧忽略 spawn 请求的 model_override（对齐需求"字段无效或被忽略"）；打开时生效。 |
| 3 | AI 自动配置 | 多模型开启后，把模型选择表达为工具参数即可：run_subagent 的 model 参数由主 Agent 决定（含"用轻量模型做搜索"的自然语言 → 主 Agent 选型），无需引擎额外逻辑；仅需在 `catalog_commands.rs` 的 ModelCatalog 查询接口上保证"按能力过滤"可用。 |

---

## 4. REQ-D04 自定义 Agent 类型定义

### 4.1 需求原文要点

可配置参数（9 项）：`name` / `description` / `system_prompt` / `task_type`（6 枚举）/ `enable_write_tools` / `allowed_write_paths` / `allowed_read_paths` / `enable_command_tools` / `enable_mcp_tools`。

验收：可定义含全部参数的类型；task_type 默认权限映射正确生效；allowed_write_paths 为 **Rust 侧硬性沙箱拦截**；定义后可多次实例化。

### 4.2 现状证据

**（1）SubagentDefinition 现有字段（骨架）**

`packages/shared-types/src/subagent.ts:45-62`：

```ts
interface SubagentDefinition {
  id / name / role / capabilityMode / systemPrompt / timeoutMs / allowedTools? / isolationMode?
}
```

覆盖需求中的：name ✅、description（≈ name 展示位）🟡、system_prompt ✅、allowedTools（工具级白名单）🟡。

**（2）能力控制现状：capabilityMode 4 档**

`SubagentCapabilityMode`（`subagent.ts:13-14`；Rust `subagent.rs:76-85`）：`read-only / read-write / execute / all`。实际生效链路：

- `read-only` → `filter_readonly_registry` 裁剪（`readonly.rs:40-48`），执行层拿不到写工具；
- 其余三档 → 无差异（无 execute/all 的细分，无命令工具独立开关）。

**（3）现状缺失项逐一比对**

| 需求字段 | 现状 | 差距 |
| :--- | :--- | :--- |
| `task_type`（analysis/design/review/implementation/organization/commit） | 无 | ❌ 无任务类型概念；`mode`（research/research_single/solve/write，`subagent.rs:318-319`）语义接近但枚举不同、无权限映射 |
| `enable_write_tools` | 无 | ❌ 无显式开关；只有间接的 capabilityMode=read-only 整组裁剪 |
| `allowed_write_paths` | 无（**write_paths.rs 是互斥不是白名单**） | ❌ **无 Rust 侧硬性路径沙箱**：`validate_write_path`（`write_paths.rs:289-296`）只做"合法性校验 + 互斥登记"，不做"越权拒绝"；子代理可在声明路径外写文件（只要无人占用） |
| `allowed_read_paths` | 无 | ❌ 无读路径限制概念 |
| `enable_command_tools` | 无 | ❌ shell_command 只有 read-only 整组剔除（`readonly.rs:19-24`），无独立开关 |
| `enable_mcp_tools` | 无 | ❌ 无 MCP 工具开关 |

**（4）定义的存放与实例化**

- 现有 `SubagentDefinition` 由"插件 manifest 的 agents 字段声明"（`subagent.ts:44` 注释），无运行时注册面；
- run_subagent 的 `agentId` 参数（`subagent.rs:463-466`）支持按定义 id 实例化，但引擎侧无定义注册表实现。

### 4.3 判定

**🟡 部分实现（骨架型）。** `SubagentDefinition` 结构存在（禁令 22 声明：由插件 manifest 声明），但需求 4.1 的 9 项参数中仅约 4 项有等价物；验收标准 4 条全部未达成：

- 可定义含全部参数的类型 ❌；
- task_type 默认权限映射 ❌；
- allowed_write_paths Rust 侧硬拦截 ❌（当前互斥机制是"冲突拒绝"而非"越权拒绝"，语义不同）；
- 定义后多次实例化 🟡（agentId 参数有，注册表无）。

### 4.4 差距与建议（数据结构映射）

**建议的字段映射（TS ↔ Rust ↔ DB）：**

| 需求字段 | TS 类型（subagent.ts 扩展） | Rust（agent-tools） | 落库（session_agents / session_meta） |
| :--- | :--- | :--- | :--- |
| `task_type` | `'analysis'\|'design'\|'review'\|'implementation'\|'organization'\|'commit'` | `subagent.rs` 新增 `TaskType` 枚举 + parse/as_str | 新列 `task_type` |
| `enable_write_tools` | bool | 与 capabilityMode 组合生效：read-only ⇒ false；否则取字段值 | 新列（或由 task_type 派生） |
| `allowed_write_paths` | string[] | 新增 `WritePathPolicy`：spawn 时把白名单路径注册为"硬性允许集"，**写工具执行时先查白名单再查互斥**（在 `claim_write_guard`（`write_paths.rs:303-318`）前插入 `check_write_allowance`） | 新列 `allowed_write_paths_json` |
| `allowed_read_paths` | string[] | 只读工具执行前校验（read_file 等入口） | 新列 `allowed_read_paths_json` |
| `enable_command_tools` | bool | 工具装配时条件剔除 shell_command（复用 `filter_readonly_registry` 的裁剪机制，`readonly.rs:40-48` 推广为通用 `filter_registry(predicate)`） | —（run 级生效） |
| `enable_mcp_tools` | bool | 工具装配时剔除 MCP 工具 | —（run 级生效） |

**实施要点：**

1. **白名单与互斥的层次关系**：`allowed_write_paths` 是**权限沙箱**（写工具执行前检查），`WritePathRegistry` 是**并发互斥**（同一路径多人写冲突）；两套机制串行叠加——先"越权拒绝"，再"冲突拒绝"；
2. **task_type 默认映射**：在 Rust 侧实现纯函数 `default_permissions(task_type) -> {write, command, write_paths}`（对齐需求 4.2 表：analysis 全关、implementation 全开、organization 限文档目录等），引擎侧 spawn 时按"定义字段 > task_type 默认"合并生效；
3. **定义注册表**：引擎侧新增定义注册表（内存 + session_meta 持久化或插件 manifest 加载，`subagent.ts:44` 注释已预留插件面），run_subagent 的 agentId 由此解析出完整定义后转成 SpawnRequest；
4. **禁止触碰**：禁令 21（role 与 capabilityMode 不并存）保持——task_type 是新维度，不并入 role。

---

## 5. REQ-D05 DAG 依赖图自动调度引擎

### 5.1 需求原文要点

- 任务依赖声明（Task A 无依赖 / B 依赖 A / D 依赖 B+C）；
- 自动构建 DAG、验证无循环依赖；
- 入度为零节点立即并行派发；任务完成后下游自动触发；叶子全完成后通知主控；
- 失败处理：失败任务的下游标记 `blocked`，通知主控（失败 id + 错误 + 被阻塞列表）；
- 可视化（可选增强）：前端 React Flow / Mermaid。

### 5.2 现状证据（`crates/orchestrator/src/flow_graph.rs` 完整实现）

**（1）依赖声明模型**

- `FlowNode`（`flow_graph.rs:90-110`）：id / task / depends_on（前置 id 列表）/ parallel（是否与同级并发）/ on_failed（节点级策略覆盖）/ is_composite（综合节点标记）；
- `FlowDeclaration`（`flow_graph.rs:116-122`）：tasks + planner_run_id（声明编排的主 run id）；
- 声明序 = 同层串行顺序（`flow_graph.rs:100-102`），after 允许前向引用（`flow_graph.rs:217-218`）。

**（2）环检测与校验**

- `FlowGraph::validate`（`flow_graph.rs:219-251`）三遍校验：id 全集/重复 → 自依赖/未知引用 → 环；
- `detect_cycle`（`flow_graph.rs:292-310`）DFS 三色标记，命中返回环路径（`["a","b","c","a"]`）；
- staged-clone 语义（`flow_graph.rs:206-212`、`add_dependency` 255-288）：校验失败零 run、图不改写；声明被拒不写任何 flow_* 键（`flow_graph.rs:861-865`）。

**（3）自动并行调度**

- `FlowScheduler::declare_flow`（`flow_graph.rs:866-909`）：staged-clone 校验 → 原子落库 → 立即推进首波；
- `advance`（`flow_graph.rs:918-1090`）：**事件驱动推进（不轮询）**——就绪节点（全部前置 completed，`is_ready`）→ 合成唤醒 → 预算 reserve → spawn；预算满时节点保持就绪等下一终态事件（`flow_graph.rs:980-983`）；
- `on_subagent_terminal`（`flow_graph.rs:1096-1210`）：终态事件 → release 预算 → 应用失败策略 → 推进；幂等（重复终态通知忽略，`flow_graph.rs:1122-1127`）；
- 不动点循环（`flow_graph.rs:927-933`）：每轮至少 spawn/阻塞一个节点，迭代上界 = 节点数 + 2。

**（4）失败处理三策略**

- `FailStrategy`（`flow_graph.rs:55-64`）：`Skip`（跳过，后置照常）/ `Block`（阻塞依赖节点含传递，04 文档默认）/ `Report`（照常推进但记录）；
- Block 传播：`propagate_block`（`advance` 内 `flow_graph.rs:935`）+ `FlowNodeState::Blocked`（终态，`flow_graph.rs:367-369`、`is_terminal` 396）；
- 上报结构：`FlowReport`（`flow_graph.rs:539-551`：node_id / run_id / strategy / kind / message），kind 含 NodeFailed / SpawnFailed / Blocked / DataInconsistent（`flow_graph.rs:526-536`）。

**（5）并发预算**

- `ConcurrencyBudget`（`flow_graph.rs:433-487`）：reserve/release 记账（已分配-已释放 = 在途）；`recompute`（`flow_graph.rs:481-486`）跨重启重算防 double-charge；
- 预算判定复用 RecursionGuard（`flow_graph.rs:974-983`：快照 depth=1，siblings=concurrent=在途数）。

**（6）重启恢复**

- `FlowScheduler::load`（`flow_graph.rs:1281-1300+`）：从 `flow_declaration` 键 + session_agents 行重建；run 映射缺失的节点按失败处理并积压数据不一致上报；恢复后由调用方 `advance` 按图重新推进；
- 持久化键命名空间（`flow_graph.rs:664-678`）：`flow_declaration` / `flow_state` / `flow_on_failed` / `flow_reserved` / `flow_released` / `flow_max_concurrent` / `flow_max_siblings` / `flow_auto_composite`。

**（7）合成唤醒（gate 类节点）**

- `FlowWakeup`（`flow_graph.rs:513-523`）：就绪即产唤醒事件（不轮询），同节点只唤醒一次（`wakeup_sent` 幂等，`flow_graph.rs:955-966`）；
- `attach_run`（`flow_graph.rs:1217-1270`）：观测态下主 Agent 自行 spawn 综合 run 后挂回节点，gate 强制与预算同样生效。

**（8）与 spawn 链路的衔接**

- spawn 请求携带 `flow_node_id` / `is_composite`（`flow_graph.rs:985-999`），结果回显（`subagent.rs:348-351`）；
- 终态事件回传：`on_subagent_terminal`（`flow_graph.rs:1096`）；
- 子代理事件发射：`with_subagent_event_emitter`（`flow_graph.rs:807-810`）挂 M14 发射器。

**（9）测试面**

`orchestrator/tests/flow_scheduler.rs`（RecordingSpawner）、`orchestrator/tests/multi_agent.rs`（ChainSpawner 主 agent 分发 + 流程节点）、`orchestrator/tests/crash_consistency.rs`（DbSpawner 崩溃一致性）——验收标准均有测试覆盖。

### 5.3 判定

**✅ 已实现。** 需求 5.1-5.3 全部达成（声明 / 环检测 / 并行派发 / 下游自动触发 / 叶子完成通知 / blocked 标记 + 通知主控）；5.4 可视化未做（需求标注"可选增强"）。

对照验收标准：依赖声明 ✅；并行识别 ✅（多_agent 测试覆盖）；下游自动触发 ✅；失败下游 blocked ✅。

### 5.4 差距与建议

| # | 差距 | 建议 |
| :--- | :--- | :--- |
| 1 | 前端可视化（5.4 可选） | 状态已在 `FlowNodeState`（`flow_graph.rs:357-369`：pending/running/completed/failed/blocked）与 `flow_state` 键中可查，前端可读。**建议 P2 可选**：新增只读查询命令（node 状态列表 + 依赖边），前端用 Mermaid 渲染（成本远低于 React Flow）；不做也不影响任何验收标准。 |
| 2 | 主 Agent 如何声明 DAG | 现状 `FlowDeclaration` 只有 Rust 结构，无工具入口。**建议**：新增 `declare_flow` 工具（参数 = tasks 数组，含 task/dependsOn/parallel/onFailed），把编排声明能力交还给主 Agent（对齐"主 Agent 是唯一编排者"原则，`flow_graph.rs:12-13`）。 |
| 3 | 叶子完成通知 | `FlowAdvance.flow_terminal`（`flow_graph.rs:565-566`）已带终态标志，但引擎侧"通知主控"接线（L1 注入）需在引擎集成时确认。 |

---

## 6. REQ-D06 Agent 间全局事件总线

### 6.1 需求原文要点

- 每个 Agent 可发布带 `topic` 标签的事件、订阅 topic 被唤醒；
- 预定义系统 topic：`agent.started` / `agent.completed` / `agent.failed` / `task.output`；自定义业务 topic（如 `rust-build.done`）；
- 事件内容：`topic` / `sender` / `timestamp` / `payload`；
- 与 DAG 集成：DAG 引擎内部监听 `agent.completed` / `agent.failed` 驱动下游；
- 安全约束：子 Agent 只能发布不能命令；**事件总线为内存级通信，不持久化（重启后清空）**；如需持久化审计由主控订阅记录；
- 验收：可发布/订阅自定义 topic；事件到达唤醒订阅方；DAG 通过事件总线驱动任务流转。

### 6.2 现状证据

**（1）事件基础设施：序列化 + 落库 + 背压分级（远超"内存级"）**

- 事件模型：`conex-types/src/events.rs:287` 起 `AgentEvent` 枚举（类型化变体，如 `SubagentStarted` 561 / `SubagentEvent` 584 / `SubagentEnded` 593），type_name 落库（`events.rs:661-663`）；
- 落库：events 表 `(session_id, sequence)` 组合主键（`schema.rs:139-147`），`session_sequence` 会话级原子取号（`schema.rs:182-185`）；
- 背压分级：`BackpressureLevel { Delta, Soft, Critical }`（`conex-types/events.rs:175-181`），`event_backpressure`（`events.rs:676-685`）：Delta 可丢不落库、Soft 尽力、Critical 必达落库；
- EventQueue（`crates/orchestrator/src/events.rs:106-180`）：取号 → 非持久化分流（delta 不落库不阻塞 drive loop）→ 持久化事件同步等待落库；持久化失败 → run 标记 failed（`events.rs:12-14`）；
- 子代理事件：`SubagentEventEmitter`（`crates/orchestrator/src/subagent_events.rs:172-218`）三发射点（started / event / ended），背压：started/ended = Critical 必达、progress = Delta、message/tool = Soft（`subagent_events.rs:15-19`）。

**（2）事件消费面：不是 Pub/Sub，是"前端推送 + 插件钩子 + 调度器回传"**

- 前端：`workbench-run-event` 通道（`apps/agent-workbench/src-tauri/src/core_event_bridge.rs:1-11`），buffer.rs 按 runId 缓冲 + 高水位丢帧（`buffer.rs:54-91`，Critical 永不丢）；
- 插件钩子：`crates/session-loop/src/hooks.rs` 14 事件（`hooks.rs:59-106`：session.* / turn.* / tool.* / context.compact.* / error.occurred / model.* / subagent.*），observe/on 双模式（`hooks.rs:288-296`）；
- DAG 调度器：消费的是**直接函数调用** `on_subagent_terminal`（`flow_graph.rs:1096-1097`），**不是**通过事件总线订阅——需求 6.3 的"DAG 通过事件总线驱动"在实现上是"终态事件 → 引擎侧 → 调度器方法"，事件发射（subagent_events）与调度推进（on_subagent_terminal）是两条平行链路。

**（3）无 topic 概念**

- `AgentEvent` 是闭合枚举（`conex-types/events.rs:287`），无自由字符串 topic 字段；"自定义业务 topic（rust-build.done）"无处安放；
- 无订阅注册表、无发布 API、无"唤醒订阅方"机制。

### 6.3 判定

**🟡 部分实现。** 三分之二需求语义与现状架构方向相反：

- ✅ 基础设施面（序列 / 落库 / 背压 / 终端推送 / 钩子消费）完整且远超需求；
- ❌ **Pub/Sub 语义**（topic 发布订阅）不存在——现状是"单向事件流 + 点对点回传"；
- ❌ 验收标准 1（发布/订阅自定义 topic）与验收标准 3（DAG 通过事件总线驱动）在字面意义上未达成；
- ⚠️ **与需求文档 6.4"内存级不持久化"冲突**：现状 Critical 事件落库（events 表）。

### 6.4 冲突点专业判断：分层持久化 vs 纯内存

**结论：现有"Critical 必达落库 + Delta 不落库"的分层持久化是对的，需求文档 6.4 的"纯内存"应判定为过时/低优先级约束，建议按现状保留并修订需求文档。**

论证（结合崩溃恢复 / 审计 / 补投三面）：

1. **崩溃恢复面**：子代理终态（subagent-ended，Critical）若只在内存，进程崩溃后主 Agent 无法得知"哪个子代理完成/失败"；DAG 调度器恢复虽不直接依赖 events 表（`flow_graph.rs:1281+` 从 session_agents 行 + flow_* 键重建），但"补投"依赖终态事件的持久化留痕——恢复阶梯 2 的通知（`recover_notifications`，`recovery.rs:76-82`）与 steering 补排（`restore_steering_notifications`，`recovery.rs:52-54`）都是"落库后重启可恢复"的实例。纯内存总线 + 重启清空 = 子代理完成信号永久丢失。
2. **审计面**：events 表是会话级审计底账（recovery-* 域事件留痕：`recovery.rs:96-104` 五个恢复域事件类型），若按需求"由主控订阅记录"则主控 Agent 本身也是易失的（进程内），审计链断裂；"引擎落库 + 引擎恢复"比"主控订阅 + 主控记录"可靠一个数量级。
3. **补投面**：DAG 推进依赖终态事件（`on_subagent_terminal`）；若事件仅内存，恢复后调度器必须靠 session_agents 行状态差量重推（现状 load 正是这么做的），两者并存时**落库事件是校验锚点**（崩溃一致性测试 `crash_consistency.rs` 覆盖）。
4. **成本面**：SQLite 单会话事件量级小（Delta 已分流不落库），落库开销可忽略；"纯内存"省不了什么。

**需求文档修订建议**：把 REQ-D06 6.4 改为"事件按背压分级持久化（Critical 必达落库、Delta 可丢不落库）；自定义业务 topic 若为纯诊断类可按 Delta 处理"。

### 6.5 差距与建议（topic Pub/Sub 的务实落地）

| # | 差距 | 建议 |
| :--- | :--- | :--- |
| 1 | 无自定义 topic | **不新增通用 topic 字符串**（会破坏 AgentEvent 闭合枚举的强类型与注册表）；改为**注册式事件扩展**：`AgentEvent::CustomTopic { session_id, topic: String, sender, payload }`（topic 白名单登记于事件注册表，防任意字符串泛滥），背压默认 Soft（可配 Delta/Critical）。发布 API = 现有 `EventQueue::push`，订阅 API = 引擎侧订阅表（session_meta 或内存）+ 唤醒 = 现有 L1 注入通道（见 REQ-D07），**不需要新总线**。 |
| 2 | 需求 6.3"DAG 通过事件总线驱动" | 现状是函数直调（`on_subagent_terminal`，`flow_graph.rs:1096`），语义上已经等价且更可靠（无事件序列化/反序列化损耗）；保留现状，在文档层面说明"DAG 驱动 = 终态事件 → 调度器回调"即可，不必重构为消息订阅。 |
| 3 | 子 Agent 间直连通信 | 需求 6.4 安全约束（子 Agent 只能发布不能命令）与现状"一切经主 Agent 编排"一致（`flow_graph.rs:12-13` 主 Agent 唯一编排者）；子 Agent 发布的事件落父会话，主 Agent 经 hooks（subagent.*）或 L1 注入消费。无动作。 |

---

## 7. REQ-D07 事件驱动无轮询唤醒

### 7.1 需求原文要点

- 子 Agent 完成任务后自动通知主控（子 Agent ID / 角色标签 / 完成状态 / 产出摘要）；
- 子 Agent 遇任务书未覆盖问题时主动"上报"请求裁决；
- 主控被唤醒后上下文中**自动注入所有待处理子 Agent 消息（批量推送，不是逐条唤醒）**；
- 验收：完成后主控自动唤醒；多子代理同时完成批量推送；上报消息正确送达。

### 7.2 现状证据

**（1）事件驱动等待原语（非轮询）**

`crates/agent-tools/src/tools/wait_subagents.rs`：

- `wait_for_terminal_events`（`wait_subagents.rs:233`）：订阅 subagent-ended 事件流 → mpsc 灌入 → 消费（"优先事件而非轮询"，`wait_subagents.rs:12-13`）；
- 三模式：await-all（等全部终态）/ timer（到点返回未完成列表）/ parallel-work（立即返回，`wait_subagents.rs:41-72`）；
- `SubagentWaitChannel`（`wait_subagents.rs:367-388`）：persist_declaration / snapshot / wait_for_terminal / inject 四接口，引擎侧接线位。

**（2）完成通知（子 Agent → 主 Agent）链路**

- 终态事件：`SubagentEndedInfo`（`subagent_events.rs:87-96`：subagent_id / subagent_run_id / status / summary）——status 规范值 completed/failed（`subagent_events.rs:99-118`）；
- 发射：FlowScheduler `on_subagent_terminal` 内收口发射（`flow_graph.rs:1132-1171`）；
- 主控消费：引擎侧将终态事件转为 steering 条目（`recovery.rs:371-380` `build_steering_entry` 是恢复域实例）或唤醒事件，经 L1 steer 环送达主 Agent。

**（3）上报（子 Agent 主动请求裁决）链路**

- 运行中注入：`SubagentWaitChannel::inject`（`wait_subagents.rs:387-388`）经目标 run 的 ControlBus L1 steer 环（session-loop `control.rs` request_subagent_inject，transfer 语义，不打断流）；
- 反向的上报（子 Agent → 主 Agent）：子 Agent 通过消息/事件（`SubagentEventKind::Message`，Soft 落库，`conex-types/events.rs:126-128`）表达，引擎侧转呈主 Agent；
- 恢复域有完整实例：阶梯 2 通知 = steering 条目 + 落库（`recovery.rs:333-380`），group_id 去重（`recovery.rs:354-356`）。

**（4）批量推送（不逐条唤醒）**

- `PendingMessageQueue`（`crates/orchestrator/src/steering_queue.rs:111-114`）：`dequeue_all`（`steering_queue.rs:181`）一次性取空、`transfer_into_input_queue`（`steering_queue.rs:199`）批量转注入输入队列、`transfer_follow_up`（`steering_queue.rs:213`）；
- 多条 steering 条目（含 recovery-* 分组，`recovery.rs:88-90`）在主 Agent 下轮次开始时批量入上下文。

**（5）DAG 侧唤醒**

- 合成唤醒 `FlowWakeup`（`flow_graph.rs:513-523`）+ `take_wakeups`（`flow_graph.rs:848-850`）队列化消费，一次可取全部就绪唤醒（批量语义）。

### 7.3 判定

**✅ 已实现。** 对照验收标准：

- 子 Agent 完成后主控自动唤醒 ✅（终态事件 → L1 注入，非轮询）；
- 多个同时完成批量推送 ✅（PendingMessageQueue 批量 + dequeue_all）；
- 上报消息正确送达 ✅（Message 事件 Soft 落库 + steering 通道）。

设计上"工具化等待"（yield 语义，`wait_subagents.rs:5-7`）甚至比需求更强：主 Agent 用 wait_subagents 显式等待，而不是引擎被动唤醒。

### 7.4 差距与建议

| # | 差距 | 建议 |
| :--- | :--- | :--- |
| 1 | 完成通知的"角色标签"字段 | `SubagentEndedInfo`（`subagent_events.rs:87-96`）无 role 字段；需求要求通知含"角色标签"。**建议**：`emit_ended` 时从 `FlowNodeRuntime.subagent_id`（`flow_graph.rs:409-411`）回查 session_agents 行补 role/description 进 summary 或信封（或复用 `started_info_from_spawn` 的 role 缺省语义，`subagent_events.rs:222-244`）。 |
| 2 | 批量唤醒的上下文注入完整度 | steering 批量注入已有（`steering_queue.rs:199-213`），但"自动注入所有待处理子代理消息"的引擎侧接线（终态事件 → 队列 → 主 Agent 下轮注入）需在引擎集成时确认顺序与去重（建议以 group_id 去重 + dequeue_all 批量，`steering_queue.rs:147` replaceOrEnqueue）。 |
| 3 | 子 Agent 上报的显式工具化 | 子 Agent 侧无"上报主控"工具（现为消息事件隐式表达）。**建议 P2**：新增 `report_to_orchestrator` 工具（消息落父会话 + steering 条目入队 + 落库），语义对齐恢复域 `recover_notifications`（`recovery.rs:333-351`），使"上报"成为一等原语。 |

---

## 8. REQ-D08 子 Agent 生命周期管理

### 8.1 需求原文要点

- `list`：列出所有活跃子 Agent（ConversationId / Role / 状态 / 启动时间）；
- `kill`：终止指定子 Agent——**并带用户裁决："子 Agent 不允许再嵌套子 Agent，仅有主 Agent 有生成子 Agent 的能力以及拥有子 Agent 的生命周期管理"**；被终止子 Agent 日志和产出保留，branch 工作区清理；
- `kill_all`：终止所有子 Agent 及其后代；
- `resume`：恢复被杀死的（或网络问题）子 Agent，携带 id / 名称 / prompt 激活；
- 验收：可列出、终止单个或全部子 Agent；被终止子 Agent 的产出文件和日志保留。

### 8.2 现状证据

**（1）list：✅ 数据完整，前端可展示**

- 数据：`session_agents` 表全字段可读（`crates/conex-db/src/agents.rs:9-89` `load_session_agents`：agent_id / subagent_run_id / parent 链 / description / mode / status / summary / started_at / ended_at / depth / subagent_path_json + 消息）；
- 前端：`AgentTeamBoard.tsx`（列表 + 状态点 + 时长 + 进度，`AgentTeamBoard.tsx:13-51` 状态点、`105-121` 工具进度）、`AgentCard.tsx`（侧栏聊天）、`InlineAgentPanel.tsx`（主对话内嵌块 + 停止/强停）。

**（2）kill：✅ L3 强停机制存在，引擎侧接线位明确**

- 协议：`control.rs`（`crates/session-loop/src/control.rs`）L0-L3（`control.rs:43-58`），`ForceCancel` → L3（`control.rs:67`）；L3 队列面（`control.rs:205-207`）+ 安全点聚合（`safe_point.rs`，优先级：AbortSignal > force_cancel > cooperative_stop > soft_inject，`safe_point.rs:117-121`）；
- 终态：被终止 run 终态归一 failed（I0 裁决，`subagent.rs:122-123`；写面不产生 stopped，`subagent.rs:138-140`；DB CHECK 允许集 `running/completed/failed/stopped`，`schema.rs:59`，读回 stopped 归一 failed `subagent.rs:152-158`）；
- 产出保留：写路径回收站（trash）与审计面（audit.rs）保证文件可恢复；"日志保留" = session_agent_messages 级联保留（`schema.rs:68-85`）。

**（3）kill_all：❌ 无专门入口**

- 无"终止所有子代理及其后代"的命令/工具；`RecoveryCoordinator`、`FlowScheduler` 均无批量终止 API；前端只有单 agent 停止（`InlineAgentPanel.tsx:8`：运行中可停止 L2/L3）。

**（4）resume：✅ 恢复阶梯 3 fork（比需求更强）**

`crates/orchestrator/src/recovery.rs` 四级恢复阶梯（`recovery.rs:7-31`）：

- 阶梯 1 自动重试（`ladder1_decision`，`recovery.rs:198-236`：瞬态分类 + 退避 750ms 起 8s 封顶 60s 总预算）；
- 阶梯 2 主 Agent 激活（steering 软注入 + 落库 `recover_notifications`，`recovery.rs:333-380`）；
- 阶梯 3 fork：`fork_and_reassign` + fork 三态上下文继承（`ForkContextMode` Verbatim/Summarized/New，`recovery.rs:390-411`，判定 `decide_fork_context` 418-435：≤24h 窗口 + ≤80% 字节占比 → Verbatim；超限摘要；空内容 New）+ `ForkRecord` 落库（`recovery.rs:438-457`）+ 预算制（操作指纹 `fingerprint` 244-255 + Episode 预算默认 3，`recovery.rs:259-329`）；
- 阶梯 4 上报用户（`recover_needs_user` 标记，`recovery.rs:85-86`）；
- resume 语义承接：需求"恢复被杀死的子 Agent"= fork 新 run 承接同一目标（原 run 置 failed，`recovery.rs:22-27`），"携带 id/名称/prompt 激活" = fork_and_reassign 的入参形态。

**（5）嵌套约束：⚠️ 冲突——现状允许嵌套，需求禁止**

- 现状 `DEFAULT_RECURSION_GUARD.max_depth = 3`（`subagent.rs:185`；TS `subagent.ts:37`）：主 Agent 可派子 Agent，子 Agent 还可再派（深度 2、3）；
- 需求 REQ-D08 kill 项括号（用户裁决）："子 Agent 不允许再嵌套子 Agent，仅有主 Agent 有生成子 Agent 的能力"——即 **maxDepth 必须为 1**；
- 测试锁定现状（`subagent.rs:832-853`：depth=4 拒绝 / max=3；`subagent.rs:904-920`：depth=3 边界通过）。

### 8.3 判定

**🟡 部分实现。**

- list ✅（数据 + 前端全链路）；
- kill ✅（L3 强停 + 终态归一 + 产出/日志保留）；
- kill_all ❌；
- resume ✅（恢复阶梯 fork 三态继承，比需求更强）；
- **嵌套约束 ✗ 未执行用户裁决**（maxDepth=3 而非 1）。

### 8.4 差距与建议

**（1）把 maxDepth 改为 1 的改造点清单**

| # | 位置 | 现状 | 改动 |
| :--- | :--- | :--- | :--- |
| 1 | `crates/agent-tools/src/tools/subagent.rs:185` | `max_depth: 3` | 改 `1`（唯一权威默认值，Rust 侧） |
| 2 | `packages/shared-types/src/subagent.ts:37` | `maxDepth: 3` | 改 `1`（TS 侧同步，测试 `subagent.ts` 无边界测试但注释要更新） |
| 3 | `subagent.rs:832-853` 测试 `guard_depth_exceeded_rejected` | depth=4 对 max=3 | 改 depth=2 对 max=1 |
| 4 | `subagent.rs:904-920` 测试 `guard_within_limits_allowed` | depth=3 边界通过 | 改 depth=1 为边界通过、depth=2 拒绝 |
| 5 | `flow_graph.rs:788-792`、`flow_graph.rs:892-896` | `max_depth: DEFAULT_RECURSION_GUARD.max_depth` | 跟随默认值自动变 1，无需改（但注释要确认语义：流程节点快照 depth 恒为 1，`flow_graph.rs:976`，不再受 max_depth=1 影响） |
| 6 | 引擎侧 spawner（apps/agent-workbench，未实现） | 深度沿 parent_run_id 链计算 | 实现时直接使用新默认值即可 |
| 7 | **工具面防护（新增，重要）** | 子代理工具装配时未剔除 run_subagent / wait_subagents | read-write/execute/all 模式的子代理注册表要剔除 run_subagent（和 wait_subagents 的"等待"语义保留无妨），在 `BuiltinToolConfig`（`tools/mod.rs:50-57`）装配处按"spawn 发起者是否主 Agent"过滤；守卫层（`check_recursion_guard` depth 判定）是最终防线，工具面剔除是防浪费 |
| 8 | 文档同步 | `AGENTS.md` 调度规则、`subagent.rs:1-23` 模块头注释（"maxDepth=3"字样）、REQ-D08 需求文档 | 全部改为"仅主 Agent 可派发，子 Agent 深度 1" |

注意：maxDepth=1 时 `check_ancestor_chain` 死锁检测（`subagent.rs:290-297`）仍然保留（防同一主会话重复 fork 自身形成环的兜底）。

**（2）kill_all 实现建议**

在引擎侧新增批量终止入口：按 session_agents 行过滤（`parent_session_id` = 主会话 且 status ∈ running，`agents.rs:17-23` 查询条件扩展），逐个对子代理 run 发 L3 force_cancel（`control.rs` request_force_cancel）；终态统一归一 failed（`subagent.rs:141-147`）；FlowScheduler 侧每个终态事件自然触发 `on_subagent_terminal` 推进（`flow_graph.rs:1096-1210`），无需额外编排。

**（3）resume 现状补充**

fork 三态继承已覆盖"网络问题恢复"（阶梯 1 自动重试优先于 fork）；需求 resume 的"携带 id/名称/prompt 激活"建议落为引擎侧 `resume_subagent` 命令：入参 subagent_id + prompt（可选），内部走 `fork_and_reassign`（`recovery.rs:21-27` 接线契约）并消费 Episode 预算（`recovery.rs:300-312`）。

---

## 9. 模块 D 总结

### 9.1 整体判定表

| 需求 | 判定 | 核心证据（文件:行号） | 主要差距 |
| :--- | :---: | :--- | :--- |
| REQ-D01 动态派发 | 🟡 | `subagent.rs:435-597`（工具+执行）、`subagent.rs:36-47`（Role 枚举）、`subagent.rs:184-188`（守卫 6/5/3） | Role 非自由标签；无批量派发；上限 6 < 12；引擎侧 spawner 未接线 |
| REQ-D02 工作区隔离 | ❌ | `subagent.ts:19-20`（none）、`write_paths.rs:129-281`（互斥）、`readonly.rs:19-48`（裁剪） | 无 share/branch；隔离模式恒 none |
| REQ-D03 默认当前模型 | 🟡 | `config.rs:229-249`（全局解析）、`subagent.rs:303-332`（无 model 字段） | 继承 ✅；多模型模式全缺 |
| REQ-D04 自定义 Agent 类型 | 🟡 | `subagent.ts:45-62`（Definition）、`readonly.rs`（裁剪） | 缺 task_type 等 7 项；无路径硬沙箱 |
| REQ-D05 DAG 调度 | ✅ | `flow_graph.rs:90-122`（声明）、`219-251`（校验）、`918-1090`（advance）、`1096-1210`（终态）、`1281+`（恢复） | 仅可视化（可选）与主 Agent 声明入口 |
| REQ-D06 全局事件总线 | 🟡 | `conex-types/events.rs:175-181`（背压）、`orchestrator/events.rs:106-180`（队列）、`subagent_events.rs:172-218`（发射器）、`hooks.rs:59-106`（14 钩子） | 无 topic Pub/Sub；需求"纯内存"与现状落库冲突（建议修订需求） |
| REQ-D07 事件驱动唤醒 | ✅ | `wait_subagents.rs:41-72`（三模式）、`233`（事件等待原语）、`steering_queue.rs:181-213`（批量）、`flow_graph.rs:513-523`（合成唤醒） | 完成通知缺 role 字段；上报无工具化入口（P2） |
| REQ-D08 生命周期 | 🟡 | `control.rs:43-67`（L3）、`recovery.rs:198-457`（恢复阶梯/fork）、`agents.rs:9-89`（list）、`subagent.rs:185`（maxDepth=3） | kill_all 缺失；maxDepth 未按用户裁决改 1 |

### 9.2 真 gap 清单（按优先级）

| 优先级 | Gap | 说明 | 工作量估计 |
| :---: | :--- | :--- | :--- |
| **P0-1** | 引擎侧 `SubagentSpawner` 接线（D01 落地前提） | 守卫快照 → 落库 → 独立 run 启动 → 终态回传（`subagent.rs:388-407` 契约职责） | 1 任务卡 |
| **P0-2** | maxDepth 3→1（用户裁决执行） | 8 个改造点见 §8.4(1)；含工具面剔除 run_subagent | 0.5 任务卡 |
| **P0-3** | 并发上限与"一轮 12"对齐 | maxConcurrent 6→12 争议裁决（§1.4-3） | 0.5 任务卡 |
| **P1-1** | REQ-D04 字段扩展 + 路径硬沙箱 | 9 项参数映射 + `check_write_allowance` 前置拦截（§4.4） | 1.5 任务卡 |
| **P1-2** | REQ-D06 topic 扩展 + 需求文档修订（纯内存 → 分层持久化） | `AgentEvent::CustomTopic` 注册式扩展（§6.5） | 1 任务卡 |
| **P1-3** | declare_flow 工具化（主 Agent 声明 DAG 入口） | 编排能力交还主 Agent（§5.4-2） | 1 任务卡 |
| **P2-1** | 批量派发参数 / 主 Agent 声明入口二选一 | §1.4-2 | 1 任务卡 |
| **P2-2** | worktree share/branch 隔离 | 评估登记，暂缓（§2.4-2） | 2 任务卡（若做） |
| **P2-3** | DAG 前端可视化（Mermaid） | §5.4-1 | 0.5 任务卡 |
| **P2-4** | Role 展示标签 / report_to_orchestrator 工具 | §1.4-1、§7.4-3 | 0.5 任务卡 |

### 9.3 与需求文档的冲突点清单

| # | 冲突 | 需求文档立场 | 现状 | 裁决建议 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **嵌套** | REQ-D08 kill 括号（用户裁决）：子 Agent 不允许再嵌套 | maxDepth=3 允许嵌套（`subagent.rs:185`） | **执行用户裁决**：maxDepth 改 1（§8.4-1 改造点清单）；同时修订需求文档 REQ-D08 正式落为"仅主 Agent 可派发" |
| 2 | **事件持久化** | REQ-D06 6.4：内存级不持久化，重启清空 | Critical 必达落库（events 表），Delta 不落库 | **保留现状分层持久化**，修订需求文档（§6.4 论证：崩溃恢复/审计/补投三面）；自定义 topic 若引入按 Delta/Soft 级处理 |
| 3 | **调度上限** | REQ-D01：单轮上限遵守项目约定（12） | maxConcurrent=6 / maxSiblings=5 | 修订：maxConcurrent 提到 12（会话级硬上限），兄弟并发维持 5；或修订需求为 6。需用户裁决 |
| 4 | **Role 语义** | REQ-D01：Role 为 2-5 字自由标签 | Role 固定 5 枚举（禁令 21 防双维度） | 保持枚举 + 新增 display_label 自由文本展示位（§1.4-1），两者不冲突 |
| 5 | **隔离模式** | REQ-D02：三隔离模式 | `isolationMode` 恒 `'none'`（worktree 推迟） | 承认差距（❌），登记 P2 评估；互斥 + 只读裁剪为中间态（§2.4） |

### 9.4 结论

模块 D 整体完成度约 **60%**：调度核心（DAG、等待、恢复、事件基础设施）已远超需求规格，缺口集中在**派发/权限/隔离的"外围控制面"**（批量、自定义类型、路径沙箱、worktree、kill_all）以及**两处与需求文档的实质性冲突**（嵌套深度、事件持久化）。建议按 §9.2 的 P0-1/P0-2/P0-3 先行推进——三者都是"小改动、高裁决价值"，其余按 P1/P2 排期；冲突点 1、2 需要在本文档评审时由用户拍板后回写需求文档。

---

## 附：调查证据索引（文件 → 用途）

| 文件 | 证据用途 |
| :--- | :--- |
| `crates/agent-tools/src/tools/subagent.rs` | run_subagent 工具 / SpawnRequest / 守卫 / 状态机 / 伪造防护（D01/D08） |
| `crates/agent-tools/src/tools/wait_subagents.rs` | 三模式等待 / 事件驱动原语 / inject（D07） |
| `crates/agent-tools/src/write_paths.rs` | 写路径互斥（D02 替代机制） |
| `crates/agent-tools/src/readonly.rs` | 只读工具裁剪（D02/D04） |
| `crates/agent-tools/src/explore_quota.rs` | 探索类文档配额（D04 相关背景） |
| `packages/shared-types/src/subagent.ts` | SubagentDefinition / 隔离模式 / 守卫配置 TS 契约 |
| `crates/orchestrator/src/flow_graph.rs` | DAG 调度器全量（D05） |
| `crates/orchestrator/src/subagent_events.rs` | 子代理三事件发射器（D06/D07） |
| `crates/orchestrator/src/events.rs` | EventQueue / 持久化分流（D06） |
| `crates/orchestrator/src/steering_queue.rs` | 批量推送队列（D07） |
| `crates/orchestrator/src/recovery.rs` | 四级恢复阶梯 / fork 三态 / 预算（D08 resume） |
| `crates/session-loop/src/hooks.rs` | 14 事件钩子面（D06） |
| `crates/session-loop/src/control.rs`、`safe_point.rs` | L3 强停（D08 kill） |
| `crates/conex-db/src/schema.rs`、`agents.rs` | session_agents / events / session_meta 表（D01/D08/D06） |
| `crates/conex-types/src/events.rs` | AgentEvent 枚举 / 背压分级（D06） |
| `crates/agent-provider/src/config.rs` | 全局模型配置（D03） |
| `apps/agent-workbench/src-tauri/src/config/provider.rs` | effective_model / 设置（D03） |
| `apps/crish-desktop/src/components/agent-card/` | AgentCard / AgentTeamBoard / InlineAgentPanel（D08 UI） |
| `apps/agent-workbench/src-tauri/src/core_event_bridge.rs`、`buffer.rs` | 事件终端推送（D06） |
