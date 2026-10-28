//! run 域拆分接线（SR-02 · 拆分 · ≠ EL）
//!
//! core_run_commands.rs 门面（薄 barrel）→ run/ 目录 9 模：
//! - run_core：CoreRunState 单定义持有者 + ActiveRun + 审计/注入面 +
//!   连续性适配 + restore/snapshot 面（run_snapshot.rs 再拆）+ 生命周期；
//! - run_launch：run 装配命令面（run_task_impl / run_control / compact /
//!   cancel + finalize_failed 等收口辅助）；
//! - run_retry：重试阶梯 / 熔断计数 / 退避 / wake watcher / user_stopped；
//! - run_approval：ApprovalGateImpl + approve/deny + 审批历史/摘要；
//! - run_history：SessionHistoryCache + 历史转换 + 上下文预算；
//! - run_resume：续跑判定输入（ResumeSignals 族）+ goal 读写 + 恢复
//!   预算/子代理恢复阶梯 + production_resume_launcher；
//! - run_idle：mod idle_resume（decide_idle_resume / drive_run_loop /
//!   checkpoint / stage——opaque future 跨模块递归切断结构保持）；
//! - run_commands：后台任务命令 / 事件快照读取 / settings / id 工具 / trash。
//!
//! 接线约定：本模块聚合全部原 core_run_commands.rs 的 `use` 面（pub(crate)
//! 化）与顶层常量；9 模经 glob re-export 到本层，门面 `pub(crate) use run::*`
//! 保持既有 crate 内引用路径不 break。
//!
//! **去扁平化进度（2026-10-27，分阶段收敛中）**：run_history / run_retry /
//! run_snapshot / run_resume / run_approval / run_commands 已改为显式 import，
//! 不再依赖本层 `use` 面（本层只剩它们真正共享的符号）。**剩余 3 个模块与
//! tests.rs 仍用 `use super::*`**——run_core（类型定义枢纽）/ run_launch /
//! run_idle（含 1.5k 行内联测试），随下一步模块拆分（run_launch 测试外置、
//! idle_resume 升目录）一并显式化。新增代码请直接在子模块显式 import，
//! 不要扩充本层 `use` 面。

// ── 跨模块共享面（run/ 九模块统一经 `use super::*` 可见）──────────────
pub(crate) use std::collections::{HashMap, HashSet};
pub(crate) use std::future::Future;
pub(crate) use std::path::PathBuf;
pub(crate) use std::pin::Pin;
pub(crate) use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
pub(crate) use std::sync::{Arc, Mutex};

