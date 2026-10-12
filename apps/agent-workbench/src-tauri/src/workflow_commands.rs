//! workflow 命令面（T-CF-14，G9 命令面 / REQ-C03）：六条命令实装
//!
//! `create-workflow` / `list-workflows` / `update-workflow` / `delete-workflow` /
//! `trigger-workflow` / `list-workflow-runs` —— 消除前端 workflowRunner.ts 的
//! 幽灵声明（T03.7 恒不可用），改为真实 IPC。
//!
//! **后端委托契约**（02-CF 方案 §4.4 / T-CF-09，A5 已落盘 sched.rs）：
//! - 调度真源 = `SchedulerRegistry`（sched.rs）：注册 / 取消 / 恢复 /
//!   到期触发（steering 注入 + CronFired 事件）——本模块经委托槽
//!   [WorkflowBackend::registry] 对接（`CronTaskInput` 冻结入参形状）；
//! - 表达式校验与 next_fire 计算复用 T-CF-08 解析器
//!   `conex_types::cron::parse_cron`（真实 Rust 侧错误文案，
//!   前端「双重校验」的第二道就是它）；
//! - 持久化键 `sched_<cronId>`（session_meta 表，与 sched.rs 键形状同构）；
//! - steering 条目（group_id = `cron-<id>`）与触发文案按 §4.8 冻结模板
//!   （`<prompt>（cron <id> 第 N 次触发）`）。
//!
//! **委托边界**（A5 已落盘面 vs 命令层自有语义）：
//! - create → registry.register / delete → registry.cancel / list →
//!   registry.snapshot（A5 显式为 T-CF-14 预留）；30 方案 P6 装配收口
//!   后经 [WorkflowBackend::set_registry] 注入共享实例（main.rs 装配轮
//!   调用，消除队列双实例 + 注册表委托生产转正）；
//! - update / trigger / list-workflow-runs 无 registry 表面（A5 未暴露），
//!   由命令层元数据层承载：workflow 展示字段（name/cwd/mode/schedule/
//!   createdAt/updatedAt/lastRunAt）与运行历史（`sched_runs` 键）本层
//!   负责，`CronTask` 冻结字段不含它们（§4.4 形状所致）；
//! - trigger 的手动立即执行：registry 无「立即触发」API（sched.rs 仅
//!   按 next_fire_at 调度），命令层直接注入 steering 条目并计入元数据
//!   fired_count——偏差登记：注册表 CronTask.fired_count 在下一次自然
//!   触发前不含手动触发次数（列表展示以 snapshot 为真源时同源一致）。
//!
//! **daily / intervalMinutes 转 cron 的语义边界**（§8.4 开放问题 5）：
//! - daily → `M H * * *`（parse_cron 按本地时区固定偏移计算——对齐前端
//!   「每日固定时刻（本机时区）」语义）；
//! - intervalMinutes → `*/N * * * *` 是**近似语义**：cron 按整点对齐触发
//!   （:00/:30…），N 不整除 60 时与「每 N 分钟相对启动时刻」存在漂移。
//!
//! **运行历史边界**：list-workflow-runs 以命令层触发记录（`sched_runs` 键）
//! 近似，真源在引擎事件面（cron-fired / run 事件），R-CF3 事件面接线后切换；
//! trigger 的 runId / sessionId 由引擎触发路径（RunProducer / 续 run）产出，
//! 命令层立即触发仅注入 steering 面，暂返回空（不伪造 run 句柄）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use conex_db::LocalDb;
use conex_types::cron::parse_cron;
use orchestrator::steering_queue::SteeringInputEntry;
use orchestrator::PendingMessageQueue;
use serde::{Deserialize, Serialize};

use crate::core_error::CoreError;
use crate::sched::{CronTaskInput, CronTaskStatus, CronTaskUpdatePatch, SchedulerRegistry};

/// cron id 前缀（`cron-<seq>`，§4.4 冻结命名）
const CRON_ID_PREFIX: &str = "cron-";
/// 索引键（cronId 列表；conex-db 暂无 session_meta 键扫描 API，
/// 命令面自持索引保证 sched_<cronId> 可枚举；A5 若扩展列表 API 可切换）
const SESSION_META_INDEX_KEY: &str = "sched_index";
/// 运行历史键（`sched_runs`，命令层近似真源；事件面接线后替换）
const SESSION_META_RUNS_KEY: &str = "sched_runs";
/// 间隔分钟上限（对齐前端 WORKFLOW_INTERVAL_MINUTES_MAX = 60*24*7）
const INTERVAL_MINUTES_MAX: u64 = 60 * 24 * 7;

/// 当前 epoch 毫秒（workflow 全域时间基准）
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

// ── 调度 wire 形状（对齐前端 workflowScheduler.ts 类型面）──────────────

/// 调度配置 wire（serde tag=type；与前端 WorkflowSchedule 逐项对应）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum WorkflowScheduleWire {
    /// 手动（仅触发执行，无自动调度）
    Manual,
    /// 每日固定时刻（`M H * * *`；本地时区语义由 parse_cron 承载）
    Daily {
        /// HH:mm（00:00–23:59）
        time: String,
        /// IANA 时区名（命令层展示用；调度语义按本地时区）
        timezone: String,
    },
    /// 间隔分钟（`*/N * * * *` 近似语义，N 不整除 60 时漂移）
    IntervalMinutes {
        /// 间隔分钟（1–10080）
        interval_minutes: u64,
    },
    /// 5 字段标准 cron（前端双重校验通过后原样下发）
    Cron {
        /// cron 表达式原文
        expression: String,
    },
}

impl WorkflowScheduleWire {
    /// 从命令入参 JSON 解析（未知类型返回中文错误，不让 serde 英文文案裸奔）
    fn parse(value: &serde_json::Value) -> Result<Self, String> {
        let obj = value
            .as_object()
            .ok_or_else(|| "调度配置无效".to_string())?;
        let t = obj
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        match t.as_str() {
            "" | "manual" => Ok(Self::Manual),
            "daily" => {
                let time = obj
                    .get("time")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !is_valid_daily_time(&time) {
                    return Err("每日时刻须为 HH:mm（00:00–23:59）".to_string());
                }
                let timezone = obj
                    .get("timezone")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if timezone.is_empty() {
                    return Err("时区不能为空，请使用 IANA 名称（如 Asia/Shanghai）".to_string());
                }
                Ok(Self::Daily { time, timezone })
            }
            "intervalMinutes" => {
                let raw = obj
                    .get("intervalMinutes")
                    .or_else(|| obj.get("minutes"))
                    .and_then(|v| v.as_u64());
                match raw {
                    Some(n) if n >= 1 && n <= INTERVAL_MINUTES_MAX => Ok(Self::IntervalMinutes {
                        interval_minutes: n,
                    }),
                    _ => Err(format!("间隔分钟须为 1–{} 的整数", INTERVAL_MINUTES_MAX)),
                }
            }
            "cron" => {
                let expression = obj
                    .get("expression")
                    .or_else(|| obj.get("cron"))
                    .or_else(|| obj.get("cronExpression"))
                    .or_else(|| obj.get("expr"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let normalized = validate_cron_expression(&expression)?;
                Ok(Self::Cron {
                    expression: normalized,
                })
            }
            "weekly" | "fileWatch" | "onFileChange" => Err(format!(
                "引擎暂不支持「{}」调度，请改用「每天」或「间隔分钟」",
                t
            )),
            _ => Err(format!("不支持的调度类型：{}", t)),
        }
    }
}

/// 每日时刻 HH:mm 合法性（00:00–23:59，对齐前端 isValidDailyTime）
fn is_valid_daily_time(value: &str) -> bool {
    let t = value.trim();
    if t.is_empty() {
        return false;
    }
    let mut parts = t.split(':');
    let (h, m) = match (parts.next(), parts.next(), parts.next()) {
        (Some(h), Some(m), None) => (h, m),
        _ => return false,
    };
    if !(h.len() == 2
        && m.len() == 2
        && h.chars().all(|c| c.is_ascii_digit())
        && m.chars().all(|c| c.is_ascii_digit()))
    {
        return false;
    }
    let hh: u32 = h.parse().unwrap_or(100);
    let mm: u32 = m.parse().unwrap_or(100);
    hh <= 23 && mm <= 59
}

/// 调度 → cron 表达式（manual 返回 None；边界语义见模块头注记）。
/// 时刻字段做数值归一（"09:30" → "30 9 * * *"，不保留零填充）
fn schedule_to_expression(schedule: &WorkflowScheduleWire) -> Option<String> {
    match schedule {
        WorkflowScheduleWire::Manual => None,
        WorkflowScheduleWire::Daily { time, .. } => {
            let (h, m) = time.split_once(':').unwrap_or(("0", "0"));
            let hh: u32 = h.parse().unwrap_or(0);
            let mm: u32 = m.parse().unwrap_or(0);
            Some(format!("{mm} {hh} * * *"))
        }
        WorkflowScheduleWire::IntervalMinutes { interval_minutes } => {
            Some(format!("*/{} * * * *", interval_minutes))
        }
        WorkflowScheduleWire::Cron { expression } => Some(expression.clone()),
    }
}

// ── cron 校验与 next_fire（委托 T-CF-08 解析器，真实 Rust 侧文案）──────

/// 校验 5 字段 cron 表达式（委托 `conex_types::cron::parse_cron`）。
///
/// 通过返回空白压缩的规范化表达式；失败返回**解析器真实中文错误文案**
/// （前端双重校验的第二道；T-CF-14 内容 4）。
fn validate_cron_expression(expr: &str) -> Result<String, String> {
    let normalized = expr.split_whitespace().collect::<Vec<_>>().join(" ");
    parse_cron(&normalized).map_err(|e| e.to_string())?;
    Ok(normalized)
}

/// 下一次触发时刻（委托 `CronSchedule::next_fire_after`，本地时区固定偏移；
/// 无未来命中时刻返回 None——如 2 月 30 日类表达式）
fn next_fire_after_ms(expression: &str, after_ms: u64) -> Option<u64> {
    parse_cron(expression).ok()?.next_fire_after(after_ms)
}

// ── 时间展示（ISO-8601 UTC；next_fire 为本地时刻，展示做 UTC 归一）──────

/// 从 epoch 天数求公历（年/月/日），Hinnant 逆算法
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// epoch 毫秒 → ISO-8601 UTC（`YYYY-MM-DDTHH:MM:SS.mmmZ`；前端 Date.parse 可直接解析）
fn epoch_ms_to_iso(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        mo,
        d,
        h,
        m,
        s,
        ms % 1000
    )
}

// ── 持久化（session_meta `sched_*` 键；§4.4 冻结形状）────────────────

/// workflow 存储条目（sched_<cronId> 键 JSON 形状）
///
/// 前八字段与 §4.4 `CronTask` 冻结字段逐项对齐（camelCase），sched.rs
/// 恢复扫描按同键同形解析；扩展字段为本命令面所需（workflow 名称 /
/// 目录 / 运行时刻 / 调度原形）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredWorkflow {
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
    pub(crate) fn view(&self) -> WorkflowView {
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
        }
    }
}

