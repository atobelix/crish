/**
 * demo-data.js — Conex / Crish Authentic Project Synthetic Workflow Dataset
 * Reflects real Conex architecture:
 *   crates/session-loop, crates/orchestrator, crates/agent-tools, apps/crish-desktop, packages/conex-protocol
 * Comprehensive multi-turn synthetic data with rich tool logs, code diffs, benchmarks, and subagent traces.
 */
window.DemoData = {
  conversation: [
    {
      id: 'u1',
      role: 'user',
      time: '11:30',
      text: '请帮我重构 Conex 核心事件循环（crates/session-loop）与前端桌面工作台的 IPC 并发分发，解决高频输出时的 UI 掉帧问题。',
    },
    {
      id: 'a1',
      role: 'assistant',
      time: '11:31',
      blocks: [
        {
          type: 'thinking',
          preview: '检查 crates/session-loop、crates/orchestrator 与 packages/conex-protocol 架构…',
          content:
            '分析目标：消除高频 Token 流式输出与 Tool Execution 事件对 Tauri IPC 和 WebView2 主线程的过载冲击。\n\n' +
            '1. 检查 `crates/session-loop/Cargo.toml` 与 `src/lib.rs`，观察现有事件下发机制。\n' +
            '2. 现状分析：当前内核每产生一个 Token 或 Step 变动，都会无缓冲直接通过 mpsc 发送并在 Tauri 桥上触发一次 emit；当大模型以 120 tok/s 输出时，IPC 通道发生拥塞与主线程布局抖动。\n' +
            '3. 解决方案：引入 `EventBatcher`（16ms 帧对齐节流窗口 + 环形缓冲区），在 Rust 内核侧合并微小事件流，按渲染帧率均匀推送到前端。\n' +
            '4. 验证计划：先编写 unit test 覆盖批量归并逻辑，再通过 Vitest 验证前端协议解析器的兼容性。\n' +
            '5. 端到端压测：对比改造前后的 10,000 事件吞吐与 WebView2 主线程掉帧率。',
          elapsed: '3.4s',
        },
        {
          type: 'plan',
          id: 'plan-conex-ipc-refactor',
          title: 'Conex 引擎内核与桌面端 IPC 高频事件流控重构',
          status: 'running',
          currentStepIndex: 1, // 0-indexed: Step 2 (2/5)
          steps: [
            {
              id: 'step-1',
              title: '摸清 crates/session-loop 与 IPC 通道瓶颈',
              status: 'done',
              children: [
                {
                  type: 'purpose',
                  id: 'p-1',
                  primary: '摸清项目依赖与 IPC 入口',
                  secondary: ['浏览 session-loop 源码结构', '定位 emit_event 调用点'],
                  status: 'success',
                  tools: [
                    {
                      id: 'tc-1',
                      name: 'read_file',
                      status: 'success',
                      arguments: JSON.stringify({ path: 'crates/session-loop/Cargo.toml' }),
                      output:
                        '[package]\n' +
                        'name = "conex-session-loop"\n' +
                        'version = "0.4.0"\n' +
                        'edition = "2021"\n' +
                        'description = "Core asynchronous session loop & task state machine for Conex"\n\n' +
                        '[dependencies]\n' +
                        'tokio = { version = "1.38", features = ["full", "tracing"] }\n' +
                        'tokio-util = { version = "0.7", features = ["time", "codec"] }\n' +
                        'serde = { version = "1.0", features = ["derive"] }\n' +
                        'serde_json = "1.0"\n' +
                        'tracing = "0.1"\n' +
                        'async-trait = "0.1"\n' +
                        'futures = "0.3"\n' +
                        'crossbeam-queue = "0.3"\n' +
                        'conex-protocol = { path = "../../packages/conex-protocol" }\n' +
                        'conex-telemetry = { path = "../conex-telemetry" }\n\n' +
                        '[dev-dependencies]\n' +
                        'criterion = { version = "0.5", features = ["async_tokio"] }\n' +
                        'tokio-test = "0.4"\n' +
                        'tempfile = "3.10"',
                    },
                    {
                      id: 'tc-2',
                      name: 'grep_search',
                      status: 'success',
                      arguments: JSON.stringify({ path: 'crates/session-loop/src', query: 'emit_event' }),
                      output:
                        'crates/session-loop/src/lib.rs:88:        self.ipc_sender.send(SessionEvent::Token(chunk)).await?;\n' +
                        'crates/session-loop/src/lib.rs:142:       self.ipc_sender.send(SessionEvent::StepCompleted(id)).await?;\n' +
                        'crates/session-loop/src/engine.rs:45:     self.emitter.emit_event("session:event", payload).await?;\n' +
                        'crates/session-loop/src/dispatcher.rs:91: self.tx.send(InternalEvent::Batch(events)).await?;',
                    },
                    {
                      id: 'tc-2b',
                      name: 'read_file',
                      status: 'success',
                      arguments: JSON.stringify({ path: 'crates/session-loop/src/lib.rs', lines: '75-110' }),
                      output:
                        '    async fn handle_llm_stream(&mut self, mut stream: EventStream) -> Result<(), SessionError> {\n' +
                        '        while let Some(event) = stream.next().await {\n' +
                        '            match event {\n' +
                        '                StreamEvent::Token(chunk) => {\n' +
                        '                    // 瓶颈所在：每次 token 直接触发单次 channel send 与 IPC 广播\n' +
                        '                    self.ipc_sender.send(SessionEvent::Token(chunk)).await?;\n' +
                        '                }\n' +
                        '                StreamEvent::ToolCall(call) => {\n' +
                        '                    self.ipc_sender.send(SessionEvent::ToolCall(call)).await?;\n' +
                        '                }\n' +
                        '            }\n' +
                        '        }\n' +
                        '        Ok(())\n' +
                        '    }',
                    },
                  ],
                },
                {
                  type: 'purpose',
                  id: 'p-1b',
                  primary: '分析事件分发链路与背压缺失点',
                  secondary: ['审查 crates/orchestrator/src/dispatcher.rs', '分析 Tokio 队列吞吐特征'],
                  status: 'success',
                  tools: [
                    {
                      id: 'tc-2c',
                      name: 'read_file',
                      status: 'success',
                      arguments: JSON.stringify({ path: 'crates/orchestrator/src/dispatcher.rs', lines: '30-65' }),
                      output:
                        'pub struct EventDispatcher {\n' +
                        '    outbound_tx: mpsc::Sender<TauriIpcEnvelope>,\n' +
                        '    max_in_flight: usize,\n' +
                        '}\n\n' +
                        'impl EventDispatcher {\n' +
                        '    pub async fn dispatch(&self, envelope: TauriIpcEnvelope) -> Result<()> {\n' +
                        '        // 缺乏按时间窗口汇聚机制，导致瞬时产生上万次序列化开销\n' +
                        '        self.outbound_tx.send(envelope).await.map_err(|_| Error::ChannelClosed)\n' +
                        '    }\n' +
                        '}',
                    },
                    {
                      id: 'tc-2d',
                      name: 'run_command',
                      status: 'success',
                      arguments: JSON.stringify({ command: 'cargo check -p session-loop' }),
                      output: '    Checking conex-session-loop v0.4.0 (c:/Software/conex/crates/session-loop)\n    Finished dev [unoptimized + debuginfo] target(s) in 0.82s',
                    },
                  ],
                },
              ],
            },
            {
              id: 'step-2',
              title: '重构 crates/session-loop 批量缓冲与调度器',
              status: 'running',
              children: [
                {
                  type: 'purpose',
                  id: 'p-2',
                  primary: '实现 EventBatcher 16ms 节流窗口与背压反馈',
                  secondary: ['新增 batcher.rs', '接入 cargo test 单测验证'],
                  status: 'success',
                  tools: [
                    {
                      id: 'tc-3',
                      name: 'edit_file',
                      status: 'success',
                      arguments: JSON.stringify({
                        path: 'crates/session-loop/src/batcher.rs',
                        changes: '// +112 -18: 实现 16ms RingBuffer 聚合与自适应 Flush 机制',
                      }),
                      diffStat: '+112 −18',
                      output:
                        '@@ -1,30 +1,114 @@\n' +
                        '+use std::time::{Duration, Instant};\n' +
                        '+use tokio::sync::mpsc;\n' +
                        '+use crate::events::SessionEvent;\n' +
                        '+\n' +
                        '+pub struct EventBatcher {\n' +
                        '+    buffer: Vec<SessionEvent>,\n' +
                        '+    max_batch_size: usize,\n' +
                        '+    flush_interval: Duration,\n' +
                        '+    last_flush: Instant,\n' +
                        '+    sender: mpsc::Sender<Vec<SessionEvent>>,\n' +
                        '+}\n' +
                        '+\n' +
                        '+impl EventBatcher {\n' +
                        '+    pub fn new(sender: mpsc::Sender<Vec<SessionEvent>>, max_batch_size: usize, flush_interval_ms: u64) -> Self {\n' +
                        '+        Self {\n' +
                        '+            buffer: Vec::with_capacity(max_batch_size),\n' +
                        '+            max_batch_size,\n' +
                        '+            flush_interval: Duration::from_millis(flush_interval_ms),\n' +
                        '+            last_flush: Instant::now(),\n' +
                        '+            sender,\n' +
                        '+        }\n' +
                        '+    }\n' +
                        '+\n' +
                        '+    pub async fn push(&mut self, event: SessionEvent) -> Result<(), mpsc::error::SendError<Vec<SessionEvent>>> {\n' +
                        '+        self.buffer.push(event);\n' +
                        '+        if self.buffer.len() >= self.max_batch_size || self.last_flush.elapsed() >= self.flush_interval {\n' +
                        '+            self.flush().await?;\n' +
                        '+        }\n' +
                        '+        Ok(())\n' +
                        '+    }\n' +
                        '+\n' +
                        '+    pub async fn flush(&mut self) -> Result<(), mpsc::error::SendError<Vec<SessionEvent>>> {\n' +
                        '+        if self.buffer.is_empty() {\n' +
                        '+            return Ok(());\n' +
                        '+        }\n' +
                        '+        let batch = std::mem::replace(&mut self.buffer, Vec::with_capacity(self.max_batch_size));\n' +
                        '+        self.last_flush = Instant::now();\n' +
                        '+        self.sender.send(batch).await\n' +
                        '+    }\n' +
                        '+}',
                    },
                    {
                      id: 'tc-4',
                      name: 'run_command',
                      status: 'success',
                      arguments: JSON.stringify({ command: 'cargo test -p conex-session-loop -- --nocapture' }),
                      output:
                        'running 12 tests\n' +
                        'test batcher::tests::test_batch_flush_interval ... ok\n' +
                        'test batcher::tests::test_ring_buffer_overflow ... ok\n' +
                        'test batcher::tests::test_batcher_capacity_reclaim ... ok\n' +
                        'test batcher::tests::test_concurrent_flushes ... ok\n' +
                        'test loop::tests::test_session_lifecycle ... ok\n' +
                        'test loop::tests::test_token_stream_aggregation ... ok\n' +
                        'test loop::tests::test_backpressure_threshold ... ok\n' +
                        'test loop::tests::test_cancelled_task_cleanup ... ok\n' +
                        'test dispatcher::tests::test_ipc_message_packer ... ok\n' +
                        'test dispatcher::tests::test_priority_queue_ordering ... ok\n' +
                        'test dispatcher::tests::test_heartbeat_liveness ... ok\n' +
                        'test telemetry::tests::test_fps_metric_collection ... ok\n\n' +
                        'test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.18s',
                    },
                  ],
                },
                {
                  type: 'purpose',
                  id: 'p-2b',
                  primary: '接入自适应背压窗口与丢帧防护机制',
                  secondary: ['实现 BackpressureController', '压测 10,000 事件下的内存占用稳定在 12MB 内'],
                  status: 'success',
                  tools: [
                    {
                      id: 'tc-4b',
                      name: 'edit_file',
                      status: 'success',
                      arguments: JSON.stringify({
                        path: 'crates/session-loop/src/backpressure.rs',
                        changes: '// +84 -6: 实现滑动窗口流量控制器与高水位警告',
                      }),
                      diffStat: '+84 −6',
                      output:
                        '@@ -1,10 +1,88 @@\n' +
                        '+pub struct BackpressureController {\n' +
                        '+    high_watermark: usize,\n' +
                        '+    low_watermark: usize,\n' +
                        '+    in_flight: std::sync::atomic::AtomicUsize,\n' +
                        '+}\n' +
                        '+\n' +
                        '+impl BackpressureController {\n' +
                        '+    pub fn should_throttle(&self) -> bool {\n' +
                        '+        self.in_flight.load(std::sync::atomic::Ordering::Relaxed) >= self.high_watermark\n' +
                        '+    }\n' +
                        '+}',
                    },
                    {
                      id: 'tc-4c',
                      name: 'run_command',
                      status: 'success',
                      arguments: JSON.stringify({ command: 'cargo test -p conex-session-loop --test backpressure_suite' }),
                      output:
                        'running 4 tests\n' +
                        'test test_high_watermark_throttling ... ok\n' +
                        'test test_low_watermark_recovery ... ok\n' +
                        'test test_rapid_burst_recovery ... ok\n' +
                        'test test_zero_allocation_window ... ok\n\n' +
                        'test result: ok. 4 passed; 0 failed; 0 ignored; finished in 0.09s',
                    },
                  ],
                },
                {
                  type: 'subagent',
                  id: 'sa-1',
                  name: '并发性能与协议一致性校验 subagent',
                  status: 'running',
                  elapsed: '1.8s',
                  traces: [
                    ['校验 session-loop 批处理契约', '分析 10k 事件峰值吞吐量'],
                    ['比对前后端帧率抖动', '执行 Vitest 协议回归测试'],
                  ],
                  children: [
                    {
                      type: 'purpose',
                      id: 'p-sa-1',
                      primary: '执行前端协议一致性回归测试',
                      status: 'success',
                      tools: [
                        {
                          id: 'tc-5',
                          name: 'read_file',
                          status: 'success',
                          arguments: JSON.stringify({ path: 'packages/conex-protocol/src/events.ts' }),
                          output:
                            'export interface BatchedSessionEvents {\n' +
                            '  version: 1;\n' +
                            '  timestamp: number;\n' +
                            '  events: SessionEvent[];\n' +
                            '}\n\n' +
                            'export type SessionEvent =\n' +
                            '  | { kind: "token"; chunk: string; index: number }\n' +
                            '  | { kind: "step_start"; stepId: string; title: string }\n' +
                            '  | { kind: "step_done"; stepId: string; status: "done" | "error" }\n' +
                            '  | { kind: "tool_call"; toolId: string; name: string; args: string };',
                        },
                        {
                          id: 'tc-5b',
                          name: 'edit_file',
                          status: 'success',
                          arguments: JSON.stringify({
                            path: 'packages/conex-protocol/src/batch_decoder.ts',
                            changes: '// +42 -5: 优化微秒级批量反序列化解析性能',
                          }),
                          diffStat: '+42 −5',
                          output:
                            '@@ -10,8 +10,45 @@\n' +
                            '+export function decodeBatchedEvents(payload: ArrayBuffer): SessionEvent[] {\n' +
                            '+  const view = new DataView(payload);\n' +
                            '+  // 高性能零拷贝分块解析\n' +
                            '+  return parseZeroCopyStream(view);\n' +
                            '+}',
                        },
                        {
                          id: 'tc-6',
                          name: 'run_command',
                          status: 'success',
                          arguments: JSON.stringify({ command: 'npx vitest run packages/conex-protocol' }),
                          output:
                            ' ✓ packages/conex-protocol/test/events.spec.ts (6 tests) 18ms\n' +
                            ' ✓ packages/conex-protocol/test/batch_decoder.spec.ts (8 tests) 14ms\n\n' +
                            ' Test Files  2 passed (2)\n' +
                            '      Tests  14 passed (14)\n' +
                            '   Start at  11:31:42\n' +
                            '   Duration  380ms',
                        },
                      ],
                    },
                    {
                      type: 'purpose',
                      id: 'p-sa-2',
                      primary: '执行 10,000 TPS 峰值事件流基准测试',
                      status: 'success',
                      tools: [
                        {
                          id: 'tc-7',
                          name: 'run_command',
                          status: 'success',
                          arguments: JSON.stringify({ command: 'cargo bench -p conex-session-loop' }),
                          output:
                            'Benchmarking batcher_10k_events:\n' +
                            '  time:   [1.1242 ms 1.1310 ms 1.1388 ms]\n' +
                            '  thrpt:  [8.7811 Melem/s 8.8417 Melem/s 8.8952 Melem/s]\n\n' +
                            'Benchmarking zero_copy_deserialization:\n' +
                            '  time:   [242.10 µs 244.52 µs 247.19 µs]\n' +
                            '  change: [-74.2% -73.5% -72.8%] (p = 0.00 < 0.05)\n' +
                            '  Performance has improved significantly.',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              id: 'step-3',
                  title: '优化 apps/crish-desktop 虚拟流式渲染管线',
                  status: 'pending',
                },
                {
                  id: 'step-4',
                  title: '执行 cargo test --workspace 与端到端压测',
                  status: 'pending',
                },
                {
                  id: 'step-5',
                  title: '生成 Conex IPC 性能优化评审与变更摘要报告',
                  status: 'pending',
                },
              ],
        },
        {
          type: 'text',
          id: 'txt-1',
          text: '已完成 `crates/session-loop` 的批处理缓冲与背压流控改造。压测结果显示序列化开销大幅下降，无掉帧现象。以下是技术评审与对比报告：',
        },
        {
          type: 'artifact',
          id: 'art-1',
          title: 'PE-08-session-loop-ipc-batcher.md',
          mime: 'markdown',
          content:
            '# Conex IPC Event Batcher 性能改造技术评审\n\n' +
            '## 一、核心指标收益\n\n' +
            '| 评估维度 | 改造前 (Baseline) | 改造后 (Batcher 16ms) | 优化幅度 |\n' +
            '| :--- | :--- | :--- | :--- |\n' +
            '| **IPC 调用频次 (120 tok/s)** | 120 calls/sec | 60 calls/sec (固定帧率) | **-50.0%** |\n' +
            '| **WebView2 主线程掉帧 (Frame Drop)** | 18.4% (卡顿明显) | < 0.2% (全程 60 FPS) | **消除掉帧** |\n' +
            '| **10k 事件反序列化耗时** | 948 µs | 244 µs (零拷贝解析) | **-74.2%** |\n' +
            '| **内核内存开销 (Peak RSS)** | 28.6 MB | 11.4 MB (环形缓冲区复用) | **-60.1%** |\n\n' +
            '## 二、架构变更明细\n\n' +
            '1. **crates/session-loop/src/batcher.rs**\n' +
            '   - 新增 `EventBatcher` 结构，采用 16ms 帧对齐窗口与环形缓冲区。\n' +
            '   - 当积攒达到 `max_batch_size = 64` 或超时 16ms 时自动触发零分配刷新。\n\n' +
            '2. **crates/session-loop/src/backpressure.rs**\n' +
            '   - 新增 `BackpressureController`，当待消费消息超过高水位（512 条）时对 LLM 读取端实施轻微微秒级背压。\n\n' +
            '3. **packages/conex-protocol/src/batch_decoder.ts**\n' +
            '   - 前端增加 `decodeBatchedEvents` 批量解析器，配合 React 批量更新机制。\n\n' +
            '## 三、测试与验证状态\n\n' +
            '- [x] `cargo test -p conex-session-loop` (12 项单测通过)\n' +
            '- [x] `cargo test -p conex-session-loop --test backpressure_suite` (4 项单测通过)\n' +
            '- [x] `npx vitest run packages/conex-protocol` (14 项测试全部通过)\n' +
            '- [x] `cargo bench -p conex-session-loop` (吞吐量达到 8.84 Melem/s)',
        },
        {
          type: 'composing',
          id: 'comp-1',
          text: '正在同步 batcher.rs 与前端虚拟列表渲染管线…',
        }
      ],
    },
    {
      id: 'u2',
      role: 'user',
      time: '11:35',
      text: '现在的压测效果不错。不过，能再帮我检查一下 `conex-protocol` 里面是否有遗漏的类型定义吗？我记得之前有一个 `IpcMessage` 的变体没处理。',
    },
    {
      id: 'a2',
      role: 'assistant',
      time: '11:36',
      blocks: [
        {
          type: 'text',
          text: '好的，我马上帮您检查 `conex-protocol` 的类型定义。',
        },
        {
          type: 'purpose',
          id: 'p-2',
          primary: '检查 IPC 类型定义',
          secondary: ['扫描 IpcMessage 变体', '比对 Rust 与 TS 定义'],
          status: 'success',
          tools: []
        }
      ]
    },
    {
      id: 'u3',
      role: 'user',
      time: '11:38',
      text: '嗯，不仅是 `IpcMessage`，还有 `SessionEvent`。帮我都扫一遍。',
    },
    {
      id: 'a3',
      role: 'assistant',
      time: '11:39',
      blocks: [
        {
          type: 'text',
          text: '好的，正在全面扫描内核的 Event 定义与前端的映射。',
        },
        {
          type: 'action',
          id: 'act-1',
          status: 'success',
          verb: '搜索',
          objectLabel: 'SessionEvent 定义',
          path: 'crates/session-loop/src/lib.rs',
          consoleOutput: 'Found 4 variants: Token, StepCompleted, Batch, Error'
        }
      ]
    },
    {
      id: 'u4',
      role: 'user',
      time: '11:42',
      text: '看起来 `Error` 变体在 TS 那边应该是映射为 `IpcError`。能不能顺便帮我写一段处理 `IpcError` 的 React Hook，用于全局拦截并展示一个 Toast 提示？',
    },
    {
      id: 'a4',
      role: 'assistant',
      time: '11:45',
      blocks: [
        {
          type: 'text',
          text: '没问题，我这就为您编写一个 `useIpcErrorHandler` Hook。',
        },
        {
          type: 'action',
          id: 'act-2',
          status: 'success',
          verb: '写入文件',
          objectLabel: 'hooks/useIpcError.ts',
          path: 'apps/crish-desktop/src/hooks/useIpcError.ts',
          consoleOutput: 'export function useIpcErrorHandler() { ... }'
        },
        {
          type: 'text',
          text: '我已经创建了该 Hook，您可以在应用的顶层组件中直接调用它来进行全局拦截。'
        }
      ]
    },
    {
      id: 'u5',
      role: 'user',
      time: '11:50',
      text: '干得漂亮。接下来我们要考虑对子 Agent 的管理功能了。在 `agent-tools` 里面新增一个专门用于列出现有活跃子任务的接口吧。',
    },
    {
      id: 'a5',
      role: 'assistant',
      time: '11:51',
      blocks: [
        {
          type: 'thinking',
          preview: '构思子任务管理接口...',
          content: '分析：需要在 `agent-tools` 中添加 `list_active_subtasks` 方法，并通过 IPC 暴露。\n将修改对应的 Rust 代码并更新 TS 定义。',
          elapsed: '2.1s'
        }
      ]
    }
  ],
  pendingApprovals: [
    {
      id: 'appr-1',
      type: 'command',
      command: 'cargo test --workspace --exclude conex-integration-e2e',
      reason: '执行内核工作区全部 73 项单测基线校验，验证全局无回归。',
      risk: 'low',
    },
  ],
};
