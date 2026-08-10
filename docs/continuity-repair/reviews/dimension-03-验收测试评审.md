# 维度评审 03 — 验收断言与测试策略完备性（评审报告）

> 目录：docs/continuity-repair/reviews/
> 日期：2026-08-11
> 评审视角：验收断言可测性、测试策略覆盖、既有测试资产回归面、测试基础设施缺口、跨维度测试协调。
> 评审对象：dimensions/D1-D8 八份维度文档；对照 00-总纲-维度设计.md（§3 最低线 / §5 护栏 / §6 契约）与 01-敲定方案.md（裁决与接线时序）。
> 证据原则：所有结论以代码抽查为真源；行号以核对当日（2026-08-11）仓库 HEAD 为准。

---

## 0. 结论速览

1. **总体合格但有两个硬伤**：8 份维度文档的验收断言绝大多数可测、测试策略覆盖了正常/失败/边界/并发/重启恢复五大路径，红线断言（用户停止不续、12/5/1、嵌套禁令）基本齐备。但存在 **2 个严重问题**：① D4 命令条数断言基于**过时基线**（文档写 102/98，实测 103/99），按文档实施测试必红；② 全部 8 份文档反复引用「recovery.rs 40+ 单测」作回归面，**实测 recovery.rs 内单测标记仅 24 个**，「40+」不可验证。
2. **最大测试基础设施缺口**：D2/D3/D5 的「mock provider 瞬态错误」集成测试依赖壳层可脚本化错误的 mock SSE/HTTP server，**该设施当前不存在**（壳层仅有返回空 200 的 RequestCaptureServer，core_run_commands.rs 测试域 :6271 区域），文档未将其列为交付物。
3. **时钟注入可行但需显式引入**：D1/D2 的退避序列断言依赖 `tokio::time::pause` 类设施，全仓先例仅在 agent-provider retry.rs（4 处），session-loop 与壳层测试域均无先例；D2 更存在「实现侧注入式延迟 vs 测试侧 tokio pause」二选一未锁定的落地风险。
4. 证据要点：所有维度引用关键行号（decide_idle_resume :2505、spawn_idle_resume_run :2637、hydrate 测试 :376、registry_drift :208-213/:501-502/:829-838、normalize.rs:177-179、session.rs:514/545、recovery.rs:205/846/914/1231、useStreamCallbacks.ts:661 等）经抽查**全部属实**，引用纪律良好。

---

## 1. 验收断言可测性核查（逐维度）

| 维度 | 断言数 | 可测性 | 红线断言覆盖 | 发现 |
|---|---|---|---|---|
| D1 | A1-A9 | 高（A1-A6 单测注入分类错误；A8 编译+单测；A9 扩既有测试） | 熔断红线（A5/A6）、用户手动不受限（§3.2.2 C4） | A8 测试命令包名错误（见 P3-1）；A2/A3 数学自洽已核算 |
| D2 | A1-A8 | 高（A1-A3 壳层 mock 收口；T9 退避依赖时钟） | 用户停止/abort 永不续（A3/T4）、熔断期不续（A6/T7） | A1「上下文完整」断言依赖未核证链路（见 P2-4）；**无 12/5/1 说明性断言**（见 P3-4） |
| D3 | A1-A10 | 高（T1-T7 场景编排明确） | 12/5/1（A7）、嵌套禁令（§6）、探索配额（§6） | A1「无 steering 条目」断言写法与双条目共存语义有张力（见 P2-2） |
| D4 | A1-A7 | 高（T1-T10 各断言对应） | 12/5/1（A1/T2）、嵌套（R2）、配额（R3） | **A5/T6 条数断言基线过时（P1-1）** |
| D5 | A1-A10 | 高（U1-U12 纯函数直测） | 用户停止（A10）、轮数上限（A3/A8）、错误收场不续（A4） | I3/I4 终态 reason 断言落点未写清（见 P2-3） |
| D6 | A1-A6 | 高（tick 单测直驱 + 集成） | 用户停止跨 run（§5.2 用例 + user_stopped 决策 1） | A2 与 D4 A4 共享「重启恢复」语义，归属需显式（见 P2-5） |
| D7 | A1-A6 | 高（T1-T9；损坏降级 A2 双侧） | 用户停止不触发自动动作（R9 声明） | 跨重启 checkpoint 水合无集成测试（见 P3-2）；history 注入与 D2 的 history 断言分域但无统一 fixture（见 P2-4） |
| D8 | A1-A7 | 高（登记四测试面 + 前端 vitest） | 无直接红线（只读投影 + 命令消费方，§6 风险 10 声明 12/5/1 不变式） | A5 水合断言与 D7 T5 双写（见 P2-6） |

