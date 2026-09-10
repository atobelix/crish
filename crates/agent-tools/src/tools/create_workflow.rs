//! create_workflow 工具与 WorkflowCreationChannel 契约（维度五：定时任务编排助手）
//!
//! 定位（docs/prompt-injection-pipeline/00-总方案-统一提示词与上下文注入通道架构规划.md
//! §二 维度五 / §六 现实基线注记 3；detailed-plans/05-定时任务编排助手落地实践详案.md
//! §2.4 双模落盘 · 路径 A）：
//! - AI 侧经 create_workflow 工具向引擎注册定时任务（Grill-Me 四要素对齐后
//!   自动调用），引擎复用既有 `create-workflow` IPC 命令的校验 / parse_cron /
//!   注册逻辑落盘（工作区路径、时区偏移语义等全部同源，禁止平行实现第二套
//!   注册链路——接线注记见 05 详案 §2.4）；
//! - 本模块只定义**契约与工具本体**：agent-tools 是叶子 crate，不依赖引擎
//!   （对齐 set_timer.rs TimerChannel 先例）；引擎侧实现
//!   [WorkflowCreationChannel]（workflow_commands.rs 后端适配）后经
//!   BuiltinToolConfig 注入，通道未接线时工具返回 common.unsupported
//!   结构化错误；
//! - 入参形状对齐 05 详案 §2.4 `CreateWorkflowInput` 冻结契约
//!   （schedule_type 四态：manual | daily | intervalMinutes | cron，其余字段
//!   为各态的补充载荷；enabled 缺省 true）。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use conex_types::error::codes;
use serde_json::Value;
use std::sync::Arc;

// ── 调度类型字面量（05 详案 §2.4 / 前端 WorkflowScheduleWire 同源）────────

/// 手动触发（仅手动执行，不自动调度）
pub const SCHEDULE_TYPE_MANUAL: &str = "manual";
/// 每日固定时刻（HH:mm，本机时区语义由引擎 parse_cron 固定偏移承载）
pub const SCHEDULE_TYPE_DAILY: &str = "daily";
/// 间隔分钟轮询（1–10080 分钟）
pub const SCHEDULE_TYPE_INTERVAL_MINUTES: &str = "intervalMinutes";
/// 5 字段标准 cron 表达式
pub const SCHEDULE_TYPE_CRON: &str = "cron";

// ── 工作流创建通道契约（引擎侧接线面）──────────────────────────────

/// 定时任务创建错误（结构化，映射为 ToolError 出站；对齐 TimerError 风格
/// set_timer.rs:49-97）
///
/// 语义校验（名称/提示词非空、cron 合法性、每日时刻、间隔范围）**全部
/// 收敛在引擎侧** `create-workflow` 既有校验链（05 详案 §2.4 接线注记）——
/// 本枚举只承载结构化错误外壳，detail 为引擎侧校验文案，不在 agent-tools
/// 内做第二套语义校验。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkflowCreateError {
    /// 入参语义校验失败（名称空 / cron 非法 / 时刻非法 / 间隔越界；
    /// 附引擎侧既有校验的真实中文文案）
    InvalidInput(String),
    /// 通道未接线（对齐 common.unsupported 语义）
    Unsupported,
}

impl WorkflowCreateError {
    /// 错误码
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput(_) => codes::TOOL_INVALID_INPUT,
            Self::Unsupported => codes::COMMON_UNSUPPORTED,
        }
    }

    /// 错误文案
    pub fn message(&self) -> String {
        match self {
            Self::InvalidInput(detail) => format!("创建定时任务失败：{detail}"),
            Self::Unsupported => "create_workflow 通道未接线（引擎集成后可用）".to_string(),
        }
    }
}

/// create_workflow 工具入参（对齐 05 详案 §2.4 `CreateWorkflowInput` 冻结契约；
/// camelCase wire 形状由工具 schema 承载，本结构为通道传递的 Rust 面）
#[derive(Debug, Clone)]
pub struct WorkflowCreateInput {
    /// 任务名称（必填非空；引擎侧校验）
    pub name: String,
    /// 每次触发时执行的操作指令（必填非空；引擎侧校验）
    pub prompt: String,
    /// 调度类型（manual | daily | intervalMinutes | cron；缺省 manual）
    pub schedule_type: String,
    /// 每日时刻（schedule_type=daily 时必填，HH:mm）
    pub daily_time: Option<String>,
    /// 间隔分钟（schedule_type=intervalMinutes 时必填，1–10080）
    pub interval_minutes: Option<u64>,
    /// 5 字段 cron 表达式（schedule_type=cron 时必填）
    pub cron_expression: Option<String>,
    /// 目标工作区（本机物理绝对路径；缺省 = 不绑定 cwd）
    pub cwd: Option<String>,
    /// 是否启用（缺省 true）
    pub enabled: Option<bool>,
}

