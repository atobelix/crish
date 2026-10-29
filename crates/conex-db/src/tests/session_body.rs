//! 会话正文：会话索引 Upsert、正文 CAS / rebase、追加 / 覆盖 / 收缩 / 清空、防误删、截断与消息解析。

use super::*;
use crate::messages::parse_session_messages_flexible;

#[test]
fn save_session_body_cas_conflict_rejects_stale_batch() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    // 首批 batch_version=1 成功
    db.save_session_body_versioned("s1", &[sample_message("m1", "user", 1)], Some(1))
        .unwrap();
    let list = db.list_sessions().unwrap();
    assert_eq!(list[0].message_count, 1);

    // 陈旧批次 batch_version=1（<= 当前 body_version=1）→ CasConflict
    let err = db
        .save_session_body_versioned("s1", &[sample_message("m-stale", "user", 2)], Some(1))
        .unwrap_err();
    assert_eq!(err.kind, crate::error::DbFailureKind::CasConflict);
    // 冲突批次不得污染正文
    assert_eq!(db.load_session_body("s1").unwrap().len(), 1);

    // 更新批次 batch_version=2 成功
    db.save_session_body_versioned(
        "s1",
        &[
            sample_message("m2", "user", 3),
            sample_message("m3", "assistant", 4),
        ],
        Some(2),
    )
    .unwrap();
    let list2 = db.list_sessions().unwrap();
    assert_eq!(list2[0].message_count, 2);
}

/// 回归（实证 2026-09-15，真实宿主）：重启后首批 `None`（rebase）必须把
/// `body_version` **归零**，使前端随后递传的 `Some(1..n)` 与库中序列连续。
///
/// 旧实现只更新 `message_count`、保留旧纪元版本 ⇒ 首批 rebase 之后每一批都
/// 命中 `n <= 旧纪元版本` 而 `CasConflict`，真实宿主表现为 **65 个会话的正文
/// 全部写不进 SQLite、整批降级 LS**（前端批次计数器是模块级内存变量，每次
/// 启动从 0 开始，首批恒为 1）。
#[test]
fn rebase_resets_body_version_so_post_restart_batches_are_accepted() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    // 旧纪元：上次运行写到 batch_version=40（留下高 body_version）
    db.save_session_body_versioned("s1", &[sample_message("m1", "user", 1)], Some(40))
        .unwrap();

    // 模拟重启：前端首批传 None（显式 rebase）——必须成功并归零纪元
    db.save_session_body_versioned("s1", &[sample_message("m1", "user", 1)], None)
        .unwrap();

    // 重启后的递增批次必须被接受（旧实现此处恒 CasConflict）
    db.save_session_body_versioned(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
        ],
        Some(1),
    )
    .unwrap();
    db.save_session_body_versioned(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
            sample_message("m3", "user", 3),
        ],
        Some(2),
    )
    .unwrap();
    assert_eq!(db.load_session_body("s1").unwrap().len(), 3);

    // 归零不得削弱 CAS 防线：同版本重放仍被拒
    let err = db
        .save_session_body_versioned("s1", &[sample_message("m4", "user", 4)], Some(2))
        .unwrap_err();
    assert_eq!(err.kind, crate::error::DbFailureKind::CasConflict);
    assert_eq!(
        db.load_session_body("s1").unwrap().len(),
        3,
        "冲突批次不得污染正文"
    );
}

