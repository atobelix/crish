//! switch_agent_model 工具：主 agent 运行中切换子代理模型（P2）。
//!
//! 语义：更新目标 run 的 `ModelCell`，**下一次模型调用（下一 turn）生效**，
//! 不打断在途请求；`model` 省略/空串 = 清除覆盖，回到引擎当前配置。

use async_trait::async_trait;
use conex_types::error::codes;
use serde_json::Value;
use std::sync::Arc;

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};

/// 工具名（子代理注册面剔除）
pub const SWITCH_AGENT_MODEL_TOOL_NAME: &str = "switch_agent_model";

/// 模型切换通道（引擎侧实现；None = 未接线 → common.unsupported）
pub trait SubagentModelChannel: Send + Sync + std::fmt::Debug {
    /// 切换模型（None = 清除覆盖）。`session_id` 限定父会话作用域，
    /// 目标可为运行中 run 或已终态子代理行（为下次恢复预设）。
    fn switch(
        &self,
        session_id: &str,
        agent_or_run: &str,
        model: Option<String>,
    ) -> Result<(), String>;
}

/// 工具实现
pub(crate) struct SwitchAgentModelTool {
    def: ToolDefinition,
    channel: Option<Arc<dyn SubagentModelChannel>>,
}

impl SwitchAgentModelTool {
    pub(crate) fn with_channel(channel: Option<Arc<dyn SubagentModelChannel>>) -> Self {
        Self {
            def: ToolDefinition {
                name: SWITCH_AGENT_MODEL_TOOL_NAME.to_string(),
                description: "切换子代理模型（仅主 agent）：运行中即时更新，下一 turn 生效；\
                              省略 model 表示清除覆盖、回到引擎当前配置。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "agentId": {
                            "type": "string",
                            "description": "目标子代理 id 或 run id"
                        },
                        "model": {
                            "type": "string",
                            "description": "目标模型名（省略/空串 = 清除覆盖）"
                        }
                    },
                    "required": ["agentId"]
                }),
                dangerous: false,
                fatal_on_error: false,
            },
            channel,
        }
    }
}

#[async_trait]
impl Tool for SwitchAgentModelTool {
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
                "switch_agent_model 未接线：模型通道未装配（引擎集成后可用）",
            ));
        };
        let agent_id = crate::tools::require_string(&args, "agentId")?;
        let model = args
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        channel
            .switch(&ctx.session_id, &agent_id, model.clone())
            .map_err(|message| ToolError::new(codes::TOOL_EXECUTION_FAILED, message))?;
        Ok(serde_json::json!({
            "status": if model.is_some() { "switched" } else { "cleared" },
            "agentId": agent_id,
            "model": model,
            "effective": "next-turn",
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;
    use std::sync::Mutex;

    #[derive(Debug, Default)]
    struct RecordingSwitch {
        calls: Mutex<Vec<(String, Option<String>)>>,
    }

    impl SubagentModelChannel for RecordingSwitch {
        fn switch(
            &self,
            _session_id: &str,
            agent_or_run: &str,
            model: Option<String>,
        ) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push((agent_or_run.to_string(), model));
            Ok(())
        }
    }

    #[tokio::test]
    async fn switches_and_clears_model() {
        let channel = Arc::new(RecordingSwitch::default());
        let tool = SwitchAgentModelTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        tool.execute(
            &ctx,
            serde_json::json!({ "agentId": "sub-1", "model": "deepseek-v4-pro" }),
        )
        .await
        .expect("切换应成功");
        let out = tool
            .execute(&ctx, serde_json::json!({ "agentId": "sub-1" }))
            .await
            .expect("清除应成功");
        assert_eq!(out["status"], "cleared");
        let calls = channel.calls.lock().unwrap();
        assert_eq!(calls[0].1.as_deref(), Some("deepseek-v4-pro"));
        assert_eq!(calls[1].1, None);
    }
}
