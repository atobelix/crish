//! WS 测试 · 鉴权升级 / 订阅推送 / 续传 / 心跳（tests.rs 拆分）。

#![allow(clippy::disallowed_methods)]

use super::super::*;
use super::support::*;

use crate::server::auth::{sha256_hex, TokenStore};
use crate::server::backend::ApiBackend;
use std::time::Duration;

// ── 鉴权与升级 ────────────────────────────────────────────

#[tokio::test]
async fn upgrade_rejects_missing_and_invalid_token() {
    let (addr, _handle, _token, _registry) = test_server(None, None).await;
    // 无令牌 → 401
    let response = reqwest::get(format!("http://{addr}/v1/events"))
        .await
        .expect("请求必须可达");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    // 错误令牌 → 401
    let response = reqwest::get(format!("http://{addr}/v1/events?token=deadbeef"))
        .await
        .expect("请求必须可达");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn upgrade_rejects_revoked_token() {
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    // 撤销令牌（写回 pairing.json；TokenStore 已加载，撤销经同一文件
    // 语义由 R1-07 全链保证——此处验证 401 拒绝路径）
    let path = std::env::temp_dir().join(format!("pairing-revoke-{}.json", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let mut store = TokenStore::new(path.clone());
    let raw = store.issue("revoke-me", now_ms()).unwrap();
    let hash = sha256_hex(raw.as_bytes());
    assert!(store.revoke(&hash), "撤销必须命中");
    // 撤销令牌连接 → 拒绝（101 前 401）
    let response = reqwest::get(format!("http://{addr}/v1/events?token={raw}"))
        .await
        .expect("请求必须可达");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_file(path);
    let _ = token;
}

#[tokio::test]
async fn upgrade_accepts_query_token_and_upgrades() {
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    let url = format!("ws://{addr}/v1/events?token={token}");
    let (mut ws, response) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("升级必须成功");
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    let _ = ws.close(None).await;
}

#[tokio::test]
async fn upgrade_accepts_bearer_header() {
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    let url = format!("ws://{addr}/v1/events");
    let mut request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(url)
            .unwrap();
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {token}").parse().unwrap());
    let (mut ws, response) = tokio_tungstenite::connect_async(request)
        .await
        .expect("升级必须成功");
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    let _ = ws.close(None).await;
}

#[tokio::test]
async fn upgrade_rejects_cross_origin() {
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    let url = format!("ws://{addr}/v1/events?token={token}");
    let mut request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(url)
            .unwrap();
    // 跨站 Origin（非本机 host）→ 403 拒绝
    request
        .headers_mut()
        .insert("Origin", "https://evil.example.com".parse().unwrap());
    let response = tokio_tungstenite::connect_async(request)
        .await
        .expect_err("跨站 Origin 必须被拒绝");
    assert!(
        response.to_string().contains("403") || response.to_string().contains("Forbidden"),
        "拒绝原因应含 403：{response}"
    );
}

// ── 订阅 ──────────────────────────────────────────────────

#[tokio::test]
async fn subscribe_ok_returns_cursors() {
    let backend = Arc::new(MemoryBackend::new());
    backend.push("s-1", "agent-start", 1);
    backend.push("s-1", "run-terminal", 2);
    let (addr, _handle, token, _registry) =
        test_server(Some(backend as Arc<dyn ApiBackend>), None).await;
    let mut ws = ws_connect(addr, &token).await;
    send_envelope_text(
        &mut ws,
        "events.subscribe",
        serde_json::json!({
            "sessions": ["s-1", "s-2"],
            "lastSequences": { "s-1": 1 }
        }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "events.subscribe.ok");
    let ok: SubscribeOk = serde_json::from_value(body).unwrap();
    assert_eq!(ok.sessions.len(), 2);
    // s-1：latest=2 → nextSequence=3；落后 1 条不 stale
    let s1 = ok.sessions.iter().find(|c| c.session_id == "s-1").unwrap();
    assert_eq!(s1.next_sequence, 3);
    assert!(!s1.stale);
    // s-2：空会话 → nextSequence=0（无事件可续）
    let s2 = ok.sessions.iter().find(|c| c.session_id == "s-2").unwrap();
    assert_eq!(s2.next_sequence, 0);
    assert!(!s2.stale);
}

#[tokio::test]
async fn subscribe_marks_stale_when_cursor_lags_beyond_window() {
    let backend = Arc::new(MemoryBackend::new());
    // 落后超过 EVENT_WINDOW(4096) → stale（D3 §7.5 全量回放信号）
    backend.push_range("s-1", "agent-start", 1, 4200);
    let (addr, _handle, token, _registry) =
        test_server(Some(backend as Arc<dyn ApiBackend>), None).await;
    let mut ws = ws_connect(addr, &token).await;
    send_envelope_text(
        &mut ws,
        "events.subscribe",
        serde_json::json!({
            "sessions": ["s-1"],
            "lastSequences": { "s-1": 0 }
        }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "events.subscribe.ok");
    let ok: SubscribeOk = serde_json::from_value(body).unwrap();
    let s1 = &ok.sessions[0];
    assert_eq!(s1.next_sequence, 4201);
    assert!(s1.stale, "落后超窗口必须标记 stale");
}

#[tokio::test]
async fn subscribe_too_many_sessions_rejected() {
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    let mut ws = ws_connect(addr, &token).await;
    let sessions: Vec<String> = (0..33).map(|i| format!("s-{i}")).collect();
    send_envelope_text(
        &mut ws,
        "events.subscribe",
        serde_json::json!({ "sessions": sessions, "lastSequences": {} }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).unwrap();
    assert_eq!(error.code, DeviceErrorCode::StreamTooManySubscriptions);
}

// ── 实时推送过滤 ──────────────────────────────────────────

#[tokio::test]
async fn push_filtered_by_subscription() {
    let fanout = test_fanout();
    let (addr, _handle, token, _registry) = test_server(None, Some(fanout.clone())).await;
    let mut ws = ws_connect(addr, &token).await;
    send_envelope_text(
        &mut ws,
        "events.subscribe",
        serde_json::json!({ "sessions": ["s-1"], "lastSequences": {} }),
    )
    .await;
    let (kind, _) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "events.subscribe.ok");
    // 广播：s-1 命中订阅，s-2 未订阅（无全局白名单）→ 只推 s-1
    publish(&fanout, "s-1", "agent-start", Some(10));
    publish(&fanout, "s-2", "agent-start", Some(10));
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "events.push");
    let push: EventsPush = serde_json::from_value(body).unwrap();
    assert_eq!(push.session_id, "s-1");
    assert_eq!(push.event["type"], "agent-start");
    assert!(!push.preview);
}

#[tokio::test]
async fn push_marks_preview_when_sequence_missing() {
    let fanout = test_fanout();
    let (addr, _handle, token, _registry) = test_server(None, Some(fanout.clone())).await;
    let mut ws = ws_connect(addr, &token).await;
    send_envelope_text(
        &mut ws,
        "events.subscribe",
        serde_json::json!({ "sessions": ["s-1"], "lastSequences": {} }),
    )
    .await;
    let _ = next_text(&mut ws).await;
    // 实时预览帧（sequence=None，D3 §7.4：移动端不推进游标）
    publish(&fanout, "s-1", "agent-start", None);
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "events.push");
    let push: EventsPush = serde_json::from_value(body).unwrap();
    assert!(push.preview, "无 sequence 的实时帧必须标记 preview");
}

#[tokio::test]
async fn push_filtered_by_subscribe_all_whitelist() {
    let fanout = test_fanout();
    let (addr, _handle, token, _registry) = test_server(None, Some(fanout.clone())).await;
    let mut ws = ws_connect(addr, &token).await;
    // 先心跳往返确认服务端已 spawn drain（fanout 订阅就绪）
    confirm_registered(&mut ws).await;
    send_envelope_text(
        &mut ws,
        "events.subscribeAll",
        serde_json::json!({ "events": ["run-terminal"] }),
    )
    .await;
    // subscribeAll 无专用回执：以后续 heartbeat.ok 确认服务端已处理
    //（同连接帧序保证：heartbeat 在 subscribeAll 之后到达 = 订阅已生效）
    confirm_registered(&mut ws).await;
    // 广播：run-terminal 命中白名单；agent-start 未命中（会话未订阅）
    publish(&fanout, "s-a", "run-terminal", Some(1));
    publish(&fanout, "s-a", "agent-start", Some(2));
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "events.push");
    let push: EventsPush = serde_json::from_value(body).unwrap();
    assert_eq!(push.event["type"], "run-terminal");
}

// ── 续传 ──────────────────────────────────────────────────

#[tokio::test]
async fn resume_replays_pages_then_done() {
    let backend = Arc::new(MemoryBackend::new());
    backend.push_range("s-1", "message-end", 1, 250);
    let (addr, _handle, token, _registry) =
        test_server(Some(backend as Arc<dyn ApiBackend>), None).await;
    let mut ws = ws_connect(addr, &token).await;
    send_envelope_text(
        &mut ws,
        "events.subscribe",
        serde_json::json!({ "sessions": ["s-1"], "lastSequences": {} }),
    )
    .await;
    let _ = next_text(&mut ws).await;
    send_envelope_text(
        &mut ws,
        "events.resume",
        serde_json::json!({ "sessionId": "s-1", "afterSequence": 0, "maxEvents": 200 }),
    )
    .await;
    // 第 1 页：1..=200
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "events.resume.page");
    let page: ResumePage = serde_json::from_value(body).unwrap();
    assert_eq!(page.events.len(), 200);
    assert_eq!(page.events[0]["sequence"], 1);
    assert_eq!(page.next_after_sequence, 200);
    assert!(page.has_more);
    // 第 2 页：201..=250
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "events.resume.page");
    let page: ResumePage = serde_json::from_value(body).unwrap();
    assert_eq!(page.events.len(), 50);
    assert_eq!(page.next_after_sequence, 250);
    assert!(!page.has_more);
    // 收口：resume.done（resumedTo = 已追平到的序列）
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "events.resume.done");
    let done: ResumeDone = serde_json::from_value(body).unwrap();
    assert_eq!(done.resumed_to, 250);
}

