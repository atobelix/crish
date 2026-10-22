//! 分类 router：CDP 原始事件 → 强类型事件（含宽容解析辅助 parse/typed）。

use super::{BrowserEvent, ConsoleLevel, DialogInfo, DomChangeKind, Ignored, LifecycleKind};
use crate::cdp::domains::{
    AttachedToTargetEvent, ConsoleApiCalledEvent, ExceptionThrownEvent, FileChooserOpenedEvent,
    FrameAttachedEvent, FrameDetachedEvent, FrameEvent, JavascriptDialogClosedEvent,
    JavascriptDialogOpeningEvent, NavigatedWithinDocumentEvent, PageErrorEvent,
    RequestWillBeSentEvent, TargetCreatedEvent, TargetDestroyedEvent, WindowOpenEvent,
};
use crate::cdp::types::CdpEvent;
use serde::de::DeserializeOwned;
use serde_json::Value;

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
        "Target.targetCreated" => typed::<TargetCreatedEvent>(&event.params, |e| {
            BrowserEvent::TargetCreated(e.target_info)
        }),
        "Target.targetDestroyed" => {
            typed::<TargetDestroyedEvent>(&event.params, |e| BrowserEvent::TargetDestroyed {
                target_id: e.target_id,
            })
        }
        "Target.targetInfoChanged" => typed::<TargetCreatedEvent>(&event.params, |e| {
            BrowserEvent::TargetInfoChanged(e.target_info)
        }),
        "Target.attachedToTarget" => {
            typed::<AttachedToTargetEvent>(&event.params, |e| BrowserEvent::SessionAttached {
                target_id: e.target_info.target_id,
                session: e.session_id,
            })
        }
        "Target.detachedFromTarget" => Err(Ignored("detachedFromTarget 不订阅".to_string())),
        // —— 导航面 ——
        "Page.frameStartedNavigating" => {
            typed::<FrameEvent>(&event.params, |e| BrowserEvent::NavigationStarted {
                session: session(),
                frame: e.frame.id,
                url: e.frame.url,
            })
        }
        "Page.frameNavigated" => typed::<FrameEvent>(&event.params, |e| BrowserEvent::Navigated {
            session: session(),
            frame: e.frame.id,
            url: e.frame.url,
            main: e.frame.parent_id.is_none(),
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
        "Page.frameAttached" => {
            typed::<FrameAttachedEvent>(&event.params, |_| BrowserEvent::DomChanged {
                session: session(),
                kind: DomChangeKind::FrameAttached,
            })
        }
        "Page.frameDetached" => {
            typed::<FrameDetachedEvent>(&event.params, |_| BrowserEvent::DomChanged {
                session: session(),
                kind: DomChangeKind::FrameDetached,
            })
        }
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
            typed::<JavascriptDialogClosedEvent>(&event.params, |e| BrowserEvent::DialogClosed {
                session: session(),
                accepted: e.result,
            })
        }
        "Page.windowOpen" => {
            typed::<WindowOpenEvent>(&event.params, |e| BrowserEvent::WindowOpenRequested {
                url: e.url,
                session: session(),
            })
        }
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
            // G-11：stackTrace.callFrames[0] 为栈顶帧（最近调用点）；行号为
            // CDP 0-based 原值透传（负值/缺失 → None，eval 与浏览器内建无脚本来源）
            let call_frame = event.params["stackTrace"]["callFrames"]
                .as_array()
                .and_then(|frames| frames.first());
            let url = call_frame.and_then(|f| f["url"].as_str()).map(String::from);
            let line = call_frame
                .and_then(|f| f["lineNumber"].as_i64())
                .filter(|v| *v >= 0)
                .map(|v| v as u64);
            BrowserEvent::Console {
                session: session(),
                level,
                text,
                url,
                line,
            }
        }),
        "Runtime.exceptionThrown" => typed::<ExceptionThrownEvent>(&event.params, |e| {
            // G-11：exceptionDetails.url/lineNumber（CDP 0-based，负值/缺失 → None）
            let details = &event.params["exceptionDetails"];
            let url = details["url"].as_str().map(String::from);
            let line = details["lineNumber"]
                .as_i64()
                .filter(|v| *v >= 0)
                .map(|v| v as u64);
            BrowserEvent::PageError {
                session: session(),
                text: e.exception_details.text,
                url,
                line,
            }
        }),
        "Page.pageError" => typed::<PageErrorEvent>(&event.params, |e| {
            // G-11：entry.url/lineNumber（LogEntry 已解析，0-based 原值透传）
            BrowserEvent::PageError {
                session: session(),
                text: e.entry.text,
                url: e.entry.url,
                line: e.entry.line_number.filter(|v| *v >= 0).map(|v| v as u64),
            }
        }),
        // —— 网络面 ——
        "Network.requestWillBeSent" => {
            typed::<RequestWillBeSentEvent>(&event.params, |e| BrowserEvent::NetworkRequest {
                request_id: e.request_id,
                url: e.request.url,
                method: e.request.method,
                // G-11：请求发出时响应未到，status 由 responseReceived 转译提供
                status: None,
            })
        }
        // G-11 补齐：responseReceived 携带 HTTP 状态码（response.status）。
        // 与 requestWillBeSent 共用 NetworkRequest 变体（同 requestId 的
        // 补充转译）：url 取 response.url（同源完整 URL），method 协议不
        // 携带 → 空串（以 requestWillBeSent 转译为准）
        "Network.responseReceived" => Ok(BrowserEvent::NetworkRequest {
            request_id: event.params["requestId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            url: event.params["response"]["url"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            method: String::new(),
            status: event.params["response"]["status"]
                .as_i64()
                .and_then(|s| u16::try_from(s).ok()),
        }),
        "Network.loadingFinished" => Ok(BrowserEvent::NetworkDone {
            request_id: event.params["requestId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            ok: true,
            // G-11：encodedDataLength = 响应体编码后字节数（CDP 为 number，
            // 整数/浮点形态均有，as_f64 统一兜底；负值/缺失 → None）
            size: event.params["encodedDataLength"]
                .as_f64()
                .filter(|v| *v >= 0.0)
                .map(|v| v as u64),
        }),
        "Network.loadingFailed" => Ok(BrowserEvent::NetworkDone {
            request_id: event.params["requestId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            ok: false,
            size: None,
        }),
        "Network.requestFailed" => Ok(BrowserEvent::NetworkDone {
            request_id: event.params["requestId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            ok: false,
            size: None,
        }),
        // —— R-3 补齐：上传触发 ——
        "Page.fileChooserOpened" => {
            typed::<FileChooserOpenedEvent>(&event.params, |e| BrowserEvent::FileChooserOpened {
                session: session(),
                frame: e.frame_id,
                backend_node_id: e.backend_node_id,
            })
        }
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
