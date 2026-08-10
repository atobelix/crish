//! CDP 交互抽象（PageOps）与真实浏览器实现（维度 14 消费面）
//!
//! - `PageOps`：动作层全部 CDP 交互的 trait 抽象——真实实现 `BrowserPageOps`
//!   （经统一发送层 `BrowserSession`）与确定性测试 mock（mocks.rs）共用同一执行器；
//! - `BrowserPageOps`：`BrowserSession` 包装（缺省绑定当前活动标签；P1 经
//!   `with_session` 绑定具体标签会话——per-tab 动作路由，动作入口按 tab_id 解析）；
//! - `BrowserSnapshotStore`：`SnapshotStore` 契约的真实实现（维度 11/13 门面，
//!   R-1 per-tab 签名；会话解析经注入闭包，P1 提供 `session_for_tab` 辅助）；
//! - `Delay`：延迟注入抽象（真实 tokio sleep / 测试记录型），重试延迟与 type 节流共用。
//!
//! 错误映射：`CdpError` → `ActionError` 按维度 14 §5.1 表（TargetClosed/ContextGone/
//! NodeStale/ConnectionLost/Aborted/Timeout/NotReady 各归其类，R-9）；M4 修正：
//! Internal/Serialize 归 Unsupported（Fatal 不重试）——内部错误重试不会自愈。

use crate::action::locate::ViewportSize;
use crate::action::{ActionError, ActionErrorKind, ElementMeta, SnapshotStore};
use crate::cdp::bus::{BrowserEvent, VersionReason};
use crate::cdp::domains::{
    BoxModel, CallArgument, DispatchKeyEventParams, DispatchMouseEventParams,
    GetLayoutMetricsResult, GetNavigationHistoryResult,
};
use crate::cdp::error::CdpError;
use crate::cdp::sender::Command;
use crate::cdp::version::{Stale, TabId};
use crate::snapshot::budget::BudgetConfig;
use crate::snapshot::SnapshotManager;
use crate::BrowserSession;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 命令级超时（对齐表 2-1 原语默认值：click/hover/drag/focus/key 15s，滚动 8s 等；
/// 统一 15s 为 MVP 默认，env 覆盖接线在 M7 工具层）。
const CMD_TIMEOUT: Duration = Duration::from_secs(15);

// CDP 方法名（本模块内部使用；与 cdp/domains.rs 的 names 常量互补）
const CDP_PAGE_GET_NAVIGATION_HISTORY: &str = "Page.getNavigationHistory";
const CDP_PAGE_GET_LAYOUT_METRICS: &str = "Page.getLayoutMetrics";
const CDP_PAGE_GO_BACK: &str = "Page.goBack";
const CDP_DOM_PUSH_NODES: &str = "DOM.pushNodesByBackendIdsToFrontend";
const CDP_DOM_GET_BOX_MODEL: &str = "DOM.getBoxModel";
const CDP_DOM_SCROLL_INTO_VIEW: &str = "DOM.scrollIntoViewIfNeeded";
const CDP_DOM_FOCUS: &str = "DOM.focus";
const CDP_DOM_RESOLVE_NODE: &str = "DOM.resolveNode";
const CDP_DOM_SET_FILE_INPUT_FILES: &str = "DOM.setFileInputFiles";
const CDP_RUNTIME_CALL_FUNCTION_ON: &str = "Runtime.callFunctionOn";
const CDP_RUNTIME_EVALUATE: &str = "Runtime.evaluate";
const CDP_RUNTIME_CREATE_ISOLATED_WORLD: &str = "Runtime.createIsolatedWorld";
const CDP_INPUT_DISPATCH_MOUSE: &str = "Input.dispatchMouseEvent";
const CDP_INPUT_DISPATCH_KEY: &str = "Input.dispatchKeyEvent";
const CDP_INPUT_INSERT_TEXT: &str = "Input.insertText";

/// 延迟注入抽象（重试延迟/type 节流/轮询间隔共用；测试注入记录型不真实等待）。
#[async_trait]
pub trait Delay: Send + Sync {
    async fn sleep(&self, duration: Duration);
}

/// 真实延迟（tokio sleep）。
pub struct TokioDelay;

