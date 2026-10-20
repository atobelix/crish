//! StoreNoteBackend 集成 / 契约测试入口（**SD-39** 按域拆）
//!
//! 由 `store_backend` 经 `#[path]` 接入（无孤儿）。子域：
//! - [`apply_md`]：apply_md / query / outline / W4-A lossy / factory / batch_token
//! - [`batch`]：W4-F `w4f_*` / insert / move / update / delete / dry_run
//! - [`hydrate`]：`hydrate_document_*` 冷热路径
//!
//! **B1-1 / B3 观测面**（2026-08-13-wave 轮 4 单元 B1-1+B3）：
//! - 毒化测（每文件 ≥1，三要素：正常返回 + LogCapture error 日志 + 计数 +N）
//! - B3 per-doc 分片锁并发断言（不同 doc 不串行 / 同 doc 串行 / 锁表有界 /
//!   双线程并发首开）
//!
//! **≠ EL-05**；**≠ A-AGT 满表**；**≠ W6-E**；测绿不抬关。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_db() -> (std::path::PathBuf, std::path::PathBuf) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "conex-note-rt-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        n
    ));
    std::fs::create_dir_all(&dir).expect("创建测试临时目录失败");
    let db = dir.join("workspace.db");
    (dir, db)
}

/// 测试临时目录清理：目录可能已被被测逻辑删除（`NotFound` 属预期）；
/// Windows 上 SQLite 句柄释放晚于 Drop 存在毫秒级延迟，`remove_dir_all` 可能报
/// os error 32（占用中）——重试三轮递增退避后仍失败则告警并放行：泄漏一个
/// %TEMP% 目录属环境噪声，不应升级为断言失败（不静默：eprintln 可见）。
fn cleanup(dir: std::path::PathBuf) {
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..3u32 {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => return,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(50u64 * (attempt as u64 + 1)));
            }
        }
    }
    if let Some(e) = last_err {
        eprintln!(
            "[store_backend_tests::cleanup] 测试临时目录重试后仍被占用，跳过删除（{}）：{e}",
            dir.display()
        );
    }
}

#[path = "store_backend_tests_apply_md.rs"]
mod apply_md;

#[path = "store_backend_tests_batch.rs"]
mod batch;

#[path = "store_backend_tests_hydrate.rs"]
mod hydrate;

// ── B1-1 毒化测观测面（LogCapture + with_capture 同形复制，对齐
//    crates/session-loop/tests/observability.rs：15-61；B1-3 note_memory 样板；
//    tracing-subscriber 为 workspace 既有依赖，仅 dev 面启用）────────

mod capture {
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    /// 捕获日志的内存缓冲（fmt writer 共享同一缓冲）
    #[derive(Default)]
    pub struct LogCapture {
        lines: Mutex<Vec<String>>,
    }

    impl LogCapture {
        fn push(&self, line: &str) {
            self.lines.lock().unwrap().push(line.to_string());
        }
        fn snapshot(&self) -> Vec<String> {
            self.lines.lock().unwrap().clone()
        }
    }

    /// fmt writer：Arc 包装共享缓冲
    struct ArcWriter(Arc<LogCapture>);

    impl Write for ArcWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            // fmt 会以行调用；按行切分逐行记录
            let text = String::from_utf8_lossy(buf);
            for line in text.lines() {
                self.0.push(line);
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// 在捕获 subscriber 下执行闭包，返回捕获行（毒化测仅断言 error 级）
    pub fn with_capture<F, R>(f: F) -> (R, Vec<String>)
    where
        F: FnOnce() -> R,
    {
        let capture = Arc::new(LogCapture::default());
        let writer = capture.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(move || ArcWriter(writer.clone()))
            .with_max_level(tracing::Level::ERROR)
            .with_ansi(false)
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        let result = f();
        let lines = capture.snapshot();
        (result, lines)
    }
}

use capture::with_capture;

/// 毒化测串行锁：crate 级聚合计数器在并行测试下会污染 before/after
/// 断言；仅测试面串行，不影响生产路径。
static POISON_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 取毒化测串行守卫（测试面自恢复：本锁若被毒化直接取回，不级联失败）。
fn poison_test_guard() -> std::sync::MutexGuard<'static, ()> {
    POISON_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 同步执行 async 闭包（毒化测 / 并发测用：fresh current_thread runtime，
/// 对齐 explore_quota 双线程模式；store async 壳均为零 await 纯同步体）。
fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime")
        .block_on(f)
}