/// create_workflow 结果信封（工具向模型回执的最小展示面；引擎后端
/// WorkflowView 的投影——完整列表仍经 list-workflows 读取）
#[derive(Debug, Clone)]
pub struct WorkflowCreateOutput {
    /// 新任务 id（cron-<seq>）
    pub workflow_id: String,
    /// 任务名称（回显引擎规范化后的值）
    pub name: String,
    /// 下次执行时刻（ISO-8601 UTC；manual 任务无调度 → None）
    pub next_run_at: Option<String>,
}

/// 工作流创建通道契约（AI 侧工具与引擎侧 workflow 后端解耦边界；
/// 与 subagent_wait_channel（mod.rs:54-57）/ timer_channel（set_timer.rs）
/// 同一注入范式）
///
/// 实现方职责（对齐 05 详案 §2.4 接线注记）：复用既有 `create-workflow` IPC
/// 命令的校验 / parse_cron / 调度注册逻辑（WorkflowBackend::create），**禁止**
/// 平行实现第二套注册链路。语义校验失败返回 [WorkflowCreateError::InvalidInput]
/// （附引擎既有校验文案），错误码映射 tool.invalid_input。
#[async_trait]
pub trait WorkflowCreationChannel: Send + Sync + std::fmt::Debug {
    /// 创建定时任务（引擎侧校验 → 表达式转换 → 注册调度 → 落库）
    async fn create(
        &self,
        input: WorkflowCreateInput,
    ) -> Result<WorkflowCreateOutput, WorkflowCreateError>;
}

// ── create_workflow 工具 ─────────────────────────────────────────────

/// create_workflow 工具：向引擎注册定时任务（05 详案 §2.4 路径 A）
pub(crate) struct CreateWorkflowTool {
    def: ToolDefinition,
    /// 工作流创建通道（None = 未接线，返回结构化不可用错误）
    channel: Option<Arc<dyn WorkflowCreationChannel>>,
}

impl CreateWorkflowTool {
    /// 新建工具（通道未接线；测试与未集成环境返回结构化不可用错误）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new() -> Self {
        Self::with_channel(None)
    }

    /// 新建工具并注入工作流创建通道（注册面接线点：BuiltinToolConfig 注入）
    pub(crate) fn with_channel(channel: Option<Arc<dyn WorkflowCreationChannel>>) -> Self {
        Self {
            def: ToolDefinition {
                name: "create_workflow".to_string(),
                description: "创建定时任务（注册到引擎调度器，按调度周期自动触发并在每次\
                              触发时执行 prompt 指令）：输入任务名称 name、执行指令 prompt、\
                              调度 scheduleType（manual 手动 / daily 每日固定时刻（配 \
                              dailyTime HH:mm，本机时区）/ intervalMinutes 间隔轮询（配 \
                              intervalMinutes 分钟）/ cron 5 字段表达式（配 \
                              cronExpression））、可选目标工作区 cwd（本机绝对路径）与\
                              是否启用 enabled（缺省 true）。创建成功后返回 workflowId 与\
                              下次执行时刻。定时任务基于后台时钟调度，不支持文件监听或 \
                              git push 钩子——用户提出监听类需求时引导为周期轮询。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "任务名称（必填非空，简明语义化标识）"
                        },
                        "prompt": {
                            "type": "string",
                            "description": "每次触发时执行的具体操作指令（必填非空，建议含\
                                           无异常时简短回复的规范）"
                        },
                        "scheduleType": {
                            "type": "string",
                            "enum": ["manual", "daily", "intervalMinutes", "cron"],
                            "description": "调度类型（可选，缺省 manual）：manual 手动 / \
                                           daily 每日固定时刻 / intervalMinutes 间隔轮询 / \
                                           cron 5 字段标准表达式"
                        },
                        "dailyTime": {
                            "type": "string",
                            "description": "每日时刻（scheduleType=daily 时必填；HH:mm，如 \
                                           09:00；本机时区）"
                        },
                        "intervalMinutes": {
                            "type": "number",
                            "description": "间隔分钟（scheduleType=intervalMinutes 时必填；\
                                           1–10080 整数）"
                        },
                        "cronExpression": {
                            "type": "string",
                            "description": "5 字段 cron 表达式（scheduleType=cron 时必填，\
                                           如 0 9 * * *）"
                        },
                        "cwd": {
                            "type": "string",
                            "description": "目标工作区本机物理绝对路径（可选）"
                        },
                        "enabled": {
                            "type": "boolean",
                            "description": "是否启用（可选，缺省 true）"
                        }
                    },
                    "required": ["name", "prompt"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
            channel,
        }
    }
}

