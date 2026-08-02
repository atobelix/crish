# PE-09 性能回归收口报告（T09.10）

> 日期：2026-08-02　执行：T09.10（复测与回归收口）
> 范围：T09.1-T09.9 全部性能项的关键断言/测试/基准复跑；T09.4/T09.5 缺口检查；
> 基线对照：`audits/PE-perf-baseline.md`（§1 基线 → §3/§4 复测）；任务书：`plans/PE-09-performance-plan.md`。
> 结论摘要：**7/9 项验证通过无回归，2 项未完成（T09.4 未接线、T09.5 未实现）已登记遗留；本任务零代码改动。**

## 1. 回归验证结果（逐项）

| 任务 | 验证项 | 关键数字 | 状态 | 结论 |
| ---- | ------ | -------- | ---- | ---- |
| **T09.1** 增量流（首 token） | `ttfb.rs` 600ms 硬断言 + 300ms 内部基准 | 首条 delta 到达事件桥 **503.7ms**（基线 502.6ms）；流产出→事件桥 **31.3µs**（基线 43.2µs）；全流 5.04s 保持 | ✅ 全绿 | 无回归，600ms 硬断言保持通过 |
| T09.1 增量流（真实 TCP mock） | `agent-provider/tests/ttfb_measure.rs` | 请求→首事件 **510.5ms**（基线 510.8ms，首字节 510.5ms） | ✅ 全绿 | 无回归 |
| T09.1 增量流（契约） | `streaming_incremental_contract.rs` 7 测试（形状/顺序/终止/取消/abort 竞速） | 7/7 通过 | ✅ 全绿 | 契约无回归 |
| **T09.2** 事件克隆 | 代码审查断言 + events roundtrip + events.rs 测试 | `drive_outcome`/`push` 均 by value 消费（events.rs:152/314/329），无 `.clone()`；conex-types 83 测试全绿 | ✅ 全绿 | 深克隆 2→0 保持（G2） |
| **T09.3** 对话克隆 | `run_loop::long_conversation_request_and_record_are_zero_copy` Arc 身份断言 | 请求链 101 条 + 记录路径 4 条全部 `Arc::ptr_eq` 通过；基准 O(1) 保持（139-149 ps） | ✅ 全绿 | 零拷贝保持（G3） |
| **T09.4** DB 写放大 | 接线状态检查（本任务缺口项） | append_session_messages 命令**未注册**（manifest `registered=false`；session_commands.rs 无实现；main.rs 未挂；前端无 appendSessionMessages） | ⚠ 遗留 L1 | 未接线，G4 端到端未达成（DB 侧 API 已就绪） |
| **T09.5** 分页下推 | store 接口与调用检查（本任务缺口项） | `Store::query_events` 仍两参无 limit（persist.rs:169）；core_read_session_events/read_run_events 全量读+内存 paginate（core_query_commands.rs:429/477）；SQL LIMIT 已支持但传 None（persist.rs:672） | ⚠ 遗留 L2 | 未实现，G5 未达成（翻页语义正确，开销未消除） |
| **T09.6** 审批并行 | `tool_batch` 基准 + tool_exec 审批测试 | approval_model_a **61.9ms**（基线 309.9ms → 62.1ms，-80.0%）；no_approval 62.0ms；审批并行 6 测试全绿 | ✅ 全绿 | 达标保持，批延迟 = max(工具) + 审批链（G6） |
| **T09.9** abort 时序 | Q21/Q33/Q40 三修复测试组 | tool_exec `abort_interrupts_long_running_tool_promptly` 等；safe_point `wait_aborted_*`（13 测试）；stream_error `abort_at_ladder_entry_skips_retry_and_closes_out` 等；stream 10 测试；agent-provider abort 3 测试；run_loop 2 abort 测试 | ✅ 全绿 | 三修复无回归 |
| T09.7 基准（其余 4 个） | event_chain / request_build / db_write / sse_parse | 见 §2 对照表 | ✅ 持平/更优 | 无超量级回归（噪声说明见 §3） |
| 压力测试 | release + `--ignored` stress_ 系列 | stress_long_session 4 / stress_concurrent_runs 2 / stress_write 3 全部通过（5000 消息 28.5µs 报告模式） | ✅ 全绿 | 无回归 |
| 全量回归 | `cargo test --workspace` | 全部 crate 测试通过（0 failed） | ✅ 全绿 | T09.10 验收项 1 达成 |
| 静态检查 | `cargo clippy --workspace --all-targets` | 仅既有告警（L4 登记），本任务零代码改动无新增 | ✅ | 零新告警 |