pub(crate) use agent_provider::request::build_system_prompt;
pub(crate) use agent_tools::audit::{AuditSink, SecurityAuditSink};
pub(crate) use agent_tools::background::BackgroundTaskManager;
pub(crate) use agent_tools::backup::BackupMiddleware;
pub(crate) use agent_tools::context::ExploreDocsQuotaContext;
// 审计 01 W1（任务连续性推进轮）：kill_subagent / send_message 三通道
// 生产实现（CoreRunState 契约面；经 ContinuityStateAdapter Weak 适配
// 注入引擎 ContinuityChannelBoard）
pub(crate) use agent_tools::tools::kill_subagent::{
    KillOutcomeKind, KillSubagentToolResult, SubagentKillChannel,
};
pub(crate) use agent_tools::tools::send_message::{
    MainAgentMessageChannel, MainMessageRing, SubagentInjectChannel,
};
pub(crate) use agent_tools::tools::subagent::SubagentState;
pub(crate) use agent_tools::write_paths::{WritePathPolicy, WritePathRegistry};
pub(crate) use conex_db::LocalDb;
// E2 F4（手动压缩命令面）：LlmRequired = 无 Summarizer / 摘要失败 → 放弃
// 压缩（禁止纯丢弃式线性压缩，E2 §2 F1 L1/L2）
pub(crate) use conex_compaction::compaction::StubPolicy;
pub(crate) use conex_types::events::{
    AgentEvent, AgentEventEnvelope, RunCacheStats, RunTerminalStatus,
};
pub(crate) use conex_types::message::{
    AgentMessage, AgentMessageBlock, AgentMessageMetadataKind, AgentMessageRole,
};
pub(crate) use session_loop::r#loop::stage_summary::{
    build_stage_summary_document, next_pending_milestone, stage_ratios_from_session_meta,
    stage_summary_to_checkpoint_payload, stage_summary_to_markdown, stage_tier,
    StageSummaryDocument, StageSummaryRange, DEFAULT_COMPACT_STAGE_RATIOS,
};
// E2 F4：压缩记录（context-compression-end 载荷）+ Manual 触发/原因变体 +
// 块语义 details 构造（orchestrator::blocks 消费面，blocks.rs:96-137）
pub(crate) use conex_types::session::AgentEndReason;
pub(crate) use conex_types::tool::{
    compaction_block_details, ContextCompressionReason, ContextCompressionRecord,
    ContextCompressionTrigger,
};
pub(crate) use conex_types::{
    codes, ContextBudget, CrishError, CrishErrorPayload, HistoryMessage, PermissionMode,
};
pub(crate) use orchestrator::events::{build_run_terminal, drive_outcome, EventQueue};
pub(crate) use orchestrator::persist::{SessionSequencer, Store};
pub(crate) use orchestrator::recovery::{
    is_transient_kind, RecoveryBudget, RecoveryCoordinator, RecoveryError, RecoveryRetryPolicy,
    RecoveryStore, RECOVER_GROUP_PREFIX, RECOVER_MAX_EPISODES_KEY,
};
pub(crate) use orchestrator::restore::{RestoreOutcome, SnapshotStore};
pub(crate) use orchestrator::run::{CancelMode, RunEngine, RunHandle, RunManager};
pub(crate) use orchestrator::session::{SessionRecord, SessionTree};
pub(crate) use orchestrator::{GoalState, PendingMessageQueue};
pub(crate) use session_loop::hydrate::hydrate_history;
pub(crate) use session_loop::{
    AbortSignal, ApprovalGate, ControlBus, DeltaSink, RunOutcome, SessionLoopOptions,
    SummaryDispatchConfig, ToolBatchOptions,
};

pub(crate) use crate::context_injection::{
    ContextInjection, ContextInjectionKind, ContextInjector,
};
pub(crate) use crate::core_error::CoreError;
pub(crate) use crate::core_event_bridge::{EmitReport, EventBridge};
pub(crate) use crate::core_query::{
    BackgroundTasksSummary, RestoreStatus, RunUsage, SnapshotStatus,
};
pub(crate) use crate::engine_channels::{BridgeLiveSink, BufferedRunEventBridge};
pub(crate) use crate::engine_handle::EngineHandle;
pub(crate) use crate::run_producer::SessionLoopProducer;
pub(crate) use crate::status_diagnostics::StatusDiagnostics;
pub(crate) use crate::task_event_consumer::TaskEventConsumer;
pub(crate) use crate::wait_channel::{ControlBusResolver, SubagentWaitRegistry};

// ── 测试面共享符号（仅 cfg(test)：run/tests.rs 与各内联测试使用；
//    生产模块一律显式 import，不经本层）────────────────────────────
#[cfg(test)]
pub(crate) use conex_types::error::ProviderErrorKind;
#[cfg(test)]
pub(crate) use conex_types::events::{
    ApprovalDecision as WireApprovalDecision, SecurityAuditDecision, SecurityAuditOperation,
};
#[cfg(test)]
pub(crate) use conex_types::impact::ImpactAssessment;
#[cfg(test)]
pub(crate) use orchestrator::recovery::{RunFailureContext, RECOVER_EPISODES_KEY};
#[cfg(test)]
pub(crate) use orchestrator::restore::{RestoreMode, StateSnapshot};
#[cfg(test)]
pub(crate) use orchestrator::ToolCallStamp;
#[cfg(test)]
pub(crate) use session_loop::tool_events::{ApprovalDecision, ApprovalRequester};

// ── 会话元数据键约定（checkpoint 阶段标记 / 产出目录键共用）────────

/// 会话级键编码（`{session_id}:{key}`；空 session_id 退化字面键，
/// 对齐 explore_quota.rs:43-49 的 S7 接线模式）
pub(crate) fn session_meta_key_of(session_id: &str, key: &str) -> String {
    if session_id.is_empty() {
        key.to_string()
    } else {
        format!("{session_id}:{key}")
    }
}

