//! compaction_dispatch 测试（R2 整改：自源文件机械迁出，内容未改）

use super::*;
use crate::compaction::{DecisionCategory, PINNED_LEDGER_MESSAGE_ID};
use crate::steering::{RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions};
use agent_tools::registry::ToolRegistry;
use conex_types::message::{AgentMessageBlock, AgentMessageRole};

fn make_test_state() -> LoopState {
    let steering = SteeringCoordinator::new(
        vec![Box::new(RecoverySteeringStrategy::default())],
        SteeringCoordinatorOptions::default(),
    );
    LoopState::new(
        "sess-compaction-test",
        10,
        steering,
        SessionLoopOptions::default(),
        Arc::new(ToolRegistry::new()),
    )
}

#[test]
fn test_compaction_runtime_decision_ledger_and_invariance_accessors() {
    let mut state = make_test_state();
    assert!(state.compaction.decision_ledger().is_empty());

    let entry = crate::compaction::DecisionLedgerEntry {
        id: "dec-1".to_string(),
        category: DecisionCategory::SecurityBoundary,
        statement: "绝对禁止 In-Flight Hot-Swap".to_string(),
        created_at_turn: 1,
        source_message_id: None,
    };
    state.compaction.decision_ledger_mut().add_entry(entry);
    assert_eq!(state.compaction.decision_ledger().len(), 1);

    let guard = state.compaction.invariance_guard();
    assert!(guard.check_swap_permission().is_ok());
    guard.enter_run();
    assert!(guard.check_swap_permission().is_err());
    guard.exit_run();
    assert!(guard.check_swap_permission().is_ok());
}

#[tokio::test]
async fn test_apply_compaction_promotes_decisions_and_syncs_slot2_anchor() {
    let mut state = make_test_state();
    let sys_msg = Arc::new(AgentMessage {
        id: "sys-0".to_string(),
        role: AgentMessageRole::System,
        created_at: "2026-10-27T00:00:00Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "System prompt".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    });
    let history_msg = Arc::new(AgentMessage {
        id: "user-dec-msg".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-10-27T00:01:00Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "请记住这些原则：\nREDLINE: 绝对禁止 In-Flight Hot-Swap 击穿 KV Cache\nDECISION: 启用 Slot 2.2 不可变决策账本".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    });
    state.conversation = vec![sys_msg.clone(), history_msg.clone()];

    let plan = CompactionPlan {
        messages: vec![sys_msg.clone()],
        dropped_ids: vec!["user-dec-msg".to_string()],
        kept_ids: vec!["sys-0".to_string()],
        tokens_before: 2000,
        tokens_after: 500,
        first_kept_message_id: Some("sys-0".to_string()),
        summary: "Summary".to_string(),
        generation: 1,
        fold_index: 1,
        fold_chain_prev: 0,
        fold_chain_after: 1,
        summary_is_llm: false,
        llm_unavailable: false,
    };
    let info = CompactionTriggerInfo {
        trigger: ContextCompressionTrigger::Threshold,
        reason: ContextCompressionReason::Threshold,
    };

    apply_compaction(&mut state, &plan, &info, Some(1000)).await;

    // 验证 1：决策已成功从丢弃消息中提升沉淀至 Slot 2.2 账本
    assert_eq!(state.compaction.decision_ledger().len(), 2);
    let statements: Vec<&str> = state
        .compaction
        .decision_ledger()
        .entries()
        .iter()
        .map(|e| e.statement.as_str())
        .collect();
    assert!(statements
        .iter()
        .any(|s| s.contains("绝对禁止 In-Flight Hot-Swap")));
    assert!(statements
        .iter()
        .any(|s| s.contains("启用 Slot 2.2 不可变决策账本")));

    // 验证 2：Slot 2 锚点消息已成功注入 conversation 中（紧随 System 消息）
    assert_eq!(state.conversation[0].id, "sys-0");
    assert_eq!(state.conversation[1].id, PINNED_LEDGER_MESSAGE_ID);
    let block_text = match &state.conversation[1].blocks[0] {
        AgentMessageBlock::Text { text } => text.as_str(),
        _ => "",
    };
    assert!(block_text.contains("Slot 2.2"));
}

#[test]
fn test_pinned_decision_ledger_non_foldable_cross_generation_protection() {
    let mut dropped = vec![
        "msg-1".to_string(),
        PINNED_LEDGER_MESSAGE_ID.to_string(),
        "msg-2".to_string(),
    ];
    let mut kept = vec!["sys-0".to_string()];

    let protected = PinnedDecisionLedger::protect_from_dropped(&mut dropped, &mut kept);
    assert!(protected);
    assert_eq!(dropped, vec!["msg-1".to_string(), "msg-2".to_string()]);
    assert!(kept.contains(&PINNED_LEDGER_MESSAGE_ID.to_string()));
}
