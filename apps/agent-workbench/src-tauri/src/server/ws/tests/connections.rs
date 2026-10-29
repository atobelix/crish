//! WS 测试 · 连接管理 / 帧协议 / 注册表 / 推送直投（tests.rs 拆分）。

use super::super::*;
use super::support::*;

use crate::server::auth::sha256_hex;
use conex_types::device::version::MAX_FRAME_BYTES;
use std::time::Duration;

// ── 连接管理 ──────────────────────────────────────────────

#[tokio::test]
async fn duplicate_connection_kicks_old() {
    // P0-3 裁决：每设备一主连接，同令牌重复连接踢旧
    // （D2 §10.5：kicked duplicate-connection）
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    let mut old = ws_connect(addr, &token).await;
    // 确认旧连接已注册（避免升级回调未完成即建新连接的竞态）
    confirm_registered(&mut old).await;
    let mut new = ws_connect(addr, &token).await;
    // 旧连接收到 kicked（duplicate-connection）并关闭
    let (kind, body) = parse_frame(&next_text(&mut old).await.expect("旧连接必须被踢"));
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).unwrap();
    assert!(
        error.message.contains(KICK_DUPLICATE),
        "踢出原因必须携带 duplicate-connection：{}",
        error.message
    );
    // 新连接正常可用（心跳往返）
    confirm_registered(&mut new).await;
}

#[tokio::test]
async fn connection_limit_rejects_ninth() {
    // D2 §10.5：全局上限 MAX_WS_CONNECTIONS=8，超限拒绝新连接
    // （conn.limit 错误帧 + 关闭）
    let labels: Vec<String> = (0..9).map(|i| format!("dev-{i}")).collect();
    let label_refs: Vec<&str> = labels.iter().map(String::as_str).collect();
    let (addr, _handle, tokens, _registry) =
        spawn_server_with_tokens(None, None, &label_refs).await;
    // 占满 8 个连接（逐个确认注册完成）
    let mut sockets = Vec::new();
    for token in &tokens[..8] {
        let mut ws = ws_connect(addr, token).await;
        confirm_registered(&mut ws).await;
        sockets.push(ws);
    }
    // 第 9 个连接 → 拒绝（error conn.limit + 关闭）
    let mut ninth = ws_connect(addr, &tokens[8]).await;
    let (kind, body) = parse_frame(
        &next_text(&mut ninth)
            .await
            .expect("应收到 conn.limit 拒绝帧"),
    );
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).unwrap();
    assert!(
        error.message.contains(KICK_LIMIT),
        "拒绝原因必须携带 conn.limit：{}",
        error.message
    );
    // 旧连接不受影响
    confirm_registered(&mut sockets[0]).await;
}

#[tokio::test]
async fn kick_by_token_hash_revokes_connection() {
    // D2 §10.6：令牌撤销 → kicked token-revoked（R1-07 撤销全链接线点）
    let (addr, _handle, token, registry) = test_server(None, None).await;
    let mut ws = ws_connect(addr, &token).await;
    confirm_registered(&mut ws).await;
    let hash = sha256_hex(token.as_bytes());
    let kicked = registry.kick_by_token_hash(&hash, KICK_REVOKED);
    assert_eq!(kicked.len(), 1, "撤销必须命中在线连接");
    let (kind, body) = parse_frame(
        &next_text(&mut ws)
            .await
            .expect("应收到 token-revoked 踢出帧"),
    );
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).unwrap();
    assert_eq!(error.code, DeviceErrorCode::AuthDeviceRevoked);
    assert!(
        error.message.contains(KICK_REVOKED),
        "踢出原因必须携带 token-revoked：{}",
        error.message
    );
}

