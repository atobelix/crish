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

/// 执行会话模式：绑定当前会话（在当前对话内自动定时执行）
pub const EXECUTION_MODE_CURRENT_SESSION: &str = "current_session";
/// 目标模式简写：绑定当前会话（对齐阶段三方案 target_mode 契约）
pub const EXECUTION_MODE_CURRENT: &str = "current";
/// 执行会话模式：独立后台会话（在后台独立新建会话执行）
pub const EXECUTION_MODE_ISOLATED: &str = "isolated";
/// 单轨定时任务索引键（与阶段一、阶段四收敛后的单轨索引键严格同源，废除旧 `sched_ids`）
pub const SESSION_META_INDEX_KEY: &str = "sched_index";

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

/// create_workflow 工具入参结构体（支持 camelCase 与 snake_case 单轨解析）
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkflowArgs {
    /// 任务名称（必填非空）
    #[serde(default)]
    pub name: String,
    /// 每次触发时执行的操作指令（必填非空）
    #[serde(default)]
    pub prompt: String,
    /// 调度类型（manual | daily | intervalMinutes | cron；缺省 manual）
    #[serde(default, alias = "schedule_type")]
    pub schedule_type: Option<String>,
    /// 每日时刻（schedule_type=daily 时必填，HH:mm）
    #[serde(default, alias = "daily_time")]
    pub daily_time: Option<String>,
    /// 间隔分钟（schedule_type=intervalMinutes 时必填，1–10080）
    #[serde(default, alias = "interval_minutes")]
    pub interval_minutes: Option<u64>,
    /// 5 字段 cron 表达式（schedule_type=cron 时必填）
    #[serde(default, alias = "cron_expression")]
    pub cron_expression: Option<String>,
    /// 目标工作区（可选；未传且 ctx.workspace_root 非空时默认继承）
    #[serde(default)]
    pub cwd: Option<String>,
    /// 是否启用（缺省 true）
    #[serde(default)]
    pub enabled: Option<bool>,
    /// 执行会话模式（"current_session" / "current" 在当前对话内自动定时执行；"isolated" 在后台独立新建会话执行）
    #[serde(
        default,
        alias = "execution_mode",
        alias = "targetMode",
        alias = "target_mode"
    )]
    pub execution_mode: Option<String>,
    /// 目标会话 ID（可选；若传入则优先使用，若传 "isolated"/"independent"/"none" 或空且 execution_mode == "isolated" 则置为 None）
    #[serde(default, alias = "target_session_id")]
    pub target_session_id: Option<String>,
}

/// create_workflow 工具入参（对齐 05 详案 §2.4 `CreateWorkflowInput` 冻结契约与阶段三会话绑定升级；
/// camelCase wire 形状由工具 schema 承载，本结构为通道传递的 Rust 面）
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCreateInput {
    /// 任务名称（必填非空；引擎侧校验）
    pub name: String,
    /// 每次触发时执行的操作指令（必填非空；引擎侧校验）
    pub prompt: String,
    /// 调度类型（manual | daily | intervalMinutes | cron；缺省 manual）
    #[serde(alias = "schedule_type")]
    pub schedule_type: String,
    /// 每日时刻（schedule_type=daily 时必填，HH:mm）
    #[serde(default, alias = "daily_time")]
    pub daily_time: Option<String>,
    /// 间隔分钟（schedule_type=intervalMinutes 时必填，1–10080）
    #[serde(default, alias = "interval_minutes")]
    pub interval_minutes: Option<u64>,
    /// 5 字段 cron 表达式（schedule_type=cron 时必填）
    #[serde(default, alias = "cron_expression")]
    pub cron_expression: Option<String>,
    /// 目标工作区（本机物理绝对路径；未传时默认继承 ctx.workspace_root）
    #[serde(default)]
    pub cwd: Option<String>,
    /// 是否启用（缺省 true）
    #[serde(default)]
    pub enabled: Option<bool>,
    /// 绑定的目标会话 ID（Some = 绑定指定会话；None = 独立后台专用会话）
    #[serde(default, alias = "target_session_id")]
    pub target_session_id: Option<String>,
    /// 执行会话模式（"current_session" | "isolated"）
    #[serde(default, alias = "execution_mode")]
    pub execution_mode: Option<String>,
    /// 目标模式（"current" | "isolated"，对齐阶段三方案 target_mode 字段）
    #[serde(default, alias = "target_mode")]
    pub target_mode: Option<String>,
}

