//! 任务域事件唤醒消费面（T-AB-18：唤醒摘要 / 审计留痕 / C7 衔接）
//!
//! 定位（01-AB方案 §7.4 T-AB-18）：任务域七事件的**发射点**在壳层
//! （T-AB-16 / C3 接线），本模块是 orchestrator 侧的**唤醒消费面**：
//!
//! - **唤醒摘要注入**（REQ-C04）：消费 task-completed / task-failed /
//!   task-killed / task-suspicious 组装摘要文本——「任务 <id> 已完成，
//!   退出码 0」「任务 <id> 异常退出（exit code N），附最后 20 行日志」
//!   「任务 <id> 疑似卡死（<M> 秒无输出）」「任务 <id> 已被终止」；
//!   注入时机为 run idle / 下一条用户消息边界（[TaskWakeBatch] 按 run
//!   聚合，同 run 多终态**合并为一条注入**，不逐条打断——REQ-D07
//!   语义；完整「AI 无事可做时立即唤醒」属模块 C（REQ-C04）范围，
//!   本模块只提供数据与批量注入入口，不越界实现定时器面）；
//! - **security-audit 审计留痕**：任务启停/终止/归档聚合为
//!   [TaskAuditRecord]（taskId / command 摘要 / 操作者 / 时间戳 / 结果），
//!   逐条发射 `security-audit` 事件（operation=command-exec，对齐
//!   agent-tools shell.rs 红线拦截先例的 command-exec 形态；审计基线
//!   31-security-baseline.md B4：安全相关事件必须落事件流、可检索）；
//! - **C7 恢复阶梯衔接**：task-failed 且 AI 显式等待关键任务时经
//!   [PendingMessageQueue] 写入 steering 条目（group_id = `task-<id>`
//!   原位替换去重、is_steering 受保护位）——对齐 recovery.rs 阶梯 2
//!   「通知落库，重启后主 agent 仍可见」先例；**不做自动重试**
//!   （重试决策属 AI，本模块只投递）。「AI 显式等待」判定由接线方
//!   （壳层 T-AB-16 / C3）在调用 [steer_for_task_failed] 前裁决；
//! - **task-started 的 ownerRunId**：供按来源过滤（主 agent 与其派发的
//!   子 agent run 看到的任务按来源归组，[task_owner_run_id] /
//!   [filter_tasks_by_owner]）。
//!
//! 接线契约：壳层（apps/agent-workbench，T-AB-16/C3）在任务终态发射
//! 事件的同时调用本模块消费入口（[TaskWakeBatch::push] 收集摘要、
//! [TaskAuditAccumulator::push] 聚合审计、[steer_for_task_failed] 写
//! steering 队列）；run idle / 用户消息边界由引擎把 [PendingMessageQueue]
//! 经 transfer_follow_up 批量注入（steering_queue.rs 既有能力，D8 裁决）。

use std::collections::BTreeMap;
use std::sync::Arc;

use conex_types::events::{AgentEvent, SecurityAuditDecision, SecurityAuditOperation};
use conex_types::impact::ImpactAssessment;

use crate::events::{EventQueue, PersistError};
use crate::now_iso_utc;
use crate::persist::Store;
use crate::steering_queue::{PendingMessageQueue, SteeringInputEntry};

// ── 唤醒摘要（REQ-C04 四模板，01 方案 §4.5 通知文案冻结）────────────

/// 组装任务终态唤醒摘要（四类事件各一模板；其余事件返回 None）。
///
/// 文案冻结（01 方案 §4.5 表 + T-AB-18 验收快照）：
/// - task-completed：`任务 <id> 已完成，退出码 <N>`；
/// - task-failed：`任务 <id> 异常退出（exit code <N>），附最后 20 行日志`；
/// - task-suspicious：`任务 <id> 疑似卡死（<M> 秒无输出）`（静默毫秒转秒）；
/// - task-killed：`任务 <id> 已被终止`。
pub fn task_wake_summary(event: &AgentEvent) -> Option<String> {
    match event {
        AgentEvent::TaskCompleted {
            task_id, exit_code, ..
        } => Some(format!("任务 {task_id} 已完成，退出码 {exit_code}")),
        AgentEvent::TaskFailed {
            task_id, exit_code, ..
        } => Some(format!(
            "任务 {task_id} 异常退出（exit code {exit_code}），附最后 20 行日志"
        )),
        AgentEvent::TaskSuspicious {
            task_id,
            silence_ms,
            ..
        } => {
            let seconds = silence_ms.div_ceil(1000);
            Some(format!("任务 {task_id} 疑似卡死（{seconds} 秒无输出）"))
        }
        AgentEvent::TaskKilled { task_id, .. } => Some(format!("任务 {task_id} 已被终止")),
        _ => None,
    }
}

