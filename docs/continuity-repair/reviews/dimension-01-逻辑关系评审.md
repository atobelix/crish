# 维度评审 01 — 方案之间逻辑关系与接口一致性评审

> 目录：docs/continuity-repair/reviews/
> 日期：2026-08-11
> 评审视角：维度间接口契约对齐、数据面冲突、接线时序成立性、与敲定方案一致性
> 输入：00-总纲-维度设计.md、01-敲定方案.md、dimensions/D1-D8（8 份）
> 结论：**接口契约 90% 对齐，但存在 2 处阻断级文件域/载荷冲突、8 处重要级接口缺口，需主控裁决后进入修订轮**。

---

## 0. 结论速览

| # | 级别 | 问题 | 涉及文档 |
|---|---|---|---|
| B1 | 阻断 | 流中断结构化标注文件域双挂：D1 与 D7 均声明为主体实现方（streaming.rs/consume/mod.rs/stream.rs/engine.rs to_loop_event） | D1 §1.1/§3.5/附录 vs D7 §1.3/§3.7 |
| B2 | 阻断 | goal-round-completed 事件载荷字段集在 D5（发射面）与 D8（登记面）不一致 | D5 §3.9/§4.2 vs D8 §3.1.1/§4.1 |
| W1 | 重要 | 熔断触发的 recovery-escalated（detail=circuit-trip）与冻结载荷（无 detail、含 subagentRunId）不匹配，发射点归属未定 | D1 §3.2.2 C5 vs D8 §3.1.1 |
| W2 | 重要 | D6 空注入轮判定 `empty_inject = !queue_pending` 会把 goal 续轮误判为空注入轮不计 streak，与敲定 #21 矛盾且与 D6 自身测试矛盾 | D6 §3.5/§1.2 A6/§5.5 |
| W3 | 重要 | RunFailureContext 增 history 字段（00 §6 冻结契约外扩展），D7 单方面声明，D3/D4 的 ctx 装配表未同步 | D7 §1.3-3/§3.4 vs D3 §3.2.4、D4 §3.5 |
| W4 | 重要 | EngineHandle::new_with_spawner 被 D4 与 D6 同点双改，参数名/类型/下转型路径不一致 | D4 §3.8 段2 vs D6 §3.1 段2 |
| W5 | 重要 | D2 直写 recover_episodes 绕过 RecoveryCoordinator 内存缓存，D8 观测（budget() 内存态）与重启恢复出现陈旧窗口 | D2 §3.4 vs D3 §3.1 vs D8 §3.3 |
| W6 | 重要 | recovery-budget-denied 双发射方载荷不一致（D2 主 run 侧无 subagentRunId） | D2 §3.4 vs D8 §3.1.1 |
| W7 | 重要 | recovery-* 事件落库会话域（子代理失败事件在 sub-sess-*）与 D8 前端主会话检索路径未闭环 | D3 §4.2 vs D8 §3.7.1 |
| W8 | 重要 | 敲定 #8 唤醒源枚举（含 restore）与预算消费面错位：仅 error-retry 实际消费，D6 明言 restore 不消费预算 | 01 §1 #8 vs D6 §3.3 |
| W9 | 重要 | D4 wait 真适配「单槽降级」vs MemoryWaitStore 16 条声明语义，效果边界需主控确认 | D4 §1.3/§8 D-2 |
| S1-S9 | 建议 | 见 §6 建议级清单（goal_state 键字段命名、coordinator_for await、自决新键、runtime-intervention-required 消费、run_restore 汇聚批等） | 见 §6 |

---

## 1. 接口契约对齐核查（逐接口）

### 1.1 `RunOutcome.provider_error`（D1→D2/D3）— 对齐 ✓

- 四方定义一致：00 §6（kind/retryable/retry_after_ms/retries）、01 §2.3（Option\<ProviderErrorSummary{kind, retryable, retry_after_ms, retries}\>）、D1 §3.4、D2 §4、D3 §3.2.1 全部同形。
- 提取点一致：D1 §3.4 / D2 §3.2 / D3 §3.2.1 / 01 §2.3 均指向 drive_run_loop :2710-2712 移动消费前 clone。
- 填充点一致：fatal_provider_error（stream_error.rs:237-269）唯一 fatal 入口，D1 §3.4 与 01 §2.3 吻合。
- 注意（非冲突）：D3 §8 决策 1 将 `RunFailureContext.retries` 语义定为「跨 run 阶梯 1 已重试次数」而非 provider_error.retries（run 内计数），且明言 provider_error.retries 仅作观测——与 02 W4 原表述冲突已在 D3 内留痕，合理，但 00 §6 契约表第 2 行「retries」一词在 D1 侧（run 内）与 D3 侧（跨 run）语义不同，建议 00 修订时加注（见 S8）。

