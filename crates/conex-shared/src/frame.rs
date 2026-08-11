//! 帧源抽象（05 文档 §3 定稿；浏览器线语义对等点见 05 文档 §2.1）。
//!
//! 语义约定：
//! - 生命周期（start/stop/status）与浏览器线 `ScreencastSession` 对等
//!   （session.rs:314/344/381）；
//! - 订阅为独占消费契约（同 `FrameReceiver`，sink.rs take_receiver 语义），
//!   重复订阅返回错误；
//! - 背压为「帧可丢、画面追最新」（丢旧保新，FrameSink 同语义）；
//! - 恢复（浏览器重连自愈 / 桌面捕获重试）为实现内语义，trait 只暴露状态投影。

use async_trait::async_trait;

/// 帧图格式（浏览器线恒 JPEG；桌面线 PNG/JPEG 可配，05 文档 §3.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameFormat {
    /// JPEG 编码
    Jpeg,
    /// PNG 编码
    Png,
}

/// 帧率档位（跨线语义档：浏览器线映射 FpsLevel，桌面线映射事件驱动/轮询）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FrameRate {
    /// 事件驱动（桌面线默认：UI/输入事件触发捕获，不轮询）
    EventDriven,
    /// 低档（浏览器线 Base ≈ 8fps；桌面线 ≈ 2fps 轮询）
    Low,
    /// 交互档（浏览器线 Interactive ≈ 15fps；桌面线 ≈ 3-5fps）
    Interactive,
    /// 突发档（浏览器线 Burst ≈ 20fps）
    Burst,
}

/// 运行期帧策略（start 初始档 + set_frame_policy 运行期调档）。
///
/// 策略为运行期请求，实现内可降级（如浏览器线格式恒 JPEG，05 文档 §9 问题 7）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FramePolicy {
    /// 帧率档
    pub rate: FrameRate,
    /// 帧图格式
    pub format: FrameFormat,
    /// JPEG 质量档（50-75 有效面；PNG 无损忽略）
    pub quality: Option<u8>,
}

/// 共享帧（浏览器线由 `FrameOut` 转换补 format=Jpeg；桌面线 PNG 原生）。
/// 可序列化：帧下行通道按 MIME 判定渲染（05 文档 §9 问题 6）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Frame {
    /// 帧序号（单调递增）
    pub seq: u64,
    /// 帧宽（像素）
    pub width: u32,
    /// 帧高（像素）
    pub height: u32,
    /// 帧图格式（前端按 MIME 渲染判定，05 文档 §9 问题 6）
    pub format: FrameFormat,
    /// 编码后字节
    pub data: Vec<u8>,
}

/// 帧源状态（浏览器侧映射 `ScreencastStatus`，session.rs:51-61）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameSourceStatus {
    /// 未启动/已停止
    Idle,
    /// 启动在途
    Starting,
    /// 帧流运行中
    Active,
    /// 停止在途
    Stopping,
}

/// 帧源错误（Display 文案与 05 文档 §3.2 定稿一致）。
#[derive(Debug, thiserror::Error)]
pub enum FrameSourceError {
    /// 帧源已激活（重复 start）
    #[error("帧源已激活（重复 start）")]
    AlreadyActive,
    /// 帧源未启动
    #[error("帧源未启动")]
    NotActive,
    /// 帧源已关闭（消费端流终止）
    #[error("帧源已关闭（消费端流终止）")]
    Closed,
    /// 帧源失败
    #[error("帧源失败：{0}")]
    Failed(String),
}

/// 帧源（共享引用调用面；浏览器线 `CdpScreencastSource` 包装 `ScreencastSession`，
/// 桌面线 `DesktopCaptureSource` 包装 `ScreenCapture`）。
#[async_trait]
pub trait FrameSource: Send + Sync {
    /// 启动帧流（幂等拒绝：Active/Starting 时返回 AlreadyActive）。
    async fn start(&self, policy: FramePolicy) -> Result<(), FrameSourceError>;
    /// 停止帧流（幂等；停帧后订阅流仍可排空已入队帧）。
    async fn stop(&self) -> Result<(), FrameSourceError>;
    /// 订阅帧输出流（独占消费契约，同 FrameReceiver；重复订阅返回 Err）。
    fn subscribe(&self) -> Result<Box<dyn FrameStream>, FrameSourceError>;
    /// 动作后同步回显帧（实现内语义：流内取下一帧；桌面线亦可单帧直捕）。
    async fn request_sync_frame(&self) -> Result<Frame, FrameSourceError>;
    /// 运行期调档（帧率/质量/格式请求；实现内可降级，如浏览器线格式恒 JPEG）。
    fn set_frame_policy(&self, policy: FramePolicy);
    /// 当前状态（面板投影/互斥切换清理断言用）。
    fn status(&self) -> FrameSourceStatus;
}

/// 帧输出流（独占消费句柄；浏览器线适配 `FrameReceiver::recv`）。
#[async_trait]
pub trait FrameStream: Send {
    /// 取下一帧（空时挂起；背压契约：队列满时实现内丢旧保新——帧可丢，画面追最新；
    /// 源停止并排空后返回 Err(Closed)）。
    async fn next_frame(&mut self) -> Result<Frame, FrameSourceError>;
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::test_support::block_on;

