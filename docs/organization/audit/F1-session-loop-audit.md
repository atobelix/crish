# F1：session-loop 会话循环内核严格审计报告

- 审计日期：2026-08-07
- 审计模式：只读（未改动任何代码）
- 审计范围：`crates/session-loop/src/` 全部源码 + `crates/conex-types/src/session.rs`、`transition.rs`
- 审计方式：逐文件通读（loop/mod.rs 1192 行、handlers/* 全部 8 个、state.rs、safe_point.rs、tool_exec.rs 生产段 131-1350 行、stream.rs、control.rs、input.rs、steering/*、approval.rs、approval_router.rs、hooks.rs、hydrate.rs、cache_tracker.rs、escape_watch.rs、testing/mod.rs 等），配合 grep 扫描 unwrap/expect/panic/`let _`/未接线字段
- 严重度定义：P0 = 崩溃/数据丢失/安全面；P1 = 行为错误或错误被吞（用户无感知）；P2 = 边界/竞态缺陷（需特定输入或时序触发）；P3 = 死代码/健壮性/信息级

---

## 一、发现清单

### P1（高）

| 编号  | 位置                                                                                                     | 严重度 | 问题描述                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 触发场景                                                                                                                                                                                                 | 修复建议                                                                                                                                                                           |
| ----- | -------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1-01 | `loop/mod.rs:713-723, 770-778`                                                                           | P1     | **B1 验证：Skip 在 streaming 态静默降级——现状确认存在且注释与实现不符**。`recovery_decision` 在无 `recovery_hook` 且未 abort 时缺省返回 `RecoveryDecision::Skip`（:722），而 Skip 分支在 streaming 态派发 `NoToolCalls` 正常收场（:773-777）。即：**任何 handler 抛出的非 abort 错误（无钩子注入时）都会被静默降级为「纯文字回复正常结束」**，run 以 `stop` 收场、无 error、用户无感知。模块头注释（:21-22）声称「缺省：不可恢复内部错误 → error 收场」，与实现（缺省 = Skip）相反 | 无 recovery_hook 的生产路径下，streaming/executing 链路任意内部错误（如 `dispatch` 失败、`LoopError::internal`）→ catch 兜底 → Skip → `NO_TOOL_CALLS` → turn-complete → stop 收场，错误仅在日志/事件可见 | 缺省决策改为 error 收场（Fatal 分支）或至少区分「已知良性错误」与「内部错误」：`LoopError::internal` 类一律 error 收场；Skip 仅允许 recovery_hook 显式裁决返回                     |
| F1-02 | `tool_exec.rs:598-600`（顺序路径）、`:357-359`（并行组审批循环）、`:1140-1142`（requires_approval 重试） | P1     | **外层批级审批等待无超时、无 abort 竞速窗口**。`gate.request_approval(...).await` 直接挂起——`ApprovalGate` 是编排层注入的外部 trait，内核侧无任何防护。对比：工具内 ask 通道（`approval.rs:131-160`）有 `wait_aborted` 竞速 + 50ms 轮询取消，而批级审批三个 await 点全部裸挂。abort 信号/force_cancel 在审批等待期间无法打断 run                                                                                                                                                   | 审批卡片丢失/事件桥断连/裁决者（主 agent）被 wait 阻塞时，用户 abort 后 run 无限悬挂（依赖 gate 实现方自带的 120s 超时，approval_router.rs:24-33 注释表明超时兜底在编排层，内核无强制面）                | 三个 await 点统一包 `tokio::select!{ biased; abort → Cancelled, decision = timeout(approval_timeout, gate.request_approval) → Expired }`；超时常量可配置（缺省与编排层 120s 对齐） |
| F1-03 | `state.rs:72` `turn_index += 1`；`prepare_turn.rs:43` `turn_index + 1`                                   | P2     | **u32 计数溢出无保护**。debug 构建 `+= 1` 溢出 panic（状态机进程级崩溃）；release 构建 wrap 归零 → `should_stop_for_max_turns`（session.rs:153-155）失效 → max-turns 预算被绕过                                                                                                                                                                                                                                                                                                    | `max_turns = u32::MAX`（或任意 > 32 亿）+ `NO_PROGRESS_CONTINUE` 连续重试/`InputAvailable` 归零前累计。现实中不常见但属预算边界失效                                                                      | `saturating_add(1)`；并在 turn-complete 的 maxTurns 判定前对 `turn_index == u32::MAX` 显式收场                                                                                     |

### P2（中）

| 编号  | 位置                                                                              | 严重度 | 问题描述                                                                                                                                                                                                                                                                                                                                       | 触发场景                                                                                        | 修复建议                                                                                                                       |
| ----- | --------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| F2-01 | `stream_error.rs:101`、`no_tool_calls.rs:32` `state.max_tokens *= 2`              | P2     | **length 阶梯升级溢出**。`length_upgrade_limit` 是配置项（u32），默认 2 安全（8192→16384→32768），但配置 > 24 次时 `8192 × 2^24 > u32::MAX` → debug panic / release wrap 成小值（wrap 后 max_tokens 变小，行为退化）                                                                                                                           | 壳层/测试注入 `length_upgrade_limit ≥ 25` + 连续 ContextLengthExceeded 或 stopReason=length     | `saturating_mul(2)` + 阶梯上限钳制到 32768（配置超上限按上限计）                                                               |
| F2-02 | `turn_complete.rs:115` `should_stop_for_max_turns()`                              | P2     | **max_turns=0 边界语义**：`turn_index(1) >= 0` 恒真，首轮已完整执行（用户消息已消费、provider 已调用、回复已 commit）后才 max-turns 收场。「max_turns=0 = 不允许任何轮次」语义下应更早拦截；且 `max_turns=1` 时首轮后即收场（符合直觉）但无任何测试锚定这两个边界                                                                              | 壳层误配 max_turns=0                                                                            | run() 起始显式拦截 `max_turns == 0`（收场原因明确化）；补 max_turns=0/1 边界测试                                               |
| F2-03 | `control.rs:429-438` `drain_as_action`                                            | P2     | **无消息的 L1 意图被静默吞没**。`inject_intents` 过滤 `i.message.is_some()`（:406）；若队列仅含 message=None 的 SoftInject/Steer/FollowUp（`ControlIntentInput.message` 全 Option，序列化载荷允许 None），drain 后返回 `None`——意图已出队但无任何动作、无日志                                                                                  | 外部调用方（壳层/UI）构造 `request(SoftInject, message: None)`；或 wire 反序列化缺 message 字段 | 无消息 L1 意图：保留意图并记录 warn（或返回 None 时先检测「有 L1 但无消息」并告警），不静默丢弃                                |
| F2-04 | `loop/handlers/steering_evaluation.rs:26-72`（无 `check_control` 调用）           | P2     | **steering-evaluation 状态无安全点**。模块头注（handlers/mod.rs:13）宣称「每个 handler 起始调用 check_control」，steering_evaluation 是唯一缺失者（注释自辩为瞬时相位）。后果：abort 在 empty-response 分类后、steering 注入前到达时，**仍会执行一次策略评估并把 steering 注入消息写入对话**（abort 后副作用），到 preparing-turn 安全点才收敛 | 流空响应 + 用户恰在 steering 评估窗口 abort（Q21 竞速的延伸窗口）                               | handler 起始补 check_control；或在 streaming Empty 分支 dispatch(SteeringNeeded) 前复查 abort（与 StreamError 分支 :219 对齐） |
| F2-05 | `streaming.rs:315` `tools_schema().expect(...)`                                   | P2     | **生产路径防御性 expect**。依赖「build_request 前必须 ensure_tools_snapshot」的调用纪律（:52 先调用），一旦未来新增调用点绕过纪律即 panic（进程级）。同类：`streaming.rs:199` `tool_calls.len() as u32`（usize→u32 截断，模型产出 >40 亿工具调用时失真，理论面）                                                                               | 纪律破坏（新 handler/新路径直接调 build_request）                                               | expect 改 `LoopError::internal`（与 dispatch_once 的 Idle/Done 防御同风格）；count 转换加 `min(u32::MAX)` 或改用 u64 语义      |
| F2-06 | `hydrate.rs:289-294` `truncate_to_last_user`                                      | P2     | **水合不校验 user/assistant 交替**。仅保证尾部 user（:290-291），中间可连续 user 或连续 assistant（assistant 开头的历史在尾部 user 前是合法的，但 [assistant, user, user] 形态会原样进请求）。Anthropic 系协议对连续同角色消息更严格（部分实现拒绝），OpenAI 系容忍                                                                            | 前端 store 存在连续 user 消息的历史（多轮追问未合并）                                           | 水合层做交替归并（连续同角色合并 text）或至少断言记录；列为后续演进项即可（当前 ProviderCall 实现方未反馈拒绝）                |
| F2-07 | `turn_complete.rs:49-52`（步骤 2）与 `executing_tools.rs:104-123`（步骤 5 fatal） | P2     | **fatal 判定先于 abort 检查的时序**：batch abort 时若已完成工具为 fatalOnError，executing_tools 步骤 5 先 dispatch(Error)（endReason patch 为 error），随后 turn_complete 步骤 2 的 abort 复查兜底为 aborted 收场——**最终收场正确**，但期间状态机经过 error 中间态，若 turn_complete 之前的任何路径提前收敛（未来改动）会误报 error            | 当前不可触发（turn_complete 步骤 2 兜底），属防御性观察项                                       | 在 executing_tools 步骤 5 前复查 abort（与步骤 1 同源），fatal 与 abort 并存时直接走 abort 路径                                |
| F2-08 | `streaming.rs:105-111` delta_sink 发射                                            | P3     | 实时轨 `sink.push(delta)` 返回 `()`，**丢帧无感知**（注释声明「丢帧不丢 message-end」为设计契约）。但 abort 后已 push 的 delta 与收口轨 message-delta 若消费侧双收会重复（设计约定依赖事件桥去重，本层无校验）                                                                                                                                 | 事件桥消费侧未按 sequence=None 语义去重时，abort 场景出现重复 delta                             | 属跨层契约面，建议在 03 §5.3-6 契约文档补 abort 场景的 delta 与收口轨一致性说明                                                |
| F2-09 | `hooks.rs:687-700` `error_eventing` 重入护栏                                      | P3     | handler 内 panic 时 `error_eventing` 标志卡死 `true`（无 guard/恢复），后续所有错误事件化被永久关闭（仅影响观测）                                                                                                                                                                                                                              | 插件 handler panic（async fn 内 panic 不跨 await 时直接传播）                                   | 用 RAII guard 恢复标志，或 hook handler 调用包 `catch_unwind`                                                                  |

### P3（低 / 死代码与未接线）

| 编号  | 位置                                                                                                     | 问题描述                                                                                                                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F3-01 | `steering/strategy.rs:258` `digits.parse().ok()?`                                                        | `exit_code_from_text` 匹配到非法数字段时提前 `?` 返回 None，**漏掉文本后续的合法 `exit code: N`**（如 "exit code: unknown\nexit code: 1" 判为非失败）。应为 `continue` 继续扫描 |
| F3-02 | `tool_exec.rs:145-155` `with_idempotency`                                                                | **pub 但全 crate 零消费**（生产路径用 `with_idempotency_opt` :161，:451 为唯一调用点）；grep 确认无任何测试调用。死代码                                                         |
| F3-03 | `cache_tracker.rs:145-147` `set_ttl`                                                                     | pub 但零消费（T-40 引擎接线点未到，字段无生产调用）——预留接口，标注即可                                                                                                         |
| F3-04 | `loop/mod.rs:555-557` `escape_watch_config()`                                                            | 注释自认「生产零消费现状保持」（观测/调试用），壳层经自身装配点取配置，本 getter 冗余                                                                                           |
| F3-05 | `provider.rs:49` `StreamResult` 别名                                                                     | 冻结契约保留形态，「评估去留」未决，pub 但无消费方（测试内亦无）                                                                                                                |
| F3-06 | `steering/mod.rs:57, 60` `BeforeTurn` / `AfterCompaction`                                                | 占位相位：`BeforeTurn` 有评估点（prepare_turn.rs:64 遍历）但无策略消费；`AfterCompaction` 无评估点无消费（注释已标注 T06.3 Q12）                                                |
| F3-07 | `loop/mod.rs:155` `should_stop_after_turn`                                                               | 注释自认「生产暂无注入方，兼容层仅测试/编排注入用」；turn_complete.rs:155-168 保留完整消费逻辑                                                                                  |
| F3-08 | `streaming.rs:291` `ProviderRequest { session_id: None }`                                                | T-17（P2 步骤 4b）未接线：缓存键派生的会话 ID 恒 None，`session_id` 字段为占位                                                                                                  |
| F3-09 | `safe_point.rs:106-112, 162-198` `ControlAction::end_reason` / `write_inject_messages` / `ring_for_kind` | `#[cfg(test)]` 标注的生产零消费面（T06.3 Q06 已登记）                                                                                                                           |
| F3-10 | `executing_tools.rs:144` `tool-result-{result.id}`                                                       | 工具角色消息 id 复用模型 tool-call id：跨轮复用同 id 时消息 id 冲突（模型可重复产出同 id 调用）；事件侧无重复检查                                                               |
| F3-11 | `input.rs:19, 66-71` 队列容量覆盖                                                                        | 容量 1000 满时**静默覆盖最旧输入**（含用户 force 消息）——设计文档化的背压保护，但被覆盖的用户消息无任何日志/事件                                                                |

---

## 二、审查维度逐项结论

### 1. 状态机边界

- **转移表穷举质量高**：`transition.rs` 全 160 对（8×20）有穷举测试（:429-445，33 条已定义 + 显式 Undefined/Terminal），`state.rs` 逐行断言 + 失败不变更语义（:57-61「先查表后变更」）均有测试锚定。**可达状态集合与转移表一致**，未发现非法组合可达。
- **边界缺口**：max_turns=0/1 无测试；turn_index 溢出无保护（F1-03）；`E::HasToolCalls { count }` 载荷无钳制（F2-05 附注）；steering 预算边界（N-1/N）有测试（steering/mod.rs:475-512）——此维度质量最好。
- 注：`transition.rs` 中 streaming 的 `InterventionRequired` → turn-complete(endReason=error) 与 steering-evaluation 的 `InterventionRequired` → turn-complete(endReason=error) 两条线生产侧都被 D7 裁决改写为 stop+诊断（prepare_turn.rs:73-81、steering_evaluation.rs:61-68），转移表保留 error 语义但生产不触发——一致但有冗余。

### 2. 并发与竞态

- **abort 竞速实现正确**：Q21 双轨（streaming.rs:84-99 流消费 + tool_exec.rs:886-893 工具执行 + run_hook_with_timeout:1257-1261）均为 `biased` 且带双重 `is_aborted()` 复查；`wait_aborted` 防丢通知模式正确（safe_point.rs:65-74）；Q33 补标注（streaming.rs:135-154 + stream.rs:488-516）闭环。工具执行 drop = 尽力取消，远端取消依赖传输层/abort_token——本层已提供。
- **竞态缺口**：批级审批等待三个 await 点无竞速（F1-02）；steering-evaluation 无安全点（F2-04）；`delta_sink.push` 同步调用无背压（设计契约）。
- **锁使用**：全部 `Mutex` 均走 `unwrap_or_else(|e| e.into_inner())` 恢复（check_control/loop/mod.rs:518、approval.rs:82、hooks.rs:461 等），无 `unwrap()` 残留；`hooks.rs` 读锁在 handler 调用期间不持有（快照克隆 :516-535，防重入死锁）——**PoisonError 处理无残留**。await 内持锁：`ApprovalChannel::ask` 的 recorded 锁仅在 push 瞬时持有（:112-122），无跨 await 持锁。
- **Atomic 使用**：`MESSAGE_ID_COUNTER`/`BATCH_SEQ`/`SUBAGENT_INJECT_SEQ`（Relaxed/SeqCst 混合）自增，u64 溢出不现实；`AbortSignal` AtomicBool SeqCst 正确。

### 3. 超时与取消

- 工具执行超时（60s 默认）✓；中间件链超时（2000/2000/1000ms）✓；hook 超时（注册级）✓；流消费 abort 及时取消 ✓。
- **缺口**：审批等待无超时无取消（F1-02，最大悬挂风险点）；abort 后工具 future 被 drop 属「尽力取消」，真实子进程/远端任务泄漏依赖工具实现方协作（abort_token 已提供但无强制）；`EscapeWatchHandle::shutdown` 有 await task 收口（escape_watch.rs:293-300），Drop 兜底仅 stop watcher 不 await（:307-309）——run 崩溃路径消费任务 detached，靠通道关闭自收口，有轻微泄漏窗口（P3 观察项）。

### 4. 错误处理

- 生产路径 `unwrap`/`expect`/`panic!` 扫描：**非测试代码仅 1 处 expect**（streaming.rs:315 工具快照，F2-05）+ 1 处防御性 `unwrap_or_else`（tool_exec.rs:502 空结果兜底，注释明确）。`let _ =` 全部为 hooks observe 语义（设计如此，错误事件化已计数）。`hydrate.rs` 的 `.ok()` 过滤为宽容水合设计。
- **最大问题 = F1-01（Skip 缺省静默降级）**——错误被吞成正常收场，这是本轮审计最值得先修的一项。
- 恢复决策边界：`Retry` 仅 streaming 生效（:763）、`Skip` streaming 降级、`Abort` 按状态分派——决策本身有防御分支，问题是缺省值选错。

### 5. 数值边界

- token 累计：cache_tracker 全部 `saturating_add`（:190-192）✓；`clamp_max_tokens` 用 saturating（handlers/mod.rs:181-197，下限 256 不钳 + MIN 1，有测试 :633-650）✓。
- **缺口**：`max_tokens *= 2`（F2-01）、`turn_index += 1`（F1-03）、length 阶梯「8192→16384→32768 上限 2 次」默认路径有测试（stream_error.rs:560-598 覆盖用尽→压缩→fatal 全链）✓——配置放大后失效。
- 输出截断：`output_budget_bytes` 透传 executor（tool_events.rs:235，默认 None 不截断）——**默认不截断**：模型产出超大输出时工具结果消息无上限进入对话（上下文膨胀），靠预算/压缩兜底，无输出侧硬上限（P3 观察项）。

### 6. 空与极值输入

- 空消息 run：`enqueue_force` 后 awaiting-input 必消费到（run 起始即 force），空文本消息正常；`TestProvider` 空脚本构造期断言（testing/mod.rs:54, 70）；空流 → Empty → steering 路径有测试。
- **空工具注册表 + 模型产出工具调用**：`execute_single` 未知工具 → NotFound 非致命喂回模型（tool_exec.rs:676-689，有单测 :1523-1533）——但**整链路（streaming→executing-tools→喂回）无端到端测试**。
- 超长参数/超大消息：无长度上限校验（消息块文本无上限），依赖压缩；`exit_code_from_text` 有线性扫描。

### 7. 死代码与未接线

见 F3-02~F3-09 清单。重要确认：`steering_enabled` 真实生效（streaming.rs:206-211 Empty 短路 + prepare_turn.rs:63 + steering_evaluation.rs:30-35 三处接线一致）✓；`idempotency_enabled` 真实生效（with_options 注入守卫 :446-451，有测试）✓；`output_budget_bytes` 真实透传 ✓；`parent_run_id`/`approval_requester` 链路完整 ✓。

### 8. 测试盲区（建议补测）

1. **max_turns = 0 / 1 端到端**（F2-02 语义锚定）
2. **无 recovery_hook 时 handler 抛错 → Skip 静默降级**的端到端断言（F1-01 行为钉死或修复后钉死）
3. **批级审批挂起 + abort 竞速**（F1-02：顺序路径与并行组两个 await 点）
4. `length_upgrade_limit`/`transient_retry_limit`/`continue_nudge_limit` = 0 与超大值边界（0 = 直接 fatal/收场，无测试）
5. 空工具注册表 + HasToolCalls 整链路（NotFound 喂回 → 下一轮）
6. turn_index 溢出（u32::MAX 构造，debug 下验证不 panic 或显式收场）
7. steering-evaluation 状态 abort 竞速（F2-04：abort 后不得注入 steering 消息）
8. 消息 id 冲突（模型复用 tool-call id → tool-result-{id} 重复，F3-10）
9. `exit_code_from_text` 非法数字段 + 后续合法段（F3-01）
10. hydrate 连续 user / assistant 开头形态（F2-06）

---

## 三、结论

**总体评价：内核工程质量高**——状态机穷举、abort 竞速（Q21/Q33/Q40）、锁中毒恢复、append-only 前缀纪律（P1/I1-I6）、恢复阶梯与压缩阶梯的双维度恢复，均实现严谨且有测试锚定；生产路径几乎无 unwrap/panic 残留；`steering_enabled`/`idempotency_enabled` 等开关均真实接线。

**建议优先修复（按序）**：

1. **F1-01**（缺省 Skip 静默降级，错误被吞）——行为面错误，直接影响用户可感知的正确性；
2. **F1-02**（批级审批无超时/无 abort 取消）——最大悬挂风险，abort 无法收敛 run；
3. **F1-03 + F2-01**（u32 溢出三处）——防御性修复，成本低；
4. **F2-02**（max_turns=0 边界）与 **F2-03**（L1 无消息意图吞没）——边界收口；
5. 其余 P2/P3 按测试盲区清单补测后择机修复。

**P0 级缺陷：未发现**（无崩溃面、无数据丢失面、无安全面；最接近的是 F1-01 的错误吞没与 F1-02 的悬挂，均非崩溃类）。
