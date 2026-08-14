//! 桌面帧源(05 文档 §3.5):包装既有截屏源实现共享层 `FrameSource`/`FrameStream`。
//!
//! 设计要点:
//! - 产源抽象 [`FrameProducer`]:生产实现为 `screen::ScreenCapture` 适配
//!   (布局刷新/重试为 ScreenCapture 内语义),测试注入 mock,不触真实设备;
//! - 背压:`tokio::sync::watch` 通道即 latest-slot——捕获写入覆盖旧帧
//!   (丢旧保新,与浏览器线 FrameSink 语义一致,05 §3.2 契约「帧可丢,画面追最新」);
//! - 订阅:独占消费契约(同 FrameReceiver),重复订阅返回错误;
//! - 帧率档:轮询档(Low ≈ 2fps / Interactive ≈ 4fps / Burst ≈ 10fps)由后台线程
//!   循环捕获;EventDriven 档不轮询,帧由 [`request_sync_frame`] 事件驱动产生
//!   (05 §3.5「事件驱动单帧槽」);
//! - 格式:产源恒 PNG;请求 JPEG 时实现内降级为 PNG 并记录日志
//!   (05 §9 问题 7「策略为运行期请求,实现可降级」)。
//!
//! 隐私联动(04 §4.5 密码框抑制暂停捕获)与布局表热插拔感知均在桌面会话层,
//! trait 面零感知(05 §3.5)。

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use conex_shared::frame::{
    Frame, FrameFormat, FramePolicy, FrameRate, FrameSource, FrameSourceError, FrameSourceStatus,
    FrameStream,
};
use tokio::sync::watch;

use crate::screen::{CapturedFrame, ScreenCapture};

/// 截屏产源抽象(最小注入面:生产为 ScreenCapture 适配,测试为 mock)
pub trait FrameProducer: Send {
    /// 捕获并编码一帧(布局刷新 / 重试为实现内语义;失败返回设备面错误)
    fn capture(&mut self) -> Result<CapturedFrame, String>;
}

/// ScreenCapture 适配:直接委托(布局刷新与重试已在 screen.rs 内)
#[cfg(windows)]
impl FrameProducer for ScreenCapture {
    fn capture(&mut self) -> Result<CapturedFrame, String> {
        ScreenCapture::capture(self)
    }
}

/// 事件驱动档的后台线程休眠粒度(毫秒):不轮询,仅细粒度响应停止
const EVENT_DRIVEN_POLL_MS: u64 = 50;

/// 轮询间隔映射(纯函数,可单测):
/// EventDriven = None(事件驱动不轮询);Low ≈ 2fps、Interactive ≈ 4fps、
/// Burst ≈ 10fps(05 §3.5「Low/Interactive = 2-5fps 轮询档」)。
pub fn rate_to_interval_ms(rate: FrameRate) -> Option<u64> {
    match rate {
        FrameRate::EventDriven => None,
        FrameRate::Low => Some(500),
        FrameRate::Interactive => Some(250),
        FrameRate::Burst => Some(100),
    }
}

/// 桌面帧源:包装截屏产源;latest-slot 背压 + watch 通道唤醒。
///
/// 生命周期(05 §3.2 契约):Idle → Active(重复 start 拒绝)→ Idle(幂等停止);
/// 停帧后订阅流仍可排空已入队帧(至多一帧),排空后返回 `Closed`。
pub struct DesktopCaptureSource {
    inner: Arc<Inner>,
}

struct Inner {
    status: AtomicU8,
    policy: Mutex<Option<FramePolicy>>,
    producer: Mutex<Box<dyn FrameProducer>>,
    /// 帧槽发送端(latest-slot;stop 时取走即关闭通道)
    tx: Mutex<Option<watch::Sender<Frame>>>,
    /// 独占订阅接收端(同 FrameReceiver 契约)
    rx: Mutex<Option<watch::Receiver<Frame>>>,
    subscribed: AtomicBool,
    stop: AtomicBool,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    seq: AtomicU64,
}

impl Inner {
    /// 当前状态投影
    fn status(&self) -> FrameSourceStatus {
        match self.status.load(Ordering::SeqCst) {
            0 => FrameSourceStatus::Idle,
            1 => FrameSourceStatus::Starting,
            2 => FrameSourceStatus::Active,
            _ => FrameSourceStatus::Stopping,
        }
    }