/// 毒化 std `Mutex`（B1-1 测试注入，对齐 agent-tools `test_support::poison_std_lock`）：
/// 在持锁线程内 panic，使锁进入中毒状态（PoisonError），验证恢复式处理不 panic。
fn poison_std_lock<T: std::marker::Send>(lock: &std::sync::Mutex<T>) {
    let panicked = std::panic::catch_unwind(|| {
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let _guard = lock.lock().unwrap();
                panic!("模拟持锁 panic（毒化锁）");
            });
        });
    });
    assert!(
        panicked.is_err(),
        "毒化注入必须真的 panic；否则锁未被毒化，恢复路径用例失去意义"
    );
}

use crate::StoreNoteBackend;
use agent_tools::note_backend::{
    NoteApplyMdRequest, NoteApplyMode, NoteBackend, NoteQueryBlocksParams,
};
use std::sync::Arc;

/// 种子写入（默认 User origin，无 intent / batch）。
fn apply_md(backend: &StoreNoteBackend, doc_id: &str, markdown: &str) {
    block_on(backend.apply_md_fragment(NoteApplyMdRequest {
        doc_id: doc_id.into(),
        markdown: markdown.into(),
        parent_id: None,
        after_block_id: None,
        mode: NoteApplyMode::ApplyMdFragment,
        intent_id: None,
        batch_id: None,
        message_id: None,
        origin: Some("user".into()),
    }))
    .expect("apply_md");
}

// ── B1-1 毒化测（每文件 ≥1；三要素：正常返回 + 日志 + 计数）────────

/// store_backend.rs（:179 outline 读路径）：sessions 索引锁毒化 →
/// document_outline 正常返回 + error 日志 + 计数 +1。
#[test]
fn poisoned_sessions_map_outline_recovers_with_log_and_count() {
    let _serial = poison_test_guard();
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();
    apply_md(&backend, "poison-outline", "# Poison Outline\n\nbody");
    let before = crate::poison::poison_recovery_count();
    poison_std_lock(&backend.sessions);
    let (res, lines) =
        with_capture(|| block_on(backend.document_outline("poison-outline", Some(6))));
    let outline = res.expect("毒化后 outline 仍正常返回");
    assert!(
        !outline.outline.is_empty(),
        "session 树大纲应可读: {:?}",
        outline
    );
    assert!(
        lines.iter().any(|l| l.contains("锁中毒")),
        "缺少锁中毒 error 日志，捕获：\n{}",
        lines.join("\n")
    );
    assert_eq!(
        crate::poison::poison_recovery_count(),
        before + 1,
        "sessions 索引锁恢复必须计数 +1"
    );
    cleanup(dir);
}

/// store_backend_apply.rs（:61 写路径）：per-doc 锁毒化 →
/// apply_collab_ops_json 正常返回（写仍落地）+ 日志 + 计数 +1。
#[test]
fn poisoned_per_doc_lock_apply_collab_recovers_with_log_and_count() {
    let _serial = poison_test_guard();
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();
    apply_md(&backend, "poison-collab", "seed body");
    let arc = backend
        .sessions
        .lock()
        .unwrap()
        .get("poison-collab")
        .unwrap()
        .clone();
    let before = crate::poison::poison_recovery_count();
    poison_std_lock(&arc);
    let ops_json = r#"[{"op":"insert","id":"22222222-2222-4222-a222-222222222222","parent":null,"order":"a0","kind":"paragraph","props":{"attrs":{}}}]"#;
    let (res, lines) =
        with_capture(|| backend.apply_collab_ops_json("poison-collab", ops_json, Some("user")));
    let out = res.expect("毒化后 apply_collab_ops_json 仍正常返回");
    assert_eq!(out.applied, 1, "恢复式继续后写仍落地");
    assert!(
        lines.iter().any(|l| l.contains("锁中毒")),
        "缺少锁中毒 error 日志，捕获：\n{}",
        lines.join("\n")
    );
    assert_eq!(
        crate::poison::poison_recovery_count(),
        before + 1,
        "per-doc 锁恢复必须计数 +1"
    );
    let q = block_on(backend.query_blocks(NoteQueryBlocksParams {
        doc_id: "poison-collab".into(),
        text_match: None,
        ..Default::default()
    }))
    .expect("query");
    assert!(!q.blocks.is_empty(), "毒化后写仍应落投影");
    cleanup(dir);
}

