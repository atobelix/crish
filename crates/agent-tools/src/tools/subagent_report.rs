//! 子代理 → 父 agent 的通信工具（P1）。
//!
//! - `report_progress`：过程信息（摘要通道，合并后批量投递）；
//! - `ask_parent`：需要父决策的问题（即时通道）；
//! - `request_capability`：只读/权限不足时向父申请能力（即时问题，可由父
//!   `grant_capability` 批准后继续）。
//!
//! 仅子代理工具集包含本组工具；主 agent 注册面剔除（自身不需要上报）。

use async_trait::async_trait;
use conex_agents::comm::AgentMessageKind;
use conex_types::error::codes;
use serde_json::Value;
use std::sync::Arc;

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};

/// 上报通道（引擎侧实现；None = 未接线 → common.unsupported）
#[async_trait]
pub trait SubagentReportChannel: Send + Sync + std::fmt::Debug {
    /// 发送一条消息（`child_session` 用于反查父路由；Progress 走摘要通道）
    async fn report(
        &self,
        child_session: &str,
        kind: AgentMessageKind,
        text: String,
        dedupe_key: Option<String>,
    ) -> Result<(), String>;

    /// 立即冲刷指定子代理的摘要缓冲（终态/显式 flush 用）
    async fn flush(&self, child_session: &str);
}

/// 子代理路由注册（引擎在 spawn/终态时维护；供 mailbox 反查父会话）
#[async_trait]
pub trait ChildAgentRegistrar: Send + Sync + std::fmt::Debug {
    /// 注册子代理会话 → 父会话/agent id
    fn register_child(&self, child_session: &str, parent_session: &str, agent_id: &str);
    /// 注销
    fn unregister_child(&self, child_session: &str);
    /// 终态冲刷摘要（默认 no-op）
    async fn flush_child(&self, _child_session: &str) {}
}

/// 工具名常量（子/主注册面过滤共用）
pub const REPORT_PROGRESS_TOOL_NAME: &str = "report_progress";
pub const ASK_PARENT_TOOL_NAME: &str = "ask_parent";
pub const REQUEST_CAPABILITY_TOOL_NAME: &str = "request_capability";

const REPORT_DESCRIPTION: &str =
    "向主 agent 汇报进展（非即时，摘要通道）：适合阶段性结果、重要发现、下一步计划。\
     多条进展会按会话策略合并后批量送达，避免频繁打扰。";

const ASK_DESCRIPTION: &str =
    "向主 agent 提问（即时通道）：遇到需要决策的歧义、风险或方案选择时使用，\
     父 agent 会在下一个安全点收到并回复。";

const REQUEST_CAPABILITY_DESCRIPTION: &str =
    "申请能力升级（即时通道）：当前只读/能力不足导致无法完成剩余任务时，\
     说明需要的能力与理由；主 agent 可用 grant_capability 批准。";

fn build_definition(name: &str, description: &str, properties: Value, required: &[&str]) -> ToolDefinition {
    ToolDefinition {
        name: name.to_string(),
        description: description.to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": properties,
            "required": required
        }),
        dangerous: false,
        fatal_on_error: false,
    }
}

/// report_progress 工具
pub(crate) struct ReportProgressTool {
    def: ToolDefinition,
    channel: Option<Arc<dyn SubagentReportChannel>>,
}

impl ReportProgressTool {
    pub(crate) fn with_channel(channel: Option<Arc<dyn SubagentReportChannel>>) -> Self {
        Self {
            def: build_definition(
                REPORT_PROGRESS_TOOL_NAME,
                REPORT_DESCRIPTION,
                serde_json::json!({
                    "text": { "type": "string", "description": "进展描述（简洁、可核查）" },
                    "dedupeKey": {
                        "type": "string",
                        "description": "可选去重键：同键在合并窗口内只保留最新一条"
                    }
                }),
                &["text"],
            ),
            channel,
        }
    }
}

/// ask_parent 工具
pub(crate) struct AskParentTool {
    def: ToolDefinition,
    channel: Option<Arc<dyn SubagentReportChannel>>,
}

impl AskParentTool {
    pub(crate) fn with_channel(channel: Option<Arc<dyn SubagentReportChannel>>) -> Self {
        Self {
            def: build_definition(
                ASK_PARENT_TOOL_NAME,
                ASK_DESCRIPTION,
                serde_json::json!({
                    "question": { "type": "string", "description": "需要父 agent 决策的问题" },
                    "context": {
                        "type": "string",
                        "description": "可选：已知信息/候选方案/影响范围"
                    }
                }),
                &["question"],
            ),
            channel,
        }
    }
}

/// request_capability 工具
pub(crate) struct RequestCapabilityTool {
    def: ToolDefinition,
    channel: Option<Arc<dyn SubagentReportChannel>>,
}

impl RequestCapabilityTool {
    pub(crate) fn with_channel(channel: Option<Arc<dyn SubagentReportChannel>>) -> Self {
        Self {
            def: build_definition(
                REQUEST_CAPABILITY_TOOL_NAME,
                REQUEST_CAPABILITY_DESCRIPTION,
                serde_json::json!({
                    "capability": {
                        "type": "string",
                        "enum": ["read-write", "execute", "all"],
                        "description": "申请的目标能力档"
                    },
                    "reason": {
                        "type": "string",
                        "description": "为什么当前能力不足（需要写哪个路径/执行什么命令/影响范围）"
                    }
                }),
                &["capability", "reason"],
            ),
            channel,
        }
    }
}

