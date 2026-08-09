//! 动作执行与定位重试（维度 14）—— 原语层模块入口
//!
//! 职责边界（14 §1.1）：本模块只定义**执行原语层**；工具注册、审批接线、审计出站
//! 由维度 17（工具集与权限）负责，本模块在接口处标注对接点。
//!
//! ## 执行流水线（§2.2，T-8）
//! 顺序以本维度为准：**门禁 → 版本 → abort → 定位 → 派发 → 后置导航复核 → 审计**。
//! 令牌获取在工具层入口（协同层经 ToolContext，早于执行流水线，T-8），本流水线内
//! 的 abort 检查是**检查**而非获取；审计由维度 17 工具层 run_browser_action 第⑥步
//! 发射（M-4：本模块不自定义审计事件）。
//!
//! ## 重试状态机（§5，R-8/R-9/T-10）
//! VersionInvalid/NodeStale 等重试性错误计入 3 次总上限（MAX_ATTEMPTS，R-8）；
//! Aborted（用户接管吊销）与 ConnectionLost 的恢复后重试不计入额度；NodeStale
//! 3 次耗尽 → 「节点定位失败」升级提示（`ActionError::escalate`，T-10，升级接口点
//! 在维度 17 §2.2 审批链）。单动作总预算 `ACTION_TOTAL_TIMEOUT=120s`（T-9，含
//! 重试/等待/分块延迟，自 execute 起算，超时返回失败不再发起新一轮重试）。
//!
//! ## 安全面（R-5/R-6/R-7）
//! - 门禁：本模块只定义 `DomainGate` trait 引用（gate.rs），结构与匹配语义以维度
//!   17 §4 为唯一权威实现；未接线时返回「未接线」结构化错误（UnwiredGate）；
//! - wait_for 文本匹配：固定代码模板 + 参数 JSON 序列化注入（wait.rs，永不经字符串
//!   拼接进代码文本，R-5）；
//! - evaluate：仅接口引用维度 17 §3（evaluate.rs），MVP 返回「未接线」错误（R-6）。
//!
//! ## 测试面
//! CDP 交互经 `PageOps` trait 抽象（ops.rs），真实浏览器实现 `BrowserPageOps` 与
//! 确定性 mock（mocks.rs，cfg(test)）共用同一执行器；重试/超时/竞态全部 mock 测试，
//! 真实浏览器 e2e 留待联调（10 文档验收口径）。

pub mod evaluate;
pub mod gate;
pub mod keyboard;
pub mod locate;
pub mod ops;
pub mod pointer;
pub mod retry;
pub mod upload;
pub mod wait;

#[cfg(test)]
pub(crate) mod mocks;

pub use evaluate::EvaluateRequest;
pub use gate::{DomainGate, GateDenial};
pub use keyboard::KeySpec;
pub use locate::{Located, ResolvedPoint, ViewportSize};
pub use ops::{Delay, PageOps, TokioDelay};
pub use retry::{ActionOutcome, RetryDecision, RetryPolicy, RetryState, RetryStrategy};
pub use wait::{WaitCondition, WaitOptions};

use crate::cdp::sender::CancellationToken;
use crate::cdp::version::{Stale, TabId};
use async_trait::async_trait;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// 重试总上限（§5.3，R-8：VersionInvalid/NodeStale 等计入 3 次总上限）。
pub const MAX_ATTEMPTS: u32 = 3;
/// 单动作总预算（T-9：含全部重试、等待与分块延迟，自 execute 起算）。
pub const ACTION_TOTAL_TIMEOUT: Duration = Duration::from_secs(120);
/// type 分块大小（§4.1，50 字符/块）。
pub const TYPE_CHUNK_SIZE: usize = 50;
/// type 块间节流（§4.1，12ms）。
pub const TYPE_CHUNK_DELAY_MS: u64 = 12;
/// type 单次输入字符上限（参数校验护栏）。
pub const MAX_TYPE_CHARS: usize = 65_536;
/// NotInteractive 等待可见轮询上限（§5.1：首次 wait_for ≤2s）。
pub const NOT_INTERACTIVE_WAIT_MS: u32 = 2_000;
/// 导航竞态/目标关闭延迟（§5.4，300ms）。
pub const RETRY_DELAY_MS: u64 = 300;
/// ConnectionLost 恢复等待上限（R-9，维度 10 崩溃重启窗口）。
pub const CONNECTION_WAIT: Duration = Duration::from_secs(30);
/// 文件选择器事件等待上限（§9.1 4b，≤3s）。
pub const FILE_CHOOSER_WAIT: Duration = Duration::from_secs(3);
/// 滚动容器重取 box 循环上限（§3.2，最多 2 次后仍失败 → NotInteractive）。
pub const SCROLL_RETRIES: u32 = 2;

/// 动作错误分类（§2.1 全表；R-9 扩展 ConnectionLost/TargetRestarting）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionErrorKind {
    /// snapshotVersion 不匹配（重连/崩溃重启 VersionReset 后旧版本一律 Stale，U-2）
    VersionInvalid,
    /// backendNodeId 无法解析/box 获取失败
    NodeStale,
    /// "Target closed" 等：标签页/目标销毁
    TargetClosed,
    /// 执行上下文销毁/帧分离（导航竞态）
    ContextGone,
    /// CDP 连接断开（11 §3.2 CdpError::ConnectionLost，R-9）
    ConnectionLost,
    /// 浏览器进程启动中/崩溃重启中（维度 10 Launching/Crashed，R-9）
    TargetRestarting,
    /// 元素隐藏/禁用/被遮挡（box 校验不过）
    NotInteractive,
    /// 原语级超时（click 15s 等）/ 总预算超时
    Timeout,
    /// 域名门禁拒绝（含 IP 阻断）
    GateDenied,
    /// 审批未通过（由维度 17 直接拦截，原语层兜底）
    ApprovalDenied,
    /// 入参非法（索引越界、路径不存在等）
    InvalidInput,
    /// 目标不可支持（如跨域 iframe 元素未启用，二期启用）
    Unsupported,
    /// 用户接管/令牌吊销（不计入重试额度，R-8）
    Aborted,
}

/// 动作执行错误（§2.1）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionError {
    pub kind: ActionErrorKind,
    pub message: String,
    /// 第几次派发尝试（1 起）
    pub attempt: u8,
    /// 关联 CDP 错误原文（有则填，供审计/排查）
    pub cdp_raw: Option<String>,
    /// NodeStale 重试耗尽升级（T-10）：附「继续/中止」升级提示，接口点维度 17 §2.2
    pub escalate: bool,
}

impl ActionError {
    pub fn new(kind: ActionErrorKind, message: impl Into<String>) -> Self {
        ActionError {
            kind,
            message: message.into(),
            attempt: 1,
            cdp_raw: None,
            escalate: false,
        }
    }