**红线断言总体评估**：00 总纲 §5 的「用户显式停止永不自动续」（护栏 2）在 D2（A3/T4）、D5（A10）、D6（user_stopped 用例）、D7（R9）均有断言锚点；「12/5/1 只增不减」（护栏 1）在 D3（A7）、D4（A1/T2）有断言；「嵌套禁令」在 D3（§6 表）、D4（R2）有声明。**唯一缺口**：D2 未说明「error 续 run 走主 run idle 通道、不经过 spawn 守卫、不涉及 12/5/1」——该说明性断言缺失可能导致实现时误接 spawn 守卫（见 P3-4）。

---

## 2. 测试策略覆盖核查（正常/失败/边界/并发/重启）

| 路径 | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 |
|---|---|---|---|---|---|---|---|---|
| 正常路径 | T1/T2 重试成功 | T1/T2 自动拉起 | T1 阶梯 1 恢复 | T1 resume 三态 | U1-U3 完成判定 | A1 定时器拉起 | T1/T6 采集→注入 | A1 注册表绿 |
| 失败路径 | T3 预算耗尽 fatal | T3/T12 停续/拉起失败 | T2 阶梯 2/T5 非瞬态 | T4/T5 幂等/未投递 | U9/U10 error 不续 | 子代理只通知 | T3/T4 损坏降级 | A2 检索合成失败跳过 |
| 边界 | T5 熔断闸 6/5、T6 指数上限 62 | T10 预算可配、T7 熔断 | A2 max_retries=2、A3 预算耗尽 | T4 已终态幂等 | U5/U8 stalled/max_rounds | A4 16 条合并 | A2 坏 JSON | A3 空值缺省 |
| 并发 | —（run 内串行天然） | 集成「与 D3 并行」预算读写 | T7 12/5/1 并发满 | T7 不阻塞 worker | 串行守卫声明 | **A5 双拉并发** | R7 同锁互斥声明 | —（只读投影） |
| 重启恢复 | T13 坏 JSON（键面） | 集成「重启持久化」 | T4 重排不重放 | T10 wait 恢复 | I7 断点续接 | A2/A3 fired 幂等 | §3.3 声明跨重启闭环 | —（无跨重启面） |

**结论**：五大路径覆盖基本合格，D6 的并发双拉（A5）、D2/D3 的预算并发读写、D8 的合成 fallback 是亮点。**两个覆盖缺口**：
- **D1 缺「熔断跨重启持续生效」端到端断言**：D1 T9-T14 只覆盖单次收口计数/清零/装配注入，熔断键跨重启不丢（重启后 streak 继续闸下一 run）无对应测试（D2 有预算的「重启持久化」集成，D1 键同理可测）。
- **D7 缺「checkpoint 跨重启水合」集成断言**：D7 §3.3 声称「checkpoint 数据随 SessionRecord 进快照……重启经 run_restore 水合……跨重启闭环」，但 §5 测试列表 T1-T9 无重启环节（T6 是「run 1 收口 → run 2 拉起」的进程内链路，未跨重启）。应补：写叶子 → 快照 → 新实例 run_restore → 拉起 run 2 → prompt 含摘要。

---

## 3. 既有测试资产回归面核查（逐项实测）

