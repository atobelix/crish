//! kill_subagent 工具（D4 §3.3）：主 agent 关闭子代理的通道契约与工具本体。
//!
//! - **仅主 agent 工具集**：子代理注册表剔除面扩展（与 run_subagent 同面，
//!   剔除决策权威位在引擎装配点——发起者身份判定在引擎）；
//! - 引擎侧实现 [SubagentKillChannel]（经 SubagentLifecycleService +
//!   spawn_blocking），agent-tools 只定义契约；
//! - 通道未接线（None）→ `common.unsupported`（与 run_subagent 未接线先例
//!   subagent.rs:999-1004 同款）；目标子代理不存在 → 结构化错误码
//!   `subagent.not_found`（D4 §8 D-5）；
//! - 结果信封：`{ subagentId, subagentRunId, outcome: "killed"|"alreadyTerminal",
//!   forceCancelDelivered }`（对齐 wait_subagents 结果信封风格）。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use conex_types::error::codes;
use serde_json::Value;
use std::sync::Arc;

/// kill_subagent 工具名（子代理注册表剔除对象；常量供剔除面与测试引用）
pub const SUBAGENT_KILL_TOOL_NAME: &str = "kill_subagent";

/// 单目标终止处置结果（工具面自持枚举，wire 名 camelCase）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillOutcomeKind {
    /// L3 强停投递成功 + 行归一 failed
    Killed,
    /// 行非 running（失败/完成），无动作（幂等）
    AlreadyTerminal,
}

impl KillOutcomeKind {
    /// wire 名
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Killed => "killed",
            Self::AlreadyTerminal => "alreadyTerminal",
        }
    }
}

/// 工具结果（agent-tools 自持类型，叶子 crate 不依赖 orchestrator）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillSubagentToolResult {
    /// 子代理 id
    pub subagent_id: String,
    /// 子代理 run id（目标行定位所得）
    pub subagent_run_id: Option<String>,
    /// 处置结果
    pub outcome: KillOutcomeKind,
    /// killed 时 L3 是否实际投递（引擎无该 run 的运行实例 = false）
    pub force_cancel_delivered: bool,
}

/// 主 agent 关闭子代理的通道契约（引擎侧实现；None = 未接线 →
/// common.unsupported）。
///
/// 实现方职责（对齐 D4 §3.3）：经 SubagentLifecycleService::kill_subagent
/// （orchestrator::lifecycle）投递 L3 强停 + 行归一 failed；同步 SQLite 面
/// 经 spawn_blocking 包裹（F2-27，命令面同步调用面不落在 tokio worker 上）。
#[async_trait::async_trait]
pub trait SubagentKillChannel: Send + Sync + std::fmt::Debug {
    /// 单目标终止：返回处置结果；目标不存在 / 落库失败 → Err(结构化文案)
    async fn kill_subagent(
        &self,
        session_id: &str,
        subagent_id: &str,
        reason: &str,
    ) -> Result<KillSubagentToolResult, String>;
}

/// kill_subagent 工具：主 agent 单目标关闭子代理（终止 + 重派闭环的
/// 「关闭」侧；重派走 run_subagent / resume_subagent）
pub(crate) struct KillSubagentTool {
    def: ToolDefinition,
    /// 终止通道（None = 未接线，返回结构化不可用错误）
    channel: Option<Arc<dyn SubagentKillChannel>>,
}

impl KillSubagentTool {
    /// 新建工具（终止通道未接线；测试与未集成环境返回结构化不可用错误）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new() -> Self {
        Self::with_channel(None)
    }

    /// 新建工具并注入终止通道（注册面接线点：BuiltinToolConfig 注入）
    pub(crate) fn with_channel(channel: Option<Arc<dyn SubagentKillChannel>>) -> Self {
        Self {
            def: ToolDefinition {
                name: SUBAGENT_KILL_TOOL_NAME.to_string(),
                description: "单目标关闭子代理（主 agent 编排用）：按 subagentId 终止\
                              指定子代理——投递 L3 强停并归一失败态；已终态目标\
                              （失败/完成）幂等 no-op（alreadyTerminal）。关闭后主 agent\
                              可经 run_subagent / resume_subagent 重派。返回\
                              subagentId/subagentRunId/outcome/forceCancelDelivered。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "subagentId": {
                            "type": "string",
                            "description": "目标子代理 id（run_subagent 返回的 subagentId，必填）"
                        },
                        "reason": {
                            "type": "string",
                            "description": "终止原因（可选，供审计与终态留痕；缺省 kill_subagent）"
                        }
                    },
                    "required": ["subagentId"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
            channel,
        }
    }
}