### 1.2 `RunFailureContext`（壳层→D3）— 有 1 处扩展缺口（W3）

- 00 §6 冻结 8 字段（subagent_id/task/error_kind/retries/produced_content/from_leaf_id/inject_bytes/window_bytes）；D3 §3.2.4 按 recovery.rs:757-780 的 11 字段装配（另含 subagent_run_id/retry_elapsed_ms/started_at_ms）。
- D7 §1.3-3 新增 `history: Option<Vec<HistoryMessage>>` 字段并自标「需显式批准」——方向正确，但 D3 §3.2.4 装配表与 D4 §3.5 prepare_resume 均未同步该字段，构成「消费者（D7）依赖 D3/D4 装配点填充、生产者文档未声明」的断链。详见 W3。

### 1.3 `goal_state` 键（D5→D6/D8）— 字段命名不一致（S1）

- 01 §2.1 冻结形状：goal/max_rounds/max_stalled_rounds/current_round/stalled_rounds/progress_signature/stopped_reason（snake_case）。
- D5 §4.1 JSON 示例：`maxRounds`/`currentRound`/`stalledRounds`/`progressSignature`/`stoppedReason`（camelCase）+ 新增 `schemaVersion`/`updatedAtMs` 两字段；而 D5 §8 决策 3 自称「键形状与敲定严格一致」——文档内部自相矛盾。
- 参照系：D1 的 provider_fail_streak 键示例（§3.2.1）与 01 §2.1 均用 snake_case，仓库 session_meta 键惯例为 snake_case。goat_state 内部字段命名需统一（详见 S1）。

### 1.4 `provider_fail_streak` 键（D1）— 对齐 ✓，附带 2 个配置键

- 01 §2.1（count/first_fail_at_ms/last_fail_at_ms/window_ms）与 D1 §3.2.1 完全一致；window_ms 默认 0 = 无窗口（裁决 #6）在 D1 §8 决策 7 有解释。
- D1 §4.1 另立 provider_fail_threshold / provider_fail_window_ms / provider_retry_backoff_ms 三键，其中前两键为 V2 核查项「建议暴露可配」的落地，合理但属冻结键表外新增，建议 01 §2.1 补登（见 S3）。

### 1.5 事件登记（D3/D5→D8）— 1 处阻断（B2）+ 1 处载荷错位（W6）

- 数量口径：D8 §8 D-1 锁定 49（41 + 8），替换 00/01 的「47/49」表述，合理（01 §2.2 表列全 8 事件）。
- recovery-* ×5：D3 §4.2 发射点与 D8 §3.1.1 载荷逐一对齐（escalated/steering/fork/report/budget-denied），✓。
- goal-* ×3：**goal-round-completed 载荷 D5 与 D8 不一致**（B2）；goal-round-started 基本一致（D8 多 sessionId，信封级字段，S9）；goal-continuation-decided 一致。
- 双发射方：recovery-budget-denied 有 D3（fork 拒绝，recovery.rs:1051-1063）与 D2（主 run 预算耗尽，D2 §3.4 consume_main_episode）两个发射点，D2 侧 payload 无 subagentRunId（W6）。
- 发射通道：D5 §8 决策 4 goal-* 走 envelope emit、recovery-* 走 append_event 直写——与 01 §2.2「recovery 域继续走 append_event 直写」不冲突（01 未规定 goal 通道），但 D8 §2.2 发现的「append_event body-only 不可被 core_read_session_events 读取」事实必须由 D8 §3.2 读面合成兜底——该兜底已设计，✓。

### 1.6 队列与拉起器 group_id（D2/D3/D6 共享）— 对齐 ✓

- 00 §6 前缀族（recovery-/restore-/subagent-terminal-/timer-/task-wake），D2 §3.4（recovery-\<主run_id\>）、D3 §4.3（recovery-\<子代理run_id\>、subagent-terminal-）、D6 §3.3（restore-\<run_id\>）、D6 §7（补 cron-、watchdog-）与 00 表一致；条目 id 各自带时间戳保唯一（D2 §3.4、D6 §3.3）。
- D2 §3.4 已声明「与 C7 阶梯 2 同前缀不同 run_id 域，replace_or_enqueue 按完整 group_id 去重不冲突」——前提是主/子 run_id 全局唯一，文档已注明。
- 合并注入上限 ≤16：D2 §6、D6 §3.4（RESTORE_MERGE_INJECT_LIMIT，作用于 drain 全源）与 00 护栏 8 一致 ✓。

