# PE-06 抽象完善与功能去重方案（Rust 构造体打磨 + 前端去重）

| 项 | 内容 |
|---|---|
| 方案编号 | PE-06 |
| 领域 | 抽象完善与功能去重（23-architecture-hardening-plan.md 的 E6 域落地） |
| 输入事实 | AA-01-rust-core-code-review.md（41 项问题，本域承担 22 项）、AA-03-frontend-state-hooks-review.md（25 项问题，本域承担 18 项） |
| 协作边界 | PE-04 管「日志与传播」，本域管「错误类型本身」（见 §5）；23-hardening E2 域决定 useStreamRenderThrottle 去留 |
| 工作方式 | 只读研究 + 本文档；不修改任何代码 |
| 状态 | 待评审（v2 已按 AU-04 修订） |

## 修订记录

> 版本 **v2**（2026-08-01）· 依据 **AU-04-interface-freeze-decisions.md**（F6/F9/F10、D1/D6/D7/D8/D9/D10、认领表 #1/#11/#12/#13/#16/#19、附录串行表）逐条落实。

| 修订点 | 内容 |
|---|---|
| 锁中毒移交（F10/D1） | **T06.6 删除任务体，改引用 PE-07 T07.6**（安全 DoS 面归属）；本域只保留 Q19（合理 expect 标注保留）与 Q20（测试替身）等非锁项；数字修正：实为 37 处（idempotency 生产 10 + 测试 2、bridge 25 = 22 锁 + 279/334/538 结果 expect、middleware 2），541 为 expect_err 与 538 同 match 对 |
| 错误类型本体全责（D8/D9） | T06.5 接收 PE-04 移交的 DbFailure From（T04.3-1）、StoreError From（T04.3-2）→ 新增 T06.5.7/T06.5.8；Q31 文案（T04.3-5）、Q30 显式工厂（T04.3-6）已并入 T06.5.5/T06.5.4；RecoveryHook::decide 签名按 **F6** 冻结 |
| 启动/回灌主责（D6/D7） | T06.11 Q01 引擎就绪归一主责移 **PE-01 T04.1/T04.2**（本任务仅保留特有部分：E13 删除、遥测订阅收敛）；Q02/Q03 会话三写串行 + hydration 门闩主责移 **PE-01 T04.4**（hydrationComplete 变量由其产出）；组 8（sessionIndexLoader/E3/E12）移交 PE-01 T04.4 |
| T06.11 验收补强（认领表 #19） | 补具体可检查断言：订阅数、merge 串行、门闩时序（对齐 PE-01 T04.x 风格）；补 Q08 folder rebind 任务体（认领表 #11） |
| T06.8 补任务体（#12/#13） | 补 Q17/Q18 消除点（buildPatchAsst/finalizeInFlight 改 streamingStore 缓冲、`as any` 三处消除）与 Q19 useSidebarSessions 范式（useSyncExternalStore 模板，随组 1） |
| 边界移交修正 | §7 Q21/Q33/Q40 移交表述作废 → 改指 **PE-09 T09.9**；Q35「记录不改」作废 → 按 **PE-09 T09.6** 修复（F9 ApprovalGate Arc 化）；补同文件串行声明（tool_exec.rs / streaming.rs / loop/mod.rs / handlers/mod.rs） |
| C17 命名时序 | T06.8 组 2 用旧名 useDaemonState 开发（PE-05 T05.7.2 末轮统一改名，发布/订阅一致性单测归 PE-05） |

## 1. 目标

1. **修复 Q01 阻塞缺陷**：cancel-siblings 在「并行项夹顺序项」混排场景漏标中间顺序项，导致空 id 取消结果与缺失 tool-start/tool-end 事件对，破坏工具事件序列契约（01 §五.6）与前端 tool 卡片完整性。
2. **消除重复实现**：Rust 侧 15+ 项死代码/假功能（abort_reason 只写不读、compression_hook 死配置、payload_recovery 假恢复、to_tool_output 无调用点等）逐一删除或接线；前端 10 组重复 hooks 合并、遥测三份死实现合一、窗口冻结状态机接线。
3. **抽象收敛**：构造体字段评审（删未用字段、补缺省语义、构造器默认值规范化）；错误路径携带结构化错误类型，打通层间错误码（**错误类型本体全责**：接收 PE-04 移交的 DbFailure/StoreError From 与 Q30/Q31，见 T06.5）；跨 store 耦合归位（shell 经 compositionRoot 门面、providerStore 经 api 层）。
4. **锁中毒加固**：~~36 处运行时 `Mutex::lock().expect(...)` 全部改为恢复模式或 Result 传播~~ → **移交 PE-07 T07.6**（AU-04 F10/D1：安全 DoS 面归属 PE-07，实测 37 处）；本域仅保留 Q19（合理 expect 标注保留）与 Q20（测试替身）等非锁项。

## 2. 现状盘点（问题台账）

### 2.1 Rust 侧（AA-01，41 项 → 本域承担 22 项）

| 类别 | 编号 | 处置方向 |
|---|---|---|
| 阻塞缺陷 | Q01 | 修复（T06.1） |
| 配置未接线 | Q03 steering_enabled、Q04 compression_hook、Q14 idempotency | 接线或删除（T06.2 / T06.4.1） |
| 假恢复 | Q05 payload_recovery | 删除阶梯直接 fatal（T06.2） |
| 只写不读 | Q02 abort_reason、Q11 AgentSessionContext.abort_reason | 删除 + 收场透出（T06.3） |
| 死代码 | Q06 safe_point 三函数、Q07 withdraw、Q08 EmitDiagnostic、Q10 to_tool_output、Q12 占位变体、Q13 soft 别名、Q15 session_id 恒空、Q18 RecordingMiddleware、Q20 scripts 空 panic | 删除 / #[cfg(test)] / 接线（T06.3） |
| 锁中毒 | Q16/Q17/Q18 | **移交 PE-07 T07.6**（F10/D1：安全 DoS 面；本域只保留 Q19/Q20 等非锁项） |
| 错误体系 | Q29/Q30/Q31/Q34 | 类型升级（T06.5，本域为唯一类型 owner） |
| 构造体 | SessionLoopOptions/ToolBatchOptions/RunOutcome/AgentSessionLoop | 打磨（T06.4） |
| 不属本域 | Q19 合理 expect（保留）、Q21 abort 轮询、Q22 pending 清理、Q23/Q24/Q25/Q26/Q27/Q28/Q33/Q35-Q41 | 移交 PE-09 / orchestrator 域 / 记录（见 §8 边界） |

### 2.2 前端侧（AA-03，25 项 → 本域承担 18 项）

| 类别 | 编号 | 处置方向 |
|---|---|---|
| 死代码三份并存 | Q04 遥测（telemetryStore / storeTelemetryActions / slices）、Q10 storeTransaction + bootstrapStores 死函数 | 删除（T06.7） |
| hooks 重复 10 组 | AA-03 四章组 1-10 | 合并（T06.8） |
| 未接线状态机 | Q07 WindowResizeBridge | 接线（T06.10） |
| 跨 store 耦合 | Q06 shell 直取 layoutTreeStore、Q05 providerStore 直连 fetch、Q11/Q13 订阅与投影多点 | 归位（T06.9） |
| 启动与回灌 | Q01 初始化四份复制、Q02 sessions 三写、Q03 hydration 门闩、Q08 folder rebind | 主责移 **PE-01 T04.1/T04.2/T04.4**（D6/D7）；本域仅保留特有部分（E13 删除、遥测订阅收敛）；Q08 补任务体（T06.11） |
| 门禁与类型 | Q09/Q18 显式 any、Q25 API 无类型契约、Q17 hooks 直改 store、Q19 useSidebarSessions、Q20-Q24 | 归入对应任务 |
| 不属本域 | Q12 SessionSyncService 主备、Q14 restore 双实现、Q15/Q16 激活路径 | 记录待后续域 |

## 3. 任务分解（T06.x）