    /// 当前策略(未 start 时取防御默认:PNG 事件驱动)
    fn policy(&self) -> FramePolicy {
        self.policy
            .lock()
            .expect("策略槽锁损坏")
            .unwrap_or(FramePolicy {
                rate: FrameRate::EventDriven,
                format: FrameFormat::Png,
                quality: None,
            })
    }

    /// 单帧直捕:锁产源捕获 → 序号推进 → 共享帧转换(PNG 原生;JPEG 降级记录日志)
    fn capture_once(&self) -> Result<Frame, String> {
        let captured = self.producer.lock().expect("产源锁损坏").capture()?;
        let policy = self.policy();
        if policy.format != FrameFormat::Png {
            tracing::warn!(
                format = ?policy.format,
                "桌面产源仅支持 PNG,格式请求降级为 Png(05 §9 问题 7 降级语义)"
            );
        }
        Ok(Frame {
            seq: self.seq.fetch_add(1, Ordering::SeqCst) + 1,
            width: captured.width,
            height: captured.height,
            format: FrameFormat::Png,
            data: captured.data,
        })
    }

    /// 推帧入槽(覆盖旧帧,丢旧保新)
    fn push_frame(&self, frame: &Frame) {
        if let Some(tx) = self.tx.lock().expect("帧槽锁损坏").as_ref() {
            // watch send 恒成功(单槽覆盖);无接收端时忽略
            let _ = tx.send(frame.clone());
        }
    }

    /// 当前轮询间隔(EventDriven → None)
    fn current_interval(&self) -> Option<u64> {
        rate_to_interval_ms(self.policy().rate)
    }
}

impl DesktopCaptureSource {
    /// 新建桌面帧源(包装截屏产源;未启动前状态为 Idle)
    pub fn new(producer: Box<dyn FrameProducer>) -> Self {
        // 占位帧(seq=0)仅用于满足 watch 初值;消费端以 seq 判定新帧
        let placeholder = Frame {
            seq: 0,
            width: 0,
            height: 0,
            format: FrameFormat::Png,
            data: Vec::new(),
        };
        let (tx, rx) = watch::channel(placeholder);
        Self {
            inner: Arc::new(Inner {
                status: AtomicU8::new(0),
                policy: Mutex::new(None),
                producer: Mutex::new(producer),
                tx: Mutex::new(Some(tx)),
                rx: Mutex::new(Some(rx)),
                subscribed: AtomicBool::new(false),
                stop: AtomicBool::new(false),
                thread: Mutex::new(None),
                seq: AtomicU64::new(0),
            }),
        }
    }

    /// 当前生效策略(未 start 为防御默认)
    pub fn policy(&self) -> FramePolicy {
        self.inner.policy()
    }
}

/// 捕获循环(后台线程):轮询档按帧率间隔循环捕获;EventDriven 档不轮询,
/// 仅以细粒度休眠响应停止。捕获失败(瞬时设备抖动)记录日志后下一轮重试。
fn capture_loop(inner: Arc<Inner>) {
    loop {
        if inner.stop.load(Ordering::SeqCst) {
            break;
        }
        let interval = match inner.current_interval() {
            Some(ms) => ms,
            None => {
                std::thread::sleep(Duration::from_millis(EVENT_DRIVEN_POLL_MS));
                continue;
            }
        };
        match inner.capture_once() {
            Ok(frame) => inner.push_frame(&frame),
            Err(e) => {
                tracing::warn!(error = %e, "轮询捕获失败,下一轮重试");
            }
        }
        sleep_chunked(&inner, interval);
    }
}

/// 分片休眠:每 50ms 检查一次停止旗,保证 stop 延迟 ≤ 片粒度
fn sleep_chunked(inner: &Inner, ms: u64) {
    let mut remaining = ms;
    while remaining > 0 && !inner.stop.load(Ordering::SeqCst) {
        let chunk = remaining.min(50);
        std::thread::sleep(Duration::from_millis(chunk));
        remaining -= chunk;
    }
}

