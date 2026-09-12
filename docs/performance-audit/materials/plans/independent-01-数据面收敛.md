# independent-01 · 数据面收敛（事件流 · IPC · SQLite · 持久化单轨 · 消息驻留）

> **战役**：performance-audit → performance-fix  
> **创建**：2026-09-13  
> **性质**：独立完整修复总计划（数据面主视角）。不与其他并行总案对齐；`91-系统性修复总方案.md` 仅作对照草稿，可推翻。  
> **上游**：`00-性能审查总纲.md`、`90-发现清单索引.md`（396 项 / 86 高 / 16 簇）；按需抽读 03/04/05/08/10 报告；关键代码锚点已 rg/read 核实。  
> **明确不谈**：工期、人员、业务优先级。下列顺序 = 逻辑依赖拓扑；问题同权。

---

## 1. 全局效果锁（不缩水）

### 1.1 问题范围锁

本计划完整覆盖数据面五域的**全部**已登记问题，不得降级、不得砍项、不得以「简化版 / MVP」替代：

| 域 | 覆盖发现（节选，完整映射见 §5） | 锁定语义 |
| -- | -- | -- |
| 事件流 | 03-R1/R2/R3/R4/R5/R6/R7/R8、04-S1/S2/S3/T1/K2、09-L1/L2/A1/B1、10-T3/T4 | token/事件从产生→emit→旁路→落库的**全链放大**必须收敛，禁止只修一端 |
| IPC | 03-V1/V2/V3/V4、03-C1/C2/C3、15-FAN01/PSHP03/XOV01 | 前端传输恰 1 次 parse；旁路禁全量反解析；双发消除 |
| SQLite | 05-S1/S2/S3、05-W1/W2/W3/W5、05-R1/R2/R3、05-Q1/Q2、05-G2、03-I1 | 组提交真接线；增量 save；读路径 ReaderPool 完备；索引与 GC 出锁 |
| 持久化单轨 | 08-H1/H4、07-D2/D3、01-M9、sessionIndex 双源 | SQLite 法定唯一会话存储；zustand persist 全量 sessions **物理切除** |
| 消息驻留 | 08-H2/H3/H5/H6、05-R2、09-S1/E1、03-V4、13-C13-M7（交叉） | 非活跃可驱逐；工具输出 hardCap；恢复分页可取消；快照记账完整 |

### 1.2 目标不变量（修复后必须成立；与 90 簇 C1/C4/C5/C8/C16 对齐）

| ID | 不变量 | 现状锚点（核实） |
| -- | -- | -- |
| DP-INV-1 | 非增量事件跨 webview IPC **恰 1 遍** | 双发：实时轨 `emit_event` + 收口轨 `run_idle.rs:1397-1428` 再 emit |
| DP-INV-2 | NoPersist 事件 **0 次** sequence 取号 SQL | `orchestrator/events.rs:246-263` 先 reserve 后 `is_non_persistent` |
| DP-INV-3 | 生产域写**零** `self.conn.lock()` 旁路；全部经组提交 Writer | 全仓 `db.write(`/`writer().write` 生产命中 0；域方法 100+ 处 lock |
| DP-INV-4 | 前端对废弃 persist 岛 **0 读 0 写**；`sessionStore` partialize **不含** `sessions` | `sessionStore.ts:64-69` 仍 `sessions: s.sessions` |
| DP-INV-5 | 数据面事件 `parseBridgeEvent` 恰 **1 次** | `EventRouter.onMsg` 先 parse 再在 `handleAgentEvent:152` 丢弃；`dataPlaneRouter` 另 parse |
| DP-INV-6 | 工具输出全链同预算常量；超限 `truncated` 透传 | `output_budget_bytes` 默认 None；`save_session_body` 无 dirty |
| DP-INV-7 | 非活跃会话 messages 可软驱逐；激活懒水合（已有 K=5）对称驱逐 | activate 只增不减；无 evict |
| DP-INV-8 | 持久化事件收口批：**整批单事务**；取号批量化后 SQL 数 O(1) | `drive_outcome` 逐条 `queue.push` await；`reserve_sequence` 3 语句 |

### 1.3 禁止退避

- 不得以「契约禁止合并」为由保留 token 全链逐条放大——PE-02 的解释空间（同 block 追加合并保持顺序）必须进入裁决票，禁止静默放弃。
- 不得以「组提交已写但未接线」冒充完成——接线 + 负向断言（生产 0 旁路）才算完成。
- 不得以「部分兼容读旧 LS 键」保留双源——旧岛物理删除后 boot 一次性 migration，再删读代码。
- 不得新增无删除日期的 fallback/降级轨。

---

## 2. 维度划分与逻辑依赖序

### 2.1 概念清单（推进单位）

| 维度 | 概念 | 当前路径数 | 目标路径数 |
| -- | -- | -- | -- |
| D-A | 事件序号（sequence）分配 | 1（reserve 恒走，含 NoPersist） | 1（**仅持久化事件** reserve） |
| D-B | 会话/事件写路径 | 2（主 Mutex 直写 + 空转组提交 Actor） | 1（组提交 Writer） |
| D-C | 会话 body 持久化 | 3（前端全量重发 / SQL 先删后插 / 前端 LS persist 全量 sessions） | 1（SQLite 增量 UPSERT；LS 无 body） |
| D-D | 事件 → webview 投递 | 2（实时轨全文 + 收口轨全文双发） | 1（实时全文 + 收口 sequence 回执/免发） |
| D-E | 前端事件解析 | 2（dataPlaneRouter + EventRouter 各 parse） | 1（过滤前移，parse ×1） |
| D-F | 会话索引源 | 2（localStorage 优先 + SQLite 回退） | 1（SQLite） |
| D-G | 消息驻留 | 1（永不驱逐，无预算） | 1（预算 + 软驱逐 + 懒水合） |
| D-H | 工具输出字节账 | 多源散落（None / 200KB shell / 前端 hardCap 未接） | 1（预算常量源） |
| D-I | 旁路元数据提取 | 2（fanout 全量 parse + push AgentEvent parse） | 1（emit 侧 meta 一次构造，旁路零反解析） |
| D-J | 审计通道 | 1（Unbounded mpsc） | 1（有界 + 溢出可观测） |

