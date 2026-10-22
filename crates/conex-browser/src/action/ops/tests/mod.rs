//! action::ops 测试套件与共享 Mock 辅助。

use std::sync::Arc;

use serde_json::json;

use crate::cdp::error::CdpError;
use crate::cdp::mock::MockReply;

mod isolated_world;
mod network;
mod page_ops;

/// 放行策略钩子（会话面集成测试用）。
pub(super) struct AllowHooks;

#[async_trait::async_trait]
impl crate::cdp::sender::CommandPolicyHooks for AllowHooks {
    async fn idempotent(
        &self,
        _key: &crate::cdp::sender::IdKey,
    ) -> Option<Result<serde_json::Value, CdpError>> {
        None
    }
    async fn approve(
        &self,
        _cmd: &crate::cdp::sender::CdpCommandView,
    ) -> Result<(), crate::cdp::sender::ApprovalDenied> {
        Ok(())
    }
    fn audit(&self, _event: crate::cdp::sender::BrowserAuditEvent) {}
    fn emergency_stop(&self) -> Arc<std::sync::atomic::AtomicBool> {
        Arc::new(std::sync::atomic::AtomicBool::new(false))
    }
    fn abort_token(&self) -> crate::cdp::sender::CancellationToken {
        crate::cdp::sender::CancellationToken::new()
    }
}

/// 会话恢复所需 mock 自动应答全表（与 lib.rs 会话面集成测试同源）。
pub(super) fn restore_reply_map() -> Vec<(&'static str, MockReply)> {
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

/// 采集四路应答（Chrome 151 实测形态 fixture：backendNodeId / Rare*Data 映射 /
/// 无 nodeCount / documentURL 池下标 / layoutViewport 新字段；
/// M2：INPUT 节点带 type=password 属性，用于密码标记断言）。
pub(super) fn collector_reply_map() -> Vec<(&'static str, MockReply)> {
    vec![
        (
            "DOMSnapshot.captureSnapshot",
            MockReply::Ok(json!({
                "strings": [
                    "data:text/html;charset=utf-8,page",
                    "联调测试页",
                    "#document", "HTML", "HEAD", "BODY", "INPUT",
                    "id", "name", "BUTTON", "中文按钮", "#text", "DIV", "out", "初始文本",
                    "type", "password"
                ],
                "documents": [{
                    "documentURL": 0,
                    "title": 1,
                    "nodes": {
                        "attributes": [[], [], [], [7, 8, 15, 16], [], [7, 13], []],
                        "backendNodeId": [2, 3, 4, 1, 6, 5, 7],
                        "contentDocumentIndex": { "index": [], "value": [] },
                        "currentSourceURL": { "index": [], "value": [] },
                        "inputChecked": { "index": [] },
                        "inputValue": { "index": [3], "value": [-1] },
                        "isClickable": { "index": [3, 4] },
                        "nodeName": [2, 3, 5, 6, 9, 12, 11],
                        "nodeType": [9, 1, 1, 1, 1, 1, 3],
                        "nodeValue": [-1, -1, -1, -1, -1, -1, 14],
                        "optionSelected": { "index": [] },
                        "originURL": { "index": [], "value": [] },
                        "parentIndex": [-1, 0, 1, 2, 2, 2, 5],
                        "pseudoIdentifier": { "index": [], "value": [] },
                        "pseudoType": { "index": [], "value": [] },
                        "shadowRootType": { "index": [], "value": [] },
                        "textValue": { "index": [], "value": [] }
                    },
                    "layout": {
                        "nodeIndex": [0, 1, 2, 3, 4, 5, 6],
                        "bounds": [
                            [0, 0, 1262, 624], [8, 8, 1246, 608], [8, 8, 1246, 600],
                            [8, 8, 177, 21], [185, 8, 100, 30], [8, 100, 64, 24], [8, 124, 60, 20]
                        ]
                    }
                }]
            })),
        ),
        (
            "DOM.getDocument",
            MockReply::Ok(json!({
                "root": { "nodeId": 1, "backendNodeId": 1, "nodeType": 9, "nodeName": "#document", "attributes": [], "children": [] }
            })),
        ),
        (
            "Page.getLayoutMetrics",
            MockReply::Ok(json!({
                "layoutViewport": { "pageX": 0, "pageY": 0, "clientWidth": 1262, "clientHeight": 624 },
                "visualViewport": { "offsetX": 0, "offsetY": 0, "pageX": 0, "pageY": 0, "clientWidth": 1262, "clientHeight": 624, "scale": 1 },
                "contentSize": { "x": 0, "y": 0, "width": 1262, "height": 624 }
            })),
        ),
        (
            "Accessibility.getFullAXTree",
            MockReply::Ok(json!({ "nodes": [] })),
        ),
    ]
}