// ── 批量注入组装（REQ-D07：run idle / 用户消息边界，同 run 合并一条）─

/// 按 run 聚合的唤醒摘要批次。
///
/// 语义（T-AB-18 验收「摘要注入为批量」）：同一 run 内多个任务终态
/// 合并为**一条**注入（[Self::drain_merged] 换行拼接后经
/// [build_wake_steering_entry] 入队），不逐条打断——对齐 REQ-D07
/// 「run idle / 下一条用户消息边界批量推送」；同任务多次终态
/// （如先 suspicious 后 completed）原位替换，只保留最新摘要。
#[derive(Debug, Clone, Default)]
pub struct TaskWakeBatch {
    /// task_id → 摘要（BTreeMap 保证合并文本按任务 id 有序，输出确定）
    entries: BTreeMap<String, String>,
}

impl TaskWakeBatch {
    /// 新建空批次
    pub fn new() -> Self {
        Self::default()
    }

    /// 消费一个任务终态事件（completed/failed/killed/suspicious）。
    ///
    /// 返回 `true` 表示产出了新摘要（事件被消费）；同任务已存在旧摘要
    /// 时原位替换（保留最新终态，不重复注入）。
    pub fn push(&mut self, event: &AgentEvent) -> bool {
        let Some(summary) = task_wake_summary(event) else {
            return false;
        };
        let task_id = match event {
            AgentEvent::TaskCompleted { task_id, .. }
            | AgentEvent::TaskFailed { task_id, .. }
            | AgentEvent::TaskSuspicious { task_id, .. }
            | AgentEvent::TaskKilled { task_id, .. } => task_id.clone(),
            _ => return false,
        };
        self.entries.insert(task_id, summary);
        true
    }

    /// 取出全部摘要合并为一条文本（换行拼接，按任务 id 有序）并清空批次。
    ///
    /// 返回 None 表示批次为空（无注入内容）。
    pub fn drain_merged(&mut self) -> Option<String> {
        if self.entries.is_empty() {
            return None;
        }
        let merged = self
            .entries
            .values()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        self.entries.clear();
        Some(merged)
    }

    /// 是否有待注入摘要
    pub fn has_pending(&self) -> bool {
        !self.entries.is_empty()
    }

    /// 当前批次任务数
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 清空批次
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

/// 批量注入 steering 条目分组名（同 run 合并注入，replaceOrEnqueue 去重）
pub const TASK_WAKE_GROUP_ID: &str = "task-wake";

/// 把合并后的唤醒文本构造成 steering 条目（is_steering 受保护位，
/// 容量挤占时不淘汰；group_id = [TASK_WAKE_GROUP_ID] 去重）。
pub fn build_wake_steering_entry(text: String) -> SteeringInputEntry {
    SteeringInputEntry {
        id: TASK_WAKE_GROUP_ID.to_string(),
        text,
        attachments: Vec::new(),
        enqueued_at: crate::now_ms() as u64,
        group_id: Some(TASK_WAKE_GROUP_ID.to_string()),
        is_steering: true,
    }
}

// ── C7 衔接（task-failed → steering，group_id=`task-<id>` 原位去重）──

/// 任务 steering 分组名（`task-<id>`，对齐 recovery.rs 阶梯 2 的
/// `recovery-<run_id>` 分组先例；replaceOrEnqueue 原位替换去重）
pub fn task_steering_group_id(task_id: &str) -> String {
    format!("task-{task_id}")
}

/// 构造 task-failed 的 C7 steering 条目。
///
/// 对齐 [crate::recovery::build_steering_entry] 先例：is_steering 受保护
/// 位 + group_id 分组去重 + id 含任务 id 保证幂等。文案复用唤醒摘要
/// （「任务 <id> 异常退出（exit code N），附最后 20 行日志」）。
pub fn build_task_failed_steering_entry(event: &AgentEvent) -> Option<SteeringInputEntry> {
    let AgentEvent::TaskFailed { task_id, .. } = event else {
        return None;
    };
    let text = task_wake_summary(event)?;
    Some(SteeringInputEntry {
        id: format!("task-failed-{task_id}"),
        text,
        attachments: Vec::new(),
        enqueued_at: crate::now_ms() as u64,
        group_id: Some(task_steering_group_id(task_id)),
        is_steering: true,
    })
}

/// C7 写入侧：task-failed 经 [PendingMessageQueue] 写 steering 条目。
///
/// 同任务重复失败原位替换（[PendingMessageQueue::replace_or_enqueue]），
/// 返回 `true` 表示发生了替换（第二次及以后的失败不新增条目）。
///
/// 「AI 显式等待关键任务」的判定由接线方在调用前裁决（本模块只投递
/// 不重试）；非 task-failed 事件直接返回 false 不写队列。
pub fn steer_for_task_failed(queue: &mut PendingMessageQueue, event: &AgentEvent) -> bool {
    let Some(entry) = build_task_failed_steering_entry(event) else {
        return false;
    };
    queue.replace_or_enqueue(entry)
}

// ── security-audit 审计留痕（任务启停/终止/归档聚合）───────────────

/// 任务审计结果（`TaskAuditRecord.result` wire 值）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskAuditResult {
    /// 任务启动（adopt 成功）
    Started,
    /// 任务自然退出且退出码为 0
    Completed,
    /// 任务自然退出且退出码非 0
    Failed,
    /// 任务被终止（含两阶段升级）
    Killed,
    /// 任务归档（30 分钟内存条目清理；壳层 T-AB-16 接线位）
    Archived,
}