### 2.2 逻辑依赖序（为何是这个顺序）

```text
Layer-0  契约与预算 SSOT（数字唯一源 + 切除登记表启用）
    │   （无 SSOT，后续接线会再次分叉；预算不锁则 hardCap/截断各自为政）
    ▼
Layer-1  写路径减负（先减载，再换轨）
    │   D-A  NoPersist 跳过取号（零契约、纯重排序）
    │   D-H  工具输出默认预算 + Arc（事件层截断先于 DB）
    │   D-J  审计通道有界化（防止组提交接线后审计侧仍无界堆积）
    ▼
Layer-2  写路径单轨（DB 侧 SSOT）
    │   D-B  组提交 Actor 真接线 + 读路径 ReaderPool 完备 + 取号单语句
    │   D-C-DB  save_session_body 增量 UPSERT（先删后插物理删除）
    │   （依赖 Layer-1：NoPersist 不进批、输出已截断，组提交负载可预期）
    ▼
Layer-3  持久化前端单轨（减写入量 + 切旧岛）
    │   D-C-FE  dirty 检测 + partialize 切除 sessions + LS 旧键物理删除
    │   D-F  索引单源收口到 SQLite
    │   （依赖 Layer-2：SQLite 侧必须已能增量/CAS，否则前端 dirty 无意义）
    ▼
Layer-4  传输与投递收敛
    │   D-E  数据面单 parse
    │   D-I  旁路 meta-only
    │   D-D  双发消除（需 engine-events 契约；强契约层）
    │   （依赖 Layer-2/3：写路径稳定后再动 IPC 语义，避免双变量）
    ▼
Layer-5  驻留与恢复
    │   D-G  消息软驱逐 + 快照记账 + 水合可取消
    │   （依赖 Layer-3：persist 单轨后驱逐不破坏恢复正确性）
    ▼
Layer-6  强契约事件语义收口
    │   双发消除终态 / message-start 瘦身 / PE-02 同 block 合并裁决
    ▼
Layer-7  观测闭环与负向断言全绿
```

**并行规则**：同一 Layer 内文件域不相交可并行；**收敛/删除类任务一律串行**（先删后改）；跨 Layer 禁止「先改消费端再改生产端」。

**禁止反例**（本计划明确否决）：

- 未接组提交前，不得只改前端 debounce 掩盖 DB 尖峰；
- 未做 NoPersist 跳过前，不得把收口批「事务化」包住 NoPersist 白付取号；
- 未物理删除 zustand persist `sessions` 前，不得声称「持久化已优化」；
- 未过滤前移前，不得用 `requestIdleCallback` 延迟 parse 冒充单 parse；
- 未 PE-02 裁决前，不得静默 N 合 1 token；也**不得**以「契约禁止」为由拒绝开评审票。

---

## 3. 删什么 / 收敛什么（逐条）

> 每条：概念 · 现状路径数→目标路径数 · 入口出口文件 · 动作。  
> 「无删除须验证依据」仅适用于本计划范围外项——本计划**有**删除面，见下。

### 3.1 必须物理删除（禁止注释隐藏 / 双轨兼容）

| # | 概念 | 路径数 | 现状入口/出口 | 删除物 | 替代 |
| -- | -- | -- | -- | --- | -- |
| DEL-1 | 组提交旁路：域方法直写主 Mutex | 2→1 | 入：`events.rs:21` / `sessions.rs:16` / `runs.rs:120` / `messages.rs:55` / `blocks.rs:153` / … 出：`LocalDb::conn` | 全部生产路径 `self.conn.lock()` **写**方法改为 `writer`；删除与 Writer 并行的直写分支 | `LocalDb::write` / `blocking_db_call`→writer oneshot |
| DEL-2 | save_session_body 先删后插 | 1→1（形态替换） | 入：`session_commands.rs:140` 入：`messages.rs:50-102` | `DELETE FROM session_messages` 全段 + 逐条 INSERT 循环 | 按 id/seq 的增量 UPSERT + 批末单次 message_count 重算 |
| DEL-3 | 双触发器 message_count 写放大 | 1→0（触发器）| `schema.rs:262-272` insert/delete 触发器 | 两支触发器 DDL（v 迁移 DROP） | 保存路径末 `UPDATE sessions SET message_count=(SELECT COUNT…)` 或读时计算 |
| DEL-4 | NoPersist 取号 | 1→0 | 入：`orchestrator/events.rs:246` 出：`reserve_sequence` | 取号在 `is_non_persistent` **之前**的控制流 | 判定前移；NoPersist sequence=None |
| DEL-5 | zustand persist 全量 sessions | 1→0 | `sessionStore.ts:64-69` partialize；`crish_session_store` 键内 sessions 字段 | partialize 中的 `sessions` 字段；boot 后旧键 sessions 字段清除 + 读代码删除 | SQLite hydrate（已有）+ 仅元数据 LS（activeSessionId/folderOrder/drafts 可保留） |
| DEL-6 | 会话索引 localStorage 优先双源 | 2→1 | 入：`sessionRustDbHydrate` / `lsSaveSessionIndex` 出：`crish_session_index_v1` 等 | 「LS 优先、SQLite 回退」分支与读路径 | SQLite 单源；LS 索引键迁移后删除 |
| DEL-7 | 前端全量重发所有会话 body | 1→dirty 集合 | 入：`sessionRustDbHydrate.ts:347-360` 出：每会话 `saveSessionBody` | 对未变更会话仍发 body 的循环体 | dirty 引用比较（`sessionsById` 前一版快照）；仅 dirty 进 bodyJobs |
| DEL-8 | batch_version Rust 侧静默丢弃 | 1→1（真消费） | 入：`sessionRustDbSql.ts` 传 batchVersion 出：`session_commands.rs` 签名 | 签名中丢弃参数的行为 | 签名接收 + CAS 校验；过期写拒绝上抛 |
| DEL-9 | 收口轨对 webview 全文再投递 | 2→1 | 入：`run_idle.rs:1400-1421` 出：`bridge.emit` | 非 delta 事件第二次**全量 payload** emit | sequence 回执摘要信封（旁路 fanout/push 仍可读完整事件——从落库/内存 store 取，不再二次 IPC） |
| DEL-10 | EventRouter 数据面先 parse 后丢弃 | 2→1 | 入：`EventRouter.ts:225-227` → `:152` | parse 后在 handleAgentEvent 丢弃的路径 | `isDataPlaneEventType` 前移到 parse 之前 |
| DEL-11 | fanout `from_value(value.clone())` 全量 | 1→0 | 入：`fanout.rs:281-293` | 整树 Value 深拷贝 + AgentEvent 二次 parse | emit 侧同步产出轻量 `EventMeta`；旁路只读 meta |
| DEL-12 | 审计 Unbounded 通道 | 1→1（有界） | 入：`run_core.rs` audit worker / 04-O1 | `unbounded_channel` 无界堆积语义 | 有界 + 丢弃计数可观测（与 EventBuffer Critical 策略对齐） |
| DEL-13 | reserve 三语句自动提交 | 1→1（单语句/单事务） | 入：`events.rs:201-227` | 三段各自 execute 无事务 | `UPDATE … RETURNING` 或单事务；冷路径 seed 保留 |
| DEL-14 | drive_outcome 逐条 await DB | 1→1（批事务） | 入：`orchestrator/events.rs:450-475` | 循环内逐条 push 的串行形态 | 批量取号区间 + 单事务 INSERT 组；Q25 语义改为批首序号 |
| DEL-15 | 前端 body/agents 全量 normalize 重发 | 1→增量/仅 dirty | 入：`sessionRustDbHydrate.ts:350-359` | 每次 persist 对全部会话 `normalizeAssistantTimeline` | 仅 dirty 会话 normalize；agents 同理 |

