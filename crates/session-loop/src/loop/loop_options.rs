//! 循环配置面（SR-06c · 拆分 · ≠ EL）：SessionLoopOptions（恢复阶梯上限 /
//! 钩子 / 预算 / 压缩 / 摘要调度 / 装配面）+ Default + RetryBackoffConfig；
//! 自 loop/mod.rs 拆出，经父模 re-export（crate::r#loop::SessionLoopOptions
//! 路径不 break）。
//!
//! B3 · 37字段→7子结构体收敛：顶层 7 分组（Retry/Compaction/Summary/ToolExec/
//! Cache/Assembly/Hooks），单结构体字段数 ≤8，默认值语义不变。

use std::path::PathBuf;
use std::sync::Arc;

use agent_tools::context::ExploreDocsQuotaContext;
use agent_tools::middleware::ToolMiddleware;
use agent_tools::note_backend::NoteBackendHandle;
use agent_tools::write_paths::WritePathRegistry;
use conex_compaction::{CompactionPolicy, Summarizer};
use conex_types::context::ContextBudget;

use crate::cache_tracker::CacheTrackingConfig;

use super::{RecoveryHook, TurnEndHook};

// ── 7 子结构体（B3 分组收敛）─────────────────────────────────────────────

/// 重试/阶梯上限配置（Retry 域，5 字段）
#[derive(Clone)]
pub struct RetryConfig {
    pub transient_retry_limit: u32,
    pub retry_backoff: Option<RetryBackoffConfig>,
    pub provider_fail_streak: Option<u32>,
    pub length_upgrade_limit: u32,
    pub continue_nudge_limit: u32,
}
impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            transient_retry_limit: 3,
            retry_backoff: None,
            provider_fail_streak: None,
            length_upgrade_limit: 2,
            continue_nudge_limit: 1,
        }
    }
}
/// 压缩策略配置（Compaction 域，7 字段）
#[derive(Clone)]
pub struct CompactionConfig {
    pub compaction_policy: Option<CompactionPolicy>,
    pub summarizer: Option<Arc<dyn Summarizer>>,
    pub max_auto_compactions_per_run: u32,
    pub compact_overflow_retries: u32,
    pub compact_require_llm: bool,
    pub compact_allow_stub_fallback: bool,
    pub compact_stage_ratios: Option<Vec<f64>>,
}
impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            compaction_policy: None,
            summarizer: None,
            max_auto_compactions_per_run: 1,
            compact_overflow_retries:
                crate::r#loop::handlers::stream_error::MAX_OVERFLOW_COMPRESSION_RETRIES,
            compact_require_llm: true,
            compact_allow_stub_fallback: false,
            compact_stage_ratios: Some(
                crate::r#loop::stage_summary::DEFAULT_COMPACT_STAGE_RATIOS.to_vec(),
            ),
        }
    }
}
/// 摘要调度配置（Summary 域，4 字段）
#[derive(Clone)]
pub struct SummaryConfig {
    pub summary_dispatch: Option<crate::r#loop::summary_dispatch::SummaryDispatchConfig>,
    pub compact_summary_max_attempts: u32,
    pub compact_summary_retry_window_ms: u64,
    pub summary_coordinator:
        Option<Arc<crate::r#loop::summary_coordinator::SessionSummaryCoordinator>>,
}
impl Default for SummaryConfig {
    fn default() -> Self {
        Self {
            summary_dispatch: None,
            compact_summary_max_attempts:
                crate::r#loop::summary_dispatch::DEFAULT_RETRY_GUARD_MAX_ATTEMPTS,
            compact_summary_retry_window_ms:
                crate::r#loop::summary_dispatch::DEFAULT_RETRY_GUARD_WINDOW_MS,
            summary_coordinator: None,
        }
    }
}
/// 工具执行配置（ToolExec 域，7 字段）
#[derive(Clone)]
pub struct ToolExecConfig {
    pub idempotency_enabled: bool,
    pub tool_middleware: Vec<Arc<dyn ToolMiddleware>>,
    pub hooks: Option<Arc<crate::hooks::HookRegistry>>,
    pub cwd: Option<String>,
    pub assistant_client_message_id: Option<String>,
    pub tool_promise_recovery_enabled: bool,
    pub max_tool_promise_heals: u32,
}
impl Default for ToolExecConfig {
    fn default() -> Self {
        Self {
            idempotency_enabled: false,
            tool_middleware: Vec::new(),
            hooks: None,
            cwd: None,
            assistant_client_message_id: None,
            tool_promise_recovery_enabled: true,
            max_tool_promise_heals: 2,
        }
    }
}
/// 缓存测量配置（Cache 域，1 字段）
#[derive(Clone)]
pub struct CacheConfig {
    pub cache_tracking: Option<CacheTrackingConfig>,
}
impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            cache_tracking: None,
        }
    }
}
/// 装配面配置（Assembly 域，8 字段）
#[derive(Clone)]
pub struct AssemblyConfig {
    pub system_prompt: Option<String>,
    pub context_budget: Option<ContextBudget>,
    pub write_claims: Option<Arc<WritePathRegistry>>,
    pub explore_docs_quota: Option<ExploreDocsQuotaContext>,
    pub output_dir: Option<Arc<dyn agent_tools::tools::output_dir::OutputDirResolver>>,
    pub parent_run_id: Option<String>,
    pub note_backend: Option<NoteBackendHandle>,
    pub pending_input_store: Option<Arc<dyn crate::input::PendingInputStore>>,
}
impl Default for AssemblyConfig {
    fn default() -> Self {
        Self {
            system_prompt: None,
            context_budget: None,
            write_claims: None,
            explore_docs_quota: None,
            output_dir: None,
            parent_run_id: None,
            note_backend: None,
            pending_input_store: None,
        }
    }
}
/// 钩子/运行时配置（Hooks 域，8 字段）
#[derive(Clone)]
pub struct HooksConfig {
    pub steering_enabled: bool,
    pub turn_end_hook: Option<Arc<dyn TurnEndHook>>,
    pub should_stop_after_turn: Option<Arc<dyn TurnEndHook>>,
    pub recovery_hook: Option<Arc<dyn RecoveryHook>>,
    pub live_sink: Option<Arc<dyn crate::provider::LiveEventSink>>,
    pub background: Option<Arc<dyn agent_tools::background::BackgroundTaskManager>>,
    pub log_root: Option<PathBuf>,
    pub reasoning_effort: Option<crate::provider::ReasoningEffort>,
}
impl Default for HooksConfig {
    fn default() -> Self {
        Self {
            steering_enabled: true,
            turn_end_hook: None,
            should_stop_after_turn: None,
            recovery_hook: None,
            live_sink: None,
            background: None,
            log_root: None,
            reasoning_effort: None,
        }
    }
}
/// 循环配置（恢复阶梯上限 / 钩子；缺省值对齐 01 §2.5-2.6 与 §3.3）
#[derive(Clone)]
pub struct SessionLoopOptions {
    pub retry: RetryConfig,
    pub compaction: CompactionConfig,
    pub summary: SummaryConfig,
    pub tool_exec: ToolExecConfig,
    pub cache: CacheConfig,
    pub assembly: AssemblyConfig,
    pub hooks: HooksConfig,
}
impl Default for SessionLoopOptions {
    fn default() -> Self {
        Self {
            retry: RetryConfig::default(),
            compaction: CompactionConfig::default(),
            summary: SummaryConfig::default(),
            tool_exec: ToolExecConfig::default(),
            cache: CacheConfig::default(),
            assembly: AssemblyConfig::default(),
            hooks: HooksConfig::default(),
        }
    }
}
impl SessionLoopOptions {
    pub fn with_tool_middleware(mut self, middleware: Vec<Arc<dyn ToolMiddleware>>) -> Self {
        self.tool_exec.tool_middleware = middleware;
        self
    }
    pub fn stage_ratios(&self) -> Option<&[f64]> {
        self.compaction
            .compact_stage_ratios
            .as_deref()
            .filter(|r| !r.is_empty())
    }
    pub fn live_sink(&self) -> Option<Arc<dyn crate::provider::LiveEventSink>> {
        self.hooks.live_sink.clone()
    }
    pub fn background(&self) -> Option<Arc<dyn agent_tools::background::BackgroundTaskManager>> {
        self.hooks.background.clone()
    }
    pub fn log_root(&self) -> Option<PathBuf> {
        self.hooks.log_root.clone()
    }
    pub fn tool_promise_recovery_enabled(&self) -> bool {
        self.tool_exec.tool_promise_recovery_enabled
    }
    pub fn max_tool_promise_heals(&self) -> u32 {
        self.tool_exec.max_tool_promise_heals
    }
    pub fn transient_retry_limit(&self) -> u32 {
        self.retry.transient_retry_limit
    }
    pub fn retry_backoff(&self) -> Option<RetryBackoffConfig> {
        self.retry.retry_backoff
    }
    pub fn provider_fail_streak(&self) -> Option<u32> {
        self.retry.provider_fail_streak
    }
    pub fn length_upgrade_limit(&self) -> u32 {
        self.retry.length_upgrade_limit
    }
    pub fn continue_nudge_limit(&self) -> u32 {
        self.retry.continue_nudge_limit
    }
    pub fn steering_enabled(&self) -> bool {
        self.hooks.steering_enabled
    }
    pub fn turn_end_hook(&self) -> Option<Arc<dyn TurnEndHook>> {
        self.hooks.turn_end_hook.clone()
    }
    pub fn should_stop_after_turn(&self) -> Option<Arc<dyn TurnEndHook>> {
        self.hooks.should_stop_after_turn.clone()
    }
    pub fn recovery_hook(&self) -> Option<Arc<dyn RecoveryHook>> {
        self.hooks.recovery_hook.clone()
    }
    pub fn cwd(&self) -> Option<String> {
        self.tool_exec.cwd.clone()
    }
    pub fn assistant_client_message_id(&self) -> Option<String> {
        self.tool_exec.assistant_client_message_id.clone()
    }
    pub fn idempotency_enabled(&self) -> bool {
        self.tool_exec.idempotency_enabled
    }
    pub fn tool_middleware(&self) -> &Vec<Arc<dyn ToolMiddleware>> {
        &self.tool_exec.tool_middleware
    }
    pub fn hooks_opt(&self) -> Option<Arc<crate::hooks::HookRegistry>> {
        self.tool_exec.hooks.clone()
    }
    pub fn system_prompt(&self) -> Option<String> {
        self.assembly.system_prompt.clone()
    }
    pub fn context_budget(&self) -> Option<ContextBudget> {
        self.assembly.context_budget
    }
    pub fn compaction_policy(&self) -> Option<CompactionPolicy> {
        self.compaction.compaction_policy.clone()
    }
    pub fn summarizer(&self) -> Option<Arc<dyn Summarizer>> {
        self.compaction.summarizer.clone()
    }
    pub fn max_auto_compactions_per_run(&self) -> u32 {
        self.compaction.max_auto_compactions_per_run
    }
    pub fn compact_overflow_retries(&self) -> u32 {
        self.compaction.compact_overflow_retries
    }
    pub fn compact_require_llm(&self) -> bool {
        self.compaction.compact_require_llm
    }
    pub fn compact_allow_stub_fallback(&self) -> bool {
        self.compaction.compact_allow_stub_fallback
    }
    pub fn compact_stage_ratios(&self) -> Option<Vec<f64>> {
        self.compaction.compact_stage_ratios.clone()
    }
    pub fn cache_tracking(&self) -> Option<CacheTrackingConfig> {
        self.cache.cache_tracking.clone()
    }
    pub fn write_claims(&self) -> Option<Arc<WritePathRegistry>> {
        self.assembly.write_claims.clone()
    }
    pub fn explore_docs_quota(&self) -> Option<ExploreDocsQuotaContext> {
        self.assembly.explore_docs_quota.clone()
    }
    pub fn output_dir(&self) -> Option<Arc<dyn agent_tools::tools::output_dir::OutputDirResolver>> {
        self.assembly.output_dir.clone()
    }
    pub fn parent_run_id(&self) -> Option<String> {
        self.assembly.parent_run_id.clone()
    }
    pub fn summary_dispatch(
        &self,
    ) -> Option<crate::r#loop::summary_dispatch::SummaryDispatchConfig> {
        self.summary.summary_dispatch.clone()
    }
    pub fn compact_summary_max_attempts(&self) -> u32 {
        self.summary.compact_summary_max_attempts
    }
    pub fn compact_summary_retry_window_ms(&self) -> u64 {
        self.summary.compact_summary_retry_window_ms
    }
    pub fn summary_coordinator(
        &self,
    ) -> Option<Arc<crate::r#loop::summary_coordinator::SessionSummaryCoordinator>> {
        self.summary.summary_coordinator.clone()
    }
    pub fn note_backend(&self) -> Option<NoteBackendHandle> {
        self.assembly.note_backend.clone()
    }
    pub fn pending_input_store(&self) -> Option<Arc<dyn crate::input::PendingInputStore>> {
        self.assembly.pending_input_store.clone()
    }
    pub fn reasoning_effort(&self) -> Option<crate::provider::ReasoningEffort> {
        self.hooks.reasoning_effort
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RetryBackoffConfig {
    pub base_ms: Option<u64>,
    pub max_ms: Option<u64>,
    pub total_budget_ms: Option<u64>,
}
