//! WS 连接生命周期（ws.rs 拆分）：升级后注册、并发任务与收尾。

use super::*;

/// 连接生命周期（升级成功后执行）
///
/// 结构：注册（上限/踢旧）→ split（sender 独占写端）→ 三个并发任务
/// （sender / 广播 drain / 心跳）+ 主消息循环；任一任务退出 → 踢出信号
/// → 全链收尾 → 注销。
pub(super) async fn handle_socket(
    socket: axum::extract::ws::WebSocket,
    state: ServerState,
    token_hash: String,
    label: String,
    pair_pending: bool,
    initial_token: Option<String>,
    trusted_relay: bool,
) {
    let registry = state.ws_registry();
    let (kill_tx, kill_rx) = watch::channel::<Option<String>>(None);
    let outcome = registry.register(&token_hash, &label, kill_tx.clone(), virtual_now_ms());
    let conn_id = match outcome {
        RegisterOutcome::Registered(id) => id,
        RegisterOutcome::LimitExceeded => {
            // 全局连接上限拒绝（D2 §10.5：conn.limit 错误帧后关闭）
            let frame = error_frame(
                0,
                DeviceErrorCode::TransportClosed,
                format!("连接数已达上限（{KICK_LIMIT}）"),
                None,
            );
            let mut socket = socket;
            if socket
                .send(axum::extract::ws::Message::Text(frame.into()))
                .await
                .is_ok()
            {
                let _ = socket.close().await;
            }
            return;
        }
    };
    // 正常升级连接（令牌已校验）立即标记已认证；配对升级连接保持未认证
    //（相位门控：仅 pair.hello 可入，R1-11 G-2）
    if !pair_pending {
        registry.mark_authenticated(conn_id, &token_hash, &label);
    }
    let (ws_sender, mut ws_receiver) = socket.split();
    let (out_tx, out_rx) = mpsc::channel::<Outbound>(CONN_BUFFER_CAPACITY);
    // R3-02 推送直投数据面：出站通道注入注册表（PushChannel 按令牌哈希
    // 定位连接后 try_send events.push 帧，复用本 sender task 发送路径）
    registry.attach_outbound(conn_id, out_tx.clone());

    // sender task：独占 WS 写端；踢出信号 → 发 kicked 帧 → 关闭 → 注销
    let sender_task = tokio::spawn(sender_loop(
        ws_sender,
        out_rx,
        kill_rx.clone(),
        Arc::clone(&registry),
        conn_id,
    ));

    // 心跳 task：30s Ping + 90s 无帧踢出
    let heartbeat_task = tokio::spawn(heartbeat_loop(
        Arc::clone(&registry),
        conn_id,
        out_tx.clone(),
        kill_rx.clone(),
    ));

    // 广播 drain task：fanout 接收端 → 重放 pending / 背压入队
    // （R1-01 FanOutEmitter：连接建立即注册空过滤器，events.subscribe
    // 到达后经 refresh_fanout_filter 重建；fanout 未装配 = 无广播推送）
    let fanout_ctx: Option<(
        watch::Sender<FanoutReceiver>,
        watch::Receiver<FanoutReceiver>,
    )> = if let Some(fanout) = state.fanout() {
        match fanout.subscribe(conn_id.to_string(), SubscriptionFilter::default()) {
            Ok(receiver) => {
                let (rx_tx, rx_rx) = watch::channel(receiver);
                Some((rx_tx, rx_rx))
            }
            Err(FanoutError::AlreadyRegistered) => {
                // 连接 id 冲突属进程级异常：关闭广播（订阅/续传/心跳
                // 仍可用），记错误日志
                tracing::error!(
                    target: "ws",
                    conn_id,
                    "fanout 订阅注册冲突，本连接广播推送禁用"
                );
                None
            }
        }
    } else {
        None
    };
    let drain_task = if let Some((_, rx_rx)) = &fanout_ctx {
        Some(tokio::spawn(drain_loop(
            rx_rx.clone(),
            Arc::clone(&registry),
            conn_id,
            out_tx.clone(),
            kill_rx.clone(),
        )))
    } else {
        None
    };

    // 主消息循环（读端独占）
    let token_key = Arc::new(Mutex::new(initial_token));
    let ctx = ConnCtx {
        conn_id,
        state,
        out_tx: out_tx.clone(),
        fanout_rx: fanout_ctx.map(|(rx_tx, _)| rx_tx),
        token_key: Some(token_key),
        token_hash: token_hash.clone(),
        trusted_relay,
    };
    while let Some(frame) = ws_receiver.next().await {
        match frame {
            Ok(axum::extract::ws::Message::Text(text)) => {
                registry.touch(conn_id, virtual_now_ms());
                if handle_text(text.to_string(), &ctx).await == Action::Close {
                    break;
                }
            }
            Ok(axum::extract::ws::Message::Pong(_)) => {
                // 客户端 Pong（服务端 Ping 的应答）刷新活动时刻
                registry.touch(conn_id, virtual_now_ms());
            }
            Ok(axum::extract::ws::Message::Ping(payload)) => {
                // 客户端主动 Ping → 回 Pong
                registry.touch(conn_id, virtual_now_ms());
                let _ = out_tx
                    .send(Outbound::Frame(axum::extract::ws::Message::Pong(payload)))
                    .await;
            }
            Ok(axum::extract::ws::Message::Binary(_)) => {
                // 协议只定义文本帧；二进制帧记录后忽略
                registry.touch(conn_id, virtual_now_ms());
                tracing::debug!(target: "ws", conn_id, "收到二进制帧，忽略");
            }
            Ok(axum::extract::ws::Message::Close(_)) | Err(_) => break,
        }
    }

    // 收尾：通知全部并发任务退出（sender 收尾注销；心跳/drain 退出）
    let _ = kill_tx.send(Some(String::new()));
    let _ = out_tx.send(Outbound::Close).await;
    let _ = sender_task.await;
    let _ = heartbeat_task.await;
    if let Some(task) = drain_task {
        let _ = task.await;
    }
    // fanout 订阅注销（R1-01 连接注册表；断线清理，D2 §10.5）
    if let Some(fanout) = ctx.state.fanout() {
        fanout.unsubscribe(&conn_id.to_string());
    }
}

