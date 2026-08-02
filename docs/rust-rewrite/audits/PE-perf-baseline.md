# PE 性能基线（PE-perf-baseline.md）

> 维护者：PE-09 T09.7（基准基建，本任务）；基线数据写入方：PE-02（前端埋点
> `requestToFirstChunkMs`）与本任务（Rust 侧基准 + 首 token 集成测量）。
> 单一基线文档（AU-04 认领表 #4 / T09.8：不再散落两份）。
> 关联：`plans/PE-09-performance-plan.md` T09.7/T09.8；`audits/AA-06-performance-review.md`。

## 0. 运行环境与命令

| 项       | 值                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------- |
| 机器     | Windows（开发机），release / bench profile（`cargo bench` 默认优化）                              |
| 工具链   | cargo 1.x（workspace 无 MSRV 声明，最新 stable）                                                  |
| 测量     | Criterion 0.5.1；本文件数字 = 中位数（time 行中间值）                                             |
| 快速模式 | `cargo bench -p <pkg> --bench <name> -- --measurement-time 1 --warm-up-time 0.2 --sample-size 20` |

> 注意：criterion 0.5 **无 `--quick` 选项**（任务书初稿写法），快速模式以上述
> 参数替代；且 `--` 后参数仅对显式 `--bench <name>` 目标生效（默认 lib 测试
> harness 目标不接收 criterion 参数）。

基准场景总表（5 个基准 + 2 个首 token 测试）：

| 基准                           | 位置                                           | 场景（任务书映射）                                    |
| ------------------------------ | ---------------------------------------------- | ----------------------------------------------------- |
| event_chain                    | `crates/orchestrator/benches/event_chain.rs`   | P2 事件序列化/驱动                                    |
| request_build                  | `crates/session-loop/benches/request_build.rs` | P3 对话克隆/消息记录 + consume 聚合                   |
| db_write                       | `crates/conex-db/benches/db_write.rs`          | P6 append_event 写路径                                |
| sse_parse                      | `crates/agent-provider/benches/sse_parse.rs`   | SSE 帧解析吞吐                                        |
| tool_batch                     | `crates/session-loop/benches/tool_batch.rs`    | P8 工具批量执行                                       |
| ttfb（session-loop）           | `crates/session-loop/tests/ttfb.rs`            | 首 token：600ms 硬断言 + 300ms 内部基准               |
| ttfb_measure（agent-provider） | `crates/agent-provider/tests/ttfb_measure.rs`  | 首 token：真实 TCP mock SSE 分阶段观测 + 600ms 硬断言 |

## 1. 基线数字（2026-08-02 首次记录，T09.7 阶段 0）

### 1.1 event_chain（orchestrator，P2）

| 基准                                | 中位数  | 说明                                                       |
| ----------------------------------- | ------- | ---------------------------------------------------------- |
| drive_outcome_100 / MessageEnd 1KB  | 70.4 µs | 46 事件全链（type_name → 序列化 → store 追加），内存 store |
| drive_outcome_100 / MessageEnd 10KB | 71.9 µs | 同上（10KB 正文 +14% 序列化成本）                          |
| push_per_event / MessageEnd 10KB    | 7.2 µs  | 单条持久化事件全链（含 10KB 序列化）                       |

- 解读：每事件 ≈ 1.5 µs（含 `serde_json::to_string` 与内存 store 追加）。
- 替身注意：`InMemoryStore::reserve` 对累计事件线性扫描（测试替身语义，
  真实 SQLite 走索引 `MAX(seq)`），基准已在每迭代新建 store 隔离该成本；
  驱动类基准的绝对数字含小规模扫描（n≤46），量级不受影响。
- 测量注意：`b.iter` 内 `rt.block_on` 必须直接接收 future，不得用 `async {}`
  块再包一层（实测该写法被优化器折叠，计时失真约 50×，已加注释防回归）。

### 1.2 request_build（session-loop，P3/P4 + consume）

| 基准                            | 中位数  | 说明                                            |
| ------------------------------- | ------- | ----------------------------------------------- |
| provider_request 100 消息       | 141 ps  | 借用构造（`&[Arc<AgentMessage>]`）              |
| provider_request 1000 消息      | 129 ps  | 持平                                            |
| provider_request 5000 消息      | 134 ps  | **持平 → 请求构建链 O(1)、0 深克隆（G3 验证）** |
| record_message 1KB（Arc push）  | 324 ns  | 对话 push + start/end 事件（0 深克隆）          |
| record_message 10KB（Arc push） | 405 ns  | 与正文大小弱相关（深克隆应 2→0，T09.3.2）       |
| consume 1000 TextDelta          | 57.1 µs | ≈ 57 ns/token（P1 聚合侧成本）                  |

### 1.3 db_write（conex-db，P6）

| 基准                    | 中位数   | 说明                                 |
| ----------------------- | -------- | ------------------------------------ |
| save_full 100 消息      | 1.49 ms  | 全量（DELETE + INSERT + 逐行触发器） |
| save_full 1000 消息     | 14.25 ms | 线性 O(n)                            |
| save_full 5000 消息     | 80.17 ms | 线性 O(n)                            |
| append_incremental +1   | 127 µs   | 基库 1000 条续写                     |
| append_incremental +10  | 252 µs   |                                      |
| append_incremental +100 | 2.52 ms  |                                      |

- **写放大比（1000 条会话每次 commit +1）≈ 14.25ms / 0.127ms ≈ 112×**
  （G4 改前基线；T09.4 增量接线后前端 commit 走 append，前端侧 + DB 侧
  写放大应降至 O(k)）。