#[async_trait]
impl Delay for TokioDelay {
    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// CDP 交互抽象（维度 14 消费面；真实实现 BrowserPageOps / 测试 mock 共用执行器）。
///
/// 全部方法按 `ActionError` 分类返回（映射口径见模块头注释），供重试状态机决策；
/// 命令参数一律经 JSON 序列化注入，函数模板固定、参数永不字符串拼接（R-5 纪律）。
#[async_trait]
pub trait PageOps: Send + Sync {
    /// 当前页面 URL（门禁动作检查点/导航复核/wait_for Url 条件）。
    async fn current_url(&self) -> Result<String, ActionError>;
    /// 布局视口尺寸（§3.3 坐标裁剪用）。
    async fn viewport(&self) -> Result<ViewportSize, ActionError>;
    /// DOM.pushNodesByBackendIdsToFrontend（backendNodeId → 前端树 nodeId）。
    async fn push_nodes(&self, backend_ids: &[i64]) -> Result<Vec<i64>, ActionError>;
    /// DOM.getBoxModel（nodeId；"Could not compute box model" → NodeStale）。
    async fn box_model(&self, node_id: i64) -> Result<BoxModel, ActionError>;
    /// DOM.scrollIntoViewIfNeeded（§3.2 滚动容器路径）。
    async fn scroll_into_view(&self, node_id: i64) -> Result<(), ActionError>;
    /// DOM.focus（无坐标路径聚焦）。
    async fn focus_node(&self, node_id: i64) -> Result<(), ActionError>;
    /// DOM.resolveNode → objectId（遮挡检测/select/回读共用）。
    async fn resolve_node(&self, node_id: i64) -> Result<String, ActionError>;
    /// Runtime.callFunctionOn（固定模板 + args 序列化注入，`this` 绑定目标元素）。
    async fn call_function_on(
        &self,
        object_id: &str,
        function: &str,
        args: &[Value],
    ) -> Result<Value, ActionError>;
    /// Input.dispatchMouseEvent（click/hover/drag/scroll 统一注入管线）。
    async fn mouse_event(&self, params: DispatchMouseEventParams) -> Result<(), ActionError>;
    /// Input.dispatchKeyEvent（type 三事件序列 / key 组合键）。
    async fn key_event(&self, params: DispatchKeyEventParams) -> Result<(), ActionError>;
    /// Input.insertText（IME 安全路径，§4.4）。
    async fn insert_text(&self, text: &str) -> Result<(), ActionError>;
    /// Runtime.evaluate（固定模板只读求值；wait_for 文本轮询/回读校验）。
    async fn evaluate(&self, expression: &str) -> Result<Value, ActionError>;
    /// Runtime.createIsolatedWorld（17 §3.2：evaluate 受限求值的隔离世界）。
    async fn create_isolated_world(&self) -> Result<String, ActionError>;
    /// Runtime.evaluate 于隔离世界执行（17 §3.2：awaitPromise/2s 超时/userGesture=false/
    /// returnByValue=true；返回纯 JSON 拷贝）。
    async fn evaluate_isolated(&self, world_id: &str, expression: &str) -> Result<Value, ActionError>;
    /// 在途请求数（wait_for NetworkIdle 条件）。
    async fn network_in_flight(&self) -> Result<usize, ActionError>;
    /// DOM.setFileInputFiles（上传直接路径，§9.1 4a）。
    async fn set_file_input_files(
        &self,
        backend_node_id: i64,
        files: &[String],
    ) -> Result<(), ActionError>;
    /// 元素是否为 input[type=file]（固定模板判定，§9.1 步骤 4 分流）。
    async fn is_file_input(&self, node_id: i64) -> Result<bool, ActionError>;
    /// 等待 Page.fileChooserOpened 事件（代理触发器路径，§9.1 4b）。
    async fn file_chooser_node(&self, timeout: Duration) -> Result<i64, ActionError>;
    /// 等待 ConnectionRestored 恢复事件（R-9，ConnectionLost 恢复路径）。
    async fn await_connection_restored(&self, timeout: Duration) -> Result<(), ActionError>;
    /// Page.goBack（门禁后置复核回退，§7.1 ③）。
    async fn go_back(&self) -> Result<(), ActionError>;
    /// 目标（标签页）存活探测（TargetClosed 恢复路径，§5.1）。
    async fn target_alive(&self) -> Result<bool, ActionError>;
}

/// 在途请求计数（wait_for NetworkIdle 消费，维度 11 事件总线订阅维护）。
pub struct NetworkCounter {
    in_flight: Arc<AtomicUsize>,
    /// 订阅任务句柄（Drop 时 abort 终止——M3：任务不再持有 Arc<Self> 自保活，
    /// 计数 Arc 归零即收尸，杜绝每实例常驻订阅任务泄漏）
    handle: tokio::task::JoinHandle<()>,
}

impl NetworkCounter {
    pub fn new(mut rx: tokio::sync::broadcast::Receiver<BrowserEvent>) -> Arc<Self> {
        let in_flight = Arc::new(AtomicUsize::new(0));
        let task_in_flight = in_flight.clone();
        let handle = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(BrowserEvent::NetworkRequest { .. }) => {
                        task_in_flight.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(BrowserEvent::NetworkDone { .. }) => {
                        task_in_flight
                            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                                Some(n.saturating_sub(1))
                            })
                            .ok();
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        Arc::new(NetworkCounter { in_flight, handle })
    }

    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::Relaxed)
    }
}

