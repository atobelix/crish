//! 真实浏览器 ops 实现（BrowserPageOps）。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::error::*;
use super::network::NetworkCounter;
use super::traits::PageOps;
use crate::action::locate::ViewportSize;
use crate::action::{ActionError, ActionErrorKind};
use crate::cdp::domains::{
    BoxModel, CallArgument, DispatchKeyEventParams, DispatchMouseEventParams,
    GetLayoutMetricsResult, GetNavigationHistoryResult,
};
use crate::cdp::sender::Command;
use crate::BrowserSession;

/// 真实浏览器 ops（`BrowserSession` 包装；默认绑定当前活动标签会话，
/// P1 可用 `with_session` 绑定具体标签会话——per-tab 动作路由）。
pub struct BrowserPageOps {
    pub(crate) session: Arc<BrowserSession>,
    network: Arc<NetworkCounter>,
    /// 绑定的 CDP 会话（P1 多标签：per-tab 执行器按目标标签解析一次后绑定；
    /// None = 活动标签兜底，向后兼容）
    bound_session: Option<String>,
}

impl BrowserPageOps {
    /// 新建 ops（自动启动在途请求计数订阅，维度 11 事件总线；活动标签兜底）。
    pub fn new(session: Arc<BrowserSession>) -> Self {
        let network = NetworkCounter::new(session.subscribe());
        BrowserPageOps {
            session,
            network,
            bound_session: None,
        }
    }

    /// 绑定具体标签会话（P1 多标签：动作入口按 tab_id 路由解析后绑定，
    /// 后续全部 CDP 调用固定走该会话——并发动作天然隔离，无共享态漂移）。
    pub fn with_session(mut self, session: String) -> Self {
        self.bound_session = Some(session);
        self
    }

    /// 当前目标会话（绑定会话优先；缺省活动标签会话）。
    fn session_id(&self) -> Result<String, ActionError> {
        if let Some(bound) = &self.bound_session {
            return Ok(bound.clone());
        }
        self.session
            .current_session()
            .map(|r| r.session)
            .map_err(|e| map_cdp_error(e, "current_session"))
    }

    pub(crate) async fn send(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, ActionError> {
        let session = self.session_id()?;
        let command = Command::new(method)
            .params(params)
            .with_session(session)
            .with_timeout(timeout);
        self.session
            .send(command)
            .await
            .map_err(|e| map_cdp_error(e, method))
    }
}

#[async_trait]
impl PageOps for BrowserPageOps {
    async fn current_url(&self) -> Result<String, ActionError> {
        let value = self
            .send(CDP_PAGE_GET_NAVIGATION_HISTORY, json!({}), CMD_TIMEOUT)
            .await?;
        let history: GetNavigationHistoryResult = serde_json::from_value(value).map_err(|e| {
            ActionError::new(
                ActionErrorKind::ContextGone,
                format!("导航历史解析失败：{e}"),
            )
        })?;
        let url = history
            .entries
            .get(history.current_index.max(0) as usize)
            .map(|e| e.url.clone())
            .unwrap_or_default();
        Ok(url)
    }

    async fn viewport(&self) -> Result<ViewportSize, ActionError> {
        let value = self
            .send(CDP_PAGE_GET_LAYOUT_METRICS, json!({}), CMD_TIMEOUT)
            .await?;
        let metrics: GetLayoutMetricsResult = serde_json::from_value(value).map_err(|e| {
            ActionError::new(
                ActionErrorKind::ContextGone,
                format!("布局度量解析失败：{e}"),
            )
        })?;
        Ok(ViewportSize {
            width: metrics.layout_viewport.viewport_width(),
            height: metrics.layout_viewport.viewport_height(),
        })
    }

    async fn push_nodes(&self, backend_ids: &[i64]) -> Result<Vec<i64>, ActionError> {
        let value = self
            .send(
                CDP_DOM_PUSH_NODES,
                json!({ "backendNodeIds": backend_ids }),
                CMD_TIMEOUT,
            )
            .await?;
        serde_json::from_value(value)
            .map_err(|e| {
                ActionError::new(
                    ActionErrorKind::NodeStale,
                    format!("pushNodes 结果解析失败：{e}"),
                )
            })
            .map(|r: crate::cdp::domains::PushNodesByBackendIdsToFrontendResult| r.node_ids)
    }

    async fn box_model(&self, node_id: i64) -> Result<BoxModel, ActionError> {
        let value = self
            .send(
                CDP_DOM_GET_BOX_MODEL,
                json!({ "nodeId": node_id }),
                CMD_TIMEOUT,
            )
            .await?;
        serde_json::from_value(value)
            .map_err(|e| {
                ActionError::new(
                    ActionErrorKind::NodeStale,
                    format!("getBoxModel 结果解析失败：{e}"),
                )
            })
            .map(|r: crate::cdp::domains::GetBoxModelResult| r.model)
    }

