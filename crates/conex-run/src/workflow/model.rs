//! 持久化模型：StoredWorkflow / 命令视图 / 运行记录与滚动淘汰。

use serde::{Deserialize, Serialize};

use crate::sched::CronTaskStatus;
use crate::workflow::now_ms;
use crate::workflow::schedule::{epoch_ms_to_iso, WorkflowScheduleWire};

/// workflow 存储条目（sched_<cronId> 键 JSON 形状）
///
/// 前八字段与 §4.4 `CronTask` 冻结字段逐项对齐（camelCase），sched.rs
/// 恢复扫描按同键同形解析；扩展字段为本命令面所需（workflow 名称 /
/// 目录 / 运行时刻 / 调度原形）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredWorkflow {
    // ── §4.4 CronTask 冻结字段 ──
    pub cron_id: String,
    /// 5 字段 cron 表达式（manual 为空串）
    #[serde(default)]
    pub expression: String,
    /// 每次触发的通知内容（= workflow 提示词）
    #[serde(default)]
    pub prompt: String,
    /// None = 无限触发；到达即停止（当前命令面不消费，注册表触发路径消费）
    #[serde(default)]
    pub max_iterations: Option<u64>,
    /// true = 独立常驻（拉起独立 run；当前命令面恒 false，AB 方案裁决后接线）
    #[serde(default)]
    pub is_daemon: bool,
    /// 下次触发时刻（parse_cron 估算；真实调度与补发以注册表为准）
    #[serde(default)]
    pub next_fire_at_ms: u64,
    /// 已触发次数（trigger-workflow 立即执行计入；委托激活时与
    /// CronTask.fired_count 存在窗口差——见模块头「委托边界」）
    #[serde(default)]
    pub fired_count: u64,
    /// 生命周期状态（单一真理源）
    #[serde(default = "default_cron_status")]
    pub status: CronTaskStatus,
    /// 是否启用（兼容字段；投影自 status == Active）
    #[serde(default = "default_true")]
    pub enabled: bool,
    // ── workflow 扩展字段 ──
    #[serde(default = "default_workflow_name")]
    pub name: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default = "default_manual_schedule")]
    pub schedule: WorkflowScheduleWire,
    #[serde(default = "now_ms")]
    pub created_at_ms: u64,
    #[serde(default = "now_ms")]
    pub updated_at_ms: u64,
    #[serde(default)]
    pub last_run_at_ms: Option<u64>,
    #[serde(default)]
    pub target_session_id: Option<String>,
    #[serde(default)]
    pub execution_mode: Option<String>,
    #[serde(default, alias = "permissionMode")]
    pub permission_mode: Option<String>,
}

fn default_cron_status() -> CronTaskStatus {
    CronTaskStatus::Active
}

fn default_true() -> bool {
    true
}

fn default_workflow_name() -> String {
    "未命名任务".to_string()
}

fn default_manual_schedule() -> WorkflowScheduleWire {
    WorkflowScheduleWire::Manual
}

impl StoredWorkflow {
    /// 命令输出视图（camelCase wire 形状，对齐前端 WorkflowDefinition）
    pub fn view(&self) -> WorkflowView {
        WorkflowView {
            id: self.cron_id.clone(),
            name: self.name.clone(),
            prompt: self.prompt.clone(),
            cwd: self.cwd.clone(),
            mode: self.mode.clone(),
            enabled: self.enabled,
            schedule: self.schedule.clone(),
            created_at: epoch_ms_to_iso(self.created_at_ms),
            updated_at: epoch_ms_to_iso(self.updated_at_ms),
            next_run_at: if self.next_fire_at_ms == 0 || !self.enabled {
                None
            } else {
                Some(epoch_ms_to_iso(self.next_fire_at_ms))
            },
            last_run_at: self.last_run_at_ms.map(epoch_ms_to_iso),
            target_session_id: self.target_session_id.clone(),
            execution_mode: self.execution_mode.clone(),
            permission_mode: self.permission_mode.clone(),
        }
    }
}

/// 命令输出：workflow 条目（对齐前端 WorkflowDefinition 类型面）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowView {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub cwd: Option<String>,
    pub mode: Option<String>,
    pub enabled: bool,
    pub schedule: WorkflowScheduleWire,
    pub created_at: String,
    pub updated_at: String,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
}

/// 运行记录（`sched_runs` 键条目；触发时登记，事件面接线后替换真源）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunRecord {
    pub workflow_id: String,
    pub run_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default = "default_trigger_kind")]
    pub trigger_kind: String,
    pub scheduled_for_ms: u64,
    pub started_at_ms: u64,
    #[serde(default)]
    pub finished_at_ms: Option<u64>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    pub status: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub output_summary: Option<String>,
}

fn default_trigger_kind() -> String {
    "cron".to_string()
}

/// 运行历史滚动淘汰策略（单工作流上限 20 条，全局上限 100 条；基于 started_at 降序保留最新记录，废除对 running 的盲目永久豁免）
pub fn prune_runs(mut runs: Vec<WorkflowRunRecord>) -> Vec<WorkflowRunRecord> {
    const PER_WORKFLOW_LIMIT: usize = 20;
    const GLOBAL_LIMIT: usize = 100;

    runs.sort_by_key(|r| std::cmp::Reverse(r.started_at_ms));

    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut kept = Vec::new();

    for run in runs {
        let count = counts.entry(run.workflow_id.clone()).or_insert(0);
        if *count < PER_WORKFLOW_LIMIT && kept.len() < GLOBAL_LIMIT {
            *count += 1;
            kept.push(run);
        }
    }

    kept
}

impl WorkflowRunRecord {
    pub fn view(&self) -> WorkflowRunView {
        WorkflowRunView {
            workflow_id: self.workflow_id.clone(),
            run_id: self.run_id.clone(),
            session_id: self.session_id.clone(),
            trigger_kind: self.trigger_kind.clone(),
            scheduled_for: epoch_ms_to_iso(self.scheduled_for_ms),
            started_at: epoch_ms_to_iso(self.started_at_ms),
            finished_at: self.finished_at_ms.map(epoch_ms_to_iso),
            duration_ms: self.duration_ms,
            status: self.status.clone(),
            prompt: self.prompt.clone(),
            error: self.error.clone(),
            output_summary: self.output_summary.clone(),
        }
    }
}

/// 命令输出：运行条目（对齐前端 WorkflowRunEntry 类型面）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunView {
    pub workflow_id: String,
    pub run_id: String,
    pub session_id: Option<String>,
    pub trigger_kind: String,
    pub scheduled_for: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub status: String,
    pub prompt: String,
    pub error: Option<String>,
    pub output_summary: Option<String>,
}
