use super::super::*;
use agent_tools::context::ToolContext;
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use agent_tools::registry::ToolRegistry;
use agent_tools::streaming::{ContentBlock, ToolProgress, ToolStream, ToolStreamItem};
use conex_types::tool::{ToolBatchCall, ToolConcurrency};
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 测试工具：echo
pub(super) struct EchoTool;
#[async_trait::async_trait]
impl Tool for EchoTool {
    fn name(&self) -> &str {
        "echo"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "echo".into(),
            description: "echo input".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        Ok(args)
    }
}

/// 测试工具：与 EchoTool 同形，但标记 dangerous=true（Ask/Smart 下必审批）
pub(super) struct DangerousEchoTool;
#[async_trait::async_trait]
impl Tool for DangerousEchoTool {
    fn name(&self) -> &str {
        "echo"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "echo".into(),
            description: "dangerous echo input".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: true,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        Ok(args)
    }
}

/// 测试工具：慢工具（睡眠指定毫秒）
pub(super) struct SlowTool {
    pub(super) ms: u64,
}
#[async_trait::async_trait]
impl Tool for SlowTool {
    fn name(&self) -> &str {
        "slow"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "slow".into(),
            description: "slow tool".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        tokio::time::sleep(Duration::from_millis(self.ms)).await;
        Ok(serde_json::json!({"ok": true}))
    }
}

/// 测试工具：总是失败
pub(super) struct FailTool;
#[async_trait::async_trait]
impl Tool for FailTool {
    fn name(&self) -> &str {
        "fail"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "fail".into(),
            description: "always fails".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        Err(ToolError::execution_failed("fail", "boom"))
    }
}

/// 标记 fatalOnError 的失败工具（验证工具级致命语义）
pub(super) struct FailToolFatal;
#[async_trait::async_trait]
impl Tool for FailToolFatal {
    fn name(&self) -> &str {
        "failfatal"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "failfatal".into(),
            description: "always fails (fatal)".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: true,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        Err(ToolError::execution_failed("failfatal", "boom"))
    }
}

/// S1 流式测试工具：execute_stream 推送 Text/Custom/Content 进度 + 终值
///（验证 execute_stream_with_output_policy 进度回调与事件接线）
pub(super) struct StreamTool {
    pub(super) text_chunks: Vec<String>,
    pub(super) custom: Option<(String, Value)>,
    pub(super) with_content: bool,
}
#[async_trait::async_trait]
impl Tool for StreamTool {
    fn name(&self) -> &str {
        "stream"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "stream".into(),
            description: "streaming tool".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        // 流式路径不调用 execute（与 execute_stream_with_output_policy
        // 消费 execute_stream 一致）
        Err(ToolError::execution_failed("stream", "execute 不应被调用"))
    }
    async fn execute_stream(&self, _ctx: &ToolContext, _args: Value) -> ToolStream {
        let mut items = Vec::new();
        for t in &self.text_chunks {
            items.push(ToolStreamItem::Progress(ToolProgress::Text {
                text: t.clone(),
            }));
        }
        if let Some((subkind, payload)) = &self.custom {
            items.push(ToolStreamItem::Progress(ToolProgress::Custom {
                subkind: subkind.clone(),
                payload: payload.clone(),
            }));
        }
        if self.with_content {
            items.push(ToolStreamItem::Progress(ToolProgress::Content {
                blocks: vec![ContentBlock {
                    kind: "image".into(),
                    data: serde_json::json!({}),
                }],
            }));
        }
        items.push(ToolStreamItem::Terminal(Ok(
            serde_json::json!({ "final": true }),
        )));
        Box::pin(futures::stream::iter(items))
    }
}