#[tokio::test]
async fn disconnect_unregisters_subscription() {
    // 断线清理：连接关闭 → 注册表注销 + fanout 订阅注销
    let fanout = test_fanout();
    let (addr, _handle, token, registry) = test_server(None, Some(fanout.clone())).await;
    let mut ws = ws_connect(addr, &token).await;
    confirm_registered(&mut ws).await;
    send_envelope_text(
        &mut ws,
        "events.subscribe",
        serde_json::json!({ "sessions": ["s-1"], "lastSequences": {} }),
    )
    .await;
    let _ = next_text(&mut ws).await;
    assert_eq!(registry.count(), 1, "连接必须已注册");
    assert_eq!(fanout.subscriber_count(), 1, "fanout 订阅必须已注册");
    // 客户端主动关闭
    let _ = ws.close(None).await;
    // 等服务端注销（sender task 收尾）
    for _ in 0..50 {
        if registry.count() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(registry.count(), 0, "关闭后连接必须注销");
    assert_eq!(fanout.subscriber_count(), 0, "关闭后 fanout 订阅必须注销");
}

// ── 帧协议 ────────────────────────────────────────────────

#[tokio::test]
async fn frame_too_large_closes_connection() {
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    let mut ws = ws_connect(addr, &token).await;
    // 超 1 MiB 帧（M6 §8.1：MAX_FRAME_BYTES 超限断链防内存放大）
    let big = "x".repeat(MAX_FRAME_BYTES + 1);
    let _ = ws
        .send(tokio_tungstenite::tungstenite::Message::Text(big.into()))
        .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.expect("应收到 frame_too_large 帧"));
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).unwrap();
    assert_eq!(error.code, DeviceErrorCode::FrameTooLarge);
}

#[tokio::test]
async fn unknown_kind_is_tolerated() {
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    let mut ws = ws_connect(addr, &token).await;
    // 未知 kind（D3 §10.3：丢弃 + 记日志，不报错）→ 连接保持
    send_envelope_text(&mut ws, "future.kind", serde_json::json!({})).await;
    confirm_registered(&mut ws).await;
}

#[tokio::test]
async fn version_mismatch_closes_connection() {
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    let mut ws = ws_connect(addr, &token).await;
    let envelope = DeviceEnvelope::unsigned(
        MessageKind::Heartbeat,
        format!("m-test-{:08}", 99),
        now_ms(),
        DeviceEndpoint::Mobile,
        DeviceEndpoint::Desktop,
        serde_json::json!({ "ts": now_ms(), "deviceTimeMs": now_ms() }),
    );
    // 手工改版本号
    let mut value = serde_json::to_value(&envelope).unwrap();
    value["v"] = serde_json::json!(99);
    let _ = ws
        .send(tokio_tungstenite::tungstenite::Message::Text(
            value.to_string().into(),
        ))
        .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.expect("应收到 version_mismatch"));
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).unwrap();
    assert_eq!(error.code, DeviceErrorCode::VersionMismatch);
}

#[tokio::test]
async fn malformed_frame_reports_error_and_keeps_connection() {
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    let mut ws = ws_connect(addr, &token).await;
    // 非 JSON 帧 → 错误帧提示 + 保持连接（防御性宽容）
    let _ = ws
        .send(tokio_tungstenite::tungstenite::Message::Text(
            "not-json".into(),
        ))
        .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.expect("应收到解析错误帧"));
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).unwrap();
    assert_eq!(error.code, DeviceErrorCode::CmdInvalid);
    // 连接仍可用
    confirm_registered(&mut ws).await;
}

// ── 注册表单元语义 ────────────────────────────────────────

#[test]
fn registry_registers_unregisters_and_counts() {
    let registry = WsRegistry::new();
    let (kill_tx, _) = watch::channel::<Option<String>>(None);
    let conn_id = match registry.register("hash-a", "device-a", kill_tx, 1000) {
        RegisterOutcome::Registered(id) => id,
        _ => panic!("注册必须成功"),
    };
    assert_eq!(registry.count(), 1);
    assert_eq!(registry.label_of(conn_id).as_deref(), Some("device-a"));
    assert_eq!(registry.connected_at(conn_id), Some(1000));
    registry.unregister(conn_id);
    assert_eq!(registry.count(), 0);
    registry.unregister(conn_id); // 幂等
    assert_eq!(registry.count(), 0);
}

