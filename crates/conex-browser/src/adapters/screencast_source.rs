//! CdpScreencastSource —— `FrameSource` 浏览器线适配器（05 文档 §3.4，纯加法）
//!
//! 包装既有 `ScreencastSession`（frames/session.rs），把共享层帧源抽象映射到
//! 既有帧流数据面：
//! - start/stop/status 委托既有生命周期（session.rs:314/344/381）；
//! - subscribe 取一次 `subscribe_frames`（独占消费契约）包成 `FrameStream` 适配；
//! - `FrameOut → Frame` 为转换视图（format 恒 Jpeg，05 文档 §6.2 项 2）；
//! - request_sync_frame = 流内下一帧（05 文档 §9 问题 5，不保证新画面）；
//! - set_frame_policy 映射帧率档（EventDriven/Low → Base；质量/格式降级忽略，
//!   05 文档 §9 问题 7——ScreencastConfig 构造期决定，会话不可重建）。
//!
//! 不替换既有 frame_stream.rs 接线：本适配器是共享层消费面的平行新增入口。
//! 恢复（ConnectionRestored 自动重启）由 `ScreencastSession` 监督任务自愈
//! （session.rs:554-629），适配器零参与。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use conex_shared::frame::{
    Frame, FrameFormat, FramePolicy, FrameRate, FrameSource, FrameSourceError, FrameSourceStatus,
    FrameStream,
};

use crate::frames::FrameReceiver;
use crate::frames::{FpsLevel, FrameOut, ScreencastError, ScreencastSession, ScreencastStatus};

/// 同步回显帧等待上限（防帧泵停滞时挂死调用方；正常 ack pacing 下帧间隔
/// ≤ 125ms（Base 档），2s 为宽松防御界）。
const SYNC_FRAME_TIMEOUT: Duration = Duration::from_secs(2);

/// 帧源适配器（浏览器线）：包装既有 `ScreencastSession` 的共享层入口。
pub struct CdpScreencastSource {
    session: Arc<ScreencastSession>,
    /// 独占订阅标志（镜像 FrameReceiver 独占消费契约；重复订阅返回 Err）。
    subscribed: AtomicBool,
}

impl CdpScreencastSource {
    /// 新建适配器（会话由 app 侧按既有流程懒创建，frame_stream.rs 现状不变）。
    pub fn new(session: Arc<ScreencastSession>) -> Self {
        CdpScreencastSource {
            session,
            subscribed: AtomicBool::new(false),
        }
    }

    /// 内部会话引用（app 侧诊断/既有接线面）。
    pub fn session(&self) -> &Arc<ScreencastSession> {
        &self.session
    }

    /// `FrameOut → Frame` 转换（共享 Frame 是适配器侧的转换视图，
    /// `FrameOut`/12 字节定长头协议保持唯一权威，05 文档 §6.2 项 2）。
    pub fn convert(out: FrameOut) -> Frame {
        Frame {
            seq: out.seq,
            width: out.width,
            height: out.height,
            format: FrameFormat::Jpeg,
            data: out.data,
        }
    }
}

/// 共享帧率档 → 浏览器线 `FpsLevel`（05 文档 §3.4：Low→Base /
/// Interactive→Interactive / Burst→Burst；EventDriven 为桌面线档，降级 Base）。
fn to_fps_level(rate: FrameRate) -> FpsLevel {
    match rate {
        FrameRate::EventDriven => {
            tracing::debug!("EventDriven 为桌面线档位，浏览器线降级为 Base（8fps）");
            FpsLevel::Base
        }
        FrameRate::Low => FpsLevel::Base,
        FrameRate::Interactive => FpsLevel::Interactive,
        FrameRate::Burst => FpsLevel::Burst,
    }
}

/// `ScreencastError → FrameSourceError`（生命周期错误面映射，05 文档 §3.2）。
fn map_screencast_error(e: ScreencastError) -> FrameSourceError {
    match e {
        ScreencastError::AlreadyActive => FrameSourceError::AlreadyActive,
        ScreencastError::NoActiveSession => FrameSourceError::Failed("无活动标签会话".to_string()),
        ScreencastError::Command(ce) => FrameSourceError::Failed(format!("CDP 命令失败：{ce}")),
    }
}