### T06.1 Rust 核心缺陷修复：Q01 cancel-siblings 事件序列

#### T06.1.1 根因（crates/session-loop/src/tool_exec.rs）

- `mark_rest_cancelled(calls, results, events, from_idx)`（444-478 行）的跳过条件为 `i <= from_idx || results[i].is_some()`。
- 混排批次 `calls = [P1(并行, 致命), S(顺序), P2(并行)]`：`parallel_group=[0,2]`、`order=[1]`、`sequence=[[0,2],[1]]`。并行组 [0,2] 致命后，179-183 行以 `last_idx = group[group.len()-1] = 2` 调用取消；`i=1` 满足 `1 <= 2` 被跳过——但 index 1 从未执行（`results[1]` 为 None）。
- 后果链：`results[1]` 为 None → 191-194 行 `unwrap_or_else` 回退为 `ClassifiedToolResult::error("", "", Cancelled, "cancelled")`（**空 id、空 tool_name**）→ executing_tools.rs 的 record_message 产出 `tool_call_id=""` 的 tool 消息 → emit_tool_events 缺该调用的 tool-start/tool-end 事件对，违反「tool-batch-start → tool-start → tool-end → tool-batch-end」契约。

#### T06.1.2 修复方案

1. **签名变更**：`mark_rest_cancelled(calls, results, events)`——删除 `from_idx` 参数，语义改为「对全部 `results[i].is_none()` 的项逐一标记取消」。取消范围 = 全部未完成项，与顺序路径语义一致（顺序路径原先靠 `i <= idx` 裁剪，现由 `results[i].is_some()` 天然覆盖，行为等价且修复混排缺陷）。
2. **三处调用点统一**（当前三处复制逻辑）：
   - 顺序路径 118-121 行：`mark_rest_cancelled(calls, &mut results, &mut events)`；
   - 审批退化路径 129-132 行：同上；
   - 并行路径 179-183 行：删除 `let last_idx = group[group.len()-1];`，改无参调用。
   - 三处 break 'outer 逻辑保留。
3. **事件产出对齐**：对每个取消项产出完整事件对（复用现有 454-470 行逻辑，不改动）：
   - `ToolStart { call_id, tool_name, input, category, concurrency, summary }`；
   - `ToolEnd { is_error: true, error_code: "tool.cancelled", error_message: "cancelled: sibling failure", duration_ms: 0, output: null }`；
   - 结果 `ClassifiedToolResult::error(&call.id, &call.tool_name, Cancelled, "cancelled: sibling failure")`——携带真实 id/tool_name，杜绝空 id 回退。
4. **防御性兜底**：191-194 行的 `unwrap_or_else` 保留（此时理论无 None），追加 `debug_assert!(results.iter().all(Option::is_some))` 以便测试期暴露遗漏路径；不回退为 panic（生产保持降级容错）。

#### T06.1.2.1 事件流对照（混排场景，修复前 vs 修复后）

场景：`calls = [P1(failfatal, Parallel), S(echo, Sequential), P2(slow, Parallel)]`，CancelSiblings。

```
修复前（现状）：
  batch-start(3)
  tool-start(P1) … tool-end(P1, error=execution_failed)      ← 并行组 join_all
  tool-start(P2) … tool-end(P2, ok)                          ← 同组完成
  mark_rest_cancelled(from_idx=2)：i=1 被 `1<=2` 跳过
  batch-end
  results 回退：S → Cancelled(id="", tool_name="")           ← 空 id 脏数据
  （S 无任何 tool-start/tool-end 事件对；前端 tool 卡片缺项、tool_call_id=""）

修复后：
  batch-start(3)
  tool-start(P1) … tool-end(P1, error=execution_failed)
  tool-start(P2) … tool-end(P2, ok)
  mark_rest_cancelled()：i=1（results[1] 为 None）→
    tool-start(S, id=c2, name=echo)
    tool-end(S, is_error=true, code=tool.cancelled, "cancelled: sibling failure")
  batch-end
  results：S → Cancelled(id="c2", tool_name="echo")          ← 真实 id
```

一致性要求：顺序路径（111-121）与审批退化路径（124-133）修复后产出的事件流与并行路径完全同构（取消项 = ToolStart→ToolEnd 对 + Cancelled 结果）。

#### T06.1.3 测试（crates/session-loop/src/tool_exec.rs + tests/run_loop.rs）

| 用例 | 断言 |
|---|---|
| 混排 cancel-siblings：`[failfatal(P), echo(S), slow(P)]` | results[1] 为 Cancelled 且 `id=="c2"`、`tool_name=="echo"`；事件流含 index1 的 ToolStart→ToolEnd 对；BatchEnd 收尾 |
| 混排致命在并行组中段：`[slow(P), failfatal(P), echo(S)]` | 并行组 join_all 全完成才判 fatal；echo 被取消且有事件对 |
| 审批退化 + 混排：approval_enabled=true | 同上断言（覆盖退化路径调用点） |
| 事件序列契约：全部取消项 | ToolStart/ToolEnd 成对、位于 BatchStart 与 BatchEnd 之间（01 §五.6） |
| run_loop.rs 端到端 | 取消项对应的 tool 消息 `tool_call_id` 非空、tool-name 正确 |

验收：`cargo test -p session-loop` 全绿；新用例锚定事件契约。

### T06.2 配置项与恢复阶梯：Q03 接线、Q05 假恢复删除、Q04 死钩子删除

#### T06.2.1 Q03 steering_enabled 接线（选择：接线，保留配置语义）

现状：`SessionLoopOptions.steering_enabled`（loop/mod.rs:124,149）默认 true，全 crate 零读取。01 §2.3 承诺「干预性 steering 可配置关闭」。

接线点（三处短路，默认 true 行为不变）：
1. `prepare_turn.rs` 步骤 4（47-67 行）：`if !state.options.steering_enabled { 跳过 AfterTools/BeforeTurn 评估 }`；
2. `steering_evaluation.rs`：`steering_enabled=false` 时 empty-response 不可恢复——在 streaming.rs 的 `ProviderOutput::Empty` 分支（103-107 行）前短路：`if !state.options.steering_enabled { return stop_with_diagnostic("steering 已禁用，空响应无法恢复") }`；
3. `streaming.rs` 的 Empty 分支短路后，steering-evaluation 状态机路径自然不可达（防御性：该 handler 入口同样检查，防止未来新路径进入）。

测试：`steering_enabled=false` 时 empty-response 直接 stop 收场、无注入、无 intervention；prepare_turn 不评估（无 steering 注入消息）。

#### T06.2.2 Q05 payload_recovery 删除（选择：删除无效阶梯，直接 fatal）

现状：stream_error.rs:76-85 对 PayloadTooLarge 只 `payload_recoveries += 1` 后 `NoProgressContinue` 重进 provider 循环——请求体与 max_tokens 完全不变，第二次必然再次 PayloadTooLarge，白耗 2 次请求延迟后 fatal，属「假恢复」。

处置（删除而非接入压缩，理由：压缩能力与 compression_hook 一并删除，见 T06.2.3；未来若落地真实压缩（scrubImagesOldestFirst）另立任务并恢复本阶梯）：
- `stream_error.rs`：`ProviderErrorKind::PayloadTooLarge` 分支从 `payload_recovery(state, &classified)` 改为 `fatal_provider_error(state, &classified)`；删除 `payload_recovery` 函数；
- 删除 `LoopState.payload_recoveries`（handlers/mod.rs:80,111）、`SessionLoopOptions.payload_recovery_limit`（loop/mod.rs:117,146）、`run()` 重置行（loop/mod.rs:279）；
- `fatal_provider_error` 的 runtime-error 事件文案补充说明「payload 过大且无压缩恢复路径，直接终止」；
- 更新 01 §2.5 语义文档（步骤 1 的 MAX_PAYLOAD_IMAGE_RECOVERY 描述同步删除）。

