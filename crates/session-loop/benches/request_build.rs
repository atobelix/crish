//! PE-09 T09.7 基准：对话克隆 / 消息记录 / 每 token 聚合（P3/P4 + consume）
//!
//! 场景（任务书 5 场景之一：session-loop 对话克隆与消息记录）：
//! - `request_build`：100/1000/5000 消息下构造 [ProviderRequest]（借用切片
//!   `&[Arc<AgentMessage>]`）——P3 零拷贝验证：请求构建链 0 深克隆，随
//!   对话规模增大耗时应保持平（O(1)），不得线性于消息数；
//! - `consume_delta`：1000 条 TextDelta 的增量聚合 + finish——每 token
//!   处理耗时（ns/token，P1 增量路径的聚合侧成本）；
//! - `record_message`：消息记录路径（Arc 化后 0 深克隆）——1KB/10KB 消息
//!   的对话 push + start/end 事件构造，验证代价随正文大小近似不敏感
//!   （深克隆应 2→0，PE-09 T09.3.2）。
//!
//! 运行：`cargo bench -p session-loop --bench request_build`
//! 快速模式：`cargo bench -p session-loop --bench request_build -- --measurement-time 1 --warm-up-time 0.2`

use std::sync::Arc;

use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use session_loop::provider::ProviderRequest;
use session_loop::stream::{ConsumeBuilder, ProviderStreamEvent, StopReason};

/// 构造一条历史消息（正文可配大小）
fn message(id: &str, text: &str) -> AgentMessage {
    AgentMessage {
        id: id.to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        blocks: vec![AgentMessageBlock::Text { text: text.into() }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

/// 构造 N 条历史消息的对话（Arc 化形态，与 LoopState.conversation 一致）
fn conversation(count: usize) -> Vec<Arc<AgentMessage>> {
    (0..count)
        .map(|i| Arc::new(message(&format!("m-{i}"), "历史消息正文")))
        .collect()
}

/// 请求构建链（P3：借用切片，0 深拷贝；tools 为空集——隔离对话成本）
fn build_request(conversation: &[Arc<AgentMessage>]) -> ProviderRequest<'_> {
    ProviderRequest {
        messages: conversation,
        tools: Vec::new(),
        max_tokens: Some(8192),
    }
}

/// 消息记录路径模拟（与 handlers/mod.rs record_message / streaming.rs
/// commit_message_with_deltas 的 Arc 化形态逐行一致：Arc 1 次 + push 共享，
/// 0 深克隆；bench 无法访问 pub(crate) 内部函数，此处按生产路径原样复刻）
fn record_message_sim(conversation: &mut Vec<Arc<AgentMessage>>, text: &str) {
    let message = Arc::new(message("assistant-1", text));
    conversation.push(message.clone());
    let event = AgentEvent::MessageEnd {
        session_id: "s1".to_string(),
        message: message.clone(),
    };
    criterion::black_box(event);
}

/// consume 增量聚合（P1 聚合侧：1000 条 delta push + finish）
fn consume_delta(count: usize) {
    let mut builder = ConsumeBuilder::new();
    for i in 0..count {
        builder.push(ProviderStreamEvent::TextDelta {
            text: format!("增量片段 {i}"),
        });
    }
    builder.push(ProviderStreamEvent::Stop {
        reason: StopReason::Stop,
        error: None,
        usage: None,
    });
    let consumed = builder.finish(false);
    criterion::black_box(consumed);
}

fn bench_request_build(c: &mut Criterion) {
    // P3：请求构建链 0 拷贝——100/1000/5000 消息应近乎持平（O(1)）
    let mut group = c.benchmark_group("request_build/borrow_chain");
    for count in [100usize, 1000, 5000] {
        let conversation = conversation(count);
        group.bench_with_input(
            BenchmarkId::new("provider_request", format!("{count} 消息")),
            &conversation,
            |b, conv| {
                b.iter(|| {
                    let request = build_request(conv);
                    criterion::black_box(&request);
                });
            },
        );
    }
    group.finish();

    // 消息记录：Arc 化后代价与正文大小弱相关（0 深克隆）
    let mut record_group = c.benchmark_group("request_build/record_message");
    for text_len in [1024usize, 10 * 1024] {
        let body = "A".repeat(text_len);
        record_group.bench_with_input(
            BenchmarkId::new("arc_push", format!("{text_len}B")),
            &body,
            |b, text| {
                b.iter_batched(
                    Vec::new,
                    |mut conv| record_message_sim(&mut conv, text),
                    criterion::BatchSize::SmallInput,
                );
            },
        );
    }
    record_group.finish();

    // 每 token 聚合：1000 条 delta（ns/token）
    let mut consume_group = c.benchmark_group("request_build/consume_delta");
    consume_group.throughput(criterion::Throughput::Elements(1000));
    consume_group.bench_function("1000_text_delta", |b| {
        b.iter(|| consume_delta(1000));
    });
    consume_group.finish();
}

criterion_group!(benches, bench_request_build);
criterion_main!(benches);
