# 04 · Rust 引擎热路径性能审查报告

> **战役**：全面性能审查（performance-audit）
> **方向**：04 · Rust 引擎热路径
> **创建**：2026-09-12
> **检查对象**：`crates/session-loop/`（loop_runner / streaming / executing_tools / prepare_turn / steering / hydrate / rollback / checkpoint / compaction_dispatch / attachment_* / cache_tracker / tool_exec / state）、`crates/orchestrator/`（events / drive_outcome / EventQueue / run 生命周期）、`apps/agent-workbench/src-tauri/src/run/` 与 `engine_channels.rs`（引擎侧锁/缓冲/flush 调度）、`crates/agent-provider/`（SSE / 流转发 / 超时重试）、全 workspace 阻塞与锁纪律
> **方法约定**：静态代码走读；每条结论带 `文件路径:行号`；未实测项标注「静态分析，待运行时验证」；不臆测
> **与 01/02/03 的边界**：03 已展开 emit 契约细节（token 逐条 emit、双发、NoPersist 取号、收口串行、实时轨 flush）——本文交叉引用不重复；03 提及但未下钻的 session-loop/orchestrator 引擎侧 clone 链、估算 O(N)、审计 worker 无界通道等在本文展开

---

## 执行摘要

**一句话结论：Rust 引擎热路径的异步纪律与锁纪律健康（无 block_in_place、无 std Mutex 跨 await、abort biased select、工具快照锁定、cache 增量签名），但流收口存在「全文三连克隆 + thought 逐 delta 成块 + 每请求双份 tools to_vec + 每请求 O(N) 上下文估算」四个随 run 规模恶化的结构性浪费——大回复/长思考/长对话下 CPU 与堆分配显著放大，叠加 03 已证的 IPC 双轨后端成本，一次大 turn 的引擎侧拷贝量可达正文字节的 4–6 倍。**

发现计数：**高 7 · 中 9 · 低 7**（合计 23 项问题；另有 8 条正面发现禁止回潮）。

| 域 | 高 | 中 | 低 | 代表问题 |
| -- | -- | -- | -- | ------- |
| S streaming | 3 | 3 | 1 | S1 收口全文三连克隆 / S2 thought 逐 delta 成块 / S3 每请求双份 tools |
| O orchestrator | 1 | 2 | 1 | O1 审计 worker 无界通道串行消费 |
| P provider | 1 | 1 | 1 | P1 consume 等价层全文 clone 同构 |
| T tool 执行 | 1 | 1 | 2 | T1 ToolOutput 多次 Value clone + 全事件对放大 |
| K 锁/spawn/估算 | 1 | 2 | 2 | K1 estimate_context 每请求 O(N) / K2 emit_event 全变体深克隆 |
| — | **7** | **9** | **7** | — |

**TOP3 高危**：

1. **L4-S1** 流收口正文三连克隆（response.text + metadata.text + tool_calls 深拷贝）——随回复长度线性放大；
2. **L4-S2** thought 逐 delta 独立成块（metadata + 消息 blocks + 收口 delta 三重放大）——长思考模型必踩；
3. **L4-K1** 每 provider 请求 + 每 prepare_turn 的 `estimate_context` 全对话扫描 + 工具 JSON 重序列化——随历史长度 O(N) 恶化，且 CompactionEngine 每次新建。

修复路线图续用 03 的 **K–O** 批次并新增 **P–S** 批次（引擎侧减拷贝，不动 IPC 契约可先行的与需契约评审的分开）。

---

## 一、架构快照（热路径图）

```
provider SSE 字节
  → agent-provider SseParser（单遍分帧，正面）
  → ProviderEventStream / provider::stream
  → session-loop streaming::consume_stream
       ├─ 每 delta: delta_to_message_event(clone) → DeltaSink.push_live → emit+flush  【03-R1】
       └─ builder.push(event)  （Aggregate 聚合）
  → finish()：text.clone ×2 + tool_calls.clone + thought_blocks serde  【L4-S1/S2】
  → build_assistant_message → commit_message_with_deltas
       ├─ MessageStart(Arc 共享，正面)
       ├─ emit_message_deltas：全文块再 clone 进 events  【L4-S5】
       └─ MessageEnd(Arc 共享)
  → tools_schema().to_vec() ×2 + capture_signature  【L4-S3】
  → clamp_request_max_tokens → estimate_context O(M)  【L4-K1】
  → build_request（messages 借用，正面）→ provider.stream
  → executing_tools：每结果 record_message + ToolEnd 全量 clone  【L4-T1】
  → LoopState.events（emit_event 深克隆，【L4-K2】）
  → orchestrator EventQueue::push 串行（03-R4）
  → 审计 worker unbounded + 串行 push_terminal_best_effort  【L4-O1】
  → engine_channels BridgeLiveSink：emit + 立即 flush（03-R5）
```

---

## 一.5 分域走读纪要（证据补充）

### 一.5.1 session-loop 状态机与事件缓冲

`LoopState`（handlers/mod.rs 构造面 :150-171）持有 `conversation: Vec<Arc<AgentMessage>>` 与 `events: Vec<AgentEvent>`。run 收口时 `loop_exec.rs:334-335` 以 `mem::take` 取走两者——缓冲生命周期与 run 对齐，**无跨 run 泄漏**（正面）。问题在 run 内：`emit_event` 对每个事件 `clone` 进 `events`，对非 Arc 变体构成深拷贝（L4-K2）。

状态机分派 `dispatch`（:215-227）为同步廉价操作，不在热点名单。`check_control`（:478+）读 `AbortSignal`（Atomic）与 `ControlBus`（std Mutex 短临界区）——安全点频率 = handler 起止，非每 delta。

### 一.5.2 streaming 消费循环逐行成本

`consume_stream`（streaming.rs:118-222）主循环每条 ProviderStreamEvent：

1. `tokio::select!` biased abort + stream.next——有 IO 时开销可忽略；
2. 命中 delta 类型：`delta_to_message_event` 分配 `String`（session_id/message_id/text clone）+ `now_iso_utc()` 格式化；
3. `sink.push(delta)` → BridgeLiveSink → serialize + buffer lock + flush 全量发射（03-R1/R5）；
4. `builder.push(event)`：Aggregate `push_str`（text）或 `thought_blocks.push`（thought，L4-S2）。

**每 delta 固定税**：≥2 次 String 克隆 + 1 次时间戳格式化 + 1 次 serde + 2 次 Mutex + WebView IPC。这与 03-R1 同构；本文强调的是 **Aggregate 侧 thought 无界块数** 与 **收口 finish 克隆** 是 03 未展开的引擎侧增量。