#[tokio::test]
async fn resume_continues_from_last_sequence() {
    // R1-05 验收锚点：断线续传从 lastSeq+1（D6 §4.6 开区间语义）
    let backend = Arc::new(MemoryBackend::new());
    backend.push_range("s-1", "message-end", 1, 300);
    let (addr, _handle, token, _registry) =
        test_server(Some(backend as Arc<dyn ApiBackend>), None).await;
    let mut ws = ws_connect(addr, &token).await;
    send_envelope_text(
        &mut ws,
        "events.subscribe",
        serde_json::json!({ "sessions": ["s-1"], "lastSequences": { "s-1": 280 } }),
    )
    .await;
    let _ = next_text(&mut ws).await;
    send_envelope_text(
        &mut ws,
        "events.resume",
        serde_json::json!({ "sessionId": "s-1", "afterSequence": 280 }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "events.resume.page");
    let page: ResumePage = serde_json::from_value(body).unwrap();
    assert_eq!(page.events.len(), 20);
    assert_eq!(page.events[0]["sequence"], 281, "续传必须从 lastSeq+1 开始");
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "events.resume.done");
    let done: ResumeDone = serde_json::from_value(body).unwrap();
    assert_eq!(done.resumed_to, 300);
}

#[tokio::test]
async fn resume_requires_subscription() {
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    let mut ws = ws_connect(addr, &token).await;
    send_envelope_text(
        &mut ws,
        "events.resume",
        serde_json::json!({ "sessionId": "s-1", "afterSequence": 0 }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).unwrap();
    assert_eq!(error.code, DeviceErrorCode::StreamNotSubscribed);
}

#[tokio::test]
async fn resume_invalid_payload_reports_error() {
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    let mut ws = ws_connect(addr, &token).await;
    send_envelope_text(
        &mut ws,
        "events.resume",
        serde_json::json!({ "sessionId": 42, "afterSequence": "x" }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).unwrap();
    assert_eq!(error.code, DeviceErrorCode::CmdInvalid);
}

#[tokio::test]
async fn realtime_during_resume_queued_after_done() {
    // R1-05 验收锚点：先重放后实时（D2 §10.3「期间实时事件先入队」）
    let backend = Arc::new(MemoryBackend::new());
    backend.push_range("s-1", "message-end", 1, 500);
    let fanout = test_fanout();
    let (addr, _handle, token, _registry) =
        test_server(Some(backend as Arc<dyn ApiBackend>), Some(fanout.clone())).await;
    let mut ws = ws_connect(addr, &token).await;
    send_envelope_text(
        &mut ws,
        "events.subscribe",
        serde_json::json!({ "sessions": ["s-1"], "lastSequences": {} }),
    )
    .await;
    let _ = next_text(&mut ws).await;
    // 发起 resume（25 页分页，窗口足够大）
    send_envelope_text(
        &mut ws,
        "events.resume",
        serde_json::json!({ "sessionId": "s-1", "afterSequence": 0, "maxEvents": 20 }),
    )
    .await;
    // 收到第 1 页 = 服务端已进入重放态 → 广播实时帧必入 pending
    let (kind, _) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "events.resume.page");
    publish(&fanout, "s-1", "agent-start", None);
    // 读完剩余 24 页
    for _ in 1..25 {
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.resume.page");
        let page: ResumePage = serde_json::from_value(body).unwrap();
        assert_eq!(page.events.len(), 20);
    }
    // resume.done 之后才收到 pending 的实时帧（先重放后实时）
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "events.resume.done");
    let done: ResumeDone = serde_json::from_value(body).unwrap();
    assert_eq!(done.resumed_to, 500);
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(
        kind, "events.push",
        "pending 实时帧必须在 done 之后按序 flush"
    );
    let push: EventsPush = serde_json::from_value(body).unwrap();
    assert_eq!(push.event["type"], "agent-start");
}