| 声称 | 维度引用 | 实测 | 结论 |
|---|---|---|---|
| recovery.rs 40+ 单测 | 00 §5 护栏 13、01 §4 红线 4、D1-D8 全部 | recovery.rs mod tests（:1295 起）`#[test]/#[tokio::test` 标记 **24 个** | **P1-2：与事实不符，不可验证** |
| 4 集成测试（recovery_ladder/multi_agent/kill_all/crash_consistency） | D2/D3/D4/D6/D7/D8 | 文件存在；测试标记数 8/5/12/12 = **37** | 属实（数量与「集成测试」定位吻合） |
| hydrate 既有测试 :376-387（error 态过滤锁定） | D7 §3.6/T5、D8 §2.5/A5 | `incomplete_and_error_status_entries_skipped` 位于 hydrate.rs:376，is_completed :87-93 | 属实；D7/D8 均声明改写，归属需单派（P2-6） |
| registry_drift 硬编码 41 断言三处 | D8 §3.1 逐文件清单 | :208-213、:501-502、:829-838 实测存在；另有 :933-948、:1477 等更多 41 锚点 | 属实；D8 已把「六处」修正为「九处」，**:1471-1496 的事件双面策略断言（41 条 + push 面）未在 D8 清单中显式列出**（轻） |
| events_roundtrip.rs 穷举 41 | D8 | :239-243 all_events() 41 实例 | 属实 |
| event_hook_mapping.rs 41=11+30 | D8 | :163-183 实测 | 属实 |
| command_manifest 条数测试（102=98+4） | D4 A5/T6、D4 §3.1 步骤 2 | **实测 103 = 99 + 4**（command_manifest.rs:233-235 断言 103/99/4；:381 断言 103）——基线已因 multi_device_network_info（R1-09，:222 注释）漂移 | **P1-1：D4 全部条数断言基于过时基线** |
| stream_error.rs Q40 abort 测试 :438-471 | D1 §3.1.6/T8 | `abort_at_transient_level_skips_remaining_ladder` 位于 :463 | 属实 |
| text_then_error_stop_yields_message | D1 A9 / D7 T9 | 位于 **session-loop/src/stream.rs:546**（非 consume/mod.rs:425-434 引用的位置——D1 写「consume/mod.rs:425-434 类」、D7 写「consume/mod.rs:425-434」） | 测试存在；**D7 的引用位置疑似不准确**（consume/mod.rs 是否有同名为：425-434 未核到，需实现时对代码为真源） |
| useStreamCallbacks.ts:661 `?? 5` | D5/D8 | 实测 `maxIterations: liveGm.maxIterations ?? 5` | 属实 |
| normalize.rs:177-179 allows_auto_continue 零生产调用 | D5 | 属实（:521-525 既有测试断言语义与 D5 A4/U10 一致） | 属实 |
| 熔断键/`provider_fail_streak` 全仓无 | D1 §2.5 | grep 仅文档引用 | 属实 |

**回归面核查总结**：除「40+ 单测」与 command_manifest 基线两处硬伤外，各维度对既有测试资产的引用基本准确，且 D1（§5.4）、D2（§5.3）、D3（§5.1）、D4（§5.5）、D5（§5.3）、D6（§5.6）、D7（§5.2）、D8（§5.3）均显式声明了 markdown-editor 门禁与 5 个专项 spec 不受影响，符合 AGENTS.md 测试资产铁律。

---

## 4. 测试基础设施缺口（依赖尚不存在设施的证据）

