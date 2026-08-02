# B1 Rust 核心代码质量评审

- 评审范围：`crates/` + `apps/agent-workbench/src-tauri/`（Rust 侧约 7.3 万行）
- 评审方式：只读抽查 6 条路径，每条读关键函数全文 100-200 行，按正确性 / 错误处理 / 清晰度 / 可测试性 4 维度评估
- 基准 commit：`84d80f16`
- 评审日期：2026-08-02

---

## 0. 总体结论

**评级：良（偏优）**

理由：

1. **状态机是本项目最强的部分**。`conex-types/transition.rs` 以表驱动穷举 33 条已定义转移、`session-loop/state.rs` 用 8 态 × 20 事件全对穷举测试锚定（`every_state_event_pair_is_defined_or_explicitly_undefined`），且「先查表后变更」保证失败时不改状态与上下文。这套正确性保障在抽查路径中未见同类疏漏。
2. **错误体系贯通**。CrishError 77 码 + category/retryable/action + cause 链（深度 8 截断）在 loop、orchestrator、db、provider 各层一致传播；恢复钩子按码分类裁决而非文本匹配（F6/T06.5.3）；`CoreError → 77 码` 显式映射收敛为单一真源。
3. **并发与竞速语义处理用心且一致**。abort 优先的 `tokio::select! { biased; }` 在流消费（streaming.rs）、SSE 读取（reader.rs）、工具超时（tool_exec.rs）三处语义对齐；sequence 取号下沉到 store 端 + UNIQUE(session_id, sequence) 构成 TOCTOU 守卫；工具批处理并行组内事件顺序契约有测试锚定。
4. **测试密度高**：108 个测试文件、约 1175 个测试用例，含并发 stress、crash 一致性、迁移 e2e、真实本地 TCP 的 SSE 全链路测试；生产路径（非测试）基本无 unwrap 残留。
5. **扣分项集中在「语义-文档不一致」而非「机制缺失」**：恢复缺省决策与注释矛盾（P1）、未知 run 状态静默映射 Failed（P2）、迁移 `unreachable!` 与备份命名误导（P2）。均为可修复的小问题，不构成架构性风险。

---

## 1. 会话状态机与主循环

### 1.1 主循环 run / converge / recovery

文件：`crates/session-loop/src/loop/mod.rs`

| 维度 | 评价 |
|---|---|
| 正确性 | run() 每轮重建状态机、恢复计数归零；while(!done) 分派 + catch 兜底（`recovery_decision` → `apply_recovery`）双层结构清晰；done 但未收敛的防御性收口路径存在（mod.rs:383-390） |
| 错误处理 | LoopError 携带结构化 CrishError（mod.rs:53-57），错误码/可重试性跨 catch 兜底保留；abort 信号优先于恢复钩子裁决 |
| 清晰度 | handler 化分派（`dispatch_once` mod.rs:394-427）与状态一一对应，注释标注任务书章节，可溯源 |
| 可测试性 | 构造器默认值、cwd/幂等派生同步、恢复钩子接收结构化错误均有单测（mod.rs:545-634） |

**问题点（P1，语义与注释矛盾）**：

```rust
// mod.rs:439-440 —— 注释声明「缺省：不可恢复内部错误 → error 收场」
// 缺省：不可恢复内部错误 → error 收场（经 apply_recovery 的 Fatal 分支）
RecoveryDecision::Skip
```

但 `apply_recovery` 的 Skip 分支（mod.rs:477-486）在 `S::Streaming` 状态下走 `dispatch(E::NoToolCalls)` **正常收场该轮**，而非 error 收场。即：**无恢复钩子注入时，streaming 状态下的内部错误（如状态机不一致的防御性错误）会被静默降级为「正常无工具轮次」收场**（endReason=stop）。错误仍有 `tracing::error` + RuntimeError 事件可观测，但收场语义与注释及 RecoveryHook trait 文档（mod.rs:115「否则 error 收场」）不符。建议：缺省 Skip 在非 streaming 状态确实 error 收场，但 streaming 分支应复核——要么改注释，要么让缺省路径返回 error 收场。