#[async_trait::async_trait]
impl Tool for KillSubagentTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        // subagentId 必填非空（对齐 require_string 校验面）
        let subagent_id = super::require_string(&args, "subagentId")?;
        let reason = super::optional_string(&args, "reason").unwrap_or_default();
        // 终止通道未接线 → 结构化不可用错误（引擎集成前零副作用）
        let Some(channel) = &self.channel else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "kill_subagent 未接线：终止通道未装配（引擎集成后可用）",
            ));
        };
        // 会话 id 取执行上下文（与 run_subagent 的 parent_session_id 同源）
        let result = channel
            .kill_subagent(&ctx.session_id, &subagent_id, &reason)
            .await
            .map_err(|message| {
                // 结构化错误码：目标不存在 → subagent.not_found（D4 §8 D-5）；
                // 其余落库/内部失败 → 执行失败兜底
                let code = if message.contains("子代理不存在") {
                    codes::SUBAGENT_NOT_FOUND
                } else {
                    codes::TOOL_EXECUTION_FAILED
                };
                ToolError::new(code, message)
            })?;
        // 结果信封（对齐 wait_subagents 结果信封风格 wait_subagents.rs:745-766）
        Ok(serde_json::json!({
            "subagentId": result.subagent_id,
            "subagentRunId": result.subagent_run_id,
            "outcome": result.outcome.as_str(),
            "forceCancelDelivered": result.force_cancel_delivered,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;
    use std::sync::Mutex;

    /// 记录式终止通道替身（可控投递结果）
    struct RecordingKillChannel {
        calls: Mutex<Vec<(String, String, String)>>,
        result: Mutex<Result<KillSubagentToolResult, String>>,
    }

    impl std::fmt::Debug for RecordingKillChannel {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("RecordingKillChannel").finish_non_exhaustive()
        }
    }

    impl RecordingKillChannel {
        fn ok(subagent_id: &str, run_id: Option<&str>, outcome: KillOutcomeKind) -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                result: Mutex::new(Ok(KillSubagentToolResult {
                    subagent_id: subagent_id.to_string(),
                    subagent_run_id: run_id.map(str::to_string),
                    outcome,
                    force_cancel_delivered: outcome == KillOutcomeKind::Killed,
                })),
            })
        }

        fn err(message: &str) -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                result: Mutex::new(Err(message.to_string())),
            })
        }

        fn calls(&self) -> Vec<(String, String, String)> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl SubagentKillChannel for RecordingKillChannel {
        async fn kill_subagent(
            &self,
            session_id: &str,
            subagent_id: &str,
            reason: &str,
        ) -> Result<KillSubagentToolResult, String> {
            self.calls
                .lock()
                .unwrap()
                .push((
                    session_id.to_string(),
                    subagent_id.to_string(),
                    reason.to_string(),
                ));
            self.result.lock().unwrap().clone()
        }
    }

    /// subagentId 缺失 / 空串 → invalid_input
    #[tokio::test]
    async fn missing_or_empty_subagent_id_rejected() {
        let tool = KillSubagentTool::with_channel(Some(RecordingKillChannel::ok(
            "sub-1",
            Some("run-1"),
            KillOutcomeKind::Killed,
        )));
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(&ctx, serde_json::json!({}))
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_INVALID_INPUT);
        let err = tool
            .execute(&ctx, serde_json::json!({ "subagentId": "  " }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_INVALID_INPUT);
    }

    /// 未接线通道 → common.unsupported（零副作用）
    #[tokio::test]
    async fn unwired_channel_returns_unsupported() {
        let tool = KillSubagentTool::with_channel(None);
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(&ctx, serde_json::json!({ "subagentId": "sub-1" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::COMMON_UNSUPPORTED);
    }

    /// 目标不存在 → 结构化错误码 subagent.not_found
    #[tokio::test]
    async fn not_found_maps_to_subagent_not_found() {
        let tool = KillSubagentTool::with_channel(Some(RecordingKillChannel::err(
            "子代理不存在：sub-missing（会话 mock-session）",
        )));
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(&ctx, serde_json::json!({ "subagentId": "sub-missing" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::SUBAGENT_NOT_FOUND);
    }

    /// 其它错误（落库失败等）→ tool.execution_failed 兜底
    #[tokio::test]
    async fn other_errors_map_to_execution_failed() {
        let tool = KillSubagentTool::with_channel(Some(RecordingKillChannel::err(
            "数据库写失败：disk full",
        )));
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(&ctx, serde_json::json!({ "subagentId": "sub-1" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_EXECUTION_FAILED);
    }

    /// 成功路径：通道收到 (session_id, subagent_id, reason) 且信封字段正确
    #[tokio::test]
    async fn killed_envelope_and_channel_args() {
        let channel = RecordingKillChannel::ok("sub-1", Some("run-1"), KillOutcomeKind::Killed);
        let tool = KillSubagentTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "subagentId": "sub-1", "reason": "已超时" }),
            )
            .await
            .unwrap();
        assert_eq!(out["subagentId"], "sub-1");
        assert_eq!(out["subagentRunId"], "run-1");
        assert_eq!(out["outcome"], "killed");
        assert_eq!(out["forceCancelDelivered"], true);
        let calls = channel.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "mock-session", "会话 id 取自执行上下文");
        assert_eq!(calls[0].1, "sub-1");
        assert_eq!(calls[0].2, "已超时", "reason 透传");
    }

    /// 已终态幂等路径：outcome=alreadyTerminal、无投递标记
    #[tokio::test]
    async fn already_terminal_envelope() {
        let channel = RecordingKillChannel::ok("sub-1", Some("run-1"), KillOutcomeKind::AlreadyTerminal);
        let tool = KillSubagentTool::with_channel(Some(channel));
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(&ctx, serde_json::json!({ "subagentId": "sub-1" }))
            .await
            .unwrap();
        assert_eq!(out["outcome"], "alreadyTerminal");
        assert_eq!(out["forceCancelDelivered"], false);
    }

    /// 缺省 reason：通道收到空串（引擎侧按缺省文案处理）
    #[tokio::test]
    async fn default_reason_passed_through() {
        let channel = RecordingKillChannel::ok("sub-1", None, KillOutcomeKind::Killed);
        let tool = KillSubagentTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        tool.execute(&ctx, serde_json::json!({ "subagentId": "sub-1" }))
            .await
            .unwrap();
        let calls = channel.calls();
        assert_eq!(calls[0].2, "", "reason 缺省透传空串");
    }
}