#[async_trait]
impl Tool for CreateWorkflowTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        // 入参解析：name / prompt 必填非空；scheduleType 缺省 manual；
        // 其余字段仅按类型透传——语义校验（时刻/间隔/cron 合法性）收敛在
        // 引擎侧既有 create-workflow 校验链，本工具不平行校验
        let name = super::require_string(&args, "name")?;
        let prompt = super::require_string(&args, "prompt")?;
        let schedule_type = super::optional_string(&args, "scheduleType")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| SCHEDULE_TYPE_MANUAL.to_string());
        let daily_time = super::optional_string(&args, "dailyTime");
        let interval_minutes = super::optional_u64(&args, "intervalMinutes");
        let cron_expression = super::optional_string(&args, "cronExpression");
        let cwd = super::optional_string(&args, "cwd");
        let enabled = super::optional_bool(&args, "enabled");

        // 工作流创建通道未接线 → 结构化不可用错误（引擎集成前零副作用，
        // 对齐 set_timer.rs 先例）
        let Some(channel) = &self.channel else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "create_workflow 未接线：工作流创建通道未装配（引擎集成后可用）",
            ));
        };

        let output = channel
            .create(WorkflowCreateInput {
                name,
                prompt,
                schedule_type,
                daily_time,
                interval_minutes,
                cron_expression,
                cwd,
                enabled,
            })
            .await
            .map_err(|e| ToolError::new(e.code(), e.message()))?;

        // 结果信封：workflowId / name / nextRunAt / text 摘要
        // （「定时任务 <name> 已创建」，manual 任务无下次执行时刻）
        let text = match &output.next_run_at {
            Some(next) => format!(
                "定时任务「{}」已创建（id {}），下次执行 {}",
                output.name, output.workflow_id, next
            ),
            None => format!(
                "定时任务「{}」已创建（id {}，手动触发）",
                output.name, output.workflow_id
            ),
        };
        Ok(serde_json::json!({
            "workflowId": output.workflow_id,
            "name": output.name,
            "nextRunAt": output.next_run_at,
            "text": text,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;
    use std::sync::Mutex;

    // ── 测试替身 ──────────────────────────────────────────────────

    /// 记录式工作流创建通道：记录 create 调用，按预设结果应答
    #[derive(Debug)]
    struct RecordingWorkflowChannel {
        calls: Mutex<Vec<WorkflowCreateInput>>,
        outcome: Result<WorkflowCreateOutput, WorkflowCreateError>,
    }

    impl RecordingWorkflowChannel {
        fn new(outcome: Result<WorkflowCreateOutput, WorkflowCreateError>) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                outcome,
            }
        }

        fn calls(&self) -> Vec<WorkflowCreateInput> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl WorkflowCreationChannel for RecordingWorkflowChannel {
        async fn create(
            &self,
            input: WorkflowCreateInput,
        ) -> Result<WorkflowCreateOutput, WorkflowCreateError> {
            self.calls.lock().unwrap().push(input);
            self.outcome.clone()
        }
    }

    /// 成功应答（参数回显）
    fn ok_output() -> WorkflowCreateOutput {
        WorkflowCreateOutput {
            workflow_id: "cron-0".to_string(),
            name: "每日巡检".to_string(),
            next_run_at: Some("2026-09-03T01:00:00.000Z".to_string()),
        }
    }

    // ── 工具行为 ──────────────────────────────────────────────────

    #[tokio::test]
    async fn create_workflow_forwards_daily_input() {
        let channel = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
        let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "name": "每日巡检",
                    "prompt": "检查仓库状态并简短回复",
                    "scheduleType": "daily",
                    "dailyTime": "09:00",
                    "cwd": "C:/work/conex",
                }),
            )
            .await
            .unwrap();
        let calls = channel.calls();
        assert_eq!(calls.len(), 1);
        let input = &calls[0];
        assert_eq!(input.name, "每日巡检");
        assert_eq!(input.prompt, "检查仓库状态并简短回复");
        assert_eq!(input.schedule_type, "daily");
        assert_eq!(input.daily_time.as_deref(), Some("09:00"));
        assert_eq!(input.interval_minutes, None);
        assert_eq!(input.cron_expression, None);
        assert_eq!(input.cwd.as_deref(), Some("C:/work/conex"));
        assert_eq!(
            input.enabled, None,
            "enabled 缺省透传 None（引擎按 true 兜底）"
        );
        // 输出信封：workflowId / name / nextRunAt / text 摘要
        assert_eq!(out["workflowId"], "cron-0");
        assert_eq!(out["name"], "每日巡检");
        assert_eq!(out["nextRunAt"], "2026-09-03T01:00:00.000Z");
        assert!(out["text"].as_str().unwrap().contains("每日巡检"));
        assert!(out["text"].as_str().unwrap().contains("下次执行"));
    }

    #[tokio::test]
    async fn create_workflow_schedule_type_defaults_manual() {
        let channel = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
        let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        // scheduleType 缺省 → manual
        tool.execute(
            &ctx,
            serde_json::json!({ "name": "手动任务", "prompt": "p" }),
        )
        .await
        .unwrap();
        assert_eq!(channel.calls()[0].schedule_type, "manual");
        // 显式 intervalMinutes / cron 字段透传
        let channel = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
        let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
        tool.execute(
            &ctx,
            serde_json::json!({
                "name": "轮询",
                "prompt": "p",
                "scheduleType": "intervalMinutes",
                "intervalMinutes": 30,
                "enabled": false,
            }),
        )
        .await
        .unwrap();
        let input = &channel.calls()[0];
        assert_eq!(input.schedule_type, "intervalMinutes");
        assert_eq!(input.interval_minutes, Some(30));
        assert_eq!(input.enabled, Some(false));
        let channel = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
        let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
        tool.execute(
            &ctx,
            serde_json::json!({
                "name": "cron 任务",
                "prompt": "p",
                "scheduleType": "cron",
                "cronExpression": "0 9 * * *",
            }),
        )
        .await
        .unwrap();
        let input = &channel.calls()[0];
        assert_eq!(input.schedule_type, "cron");
        assert_eq!(input.cron_expression.as_deref(), Some("0 9 * * *"));
    }

    #[tokio::test]
    async fn create_workflow_channel_none_unsupported() {
        let tool = CreateWorkflowTool::new();
        let ctx = create_mock_tool_context();
        // 未接线环境返回 common.unsupported（不 panic）
        let err = tool
            .execute(&ctx, serde_json::json!({ "name": "巡检", "prompt": "p" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "common.unsupported");
    }

    #[tokio::test]
    async fn create_workflow_missing_name_prompt_rejected() {
        let channel = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
        let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        // 缺 name → tool.invalid_input，不发起 create
        let err = tool
            .execute(&ctx, serde_json::json!({ "prompt": "p" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        // 空 name → tool.invalid_input
        let err = tool
            .execute(&ctx, serde_json::json!({ "name": "  ", "prompt": "p" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        // 缺 prompt → tool.invalid_input
        let err = tool
            .execute(&ctx, serde_json::json!({ "name": "巡检" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        assert!(channel.calls().is_empty(), "非法入参不得发起 create");
    }

    #[tokio::test]
    async fn create_workflow_channel_error_mapped_structurally() {
        // 引擎侧语义校验错误（非法 cron）结构化透传，不 panic
        let channel = Arc::new(RecordingWorkflowChannel::new(Err(
            WorkflowCreateError::InvalidInput("cron 表达式非法".to_string()),
        )));
        let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "name": "巡检",
                    "prompt": "p",
                    "scheduleType": "cron",
                    "cronExpression": "0 0 0 * * *",
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        assert!(err.to_string().contains("非法"));
    }

    #[tokio::test]
    async fn workflow_error_code_mapping() {
        // 错误码映射回归（对齐 TimerError 风格）
        assert_eq!(
            WorkflowCreateError::InvalidInput("x".to_string()).code(),
            codes::TOOL_INVALID_INPUT
        );
        assert_eq!(
            WorkflowCreateError::Unsupported.code(),
            codes::COMMON_UNSUPPORTED
        );
        assert!(WorkflowCreateError::Unsupported
            .message()
            .contains("未接线"));
        assert!(WorkflowCreateError::InvalidInput("坏 cron".to_string())
            .message()
            .contains("坏 cron"));
    }
}
