//! WS 文本帧处理（ws.rs 拆分）：信封校验、签名/Nonce、订阅/续传/配对。

use super::*;

pub(super) async fn handle_text(text: String, ctx: &ConnCtx) -> Action {
    // 帧大小上限（D3 §5.5 / D5 §7.5：超限断链防内存放大；1 MiB 上限经
    // 帧网关 [gateway::validate_frame_size] 单一事实源判定）
    if gateway::validate_frame_size(text.len()) != gateway::FrameVerdict::Ok {
        tracing::warn!(target: "ws", conn_id = ctx.conn_id, bytes = text.len(), "帧超 1 MiB 上限");
        let frame = error_frame(
            ctx.conn_id,
            DeviceErrorCode::FrameTooLarge,
            "帧超 1 MiB 上限（frame_too_large）".to_string(),
            None,
        );
        return send_then_close(ctx, frame).await;
    }
    // 信封解析（损坏载荷：错误帧提示 + 保持连接——防御性宽容）
    let envelope: DeviceEnvelope = match serde_json::from_str(&text) {
        Ok(envelope) => envelope,
        Err(error) => {
            tracing::warn!(target: "ws", conn_id = ctx.conn_id, error = %error, "信封解析失败，忽略该帧");
            let frame = error_frame(
                ctx.conn_id,
                DeviceErrorCode::CmdInvalid,
                "信封解析失败（cmd.invalid）".to_string(),
                None,
            );
            let _ = send_frame(ctx, frame).await;
            return Action::Continue;
        }
    };
    // 协议版本校验（不匹配 → version_mismatch + 关闭）
    if envelope.v != PROTOCOL_VERSION {
        let frame = error_frame(
            ctx.conn_id,
            DeviceErrorCode::VersionMismatch,
            format!(
                "协议版本不匹配：期望 {PROTOCOL_VERSION}，收到 {}",
                envelope.v
            ),
            Some(envelope.msg_id.as_str()),
        );
        return send_then_close(ctx, frame).await;
    }
    // 配对态相位门控（R1-11 G-2）：未认证连接（配对升级进入）仅放行
    // pair.hello——其余 kind → auth.unknown_device（对齐 mock-daemon
    // 相位语义；D3 §5.2 配对期只走 pair.*）
    if !ctx.trusted_relay
        && !ctx.state.ws_registry().is_authenticated(ctx.conn_id)
        && envelope.kind != MessageKind::PairHello
    {
        let frame = error_frame(
            ctx.conn_id,
            DeviceErrorCode::AuthUnknownDevice,
            "设备未配对，请先完成配对流程".to_string(),
            Some(envelope.msg_id.as_str()),
        );
        return send_frame(ctx, frame).await;
    }

    // HMAC 签名与 Nonce 防重放校验（GW-01 / GW-03）
    // loopback 中继桥已由桥密钥 + relay 票据授权，跳过设备级 HMAC。
    if !ctx.trusted_relay {
        let has_auth_sig = !envelope.auth.sig.is_empty();
        let has_auth_nonce = !envelope.auth.nonce.is_empty();
        let is_pair_hello = envelope.kind == MessageKind::PairHello;

        // 1. 时钟偏差校验
        if envelope.auth.ts > 0 {
            let now = now_ms();
            let max_skew = ctx.state.nonce_guard().clock_skew_ms();
            let diff = envelope.auth.ts.abs_diff(now);
            if diff > max_skew {
                let frame = error_frame(
                    ctx.conn_id,
                    DeviceErrorCode::AuthExpired,
                    format!("签名时戳过期，偏差 {diff} ms 超过阈值 {max_skew} ms"),
                    Some(envelope.msg_id.as_str()),
                );
                let _ = send_frame(ctx, frame).await;
                return Action::Continue;
            }
        }

        // 2. Nonce 幂等与重放防护
        if has_auth_nonce {
            let now = now_ms();
            let mut hasher = Sha256::new();
            hasher.update(
                serde_json::to_string(&envelope.body)
                    .unwrap_or_default()
                    .as_bytes(),
            );
            let body_hash: [u8; 32] = hasher.finalize().into();

            let check = ctx.state.nonce_guard().check_and_record(
                &envelope.auth.device_id,
                &envelope.auth.nonce,
                envelope.auth.ts,
                now,
                body_hash,
            );
            match check {
                auth::NonceCheckResult::Valid => {}
                auth::NonceCheckResult::IdempotentRetry { status: _, body: _ } => {
                    // 弱网重传完全同构，放行幂等处理
                }
                auth::NonceCheckResult::ReplayDetected => {
                    let frame = error_frame(
                        ctx.conn_id,
                        DeviceErrorCode::AuthStale,
                        "检测到 Nonce 重放或参数篡改（replay_detected）".to_string(),
                        Some(envelope.msg_id.as_str()),
                    );
                    let _ = send_frame(ctx, frame).await;
                    return Action::Continue;
                }
                auth::NonceCheckResult::ClockSkewTooLarge {
                    diff_ms,
                    max_skew_ms,
                } => {
                    let frame = error_frame(
                        ctx.conn_id,
                        DeviceErrorCode::AuthExpired,
                        format!("时钟偏差过大：{diff_ms} ms > {max_skew_ms} ms"),
                        Some(envelope.msg_id.as_str()),
                    );
                    let _ = send_frame(ctx, frame).await;
                    return Action::Continue;
                }
            }
        }

        // 3. HMAC-SHA256 签名校验（非配对 hello 帧且携带 sig 或已认证连接）
        if has_auth_sig && !is_pair_hello {
            let maybe_key = ctx
                .token_key
                .as_ref()
                .and_then(|k| k.lock().ok().and_then(|guard| guard.clone()));
            if let Some(key) = maybe_key {
                let body_json = serde_json::to_string(&envelope.body).unwrap_or_default();
                let canon = auth::canonical_ws_signing_payload(
                    &envelope.auth.device_id,
                    envelope.auth.ts,
                    &envelope.auth.nonce,
                    &envelope.msg_id,
                    &envelope.kind_str(),
                    envelope.v,
                    &body_json,
                );
                if !auth::verify_hmac_sha256(key.as_bytes(), canon.as_bytes(), &envelope.auth.sig) {
                    let frame = error_frame(
                        ctx.conn_id,
                        DeviceErrorCode::AuthBadSignature,
                        "HMAC 签名校验失败（auth.bad_signature）".to_string(),
                        Some(envelope.msg_id.as_str()),
                    );
                    let _ = send_frame(ctx, frame).await;
                    return Action::Continue;
                }
            }
        }
    }
    match &envelope.kind {
        MessageKind::PairHello => {
            handle_pair_hello_frame(envelope.body, envelope.msg_id.as_str(), ctx).await
        }
        MessageKind::EventsSubscribe => handle_subscribe(envelope.body, ctx).await,
        MessageKind::EventsSubscribeAll => handle_subscribe_all(envelope.body, ctx).await,
        MessageKind::EventsResume => handle_resume(envelope.body, ctx).await,
        MessageKind::Heartbeat => handle_heartbeat(envelope.body, ctx).await,
        MessageKind::EventsAck => {
            // 诊断模式确认（ackMode=critical）；本层无需处理，记调试日志
            let _ = serde_json::from_value::<EventAck>(envelope.body.clone());
            Action::Continue
        }
        MessageKind::DeviceUnlink => handle_device_unlink(envelope.msg_id.as_str(), ctx).await,
        MessageKind::Remote(cmd) => {
            handle_remote_command_frame(cmd.as_str(), envelope.body, envelope.msg_id.as_str(), ctx)
                .await
        }
        MessageKind::Error => {
            // 对端错误帧：记录（不关闭，宽容）
            tracing::debug!(target: "ws", conn_id = ctx.conn_id, "收到对端 error 帧");
            Action::Continue
        }
        // R1-05 范围外消息（命令 / 认证 / 流 / 设备 / 会话索引；pair.verify
        // 属密钥交换链——简化链不实现，hello 已直接完成配对）：
        // 宽容忽略 + 记录（D3 §10.3「未知 kind 丢弃 + 记日志，不报错」）
        _ => {
            tracing::debug!(
                target: "ws",
                conn_id = ctx.conn_id,
                kind = %envelope.kind_str(),
                "R1-05 范围外 kind，忽略"
            );
            Action::Continue
        }
    }
}

