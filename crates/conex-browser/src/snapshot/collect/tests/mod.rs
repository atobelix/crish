use super::frames::*;
use super::tree_build::*;
use super::*;
use crate::cdp::mock::{MockReply, MockServer};
use crate::cdp::sender::{
    ApprovalDenied, BrowserAuditEvent, CancellationToken, CdpCommandView, CommandPolicyHooks, IdKey,
};
use crate::cdp::transport::{CdpEndpoint, ExpectedBrowser};
use crate::snapshot::serialize::{build_and_serialize, SerializeOptions};
use crate::{BrowserSession, CdpError};
use std::sync::{atomic::AtomicBool, Arc};

/// 放行钩子（mock CDP 集成测试用；对齐 lib.rs 测试面）。
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
impl CommandPolicyHooks for AllowHooks {
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

/// 恢复流程所需的 mock 自动应答全表（对齐 lib.rs 测试面）。
fn restore_reply_map() -> Vec<(&'static str, MockReply)> {
    use crate::cdp::domains::names::*;
    vec![
        (
            BROWSER_GET_VERSION,
            MockReply::Ok(json!({
                "protocolVersion": "1.3",
                "product": "Chrome/131.0.6778.204",
                "revision": "@abc",
                "userAgent": "ua",
                "jsVersion": "13.1.71"
            })),
        ),
        (TARGET_SET_DISCOVER_TARGETS, MockReply::Ok(json!({}))),
        (
            TARGET_GET_TARGETS,
            MockReply::Ok(json!({
                "targetInfos": [
                    { "targetId": "T1", "type": "page", "title": "A", "url": "https://a.example" }
                ]
            })),
        ),
        (
            TARGET_ATTACH_TO_TARGET,
            MockReply::Ok(json!({ "sessionId": "FRAME_S1" })),
        ),
        (
            TARGET_DETACH_FROM_TARGET,
            MockReply::Ok(json!({ "success": true })),
        ),
        (PAGE_ENABLE, MockReply::Ok(json!({}))),
        (PAGE_SET_LIFECYCLE_EVENTS_ENABLED, MockReply::Ok(json!({}))),
        (RUNTIME_ENABLE, MockReply::Ok(json!({}))),
        (DOM_ENABLE, MockReply::Ok(json!({}))),
        (NETWORK_ENABLE, MockReply::Ok(json!({}))),
        (NETWORK_SET_BLOCKED_URLS, MockReply::Ok(json!({}))),
        (
            RUNTIME_RUN_IF_WAITING_FOR_DEBUGGER,
            MockReply::Ok(json!({})),
        ),
        (
            RUNTIME_EVALUATE,
            MockReply::Ok(json!({ "result": { "value": 1 } })),
        ),
        (PAGE_SET_WINDOW_OPEN_HANDLER, MockReply::Ok(json!({}))),
        (PAGE_HANDLE_JAVASCRIPT_DIALOG, MockReply::Ok(json!({}))),
    ]
}

/// 主会话快照应答：主文档（frameId=MAIN）+ iframe owner(101) + 按钮(202)。
/// iframe owner 布局 320×240 ≥ 10px 门限；按钮 bounds 正常。
fn main_capture_fixture() -> Value {
    json!({
        "strings": ["", "#document", "IFRAME", "BUTTON", "src",
                    "https://b.example/embed", "https://a.example", "跨域测试页"],
        "documents": [{
            "documentURL": 6,
            "title": 7,
            "frameId": "MAIN",
            "nodes": {
                "parentIndex": [-1, 0, 0],
                "nodeType": [9, 1, 1],
                "nodeName": [1, 2, 3],
                "nodeValue": [-1, -1, -1],
                "backendNodeId": [1, 101, 202],
                "attributes": [[], [4, 5], []],
                "childNodeIndexes": [1, 2, -1]
            },
            "layout": {
                "nodeIndex": [0, 1, 2],
                "bounds": [
                    [0, 0, 800, 600],
                    [0, 0, 320, 240],
                    [10, 10, 120, 36]
                ]
            }
        }]
    })
}

/// 子帧会话快照应答：子文档（frameId=F1）+ 按钮(202)——与主树 backendNodeId
/// **复用**（跨会话 id 空间独立），验证索引碰撞由合成索引消解。
fn frame_capture_fixture() -> Value {
    json!({
        "strings": ["", "#document", "BUTTON", "https://b.example/embed"],
        "documents": [{
            "documentURL": 3,
            "title": 0,
            "frameId": "F1",
            "nodes": {
                "parentIndex": [-1, 0],
                "nodeType": [9, 1],
                "nodeName": [1, 2],
                "nodeValue": [-1, -1],
                "backendNodeId": [1001, 202],
                "attributes": [[], []],
                "childNodeIndexes": [1, -1]
            },
            "layout": {
                "nodeIndex": [0, 1],
                "bounds": [
                    [0, 0, 640, 480],
                    [0, 0, 100, 30]
                ]
            }
        }]
    })
}

/// mock CDP 会话面辅助：建连（恢复流程自动应答见 restore_reply_map）。
async fn connect_mock(mock: &MockServer, ws_path: &str) -> Arc<BrowserSession> {
    let endpoint = CdpEndpoint {
        port: mock.addr.port(),
        ws_path: ws_path.to_string(),
    };
    Arc::new(
        BrowserSession::connect(
            endpoint,
            ExpectedBrowser {
                product_prefix: Some("Chrome/".to_string()),
                min_major: None,
            },
            Arc::new(AllowHooks::new()),
        )
        .await
        .expect("建连失败"),
    )
}

/// 两态之一的主采集驱动：等待主 captureSnapshot 并应答（递归开启时再答一帧）。
async fn drive_capture_snapshot(mock: &mut MockServer, reply_value: Value) {
    let cmd = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        mock.expect_command("DOMSnapshot.captureSnapshot"),
    )
    .await
    .expect("等待 captureSnapshot 超时");
    let id = cmd["id"].as_u64().expect("命令 id 缺失");
    mock.reply(id, reply_value);
}

mod cross_origin;
mod node_helpers;
mod payload_budget;
mod tree_and_frames;