impl Drop for NetworkCounter {
    /// 终止常驻订阅任务（M3：Arc 归零即收尸，任务不得活到总线关闭）。
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// CdpError → ActionError 映射（14 §5.1 表；R-9 分类）。
fn map_cdp_error(err: CdpError, method: &str) -> ActionError {
    let raw = err.to_string();
    let kind = match &err {
        CdpError::ContextGone { message, .. } => {
            if message.contains("Target closed")
                || message.contains("Target page, context or browser has been closed")
            {
                ActionErrorKind::TargetClosed
            } else {
                ActionErrorKind::ContextGone
            }
        }
        CdpError::ConnectionLost => ActionErrorKind::ConnectionLost,
        CdpError::Timeout { .. } => ActionErrorKind::Timeout,
        CdpError::Cancelled {
            reason: crate::cdp::error::CancelReason::Aborted,
        }
        | CdpError::Cancelled {
            reason: crate::cdp::error::CancelReason::EmergencyStop,
        } => ActionErrorKind::Aborted,
        CdpError::ApprovalDenied { .. } => ActionErrorKind::ApprovalDenied,
        CdpError::NotReady(_) => ActionErrorKind::TargetRestarting,
        CdpError::NoActiveTab => ActionErrorKind::TargetClosed,
        CdpError::NoSuchTab { .. } => ActionErrorKind::TargetClosed,
        CdpError::Server { message, .. } => {
            if message.contains("No node with given id found")
                || message.contains("Could not compute box model")
            {
                ActionErrorKind::NodeStale
            } else {
                ActionErrorKind::ContextGone
            }
        }
        CdpError::BadParams { .. } | CdpError::Protocol { .. } => ActionErrorKind::InvalidInput,
        // M4：内部/序列化错误非导航竞态——重试不会自愈，归 Fatal 类（Unsupported
        // 策略不重试）；旧实现误归 ContextGone 白白延迟重试 3 次并掩盖真实错误
        CdpError::Internal { .. } | CdpError::Serialize { .. } => ActionErrorKind::Unsupported,
        CdpError::DomainUnavailable { .. } => ActionErrorKind::Unsupported,
    };
    ActionError::new(kind, format!("CDP 命令失败[{method}]：{raw}")).with_cdp_raw(raw)
}

/// 真实浏览器 ops（`BrowserSession` 包装；默认绑定当前活动标签会话，
/// P1 可用 `with_session` 绑定具体标签会话——per-tab 动作路由）。
pub struct BrowserPageOps {
    session: Arc<BrowserSession>,
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

    async fn send(
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
        self.session.send(command).await.map_err(|e| map_cdp_error(e, method))
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
            ActionError::new(ActionErrorKind::ContextGone, format!("布局度量解析失败：{e}"))
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
            .send(CDP_DOM_GET_BOX_MODEL, json!({ "nodeId": node_id }), CMD_TIMEOUT)
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
            .send(CDP_DOM_RESOLVE_NODE, json!({ "nodeId": node_id }), CMD_TIMEOUT)
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
        let value = self
            .send(
                CDP_RUNTIME_CREATE_ISOLATED_WORLD,
                json!({ "worldName": "crish-read-only", "grantUniversalAccess": false }),
                CMD_TIMEOUT,
            )
            .await?;
        let world: crate::cdp::domains::CreateIsolatedWorldResult =
            serde_json::from_value(value).map_err(|e| {
                ActionError::new(
                    ActionErrorKind::Unsupported,
                    format!("createIsolatedWorld 结果解析失败：{e}"),
                )
            })?;
        Ok(world.execution_context_id.to_string())
    }

