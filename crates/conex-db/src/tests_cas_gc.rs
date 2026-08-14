//! CAS 活数据垃圾回收（GC）、租约隔离与反隔离自愈全套破坏性测试套件。
//!
//! 覆盖场景（Batch 2 Unit 2.2 + ROUND-3-IMPROVEMENT-02 §7.1 TEST-02/TEST-03）：
//! 1. 多源联合引用安全网扫描（Block 附件、CRDT 快照历史、Undo 栈引用）；
//! 2. 30 分钟活数据保护租约（BlobLeaseGuard 与 active_blob_leases 表）；
//! 3. 7 天软删除隔离期（仅标记 marked_for_delete_at，严禁即时物理删除）；
//! 4. 读取阶段反隔离自愈（Un-quarantine on Read）；
//! 5. Pinned 置顶与新建宽限期保护；
//! 6. 全生命周期 Undo 恢复与租约转合入测试。

use crate::cas_gc::*;
use crate::lease_guard::*;
use crate::LocalDb;
use rusqlite::params;
use std::time::Duration;

#[test]
fn test_sha256_hash_vectors() {
    assert_eq!(
        compute_sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        compute_sha256_hex(b"hello"),
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
    assert_eq!(
        compute_sha256_hex(b"conex cas attachment 2026"),
        "9d7fd0f33068893b3d475713e99cbc9101b3ab5714bac1b6d8ff7014783ce803"
    );
}

#[test]
fn test_put_get_blob_roundtrip_and_idempotence() {
    let db = LocalDb::open_in_memory().unwrap();
    let data = b"sample attachment binary payload";
    let hash1 = db.put_blob(data).unwrap();
    assert_eq!(hash1, compute_sha256_hex(data));

    // 同内容重复 put 幂等
    let hash2 = db.put_blob(data).unwrap();
    assert_eq!(hash1, hash2);
    assert_eq!(db.count_blobs().unwrap(), 1);

    // 读取内容
    let read_back = db.get_blob(&hash1).unwrap().expect("blob must exist");
    assert_eq!(read_back, data);

    // 查询不存在的 Hash 返回 None
    assert!(db
        .get_blob("0000000000000000000000000000000000000000000000000000000000000000")
        .unwrap()
        .is_none());
}

#[test]
fn test_multi_source_joint_scan_block_attachments_protects() {
    let db = LocalDb::open_in_memory().unwrap();
    let h1 = db.put_blob(b"block-attached-blob").unwrap();
    let h2 = db.put_blob(b"orphan-blob").unwrap();

    // 关联 h1 到 block_attachments
    db.link_block_attachment("doc-1", "block-img-1", &h1)
        .unwrap();

    let links = db.list_block_attachments("doc-1", "block-img-1").unwrap();
    assert_eq!(links, vec![h1.clone()]);

    // 执行零宽限 GC
    let cfg = CasGcConfig::zero_grace();
    let stats = db.run_cas_gc(&cfg).unwrap();

    // h1 受 block_attachments 保护，未被隔离
    assert!(!stats.quarantined_hashes.contains(&h1));
    // h2 是孤儿，被标记隔离
    assert!(stats.quarantined_hashes.contains(&h2));

    let meta1 = db.peek_blob_meta(&h1).unwrap().unwrap();
    assert!(meta1.marked_for_delete_at.is_none());

    let meta2 = db.peek_blob_meta(&h2).unwrap().unwrap();
    assert!(meta2.marked_for_delete_at.is_some());
}

#[test]
fn test_multi_source_joint_scan_doc_snapshots_protects() {
    let db = LocalDb::open_in_memory().unwrap();
    let h1 = db.put_blob(b"snapshot-historical-blob").unwrap();
    let h2 = db.put_blob(b"orphan-blob-2").unwrap();

    // 关联 h1 到 doc_snapshots_attachments（CRDT 历史快照保护）
    db.link_snapshot_attachment("doc-history-1", "snap-v4", &h1)
        .unwrap();

    let cfg = CasGcConfig::zero_grace();
    let stats = db.run_cas_gc(&cfg).unwrap();

    assert!(
        !stats.quarantined_hashes.contains(&h1),
        "快照附件严禁被 GC 隔离"
    );
    assert!(
        stats.quarantined_hashes.contains(&h2),
        "孤儿 Blob 必须被隔离"
    );

    let meta1 = db.peek_blob_meta(&h1).unwrap().unwrap();
    assert!(meta1.marked_for_delete_at.is_none());
}

#[test]
fn test_multi_source_joint_scan_session_undo_protects() {
    let db = LocalDb::open_in_memory().unwrap();
    let h1 = db.put_blob(b"undo-stack-blob-data").unwrap();
    let h2 = db.put_blob(b"orphan-blob-3").unwrap();

    // 关联 h1 到 session_undo_blobs（Undo 栈保护）
    db.link_undo_blob("session-a", "undo-step-12", &h1).unwrap();

    let cfg = CasGcConfig::zero_grace();
    let stats = db.run_cas_gc(&cfg).unwrap();

    assert!(
        !stats.quarantined_hashes.contains(&h1),
        "Undo 栈附件严禁被 GC 隔离"
    );
    assert!(
        stats.quarantined_hashes.contains(&h2),
        "孤儿 Blob 必须被隔离"
    );

    let meta1 = db.peek_blob_meta(&h1).unwrap().unwrap();
    assert!(meta1.marked_for_delete_at.is_none());
}

#[test]
fn test_lease_guard_30_min_lease_protects_upload_in_flight() {
    let db = LocalDb::open_in_memory().unwrap();
    let h1 = db.put_blob(b"uploading-blob-in-flight").unwrap();
    let h2 = db.put_blob(b"unprotected-orphan").unwrap();

    // 获取 30 分钟活数据保护租约
    let lease = db
        .acquire_blob_lease(
            &h1,
            Some("agent-upload-session"),
            Some(Duration::from_secs(1800)),
        )
        .unwrap();
    assert_eq!(lease.blob_hash, h1);
    assert!(db.is_blob_leased(&h1).unwrap());
    assert!(!db.is_blob_leased(&h2).unwrap());

    // 运行零宽限 GC
    let cfg = CasGcConfig::zero_grace();
    let stats = db.run_cas_gc(&cfg).unwrap();

    // 租约保护下的 h1 绝不进入软隔离
    assert!(
        !stats.quarantined_hashes.contains(&h1),
        "活跃租约中的 Blob 绝不能被隔离"
    );
    assert!(stats.quarantined_hashes.contains(&h2));

    // 释放租约后再次 GC
    db.release_blob_lease(&lease.lease_id).unwrap();
    assert!(!db.is_blob_leased(&h1).unwrap());

    let stats2 = db.run_cas_gc(&cfg).unwrap();
    assert!(
        stats2.quarantined_hashes.contains(&h1),
        "租约释放且无引用的 Blob 正确进入隔离"
    );
}

#[test]
fn test_blob_lease_guard_in_memory_and_db_flow() {
    // 1. 内存高速守卫测试
    let guard = BlobLeaseGuard::new();
    guard.acquire_lease("hash-mem-1");
    assert!(guard.is_leased("hash-mem-1"));
    assert!(!guard.is_leased("hash-mem-2"));
    assert_eq!(guard.active_count(), 1);
    assert_eq!(guard.leased_hashes(), vec!["hash-mem-1".to_string()]);

    guard.release_lease("hash-mem-1");
    assert!(!guard.is_leased("hash-mem-1"));
    assert_eq!(guard.active_count(), 0);

    // 2. DB 持久化租约方法测试
    let db = LocalDb::open_in_memory().unwrap();
    let l1 = db
        .acquire_blob_lease(
            "hash-db-1",
            Some("holder-1"),
            Some(Duration::from_secs(1800)),
        )
        .unwrap();
    let l2 = db
        .acquire_blob_lease(
            "hash-db-2",
            Some("holder-2"),
            Some(Duration::from_secs(1800)),
        )
        .unwrap();
    assert_eq!(l2.blob_hash, "hash-db-2");

    let active = db.list_active_blob_leases().unwrap();
    assert_eq!(active.len(), 2);

    // 续期租约
    let renewed = db
        .renew_blob_lease(&l1.lease_id, Some(Duration::from_secs(3600)))
        .unwrap();
    assert!(renewed);

    // 按 Hash 批量释放
    let released_count = db.release_blob_leases_for_hash("hash-db-2").unwrap();
    assert_eq!(released_count, 1);
    assert!(!db.is_blob_leased("hash-db-2").unwrap());

    // 释放 l1
    db.release_blob_lease(&l1.lease_id).unwrap();
    assert_eq!(db.list_active_blob_leases().unwrap().len(), 0);
}

#[test]
fn test_soft_delete_quarantine_7_days_does_not_immediately_purge() {
    let db = LocalDb::open_in_memory().unwrap();
    let h = db.put_blob(b"orphan-payload").unwrap();

    // 7 天隔离期配置（零创建宽限期）
    let cfg = CasGcConfig {
        quarantine_duration_secs: 7 * 86400,
        creation_grace_secs: 0,
    };

    // 运行第 1 次 GC：进入软删除隔离期
    let stats = db.run_cas_gc(&cfg).unwrap();
    assert_eq!(stats.quarantined_hashes, vec![h.clone()]);
    assert!(stats.purged_hashes.is_empty(), "严禁即时物理删除！");

    // 数据库行依然完好，未被物理删除
    assert_eq!(db.count_blobs().unwrap(), 1);
    assert_eq!(db.count_quarantined_blobs().unwrap(), 1);

    // 连续多次运行 GC，在 7 天内绝不物理删除
    for _ in 0..3 {
        let stats_repeat = db.run_cas_gc(&cfg).unwrap();
        assert!(
            stats_repeat.purged_hashes.is_empty(),
            "7 天隔离期内绝不物理删除"
        );
        assert_eq!(db.count_blobs().unwrap(), 1);
    }
}

#[test]
fn test_quarantine_unhealed_purged_after_7_days() {
    let db = LocalDb::open_in_memory().unwrap();
    let h = db.put_blob(b"orphan-to-expire").unwrap();

    // 标记隔离，并将 marked_for_delete_at 手动模拟为 8 天前
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "UPDATE blob_cas SET marked_for_delete_at = datetime('now', '-8 days') WHERE hash = ?1",
        params![h],
    )
    .unwrap();
    drop(conn);

    let meta = db.peek_blob_meta(&h).unwrap().unwrap();
    assert!(meta.marked_for_delete_at.is_some());

    // 运行 7 天隔离配置 GC
    let cfg = CasGcConfig {
        quarantine_duration_secs: 7 * 86400,
        creation_grace_secs: 0,
    };
    let stats = db.run_cas_gc(&cfg).unwrap();

    // 8 天前的孤儿已被物理清除
    assert_eq!(stats.purged_hashes, vec![h.clone()]);
    assert_eq!(db.count_blobs().unwrap(), 0);
    assert!(db.peek_blob_meta(&h).unwrap().is_none());
}

