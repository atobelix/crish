//! 事件总线（维度 11 §5：分类 router + typed 通道 + 帧专用通道）
//!
//! - `BrowserEvent`：强类型事件枚举（§5.1 全表，R-3 补 FileChooserOpened）
//! - `classify`：CDP 原始事件 → 强类型事件（未知 method 记 debug 忽略，宽容解析）
//! - `parse_frame`：screencastFrame → 帧块（走专用 mpsc，不进 typed 通道，§5.2）
//! - `BusHandle`：typed broadcast（4096）+ 帧 mpsc（60）；broadcast 发送永不阻塞
//!   （慢消费者 Lagged 自愈，U-2：版本跟踪器重对齐）
//! - `spawn_event_pump`：transport 事件面 → 分类 → bus / 帧通道
//!
//! 订阅时序铁律：先 subscribe 后发送可能产生事件的命令（消除漏事件窗口）。

use crate::cdp::domains::{
    AttachedToTargetEvent, ConsoleApiCalledEvent, ExceptionThrownEvent, FileChooserOpenedEvent,
    FrameAttachedEvent, FrameDetachedEvent, FrameEvent, JavascriptDialogClosedEvent,
    JavascriptDialogOpeningEvent, NavigatedWithinDocumentEvent, PageErrorEvent,
    RequestWillBeSentEvent, TargetCreatedEvent, TargetDestroyedEvent, TargetInfo, WindowOpenEvent,
};
use crate::cdp::types::CdpEvent;
use base64::Engine;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::Arc;

/// typed 事件通道容量（agent-browser client.rs:115 同款）。
pub const TYPED_CHANNEL_CAPACITY: usize = 4096;
/// 帧流通道容量（仅维度 12 消费；环形覆盖策略由维度 12 定）。
pub const FRAME_CHANNEL_CAPACITY: usize = 60;

/// DOM 变更子类（§5.4 合并推进的输入枚举）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DomChangeKind {
    DocumentUpdated,
    ChildNodeInserted,
    ChildNodeRemoved,
    CharacterDataModified,
    AttributeModified,
    AttributeRemoved,
    SetChildNodes,
    /// frameAttached（iframe 增删，归入 DOM 合并窗口，§5.4 #4）
    FrameAttached,
    /// frameDetached
    FrameDetached,
}

/// 生命周期事件子类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleKind {
    DomContent,
    Load,
}

/// 控制台级别（由 consoleAPICalled.type 映射）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleLevel {
    Debug,
    Info,
    Log,
    Warn,
    Error,
}

/// 版本推进原因（§5.4 判定清单 + R-1 显式推进行）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionReason {
    /// 全量导航（frameNavigated 主 frame）
    Navigation,
    /// SPA pushState/hash 导航
    SpaNavigation,
    /// DOM 变更（200ms 合并窗口）
    DomChange,
    /// iframe 生命周期/导航（归入 DOM 窗口）
    IframeLifecycle,
    /// 对话框出现/关闭（恒推进，宁多勿漏）
    Dialog,
    /// 用户输入注入（面板转发，显式 bump）
    InputInjected,
    /// AI 动作执行成功（显式 bump）
    ActionDone,
    /// 活动标签关闭
    TargetDestroyed,
    /// 重连恢复/崩溃重启（全部标签 +1000，global_epoch+1）
    Reconnected,
    /// 版本跟踪器自身 Lagged 重对齐（U-2）
    LaggedResync,
}

/// 标签页摘要（TargetsReconciled 载荷，维度 10 导航栈对账）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabSummary {
    pub target_id: String,
    pub session: String,
    pub url: String,
    pub title: String,
}

/// 对话框信息（§7.1 上抛载荷）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogInfo {
    pub session: String,
    pub dialog_type: String,
    pub message: String,
    pub url: String,
    pub default_prompt: Option<String>,
}

/// 帧块（screencast 专用通道载荷；JPEG 已解码为原始字节）。
#[derive(Debug, Clone)]
pub struct FrameChunk {
    pub data: Vec<u8>,
    pub session: String,
    pub frame: u64,
    pub timestamp_ms: u64,
    pub device_width: u32,
    pub device_height: u32,
}