/// 非 CAS rebase（batch_version=None）只做 Upsert 合并，不按载荷长度删尾：
/// 局部快照（2 条）不得抹掉库内 4 条历史，message_count 取库内实际行数。
/// 显式替换 API（save_session_body）仍保留缩容语义（撤回/清空/恢复自愈）。
#[test]
fn rebase_without_version_never_truncates_stored_history() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    let full: Vec<_> = (1..=4)
        .map(|i| sample_message(&format!("m{i}"), "user", i))
        .collect();
    db.save_session_body_versioned("s1", &full, Some(1))
        .unwrap();
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 4);

    db.save_session_body_versioned("s1", &full[..2], None)
        .unwrap();

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 4, "非 CAS rebase 不得删除库内既有尾部");
    assert_eq!(loaded[3].id, "m4");
    assert_eq!(
        db.list_sessions().unwrap()[0].message_count,
        4,
        "message_count 必须反映库内实际行数"
    );

    // 显式全量替换仍允许缩容
    db.save_session_body("s1", &full[..1]).unwrap();
    assert_eq!(db.load_session_body("s1").unwrap().len(), 1);
}

#[test]
fn upsert_and_list_sessions() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.upsert_session_entry(&sample_entry("s2")).unwrap();

    let list = db.list_sessions().unwrap();
    assert_eq!(list.len(), 2);
    // updated_at 相同，按 id 升序
    assert_eq!(list[0].id, "s1");
    assert_eq!(list[1].id, "s2");
}

#[test]
fn upsert_does_not_cascade_delete_messages() {
    // INSERT OR REPLACE 会触发 ON DELETE CASCADE，必须用 ON CONFLICT DO UPDATE
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
        ],
    )
    .unwrap();

    // 再次 upsert 同一会话，不应丢失消息
    let mut entry = sample_entry("s1");
    entry.title = "Updated Title".to_string();
    db.upsert_session_entry(&entry).unwrap();

    let body = db.load_session_body("s1").unwrap();
    assert_eq!(body.len(), 2, "messages must survive upsert");
    assert_eq!(db.list_sessions().unwrap()[0].title, "Updated Title");
}

#[test]
fn save_and_load_session_body() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    let msgs = vec![
        sample_message("m1", "user", 100),
        sample_message("m2", "assistant", 200),
        sample_message("m3", "user", 300),
    ];
    db.save_session_body("s1", &msgs).unwrap();

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 3);
    assert_eq!(loaded[0].id, "m1");
    assert_eq!(loaded[2].id, "m3");
    assert_eq!(loaded[1].sender, "assistant");
}

/// 追加语义：短数组 → 长数组时 Diff Shrink 匹配 0 行，尾部仅新增 Upsert。
#[test]
fn save_session_body_append_grows_and_keeps_prefix() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    db.save_session_body("s1", &[sample_message("m1", "user", 1)])
        .unwrap();
    assert_eq!(db.load_session_body("s1").unwrap().len(), 1);
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 1);

    // 追加：前缀 m1 保持，新增 m2 / m3
    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
            sample_message("m3", "user", 3),
        ],
    )
    .unwrap();

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 3, "追加后物理行数 = 新长度");
    assert_eq!(loaded[0].id, "m1");
    assert_eq!(loaded[1].id, "m2");
    assert_eq!(loaded[2].id, "m3");
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 3);
}

/// 覆盖语义：同长度数组按 (session_id, seq) Upsert 全字段（含 id/sender/text）。
#[test]
fn save_session_body_upsert_overwrites_all_fields() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
        ],
    )
    .unwrap();

    // 同长度再保存：同 seq 位置全字段被 excluded 覆盖
    let mut m1 = sample_message("m1-x", "assistant", 10);
    m1.text = Some("overwritten".into());
    db.save_session_body("s1", &[m1, sample_message("m3", "user", 3)])
        .unwrap();

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 2, "同长度覆盖不增不减行");
    assert_eq!(loaded[0].id, "m1-x", "id 全字段覆盖");
    assert_eq!(loaded[0].sender, "assistant", "sender 全字段覆盖");
    assert_eq!(
        loaded[0].text.as_deref(),
        Some("overwritten"),
        "text 全字段覆盖"
    );
    assert_eq!(loaded[1].id, "m3");
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 2);
}