    /// 构造测试帧（JPEG 标记头 + 序号字节）
    fn make_frame(seq: u64) -> Frame {
        Frame {
            seq,
            width: 1920,
            height: 1080,
            format: FrameFormat::Jpeg,
            data: vec![0xFF, 0xD8, seq as u8],
        }
    }

    /// 默认测试策略（交互档 + JPEG 质量 70）
    fn default_policy() -> FramePolicy {
        FramePolicy {
            rate: FrameRate::Interactive,
            format: FrameFormat::Jpeg,
            quality: Some(70),
        }
    }

    /// mock 帧源内部共享状态（源句柄与流句柄共用，latest-slot 语义）
    struct Shared {
        status: AtomicU8,
        seq: AtomicU64,
        slot: Mutex<Option<Frame>>,
        policy: Mutex<Option<FramePolicy>>,
    }

    impl Shared {
        fn set_status(&self, status: FrameSourceStatus) {
            self.status.store(status as u8, Ordering::SeqCst);
        }

        fn status(&self) -> FrameSourceStatus {
            match self.status.load(Ordering::SeqCst) {
                0 => FrameSourceStatus::Idle,
                1 => FrameSourceStatus::Starting,
                2 => FrameSourceStatus::Active,
                _ => FrameSourceStatus::Stopping,
            }
        }

        fn policy(&self) -> Option<FramePolicy> {
            *self.policy.lock().expect("策略槽加锁")
        }
    }

    /// mock 帧源：状态机 + 单帧槽，冒烟覆盖 trait 全方法调用面
    struct MockFrameSource {
        shared: Arc<Shared>,
        subscribed: AtomicBool,
    }

    impl MockFrameSource {
        fn new() -> Self {
            Self {
                shared: Arc::new(Shared {
                    status: AtomicU8::new(0),
                    seq: AtomicU64::new(0),
                    slot: Mutex::new(None),
                    policy: Mutex::new(None),
                }),
                subscribed: AtomicBool::new(false),
            }
        }
    }

    /// mock 帧流：共享单帧槽；源停止且排空后返回 Closed
    struct MockFrameStream {
        shared: Arc<Shared>,
    }

    #[async_trait]
    impl FrameSource for MockFrameSource {
        async fn start(&self, policy: FramePolicy) -> Result<(), FrameSourceError> {
            if self.shared.status() != FrameSourceStatus::Idle {
                return Err(FrameSourceError::AlreadyActive);
            }
            self.shared.set_status(FrameSourceStatus::Active);
            *self.shared.policy.lock().expect("策略槽加锁") = Some(policy);
            Ok(())
        }

        async fn stop(&self) -> Result<(), FrameSourceError> {
            // 幂等：已停止时同样返回 Ok
            self.shared.set_status(FrameSourceStatus::Idle);
            Ok(())
        }

        fn subscribe(&self) -> Result<Box<dyn FrameStream>, FrameSourceError> {
            if self.subscribed.swap(true, Ordering::SeqCst) {
                return Err(FrameSourceError::Failed(
                    "重复订阅（独占消费契约）".to_string(),
                ));
            }
            Ok(Box::new(MockFrameStream {
                shared: self.shared.clone(),
            }))
        }

        async fn request_sync_frame(&self) -> Result<Frame, FrameSourceError> {
            if self.shared.status() != FrameSourceStatus::Active {
                return Err(FrameSourceError::NotActive);
            }
            let seq = self.shared.seq.fetch_add(1, Ordering::SeqCst) + 1;
            let frame = make_frame(seq);
            *self.shared.slot.lock().expect("帧槽加锁") = Some(frame.clone());
            Ok(frame)
        }

        fn set_frame_policy(&self, policy: FramePolicy) {
            *self.shared.policy.lock().expect("策略槽加锁") = Some(policy);
        }

        fn status(&self) -> FrameSourceStatus {
            self.shared.status()
        }
    }

    #[async_trait]
    impl FrameStream for MockFrameStream {
        async fn next_frame(&mut self) -> Result<Frame, FrameSourceError> {
            if let Some(frame) = self.shared.slot.lock().expect("帧槽加锁").take() {
                return Ok(frame);
            }
            if self.shared.status() == FrameSourceStatus::Active {
                // mock 简化：真实现此处挂起等待新帧；mock 以 NotActive 表达「当前无帧」
                return Err(FrameSourceError::NotActive);
            }
            Err(FrameSourceError::Closed)
        }
    }

    #[test]
    fn frame_format_serde_roundtrip() {
        for (fmt, name) in [(FrameFormat::Jpeg, "jpeg"), (FrameFormat::Png, "png")] {
            assert_eq!(
                serde_json::to_string(&fmt).expect("序列化失败"),
                format!("\"{name}\"")
            );
            assert_eq!(
                serde_json::from_str::<FrameFormat>(&format!("\"{name}\"")).expect("反序列化失败"),
                fmt
            );
        }
    }

