//! 面板帧流控制器（P1-B1：帧下行 Tauri Channel + 帧状态事件）
//!
//! ## 传输选型（U-13 主控裁决，22-裁决与修订记录.md §7.4）
//! 帧流下行经 **Tauri Channel**（`tauri::ipc::Channel<Response>`，Raw 字节 →
//! 前端 ArrayBuffer，无 base64 膨胀）；输入上行经 Tauri invoke（browser_input，
//! 见 [crate::browser::panel_input]）。**不用 WS / 自定义 header token / Origin
//! 校验**——token 面由 Tauri IPC 权限模型天然覆盖，免额外监听端口（对齐 31
//! 安全基线），帧延迟同机 IPC 优于 loopback WS（U-13 理由①~④）。
//!
//! ## 帧二进制格式（对齐 12 文档 §2.2，小端定长头 + 变长负载）
//! ```text
//! 偏移 0-3   seq: u32     帧序号（前端丢帧统计/诊断用）
//! 偏移 4-7   width: u32   帧图宽度 px（deviceWidth）
//! 偏移 8-11  height: u32  帧图高度 px（deviceHeight）
//! 偏移 12+   JPEG 原始字节
//! ```
//! 前端解析见 apps/crish-desktop/src/components/workspace/browser-panel/frameProtocol.ts
//! （双端对齐，改动需同步）。
//!
//! ## P1-A 对接（并行实施已落地，2026-08）
//! 帧流数据面由 `conex_browser::frames::ScreencastSession` 承担（12 §9
//! screencast/pump.rs：帧泵 + ack pacing + fps 档位 + ConnectionRestored 恢复
//! + 去重 + 背压丢帧）。本控制器只做**传输层接线**（U-13 职责边界）：
//! - 生命周期：ScreencastSession **懒创建一次**（其 `new()` 独占消费
//!   `BusHandle.subscribe_frames()`，同一底层会话生命周期内不可重建）——
//!   随面板订阅 start/stop（可反复），随浏览器停止/重连释放（shutdown）；
//! - 转发：`ScreencastSession::subscribe_frames()`（sink 独占消费端，同样
//!   一次取走）→ 单飞转发任务 → `Channel<Response>`（无订阅者时通道为空，
//!   帧不下行，省资源）；
//! - 状态投影：订阅 → starting；首帧下行 → active；退订/启动失败/通道失效
//!   → stopped，经 `browser://frame-state-changed` 独立事件发射。
//!
//! ## 资源纪律（12 §1.1/§2.5，任务书「无订阅者不启帧流」）
//! - 单订阅者语义：帧只推送给当前订阅者；无订阅者时帧流不启动
//!   （ScreencastSession.start 不调用）；退订即停；浏览器停止/重连 →
//!   会话释放（shutdown：泵/监督任务终止，转发任务随 sink 关闭退出——
//!   不留僵尸重连）。

use crate::core_event_bridge::Emitter;
use conex_browser::frames::{FrameOut, ScreencastConfig, ScreencastSession};
use conex_browser::BrowserSession;
use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, Response};

/// 帧定长头长度（seq/width/height 各 u32，小端；12 §2.2）。
pub(crate) const FRAME_HEADER_LEN: usize = 12;

/// 帧流状态串（`browser://frame-state-changed` 事件口径 + browser_frame_status 返回）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FrameStreamState {
    /// 订阅已注册、startScreencast 已发出（或发送中），首帧未到
    Starting,
    /// 帧流泵运行中且已下行过帧（ScreencastSession Active 投影）
    Active,
    /// 未订阅 / 已退订 / 流终止（含启动失败、通道失效）
    Stopped,
}

impl FrameStreamState {
    /// 事件/载荷状态串（serde 契约：starting/active/stopped）。
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            FrameStreamState::Starting => "starting",
            FrameStreamState::Active => "active",
            FrameStreamState::Stopped => "stopped",
        }
    }
}

/// 帧编码：小端定长头 + JPEG 负载（12 §2.2 二进制格式，U-13 Channel 载荷）。
pub(crate) fn encode_frame(seq: u64, width: u32, height: u32, jpeg: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(FRAME_HEADER_LEN + jpeg.len());
    out.extend_from_slice(&(seq as u32).to_le_bytes());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(jpeg);
    out
}