    pub fn with_attempt(mut self, attempt: u32) -> Self {
        self.attempt = attempt.clamp(1, u8::MAX as u32) as u8;
        self
    }

    pub fn with_cdp_raw(mut self, raw: impl Into<String>) -> Self {
        self.cdp_raw = Some(raw.into());
        self
    }
}

/// 动作成功载荷（§2.1）。
#[derive(Debug, Clone, PartialEq)]
pub struct ActionSuccess {
    /// 动作后页面是否发生导航（由当前/动作后 URL 对比判定，§5.4）
    pub navigated: bool,
    /// 动作后最新 URL（导航时非空）
    pub url_after: Option<String>,
    /// 动作后是否应推进快照（引擎判定；导航/版本推进时 true）
    pub page_changed: bool,
    /// 附加数据（select 结果、上传文件数等）
    pub payload: Option<Value>,
}

/// 快照元素引用（工具面从快照带入：只给索引 + 索引解析出的 backendNodeId）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ElementRef {
    /// 快照中的 [N] 索引
    pub index: usize,
    /// 由快照索引解析获得（维度 13 提供，本模块执行时携带）
    pub backend_node_id: i64,
}

/// 快照元素元数据（14 §5.2 `element_by_index` 契约的消费面）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ElementMeta {
    pub backend_node_id: i64,
    /// 密码输入标记（维度 13 快照元数据；回读只比对长度不比对明文，§4.4）
    pub is_password: bool,
}

/// 快照存储契约（14 §5.2；R-1 per-tab 签名，底层复用维度 11/13 门面）。
///
/// 真实实现 `ops::BrowserSnapshotStore` 包装 `BrowserSession`/`SnapshotManager`；
/// 测试用确定性 mock（mocks.rs）。
#[async_trait]
pub trait SnapshotStore: Send + Sync {
    /// 标签页独立版本号（11 §5.4 VersionTracker）。
    fn snapshot_version(&self, tab_id: &TabId) -> u64;
    /// 校验动作携带版本（版本不匹配/epoch 变化/+1000 跳变一律 Stale，U-2）。
    fn validate_snapshot(&self, tab_id: &TabId, version: u64) -> Result<(), Stale>;
    /// 重快照（预算受限，维度 13 定参），返回新版本号。
    async fn take_snapshot(&self, tab_id: &TabId) -> Result<u64, ActionError>;
    /// 指定版本快照内按索引解析元素元数据（None = 索引不存在 → InvalidInput 致命）。
    fn element_by_index(&self, tab_id: &TabId, version: u64, index: usize) -> Option<ElementMeta>;
    /// 动作执行成功后推进版本（R-1：AI 动作即时 +1）。
    fn note_action_done(&self, tab_id: &TabId);
}

/// 鼠标按键（click 原语，§2.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

/// 滚动方向（scroll 原语，§2.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollDir {
    Up,
    Down,
    Left,
    Right,
}

/// 动作原语（§2.3 全表；evaluate 接口引用维度 17 §3）。
#[derive(Debug, Clone, PartialEq)]
pub enum Primitive {
    /// click（左/右/双击）：`count` 仅允许 1|2
    Click { button: MouseButton, count: u8 },
    /// hover
    Hover,
    /// drag（from = 请求元素，to = 目标元素）
    Drag { to: ElementRef },
    /// type（分块 + 节流 + 回读校验，§4）；submit_key 为键名（如 "Enter"）
    Type {
        text: String,
        submit_key: Option<String>,
    },
    /// key 组合键（"Control+A" 格式，§4.3）
    Key { keys: String },
    /// scroll（页面级：无元素；元素级：请求携带 element）
    Scroll { dir: ScrollDir, amount: i32 },
    /// focus（无坐标路径）
    Focus,
    /// select_option（设 value + 触发 change/input + 回读校验）
    SelectOption { value: String },
    /// upload（上传执行链，§9）
    Upload { path: PathBufLike },
    /// evaluate（受限求值引用维度 17 §3，MVP 未接线）
    Evaluate(EvaluateRequest),
}

/// 上传路径（PathBuf 包装，保持 Primitive 可 PartialEq）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathBufLike(pub std::path::PathBuf);

/// 动作请求（§2.2）。
#[derive(Debug, Clone, PartialEq)]
pub struct ActionRequest {
    /// R-1：per-tab 版本校验维度
    pub tab_id: TabId,
    /// 动作携带的快照版本（工具面从快照带入）
    pub snapshot_version: u64,
    /// 快照索引（元素类原语必填；key/页面滚动不填）
    pub element: Option<ElementRef>,
    pub primitive: Primitive,
}

/// 执行器配置（超时/重试参数，全部可注入供测试）。
#[derive(Debug, Clone)]
pub struct ActionOptions {
    /// 重试总上限（计入额度，R-8）
    pub max_attempts: u32,
    /// 单动作总预算（T-9）
    pub total_timeout: Duration,
    /// type 分块大小（§4.1）
    pub type_chunk_size: usize,
    /// type 块间节流（§4.1）
    pub type_chunk_delay: Duration,
    /// NotInteractive 等待可见轮询上限（§5.1，≤2s）
    pub not_interactive_wait_ms: u32,
    /// 导航竞态/目标关闭延迟（§5.4，300ms）
    pub retry_delay: Duration,
    /// ConnectionLost 恢复等待上限（R-9）
    pub connection_wait: Duration,
    /// 文件选择器事件等待上限（§9.1 4b，≤3s）
    pub file_chooser_wait: Duration,
    /// 滚动容器重取 box 循环上限（§3.2，最多 2 次）
    pub scroll_retries: u32,
}

impl Default for ActionOptions {
    fn default() -> Self {
        ActionOptions {
            max_attempts: MAX_ATTEMPTS,
            total_timeout: ACTION_TOTAL_TIMEOUT,
            type_chunk_size: TYPE_CHUNK_SIZE,
            type_chunk_delay: Duration::from_millis(TYPE_CHUNK_DELAY_MS),
            not_interactive_wait_ms: NOT_INTERACTIVE_WAIT_MS,
            retry_delay: Duration::from_millis(RETRY_DELAY_MS),
            connection_wait: CONNECTION_WAIT,
            file_chooser_wait: FILE_CHOOSER_WAIT,
            scroll_retries: SCROLL_RETRIES,
        }
    }
}

/// 动作执行器（§2.2 统一入口；所有原语的公共前/后置）。
pub struct ActionExecutor {
    /// CDP 交互层（trait 抽象：真实实现 BrowserPageOps / 测试 mock）
    pub(crate) ops: Arc<dyn PageOps>,
    /// 快照存储（版本校验 + 重快照 + 索引解析）
    pub(crate) snapshot: Arc<dyn SnapshotStore>,
    /// 域名门禁（维度 17 §4 唯一实现；未接线 = UnwiredGate）
    pub(crate) gate: Arc<dyn DomainGate>,
    /// 软互斥/接管信号（维度 15；检查而非获取，T-8）
    pub(crate) abort: CancellationToken,
    pub(crate) opts: ActionOptions,
    /// 延迟注入（测试用记录型；真实为 tokio sleep）
    pub(crate) delay: Arc<dyn Delay>,
}