#[async_trait]
impl FrameSource for DesktopCaptureSource {
    async fn start(&self, policy: FramePolicy) -> Result<(), FrameSourceError> {
        if self.inner.status() != FrameSourceStatus::Idle {
            return Err(FrameSourceError::AlreadyActive);
        }
        self.inner
            .status
            .store(FrameSourceStatus::Starting as u8, Ordering::SeqCst);
        *self.inner.policy.lock().expect("策略槽锁损坏") = Some(policy);
        let handle = std::thread::spawn({
            let inner = self.inner.clone();
            move || capture_loop(inner)
        });
        *self.inner.thread.lock().expect("线程槽锁损坏") = Some(handle);
        self.inner
            .status
            .store(FrameSourceStatus::Active as u8, Ordering::SeqCst);
        Ok(())
    }

    async fn stop(&self) -> Result<(), FrameSourceError> {
        if self.inner.status() == FrameSourceStatus::Idle {
            // 幂等:未启动时直接返回 Ok
            return Ok(());
        }
        self.inner
            .status
            .store(FrameSourceStatus::Stopping as u8, Ordering::SeqCst);
        self.inner.stop.store(true, Ordering::SeqCst);
        // 等待捕获线程退出(最长一个轮询间隔 + 单次捕获耗时,见 capture_loop)
        if let Some(handle) = self.inner.thread.lock().expect("线程槽锁损坏").take() {
            let _ = handle.join();
        }
        // 取走发送端关闭通道 → 订阅流排空后返回 Closed
        self.inner.tx.lock().expect("帧槽锁损坏").take();
        self.inner
            .status
            .store(FrameSourceStatus::Idle as u8, Ordering::SeqCst);
        Ok(())
    }

    fn subscribe(&self) -> Result<Box<dyn FrameStream>, FrameSourceError> {
        if self.inner.subscribed.swap(true, Ordering::SeqCst) {
            return Err(FrameSourceError::Failed(
                "重复订阅(独占消费契约)".to_string(),
            ));
        }
        let rx = self
            .inner
            .rx
            .lock()
            .expect("订阅槽锁损坏")
            .take()
            .ok_or_else(|| FrameSourceError::Failed("订阅句柄缺失".to_string()))?;
        Ok(Box::new(DesktopFrameStream { rx, last_seq: 0 }))
    }

    async fn request_sync_frame(&self) -> Result<Frame, FrameSourceError> {
        if self.inner.status() != FrameSourceStatus::Active {
            return Err(FrameSourceError::NotActive);
        }
        let frame = self
            .inner
            .capture_once()
            .map_err(FrameSourceError::Failed)?;
        self.inner.push_frame(&frame);
        Ok(frame)
    }

    fn set_frame_policy(&self, policy: FramePolicy) {
        *self.inner.policy.lock().expect("策略槽锁损坏") = Some(policy);
        // 运行期调档:轮询间隔在下一次循环迭代生效;事件驱动 ↔ 轮询档切换即时生效
    }

    fn status(&self) -> FrameSourceStatus {
        self.inner.status()
    }
}

/// 桌面帧流:独占持有 watch 接收端,以 seq 判定新帧
struct DesktopFrameStream {
    rx: watch::Receiver<Frame>,
    last_seq: u64,
}

