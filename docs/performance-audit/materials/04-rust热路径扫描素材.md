# 04 · Rust 引擎热路径扫描素材（原始走读摘录）

> 战役：性能审查 · 方向 04 · Rust 引擎热路径
> 方法：静态代码走读（read + rg）；未实测处统一标注「静态分析，待运行时验证」
> 范围锁：session-loop / orchestrator / src-tauri run+engine_channels / agent-provider / 全 workspace 阻塞与锁纪律

## 一、扫描命令与命中摘要

### 1.1 阻塞调用混入 async（block_in_place / std::fs / std::process / thread::sleep）

- `block_in_place`：全 workspace **零命中**（`rg "block_in_place"` 空）——正面。
- `std::fs` / `std::process` 裸调（非测试）：
  - `orchestrator/src/restore_snapshot.rs:327-376`（snapshot write/read/rename——壳层已有 spawn_blocking 覆盖路径，见 `run_snapshot.rs:90-101`）
  - `conex-fs` 多处（方向 06 范围，不展开）
  - `conex-computer` screen.rs:411-412（spawn_blocking 闭包内，OK）
- `std::thread::sleep` 生产路径：`conex-fs/watch.rs`、`conex-computer/desktop_capture.rs`（方向 06/14 范围）；session-loop / orchestrator / agent-provider / run 热路径 **零命中**。

### 1.2 无界 channel

- `apps/agent-workbench/src-tauri/src/run/run_core.rs:149,158,197`：`UnboundedSender<AgentEvent>` 审计落库通道——单 worker 串行消费；慢 DB 时内存堆积面。
- `run_launch.rs:562`：`mpsc::unbounded_channel()` 装配点。
- `agent-provider` 的 unbounded 仅测试侧（reader.rs tests）。

### 1.3 tokio::spawn 泄漏面

- `loop_runner.rs:350-375` spawn_pending_input_save：fire-and-forget，无 JoinHandle 持有；run 收口不等待——fail-open 语义有意为之，但高频入队时任务数无上限（静态分析）。
- `handlers/mod.rs:243-257` record_message 删 pending_input：同型 fire-and-forget。
- transport `tokio::spawn` 超时看门狗（agent-provider/transport/mod.rs:116-181）：与 request 生命周期绑定。

### 1.4 锁跨 await

- session-loop / orchestrator / agent-provider / run 热路径：**未发现** std Mutex 守卫跨 await 持有（抽查 engine_channels.rs:634/661-666、events.rs push、run_approval.rs:484-502 注释与代码一致）。
- 例外（非本方向核心）：`auth_daemon.rs` 用 tokio::RwLock（合法跨 await）；`browser/mod.rs:381` tokio Mutex。

## 二、热点代码现场（按域）

### 2.1 S 域 · streaming / consume

#### S-a 每 delta 全链 emit（与 03-R1 同源，引擎侧补充）

```
// streaming.rs:160-172
if let Some(sink) = delta_sink {
    if let Some(delta) = delta_to_message_event(&session_id, assistant_message_id, &event) {
        sink.push(delta);
    }
}
builder.push(event);
```

`delta_to_message_event`（:689-708）：`text.clone()` + `session_id.to_string()` + `message_id.to_string()` + `now_iso_utc()` 每 delta 一次。

`BridgeLiveSink::push`（engine_channels.rs:715-721）：emit + **立即 flush**——缓冲层对实时轨零贡献。

#### S-b 流收口全文三连克隆

```
// stream.rs:446-451
let metadata = build_message_metadata(&aggregate, stop_reason, false, accounting);
ConsumeResult {
    response: ProviderOutput::message(aggregate.text.clone(), aggregate.tool_calls.clone()),
    ...
}
```

`build_message_metadata`（:496）再 `metadata.insert("text".into(), Value::String(aggregate.text.clone()))`——**正文至少 2 次完整 String 克隆**（response.text + metadata.text），tool_calls 再 1 次 Vec 深克隆。thinking 流同样：`thought` 克隆进 metadata + `thought_blocks` serde 再序列化一次。

`aggregate` 此时按值移动进 finish（self），本可 `mem::take` 免克隆。