/// 命令输出：workflow 条目（对齐前端 WorkflowDefinition 类型面）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowView {
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
}

/// 运行记录（`sched_runs` 键条目；触发时登记，事件面接线后替换真源）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowRunRecord {
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
pub(crate) fn prune_runs(mut runs: Vec<WorkflowRunRecord>) -> Vec<WorkflowRunRecord> {
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
    pub(crate) fn view(&self) -> WorkflowRunView {
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
pub(crate) struct WorkflowRunView {
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

// ── 存储适配（sched_* 键读写；重启恢复数据源）───────────────────────

/// workflow 持久化适配（conex-db session_meta `sched_*` 键）
pub(crate) trait WorkflowStore: Send + Sync {
    /// 读取全部 workflow 声明
    fn load_all(&self) -> Vec<StoredWorkflow>;
    /// 保存声明（幂等 upsert；cronId 冲突即覆盖）
    fn save(&self, workflow: &StoredWorkflow);
    /// 删除声明（不存在静默成功）
    fn remove(&self, cron_id: &str);
    /// 读取运行历史
    fn load_runs(&self) -> Vec<WorkflowRunRecord>;
    /// 保存运行历史（全量覆盖；当前条目量小，全量读写足够）
    fn save_runs(&self, runs: &[WorkflowRunRecord]);

    /// 追加或更新单条运行记录（自动滚动淘汰）
    fn append_or_update_run(&self, record: WorkflowRunRecord) {
        let mut runs = self.load_runs();
        if let Some(pos) = runs
            .iter()
            .position(|r| r.workflow_id == record.workflow_id && r.run_id == record.run_id)
        {
            runs[pos] = record;
        } else {
            runs.push(record);
        }
        let pruned = prune_runs(runs);
        self.save_runs(&pruned);
    }

    /// 标记单条运行记录完成/终态（Upsert 语义：未找到已有记录时原地创建终态记录，杜绝静默丢失）
    fn update_run_finish(
        &self,
        workflow_id: &str,
        run_id: &str,
        status: &str,
        finished_at_ms: u64,
        duration_ms: u64,
        error: Option<String>,
        output_summary: Option<String>,
    ) {
        let mut runs = self.load_runs();
        if let Some(run) = runs
            .iter_mut()
            .find(|r| r.workflow_id == workflow_id && r.run_id == run_id)
        {
            run.status = status.to_string();
            run.finished_at_ms = Some(finished_at_ms);
            run.duration_ms = Some(duration_ms);
            run.error = error;
            run.output_summary = output_summary;
        } else {
            let started_at_ms = finished_at_ms.saturating_sub(duration_ms);
            runs.push(WorkflowRunRecord {
                workflow_id: workflow_id.to_string(),
                run_id: run_id.to_string(),
                session_id: None,
                trigger_kind: "cron".to_string(),
                scheduled_for_ms: started_at_ms,
                started_at_ms,
                finished_at_ms: Some(finished_at_ms),
                duration_ms: Some(duration_ms),
                status: status.to_string(),
                prompt: String::new(),
                error,
                output_summary,
            });
        }
        let pruned = prune_runs(runs);
        self.save_runs(&pruned);
    }

    /// 孤儿运行收割：扫描所有运行记录，将处于在途态的孤儿记录自动收割为 interrupted 并持久化
    fn reap_orphan_running_runs(&self) -> usize {
        let mut runs = self.load_runs();
        let mut reaped_count = 0;
        for run in &mut runs {
            if matches!(
                run.status.as_str(),
                "running" | "queued" | "pending" | "in_progress" | "accepted" | "started"
            ) {
                run.status = "interrupted".to_string();
                run.duration_ms = None;
                run.error = Some("应用重启或异常终止，历史在途记录已被系统自愈收割".to_string());
                reaped_count += 1;
            }
        }
        if reaped_count > 0 {
            let pruned = prune_runs(runs);
            self.save_runs(&pruned);
        }
        reaped_count
    }
}

/// session_meta 真适配（LocalDb `sched_<cronId>` 键 + `sched_index` 索引 +
/// `sched_runs` 键）。
///
/// 注：conex-db 当前仅有 get/set_session_meta（无键扫描 / 删除 API），
/// 故以 `sched_index` 索引键承载可枚举性；删除仅摘索引（孤儿键残留在
/// 表内但不可见）。A5 若为 SchedulerRegistry 扩展 conex-db 键扫描 API，
/// 本适配可切换为原生扫描（键形状 sched_<cronId> 已冻结）。
#[derive(Clone)]
pub(crate) struct SessionMetaWorkflowStore {
    db: LocalDb,
}

impl SessionMetaWorkflowStore {
    pub(crate) fn new(db: LocalDb) -> Self {
        Self { db }
    }
}

/// 对读取到的 StoredWorkflow 执行启发式自愈（Heuristic Rehydration）：
/// 若 schedule 为 Manual 但 expression 为有效 5 字段 cron，自愈为 WorkflowScheduleWire::Cron 并返回 true 表示发生自愈
fn heuristic_rehydrate_workflow(wf: &mut StoredWorkflow) -> bool {
    if wf.schedule == WorkflowScheduleWire::Manual && !wf.expression.trim().is_empty() {
        if let Ok(normalized) = validate_cron_expression(&wf.expression) {
            tracing::info!(
                target: "workflow",
                cron_id = %wf.cron_id,
                expression = %normalized,
                "历史任务调度配置启发式自愈：Manual -> Cron"
            );
            wf.schedule = WorkflowScheduleWire::Cron {
                expression: normalized,
            };
            return true;
        }
    }
    false
}

impl WorkflowStore for SessionMetaWorkflowStore {
    fn load_all(&self) -> Vec<StoredWorkflow> {
        let mut index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();

        // 统一索引真源：兼容合并存量历史索引数据（sched_ids）
        if let Some(legacy_raw) = self.db.get_session_meta("sched_ids").ok().flatten() {
            if let Ok(legacy_ids) = serde_json::from_str::<Vec<String>>(&legacy_raw) {
                let mut appended = false;
                for id in legacy_ids {
                    if !index.contains(&id) {
                        index.push(id);
                        appended = true;
                    }
                }
                if appended {
                    if let Ok(json) = serde_json::to_string(&index) {
                        let _ = self.db.set_session_meta(SESSION_META_INDEX_KEY, &json);
                    }
                }
            }
        }

        let mut results = Vec::new();
        for cron_id in index {
            if let Some(raw) = self.db.get_session_meta(&store_key(&cron_id)).ok().flatten() {
                if let Ok(mut wf) = serde_json::from_str::<StoredWorkflow>(&raw) {
                    if heuristic_rehydrate_workflow(&mut wf) {
                        // 自愈后立即持久化回写，杜绝未来降级丢失
                        self.save(&wf);
                    }
                    results.push(wf);
                }
            }
        }
        results
    }

    fn save(&self, workflow: &StoredWorkflow) {
        let key = store_key(&workflow.cron_id);
        // Safe Field Merge: 读取已有 session_meta JSON 进行安全增量合并，
        // 保证调度字段与扩展业务字段双向互不冲刷覆盖
        let mut base_val = self
            .db
            .get_session_meta(&key)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .unwrap_or_else(|| serde_json::json!({}));

        if let Ok(new_val) = serde_json::to_value(workflow) {
            if let (Some(base_map), Some(new_map)) = (base_val.as_object_mut(), new_val.as_object()) {
                for (k, v) in new_map {
                    base_map.insert(k.clone(), v.clone());
                }
            } else {
                base_val = new_val;
            }
            if let Ok(merged_json) = serde_json::to_string(&base_val) {
                let _ = self.db.set_session_meta(&key, &merged_json);
            }
        }

        // 索引追加到唯一真源 sched_index（已存在则不动，保持创建顺序稳定）
        let mut index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        if !index.iter().any(|id| id == &workflow.cron_id) {
            index.push(workflow.cron_id.clone());
            if let Ok(json) = serde_json::to_string(&index) {
                let _ = self.db.set_session_meta(SESSION_META_INDEX_KEY, &json);
            }
        }
    }

    fn remove(&self, cron_id: &str) {
        // 摘索引（键值残留在表内，不可见；见结构体注记）
        if let Some(json) = self
            .db
            .get_session_meta(SESSION_META_INDEX_KEY)
            .ok()
            .flatten()
        {
            if let Ok(mut index) = serde_json::from_str::<Vec<String>>(&json) {
                index.retain(|id| id != cron_id);
                if let Ok(out) = serde_json::to_string(&index) {
                    let _ = self.db.set_session_meta(SESSION_META_INDEX_KEY, &out);
                }
            }
        }
    }

    fn load_runs(&self) -> Vec<WorkflowRunRecord> {
        self.db
            .get_session_meta(SESSION_META_RUNS_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    fn save_runs(&self, runs: &[WorkflowRunRecord]) {
        if let Ok(json) = serde_json::to_string(runs) {
            let _ = self.db.set_session_meta(SESSION_META_RUNS_KEY, &json);
        }
    }
}

/// 内存适配（测试专用；生产走 SessionMetaWorkflowStore）
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Default)]
pub(crate) struct MemoryWorkflowStore {
    map: Mutex<Vec<(String, StoredWorkflow)>>,
    runs: Mutex<Vec<WorkflowRunRecord>>,
}

impl WorkflowStore for MemoryWorkflowStore {
    fn load_all(&self) -> Vec<StoredWorkflow> {
        let mut list: Vec<StoredWorkflow> = self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(_, w)| w.clone())
            .collect();
        let mut rehydrated = Vec::new();
        for wf in &mut list {
            if heuristic_rehydrate_workflow(wf) {
                rehydrated.push(wf.clone());
            }
        }
        if !rehydrated.is_empty() {
            let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
            for h in rehydrated {
                if let Some((_, slot)) = map.iter_mut().find(|(id, _)| id == &h.cron_id) {
                    *slot = h;
                }
            }
        }
        list
    }

    fn save(&self, workflow: &StoredWorkflow) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        match map.iter_mut().find(|(id, _)| id == &workflow.cron_id) {
            Some((_, slot)) => {
                // 内存版 Safe Field Merge：以 JSON Value 合并模拟无损覆盖
                if let (Ok(old_val), Ok(new_val)) = (
                    serde_json::to_value(&*slot),
                    serde_json::to_value(workflow),
                ) {
                    if let (Some(mut base_map), Some(new_map)) = (old_val.as_object().cloned(), new_val.as_object()) {
                        for (k, v) in new_map {
                            base_map.insert(k.clone(), v.clone());
                        }
                        if let Ok(merged) = serde_json::from_value::<StoredWorkflow>(serde_json::Value::Object(base_map)) {
                            *slot = merged;
                            return;
                        }
                    }
                }
                *slot = workflow.clone();
            }
            None => map.push((workflow.cron_id.clone(), workflow.clone())),
        }
    }

    fn remove(&self, cron_id: &str) {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(id, _)| id != cron_id);
    }

    fn load_runs(&self) -> Vec<WorkflowRunRecord> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn save_runs(&self, runs: &[WorkflowRunRecord]) {
        *self.runs.lock().unwrap_or_else(|e| e.into_inner()) = runs.to_vec();
    }
}