impl ActionExecutor {
    /// 新建执行器（默认门禁为「未接线」——引擎侧须注入维度 17 §4 的 DomainGate 实现）。
    pub fn new(
        ops: Arc<dyn PageOps>,
        snapshot: Arc<dyn SnapshotStore>,
        abort: CancellationToken,
    ) -> Self {
        ActionExecutor {
            ops,
            snapshot,
            gate: Arc::new(gate::UnwiredGate),
            abort,
            opts: ActionOptions::default(),
            delay: Arc::new(TokioDelay),
        }
    }

    /// 注入门禁实现（维度 17 §4；不注入则动作返回「未接线」错误）。
    pub fn with_gate(mut self, gate: Arc<dyn DomainGate>) -> Self {
        self.gate = gate;
        self
    }

    pub fn with_options(mut self, opts: ActionOptions) -> Self {
        self.opts = opts;
        self
    }

    pub fn with_delay(mut self, delay: Arc<dyn Delay>) -> Self {
        self.delay = delay;
        self
    }

    // —— 原语层统一入口（§2.2 流水线 + §5 重试状态机）——

    /// 统一入口：门禁 → 版本 → abort → 定位 → 派发 → 后置导航复核。
    /// 全程受 `ACTION_TOTAL_TIMEOUT` 总预算约束（T-9）；审计由维度 17 工具层发射（M-4）。
    pub async fn execute(&self, req: ActionRequest) -> Result<ActionSuccess, ActionError> {
        let outcome = tokio::time::timeout(self.opts.total_timeout, self.execute_inner(req)).await;
        match outcome {
            Ok(result) => result,
            Err(_) => Err(ActionError::new(
                ActionErrorKind::Timeout,
                format!(
                    "单动作总预算超时（{}s，T-9：含重试/等待/分块延迟）",
                    self.opts.total_timeout.as_secs()
                ),
            )),
        }
    }

    /// 重试状态机主循环（§5.3：attempt 1..=MAX_ATTEMPTS，额度内重快照 → 重定位 → 重派发）。
    async fn execute_inner(&self, mut req: ActionRequest) -> Result<ActionSuccess, ActionError> {
        validate_request(&req)?;
        let mut retry = RetryState::new(self.opts.max_attempts);
        loop {
            let attempt = retry.next_attempt();
            let outcome = self.run_once(&req, attempt).await;
            match outcome {
                ActionOutcome::Success(success) => {
                    // R-1：AI 动作执行成功 → 即时 +1（维度 11 推进规则）
                    self.snapshot.note_action_done(&req.tab_id);
                    return Ok(success);
                }
                ActionOutcome::Retryable(err) | ActionOutcome::Fatal(err) => {
                    match self
                        .handle_retry(&mut retry, &mut req, err)
                        .await
                    {
                        RetryFlow::Continue => {}
                        RetryFlow::Done(result) => return result,
                    }
                }
            }
        }
    }

    /// 单次尝试（不做重试）：门禁 → 版本 → abort → 定位 → 派发 → 后置复核。
    async fn run_once(
        &self,
        req: &ActionRequest,
        attempt: u32,
    ) -> ActionOutcome {
        // ① 门禁（动作检查点：scheme → IP 字面量 → 解析级校验由维度 17 §4.3 全流程实现）
        let url = match self.ops.current_url().await {
            Ok(url) => url,
            Err(err) => return self.label(err.with_attempt(attempt)),
        };
        if let Err(denial) = self.gate.check(&url) {
            return ActionOutcome::Fatal(
                ActionError::new(ActionErrorKind::GateDenied, denial.reason)
                    .with_attempt(attempt),
            );
        }
        // ② 版本校验（R-1 契约；VersionReset 后旧版本一律 Stale，U-2）
        if let Err(_stale) = self
            .snapshot
            .validate_snapshot(&req.tab_id, req.snapshot_version)
        {
            return ActionOutcome::Retryable(
                ActionError::new(
                    ActionErrorKind::VersionInvalid,
                    "快照版本已过期（版本推进或 VersionReset 后作废）",
                )
                .with_attempt(attempt),
            );
        }
        // ③ abort 检查（用户接管/令牌吊销；检查而非获取，T-8）
        if self.abort.is_cancelled() {
            return ActionOutcome::Fatal(
                ActionError::new(ActionErrorKind::Aborted, "用户接管/令牌吊销").with_attempt(attempt),
            );
        }
        // ④ 定位（快照索引 → backendNodeId → 前端树/坐标，§3）
        let element = req.element.map(|el| el.backend_node_id);
        let is_password = req
            .element
            .and_then(|el| {
                self.snapshot
                    .element_by_index(&req.tab_id, req.snapshot_version, el.index)
            })
            .map(|m| m.is_password)
            .unwrap_or(false);
        let located = match self.locate(&req.primitive, element).await {
            Ok(located) => located,
            Err(err) => return self.label(err.with_attempt(attempt)),
        };
        // ⑤ 派发（CDP 命令序列，表 2-1）
        let payload = match self.dispatch(&req.primitive, located.as_ref(), is_password).await {
            Ok(payload) => payload,
            Err(err) => return self.label(err.with_attempt(attempt)),
        };
        // ⑥ 后置导航复核 + 动作后 URL 门禁复核（§5.4 / §7.1 ③）
        let navigated = match self.ops.current_url().await {
            Ok(after) if after != url => {
                if let Err(denial) = self.gate.check(&after) {
                    // 门禁外导航：回退（仅当可用）并返回 GateDenied（附「已回退」说明）
                    let back_ok = self.ops.go_back().await.is_ok();
                    let mut message = denial.reason;
                    message.push_str(if back_ok {
                        "（已回退到上一页面）"
                    } else {
                        "（回退失败：上一页面不可达）"
                    });
                    return ActionOutcome::Fatal(
                        ActionError::new(ActionErrorKind::GateDenied, message)
                            .with_attempt(attempt),
                    );
                }
                Some(after)
            }
            Ok(_) => None,
            Err(_) => None, // 动作后 URL 读取失败不阻断成功（页面可能正导航中）
        };
        let version_changed = self.snapshot.snapshot_version(&req.tab_id) != req.snapshot_version;
        let was_navigated = navigated.is_some();
        ActionOutcome::Success(ActionSuccess {
            navigated: was_navigated,
            url_after: navigated,
            page_changed: was_navigated || version_changed,
            payload,
        })
    }