/// remote.<cmd>：移动端远程命令处理（审批与会话命令，消除 10s 黑洞）
async fn handle_remote_command_frame(
    cmd: &str,
    body: Value,
    msg_id: &str,
    ctx: &ConnCtx,
) -> Action {
    let Some(backend) = ctx.state.backend() else {
        let err_body = ErrorBody::new(DeviceErrorCode::Internal, "API backend not initialized");
        let res = conex_types::device::commands::CommandResult::failure(msg_id, err_body);
        return send_envelope(ctx, MessageKind::Result(cmd.to_string()), res).await;
    };

    let params_val = match body.get("params") {
        Some(Value::Null) | None => Value::Object(serde_json::Map::new()),
        Some(params) => params.clone(),
    };

    // 通用分发：命令名 = remote_whitelist 的 camelCase 后缀；未登记命令
    // 由 backend 返回 cmd.unknown（与注册表错误契约一致）。
    let result = match backend.dispatch_remote_command(cmd, params_val).await {
        Ok(value) => conex_types::device::commands::CommandResult::success(msg_id, value),
        Err(error) => conex_types::device::commands::CommandResult::failure(
            msg_id,
            ErrorBody::new(error.device_code(), error.to_string()),
        ),
    };

    send_envelope(ctx, MessageKind::Result(cmd.to_string()), result).await
}