impl WorkflowCreateInput {
    /// 推导归一化后的 5 字段 Cron 表达式（manual 返回 None）
    pub fn resolved_cron_expression(&self) -> Option<String> {
        match self.schedule_type.as_str() {
            SCHEDULE_TYPE_CRON => self
                .cron_expression
                .as_deref()
                .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|s| !s.is_empty()),
            SCHEDULE_TYPE_DAILY => {
                let raw = self.daily_time.as_deref()?.trim();
                let (h, m) = raw.split_once(':')?;
                let hh: u32 = h.trim().parse().ok()?;
                let mm: u32 = m.trim().parse().ok()?;
                Some(format!("{mm} {hh} * * *"))
            }
            SCHEDULE_TYPE_INTERVAL_MINUTES => {
                let n = self.interval_minutes?;
                Some(format!("*/{n} * * * *"))
            }
            _ => None,
        }
    }

    /// 生成对齐单轨契约的落盘元数据 JSON（供 `sched:{id}` / `sched_{id}` / `workflow:{id}` 持久化，
    /// 同时兼容 snake_case `target_session_id` 与 camelCase `targetSessionId`）
    pub fn to_persisted_meta_json(&self, cron_id: &str) -> Value {
        let expression = self.resolved_cron_expression().unwrap_or_default();
        let enabled = self.enabled.unwrap_or(true);
        let exec_mode = self.execution_mode.clone().unwrap_or_else(|| {
            if self.target_session_id.is_some() {
                EXECUTION_MODE_CURRENT_SESSION.to_string()
            } else {
                EXECUTION_MODE_ISOLATED.to_string()
            }
        });
        let target_mode = self.target_mode.clone().unwrap_or_else(|| {
            if self.target_session_id.is_some() {
                EXECUTION_MODE_CURRENT.to_string()
            } else {
                EXECUTION_MODE_ISOLATED.to_string()
            }
        });
        serde_json::json!({
            "cronId": cron_id,
            "cron_id": cron_id,
            "name": self.name,
            "prompt": self.prompt,
            "expression": expression,
            "scheduleType": self.schedule_type,
            "cwd": self.cwd,
            "enabled": enabled,
            "targetSessionId": self.target_session_id,
            "target_session_id": self.target_session_id,
            "executionMode": exec_mode,
            "execution_mode": exec_mode,
            "targetMode": target_mode,
            "target_mode": target_mode,
        })
    }
}

/// create_workflow 结果信封（工具向模型回执的最小展示面；引擎后端
/// WorkflowView 的投影——完整列表仍经 list-workflows 读取）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
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

/// 解析可选字符串参数（兼容主 key 与备选 alias key）
fn optional_string_with_aliases(args: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(val) = super::optional_string(args, key) {
            return Some(val);
        }
    }
    None
}

