# AA-01 Rust 核心代码质量审查报告

审查日期：2026-08-01
审查范围：crates/session-loop、crates/orchestrator（重点）；crates/agent-tools、crates/agent-provider、crates/conex-types（配合审查）
审查方式：只读静态审查（未运行测试、未改动代码）
语义依据：代码内注释引用的 01-session-loop-semantics.md / 05-test-mapping.md / 03-frontend-contract.md 等设计文档

## 一、总览

| crate | 审查规模（src 行数） | 问题数 | 严重度分布（阻塞/重要/建议） |
|---|---|---|---|
| session-loop | 约 7043 | 16 | 1 / 4 / 11 |
| orchestrator | 约 5624 | 9 | 0 / 4 / 5 |
| agent-tools | 约 6097（重点文件精读） | 9 | 0 / 3 / 6 |
| agent-provider | 约 11694（重点文件精读） | 4 | 0 / 1 / 3 |
| conex-types | 约 3244 | 3 | 0 / 1 / 2 |
| 合计 | 约 33700 | 41 | 1 / 13 / 27 |

说明：session-loop 与 orchestrator 为全文精读；agent-tools / agent-provider 按任务书重点（执行器、幂等、MCP 桥、SSE 分帧、重试器、请求构建）精读，其余文件抽样。agent-provider 的 parse/ 目录（anthropic/gemini/responses/chat 约 3900 行）为解析器，本次仅统计 panic 面，未逐行审查。

## 二、问题清单