### 1.2 状态机内核

文件：`crates/session-loop/src/state.rs` + `crates/conex-types/src/transition.rs`

| 维度 | 评价 |
|---|---|
| 正确性 | `dispatch` 先 `apply_transition` 查表、失败则状态与上下文均不变（state.rs:57-61）；endReason patch 与 effect 分离（state.rs:64-87）；error 收场仅由 §1.6 四事件产生有专门测试（state.rs:549-574） |
| 清晰度 | 转移表 8 状态 × 20 事件以 match 穷举，未定义组合落入 `Undefined { state, event }` 显式错误，不静默忽略（transition.rs:89-201） |
| 可测试性 | 33 条已定义转移逐行断言 + 全 160 对穷举 + effect 专项（turn_index 递增/计数归零/失败不改上下文），测试质量高 |

**观察点**：`TransitionError::Terminal` 与 `Undefined` 双变体设计正确；turn-complete 无 ERROR 转移（经 recovery 映射 FINISH）在表尾注与测试双重锚定。

### 1.3 流式消费（双轨 / DeltaSink）

文件：`crates/session-loop/src/loop/handlers/streaming.rs`

| 维度 | 评价 |
|---|---|
| 正确性 | abort 竞速三处读取（流内 biased select、流后复查、consume 后复查，streaming.rs:69-140）覆盖「流结束瞬间 abort」窗口；流前 Err 重试 / 流中 Err 内容保留不重试契约明确（streaming.rs:56-57） |
| 错误处理 | 分类错误进 retry 阶梯（stream_error::handle），abort 走 `streaming_aborted` 统一收场路径（streaming.rs:215-246），cooperative_stop 不 abort（D1） |
| 清晰度 | 双轨职责分离清晰：实时轨只承载 text/thought delta（`delta_to_message_event` streaming.rs:359-380），收口轨保证 start→delta*→end 完整序列（`commit_message_with_deltas` streaming.rs:344-353），注释明确「事件桥不再重发 delta 避免双发」 |
| 可测试性 | `crates/session-loop/tests/streaming_incremental_contract.rs` 覆盖首帧时间、abort 竞速、实时轨只收 delta 等契约 |

**观察点**：`build_assistant_message` 中 thought 块透传 metadata（streaming.rs:300-312）对 null/缺失字段逐个 Option 守卫，防御良好；`new_message_id` 预生成 id 使 delta 与收口消息对齐（streaming.rs:52），是 T09.1 双轨的关键设计。

---

## 2. 事件与 sequence

文件：`crates/orchestrator/src/events.rs`

| 维度 | 评价 |
|---|---|
| 正确性 | delta 不落库不阻塞（`event_class` events.rs:43-49）；持久化事件同步等待落库；run-terminal 唯一终态事件，`terminal_sent() || is_terminal()` 防重（events.rs:319-321）；Q25 失败序列号复用不留空洞（events.rs:364-371） |
| 错误处理 | PersistError 携带 sequence + event_type + StoreError（events.rs:74-88）；持久化失败 run 标记 failed(event-store-write-failed) 不假装可回放；失败路径带类型化错误码日志 |
| 清晰度 | `drive_outcome` 三段式流程（分流推送 → 失败翻转 → 正常收口）注释充分；`push_terminal_best_effort` / `push_at_best_effort` 与 `push` 职责区分清楚 |
| 可测试性 | 单测覆盖慢 store 等待、delta 不阻塞（120 delta × 40ms 场景）、并发双 run 各 50 号唯一连续、终态唯一、max-turns → failed、失败序列复用（events.rs:605-1089） |