// ── 心跳 ──────────────────────────────────────────────────

#[tokio::test]
async fn heartbeat_gets_ok() {
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    let mut ws = ws_connect(addr, &token).await;
    send_envelope_text(
        &mut ws,
        "heartbeat",
        serde_json::json!({ "ts": now_ms(), "deviceTimeMs": now_ms() }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
    assert_eq!(kind, "heartbeat.ok");
    let ok: conex_types::device::HeartbeatOk = serde_json::from_value(body).unwrap();
    assert!(ok.server_time > 0, "heartbeat.ok 必须携带桌面时钟");
}

#[tokio::test]
async fn heartbeat_timeout_kicks_connection() {
    // 半开检测：90s 无客户端帧 → 踢出（D2 §10.2「3 × 心跳间隔」）
    tokio::time::pause();
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    // 模拟半开连接：建立后既不发送应用帧也不读取（客户端库只有在
    // 读循环驱动时才处理 Ping/回 Pong）→ 服务端 90s 收不到任何帧
    let url = format!("ws://{addr}/v1/events?token={token}");
    let (mut ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("升级必须成功");
    // 推进 91s（3 个心跳周期）→ 第 3 个 tick 时超时判定触发
    tokio::time::advance(Duration::from_secs(91)).await;
    tokio::task::yield_now().await;
    let frame = next_text(&mut ws).await.expect("应收到踢出帧");
    let (kind, body) = parse_frame(&frame);
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).unwrap();
    assert!(
        error.message.contains(KICK_TIMEOUT),
        "踢出原因必须携带 heartbeat-timeout：{}",
        error.message
    );
}

#[cfg(windows)]
#[tokio::test]
async fn ping_pong_keeps_alive_during_silence() {
    // 客户端自动回 Pong → 90s 静默（仅 Ping/Pong）不被踢。
    // 读循环必须在虚拟时间推进期间持续驱动：Ping 到达时库自动回
    // Pong（写入内部缓冲），需周期 flush 才真正发出
    tokio::time::pause();
    let (addr, _handle, token, _registry) = test_server(None, None).await;
    let mut ws = ws_connect(addr, &token).await;
    send_envelope_text(
        &mut ws,
        "events.subscribe",
        serde_json::json!({ "sessions": ["s-1"], "lastSequences": {} }),
    )
    .await;
    let _ = next_text(&mut ws).await;
    // 单一任务独占 socket：读（转发 Text 帧）+ 心跳发送命令 + 周期
    // flush（驱动自动 Pong 写出）
    let (frame_tx, mut frame_rx) = mpsc::channel::<String>(16);
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<()>(4);
    let reader_task = tokio::spawn(async move {
        let mut flush_timer = tokio::time::interval(Duration::from_millis(5));
        loop {
            tokio::select! {
                frame = ws.next() => match frame {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                        if frame_tx.send(text.to_string()).await.is_err() {
                            break;
                        }
                    }
                    // 控制帧：显式回 Pong 并立即 flush（不依赖库自动回
                    // 复的调度时机——虚拟时间下 Linux 可能延迟写出导致
                    // 服务端心跳超时误踢，CI 实测）
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(payload))) => {
                        if ws
                            .send(tokio_tungstenite::tungstenite::Message::Pong(payload))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        let _ = ws.flush().await;
                    }
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Pong(_))) => {}
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
                    | Some(Err(_))
                    | None => break,
                    Some(Ok(_)) => {}
                },
                cmd = cmd_rx.recv() => {
                    match cmd {
                        // 心跳命令
                        Some(()) => {
                            let envelope = DeviceEnvelope::unsigned(
                                MessageKind::Heartbeat,
                                format!("m-test-{:08}", MSG_COUNTER.fetch_add(1, Ordering::Relaxed)),
                                now_ms(),
                                DeviceEndpoint::Mobile,
                                DeviceEndpoint::Desktop,
                                serde_json::json!({ "ts": now_ms(), "deviceTimeMs": now_ms() }),
                            );
                            if ws
                                .send(tokio_tungstenite::tungstenite::Message::Text(
                                    serde_json::to_string(&envelope).unwrap().into(),
                                ))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        // 发送端 drop → 主动关闭并退出
                        None => {
                            let _ = ws.close(None).await;
                            break;
                        }
                    }
                }
                _ = flush_timer.tick() => {
                    let _ = ws.flush().await;
                }
            }
        }
    });
    // 分步推进 100s（每步让 Ping/Pong 往返与 touch 完成；链路涉及
    // 服务端心跳 task → 客户端读循环 → 自动 Pong flush → 服务端
    // 主循环 touch 多任务协作，单次 yield 不足，多轮让行）
    for step in 0..5 {
        tokio::time::advance(Duration::from_secs(20)).await;
        for _ in 0..40 {
            tokio::task::yield_now().await;
        }
        let _ = step;
    }
    // 连接仍存活：发 heartbeat → 应收到 heartbeat.ok
    let _ = cmd_tx.send(()).await;
    let frame = loop {
        match frame_rx.try_recv() {
            Ok(frame) => break frame,
            Err(_) => {
                // 虚拟时间推进轮询（paused 下 timeout 不适用）
                tokio::time::advance(Duration::from_millis(50)).await;
                for _ in 0..40 {
                    tokio::task::yield_now().await;
                }
            }
        }
    };
    let (kind, body) = parse_frame(&frame);
    assert_eq!(kind, "heartbeat.ok", "Ping/Pong 保活下 100s 后连接必须存活");
    let ok: conex_types::device::HeartbeatOk = serde_json::from_value(body).unwrap();
    assert!(ok.server_time > 0);
    drop(cmd_tx);
    let _ = reader_task.await;
}

