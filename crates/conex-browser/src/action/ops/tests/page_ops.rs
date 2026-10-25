//! BrowserPageOps 与 BrowserSnapshotStore 测试。

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::{collector_reply_map, restore_reply_map, AllowHooks};
use crate::action::ops::page_ops::BrowserPageOps;
use crate::action::ops::snapshot_store::{session_for_active, BrowserSnapshotStore};
use crate::action::ops::traits::PageOps;
use crate::action::SnapshotStore;
use crate::cdp::mock::{MockReply, MockServer};
use crate::cdp::transport::CdpEndpoint;

/// P1 多标签：`with_session` 绑定具体标签会话——全部 CDP 命令固定路由到
/// 绑定会话，活动标签切换不影响绑定路由（per-tab 动作隔离）。
#[tokio::test]
async fn browser_page_ops_bound_session_routes_commands() {
    let mut mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    let session = Arc::new(
        crate::BrowserSession::connect(
            CdpEndpoint {
                port: mock.addr.port(),
                ws_path: "/devtools/browser/ops-bound".to_string(),
            },
            crate::cdp::transport::ExpectedBrowser::default(),
            Arc::new(AllowHooks),
        )
        .await
        .expect("会话建连失败"),
    );
    // 注入双标签附着（T1/S1、T2/S2），活动标签为最后附着者 T2
    for (target_id, sess) in [("T1", "S1"), ("T2", "S2")] {
        mock.send_event(
            "Target.attachedToTarget",
            json!({
                "sessionId": sess,
                "targetInfo": { "targetId": target_id, "type": "page", "title": "", "url": "about:blank" },
                "waitingForDebugger": false,
            }),
            None,
        );
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while session.tab_session("T1").is_none() || session.tab_session("T2").is_none() {
        assert!(tokio::time::Instant::now() < deadline, "双标签路由未就绪");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    mock.set_auto_reply(
        "Page.getNavigationHistory",
        MockReply::Ok(json!({
            "entries": [ { "id": 1, "url": "https://b.example/", "title": "B" } ],
            "currentIndex": 0
        })),
    );
    // 绑定 T2 会话（S2）：命令必须路由到 S2
    let ops = BrowserPageOps::new(session.clone()).with_session("S2".to_string());
    let url = ops.current_url().await.expect("绑定会话命令应成功");
    assert_eq!(url, "https://b.example/");
    let cmd = mock.expect_command("Page.getNavigationHistory").await;
    assert_eq!(cmd["sessionId"], "S2", "绑定会话路由必须命中 S2");

    // 活动标签切到 T1：绑定路由不受影响（仍走 S2）
    session.activate_tab("T1").expect("切换活动标签");
    let url2 = ops.current_url().await.expect("绑定会话命令应成功");
    assert_eq!(url2, "https://b.example/");
    let cmd2 = mock.expect_command("Page.getNavigationHistory").await;
    assert_eq!(cmd2["sessionId"], "S2", "活动标签切换不得影响绑定路由");

    // 未绑定的 ops 走活动标签（向后兼容兜底）
    let fallback = BrowserPageOps::new(session.clone());
    let _ = fallback
        .current_url()
        .await
        .expect("活动标签兜底命令应成功");
    let cmd3 = mock.expect_command("Page.getNavigationHistory").await;
    assert_eq!(cmd3["sessionId"], "S1", "未绑定 ops 走活动标签会话");
}

/// 回归（联调 E3 根因）：`take_snapshot` 提交的快照必须能被
/// `element_by_index` 命中——存储持单一 SnapshotManager（每次调用新建
/// manager 会让重快照后的索引解析永远落空，旧实现 mock 面未暴露）。
#[tokio::test]
async fn browser_snapshot_store_take_then_resolve() {
    let mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    for (method, reply) in collector_reply_map() {
        mock.set_auto_reply(method, reply);
    }

    let session = Arc::new(
        crate::BrowserSession::connect(
            CdpEndpoint {
                port: mock.addr.port(),
                ws_path: "/devtools/browser/store-test".to_string(),
            },
            crate::cdp::transport::ExpectedBrowser::default(),
            Arc::new(AllowHooks),
        )
        .await
        .expect("会话建连失败"),
    );
    // 注入活动标签（SessionAttached）
    mock.send_event(
        "Target.attachedToTarget",
        json!({
            "sessionId": "S1",
            "targetInfo": { "targetId": "T1", "type": "page", "title": "A", "url": "https://a.example" },
            "waitingForDebugger": false,
        }),
        None,
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(cur) = session.current_session() {
            assert_eq!(cur.target_id, "T1");
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "活动标签未就绪");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let store = BrowserSnapshotStore::new(
        session.clone(),
        session_for_active(session.clone()),
        crate::snapshot::BudgetConfig::active(),
    );
    let version = store
        .take_snapshot(&"T1".to_string())
        .await
        .expect("重快照失败");
    let meta = store
        .element_by_index(&"T1".to_string(), version, 1)
        .expect("take_snapshot 提交的快照应可被索引解析（共享缓存回归）");
    assert_eq!(meta.backend_node_id, 1, "input(backend=1) 索引解析");
    // M2：type=password 输入必须携带 is_password 标记（redact 同源判定）
    assert!(meta.is_password, "type=password 输入必须标记为密码输入目标");
    let btn = store
        .element_by_index(&"T1".to_string(), version, 6)
        .expect("按钮索引解析");
    assert_eq!(btn.backend_node_id, 6);
    assert!(!btn.is_password, "普通按钮不得误标为密码输入");
}