/// 持久化键（`sched_` 前缀 + cronId）
fn store_key(cron_id: &str) -> String {
    format!("sched_{cron_id}")
}

// ── steering 落点（§4.7：唤醒走 steering 面而非事件面）────────────────

/// steering 条目落点（PendingMessageQueue 适配；触发 / 立即执行共用）
pub(crate) trait SteeringSink: Send + Sync {
    /// 写入一条 steering 条目（group_id = cron-<cronId>，replaceOrEnqueue 去重）
    fn enqueue_steering(&self, cron_id: &str, text: String, enqueued_at_ms: u64);
}

/// PendingMessageQueue 适配（与 sched.rs QueuePendingSink 同构）
#[derive(Clone)]
pub(crate) struct QueueSteeringSink {
    queue: Arc<Mutex<PendingMessageQueue>>,
}

impl QueueSteeringSink {
    pub(crate) fn new(queue: Arc<Mutex<PendingMessageQueue>>) -> Self {
        Self { queue }
    }
}

impl SteeringSink for QueueSteeringSink {
    fn enqueue_steering(&self, cron_id: &str, text: String, enqueued_at_ms: u64) {
        let entry = SteeringInputEntry {
            session_id: format!("sched-{cron_id}"),
            id: format!("{cron_id}-{enqueued_at_ms}"),
            text,
            attachments: Vec::new(),
            enqueued_at: enqueued_at_ms,
            group_id: Some(format!("{CRON_ID_PREFIX}{cron_id}")),
            is_steering: true,
        };
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        queue.replace_or_enqueue(entry);
    }
}

// ── 命令状态与后端（命令面唯一接线点；注册表委托在此注入）──────────

/// Tauri 托管状态：workflow 命令后端
pub(crate) struct WorkflowCommandState {
    backend: Arc<WorkflowBackend>,
}

impl WorkflowCommandState {
    /// 新建（setup 装配：session_meta 真存储 + 引擎共享 steering 队列——
    /// 30 方案 P6：队列与 [crate::core_run_commands::CoreRunState] 的
    /// pending_queue 同一 Arc 实例，消除 A5-H01a 队列双实例——触发注入
    /// 落真实队列，idle 续 run 消费唤醒；注册表委托槽初始为空，经
    /// [WorkflowBackend::set_registry] 注入共享实例，见模块头「委托边界」）
    pub(crate) fn new(db: LocalDb, steering_queue: Arc<Mutex<PendingMessageQueue>>) -> Self {
        Self {
            backend: Arc::new(WorkflowBackend::new(
                Arc::new(SessionMetaWorkflowStore::new(db)),
                Arc::new(QueueSteeringSink::new(steering_queue)),
            )),
        }
    }

    /// 注入 SchedulerRegistry 委托（30 方案 P6 装配收口唯一入口；
    /// 透传 [WorkflowBackend::set_registry]——main.rs 装配轮调用）
    pub(crate) fn set_registry(&self, registry: Arc<SchedulerRegistry>) {
        self.backend.set_registry(registry);
    }

    /// 后端句柄（生产面：create_workflow 工具通道延迟绑定（main.rs 装配轮
    /// 取走注入引擎侧 [WorkflowCreationChannelBinding]，绑定前工具返回
    /// common.unsupported）；测试访问：装配轮集成断言）
    pub(crate) fn backend_handle(&self) -> Arc<WorkflowBackend> {
        Arc::clone(&self.backend)
    }

    /// 后端句柄（测试与集成访问别名）
    #[cfg(test)]
    pub(crate) fn backend(&self) -> Arc<WorkflowBackend> {
        self.backend_handle()
    }
}

// ── create_workflow 工具通道（维度五 / 05 详案 §2.4 路径 A 生产接线）────

/// 工具通道绑定载荷：backend（唯一注册链路真源）+ AppHandle（成功落盘后
/// 广播 `workflow:created` 全域事件——与 IPC 命令路径共用同一发射 helper）
struct BoundWorkflowBackend {
    backend: Arc<WorkflowBackend>,
    app: tauri::AppHandle,
}

/// create_workflow 工具通道延迟绑定适配器（对齐 ContinuityChannelBoard
/// 延迟绑定范式：引擎装配（engine_build）早于 workflow 后端创建（main.rs
/// setup ⑧c），装配期注入空绑定占位——工具返回 common.unsupported；
/// main.rs 在 `WorkflowCommandState::new` 之后调用 [Self::bind] 完成生产转正）
///
/// 注册链路 SSOT：`create` 复用既有 `create-workflow` IPC 的同一校验链
/// （[WorkflowScheduleWire::parse] → [WorkflowBackend::create]），**禁止**
/// 平行实现第二套校验 / 注册逻辑（05 详案 §2.4 接线注记）。
pub(crate) struct WorkflowCreationChannelBinding {
    inner: std::sync::Mutex<Option<BoundWorkflowBackend>>,
}

impl std::fmt::Debug for WorkflowCreationChannelBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 绑定内含 AppHandle / WorkflowBackend，均非稳定调试面——只披露绑定状态
        let bound = self.inner.lock().map(|g| g.is_some()).unwrap_or(false);
        f.debug_struct("WorkflowCreationChannelBinding")
            .field("bound", &bound)
            .finish()
    }
}

impl WorkflowCreationChannelBinding {
    /// 装配期构造（未绑定；engine_build.rs 经 BuiltinToolConfig 注入）
    pub(crate) fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(None),
        }
    }

    /// 生产绑定（main.rs setup：workflow_state 创建后取 backend + AppHandle）
    pub(crate) fn bind(&self, backend: Arc<WorkflowBackend>, app: tauri::AppHandle) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(BoundWorkflowBackend { backend, app });
    }
}

impl Default for WorkflowCreationChannelBinding {
    fn default() -> Self {
        Self::new()
    }
}

/// 工具入参 → `create-workflow` 同源 wire 调度 JSON（经
/// [WorkflowScheduleWire::parse] 复用既有校验链；timezone 仅展示语义——
/// 工具未提供时落 "local" 占位，前端列表按 IANA 校验失败回退本机时区展示，
/// 调度真源始终按本机时区计算）
fn workflow_schedule_wire_json(input: &agent_tools::WorkflowCreateInput) -> serde_json::Value {
    match input.schedule_type.as_str() {
        "daily" => serde_json::json!({
            "type": "daily",
            "time": input.daily_time.clone().unwrap_or_default(),
            "timezone": "local",
        }),
        "intervalMinutes" => serde_json::json!({
            "type": "intervalMinutes",
            "intervalMinutes": input.interval_minutes.unwrap_or_default(),
        }),
        "cron" => serde_json::json!({
            "type": "cron",
            "expression": input.cron_expression.clone().unwrap_or_default(),
        }),
        // manual 为缺省调度类型（与工具 schema 缺省一致）
        _ => serde_json::json!({ "type": "manual" }),
    }
}

#[async_trait::async_trait]
impl agent_tools::WorkflowCreationChannel for WorkflowCreationChannelBinding {
    async fn create(
        &self,
        input: agent_tools::WorkflowCreateInput,
    ) -> Result<agent_tools::WorkflowCreateOutput, agent_tools::WorkflowCreateError> {
        let bound = {
            let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_ref() {
                Some(b) => BoundWorkflowBackend {
                    backend: Arc::clone(&b.backend),
                    app: b.app.clone(),
                },
                None => return Err(agent_tools::WorkflowCreateError::Unsupported),
            }
        };

        let schedule_value = workflow_schedule_wire_json(&input);
        let schedule = WorkflowScheduleWire::parse(&schedule_value)
            .map_err(agent_tools::WorkflowCreateError::InvalidInput)?;

        let view = bound
            .backend
            .create(
                input.name,
                input.prompt,
                schedule,
                input.cwd,
                None,
                input.enabled.unwrap_or(true),
            )
            .await
            .map_err(|e: CoreError| {
                agent_tools::WorkflowCreateError::InvalidInput(e.to_string())
            })?;

        // 全域状态广播（05 详案 §2.5）：工具路径与 IPC 命令路径共用同一
        // 发射 helper，前端 useWorkflowsState 监听后刷新列表
        emit_workflow_event(
            &bound.app,
            "workflow:created",
            serde_json::json!({
                "workflowId": view.id,
                "name": view.name,
                "nextRunAt": view.next_run_at,
            }),
        );

        Ok(agent_tools::WorkflowCreateOutput {
            workflow_id: view.id,
            name: view.name,
            next_run_at: view.next_run_at,
        })
    }
}

/// workflow 全域事件发射 helper（唯一发射面：IPC 命令路径与工具通道路径
/// 共用；发射失败仅留痕不阻断注册主流程——事件是通知面，不是落盘面）
pub(crate) fn emit_workflow_event(app: &tauri::AppHandle, event: &str, payload: serde_json::Value) {
    use tauri::Emitter;
    if let Err(e) = app.emit(event, payload) {
        tracing::warn!(target: "workflow", "workflow 事件发射失败（{event}）：{e}");
    }
}

/// workflow 命令后端（store 即元数据真源：每次操作以 sched_* 键读写，
/// 重启无损；seq 自数据推导，重启不撞号；调度真源 = 委托注册表）
pub(crate) struct WorkflowBackend {
    store: Arc<dyn WorkflowStore>,
    sink: Arc<dyn SteeringSink>,
    /// SchedulerRegistry 委托槽（A3 装配收口注入；None = 命令层独立
    /// 承载调度语义——注册/取消/列表退化为元数据操作）
    registry: Mutex<Option<Arc<SchedulerRegistry>>>,
    seq: AtomicU64,
}

impl WorkflowBackend {
    /// 新建后端（适配器由装配方注入；seq 初始为数据内最大序号 +1；启动即收割在途孤儿记录）
    pub(crate) fn new(store: Arc<dyn WorkflowStore>, sink: Arc<dyn SteeringSink>) -> Self {
        let seq = store
            .load_all()
            .iter()
            .filter_map(|w| cron_seq(&w.cron_id))
            .max()
            .map(|n| n + 1)
            .unwrap_or(0);
        let backend = Self {
            store,
            sink,
            registry: Mutex::new(None),
            seq: AtomicU64::new(seq),
        };
        backend.reap_orphan_running_runs();
        backend
    }

    /// 孤儿运行收割（主进程冷启动与测试点直接代理）
    pub(crate) fn reap_orphan_running_runs(&self) -> usize {
        self.store.reap_orphan_running_runs()
    }

    /// 注入 SchedulerRegistry 委托（装配收口唯一入口；重复注入覆盖）。
    /// 生产装配点 = main.rs 装配轮（P6）：core_state.scheduler_registry()
    /// 经本方法注入共享注册表——create 即真实注册调度，不再命令层退化。
    pub(crate) fn set_registry(&self, registry: Arc<SchedulerRegistry>) {
        *self.registry.lock().unwrap_or_else(|e| e.into_inner()) = Some(registry);
    }

