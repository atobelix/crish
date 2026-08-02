//! PE-09 T09.7 基准：SSE 帧解析吞吐（P5 相关：流式路径的帧级成本）
//!
//! 场景（任务书 5 场景之一：agent-provider SSE 帧解析）：
//! - `sse_text_framing`：原始 SSE 文本字节 → [SseParser] 分帧——逐 token
//!   帧的流式文本解析吞吐（MB/s 与帧/s）；
//! - `chat_delta_parsing`：[SseFrame] → [ChatCompletionsParser] 逐帧解析
//!   （content / thought / tool_calls / finish_reason 提取 + StreamParser
//!   校验）——每帧事件产出吞吐（帧/s）。
//!
//! 运行：`cargo bench -p agent-provider --bench sse_parse`
//! 快速模式：`cargo bench -p agent-provider --bench sse_parse -- --measurement-time 1 --warm-up-time 0.2`

use agent_provider::parse::chat::ChatCompletionsParser;
use agent_provider::sse::frame::{SseFrame, SseParser};
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

/// 构造一条 chat-completions 增量帧的 SSE 文本（逐 token 一帧）
fn delta_frame_text(i: usize) -> String {
    format!(
        "data: {{\"id\":\"chatcmpl-1\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"增量第 {i} 个 token 的文本片段\"}},\"finish_reason\":null}}]}}\n\n"
    )
}

/// 构造 1000 帧的原始 SSE 文本（token 流形态）
fn sse_text(count: usize) -> String {
    (0..count).map(delta_frame_text).collect()
}

/// 按块大小切分文本（模拟网络分块到达；真实流为 reqwest 字节块）
fn chunked(text: &str, chunk_size: usize) -> Vec<Vec<u8>> {
    text.as_bytes()
        .chunks(chunk_size)
        .map(<[u8]>::to_vec)
        .collect()
}

/// 预解析出帧（chat_delta_parsing 的输入；分帧成本已由上一组隔离）
fn frames(text: &str) -> Vec<SseFrame> {
    let mut parser = SseParser::new();
    let mut frames = Vec::new();
    for chunk in chunked(text, 1024) {
        frames.extend(parser.push(&chunk).expect("分帧"));
    }
    frames.extend(parser.finish().expect("收尾分帧"));
    frames
}

fn bench_sse_parse(c: &mut Criterion) {
    // 文本分帧吞吐（字节 → SseFrame；按真实网络分块大小切分，
    // 避免一次性推入导致 pending.drain 前移的 O(n²) 测量失真）
    let text = sse_text(1000);
    let mut framing_group = c.benchmark_group("sse_parse/text_framing");
    framing_group.throughput(criterion::Throughput::Bytes(text.len() as u64));
    for chunk_size in [1024usize, 16 * 1024] {
        let chunks = chunked(&text, chunk_size);
        framing_group.bench_with_input(
            BenchmarkId::new("chunks", format!("{}B 块", chunk_size)),
            &chunks,
            |b, chunks| {
                b.iter_batched(
                    SseParser::new,
                    |mut parser| {
                        let mut out = Vec::new();
                        for chunk in chunks {
                            out.extend(parser.push(chunk).expect("分帧"));
                        }
                        out.extend(parser.finish().expect("收尾"));
                        criterion::black_box(&out);
                    },
                    criterion::BatchSize::SmallInput,
                );
            },
        );
    }
    framing_group.finish();

    // 帧 → 流事件解析吞吐（每帧 1 条 text-delta）
    let frame_set = frames(&text);
    let mut parse_group = c.benchmark_group("sse_parse/chat_delta");
    parse_group.throughput(criterion::Throughput::Elements(frame_set.len() as u64));
    parse_group.bench_function("1000_frames", |b| {
        b.iter_batched(
            ChatCompletionsParser::new,
            |mut parser| {
                let mut events = Vec::new();
                for frame in &frame_set {
                    events.extend(parser.push_frame(frame).expect("解析帧"));
                }
                events.extend(parser.finish().expect("收尾"));
                criterion::black_box(&events);
            },
            criterion::BatchSize::SmallInput,
        );
    });
    parse_group.finish();
}

criterion_group!(benches, bench_sse_parse);
criterion_main!(benches);