| # | 缺口 | 依赖维度 | 证据 | 严重度 |
|---|---|---|---|---|
| I1 | **壳层可脚本化瞬态错误的 mock SSE/HTTP server**（能返回 429+Retry-After / 5xx / 发数据后中途断流）：D2「端到端续 run：mock server 每轮 3 次瞬态失败」（§5.2）、D3 T1/T2/T5（§5.3「mock provider 连续瞬态错误」）、D5 I5（provider error 收场）、D1 T16（扩展 attempt_chat_stream 到 workbench）全部依赖 | D1/D2/D3/D5 | 壳层测试域现状仅有 RequestCaptureServer（core_run_commands.rs 测试域 :6271 区域）：接受连接 → 记请求 → 回 `HTTP/1.1 200 OK + SSE 头` 即关闭，**无脚本化错误响应能力**；session-loop 的 TestProvider（testing/mod.rs:84 `with_error`）是另一 crate 的测试件，壳层不可复用；agent-provider tests/retry.rs:25 attempt_chat_stream 属 agent-provider 测试域 | **严重**：不列为交付物则 D2/D3 集成测试无落地手段。D3 §5.3 的「复用既有 mock 装配」表述掩盖了该缺口 |
| I2 | session-loop 测试域 `start_paused` 注入时钟无先例 | D1（T1-T4 全部） | `start_paused` 全仓仅 crates/agent-provider/src/retry.rs:519/588/771/967 四处；session-loop 测试域（stream_error.rs 等）零使用 | 中：tokio 原生能力，采纳即可，但需派单书显式声明 |
| I3 | 壳层 `tokio::time::pause` 无先例 + D2 退避「实现/测试桥梁」未锁定 | D2（A8/T9） | 壳层仅 ws.rs:1971/1998 用过 `tokio::time::pause()`；D2 §3.4 写「时钟注入方式：state 上放可替换的延迟函数（测试注入即时返回或用 tokio pause）」——**二选一未定**，而验收 A8/T9 只写「tokio pause 时钟」。若实现走注入式延迟、测试走 tokio pause，断言与实现脱节 | 中：**验收断言与实现形态之间缺唯一契约**，需在派单书锁死一种 |
| I4 | D1 A8 测试命令包名错误 | D1 | apps/agent-workbench/src-tauri/Cargo.toml `name = "crish-agent-workbench"`；A8 写 `cargo test -p agent-workbench` 会报 package not found | 轻：笔误级，但会直接误导实现轮 |
| I5 | D1 T17（本地 TCP 挂起流）可重复性未设计 | D1 | 断言「keepalive+idle 窗口内以 IdleTimeout/Network 收场而非永久挂起」——真实网络测试在 CI 环境的窗口波动（首字节 30s/idle 60s 量级）未给容错边界；T17 测试写法要点仅一句 | 轻：需给超时窗口参数化（短超时装配）与失败重试策略 |

---

## 5. 问题清单（按严重程度）

### P1 严重（会导致测试必红或断言不可验证）

**P1-1 · D4 命令条数断言基于过时基线（验收断言与现状不符）**
- 证据：D4 §1.2 A5「双端条数断言同步（102→106）」、§3.1 步骤 2「条数测试更新 102→106、注册面 98→101、登记先行 4→5」、§5.2 T6「条数 106/101/5（220-233）」；实测 command_manifest.rs:222-235 断言 **103 总数 / 99 注册面 / 4 登记先行**（multi_device_network_info 于 R1-09 追加，:222 注释「追加后 100→102→103」），:381 `core_list_commands_returns_full_manifest` 断言 103；:63 模块头注释「102 条 = 注册面 98 + 登记先行 4」同样过时。
- 影响：按 D4 实施则 command_manifest 条数测试必红；00 总纲 §3 D8 行与 D4 引用的「102」基线全域失效。
- 修正：**103→107（+4 命令）、99→102、4→5**；front-end commandManifest.test.ts 镜像同步（D4 §3.1 步骤 3 引用同源基线）。

