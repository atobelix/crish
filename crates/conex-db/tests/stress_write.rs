//! DB 写路径压力测试（PE-11 T11.6.4，验证 AA-06 P6 写放大路径可测）
//!
//! 场景与断言：
//! - 连续 5000 事件写入：耗时统计（宽松上界）+ 完整性（行数 / 序列唯一
//!   连续 / 载荷可读回）；
//! - WAL 模式并发写：8 线程 × 500 事件 + 穿插会话 upsert——无锁冲突崩溃、
//!   failure latch 不触发、行数准确、序列号唯一；
//! - 写放大报告（报告模式，只统计不断言）：全量 `save_session_body` 重写
//!   耗时 vs 增量 `append_session_messages` 追加耗时。
//!
//! 运行方式（release，显式跑；默认不进常规 CI）：
//!   cargo test -p conex-db --release --test stress_write -- --ignored --nocapture

// G2 禁令豁免：测试临时 DB 清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use conex_db::LocalDb;
use conex_types::{SessionIndexEntry, SessionMessage};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// 唯一临时文件库（并行测试隔离；Drop 清理主文件 / WAL / SHM / 迁移备份）
struct TempDb {
    path: PathBuf,
}

impl TempDb {
    fn new(name: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "conex-stress-{name}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("sessions.db");
        let _ = std::fs::remove_file(&path);
        Self { path }
    }