/// store_backend_query.rs（:36/:37 读路径）：per-doc 锁毒化 →
/// document_to_md 正常返回 + 日志 + 计数 +1。
#[test]
fn poisoned_doc_lock_document_to_md_recovers_with_log_and_count() {
    let _serial = poison_test_guard();
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();
    apply_md(&backend, "poison-md", "# Poison Md\n\nquery body");
    let arc = backend
        .sessions
        .lock()
        .unwrap()
        .get("poison-md")
        .unwrap()
        .clone();
    let before = crate::poison::poison_recovery_count();
    poison_std_lock(&arc);
    let (res, lines) = with_capture(|| backend.document_to_md("poison-md"));
    let md = res.expect("毒化后 document_to_md 仍正常返回");
    assert!(md.contains("Poison Md"), "即时 S 内容可读: {md:?}");
    assert!(
        lines.iter().any(|l| l.contains("锁中毒")),
        "缺少锁中毒 error 日志，捕获：\n{}",
        lines.join("\n")
    );
    assert_eq!(
        crate::poison::poison_recovery_count(),
        before + 1,
        "per-doc 锁恢复必须计数 +1"
    );
    cleanup(dir);
}

/// store_hydrate.rs（session_handle 索引锁）：map 锁毒化 →
/// hydrate_document_from_session 正常返回 + 日志 + 计数 +1。
#[test]
fn poisoned_sessions_map_hydrate_recovers_with_log_and_count() {
    let _serial = poison_test_guard();
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();
    apply_md(&backend, "poison-hyd", "# Poison Hydrate\n\nbody");
    let before = crate::poison::poison_recovery_count();
    poison_std_lock(&backend.sessions);
    let (res, lines) = with_capture(|| backend.hydrate_document_from_session("poison-hyd", 50));
    let proj = res.expect("毒化后 hydrate 投影仍正常返回");
    assert!(!proj.blocks.is_empty(), "投影应可读: {:?}", proj);
    assert!(
        lines.iter().any(|l| l.contains("锁中毒")),
        "缺少锁中毒 error 日志，捕获：\n{}",
        lines.join("\n")
    );
    assert_eq!(
        crate::poison::poison_recovery_count(),
        before + 1,
        "sessions 索引锁恢复必须计数 +1"
    );
    cleanup(dir);
}

/// store_apply_md.rs（:112 写路径）：per-doc 锁毒化 →
/// apply_md_fragment 正常返回（写仍落地）+ 日志 + 计数 +1。
#[test]
fn poisoned_doc_lock_apply_md_recovers_with_log_and_count() {
    let _serial = poison_test_guard();
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();
    apply_md(&backend, "poison-applymd", "seed");
    let arc = backend
        .sessions
        .lock()
        .unwrap()
        .get("poison-applymd")
        .unwrap()
        .clone();
    let before = crate::poison::poison_recovery_count();
    poison_std_lock(&arc);
    let (res, lines) = with_capture(|| {
        block_on(backend.apply_md_fragment(NoteApplyMdRequest {
            doc_id: "poison-applymd".into(),
            markdown: "## Appended\n\nmore body".into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: None,
            batch_id: None,
            message_id: None,
            origin: Some("user".into()),
        }))
    });
    let r = res.expect("毒化后 apply_md 仍正常返回");
    assert!(r.inserted >= 1, "恢复式继续后写仍落地: {:?}", r);
    assert!(
        lines.iter().any(|l| l.contains("锁中毒")),
        "缺少锁中毒 error 日志，捕获：\n{}",
        lines.join("\n")
    );
    assert_eq!(
        crate::poison::poison_recovery_count(),
        before + 1,
        "per-doc 锁恢复必须计数 +1"
    );
    cleanup(dir);
}