// ── 配对哈希迁移（auth 域）────────────────────────────────

/// 注册表单元语义：mark_authenticated 迁移占位哈希 → 真实令牌哈希
/// （撤销全链 kick_by_token_hash 命中迁移后的连接）
#[test]
fn registry_mark_authenticated_migrates_token_hash() {
    let registry = WsRegistry::new();
    let (kill_tx, _) = watch::channel::<Option<String>>(None);
    let conn_id = match registry.register("pairing-pending:1", "pairing", kill_tx, 1000) {
        RegisterOutcome::Registered(id) => id,
        _ => panic!("注册必须成功"),
    };
    assert!(
        !registry.is_authenticated(conn_id),
        "配对升级连接默认未认证"
    );
    assert!(
        registry.mark_authenticated(conn_id, "real-token-hash", "配对测试手机"),
        "迁移必须命中"
    );
    assert!(registry.is_authenticated(conn_id));
    // 撤销全链（kick_by_token_hash）命中迁移后的真实哈希
    assert_eq!(
        registry.kick_by_token_hash("real-token-hash", KICK_REVOKED),
        vec![conn_id],
        "迁移后按真实令牌哈希踢出必须命中"
    );
    // 占位哈希不再占用令牌槽
    assert!(
        registry
            .kick_by_token_hash("pairing-pending:1", KICK_REVOKED)
            .is_empty(),
        "占位哈希应已释放"
    );
}