/// 强类型事件（§5.1 全表）。消费者不直接碰 `serde_json::Value`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserEvent {
    // —— 连接面 ——
    ConnectionLost { attempt: u32 },
    /// epoch = global_epoch（R-1 跨标签失效语义）；维度 12 据此重启帧通道（R-9-3）
    ConnectionRestored { elapsed_ms: u64, epoch: u64 },
    // —— 导航面 ——
    /// frameStartedNavigating
    NavigationStarted { session: String, frame: String, url: String },
    /// frameNavigated（main = 主 frame）
    Navigated { session: String, frame: String, url: String, main: bool },
    /// SPA pushState/hash
    NavigatedWithinDocument { session: String, frame: String, url: String },
    /// domContent/loadEventFired
    Lifecycle { session: String, frame: String, kind: LifecycleKind },
    // —— 目标/会话面 ——
    TargetCreated(TargetInfo),
    TargetDestroyed { target_id: String },
    TargetInfoChanged(TargetInfo),
    SessionAttached { target_id: String, session: String },
    // —— 内容变更面 ——
    DomChanged { session: String, kind: DomChangeKind },
    // —— 对话框/弹窗面 ——
    DialogOpened(DialogInfo),
    DialogClosed { session: String, accepted: bool },
    /// window.open 收口请求（§7.2，域名门禁裁决后 allow/deny）
    WindowOpenRequested { url: String, session: String },
    // —— 脚本/控制台面 ——
    Console { session: String, level: ConsoleLevel, text: String },
    PageError { session: String, text: String },
    // —— 网络面（维度 17 门禁/审计消费）——
    NetworkRequest { request_id: String, url: String, method: String },
    NetworkDone { request_id: String, ok: bool },
    // —— 版本面（R-1 per-tab）——
    VersionAdvanced { tab_id: String, from: u64, to: u64, reason: VersionReason },
    /// 重连/崩溃重启：global_epoch+1，全部标签版本失效
    VersionReset { epoch: u64, reason: VersionReason },
    // —— 标签页列表（重连对账）——
    TargetsReconciled { tabs: Vec<TabSummary> },
    /// R-3 补齐：fileChooserOpened（维度 14 上传触发）
    FileChooserOpened { session: String, frame: String, backend_node_id: i64 },
}

/// 分类忽略（含原因；未知 method 记 debug 忽略，宽容解析）。
#[derive(Debug, Clone)]
pub struct Ignored(pub String);

/// 事件总线句柄：typed 广播 + 帧 mpsc（§5.2 双通道）。
#[derive(Clone)]
pub struct BusHandle {
    event_tx: tokio::sync::broadcast::Sender<BrowserEvent>,
    frame_tx: tokio::sync::mpsc::Sender<FrameChunk>,
    /// 帧流接收端（独占消费：仅维度 12；take 一次后再次调用返回空通道）
    frame_rx: Arc<std::sync::Mutex<Option<tokio::sync::mpsc::Receiver<FrameChunk>>>>,
}

impl BusHandle {
    /// 新建总线（容量注入，测试用）。
    pub fn new(capacity: usize, frame_capacity: usize) -> Self {
        let (frame_tx, frame_rx) = tokio::sync::mpsc::channel(frame_capacity);
        BusHandle {
            event_tx: tokio::sync::broadcast::channel(capacity).0,
            frame_tx,
            frame_rx: Arc::new(std::sync::Mutex::new(Some(frame_rx))),
        }
    }

    /// 订阅 typed 事件（先订阅后动作，订阅时序铁律）。
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<BrowserEvent> {
        self.event_tx.subscribe()
    }

    /// 订阅帧流（仅维度 12 调用；独占消费——重复调用返回空接收端，
    /// 属调用方错误，调用方应保证唯一消费）。
    pub fn subscribe_frames(&self) -> tokio::sync::mpsc::Receiver<FrameChunk> {
        let mut guard = self.frame_rx.lock().unwrap_or_else(|p| p.into_inner());
        guard.take().unwrap_or_else(|| {
            tracing::warn!("帧流接收端已被消费（重复订阅），返回空通道");
            let (_tx, rx) = tokio::sync::mpsc::channel(1);
            rx
        })
    }

    /// 发布 typed 事件（broadcast 发送永不阻塞：慢消费者 Lagged 自愈）。
    pub fn publish(&self, event: BrowserEvent) {
        let _ = self.event_tx.send(event);
    }

    /// 发送帧块（满时丢弃，维度 12 环形覆盖策略兜底）。
    pub fn send_frame(&self, chunk: FrameChunk) {
        let _ = self.frame_tx.try_send(chunk);
    }

    /// typed 发送端（VersionTracker 广播 VersionAdvanced 用）。
    pub fn event_tx(&self) -> tokio::sync::broadcast::Sender<BrowserEvent> {
        self.event_tx.clone()
    }
}

fn parse<T: DeserializeOwned>(params: &Value) -> Option<T> {
    serde_json::from_value(params.clone()).ok()
}

/// 带类型的事件解析（参数解析失败 → Ignored，不炸事件泵）。
fn typed<T: DeserializeOwned>(
    params: &Value,
    f: impl FnOnce(T) -> BrowserEvent,
) -> Result<BrowserEvent, Ignored> {
    parse::<T>(params)
        .map(f)
        .ok_or_else(|| Ignored("事件参数解析失败".to_string()))
}