### 1.4 sse_parse（agent-provider，SSE 帧解析吞吐）

| 基准                             | 中位数  | 吞吐        | 说明                               |
| -------------------------------- | ------- | ----------- | ---------------------------------- |
| text_framing 1000 帧 / 1KB 分块  | 3.39 ms | 37.7 MiB/s  | 模拟网络分块（110KB 文本）         |
| text_framing 1000 帧 / 16KB 分块 | 8.39 ms | 15.2 MiB/s  | 大块时 pending.drain 前移成本上升  |
| chat_delta 1000 帧               | 2.93 ms | 341 Kelem/s | 每帧 ≈ 2.9 µs（含 Value 全树解析） |

- 解读：每帧含一次 `serde_json::from_str::<Value>` 全树解析（P5 优化目标：
  serde 派生结构体替代 Value 全树），chat_delta 侧每帧 ≈ 2.9 µs 即该成本
  主导。分块大小影响分帧路径的字符串前移成本（真实网络块 ≈ KB 级）。
- 测量注意：一次性 push 全部文本会触发 `pending.drain` 前移 O(n²)（36ms
  量级失真），基准按真实分块大小切分输入。

### 1.5 tool_batch（session-loop，P8）

| 基准                    | 中位数   | 说明                                                  |
| ----------------------- | -------- | ----------------------------------------------------- |
| no_approval 并行 5×50ms | 62.2 ms  | ≈ max(50ms) + 开销（并行正确，测试 <95ms 断言对应面） |
| approval_model_a 5×50ms | 309.9 ms | ≈ 5×62ms → **串行退化基线**                           |

- 解读：`tool_exec.rs:140-151` 审批路径当前仍为逐工具串行（ApprovalGate
  `&dyn` 无法跨 async move 共享），**P8 改前基线 = 309.9ms**；T09.6
  （Arc 化 + 执行模型 A）落地后复测应降至 ≈62ms（批延迟 = max(工具耗时)
  - 审批链）。

### 1.6 首 token 延迟（F1 三测量点之 600ms / 300ms）

**600ms 集成硬断言（验收门）**——本地慢速流（首 token 500ms、总时长 ≈5s）：

| 测量点                                     | 中位数   | 断言                                       |
| ------------------------------------------ | -------- | ------------------------------------------ |
| session-loop 慢速流：首条 delta 到达事件桥 | 502.6 ms | < 600ms ✓（改造前全量缓冲 ≈ 5s）           |
| agent-provider mock SSE：请求 → 首事件     | 510.8 ms | < 600ms ✓（首字节 510.7ms / 首帧 510.8ms） |

**300ms 内部基准（F1 记录项，不作验收门）**：

| 测量点                                 | 记录值  | 说明                                                     |
| -------------------------------------- | ------- | -------------------------------------------------------- |
| 流产出 → 事件桥到达（Rust 侧处理耗时） | 43.2 µs | `stream.next()` + delta 构造 + `sink.push`，远低于 300ms |

- 500ms 端到端（前端 `requestToFirstChunkMs`）归 **PE-02 T02.6** 总验收，
  本文件预留该节，PE-02 写入数据（三测量点口径，无第四套数字）。
- 观测方式：`cargo test -p session-loop --test ttfb -- --nocapture`、
  `cargo test -p agent-provider --test ttfb_measure -- --nocapture`。

## 2. 600ms 硬断言测试位置（T09.1 确认）

| 项                                                            | 状态                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `crates/session-loop/tests/streaming_incremental_contract.rs` | 已有（PE-02 契约锚点，F1）                                                                                          |
| 600ms 首 token 硬断言（Rust 侧事件桥等价）                    | **本任务补齐**：`crates/session-loop/tests/ttfb.rs`                                                                 |
| 600ms 首 token 硬断言（真实 TCP mock SSE）                    | **本任务补齐**：`crates/agent-provider/tests/ttfb_measure.rs`                                                       |
| tauri 侧 BridgeDeltaSink 集成（binary-only 无法直测）         | 契约由 streaming_incremental_contract + engine 单元测试覆盖；tauri 集成侧为同构薄包装（序列号 None 信封契约已冻结） |

## 3. 复测对照表（T09.2/T09.3/T09.4/T09.6 落地后回填）

| 任务                   | 预期变化                                          | 改前基线                | 复测                                                                                                                           |
| ---------------------- | ------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| T09.2（P2 克隆消除）   | push_per_event 每事件耗时下降（深克隆 2→0）       | 7.2 µs（10KB 单条）     | —                                                                                                                              |
| T09.3（P3 借用/Arc）   | provider_request 保持 O(1)；record_message 弱相关 | 129-141 ps / 324-405 ns | —                                                                                                                              |
| T09.4（P6 增量接线）   | 前端 commit 写放大 O(n)→O(k)                      | 112×（1.3 节）          | —                                                                                                                              |
| T09.6（P8 审批并行）   | approval_model_a 309.9ms → ≈62ms                  | 309.9 ms                | **62.1 ms**（-79.95%，已达标；2026-08-02 复测：no_approval 62.0ms / approval_model_a 62.1ms，批延迟 = max(工具耗时) + 审批链） |
| T09.5（P7 分页下推）   | 页首查询 O(n)→O(limit)（另行量化，暂未设基准）    | —                       | —                                                                                                                              |
| P5（帧解析，另立任务） | chat_delta 每帧 <2.9 µs                           | 2.9 µs/帧               | —                                                                                                                              |
