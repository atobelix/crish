//! tool_task —— 通用后台工具调用的查询面（工具调用超时转后台 · BG1 契约）
//!
//! 定位：与 `background_task`（shell 进程任务的管理面）**并列、命名区分**：
//! - `background_task` 查的是被 adopt 的子进程任务（BackgroundTaskManager）；
//! - `tool_task` 查的是执行满阈值后被移交通用后台注册表的**进程内工具
//!   调用**（callId 寻址），注册表本体在引擎侧
//!   `conex-run::tool_background`，经本模块的 [ToolBackgroundQuery] 契约
//!   注入（与 `configure_agents::AgentPolicyChannel` 同一注入范式：
//!   agent-tools 只定义契约，None = 未接线）。
//!
//! 本批（BG1）只通查询面：`status` / `result` 两 action 按 callId 查
//! 注册表 / 落盘结果。转后台的写入面（执行器三方竞速 detach）随 BG2
//! 生效、结果回注随 BG3 生效——在此之前本工具恒为未接线状态，返回
//! `common.unsupported` 结构化错误（与 background_task 未接线口径一致），
//! 不伪造任何任务数据。
//!
//! callId 的来源：工具转后台时本调用以占位结果收口，信封内含 callId
//! （见设计 §3.3）；模型凭该 callId 来本工具查状态与全量结果（唤醒
//! 通道的摘要被截断时的兜底路径，设计 §3.4 通道 3）。

use crate::context::ToolContext;
use crate::definition::{ToolDefinition, ToolError};
use async_trait::async_trait;
use conex_types::error::codes;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

/// 后台任务状态（tool_task 契约枚举；与注册表条目状态机一一对应）
///
/// 状态机：`Queued → Running → SettledOk | SettledErr | Cancelled |
/// OutcomeUnknown`。**没有超时/过期态**——注册表对任务时长不设上限
/// （定案 2026-11-01），超长任务合法停留在 Running；终结只来自执行
/// 落定、级联取消、会话关闭与冷启动合成（OutcomeUnknown）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolTaskState {
    /// 已登记、等待执行槽位（每会话 4 / 全局 16 并发上限外排队，不计时）
    Queued,
    /// 已获槽位、执行中
    Running,
    /// 执行落定且成功
    SettledOk,
    /// 执行落定且失败（含工具错误与执行异常）
    SettledErr,
    /// 被取消（用户停止级联 / 会话关闭 / 显式取消）
    Cancelled,
    /// 进程退出时未落定、冷启动合成的未知结果
    OutcomeUnknown,
}

impl ToolTaskState {
    /// 是否为终态（终态后状态不再迁移，先落定者胜）
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            ToolTaskState::SettledOk
                | ToolTaskState::SettledErr
                | ToolTaskState::Cancelled
                | ToolTaskState::OutcomeUnknown
        )
    }
}

/// status action 的返回快照（camelCase 直出）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolTaskStatus {
    pub call_id: String,
    pub tool_name: String,
    pub state: ToolTaskState,
    /// 登记时刻（ms epoch）
    pub queued_at_ms: u64,
    /// 获槽开始执行时刻（排队中为 None——排队不计时）
    pub started_at_ms: Option<u64>,
    /// 终态时刻（未落定为 None）
    pub settled_at_ms: Option<u64>,
    /// 执行耗时（终态且曾开始执行时有值 = settled_at - started_at）
    pub duration_ms: Option<u64>,
}

/// result action 的返回（终态携带全量结果；非终态只报状态、结果未就绪）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolTaskResult {
    pub call_id: String,
    pub tool_name: String,
    pub state: ToolTaskState,
    /// 结果是否已就绪（仅 SettledOk / SettledErr 为 true）
    pub result_ready: bool,
    /// 成功输出（SettledOk 时有值；与直接执行的工具输出同构）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    /// 失败错误码（SettledErr 时有值；对齐 wire 协议 tool.* 域）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    /// 失败文案（SettledErr / Cancelled / OutcomeUnknown 时尽力给出）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// 执行耗时（口径同 [ToolTaskStatus::duration_ms]）
    pub duration_ms: Option<u64>,
}