测试：新增「PayloadTooLarge → error 收场（reason=error，无重试）」；删除原 payload 阶梯测试（若有）。

#### T06.2.3 Q04 compression_hook 删除（选择：删除）

现状：`CompressionHook` trait（loop/mod.rs:103-109）与 `SessionLoopOptions.compression_hook` 字段（133,153）存储但从不调用；prepare_turn.rs 步骤 5（69-71 行）仅为注释。

处置：T06.2.2 删除 payload 阶梯后压缩无消费者。删除 `CompressionHook` trait、`compression_hook` 字段与 Default 初始化、prepare_turn.rs 步骤 5 注释块。文档记录「上下文压缩 = 未来任务（需真实压缩实现 + payload 阶梯一并恢复）」。

### T06.3 死代码清理清单（Rust，逐一）

| 编号 | 位置 | 处置 | 具体动作与验证 |
|---|---|---|---|
| Q02 | `LoopState.abort_reason`（handlers/mod.rs:86,114；写点 mod.rs:208、streaming.rs:131、run 重置 mod.rs:282） | 删除字段 + 收场透出 | 删除字段与三处写点；ForceCancel 分支（handlers/mod.rs:206-210）与 streaming_aborted（streaming.rs:130-133）的 reason 改经新 `EndDecision::aborted_with_diagnostic(state, reason)`（EndDecision 增构造器，diagnostic 承载取消原因，随 RunOutcome.diagnostic 透出——见 T06.4.3）；RunOutcome 观测不变且 abort 原因不再丢失 |
| Q06 | safe_point.rs `ControlAction::end_reason`（75-82）、`write_inject_messages`（129-157）、`ring_for_kind`（160-162） | `#[cfg(test)]` | 生产零消费（check_control 内联落环）；标注后 `cargo test -p session-loop` 确认测试仍绿 |
| Q07 | steering/nudge.rs `withdraw` / `withdraw_reason`（235-252） | `#[cfg(test)]` | 仅测试使用（404-417 行测试） |
| Q08 | steering/mod.rs `SteeringAction::EmitDiagnostic` 分支（103-106, 271-280） | **接线**（与 Q32 合并） | coordinator.evaluate 在「超预算跳过 inject-message」（232-234 行）时产出一条 `EmitDiagnostic { reason: "steering-budget-exhausted", diagnostic: {…预算与计数}}` 动作——apply 分支（271-280 行）已完整实现，此举同时复活 Q08 死分支与修复 Q32 静默跳过；行为面 = 预算耗尽时多一条 runtime-steering 诊断事件（前端未消费事件可透传，03 §1） |
| Q09 | steering/diagnostics.rs `SelfTerminationDiagnostic`（23 行） | 保留 + `#[doc(hidden)]` | 文档承诺字段结构保留（D2）；仅测试消费（divergence.rs:265），显式标注防误用 |
| Q10 | tool_events.rs `ClassifiedToolResult::to_tool_output`（189-201） | 删除 | 零调用点；翻译层用 tool_output_from_result / tool_output_from_parts 内联实现；删除后连带删除私有 `error_code` 函数（205-216，ToolErrorKind::error_code 已存在同义实现） |
| Q11 | conex-types/session.rs `AgentSessionContext.abort_reason`（130,143） | 删除 | 初始化后无任何读写（恒 None）；与 LoopState 自持字段重复；注意 serde skip_serializing_if 契约同步（03-frontend-contract 无此字段消费，审计证实） |
| Q12 | steering/mod.rs `SteeringPhase::BeforeTurn` / `AfterCompaction`（54,56） | 保留 + 文档标注 | BeforeTurn 有评估点（prepare_turn 步骤 4 遍历）但无策略注册；AfterCompaction 无评估点；为 TS 类型全集占位 + serde 契约，删除收益低，仅补注释「占位变体，无策略消费」 |
| Q13 | input.rs `enqueue_soft`/`drain_soft`/`has_soft_pending`（139-141,169-171,231-233）、control.rs `request_soft_inject`（222-235） | 删除 | 均为 soft 兼容别名、仅测试使用；测试改用 steer 命名；`InputEnqueueMode::Soft` 变体先 grep 确认零生产消费再一并删除（枚举序列化契约无对外面） |
| Q14 | tool_exec.rs `ToolExecutor.idempotency` 恒 None（52,60-71）；executor.rs policy.idempotency 恒 true 但 guard 恒 None | **接线**（T06.4.1） | SessionLoopOptions 新增 `idempotency_enabled`（默认 false，行为不变）；开启时 AgentSessionLoop 创建 `ToolIdempotencyGuard` 并 `with_idempotency` 注入；幂等语义（失败不记录、成功落键、snapshotTag 键）已有完整测试，接线后真实可达 |
| Q15 | orchestrator/steering_queue.rs `SteeringInputEntry.session_id`（49,67,227） | 删除 | 所有生产构造路径均写空串（user/steering/drain_nudges）；删除字段与三处初始化 |
| Q18 | agent-tools/src/middleware.rs `RecordingMiddleware`（139,157） | 删除或 `#[cfg(test)]` | 先 grep 生产引用；零引用则整体移入测试模块（**锁 expect 移交 PE-07 T07.6**，F10；本项只处置 RecordingMiddleware 本身） |
| Q20 | session-loop/testing/mod.rs `with_scripts(vec![])` 后 `stream()` 触发 `.last().expect`（148） | 构造期校验 | 测试替身：构造/脚本注册时断言非空（或 stream 前显式错误），消除延迟 panic（F10：测试替身项归本域） |
| Q19 | agent-provider/sse/frame.rs `from_utf8(...).expect`（122,131） | 保留 | 前置 from_utf8 校验保证安全，属合理使用（AA-01 正面记录）；**F10：本域保留项**，在文档标注「预期保留」防误删 |

删除通用纪律（沿用 23-hardening 执行规则）：每项删除前 `rg` 全仓确认零消费；无法判定的记为「待确认」不擅自删。

### T06.4 Rust 构造体打磨

#### T06.4.1 SessionLoopOptions 字段评审清单（crates/session-loop/src/loop/mod.rs:112-158）

| 字段 | 处置 | 理由 |
|---|---|---|
| `transient_retry_limit`（默认 3） | 保留 | 活配置 |
| `payload_recovery_limit`（默认 2） | **删除** | T06.2.2 |
| `length_upgrade_limit`（默认 2） | 保留 | 活配置 |
| `continue_nudge_limit`（默认 1） | 保留 | 活配置 |
| `steering_enabled`（默认 true） | 保留并接线 | T06.2.1 |
| `turn_end_hook` | 保留 | 01 遗留问题 3 的主钩子 |
| `should_stop_after_turn` | 保留（评审项：确认生产注入方） | turn_complete.rs:99-102 有真实消费点（兼容层）；若生产零注入则在文档标注「兼容层仅测试用」并可移出公共面 |
| `recovery_hook` | 保留 | catch 兜底裁决 |
| `compression_hook` | **删除** | T06.2.3 |
| `cwd` | 保留 | 透传 ToolExecCtx |
| `assistant_client_message_id` | 保留 | 03 §5.3-4 前端消息幂等键 |
| `idempotency_enabled`（**新增**，默认 false） | **新增** | T06.3 Q14 接线；文档注明开启后同域同参工具去重、与 run/session 域绑定 |
| （可评）`output_budget_bytes` | **移入 ToolBatchOptions** | 输出预算属工具批执行配置（T06.4.2），不在循环配置面 |

#### T06.4.2 ToolBatchOptions 字段评审清单（crates/session-loop/src/tool_events.rs:219-237）

| 字段 | 处置 | 理由 |
|---|---|---|
| `timeout`（默认 60s） | 保留 | 活配置 |
| `fail_strategy` | 保留 | 活配置 |
| `approval_enabled` | 保留 | 活配置 |
| `output_budget_bytes: Option<usize>`（**新增**，默认 None） | **新增** | execute_single 中 `ToolExecutionPolicy.output_budget_bytes` 硬编码 None（tool_exec.rs:355）；补缺省使输出预算可配置，与 executor.rs 现有 summarize 截断语义接通；默认 None 行为不变 |

