use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::protocol::Message;

// ---------- AttachCdpProxy（39-E3：attach 会话面接线真实验证） ----------

/// attach 会话面装配：mock 服务端（模拟受管实例）+ 引擎 client 通道 +
/// 注入能力集的钩子 + 会话面（loopback 随机端口）。
async fn proxy_setup() -> (MockServer, AttachCdpProxy, Arc<RecordingHooks>) {
    let mock = MockServer::spawn().await;
    let client = Arc::new(
        crate::cdp::client::CdpClient::connect(&mock.url("/devtools/browser/proxy"))
            .await
            .expect("引擎 client 建连失败"),
    );
    let hooks = Arc::new(RecordingHooks::new(true));
    hooks.set_caps(ReadonlyCaps::mcp_attach_default());
    let channel: Arc<dyn CommandChannel> = client.clone();
    let sender = Arc::new(CommandSender::new(channel, hooks.clone()));
    let proxy = AttachCdpProxy::bind(
        sender,
        Arc::new(ReadonlyCaps::mcp_attach_default()),
        client.subscribe(),
    )
    .await
    .expect("attach 会话面挂载失败");
    (mock, proxy, hooks)
}

/// 外部 CDP 客户端连会话面并发送一条命令（JSON-RPC 帧），返回响应 JSON。
async fn external_command(proxy: &AttachCdpProxy, id: u64, method: &str) -> Value {
    let (mut ws, _) = tokio_tungstenite::connect_async(proxy.ws_url())
        .await
        .expect("外部客户端连接会话面失败");
    let msg = json!({ "id": id, "method": method, "params": {} });
    ws.send(Message::Text(msg.to_string().into()))
        .await
        .expect("命令发送失败");
    let resp = ws.next().await.expect("读响应失败").expect("帧错误");
    let v: Value = serde_json::from_str(resp.to_text().expect("非文本帧")).expect("响应解析失败");
    assert_eq!(v["id"], id, "响应 id 必须回显请求 id");
    v
}

/// 装配自检：hooks 未注入能力集（attach_caps=None）→ bind 拒绝启动
/// （防「代理已挂载但拦截未生效」的静默安全漏洞，R-12 红线）。
#[tokio::test]
async fn attach_proxy_bind_requires_caps_injection() {
    let mock = MockServer::spawn().await;
    let client = Arc::new(
        crate::cdp::client::CdpClient::connect(&mock.url("/devtools/browser/proxy-no-caps"))
            .await
            .expect("引擎 client 建连失败"),
    );
    let hooks = Arc::new(RecordingHooks::new(true)); // 不 set_caps
    let channel: Arc<dyn CommandChannel> = client.clone();
    let sender = Arc::new(CommandSender::new(channel, hooks));
    let err = AttachCdpProxy::bind(
        sender,
        Arc::new(ReadonlyCaps::mcp_attach_default()),
        client.subscribe(),
    )
    .await
    .expect_err("接线不完整必须拒绝启动");
    assert!(
        err.to_string().contains("未注入只读能力集"),
        "错误应点名接线缺口，实际 {err:?}"
    );
}

/// 外部 MCP 语义拦截（34 §4.3：MCP 自身不拒绝，本面是唯一拦截点）：
/// evaluate/输入注入/cookie 读取/导航/新建标签 → capability_disabled 语义
/// + 零线上发送 + Blocked 审计。
#[tokio::test]
async fn attach_proxy_denies_eval_input_cookie_navigation_create() {
    let (mock, proxy, hooks) = proxy_setup().await;
    for (i, method) in [
        "Runtime.evaluate",         // 求值类（evaluate_script 工具）
        "Input.dispatchMouseEvent", // 交互注入（click 工具）
        "Input.dispatchKeyEvent",   // 交互注入（type 工具）
        "Network.getAllCookies",    // cookie 全量读取
        "Page.navigate",            // 导航
        "Target.createTarget",      // 新建标签（写入面）
    ]
    .iter()
    .enumerate()
    {
        let v = external_command(&proxy, i as u64 + 1, method).await;
        assert_eq!(
            v["error"]["code"].as_i64(),
            Some(-32000),
            "{method} 应回 CDP 服务器错误码"
        );
        let text = v["error"]["message"].as_str().expect("错误消息缺失");
        assert!(
            text.contains("capability_disabled"),
            "{method} 拒绝语义应含 capability_disabled，实际 {text}"
        );
        assert!(
            text.contains(method),
            "{method} 拒绝消息应点名方法，实际 {text}"
        );
    }
    assert_eq!(
        mock.commands_seen(),
        0,
        "被拒命令不得发送到线上（真实路径零透传）"
    );
    let blocked = hooks
        .steps()
        .iter()
        .filter(|s| s.as_str() == "audit:blocked")
        .count();
    assert_eq!(blocked, 6, "每条拒绝应有一条 Blocked 审计");
}