**问题点（P3）**：`reserve` 失败时本地镜像 `last_reserved += 1`（events.rs:143-147），而 store 端计数器未自增；若此后 store 恢复，下一次 `reserve` 从 store 取号会与本地镜像偏离（store 返回已被本地镜像跳过的号）。当前由 Q25 复用逻辑与测试覆盖兜底，风险可控，但建议注释注明「取号失败 → 计数器未消费」的语义。

---

## 3. 数据持久化

### 3.1 迁移框架

文件：`crates/conex-db/src/migrate.rs`

| 维度 | 评价 |
|---|---|
| 正确性 | `PRAGMA user_version` 权威源，逐版本独立事务（migrate.rs:107-133）；全新库建 v1 后走完整链（fresh_db_full_chain 测试锚定）；v3→v4 孤儿行计数写入 session_meta 可观测 + 过滤后重建组合主键（migrate.rs:220-321） |
| 错误处理 | 迁移失败 set_failure latch 后返回 DbFailure::Migration；失败不 commit |
| 清晰度 | v1→v2 用 ADD COLUMN 避免 RENAME+DROP 触发 CASCADE 清数据（migrate.rs:159-160），v3/v4 的重建模式统一为「RENAME → CREATE → INSERT…WHERE session_id IN (SELECT id FROM sessions) → DROP」，结构一致 |
| 可测试性 | `tests/migrations.rs` + `tests/upgrade_e2e.rs` + `tests/orphan_grace_contract.rs` 覆盖链式迁移与孤儿处理 |

**问题点（P2）**：
- migrate.rs:115 `_ => unreachable!()`：版本循环内 match 无兜底，未来新增 v5 会 panic 而非优雅报错。建议改为显式 `DbFailure`。
- migrate.rs:21-53 `backup_before_drop`：备份失败仅 `eprintln!`、删旧备份 `let _ =` 静默吞错，未走 tracing/CrishError 体系；且实际备份时机在「迁移 commit 后」而非 DROP 前（`.bak-v3` 恰是 v4 DROP 前的最后快照，命名有误导但语义可用）。

### 3.2 事件追加 / 查询 / 取号

文件：`crates/conex-db/src/events.rs`

| 维度 | 评价 |
|---|---|
| 正确性 | `append_event` 单语句 INSERT 配合 UNIQUE(session_id, sequence)；`query_events` 带 limit 修复无界查询（events.rs:31-32）；`reserve_sequence` 首次按 max(sequence)+1 隐式预热（events.rs:78-83） |
| 错误处理 | 全程 Result + latch_error（含 prepare/map/collect 分点标注操作名）；锁中毒转 DbFailureKind::Lock |
| 清晰度 | 读-改-写三段式取号有注释说明依赖单连接互斥（events.rs:84） |
| 可测试性 | `tests/stress_write.rs`、`tests.rs` 并发线程取号测试锚定 |

**观察点（P3）**：`reserve_sequence` 的「INSERT OR IGNORE → SELECT → UPDATE」依赖进程内 `Mutex<Connection>` 串行化；注释「读 + 写 等效单语句原子性」的表述有夸大——它是**锁提供的原子性**而非 SQL 原子性。当前 Tauri 单进程架构下成立，但若未来出现多进程访问同一 DB（如 daemon 化），该假设会失效，建议注释明确此前提。

### 3.3 run 生命周期

文件：`crates/conex-db/src/runs.rs`

**问题点（P2，状态兜底语义错误）**：

```rust
// runs.rs:267-269 —— 注释写「按 Unknown 兜底」，但枚举没有 Unknown 变体
fn map_run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRun> {
    let status_str: String = row.get(2)?;
    let status = RunStatus::from_str(&status_str).unwrap_or(RunStatus::Failed);
```

未知/损坏的状态字面量会被**静默误标为 failed**——UI 会把无法解析的 run 显示为失败，且无从分辨。建议：新增 `Unknown` 变体保留原文，或让 `map_run_row` 返回错误（restore 层可感知）。

