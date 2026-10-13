# 11 — Rust 内核 `session-loop` 异步事件循环与高频通道性能审计报告

> **审计角色**：Rust 内核 `SessionLoop` 异步事件循环与高频通道性能首席审计师
> **审计范围**：`crates/session-loop/src/` 全量 27 个核心模块（`loop/loop_runner.rs`、`loop/loop_exec.rs`、`loop/invariants.rs`、`loop/compaction_dispatch.rs`、`loop/summary_coordinator.rs`、`loop/summary_dispatch.rs`、`loop/handlers/*`、`stream.rs`、`exec_batch.rs`、`exec_single.rs`、`exec_verdict.rs`、`exec_middleware.rs`、`safe_point.rs`、`checkpoint.rs`、`freeze.rs`、`rollback.rs`、`retraction.rs`、`tool_exec.rs`、`state.rs`、`approval_router.rs`、`approval.rs`、`input.rs`、`control.rs`、`provider.rs`、`cache_tracker.rs`）
> **纪律遵循**：严格遵守 `.agents/LOGIC_PLAN_NO_RETREAT.md` 与 `AGENTS.md`（反退避、问题同权、零补丁妥协、穿透根因与架构净收敛）。

---

## 一、审计总览与核心架构诊断

`crates/session-loop` 是 Conex 内核的**单会话状态机与高频流式/工具执行心脏**。所有大模型 SSE Token 流（`TextDelta` / `ThoughtDelta`）、多轮工具并发批次调度、上下文预算预估与自动压缩、L1/L2/L3 三级安全点抢占控制、以及会话撤回冻结（Freeze/Retraction）均在此汇聚。

经过对 `crates/session-loop/src/` 全部源码的逐行穿透式审计，本报告共定位出 **20 项具有确凿代码证据（`file:line`）的性能瓶颈、并发正确性隐患与伪兼容架构债务**。所有问题同权列出，严禁以优先级为借口裁剪任何一项：

### 1.1 20 项核心缺陷全景矩阵（问题同权）

| 编号             | 所属维度         | 缺陷摘要                                                                                                                                                 | 核心代码锚点                                                                                                                                                                                              | 复杂度 / 物理开销劣化                                                                                                      |
| :--------------- | :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| **SL-PERF-01**   | 事件循环与高频流 | 流式 Token 循环内每帧 `Notify` 等待节点重注册、每帧 ISO 时间格式化、思考块碎片化与 `AgentMessage` 正文/思考 3 倍冗余深拷贝                               | `crates/session-loop/src/loop/handlers/streaming.rs:140-177, 633-756`<br>`crates/session-loop/src/stream.rs:285-291, 496-508`                                                                             | $K$ 帧流产生 $O(K)$ 次 `Notify` 链表加锁、$O(K)$ 次 UTC 格式化、消息内存膨胀 $3\times$                                     |
| **SL-PERF-02**   | 事件循环与高频流 | `LoopState::emit_event` 无条件全量 `AgentEvent::clone()` 双轨深拷贝与 `state.events` 无界驻留                                                            | `crates/session-loop/src/loop/handlers/mod.rs:79-80, 180-185`                                                                                                                                             | 每次事件发射克隆完整 `ToolEnd` / `ContextCompressionEnd` 载荷；长会话内存线性失控                                          |
| **SL-PERF-03**   | 事件循环与高频流 | 用户输入入队与每条内部消息出队的无界 `tokio::spawn`（Fire-and-Forget 协程风暴、同步 JSON 序列化与 SQLite 写锁无序竞态）                                  | `crates/session-loop/src/loop/loop_runner.rs:350-386`<br>`crates/session-loop/src/loop/handlers/mod.rs:245-264`                                                                                           | 每条工具结果/内部消息凭空 spawn 异步 DB `DELETE`；`save` 与 `delete` 乱序竞态导致僵尸记录                                  |
| **SL-PERF-04**   | 事件循环与高频流 | `summarize_via_blocking` 与 `run_summary_task` 缺失 `abort_signal` 竞速（L3 强停卡死 60s）及超时后阻塞线程泄漏                                           | `crates/session-loop/src/loop/summary_dispatch.rs:648-675, 801-815`<br>`crates/session-loop/src/loop/compaction_dispatch.rs:287-306`                                                                      | 用户点击取消后事件循环被 `summarize_via_blocking` 硬阻塞至多 60,000ms；超时后后台线程脱离                                  |
| **SL-PERF-05**   | 状态快照与上下文 | 单轮常规请求构建期对不可变 `tools_snapshot` 执行 **4 次全量 JSON 树深克隆与序列化** + **2 次 `Vec<ToolSchema>` 深拷贝**                                  | `crates/session-loop/src/loop/compaction_dispatch.rs:92-117, 180, 226`<br>`crates/session-loop/src/loop/handlers/streaming.rs:64-68, 454, 469`<br>`crates/session-loop/src/cache_tracker.rs:629-641, 685` | 单 Turn 4 次 $O(T \cdot S)$ `serde_json::Value` 树克隆与 `to_string` 分配（数十 KB JSON 反复构造丢弃）                     |
| **SL-PERF-06**   | 状态快照与上下文 | `apply_compaction` 丢弃消息捕获的 $O(D \times N)$ 二次方线性查找与无条件全量 `AgentMessage` 多次深拷贝                                                   | `crates/session-loop/src/loop/compaction_dispatch.rs:365, 431-441, 560, 573`<br>`crates/session-loop/src/loop/summary_dispatch.rs:786`                                                                    | $O(D \times N)$ 扫描；即便同步摘要成功（无需重试）也无条件深拷贝全部被丢弃历史消息                                         |
| **SL-PERF-07**   | 状态快照与上下文 | 预检/溢出压缩双重遍历切割计算、`preview.dropped` 全量深拷贝与大摘要字符串反复 `.clone()`                                                                 | `crates/session-loop/src/loop/compaction_dispatch.rs:287-313`<br>`crates/session-loop/src/loop/handlers/stream_error_recover.rs:158-229, 457`                                                             | 同一批对话在 `preview_compaction` 与 `compact_agent_messages` 中被重复扫描与克隆                                           |
| **SL-PERF-08**   | 状态快照与上下文 | 安全点采集 `collect_checkpoint_from_messages` 对历史每条消息拼接全部 50KiB `ToolResult` 文本的MB级堆分配                                                 | `crates/session-loop/src/safe_point.rs:253-276`                                                                                                                                                           | 无检查点常规会话每次采集分配 $O(M \times L_{\text{tool}})$ 堆内存（100 条消息可达 ~5MB 瞬时拷贝）                          |
| **SL-PERF-09**   | 状态快照与上下文 | `SessionFreezeRegistry` 与 `SessionSummaryCoordinatorRegistry` 全局单锁竞争、`prepare_retraction` 跨 `.await` TOCTOU 竞态与会话条目永久泄漏              | `crates/session-loop/src/freeze.rs:36-164`<br>`crates/session-loop/src/retraction.rs:200-218`<br>`crates/session-loop/src/loop/summary_coordinator.rs:287-394`                                            | 每次事件落库争抢全局 `Mutex`；撤回流程步骤 2～6 存在无锁竞态窗口；已删会话协调器驻留内存永不释放                           |
| **SL-PERF-10**   | 工具并发与锁竞争 | `BatchPlanner::plan` 全量重排破坏混合批次因果屏障 + `run_parallel` 全组串行等审批与 `join_all` 队头阻塞 + 同组 `CancelSiblings` 失效                     | `crates/session-loop/src/exec_batch.rs:220-237, 306-320, 537`                                                                                                                                             | 违背 `[Seq, Par, Seq, Par]` 相对顺序；同组慢审批/慢工具阻塞快工具发射 `ToolEnd`；致命错误无法立即取消同组兄弟任务          |
| **SL-PERF-11**   | 工具并发与锁竞争 | `executing_tools.rs` 对单次工具输出执行 **3 次完整深拷贝**（含未截断 MB 级原始输出克隆进 `ToolEnd` 事件）及摘要向量重复克隆                              | `crates/session-loop/src/loop/handlers/executing_tools.rs:109-116, 197-245, 292-539`                                                                                                                      | 绕开 `Arc<Value>` 初衷，每次工具完成执行 `serde_json::from_value(raw.clone())` 达 2～3 次                                  |
| **SL-PERF-12**   | 工具并发与锁竞争 | `ToolExecutor::execute_single` 中间件链与 Hook 链对工具入参 `input` 和输出 `output` (`serde_json::Value`) 连续 6～8 次深拷贝                             | `crates/session-loop/src/exec_single.rs:299-312, 445, 453, 470, 539, 716, 724, 740`                                                                                                                       | 大文件写入（如 `write_file` 100KB 代码）单次调用产生 600KB～800KB JSON 树深克隆                                            |
| **SL-PERF-13**   | 工具并发与锁竞争 | 工具成对性闭环 `tool_pairing.rs` 在孤儿收敛时丢弃已知集合，对全量 `events` 与 `conversation` 反复执行 $O(K \times (E + M \cdot B))$ 线性扫描             | `crates/session-loop/src/loop/handlers/tool_pairing.rs:23-60, 66-122, 188-233`                                                                                                                            | 每次孤儿工具闭合对 `state.events` 扫描 2 遍、对 `state.conversation` 所有块扫描 1～2 遍                                    |
| **SL-PERF-14**   | 工具并发与锁竞争 | `cache_tracker::message_hash` 仅预分配 64B `Vec<u8>` 却拼接整条消息（50KiB 工具输出）及重序列化 JSON 再算 FNV-1a                                         | `crates/session-loop/src/cache_tracker.rs:574-625`                                                                                                                                                        | 每条新增消息触发多次 `Vec<u8>` 翻倍扩容拷贝 + `serde_json::to_string` 堆分配，而 FNV-1a 原生支持零分配流式哈希             |
| **SL-PERF-15**   | 工具并发与锁竞争 | `ParallelExecObs`（生产零消费者）与 `AbortSignal` / `InputMux` 全路径滥用 `Ordering::SeqCst` 导致多核缓存行乒乓                                          | `crates/session-loop/src/tool_exec.rs:149-184`<br>`crates/session-loop/src/safe_point.rs:50-57`<br>`crates/session-loop/src/input.rs:43, 73, 178`                                                         | 每次工具进出、每个流式 Token 帧发出多余的硬件级 `mfence` / `dmb ish` 全序屏障                                              |
| **SL-COMPAT-16** | 伪兼容与死代码   | `executing_tools.rs` 硬编码 `ToolCategory::Internal` 与 `ToolConcurrency::Parallel` 架空工具真实并发语义，且 `rollback.rs` 保留必败的旧 path-only 回滚桩 | `crates/session-loop/src/loop/handlers/executing_tools.rs:73-92`<br>`crates/session-loop/src/rollback.rs:22-25, 101-198`                                                                                  | 所有工具并发度被强行抹平为 `Parallel`（引发并发写冲突风险）；`RollbackExecutor::rollback_before` 100% 返回 `Failed` 死代码 |
| **SL-COMPAT-17** | 伪兼容与死代码   | `turn_complete.rs` 三套重叠 TurnEnd 钩子（`turn_end_hook` + `should_stop_after_turn` 兼容层 + `HookEvent::TurnEnd`）重复构造上下文                       | `crates/session-loop/src/loop/handlers/turn_complete.rs:40, 82-100, 106-124, 168-185`                                                                                                                     | 每轮结束触发 3 套同义钩子分派与多次 `TurnContext` 构造克隆                                                                 |
| **SL-COMPAT-18** | 伪兼容与死代码   | `ToolExecutor::with_*` 与 `ToolExecutorPatch::clone_with` 变异式 Builder 反模式（既改 `&mut self` 又全字段克隆返回新实例并被调用方丢弃）                 | `crates/session-loop/src/exec_batch.rs:44-137`<br>`crates/session-loop/src/loop/loop_runner.rs:81-85, 207-215`                                                                                            | 每次 `sync_tool_executor` 凭空克隆并丢弃 3 个完整的 `ToolExecutor`（含 `Arc` 表与 `Vec`）                                  |
| **SL-COMPAT-19** | 伪兼容与死代码   | `ControlDrainAction::SoftInject` 仅为“兼容既有消费者”深拷贝合并 `messages` 向量（生产唯一调用方直接用 `..` 忽略）及 `safe_point.rs` 死函数               | `crates/session-loop/src/control.rs:197-205, 452-470`<br>`crates/session-loop/src/safe_point.rs:96-110, 144-150, 159-198`                                                                                 | 每次 L1 软注入无条件将 `steer_messages` 与 `follow_up_messages` 额外深拷贝一份后直接丢弃                                   |
| **SL-COMPAT-20** | 伪兼容与死代码   | `stream.rs` 与 `provider.rs` 因历史任务书临时边界跨 Crate 镜像复制 `ProviderStreamEvent` / `ProviderUsage` 等类型，迫使流式热路径逐帧转换分配            | `crates/session-loop/src/stream.rs:1-203`<br>`crates/session-loop/src/provider.rs:35-77`                                                                                                                  | 每个 SSE Token 帧经历跨 Crate 枚举解构与字符串重移动/重包装                                                                |

