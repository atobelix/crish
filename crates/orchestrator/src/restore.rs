//! 重启恢复与状态快照（任务书 B4.3）
//!
//! [RestoreManager::restore] 为冷启动恢复主流程（05 §5.4 run::restore /
//! store::pending）：
//! - **重启扫描**：从 [Store] 恢复全部 runs；in-flight run（queued /
//!   initializing / running / awaiting-approval / cancelling / **completing**）
//!   → 终态 interrupted（previousStatus 审计字段落库为 `run-interrupted`
//!   审计事件，终态变化可追溯；05 §2.8 orchestrator.test.ts:404 语义）；
//! - **blocked 终态保真**：blocked 类状态（Failed + goal-blocked 等 reason）
//!   与其它终态记录（completed / failed / cancelled）**原样保留不打断**
//!   （05 §2.8 orchestrator.test.ts:640 / :702 语义）；
//! - **未知字面量保真**：DB 行 / 快照中的未知状态字面量（裁决 D3，
//!   11-T1）以 `RunStatus::Unknown` 透传——既不打断也不改写，
//!   [RestoreOutcome::unknown_status_runs] 显式上报（诚实滞留取舍）；
//! - **pending 输入恢复**：从 conex-db load_pending_inputs 恢复（FIFO：
//!   创建时间升序，含 id 决胜；05 §2.8 orchestrator.test.ts:360 语义）；
//! - **快照**：全量快照（[StateSnapshot]）+ 增量恢复（lastSequence 后
//!   增量事件流）+ 损坏回退（checksum 校验，损坏时回退到上一完好备份
//!   快照，05 §2.8 orchestrator.test.ts:885 语义；无快照 → 全量重放）。
//! - **逐会话锚点**（PERSIST-02 P1-1）：快照携带每会话已重放的最大
//!   sequence（[StateSnapshot::session_last_sequence]），增量恢复按
//!   会话自身锚点取增量——不再用全会话 max 一刀切（事件序列为会话内
//!   独立，全局 max 作会话级 base 会永久跳过落后会话的快照后事件）；
//!   旧快照无逐会话锚点 → serde default 回退全局 last_sequence（兼容）。
//! - **session_agents 归一**（PERSIST-02 P1-3）：子代理运行中崩溃 →
//!   session_agents 行残留 running；restore 时对 running 行执行
//!   kill_all 语义归一（failed + ended_at），防 FlowScheduler 重建后
//!   节点永久 Running、流程卡死。
//!
//! 快照文件存储为「主文件 + .prev 备份」双文件模型：每次保存先轮转
//! （主文件 → 备份）再原子写入（tmp + rename），主文件损坏时回退备份。

use std::fmt;

use conex_db::{PendingInput, RunStatus, StoredRun};
use serde::{Deserialize, Serialize};

use crate::persist::StoreError;
use crate::session::{SessionRecord, SessionTreeError};

// SR-06d · 拆分 · ≠ EL：本文件为薄门面（恢复域核心类型 + 错误面），
// 逻辑域拆 2 模：
// - restore_snapshot.rs：快照数据形状（[StateSnapshot] / [SnapshotRun] /
//   [SnapshotPendingInput]）与文件存储（[SnapshotStore] /
//   [SnapshotFileStore]）（restore_snapshot::*）
// - restore_manager.rs：重启恢复主流程 [RestoreManager] 与状态判定
//   （restore_manager::*）
// 公开面经 `pub use` 重导出，orchestrator::restore::* 路径不 break；
// 测试旁挂 restore_tests.rs / restore_tests_snapshot.rs /
// restore_tests_continuity.rs / restore_tests_anchors.rs /
// restore_tests_agents.rs（include! 接线）。

#[path = "restore_manager.rs"]
mod restore_manager;
#[path = "restore_snapshot.rs"]
mod restore_snapshot;

pub use restore_manager::{is_blocked_reason, RestoreManager};
pub use restore_snapshot::{
    SnapshotError, SnapshotFileStore, SnapshotPendingInput, SnapshotRun, SnapshotStore,
    StateSnapshot, SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_TYPE,
};

