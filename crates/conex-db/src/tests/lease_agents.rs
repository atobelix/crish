//! 全局恢复排他租约与子代理（session_agents）持久化：增量 Upsert、移除差集、导入路径。

use super::*;
use conex_types::SessionAgent;
use std::collections::HashMap;

#[test]
fn save_and_load_session_agents() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    let agents = vec![
        SessionAgent {
            id: "a1".into(),
            subagent_run_id: "run-1".into(),
            parent_session_id: "s1".into(),
            parent_run_id: "prun-1".into(),
            parent_tool_call_id: Some("tc-1".into()),
            description: "explore".into(),
            mode: "explore".into(),
            status: "completed".into(),
            summary: Some("done".into()),
            messages: vec![sample_message("am1", "assistant", 1)],
            started_at: 100,
            ended_at: Some(200),
            depth: Some(0),
            subagent_path_json: Some(r#"["a1"]"#.into()),
            task_type: Some("analysis".into()),
            display_label: Some("Rust 内核分析师".into()),
            allowed_write_paths_json: Some(r#"["docs/notes"]"#.into()),
            sub_session_id: Some("sub-sess-0-1".into()),
        },
        SessionAgent {
            id: "a2".into(),
            subagent_run_id: "run-2".into(),
            parent_session_id: "s1".into(),
            parent_run_id: "prun-2".into(),
            parent_tool_call_id: None,
            description: "implement".into(),
            mode: "implement".into(),
            status: "running".into(),
            summary: None,
            messages: vec![],
            started_at: 300,
            ended_at: None,
            depth: Some(1),
            subagent_path_json: None,
            task_type: Some("implementation".into()),
            display_label: None,
            allowed_write_paths_json: None,
            sub_session_id: None,
        },
    ];
    db.save_session_agents("s1", &agents).unwrap();

    let loaded = db.load_session_agents("s1").unwrap();
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].id, "a1");
    assert_eq!(loaded[0].messages.len(), 1);
    assert_eq!(loaded[0].summary.as_deref(), Some("done"));
    assert_eq!(loaded[1].id, "a2");
    assert!(loaded[1].messages.is_empty());
    // T-D-07 v6 新列读写（display_label 读回 + task_type / 写路径白名单）
    assert_eq!(loaded[0].task_type.as_deref(), Some("analysis"));
    assert_eq!(loaded[0].display_label.as_deref(), Some("Rust 内核分析师"));
    assert_eq!(
        loaded[0].allowed_write_paths_json.as_deref(),
        Some(r#"["docs/notes"]"#)
    );
    assert_eq!(loaded[1].task_type.as_deref(), Some("implementation"));
    assert_eq!(loaded[1].display_label, None, "未声明的列为 None");
    assert_eq!(loaded[1].allowed_write_paths_json, None);
    // D-02 LK-04 v9 列读写（sub_session_id 读回；未声明 = None）
    assert_eq!(
        loaded[0].sub_session_id.as_deref(),
        Some("sub-sess-0-1"),
        "sub_session_id 随行读回"
    );
    assert_eq!(loaded[1].sub_session_id, None, "未声明子会话映射 = None");
}

// ===== 全局恢复排他租约（04 详案 §6.2：session_meta 键，零 DDL） =====

#[test]
fn recovery_lease_acquire_exclusive_renew_release_flow() {
    let db = LocalDb::open_in_memory().unwrap();

    // 首次抢占成功
    assert!(db.try_acquire_recovery_lease("proc-a", None).unwrap());
    // 他人未过期抢占被拒
    assert!(!db.try_acquire_recovery_lease("proc-b", None).unwrap());
    // 同一实例未过期重抢也被拒（须走 renew）
    assert!(!db.try_acquire_recovery_lease("proc-a", None).unwrap());

    // 持有者可续期；他人续期被拒
    assert!(db.renew_recovery_lease("proc-a", None).unwrap());
    assert!(!db.renew_recovery_lease("proc-b", None).unwrap());

    // 他人释放失败；持有者释放成功；释放后可被他人抢占
    assert!(!db.release_recovery_lease("proc-b").unwrap());
    assert!(db.release_recovery_lease("proc-a").unwrap());
    assert!(db.get_session_meta(RECOVERY_LEASE_KEY).unwrap().is_none());
    assert!(db.try_acquire_recovery_lease("proc-b", None).unwrap());
}

