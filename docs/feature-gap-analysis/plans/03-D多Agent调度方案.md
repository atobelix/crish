# 模块 D — 多 Agent 协同调度框架：实施方案

> 文档类型：实施方案（写文档任务，方案设计师产出）
> 需求来源：`docs/feature-gap-analysis/REQ-agent-engine-capabilities.md` 第五部分（REQ-D01~D08）
> 现状依据：`docs/feature-gap-analysis/REQ-D-现状分析.md`（现状调查结论，本方案直接采用）
> 闭环依据：`docs/multi-agent-repair/00-方案总览.md`（闭环迭代模型、Agent 分配规则、轮次报告格式）
> 编写日期：2026-08-04
> 方案性质：只做**逻辑执行顺序**，不排优先级（不写 P0/P1/P2、不写时间与人员）
> 冲突处理：两处实质冲突（嵌套深度、事件持久化）按用户裁决直接执行；其余冲突按现状分析建议并标注待定夺项

---

## 目录

1. [问题识别](#1-问题识别)
2. [任务分解总览](#2-任务分解总览)
3. [任务卡详细设计](#3-任务卡详细设计)
4. [轮次划分与执行计划](#4-轮次划分与执行计划)
5. [待用户定夺项清单](#5-待用户定夺项清单)
6. [与总方案（multi-agent-repair）的衔接](#6-与总方案multi-agent-repair的衔接)
7. [验证命令索引](#7-验证命令索引)

---

## 1. 问题识别

### 1.1 总体判定：模块 D 完成度约 60%

依据 `REQ-D-现状分析.md` 第 9 节的整体判定表（`REQ-D-现状分析.md:617-627`），模块 D 八条需求的完成状态如下：

| 需求 | 判定 | 一句话结论 | 本方案动作 |
| :--- | :---: | :--- | :--- |
| REQ-D01 动态派发 | 🟡 部分 | 单发完整；Role 固定 5 枚举、无批量派发、上限 6 < 约定 12 | T-D-05（标签）、T-D-06（批量 + 上限） |
| REQ-D02 工作区隔离 | ❌ 缺 | 仅写路径互斥 + 只读裁剪；隔离模式恒 `none` | T-D-11（已决策：暂缓，保持中间态） |
| REQ-D03 默认当前模型 | 🟡 部分 | 继承天然满足；多模型模式全缺 | T-D-10（已决策：不做，仅预留 model_override 扩展点） |
| REQ-D04 自定义 Agent 类型 | 🟡 部分 | 骨架已有；缺 task_type 等 7 项、无路径硬沙箱 | T-D-07、T-D-08（参数收敛为五项）、T-D-14（权限传递层） |
| REQ-D05 DAG 调度 | ✅ 已实现 | flow_graph 完整（超规格） | 保留不动；可视化 T-D-12（已决策：做，F11b） |
| REQ-D06 全局事件总线 | 🟡 部分 | 基础设施远超需求；无 topic Pub/Sub；与"纯内存"冲突 | T-D-04（需求修订） |
| REQ-D07 事件驱动唤醒 | ✅ 已实现 | 三模式等待 + 批量推送 + L1 注入 | 无动作 |
| REQ-D08 生命周期管理 | 🟡 部分 | list/kill/resume 已实现；kill_all 缺；maxDepth=3 与裁决冲突 | T-D-01/T-D-02（嵌套）、T-D-09（kill_all/resume） |

缺口集中在**派发/权限/隔离的"外围控制面"**（批量派发、自定义类型、路径硬沙箱、kill_all、标签），以及**两处与需求文档的实质性冲突**（嵌套深度、事件持久化）。调度核心（DAG、等待、恢复、事件基础设施）已远超需求规格，本方案**不触碰、不降级**。

### 1.2 两处实质冲突（用户裁决，必须改造）

**冲突 1：嵌套深度。** 需求 REQ-D08 kill 项括号内为**用户裁决**："子 Agent 不允许再嵌套子 Agent，仅有主 Agent 有生成子 Agent 的能力以及拥有子 Agent 的生命周期管理"（`REQ-agent-engine-capabilities.md:616`）。现状 `DEFAULT_RECURSION_GUARD.max_depth = 3`（`crates/agent-tools/src/tools/subagent.rs:184-188`，TS 同值 `packages/shared-types/src/subagent.ts:36-42`），允许深度 2、3 的嵌套，测试还锁定该行为（`subagent.rs:832-853`、`904-920`）。

**裁决执行方式（用户明确）**：

- `RecursionGuardConfig.maxDepth` 由 3 改为 **1**（深度 0 = 主 Agent，深度 1 = 子 Agent，子 Agent 无后代）；
- `run_subagent` 仅主 Agent（depth=0）可调用；子 Agent 内调用**一律拒绝**，返回**结构化错误**（不是静默忽略）；
- 工具面同步防护：子 Agent 的工具注册表中**剔除 run_subagent**（防浪费），守卫层 depth 判定是最终防线；
- 连带简化：`flow_graph` 节点不再有后代（快照 depth 恒为 1）；`kill_all` 无需递归后代遍历（见 T-D-09）。

**冲突 2：事件持久化。** 需求 REQ-D06 6.4 写"事件总线为内存级通信，不持久化（重启后清空）"（`REQ-agent-engine-capabilities.md:579`），现状是背压分级持久化（Critical 必达落库、Soft 尽力、Delta 可丢，`conex-types/events.rs:175-181`）。现状分析 §6.4（`REQ-D-现状分析.md:450-461`）从崩溃恢复 / 审计 / 补投三面论证了**分层持久化是正确的**，需求文档 6.4 应修订。

**裁决执行方式（用户已确认）**："Critical 事件落库可重放、Soft/Delta 内存级"，不采纳"纯内存 + 主 Agent 记录"。REQ-D06 修订为**分层持久化**表述（T-D-04）。

### 1.3 派发外围缺口清单（本方案任务来源）

| # | 缺口 | 现状证据 | 处理 |
| :--- | :--- | :--- | :--- |
| 1 | maxDepth=3 允许嵌套 | `subagent.rs:185`、`subagent.ts:37` | T-D-01（守卫） |
| 2 | 子 Agent 内可调 run_subagent | 工具注册表无剔除；`mod.rs:107-109` 全量注册 | T-D-02（工具面 + 结构化错误） |
| 3 | 子 Agent 提示词无"无权派发"声明 | `engine.rs:1097-1106` 注入通道已存在，未用 | T-D-03（ContextInjector 注入） |
| 4 | REQ-D06 需求文档与现状冲突 | `REQ-agent-engine-capabilities.md:579` | T-D-04（修订） |
| 5 | Role 固定 5 枚举，非 2-5 字自由标签 | `subagent.rs:36-47`、`subagent.rs:467-471` enum schema | T-D-05（display_label） |
| 6 | 无批量派发参数 | schema 仅单发（`subagent.rs:456-498`）；wait_subagents 是"批量等" | T-D-06（tasks 批量分支） |
| 7 | 并发上限 6 < 约定 12 | `subagent.rs:185-187`、`subagent.ts:36-42` | T-D-06（maxConcurrent→12） |
| 8 | SubagentDefinition 缺 7 项参数 | `subagent.ts:45-62` 骨架 | T-D-07（定义扩展） |
| 9 | 无 task_type 默认权限映射 | 需求 4.2 表（`REQ-agent-engine-capabilities.md:482-491`） | T-D-07（default_permissions 纯函数） |
| 10 | 无 allowed_write_paths Rust 侧硬沙箱 | `write_paths.rs:289-296` 只做合法性 + 互斥，不做越权拒绝 | T-D-08（check_write_allowance） |
| 11 | 无 enable_command_tools / enable_mcp_tools 独立开关 | `readonly.rs:19-48` 只有整组裁剪 | 参数收敛消解：开关不落地，命令策略按 task_type 默认集下沉（T-D-08 filter_registry 通用化）、MCP 默认继承父 |
| 12 | kill_all 无入口 | 引擎侧无批量终止 API（现状分析 §8.4-2） | T-D-09 |
| 13 | resume 无显式命令 | fork 三态已实现（`recovery.rs:382-457`），无命令面 | T-D-09（resume_subagent） |
| 14 | 引擎侧 SubagentSpawner 未接线 | grep 全仓仅测试域实现（现状分析 §1.2-6） | T-D-13（引擎接线） |
| 15 | 多模型模式全缺 | `config/provider.rs:229-249` 全局单例 | T-D-10（已决策：不做，仅预留 model_override 扩展点随 T-D-07 落地） |
| 16 | share/branch 隔离缺 | `subagent.ts:19-20` 恒 `none` | T-D-11（已决策：暂缓） |
| 17 | DAG 可视化缺 | `FlowNodeState` 可查（`flow_graph.rs:357-369`） | T-D-12（已决策：做，F11b） |
| 18 | 子代理审批无主 agent 裁决路径 | `permission.rs:133-134` 审批人恒为 UI 用户，载荷无请求方字段（`events.rs:184-201`） | T-D-14（权限传递层，用户定夺核心新设计） |
| 19 | REQ-D04 九参数过细 | `REQ-agent-engine-capabilities.md:466-478` 逐项开关冗余 | 收敛为五项（T-D-07/08 修订） |

### 1.4 明确保留/不动的面（非放弃既有功能）

依据需求总原则 6（Additive & Non-Degradation，`REQ-agent-engine-capabilities.md:46`）与用户决策 5，以下**有用功能保留**：

| 保留项 | 证据 | 理由 |
| :--- | :--- | :--- |
| DAG 调度器（REQ-D05，超规格） | `flow_graph.rs` 全量（校验 / advance / 终态 / 恢复 / 合成唤醒） | 已实现且验收全达成，本方案只确认嵌套改造对它的语义影响（快照 depth 恒 1，`flow_graph.rs:974-983`），不做功能裁撤 |
| write_paths 写路径互斥 | `write_paths.rs:129-140`（注册表）、`172-223`（claim）、`303-318`（claim_write_guard） | 与 allowed_write_paths 白名单**分层叠加**（先越权拒绝、再冲突拒绝），互斥机制原样保留 |
| maxSiblings=5（兄弟并发上限） | `subagent.rs:186` | 兄弟并发应小于全局并发，上限 12 只提升 maxConcurrent |
| wait_subagents 三模式等待 | `wait_subagents.rs:41-72` | REQ-D07 已实现，无动作 |
| 恢复阶梯 fork 三态（resume 底座） | `recovery.rs:382-457` | resume_subagent 命令直接复用，不重写 |
| 事件背压分级 + 落库 | `orchestrator/events.rs:106-180` | 冲突 2 的裁决方向（保留现状） |

---

## 2. 任务分解总览

### 2.1 任务编号与归属

本方案共 **14 个任务卡**（T-D-01 ~ T-D-14），其中 T-D-10/T-D-11/T-D-12 已由用户定夺（不做/暂缓/做），T-D-14 为用户定夺的**权限传递层**新设计（并入 R-D2）：

| 任务 | 名称 | 所属需求 | 轮次 | 文件域（独占） |
| :--- | :--- | :--- | :--- | :--- |
| T-D-01 | 嵌套禁止·守卫默认值 + 语义确认 | REQ-D08 裁决 | R-D1 | `agent-tools/subagent.rs`、`shared-types/subagent.ts`、`orchestrator/flow_graph.rs`（注释） |
| T-D-02 | 嵌套禁止·工具面防护 + 结构化错误 | REQ-D08 裁决 | R-D1 | 同上（与 T-D-01 合并分配） |
| T-D-03 | 子 Agent 提示词结构化说明注入 | 用户新增要求 | R-D1 | `apps/agent-workbench/src-tauri/engine.rs` + 引擎测试 |
| T-D-04 | REQ-D06 事件持久化需求修订 | REQ-D06 裁决 | R-D1 | `docs/feature-gap-analysis/`（纯文档） |
| T-D-05 | REQ-D01 补缺·Role 自由标签（display_label） | REQ-D01 | R-D2 | 与 T-D-07 合并分配（共享 subagent.rs） |
| T-D-06 | REQ-D01 补缺·批量派发 + 上限 12 对齐 | REQ-D01 | R-D3 | `agent-tools/subagent.rs`、`shared-types/subagent.ts` |
| T-D-07 | REQ-D04 自定义 Agent 类型（定义 + 默认权限集 + 注册表；九参数收敛为五项） | REQ-D04 | R-D2 | `agent-tools/subagent.rs`、`shared-types/subagent.ts`、`conex-db/schema.rs` + 迁移、`AgentTeamBoard.tsx` |
| T-D-08 | REQ-D04 硬沙箱（allowed_write_paths 拦截 + 命令白名单按 task_type 下沉） | REQ-D04 | R-D2 | `agent-tools/write_paths.rs`、`fs.rs`、`readonly.rs`、`mod.rs` |
| T-D-09 | REQ-D08 生命周期补缺（kill_all + resume_subagent） | REQ-D08 | R-D3 | `orchestrator/`、`session-loop/control.rs`、`conex-db/agents.rs` |
| T-D-10 | REQ-D03 多模型模式（**已决策：不做**，仅预留 model_override 扩展点） | REQ-D03 | 字段随 R-D2（T-D-07） | 并入 T-D-07 契约面（SpawnRequest 字段 + 构造点 None） |
| T-D-11 | REQ-D02 share/branch 工作区隔离（**已决策：暂缓**） | REQ-D02 | 暂缓 | （设计 + 成本保留，不排入） |
| T-D-12 | REQ-D05 DAG 可视化（**已决策：做**，纯 CSS/SVG + 开关） | REQ-D05 | R-D3 后独立小轮（F11b） | 引擎查询命令（`session_commands.rs`）+ 前端（`crish-desktop` workspace 域） |
| T-D-13 | 引擎侧 SubagentSpawner 接线 | REQ-D01 落地前提 | R-D3 | `apps/agent-workbench/src-tauri/`（独占） |
| T-D-14 | **权限传递层**（requester 字段 + 裁决者路由 + 提示词申请指引；用户定夺核心新设计） | 用户定夺新增 | R-D2 | `conex-types/events.rs` 族、`session-loop/tool_events.rs`、`workbench core_run_commands.rs`、`agent-tools/subagent_inject.rs` |

### 2.2 任务卡四要素约定

每个任务卡包含四要素，后续轮次按此格式派单：

1. **输入**：任务书依赖的文档与契约（含已冻结的接口签名）；
2. **产出**：文件域 + 具体改动清单（可审计的交付物）；
3. **验收标准**：可直接执行的命令 + 断言（命令在仓库根目录运行）；
4. **注意事项**：文件所有权、与其他任务的接口约定、禁止触碰面、风险。

### 2.3 逻辑执行顺序（不排优先级）

```
R-D1（裁决落地）→ R-D2（类型与沙箱 + 权限传递层）→ R-D3（批量与生命周期 + 引擎接线）→ 独立小轮（T-D-12 DAG 可视化，已决策做）
```

- R-D1 先行：嵌套禁止是用户裁决，且 R-D2/R-D3 的派发参数扩展（task_type / 批量）都要在"仅主 Agent 可派发"语义下设计；maxDepth=1 先落地可避免后续任务的守卫快照假设错误；
- R-D2 次之：自定义类型（五项参数）与硬沙箱是"派发外围控制面"的主体，其契约（SpawnRequest 扩展字段 + 默认权限集）是 R-D3 引擎接线（T-D-13）的输入；**权限传递层（T-D-14）并入 R-D2**——默认权限集随 task_type 定义装配，子代理审批路由复用既有 ApprovalGate 机制，属同轮契约面扩展；
- R-D3 收尾：批量派发、kill_all/resume、引擎 spawner 接线——三者共同构成"多子代理会话级管理"的完整能力面；T-D-13 依赖 R-D2 冻结的契约，放最后并行不冲突。
- 已定夺项：T-D-10 不做（仅 model_override 字段随 T-D-07 契约面预留）；T-D-11 暂缓（不占用轮次）；T-D-12 做（R-D3 后独立小轮，编排见 00 总方案 §3.14a/F11b）。

---

## 3. 任务卡详细设计

### 3.1 T-D-01 嵌套禁止·守卫默认值 + 语义确认

**定位**：执行冲突 1 裁决的守卫层改造。maxDepth 3→1 是"仅主 Agent 可派发"的最终防线，本轮先行落地权威默认值，并同步所有引用点与测试。

#### 输入

- `REQ-D-现状分析.md` §8.4(1) 改造点清单（`REQ-D-现状分析.md:588-601`）；
- `REQ-agent-engine-capabilities.md:616`（用户裁决原文）；
- 现状代码：`subagent.rs:170-297`（RecursionGuard 全量）、`subagent.ts:22-42`（TS 契约）。

#### 产出（文件域：`crates/agent-tools/src/tools/subagent.rs`、`packages/shared-types/src/subagent.ts`、`crates/orchestrator/src/flow_graph.rs` 注释、文档）

| # | 位置 | 现状 | 改动 |
| :--- | :--- | :--- | :--- |
| 1 | `subagent.rs:185` | `max_depth: 3` | 改 `1`（Rust 侧唯一权威默认值） |
| 2 | `subagent.ts:37` | `maxDepth: 3` | 改 `1`；同步字段注释（`subagent.ts:24`）与模块注释（`subagent.ts:2`） |
| 3 | `subagent.rs:832-853` 测试 `guard_depth_exceeded_rejected` | depth=4 对 max=3 | 改 depth=2 对 max=1 |
| 4 | `subagent.rs:904-920` 测试 `guard_within_limits_allowed` | depth=3 边界通过 | 改 depth=1 边界通过、depth=2 拒绝 |
| 5 | `subagent.rs:7` 模块头注释 | "maxDepth=3 / maxSiblings=5 / maxConcurrent=6" | 改 "maxDepth=1（仅主 Agent 可派发，用户裁决）" |
| 6 | `flow_graph.rs:788-792`、`892-896` | `max_depth: DEFAULT_RECURSION_GUARD.max_depth` | 跟随默认值自动变 1，**不改代码**；确认注释语义：流程节点快照 depth 恒为 1（`flow_graph.rs:974-983`），不受 max_depth=1 影响（子 Agent 无后代，流程节点全部是主 Agent 的直接子节点） |
| 7 | `flow_graph.rs:55-64` FailStrategy / `367-369` Blocked | 不涉及后代遍历 | 仅确认：节点不再有后代后，Block 传播（`flow_graph.rs:935`）仍按依赖边传播，与"父子链"无关，无改动 |
| 8 | `AGENTS.md` 调度规则 | "一轮最多 12 个子 Agent；可嵌套" | 改为"仅主 Agent 可派发子 Agent；子 Agent 深度 1，无派发能力" |
| 9 | `REQ-agent-engine-capabilities.md:616`（REQ-D08 kill 项） | 裁决写在括号里 | 把裁决正式落为规格正文："run_subagent 仅主 Agent（深度 0）可调用；子 Agent 内调用一律拒绝（结构化错误）" |

注意：`check_ancestor_chain` 死锁检测（`subagent.rs:290-297`）**保留**——maxDepth=1 后它仍是对"同主会话重复 fork 自身形成环"的兜底，不删除。

#### 验收标准

```powershell
cargo test -p agent-tools subagent
cargo test -p orchestrator flow_scheduler
npm run typecheck
```

- `guard_depth_exceeded_rejected`：depth=2、max=1 被拒，错误载荷含 `DepthExceeded { current: 2, max: 1 }`；
- `guard_within_limits_allowed`：depth=1 通过，depth=2 拒绝；
- `DEFAULT_RECURSION_GUARD`（Rust 与 TS 两侧）`max_depth == 1`；
- `cargo test -p orchestrator flow_scheduler` 全绿（flow_graph 语义未受影响的回归证据）。

#### 注意事项

- 本任务**不改** `max_siblings`（5）与 `max_concurrent`（6）——上限 12 对齐属于 T-D-06（R-D3），两轮串行改同一常量，避免同轮冲突；
- `subagent.rs` 与 `subagent.ts` 在本轮由 T-D-01/T-D-02 合并给同一 Agent 独占（文件所有权纪律，`00-方案总览.md:54-58`）；
- 引擎侧 spawner（T-D-13）实现时直接使用新默认值，本任务无需处理（当前生产实现未接线，`mod.rs:50-57`）。

---

### 3.2 T-D-02 嵌套禁止·工具面防护 + 结构化错误

**定位**：执行冲突 1 裁决的工具面与错误面改造。守卫层（T-D-01）是最终防线，本任务让"子 Agent 内调 run_subagent"在**工具面就不可见/不可能**，并且即使绕到守卫层也返回**结构化错误**而非静默行为。

#### 输入

- T-D-01 的守卫默认值改造（max_depth=1 已落地）；
- `mod.rs:107-109`（run_subagent 全量注册点）、`readonly.rs:19-48`（既有工具裁剪机制，作为模式参照）。

#### 产出（文件域：`crates/agent-tools/src/tools/subagent.rs`、`crates/agent-tools/src/tools/mod.rs`、`crates/agent-tools/src/readonly.rs`、`crates/conex-types/src/error/`）

**（1）守卫层新增 `NestingDenied` 拒绝变体（最终防线）**

- `RecursionGuardRejection`（`subagent.rs:203-213`）增加 `NestingDenied { current: usize, max: usize }`；
- 判定：`check_recursion_guard`（`subagent.rs:253-276`）中 `snapshot.depth > config.max_depth` 时返回 `DepthExceeded` 的语义保留，但**当 `max_depth == 1` 且 `snapshot.depth >= 1`**（即发起者本身是子 Agent）时，返回专用变体 `NestingDenied`，错误文案带编排指引："你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配。请通过消息/上报向主 Agent 请求派发。"
- 错误码：在 `conex-types` 错误码注册表登记 `SUBAGENT_NESTING_DENIED`（现状 `codes::SUBAGENT_DEPTH_EXCEEDED` 是兄弟/并发/深度的共用码，见 `subagent.rs:220-227` 注释——嵌套拒绝是新语义，单独登记，避免复用旧码造成前端文案歧义）。

**（2）工具面剔除（防浪费，非安全边界）**

- 在 `BuiltinToolConfig`（`mod.rs:40-58`）或工具装配处（`mod.rs:107-109`）增加"发起者身份"判定：子代理 run 装配工具注册表时**剔除 `run_subagent`**（复用 `readonly.rs:40-48` 的白名单 fail-closed 语义：把 `filter_readonly_registry` 的过滤逻辑提取为通用函数，`run_subagent` 从子代理注册表剔除，主 Agent 注册表保留）；
- 执行机制说明：子代理 run 的工具注册表在 spawn 时按"发起者是否主 Agent"裁剪——引擎侧（T-D-13）把 `is_main_agent`（depth==0）标记传入装配点；agent-tools 侧提供纯函数 `filter_out_subagent_spawner(tool_names: &[&str]) -> Vec<&str>`，便于测试与无引擎环境验证；
- `wait_subagents` 的"等待"语义与嵌套无关，**保留**（子 Agent 仍可等待已被派发的兄弟完成？——否：子 Agent 无兄弟（同父下）；保留不剔除，因为它是无害的等待原语，且剔除会破坏工具面对称性。本轮不剔除 wait_subagents，仅剔除 run_subagent）。

**（3）结构化错误透出**

- `SubagentSpawnError`（`subagent.rs:355-364`）增加 `NestingDenied(RecursionGuardRejection)` 变体，`code()` 返回新码，`message()` 透出上述指引文案；
- `RunSubagentTool::execute`（`subagent.rs:517-597`）不额外处理——spawn 通道返回的错误原样映射为 `ToolError` 出站（现状已如此，`subagent.rs:582-585`）。

#### 验收标准

```powershell
cargo test -p agent-tools subagent
cargo test -p agent-tools readonly
cargo test -p conex-types
```

- 新增测试：depth=1 发起者（子 Agent 上下文）调用 spawn → `SubagentSpawnError::NestingDenied`，错误码 `subagent.nesting_denied`，文案含"所有子 Agent 由主 Agent 分配"；
- 新增测试：`filter_out_subagent_spawner` 从工具名列表剔除 `run_subagent`，保留 `wait_subagents` 与其他工具；
- 回归：主 Agent（depth=0）spawn 不受影响（既有单发测试全绿）。

#### 注意事项

- 工具面剔除是**防浪费**，不是安全边界——子 Agent 若有其他通道（如 shell 直调）伪造 spawn，守卫层（T-D-01 + 本任务变体）兜底拒绝；
- 与 T-D-01 同文件域（`subagent.rs`/`mod.rs`），**合并给同一 Agent 顺序执行**（先守卫默认值、后工具面）；
- 错误码登记涉及 `conex-types`——若错误码注册表是冻结契约（现状分析提到"错误码注册表仅含 subagent 域 3 正式码，见 `subagent.rs:216-220` 注释"），需按注册表维护流程追加，不得手改既有码。

---

### 3.3 T-D-03 子 Agent 提示词结构化说明注入

**定位**：用户新增要求——创建子 Agent 时，其系统提示词必须包含结构化声明："你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配"。本任务设计提示词段内容并实现经 **ContextInjector** 注入（System 段），与 C2 `started_at` 注入同通道。

#### 输入

- 用户要求原文（本方案 §1.2 冲突 1 裁决 + 提示词段文案）；
- `engine.rs:1097-1106`（`CONTEXT_INJECTION_ORDER`，System 段首位）、`engine.rs:1116-1123`（`ContextInjection`）、`engine.rs:1154-1159`（`ContextInjector`）、`engine.rs:1184-1189`（`push`）、`engine.rs:1206+`（`render`：注入段汇入 `system_prompt` 面，`engine.rs:1147-1150`）；
- `crates/agent-tools/src/subagent_inject.rs:13-16`（挂载方式 = 经 `ContextInjector::push` 追加 `ContextInjection` 的先例）。

#### 产出（文件域：`apps/agent-workbench/src-tauri/src/engine.rs`、`apps/agent-workbench/src-tauri/src/` 引擎测试）

**（1）提示词段内容设计（冻结文案，测试断言用）**

- 段标题（title）：`子代理角色约束`；
- 段正文（content）：
  > 你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配。如需并行子任务、拆解或汇报，请通过消息/上报通道向主 Agent 提出，由主 Agent 统一派发。
- 段类型（kind）：`ContextInjectionKind::System`——按 `CONTEXT_INJECTION_ORDER`（`engine.rs:1101-1106`）System 在首段位，位于基础系统段之后、Skills 段之前，与其他 System 注入段保持 push 序（`engine.rs:1144-1146` 稳定排序语义）。

**（2）注入通道（与 C2 started_at 同通道）**

- 子代理 run 启动装配 ContextInjector 时（`engine.rs:2565`、`2603`、`2665` 等既有装配点之一，具体以 T-D-13 的 spawn 装配路径为准），追加：
  ```rust
  injector.push(ContextInjection::new(
      ContextInjectionKind::System,
      "子代理角色约束",
      "你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配。\
       如需并行子任务、拆解或汇报，请通过消息/上报通道向主 Agent 提出，由主 Agent 统一派发。",
  ));
  ```
- 与 C2 `started_at`（M4）注入同通道、同机制：`ContextInjection` 是只读注册项（`engine.rs:1108-1114`），本段**不含动态字段**（静态文本，不进 `@dynamic` 标记）；
- 注意 C10 字节级一致断言（`engine.rs:1112-1114`、`1157-1158`）：静态注入段纳入 C10 断言范围，**本段必须被 C10 一致性测试覆盖**（子代理 run 的 system_prompt 与断言快照逐字节一致）；
- **只注入子代理 run，不注入主 Agent run**（主 Agent 的 injector 装配点不 push 本段）——这是测试断言的关键差异点。

**（3）测试**

- 引擎测试：经 `request_system_prompt`（`crates/session-loop/src/testing/mod.rs:144-146`）取子代理 run 的 system_prompt，断言包含"你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配"全文；
- 断言主 Agent run 的 system_prompt **不包含**本段；
- 断言注入段渲染后位于基础系统段之后（`render` 拼接顺序回归）。

#### 验收标准

```powershell
cargo test -p agent-workbench --features testing
cargo test -p agent-workbench engine_context_injection
npm run typecheck
```

- 子代理 run 的 system_prompt 含冻结文案全文；
- 主 Agent run 不含该段；
- 注入顺序断言通过（System 段不破坏既有 M1/M4 拼接契约）。

#### 注意事项

- 本任务文件域（`apps/agent-workbench/src-tauri/engine.rs`）与 T-D-01/T-D-02（`crates/agent-tools`）互斥，可与 R-D1 其他任务并行；
- 若 R-D1 时引擎侧 spawn 装配路径尚未落定（T-D-13 在 R-D3），本任务先实现**注入段常量 + 装配函数 + 测试**（挂在既有装配点或独立函数），由 T-D-13 接入最终 spawn 路径——任务卡产出注明该接口约定；
- 冻结文案如需调整，必须同步更新测试断言与 T-D-02 的结构化错误文案（两者表述一致，防模型混淆）。

---

### 3.4 T-D-04 REQ-D06 事件持久化需求修订

**定位**：执行冲突 2 裁决——REQ-D06 6.4"纯内存"修订为"分层持久化"，并把 Critical 事件落库面写成可核查的清单。纯文档任务，无代码改动。

#### 输入

- `REQ-D-现状分析.md` §6.4 论证（`REQ-D-现状分析.md:450-461`：崩溃恢复 / 审计 / 补投三面）；
- `conex-types/events.rs:175-181`（BackpressureLevel 三分级）、`subagent_events.rs:15-19`（背压分配：started/ended=Critical、progress=Delta、message/tool=Soft）、`orchestrator/events.rs:106-180`（EventQueue 落库分流）、`schema.rs:139-147`（events 表结构）。

#### 产出（文件域：`docs/feature-gap-analysis/REQ-agent-engine-capabilities.md`、`docs/feature-gap-analysis/REQ-D-现状分析.md`）

**（1）REQ-D06 6.4 修订文案（写入需求文档）**

原文（`REQ-agent-engine-capabilities.md:579`）：
> 事件总线为内存级通信，不持久化（重启后清空）。如需持久化审计由主控订阅记录。

修订为（用户已确认的裁决方向）：
> 事件按背压分级持久化：**Critical 事件必达落库（重启后可重放，是崩溃恢复、审计底账与 DAG 补投的校验锚点）**；Soft 事件尽力送达（可落库、不阻塞）；Delta 事件内存级可丢（不落库）。自定义业务 topic 若为纯诊断类按 Delta 处理。如需进一步审计，可由主控订阅记录。

**（2）Critical 事件落库面清单（附证据，供评审核查）**

| 事件域 | 具体事件 | 背压级 | 证据 |
| :--- | :--- | :--- | :--- |
| 子代理生命周期 | `SubagentStarted`（`conex-types/events.rs:561`）/ `SubagentEnded`（`events.rs:593`） | Critical | `subagent_events.rs:15-19` |
| 子代理消息 | `SubagentEventKind::Message` | Soft | `conex-types/events.rs:126-128` |
| 子代理进度 | progress 类 | Delta | `subagent_events.rs:15-19` |
| 恢复域 | recovery-* 五类事件（`recovery.rs:96-104`） | Critical | 恢复阶梯留痕 |
| 工具/审批 | 写操作审计面事件 | Critical | audit.rs 面（现状分析 §8.2-2） |

- 说明：Delta 不落库已由 `orchestrator/events.rs` 分流实现（非持久化分流不阻塞 drive loop，`events.rs:12-14`）；本次修订是**文档对齐现状**，不改代码。

**（3）REQ-D-现状分析.md 回写**

- §6.3 判定与 §6.4 结论标注"用户已裁决：按分层持久化保留，需求文档已修订（REQ-D06 6.4）"；
- §9.3 冲突点 2 状态改"已闭环"。

#### 验收标准

```powershell
（文档评审验收）
```

- `REQ-agent-engine-capabilities.md` REQ-D06 6.4 含"分层持久化 + Critical 落库可重放"表述，无"纯内存"残留；
- Critical 清单与现状代码背压分配一致（评审对照 `subagent_events.rs:15-19`）；
- `REQ-D-现状分析.md` §9.3 冲突点 2 标注已闭环。

#### 注意事项

- 纯文档域，可与 R-D1 代码任务并行（文件域互斥）；
- 需求文档其他部分（REQ-D06 6.1-6.3 的 topic Pub/Sub）**本轮不改**——现状分析 §6.5 建议注册式 `AgentEvent::CustomTopic` 扩展，但那是新增能力而非冲突修复，登记为可选后续项，不占用本轮（避免范围蔓延）。

---

### 3.5 T-D-05 REQ-D01 补缺·Role 自由标签（display_label）

**定位**：需求要求 Role 为 2-5 字自由标签（"Rust 内核分析师"），现状是 5 个固定枚举（`subagent.rs:36-47`）。按现状分析 §1.4-1 方案 A：**枚举不动**（禁令 21 的调度语义，`subagent.ts:8-12`），新增 `display_label` 自由文本展示位。

#### 输入

- `REQ-D-现状分析.md` §1.4-1（方案 A 推荐）；
- `subagent.rs:303-332`（SpawnRequest）、`subagent.rs:456-498`（input_schema）、`subagent.rs:589-595`（出站信封）、`AgentTeamBoard.tsx:92-95`（agentTitle 兜底链）。

#### 产出（文件域：与 T-D-07 合并，见 §3.7 的合并分配）

**（1）契约层**

- `SubagentSpawnRequest`（`subagent.rs:303-332`）增加 `display_label: Option<String>`（2-5 字自由文本，仅展示，不影响调度）；
- run_subagent schema（`subagent.rs:456-498`）增加 `displayLabel` 参数（string，描述："角色展示标签（2-5 字自由文本，可选；仅展示，不影响调度）"）；
- `SubagentSpawnResult`（`subagent.rs:336-351`）增加 `display_label` 回显（可选）。

**（2）落库**

- `session_agents` 表（`schema.rs:50-66`）增加 `display_label` 列（走 migrate.rs 迁移；不复用 `description` 列，保持原语义——description 是任务描述，display_label 是角色标签）；
- 读取链路 `load_session_agents`（`agents.rs:9-89`）补该列。

**（3）前端**

- `AgentTeamBoard.tsx:92-95` 的 `agentTitle` 兜底链改为：`displayLabel` → `description` → `mode` → `id` → "子智能体"（label 优先）；
- TS 契约 `packages/shared-types/src/subagent.ts` 的 SpawnRequest 对应类型补 `displayLabel?: string`。

#### 验收标准

```powershell
cargo test -p agent-tools subagent
cargo test -p conex-db
npm run typecheck
npx vitest run src/components/agent-card
```

- 传入 `"wizard"` 等自由标签不再被拒（现有拒绝测试 `subagent.rs:705-717` 只针对 `role` 枚举字段，displayLabel 是独立字段）；
- 落库读回一致；前端 title 优先显示 displayLabel。

#### 注意事项

- 禁令 21 保持：`role` 枚举与 `capabilityMode` 仍是调度依据，`display_label` 是纯展示位，两维度并存不违反禁令（现状分析 §9.3 冲突 4）；
- 本任务 Rust 侧与 T-D-07 共享 `subagent.rs`/`subagent.ts`/`schema.rs` 文件域，**合并到 R-D2 同一 Agent 顺序执行**；前端 `AgentTeamBoard.tsx` 也在该 Agent 域内（跨 crate 但同轮唯一所有者）。

---

### 3.6 T-D-06 REQ-D01 补缺·批量派发 + 上限 12 对齐

**定位**：需求要求"单次调用创建 N 个并行子 Agent"且"单轮调度上限遵守项目约定（当前 12 个）"。现状是单发（`subagent.rs:456-498` schema 无批量参数）+ 上限 6（`subagent.rs:185-187`）。按现状分析 §1.4-2/3 执行。

#### 输入

- `REQ-D-现状分析.md` §1.4-2/3；
- `flow_graph.rs:866-909`（declare_flow staged-clone 原子语义，作为批量原子性参照）；
- `wait_subagents.rs:41-72`（批量等已存在，批量发补上后形成完整语义）。

#### 产出（文件域：`crates/agent-tools/src/tools/subagent.rs`、`packages/shared-types/src/subagent.ts`、`crates/orchestrator/src/flow_graph.rs` 注释确认）

**（1）上限 12 对齐**

- `max_concurrent` 6 → **12**（`subagent.rs:185-187`、`subagent.ts:36-42` 同步）；`max_siblings` **保持 5**（兄弟并发应小于全局并发，现状分析 §1.4-3）；
- 边界值测试同步（`subagent.rs:832-920` 测试域）；
- `flow_graph.rs:974-983` 预算判定引用默认值，自动跟随；确认注释。

**（2）批量派发参数（tasks 批量分支）**

- run_subagent schema 增加 `tasks` 数组参数：
  ```json
  "tasks": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "prompt": { "type": "string" },
        "role": { "type": "string", "enum": ["researcher","implementer","reviewer","debugger","planner"] },
        "displayLabel": { "type": "string" },
        "capabilityMode": { "type": "string", "enum": ["read-only","read-write","execute","all"] },
        "timeoutMs": { "type": "number" },
        "description": { "type": "string" }
      },
      "required": ["prompt"]
    }
  }
  ```
- **单发与批量互斥**：`tasks` 与 `prompt` 同时提供 → 结构化错误 `invalid_input`（防歧义）；
- **原子语义**（对齐 declare_flow staged-clone，`flow_graph.rs:866-909`）：执行时先对全部 N 个任务做**前瞻快照统一守卫**——depth 共享、siblings/concurrent 按 N 预加后过 `check_recursion_guard`（`subagent.rs:253-276`）；**任一拒绝 → 整体失败零 run**，不产生部分成功；
- 全部通过 → 逐条落库（`session_agents`）+ 启动，返回结果数组（每条 subagentId/subagentRunId/sessionId/status）；
- `SubagentSpawner` trait（`subagent.rs:400-407`）增加 `spawn_many(&[SubagentSpawnRequest]) -> Result<Vec<SubagentSpawnResult>, SubagentSpawnError>` 默认实现（循环单发不满足原子性，故 trait 层面提供批量接口；引擎侧 T-D-13 实现）；
- 说明文档：批量派发（无依赖平铺并行，REQ-D01 语义）与 DAG 调度器（有依赖关系，REQ-D05）**并存**——主 Agent 按任务关系选择；DAG 保留不动（用户决策 5）。

**（3）批量与嵌套裁决的交互**

- 批量派发只允许主 Agent 调用（深度 0）——T-D-02 的工具面剔除与守卫变体对批量同样生效（批量入口复用 run_subagent 工具面，不新增独立工具）。

#### 验收标准

```powershell
cargo test -p agent-tools subagent
cargo test -p orchestrator flow_scheduler
npm run typecheck
```

- 新增测试：一次派发 3 个任务全部成功，返回 3 条唯一 id；
- 新增测试：N 个任务中任一触发守卫拒绝（如并发预加超 12）→ 整体失败，**零 run**（断言 session_agents 无新增行——测试域经 DbSpawner 验证，`subagent.rs:1150`）；
- 新增测试：tasks 与 prompt 同时提供被拒；
- 边界测试：maxConcurrent=12 时第 13 个并发被拒；maxSiblings=5 保持原测试。

#### 注意事项

- `subagent.rs`/`subagent.ts` 在 R-D3 由本任务独占（T-D-06），与 R-D1（T-D-01/02）、R-D2（T-D-07）串行——轮间所有权转移，遵守 `00-方案总览.md:59-60` 纪律；
- `spawn_many` 的引擎侧实现依赖 T-D-13（同轮 workbench 域），本任务只冻结 trait 契约与 agent-tools 内测试（用测试域 spawner 验证原子性）；
- 不新增"批量派发走 DAG"的强制路径——两机制并存，编排权在主 Agent。

---

### 3.7 T-D-07 REQ-D04 自定义 Agent 类型（定义 + 默认权限集 + 注册表；参数收敛为五项）

**定位**：REQ-D04 的 9 项参数中现状仅约 4 项有等价物（`subagent.ts:45-62` 骨架）。按用户定夺"**权限不要太细**"（`调研-权限传递层.md` §3），九参数**收敛为五项**：保留 `name` / `description` / `system_prompt` / `task_type` / `allowed_write_paths`（可选），删除 `enable_write_tools` / `enable_command_tools` / `enable_mcp_tools` / `allowed_read_paths`——前三项由 task_type 默认集派生，读路径默认全工作区无安全增益；主 agent 配置负担从"逐项决策"降到"（可选的）一处路径"。并合并执行 T-D-05（display_label，共享文件域）与 T-D-10 的 `model_override` 扩展点预留（已决策：多模型不做）。

#### 输入

- `REQ-agent-engine-capabilities.md` §4.1（9 项参数表，`:466-478`）与 §4.2（默认映射表，`:480-491`）；
- `调研-权限传递层.md` §2.2（六套默认权限集）与 §3.2（参数收敛表）；
- `REQ-D-现状分析.md` §4.4（字段映射建议，`:309-327`）；
- `subagent.ts:44`（插件 manifest 声明面，禁令 22）。

#### 产出（文件域：`packages/shared-types/src/subagent.ts`、`crates/agent-tools/src/tools/subagent.rs`、`crates/conex-db/src/schema.rs` + migrate、`apps/crish-desktop` 前端、T-D-05 的 display_label 全量）

**（1）TS 契约扩展（`subagent.ts:45-62` SubagentDefinition）**

```ts
export type SubagentTaskType =
  'analysis' | 'design' | 'review' | 'implementation' | 'organization' | 'commit';

interface SubagentDefinition {
  // ...既有字段不变...
  readonly taskType?: SubagentTaskType;
  readonly allowedWritePaths?: readonly string[];
  readonly modelOverride?: string;   // 扩展点预留（T-D-10：多模型不做），不暴露 UI，不实现逻辑
}
```

> 收敛声明：`enableWriteTools` / `allowedReadPaths` / `enableCommandTools` / `enableMcpTools` **不在定义契约中**（九参数收敛为五项，验收断言"字段不存在"）。

**（2）Rust 侧（`subagent.rs` 新增）**

- `TaskType` 枚举（6 变体）+ `parse`/`as_str`（wire 名 kebab-case，对齐 TS）；
- **`default_permissions(task_type) -> DefaultPermissions` 纯函数**（六套默认权限集，`调研-权限传递层.md` §2.2 表落地）：

  | task_type | 工具集 | 写路径沙箱 | 命令策略 | 备注 |
  | :--- | :--- | :--- | :--- | :--- |
  | analysis | 只读白名单（复用 `readonly.rs:27-34`） | 无写 | 无命令 | 只读调研，不产生任何改动 |
  | design | 只读白名单 + 仅 `write_file` | 方案文档目录（配额凭证式，granted=true quota=1） | 无命令 | 可产出一份设计文档 |
  | review | 同 design | 评审报告目录（缺省不限制 + 配额 1） | 无命令 | 可产出一份评审报告 |
  | implementation | 全工具集 | 工作区根 `workspace_root`（即天然白名单） | 构建/测试类命令（语义层 CommandClass 过滤） | 可读写工作区 + 常用命令 |
  | organization | 只读白名单 + 写 | 主 agent 显式给目录（不配 = 退化为只读） | 无命令 | 可在指定文档目录整理/编辑 |
  | commit | 仅 `shell_command` | 无写文件工具 | 命令前缀过滤 git（T-D-08 细化） | 仅 git 操作，不碰其他 |

  - 默认集由**系统硬编码**，spawn 时引擎自动装配（T-D-13）；主 agent 不用配、也不必知道细节，文档/UI 只展示"一句话边界"；
  - 默认集在会话级 `permissionMode` 之上叠加：父会话 full-access 不传导给子代理（`调研-权限传递层.md` §2.1 独立价值）；
- `SubagentSpawnRequest`（`subagent.rs:303-332`）增加 `task_type` / `allowed_write_paths`（全部 Option，None = 不覆盖继承值）；**不增加** enable_* 与 allowed_read_paths 字段（参数收敛）；追加 `model_override: Option<String>`（扩展点预留：默认 None = 继承当前模型，引擎侧恒不消费，见 §3.10）；
- **合并语义**（现状分析 §4.4 实施要点 2）：引擎侧 spawn 时按"定义字段 > task_type 默认集"合并生效——定义显式字段优先，缺省取 `default_permissions(task_type)`；
- 禁令 21 保持：task_type 是新维度，不并入 role/capabilityMode（`subagent.ts:8-12`）；
- T-D-05 并入：`display_label: Option<String>` 字段 + schema `displayLabel` 参数 + 出站信封回显（见 §3.5）。

**（3）定义注册表（引擎侧，T-D-13 实现落位、本任务冻结结构）**

- `SubagentDefinitionRegistry`：`HashMap<String, SubagentDefinition>` + 持久化（session_meta 或插件 manifest 加载，`subagent.ts:44` 注释已预留插件面）；
- run_subagent 的 `agentId`（`subagent.rs:463-466`）解析完整定义 → 与显式参数合并 → 装配 SpawnRequest；
- "定义后可多次实例化"：agentId 每次解析同一份定义，天然支持多次。

**（4）落库**

- `session_agents`（`schema.rs:50-66`）新列：`task_type`、`display_label`、`allowed_write_paths_json`（走 migrate.rs 迁移）；enable_* 布尔已删除，由 task_type 默认集派生后落入 run 级策略（见 T-D-08 约定）；`model_override` 不落库（扩展点预留、恒 None）；
- `load_session_agents`（`agents.rs:9-89`）读回新列。

**（5）前端**

- T-D-05 的 `agentTitle` label 优先改造（`AgentTeamBoard.tsx:92-95`）。

#### 验收标准

```powershell
cargo test -p agent-tools subagent
cargo test -p conex-db
npm run typecheck
npx vitest run src
```

- `default_permissions` 六套默认集逐一断言（implementation→全工具+工作区沙箱+构建/测试命令、analysis→只读白名单无命令、commit→仅 git 命令、design/review→写配额=1 等，对齐 `调研-权限传递层.md` §5 测试锚点）；
- **参数收敛断言**：定义契约中不存在 `enable_write_tools` / `enable_command_tools` / `enable_mcp_tools` / `allowed_read_paths` 字段（编译/类型级断言）；`default_permissions` 六映射 + 定义字段覆盖合并语义；
- 定义实例化测试：注册一个含五项参数的 definition，agentId 解析出完整 SpawnRequest，合并语义正确（显式字段覆盖 task_type 默认）；
- 迁移测试：新列可读写，旧库兼容（迁移脚本幂等）；
- display_label 读回 + 前端 title 优先；
- `SubagentSpawnRequest` 全构造点显式 `model_override: None`（编译器强制）。

#### 注意事项

- 本任务与 T-D-08 的**契约冻结点**：T-D-08 需要消费 `allowed_write_paths` 与 task_type 派生的命令策略。本任务冻结约定：spawn 请求携带原始字段，**run 级 WritePolicy 结构由 T-D-08 在 `write_paths.rs` 定义**，引擎侧（T-D-13）把字段与默认集合并后转成策略再注册——本任务不依赖 T-D-08 的具体类型，只按字段名约定传递；
- `subagent.rs`/`subagent.ts`/`schema.rs` 本轮由本任务独占（含 T-D-05 合并项与 T-D-10 的 model_override 字段），T-D-08 只碰 `write_paths.rs`/`fs.rs`/`readonly.rs`/`mod.rs`——文件域互斥；
- 命令策略"仅 git / 构建测试白名单"的口径统一：在 T-D-08 的工具裁剪机制上按 task_type 默认策略实现，本任务只冻结 `DefaultPermissions` 语义；口径差异（语义层 CommandClass vs 前缀过滤）按 `调研-权限传递层.md` 开放问题 6.5 评审统一；
- 多模型扩展点：`model_override` 字段注释指向 `调研-可视化与扩展点.md` §3 与本文 §3.10，**不得附带任何消费逻辑**（违背"不做"决策）。

---

### 3.8 T-D-08 REQ-D04 硬沙箱（allowed_write_paths 拦截 + 命令策略按 task_type 下沉）

**定位**：REQ-D04 验收关键——"allowed_write_paths 为 Rust 侧硬性沙箱拦截，即使 Agent 的 Prompt 中未约束写入范围，系统也会在文件写入时进行路径校验并拒绝越界操作"（`REQ-agent-engine-capabilities.md:492`）。现状 `validate_write_path`（`write_paths.rs:289-296`）只做合法性 + 互斥登记，不做越权拒绝。按用户定夺"权限不要太细"：**enable_command_tools / enable_mcp_tools 逐项开关不再作为定义字段**（命令过滤下沉为 task_type 默认策略、MCP 默认继承父代理面），**allowed_read_paths 不再落地**（读不改状态、默认全工作区可读，无安全增益，`调研-权限传递层.md` §3.2）。

#### 输入

- `REQ-D-现状分析.md` §4.4 实施要点 1（白名单与互斥的分层关系：先越权拒绝、再冲突拒绝）；
- `write_paths.rs:172-223`（claim 多路径原子声明）、`:303-318`（claim_write_guard 接线位）、`:333-355`（overlaps 前缀语义 + Windows 大小写折叠——路径匹配逻辑直接复用）；
- `readonly.rs:19-48`（白名单 fail-closed 裁剪，推广为通用机制）；
- `调研-权限传递层.md` §2.2（命令策略按 task_type 默认）与开放问题 6.5（命令白名单口径）。

#### 产出（文件域：`crates/agent-tools/src/write_paths.rs`、`crates/agent-tools/src/tools/fs.rs`、`crates/agent-tools/src/readonly.rs`、`crates/agent-tools/src/tools/mod.rs`）

**（1）`WritePathPolicy` + `check_write_allowance`（越权拒绝）**

- 在 `write_paths.rs` 新增 run 级写策略结构：
  ```rust
  /// run 级硬性写入允许集（None = 不限制路径；implementation 默认 = 工作区根）
  pub enum WritePathPolicy { Allowed(Vec<PathBuf>), Unrestricted }
  ```
- 新增纯函数 `check_write_allowance(policy: &WritePathPolicy, target: &Path) -> Result<(), WriteAllowanceError>`：
  - 校验逻辑复用 `write_paths.rs:333-355` 的前缀语义与 Windows 大小写折叠（`a/b/c.txt` 与白名单 `a/b/` 匹配、`a/b` 与 `a/bc` 不匹配）；
  - `Allowed(paths)` 且 target 不在任何白名单前缀下 → 拒绝，返回结构化错误 `tool.write_not_allowed`（新错误码登记 conex-types），载荷含目标路径与允许范围提示；
  - `Unrestricted` → 放行。
- **挂接顺序**：写工具（write_file/delete_file/delete_dir，`fs.rs`）执行前——**先 `check_write_allowance`（越权拒绝）→ 再 `claim_write_guard`（冲突拒绝，`write_paths.rs:303-318`）**；两机制串行叠加，互斥注册表（`write_paths.rs:129-140`）原样保留（用户决策 5）；
- 语义说明：白名单是"允许集"（权限沙箱），互斥是"并发控制"，一先一后不冲突。

**（2）命令策略下沉（按 task_type 默认集，替代 enable_command_tools 开关）**

- 把 `filter_readonly_registry`（`readonly.rs:40-48`）的白名单 fail-closed 过滤逻辑**推广为通用 `filter_registry(registry, predicate)`**（保留原有 fail-closed 语义）；
- 工具级裁剪：`analysis/design/review/organization` → 只读白名单（`readonly.rs:27-34`）+ design/review 附加 `write_file`；`commit` → 仅 `shell_command`（无写文件工具）；`implementation` → 全工具集；
- 命令级过滤（shell 命令执行门禁处，按 task_type 派生策略）：
  - `commit`：命令前缀过滤（仅允许 `git` 开头）；
  - `implementation`：构建/测试类命令白名单（复用 `permission.rs:119-121` `semantics::analyze` 的 `CommandClass` 语义层分类，不维护命令前缀表）；
  - 其余 task_type：无命令（工具面已剔除 shell_command，命令级过滤为兜底）；
- **MCP 工具**：不做独立开关，默认继承父代理 MCP 面（`调研-权限传递层.md` §3.2）；需要单独收紧/放开走权限申请通道（T-D-14）。

**（3）只读路径限制（allowed_read_paths：不落地）**

- 用户定夺收敛：`allowed_read_paths` 已从定义契约删除，`ReadPathPolicy` / `check_read_allowance` **不实现**（读不改状态、默认全工作区可读；确有需要走权限申请，`调研-权限传递层.md` §3.2）；如后续需要，结构可与 WritePathPolicy 同构扩展，本轮不做。

**（4）测试**

- 越权写拒绝：Allowed(["docs/"]) 下写 `src/main.rs` → `tool.write_not_allowed`；写 `docs/a.md` → 放行；
- 前缀边界：`a/b` 与 `a/bc` 不误匹配、Windows 大小写折叠生效；
- 与互斥叠加：白名单放行但路径被他人占用 → 仍返回 `tool.write_path_conflict`（互斥错误，`write_paths.rs:79-109`）；
- 工具级裁剪：read-only 裁剪回归 + `commit` 无写文件工具 + 命令前缀过滤（非 git 前缀拒绝）+ implementation 命令分类过滤。

#### 验收标准

```powershell
cargo test -p agent-tools write_paths
cargo test -p agent-tools readonly
cargo test -p agent-tools fs
cargo test -p agent-tools mod
cargo test -p conex-types
```

- 硬沙箱拦截在 Rust 侧生效（不依赖 Prompt 遵守）；
- 互斥机制回归全绿（未破坏用户决策 5 的保留项）；
- 命令策略断言：commit 子代理 `git status` 放行、`npm install` 拒绝；implementation 子代理构建/测试类命令放行、网络发布类拒绝；
- 契约断言：定义字段面无 enable_command_tools / enable_mcp_tools（参数收敛）。

#### 注意事项

- 本任务不碰 `subagent.rs`/`subagent.ts`/`schema.rs`（T-D-07 独占）；引擎侧策略注册（T-D-13）按 T-D-07 冻结的字段名约定消费；
- `tool.write_not_allowed` 错误码登记走 conex-types 注册表流程（与 T-D-02 相同纪律）；
- 硬沙箱是**权限层**，不是并发层——两个语义都必须在错误文案中区分（越权 vs 冲突），前端与主 Agent 才能正确编排；
- 命令白名单口径（semantic CommandClass vs 前缀过滤）两类并存，按 `调研-权限传递层.md` 开放问题 6.5 在实现前评审统一一次。

---

### 3.9 T-D-09 REQ-D08 生命周期补缺（kill_all + resume_subagent）

**定位**：list ✅ / kill ✅ / resume ✅（恢复阶梯 fork，比需求更强）已实现；**kill_all ❌ 无入口**（现状分析 §8.3）。maxDepth=1 落地后（T-D-01），kill_all 无需递归后代遍历——子 Agent 无后代，kill_all = 终止主 Agent 全部 running 子代理。

#### 输入

- `REQ-D-现状分析.md` §8.4-2（kill_all 建议）与 §8.4-3（resume 命令建议）；
- `control.rs:43-67`（L0-L3 协议，ForceCancel→L3）、`control.rs:205-207`（L3 队列面）、`safe_point.rs:117-121`（终止优先级聚合）；
- `recovery.rs:21-27`（fork 接线契约）、`:1026`（fork_and_reassign）、`:392-457`（ForkContextMode / decide_fork_context / ForkRecord 区）、`:259-329`（Episode 预算）；
- `agents.rs:9-89`（load_session_agents 查询条件扩展位）。

#### 产出（文件域：`crates/orchestrator/`、`crates/session-loop/src/control.rs`、`crates/conex-db/src/agents.rs`）

**（1）kill_all 引擎入口**

- 新增批量终止服务（orchestrator 域，如 `KillAllSubagents` 命令/工具）：
  - 过滤条件：`session_agents` 行 `parent_session_id` = 主会话 且 status ∈ running（`agents.rs:17-23` 查询条件扩展）；
  - 逐个对子代理 run 发 L3 `request_force_cancel`（`control.rs:205-207` 队列面复用）；
  - 终态统一归一 failed（`subagent.rs:141-147` 写面规则自动生效）；
  - **无递归**：maxDepth=1（T-D-01）后子 Agent 无后代，无需递归遍历——任务卡明确此简化，避免为不存在的层级写递归逻辑；
  - FlowScheduler 侧每个终态事件自然触发 `on_subagent_terminal`（`flow_graph.rs:1096-1210`）推进，无需额外编排；
  - 产出保留：写路径回收站（trash）与 `session_agent_messages` 级联保留（`schema.rs:68-85`）——既有机制覆盖，无新增。
- 返回结果：终止的 subagent_id 列表 + 未终态汇总（结构化载荷，供主 Agent 编排）。

**（2）resume_subagent 命令**

- 新增 `resume_subagent` 引擎命令：入参 `subagent_id` + `prompt`（可选）；
- 内部走 `fork_and_reassign`（`recovery.rs:1026`，接线契约 `recovery.rs:21-27`）：原 run 置 failed（`recovery.rs:22-27`）、fork 新 run 承接同一目标；
- 上下文继承走既有三态判定 `decide_fork_context`（`recovery.rs:418-435`：≤24h 窗口 + ≤80% 字节占比 → Verbatim；超限摘要；空内容 New）；
- 消费 Episode 预算（`recovery.rs:259-329` 操作指纹 + 默认 3）——与恢复阶梯共用预算池，防无限 fork；
- 前端按钮（可选，不阻塞验收）：`AgentCard`/`AgentTeamBoard` 的 failed 卡片提供 resume 动作。

**（3）测试**

- kill_all：spawn 3 个 running 子代理 → kill_all → 全部 failed、产出保留、FlowScheduler 无残留节点；
- resume_subagent：kill 后 resume → fork 新 run、上下文三态判定正确、预算消费记账；
- 崩溃一致性域（`orchestrator/tests/crash_consistency.rs`）扩展：kill_all 后重启，session_agents 状态一致。

#### 验收标准

```powershell
cargo test -p orchestrator
cargo test -p orchestrator crash_consistency
cargo test -p conex-db
npm run typecheck
```

- kill_all 后全会话 running 子代理清零（终态 failed），日志与产出保留（回收站 + 消息表）；
- resume 后新 run 生效、原 run failed、ForkRecord 落库；
- 不破坏既有 list/kill 测试。

#### 注意事项

- 本任务文件域（orchestrator + session-loop/control.rs + conex-db/agents.rs）与 R-D3 的 T-D-06（agent-tools + shared-types）、T-D-13（workbench）互斥；
- `control.rs` 与 `recovery.rs` 是既有稳定域——只做**消费端新增**（新命令入口 + 查询扩展），不改 L0-L3 协议与 fork 算法本体；
- resume 是恢复阶梯的显式命令面，不是新恢复机制——阶梯 1 自动重试仍优先（`recovery.rs:198-236`），resume 供主 Agent/用户手动兜底。

---

### 3.10 T-D-10 REQ-D03 多模型模式（已决策：不做，仅预留扩展点）

**定位**：REQ-D03 的默认继承语义天然满足（`config/provider.rs:229-249` 全局单例解析、`subagent.rs:394-396` 子代理 run 同通道）。**用户已定夺：多模型模式不做**（不实现设置开关、不做 per-run 覆盖逻辑、不做 AI 自动选型），**但预留扩展点**——`SubagentSpawnRequest` 增加 `model_override: Option<String>` 字段（默认 None = 继承当前模型），引擎侧 resolve 链**不写任何分支逻辑**，UI/调度均不暴露。理由：大模型做决策/规划、小模型做执行是趋势；字段在结构体里是"文档化契约"，未来做时只加逻辑不改形状，本轮成本 ≈ 0（`调研-可视化与扩展点.md` §3）。

#### 预留内容（随 T-D-07 的 SpawnRequest 契约面落地，不独立占轮次）

1. **字段预留**：`SubagentSpawnRequest`（`subagent.rs:303-332` 结构体末尾）追加：
   ```rust
   /// 模型覆盖（扩展点预留：None = 继承当前模型；多模型模式未实现，
   /// 引擎侧恒不消费此字段——见 docs/feature-gap-analysis/调研-可视化与扩展点.md §3）
   #[serde(default, skip_serializing_if = "Option::is_none")]
   pub model_override: Option<String>,
   ```
   `SubagentSpawnRequest` 为纯 Rust 结构体（无 serde 派生），字段不存在 wire 兼容问题；
2. **构造点全覆盖**：全部 spawn 请求构造点显式补 `model_override: None`（流程节点 `flow_graph.rs:985-999`、测试域 spawner `subagent.rs:648/1150`、`orchestrator/tests/*`、`recovery.rs` 等——编译器逐个报错驱动），编译期即保证全量覆盖；
3. **不实现边界**：run_subagent 工具 schema（`subagent.rs:456-498`）**不加 model 参数**（`additionalProperties: false` 不变，UI 与工具面不暴露）；引擎侧 `effective_model` 解析链（`config/provider.rs:190-196`）零改动；前端 providerProfiles/modelCatalog 零改动；
4. **文档标注**：字段注释指向本小节与调研文档；未来实现位 = 子代理 run 装配 ProviderCall 时若 `model_override = Some(m)` 覆盖全局解析结果（`调研-可视化与扩展点.md` §3.3），本轮不写消费代码。

#### 验收标准（随 T-D-07 / T-D-13 合并执行）

```powershell
cargo test -p agent-tools subagent
cargo test --workspace
```

- `SubagentSpawnRequest` 实例化处必须显式写 `model_override: None`（编译器强制，无需独立测试）；
- `cargo test --workspace` 全量回归（纯类型变更）；
- 默认继承语义不变：spawn 未携带 model 覆盖参数时，子代理 run 解析出的模型与主 Agent 一致（T-D-13 验收覆盖）；
- 前端零改动（typecheck 无 diff）。

#### 不做 `provider_override`

03-D 原方案写了 `+ 可选 provider_override`，但"大/小模型分工"场景下 provider 通常同源（同一网关不同模型），先留 `model_override` 单字段即可；真做多模型时 provider 覆盖可再扩展（同字段面追加），避免一次预留两个没人用的字段（`调研-可视化与扩展点.md` §3.4）。

---

### 3.11 T-D-11 REQ-D02 share/branch 工作区隔离（已决策：暂缓）

**定位**：REQ-D02 三模式中 `inherit` 天然满足（共享工作区 + 写互斥兜底），`share`/`branch` 依赖 Git Worktree，原登记为**有意推迟**（`subagent.ts:19-20` 注释 "worktree/process 推迟"）。**用户已定夺：暂缓**——保持现有中间态（写路径互斥 + 只读裁剪 + allowed_write_paths 硬沙箱 + 回收站/审计可恢复），决定做时另起独立轮。本节保留原设计要点与成本评估备查，不排入任何轮次。

#### 设计要点（若用户决定做）

1. **类型扩展**：`SubagentIsolationMode` 扩展为 `'inherit' | 'share' | 'branch'`（`subagent.ts:19-20`）；`SubagentSpawnRequest` 增加 `isolation_mode`（`subagent.rs:303-332`）；落库 `session_agents` 新列（走迁移）；
2. **worktree 管理器**（引擎侧新模块）：创建/登记/清理/合并四接口；spawn 前检查仓库状态（脏工作区禁建 worktree）；
3. **run 装配**：子代理 run 的 workspace_root 指向 worktree 路径（`ToolContext.workspace_root` 会话级注入，`mod.rs:36-38`）；
4. **终止清理**：branch 模式子代理终态时自动清理 worktree；有未合并产出时保留并通知（需求 `REQ-agent-engine-capabilities.md:426`）；
5. **恢复交互**：恢复阶梯 3 fork（`recovery.rs:382-457`）与 worktree 的交互语义——fork 的新 run 指向哪个 worktree、清理归属；
6. **与既有机制的关系**：互斥（`write_paths.rs`）与只读裁剪（`readonly.rs`）保留为 inherit 模式兜底；allowed_write_paths 硬沙箱（T-D-08）在三种模式下都生效。

#### 成本评估

- 工作量约 **2 个完整任务卡**（worktree 管理器 1 卡 + 调度/恢复/清理集成 1 卡），另加引擎接线（T-D-13 域）的额外改动；
- 收益分析：单用户桌面场景下，写互斥 + 只读裁剪 + 硬沙箱已覆盖大部分冲突场景；worktree 的价值在于"破坏性实验不污染主工作区"，但 Crish 的写面已走回收站（trash）与审计（audit.rs）保障可恢复；
- **建议（务实中间态）**：当前以"写路径互斥 + 只读裁剪 + allowed_write_paths（T-D-08 后）+ 冲突短窗等待（现状分析 §2.4-3 的可选增强）"作为隔离能力的落地形态；share/branch 登记为可选后续项，用户决定做时按上述设计另起一轮（2 个任务卡 + 集成验证）。

#### 验收命令（若实施）

```powershell
cargo test -p orchestrator isolation
cargo test -p agent-tools write_paths
（集成验证：branch 修改不影响主工作区、终止后 worktree 清理、未合并产出保留通知）
```

**状态注记**：用户已定夺暂缓（`00-总方案与轮次编排.md` §5.0 #2）；上述设计与成本评估保留备查，不再更新。

---

### 3.12 T-D-12 REQ-D05 DAG 可视化（已决策：做，纯 CSS/SVG + 开关可下线）

**定位**：REQ-D05 5.4 可视化标注为"可选增强"（`REQ-agent-engine-capabilities.md:534-536`）。状态数据已在 `FlowNodeState`（`flow_graph.rs:357-369`）与 `flow_state` 键中可查（`flow_graph.rs:664-678` 持久化键）。**用户已定夺：做**——纯 CSS/SVG 渲染（符合视觉体系、零图形库依赖），以 `flow_dag_visible` 功能开关（默认关）保证随时可下线；渲染方式由原方案的 Mermaid **改为纯 CSS/SVG**（项目无图形库依赖先例，Mermaid 的运行时解析/主题不一致/样式注入与 token 体系冲突；DAG 节点规模 ≤ 20，手写分层布局够用）。排期：R-D3 后独立小轮（00 总方案 F11b，见 `00-总方案与轮次编排.md` §3.14a）。

#### 设计要点（依据 `调研-可视化与扩展点.md` §2）

1. **只读查询命令**：引擎侧新增 `get_flow_snapshot(session_id)`，返回 `{ nodes: [{ id, task, dependsOn, parallel, isComposite, state, subagentRunId }] }`——读 `flow_declaration` + `flow_state` + `load_session_agents` 按 `subagent_run_id` 拼装状态；放 `session_commands.rs` 域（对齐既有 `get_session_meta` / `load_session_agents` 命令位）；不新增写入面（编排权仍在主 Agent）；
2. **前端渲染**：纯 CSS/SVG——`FlowDagView` 区段组件（RuntimeSection 基座）+ `flowDagLayout.ts` 纯函数层（拓扑分层/边生成/状态色映射/空态判定/计数文案）+ `flowDagStore.ts`（zustand 事件 store）；节点 DOM 卡片（token 变量：`--bg-card`/`--hairline-strong`/`--radius-lg`），状态色映射对齐 AgentTeamBoard 语义（pending 灰 / running 蓝 spinner / completed 绿 / failed 红 / blocked 橙降透明度）；连线用 CSS 边框线方案；空态不渲染；
3. **功能开关**：`flow_dag_visible`（localStorage 直读键 `crish_flow_dag_visible`，`'true'/'1'` → true，缺失/脏值 → false 安全默认）；**不混入 settingsStore.appSettings**（引擎事件权威回灌会覆盖）；开关关 → 区段零挂载、零请求、零事件订阅；彻底下线 = 删前端组件，引擎零改动（查询命令是通用只读面保留无害）；
4. **数据流**：事件驱动刷新（subagent-started/ended 信封补 `flowNodeId`，二期增强）或首版降级"快照 + 轻量轮询（≥2s）"；Blocked 由快照刷新兜底；
5. **测试锚点**：纯函数层（拓扑分层三节点链 [0,1,2]、并行同层、状态色五态映射、空态判定、计数文案）+ 组件（渲染/空态/开关 off 零挂载——**可下线验收锚点**）+ hook（开关读取）+ store（事件入列）；门禁含 `npm run check:ui-layer`。

#### 成本评估

- 工作量约 **0.5~1 任务卡**（只读查询命令 + 前端组件 + 开关 + 测试）；
- 收益：可观测性提升；**不影响任何验收标准**（REQ-D05 验收 4 条全部与引擎行为相关，可视化是附加）。

#### 验收命令（F11b 轮执行）

```powershell
cargo test -p crish-agent-workbench
npm run typecheck
npx vitest run src
npm run check:ui-layer
```

---

### 3.13 T-D-13 引擎侧 SubagentSpawner 接线（REQ-D01 落地前提）

**定位**：现状分析 §1.2-6 确认：`SubagentSpawner` 生产实现**未落地**（grep 全仓仅测试域实现：`subagent.rs:1150` DbSpawner、`orchestrator/tests/flow_scheduler.rs:112`、`multi_agent.rs:155`、`recovery.rs:1410`），`BuiltinToolConfig.subagent_spawner`（`mod.rs:50-57`）默认 None，未接线时 run_subagent 返回 `common.unsupported`（`subagent.rs:559-564`）。本任务在 `apps/agent-workbench` 实现生产 spawner，是 REQ-D01 全部能力（单发/批量/自定义类型）的落地前提。

#### 输入

- `subagent.rs:388-407`（SubagentSpawner 职责清单：守卫快照 → 落库 → 独立 run → 流程关联）；
- T-D-06 冻结的 `spawn_many` trait 契约、T-D-07 冻结的 SpawnRequest 扩展字段（五项参数 + model_override）与六套默认权限集、T-D-08 的 WritePathPolicy 与命令策略、T-D-03 的提示词注入段、T-D-14 的权限申请上下文（ApprovalRequester 装配）；
- 恢复阶梯 2 的通知面（`recovery.rs:333-380` steering 条目）与 L1 注入通道（`wait_subagents.rs:387-388` inject）。

#### 产出（文件域：`apps/agent-workbench/src-tauri/` 独占）

**（1）生产 spawner 实现**

- 实现 `SubagentSpawner`（`subagent.rs:401-407`）：
  1. **守卫快照采集**：深度沿 parent_run_id 链（主会话 = 0，直接子代理 = 1），兄弟/并发按未终态记账（对齐 M6 并发预算口径，`flow_graph.rs:974-983`）→ `check_recursion_guard` + `check_ancestor_chain`（`subagent.rs:253-297`）；depth>0 发起 → T-D-02 的 `NestingDenied`（结构化错误）；
  2. **session_agents 落库**（`schema.rs:50-66`：agent_id / subagent_run_id / parent 链 / depth / 新列 task_type、display_label、allowed_write_paths_json 等）；
  3. **独立 run 启动**：走 core_run_task 同通道（`subagent.rs:394-396` 注释），**子代理 run 装配 ContextInjector 时注入 T-D-03 的提示词段**（与 started_at 同通道）+ **按 task_type 默认权限集装配**（工具注册表裁剪：只读白名单 / 全工具 / 仅 git；命令策略：构建测试类 / git 前缀；`filter_registry`，T-D-08 结构）+ **定义字段覆盖合并**（显式 allowed_write_paths 生成 WritePathPolicy 注册，`Allowed` 优先于默认工作区根）+ **装配 T-D-14 的权限申请上下文**（ApprovalRequester 注入，子代理审批默认路由给主 agent 裁决）；
  4. **流程关联**：`flow_node_id`/`is_composite`（`subagent.rs:326-331`）随落库记录，终态事件经 `on_subagent_terminal` 回传 FlowScheduler（`flow_graph.rs:1096-1210`）；
  5. `spawn_many`（T-D-06）批量实现：前瞻快照统一守卫 → 全部通过后逐条落库启动（原子语义）。
- `BuiltinToolConfig.subagent_spawner` 接线（`mod.rs:50-57`）在引擎装配点注入生产实现；wait_channel（`mod.rs:57`）同步接线。

**（2）引擎集成测试**

- 单发/批量/自定义类型端到端：run_subagent → 子代理 run 启动 → 终态事件回传 → 主 Agent 经 steering 收到通知；
- 嵌套拒绝端到端：子代理 run 内 run_subagent → 结构化错误（工具面剔除 + 守卫兜底双验证）；
- 提示词注入断言（T-D-03 的 request_system_prompt 验证）；
- 默认权限集端到端：spawn 未带权限字段 → 子代理 run 按 task_type 默认集装配（analysis 无写工具、commit 仅 git、implementation 工作区沙箱）；
- 权限申请链路端到端：子代理 run 触发审批 → 请求携带 requester=子代理 run id → 主 agent 裁决（Mock 裁决器）；
- DAG 端到端：declare_flow → spawn 节点 run → 终态推进（对齐 `orchestrator/tests/multi_agent.rs` 契约层等价面，`multi_agent.rs:777` 注释）。

#### 验收标准

```powershell
cargo test -p agent-workbench
cargo test --workspace
npm run typecheck
```

- run_subagent 不再返回 `common.unsupported`（生产环境接线完成）；
- 全部测试域 spawner（DbSpawner 等）行为对齐生产实现（契约一致回归）；
- 默认模型继承链路确认：spawn 未携带 model 覆盖参数时，子代理 run 经 ProviderCall 装配链解析出的模型与主 Agent 一致（`config/provider.rs` 全局单例链路，REQ-D03 默认继承语义——对应 00 总方案附录 A REQ-D03 行，`00-总方案与轮次编排.md` 附录 A）；`model_override` 恒为 None 且无消费逻辑（T-D-10 扩展点预留终态）。

#### 注意事项

- 本任务依赖 R-D1（T-D-01/02/03）与 R-D2（T-D-06/07/08/14）冻结的契约，是 **D 链上最后一个引擎侧代码任务**（F11b 的 T-D-12 为其后只读查询 + 前端组件）；
- workbench 文件域在 R-D3 由本任务独占（T-D-06/T-D-09 分属 agent-tools 与 orchestrator 域）；
- 若 workbench 域代码量过大（spawn 装配点分散），允许把"前端展示/按钮"拆给 T-D-09 的 Agent（不同文件域），但 spawn 装配路径必须本任务独占。

---

### 3.14 权限传递层设计摘要（用户定夺核心新设计）

> 完整设计见 `docs/feature-gap-analysis/调研-权限传递层.md`（默认权限集 §2.2、申请时序 §2.3、数据结构 §2.4、复用点清单 §2.5、测试锚点 §5）。本节为任务书可引用的摘要。

**用户定夺**：子代理的只读/权限相关设定**不要太细**——主 agent 逐项配置反而搞不清楚、考虑不全面子代理就挂了；改为「**系统默认权限集**（安全、够用、由系统给）+ **权限申请传递层**（子代理实在有需要 → 向主 agent 申请 → 主 agent 审批后放行）」。

**三层模型**（自上而下，裁决优先级：安全基线 > 默认集 > 显式覆盖 > 运行时申请）：

```
┌─ 第 3 层：运行中权限申请（PermissionRequest → 主 agent 裁决 → 放行/拒绝）┐
├─ 第 2 层：主 agent 显式配置（可选覆盖：allowed_write_paths；默认全 None）──┤
├─ 第 1 层：系统默认权限集（task_type 六枚举默认映射，spawn 时自动装配）─────┤
└─ 第 0 层：安全基线（红线命令 Deny / C3 大面积回退审批，不可豁免）────────┘
```

**核心机制（复用现有 ApprovalGate，只改"谁裁决"）**：

- 现状：`PermissionVerdict::NeedsApproval` → `ApprovalGateImpl.request_approval`（广播 approval-requested + oneshot 等待）→ `core_approve_tool / core_deny_tool`（UI 命令）→ `approval-resolved`；`permission.rs:133-134` 明确"审批人 = 用户，主 Agent 仅转呈"；
- 改动面（约 3 处小改，零新机制）：
  1. **请求载荷扩展**：`PermissionRequest`（`events.rs:184-201`）新增 `requester_run_id: Option<String>`（None = 主 agent；Some = 子代理 run id）与 `reason: Option<String>`（子代理申请理由）——新增字段全 Option、serde 缺省，向后兼容；
  2. **裁决者路由**：新增纯函数 `route_approval(source) -> Arbiter`——`ApprovalSource::MainAgent → Arbiter::User`（现状不变）；`ApprovalSource::Subagent { run_id, task_type } → Arbiter::MainAgent`（新默认；无父 run 兜底 User）；子代理身份从 `ToolExecCtx.run_id` + 父 run 关系（`SubagentEmitContext.parent_run_id`）判定；
  3. **广播目标分支**：`ApprovalGateImpl.request_approval` 按路由结果转呈——子代理来源的请求路由给主 agent 裁决面（主 agent 裁决动作 = 复用同一 `resolve` 入口，oneshot 等待天然支持"审批者换成主 agent"）；主 agent 可转用户（`ArbiterDecision::EscalateToUser`，本轮可先只做 Approved/Denied，转用户为可选分支）；
- **ApprovalGate trait 签名扩展**（方案 A，`tool_events.rs:69-77`）：`request_approval(..., requester: Option<&ApprovalRequester>)`，`ApprovalRequester { run_id, task_type, reason }`——参数全 Option，向后兼容现有实现与 MockGate；
- **不改的安全基线**：红线不可豁免（`permission.rs:96-107`）、plan 模式写类直接拒绝、I-02 待审批集合防伪造校验（`core_run_commands.rs:175-203`）、approval-requested/resolved 事件原样落库。

**默认权限集（随 T-D-07 的 `default_permissions` 落地，见 §3.7）**：六种 task_type 各一套"够用"默认，由系统硬编码、spawn 时自动装配，主 agent 不用配也不必知道细节（文档/UI 只展示一句话边界）；**父会话 full-access 不传导**——子代理的边界不由父会话宽容度决定。

**拒绝路径与提示词指引**（对齐 `explore_quota.rs` 先例）：

- 拒绝文案：「权限申请被主 agent 拒绝：<理由>。如需继续，请把诉求与替代方案以消息形式回报主 agent（说明为什么需要该权限、将执行什么操作、影响范围），由主 agent 重新裁决或调整任务后重试。」；
- 子代理提示词注入段（`permission_relay_section`，随 T-D-14 落地）：「你执行任务时使用系统分配的默认权限（按任务类型自动配置，无需你申请）。当任务确需超出默认权限的操作时：不要自己假设已获得授权，也不要绕过工具边界；发起权限申请并说明理由（需要什么、做什么、影响什么）；申请由主 agent 审批：批准后继续执行，拒绝后按拒绝理由调整做法；不要反复用相同理由重复申请，被拒后先回报主 agent 沟通。」

**测试锚点**（`调研-权限传递层.md` §5）：路由纯函数分类；申请→主 agent 放行链路（MockGate 记录 requester）；拒绝→子代理收到含"主 agent 拒绝/回报主 agent"指引；主 agent 链路不回归（requester=None → UI 流程）；超时 Expired 不中断；六默认集装配断言；参数收敛断言。

---

### 3.15 T-D-14 权限传递层（requester 字段 + 裁决者路由 + 提示词申请指引）

**定位**：用户定夺"权限不要太细 + 权限申请传递层"的落地任务（设计摘要见 §3.14，完整设计见 `调研-权限传递层.md`）。默认权限集装配随 T-D-07 的 `default_permissions` 与 T-D-13 的 spawner 落地；本任务落地**申请→主 agent 裁决**链路本身。并入 R-D2（F8）。

#### 输入

- `调研-权限传递层.md` 全文（§1 现状机制 / §2 设计 / §4 接线 / §5 测试锚点）；
- `crates/conex-types/src/events.rs:184-201`（PermissionRequest）、`crates/session-loop/src/tool_events.rs:58-77`（ApprovalGate）、`crates/session-loop/src/tool_exec.rs:657-669`（ask 装配）、`apps/agent-workbench/src-tauri/src/core_run_commands.rs:124-262`（ApprovalGateImpl）、`:1726-1775`（裁决入口）；
- `crates/agent-tools/src/explore_quota.rs`（凭证模式先例）、`subagent_inject.rs`（注入段先例）。

#### 产出（文件域：`crates/conex-types/src/events.rs` 族、`crates/session-loop/src/tool_events.rs` + 新建路由模块、`apps/agent-workbench/src-tauri/src/core_run_commands.rs`、`crates/agent-tools/src/subagent_inject.rs`）

**（1）请求载荷扩展（conex-types）**

- `PermissionRequest` 新增 `requester_run_id: Option<String>`（None = 主 agent run；Some = 子代理 run id，裁决者路由依据）与 `reason: Option<String>`（子代理申请理由，提示词协议要求"需要更高权限时说明理由"）；
- 新增字段全 Option + `#[serde(default, skip_serializing_if = "Option::is_none")]`，向后兼容；随载荷 jsonb 落库，无 schema 变更（`调研-权限传递层.md` §4.2）。

**（2）ApprovalGate 签名扩展 + 路由纯函数（session-loop）**

- `ApprovalGate::request_approval` 签名追加 `requester: Option<&ApprovalRequester>`（`ApprovalRequester { run_id, task_type: Option<String>, reason: Option<String> }`，`tool_events.rs:69-77`）；参数全 Option，现有实现与 MockGate 编译兼容；
- 新增 `ApprovalSource` 枚举与 `route_approval(source) -> Arbiter` 纯函数（MainAgent→User；Subagent→MainAgent；无父 run 兜底 User）——独立模块可单测；
- 执行器（`tool_exec.rs`）在 `call_verdict` 返回 NeedsApproval 时，从 `ToolExecCtx.run_id` + 父 run 关系构造 `ApprovalRequester`（`None` = 主 agent run）透传给 gate。

**（3）广播目标路由（workbench）**

- `ApprovalGateImpl.request_approval`（`core_run_commands.rs:207-262`）载荷构造（`:216-226`）填充新字段；广播按 `route_approval` 分支——子代理来源的请求转呈主 agent 裁决面（事件仍照发 approval-requested，前端可观测）；
- 主 agent 裁决动作复用 `core_approve_tool / core_deny_tool`（`:1726-1775`）的 `resolve`（`:175-203`）——主 agent 裁决 = 调用同一入口（新增引擎侧裁决命令或在主 agent run 的 steering 面注入审批待办，任务书按 `调研-权限传递层.md` §2.3 第 4 步定稿）；审批超时沿用 `APPROVAL_TIMEOUT=120s`；
- **守卫不变**：待审批集合校验（I-02 防伪造）与状态机恢复（`:191-202`）原样保留。

**（4）子代理提示词权限申请指引（agent-tools）**

- 新增 `permission_relay_section(task_type, 边界一句话)` 固定注入段（文案见 §3.14 拒绝路径节；对齐 `explore_docs_credential_section` 固定结构、可快照断言）；
- 挂载：引擎 spawn 子代理 run 时经 `CONTEXT_INJECTION_ORDER` 挂载（T-D-13 装配路径接入，本任务只实现段常量 + 装配函数 + 测试）；
- 快照测试（对齐 `explore_quota.rs:587-606` 模式）。

**（5）测试**

- 路由纯函数：MainAgent→User；Subagent→MainAgent；子代理 run 无父 run 时兜底 User；
- 链路（MockGate，对齐 `approval.rs:151-167`）：子代理 run 内工具触发 NeedsApproval → gate 收到 requester.run_id=子代理 run id + reason → 主 agent 裁决 Approved → 工具执行成功、approval-requested/resolved 事件齐全；
- 拒绝路径：主 agent 裁决 Denied → 子代理收到 `UserDenied` 结果，错误文案含"主 agent 拒绝"与"回报主 agent"指引（对齐 `explore_quota.rs:165-174` 断言风格）；
- 不回归：主 agent run 内工具审批 requester=None → 路由 User → 既有 UI 审批流程全绿；
- 超时：主 agent 不裁决 → Expired → 子代理 run 不中断、工具返回 approval_expired（`approval.rs:253-264` 先例）。

#### 验收标准

```powershell
cargo test -p conex-types
cargo test -p session-loop
cargo test -p agent-tools
cargo test -p crish-agent-workbench
cargo test --workspace
npm run typecheck
```

- `route_approval` 分类断言全绿；申请→主 agent 放行/拒绝链路断言全绿；
- 子代理 run 的 system_prompt 含权限申请指引段（快照断言）；
- 主 agent 审批链路零回归（既有 approval 测试全绿）；
- `PermissionRequest` 载荷序列化兼容（缺省字段旧解析器可读）。

#### 注意事项

- 事件基线不变（41）：本轮只扩展 PermissionRequest 载荷字段，不新增事件类型（`00-总方案与轮次编排.md` §3.16 F8 行）；
- `core_run_commands.rs` 所有权：F7（EG2 E-A2）→ F8（D2-3）→ F9（CF3 A8），轮间转移按 §3.17 表执行；
- `events.rs` 族所有权：F6（CF2 C-A1）→ F8（D2-3）→ F9（CF3 A4）；
- 死锁风险（主 agent 正在 wait 该子代理时裁决）按 `调研-权限传递层.md` 开放问题 6.4 处理：超时兜底 + 路由层检测"裁决者 run 正在 wait 该子代理"时转用户或自动拒绝——实现前做一次时序评审；
- 持久化待办（主 agent 离线时申请悬挂）第一版不做（开放问题 6.1，P2），路由层预留"裁决方不在线 → 转用户兜底"分支。

---

## 4. 轮次划分与执行计划

### 4.1 轮次总览（逻辑顺序，不排优先级）

| 轮次 | 目标 | 任务包 | 并行依据 |
| :--- | :--- | :--- | :--- |
| R-D1 | 嵌套禁止裁决全量落地 + 提示词结构化 + 事件持久化修订 | T-D-01+T-D-02（合并）、T-D-03、T-D-04 | agent-tools / workbench-engine / docs 三域互斥 |
| R-D2 | 自定义 Agent 类型（五项参数 + 默认权限集）+ 硬沙箱 + 展示标签 + **权限传递层** | T-D-05+T-D-07（合并）、T-D-08、**T-D-14** | 契约文件域（subagent.rs/subagent.ts/schema.rs/前端）、沙箱文件域（write_paths.rs/fs.rs/readonly.rs/mod.rs）、传递层文件域（events.rs 族/tool_events.rs/core_run_commands.rs/subagent_inject.rs）三域互斥 |
| R-D3 | 批量派发 + 上限对齐 + 生命周期补缺 + 引擎接线 | T-D-06、T-D-09、T-D-13 | agent-tools / orchestrator+session-loop+conex-db / workbench 三域互斥 |
| R-D3 后独立小轮 | DAG 可视化（已决策：做） | T-D-12 | 引擎查询命令（session_commands.rs）与前端（crish-desktop workspace 域）两域互斥；编排见 00 总方案 F11b |

轮间依赖：R-D2 依赖 R-D1（maxDepth=1 语义先落地，权限设计不悬空）；R-D3 依赖 R-D2（T-D-13 消费 T-D-06/07/08/14 契约）；R-D3 结束后全模块验收（`cargo test --workspace` + 前端基线对照），T-D-12 独立小轮随后执行（依赖 R-D3 的 spawner 接线产物），再入总方案 F12 终验。

### 4.2 R-D1 轮：嵌套禁止 + 提示词结构化 + 事件持久化修订

#### 4.2.1 问题识别

- 冲突 1（嵌套）的三层落地缺口：守卫默认值（T-D-01）、工具面 + 结构化错误（T-D-02）、提示词告知（T-D-03）；
- 冲突 2（事件持久化）的需求文档修订（T-D-04）；
- 本轮是"用户裁决的工程化"，全部为裁决强制项，不做范围蔓延。

#### 4.2.2 任务分解与 Agent 分配

| Agent | 任务包 | 文件域（独占） | 任务卡 |
| :--- | :--- | :--- | :--- |
| Agent-D1-1 | 嵌套禁止全量（守卫 → 工具面 → 错误 → 文档） | `crates/agent-tools/src/tools/subagent.rs`、`crates/agent-tools/src/tools/mod.rs`、`crates/agent-tools/src/readonly.rs`（仅提取通用过滤函数，与 Agent-D1-1 自身使用）、`packages/shared-types/src/subagent.ts`、`crates/orchestrator/src/flow_graph.rs`（仅注释确认）、`crates/conex-types/src/error/`（错误码登记）、`AGENTS.md`、`REQ-agent-engine-capabilities.md:616`（REQ-D08 回写） | T-D-01、T-D-02 |
| Agent-D1-2 | 提示词结构化注入 | `apps/agent-workbench/src-tauri/src/engine.rs`、引擎测试文件 | T-D-03 |
| Agent-D1-3 | REQ-D06 需求修订 | `docs/feature-gap-analysis/REQ-agent-engine-capabilities.md`（REQ-D06 6.4）、`docs/feature-gap-analysis/REQ-D-现状分析.md`（回写） | T-D-04 |

说明：Agent-D1-1 与 Agent-D1-2 共享 `flow_graph.rs`？——否：Agent-D1-1 只做注释确认（只读 + 注释），Agent-D1-2 不碰 flow_graph。`engine.rs` 与 `flow_graph.rs` 不同文件。文件域互斥成立。

#### 4.2.3 并行要点（文件域互斥）

- `crates/agent-tools` 与 `apps/agent-workbench/src-tauri` 为不同 crate，编译互不阻塞（workbench 依赖 agent-tools 的**既有**契约，T-D-01/02 只改默认值与新增变体——注意：T-D-02 新增 `RecursionGuardRejection::NestingDenied` 与 `SubagentSpawnError::NestingDenied` 会改变 agent-tools 的公共 API，workbench 若已引用需同步——但生产 spawner 未接线（T-D-13 才做），workbench 当前不消费这些类型，并行安全）；
- `docs/` 纯文档域，与代码零交集；
- 共享元文件：本轮无 `package.json`/根 `Cargo.toml` 改动（错误码登记在 `crates/conex-types` 内，非根元文件）。

#### 4.2.4 汇总与验证

- 轮次报告按 `00-方案总览.md` §5 模板填写（已完成/未完成/新发现/遗留/验证结果/输出清单）；
- 验证门禁：
  ```powershell
  cargo test -p agent-tools subagent
  cargo test -p agent-tools readonly
  cargo test -p agent-tools mod
  cargo test -p orchestrator flow_scheduler
  cargo test -p conex-types
  cargo test -p agent-workbench
  npm run typecheck
  ```
- 通过标准：嵌套相关测试全部按新语义（depth=1 通过、depth=2 拒绝）；提示词注入断言通过；REQ-D06 修订完成且无"纯内存"残留；
- 输出到 R-D2：T-D-01/02 冻结的"仅主 Agent 可派发"语义、T-D-03 冻结文案、R-D1 轮次报告。

### 4.3 R-D2 轮：自定义 Agent 类型（五项参数）+ 硬沙箱 + 展示标签 + 权限传递层

#### 4.3.1 问题识别

- REQ-D04 的参数缺失（数据结构面）与验收未达成——按用户定夺"权限不要太细"，九参数**收敛为五项**（删 enable_* 与 allowed_read_paths，`调研-权限传递层.md` §3.2）；
- REQ-D01 的 Role 自由标签（展示面）；
- **权限传递层**（用户定夺核心新设计）：子代理审批路由给主 agent 裁决（T-D-14）；
- 依据 R-D1 的 maxDepth=1 语义，权限设计在"子 Agent 无后代"前提下展开（task_type 默认集不涉及嵌套授权）。

#### 4.3.2 任务分解与 Agent 分配

| Agent | 任务包 | 文件域（独占） | 任务卡 |
| :--- | :--- | :--- | :--- |
| Agent-D2-1 | 定义扩展（五项参数 + model_override 扩展点）+ 默认权限集 + 注册表 + display_label | `packages/shared-types/src/subagent.ts`、`crates/agent-tools/src/tools/subagent.rs`、`crates/conex-db/src/schema.rs` + migrate、`crates/conex-db/src/agents.rs`、`apps/crish-desktop`（AgentTeamBoard.tsx 等展示组件） | T-D-05、T-D-07 |
| Agent-D2-2 | 硬沙箱 + 命令策略下沉 | `crates/agent-tools/src/write_paths.rs`、`crates/agent-tools/src/tools/fs.rs`、`crates/agent-tools/src/readonly.rs`、`crates/agent-tools/src/tools/mod.rs`、`crates/conex-types/src/error/`（错误码登记） | T-D-08 |
| Agent-D2-3 | 权限传递层（载荷扩展 + 路由 + 提示词申请指引） | `crates/conex-types/src/events.rs` 族、`crates/session-loop/src/tool_events.rs` + 新建路由模块、`apps/agent-workbench/src-tauri/src/core_run_commands.rs`、`crates/agent-tools/src/subagent_inject.rs` | T-D-14 |

#### 4.3.3 并行要点（文件域互斥）

- 三个 Agent 文件域**零重叠**（契约文件 / 沙箱文件 / 传递层文件）；但 D2-1 与 D2-2 编译在同一 crate（agent-tools）、D2-3 跨三个 crate 的独立文件——并行期间各自只编译自己的模块；crate 级集成（spawn 装配）留给 R-D3 的 T-D-13，本轮的模块级测试独立可跑；
- 契约冻结点（T-D-07 → T-D-08 / T-D-13 / T-D-14）：SpawnRequest 扩展字段名（`task_type` / `allowed_write_paths`，不含 enable_* 与 allowed_read_paths——参数收敛）+ `model_override`（扩展点预留）+ `ApprovalGate::request_approval` 签名扩展与 `ApprovalRequester` 结构在**本轮开始前**由主调度 Agent 写入各任务包，三方按冻结签名开发，轮内不沟通；
- `conex-types` 错误码登记：T-D-02（R-D1）已登记 `SUBAGENT_NESTING_DENIED`，本轮 T-D-08 登记 `WRITE_NOT_ALLOWED`——不同码位，无冲突；若注册表文件是单一源文件，由 Agent-D2-2 独占（`conex-types/src/error/` 列入其文件域）；`conex-types/src/events.rs` 族由 Agent-D2-3 独占（载荷扩展），与错误码文件不同，无重叠；
- 前端 `AgentTeamBoard.tsx` 归 Agent-D2-1 独占；Agent-D2-2/D2-3 不碰前端。

#### 4.3.4 汇总与验证

- 轮次报告（同上模板）；
- 验证门禁：
  ```powershell
  cargo test -p agent-tools subagent
  cargo test -p agent-tools write_paths
  cargo test -p agent-tools readonly
  cargo test -p agent-tools fs
  cargo test -p agent-tools mod
  cargo test -p conex-db
  cargo test -p conex-types
  cargo test -p session-loop
  cargo test -p crish-agent-workbench
  npm run typecheck
  npx vitest run src
  ```
- 通过标准：`default_permissions` 六套默认集断言全绿；定义契约无 enable_* / allowed_read_paths 字段（参数收敛）；越权写拒绝 + 互斥叠加回归；display_label 前端优先显示；`route_approval` 分类断言 + 申请→主 agent 放行/拒绝链路断言全绿；
- 注意：前端基线失败项（oklchColorGuard / userFacingErrors / sessionRustDbWriteModel / DiffCard.perf）与本轮无关，对照基线判定，不把基线失败计入本轮失败；
- 输出到 R-D3：冻结契约（SpawnRequest 五项扩展 + model_override + WritePathPolicy 签名 + ApprovalRequester/route_approval 签名 + spawn_many trait）、R-D2 轮次报告。

### 4.4 R-D3 轮：批量派发 + 生命周期补缺 + 引擎接线

#### 4.4.1 问题识别

- REQ-D01 批量派发 + 上限 12 对齐（契约与测试域）；
- REQ-D08 kill_all + resume 显式命令；
- REQ-D01 落地前提：引擎侧生产 spawner 接线（消费 R-D1/R-D2 全部冻结契约）。

#### 4.4.2 任务分解与 Agent 分配

| Agent | 任务包 | 文件域（独占） | 任务卡 |
| :--- | :--- | :--- | :--- |
| Agent-D3-1 | 批量派发 + 上限 12 | `crates/agent-tools/src/tools/subagent.rs`、`packages/shared-types/src/subagent.ts`、`crates/orchestrator/src/flow_graph.rs`（注释确认）、agent-tools 测试域 | T-D-06 |
| Agent-D3-2 | kill_all + resume_subagent | `crates/orchestrator/src/`、`crates/session-loop/src/control.rs`、`crates/conex-db/src/agents.rs`、`apps/crish-desktop`（可选按钮） | T-D-09 |
| Agent-D3-3 | 引擎 spawner 接线 | `apps/agent-workbench/src-tauri/`（独占） | T-D-13 |

#### 4.4.3 并行要点（文件域互斥）

- 三任务分属 `crates/agent-tools` + `shared-types` / `crates/orchestrator` + `session-loop` + `conex-db` / `apps/agent-workbench`——crate 域互斥；
- 依赖方向：T-D-13 编译依赖 T-D-06 的 `spawn_many` trait 与 T-D-07 的字段（R-D2 已冻结，轮内无等待）；T-D-06 的测试域 spawner（`subagent.rs:1150`）独立验证原子性，不依赖 workbench；
- `apps/crish-desktop` 前端：T-D-09 的可选按钮与 T-D-13 的 spawn 装配**不同目录**（components vs src-tauri），若两者都要动前端，按文件粒度划给各自 Agent；
- 共享元文件：本轮无根 `package.json`/根 `Cargo.toml` 改动。

#### 4.4.4 汇总与验证

- 轮次报告（同上模板）；
- 验证门禁（全模块最终验证）：
  ```powershell
  cargo test --workspace
  npm run typecheck
  npx vitest run src
  ```
- 通过标准：批量派发原子性（任一拒绝零 run）；kill_all 清零 + 产出保留；resume fork 生效；run_subagent 生产环境不再 `unsupported`；默认权限集端到端装配断言；权限申请链路端到端（子代理申请 → 主 agent 裁决）；DAG 端到端（declare_flow → 节点 run → 终态推进）全绿；
- 输出：最终轮次报告 + 已定夺项状态（T-D-10 不做 / T-D-11 暂缓 / T-D-12 做，见 §5）。

---

## 5. 待用户定夺项清单

**2026-08-04 用户已对全部三项定夺**（对应 00 总方案 §5.0 决策总览）：多模型**不做**（仅预留扩展点）、share/branch **暂缓**、DAG 可视化**做**。下表标注决策状态，原设计要点与成本保留备查：

| 项 | 需求来源 | 决策 | 设计要点 | 成本 | 落点 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **多模型模式** | REQ-D03 | **已决策：不做** | 仅预留 `SubagentSpawnRequest.model_override: Option<String>` 字段（默认 None，全部构造点显式 None），引擎零逻辑、UI 零暴露、run_subagent schema 不加参数 | 约 0（字段随 T-D-07 契约面落地） | 随 T-D-07/T-D-13 合并执行，见 §3.10 修订 |
| **share/branch 工作区隔离** | REQ-D02 | **已决策：暂缓** | worktree 管理器（创建/登记/清理/合并）+ 脏工作区禁建 + workspace_root 指向 worktree + 终止清理（未合并产出保留通知）+ 恢复阶梯交互 | 约 2 完整任务卡 + 引擎接线增量 | 保持现有中间态；决定做时另起独立轮，见 §3.11 |
| **DAG 可视化** | REQ-D05 5.4（可选） | **已决策：做** | 只读查询命令 `get_flow_snapshot`（节点状态 + 依赖边）+ **纯 CSS/SVG** 渲染（FlowDagView + flowDagLayout 纯函数层）+ `flow_dag_visible` 开关（默认关、可下线） | 约 0.5~1 任务卡 | R-D3 后独立小轮（00 总方案 F11b），见 §3.12 修订 |

决策后的插入路径：多模型 → 字段随 T-D-07（R-D2）落地，不排轮次；share/branch → 另起独立轮（2 任务卡 + 集成验证）；可视化 → R-D3 后独立小轮（F11b）。

---

## 6. 与总方案（multi-agent-repair）的衔接

### 6.1 定位关系

- `docs/multi-agent-repair/00-方案总览.md` 的 R0-R7 是多 Agent 协同修复的执行方案（R7 产出 Agent 调度能力本体，`00-方案总览.md:74`）；本方案是**修复收敛后**、针对需求文档模块 D 的**能力补齐方案**（feature-gap-analysis 域），两者是"收敛地基 → 能力扩展"的前后关系；
- 本方案的任务卡可直接作为 R7 之后的新轮次执行依据；执行时复用 `04-Agent功能需求设计.md` 的 C1-C10 能力规格语境（若其仍有效）。

### 6.2 闭环模型复用

每一轮（R-D1/R-D2/R-D3）遵循 `00-方案总览.md:24-46` 的闭环迭代模型：问题识别 → 任务分解 → Agent 分配 → 并行修复 → 结果汇总 → 验证门禁 → 输出成为下一轮输入。轮内各 Agent 不互相依赖、不互相等待；轮内阻塞降级为"未完成"写入轮次报告由下一轮承接。

### 6.3 分配纪律复用

- 每轮最多 12 个 Agent（本方案每轮 2-3 个，按需分配）；
- 同轮文件域互斥（本方案每轮已按 §4 表格划定）；
- 文件所有权纪律（`00-方案总览.md:54-60`）：共享元文件唯一所有者、轮间所有权转移——`subagent.rs`/`subagent.ts` 在 R-D1（T-D-01/02）→ R-D2（T-D-07）→ R-D3（T-D-06）三轮间按任务包转移所有权，不允许两轮残留未完成编辑；
- 轮次报告格式严格按 `00-方案总览.md:89-127` 模板（元信息/已完成/未完成/新发现/遗留/验证结果/输出清单）。

### 6.4 安全红线

执行时遵守 `05-协同操作约束与安全.md`（checkpoint 恢复、git 操作安全、删除铁律、故障恢复阶梯）——本方案涉及 `session_agents` 迁移（T-D-07）与 kill_all（T-D-09），落库与终止操作必须按红线走审批与回收站语义，不做破坏性默认。

---

## 7. 验证命令索引

| 命令 | 覆盖域 | 用于 |
| :--- | :--- | :--- |
| `cargo test -p agent-tools` | subagent 守卫/嵌套/批量/沙箱/裁剪 | T-D-01/02/06/07/08 |
| `cargo test -p agent-tools subagent` | 守卫边界 + 批量原子性 + 定义映射 | T-D-01/02/05/06/07 |
| `cargo test -p agent-tools write_paths` | 白名单 + 互斥叠加 | T-D-08 |
| `cargo test -p agent-tools readonly` | 工具裁剪通用化 | T-D-02/08 |
| `cargo test -p orchestrator` | DAG 语义回归 + kill_all/resume | T-D-01/09 |
| `cargo test -p orchestrator flow_scheduler` | flow_graph 回归 | T-D-01/06 |
| `cargo test -p orchestrator crash_consistency` | kill_all 崩溃一致性 | T-D-09 |
| `cargo test -p conex-db` | 新列迁移与读回 | T-D-05/07 |
| `cargo test -p conex-types` | 错误码登记 + PermissionRequest 载荷扩展 | T-D-02/08/14 |
| `cargo test -p session-loop` | 审批路由与申请→裁决链路（MockGate） | T-D-14 |
| `cargo test -p agent-workbench` | 引擎 spawner + 提示词注入 + 审批路由分支 | T-D-03/13/14 |
| `cargo test --workspace` | 全模块最终验证（73 套件基线） | R-D3 终验 |
| `npm run typecheck` | TS 契约 + 前端 | 每轮 |
| `npx vitest run src` | 前端单测（基线失败项对照：oklchColorGuard / userFacingErrors / sessionRustDbWriteModel / DiffCard.perf） | 每轮 |

---

> **文档结束**
> 本方案为模块 D（多 Agent 协同调度框架）的实施依据：两处冲突按用户裁决执行，14 个任务卡覆盖派发外围缺口与权限传递层（用户定夺核心新设计），3 轮按逻辑顺序推进（另附 T-D-12 独立小轮），3 项体验增强已定夺（不做/暂缓/做）。方案落地时以代码为真源，行号引用如有漂移以实际代码为准。