### 一.5.3 prepare_turn 顺序与估算触发点

`prepare_turn.rs:37-136` 固定顺序：abort 检查 → hold 消费（可能边界压缩）→ record_message×N → turn-start → hooks → steering 两相位 → preflight 压缩 → TURN_PREPARED。

估算触发：
- hold 非空 → `maybe_compact_user_boundary` → `estimate_context`；
- preflight → `estimate_context`；
- 之后 streaming `clamp_request_max_tokens` → `estimate_context`。

**同一 turn 最多 3 次 O(M) 估算**（L4-S6）。steering 两相位对空策略协调器近零成本；RecoverySteeringStrategy 注入后走尾部倒扫（L4-S7），仍受 user 边界短路保护。

### 一.5.4 executing_tools 事件放大系数

`emit_tool_events`（executing_tools.rs:223-423）两遍扫描：第一遍收集摘要，第二遍发射。每工具：

| 事件 | 载荷 | clone 点 |
| ---- | ---- | -------- |
| ToolStart | input 全量 | input.clone |
| ToolEnd | output 全量 + executed_input | tool_output_from_parts 内 2–3× Value clone |
| MessageStart/End（record_message） | ToolResult 块含 output | tool_output_from_result 再 2–3× |

K 工具批的引擎侧 Value 拷贝次数 ≈ **K × 5–7**（静态推导）。与 03-C2 的 IPC 面正交：即使 IPC 截断，events 缓冲与 record_message 仍持全量。

### 一.5.5 orchestrator EventQueue 与 run 生命周期

`EventQueue::push`（events.rs:246-280）：reserve（会话原子序列）→ is_non_persistent 短路 → serialize envelope → append_event。`drive_outcome`（:435+）逐事件 await push——03-R4 已写串行；本文补充：审计 worker（run_core.rs:200）是 **第二生产者** 抢同一 `tokio::Mutex<EventQueue>`（L4-O2），且其通道无界（L4-O1）。

`push_terminal_best_effort`（:297-340）失败不重试序列推进——语义正确（不假装可回放），但与无界通道组合时「失败仍堆在 mpsc」直到 worker 排空。

### 一.5.6 agent-provider 传输与重试

- `transport/mod.rs`：reqwest 适配 + first-byte/idle 超时看门狗 spawn——与请求同生命周期；
- `retry_stream.rs:106+`：loop 内失败分类 → decision → sleeper.sleep（abort 竞速）→ 重试；**无整历史重放缓冲膨胀**（每次重试新流）；
- `SseParser`：正面 P1；`read_sse` 逐块 push——块大小由 reqwest 决定，无应用层合批需求（合批问题在 02-X2 PTY 域）。

### 一.5.7 hydrate / rollback / checkpoint / attachment

- hydrate：零拷贝 Arc 对接（P8）；`joined_text` 每消息一次拼接——O(正文) 但仅恢复期一次。
- rollback / checkpoint：低频控制面；走读未见每 turn 热点。
- attachment_budget：同步顺序接纳 + Head-Tail 截断；无 async、无锁；成本 O(附件字节) 仅在带附件输入时。

### 一.5.8 cache_tracker 生命周期

`capture_signature` 每 provider 请求前调用（streaming.rs:64-66）；增量路径已优化消息侧（P4），但 `sig.clone()` 进 last_signature（L4-K3）且 tools_hash 每次重算（并入 S3）。`record_usage` 在 consume 后调用（streaming.rs:242）——O(1) 标量运算为主，正面。

---

## 二、正面发现（禁止回潮）

### P1. SSE 分帧 O(N) 单遍扫描 + 4MB pending 上限

- **位置**：`crates/agent-provider/src/sse/frame.rs:56-59,157-193`
- **现象**：旧实现每帧 `find_separator` 从头重扫导致 O(N²)（注释记载 30k 帧 debug >11s）；已改为单遍定位边界 + 一次 drain；pending 超 4MB fail-closed。
- **禁止回潮理由**：任何「每帧从头 find」或「无上限 pending」的改回都会在恶意/故障流下复现 OOM 或 O(N²)。回归锚点：frame 单测 + F3 压力注释。

### P2. abort biased select（stream 与 SSE reader 一致）

- **位置**：`session-loop/src/loop/handlers/streaming.rs:138-154`；`agent-provider/src/sse/reader.rs:230-246`
- **现象**：`tokio::select! { biased; abort; stream }`——abort 优先，取消挂起读。无不可中断 sleep（重试 sleep 同样 select abort，`retry_stream.rs:41-45`）。
- **禁止回潮**：去掉 biased 或改用裸 sleep 会拉长 force_cancel 延迟。

### P3. 工具快照 run 内一次锁定

- **位置**：`streaming.rs:444-475`（ensure_tools_snapshot）
- **现象**：首次构建后幂等复用，工具循环轮次间前缀字节稳定；不再每轮从注册表重建。
- **禁止回潮**：run 中途重建快照破坏 cache 前缀稳定性（P1 不变量）。

### P4. cache_tracker 增量消息哈希

- **位置**：`cache_tracker.rs:664-716`（build_request_signature_incremental）
- **现象**：system/tools 未变且前缀覆盖时只哈希新增消息，O(N)→O(新增)；压缩后强制全量重算路径正确。
- **禁止回潮**：退回每轮全量 message_hash 会在长对话每 turn O(M×blocks) 浪费。

### P5. 消息 Arc 共享（PE-09 T09.3.2）

- **位置**：`streaming.rs:659-682`；`handlers/mod.rs:232-273`
- **现象**：`Arc::new` 一次后对话与 start/end 事件共享同一份消息内存；serde 对 Arc 按 T 序列化，wire 不变。
- **禁止回潮**：start/end 各持 owned 消息会恢复 2× 正文驻留。

### P6. 全 workspace 无 block_in_place、热路径无 std Mutex 跨 await

- **位置**：全 workspace `rg block_in_place` 空；`engine_channels.rs:634-671`、`run_approval.rs:484-502`、`events.rs` push 链抽检
- **现象**：锁内只做同步短操作；DB/FS 经 spawn_blocking 或 async API。
- **禁止回潮**：在 runtime worker 上直接持 std Mutex 做 IO 会饿死 tokio 调度。

### P7. 工具并行组信号量限流

- **位置**：`exec_batch.rs:407-531`（Semaphore + join_all）
- **现象**：`max_parallel` 可配，默认有界；acquire_owned FIFO 排队不拒绝。
- **禁止回潮**：无界 join_all 会在大批工具时打爆系统文件句柄/进程数。