/// 通用后台注册表的查询契约（引擎侧实现、装配期注入）
///
/// 实现权威实现在 `conex-run::tool_background::ToolBackgroundRegistry`
/// （进程内注册表 + 落盘存储两级查询）；本 trait 是 agent-tools 与引擎
/// 之间的唯一耦合面。两个方法均以 callId 寻址，查无此任务返回 None
/// （由工具层翻译为 tool.not_found 风格错误）。
#[async_trait]
pub trait ToolBackgroundQuery: Send + Sync + std::fmt::Debug {
    /// 按 callId 查任务状态快照
    async fn status(&self, call_id: &str) -> Option<ToolTaskStatus>;
    /// 按 callId 查任务结果（非终态返回 result_ready=false 的状态视图）
    async fn result(&self, call_id: &str) -> Option<ToolTaskResult>;
}

/// tool_task 工具本体（查询后端构造期注入；None = 未接线）
#[derive(Debug)]
pub struct ToolTaskTool {
    def: ToolDefinition,
    query: Option<Arc<dyn ToolBackgroundQuery>>,
}

impl ToolTaskTool {
    /// 以查询后端构造（None = 未接线，执行期返回 common.unsupported）
    pub fn with_query(query: Option<Arc<dyn ToolBackgroundQuery>>) -> Self {
        Self {
            def: ToolDefinition {
                name: "tool_task".to_string(),
                description: "查询已转入后台的工具调用的状态与结果（按 callId）。\
                    工具执行超过阈值仍未完成时会被转入后台继续执行，本调用先收到带 callId 的占位结果；\
                    之后可用 action=status 查进度、action=result 取全量结果（未完成时返回未就绪状态，不报错）。\
                    注意：这与 background_task（shell 进程任务）是两套任务，本工具只查进程内工具调用。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["status", "result"],
                            "description": "status = 查状态快照；result = 取结果（未落定返回未就绪）"
                        },
                        "callId": {
                            "type": "string",
                            "description": "转后台占位结果中给出的工具调用 id"
                        }
                    },
                    "required": ["action", "callId"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
                background_after_ms: None,
            },
            query,
        }
    }
}

#[async_trait]
impl crate::definition::Tool for ToolTaskTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        // 先解析 action（入参校验独立于接线状态，保证错误分类稳定，
        // 与 background_task 同口径）
        let action = super::require_string(&args, "action")?;
        // 查询后端未接线 → 结构化不可用错误（不 panic、不伪造数据）
        let Some(query) = &self.query else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "tool_task 未接线：通用后台注册表未装配（引擎侧注入 ToolBackgroundQuery 后可用）",
            ));
        };
        match action.as_str() {
            "status" => {
                let call_id = super::require_string(&args, "callId")?;
                let status = query.status(&call_id).await.ok_or_else(|| {
                    ToolError::new(
                        codes::TOOL_NOT_FOUND,
                        format!("tool_task 未找到后台工具调用：{call_id}"),
                    )
                })?;
                serialize_contract(&status)
            }
            "result" => {
                let call_id = super::require_string(&args, "callId")?;
                let result = query.result(&call_id).await.ok_or_else(|| {
                    ToolError::new(
                        codes::TOOL_NOT_FOUND,
                        format!("tool_task 未找到后台工具调用：{call_id}"),
                    )
                })?;
                serialize_contract(&result)
            }
            other => Err(ToolError::invalid_input(format!(
                "未知 action：{other}（可选 status / result）"
            ))),
        }
    }
}