**P1-2 · 「recovery.rs 40+ 单测」回归面声称与实测不符（断言本身含糊）**
- 证据：00 总纲 §5 护栏 13、01 敲定 §4 红线 4、D1-D8 全部文档反复引用「recovery.rs 40+ 单测 + 4 集成测试作回归面」；实测 recovery.rs `mod tests`（:1295 起）测试标记 **24 个**，4 集成文件共 **37 个**（recovery_ladder 8 / multi_agent 5 / kill_all 12 / crash_consistency 12）。
- 影响：「40+」不可验证、与真值不符；作为「测试资产门禁」的表述，数字本身非阻断（测试仍在），但全部 8 份文档基于该数字声明的回归面强度被高估约 40%。
- 修正：统一改为实测口径（如「recovery.rs 24 单测 + 4 集成 37 用例」或仅写「recovery.rs 全部既有单测 + 4 集成测试」不写数字），避免不可验证断言。

### P2 中等（断言/测试可落地但需澄清或补设施）

**P2-1 · 注入时钟在目标测试域无先例 + D2 退避注入方式未锁定（对应 I2/I3）**
- 证据：D1 §1.2 A1-A4 / §5.1 T1-T4 全部依赖 `#[tokio::test(start_paused = true)]` + `advance`；该模式在 session-loop 测试域零先例（仅 agent-provider retry.rs 4 处）。D2 A8/T9 依赖 tokio pause 而 §3.4 又留了「可替换延迟函数」的第二方案，两方案未定一。
- 建议：派单书显式声明（a）session-loop 测试域引入 start_paused（b）D2 实现侧注入式延迟函数 + 测试侧直接驱动（两维度统一选一种），并在 D2 验收中把「等待 ≥750/1500/3000」断言与注入方式绑定写死。

**P2-2 · D3 A1「无 steering 条目」断言写法与双条目共存语义有张力**
- 证据：D3 §1.2 A1 断言「**无 steering 条目**（`recovery-<run_id>` 不在队列）」；但 D3 §3.2.3 明确「escalate 的 steering 条目与 subagent-terminal-<run_id> 共存（02 D2 已裁定保留双条目）」，§4.3 表中 subagent-terminal-<run_id> 由收口五步必然产生。若实现者把 A1 理解为「队列无任何条目」，会误伤既有通知链断言。
- 修正：A1 断言文本改为「队列中无 `recovery-<run_id>` 分组条目（阶梯 2 未触发）；`subagent-terminal-<run_id>` 终态通知允许存在」。

**P2-3 · D5 I3/I4 终态 reason 断言落点未写清**
- 证据：D5 §1.2 A2/A3 与 §5.2 I3/I4 断言「终态 reason=goal-stalled/goal-max-rounds **落库**（is_blocked_reason 命中，restore.rs:812-817）」——但未指明验证哪张表哪个字段；D5 §7 V4 又声明「run 状态机映射不动，reason 仅观测区分」。
- 对照：D3 §5.3 有明确写法「断言原 run end_reason：查 runs 表（runs 表 v5 列，core_run_commands.rs:2932-2936 查询面）」。D5 应引用同一查询面，否则 I3/I4「落库」断言无落点。

**P2-4 · D2 A1「上下文完整」断言依赖未核证链路 + 与 D7 history 分域测试缺统一 fixture**
- 证据：D2 §1.2 A1 断言「新 run 首轮对话含 run 1 的部分产出消息」，机制 = `SessionHistoryCache` 收口缓存（:2718）+ `resolve_history_source`（:1088-1096）Cache 回退分支——该分支既有测试锁定未核证；且注入文本断言用「含『继续任务』」字面（D2 §1.2 A1），模板精确串（D2 §3.4「上一轮 provider 中断（<kind>），继续任务」）未入断言，属「断言本身含糊」。
- 另：D2（idle-resume 路径 history）与 D7（fork 路径 history，§3.4 边界声明「主 run 侧不属本项」）对同一机制（SessionHistoryCache + resolve_history_source）分域断言，无统一测试锚点，存在「都以为对方在测」风险。
- 修正：A1 断言锁定精确模板文本；派单时标注 resolve_history_source Cache 分支既有测试文件（若无则补一条基线单测）；D2/D7 共享的 history 回退链测试归属写清。