### P8. hydration 零拷贝对接 + 宽容水合

- **位置**：`hydrate.rs:34-49`；`loop_runner.rs:276-290`
- **现象**：`hydrate_history` → `Vec<Arc<AgentMessage>>` → `with_initial_conversation_arc` 无深拷贝；单条失败跳过不中断。
- **禁止回潮**：水合路径改回 owned Vec 再二次 map 会放大恢复期内存。

---

## 三、问题清单（八要素）

编号体系：`L4-<域><序号>`；域 S=streaming / O=orchestrator / P=provider / T=tool / K=锁与估算。

---

### L4-S1【高 / P0】流收口正文三连克隆（response.text + metadata.text + tool_calls）

- **位置**：`crates/session-loop/src/stream.rs:446-451,473-478`（finish / finish_after_abort）；`stream.rs:496`（metadata text）；`agent-provider/src/consume/mod.rs:313,344`（等价层同构）
- **现象**：`Aggregate` 按值进入 `finish` 后，仍对 `aggregate.text` 做 `.clone()` 塞进 `ProviderOutput::message`，同时 `build_message_metadata` 再 `text.clone()` 进 metadata；`tool_calls` 再深克隆一次。收口路径正文至少 **2 份完整 String 分配** + tool_calls 1 份 Vec 深拷贝。
- **代码现场**：
  ```rust
  // stream.rs:446-450
  let metadata = build_message_metadata(&aggregate, stop_reason, false, accounting);
  ConsumeResult {
      response: ProviderOutput::message(aggregate.text.clone(), aggregate.tool_calls.clone()),
      ...
  }
  // stream.rs:496
  metadata.insert("text".to_string(), Value::String(aggregate.text.clone()));
  ```
- **调用链**：consume_stream → builder.finish → finish → ProviderOutput::message → consume_classify → build_assistant_message(text.clone 其一由 consume 已付) → commit
- **根因**：聚合器与响应类型双持有「正文真相」；未用 `mem::take` 或 `Arc<str>` 收敛单一所有权。
- **影响量化**：静态分析——回复正文 B 字节时收口额外分配 ≥2B + tool_calls 深拷贝；B=50KB 时约 100KB+ 堆分配/turn；长回复（200KB）时单 turn 收口堆分配 ~0.5MB 级。随 turn 数线性累加。待运行时验证（V1）。
- **修复方案**：`finish` 内 `let text = std::mem::take(&mut aggregate.text)`、`let tool_calls = std::mem::take(&mut aggregate.tool_calls)` 后再 build metadata（metadata 若需 text，只在 Message 分支取一次引用写入，或 metadata 不再冗余存全文——需契约评审，因 metadata.text 可能有前端消费者）；短期安全版：response 用 take，metadata 保留 clone。agent-provider consume 层同步修。
- **回归风险**：低——不改 wire 形状（仍两处各持全文）；若选择 metadata 去冗余则升契约，单独评审。锁 `finish` 单测全绿。

---

### L4-S2【高 / P0】thought 逐 delta 独立成块——metadata/消息/收口三重放大

- **位置**：`stream.rs:288-291`（Aggregate::push ThoughtDelta）；`stream.rs:503-507`（thought_blocks serde）；`streaming.rs:604-617`（build_assistant_message 逐块重建）
- **现象**：每条 `ThoughtDelta` 存为独立 `ThoughtBlock { text, redacted }`；收口时 `serde_json::to_value(&thought_blocks)` 整表序列化进 metadata；`build_assistant_message` 再逐 block `to_string()` 重建 `AgentMessageBlock::Thought`。长思考（D 条 delta）时块数 = D，metadata 与消息 blocks 线性膨胀。
- **代码现场**：
  ```rust
  // stream.rs:288-291
  ProviderStreamEvent::ThoughtDelta { text, redacted } => {
      self.thought.push_str(&text);
      self.thought_blocks.push(ThoughtBlock { text, redacted });
  }
  // streaming.rs:609-616
  for block in blocks_value {
      if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
          blocks.push(AgentMessageBlock::Thought { text: text.to_string(), redacted: ... });
      }
  }
  ```
- **调用链**：SSE thought-delta → Aggregate → finish metadata.thoughtBlocks → build_assistant_message → commit_message_with_deltas → emit_message_deltas（每 Thought 块再一条收口 delta）
- **根因**：redacted 逐段保留的产品语义被实现为「每 delta 一块」，未做相邻同 redacted 段合并。
- **影响量化**：静态分析——思考 2k delta、平均每段 20 字节时：thought_blocks ≈ 2k 小对象 + serde 一次 + 消息内 2k Thought 块 + 收口轨 2k 条 MessageDelta（每条 block.clone）。相对「合并为单块」放大数十倍对象数与事件数。待运行时验证（V2）。
- **修复方案**：Aggregate 内合并相邻同 `redacted` 的 thought 段（或整流合并为单块 + redacted 标记集合/首段标记——需产品确认 redacted 粒度契约）；metadata.thoughtBlocks 与消息 blocks 从合并结果构建。**涉及 thoughtBlocks 事件/消息形态，升契约评审**。
- **回归风险**：中——前端若按 thoughtBlocks 段数做 UI 分段会受影响；需契约对齐。锁现有 pure_thought 测试改断言合并后形状。

---

### L4-S3【高 / P0】每请求 tools_schema().to_vec() ×2 + tools JSON 重序列化 ×2

- **位置**：`streaming.rs:62`（capture 用 to_vec）；`streaming.rs:425`（build_request to_vec）；`cache_tracker.rs:629-640`（tools_hash）；`compaction_dispatch.rs:104-116`（tools_prefix_json）
- **现象**：快照 `tools_snapshot` 已锁定，但每 provider 请求：
  1. `tools_schema(state).to_vec()` 克隆全部 ToolSchema 给 capture_signature；
  2. `build_request` 再 `to_vec()` 一次；
  3. `tools_hash` 再对每个工具 `json!({name.clone(), description.clone(), input_schema.clone()})` + `to_string`；
  4. `estimate_context` → `tools_prefix_json` 再做一遍 3 的克隆+序列化。
- **代码现场**：
  ```rust
  // streaming.rs:62
  let tools = tools_schema(state).to_vec();
  // streaming.rs:425
  tools: tools_schema(state).to_vec(),
  // cache_tracker.rs:630-640
  .map(|t| serde_json::json!({ "name": t.name.clone(), "description": t.description.clone(), "input_schema": t.input_schema.clone() }))
  ```
