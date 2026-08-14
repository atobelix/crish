//! `mirror_os_watch` 单元测（**SD-19** 外置；语义与拆前一致）。
//!
//! 由父模 [`crate::mirror_os_watch`] 经 `#[path]` 接入。
//! **≠ EL-03**；**≠ inotify 产品满关**；poll 并存但 **≠** 默认双开。

use super::path::paths_equal_for_mirror;
use super::*;
use crate::mirror::{MirrorDriftClass, MirrorWatchHandle};
use crate::{InFlightSuppressVerdict, WorkspaceStore};
use conex_doc_collab::{BlockId, BlockKind, BlockNode, BlockProps, BlockTree};
use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_dir() -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let p = std::env::temp_dir().join(format!(
        "conex-mirror-os-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        n
    ));
    let _ = std::fs::create_dir_all(&p);
    p
}

fn sample_tree(text: &str) -> BlockTree {
    let id = BlockId::from_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
    let mut nodes = HashMap::new();
    nodes.insert(
        id,
        BlockNode {
            id,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
            children: vec![],
            text_snapshot: Some(text.into()),
        },
    );
    BlockTree {
        root_children: vec![id],
        nodes,
    }
}

/// Fake 事件源可注入；命中 path 后 detect → MirrorOnly。
///
/// **≠ OS inotify 生产满关**（本测不绑内核）；**≠ EL-03**；**≠ A-INV-02 UI**。
#[test]
fn fake_os_source_drives_detect_mirror_only() {
    let dir = temp_dir();
    let db = dir.join("workspace.db");
    let mirror_root = dir.join("mirrors");
    let store = WorkspaceStore::open(&db).unwrap();
    let tree = sample_tree("os fake hello");
    store
        .export_md_mirror("doc-fake-os", &tree, 1, &mirror_root)
        .unwrap();

    let report0 = store.detect_mirror_drift("doc-fake-os", 1).unwrap();
    assert_eq!(report0.class, MirrorDriftClass::None);
    let path = report0.path.clone();

    // 外部改盘
    let mut content = std::fs::read_to_string(&path).unwrap();
    content.push_str("\n\nfake os edit\n");
    std::fs::write(&path, content.as_bytes()).unwrap();

    let mut fake = FakeMirrorOsEventSource::new();
    fake.push_modified(&path);

    let ev = fake.try_recv_event().expect("fake 须弹出事件");
    assert_eq!(ev.kind, MirrorOsEventKind::Modified);

    let hit = detect_if_os_event_hits_mirror(&store, "doc-fake-os", 1, &ev)
        .unwrap()
        .expect("路径须命中");
    assert_eq!(
        hit.class,
        MirrorDriftClass::MirrorOnly,
        "OS hint + detect 须 MirrorOnly，got {:?}",
        hit.class
    );

    // 无关路径 → None
    let miss_ev = MirrorOsEvent {
        path: dir.join("other.md"),
        kind: MirrorOsEventKind::Modified,
    };
    let miss = detect_if_os_event_hits_mirror(&store, "doc-fake-os", 1, &miss_ev).unwrap();
    assert!(miss.is_none(), "无关路径不得误命中");

    let _ = std::fs::remove_dir_all(&dir);
}