## 2. 基准复测对照表（快速模式，同机同参数）

| 基准 | 场景 | 基线 | 复测 | 状态 |
| ---- | ---- | ---- | ---- | ---- |
| tool_batch | approval_model_a 5×50ms | 309.9 ms | **61.9 ms** | ✅ 达标（-80.0%） |
| tool_batch | no_approval 5×50ms | 62.2 ms | 62.0 ms | ✅ 持平 |
| event_chain | drive_outcome 1KB | 70.4 µs | 71.7 µs | ✅ 持平 |
| event_chain | drive_outcome 10KB | 71.9 µs | 78-97 µs（区间） | ⚠ 噪声内待确认（L3） |
| event_chain | push_per_event 10KB | 7.2 µs | 8.1-8.5 µs | ✅ 噪声内 |
| request_build | provider_request 100/1000/5000 | 141/129/134 ps | 145.6/149.2/139.1 ps | ✅ O(1) 保持 |
| request_build | record_message 1KB/10KB | 324/405 ns | 322.5/376.2 ns | ✅ 持平 |
| request_build | consume 1000 TextDelta | 57.1 µs | 61.2 µs | ✅ 持平（61 ns/token） |
| db_write | save_full 100/1000/5000 | 1.49/14.25/80.17 ms | 1.37/17.04/80.64 ms | ✅ 持平（1000 档 +20% 噪声） |
| db_write | append +1/+10/+100 | 127/252 µs / 2.52 ms | 84.0/202.8 µs / 1.93 ms | ✅ 更优 |
| sse_parse | text_framing 1KB/16KB | 3.39/8.39 ms | 1.40/4.60 ms | ✅ 更优（顺带） |
| sse_parse | chat_delta 1000 帧 | 2.93 ms | 1.00 ms | ✅ 更优（1.0 µs/帧） |

## 3. 测量噪声说明

- 复测期间机器背景进程活跃（Chrome/QQPC/msedgewebview2），criterion 同参数
  多次运行 event_chain 波动 ±50%；对照取「独立运行低并发」中位数，与基线
  同机同参数（快速模式）。criterion 默认参数在本机持续负载下触发 CPU 降频，
  数值系统性偏高，对照基线必须用快速模式。
- event_chain 10KB 档与 save_full 1000 档差异（+24~35% / +20%）判为噪声，
  登记 L3，待低负载复测定论；其余各档与基线一致或更优。

## 4. 缺口清单（检查结果）

| 缺口 | 证据 | 影响 | 处置 |
| ---- | ---- | ---- | ---- |
| GAP-1：append_session_messages 命令未接线 | command_manifest.rs:150 `registered=false`；session_commands.rs / main.rs 无实现 | 前端 commit 仍全量 saveSessionBody，写放大 ~200× | 遗留 L1（后续轮次接线，PE-08 串行约束保持） |
| GAP-2：query_events 分页未下推 SQL | persist.rs:169 无 limit 参数；core_query_commands.rs:429/477 全量读 + 内存分页 | 长会话首页 O(n) 全量读 + 逐条 JSON 重建 | 遗留 L2（按 T09.5.1 步骤 1-7 落地） |
| GAP-3：前端 hydrate 游标循环 | 依赖 GAP-2 | 长会话恢复全量读取 | 随 L2 一并落地 |

## 5. 遗留登记（摘要，详见 PE-perf-baseline.md §5）

- **L1**：T09.4 未接线（G4 未达成）
- **L2**：T09.5 未实现（G5 未达成）
- **L3**：基准测量噪声（event_chain 10KB 档待低负载复测）
- **L4**：clippy 既有告警（未接线命令死代码等，随接线消除）

## 6. 结论

- **无回归**：T09.1/T09.2/T09.3/T09.6/T09.9 全部关键断言复跑全绿；首 token
  600ms 硬断言保持（503.7ms）；审批并行保持 61.9ms；对话/事件零克隆断言保持；
  abort 三修复保持；压力测试与全 workspace 测试全绿。
- **未完成**：T09.4（append 命令未接线）、T09.5（分页未下推）按缺口检查登记遗留，
  不影响已落地项；两任务书对应 G4/G5 目标顺延至后续轮次。
- **冒烟**：live model 全旅程（真实 provider）为联调项未执行，归 E8 最终验收
  （PE-02 T02.6 端到端 500ms 放行权在 T09.8 已确认归本任务，联调时行使）。