**P2-5 · D6 A2 与 D4 A4 共享「重启恢复」语义，store 换装测试代码必改（「同断言不改」表述偏差）**
- 证据：D6 §5.1「`timer_registry_persists_and_recovers` 换真 store **同断言不改**」、sched.rs:1203-1244 同理；但「换 store 注入」本身就是测试代码改动（装配面从 Memory store 换 LocalDbTimerStore），且 MemoryTimerStore 与真适配的 load_all 语义（内存 Vec vs 索引键枚举）若不等价既有断言会红。D6 §5.1 还声明「坏 JSON 跳过不 panic（fail-open）」是**新增**单测。
- 修正：派单书写清「测试代码改装配注入面、断言体不动」边界；新增 LocalDb 索引键往返单测归 D6 交付物（文档已列，需与 D4 T9 的 LocalDbWaitStore 往返测试对齐测试实例构造方式）。

**P2-6 · hydrate 断言改写双维度双写，归属需单派**
- 证据：D7 §5.1 T5「hydrate.rs 测试域（改造 :376-382 断言）」与 D8 §5.1「水合（D7 接线后验收）：hydrate.rs（D7 改，断言本维度提供）」、D8 §3.4 第 5 条「测试改写：incomplete_and_error_status_entries_skipped……新增单独用例 error_status_hydrates_with_failed_turn_marker」——实现与验收职责已声明归 D7/D8 分侧，但「改写既有断言」的实际执行者与命名（新用例名）未单派。
- 修正：hydrate 测试改动（含断言改名与新用例）明确单派 D7 执行、D8 验收复核；避免两个维度各自在测试文件里改同一函数。

**P2-7 · D1 熔断跨重启持续生效无端到端断言（覆盖缺口）**
- 证据：D1 §5.2 T9-T14 覆盖单次收口计数/清零/坏 JSON/装配注入；跨重启场景（重启后 streak 保留、继续闸下一 run）无测试；D2 有「重启持久化」集成（预算），D1 键同型可测。
- 修正：D1 补「streak=6 落库 → 模拟重启 → 新 run 装配读键 → transient_retry 入口被闸」端到端单测（可并入 T14 装配注入链）。

### P3 轻（笔误/提示级）

- **P3-1**：D1 A8 测试命令 `cargo test -p agent-workbench` 包名错误（实为 `crish-agent-workbench`）；D1 §5.3 T17 本地 TCP 挂起流的窗口波动无容错设计（I5）。
- **P3-2**：D7 跨重启 checkpoint 水合无集成测试（§3.3 声称闭环但 §5 无重启用例），建议补「写叶子 → 快照 → 新实例 run_restore → 拉起 → prompt 含摘要」。
- **P3-3**：D7 T9 引用 `consume/mod.rs:425-434`（D1 写「425-434 类」）——实测同名测试在 session-loop/src/stream.rs:546；consume/mod.rs 侧是否有对应测试需实现时以代码为真源核对。
- **P3-4**：D2 缺「error 续 run 不经过 spawn 守卫（主 run idle 通道，subagent_config=None，spawn_idle_resume_run :2660-2661）且嵌套禁令不变」的说明性断言——非测试缺口，但可防实现轮误接守卫（D6 §6 护栏 7 有同类声明，D2 无）。
- **P3-5**：D8 §3.1 清单未显式含 registry_drift.rs:1471-1496「事件双面策略 41 条」与 :888-948 的 cron 编号终态断言群——D8 已把 05 的「六处」扩为「九处」，但这两处 41 锚点若漏改同样 cargo test 红，建议并入清单（D8 §3.1 表第 5 行的「三处 41」实为「五处以上 41」）。
- **P3-6**：D5 I2 断言 mode=goal-continue（§5.2），但 mode 参数化落点在 D2（§3.4 动态决策 D2-6「D2 落地时 mode 参数为一次性改造」）——D5 集成测试对 D2 有隐藏依赖，派单时需标注「D5 I2 在 D2 的 mode 参数化之后执行」。

---