/// 推导目标会话绑定与执行模式：
/// 返回 `(target_session_id, execution_mode, target_mode)`
fn resolve_session_binding(
    ctx: &ToolContext,
    raw_exec_mode: Option<&str>,
    raw_target_sid: Option<&str>,
) -> (Option<String>, String, String) {
    let mode_norm = raw_exec_mode.map(str::trim).filter(|s| !s.is_empty());
    let target_trimmed = raw_target_sid.map(str::trim);

    // 1. 显式声明 execution_mode / targetMode 为 isolated
    if let Some(m) = mode_norm {
        if m.eq_ignore_ascii_case(EXECUTION_MODE_ISOLATED) || m.eq_ignore_ascii_case("independent")
        {
            return (
                None,
                EXECUTION_MODE_ISOLATED.to_string(),
                EXECUTION_MODE_ISOLATED.to_string(),
            );
        }
    }

    // 2. 显式传入 target_session_id / targetSessionId
    if let Some(t) = target_trimmed {
        if t.eq_ignore_ascii_case(EXECUTION_MODE_ISOLATED)
            || t.eq_ignore_ascii_case("independent")
            || t.eq_ignore_ascii_case("none")
        {
            return (
                None,
                EXECUTION_MODE_ISOLATED.to_string(),
                EXECUTION_MODE_ISOLATED.to_string(),
            );
        }
        if !t.is_empty() {
            return (
                Some(t.to_string()),
                EXECUTION_MODE_CURRENT_SESSION.to_string(),
                EXECUTION_MODE_CURRENT.to_string(),
            );
        }
        // target_session_id 显式传空串且未显式指定 current_session/current 时，视为 isolated
        let explicitly_current = mode_norm.is_some_and(|m| {
            m.eq_ignore_ascii_case(EXECUTION_MODE_CURRENT_SESSION)
                || m.eq_ignore_ascii_case(EXECUTION_MODE_CURRENT)
        });
        if !explicitly_current {
            return (
                None,
                EXECUTION_MODE_ISOLATED.to_string(),
                EXECUTION_MODE_ISOLATED.to_string(),
            );
        }
    }

    // 3. 在有效会话上下文中调用（或显式指定 current_session / current）→ 自动绑定 ctx.session_id
    let ctx_sid = ctx.session_id.trim();
    if !ctx_sid.is_empty() {
        (
            Some(ctx_sid.to_string()),
            EXECUTION_MODE_CURRENT_SESSION.to_string(),
            EXECUTION_MODE_CURRENT.to_string(),
        )
    } else {
        (
            None,
            EXECUTION_MODE_ISOLATED.to_string(),
            EXECUTION_MODE_ISOLATED.to_string(),
        )
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;
    use std::path::PathBuf;
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

    /// 基于 LocalDb session_meta 的测试工作流创建通道：
    /// 验证单轨索引键 `sched_index` 与 `sched:{id}` / `sched_{id}` / `workflow:{id}` 落盘元数据契约
    struct DbBackedWorkflowChannel {
        db: conex_db::LocalDb,
        seq: Mutex<u64>,
    }

    impl std::fmt::Debug for DbBackedWorkflowChannel {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("DbBackedWorkflowChannel")
        }
    }

    impl DbBackedWorkflowChannel {
        fn new(db: conex_db::LocalDb) -> Self {
            Self {
                db,
                seq: Mutex::new(0),
            }
        }
    }

    #[async_trait]
    impl WorkflowCreationChannel for DbBackedWorkflowChannel {
        async fn create(
            &self,
            input: WorkflowCreateInput,
        ) -> Result<WorkflowCreateOutput, WorkflowCreateError> {
            let id_num = {
                let mut g = self.seq.lock().unwrap();
                let current = *g;
                *g += 1;
                current
            };
            let workflow_id = format!("cron-{id_num}");
            let meta_json = input.to_persisted_meta_json(&workflow_id);
            let serialized = serde_json::to_string(&meta_json).unwrap();

            // 落盘 sched_{id}、sched:{id}、workflow:{id} 元数据
            self.db
                .set_session_meta(&format!("sched_{workflow_id}"), &serialized)
                .unwrap();
            self.db
                .set_session_meta(&format!("sched:{workflow_id}"), &serialized)
                .unwrap();
            self.db
                .set_session_meta(&format!("workflow:{workflow_id}"), &serialized)
                .unwrap();

            // 单轨索引写入 SESSION_META_INDEX_KEY ("sched_index")
            let mut index: Vec<String> = self
                .db
                .get_session_meta(SESSION_META_INDEX_KEY)
                .ok()
                .flatten()
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_default();
            if !index.contains(&workflow_id) {
                index.push(workflow_id.clone());
                self.db
                    .set_session_meta(
                        SESSION_META_INDEX_KEY,
                        &serde_json::to_string(&index).unwrap(),
                    )
                    .unwrap();
            }

            let next_run_at = input
                .resolved_cron_expression()
                .map(|_| "2026-10-13T01:00:00.000Z".to_string());
            Ok(WorkflowCreateOutput {
                workflow_id,
                name: input.name,
                next_run_at,
            })
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
        assert_eq!(out["cronExpression"], "0 9 * * *");
        assert!(out["text"].as_str().unwrap().contains("每日巡检"));
        assert!(out["text"].as_str().unwrap().contains("下次执行"));
    }

    #[tokio::test]
    async fn create_workflow_auto_binds_current_session_id() {
        let channel = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
        let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
        let mut ctx = create_mock_tool_context();
        ctx.session_id = "sess-chat-123".to_string();
        ctx.workspace_root = PathBuf::from("C:/Projects/conex");

        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "name": "自动绑定巡检",
                    "prompt": "每日检查分支状态",
                    "scheduleType": "daily",
                    "dailyTime": "09:00"
                }),
            )
            .await
            .unwrap();

        let calls = channel.calls();
        assert_eq!(calls.len(), 1);
        let input = &calls[0];
        assert_eq!(input.target_session_id.as_deref(), Some("sess-chat-123"));
        assert_eq!(input.execution_mode.as_deref(), Some("current_session"));
        assert_eq!(input.target_mode.as_deref(), Some("current"));
        assert_eq!(
            input.cwd.as_deref(),
            Some("C:/Projects/conex"),
            "未传 cwd 时应自动继承 ctx.workspace_root"
        );

        assert_eq!(out["targetSessionId"], "sess-chat-123");
        assert_eq!(out["target_session_id"], "sess-chat-123");
        assert_eq!(out["executionMode"], "current_session");
        assert_eq!(out["execution_mode"], "current_session");
        assert_eq!(out["targetMode"], "current");
        let text = out["text"].as_str().unwrap();
        assert!(text.contains("已绑定当前对话（会话 ID: sess-chat-123）"));
        assert!(text.contains("Cron 表达式: 0 9 * * *"));
    }

    #[tokio::test]
    async fn create_workflow_explicit_isolated_execution_mode_clears_target_session() {
        let channel = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
        let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
        let mut ctx = create_mock_tool_context();
        ctx.session_id = "sess-chat-123".to_string();

        // 1. 显式传入 execution_mode = "isolated"
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "name": "后台巡检",
                    "prompt": "静默执行检查",
                    "scheduleType": "cron",
                    "cronExpression": "*/15 * * * *",
                    "execution_mode": "isolated"
                }),
            )
            .await
            .unwrap();

        let calls = channel.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].target_session_id, None);
        assert_eq!(calls[0].execution_mode.as_deref(), Some("isolated"));
        assert_eq!(calls[0].target_mode.as_deref(), Some("isolated"));
        assert!(out["targetSessionId"].is_null());
        assert!(out["target_session_id"].is_null());
        assert_eq!(out["execution_mode"], "isolated");
        assert_eq!(out["targetMode"], "isolated");
        assert!(out["text"]
            .as_str()
            .unwrap()
            .contains("独立专用后台会话（isolated）"));

        // 2. 显式传入 targetSessionId = "isolated" / "independent"
        let channel2 = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
        let tool2 = CreateWorkflowTool::with_channel(Some(channel2.clone()));
        tool2
            .execute(
                &ctx,
                serde_json::json!({
                    "name": "后台巡检2",
                    "prompt": "静默执行检查",
                    "targetSessionId": "independent"
                }),
            )
            .await
            .unwrap();
        assert_eq!(channel2.calls()[0].target_session_id, None);
        assert_eq!(
            channel2.calls()[0].execution_mode.as_deref(),
            Some("isolated")
        );
    }

    #[tokio::test]
    async fn create_workflow_persists_sched_index_and_single_track_meta() {
        let db = conex_db::LocalDb::open_in_memory().expect("打开内存库应成功");
        let channel = Arc::new(DbBackedWorkflowChannel::new(db.clone()));
        let tool = CreateWorkflowTool::with_channel(Some(channel));

        let mut ctx = create_mock_tool_context();
        ctx.session_id = "sess-chat-123".to_string();

        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "name": "索引与落盘验证",
                    "prompt": "执行代码健康检查",
                    "scheduleType": "cron",
                    "cronExpression": "0 9 * * 1-5"
                }),
            )
            .await
            .unwrap();

        let wf_id = out["workflowId"].as_str().unwrap();
        assert_eq!(wf_id, "cron-0");

        // 验证单轨索引键 "sched_index" 写入正确，且未使用旧 "sched_ids"
        assert!(
            db.get_session_meta("sched_ids").unwrap().is_none(),
            "严禁写入旧索引键 sched_ids"
        );
        let index_raw = db
            .get_session_meta(SESSION_META_INDEX_KEY)
            .unwrap()
            .expect("sched_index 必须存在");
        let index: Vec<String> = serde_json::from_str(&index_raw).unwrap();
        assert_eq!(index, vec!["cron-0".to_string()]);

        // 验证 sched:{id}、sched_{id}、workflow:{id} 落盘 JSON 可正常读取且包含双命名对齐字段
        for key in [
            format!("sched_{wf_id}"),
            format!("sched:{wf_id}"),
            format!("workflow:{wf_id}"),
        ] {
            let raw = db
                .get_session_meta(&key)
                .unwrap()
                .unwrap_or_else(|| panic!("{key} 应已落盘"));
            let meta: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(meta["target_session_id"], "sess-chat-123");
            assert_eq!(meta["targetSessionId"], "sess-chat-123");
            assert_eq!(meta["execution_mode"], "current_session");
            assert_eq!(meta["executionMode"], "current_session");
            assert_eq!(meta["target_mode"], "current");
            assert_eq!(meta["targetMode"], "current");
            assert_eq!(meta["expression"], "0 9 * * 1-5");
        }
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