| 编号 | 位置 | 严重度 | 问题描述 | 建议修复方向 |
|---|---|---|---|---|
| Q01 | session-loop/src/tool_exec.rs:179-183, 444-478 | 阻塞 | cancel-siblings 在并行组致命时按「组末索引」判定取消范围，夹在并行项之间的顺序项既未执行也未标记取消，回退为空 id 的 Cancelled 结果，且缺失 tool-start/tool-end 事件对（详见三.1） | mark_rest_cancelled 改为按「结果仍为 None 且未执行」判定，不依赖 from_idx 下标裁剪 |
| Q02 | session-loop/src/loop/handlers/mod.rs:86,114,208; streaming.rs:131; loop/mod.rs:282 | 建议 | `LoopState.abort_reason` 只写不读（三处写入、零消费），abort 原因从不进入 EndDecision/RunOutcome/事件 | 删除字段，或在 EndDecision::aborted 中透出 reason |
| Q03 | session-loop/src/loop/mod.rs:124,149 | 重要 | `steering_enabled` 配置项定义并默认 true，但全 crate 无任何读取点——文档承诺「干预性 steering 可配置关闭」从未生效 | 在 prepare_turn / steering_evaluation 入口按该选项短路，或删除字段并改文档 |
| Q04 | session-loop/src/loop/mod.rs:133,153; loop/handlers/prepare_turn.rs:69-71 | 建议 | `compression_hook` 存储但从不调用（prepare_turn 步骤 5 仅为注释），压缩功能为死配置 | 删除或接入真实调用点；payload_recovery 与压缩共用时一并落地 |
| Q05 | session-loop/src/loop/handlers/stream_error.rs:76-85 | 重要 | `payload_recovery` 只递增计数并重试，不执行任何压缩/裁剪——对同一请求（相同 payload、相同 max_tokens）重复重试 2 次必然再次失败，是「假恢复」 | 要么接入压缩钩子（压缩消息/剪图后再重试），要么对 PayloadTooLarge 直接 fatal，删除无效阶梯 |
| Q06 | session-loop/src/safe_point.rs:75-82,129-157,160-162 | 建议 | `ControlAction::end_reason()`、`write_inject_messages()`、`ring_for_kind()` 为 pub 但生产路径零消费（check_control 内联了落环逻辑），仅测试使用 | 标记 #[cfg(test)] 或删除，减少公共面 |
| Q07 | session-loop/src/steering/nudge.rs:235-252 | 建议 | `withdraw` / `withdraw_reason` 仅测试使用，生产路径无调用 | 同 Q06 |
| Q08 | session-loop/src/steering/mod.rs:103-106,271-280 | 建议 | `SteeringAction::EmitDiagnostic` 分支在 apply 中完整实现，但没有任何策略产出该动作——诊断事件在真实运行中永远不会发出 | 由 RecoverySteeringStrategy 在干预前产出（如预算将尽时），或删除死分支 |
| Q09 | session-loop/src/steering/diagnostics.rs:23; lib.rs:58 | 建议 | `SelfTerminationDiagnostic` 仅测试消费（tests/divergence.rs:265），生产零使用（文档注明「字段结构保留」，可接受但应显式标注） | 保留结构但加 #[doc(hidden)] 或移入测试模块 |
| Q10 | session-loop/src/tool_events.rs:189-201 | 建议 | `ClassifiedToolResult::to_tool_output()` 无任何调用点（翻译层用 tool_output_from_result / tool_output_from_parts 内联实现） | 删除或让 executing_tools 复用 |
| Q11 | conex-types/src/session.rs:130,143 | 建议 | `AgentSessionContext.abort_reason` 恒为 None：初始化后无任何写入与读取 | 删除字段（LoopState 自有 abort_reason），或接通写入路径 |
| Q12 | session-loop/src/steering/mod.rs:54,56 | 建议 | `SteeringPhase::BeforeTurn`（prepare_turn 评估但无策略注册该 phase）、`AfterCompaction`（无任何评估点）为占位变体 | 保持占位并在文档标注「无策略消费」，或删除 |
| Q13 | session-loop/src/control.rs:222-235; input.rs:139-141,169-171,231-233 | 建议 | `request_soft_inject`、`enqueue_soft`、`drain_soft`、`has_soft_pending` 均为 soft 兼容别名，仅测试使用 | 收敛为 steer 命名，删除别名 |
| Q14 | session-loop/src/tool_exec.rs:52,60-62,65-71; agent-tools/src/executor.rs:35,79 | 建议 | `ToolExecutor.idempotency` 恒为 None：`ToolExecutor::new` 不启用、AgentSessionLoop 无启用入口；`execute_single` 的 policy.idempotency 恒 true 但 guard 恒 None——幂等功能在真实链路完全不可达 | 在 AgentSessionLoop/SessionLoopOptions 暴露幂等开关，或删除死配置 |
| Q15 | orchestrator/src/steering_queue.rs:49,67,227 | 建议 | `SteeringInputEntry.session_id` 所有生产构造路径均写空串（user/steering/drain_nudges），恒空字段 | 删除字段或由调用方填充 |
| Q16 | agent-tools/src/idempotency.rs:138,154,166,189,215,233,241,251,265,273 | 重要 | 运行时路径 10 处 `Mutex::lock().expect("幂等守卫锁中毒后不可恢复")`——任一持锁 panic（外部 store 回调等）即级联 panic 且整个进程不可恢复 | 改为 `unwrap_or_else(|e| e.into_inner())` 恢复模式，或返回错误 |
| Q17 | agent-tools/src/mcp/bridge.rs:139,148,156,171,178,185,271,279,304,314,334,401,402,487,507,538,541,551,568,581,591,601,612,618,633,857 | 重要 | 运行时 26 处锁中毒 expect + 2 处样板 expect（538/541 `result.expect("Ok 分支必有值")`）；锁作用域虽短，但数量大且与 Q16 同型 | 统一为恢复模式；538/541 简化为 match |
| Q18 | agent-tools/src/middleware.rs:139,157 | 建议 | `RecordingMiddleware` 锁中毒 expect（示例实现，若被生产引用则同 Q16） | 同 Q16 |
| Q19 | agent-provider/src/sse/frame.rs:122,131 | 建议 | `String::from_utf8(...).expect("已校验为合法 UTF-8")`——前置 from_utf8 校验保证安全，属合理使用（记录为正面） | 无需修改，保留 |
| Q20 | session-loop/src/testing/mod.rs:148 | 建议 | `with_scripts(vec![])` 后首次调用 `stream()` 触发 `.last().expect("脚本至少一份")` panic（测试替身，非生产） | 构造期校验 scripts 非空 |
| Q21 | session-loop/src/tool_exec.rs:386-395 | 重要 | abort 信号只在工具执行完成后检查——L3 取消对运行中的长工具最长需等 `options.timeout`（默认 60s）才生效；超时 drop future 时 MCP 远端仍在执行 | 在 timeout future 内周期性检查 abort，或对执行体包 abort-aware 竞速 |
| Q22 | agent-tools/src/mcp/bridge.rs:308-310 | 建议 | `request()` 的 `Ok(Err(_))` 分支不清理 pending 表项；与 `mark_exited`（177-181）的 drain 存在竞态窗口——exited 之后插入的表项只能等 30s 超时才移除（有限泄漏） | mark_exited 后再清一次 pending，或 request 失败路径统一 remove |
| Q23 | orchestrator/src/events.rs:97,102-107,125-126; run.rs:495-508 | 重要 | 会话内 sequence 由各 run 的 EventQueue 独立分配（base=run.cursor+1），同会话并发 run（主 run + 子 agent）共享同一 store 时 sequence 冲突 → append_event UNIQUE 失败 → 整个 run 被标记 event-store-write-failed | 会话级 sequence 分配器（AtomicU64 或 store 端自增），或禁止同会话并发 run |
| Q24 | orchestrator/src/restore.rs:644-652; events.rs:578（确立的构造模式） | 重要 | 恢复流程的 `next_sequence()`（审计事件用）与 RunManager 落库 cursor=0、EventQueue base=cursor+1（该构造模式由 events.rs 测试确立，生产调用方在 crate 外）无协调：恢复后有审计事件的会话，新 run 首个事件 sequence=1 会与已落库历史事件冲突（详见三.2） | 恢复时回填 RunHandle.cursor = 会话最大 sequence，EventQueue 以之为 base |
| Q25 | orchestrator/src/events.rs:293-309 vs 340-367 | 建议 | 中途持久化失败路径的终态事件用 `next_sequence`（产生序列空洞），而终态落库失败重发路径复用 `err.sequence`——两条失败路径的序列语义不一致，与「事件序列连续性」承诺冲突 | 中途失败路径也复用失败 sequence 发终态 |
| Q26 | orchestrator/src/normalize.rs:109-117 vs run.rs:559-572 | 重要 | 两套终态映射语义冲突：run.rs 中 MaxTurns → Failed（05 §2.8）；normalize.rs 中 MaxTurns → Completed。同一概念两处结论相反，消费方取错映射将产生错误 run 终态 | 收敛为单一映射函数并加一致性测试 |
| Q27 | orchestrator/src/persist.rs:396-471 | 建议 | `LocalDbStore` 的同步 SQLite 调用直接包在 async fn 内（阻塞 runtime 工作线程，无 spawn_blocking / 专用线程） | 用 tokio::task::spawn_blocking 包裹，或文档明确单线程 runtime 约束 |
| Q28 | agent-tools/src/mcp/bridge.rs:237-239,830-877 | 建议 | spawn_reader / spawn_stderr_drainer / spawn_crash_monitor 为 tokio::spawn 且无 join/abort 句柄；stop() 杀进程后依赖 EOF 自终，任务泄漏与生命周期不可观测 | 持有 JoinHandle 并在 stop() 时 abort/join |
| Q29 | session-loop/src/loop/mod.rs:49-63; loop/end.rs:88-106 | 重要 | 错误体系与 conex-types 的 CrishError 完全脱节：LoopError 仅 `message: String`，RunOutcome.error / terminal_error 均为 String，错误码/可重试性/分类在层间丢失；CrishError 只在 IPC 边界兜底（CrishErrorPayload::from_unknown） | EndDecision / RunOutcome / AgentEnd 事件错误字段携带 CrishError（或至少携带错误码 + 上下文） |
| Q30 | conex-types/src/error.rs:985-989 | 建议 | `From<CoreError> for CrishError` 的 InvalidInput → common.unsupported 映射语义存疑（注释自认「无调用上下文走兜底」），调用方易误用 | 删除该 From 实现或改为显式工厂函数 |
| Q31 | session-loop/src/loop/handlers/turn_complete.rs:54; orchestrator/src/events.rs:326 | 建议 | 兜底错误文案「run 失败」/「run 失败」（error 收场且无 terminal_error 时）丢失具体原因，人读信息不足 | 默认文案携带状态机状态与事件类型 |
| Q32 | session-loop/src/steering/mod.rs:232-234 | 建议 | coordinator 预算耗尽时 `evaluate` 静默跳过 inject（continue），不产任何事件——若策略配置 max_steering_messages > coordinator 预算，用户只见「预算耗尽」无原因 | 跳过时附加一条 runtime-steering 诊断事件 |
| Q33 | session-loop/src/loop/handlers/streaming.rs:50,84 | 建议 | `aborted` 标志在 consume 前一次性捕获：流中途触发 abort 时已 commit 消息不带 stopReason=aborted 标注（消息正常落盘后才由 check_control 收场），partial salvage 标注不一致 | consume 后重读 abort_signal 再决定标注 |
| Q34 | session-loop/src/loop/mod.rs:314-320 | 建议 | `while` 退出但未收敛的防御路径读 `machine.context().end_reason`——该字段在多个转移（如 FINISH 不 patch、NO_INPUT 不 patch）下为初始 stop，防御路径信息量低 | 该路径改为显式 internal error 收场 |
| Q35 | session-loop/src/tool_exec.rs:122-133 | 建议 | 审批开启时并行组退化为顺序执行（ApprovalGate 为 &dyn 无法跨 async move 共享）——文档已注明，但审批 + 并行工具场景吞吐下降且无观测 | 未来将 ApprovalGate 改 Arc 化支持真并行 |
| Q36 | session-loop/src/input.rs:25 | 建议 | `next_batch_seq` 用 SeqCst，仅作进程内 batch id 唯一性，Relaxed 足够 | 微调，非必须 |
| Q37 | session-loop/src/tool_exec.rs:84; input.rs:22-26 | 建议 | batch id 用进程级计数器，与 run/session 无关——多 run 并发时 batch id 全局唯一但跨会话无前缀，观测侧难以归属 | 前缀带 run_id |
| Q38 | orchestrator/src/session.rs:156-169 | 建议 | `SessionRecord::apply_leaf_move_event` 只解析 toLeafId，忽略事件中其它字段（fromLeafId 等）——扩展性有限 | 保留现状即可，记录 |
| Q39 | session-loop/src/steering/strategy.rs:139-167 | 建议 | `detect_recent_tool_error_loop` 只统计 tool-result 块的 is_error/exit code，工具输出为纯文本且无「Exit code:」字样时（如 JSON 错误对象无 code 字段）不判定失败——与工具真实失败面有偏差 | 补充常见失败文本特征，或与工具分类结果联动 |
| Q40 | session-loop/src/loop/handlers/stream_error.rs:45-54 | 建议 | 瞬态重试期间不检查 abort_signal——若重试间隙用户取消，仍会继续重试直至阶梯用尽（延迟 3 次请求） | 重试决策前查 abort_signal |
| Q41 | 各 crate 测试 | 建议 | 时间戳/栅栏测试依赖真实时钟（TestProvider::with_pause 真实 sleep、now_iso_utc 无注入时钟），部分测试存在时间脆弱性 | 引入可注入时钟（如 tokio start_paused） |