// ── 顶层常量（原 core_run_commands.rs 128-212；分域注记，聚合后各模可见）──

/// run 的 max-turns 缺省预算（常规模式提升至 512 轮；0 代表无上限全天候自主运转）
pub(crate) const MAX_TURNS_DEFAULT: u32 = 512;
/// 会话元数据 session_meta 中持久化的 max_turns 键
pub(crate) const META_KEY_MAX_TURNS: &str = "max_turns";
/// 审批等待超时（超时 → Expired；前端 ApprovalFlow 亦有兜底）
#[cfg(test)]
pub(crate) const APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// 快照周期默认值（T08.6 触发点 B：默认 60s，session_meta
/// `snapshot_interval_ms` 可配）
pub(crate) const DEFAULT_SNAPSHOT_INTERVAL_MS: u64 = 60_000;
/// DEEPCHECK-01 P0：SessionHistoryCache 每会话 token 预算（防膨胀；超出时
/// 按「稳定锚点 + 预算尾部」截断，跨 run 请求前缀字节稳定，见
/// [truncate_history_with_anchor]；估算对齐 conex-compaction count_tokens，
/// 与前端 HISTORY_TOKEN_BUDGET 同语义）
pub(crate) const SESSION_HISTORY_TOKEN_BUDGET: usize = 200_000;
/// 单条历史消息的固定线缆开销估算（role/id/timestamp/status + JSON 信封，
/// 与前端 HISTORY_MESSAGE_TOKEN_OVERHEAD 对齐）
pub(crate) const SESSION_HISTORY_MESSAGE_TOKEN_OVERHEAD: usize = 8;
/// T-29：SessionHistoryCache 会话数上限（防膨胀；超出时 FIFO 淘汰
/// 最久未更新的会话）
pub(crate) const SESSION_HISTORY_MAX_SESSIONS: usize = 32;

// ── D3：C7 恢复阶梯生产接线（维度文档 D3-C7恢复阶梯生产接线.md）──────

/// D3 §4.1：阶梯 1 跨 run 重试次数可配键（D3 自决键；装配时读，缺省 2；
/// 与内核 3 次叠加共 5 次瞬态尝试/任务，敲定方案 §5 V3）
pub(crate) const RECOVER_LADDER1_MAX_RETRIES_KEY: &str = "recover_ladder1_max_retries";
/// D3 §4.1/V3：阶梯 1 跨 run 重试次数缺省（RecoveryRetryPolicy.max_retries）
pub(crate) const RECOVER_LADDER1_MAX_RETRIES_DEFAULT: u32 = 2;
/// E3-2（D3 §3.2.6）：子代理汇报文本截断长度（对齐 checkpoint 摘要
/// 截断语义）
pub(crate) const SUBAGENT_PROGRESS_TRUNCATE_CHARS: usize = 500;

// ── D2/E1/D5/D1：壳层恢复面（任务连续性方案实施轮 2）──────────────