    async fn evaluate_isolated(&self, world_id: &str, expression: &str) -> Result<Value, ActionError> {
        let context_id: i64 = world_id.parse().map_err(|_| {
            ActionError::new(ActionErrorKind::Unsupported, "非法隔离世界标识")
        })?;
        let value = self
            .send(
                CDP_RUNTIME_EVALUATE,
                json!({
                    "expression": expression,
                    "contextId": context_id,
                    "returnByValue": true,
                    "awaitPromise": true,
                    "userGesture": false,
                    "timeout": 2000,
                    "generatePreview": false,
                }),
                CMD_TIMEOUT,
            )
            .await?;
        let evaluated: crate::cdp::domains::EvaluateResult = serde_json::from_value(value)
            .map_err(|e| {
                ActionError::new(
                    ActionErrorKind::Unsupported,
                    format!("evaluate_isolated 结果解析失败：{e}"),
                )
            })?;
        if evaluated.exception_details.is_some() {
            return Err(ActionError::new(
                ActionErrorKind::InvalidInput,
                "受限求值执行异常",
            ));
        }
        Ok(evaluated.result.value.unwrap_or(Value::Null))
    }

    async fn network_in_flight(&self) -> Result<usize, ActionError> {
        Ok(self.network.in_flight())
    }

    async fn set_file_input_files(
        &self,
        backend_node_id: i64,
        files: &[String],
    ) -> Result<(), ActionError> {
        self.send(
            CDP_DOM_SET_FILE_INPUT_FILES,
            json!({ "backendNodeId": backend_node_id, "files": files }),
            CMD_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    async fn is_file_input(&self, node_id: i64) -> Result<bool, ActionError> {
        let object_id = self.resolve_node(node_id).await?;
        let value = self
            .call_function_on(
                &object_id,
                crate::action::upload::IS_FILE_INPUT_TEMPLATE,
                &[],
            )
            .await?;
        Ok(value.as_bool().unwrap_or(false))
    }

    async fn file_chooser_node(&self, timeout: Duration) -> Result<i64, ActionError> {
        let mut rx = self.session.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(ActionError::new(
                    ActionErrorKind::Timeout,
                    format!("等待 Page.fileChooserOpened 超时（{}ms）", timeout.as_millis()),
                ));
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(BrowserEvent::FileChooserOpened {
                    backend_node_id, ..
                })) => return Ok(backend_node_id),
                Ok(Ok(_)) => {}
                Ok(Err(_)) => {
                    return Err(ActionError::new(
                        ActionErrorKind::TargetClosed,
                        "事件总线关闭（目标已销毁）",
                    ))
                }
                Err(_) => {
                    return Err(ActionError::new(
                        ActionErrorKind::Timeout,
                        format!("等待 Page.fileChooserOpened 超时（{}ms）", timeout.as_millis()),
                    ))
                }
            }
        }
    }

    async fn await_connection_restored(&self, timeout: Duration) -> Result<(), ActionError> {
        let mut rx = self.session.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(ActionError::new(
                    ActionErrorKind::ConnectionLost,
                    format!("等待 ConnectionRestored 超时（{}s，恢复窗口 R-9）", timeout.as_secs()),
                ));
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(BrowserEvent::ConnectionRestored { .. })) => return Ok(()),
                Ok(Ok(_)) => {}
                Ok(Err(_)) => {
                    return Err(ActionError::new(
                        ActionErrorKind::TargetClosed,
                        "事件总线关闭（目标已销毁）",
                    ))
                }
                Err(_) => {
                    return Err(ActionError::new(
                        ActionErrorKind::ConnectionLost,
                        format!("等待 ConnectionRestored 超时（{}s，恢复窗口 R-9）", timeout.as_secs()),
                    ))
                }
            }
        }
    }

    async fn go_back(&self) -> Result<(), ActionError> {
        self.send(CDP_PAGE_GO_BACK, json!({}), CMD_TIMEOUT)
            .await?;
        Ok(())
    }

    async fn target_alive(&self) -> Result<bool, ActionError> {
        // MVP：活动标签会话存在即存活（P1 细化目标探测）
        Ok(self.session.current_session().is_ok())
    }
}