## 三、高严重度问题详述

### 3.1 【阻塞】cancel-siblings 在并行组致命时漏标中间顺序项（Q01）

触发路径（session-loop/src/tool_exec.rs）：
1. 批次 calls = [P(并行, 致命工具), S(顺序), P2(并行)]，`FailStrategy::CancelSiblings`；
2. 分组（96-109 行）：`parallel_group = [0, 2]`，`order = [1]`，`sequence = [[0,2], [1]]`；
3. 并行组 [0,2] 执行：index 0 致命失败 → `fatal` 置位（174-176 行）；
4. 179-183 行调用 `mark_rest_cancelled(calls, ..., last_idx = 2)`；
5. `mark_rest_cancelled`（444-478 行）的跳过条件 `i <= from_idx || results[i].is_some()`：i=1 时 `1 <= 2` 成立 → 被跳过——但 index 1 从未执行（`results[1]` 为 None），既无 ToolStart/ToolEnd 事件，也无取消结果；
6. `break 'outer`（182 行）后，191-194 行 `unwrap_or_else` 把 results[1] 回退为 `ClassifiedToolResult::error("", "", Cancelled, "cancelled")`——**空 id、空 tool_name**；
7. executing_tools.rs:90-92 将其 record_message：对话中出现 `id="tool-result-"`、`tool_call_id=""` 的 tool 消息；emit_tool_events 也缺少该调用的 tool-start/tool-end 事件对，破坏「tool-batch-start → tool-start → tool-end → tool-batch-end」事件序列契约（01 §五.6）与前端 tool 卡片数据完整性。