#[tokio::test]
async fn registry_duplicate_token_kicks_old() {
    let registry = WsRegistry::new();
    let (kill_tx, mut kill_rx) = watch::channel::<Option<String>>(None);
    let old_id = match registry.register("hash-x", "old", kill_tx, 1000) {
        RegisterOutcome::Registered(id) => id,
        _ => panic!("注册必须成功"),
    };
    let (kill_tx2, _) = watch::channel::<Option<String>>(None);
    let new_id = match registry.register("hash-x", "new", kill_tx2, 2000) {
        RegisterOutcome::Registered(id) => id,
        _ => panic!("注册必须成功"),
    };
    assert_ne!(old_id, new_id);
    assert_eq!(registry.count(), 1, "同令牌只保留最新连接");
    // 旧连接收到踢出信号
    let _ = tokio::time::timeout(Duration::from_secs(1), kill_rx.changed())
        .await
        .expect("旧连接必须收到踢出信号");
    assert_eq!(kill_rx.borrow().as_deref(), Some(KICK_DUPLICATE));
}

// ── R1-10 T-02：同令牌多端并发（窃听重放）──

/// T-02 窃听重放令牌 → 同令牌多端并发。按现有实现语义（P0-3 裁决
/// 「每设备一主连接」）断言：第二连接被接受、旧连接被踢出（携带
/// duplicate-connection 告警信号）、注册表恒 1 条、令牌槽迁移到新
/// 连接（撤销全链命中新连接）；新连接注销后令牌槽释放可再注册。
#[tokio::test]
async fn t02_same_token_concurrent_second_connection_evicts_first() {
    let registry = WsRegistry::new();
    // 第一连接（合法设备）
    let (kill_tx_old, mut kill_rx_old) = watch::channel::<Option<String>>(None);
    let old_id = match registry.register("hash-t02", "dev-a", kill_tx_old, 1000) {
        RegisterOutcome::Registered(id) => id,
        _ => panic!("第一连接注册必须成功"),
    };
    // 第二连接（同一令牌——窃听重放 / 双端并发）
    let (kill_tx_new, _) = watch::channel::<Option<String>>(None);
    let new_id = match registry.register("hash-t02", "dev-b", kill_tx_new, 2000) {
        RegisterOutcome::Registered(id) => id,
        _ => panic!("第二连接注册必须成功"),
    };
    assert_ne!(old_id, new_id, "第二连接分配新 id");
    // 每令牌并发语义：注册表恒 1 条（旧连接被踢出）
    assert_eq!(registry.count(), 1, "同令牌只保留最新连接");
    // 告警信号：旧连接收到 duplicate-connection 踢出原因
    let _ = tokio::time::timeout(Duration::from_secs(1), kill_rx_old.changed())
        .await
        .expect("旧连接必须收到踢出信号");
    assert_eq!(
        kill_rx_old.borrow().as_deref(),
        Some(KICK_DUPLICATE),
        "踢出原因必须携带 duplicate-connection（告警信号）"
    );
    // 令牌槽已迁移：撤销全链（kick_by_token_hash）命中新连接而非旧连接
    let kicked = registry.kick_by_token_hash("hash-t02", "token-revoked");
    assert_eq!(kicked, vec![new_id], "撤销必须命中当前活跃连接（新连接）");
    // 新连接注销后令牌槽释放：第三次注册可成功
    registry.unregister(new_id);
    let (kill_tx3, _) = watch::channel::<Option<String>>(None);
    match registry.register("hash-t02", "dev-c", kill_tx3, 3000) {
        RegisterOutcome::Registered(id) => assert_ne!(id, old_id, "第三次注册分配新 id"),
        _ => panic!("注销后同令牌应可重新注册"),
    }
    assert_eq!(registry.count(), 1, "并发连接数恒为 1");
}

#[test]
fn registry_limit_exceeded_rejects() {
    let registry = WsRegistry::new();
    for i in 0..MAX_WS_CONNECTIONS {
        let (kill_tx, _) = watch::channel::<Option<String>>(None);
        let outcome =
            registry.register(&format!("hash-{i}"), &format!("dev-{i}"), kill_tx, i as u64);
        assert!(matches!(outcome, RegisterOutcome::Registered(_)));
    }
    let (kill_tx, _) = watch::channel::<Option<String>>(None);
    let outcome = registry.register("hash-over", "dev-over", kill_tx, 999);
    assert_eq!(outcome, RegisterOutcome::LimitExceeded);
}

