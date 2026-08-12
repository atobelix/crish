//! send_message 工具（D4 §3.10 / E3 §1.2）：主 agent 主动消息注入。
//!
//! - **仅主 agent 工具集**：子代理注册表剔除面扩展（与 run_subagent /
//!   kill_subagent 同面，剔除决策权威位在引擎装配点——发起者身份判定在
//!   引擎；子代理调用 → tool.not_found）；
//! - `target=subagent`：经 [SubagentInjectChannel] 复用 L1 steer 注入
//!   （与 wait 期间 inject 同通道同语义：`request_subagent_inject`，
//!   reason=`subagent_inject:<id>`，不打断子代理流；目标 run 不可达 →
//!   结构化失败，不静默、不 panic）；
//! - `target=self`：经 [MainAgentMessageChannel] 写会话消息留档
//!   （metadata `{source:"main-agent"}`）+ 入队（当前 run 存活 → followUp
//!   环；run 已收口 → PendingMessageQueue 兜底）——**不标记 user_touched**
//!   （主 agent 自发消息不算「用户交互」，收口不因此抑制 idle 续 run）；
//! - 通道未接线（None）→ `common.unsupported`（与 run_subagent 未接线
//!   先例 subagent.rs:999-1004 同款）；
//! - 结果信封：`{ target, delivered: true, ring: "steer"|"follow_up",
//!   messageId }`（对齐 wait_subagents 结果信封风格）。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use conex_types::error::codes;
use serde_json::Value;
use std::sync::Arc;

/// send_message 工具名（子代理注册表剔除对象；常量供剔除面与测试引用）
pub const SEND_MESSAGE_TOOL_NAME: &str = "send_message";

/// 消息环（target=self 时有效；target=subagent 恒 steer）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainMessageRing {
    /// 下一安全点注入（当前 run 继续）
    Steer,
    /// 仅 run idle 注入（不打断当前 run）
    FollowUp,
}

impl MainMessageRing {
    /// wire 名
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::FollowUp => "follow_up",
        }
    }

    /// 从 wire 名解析（未知值 → None，由调用方按缺省处理）
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "steer" => Some(Self::Steer),
            "follow_up" => Some(Self::FollowUp),
            _ => None,
        }
    }
}

/// 子代理注入通道契约（引擎侧实现；None = 未接线 → common.unsupported）。
///
/// 实现方职责（对齐 wait_channel.rs:457-473 的既有 inject 语义）：经
/// ControlBusResolver 按 subagent_id 定位目标 run 的 ControlBus →
/// `request_subagent_inject(subagent_id, message, Some("send_message_tool"))`
/// ——L1 steer 环，reason=`subagent_inject:<id>`，不打断子代理流；目标 run
/// 不可达 → Err(结构化文案，工具映射为结构化失败，不静默不 panic）。
#[async_trait::async_trait]
pub trait SubagentInjectChannel: Send + Sync + std::fmt::Debug {
    /// 向运行中子代理注入提示词（L1 steer）
    async fn inject(&self, subagent_id: &str, message: &str) -> Result<(), String>;
}

/// 主 agent 会话消息留档 + 入队通道契约（引擎侧实现；None = 未接线）。
///
/// 实现方职责（对齐 E3 §1.2 / D4 §3.10）：① 写入会话消息记录（user 角色
/// 文本消息，metadata `{source:"main-agent"}`——与用户消息区分，用户消息
/// 无 source 字段）；② 当前 run 仍存活 → 经主 run 自己 ControlBus
/// `request_follow_up` 入 followUp 环（仅 idle promote 消费，不打断当前
/// run）；③ 当前 run 已收口 → PendingMessageQueue 入队 steering 条目
/// （group_id=`main-agent-msg`，下一 run decide_idle_resume 消费）。
/// **恒不标记 user_touched**（主 agent 自发消息不算用户交互，收口不因此
/// 抑制 idle 续 run——core_run_commands.rs:2517-2519 语义）。
///
/// `session_id` 入参为执行上下文会话（ToolContext.session_id）——多会话
/// 并发时消息必须落在**发起会话**的主 run 环上（会话留档语义按会话隔离）。
#[async_trait::async_trait]
pub trait MainAgentMessageChannel: Send + Sync + std::fmt::Debug {
    /// 主 agent 给自己留话：返回消息 id（会话留档 + 入队一体完成）
    async fn deliver_self(
        &self,
        session_id: &str,
        message: &str,
        ring: MainMessageRing,
    ) -> Result<String, String>;
}