/// device.unlink：移动端主动解除配对——按本连接令牌哈希自撤销（幂等；
/// 已撤销/占位连接返回 auth.unknown_device），成功回 result 帧后踢出连接。
/// 只允许撤销自己，不接受 body.deviceId 跨设备操作（admin 面仅桌面端）。
async fn handle_device_unlink(msg_id: &str, ctx: &ConnCtx) -> Action {
    let revoked = {
        let tokens = ctx.state.tokens();
        let mut guard = tokens.lock().unwrap_or_else(|e| e.into_inner());
        guard.revoke(&ctx.token_hash)
    };
    let result = if revoked {
        conex_types::device::commands::CommandResult::success(
            msg_id,
            serde_json::json!({ "unlinked": true }),
        )
    } else {
        conex_types::device::commands::CommandResult::failure(
            msg_id,
            ErrorBody::new(
                DeviceErrorCode::AuthUnknownDevice,
                "设备不存在或已撤销".to_string(),
            ),
        )
    };
    let action = send_envelope(
        ctx,
        MessageKind::Result("device.unlink".to_string()),
        result,
    )
    .await;
    if revoked {
        ctx.state
            .ws_registry()
            .kick_by_token_hash(&ctx.token_hash, KICK_REVOKED);
    }
    action
}

/// pair.hello：配对简化链（hello → pair.ok + device.ready；任务书「或直接
/// verify/ok」授权，D3 §4.8 消息名/字段对齐——challenge/verify 密钥链在
/// 无 X25519/HMAC 实现下为占位，mock 亦不验签）。
///
/// 成功：回 pair.ok（D3 PairOk desktopId/ttl + token 明文扩展，仅此一次）
/// 以及 device.ready，连接经 [WsRegistry::mark_authenticated] 转入已认证
/// （占位哈希迁移为真实令牌哈希——撤销全链与「令牌可订阅」随即可用）。
///
/// 失败：error 帧（D3 §6.2 设备错误码，关联请求 msgId）。
async fn handle_pair_hello_frame(body: Value, msg_id: &str, ctx: &ConnCtx) -> Action {
    let registry = ctx.state.ws_registry();
    // 已认证连接重复 pair.hello → cmd.invalid（配对仅发生在配对态连接；
    // 码一次性语义下重复 hello 也会被状态机拒绝，此处防呆提示）
    if registry.is_authenticated(ctx.conn_id) {
        let frame = error_frame(
            ctx.conn_id,
            DeviceErrorCode::CmdInvalid,
            "连接已完成认证，pair.hello 无意义".to_string(),
            Some(msg_id),
        );
        return send_frame(ctx, frame).await;
    }
    let reply = crate::server::pair_endpoint::handle_pair_hello(
        &body,
        ctx.state.pairing().as_deref(),
        now_ms(),
    );
    let (token, label, device_id) = match reply {
        Ok(ok) => ok,
        Err((code, message)) => {
            let frame = error_frame(ctx.conn_id, code, message, Some(msg_id));
            return send_frame(ctx, frame).await;
        }
    };
    // D3 §4.8 step 5/6：pair.ok + device.ready
    let ok = crate::server::pair_endpoint::pair_ok_body(
        crate::server::pair_endpoint::DESKTOP_ID,
        &token,
    );
    if send_envelope(ctx, MessageKind::PairOk, ok).await == Action::Close {
        return Action::Close;
    }
    let ready = crate::server::pair_endpoint::device_ready_body(&device_id);
    if send_envelope(ctx, MessageKind::DeviceReady, ready).await == Action::Close {
        return Action::Close;
    }
    // 令牌哈希迁移：配对完成 → 连接转已认证（本连接后续消息放行，
    // 撤销全链 kick_by_token_hash 从此可命中）
    let token_hash = auth::sha256_hex(token.as_bytes());
    if let Some(ref tk_cell) = ctx.token_key {
        if let Ok(mut guard) = tk_cell.lock() {
            *guard = Some(token.clone());
        }
    }
    // 新令牌落盘后重载路由层令牌库（协调器 store 与本路由 store 各自
    // 独立——R1-07 装配断裂收口：新令牌立即被路由层鉴权接受）
    ctx.state.reload_tokens();
    registry.mark_authenticated(ctx.conn_id, &token_hash, &label);
    Action::Continue
}