/// sender task：独占 WS 写端（出站通道消费 + 踢出信号处理）
async fn sender_loop(
    mut ws_sender: futures_util::stream::SplitSink<
        axum::extract::ws::WebSocket,
        axum::extract::ws::Message,
    >,
    mut out_rx: mpsc::Receiver<Outbound>,
    mut kill_rx: watch::Receiver<Option<String>>,
    registry: Arc<WsRegistry>,
    conn_id: u64,
) {
    // 踢出原因（None = 正常/主动关闭，不发踢出帧）
    let kicked: Option<String> = loop {
        tokio::select! {
            _ = kill_rx.changed() => {
                match kill_rx.borrow().clone() {
                    Some(reason) if !reason.is_empty() => break Some(reason),
                    // 空串 = 主动关闭：不立即退出——继续消费出站队列，
                    // 先发完已入队的帧（Close 帧已在队列中）再收尾
                    _ => continue,
                }
            }
            out = out_rx.recv() => match out {
                Some(Outbound::Frame(message)) => {
                    // 写超时：慢消费者（网络差 / 不读数据）会让 TCP 发送缓冲填满，
                    // 裸 await 会永久阻塞本 task，其连接也无法被回收。
                    match tokio::time::timeout(WS_WRITE_TIMEOUT, ws_sender.send(message)).await {
                        Ok(Ok(())) => {}
                        Ok(Err(_)) => break None,
                        Err(_) => {
                            tracing::warn!(
                                target: "ws",
                                conn_id,
                                timeout_ms = WS_WRITE_TIMEOUT.as_millis(),
                                "WS 写超时（慢消费者），注销连接"
                            );
                            break None;
                        }
                    }
                }
                Some(Outbound::Close) | None => break None,
            },
        }
    };
    if let Some(reason) = kicked {
        if let Ok(frame) = serde_json::to_string(&kicked_envelope(&reason, conn_id)) {
            let _ = ws_sender
                .send(axum::extract::ws::Message::Text(frame.into()))
                .await;
        }
    }
    let _ = ws_sender.close().await;
    registry.unregister(conn_id);
}