#[test]
fn test_unquarantine_self_healing_on_read() {
    let db = LocalDb::open_in_memory().unwrap();
    let payload = b"critical-healed-attachment";
    let h = db.put_blob(payload).unwrap();

    // 让其进入隔离期
    let cfg = CasGcConfig::zero_grace();
    let marked = db.mark_quarantine_orphans(&cfg).unwrap();
    assert_eq!(marked, vec![h.clone()]);

    let meta_before = db.peek_blob_meta(&h).unwrap().unwrap();
    assert!(
        meta_before.marked_for_delete_at.is_some(),
        "必须处于软删除隔离期"
    );

    // 用户通过 get_blob 读取内容 -> 触发反隔离自愈！
    let read_data = db
        .get_blob(&h)
        .unwrap()
        .expect("blob must be readable during quarantine");
    assert_eq!(read_data, payload);

    // 验证反隔离自愈：marked_for_delete_at 已原子恢复为 NULL
    let meta_after = db.peek_blob_meta(&h).unwrap().unwrap();
    assert!(
        meta_after.marked_for_delete_at.is_none(),
        "读取必须自动完成反隔离自愈！"
    );

    // 模拟隔离期满（8 天）再次 GC：因为已自愈，绝不被误杀物理删除！
    let purge_cfg = CasGcConfig {
        quarantine_duration_secs: 0,
        creation_grace_secs: 300, // 宽限期保护已自愈数据
    };
    let purged = db.purge_expired_quarantined(&purge_cfg).unwrap();
    assert!(purged.is_empty(), "已自愈的数据绝不可被物理清除");
    assert_eq!(db.count_blobs().unwrap(), 1);
}