    /// 错误标注：按重试策略把错误归入 Retryable/Fatal 三分类之一（§2.1，供状态机决策）。
    fn label(&self, err: ActionError) -> ActionOutcome {
        match retry::policy_for(err.kind).strategy {
            RetryStrategy::Fatal | RetryStrategy::Abort => ActionOutcome::Fatal(err),
            _ => ActionOutcome::Retryable(err),
        }
    }

    /// 定位链（§3.1）：无坐标路径直注 / 坐标路径 getBoxModel。
    async fn locate(
        &self,
        primitive: &Primitive,
        element: Option<i64>,
    ) -> Result<Option<Located>, ActionError> {
        let Some(backend) = element else {
            return Ok(None);
        };
        if needs_coords(primitive) {
            let viewport = self.ops.viewport().await?;
            let point = locate::resolve_click_point(
                self.ops.as_ref(),
                backend,
                &viewport,
                self.opts.scroll_retries,
            )
            .await?;
            Ok(Some(Located::Point {
                backend,
                point,
            }))
        } else if needs_scroll_point(primitive) {
            // 元素级滚动：scrollIntoViewIfNeeded → 取 box → 容器内偏移量滚轮（§3.2）
            let viewport = self.ops.viewport().await?;
            let point = locate::resolve_scroll_point(
                self.ops.as_ref(),
                backend,
                &viewport,
                self.opts.scroll_retries,
            )
            .await?;
            Ok(Some(Located::Point {
                backend,
                point,
            }))
        } else {
            let node_id = locate::resolve_node_id(self.ops.as_ref(), backend).await?;
            Ok(Some(Located::Node { backend, node_id }))
        }
    }

    /// 派发（表 2-1 命令序列）。
    async fn dispatch(
        &self,
        primitive: &Primitive,
        located: Option<&Located>,
        is_password: bool,
    ) -> Result<Option<Value>, ActionError> {
        match primitive {
            Primitive::Click { button, count } => {
                let point = require_point(located)?;
                pointer::dispatch_mouse_click(self, point, *button, *count).await?;
                Ok(None)
            }
            Primitive::Hover => {
                let point = require_point(located)?;
                pointer::dispatch_hover(self, point).await?;
                Ok(None)
            }
            Primitive::Drag { to } => {
                let point = require_point(located)?;
                let viewport = self.ops.viewport().await?;
                let to_point = locate::resolve_click_point(
                    self.ops.as_ref(),
                    to.backend_node_id,
                    &viewport,
                    self.opts.scroll_retries,
                )
                .await?;
                pointer::dispatch_drag(self, point, &to_point).await?;
                Ok(None)
            }
            Primitive::Scroll { dir, amount } => {
                pointer::dispatch_scroll(self, located, *dir, *amount).await?;
                Ok(None)
            }
            Primitive::Type { text, submit_key } => {
                let node = require_node(located)?;
                keyboard::dispatch_type(self, *node, text, submit_key.as_deref(), is_password)
                    .await?;
                Ok(None)
            }
            Primitive::Key { keys } => {
                keyboard::dispatch_key(self, keys).await?;
                Ok(None)
            }
            Primitive::Focus => {
                let node = require_node(located)?;
                keyboard::dispatch_focus(self, *node).await?;
                Ok(None)
            }
            Primitive::SelectOption { value } => {
                let node = require_node(located)?;
                keyboard::dispatch_select_option(self, *node, value).await
            }
            Primitive::Upload { path } => {
                let node = require_node(located)?;
                let backend = match located {
                    Some(Located::Node { backend, .. }) => *backend,
                    _ => {
                        return Err(ActionError::new(
                            ActionErrorKind::InvalidInput,
                            "upload 需要无坐标定位（元素未解析出 backendNodeId）",
                        ))
                    }
                };
                upload::dispatch_upload(self, *node, backend, path.0.as_path()).await
            }
            Primitive::Evaluate(request) => evaluate::dispatch_evaluate(self, request).await,
        }
    }

    /// 重试决策执行（§5.3 状态机：错误 → 策略 → 具体动作）。
    async fn handle_retry(
        &self,
        retry: &mut RetryState,
        req: &mut ActionRequest,
        first_err: ActionError,
    ) -> RetryFlow {
        let mut err = first_err;
        loop {
            if self.abort.is_cancelled() {
                return RetryFlow::Done(Err(ActionError::new(
                    ActionErrorKind::Aborted,
                    "用户接管/令牌吊销（重试期间）",
                )));
            }
            match retry.decide(&err) {
                RetryDecision::Stop(outcome) => return RetryFlow::Done(Err(outcome)),
                RetryDecision::Continue => return RetryFlow::Continue,
                RetryDecision::DelayThenRetry => {
                    // ContextGone：延迟 300ms → 版本校验（§5.4）
                    self.delay.sleep(self.opts.retry_delay).await;
                    if self
                        .snapshot
                        .validate_snapshot(&req.tab_id, req.snapshot_version)
                        .is_err()
                    {
                        // 版本已推进 → 按 VersionInvalid 重快照
                        err = ActionError::new(
                            ActionErrorKind::VersionInvalid,
                            "延迟后版本已推进（导航竞态）",
                        );
                        continue;
                    }
                    return RetryFlow::Continue;
                }
                RetryDecision::DelayThenRetake => {
                    // TargetClosed：延迟 300ms → 目标存活校验（§5.1）
                    self.delay.sleep(self.opts.retry_delay).await;
                    let alive = match self.ops.target_alive().await {
                        Ok(alive) => alive,
                        Err(e) => {
                            err = e;
                            continue;
                        }
                    };
                    if !alive {
                        return RetryFlow::Done(Err(ActionError::new(
                            ActionErrorKind::TargetClosed,
                            "目标（标签页）已销毁，不再自动重试",
                        )));
                    }
                    match self.retake(req).await {
                        Ok(flow) => return flow,
                        Err(take_err) => {
                            err = take_err;
                            continue;
                        }
                    }
                }
                RetryDecision::Retake => match self.retake(req).await {
                    Ok(flow) => return flow,
                    Err(take_err) => {
                        err = take_err;
                        continue;
                    }
                },
                RetryDecision::WaitVisible => {
                    // NotInteractive 首轮：wait_for 可见（≤2s）→ 重试（§5.1）
                    let Some(index) = req.element.map(|el| el.index) else {
                        return RetryFlow::Continue;
                    };
                    let wait = self
                        .wait_for(
                            WaitCondition::Element { index },
                            WaitOptions::for_condition(&WaitCondition::Element { index }, req.tab_id.clone())
                                .with_timeout_ms(self.opts.not_interactive_wait_ms),
                        )
                        .await;
                    match wait {
                        Ok(_) => return RetryFlow::Continue,
                        Err(wait_err) => {
                            // 等待可见超时仍归类 NotInteractive（元素持续不可见，§5.1）
                            err = ActionError::new(
                                ActionErrorKind::NotInteractive,
                                format!("元素等待可见超时：{}", wait_err.message),
                            );
                            continue;
                        }
                    }
                }
                RetryDecision::WaitThenRetry => {
                    // Timeout 首轮：等待元素可见/网络空闲 → 重试 1 次（§5.1）
                    let ready = match req.element {
                        Some(el) => self
                            .wait_for(
                                WaitCondition::Element { index: el.index },
                                WaitOptions::for_condition(
                                    &WaitCondition::Element { index: el.index },
                                    req.tab_id.clone(),
                                )
                                .with_timeout_ms(self.opts.not_interactive_wait_ms),
                            )
                            .await
                            .is_ok(),
                        None => self
                            .wait_for(
                                WaitCondition::NetworkIdle { quiet_ms: 500 },
                                WaitOptions::for_condition(
                                    &WaitCondition::NetworkIdle { quiet_ms: 500 },
                                    req.tab_id.clone(),
                                ),
                            )
                            .await
                            .is_ok(),
                    };
                    if !ready {
                        err = ActionError::new(ActionErrorKind::Timeout, "等待就绪后仍超时");
                        continue;
                    }
                    return RetryFlow::Continue;
                }
                RetryDecision::AwaitConnection => {
                    // ConnectionLost：等待 ConnectionRestored → 重试 ≤1 次（R-9，不计数）
                    match self
                        .ops
                        .await_connection_restored(self.opts.connection_wait)
                        .await
                    {
                        Ok(()) => return RetryFlow::Continue,
                        Err(restore_err) => {
                            err = restore_err;
                            continue;
                        }
                    }
                }
            }
        }
    }