/// 心跳 task：周期 Ping + 半开检测（3 × 心跳间隔无客户端帧 → 踢出）
async fn heartbeat_loop(
    registry: Arc<WsRegistry>,
    conn_id: u64,
    out_tx: mpsc::Sender<Outbound>,
    mut kill_rx: watch::Receiver<Option<String>>,
) {
    let mut interval =
        tokio::time::interval(std::time::Duration::from_millis(HEARTBEAT_INTERVAL_MS));
    // 首 tick 立即完成：先消耗——首个 Ping 在 30s 后发出，避免升级瞬间
    // 的控制帧干扰客户端握手后的首帧读取
    interval.tick().await;
    loop {
        tokio::select! {
            _ = kill_rx.changed() => break,
            _ = interval.tick() => {}
        }
        // 连接已注销（主循环收尾完成）→ 退出
        let Some(last_frame) = registry.last_frame_at(conn_id) else {
            break;
        };
        // 半开检测：90s 无任何客户端帧 → 踢出（D2 §10.2；超时判定经帧网关
        // [gateway::read_timeout_exceeded] 纯函数，虚拟时钟与 touch 同源）
        if gateway::read_timeout_exceeded(last_frame, virtual_now_ms(), HEARTBEAT_TIMEOUT_MS) {
            tracing::warn!(target: "ws", conn_id, "心跳超时（90s 无客户端帧），踢出");
            registry.kick(conn_id, KICK_TIMEOUT);
            break;
        }
        // 传输层保活（客户端库自动回 Pong → 主循环 touch 刷新活动时刻）
        if out_tx
            .send(Outbound::Frame(axum::extract::ws::Message::Ping(
                Bytes::new(),
            )))
            .await
            .is_err()
        {
            break;
        }
    }
}

/// 广播 drain task：fanout 接收端（订阅过滤与端级背压已在 fanout 侧
/// 完成，D2 §10.4）→ 重放 pending / 发送缓冲入队
async fn drain_loop(
    mut rx_handle: watch::Receiver<FanoutReceiver>,
    registry: Arc<WsRegistry>,
    conn_id: u64,
    out_tx: mpsc::Sender<Outbound>,
    mut kill_rx: watch::Receiver<Option<String>>,
) {
    loop {
        // 等待：fanout 接收端更新（订阅变更重建）或新事件
        let event = {
            let current = rx_handle.borrow().clone();
            tokio::select! {
                _ = kill_rx.changed() => break,
                _ = rx_handle.changed() => continue,
                event = current.recv() => event,
            }
        };
        let Some(event) = event else { break };
        // 重放期间：实时事件入 pending（resume.done 后按序 flush，
        // 保证「先重放后实时」每会话顺序，D2 §10.3）
        if let Some(sid) = event.session_id.as_deref() {
            if registry.is_replaying(conn_id, sid) {
                registry.push_pending(conn_id, sid, event.payload.clone(), event.level);
                continue;
            }
        }
        // 常规推送（背压：缓冲满丢 Delta 保 Critical，D2 §10.4）
        let frame = match push_frame(&event.session_id.unwrap_or_default(), &event.payload) {
            Ok(body) => outbound_frame(conn_id, MessageKind::EventsPush, body),
            Err(error) => {
                tracing::error!(target: "ws", conn_id, error = %error, "推送帧构造失败（跳过）");
                continue;
            }
        };
        match out_tx.try_send(Outbound::Frame(axum::extract::ws::Message::Text(
            frame.into(),
        ))) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(full)) => {
                if event.level == conex_types::events::BackpressureLevel::Delta {
                    tracing::debug!(target: "ws", conn_id, "发送缓冲满，丢 Delta 帧");
                    continue;
                }
                // Critical / Soft 必达：等待缓冲腾出（慢消费者仅自限，
                // 不阻塞引擎发射路径——fanout publish 非阻塞，D2 §10.7）。
                // 等待必须有上限：否则慢消费者让本任务与缓冲一起无界增长。
                match tokio::time::timeout(WS_WRITE_TIMEOUT, out_tx.send(full)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) => break,
                    Err(_) => {
                        tracing::warn!(
                            target: "ws",
                            conn_id,
                            timeout_ms = WS_WRITE_TIMEOUT.as_millis(),
                            "必达帧等待发送缓冲超时（慢消费者），注销连接"
                        );
                        break;
                    }
                }
            }
            Err(mpsc::error::TrySendError::Closed(_)) => break,
        }
    }
}