### 3.2 收敛但不整文件删除

| # | 概念 | 收敛动作 | 入口 |
| -- | -- | -- | -- |
| CNV-1 | 读路径 ReaderPool | `events/runs/blocks/usage` 纯读改 `self.read()` | `events.rs:46,94,136,163` 等 |
| CNV-2 | load_session_body | 增加分页 API；全量 API 保留供恢复终态 | `messages.rs:10-46` |
| CNV-3 | 工具输出 Arc | ToolEnd.output / 大 String `Arc` 化至 emit 与消息累积 | `executing_tools.rs` / `events.rs` |
| CNV-4 | 实时轨伪缓冲 | push_live 改为「入队 + 时间窗/Critical 条件 flush」 | `engine_channels.rs:714-728` |
| CNV-5 | push 旁路 on_event | meta-only，禁全量 AgentEvent parse | `push/pusher.rs` |
| CNV-6 | message-start 全文 | 载荷降摘要（契约层；消费面已空） | `mod.rs` record_message / parser |
| CNV-7 | 水合 | AbortSignal 贯穿；每页投影后丢弃原始事件 | `sessionEventHydrate.ts` |
| CNV-8 | MessageSnapshots | 全量副本计入预算 | `MessageSnapshots.ts` |

### 3.3 本计划范围外（明确不做，防蔓延）

- 前端渲染帧预算 / 卡片 memo / 终端 WebGL（01/02/12 域）——仅在事件面交叉处引用 ID，不展开实现。
- 启动 catalog 静态图 / 资产体积（07/11/16）——persist 单轨与 setup 分级的文件域不相交。
- Gatekeeper / DNS / UIA（14）——阻塞面治理另一维度；工具输出预算（D-H）与之在 10-T4 交叉，以本计划 D-H 为准推进事件层截断。
- PE-02 的**实现**：本计划只开裁决票与前置减负；同 block 合并实现排在 Layer-6。

---

## 4. 任务分解

> 每任务固定六段：做什么 / 删什么 / 依赖 / 唯一文件域 / 验收（功能 + 负产出 + 五端物证）。  
> 路径收敛问题：每任务开头用「N→M」作答。

---

### Layer-0

#### T-L0-A · 预算 SSOT（数据面相关子集）

| 项 | 内容 |
| -- | -- |
| 路径收敛 | 散落数字源 ∞ → 1（Rust `perf_budget` + 前端 `perfBudgets`） |
| 做什么 | ① 新建 `crates/conex-shared/src/perf_budget.rs`（或等价 shared 位置）与 `apps/crish-desktop/src/api/perfBudgets.ts`；② 迁入：工具输出字节上限、shell 200KB、EventBuffer 软/硬水位、会话消息驱逐 K、预览行/字节、水合页大小、PTY 合批窗（预留）、delta 合并窗（**预留常量，PE-02 解锁前禁止生产读取**）；③ `scripts/check-perf-budgets.mjs` 骨架：业务代码字面量预算未 re-export 则 warn（接 CI 后 fail）。 |
| 删什么 | 各文件内散落的**重复定义**（保留引用）；禁止新魔数。 |
| 依赖 | 无。可与 T-L1-A 并行。 |
| 唯一文件域 | `crates/conex-shared/src/perf_budget.rs`、`apps/crish-desktop/src/api/perfBudgets.ts`、`scripts/check-perf-budgets.mjs`；各调用点**只改 import**不改行为（一次性机械）。 |
| 验收 | 功能：现有行为不变（单测绿）。负产出：预算数字出现在非源文件计数 = 0（脚本）。五端：触发=脚本可跑；传输=n/a；介质=常量文件入库；消费=工具截断/驱逐后续任务从该源取数；负向=`rg` 魔数清单比对。 |

#### T-L0-B · 物理切除登记表

| 项 | 内容 |
| -- | -- |
| 做什么 | 启用 §3 DEL-1…DEL-15 登记表（本计划 §3 已列）；执行时逐项打勾；新增删除项必须先登记。 |
| 删什么 | 无代码删除（流程装置）。 |
| 验收 | 登记表与实现 PR 一一对应；未登记的「顺手删」打回。 |