    fn path(&self) -> &PathBuf {
        &self.path
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(format!("{}-wal", self.path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", self.path.display()));
        if let Some(parent) = self.path.parent() {
            if let Ok(entries) = std::fs::read_dir(parent) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    // 迁移链 DROP 前备份（sessions.db.bak-v{n}）一并清理
                    if name.starts_with("sessions.db.bak-v") {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
            let _ = std::fs::remove_dir_all(parent);
        }
    }
}

/// 构造会话索引条目（upsert 写放大路径的载荷）
fn sample_entry(id: &str, title: &str, updated_at: i64) -> SessionIndexEntry {
    SessionIndexEntry {
        id: id.to_string(),
        title: title.to_string(),
        folder: "常规会话".to_string(),
        is_pinned: false,
        is_archived: false,
        branch_parent_id: None,
        timestamp: "2026-01-01T00:00:00Z".to_string(),
        updated_at,
        message_count: 0,
        pinned_message_ids: None,
        engine_cursor: None,
        engine_last_run_id: None,
        hydrated_from_engine: None,
    }
}

/// 构造会话消息（save/append 写放大路径的载荷）
fn sample_message(id: &str, sender: &str, ts: i64) -> SessionMessage {
    SessionMessage {
        id: id.to_string(),
        sender: sender.to_string(),
        text: Some(format!("消息正文 {id}：用于放大全量保存的写入体积")),
        thinking: None,
        timestamp: ts,
        status: Some("completed".to_string()),
        stream_text_offset: None,
        thinking_time: None,
        tool_calls_json: None,
        blocks_json: None,
        tool_call_results_json: None,
        usage: None,
    }
}

/// 连续 5000 事件写入：耗时统计 + 完整性断言
#[test]
#[ignore]
fn stress_append_5000_events_timing_and_integrity() {
    let temp = TempDb::new("append5000");
    let db = LocalDb::open(temp.path()).expect("打开临时库");
    db.insert_session("s1", "压力会话").expect("建会话");

    let started = Instant::now();
    for seq in 1..=5000i64 {
        db.append_event("s1", seq, "agent-start", &format!(r#"{{"seq":{seq}}}"#))
            .expect("追加事件不应失败");
    }
    let elapsed = started.elapsed();

    // 完整性：行数 / 序列唯一连续 / 载荷可读回
    let events = db.query_events("s1", 0, None).expect("查询全部事件");
    assert_eq!(events.len(), 5000, "5000 条事件全部落库");
    let mut seqs: Vec<i64> = events.iter().map(|e| e.sequence).collect();
    seqs.sort_unstable();
    assert_eq!(seqs, (1..=5000).collect::<Vec<_>>(), "序列唯一连续");
    assert!(events[0].payload.contains("\"seq\":1"), "首事件载荷可读回");
    assert!(events[4999].payload.contains("\"seq\":5000"), "末事件载荷可读回");

    // 宽松上界（机器无关；正常 < 1s）
    assert!(elapsed.as_secs() < 60, "5000 事件顺序写入过慢：{elapsed:?}");
    println!(
        "[stress] 5000 事件顺序写入（单会话）耗时：{elapsed:?}（{:.0} 事件/秒），完整性 OK",
        5000.0 / elapsed.as_secs_f64()
    );
}

/// WAL 模式并发写：8 线程 × 500 事件 + 会话索引 upsert 混合
///
/// 单写者模型（Mutex<Connection> 串行化）下断言：无锁冲突崩溃、
/// failure latch 不触发、行数准确、序列号唯一、WAL 模式真实生效。
#[test]
#[ignore]
fn stress_wal_concurrent_appends_and_upserts() {
    let temp = TempDb::new("wal_concurrent");
    let db = LocalDb::open(temp.path()).expect("打开临时库（WAL 模式）");
    db.insert_session("s1", "并发会话").expect("建会话");
    let db = Arc::new(db);

    // 预写一条触发 WAL 边车文件（随后验证 journal_mode）。
    // 注意：query_events 的 after_sequence=0 语义为 `sequence > 0`，
    // 预热行序列号须落在线程区间之外（线程写 1..=4000，预热用 4001）
    db.append_event("s1", 4001, "warmup", "{}").expect("预热写入");

    let mut handles = Vec::new();
    for t in 0..8u64 {
        let db = db.clone();
        handles.push(std::thread::spawn(move || {
            // 每线程独立 sequence 区间：t*500+1 ..= (t+1)*500
            for i in 0..500u64 {
                let seq = t * 500 + i + 1;
                db.append_event(
                    "s1",
                    seq as i64,
                    "agent-start",
                    &format!(r#"{{"t":{t},"i":{i}}}"#),
                )
                .expect("并发追加不应失败");
            }
            // 并发 upsert 会话索引（P6 写放大路径：ON CONFLICT DO UPDATE）
            db.upsert_session_entry(&sample_entry(
                "s1",
                &format!("并发会话 {t}"),
                1000 + t as i64,
            ))
            .expect("并发 upsert 不应失败");
        }));
    }

    let started = Instant::now();
    for handle in handles {
        handle.join().expect("并发写线程不应 panic");
    }
    let elapsed = started.elapsed();

    // 无崩溃 + 无 failure latch + 行数准确 + 序列唯一
    assert!(db.get_failure().is_none(), "并发写不得触发 failure latch");
    let events = db.query_events("s1", 0, None).expect("查询全部事件");
    // 预热 1 条（seq=4001）+ 8×500 = 4001 条
    assert_eq!(events.len(), 4001, "预热 1 条 + 8×500 事件全部落库");
    let mut seqs: Vec<i64> = events.iter().map(|e| e.sequence).collect();
    seqs.sort_unstable();
    seqs.dedup();
    assert_eq!(seqs.len(), 4001, "序列号全部唯一（无锁冲突）");
    assert_eq!(db.list_sessions().expect("列出会话").len(), 1, "upsert 不产生重复会话");

    // WAL 模式验证：journal_mode 应为 wal（并发写友好，PE-08 T08.7）
    let probe = rusqlite::Connection::open(temp.path()).expect("探针连接");
    let mode: String = probe
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .expect("读取 journal_mode");
    assert_eq!(mode.to_lowercase(), "wal", "压力库应处于 WAL 模式");

    // 宽松上界（机器无关）
    assert!(elapsed.as_secs() < 120, "并发写耗时过长：{elapsed:?}");
    println!(
        "[stress] WAL 并发写（8 线程 × 500 事件 + 8 次 upsert）耗时：{elapsed:?}（{:.0} 事件/秒），行数准确、序列唯一、无崩溃",
        4001.0 / elapsed.as_secs_f64()
    );
}

/// 写放大报告（报告模式，只统计不断言耗时）：全量保存 vs 增量追加
///
/// AA-06 P6：`save_session_body` 每 commit 重写整个会话正文（O(n) 行
/// DELETE+INSERT）；`append_session_messages` 为增量追加路径——本报告给出
/// 两条路径的实测耗时差，供写放大数据留存。
#[test]
#[ignore]
fn stress_write_amplification_report() {
    let temp = TempDb::new("amplification");
    let db = LocalDb::open(temp.path()).expect("打开临时库");
    db.insert_session("s1", "写放大会话").expect("建会话");

    // 全量保存 2000 条
    let all: Vec<SessionMessage> = (0..2000u64)
        .map(|i| sample_message(&format!("m{i}"), if i % 2 == 0 { "user" } else { "assistant" }, i as i64))
        .collect();
    let started = Instant::now();
    db.save_session_body("s1", &all).expect("全量保存");
    let full_save = started.elapsed();
    assert_eq!(db.load_session_body("s1").expect("读回").len(), 2000, "全量保存后行数准确");

    // 增量追加 500 条（P6 优化路径）
    let inc: Vec<SessionMessage> = (2000..2500u64)
        .map(|i| sample_message(&format!("m{i}"), if i % 2 == 0 { "user" } else { "assistant" }, i as i64))
        .collect();
    let started = Instant::now();
    db.append_session_messages("s1", &inc).expect("增量追加");
    let inc_append = started.elapsed();
    assert_eq!(db.load_session_body("s1").expect("读回").len(), 2500, "增量追加后行数准确");

    // 再次全量保存（写放大：重写全部现有行）
    let started = Instant::now();
    db.save_session_body("s1", &all).expect("再次全量保存");
    let full_rewrite = started.elapsed();
    assert_eq!(db.load_session_body("s1").expect("读回").len(), 2000, "再次全量保存后行数准确");

    println!(
        "[stress] 写放大报告（报告模式，无耗时断言）：全量保存 2000 条={full_save:?}，增量追加 500 条={inc_append:?}，再次全量重写 2500 条={full_rewrite:?}"
    );
}