- **调用链**：handle → capture_signature(tools) → build_request(tools) → clamp → estimate_context(tools_prefix_json)
- **根因**：ToolSchema 未 Arc 化或未缓存「schema JSON 字符串 / 哈希」；capture 的 `to_vec` 仅为借用切片形态转换付了深拷贝。
- **影响量化**：静态分析——8 内置工具 schema 合计数 KB 时每 turn ~4 次全量克隆+2 次 JSON 序列化；注册 MCP 工具后 schema 变大，成本随工具数线性。对 8 工具量级影响中等，对工具很多的会话显著。待运行时验证（V3）。
- **修复方案**：`capture_signature` 改收 `&[ToolSchema]` 切片（已有快照，无需 to_vec）；tools_hash / tools_prefix_json 在快照构建时预计算并缓存于 `tools_snapshot` 旁（`Arc<str>` 或 `OnceLock`）；`build_request` 若 ProviderRequest.tools 可改借用则免 to_vec（AU-04 契约允许 owned 的话保留一次 Arc 共享）。
- **回归风险**：低——纯性能重构；缓存失效条件 = 快照重建（run 生命周期），与现语义一致。

---

### L4-S4【中 / P1】message metadata 冗余存全文 text/thought——与 body 双份驻留

- **位置**：`stream.rs:496-501`；`streaming.rs:641-645`（metadata 透传进 AgentMessage）
- **现象**：`build_message_metadata` 把 `aggregate.text` 与（非空时）`aggregate.thought` 全文写入 metadata；`build_assistant_message` 又把 metadata 整体 clone 进消息。消息结构上 blocks 已含正文，metadata.text 为历史兼容冗余。
- **调用链**：finish → metadata → build_assistant_message → AgentMessage.metadata → emit start/end（Arc 共享但 metadata 内已是第二份 String）
- **根因**：metadata 作为「标注面」混入了正文真相；未区分标注 vs 内容。
- **影响量化**：每 assistant 消息额外驻留 ≈ B（正文）+ T（思考）；与 S1 叠加后单消息可有 3 份正文。静态分析，待运行时验证。
- **修复方案**：契约评审——metadata 去掉 `text`/`thought` 全文键（或改 short hash/length）；前端若有消费者需迁移到 blocks。分批：先引擎侧标记 deprecated 不写全文（若前端已读 blocks），再删键。
- **回归风险**：中高——跨 IPC 契约与前端消费；必须 01/03 的契约清单联审。

---

### L4-S5【中 / P1】收口轨 emit_message_deltas 对全文块再 clone 进 events

- **位置**：`streaming.rs:712-726`；与 `handlers/mod.rs:173-179` emit_event 叠加
- **现象**：`commit_message_with_deltas` 在 start 与 end 之间对每个 Text/Thought 块 `block.clone()` 推入 `state.events`——即使实时轨已发过同内容 delta。大回复时 events 缓冲额外持有 ≈B 全文克隆。
- **调用链**：commit_message_with_deltas → emit_message_deltas → events.push → 收口 drive_outcome（03-R4 串行落库/再发）
- **根因**：收口序列「message-start → delta* → end」契约要求 delta 在场，但未区分「持久化记账」与「正文内容」——全文块被当作 delta 载荷。
- **影响量化**：与 03-R1/R2 叠乘：实时轨已传 B，收口 events 再持 B，收口 emit 再序列化（若 03-R2 双发未修则 wire 再 B）。静态分析。
- **修复方案**：短期：收口 delta 可改为 `block` 空壳/元数据级（需契约）；或 events 侧对 MessageDelta 用 `Arc` 块共享（`AgentMessageBlock` 不能直接 Arc，可把 delta 的 block 改 `Arc<AgentMessageBlock>`——契约变更）。与 03-L 批次合并评审。
- **回归风险**：中——序列契约冻结；不可静默删 delta。

---

### L4-S6【中 / P2】prepare_turn 内 hold→compact→record 与边界估算双扫

- **位置**：`prepare_turn.rs:49-61`；`compaction_dispatch.rs:217-229`
- **现象**：有 hold 消息时先 `maybe_compact_user_boundary`（内含 estimate_context），再逐条 `record_message`；record_message 每条又触发 MessageStart/End + pending_input DELETE spawn。边界压缩与 preflight 压缩若同 turn 触发会各自 estimate。
- **调用链**：dequeue → maybe_compact_user_boundary(estimate) → record_message×N → turn-start → maybe_compact_preflight(estimate) → streaming(clamp estimate)
- **影响量化**：同 turn 最多 3 次 estimate_context（O(M)×3）；多用户消息时 record_message 事件对 ×N。静态分析。
- **修复方案**：estimate 结果在 prepare_turn 内缓存复用（turn 级 once）；pending_input DELETE 可批量化（可选）。
- **回归风险**：低——缓存需在 conversation 变更（compact/record）后失效，注意边界压缩先于 record 的顺序。

---

### L4-S7【低 / P2】steering 检测尾部倒扫 + 每 tool-call JSON 序列化

- **位置**：`steering/strategy.rs:146-207`
- **现象**：`detect_repeated_tool_call_loop` 对尾部 assistant 每个 tool-call `serde_json::to_string(&call.input)` 做签名；`detect_recent_tool_error_loop` 倒扫 blocks。短路设计（遇 user 停）使常见路径便宜。
- **影响量化**：最坏（长工具链无 user 边界）O(工具调用数 × 入参大小)；典型路径可忽略。静态分析。
- **修复方案**：可选——tool-call 签名在 record 时缓存；非优先。
- **回归风险**：低。

---

### L4-O1【高 / P0】审计落库 worker：Unbounded 通道 + 串行 push_terminal_best_effort

- **位置**：`apps/agent-workbench/src-tauri/src/run/run_core.rs:149,194-215`；装配 `run_launch.rs:562`
- **现象**：`BridgeAuditSink.emit` 每事件 `persist.send(event.clone())` 进 UnboundedSender；单 worker 逐条 `queue.lock().await` + `push_terminal_best_effort`（内部仍 reserve+append 串行）。慢 DB / 全局锁竞争时：① mpsc 无界堆积 AgentEvent（含大 ToolEnd）；② worker 延迟传导到「落库尽力」语义但内存不设防。
- **代码现场**：
  ```rust
  // run_core.rs:149
  pub(crate) persist: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
  // run_core.rs:200-205
  while let Some(event) = rx.recv().await {
      let sequenced = queue.lock().await
          .push_terminal_best_effort(&session_id, event).await;
  }
  ```