---

## 二、维度 A：事件循环、高频流式通道、背压与微调度穿透分析

### 2.1 [SL-PERF-01] 高频流式循环内每帧 `Notify` 节点分配、ISO 时间戳格式化、思考块碎片化与 `AgentMessage` 3 倍冗余深拷贝

- **代码定位**：
  - `crates/session-loop/src/loop/handlers/streaming.rs:140-177`（`consume_stream` 主循环）
  - `crates/session-loop/src/loop/handlers/streaming.rs:633-675`（`build_assistant_message`）
  - `crates/session-loop/src/loop/handlers/streaming.rs:694-756`（`commit_message_with_deltas` / `delta_to_message_event`）
  - `crates/session-loop/src/stream.rs:285-291, 496-508`（`StreamMessageBuilder::push` / `build_message_metadata`）
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/loop/handlers/streaming.rs:140-177
  loop {
      let maybe_event = tokio::select! {
          biased;
          () = state.abort_signal.wait_aborted() => {
              state.stream_aborted = true;
              break;
          }
          next = stream.next() => next,
      };
      let Some(event) = maybe_event else { break; };
      if state.abort_signal.is_aborted() {
          state.stream_aborted = true;
          break;
      }
      if let Some(delta) = delta_to_message_event(&state.session_id, &live_message_id, &event) {
          if let Some(sink) = &state.options.hooks.stream_sink {
              sink.push(delta.clone());
          }
          if let Some(sink) = &state.options.hooks.live_sink {
              sink.push_live(delta);
          }
      }
      builder.push(event);
  }
  ```
  ```rust
  // crates/session-loop/src/stream.rs:285-291 & 496-508
  ProviderStreamEvent::ThoughtDelta { delta, signature } => {
      self.thought.push_str(&delta);
      self.thought_blocks.push(ThoughtBlock {
          text: delta,
          signature,
      });
  }
  // ...
  fn build_message_metadata(aggregate: &StreamAggregate) -> serde_json::Value {
      let mut map = serde_json::Map::new();
      map.insert("text".to_string(), serde_json::Value::String(aggregate.text.clone()));
      map.insert("thought".to_string(), serde_json::Value::String(aggregate.thought.clone()));
      map.insert(
          "thoughtBlocks".to_string(),
          serde_json::to_value(&aggregate.thought_blocks).unwrap_or(serde_json::Value::Null),
      );
      // ...
  }
  ```
- **根因与复杂度推导**：
  1. **每帧 `Notify::notified()` 侵入式链表注册/注销**：`state.abort_signal.wait_aborted()`（`safe_point.rs:65-74`）在每次调用时先检查 `is_aborted()`（`SeqCst`），随后调用 `self.notify.notified().await`。在 `consume_stream` 的 `loop` 中，每收到 1 个 Token 增量（哪怕已在 socket 缓冲区就绪），`tokio::select! { biased; ... }` 都会构造一个新的 `Notified` future、轮询一次（若未触发则在 `Notify` 内部等待链表注册 waiter），紧接着当 `stream.next()` 立即就绪时 Drop 该 `Notified` future（再次锁定 `Notify` 链表移除 waiter）；出 `select!` 后第 153 行又冗余调用了一次 `state.abort_signal.is_aborted()`！
  2. **每帧 UTC 字符串格式化与双 Sink 同步克隆**：`delta_to_message_event`（`streaming.rs:718-737`）对**每一个 Token 帧**调用 `now_iso_utc()`（执行完整的日历计算与 `format!("{year:04}-{month:02}-{day:02}T...")` 堆字符串分配），并克隆 `session_id`、`message_id`、`delta`；若同时挂载 `stream_sink` 和 `live_sink`，还会额外 `.clone()` 一次 `AgentEvent::MessageDelta`。此外 `sink.push_live` 是同步方法，完全缺乏异步 Channel 背压感知。
  3. **思考块按 Token 碎片化爆炸（无增量合并）**：`StreamMessageBuilder::push`（`stream.rs:285-291`）在收到流式 `ThoughtDelta` 时，**没有将连续无 signature 的增量合并到最后一个 `ThoughtBlock`**，而是每收到 1 个 Token 就向 `self.thought_blocks` 推入一个仅含几个字符的 `ThoughtBlock`！一段 2,000 Token 的推理过程会产生 2,000 个独立的 `ThoughtBlock` 结构体。
  4. **单条 `AgentMessage` 内部 3 倍正文/思考内存冗余**：
     - `build_message_metadata`（`stream.rs:496-508`）把完整的 `aggregate.text`、`aggregate.thought` 以及包含数千个碎片块的 `aggregate.thought_blocks` **全量克隆并序列化进 `metadata: serde_json::Value`**；
     - 随后 `build_assistant_message`（`streaming.rs:633-675`）又从 `built.metadata.get("thoughtBlocks")` 中反解析出 `2,000` 个独立的 `AgentMessageBlock::Thinking` 塞进 `blocks`，同时把包含 `text`/`thought`/`thoughtBlocks` 完整副本的 `built.metadata` 原封不动赋给 `AgentMessage.metadata`！
     - 最后 `commit_message_with_deltas`（`streaming.rs:694-712, 741-756`）在流已经实时推送过 `MessageDelta` 的前提下，又把 `message.blocks` 遍历转换成數千个 `AgentEvent::MessageDelta` 塞入 `state.events`！

---

### 2.2 [SL-PERF-02] `LoopState::emit_event` 无条件全量 `AgentEvent::clone()` 双轨复制与无界 `state.events` 累积

- **代码定位**：`crates/session-loop/src/loop/handlers/mod.rs:79-80, 180-185`
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/loop/handlers/mod.rs:180-185
  pub(crate) fn emit_event(&mut self, event: AgentEvent) {
      self.events.push(event.clone());
      if let Some(sink) = &self.options.hooks.live_sink {
          sink.push_live(event);
      }
  }
  ```