/// 分类 router：CDP 原始事件 → 强类型事件（§5.1）。
/// `Page.screencastFrame` / `screencastVisibilityChanged` 不走此路（帧专用通道，§5.2）。
pub fn classify(event: &CdpEvent) -> Result<BrowserEvent, Ignored> {
    let session = || event.session_id.clone().unwrap_or_default();
    let method = event.method.as_str();
    match method {
        // —— 目标/会话面 ——
        "Target.targetCreated" => {
            typed::<TargetCreatedEvent>(&event.params, |e| BrowserEvent::TargetCreated(e.target_info))
        }
        "Target.targetDestroyed" => typed::<TargetDestroyedEvent>(&event.params, |e| {
            BrowserEvent::TargetDestroyed {
                target_id: e.target_id,
            }
        }),
        "Target.targetInfoChanged" => typed::<TargetCreatedEvent>(&event.params, |e| {
            BrowserEvent::TargetInfoChanged(e.target_info)
        }),
        "Target.attachedToTarget" => typed::<AttachedToTargetEvent>(&event.params, |e| {
            BrowserEvent::SessionAttached {
                target_id: e.target_info.target_id,
                session: e.session_id,
            }
        }),
        "Target.detachedFromTarget" => Err(Ignored("detachedFromTarget 不订阅".to_string())),
        // —— 导航面 ——
        "Page.frameStartedNavigating" => typed::<FrameEvent>(&event.params, |e| {
            BrowserEvent::NavigationStarted {
                session: session(),
                frame: e.frame.id,
                url: e.frame.url,
            }
        }),
        "Page.frameNavigated" => typed::<FrameEvent>(&event.params, |e| {
            BrowserEvent::Navigated {
                session: session(),
                frame: e.frame.id,
                url: e.frame.url,
                main: e.frame.parent_id.is_none(),
            }
        }),
        "Page.navigatedWithinDocument" => {
            typed::<NavigatedWithinDocumentEvent>(&event.params, |e| {
                BrowserEvent::NavigatedWithinDocument {
                    session: session(),
                    frame: e.frame_id,
                    url: e.url,
                }
            })
        }
        "Page.domContentEventFired" => Ok(BrowserEvent::Lifecycle {
            session: session(),
            frame: String::new(),
            kind: LifecycleKind::DomContent,
        }),
        "Page.loadEventFired" => Ok(BrowserEvent::Lifecycle {
            session: session(),
            frame: String::new(),
            kind: LifecycleKind::Load,
        }),
        // —— 内容变更面（DOM 域）——
        "DOM.documentUpdated" => Ok(BrowserEvent::DomChanged {
            session: session(),
            kind: DomChangeKind::DocumentUpdated,
        }),
        "DOM.childNodeInserted" => Ok(BrowserEvent::DomChanged {
            session: session(),
            kind: DomChangeKind::ChildNodeInserted,
        }),
        "DOM.childNodeRemoved" => Ok(BrowserEvent::DomChanged {
            session: session(),
            kind: DomChangeKind::ChildNodeRemoved,
        }),
        "DOM.characterDataModified" => Ok(BrowserEvent::DomChanged {
            session: session(),
            kind: DomChangeKind::CharacterDataModified,
        }),
        "DOM.attributeModified" => Ok(BrowserEvent::DomChanged {
            session: session(),
            kind: DomChangeKind::AttributeModified,
        }),
        "DOM.attributeRemoved" => Ok(BrowserEvent::DomChanged {
            session: session(),
            kind: DomChangeKind::AttributeRemoved,
        }),
        "DOM.setChildNodes" => Ok(BrowserEvent::DomChanged {
            session: session(),
            kind: DomChangeKind::SetChildNodes,
        }),
        "Page.frameAttached" => typed::<FrameAttachedEvent>(&event.params, |_| {
            BrowserEvent::DomChanged {
                session: session(),
                kind: DomChangeKind::FrameAttached,
            }
        }),
        "Page.frameDetached" => typed::<FrameDetachedEvent>(&event.params, |_| {
            BrowserEvent::DomChanged {
                session: session(),
                kind: DomChangeKind::FrameDetached,
            }
        }),
        // —— 对话框/弹窗面 ——
        "Page.javascriptDialogOpening" => {
            typed::<JavascriptDialogOpeningEvent>(&event.params, |e| {
                BrowserEvent::DialogOpened(DialogInfo {
                    session: session(),
                    dialog_type: e.dialog_type,
                    message: e.message,
                    url: e.url,
                    default_prompt: e.default_prompt,
                })
            })
        }
        "Page.javascriptDialogClosed" => {
            typed::<JavascriptDialogClosedEvent>(&event.params, |e| {
                BrowserEvent::DialogClosed {
                    session: session(),
                    accepted: e.result,
                }
            })
        }
        "Page.windowOpen" => typed::<WindowOpenEvent>(&event.params, |e| {
            BrowserEvent::WindowOpenRequested {
                url: e.url,
                session: session(),
            }
        }),
        // —— 脚本/控制台面 ——
        "Runtime.consoleAPICalled" => typed::<ConsoleApiCalledEvent>(&event.params, |e| {
            let level = match e.call_type.as_str() {
                "debug" => ConsoleLevel::Debug,
                "info" => ConsoleLevel::Info,
                "warning" => ConsoleLevel::Warn,
                "error" | "assert" => ConsoleLevel::Error,
                _ => ConsoleLevel::Log,
            };
            let text = e
                .args
                .iter()
                .map(|a| {
                    a.value
                        .clone()
                        .map(|v| v.to_string())
                        .or_else(|| a.description.clone())
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
                .join(" ");
            BrowserEvent::Console {
                session: session(),
                level,
                text,
            }
        }),
        "Runtime.exceptionThrown" => typed::<ExceptionThrownEvent>(&event.params, |e| {
            BrowserEvent::PageError {
                session: session(),
                text: e.exception_details.text,
            }
        }),
        "Page.pageError" => typed::<PageErrorEvent>(&event.params, |e| {
            BrowserEvent::PageError {
                session: session(),
                text: e.entry.text,
            }
        }),
        // —— 网络面 ——
        "Network.requestWillBeSent" => {
            typed::<RequestWillBeSentEvent>(&event.params, |e| BrowserEvent::NetworkRequest {
                request_id: e.request_id,
                url: e.request.url,
                method: e.request.method,
            })
        }
        "Network.loadingFinished" => Ok(BrowserEvent::NetworkDone {
            request_id: event.params["requestId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            ok: true,
        }),
        "Network.loadingFailed" => Ok(BrowserEvent::NetworkDone {
            request_id: event.params["requestId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            ok: false,
        }),
        "Network.requestFailed" => Ok(BrowserEvent::NetworkDone {
            request_id: event.params["requestId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            ok: false,
        }),
        // —— R-3 补齐：上传触发 ——
        "Page.fileChooserOpened" => typed::<FileChooserOpenedEvent>(&event.params, |e| {
            BrowserEvent::FileChooserOpened {
                session: session(),
                frame: e.frame_id,
                backend_node_id: e.backend_node_id,
            }
        }),
        // —— 帧专用通道（§5.2 不入 typed 总线）——
        "Page.screencastFrame" | "Page.screencastVisibilityChanged" => {
            Err(Ignored("screencast 帧走专用通道".to_string()))
        }
        // —— 执行环境事件（§5.4 #15 不推进，无 typed 面）——
        "Runtime.executionContextCreated"
        | "Runtime.executionContextDestroyed"
        | "Runtime.executionContextsCleared" => Err(Ignored("执行环境事件不转译".to_string())),
        // —— 未订阅事件：宽容忽略 ——
        other => Err(Ignored(format!("未知事件 {other}"))),
    }
    .map_err(|_| Ignored(format!("事件 {} 解析失败", event.method)))
}

/// screencastFrame 解析为帧块（base64 JPEG 解码；大消息走专用 mpsc 不过 typed 总线）。
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
    Some(FrameChunk {
        data,
        session: event.session_id.clone().unwrap_or_default(),
        frame: event.params["frameNumber"].as_u64().unwrap_or(0),
        timestamp_ms: (timestamp_s * 1000.0) as u64,
        device_width: meta["deviceWidth"].as_u64().unwrap_or(0) as u32,
        device_height: meta["deviceHeight"].as_u64().unwrap_or(0) as u32,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw(method: &str, params: Value, session: Option<&str>) -> CdpEvent {
        CdpEvent {
            method: method.to_string(),
            params,
            session_id: session.map(String::from),
        }
    }

    /// 验收 9.1-12：注入 N 事件 → 订阅者按序收到（顺序断言）
    #[tokio::test]
    async fn bus_events_in_order() {
        let bus = BusHandle::new(16, 4);
        let mut rx = bus.subscribe();
        let events = vec![
            BrowserEvent::Console {
                session: "s".to_string(),
                level: ConsoleLevel::Log,
                text: "一".to_string(),
            },
            BrowserEvent::NetworkRequest {
                request_id: "r1".to_string(),
                url: "https://e.com".to_string(),
                method: "GET".to_string(),
            },
            BrowserEvent::PageError {
                session: "s".to_string(),
                text: "错误".to_string(),
            },
            BrowserEvent::DomChanged {
                session: "s".to_string(),
                kind: DomChangeKind::CharacterDataModified,
            },
            BrowserEvent::NetworkDone {
                request_id: "r1".to_string(),
                ok: true,
            },
        ];
        for e in &events {
            bus.publish(e.clone());
        }
        for expected in &events {
            let got = rx.recv().await.expect("订阅者应有事件");
            assert_eq!(&got, expected, "事件顺序必须与发布序一致");
        }
    }

    /// 验收 9.1-13：慢消费者 Lagged → 自愈路径（版本跟踪器重对齐）
    #[tokio::test]
    async fn bus_lagged_recovery() {
        // 小容量总线制造 Lagged
        let bus = BusHandle::new(2, 4);
        let mut slow = bus.subscribe();
        // 订阅者未消费，发布 4 个事件（容量 2：最早 2 个被挤出）
        for i in 0..4u64 {
            bus.publish(BrowserEvent::NetworkDone {
                request_id: format!("r{i}"),
                ok: true,
            });
        }
        // 慢消费者首个 recv 必为 Lagged（丢了 2 个）
        match slow.recv().await {
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
            other => panic!("应收到 Lagged，实际 {other:?}"),
        }
        // 后续事件仍按序可得（自愈：不丢后续）
        let got = slow.recv().await.expect("重对齐后应能继续消费");
        assert_eq!(got, BrowserEvent::NetworkDone { request_id: "r2".to_string(), ok: true });
        let got = slow.recv().await.expect("重对齐后应能继续消费");
        assert_eq!(got, BrowserEvent::NetworkDone { request_id: "r3".to_string(), ok: true });

        // 版本跟踪器自愈（U-2）：Lagged 检测 → 全标签 +1000 + epoch+1 + VersionReset
        let bus2 = BusHandle::new(64, 4);
        let tracker = Arc::new(crate::cdp::version::VersionTracker::new(
            bus2.event_tx(),
            std::time::Duration::from_millis(50),
        ));
        let mut rx = bus2.subscribe();
        tracker.bump("tab-1", VersionReason::InputInjected);
        // 先消费 bump 的 VersionAdvanced，再验证 Lagged 自愈的 VersionReset
        let first = rx.recv().await.expect("应广播 VersionAdvanced");
        assert!(matches!(first, BrowserEvent::VersionAdvanced { .. }));
        tracker.on_lagged();
        assert_eq!(tracker.snapshot_version("tab-1"), 1001);
        assert_eq!(tracker.epoch(), 1);
        let got = rx.recv().await.expect("应广播 VersionReset");
        assert!(matches!(
            got,
            BrowserEvent::VersionReset { epoch: 1, reason: VersionReason::LaggedResync }
        ));
    }

    /// 验收 9.1-14：帧事件不进 typed 通道
    #[tokio::test]
    async fn bus_screencast_isolated() {
        let bus = BusHandle::new(16, 4);
        let mut rx = bus.subscribe();
        let mut frames = bus.subscribe_frames();

        // 帧事件：分类必须 Ignored + parse_frame 提取成功
        let chunk = base64::engine::general_purpose::STANDARD.encode(b"fake-jpeg-bytes");
        let frame_evt = raw(
            "Page.screencastFrame",
            json!({
                "data": chunk,
                "metadata": {
                    "pageScaleFactor": 1.0,
                    "deviceWidth": 1280,
                    "deviceHeight": 720,
                    "timestamp": 1234.567
                },
                "sessionId": "S1",
                "frameNumber": 42
            }),
            Some("S1"),
        );
        assert!(classify(&frame_evt).is_err(), "帧事件不得进入 typed 分类");
        let parsed = parse_frame(&frame_evt).expect("帧解析失败");
        assert_eq!(parsed.data, b"fake-jpeg-bytes");
        assert_eq!(parsed.session, "S1");
        assert_eq!(parsed.frame, 42);
        assert_eq!(parsed.timestamp_ms, 1_234_567);
        assert_eq!(parsed.device_width, 1280);

        bus.send_frame(parsed);
        // typed 通道只收到普通事件
        bus.publish(BrowserEvent::Console {
            session: "s".to_string(),
            level: ConsoleLevel::Log,
            text: "x".to_string(),
        });
        let got = rx.recv().await.expect("typed 订阅者应有事件");
        assert!(
            matches!(got, BrowserEvent::Console { .. }),
            "typed 通道不应出现帧事件"
        );
        // 帧通道独立收到
        let frame = frames.recv().await.expect("帧通道应有帧");
        assert_eq!(frame.frame, 42);
    }

    /// 分类 router 冒烟：导航/对话框/网络/目标事件全表转译。
    #[test]
    fn bus_classify_smoke() {
        let e = raw(
            "Page.frameNavigated",
            json!({ "frame": { "id": "F1", "url": "https://e.com", "parentId": null } }),
            Some("S1"),
        );
        assert_eq!(
            classify(&e).unwrap(),
            BrowserEvent::Navigated {
                session: "S1".to_string(),
                frame: "F1".to_string(),
                url: "https://e.com".to_string(),
                main: true,
            }
        );

        let e = raw(
            "Target.attachedToTarget",
            json!({
                "sessionId": "S2",
                "targetInfo": { "targetId": "T2", "type": "page", "title": "t", "url": "u" },
                "waitingForDebugger": false
            }),
            None,
        );
        assert_eq!(
            classify(&e).unwrap(),
            BrowserEvent::SessionAttached { target_id: "T2".to_string(), session: "S2".to_string() }
        );

        let e = raw(
            "Page.javascriptDialogOpening",
            json!({ "url": "https://e.com", "message": "hello", "type": "alert", "defaultPrompt": null }),
            Some("S1"),
        );
        assert!(matches!(classify(&e).unwrap(), BrowserEvent::DialogOpened(_)));

        // 未知事件宽容忽略
        let e = raw("Foo.bar", json!({}), None);
        assert!(classify(&e).is_err());
    }

    // ---------- 全事件转译表（评审 P2 补强：wire → typed 逐变体断言） ----------

    /// Target 域：targetCreated / targetInfoChanged / targetDestroyed / attachedToTarget。
    #[test]
    fn bus_table_target_domain() {
        let info = json!({
            "targetId": "T1",
            "type": "page",
            "title": "标题",
            "url": "https://a.example",
            "attached": true,
            "browserContextId": "BC1",
            "openerId": "T0",
        });
        // targetCreated → TargetCreated 全字段透传
        let got = classify(&raw("Target.targetCreated", json!({ "targetInfo": info }), None))
            .expect("targetCreated 应转译");
        match got {
            BrowserEvent::TargetCreated(t) => {
                assert_eq!(t.target_id, "T1");
                assert_eq!(t.target_type, "page");
                assert_eq!(t.title, "标题");
                assert_eq!(t.url, "https://a.example");
                assert_eq!(t.attached, Some(true));
                assert_eq!(t.browser_context_id.as_deref(), Some("BC1"));
                assert_eq!(t.opener_id.as_deref(), Some("T0"));
            }
            other => panic!("应为 TargetCreated，实际 {other:?}"),
        }
        // targetInfoChanged → TargetInfoChanged
        let got = classify(&raw("Target.targetInfoChanged", json!({ "targetInfo": info }), None))
            .expect("targetInfoChanged 应转译");
        assert!(matches!(got, BrowserEvent::TargetInfoChanged(t) if t.target_id == "T1"));
        // targetDestroyed → TargetDestroyed
        let got = classify(&raw("Target.targetDestroyed", json!({ "targetId": "T9" }), None))
            .expect("targetDestroyed 应转译");
        assert_eq!(got, BrowserEvent::TargetDestroyed { target_id: "T9".to_string() });
        // attachedToTarget → SessionAttached（双层路由建立点）
        let got = classify(
            &raw(
                "Target.attachedToTarget",
                json!({
                    "sessionId": "S2",
                    "targetInfo": { "targetId": "T2", "type": "page", "title": "t", "url": "u" },
                    "waitingForDebugger": false,
                }),
                None,
            ),
        )
        .expect("attachedToTarget 应转译");
        assert_eq!(got, BrowserEvent::SessionAttached { target_id: "T2".to_string(), session: "S2".to_string() });
        // detachedFromTarget → 显式忽略
        assert!(
            classify(&raw("Target.detachedFromTarget", json!({ "sessionId": "S2" }), None)).is_err(),
            "detachedFromTarget 不订阅"
        );
    }

    /// 导航面：frameStartedNavigating / frameNavigated 主次帧 / navigatedWithinDocument /
    /// domContent / load 生命周期。
    #[test]
    fn bus_table_navigation_domain() {
        // frameStartedNavigating → NavigationStarted（FrameInfo 全字段宽容解析）
        let got = classify(
            &raw(
                "Page.frameStartedNavigating",
                json!({ "frame": { "id": "F1", "url": "https://n.example" } }),
                Some("S1"),
            ),
        )
        .expect("frameStartedNavigating 应转译");
        assert_eq!(
            got,
            BrowserEvent::NavigationStarted { session: "S1".to_string(), frame: "F1".to_string(), url: "https://n.example".to_string() }
        );
        // frameNavigated 主帧（parentId 缺省）→ main=true
        let got = classify(
            &raw(
                "Page.frameNavigated",
                json!({ "frame": { "id": "F1", "url": "https://e.com", "parentId": null } }),
                Some("S1"),
            ),
        )
        .expect("frameNavigated 应转译");
        assert_eq!(
            got,
            BrowserEvent::Navigated { session: "S1".to_string(), frame: "F1".to_string(), url: "https://e.com".to_string(), main: true }
        );
        // frameNavigated 子帧（parentId 存在）→ main=false
        let got = classify(
            &raw(
                "Page.frameNavigated",
                json!({ "frame": { "id": "F2", "url": "https://i.example", "parentId": "F1" } }),
                Some("S1"),
            ),
        )
        .expect("子帧应转译");
        assert_eq!(
            got,
            BrowserEvent::Navigated { session: "S1".to_string(), frame: "F2".to_string(), url: "https://i.example".to_string(), main: false }
        );
        // navigatedWithinDocument（SPA pushState/hash）
        let got = classify(
            &raw("Page.navigatedWithinDocument", json!({ "frameId": "F1", "url": "https://e.com/#/route" }), Some("S1")),
        )
        .expect("navigatedWithinDocument 应转译");
        assert_eq!(
            got,
            BrowserEvent::NavigatedWithinDocument { session: "S1".to_string(), frame: "F1".to_string(), url: "https://e.com/#/route".to_string() }
        );
        // domContentEventFired / loadEventFired → Lifecycle
        let got = classify(&raw("Page.domContentEventFired", json!({ "timestamp": 1.0 }), Some("S1"))).unwrap();
        assert_eq!(got, BrowserEvent::Lifecycle { session: "S1".to_string(), frame: String::new(), kind: LifecycleKind::DomContent });
        let got = classify(&raw("Page.loadEventFired", json!({ "timestamp": 2.0 }), Some("S1"))).unwrap();
        assert_eq!(got, BrowserEvent::Lifecycle { session: "S1".to_string(), frame: String::new(), kind: LifecycleKind::Load });
    }

    /// DOM 域七子类 + frameAttached/frameDetached 归并 → DomChanged 全子类。
    #[test]
    fn bus_table_dom_domain() {
        let cases = [
            ("DOM.documentUpdated", DomChangeKind::DocumentUpdated),
            ("DOM.childNodeInserted", DomChangeKind::ChildNodeInserted),
            ("DOM.childNodeRemoved", DomChangeKind::ChildNodeRemoved),
            ("DOM.characterDataModified", DomChangeKind::CharacterDataModified),
            ("DOM.attributeModified", DomChangeKind::AttributeModified),
            ("DOM.attributeRemoved", DomChangeKind::AttributeRemoved),
            ("DOM.setChildNodes", DomChangeKind::SetChildNodes),
        ];
        for (method, kind) in cases {
            let got = classify(&raw(method, json!({}), Some("S1"))).expect("应转译");
            assert_eq!(got, BrowserEvent::DomChanged { session: "S1".to_string(), kind }, "{method}");
        }
        // frameAttached / frameDetached 归入 DOM 合并窗口子类
        let got = classify(&raw("Page.frameAttached", json!({ "frameId": "F3", "parentFrameId": "F1" }), Some("S1"))).unwrap();
        assert_eq!(got, BrowserEvent::DomChanged { session: "S1".to_string(), kind: DomChangeKind::FrameAttached });
        let got = classify(&raw("Page.frameDetached", json!({ "frameId": "F3", "reason": "remove" }), Some("S1"))).unwrap();
        assert_eq!(got, BrowserEvent::DomChanged { session: "S1".to_string(), kind: DomChangeKind::FrameDetached });
        // session 缺省 → 空串（宽容解析）
        let got = classify(&raw("DOM.documentUpdated", json!({}), None)).unwrap();
        assert_eq!(got, BrowserEvent::DomChanged { session: String::new(), kind: DomChangeKind::DocumentUpdated });
    }

    /// 对话框/弹窗面：javascriptDialogOpening（含 defaultPrompt）/ javascriptDialogClosed /
    /// windowOpen。
    #[test]
    fn bus_table_dialog_domain() {
        // opening：全字段 + defaultPrompt 透传
        let got = classify(
            &raw(
                "Page.javascriptDialogOpening",
                json!({ "url": "https://e.com", "message": "确认操作？", "type": "prompt", "defaultPrompt": "默认值" }),
                Some("S1"),
            ),
        )
        .expect("opening 应转译");
        match got {
            BrowserEvent::DialogOpened(info) => {
                assert_eq!(info.session, "S1");
                assert_eq!(info.dialog_type, "prompt");
                assert_eq!(info.message, "确认操作？");
                assert_eq!(info.url, "https://e.com");
                assert_eq!(info.default_prompt.as_deref(), Some("默认值"));
            }
            other => panic!("应为 DialogOpened，实际 {other:?}"),
        }
        // defaultPrompt 为 null → None
        let got = classify(
            &raw("Page.javascriptDialogOpening", json!({ "url": "u", "message": "m", "type": "alert", "defaultPrompt": null }), Some("S1")),
        )
        .unwrap();
        assert!(matches!(got, BrowserEvent::DialogOpened(info) if info.default_prompt.is_none()));
        // closed：result=true/false
        let got = classify(&raw("Page.javascriptDialogClosed", json!({ "result": true, "userGesture": true }), Some("S1"))).unwrap();
        assert_eq!(got, BrowserEvent::DialogClosed { session: "S1".to_string(), accepted: true });
        let got = classify(&raw("Page.javascriptDialogClosed", json!({ "result": false }), Some("S1"))).unwrap();
        assert_eq!(got, BrowserEvent::DialogClosed { session: "S1".to_string(), accepted: false });
        // windowOpen → WindowOpenRequested
        let got = classify(
            &raw("Page.windowOpen", json!({ "url": "https://pop.example", "windowName": "w", "windowFeatures": ["width=100"], "userGesture": true }), Some("S1")),
        )
        .unwrap();
        assert_eq!(got, BrowserEvent::WindowOpenRequested { url: "https://pop.example".to_string(), session: "S1".to_string() });
    }

    /// 控制台面：consoleAPICalled 全级别映射 + 参数拼接（JSON 序列化语义）；
    /// exceptionThrown / pageError。
    #[test]
    fn bus_table_console_domain() {
        let level_cases = [
            ("debug", ConsoleLevel::Debug),
            ("info", ConsoleLevel::Info),
            ("warning", ConsoleLevel::Warn),
            ("error", ConsoleLevel::Error),
            ("assert", ConsoleLevel::Error),
            ("log", ConsoleLevel::Log),
            ("未知级别", ConsoleLevel::Log),
        ];
        for (call_type, level) in level_cases {
            let got = classify(
                &raw(
                    "Runtime.consoleAPICalled",
                    json!({ "type": call_type, "args": [ { "type": "string", "value": "你好" } ] }),
                    Some("S1"),
                ),
            )
            .unwrap_or_else(|_| panic!("consoleAPICalled({call_type}) 应转译"));
            // value 经 Value::to_string() 序列化 → 字符串带 JSON 引号
            assert_eq!(
                got,
                BrowserEvent::Console { session: "S1".to_string(), level, text: "\"你好\"".to_string() },
                "type={call_type}"
            );
        }
        // 多参数空格拼接 + 无 value 时回退 description
        let got = classify(
            &raw(
                "Runtime.consoleAPICalled",
                json!({
                    "type": "log",
                    "args": [
                        { "type": "string", "value": "a" },
                        { "type": "number", "value": 42 },
                        { "type": "object", "description": "Object{len:2}" }
                    ]
                }),
                Some("S1"),
            ),
        )
        .unwrap();
        assert_eq!(
            got,
            BrowserEvent::Console { session: "S1".to_string(), level: ConsoleLevel::Log, text: "\"a\" 42 Object{len:2}".to_string() }
        );
        // exceptionThrown → PageError（exception_details.text）
        let got = classify(
            &raw("Runtime.exceptionThrown", json!({ "timestamp": 1.0, "exceptionDetails": { "text": "ReferenceError: x is not defined" } }), Some("S1")),
        )
        .unwrap();
        assert_eq!(got, BrowserEvent::PageError { session: "S1".to_string(), text: "ReferenceError: x is not defined".to_string() });
        // pageError → PageError（entry.text）
        let got = classify(
            &raw(
                "Page.pageError",
                json!({ "entry": { "source": "javascript", "level": "error", "text": "TypeError: y", "timestamp": 1.0 } }),
                Some("S1"),
            ),
        )
        .unwrap();
        assert_eq!(got, BrowserEvent::PageError { session: "S1".to_string(), text: "TypeError: y".to_string() });
    }

    /// 网络面：requestWillBeSent / loadingFinished / loadingFailed / requestFailed。
    #[test]
    fn bus_table_network_domain() {
        let got = classify(
            &raw(
                "Network.requestWillBeSent",
                json!({ "requestId": "r1", "request": { "url": "https://cdn.example/x.js", "method": "GET" } }),
                None,
            ),
        )
        .unwrap();
        assert_eq!(got, BrowserEvent::NetworkRequest { request_id: "r1".to_string(), url: "https://cdn.example/x.js".to_string(), method: "GET".to_string() });
        // 三终止事件 → NetworkDone（ok 语义：仅 loadingFinished 为 true）
        let got = classify(&raw("Network.loadingFinished", json!({ "requestId": "r1" }), None)).unwrap();
        assert_eq!(got, BrowserEvent::NetworkDone { request_id: "r1".to_string(), ok: true });
        for method in ["Network.loadingFailed", "Network.requestFailed"] {
            let got = classify(&raw(method, json!({ "requestId": "r2" }), None)).unwrap();
            assert_eq!(got, BrowserEvent::NetworkDone { request_id: "r2".to_string(), ok: false }, "{method}");
        }
        // requestId 缺省 → 空串兜底（宽容解析）
        let got = classify(&raw("Network.loadingFailed", json!({ "errorText": "net::ERR_ABORTED" }), None)).unwrap();
        assert_eq!(got, BrowserEvent::NetworkDone { request_id: String::new(), ok: false });
    }

    /// R-3 补齐面：fileChooserOpened → FileChooserOpened（上传触发）。
    #[test]
    fn bus_table_file_chooser() {
        let got = classify(
            &raw("Page.fileChooserOpened", json!({ "frameId": "F1", "mode": "selectMultiple", "backendNodeId": 77 }), Some("S1")),
        )
        .expect("fileChooserOpened 应转译");
        assert_eq!(got, BrowserEvent::FileChooserOpened { session: "S1".to_string(), frame: "F1".to_string(), backend_node_id: 77 });
    }

    /// 忽略面全表：screencast 双事件 / 执行环境三事件 / 未知方法 / 解析失败。
    #[test]
    fn bus_table_ignored_events() {
        for method in [
            "Page.screencastFrame",
            "Page.screencastVisibilityChanged",
            "Runtime.executionContextCreated",
            "Runtime.executionContextDestroyed",
            "Runtime.executionContextsCleared",
        ] {
            assert!(
                classify(&raw(method, json!({}), None)).is_err(),
                "{method} 必须记忽略（不炸事件泵）"
            );
        }
        assert!(classify(&raw("Nope.nope", json!({}), None)).is_err(), "未知事件宽容忽略");
        // 已知方法但参数残缺 → Ignored（宽容解析，不 panic）
        assert!(classify(&raw("Target.targetCreated", json!({}), None)).is_err(), "参数解析失败应忽略");
        assert!(classify(&raw("Page.frameNavigated", json!({}), None)).is_err(), "frameNavigated 缺参应忽略");
        assert!(classify(&raw("Runtime.consoleAPICalled", json!({ "type": "log" }), None)).is_err(), "consoleAPICalled 缺 args 应忽略");
    }
}
