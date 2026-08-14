//! 输入注入管线（维度 12 §4：单通道保序互斥 + no-wait 快速路径 + 版本推进）
//!
//! - **单消费者保序互斥**：全部 `InputCmd` 经有界 mpsc 排队，消费端串行派发——
//!   同一时刻单事件在途（互斥），先入先出（保序：press 不会越过 release，
//!   §4.1「socket 互斥保序」的管线侧实现；wire 层另有传输 socket 互斥兜底）；
//! - **no-wait 快速路径（P1-A 遗留 2/2）**：`dispatch` 入队即返回，消费端
//!   经 `send_page_no_wait` 写入 CDP socket 即视为注入成功（bump 前提），
//!   不等待 CDP 响应（agent-browser websocket.rs:609-615 语义；修复前消费端
//!   走统一发送层等响应，Silent/慢回包会占住队列）；自然背压由有界队列承担
//!   （队列满时调用方挂起排队，不丢弃——输入事件与帧不同，不能丢）；
//! - **版本推进（R-1/U-1）**：注入成功 → `bump(tab_id, InputInjected)` 即时
//!   +1（任何来源的注入都推进——用户与 AI 统一；不直接改版本号，聚合/导航
//!   优先逻辑归维度 11 单一权威）；
//! - **与 AI 动作共用（§4.1 单通道）**：复用 BrowserSession 统一发送层
//!   （approval/audit/abort 同一管线）；吊销链（维度 15 Coordinator）与输入
//!   互不阻塞（M-1：no-wait 不阻塞吊销，吊销不串行化输入）；
//! - **800ms 稳定窗语义落点（T-12，审计 A P1-2）**：`TOKEN_MIN_STABLE_WINDOW`
//!   （维度 15，800ms，统一常量）由**前端 panelStatusMachine 接管显示态**
//!   （panelStatusMachine.ts:30 `TOKEN_MIN_STABLE_WINDOW_MS` + usePanelStatus
//!   800ms 过渡定时，U-9）承担；**吊销执行面**由引擎 estop/abort 承担
//!   （cdp/sender.rs 五段管线②急停旗拒绝新命令 + abort_token 取消在途，
//!   M-2）；本管线注入即 bump 版本推进（R-1/U-1，快照失效感知层）。MVP
//!   粗粒度协同（22 §8.2 M8：动作前快照校验 + 用户可停）**无独立令牌稳定
//!   窗**；若未来实现维度 15 Coordinator 令牌机制（collab/token.rs 设计：
//!   TokenHolder/RevokeSource/稳定窗去抖），扩展点 = 本管线注入成功处
//!   （`consumer_loop` bump 点）挂吊销回调，M-1 不阻塞约束不变。
//! - 键盘归一化：用户路径 key/code/VK 直取浏览器事件（§3.3）；AI 路径键名
//!   查表复用 `action/keyboard.rs::lookup_key`（见 mod.rs 测试断言）。

use crate::cdp::bus::VersionReason;
use crate::cdp::error::CdpError;
use crate::BrowserSession;
use crate::SessionRef;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

use super::{to_cdp, InputCmd};

/// 输入队列容量（有界背压：满时 dispatch 挂起排队，不丢弃）。
pub const INPUT_QUEUE_CAPACITY: usize = 1024;
/// 单事件命令超时（no-wait 落地后管线内部不再使用，保留导出兼容外部引用）。
pub const INPUT_CMD_TIMEOUT: Duration = Duration::from_secs(5);

/// 输入管线统计快照。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InputStats {
    /// 已派发命令数（入队）。
    pub dispatched: u64,
    /// 注入成功数（CDP 发送成功 + bump 已推进）。
    pub injected: u64,
    /// 注入失败数（无活动标签/发送失败）。
    pub failed: u64,
}

/// 输入管线错误。
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum InputError {
    /// 无活动标签会话（注入前置条件）。
    #[error("无活动标签会话")]
    NoActiveTab,
    /// CDP 发送失败（含断连；事件未注入，版本不推进）。
    #[error("输入注入发送失败：{message}")]
    SendFailed { message: String },
    /// 管线已销毁（消费任务终止）。
    #[error("输入管线已关闭")]
    QueueClosed,
}