#[test]
fn recovery_lease_expired_can_be_taken_over() {
    let db = LocalDb::open_in_memory().unwrap();

    // 以极短 TTL 抢占，等待其过期
    assert!(db.try_acquire_recovery_lease("proc-a", Some(1)).unwrap());
    std::thread::sleep(std::time::Duration::from_millis(10));

    // 过期后他人可接管（Fail-Safe TTL 容灾）
    assert!(db.try_acquire_recovery_lease("proc-b", None).unwrap());
    // 过期租约上原持有者续期失败（已易主）
    assert!(!db.renew_recovery_lease("proc-a", None).unwrap());
    assert!(db.release_recovery_lease("proc-b").unwrap());
}

// ===== ADD-01：save_session_agents 增量 Upsert + 移除差集（禁级联抹白）=====

fn sample_agent(id: &str, status: &str, messages: Vec<SessionMessage>) -> SessionAgent {
    SessionAgent {
        id: id.into(),
        subagent_run_id: format!("run-{id}"),
        parent_session_id: "s1".into(),
        parent_run_id: format!("prun-{id}"),
        parent_tool_call_id: None,
        description: format!("desc-{id}"),
        mode: "explore".into(),
        status: status.into(),
        summary: None,
        messages,
        started_at: 100,
        ended_at: None,
        depth: Some(1),
        subagent_path_json: None,
        task_type: None,
        display_label: None,
        allowed_write_paths_json: None,
        sub_session_id: None,
    }
}

/// ADD-01 物证：save_session_agents 仅更新元数据（状态流转）后，
/// session_agent_messages 历史消息必须完整存活——零级联抹白。
#[test]
fn save_session_agents_metadata_update_preserves_messages() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    let mut a1 = sample_agent(
        "a1",
        "running",
        vec![
            sample_message("am1", "assistant", 1),
            sample_message("am2", "user", 2),
        ],
    );
    db.save_session_agents("s1", std::slice::from_ref(&a1))
        .unwrap();

    // 状态流转 running → completed（快照仍携带全部消息）
    a1.status = "completed".into();
    a1.ended_at = Some(300);
    db.save_session_agents("s1", &[a1]).unwrap();

    let rows = db.load_session_agents("s1").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, "completed");
    assert_eq!(rows[0].ended_at, Some(300));
    assert_eq!(
        rows[0].messages.len(),
        2,
        "状态更新后子代理历史消息必须存活（零级联抹白）"
    );
    assert_eq!(rows[0].messages[0].id, "am1");
    assert_eq!(rows[0].messages[1].id, "am2");
}

/// 消息 Upsert + 尾部收缩：短数组覆盖长数组时多余 seq 被清理，内容以载荷为准。
#[test]
fn save_session_agents_message_upsert_and_tail_shrink() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    let a1 = sample_agent(
        "a1",
        "running",
        vec![
            sample_message("am1", "assistant", 1),
            sample_message("am2", "assistant", 2),
            sample_message("am3", "assistant", 3),
        ],
    );
    db.save_session_agents("s1", std::slice::from_ref(&a1))
        .unwrap();

    // 缩短为 2 条 + 更新首条内容
    let mut shorter = a1.clone();
    shorter.messages = vec![
        {
            let mut m = sample_message("am1", "assistant", 1);
            m.text = Some("updated".into());
            m
        },
        sample_message("am2x", "user", 2),
    ];
    db.save_session_agents("s1", &[shorter]).unwrap();

    let rows = db.load_session_agents("s1").unwrap();
    assert_eq!(rows[0].messages.len(), 2, "尾部收缩清理多余 seq");
    assert_eq!(rows[0].messages[0].text.as_deref(), Some("updated"));
    assert_eq!(rows[0].messages[1].id, "am2x");
}

/// 移除差集：本次列表未包含的 agent 行被删除（级联仅作用于确要移除的行）；
/// 保留行的消息不受影响。
#[test]
fn save_session_agents_removal_diff_set() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    let a1 = sample_agent(
        "a1",
        "completed",
        vec![sample_message("am1", "assistant", 1)],
    );
    let a2 = sample_agent("a2", "running", vec![sample_message("bm1", "assistant", 1)]);
    db.save_session_agents("s1", &[a1.clone(), a2]).unwrap();
    assert_eq!(db.load_session_agents("s1").unwrap().len(), 2);

    // 仅保留 a1：a2 应被移除差集删除（其消息随之级联），a1 消息存活
    db.save_session_agents("s1", &[a1]).unwrap();
    let rows = db.load_session_agents("s1").unwrap();
    assert_eq!(rows.len(), 1, "未包含的 agent 行被移除");
    assert_eq!(rows[0].id, "a1");
    assert_eq!(rows[0].messages.len(), 1, "保留行消息不受差集影响");
}