/// 标签 → 会话解析器（引擎侧维度 15 标签管理注入；MVP 可用 session_for_active 兜底）。
pub type SessionResolver = Arc<dyn Fn(&TabId) -> Option<String> + Send + Sync>;

/// 快照存储真实实现（维度 11/13 门面包装；R-1 per-tab 签名）。
///
/// 会话解析经注入闭包 `session_for`（引擎侧维度 15 标签管理提供）；
/// 密码标记（is_password）由快照文档携带（M2：redact 同源判定），
/// 密码输入目标在工具面走 insertText/长度比对路径（§4.4）。
/// **内部持单一 `SnapshotManager` 实例**：`take_snapshot` 的提交与
/// `element_by_index` 的读取必须共享同一缓存——每次调用新建 manager 会
/// 让重快照后的索引解析永远落空（联调 E3 根因，mock 面未暴露）。
pub struct BrowserSnapshotStore {
    session: Arc<BrowserSession>,
    session_for: SessionResolver,
    manager: SnapshotManager,
}

impl BrowserSnapshotStore {
    pub fn new(
        session: Arc<BrowserSession>,
        session_for: SessionResolver,
        budgets: BudgetConfig,
    ) -> Self {
        let manager = session.snapshot_manager(budgets);
        BrowserSnapshotStore {
            session,
            session_for,
            manager,
        }
    }

    fn manager(&self) -> &SnapshotManager {
        &self.manager
    }
}

#[async_trait]
impl SnapshotStore for BrowserSnapshotStore {
    fn snapshot_version(&self, tab_id: &TabId) -> u64 {
        self.session.snapshot_version(tab_id)
    }

    fn validate_snapshot(&self, tab_id: &TabId, version: u64) -> Result<(), Stale> {
        self.session.validate_snapshot(tab_id, version)
    }

    async fn take_snapshot(&self, tab_id: &TabId) -> Result<u64, ActionError> {
        let session = (self.session_for)(tab_id).ok_or_else(|| {
            ActionError::new(
                ActionErrorKind::InvalidInput,
                format!("标签 {tab_id} 无可用会话（维度 15 标签管理接线）"),
            )
        })?;
        let doc = self
            .manager()
            .capture(tab_id, &session, true)
            .await
            .map_err(|e| match e {
                crate::snapshot::SnapshotError::Timeout(_) => ActionError::new(
                    ActionErrorKind::Timeout,
                    format!("重快照超时（12s 硬超时，T-1）：{e}"),
                ),
                crate::snapshot::SnapshotError::Stale(stale) => ActionError::new(
                    ActionErrorKind::VersionInvalid,
                    format!("重快照版本竞态（M-5）：{stale:?}"),
                ),
                other => ActionError::new(
                    ActionErrorKind::NodeStale,
                    format!("重快照失败：{other}"),
                ),
            })?;
        Ok(doc.meta.snapshot_version)
    }

    fn element_by_index(&self, tab_id: &TabId, version: u64, index: usize) -> Option<ElementMeta> {
        let doc = self.manager().get_cached(tab_id, version)?;
        let node_ref = doc.selector_map.get(&(index as u32))?;
        Some(ElementMeta {
            backend_node_id: node_ref.backend_node_id,
            // M2：快照文档敏感输入集合（redact 同源判定）
            is_password: doc.password_backend_ids.contains(&node_ref.backend_node_id),
        })
    }

    fn note_action_done(&self, tab_id: &TabId) {
        self.session.bump(tab_id, VersionReason::ActionDone);
    }
}

/// 会话解析辅助（引擎侧注入的简单实现样例：活动标签兜底）。
pub fn session_for_active(session: Arc<BrowserSession>) -> SessionResolver {
    Arc::new(move |_tab_id: &TabId| {
        session
            .current_session()
            .ok()
            .map(|r| r.session.clone())
    })
}