/// 统计原子面（派发方与消费任务共享）。
struct StatsInner {
    dispatched: AtomicU64,
    injected: AtomicU64,
    failed: AtomicU64,
}

impl Default for StatsInner {
    fn default() -> Self {
        StatsInner {
            dispatched: AtomicU64::new(0),
            injected: AtomicU64::new(0),
            failed: AtomicU64::new(0),
        }
    }
}

/// 活动钩子（可选）：注入成功后回调（app 侧接线：帧率升降档 input_active /
/// 维度 15 用户输入上报）。
type ActivityHook = Arc<dyn Fn() + Send + Sync>;

/// 队列信封（命令 + 完成通知）。
struct Envelope {
    seq: u64,
    cmd: InputCmd,
    done: oneshot::Sender<Result<(), InputError>>,
}

/// 输入注入管线（唯一注入面：用户路径与 AI 路径共用）。
pub struct InputPipeline {
    session: Arc<BrowserSession>,
    tx: mpsc::Sender<Envelope>,
    stats: Arc<StatsInner>,
    activity: Arc<Mutex<Option<ActivityHook>>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Drop for InputPipeline {
    /// 收尾（M3）：终止消费任务（任务不持有 Arc<Self> 自保活）。
    fn drop(&mut self) {
        if let Some(t) = self.task.lock().unwrap_or_else(|p| p.into_inner()).take() {
            t.abort();
        }
    }
}

impl InputPipeline {
    /// 新建管线（启动单消费者任务；先订阅后注入——消费任务对发送面
    /// 的调用顺序即用户操作顺序）。
    pub fn new(session: Arc<BrowserSession>) -> Arc<Self> {
        let (tx, rx) = mpsc::channel(INPUT_QUEUE_CAPACITY);
        let stats = Arc::new(StatsInner::default());
        let activity: Arc<Mutex<Option<ActivityHook>>> = Arc::new(Mutex::new(None));
        let task = tokio::spawn(consumer_loop(
            rx,
            session.clone(),
            stats.clone(),
            activity.clone(),
        ));
        Arc::new(InputPipeline {
            session,
            tx,
            stats,
            activity,
            task: Mutex::new(Some(task)),
        })
    }

    /// 派发输入命令（no-wait 快速路径：入队即返回，不等 CDP 响应）。
    ///
    /// 返回时机 = 命令已写入 CDP socket（或失败）；版本推进（bump 即时 +1）
    /// 在返回前完成。
    pub async fn dispatch(&self, cmd: InputCmd) -> Result<(), InputError> {
        let seq = self.stats.dispatched.fetch_add(1, Ordering::SeqCst) + 1;
        let (done_tx, done_rx) = oneshot::channel();
        self.tx
            .send(Envelope {
                seq,
                cmd,
                done: done_tx,
            })
            .await
            .map_err(|_| InputError::QueueClosed)?;
        done_rx.await.map_err(|_| InputError::QueueClosed)?
    }

    /// 统计快照。
    pub fn stats(&self) -> InputStats {
        InputStats {
            dispatched: self.stats.dispatched.load(Ordering::Relaxed),
            injected: self.stats.injected.load(Ordering::Relaxed),
            failed: self.stats.failed.load(Ordering::Relaxed),
        }
    }

    /// 挂接活动钩子（注入成功后回调；app 侧接线 input_active / 维度 15 上报）。
    pub fn attach_activity(&self, hook: ActivityHook) {
        *self.activity.lock().unwrap_or_else(|p| p.into_inner()) = Some(hook);
    }