#### S-c thought 逐 delta 一条 ThoughtBlock（随思考 token 数线性放大）

```
// stream.rs:288-291
ProviderStreamEvent::ThoughtDelta { text, redacted } => {
    self.thought.push_str(&text);
    self.thought_blocks.push(ThoughtBlock { text, redacted });
}
```

每条 thought-delta 存为独立块；收口 `serde_json::to_value(&thought_blocks)`（:506）+ `build_assistant_message` 逐块重建 AgentMessageBlock（streaming.rs:609-617）。长思考（数百 delta）时 metadata 与消息 blocks 数量 = delta 数。

#### S-d 每请求 tools 全量 to_vec ×2

```
// streaming.rs:62  — capture_signature 用
let tools = tools_schema(state).to_vec();
// streaming.rs:425 — build_request 用
tools: tools_schema(state).to_vec(),
```

快照本身锁定一次（ensure_tools_snapshot，正面），但每 turn **两次** `to_vec` 深克隆全部 ToolSchema（8 内置工具 + MCP 时更多）。tools_hash / tools_prefix_json 还各自再 `serde_json::json!` 克隆 name/description/input_schema（cache_tracker.rs:629-640、compaction_dispatch.rs:104-116）。

#### S-e estimate_context 每调用 O(N) 全对话扫描 + 工具 JSON 重序列化

```
// compaction_dispatch.rs:92-99
pub(crate) fn estimate_context(state: &LoopState) -> EstimateContext {
    let engine = CompactionEngine::new(0);  // 每次新建
    engine.estimate_context_tokens(
        &state.conversation,
        tools_prefix_json(state).as_deref(),  // 每次序列化全部工具 schema
        ...
    )
}
```

调用点：
1. `clamp_request_max_tokens`（streaming.rs:440）——**每个 provider 请求**必调；
2. `maybe_compact_preflight`（compaction_dispatch.rs:180）——每 prepare_turn；
3. `maybe_compact_user_boundary`（:226）——有 hold 消息时。

usage 命中路径仍需 `find_usage_message` 倒扫 + 尾随消息块级启发式；usage 未命中时全对话块级估算。**与对话长度 O(N) 恶化**。

#### S-f emit_event 一律深克隆事件入持久轨

```
// handlers/mod.rs:173-179
pub(crate) fn emit_event(&mut self, event: AgentEvent) {
    self.events.push(event.clone());
    if let Some(sink) = &self.options.hooks.live_sink {
        sink.push_live(event);
    }
}
```

`AgentEvent` 含 owned 字段的变体（MessageDelta.block、ToolEnd.result 等）每次克隆一份。message-start/end 走 Arc 共享（正面），但 delta/tool 事件仍深克隆。

#### S-g 收口轨再次 emit 全文 delta

```
// streaming.rs:712-726 emit_message_deltas
for block in &message.blocks {
    if matches!(block, Text | Thought) {
        state.events.push(AgentEvent::MessageDelta {
            block: block.clone(),  // 全文块再克隆一遍进 events
            ...
        });
    }
}
```

与实时轨 delta 内容重叠（03-R1 已述 IPC 双轨）；引擎侧 events 缓冲同样承受全文克隆。大回复时 events 内存 ≈ 2× 正文。

### 2.2 O 域 · orchestrator events / EventQueue

#### O-a EventQueue::push 逐条 await（与 03-R4 同源，引擎侧确认）

```
// events.rs:246-280
let sequence = match self.reserve(session_id).await { ... };
if is_non_persistent(&event) {
    return Ok(SequencedEvent { sequence, event, persisted: false });
}
let payload = serde_json::to_string(&envelope)...;
self.store().append_event(...).await...
```

NoPersist 事件仍先 reserve（3 SQL）再判定——与 03-R3 完全一致，本报告只交叉引用不重复展开。

#### O-b 审计 worker 串行消费无界通道

```
// run_core.rs:194-215
while let Some(event) = rx.recv().await {
    let sequenced = queue.lock().await
        .push_terminal_best_effort(&session_id, event).await;
}
```

单 worker + UnboundedReceiver：慢盘/锁竞争时 mpsc 队列无界增长（内存面）。

### 2.3 P 域 · agent-provider SSE / 重试