---

### Layer-1

#### T-L1-A · NoPersist 跳过取号（D-A）

| 项 | 内容 |
| -- | -- |
| 路径收敛 | 取号路径对 NoPersist：1→0 |
| 做什么 | `EventQueue::push`（`orchestrator/src/events.rs:244-264`）：将 `is_non_persistent(&event)` **前移**至 `reserve` 之前；NoPersist 返回 `sequence: 0` 或 `None`（与消费方约定；前端本不消费）；复核失败复用序列（Q25）对「未取号失败」的语义；扩展 `events.rs` 单测：NoPersist 不触达 store.reserve。 |
| 删什么 | 「先 reserve 后判定」控制流（DEL-4）；相关注释更新。 |
| 依赖 | 无。**必须先于组提交接线**（否则组提交批内仍含白付 SQL）。 |
| 唯一文件域 | `crates/orchestrator/src/events.rs`（+ 其测试）。**不碰** `conex-db`。 |
| 验收 | 功能：delta 类事件仍正确进入实时轨、不落库；run 终态恢复序列连续语义与 Q25 测试一致。负产出：控制流删除；路径 1→0。五端：触发=普通 run 收口；传输=保留；介质=events 表无 NoPersist 行；消费=seed_sequences/MAX 语义不变；负向=单测 mock store 上 NoPersist 调用 reserve 次数=0；运行时 SQL 计数（可选 tracing）delta 批取号=0。 |

#### T-L1-B · 工具输出预算默认值 + 事件层截断 + Arc（D-H）

| 项 | 内容 |
| -- | -- |
| 路径收敛 | 输出表示路径：多源散落 → 1 预算常量 |
| 做什么 | ① `ToolBatchOptions.output_budget_bytes` 默认改为 Some(预算常量)；② 生产 `run_launch` 不覆盖 None；③ 超限截断 + `truncated: true` 贯穿 tool-end / 消息块；④ ToolEnd.output / 大 text 字段 `Arc` 化（与 04-T1/C2 同票）；⑤ 前端 store 写入 hardCap 接同一常量（`streamCallbacksEvents` / ToolCallOutput 写入路径）。 |
| 删什么 | 「默认 None」路径；执行→事件→消息链上非 Arc 的重复深 clone 点（保留语义等价测试）。 |
| 依赖 | T-L0-A（常量源）。 |
| 唯一文件域 | `crates/session-loop/src/tool_events.rs`、`loop/handlers/executing_tools.rs`、`crates/agent-tools/src/output*.rs`（若在域内）、`apps/crish-desktop/src/api/**/streamCallbacksEvents.ts`、`components/**/ToolCallOutput*`（写入 cap）。 |
| 验收 | 功能：shell/FS 大输出仍展示（截断标记 UI）；diff 解析在预算内路径。负产出：默认 None 消失；1MB 输出峰值断言（V 级）。五端：触发=大 read_file/shell；传输=tool-end 体积≤预算+overhead；介质=events 表 payload 有界；消费=卡片显示 truncated；负出=store output.length≤CAP 单测。 |

#### T-L1-C · 审计通道有界化（D-J / 交叉 04-O1、09-A1）

| 项 | 内容 |
| -- | -- |
| 路径收敛 | 无界→有界（1→1） |
| 做什么 | 审计 worker mpsc 改有界；满时按「丢弃计数 + 日志」策略（对齐 EventBuffer Soft/Critical 哲学，禁止无限涨）；与 EventBuffer Critical 硬上限（09-B1）同一验收场景。 |
| 删什么 | `unbounded_channel` 使用点。 |
| 依赖 | 无（可与 A/B 并行）。 |
| 唯一文件域 | 审计 worker 相关 `src-tauri` / `session-loop` 文件（以 04-O1 定位为准）；EventBuffer 硬上限若同 PR 则并入 `engine_channels/src/buffer.rs`。 |
| 验收 | 功能：审计落库失败可感知；压测 20 万条不 OOM。负出：无界通道 0 命中。五端：触发=长 run；传输=n/a；介质=审计表行数有上界策略；消费=stats 丢弃计数；负出=单测溢出策略。 |

---

### Layer-2

#### T-L2-A · 组提交真接线 + 取号单语句 + 读路径完备（D-B）

| 项 | 内容 |
| -- | -- |
| 路径收敛 | 写路径 2→1；纯读旁路 N→ ReaderPool 优先 |
| 做什么 | ① 提供同步外观 `blocking_db_call` 内部改道 `writer`（对外 async API 可保持）；② 迁移优先序：`append_event`+`reserve_sequence` → `update_run_status`/`save_run_usage`/`touch_session` → `upsert_session_entry` → 其余域写；③ `reserve_sequence` 单语句 `UPDATE … RETURNING`（核 rusqlite/SQLite 版本；不支持则单事务）；④ 读：`events/runs/blocks/usage` 纯读改 `self.read()`；⑤ open 时主+写连接统一 `foreign_keys=ON`、补 `cache_size`（预算源）；⑥ CAS GC 出主锁短临界区。 |
| 删什么 | 与组提交并行的生产直写分支（DEL-1）；`reserve` 三语句（DEL-13）；busy_timeout 双设（低危顺带）。 |
| 依赖 | T-L1-A（批内无 NoPersist）；T-L1-B（批内 payload 已有界）。 |
| 唯一文件域 | `crates/conex-db/**`（lib/events/messages/sessions/runs/blocks/cas_gc/reader_pool/schema 迁移）；调用方**仅**签名不变的机械适配（`orchestrator/persist.rs` 若需改 blocking 桥接，单独列出不与 UI 混域）。 |
| 验收 | 功能：恢复/导入/e2e 往返；`tests_concurrency` 组提交用例扩域方法冒烟。负出：生产 `self.conn.lock()` **写**命中=0（脚本 AST/正则）；`db.write` 生产命中>0；SQL 计数 1 事务内 N INSERT。五端：触发=长 run 收口+并行会话 save；传输=n/a；介质=WAL 组提交 stats.max_batch≥2；消费=读路径不持主 Mutex 抽检；负出=旁路 grep + FK 审计；运行时=05-V2/V3/V6 场景。 |