### 1.7 checkpoint 载荷与 hydrate 标记 — 对齐 ✓

- 00 §6（read/set_leaf_checkpoint session.rs:514-574；损坏降级）与 D7 §2.1/§3.5 一致。
- hydrate 标记：00 §6（error 态保留 + metadata {kind:"failed-turn"}，无 schema 改动）、D7 §3.6、D8 §3.4 三方完全一致；hydrate.rs 文件域归 D7 单写方、D8 只冻契约，两文档互相引用确认 ✓。

### 1.8 `RunTaskOptions` 三字段（D5）— 对齐 ✓

- 01 §2.3（visible_goal/max_rounds/max_stalled_rounds，serde camelCase，缺省 None）与 D5 §3.1/§4.3 一致；D5 缺省 12/2 有前端常量先例支撑。

---

## 2. 数据面冲突（同一键/事件/命令/文件被多维度改动）

### 2.1 文件域冲突

| 文件 | 声明方 | 冲突面 | 级别 |
|---|---|---|---|
| streaming.rs / consume/mod.rs / stream.rs | D1 §3.5、§1.1 目标⑤、附录（stream.rs「标注」、consume「标注镜像」、streaming「注入点」）**vs** D7 §1.3 范围迁移一、§3.7（「本维度裁定：主体改动归 D7，D1 只负责 provider_error 数据面」） | 双写方声明同一批文件，且 D1 验收 A9/T18 覆盖标注行为；派单无法同时满足两份文档 | **B1 阻断** |
| engine.rs to_loop_event 映射 | D1 §3.5（:655-660 映射）vs D7 §3.7（「04 §3-5 提及，与 D1 同文件按串行纪律」） | 两方均已声明同文件同函数改动，D7 承认串行但 D1 未让位 | B1 连带 |
| engine.rs `EngineHandle::new_with_spawner` 构造签名 | D4 §3.8 段2（增 `local_db: Option<Arc<LocalDb>>`，经 `self.local_db()` 下转）**vs** D6 §3.1 段2（增 `db: Option<LocalDb>`，经 `store.as_local_db()` 下转） | 同点双改、参数名/类型/下转型不一致；两份文档互相未引用对方 | **W4 重要** |
| run_restore 成功路径（core_run_commands.rs:2201-2236 区域） | D3 §3.3（树重建+重排）、D5 §3.2（goal_state 惰性加载）、D6 §3.3（恢复条目）、D8 §3.3（状态访问器装配） | 四维度插入点汇聚；各文档仅以「同文件串行」带过，无合并批次定义 | S4（协调提醒） |
| drive_run_loop 收口区（:2710-2712 / :2718 / :2729 / :2844-2852 / :2872） | D1/D2/D3/D5/D7 各自声明插入点 | 00 §4 已声明派单按文件互斥，文档间时序描述相互兼容（D3 §3.2.1、D7 §3.1、D5 §3.3 顺序自洽） | 无冲突 ✓ |
| hydrate.rs | D7 §3.6（实现）vs D8 §3.4（契约定义） | 双方已协商归 D7 单写方，D8 不触碰 ✓ | 已解决 ✓ |

### 2.2 键冲突

| 键 | 声明方 | 状态 |
|---|---|---|
| recover_episodes | D2 主 run 路径（三参指纹，D2 §3.4 直写）**与** D3 RecoveryCoordinator（两参指纹，record_fork）双写方 | 01 §2.1 已裁决「D2 主 run 预算写入同键」，D2 §3.4 精确化为指纹域互斥+串行守卫——写冲突已解决；**但 D2 直写绕过 coordinator 内存缓存，与 D8 观测读 budget() 内存态产生陈旧窗口（W5）** |
| goal_state | D5 唯一写方=RoundAssessment，00 §6/01 §2.1 冻结 | ✓ |
| provider_fail_streak | D1 唯一读写方 | ✓ |
| recover_ladder1_max_retries | D3 §4.1 自决新键（冻结表外） | S3（需追认） |
| dispatch_* / timer_<id> / sched_<id> | D4（wait 真适配）/ D6（timer/sched 真适配），键形状已冻结 | 无冲突 ✓（W4 只冲突构造签名） |

