//! 动作执行器：构造/注入、统一入口（总预算）、重试主循环、单次尝试流水线、定位链与派发。

use super::executor_retry::RetryFlow;
use super::validate::{
    needs_coords, needs_scroll_point, require_node, require_point, validate_request,
};
use super::{
    ActionError, ActionErrorKind, ActionOptions, ActionOutcome, ActionRequest, ActionSuccess,
    Delay, DomainGate, Located, PageOps, Primitive, RetryState, RetryStrategy, SnapshotStore,
    TokioDelay,
};
use super::{evaluate, gate, keyboard, locate, pointer, retry, upload};
use crate::cdp::sender::CancellationToken;
use serde_json::Value;
use std::sync::Arc;

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
                    match self.handle_retry(&mut retry, &mut req, err).await {
                        RetryFlow::Continue => {}
                        RetryFlow::Done(result) => return result,
                    }
                }
            }
        }
    }

    /// 单次尝试（不做重试）：门禁 → 版本 → abort → 定位 → 派发 → 后置复核。
    async fn run_once(&self, req: &ActionRequest, attempt: u32) -> ActionOutcome {
        // ① 门禁（动作检查点：scheme → IP 字面量 → 解析级校验由维度 17 §4.3 全流程实现）
        let url = match self.ops.current_url().await {
            Ok(url) => url,
            Err(err) => return self.label(err.with_attempt(attempt)),
        };
        if let Err(denial) = self.gate.check(&url) {
            return ActionOutcome::Fatal(
                ActionError::new(ActionErrorKind::GateDenied, denial.reason).with_attempt(attempt),
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
                ActionError::new(ActionErrorKind::Aborted, "用户接管/令牌吊销")
                    .with_attempt(attempt),
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
        let payload = match self
            .dispatch(&req.primitive, located.as_ref(), is_password)
            .await
        {
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
            Ok(after) => {
                // URL 未变化 = 本动作未触发导航（after 与动作前一致，无门禁复核必要）
                tracing::trace!("动作后 URL 未变化（无导航）：{after}");
                None
            }
            Err(e) => {
                // 动作后 URL 读取失败不阻断成功（页面可能正导航中），但必须留痕
                tracing::debug!("动作后读取 URL 失败（不阻断动作成功）：{e}");
                None
            }
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
            Ok(Some(Located::Point { backend, point }))
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
            Ok(Some(Located::Point { backend, point }))
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
                        ));
                    }
                };
                upload::dispatch_upload(self, *node, backend, path.0.as_path()).await
            }
            Primitive::Evaluate(request) => evaluate::dispatch_evaluate(self, request).await,
        }
    }
}