#### T-L2-B · save_session_body 增量 UPSERT + CAS 真消费（D-C-DB）

| 项 | 内容 |
| -- | -- |
| 路径收敛 | 全量重写路径 1→增量形态 1（全量模式降为**显式** rebase API，不走 debounce 热路径） |
| 做什么 | ① DB：按 `message.id`/`seq` UPSERT；消失 id DELETE（可按 seq 前缀）；② 批末单次重算 `message_count`（或读时计算）；③ 触发器迁移 DROP（DEL-3）；④ `batch_version` 进 `session_commands::save_session_body` 签名，CAS 失败返回可识别错误（前端 `sessionRustDbWriteGuard` 已有版本号——接上）；⑤ 写走组提交（依赖 T-L2-A）。 |
| 删什么 | 先删后插（DEL-2）；双触发器（DEL-3）；静默丢弃 batch_version（DEL-8）。 |
| 依赖 | T-L2-A。 |
| 唯一文件域 | `crates/conex-db/src/messages.rs`、`schema.rs`/`migrate_steps.rs`（DROP 触发器迁移）、`apps/agent-workbench/src-tauri/src/session_commands.rs`。**不碰**前端 dirty（下一 Layer）。 |
| 验收 | 功能：崩溃恢复/清空会话僵尸复活防护回归；CAS 过期拒绝。负出：DELETE 全表路径 0；触发器 0；含未变更消息的全量重写测试空。五端：触发=工具密集 run 350ms 批；传输=body IPC 仅 dirty（Layer-3 后）；介质=session_messages 增量行；消费=list_sessions.message_count 正确；负出=SQL 语句计数 bench；运行时=V-B2「增量 save <20% 全量耗时」。 |

---

### Layer-3

#### T-L3-A · 前端 dirty 集合 + persist partialize 切除 + 旧键物理删除（D-C-FE）

| 项 | 内容 |
| -- | -- |
| 路径收敛 | LS body 镜像 1→0；SQLite 写入源 1（dirty） |
| 做什么 | ① `sessionStore` partialize **删除** `sessions`（DEL-5）；仅保留 `activeSessionId`/`folderOrder`/`composerDrafts`（或 drafts 另评估）；② boot 一次 migration：读旧 LS sessions → 已有 Rust hydrate 覆盖 → **删除** `crish_session_store` 内 sessions 字段/旧镜像键 → **删除读代码**；③ `persistAllSessionsRust`：与上一批 dirty 快照引用比较，仅 dirty 进 `bodyJobs`（DEL-7/15）；④ 去掉「命令缺失回退 LS 全量 body」的降级轨，或给删除日期并改「仅索引元数据」。 |
| 删什么 | partialize sessions（DEL-5）；全量重发循环（DEL-7）；每次全量 normalize（DEL-15）；无日期的 LS body fallback。 |
| 依赖 | T-L2-B（增量 save + CAS）。 |
| 唯一文件域 | `apps/crish-desktop/src/store/sessionStore.ts`、`store/layout-helpers/store-persistence.ts`、`api/session-persistence/sessionRustDbHydrate.ts`、`sessionRustDbWriteGuard.ts`、迁移脚本。 |
| 验收 | 功能：刷新后会话/消息完整（来自 SQLite）；draft 不丢。负出：`sessions` 在 partialize 0 命中；对旧键读 0；dirty 外 saveSessionBody 调用 0（单测 mock 计数）。五端：触发=set 单会话消息；传输=仅 dirty invoke；介质=LS 无 messages 大键；消费=UI 全量来自 hydrate；负出=`check-store-islands` 脚本 + 行为级「改 A 不触发 B 的 save」。 |

#### T-L3-B · 会话索引单源（D-F）

| 项 | 内容 |
| -- | -- |
| 路径收敛 | 2→1 |
| 做什么 | ① 侧栏/列表唯一真相 = SQLite `list_sessions` / 索引表；② 删除「localStorage 优先、SQLite 回退」读序；③ `lsSaveSessionIndex` 删除或改为只读调试导出（不进 boot）；④ 07-D3 双水合轨合并为单引擎拉取。 |
| 删什么 | LS 索引优先分支（DEL-6）；双水合中的重复拉取。 |
| 依赖 | T-L3-A（persist 单轨后索引不再需要 LS 写回）。 |
| 唯一文件域 | `sessionRustDbHydrate.ts` 索引段、session index 模块、boot 水合调用点。 |
| 验收 | 功能：侧栏排序/文件夹序正确。负出：LS 索引键 boot 读 0。五端：触发=启动+改标题；传输=list_sessions；介质=sessions 表；消费=SessionRow；负出=双源读序 0 命中。 |

---

### Layer-4

#### T-L4-A · 数据面单 parse + 轮询单源（D-E）

| 项 | 内容 |
| -- | -- |
| 路径收敛 | 数据面 parse 2→1；bg 任务轮询源 2→1 |
| 做什么 | ① `EventRouter.onMsg`：`resolveEventType` 后立即 `isDataPlaneEventType` 短路，**禁止**进入 `parseBridgeEvent`（DEL-10）；② `resolveEventType` 结果随对象复用（fanout 传 `{type, raw}`）；③ `useBackgroundTaskPolling` 删除或改订阅 `engineStore.bgTasks`（链 A 已有 hidden 跳过）；④ 轮询 tick in-flight 互斥；错误 kind 不重试；⑤ 水合 AbortSignal + 每页投影后丢事件（CNV-7）。 |
| 删什么 | 先 parse 后丢弃（DEL-10）；双轮询死路径；无 kind 的全量重试。 |
| 依赖 | 无强依赖；建议在 T-L2-* 稳定后合入，避免与 DB 改动同轮冲突。 |
| 唯一文件域 | `apps/crish-desktop/src/api/chat-bridge/EventRouter.ts`、`dataPlaneRouter.ts`、`tauriTransport.ts`、`hooks/useBackgroundTaskPolling.ts`、`sessionEventHydrate.ts`。 |
| 验收 | 功能：task/timer/cron 仍由 dataPlane 消费；run 事件不丢。负出：数据面事件进入 EventRouter parseBridge 次数=0（探针）；轮询次数减半。五端：触发=后台任务输出+run 活跃；传输=单 parse 探针；介质=n/a；消费=task store；负出=`parseBridgeEvent` 计数单测。 |