### 2.3 事件冲突

| 事件 | 冲突面 | 级别 |
|---|---|---|
| goal-round-completed | 发射面载荷（D5 §3.9/§4.2）vs 登记面载荷（D8 §3.1.1/§4.1）字段集不一致 | **B2 阻断** |
| recovery-escalated | D1 C5 拟以 detail=circuit-trip 形态留痕 vs D8 冻结载荷（subagentRunId/kind/retries/elapsedMs，无 detail）vs D3 §4.2 发射点仅子代理 Escalate 分支 | W1 |
| recovery-budget-denied | D2 主 run 侧发射（payload 无 subagentRunId）vs D3 子代理侧发射 vs D8 冻结形状（含 subagentRunId） | W6 |
| recovery-* 会话归属 | 子代理失败事件经 append_event 落 sub-sess-* 会话（D3 §4.2「会话级原子取号」），D8 §3.7.1 失败卡片以主会话 core_read_session_events 检索为数据源 ① | W7 |

### 2.4 命令冲突 — 无 ✓

- D4 命令面（resume_subagent/kill_all/kill_subagent/core_resume_run 登记先行）与 D8 前端消费（§3.7.1 按钮、commandMap 白名单）一致；D8 §4.2 明言「不重复登记」✓。

---

## 3. 接线时序成立性（00 §4 DAG 核查）

| DAG 边 | 遵守情况 | 备注 |
|---|---|---|
| D1→D2 | ✓ 同批（01 §3-2、D1 §7、D2 §3.6） | 两文档均声明同批，stream_error.rs 单批 |
| D3→D4 | ✓ D4 §3.5「D3 完成前 resume 命令不可用」、D3 §7 阶梯 3 fork 归 D4 命令面 | 一致 |
| D6-①→②→③ | ✓ D6 §1.1 顺序表即实现序 | — |
| D6→D7 | ✓ D7 §7「拉起器注入载体 D6→D7，不依赖 watcher 判定」；D7 §8 决策 1 提供基线自洽路径（经 state.sessions 重建树），不阻塞 D7 独立验收 | — |
| D5 独立 | ✓ D5 §7 只依赖 RunTaskOptions 字段面；decide_idle_resume 同批为同批约束非 DAG 依赖 | — |
| D8 横切 | ✓ 事件面随 D3/D5、UI 面随 D4 均被 D8 §7 引用 | — |

**断链候选（生产者后于消费者 / 消费者依赖未定义输入）**：

1. **W3**：D7 的 history 注入消费 D3 收口触发点（:2844 前）与 D4 resume 路径（lifecycle.rs:287-301）的 ctx 装配，但 D3 §3.2.4 与 D4 §3.5 的装配表均无 history 字段——消费者已定义、生产者未声明。
2. **W1**：D1 声明熔断留痕 recovery-escalated「由 D3 事件登记批补」（D1 §4.3/C5），但 D3 §4.2 发射点表未含 circuit-trip 场景，D8 载荷也无 detail——留痕责任方悬空。
3. **W5**：D2 直写 recover_episodes 后，RecoveryCoordinator 内存缓存（D8 §3.3 观测源、D3 §3.1 new 时装载）不感知——「写方后于读方缓存」的陈旧窗口。
4. **S2**：D2 §3.1 伪代码 `state.circuit_breaker_is_tripped(&active.session_id).await`（D2 §7 归 D1 提供）——D1 文档只定义「闸面=transient_retry 入口检查」与键，未定义 `is_tripped(session_id)` API 形态/落点；同批落地可掩盖，但属「消费者依赖未定义输入」。

---

## 4. 与敲定方案一致性（裁决 #1-#21 逐条）