#### T06.4.3 EndDecision / RunOutcome 字段评审清单（crates/session-loop/src/loop/end.rs）

| 字段 | 处置 | 理由 |
|---|---|---|
| `reason` | 保留 | 收场唯一原因 |
| `error: Option<String>` | **升级**为 `Option<CrishError>` | T06.5 错误路径收敛；序列化时经 CrishErrorPayload，前端错误展示从纯文本变结构化（03-frontend-contract 同步） |
| `diagnostic` | 保留 | 非错误收场的可观测信息；承接 T06.3 Q02 的 abort 原因透出 |
| `turn_index` / `tool_call_count` / `steering_count` | 保留 | 观测字段 |
| 构造器 | 收敛 | 增 `aborted_with_diagnostic(state, reason)`（Q02 用）；其余构造器语义不变 |
| `RunOutcome.error` | 同步升级 | 与 EndDecision 同型 |
| `RunOutcome.messages` / `events` | 保留 | 全量回传（orchestrator 落库与前端事件流消费） |

#### T06.4.4 AgentSessionLoop 构造器默认值规范化（crates/session-loop/src/loop/mod.rs:184-241）

现状问题：
- 默认值分散两处：`new()` 内联（options=Default、RecoverySteeringStrategy::default()、默认预算、ToolBatchOptions::default()、cwd=None、approval=None）与 `SessionLoopOptions::default()`；
- `with_options` 只把 `options.cwd` 同步到 `tool_ctx`（226-227 行），`idempotency_enabled` 等派生状态不同步；
- `with_tool_options` 与 `with_options` 互不联动（cwd 冲突时以 with_options 后写为准，无文档）。

规范化方案：
1. `with_options` 内统一派生状态同步：`cwd → tool_ctx.cwd`；`idempotency_enabled=true` 时创建 `ToolIdempotencyGuard::new()` 并以 `with_idempotency` 重建 `tool_executor`（false 时移除）；
2. 文档化 builder 顺序约束：`with_options` / `with_tool_options` / `with_approval` 必须在 `run()` 之前调用（Rust builder 语义，Option 字段构造期定）；
3. 测试：构造器默认值断言（现有测试补 idempotency 开关、cwd 联动两条）；
4. `new()` 签名保持（session_id, run_id, max_turns, provider, tool_registry）——外部编排层（B4/B6）已按此契约消费，不改公共签名。

#### T06.4.5 AgentTool / Provider 相关结构字段评审

范围与分级（agent-tools / agent-provider 未在 AA-01 全文精读范围，本轮以评审记录为主；**锁项移交 PE-07 T07.6**（F10），本域仅 Q19/Q20 标注保留与测试替身处置）：

| 结构 | 位置 | 评审项 |
|---|---|---|
| `Tool` trait（对齐 TS AgentTool 执行面） | agent-tools/src/definition.rs:133 | 字段/方法契约以 05 §5.x 为准；`name/definition/execute` 三件套保留；输出预算与幂等标记已由 executor 层承载，不在 trait 上扩张 |
| `ToolDefinition` | agent-tools/src/definition.rs | `dangerous`/`fatal_on_error` 字段与 tool_exec.rs `result_is_fatal` 联动正确（Q01 修复后复核取消路径不误判致命） |
| `ProviderConfig` | agent-provider/src/config.rs:95 | 逐字段 grep 消费方形成清单；本轮不改（标记「待 PE-05 provider 域评审」），仅记录观察：api_key 解析/加密路径与 AA-05 安全域重叠 |
| `ProviderUsage` | agent-provider/src/events.rs:33 | 与前端 tokenUsage 投影（layoutStore 遥测字段）对齐评审；前端侧已由 T06.7 收敛 |

### T06.5 错误路径收敛（本域为错误类型唯一 owner，PE-04 仅消费）

#### 5.1 边界划分（关键：避免重叠；AU-04 D8/D9 后本域为错误类型唯一 owner）

| 维度 | PE-06（本域，错误类型本体全责） | PE-04（仅日志与传播消费） |
|---|---|---|
| 类型 | LoopError / EndDecision.error / RunOutcome.error / AgentEnd 事件 error 字段的类型与结构；DbFailure/StoreError → CrishError 的 From（接收 PE-04 移交的 T04.3-1/T04.3-2） | 不定义类型，只消费 PE-06 升级后的类型（发射点日志带码、前端 payload.code 解析） |
| 映射 | 错误码分类（transient/permanent/security）、From 实现（DbFailure/StoreError，T06.5.7/5.8）、层间传递、收场语义（Q29/Q30/Q31/Q34）；core_error_code 映射配合 PE-03 T03.3 动作 1 | 日志输出（tracing/instrument、span 注入 sessionId/runId）、发射点日志分级、前端日志统一与诊断面板 |
| 可观测性 | 错误数据本身的内容与结构（码/分类/上下文） | 错误数据如何被记录与展示 |
| 交集处理 | 本域定义「错误对象」后，PE-04 不得再定义第二个错误形状；PE-04 的日志字段（如 span 内的 error）直接引用本域类型 | 若 PE-04 发现错误类型缺失字段，反提需求到本域，不自行打补丁 |

#### 5.2 具体任务

| 任务 | 内容 | 验收 |
|---|---|---|
| T06.5.1 LoopError 结构化 | `LoopError { message: String }`（loop/mod.rs:49-63）升级为携带 `CrishError`（conex-types 77 码注册表）；`LoopError::internal` 改为显式码构造；所有 `map_err` 兜底保留原始结构化信息（handlers/mod.rs:138-143 不再丢 TransitionError 上下文） | crate 内无裸 String 错误兜底 |
| T06.5.2 收口类型升级 | EndDecision.error / RunOutcome.error / AgentEnd 事件 error 字段：`Option<String>` → `Option<CrishError>`（IPC 序列化走 CrishErrorPayload）；converge（loop/mod.rs:416-436）同步 | 前端可拿到错误码 + category + retryable + cause 链 |
| T06.5.3 RecoveryHook 签名 | **按 F6 冻结（v1）**：`decide(&self, error: &CrishError, state: AgentSessionState) -> RecoveryDecision`（loop/mod.rs:100）；缺省实现保留（abort 信号 → Abort，否则 error 收场）；本任务为唯一实现方，PE-04 仅消费（调用点传 `&err`，不改签名） | 恢复钩子基于码分类裁决而非文本 |
| T06.5.4 Q30 | 删除 `From<CoreError> for CrishError` 的 `InvalidInput → common.unsupported` 兜底映射（conex-types/src/error.rs:985-989），改显式工厂函数（调用方按码表选码，`from_core_error_with_context`）；确认 IPC 边界 from_unknown 仍兜底；**core_error_code 映射配合 PE-03 T03.3 动作 1（D8 双边界）** | 无语义存疑的隐式映射 |
| T06.5.5 Q31 | 兜底错误文案「run 失败」携带状态机状态与事件类型（turn_complete.rs:54、orchestrator/events.rs:326）——**承接 PE-04 T04.3-5（已移交）** | 人读信息可定位 |
| T06.5.6 Q34 | while 退出未收敛防御路径（loop/mod.rs:314-320）改显式 internal error 收场（携带状态机状态），不再读初始 end_reason | 防御路径信息量充足 |
| T06.5.7 DbFailure 结构化 + From（承接 PE-04 T04.3-1） | 文件：`crates/conex-db/src/lib.rs`。新增 `pub enum DbFailureKind { Lock, Corrupt, Io, Schema, NotFound, Capacity, Other }`（从 rusqlite Error / io 场景分流）；`kind` 迁移为 `DbFailureKind` + `as_str()` 兼容（破坏面 error_bridge.rs:72 `kind_str.contains("corrupt")`、orchestrator persist.rs:124 同步改，正是去魔法字符串目标）；`impl From<DbFailure> for CrishError` 映射表——Lock→store.write_failed(Transient,retryable)、Corrupt→store.corrupted(Permanent)、Io→store.write_failed(Transient)、Schema→store.read_failed 或 event_store.read_failed、NotFound→store.read_failed、Capacity→store.capacity_exceeded(Permanent)、Other→store.write_failed(Transient) | `cargo test -p conex-db` 全绿；全仓 grep `contains("corrupt")` 无残留 |
| T06.5.8 StoreError 下沉 + From（承接 PE-04 T04.3-2） | 文件：`crates/orchestrator/src/persist.rs`。保留 `StoreError { kind, message }`（内部兼容），新增 `impl From<StoreError> for CrishError` 与 `to_crish()`；映射表——`lock`→store.write_failed(Transient,retryable)、`append_event`/`insert_run`/`update_run_status`/`serialize_event`→event_store.append_failed、`query_events`/`query_runs`/`load_pending_inputs`→event_store.read_failed、`save_pending_input`/`delete_pending_input`→store.write_failed、未知 kind→store.write_failed 兜底（原 kind 入 metadata.kind 不丢失）；`From<StoreError> for RestoreError` 保持 | `cargo test -p orchestrator` 全绿；映射表逐条断言；未知 kind 兜底不 panic |
| P2 关联评审 | Q26 终态映射收敛（run.rs MaxTurns→Failed vs normalize.rs MaxTurns→Completed 两套语义冲突）：收敛单一权威映射 + 互引一致性测试；Q25 两条失败路径序列语义统一 | 单映射函数 + 双锚测试 |

