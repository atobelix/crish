use super::*;

/// 真实通道 wire 参数（mock 发送面）：addInitScript 源、DOMStorage.enable
/// 惰性一次、setDOMStorageItem/getDOMStorageItems 的 storageId
/// （securityOrigin + isLocalStorage=true）与 key/value。
#[tokio::test]
async fn session_channel_wire_params() {
    let mut mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    mock.set_auto_reply(
        "Page.addScriptToEvaluateOnNewDocument",
        MockReply::Ok(json!({ "identifier": "I1" })),
    );
    mock.set_auto_reply("DOMStorage.enable", MockReply::Ok(json!({})));
    mock.set_auto_reply("DOMStorage.setDOMStorageItem", MockReply::Ok(json!({})));
    mock.set_auto_reply(
        "DOMStorage.getDOMStorageItems",
        MockReply::Ok(json!({ "entries": [["k", "v"]] })),
    );
    let session = Arc::new(
        crate::BrowserSession::connect(
            CdpEndpoint {
                port: mock.addr.port(),
                ws_path: "/devtools/browser/storage-state".to_string(),
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
                "targetInfo": { "targetId": "T1", "type": "page", "title": "A", "url": "https://example.com" },
                "waitingForDebugger": false,
            }),
            None,
        );
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    while session.current_session().is_err() {
        assert!(tokio::time::Instant::now() < deadline, "活动标签未就绪");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let channel = SessionLocalStorageChannel::for_active(session.clone()).expect("通道");

    // 注入面（单 origin 双条目，便于按序消费断言）
    let json = r#"{"cookies":[],"origins":[{"origin":"https://example.com","localStorage":[{"name":"theme","value":"dark"},{"name":"token","value":"abc"}]}]}"#;
    let plan = build_import_plan(&parse_storage_state(json).expect("解析"));
    inject_origin_scripts(&channel, &plan).await.expect("注入");
    let cmd = mock
        .expect_command("Page.addScriptToEvaluateOnNewDocument")
        .await;
    assert_eq!(cmd["sessionId"], "S1");
    assert!(
        cmd["params"]["source"]
            .as_str()
            .unwrap()
            .contains("window.location.origin"),
        "脚本须含 origin 守卫"
    );
    let cmd = mock.expect_command("DOMStorage.enable").await;
    assert_eq!(cmd["sessionId"], "S1");
    let cmd = mock.expect_command("DOMStorage.setDOMStorageItem").await;
    assert_eq!(
        cmd["params"]["storageId"]["securityOrigin"],
        "https://example.com"
    );
    assert_eq!(cmd["params"]["storageId"]["isLocalStorage"], true);
    assert_eq!(cmd["params"]["key"], "theme");
    assert_eq!(cmd["params"]["value"], "dark");
    let cmd = mock.expect_command("DOMStorage.setDOMStorageItem").await;
    assert_eq!(cmd["params"]["key"], "token");

    // 读取面
    let origins = collect_local_storage(&channel, &["https://example.com".to_string()])
        .await
        .expect("读取");
    assert_eq!(origins[0].local_storage[0].name, "k");
    let cmd = mock.expect_command("DOMStorage.getDOMStorageItems").await;
    assert_eq!(
        cmd["params"]["storageId"]["securityOrigin"],
        "https://example.com"
    );
    assert_eq!(cmd["params"]["storageId"]["isLocalStorage"], true);

    // enable 惰性一次：全部预期命令已消费，队列无残留（不得重复 enable）
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), mock.next_command(),)
            .await
            .is_err(),
        "命令队列应已消费完毕（DOMStorage.enable 惰性一次）"
    );
    session.shutdown().await;
}

/// 放行策略钩子（会话面集成测试用，与 ops.rs 测试同源）。
struct AllowHooks;

#[async_trait::async_trait]
impl crate::cdp::sender::CommandPolicyHooks for AllowHooks {
    async fn idempotent(
        &self,
        _key: &crate::cdp::sender::IdKey,
    ) -> Option<Result<serde_json::Value, crate::cdp::error::CdpError>> {
        None
    }
    async fn approve(
        &self,
        _cmd: &crate::cdp::sender::CdpCommandView,
    ) -> Result<(), crate::cdp::sender::ApprovalDenied> {
        Ok(())
    }
    fn audit(&self, _event: crate::cdp::sender::BrowserAuditEvent) {}
    fn emergency_stop(&self) -> Arc<std::sync::atomic::AtomicBool> {
        Arc::new(std::sync::atomic::AtomicBool::new(false))
    }
    fn abort_token(&self) -> crate::cdp::sender::CancellationToken {
        crate::cdp::sender::CancellationToken::new()
    }
}

/// 会话恢复所需 mock 自动应答全表（与 ops.rs 测试同源）。
fn restore_reply_map() -> Vec<(&'static str, MockReply)> {
    vec![
        (
            "Browser.getVersion",
            MockReply::Ok(json!({
                "protocolVersion": "1.3",
                "product": "Chrome/151.0.7922.72",
                "revision": "@abc",
                "userAgent": "ua",
                "jsVersion": "13.1.71"
            })),
        ),
        ("Target.setDiscoverTargets", MockReply::Ok(json!({}))),
        (
            "Target.getTargets",
            MockReply::Ok(json!({
                "targetInfos": [
                    { "targetId": "T1", "type": "page", "title": "A", "url": "https://a.example" }
                ]
            })),
        ),
        (
            "Target.attachToTarget",
            MockReply::Ok(json!({ "sessionId": "S1" })),
        ),
        ("Page.enable", MockReply::Ok(json!({}))),
        ("Page.setLifecycleEventsEnabled", MockReply::Ok(json!({}))),
        ("Runtime.enable", MockReply::Ok(json!({}))),
        ("DOM.enable", MockReply::Ok(json!({}))),
        ("Network.enable", MockReply::Ok(json!({}))),
        ("Runtime.runIfWaitingForDebugger", MockReply::Ok(json!({}))),
        (
            "Runtime.evaluate",
            MockReply::Ok(json!({ "result": { "value": 1 } })),
        ),
        ("Page.setWindowOpenHandler", MockReply::Ok(json!({}))),
    ]
}