impl TaskAuditResult {
    /// wire 名（kebab-case）
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Killed => "killed",
            Self::Archived => "archived",
        }
    }
}

/// 任务操作者（`TaskAuditRecord.operator`：AI 工具调用 / 用户命令）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskAuditOperator {
    /// AI 工具调用（携带工具调用 id，审计可回溯；LK-03 空串消解：
    /// 有工具调用上下文传真值 / 无上下文置 None，禁空串）
    AiTool {
        /// 工具调用 id（工具发起时真值；无工具调用上下文时为 None，非空串）
        tool_call_id: Option<String>,
    },
    /// 用户命令（任务由用户命令行发起）
    UserCommand,
}

/// 任务域审计记录（T-AB-18 要求五要素：taskId / command 摘要 / 操作者 /
/// 时间戳 / 结果；聚合器内部维护，事件发射时经 security-audit 落库）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAuditRecord {
    /// 任务 id（后台任务注册表主键）
    pub task_id: String,
    /// 命令摘要（人读，含 argv 摘要；来自 task-started 的 command 字段）
    pub command: String,
    /// 操作者（AI 工具调用 / 用户命令）
    pub operator: TaskAuditOperator,
    /// 发生时间（epoch 毫秒）
    pub at_ms: u64,
    /// 结果（started/completed/failed/killed/archived）
    pub result: TaskAuditResult,
}

/// 任务审计结果 → security-audit 处置决策（审计流展示位语义）。
///
/// decision 原语义为「安全处置」（blocked/approved/denied/...），任务域
/// 审计的结果精度由 [TaskAuditRecord.result] 承载，此处仅作审计流展示
/// 映射：启动/成功 → approved（执行已批准且生效）、失败 → denied（执行
/// 未成功）、被终止 → blocked（未自然完成）。
pub fn task_audit_decision(result: TaskAuditResult) -> SecurityAuditDecision {
    match result {
        TaskAuditResult::Started | TaskAuditResult::Completed | TaskAuditResult::Archived => {
            SecurityAuditDecision::Approved
        }
        TaskAuditResult::Failed => SecurityAuditDecision::Denied,
        TaskAuditResult::Killed => SecurityAuditDecision::Blocked,
    }
}

/// 构造任务域 security-audit 事件。
///
/// 形态对齐 agent-tools shell.rs 红线拦截先例（operation=command-exec，
/// targets 承载命令文本）：本模块 targets 承载**任务 id**（审计面板按
/// 任务检索）、tool_call_id 承载 AI 工具调用 id（工具发起传真值 /
/// 无工具调用上下文 None，禁空串；用户命令时为 None）、impact 为空
/// 影响面（任务域无文件影响面语义）。
pub fn build_task_audit_event(session_id: &str, record: &TaskAuditRecord) -> AgentEvent {
    let tool_call_id = match &record.operator {
        TaskAuditOperator::AiTool { tool_call_id } => tool_call_id.clone(),
        TaskAuditOperator::UserCommand => None,
    };
    AgentEvent::SecurityAudit {
        session_id: session_id.to_string(),
        timestamp: now_iso_utc(),
        operation: SecurityAuditOperation::CommandExec,
        targets: vec![record.task_id.clone()],
        impact: ImpactAssessment::default(),
        decision: task_audit_decision(record.result),
        permission_mode: None,
        tool_call_id,
    }
}

/// 任务审计聚合器（启停/终止/归档留痕：记录 + security-audit 事件发射）。
///
/// - task-started 记忆 task_id → command 摘要，供终态记录回填命令摘要
///   （completed/failed/killed 事件体不含 command 字段）；
/// 默认审计记录上限（DEC-04 裁决：有界容量防泄漏）
pub const DEFAULT_MAX_AUDIT_RECORDS: usize = 1000;
/// 默认临时命令摘要映射上限
pub const DEFAULT_MAX_COMMANDS: usize = 1000;

