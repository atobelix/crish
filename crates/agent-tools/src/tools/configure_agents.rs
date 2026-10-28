//! configure_agents 工具：主 agent 调整会话级子代理策略。
//!
//! 仅主 agent 工具集（子代理注册表剔除）；策略持久化在 `session_meta`，
//! 立即同步 spawner 准入——数量/深度/通信节奏都由主 agent 按压力调整。
//!
//! 支持字段级补丁（深度合并）：
//! - `spawn`: maxDepth / allowChildSpawn / maxActivePerParent / maxActivePerSession
//! - `communication`: digestIntervalMs / instantRefillPerMin / criticalCapacity ...
//! - `capability`: upgradeRequiresApproval

use async_trait::async_trait;
use conex_types::error::codes;
use serde_json::Value;
use std::sync::Arc;

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};

/// 工具名（子代理由引擎装配点剔除）
pub const CONFIGURE_AGENTS_TOOL_NAME: &str = "configure_agents";

/// 策略通道契约（引擎侧实现；None = 未接线 → common.unsupported）
pub trait AgentPolicyChannel: Send + Sync + std::fmt::Debug {
    /// 应用字段级补丁并返回最新策略 JSON
    fn apply(&self, session_id: &str, patch: Value) -> Result<Value, String>;

    /// 读取当前策略 JSON（可选诊断面）
    fn describe(&self, session_id: &str) -> Result<Value, String>;
}

/// 工具实现
pub(crate) struct ConfigureAgentsTool {
    def: ToolDefinition,
    channel: Option<Arc<dyn AgentPolicyChannel>>,
}

impl ConfigureAgentsTool {
    /// 新建未接线工具（测试/未集成环境返回结构化不可用）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new() -> Self {
        Self::with_channel(None)
    }

    /// 注入策略通道
    pub(crate) fn with_channel(channel: Option<Arc<dyn AgentPolicyChannel>>) -> Self {
        Self {
            def: ToolDefinition {
                name: CONFIGURE_AGENTS_TOOL_NAME.to_string(),
                description: "调整本会话的子代理策略（仅主 agent）：传入字段级补丁，\
                              深度合并后立即生效并持久化。用于按任务规模/服务商压力调整\
                              数量上限、是否允许子代理继续派发、通信摘要节奏等。\
                              返回 { status, policy }。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "patch": {
                            "type": "object",
                            "description": "策略补丁（深度合并）；示例：{\"spawn\":{\"maxActivePerSession\":8}}",
                            "properties": {
                                "spawn": {
                                    "type": "object",
                                    "properties": {
                                        "maxDepth": { "type": ["integer", "null"] },
                                        "allowChildSpawn": { "type": "boolean" },
                                        "maxActivePerParent": { "type": ["integer", "null"] },
                                        "maxActivePerSession": { "type": ["integer", "null"] }
                                    }
                                },
                                "communication": { "type": "object" },
                                "capability": { "type": "object" }
                            }
                        }
                    },
                    "required": ["patch"]
                }),
                dangerous: false,
                fatal_on_error: false,
            },
            channel,
        }
    }
}

#[async_trait]
impl Tool for ConfigureAgentsTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let Some(channel) = self.channel.as_ref() else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "configure_agents 未接线：策略通道未装配（引擎集成后可用）",
            ));
        };
        let patch = input
            .get("patch")
            .ok_or_else(|| ToolError::invalid_input("patch 必填（对象）".to_string()))?;
        if !patch.is_object() {
            return Err(ToolError::invalid_input(
                "patch 必须是对象（字段级补丁）".to_string(),
            ));
        }
        let policy = channel
            .apply(&ctx.session_id, patch.clone())
            .map_err(|message| ToolError::new(codes::TOOL_EXECUTION_FAILED, message))?;
        Ok(serde_json::json!({
            "status": "applied",
            "policy": policy,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;
    use std::sync::Mutex;

    #[derive(Debug, Default)]
    struct RecordingPolicyChannel {
        calls: Mutex<Vec<(String, Value)>>,
    }

    impl AgentPolicyChannel for RecordingPolicyChannel {
        fn apply(&self, session_id: &str, patch: Value) -> Result<Value, String> {
            self.calls
                .lock()
                .unwrap()
                .push((session_id.to_string(), patch.clone()));
            Ok(patch)
        }

        fn describe(&self, _session_id: &str) -> Result<Value, String> {
            Ok(serde_json::json!({}))
        }
    }

    #[tokio::test]
    async fn applies_patch_with_session_context() {
        let channel = Arc::new(RecordingPolicyChannel::default());
        let tool = ConfigureAgentsTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "patch": { "spawn": { "maxActivePerSession": 8 } } }),
            )
            .await
            .expect("补丁应成功");
        assert_eq!(out["status"], "applied");
        let calls = channel.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, ctx.session_id);
        assert_eq!(calls[0].1["spawn"]["maxActivePerSession"], 8);
    }

    #[tokio::test]
    async fn rejects_non_object_patch() {
        let tool =
            ConfigureAgentsTool::with_channel(Some(Arc::new(RecordingPolicyChannel::default())));
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(&ctx, serde_json::json!({ "patch": "oops" }))
            .await
            .expect_err("非对象补丁必须拒绝");
        assert!(err.to_string().contains("patch"));
    }

    #[tokio::test]
    async fn unwired_tool_is_structured_unsupported() {
        let tool = ConfigureAgentsTool::new();
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(&ctx, serde_json::json!({ "patch": {} }))
            .await
            .expect_err("未接线必须报错");
        assert!(err.to_string().contains("未接线"));
    }
}