/// store_apply_md.rs（intents :99 幂等检查 + :232 结果回写）：intents 锁毒化 →
/// 一次调用两处各恢复一次（计数 +2）+ 日志 + 幂等语义仍成立（二次调用命中缓存）。
#[test]
fn poisoned_intents_lock_apply_md_recovers_with_log_and_count() {
    let _serial = poison_test_guard();
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();
    apply_md(&backend, "poison-intents", "seed body");
    let before = crate::poison::poison_recovery_count();
    poison_std_lock(&backend.intents);
    let (res, lines) = with_capture(|| {
        block_on(backend.apply_md_fragment(NoteApplyMdRequest {
            doc_id: "poison-intents".into(),
            markdown: "# Intent Writes\n\nmore".into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: Some("intent-poison-1".into()),
            batch_id: None,
            message_id: None,
            origin: Some("user".into()),
        }))
    });
    let r = res.expect("毒化后 intent 写仍正常返回");
    assert!(
        !r.idempotent && r.inserted >= 1,
        "首次写不幂等且落块: {:?}",
        r
    );
    assert!(
        lines.iter().any(|l| l.contains("锁中毒")),
        "缺少锁中毒 error 日志，捕获：\n{}",
        lines.join("\n")
    );
    assert_eq!(
        crate::poison::poison_recovery_count(),
        before + 2,
        "intents 幂等检查（:99）与结果回写（:232）两处锁各恢复一次"
    );
    // 幂等语义不因毒化而丢：二次调用命中首次结果缓存
    let second = block_on(backend.apply_md_fragment(NoteApplyMdRequest {
        doc_id: "poison-intents".into(),
        markdown: "# Intent Writes\n\nmore".into(),
        parent_id: None,
        after_block_id: None,
        mode: NoteApplyMode::ApplyMdFragment,
        intent_id: Some("intent-poison-1".into()),
        batch_id: None,
        message_id: None,
        origin: Some("user".into()),
    }))
    .expect("幂等二次调用");
    assert!(second.idempotent && second.inserted == 0);
    cleanup(dir);
}

// ── B3 per-doc 分片锁断言（内存面重叠为准；conn 单连接串行为诚实边界）─

/// 不同 doc 并发写不串行：持住 doc-a 的 per-doc 锁期间，doc-b 写必须完成。
/// （若退化为全表单锁，doc-b 会被同一把锁阻塞 → 超时红。）
#[test]
fn per_doc_lock_allows_concurrent_writes_to_different_docs() {
    let (dir, db) = temp_db();
    let backend = Arc::new(StoreNoteBackend::open(&db).unwrap());
    // 先打开两 doc（首开 ensure 不在断言面内）
    apply_md(&backend, "b3-a", "# A seed");
    apply_md(&backend, "b3-b", "# B seed");
    // 持住 doc-a 的 per-doc 锁（测试线程）
    let arc_a = backend
        .sessions
        .lock()
        .unwrap()
        .get("b3-a")
        .unwrap()
        .clone();
    let _held_a = arc_a.lock().unwrap();
    // 新 OS 线程驱动写 doc-b（真实并发，对齐 explore_quota 双线程模式）
    let backend2 = Arc::clone(&backend);
    let (tx, rx) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || {
        let r = block_on(backend2.apply_md_fragment(NoteApplyMdRequest {
            doc_id: "b3-b".into(),
            markdown: "## B Concurrent\n\nconcurrent body".into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: None,
            batch_id: None,
            message_id: None,
            origin: Some("user".into()),
        }));
        tx.send(r).expect("send 写结果");
    });
    let r = rx
        .recv_timeout(std::time::Duration::from_secs(15))
        .expect("doc-b 写必须在 doc-a per-doc 锁被持有时完成（per-doc 锁不串行不同 doc）");
    r.expect("doc-b 并发写成功");
    drop(_held_a);
    writer.join().expect("写线程不应 panic");
    // 内存面断言：doc-b 内容即时可读（get_md 走 session 树）
    let md = block_on(backend.get_md("b3-b")).expect("doc-b md");
    assert!(
        md.contains("concurrent body") || md.contains("B Concurrent"),
        "doc-b 写已落 session 树: {md:?}"
    );
    cleanup(dir);
}