#### T-L4-B · 旁路 meta-only（D-I / 交叉 15）

| 项 | 内容 |
| -- | -- |
| 路径收敛 | 每事件旁路全量 parse 1→0 |
| 做什么 | ① `emit_payload` 信封构造时同步产出 `EventMeta { type, sessionId, sequence, backpressure }`（或扁平前缀一次扫描）；② fanout `parse_event_meta` 改为消费 EventMeta（DEL-11）；③ `PushAwareEmitter::on_event` 同构（15-PSHP03）；④ 多端 XOV 交叉：fanout+push 共用 meta，禁止各全量 `AgentEvent` parse。 |
| 删什么 | `from_value(value.clone())` 与全量 AgentEvent 二次 parse 热路径。 |
| 依赖 | 可与 L4-A 并行（不同文件域）。 |
| 唯一文件域 | `src-tauri/src/server/fanout.rs`、`push/pusher.rs`、`core_event_bridge.rs`（meta 产出点）。 |
| 验收 | 功能：WS/push 背压分级不变。负出：热路径全量 AgentEvent parse 0。五端：触发=多端开启；传输=meta 构造 1 次；介质=n/a；消费=订阅者；负出=解析计数；运行时=V-B1。 |

#### T-L4-C · 实时轨真缓冲（D-D 前置 / 03-R7/R8）

| 项 | 内容 |
| -- | -- |
| 路径收敛 | 伪缓冲→真缓冲（1→1） |
| 做什么 | `BridgeLiveSink::push_live`：入队后**不**无条件 flush；时间窗（预算源）或 Critical 水位触发 flush；窗口最小化时放大 flush 周期（03-R8）。 |
| 删什么 | emit 后立即 flush 的无条件形态。 |
| 依赖 | 与 PE-02 合并实现解耦——**仅调 flush 时机，不合并事件体**（保持逐事件语义，兼容契约）。 |
| 唯一文件域 | `apps/agent-workbench/src-tauri/src/engine_channels.rs`。 |
| 验收 | 功能：末尾 delta 延迟 ≤ 窗+flush；Soft 丢帧语义压测仍过。负出：无条件 `flush()` 调用点减少。五端：触发=高频率流；传输=事件数可暂不减；介质=n/a；消费=前端 batcher 兼容；负出=及时性单测。 |

---

### Layer-5

#### T-L5-A · 消息软驱逐 + 快照记账 + 压力驱逐（D-G）

| 项 | 内容 |
| -- | -- |
| 路径收敛 | 驻留策略 0 路径→1 预算路径 |
| 做什么 | ① 非活跃会话 messages 软驱逐（K=预算源）；激活懒水合（ACT-502 K=5 已有）对称；② MessageSnapshots 预算计入全量副本；③ 内存压力 level 调用驱逐；④ `load_session_body` 分页 API 接入恢复/切换（05-R2）；⑤ history get Arc 化（09-S1）；⑥ EngineHandle.cache_sessions 上限/删除（09-E1）+ 会话删除清理钩子（09-H1 四件套）。 |
| 删什么 | 「只增不减」activate 路径；快照漏计账本；无上限 cache。 |
| 依赖 | T-L3-A/B（单轨恢复语义）。 |
| 唯一文件域 | `sessionActivateHydrate.ts`、`MessageSnapshots.ts`、`entry-core.tsx` 压力钩子、`conex-db/messages.rs` 分页 API、`session-loop` history cache、`EngineHandle`。 |
| 验收 | 功能：切换会话内容完整（懒加载骨架可接受）。负出：已水合会话数≤K；删除会话后四表 len 清理。五端：触发=浏览 N 重会话；传输=分页 body；介质=DB 不变；消费=UI 懒加载；负出=heap 断言；运行时=V-E1/V-B3。 |

#### T-L5-B · 会话级 HashMap 删除钩子（09-H1）与 L1/L2 驻留

| 项 | 内容 |
| -- | -- |
| 做什么 | 会话删除/关闭钩子清理 09-H1 四件套与 cache；LoopState.events 生命周期已有 run 对齐（正面）保持；thought_blocks 按 block 边界合并驻留（09-L2，与 04-S2 同实现，**不**做 token 合并 emit）。 |
| 删什么 | 无 delete 的 map 增长路径；逐 delta thought 独立成块（合并为块边界）。 |
| 依赖 | 可与 L5-A 并行（不同文件）。 |
| 唯一文件域 | `session-loop` state/history、壳 `EngineHandle`、删除会话 IPC 钩子。 |
| 验收 | 功能：删会话后引擎 map 无悬挂。负出：无钩子 map 数=0。 |

---

### Layer-6 · 强契约（评审通过前禁止实现）

#### T-L6-A · 双发消除终态（03-R2 / DP-INV-1）

- 契约：engine-events；schemaVersion + 生成 parser + registry_drift。
- 方案空间：① 收口 webview 仅 sequence 回执；② 实时轨预取 sequence，收口 webview 免发——**旁路 fanout/push 完整事件改从 store/内存读取，禁止二次 IPC 全文**。
- 删什么：收口非 delta 全文再投递（DEL-9）。
- 依赖：L2 写路径稳定、L4 消费面稳定。
- 验收：普通 run 非增量 IPC 遍数=1；旁路转发仍完整。

#### T-L6-B · message-start 瘦身（03-C1）

- 载荷降 `{sessionId, messageId, role, turnIndex}`；前端空实现删除对全文的容忍解析。
- 依赖：T-L6-A 同批或紧后。

#### T-L6-C · PE-02 裁决票（03-R1 前置）