/// 帧流控制器（BrowserSlot 字段；无订阅者不启帧流，省资源）。
///
/// 生命周期关系（与 P1-A ScreencastSession 的投影）：
/// - ScreencastSession 生命周期 == 底层 BrowserSession 生命周期（懒创建一次）；
/// - 订阅/退订 == start/stop（可反复）；浏览器停/重连 == release（shutdown）。
pub(crate) struct FrameStreamController {
    /// 帧流会话（懒创建：首次订阅时以当前底层会话构建；同一会话生命周期内
    /// 仅一个实例——new() 独占消费 BusHandle 帧通道）
    screencast: Mutex<Option<Arc<ScreencastSession>>>,
    /// 当前订阅通道（None = 无订阅者；转发任务每帧读取，空则不下行）
    channel: Mutex<Option<Channel<Response>>>,
    /// 转发任务（单飞：随会话生命周期常驻；帧输出 → Tauri Channel）
    forwarder: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// 事件发射器（与 BrowserSlot 共用 attach_emitter 接线）
    emitter: Mutex<Option<Arc<dyn Emitter>>>,
    /// 帧状态（0=stopped 1=starting 2=active；browser_frame_status 查询源）
    state: AtomicU8,
}

const STATE_STOPPED: u8 = 0;
const STATE_STARTING: u8 = 1;
const STATE_ACTIVE: u8 = 2;

impl FrameStreamController {
    pub(crate) fn new() -> Self {
        FrameStreamController {
            screencast: Mutex::new(None),
            channel: Mutex::new(None),
            forwarder: Mutex::new(None),
            emitter: Mutex::new(None),
            state: AtomicU8::new(STATE_STOPPED),
        }
    }

    /// 挂接事件发射器（`browser://frame-state-changed`）。
    pub(crate) fn attach_emitter(&self, emitter: Arc<dyn Emitter>) {
        *self.emitter.lock().unwrap_or_else(|p| p.into_inner()) = Some(emitter);
    }

    /// 当前帧状态（browser_frame_status 查询面）。
    pub(crate) fn state(&self) -> FrameStreamState {
        match self.state.load(Ordering::SeqCst) {
            STATE_STARTING => FrameStreamState::Starting,
            STATE_ACTIVE => FrameStreamState::Active,
            _ => FrameStreamState::Stopped,
        }
    }

    /// 订阅帧流（唯一订阅者语义：替换既有订阅——旧通道释放 → JS 端收到 end）。
    ///
    /// 懒创建 ScreencastSession（P1-A 帧泵；独占消费帧通道）+ start() +
    /// 单飞转发任务（sink 消费端一次取走）。
    pub(crate) async fn subscribe(self: &Arc<Self>, raw_session: Arc<BrowserSession>, channel: Channel<Response>) {
        // 替换既有订阅者：退订旧流（旧 channel 释放 → JS 端收到 end）
        self.unsubscribe().await;
        *self.channel.lock().unwrap_or_else(|p| p.into_inner()) = Some(channel);

        // 懒创建帧流会话（同一底层会话生命周期内仅一次；new() 独占帧通道）
        let screencast = {
            let mut slot = self.screencast.lock().unwrap_or_else(|p| p.into_inner());
            slot.get_or_insert_with(|| {
                tracing::debug!(target: "browser", "帧流会话懒创建（ScreencastSession）");
                Arc::new(ScreencastSession::new(
                    raw_session,
                    ScreencastConfig::default(),
                ))
            })
            .clone()
        };
        self.ensure_forwarder(&screencast);

        // 启动帧流（失败 → stopped + reason；转发任务保持驻留，可重试订阅）
        match screencast.start().await {
            Ok(()) => self.set_state(FrameStreamState::Starting, None),
            Err(error) => {
                tracing::warn!(target: "browser", error = %error, "帧流启动失败");
                self.set_state(FrameStreamState::Stopped, Some(format!("{error}")));
            }
        }
    }

    /// 退订帧流（停止帧泵；会话保留，可再次订阅）。
    pub(crate) async fn unsubscribe(&self) {
        let had_channel = self
            .channel
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
            .is_some();
        if let Some(screencast) = self.screencast_sync() {
            if had_channel {
                screencast.stop().await;
            }
        }
        self.set_state(FrameStreamState::Stopped, None);
    }

    /// 释放帧流会话（浏览器停止/重连路径）：shutdown（终止泵/监督任务 +
    /// 关闭输出槽）→ 转发任务随 sink 关闭退出（释放 Arc → 底层会话正常
    /// 回收，防僵尸重连）。
    pub(crate) fn release_session(&self) {
        *self.channel.lock().unwrap_or_else(|p| p.into_inner()) = None;
        let Some(screencast) = self
            .screencast
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        else {
            return;
        };
        // 统一走 tauri::async_runtime::spawn（全局 runtime 惰性初始化，同步/
        // 异步上下文均安全——同步 fn 内 tokio::spawn 在无 runtime 上下文会
        // panic "no reactor running"；与 tokio::spawn 语义一致，任务 detach
        // 运行，句柄不持有；与 52ba3165 R1-1 同类修复对齐）。
        tauri::async_runtime::spawn(async move {
            screencast.shutdown().await;
        });
        self.set_state(FrameStreamState::Stopped, None);
    }