/// 会话解析辅助（P1 多标签）：按 tab_id（targetId 语义）经 `tab_session`
/// 路由到对应 CDP 会话——重快照/动作路由与工具面 `resolve_tab` 同一口径。
pub fn session_for_tab(session: Arc<BrowserSession>) -> SessionResolver {
    Arc::new(move |tab_id: &TabId| {
        session.tab_session(tab_id).map(|r| r.session)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::mock::{MockReply, MockServer};
    use crate::cdp::transport::CdpEndpoint;

    /// CdpError → ActionError 分类映射（14 §5.1 表逐行回归，R-9）。
    #[test]
    fn cdp_error_classification() {
        let cases = vec![
            (
                CdpError::ContextGone {
                    method: "m".to_string(),
                    message: "Target closed".to_string(),
                },
                ActionErrorKind::TargetClosed,
            ),
            (
                CdpError::ContextGone {
                    method: "m".to_string(),
                    message: "Execution context was destroyed".to_string(),
                },
                ActionErrorKind::ContextGone,
            ),
            (
                CdpError::ContextGone {
                    method: "m".to_string(),
                    message: "Cannot find context with specified id".to_string(),
                },
                ActionErrorKind::ContextGone,
            ),
            (
                CdpError::ContextGone {
                    method: "m".to_string(),
                    message: "Frame was detached".to_string(),
                },
                ActionErrorKind::ContextGone,
            ),
            (CdpError::ConnectionLost, ActionErrorKind::ConnectionLost),
            (
                CdpError::Timeout {
                    method: "m".to_string(),
                    elapsed: Duration::from_secs(1),
                },
                ActionErrorKind::Timeout,
            ),
            (
                CdpError::Cancelled {
                    reason: crate::cdp::error::CancelReason::Aborted,
                },
                ActionErrorKind::Aborted,
            ),
            (
                CdpError::ApprovalDenied {
                    reason: "no".to_string(),
                },
                ActionErrorKind::ApprovalDenied,
            ),
            (CdpError::NotReady("重启中".to_string()), ActionErrorKind::TargetRestarting),
            (CdpError::NoActiveTab, ActionErrorKind::TargetClosed),
            (
                CdpError::Server {
                    code: -32000,
                    message: "No node with given id found".to_string(),
                },
                ActionErrorKind::NodeStale,
            ),
            (
                CdpError::Server {
                    code: -32000,
                    message: "Could not compute box model".to_string(),
                },
                ActionErrorKind::NodeStale,
            ),
            (
                CdpError::BadParams {
                    method: "m".to_string(),
                    message: "bad".to_string(),
                },
                ActionErrorKind::InvalidInput,
            ),
            // M4：内部/序列化错误不得归 ContextGone（重试不会自愈，Fatal 不重试）
            (
                CdpError::Internal {
                    method: Some("m".to_string()),
                    message: "锁中毒恢复".to_string(),
                },
                ActionErrorKind::Unsupported,
            ),
            (
                CdpError::Serialize {
                    method: "m".to_string(),
                    message: "信封编码失败".to_string(),
                },
                ActionErrorKind::Unsupported,
            ),
            (
                CdpError::DomainUnavailable {
                    method: "m".to_string(),
                },
                ActionErrorKind::Unsupported,
            ),
        ];
        for (cdp, expected) in cases {
            let mapped = map_cdp_error(cdp, "test");
            assert_eq!(
                mapped.kind, expected,
                "分类不符：{}",
                mapped.message
            );
            assert!(mapped.cdp_raw.is_some(), "应携带 CDP 错误原文");
        }
    }

    /// 在途计数维护（wait_for NetworkIdle 输入面）。
    #[tokio::test]
    async fn network_counter_tracks_in_flight() {
        let bus = crate::cdp::bus::BusHandle::new(64, 4);
        let counter = NetworkCounter::new(bus.subscribe());
        bus.publish(BrowserEvent::NetworkRequest {
            request_id: "r1".to_string(),
            url: "https://e.com".to_string(),
            method: "GET".to_string(),
        });
        bus.publish(BrowserEvent::NetworkRequest {
            request_id: "r2".to_string(),
            url: "https://e.com".to_string(),
            method: "GET".to_string(),
        });
        // 订阅任务异步消费
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(counter.in_flight(), 2);
        bus.publish(BrowserEvent::NetworkDone {
            request_id: "r1".to_string(),
            ok: true,
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(counter.in_flight(), 1, "loadingFinished 应减一");
    }

    /// M3：Drop 后订阅任务终止——不再泄漏常驻任务（任务不持有 Arc<Self> 自保活）。
    #[tokio::test]
    async fn network_counter_task_terminates_on_drop() {
        let bus = crate::cdp::bus::BusHandle::new(64, 4);
        let counter = NetworkCounter::new(bus.subscribe());
        let abort = counter.handle.abort_handle();
        bus.publish(BrowserEvent::NetworkRequest {
            request_id: "r1".to_string(),
            url: "https://e.com".to_string(),
            method: "GET".to_string(),
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(counter.in_flight(), 1, "Drop 前计数正常");
        assert!(!abort.is_finished(), "Drop 前任务存活");
        drop(counter);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if abort.is_finished() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "Drop 后订阅任务必须终止"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// P1 多标签：`with_session` 绑定具体标签会话——全部 CDP 命令固定路由到
    /// 绑定会话，活动标签切换不影响绑定路由（per-tab 动作隔离）。
    #[tokio::test]
    async fn browser_page_ops_bound_session_routes_commands() {
        let mut mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        let session = Arc::new(
            crate::BrowserSession::connect(
                CdpEndpoint {
                    port: mock.addr.port(),
                    ws_path: "/devtools/browser/ops-bound".to_string(),
                },
                crate::cdp::transport::ExpectedBrowser::default(),
                Arc::new(AllowHooks),
            )
            .await
            .expect("会话建连失败"),
        );
        // 注入双标签附着（T1/S1、T2/S2），活动标签为最后附着者 T2
        for (target_id, sess) in [("T1", "S1"), ("T2", "S2")] {
            mock.send_event(
                "Target.attachedToTarget",
                json!({
                    "sessionId": sess,
                    "targetInfo": { "targetId": target_id, "type": "page", "title": "", "url": "about:blank" },
                    "waitingForDebugger": false,
                }),
                None,
            );
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while session.tab_session("T1").is_none() || session.tab_session("T2").is_none() {
            assert!(tokio::time::Instant::now() < deadline, "双标签路由未就绪");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        mock.set_auto_reply("Page.getNavigationHistory", MockReply::Ok(json!({
            "entries": [ { "id": 1, "url": "https://b.example/", "title": "B" } ],
            "currentIndex": 0
        })));
        // 绑定 T2 会话（S2）：命令必须路由到 S2
        let ops = BrowserPageOps::new(session.clone()).with_session("S2".to_string());
        let url = ops.current_url().await.expect("绑定会话命令应成功");
        assert_eq!(url, "https://b.example/");
        let cmd = mock.expect_command("Page.getNavigationHistory").await;
        assert_eq!(cmd["sessionId"], "S2", "绑定会话路由必须命中 S2");

        // 活动标签切到 T1：绑定路由不受影响（仍走 S2）
        session.activate_tab("T1").expect("切换活动标签");
        let url2 = ops.current_url().await.expect("绑定会话命令应成功");
        assert_eq!(url2, "https://b.example/");
        let cmd2 = mock.expect_command("Page.getNavigationHistory").await;
        assert_eq!(cmd2["sessionId"], "S2", "活动标签切换不得影响绑定路由");

        // 未绑定的 ops 走活动标签（向后兼容兜底）
        let fallback = BrowserPageOps::new(session.clone());
        let _ = fallback.current_url().await.expect("活动标签兜底命令应成功");
        let cmd3 = mock.expect_command("Page.getNavigationHistory").await;
        assert_eq!(cmd3["sessionId"], "S1", "未绑定 ops 走活动标签会话");
    }

    /// 会话恢复所需 mock 自动应答全表（与 lib.rs 会话面集成测试同源）。
    fn restore_reply_map() -> Vec<(&'static str, MockReply)> {
        vec![
            ("Browser.getVersion", MockReply::Ok(json!({
                "protocolVersion": "1.3",
                "product": "Chrome/151.0.7922.72",
                "revision": "@abc",
                "userAgent": "ua",
                "jsVersion": "13.1.71"
            }))),
            ("Target.setDiscoverTargets", MockReply::Ok(json!({}))),
            ("Target.getTargets", MockReply::Ok(json!({
                "targetInfos": [
                    { "targetId": "T1", "type": "page", "title": "A", "url": "https://a.example" }
                ]
            }))),
            ("Target.attachToTarget", MockReply::Ok(json!({ "sessionId": "S1" }))),
            ("Page.enable", MockReply::Ok(json!({}))),
            ("Page.setLifecycleEventsEnabled", MockReply::Ok(json!({}))),
            ("Runtime.enable", MockReply::Ok(json!({}))),
            ("DOM.enable", MockReply::Ok(json!({}))),
            ("Network.enable", MockReply::Ok(json!({}))),
            ("Runtime.runIfWaitingForDebugger", MockReply::Ok(json!({}))),
            ("Runtime.evaluate", MockReply::Ok(json!({ "result": { "value": 1 } }))),
            ("Page.setWindowOpenHandler", MockReply::Ok(json!({}))),
        ]
    }

    /// 采集四路应答（Chrome 151 实测形态 fixture：backendNodeId / Rare*Data 映射 /
    /// 无 nodeCount / documentURL 池下标 / layoutViewport 新字段；
    /// M2：INPUT 节点带 type=password 属性，用于密码标记断言）。
    fn collector_reply_map() -> Vec<(&'static str, MockReply)> {
        vec![
            ("DOMSnapshot.captureSnapshot", MockReply::Ok(json!({
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
            }))),
            ("DOM.getDocument", MockReply::Ok(json!({
                "root": { "nodeId": 1, "backendNodeId": 1, "nodeType": 9, "nodeName": "#document", "attributes": [], "children": [] }
            }))),
            ("Page.getLayoutMetrics", MockReply::Ok(json!({
                "layoutViewport": { "pageX": 0, "pageY": 0, "clientWidth": 1262, "clientHeight": 624 },
                "visualViewport": { "offsetX": 0, "offsetY": 0, "pageX": 0, "pageY": 0, "clientWidth": 1262, "clientHeight": 624, "scale": 1 },
                "contentSize": { "x": 0, "y": 0, "width": 1262, "height": 624 }
            }))),
            ("Accessibility.getFullAXTree", MockReply::Ok(json!({ "nodes": [] }))),
        ]
    }

    /// 放行策略钩子（会话面集成测试用）。
    struct AllowHooks;

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

    /// 回归（联调 E3 根因）：`take_snapshot` 提交的快照必须能被
    /// `element_by_index` 命中——存储持单一 SnapshotManager（每次调用新建
    /// manager 会让重快照后的索引解析永远落空，旧实现 mock 面未暴露）。
    #[tokio::test]
    async fn browser_snapshot_store_take_then_resolve() {
        let mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        for (method, reply) in collector_reply_map() {
            mock.set_auto_reply(method, reply);
        }

        let session = Arc::new(
            crate::BrowserSession::connect(
                CdpEndpoint {
                    port: mock.addr.port(),
                    ws_path: "/devtools/browser/store-test".to_string(),
                },
                crate::cdp::transport::ExpectedBrowser::default(),
                Arc::new(AllowHooks),
            )
            .await
            .expect("会话建连失败"),
        );
        // 注入活动标签（SessionAttached）
        mock.send_event(
            "Target.attachedToTarget",
            json!({
                "sessionId": "S1",
                "targetInfo": { "targetId": "T1", "type": "page", "title": "A", "url": "https://a.example" },
                "waitingForDebugger": false,
            }),
            None,
        );
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(cur) = session.current_session() {
                assert_eq!(cur.target_id, "T1");
                break;
            }
            assert!(tokio::time::Instant::now() < deadline, "活动标签未就绪");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let store = BrowserSnapshotStore::new(
            session.clone(),
            session_for_active(session.clone()),
            crate::snapshot::BudgetConfig::active(),
        );
        let version = store
            .take_snapshot(&"T1".to_string())
            .await
            .expect("重快照失败");
        let meta = store
            .element_by_index(&"T1".to_string(), version, 1)
            .expect("take_snapshot 提交的快照应可被索引解析（共享缓存回归）");
        assert_eq!(meta.backend_node_id, 1, "input(backend=1) 索引解析");
        // M2：type=password 输入必须携带 is_password 标记（redact 同源判定）
        assert!(meta.is_password, "type=password 输入必须标记为密码输入目标");
        let btn = store
            .element_by_index(&"T1".to_string(), version, 6)
            .expect("按钮索引解析");
        assert_eq!(btn.backend_node_id, 6);
        assert!(!btn.is_password, "普通按钮不得误标为密码输入");
    }
}