#[async_trait]
impl FrameSource for CdpScreencastSource {
    async fn start(&self, policy: FramePolicy) -> Result<(), FrameSourceError> {
        // 帧率档初始化（ScreencastConfig 构造期已定格式/质量，此处仅调档）
        self.session.set_fps_level(to_fps_level(policy.rate));
        self.session.start().await.map_err(map_screencast_error)
    }

    async fn stop(&self) -> Result<(), FrameSourceError> {
        // 幂等：已停止/停止中同样返回 Ok（session.rs:344 语义）
        self.session.stop().await;
        Ok(())
    }

    fn subscribe(&self) -> Result<Box<dyn FrameStream>, FrameSourceError> {
        if self.subscribed.swap(true, Ordering::SeqCst) {
            return Err(FrameSourceError::Failed(
                "重复订阅（独占消费契约）".to_string(),
            ));
        }
        Ok(Box::new(SessionFrameStream::new(
            self.session.subscribe_frames(),
        )))
    }

    async fn request_sync_frame(&self) -> Result<Frame, FrameSourceError> {
        if self.status() != FrameSourceStatus::Active {
            return Err(FrameSourceError::NotActive);
        }
        // 流内下一帧（05 文档 §9 问题 5，不保证新画面）：取一次即时消费端，
        // 不依赖既有订阅；take_receiver 对非首次取仍返回可用接收端（仅告警），
        // 不破坏既有订阅流。
        let rx = self.session.subscribe_frames();
        rx.recv_timeout(SYNC_FRAME_TIMEOUT)
            .await
            .map(Self::convert)
            .ok_or_else(|| FrameSourceError::Failed("等待同步回显帧超时（帧泵无产出）".to_string()))
    }

    fn set_frame_policy(&self, policy: FramePolicy) {
        self.session.set_fps_level(to_fps_level(policy.rate));
        if policy.format != FrameFormat::Jpeg {
            // 格式/质量降级忽略（05 文档 §9 问题 7）：浏览器线恒 Jpeg，
            // ScreencastConfig 构造期决定，会话不可重建
            tracing::debug!("帧策略格式降级忽略：浏览器线恒 Jpeg（ScreencastConfig 构造期决定）");
        }
    }

    fn status(&self) -> FrameSourceStatus {
        match self.session.status() {
            ScreencastStatus::Idle => FrameSourceStatus::Idle,
            ScreencastStatus::Starting => FrameSourceStatus::Starting,
            ScreencastStatus::Active => FrameSourceStatus::Active,
            ScreencastStatus::Stopping => FrameSourceStatus::Stopping,
        }
    }
}

/// `FrameReceiver → FrameStream` 适配（recv 返回 None（会话销毁）→ Err(Closed)）。
struct SessionFrameStream {
    receiver: FrameReceiver,
}

impl SessionFrameStream {
    fn new(receiver: FrameReceiver) -> Self {
        SessionFrameStream { receiver }
    }
}

