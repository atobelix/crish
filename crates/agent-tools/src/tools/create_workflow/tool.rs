//! create_workflow 工具本体：CreateWorkflowTool 定义与 Tool 实现（自 create_workflow.rs 纯搬迁）

use super::binding::{optional_string_with_aliases, resolve_session_binding};
use super::{WorkflowCreateInput, WorkflowCreationChannel, SCHEDULE_TYPE_MANUAL};
use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use conex_types::error::codes;
use serde_json::Value;
use std::sync::Arc;

// ── create_workflow 工具 ─────────────────────────────────────────────

/// create_workflow 工具：向引擎注册定时任务（05 详案 §2.4 路径 A + 阶段三会话绑定）
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
                              cronExpression））、可选目标工作区 cwd（本机绝对路径，未传时默认\
                              继承当前上下文工作区）、可选执行模式 execution_mode / targetMode\
                              （'current_session'/'current' 在当前对话内自动定时执行 | 'isolated' 在后台独立新建会话执行）、\
                              可选目标会话 target_session_id / targetSessionId（默认自动绑定当前对话；\
                              设为 'isolated'/'independent' 则为独立后台会话）与是否启用 enabled（缺省 true）。\
                              创建成功后返回 workflowId、Cron 表达式、目标会话绑定状态与下次执行时刻。\
                              定时任务基于后台时钟调度，不支持文件监听或 git push 钩子——\
                              用户提出监听类需求时引导为周期轮询。"
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
                            "description": "目标工作区本机物理绝对路径（可选，未传时默认继承当前上下文工作区路径）"
                        },
                        "execution_mode": {
                            "type": "string",
                            "enum": ["current_session", "current", "isolated"],
                            "description": "执行会话模式：'current_session'（默认，在当前对话内自动定时执行）| 'isolated'（在后台独立新建会话执行）"
                        },
                        "executionMode": {
                            "type": "string",
                            "enum": ["current_session", "current", "isolated"],
                            "description": "执行会话模式（同 execution_mode）：'current_session' | 'isolated'"
                        },
                        "targetMode": {
                            "type": "string",
                            "enum": ["current", "current_session", "isolated"],
                            "description": "目标执行模式：'current' 绑定当前对话；'isolated' 独立后台会话"
                        },
                        "target_session_id": {
                            "type": "string",
                            "description": "目标会话 ID（可选）：显式传入则优先绑定；未传且在有效会话中默认自动绑定当前会话 ID；传 'isolated'/'independent' 则置空为独立后台会话"
                        },
                        "targetSessionId": {
                            "type": "string",
                            "description": "目标会话 ID（可选，同 target_session_id）：缺省自动绑定当前对话；传入 'isolated'/'independent' 则创建独立后台任务"
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

    async fn execute(&self, ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        // 入参解析：name / prompt 必填非空；scheduleType 缺省 manual；
        // 其余字段仅按类型透传——语义校验（时刻/间隔/cron 合法性）收敛在
        // 引擎侧既有 create-workflow 校验链，本工具不平行校验
        let name = super::require_string(&args, "name")?;
        let prompt = super::require_string(&args, "prompt")?;
        let schedule_type = optional_string_with_aliases(&args, &["scheduleType", "schedule_type"])
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| SCHEDULE_TYPE_MANUAL.to_string());
        let daily_time = optional_string_with_aliases(&args, &["dailyTime", "daily_time"]);
        let interval_minutes = super::optional_u64(&args, "intervalMinutes")
            .or_else(|| super::optional_u64(&args, "interval_minutes"));
        let cron_expression =
            optional_string_with_aliases(&args, &["cronExpression", "cron_expression"]);
        let enabled = super::optional_bool(&args, "enabled");

        // cwd：优先使用显式传入的非空路径；未传且 ctx.workspace_root 非空时默认继承
        let cwd = super::optional_string(&args, "cwd")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                let ws = ctx.workspace_root.to_string_lossy();
                let trimmed = ws.trim();
                if !trimmed.is_empty() {
                    Some(trimmed.to_string())
                } else {
                    None
                }
            });

        // 会话绑定与执行模式智能感知（单轨无冗余垫片）
        let raw_exec_mode = optional_string_with_aliases(
            &args,
            &[
                "execution_mode",
                "executionMode",
                "targetMode",
                "target_mode",
            ],
        );
        let raw_target_sid =
            optional_string_with_aliases(&args, &["target_session_id", "targetSessionId"]);
        let (target_session_id, execution_mode, target_mode) =
            resolve_session_binding(ctx, raw_exec_mode.as_deref(), raw_target_sid.as_deref());

        // 工作流创建通道未接线 → 结构化不可用错误（引擎集成前零副作用，
        // 对齐 set_timer.rs 先例）
        let Some(channel) = &self.channel else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "create_workflow 未接线：工作流创建通道未装配（引擎集成后可用）",
            ));
        };

        let input = WorkflowCreateInput {
            name,
            prompt,
            schedule_type,
            daily_time,
            interval_minutes,
            cron_expression,
            cwd: cwd.clone(),
            enabled,
            target_session_id: target_session_id.clone(),
            execution_mode: Some(execution_mode.clone()),
            target_mode: Some(target_mode.clone()),
        };
        let resolved_cron = input.resolved_cron_expression();

        let output = channel
            .create(input)
            .await
            .map_err(|e| ToolError::new(e.code(), e.message()))?;

        let session_desc = match &target_session_id {
            Some(sid) => format!("已绑定当前对话（会话 ID: {sid}）"),
            None => "独立专用后台会话（isolated）".to_string(),
        };
        let cron_desc = match &resolved_cron {
            Some(expr) => format!("，Cron 表达式: {expr}"),
            None => String::new(),
        };

        // 结果信封：清晰说明已创建的定时任务 ID、Cron 表达式、绑定的目标会话模式及下次执行时刻
        let text = match &output.next_run_at {
            Some(next) => format!(
                "定时任务「{}」已成功创建（id {}{}，{}），下次执行时刻 {}",
                output.name, output.workflow_id, cron_desc, session_desc, next
            ),
            None => format!(
                "定时任务「{}」已成功创建（id {}{}，{}，手动触发）",
                output.name, output.workflow_id, cron_desc, session_desc
            ),
        };
        Ok(serde_json::json!({
            "workflowId": output.workflow_id,
            "name": output.name,
            "nextRunAt": output.next_run_at,
            "cronExpression": resolved_cron,
            "cwd": cwd,
            "targetSessionId": target_session_id,
            "target_session_id": target_session_id,
            "targetMode": target_mode,
            "executionMode": execution_mode,
            "execution_mode": execution_mode,
            "text": text,
        }))
    }
}