- **根因与复杂度推导**：
  - `AgentEvent` 枚举承载了 `ToolBatchStart`（含 `Vec<ToolBatchCall>` 及全部 JSON `input`）、`ToolEnd`（含完整 `ToolOutputPayload`）、`ContextCompressionEnd`（含 `ContextCompressionRecord`）等重型结构体。
  - `emit_event` 无条件执行 `self.events.push(event.clone())`，将每个事件完整深拷贝一份留存在 `LoopState::events: Vec<AgentEvent>` 中，直到整个多轮 `SessionLoop::run` 收敛（可能跨越数十轮工具调用、数千个流事件）才返回。
  - 在生产壳层（`orchestrator` / Tauri IPC）中，所有事件早已通过 `live_sink` 实时落库并推送前端，`run()` 返回的 `LoopOutcome.events` 绝大部分场景仅在单测断言中消费，生产路径为其支付了 100% 的全量事件深拷贝与长生命周期内存驻留税。

---

### 2.3 [SL-PERF-03] 用户输入入队与消息记录的无界 `tokio::spawn`（Fire-and-Forget 协程风暴与 DB 写锁竞态）

- **代码定位**：
  - `crates/session-loop/src/loop/loop_runner.rs:350-386`（`persist_pending_input` / `enqueue_input`）
  - `crates/session-loop/src/loop/loop_exec.rs:111-113`（`run` 入口）
  - `crates/session-loop/src/loop/handlers/mod.rs:245-264`（`LoopState::record_message`）
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/loop/loop_runner.rs:355-367
  fn persist_pending_input(&self, message: &AgentMessage, priority: &str) {
      let Some(store) = self.options.hooks.pending_input_store.clone() else {
          return;
      };
      let Ok(handle) = tokio::runtime::Handle::try_current() else {
          return;
      };
      let Ok(payload) = serde_json::to_string(message) else {
          return;
      };
      let id = message.id.clone();
      let session_id = self.session_id.clone();
      let priority = priority.to_string();
      handle.spawn(async move {
          let _ = store.save_pending_input(&id, &session_id, &priority, &payload).await;
      });
  }
  ```
  ```rust
  // crates/session-loop/src/loop/handlers/mod.rs:245-264
  pub(crate) fn record_message(&mut self, message: AgentMessage) {
      if let Some(sink) = &self.options.hooks.message_sink {
          sink.on_message(&message);
      }
      if let Some(store) = self.options.hooks.pending_input_store.clone() {
          if let Ok(handle) = tokio::runtime::Handle::try_current() {
              let id = message.id.clone();
              handle.spawn(async move {
                  let _ = store.delete_pending_input(&id).await;
              });
          }
      }
      self.conversation.push(Arc::new(message));
  }
  ```
- **根因与复杂度推导**：
  1. **对所有非 Pending 消息滥发 DB `DELETE` 协程**：`record_message` 被用于记录**所有**进入 `conversation` 的消息——包括 Assistant 回复（`streaming.rs:708`）、每个工具的执行结果消息（`executing_tools.rs:115`）、孤儿补齐消息（`tool_pairing.rs:118`）、以及未通过 `enqueue_input` 落库的内部消息！当一个批次并发执行 12 个工具时，`record_message` 会连续 12 次 `handle.spawn` 异步任务去执行 SQLite `DELETE FROM pending_inputs WHERE id = ?`（全部是必定影响 0 行的无效写事务），直接与事件落库争抢 SQLite 写锁！
  2. **`save` 与 `delete` 无序竞态（Race Condition）**：`persist_pending_input`（`loop_exec.rs:111`）通过 `handle.spawn` 异步发起 `save_pending_input`；仅几微秒后，`prepare_turn::handle`（`prepare_turn.rs:28`）出队该消息并调用 `state.record_message(msg)`，再次 `handle.spawn` 发起 `delete_pending_input`！两个独立的 `tokio::spawn` 任务在多线程 Runtime 上完全没有因果顺序保证——一旦 `delete_pending_input` 先于 `save_pending_input` 获得调度并执行完毕，随后才执行的 `save_pending_input` 会把**已经消费完毕的消息永久残留在 `pending_inputs` 表中**，导致下次重启时幽灵消息重放！

---

### 2.4 [SL-PERF-04] `summarize_via_blocking` 与 `run_summary_task` 缺失 `abort_signal` 竞速（L3 强停卡死 60s）与超时阻塞线程脱离

- **代码定位**：
  - `crates/session-loop/src/loop/compaction_dispatch.rs:287-306`（`compact_with_llm_guard`）
  - `crates/session-loop/src/loop/handlers/stream_error_recover.rs:158-177`（`compression_ladder`）
  - `crates/session-loop/src/loop/summary_dispatch.rs:648-675, 801-815`（`run_summary_task` / `summarize_via_blocking`）
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/loop/compaction_dispatch.rs:297-299
  let wall_ms = state.options.compaction.llm_summary_timeout_ms;
  let precomputed =
      super::summary_dispatch::summarize_via_blocking(&summarizer, preview.dropped, wall_ms).await;
  ```
  ```rust
  // crates/session-loop/src/loop/summary_dispatch.rs:801-815
  pub(crate) async fn summarize_via_blocking(
      summarizer: &Arc<dyn conex_context_engine::compaction::SummaryGenerator>,
      dropped: Vec<AgentMessage>,
      wall_ms: u64,
  ) -> Result<String, String> {
      let summarizer = Arc::clone(summarizer);
      let fut = tokio::task::spawn_blocking(move || summarizer.summarize(&dropped));
      match tokio::time::timeout(Duration::from_millis(wall_ms), fut).await {
          Ok(Ok(res)) => res,
          Ok(Err(join_err)) => Err(format!("summary worker join error: {join_err}")),
          Err(_elapsed) => Err(format!("summary timeout after {wall_ms}ms")),
      }
  }
  ```
- **根因与复杂度推导**：
  1. **L3 强停信号盲区（长达 60,000ms 的不可取消阻塞）**：`llm_summary_timeout_ms` 默认值为 `60_000`（60 秒，`state.rs:25`）。在 `prepare_turn` 触发预检压缩（`compact_with_llm_guard`）或 `stream_error_recover` 触发溢出阶梯压缩（`compression_ladder`）时，主循环直接 `.await` `summarize_via_blocking`，**完全没有与 `state.abort_signal.wait_aborted()` 进行 `tokio::select! { biased; ... }` 竞速**！如果用户在压缩摘要期间点击 Stop 或发起撤回（`prepare_retraction` 等待 `wait_converged`），整个 `SessionLoop` 会僵死长达 60 秒！
  2. **后台重试睡眠盲区与阻塞线程脱离**：`run_summary_task`（`summary_dispatch.rs:662`）在重试退避 `tokio::time::sleep` 期间不监听 `abort_signal`；且 `tokio::time::timeout` 包裹 `spawn_blocking` 时，一旦超时或取消，底层的 OS 阻塞线程无法被中断，会继续占用 Tokio blocking thread pool 直至 HTTP 同步请求自然返回。

---

## 三、维度 B：状态快照、上下文估算、历史回溯与内存克隆开销穿透分析

### 3.1 [SL-PERF-05] 单轮常规请求构建期 `tools_schema` JSON 树与 `ToolSchema` 4 次重复全量深克隆及重序列化

