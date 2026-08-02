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

| 任务                   | 预期变化                                          | 改前基线                | 复测（2026-08-02 T09.10 收口复测）                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T09.2（P2 克隆消除）   | push_per_event 每事件耗时下降（深克隆 2→0）       | 7.2 µs（10KB 单条）     | **8.1-8.5 µs**（低噪声采样；drive_outcome 1KB 71.7µs 持平基线 70.4µs；+14% 在机器噪声内，见 §4 噪声说明）                                                                                                                |
| T09.3（P3 借用/Arc）   | provider_request 保持 O(1)；record_message 弱相关 | 129-141 ps / 324-405 ns | **139-149 ps**（100/1000/5000 消息持平，O(1) 保持）；record_message **322/376 ns**（1KB/10KB）；consume 1000 **61.2 µs**（61 ns/token，基线 57.1µs）；Arc 身份零拷贝断言全绿 |
| T09.4（P6 增量接线）   | 前端 commit 写放大 O(n)→O(k)                      | 112×（1.3 节）          | **⚠ 未接线（遗留）**：append_session_messages 命令未注册（manifest `registered=false`，session_commands.rs 无实现，main.rs 未挂）；G4 端到端未达成，登记见 §5 |
| T09.6（P8 审批并行）   | approval_model_a 309.9ms → ≈62ms                  | 309.9 ms                | **61.9 ms**（-80.0%，已达标；2026-08-02 复测：no_approval 62.0ms / approval_model_a 61.9ms，批延迟 = max(工具耗时) + 审批链）                                                                                            |
| T09.5（P7 分页下推）   | 页首查询 O(n)→O(limit)（另行量化，暂未设基准）    | —                       | **⚠ 未实现（遗留）**：Store::query_events 无 limit 参数（persist.rs:169 两参签名），调用处全量读 + 内存 paginate；conex-db SQL LIMIT 已支持但传 None（persist.rs:672），登记见 §5 |
| P5（帧解析，另立任务） | chat_delta 每帧 <2.9 µs                           | 2.9 µs/帧               | **1.0 µs/帧**（顺带复测 1.00ms/1000 帧，优于基线；text_framing 1.40/4.60ms，均优于基线）                                                                                                                                 |

## 4. T09.10 回归收口复测记录（2026-08-02）

### 4.1 首 token（F1 三测量点之 600ms / 300ms 复测）

| 测量点                                  | 基线（T09.7） | T09.10 复测 | 状态 |
| --------------------------------------- | ------------- | ----------- | ---- |
| session-loop 慢速流：首条 delta 到达事件桥 | 502.6 ms      | **503.7 ms** | ✓ <600ms（5.04s 全流时长保持，增量路径不缩短流） |
| agent-provider mock SSE：请求 → 首事件  | 510.8 ms      | **510.5 ms** | ✓ <600ms（首字节 510.5ms / 首帧 510.5ms，总 6.17s） |
| 300ms 内部基准：流产出 → 事件桥处理耗时 | 43.2 µs       | **31.3 µs**  | ✓ 远低于 300ms（仅记录，不作验收门） |

### 4.2 基准复测（Criterion，快速模式参数）

| 基准        | 场景                   | 基线中位数 | T09.10 复测中位数 | 状态 |
| ----------- | ---------------------- | ---------- | ----------------- | ---- |
| tool_batch  | no_approval 并行 5×50ms | 62.2 ms    | 62.0 ms           | ✓ 持平 |
| tool_batch  | approval_model_a 5×50ms | 309.9 ms   | **61.9 ms**       | ✓ 已达标（-80.0%） |
| event_chain | drive_outcome 1KB      | 70.4 µs    | 71.7 µs           | ✓ 持平 |
| event_chain | drive_outcome 10KB     | 71.9 µs    | 78-97 µs（多次运行区间） | ⚠ 噪声内（±50% 波动，见 4.3） |
| event_chain | push_per_event 10KB    | 7.2 µs     | 8.1-8.5 µs（低噪声采样） | ✓ 噪声内 |
| request_build | provider_request 100/1000/5000 | 141/129/134 ps | 145.6/149.2/139.1 ps | ✓ O(1) 保持 |
| request_build | record_message 1KB/10KB | 324/405 ns | 322.5/376.2 ns | ✓ 持平 |
| request_build | consume 1000 TextDelta | 57.1 µs    | 61.2 µs            | ✓ 持平（61 ns/token） |
| db_write    | save_full 100/1000/5000 | 1.49/14.25/80.17 ms | 1.37/17.04/80.64 ms | ✓ 持平（1000 档 +20% 噪声） |
| db_write    | append +1/+10/+100    | 127/252 µs / 2.52 ms | 84.0/202.8 µs / 1.93 ms | ✓ 更优 |
| sse_parse   | text_framing 1KB/16KB  | 3.39/8.39 ms | 1.40/4.60 ms       | ✓ 更优（非本域，顺带复测） |
| sse_parse   | chat_delta 1000 帧     | 2.93 ms    | 1.00 ms            | ✓ 更优（1.0 µs/帧） |