#[test]
fn registry_replay_pending_respects_capacity() {
    let registry = WsRegistry::new();
    let (kill_tx, _) = watch::channel::<Option<String>>(None);
    let conn_id = match registry.register("hash-r", "dev-r", kill_tx, 1000) {
        RegisterOutcome::Registered(id) => id,
        _ => panic!("注册必须成功"),
    };
    registry.set_subscriptions(conn_id, vec!["s-1".to_string()]);
    registry.begin_replay(conn_id, "s-1");
    // 填满 pending（Delta 帧）
    for i in 0..RESUME_PENDING_CAPACITY {
        registry.push_pending(
            conn_id,
            "s-1",
            format!("payload-{i}"),
            BackpressureLevel::Delta,
        );
    }
    // 再入 Delta → 超限被丢
    registry.push_pending(
        conn_id,
        "s-1",
        "delta-overflow".to_string(),
        BackpressureLevel::Delta,
    );
    // 再入 Critical → 挤掉队头，必达
    registry.push_pending(
        conn_id,
        "s-1",
        "critical-arrived".to_string(),
        BackpressureLevel::Critical,
    );
    let pending = registry.end_replay(conn_id, "s-1");
    assert_eq!(pending.len(), RESUME_PENDING_CAPACITY);
    assert!(
        !pending
            .iter()
            .any(|(_, payload)| payload == "delta-overflow"),
        "Delta 超限必须被丢"
    );
    assert!(
        pending
            .iter()
            .any(|(_, payload)| payload == "critical-arrived"),
        "Critical 必须保留"
    );
    assert!(
        !registry.is_replaying(conn_id, "s-1"),
        "end_replay 后退出重放态"
    );
}

#[test]
fn registry_filter_parts_reflects_subscriptions() {
    let registry = WsRegistry::new();
    let (kill_tx, _) = watch::channel::<Option<String>>(None);
    let conn_id = match registry.register("hash-m", "dev-m", kill_tx, 1000) {
        RegisterOutcome::Registered(id) => id,
        _ => panic!("注册必须成功"),
    };
    // 空订阅 → 空过滤器
    let (sessions, global) = registry.filter_parts(conn_id);
    assert!(sessions.is_empty() && global.is_empty());
    // 会话订阅 + 全局白名单 → 双元组反映
    registry.set_subscriptions(conn_id, vec!["s-2".to_string(), "s-1".to_string()]);
    registry.set_subscribe_all(conn_id, vec!["security-audit".to_string()]);
    let (sessions, global) = registry.filter_parts(conn_id);
    assert_eq!(
        sessions,
        vec!["s-1".to_string(), "s-2".to_string()],
        "会话应排序稳定"
    );
    assert_eq!(global, vec!["security-audit".to_string()]);
    // 注销后 → 空
    registry.unregister(conn_id);
    let (sessions, global) = registry.filter_parts(conn_id);
    assert!(sessions.is_empty() && global.is_empty());
}

#[test]
fn registry_snapshot_shape_and_content() {
    let registry = WsRegistry::new();
    let (kill_tx, _) = watch::channel::<Option<String>>(None);
    let conn_id = match registry.register("hash-s", "device-s", kill_tx, 1000) {
        RegisterOutcome::Registered(id) => id,
        _ => panic!("注册必须成功"),
    };
    registry.set_subscriptions(conn_id, vec!["s-1".to_string(), "s-2".to_string()]);
    let snapshot = registry.snapshot();
    assert_eq!(snapshot.len(), 1);
    let entry = &snapshot[0];
    assert_eq!(entry.conn_id, conn_id);
    assert_eq!(entry.label, "device-s");
    assert_eq!(entry.connected_at_ms, 1000);
    assert_eq!(entry.subscribed_count, 2);
    registry.unregister(conn_id);
    assert!(registry.snapshot().is_empty(), "注销后快照应清空");
}