    /// 用户输入信号（交互期升帧，12 §2.5：面板输入 → ScreencastSession
    /// 升 Interactive 档；无活跃帧流会话时 no-op）。
    pub(crate) fn on_user_input(&self) {
        if let Some(screencast) = self.screencast_sync() {
            screencast.mark_input();
        }
    }

    // ---------- 内部 ----------

    fn screencast_sync(&self) -> Option<Arc<ScreencastSession>> {
        self.screencast
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// 单飞转发任务：ScreencastSession 帧输出（sink 独占消费端，一次取走）
    /// → encode_frame → Channel 下行。首帧下行时状态转 active；通道失效
    /// （webview 关闭）→ stopped + 退出；会话释放（sink 关闭）→ 退出。
    fn ensure_forwarder(self: &Arc<Self>, screencast: &Arc<ScreencastSession>) {
        if self
            .forwarder
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
        {
            return;
        }
        let receiver = screencast.subscribe_frames();
        let ctrl = Arc::clone(self);
        // 同步 fn 内 tokio::spawn → tauri::async_runtime::spawn（全局 runtime
        // 惰性初始化，同步/异步上下文均安全；JoinHandle 语义不变，仅存字段
        // 做单飞判空，不 await）。
        let task = tauri::async_runtime::spawn(async move {
            loop {
                let Some(frame) = receiver.recv().await else {
                    break; // 会话释放（sink 关闭）
                };
                if !ctrl.forward_one(frame) {
                    break; // 通道失效
                }
            }
        });
        *self.forwarder.lock().unwrap_or_else(|p| p.into_inner()) = Some(task);
    }

    /// 单帧转发：无订阅者不下行（状态不变）；首帧下行转 active；
    /// 通道失败 → stopped + false。
    fn forward_one(&self, frame: FrameOut) -> bool {
        let channel = self
            .channel
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let Some(channel) = channel else {
            // 无订阅者（退订后残留帧）：不下行（资源纪律），状态不变
            return true;
        };
        // 状态投影：首帧下行 → active（ScreencastSession Active 的传输面投影）
        if self.state.load(Ordering::SeqCst) != STATE_ACTIVE {
            self.set_state(FrameStreamState::Active, None);
        }
        let payload = encode_frame(frame.seq, frame.width, frame.height, &frame.data);
        match channel.send(Response::new(payload)) {
            Ok(()) => true,
            Err(error) => {
                // 通道失效（webview 关闭/前端已退订）→ 停止（资源纪律）
                tracing::warn!(target: "browser", error = %error, "帧通道失效（停止转发）");
                self.set_state(FrameStreamState::Stopped, Some(format!("帧通道失效：{error}")));
                false
            }
        }
    }

    /// 状态迁移 + `browser://frame-state-changed` 发射（`{ state, reason? }`）。
    fn set_state(&self, state: FrameStreamState, reason: Option<String>) {
        self.state.store(
            match state {
                FrameStreamState::Starting => STATE_STARTING,
                FrameStreamState::Active => STATE_ACTIVE,
                FrameStreamState::Stopped => STATE_STOPPED,
            },
            Ordering::SeqCst,
        );
        let Some(emitter) = self
            .emitter
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
        else {
            return;
        };
        let payload = json!({
            "state": state.as_str(),
            "reason": reason,
        });
        let json = match serde_json::to_string(&payload) {
            Ok(json) => json,
            Err(error) => {
                tracing::error!(target: "browser", error = %error, "帧状态载荷序列化失败（跳过发射）");
                return;
            }
        };
        emitter.emit("browser://frame-state-changed", &json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_event_bridge::Emitter;
    use std::sync::mpsc as std_mpsc;
    use std::time::Duration;

    /// 测试发射器（记录 channel:payload）。
    struct TestEmitter(Arc<std::sync::Mutex<Vec<String>>>);

    impl Emitter for TestEmitter {
        fn emit(&self, channel: &str, payload: &str) {
            self.0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(format!("{channel}:{payload}"));
        }
    }

    /// 帧编码契约（12 §2.2）：小端头 seq/width/height + JPEG 负载。
    #[test]
    fn encode_frame_header_little_endian() {
        let bytes = encode_frame(0x01020304, 800, 600, &[1, 2, 3]);
        assert_eq!(bytes.len(), FRAME_HEADER_LEN + 3);
        assert_eq!(bytes[0..4], [0x04, 0x03, 0x02, 0x01], "seq 小端");
        assert_eq!(bytes[4..8], 800u32.to_le_bytes(), "width 小端");
        assert_eq!(bytes[8..12], 600u32.to_le_bytes(), "height 小端");
        assert_eq!(&bytes[12..], &[1, 2, 3], "负载原样拼接");
        // u64 seq 截断为 u32 头（前端诊断用；溢出回绕可接受）
        let bytes = encode_frame(u64::from(u32::MAX) + 5, 1, 1, b"x");
        assert_eq!(bytes[0..4], 4u32.to_le_bytes(), "seq 截断取低 32 位");
    }

    /// 帧状态序列化契约（starting/active/stopped 小写）。
    #[test]
    fn frame_state_serde_contract() {
        assert_eq!(serde_json::to_string(&FrameStreamState::Starting).unwrap(), "\"starting\"");
        assert_eq!(serde_json::to_string(&FrameStreamState::Active).unwrap(), "\"active\"");
        assert_eq!(serde_json::to_string(&FrameStreamState::Stopped).unwrap(), "\"stopped\"");
        assert_eq!(FrameStreamState::Active.as_str(), "active");
    }

    /// 无订阅者：状态恒 stopped；释放幂等（不炸）。
    #[test]
    fn idle_controller_is_stopped() {
        let ctrl = FrameStreamController::new();
        assert_eq!(ctrl.state(), FrameStreamState::Stopped);
        ctrl.release_session();
        assert_eq!(ctrl.state(), FrameStreamState::Stopped);
    }

    /// 转发面：单帧下行（通道收到 12 字节头 + 负载）；首帧状态转 active。
    /// （ScreencastSession 帧泵全链由 conex-browser frames 模块单测覆盖；
    /// 本测试验证控制器转发与状态投影的契约面。）
    #[tokio::test]
    async fn forward_one_downlinks_encoded_frame() {
        let ctrl = Arc::new(FrameStreamController::new());
        let logs = Arc::new(std::sync::Mutex::new(Vec::new()));
        ctrl.attach_emitter(Arc::new(TestEmitter(Arc::clone(&logs))));
        let (sent_tx, sent_rx) = std_mpsc::channel();
        *ctrl.channel.lock().unwrap_or_else(|p| p.into_inner()) = Some(Channel::new(
            move |body: tauri::ipc::InvokeResponseBody| {
                sent_tx
                    .send(body)
                    .map_err(|_| tauri::Error::Anyhow(anyhow::anyhow!("测试通道已关闭")))
            },
        ));
        let ok = ctrl.forward_one(FrameOut {
            seq: 1,
            width: 800,
            height: 600,
            data: vec![0xAB; 64],
        });
        assert!(ok, "有订阅者必须下行成功");
        let body = sent_rx.recv_timeout(Duration::from_secs(2)).expect("帧必须下行");
        let bytes = match body {
            tauri::ipc::InvokeResponseBody::Raw(b) => b,
            other => panic!("载荷必须为 Raw：{other:?}"),
        };
        assert_eq!(bytes.len(), FRAME_HEADER_LEN + 64);
        assert_eq!(bytes[0..4], 1u32.to_le_bytes(), "seq 头");
        assert_eq!(bytes[4..8], 800u32.to_le_bytes());
        assert_eq!(bytes[8..12], 600u32.to_le_bytes());
        assert_eq!(ctrl.state(), FrameStreamState::Active, "首帧下行转 active");
        let log = logs.lock().unwrap_or_else(|p| p.into_inner());
        assert!(
            log.iter().any(|s| s.contains("browser://frame-state-changed") && s.contains("\"state\":\"active\"")),
            "必须发射 active 事件：{log:?}"
        );
    }

    /// 无订阅者时帧不下行（资源纪律：通道空 → 跳过，状态不变）。
    #[test]
    fn forward_one_skips_when_no_channel() {
        let ctrl = FrameStreamController::new();
        let ok = ctrl.forward_one(FrameOut {
            seq: 1,
            width: 1,
            height: 1,
            data: vec![1, 2, 3],
        });
        assert!(ok, "无订阅者只是不下行，不视为通道失效");
        assert_eq!(ctrl.state(), FrameStreamState::Stopped, "无订阅者不启帧流");
    }

    /// 通道失效（webview 关闭）：stopped + 停止转发。
    #[test]
    fn channel_failure_stops_forwarding() {
        let ctrl = FrameStreamController::new();
        // 通道回调恒失败（模拟 webview 已关）
        *ctrl.channel.lock().unwrap_or_else(|p| p.into_inner()) = Some(Channel::new(|_| {
            Err(tauri::Error::Anyhow(anyhow::anyhow!("webview gone")))
        }));
        let ok = ctrl.forward_one(FrameOut {
            seq: 1,
            width: 1,
            height: 1,
            data: vec![1],
        });
        assert!(!ok, "通道失效必须停止转发");
        assert_eq!(ctrl.state(), FrameStreamState::Stopped);
    }
}
