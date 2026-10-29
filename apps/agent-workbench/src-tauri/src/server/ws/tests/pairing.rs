//! WS 测试 · 配对链 / HMAC 签名 / 远程命令（tests.rs 拆分）。

use super::super::*;
use super::support::*;

use crate::server::auth::TokenStore;
use crate::server::backend::ApiBackend;
use crate::server::{router, ServerConfig, ServerHandle, ServerInstance, ServerState};
use conex_types::device::RunControlLevel;
use std::net::SocketAddr;
use std::time::Duration;

// ── R1-11 G-2：WS pair.hello 消息链（配对升级 + 简化链）──

/// 配对服务测试装配：服务开关开启 + 配对协调器注入（协调器令牌库与
/// 路由层令牌库同文件——reload_tokens 收口；码经协调器激活）。返回
/// (地址, 句柄, 协调器)。
async fn spawn_pairing_server() -> (
    SocketAddr,
    ServerHandle,
    Arc<crate::server::pairing::PairingCoordinator>,
) {
    let dir = tempfile::tempdir().expect("临时目录必须可创建");
    let file = dir.path().join("pairing.json");
    let mut config = ServerConfig::new(dir.path());
    config.port = 0;
    config.multi_device_enabled = true;
    config.pairing_file_path = file.clone();
    let tokens = Arc::new(Mutex::new(TokenStore::new(file)));
    let ws_registry = Arc::new(WsRegistry::new());
    let coordinator = Arc::new(crate::server::pairing::PairingCoordinator::new(
        tokens,
        ws_registry,
    ));
    let instance = ServerInstance::bind(config).await.expect("测试绑定失败");
    let addr = instance.addr();
    let handle = instance.handle().clone();
    let state = ServerState::new(
        instance.handle(),
        TokenStore::load(&handle.config().pairing_file_path),
        None,
    )
    .with_pairing(Arc::clone(&coordinator));
    let router = router::build_router(state);
    tokio::spawn(async move {
        let _ = instance.serve(router).await;
    });
    let url = format!("http://{addr}/v1/info");
    for _ in 0..100 {
        if reqwest::get(&url).await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    (addr, handle, coordinator)
}

/// 无令牌 WS 连接（配对升级路径）
async fn ws_connect_anonymous(
    addr: SocketAddr,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let url = format!("ws://{addr}/v1/events");
    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("配对升级必须成功（激活码存在）");
    ws
}

/// pair.hello 帧（D3 §4.8 字段：code/deviceId/mobilePub/mobileLongPub/
/// deviceName）
async fn send_pair_hello(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    code: &str,
) {
    send_envelope_text(
        ws,
        "pair.hello",
        serde_json::json!({
            "code": code,
            "deviceId": "dev-pair-test-0001",
            "mobilePub": "mock-mobile-pub",
            "mobileLongPub": "mock-mobile-long-pub",
            "deviceName": "配对测试手机",
            "platform": "android",
        }),
    )
    .await;
}

/// 无活跃配对码时：无令牌升级被拒（401）——配对例外只在配对激活期
/// 开放（D5 零信任不因本例外放宽；R1-05 既有拒绝语义保持）
#[tokio::test]
async fn pair_upgrade_rejected_without_active_code() {
    let (addr, _handle, coordinator) = spawn_pairing_server().await;
    let _ = coordinator; // 未激活配对（无码）
    let response = reqwest::get(format!("http://{addr}/v1/events"))
        .await
        .expect("请求必须可达");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

/// WS pair 消息链全路径（任务书验收：hello→ok 拿令牌→令牌可订阅）：
/// ① 配对激活期无令牌连接升级成功；② 未配对连接发会话消息被拒
/// （相位门控 auth.unknown_device）；③ pair.hello 正确码 → pair.ok
/// （desktopId/ttl/token 64hex 明文）+ device.ready；④ 同连接订阅会话
/// → subscribe.ok（配对完成令牌即生效）；⑤ 新令牌开新连接 → 心跳
/// 往返成功（令牌被路由层鉴权接受）
#[tokio::test]
async fn pair_hello_chain_ok_and_token_subscribes() {
    let (addr, _handle, coordinator) = spawn_pairing_server().await;
    let code = coordinator
        .start_pairing(now_ms())
        .expect("激活配对必须成功")
        .code;
    let mut ws = ws_connect_anonymous(addr).await;

    // ② 相位门控：未配对连接发 events.subscribe → auth.unknown_device
    send_envelope_text(
        &mut ws,
        "events.subscribe",
        serde_json::json!({ "sessions": ["s-1"], "lastSequences": {} }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).unwrap();
    assert_eq!(error.code, DeviceErrorCode::AuthUnknownDevice);

    // ③ pair.hello 正确码 → pair.ok（含 token 明文）+ device.ready
    send_pair_hello(&mut ws, &code).await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "pair.ok", "配对成功必须回 pair.ok");
    let token = {
        let ok = body.as_object().expect("pair.ok 必须为对象");
        assert_eq!(
            ok["desktopId"].as_str(),
            Some(crate::server::pair_endpoint::DESKTOP_ID)
        );
        assert_eq!(
            ok["ttl"].as_u64(),
            Some(crate::server::pair_endpoint::PAIR_TTL_SECONDS)
        );
        let token = ok["token"].as_str().expect("pair.ok 必须携带令牌明文");
        assert_eq!(token.len(), 64, "32B hex 令牌");
        token.to_string()
    };
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "device.ready");
    assert_eq!(body["deviceId"].as_str(), Some("dev-pair-test-0001"));

    // ④ 同连接配对完成后订阅会话 → subscribe.ok（令牌即生效）
    send_envelope_text(
        &mut ws,
        "events.subscribe",
        serde_json::json!({ "sessions": ["s-1"], "lastSequences": {} }),
    )
    .await;
    let (kind, _) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "events.subscribe.ok", "配对完成后会话消息必须放行");

    // ⑤ 新令牌开新连接（升级鉴权走 TokenStore——reload_tokens 收口
    // 后路由层接受配对签发的新令牌）
    let mut ws2 = ws_connect(addr, &token).await;
    send_envelope_text(
        &mut ws2,
        "heartbeat",
        serde_json::json!({ "ts": now_ms(), "deviceTimeMs": now_ms() }),
    )
    .await;
    let (kind, _) = parse_frame(&next_text(&mut ws2).await.unwrap());
    assert_eq!(kind, "heartbeat.ok", "新令牌必须通过 WS 升级鉴权");
    let _ = ws2.close(None).await;
    let _ = ws.close(None).await;
}