执行顺序注记（AU-04）：T06.5 为错误类型**唯一 owner**，须领先 PE-04 落地（PE-04 已按 AU-04 修订为只保留日志/传播消费，依赖本域类型基线）；PE-04 的 T04.3-1/2/5/6 已改为引用本域任务，不重复实现。

### T06.6 锁中毒加固（已删除，改引用 PE-07 T07.6，F10/D1）

> **修订（AU-04 F10/D1）**：锁中毒修复按「安全相关 vs 通用」归属边界划归 **PE-07 T07.6**（唯一执行者）——外部回调/MCP server 可触发持锁 panic = DoS，属安全面。本任务**删除任务体**，PE-06 只保留以下非锁项：
> - **Q19**（agent-provider/sse/frame.rs `from_utf8(...).expect` 122/131）：合理 expect 保留，标注「预期保留」（见 T06.3）；
> - **Q20**（session-loop/testing/mod.rs:148 测试替身）：构造期校验，消除延迟 panic（见 T06.3）。
>
> **清单数字修正（以 F10 rg 实测为准，2026-08-01）**：agent-tools 三文件 `.expect(` 实为 **37 处**——idempotency.rs 12（生产 10 + 测试 2）、mcp/bridge.rs 25（**22 锁 + 结果 expect 3 处：279/334/538**，541 行为 `expect_err` 与 538 同一 match 样板对，不作独立行号）、middleware.rs 2。原「36 处」与 bridge「25 锁 + 2 结果」两处表述作废；逐位置清单（6.1.1）与 A/B/C 三级修复策略（6.2）整体随任务体移交 PE-07 T07.6 执行。
>
> **验收归属**：`rg "\.expect\(" crates/agent-tools/src` 仅剩测试与 Q19 保留项；中毒单测 A/B/C 三级（PE-07 T07.6 用例 1-3）通过——均由 PE-07 判定。

### T06.7 前端死文件清理（遥测三份合一 + 其它）

#### 7.1 遥测三份合一（AA-03 Q04，重要）

| 文件 | 处置 | 说明 |
|---|---|---|
| store/telemetryStore.ts（128 行） | **删除** | 全仓 0 import（审计引用计数证实）；与 layoutStore 遥测字段完全重叠；appSettings 类型 `Record<string, unknown>` 与 layoutStore `Settings \| null` 不一致（死文件不受类型门禁约束，已腐烂） |
| store/storeTelemetryActions.ts | **删除** | 0 import；`createTelemetryActions` 与活实现 layout-core-actions.ts:118-173,218-260 逐行相同 |
| store/slices/{ui,terminal,permission,diff}-slice.ts（4 文件） | **删除** | 0 import 死文件 |
| store/layout-helpers/layout-core-actions.ts | 保留 | 唯一活实现（syncTelemetryData/killWorker/triggerCronJobNow） |

迁移点：无（0 import，审计已证）；删除后运行 `check:store-types` + 全仓 grep 零残留确认。

#### 7.2 其它死文件清单

| 文件 | 处置 | 说明 |
|---|---|---|
| store/storeTransaction.ts | 删除 | 0 import；活实现为 api/store-access/storeAccessCore.ts:101-206（浅 clone 语义）——同名双实现极易误用 |
| store/bootstrapStores.ts 死函数（syncLayoutToSession 等 6 个 + batchRollback） | 删除 | 注释自认「no inter-store subscribe sync required」；仅保留 initStoreAccess + 频率日志 |
| app/useEngineBootstrap.ts | 删除 | 死代码（仅测试引用）；引擎就绪归一（T06.11） |
| hooks/useWindowControls.ts | 删除 | 生产 0 消费方；AppBootstrap.winCtl 为唯一实现（其测试迁移到 winCtl） |
| hooks/useStreamRenderThrottle.ts | **待 E2 域裁决** | 23-hardening E2.3 计划将其接入增量渲染；若 E2 落地则保留，否则删除——本域不擅断 |
| hooks/useVirtualDiffScroll.ts | 删除 | useVirtualScroll 为唯一实现（Q23） |
| components/workspace/useWorkspaceResize.ts | 删除 | 自注已废弃 |
| store/sessionIndexLoader.ts | 删除 | 并入 E3 回灌编排（**主责 PE-01 T04.4**，D7） |
| 门禁扩展 | 修改 | check-no-as-any-store 覆盖 layout-helpers/、workspace-shell/、hooks/（Q09/Q18） |

### T06.8 前端 hooks 去重（AA-03 四章 10 组）