/// 任务安全审计记录聚合器（T-AB-18）
///
/// 承载会话内全部后台任务的审计流水（started / completed / failed /
/// killed / archived），供 [Self::emit_audit_events] 批量落库。
///
/// - 有界容量与 FIFO 淘汰（DEC-04 裁决：默认 1000 条上限，超限淘汰最早记录）；
/// - 终态即时释放 `commands` 临时映射（防长期运行内存泄漏）；
/// - 同 (task_id, result) 原位替换（重复终态只留一条，防无限增长）；
/// - [Self::record_archive] 为归档审计入口（无 task-archived 事件类型，
///   由壳层 T-AB-16 在 30 分钟归档时接线调用）。
pub struct TaskAuditAccumulator {
    /// task_id → command 摘要（task-started 记忆，有界容量）
    commands: BTreeMap<String, String>,
    /// 审计记录（按发生顺序；同 task+result 原位替换，有界 FIFO 队列）
    records: Vec<TaskAuditRecord>,
    /// 审计记录最大容量
    max_records: usize,
}

impl TaskAuditAccumulator {
    /// 新建聚合器（默认 1000 条上限）
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_MAX_AUDIT_RECORDS)
    }

    /// 指定容量上限新建聚合器
    pub fn with_capacity(max_records: usize) -> Self {
        Self {
            commands: BTreeMap::new(),
            records: Vec::new(),
            max_records,
        }
    }

    /// 消费一个任务事件（started/completed/failed/killed）聚合审计记录。
    ///
    /// 操作者由接线方传入（壳层知道任务由 AI 工具调用还是用户命令
    /// 发起）；返回 `true` 表示产生了审计记录。
    /// 进入终态（Completed / Failed / Killed）时即时清理 `commands` 映射。
    pub fn push(&mut self, event: &AgentEvent, operator: TaskAuditOperator) -> bool {
        match event {
            AgentEvent::TaskStarted {
                task_id, command, ..
            } => {
                if self.commands.len() >= DEFAULT_MAX_COMMANDS {
                    if let Some(first_key) = self.commands.keys().next().cloned() {
                        self.commands.remove(&first_key);
                    }
                }
                self.commands.insert(task_id.clone(), command.clone());
                self.record(task_id.clone(), operator, TaskAuditResult::Started)
            }
            AgentEvent::TaskCompleted { task_id, .. } => {
                let ok = self.record(task_id.clone(), operator, TaskAuditResult::Completed);
                self.commands.remove(task_id);
                ok
            }
            AgentEvent::TaskFailed { task_id, .. } => {
                let ok = self.record(task_id.clone(), operator, TaskAuditResult::Failed);
                self.commands.remove(task_id);
                ok
            }
            AgentEvent::TaskKilled { task_id, .. } => {
                let ok = self.record(task_id.clone(), operator, TaskAuditResult::Killed);
                self.commands.remove(task_id);
                ok
            }
            _ => false,
        }
    }

    /// 归档审计入口（无 task-archived 事件类型；壳层 T-AB-16 在 30 分钟
    /// 归档时接线调用；command 摘要由调用方提供——归档时内存命令映射
    /// 已随条目清理）
    pub fn record_archive(
        &mut self,
        task_id: &str,
        command: &str,
        operator: TaskAuditOperator,
        at_ms: u64,
    ) -> bool {
        self.commands.remove(task_id);
        self.record_with(
            task_id.to_string(),
            command.to_string(),
            operator,
            at_ms,
            TaskAuditResult::Archived,
        )
    }

    /// 聚合记录（同 task+result 原位替换，防重复终态无限增长）
    fn record(
        &mut self,
        task_id: String,
        operator: TaskAuditOperator,
        result: TaskAuditResult,
    ) -> bool {
        let at_ms = crate::now_ms() as u64;
        let command = self.commands.get(&task_id).cloned().unwrap_or_default();
        self.record_with(task_id, command, operator, at_ms, result)
    }

    /// 聚合记录落位（同 task+result 原位替换，超限 FIFO 淘汰）
    fn record_with(
        &mut self,
        task_id: String,
        command: String,
        operator: TaskAuditOperator,
        at_ms: u64,
        result: TaskAuditResult,
    ) -> bool {
        let record = TaskAuditRecord {
            task_id,
            command,
            operator,
            at_ms,
            result,
        };
        if let Some(existing) = self
            .records
            .iter_mut()
            .find(|r| r.task_id == record.task_id && r.result == record.result)
        {
            *existing = record;
            return true;
        }
        if self.records.len() >= self.max_records {
            self.records.remove(0);
        }
        self.records.push(record);
        true
    }

    /// 全部审计记录（按发生顺序）
    pub fn records(&self) -> &[TaskAuditRecord] {
        &self.records
    }

    /// 审计记录总数
    pub fn count(&self) -> usize {
        self.records.len()
    }

    /// 指定结果的记录数（验收断言「审计留痕计数」）
    pub fn count_by_result(&self, result: TaskAuditResult) -> usize {
        self.records.iter().filter(|r| r.result == result).count()
    }

    /// 逐条发射 security-audit 事件（经 [EventQueue] 落库，Critical 必达）。
    ///
    /// 返回发射条数；任一条落库失败即返回错误（审计必达语义，
    /// 不静默吞掉）。
    pub async fn emit_audit_events(
        &self,
        store: Arc<dyn Store>,
        session_id: &str,
    ) -> Result<usize, PersistError> {
        // D-01 DM-04：任务域审计事件无 run 归属（队列绑 None = 会话域）
        let mut queue = EventQueue::new(store, 1, None);
        let mut count = 0;
        for record in &self.records {
            queue
                .push(session_id, build_task_audit_event(session_id, record))
                .await?;
            count += 1;
        }
        Ok(count)
    }
}