    /// 委托注册表当前句柄
    fn registry(&self) -> Option<Arc<SchedulerRegistry>> {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 创建 workflow（名称/提示词/调度三校验 → 表达式转换 → 落库；
    /// 委托激活时经注册表 register 校验并接入真实调度——注册表 API 为
    /// async，本方法及 update/delete 一并 async（命令体直调，不包
    /// spawn_blocking：store 为轻量 KV 写，少量语句可接受））
    pub(crate) async fn create(
        &self,
        name: String,
        prompt: String,
        schedule: WorkflowScheduleWire,
        cwd: Option<String>,
        mode: Option<String>,
        enabled: bool,
    ) -> Result<WorkflowView, CoreError> {
        let name = name.trim().to_string();
        let prompt = prompt.trim().to_string();
        if name.is_empty() {
            return Err(CoreError::InvalidInput("名称不能为空".to_string()));
        }
        if prompt.is_empty() {
            return Err(CoreError::InvalidInput("提示词不能为空".to_string()));
        }
        let expression = schedule_to_expression(&schedule).unwrap_or_default();
        // 委托激活：注册表 register 承担解析校验 + next_fire 计算（真实
        // parse_cron 文案；无未来命中时刻同样拒绝——T-CF-09 语义）
        if let Some(registry) = self.registry() {
            if !expression.is_empty() {
                let input = CronTaskInput {
                    expression: expression.clone(),
                    prompt: prompt.clone(),
                    max_iterations: None,
                    is_daemon: false,
                };
                let cron_id = registry.register(input).await.map_err(map_scheduler_err)?;
                if !enabled {
                    if let Err(e) = registry.pause_task(&cron_id).await {
                        tracing::warn!(target: "workflow", %cron_id, "创建未启用任务时初始暂停失败: {e:?}");
                    }
                }
                // manual（无表达式）不经注册表：命令层独立 id 分配
                let now = now_ms();
                let next_fire_at_ms = next_fire_after_ms(&expression, now).unwrap_or(0);
                let workflow = StoredWorkflow {
                    cron_id,
                    expression,
                    prompt,
                    max_iterations: None,
                    is_daemon: false,
                    next_fire_at_ms,
                    fired_count: 0,
                    status: if enabled {
                        CronTaskStatus::Active
                    } else {
                        CronTaskStatus::Paused
                    },
                    enabled,
                    name,
                    cwd: cwd.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
                    mode: mode.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()),
                    schedule,
                    target_session_id: None,
                    execution_mode: None,
                    created_at_ms: now,
                    updated_at_ms: now,
                    last_run_at_ms: None,
                };
                self.store.save(&workflow);
                tracing::info!(
                    target: "workflow",
                    cron_id = %workflow.cron_id,
                    expression = %workflow.expression,
                    "workflow 已创建（委托注册表）"
                );
                return Ok(workflow.view());
            }
        }
        // 独立路径（委托未激活 或 manual）：本地校验 + 本地 next_fire 估算；
        // 无未来命中时刻（2 月 30 日类）→ 拒绝注册（对齐注册表 NoNextFire 语义）
        if !expression.is_empty() {
            validate_cron_expression(&expression).map_err(CoreError::InvalidInput)?;
        }
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let cron_id = format!("{CRON_ID_PREFIX}{seq}");
        let now = now_ms();
        let next_fire_at_ms = if expression.is_empty() {
            0
        } else {
            next_fire_after_ms(&expression, now).ok_or_else(|| {
                CoreError::InvalidInput(format!(
                    "cron 表达式 {expression} 无未来触发时刻（如 2 月 30 日），拒绝注册"
                ))
            })?
        };
        let workflow = StoredWorkflow {
            cron_id,
            expression,
            prompt,
            max_iterations: None,
            is_daemon: false,
            next_fire_at_ms,
            fired_count: 0,
            status: if enabled {
                CronTaskStatus::Active
            } else {
                CronTaskStatus::Paused
            },
            enabled,
            name,
            cwd: cwd.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
            mode: mode.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()),
            schedule,
            target_session_id: None,
            execution_mode: None,
            created_at_ms: now,
            updated_at_ms: now,
            last_run_at_ms: None,
        };
        self.store.save(&workflow);
        tracing::info!(
            target: "workflow",
            cron_id = %workflow.cron_id,
            expression = %workflow.expression,
            "workflow 已创建"
        );
        Ok(workflow.view())
    }

    /// 列出全部 workflow（按创建时间升序，稳定展示；委托激活时以
    /// 注册表 snapshot 为准刷新运行态字段，彻底杜绝冲刷覆盖 DB 启用状态）
    pub(crate) fn list(&self) -> Vec<WorkflowView> {
        let mut all = self.store.load_all();
        // 委托激活：snapshot（CronTask）刷新 fired_count / next_fire_at（注册表为调度真源）
        // 彻底删除 workflow.enabled = task.enabled 脏冲刷！仅在 workflow.enabled 为 true 时同步 task.next_fire_at_ms
        if let Some(registry) = self.registry() {
            let snapshot = registry.snapshot();
            for workflow in &mut all {
                if let Some(task) = snapshot.iter().find(|t| t.cron_id == workflow.cron_id) {
                    workflow.fired_count = task.fired_count;
                    if workflow.enabled {
                        workflow.next_fire_at_ms = task.next_fire_at_ms;
                    }
                }
            }
        }
        all.sort_by_key(|w| w.created_at_ms);
        all.iter().map(|w| w.view()).collect()
    }

    /// 更新 workflow（部分字段补丁；调度变化 → 重算表达式与 next_fire；
    /// 原地热更新保持 cron_id 与 created_at_ms 恒定不变；启停联动底座 pause/resume）
    pub(crate) async fn update(
        &self,
        cron_id: &str,
        patch: WorkflowPatch,
    ) -> Result<WorkflowView, CoreError> {
        let all = self.store.load_all();
        let Some(mut workflow) = all.into_iter().find(|w| w.cron_id == cron_id) else {
            return Err(CoreError::NotFound(format!("workflow {cron_id} 不存在")));
        };
        if let Some(name) = patch.name {
            let name = name.trim().to_string();
            if name.is_empty() {
                return Err(CoreError::InvalidInput("名称不能为空".to_string()));
            }
            workflow.name = name;
        }
        let prompt_changed = if let Some(prompt) = patch.prompt {
            let prompt = prompt.trim().to_string();
            if prompt.is_empty() {
                return Err(CoreError::InvalidInput("提示词不能为空".to_string()));
            }
            let changed = prompt != workflow.prompt;
            workflow.prompt = prompt;
            changed
        } else {
            false
        };
        if let Some(cwd) = patch.cwd {
            let cwd = cwd.trim().to_string();
            workflow.cwd = if cwd.is_empty() { None } else { Some(cwd) };
        }
        if let Some(mode) = patch.mode {
            let mode = mode.trim().to_string();
            workflow.mode = if mode.is_empty() { None } else { Some(mode) };
        }
        if let Some(target_sid) = patch.target_session_id.as_ref() {
            let target_sid = target_sid.trim().to_string();
            workflow.target_session_id = if target_sid.is_empty() {
                None
            } else {
                Some(target_sid)
            };
        }
        if let Some(exec_mode) = patch.execution_mode.as_ref() {
            let exec_mode = exec_mode.trim().to_string();
            workflow.execution_mode = if exec_mode.is_empty() {
                None
            } else {
                Some(exec_mode)
            };
        }

        let enabled_changed = patch.enabled.is_some() && patch.enabled != Some(workflow.enabled);
        let target_enabled = patch.enabled.unwrap_or(workflow.enabled);

        let schedule_changed = patch.schedule.is_some();
        if let Some(schedule) = patch.schedule {
            let expression = schedule_to_expression(&schedule).unwrap_or_default();
            if !expression.is_empty() {
                validate_cron_expression(&expression).map_err(CoreError::InvalidInput)?;
            }
            workflow.schedule = schedule;
            workflow.expression = expression;
            workflow.next_fire_at_ms = if workflow.expression.is_empty() {
                0
            } else {
                next_fire_after_ms(&workflow.expression, now_ms()).ok_or_else(|| {
                    CoreError::InvalidInput(format!(
                        "cron 表达式 {} 无未来触发时刻（如 2 月 30 日），拒绝更新",
                        workflow.expression
                    ))
                })?
            };
        }

        // 委托注册表热更新与启停联动（保持 cron_id 与 created_at_ms 恒定不变）
        if let Some(registry) = self.registry() {
            let in_registry = registry.snapshot().iter().any(|t| t.cron_id == cron_id);
            if in_registry {
                // 1. 若要暂停且发生状态变化，先调用 pause_task
                if enabled_changed && !target_enabled {
                    registry.pause_task(cron_id).await?;
                }

                // 2. 调度表达式或提示词等原地热更新
                if (schedule_changed || prompt_changed || patch.target_session_id.is_some())
                    && !workflow.expression.is_empty()
                {
                    let task_patch = CronTaskUpdatePatch {
                        expression: if schedule_changed {
                            Some(workflow.expression.clone())
                        } else {
                            None
                        },
                        prompt: if prompt_changed {
                            Some(workflow.prompt.clone())
                        } else {
                            None
                        },
                        max_iterations: None,
                        is_daemon: None,
                        target_session_id: patch.target_session_id.clone().map(Some),
                    };
                    registry.update_task(cron_id, task_patch).await?;
                } else if schedule_changed && workflow.expression.is_empty() {
                    // 转为 manual：从注册表中取消调度协程
                    let _ = registry.cancel(cron_id).await;
                }

                // 3. 若要启用且发生状态变化，执行恢复
                if enabled_changed && target_enabled {
                    registry.resume_task(cron_id).await?;
                }

                // 同步注册表运行态中的 next_fire_at_ms
                if let Some(task) = registry.snapshot().iter().find(|t| t.cron_id == cron_id) {
                    if target_enabled {
                        workflow.next_fire_at_ms = task.next_fire_at_ms;
                    }
                }
            }
        }

        workflow.enabled = target_enabled;
        workflow.status = if target_enabled {
            CronTaskStatus::Active
        } else {
            CronTaskStatus::Paused
        };
        workflow.updated_at_ms = now_ms();
        self.store.save(&workflow);
        Ok(workflow.view())
    }

    /// 删除 workflow（委托激活时经注册表 cancel 停调度；清单移除，
    /// 运行历史保留）
    pub(crate) async fn delete(&self, cron_id: &str) -> Result<(), CoreError> {
        let exists = self.store.load_all().iter().any(|w| w.cron_id == cron_id);
        if !exists {
            return Err(CoreError::NotFound(format!("workflow {cron_id} 不存在")));
        }
        if let Some(registry) = self.registry() {
            registry.cancel(cron_id).await.map_err(map_scheduler_err)?;
        }
        self.store.remove(cron_id);
        tracing::info!(target: "workflow", cron_id, "workflow 已删除");
        Ok(())
    }

    /// 立即触发一次（复用触发路径：fired_count 计入 + steering 条目注入）。
    ///
    /// manual 无表达式亦允许触发（仅注入 steering 面；run 由引擎承接）。
    /// 注册表无「立即触发」API，手动触发不改变注册表调度表——下次自然
    /// 触发仍按原计划（偏差登记见模块头）。
    pub(crate) fn trigger(&self, cron_id: &str) -> Result<TriggerResult, CoreError> {
        let all = self.store.load_all();
        let Some(mut workflow) = all.into_iter().find(|w| w.cron_id == cron_id) else {
            return Err(CoreError::NotFound(format!("workflow {cron_id} 不存在")));
        };
        if !workflow.enabled {
            return Err(CoreError::InvalidInput(format!(
                "workflow {cron_id} 已暂停，请先启用再触发"
            )));
        }
        let now = now_ms();
        workflow.fired_count += 1;
        workflow.last_run_at_ms = Some(now);
        if !workflow.expression.is_empty() {
            workflow.next_fire_at_ms = next_fire_after_ms(&workflow.expression, now).unwrap_or(0);
        }
        workflow.updated_at_ms = now;
        self.store.save(&workflow);
        // steering 条目（§4.8 冻结模板：prompt + 第 N 次触发）
        self.sink.enqueue_steering(
            cron_id,
            format!(
                "{}（cron {} 第 {} 次触发）",
                workflow.prompt, workflow.cron_id, workflow.fired_count
            ),
            now,
        );
        // 运行记录（命令层近似真源；生成可追踪 session_id 与完成状态）
        let run_id = format!("{}-fire-{}", workflow.cron_id, workflow.fired_count);
        let session_id = format!("sched-{}-{}", workflow.cron_id, workflow.fired_count);
        let record = WorkflowRunRecord {
            workflow_id: workflow.cron_id.clone(),
            run_id: run_id.clone(),
            session_id: Some(session_id.clone()),
            trigger_kind: "manual".to_string(),
            scheduled_for_ms: now,
            started_at_ms: now,
            finished_at_ms: Some(now),
            duration_ms: Some(0),
            status: "completed".to_string(),
            prompt: workflow.prompt.clone(),
            error: None,
            output_summary: Some(format!("手动立即触发成功（第 {} 次）", workflow.fired_count)),
        };
        self.store.append_or_update_run(record);
        tracing::info!(
            target: "workflow",
            cron_id,
            fired_count = workflow.fired_count,
            "workflow 已立即触发（steering 条目已注入）"
        );
        Ok(TriggerResult {
            run_id: Some(run_id),
            session_id: Some(session_id),
        })
    }

    /// 运行历史（可按 workflowId 过滤；按开始时间倒序；支持上限数量限制；每次扫描先收割在途孤儿）
    pub(crate) fn list_runs(
        &self,
        workflow_id: Option<&str>,
        limit: Option<usize>,
    ) -> Vec<WorkflowRunView> {
        self.reap_orphan_running_runs();
        let mut runs = self.store.load_runs();
        if let Some(id) = workflow_id {
            runs.retain(|r| r.workflow_id == id);
        }
        runs.sort_by_key(|r| std::cmp::Reverse(r.started_at_ms));
        let cap = limit.unwrap_or(50).clamp(1, 200);
        runs.into_iter().take(cap).map(|r| r.view()).collect()
    }
}