async fn send(
    channel: Option<&Arc<dyn SubagentReportChannel>>,
    ctx: &ToolContext,
    kind: AgentMessageKind,
    text: String,
    dedupe_key: Option<String>,
) -> Result<Value, ToolError> {
    let Some(channel) = channel else {
        return Err(ToolError::new(
            codes::COMMON_UNSUPPORTED,
            "子代理上报通道未接线（引擎集成后可用）",
        ));
    };
    if text.trim().is_empty() {
        return Err(ToolError::invalid_input("消息文本不能为空".to_string()));
    }
    channel
        .report(&ctx.session_id, kind, text, dedupe_key)
        .await
        .map_err(|message| ToolError::new(codes::TOOL_EXECUTION_FAILED, message))?;
    Ok(serde_json::json!({
        "delivered": true,
        "channel": if kind.is_instant() { "instant" } else { "digest" },
        "kind": format!("{kind:?}").to_lowercase(),
    }))
}

#[async_trait]
impl Tool for ReportProgressTool {
    fn name(&self) -> &str {
        &self.def.name
    }
    fn definition(&self) -> &ToolDefinition {
        &self.def
    }
    async fn execute(&self, ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let text = super::require_string(&args, "text")?;
        let dedupe = args
            .get("dedupeKey")
            .and_then(Value::as_str)
            .map(str::to_string);
        send(
            self.channel.as_ref(),
            ctx,
            AgentMessageKind::Progress,
            text,
            dedupe,
        )
        .await
    }
}

#[async_trait]
impl Tool for AskParentTool {
    fn name(&self) -> &str {
        &self.def.name
    }
    fn definition(&self) -> &ToolDefinition {
        &self.def
    }
    async fn execute(&self, ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let question = super::require_string(&args, "question")?;
        let context = args.get("context").and_then(Value::as_str);
        let text = match context {
            Some(context) if !context.trim().is_empty() => {
                format!("问题：{question}\n上下文：{context}")
            }
            _ => format!("问题：{question}"),
        };
        send(
            self.channel.as_ref(),
            ctx,
            AgentMessageKind::Question,
            text,
            Some("ask_parent".to_string()),
        )
        .await
    }
}

#[async_trait]
impl Tool for RequestCapabilityTool {
    fn name(&self) -> &str {
        &self.def.name
    }
    fn definition(&self) -> &ToolDefinition {
        &self.def
    }
    async fn execute(&self, ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let capability = super::require_string(&args, "capability")?;
        if conex_agents::task::SubagentCapabilityMode::parse(&capability).is_none() {
            return Err(ToolError::invalid_input(format!(
                "未知能力档：{capability}"
            )));
        }
        let reason = super::require_string(&args, "reason")?;
        let text = format!(
            "能力申请：{capability}\n理由：{reason}\n请主 agent 评估后使用 grant_capability 批准，\
             或给出替代方案。"
        );
        send(
            self.channel.as_ref(),
            ctx,
            AgentMessageKind::Question,
            text,
            Some("request_capability".to_string()),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;
    use std::sync::Mutex;

    #[derive(Debug, Default)]
    struct RecordingChannel {
        calls: Mutex<Vec<(AgentMessageKind, String, Option<String>)>>,
    }

    #[async_trait]
    impl SubagentReportChannel for RecordingChannel {
        async fn report(
            &self,
            _child_session: &str,
            kind: AgentMessageKind,
            text: String,
            dedupe_key: Option<String>,
        ) -> Result<(), String> {
            self.calls.lock().unwrap().push((kind, text, dedupe_key));
            Ok(())
        }

        async fn flush(&self, _child_session: &str) {}
    }

    #[tokio::test]
    async fn report_progress_uses_digest_channel() {
        let channel = Arc::new(RecordingChannel::default());
        let tool = ReportProgressTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "text": "已定位问题", "dedupeKey": "step-1" }),
            )
            .await
            .expect("上报应成功");
        assert_eq!(out["channel"], "digest");
        let calls = channel.calls.lock().unwrap();
        assert_eq!(calls[0].0, AgentMessageKind::Progress);
        assert_eq!(calls[0].2.as_deref(), Some("step-1"));
    }

    #[tokio::test]
    async fn ask_parent_is_instant_with_context() {
        let channel = Arc::new(RecordingChannel::default());
        let tool = AskParentTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "question": "选 A 还是 B？", "context": "A 快，B 稳" }),
            )
            .await
            .expect("提问应成功");
        assert_eq!(out["channel"], "instant");
        let calls = channel.calls.lock().unwrap();
        assert_eq!(calls[0].0, AgentMessageKind::Question);
        assert!(calls[0].1.contains("A 快，B 稳"));
    }

    #[tokio::test]
    async fn request_capability_rejects_unknown_mode() {
        let tool =
            RequestCapabilityTool::with_channel(Some(Arc::new(RecordingChannel::default())));
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({ "capability": "god-mode", "reason": "x" }),
            )
            .await
            .expect_err("未知能力档必须拒绝");
        assert!(err.to_string().contains("未知能力档"));
    }
}