#### P-a SSE 分帧已修复 O(N)（正面）

`frame.rs:157-193`：单遍扫描 split_frames + 4MB pending 上限（F3 #5）。**禁止回潮**。

#### P-b consume 收口同样全文 clone（与 S-b 同构）

`consume/mod.rs:313,344`：`aggregate.text.clone()` + `tool_calls.clone()`——与 session-loop 等价层同模式，若接线切换为共享 consume 时需一并修。

#### P-c 重试 sleep 可中断（正面）

`retry_stream.rs:41-45`：`tokio::select! { abort, sleep }`——无不可中断 sleep。

### 2.4 T 域 · tool 执行结果

#### T-a ToolOutput 多次 serde_json Value clone

```
// executing_tools.rs:184,188,195,453,457,463
serde_json::from_value(result.output.clone())...
json: Some(result.output.clone()),
```

同一 output Value 在 tool 角色消息与 ToolEnd 事件路径各克隆多次；tool-end 全量透传（03-C2 已述 IPC 面；引擎侧 events 缓冲同样承受）。

#### T-b 每个工具结果 record_message 全事件对

```
// executing_tools.rs:103-105
for result in &outcome.results {
    record_message(state, tool_result_message(result));
}
```

N 工具 → N×(MessageStart+MessageEnd) + 每次 emit_event 再 clone。批内 8 工具 ≈ 16 事件对 + tool-start/end 8+8。

### 2.5 K 域 · 锁 / spawn / busy loop

| 项 | 位置 | 结论 |
| --- | ------ | ---- |
| block_in_place | workspace | 零命中 |
| std Mutex 跨 await | 热路径 | 零命中（抽查） |
| 无界 persist 通道 | run_core.rs:149 | 有，O-b |
| busy loop | session-loop 热路径 | 无（approval 测试 sleep 30ms 非生产） |
| orphan reaper interval | run_commands.rs:966 | 定时器非 busy loop |
| tools snapshot | streaming.rs:464-475 | run 内一次，正面 |
| cache_tracker 增量哈希 | cache_tracker.rs:678-715 | append-only O(新增)，正面 |
| abort biased select | streaming.rs:139-146 / reader.rs:230-246 | 正面 |
| Arc 消息共享 | streaming.rs:665-674 / record_message | 正面 |

## 三、与 01–03 的边界备忘

| 本方向条目 | 03 已写 | 本报告处理 |
| --------- | ------- | --------- |
| token 逐条 emit + 契约禁合并 | 03-R1 | 交叉引用；只补引擎侧 clone 链 |
| 非增量事件双发 | 03-R2 | 交叉引用；S-g 补 events 缓冲面 |
| NoPersist 白付取号 | 03-R3 | 不重复 |
| 收口串行 push | 03-R4 | 不重复；O-b 补审计 worker |
| 实时轨 flush 形同虚设 | 03-R5 | 交叉引用 |
| PTY 零合批 | 02-X2 | 范围外（pty/session），交叉引用 |
| 锁不跨 await | 03-P10 | 确认仍成立，正面清单 |

## 四、影响量化模型（静态推导，待运行时验证）

设：一次 run 有 T turn、每 turn 平均 D 条 text-delta、回复正文 B 字节、工具批平均 K 个、工具输出平均 O 字节、对话历史消息数 M。

| 热点 | 复杂度/体积 | 量级示例 |
| ---- | ---------- | -------- |
| S-a/S-b 收口三连 clone | 2×B（text）+ tool_calls 深拷贝 | B=50KB → 额外 ~100KB 分配/收口 |
| S-c thought blocks | O(D_thought) 块 + serde | D=2000 → 2000 ThoughtBlock |
| S-d tools to_vec×2 | O(tools schema) 每 turn | 8 工具 ≈ 数 KB×2 |
| S-e estimate | O(M) 每请求+每 prepare_turn | M=200 → 2×全扫/turn |
| S-g 收口 delta 全文 | ≈B 克隆进 events | 与实时轨内容重叠 |
| T-a 工具输出 clone | 3–4×O 每工具 | O=100KB → ~400KB/工具 |
| O-b 审计积压 | 无界 | 慢盘时线性堆积 |