- **调用链**：工具/安全事件 → BridgeAuditSink.emit → unbounded send → worker → EventQueue（全局 tokio Mutex）→ store
- **根因**：审计通道选了「不阻断 run」的 fire-and-forget，但未加水位/采样/有界背压；与实时轨共享 EventQueue 全局锁还引入锁竞争。
- **影响量化**：静态分析——工具批 10×100KB 输出时，若 DB 跟不上，队列峰值可达 MB–百 MB 级（叠加 03-R2 双发的事件克隆）。待运行时验证（V4）。
- **修复方案**：改为有界 channel + 满时降级（丢审计或合并为 run 级摘要）；或审计路径独立轻量 append 批量事务；与 03-R4 收口批量化同批。
- **回归风险**：中——审计「尽力而为」语义可保留，但丢弃策略需产品确认；锁顺序（audit queue vs 主 EventQueue）需防死锁。

---

### L4-O2【中 / P1】drive_outcome 逐事件 push 与审计 worker 抢同一把 EventQueue 锁

- **位置**：`orchestrator/src/events.rs:435-485`（drive_outcome）；`run_core.rs:200-205`
- **现象**：收口 drive_outcome 与审计 worker 共用 `Arc<tokio::sync::Mutex<EventQueue>>`；两边都串行 append，收口延迟被审计积压拉长（03-R4 只写了收口侧，未写双生产者）。
- **影响量化**：静态分析——审计积压时收口 drive_outcome 等锁时间上升；与 O1 叠加。
- **修复方案**：审计独立队列/连接；或 EventQueue 拆「实时收口」与「审计」两个 Mutex 域（需序列号分配语义评审——sequence 会话级单调依赖单点）。
- **回归风险**：高——sequence 分配点必须仍单点；优先做 O1 有界化再评估是否拆锁。

---

### L4-O3【中 / P2】EventQueue 本地镜像 last_reserved 单点热路径

- **位置**：`events.rs:216,246` 附近 reserve 逻辑；`next_sequences` 缓存（run_core.rs:238-239）
- **现象**：每事件 reserve 走 store（03-R3 已写 NoPersist 白付）；本地 last_reserved 在 Mutex 内更新，高频事件下锁竞争与 SQL 放大同源。
- **处理**：交叉引用 03-R3/R4，本文不重复展开；修复归 03 批次 K。
- **回归风险**：见 03。

---

### L4-O4【低 / P3】restore_snapshot 路径 std::fs 与异步边界

- **位置**：`orchestrator/src/restore_snapshot.rs:327-376`；壳层 `run_snapshot.rs:90-101` 已 spawn_blocking
- **现象**：restore_snapshot 本体是同步 fs；生产经壳层 spawn_blocking 覆盖。若未来直接在 async 调用会阻塞 worker。
- **修复方案**：文档/注释钉死「仅允许 spawn_blocking 调用」；或 API 改 `async fn` 内部 spawn_blocking。
- **回归风险**：低。

---

### L4-P1【高 / P0】agent-provider consume 等价层全文 clone 同构（接线切换时的暗雷）

- **位置**：`agent-provider/src/consume/mod.rs:313,344`
- **现象**：与 L4-S1 完全同构的 `aggregate.text.clone()` + `tool_calls.clone()`。当前 session-loop 用自带 stream.rs 等价层；一旦按 stream.rs 头注「可将本层整体替换为 agent-provider::consume」接线，会原样继承收口双 clone。
- **影响量化**：静态分析——与 S1 同量级；当前生产路径未接线故标「潜伏」，但高优先修复以免切换时回归。
- **修复方案**：与 S1 同步用 `mem::take` 修 consume 层，保持两层等价语义一致（有对比测试 consume_builder_matches_consume）。
- **回归风险**：低。

---

### L4-P2【中 / P1】每请求全历史 to_chat_messages 重建 wire 消息

- **位置**：`agent-provider/src/request/messages.rs:264-360`；`build_chat.rs:111+`
- **现象**：每次 provider 请求把全部对话映射为 `Vec<ChatMessage>`（内容 clone/JSON 序列化 tool args、content parts）。无「前缀 wire 缓存 + 增量追加」。这是 LLM 请求构建常态，但长历史下 O(M×平均消息体) 每 turn 重付。
- **调用链**：build_request → to_chat_messages_with_compat → HTTP body serde
- **根因**：wire 映射依赖动态 compat/cache 断点，难以简单缓存全量；但「纯追加且断点计划未变」的尾部可增量。
- **影响量化**：M=200、平均 2KB/条时每 turn 约数百 KB 映射+序列化；与 compaction 引擎互补（压缩后 M 变小）。静态分析，待运行时验证（V5）。
- **修复方案**：优先级低于 S1/S2——可在 wire 层缓存「已映射前缀的 serde_json::Value 数组」，仅对新消息增量 append（断点计划变化时全量失效）。
- **回归风险**：中——compat/断点语义复杂，需 request 测试海保护。

---

### L4-P3【低 / P2】first-byte/idle 超时每次 select 新建 sleep 定时器

- **位置**：`sse/reader.rs:229-240`
- **现象**：每 chunk 读取新建 `tokio::time::sleep(duration)`；块数多时定时器创建开销累计（通常可忽略，因每块已有 IO）。
- **修复方案**：可选 `timeout()` 包装或复用 deadline；非优先。
- **回归风险**：低。

---

### L4-T1【高 / P0】工具结果路径多次 serde_json::Value 深克隆 + 每结果全消息事件对

- **位置**：`executing_tools.rs:103-105,184-195,427-465`
- **现象**：
  1. 每结果 `record_message` → MessageStart/End + emit_event 深克隆；
  2. `tool_output_from_result` / `tool_output_from_parts` 对同一 `output: &Value` 做 `from_value(output.clone())` 或 `json: Some(output.clone())` 多次；
  3. ToolEnd 事件全量透传 output（03-C2 IPC 面；引擎 events 缓冲同样持有一份）。
- **代码现场**：
  ```rust
  // executing_tools.rs:184,188
  serde_json::from_value(result.output.clone()).unwrap_or_default()
  json: Some(result.output.clone()),
  // 453,457,463 同型
  ```