- 提交「同 messageId+block 追加合并保持顺序」修订案；若通过，接线 L1-C 预留的合并窗常量；若否决，记录否决理由并只保留 L4-C 真缓冲收益。
- **禁止**未裁决先实现。

#### T-L6-D · Progress 实时化或停止构造（10-T3）

- 用户裁决；禁止静默砍。数据面只关心：ToolStart/End 实时桥是否改批收口（与 T-L2 事件路径交叉）。

---

### Layer-7

#### T-L7-A · 防御脚本与运行时回填

| 项 | 内容 |
| -- | -- |
| 做什么 | ① `check-store-islands`：禁写已删 LS 岛；② `check-async-commands` 扩展（若与阻塞面维重叠，数据面只提需求不实现）；③ parse-once / NoPersist SQL / 组提交 stats 探针进集成测试；④ 03-V/05-V/08-V 经 **4000 Tauri MCP** 生产包回填写回各报告 §V。 |
| 验收 | 门禁进 `check:desktop` 或 ci 对应 job；V 项状态从「待测」更新。 |

---

## 5. 与 90 发现 ID 映射

| 本计划任务 | 90 簇 | 90 阶段建议 | 发现 ID |
| -- | -- | -- | -- |
| T-L0-A/B | C16 | 阶段 1/6 | 门禁前提；§3.2 未接线清单 |
| T-L1-A | C1/C4 | 阶段 2 | 03-R3、05-W3 |
| T-L1-B | C6 | 阶段 1/2 | 03-R6、10-T4、04-T1、08-H3、13-G8 交叉 |
| T-L1-C | C8 | 阶段 2 | 04-O1/O2、09-A1/A2/B1、16-P3 |
| T-L2-A | C4/C16 | 阶段 1/5 | 05-S1/S2/S3、05-W2/W5、05-R1、05-Q1、05-G2、03-R4 |
| T-L2-B | C4 | 阶段 5 | 03-I1、05-W1、05-W7 交叉 |
| T-L3-A | C4/C5 | 阶段 1/3 | 08-H1/H4、01-M9、07-D4 交叉 |
| T-L3-B | C15 | 阶段 5 | 07-D2/D3 |
| T-L4-A | C1 | 阶段 3 | 03-V1/V2/V3/V4 |
| T-L4-B | C1 | 阶段 2 | 03-R5、15-FAN01/PSHP03/XOV01 |
| T-L4-C | C1 | 阶段 2 | 03-R7/R8 |
| T-L5-A | C5 | 阶段 1/5 | 08-H2/H5/H6、05-R2、09-S1、03-V4 |
| T-L5-B | C5/C8 | 阶段 2 | 09-H1/L1/L2 |
| T-L6-A/B/C/D | 阶段 4 | 强契约 | 03-R1/R2/C1、10-T3 |
| T-L7-A | C16 | 阶段 6 | 16-P*、全部 V |

**§3.2 未接线清单在本计划中的处置**：

| 设施 | 处置 |
| -- | -- |
| 组提交 | T-L2-A 接线（主票） |
| G8 tool_output | 并入 T-L1-B |
| Progress | T-L6-D 裁决 |
| ReaderPool 完备 | T-L2-A 读路径 |
| moka 预算 | **不在本计划主路径**（渲染维）；事件预算以 T-L0-A 为准 |
| send_pending_batch / cleanup_logs | 多设备维；本计划只通过 T-L4-B 降低 push 解析税 |
| message-start 全文 | T-L6-B |
| 增量高亮死代码等 | 前端渲染维，不展开 |

---

## 6. 与 91 草稿的分歧与理由

| # | 91 取舍 | 本计划取舍 | 理由 |
| -- | -- | --- | -- |
| 1 | Layer 0 预算 SSOT 为**绝对首位**且与阻塞面/引擎并行首轮 | 预算 SSOT 仍要，但**数据面主路径**把 NoPersist→组提交→增量 save 排在组提交前的「减载」；不把预算当作接线前提的唯一闸 | 组提交接线不依赖新预算模块即可正确；NoPersist 重排序零依赖、收益立即；预算可并行，不阻塞写路径 |
| 2 | 05-S1 组提交与引擎 Arc、moka、compaction 同在 L2 大包 | **写路径单轨（L2）严格先于前端 persist 切除（L3）**，且 NoPersist 必须在组提交**之前** | 91 将 NoPersist 与组提交同单元易造成「事务包白付取号」；逻辑上先减载再换轨 |
| 3 | 增量 save 与前端 dirty 在 91 分处 W3.2/W3.3 但依赖关系松 | **强制 DB 增量+CAS（L2-B）先于前端 dirty（L3-A）**，并同票要求删除无日期 LS fallback | 前端 dirty 若先做，Rust 仍全量 DELETE+INSERT，尖峰仍在；无删除日期的「invoke 缺失回退全量 LS」是典型兼容岛，91 未强调删除 |
| 4 | 会话索引双源放在阶段 5（资产/深水之后） | 索引单源与 persist 切除**同 Layer**（L3） | 索引 LS 优先是持久化双轨的一部分，不是启动资产问题；拆开会留下「body 单源、索引双源」的半收敛 |
| 5 | 双发/message-start/PE-02 全部押后 Layer 8 | 同意押后**实现**，但 L4 仍做「真缓冲 / meta-only / 单 parse」；并**强制开 PE-02 裁决票**（T-L6-C），禁止以「契约禁止」关闭议题 | 91 表述接近「解锁前只能旁路减解析」；本计划要求裁决票有产出（通过/否决+记录），避免 token 放大根因无限期悬置 |
| 6 | U-EVENT 收口 clone 与组提交可同 PR | 收口三连克隆（04-S1）与 thought 块合并归入 L5-B/引擎侧，**不**与组提交同文件域 | 降低并行冲突；事件模型 clone 与 DB 写轨变更正交 |
| 7 | 91 未把「无日期 LS 降级轨」列为必删 | DEL 明确要求删除或给删除日期 | AGENTS §8.4；本计划数据面存在 `persistAllSessionsLocalFallback` 类路径，必须处理 |
| 8 | 91 Layer 顺序中传输在持久化之前有时可并行 | 本计划 L4 传输在 L2/L3 后（文件域允许早合入 L4-A 的纯前端单 parse） | 单 parse 不依赖 DB；但双发消除必须在写路径稳定后——91 也如此，本计划把「可早」与「必须晚」拆开写清 |
| 9 | 阻塞面 spawn_blocking 在 91 为 L1 大项 | **不在本计划实现**；与 10-T4 交叉的仅输出预算 | 主视角数据面；避免与阻塞维文件域冲突；交叉处以发现 ID 移交 |
| 10 | 91 首轮 8 单元并行 | 本计划首轮逻辑上 L0-A∥L1-A∥L1-B∥L1-C；L2 起收敛串行写路径 | 删除/收敛类任务 v3 要求串行；写路径单轨不能三个 Agent 同时改 `conex-db` |