修复方向：`mark_rest_cancelled` 不依赖 `from_idx` 下标裁剪，改为「`results[i].is_none()` 即取消」（取消范围 = 全部未完成项，与顺序路径语义一致）；并补充该混排场景测试（当前测试仅覆盖纯顺序批次的 cancel-siblings，见 run_loop.rs / tool_exec.rs 测试集）。

### 3.2 【重要】恢复后新 run 的事件 sequence 与审计事件冲突（Q24）

触发路径：
1. 会话 S 的 run R1 运行至 sequence=5 后进程崩溃（R1 状态 Running 落库，cursor 字段在库中为 5）；
2. 重启执行 `RestoreManager::restore`（restore.rs:512-622）：R1 被标记 interrupted，审计事件 sequence = `next_sequence` = 6（restore.rs:560,644-652）；
3. 新 run R2 经 `RunManager::start_run`（run.rs:495-508）落库 cursor=0，内存 `RunHandle.cursor = 0`；
4. drive_outcome 按 run.cursor+1 构造 EventQueue（events.rs:578/628 同型用法），R2 的 base=1 → 首个事件 sequence=1。而会话内已落库事件从 1 起（R1 的 agent-start 等，含恢复时新增的审计事件），R2 的 sequence=1 必然与已有事件冲突 → `append_event` 触发 UNIQUE(session_id, sequence) 失败（persist.rs:291-299 的 InMemory 亦模拟该约束）→ R2 整 run 被标记 `event-store-write-failed`（events.rs:282-308）。
   即：只要会话有任意历史事件，恢复后新 run 的第一个事件必然 sequence 冲突。当前代码没有任何路径把库中 cursor 回填到 RunHandle（restore 的 RestoreOutcome.runs 携带 cursor 但无人消费）。

