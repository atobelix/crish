//! EV-12 输入留痕集成测试（D-03 事件面 · 轮 4）
//!
//! 真实写者链路：AgentSessionLoop（session-loop 内核，注入
//! [session_loop::PendingInputStore] 适配）→ InMemoryStore（orchestrator
//! `Store` 面，persist.rs）：
//! - enqueue 写点：入队 → save_pending_input 落库（id=消息 id、
//!   run_id 正确、payload=消息 JSON，INSERT OR REPLACE 幂等）；
//! - 消费删点：run 消费消息成为 message-start（record_message）→
//!   delete_pending_input 行删除；
//! - 恢复衔接：恢复消费端 `load_pending_inputs`（restore_manager.rs:273
//!   RestoreManager 数据源）读回真实写者数据，FIFO 顺序（created_at
//!   升序 + id 决胜）保持——崩溃恢复 FIFO 语义在真实写者下续绿
//!   （全流程恢复测试见 crash_consistency.rs 既有用例）。

use std::sync::Arc;
use std::time::Duration;

use agent_tools::registry::ToolRegistry;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use orchestrator::persist::{InMemoryStore, Store};
use session_loop::testing::TestProvider;
use session_loop::{AgentSessionLoop, InputEnqueueMode, PendingInputStore};

/// 用户消息构造（id 显式给定，作为 pending 行 id）
fn user_msg(id: &str, text: &str) -> AgentMessage {
    AgentMessage {
        id: id.to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-08-14T00:00:00.000Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: text.to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

/// 装配带输入留痕注入的 loop（未注入 = 不落库，向后兼容）
fn loop_with_pending_store(
    store: Arc<InMemoryStore>,
) -> (AgentSessionLoop, Arc<InMemoryStore>) {
    let persist: Arc<dyn PendingInputStore> = store.clone();
    let loop_inst = AgentSessionLoop::new(
        "s1",
        "r1",
        16,
        Box::new(TestProvider::text_reply("好的")),
        Arc::new(ToolRegistry::new()),
    )
    .with_pending_input_store(persist);
    (loop_inst, store)
}

/// enqueue 写点：入队即落库（id / session_id / run_id / payload=消息 JSON）
#[tokio::test]
async fn enqueue_writes_pending_input_with_run_id() {
    let (mut loop_inst, store) = loop_with_pending_store(Arc::new(InMemoryStore::new()));
    loop_inst.enqueue_input(user_msg("m-1", "你好"), InputEnqueueMode::Force);
    // fire-and-forget 落库：等待 spawn 任务完成
    tokio::time::sleep(Duration::from_millis(30)).await;

    let rows = store.load_pending_inputs("s1").await.unwrap();
    assert_eq!(rows.len(), 1, "enqueue 写点必须落库一条");
    assert_eq!(rows[0].id, "m-1", "pending 行 id = 消息 id");
    assert_eq!(rows[0].session_id, "s1");
    assert_eq!(rows[0].run_id.as_deref(), Some("r1"), "run_id 正确性");
    assert!(rows[0].payload.contains("你好"), "payload = 消息 JSON 正文");
    assert!(rows[0].payload.contains("\"id\":\"m-1\""), "payload 含消息 id 字段");
    // 其它会话不命中
    let other = store.load_pending_inputs("s-other").await.unwrap();
    assert!(other.is_empty(), "会话隔离");
}

/// 消费删点：run 消费消息成为 message-start → pending 行删除
///（含 run 起始写点的消息：每条用户消息 1 INSERT + 1 DELETE）
#[tokio::test]
async fn consume_deletes_pending_input_row() {
    let (mut loop_inst, store) = loop_with_pending_store(Arc::new(InMemoryStore::new()));
    // enqueue 注入面写点（run 前）
    loop_inst.enqueue_input(user_msg("m-1", "第一问"), InputEnqueueMode::Force);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(store.load_pending_inputs("s1").await.unwrap().len(), 1);

    // run 起始写点（用户消息主路径）+ 消费删点（record_message）
    let _outcome = loop_inst.run(user_msg("m-2", "第二问")).await;
    tokio::time::sleep(Duration::from_millis(30)).await;

    let rows = store.load_pending_inputs("s1").await.unwrap();
    assert!(
        rows.is_empty(),
        "消费后 pending 行必须全部删除（含 enqueue 写点 m-1 与 run 写点 m-2）：{rows:?}"
    );
}

/// 恢复衔接：真实写者数据经 load_pending_inputs（恢复消费端数据源）读回，
/// FIFO 顺序（created_at 升序 + id 决胜）保持
#[tokio::test]
async fn restore_reads_written_pending_inputs_in_fifo_order() {
    let (mut loop_inst, store) = loop_with_pending_store(Arc::new(InMemoryStore::new()));
    // 三环各写一条（enqueue 单点统一落库）
    loop_inst.enqueue_input(user_msg("p1", "一"), InputEnqueueMode::Force);
    loop_inst.enqueue_input(user_msg("p2", "二"), InputEnqueueMode::Steer);
    loop_inst.enqueue_input(user_msg("p3", "三"), InputEnqueueMode::FollowUp);
    tokio::time::sleep(Duration::from_millis(30)).await;

    // 恢复消费端 = RestoreManager::restore 的 load_pending_inputs 数据源
    //（restore_manager.rs:273；全流程恢复测试见 crash_consistency.rs）
    let rows = store.load_pending_inputs("s1").await.unwrap();
    let ids: Vec<&str> = rows.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, vec!["p1", "p2", "p3"], "FIFO：创建时间升序 + id 决胜");
    assert_eq!(rows[0].run_id.as_deref(), Some("r1"));
    assert!(rows[0].payload.contains("一"));
}

/// 幂等语义：同 id 重复入队（INSERT OR REPLACE）不产生重复行
#[tokio::test]
async fn repeated_enqueue_is_idempotent_by_id() {
    let (mut loop_inst, store) = loop_with_pending_store(Arc::new(InMemoryStore::new()));
    loop_inst.enqueue_input(user_msg("dup", "v1"), InputEnqueueMode::Force);
    tokio::time::sleep(Duration::from_millis(30)).await;
    loop_inst.enqueue_input(user_msg("dup", "v2"), InputEnqueueMode::Force);
    tokio::time::sleep(Duration::from_millis(30)).await;

    let rows = store.load_pending_inputs("s1").await.unwrap();
    assert_eq!(rows.len(), 1, "同 id 覆盖不重复（INSERT OR REPLACE 幂等）");
    assert!(rows[0].payload.contains("v2"), "幂等覆盖后为最新载荷");
}