    /// 重快照 → 按索引重定位（§5.3；索引在新快照中不存在 → InvalidInput 致命，E2E-10）。
    /// 重快照失败 → Err（原错误原样返回，§5.3），由 handle_retry 决策循环接管。
    async fn retake(&self, req: &mut ActionRequest) -> Result<RetryFlow, ActionError> {
        let version = self.snapshot.take_snapshot(&req.tab_id).await?;
        req.snapshot_version = version;
        match req.element.map(|el| el.index) {
            Some(index) => match self
                .snapshot
                .element_by_index(&req.tab_id, version, index)
            {
                Some(meta) => {
                    req.element = Some(ElementRef {
                        index,
                        backend_node_id: meta.backend_node_id,
                    });
                    Ok(RetryFlow::Continue)
                }
                None => Ok(RetryFlow::Done(Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    format!(
                        "索引 [{index}] 在新快照（v{version}）中不存在（元素已消失，E2E-10）"
                    ),
                )))),
            },
            None => Ok(RetryFlow::Continue),
        }
    }

    // —— 原语便捷入口（§2.3 签名；内部组装 ActionRequest 走统一流水线）——

    pub async fn click(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        el: ElementRef,
        button: MouseButton,
        count: u8,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: Some(el),
            primitive: Primitive::Click { button, count },
        })
        .await
    }

    pub async fn hover(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        el: ElementRef,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: Some(el),
            primitive: Primitive::Hover,
        })
        .await
    }

    pub async fn drag(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        from: ElementRef,
        to: ElementRef,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: Some(from),
            primitive: Primitive::Drag { to },
        })
        .await
    }

    pub async fn type_text(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        el: ElementRef,
        text: &str,
        submit_key: Option<&str>,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: Some(el),
            primitive: Primitive::Type {
                text: text.to_string(),
                submit_key: submit_key.map(str::to_string),
            },
        })
        .await
    }

    pub async fn key(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        keys: &str,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: None,
            primitive: Primitive::Key {
                keys: keys.to_string(),
            },
        })
        .await
    }

    pub async fn scroll(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        dir: ScrollDir,
        amount: i32,
        el: Option<ElementRef>,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: el,
            primitive: Primitive::Scroll { dir, amount },
        })
        .await
    }

    pub async fn focus(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        el: ElementRef,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: Some(el),
            primitive: Primitive::Focus,
        })
        .await
    }

    pub async fn select_option(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        el: ElementRef,
        value: &str,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: Some(el),
            primitive: Primitive::SelectOption {
                value: value.to_string(),
            },
        })
        .await
    }

    pub async fn upload_file(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        el: ElementRef,
        path: &Path,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: Some(el),
            primitive: Primitive::Upload {
                path: PathBufLike(path.to_path_buf()),
            },
        })
        .await
    }

    pub async fn evaluate(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        request: EvaluateRequest,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: None,
            primitive: Primitive::Evaluate(request),
        })
        .await
    }

    /// wait_for 等待原语（§6：事件驱动 + 轮询兜底；条件面 R-5）。
    pub async fn wait_for(
        &self,
        cond: WaitCondition,
        opts: WaitOptions,
    ) -> Result<ActionSuccess, ActionError> {
        wait::wait_for(self, cond, opts).await
    }
}

/// 重试流控制（execute_inner ↔ handle_retry 内部协议）。
enum RetryFlow {
    /// 继续下一轮 run_once
    Continue,
    /// 终止并返回最终结果
    Done(Result<ActionSuccess, ActionError>),
}

/// 需要元素的原语（参数校验 + 定位前置）。
fn requires_element(primitive: &Primitive) -> bool {
    matches!(
        primitive,
        Primitive::Click { .. }
            | Primitive::Hover
            | Primitive::Drag { .. }
            | Primitive::Type { .. }
            | Primitive::Focus
            | Primitive::SelectOption { .. }
            | Primitive::Upload { .. }
    )
}

/// 坐标路径原语（§3.2：click/hover/drag 需要真实渲染位置）。
fn needs_coords(primitive: &Primitive) -> bool {
    matches!(
        primitive,
        Primitive::Click { .. } | Primitive::Hover | Primitive::Drag { .. }
    )
}

/// 元素级滚动（§3.2：scrollIntoViewIfNeeded → 取 box → 容器内滚轮）。
fn needs_scroll_point(primitive: &Primitive) -> bool {
    matches!(primitive, Primitive::Scroll { .. })
}

fn require_point(located: Option<&Located>) -> Result<&ResolvedPoint, ActionError> {
    match located {
        Some(Located::Point { point, .. }) => Ok(point),
        _ => Err(ActionError::new(
            ActionErrorKind::InvalidInput,
            "该原语需要坐标定位（元素不可见/未解析出注入点）",
        )),
    }
}

fn require_node(located: Option<&Located>) -> Result<&i64, ActionError> {
    match located {
        Some(Located::Node { node_id, .. }) => Ok(node_id),
        _ => Err(ActionError::new(
            ActionErrorKind::InvalidInput,
            "该原语需要无坐标定位（元素未解析出 nodeId）",
        )),
    }
}

