use super::*;

/// 会话记录往返：to_session_record → from_session_record 保持结构与叶子
#[test]
fn session_record_roundtrip_preserves_tree() {
    let mut t = tree();
    chain(&mut t);
    t.move_leaf(Some("root"), None).unwrap();
    let record = t.to_session_record();
    assert_eq!(record.session_id, "session_a");
    assert_eq!(record.current_leaf_id.as_deref(), Some("root"));
    assert_eq!(record.branches.len(), 3, "分支列表 = 全部条目");

    let restored = SessionTree::from_session_record(record).unwrap();
    assert_eq!(restored.current_leaf_id(), Some("root"));
    assert_eq!(restored.entries().len(), 3);
    // 当前叶子为 root（移动后的指针保真）
    let branch = restored
        .read_branch_path(restored.current_leaf_id())
        .unwrap();
    let path: Vec<&str> = branch.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(path, vec!["root"]);
    // 原分支路径仍可回溯（树结构完整）
    let branch = restored.read_branch_path(Some("leaf")).unwrap();
    let path: Vec<&str> = branch.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(path, vec!["root", "mid", "leaf"]);
}

/// 叶子移动持久化事件：载荷构建 + 应用（orchestrator.test.ts:813）
#[test]
fn leaf_move_event_payload_roundtrip() {
    let mut record = tree().to_session_record();
    record
        .apply_leaf_move_event(&session_leaf_moved_payload("leaf_target"))
        .unwrap();
    assert_eq!(record.current_leaf_id.as_deref(), Some("leaf_target"));

    let err = record.apply_leaf_move_event("{}").unwrap_err();
    assert!(matches!(err, SessionTreeError::InvalidState { .. }));
}

// ── T-34：会话上下文元数据（P4 阶段 5-1 护栏持久化） ──

/// 会话记录上下文元数据：set / get + serde roundtrip（快照持久化形态）
#[test]
fn session_record_context_meta_roundtrip() {
    let meta = conex_types::context::SessionContextMeta {
        last_compaction_at: Some(1_700_000_000_000),
        last_compaction_sequence: Some(42),
        last_compaction_generation: Some(3),
        compression_retries: 1,
    };
    let mut record = tree().to_session_record();
    assert!(record.context_meta().is_none(), "新建会话记录无护栏");
    record.set_context_meta(meta.clone());
    assert_eq!(record.context_meta(), Some(&meta));

    // serde roundtrip：camelCase + skip_none（快照/会话记录持久化形态）
    let json = serde_json::to_string(&record).unwrap();
    let back: SessionRecord = serde_json::from_str(&json).unwrap();
    assert_eq!(back.context_meta(), Some(&meta));
    assert!(json.contains("contextMeta"), "camelCase 序列化：{json}");
    // 旧快照（无 contextMeta 字段）→ None（schema 兼容）
    let legacy = r#"{"sessionId":"s1","currentLeafId":null,"branches":[]}"#;
    let legacy_record: SessionRecord = serde_json::from_str(legacy).unwrap();
    assert!(legacy_record.context_meta().is_none(), "旧快照缺省 None");
}

/// 压缩结束事件折叠：last_compaction_at = 事件时间戳（epoch ms）、
/// sequence = 事件序列、generation 逐条 +1、compression_retries 归零
#[test]
fn apply_compression_end_updates_guards() {
    let mut record = tree().to_session_record();
    let boundary = parse_iso8601_epoch_ms("2026-08-03T10:00:00.000Z").unwrap();
    // 首次压缩：从无护栏建立
    assert!(record.apply_compression_end(7, "2026-08-03T10:00:00.000Z"));
    let meta = record.context_meta().expect("首次压缩必须建立护栏");
    assert_eq!(meta.last_compaction_at, Some(boundary));
    assert_eq!(meta.last_compaction_sequence, Some(7));
    assert_eq!(meta.last_compaction_generation, Some(1), "首次压缩代数 = 1");
    assert_eq!(meta.compression_retries, 0);
    // 第二次压缩：边界推进、序列更新、代数 +1
    let boundary2 = parse_iso8601_epoch_ms("2026-08-03T12:30:00.000Z").unwrap();
    assert!(record.apply_compression_end(15, "2026-08-03T12:30:00.000Z"));
    let meta = record.context_meta().expect("护栏持续存在");
    assert_eq!(
        meta.last_compaction_at,
        Some(boundary2),
        "边界推进到最近压缩"
    );
    assert_eq!(meta.last_compaction_sequence, Some(15));
    assert_eq!(meta.last_compaction_generation, Some(2), "代数按事件累计");
}

/// 时间戳不可解析：保持既有护栏状态（不写坏），返回 false
#[test]
fn apply_compression_end_ignores_unparseable_timestamp() {
    let mut record = tree().to_session_record();
    assert!(!record.apply_compression_end(1, "not-a-timestamp"));
    assert!(record.context_meta().is_none(), "非法输入不得建立护栏");
    // 既有护栏 + 非法输入：护栏不被破坏
    assert!(record.apply_compression_end(2, "2026-08-03T10:00:00.000Z"));
    assert!(!record.apply_compression_end(3, "2026-13-99T99:99:99.000Z"));
    let meta = record.context_meta().expect("既有护栏保留");
    assert_eq!(
        meta.last_compaction_sequence,
        Some(2),
        "非法输入不得推进序列"
    );
    assert_eq!(meta.last_compaction_generation, Some(1));
}

/// ISO 时间戳解析精度：毫秒、缺毫秒、非法形态
#[test]
fn parse_iso8601_epoch_ms_precision() {
    assert_eq!(parse_iso8601_epoch_ms("1970-01-01T00:00:00.000Z"), Some(0));
    assert_eq!(
        parse_iso8601_epoch_ms("1970-01-01T00:00:00.500Z"),
        Some(500)
    );
    assert_eq!(
        parse_iso8601_epoch_ms("1970-01-01T00:00:01Z"),
        Some(1_000),
        "缺毫秒按 0 处理"
    );
    assert_eq!(
        parse_iso8601_epoch_ms("2026-08-03T11:30:00.500Z"),
        parse_iso8601_epoch_ms("2026-08-03T11:30:00.5Z"),
        "毫秒补零一致"
    );
    for bad in [
        "2026-08-03T11:30:00",
        "2026-08-03 11:30:00.000Z",
        "2026-13-01T00:00:00.000Z",
        "2026-08-03T24:00:00.000Z",
        "garbage",
        "",
    ] {
        assert_eq!(parse_iso8601_epoch_ms(bad), None, "非法形态：{bad}");
    }
}