- **代码定位**：
  - `crates/session-loop/src/loop/compaction_dispatch.rs:92-117, 180, 226`（`tools_prefix_json` / `estimate_context`）
  - `crates/session-loop/src/loop/handlers/streaming.rs:64-68, 454, 469, 489-491`（`streaming::handle` / `build_request` / `clamp_request_max_tokens`）
  - `crates/session-loop/src/cache_tracker.rs:629-641, 685`（`tools_hash` / `build_request_signature_incremental`）
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/loop/compaction_dispatch.rs:104-117
  fn tools_prefix_json(state: &LoopState) -> Option<String> {
      if state.tools_snapshot.is_empty() {
          return None;
      }
      let entries: Vec<serde_json::Value> = state
          .tools_snapshot
          .iter()
          .map(|t| {
              serde_json::json!({
                  "name": t.name,
                  "description": t.description,
                  "input_schema": t.input_schema,
              })
          })
          .collect();
      serde_json::to_string(&entries).ok()
  }
  ```
  ```rust
  // crates/session-loop/src/loop/handlers/streaming.rs:64-68 & 454 & 469
  let tools = tools_schema(state).to_vec();
  let cache_break_events = state.cache_tracker.as_mut().map(|tracker| {
      let mut out = Vec::new();
      tracker.capture_signature(&state.session_id, state.turn_index, &sys, &tools, &conversation, &mut out);
      out
  });
  // ...
  // streaming.rs:454 (build_request)
  tools: tools_schema(state).to_vec(),
  // streaming.rs:469 (clamp_request_max_tokens)
  let est = crate::r#loop::compaction_dispatch::estimate_context(state);
  ```
  ```rust
  // crates/session-loop/src/cache_tracker.rs:629-641 & 685
  fn tools_hash(tools: &[ToolSchema]) -> u64 {
      let json = serde_json::Value::Array(
          tools.iter().map(|t| serde_json::json!({
              "name": t.name,
              "description": t.description,
              "input_schema": t.input_schema,
          })).collect(),
      );
      let s = serde_json::to_string(&json).unwrap_or_default();
      fnv1a(s.as_bytes())
  }
  ```
- **根因与复杂度推导**：
  - `state.tools_snapshot: Arc<[ToolSchema]>` 在 `LoopState::new`（`handlers/mod.rs:111-116`）初始化后，**在整个 `SessionLoop::run` 生命周期内是 100% 只读不可变的**！
  - 然而在**每一个 Turn 的常规无压缩路径**上，内核对这套不可变的工具 Schema（通常含 20～50 个工具，每个 `input_schema` 是复杂的嵌套 JSON Schema 树，总计约 30KB～80KB）执行了惊人的重复工作：
    1. `prepare_turn` → `maybe_compact_user_boundary` → `estimate_context` → `tools_prefix_json`：**第 1 次**深克隆所有 `t.input_schema` 构造 `Vec<Value>` 并 `serde_json::to_string` 序列化出 50KB JSON 字符串计算 Token 数，算完立即丢弃；
    2. `prepare_turn` → `maybe_compact_preflight` → `estimate_context` → `tools_prefix_json`：**第 2 次**深克隆所有 `t.input_schema` 并重序列化 50KB JSON 字符串；
    3. `streaming::handle`：`tools_schema(state).to_vec()` **第 1 次深拷贝 `Vec<ToolSchema>`**，随后 `capture_signature` → `build_request_signature_incremental` → `tools_hash(&tools)`：**第 3 次**深克隆所有 `t.input_schema` 构造 `Value::Array` 并 `serde_json::to_string` 算 `fnv1a`（注意：即便走 `incremental` 分支，`tools_hash` 也没有缓存，每轮重算！）；
    4. `streaming::build_request`：`tools_schema(state).to_vec()` **第 2 次深拷贝 `Vec<ToolSchema>`**，紧接着 `clamp_request_max_tokens` 调用 `estimate_context(state)` → `tools_prefix_json`：**第 4 次**深克隆所有 `t.input_schema` 并重序列化 50KB JSON 字符串！
  - **数学复杂度**：设工具数量为 $T$，单工具 Schema JSON 树节点数为 $S$。原本应在 `LoopState::new` 一次性预计算缓存（$O(1)$ 后续读取）的静态元数据，现在每轮重复执行 $4 \times O(T \cdot S)$ 次堆分配深克隆与序列化，纯属无意义的 CPU 与分配器损耗。

---

### 3.2 [SL-PERF-06] `apply_compaction` 丢弃消息捕获的 $O(D \times N)$ 二次方查找与无条件全量 `AgentMessage` 多次深拷贝

- **代码定位**：
  - `crates/session-loop/src/loop/compaction_dispatch.rs:365-375, 431-441, 557-588`
  - `crates/session-loop/src/loop/summary_dispatch.rs:784-788`
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/loop/compaction_dispatch.rs:431-441
  let dropped_for_retry: Vec<conex_types::message::AgentMessage> = plan
      .dropped_ids
      .iter()
      .filter_map(|id| {
          state
              .conversation
              .iter()
              .find(|m| &m.id == id)
              .map(|m| (**m).clone())
      })
      .collect();
  ```
  ```rust
  // crates/session-loop/src/loop/compaction_dispatch.rs:365-372
  pub(crate) fn maybe_retry_pending_summary(state: &mut LoopState) {
      let Some(pending) = state.compaction.pending_summary_retry.clone() else {
          return;
      };
      let block_still_present = state
          .conversation
          .iter()
          .any(|m| m.id == pending.summary_block_id);
      if !block_still_present {
          state.compaction.pending_summary_retry = None;
          return;
      }
  ```
- **根因与复杂度推导**：
  1. **$O(D \times N)$ 二次方扫描**：`plan.dropped_ids` 包含 $D$ 个被丢弃消息 ID，`state.conversation` 包含 $N$ 条消息，双重循环执行 $D \times N$ 次字符串比较。
  2. **95% 场景下的无用全量深拷贝**：只有当 `!plan.summary_is_llm && !plan.dropped_ids.is_empty()`（即同步 LLM 摘要失败、退化为确定性 stub，且需要后台异步重试）时，才需要用到 `dropped_for_retry`（见 `:557`）。然而第 431 行在**不知道是否需要重试的情况下**，对每次压缩都无条件把所有被丢弃的历史消息（可能包含数十条 50KiB 的 `ToolResult`）执行 `(**m).clone()` 深拷贝出完整的 `Vec<AgentMessage>`！
  3. **重试链路的连环深拷贝**：一旦进入重试，`:560` 执行 `dropped_for_retry.clone()`，`:365` 每次 turn 结束检查时先 `pending_summary_retry.clone()` 克隆整批大消息（哪怕下一行发现不再需要也会先克隆），`summarize_once`（`summary_dispatch.rs:786`）每次重试又执行 `task.dropped.clone()`。如果将 `dropped` 改为 `Arc<[Arc<AgentMessage>]>`（或 `Arc<[AgentMessage]>`），所有这些跨线程/跨轮次传递的克隆开销将从 $O(\text{Megabytes})$ 降至 $O(1)$ 的原子引用计数自增！

---

### 3.3 [SL-PERF-07] 预检/溢出压缩双重遍历切割计算与 `preview.dropped` 冗余深拷贝

- **代码定位**：
  - `crates/session-loop/src/loop/compaction_dispatch.rs:287-313`（`compact_with_llm_guard`）
  - `crates/session-loop/src/loop/handlers/stream_error_recover.rs:158-229, 457`（`compression_ladder` / `apply_recovery_action`）
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/loop/compaction_dispatch.rs:292-312
  let plain_conv = state.plain_conversation();
  let preview = engine.preview_compaction(&plain_conv, policy);
  let precomputed = if preview.dropped.is_empty() {
      None
  } else {
      let wall_ms = state.options.compaction.llm_summary_timeout_ms;
      Some(
          super::summary_dispatch::summarize_via_blocking(&summarizer, preview.dropped, wall_ms)
              .await,
      )
  };
  engine.compact_agent_messages_with_stub_policy(
      &plain_conv,
      policy,
      None,
      precomputed.as_ref(),
      stub_policy,
  )
  ```
- **根因与复杂度推导**：
  - `state.plain_conversation()`（`handlers/mod.rs:285-287`）先把 `Vec<Arc<AgentMessage>>` 中**每一条消息**通过 `(**m).clone()` 深拷贝成一个新的 `Vec<AgentMessage>`（`plain_conv`）！
  - 紧接着 `engine.preview_compaction(&plain_conv, policy)` 遍历一遍 `plain_conv` 计算切割点并**再次深拷贝**出 `preview.dropped: Vec<AgentMessage>`；
  - 随后 `engine.compact_agent_messages_with_stub_policy(&plain_conv, ...)` **第二次完整遍历** `plain_conv` 重新计算完全相同的切割点并第三次深拷贝保留的消息；
  - 在 `stream_error_recover.rs:457` 中，`state.conversation = plan.messages.into_iter().map(Arc::new).collect()` 又把所有未丢弃的消息重新包装为新的 `Arc<AgentMessage>`，破坏了原有存活消息的 `Arc` 指针身份！

---

### 3.4 [SL-PERF-08] 安全点检查点采集 `collect_checkpoint_from_messages` 的 MB 级全量字符串拼接分配

- **代码定位**：`crates/session-loop/src/safe_point.rs:253-276`
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/safe_point.rs:253-276
  pub fn collect_checkpoint_from_messages(
      messages: &[AgentMessage],
  ) -> Result<Option<CheckpointProgress>, CheckpointParseError> {
      for message in messages.iter().rev() {
          if message.role == AgentMessageRole::System {
              continue;
          }
          let mut text = message.text();
          for block in &message.blocks {
              if let AgentMessageBlock::ToolResult { output, .. } = block {
                  if let Some(output_text) = &output.text {
                      if !text.is_empty() {
                          text.push('\n');
                      }
                      text.push_str(output_text);
                  }
              }
          }
          if let Some(mut checkpoint) = parse_checkpoint_marker(&text)? {
              checkpoint.source_message_id = Some(message.id.clone());
              return Ok(Some(checkpoint));
          }
      }
      Ok(None)
  }
  ```
- **根因与复杂度推导**：
  - `parse_checkpoint_marker` 只是按行扫描寻找以 `CHECKPOINT:` 开头的行。
  - 然而 `collect_checkpoint_from_messages` 在遍历每条历史消息时，无论该消息中是否含有 `"CHECKPOINT:"` 子串，都会无条件先调用 `message.text()`（分配堆 `String` 拼接所有 `Text` 块），再遍历所有 `ToolResult` 块将可能高达 50KiB 的 `output_text` `push_str` 拼接到同一个大 `String` 中！
  - 当会话历史中没有任何 `CHECKPOINT:` 标记（占生产 99% 以上场景）时，倒序扫描全部 $M$ 条消息会把整个会话自启动以来的所有文本和所有工具输出完整拷贝拼接一遍（例如 80 条工具结果 × 50KiB = **4MB 瞬时堆分配与内存复制**），而实际上只要对每个 `&str` 切片先做 `memchr` / `contains("CHECKPOINT:")` 零分配快速短路，开销即可降至纳秒级！

---

### 3.5 [SL-PERF-09] `SessionFreezeRegistry` 与 `SessionSummaryCoordinatorRegistry` 全局单锁竞争、`prepare_retraction` TOCTOU 竞态与会话泄漏