/// 同 doc 写仍串行（单写者不变）：持锁期间同 doc 写被阻塞，释放后完成。
#[test]
fn same_doc_writes_stay_serialized_under_per_doc_lock() {
    let (dir, db) = temp_db();
    let backend = Arc::new(StoreNoteBackend::open(&db).unwrap());
    apply_md(&backend, "b3-same", "# Same seed");
    let arc = backend
        .sessions
        .lock()
        .unwrap()
        .get("b3-same")
        .unwrap()
        .clone();
    let _held = arc.lock().unwrap();
    let backend2 = Arc::clone(&backend);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (tx, rx) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || {
        ready_tx.send(()).expect("ready");
        let r = block_on(backend2.apply_md_fragment(NoteApplyMdRequest {
            doc_id: "b3-same".into(),
            markdown: "## Same Doc Write\n\nbody".into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: None,
            batch_id: None,
            message_id: None,
            origin: Some("user".into()),
        }));
        tx.send(r).expect("send 写结果");
    });
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("写线程已就绪");
    assert!(
        rx.recv_timeout(std::time::Duration::from_millis(300))
            .is_err(),
        "同 doc 写必须被 per-doc 锁串行（持锁期间不得完成）"
    );
    drop(_held);
    let r = rx
        .recv_timeout(std::time::Duration::from_secs(15))
        .expect("释放 per-doc 锁后同 doc 写完成");
    r.expect("同 doc 写成功");
    writer.join().expect("写线程不应 panic");
    cleanup(dir);
}

/// 锁表有界：per-doc 锁条目数 == sessions 索引条目数，不随调用次数增长；
/// 冷开摘除后条目回落。
#[test]
fn per_doc_lock_table_bounded_by_open_docs() {
    let (dir, db) = temp_db();
    let backend = StoreNoteBackend::open(&db).unwrap();
    // 同 doc 反复写：锁条目不因调用次数增长（上界 = 打开的 doc 数）
    for i in 0..5 {
        apply_md(&backend, "bounded-a", &format!("# A{i}\n\nbody{i}"));
    }
    for i in 0..3 {
        apply_md(&backend, "bounded-b", &format!("# B{i}\n\nbody{i}"));
    }
    let n = backend.sessions.lock().unwrap().len();
    assert_eq!(
        n, 2,
        "per-doc 锁条目数 == sessions 索引条目数（2 doc），不随调用次数增长，got {n}"
    );
    // remove 路径：直接摘除（不经冷开重插）→ 条目回落
    backend.remove_session_for_cold("bounded-b");
    assert_eq!(backend.sessions.lock().unwrap().len(), 1, "摘除后锁表回落");
    // 冷开 = 摘除 + 重开：同 doc 不产生重复锁条目（仍 1，无泄漏）
    backend
        .hydrate_document_cold("bounded-a", 10)
        .expect("cold hydrate");
    assert_eq!(
        backend.sessions.lock().unwrap().len(),
        1,
        "冷开重开后同 doc 无重复条目（无泄漏）"
    );
    cleanup(dir);
}

/// 双 OS 线程并发首开**不同** doc（barrier 式同时启动）：双写均成功、
/// 锁表恰 2 条目、两 doc 内容均可读（无丢失）。
#[test]
fn concurrent_first_open_distinct_docs_lands_two_sessions() {
    let (dir, db) = temp_db();
    let backend = Arc::new(StoreNoteBackend::open(&db).unwrap());
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut handles = Vec::new();
    for doc in ["cfo-a", "cfo-b"] {
        let backend = Arc::clone(&backend);
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            block_on(backend.apply_md_fragment(NoteApplyMdRequest {
                doc_id: doc.into(),
                markdown: format!("# {doc}\n\nfirst open body"),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: None,
                message_id: None,
                origin: Some("user".into()),
            }))
        }));
    }
    barrier.wait();
    for h in handles {
        h.join().expect("写线程不应 panic").expect("并发首开写成功");
    }
    assert_eq!(
        backend.sessions.lock().unwrap().len(),
        2,
        "并发首开两 doc → 锁表恰 2 条目"
    );
    for doc in ["cfo-a", "cfo-b"] {
        let md = block_on(backend.get_md(doc)).expect("读");
        assert!(md.contains(doc), "{doc} 内容可读（双写无丢失）: {md:?}");
    }
    cleanup(dir);
}

// ── B3 · CAS 冲突类型化（消费侧：store_backend.rs map_commit_err）────────
//
// CT-01 CAS 陈旧写经 on_committed_expect → PersistError::Conflict
// → ApplyError::PersistConflict → map_commit_err 类型匹配 →
// NoteBackendError::Conflict（note.persist_conflict），不依赖 Display 文案。