**正面**：`update_run_status` 用 `COALESCE(?3, end_reason)` / `COALESCE(?4, cursor)` 保留旧值语义（runs.rs:147-148）；`now_millis` 有 `unwrap_or_default` 兜底（runs.rs:282-287）。

---

## 4. 权限与工具执行

### 4.1 批处理执行器

文件：`crates/session-loop/src/tool_exec.rs`

| 维度 | 评价 |
|---|---|
| 正确性 | 并行组 + 顺序项混排调度（并行组先发、顺序项依次，tool_exec.rs:126-141）；cancel-siblings 覆盖混排场景（mark_rest_cancelled 按 `results[i].is_none()` 判定，tool_exec.rs:836-869）；审批事件先于挂起发出防死锁（tool_exec.rs:432-440）；T09.6 审批模式恢复并行（先逐个审批、通过后 join_all 并行） |
| 错误处理 | 未知工具/非法入参/超时/abort 全走分类结果不 panic；abort-aware 竞速：`tokio::select! { biased; }` 使 abort 优先于 timeout（tool_exec.rs:608-615）；执行体 future 随分支丢失被 drop 作为取消语义（注释明确 MCP 远端尽力取消） |
| 清晰度 | 权限三态（Allow/Deny/NeedsApproval）× 审批开关的 `should_execute` 判定矩阵注释充分（tool_exec.rs:228-237） |
| 可测试性 | 单测覆盖并行耗时、超时、cancel-siblings 致命/非致命、混排取消事件对契约（assert_event_contract 断言每个取消项有 ToolStart→ToolEnd 配对且 id 非空，tool_exec.rs:1145-1180）；另有 benches/tool_batch.rs |

**问题点（P3）**：
- tool_exec.rs:79-97 `with_idempotency` 与 `with_idempotency_opt` 功能重叠（前者是后者 `Some` 的特例），两份构造体重复，建议合并。
- tool_exec.rs:348 防御性兜底 `ClassifiedToolResult::error("", "", …)` 空 id 回退——有 `debug_assert!(results.iter().all(Option::is_some))`（tool_exec.rs:345）锚定测试，生产降级可接受，属文档化防御。
- 嵌套 match（`(&approval, options.approval_enabled)` × `verdict`，tool_exec.rs:421-484）可读性偏重，但注释与分支语义完整，属可接受复杂度。

### 4.2 工具上下文（abort / ask）

文件：`crates/agent-tools/src/context.rs`

| 维度 | 评价 |
|---|---|
| 正确性 | AbortToken 用 `Ordering::SeqCst`（context.rs:37-44），跨线程可见性有保障（注：Acquire/Release 已足够，SeqCst 略保守但不影响正确性）；AskChannel trait 边界 `Send + Sync + Debug`（context.rs:61） |
| 错误处理 | ask 返回 `Result<AskDecision, ToolError>`，工具侧可传播审批失败；未接线时 None 语义由上层裁定（放行/透传） |
| 清晰度 | 文档明确「本层保持轻量、无 tokio 运行时绑定」，std 同步原语实现，依赖面干净（context.rs:20-24） |
| 可测试性 | abort 幂等触发、Clone 共享、NoopAskChannel 放行、mock 上下文工厂均有单测（context.rs:137-170） |

---

## 5. 错误体系

文件：`crates/conex-types/src/error.rs`

| 维度 | 评价 |
|---|---|
| 正确性 | 77 码 × 20 域常量 + `CRISH_ERROR_REGISTRY` 注册表（error.rs:159-582）；`info()` 未知码回退 common.unknown；cause 链递归截断深度 8（error.rs:669-700，payload 携带 truncated 标记）；`to_error_payload` 与 TS serialize.ts 字段一一对应（含 `public` 字段名） |
| 错误处理 | `from_core_error_with_context` 显式选码（删除隐式 From 映射，error.rs:1037-1060）；`core_error_code` 单一真源映射表；ProviderErrorKind 13 类分类与 02 §4.2 逐行对齐（error.rs:756-823） |
| 清晰度 | struct 而非 enum 的理由（77 码不可维护）在文档中明确；registry_drift 测试防 TS/Rust 码表漂移 |
| 可测试性 | 单测覆盖 payload 往返、cause 截断、未知码回退、migrate_error_code 全表 |