- **调用链**：execute_batch → emit_tool_events(ToolEnd) → tool 角色 record_message → tool_output_from_result
- **影响量化**：K 工具 × 输出 O 字节 × 3–4 次克隆 ≈ 3KO–4KO 额外分配/批；大工具输出（读大文件）时单批 MB 级。与 03 截断方案（R6）互补。静态分析，待运行时验证（V6）。
- **修复方案**：output 全程 `Arc<Value>` 或一次构造 ToolOutput 后 `Arc` 共享进消息块与事件；或 tool 角色消息与 ToolEnd 共享同一 `Arc<ToolOutput>`。需 types 层小改。
- **回归风险**：中——AgentEvent 序列化形状不变（Arc transparent），但类型改动波及面广；可分阶段：先 `mem::take` 减少同函数内重复 clone。

---

### L4-T2【中 / P1】BatchStart/End 的 calls 摘要在第二遍发射时整体 clone

- **位置**：`executing_tools.rs:229-284,409-417`
- **现象**：`calls_summary` / `results_summary` 聚合后，`ToolBatchStart.calls: calls_summary.clone()`、`ToolBatchEnd.calls: results_summary.clone()`——摘要本身不大（input/output 已 Null），但模式与 S3 同型：为借用生命周期付整表克隆。
- **影响量化**：批大小 K 时 2 次摘要表克隆；K 大时可见。静态分析。
- **修复方案**：先构造 start/end 事件再发射，或 `Arc<Vec<...>>`。
- **回归风险**：低。

---

### L4-T3【低 / P3】approval 参数在 ToolStart 与 ApprovalRequested 双份克隆

- **位置**：`executing_tools.rs:286-341`
- **现象**：`input.clone()` 进 ToolStart.call，`args.clone()` 进 ApprovalRequested.parameters——审批路径双重持参。
- **影响量化**：仅审批开启且入参大时；频率低。
- **修复方案**：Arc 共享 args。
- **回归风险**：低。

---

### L4-T4【低 / P3】pending_input save/delete fire-and-forget 任务无背压

- **位置**：`loop_runner.rs:350-375`；`handlers/mod.rs:243-257`
- **现象**：每入队/消费用户消息 `handle.spawn` 一个 DB 任务，无 JoinHandle、无并发上限。慢 DB 时任务数 = 未完成消息数。
- **影响量化**：用户消息频率低，典型可忽略；异常注入/回放时可能堆积。
- **修复方案**：单会话串行 task 队列或有界 channel。
- **回归风险**：低（fail-open 语义保留）。

---

### L4-K1【高 / P0】estimate_context：每请求新建引擎 + 全对话扫描 + 工具 JSON 重序列化

- **位置**：`compaction_dispatch.rs:92-116`；调用点 `streaming.rs:440`、`compaction_dispatch.rs:180,226`；实现 `conex-compaction/src/engine.rs:163-171`
- **现象**：
  1. `CompactionEngine::new(0)` 每次调用新建（廉价但无意义）；
  2. `estimate_context_tokens` 对对话倒扫找 usage + 尾随块级启发式（usage 未命中时全扫）；
  3. `tools_prefix_json` 每次克隆并序列化全部工具 schema 为 String；
  4. 同一 turn 内 clamp / preflight / boundary 最多调 3 次（S6）。
- **调用链**：build_request → clamp_request_max_tokens → estimate_context → tools_prefix_json + estimate_context_tokens
- **根因**：估算未缓存 turn 级结果；工具 JSON 未随快照预计算；引擎为值类型无复用面。
- **影响量化**：M 消息、对话体大时每 turn 至少 1 次 O(M) 块级扫描；与 P2 的 wire 重建叠加，长对话每 turn 固定税。静态分析，待运行时验证（V1 与 V3 交叉）。
- **修复方案**：① tools_prefix_json 预计算进快照旁路缓存；② estimate 结果以 `conversation.len()+last_compaction_at+tools_hash` 为 key 在 LoopState 缓存，conversation 变更失效；③ 引擎改 `&'static` 或线程局部复用。usage 命中路径已是 O(1) 优先，保持。
- **回归风险**：低-中——缓存失效必须覆盖 compact/steering 注入/record_message；单测锁 estimate 与手动全扫一致。

---

### L4-K2【中 / P1】emit_event 对全变体深克隆——非 Arc 变体双份驻留

- **位置**：`handlers/mod.rs:173-179`
- **现象**：`events.push(event.clone())` 后 `push_live(event)`——clone 对 Arc 消息变体廉价，但对 `MessageDelta.block`、`ToolEnd.result`、`ToolBatchStart.calls` 等 owned 变体是深拷贝。每 delta 已在 S-a 付过一次 clone 构造事件，这里再 clone 进 events。
- **调用链**：emit_event → events + live_sink
- **影响量化**：与 S1/S5/T1 叠乘；delta 路径每条事件 2 份 block 内容（live 一份、events 一份）。静态分析。
- **修复方案**：live 与 persist 轨对 delta 用 `Arc` 信封；或 events 轨对可丢类目不存全文（收口记账用元数据）——需与 03-R 契约批合并。
- **回归风险**：中——事件类型共享语义变更。

---

### L4-K3【中 / P2】capture_signature 克隆完整 last_signature（含 message_hashes 向量）

- **位置**：`cache_tracker.rs:183-190,701-706`
- **现象**：增量路径 `prev.message_hashes` move 复用正确；但 `self.last_signature = Some(sig.clone())` 每 turn 克隆含 N 个 u64 的向量 + pending 又持一份。N 大时（数千消息）向量克隆可见。
- **影响量化**：N=2000 时 ≈16KB 向量 ×2/turn——相对正文克隆较小。静态分析。
- **修复方案**：`pending_signature` 与 `last_signature` 用 `Arc<RequestSignature>` 共享。
- **回归风险**：低。

---

### L4-K4【中 / P1】finish 时 Aggregate 内 thought 字符串与 thought_blocks 双持有

- **位置**：`stream.rs:288-290,497-507`
- **现象**：`thought` 聚合字符串与 `thought_blocks` 逐段文本并存；收口 metadata 同时写 `thought` 全文与 `thoughtBlocks` 数组——思考内容在 Aggregate 内已 2 份，序列化后 metadata 再 2 份键。
- **影响量化**：思考 T 字节时 Aggregate ≈2T + metadata ≈2T。与 S2 叠加。静态分析。
- **修复方案**：blocks 可重建 thought（拼接）时收口只保留 blocks；或只保留 thought 字符串 + redacted 区间列表。契约评审。
- **回归风险**：中——thought/thoughtBlocks 双键契约。

---

### L4-K5【低 / P3】run_history 缓存 Mutex 临界区含 clone

- **位置**：`run/run_history.rs:55-74`
- **现象**：缓存读写在 std Mutex 内 clone 条目；临界区短，争用低。
- **修复方案**：可选 Arc 值。
- **回归风险**：低。

---