/// events.subscribe：按会话订阅（≤ MAX_SUBSCRIPTIONS）+ 回执 subscribe.ok
async fn handle_subscribe(body: Value, ctx: &ConnCtx) -> Action {
    let subscribe: Subscribe = match serde_json::from_value(body.clone()) {
        Ok(subscribe) => subscribe,
        Err(error) => {
            let frame = error_frame(
                ctx.conn_id,
                DeviceErrorCode::CmdInvalid,
                format!("subscribe 载荷非法：{error}"),
                None,
            );
            return send_frame(ctx, frame).await;
        }
    };
    if subscribe.sessions.len() > MAX_SUBSCRIPTIONS {
        let frame = error_frame(
            ctx.conn_id,
            DeviceErrorCode::StreamTooManySubscriptions,
            format!(
                "订阅会话超限（{}，上限 {}）",
                subscribe.sessions.len(),
                MAX_SUBSCRIPTIONS
            ),
            None,
        );
        return send_frame(ctx, frame).await;
    }
    ctx.state
        .ws_registry()
        .set_subscriptions(ctx.conn_id, subscribe.sessions.clone());
    refresh_fanout_filter(ctx);
    // 逐会话游标回执（nextSequence = 会话当前 max+1；stale = 落后超窗口）
    let mut cursors = Vec::with_capacity(subscribe.sessions.len());
    if let Some(backend) = ctx.state.backend() {
        for session_id in &subscribe.sessions {
            let last = subscribe.last_sequences.sequence_of(session_id);
            let params = conex_types::device::EventPageParams {
                session_id: session_id.clone(),
                after_sequence: Some(last),
                max_events: Some(1),
                direction: None,
            };
            match backend.read_session_events(params).await {
                Ok(page) => {
                    // nextSequence = 会话当前 max+1；会话不存在（latest
                    // 为 None）→ 0（无事件可续）
                    let next_sequence = match page.latest_sequence {
                        Some(latest) => latest.saturating_add(1),
                        None => 0,
                    };
                    let stale = match page.latest_sequence {
                        Some(latest) => latest.saturating_sub(last) > EVENT_WINDOW as u64,
                        None => false,
                    };
                    cursors.push(SessionCursor {
                        session_id: session_id.clone(),
                        next_sequence,
                        stale,
                    });
                }
                Err(error) => {
                    tracing::warn!(
                        target: "ws",
                        conn_id = ctx.conn_id,
                        session_id,
                        error = %error,
                        "订阅游标查询失败，按已追平回执"
                    );
                    cursors.push(SessionCursor {
                        session_id: session_id.clone(),
                        next_sequence: last,
                        stale: false,
                    });
                }
            }
        }
    }
    let body = SubscribeOk { sessions: cursors };
    send_envelope(ctx, MessageKind::EventsSubscribeOk, body).await
}

/// events.subscribeAll：全局轻订阅（type 白名单；静默成功，M6 无专用回执）
async fn handle_subscribe_all(body: Value, ctx: &ConnCtx) -> Action {
    let subscribe_all: SubscribeAll = match serde_json::from_value(body.clone()) {
        Ok(subscribe_all) => subscribe_all,
        Err(error) => {
            let frame = error_frame(
                ctx.conn_id,
                DeviceErrorCode::CmdInvalid,
                format!("subscribeAll 载荷非法：{error}"),
                None,
            );
            return send_frame(ctx, frame).await;
        }
    };
    ctx.state
        .ws_registry()
        .set_subscribe_all(ctx.conn_id, subscribe_all.events);
    refresh_fanout_filter(ctx);
    Action::Continue
}

/// 按注册表当前订阅状态重建 fanout 订阅（unsubscribe + subscribe 新
/// 过滤器 → 经 watch 更新 drain 接收端；fanout 未装配时为空操作）
fn refresh_fanout_filter(ctx: &ConnCtx) {
    let (Some(fanout), Some(rx_tx)) = (ctx.state.fanout(), &ctx.fanout_rx) else {
        return;
    };
    let conn_key = ctx.conn_id.to_string();
    fanout.unsubscribe(&conn_key);
    let (sessions, global) = ctx.state.ws_registry().filter_parts(ctx.conn_id);
    match fanout.subscribe(conn_key, SubscriptionFilter::new(sessions, global)) {
        Ok(new_receiver) => {
            let _ = rx_tx.send(new_receiver);
        }
        Err(FanoutError::AlreadyRegistered) => {
            // 重建冲突（unsubscribe 后注册不应冲突）：保留旧接收端，记日志
            tracing::warn!(
                target: "ws",
                conn_id = ctx.conn_id,
                "fanout 订阅重建冲突，沿用旧过滤"
            );
        }
    }
}

