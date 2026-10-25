//! 隔离世界创建与只读代理注入测试。

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::{restore_reply_map, AllowHooks};
use crate::action::ops::isolated_world::{CRISH_READ_INJECTION, ISOLATED_WORLD_NAME};
use crate::action::ops::page_ops::BrowserPageOps;
use crate::action::ops::traits::PageOps;
use crate::action::ActionErrorKind;
use crate::cdp::mock::{MockReply, MockServer};
use crate::cdp::transport::CdpEndpoint;

/// 缺陷 B 注入脚本契约（17 §3.1）：6 个白名单方法必须与词法层 READ_API
/// 同步（api 字面量 `attr: attr` 形态逐个断言，防缺方法/改名漂移）；
/// 只读/深拷贝/constructor 链拦截语义存在（代理面运行时保险）。
#[test]
fn injection_script_covers_read_api_and_readonly() {
    for method in crate::action::evaluate::READ_API {
        assert!(
            CRISH_READ_INJECTION.contains(&format!("{method}: {method}")),
            "注入脚本应暴露白名单方法 {method}"
        );
    }
    assert!(
        CRISH_READ_INJECTION.contains("Object.defineProperty"),
        "应经 defineProperty 挂载"
    );
    assert!(
        CRISH_READ_INJECTION.contains("globalThis"),
        "应挂载世界全局"
    );
    assert!(
        CRISH_READ_INJECTION.contains("writable: false"),
        "代理应不可写"
    );
    assert!(
        CRISH_READ_INJECTION.contains("configurable: false"),
        "代理应不可配置"
    );
    assert!(
        CRISH_READ_INJECTION.contains("constructor"),
        "应含 constructor 链检查语义"
    );
    assert!(
        CRISH_READ_INJECTION.contains("__proto__"),
        "应含 __proto__ 检查语义"
    );
    assert!(
        CRISH_READ_INJECTION.contains("deepJSON"),
        "应含纯 JSON 深拷贝"
    );
    assert!(
        CRISH_READ_INJECTION.contains("is read-only"),
        "应含只读拒绝语义"
    );
}