| 组 | 文件 | 保留实现 | 删除项 | 迁移点清单 |
|---|---|---|---|---|
| 1 会话激活/打开 tab | workspaceShellStore.openOrFocusSession；useSlashSend.ts:132-145,393-395；store-persistence.ts:231-263；editing-keys.ts:30-35 | workspaceShellStore.openOrFocusSession + session facade 命名 action（`compositionRoot.session`） | useSlashSend 内直连 `setActiveSessionId` 分支（:393-395）；回灌后直激活（store-persistence:231-263） | useSlashSend.ts 改经 shell.openOrFocusSession；store-persistence 回灌改经 session.openOrFocusSession（shell 决定建 tab/绑 leaf）；editing-keys 保持经 shell |
| 2 引擎/连接就绪 | AppBootstrap section 7；ConnectionManager.connect；useDaemonState.ts:123-148 | ConnectionManager 单一投影（onStateChange）+ useEngineState | useEngineBootstrap.ts（死）；AppBootstrap section 3（:147-154）；bootstrap-full.ts:7-9 重复探测 | AppBootstrap.ts 合并 section3→7；useDaemonState 改消费 ConnectionManager；bootstrap-full 删除重复 ensureDaemonConnected。**C17 时序（AU-04）**：本组在本轮次内继续用旧名 `useDaemonState` 开发（含 PE-01 T04.3），`useEngineState` 改名由 **PE-05 T05.7.2 末轮统一**执行 |
| 3 拖拽控制器 | useTreeDrag.ts；useToolDockTabDrag.ts；useTabDrag.ts + tab-drag/* | 抽公共 pointer-drag 基座（DRAG_THRESHOLD_PX/GHOST_OFFSET_X/Y/DROP_DETECT_INTERVAL_MS 常量收敛、phase 状态机、pointerId 隔离、ghost 跟随、监听注册统一） | 三套的重复样板 | 三套 hook 改消费基座，仅保留 drop 语义差异层；常量单源 |
| 4 resize/sash | useColumnResize.ts；useTreeResize.ts | 抽公共 sash 手势基座 | components/workspace/useWorkspaceResize.ts（自注废弃） | 两个消费方改基座；删除废弃文件 |
| 5 虚拟滚动 | useVirtualScroll.ts；useVirtualDiffScroll.ts | useVirtualScroll（支持「仅高度同步」模式） | useVirtualDiffScroll.ts | diff 滚动消费方改 useVirtualScroll（或高度同步模式） |
| 6 窗口控制 | useWindowControls.ts（死）；AppBootstrap.winCtl | AppBootstrap.winCtl | useWindowControls.ts | 其测试（desktopNativeFeatures.test.ts:265）迁移到 winCtl 单例 |
| 7 toast 通道 | useToastQueue.ts；services/ToastBus.ts（'toast:show'）；TelemetryService debug | useToastQueue 为主通道（timers Map 清理规范）；ToastBus 单例降为底层实现 | ToastBus 独立通道（pickWorkspaceFolder.ts:16、UndoRedoService.ts:15 改经 useToastQueue 或单一 bus 直调） | 两个消费方改造；TelemetryService debug 移除 |
| 8 会话回灌 | initStorePersistence（store-persistence.ts）；sessionIndexLoader.ts；sessionDaemonSync（E12） | 单一回灌编排 + 串行化（E3 完成前 E12 不 merge） | sessionIndexLoader.ts | **移交 PE-01 T04.4 执行（D7）**：sessionIndexLoader 删除、E3/E12 串行、waitForHydration 接线均以 PE-01 T04.4 为主责（hydrationComplete 变量由其产出）；本域不重复实现 |
| 9 遥测 actions | layout-core-actions.ts（活）；storeTelemetryActions.ts（死）；telemetryStore.ts（死） | layout-core-actions.ts | 两份死实现 + slices 4 文件 | 见 T06.7.1（0 import，无迁移） |
| 10 窗口缩放冻结 | AppBootstrap E13 手动 class；WindowResizeBridge.ts（未接线）；layoutAnimationStore window-resizing | WindowResizeBridge（经 begin/endLayoutInteraction） | AppBootstrap E13 手动 classList 逻辑 | 见 T06.10 |

#### 8.1 消除点任务体（认领表 #12/#13 补充，AU-04）

- **Q17 消除点**（`streamingStore` 缓冲化）：`buildPatchAsst` / `finalizeInFlight` 由「直改 store」改为经 `streamingStore` 缓冲后统一提交（命名 action），消除跨 store 直写；验收：这两条路径下 store 状态变更可经单一 action 追溯，vitest 断言变更前后投影一致。
- **Q18 `as any` 三处消除**：`layout-helpers/`、`workspace-shell/`、`hooks/` 三处 `as any` 改类型守卫/zod 推断（配合 T06.7 门禁扩展行：`check-no-as-any-store` 覆盖后三处零残留）；验收：门禁扩展落地后 `rg "as any"` 上述目录零命中。
- **Q19 useSidebarSessions 范式**：改为 `useSyncExternalStore` 模板（订阅单一 store 快照，消除手动订阅/投影样板），**随组 1 迁移**（sideBarSessions 投影面与组 1 会话激活共用）；验收：消费方行为不变，单测绿。

### T06.9 跨 store 耦合修复

#### 9.1 shell 直取 layoutTreeStore（AA-03 Q06）

- workspaceShellStore.ts 6 处直连（85/99/121/150-157/514 行 `useLayoutTreeStore.getState()`）统一改经 compositionRoot.tree 门面——layoutRestorePolicy.ts:178 与 treePanelAccess.ts 已示范该模式；compositionRoot 暴露 `tree` 命名空间（getState 快照 + 命令式方法），阻断 shell 模块对 store 的直接 import 环；
- 模块级永久订阅 L610-624（syncShellDocksFromTree 反向投影）改为显式生命周期：bootstrapServices 注册、cleanup 退订；同时加投影抑制标志，消除 shell↔tree 双向投影回环（applyDockToTree ↔ syncShellDocksFromTree 互触发）；
- 其它模块级订阅同步处理：layoutAnimationStore.ts:354-358（ResizeObserverManager，bootstrap 生命周期）、layoutStore.ts:330（__storeUpdateCount 计数订阅移入 DEV 分支）、sessionStore.ts:283（registerActiveIdResolver 补注销）。

#### 9.2 providerStore 直连 fetch 归位（AA-03 Q05）

- 新增 `api/accountStatusApi.ts`：`refreshAccountStatus(id): Promise<AccountStatus>`，复用 transport/clientApi 模式（超时/错误归一），返回类型化 AccountStatus（含 zod/类型守卫，同步满足 Q25）；
- providerStore.refreshAccountStatus（providerStore.ts:105）改调 api 层，删除裸 `fetch('/api/accounts/${id}/status')`；`data` 类型化消费；
- 验收：全仓 grep `fetch('/api/` 仅剩 transport 层。

### T06.10 窗口缩放冻结接线（AA-03 Q07，选择：接线保留能力）

1. bootstrap-services.ts（E5 段）增加 `WindowResizeBridge.getInstance().connect()`（connect 幂等，StrictMode 双执行安全）；
2. 删除 AppBootstrap E13 手动 `body.classList.add/remove('window-resizing')`（100ms debounce，不进 store）——layoutAnimationStore 的 TYPE_BODY_CLASSES 成为唯一接管者（其 watchdog 30s force-end 已防永久冻结）；
3. 测试：保留 WindowResizeBridge 现有单测；补 bootstrap 集成断言（connect 幂等、disconnect 清理、冻结进出与 class 一致性）；
4. 风险提示：`is-layout-frozen` 首次在生产生效——拖拽/窗口缩放期间布局冻结行为变化（见 §7）。

### T06.11 启动链路与回灌收敛（AA-03 Q01/Q02/Q03/Q08，协作任务，主责移交 PE-01）

> 修订（AU-04 D6/D7）：启动就绪归一（Q01）与回灌收敛（Q02/Q03）**主责为 PE-01 T04.1/T04.2/T04.4**（hydrationComplete 变量由 PE-01 T04.4 产出，声明为公共门闩供 PE-08 等消费）；本任务**只保留特有部分并引用**，不重复实现。

| 任务 | 主责 | 本域特有部分 / 引用 |
|---|---|---|
| Q01 引擎初始化归一 | **PE-01 T04.1/T04.2**（AppBootstrap section 3+7 合并、gateTimer 去重、ensureDaemonConnected 幂等化、useEngineBootstrap 删除） | 本域仅保留**遥测订阅收敛**（随 T06.7.1 的 layout-core-actions 单实现）；E13（手动 resize class）删除归 T06.10 |
| Q02 会话三写串行 | **PE-01 T04.4**（E3/E12 串行编排、sessionIndexLoader 删除、350ms persist 空数组擦库守卫——AA-07 P02 联动） | 本域引用 PE-01 T04.4 语义；`waitForHydration` 门闩变量归 PE-01 产出 |
| Q03 hydration 门闩 | **PE-01 T04.4**（hydrateWorkspaceShell 前 `await waitForHydration()`，store-persistence.ts:71-86 已导出，与 waitLayoutTreeHydration 并行等待） | 本域消费门闩变量，不重复产出 |
| Q08 folder rebind 任务体（认领表 #11 补） | 本域（T06.11 补任务体） | 收敛为经**命名 action**（foldRebind 系列进 workspaceShellStore/sessionStore 的既有 action 面），杜绝 immer 直写：folder rebind 状态变更统一走 action + 投影刷新；验收：vitest 断言 rebind 前后 store 快照经 action 单路径变更、订阅投影一致，无裸 `setState` 直写残留 |

**验收断言（认领表 #19 补强，对齐 PE-01 T04.x 风格）**：
1. **订阅数**：AppBootstrap 就绪链路在 StrictMode 双执行下订阅/退订配平——集成测试断言连接状态订阅者数量不变（双执行前后各快照一次，相等且 cleanup 后可回到基线）；Q04 遥测订阅收敛后 `layoutStore` 遥测订阅仅 1 个活动订阅（`check:store-types` + 运行时计数断言）。
2. **merge 串行**：E3（SQLite 回灌）与 E12（daemon merge）不并发——测试注入「E3 进行中触发 E12」场景，断言 E12 排队等待 hydrationComplete 后才执行；merge 期间无中间态写库（写库动作仅在编排单点）。
3. **门闩时序**：`hydrationComplete` 置真前 persist/merge 均不落库（守卫断言，persist 空数组擦库守卫同门闩变量）；waitForHydration 在 E3 异常路径也必然放行（超时兜底 ≤ 既有 15s 离线回退窗口）。

注：本任务涉及启动时序，风险最高（AA-03 五章时序图），独立执行并配集成测试（store-initializers.test.ts 扩展）；依赖 PE-01 T04.1/T04.4 先行或门闩变量先落地（AU-04 附录 AppBootstrap.ts 串行：PE-01 T04.x 先行 → 本任务在后）。

### T06.12 测试与验收（贯穿全部任务）

- 门槛：`cargo test --workspace` 全绿、`cargo clippy` 不新增告警、前端 vitest 相关套件 + typecheck + `check:store-types` 全绿；
- 删除纪律：每项删除前 grep 零残留确认；「待确认」不删；
- 新增测试汇总：Q01 混排 4 用例（T06.1.3）、steering_enabled 短路（T06.2.1）、PayloadTooLarge 直接 fatal（T06.2.2）、构造器默认值（T06.4.4）、预算耗尽诊断事件（T06.3 Q08）、DbFailure/StoreError From 映射表（T06.5.7/5.8）、WindowResizeBridge 集成（T06.10）、providerStore 经 api（T06.9.2）、回灌串行与门闩时序（T06.11，主责 PE-01 T04.4）。**锁中毒测试（A/B/C 三级）归 PE-07 T07.6 用例 1-3**（F10，本域不新增）。

### T06.13 验收清单（总勾稽表）

| # | 验收项 | 证据 |
|---|---|---|
| 1 | Q01 混排取消：取消项结果携带真实 id/tool_name、事件对完整、无空 id 回退 | tool_exec.rs 4 新用例 + run_loop.rs 端到端 |
| 2 | steering_enabled 两处短路 + 默认 true 行为不变 | 新单测 + 既有 run_loop 套件全绿 |
| 3 | PayloadTooLarge 直接 fatal；payload_recovery_limit / payload_recoveries / compression_hook 全仓零残留 | grep + stream_error 新用例 |
| 4 | T06.3 死代码逐项处置完成（`#[cfg(test)]`/删除/接线各有标注） | grep 零残留 + cargo test 全绿 |
| 5 | 构造体字段评审落地：SessionLoopOptions 增删、ToolBatchOptions.output_budget_bytes、EndDecision.aborted_with_diagnostic、构造器派生状态同步 | 编译 + 新单测 |
| 6 | LoopError / EndDecision.error / RunOutcome.error / AgentEnd error 升级为 CrishError；DbFailure/StoreError From 落地（T06.5.1/5.2/5.7/5.8） | crate 内无裸 String 兜底 + IPC 契约测试 |
| 7 | 锁中毒移交（F10）：T06.6 删除、改引用 PE-07 T07.6；本域 Q19 保留标注、Q20 测试替身处置完成；`rg "\.expect\(" crates/agent-tools/src` 仅剩测试与 Q19 保留项（由 PE-07 执行验收） | rg + PE-07 T07.6 用例 1-3 |
| 8 | 遥测三份合一：telemetryStore/storeTelemetryActions/slices 删除；layout-core-actions 唯一 | grep 0 import + check:store-types |
| 9 | 10 组 hooks 合并完成，各自消费方迁移清单逐项勾稽 | vitest 相关套件 + typecheck |
| 10 | WindowResizeBridge 接线、E13 删除、is-layout-frozen 生效 | 集成测试 + 手工拖拽回归 |
| 11 | shell 经 compositionRoot.tree、providerStore 经 api 层；订阅生命周期化 | grep + store 门禁 |
| 12 | 回灌串行化 + hydration 门闩（主责 PE-01 T04.4，D7）；本域 T06.11 特有部分（遥测订阅收敛、Q08 rebind action 化）与验收断言（订阅数/merge 串行/门闩时序）通过 | store-initializers 集成测试 |
| 13 | 03-frontend-contract / 01-session-loop-semantics 同步修订 | 文档 diff 评审 |
| 14 | 全量回归：cargo test --workspace、vitest、typecheck、check:store-types 全绿 | CI 报告 |

## 4. 风险（行为变化面）

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | Q01 修复后取消项事件序列变化 | 混排 cancel-siblings 场景：取消项多出 tool-start/tool-end 事件对、取消消息带真实 id/tool_name（原为空 id 脏数据）——对前端是**修复性**变化，但事件数量与内容变化 | 新测试锚定事件契约（T06.1.3）；前端 tool 卡片渲染依赖字段（id/toolName/output/isError）已按契约实现 |
| R2 | Q05 删除 payload 阶梯 | PayloadTooLarge 从「重试 2 次后 fatal」变「直接 fatal」——少 2 次必然失败的请求延迟，失败更快、诊断更清晰；用户可见行为变化 | runtime-error 文案明示「无压缩恢复路径」；01 §2.5 文档同步 |
| R3 | Q03 接线 steering_enabled | 关闭开关首次真正生效（empty-response 直接收场）；默认 true 无变化 | 默认值不变；配置语义文档化 |
| R4 | Q08/Q32 诊断事件接线 | 预算耗尽场景多一条 runtime-steering 诊断事件；前端未消费事件允许透传（03 §1 未消费清单含 runtime-steering） | 事件载荷轻量；前端 EventRouter 已有透传 |
| R5 | Q14 幂等接线 | 默认 false 无行为变化；开启后同域同参工具去重（跨 run 生效，域 = run_id+session_id） | 默认关闭；文档注明开启语义 |
| R6 | 错误字段类型升级（T06.5.2） | AgentEnd 事件与 RunOutcome 的 error 从 String 变结构化 CrishErrorPayload——IPC 契约变化，前端错误解析逻辑需同步 | 与 03-frontend-contract 同步修订；payload 保留 message 文本字段兼容旧展示 |
| R7 | 锁中毒恢复模式（移出本域） | 锁 expect 修复归 PE-07 T07.6（F10）；若本域误改 agent-tools 锁路径与 PE-07 并行冲突 | 本域不再触碰 agent-tools 三文件锁 expect；修复策略（A/B/C 三级）、单测与验收均由 PE-07 执行 |
| R8 | WindowResizeBridge 接线 | `is-layout-frozen` 首次生产生效：拖拽/缩放期间布局冻结与 body class 行为变化；原 E13 手动 remove 可能清掉 store 期望 class 的问题消失 | 已有 watchdog（30s force-end）+ 对称 end 清理（layoutAnimationStore 正面发现 4） |
| R9 | T06.11 回灌/启动收敛 | 启动时序重排可能暴露新竞态（E3/E12 串行化改变现状交错行为） | 独立高优先级执行；集成测试覆盖（store-initializers） |
| R10 | serde 字段删除（Q11 abort_reason、Q15 session_id） | IPC/持久化载荷字段移除；前端不消费这些字段（审计证实），但载荷 diff 面存在 | 03-frontend-contract 同步；删除前 grep 前端引用 |
| R11 | useStreamRenderThrottle 去留未决 | 若 E2 域不接线且本域误删/误留，产生噪音 | 与 E2 域裁决同步，本方案标记「待裁决」不擅动 |
| R12 | hooks 合并回归 | 10 组合并涉及组件消费方改造（尤其组 1/2/3/4），回归面广 | 逐组小步执行 + 每步 vitest/typecheck；组 3/4 基座抽取先行，消费方后迁 |
| R13 | Q14 幂等接线与锁修复顺序 | 若锁修复未完成先接线幂等，开启路径存在 panic 级联面 | 锁修复由 **PE-07 T07.6** 执行（F10 批 0）；本域 T06.4.1 幂等接线在 PE-07 交付后（跨书依赖，见 §5 依赖注记） |

## 5. 执行顺序（阶段化）

```
阶段 0  基线快照：cargo test --workspace、vitest、typecheck、check:store-types 全绿记录
阶段 1  （原 T06.6 锁中毒加固）已按 F10 移交 PE-07 T07.6（安全 DoS 面，PE-07 批 0 执行）——本域不占阶段；
        仅核对 Q19 保留标注与 Q20 测试替身处置（随阶段 4）
阶段 2  T06.1 Q01 阻塞修复 + 混排测试（本域最高优先级）
阶段 3  T06.2 配置与恢复阶梯（Q03 接线 / Q05 删除 / Q04 删除）+ T06.3 中与其耦合项
        （Q02 abort_reason 透出、Q14 幂等接线——接线放本阶段但默认关闭）
阶段 4  T06.3 死代码清理其余项（Q06/Q07/Q08/Q09/Q10/Q11/Q12/Q13/Q15/Q18/Q20 + Q19/Q20 标注）
阶段 5  T06.5 错误类型升级（**唯一类型 owner，领先 PE-04 消费侧**；含承接的 T06.5.7/5.8 From 实现）
阶段 6  T06.4 构造体打磨（字段评审落地 + 构造器规范化 + 幂等接线开启路径测试——依赖 PE-07 T07.6 先行）
阶段 7  T06.7 前端死文件删除（遥测三份合一优先）+ 门禁扩展
阶段 8  T06.8 hooks 去重组 5/6/7/9（低风险删除）→ 组 3/4（基座抽取）→ 组 1/2（高耦合，随引擎归一）→ 组 8（移交 PE-01 T04.4）
阶段 9  T06.10 WindowResizeBridge 接线（删除 E13）
阶段 10 T06.9 跨 store 修复（shell 门面化、providerStore api 化、订阅生命周期）
阶段 11 T06.11 特有部分（遥测订阅收敛、Q08 rebind action 化）——回灌/启动收敛主责在 PE-01 T04.4，须其先行
阶段 12 全量回归 + 03-frontend-contract / 01-session-loop-semantics 文档同步 + 本方案验收清单勾稽
```

依赖注记：阶段 5 依赖阶段 3/4（错误类型面确定后不再叠加死代码噪音）；阶段 6 幂等接线依赖 PE-07 T07.6（F10，PE-07 批 0）；T06.11 依赖 PE-01 T04.1/T04.4 先行（D6/D7）；阶段 8 组 2 依赖 PE-01 T04.1 的引擎归一；组 8 移交 PE-01 T04.4（sessionIndexLoader 删除）。

## 6. 文档同步清单

| 文档 | 变更 |
|---|---|
| 03-frontend-contract.md | AgentEnd error 字段结构化（R6）、被删 serde 字段（abort_reason/session_id）、未消费事件清单（runtime-steering 诊断） |
| 01-session-loop-semantics.md | §2.5 payload 阶梯删除、steering_enabled 生效语义、取消事件序列契约澄清 |
| 23-architecture-hardening-plan.md | E6 各任务标记本方案承接；E2.3（useStreamRenderThrottle）标记待裁决 |
| store/README.md | ownership 表同步（telemetry 收敛、shell 门面化、门禁范围扩展） |
| AA-01 / AA-03 | 问题台账标注「PE-06 已承接」状态列 |

## 7. 边界与移交清单（不属本域）

| 项 | 移交 |
|---|---|
| Q21 abort 轮询、Q40 重试间隙查 abort、Q33 流标注 | **PE-09 新增任务 T09.9「abort 时序三修复」**（AU-04 认领表 #1；原「移交 PE-05（运行行为域）」表述**作废**）；本方案不引入 abort 时序改动 |
| Q22 pending 清理竞态、Q28 spawn 句柄 | agent-tools 生命周期域（登记 30-verification-checklist） |
| Q23/Q24/Q25/Q26/Q27 | orchestrator 域（Q26 已列 P2 关联评审，见 T06.5.2；Q23 由 PE-08 T08.12 承接） |
| Q35 审批并行退化 | **按 PE-09 T09.6 修复（F9）**：ApprovalGate 跨 async 边界 Arc 化（`Option<Arc<dyn ApprovalGate>>`）后审批逐个 await、执行阶段 join_all 并行；原「记录不改」**作废**；本域 T06.1 改 `mark_rest_cancelled` 签名时不得动 approval 参数形态 |
| Q36/Q37 batch id 前缀 | 低价值微调，随 T06.4.2 顺手做（Relaxed + run_id 前缀），不单列 |
| Q41 注入时钟 | 测试基础设施域（PE-11 T11.7 TestClock） |
| 前端 Q12 SessionSyncService、Q14 restore 双实现、Q15/Q16 激活路径 | 记录待后续前端域 |

**同文件串行声明（AU-04 §四 PE-06.7，与 PE-09 协作）**：
- `tool_exec.rs`：**本域 T06.1 先行** → PE-09 T09.6（Arc 化）随后；T06.1 改 `mark_rest_cancelled` 签名时保持 `approval: Option<Arc<dyn ApprovalGate>>` 形态（F9）。
- `streaming.rs`：**PE-09 T09.1 重构先行** → 本域 T06.2.1 短路点随后落点调整（同文件严格串行）。
- `loop/mod.rs`、`handlers/mod.rs`：与 PE-09 串行（本域 T06.5 类型升级与 PE-09 事件/收口改动按 AU-04 附录串行序执行，禁止并行改同一函数）。

## 附录 A：与 23-architecture-hardening-plan E6 的任务映射

| 23-hardening 任务 | 本方案承接 | 说明 |
|---|---|---|
| E6.1 重复实现合并 | T06.7 / T06.8 / T06.11 | 启动状态机合并（T06.11）、ModelPicker 与设置面板模型 tab 合并不在本域（组件域 E5） |
| E6.2 函数与构造体打磨 | T06.3 / T06.4 / T06.5 | 核心构造体字段评审 + 错误类型升级 + 死代码清理 |
| E6.3 前端 store 分层评审 | T06.7 / T06.9 | 13 实例盘点在 AA-03 完成；本方案承接死文件删除、跨 store 耦合归位、facade 完整性（门禁扩展） |
| E6.4 功能归类（git 本机实现 vs 命令面） | 不承接 | 移交组件/工具域，本方案记录于 §8 边界 |

## 附录 B：AA-03 四章启动时序与本次改动点的对照

| 时序节点 | 本次改动 | 风险注记 |
|---|---|---|
| E3 回灌 | 串行化编排（**主责 PE-01 T04.4**，D7） | 与 E12 竞态消除；persist 空数组守卫联动 AA-07 P02 |
| E4 hydrateWorkspaceShell | 加 waitForHydration 门闩（**主责 PE-01 T04.4**，D7） | 不等 E3 的标题缺失问题修复 |
| E5 bootstrapServices | 加 WindowResizeBridge.connect（T06.10）；订阅生命周期化（T06.9.1） | StrictMode 双执行：connect 幂等已具备 |
| E8/E12 引擎就绪 | 归一为 useEngineState 语义（**主责 PE-01 T04.1**；改名归 PE-05 T05.7.2，C17） | gate timer 不再无条件 setEngineReady |
| E13 手动 resize class | 删除（T06.10） | 冻结接管移交 layoutAnimationStore |
| E16 遥测订阅 | 收敛到 layout-core-actions（T06.7.1） | 三写路径删除后无并发覆盖面 |
