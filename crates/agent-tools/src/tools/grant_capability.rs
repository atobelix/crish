//! grant_capability 工具：主 agent 授予/收窄子代理能力（P0）。
//!
//! 与 `request_capability` 配对：子代理申请 → 主 agent 决策 → 本工具落地，
//! 运行中下一批次生效（无需重启子代理）。

use async_trait::async_trait;
use conex_agents::task::SubagentCapabilityMode;
use conex_types::error::codes;
use serde_json::Value;
use std::sync::Arc;

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};

/// 工具名（子代理注册面剔除）
pub const GRANT_CAPABILITY_TOOL_NAME: &str = "grant_capability";

/// 能力授予通道（引擎侧实现；None = 未接线 → common.unsupported）
pub trait SubagentCapabilityGrantChannel: Send + Sync + std::fmt::Debug {
    /// 授予/收窄指定子代理能力（agent_id 或 run_id）；`session_id`
    /// 限定父会话作用域（运行中即时生效，终态行同步持久化供恢复）
    fn grant(
        &self,
        session_id: &str,
        agent_or_run: &str,
        capability: SubagentCapabilityMode,
    ) -> Result<(), String>;
}

/// 工具实现
pub(crate) struct GrantCapabilityTool {
    def: ToolDefinition,
    channel: Option<Arc<dyn SubagentCapabilityGrantChannel>>,
}

impl GrantCapabilityTool {
    pub(crate) fn with_channel(channel: Option<Arc<dyn SubagentCapabilityGrantChannel>>) -> Self {
        Self {
            def: ToolDefinition {
                name: GRANT_CAPABILITY_TOOL_NAME.to_string(),
                description: "授予或收窄子代理能力（仅主 agent）：运行中即时生效，\
                              下一批次 gate 读取。用于批准子代理的 request_capability。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "agentId": {
                            "type": "string",
                            "description": "目标子代理 id（run_subagent 返回的 subagentId）或 run id"
                        },
                        "capability": {
                            "type": "string",
                            "enum": ["read-only", "read-write", "execute", "all"],
                            "description": "目标能力档（受父级能力钳制）"
                        }
                    },
                    "required": ["agentId", "capability"]
                }),
                dangerous: false,
                fatal_on_error: false,
            },
            channel,
        }
    }
}

#[async_trait]
impl Tool for GrantCapabilityTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let Some(channel) = self.channel.as_ref() else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "grant_capability 未接线：能力通道未装配（引擎集成后可用）",
            ));
        };
        let agent_id = crate::tools::require_string(&args, "agentId")?;
        let raw = crate::tools::require_string(&args, "capability")?;
        let capability = SubagentCapabilityMode::parse(&raw)
            .ok_or_else(|| ToolError::invalid_input(format!("未知能力档：{raw}")))?;
        channel
            .grant(&ctx.session_id, &agent_id, capability)
            .map_err(|message| ToolError::new(codes::TOOL_EXECUTION_FAILED, message))?;
        Ok(serde_json::json!({
            "status": "granted",
            "agentId": agent_id,
            "capability": capability.as_str(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;
    use std::sync::Mutex;

    #[derive(Debug, Default)]
    struct RecordingGrant {
        calls: Mutex<Vec<(String, SubagentCapabilityMode)>>,
    }

    impl SubagentCapabilityGrantChannel for RecordingGrant {
        fn grant(
            &self,
            _session_id: &str,
            agent_or_run: &str,
            capability: SubagentCapabilityMode,
        ) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push((agent_or_run.to_string(), capability));
            Ok(())
        }
    }

    #[tokio::test]
    async fn grants_capability() {
        let channel = Arc::new(RecordingGrant::default());
        let tool = GrantCapabilityTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "agentId": "sub-1", "capability": "read-write" }),
            )
            .await
            .expect("授予应成功");
        assert_eq!(out["status"], "granted");
        assert_eq!(channel.calls.lock().unwrap()[0].1, SubagentCapabilityMode::ReadWrite);
    }

    #[tokio::test]
    async fn rejects_unknown_capability() {
        let tool =
            GrantCapabilityTool::with_channel(Some(Arc::new(RecordingGrant::default())));
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({ "agentId": "sub-1", "capability": "god" }),
            )
            .await
            .expect_err("未知能力必须拒绝");
        assert!(err.to_string().contains("未知能力档"));
    }
}