#[test]
fn test_unquarantine_self_healing_on_meta_read() {
    let db = LocalDb::open_in_memory().unwrap();
    let h = db.put_blob(b"meta-heal-data").unwrap();

    db.mark_quarantine_orphans(&CasGcConfig::zero_grace())
        .unwrap();
    assert!(db
        .peek_blob_meta(&h)
        .unwrap()
        .unwrap()
        .marked_for_delete_at
        .is_some());

    // get_blob_meta 默认触发反隔离自愈
    let meta = db.get_blob_meta(&h).unwrap().unwrap();
    assert!(meta.marked_for_delete_at.is_none());

    // 再次 peek 确认已持久化自愈
    let peeked = db.peek_blob_meta(&h).unwrap().unwrap();
    assert!(peeked.marked_for_delete_at.is_none());
}

#[test]
fn test_pinned_blob_never_quarantined_or_purged() {
    let db = LocalDb::open_in_memory().unwrap();
    let h = db.put_blob(b"pinned-template-image").unwrap();

    // 设置置顶保护
    let pinned = db.pin_blob(&h, true).unwrap();
    assert!(pinned);

    let meta = db.peek_blob_meta(&h).unwrap().unwrap();
    assert!(meta.pinned);

    // 零宽限与零隔离期极端 GC
    let cfg = CasGcConfig::zero_grace();
    let stats = db.run_cas_gc(&cfg).unwrap();

    assert!(
        stats.quarantined_hashes.is_empty(),
        "Pinned Blob 严禁进入隔离期"
    );
    assert!(stats.purged_hashes.is_empty(), "Pinned Blob 严禁被物理清除");
    assert_eq!(db.count_blobs().unwrap(), 1);

    // 取消置顶后再 GC
    db.pin_blob(&h, false).unwrap();
    let stats2 = db.run_cas_gc(&cfg).unwrap();
    assert!(
        stats2.quarantined_hashes.contains(&h),
        "取消置顶后正常进入隔离"
    );
}

