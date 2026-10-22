//! G03 T-EG-12：会话删除清理完整链路。

use super::*;

// ── G03 T-EG-12：会话删除清理完整链路 ──

/// 测试用临时目录（独立命名，drop 自动清理）
struct TempDir(std::path::PathBuf);

impl TempDir {
    fn new(prefix: &str) -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "conex_sess_del_{prefix}_{}_{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// delete_session_and_read_meta：删除前读产出 meta，删除后会话行消失
#[test]
fn delete_session_reads_output_meta_before_delete() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    let out_dir_key = crate::outputs_config::session_meta_key_of(
        "s1",
        crate::outputs_config::SESSION_META_KEY_OUTPUT_DIR,
    );
    let out_root_key = crate::outputs_config::session_meta_key_of(
        "s1",
        crate::outputs_config::SESSION_META_KEY_OUTPUT_ROOT,
    );
    db.set_session_meta(&out_dir_key, "/tmp/conex/x/2026-08-05-s1")
        .unwrap();
    db.set_session_meta(&out_root_key, ".agent-outputs")
        .unwrap();

    let (dir, root) = delete_session_and_read_meta(&db, "s1").unwrap();
    assert_eq!(dir.as_deref(), Some("/tmp/conex/x/2026-08-05-s1"));
    assert_eq!(root.as_deref(), Some(".agent-outputs"));
    assert!(db.list_sessions().unwrap().is_empty(), "会话行应已删除");
    // RUN-15：session_meta 无 FK 级联，库层 delete_session 已在删除事务内
    // 按前缀清理 `{session_id}:*` 键——删除后按前缀查询应返回 0 行。
    assert!(
        db.get_session_meta(&out_dir_key).unwrap().is_none(),
        "删除会话后 session_meta 前缀键应已级联清理（RUN-15）"
    );
    assert!(
        db.get_session_meta(&out_root_key).unwrap().is_none(),
        "output_root 键同事务清理（RUN-15）"
    );
}

/// 完整链路（T-EG-12 验收）：删除会话 → 产出目录进回收站（trash 注册
/// 断言）→ 清理通知发出（notice 含结果与回收站位置）
#[test]
fn delete_session_cleanup_full_chain_trashes_outputs_and_notifies() {
    // 场景：内存库会话 s1 + 工作区产出目录（G01 落键精确命中）
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    let ws = TempDir::new("ws");
    let trash = TempDir::new("trash");
    let out_dir = ws.0.join(".agent-outputs/2026-08-05-s1");
    std::fs::create_dir_all(out_dir.join("sub")).unwrap();
    std::fs::write(out_dir.join("sub/a.md"), "产出文档").unwrap();
    let out_dir_key = crate::outputs_config::session_meta_key_of(
        "s1",
        crate::outputs_config::SESSION_META_KEY_OUTPUT_DIR,
    );
    db.set_session_meta(&out_dir_key, out_dir.to_str().unwrap())
        .unwrap();

    // ① 删除会话（spawn_blocking 段直测）
    let (dir, root) = delete_session_and_read_meta(&db, "s1").unwrap();
    assert_eq!(dir.as_deref(), Some(out_dir.to_str().unwrap()));
    assert!(root.is_none());
    assert!(db.list_sessions().unwrap().is_empty());

    // ② 产出目录清理（trash 接管：conex-fs trash，不直接 remove）
    let result = crate::outputs_config::cleanup_session_outputs_at(
        trash.path(),
        ws.path(),
        "s1",
        dir.as_deref(),
        root.as_deref(),
        None,
        false,
    );
    assert!(result.cleaned, "notice: {}", result.notice);
    assert_eq!(
        result.trashed_dirs,
        vec![out_dir.to_string_lossy().into_owned()]
    );
    assert!(!out_dir.exists(), "产出目录应已移入回收站");

    // ③ trash 注册断言：条目可见、原路径正确、类型为目录
    let service = conex_fs::trash::TrashService::new(trash.path());
    let entries = service.list();
    assert_eq!(entries.len(), 1, "回收站登记应有且仅有一条");
    assert_eq!(entries[0].original_path, out_dir);
    assert_eq!(entries[0].kind, conex_fs::trash::TrashKind::Dir);

    // ④ 清理通知发出：结果 + 回收站位置
    assert!(result.notice.contains("移入回收站"));
    assert!(result.notice.contains("回收站位置"));
    assert!(
        result.trash_root.contains("trash"),
        "回收站位置应指向 trash 根：{}",
        result.trash_root
    );
}

/// 无产出目录的会话删除：清理为干净 no-op，通知说明无需清理
#[test]
fn delete_session_cleanup_no_outputs_noop_notice() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    let ws = TempDir::new("ws");
    let trash = TempDir::new("trash");

    let (dir, root) = delete_session_and_read_meta(&db, "s1").unwrap();
    assert!(dir.is_none() && root.is_none());

    let result = crate::outputs_config::cleanup_session_outputs_at(
        trash.path(),
        ws.path(),
        "s1",
        dir.as_deref(),
        root.as_deref(),
        None,
        false,
    );
    assert!(!result.cleaned);
    assert!(result.notice.contains("未发现会话产出目录"));
    assert!(result.notice.contains("回收站位置"));
    assert!(conex_fs::trash::TrashService::new(trash.path())
        .list()
        .is_empty());
}