#[async_trait]
impl FrameStream for DesktopFrameStream {
    async fn next_frame(&mut self) -> Result<Frame, FrameSourceError> {
        loop {
            // 先读槽位:latest-slot 语义下「已入队帧」至多一帧
            let current = self.rx.borrow_and_update().clone();
            if current.seq > self.last_seq {
                self.last_seq = current.seq;
                return Ok(current);
            }
            match self.rx.changed().await {
                Ok(_) => continue,
                Err(_) => {
                    // 源已停止(发送端关闭):排空最后一帧后返回 Closed
                    let last = self.rx.borrow_and_update().clone();
                    if last.seq > self.last_seq {
                        self.last_seq = last.seq;
                        return Ok(last);
                    }
                    return Err(FrameSourceError::Closed);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;

    use super::*;

    /// 阻塞执行器:current-thread 运行时驱动 trait 异步方法(测试专用)
    fn block_on<F: Future>(fut: F) -> F::Output {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("测试运行时构建失败");
        rt.block_on(fut)
    }

    /// mock 产源:按队列逐帧产出;空队列或 fail 时返回错误;捕获次数经共享计数
    struct MockProducer {
        frames: std::collections::VecDeque<CapturedFrame>,
        fail: bool,
        calls: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl MockProducer {
        fn new(frames: Vec<CapturedFrame>) -> Self {
            Self {
                frames: frames.into(),
                fail: false,
                calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            }
        }

        fn failing() -> Self {
            Self {
                frames: std::collections::VecDeque::new(),
                fail: true,
                calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            }
        }
    }

    impl FrameProducer for MockProducer {
        fn capture(&mut self) -> Result<CapturedFrame, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err("mock 产源失败".to_string());
            }
            self.frames
                .pop_front()
                .ok_or_else(|| "mock 产源帧队列已空".to_string())
        }
    }

    /// 构造测试帧
    fn frame(seq: u64, width: u32, height: u32) -> CapturedFrame {
        CapturedFrame {
            seq,
            width,
            height,
            data: format!("frame-{seq}").into_bytes(),
        }
    }

    /// 默认测试策略:事件驱动 + PNG(不轮询,生命周期测试确定性)
    fn event_driven_policy() -> FramePolicy {
        FramePolicy {
            rate: FrameRate::EventDriven,
            format: FrameFormat::Png,
            quality: None,
        }
    }

    #[test]
    fn rate_to_interval_mapping() {
        assert_eq!(rate_to_interval_ms(FrameRate::EventDriven), None);
        assert_eq!(rate_to_interval_ms(FrameRate::Low), Some(500));
        assert_eq!(rate_to_interval_ms(FrameRate::Interactive), Some(250));
        assert_eq!(rate_to_interval_ms(FrameRate::Burst), Some(100));
    }

    #[test]
    fn lifecycle_start_stop_state_machine() {
        let source =
            DesktopCaptureSource::new(Box::new(MockProducer::new(vec![frame(1, 100, 50)])));
        assert_eq!(source.status(), FrameSourceStatus::Idle);
        block_on(source.start(event_driven_policy())).expect("启动失败");
        assert_eq!(source.status(), FrameSourceStatus::Active);
        block_on(source.stop()).expect("停止失败");
        assert_eq!(source.status(), FrameSourceStatus::Idle);
    }

    #[test]
    fn duplicate_start_rejected() {
        let source =
            DesktopCaptureSource::new(Box::new(MockProducer::new(vec![frame(1, 100, 50)])));
        block_on(source.start(event_driven_policy())).expect("首次启动失败");
        assert!(matches!(
            block_on(source.start(event_driven_policy())),
            Err(FrameSourceError::AlreadyActive)
        ));
        block_on(source.stop()).expect("停止失败");
    }

    #[test]
    fn stop_is_idempotent() {
        let source = DesktopCaptureSource::new(Box::new(MockProducer::new(vec![])));
        assert!(block_on(source.stop()).is_ok());
    }

    #[test]
    fn request_sync_frame_requires_active() {
        let source =
            DesktopCaptureSource::new(Box::new(MockProducer::new(vec![frame(1, 100, 50)])));
        assert!(matches!(
            block_on(source.request_sync_frame()),
            Err(FrameSourceError::NotActive)
        ));
    }

    #[test]
    fn request_sync_frame_produces_png_frame() {
        let source =
            DesktopCaptureSource::new(Box::new(MockProducer::new(vec![frame(1, 1366, 768)])));
        block_on(source.start(event_driven_policy())).expect("启动失败");
        let f = block_on(source.request_sync_frame()).expect("回显失败");
        assert_eq!(f.seq, 1);
        assert_eq!((f.width, f.height), (1366, 768));
        assert_eq!(f.format, FrameFormat::Png);
        assert_eq!(f.data, b"frame-1");
        block_on(source.stop()).expect("停止失败");
    }

    #[test]
    fn request_sync_frame_jpeg_request_degraded_to_png() {
        // 05 §9 问题 7:JPEG 请求降级为 PNG(产源恒 PNG,记录日志)
        let source = DesktopCaptureSource::new(Box::new(MockProducer::new(vec![frame(1, 10, 10)])));
        let policy = FramePolicy {
            rate: FrameRate::EventDriven,
            format: FrameFormat::Jpeg,
            quality: Some(70),
        };
        block_on(source.start(policy)).expect("启动失败");
        let f = block_on(source.request_sync_frame()).expect("回显失败");
        assert_eq!(f.format, FrameFormat::Png, "JPEG 请求应降级为 PNG");
        block_on(source.stop()).expect("停止失败");
    }

    #[test]
    fn request_sync_frame_capture_failure_maps_to_failed() {
        let source = DesktopCaptureSource::new(Box::new(MockProducer::failing()));
        block_on(source.start(event_driven_policy())).expect("启动失败");
        assert!(matches!(
            block_on(source.request_sync_frame()),
            Err(FrameSourceError::Failed(_))
        ));
        block_on(source.stop()).expect("停止失败");
    }

    #[test]
    fn subscribe_is_exclusive() {
        let source = DesktopCaptureSource::new(Box::new(MockProducer::new(vec![frame(1, 10, 10)])));
        let _first = source.subscribe().expect("首次订阅失败");
        assert!(matches!(
            source.subscribe(),
            Err(FrameSourceError::Failed(_))
        ));
    }

    #[test]
    fn latest_slot_drops_old_frames() {
        // 丢旧保新:两次回显入槽,订阅流只读到最新帧(seq=2)
        let source = DesktopCaptureSource::new(Box::new(MockProducer::new(vec![
            frame(1, 10, 10),
            frame(2, 10, 10),
        ])));
        block_on(source.start(event_driven_policy())).expect("启动失败");
        block_on(source.request_sync_frame()).expect("第一次回显失败");
        block_on(source.request_sync_frame()).expect("第二次回显失败");
        let mut stream = source.subscribe().expect("订阅失败");
        let f = block_on(stream.next_frame()).expect("取帧失败");
        assert_eq!(f.seq, 2, "latest-slot 应丢旧保新,只读到最新帧");
        block_on(source.stop()).expect("停止失败");
    }

    #[test]
    fn stop_drains_last_frame_then_closed() {
        // 停帧后订阅流仍可排空已入队帧(至多一帧),再取返回 Closed
        let source = DesktopCaptureSource::new(Box::new(MockProducer::new(vec![frame(1, 10, 10)])));
        block_on(source.start(event_driven_policy())).expect("启动失败");
        block_on(source.request_sync_frame()).expect("回显失败");
        let mut stream = source.subscribe().expect("订阅失败");
        let f = block_on(stream.next_frame()).expect("排空失败");
        assert_eq!(f.seq, 1);
        block_on(source.stop()).expect("停止失败");
        assert!(matches!(
            block_on(stream.next_frame()),
            Err(FrameSourceError::Closed)
        ));
    }

    #[test]
    fn polling_capture_loop_reacts_to_stop() {
        // 轮询档(Low)启动后产源至少被捕获一次;stop 后线程退出
        let producer = MockProducer::new(vec![frame(1, 10, 10); 8]);
        let calls = producer.calls.clone();
        let source = DesktopCaptureSource::new(Box::new(producer));
        let policy = FramePolicy {
            rate: FrameRate::Low,
            format: FrameFormat::Png,
            quality: None,
        };
        block_on(source.start(policy)).expect("启动失败");
        // 等待首轮捕获(轮询间隔 500ms 内必然发生)
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while calls.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(calls.load(Ordering::SeqCst) > 0, "轮询档应触发捕获");
        block_on(source.stop()).expect("停止失败");
    }

    #[test]
    fn set_frame_policy_persisted() {
        let source = DesktopCaptureSource::new(Box::new(MockProducer::new(vec![frame(1, 10, 10)])));
        block_on(source.start(event_driven_policy())).expect("启动失败");
        let burst = FramePolicy {
            rate: FrameRate::Burst,
            format: FrameFormat::Png,
            quality: None,
        };
        source.set_frame_policy(burst);
        assert_eq!(source.policy(), burst);
        block_on(source.stop()).expect("停止失败");
    }

    #[test]
    fn desktop_capture_source_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<DesktopCaptureSource>();
    }
}