#[test]
fn test_full_undo_lifecycle_with_quarantine_and_healing() {
    let db = LocalDb::open_in_memory().unwrap();
    let img_bytes = b"user-uploaded-photo-bytes";
    let hash = db.put_blob(img_bytes).unwrap();

    // 1. 用户将图片插入 Block 1
    db.link_block_attachment("doc-notes", "block-img-1", &hash)
        .unwrap();

    // 2. 用户删除了 Block 1，此时将历史状态存入 session_undo_blobs
    db.unlink_block_attachment("doc-notes", "block-img-1", &hash)
        .unwrap();
    db.link_undo_blob("session-user", "undo-op-42", &hash)
        .unwrap();

    // 3. 后台定时 GC 运行：由于 Undo 栈引用存在，绝不隔离！
    let cfg = CasGcConfig::zero_grace();
    let stats1 = db.run_cas_gc(&cfg).unwrap();
    assert!(!stats1.quarantined_hashes.contains(&hash));
    assert!(db
        .peek_blob_meta(&hash)
        .unwrap()
        .unwrap()
        .marked_for_delete_at
        .is_none());

    // 4. 会话结束或 Undo 栈清空（移除 undo 引用）
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "DELETE FROM session_undo_blobs WHERE blob_hash = ?1",
        params![hash],
    )
    .unwrap();
    drop(conn);

    // 5. 下一次 GC：进入 7 天隔离期
    let stats2 = db.run_cas_gc(&CasGcConfig::zero_grace()).unwrap();
    assert!(stats2.quarantined_hashes.contains(&hash));
    assert!(db
        .peek_blob_meta(&hash)
        .unwrap()
        .unwrap()
        .marked_for_delete_at
        .is_some());

    // 6. 用户触发撤销（Undo），恢复 Block 并调用 get_blob
    let restored_bytes = db.get_blob(&hash).unwrap().expect("Blob 必须在隔离期可读");
    assert_eq!(restored_bytes, img_bytes);

    // 7. 重新关联 Block 附件
    db.link_block_attachment("doc-notes", "block-img-1", &hash)
        .unwrap();

    // 8. 验证已反隔离自愈
    assert!(db
        .peek_blob_meta(&hash)
        .unwrap()
        .unwrap()
        .marked_for_delete_at
        .is_none());

    // 9. 后续 GC 运行，数据完好无损
    let stats3 = db.run_cas_gc(&CasGcConfig::zero_grace()).unwrap();
    assert!(!stats3.quarantined_hashes.contains(&hash));
    assert!(!stats3.purged_hashes.contains(&hash));
    assert_eq!(db.count_blobs().unwrap(), 1);
}