/// **真 OS 事件**：改 mirror 文件 → notify 通道收到路径事件 → detect MirrorOnly。
///
/// 可证伪：若 watcher 未订 FS 事件 / 过滤丢光，本测超时失败。
///
/// **诚实钉死**：
/// - 本测证明 **OS 事件入口可工作**，**≠** A-INV-02 产品 UI 满关
/// - **≠** EL-03
/// - **≠**「poll API = inotify 满关」——本测走的是 [`MirrorOsWatcher`]，不是 poll 冒充
/// - **≠** 默认双开 poll+OS——本测按需组合 hint→poll，不自动双开
/// - poll 子集仍独立存在且不回退
#[test]
fn os_watcher_emits_event_on_mirror_file_write() {
    let dir = temp_dir();
    let db = dir.join("workspace.db");
    let mirror_root = dir.join("mirrors");
    let _ = std::fs::create_dir_all(&mirror_root);
    let store = WorkspaceStore::open(&db).unwrap();
    let tree = sample_tree("os real hello");
    store
        .export_md_mirror("doc-os-real", &tree, 1, &mirror_root)
        .unwrap();

    let report0 = store.detect_mirror_drift("doc-os-real", 1).unwrap();
    assert_eq!(report0.class, MirrorDriftClass::None);
    let path = report0.path.clone();
    assert!(path.is_file(), "export 后 mirror 文件须存在");

    // 启动 OS watcher（父目录 + interest 过滤）
    let watcher = MirrorOsWatcher::watch_mirror_file(&path)
        .expect("OS watcher 须能注册（notify）");
    assert!(
        !watcher.watched_dirs().is_empty(),
        "须注册至少一个父目录"
    );
    // 清启动噪声
    let _ = watcher.drain();
    // 部分平台 watch 注册后需极短稳定窗口
    std::thread::sleep(Duration::from_millis(50));

    // 外部改盘（触发 OS 事件）
    let mut content = std::fs::read_to_string(&path).unwrap();
    content.push_str("\n\nreal os edit via notify\n");
    std::fs::write(&path, content.as_bytes()).unwrap();

    // 等待至少一条命中本文件的事件（Windows RDCW / 其它后端可能多条）
    let deadline = Duration::from_secs(3);
    let start = std::time::Instant::now();
    let mut saw = None;
    while start.elapsed() < deadline {
        if let Some(ev) = watcher.recv_timeout(Duration::from_millis(200)) {
            if paths_equal_for_mirror(&ev.path, &path) {
                saw = Some(ev);
                break;
            }
        }
    }
    let ev = saw.unwrap_or_else(|| {
        panic!(
            "OS watcher 在 {deadline:?} 内未收到 mirror 文件事件（path={}）。\
             这证明 OS 订阅未工作——不得用 poll 冒充本测通过。",
            path.display()
        )
    });
    assert!(
        matches!(
            ev.kind,
            MirrorOsEventKind::Modified
                | MirrorOsEventKind::Created
                | MirrorOsEventKind::RescanHint
        ),
        "写文件后期望 Modified/Created/RescanHint，got {:?}",
        ev.kind
    );

    // OS hint → detect
    let hit = detect_if_os_event_hits_mirror(&store, "doc-os-real", 1, &ev)
        .unwrap()
        .expect("OS 事件路径须命中 mirror");
    assert_eq!(
        hit.class,
        MirrorDriftClass::MirrorOnly,
        "外部 OS 改盘须 MirrorOnly，got {:?}",
        hit.class
    );

    // 组合：OS hint → poll 指纹（既有 poll 不回退；显式组合 ≠ 默认双开）
    let mut handle = MirrorWatchHandle::new("doc-os-real");
    // 先建基线（当前已改盘状态）
    let _ = handle.poll_mirror_once(&store, 1).unwrap();
    // 再改一次 + OS 事件
    let mut c2 = std::fs::read_to_string(&path).unwrap();
    c2.push_str("second\n");
    std::fs::write(&path, c2.as_bytes()).unwrap();
    let mut ev2 = None;
    let start2 = std::time::Instant::now();
    while start2.elapsed() < deadline {
        if let Some(ev) = watcher.recv_timeout(Duration::from_millis(200)) {
            if paths_equal_for_mirror(&ev.path, &path) {
                ev2 = Some(ev);
                break;
            }
        }
    }
    let ev2 = ev2.expect("第二次改盘也须有 OS 事件");
    let polled = poll_on_os_hint(&mut handle, &store, 1, &ev2)
        .unwrap()
        .expect("poll_on_os_hint 须命中");
    assert!(
        polled.fingerprint_changed || polled.is_change_event() || !polled.first_poll,
        "OS+poll 组合须反映变更"
    );
    assert_eq!(polled.report.class, MirrorDriftClass::MirrorOnly);

    let _ = std::fs::remove_dir_all(&dir);
}

/// 诚实边界：模块公开面存在 OS API，且 **不** 把 poll 标成 inotify 满关 / **不** 写 EL 关闭叙事。
///
/// 可证伪：若误删 `MirrorOsWatcher` 或把 poll 标成 inotify 满关，本测/文档双钉。
#[test]
fn mirror_os_watcher_api_is_not_poll_and_not_el03() {
    // 编译期存在性：OS 类型与 poll 类型并存
    let _ = std::any::type_name::<MirrorOsWatcher>();
    let _ = std::any::type_name::<crate::MirrorWatchHandle>();
    let _ = std::any::type_name::<crate::MirrorWatcher>();

    // 文档契约（源码字符串钉死，防叙事回退）
    let src = include_str!("mirror_os_watch.rs");
    assert!(
        src.contains("SD-19"),
        "头注释须钉 SD-19"
    );
    assert!(
        src.contains("≠ EL-03") || src.contains("**≠ EL-03**"),
        "头注释须显式 ≠ EL-03"
    );
    assert!(
        src.contains("poll") && (src.contains("inotify") || src.contains("满关")),
        "头注释须区分 poll 与 OS/inotify，禁止 poll=满关叙事"
    );
    assert!(
        src.contains("notify"),
        "须点名 notify 作为 OS 后端"
    );
    // 须保留「poll 与 OS 并存 / 禁止 poll 冒充」纪律句
    assert!(
        src.contains("禁止") && src.contains("poll") && src.contains("inotify"),
        "须保留禁止 poll 冒充 inotify 的纪律表述"
    );
    assert!(
        src.contains("默认双开"),
        "头注释须钉 poll 并存但 ≠ 默认双开"
    );
}