/// Diff Shrink 收缩语义：长数组 → 短数组时仅删 seq >= 新长度的尾部。
#[test]
fn save_session_body_diff_shrink_removes_tail() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
            sample_message("m3", "user", 3),
        ],
    )
    .unwrap();
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 3);

    // 收缩：保留前缀 m1，物理删除 seq >= 1 的尾部
    db.save_session_body("s1", &[sample_message("m1", "user", 1)])
        .unwrap();

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 1, "Diff Shrink 后仅剩前缀");
    assert_eq!(loaded[0].id, "m1");
    assert_eq!(
        db.list_sessions().unwrap()[0].message_count,
        1,
        "message_count 绝对赋值 = messages.len()"
    );
}

/// 清空语义：空数组 + Diff Shrink(seq >= 0) 清空该会话全部消息行。
#[test]
fn save_session_body_clear_empty_array_empties_session() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "user", 2),
        ],
    )
    .unwrap();
    assert_eq!(db.load_session_body("s1").unwrap().len(), 2);

    // 显式清空（空数组）：显式 CAS 版本号推进清空
    db.save_session_body_versioned("s1", &[], Some(1)).unwrap();

    assert!(db.load_session_body("s1").unwrap().is_empty());
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 0);
}

/// 覆盖 + 收缩组合：既有字段覆盖又有尾部收缩，端到端行数与内容一致。
#[test]
fn save_session_body_replace_with_shrink_combined() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
            sample_message("m3", "user", 3),
        ],
    )
    .unwrap();
    // 再次保存：覆盖 m1 全字段 + 收缩删除 m2/m3
    let mut m1 = sample_message("m1b", "assistant", 20);
    m1.text = Some("rewritten".into());
    db.save_session_body("s1", &[m1]).unwrap();

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 1, "覆盖 + 收缩后仅 1 行");
    assert_eq!(loaded[0].id, "m1b");
    assert_eq!(loaded[0].text.as_deref(), Some("rewritten"));
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 1);
}

/// message_count 绝对赋值：与序列长度严格相等（追加 / 收缩 / 清空三段）。
#[test]
fn message_count_absolute_assign_tracks_len() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    // 追加：2 条
    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
        ],
    )
    .unwrap();
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 2);

    // 收缩：1 条（旧「先 delete(-2) 再 insert(+1)」触发器双轨口径已退役）
    db.save_session_body("s1", &[sample_message("m-only", "user", 10)])
        .unwrap();
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 1);

    // 显式清空：0 条（需带 CAS 版本）
    db.save_session_body_versioned("s1", &[], Some(1)).unwrap();
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 0);
}

/// Task-2 物理防误删守卫：无 CAS 的盲写空数组禁止清空已有历史消息或历史事件的会话。
#[test]
fn save_session_body_empty_without_cas_guarded_against_accidental_delete() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    // 1. 会话已有 2 条消息，盲写空数组 (batch_version = None) 必须被物理拦截
    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
        ],
    )
    .unwrap();
    assert_eq!(db.load_session_body("s1").unwrap().len(), 2);

    // 模拟前端启动未水合懒壳盲写 []
    db.save_session_body("s1", &[]).unwrap();

    // 消息完好保留，message_count 未被归零
    assert_eq!(
        db.load_session_body("s1").unwrap().len(),
        2,
        "盲写空数组必须被物理拦截，消息不能丢失"
    );
    assert_eq!(
        db.list_sessions().unwrap()[0].message_count,
        2,
        "message_count 必须保持原值"
    );

    // 2. 会话 session_messages 为空，但在 events 表中存在 message-start / message-end
    db.upsert_session_entry(&sample_entry("s2")).unwrap();
    db.append_event(
        "s2",
        1,
        "message-start",
        r#"{"type":"message-start","sessionId":"s2"}"#,
        None,
    )
    .unwrap();
    db.append_event(
        "s2",
        2,
        "message-end",
        r#"{"type":"message-end","sessionId":"s2"}"#,
        None,
    )
    .unwrap();

    // 对 s2 尝试盲写空数组：因为 events 表存在对话事件，同样被守卫拦截
    db.save_session_body("s2", &[]).unwrap();

    // 3. 真正无消息且无事件的纯新空会话，盲写空数组允许放行
    db.upsert_session_entry(&sample_entry("s_empty")).unwrap();
    db.save_session_body("s_empty", &[]).unwrap();
    assert_eq!(db.load_session_body("s_empty").unwrap().len(), 0);

    // 4. 显式带有 CAS 版本号的清空操作，允许正常清空
    db.save_session_body_versioned("s1", &[], Some(1)).unwrap();
    assert_eq!(db.load_session_body("s1").unwrap().len(), 0);
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 0);
}