// ── R3-02 推送直投数据面（PushChannel 帧发送路径）──

/// 注册连接 + 注入出站通道 → send_push_frame 投递 events.push 信封
/// （envelope 内容级断言：kind / body / from-to，M8 裁决修正 2）
#[tokio::test]
async fn send_push_frame_delivers_envelope_to_token() {
    let registry = Arc::new(WsRegistry::new());
    let (kill_tx, _) = watch::channel::<Option<String>>(None);
    let token_hash = sha256_hex(b"tok-a");
    let conn_id = match registry.register(&token_hash, "手机 A", kill_tx, 1_000) {
        RegisterOutcome::Registered(id) => id,
        _ => panic!("注册必须成功"),
    };
    let (out_tx, mut out_rx) = mpsc::channel::<Outbound>(4);
    registry.attach_outbound(conn_id, out_tx);

    let body = serde_json::json!({
        "sessionId": "s-7",
        "event": { "eventType": "run-terminal", "dedupeKey": "run-terminal:run-42:failed" },
    });
    assert_eq!(
        registry.send_push_frame(&token_hash, body),
        Some(true),
        "在线连接直推必须入缓冲"
    );

    let frame = out_rx.recv().await.expect("直推帧必须到达出站通道");
    let Outbound::Frame(axum::extract::ws::Message::Text(text)) = frame else {
        panic!("直推帧必须为文本帧");
    };
    let envelope: DeviceEnvelope = serde_json::from_str(&text).expect("直推帧必须为合法信封");
    assert_eq!(envelope.kind.as_str(), "events.push");
    assert_eq!(envelope.body["sessionId"], "s-7");
    assert_eq!(
        envelope.body["event"]["dedupeKey"],
        "run-terminal:run-42:failed"
    );
    assert_eq!(envelope.from, DeviceEndpoint::Desktop);
    assert_eq!(envelope.to, DeviceEndpoint::Mobile);
}

/// 无连接（令牌未注册 / 已注销）→ None（PushChannel 映射 NoConnection）
#[test]
fn send_push_frame_missing_connection_returns_none() {
    let registry = WsRegistry::new();
    assert_eq!(
        registry.send_push_frame("hash-ghost", serde_json::json!({})),
        None,
        "未注册令牌直投必须返回无连接"
    );
}

/// 出站缓冲满 → Some(false)（端级背压；PushChannel 映射 SendFailed，
/// 分发器降级 pending，D7 §6.6）
#[tokio::test]
async fn send_push_frame_backpressured_when_buffer_full() {
    let registry = Arc::new(WsRegistry::new());
    let (kill_tx, _) = watch::channel::<Option<String>>(None);
    let token_hash = sha256_hex(b"tok-b");
    let conn_id = match registry.register(&token_hash, "手机 B", kill_tx, 1_000) {
        RegisterOutcome::Registered(id) => id,
        _ => panic!("注册必须成功"),
    };
    // 容量 1：首帧占满 → 第二帧 Full（接收端不消费模拟慢消费者；
    // 接收端保持存活——drop 会使 try_send 返回 Closed 而非 Full）
    let (out_tx, out_rx) = mpsc::channel::<Outbound>(1);
    registry.attach_outbound(conn_id, out_tx);

    assert_eq!(
        registry.send_push_frame(&token_hash, serde_json::json!({ "n": 1 })),
        Some(true),
        "首帧应入缓冲"
    );
    assert_eq!(
        registry.send_push_frame(&token_hash, serde_json::json!({ "n": 2 })),
        Some(false),
        "缓冲满必须返回背压信号"
    );
    let _ = out_rx;
}

