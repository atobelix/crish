//! PE-09 T09.7 基准：DB 写入路径（P6）
//!
//! 场景：save_session_body 全量保存（100/1000/5000 消息）。
//!
//! 指标：每批耗时——全量路径 O(n)（DELETE 全表 + 逐条 INSERT +
//! 逐行触发器 UPDATE）。
//!
//! 运行：`cargo bench -p conex-db --bench db_write`
//! 快速模式：`cargo bench -p conex-db --bench db_write -- --measurement-time 1 --warm-up-time 0.2`

use conex_db::LocalDb;
use conex_types::SessionMessage;
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

/// 构造一条会话消息（正文可配大小）
fn message(i: usize, text_len: usize) -> SessionMessage {
    SessionMessage {
        id: format!("m-{i}"),
        sender: "assistant".to_string(),
        text: Some("A".repeat(text_len)),
        thinking: None,
        timestamp: 1_700_000_000_000 + i as i64,
        status: None,
        stream_text_offset: None,
        thinking_time: None,
        tool_calls_json: None,
        blocks_json: None,
        tool_call_results_json: None,
        usage: None,
    }
}

/// 建内存库并插入会话行（session_messages 外键引用 sessions.id）
fn db_with_session() -> LocalDb {
    let db = LocalDb::open_in_memory().expect("开内存库");
    db.insert_session("s1", "基准会话").expect("建会话行");
    db
}

/// 全量保存路径：先删后插（P6 写放大 O(n)）
fn save_full(db: &LocalDb, session_id: &str, messages: &[SessionMessage]) {
    db.save_session_body(session_id, messages)
        .expect("全量保存");
}

fn bench_db_write(c: &mut Criterion) {
    // 全量保存：消息数增长时耗时线性（O(n) 写放大对照）
    let mut full_group = c.benchmark_group("db_write/save_full");
    for count in [100usize, 1000, 5000] {
        let messages: Vec<SessionMessage> = (0..count).map(|i| message(i, 256)).collect();
        full_group.bench_with_input(
            BenchmarkId::new("messages", format!("{count}")),
            &messages,
            |b, messages| {
                b.iter_batched(
                    db_with_session,
                    |db| {
                        save_full(&db, "s1", messages);
                    },
                    criterion::BatchSize::SmallInput,
                );
            },
        );
    }
    full_group.finish();
}

criterion_group!(benches, bench_db_write);
criterion_main!(benches);