    #[test]
    fn frame_rate_serde_roundtrip() {
        for (rate, name) in [
            (FrameRate::EventDriven, "event_driven"),
            (FrameRate::Low, "low"),
            (FrameRate::Interactive, "interactive"),
            (FrameRate::Burst, "burst"),
        ] {
            assert_eq!(
                serde_json::to_string(&rate).expect("序列化失败"),
                format!("\"{name}\"")
            );
            assert_eq!(
                serde_json::from_str::<FrameRate>(&format!("\"{name}\"")).expect("反序列化失败"),
                rate
            );
        }
    }

    #[test]
    fn frame_serde_roundtrip() {
        let frame = make_frame(7);
        let json = serde_json::to_string(&frame).expect("序列化失败");
        assert_eq!(
            json,
            r#"{"seq":7,"width":1920,"height":1080,"format":"jpeg","data":[255,216,7]}"#
        );
        assert_eq!(
            serde_json::from_str::<Frame>(&json).expect("反序列化失败"),
            frame
        );
    }

    #[test]
    fn frame_policy_default_fields() {
        // FramePolicy 为进程内类型（不序列化），字段面构造即契约
        let policy = FramePolicy {
            rate: FrameRate::Low,
            format: FrameFormat::Png,
            quality: None,
        };
        assert_eq!(policy.rate, FrameRate::Low);
        assert_eq!(policy.format, FrameFormat::Png);
        assert_eq!(policy.quality, None);
    }

    #[test]
    fn frame_source_status_variants_distinct() {
        // 状态机五态互异（面板投影映射面）
        let states = [
            FrameSourceStatus::Idle,
            FrameSourceStatus::Starting,
            FrameSourceStatus::Active,
            FrameSourceStatus::Stopping,
        ];
        for (i, s) in states.iter().enumerate() {
            for (j, t) in states.iter().enumerate() {
                assert_eq!(i == j, s == t, "状态互异断言: {i} vs {j}");
            }
        }
    }

    #[test]
    fn frame_source_error_display() {
        assert_eq!(
            FrameSourceError::AlreadyActive.to_string(),
            "帧源已激活（重复 start）"
        );
        assert_eq!(FrameSourceError::NotActive.to_string(), "帧源未启动");
        assert_eq!(
            FrameSourceError::Closed.to_string(),
            "帧源已关闭（消费端流终止）"
        );
        assert_eq!(
            FrameSourceError::Failed("设备丢失".to_string()).to_string(),
            "帧源失败：设备丢失"
        );
    }

    #[test]
    fn frame_source_object_safe_and_lifecycle_smoke() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Box<dyn FrameSource>>();
        fn assert_send<T: Send>() {}
        assert_send::<Box<dyn FrameStream>>();

        // 对象安全：按 trait 对象装箱调用全方法
        let source: Box<dyn FrameSource> = Box::new(MockFrameSource::new());
        assert_eq!(source.status(), FrameSourceStatus::Idle);

        block_on(source.start(default_policy())).expect("启动失败");
        assert_eq!(source.status(), FrameSourceStatus::Active);

        // 动作后同步回显：产帧入槽
        let sync = block_on(source.request_sync_frame()).expect("回显失败");
        assert_eq!(sync.seq, 1);

        // 订阅独占流并取帧
        let mut stream: Box<dyn FrameStream> = source.subscribe().expect("订阅失败");
        let frame = block_on(stream.next_frame()).expect("取帧失败");
        assert_eq!(frame, sync);

        // 停止后流排空：返回 Closed
        block_on(source.stop()).expect("停止失败");
        assert_eq!(source.status(), FrameSourceStatus::Idle);
        assert!(matches!(
            block_on(stream.next_frame()),
            Err(FrameSourceError::Closed)
        ));
    }

    #[test]
    fn frame_source_duplicate_start_rejected() {
        let source = MockFrameSource::new();
        block_on(source.start(default_policy())).expect("首次启动失败");
        assert!(matches!(
            block_on(source.start(default_policy())),
            Err(FrameSourceError::AlreadyActive)
        ));
    }

    #[test]
    fn frame_source_subscribe_is_exclusive() {
        let source = MockFrameSource::new();
        let _first = source.subscribe().expect("首次订阅失败");
        assert!(matches!(
            source.subscribe(),
            Err(FrameSourceError::Failed(_))
        ));
    }

    #[test]
    fn frame_source_request_sync_frame_requires_active() {
        let source = MockFrameSource::new();
        assert!(matches!(
            block_on(source.request_sync_frame()),
            Err(FrameSourceError::NotActive)
        ));
    }

    #[test]
    fn frame_source_set_policy_persisted() {
        let source = MockFrameSource::new();
        block_on(source.start(default_policy())).expect("启动失败");
        let burst = FramePolicy {
            rate: FrameRate::Burst,
            format: FrameFormat::Jpeg,
            quality: None,
        };
        source.set_frame_policy(burst);
        assert_eq!(source.shared.policy(), Some(burst));
    }
}