#[async_trait]
impl FrameStream for SessionFrameStream {
    async fn next_frame(&mut self) -> Result<Frame, FrameSourceError> {
        self.receiver
            .recv()
            .await
            .map(CdpScreencastSource::convert)
            .ok_or(FrameSourceError::Closed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::error::CdpError;
    use crate::cdp::mock::{MockReply, MockServer};
    use crate::cdp::sender::{
        ApprovalDenied, BrowserAuditEvent, CancellationToken, CdpCommandView, IdKey,
    };
    use crate::cdp::transport::{CdpEndpoint, ExpectedBrowser};
    use crate::frames::ScreencastConfig;
    use async_trait::async_trait;
    use base64::Engine;
    use conex_shared::frame::{FrameFormat, FrameRate};
    use serde_json::{json, Value};
    use std::sync::atomic::AtomicBool;

    /// 放行策略钩子（会话面测试用，同 session.rs 测试）。
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

    /// 会话恢复所需 mock 自动应答全表（同 session.rs 测试）。
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
    async fn setup() -> (MockServer, Arc<crate::BrowserSession>) {
        let mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        mock.set_auto_reply("Page.startScreencast", MockReply::Ok(json!({})));
        mock.set_auto_reply("Page.stopScreencast", MockReply::Ok(json!({})));
        mock.set_auto_reply("Page.screencastFrameAck", MockReply::Ok(json!({})));

        let session = Arc::new(
            crate::BrowserSession::connect(
                CdpEndpoint {
                    port: mock.addr.port(),
                    ws_path: "/devtools/browser/adapters-frames-test".to_string(),
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
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while session.current_session().is_err() {
            assert!(std::time::Instant::now() < deadline, "活动标签未就绪");
            tokio::task::yield_now().await;
        }
        (mock, session)
    }

    /// 注入一帧（envelope session S1；params.sessionId 同值，与 session.rs 口径一致）。
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

    /// 默认测试策略（交互档 + JPEG 质量 70，对齐 conex-shared frame.rs 测试）。
    fn default_policy() -> FramePolicy {
        FramePolicy {
            rate: FrameRate::Interactive,
            format: FrameFormat::Jpeg,
            quality: Some(70),
        }
    }

    /// Frame 转换断言（05 文档 §3.2）：字段一一映射 + format 恒 Jpeg。
    #[test]
    fn frame_out_conversion_mapping() {
        let out = FrameOut {
            seq: 42,
            width: 1280,
            height: 720,
            data: vec![0xFF, 0xD8, 1, 2],
        };
        let frame = CdpScreencastSource::convert(out);
        assert_eq!(frame.seq, 42);
        assert_eq!(frame.width, 1280);
        assert_eq!(frame.height, 720);
        assert_eq!(frame.format, FrameFormat::Jpeg, "浏览器线恒 Jpeg");
        assert_eq!(frame.data, vec![0xFF, 0xD8, 1, 2], "JPEG 字节原样透传");
    }

    /// 生命周期全流程（05 文档 §3.4）：start → Active；订阅独占流取帧；
    /// request_sync_frame 取流内下一帧；stop 幂等 → Idle；已激活重复 start 拒绝。
    #[tokio::test]
    async fn frame_source_lifecycle_and_stream() {
        let (mock, session) = setup().await;
        let frames = ScreencastSession::new(
            session.clone(),
            ScreencastConfig {
                hold_override: Some(Duration::ZERO),
                ..Default::default()
            },
        );
        let source = CdpScreencastSource::new(Arc::new(frames));
        assert_eq!(source.status(), FrameSourceStatus::Idle);

        // 启动 + 已激活重复 start 拒绝
        source.start(default_policy()).await.expect("启动失败");
        assert_eq!(source.status(), FrameSourceStatus::Active);
        assert!(matches!(
            source.start(default_policy()).await,
            Err(FrameSourceError::AlreadyActive)
        ));

        // 订阅独占流；重复订阅拒绝
        let mut stream = source.subscribe().expect("订阅失败");
        assert!(matches!(
            source.subscribe(),
            Err(FrameSourceError::Failed(_))
        ));

        // 注入 2 帧 → 流内逐帧（字段映射断言）
        inject_frame(&mock, 1);
        inject_frame(&mock, 2);
        for seq in 1..=2u64 {
            let frame = stream.next_frame().await.expect("取帧失败");
            assert_eq!(frame.seq, seq);
            assert_eq!(frame.width, 1280);
            assert_eq!(frame.height, 720);
            assert_eq!(frame.format, FrameFormat::Jpeg);
            assert_eq!(frame.data, b"fake-jpeg-bytes");
        }

        // request_sync_frame：流内下一帧（05 文档 §9 问题 5，不保证新画面）
        inject_frame(&mock, 3);
        let sync = source.request_sync_frame().await.expect("同步帧失败");
        assert_eq!(sync.seq, 3);
        assert_eq!(sync.format, FrameFormat::Jpeg);

        // stop 幂等 → Idle
        source.stop().await.expect("停止失败");
        source.stop().await.expect("停止应幂等");
        assert_eq!(source.status(), FrameSourceStatus::Idle);

        source.session().shutdown().await;
        session.shutdown().await;
    }

    /// request_sync_frame 前置条件：未启动 → NotActive。
    #[tokio::test]
    async fn request_sync_frame_requires_active() {
        let (_mock, session) = setup().await;
        let frames = ScreencastSession::new(session.clone(), ScreencastConfig::default());
        let source = CdpScreencastSource::new(Arc::new(frames));
        assert!(matches!(
            source.request_sync_frame().await,
            Err(FrameSourceError::NotActive)
        ));
        source.session().shutdown().await;
        session.shutdown().await;
    }

    /// set_frame_policy 映射（05 文档 §3.4）：帧率档映射 FpsLevel；
    /// 格式/质量降级忽略（恒 Jpeg）。
    #[tokio::test]
    async fn set_frame_policy_maps_fps_level() {
        let (mock, session) = setup().await;
        let frames = ScreencastSession::new(
            session.clone(),
            ScreencastConfig {
                hold_override: Some(Duration::ZERO),
                ..Default::default()
            },
        );
        let source = CdpScreencastSource::new(Arc::new(frames));
        assert_eq!(source.session().fps_level(), FpsLevel::Base, "初始档 Base");

        // Burst 映射（Png 格式请求被降级忽略，不报错不影响档位）
        source.set_frame_policy(FramePolicy {
            rate: FrameRate::Burst,
            format: FrameFormat::Png,
            quality: None,
        });
        assert_eq!(
            source.session().fps_level(),
            FpsLevel::Burst,
            "Burst → Burst"
        );

        // Low → Base；quality 忽略
        source.set_frame_policy(FramePolicy {
            rate: FrameRate::Low,
            format: FrameFormat::Jpeg,
            quality: Some(90),
        });
        assert_eq!(source.session().fps_level(), FpsLevel::Base, "Low → Base");

        source.session().shutdown().await;
        let _ = mock;
        session.shutdown().await;
    }

    /// start 失败映射（U-3 新语义双断言）：
    /// - 降级启用（static_fallback_enabled 默认 true）→ startScreencast 失败
    ///   时 1fps 轮询接管，返回 Ok + 状态机投影 Active + is_degraded=true，
    ///   停止后退出降级（is_degraded=false）；
    /// - 降级禁用 → 旧语义保留：失败（ScreencastError::Command → Failed）
    ///   + 状态回 Idle + 不进入降级轮询。
    #[tokio::test]
    async fn start_failure_maps_to_failed() {
        // —— 降级启用（默认）：失败 → Ok + Active + 降级轮询接管 ——
        let (mock, session) = setup().await;
        let frames = ScreencastSession::new(session.clone(), ScreencastConfig::default());
        let source = CdpScreencastSource::new(Arc::new(frames));
        mock.set_auto_reply(
            "Page.startScreencast",
            MockReply::Error {
                code: -32000,
                message: "screencast not supported".to_string(),
            },
        );
        source
            .start(default_policy())
            .await
            .expect("降级接管应返回 Ok");
        assert_eq!(
            source.status(),
            FrameSourceStatus::Active,
            "降级后状态机投影仍为 Active（帧流运行中）"
        );
        assert!(source.session().is_degraded(), "应处于静态降级轮询");
        source.stop().await.expect("停止失败");
        assert!(!source.session().is_degraded(), "停止后退出降级轮询");
        source.session().shutdown().await;
        session.shutdown().await;

        // —— 降级禁用（旧语义保留）：失败 → Failed + 状态回 Idle ——
        let (mock, session) = setup().await;
        let frames = ScreencastSession::new(
            session.clone(),
            ScreencastConfig {
                static_fallback_enabled: false,
                ..Default::default()
            },
        );
        let source = CdpScreencastSource::new(Arc::new(frames));
        mock.set_auto_reply(
            "Page.startScreencast",
            MockReply::Error {
                code: -32000,
                message: "screencast not supported".to_string(),
            },
        );
        let err = source.start(default_policy()).await.expect_err("应失败");
        assert!(
            matches!(err, FrameSourceError::Failed(_)),
            "实际错误：{err:?}"
        );
        assert_eq!(source.status(), FrameSourceStatus::Idle, "失败回 Idle");
        assert!(!source.session().is_degraded(), "降级禁用时不进入降级轮询");
        source.session().shutdown().await;
        session.shutdown().await;
    }
}