**问题点（P3，类型安全弱项）**：错误码为字符串常量而非 enum，typo 无编译期检查；`Lazy<HashMap>` 注册表查表有运行时开销且易漂移。已由 `crates/conex-types/tests/registry_drift.rs` 补偿（可接受，但若未来码表膨胀可考虑 `enum + strum` 双向映射）。

**观察点**：`migrate_error_code`（error.rs:841-925）覆盖 SessionErrorCode / ProviderErrorKind / 自由字符串码 / TOOL_ERROR 拆分 / ErrorDomain 五类来源，是迁移期的正确做法。

---

## 6. provider 流

### 6.1 chat-completions 解析器

文件：`crates/agent-provider/src/parse/chat.rs`

| 维度 | 评价 |
|---|---|
| 正确性 | 帧处理顺序硬编码（错误帧 → usage → delta → 兼容位置 → finish_reason，chat.rs:4-17），与 02 §2.2 逐行对齐；thought 优先级 reasoning_content → thinking → thinking_delta（chat.rs:111-119）；RU-06/08/09 三条恢复规则（缺 name 诊断、强制 tool-call、零捕获诊断）在 finish 时统一执行 |
| 错误处理 | 错误帧立即终止且后续帧空产出（chat.rs:62-64, 74-83）；`terminated` 标志防重复 finish；非 JSON 帧防御性跳过（chat.rs:68-70，依赖分帧层已保证合法性） |
| 清晰度 | `terminated` / `collector` / `usage` / `finish_reason` 状态字段职责单一；finish_reason 映射表以文档注释呈现（chat.rs:229-235） |
| 可测试性 | 测试极密：优先级、空串忽略、legacy function_call、非流式混入、平铺变体、多 choice 取首、usage 覆盖/非有限值拒绝、错误帧变体五连、RU-06/08/09、空流、[DONE] 防御、finish 幂等（chat.rs:314-944） |

### 6.2 传输层与增量流

文件：`crates/agent-provider/src/transport/mod.rs` + `sse/reader.rs`

| 维度 | 评价 |
|---|---|
| 正确性 | `stream_frames` 真增量（首帧到达即产出，transport/mod.rs:64-79）；`read_stream` 双段超时（first-byte / idle）上抛 SseReadError 绝不静默结束（02 §六.2）；abort 竞速 biased 优先（reader.rs:230-246） |
| 错误处理 | 超时/abort/分帧错误以 Err 条目终止流，之后流立即结束（transport/mod.rs:69, 377） |
| 清晰度 | 分帧与 reqwest 完全解耦（ChunkReader trait 适配，transport/mod.rs:21-48），测试可用本地 TCP 全链路 |
| 可测试性 | 真 TCP 服务模拟慢流/挂起/分块延迟，覆盖首字节超时、abort 中断、[DONE] 丢弃、增量产出时序、收集等价回归（transport/mod.rs:189-408） |

---

## 7. 与 TS 同类实现的差异优势清单