/// B3：`CommitPipelineError::Apply(ApplyError::PersistConflict)` 经
/// [`map_commit_err`] 类型化分类为 [`NoteBackendError::Conflict`]，
/// 不再依赖 `to_string().contains("conflict")` 字符串匹配。
#[test]
fn map_commit_err_types_persist_conflict_to_note_conflict() {
    use agent_tools::note_backend::NoteBackendError;
    use conex_doc_collab::ApplyError;
    use conex_workspace_store::CommitPipelineError;

    let expected_rev = 7u64;
    let err = CommitPipelineError::Apply(ApplyError::PersistConflict {
        expected: expected_rev,
    });
    let mapped = crate::store_backend::map_commit_err(err);
    assert!(
        matches!(mapped, NoteBackendError::Conflict(_)),
        "PersistConflict 应类型化分类为 NoteBackendError::Conflict，得到 {mapped:?}"
    );
    // 稳定码：note.persist_conflict
    assert_eq!(mapped.code(), "note.persist_conflict");
    // 消息含期望 rev（类型化文案，不依赖原 PersistError Display）
    assert!(
        mapped.message().contains(&expected_rev.to_string()),
        "消息应含期望 rev {expected_rev}，得到 {}",
        mapped.message()
    );
}

/// B3 负例：非 CAS 冲突的 ApplyError 变体（如 Persist/NotFound/Schema）
/// 仍走既有字符串分类路径，不被误判为 Conflict。
#[test]
fn map_commit_err_keeps_non_conflict_apply_variants_unaffected() {
    use agent_tools::note_backend::NoteBackendError;
    use conex_doc_collab::ApplyError;
    use conex_workspace_store::CommitPipelineError;

    // NotFound 变体 → 仍走 contains("not found") 分类为 NotFound
    let err = CommitPipelineError::Apply(ApplyError::NotFound("block x".into()));
    let mapped = crate::store_backend::map_commit_err(err);
    assert!(
        matches!(mapped, NoteBackendError::NotFound(_)),
        "ApplyError::NotFound 应分类为 NoteBackendError::NotFound，得到 {mapped:?}"
    );

    // 普通 Persist（非 CAS 冲突）→ ApplyFailed，不被误判为 Conflict
    let err = CommitPipelineError::Apply(ApplyError::Persist("io: disk full".into()));
    let mapped = crate::store_backend::map_commit_err(err);
    assert!(
        matches!(mapped, NoteBackendError::ApplyFailed(_)),
        "ApplyError::Persist(非冲突) 应分类为 ApplyFailed，得到 {mapped:?}"
    );
}

// ── S3 性能热点埋点观测测（LogCapture WARN 级，对齐 observability.rs）─
//
// 覆盖：② 长锁等待（获取点计时 + 超阈值条件告警「锁等待慢于阈值」）、
// ①-全文 序列化（document_to_md 全树转 MD 耗时 + 超阈值告警「全文序列化
// 慢于阈值」）。探针 [crate::store_backend::SlowPathProbe] 为 pub(crate)，
// 测试可直驱阈值门控（确定性）；锁等待另有真实争抢集成测（channel 同步
// 持锁 30ms → document_to_md 等待 → 告警捕获）。

/// S3 告警测串行锁：与 B1-1 毒化测共享 capture 无冲突（各自线程隔离），
/// 但本组测试与既有 with_capture 均为线程局部默认订阅者，互不串扰。
mod s3_slow_path_tests {
    use super::*;
    use crate::store_backend::{SlowPathProbe, SLOW_FULLTEXT_SERIALIZE_WARN_MS};
    use std::io::Write;
    use std::sync::mpsc;

    /// 捕获日志的内存缓冲（fmt writer 共享同一缓冲；WARN 级）
    #[derive(Default)]
    struct LogCapture {
        lines: std::sync::Mutex<Vec<String>>,
    }

    impl LogCapture {
        fn push(&self, line: &str) {
            self.lines.lock().unwrap().push(line.to_string());
        }
        fn snapshot(&self) -> Vec<String> {
            self.lines.lock().unwrap().clone()
        }
    }

    /// fmt writer：Arc 包装共享缓冲
    struct ArcWriter(Arc<LogCapture>);