#[test]
fn parse_session_messages_flexible_handles_empty() {
    assert!(parse_session_messages_flexible("").is_empty());
    assert!(parse_session_messages_flexible("   \n  ").is_empty());
}

#[test]
fn parse_session_messages_flexible_handles_bad_jsonl() {
    let raw = "not json\n{\"id\":\"m1\",\"sender\":\"user\",\"timestamp\":1}\nalso bad";
    let msgs = parse_session_messages_flexible(raw);
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].id, "m1");
}

#[test]
fn test_truncate_session_messages_after_physical_shrink_and_metadata() {
    let (db, _guard) = open_temp_wal_db();
    db.insert_session("s1", "retraction session").unwrap();

    // 1. 插入 5 条消息 (seq 0..4)
    let messages = vec![
        sample_message("m0", "user", 1),
        sample_message("m1", "assistant", 2),
        sample_message("m2", "user", 3),
        sample_message("m3", "assistant", 4),
        sample_message("m4", "assistant", 5),
    ];
    db.save_session_body_versioned("s1", &messages, Some(1))
        .unwrap();

    let initial = db.load_session_body("s1").unwrap();
    assert_eq!(initial.len(), 5);

    // 2. 截断 m2 之后的消息（删除 m3, m4）
    let deleted = db.truncate_session_messages_after("s1", "m2").unwrap();
    assert_eq!(deleted, 2, "物理删除 2 条被撤回消息");

    // 3. 读回验证：仅剩 3 条消息，且顺序保持为 m0, m1, m2
    let remaining = db.load_session_body("s1").unwrap();
    assert_eq!(remaining.len(), 3);
    assert_eq!(remaining[0].id, "m0");
    assert_eq!(remaining[1].id, "m1");
    assert_eq!(remaining[2].id, "m2");

    // 4. sessions 表元数据断言：message_count == 3，body_version 自增为 2
    let list = db.list_sessions().unwrap();
    assert_eq!(list[0].message_count, 3);
    db.read(|conn| {
        let (count, version): (i64, i64) = conn
            .query_row(
                "SELECT message_count, body_version FROM sessions WHERE id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 3);
        assert_eq!(version, 2);
        Ok(())
    })
    .unwrap();

    // 5. 不存在的消息 ID 报错
    let err = db
        .truncate_session_messages_after("s1", "m-nonexistent")
        .unwrap_err();
    assert_eq!(
        err.kind,
        DbFailureKind::Other("truncate_target_not_found".into())
    );

    // 6. 空会话截断安全返回 Ok(0)
    db.insert_session("s_empty", "empty").unwrap();
    let zero = db
        .truncate_session_messages_after("s_empty", "any")
        .unwrap();
    assert_eq!(zero, 0);

    // 7. 测试 truncate_session_messages_after_seq
    let deleted_seq = db.truncate_session_messages_after_seq("s1", 1).unwrap();
    assert_eq!(deleted_seq, 1, "删除 seq > 1（即 m2，seq=2）");
    let after_seq = db.load_session_body("s1").unwrap();
    assert_eq!(after_seq.len(), 2);
    assert_eq!(after_seq[0].id, "m0");
    assert_eq!(after_seq[1].id, "m1");
}