/// S5 测钉工具（D-02 LK-01）：快照记录执行时收到的
/// ToolContext.tool_call_id（Option 原样记录，None 与空串可区分），
/// 供断言验证键源注入——工具侧读 ctx.tool_call_id 即「当前调用 id」
pub(super) struct RecordingCtxTool {
    seen_call_ids: Arc<Mutex<Vec<Option<String>>>>,
}
impl RecordingCtxTool {
    pub(super) fn new(seen: Arc<Mutex<Vec<Option<String>>>>) -> Self {
        Self {
            seen_call_ids: seen,
        }
    }
}
#[async_trait::async_trait]
impl Tool for RecordingCtxTool {
    fn name(&self) -> &str {
        "recording-ctx"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "recording-ctx".into(),
            description: "records ctx.tool_call_id".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        self.seen_call_ids
            .lock()
            .unwrap()
            .push(ctx.tool_call_id.clone());
        Ok(serde_json::json!({"ok": true}))
    }
}

/// 计数工具：每次执行自增并原样返回入参（验证中间件/钩子修改与阻止）
pub(super) struct CountingEchoTool {
    pub(super) calls: Arc<AtomicUsize>,
}
#[async_trait::async_trait]
impl Tool for CountingEchoTool {
    fn name(&self) -> &str {
        "countecho"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "countecho".into(),
            description: "count then echo".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(args)
    }
}

pub(super) fn registry_with(tools: Vec<Arc<dyn Tool>>) -> Arc<ToolRegistry> {
    let mut reg = ToolRegistry::new();
    for t in tools {
        reg.register(t).expect("register");
    }
    Arc::new(reg)
}

pub(super) fn call(id: &str, name: &str, concurrency: ToolConcurrency) -> ToolBatchCall {
    ToolBatchCall {
        id: id.into(),
        tool_name: name.into(),
        summary: format!("call {name}"),
        input: serde_json::json!({"v": id}),
        category: conex_types::tool::ToolCategory::Internal,
        concurrency,
    }
}

pub(super) fn exec_ctx() -> ToolExecCtx {
    ToolExecCtx {
        run_id: "run-1".into(),
        session_id: "sess-1".into(),
        ..Default::default()
    }
}

/// 测试审批门
pub(super) struct MockApproval {
    pub(super) decision: ApprovalDecision,
}
#[async_trait::async_trait]
impl ApprovalGate for MockApproval {
    async fn request_approval(
        &self,
        _call_id: &str,
        _tool_name: &str,
        _args: &Value,
        _requester: Option<&ApprovalRequester>,
        _reason: Option<&str>,
    ) -> ApprovalDecision {
        self.decision.clone()
    }
}

/// 事件序列契约断言（01 §五.6）：
/// - BatchStart 打头、BatchEnd 收尾；
/// - 每个取消项都有 ToolStart→ToolEnd 事件对（配对次数各一）；
/// - 全部结果携带真实 id / tool_name（无空 id 回退）。
pub(super) fn assert_event_contract(
    calls: &[ToolBatchCall],
    results: &[ClassifiedToolResult],
    events: &[ToolEvent],
) {
    assert!(
        matches!(events.first(), Some(ToolEvent::BatchStart { .. })),
        "事件序列应以 BatchStart 打头"
    );
    assert!(
        matches!(events.last(), Some(ToolEvent::BatchEnd { .. })),
        "事件序列应以 BatchEnd 收尾"
    );
    let starts = |id: &str| {
        events
            .iter()
            .filter(|e| matches!(e, ToolEvent::ToolStart { call_id, .. } if call_id == id))
            .count()
    };
    let ends = |id: &str| {
        events
            .iter()
            .filter(|e| matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == id))
            .count()
    };
    for (i, (call, r)) in calls.iter().zip(results).enumerate() {
        assert!(!r.id.is_empty(), "结果 {i} 的 id 不得为空");
        assert!(!r.tool_name.is_empty(), "结果 {i} 的 tool_name 不得为空");
        assert_eq!(r.id, call.id, "结果 {i} 的 id 应与入参一致");
        assert_eq!(
            r.tool_name, call.tool_name,
            "结果 {i} 的 tool_name 应与入参一致"
        );
        if r.error_kind == Some(ToolErrorKind::Cancelled) {
            assert_eq!(
                starts(&r.id),
                1,
                "取消项 {i}（{}）缺 tool-start 事件对",
                r.id
            );
            assert_eq!(ends(&r.id), 1, "取消项 {i}（{}）缺 tool-end 事件对", r.id);
        }
    }
}
