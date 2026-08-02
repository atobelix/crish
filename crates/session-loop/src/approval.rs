//! 审批通道（R4 T10：ToolContext.ask 的真实审批接线）
//!
//! [ApprovalChannel] 实现 [agent_tools::context::AskChannel]：把工具内部的
//! 审批提问（shell 命令门禁 RequiresApproval 等）接到批执行器的
//! [ApprovalGate]——记录 approval-requested 事件（进批事件流，先发后等
//! 防死锁，01 §五.8），等待用户裁决（abort 触发即取消），按裁决返回
//! [agent_tools::context::AskDecision]。
//!
//! 归属：本通道是 session-loop 侧接线（gate 由批执行器注入），由
//! [crate::tool_exec::ToolExecutor] 组装 [agent_tools::context::ToolContext]
//! 时注入 ctx.ask（tool_exec.rs 的 ask: None 接线点）。

use agent_tools::context::{AbortToken, AskChannel, AskDecision};
use agent_tools::definition::ToolError;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use std::sync::Mutex;

use crate::safe_point::AbortSignal;
use crate::tool_events::{ApprovalDecision, ApprovalGate, ToolEvent};

/// abort 取消轮询间隔（std AbortToken 无异步等待原语，轮询查标志位）
const ABORT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

/// 审批通道（AskChannel 实现，R4 T10）
#[derive(Clone)]
pub struct ApprovalChannel {
    /// 审批门（广播 approval-requested + 等待裁决）
    gate: Arc<dyn ApprovalGate>,
    /// 本次工具调用标识（gate 待审批集合键）
    call_id: String,
    /// 批级中止信号（L3 强停即时取消审批等待）
    abort: Option<AbortSignal>,
    /// 会话级中止令牌（契约：审批等待期间支持 abort_token 取消）
    abort_token: AbortToken,
    /// 审批请求事件记录（执行完成后由执行器取走，并入批事件流）
    recorded: Arc<Mutex<Vec<ToolEvent>>>,
}

impl std::fmt::Debug for ApprovalChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApprovalChannel")
            .field("call_id", &self.call_id)
            .field("abort", &self.abort)
            .field("abort_token", &self.abort_token)
            .field(
                "recorded_len",
                &self.recorded.lock().map(|g| g.len()).unwrap_or(0),
            )
            .finish_non_exhaustive()
    }
}