| 裁决 | 状态 | 说明 |
|---|---|---|
| #1 方案 B | ✓ | D1 §3.1 全篇按方案 B；「A' 增量流重试封装明确不做」D1 §0 |
| #2 750ms | ✓ | D1 §3.1.1 常量镜像，测试锁定 |
| #3 429 放行 5min | ✓ | D1 §3.1.2 规则 R2/R3/R4 |
| #4 完整装配 | ✓ | D3 §3.1 五件套必传，policy.max_retries=2（V3 落地） |
| #5 收口后重派 | ✓ | D3 §3.2.2/§3.2.3；D3 §8 决策 11 澄清「决策在收口前、spawn 在收口后」与裁决字面的关系，合理 |
| #6 熔断语义 | ✓（含 S2 补丁） | D1 §3.2.2 规则 C1-C5；S2 落点三判序与裁决一致 |
| #7 独立键 | ✓ | D1 §3.2.1 |
| #8 指纹含唤醒源 | △ | D2 §1.3/§3.3 落地 fingerprint_with_source 三参（recovery.rs 零改动精确化合理）；**但「restore/goal/timer/cron/user」唤醒源枚举无消费方，D6 §3.3 明言 restore 不消费预算——与裁决 #8 隐含语义张力（W8）** |
| #9 收口 RoundAssessment | ✓ | D5 §3.3，allows_auto_continue 首个生产调用 |
| #10 L0+L1 | ✓ | D5 §3.5；L3 后置、L2 退化计数与裁决一致 |
| #11 工具批指纹 | ✓ | D5 §3.4 |
| #12 watcher 独立先行 | ✓ | D6 §3.2「watcher 不读 goal_state，独立于 D5」；顺序 store→watcher→恢复条目 |
| #13 水合本轮做 | ✓ | D7 §3.6、D8 §3.4 一致 |
| #14 集中一次登记 | ✓ | D8 §3.1（九处+生成产物，较 05「六处」补三处测试面，属修订补充非冲突）；D3/D5 均声明同批 |
| #15 kill_subagent | ✓ | D4 §3.2/§3.3 |
| #16 接管确认 | ✓ | D4 §3.6 |
| #17 core_resume_run P2 | ✓ | D4 §1.3 范围澄清（登记先行 registered=false，有先例），合理 |
| #18 failover 不做 | ✓ | D1 §0-6 |
| #19 history 注入 | △ | D7 §3.4 实现；**引入 RunFailureContext.history 契约扩展需批准（W3）** |
| #20 interrupted 只通知 | ✓ | D6 §3.3（sub-sess-* 分流、父归属解析、不自动 fork）；D3 §7 引用 |
| #21 空转分场景 | △ | D6 §3.5 实现与裁决 goal 分支**逻辑矛盾（W2）** |

**「与敲定冲突」标注质量**：D2 §1.3、D4 §1.3、D7 §1.3 三处冲突声明均给出了理由与先例，标注规范 ✓；D5 §8 决策 3 的「严格一致」自述与 §4.1 形状不符（S1）属文档内部错误而非标注缺失。

---

## 5. 问题清单（按严重程度）

### 阻断级（必须裁决后修订，否则派单/实现直接冲突）

**B1 · 流中断结构化标注文件域双挂（D1 vs D7）**
- D1 §1.1 目标⑤、§3.5 全节、§4.2 字段表、附录文件索引（stream.rs「标注」、consume/mod.rs「标注镜像」、streaming.rs「注入点」、engine.rs「映射」）把标注作为 D1 范围与验收（A9/T18）实现。
- D7 §1.3 范围迁移一裁定「主体改动归 D7，D1 只负责 RunOutcome.provider_error 数据面」，依据是任务书 D7 范围④与 00 总纲 D1 关键文件清单不含 stream/consume。
- 两份文档互为反证，且 00 总纲 §3 D1 行⑤本身含标注项——裁决权在主控。若维持 D7 属主，D1 须删除目标⑤/§3.5/A9/T18（或改写为「消费方声明」），并将 §7 接口表行「流中断标注 | D1→D7」的方向改为 D7→D1/D2/D8。

**B2 · goal-round-completed 事件载荷不一致（D5 vs D8）**
- D5 §3.9：`round / toolCallCount / toolSuccessCount / messageCount / decision / reasonDetail / stalledDelta / evidence`；D5 §4.2：`round / decision / reasonDetail / toolCallCount / toolSuccessCount / stalledRounds / evidence`（D5 内部两处已互相不一致：stalledDelta vs stalledRounds）。
- D8 §3.1.1/§4.1：`round / maxRounds / outcome / progressSignature`（outcome ∈ needs-continuation/no-progress/completed/blocked，对齐 orchestration.ts:62-63）。
- 三方字段集互不相同。事件登记（D8）与发射（D5）必须同批同形状；D5 的 decision/reasonDetail 与 D8 的 outcome 是同一语义的不同表达，需合并为一个字段集（建议以 D5 更细的评估字段为准 + D8 的 outcome 作为该域通用枚举，或反之），并同步 orchestration.ts 对齐口径与 fixture。

### 重要级（需修订/裁决，不解决则实现歧义）