/// 缺陷 A+B 回归（K7 e2e，Chrome 151）：建世界命令序列与参数——
/// Page.getFrameTree（取主 frame）→ Page.createIsolatedWorld（frameId +
/// worldName）→ 同一 world 的 Runtime.evaluate（注入 __crish_read 代理，
/// contextId 为 createIsolatedWorld 返回值）；命令顺序硬断言。
#[tokio::test]
async fn create_isolated_world_uses_page_domain_and_injects_proxy() {
    let mut mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    mock.set_auto_reply(
        "Page.getFrameTree",
        MockReply::Ok(json!({
            "frameTree": {
                "frame": { "id": "FRAME-MAIN", "url": "https://a.example", "mimeType": "text/html" },
                "childFrames": []
            }
        })),
    );
    mock.set_auto_reply(
        "Page.createIsolatedWorld",
        MockReply::Ok(json!({ "executionContextId": 42 })),
    );
    // 注入 evaluate 应答（带 type 字段；连接期探针 "1" 同享该应答）
    mock.set_auto_reply(
        "Runtime.evaluate",
        MockReply::Ok(json!({ "result": { "type": "boolean", "value": true } })),
    );
    let session = Arc::new(
        crate::BrowserSession::connect(
            CdpEndpoint {
                port: mock.addr.port(),
                ws_path: "/devtools/browser/isolated-world".to_string(),
            },
            crate::cdp::transport::ExpectedBrowser::default(),
            Arc::new(AllowHooks),
        )
        .await
        .expect("会话建连失败"),
    );
    // 注入活动标签（T1/S1），等待路由就绪
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
    while session.current_session().is_err() {
        assert!(tokio::time::Instant::now() < deadline, "活动标签未就绪");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let ops = BrowserPageOps::new(session.clone());
    let world = ops.create_isolated_world().await.expect("建世界失败");
    assert_eq!(
        world, "42",
        "应返回 createIsolatedWorld 的 executionContextId"
    );

    // 命令序列收集：仅关注建世界三连（跳过连接期其余命令；
    // 注入 evaluate 以表达式含 __crish_read 与连接期探针 "1" 区分）
    let mut seq: Vec<(String, Value)> = Vec::new();
    let collect = tokio::time::Instant::now() + Duration::from_secs(3);
    while seq.len() < 3 {
        assert!(
            tokio::time::Instant::now() < collect,
            "建世界命令序列未收齐：{seq:?}"
        );
        let cmd = tokio::time::timeout(Duration::from_millis(1000), mock.next_command())
            .await
            .expect("等待命令超时");
        let method = cmd["method"].as_str().unwrap_or("").to_string();
        let is_injection = method == "Runtime.evaluate"
            && cmd["params"]["expression"]
                .as_str()
                .is_some_and(|e| e.contains("__crish_read"));
        if matches!(
            method.as_str(),
            "Page.getFrameTree" | "Page.createIsolatedWorld"
        ) || is_injection
        {
            seq.push((method, cmd));
        }
    }

    // 顺序：getFrameTree → createIsolatedWorld → 注入 evaluate（缺陷 A/B 硬断言）
    assert_eq!(seq[0].0, "Page.getFrameTree", "应先取主 frame：{seq:?}");
    assert_eq!(
        seq[1].0, "Page.createIsolatedWorld",
        "再建隔离世界：{seq:?}"
    );
    assert_eq!(seq[2].0, "Runtime.evaluate", "建世界后注入代理：{seq:?}");
    // 建世界参数：Page 域 + frameId（主 frame）+ worldName 保留
    let create = &seq[1].1;
    assert_eq!(
        create["params"]["frameId"], "FRAME-MAIN",
        "frameId 应为主 frame"
    );
    assert_eq!(
        create["params"]["worldName"], ISOLATED_WORLD_NAME,
        "worldName 应保留"
    );
    // 注入参数：同一 world（contextId 与建世界返回值一致）
    let inject = &seq[2].1;
    assert_eq!(inject["params"]["contextId"], 42, "注入应在新建世界执行");
    assert_eq!(inject["params"]["userGesture"], false);
    assert_eq!(inject["params"]["returnByValue"], true);
    assert_eq!(inject["params"]["timeout"], 2000);
    // 注入脚本本体断言（代理定义存在性）
    let expr = inject["params"]["expression"]
        .as_str()
        .expect("注入表达式缺失");
    assert!(expr.contains("__crish_read"), "注入脚本应定义 __crish_read");
    assert!(expr.contains("attr"), "注入脚本应含 attr 方法");
    assert!(expr.contains("rect"), "注入脚本应含 rect 方法");
}

/// 缺陷 A 错误映射保持：Page.createIsolatedWorld 失败 → Unsupported
/// （dispatch 层映射「隔离世界创建失败」；不重试类，与旧 Runtime 域语义一致）。
#[tokio::test]
async fn create_isolated_world_page_domain_error_maps_unsupported() {
    let mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    mock.set_auto_reply(
        "Page.getFrameTree",
        MockReply::Ok(json!({
            "frameTree": {
                "frame": { "id": "FRAME-MAIN", "url": "https://a.example", "mimeType": "text/html" },
                "childFrames": []
            }
        })),
    );
    mock.set_auto_reply(
        "Page.createIsolatedWorld",
        MockReply::Error {
            code: -32601,
            message: "Method not found".to_string(),
        },
    );
    let session = Arc::new(
        crate::BrowserSession::connect(
            CdpEndpoint {
                port: mock.addr.port(),
                ws_path: "/devtools/browser/isolated-world-err".to_string(),
            },
            crate::cdp::transport::ExpectedBrowser::default(),
            Arc::new(AllowHooks),
        )
        .await
        .expect("会话建连失败"),
    );
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
    while session.current_session().is_err() {
        assert!(tokio::time::Instant::now() < deadline, "活动标签未就绪");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let ops = BrowserPageOps::new(session.clone());
    let err = ops.create_isolated_world().await.expect_err("应返回错误");
    assert_eq!(
        err.kind,
        ActionErrorKind::Unsupported,
        "建世界失败应归 Unsupported"
    );
    assert!(err.cdp_raw.is_some(), "应携带 CDP 错误原文");
}