    async fn scroll_into_view(&self, node_id: i64) -> Result<(), ActionError> {
        self.send(
            CDP_DOM_SCROLL_INTO_VIEW,
            json!({ "nodeId": node_id }),
            CMD_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    async fn focus_node(&self, node_id: i64) -> Result<(), ActionError> {
        self.send(CDP_DOM_FOCUS, json!({ "nodeId": node_id }), CMD_TIMEOUT)
            .await?;
        Ok(())
    }

    async fn resolve_node(&self, node_id: i64) -> Result<String, ActionError> {
        let value = self
            .send(
                CDP_DOM_RESOLVE_NODE,
                json!({ "nodeId": node_id }),
                CMD_TIMEOUT,
            )
            .await?;
        let resolved: crate::cdp::domains::ResolveNodeResult = serde_json::from_value(value)
            .map_err(|e| {
                ActionError::new(
                    ActionErrorKind::NodeStale,
                    format!("resolveNode 结果解析失败：{e}"),
                )
            })?;
        resolved.object.object_id.ok_or_else(|| {
            ActionError::new(
                ActionErrorKind::NodeStale,
                "resolveNode 未返回 objectId（节点已过期）",
            )
        })
    }

    async fn call_function_on(
        &self,
        object_id: &str,
        function: &str,
        args: &[Value],
    ) -> Result<Value, ActionError> {
        // 参数经 CallArgument.value 序列化注入（JSON 序列化，永不经字符串拼接）
        let call_args: Vec<CallArgument> = args
            .iter()
            .map(|v| CallArgument {
                value: Some(v.clone()),
                object_id: None,
            })
            .collect();
        let value = self
            .send(
                CDP_RUNTIME_CALL_FUNCTION_ON,
                json!({
                    "functionDeclaration": function,
                    "objectId": object_id,
                    "arguments": call_args,
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
                CMD_TIMEOUT,
            )
            .await?;
        let evaluated: crate::cdp::domains::EvaluateResult = serde_json::from_value(value)
            .map_err(|e| {
                ActionError::new(
                    ActionErrorKind::Unsupported,
                    format!("callFunctionOn 结果解析失败：{e}"),
                )
            })?;
        if evaluated.exception_details.is_some() {
            return Err(ActionError::new(
                ActionErrorKind::Unsupported,
                "页面内函数执行抛异常（固定模板不应失败）",
            ));
        }
        Ok(evaluated.result.value.unwrap_or(Value::Null))
    }

    async fn mouse_event(&self, params: DispatchMouseEventParams) -> Result<(), ActionError> {
        self.send(
            CDP_INPUT_DISPATCH_MOUSE,
            serde_json::to_value(params).unwrap_or(Value::Null),
            CMD_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    async fn key_event(&self, params: DispatchKeyEventParams) -> Result<(), ActionError> {
        self.send(
            CDP_INPUT_DISPATCH_KEY,
            serde_json::to_value(params).unwrap_or(Value::Null),
            CMD_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    async fn insert_text(&self, text: &str) -> Result<(), ActionError> {
        self.send(CDP_INPUT_INSERT_TEXT, json!({ "text": text }), CMD_TIMEOUT)
            .await?;
        Ok(())
    }

    async fn evaluate(&self, expression: &str) -> Result<Value, ActionError> {
        let value = self
            .send(
                CDP_RUNTIME_EVALUATE,
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                    "timeout": 2000,
                }),
                CMD_TIMEOUT,
            )
            .await?;
        let evaluated: crate::cdp::domains::EvaluateResult = serde_json::from_value(value)
            .map_err(|e| {
                ActionError::new(
                    ActionErrorKind::Unsupported,
                    format!("evaluate 结果解析失败：{e}"),
                )
            })?;
        if evaluated.exception_details.is_some() {
            return Err(ActionError::new(
                ActionErrorKind::Unsupported,
                "页面求值异常（固定模板不应失败）",
            ));
        }
        Ok(evaluated.result.value.unwrap_or(Value::Null))
    }

    async fn create_isolated_world(&self) -> Result<String, ActionError> {
        self.create_isolated_world_impl().await
    }

    async fn evaluate_isolated(
        &self,
        world_id: &str,
        expression: &str,
    ) -> Result<Value, ActionError> {
        self.evaluate_isolated_impl(world_id, expression).await
    }

    async fn network_in_flight(&self) -> Result<usize, ActionError> {
        Ok(self.network.in_flight())
    }

    async fn set_file_input_files(
        &self,
        backend_node_id: i64,
        files: &[String],
    ) -> Result<(), ActionError> {
        self.set_file_input_files_impl(backend_node_id, files).await
    }

    async fn is_file_input(&self, node_id: i64) -> Result<bool, ActionError> {
        self.is_file_input_impl(node_id).await
    }

    async fn file_chooser_node(&self, timeout: Duration) -> Result<i64, ActionError> {
        self.file_chooser_node_impl(timeout).await
    }

    async fn await_connection_restored(&self, timeout: Duration) -> Result<(), ActionError> {
        self.await_connection_restored_impl(timeout).await
    }

    async fn go_back(&self) -> Result<(), ActionError> {
        self.send(CDP_PAGE_GO_BACK, json!({}), CMD_TIMEOUT).await?;
        Ok(())
    }

    async fn target_alive(&self) -> Result<bool, ActionError> {
        // MVP：活动标签会话存在即存活（P1 细化目标探测）
        Ok(self.session.current_session().is_ok())
    }
}