/// send_message 工具：主 agent 任意时刻向运行中子代理调整方向、
/// 或给自己的下一轮排一条消息（缺口 G-M1 闭合）
pub(crate) struct SendMessageTool {
    def: ToolDefinition,
    /// 子代理注入通道（与 wait_subagents 共用 ControlBusResolver 契约面；
    /// None = 未接线 → common.unsupported）
    subagent_inject: Option<Arc<dyn SubagentInjectChannel>>,
    /// 主 agent 会话消息留档 + 入队通道（壳层实现；None = 未接线）
    self_message: Option<Arc<dyn MainAgentMessageChannel>>,
}

impl SendMessageTool {
    /// 新建工具（两通道未接线；测试与未集成环境返回结构化不可用错误）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new() -> Self {
        Self::with_channels(None, None)
    }

    /// 新建工具并注入两通道（注册面接线点：BuiltinToolConfig 注入）
    pub(crate) fn with_channels(
        subagent_inject: Option<Arc<dyn SubagentInjectChannel>>,
        self_message: Option<Arc<dyn MainAgentMessageChannel>>,
    ) -> Self {
        Self {
            def: ToolDefinition {
                name: SEND_MESSAGE_TOOL_NAME.to_string(),
                description: "发送消息（主 agent 主动消息注入）：target=subagent 向运行中\
                              子代理注入提示（L1 steer 环，不打断执行，reason 携带\
                              subagent_inject:<id>）；target=self 给自己留话（写入会话\
                              消息记录 metadata.source=main-agent，run 结束前入 followUp\
                              环、已收口时入队下一轮消费；不标记 user_touched）。返回\
                              target/delivered/ring/messageId。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "target": {
                            "type": "string",
                            "enum": ["subagent", "self"],
                            "description": "消息目标：subagent = 运行中的子代理（经 L1 steer 环注入，\
                                            不打断执行）；self = 主 agent 自己（写入会话消息记录；\
                                            run 结束前入 followUp 环，下一轮消费）"
                        },
                        "subagentId": {
                            "type": "string",
                            "description": "target=subagent 时必填：目标子代理 id（run_subagent 返回的 subagentId）"
                        },
                        "message": {
                            "type": "string",
                            "description": "消息文本（必填）"
                        },
                        "urgency": {
                            "type": "string",
                            "enum": ["steer", "follow_up"],
                            "description": "target=self 时有效：steer = 下一安全点注入（当前 run 继续）；\
                                            follow_up = 仅 run idle 注入（不打断当前 run）。缺省 follow_up。\
                                            target=subagent 时恒为 steer"
                        }
                    },
                    "required": ["target", "message"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
            subagent_inject,
            self_message,
        }
    }
}