- **代码定位**：
  - `crates/session-loop/src/freeze.rs:36-164`（`SessionFreezeRegistry`）
  - `crates/session-loop/src/retraction.rs:195-232`（`RetractionCoordinator::prepare_retraction`）
  - `crates/session-loop/src/loop/summary_coordinator.rs:287-394`（`SessionSummaryCoordinatorRegistry`）
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/retraction.rs:200-220
  // 2. 并发撤回互斥：已冻结则拒绝
  if self.freeze.is_frozen(session_id) {
      return Err(RetractionError::AlreadyFrozen {
          session_id: session_id.to_string(),
      });
  }
  // 3. L3 强停 + 排空控制队列與待消费输入队列
  self.runner.stop_run(session_id).await?;
  // 4. 等待循环任务完全退出
  self.runner.wait_converged(session_id).await?;
  // 5. 读取当前最大落库序号
  let frozen_after_seq = self.store.session_max_sequence(session_id).await?;
  // 6. 置位冻结栅栏（此后写侧拦截）
  self.freeze.freeze(session_id, frozen_after_seq)?;
  ```
- **根因与复杂度推导**：
  1. **`prepare_retraction` 跨 3 个 `.await` 点的严重 TOCTOU 竞态**：步骤 2 调用 `self.freeze.is_frozen(session_id)` 检查锁状态后立即释放 `Mutex`；随后步骤 3 (`stop_run().await`)、步骤 4 (`wait_converged().await`)、步骤 5 (`session_max_sequence().await`) 均是异步挂起点（耗时可达数百毫秒至数秒），直到步骤 6 才调用 `self.freeze.freeze(...)` 真正占位！若前端用户快速双击撤回或两个 IPC 请求并发进入，两个请求都会通过步骤 2 的 `is_frozen` 检查，同时执行 `stop_run` / `wait_converged`！应当在步骤 2 直接原子置位 `Retracting / PendingFreeze` 状态占位锁，并在步骤 6 填充 `frozen_after_seq`（且用 RAII Drop Guard 保证中间步骤失败时自动释放占位）。
  2. **写侧每事件落库争抢全局 `Mutex`**：`SessionFreezeRegistry::check_write`（`freeze.rs:142`）在每条事件落库时锁定全局 `Mutex<HashMap<String, FrozenSession>>`。由于 99.99% 的时间里没有任何会话处于冻结态，增加一个 `AtomicUsize`（当前活跃冻结会话计数 `active_frozen_count`）即可在计数为 0 时以 1 条 `Acquire` 原子读指令 100% 绕过 `Mutex` 与 `HashMap` 哈希查找！
  3. **`SessionSummaryCoordinatorRegistry` 永久驻留泄漏**：`summary_coordinator.rs:384` 明确标注 `remove` 在壳层会话删除路径未接线，且每个协调器内部的 `last_outcome` 一直保留直到被覆盖。

---

## 四、维度 C：工具批处理并发执行、锁竞争与序列化开销穿透分析

### 4.1 [SL-PERF-10] `BatchPlanner::plan` 全量重排破坏混合批次因果屏障 + `run_parallel` 全组等审批/`join_all` 队头阻塞 + 同组 `CancelSiblings` 失效

- **代码定位**：`crates/session-loop/src/exec_batch.rs:220-237, 250-296, 306-320, 534-548`
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/exec_batch.rs:220-237
  pub fn plan(calls: &[ToolBatchCall]) -> Vec<ExecutionGroup> {
      let mut parallel = Vec::new();
      let mut sequential = Vec::new();
      for call in calls {
          match call.concurrency {
              ToolConcurrency::Parallel => parallel.push(call.clone()),
              ToolConcurrency::Sequential | ToolConcurrency::Exclusive => {
                  sequential.push(call.clone());
              }
          }
      }
      let mut groups = Vec::new();
      if !parallel.is_empty() {
          groups.push(ExecutionGroup { concurrency: GroupConcurrency::Parallel, calls: parallel });
      }
      for call in sequential {
          groups.push(ExecutionGroup { concurrency: GroupConcurrency::Sequential, calls: vec![call] });
      }
      groups
  }
  ```
  ```rust
  // crates/session-loop/src/exec_batch.rs:306-320 & 534-548
  async fn run_parallel(&self, group: &ExecutionGroup, ctx: &BatchExecContext) -> GroupOutcome {
      let approvals = self.collect_approvals(&group.calls, ctx).await;
      let raw_results = self.execute_group(&group.calls, &approvals, ctx).await;
      Self::collect_group_endings(&group.calls, raw_results)
  }
  // ...
  let futures: Vec<_> = calls.iter().map(|call| { ... }).collect();
  futures::future::join_all(futures).await
  ```
- **根因与复杂度推导**：
  1. **全局重排破坏工具调用因果序**：`BatchPlanner::plan` 不是按**连续可并行段（Run-Length / Contiguous Segment）**分组，而是把整个批次中**所有** `Parallel` 工具全部抽到最前面组成第 1 组！如果大模型在同一轮发出了 `[write_file("a.rs") (Sequential), read_file("a.rs") (Parallel)]`（先写后读），`BatchPlanner::plan` 会强行重排为**先执行 `read_file("a.rs")`，后执行 `write_file("a.rs")`**，读到旧文件内容！正确的规划算法必须将 `Sequential`/`Exclusive` 视为**顺序屏障（Fence）**，仅合并相邻的 `Parallel` 调用段。
  2. **串行等待全组审批（Head-of-Line Blocking）**：`run_parallel`（`exec_batch.rs:315`）先调用 `collect_approvals` 逐个串行 `.await` 组内所有需要审批的工具（`exec_batch.rs:331` `for call in calls`），直到最后一个工具审批通过后，才调用 `execute_group` 启动第 1 个工具！这意味着组内 9 个免审批的只读工具（如 `read_file`）会被 1 个等待人工点击审批的工具硬生生卡住无法启动。
  3. **`join_all` 尾部延迟与同组 `CancelSiblings` 失效**：`execute_group` 使用 `futures::future::join_all(futures).await`，必须等组内最慢的工具跑完才能统一收集结果；更严重的是，当 `FailStrategy::CancelSiblings` 启用且同组内某个并发工具在 10ms 时立即报错失败，其余耗时 30s 的同组并发工具**根本不会被取消**（因为 `should_abort_siblings` 检查在 `run_groups` 的组间循环 `exec_batch.rs:269`，对同组内部完全不起作用！）。

---

### 4.2 [SL-PERF-11] `executing_tools.rs` 对单次工具输出执行 3 次完整深拷贝（含未截断 MB 级输出克隆进事件）

- **代码定位**：`crates/session-loop/src/loop/handlers/executing_tools.rs:109-116, 197-245, 292-539`
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/loop/handlers/executing_tools.rs:109-116
  emit_tool_events(state, &calls, &outcome);
  for result in &outcome.results {
      if let Some(msg) = tool_result_message(result) {
          state.record_message(msg);
      }
  }
  ```
  ```rust
  // crates/session-loop/src/loop/handlers/executing_tools.rs:500-539 (tool_output_from_parts)
  if let serde_json::Value::Object(_) = output.as_ref() {
      if let Ok(mut parsed) = serde_json::from_value::<ToolOutputPayload>((**output).clone()) {
          // ...
          return parsed;
      }
  }
  match output.as_ref() {
      serde_json::Value::String(text) => ToolOutputPayload { text: Some(text.clone()), ... },
      other => ToolOutputPayload { data: Some(other.clone()), ... },
  }
  ```
- **根因与复杂度推导**：
  - 尽管 `ClassifiedToolResult.output` 被声明为 `Arc<serde_json::Value>`（代码注释声称“消除深 clone”），但在 `executing_tools.rs` 中：
    1. `emit_tool_events` 调用 `tool_output_from_parts(&r.output, ...)`，通过 `(**output).clone()` 将完整输出深拷贝并反序列化为 `ToolOutputPayload`（**第 1 次深拷贝**，且此处**没有调用 `apply_g8_tool_output_truncation`**，若工具返回 2MB 输出，2MB 字符串被原样塞入 `AgentEvent::ToolEnd`）；
    2. `state.emit_event(AgentEvent::ToolEnd { ... })` 内部立即执行 `self.events.push(event.clone())`（**第 2 次 2MB 深拷贝**）；
    3. 紧接着第 114 行 `tool_result_message(result)` 调用 `tool_output_from_result(result)`（`executing_tools.rs:197-245`），里面着几乎完全重复的代码再次对 `raw` 执行 `serde_json::from_value(raw.clone())` / `text.to_string()`（**第 3 次深拷贝**），最后才调用 `apply_g8_tool_output_truncation(&mut payload)` 截断到 50KiB！
  - 此外，`emit_tool_events`（`:298-338`）构造 `calls_summary` 和 `results_summary` 时，又把每个工具的 `call.input` 和 `result_summary` 克隆多份塞进 `ToolBatchStart` 和 `ToolBatchEnd`。

---

### 4.3 [SL-PERF-12] `ToolExecutor::execute_single` 中间件链与 Hook 链对 `serde_json::Value` 入参与输出连续 6～8 次深拷贝

- **代码定位**：`crates/session-loop/src/exec_single.rs:299-312, 437-504, 539-564, 674-758`
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/exec_single.rs:445-475
  let initial = call.input.clone();
  let after_mw = self.run_middleware_before(call, initial, ctx)?;
  let after_hook = self.dispatch_pre_hook(call, after_mw.clone(), ctx).await?;
  // ...
  for mw in &self.middleware {
      match mw.before_execute(call, &current_input, ctx) {
          MiddlewareDecision::Continue(next) => {
              current_input = next.unwrap_or_else(|| current_input.clone());
          }
  ```
  ```rust
  // crates/session-loop/src/exec_single.rs:304 & 539-546
  let raw_exec = self.race_execution(handler, call, exec_input.clone(), ctx, &tool_ctx).await;
  // ...
  async fn race_execution(
      &self,
      handler: Arc<dyn ToolExecutionHandler>,
      call: &ToolBatchCall,
      exec_input: Value,
      ctx: &BatchExecContext,
      tool_ctx: &ToolExecutionContext,
  ) -> Result<Result<Value, String>, ToolClassifiedError> {
      let exec_input_clone = exec_input.clone();
  ```
