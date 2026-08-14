//! PE-09 T09.7 基准：事件链克隆 / 序列化 / 驱动（P2）
//!
//! 场景：drive_outcome 驱动 100 事件（agent-start + turn 包 + 20 工具批 +
//! 大 MessageEnd 1KB/10KB 文本），经 EventQueue 全链（type_name → 序列化 →
//! store 追加）。指标：每事件耗时 / 总耗时（内存 store，不含 DB I/O）。
//!
//! 基线对照（G2）：持久化事件路径深克隆 2→0 后，本基准记录每事件
//! 处理耗时的绝对数字；随消息体增大（1KB→10KB）应近似线性于序列化
//! 成本，而非深克隆的二次项。
//!
//! 运行：`cargo bench -p orchestrator --bench event_chain`
//! 快速模式：`cargo bench -p orchestrator --bench event_chain -- --measurement-time 1 --warm-up-time 0.2`

use std::sync::Arc;

use conex_types::events::{AgentEvent, RunTerminalStatus};
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::session::AgentEndReason;
use conex_types::tool::{
    ToolBatchCall, ToolBatchResult, ToolCategory, ToolConcurrency, ToolOutput,
};
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use orchestrator::events::{drive_outcome, EventQueue};
use orchestrator::persist::{InMemoryStore, Store};
use orchestrator::run::RunManager;
use session_loop::RunOutcome;

/// 固定时间戳（事件构造开销不纳入基准目标）
fn ts() -> String {
    "2026-01-01T00:00:00.000Z".to_string()
}

/// 构造一条消息（正文块，文本大小可配）
fn message(id: &str, text: &str) -> AgentMessage {
    AgentMessage {
        id: id.to_string(),
        role: AgentMessageRole::Assistant,
        created_at: ts(),
        blocks: vec![AgentMessageBlock::Text { text: text.into() }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

/// 构造一次工具调用（并行组内成员）
fn tool_call(i: usize) -> ToolBatchCall {
    ToolBatchCall {
        id: format!("call-{i}"),
        tool_name: "read_file".to_string(),
        summary: format!("读取文件 {i}").to_string(),
        input: serde_json::json!({ "path": "/tmp/f-{i}.txt" }),
        category: ToolCategory::Filesystem,
        concurrency: ToolConcurrency::Parallel,
    }
}

/// 构造 100 事件流（P2 场景：agent-start + 20 工具批 + 大 MessageEnd）
///
/// 事件构成（与 AA-06 P2 触发场景对齐）：
/// - agent-start / turn-start / turn-end / agent-end 各 1；
/// - 20 × tool-start / tool-end（工具批，P2 放大项）；
/// - message-start / message-end（1KB 或 10KB 正文，深克隆代价最大项）。
fn build_outcome(text_size: usize) -> RunOutcome {
    let session_id = "s1";
    let mut events: Vec<AgentEvent> = Vec::new();
    events.push(AgentEvent::AgentStart {
        session_id: session_id.to_string(),
        timestamp: ts(),
    });
    events.push(AgentEvent::TurnStart {
        session_id: session_id.to_string(),
        turn_index: 0,
        timestamp: ts(),
    });
    for i in 0..20 {
        events.push(AgentEvent::ToolStart {
            session_id: session_id.to_string(),
            batch_id: "batch-1".to_string(),
            call: tool_call(i),
            timestamp: ts(),
            turn_index: None,
        });
        events.push(AgentEvent::ToolEnd {
            session_id: session_id.to_string(),
            batch_id: "batch-1".to_string(),
            result: ToolBatchResult {
                id: format!("call-{i}"),
                tool_name: "read_file".to_string(),
                output: ToolOutput {
                    text: Some("读取结果".repeat(16)),
                    json: None,
                    artifacts: None,
                },
                is_error: false,
                duration_ms: 3,
            },
            timestamp: ts(),
            attempt: None,
            deduplicated: None,
            executed_input: None,
        });
    }
    // 大消息正文（1KB / 10KB）
    let body = "A".repeat(text_size);
    let message = Arc::new(message("assistant-1", &body));
    events.push(AgentEvent::MessageStart {
        session_id: session_id.to_string(),
        message: message.clone(),
    });
    events.push(AgentEvent::MessageEnd {
        session_id: session_id.to_string(),
        message,
        turn_index: None,
    });
    events.push(AgentEvent::TurnEnd {
        session_id: session_id.to_string(),
        turn_index: 0,
        tool_call_count: 20,
        timestamp: ts(),
        usage: None,
    });
    events.push(AgentEvent::AgentEnd {
        session_id: session_id.to_string(),
        timestamp: ts(),
        reason: AgentEndReason::Stop,
        error: None,
    });
    RunOutcome {
        reason: AgentEndReason::Stop,
        error: None,
        diagnostic: None,
        messages: Vec::new(),
        events,
        turn_index: 0,
        tool_call_count: 20,
        steering_count: 0,
        // T-36：缓存统计字段（本构造点无样本 → None，缺省向后兼容）
        cache_stats: None,
        // D1：provider 错误摘要（本构造点非 fatal 收场 → None，缺省向后兼容）
        provider_error: None,
    }
}

/// 驱动一次 outcome（每迭代全新 store / run / queue——事件路径无共享状态）
async fn drive(text_size: usize) {
    let store: Arc<dyn Store> = Arc::new(InMemoryStore::new());
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r1").await.expect("启动 run");
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);
    let outcome = build_outcome(text_size);
    let result = drive_outcome(&mut run, &mut queue, outcome).await.expect("驱动");
    assert_eq!(result.terminal_status, RunTerminalStatus::Completed);
}

/// 建 runtime（rt-multi-thread：orchestrator dev-deps 已声明）
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Runtime::new().expect("建 tokio runtime")
}

fn bench_event_chain(c: &mut Criterion) {
    let rt = runtime();
    let mut group = c.benchmark_group("event_chain/drive_outcome_100");
    for text_size in [1024usize, 10 * 1024] {
        group.throughput(criterion::Throughput::Elements(46));
        group.bench_with_input(
            BenchmarkId::new("message_end", format!("{text_size}B")),
            &text_size,
            |b, &size| {
                // 注意：block_on 必须直接接收 drive 的 future，不得用
                // `async { }` 块再包一层——实测该写法被优化器折叠，
                // criterion 计时失真约 50×（3.3µs vs 真实 178µs）
                b.iter(|| rt.block_on(drive(size)));
            },
        );
    }
    group.finish();

    // 单事件耗时分拆：逐事件 push（序列化 + type_name + store）路径。
    // 每迭代新建 store/queue——InMemoryStore::reserve 对累计事件线性扫描
    // （测试替身语义），复用队列会让扫描成本随迭代数增长而污染测量
    let mut push_group = c.benchmark_group("event_chain/push_per_event");
    let body = "A".repeat(10 * 1024);
    push_group.bench_function("message_end_10k", |b| {
        b.iter_batched(
            || {
                let store: Arc<dyn Store> = Arc::new(InMemoryStore::new());
                let event = AgentEvent::MessageEnd {
                    session_id: "s1".to_string(),
                    message: Arc::new(message("assistant-1", &body)),
                    turn_index: None,
                };
                (store, event)
            },
            |(store, event)| {
                let mut queue = rt.block_on(async { EventQueue::new(store.clone(), 1, None) });
                rt.block_on(async { queue.push("s1", event).await })
                    .expect("入队");
            },
            criterion::BatchSize::SmallInput,
        );
    });
    push_group.finish();
}

criterion_group!(benches, bench_event_chain);
criterion_main!(benches);
