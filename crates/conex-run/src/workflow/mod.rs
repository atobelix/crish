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
//!
//! 模块划分（2026-10-27 拆自单文件 3.3k 行）：
//! - `schedule`：调度 wire 形状 + daily/interval ↔ cron 转换与校验；
//! - `model`：持久化模型（StoredWorkflow / 视图 / 运行记录与 pruning）；
//! - `store`：WorkflowStore 契约 + session_meta / 内存两实现；
//! - `sinks`：steering 与事件广播的动作契约；
//! - `launcher`：ScheduledTaskLauncher 生产实现（触发 → 装配 run）；
//! - `backend`：命令面聚合（create/list/update/delete/trigger/runs）。

mod backend;
mod launcher;
mod model;
mod schedule;
mod sinks;
mod store;

#[cfg(test)]
mod tests;

pub use backend::{parse_schedule_input, TriggerResult, WorkflowBackend, WorkflowPatch};
pub use launcher::{resolve_effective_workflow_cwd, ProductionScheduledLauncher};
pub use model::{prune_runs, StoredWorkflow, WorkflowRunRecord, WorkflowRunView, WorkflowView};
pub use schedule::WorkflowScheduleWire;
pub use sinks::{QueueSteeringSink, SteeringSink, WorkflowEventSink};
pub use store::{MemoryWorkflowStore, SessionMetaWorkflowStore, WorkflowStore};

/// cron id 前缀（`cron-<seq>`，§4.4 冻结命名）
pub(crate) const CRON_ID_PREFIX: &str = "cron-";

/// 当前 epoch 毫秒（workflow 全域时间基准；实现复用
/// [crate::engine_assembly::unix_millis_now]，全 crate 单一时间源）
pub(crate) fn now_ms() -> u64 {
    crate::engine_assembly::unix_millis_now()
}