#[test]
fn test_lease_transition_to_block_attachment() {
    let db = LocalDb::open_in_memory().unwrap();
    let file_data = b"large-binary-video-payload";
    let hash = db.put_blob(file_data).unwrap();

    // 1. 上传期间获取租约（30 分钟）
    let lease = db
        .acquire_blob_lease(
            &hash,
            Some("upload-job-99"),
            Some(Duration::from_secs(1800)),
        )
        .unwrap();

    // 2. GC 运行：租约保护，不进入隔离
    let cfg = CasGcConfig::zero_grace();
    let stats1 = db.run_cas_gc(&cfg).unwrap();
    assert!(!stats1.quarantined_hashes.contains(&hash));

    // 3. LLM 确认并合入文档块
    db.link_block_attachment("doc-target", "block-video", &hash)
        .unwrap();

    // 4. 释放上传租约
    db.release_blob_lease(&lease.lease_id).unwrap();

    // 5. GC 再次运行：受 block_attachments 保护，依旧安全
    let stats2 = db.run_cas_gc(&cfg).unwrap();
    assert!(!stats2.quarantined_hashes.contains(&hash));
    assert_eq!(db.count_blobs().unwrap(), 1);
}

#[test]
fn test_purge_physically_removes_external_file() {
    let db = LocalDb::open_in_memory().unwrap();
    let temp_dir = std::env::temp_dir().join(format!("conex_cas_test_{}", std::process::id()));
    std::fs::create_dir_all(&temp_dir).unwrap();
    let temp_file = temp_dir.join("external_blob.bin");
    std::fs::write(&temp_file, b"external payload content").unwrap();
    assert!(temp_file.exists());

    let file_path_str = temp_file.to_str().unwrap().to_string();
    let hash = db
        .put_blob_with_options(b"external payload content", "file", &file_path_str)
        .unwrap();

    // 1. 进入软隔离
    let cfg = CasGcConfig::zero_grace();
    let stats1 = db.run_cas_gc(&cfg).unwrap();
    assert!(stats1.quarantined_hashes.contains(&hash));
    assert!(temp_file.exists(), "软删除期间物理文件必须保留");

    // 2. 模拟 8 天前过期并执行物理清除
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "UPDATE blob_cas SET marked_for_delete_at = datetime('now', '-8 days') WHERE hash = ?1",
        params![hash],
    )
    .unwrap();
    drop(conn);

    let purge_cfg = CasGcConfig {
        quarantine_duration_secs: 7 * 86400,
        creation_grace_secs: 0,
    };
    let purged = db.purge_expired_quarantined(&purge_cfg).unwrap();
    assert_eq!(purged, vec![hash.clone()]);
    assert_eq!(db.count_blobs().unwrap(), 0);

    // 3. 验证物理文件被真正 unlink
    assert!(!temp_file.exists(), "物理清除后外置文件必须被真正删除");
    let _ = std::fs::remove_dir_all(&temp_dir);
}