#[async_trait::async_trait]
impl Tool for SendMessageTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        // target 必填且枚举合法（subagent / self）
        let target = super::require_string(&args, "target")?;
        if target != "subagent" && target != "self" {
            return Err(ToolError::invalid_input(format!(
                "target 必须是 subagent 或 self：{target}"
            )));
        }
        // message 必填非空 + 控制字符拒绝（对齐 require_string 校验面）
        let message = super::require_string(&args, "message")?;
        // urgency（target=self 有效；缺省 follow_up）
        let urgency = match super::optional_string(&args, "urgency") {
            Some(raw) => MainMessageRing::parse(&raw)
                .ok_or_else(|| ToolError::invalid_input(format!("未知 urgency：{raw}")))?,
            None => MainMessageRing::FollowUp,
        };

        match target.as_str() {
            // 向运行中子代理注入（L1 steer，不打断流；ring 恒 steer）
            "subagent" => {
                let subagent_id = super::require_string(&args, "subagentId")?;
                let Some(channel) = &self.subagent_inject else {
                    return Err(ToolError::new(
                        codes::COMMON_UNSUPPORTED,
                        "send_message 未接线：子代理注入通道未装配（引擎集成后可用）",
                    ));
                };
                channel
                    .inject(&subagent_id, &message)
                    .await
                    .map_err(|message| {
                        // 目标不可达 → 结构化失败（不静默、不 panic）；码映射：
                        // 「不可达/不存在」→ subagent.not_found，其余执行失败兜底
                        let code = if message.contains("不可达")
                            || message.contains("不存在")
                        {
                            codes::SUBAGENT_NOT_FOUND
                        } else {
                            codes::TOOL_EXECUTION_FAILED
                        };
                        ToolError::new(code, message)
                    })?;
                Ok(serde_json::json!({
                    "target": "subagent",
                    "delivered": true,
                    "ring": "steer",
                    "messageId": serde_json::Value::Null,
                }))
            }
            // 给自己留话（会话留档 + followUp 环 / 队列兜底）
            "self" => {
                let Some(channel) = &self.self_message else {
                    return Err(ToolError::new(
                        codes::COMMON_UNSUPPORTED,
                        "send_message 未接线：主 agent 消息通道未装配（引擎集成后可用）",
                    ));
                };
                let message_id = channel
                    .deliver_self(&ctx.session_id, &message, urgency)
                    .await
                    .map_err(|message| ToolError::new(codes::TOOL_EXECUTION_FAILED, message))?;
                Ok(serde_json::json!({
                    "target": "self",
                    "delivered": true,
                    "ring": urgency.as_str(),
                    "messageId": message_id,
                }))
            }
            _ => unreachable!("target 枚举已校验"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;
    use std::sync::Mutex;

    /// 记录式子代理注入通道替身
    struct RecordingInjectChannel {
        calls: Mutex<Vec<(String, String)>>,
        fail: bool,
    }

    impl std::fmt::Debug for RecordingInjectChannel {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("RecordingInjectChannel").finish_non_exhaustive()
        }
    }

    impl RecordingInjectChannel {
        fn ok() -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                fail: false,
            })
        }

        fn failing() -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                fail: true,
            })
        }

        fn calls(&self) -> Vec<(String, String)> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl SubagentInjectChannel for RecordingInjectChannel {
        async fn inject(&self, subagent_id: &str, message: &str) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push((subagent_id.to_string(), message.to_string()));
            if self.fail {
                Err(format!("目标子代理不可达：{subagent_id}（无运行实例）"))
            } else {
                Ok(())
            }
        }
    }

    /// 记录式主 agent 消息通道替身
    struct RecordingSelfChannel {
        calls: Mutex<Vec<(String, String, MainMessageRing)>>,
        fail: bool,
    }

    impl std::fmt::Debug for RecordingSelfChannel {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("RecordingSelfChannel").finish_non_exhaustive()
        }
    }

    impl RecordingSelfChannel {
        fn ok() -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                fail: false,
            })
        }

        fn failing() -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                fail: true,
            })
        }

        fn calls(&self) -> Vec<(String, String, MainMessageRing)> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl MainAgentMessageChannel for RecordingSelfChannel {
        async fn deliver_self(
            &self,
            session_id: &str,
            message: &str,
            ring: MainMessageRing,
        ) -> Result<String, String> {
            self.calls
                .lock()
                .unwrap()
                .push((session_id.to_string(), message.to_string(), ring));
            if self.fail {
                Err("消息留档失败：disk full".to_string())
            } else {
                Ok(format!("main-agent-msg-{}", self.calls.lock().unwrap().len()))
            }
        }
    }

    fn wired_tool() -> SendMessageTool {
        SendMessageTool::with_channels(Some(RecordingInjectChannel::ok()), Some(RecordingSelfChannel::ok()))
    }

    /// target 缺失 / 非法 → invalid_input
    #[tokio::test]
    async fn invalid_target_rejected() {
        let tool = wired_tool();
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(&ctx, serde_json::json!({ "message": "hi" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_INVALID_INPUT);
        let err = tool
            .execute(&ctx, serde_json::json!({ "target": "both", "message": "hi" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_INVALID_INPUT);
    }

    /// message 缺失 / 空串 → invalid_input
    #[tokio::test]
    async fn missing_message_rejected() {
        let tool = wired_tool();
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(&ctx, serde_json::json!({ "target": "self" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_INVALID_INPUT);
    }

    /// target=subagent 缺 subagentId → invalid_input
    #[tokio::test]
    async fn subagent_target_requires_subagent_id() {
        let tool = wired_tool();
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({ "target": "subagent", "message": "调整方向" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_INVALID_INPUT);
    }

    /// 未知 urgency → invalid_input（target=self 时校验）
    #[tokio::test]
    async fn invalid_urgency_rejected() {
        let tool = wired_tool();
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({ "target": "self", "message": "hi", "urgency": "urgent" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_INVALID_INPUT);
    }

    /// 两通道未接线 → common.unsupported
    #[tokio::test]
    async fn unwired_channels_return_unsupported() {
        let tool = SendMessageTool::new();
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(&ctx, serde_json::json!({ "target": "subagent", "subagentId": "s1", "message": "hi" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::COMMON_UNSUPPORTED);
        let err = tool
            .execute(&ctx, serde_json::json!({ "target": "self", "message": "hi" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::COMMON_UNSUPPORTED);
    }

    /// target=subagent → L1 注入通道收到 (subagent_id, message)；ring 恒 steer
    #[tokio::test]
    async fn subagent_target_injects_via_channel() {
        let channel = RecordingInjectChannel::ok();
        let tool = SendMessageTool::with_channels(Some(channel.clone()), Some(RecordingSelfChannel::ok()));
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "target": "subagent", "subagentId": "sub-7", "message": "优先低风险改动" }),
            )
            .await
            .unwrap();
        assert_eq!(out["target"], "subagent");
        assert_eq!(out["delivered"], true);
        assert_eq!(out["ring"], "steer", "target=subagent 恒 steer（L1 注入语义）");
        let calls = channel.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "sub-7");
        assert_eq!(calls[0].1, "优先低风险改动");
    }

    /// 目标不可达 → 结构化 subagent.not_found（不静默）
    #[tokio::test]
    async fn unreachable_subagent_returns_structured_error() {
        let channel = RecordingInjectChannel::failing();
        let tool = SendMessageTool::with_channels(Some(channel), Some(RecordingSelfChannel::ok()));
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({ "target": "subagent", "subagentId": "ghost", "message": "hi" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::SUBAGENT_NOT_FOUND);
    }

    /// target=self → 消息通道收到 (message, ring)；urgency 缺省 follow_up
    #[tokio::test]
    async fn self_target_delivers_with_default_follow_up() {
        let channel = RecordingSelfChannel::ok();
        let tool = SendMessageTool::with_channels(Some(RecordingInjectChannel::ok()), Some(channel.clone()));
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(&ctx, serde_json::json!({ "target": "self", "message": "记住：明天继续调研 X" }))
            .await
            .unwrap();
        assert_eq!(out["target"], "self");
        assert_eq!(out["delivered"], true);
        assert_eq!(out["ring"], "follow_up", "缺省 follow_up（不打断当前 run）");
        assert!(out["messageId"].as_str().unwrap().starts_with("main-agent-msg-"));
        let calls = channel.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "mock-session", "会话 id 取自执行上下文");
        assert_eq!(calls[0].1, "记住：明天继续调研 X");
        assert_eq!(calls[0].2, MainMessageRing::FollowUp);
    }

    /// target=self + urgency=steer → 通道收到 steer 环
    #[tokio::test]
    async fn self_target_steer_ring_respected() {
        let channel = RecordingSelfChannel::ok();
        let tool = SendMessageTool::with_channels(Some(RecordingInjectChannel::ok()), Some(channel.clone()));
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "target": "self", "message": "x", "urgency": "steer" }),
            )
            .await
            .unwrap();
        assert_eq!(out["ring"], "steer");
        let calls = channel.calls();
        assert_eq!(calls[0].2, MainMessageRing::Steer);
    }

    /// target=self 留档失败 → tool.execution_failed 兜底
    #[tokio::test]
    async fn self_target_failure_maps_to_execution_failed() {
        let channel = RecordingSelfChannel::failing();
        let tool = SendMessageTool::with_channels(Some(RecordingInjectChannel::ok()), Some(channel));
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(&ctx, serde_json::json!({ "target": "self", "message": "x" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_EXECUTION_FAILED);
    }
}