    /// 底层会话引用（app 侧接线面）。
    pub fn session(&self) -> &Arc<BrowserSession> {
        &self.session
    }
}

/// 消费循环：串行派发（同一时刻单事件写入 wire）+ 注入成功 → bump 即时 +1。
async fn consumer_loop(
    mut rx: mpsc::Receiver<Envelope>,
    session: Arc<BrowserSession>,
    stats: Arc<StatsInner>,
    activity: Arc<Mutex<Option<ActivityHook>>>,
) {
    while let Some(env) = rx.recv().await {
        let result = send_cdp(&session, &env.cmd).await;
        match &result {
            Ok(sref) => {
                // R-1/U-1：输入注入即时 +1（per-tab；任何来源的注入都推进）
                session.bump(&sref.target_id, VersionReason::InputInjected);
                stats.injected.fetch_add(1, Ordering::Relaxed);
                if let Some(hook) = activity.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
                    hook();
                }
            }
            Err(e) => {
                tracing::debug!("输入命令 {} 注入失败：{e}", env.seq);
                stats.failed.fetch_add(1, Ordering::Relaxed);
            }
        }
        let _ = env.done.send(result.map(|_| ()));
    }
}

/// 单命令 CDP 派发：解析活动会话 → 归一化 → no-wait 发送（写入 socket 即
/// 返回，不等待响应；P1-A 遗留 2/2 切换点）。
async fn send_cdp(session: &BrowserSession, cmd: &InputCmd) -> Result<SessionRef, InputError> {
    let sref = session
        .current_session()
        .map_err(|_| InputError::NoActiveTab)?;
    let (method, params) = to_cdp(cmd);
    session
        .send_page_no_wait(&sref.session, method, params)
        .await
        .map_err(|e: CdpError| InputError::SendFailed {
            message: e.to_string(),
        })?;
    Ok(sref)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::bus::{BrowserEvent, VersionReason};
    use crate::cdp::mock::{MockReply, MockServer};
    use crate::cdp::sender::{
        ApprovalDenied, BrowserAuditEvent, CancellationToken, CdpCommandView, IdKey,
    };
    use crate::cdp::transport::{CdpEndpoint, ExpectedBrowser};
    use async_trait::async_trait;
    use futures_util::future::join_all;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

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

    /// 组装：mock 会话 + 输入命令自动应答 + 活动标签就绪。
    async fn setup() -> (MockServer, Arc<BrowserSession>) {
        let mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        mock.set_auto_reply("Input.dispatchMouseEvent", MockReply::Ok(json!({})));
        mock.set_auto_reply("Input.dispatchKeyEvent", MockReply::Ok(json!({})));
        mock.set_auto_reply("Input.insertText", MockReply::Ok(json!({})));

        let session = Arc::new(
            BrowserSession::connect(
                CdpEndpoint {
                    port: mock.addr.port(),
                    ws_path: "/devtools/browser/input-test".to_string(),
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

    fn mouse_move(x: f64) -> InputCmd {
        InputCmd::MouseMove {
            x,
            y: 0.0,
            button: crate::input::InputButton::None,
            buttons: 0,
            modifiers: 0,
        }
    }

    /// 保序（§4.1）：30 个派发任务并发注入 → wire 上按入队序到达
    /// （同一时刻单事件在途，press 不会越过 move）。
    #[tokio::test]
    async fn pipeline_concurrent_dispatch_keeps_order() {
        let (mut mock, session) = setup().await;
        let pipeline = InputPipeline::new(session.clone());

        // 并发派发（调用方不等 CDP 响应——no-wait 快速路径）；
        // join_all 按列表序轮询 → 入队序确定（0..29）
        let mut futures = Vec::new();
        for i in 0..30u32 {
            futures.push(pipeline.dispatch(mouse_move(f64::from(i))));
        }
        let results = join_all(futures).await;
        for r in results {
            r.expect("命令失败");
        }
        // 按派发序消费 wire：x 严格递增
        for i in 0..30u32 {
            let cmd = mock.expect_command("Input.dispatchMouseEvent").await;
            let x = cmd["params"]["x"].as_f64().unwrap();
            assert_eq!(x, f64::from(i), "第 {i} 条命令 x 必须按派发序");
        }
        assert_eq!(pipeline.stats().injected, 30);
        assert_eq!(pipeline.stats().failed, 0);

        session.shutdown().await;
    }

    /// no-wait 快速路径（P1-A 遗留 2/2）：mock 不回包（Silent，模拟延迟/无
    /// 响应）时命令仍全部到达 wire 且派发全部成功返回——消费端不等待 CDP
    /// 响应；wire 保序不丢（输入事件不丢弃）。
    #[tokio::test]
    async fn pipeline_no_wait_does_not_wait_for_reply() {
        let (mut mock, session) = setup().await;
        let pipeline = InputPipeline::new(session.clone());

        // 输入命令不回包：no-wait 不等响应，命令逐条落地（修复前会卡在第 1 条）
        mock.set_auto_reply("Input.dispatchMouseEvent", MockReply::Silent);
        let baseline = mock.commands_seen();
        for x in 1..=3u64 {
            pipeline
                .dispatch(mouse_move(x as f64))
                .await
                .expect("no-wait 派发应成功");
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        while mock.commands_seen() < baseline + 3 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            mock.commands_seen(),
            baseline + 3,
            "不回包时命令也应全部落地（no-wait）"
        );
        // wire 保序：x = 1, 2, 3
        for i in 1..=3u64 {
            let cmd = mock.expect_command("Input.dispatchMouseEvent").await;
            assert_eq!(cmd["params"]["x"], i as f64, "第 {i} 条命令按派发序");
        }
        // 写入 socket 即视为注入成功：版本推进
        assert_eq!(pipeline.stats().injected, 3);
        assert_eq!(pipeline.stats().failed, 0);
        assert_eq!(session.snapshot_version(&"T1".to_string()), 3);

        session.shutdown().await;
    }

    /// 版本推进（R-1/U-1）：注入成功 → bump 即时 +1（每事件 +1，
    /// InputInjected 原因广播，per-tab）。
    #[tokio::test]
    async fn pipeline_bump_immediate_on_injection() {
        let (mock, session) = setup().await;
        let pipeline = InputPipeline::new(session.clone());
        let mut rx = session.subscribe();
        let _ = mock;

        assert_eq!(session.snapshot_version(&"T1".to_string()), 0);
        pipeline
            .dispatch(InputCmd::Text {
                text: "你好".to_string(),
            })
            .await
            .expect("注入失败");
        assert_eq!(
            session.snapshot_version(&"T1".to_string()),
            1,
            "注入成功即时 +1（无聚合窗，U-1）"
        );
        pipeline.dispatch(mouse_move(5.0)).await.expect("注入失败");
        pipeline.dispatch(mouse_move(6.0)).await.expect("注入失败");
        assert_eq!(session.snapshot_version(&"T1".to_string()), 3, "每事件 +1");

        // 原因断言：VersionAdvanced(InputInjected)
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        let mut saw = 0u32;
        while saw < 3 && tokio::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(BrowserEvent::VersionAdvanced {
                    tab_id,
                    reason: VersionReason::InputInjected,
                    ..
                }) if tab_id == "T1" => saw += 1,
                Ok(_) => {}
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        }
        assert_eq!(saw, 3, "三次注入三次 InputInjected 广播");
        assert!(
            session.validate_snapshot(&"T1".to_string(), 1).is_err(),
            "旧版本 Stale"
        );
        assert!(session.validate_snapshot(&"T1".to_string(), 3).is_ok());

        session.shutdown().await;
    }

    /// IME 文本透传（§3.7）：compositionend 整串 insertText（含 surrogate pair）。
    #[tokio::test]
    async fn pipeline_ime_insert_text_passthrough() {
        let (mut mock, session) = setup().await;
        let pipeline = InputPipeline::new(session.clone());

        pipeline
            .dispatch(InputCmd::Text {
                text: "你好世界🙂".to_string(),
            })
            .await
            .expect("IME 注入失败");
        let cmd = mock.expect_command("Input.insertText").await;
        assert_eq!(cmd["params"]["text"], "你好世界🙂");
        assert_eq!(pipeline.stats().injected, 1);

        session.shutdown().await;
    }

    /// 键盘归一化（§3.3）：可打印字符 keyDown 携带 text；keyUp 无 text；
    /// 组合键掩码透传（Ctrl+A 全选语义）。
    #[tokio::test]
    async fn pipeline_key_down_up_sequence() {
        let (mut mock, session) = setup().await;
        let pipeline = InputPipeline::new(session.clone());

        pipeline
            .dispatch(InputCmd::KeyDown {
                key: Some("a".to_string()),
                code: Some("KeyA".to_string()),
                text: Some("a".to_string()),
                unmodified_text: Some("a".to_string()),
                windows_virtual_key_code: 65,
                native_virtual_key_code: None,
                auto_repeat: false,
                modifiers: 0,
                location: 0,
            })
            .await
            .expect("keyDown 失败");
        pipeline
            .dispatch(InputCmd::KeyUp {
                key: Some("a".to_string()),
                code: Some("KeyA".to_string()),
                windows_virtual_key_code: 65,
                native_virtual_key_code: None,
                modifiers: 0,
                location: 0,
            })
            .await
            .expect("keyUp 失败");
        pipeline
            .dispatch(InputCmd::KeyDown {
                key: Some("A".to_string()),
                code: Some("KeyA".to_string()),
                text: None,
                unmodified_text: None,
                windows_virtual_key_code: 65,
                native_virtual_key_code: None,
                auto_repeat: false,
                modifiers: 2,
                location: 0,
            })
            .await
            .expect("组合键失败");

        let down = mock.expect_command("Input.dispatchKeyEvent").await;
        assert_eq!(down["params"]["type"], "keyDown");
        assert_eq!(down["params"]["text"], "a", "可打印字符携带 text");
        let up = mock.expect_command("Input.dispatchKeyEvent").await;
        assert_eq!(up["params"]["type"], "keyUp");
        assert!(up["params"].get("text").is_none(), "keyUp 无 text");
        let chord = mock.expect_command("Input.dispatchKeyEvent").await;
        assert_eq!(chord["params"]["modifiers"], 2, "Ctrl 掩码透传");
        assert!(chord["params"].get("text").is_none(), "组合键不做文本插入");

        session.shutdown().await;
    }

    /// 失败路径：断连后派发 → SendFailed（版本不推进）；活动钩子不触发。
    /// no-wait 无等待语义：断线感知后才能确定性失败（ConnectionLost 广播
    /// 前 writer 仍可写入 TCP 缓冲；重连退避 1s，广播后窗口内派发即可）。
    #[tokio::test]
    async fn pipeline_send_failure_no_bump() {
        let (mock, session) = setup().await;
        let pipeline = InputPipeline::new(session.clone());
        let mut rx = session.subscribe();
        let calls = Arc::new(AtomicUsize::new(0));
        let hook_calls = calls.clone();
        pipeline.attach_activity(Arc::new(move || {
            hook_calls.fetch_add(1, Ordering::SeqCst);
        }));

        assert_eq!(session.snapshot_version(&"T1".to_string()), 0);
        mock.close_connection();
        // 等 ConnectionLost（supervisor 广播前已清空 client：此后 no-wait 必失败）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(BrowserEvent::ConnectionLost { .. }) = rx.try_recv() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "应广播 ConnectionLost"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let err = pipeline
            .dispatch(mouse_move(1.0))
            .await
            .expect_err("断连应失败");
        assert!(
            matches!(err, InputError::SendFailed { .. }),
            "实际错误：{err}"
        );
        assert_eq!(
            session.snapshot_version(&"T1".to_string()),
            0,
            "失败不推进版本"
        );
        assert_eq!(pipeline.stats().failed, 1);
        assert_eq!(calls.load(Ordering::SeqCst), 0, "失败不触发活动钩子");

        session.shutdown().await;
    }

    /// 活动钩子：注入成功后触发（app 侧接线 input_active → 帧率升降档）。
    #[tokio::test]
    async fn pipeline_activity_hook_fires_on_injection() {
        let (mock, session) = setup().await;
        let pipeline = InputPipeline::new(session.clone());
        let calls = Arc::new(AtomicUsize::new(0));
        let hook_calls = calls.clone();
        pipeline.attach_activity(Arc::new(move || {
            hook_calls.fetch_add(1, Ordering::SeqCst);
        }));
        let _ = mock;

        pipeline.dispatch(mouse_move(1.0)).await.expect("注入失败");
        pipeline.dispatch(mouse_move(2.0)).await.expect("注入失败");
        assert_eq!(calls.load(Ordering::SeqCst), 2, "每次注入成功触发一次");

        session.shutdown().await;
    }
}
