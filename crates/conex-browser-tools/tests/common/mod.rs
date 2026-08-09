//! 集成测试共享面：MockSession（SessionOps 替身）与注册辅助
//!
//! Mock 语义：记录全部命令/动作/等待请求（参数透传断言面），返回固定 canned
//! 响应（返回结构断言面）。与 RealSession 共用同一 `SessionOps` trait 面，
//! 证明工具层不依赖具体会话实现。

#![allow(dead_code)]

use agent_tools::definition::ToolError;
use async_trait::async_trait;
use conex_browser::action::{
    ActionError, ActionRequest, ActionSuccess, ElementMeta, WaitCondition, WaitOptions,
};
use conex_browser::snapshot::budget::BudgetConfig;
use conex_browser::SessionRef;
use conex_browser_tools::session::{ConsoleEntry, NetworkEntry, SessionOps, SnapshotView};
use conex_browser_tools::{BrowserToolsConfig, SensitiveCapabilities};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

/// 会话替身：记录调用 + canned 响应。
pub struct MockSession {
    pub log: Mutex<Vec<String>>,
}

impl MockSession {
    pub fn new() -> Arc<Self> {
        Arc::new(MockSession {
            log: Mutex::new(Vec::new()),
        })
    }

    pub fn record(&self, line: String) {
        self.log
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(line);
    }

    pub fn calls(&self) -> Vec<String> {
        self.log.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// 断言某条记录存在（参数透传）。
    pub fn assert_recorded(&self, needle: &str) {
        let calls = self.calls();
        assert!(
            calls.iter().any(|c| c.contains(needle)),
            "应记录含 {needle:?} 的调用：{calls:?}"
        );
    }
}

#[async_trait]
impl SessionOps for MockSession {
    fn readiness(&self) -> Result<(), String> {
        Ok(())
    }

    fn current_tab(&self) -> Result<SessionRef, ToolError> {
        Ok(SessionRef {
            target_id: "T1".to_string(),
            session: "S1".to_string(),
        })
    }

    async fn send_page(
        &self,
        _session: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, ToolError> {
        self.record(format!("page:{method} {params}"));
        match method {
            "Page.navigate" => Ok(json!({ "frameId": "F1" })),
            "Page.captureScreenshot" => Ok(json!({ "data": "QUJD" })),
            _ => Ok(json!({})),
        }
    }

    async fn send_browser(&self, method: &str, params: Value) -> Result<Value, ToolError> {
        self.record(format!("browser:{method} {params}"));
        match method {
            "Target.getTargets" => Ok(json!({
                "targetInfos": [
                    { "targetId": "T1", "type": "page", "title": "页A", "url": "https://a.example/" },
                    { "targetId": "T2", "type": "page", "title": "页B", "url": "https://b.example/" },
                    { "targetId": "W1", "type": "webview", "title": "", "url": "about:blank" }
                ]
            })),
            "Target.getTargetInfo" => Ok(json!({
                "targetInfo": { "targetId": "T1", "type": "page", "title": "标题A", "url": "https://a.example/after" }
            })),
            "Target.createTarget" => Ok(json!({ "targetId": "T9" })),
            "Target.closeTarget" => Ok(json!({ "success": true })),
            _ => Ok(json!({})),
        }
    }

    fn snapshot_version(&self, _tab_id: &str) -> u64 {
        7
    }

    async fn capture_snapshot(
        &self,
        tab_id: &str,
        _session: &str,
        _budgets: BudgetConfig,
    ) -> Result<SnapshotView, ToolError> {
        self.record(format!("snapshot:capture tab={tab_id}"));
        Ok(SnapshotView {
            snapshot_version: 7,
            tree: "TREE_TEXT".to_string(),
            warnings: vec![],
        })
    }

    fn element_meta(
        &self,
        _tab_id: &str,
        _version: u64,
        _index: u32,
    ) -> Result<Option<ElementMeta>, ToolError> {
        Ok(Some(ElementMeta {
            backend_node_id: 42,
            is_password: false,
        }))
    }

    async fn execute_action(&self, req: ActionRequest) -> Result<ActionSuccess, ActionError> {
        self.record(format!(
            "action:tab={} version={} element={:?} primitive={:?}",
            req.tab_id, req.snapshot_version, req.element, req.primitive
        ));
        Ok(ActionSuccess {
            navigated: false,
            url_after: None,
            page_changed: false,
            payload: None,
        })
    }

    async fn wait_for(
        &self,
        cond: WaitCondition,
        _opts: WaitOptions,
    ) -> Result<ActionSuccess, ActionError> {
        self.record(format!("wait:{cond:?}"));
        Ok(ActionSuccess {
            navigated: false,
            url_after: None,
            page_changed: false,
            payload: None,
        })
    }

    async fn console_entries(&self, since_seq: u64) -> Vec<ConsoleEntry> {
        vec![
            ConsoleEntry {
                seq: 1,
                level: "info".to_string(),
                text: "hello".to_string(),
            },
            ConsoleEntry {
                seq: 2,
                level: "error".to_string(),
                text: "boom".to_string(),
            },
        ]
        .into_iter()
        .filter(|e| e.seq > since_seq)
        .collect()
    }

    async fn network_entries(&self, since_seq: u64) -> Vec<NetworkEntry> {
        vec![NetworkEntry {
            seq: 1,
            id: "r1".to_string(),
            url: "https://a.example/x?token=abc".to_string(),
            method: "GET".to_string(),
            done: true,
        }]
        .into_iter()
        .filter(|e| e.seq > since_seq)
        .collect()
    }
}

/// 带 mock 会话的注册配置（upload 能力位可开关）。
pub fn mock_config(mock: &Arc<MockSession>, upload_enabled: bool) -> BrowserToolsConfig {
    BrowserToolsConfig {
        session_ops: Some(mock.clone()),
        sensitive: SensitiveCapabilities {
            upload: upload_enabled,
            ..Default::default()
        },
        ..Default::default()
    }
}

/// 空配置（无会话 → not_ready 契约面）。
pub fn empty_config() -> BrowserToolsConfig {
    BrowserToolsConfig::default()
}

/// 全部 23 个工具名（注册数精确断言的实现清单，与 register_browser_tools 一致）。
pub const ALL_TOOL_NAMES: [&str; 23] = [
    "browser_navigate",
    "browser_back",
    "browser_forward",
    "browser_reload",
    "browser_list_tabs",
    "browser_new_tab",
    "browser_close_tab",
    "browser_switch_tab",
    "browser_snapshot",
    "browser_screenshot",
    "browser_wait_for",
    "browser_get_url",
    "browser_get_title",
    "browser_click",
    "browser_type",
    "browser_key",
    "browser_scroll",
    "browser_hover",
    "browser_drag",
    "browser_select_option",
    "browser_upload",
    "browser_console",
    "browser_network",
];

/// 危险矩阵：交互 8 个全 dangerous=true，其余 15 个 false。
pub const DANGEROUS_TOOLS: [&str; 8] = [
    "browser_click",
    "browser_type",
    "browser_key",
    "browser_scroll",
    "browser_hover",
    "browser_drag",
    "browser_select_option",
    "browser_upload",
];