---

## 7. 诚实边界（未读代码处 · 待核实）

以下条目在本次走读中**未**逐行核实，标注「待核实」；实现前必须由执行 Agent 读码确认，禁止当已验证事实：

1. **rusqlite / 系统 SQLite 是否支持 `UPDATE … RETURNING`**（T-L2-A 取号单语句）——待核实版本与 Windows 构建矩阵。  
2. **`persistAllSessionsLocalFallback` 的全部调用点与产品语义**（是否仍有真实 invoke 缺失场景）——待核实；若存在合法离线场景，删除需改为「元数据-only 降级 + 删除日期」。  
3. **`composerDrafts` 是否应留在 persist**——本计划倾向保留（小对象）；与 08-M5 删除悬挂的交叉待实现时裁决。  
4. **EventBuffer 与审计通道是否应共享同一有界策略实现**——本计划建议策略对齐但通道分离；是否合并代码待定。  
5. **`save_session_agents` 热路径频率**（05-W7）——静态显示低频；若前端每 350ms 仍全量 agents，则需并入 dirty 集合——**待核实调用频次**。  
6. **seed_sequences 对「NoPersist 不再占号」后的空洞语义**——报告称 MAX+1 不受影响；失败重试 Q25 路径细节待实现时用现有测试锚点复核。  
7. **fanout/push 装配是否默认关闭**——03 称 fanout 槽 None 时零开销；T-L4-B 收益在「多端开启」场景，验收需显式打开装配（待核实装配开关路径）。  
8. **03-I2 boot 水合已修（ACT-502）**——以 07/90 §6 为准；本计划不重复开票，但 L3-B 索引单源可能影响 hydrate 顺序——实现时回归。  
9. **审计通道具体文件路径**（04-O1 引用的 run_core）未在本轮展开定位——待核实精确入口。  
10. **组提交 SAVEPOINT 与 UPSERT 增量事务的嵌套语义**——group_commit 已有 SAVEPOINT 隔离（05-P8）；增量 save 作为单 write 闭包时的事务边界待设计确认。

---

## 8. 文件域总表（防并行冲突）

| 单元 | 主要文件域 |
| -- | -- |
| U-BUDGET-DATA | `conex-shared/perf_budget`、`perfBudgets.ts`、`check-perf-budgets.mjs` |
| U-NOPERSIST | `crates/orchestrator/src/events.rs`（push 控制流） |
| U-OUT-BUDGET | `tool_events.rs`、`executing_tools.rs`、agent-tools output、前端 ToolCallOutput 写入 |
| U-AUDIT-BOUNDED | 审计 worker 通道、`engine_channels/buffer.rs`（硬上限） |
| U-DB-GROUP | `crates/conex-db/**` 写路径与 ReaderPool |
| U-DB-BODY | `messages.rs`、`session_commands.rs`、schema 触发器迁移 |
| U-FE-PERSIST | `sessionStore.ts`、`store-persistence.ts`、`sessionRustDbHydrate.ts`、WriteGuard |
| U-FE-INDEX | 索引/水合读序 |
| U-XPORT | `EventRouter.ts`、`dataPlaneRouter.ts`、`tauriTransport.ts`、bg polling |
| U-BYPASS | `fanout.rs`、`pusher.rs`、`core_event_bridge.rs` |
| U-LIVE-BUF | `engine_channels.rs`（BridgeLiveSink） |
| U-EVICT | hydrate/snapshots/pressure、messages 分页、history cache、EngineHandle |
| U-CONTRACT | engine-events、registry_drift、PE-02 票 |
| U-GUARD | check-* 与集成探针 |

跨单元只允许只读依赖；写路径收敛单元（U-DB-*）**同时只允许一个主责 Agent**。

---

## 9. 逻辑里程碑（非工期）

| 里程碑 | 完成定义 |
| -- | -- |
| M-DP-0 | 预算源 + 切除登记表 + 脚本骨架 |
| M-DP-1 | NoPersist 0 取号；输出默认预算+Arc；审计有界（INV-2 部分） |
| M-DP-2 | 组提交生产零旁路；取号单语句；ReaderPool 完备；增量 save+CAS（INV-3/8） |
| M-DP-3 | partialize 无 sessions；dirty 只发变更；索引单源（INV-4） |
| M-DP-4 | 数据面 parse×1；旁路 meta-only；实时轨真缓冲（INV-5） |
| M-DP-5 | 驱逐+分页+删除钩子（INV-7） |
| M-DP-6 | 双发消除+start 瘦身+PE-02 裁决落地（INV-1） |
| M-DP-7 | 门禁接 CI；V 项 MCP 回填 |

每里程碑交付必须携带：功能回归 + 负产出行数/路径数 + 五端物证清单；禁止「模块自测绿」单独充当完成。

---

## 10. 一句话方案哲学

**数据面只有一条真相轨：事件少付一次、写库少锁一次、前端少存一份；凡与唯一轨并行的旧路径，先减载、再换轨、后拆除——删除是收敛的完成形态，不是范围缩水。**

---

_本文件为独立总案（independent-01）。执行轮以主控定稿 92 + 分维详案为准；本文件提供数据面删除面与依赖序的独立交叉验证输入。未 git commit。_