## 6. 测试补强清单（给主控的跨维度协调项）

### 6.1 必须修正（实施前）
| # | 项 | 负责面 |
|---|---|---|
| C1 | command_manifest 条数基线校正：103→107 / 99→102 / 4→5（D4 A5/T6 全部数字 + 前端 commandManifest.test.ts 镜像 + :63 模块头注释） | D4 派单书 |
| C2 | 「recovery.rs 40+ 单测」统一改为实测口径（24 单测 + 4 集成 37 用例），00 总纲 §5 护栏 13、01 敲定 §4 红线 4、D1-D8 全部涉及引用处一并修订 | 主控修订轮 |
| C3 | 壳层可脚本化 mock SSE/HTTP server（响应序列：429+Retry-After / 5xx / 发数据后断流）列为显式交付物，D1（T16 端到端）、D2（端到端续 run）、D3（T1/T2/T5）、D5（I5）共用 | 主控新增任务书条目 |

### 6.2 应澄清（同批修订）
| # | 项 | 负责面 |
|---|---|---|
| C4 | D2 退避时钟策略二选一锁死：实现侧可注入延迟函数 vs 测试侧 tokio pause（D2 §3.4 与 A8/T9 必须一致） | D2 修订 |
| C5 | D3 A1「无 steering 条目」断言改为「无 recovery-<run_id> 分组，subagent-terminal-<run_id> 允许存在」 | D3 修订 |
| C6 | D5 I3/I4 终态断言落点引用 runs 表 end_reason 查询面（D3 §5.3 同款，core_run_commands.rs:2932-2936） | D5 修订 |
| C7 | hydrate 测试改写（改名 + error_status_hydrates_with_failed_turn_marker 新用例）单派 D7，D8 只验收复核 | 主控派单 |
| C8 | D2 A1 注入文本断言锁定精确模板（「上一轮 provider 中断（<kind>），继续任务」），并核证/补 resolve_history_source Cache 分支基线测试 | D2 修订 |

### 6.3 应补强（测试补强）
| # | 项 | 负责面 |
|---|---|---|
| C9 | D1 补「熔断跨重启闸下一 run」端到端单测（streak 落库 → 重启 → 装配闸） | D1 补 |
| C10 | D7 补「checkpoint 跨重启水合」集成测试（写叶子 → 快照 → run_restore → 拉起含摘要） | D7 补 |
| C11 | D8 登记清单补 registry_drift.rs:1471-1496 双面策略 41 锚点（「三处 41」扩为全量枚举） | D8 修订 |
| C12 | D2 补说明性断言：error 续 run 走主 run idle 通道（subagent_config=None），不经过 spawn 守卫、嵌套禁令不变 | D2 补 |
| C13 | D5 派单标注 I2 依赖 D2 的 mode 参数化（接线序：D2 先行，I2 后跑） | 主控派单 |

---

## 7. 评审方法说明与验证记录

- 抽查核实的行号/事实：decide_idle_resume :2505、spawn_idle_resume_run :2637、normalize.rs:177-179（+ 既有测试 :521-525）、hydrate.rs:87/:376、registry_drift.rs:208-213/:501-502/:829-838、events_schema_version.rs:96、event_hook_mapping.rs:163-183、events_roundtrip.rs:239-243、command_manifest.rs:222-235/:381、stream_error.rs:463（abort_at_transient_level）、stream.rs:546（text_then_error_stop_yields_message）、recovery.rs:205/:846/:914/:1231、session.rs:514/:545/:589、timers.rs:458、transport/mod.rs:93（serve_sse）、testing/mod.rs:84（with_error）、useStreamCallbacks.ts:661、wait_channel.rs:58（DECLARATION_CAP=16）、Cargo.toml `name = "crish-agent-workbench"`。
- 本评审为只读分析 + 单文档产出；未修改任何代码、未执行任何 git 操作。

> 产出路径：docs/continuity-repair/reviews/dimension-03-验收测试评审.md
