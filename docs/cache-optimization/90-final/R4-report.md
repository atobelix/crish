# 轮次报告：R4（历史回流与上下文管理，P4）

## 轮次元信息

- 轮次：R4
- 本轮 Agent 数：8 / 12（T-27、T-28、T-32、T-29、T-33、T-30、T-31、T-34）
- 任务包数：8（T-27~T-34，P4 全量）
- 门禁执行结果：**通过（本方案域）**——session-loop 205+4 集成、orchestrator 106、conex-compaction 37、conex-types 101 全绿；crish-agent-workbench 187 通过（2 项失败仍为外部 R3-D3 归因）
- 日期：2026-08-03

## 一、已完成

| 任务单元 | 文件域                                                                  | 改动摘要                                                                                                                                                                                                                                                                                                                            | 自验证                                                |
| -------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| T-27     | `conex-types/src/history.rs`、`context.rs`（新）                        | `HistoryMessage`（id/sender/timestamp + 可选 text/thinking/blocks_json/tool_calls_json/tool_call_results_json/status）、`ContextBudget`（window 64000/reserve 16384/safety 4096）、`SessionContextMeta`（压缩护栏四字段）+ 11 测试                                                                                                  | conex-types 101 全绿                                  |
| T-28     | `session-loop/src/hydrate.rs`（新）                                     | `hydrate_history` 宽容水合（完成态过滤/blocks 保真优先/合成兜底/尾部 user 截断/乱序保序）+ 16 测试；发现 blocks_json 形状偏差（前端 timeline 形状）已记录回退路径                                                                                                                                                                   | session-loop 184 全绿                                 |
| T-32     | `conex-compaction/src/lib.rs`                                           | AgentMessage 面：`estimate_context_tokens`（usage 优先 C9 + 时间戳护栏 + 启发式）、`find_cut_point`（tool 配对保护）、`compact_agent_messages`（L1 占位符/L2 摘要/迭代合并）、`should_compact`、`CompactionPolicy`/`CompactionPlan`/`Summarizer`（同步 trait）+ 27 新测试；旧 Message 面逐字节未动                                  | conex-compaction 37 全绿                              |
| T-29     | `core_run_commands.rs`                                                  | SessionHistoryCache（32 会话×200 条、FIFO、孤儿 tool 前缀防护）、`core_run_task` 加 history/context_window、收口写入 to_history_messages（全角色保真）、resolve_history_source 混合路线 + 8 测试                                                                                                                                    | crish-agent-workbench 185+11+17（隔离 worktree 验证） |
| T-33     | `session-loop` handlers/loop/mod/prepare_turn/streaming                 | `context_budget/compaction_policy/summarizer/max_auto_compactions_per_run` options、`clamp_max_tokens`（下限 256 不钳只记录）、`estimate_context`（C9 inputTotal）、`maybe_compact_preflight`（prepare_turn 预留点恢复）、`apply_compaction`（触发/计数/时间戳护栏/Start-End 事件广播）、run() 归零点 + 4 集成测试（真实 run 链路） | session-loop 191+4 全绿                               |
| T-30     | `engine.rs`、`core_run_commands.rs`                                     | `SessionLoopProducer.initial_conversation` 水合分支（零拷贝预置 + run 追加）、context_budget 透传、753-754 注释兑现 + 3 测试                                                                                                                                                                                                        | crish-agent-workbench 187 通过                        |
| T-31     | `ConnectionLifecycle.ts`                                                | `buildHistoryMessages` 纯函数（完成态过滤/HISTORY_CAP=100/excludeId）、`resolveContextWindow`（设置键→catalog 兜底）、startRunTask history/contextWindow 透传 + 11 测试                                                                                                                                                             | vitest 104/104、typecheck 绿                          |
| T-34     | `stream_error.rs`、`loop/mod.rs`、`invariants.rs`（新）、`orchestrator` | 压缩阶梯（length_ladder 用尽→Overflow 压缩重试一次→fatal；PayloadTooLarge 直接压缩阶梯；MAX_OVERFLOW_COMPRESSION_RETRIES=1；noop 不假恢复）、`SessionContextMeta` 落 SessionRecord + restore 重放折叠 + **I1-I6 不变量测试** + 12 新测试                                                                                            | session-loop 205、orchestrator 106 全绿               |

提交记录：`533f5d31`（波 1-2）、`805aafed`（波 4；波 3 与波 4 合并提交）。

## 二、门禁执行结果

- `cargo test --workspace`：本方案域全绿；唯一失败 = R3-D3 外部 2 项（红线测试，--skip 后 187 全绿）
- `npx vitest run src/api/chat-bridge`：104/104；`npm run typecheck`：exit 0

## 三、发现的问题与主 Agent 裁决

| #     | 问题                                                                                        | 裁决/处置                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4-D1 | T-28 发现前端 blocks_json 为 timeline 形状（与 AgentMessageBlock 序列不兼容）               | 接受宽容水合回退路径（信息损失以 text 主字段为限）；T-31 已按 HistoryMessage 字段组装不依赖 blocks 形状；若未来需要块保真由前端下发 AgentMessageBlock 形状，hydrate 自动生效（已注释） |
| R4-D2 | session-loop Cargo.toml 新增 conex-compaction 依赖（与 §7.1"T-36 唯一编辑 Cargo.toml"冲突） | 接受：P4 §3.4.1 必要依赖，T-33 已加（新增行）；T-36 追加 conex-telemetry 行不受影响；已登记                                                                                            |
| R4-D3 | T-32 裁决：Summarizer 同步 trait（P4 §3.4.4 原为 async_trait 但 §3.7 签名同步，矛盾）       | 接受同步 trait（纯算法 crate 不引入运行时，摘要请求调度归壳层）；命名 compact_agent_messages 避免与旧面重名                                                                            |
| R4-D4 | T-33 与 T-34 并行写 loop/mod.rs                                                             | 波次串行已满足（T-33 第三波先写归零点，T-34 第四波仅追加验证），无冲突                                                                                                                 |
| R4-D5 | 模型切换护栏（§3.4.6）LoopState 无模型 id                                                   | 已注释预留，不阻塞主线（登记演进项）                                                                                                                                                   |

## 四、输出为下一轮输入（R5）

- `cacheBreakdown.inputTotal` 已贯通（T-16 → T-32/T-33 估算 → I6 钉死），P5 的 MissDetector 可直接消费
- 压缩事件（ContextCompressionStart/End）已在 run 事件流广播，P5 的 CacheDomainEvent 需与其衔接（C13 基线重置）
- `SessionContextMeta` 已落 SessionRecord（T-34），P5 的 conex-db v5 迁移参照该模式
- R3-D3 外部 2 项失败继续登记，R7 复核
