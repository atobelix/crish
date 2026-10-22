//! 帧流会话单元测试公共脚手架与 mock 设施（自 session.rs 平移）。

use super::*;
use crate::cdp::bus::VersionReason;
use crate::cdp::error::CdpError;
use crate::cdp::mock::{MockReply, MockServer};
use crate::cdp::sender::{
    ApprovalDenied, BrowserAuditEvent, CancellationToken, CdpCommandView, IdKey,
};
use crate::cdp::transport::{CdpEndpoint, ExpectedBrowser};
use async_trait::async_trait;
use base64::Engine;
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

mod lifecycle;
mod streaming;

/// 放行策略钩子（会话面测试用，同 lib.rs 测试）。
struct AllowHooks {
    stop: Arc<AtomicBool>,
    token: CancellationToken,
}

impl AllowHooks {
    fn new() -> Self {
        AllowHooks {
            stop: Arc::new(AtomicBool::new(false)),
            token: CancellationToken::new(),
        }
    }
}

#[async_trait]
impl crate::cdp::sender::CommandPolicyHooks for AllowHooks {
    async fn idempotent(&self, _key: &IdKey) -> Option<Result<Value, CdpError>> {
        None
    }
    async fn approve(&self, _cmd: &CdpCommandView) -> Result<(), ApprovalDenied> {
        Ok(())
    }
    fn audit(&self, _event: BrowserAuditEvent) {}
    fn emergency_stop(&self) -> Arc<AtomicBool> {
        self.stop.clone()
    }
    fn abort_token(&self) -> CancellationToken {
        self.token.clone()
    }
}

/// 会话恢复所需 mock 自动应答全表（同 ops.rs 测试）。
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

/// 组装：mock 会话 + screencast 三命令自动应答 + 活动标签就绪。
async fn setup() -> (MockServer, Arc<BrowserSession>) {
    let mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    mock.set_auto_reply("Page.startScreencast", MockReply::Ok(json!({})));
    mock.set_auto_reply("Page.stopScreencast", MockReply::Ok(json!({})));
    mock.set_auto_reply("Page.screencastFrameAck", MockReply::Ok(json!({})));

    let session = Arc::new(
        BrowserSession::connect(
            CdpEndpoint {
                port: mock.addr.port(),
                ws_path: "/devtools/browser/frames-test".to_string(),
            },
            ExpectedBrowser::default(),
            Arc::new(AllowHooks::new()),
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
    // 事件链路无定时器（事件泵/活动跟踪纯事件驱动）：yield 轮询即可
    // （兼容虚拟时钟测试环境，不依赖真实 sleep）
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while session.current_session().is_err() {
        assert!(std::time::Instant::now() < deadline, "活动标签未就绪");
        tokio::task::yield_now().await;
    }
    (mock, session)
}

/// 注入一帧（envelope session S1；params.sessionId 同值，与 bus 测试口径一致）。
fn inject_frame(mock: &MockServer, frame: u64) {
    let data = base64::engine::general_purpose::STANDARD.encode(b"fake-jpeg-bytes");
    mock.send_event(
        "Page.screencastFrame",
        json!({
            "data": data,
            "metadata": {
                "pageScaleFactor": 1.0,
                "deviceWidth": 1280,
                "deviceHeight": 720,
                "timestamp": 1.0
            },
            "sessionId": "S1",
            "frameNumber": frame
        }),
        Some("S1"),
    );
}

/// 等待 ack 计数达标（真实时钟轮询，2s 上限）。
async fn wait_acks(frames: &ScreencastSession, target: u64) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while frames.stats().acks_sent < target && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
        frames.stats().acks_sent >= target,
        "等待 ack 超时（目标 {target}，实际 {}）",
        frames.stats().acks_sent
    );
}