**W1 · 熔断留痕 recovery-escalated 形态与发射责任悬空**
- D1 §3.2.2 C5：熔断达阈值发 runtime-intervention-required + 「recovery-escalated（detail=circuit-trip）留痕，D3 登记时补」；发射落点=D1 壳层收口计数处。
- D8 §3.1.1 recovery-escalated 冻结载荷 = {sessionId, subagentRunId, kind, retries, elapsedMs}（镜像 recovery.rs:941-946，子代理语境），无 detail 字段；D3 §4.2 发射点表仅含 on_subagent_run_failure Escalate 分支。
- 建议：主控裁决二选一——① recovery-escalated 增可选 `detail: Option<String>` 字段（默认 None，subagentRunId 改 Option，兼容子代理侧），熔断侧以 detail="circuit-trip" 发射；② 熔断只发 runtime-intervention-required，删去 recovery-escalated 留痕表述（D1 §4.3/C5 同步改）。

**W2 · D6 空注入轮判定与敲定 #21 矛盾（D6 内部 + 跨维度）**
- D6 §3.5 伪代码 `empty_inject = !queue_pending`，判定分支「empty_inject → 不增不减」。
- goal 续轮（D5 四源，注入=goal 前缀，无队列条目）满足 `!queue_pending` → 被误判为空注入轮不计 streak——与敲定 #21「goal 续轮无 AI 产出计入空转」、D6 §1.2 A6、D6 §5.5 测试 `goal_round_no_output_counts` 直接矛盾（D6 §3.5 声称「goal 前缀注入非空走 else 分支自然计入」不成立：else 分支要求 empty_inject=false）。
- 建议：`empty_inject` 判定改为按唤醒源区分（仅 timer/cron 源且无队列条目才算空注入轮），D5 的 goal 轮与 D2 的 error 分支走计入/独立路径；D6 §3.5 伪代码与测试表述同步修正。

**W3 · RunFailureContext.history 契约扩展未同步到 D3/D4**
- D7 §1.3-3 已自标「需显式批准」，方向正确；但 D3 §3.2.4（11 字段装配表）与 D4 §3.5（prepare_resume）未含 history，D7 §3.4 的数据流 ① 却要求 D3 收口触发点与 resume 路径填充。
- 建议：主控批准扩展后，D3 §3.2.4 装配表补 history 行（数据源 = session_history.get(子代理会话)），D4 §3.5 prepare_resume 补 row.messages→HistoryMessage 转换（约 10 行，D7 §3.4 已估算）；两份文档须在同批修订。

**W4 · EngineHandle::new_with_spawner 同点双改**
- D4 §3.8 段2：增 `local_db: Option<Arc<LocalDb>>`，CoreRunState::new 经 `self.local_db()` 下传。
- D6 §3.1 段2：增 `db: Option<LocalDb>`，经 `store.as_local_db()` 下传。
- 同一构造签名、参数名与类型不一致、下转型路径不同，两份文档未互相引用；若分两批派单必冲突。
- 建议：统一签名（如 `db: Option<LocalDb>`，下转型经 `store.as_local_db()`，恢复.rs:642 先例），D4/D6 修订为同一表述，装配替换合并为一次批。

**W5 · D2 直写 recover_episodes vs coordinator 内存缓存陈旧**
- D2 §3.4 consume_main_episode 经 spawn_blocking 直写 session_meta 键（不经 RecoveryCoordinator）。
- D3 §3.1 coordinator_for 惰性构造后 new 装载一次预算（recovery.rs:855-863），D8 §3.3 recoverEpisodes 数据源 = coordinator 内存态访问器 budget()（recovery.rs:884-886）。
- 后果：主 run error 续 run 消费预算后，D8 观测的 recoverEpisodes 不反映 D2 侧计数（陈旧），重启恢复（from_json 读盘）与内存态存在差异窗口。
- 建议：D2 直写后同步刷新 coordinator 内存态（经 coordinator_for 拿实例，或 D8 侧 recoverEpisodes 改读键直读），三文档统一口径。

**W6 · recovery-budget-denied 双发射方载荷不一致**
- D2 §3.4：`{fingerprint, count, max}`（无 subagentRunId，主 run 语境无此字段）。
- D8 §3.1.1：`sessionId, subagentRunId, fingerprint, count, max`（镜像 recovery.rs:1054-1059）。
- 建议：subagentRunId 改 `Option<String>`（D2 侧 None），D8 载荷表同步标注双发射方语义。