### 4.3 测量环境噪声说明（重要）

- 复测期间机器背景进程活跃（Chrome 多进程 / QQPC / msedgewebview2 等），
  Criterion 同参数多次运行 event_chain 波动达 ±50%（1KB 档 69-190µs、
  10KB 档 78-202µs、push 档 8-17µs 均出现过）；单独低并发运行时低值端
  与基线一致。**结论：全部基准无超量级回归信号；event_chain 10KB 档
  （+24~35%）与 save_full 1000 档（+20%）判为噪声，待低负载时段复测确认**，
  登记见 §5 L3。
- 记录口径：本表取「独立运行、低并发」的中位数；与基线同机同参数
  （快速模式 `--measurement-time 1~3 --warm-up-time 0.2~0.5 --sample-size 20~30`）。
- 注意：criterion 默认参数（长测量时间）在本机持续负载下会触发 CPU
  降频，数值系统性偏高（event_chain 1KB 达 190µs），对照基线须用快速模式。

## 5. 遗留登记（T09.10 收口，未完成项）

| # | 项 | 状态证据 | 影响 | 后续归属 |
| - | -- | -------- | ---- | -------- |
| L1 | **T09.4 前端 commit 增量未接线**：append_session_messages 命令仅 manifest 登记（`registered=false`，command_manifest.rs:150），session_commands.rs 无实现、main.rs 未注册；sessionRustDb.ts 无 appendSessionMessages，commit 仍全量 saveSessionBody | G4 端到端写放大未达成（DB 侧 append API 已就绪，lib.rs:965） | 写放大比维持全量路径（实测 1000 条会话 save_full ≈ 17ms vs append +1 ≈ 84µs，仍 ~200×） | PE-09 后续轮次接线（T09.4.1/T09.4.2），与 PE-08 串行约束保持 |
| L2 | **T09.5 SQL 分页下推未实现**：Store::query_events 无 limit 参数（persist.rs:169）；core_read_session_events/read_run_events 全量读 + 内存 paginate（core_query_commands.rs:429/477）；conex-db SQL LIMIT 已支持但 LocalDbStore 传 None（persist.rs:672） | G5 首页查询仍 O(n) | 长会话首页查询全量读 + 逐条 JSON 重建；翻页语义正确但开销未消除 | 按 T09.5.1 步骤 1-7 落地（含 restore 传 None、run 边界切点测试） |
| L3 | 基准噪声：机器背景负载导致 event_chain/save_full 部分档位波动 ±50%，10KB 档无法定论 | 见 §4.3 | 复测对照精度受限 | 低负载时段或专用机器复测，更新 §3 对照表 |
| L4 | clippy 既有告警（非本任务新增）：conex-db/search/sandbox 等 lib 告警；workbench 未接线命令死代码（workbench_profile_secret_* / provider_status 等，与 L1 同类：命令登记先行未接线） | `cargo clippy --workspace --all-targets` | 无功能影响 | 随 PE-07/PE-09 接线消除；本任务零代码改动，无新增告警 |

> 已验证未回归项（收口结论）：T09.1 增量流（ttfb 600ms 硬断言）、T09.2 事件克隆
> （by value 零克隆代码审查 + roundtrip）、T09.3 对话克隆（Arc 身份零拷贝测试）、
> T09.6 审批并行（61.9ms）、T09.9 abort 三修复（14+ 测试）、压力测试
> （stress_long_session / stress_concurrent_runs / stress_write）、
> `cargo test --workspace` 全绿。