## 四、随规模恶化矩阵（问题 → 恶化轴）

| 恶化轴 | 命中问题 | 说明 |
| ------ | -------- | ---- |
| 回复正文长度 B | S1, S4, S5, K2 | 收口/事件/IPC 多重放大 |
| 思考 delta 数 D | S2, K4, S5 | 逐 delta 成块 |
| 对话历史消息数 M | K1, P2, S6 | 每请求估算+wire 重建 |
| 工具输出大小 O | T1, O1 | Value clone + 审计堆积 |
| 工具数量 K | S3, T1, T2 | schema clone + 事件对 |
| MCP 工具 schema 体积 | S3, K1 | tools JSON 序列化 ×4/turn |
| DB 变慢 | O1, O2 | 无界审计队列 |

---

## 五、修复路线图（续 03 K–O + 新增 P–S）

> 原则：不动 IPC 契约的先做；动 thoughtBlocks / metadata.text / delta 载荷的进契约批。

### 批次 K（03 已有 · 引擎减负重叠项）——本文补充验收点

- 文件：`events.rs`、`conex-db/events.rs`、`engine_channels.rs`、`handlers/mod.rs`、`executing_tools.rs`
- 本文追加：**K 批必须同步修 L4-K2（emit_event clone）与 L4-T1 的 mem::take 减 clone 子集**

### 批次 L / O（03 契约批）——本文追加范围

- **L 扩展**：S2 thoughtBlocks 合并、S4 metadata 去全文、S5 收口 delta 载荷、K4 thought 双持有——同一轮契约评审
- **O 扩展**：K2 Arc 事件信封

### 批次 P（新 · provider 收口零 clone）

| ID | 项 | 依赖 |
| -- | -- | ---- |
| P-1 | consume 层 mem::take 修 L4-P1 | 无 |
| P-2 | session-loop stream.rs finish mem::take 修 L4-S1 | 无 |
| P-3 | 两层等价测试保持 | P-1/P-2 |

### 批次 Q（新 · 估算与工具快照缓存）

| ID | 项 | 依赖 |
| -- | -- | -- |
| Q-1 | tools_prefix_json / tools_hash 预计算缓存（S3） | 无 |
| Q-2 | capture_signature 收切片免 to_vec（S3） | 无 |
| Q-3 | estimate_context turn 级缓存（K1） | Q-1 |
| Q-4 | cache_tracker Arc<RequestSignature>（K3） | 无 |

### 批次 R（新 · 审计通道有界化）

| ID | 项 | 依赖 |
| -- | -- | ---- |
| R-1 | Unbounded → 有界 + 丢弃策略（O1） | 产品确认 |
| R-2 | 评估 audit 与主 EventQueue 拆锁（O2） | R-1 后 |
| R-3 | 与 03-R4 收口批量化协同 | 03-K |

### 批次 S（新 · 工具输出共享）

| ID | 项 | 依赖 |
| -- | -- | -- |
| S-1 | tool_output 一次构造 + Arc 共享消息/事件（T1） | types 小改 |
| S-2 | 批摘要 Arc（T2） | 无 |
| S-3 | 审批 args Arc（T3） | 无 |

**性价比排序（静态）**：P-1/P-2（收口零 clone）> Q-1/Q-3（长对话固定税）> S-1（大工具输出）> R-1（稳定性）> 契约批 L 扩展。

### 五.1 批次依赖与并行建议

```
无依赖可并行：
  P-1/P-2  （stream finish mem::take）
  Q-1/Q-2  （tools 缓存与免 to_vec）
  Q-4      （cache_tracker Arc）
  S-2/S-3  （摘要/审批 Arc）

需等契约或产品确认：
  L 扩展（thoughtBlocks / metadata.text / delta 载荷 / thought 双持有）
  R-1（审计丢弃策略）
  S-1（ToolOutput Arc——types 面）

在 03-K 之后：
  K2（emit_event Arc 信封）与 03 双发/收口批量化同轮，避免两次动事件形状
```

### 五.2 每批验收标准（引擎侧）

| 批 | 验收断言 |
| -- | -------- |
| P | `finish` 路径对 Aggregate 的 text/tool_calls `mem::take`；consume_builder 等价测试全绿；V1 收口分配下降 |
| Q | tools_prefix 全 run 序列化次数 = 1；estimate 缓存命中计数可观测；与手动全扫结果 bit 级一致（单测） |
| R | 审计队列深度 ≤ 配置水位；超水位路径有明确 tracing；run 收口仍 await 排空（或明确丢弃） |
| S | 单工具 1MB 输出时 clone 计数 ≤1 次深拷贝；ToolEnd wire 形状不变 |
| L | 契约 diff 评审记录；前端 01 消费面回归；registry_drift 更新 |

---

## 六、运行时验证计划

> 全部场景在 debug 构建 + `npm run dev:workbench` 真宿主执行；观测用 tracing / 既有 perf 钩子 / cargo bench，**不使用 9222 CDP**。

| ID | 场景 | 指标 | 验证问题 | 通过判据（建议） |
| -- | ---- | ---- | -------- | --------------- |
| V1 | 单 turn 大回复（50KB/200KB 文本） | 收口段 heap 采样 / 分配计数 | S1/S4/S5 | 修复后收口额外分配 <0.5×B |
| V2 | 长思考流（≥2000 thought-delta） | events 长度、metadata.thoughtBlocks.len、对象数 | S2 | 合并后 blocks.len 与 redacted 段数同阶，非 delta 数 |
| V3 | 8 工具 + 30 MCP 工具会话，20 turn | tools JSON 序列化耗时（现有 slow serialize 告警点） | S3/K1 | tools_prefix 只序列化 1 次/run |
| V4 | 慢 DB 模拟（append 延迟注入，persist.rs 已有 delay 钩子） | 审计队列深度、RSS | O1 | 有界后队列 ≤ 水位，不随时间线性涨 |
| V5 | 长历史 200 消息请求构建 | build 请求体耗时 | P2 | 增量 wire 缓存后耗时与新增消息数相关 |
| V6 | 单工具 1MB 输出批（8 并行） | ToolEnd+record 路径分配 | T1 | clone 次数从 3–4 降为 ≤1 |
| V7 | 全程 force_cancel 中断流 | abort 端到端延迟 | P2 正面 | 不因修复变差（锁回归） |
| V8 | 对话 500 消息 + 每 turn clamp | estimate_context 调用计数与耗时 | K1/S6 | turn 级缓存命中后 ≤1 次全扫 |
| V9 | 审计通道压力（快速 1000 小事件） | unbounded 深度 vs 有界丢弃计数 | O1/R-1 | 有界后 RSS 平稳 |
| V10 | cache_tracker 500 消息增量签名 | signature 捕获耗时 | K3 | Arc 共享后无向量深拷贝尖峰 |