**W7 · recovery-* 事件会话归属与 D8 检索路径未闭环**
- D3 §4.2：recovery-* 经 RecoveryStore::append_event（recovery.rs:635-651「会话级原子取号」）落 events 表；子代理失败的 coordinator 按子代理 run 会话（sub-sess-*）装配（D3 §3.1 按 run 的 session_id 取 coordinator）。
- D8 §3.7.1 失败卡片数据源①=「最近 recovery-escalated 事件（core_read_session_events 检索）」——若检索主会话，读不到子代理会话事件；D8 §3.2 读面合成也未涉及会话域问题。
- 建议：明确 append_event 的 session_id 语义（子代理事件落子会话 or 父会话），D8 前端相应读子会话事件（前端已有 subagent 会话事件消费面）或 D3 侧重定向父会话；验收 A4 补一条会话域断言。

**W8 · 敲定 #8 唤醒源枚举与预算消费面错位**
- 01 §1 #8：唤醒源 ∈ {user, error-retry, timer-\<id\>, cron-\<id\>, restore, goal}。
- 实际消费：仅 D2 error-retry 走 recover_episodes 预算；D5 goal（max_rounds 独立预算）、D6 timer/cron（无预算）、D6 restore（§3.3 明言不消费预算）、user（非恢复路径）均不消费。
- 建议：主控确认「#8 枚举为前瞻设计，预算实际仅 error-retry 域消费」并在 01 或 D2 §3.3 注释加注，消除 restore 源的隐含预算语义张力；D2 §3.3 的 WAKE_SOURCE_RESTORE 常量保留但标注「无消费方」。

**W9 · D4 wait 真适配「单槽」与 16 条声明语义的降级边界**
- D4 §1.3-2/§8 D-2：MemoryWaitStore 保留最近 16 条（DECLARATION_CAP, wait_channel.rs:57-58），真适配以「单声明槽（最新覆盖）」落地，理由是 dispatch_* 为单值键、不引入索引键。
- 对照：D6 §3.1 的 timer/sched 真适配用 `timer_ids`/`sched_ids` 索引键保证可枚举（01 §2.1 已冻结该形态，workflow_commands.rs:403-406 先例）——「不引入索引键」的约束在本方案内部并不一致（dispatch_ids 可仿 timer_ids 冻结，01 §2.1 只是未列）。
- 多声明场景（两个 wait_subagents 批次）重启后仅最新声明恢复，属功能降级；D4 §5 T9/T10 验收断言「完全一致」需以单声明前提限定。
- 建议：主控裁决——维持单槽（在 01 §2.1 补注 dispatch 单槽语义，D4 验收断言加前提）或引入 dispatch_ids 索引键保留多槽（约 +20 行，D4 §8 D-2 理由「键不可枚举」被 timer_ids 先例削弱）。

### 建议级

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| S1 | goal_state 键内部字段命名 snake_case vs camelCase 未统一；D5 §4.1 示例含冻结表外 schemaVersion/updatedAtMs，与 D5 §8 决策 3「严格一致」自述矛盾 | 01 §2.1 vs D5 §4.1/§8 决策 3 | 以 01 §2.1 snake_case 为准（对齐 D1 provider_fail_streak 键惯例），D5 §4.1 修正示例并说明新增字段须主控追认 |
| S2 | `circuit_breaker_is_tripped(session_id)` 为 D2 消费的 D1 提供接口，D1 未定义 API 形态 | D2 §3.1/§7 vs D1 §3.2 | D1 补一段接口定义（签名/落点/注入形态），或 D2 明确为壳层 helper（D2 §8 D2-9 已给方向，落一处即可） |
| S3 | recover_ladder1_max_retries 属 01 §2.1 冻结键表外自决键（D3 §4.1） | D3 §4.1 vs 01 §2.1 | 01 §2.1 补登（含默认 2、V3 关联），维护「数据面形状冻结」权威 |
| S4 | run_restore 成功路径为 D3/D5/D6/D8 四维度插入点汇聚，缺合并批次定义 | D3 §3.3、D5 §3.2、D6 §3.3、D8 §3.3 | 主控派单时定义 run_restore 合并批（建议 D3+D5+D6+D8 同批串行），各文档加注 |
| S5 | D8 未声明消费 D1 提供的 runtime-intervention-required（熔断触发事件） | D1 §7 vs D8 §3.7/§7 | D8 §3.7.1 恢复状态行补一条熔断横幅消费面（或 P2 标注），保持 D1→D8 契约闭环 |
| S6 | D1 C3「run 内重试中成功不清零」与 S2 落点规则 3「正常完成→清零」措辞歧义（run 内重试后正常完成的 run 是否清零） | D1 §3.2.2 C3 vs §3.2.2 落点规则 3 | 以敲定 #6 S2 字面「正常完成→清零」为准，D1 C3 措辞改为「重试成功时刻不清零，收口按正常完成判定」 |
| S7 | D4 §3.5 resume 伪代码 `state.coordinator_for(&session_id).await` 与 D3 §3.1 同步 fn 签名不符 | D4 §3.5 vs D3 §3.1 | 统一为同步调用（coordinator_for 无 await） |
| S8 | 00 §6 契约表 RunFailureContext.retries 语义未区分 run 内（provider_error.retries）与跨 run（ladder-1 计数） | 00 §6 vs D3 §3.2.4/§8 决策 1 | 00 修订时加注双语义，避免实现歧义 |
| S9 | goal-* 事件载荷含 sessionId 与信封顶层 sessionId 重复（D8 §3.1.1）；recovery-* 合成路径需 sessionId 在体内，goal-* envelope 路径不需要 | D8 §3.1.1 vs D5 §4.2 | 统一约定：envelope 事件不列 sessionId 变体字段（读侧信封已含） |
| S10 | D5 RoundAssessment 在子代理 run 收口（:2844-2852 后）也会被调用（子代理会话无 goal_state → NoGoal，语义正确但隐式） | D5 §3.3 | 建议显式 `active.subagent.is_none()` 守卫前置，避免 NoGoal 无谓评估（与 D5 §1.2 A9 一致） |