/// 更新补丁（命令入参部分字段）
#[derive(Default)]
pub(crate) struct WorkflowPatch {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub schedule: Option<WorkflowScheduleWire>,
    pub cwd: Option<String>,
    pub mode: Option<String>,
    pub enabled: Option<bool>,
    pub target_session_id: Option<String>,
    pub execution_mode: Option<String>,
}

/// 立即触发结果（runId / sessionId 由引擎触发路径产出，当前为空）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TriggerResult {
    pub run_id: Option<String>,
    pub session_id: Option<String>,
}

/// SchedulerError → CoreError（结构化映射：非法表达式/无命中 → InvalidInput，
/// 未知 id → NotFound）
fn map_scheduler_err(err: crate::sched::SchedulerError) -> CoreError {
    match err {
        crate::sched::SchedulerError::InvalidExpression(detail) => {
            CoreError::InvalidInput(format!("cron 表达式非法：{detail}"))
        }
        crate::sched::SchedulerError::NoNextFire(expression) => CoreError::InvalidInput(format!(
            "cron 表达式 {expression} 无未来触发时刻（如 2 月 30 日），拒绝注册"
        )),
        crate::sched::SchedulerError::IdNotFound => {
            CoreError::NotFound("cron 任务不存在或已停止".to_string())
        }
    }
}

/// 从 cron id 解析序号（`cron-<seq>` → seq）
fn cron_seq(cron_id: &str) -> Option<u64> {
    cron_id
        .strip_prefix(CRON_ID_PREFIX)
        .and_then(|seq| seq.parse::<u64>().ok())
}

/// 把调度入参 Value 解析为 wire 枚举（命令入参容错层）
fn parse_schedule_input(
    value: Option<&serde_json::Value>,
) -> Result<WorkflowScheduleWire, CoreError> {
    match value {
        None => Ok(WorkflowScheduleWire::Manual),
        Some(v) => WorkflowScheduleWire::parse(v).map_err(CoreError::InvalidInput),
    }
}

// ── 六条 Tauri 命令（wire 名 kebab-case，与 command_manifest 登记一致）──

/// `create-workflow`：创建 workflow（名称/提示词必填；调度按 §4.4 转 cron）
#[tauri::command(rename = "create-workflow")]
pub(crate) async fn create_workflow(
    name: String,
    prompt: String,
    schedule: Option<serde_json::Value>,
    cwd: Option<String>,
    mode: Option<String>,
    enabled: Option<bool>,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkflowCommandState>,
) -> Result<WorkflowCreateResponse, CoreError> {
    let schedule = parse_schedule_input(schedule.as_ref())?;
    let backend = Arc::clone(&state.inner().backend);
    let workflow = backend
        .create(name, prompt, schedule, cwd, mode, enabled.unwrap_or(true))
        .await?;
    // 全域状态广播（05 详案 §2.5）：前端 useWorkflowsState 监听后即时刷新
    emit_workflow_event(
        &app,
        "workflow:created",
        serde_json::json!({
            "workflowId": workflow.id,
            "name": workflow.name,
            "nextRunAt": workflow.next_run_at,
        }),
    );
    Ok(WorkflowCreateResponse { workflow })
}

/// `list-workflows`：列出全部 workflow
#[tauri::command(rename = "list-workflows")]
pub(crate) async fn list_workflows(
    state: tauri::State<'_, WorkflowCommandState>,
) -> Result<Vec<WorkflowView>, CoreError> {
    let backend = Arc::clone(&state.inner().backend);
    tokio::task::spawn_blocking(move || Ok::<Vec<WorkflowView>, CoreError>(backend.list()))
        .await
        .map_err(|e| CoreError::Internal(format!("list-workflows join: {e}")))?
}

/// `update-workflow`：更新 workflow（部分字段补丁）
#[tauri::command(rename = "update-workflow")]
pub(crate) async fn update_workflow(
    workflow_id: String,
    name: Option<String>,
    prompt: Option<String>,
    schedule: Option<serde_json::Value>,
    cwd: Option<String>,
    mode: Option<String>,
    enabled: Option<bool>,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkflowCommandState>,
) -> Result<WorkflowCreateResponse, CoreError> {
    if workflow_id.trim().is_empty() {
        return Err(CoreError::InvalidInput("workflowId 不能为空".to_string()));
    }
    let schedule = match schedule.as_ref() {
        Some(v) => Some(parse_schedule_input(Some(v))?),
        None => None,
    };
    let patch = WorkflowPatch {
        name,
        prompt,
        schedule,
        cwd,
        mode,
        enabled,
        target_session_id: None,
        execution_mode: None,
    };
    let backend = Arc::clone(&state.inner().backend);
    let workflow = backend.update(&workflow_id, patch).await?;
    emit_workflow_event(
        &app,
        "workflow:updated",
        serde_json::json!({
            "workflowId": workflow.id,
            "name": workflow.name,
            "nextRunAt": workflow.next_run_at,
        }),
    );
    Ok(WorkflowCreateResponse { workflow })
}

/// `delete-workflow`：删除 workflow（清单移除，运行历史保留）
#[tauri::command(rename = "delete-workflow")]
pub(crate) async fn delete_workflow(
    workflow_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkflowCommandState>,
) -> Result<(), CoreError> {
    if workflow_id.trim().is_empty() {
        return Err(CoreError::InvalidInput("workflowId 不能为空".to_string()));
    }
    let backend = Arc::clone(&state.inner().backend);
    backend.delete(&workflow_id).await?;
    emit_workflow_event(
        &app,
        "workflow:deleted",
        serde_json::json!({ "workflowId": workflow_id }),
    );
    Ok(())
}

/// `trigger-workflow`：手动立即触发一次（fired_count 计入 + steering 注入）
#[tauri::command(rename = "trigger-workflow")]
pub(crate) async fn trigger_workflow(
    workflow_id: String,
    state: tauri::State<'_, WorkflowCommandState>,
) -> Result<TriggerResult, CoreError> {
    if workflow_id.trim().is_empty() {
        return Err(CoreError::InvalidInput("workflowId 不能为空".to_string()));
    }
    let backend = Arc::clone(&state.inner().backend);
    tokio::task::spawn_blocking(move || backend.trigger(&workflow_id))
        .await
        .map_err(|e| CoreError::Internal(format!("trigger-workflow join: {e}")))?
}

/// `list-workflow-runs`：运行历史（可按 workflowId 过滤，支持 limit 数量限制）
#[tauri::command(rename = "list-workflow-runs")]
pub(crate) async fn list_workflow_runs(
    workflow_id: Option<String>,
    limit: Option<usize>,
    state: tauri::State<'_, WorkflowCommandState>,
) -> Result<Vec<WorkflowRunView>, CoreError> {
    let backend = Arc::clone(&state.inner().backend);
    tokio::task::spawn_blocking(move || {
        Ok::<Vec<WorkflowRunView>, CoreError>(backend.list_runs(workflow_id.as_deref(), limit))
    })
    .await
    .map_err(|e| CoreError::Internal(format!("list-workflow-runs join: {e}")))?
}

/// 创建 / 更新响应（对齐前端 `{ ok, workflow, error? }` 解析面）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowCreateResponse {
    pub workflow: WorkflowView,
}