方法：`cargo flamegraph` / `dhat` / `tracing` 慢序列化阈值（`engine_channels.rs:532-553`）；禁止 CDP，用日志与 bench。修复后重跑 V1/V2/V3 为合入门禁建议。

---

## 七、交叉引用

| 来源 | 关系 |
| ---- | ---- |
| 03-R1 token 逐条 emit | 本文 S-a 只补 clone 链与 flush；IPC 体积归 03 |
| 03-R2 非增量双发 | 本文 S5 补 events 缓冲全文持有 |
| 03-R3 NoPersist 取号 | 不重复；O3 指回 |
| 03-R4 收口串行 | 本文 O1/O2 补审计双生产者与无界通道 |
| 03-R5 实时轨 flush | 确认仍在 BridgeLiveSink（engine_channels.rs:715-721） |
| 03-C2 ToolEnd 全量 | 本文 T1 补引擎侧 Value clone |
| 02-X2 PTY 零合批 | 范围外（pty），不展开 |
| 01 流式渲染 | S2 thought 块数会传导前端 01/M 系问题——修复需前后端联审 |
| 05 SQLite | O1 有界化与 05 批量写同批设计 |
| 13 Compaction | K1 估算缓存与 13 压缩触发共享 estimate 真值 |

---

## 八、附录

### 8.1 覆盖面清单

| 范围锁条目 | 覆盖 | 备注 |
| ---------- | ---- | ---- |
| session-loop loop_runner | ✅ | builder/装配/pend spawn |
| streaming | ✅ | consume/commit/delta |
| executing_tools | ✅ | 事件对/clone |
| prepare_turn | ✅ | hold/compact/双 estimate |
| steering | ✅ | 尾扫/JSON 签名 |
| hydrate | ✅ | 正面 P8 |
| rollback / checkpoint | ✅ 走读 | 热路径外低频，无新增高危 |
| compaction_dispatch | ✅ | estimate/tools_prefix |
| attachment_* | ✅ 走读 | 预算钳制同步、无 async 阻塞 |
| cache_tracker | ✅ | 增量签名正面 + K3 |
| tool_exec / exec_batch | ✅ | 信号量正面 + T 域 |
| state | ✅ | events Vec 生命周期 |
| orchestrator events/drive_outcome/EventQueue | ✅ | + 03 交叉 |
| run/* engine_channels | ✅ | 审计 worker/缓冲/flush |
| agent-provider SSE/retry | ✅ | 正面 P1/P2/P3 + P1/P2/P3 问题 |
| 全 workspace 阻塞/锁/spawn/busy | ✅ | 见 materials |

### 8.2 严重度判定理由汇总

| 级 | 判据 | 本文例 |
| -- | ---- | ------ |
| 高 | 随 B/D/M/O 线性放大且处于每 turn 必经路径；或无界内存面 | S1,S2,S3,O1,P1,T1,K1 |
| 中 | 放大但有界/频率较低/契约耦合需分批 | S4,S5,S6,O2,P2,T2,K2,K4 |
| 低 | 临界区短、路径低频、或纯工程债 | S7,O4,P3,T3,T4,K3,K5 |

### 8.3 关键文件索引

```
crates/session-loop/src/stream.rs
crates/session-loop/src/loop/handlers/streaming.rs
crates/session-loop/src/loop/handlers/mod.rs
crates/session-loop/src/loop/handlers/executing_tools.rs
crates/session-loop/src/loop/handlers/prepare_turn.rs
crates/session-loop/src/loop/compaction_dispatch.rs
crates/session-loop/src/cache_tracker.rs
crates/session-loop/src/loop/loop_runner.rs
crates/session-loop/src/steering/strategy.rs
crates/session-loop/src/hydrate.rs
crates/orchestrator/src/events.rs
crates/agent-provider/src/sse/frame.rs
crates/agent-provider/src/sse/reader.rs
crates/agent-provider/src/consume/mod.rs
crates/agent-provider/src/retry_stream.rs
crates/agent-provider/src/request/messages.rs
apps/agent-workbench/src-tauri/src/engine_channels.rs
apps/agent-workbench/src-tauri/src/run/run_core.rs
apps/agent-workbench/src-tauri/src/run/run_launch.rs
```

### 8.4 与 03 报告发现计数对照（避免重复计数）

| 03 ID | 主题 | 04 处理 |
| ----- | ---- | ------- |
| R1 | token 逐条 emit | 交叉引用；本文只补 Aggregate/clone 链 |
| R2 | 双发 | 交叉引用 + S5 引擎侧 events 持有 |
| R3 | NoPersist 取号 | 不重复 |
| R4 | 收口串行 | 交叉引用 + O1/O2 审计双生产者扩展 |
| R5 | flush 形同虚设 | 确认 BridgeLiveSink 仍在（engine_channels.rs:715-721） |
| C2 | ToolEnd 全量 | T1 引擎侧 Value clone 计数 |
| P10 | 锁纪律 | 确认仍成立 → 正面 P6 |
| I1 | save_session_body | 方向 05 边界，本文不展开 |
| V 域 | 前端解析 | 与本文 S2 thought 块数正交；修复需联审 |

### 8.5 本文未覆盖 / 留给其他方向

| 项 | 归属 | 原因 |
| -- | ---- | ---- |
| PTY 读循环合批 | 02-X2 | 范围锁不含 pty/ |
| SQLite append 本体 | 05 | 本文只到 EventQueue 调度 |
| conex-fs 同步 IO | 06 | 热路径外 |
| spawn_blocking 线程池容量 | 16 | 可观测性向 |
| relay/telemetry 通道 | 15 | 非 run 热路径 |

### 8.6 术语

| 术语 | 含义 |
| ---- | ---- |
| 实时轨 | sequence=None、立即 flush 至 WebView 的事件路径 |
| 收口轨 | run 结束 drive_outcome 序列化取号落库路径 |
| 审计轨 | BridgeAuditSink → unbounded mpsc → push_terminal_best_effort |
| 三连克隆 | 同一份正文在 finish 内被 clone 进 response/metadata/tool_calls 三处 |
| 固定税 | 每 turn 必付、与内容大小/历史长度成正比的无缓存成本 |

---

_报告完 · 方向 04 · 2026-09-12 · 静态分析，待 V1–V10 运行时回填_
