//! create_workflow 入参 / 出参与 WorkflowCreationChannel 通道契约（自 create_workflow.rs 纯搬迁）

use super::{
    WorkflowCreateError, EXECUTION_MODE_CURRENT, EXECUTION_MODE_CURRENT_SESSION,
    EXECUTION_MODE_ISOLATED, SCHEDULE_TYPE_CRON, SCHEDULE_TYPE_DAILY,
    SCHEDULE_TYPE_INTERVAL_MINUTES,
};
use async_trait::async_trait;
use serde_json::Value;

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
