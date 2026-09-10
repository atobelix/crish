//! orchestrator crate（B4：会话/run 管理、事件持久化）
//!
//! - [`run`]：run 生命周期管理（B4.1）——[run::RunHandle] / run 状态机 /
//!   审批挂起恢复 / cancel 三路径（L2 协作、L3 强制、模式回落
//!   cooperative-fallback-force）；
//! - [`events`]：事件序列与持久化分流（B4.2）——sequence 连续分配、
//!   message-delta/thought-delta 非持久化不阻塞、run-terminal 唯一终态事件；
//! - [`flow_graph`]：C6 依赖图调度器（I5-M6）——[flow_graph::FlowNode]
//!   声明 / staged-clone 环检测 / gate 强制 / on_failed 三策略 /
//!   并发预算 reserve-release / 重启恢复 / 合成唤醒（事件驱动不轮询）；
//! - [`persist`]：事件存储连接抽象（B4.2）——[persist::Store] trait
//!   （insert_run/update_run_status/append_event/query_events/query_runs/
//!   pending 输入 API），内存实现（测试用）+ conex-db 实现（SQLite
//!   生产路径）；
//! - [`session`]：会话树与 conversation-rewind 计划（B4.3）——
//!   [session::SessionTree]（追加/分叉/叶子移动 + expected_current_leaf
//!   校验）、[session::SessionRecord]（会话记录）、[session::RewindPlan]
//!   与执行骨架（取消 run → 清审批 → 恢复检查点 → 移动叶子）；
//! - [`restore`]：重启恢复与状态快照（B4.3）——in-flight → interrupted
//!   （previousStatus 审计）、blocked/终态保真、pending FIFO 恢复、
//!   全量/增量快照 + 损坏回退；
//! - [`recovery`]：C7 四级恢复阶梯 + 恢复预算制（I6-M9）——
//!   [recovery::RecoveryCoordinator]（阶梯 1 自动重试 → 阶梯 2 主 agent
//!   激活 steering → 阶梯 3 fork 三态上下文继承 → 阶梯 4 上报用户），
//!   操作指纹 + Episode 预算（`recover_*` 键命名空间）；
//! - [`lifecycle`]：子代理生命周期补缺（T-D-09）——kill_all 批量终止
//!   （过滤 running 子代理 + L3 强停投递 + 终态归一 failed）与
//!   resume_subagent 显式恢复（fork_and_reassign 消费端命令面，共用
//!   Episode 预算池）；
//! - [`task_events`]：任务域事件唤醒消费面（T-AB-18）——唤醒摘要批量
//!   注入（[task_events::TaskWakeBatch]）、security-audit 审计留痕
//!   （[task_events::TaskAuditAccumulator]）、C7 衔接
//!   （[task_events::steer_for_task_failed]）、ownerRunId 来源过滤；
//! - [`goal_state`]：D5 goal 引擎化纯函数侧——[goal_state::GoalState]
//!   （session_meta `goal_state` 键形状，fail-open JSON 解析）、
//!   [goal_state::assess_round] 收口评估纯函数（L0+L1 完成门禁 /
//!   stalled 工具批指纹 / 轮数上限）、[goal_state::tool_batch_fingerprint]
//!   （工具批 FNV-1a 签名）；[normalize::allows_auto_continue] 的首个
//!   生产调用点（[goal_state::GoalState::goal_pending]）。
//!
//! 语义来源：05-test-mapping.md §2.8 / §5.4（run::drive / run::cancel /
//! run::approval / run::fail / run::restore / session::tree / store::pending /
//! rewind）、03-frontend-contract.md §3.2 A 组命令契约、
//! §5.2-2（终态别名收敛：run-terminal 为唯一终态）。
//!
//! 复用：session-loop 的 [session_loop::RunOutcome] 与 [session_loop::EndDecision]
//! 作为 run 收口类型（B3.4 产出，不重复定义）；conex-db 的 run/events/
//! pending_inputs 表落库；conex-types 的 [conex_types::events::RunTerminalStatus]
//! 与 [conex_types::events::AgentEvent] 作为事件唯一真源。

pub mod blocks;
pub mod events;
pub mod flow_graph;
pub mod goal_state;
pub mod lifecycle;
pub mod normalize;
pub mod persist;
pub mod recovery;
pub mod restore;
pub mod run;
pub mod session;
pub mod steering_queue;
pub mod subagent_events;
pub mod task_events;

pub use goal_state::{
    assess_round, GoalDecision, GoalState, RoundAssessment, RoundInput, ToolCallStamp,
    DEFAULT_GOAL_MAX_ROUNDS, DEFAULT_GOAL_MAX_STALLED_ROUNDS, GOAL_STATE_KEY,
};
pub use normalize::{
    allows_auto_continue, is_terminal_event, normalize_envelope, terminal_status_for_end_reason,
};
pub use steering_queue::PendingMessageQueue;

/// 当前 UTC 毫秒时间戳（epoch ms，run 记录与事件共用）
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}