    impl Write for ArcWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let text = String::from_utf8_lossy(buf);
            for line in text.lines() {
                self.0.push(line);
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// 在捕获 subscriber 下执行闭包，返回捕获行（WARN 级——S3 告警为
    /// warn 级；B1 毒化测的 ERROR 级捕获器会漏掉它）
    pub fn with_capture_warn<F, R>(f: F) -> (R, Vec<String>)
    where
        F: FnOnce() -> R,
    {
        let capture = Arc::new(LogCapture::default());
        let writer = capture.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(move || ArcWriter(writer.clone()))
            .with_max_level(tracing::Level::WARN)
            .with_ansi(false)
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        let result = f();
        let lines = capture.snapshot();
        (result, lines)
    }

    /// ② 长锁等待（真实争抢集成测）：另起线程持 per-doc 锁 30ms（channel
    /// 同步确保持锁在先），主线程 document_to_md 等待 > 10ms 阈值 →
    /// warn「锁等待慢于阈值」被捕获；返回结果不受埋点影响。
    #[test]
    fn slow_lock_wait_warns_over_threshold() {
        let (dir, db) = temp_db();
        let backend = StoreNoteBackend::open(&db).unwrap();
        apply_md(&backend, "slow-lock", "# Slow Lock\n\nbody");
        let arc = backend
            .sessions
            .lock()
            .unwrap()
            .get("slow-lock")
            .unwrap()
            .clone();
        let (tx, rx) = mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _guard = arc.lock().unwrap();
            tx.send(()).expect("持锁线程向同步 channel 发送失败");
            std::thread::sleep(std::time::Duration::from_millis(30));
        });
        rx.recv().expect("持锁线程已拿到锁（channel 同步）");
        let (res, lines) = with_capture_warn(|| backend.document_to_md("slow-lock"));
        let md = res.expect("等待后 document_to_md 正常返回");
        assert!(md.contains("Slow Lock"), "读路径不受埋点影响: {md:?}");
        assert!(
            lines.iter().any(|l| l.contains("锁等待慢于阈值")),
            "锁等待超阈值必须告警，捕获：\n{}",
            lines.join("\n")
        );
        holder.join().expect("持锁线程不应 panic");
        cleanup(dir);
    }

    /// ② 长锁等待负例：无争抢常态调用 → 零告警（条件告警门控可证伪）。
    #[test]
    fn fast_lock_wait_stays_silent() {
        let (dir, db) = temp_db();
        let backend = StoreNoteBackend::open(&db).unwrap();
        apply_md(&backend, "fast-lock", "# Fast Lock\n\nbody");
        let (res, lines) = with_capture_warn(|| backend.document_to_md("fast-lock"));
        assert!(res.is_ok(), "常态读正常");
        assert!(
            !lines.iter().any(|l| l.contains("锁等待慢于阈值")),
            "常态零告警，捕获：\n{}",
            lines.join("\n")
        );
        cleanup(dir);
    }

    /// ①-全文 序列化（探针级阈值门控正例）：直驱 SlowPathProbe 注入
    /// 超阈值序列化耗时（≥ SLOW_FULLTEXT_SERIALIZE_WARN_MS=100ms）→
    /// 析构时 warn「全文序列化慢于阈值」被捕获（确定性，不依赖机器速度）。
    #[test]
    fn slow_fulltext_serialize_warns_over_threshold() {
        let (_, lines) = with_capture_warn(|| {
            let mut probe = SlowPathProbe::start("doc-slow-md");
            probe.record_serialize(std::time::Duration::from_millis(
                SLOW_FULLTEXT_SERIALIZE_WARN_MS + 50,
            ));
            drop(probe);
        });
        assert!(
            lines.iter().any(|l| l.contains("全文序列化慢于阈值")),
            "超阈值序列化必须告警，捕获：\n{}",
            lines.join("\n")
        );
    }

    /// ①-全文 序列化负例：低于阈值 → 零告警（条件告警门控可证伪）。
    #[test]
    fn fast_fulltext_serialize_stays_silent() {
        let (_, lines) = with_capture_warn(|| {
            let mut probe = SlowPathProbe::start("doc-fast-md");
            probe.record_serialize(std::time::Duration::from_micros(800));
            drop(probe);
        });
        assert!(
            !lines.iter().any(|l| l.contains("全文序列化慢于阈值")),
            "常态零告警，捕获：\n{}",
            lines.join("\n")
        );
    }
}
