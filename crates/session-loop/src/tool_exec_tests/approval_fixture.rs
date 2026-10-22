use super::super::*;
use agent_tools::context::ToolContext;
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// 记录审批请求顺序的测试门（T09.6：决策逐个按组序发起断言）
pub(super) struct RecordingApproval {
    pub(super) order: Arc<std::sync::Mutex<Vec<String>>>,
}
#[async_trait::async_trait]
impl ApprovalGate for RecordingApproval {
    async fn request_approval(
        &self,
        call_id: &str,
        _tool_name: &str,
        _args: &Value,
        _requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        self.order
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(call_id.to_string());
        ApprovalDecision::Approved
    }
}

/// 阻塞审批门：等待 release 通知后才返回决策（abort 中断审批测试用）
pub(super) struct BlockingApproval {
    pub(super) release: Arc<tokio::sync::Notify>,
    pub(super) order: Arc<std::sync::Mutex<Vec<String>>>,
}
#[async_trait::async_trait]
impl ApprovalGate for BlockingApproval {
    async fn request_approval(
        &self,
        call_id: &str,
        _tool_name: &str,
        _args: &Value,
        _requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        self.order
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(call_id.to_string());
        self.release.notified().await;
        ApprovalDecision::Approved
    }
}

/// 按 call_id 选择性拒绝的测试门（并行组内单项被拒场景）
pub(super) struct DenySomeApproval {
    pub(super) deny: String,
}
#[async_trait::async_trait]
impl ApprovalGate for DenySomeApproval {
    async fn request_approval(
        &self,
        call_id: &str,
        _tool_name: &str,
        _args: &Value,
        _requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        if call_id == self.deny {
            ApprovalDecision::Denied {
                reason: "no".into(),
            }
        } else {
            ApprovalDecision::Approved
        }
    }
}

/// 按序返回决策的测试门（T10：批级审批通过 → 重试审批拒绝场景）
pub(super) struct SequenceApproval {
    decisions: std::sync::Mutex<VecDeque<ApprovalDecision>>,
}

impl SequenceApproval {
    pub(super) fn new(decisions: Vec<ApprovalDecision>) -> Self {
        Self {
            decisions: std::sync::Mutex::new(VecDeque::from(decisions)),
        }
    }
}

#[async_trait::async_trait]
impl ApprovalGate for SequenceApproval {
    async fn request_approval(
        &self,
        _call_id: &str,
        _tool_name: &str,
        _args: &Value,
        _requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        self.decisions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pop_front()
            .unwrap_or(ApprovalDecision::Approved)
    }
}

/// 挂起审批门：永不返回决策（模拟审批卡片丢失 / 事件桥断连——
/// 只模拟「审批不响应」，超时/abort 收敛必须由内核 select!/timeout
/// 真实完成，PS-04 T4.2 防作弊条款 2）
pub(super) struct PendingApproval;

#[async_trait::async_trait]
impl ApprovalGate for PendingApproval {
    async fn request_approval(
        &self,
        _call_id: &str,
        _tool_name: &str,
        _args: &Value,
        _requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        std::future::pending().await
    }
}

/// 前 hang_after 次问询返回 Approved，之后挂起（requires_approval
/// 重试审批挂起测试用：批级审批先通过，重试审批不响应）
pub(super) struct HangAfterApprovals {
    hang_after: usize,
    consulted: AtomicUsize,
}

impl HangAfterApprovals {
    pub(super) fn new(hang_after: usize) -> Self {
        Self {
            hang_after,
            consulted: AtomicUsize::new(0),
        }
    }
}

#[async_trait::async_trait]
impl ApprovalGate for HangAfterApprovals {
    async fn request_approval(
        &self,
        _call_id: &str,
        _tool_name: &str,
        _args: &Value,
        _requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        let n = self.consulted.fetch_add(1, Ordering::SeqCst);
        if n < self.hang_after {
            ApprovalDecision::Approved
        } else {
            std::future::pending().await
        }
    }
}

/// 记录请求方身份的测试门（T-D-14：断言子代理请求透传 requester）
pub(super) struct RequesterRecordingApproval {
    pub(super) decision: ApprovalDecision,
    pub(super) received: Arc<std::sync::Mutex<Option<ApprovalRequester>>>,
}
#[async_trait::async_trait]
impl ApprovalGate for RequesterRecordingApproval {
    async fn request_approval(
        &self,
        _call_id: &str,
        _tool_name: &str,
        _args: &Value,
        requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        *self.received.lock().unwrap() = requester.cloned();
        self.decision.clone()
    }
}

/// 测试工具：恒返回 tool.requires_approval（T10 ApprovalRequired 分类）
pub(super) struct AlwaysRequiresApprovalTool;

#[async_trait::async_trait]
impl Tool for AlwaysRequiresApprovalTool {
    fn name(&self) -> &str {
        "always_approval"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "always_approval".into(),
            description: "always requires approval".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: true,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        Err(ToolError::new(
            "tool.requires_approval",
            "command requires approval",
        ))
    }
}

/// 测试工具：首调返回 tool.requires_approval，次调成功
/// （T10：用户同意后重试执行该工具调用）
#[derive(Clone)]
pub(super) struct ApprovalOnceTool {
    calls: Arc<AtomicUsize>,
}

impl ApprovalOnceTool {
    pub(super) fn new() -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }
    pub(super) fn call_count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl Tool for ApprovalOnceTool {
    fn name(&self) -> &str {
        "approval_once"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "approval_once".into(),
            description: "first call requires approval".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: true,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            Err(ToolError::new(
                "tool.requires_approval",
                "command requires approval",
            ))
        } else {
            Ok(args)
        }
    }
}

/// 测试工具：dangerous 标记且执行成功（T10 权限判定消费 dangerous）
pub(super) struct DangerousTool;

#[async_trait::async_trait]
impl Tool for DangerousTool {
    fn name(&self) -> &str {
        "dangerous_tool"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "dangerous_tool".into(),
            description: "dangerous but succeeds".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: true,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        Ok(args)
    }
}
