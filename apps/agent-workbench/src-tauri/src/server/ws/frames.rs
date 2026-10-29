//! WS 出站帧构造与发送（ws.rs 拆分）：信封 / 错误帧 / 踢出帧 / 推送体。

use super::*;

/// 发送出站信封（序列化 body → 信封 → 文本帧 → out_tx；回执/错误必达）
pub(super) async fn send_envelope(
    ctx: &ConnCtx,
    kind: MessageKind,
    body: impl Serialize,
) -> Action {
    let value = match serde_json::to_value(&body) {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(target: "ws", conn_id = ctx.conn_id, error = %error, "出站消息序列化失败");
            return Action::Continue;
        }
    };
    let frame = outbound_frame(ctx.conn_id, kind, value);
    send_frame(ctx, frame).await
}

/// 发送文本帧（必达语义：缓冲满时等待腾出）
pub(super) async fn send_frame(ctx: &ConnCtx, frame: String) -> Action {
    match ctx
        .out_tx
        .try_send(Outbound::Frame(axum::extract::ws::Message::Text(
            frame.clone().into(),
        ))) {
        Ok(()) => Action::Continue,
        Err(mpsc::error::TrySendError::Full(_)) => {
            if ctx
                .out_tx
                .send(Outbound::Frame(axum::extract::ws::Message::Text(
                    frame.into(),
                )))
                .await
                .is_err()
            {
                Action::Close
            } else {
                Action::Continue
            }
        }
        Err(mpsc::error::TrySendError::Closed(_)) => Action::Close,
    }
}

/// 发送错误帧后关闭连接（frame_too_large / version_mismatch 等断链场景）
pub(super) async fn send_then_close(ctx: &ConnCtx, frame: String) -> Action {
    let _ = send_frame(ctx, frame).await;
    Action::Close
}

/// 构造出站信封文本帧（from=desktop → to=mobile；msgId 计数器分配）
pub(super) fn outbound_frame(conn_id: u64, kind: MessageKind, body: Value) -> String {
    let envelope = DeviceEnvelope::unsigned(
        kind,
        next_msg_id(conn_id),
        now_ms(),
        DeviceEndpoint::Desktop,
        DeviceEndpoint::Mobile,
        body,
    );
    serde_json::to_string(&envelope).unwrap_or_else(|_| "{}".to_string())
}

/// 构造踢出帧（reason → 错误码映射，D2 §10.6）
pub(super) fn kicked_envelope(reason: &str, conn_id: u64) -> DeviceEnvelope {
    // token-revoked：设备已撤销（移动端进入 unauthorized 终止态，不自动
    // 重试）；其余：transport.closed（可重连）
    let (code, message) = if reason == KICK_REVOKED {
        (
            DeviceErrorCode::AuthDeviceRevoked,
            format!("设备已被撤销（{reason}）"),
        )
    } else {
        (
            DeviceErrorCode::TransportClosed,
            format!("连接被服务端关闭（{reason}）"),
        )
    };
    let body = ErrorBody::new(code, message);
    DeviceEnvelope::unsigned(
        MessageKind::Error,
        next_msg_id(conn_id),
        now_ms(),
        DeviceEndpoint::Desktop,
        DeviceEndpoint::Mobile,
        serde_json::to_value(body).unwrap_or_default(),
    )
}

/// 构造 error 帧文本（统一出网错误；reqMsgId 关联请求）
pub(super) fn error_frame(
    conn_id: u64,
    code: DeviceErrorCode,
    message: String,
    req_msg_id: Option<&str>,
) -> String {
    let mut body = ErrorBody::new(code, message);
    if let Some(msg_id) = req_msg_id {
        body = body.with_req_msg_id(msg_id);
    }
    outbound_frame(
        conn_id,
        MessageKind::Error,
        serde_json::to_value(body).unwrap_or_default(),
    )
}

/// 构造 events.push 消息体（preview = 事件 sequence 未落库，D3 §7.4；
/// 外层 DeviceEnvelope 由调用方 [outbound_frame] 包装）
pub(super) fn push_frame(session_id: &str, payload: &str) -> Result<Value, ServerError> {
    let value: Value = serde_json::from_str(payload)
        .map_err(|e| ServerError::internal(format!("事件载荷解析失败：{e}")))?;
    let preview = value.get("sequence").is_none();
    let body = EventsPush {
        session_id: session_id.to_string(),
        preview,
        event: value,
    };
    serde_json::to_value(&body)
        .map_err(|e| ServerError::internal(format!("events.push 序列化失败：{e}")))
}
