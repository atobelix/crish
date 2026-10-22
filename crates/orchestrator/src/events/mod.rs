//! 事件序列与持久化分流（任务书 B4.2）
//!
//! [EventQueue] 为 run 内事件分配连续 sequence（T08.12：实际取号走 store
//! 端会话级原子计数器，会话内全局单调、跨 run 不重置——Q23），
//! 并做持久化分流：
//! - message-delta / thought-delta 非持久化，不阻塞 drive loop
//!   （05 §2.8：orchestrator.test.ts:93-189 语义）；
//! - approval-requested 等持久化事件同步等待落库，保证中间态可观测
//!   （05 §2.8：orchestrator.test.ts:191-237 语义）；
//! - run-terminal 为唯一终态事件（03 §5.2-2：删 run-completed / run-failed /
//!   run-cancelled / run-ended 别名，终态判据统一为
//!   [conex_types::events::RunTerminalStatus]）；
//! - 持久化失败 → run 标记 failed(event-store-write-failed)，不假装可回放
//!   （05 §2.8：orchestrator.test.ts:239-289 语义）。
//!
//! [drive_outcome] 把 session-loop 的 [session_loop::RunOutcome] 事件流推入
//! 队列并按 [crate::run::map_outcome_to_terminal] 收口终态（复用 B3.4 收口
//! 类型，不重复定义）。

use conex_types::events::{event_policy, AgentEvent, PersistenceDecision};

use crate::persist::StoreError;

mod drive;
mod queue;

pub use drive::{
    build_run_terminal, drive_outcome, DriveOutcome, PersistFailureInfo, MAX_TURNS_FAILED_MESSAGE,
};
pub use queue::EventQueue;

/// 冻结护栏拒绝的 StoreError kind（T06.5.8 映射面未知 kind 兜底
/// store.write_failed + metadata.kind=retraction_freeze；判定走
/// [PersistError::is_retraction_freeze]，不依赖文案）
pub const RETRACTION_FREEZE_KIND: &str = "retraction_freeze";

/// 是否非持久化事件（D-04 PC-05 迁移：单一分类事实源 [event_policy] 的
/// persist 决策；delta/soft 增量不阻塞 drive loop——05 §2.8 语义不变）
pub fn is_non_persistent(event: &AgentEvent) -> bool {
    event_policy(event).persist == PersistenceDecision::NoPersist
}

/// 事件类型名（顶层 type，落库用；直接取 [AgentEvent::type_name]，
/// 不再构造信封克隆事件体）
pub fn event_type_name(event: &AgentEvent) -> &'static str {
    event.type_name()
}

/// 已入队事件（含序列号与落库标记）
#[derive(Debug, Clone, PartialEq)]
pub struct SequencedEvent {
    /// 序列号：持久化事件 = store 端已取号（会话内单调连续）；
    /// NoPersist（T-D1-A）= `last_reserved` 镜像（不推进计数器，
    /// 不代表新分配的序号——`persisted == false` 时调用面禁止据此
    /// 回退 `run.cursor`）
    pub sequence: u64,
    /// 事件
    pub event: AgentEvent,
    /// 是否已落库（NoPersist / delta 与失败路径的终态为 false）
    pub persisted: bool,
}

/// 持久化错误（携带失败事件上下文，供 run-failed 详情使用）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistError {
    /// 失败的序列号
    pub sequence: u64,
    /// 失败的事件类型
    pub event_type: String,
    /// 存储层错误
    pub error: StoreError,
}

impl PersistError {
    /// 冻结护栏拒绝构造（R1 边界冻结：冻结期内 `> frozen_seq` 的非撤离
    /// 写入；kind 取 [RETRACTION_FREEZE_KIND] 可判定）
    pub fn retraction_freeze(sequence: u64, frozen_seq: u64, event_type: &str) -> Self {
        Self {
            sequence,
            event_type: event_type.to_string(),
            error: StoreError::new(
                RETRACTION_FREEZE_KIND,
                format!(
                    "撤回冻结激活期内拒绝越过 frozen_seq={frozen_seq} 的非撤离写入（sequence={sequence}）"
                ),
            ),
        }
    }

    /// 是否为冻结护栏拒绝（区别于普通落库失败——冻结拒绝不标记
    /// run failed，见 drive_outcome 调用面）
    pub fn is_retraction_freeze(&self) -> bool {
        self.error.kind == RETRACTION_FREEZE_KIND
    }
}

impl std::fmt::Display for PersistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "事件 {} 落库失败（sequence={}）：{}",
            self.event_type, self.sequence, self.error
        )
    }
}

impl std::error::Error for PersistError {}

#[cfg(test)]
mod tests;