/// D2 §3.3：唤醒源常量（预算指纹 source 段）。D2 建议 recovery.rs 集中
/// 定义，本轮文件域限制定义于壳层（后续主控可统一迁移）。
pub(crate) const WAKE_SOURCE_ERROR_RETRY: &str = "error-retry";
/// E1 §3.4：续写指纹域（独立于 error-retry，同键 recover_episodes 互斥；
/// 激活 D2 W8 前瞻设计）
pub(crate) const WAKE_SOURCE_CONTENT_RESUME: &str = "content-resume";
/// D2 §3.4：主 run error 续 run 注入文本（锁定模板；约束 C：最小化，
/// 不含 kind/retries 等诊断细节——诊断走 provider-diagnostic 事件 +
/// 临时通知，不给 AI）
pub(crate) const MAIN_RESUME_INJECT_TEXT: &str = "继续任务";
/// D1 §3.2.1：熔断计数键（session_meta；JSON 字段 snake_case，02-定夺 S1）
pub(crate) const PROVIDER_FAIL_STREAK_KEY: &str = "provider_fail_streak";
/// D1 §3.1.4：熔断阈值可配键（缺省 [PROVIDER_FAIL_THRESHOLD_DEFAULT]）
pub(crate) const PROVIDER_FAIL_THRESHOLD_KEY: &str = "provider_fail_threshold";
/// D1 §3.2.4：熔断阈值缺省（对齐 stream_error.rs PROVIDER_FAIL_THRESHOLD=6）
pub(crate) const PROVIDER_FAIL_THRESHOLD_DEFAULT: u32 = 6;
/// E1 §3.4：续写开关键（缺省 true = 默认开启）
pub(crate) const CONTENT_RESUME_ENABLED_KEY: &str = "content_resume_enabled";
/// E1 §3.4：续写预算上限键（缺省 [CONTENT_RESUME_MAX_DEFAULT]）
pub(crate) const CONTENT_RESUME_MAX_KEY: &str = "content_resume_max";
/// E1 §3.4：续写次数上限缺省（比 error-retry 的 3 更紧——续写是「质量
/// 增强」而非「任务救急」，且每次续写都是完整请求）
pub(crate) const CONTENT_RESUME_MAX_DEFAULT: u32 = 2;
/// D1 §3.2.1：window_ms 缺省（0 = 无窗口；连续计数/成功归零是唯一语义，
/// 字段保留 = 惰性过期支持）
pub(crate) const PROVIDER_FAIL_WINDOW_MS_DEFAULT: u64 = 0;
/// D1 §3.1.4：退避配置键（session_meta；JSON 数组 [base, max, budget]
/// 或单值 base，仿 compact_summary_backoff_ms 宽容解析先例
/// （summary_dispatch.rs:84-89）；缺键 → None = 现状立即重试向后兼容）
pub(crate) const PROVIDER_RETRY_BACKOFF_MS_KEY: &str = "provider_retry_backoff_ms";

// ── D6/D7：无人值守唤醒链路 + checkpoint 闭环（接续链 2 壳层面）──

/// D6 §3.3：子代理独立会话 id 前缀（subagent_spawner.rs:289 生成路径；
/// run_restore 恢复条目按此前缀分流主 run / 子代理——子代理只通知不
/// 自动 fork，裁决 #20）
pub(crate) const SUBAGENT_SESSION_PREFIX: &str = "sub-sess-";
/// D6 §3.4：合并注入上限（评审 selection-03:220 建议 ≤16 条；超出保留
/// 最新并注明省略 N 条——drain 是全部队列源的公共合并面，一次定界
/// 覆盖全部源。注：该 16 为恢复/唤醒条目数，与 16/16/1 递归守卫的
/// max_concurrent 16 无关联，final/00 §3.1 已加注）
pub(crate) const RESTORE_MERGE_INJECT_LIMIT: usize = 16;
/// D6 §3.3：恢复条目 group_id 前缀（键形状 `restore-<run_id>`，对齐
/// recovery-/timer-/subagent-terminal- 前缀族，00-总纲-维度设计.md:136）
pub(crate) const RESTORE_GROUP_PREFIX: &str = "restore-";
/// D6 §3.3：主 run 恢复条目注入文本（任务书原文：重启恢复的续跑指令）
#[allow(dead_code)]
pub(crate) const RESTORE_MAIN_INJECT_TEXT: &str = "上次被重启打断，请继续";
/// D7 §8 决策 4：checkpoint 注入摘要截断护栏（summary ≤500 字符，
/// 超长截断 + 省略号；completed/next 各 ≤5 项在拼接处限制）
pub(crate) const CHECKPOINT_SUMMARY_TRUNCATE_CHARS: usize = 500;
/// D7 §8 决策 4：checkpoint 注入清单项数上限（completed/next 各 ≤5 项）
pub(crate) const CHECKPOINT_LIST_ITEMS_MAX: usize = 5;

pub mod run_approval;
pub mod run_commands;
pub mod run_core;
pub mod run_history;
pub mod run_idle;
pub mod run_launch;
pub mod run_resume;
pub mod run_retry;
pub mod run_snapshot;

pub use run_approval::*;
pub use run_commands::*;
pub use run_core::*;
pub(crate) use run_history::*;
pub(crate) use run_idle::*;
pub use run_launch::*;
pub(crate) use run_resume::*;
pub use run_retry::*;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