修复方向：restore 后按会话最大 sequence 重建 RunHandle.cursor（`EventQueue::new(store, session_max_seq + 1)`），或将 sequence 分配改为 store 端自增/进程级 AtomicU64 按会话键控。

### 3.3 【重要】两套终态映射语义冲突（Q26）

- run.rs:559-572 `map_outcome_to_terminal`：`MaxTurns → (Failed, "max-turns")`，并有测试锚定（run.rs:680-701）；
- normalize.rs:109-117 `terminal_status_for_end_reason`：`MaxTurns → Completed`，注释与测试锚定（normalize.rs:450-472）。

同一 max-turns 收场，按不同消费路径会得到 failed 或 completed 两种互斥终态。前端/恢复/续轮裁决（allows_auto_continue 也基于 reason）若混用两处映射，将出现 run 状态与 agent-end 语义不一致。建议收敛为单一权威映射（含 MaxTurns 裁决），并在两处加互引测试。

### 3.4 【重要】payload 恢复是无效阶梯（Q05）

stream_error.rs:76-85：PayloadTooLarge 时只 `payload_recoveries += 1` 然后 `NoProgressContinue` 重进 provider 循环——请求体（消息列表、max_tokens）完全不变，第二次必然再次 PayloadTooLarge，白白消耗 2 次请求延迟后 fatal。该阶梯既无压缩钩子调用（compression_hook 也是死的，Q04），也没有任何请求变化。要么在重试前接入真实压缩（scrubImagesOldestFirst / 消息裁剪），要么删除该阶梯直接 fatal 并在诊断中说明。