- **根因与复杂度推导**：
  - 仔细追踪一次 `write_file`（携带 100KB `CodeContent` 的 `call.input: serde_json::Value`）在 `execute_single` 中的生命周期：
    1. `run_pre_checks` 第 445 行：`call.input.clone()`（拷贝 #1）；
    2. `run_middleware_before` 第 470 行：`next.unwrap_or_else(|| current_input.clone())`——当中间件返回 `Continue(None)`（不修改参数）时，由于 `current_input` 本身就是 owned `Value`，这里竟然写成了 `current_input.clone()` 而不是直接保持 `current_input` 不变！（拷贝 #2）；
    3. `run_pre_checks` 第 453 行：`self.dispatch_pre_hook(call, after_mw.clone(), ctx)`，而 `dispatch_pre_hook` 内部第 485 行又写了一次 `input.clone()`！（拷贝 #3、#4）；
    4. `execute_single` 第 304 行：`self.race_execution(..., exec_input.clone(), ...)`（拷贝 #5）；
    5. `race_execution` 第 546 行：`let exec_input_clone = exec_input.clone();`——`exec_input` 已经是按值 move 进来的局部变量，后续根本不再使用 `exec_input`，却无故又 `.clone()` 了一次！（拷贝 #6）；
    6. `finalize_execution` 第 724 行：`r.executed_input = Some(exec_input.clone())`（拷贝 #7）；
    7. `collect_group_endings`（`exec_batch.rs:582`）与 `executing_tools.rs:475`：再次 `.clone()` `executed_input`（拷贝 #8、#9）！
  - 同様に，`apply_on_result_chain`（`exec_single.rs:740`）在中间件返回 `Ok(None)` 时也写成了 `output = next.unwrap_or_else(|| output.clone())`！仅仅消除这些无意义的 `.clone()` 并对未修改的参数共享 `Arc<Value>`，就能砍掉单次工具调用 **80% 以上的 JSON 树深克隆**。

---

### 4.4 [SL-PERF-13] 工具成对性闭环 `tool_pairing.rs` 的 $O(K \times (E + M \cdot B))$ 重复全表线性扫描