impl ApprovalChannel {
    /// 新建审批通道
    pub fn new(
        gate: Arc<dyn ApprovalGate>,
        call_id: impl Into<String>,
        abort: Option<AbortSignal>,
        abort_token: AbortToken,
    ) -> Self {
        Self {
            gate,
            call_id: call_id.into(),
            abort,
            abort_token,
            recorded: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// 取走本次执行记录的审批事件（并入批事件流，保持
    /// tool-start → approval-requested → tool-end 顺序契约）
    pub fn take_recorded(&self) -> Vec<ToolEvent> {
        std::mem::take(&mut *self.recorded.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// 是否已中止（批级信号与会话级令牌任一触发）
    fn is_aborted(&self) -> bool {
        self.abort_token.is_aborted()
            || self.abort.as_ref().map(|s| s.is_aborted()).unwrap_or(false)
    }

    /// 等待中止：批级 AbortSignal 与 abort_token 任一触发即返回
    /// （std 令牌无异步等待原语，按固定间隔轮询标志位）
    async fn wait_aborted(&self) {
        loop {
            if self.is_aborted() {
                return;
            }
            tokio::time::sleep(ABORT_POLL_INTERVAL).await;
        }
    }
}

#[async_trait]
impl AskChannel for ApprovalChannel {
    async fn ask(
        &self,
        tool_name: &str,
        args: &Value,
    ) -> Result<AskDecision, ToolError> {
        // 1. 记录 approval-requested（先发后等防死锁，01 §五.8；gate 实现方
        //    负责实时广播，本记录进入批事件流供持久化翻译）
        self.recorded
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(ToolEvent::ApprovalRequested {
                call_id: self.call_id.clone(),
                tool_name: tool_name.to_string(),
                args: args.clone(),
            });

        // 2. 等待裁决；abort（批级信号 / abort_token）触发即取消等待，
        //    走取消收场（不伪造审批事件）
        let gate = Arc::clone(&self.gate);
        let call_id = self.call_id.clone();
        let tool_name = tool_name.to_string();
        let args = args.clone();
        let wait = gate.request_approval(&call_id, &tool_name, &args);
        let cancelled = self.wait_aborted();
        tokio::select! {
            biased;
            () = cancelled => Err(ToolError::new("tool.cancelled", "aborted")),
            decision = wait => {
                // 竞速兜底：等待期间 abort 与裁决同时就绪 → 取消优先
                //（L3 强停语义；std 令牌轮询窗口内触发也即刻生效）
                if self.is_aborted() {
                    return Err(ToolError::new("tool.cancelled", "aborted"));
                }
                match decision {
                    ApprovalDecision::Approved => Ok(AskDecision::Allowed),
                    ApprovalDecision::Denied { reason } => Ok(AskDecision::Denied { reason }),
                    ApprovalDecision::Expired => Err(ToolError::new(
                        "tool.approval_expired",
                        "approval expired",
                    )),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// 测试审批门：返回预设裁决并记录问询次数
    struct MockGate {
        decision: ApprovalDecision,
        consulted: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl ApprovalGate for MockGate {
        async fn request_approval(
            &self,
            _call_id: &str,
            _tool_name: &str,
            _args: &Value,
        ) -> ApprovalDecision {
            self.consulted.fetch_add(1, Ordering::SeqCst);
            self.decision.clone()
        }
    }

    /// 阻塞审批门：等待 release 通知（abort 取消等待测试用）
    struct BlockingGate {
        release: Arc<tokio::sync::Notify>,
        consulted: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl ApprovalGate for BlockingGate {
        async fn request_approval(
            &self,
            _call_id: &str,
            _tool_name: &str,
            _args: &Value,
        ) -> ApprovalDecision {
            self.consulted.fetch_add(1, Ordering::SeqCst);
            self.release.notified().await;
            ApprovalDecision::Approved
        }
    }

    fn channel(
        gate: Arc<dyn ApprovalGate>,
        abort: Option<AbortSignal>,
    ) -> (ApprovalChannel, AbortToken) {
        let token = AbortToken::new();
        (
            ApprovalChannel::new(gate, "c1", abort, token.clone()),
            token,
        )
    }

    #[tokio::test]
    async fn approved_maps_to_allowed_and_records_event() {
        let consulted = Arc::new(AtomicUsize::new(0));
        let gate: Arc<dyn ApprovalGate> = Arc::new(MockGate {
            decision: ApprovalDecision::Approved,
            consulted: Arc::clone(&consulted),
        });
        let (ch, _token) = channel(gate, None);
        let decision = ch
            .ask("shell_command", &serde_json::json!({ "command": "git push" }))
            .await
            .unwrap();
        assert_eq!(decision, AskDecision::Allowed);
        assert_eq!(consulted.load(Ordering::SeqCst), 1);
        // 审批事件已记录（call_id 与工具名齐全）
        let recorded = ch.take_recorded();
        assert_eq!(recorded.len(), 1);
        match &recorded[0] {
            ToolEvent::ApprovalRequested {
                call_id,
                tool_name,
                args,
            } => {
                assert_eq!(call_id, "c1");
                assert_eq!(tool_name, "shell_command");
                assert_eq!(args["command"], "git push");
            }
            other => panic!("应记录 ApprovalRequested，实际 {other:?}"),
        }
    }

    #[tokio::test]
    async fn denied_maps_to_denied_decision() {
        let gate: Arc<dyn ApprovalGate> = Arc::new(MockGate {
            decision: ApprovalDecision::Denied {
                reason: "no".into(),
            },
            consulted: Arc::new(AtomicUsize::new(0)),
        });
        let (ch, _token) = channel(gate, None);
        let decision = ch
            .ask("shell_command", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(
            decision,
            AskDecision::Denied {
                reason: "no".into()
            }
        );
    }

    #[tokio::test]
    async fn expired_maps_to_error() {
        let gate: Arc<dyn ApprovalGate> = Arc::new(MockGate {
            decision: ApprovalDecision::Expired,
            consulted: Arc::new(AtomicUsize::new(0)),
        });
        let (ch, _token) = channel(gate, None);
        let err = ch
            .ask("shell_command", &serde_json::json!({}))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.approval_expired");
    }

    /// abort_token 取消：等待裁决期间令牌触发 → 立即返回取消错误
    #[tokio::test]
    async fn abort_token_cancels_waiting_approval() {
        let release = Arc::new(tokio::sync::Notify::new());
        let gate: Arc<dyn ApprovalGate> = Arc::new(BlockingGate {
            release: Arc::clone(&release),
            consulted: Arc::new(AtomicUsize::new(0)),
        });
        let (ch, token) = channel(gate, None);
        let handle = tokio::spawn(async move {
            ch.ask("shell_command", &serde_json::json!({})).await
        });
        // 等待 gate 被问询（审批挂起中）后触发 abort_token
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        token.abort();
        release.notify_waiters();
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), handle)
            .await
            .expect("abort 取消应在时限内返回")
            .expect("ask 不应 panic");
        assert_eq!(result.unwrap_err().code(), "tool.cancelled");
    }

    /// 批级 AbortSignal 取消：信号触发 → 等待取消
    #[tokio::test]
    async fn abort_signal_cancels_waiting_approval() {
        let release = Arc::new(tokio::sync::Notify::new());
        let gate: Arc<dyn ApprovalGate> = Arc::new(BlockingGate {
            release: Arc::clone(&release),
            consulted: Arc::new(AtomicUsize::new(0)),
        });
        let signal = AbortSignal::new();
        let (ch, _token) = channel(gate, Some(signal.clone()));
        let handle = tokio::spawn(async move {
            ch.ask("shell_command", &serde_json::json!({})).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        signal.abort();
        release.notify_waiters();
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), handle)
            .await
            .expect("abort 取消应在时限内返回")
            .expect("ask 不应 panic");
        assert_eq!(result.unwrap_err().code(), "tool.cancelled");
    }
}