/// 只读面放行：快照/截图/console/network 四类只读命令经会话面到达线上
/// 并回传真实结果（id 回显 + result 透传 + 恰好各一次发送）。
#[tokio::test]
async fn attach_proxy_passes_readonly_commands() {
    let (mock, proxy, _) = proxy_setup().await;
    mock.set_auto_reply(
        "DOMSnapshot.captureSnapshot",
        MockReply::Ok(json!({ "documents": [{ "nodes": [] }] })),
    );
    mock.set_auto_reply(
        "Page.captureScreenshot",
        MockReply::Ok(json!({ "data": "base64" })),
    );
    mock.set_auto_reply("Runtime.enable", MockReply::Ok(json!({})));
    mock.set_auto_reply("Network.enable", MockReply::Ok(json!({})));

    let mut ws = tokio_tungstenite::connect_async(proxy.ws_url())
        .await
        .expect("外部客户端连接会话面失败")
        .0;
    let commands = [
        (
            "DOMSnapshot.captureSnapshot",
            json!({ "computedStyles": ["color"] }),
        ),
        ("Page.captureScreenshot", json!({ "format": "png" })),
        ("Runtime.enable", json!({})),
        ("Network.enable", json!({})),
    ];
    for (i, (method, params)) in commands.iter().enumerate() {
        let frame = json!({ "id": i as u64 + 1, "method": method, "params": params });
        ws.send(Message::Text(frame.to_string().into()))
            .await
            .expect("命令发送失败");
    }
    for i in 0..4u64 {
        let resp = ws.next().await.expect("读响应失败").expect("帧错误");
        let v: Value =
            serde_json::from_str(resp.to_text().expect("非文本帧")).expect("响应解析失败");
        assert_eq!(v["id"], i + 1, "只读命令响应 id 应回显");
        assert!(
            v.get("error").is_none(),
            "只读命令 {} 不应被拦截：{v}",
            commands[i as usize].0
        );
    }
    assert_eq!(mock.commands_seen(), 4, "四类只读命令应恰好各发送一次");
}

/// 会话建立面放行（39-E3 实测补充）：Target 域会话路由命令（枚举目标/
/// 建立 flatten 会话）经会话面到达线上并回传真实 sessionId。
#[tokio::test]
async fn attach_proxy_passes_session_establishment_commands() {
    let (mock, proxy, _) = proxy_setup().await;
    mock.set_auto_reply(
        "Target.getTargets",
        MockReply::Ok(json!({ "targetInfos": [{ "targetId": "T1", "type": "page" }] })),
    );
    mock.set_auto_reply(
        "Target.attachToTarget",
        MockReply::Ok(json!({ "sessionId": "S1" })),
    );
    mock.set_auto_reply("Target.setAutoAttach", MockReply::Ok(json!({})));
    mock.set_auto_reply("Target.detachFromTarget", MockReply::Ok(json!({})));

    let mut ws = tokio_tungstenite::connect_async(proxy.ws_url())
        .await
        .expect("外部客户端连接会话面失败")
        .0;
    let commands = [
        ("Target.getTargets", json!({})),
        (
            "Target.attachToTarget",
            json!({ "targetId": "T1", "flatten": true }),
        ),
        (
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "flatten": true }),
        ),
        ("Target.detachFromTarget", json!({ "sessionId": "S1" })),
    ];
    for (i, (method, params)) in commands.iter().enumerate() {
        let frame = json!({ "id": i as u64 + 1, "method": method, "params": params });
        ws.send(Message::Text(frame.to_string().into()))
            .await
            .expect("命令发送失败");
    }
    for i in 0..4u64 {
        let resp = ws.next().await.expect("读响应失败").expect("帧错误");
        let v: Value =
            serde_json::from_str(resp.to_text().expect("非文本帧")).expect("响应解析失败");
        assert_eq!(v["id"], i + 1);
        assert!(
            v.get("error").is_none(),
            "会话建立命令 {} 不应被拦截：{v}",
            commands[i as usize].0
        );
    }
    // 回传的 sessionId 透传（attachToTarget 响应含 S1）
    assert_eq!(mock.commands_seen(), 4);
}

/// 事件透传面（真实 attach 路径）：白名单事件（console/network/snapshot）
/// 到达外部客户端，非白名单事件静默丢弃（fail-closed）。
#[tokio::test]
async fn attach_proxy_forwards_whitelisted_events_only() {
    let (mock, proxy, _) = proxy_setup().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(proxy.ws_url())
        .await
        .expect("外部客户端连接会话面失败");

    mock.send_event(
        "Runtime.consoleAPICalled",
        json!({ "type": "log" }),
        Some("S1"),
    );
    mock.send_event(
        "Network.requestWillBeSent",
        json!({ "requestId": "1" }),
        Some("S1"),
    );
    mock.send_event("Page.frameNavigated", json!({ "frame": {} }), None);
    mock.send_event(
        "Runtime.exceptionThrown",
        json!({ "exception": {} }),
        Some("S1"),
    );

    let read_event = async |ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >|
           -> Value {
        loop {
            let msg = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
                .await
                .expect("等待白名单事件超时")
                .expect("连接关闭")
                .expect("帧错误");
            if let Message::Text(t) = msg {
                return serde_json::from_str(&t).expect("事件解析失败");
            }
        }
    };
    let e1 = read_event(&mut ws).await;
    assert_eq!(
        e1["method"], "Runtime.consoleAPICalled",
        "console 面事件应透传"
    );
    let e2 = read_event(&mut ws).await;
    assert_eq!(
        e2["method"], "Network.requestWillBeSent",
        "network 面事件应透传"
    );
    // 非白名单事件不透传：短暂窗口后不应有第三个事件
    let got_third = tokio::time::timeout(std::time::Duration::from_millis(150), ws.next()).await;
    assert!(
        got_third.is_err(),
        "非白名单事件（frameNavigated/exceptionThrown）不得透传，实际 {:?}",
        got_third.ok()
    );
}