/// 错误配对码 → error 帧 + pair.invalid_code（D3 §6.2 错误码对齐 mock）
#[tokio::test]
async fn pair_hello_wrong_code_returns_error_frame() {
    let (addr, _handle, coordinator) = spawn_pairing_server().await;
    coordinator
        .start_pairing(now_ms())
        .expect("激活配对必须成功");
    let mut ws = ws_connect_anonymous(addr).await;
    send_pair_hello(&mut ws, "CXN-AAAA-BBBB-CCCC").await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).unwrap();
    assert_eq!(error.code, DeviceErrorCode::PairInvalidCode);
    let _ = ws.close(None).await;
}

/// 载荷缺字段 → error 帧 + cmd.invalid（对齐 mock-daemon：pair.hello
/// 缺必需字段拒绝）
#[tokio::test]
async fn pair_hello_malformed_body_returns_error_frame() {
    let (addr, _handle, coordinator) = spawn_pairing_server().await;
    coordinator
        .start_pairing(now_ms())
        .expect("激活配对必须成功");
    let mut ws = ws_connect_anonymous(addr).await;
    send_envelope_text(
        &mut ws,
        "pair.hello",
        serde_json::json!({ "code": "CXN-7K4P-Q2MB-9XRT" }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).unwrap();
    assert_eq!(error.code, DeviceErrorCode::CmdInvalid);
    let _ = ws.close(None).await;
}

/// device.unlink：移动端主动解除配对只撤销本连接令牌（不接受跨设备
/// deviceId 操作），撤销后该令牌的新连接升级被拒，当前连接被踢出。
#[tokio::test]
async fn device_unlink_revokes_own_token_and_kicks_connection() {
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    let mut ws = ws_connect(addr, &token).await;

    send_envelope_text(
        &mut ws,
        "device.unlink",
        serde_json::json!({ "deviceId": "another-device" }),
    )
    .await;

    // 令牌已撤销：同令牌的新升级在 101 前被 401 拒绝（无论当前连接
    // 是否先收到 kicked 帧）。
    for _ in 0..50 {
        let response = reqwest::get(format!("http://{addr}/v1/events?token={token}"))
            .await
            .expect("请求必须可达");
        if response.status() == StatusCode::UNAUTHORIZED {
            let _ = ws.close(None).await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("device.unlink 后令牌必须立即失效（新连接应 401）");
}

// ── HMAC-SHA256 签名与 Nonce 防重放（GW-01 / GW-03）──

#[tokio::test]
async fn ws_hmac_signature_and_nonce_verification() {
    let (addr, _handle, raw_token, _) = test_server(None, None).await;
    let mut ws = ws_connect(addr, &raw_token).await;

    let now = now_ms();
    let device_id = "test-device";
    let body = serde_json::json!({ "ts": now, "deviceTimeMs": now });
    let body_str = serde_json::to_string(&body).unwrap();
    let nonce = "nonce-ws-001";
    let msg_id = "msg-ws-001";

    // 1. 合法签名 + Nonce -> 心跳成功 (heartbeat.ok)
    let canon = auth::canonical_ws_signing_payload(
        device_id,
        now,
        nonce,
        msg_id,
        "heartbeat",
        1,
        &body_str,
    );
    let valid_sig = auth::hmac_sha256_hex(raw_token.as_bytes(), canon.as_bytes());

    let frame = serde_json::json!({
        "v": 1,
        "kind": "heartbeat",
        "msgId": msg_id,
        "ts": now,
        "from": "mobile",
        "to": "desktop",
        "auth": {
            "deviceId": device_id,
            "ts": now,
            "nonce": nonce,
            "sig": valid_sig,
        },
        "body": body,
    });
    let _ = ws
        .send(tokio_tungstenite::tungstenite::Message::Text(
            serde_json::to_string(&frame).unwrap().into(),
        ))
        .await;
    let (kind, _) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "heartbeat.ok", "合法签名必须成功返回 heartbeat.ok");

    // 2. 错误 HMAC 签名 -> 返回 error (AuthBadSignature)
    let invalid_frame = serde_json::json!({
        "v": 1,
        "kind": "heartbeat",
        "msgId": "msg-ws-002",
        "ts": now,
        "from": "mobile",
        "to": "desktop",
        "auth": {
            "deviceId": device_id,
            "ts": now,
            "nonce": "nonce-ws-002",
            "sig": "0000000000000000000000000000000000000000000000000000000000000000",
        },
        "body": body,
    });
    let _ = ws
        .send(tokio_tungstenite::tungstenite::Message::Text(
            serde_json::to_string(&invalid_frame).unwrap().into(),
        ))
        .await;
    let (kind, body_res) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "error", "错误签名必须返回 error 帧");
    let err: ErrorBody = serde_json::from_value(body_res).unwrap();
    assert_eq!(err.code, DeviceErrorCode::AuthBadSignature);

    // 3. 过期时间戳 (>5分钟偏差) -> 返回 error (AuthExpired)
    let expired_ts = now - 400_000;
    let expired_frame = serde_json::json!({
        "v": 1,
        "kind": "heartbeat",
        "msgId": "msg-ws-003",
        "ts": expired_ts,
        "from": "mobile",
        "to": "desktop",
        "auth": {
            "deviceId": device_id,
            "ts": expired_ts,
            "nonce": "nonce-ws-003",
            "sig": valid_sig,
        },
        "body": body,
    });
    let _ = ws
        .send(tokio_tungstenite::tungstenite::Message::Text(
            serde_json::to_string(&expired_frame).unwrap().into(),
        ))
        .await;
    let (kind, body_res) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "error", "过期时戳必须返回 error 帧");
    let err: ErrorBody = serde_json::from_value(body_res).unwrap();
    assert_eq!(err.code, DeviceErrorCode::AuthExpired);

    // 4. 重放攻击（相同 Nonce 篡改 Body）-> 返回 error (AuthStale)
    let tampered_body = serde_json::json!({ "ts": now, "deviceTimeMs": now + 999 });
    let replay_frame = serde_json::json!({
        "v": 1,
        "kind": "heartbeat",
        "msgId": "msg-ws-004",
        "ts": now,
        "from": "mobile",
        "to": "desktop",
        "auth": {
            "deviceId": device_id,
            "ts": now,
            "nonce": nonce, // 重复使用 nonce-ws-001
            "sig": valid_sig,
        },
        "body": tampered_body,
    });
    let _ = ws
        .send(tokio_tungstenite::tungstenite::Message::Text(
            serde_json::to_string(&replay_frame).unwrap().into(),
        ))
        .await;
    let (kind, body_res) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "error", "重放篡改必须返回 error 帧");
    let err: ErrorBody = serde_json::from_value(body_res).unwrap();
    assert_eq!(err.code, DeviceErrorCode::AuthStale);

    let _ = ws.close(None).await;
}