/// 设备活跃快照（R3-02 DevicePresenceSource 适配数据源：token_hash +
/// label + 最近活动；touch 刷新；注销即移除）
#[test]
fn device_activities_reflect_connections_and_touch() {
    let registry = WsRegistry::new();
    let (kill_tx_a, _) = watch::channel::<Option<String>>(None);
    let id_a = match registry.register("hash-a", "手机 A", kill_tx_a, 1_000) {
        RegisterOutcome::Registered(id) => id,
        _ => panic!("注册必须成功"),
    };
    let (kill_tx_b, _) = watch::channel::<Option<String>>(None);
    registry.register("hash-b", "手机 B", kill_tx_b, 2_000);

    let activities = registry.device_activities();
    assert_eq!(activities.len(), 2, "两台设备");
    let a = activities
        .iter()
        .find(|(hash, _, _)| hash == "hash-a")
        .expect("A 在表内");
    assert_eq!(a.1, "手机 A");
    assert_eq!(a.2, 1_000);

    // touch 刷新最近活动（对齐 ws.rs touch 语义）
    registry.touch(id_a, 60_000);
    let activities = registry.device_activities();
    let a = activities
        .iter()
        .find(|(hash, _, _)| hash == "hash-a")
        .expect("A 在表内");
    assert_eq!(a.2, 60_000, "touch 后最近活动刷新");

    // 注销即不在列表（R1-05 断线清理语义）
    registry.unregister(id_a);
    let activities = registry.device_activities();
    assert_eq!(activities.len(), 1);
    assert_eq!(activities[0].0, "hash-b");
}

/// 端到端：真实服务 + WS 连接 → send_push_frame 帧到达客户端 socket
/// （PushChannel 同路径：注册表 → 出站通道 → sender task → wire）
#[tokio::test]
async fn push_frame_reaches_connected_socket() {
    let (addr, _handle, token, registry) = test_server(None, None).await;
    let mut ws = ws_connect(addr, &token).await;
    confirm_registered(&mut ws).await;

    let hash = sha256_hex(token.as_bytes());
    let body = serde_json::json!({
        "sessionId": "s-7",
        "event": { "eventType": "run-terminal", "dedupeKey": "run-terminal:run-42" },
    });
    assert_eq!(
        registry.send_push_frame(&hash, body),
        Some(true),
        "在线连接直推必须入缓冲"
    );
    let (kind, push_body) = parse_frame(&next_text(&mut ws).await.expect("直推帧必须到达"));
    assert_eq!(kind, "events.push");
    assert_eq!(push_body["sessionId"], "s-7");
    assert_eq!(push_body["event"]["dedupeKey"], "run-terminal:run-42");
    let _ = ws.close(None).await;
}

#[test]
fn classify_payload_levels_and_fields() {
    // Delta：message-delta（完整信封：sessionId/timestamp/messageId/block）
    let delta = r#"{"type":"message-delta","sessionId":"s-1","timestamp":"t","messageId":"m1","block":{"type":"text","text":"hi"},"schemaVersion":1}"#;
    let (sid, ty, level) = classify_payload(delta);
    assert_eq!(sid.as_deref(), Some("s-1"));
    assert_eq!(ty.as_deref(), Some("message-delta"));
    assert_eq!(level, BackpressureLevel::Delta);
    // Critical：run-terminal
    let terminal = r#"{"type":"run-terminal","sessionId":"s-1","sequence":9,"schemaVersion":1,"runId":"r-1","terminal":"completed","timestamp":"t"}"#;
    let (sid, ty, level) = classify_payload(terminal);
    assert_eq!(sid.as_deref(), Some("s-1"));
    assert_eq!(ty.as_deref(), Some("run-terminal"));
    assert_eq!(level, BackpressureLevel::Critical);
    // 解析失败 → 保守 Critical
    let (sid, ty, level) = classify_payload("not-json");
    assert_eq!(sid, None);
    assert_eq!(ty, None);
    assert_eq!(level, BackpressureLevel::Critical);
}

#[test]
fn origin_allowed_rules() {
    use axum::http::HeaderValue;
    let mut headers = HeaderMap::new();
    // 无 Origin（原生客户端）→ 放行
    assert!(origin_allowed(&headers));
    // 本机 host → 放行
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("http://localhost:1420"),
    );
    assert!(origin_allowed(&headers));
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("http://127.0.0.1:8765"),
    );
    assert!(origin_allowed(&headers));
    // 跨站 → 拒绝
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("https://evil.example.com"),
    );
    assert!(!origin_allowed(&headers));
}