/// 入参校验（非法参数一律 InvalidInput 致命，不重试；E2E 级穷举见各模块测试）。
fn validate_request(req: &ActionRequest) -> Result<(), ActionError> {
    if requires_element(&req.primitive) && req.element.is_none() {
        return Err(ActionError::new(
            ActionErrorKind::InvalidInput,
            "该原语必须携带元素索引",
        ));
    }
    if let Some(el) = req.element {
        if el.backend_node_id <= 0 {
            return Err(ActionError::new(
                ActionErrorKind::InvalidInput,
                "元素 backendNodeId 非法（非正数）",
            ));
        }
    }
    match &req.primitive {
        Primitive::Click { count, .. } => {
            if !matches!(count, 1 | 2) {
                return Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    format!("click count 仅允许 1|2，收到 {count}"),
                ));
            }
        }
        Primitive::Scroll { amount, .. } => {
            if *amount <= 0 {
                return Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    format!("scroll 距离必须为正数，收到 {amount}"),
                ));
            }
        }
        Primitive::Type { text, submit_key } => {
            if text.is_empty() && submit_key.is_none() {
                return Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    "type 文本为空且未指定提交键",
                ));
            }
            if text.chars().count() > MAX_TYPE_CHARS {
                let count = text.chars().count();
                return Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    format!("type 文本超长（{count} 字符 > {MAX_TYPE_CHARS} 上限）"),
                ));
            }
            if let Some(key) = submit_key {
                keyboard::parse_key_sequence(key).map_err(|_| {
                    ActionError::new(
                        ActionErrorKind::InvalidInput,
                        format!("非法提交键名：{key}"),
                    )
                })?;
            }
        }
        Primitive::Key { keys } => {
            keyboard::parse_key_sequence(keys).map_err(|_| {
                ActionError::new(ActionErrorKind::InvalidInput, format!("非法键名：{keys}"))
            })?;
        }
        Primitive::SelectOption { value } => {
            if value.is_empty() {
                return Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    "select_option 选项值不能为空",
                ));
            }
        }
        Primitive::Upload { path } => {
            upload::validate_path(path.0.as_path())?;
        }
        Primitive::Evaluate(request) => {
            if request.expression.is_empty() {
                return Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    "evaluate 表达式不能为空",
                ));
            }
            if request.timeout_ms > 2000 {
                return Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    format!(
                        "evaluate 求值硬限 2000ms（17 §3.2），收到 {}ms",
                        request.timeout_ms
                    ),
                ));
            }
        }
        Primitive::Hover | Primitive::Focus | Primitive::Drag { .. } => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action::mocks::*;

    fn exec_with(
        ops: MockOps,
        snapshot: MockSnapshotStore,
    ) -> (ActionExecutor, MockOps, MockSnapshotStore, CancellationToken) {
        let token = CancellationToken::new();
        let executor = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(snapshot.clone()),
            token.clone(),
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        (executor, ops, snapshot, token)
    }

    fn click_req(version: u64, backend: i64) -> ActionRequest {
        ActionRequest {
            tab_id: "t1".to_string(),
            snapshot_version: version,
            element: Some(ElementRef {
                index: 0,
                backend_node_id: backend,
            }),
            primitive: Primitive::Click {
                button: MouseButton::Left,
                count: 1,
            },
        }
    }

    /// 流水线顺序（T-8）：门禁 → 版本 → abort → 定位 → 派发；门禁拒绝 → 零派发。
    #[tokio::test]
    async fn pipeline_gate_blocks_dispatch() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().url = "https://denied.example".to_string();
        let gate = Arc::new(DenyGate::new(vec!["denied.example".to_string()]));
        let token = CancellationToken::new();
        let executor = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            token,
        )
        .with_gate(gate);
        let err = executor.execute(click_req(1, 11)).await.expect_err("门禁应拒绝");
        assert_eq!(err.kind, ActionErrorKind::GateDenied);
        assert!(ops.count(MockOp::CurrentUrl) >= 1, "门禁前应取当前 URL");
        assert_eq!(ops.count(MockOp::PushNodes), 0, "门禁拒绝不得派发定位");
        assert_eq!(ops.count(MockOp::MouseEvent), 0, "门禁拒绝不得派发坐标事件");
    }

    /// 门禁未接线：默认执行器返回「未接线」结构化错误。
    #[tokio::test]
    async fn gate_unwired_returns_error() {
        let ops = MockOps::new();
        let snapshot = MockSnapshotStore::with_elements(1, &[ElementMeta {
            backend_node_id: 11,
            is_password: false,
        }]);
        let token = CancellationToken::new();
        let executor = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(snapshot),
            token,
        );
        let err = executor.execute(click_req(1, 11)).await.expect_err("未接线应报错");
        assert_eq!(err.kind, ActionErrorKind::GateDenied);
        assert!(err.message.contains("未接线"));
    }

    /// 版本失效重试（E2E-9）：旧版本 → 重快照 → 重定位到新 backendNodeId → 动作成功。
    #[tokio::test]
    async fn version_invalid_retakes_and_succeeds() {
        let snapshot = MockSnapshotStore::new(1); // 兜底索引表注入在下方
        // 新快照 v2 上索引 0 存在（重定位到新 backendNodeId 21）
        snapshot
            .state
            .lock()
            .unwrap()
            .elements
            .insert(2, vec![ElementMeta { backend_node_id: 21, is_password: false }]);
        let (executor, ops, snapshot, _t) = exec_with(MockOps::new(), snapshot);
        let success = executor
            .execute(click_req(0, 11))
            .await
            .expect("版本失效应自动重快照重试成功");
        assert!(!success.navigated);
        assert_eq!(snapshot.take_count(), 1, "重快照恰好一次");
        // 重派发发生在新 backend 21 的坐标上：box(121) 中心 (250, 25)
        let moved = ops.calls_of(MockOp::MouseEvent);
        assert!(
            moved.iter().any(|c| c.detail.contains("mouseMoved") && c.detail.contains("x=250")),
            "应在新元素坐标派发：{:?}",
            moved
        );
        assert!(
            ops.calls_of(MockOp::PushNodes)
                .iter()
                .any(|c| c.detail.contains("21")),
            "应重定位到新 backendNodeId 21"
        );
    }

    /// 节点过期（E2E-10）：NodeStale → 重快照 → 索引不存在 → InvalidInput 致命。
    #[tokio::test]
    async fn node_stale_then_index_missing_is_fatal_invalid_input() {
        let ops = MockOps::new();
        // 元素被 JS 删除：backend 99 未登记（push 空 → NodeStale）；新快照中索引 0 不存在
        let snapshot = MockSnapshotStore::new(1);
        let (executor, ops, _snapshot, _t) = exec_with(ops.clone(), snapshot);
        let err = executor
            .execute(click_req(1, 99))
            .await
            .expect_err("应致命");
        assert_eq!(err.kind, ActionErrorKind::InvalidInput);
        assert!(err.message.contains("不存在"));
        assert_eq!(ops.count(MockOp::MouseEvent), 0, "索引不存在不得派发");
    }

    /// 3 次上限（E2E-18）：持续 NodeStale → escalate 升级提示（T-10）。
    #[tokio::test]
    async fn node_stale_exhaustion_escalates() {
        let (executor, ops, _snapshot, _t) = exec_with(
            MockOps::new(),
            MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }]),
        );
        // pushNodes 恒 NodeStale（元素反复重建）
        ops.state
            .lock()
            .unwrap()
            .persist_errors
            .insert(MockOp::PushNodes, ActionError::new(ActionErrorKind::NodeStale, "push 空"));
        let err = executor.execute(click_req(1, 11)).await.expect_err("应耗尽");
        assert_eq!(err.kind, ActionErrorKind::NodeStale);
        assert_eq!(err.attempt, 3, "attempt 应停在 3（计入上限，R-8）");
        assert!(err.escalate, "NodeStale 耗尽应升级（T-10）");
        assert!(err.message.contains("节点定位失败"));
        assert_eq!(ops.count(MockOp::PushNodes), 3, "3 次重试后不再自动重试");
    }

    /// Aborted 不计入额度（R-8）：重试中注入 abort → 中止于第 2 次尝试（额度未耗尽）。
    #[tokio::test]
    async fn aborted_does_not_count_quota() {
        let token = CancellationToken::new();
        let ops = MockOps::new();
        {
            let mut s = ops.state.lock().unwrap();
            s.fail_queue.push_back((
                MockOp::PushNodes,
                ActionError::new(ActionErrorKind::NodeStale, "首轮节点过期"),
            ));
            s.on_fail_cancel = Some(token.clone());
        }
        let executor = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            token.clone(),
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        let err = executor.execute(click_req(1, 11)).await.expect_err("应中止");
        assert_eq!(err.kind, ActionErrorKind::Aborted, "接管应立即中止");
        // 中止发生在重试决策入口（首轮 NodeStale 之后），未发起任何重试（不计入，R-8）
        assert_eq!(err.attempt, 1);
        assert_eq!(ops.count(MockOp::MouseEvent), 0, "中止后不得派发");
        assert_eq!(ops.count(MockOp::PushNodes), 1, "仅首轮定位发生过（重试轮被中止拦截）");
        // 额度未耗尽：新令牌 + 同一 mock（队列已清空）→ 完整动作应成功
        let executor2 = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            CancellationToken::new(),
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        let success = executor2.execute(click_req(1, 11)).await.expect("额度应完好");
        assert!(!success.navigated);
    }

    /// 120s 总预算（T-9）：慢速 mock（挂起派发）→ Timeout 失败（注入小预算）。
    #[tokio::test]
    async fn total_timeout_fires_on_hang() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().hang.insert(MockOp::MouseEvent);
        let snapshot = MockSnapshotStore::with_elements(1, &[ElementMeta {
            backend_node_id: 11,
            is_password: false,
        }]);
        let executor = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(snapshot),
            CancellationToken::new(),
        )
        .with_gate(Arc::new(AllowGate))
        .with_options(ActionOptions {
            total_timeout: Duration::from_millis(50),
            ..ActionOptions::default()
        });
        let err = executor.execute(click_req(1, 11)).await.expect_err("挂起应超时");
        assert_eq!(err.kind, ActionErrorKind::Timeout);
        assert!(err.message.contains("总预算"));
    }

    /// 后置导航复核（§7.1 ③）：动作后 URL 变化 → Success{navigated:true}。
    #[tokio::test]
    async fn post_check_navigation_success() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().url_after_mouse = Some("https://next.example".to_string());
        let (executor, _ops, _snap, _t) = exec_with(
            ops,
            MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }]),
        );
        let success = executor.execute(click_req(1, 11)).await.expect("点击应成功");
        assert!(success.navigated, "URL 变化应标记导航");
        assert_eq!(success.url_after.as_deref(), Some("https://next.example"));
    }

    /// 后置门禁复核（§7.1 ③）：导航到白名单外 → 回退 + GateDenied。
    #[tokio::test]
    async fn post_check_gate_denial_goes_back() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().url_after_mouse = Some("https://evil.example".to_string());
        let gate = Arc::new(DenyGate::new(vec!["evil.example".to_string()]));
        let token = CancellationToken::new();
        let executor = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            token,
        )
        .with_gate(gate);
        let err = executor.execute(click_req(1, 11)).await.expect_err("门禁复核应拦截");
        assert_eq!(err.kind, ActionErrorKind::GateDenied);
        assert!(err.message.contains("已回退"));
        assert_eq!(ops.count(MockOp::GoBack), 1, "应触发回退");
    }

    /// 入参校验穷举：非法坐标/负数/超长/空串/非法键名 → InvalidInput 且零 CDP 调用。
    #[tokio::test]
    async fn validate_request_exhaustive() {
        let cases: Vec<ActionRequest> = vec![
            // 元素类原语缺元素
            ActionRequest {
                tab_id: "t1".to_string(),
                snapshot_version: 1,
                element: None,
                primitive: Primitive::Click { button: MouseButton::Left, count: 1 },
            },
            // backendNodeId 非正数
            ActionRequest {
                tab_id: "t1".to_string(),
                snapshot_version: 1,
                element: Some(ElementRef { index: 0, backend_node_id: -1 }),
                primitive: Primitive::Hover,
            },
            // click count 非法（0 / 3）
            click_with_count(0),
            click_with_count(3),
            // scroll 负数 / 零
            ActionRequest {
                tab_id: "t1".to_string(),
                snapshot_version: 1,
                element: None,
                primitive: Primitive::Scroll { dir: ScrollDir::Down, amount: -100 },
            },
            ActionRequest {
                tab_id: "t1".to_string(),
                snapshot_version: 1,
                element: None,
                primitive: Primitive::Scroll { dir: ScrollDir::Down, amount: 0 },
            },
            // type 空串且无提交键 / 超长
            ActionRequest {
                tab_id: "t1".to_string(),
                snapshot_version: 1,
                element: Some(ElementRef { index: 0, backend_node_id: 11 }),
                primitive: Primitive::Type { text: String::new(), submit_key: None },
            },
            ActionRequest {
                tab_id: "t1".to_string(),
                snapshot_version: 1,
                element: Some(ElementRef { index: 0, backend_node_id: 11 }),
                primitive: Primitive::Type {
                    text: "x".repeat(MAX_TYPE_CHARS + 1),
                    submit_key: None,
                },
            },
            // 非法提交键名
            ActionRequest {
                tab_id: "t1".to_string(),
                snapshot_version: 1,
                element: Some(ElementRef { index: 0, backend_node_id: 11 }),
                primitive: Primitive::Type {
                    text: "a".to_string(),
                    submit_key: Some("BogusKey".to_string()),
                },
            },
            // 非法键名
            ActionRequest {
                tab_id: "t1".to_string(),
                snapshot_version: 1,
                element: None,
                primitive: Primitive::Key { keys: "Bogus+Key".to_string() },
            },
            // select 空值
            ActionRequest {
                tab_id: "t1".to_string(),
                snapshot_version: 1,
                element: Some(ElementRef { index: 0, backend_node_id: 11 }),
                primitive: Primitive::SelectOption { value: String::new() },
            },
            // evaluate 空表达式 / 超硬限
            ActionRequest {
                tab_id: "t1".to_string(),
                snapshot_version: 1,
                element: None,
                primitive: Primitive::Evaluate(EvaluateRequest {
                    expression: String::new(),
                    element: None,
                    timeout_ms: 1000,
                }),
            },
            ActionRequest {
                tab_id: "t1".to_string(),
                snapshot_version: 1,
                element: None,
                primitive: Primitive::Evaluate(EvaluateRequest {
                    expression: "1".to_string(),
                    element: None,
                    timeout_ms: 2001,
                }),
            },
        ];
        let (executor, ops, _snap, _t) = exec_with(
            MockOps::new(),
            MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }]),
        );
        for req in cases {
            let err = executor
                .execute(req)
                .await
                .expect_err("非法参数应被拒绝");
            assert_eq!(err.kind, ActionErrorKind::InvalidInput, "消息：{}", err.message);
        }
        // 非法参数全部在派发前拦截（零 CDP 调用）
        let s = ops.state.lock().unwrap();
        assert_eq!(s.calls.len(), 0, "非法参数不得产生任何 CDP 调用：{:?}", s.calls);
    }

    fn click_with_count(count: u8) -> ActionRequest {
        ActionRequest {
            tab_id: "t1".to_string(),
            snapshot_version: 1,
            element: Some(ElementRef { index: 0, backend_node_id: 11 }),
            primitive: Primitive::Click { button: MouseButton::Left, count },
        }
    }

    /// R-1：动作执行成功 → 版本即时 +1（note_action_done）。
    #[tokio::test]
    async fn action_success_bumps_version() {
        let snapshot = MockSnapshotStore::with_elements(1, &[ElementMeta {
            backend_node_id: 11,
            is_password: false,
        }]);
        let (executor, _ops, snapshot, _t) = exec_with(MockOps::new(), snapshot);
        executor.execute(click_req(1, 11)).await.expect("点击应成功");
        assert_eq!(
            snapshot.state.lock().unwrap().bumps,
            vec!["t1".to_string()],
            "成功动作即时 +1（R-1：AI 动作执行成功）"
        );
    }

    /// 导航竞态（§5.4）：ContextGone → 延迟 300ms → 版本未变 → 原节点重派发 → 成功。
    #[tokio::test]
    async fn context_gone_delays_then_retries() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().fail_queue.push_back((
            MockOp::MouseEvent,
            ActionError::new(ActionErrorKind::ContextGone, "Execution context was destroyed"),
        ));
        let delay = Arc::new(RecordingDelay::new());
        let executor = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            CancellationToken::new(),
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(delay.clone());
        let success = executor.execute(click_req(1, 11)).await.expect("竞态延迟后应成功");
        assert!(!success.navigated);
        assert_eq!(delay.durations(), vec![Duration::from_millis(RETRY_DELAY_MS)], "延迟 300ms 恰一次");
        assert_eq!(ops.count(MockOp::MouseEvent), 1 + 3, "首轮 moved 失败 + 重派发完整序列");
        // 重快照未发生（版本未变，原 backendNodeId 重派发）
        assert_eq!(ops.count(MockOp::PushNodes), 2, "两轮定位（同 backendNodeId）");
    }

    /// TargetClosed（§5.1）：延迟 → 目标存活 → 重快照重定位 → 成功。
    #[tokio::test]
    async fn target_closed_alive_retakes_and_succeeds() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().fail_queue.push_back((
            MockOp::MouseEvent,
            ActionError::new(ActionErrorKind::TargetClosed, "Target closed"),
        ));
        let executor = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            CancellationToken::new(),
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        let success = executor.execute(click_req(1, 11)).await.expect("目标存活应重试成功");
        assert!(!success.navigated);
        assert_eq!(ops.count(MockOp::TargetAlive), 1, "存活校验恰一次");
        assert_eq!(ops.count(MockOp::MouseEvent), 1 + 3, "首轮失败 + 重派发完整序列");
    }

    /// TargetClosed（§5.1）：延迟 → 目标已销毁 → 致命（不无限重试）。
    #[tokio::test]
    async fn target_closed_dead_is_fatal() {
        let ops = MockOps::new();
        {
            let mut s = ops.state.lock().unwrap();
            s.alive = false;
            s.persist_errors.insert(
                MockOp::MouseEvent,
                ActionError::new(ActionErrorKind::TargetClosed, "Target closed"),
            );
        }
        let executor = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            CancellationToken::new(),
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        let err = executor.execute(click_req(1, 11)).await.expect_err("目标销毁应致命");
        assert_eq!(err.kind, ActionErrorKind::TargetClosed);
        assert!(err.message.contains("已销毁"));
        assert_eq!(ops.count(MockOp::MouseEvent), 1, "仅首轮 moved（不做第二次点击）");
    }

    /// ConnectionLost（R-9）：等恢复事件 → 重试 ≤1 次（不消耗额度）→ 成功。
    #[tokio::test]
    async fn connection_lost_recovers_once() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().fail_queue.push_back((
            MockOp::MouseEvent,
            ActionError::new(ActionErrorKind::ConnectionLost, "CDP 连接断开"),
        ));
        let executor = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            CancellationToken::new(),
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        let success = executor.execute(click_req(1, 11)).await.expect("恢复后应重试成功");
        assert!(!success.navigated);
        assert_eq!(ops.count(MockOp::AwaitConnectionRestored), 1, "等待恢复事件恰一次");
        assert_eq!(ops.count(MockOp::MouseEvent), 1 + 3, "首轮失败 + 恢复后重派发");
    }

    /// ConnectionLost 恢复超时（R-9）：恢复窗口内无事件 → 致命。
    #[tokio::test]
    async fn connection_lost_restore_timeout_fatal() {
        let ops = MockOps::new();
        {
            let mut s = ops.state.lock().unwrap();
            s.restored = false;
            s.persist_errors.insert(
                MockOp::MouseEvent,
                ActionError::new(ActionErrorKind::ConnectionLost, "CDP 连接断开"),
            );
        }
        let executor = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            CancellationToken::new(),
        )
        .with_gate(Arc::new(AllowGate))
        .with_options(ActionOptions {
            connection_wait: Duration::from_millis(1),
            ..ActionOptions::default()
        })
        .with_delay(Arc::new(RecordingDelay::new()));
        let err = executor.execute(click_req(1, 11)).await.expect_err("恢复超时应致命");
        assert_eq!(err.kind, ActionErrorKind::ConnectionLost);
        assert_eq!(ops.count(MockOp::AwaitConnectionRestored), 1, "恢复后重试 ≤1 次");
    }
}