- **代码定位**：`crates/session-loop/src/loop/handlers/tool_pairing.rs:23-60, 66-122, 188-233`
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/loop/handlers/tool_pairing.rs:188-233
  pub(crate) fn reconcile_orphan_tool_calls(state: &mut LoopState, reason: &str) -> usize {
      let mut answered: HashSet<String> = HashSet::new();
      for msg in &state.conversation { ... }
      let mut orphan_calls: Vec<(String, String)> = Vec::new();
      for msg in &state.conversation { ... }
      for (tool_call_id, tool_name) in &orphan_calls {
          close_orphan_call(state, tool_call_id, tool_name, reason);
      }
      orphan_calls.len()
  }
  ```
  ```rust
  // crates/session-loop/src/loop/handlers/tool_pairing.rs:66-122
  fn close_orphan_call(state: &mut LoopState, tool_call_id: &str, tool_name: &str, reason: &str) {
      let has_end_event = events_have_tool_end(&state.events, tool_call_id);
      let has_result_msg = conversation_has_tool_result(&state.conversation, tool_call_id);
      if has_end_event && has_result_msg { return; }
      if !has_end_event {
          if !events_have_tool_start(&state.events, tool_call_id) { ... }
  ```
- **根因与复杂度推导**：
  - `reconcile_orphan_tool_calls` 已经在第 189～200 行完整遍历过一次 `state.conversation` 构建了 `answered: HashSet<String>`，确定了 `orphan_calls` 必然不在 `answered` 中；
  - 然而在随后针对每个孤儿调用的循环中，`close_orphan_call` 不仅丢弃了 `answered` 信息重新调用 `conversation_has_tool_result(&state.conversation, tool_call_id)`（再次全表扫描整个 `state.conversation` 的所有消息和所有块），还连续调用 `events_have_tool_end(&state.events, tool_call_id)` 和 `events_have_tool_start(&state.events, tool_call_id)` 两次全表线性扫描整个 `state.events`！
  - 在 `seal_pending_tool_calls`（`tool_pairing.rs:42-60`）中同样存在针对每个 pending call 的三重全表扫描。预先单趟构建 `started_ids: HashSet<&str>` 与 `ended_ids: HashSet<&str>` 即可将复杂度从 $O(K \times (E + M \cdot B))$ 降至 $O(E + M \cdot B)$。

---

### 4.5 [SL-PERF-14] `cache_tracker.rs` 消息签名哈希 `message_hash` 的 64B 缓冲多次扩容拷贝与 JSON 重序列化

- **代码定位**：`crates/session-loop/src/cache_tracker.rs:574-625`
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/cache_tracker.rs:574-625
  fn message_hash(msg: &AgentMessage) -> u64 {
      let mut bytes = Vec::with_capacity(64);
      bytes.extend_from_slice(msg.id.as_bytes());
      // ...
      for block in &msg.blocks {
          match block {
              AgentMessageBlock::Text { text } => {
                  bytes.push(b'T');
                  bytes.extend_from_slice(text.as_bytes());
              }
              AgentMessageBlock::ToolCall { call } => {
                  // ...
                  if let Ok(s) = serde_json::to_string(&call.input) {
                      bytes.extend_from_slice(s.as_bytes());
                  }
              }
              AgentMessageBlock::ToolResult { output, .. } => {
                  // ...
                  if let Some(t) = &output.text {
                      bytes.extend_from_slice(t.as_bytes());
                  }
              }
          }
      }
      fnv1a(&bytes)
  }
  ```
- **根因与复杂度推导**：
  - `fnv1a`（`cache_tracker.rs:644-651`）是标准的逐字节流式哈希：
    ```rust
    let mut hash = FNV_OFFSET_BASIS;
    for b in bytes { hash ^= u64::from(*b); hash = hash.wrapping_mul(FNV_PRIME); }
    ```
  - 既然算法本身逐字节消费输入，根本不需要把整条消息的所有文本块、思考块、50KiB 工具结果以及 `serde_json::to_string(&call.input)` 全部拷贝到一个初始容量仅 64 字节的 `Vec<u8>` 中（从 64B 扩容到 64KB 需经历 **10 次 `realloc` 与内存搬移**）！
  - 直接定义一个栈上的 `struct Fnv1aHasher(u64)` 并实现 `std::io::Write`，直接向 `Fnv1aHasher` 写入切片并使用 `serde_json::to_writer(&mut hasher, &call.input)`，即可实现 **100% 零堆分配（0 Byte Heap Allocation）** 的 $O(L)$ 原地哈希！

---

### 4.6 [SL-PERF-15] `ParallelExecObs`（生产零消费者）与 `AbortSignal` / `InputMux` 全路径 `Ordering::SeqCst` 缓存行乒乓

- **代码定位**：
  - `crates/session-loop/src/tool_exec.rs:149-184`（`ParallelExecObs`）
  - `crates/session-loop/src/safe_point.rs:50-57`（`AbortSignal`）
  - `crates/session-loop/src/input.rs:43, 73, 178`（`InputMux` / `SteerChannel`）
- **现场源码证据**：
  ```rust
  // crates/session-loop/src/tool_exec.rs:149-156
  pub(crate) fn enter(&self) {
      let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
      self.peak.fetch_max(now, Ordering::SeqCst);
  }
  pub(crate) fn leave(&self) {
      self.active.fetch_sub(1, Ordering::SeqCst);
  }
  ```
- **根因与复杂度推导**：
  - `ParallelExecObs::active()` 与 `peak()` 在整个生产代码中**没有任何调用方**（源码第 169～184 行专门加了 `#[allow(dead_code)]` 注释说明仅供测试读取），但在生产每次并发工具执行进出时，所有工作线程都在同一个 `Arc<ParallelExecObs>` 的同一条缓存行上连续执行 `fetch_add(SeqCst)`、`fetch_max(SeqCst)`、`fetch_sub(SeqCst)`！
  - 同样，`AbortSignal::is_aborted()` 在每个流式 Token、每次安全点检查中均使用 `Ordering::SeqCst`，在 x86_64/ARM64 多核上造成不必要的全局内存屏障开销，降级为 `Ordering::Acquire` / `Ordering::Release`（统计计数器用 `Ordering::Relaxed`）即可满足全部 happens-before 语义。

---

## 五、维度 D：真兼容 vs 伪兼容 物理分水岭核验与切除清单

根据反退避与净收敛铁律，我们对 `crates/session-loop` 中的所有兼容层进行了逐一甄别：

### 5.1 真兼容（100% 誓死捍卫）

1. **L1 / L2 / L3 三级抢占控制与 `ControlBus` 幂等去重**（`control.rs`、`safe_point.rs`）：保障用户软注入（Steer/FollowUp）、中断当前工具批次、强停整轮运行的确定性状态机语义，必须 100% 保持。
2. **工具调用成对性不变量 I1 与孤儿闭合契约**（`invariants.rs`、`tool_pairing.rs`）：大模型 API（Anthropic / OpenAI）强校验 `ToolCall` 与 `ToolResult` 1:1 配对，流中断或强停时合成 `[aborted]` ToolResult 是防止后续 Turn 400 报错的**核心真兼容契约**（但实现需从 $O(K \cdot N)$ 优化为 $O(N)$ 索引查找）。
3. **G8 50KiB 工具输出 UTF-8 字符边界安全截断**（`executing_tools.rs:251-289`）：保护上下文窗口与多字节字符安全。
4. **Prompt Cache 增量签名追踪与 Break 诊断**（`cache_tracker.rs`）：保护多轮对话 KV Cache 命中率可观测性。

### 5.2 伪兼容与历史包袱（坚决切除，单轨收敛）

#### [SL-COMPAT-16] 伪兼容：`executing_tools.rs` 硬编码 `ToolCategory::Internal` 与 `ToolConcurrency::Parallel` 架空工具定义 + `rollback.rs` 必败死代码桩

- **代码定位**：
  - `crates/session-loop/src/loop/handlers/executing_tools.rs:73-92`
  - `crates/session-loop/src/rollback.rs:22-25, 101-198`
- **现场证据**：
  ```rust
  // crates/session-loop/src/loop/handlers/executing_tools.rs:84-91
  calls.push(ToolBatchCall {
      id: call.id.clone(),
      name: call.name.clone(),
      input: call.input.clone(),
      category: ToolCategory::Internal,
      concurrency: ToolConcurrency::Parallel,
  });
  ```
  - **危害**：在 `executing_tools::handle` 从 Assistant 消息提取工具调用时，没有从工具注册表或 Schema 元数据查询工具真实的 `ToolCategory` 与 `ToolConcurrency`，而是**全部硬编码为 `ToolCategory::Internal` 和 `ToolConcurrency::Parallel`**！这不仅导致需要串行执行的写文件/命令执行工具在 `SessionLoop` 层被错误地并发调度，还导致 `ToolStart`/`ToolEnd` 事件上报给前端的 `category` 永远是 `Internal`！
  - 同时，`crates/session-loop/src/rollback.rs:104-198` 中的 `RollbackExecutor::rollback_before` 注释明文写着：_“历史 path-only 写类入口经 trash 层 fail-closed 拒绝，不能再按路径消费快照。生产撤回由壳层按 ToolEnd owner 调用 TrashService::rollback_operations；本执行器仅保留类别策略投影兼容面”_——整个 `rollback_before` 及其 `TrashRollbackAdapter` 在生产中已被 `RetractionCoordinator`（`retraction.rs:223` 直接调用 `self.trash.rollback_operations`）完全取代，属于 100% 伪兼容死代码。

#### [SL-COMPAT-17] 伪兼容：`turn_complete.rs` 三套重叠 TurnEnd 钩子（含 `should_stop_after_turn` 历史兼容层）

- **代码定位**：`crates/session-loop/src/loop/handlers/turn_complete.rs:40, 82-100, 106-124, 168-185`
- **现场证据**：
  ```rust
  // crates/session-loop/src/loop/handlers/turn_complete.rs:168-174
  /// 评估 `should_stop_after_turn` 兼容层（01 遗留问题 3）：
  /// 若调用方未设置 `turn_end_hook` 但设置了简化回调，则在 `AwaitingInput` 前转为 `Completed`。
  fn evaluate_should_stop_after_turn(state: &mut LoopState) -> bool { ... }
  ```
  - **切除方案**：将 `should_stop_after_turn` 统一收口至单一的 `turn_end_hook`（或提供构造函数辅助转换），废除 `LoopHooks` 上的双字段并存与每轮双重评估。

#### [SL-COMPAT-18] 伪兼容：`ToolExecutor::with_*` 与 `ToolExecutorPatch::clone_with` 变异式 Builder 反模式

- **代码定位**：`crates/session-loop/src/exec_batch.rs:44-137`、`crates/session-loop/src/loop/loop_runner.rs:81-85, 207-215`
- **现场证据**：
  ```rust
  // crates/session-loop/src/exec_batch.rs:101-106
  pub fn with_middleware(&mut self, middleware: Vec<Arc<dyn ToolMiddleware>>) -> Self {
      self.clone_with(ToolExecutorPatch {
          middleware: Some(middleware),
          ..Default::default()
      })
  }
  // crates/session-loop/src/loop/loop_runner.rs:207-214
  let _ = self.tool_executor.with_middleware(self.options.tool_exec.middleware.clone());
  let _ = self.tool_executor.with_hooks(self.options.tool_exec.hooks.clone());
  let _ = self.tool_executor.with_revert_policy(self.options.tool_exec.revert_policy.clone());
  ```
  - **危害**：`with_middleware(&mut self) -> Self` 先修改 `self.middleware`，然后再把 `self` 的全部 6 个字段 `.clone()` 一份构造新的 `ToolExecutor` 返回；而 `loop_runner.rs` 连续调用 3 个 `with_*` 并用 `let _ = ...` 丢弃返回值，每次白白克隆 3 个完整的 `ToolExecutor`！
  - **切除方案**：废除 `ToolExecutorPatch::clone_with` 怪胎模式，拆分为纯就地修改的 `set_middleware(&mut self, ...)` 与标准消费所有权的 `with_middleware(mut self, ...) -> Self`。

#### [SL-COMPAT-19] 伪兼容：`ControlDrainAction::SoftInject` 冗余 `messages` 深拷贝字段与 `safe_point.rs` 死辅助函数

- **代码定位**：`crates/session-loop/src/control.rs:197-205, 452-470`、`crates/session-loop/src/safe_point.rs:96-110, 144-150, 159-198`
- **现场证据**：
  ```rust
  // crates/session-loop/src/control.rs:452-463
  let mut messages = steer_messages.clone();
  messages.extend(follow_up_messages.iter().cloned());
  ControlDrainAction::SoftInject {
      steer_messages,
      follow_up_messages,
      messages,
      preempt_after_batch,
  }
  ```
  - **危害**：`ControlDrainAction::SoftInject` 同时持有 `steer_messages`、`follow_up_messages` 和二者深拷贝拼接后的 `messages`（注释：`合并视图（steer 在前、follow_up 在后），兼容既有消费者`）。而生产唯一消费者 `apply_safe_point_control`（`safe_point.rs:144-150`）直接用 `..` 忽略了 `messages`！同时 `safe_point.rs:96-110` 的 `poll_safe_point` 与 `:159-198` 的 `collect_checkpoint_markers` 已无生产调用。
  - **切除方案**：直接移除 `SoftInject.messages` 冗余字段，改为按需零拷贝迭代器方法 `fn all_messages(&self) -> impl Iterator<Item = &AgentMessage>`；清理 `safe_point.rs` 未接线死函数。

#### [SL-COMPAT-20] 伪兼容：`stream.rs` 与 `provider.rs` 跨 Crate 镜像复制流事件与 Usage 类型

- **代码定位**：`crates/session-loop/src/stream.rs:1-203`、`crates/session-loop/src/provider.rs:35-77`
- **现场证据**：`stream.rs:17-19` 明确记录该重复类型仅为当时遵守“任务书 B3.4 第 5 点不引入新依赖”而自建的镜像类型。
- **切除方案**：将 `ProviderStreamEvent`、`StopReason`、`ProviderUsage`、`CacheAccounting`、`ReasoningEffort` 统一提升至共享底座 `crates/conex-types`，让 `agent-provider` 与 `session-loop` 共享同一套零拷贝类型定义，彻底消除流式热路径上的逐帧枚举转换。

---

## 六、SOTA 单轨演进架构方案与验证断言

针对上述 20 项性能与架构缺陷，我们设计以下 **5 大 SOTA 单轨演进改造方案**，不打补丁、不留双轨：

### 6.1 方案一：流式热路径零拷贝化与增量块原位聚合（根治 SL-PERF-01 / 02 / 20）

1. **流式 `AbortSignal` 监听优化**：在 `consume_stream` 循环外 `tokio::pin!` 一个持久化的 `let abort_fut = state.abort_signal.wait_aborted();`，或者使用 `tokio_util::sync::CancellationToken`，避免每帧 Token 重新在 `Notify` 侵入式链表中注册/注销 waiter；移除循环体第 153 行冗余的第二次 `is_aborted()` 检查。
2. **增量思考块原位合并（Coalescing）**：在 `StreamMessageBuilder::push`（`stream.rs:285-291`）中，当收到 `ThoughtDelta { delta, signature: None }` 且 `self.thought_blocks.last_mut()` 也是 `signature: None` 时，直接调用 `last.text.push_str(&delta)` 原位追加，将 2,000 个碎片 `ThoughtBlock` 收敛为 1 个连续块！
3. **消除 `AgentMessage` 3 倍内存冗余**：
   - `build_message_metadata` 不再往 `metadata` JSON 树中重复塞入完整的 `text`、`thought` 和 `thoughtBlocks`（这些内容已经在 `AgentMessage.blocks` 中作为一等公民存储），仅在 `metadata` 中保留 `stopReason`、`usage`、`cache`、`providerMeta`；
   - `build_assistant_message` 直接消费 `StreamMessageBuilder` 产出的 `thought_blocks` 与 `text`（通过 `mem::take` 零拷贝移动所有权），彻底废除“先序列化进 `serde_json::Value` 再从 `metadata["thoughtBlocks"]` 反解析回 `AgentMessageBlock`”的荒谬回路；
   - `commit_message_with_deltas` 不再向 `state.events` 重复补发全量 `MessageDelta`（或仅在未配置 `stream_sink`/`live_sink` 的离线测试模式下按需开启 `record_event_history: bool`）。
4. **`AgentEvent` 载荷 `Arc` 化 / 按需历史记录**：在 `LoopOptions` 中引入 `retain_events_in_memory: bool`（生产壳层通过 `live_sink` 实时消费时设为 `false`，测试时默认 `true`），使生产路径 `LoopState::emit_event` 直接 move `event` 给 `live_sink.push_live(event)`，实现 **0 次 `AgentEvent::clone()`** 与 **$O(1)$ 事件内存占用**！

### 6.2 方案二：不可变工具 Schema 预计算缓存与零分配流式 FNV-1a 哈希（根治 SL-PERF-05 / 14）

1. **`LoopState` 静态 Schema 缓存（Precomputed Tool Artifacts）**：
   - 在 `LoopState::new` 初始化 `tools_snapshot: Arc<[ToolSchema]>` 时，一次性预计算并缓存：
     - `tools_prefix_json: Option<Arc<str>>`（供 `estimate_context` 直接 $O(1)$ 读取）；
     - `tools_prefix_tokens: usize`（更进一步：直接在初始化时用 `estimate_raw_text_tokens` 算出工具 Schema 的 Token 数缓存为 `usize`，使 `estimate_context` 连字符串读取都省去，100% $O(1)$！）；
     - `tools_signature_hash: u64`（供 `CacheBreakTracker::capture_signature` 直接传入预计算好的 `u64` 哈希，彻底砍掉每轮 `tools_hash(&tools)` 的 JSON 树克隆与序列化）；
   - 将 `ProviderRequest.tools` 的类型从 `Vec<ToolSchema>` 改为 `Arc<[ToolSchema]>`（或 `Cow<'a, [ToolSchema]>`），消除每轮 `tools_schema(state).to_vec()` 的两次深拷贝。
2. **零分配流式 `Fnv1aHasher`**：
   - 在 `crates/session-loop/src/cache_tracker.rs` 中实现栈上零分配哈希器：
     ```rust
     struct Fnv1aWriter(u64);
     impl Default for Fnv1aWriter {
         fn default() -> Self { Self(FNV_OFFSET_BASIS) }
     }
     impl std::io::Write for Fnv1aWriter {
         fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
             for &b in buf {
                 self.0 ^= u64::from(b);
                 self.0 = self.0.wrapping_mul(FNV_PRIME);
             }
             Ok(buf.len())
         }
         fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
     }
     ```
   - `message_hash` 与 `tools_hash` 全部通过 `Fnv1aWriter` 原地流式写入字节与 `serde_json::to_writer(&mut hasher, &call.input)`，将每条消息签名的堆分配次数从 $O(\log L)$ 次扩容降至 **严格的 0 次堆分配**。

### 6.3 方案三：上下文压缩 `Arc` 零拷贝传递、取消竞速与安全点零分配扫描（根治 SL-PERF-04 / 06 / 07 / 08 / 09）

1. **压缩与摘要重试全链路 `Arc` 化**：
   - 将 `PendingSummaryRetry.dropped` 与 `SummaryDispatchTask.dropped` 改为 `Arc<[AgentMessage]>`；
   - 在 `apply_compaction`（`compaction_dispatch.rs:431`）中，**仅当 `!plan.summary_is_llm && !plan.dropped_ids.is_empty()` 时**才构建 `dropped_for_retry`，且通过 `HashSet<&str>` 将查找复杂度从 $O(D \times N)$ 降至 $O(N)$；
   - 在 `maybe_retry_pending_summary`（`compaction_dispatch.rs:365`）中，先借用 `state.compaction.pending_summary_retry.as_ref()` 检查 `block_still_present`，通过后再 `.take()` 或克隆 `Arc`，消除无效深拷贝。
2. **`summarize_via_blocking` 接入 `AbortSignal` 偏置竞速**：
   - 为 `summarize_via_blocking` 增加 `abort_signal: &AbortSignal` 参数，内部使用 `tokio::select! { biased; () = abort_signal.wait_aborted() => Err("aborted".into()), res = tokio::time::timeout(...) => ... }`；
   - `run_summary_task` 的退避 `sleep` 同样接入 `abort_signal.wait_aborted()` 竞速，确保 L3 强停或会话撤回时毫秒级响应。
3. **`collect_checkpoint_from_messages` 零分配块级流式扫描**：
   - 废除 `safe_point.rs:258-267` 中拼接整条消息与全部 50KiB `ToolResult` 的 `text.push_str`；
   - 改为直接遍历 `message.blocks` 中的每个文本切片（`AgentMessageBlock::Text { text }` 与 `AgentMessageBlock::ToolResult { output: ToolOutputPayload { text: Some(t), .. }, .. }`），先用 `s.contains("CHECKPOINT:")` 做零分配快速过滤，仅在命中时调用 `parse_checkpoint_marker(s)`，实现常规路径 **0 字节堆分配**。
4. **`SessionFreezeRegistry` 原子快速路径与撤回占位锁**：
   - 在 `SessionFreezeRegistry` 中增加 `active_frozen_count: AtomicUsize`；`check_write` 先执行 `if self.active_frozen_count.load(Ordering::Acquire) == 0 { return Ok(()); }`，使 99.99% 的常规写操作完全无锁通过；
   - 在 `prepare_retraction` 步骤 2 原子插入 `FreezeState::Preparing` 占位（带 RAII 失败回滚守卫），步骤 6 升级为 `FreezeState::Frozen { frozen_after_seq }`，彻底闭合跨 `.await` 的 TOCTOU 竞态窗口。

### 6.4 方案四：因果序感知的连续段并发规划器与流式并发执行器（根治 SL-PERF-10 / 11 / 12 / 13 / 15 / 16）

1. **恢复真实的工具 `category` 与 `concurrency` 投影**：
   - 在 `executing_tools.rs:73-92` 中，通过 `state.tool_executor.classify_call(&call)`（或查询工具注册表/元数据）填入每个工具真实的 `ToolCategory` 与 `ToolConcurrency`，废除 `Internal` + `Parallel` 硬编码；同时删除 `rollback.rs` 中废弃的 `RollbackExecutor::rollback_before` 桩代码。
2. **连续段分桶（Contiguous Parallel Segment Bucketing）**：
   - 重写 `BatchPlanner::plan`（`exec_batch.rs:220-237`）：按调用原始顺序扫描，遇到 `Parallel` 则并入当前 `Parallel` 组；一旦遇到 `Sequential` 或 `Exclusive`，立即封口当前 `Parallel` 组并单独推入一个 `Sequential`/`Exclusive` 组，后续再遇到 `Parallel` 时开启新的 `Parallel` 组。这既保证了连续只读工具的 100% 并发吞吐，又严格维护了 `Sequential` 写工具前后的因果屏障！
3. **每工具内联审批与 `FuturesUnordered` + 同组 `CancelSiblings` 即时熔断**：
   - 在 `run_parallel` 中，将单工具审批下沉到每个工具自己的异步任务内部（免审批工具立即启动执行，无需等待同组其他工具的审批弹窗）；
   - 使用 `futures::stream::FuturesUnordered` 替代 `join_all`，并在同组共享一个子级 `CancellationToken`（`group_cancel_token`）：一旦组内任何工具触发 `FailStrategy::CancelSiblings`，立即触发 `group_cancel_token.cancel()` 中断同组仍在运行的兄弟任务。
4. **消除 `executing_tools` 与 `exec_single` 的多余深拷贝**：
   - 在 `executing_tools::handle` 中，每个工具的 `ToolOutputPayload` 仅构造 **1 次**，立即应用 G8 截断后用 `Arc` 或克隆轻量引用同时供给 `ToolEnd` 事件与 `ToolResult` 消息；
   - 在 `exec_single.rs` 中移除 `race_execution`、`run_middleware_before`、`apply_on_result_chain` 中所有在 `None` 分支和 move 前后的无意义 `.clone()`。
5. **消除 Pending Input 无效 DB `DELETE` 风暴与乱序竞态**：
   - 为 `AgentMessage`（或 `LoopState.pending_persisted_ids: HashSet<String>`）记录哪些消息 ID 真正通过 `persist_pending_input` 落了库；`record_message` 仅当 `pending_persisted_ids.remove(&message.id)` 返回 `true` 时才触发 `delete_pending_input`，彻底消灭内部工具结果/Assistant 消息引发的无效 SQLite 写协程风暴！

---

### 6.5 量化验收断言清单（Verification Assertions）

1. **流式热路径分配断言**：1,000 Token（含 500 `ThoughtDelta` + 500 `TextDelta`）流式聚合后，`AgentMessage.blocks` 中的 `Thinking` 块数量从 500 个收敛为 **1 个**；`AgentMessage.metadata` 不再包含重复的 `"text"` / `"thought"` / `"thoughtBlocks"` 字符串副本，单条长思考消息内存占用下降 **$\ge 65\%$**。
2. **单轮工具 Schema 零重算断言**：在 30 个注册工具的多轮会话中，第 $2 \dots N$ 轮的 `estimate_context` 与 `capture_signature` 对 `ToolSchema.input_schema` 的克隆次数与 `serde_json::to_string` 调用次数严格为 **0**。
3. **消息哈希零堆分配断言**：`cache_tracker::message_hash` 对含 50KiB `ToolResult` 的消息计算签名时，堆内存分配字节数从 $>100\text{KiB}$ 降至 **0 Bytes**。
4. **安全点检查点采集零分配断言**：`collect_checkpoint_from_messages` 在不含 `CHECKPOINT:` 的 100 条历史消息（每条含 50KiB 工具输出）上执行时，堆分配次数为 **0**，耗时从毫秒级降至 **$< 20\mu\text{s}$**。
5. **混合批次因果序不变量测试**：给定调用序列 `[Parallel(A), Sequential(B), Parallel(C), Parallel(D)]`，`BatchPlanner::plan` 必须产出 3 个有序执行组 `[Parallel([A]), Sequential([B]), Parallel([C, D])]`，严禁将 `C, D` 提至 `B` 之前。
6. **压缩摘要强停响应断言**：在 `summarize_via_blocking` 模拟阻塞 60s 期间触发 `abort_signal.abort()`，`compact_with_llm_guard` 与 `compression_ladder` 必须在 **$< 10\text{ms}$** 内立即退出返回，严禁阻塞至 60s 超时。
7. **门禁全绿断言**：`cargo test -p session-loop` 与 `cargo clippy -p session-loop --all-targets -- -D warnings` 100% 零告警通过。
