//! 帧专用通道解析（screencastFrame → 帧块）与事件泵（transport 事件面 → 分类 → bus / 帧通道）。

use super::{BusHandle, FrameChunk, Ignored, classify};
use crate::cdp::types::CdpEvent;
use base64::Engine;
use serde_json::Value;

/// screencastFrame 解析为帧块（base64 JPEG 解码；大消息走专用 mpsc 不过 typed 总线）。
///
/// Chrome 151 协议漂移（G-3 真实链路实测，2026-08-10）：
/// - `metadata.deviceWidth/deviceHeight` 实测为浮点值（如 `deviceHeight: 633.6`），
///   `as_u64` 对浮点返回 None 导致尺寸落 0（修复前帧尺寸恒 0）；
/// - `frameNumber` 字段实测**不再发送**，`as_u64().unwrap_or(0)` 使帧序号恒 0，
///   帧泵去重表 (session, frame) 会把首帧后的全部帧误判为重复丢弃 → 帧流停滞
///   （修复前 e2e 仅能收到 1 帧）。回退策略：帧序号取帧时间戳毫秒值
///   （秒级浮点 → 毫秒整数；帧间隔 ~100ms 保证同毫秒双帧概率可忽略）；
/// - `params.sessionId` 实测为 **JSON 数字**（如 `1`，旧协议为字符串）——ack
///   会话需保留**原始形态**原样回传（Chrome 对 ack 参数类型敏感，字符串化
///   后回传被拒绝：Invalid parameters → ack 全失败 → Chrome 停发新帧）。
pub fn parse_frame(event: &CdpEvent) -> Option<FrameChunk> {
    if event.method != "Page.screencastFrame" {
        return None;
    }
    let data_b64 = event.params["data"].as_str()?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .ok()?;
    let meta = &event.params["metadata"];
    let timestamp_s = meta["timestamp"].as_f64().unwrap_or(0.0);
    let timestamp_ms = (timestamp_s * 1000.0) as u64;
    let session = event.session_id.clone().unwrap_or_default();
    // ack 会话优先取 params.sessionId 原始值（形态无损），缺省回退信封
    let ack_session = match event.params.get("sessionId") {
        Some(v) if !v.is_null() => v.clone(),
        _ => Value::String(session.clone()),
    };
    Some(FrameChunk {
        data,
        session,
        ack_session,
        // frameNumber 缺省回退帧时间戳毫秒（Chrome 151 实测不发该字段）
        frame: event.params["frameNumber"].as_u64().unwrap_or(timestamp_ms),
        timestamp_ms,
        // 尺寸按浮点解析取整（Chrome 151 实测为浮点值）
        device_width: meta["deviceWidth"].as_f64().unwrap_or(0.0).round() as u32,
        device_height: meta["deviceHeight"].as_f64().unwrap_or(0.0).round() as u32,
    })
}

/// 事件泵：transport 事件面 → 分类 → typed bus / 帧通道。
pub fn spawn_event_pump(
    mut events: tokio::sync::broadcast::Receiver<CdpEvent>,
    bus: BusHandle,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    // 帧先行（专用通道）
                    if let Some(chunk) = parse_frame(&event) {
                        bus.send_frame(chunk);
                        continue;
                    }
                    match classify(&event) {
                        Ok(typed) => bus.publish(typed),
                        Err(Ignored(reason)) => {
                            tracing::debug!("事件 {} 忽略：{reason}", event.method);
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // 原始事件面 lagged：直接丢弃（typed 面自愈由版本驱动处理）
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    })
}