/// in-flight → interrupted 的终态 reason（05 §2.8 orchestrator.test.ts:404）
pub const INTERRUPTED_REASON: &str = "daemon-restarted";
/// run 被打断的终态错误文案（非 cancelling 路径）
pub const INTERRUPTED_ERROR: &str = "Run was interrupted by daemon restart.";
/// 取消被打断的终态错误文案（cancelling 路径）
pub const CANCEL_INTERRUPTED_ERROR: &str = "Run cancellation was interrupted by daemon restart.";
/// 恢复审计事件类型名（previousStatus 审计字段落库）
pub const RUN_INTERRUPTED_EVENT: &str = "run-interrupted";

/// 恢复模式（05 §2.8 orchestrator.test.ts:1008 / :1066）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreMode {
    /// 无可用快照：从事件全量重放
    FullReplay,
    /// 快照有效：从 lastSequence 后增量流
    SnapshotIncremental,
}

/// interrupted 恢复审计记录（previousStatus 审计字段，终态变化可追溯）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedRun {
    /// run id
    pub run_id: String,
    /// 会话 id
    pub session_id: String,
    /// 原（in-flight）状态
    pub previous_status: String,
    /// 终态（failed / cancelled）
    pub status: String,
    /// 终态 reason（daemon-restarted）
    pub reason: String,
    /// 终态错误文案
    pub error: String,
    /// 审计时间戳（epoch ms）
    pub timestamp: i64,
}

/// 恢复结果
///
/// 说明：不派生 PartialEq/Eq——库内 [StoredRun] / [PendingInput] /
/// [SessionRecord] 未实现 Eq（字段比对用逐项断言）。
#[derive(Debug, Clone)]
pub struct RestoreOutcome {
    /// 恢复模式（全量重放 / 快照增量）
    pub mode: RestoreMode,
    /// 恢复的会话记录（快照会话 ∪ run 派生会话）
    pub sessions: Vec<SessionRecord>,
    /// 恢复的 run 记录（in-flight 已标记 interrupted）
    pub runs: Vec<StoredRun>,
    /// 恢复的待处理输入（FIFO）
    pub pending_inputs: Vec<PendingInput>,
    /// 本次恢复打断的 run（previousStatus 审计）
    pub interrupted: Vec<InterruptedRun>,
    /// 未知状态字面量保留的 run（run_id + 原字面量；裁决 D3，11-T1——
    /// 不打断、不改写，显式上报对冲「诚实滞留」）
    pub unknown_status_runs: Vec<(String, String)>,
    /// 事件流锚点（lastSequence：其后事件为增量流）
    pub last_sequence: u64,
    /// 快照回退说明（None = 未回退；快照损坏/缺失回退时含原因）
    pub snapshot_note: Option<String>,
    /// 已加载快照的代数（无快照 = 0；T08.6：恢复成功后立即保存快照时
    /// 以 generation+1 续接）
    pub snapshot_generation: u64,
}

/// 恢复错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreError {
    /// 错误类别（操作名）
    pub kind: String,
    /// 错误详情
    pub message: String,
}

impl RestoreError {
    /// 构造恢复错误
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for RestoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for RestoreError {}

impl From<StoreError> for RestoreError {
    fn from(err: StoreError) -> Self {
        Self::new(err.kind, err.message)
    }
}

impl From<SnapshotError> for RestoreError {
    fn from(err: SnapshotError) -> Self {
        Self::new(err.kind, err.message)
    }
}

impl From<SessionTreeError> for RestoreError {
    fn from(err: SessionTreeError) -> Self {
        Self::new("session.invalid_state", err.to_string())
    }
}

#[cfg(test)]
mod tests {
    // SR-06d · 拆分 · ≠ EL：测试旁挂分五段（crate-size 门禁对 src 内每个
    // 文件限 600 行，故用 include! 合成单一 tests 模块——测试路径
    // restore::tests::* 不 break）。
    #![allow(clippy::disallowed_methods)]
    include!("restore_tests.rs");
    include!("restore_tests_snapshot.rs");
    include!("restore_tests_continuity.rs");
    include!("restore_tests_anchors.rs");
    include!("restore_tests_agents.rs");
}