/// 父目录不存在 → 明确错误（可证伪失败路径）。
#[test]
fn mirror_os_watch_missing_parent_errors() {
    let dir = temp_dir();
    let ghost = dir.join("no-such-dir").join("file.md");
    let err = match MirrorOsWatcher::watch_mirror_file(&ghost) {
        Err(e) => e,
        Ok(_) => panic!("父目录不存在时须返回错误，不得成功创建 watcher"),
    };
    match err {
        MirrorOsWatchError::InvalidPath(msg) => {
            assert!(
                msg.contains("父目录") || msg.contains("不存在"),
                "错误信息须指向父目录问题，got {msg}"
            );
        }
        other => panic!("期望 InvalidPath，got {other}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// 验证 InFlightExportGuard 与 detect 状态机联动：自发落盘事件 100% 压制
#[test]
fn in_flight_guard_suppresses_self_export_events() {
    let dir = temp_dir();
    let db = dir.join("workspace.db");
    let mirror_root = dir.join("mirrors");
    let store = WorkspaceStore::open(&db).unwrap();
    let tree = sample_tree("guard test content");

    let exported_path = store
        .export_md_mirror("doc-guard-test", &tree, 1, &mirror_root)
        .unwrap();

    // 刚落盘完成时，处于 InFlight 保护期（1000ms TTL 内）
    assert!(store.export_guard().is_in_flight(&exported_path));

    // detect_mirror_drift 判定无漂移
    let report = store.detect_mirror_drift("doc-guard-test", 1).unwrap();
    assert_eq!(
        report.class,
        MirrorDriftClass::None,
        "自发落盘后在途守卫必须压制自发事件"
    );
    assert!(!report.mirror_changed);

    // 模拟 OS Watcher 收到该文件的自发事件
    let ev = MirrorOsEvent {
        path: exported_path.clone(),
        kind: MirrorOsEventKind::Modified,
    };
    let hit = detect_if_os_event_hits_mirror(&store, "doc-guard-test", 1, &ev)
        .unwrap()
        .expect("自发事件仍命中对应 mirror path");
    assert_eq!(
        hit.class,
        MirrorDriftClass::None,
        "自发事件分类必须为 None"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// 验证 Windows 3 阶段原子写瞬态重命名缺失时的 SuppressTransientDeletion 机制
#[test]
fn in_flight_guard_suppresses_transient_deletion() {
    let dir = temp_dir();
    let db = dir.join("workspace.db");
    let mirror_root = dir.join("mirrors");
    let store = WorkspaceStore::open(&db).unwrap();
    let final_path = mirror_root.join("doc-transient.md");

    // 手动模拟写入初期（Writing 阶段）登记
    let _token = store.export_guard().register(&final_path, "expected_hash_val", 1);

    // 在 Writing 阶段且物理文件尚不存在（瞬态间隙）-> check_and_suppress 必须返回 SuppressTransientDeletion
    let verdict = store.export_guard().check_and_suppress(&final_path, None);
    assert_eq!(verdict, InFlightSuppressVerdict::SuppressTransientDeletion);
    assert!(verdict.is_suppressed());

    let _ = std::fs::remove_dir_all(&dir);
}

/// 验证多次导出落盘无 `.tmp` 或 `.bak` 残留
#[test]
fn export_md_mirror_leaves_no_transient_files() {
    let dir = temp_dir();
    let db = dir.join("workspace.db");
    let mirror_root = dir.join("mirrors");
    let store = WorkspaceStore::open(&db).unwrap();

    for i in 1..=5 {
        let tree = sample_tree(&format!("content version {i}"));
        store
            .export_md_mirror("doc-clean", &tree, i, &mirror_root)
            .unwrap();
    }

    // 检查目录中除最终 .md 文件外无任何 .tmp / .bak 残留
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&mirror_root).unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        files.push(name);
    }
    assert_eq!(files.len(), 1);
    assert_eq!(files[0], "doc-clean.md");

    let _ = std::fs::remove_dir_all(&dir);
}
