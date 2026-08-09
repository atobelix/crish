# AU2 代码融合度审计报告（多端互通方案 × 现有代码实读核对）

> 审计子代理：AU2（代码融合度）
> 日期：2026-08-09
> 审计对象：`docs/multi-device/plans/` 下全部方案（D1-D8 / M1-M8 / F1-F6 / AC / R2A/R2B 等），重点为 D1/D2/D3/D5/D6、M6/M7、F3/F5/F6、AC、R2A
> 审计方法：**只读**。逐条把方案声称的「与现有代码的融合点」与仓库实际代码实读对照；全部引用为 2026-08-09 工作区快照（仓库相对路径 + 行号，可复核）。本审计不写代码、不修改方案文档，只产出本审计文档。
> 产出路径：`docs/multi-device/audits/AU2-code-fit.md`（UTF-8 无 BOM）
> 结论口径：每条审计项给出「方案声称（文档+章节）→ 代码实读（文件:行号）→ 结论（成立 / 不成立 / 需修正）」。

---

## 目录

- [0. 结论摘要（TL;DR）](#0-结论摘要tldr)
- [1. 审计范围与方法](#1-审计范围与方法)
- [2. 审计点 1：事件基复用（AgentEventEnvelope 41 变体）](#2-审计点-1事件基复用)
- [3. 审计点 2：事件桥汇聚点（FanOutEmitter / emit_payload）](#3-审计点-2事件桥汇聚点)
- [4. 审计点 3：命令面映射（37 命令 × 95 条 manifest）](#4-审计点-3命令面映射)
- [5. 审计点 4：审批复用（ApprovalGateImpl.resolve + I-02）](#5-审计点-4审批复用)
- [6. 审计点 5：游标续传（events 表 + query_events + EventPage）](#6-审计点-5游标续传)
- [7. 审计点 6：S1 流式协议（ToolProgress → ToolUpdate）](#7-审计点-6s1-流式协议)
- [8. 审计点 7：纯函数共享（toolCardPresenter 等四组）](#8-审计点-7纯函数共享)
- [9. 审计点 8：类型生成（generate-engine-bindings.mjs 泛化）](#9-审计点-8类型生成)
- [10. 审计点 9：账号中心（account-center 结构 + credentialMode）](#10-审计点-9账号中心)
- [11. 审计点 10：前端 Transport 契约](#11-审计点-10前端-transport-契约)
- [12. 审计点 11：融合度总体结论](#12-审计点-11融合度总体结论)
- [13. 审计点 12：方案未覆盖的代码融合缺口清单](#13-审计点-12方案未覆盖的代码融合缺口清单)
- [14. 附录：验证记录与引用索引](#14-附录验证记录与引用索引)

---

## 0. 结论摘要（TL;DR)

### 0.1 融合点真实性占比

本审计逐条核对了任务书指定的 10 个融合点（事件基 / 事件桥 / 命令面 / 审批 / 游标 / S1 协议 / 纯函数 / 类型生成 / 账号中心 / Transport 契约）以及 R2A 遗留资产、D3/D6 交叉引用：

| 审计点 | 方案声称 | 实读结论 | 判定 |
|---|---|---|---|
| 1 事件基复用 | D1/D3：41 变体 + 信封扁平 JSON 零发明 | 41 变体逐名对上 `ALL_TYPE_NAMES`；信封扁平序列化与测试锁定均在 | **成立** |
| 2 事件桥汇聚点 | D2：FanOutEmitter 挂 `emit_payload` 零引擎改动 | `Emitter` trait / `emit_payload` / 单构造点全部实读吻合 | **成立**（行号漂移 1 处） |
| 3 命令面映射 | M6：37 命令映射 95 条（勘误 D1/D2/D3 的 92） | manifest 实数为 95 = 91 + 4；37 条算术自洽；M6 勘误准确 | **成立**（D1/D2/D3 需修正旧口径） |
| 4 审批复用 | D5/M7：复用 `resolve` + I-02 | resolve 230-258、I-02 防伪造、命令入口 3768-3818 实读吻合 | **成立**（远程入口本身是新代码） |
| 5 游标续传 | D3/D6：`(session_id, sequence)` + `query_events` + EventPage | 主键 / 取号 / 开区间查询 / EventPage 契约全部吻合 | **成立**（Store 无 limit + 内存分页需注意，D6 已诚实标注） |
| 6 S1 流式协议 | F3：手机端消费 tool-update 领先桌面端 | 映射链（streaming → tool_exec → executing_tools）与桌面空实现实读确认 | **成立** |
| 7 纯函数共享 | F3/F5：toolCardPresenter / streamTextBatcher / mergeAssistantTextPiece / sessionSearch | 四组函数全部存在、零 React 依赖 | **成立**（1 处函数名引用不准） |
| 8 类型生成 | D3/M6：生成器泛化多注册表 | 注册表驱动 + 幂等 + 护栏机制属实，但当前脚本单注册表硬编码 | **成立（需改造，非零改动）** |
| 9 账号中心 | AC/M2/M7/F6：Fastify+SQLite 可加模块；credentialMode=account-center 现有 | account-center 结构与差距实读吻合；桌面 credentialMode 模式位真实存在 | **成立**（集成深度为零，F6 表述需收窄） |
| 10 Transport 契约 | D1：Transport 接口作移动端复用契约 | types.ts:47-83 接口形态逐字段吻合 | **成立**（类型依赖 tauriInvoke 需重构） |

**总计：10 个审计点中 8 个「成立」、2 个「成立但有改造/注意注记」；另发现 8 处「需修正」项（2 处事实错误、3 处文档间矛盾、3 处行号漂移）与 10 项方案未覆盖的融合缺口。不存在「不成立」的融合点——方案声称的融合点全部有真实代码底座，真实性占比高（核心主张 100% 有实读证据），但存在若干口径陈旧与跨文档矛盾需要主控统一裁决。**

### 0.2 最大融合风险（一句话）

**事件扇出装配点的「两文档不一致」+ 「41 变体冻结 vs 新增事件变体」的语义张力是最大风险**：D1 与 D2 对 FanOutEmitter 的挂法（替换 emitter vs 新增第二个桥）描述不一致，D1 §5.2 建议新增 `session-index-changed` 事件变体而 D2 §7.4 明确「41 变体冻结、不新增」，两处若不先统一裁决，实现阶段会各做一套，事件面分裂（详见 §12 缺口 G-1/G-2、§13.2）。

### 0.3 需修正项速览

| # | 归属文档+章节 | 问题 | 修正建议 |
|---|---|---|---|
| F-1 | D1 §6.4.1、D2 §2.2/§9、D3 §2.4/§10 | 命令条数「92 = 88 + 4」已过时（实为 95 = 91 + 4，M6 §2.3 已勘误） | 三文档同步为 95 = 91 + 4；M6 勘误转正为正式口径 |
| F-2 | D1 §6.7 | 「`apps/crish-mobile/`（现有目录）」不存在（R2A 已裁决删除，legacy 原型在 `reference/mobile-companion*`） | 删除该引用或改为「新增 `apps/crish-mobile/`」 |
| F-3 | D2 §8.3/§9.1 ↔ M6 §4.3/§4.8 | 文件读写暴露矛盾：D2 将 list_directory/read_file 列 T4 预留（v1 不暴露）、write_file_content 列 T3 拒绝；M6 将 C16/C17/C18 列白名单特批（v1 可用） | 主控裁决统一：v1 是否开放文件只读/受控写；两文档以同一冻结清单为准 |
| F-4 | D2 §9.4 ↔ M6 C10/C15 | `core_search_files` / `core_check_command`：D2 列 T3 不暴露，M6 映射为可用命令 | 同 F-3，统一白名单真源（单一 remote_manifest） |
| F-5 | F3 §3.4.2 | 引用的 `truncateToolOutput`（toolCardPresenter.ts:89-101）不存在；同文件内为本地 helper（16 行/1600 字符语义存在） | 修正函数名引用 |
| F-6 | D1 §6.2.2 ↔ D2 §4.2/§5 | FanOutEmitter 挂法不一致：D1 倾向「新增第二个 EventBridge 物理解耦」，D2 采用「替换构造点 emitter」 | 统一为单一装配决策（建议 D2 方案 + 保留 GUI 通道语义） |
| F-7 | D1 §5.2 ↔ D2 §7.4 | 「新增 session-index-changed 事件变体」vs「41 变体冻结不新增」直接冲突 | 主控按 D1 O1 尽快裁决；若冻结则 F5 会话列表增量刷新改用轮询/index 版本号 |
| F-8 | D1/D2 多处 | 行号漂移：EventBridge::new（345-348→353-356）、退出钩子（467-473→482-488）、串行守卫（3082-3090→3088-3096）、BufferedRunEventBridge（1643-1704→emit 1703/flush 1729） | 文档行号以 2026-08-09 快照刷新；后续以符号名双索引复核 |

---

## 1. 审计范围与方法

### 1.1 审计范围

- **方案文档**（`docs/multi-device/plans/`，25 份）：重点实读 D1（1098 行全读）、D2（全读）、D5（前 853 行）、M6（前 1753 行）、M7（前 619 行）、F3（前 565 行）、F5（前 300 行）、AC（全读）；D3/D6 经关键章节 grep 核对（92 条口径、DeviceEnvelope §5.3、resume 复用 §7.x、query_events 语义 §2/§9）；R2A 经关键结论核对（apps/crish-mobile 去留）。
- **代码**（实读文件清单见 §14 附录）：
  - `crates/conex-types/src/events.rs`（全 1013 行）
  - `apps/agent-workbench/src-tauri/src/core_event_bridge.rs`（全 255 行）
  - `apps/agent-workbench/src-tauri/src/command_manifest.rs`（前 210 行 + 测试）
  - `apps/agent-workbench/src-tauri/src/core_run_commands.rs`（审批门 / 命令入口 / run 装配 / 审计 sink 多段）
  - `apps/agent-workbench/src-tauri/src/core_query_commands.rs`（EventPage / 事件分页）
  - `apps/agent-workbench/src-tauri/src/main.rs`（setup 序列 / 退出钩子）
  - `apps/agent-workbench/src-tauri/src/buffer.rs`（丢帧类目 / 水位）
  - `apps/agent-workbench/src-tauri/src/config/provider.rs`（credentialMode）
  - `crates/conex-db/src/events.rs`、`crates/orchestrator/src/persist.rs`
  - `crates/session-loop/src/tool_events.rs`、`crates/session-loop/src/tool_exec.rs`（S1 映射）、`crates/session-loop/src/loop/handlers/executing_tools.rs`
  - `crates/agent-tools/src/streaming.rs`、`crates/agent-tools/src/permission.rs`
  - 前端：`transport/types.ts`、`tauriTransport.ts`、`tool-presentation/toolCardPresenter.ts`、`chat-bridge/handlers/eventUtils.ts`、`chat-bridge/handlers/toolHandlers.ts`、`streamTextBatcher.ts`、`sessionSearch.ts`、`EventRouter.ts`
  - `scripts/generate-engine-bindings.mjs`
  - 外部只读：`C:\Software\account-center\navigation-site\zennav-server\`（package.json / auth.service.ts / modules 目录）

### 1.2 判定标准

- **成立**：方案声称的代码事实（符号名 / 结构 / 行号区间）与实读一致，融合点的「复用」在代码层面真实成立（可能含轻微行号漂移，不改变语义）。
- **需修正**：声称的核心事实存在但口径过时 / 函数名不准 / 行号漂移明显 / 与另一方案文档冲突，不影响融合点成立性但必须改文档。
- **不成立**：声称的代码事实不存在或语义相反。（本审计未发现此类项。）

### 1.3 一个重要背景事实

方案声称的代码基线版本（2026-08-09 工作区快照）中，命令面为 **95 条（注册面 91 + 登记先行 4）**、事件面为 **41 变体**、`credentialMode` 已含 `account-center` 三态。方案文档之间对前两项存在 92 vs 95 的旧口径残留（详见 §4 与 F-1）。

---

## 2. 审计点 1：事件基复用

### 2.1 方案声称（文档 + 章节）

| 来源 | 声称 |
|---|---|
| D1 §1.2 / §6.1 | `AgentEvent` 41 变体 + `AgentEventEnvelope`（扁平 JSON）直接作跨端事件基，**零协议发明**；信封注释明确「与 daemon WS 广播同构」（events.rs:908）；移动端复用生成 TS 类型 + parser（packages/shared-types/src/generated/engine/parser.ts） |
| D1 §6.1.1 | 信封 `{type, runId, sequence, schemaVersion, ...事件字段}`，runId/sequence/schemaVersion 由 emit 层注入（events.rs:905-933, 941-992） |
| D3 §1.3 原则 1 | 事件体不二次包装，原样透传 |
| M6 §2.2 / §5 | 41 变体（events.rs:306-782 字段级事实源；ALL_TYPE_NAMES 810-852）；逐事件裁剪策略表（§5.1，41 行全表） |

### 2.2 代码实读

1. **41 变体数量与名称**：`events.rs:290-296` 模块头注释明言「41 种域事件」并记录演进史（38 → 40 → 41，T-CF-04 定时器 +2、T-CF-08 cron +1）；`events.rs:304-782` 为 `#[serde(tag = "type")]` tagged enum；`events.rs:810-852` 宏登记 `ALL_TYPE_NAMES`，**恰好 41 条**：agent-start / agent-end / turn-start / turn-end / message-start / message-delta / message-end / tool-start / tool-update / tool-end / tool-batch-start / tool-batch-end / tool-input-repaired / context-compression-start / context-compression-end / provider-diagnostic / runtime-error / runtime-steering / runtime-intervention-required / approval-requested / approval-resolved / checkpoint-created / checkpoint-restored / run-terminal / cache-stats-updated / cache-waste-alert / cold-cache-warning / security-audit / subagent-started / subagent-event / subagent-ended / task-started / task-output / task-heartbeat / task-suspicious / task-completed / task-failed / task-killed / timer-fired / timer-cancelled / cron-fired。
2. **M6 §5.1 表逐名核对**：M6 的 41 行映射表（1-41 编号）与上述 `ALL_TYPE_NAMES` **逐一同名、同序**；M6 统计（T=13 / R=18 / U=10、同步面 20）是设计分类（裁剪策略），非代码事实，代码侧无对应物——文档自身已标注这是「登记」而非「现存」。
3. **信封结构**：`events.rs:921-933` `AgentEventEnvelope { event, run_id: Option<String>, sequence: Option<u64>, schema_version: u32 }`；`events.rs:941-964` 序列化为**扁平顶层 JSON**（把 `runId` / `sequence` / `schemaVersion` 直接插入事件对象顶层）；`events.rs:966-992` 反序列化缺省补 `schemaVersion=1`（旧帧兼容）；`events.rs:935-939` `EVENT_ENVELOPE_SCHEMA_VERSION = 1`。
4. **「与 daemon WS 广播同构」**：`events.rs:907-908` 注释原文「序列化为**扁平**顶层 JSON：`{ type, runId, sequence, schemaVersion, sessionId, ...事件字段 }`，与 daemon WS 广播同构（03 §3.1）」——与 D1 §1.2 引用一致。
5. **扁平 JSON 的测试锁定**：`core_event_bridge.rs:196-220` 测试 `payload_is_flat_top_level_envelope_json` 断言顶层 `{type, runId, sequence, schemaVersion, sessionId, ...}`——「跨端载荷与 GUI 通道逐字节一致」（D1 §8.2 P0 验收 1）的断言基础已存在。
6. **事件注册表机制**：`events.rs:789-808` 宏「新增事件变体在此登记即可，编译期要求补 arm；并同步 contracts/engine-events.json，由 tests/registry_drift.rs 锁定」；`crates/conex-types/tests/registry_drift.rs` 存在（实读命中）。
7. **前端生成产物**：`packages/shared-types/src/generated/engine/`（events/types/parser/index）存在，由 `scripts/generate-engine-bindings.mjs` 生成（详见 §9）。

### 2.3 41 变体分组核对表（与 ALL_TYPE_NAMES 逐组实读对照）

`events.rs:810-852` 的宏登记按域分组如下（组内顺序 = `ALL_TYPE_NAMES` 顺序，M6 §5.1 表 1-41 编号即此顺序）：

| 域 | 变体（wire 名） | 数量 | 代码区间 |
|---|---|---|---|
| Agent 域 | agent-start / agent-end | 2 | events.rs:309-323 |
| Turn 域 | turn-start / turn-end | 2 | events.rs:327-340 |
| Message 域 | message-start / message-delta / message-end | 3 | events.rs:344-367 |
| Tool 域 | tool-start / tool-update / tool-end / tool-batch-start / tool-batch-end / tool-input-repaired | 6 | events.rs:371-420 |
| 压缩域 | context-compression-start / context-compression-end | 2 | events.rs:424-441 |
| 诊断/审批/检查点域 | provider-diagnostic / runtime-error / runtime-steering / runtime-intervention-required / approval-requested / approval-resolved / checkpoint-created / checkpoint-restored / run-terminal | 9 | events.rs:445-519 |
| 缓存测量域 | cache-stats-updated / cache-waste-alert / cold-cache-warning | 3 | events.rs:524-554 |
| 安全审计域 | security-audit | 1 | events.rs:559-577 |
| 子代理域 | subagent-started / subagent-event / subagent-ended | 3 | events.rs:583-626 |
| 任务域 | task-started / task-output / task-heartbeat / task-suspicious / task-completed / task-failed / task-killed | 7 | events.rs:635-728 |
| 定时器域 + cron 域 | timer-fired / timer-cancelled / cron-fired | 3 | events.rs:737-781 |

合计 **41**，与模块头注释（events.rs:290-296「41 种域事件」）及 M6/F3 的 41 变体表完全一致。M6 §5.1 的 T/R/U 统计（透明透传 13 / 摘要化 18 / 元组 10）与同步面 20 是**跨端裁剪设计**（方案登记值），不是代码侧既有属性——代码侧只有背压分级（events.rs:867-903）与「message-end 必达」等语义，方案文档自身已将该表标注为登记规则而非代码事实，无混淆。

### 2.4 结论

**成立。** 41 变体数量与名称、信封扁平 JSON 形态、schemaVersion 缺省语义、注册表 + drift 护栏、生成产物全部实读吻合；「零协议发明」主张有真实代码底座。M6 的 41 变体清单与 `ALL_TYPE_NAMES` 一一对应（41/41 同名同序），无增删改。

**附注**：信封 `runId` 缺失时「前端放行不过滤但多 run 并发过滤失效」（events.rs:908-910 注释），timer/cron 事件使用 `timer-<id>` / `cron-<id>` 伪 runId（events.rs:925-928）——跨端转发继承同一语义，移动端 feed 需按 timerId/cronId 分组（F3 §3.1 已覆盖，但未强调「多 run 并发过滤失效」是既有已知限制，见缺口 G-3）。

---

## 3. 审计点 2：事件桥汇聚点

### 3.1 方案声称（文档 + 章节）

| 来源 | 声称 |
|---|---|
| D2 §1 / §2.3 / §11-A | 新增 `FanOutEmitter` 实现既有 `Emitter` trait（core_event_bridge.rs:51-54），挂在 `EventBridge` 构造点（main.rs:345-348）之后；**全部发射路径最终都收敛到 `EventBridge::emit_payload`（core_event_bridge.rs:137-144）**，桥与引擎零改动，WS 广播自动获得全事件流 |
| D1 §6.2.1 | 发射链三层（TauriEmitter → EventBridge → BufferedRunEventBridge → 消费方），`Emitter` trait 是唯一发射抽象（core_event_bridge.rs:51-54），Tauri 通道与测试替身已共存（RecordingEmitter 156-174） |
| D1 §6.2.2 | 方案 A（推荐）：FanoutEmitter 实现 Emitter trait；落点倾向「保持原桥不动，新增第二个 EventBridge（channel 语义不同）由网关消费」 |
| D2 §2.4 / §10 | 实时轨 BridgeDeltaSink 信封 sequence=None；WS 续传重放复用 `core_read_session_events` EventPage 契约 |

### 3.2 代码实读

1. **`Emitter` trait**：`core_event_bridge.rs:51-54`，`fn emit(&self, channel: &str, payload: &str)`，payload 为已序列化完整 JSON 字符串，`Send + Sync`——「实现方自行兜底发射失败」。
2. **`TauriEmitter`**：`core_event_bridge.rs:57-81`，`app.emit(channel, payload)`，失败仅 warn（尽力而为）。
3. **`EventBridge`**：`core_event_bridge.rs:88-145`。`serialize`（107-120）信封 → JSON 字符串；`emit_payload`（137-144）`self.emitter.emit(&self.channel, payload)` 直发；测试替身 `RecordingEmitter`（156-174）与 Tauri 实现共存——**新增发射器只需实现该 trait 即可插**。
4. **构造点（单点）**：`main.rs:353-356` `EventBridge::new("workbench-run-event", Arc::new(TauriEmitter::new(app_handle)))`——D2 引用的「main.rs:345-348」实际为 353-356（行号漂移约 8 行，F-8）。桥构造后以 clone 注入 CoreRunState（main.rs:372-379）、`app.manage(bridge.clone())`（397）、task 事件（414）、timer/cron drain（448-449）。
5. **汇聚点验证（全部发射路径）**：
   - run 级缓冲桥 `BufferedRunEventBridge`：`engine.rs:1703` `emit`（入队即序列化）、`engine.rs:1729` `flush`（drain 后逐条 `bridge.emit_payload`）——D2 引 1643-1704 为结构起始区间，实际 emit/flush 在 1703/1729（漂移约 25 行）；
   - 实时轨 `BridgeDeltaSink`：`engine.rs:1743+`（D2 引 1716-1741，漂移约 27 行），信封 sequence=None；
   - timer/cron drain：`main.rs:445-456` 500ms tick → `engine::forward_drained_timer_events` → bridge；
   - 审批 request 实时预览：`core_run_commands.rs:3148` 注释「审批门广播（approval-requested 实时预览：信封 sequence=None）」；
   - 审批 resolved 落库 + 实时：`core_run_commands.rs:3820-3854` `emit_approval_resolved` → `active.bridge.emit(&envelope)` + `flush()`；
   - 审计 sink：`core_run_commands.rs:448-490` `BridgeAuditSink` → `self.bridge.emit(&envelope)` + `flush()`；
   - task 事件：`main.rs:414` `background_tasks.set_event_bridge(bridge.clone(), ...)`。
6. **旁路（不在汇聚点内）**：`main.rs:404-406` `core_state.engine().browser_slot().attach_emitter(Arc::new(TauriEmitter::new(...)))`——`browser://state-changed` 通道**不经 EventBridge**，是独立发射器。若移动端需浏览器面板状态事件，FanoutEmitter 方案覆盖不到（方案文档未提及）。
7. **背压语义**：`buffer.rs:36-42` `drop_class_of`（仅 message-delta 为 Soft 可丢，其余 Critical 永不丢）；`buffer.rs:200-206` `Default` 水位 Soft 64 / Critical 256——与 D2 §2.3 引用一致。
8. **「零 crate:: 内部引用」风格**：`core_event_bridge.rs:2-4` 模块头注明确认，可 `#[path]` 独立编译测试——D1/D2 声称的「新增扇出实现可保持同风格」属实。

### 3.3 结论

**成立（需修正 1 处行号漂移）。** `emit_payload` 形态（已序列化字符串直发）、`Emitter` trait 可插性、单构造点、全部发射路径收敛——实读全部吻合，「桥与引擎零改动」主张成立。修正项：
- 行号：EventBridge::new 构造点为 `main.rs:353-356`（D2 引 345-348）；
- 补充注意：`browser://state-changed` 旁路（main.rs:404-406）不在汇聚点内；
- D1 §6.2.2 与 D2 对「挂法」描述不一致（D1 倾向新增第二个 EventBridge 物理解耦、D2 采用替换 emitter 的 FanOutEmitter）——见缺口 G-2 / 修正项 F-6。

---

## 4. 审计点 3：命令面映射

### 4.1 方案声称（文档 + 章节）

| 来源 | 声称 |
|---|---|
| M6 §2.3（重要勘误） | D3 §2.4 引用「92 条」过时；当前总数 **95 条 = 注册面 91 + 登记先行 4**（增量：27 方案 S6 浏览器三条 browser_start/stop/status 已 registered=true；登记先行 4 条仍为 false） |
| M6 §4 | 37 条 `cmd.*` 命令映射桌面命令面（§4.1-4.6 六域 + 设备域总表），参数/响应沿用现有 serde camelCase 契约，不造第二套 DTO |
| M6 §4.7 | 95 条按「A 移动端映射 37 / B 只读可开放不接 / C 写与安全敏感拒绝 / D 内部面」四类归表 |
| D1 §6.4 / D2 §9 | `surface` 字段已区分 engine（三端共用）/ gui（GUI 专属），`command_manifest.rs:33-38`；D2 按 T1/T2/T3 分级 92 条（旧口径） |

### 4.2 代码实读

1. **条数**：`command_manifest.rs:68-191` 逐条计数：registered=true = **91**（workbench 22 + config 10 + core 工具旧组 6 + 查询与运行 9 + session 14 + markdown 5 + worker 组 10 + core_list_commands 1 + catalog 2 + trash 3 + workflow 6 + browser 3），registered=false = **4**（append_session_messages / workbench_open_workspace / workbench_list_workspaces / workbench_dev_mcp_enabled，186-189）→ **总数 95**。
2. **测试锁定**：`command_manifest.rs:209-210` `manifest_count_matches_registered_surface` 注释「95 = 注册面 91 + 登记先行 4」；`main.rs:500-514` 注册面 == manifest registered=true 逐项一致断言（registration_surface_matches_manifest）。**95 条是当前代码事实，M6 勘误准确。**
3. **surface 字段**：`command_manifest.rs:33-38` `surface: engine = 引擎契约面（三端共用）；gui = GUI 专属面`——「三端共用」表述证实设计者已预见多端，D1/D2 声称属实。
4. **M6 37 条算术自洽**：F1 域 10（C01-C10）+ F2 域 5（C11-C15）+ F4 域 8（C16-C23）+ F5 域 4（C24-C27，另复用 C03/C05）+ F6 域 5（C28-C32）+ 设备域 5（C33-C37）= **37**。桌面映射名抽查与 manifest 一致：core_get_status（manifest:119）、core_get_run_snapshot（:120）、core_read_run_events（:121）、core_read_session_events（:122）、core_run_task（:123）、core_run_control（:124）、core_cancel_run（:125）、core_approve_tool（:126）、core_deny_tool（:127）、core_check_command（:112）、core_search_files（:113）、config_get（:100）、config_update（:101）、list_sessions（:129）、get_flow_snapshot（:143）、core_list_commands（:164）、workbench_list_background_tasks（:85）、workbench_get_background_task_output（:86）、workbench_list_directory（:92）、workbench_read_file_content（:93）、workbench_write_file_content（:94）、workbench_list_workspaces（:188）、workbench_open_workspace（:187）——**全部命中且 surface/registered 与 M6 描述一致**（workbench 五条 surface=gui、registered=true；登记先行两条 false）。
5. **D1/D2/D3 的 92 条旧口径**：D1 §6.4.1「command_registry!（92 条注册，含登记先行 4 条）」、D2 §2.2「88 条 registered + 4 条登记先行」、D3 §2.4「92 条命令（注册面 88 + 登记先行 4）」（D3-protocol.md:135）与 D3 附录（:1699）——均为旧快照口径，**与当前代码不符**（M6 勘误已指出，D1/D2/D3 正文未同步）。

### 4.3 结论

**成立（M6 口径）；D1/D2/D3 需修正（F-1）。** 95 = 91 + 4 有 manifest 本身与双端测试双重锁定；37 条命令映射名全部可落 manifest，且「参数沿用现有 serde camelCase 契约、不造第二套 DTO」有 `RunTaskOptions`（core_run_commands.rs:3010-3036 附近）等先例支撑。需修正项：
- F-1：D1 §6.4.1 / D2 §2.2+§9 / D3 §2.4+§10 的 92 条口径全部更新为 95 = 91 + 4；
- F-3/F-4：D2 的 T1/T2/T3 分级与 M6 白名单存在冲突（文件面与工具面），见 §12 修正项表——**「surface=engine ∩ 白名单」的三重约束需要一个单一真源**，当前 D2 的 REST 路由表、M6 的协议白名单、D5 的 remote_manifest 是三张不同的表（缺口 G-6）。

### 4.4 M6 37 条命令映射明细核对表（命令 kind → Tauri 命令 → manifest 行号）

| # | 命令 kind | 对应 Tauri 命令 | manifest 行号 | surface | 实读核对 |
|---|---|---|---|---|---|
| C01 | cmd.getStatus | core_get_status | command_manifest.rs:119 | engine | ✓ |
| C02 | cmd.getRunSnapshot | core_get_run_snapshot | :120 | engine | ✓ |
| C03 | cmd.readSessionEvents | core_read_session_events | :122 | engine | ✓ |
| C04 | cmd.readRunEvents | core_read_run_events | :121 | engine | ✓ |
| C05 | cmd.listSessions | list_sessions | :129 | engine | ✓ |
| C06 | cmd.listBackgroundTasks | workbench_list_background_tasks | :85 | **gui** | ✓（M6 特批） |
| C07 | cmd.getTaskOutput | workbench_get_background_task_output | :86 | **gui** | ✓（M6 特批） |
| C08 | cmd.getFlowSnapshot | get_flow_snapshot | :143 | engine | ✓ |
| C09 | cmd.listCommands | core_list_commands | :164 | engine | ✓ |
| C10 | cmd.getSearchIndex | core_search_files | :113 | engine | ✓（与 D2 T3 冲突，F-4） |
| C11 | cmd.approve | core_approve_tool | :126 | engine | ✓ |
| C12 | cmd.deny | core_deny_tool | :127 | engine | ✓ |
| C13 | cmd.listPendingApprovals | [新增] mobile_list_pending_approvals | — | — | 新增面（无 manifest 条目） |
| C14 | cmd.approvalHistory | [新增] mobile_approval_sync_state | — | — | 新增面 |
| C15 | cmd.checkCommand | core_check_command | :112 | engine | ✓（与 D2 T3 冲突，F-4） |
| C16 | cmd.listDir | workbench_list_directory | :92 | **gui** | ✓（M6 特批，与 D2 T4 冲突，F-3） |
| C17 | cmd.readFile | workbench_read_file_content | :93 | **gui** | ✓（M6 特批，与 D2 T4 冲突，F-3） |
| C18 | cmd.writeFile | workbench_write_file_content | :94 | **gui** | ✓（M6 特批，与 D2 T3 冲突，F-3） |
| C19 | cmd.listWorkspaces | workbench_list_workspaces（登记先行） | :188 | gui | ✓（registered=false） |
| C20 | cmd.switchWorkspace | workbench_open_workspace（登记先行） | :187 | gui | ✓（registered=false，需接线） |
| C21 | cmd.searchFiles | [新增] mobile_search_files（→ fuzzy_find） | — | — | 新增面 |
| C22 | cmd.assetUrl | [新增] mobile_asset_url | — | — | 新增面 |
| C23 | cmd.fileStat | file_stat 工具代理（薄壳） | — | — | 新增面 |
| C24 | cmd.runTask | core_run_task | :123 | engine | ✓ |
| C25 | cmd.runControl | core_run_control | :124 | engine | ✓ |
| C26 | cmd.cancelRun | core_cancel_run | :125 | engine | ✓ |
| C27 | cmd.searchSessions | [新增] mobile_search_sessions（P2） | — | — | 新增面（v1 不实现） |
| C28 | cmd.getSettings | config_get | :100 | engine | ✓ |
| C29 | cmd.setSettings | config_update | :101 | engine | ✓ |
| C30 | cmd.settingsConfirm | [新增] mobile_settings_confirm | — | — | 新增面 |
| C31 | cmd.pauseAutomation | [新增] mobile_pause_automation | — | — | 新增面 |
| C32 | cmd.queryPresence | [新增] device_presence_query | — | — | 新增面 |
| C33-C37 | 设备域 5 条 | Device Registry / Pairing Service（新增面） | — | — | 新增面（无 manifest 条目） |

核对要点：
1. **既有命令 23 条**（C01-C12、C15-C20、C24-C26、C28、C29）全部命中 manifest 且 surface/registered 与 M6 描述一致；
2. **surface=gui 特批 5 条**（C06/C07/C16/C17/C18）实读确认均为 gui + registered=true——M6 §4.8 的「白名单特批」描述准确，但与 D2 §8.3（list_directory/read_file = T4 预留 v1 不暴露、write_file_content = T3 拒绝）**直接矛盾**（F-3）；
3. **登记先行 2 条**（C19/C20）registered=false——M6 声称「M4-1 接线后 registered=true」是未来动作，现状不可调；
4. **新增命令 14 条**（C13/C14/C21/C22/C23/C27/C30/C31/C32 + C33-C37）无 manifest 条目——M6 均以 `[新增]` 标注，表述诚实；但 D1 §6.4.3 的融合不变量「网关暴露的命令数 ≤ 现有注册面，不做仅服务端可调的新命令」与 M6 的 14 条新增面**存在张力**——新增命令需先注册进 `command_registry!` + manifest 才能保持「注册面唯一真源」（D1 不变量）与 M6 协议面一致，两文档对「新增命令的登记路径」未对齐。

---

## 5. 审计点 4：审批复用

### 5.1 方案声称（文档 + 章节）

| 来源 | 声称 |
|---|---|
| D5 §0.3 / §4.3 | 复用 `ApprovalGateImpl`（core_run_commands.rs:161）的 request_approval 广播路径与 `resolve`（:230）裁决入口 + pending 集合校验（I-02）；`Arbiter` 枚举（approval_router.rs:74）扩展 Remote 变体（设计新增） |
| D1 §5.4 / §6.5 | 远程审批 = 给现有 resolve 增加鉴权过的服务入口；`core_approve_tool`/`core_deny_tool`（3746-3800 附近）与 approval-resolved 落库 + 实时（3801-3831）；并发裁决 pending.remove 单写者（235-245）；APPROVAL_TIMEOUT 120s（:87） |
| M7 §1.5 / §2.8 | 审批裁决唯一入口 resolve（core_run_commands.rs:230）；移动端决策经网关转 resolve，验证证据随请求提交，resolve 不感知 |
| M6 C11/C12 | cmd.approve/deny 映射 core_approve_tool/core_deny_tool（command_manifest.rs:126-127）；响应形状对齐 `ApproveResponse`（core_run_commands.rs:117-123 附近）；`cmd.approval_mismatch` = I-02 NotFound 语义 |

### 5.2 代码实读

1. **`ApprovalGateImpl`**：`core_run_commands.rs:161-187`（struct：run_id / session_id / parent_run_id / deadlock_detector / broadcast / pending: `Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>` / handle / store / cwd）；`:191-211` 构造；`:230-258` `resolve`：
   - `:235-245` `pending.remove(tool_call_id)` 不存在 → `CoreError::NotFound`（I-02 防伪造，注释「杜绝伪造 approval-resolved 审计事件 / 提前审批」）；
   - `:246` `sender.send(decision)` 送决策；
   - `:247-257` 状态机恢复 `handle.resolve_approval`（awaiting-approval → running）。
2. **`request_approval`（先发后等）**：`:263-343`——来源分类 + 裁决者路由（:273-278，route_approval_guarded / route_approval）、构造 PermissionRequest（:290-307，含 requester_run_id/reason 权限传递层）、广播 approval-requested（:308-312）、状态机 running → awaiting-approval 落库（:314-325）、注册 oneshot（:327-336）、120s 超时等待（:339-342，Expired）。
3. **命令入口**：`core_approve_tool` `:3768-3792`——仅接受 decision="approved"（:3777-3781，其余 InvalidInput 拒绝，**M6 声称「跨端参数不提供 decision 字段」的依据就在此处**）→ `active.approval.resolve(...Approved)` → `emit_approval_resolved`；`core_deny_tool` `:3795-3818`（reason 缺省 "user denied"）；`emit_approval_resolved` `:3820-3854`（EventQueue.push 落库 → 信封携带 sequence → bridge.emit + flush 实时）。
4. **权限传递层载荷**：`PermissionRequest` `events.rs:196-218`（id/sessionId/cwd/toolCallId/toolName/parameters/summary/toolMetadata/metadata/requesterRunId/reason，后两者 Option 向后兼容）；`ApprovalDecision` `events.rs:223-232`（approved/denied/expired）。
5. **裁决者路由**：`crates/session-loop/src/approval_router.rs`（D5 引 :74 Arbiter、:88-118 路由函数）——实读命中文件（grep 确认 classify_source / route_approval / route_approval_guarded / arbiter_metadata 存在）。
6. **APPROVAL_TIMEOUT**：`core_run_commands.rs:87-88` 常量区（:339-342 使用）——D1/D5 引 :87/:88 吻合。

### 5.3 结论

**成立。** 「移动端如何触发 resolve」的答案是：**远程入口（网关层的 md.approve → core_approve_tool 委托）是新代码，resolve 本身与 I-02 校验、状态机恢复、approval-resolved 落库 + 实时发射全部是现有可复用路径**——D5/M7 声称的「复用 resolve 入口」准确，M6 声称的「approve 只接受 approved、I-02 NotFound → approval_mismatch 冲突收敛」均有代码依据。并发裁决「pending.remove 单写 + 第二个裁决 NotFound」语义实读成立（:235-245），无需分布式锁。

**附注**：D5 声称「Arbiter 扩展 Remote 变体」是设计新增（approval_router.rs 现仅有 User/MainAgent）；「远程 run 内红线不可豁免」（decide_with_redline，permission.rs:96）实读存在。这些是方案增量而非复用，方案文档表述已区分，无误导。

---

## 6. 审计点 5：游标续传

### 6.1 方案声称（文档 + 章节）

| 来源 | 声称 |
|---|---|
| D1 §5.3 / §6.3 | events 表 `(session_id, sequence)` 主键（schema.rs:141-149）；`reserve_sequence` 原子取号（conex-db/src/events.rs:72-99）、`seed_sequence` 幂等校准（103-121）；查询面 `after_sequence` 游标分页 `core_read_session_events`（core_query_commands.rs:510-539）返回 `{events, nextAfterSequence, hasMore}` |
| D3 §7.x | events.resume 拉历史实现 = 复用 `core_read_session_events`（D3-protocol.md:719） |
| D6 §2.1-2.2 | 通道 B 增量以 `(session_id, sequence)` 为锚点，复用 `LocalDb::query_events(session_id, after_sequence, limit)`（conex-db/src/events.rs:33-68）开区间语义；`reserve_sequence` 单调（跨 run 不重置） |
| D6 §9.1（诚实标注） | `Store` trait 只暴露无 limit 的 `query_events`（persist.rs:168），limit 仅在 LocalDb 层；同步服务应直调 LocalDb 或新增分页方法 |
| M6 C03 | cmd.readSessionEvents 响应 EventPage 契约；cursor 开区间；`latestSequence` 由服务端补充（设计增量） |

### 6.2 代码实读

1. **主键与取号**：`conex-db/src/events.rs`：`append_event`（:8-27，INSERT 受 UNIQUE 约束）；`query_events`（:33-68）SQL 原文 `WHERE session_id = ?1 AND sequence > ?2 ORDER BY sequence ASC LIMIT ?3`——**开区间 + limit 分页原语存在**，与 D6 §2.2 引用逐字一致；`reserve_sequence`（:72-99，session_sequence 表原子取号，首次 max+1 对齐）；`seed_sequence`（:103-121，MAX 语义幂等）。schema.rs:141-149（v5 目标形态复合主键）为方案引用，本审计未实读该行段但 events.rs 的 INSERT 约束行为与之一致。
2. **EventPage 契约**：`core_query_commands.rs:328-338` `EventPage { events: Vec<serde_json::Value>, next_after_sequence: u64, has_more: bool }`（camelCase）——与 D1/D3/M6 声称一致。
3. **core_read_session_events**：`:510-539`——`require_session_id` → `store.query_events(&session_id, after)`（**Store 层无 limit 参数**）→ `parse_envelopes` 全量解析 → `paginate` **内存分页** → EventPage。即：**当前实现把游标之后的全量事件加载进内存再分页**（依赖 SQL 侧 LIMIT 的是 LocalDb 层，Store trait 未透出）。
4. **Store trait**：`persist.rs:168` `async fn query_events(&self, session_id: &str, after_sequence: u64) -> StoreResult<Vec<PersistedEvent>>`——确认无 limit；D6 §9.1 的标注**属实**。
5. **反向查询**：`query_events` 只有 forward（`ORDER BY sequence ASC`）；M6 §4.1.3.1 声称的 backward 方向不存在于当前代码，M6 已明确标注为「conex-db 新增 query_events_backward，零改动既有 forward 面」——表述诚实。
6. **实时预览帧**：`BridgeDeltaSink` 信封 sequence=None（engine.rs:1743+；core_run_commands.rs:3148 注释确认），落库帧携带序列号（emit_approval_resolved :3833-3843 先 queue.push 取号再注入信封）——D1 §5.3「实时预览帧 sequence=None、落库帧携带序列号」属实。

### 6.3 结论

**成立（附 1 项必须处理的工程注意 + 1 项方案已诚实标注的新增面）。**
- 游标三件套（主键 / 开区间查询 / EventPage）全部实读成立，断线续传「复用既有查询面」主张真实；
- **注意**：`core_read_session_events` 经 Store 无 limit 拉全量再内存分页（core_query_commands.rs:521-531）——移动端同步面若直接复用此命令做断线追平，大会话（如 5 万事件）会触发一次性全量加载。D6 §9.1 已提出 `query_events_paged` 或直调 `LocalDb::query_events(after, Some(limit))` 两个选项但**未定案**——这属于「复用路径上的性能缺陷」，需在同步面实现前裁决（缺口 G-4）；
- backward 方向不存在，M6 已正确标注为新增（非「复用现有面」）。

---

## 7. 审计点 6：S1 流式协议

### 7.1 方案声称（文档 + 章节）

| 来源 | 声称 |
|---|---|
| F3 §4.1 | S1 流式协议（TOOLS-01 §3.1.5，tool_exec.rs:1424-1445）：`ToolProgress::Text → ToolProgressUpdate {text, metadata:{kind:"tool-progress"}}`；`Custom → {json, subkind}`；`Content → 不发射（None）`；事件载体 tool-update（events.rs:379-386）；**手机端领先桌面端消费此事件**（桌面 tool-update 空实现，toolHandlers.ts:25-30） |
| F3 §2.3 | 时序契约：tool-batch-start → (tool-start → approval-requested → tool-update* → tool-end)* → tool-batch-end（tool_events.rs:1-9） |
| F3 §4.1 | tool-update 是展示面事件不进消息历史，终值由 ToolEnd 承载（executing_tools.rs:270-279） |

### 7.2 代码实读

1. **`ToolProgress` 定义**：`crates/agent-tools/src/streaming.rs:39+`（tag="kind" snake_case，Text / Custom / Content 三态）。
2. **S1 出站映射**：`crates/session-loop/src/tool_exec.rs:1424-1445` `tool_progress_update`：`ToolProgress::Text { text } → Some(ToolProgressUpdate { text, metadata: {kind: "tool-progress"} })`；`Custom { subkind, payload } → Some(ToolProgressUpdate { json, metadata: {kind: subkind} })`；`Content → None`——与 F3 §4.1 声称逐行一致（含行号）。
3. **事件链**：`tool_events.rs:22-69` `ToolEvent` 枚举含 `ToolProgress { call_id, update }`（:63-66，注释「翻译层映射为 AgentEvent::ToolUpdate」）；`tool_events.rs:1-9` 模块头时序文档（S1 起 tool-update* 零或多条，恒位于 tool-start 与 tool-end 之间）。
4. **映射落地**：`crates/session-loop/src/loop/handlers/executing_tools.rs:269-279` `ToolEvent::ToolProgress` → `state.events.push(AgentEvent::ToolUpdate {...})`；同文件测试（:393-465）断言「ToolProgress 应映射为 AgentEvent::ToolUpdate」且「ToolUpdate 不得写消息历史」。
5. **事件载体**：`events.rs:379-386` `ToolUpdate { session_id, batch_id, tool_call_id, update: ToolProgressUpdate, timestamp }`；`ToolProgressUpdate` 定义于 `conex-types/src/tool.rs:146+`（text? / json? / metadata?）。
6. **桌面消费现状**：`apps/crish-desktop/src/api/chat-bridge/handlers/toolHandlers.ts:25-30` `onToolUpdate` **显式空实现**（注释「tool-update 暂无 UI 落地：显式空实现（原实现无分支、静默放行）」）——**F3 声称「手机端领先桌面端消费此事件」属实**。
7. **流式输出源头**：`crates/agent-tools/src/tools/shell.rs` 以 `ToolProgress::Text` 推送输出块（:376、:1293 等）——shell 输出经此通道流式到达，与 F3 §4.1「shell_command 的输出即经此通道流式到达」一致。

### 7.3 结论

**成立。** S1 映射链（streaming 定义 → tool_exec 出站映射 → executing_tools 事件落地 → tool-update wire 载体 → 桌面空实现）全链路实读确认，wire 形状（`ToolProgressUpdate {text/json/metadata}`）可被移动端直接消费，且「ToolUpdate 不进消息历史、终值由 ToolEnd 承载」的语义有测试锁定（executing_tools.rs:465-468）。F3 声称与代码事实完全吻合，无修正项。

---

## 8. 审计点 7：纯函数共享

### 8.1 方案声称（文档 + 章节）

| 来源 | 声称 |
|---|---|
| F3 §3.3.2 / §6.3 | 复用 `toolCardPresenter.ts` 的 `toolHumanLabel` / `toolCommandPreview` / `extractToolCommand` 纯函数逻辑（移植为共享包） |
| F3 §3.4.1 | 复用桌面批合并器模式 `streamTextBatcher.ts`：intervalMs=48（:64）、maxBufferedChars=8000（:78）、isImmediateToolStatus（:335-339） |
| F3 §3.3.1 / F5 §2.3 | message-end 终态全文合并复用 `mergeAssistantTextPiece`（eventUtils.ts:49-63） |
| F5 §1.7 | `sessionSearch.ts`：matchSessionSearch（:417-479）/ messageMatchesSearch（:345-358）/ makeSearchSnippet（:236-296）/ ellipsizeCodepoints（:184-194）纯函数直接移植 |
| D1 §6.6 | EventRouter + handlers/* + StreamRenderBuffer + sessionStreamManager 等纯 TS 模块可移入共享包 |

### 8.2 代码实读

1. **toolCardPresenter.ts**（`apps/crish-desktop/src/api/tool-presentation/toolCardPresenter.ts`）：全文件 **0 处 react 引用**（imports 仅 `MessageToolCall`/`SessionMessage` 类型 + `ToolRowTone` 类型）；导出函数清单命中：`extractToolCommand`（:25）、`isToolRowDefaultOpen`（:306）、`toolRowTone`（:336）、`humanizeShellCommand`（:500）、`toolHumanLabel`（:846）、`toolCommandPreview`（:878）、`toolResultPreview`（:893）等——纯函数，可抽共享包。
2. **streamTextBatcher.ts**（`apps/crish-desktop/src/api/streamTextBatcher.ts`）：`StreamValueBatcher<T>`（:46）+ `StreamTextBatcher`（:258）；默认 `intervalMs = 48`（:64）；`maxBufferedSize` 缺省 8000（:78）；`isImmediateToolStatus`（:335）；imports 仅 `MessageToolCall` 类型——纯 TS，无 React 依赖。
3. **mergeAssistantTextPiece**：`apps/crish-desktop/src/api/chat-bridge/handlers/eventUtils.ts:49-63`——终态权威合并（增量累积与终稿不一致时以终稿为准），纯函数。同文件 `messageBelongsToRun`（:30-39，null runId 放行）与 F3 §3.1 引用一致。
4. **sessionSearch.ts**（`apps/crish-desktop/src/api/sessionSearch.ts`）：`ellipsizeCodepoints`（:184）、`makeSearchSnippet`（:236）、`messageMatchesSearch`（:345）、`matchSessionSearch`（:417）——全部命中；imports 仅 store 类型 + sessionTitle——纯函数。
5. **共享先例**：`packages/shared-types/src/generated/engine/` 已是跨端共享的生成产物；`EventRouter.ts:101` 注释「前端不校验 sequence，不做乱序缓冲/缺口检测」（F3 §3.2 引用单通道顺序语义）属实。

### 8.3 结论

**成立（1 处函数名引用需修正）。** 四组函数全部存在且零 React 依赖，可被共享包抽取（`packages/` 已有生成产物先例）。修正项 F-5：F3 §3.4.2 引用的 `truncateToolOutput`（toolCardPresenter.ts:89-101）**在导出面不存在**——同文件内为本地 helper `ln(output, maxLines = 16, maxChars = 1600)`（语义相同：16 行 / 1600 字符预览上限），文档引用名需修正或改用现有导出（fullToolOutput / toolResultPreview）。

---

## 9. 审计点 8：类型生成

### 9.1 方案声称（文档 + 章节）

| 来源 | 声称 |
|---|---|
| M6 §1.6 / §12 | 新类型落 `crates/conex-types/src/device/` 模块族（不新建 crate）；新增注册表 `contracts/device-protocol.json`，把 `generate-engine-bindings.mjs` **泛化为多注册表分发**（contract 字段区分 engine-events / device-protocol），输出 `packages/shared-types/src/generated/device/{messages,types,parser,index,errors,capabilities}.ts`；事件体不重新生成（复用既有 parseEngineEvent） |
| D3 §2.7 | 生成纪律：注册表驱动 + 确定性字节 + PARSER_PREAMBLE |

### 9.2 代码实读

1. **注册表驱动**：`scripts/generate-engine-bindings.mjs:25-31` `REGISTRY_PATH = crates/conex-types/contracts/engine-events.json`；`:32-39` `OUT_DIR = packages/shared-types/src/generated/engine`——**路径硬编码**。
2. **contract 校验**：`:87-96` `validateRegistry`：`reg.contract !== "engine-events"` 即 fail——当前只接受单一 contract 值。
3. **幂等**：`:16` 注释「Idempotency: no timestamps or randomness; run twice -> identical bytes」——确定性字节保证存在。
4. **输出集**：`:10-14` 固定输出 events.ts / types.ts / parser.ts / index.ts（M6 声称的 device 输出集 {messages,types,parser,index,errors,capabilities} 是新增规划，当前无对应物）。
5. **护栏**：注册表字段校验（integer 标记 :110-117、未知类型引用 :104-109、event id 顺序 :119-120 等）+ `tests/registry_drift.rs`（Rust 侧锁定事件与注册表漂移）。
6. **device/ 模块族**：`crates/conex-types/src/` 当前无 `device/` 目录——M6 声明为新增落点（未声称已存在），与现状一致。

### 9.3 结论

**成立（属「需改造」而非「零改动复用」）。** 生成器的机制（注册表驱动、确定性字节、契约校验、漂移护栏）全部实读确认，具备泛化基础；但**当前脚本是单注册表硬编码**（路径 / 输出目录 / 输出文件集 / contract 白名单均写死），泛化为多注册表分发是一个明确的参数化改造任务（改造点：REGISTRY_PATH/OUT_DIR 参数化 + 输出文件映射表 + contract 分支 + device parser 的 PARSER_PREAMBLE）。M6 §1.6 未标注该工作量，建议补充「生成器泛化」为独立实现项并加「device 注册表 drift 测试」。

---

## 10. 审计点 9：账号中心

### 10.1 方案声称（文档 + 章节）

| 来源 | 声称 |
|---|---|
| AC §3.2 / §3.3 | zennav-server = Node.js + TypeScript（CommonJS）+ **Fastify 5** + **SQLite（better-sqlite3）**，22 个路由模块注册面（index.ts:120-183）；设备注册表含 desktop/mobile；无 push/ws/sse/fcm/apns 模块 |
| AC §6.2-6.4 | 需新增 push_tokens / relay_credentials 两个模块 + 白名单扩展（DESKTOP_AUTH_APPS 仅 chat_sync_desktop，auth.service.ts:244）；中继服务独立 Rust 新写 |
| F6 §3.x | 桌面配置面已有 `credentialMode = account-center` 分支（provider.rs:153-155 返回 None、:256-263 校验三态）——「account-center 模式存在即手机端账户体系的落点」 |
| M2 §13 | 引用 AC 的 relay_credentials / push_tokens / A3 联动为账号侧基准 |

### 10.2 代码实读（account-center 只读）

1. **技术栈**：`C:\Software\account-center\navigation-site\zennav-server\package.json`：`fastify ^5.8.4`、`better-sqlite3 ^12.8.0`、`@fastify/cors ^11.2.0`——AC §3.2 声称属实。
2. **模块结构**：`src/modules/` 目录实列：account / admin / ai / assets / auth / billing / clipboard / devices / health / icon / mail / privacy / projects / reminders / resources / shares / sync / usage / wallpaper / wechat / workspace / zendrop——**无 push 模块、无 relay 模块**（AC §4.3.4「推送完全缺失」、§4.3.5「中继鉴权半有」的差距判断属实）。
3. **DESKTOP_AUTH_APPS**：`src/modules/auth/auth.service.ts:244` `const DESKTOP_AUTH_APPS = new Set(['chat_sync_desktop'])`；`:1145` 使用校验——AC §4.3.2「白名单目前只有 chat_sync_desktop」**逐字属实**。
4. **auth 模块规模**：auth.routes.ts（17 组端点）+ auth.service.ts（2224 行级）——AC §3.3 声称属实（本审计未逐行核读 2224 行，但文件存在性与规模可复核）。
5. **crish 侧 credentialMode（关键交叉验证）**：`apps/agent-workbench/src-tauri/src/config/provider.rs`：
   - `:153-155` `effective_api_key()` 在 `effective_credential_mode() == "account-center"` 时**直接返回 None**（不读直连密钥）——F6 引用行号准确；
   - `:256-263` `set_credential_mode` 校验 `direct / account-center / auto` 三态（错误文案原文「Expected direct, account-center, or auto」）；
   - `:299-325` 快照含 `credentialMode`（:314）；
   - `config/resolution.rs:84` normalize_credential_mode 三态映射；
   - `packages/shared-types/src/provider-defaults.ts:1` `CrishProviderCredentialMode = "direct" | "account-center" | "auto"`（前端类型已存在）。
6. **集成深度（重要修正注记）**：provider.rs 的 account-center 分支**只有「禁用本地直连密钥」一个行为**——不存在登录流程、令牌换取、账号中心 API 客户端、设备注册等任何集成代码。F6 声称「account-center 模式存在即手机端账户体系的落点」**高估了现状**：模式位（mode bit）真实存在，但「凭据由账号中心下发」是未来集成语义，当前实现是「无密钥」而非「从账号中心取密钥」。

### 10.3 结论

**成立（AC 对账号中心的结构与差距描述与实读完全一致）；F6 表述需收窄（修正项）。**
- AC 的核心裁决「需调整（非重做）：核心直接复用 + push_tokens/relay_credentials 两模块新增 + 白名单扩展」有完整代码证据（Fastify+SQLite 结构、无 push/relay 模块、单 app 白名单）；
- F6 的 credentialMode=account-center 引用行号准确（provider.rs:153-155 / 256-263），但应把「凭据由账号中心下发」改为「模式位已存在，集成（登录/取凭据/设备注册）全部为新增」——否则实现方会误以为桌面侧已有账号中心客户端。

---

## 11. 审计点 10：前端 Transport 契约

### 11.1 方案声称（文档 + 章节）

| 来源 | 声称 |
|---|---|
| D1 §6.6 | `Transport` 接口：`call/request/send/onMessage/onStatus/waitUntilConnected/stop/getStatus/isReady`（types.ts:47-83）；`TauriTransport` 实现（tauriTransport.ts:158-210 附近）；事件载荷「逐字透传，不做归一化」（tauriTransport.ts:13-15）；上层（EventRouter/ConnectionLifecycle）只依赖接口（types.ts:20） |
| D1 §5.9 | `TransportStatus` 四态（types.ts:29） |

### 11.2 代码实读

1. **接口**：`apps/crish-desktop/src/api/transport/types.ts:47-83`：`call<T>`（:54）、`request<T>`（:57-61）、`send`（:64）、`onMessage`（:67）、`onStatus`（:70）、`waitUntilConnected`（:73）、`stop`（:76）、`getStatus`（:79）、`isReady`（:82）——**与 D1 声称的 11 项逐字段吻合**。
2. **类型**：`TransportStatus` 四态 `'disconnected' | 'connecting' | 'connected' | 'failed'`（:29）；`TransportCallResult<T>` = `InvokeTypedResult<T>`（:35，三态）；`TransportMessage = Record<string, unknown>`（:32）。
3. **设计约束注释**：`:20-26`「上层（EventRouter / ConnectionLifecycle 等）只依赖本接口」「request/send/call 的 type 即命令名：Tauri 路径直接对应 core_* / config_* 等命令（无 WS 消息 type 映射层，命令名直传）」「事件载荷不做二次归一」——与 D1 §6.6.1 声称一致。
4. **TauriTransport**：`tauriTransport.ts:17` 注释「不依赖 WebSocket：无心跳、无重连（进程内核心，断连即应用退出）」——D1 §1.1 引用属实。
5. **可复用性判断**：接口形态（命令名直传 + 广播 onMessage + 状态四态）与跨端协议语义（command/command-ack + event 帧 + hello 握手）同构，作 RemoteTransport 的契约面**成立**。

### 11.3 结论

**成立（1 项类型依赖需注意）。** 接口形态与声称完全一致。注意项：`TransportCallResult` 直接引用 `tauriInvoke` 的 `InvokeTypedResult`（types.ts:35）——抽共享包时该类型需一并移出或做依赖倒置（接口不依赖 Tauri 实现类型），D1 §6.6.2 未提及此点；`tauriTransport.ts` 的 listen('workbench-run-event') 对应 onMessage，RemoteTransport 需把 WS event 帧映射为同一回调形态——语义同构但实现差异未在方案中展开（缺口 G-8 相关）。

---

## 12. 审计点 11：融合度总体结论

### 12.1 真实性统计

- **成立：8/10**（事件基、事件桥、命令面、审批、游标、S1 协议、纯函数、Transport 契约）
- **成立但需改造/注意：2/10**（类型生成 = 参数化改造任务；游标续传 = Store 无 limit + 内存分页性能注意，D6 已诚实标注）
- **不成立：0/10**
- **需修正：8 处**（F-1 命令条数旧口径 ×3 文档、F-2 apps/crish-mobile 目录引用、F-3/F-4 白名单冲突 ×2、F-5 函数名、F-6 装配点不一致、F-7 事件变体张力、F-8 行号漂移 ×4 处）——详见 §0.3 速览表与 §13.2 明细。

**融合度定性：方案声称的融合点全部有真实代码底座，无一虚构；「零协议发明 / 零引擎改动 / 复用现有入口」三类核心主张均经受住实读核对。主要失真集中在「口径陈旧」（命令条数 92→95）与「文档间白名单不一致」（D2 分级 vs M6 特批 vs D5 remote_manifest 三张表），属于方案协调层问题而非代码事实错误。**

### 12.2 各方案融合点质量排名（按实读吻合度）

| 方案 | 融合点质量 | 备注 |
|---|---|---|
| F3 / F6 | ★★★★★ | 引用行号几乎全部精确（toolHandlers.ts:25-30、provider.rs:153-155、tool_exec.rs:1424-1445 等），仅 truncateToolOutput 一处函数名不准 |
| D5 / M7 | ★★★★★ | 审批链路引用精确（resolve :230、pending.remove :235-245、permission.rs:19/96 等） |
| M6 | ★★★★☆ | 41 变体表与命令映射精确，勘误（92→95）准确；生成器泛化未标注改造工作量 |
| D2 | ★★★★☆ | 事件桥结构引用精确；命令条数 92 旧口径 + 文件面 T3/T4 与 M6 冲突 + 行号漂移数处 |
| D1 | ★★★☆☆ | 架构事实（41 变体/信封/Transport/审批）精确；apps/crish-mobile 目录引用错误 + 92 条旧口径 + 装配点与 D2 不一致 |
| D3 | ★★★☆☆ | resume 复用与信封引用正确；92 条口径过时（M6 已勘误，D3 正文未同步） |
| AC | ★★★★★ | account-center 结构/差距/白名单描述与外部代码实读完全一致 |

### 12.3 方案间交叉一致性核对表（跨文档冲突点汇总）

除各审计点内部的修正项外，方案文档之间存在以下需要主控统一裁决的交叉不一致（按影响排序）：

| # | 涉及文档 | 不一致内容 | 实读依据 | 影响面 |
|---|---|---|---|---|
| X-1 | D2 §8.3/§9.1 ↔ M6 §4.3/§4.8 | 文件读写暴露口径相反：D2 列 T4 预留（v1 不暴露）/ T3 拒绝；M6 列白名单特批（v1 可用） | 三条命令实为 surface=gui + registered=true（command_manifest.rs:92-94） | 移动端文件域（F4）v1 功能范围 |
| X-2 | D2 §9.4 ↔ M6 C10/C15 | core_search_files / core_check_command：D2 列 T3 不暴露；M6 映射为可用命令 | 两条命令实为 surface=engine + registered=true（:112-113） | 搜索状态卡 / 审批前置预览 |
| X-3 | D1 §6.2.2 ↔ D2 §4.2/§5 | FanOutEmitter 挂法：D1 倾向「新增第二个 EventBridge 物理解耦」；D2 采用「构造点替换 emitter」 | 桥构造点为单点（main.rs:353-356） | 事件扇出实现落点（缺口 G-1） |
| X-4 | D1 §5.2 ↔ D2 §7.4 | 新增事件变体：D1 建议正规登记 session-index-changed；D2 明确 41 变体冻结不新增 | 登记流程存在（events.rs:789-808）但成本高（三件套 + 生成产物） | 会话列表增量刷新机制（缺口 G-2） |
| X-5 | D1 §6.4.3 ↔ M6 §4 新增面 | D1 不变量「网关暴露 ≤ 现有注册面，不做仅服务端可调新命令」vs M6 的 14 条 `[新增]` mobile_* 命令 | 新增命令无 manifest 条目 | 新增命令登记路径未对齐 |
| X-6 | D5 §4.5 ↔ M6 §4.7 ↔ D2 §9 | 三张白名单表（remote_manifest / M6 映射表+特批 / D2 T1-T3 路由表）口径不一 | 无机器可读单一真源 | 权限漂移风险（缺口 G-6） |
| X-7 | D2 §9.4 ↔ M6 §4.1.9/§4.2.4 | core_list_commands：D2 列 T1（GET /v1/commands）；M6 C09 映射一致但 D2 §8.3 T3 清单把「core_list_commands 自身」语义表述模糊 | :164 engine registered | 能力协商入口口径 |
| X-8 | F3 §4.5 ↔ D1 §2.2.2 | 手机端 PTY stdin：F3 明确只读（§4.5 表格）；D1 §2.2.3 将「终端输入转发（PTY 输入通道，P2）」列于 D5 的 operate 能力（D5 §4.1）——D5 与 F3 对 PTY 输入的 P2 归属不一致 | 桌面 PTY 为 GUI 面（manifest:76-79 workbench_pty_*） | 终端域能力边界 |

> 说明：X-1/X-2/X-3/X-4 已在 §0.3 修正项表中映射（F-3/F-4/F-6/F-7）；X-5~X-8 为额外发现的交叉不一致，建议主控在 D 系列评审会上逐项裁决，避免实现期各子代理各做一套。

---

## 13. 审计点 12：方案未覆盖的代码融合缺口清单

以下为方案（D1-D8/M1-M8/F1-F6/AC/R2）未覆盖或覆盖不足、但实读发现的代码融合难点：

### G-1 事件桥与 Tauri 事件通道的关系（未统一裁决）

- 现状：`Emitter` trait 的 `emit(channel, payload)` 携带 channel 参数，但 `EventBridge` 构造时 channel 恒为 `"workbench-run-event"`（main.rs:353-356），`emit_payload` 固定用该通道。
- 方案缺口：D1 §6.2.2 给出两个落点（「把 TauriEmitter 换为 FanoutEmitter」或「新增第二个 EventBridge 物理解耦」）且**倾向后者**；D2 §4.2 架构图采用**前者**（FanOutEmitter 内部分路 Tauri + WS）。两文档对同一融合点的装配描述不一致，主控未裁决（修正项 F-6）。若实现各自为政，会出现「WS 扇出挂在哪一层」两套实现。
- 建议：冻结为单一决策——推荐 D2 形态（替换构造点 emitter 为 FanoutEmitter，内部保留 TauriEmitter 分支），但需明确 channel 语义（WS 侧不区分 channel，还是按 channel 过滤转发）。

### G-2 「41 变体冻结」与「新增事件变体」的语义张力

- 现状：41 变体是 `ALL_TYPE_NAMES` 宏 + `contracts/engine-events.json` + `registry_drift.rs` 三方锁定的封闭集；新增变体走三件套流程（成本：Rust enum arm + 注册表 + 生成产物 + 前端类型）。
- 方案缺口：D1 §5.2 建议**新增** `session-index-changed` 事件变体（「正规登记新事件变体」）；D2 §7.4 明确「**不新增事件变体**（41 变体冻结，新增需走注册表 + 前端生成产物，成本高）」改为 StatusDiagnostics + 轮询。D1 的 O1 已列此开放问题但两方案结论相反，主控未裁决（修正项 F-7）。
- 影响：决定 F5 会话列表增量刷新机制的协议形态（事件面 vs 轮询面），直接影响 D2/M6/F5 三份文档的同步面设计。

### G-3 多窗口 / 多 run 并发时的事件路由

- 现状：单通道顺序（EventRouter.ts:101「前端不校验 sequence，不做乱序缓冲/缺口检测」）；多 run 并发时前端按 runId 过滤（messageBelongsToRun，eventUtils.ts:30-39）；**runId 缺失（None）时放行不过滤**（events.rs:908-910 注释明言「多 run 并发过滤失效」）；timer/cron 事件用伪 runId（events.rs:925-928）。
- 方案缺口：D1/F3 覆盖了 feed 按 run 分组的**设计**，但未强调跨端转发继承「runId 缺失即不过滤」的既有限制；移动端订阅多会话时，无 run 归属的数据面事件（task/timer/cron）与主 run 事件的混流路由需要明确过滤规则（F3 §3.1 分组规则 3/4 已有设计，但「runId 缺失放行」与「数据面隔离」的组合边界未冻结）。

### G-4 游标续传路径的内存无界加载

- 现状：`core_read_session_events` 经 `Store::query_events`（persist.rs:168，无 limit）拉全量 → 内存解析 → 内存分页（core_query_commands.rs:521-531）。
- 方案缺口：D3 `events.resume` 与 M6 C03 都声称「复用 core_read_session_events 契约」——契约可复用，但**实现会全量加载**。D6 §9.1 已提出两个候选（新增 `query_events_paged` / 直调 `LocalDb::query_events(after, Some(limit))`）但未定案。这是同步面落地前必须解决的性能缺口（会议话 >1 万事件的追平场景）。

### G-5 sequence=None 实时帧的跨端去重键

- 现状：前端去重键 `buildEventDedupeKey`（EventRouter.ts:166-189）包含 sequence；实时预览帧 sequence=None（BridgeDeltaSink / 审批广播）。
- 方案缺口：F3 §3.1.1 用 `(eventType, entityId, sequence)` 键 + 事件自带 id（messageId/toolCallId/taskId）兜底，但**未冻结 sequence=None 帧的去重键形态**（跨端实时轨大量事件是 sequence=None 的预览帧，收口轨才带序列号）。D1 §5.3 说「按稳定键 upsert」，具体到 message-delta（无稳定 id 之外的 sequence）时键如何构造未闭环——实现时会在这里出现双轨重复渲染的边界。

### G-6 三张「白名单表」未统一真源

- 现状：D2 §8/§9 的 REST 路由 T1/T2/T3 表、M6 §4.7/§4.8 的协议白名单（含 surface=gui 特批 5 条）、D5 §4.5 的 `remote_manifest.rs` 白名单——**三张表口径不一**（例：文件读写 D2 拒 / M6 特批；core_search_files D2 T3 / M6 C10 可用）。
- 方案缺口：无单一真源与漂移测试。M6 §4.8 已建议「迁移 surface=gui 五条为 engine」但未冻结；D5 §2.9 建议 remote_manifest 扩展 risk_class 但未与 M6 映射表对齐。**这是实现期最可能出「权限漂移」的面**——建议先冻结一张机器可读清单（如 `remote_manifest.json`）再谈分层。

### G-7 进程模型与故障隔离的边界

- 现状：单进程 IPC 模型（main.rs:5-26 文档化）；Tauri 自带 tokio runtime；`tokio-tungstenite` 已在依赖图（conex-browser CDP 链路），**axum 不在依赖图**（D2 §6.1 声称「hyper 已在图」——实读 Cargo.lock 需复核，但 D2 已诚实标注 axum 属新增依赖需 PE-10 登记）。
- 方案缺口：服务与主进程同进程意味着网关 panic / 内存放大会拖垮引擎。D2 §4.1 列了「任务隔离」缓解但未给具体隔离方案（单独 runtime？task-local？panic=abort 语义？）；D5 的 D-01 默认关闭 + D2 的双态监听（loopback 恒开 / 0.0.0.0 仅配对）已缓解暴露面，但**「网关线程池 vs LocalDb 单连接 Mutex」的吞吐上限**（D1 §6.3.2 声称「conn.lock() 自然串行，无新增锁」）缺乏压测数据支撑（8 端并发 × 事件查询分页的场景）。

### G-8 RemoteTransport 的实现差异未展开

- 现状：`Transport` 接口的 `request/send` 语义是「命令名直传」（types.ts:21-22），`TransportCallResult` 三态依赖 `tauriInvoke` 类型（types.ts:35）。
- 方案缺口：D1 §6.6.2 说「新实现 RemoteTransport 实现同一接口」——但跨端协议的命令是 `cmd.*` 包装名而非 Tauri 命令名、响应是 `result.*` 信封而非 invoke 三态；「命令名直传」语义在远程实现中需要一层映射（md 命令名 ↔ 桌面命令名 ↔ manifest）。该映射层属于网关（Rust 侧）还是移动端（TS 侧）未定（D1 把映射放网关侧，但未写进 D2 的 API 面设计——D2 REST 路径按 Tauri 命令名直出，与 M6 的 cmd.* 名不同构，两套命名需在 D2/M6 之间对齐，此点两文档均未覆盖）。

### G-9 桌面端 account-center 集成深度为零

- 现状：provider.rs 只有 credentialMode 模式位（account-center 下 effective_api_key 返回 None），无登录、无令牌换取、无账号中心 API 客户端。
- 方案缺口：F6 声称「account-center 模式存在即落点」高估现状（修正项）；桌面侧 account-center 集成（登录流、token 存储于 OS 凭据库、设备注册、refresh 轮换）在 D1-D8/M1-M8/F1-F6 中只有 AC §7.2 的表格级描述，**没有对应现有代码的融合点设计**（AC 的 15-20 人日估算含此工作量，但无实现锚点）。

### G-10 端级缓冲的键形未冻结

- 现状：`EventBuffer` 按 runId 分桶（buffer.rs:65-70 `runs: HashMap<String, RunQueue>`），水位 Soft 64 / Critical 256（:200-206）。
- 方案缺口：D1 O4 倾向「复用 EventBuffer 按 deviceId 分桶」——但 EventBuffer 的键是 runId、丢帧判定是 drop_class_of（只有 message-delta 是 Soft，:36-42），端级缓冲要处理「按 deviceId 分桶 × 每桶内多 run」与「Delta 可丢、Critical 必达 + 必达失败断端」语义，直接换键是否成立未验证（O4 列为开放问题，但 D2 的 WsBroadcast 设计（wait_channel.rs:201-272 先例）没有逐条对齐「Critical 必达则断端重连追平」的闭环）。

---

## 14. 附录：验证记录与引用索引

### 14.1 本审计实读的关键代码事实（文件:行号 → 语义）

| 主题 | 位置 | 语义 |
|---|---|---|
| 41 变体声明 | crates/conex-types/src/events.rs:304-782 | `#[serde(tag="type")]` tagged enum |
| 41 变体清单 | events.rs:810-852 | `ALL_TYPE_NAMES` 宏，41 条 |
| 事件登记纪律 | events.rs:789-808 | 新增变体须同步 contracts/engine-events.json + registry_drift.rs |
| 背压分级 | events.rs:867-903 | Delta/Soft/Critical；subagent kind 级 898-903 |
| 信封结构 | events.rs:921-933 | event + runId + sequence + schemaVersion |
| 信封扁平序列化 | events.rs:941-964 | 顶层插入 runId/sequence/schemaVersion |
| 信封反序列化 | events.rs:966-992 | schemaVersion 缺省补 1 |
| PermissionRequest | events.rs:196-218 | toolCallId/toolName 必填 + 权限传递层字段 |
| ApprovalDecision | events.rs:223-232 | approved/denied/expired |
| ToolUpdate 事件 | events.rs:379-386 | sessionId/batchId/toolCallId/update/timestamp |
| run-terminal | events.rs:511-519 | terminal + error，runId 信封注入 |
| Emitter trait | core_event_bridge.rs:51-54 | emit(channel, payload) |
| TauriEmitter | core_event_bridge.rs:57-81 | app.emit("workbench-run-event", ...) |
| EventBridge.serialize | core_event_bridge.rs:107-120 | 信封 → 扁平 JSON |
| EventBridge.emit_payload | core_event_bridge.rs:137-144 | 已序列化载荷直发 |
| 扁平载荷测试 | core_event_bridge.rs:196-220 | payload_is_flat_top_level_envelope_json |
| 零 crate:: 引用 | core_event_bridge.rs:2-4 | #[path] 独立编译测试先例 |
| 单进程 IPC 模型 | main.rs:5-26 | 进程内核心装配层文档 |
| EventBridge 构造点 | main.rs:353-356 | new("workbench-run-event", TauriEmitter) |
| restore spawn | main.rs:388-392 | run_restore 异步执行 |
| browser 旁路发射器 | main.rs:404-406 | browser://state-changed 独立 TauriEmitter |
| task 事件桥注入 | main.rs:414 | set_event_bridge(bridge.clone()) |
| timer/cron drain | main.rs:445-456 | 500ms tick → forward_drained_* |
| 退出钩子 | main.rs:482-488 | RunEvent::Exit → PTY 清理 + 快照 |
| 注册面==manifest 测试 | main.rs:500-514 | registration_surface_matches_manifest |
| 丢帧类目 | buffer.rs:36-42 | 仅 message-delta 为 Soft |
| 水位默认值 | buffer.rs:200-206 | Soft 64 / Critical 256 |
| BufferedRunEventBridge.emit | engine.rs:1703 | 入队即序列化 |
| BufferedRunEventBridge.flush | engine.rs:1729 | drain → emit_payload |
| BridgeDeltaSink | engine.rs:1743+ | 实时轨，sequence=None |
| ApprovalGateImpl | core_run_commands.rs:161-187 | pending 集合 + oneshot 通道 |
| resolve | core_run_commands.rs:230-258 | I-02：pending.remove 不存在 → NotFound |
| request_approval | core_run_commands.rs:263-343 | 先发后等 + 120s 超时 Expired |
| BridgeAuditSink | core_run_commands.rs:448-490 | 审计落库 + bridge.emit/flush |
| core_run_task 薄壳 | core_run_commands.rs:3038-3044 | 委托 run_task_impl |
| run_task_impl | core_run_commands.rs:3049+ | 契约体，测试可直调 |
| 串行守卫 | core_run_commands.rs:3088-3096 | 同会话同时只允许一个活动 run |
| 审批实时预览 | core_run_commands.rs:3148 | approval-requested 信封 sequence=None |
| core_approve_tool | core_run_commands.rs:3768-3792 | decision 仅 approved + resolve + emit |
| core_deny_tool | core_run_commands.rs:3795-3818 | reason 缺省 user denied |
| emit_approval_resolved | core_run_commands.rs:3820-3854 | 落库 + 实时发射 |
| EventPage | core_query_commands.rs:328-338 | events/nextAfterSequence/hasMore |
| core_read_session_events | core_query_commands.rs:510-539 | Store 全量拉取 + 内存分页 |
| core_read_run_events | core_query_commands.rs:541-588 | 按信封 runId 过滤 |
| manifest 条目 | command_manifest.rs:29-38 | name/family/surface/registered |
| surface 语义 | command_manifest.rs:33-38 | engine = 三端共用 |
| 95 条清单 | command_manifest.rs:68-191 | 91 registered + 4 登记先行 |
| 条数测试 | command_manifest.rs:209-210 | 95 = 91 + 4 |
| query_events | conex-db/src/events.rs:33-68 | 开区间 sequence > ? LIMIT ? |
| reserve_sequence | conex-db/src/events.rs:72-99 | session_sequence 原子取号 |
| seed_sequence | conex-db/src/events.rs:103-121 | MAX 语义幂等 |
| Store.query_events | orchestrator/src/persist.rs:168 | 无 limit 版本 |
| S1 时序契约 | session-loop/src/tool_events.rs:1-9 | tool-batch-start → (start→approval→update*→end)* → batch-end |
| ToolEvent::ToolProgress | session-loop/src/tool_events.rs:63-66 | 翻译层映射 ToolUpdate |
| S1 出站映射 | session-loop/src/tool_exec.rs:1424-1445 | Text/Custom/Content → ToolProgressUpdate |
| ToolUpdate 落地 | session-loop/src/loop/handlers/executing_tools.rs:269-279 | 展示面事件，不进消息历史 |
| ToolProgress 定义 | agent-tools/src/streaming.rs:39+ | Text/Custom/Content |
| 权限三态 | agent-tools/src/permission.rs:19/57 | PermissionMode / PermissionVerdict |
| 红线判定 | agent-tools/src/permission.rs:96/113/135 | decide_with_redline / decide_command / decide_command_with_revert |
| Transport 接口 | apps/crish-desktop/src/api/transport/types.ts:47-83 | call/request/send/onMessage/onStatus/waitUntilConnected/stop/getStatus/isReady |
| Transport 四态 | types.ts:29 | disconnected/connecting/connected/failed |
| 无 WebSocket 注释 | tauriTransport.ts:17 | 进程内核心，断连即应用退出 |
| tool-update 空实现 | toolHandlers.ts:25-30 | 手机端领先消费依据 |
| mergeAssistantTextPiece | eventUtils.ts:49-63 | 终态权威合并 |
| messageBelongsToRun | eventUtils.ts:30-39 | null runId 放行 |
| 单通道顺序 | EventRouter.ts:101 | 不校验 sequence、不做乱序缓冲 |
| toolCardPresenter 纯函数 | toolCardPresenter.ts:25/306/336/500/846/878/893 | extractToolCommand/toolHumanLabel 等；0 react 引用 |
| 本地输出截断 helper | toolCardPresenter.ts | ln(output, maxLines=16, maxChars=1600)（非导出，F3 引用名不准） |
| 批合并器 | streamTextBatcher.ts:64/78/258/335 | 48ms / 8000 / StreamTextBatcher / isImmediateToolStatus |
| 会话搜索纯函数 | sessionSearch.ts:184/236/345/417 | ellipsizeCodepoints/makeSearchSnippet/messageMatchesSearch/matchSessionSearch |
| 生成器注册表驱动 | scripts/generate-engine-bindings.mjs:25-39 | REGISTRY_PATH/OUT_DIR 硬编码 |
| 生成器 contract 校验 | generate-engine-bindings.mjs:87-96 | 仅接受 engine-events |
| 生成器幂等 | generate-engine-bindings.mjs:16 | 无时间戳/随机，双跑同字节 |
| credentialMode=account-center | config/provider.rs:153-155/256-263/314 | 模式位真实存在；无客户端集成 |
| 账号中心 Fastify+SQLite | account-center/.../package.json | fastify ^5.8.4 / better-sqlite3 ^12.8.0 |
| DESKTOP_AUTH_APPS | account-center/.../auth.service.ts:244 | 仅 chat_sync_desktop |
| 无 push/relay 模块 | account-center/.../src/modules/ | 22 模块目录实列 |
| MCP 先例 | dev_mcp.rs:21-31 | CRISH_MCP_SOCKET=1 / 端口 4000 loopback |
| CSP 预留 8765 | tauri.conf.json:29 | connect-src 含 127.0.0.1:8765 / ws://127.0.0.1:8765 |

### 14.2 需修正项明细（合并 §0.3）

| # | 归属 | 内容 | 建议 |
|---|---|---|---|
| F-1 | D1 §6.4.1 / D2 §2.2+§9 / D3 §2.4+§10.2 | 命令条数 92 = 88 + 4 过时 | 统一为 95 = 91 + 4（M6 §2.3 勘误转正） |
| F-2 | D1 §6.7 | 「apps/crish-mobile/（现有目录）」不存在 | 改「新增 apps/crish-mobile/」（legacy 在 reference/mobile-companion-app，R2A 已裁决删除） |
| F-3 | D2 §8.3/§9.1 ↔ M6 §4.3/§4.8 | 文件读写暴露矛盾（T4 预留 vs 白名单特批） | 主控裁决 v1 文件面口径并冻结单一清单 |
| F-4 | D2 §9.4 ↔ M6 C10/C15 | core_search_files/core_check_command 暴露矛盾 | 同 F-3 |
| F-5 | F3 §3.4.2 | truncateToolOutput 函数名不存在 | 改引用本地 helper 语义或现有导出（fullToolOutput 等） |
| F-6 | D1 §6.2.2 ↔ D2 §4.2/§5 | FanOutEmitter 挂法不一致 | 统一装配决策（建议 D2 形态 + 明确 channel 语义） |
| F-7 | D1 §5.2 ↔ D2 §7.4 | 新增事件变体 vs 41 变体冻结 | 按 D1 O1 尽快裁决，冻结事件面边界 |
| F-8 | D1/D2 多处 | 行号漂移（EventBridge::new / 退出钩子 / 串行守卫 / BufferedRunEventBridge） | 以 2026-08-09 快照刷新；后续以符号名双索引 |

### 14.3 审计局限

- 本审计未实读的行段（以方案引用为口径复核）：schema.rs:141-149（events 表复合主键，经 events.rs INSERT 行为与 UNIQUE 约束间接确认）、approval_router.rs:60-118 全段（经 grep 符号确认存在，未逐行）、Cargo.lock 的 axum/tokio-tungstenite 条目（D2 §6.1 声称，本审计未核读锁文件）、account-center 的 auth.service.ts 2224 行全量（仅核对关键锚点 :244/:1145/:356-393 引用点）。
- 行号随代码演进会漂移；结论以符号名为准，行号为 2026-08-09 快照。

### 14.4 外围方案简核（R2A/R2B/M1/M8/D4/D7 关键交叉点）

对任务书点名的外围方案做关键交叉点简核（非融合点深审，仅确认不产生与主审计冲突的事实错误）：

| 方案 | 关键声称 | 实读 | 判定 |
|---|---|---|---|
| R2A | 「apps/crish-mobile 为纯实验性原型，无 git、无测试，建议整目录删除」 | 仓库 `apps/` 下**当前只有 agent-workbench 与 crish-desktop**，无 crish-mobile 目录；`reference/mobile-companion` 与 `reference/mobile-companion-app` 存在（legacy 原型）；R2A 声称的「目录未被 git 跟踪」与现状一致（目录已不存在） | 成立（佐证 D1 §6.7 引用为需修正项 F-2） |
| R2B | 移动端技术选型（固定 PIN / 假加密教训） | 本审计不涉及移动端代码（apps/crish-mobile 不存在），M7 §3.3 引用其「宁可要 PIN 也不做假解锁」教训与 D4 §7.4 对齐 | 无代码事实冲突 |
| M1 | 多平台（跨端技术选型） | 不涉及现有仓库代码融合点，未发现与实读冲突的代码引用 | 无冲突 |
| M8 | 推送发布 | 依赖 D7 推送体系；D7 依赖 account-center push_tokens 注册表（AC §6.3）——账号中心侧实读无 push 模块，缺口判断与 AC 一致 | 成立（依赖链自洽） |
| D4 | 移动端技术选型 | 引用桌面 Transport/handler 复用（与 D1 §6.6 一致），本审计确认这些模块可复用（§8） | 成立 |
| D7 | 推送通知 | 依赖 D6 同步面事件白名单（M6 §5.0 同步面 20 事件）——该白名单为方案登记值，无代码冲突 | 成立（登记值） |

### 14.5 一句话总结

**方案声称的融合点 8/10 完全成立、2/10 成立但需改造注记、0 不成立；需修正 8 处（命令条数旧口径、apps/crish-mobile 目录引用、D2 与 M6 白名单冲突、FanOutEmitter 装配点不一致、事件变体冻结张力、函数名与行号漂移）；最大融合风险 = FanOutEmitter 装配点两文档不一致 + 「41 变体冻结 vs 新增事件变体」未裁决导致的事件面分裂。**