impl Default for TaskAuditAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

// ── task-started 的 ownerRunId 来源过滤 ────────────────────────────

/// 提取任务来源 run id（仅 task-started 携带 ownerRunId；其余事件 None）。
pub fn task_owner_run_id(event: &AgentEvent) -> Option<&str> {
    match event {
        AgentEvent::TaskStarted { owner_run_id, .. } => Some(owner_run_id.as_str()),
        _ => None,
    }
}

/// 按来源过滤任务事件（主 agent 与其派发的子 agent run 按来源归组）。
///
/// 只保留 owner_run_id 与目标 run 一致的事件；不携带 ownerRunId 的
/// 非 started 事件一并过滤（来源过滤仅对 started 流生效，T-AB-18 第 4 点）。
pub fn filter_tasks_by_owner<'a>(
    events: impl IntoIterator<Item = &'a AgentEvent>,
    owner_run_id: &str,
) -> Vec<&'a AgentEvent> {
    events
        .into_iter()
        .filter(|e| task_owner_run_id(e) == Some(owner_run_id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persist::InMemoryStore;
    use conex_types::events::AgentEvent;

    const TS: &str = "2026-08-04T00:00:00.000Z";

    fn started(task_id: &str, owner: &str) -> AgentEvent {
        AgentEvent::TaskStarted {
            session_id: "s1".into(),
            task_id: task_id.into(),
            command: "cargo build".into(),
            cwd: "/ws".into(),
            owner_run_id: owner.into(),
            is_daemon: false,
        }
    }

    fn completed(task_id: &str, exit_code: i32) -> AgentEvent {
        AgentEvent::TaskCompleted {
            session_id: "s1".into(),
            task_id: task_id.into(),
            exit_code,
            duration_ms: 1200,
            line_count: 99,
        }
    }

    fn failed(task_id: &str, exit_code: i32) -> AgentEvent {
        AgentEvent::TaskFailed {
            session_id: "s1".into(),
            task_id: task_id.into(),
            exit_code,
            tail: vec!["最后一行".into()],
            duration_ms: 800,
        }
    }

    fn suspicious(task_id: &str, silence_ms: u64) -> AgentEvent {
        AgentEvent::TaskSuspicious {
            session_id: "s1".into(),
            task_id: task_id.into(),
            silence_ms,
            last_output_at_ms: 1_785_456_000_000,
        }
    }

    fn killed(task_id: &str) -> AgentEvent {
        AgentEvent::TaskKilled {
            session_id: "s1".into(),
            task_id: task_id.into(),
            via_force: true,
            diagnostics: None,
        }
    }

    // ── 唤醒摘要快照（T-AB-18 验收：task-completed 摘要快照断言）──

    #[test]
    fn completed_summary_snapshot() {
        assert_eq!(
            task_wake_summary(&completed("t-1", 0)).as_deref(),
            Some("任务 t-1 已完成，退出码 0"),
            "completed 摘要模板（快照）"
        );
    }

    #[test]
    fn failed_summary_snapshot() {
        assert_eq!(
            task_wake_summary(&failed("t-1", 7)).as_deref(),
            Some("任务 t-1 异常退出（exit code 7），附最后 20 行日志"),
            "failed 摘要模板（快照）"
        );
    }

    #[test]
    fn suspicious_summary_snapshot_seconds_rounded_up() {
        // 65000ms → 65 秒；1ms → 1 秒（向上取整，非零静默必展示秒数）
        assert_eq!(
            task_wake_summary(&suspicious("t-1", 65_000)).as_deref(),
            Some("任务 t-1 疑似卡死（65 秒无输出）"),
            "suspicious 摘要模板（快照）"
        );
        assert_eq!(
            task_wake_summary(&suspicious("t-1", 1)).as_deref(),
            Some("任务 t-1 疑似卡死（1 秒无输出）"),
            "静默毫秒向上取整到秒"
        );
    }

    #[test]
    fn killed_summary_snapshot() {
        assert_eq!(
            task_wake_summary(&killed("t-1")).as_deref(),
            Some("任务 t-1 已被终止"),
            "killed 摘要模板（快照）"
        );
    }

    #[test]
    fn non_terminal_events_have_no_summary() {
        assert_eq!(task_wake_summary(&started("t-1", "run-main")), None);
        assert_eq!(
            task_wake_summary(&AgentEvent::AgentStart {
                session_id: "s1".into(),
                timestamp: TS.into(),
            }),
            None
        );
    }

    // ── 批量注入（T-AB-18 验收：同 run 多终态合并为一条注入）──

    #[test]
    fn wake_batch_merges_multiple_terminal_events_into_one_injection() {
        let mut batch = TaskWakeBatch::new();
        assert!(batch.push(&completed("t-1", 0)));
        assert!(batch.push(&failed("t-2", 1)));
        assert!(batch.push(&killed("t-3")));
        assert_eq!(batch.len(), 3);
        let merged = batch.drain_merged().expect("批次非空必有合并文本");
        // 同 run 三个任务终态合并为一条注入（换行拼接，任务 id 有序）
        assert_eq!(
            merged,
            "任务 t-1 已完成，退出码 0\n\
             任务 t-2 异常退出（exit code 1），附最后 20 行日志\n\
             任务 t-3 已被终止"
        );
        assert!(batch.is_empty(), "drain 后批次清空");
        assert_eq!(batch.drain_merged(), None, "空批次无注入");
    }

    #[test]
    fn wake_batch_replaces_same_task_terminal_in_place() {
        let mut batch = TaskWakeBatch::new();
        // 同任务先 suspicious 后 completed：原位替换，只留最新终态
        assert!(batch.push(&suspicious("t-1", 65_000)));
        assert!(batch.push(&completed("t-1", 0)));
        assert_eq!(batch.len(), 1, "同任务多终态原位替换");
        assert_eq!(
            batch.drain_merged().as_deref(),
            Some("任务 t-1 已完成，退出码 0"),
            "保留最新摘要"
        );
    }

    #[test]
    fn wake_steering_entry_is_protected_and_grouped() {
        let entry = build_wake_steering_entry("任务 t-1 已完成，退出码 0".into());
        assert!(entry.is_steering, "批量注入为 steering 受保护位");
        assert_eq!(entry.group_id.as_deref(), Some(TASK_WAKE_GROUP_ID));
        assert_eq!(entry.id, TASK_WAKE_GROUP_ID);
        // 同 run 二次合并注入按 group 去重（队列层 replaceOrEnqueue）
        let mut queue = PendingMessageQueue::new();
        let first = queue.replace_or_enqueue(build_wake_steering_entry(
            "任务 t-1 已完成，退出码 0".into(),
        ));
        let second = queue.replace_or_enqueue(build_wake_steering_entry(
            "任务 t-1 已完成，退出码 0\n任务 t-2 已被终止".into(),
        ));
        assert!(!first && second, "同分组重复注入原位替换");
        assert_eq!(queue.len(), 1);
        assert_eq!(
            queue.peek().unwrap().group_id.as_deref(),
            Some(TASK_WAKE_GROUP_ID)
        );
    }

    // ── C7 衔接（T-AB-18 验收：task-failed steering 条目去重）──

    #[test]
    fn failed_steering_entry_group_and_protection_bit() {
        let entry =
            build_task_failed_steering_entry(&failed("t-1", 1)).expect("task-failed 有条目");
        assert_eq!(
            entry.group_id.as_deref(),
            Some("task-t-1"),
            "group_id=task-<id>"
        );
        assert!(entry.is_steering, "is_steering 受保护位");
        assert_eq!(entry.id, "task-failed-t-1");
        assert_eq!(
            entry.text,
            "任务 t-1 异常退出（exit code 1），附最后 20 行日志"
        );
        // 非 task-failed 事件不产生条目
        assert_eq!(build_task_failed_steering_entry(&completed("t-1", 0)), None);
        assert_eq!(build_task_failed_steering_entry(&started("t-1", "r")), None);
    }

    #[test]
    fn failed_steering_dedup_on_repeat_failure() {
        let mut queue = PendingMessageQueue::new();
        // 第一次失败：新条目
        assert!(!steer_for_task_failed(&mut queue, &failed("t-1", 1)));
        assert_eq!(queue.len(), 1);
        // 重复失败（同任务）：原位替换，不新增条目（C7 去重验收）
        assert!(steer_for_task_failed(&mut queue, &failed("t-1", 3)));
        assert_eq!(queue.len(), 1, "重复失败原位替换去重");
        assert_eq!(
            queue.peek().unwrap().text,
            "任务 t-1 异常退出（exit code 3），附最后 20 行日志",
            "替换后条目携带最新退出码"
        );
        // 不同任务：各自独立分组
        assert!(!steer_for_task_failed(&mut queue, &failed("t-2", 2)));
        assert_eq!(queue.len(), 2);
        // 非 task-failed：不写队列
        assert!(!steer_for_task_failed(&mut queue, &completed("t-3", 0)));
        assert_eq!(queue.len(), 2);
    }

    // ── security-audit 留痕（T-AB-18 验收：审计事件计数与字段）──

    #[test]
    fn audit_records_started_completed_killed_counts() {
        let mut acc = TaskAuditAccumulator::new();
        let ai = TaskAuditOperator::AiTool {
            tool_call_id: Some("tc-1".into()),
        };
        assert!(acc.push(&started("t-1", "run-main"), ai.clone()));
        assert!(acc.push(&completed("t-1", 0), ai.clone()));
        assert!(acc.push(&killed("t-2"), TaskAuditOperator::UserCommand));
        assert_eq!(acc.count(), 3, "启/完/杀各一条审计记录");
        assert_eq!(acc.count_by_result(TaskAuditResult::Started), 1);
        assert_eq!(acc.count_by_result(TaskAuditResult::Completed), 1);
        assert_eq!(acc.count_by_result(TaskAuditResult::Killed), 1);
        assert_eq!(acc.count_by_result(TaskAuditResult::Failed), 0);

        // 记录字段：taskId / command 摘要（来自 task-started 记忆）/ 操作者 / 时间戳 / 结果
        let completed_rec = acc
            .records()
            .iter()
            .find(|r| r.result == TaskAuditResult::Completed)
            .expect("有 completed 记录");
        assert_eq!(completed_rec.task_id, "t-1");
        assert_eq!(
            completed_rec.command, "cargo build",
            "command 摘要来自 task-started"
        );
        assert_eq!(completed_rec.operator, ai);
        assert!(completed_rec.at_ms > 0, "时间戳必填");
    }

    #[test]
    fn audit_same_task_same_result_replaces_in_place() {
        let mut acc = TaskAuditAccumulator::new();
        let ai = TaskAuditOperator::AiTool {
            tool_call_id: Some("tc-1".into()),
        };
        acc.push(&started("t-1", "run-main"), ai.clone());
        // 同任务两次 completed（如重试后成功）：只留一条，防无限增长
        acc.push(&completed("t-1", 1), ai.clone());
        acc.push(&completed("t-1", 0), ai.clone());
        assert_eq!(
            acc.count_by_result(TaskAuditResult::Completed),
            1,
            "同 task+result 原位替换"
        );
    }

    #[test]
    fn audit_archive_entry_interface() {
        let mut acc = TaskAuditAccumulator::new();
        assert!(acc.record_archive(
            "t-9",
            "cargo build",
            TaskAuditOperator::UserCommand,
            1_785_456_000_000,
        ));
        assert_eq!(acc.count_by_result(TaskAuditResult::Archived), 1);
        assert_eq!(acc.records()[0].at_ms, 1_785_456_000_000, "归档时间戳透传");
    }

    #[tokio::test]
    async fn audit_events_emitted_with_command_exec_shape() {
        let mem = Arc::new(InMemoryStore::new());
        let store: Arc<dyn Store> = mem.clone();
        let mut acc = TaskAuditAccumulator::new();
        acc.push(
            &started("t-1", "run-main"),
            TaskAuditOperator::AiTool {
                tool_call_id: Some("tc-9".into()),
            },
        );
        acc.push(&failed("t-1", 2), TaskAuditOperator::UserCommand);
        acc.push(&completed("t-2", 0), TaskAuditOperator::UserCommand);

        let emitted = acc
            .emit_audit_events(store, "s1")
            .await
            .expect("审计事件落库");
        assert_eq!(emitted, 3, "每条审计记录发射一条 security-audit");

        let stored = mem.events();
        let audits: Vec<_> = stored
            .iter()
            .filter(|e| e.event_type == "security-audit")
            .collect();
        assert_eq!(audits.len(), 3, "security-audit 落库三条");
        for row in &audits {
            let event: AgentEvent = serde_json::from_str(&row.payload).unwrap();
            match event {
                AgentEvent::SecurityAudit {
                    operation,
                    targets,
                    impact,
                    decision,
                    tool_call_id: _,
                    timestamp,
                    ..
                } => {
                    assert_eq!(operation, SecurityAuditOperation::CommandExec);
                    assert!(timestamp.contains('T'), "时间戳 ISO8601");
                    assert_eq!(impact, ImpactAssessment::default(), "任务域空影响面");
                    if targets[0] == "t-1" {
                        // t-1 先 failed 后 completed（不同 result 各留一条）
                        assert!(matches!(
                            decision,
                            SecurityAuditDecision::Denied | SecurityAuditDecision::Approved
                        ));
                    }
                }
                other => panic!("应为 security-audit，实际 {}", other.type_name()),
            }
        }
        // 操作者承载：AI 工具调用携带 toolCallId，用户命令为 None
        let first: AgentEvent = serde_json::from_str(&audits[0].payload).unwrap();
        match first {
            AgentEvent::SecurityAudit {
                tool_call_id,
                targets,
                ..
            } => {
                assert_eq!(targets[0], "t-1", "targets 承载任务 id（审计可检索）");
                assert_eq!(
                    tool_call_id.as_deref(),
                    Some("tc-9"),
                    "AI 工具调用操作者携带 toolCallId"
                );
            }
            _ => unreachable!(),
        }
        let second: AgentEvent = serde_json::from_str(&audits[1].payload).unwrap();
        match second {
            AgentEvent::SecurityAudit {
                tool_call_id,
                decision,
                ..
            } => {
                assert_eq!(tool_call_id, None, "用户命令无工具调用 id");
                assert_eq!(
                    decision,
                    SecurityAuditDecision::Denied,
                    "failed → denied 展示位"
                );
            }
            _ => unreachable!(),
        }
    }

    // ── ownerRunId 来源过滤（T-AB-18 第 4 点）──

    #[test]
    fn owner_run_id_extraction_and_filtering() {
        let events = vec![
            started("t-1", "run-main"),
            started("t-2", "run-sub-1"),
            completed("t-1", 0),
            started("t-3", "run-main"),
        ];
        assert_eq!(task_owner_run_id(&events[0]), Some("run-main"));
        assert_eq!(task_owner_run_id(&events[2]), None, "非 started 事件无来源");
        let main_tasks = filter_tasks_by_owner(events.iter(), "run-main");
        assert_eq!(main_tasks.len(), 2, "主 agent 来源两个任务");
        assert!(main_tasks
            .iter()
            .all(|e| task_owner_run_id(e) == Some("run-main")));
        let sub_tasks = filter_tasks_by_owner(events.iter(), "run-sub-1");
        assert_eq!(sub_tasks.len(), 1, "子 agent 来源一个任务");
        assert_eq!(task_owner_run_id(sub_tasks[0]), Some("run-sub-1"));
    }

    #[test]
    fn audit_capacity_fifo_eviction() {
        let mut acc = TaskAuditAccumulator::with_capacity(3);
        let ai = TaskAuditOperator::AiTool { tool_call_id: None };
        acc.push(&started("t-1", "run-main"), ai.clone());
        acc.push(&started("t-2", "run-main"), ai.clone());
        acc.push(&started("t-3", "run-main"), ai.clone());
        assert_eq!(acc.count(), 3);
        assert_eq!(acc.records()[0].task_id, "t-1");

        // 插入第 4 条，t-1 被 FIFO 淘汰
        acc.push(&started("t-4", "run-main"), ai.clone());
        assert_eq!(acc.count(), 3);
        assert_eq!(acc.records()[0].task_id, "t-2");
        assert_eq!(acc.records()[1].task_id, "t-3");
        assert_eq!(acc.records()[2].task_id, "t-4");
    }

    #[test]
    fn audit_terminal_cleans_commands_map() {
        let mut acc = TaskAuditAccumulator::new();
        let ai = TaskAuditOperator::AiTool { tool_call_id: None };
        acc.push(&started("t-1", "run-main"), ai.clone());
        assert_eq!(acc.commands.get("t-1").map(String::as_str), Some("cargo build"));

        // completed 后 commands 映射即时释放
        acc.push(&completed("t-1", 0), ai.clone());
        assert_eq!(acc.commands.get("t-1"), None);
    }
}