/// 契约结构序列化出站（与 background_task::serialize_contract 同口径：
/// 序列化失败归类为执行失败而非静默兜底）
fn serialize_contract<T: Serialize>(value: &T) -> Result<Value, ToolError> {
    serde_json::to_value(value).map_err(|e| {
        ToolError::new(
            codes::TOOL_EXECUTION_FAILED,
            format!("tool_task 结果序列化失败：{e}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;
    use crate::definition::Tool;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// 内存假后端：按 callId 预置状态/结果，验证工具层分发与错误分类
    #[derive(Debug, Default)]
    struct FakeQuery {
        statuses: Mutex<HashMap<String, ToolTaskStatus>>,
        results: Mutex<HashMap<String, ToolTaskResult>>,
    }

    #[async_trait]
    impl ToolBackgroundQuery for FakeQuery {
        async fn status(&self, call_id: &str) -> Option<ToolTaskStatus> {
            self.statuses.lock().unwrap().get(call_id).cloned()
        }

        async fn result(&self, call_id: &str) -> Option<ToolTaskResult> {
            self.results.lock().unwrap().get(call_id).cloned()
        }
    }

    fn sample_status() -> ToolTaskStatus {
        ToolTaskStatus {
            call_id: "call-1".to_string(),
            tool_name: "web_search".to_string(),
            state: ToolTaskState::Running,
            queued_at_ms: 1_000,
            started_at_ms: Some(1_200),
            settled_at_ms: None,
            duration_ms: None,
        }
    }

    #[test]
    fn definition_shape() {
        let tool = ToolTaskTool::with_query(None);
        let def = tool.definition();
        assert_eq!(def.name, "tool_task");
        assert!(!def.dangerous);
        assert!(!def.fatal_on_error);
        // 查询工具自身永不转后台（快查询，禁入）
        assert!(!def.is_background_eligible());
        assert_eq!(def.input_schema["required"], json!(["action", "callId"]));
    }

    #[tokio::test]
    async fn unwired_returns_common_unsupported() {
        let tool = ToolTaskTool::with_query(None);
        let err = tool
            .execute(
                &create_mock_tool_context(),
                json!({ "action": "status", "callId": "call-1" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::COMMON_UNSUPPORTED);
    }

    #[tokio::test]
    async fn status_and_result_roundtrip_via_backend() {
        let fake = Arc::new(FakeQuery::default());
        fake.statuses
            .lock()
            .unwrap()
            .insert("call-1".to_string(), sample_status());
        fake.results.lock().unwrap().insert(
            "call-1".to_string(),
            ToolTaskResult {
                call_id: "call-1".to_string(),
                tool_name: "web_search".to_string(),
                state: ToolTaskState::SettledOk,
                result_ready: true,
                output: Some(json!({ "hits": 3 })),
                error_code: None,
                error_message: None,
                duration_ms: Some(25_000),
            },
        );
        let tool = ToolTaskTool::with_query(Some(fake));

        let out = tool
            .execute(
                &create_mock_tool_context(),
                json!({ "action": "status", "callId": "call-1" }),
            )
            .await
            .unwrap();
        assert_eq!(out["callId"], "call-1");
        assert_eq!(out["state"], "running");
        assert_eq!(out["startedAtMs"], 1_200);

        let out = tool
            .execute(
                &create_mock_tool_context(),
                json!({ "action": "result", "callId": "call-1" }),
            )
            .await
            .unwrap();
        assert_eq!(out["state"], "settled-ok");
        assert_eq!(out["resultReady"], true);
        assert_eq!(out["output"], json!({ "hits": 3 }));
        assert_eq!(out["durationMs"], 25_000);
    }

    #[tokio::test]
    async fn unknown_call_id_is_not_found() {
        let tool = ToolTaskTool::with_query(Some(Arc::new(FakeQuery::default())));
        let err = tool
            .execute(
                &create_mock_tool_context(),
                json!({ "action": "result", "callId": "nope" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_NOT_FOUND);
    }

    #[tokio::test]
    async fn unknown_action_and_missing_args_are_invalid_input() {
        let tool = ToolTaskTool::with_query(Some(Arc::new(FakeQuery::default())));
        let err = tool
            .execute(
                &create_mock_tool_context(),
                json!({ "action": "kill", "callId": "call-1" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_INVALID_INPUT);

        let err = tool
            .execute(&create_mock_tool_context(), json!({ "action": "status" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_INVALID_INPUT);
    }

    #[test]
    fn state_terminal_classification() {
        assert!(!ToolTaskState::Queued.is_terminal());
        assert!(!ToolTaskState::Running.is_terminal());
        assert!(ToolTaskState::SettledOk.is_terminal());
        assert!(ToolTaskState::SettledErr.is_terminal());
        assert!(ToolTaskState::Cancelled.is_terminal());
        assert!(ToolTaskState::OutcomeUnknown.is_terminal());
    }
}