/// events.resume：游标续传（未订阅拒绝 → 逐页 resume.page → resume.done
/// → flush 重放期间 pending）
async fn handle_resume(body: Value, ctx: &ConnCtx) -> Action {
    let resume: Resume = match serde_json::from_value(body.clone()) {
        Ok(resume) => resume,
        Err(error) => {
            let frame = error_frame(
                ctx.conn_id,
                DeviceErrorCode::CmdInvalid,
                format!("resume 载荷非法：{error}"),
                None,
            );
            return send_frame(ctx, frame).await;
        }
    };
    let registry = ctx.state.ws_registry();
    // 前置校验：未订阅会话即请求续传（M6 §6.2.2 stream.not_subscribed）
    if !registry.is_subscribed(ctx.conn_id, &resume.session_id) {
        let frame = error_frame(
            ctx.conn_id,
            DeviceErrorCode::StreamNotSubscribed,
            format!(
                "未订阅会话 {} 即请求续传（stream.not_subscribed）",
                resume.session_id
            ),
            None,
        );
        return send_frame(ctx, frame).await;
    }
    let page_size = resume
        .max_events
        .unwrap_or(PAGE_SIZE_DEFAULT)
        .clamp(1, PAGE_SIZE_MAX);
    // 重放期间实时事件入 pending（保证「先重放后实时」每会话顺序）
    registry.begin_replay(ctx.conn_id, &resume.session_id);
    let mut cursor = resume.after_sequence;
    if let Some(backend) = ctx.state.backend() {
        loop {
            let params = conex_types::device::EventPageParams {
                session_id: resume.session_id.clone(),
                after_sequence: Some(cursor),
                max_events: Some(page_size),
                direction: None,
            };
            match backend.read_session_events(params).await {
                Ok(page) => {
                    if !page.events.is_empty() {
                        let page_body = ResumePage {
                            session_id: resume.session_id.clone(),
                            events: page.events,
                            next_after_sequence: page.next_after_sequence,
                            has_more: page.has_more,
                        };
                        if send_envelope(ctx, MessageKind::EventsResumePage, page_body).await
                            == Action::Close
                        {
                            let _ = registry.end_replay(ctx.conn_id, &resume.session_id);
                            return Action::Close;
                        }
                    }
                    cursor = page.next_after_sequence;
                    if !page.has_more {
                        break;
                    }
                }
                Err(error) => {
                    tracing::error!(
                        target: "ws",
                        conn_id = ctx.conn_id,
                        session_id = %resume.session_id,
                        error = %error,
                        "续传分页查询失败，中断重放"
                    );
                    break;
                }
            }
        }
    }
    // 重放收口：resume.done（resumedTo = 已追平到的序列）
    let pending = registry.end_replay(ctx.conn_id, &resume.session_id);
    let done = ResumeDone {
        session_id: resume.session_id.clone(),
        resumed_to: cursor,
    };
    if send_envelope(ctx, MessageKind::EventsResumeDone, done).await == Action::Close {
        return Action::Close;
    }
    // flush 重放期间到达的实时事件（按到达序；此时已脱离重放态）
    for (_, payload) in pending {
        let frame = match push_frame(&resume.session_id, &payload) {
            Ok(body) => outbound_frame(ctx.conn_id, MessageKind::EventsPush, body),
            Err(error) => {
                tracing::error!(target: "ws", conn_id = ctx.conn_id, error = %error, "pending 帧构造失败（跳过）");
                continue;
            }
        };
        if ctx
            .out_tx
            .send(Outbound::Frame(axum::extract::ws::Message::Text(
                frame.into(),
            )))
            .await
            .is_err()
        {
            return Action::Close;
        }
    }
    Action::Continue
}

/// heartbeat：回执 heartbeat.ok（时钟校准，D3 §9.3）
async fn handle_heartbeat(body: Value, ctx: &ConnCtx) -> Action {
    // 载荷宽松解析（心跳格式非法仍回执——保活优先）
    let heartbeat = serde_json::from_value::<conex_types::device::Heartbeat>(body.clone())
        .unwrap_or(conex_types::device::Heartbeat {
            ts: now_ms(),
            device_time_ms: 0,
        });
    let ok = conex_types::device::HeartbeatOk {
        ts: heartbeat.ts,
        server_time: now_ms(),
    };
    send_envelope(ctx, MessageKind::HeartbeatOk, ok).await
}