### 3.5 【重要】错误体系与 CrishError 脱节（Q29）

整个运行链路（session-loop → orchestrator → 事件）的错误均为字符串：`LoopError { message }`（loop/mod.rs:49-63）在 catch 兜底时只保留格式化文本（handlers/mod.rs:138-143 的 map_err 丢弃 TransitionError 的原始结构化信息），`RunOutcome.error: Option<String>`、`RunTerminal.error: Option<String>`（events.rs:231-249）。conex-types 的 CrishError（77 码注册表 + category/retryable + cause 链）只在 IPC 序列化边界经 `from_unknown` 兜底为 common.unknown。后果：错误码分类（transient/permanent/security）无法跨层传递，前端只能拿到「provider 错误（server-error）：..."」这类无码文案；恢复钩子（RecoveryHook::decide(error: &str, ...)）也只能基于文本裁决。建议在 EndDecision/RunOutcome/AgentEnd 事件中携带 CrishError（或最小错误码 + 字段），实现层内错误码贯通。

## 四、正面发现（供 E6 打磨保留）

1. 状态机转移表穷举（conex-types/transition.rs）+ 8×20=160 对全量测试 + 33 条逐行断言 + 11 条 error 收场语义测试（state.rs）——规格到测试的闭环是本仓库最佳实践。
2. 未定义转移显式失败、失败不改状态不改上下文（state.rs:57-61, 458-465）——01 §五.1 落实干净。
3. 锁使用整体正确：控制总线 std Mutex 临界区无 await（handlers/mod.rs:196-231、streaming.rs:124-151）；InMemoryStore 延迟 sleep 在持锁前（persist.rs:271-278）；TestProvider 计数锁无 await。锁中毒用 `unwrap_or_else(|e| e.into_inner())` 恢复（handlers/mod.rs:199）是正确模式，建议推广到 idempotency/bridge（Q16/Q17）。
4. consume 聚合的 D5/D6 语义（stream.rs:252-316）：有内容即 Message、错误降级为 metadata 标注、abort 内容保留——错误与输出分离的设计正确且测试充分。
5. 工具超时处理：shell 的 kill_on_drop + 树杀（shell.rs:273,320-324）、abort 竞速后检查顺序（tool_exec.rs:386-395）、timeout 语义与 duration 上报——边界处理到位。
6. run-terminal 唯一终态事件 + best-effort 落库「不假装可回放」（events.rs:157-204, 293-368）——持久化失败语义严谨。
7. steering 单一计数源 D10：evaluate 不改计数、apply 唯一增量点、预算边界 N-1/N 测试（steering/mod.rs:419-479）——边界测试精确。
8. D8 nudge 通道与 PendingMessageQueue 容量挤占语义（evict oldest non-steering / 全 steering 时普通消息丢弃）与 TS 逐条对齐且有 6+ 测试（steering_queue.rs:341-635）。
9. 快照体系：双文件轮转 + tmp/rename 原子写 + FNV-1a checksum + 损坏回退 + previousStatus 审计事件（restore.rs）——恢复健壮性设计优秀，测试覆盖损坏/缺失/回退全路径。
10. 幂等守卫：失败不记录、成功才落键、持久化 store 懒加载、snapshotTag 精确键（idempotency.rs）——语义正确（仅锁中毒 panic 需治理）。
11. 时间戳手写 civil-from-days 有已知基准测试（steering/mod.rs:698-704、steering_queue.rs:631-635），无 chrono 依赖前提下正确性有锚点。
12. 集成测试覆盖面好：run_loop.rs 18 个端到端场景（steering 注入/预算耗尽/abort 部分保留/协作停止/max-turns/瞬态重试/length 阶梯/致命工具/事件序列契约）；orchestrator tests 8 个文件覆盖 drive/cancel/approval/normalize/restore。