// ── 远程命令分发（remote.<cmd>）──

#[tokio::test]
async fn remote_run_control_dispatches_mobile_wire_params_and_preserves_errors() {
    let backend = Arc::new(MemoryBackend::new());
    let (addr, _handle, token, _registry) =
        test_server(Some(backend.clone() as Arc<dyn ApiBackend>), None).await;
    let mut ws = ws_connect(addr, &token).await;

    for (msg_id, level, payload) in [
        (
            "mobile-inject",
            "soft_inject",
            Some(serde_json::json!({ "text": "follow-up from mobile" })),
        ),
        ("mobile-pause", "cooperative_stop", None),
        ("mobile-resume", "continue", None),
        ("mobile-cancel", "force_cancel", None),
    ] {
        let mut params = serde_json::json!({
            "level": level,
            "runId": "r-mobile",
            "sessionId": "s-mobile",
            "reason": "from mobile",
        });
        if let Some(payload) = payload {
            params["payload"] = payload;
        }
        send_remote_command(&mut ws, "runControl", msg_id, params).await;
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "result.runControl");
        let result: conex_types::device::commands::CommandResult =
            serde_json::from_value(body).unwrap();
        assert_eq!(result.req_msg_id, msg_id);
        assert!(result.ok);
        assert_eq!(result.result, Some(serde_json::json!({ "ok": true })));
    }

    let received = backend.run_controls.lock().unwrap().clone();
    assert_eq!(received.len(), 4);
    assert_eq!(received[0].level, RunControlLevel::SoftInject);
    assert_eq!(received[0].run_id, "r-mobile");
    assert_eq!(received[0].session_id, "s-mobile");
    assert_eq!(
        received[0].payload,
        Some(serde_json::json!({ "text": "follow-up from mobile" }))
    );
    assert_eq!(received[0].reason.as_deref(), Some("from mobile"));
    assert_eq!(received[1].level, RunControlLevel::CooperativeStop);
    assert_eq!(received[2].level, RunControlLevel::Continue);
    assert_eq!(received[3].level, RunControlLevel::ForceCancel);

    // Dispatcher must preserve the backend's business error code.
    *backend.run_control_error.lock().unwrap() = Some(ServerError::protocol(
        DeviceErrorCode::CmdNotFound,
        "run 不存在或已终态：r-terminal",
    ));
    send_remote_command(
        &mut ws,
        "runControl",
        "mobile-terminal-run",
        serde_json::json!({
            "level": "continue",
            "runId": "r-terminal",
            "sessionId": "s-mobile",
        }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "result.runControl");
    let result: conex_types::device::commands::CommandResult =
        serde_json::from_value(body).unwrap();
    assert!(!result.ok);
    assert_eq!(
        result.error.unwrap().code,
        DeviceErrorCode::CmdNotFound,
        "目标缺失/已终态必须保留 CoreStateBackend 错误码"
    );

    // 枚举参数非法时在反序列化阶段拒绝，不调用后端。
    send_remote_command(
        &mut ws,
        "runControl",
        "mobile-invalid-level",
        serde_json::json!({
            "level": "pause",
            "runId": "r-mobile",
            "sessionId": "s-mobile",
        }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "result.runControl");
    let result: conex_types::device::commands::CommandResult =
        serde_json::from_value(body).unwrap();
    assert_eq!(result.error.unwrap().code, DeviceErrorCode::CmdInvalid);
    assert_eq!(backend.run_controls.lock().unwrap().len(), 5);
    let _ = ws.close(None).await;
}

#[tokio::test]
async fn remote_other_session_commands_keep_their_wire_contracts() {
    let backend = Arc::new(MemoryBackend::new());
    let (addr, _handle, token, _registry) =
        test_server(Some(backend.clone() as Arc<dyn ApiBackend>), None).await;
    let mut ws = ws_connect(addr, &token).await;

    send_remote_command(
        &mut ws,
        "runTask",
        "mobile-run-task",
        serde_json::json!({
            "sessionId": "s-mobile",
            "prompt": "hello from mobile",
            "clientMessageId": "msg-client-1",
        }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "result.runTask");
    let result: conex_types::device::commands::CommandResult =
        serde_json::from_value(body).unwrap();
    assert!(result.ok);
    assert_eq!(result.req_msg_id, "mobile-run-task");
    assert_eq!(
        result.result,
        Some(serde_json::json!({ "runId": "r-mobile", "sessionId": "s-mobile" }))
    );
    let run_task = backend.run_tasks.lock().unwrap()[0].clone();
    assert_eq!(run_task.prompt, "hello from mobile");
    assert_eq!(run_task.client_message_id.as_deref(), Some("msg-client-1"));

    send_remote_command(
        &mut ws,
        "cancelRun",
        "mobile-cancel-run",
        serde_json::json!({ "runId": "r-mobile", "reason": "user cancelled" }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "result.cancelRun");
    let result: conex_types::device::commands::CommandResult =
        serde_json::from_value(body).unwrap();
    assert!(result.ok);
    assert_eq!(
        result.result,
        Some(serde_json::json!({ "ok": true, "runId": "r-mobile" }))
    );
    assert_eq!(backend.cancel_runs.lock().unwrap()[0].run_id, "r-mobile");

    // searchSessions 是协议中的 P2 未注册能力，保持 cmd.unknown 契约。
    send_remote_command(
        &mut ws,
        "searchSessions",
        "mobile-search-sessions",
        serde_json::json!({ "query": "hello" }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "result.searchSessions");
    let result: conex_types::device::commands::CommandResult =
        serde_json::from_value(body).unwrap();
    assert!(!result.ok);
    assert_eq!(result.req_msg_id, "mobile-search-sessions");
    assert_eq!(result.error.unwrap().code, DeviceErrorCode::CmdUnknown);
    let _ = ws.close(None).await;
}

#[tokio::test]
async fn remote_run_control_rejects_pairing_state_connection() {
    let (addr, _handle, coordinator) = spawn_pairing_server().await;
    coordinator
        .start_pairing(now_ms())
        .expect("激活配对必须成功");
    let mut ws = ws_connect_anonymous(addr).await;
    send_remote_command(
        &mut ws,
        "runControl",
        "anonymous-run-control",
        serde_json::json!({
            "level": "cooperative_stop",
            "runId": "r-mobile",
            "sessionId": "s-mobile",
        }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).unwrap();
    assert_eq!(error.code, DeviceErrorCode::AuthUnknownDevice);
    let _ = ws.close(None).await;
}

/// F3：listPendingApprovals 空参契约——Null/`{}` 不得恒 CmdInvalid
#[test]
fn list_pending_approvals_null_and_empty_object_contract() {
    use conex_types::device::commands::ListPendingApprovalsParams;

    // 裸 Null 对 struct 反序列化失败（记录为何必须 normalize）
    let bare_null = serde_json::from_value::<ListPendingApprovalsParams>(Value::Null);
    assert!(
        bare_null.is_err(),
        "裸 Null 必须无法直接反序列化为 ListPendingApprovalsParams"
    );

    // normalize(Null) → {} → 成功（防回潮恒 CmdInvalid）
    let normalized = normalize_list_pending_approvals_params(Value::Null);
    assert_eq!(normalized, serde_json::json!({}));
    let from_null: ListPendingApprovalsParams =
        serde_json::from_value(normalized).expect("Null→{} 必须可反序列化");
    assert_eq!(from_null.after_sequence, None);

    // 直接 {} 成功
    let from_empty: ListPendingApprovalsParams =
        serde_json::from_value(serde_json::json!({})).expect("{} 必须可反序列化");
    assert_eq!(from_empty.after_sequence, None);

    // 非空对象透传
    let with_seq =
        normalize_list_pending_approvals_params(serde_json::json!({ "afterSequence": 42u64 }));
    let parsed: ListPendingApprovalsParams =
        serde_json::from_value(with_seq).expect("带 afterSequence 必须可反序列化");
    assert_eq!(parsed.after_sequence, Some(42));
}