| # | 维度 | Rust 侧优势 | 具体证据 |
|---|---|---|---|
| 1 | 状态机 | 表驱动 + 穷举测试，未定义转移显式报错；TS `createAgentSessionMachine` 手写 if/switch 无此保障 | transition.rs:89-201 + state.rs:470-488（8×20 全对穷举） |
| 2 | 所有权/拷贝 | 构建请求用借用 `&[AgentMessage]`；消息 `Arc` 一次共享于对话与事件；收口 `mem::take` O(1) 移交而非深拷贝 | streaming.rs:253-259, 344-353; loop/mod.rs:509-530 |
| 3 | 并发语义 | `tokio::select! { biased; }` 显式 abort 优先，三处（流消费/SSE 读/工具执行）语义一致；TS Promise.race 无偏且易被超时吞掉 | streaming.rs:69-115; reader.rs:230-246; tool_exec.rs:608-615 |
| 4 | 错误体系 | 77 码注册表 + cause 链截断 + thiserror + 显式映射单一真源；恢复钩子按码分类而非文本匹配 | error.rs:159-700; loop/mod.rs:431-441 |
| 5 | 持久化原子性 | SQLite 事务迁移 + store 端原子取号 + UNIQUE(session_id, sequence) TOCTOU 守卫；TS 端手写游标易竞态 | persist.rs:195-198; events.rs(reserve_sequence):72-99 |
| 6 | 类型安全 | `ToolConcurrency` 枚举、`PermissionVerdict` 三态、事件变体内嵌 payload（`HasToolCalls { count }`）；TS 以字符串/对象传递 | transition.rs:132-137; tool_exec.rs:773-785 |
| 7 | 可测试性 | 同进程内存 store 故障注入（fail_next_append / fail_all_appends / append_delay）+ 并发 stress + 崩溃一致性测试；108 文件约 1175 用例 | persist.rs:242-263; tests/stress_concurrent_runs.rs; tests/crash_consistency.rs |
| 8 | 可观测性 | tracing span（run 级）+ 类型化事件双通道，错误码进日志字段 | loop/mod.rs:336-341, 452-465 |

---

## 8. 问题点汇总（按严重度）

| 级别 | 位置 | 问题 | 建议 |
|---|---|---|---|
| P1 | loop/mod.rs:439-440 + 477-486 | 缺省恢复决策 Skip 在 streaming 状态下将内部错误静默降级为正常收场，与注释/文档「缺省 error 收场」矛盾 | 统一语义：缺省路径 streaming 也按 error 收场，或修正文档 |
| P2 | runs.rs:267-269 | 未知 run 状态静默映射 Failed（注释写 Unknown 但无此变体），数据误标 | 新增 Unknown 变体或返回错误 |
| P2 | migrate.rs:115 | 版本循环 `unreachable!()`，未来加 v5 会 panic | 改为显式 DbFailure |
| P2 | migrate.rs:21-53 | 备份失败 eprintln + 删旧备份静默吞错，未走 tracing/CrishError；`.bak-v{n}` 实为迁移后快照，命名与「drop 前」语义不符 | 接 tracing 告警；改名或改注释 |
| P3 | events.rs(reserve):143-147 | 取号失败本地镜像 +1 与 store 计数器可能偏离 | 注释注明语义，或失败时回退镜像 |
| P3 | events.rs:84 | 「读+写等效单语句原子性」表述夸大，实为单连接互斥保证 | 注明单进程前提 |
| P3 | tool_exec.rs:79-97 | with_idempotency / with_idempotency_opt 冗余 | 合并为一个方法 |
| P3 | error.rs:54-156 | 字符串错误码无编译期检查 | 已由 registry_drift 测试补偿；可选 enum+strum |
| P3 | context.rs:37-44 | AbortToken 用 SeqCst 略保守 | 可降为 Acquire/Release（非必须） |

---

## 9. 评审限制说明

- 抽查为「点读」而非全量阅读：6 条路径共约 6000 行关键代码，未覆盖 `orchestrator/restore.rs`、`session-loop/steering/*`、`agent-provider/request/*`、`conex-compaction`、Tauri 侧与 IPC 面。
- 正确性结论基于代码 + 测试锚定，未实际运行测试或 lint（只读评审）。
- 测试用例数（1175）为按 `#[test]` / `#[tokio::test]` 注解统计，含 `#[cfg(test)]` 模块内用例。