---

## 6. 调整建议清单（给主控）

| # | 动作 | 对象 | 说明 |
|---|---|---|---|
| R1 | **裁决 B1**：流中断标注属主 | 主控 ↔ D1/D7 | 定属主后 D1 或 D7 删/改对应章节；engine.rs to_loop_event 归属随裁决；D1 A9/T18 或 D7 T9 二选一保留 |
| R2 | **裁决 B2**：goal-round-completed 载荷字段集 | 主控 ↔ D5/D8 | 合并为单一字段集（建议 D5 评估字段 + D8 outcome 枚举统一），同步 orchestration.ts 对齐口径与 fixture；D5 §3.9/§4.2 内部字段表先自洽 |
| R3 | 裁决 W1（recovery-escalated 载荷形态）+ W6（subagentRunId 可选化） | 主控 ↔ D1/D2/D8 | 事件载荷改 Option 或取消留痕，D8 §3.1.1 同步 |
| R4 | 裁决 W2 后修订 D6 §3.5 | D6 | empty_inject 按唤醒源区分；同步 §1.2 A6 与 §5.5 测试表述 |
| R5 | 批准 W3 后同步修订 D3 §3.2.4 / D4 §3.5 | D3/D4 | ctx 装配表补 history；D7 §1.3-3 标注「已批准」 |
| R6 | 统一 W4 构造签名 | D4/D6 | 合并为同一签名与下转型路径，装配替换一次批 |
| R7 | 裁决 W5 观测口径 | D2/D8/D3 | D2 写后刷新 coordinator 内存态，或 D8 读键直读；明确重启恢复口径 |
| R8 | 裁决 W7 事件会话域 | D3/D8 | append_event session_id 语义 + 前端检索路径 + A4 补会话域断言 |
| R9 | 裁决 W8/W9 | 主控 ↔ 01/D6/D4 | #8 枚举前瞻性加注；wait 单槽 vs dispatch_ids 索引键二选一 |
| R10 | 建议级 S1-S10 修订归口 | 各维度 | 其中 S1（goal_state 键命名）与 S3（新键追认）建议随修订轮一次性处理，S4 由主控派单时定义 run_restore 合并批 |

---

## 7. 评审口径说明

- 本评审只读核对 8 份维度文档 + 00/01 两份权威文档，未抽查代码（行号引用以各文档为准，漂移以代码为真源）。
- 未发现维度文档违反 12/5/1、用户停止永不续、子代理只通知不自动 fork 等红线；未发现「声称依赖未定义输入」之外的断链。
- 总体评价：接口契约体系设计质量高（group_id 前缀族、指纹域隔离、同批约束均落地），主要风险集中在**文件域双挂（B1）、事件载荷契约漂移（B2/W6）、同点双改（W4）**三类可裁决可修订的协调问题，无架构性返工风险。

> 本评审为只读分析产出（唯一写面 = 本文件）；未修改任何代码、未执行任何 git 操作。
