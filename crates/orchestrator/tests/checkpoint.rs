//! C1 checkpoint 采集链路集成测试（M5A；04 §2 C1 验收面）
//!
//! 覆盖任务书（M5）验收要点：
//! - 行标记采集：对话中 `CHECKPOINT: {json}` 行 → payload 落库（经
//!   session-loop 安全点采集函数 + 会话树叶子 payload 读写）；
//! - 叶子 payload 读写：写入 / 读回 / 快照 serde 持久化；
//! - 优先恢复语义：有 checkpoint 的会话 → 检测信号（checkpoint-present）；
//! - 损坏降级：解析失败不 panic、返回降级标记（checkpoint-corrupt）；
//! - 无 checkpoint 回归：普通会话保持现状（Absent / None）。
//!
//! 本文件为采集端链路测试：恢复端注入（M5B）接线时在 restore.rs 侧
//! 消费同一批 API（read_leaf_checkpoint + signal）。

use conex_types::checkpoint::{
    CHECKPOINT_CORRUPT_SIGNAL, CHECKPOINT_PRESENT_SIGNAL, CheckpointPayload, LeafCheckpointState,
};
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use orchestrator::session::SessionTree;
use session_loop::safe_point::collect_checkpoint_from_messages;

fn assistant_msg(text: &str) -> AgentMessage {
    AgentMessage {
        id: format!("a-{text}"),
        role: AgentMessageRole::Assistant,
        created_at: "2026-01-01T00:00:00Z".into(),
        blocks: vec![AgentMessageBlock::Text { text: text.into() }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

fn sample_checkpoint(target: &str) -> CheckpointPayload {
    CheckpointPayload {
        target: target.into(),
        summary: "基座完成，检查点链路已打通".into(),
        timestamp: Some("2026-08-03T10:00:00.000Z".into()),
        completed: vec!["定义协议类型".into(), "实现行标记解析".into()],
        files: vec![
            "crates/conex-types/src/checkpoint.rs".into(),
            "crates/session-loop/src/safe_point.rs".into(),
        ],
        next: vec!["接线恢复注入".into()],
    }
}

/// 行标记采集 → 落库 → 读回：对话中 CHECKPOINT 行产出检查点，
/// 写入会话树叶子 payload 后可完整读回（含目标/摘要/时间戳/步骤）
#[test]
fn checkpoint_line_marker_collects_into_leaf_payload() {
    let checkpoint = sample_checkpoint("实现检查点采集");
    let marker = format!("已完成大半。\nCHECKPOINT: {}\n继续收尾。", {
        serde_json::to_string(&checkpoint).expect("检查点载荷可序列化")
    });
    let messages = vec![
        assistant_msg("先做基础工作，暂无检查点。"),
        assistant_msg(&marker),
    ];

    let collected = collect_checkpoint_from_messages(&messages)
        .expect("采集不应报错")
        .expect("应采集到检查点");
    assert_eq!(collected.target, "实现检查点采集");
    assert_eq!(collected.completed.len(), 2, "已完成步骤落库");
    assert_eq!(collected.files.len(), 2, "文件清单落库");
    assert_eq!(collected.next.len(), 1, "下一步落库");

    // 落库：写入会话树叶子 payload → 读回与采集结果一致
    let mut tree = SessionTree::new("s1");
    tree.append("leaf1", serde_json::json!({ "text": "运行记录" }))
        .unwrap();
    tree.set_leaf_checkpoint("leaf1", &collected).unwrap();
    match tree.read_leaf_checkpoint(Some("leaf1")) {
        LeafCheckpointState::Present(back) => assert_eq!(back, collected),
        other => panic!("应读回有效检查点：{other:?}"),
    }
    // payload 其它字段不被触碰
    let payload = match &tree.entry("leaf1").expect("叶子存在").kind {
        orchestrator::session::SessionTreeEntryKind::Node { payload } => payload,
        other => panic!("应为节点条目：{other:?}"),
    };
    assert_eq!(payload["text"], "运行记录");
}

/// 优先恢复语义：有 checkpoint 的会话 → 检测信号 checkpoint-present；
/// run 初始化检测读取当前叶子即命中
#[test]
fn session_with_checkpoint_marks_preferred_resume() {
    let checkpoint = sample_checkpoint("续跑目标");
    let mut tree = SessionTree::new("s1");
    tree.append("leaf1", serde_json::json!({})).unwrap();
    tree.set_leaf_checkpoint("leaf1", &checkpoint).unwrap();
    tree.move_leaf(Some("leaf1"), None).unwrap();

    let state = tree.read_leaf_checkpoint(None);
    assert!(state.is_present(), "当前叶子有检查点");
    assert_eq!(state.signal(), Some(CHECKPOINT_PRESENT_SIGNAL));
    match state {
        LeafCheckpointState::Present(payload) => assert_eq!(payload.target, "续跑目标"),
        other => panic!("应有效：{other:?}"),
    }
}

/// 损坏降级：叶子 payload 检查点损坏 → Corrupt + checkpoint-corrupt 信号，
/// 不 panic；采集端损坏标记行 → Err（降级信号）
#[test]
fn corrupt_checkpoint_degrades_without_panic() {
    // 叶子侧损坏（值类型错误）
    let mut tree = SessionTree::new("s1");
    tree.append("leaf1", serde_json::json!({ "checkpoint": { "target": 123 } }))
        .unwrap();
    let state = tree.read_leaf_checkpoint(Some("leaf1"));
    match &state {
        LeafCheckpointState::Corrupt(reason) => {
            assert!(reason.contains("解析失败"), "降级原因可读：{reason}")
        }
        other => panic!("应降级为 Corrupt：{other:?}"),
    }
    assert_eq!(state.signal(), Some(CHECKPOINT_CORRUPT_SIGNAL));
    assert!(!state.is_present());

    // 采集侧损坏（标记行 JSON 损坏）→ Err，不 panic
    let messages = vec![assistant_msg("CHECKPOINT: {broken json")];
    let err = collect_checkpoint_from_messages(&messages).unwrap_err();
    assert_eq!(err.kind, "checkpoint.parse_failed");
}

/// 无 checkpoint 回归：普通会话叶子 → Absent、无检测信号（现状）；
/// 无标记对话采集 → Ok(None)
#[test]
fn no_checkpoint_keeps_current_behavior() {
    let mut tree = SessionTree::new("s1");
    tree.append("leaf1", serde_json::json!({ "text": "普通会话" }))
        .unwrap();
    assert_eq!(tree.read_leaf_checkpoint(Some("leaf1")), LeafCheckpointState::Absent);
    assert_eq!(tree.read_leaf_checkpoint(None).signal(), None);

    let messages = vec![
        assistant_msg("完成了第一步，不需要检查点。"),
        assistant_msg("全部完成。"),
    ];
    assert_eq!(collect_checkpoint_from_messages(&messages).unwrap(), None);
}

/// checkpoint 内容不含 system 消息：仅 system 含标记 → 采集 None；
/// 对话采集只取助手/工具输出中的标记
#[test]
fn checkpoint_content_never_comes_from_system_messages() {
    let checkpoint = sample_checkpoint("系统注入");
    let marker = serde_json::to_string(&checkpoint).unwrap();
    let system = AgentMessage {
        id: "sys-1".into(),
        role: AgentMessageRole::System,
        created_at: "2026-01-01T00:00:00Z".into(),
        blocks: vec![AgentMessageBlock::Text {
            text: format!("CHECKPOINT: {marker}"),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    };
    assert_eq!(
        collect_checkpoint_from_messages(&[system]).unwrap(),
        None,
        "system 消息永不进入检查点内容"
    );
}