// ── 测试 ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试桩：steering 落点记录
    #[derive(Default)]
    struct ProbeSink {
        entries: Mutex<Vec<(String, String, u64)>>,
    }

    impl SteeringSink for ProbeSink {
        fn enqueue_steering(&self, cron_id: &str, text: String, enqueued_at_ms: u64) {
            self.entries
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((cron_id.to_string(), text, enqueued_at_ms));
        }
    }

    /// 测试桩：sched.rs PendingSink 落点（委托测试用）
    #[derive(Default)]
    struct SchedProbe {
        entries: Mutex<Vec<String>>,
    }

    impl crate::sched::PendingSink for SchedProbe {
        fn enqueue_steering(&self, cron_id: &str, text: String, _enqueued_at_ms: u64) {
            self.entries
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(format!("{cron_id}|{text}"));
        }
    }

    /// 构造测试后端（内存 store + probe sink；独立模式，注册表委托未注入）
    fn test_backend() -> (Arc<WorkflowBackend>, Arc<ProbeSink>) {
        let sink = Arc::new(ProbeSink::default());
        let backend = Arc::new(WorkflowBackend::new(
            Arc::new(MemoryWorkflowStore::default()),
            Arc::clone(&sink) as Arc<dyn SteeringSink>,
        ));
        (backend, sink)
    }

    /// 构造 daily 调度入参
    fn daily_schedule(time: &str) -> WorkflowScheduleWire {
        WorkflowScheduleWire::Daily {
            time: time.to_string(),
            timezone: "Asia/Shanghai".to_string(),
        }
    }

    // ── 命令语义：创建 / 列表 / 删除 / 触发 ────────────────────────

    /// 创建 → 列表同形状条目（id/名称/提示词/调度/表达式转换齐备）
    #[tokio::test]
    async fn create_workflow_persists() {
        let (backend, _) = test_backend();
        let view = backend
            .create(
                "每日检查".to_string(),
                "检查仓库状态".to_string(),
                daily_schedule("09:30"),
                None,
                None,
                true,
            )
            .await
            .expect("创建应成功");
        assert!(
            view.id.starts_with("cron-"),
            "id 应为 cron-<seq>：{}",
            view.id
        );
        assert_eq!(view.name, "每日检查");
        assert_eq!(view.prompt, "检查仓库状态");
        assert!(view.enabled);
        assert!(view.next_run_at.is_some(), "daily 应有 nextRunAt");

        let list = backend.list();
        assert_eq!(list.len(), 1, "列表应含创建条目");
        let listed = &list[0];
        assert_eq!(listed.id, view.id, "列表条目 id 与创建一致");
        assert_eq!(listed.name, view.name);
        assert_eq!(listed.prompt, view.prompt);
        assert_eq!(
            listed.schedule,
            WorkflowScheduleWire::Daily {
                time: "09:30".to_string(),
                timezone: "Asia/Shanghai".to_string(),
            },
            "schedule 应原样回显"
        );
        // 持久化形状：sched_<cronId> 键可读回
        let persisted = backend.store.load_all();
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].cron_id, view.id);
        assert_eq!(persisted[0].expression, "30 9 * * *", "daily → M H * * *");
    }

    /// 删除后列表不含该条目（运行历史保留）
    #[tokio::test]
    async fn delete_workflow_removes() {
        let (backend, _) = test_backend();
        let view = backend
            .create(
                "临时任务".to_string(),
                "清理".to_string(),
                WorkflowScheduleWire::Manual,
                None,
                None,
                true,
            )
            .await
            .expect("创建应成功");
        backend.trigger(&view.id).expect("触发应成功");
        backend.delete(&view.id).await.expect("删除应成功");
        assert!(
            backend.list().iter().all(|w| w.id != view.id),
            "删除后列表不得含该条目"
        );
        assert_eq!(backend.store.load_all().len(), 0, "存储应移除 sched_* 键");
        // 删除不存在的 id → NotFound
        let again = backend.delete(&view.id).await;
        assert!(
            matches!(again, Err(CoreError::NotFound(_))),
            "删除不存在应 NotFound：{again:?}"
        );
    }

    /// 立即触发：fired_count+1、steering 条目按 §4.8 模板出现、
    /// 运行记录登记、表达式任务的 next_fire 重算
    #[tokio::test]
    async fn trigger_workflow_immediate_fire() {
        let (backend, sink) = test_backend();
        let view = backend
            .create(
                "巡检".to_string(),
                "巡检工作区".to_string(),
                daily_schedule("08:00"),
                None,
                None,
                true,
            )
            .await
            .expect("创建应成功");
        let result = backend.trigger(&view.id).expect("触发应成功");
        assert_eq!(result.run_id.as_deref(), Some("cron-0-fire-1"));
        assert_eq!(result.session_id.as_deref(), Some("sched-cron-0-1"));
        // fired_count 计入
        let persisted = backend.store.load_all();
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].fired_count, 1, "触发后 fired_count 应为 1");
        assert!(persisted[0].last_run_at_ms.is_some());
        // steering 条目（§4.8 模板：prompt + 第 N 次触发；group = cron-<id>）
        let entries = sink.entries.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(entries.len(), 1, "应恰好注入一条 steering 条目");
        let (cron_id, text, _) = &entries[0];
        assert_eq!(cron_id, &view.id);
        assert!(
            text.contains("巡检工作区") && text.contains("第 1 次触发"),
            "steering 文本应按冻结模板：{text}"
        );
        // 运行记录
        let runs = backend.list_runs(Some(&view.id), None);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].workflow_id, view.id);
        assert_eq!(runs[0].status, "completed");
        assert_eq!(runs[0].trigger_kind, "manual");
        assert_eq!(runs[0].prompt, "巡检工作区");
    }

    /// 非法调度拒绝（Rust 侧真实错误文案——parse_cron 中文错误，不落库）
    #[tokio::test]
    async fn create_workflow_rejects_invalid_schedule() {
        let (backend, _) = test_backend();
        // 非法 cron：6 字段（parse_cron 真实文案含「6 字段」定位）
        let err = backend
            .create(
                "坏 cron".to_string(),
                "x".to_string(),
                WorkflowScheduleWire::Cron {
                    expression: "0 0 0 * * *".to_string(),
                },
                None,
                None,
                true,
            )
            .await;
        assert!(
            matches!(&err, Err(CoreError::InvalidInput(detail)) if detail.contains("字段")),
            "非法 cron 应返回 parse_cron 中文文案：{err:?}"
        );
        // 无未来命中时刻（2 月 30 日）→ 拒绝
        let err = backend
            .create(
                "坏 cron".to_string(),
                "x".to_string(),
                WorkflowScheduleWire::Cron {
                    expression: "0 0 30 2 *".to_string(),
                },
                None,
                None,
                true,
            )
            .await;
        assert!(err.is_err(), "2 月 30 日类表达式应拒绝：{err:?}");
        // 非法 intervalMinutes 越界
        let err = backend
            .create(
                "坏间隔".to_string(),
                "x".to_string(),
                WorkflowScheduleWire::IntervalMinutes {
                    interval_minutes: 0,
                },
                None,
                None,
                true,
            )
            .await;
        assert!(err.is_err(), "间隔 0 应拒绝");
        // 空名称拒绝
        let err = backend
            .create(
                "  ".to_string(),
                "x".to_string(),
                WorkflowScheduleWire::Manual,
                None,
                None,
                true,
            )
            .await;
        assert!(
            matches!(err, Err(CoreError::InvalidInput(_))),
            "空名称应拒绝"
        );
        // 全部拒绝不落库
        assert_eq!(backend.store.load_all().len(), 0, "拒绝路径不得落库");
    }

    /// 更新：部分补丁（改名称 / 暂停 / 换调度 → 表达式与 next_fire 重算）
    #[tokio::test]
    async fn update_workflow_patch_and_recompute() {
        let (backend, _) = test_backend();
        let view = backend
            .create(
                "旧名".to_string(),
                "旧提示".to_string(),
                WorkflowScheduleWire::Manual,
                None,
                None,
                true,
            )
            .await
            .expect("创建应成功");
        let updated = backend
            .update(
                &view.id,
                WorkflowPatch {
                    name: Some("新名".to_string()),
                    schedule: Some(daily_schedule("12:00")),
                    ..WorkflowPatch::default()
                },
            )
            .await
            .expect("更新应成功");
        assert_eq!(updated.name, "新名");
        assert_eq!(updated.prompt, "旧提示", "未补丁字段保持原值");
        let persisted = backend.store.load_all();
        assert_eq!(persisted[0].expression, "0 12 * * *", "换调度应重算表达式");
        assert_ne!(persisted[0].next_fire_at_ms, 0, "换调度应重算 next_fire");
        // 暂停
        let paused = backend
            .update(
                &view.id,
                WorkflowPatch {
                    enabled: Some(false),
                    ..WorkflowPatch::default()
                },
            )
            .await
            .expect("暂停应成功");
        assert_eq!(paused.enabled, false);
        // 更新不存在的 id → NotFound
        let missing = backend.update("cron-999", WorkflowPatch::default()).await;
        assert!(
            matches!(missing, Err(CoreError::NotFound(_))),
            "更新不存在应 NotFound：{missing:?}"
        );
    }

    /// 已暂停任务触发拒绝；manual 任务允许触发（仅 steering 面）
    #[tokio::test]
    async fn trigger_disabled_rejected_manual_allowed() {
        let (backend, _) = test_backend();
        let view = backend
            .create(
                "手动".to_string(),
                "手动作业".to_string(),
                WorkflowScheduleWire::Manual,
                None,
                None,
                false,
            )
            .await
            .expect("创建应成功");
        let err = backend.trigger(&view.id);
        assert!(
            matches!(&err, Err(CoreError::InvalidInput(detail)) if detail.contains("暂停")),
            "暂停任务触发应拒绝：{err:?}"
        );
        // 启用后 manual 触发成功（无表达式仅 steering 面）
        backend
            .update(
                &view.id,
                WorkflowPatch {
                    enabled: Some(true),
                    ..WorkflowPatch::default()
                },
            )
            .await
            .expect("启用应成功");
        backend.trigger(&view.id).expect("manual 触发应成功");
        let persisted = backend.store.load_all();
        assert_eq!(persisted[0].fired_count, 1);
    }

    // ── 委托注册表（A5 注入后语义）────────────────────────────────

    /// 委托激活：create → 注册表 snapshot 出现任务（id 同源），
    /// delete → 注册表 cancel（enabled=false 落库）+ 元数据移除。
    #[tokio::test]
    async fn delegation_wires_register_and_cancel() {
        use crate::sched::{MemorySchedStore, SchedEventSink, SchedStore};

        // 构造注册表（sched.rs 适配器；launcher 未接线；注意 shared() 已返回 Arc）
        let pending: Arc<dyn crate::sched::PendingSink> = Arc::new(SchedProbe::default());
        let events: Arc<dyn crate::sched::EventSink> = Arc::new(SchedEventSink::new());
        let sched_store: Arc<dyn SchedStore> = MemorySchedStore::shared();
        let sched_store_assert = Arc::clone(&sched_store);
        let registry = Arc::new(SchedulerRegistry::new(pending, events, sched_store, None));

        // 命令后端注入委托
        let sink = Arc::new(ProbeSink::default());
        let backend = Arc::new(WorkflowBackend::new(
            Arc::new(MemoryWorkflowStore::default()),
            Arc::clone(&sink) as Arc<dyn SteeringSink>,
        ));
        backend.set_registry(Arc::clone(&registry));

        // 创建 → 注册表 snapshot 同源条目
        let view = backend
            .create(
                "委托创建".to_string(),
                "委托提示".to_string(),
                daily_schedule("07:00"),
                None,
                None,
                true,
            )
            .await
            .expect("委托模式创建应成功");
        let snapshot = registry.snapshot();
        assert_eq!(snapshot.len(), 1, "注册表应有同源任务");
        assert_eq!(snapshot[0].cron_id, view.id);
        assert_eq!(snapshot[0].expression, "0 7 * * *");
        assert_eq!(snapshot[0].prompt, "委托提示");

        // 删除 → 注册表 cancel（enabled=false 落库）+ 元数据移除
        backend.delete(&view.id).await.expect("委托模式删除应成功");
        let persisted = sched_store_assert.load_all();
        assert_eq!(persisted.len(), 1);
        assert!(!persisted[0].enabled, "cancel 应 enabled=false 落库");
        assert!(registry.snapshot().iter().all(|t| !t.enabled));
        assert!(backend.list().is_empty(), "元数据列表应移除");
    }

    /// 验收（30 方案 P6）：trigger → steering 条目落入真实共享队列——
    /// QueueSteeringSink 适配 PendingMessageQueue（group_id = cron-<id>
    /// 原位替换去重、is_steering 受保护位、摘要文本含 prompt 与第 N 次触发）
    #[tokio::test]
    async fn trigger_workflow_enqueues_shared_steering() {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let backend = Arc::new(WorkflowBackend::new(
            Arc::new(MemoryWorkflowStore::default()),
            Arc::new(QueueSteeringSink::new(Arc::clone(&queue))),
        ));
        let view = backend
            .create(
                "手动巡检".to_string(),
                "检查仓库状态".to_string(),
                WorkflowScheduleWire::Manual,
                None,
                None,
                true,
            )
            .await
            .expect("manual 创建应成功");
        backend.trigger(&view.id).expect("触发应成功");

        let queue = queue.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(queue.len(), 1, "触发必须写入共享队列");
        let entry = queue.peek().expect("队列必有条目");
        assert_eq!(
            entry.group_id.as_deref(),
            Some(format!("{CRON_ID_PREFIX}{}", view.id).as_str()),
            "group_id 应为 cron-<id>"
        );
        assert!(entry.is_steering, "触发条目为 steering 受保护位");
        assert!(
            entry.text.contains("检查仓库状态") && entry.text.contains("第 1 次触发"),
            "摘要文本应含 prompt 与触发计数：{}",
            entry.text
        );
    }

    /// 验收（30 方案 P6）：create（cron 表达式）→ 注册表快照含 next_fire
    /// ——真实注册调度接入（不再只落库）；注册表表内条目即活跃（P7
    /// has_active 判定真源）。
    #[tokio::test]
    async fn create_workflow_registers_real_scheduler() {
        use crate::sched::{MemorySchedStore, SchedEventSink, SchedStore};

        let pending: Arc<dyn crate::sched::PendingSink> = Arc::new(SchedProbe::default());
        let events: Arc<dyn crate::sched::EventSink> = Arc::new(SchedEventSink::new());
        let sched_store: Arc<dyn SchedStore> = MemorySchedStore::shared();
        let registry = Arc::new(SchedulerRegistry::new(pending, events, sched_store, None));
        let backend = Arc::new(WorkflowBackend::new(
            Arc::new(MemoryWorkflowStore::default()),
            Arc::new(ProbeSink::default()) as Arc<dyn SteeringSink>,
        ));
        backend.set_registry(Arc::clone(&registry));

        let view = backend
            .create(
                "每日备份".to_string(),
                "执行备份".to_string(),
                daily_schedule("07:00"),
                None,
                None,
                true,
            )
            .await
            .expect("委托模式创建应成功");
        let snapshot = registry.snapshot();
        assert_eq!(snapshot.len(), 1, "注册表应有同源任务");
        assert_eq!(snapshot[0].cron_id, view.id);
        assert!(
            snapshot[0].next_fire_at_ms > 0,
            "快照应含 next_fire（真实调度，不再只落库）"
        );
        assert!(
            registry.has_active(),
            "表内条目即活跃（P7 cron_has_enabled 判定真源）"
        );
        // 清理：取消防触发任务泄漏（daily 表达式真实 sleep 挂起）
        registry.cancel(&view.id).await.expect("清理取消应成功");
    }

    // ── 表达式校验与 next_fire（委托 parse_cron 纯函数）────────────

    #[test]
    fn cron_validation_delegates_to_parser() {
        // 合法：*、n、a-b、列表、步进、范围步进、dow 0/7
        for expr in [
            "* * * * *",
            "0 9 * * *",
            "5 8 * * 1-5",
            "0,30 9-18 * * *",
            "*/5 * * * *",
            "0 8-20/2 * * *",
            "0 0 * * 7",
        ] {
            assert_eq!(
                validate_cron_expression(expr).as_deref(),
                Ok(expr),
                "{expr} 应合法"
            );
        }
        // 非法：空 / @ 宏 / 6 字段 / 4 字段 / 越界（parse_cron 真实文案）
        assert!(validate_cron_expression("").is_err());
        assert!(validate_cron_expression("@daily").is_err());
        assert!(validate_cron_expression("0 0 0 * * *").is_err());
        assert!(validate_cron_expression("0 0 * *").is_err());
        assert!(validate_cron_expression("60 * * * *").is_err());
        assert!(validate_cron_expression("0 24 * * *").is_err());
        assert!(validate_cron_expression("0 0 32 * *").is_err());
        assert!(validate_cron_expression("0 0 * 13 *").is_err());
        assert!(validate_cron_expression("0 0 * * 8").is_err());
        // 错误文案为中文（前端可直接展示）
        let err = validate_cron_expression("0 0 0 * * *").unwrap_err();
        assert!(err.contains("6 字段"), "应含字段数定位：{err}");
    }

    #[test]
    fn next_fire_delegates_to_parser() {
        // 确定性断言走固定偏移（offset=0 即 UTC；next_fire_after_in_offset
        // 是 T-CF-08 冻结签名的确定性变体，不依赖本机时区）
        let after = 1_752_000_000_000u64;
        let schedule = parse_cron("30 9 * * *").expect("表达式应合法");
        let next = schedule
            .next_fire_after_in_offset(after, 0)
            .expect("daily 应有下次触发");
        assert!(next > after);
        let secs = next / 1000;
        let (h, m) = ((secs % 86_400) / 3600, (secs % 3600) / 60);
        assert_eq!((h, m), (9, 30), "下次触发应为 09:30（UTC 偏移）");
        // 无命中：2 月 30 日不存在
        assert_eq!(
            schedule_next("0 0 30 2 *", after),
            None,
            "2 月 30 日应无命中"
        );
        // 包装函数（本地时区语义）行为面断言：Some 且在 after 之后、分钟对齐
        if let Some(wrapped) = next_fire_after_ms("30 9 * * *", after) {
            assert!(wrapped > after);
            assert_eq!(wrapped % 60_000, 0, "应为整分钟");
        } else {
            panic!("next_fire_after_ms 应返回 Some");
        }
    }

    /// 便捷：表达式 → 固定偏移下次触发
    fn schedule_next(expression: &str, after_ms: u64) -> Option<u64> {
        parse_cron(expression)
            .ok()?
            .next_fire_after_in_offset(after_ms, 0)
    }

    #[test]
    fn epoch_iso_format_is_parseable() {
        let iso = epoch_ms_to_iso(1_752_000_000_000);
        assert!(iso.ends_with('Z'), "应为 UTC Z 后缀：{iso}");
        assert!(iso.contains('T'), "应为 ISO 格式：{iso}");
        let secs = iso[..iso.len() - 5].replace('T', "-").replace(':', "-");
        let parts: Vec<&str> = secs.split('-').collect();
        assert_eq!(parts.len(), 6, "ISO 应含完整日期时间字段：{iso}");
    }

    /// 持久化重启恢复：MemoryStore 残留 → 新后端 seq 不撞号、列表可读回
    #[tokio::test]
    async fn backend_recovers_from_store_on_restart() {
        let store = Arc::new(MemoryWorkflowStore::default());
        let sink = Arc::new(ProbeSink::default());
        let backend_a = Arc::new(WorkflowBackend::new(
            Arc::clone(&store) as Arc<dyn WorkflowStore>,
            Arc::clone(&sink) as Arc<dyn SteeringSink>,
        ));
        let first = backend_a
            .create(
                "重启前".to_string(),
                "x".to_string(),
                WorkflowScheduleWire::Manual,
                None,
                None,
                true,
            )
            .await
            .expect("创建应成功");
        assert_eq!(first.id, "cron-0");
        drop(backend_a); // 模拟重启（store 残留）
        let backend_b = WorkflowBackend::new(
            Arc::clone(&store) as Arc<dyn WorkflowStore>,
            Arc::clone(&sink) as Arc<dyn SteeringSink>,
        );
        let list = backend_b.list();
        assert_eq!(list.len(), 1, "重启后列表应恢复");
        assert_eq!(list[0].id, "cron-0");
        let second = backend_b
            .create(
                "重启后".to_string(),
                "y".to_string(),
                WorkflowScheduleWire::Manual,
                None,
                None,
                true,
            )
            .await
            .expect("创建应成功");
        assert_eq!(second.id, "cron-1", "重启后 seq 不得撞号");
    }

    // ── Wave 1 存储无损合并与孤儿运行收割实施专项测试 ─────────────

    /// 1. ID 恒定铁律：委托模式下修改调度表达式与提示词，cron_id 与 created_at 严格不变
    #[tokio::test]
    async fn update_workflow_preserves_id_and_invariance() {
        use crate::sched::{MemorySchedStore, SchedEventSink, SchedStore};

        let pending: Arc<dyn crate::sched::PendingSink> = Arc::new(SchedProbe::default());
        let events: Arc<dyn crate::sched::EventSink> = Arc::new(SchedEventSink::new());
        let sched_store: Arc<dyn SchedStore> = MemorySchedStore::shared();
        let registry = Arc::new(SchedulerRegistry::new(pending, events, sched_store, None));

        let sink = Arc::new(ProbeSink::default());
        let backend = Arc::new(WorkflowBackend::new(
            Arc::new(MemoryWorkflowStore::default()),
            Arc::clone(&sink) as Arc<dyn SteeringSink>,
        ));
        backend.set_registry(Arc::clone(&registry));

        let created = backend
            .create(
                "恒定任务".to_string(),
                "初始提示词".to_string(),
                daily_schedule("08:00"),
                None,
                None,
                true,
            )
            .await
            .expect("创建应成功");

        let original_id = created.id.clone();
        let original_created_at = created.created_at.clone();

        // 更新调度表达式与提示词
        let updated = backend
            .update(
                &original_id,
                WorkflowPatch {
                    prompt: Some("热更新提示词".to_string()),
                    schedule: Some(daily_schedule("18:30")),
                    ..WorkflowPatch::default()
                },
            )
            .await
            .expect("更新应成功");

        // 核心断言：ID 与创建时间绝对恒定
        assert_eq!(updated.id, original_id, "cron_id 必须绝对恒定，严禁因更新表达式重分 ID");
        assert_eq!(
            updated.created_at, original_created_at,
            "created_at 必须绝对恒定，严禁被重置"
        );
        assert_eq!(updated.prompt, "热更新提示词");

        // 注册表快照检验：注册表中也是同一个 ID，且表达式已热更新
        let snapshot = registry.snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].cron_id, original_id);
        assert_eq!(snapshot[0].expression, "30 18 * * *");
        assert_eq!(snapshot[0].prompt, "热更新提示词");
    }

    /// 2. 启停联动：更新 enabled 联动触发底座 pause_task / resume_task，且 list() 真实回显
    #[tokio::test]
    async fn update_workflow_pause_resume_linkage() {
        use crate::sched::{MemorySchedStore, SchedEventSink, SchedStore};

        let pending: Arc<dyn crate::sched::PendingSink> = Arc::new(SchedProbe::default());
        let events: Arc<dyn crate::sched::EventSink> = Arc::new(SchedEventSink::new());
        let sched_store: Arc<dyn SchedStore> = MemorySchedStore::shared();
        let registry = Arc::new(SchedulerRegistry::new(pending, events, sched_store, None));

        let sink = Arc::new(ProbeSink::default());
        let backend = Arc::new(WorkflowBackend::new(
            Arc::new(MemoryWorkflowStore::default()),
            Arc::clone(&sink) as Arc<dyn SteeringSink>,
        ));
        backend.set_registry(Arc::clone(&registry));

        let created = backend
            .create(
                "联动任务".to_string(),
                "提示词".to_string(),
                daily_schedule("09:00"),
                None,
                None,
                true,
            )
            .await
            .expect("创建应成功");

        assert!(registry.snapshot()[0].enabled, "注册后初始为 active");

        // 暂停任务
        let paused = backend
            .update(
                &created.id,
                WorkflowPatch {
                    enabled: Some(false),
                    ..WorkflowPatch::default()
                },
            )
            .await
            .expect("暂停应成功");

        assert!(!paused.enabled);
        assert!(paused.next_run_at.is_none(), "暂停态 next_run_at 必须为 None");
        assert!(!registry.snapshot()[0].enabled, "注册表中任务必须同步置为 paused");

        // 恢复任务
        let resumed = backend
            .update(
                &created.id,
                WorkflowPatch {
                    enabled: Some(true),
                    ..WorkflowPatch::default()
                },
            )
            .await
            .expect("恢复应成功");

        assert!(resumed.enabled);
        assert!(resumed.next_run_at.is_some(), "恢复后应有 next_run_at");
        assert!(registry.snapshot()[0].enabled, "注册表中任务必须同步置为 active");
    }

    /// 3. Safe Field Merge 治理：save 不会冲刷业务或底座自定义 JSON 字段，实现双向安全无损
    #[test]
    fn safe_field_merge_preserves_business_and_scheduling_fields() {
        let db = LocalDb::open_in_memory().expect("内存库应打开成功");
        let store = SessionMetaWorkflowStore::new(db.clone());

        // 预置存量 JSON，包含上层业务私有扩展字段与底座扩展字段
        let raw_json = serde_json::json!({
            "cronId": "cron-42",
            "expression": "0 10 * * *",
            "prompt": "原始提示词",
            "enabled": true,
            "status": "Active",
            "name": "业务工作流",
            "customBusinessField": "important_value",
            "extraMeta": { "nested": 123 },
            "createdAtMs": 1000u64,
            "updatedAtMs": 1000u64
        });
        db.set_session_meta("sched_cron-42", &raw_json.to_string())
            .expect("预置元数据应成功");
        db.set_session_meta(
            SESSION_META_INDEX_KEY,
            &serde_json::to_string(&vec!["cron-42"]).unwrap(),
        )
        .expect("预置索引应成功");

        // 从 store 加载
        let mut loaded = store.load_all();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].cron_id, "cron-42");

        // 修改某字段后调用 store.save
        loaded[0].prompt = "修改后的提示词".to_string();
        store.save(&loaded[0]);

        // 直接读取底座 JSON 校验：业务扩展字段未被冲刷丢失
        let saved_json_str = db
            .get_session_meta("sched_cron-42")
            .expect("读取")
            .expect("存在");
        let saved_val: serde_json::Value = serde_json::from_str(&saved_json_str).unwrap();

        assert_eq!(saved_val["prompt"], "修改后的提示词");
        assert_eq!(saved_val["customBusinessField"], "important_value");
        assert_eq!(saved_val["extraMeta"]["nested"], 123);
    }

    /// 4. 启发式自愈：Manual 调度但有合法 cron 表达式的历史脏数据，在 load_all 时自动自愈为 Cron
    #[test]
    fn heuristic_rehydration_restores_manual_with_valid_expression() {
        let db = LocalDb::open_in_memory().expect("内存库应打开成功");
        let store = SessionMetaWorkflowStore::new(db.clone());

        // 预置存量脏数据：schedule 为 manual，但 expression 为有效 5 字段表达式
        let legacy_json = serde_json::json!({
            "cronId": "cron-legacy-1",
            "expression": "*/15 * * * *",
            "prompt": "历史脏任务",
            "enabled": true,
            "name": "自愈测试",
            "schedule": { "type": "manual" },
            "createdAtMs": 2000u64,
            "updatedAtMs": 2000u64
        });
        db.set_session_meta("sched_cron-legacy-1", &legacy_json.to_string())
            .unwrap();
        // 且索引位于老键 sched_ids 中，测试索引合并
        db.set_session_meta(
            "sched_ids",
            &serde_json::to_string(&vec!["cron-legacy-1"]).unwrap(),
        )
        .unwrap();

        let all = store.load_all();
        assert_eq!(all.len(), 1);
        let wf = &all[0];
        // 断言自愈成功
        assert_eq!(
            wf.schedule,
            WorkflowScheduleWire::Cron {
                expression: "*/15 * * * *".to_string()
            },
            "启发式自愈应将 Manual + 有效表达式恢复为 WorkflowScheduleWire::Cron"
        );

        // 断言已回写持久化库，并且新索引 sched_index 已写入
        let reloaded_index: Vec<String> = serde_json::from_str(
            &db.get_session_meta(SESSION_META_INDEX_KEY)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(reloaded_index.contains(&"cron-legacy-1".to_string()));
    }

    /// 5. 孤儿运行收割与 update_run_finish Upsert 语义验证
    #[test]
    fn orphan_running_runs_reaped_and_update_run_finish_upsert() {
        let store = MemoryWorkflowStore::default();

        // 插入各种在途状态记录与一条已完成记录
        let statuses = [
            ("r1", "running"),
            ("r2", "queued"),
            ("r3", "pending"),
            ("r4", "in_progress"),
            ("r5", "accepted"),
            ("r6", "started"),
            ("r7", "completed"),
        ];
        for (rid, st) in statuses {
            store.append_or_update_run(WorkflowRunRecord {
                workflow_id: "wf-1".to_string(),
                run_id: rid.to_string(),
                session_id: None,
                trigger_kind: "cron".to_string(),
                scheduled_for_ms: 1000,
                started_at_ms: 1000,
                finished_at_ms: None,
                duration_ms: Some(999),
                status: st.to_string(),
                prompt: "测试".to_string(),
                error: None,
                output_summary: None,
            });
        }

        // 执行收割
        let reaped = store.reap_orphan_running_runs();
        assert_eq!(reaped, 6, "6 条在途记录应全部被收割");

        let runs = store.load_runs();
        for run in &runs {
            if run.run_id == "r7" {
                assert_eq!(run.status, "completed");
            } else {
                assert_eq!(run.status, "interrupted");
                assert_eq!(run.duration_ms, None);
                assert!(run.error.as_deref().unwrap_or("").contains("自愈收割"));
            }
        }

        // 验证 update_run_finish Upsert：更新已有记录
        store.update_run_finish(
            "wf-1",
            "r1",
            "success",
            2000,
            1000,
            None,
            Some("完成摘要".to_string()),
        );
        let updated_r1 = store.load_runs().into_iter().find(|r| r.run_id == "r1").unwrap();
        assert_eq!(updated_r1.status, "success");
        assert_eq!(updated_r1.duration_ms, Some(1000));
        assert_eq!(updated_r1.output_summary.as_deref(), Some("完成摘要"));

        // 验证 update_run_finish Upsert：若记录不存在，原地创建终态记录
        store.update_run_finish(
            "wf-1",
            "r-brand-new",
            "failed",
            3000,
            500,
            Some("外部超时".to_string()),
            None,
        );
        let created_new = store.load_runs().into_iter().find(|r| r.run_id == "r-brand-new").unwrap();
        assert_eq!(created_new.status, "failed");
        assert_eq!(created_new.started_at_ms, 2500);
        assert_eq!(created_new.finished_at_ms, Some(3000));
        assert_eq!(created_new.error.as_deref(), Some("外部超时"));
    }

    /// 6. list() 杜绝冲刷覆盖 DB 启用状态
    #[tokio::test]
    async fn list_does_not_overwrite_db_enabled_state() {
        use crate::sched::{MemorySchedStore, SchedEventSink, SchedStore};

        let pending: Arc<dyn crate::sched::PendingSink> = Arc::new(SchedProbe::default());
        let events: Arc<dyn crate::sched::EventSink> = Arc::new(SchedEventSink::new());
        let sched_store: Arc<dyn SchedStore> = MemorySchedStore::shared();
        let registry = Arc::new(SchedulerRegistry::new(pending, events, sched_store, None));

        let sink = Arc::new(ProbeSink::default());
        let store = Arc::new(MemoryWorkflowStore::default());
        let backend = Arc::new(WorkflowBackend::new(
            Arc::clone(&store) as Arc<dyn WorkflowStore>,
            Arc::clone(&sink) as Arc<dyn SteeringSink>,
        ));
        backend.set_registry(Arc::clone(&registry));

        let created = backend
            .create(
                "禁用任务".to_string(),
                "提示词".to_string(),
                daily_schedule("10:00"),
                None,
                None,
                false,
            )
            .await
            .expect("创建应成功");

        assert!(!created.enabled);

        // 调用 list()，断言其 enabled 依然为 false，且 next_run_at 为 None
        let list = backend.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, created.id);
        assert!(!list[0].enabled, "list() 严禁覆盖库中的禁用状态");
        assert!(list[0].next_run_at.is_none());
    }

    /// 7. prune_runs 针对所有运行记录限制单任务与全局容量（不豁免 running）
    #[test]
    fn prune_runs_limits_all_runs() {
        let mut runs = Vec::new();
        // 单工作流插入 30 条 running 状态的记录
        for i in 0..30 {
            runs.push(WorkflowRunRecord {
                workflow_id: "wf-prune".to_string(),
                run_id: format!("run-{i}"),
                session_id: None,
                trigger_kind: "cron".to_string(),
                scheduled_for_ms: i * 100,
                started_at_ms: i * 100,
                finished_at_ms: None,
                duration_ms: None,
                status: "running".to_string(),
                prompt: "提示".to_string(),
                error: None,
                output_summary: None,
            });
        }

        let pruned = prune_runs(runs);
        assert_eq!(
            pruned.len(),
            20,
            "单工作流上限为 20，即使全部为 running 也必须滚动淘汰最老记录"
        );
        // 保留的是 started_at_ms 最大的最新 20 条（10..30）
        let min_started = pruned.iter().map(|r| r.started_at_ms).min().unwrap();
        assert_eq!(min_started, 1000);
    }
}