/// 空列表 = 显式清空该会话全部子代理元数据（允许级联清消息）。
#[test]
fn save_session_agents_empty_list_clears_session() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.save_session_agents(
        "s1",
        &[sample_agent(
            "a1",
            "completed",
            vec![sample_message("am1", "assistant", 1)],
        )],
    )
    .unwrap();

    db.save_session_agents("s1", &[]).unwrap();
    assert!(
        db.load_session_agents("s1").unwrap().is_empty(),
        "空列表显式清空全部子代理"
    );
}

// ===== 导入路径 Upsert：冲突以载荷覆盖 + 差集（DEL-05 / DEL-05b）=====

/// 导入幂等 + 覆盖：重复导入时 session_messages / session_agents 以载荷
/// DO UPDATE，且载荷未包含的 agent 被移除差集删除（无全量 DELETE 毁窗）。
#[test]
fn import_agents_and_messages_upsert_with_removal_diff() {
    let (db, _guard) = open_temp_wal_db();

    let index = serde_json::json!([{
        "id": "s1",
        "title": "T",
        "updatedAt": 1,
        "messageCount": 1,
    }])
    .to_string();

    let agent_json = |ids: &[&str], msg_ids: &[&str]| -> String {
        let list: Vec<serde_json::Value> = ids
            .iter()
            .map(|id| {
                let msgs: Vec<serde_json::Value> = msg_ids
                    .iter()
                    .map(|mid| {
                        serde_json::json!({
                            "id": mid,
                            "sender": "assistant",
                            "text": format!("text-{mid}"),
                            "timestamp": 1,
                        })
                    })
                    .collect();
                serde_json::json!({
                    "id": id,
                    "subagentRunId": format!("run-{id}"),
                    "parentSessionId": "s1",
                    "parentRunId": format!("prun-{id}"),
                    "description": format!("desc-{id}"),
                    "mode": "explore",
                    "status": "completed",
                    "messages": msgs,
                    "startedAt": 0,
                })
            })
            .collect();
        serde_json::to_string(&list).unwrap()
    };

    // 首次导入：a1+a2，消息 am1/am2
    let body = serde_json::json!([
        {"id": "m1", "sender": "user", "text": "hi", "timestamp": 100},
        {"id": "m2", "sender": "assistant", "text": "hello", "timestamp": 200},
    ])
    .to_string();
    let mut bodies = HashMap::new();
    bodies.insert("s1".to_string(), body);
    let mut agents_map = HashMap::new();
    agents_map.insert("s1".to_string(), agent_json(&["a1", "a2"], &["am1", "am2"]));

    db.import_from_localstorage(&index, bodies.clone(), agents_map, None, &[])
        .unwrap();
    assert_eq!(db.load_session_agents("s1").unwrap().len(), 2);
    assert_eq!(db.load_session_body("s1").unwrap().len(), 2);

    // 二次导入：body 缩短为 1 条；agents 仅 a1 且消息缩为 1 条
    let body2 = serde_json::json!([
        {"id": "m1x", "sender": "user", "text": "hi2", "timestamp": 100},
    ])
    .to_string();
    let mut bodies2 = HashMap::new();
    bodies2.insert("s1".to_string(), body2);
    let mut agents_map2 = HashMap::new();
    agents_map2.insert("s1".to_string(), agent_json(&["a1"], &["am1x"]));

    db.import_from_localstorage(&index, bodies2, agents_map2, None, &[])
        .unwrap();

    // 消息：载荷覆盖 + 尾部收缩
    let body_loaded = db.load_session_body("s1").unwrap();
    assert_eq!(body_loaded.len(), 1);
    assert_eq!(body_loaded[0].id, "m1x");

    // agents：a2 被移除差集删除；a1 消息以载荷覆盖并收缩
    let agents_loaded = db.load_session_agents("s1").unwrap();
    assert_eq!(agents_loaded.len(), 1, "载荷未包含的 agent 被移除差集删除");
    assert_eq!(agents_loaded[0].id, "a1");
    assert_eq!(agents_loaded[0].messages.len(), 1);
    assert_eq!(agents_loaded[0].messages[0].id, "am1x");
}
