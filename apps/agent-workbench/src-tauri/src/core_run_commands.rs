//! run 生命周期命令桥（B6.1：core_run_task / core_run_control /
//! core_cancel_run / core_approve_tool / core_deny_tool）
//!
//! 本模块同时承载：
//! - [CoreRunState]：进程内核心运行状态（store / 引擎 / 事件桥 / 活动 run
//!   注册表 / 恢复门禁 / 快照状态，B6.4）；
//! - [drive_run_loop]：run 驱动循环——`produce`（[RunProducer] trait）→
//!   [orchestrator::events::drive_outcome] → 事件 emit（信封 runId/sequence
//!   注入；T09.1 后收口 message-delta 跳过不双发）→ cursor 发布 → 终态
//!   退出；错误路径 [finalize_failed]；退出后快照（T08.6 触发点 A）；
//! - [ApprovalGateImpl]：审批门（approval-requested 先发后等防死锁，
//!   01 §五.8；I-02 / PE-12 T12.3：待审批集合校验）；
//! - 快照三触发（PE-08 T08.6）：终态保存（[CoreRunState::save_snapshot_now]）/
//!   周期任务（[CoreRunState::spawn_snapshot_loop]，默认 60s 可配）/
//!   退出钩子（[CoreRunState::save_snapshot_blocking]，main.rs `RunEvent::Exit`）；
//!   restore 在 app.manage(CoreRunState) 之前经 run_in_runtime 执行
//!   （[CoreRunState::run_restore]）；run_task 门禁 restore_ready（Q24 竞态）。
//!
//! 错误协议：命令返回 [crate::core_error::CoreError]（`{kind, detail}`，
//! 03 §5.3-5 IPC 面唯一协议；R2 的 core_error.rs 已接线，run/store 错误
//! 经 `map_run_err` / `map_store_err` 无损映射，77 码经 `core_error_code`
//! 显式映射——见 PE-03 §2.4.2 映射表）。
//!
//! TODO(集成 agent)：main.rs 声明 `mod core_run_commands` 并
//! `app.manage(Arc::new(CoreRunState::new(...)))`（restore 在 manage 之前）。

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_provider::request::build_system_prompt;
use agent_tools::audit::{AuditSink, SecurityAuditSink};
use agent_tools::backup::BackupMiddleware;
use agent_tools::background::{
    BackgroundAdoptRequest, BackgroundTaskInfo, BackgroundTaskManager, BackgroundTaskRef, LogSlice,
    TaskState,
};
use agent_tools::context::ExploreDocsQuotaContext;
use agent_tools::definition::ToolError;
// 审计 01 W1（任务连续性推进轮）：kill_subagent / send_message 三通道
// 生产实现（CoreRunState 契约面；经 ContinuityStateAdapter Weak 适配
// 注入引擎 ContinuityChannelBoard）
use agent_tools::tools::kill_subagent::{KillOutcomeKind, KillSubagentToolResult, SubagentKillChannel};
use agent_tools::tools::send_message::{
    MainAgentMessageChannel, MainMessageRing, SubagentInjectChannel,
};
use agent_tools::tools::subagent::{SubagentSpawner, SubagentState};
use agent_tools::write_paths::{WritePathPolicy, WritePathRegistry};
use conex_db::LocalDb;
use serde::Serialize;
// DEEPCHECK-01 P0：历史 token 估算复用 conex-compaction count_tokens 启发式
// （ASCII 单词约 4 字符/token，与前端 estimateTextTokens 对齐）
use conex_compaction::count_tokens;
// E2 F4（手动压缩命令面）：LlmRequired = 无 Summarizer / 摘要失败 → 放弃
// 压缩（禁止纯丢弃式线性压缩，E2 §2 F1 L1/L2）
use conex_compaction::compaction::StubPolicy;
// E2 F5（分阶段总结壳层接线）：里程碑判定纯函数 + Schema 构造 + checkpoint
// 载荷转换 + 配置解析（stage_summary.rs 轮 1 已落地，本面只读调用）
use session_loop::r#loop::stage_summary::{
    DEFAULT_COMPACT_STAGE_RATIOS, StageSummaryDocument, StageSummaryRange,
    build_stage_summary_document, next_pending_milestone, stage_ratios_from_session_meta,
    stage_summary_to_checkpoint_payload, stage_summary_to_markdown, stage_tier,
};
use conex_types::device::{
    ApprovalChannel as RemoteApprovalChannel, ApprovalHistoryItem, ApprovalHistoryResult, Arbiter,
    PendingApproval,
};
use conex_types::events::{
    AgentEvent, AgentEventEnvelope, ApprovalDecision as WireApprovalDecision, PermissionRequest,
    RunCacheStats, RunTerminalStatus, SecurityAuditDecision, SecurityAuditOperation,
    SubagentEventKind,
};
use conex_types::error::ProviderErrorKind;
use conex_types::impact::ImpactAssessment;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
// E2 F4：压缩记录（context-compression-end 载荷）+ Manual 触发/原因变体 +
// 块语义 details 构造（orchestrator::blocks 消费面，blocks.rs:96-137）
use conex_types::tool::{
    compaction_block_details, ContextCompressionReason, ContextCompressionRecord,
    ContextCompressionTrigger,
};
use conex_types::session::AgentEndReason;
use conex_types::{codes, ContextBudget, CrishError, CrishErrorPayload, HistoryMessage};
use orchestrator::events::{build_run_terminal, drive_outcome, EventQueue};
use orchestrator::persist::{SessionSequencer, Store};
use orchestrator::recovery::{
    backoff_delay_ms, fingerprint, is_transient_kind, RecoveryAction, RecoveryBudget,
    RecoveryCoordinator, RecoveryError, RecoveryOutcome, RecoveryRetryPolicy, RecoveryStore,
    RECOVER_EPISODES_KEY, RECOVER_GROUP_PREFIX, RECOVER_MAX_EPISODES_KEY, RunFailureContext,
};
use orchestrator::restore::{RestoreManager, RestoreMode, RestoreOutcome, SnapshotStore, StateSnapshot};
use orchestrator::run::{CancelMode, RunEngine, RunHandle, RunManager};
use orchestrator::session::{SessionRecord, SessionTree};
use orchestrator::subagent_events::{
    SubagentEmitContext, SubagentEventEmitter, SubagentEventInfo,
};
use orchestrator::{
    assess_round, GoalDecision, GoalState, PendingMessageQueue, RoundInput, ToolCallStamp,
};
use session_loop::hydrate::hydrate_history;
use session_loop::approval_router::{
    classify_source, route_approval, route_approval_guarded, arbiter_metadata,
};
use session_loop::tool_events::{ApprovalDecision, ApprovalRequester};
use tauri::Manager as _;
use session_loop::{
    AbortSignal, ApprovalGate, ControlBus, DeltaSink, EscapeWatchConfig, EscapeWatchHandle,
    EscapeWatchInjector, PermissionMode, RegistryBackedDetector, RunOutcome, SessionLoopOptions,
    SummaryDispatchConfig, ToolBatchOptions, spawn_escape_watch,
};

use crate::core_error::CoreError;
use crate::core_event_bridge::{EmitReport, EventBridge};
use crate::core_query_commands::{BackgroundTasksSummary, RestoreStatus, RunUsage, SnapshotStatus};
// 审计 01 W1：ControlBusResolver 契约（库目标 wait_channel 定义；引擎
// WaitChannel 的 inject 面与 send_message 子代理注入共用同一解析器）
use crish_agent_workbench::wait_channel::ControlBusResolver;
use crate::engine::{
    BridgeDeltaSink, BufferedRunEventBridge, ContextInjection, ContextInjectionKind, ContextInjector,
    EngineHandle, SessionLoopProducer,
};
use crate::status_diagnostics::StatusDiagnostics;
use crate::task_event_consumer::TaskEventConsumer;

/// run 的 max-turns 预算（对齐 01 §1.5：独立预算 reason）
const MAX_TURNS_DEFAULT: u32 = 64;
/// 审批等待超时（超时 → Expired；前端 ApprovalFlow 亦有兜底）
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
/// 快照周期默认值（T08.6 触发点 B：默认 60s，session_meta
/// `snapshot_interval_ms` 可配）
const DEFAULT_SNAPSHOT_INTERVAL_MS: u64 = 60_000;
/// DEEPCHECK-01 P0：SessionHistoryCache 每会话 token 预算（防膨胀；超出时
/// 按「稳定锚点 + 预算尾部」截断，跨 run 请求前缀字节稳定，见
/// [truncate_history_with_anchor]；估算对齐 conex-compaction count_tokens，
/// 与前端 HISTORY_TOKEN_BUDGET 同语义）
const SESSION_HISTORY_TOKEN_BUDGET: usize = 200_000;
/// 单条历史消息的固定线缆开销估算（role/id/timestamp/status + JSON 信封，
/// 与前端 HISTORY_MESSAGE_TOKEN_OVERHEAD 对齐）
const SESSION_HISTORY_MESSAGE_TOKEN_OVERHEAD: usize = 8;
/// T-29：SessionHistoryCache 会话数上限（防膨胀；超出时 FIFO 淘汰
/// 最久未更新的会话）
const SESSION_HISTORY_MAX_SESSIONS: usize = 32;

// ── D3：C7 恢复阶梯生产接线（维度文档 D3-C7恢复阶梯生产接线.md）──────

/// D3 §4.1：阶梯 1 跨 run 重试次数可配键（D3 自决键；装配时读，缺省 2；
/// 与内核 3 次叠加共 5 次瞬态尝试/任务，敲定方案 §5 V3）
const RECOVER_LADDER1_MAX_RETRIES_KEY: &str = "recover_ladder1_max_retries";
/// D3 §4.1/V3：阶梯 1 跨 run 重试次数缺省（RecoveryRetryPolicy.max_retries）
const RECOVER_LADDER1_MAX_RETRIES_DEFAULT: u32 = 2;
/// E3-2（D3 §3.2.6）：子代理汇报文本截断长度（对齐 checkpoint 摘要
/// 截断语义）
const SUBAGENT_PROGRESS_TRUNCATE_CHARS: usize = 500;

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
const PROVIDER_FAIL_WINDOW_MS_DEFAULT: u64 = 0;
/// D1 §3.1.4：退避配置键（session_meta；JSON 数组 [base, max, budget]
/// 或单值 base，仿 compact_summary_backoff_ms 宽容解析先例
/// （summary_dispatch.rs:84-89）；缺键 → None = 现状立即重试向后兼容）
const PROVIDER_RETRY_BACKOFF_MS_KEY: &str = "provider_retry_backoff_ms";

// ── D6/D7：无人值守唤醒链路 + checkpoint 闭环（接续链 2 壳层面）──

/// D6 §3.3：子代理独立会话 id 前缀（subagent_spawner.rs:289 生成路径；
/// run_restore 恢复条目按此前缀分流主 run / 子代理——子代理只通知不
/// 自动 fork，裁决 #20）
const SUBAGENT_SESSION_PREFIX: &str = "sub-sess-";
/// D6 §3.4：合并注入上限（评审 selection-03:220 建议 ≤16 条；超出保留
/// 最新并注明省略 N 条——drain 是全部队列源的公共合并面，一次定界
/// 覆盖全部源。注：该 16 为恢复/唤醒条目数，与 16/16/1 递归守卫的
/// max_concurrent 16 无关联，final/00 §3.1 已加注）
const RESTORE_MERGE_INJECT_LIMIT: usize = 16;
/// D6 §3.3：恢复条目 group_id 前缀（键形状 `restore-<run_id>`，对齐
/// recovery-/timer-/subagent-terminal- 前缀族，00-总纲-维度设计.md:136）
const RESTORE_GROUP_PREFIX: &str = "restore-";
/// D6 §3.3：主 run 恢复条目注入文本（任务书原文：重启恢复的续跑指令）
const RESTORE_MAIN_INJECT_TEXT: &str = "上次被重启打断，请继续";
/// D7 §8 决策 4：checkpoint 注入摘要截断护栏（summary ≤500 字符，
/// 超长截断 + 省略号；completed/next 各 ≤5 项在拼接处限制）
const CHECKPOINT_SUMMARY_TRUNCATE_CHARS: usize = 500;
/// D7 §8 决策 4：checkpoint 注入清单项数上限（completed/next 各 ≤5 项）
const CHECKPOINT_LIST_ITEMS_MAX: usize = 5;

/// D1 §3.2.1：`provider_fail_streak` 键形状（05 形状冻结；字段 snake_case，
/// 02-定夺 S1）。宽容解析 fail-open：坏 JSON / 缺字段 → count=0。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct ProviderFailStreak {
    /// 当前连续失败计数（瞬态类）
    pub count: u32,
    /// 首次失败时刻（epoch ms）
    pub first_fail_at_ms: i64,
    /// 最近一次失败时刻（epoch ms）
    pub last_fail_at_ms: i64,
    /// 窗口配置（0 = 无窗口；>0 时读侧惰性过期判定，D1 §3.2.1）
    pub window_ms: u64,
}

impl ProviderFailStreak {
    /// 首次失败（count=1 起）
    fn first_failure(now_ms: u64) -> Self {
        Self {
            count: 1,
            first_fail_at_ms: now_ms as i64,
            last_fail_at_ms: now_ms as i64,
            window_ms: PROVIDER_FAIL_WINDOW_MS_DEFAULT,
        }
    }

    /// 清零形态（成功面，C3）
    fn cleared(now_ms: u64) -> Self {
        Self {
            count: 0,
            first_fail_at_ms: 0,
            last_fail_at_ms: now_ms as i64,
            window_ms: PROVIDER_FAIL_WINDOW_MS_DEFAULT,
        }
    }

    /// 宽容解析（fail-open：缺键 / 坏 JSON / 缺字段 → count=0）
    fn from_json(raw: Option<&str>) -> Self {
        raw.and_then(|raw| serde_json::from_str::<ProviderFailStreak>(raw).ok())
            .unwrap_or_else(|| Self::cleared(0))
    }

    fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// 连续失败 +1（首次失败填充 first_fail_at）
    fn record_failure(&mut self, now_ms: u64) {
        if self.count == 0 {
            self.first_fail_at_ms = now_ms as i64;
        }
        self.count = self.count.saturating_add(1);
        self.last_fail_at_ms = now_ms as i64;
    }

    /// 读取侧惰性过期（window_ms > 0 且超窗 → 视为清零，D1 §3.2.1）
    fn effective_count(&self, now_ms: u64) -> u32 {
        if self.window_ms > 0
            && self.first_fail_at_ms > 0
            && now_ms >= self.first_fail_at_ms as u64
            && now_ms - self.first_fail_at_ms as u64 >= self.window_ms
        {
            0
        } else {
            self.count
        }
    }
}

/// D2 §3.2 + E1 §3.3：续 run 判定输入（drive_run_loop 在 outcome 移动消费
/// 前提取的数据面；decide_idle_resume 消费）。
///
/// provider_error 为壳层自有镜像结构（session-loop 的 ProviderErrorSummary
/// 所在 `mod end` 为私有模块，壳层无法命名该类型——字段访问无需类型名，
/// 提取时逐字段映射；D2 §3.2 的 `Option<&ProviderErrorSummary>` 签名在本
/// 壳层落地为等价字段镜像）。
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ResumeSignals {
    /// D2 §3.3：任务文本（会话首条非 steering user 消息；指纹输入）
    pub task_text: String,
    /// D1 数据面：fatal 收场的 provider 错误摘要（正常 stop 收场 None）
    pub provider_error: Option<ProviderErrorFields>,
    /// E1 §2.1：最后一条 assistant 消息的流中断标注信号（D7 标注）
    pub last_assistant: Option<LastAssistantSignal>,
}

/// D1 数据面摘要的壳层镜像（ProviderErrorSummary 字段子集：kind /
/// retryable / retries）
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ProviderErrorFields {
    /// 分类 13 类（kebab-case）
    pub kind: ProviderErrorKind,
    /// 是否可重试
    pub retryable: bool,
    /// run 内实际重试次数
    pub retries: u32,
}

/// E1 §2.1：最后一条 assistant 消息的流中断标注（D7 §3.7；与 D1 熔断
/// S2 计数同数据源）
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LastAssistantSignal {
    /// metadata.providerErrorKind（无标注 None）
    pub kind: Option<ProviderErrorKind>,
    /// metadata.providerErrorRetryable（无标注 None；!= false 语义）
    pub retryable: Option<bool>,
    /// 纯文本消息（无 tool_calls 且文本非空——工具调用已提交不续写）
    pub is_plain_text: bool,
}

/// D5 §3.3：goal 收口评估输入（RoundInput 三要素 + 事件载荷计数的
/// 预提取形态）
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GoalRoundSignals {
    /// 本轮助手终稿文本（消息尾）
    pub assistant_text: String,
    /// 本轮工具批（tool_name + 参数顶层 key 集）
    pub tool_calls: Vec<ToolCallStamp>,
    /// 本轮成功工具结果计数（L2 退化证据）
    pub tool_success_count: u32,
    /// 本轮工具调用次数（goal-round-completed 载荷）
    pub tool_call_count: u32,
    /// 本轮消息数（goal-round-completed 载荷）
    pub message_count: u32,
}

/// D2 §3.3：带唤醒源类型的操作指纹（裁决 #8：同注入模板 = 同任务会
/// 混淆不同唤醒源；source 参与哈希输入，与 task 字节间以 0x00 分隔）。
///
/// 复刻 recovery.rs fingerprint 的 FNV-1a 循环（同参数防漂移）；D2 §3.3
/// 建议 recovery.rs 新增三参变体，本轮文件域限制实现于壳层。
fn fingerprint_with_source(subagent_id: &str, task: &str, source: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in subagent_id.as_bytes().iter().chain(&[0u8]) {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0001_0000_01b3);
    }
    for byte in task.as_bytes().iter().chain(&[0u8]) {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0001_0000_01b3);
    }
    for byte in source.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0001_0000_01b3);
    }
    format!("{hash:016x}")
}

/// E1 §3.2：续写注入模板的 kind 人读化（锁定模板测试断言绑定；
/// 瞬态四类取变体名风格，非瞬态回退 kebab-case——模板仅瞬态类可达）
fn resume_kind_label(kind: ProviderErrorKind) -> &'static str {
    match kind {
        ProviderErrorKind::RateLimit => "RateLimit",
        ProviderErrorKind::ServerError => "ServerError",
        ProviderErrorKind::Timeout => "Timeout",
        ProviderErrorKind::Network => "Network",
        ProviderErrorKind::Aborted => "aborted",
        ProviderErrorKind::PayloadTooLarge => "payload-too-large",
        ProviderErrorKind::GatewayChallenge => "gateway-challenge",
        ProviderErrorKind::Auth => "auth",
        ProviderErrorKind::Quota => "quota",
        ProviderErrorKind::EndpointUnavailable => "endpoint-unavailable",
        ProviderErrorKind::ContextLengthExceeded => "context-length-exceeded",
        ProviderErrorKind::InvalidRequest => "invalid-request",
        ProviderErrorKind::Unknown => "unknown",
    }
}

/// D1 §3.1.4：`provider_retry_backoff_ms` 键纯解析（可单测；宽容
/// fail-open）：
/// - JSON 数组 [base, max, budget] → 三字段全量配置；
/// - JSON 单数值 base → 仅 base 定制（max/budget None 回落内核常量）；
/// - 其余形状 / 坏 JSON → None（不装配 = 现状立即重试向后兼容）。
fn parse_retry_backoff_config(raw: &str) -> Option<session_loop::r#loop::RetryBackoffConfig> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    match value {
        serde_json::Value::Number(n) => Some(session_loop::r#loop::RetryBackoffConfig {
            base_ms: n.as_u64(),
            max_ms: None,
            total_budget_ms: None,
        }),
        serde_json::Value::Array(items) => {
            let mut nums = items.iter().filter_map(|item| item.as_u64());
            let base_ms = nums.next();
            let max_ms = nums.next();
            let total_budget_ms = nums.next();
            base_ms.map(|base_ms| session_loop::r#loop::RetryBackoffConfig {
                base_ms: Some(base_ms),
                max_ms,
                total_budget_ms,
            })
        }
        _ => None,
    }
}

/// D2 §3.3：会话首条非 steering user 消息（任务文本提取）。steering
/// 注入消息带 `{kind:"steering"}` 元数据——error 续 run 的注入文本
/// 「继续任务」即 steering 形态，直取会让指纹从第二次起漂移到注入
/// 模板上（selection-03 评审护栏 5 同款混淆）。
fn main_task_text(messages: &[Arc<AgentMessage>]) -> String {
    messages
        .iter()
        .find(|m| m.role == AgentMessageRole::User && !is_steering_message(m))
        .map(|m| m.text().trim().to_string())
        .unwrap_or_default()
}

/// steering 注入判定（消息 metadata.kind == "steering"）
fn is_steering_message(message: &AgentMessage) -> bool {
    message
        .metadata
        .as_ref()
        .and_then(|meta| meta.get("kind"))
        .and_then(|kind| kind.as_str())
        == Some("steering")
}

/// E1 §2.1：最后一条 assistant 消息的信号提取（D7 流中断标注）
fn last_assistant_provider_signal(
    messages: &[Arc<AgentMessage>],
) -> Option<LastAssistantSignal> {
    let last = messages.iter().rev().find(|m| m.role == AgentMessageRole::Assistant)?;
    let is_plain_text = last.tool_calls().next().is_none() && !last.text().is_empty();
    let (kind, retryable) = provider_signal_metadata(last.metadata.as_ref());
    Some(LastAssistantSignal {
        kind,
        retryable,
        is_plain_text,
    })
}

/// 从消息 metadata 提取 providerErrorKind / providerErrorRetryable
/// （D7 §3.7 标注；kebab-case 字符串解析，坏值 None）
fn provider_signal_metadata(
    metadata: Option<&serde_json::Value>,
) -> (Option<ProviderErrorKind>, Option<bool>) {
    let Some(meta) = metadata else {
        return (None, None);
    };
    let kind = meta
        .get("providerErrorKind")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str::<ProviderErrorKind>(&format!("\"{s}\"")).ok());
    let retryable = meta
        .get("providerErrorRetryable")
        .and_then(|v| v.as_bool());
    (kind, retryable)
}

/// D5 §3.3：goal 收口评估输入预提取（消息面三要素 + 事件载荷计数）
fn extract_goal_round_signals(messages: &[Arc<AgentMessage>]) -> GoalRoundSignals {
    let mut assistant_text = String::new();
    let mut tool_calls: Vec<ToolCallStamp> = Vec::new();
    let mut tool_success_count: u32 = 0;
    let mut tool_call_count: u32 = 0;
    for message in messages {
        if message.role == AgentMessageRole::Assistant {
            let text = message.text();
            if !text.is_empty() {
                assistant_text = text;
            }
            for call in message.tool_calls() {
                tool_call_count += 1;
                let keys = call
                    .input
                    .as_object()
                    .map(|object| object.keys().cloned().collect())
                    .unwrap_or_default();
                tool_calls.push(ToolCallStamp {
                    tool_name: call.tool_name.clone(),
                    param_keys: keys,
                });
            }
        }
        if message.role == AgentMessageRole::Tool {
            for block in &message.blocks {
                if let AgentMessageBlock::ToolResult { is_error, .. } = block {
                    if !is_error {
                        tool_success_count += 1;
                    }
                }
            }
        }
    }
    GoalRoundSignals {
        assistant_text,
        tool_calls,
        tool_success_count,
        tool_call_count,
        message_count: messages.len() as u32,
    }
}

/// D5 §3.7：续轮注入文本构造（主源 = goal 前缀，增强 = nextSteps；
/// 模板对齐 buildGoalModePrefix，goalModeController.ts:74-95）
fn build_goal_continuation_prompt(goal_state: &GoalState, next_steps: &[String]) -> String {
    let round = goal_state.current_round + 1;
    let mut text = format!(
        "[目标模式 · 系统指令]\n\
         你正在执行长期目标，请持续推进直至完成，并在每轮结束前自检进度。\n\
         目标：{}\n\
         当前第 {}/{} 轮（自动续写上限 {} 轮）。\n\
         请工作直至目标实质完成；不要半途停下或只列计划而不执行。\n\
         请在回复中维护 markdown 任务清单（`- [ ]` / `- [x]`），便于进度同步。\n\
         若目标已完成，请在回复末尾明确写出 DONE 或「目标已完成」。",
        goal_state.goal,
        round,
        goal_state.max_rounds,
        goal_state.max_rounds
    );
    if !next_steps.is_empty() {
        text.push_str("\n上轮进度小结（供续接）：\n");
        for step in next_steps {
            text.push_str(&format!("- 下一步：{step}\n"));
        }
    }
    text.push_str("---");
    text
}

/// D5 §3.9：GoalDecision → wire 值（Continue/Completed/NoProgress/
/// Blocked/NoGoal，events.rs 载荷注释约定）
fn goal_decision_wire(decision: GoalDecision) -> String {
    match decision {
        GoalDecision::Continue => "Continue",
        GoalDecision::Completed => "Completed",
        GoalDecision::NoProgress => "NoProgress",
        GoalDecision::Blocked => "Blocked",
        GoalDecision::NoGoal => "NoGoal",
    }
    .to_string()
}

/// D2 §3.4（C4 锁死）：跨 run 续 run 退避延迟注入点类型（attempt =
/// 本次消费后的预算计数；测试直接驱动，不依赖 tokio pause）
pub(crate) type BackoffDelayFn = Arc<dyn Fn(u32) -> Duration + Send + Sync>;

/// D3 §3.2.2：阶梯 1 恢复计划（C7 决策的壳层执行载体——AutoRetry 时
/// 携带退避 delay、重入上下文与协调器引用，供收口后重派执行）
enum RecoveryPlan {
    /// 预算内自动重试（重试不计入 run 失败；delay 已钳到单次上限与
    /// 剩余预算）
    AutoRetry {
        /// 重试前等待时长
        delay: Duration,
        /// run 失败上下文（重派请求与 escalate 重入共用）
        ctx: RunFailureContext,
        /// 会话恢复协调器（重入 escalate 用）
        coord: Arc<Mutex<RecoveryCoordinator>>,
    },
}

// ── 命令返回形状（03 §3.2 A 组契约）───────────────────────────────

/// core_run_task 返回（03 §3.1：{runId, sessionId} 回执）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskResponse {
    pub run_id: String,
    pub session_id: String,
}

/// core_cancel_run 返回（{ok, runId}；pid 无进程内概念，省略）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRunResponse {
    pub ok: bool,
    pub run_id: String,
}

/// core_approve_tool / core_deny_tool 返回（{ok, toolCallId, decision}）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveResponse {
    pub ok: bool,
    pub tool_call_id: String,
    pub decision: &'static str,
}

// ── RunProducer trait（drive_run_loop 的循环输入）──────────────────

/// run 生产接口（drive_run_loop 的 `produce` 步骤）
///
/// 当前实现 [SessionLoopProducer]（engine.rs）：单次 produce 即覆盖整个
/// run（含多 turn），drive_outcome 收口终态后退出；未来 goal 多轮模式
/// 在本循环续轮。
#[async_trait::async_trait]
pub(crate) trait RunProducer: Send {
    /// 生产一次 run 结果
    async fn produce(&mut self) -> RunOutcome;
}

#[async_trait::async_trait]
impl RunProducer for SessionLoopProducer {
    async fn produce(&mut self) -> RunOutcome {
        SessionLoopProducer::produce(self).await
    }
}

// ── 审批门（ApprovalGate 实现）────────────────────────────────────

/// 待审批请求元信息（R1-04 REST 写面 [list_pending_approvals_impl] 数据源）
///
/// 生命周期与 [ApprovalGateImpl::pending] 的 oneshot 通道完全一致：
/// `request_approval` 登记、`resolve` 清除——「已请求未裁决」的运行时真源
/// （M6 C13 派生态的实时版本；run 终态移出活动注册表，天然满足「run 未
/// 终态」条件）。parameters 全量不下发（隐私红线，D6 §7.2），只记键名。
pub(crate) struct PendingRequestMeta {
    /// 工具名
    pub tool_name: String,
    /// 请求摘要
    pub summary: String,
    /// 工具工作目录
    pub cwd: String,
    /// 会话 id
    pub session_id: String,
    /// 请求方 run 归属（None = 主 agent run；与 approval-requested 同源）
    pub requester_run_id: Option<String>,
    /// 申请理由（子代理来源；None = 主 agent 请求）
    pub reason: Option<String>,
    /// 裁决者 wire 名（user / main-agent；与
    /// approval-requested.metadata.arbiter 同源）
    pub arbiter: String,
    /// 请求时刻（epoch ms；expiresAt = requestedAt + APPROVAL_TIMEOUT）
    pub requested_at_ms: u64,
    /// 参数键名列表（parameters 全量不下发，仅键名，M6 C13）
    pub param_keys: Vec<String>,
}

/// 审批门（B6.1：approval-requested 先发后等防死锁，01 §五.8）
///
/// - `request_approval`：广播 approval-requested（经缓冲事件桥，实时通道）
///   → 注册 oneshot 等待 → 超时返回 [ApprovalDecision::Expired]；
/// - `resolve`：core_approve_tool / core_deny_tool 入口——**先校验
///   tool_call_id 在待审批集合**（AA-05 I-02 / PE-12 T12.3：不匹配返回
///   NotFound，杜绝伪造审计事件），再送决策并恢复 run 状态机
///   （awaiting-approval → running）。
pub(crate) struct ApprovalGateImpl {
    /// run 标识
    run_id: String,
    /// 会话标识
    session_id: String,
    /// 父 run 归属（T-D-14 权限传递层）：None = 主 agent run / 无父 run
    /// （审批裁决者 = 用户，现状不变）；Some = 子代理 run 的父 run id
    /// （审批请求路由给主 agent 裁决，可经死锁防护转用户兜底）
    parent_run_id: Option<String>,
    /// 死锁检测器（T-D-14 开放问题 6.4，时序评审见 approval_router.rs 模块
    /// 头注）：判定「裁决者（主 agent）正在 wait 本 run（子代理）」——
    /// 命中时路由转用户打破 120s 空等；None = 未接线（退化纯超时兜底，
    /// 行为与现状一致）。真实 wait 态信号源 = orchestrator 子代理跟踪器
    /// （wait_subagents 工具执行期间标记），由 F11 T-D-13 引擎接线注入。
    deadlock_detector: Option<Box<dyn Fn(&str) -> bool + Send + Sync>>,
    /// 广播 approval-requested（先发后等；信封 sequence=None 实时预览，
    /// 收口流携带持久化序列）
    broadcast: Box<dyn Fn(AgentEvent) + Send + Sync>,
    /// 待审批集合：tool_call_id → 决策通道（I-02 校验依据）
    pending: std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<ApprovalDecision>>>,
    /// 待审批请求元信息（R1-04：与 [Self::pending] 同生命周期，见
    /// [PendingRequestMeta]——request 登记、resolve 清除）
    pending_meta: std::sync::Mutex<HashMap<String, PendingRequestMeta>>,
    /// run 状态机联动（awaiting-approval 中间态落库）
    handle: Arc<tokio::sync::Mutex<RunHandle>>,
    /// store（状态机转移落库）
    store: Arc<dyn Store>,
    /// 工具执行工作目录（PermissionRequest.cwd）
    cwd: Option<String>,
}

impl ApprovalGateImpl {
    /// 新建审批门
    pub(crate) fn new(
        run_id: String,
        session_id: String,
        parent_run_id: Option<String>,
        broadcast: Box<dyn Fn(AgentEvent) + Send + Sync>,
        handle: Arc<tokio::sync::Mutex<RunHandle>>,
        store: Arc<dyn Store>,
        cwd: Option<String>,
    ) -> Self {
        Self {
            run_id,
            session_id,
            parent_run_id,
            deadlock_detector: None,
            broadcast,
            pending: std::sync::Mutex::new(HashMap::new()),
            pending_meta: std::sync::Mutex::new(HashMap::new()),
            handle,
            store,
            cwd,
        }
    }

    /// 注入死锁检测器（T-D-14 开放问题 6.4）：判定「裁决者 run 正在 wait
    /// 本 run（子代理）」——命中时审批请求路由转用户（UI 裁决面不受主
    /// agent wait 状态阻塞）；不注入 = 纯超时兜底（120s Expired，子代理
    /// run 不中断，行为与现状一致）。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn with_deadlock_detector(
        mut self,
        detector: Box<dyn Fn(&str) -> bool + Send + Sync>,
    ) -> Self {
        self.deadlock_detector = Some(detector);
        self
    }

    /// 解析审批（core_approve_tool / core_deny_tool 入口）
    ///
    /// I-02（T12.3）：tool_call_id 必须在待审批集合，不匹配返回
    /// NotFound（杜绝伪造 approval-resolved 审计事件 / 提前审批）。
    /// 文案含 `pending` 关键字：`DeviceErrorCode::from_core_error` 对
    /// 审批域 NotFound 升级为 cmd.approval_mismatch（F2 §11.2 冲突信号，
    /// 移动端据此收敛「已被其他设备处理 / 已过期」）。
    pub(crate) async fn resolve(
        &self,
        tool_call_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), CoreError> {
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tool_call_id)
            .ok_or_else(|| {
                CoreError::NotFound(format!(
                    "tool_call_id not in pending approvals（run={}）：{tool_call_id}",
                    self.run_id
                ))
            })?;
        // R1-04：与决策通道同步清除待办元信息（list_pending_approvals
        // 不再返回已裁决条目）
        self.pending_meta
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tool_call_id);
        let _ = sender.send(decision);
        // 状态机恢复：awaiting-approval → running（B4.1 审批恢复路径）
        let mut handle = self.handle.lock().await;
        if let Err(error) = handle.resolve_approval(self.store.as_ref()).await {
            tracing::warn!(
                target: "approval",
                run_id = %self.run_id,
                error = %error,
                "resolve_approval 失败（审批决策已送达，状态机兜底）"
            );
        }
        Ok(())
    }

    /// 待审批集合是否包含指定工具调用（R1-04：run_id 缺失时按待审批
    /// 集合反查——M6 C11「runId 缺失容错」）
    pub(crate) fn contains_pending(&self, tool_call_id: &str) -> bool {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(tool_call_id)
    }

    /// 待审批请求元信息快照（R1-04：[list_pending_approvals_impl]
    /// 数据源；返回 (tool_call_id, meta) 列表，与 pending 通道同生命周期）
    pub(crate) fn pending_requests(&self) -> Vec<(String, PendingRequestMeta)> {
        self.pending_meta
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(tool_call_id, meta)| {
                (
                    tool_call_id.clone(),
                    PendingRequestMeta {
                        tool_name: meta.tool_name.clone(),
                        summary: meta.summary.clone(),
                        cwd: meta.cwd.clone(),
                        session_id: meta.session_id.clone(),
                        requester_run_id: meta.requester_run_id.clone(),
                        reason: meta.reason.clone(),
                        arbiter: meta.arbiter.clone(),
                        requested_at_ms: meta.requested_at_ms,
                        param_keys: meta.param_keys.clone(),
                    },
                )
            })
            .collect()
    }
}

#[async_trait::async_trait]
impl ApprovalGate for ApprovalGateImpl {
    async fn request_approval(
        &self,
        call_id: &str,
        tool_name: &str,
        args: &serde_json::Value,
        requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        // 1. 来源分类 + 裁决者路由（T-D-14 权限传递层）：子代理来源 →
        //    主 agent 裁决（默认）；主 agent 来源 → 用户（现状不变）；
        //    死锁检测命中（主 agent 正在 wait 该子代理）→ 转用户兜底。
        let source = classify_source(&self.run_id, self.parent_run_id.as_deref());
        let arbiter = self
            .deadlock_detector
            .as_ref()
            .map(|detector| route_approval_guarded(&source, detector(&self.run_id)))
            .unwrap_or_else(|| route_approval(&source));
        tracing::info!(
            target: "approval",
            run_id = %self.run_id,
            parent_run_id = ?self.parent_run_id,
            arbiter = ?arbiter,
            requester_run_id = requester.map(|r| r.run_id.as_str()),
            "审批请求（权限传递层裁决者路由）"
        );

        // 2. 广播 approval-requested（防死锁：先发出再等待，01 §五.8；
        //    实时通道 sequence=None 预览，持久化副本随收口流落库）
        let request = PermissionRequest {
            id: format!("approval-{call_id}"),
            session_id: self.session_id.clone(),
            cwd: self.cwd.clone().unwrap_or_default(),
            tool_call_id: call_id.to_string(),
            tool_name: tool_name.to_string(),
            parameters: args.clone(),
            summary: format!("call {tool_name}"),
            tool_metadata: Default::default(),
            // T-D-14：路由分支可观测落点——子代理来源路由给主 agent 时
            // metadata.arbiter=main-agent（前端据此渲染主 agent 裁决面）；
            // 用户裁决面 None（主 agent run 现状载荷字节不变）
            metadata: arbiter_metadata(arbiter),
            // T-D-14：请求方身份（子代理 run id + 申请理由）随载荷广播
            // 与落库（None = 主 agent run，向后兼容）
            requester_run_id: requester.map(|r| r.run_id.clone()),
            reason: requester.and_then(|r| r.reason.clone()),
        };
        (self.broadcast)(AgentEvent::ApprovalRequested {
            session_id: self.session_id.clone(),
            request,
            timestamp: crate::engine::now_iso_utc(),
        });

        // 2. 状态机联动：running → awaiting-approval（落库，中间态可观测）
        {
            let mut handle = self.handle.lock().await;
            if let Err(error) = handle.request_approval(self.store.as_ref()).await {
                tracing::warn!(
                    target: "approval",
                    run_id = %self.run_id,
                    error = %error,
                    "request_approval 状态机转移失败（审批仍可等待）"
                );
            }
        }

        // 3. 注册等待通道（先发后等，防死锁）
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            if pending.contains_key(call_id) {
                // 同 call 重复审批请求：覆盖旧通道（旧等待超时自然收口）
                let _ = pending.remove(call_id);
            }
            pending.insert(call_id.to_string(), tx);
        }
        // R1-04：同步登记待办元信息（list_pending_approvals 对账数据源；
        // 与 pending 通道同生命周期，resolve 时清除）。arbiter wire 名与
        // 上方广播的 metadata.arbiter 同源（main-agent / user）。
        {
            let mut meta = self.pending_meta.lock().unwrap_or_else(|e| e.into_inner());
            meta.insert(
                call_id.to_string(),
                PendingRequestMeta {
                    tool_name: tool_name.to_string(),
                    summary: format!("call {tool_name}"),
                    cwd: self.cwd.clone().unwrap_or_default(),
                    session_id: self.session_id.clone(),
                    requester_run_id: requester.map(|r| r.run_id.clone()),
                    reason: requester.and_then(|r| r.reason.clone()),
                    arbiter: match arbiter {
                        session_loop::approval_router::Arbiter::MainAgent => "main-agent".to_string(),
                        session_loop::approval_router::Arbiter::User => "user".to_string(),
                    },
                    requested_at_ms: crate::server::now_ms(),
                    param_keys: args
                        .as_object()
                        .map(|map| map.keys().cloned().collect())
                        .unwrap_or_default(),
                },
            );
        }

        // 4. 等待决策（超时 → Expired；工具侧按非致命处理，01 §五.8）
        match tokio::time::timeout(APPROVAL_TIMEOUT, rx).await {
            Ok(Ok(decision)) => decision,
            Ok(Err(_)) | Err(_) => ApprovalDecision::Expired,
        }
    }
}

// ── ActiveRun：活动 run 注册表条目 ────────────────────────────────

/// 活动 run 条目（活动注册表 `active_runs: run_id → ActiveRun`）
///
/// 并发模型（AA-02）：异步路径（drive / cancel / approve）经 tokio Mutex
/// 访问 [RunHandle] 与 [EventQueue]；std Mutex（控制总线）不跨 await 持有。
pub(crate) struct ActiveRun {
    /// 会话标识
    session_id: String,
    /// run 标识
    run_id: String,
    /// run 状态机句柄（drive 收口 / cancel 三路径 / approve 状态机联动）
    handle: Arc<tokio::sync::Mutex<RunHandle>>,
    /// 事件队列（drive 收口 + approve-resolved 落库共用）
    queue: Arc<tokio::sync::Mutex<EventQueue>>,
    /// 控制总线（L2 协作停止 / L1 注入意图）
    control_bus: Arc<Mutex<ControlBus>>,
    /// L3 强停信号（AbortSignal，安全点协作）
    abort_signal: AbortSignal,
    /// 审批门
    approval: Arc<ApprovalGateImpl>,
    /// 本 run 的缓冲事件桥（gate 广播 / delta sink / 收口 emit 共用）
    bridge: Arc<BufferedRunEventBridge>,
    /// 实时 delta 是否激活（T09.1：激活时收口 message-delta 跳过不双发）
    delta_sink_active: bool,
    /// 逃逸监视句柄（T-ESC-03：run 起停钩子；None = 未启用。Mutex 包装：
    /// drive / finalize 路径经锁 take 出句柄后 async 收口，锁不跨 await）
    escape_watch: Mutex<Option<EscapeWatchHandle>>,
    /// 驱动任务句柄（30-P1：spawn(drive_run_loop) 的 JoinHandle）。
    /// Mutex<Option> 形态——ActiveRun 构造在前、spawn 在后，句柄经
    /// [Self::set_driver] 事后登记；收口**不 await**（JoinHandle drop 即
    /// detach，tokio 语义，防挂起），句柄供可观测与未来 join
    driver: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// T-CF-11：本 run 是否有用户交互（用户经 L1 soft_inject 注入消息 /
    /// force_cancel 置位；收口判定「用户消息到达后的正常收场不触发续
    /// run」的依据）
    user_touched: AtomicBool,
    /// 子代理 run 装配配置（T-D-13：Some = 本 run 是子代理 run——收口
    /// 时经 spawner 终态处理（记账释放 / 事件发射 / steering 通知）；
    /// None = 普通 run，收口行为与现状一致）
    subagent: Option<crate::subagent_spawner::SubagentRunConfig>,
    /// L4（F12）：审计落库 worker 句柄（run 级；收口处 take + await
    /// 排空——保证审计底账在 run 终态前全部落库；None = 测试驱动路径
    /// 未装配）
    audit_persist: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl ActiveRun {
    /// 登记驱动任务句柄（30-P1；spawn 后调用一次，重复登记覆盖——驱动
    /// 任务每 run 仅一个）
    pub(crate) fn set_driver(&self, handle: tauri::async_runtime::JoinHandle<()>) {
        *self.driver.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    }

    /// 驱动任务是否已收口（观测 / 测试轮询；不 await，语义 = tokio
    /// JoinHandle::is_finished——已收口 / 已取消均成立）
    #[cfg_attr(not(test), allow(dead_code))] // 测试断言面消费；生产供未来 join/观测（30-P1 句柄管理）
    pub(crate) fn driver_finished(&self) -> bool {
        self.driver
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|handle| handle.inner().is_finished())
            .unwrap_or(false)
    }
}

/// 活动 run 的引擎取消接口（[orchestrator::run::RunEngine] 实现：
/// L2 协作停止入控制总线，L3 强停触发 AbortSignal + 总线 force_cancel）
struct ActiveRunEngine {
    active: Arc<ActiveRun>,
}

impl RunEngine for ActiveRunEngine {
    fn request_cooperative_stop(&self, reason: &str) -> bool {
        let mut bus = self
            .active
            .control_bus
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        bus.request_cooperative_stop(Some(reason.to_string()), Some("ui".to_string()));
        true
    }

    fn abort(&self, reason: &str) {
        self.active.abort_signal.abort();
        let mut bus = self
            .active
            .control_bus
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        bus.request_force_cancel(Some(reason.to_string()), Some("ui".to_string()));
    }
}

/// 逃逸监视审计 sink（T-ESC-03 壳层适配）：security-audit 事件经本 run
/// 缓冲事件桥实时广播（信封 sequence=None 实时预览，前端审计面板实时
/// 可见；与审批门 broadcast 同构）。落库（append_event）L4（F12）已
/// 接线：同步广播外另发持久化通道，由单 worker 按发射序
/// reserve_sequence + append_event 落库（events 表审计底账；广播保实时、
/// 落库保底账，双轨并存）。
#[derive(Debug)]
struct BridgeAuditSink {
    /// 本 run 缓冲事件桥
    bridge: Arc<BufferedRunEventBridge>,
    /// run 标识（信封注入）
    run_id: String,
    /// 审计持久化通道（L4：worker 按发射序落库；发送失败 = worker 已
    /// 退出，落库尽力而为，广播不受影响）
    persist: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
}

impl BridgeAuditSink {
    /// 新建桥接审计 sink（run 级实例；persist 通道由 run 装配轮创建，
    /// worker 与 run 同生命周期）
    fn new(
        bridge: Arc<BufferedRunEventBridge>,
        run_id: String,
        persist: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    ) -> Self {
        Self {
            bridge,
            run_id,
            persist,
        }
    }
}

impl SecurityAuditSink for BridgeAuditSink {
    fn emit(&self, event: &AgentEvent) {
        // L4（F12）：审计底账落库——先发持久化通道（worker 按发射序
        // reserve + append_event；通道关闭仅告警，广播已保实时轨）
        if let Err(error) = self.persist.send(event.clone()) {
            tracing::warn!(
                target: "audit",
                run_id = %self.run_id,
                error = %error,
                "审计落库通道已关闭（保留实时轨，落库尽力而为）"
            );
        }
        let envelope = AgentEventEnvelope::new(event.clone(), Some(self.run_id.clone()), None);
        self.bridge.emit(&envelope);
        self.bridge.flush();
    }
}

/// 审计落库 worker（L4：审计底账持久化——广播保实时、落库保底账）
///
/// 单 worker 串行消费 mpsc 通道：严格保持发射序 → 会话级 sequence
/// 单调不逆序；复用 [orchestrator::events::EventQueue] 的
/// `push_terminal_best_effort` 尽力语义（store 失败仅告警，审计不阻断
/// run、不标记 run 失败）。生命周期：随 run 收口（桥引用全部释放 →
/// sender drop 发出关闭信号 → 排空后退出；收口处 await 保证终态前
/// 落库完成）。
fn spawn_audit_persistence(
    queue: Arc<tokio::sync::Mutex<EventQueue>>,
    session_id: String,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let sequenced = queue
                .lock()
                .await
                .push_terminal_best_effort(&session_id, event)
                .await;
            if !sequenced.persisted {
                tracing::warn!(
                    target: "audit",
                    session_id = %session_id,
                    event_type = sequenced.event.type_name(),
                    "审计事件落库失败（保留实时轨，审计底账尽力而为）"
                );
            }
        }
    })
}

/// 逃逸监视主 agent 注入器（T-ESC-03 壳层适配）：归因摘要经 L1
/// followUp 环注入会话（D8：run 内不注入，run idle promote 后成为
/// 下一条用户消息——主 agent 下一轮即可看到，REQ §3.3 第 3 点；
/// 注入频率限流由聚合报告粒度承担）
struct ControlBusInjector {
    /// 本 run 控制总线（std Mutex，锁不跨 await 持有）
    bus: Arc<Mutex<ControlBus>>,
}

impl ControlBusInjector {
    /// 新建注入器（总线与 run 同生命周期）
    fn new(bus: Arc<Mutex<ControlBus>>) -> Self {
        Self { bus }
    }
}

impl EscapeWatchInjector for ControlBusInjector {
    fn inject(&self, text: &str) {
        let mut bus = self.bus.lock().unwrap_or_else(|e| e.into_inner());
        bus.request_follow_up(
            crate::engine::user_message(text, None),
            Some("escape-watch".to_string()),
            Some("system".to_string()),
        );
    }
}

// ── SessionHistoryCache（T-29：per-session 历史缓存）────────────

/// 引擎壳侧 per-session 历史缓存（P4 阶段 1-3/1-4，任务单元 T-29）
///
/// - 结构：`session_id → Vec<HistoryMessage>`——与前端 `history` 参数
///   同构（混合路线统一载荷形态，P4 §3.2.3）；
/// - 内存态、不落库：避免与前端全量写 session_messages 双写冲突
///   （P4 §1.3 验收红线 2）；不改写会话语义；
/// - 写入时机：run 收口（[drive_run_loop] 收口处，[RunOutcome]::messages
///   收口映射后原子替换 = 压缩后缓存基线重建，P4 §3.6 I5 / C13）；
/// - 读取：下次 run 组装 history 参数（[core_run_task]：前端 history
///   为空/未传时回退本缓存——混合路线"引擎侧缓存主"）；
/// - 容量护栏：每会话消息条数上限 + 会话数上限（防膨胀）。
pub(crate) struct SessionHistoryCache {
    inner: Mutex<CacheInner>,
    /// 每会话 token 预算（DEEPCHECK-01 P0 起替代消息条数上限）
    max_tokens: usize,
    /// 会话数上限
    max_sessions: usize,
}

struct CacheInner {
    sessions: HashMap<String, Vec<HistoryMessage>>,
    /// 写入顺序（FIFO 淘汰最久未更新的会话；重复写入移到末尾 ≈ LRU）
    order: VecDeque<String>,
}

impl SessionHistoryCache {
    /// 新建缓存（默认容量：每会话 `SESSION_HISTORY_TOKEN_BUDGET` token、
    /// 最多 `SESSION_HISTORY_MAX_SESSIONS` 个会话）
    pub(crate) fn new() -> Self {
        Self::with_limits(SESSION_HISTORY_TOKEN_BUDGET, SESSION_HISTORY_MAX_SESSIONS)
    }

    /// 新建缓存（显式容量；测试用小容量验证上限语义）
    /// `max_tokens`：每会话 token 预算（DEEPCHECK-01 P0 起替代消息条数上限）
    pub(crate) fn with_limits(max_tokens: usize, max_sessions: usize) -> Self {
        Self {
            inner: Mutex::new(CacheInner {
                sessions: HashMap::new(),
                order: VecDeque::new(),
            }),
            max_tokens,
            max_sessions,
        }
    }

    /// 读取会话历史（下次 run 组装 history 参数的缓存源；None = 无缓存）
    pub(crate) fn get(&self, session_id: &str) -> Option<Vec<HistoryMessage>> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions
            .get(session_id)
            .cloned()
    }

    /// 写入会话历史（run 收口原子替换）
    ///
    /// 写入前执行两级护栏（DEEPCHECK-01 P0：锚点 + 预算，跨 run 前缀稳定）：
    /// 1. token 预算：超预算按 [truncate_history_with_anchor] 截断——首条
    ///    user 锚点恒在 + 尾部预算窗口（不再固定条数尾部滑窗）；
    /// 2. 安全前缀：逐条前移直到首条为 user（不保留孤儿 tool/system
    ///    首条与带未配对 ToolCall 的 assistant 首条——wire 400 风险）。
    ///
    /// 会话数超限：FIFO 淘汰最久未更新的会话。
    pub(crate) fn store(&self, session_id: &str, mut messages: Vec<HistoryMessage>) {
        truncate_history_with_anchor(&mut messages, self.max_tokens);
        ensure_safe_prefix(&mut messages);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pos) = inner.order.iter().position(|id| id == session_id) {
            inner.order.remove(pos);
        }
        inner.order.push_back(session_id.to_string());
        while inner.order.len() > self.max_sessions {
            if let Some(oldest) = inner.order.pop_front() {
                inner.sessions.remove(&oldest);
            }
        }
        inner.sessions.insert(session_id.to_string(), messages);
    }
}

/// DEEPCHECK-01 P0：历史截断统一语义——「稳定锚点 + token 预算」（前端
/// buildHistoryMessages / 引擎缓存读写三层同语义，跨 run 请求前缀稳定）。
///
/// 语义：
/// 1. 预算内 → 原样保留（append-only，请求前缀天然字节稳定，服务端自动
///    前缀缓存全量命中——不再逐轮尾部滑窗整体漂移）；
/// 2. 超预算 → 锚点恒在：保留「首条 user 消息及其前的稳定头部」，其余从
///    最老消息起逐条让位直到尾部窗口装入预算（预算内尾部截断而非固定
///    条数截断）——锚点 = 会话首条 user，永不因截断消失，失配点收敛到
///    尾部增量；
/// 3. 尾部边界 wire 安全：截断点不落在孤儿 tool 消息（其 ToolCall 已被
///    截掉，结果在截断区必然紧随其调用，故只可能落在窗口起点）或携带
///    孤儿 ToolCall 的 assistant 上（wire 400 风险，与 [ensure_safe_prefix]
///    同语义；前端载荷仅 user/assistant 且单条自包含，无此步骤）。
pub(crate) fn truncate_history_with_anchor(
    messages: &mut Vec<HistoryMessage>,
    max_tokens: usize,
) {
    let total: usize = messages.iter().map(estimate_history_tokens).sum();
    if messages.is_empty() || total <= max_tokens {
        return;
    }
    // 锚点 = 首条 user 消息；无 user → 以首条为锚（退化形态仍保证前缀稳定）
    let anchor_end = messages
        .iter()
        .position(|m| m.sender == "user")
        .unwrap_or(0);
    let head_tokens: usize = messages[..=anchor_end]
        .iter()
        .map(estimate_history_tokens)
        .sum();
    // 尾部窗口：从旧到新尽量多带（tail_start 尽可能小，预算内）
    let mut tail_start = anchor_end + 1;
    let mut tail_tokens = total - head_tokens;
    while tail_start < messages.len() && head_tokens + tail_tokens > max_tokens {
        tail_tokens -= estimate_history_tokens(&messages[tail_start]);
        tail_start += 1;
    }
    // 尾部边界 wire 安全：跳过孤儿 tool 首条与携带孤儿 ToolCall 的
    // assistant（结果消息的调用恒在其前，孤儿只可能落在窗口起点）
    while tail_start < messages.len() {
        let must_drop = match messages[tail_start].sender.as_str() {
            "tool" | "system" => true,
            "assistant" => first_has_orphan_tool_call(&messages[tail_start..]),
            _ => false,
        };
        if !must_drop {
            break;
        }
        tail_start += 1;
    }
    // 移除锚点后到尾部窗口起点之间的中间段（锚点与尾部恒在）
    if tail_start > anchor_end + 1 {
        messages.drain(anchor_end + 1..tail_start);
    }
}

/// 单条 HistoryMessage 的 token 估算（对齐前端 estimateHistoryMessageTokens：
/// 复用 conex-compaction count_tokens 启发式——ASCII 单词约 4 字符/token、
/// 分隔符与 CJK 每字符 1 token；固定消息开销 8 token）。
///
/// 字段口径：缓存路径消息带完整 `blocks_json`（收口保真）→ 直接估算其
/// JSON 序列（覆盖 text/thinking/tool-call/tool-result 全部块与输出正文）；
/// 缺块（前端载荷形态）→ 按 text/thinking/tool_calls_json/
/// tool_call_results_json 合成字段估算。
fn estimate_history_tokens(entry: &HistoryMessage) -> usize {
    let content_tokens = if let Some(blocks) = entry.blocks_json.as_deref() {
        count_tokens(blocks)
    } else {
        entry.text.as_deref().map(count_tokens).unwrap_or(0)
            + entry.thinking.as_deref().map(count_tokens).unwrap_or(0)
            + entry.tool_calls_json.as_deref().map(count_tokens).unwrap_or(0)
            + entry
                .tool_call_results_json
                .as_deref()
                .map(count_tokens)
                .unwrap_or(0)
    };
    content_tokens + SESSION_HISTORY_MESSAGE_TOKEN_OVERHEAD
}

/// 缓存安全前缀化：首条不得为 tool/system（孤儿——需要前置上下文），
/// 也不得为携带未配对 ToolCall 的 assistant（孤儿调用——wire 400）。
/// 逐条前移直到首条为 user（或序列为空）。
fn ensure_safe_prefix(messages: &mut Vec<HistoryMessage>) {
    while let Some(first) = messages.first() {
        let must_drop = match first.sender.as_str() {
            "tool" | "system" => true,
            "assistant" => first_has_orphan_tool_call(messages),
            _ => false,
        };
        if must_drop {
            messages.remove(0);
        } else {
            break;
        }
    }
}

/// 首条 assistant 是否携带孤儿 ToolCall（其调用 id 在后续消息中无
/// 对应 ToolResult——截断落在 assistant(tool_calls) 与其结果之间）。
/// 全部调用都有结果才算配对完整（wire 要求每个 call 都有 result）。
fn first_has_orphan_tool_call(messages: &[HistoryMessage]) -> bool {
    let Some(first) = messages.first() else {
        return false;
    };
    let Some(blocks) = parse_blocks(first) else {
        return false;
    };
    let call_ids: Vec<&str> = blocks
        .iter()
        .filter_map(|block| match block {
            AgentMessageBlock::ToolCall(call) => Some(call.id.as_str()),
            _ => None,
        })
        .collect();
    if call_ids.is_empty() {
        return false;
    }
    let has_all_results = call_ids.iter().all(|call_id| {
        messages.iter().skip(1).any(|entry| {
            parse_blocks(entry).is_some_and(|entry_blocks| {
                entry_blocks.iter().any(|block| match block {
                    AgentMessageBlock::ToolResult { tool_call_id, .. } => tool_call_id == call_id,
                    _ => false,
                })
            })
        })
    });
    !has_all_results
}

/// 解析 HistoryMessage 的 blocks_json（缓存收口/读回均保真携带完整块序列）
fn parse_blocks(entry: &HistoryMessage) -> Option<Vec<AgentMessageBlock>> {
    entry
        .blocks_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<Vec<AgentMessageBlock>>(json).ok())
}

// ── T-29 收口映射：RunOutcome::messages → HistoryMessage ─────────

/// run 收口：对话消息 → HistoryMessage（任务书第 4 点）
///
/// - **全角色保真**（user/assistant/tool/system 都收口）：引擎缓存是
///   权威增量，工具结果（Tool 角色独立消息，executing_tools.rs:143-158）
///   必须原样续接，否则 wire 前缀 tool_call 无对应 result（400）；
///   hydrate.rs 的前端过滤规则（P4 §3.2.3 规则 2）只适用于 UI 载荷，
///   不适用于本收口路径（读回走 [cached_history_to_conversation] 保真水合）；
/// - `blocks_json` 保真（完整 AgentMessageBlock 序列）；`tool_calls_json`
///   /`tool_call_results_json` 置 None（有 blocks_json 时不再需要合成源）；
/// - `status = completed`（收口消息均为完成态）；
/// - `timestamp` = created_at 的 epoch ms 折算。
fn to_history_messages(outcome: &RunOutcome) -> Vec<HistoryMessage> {
    outcome
        .messages
        .iter()
        .map(|message| to_history_message(message.as_ref()))
        .collect()
}

/// 单条 AgentMessage → HistoryMessage（全角色保真）
fn to_history_message(message: &AgentMessage) -> HistoryMessage {
    HistoryMessage {
        id: message.id.clone(),
        sender: role_sender(message.role),
        text: non_empty(message.text()),
        thinking: non_empty(message.thought()),
        blocks_json: if message.blocks.is_empty() {
            None
        } else {
            serde_json::to_string(&message.blocks).ok()
        },
        tool_calls_json: None,
        tool_call_results_json: None,
        status: Some("completed".to_string()),
        timestamp: iso8601_to_epoch_millis(&message.created_at),
    }
}

/// 角色 → sender 字符串（与 hydrate.rs 规则 2 的 user/assistant 子集
/// 兼容，额外保留 tool/system——缓存路径读回不过滤）
fn role_sender(role: AgentMessageRole) -> String {
    match role {
        AgentMessageRole::System => "system",
        AgentMessageRole::User => "user",
        AgentMessageRole::Assistant => "assistant",
        AgentMessageRole::Tool => "tool",
    }
    .to_string()
}

/// 空串 → None（HistoryMessage 载荷字段可选语义）
fn non_empty(text: String) -> Option<String> {
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

// ── T-29 时间戳互逆（与 session-loop hydrate.rs 同源算法）────────

/// ISO8601 → epoch ms（引擎统一格式 `YYYY-MM-DDTHH:MM:SS.mmmZ`；
/// 宽容解析：毫秒段可缺省（`SSZ`），时区仅接受 Z；失败兜底 0）
fn iso8601_to_epoch_millis(iso: &str) -> i64 {
    let Some((date, rest)) = iso.split_once('T') else {
        return 0;
    };
    let mut parts = date.split('-');
    let (Some(year), Some(month), Some(day)) = (
        parts.next().and_then(|v| v.parse::<i64>().ok()),
        parts.next().and_then(|v| v.parse::<u32>().ok()),
        parts.next().and_then(|v| v.parse::<u32>().ok()),
    ) else {
        return 0;
    };
    let mut time = rest.split(':');
    let (Some(hour), Some(minute)) = (
        time.next().and_then(|v| v.parse::<i64>().ok()),
        time.next().and_then(|v| v.parse::<i64>().ok()),
    ) else {
        return 0;
    };
    let sec_rest = time.next().unwrap_or("0");
    let stripped = sec_rest.strip_suffix('Z').unwrap_or(sec_rest);
    let (sec, millis) = match stripped.split_once('.') {
        Some((s, ms)) => (
            s.parse::<i64>().unwrap_or(0),
            ms.parse::<i64>().unwrap_or(0),
        ),
        None => (stripped.parse::<i64>().unwrap_or(0), 0),
    };
    let days = days_from_civil(year, month, day);
    ((days * 86_400 + hour * 3600 + minute * 60 + sec) * 1000) + millis
}

/// 公历年月日 → Unix 天数（Howard Hinnant civil_from_days 的逆函数；
/// 与 session-loop hydrate.rs / steering mod.rs 同源算法）
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// epoch ms → ISO8601（毫秒精度 UTC；算法与 session-loop hydrate.rs
/// iso8601_from_epoch_millis 同源——读回缓存还原 created_at 用）
fn epoch_millis_to_iso8601(epoch_ms: i64) -> String {
    let secs = epoch_ms.div_euclid(1000);
    let millis = epoch_ms.rem_euclid(1000);
    let (hours, minutes, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{sec:02}.{millis:03}Z")
}

/// Unix 天数 → 公历年月日（Howard Hinnant 算法，与 session-loop
/// hydrate.rs:251-271 同源，不引入 chrono 依赖）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

// ── T-29 读回水合与混合路线装配 ──────────────────────────────────

/// 缓存读回 → 对话（**保真水合**：T-29 缓存路径，与 T-28 前端载荷
/// 过滤规则互补——缓存是引擎权威增量，tool/system 角色与完整 blocks
/// 原样续接，工具结果配对不拆散；单条不可用（角色未知 / blocks 不可
/// 解析）宽容跳过，不中断整体）
///
/// DEEPCHECK-01 P0：读回前同样按「锚点 + token 预算」截断（与 store 写入
/// 语义对齐的防御性一致性；正常路径 store 已截断，此处幂等）。
fn cached_history_to_conversation(entries: Vec<HistoryMessage>) -> Vec<Arc<AgentMessage>> {
    let mut entries = entries;
    truncate_history_with_anchor(&mut entries, SESSION_HISTORY_TOKEN_BUDGET);
    entries
        .iter()
        .filter_map(|entry| {
            let role = match entry.sender.as_str() {
                "user" => AgentMessageRole::User,
                "assistant" => AgentMessageRole::Assistant,
                "tool" => AgentMessageRole::Tool,
                "system" => AgentMessageRole::System,
                _ => return None,
            };
            let blocks = parse_blocks(entry).unwrap_or_default();
            if blocks.is_empty() {
                return None;
            }
            Some(Arc::new(AgentMessage {
                id: entry.id.clone(),
                role,
                created_at: epoch_millis_to_iso8601(entry.timestamp),
                blocks,
                // metadata 裁剪（usage 等运行期数据不进 LLM 上下文，双保险）
                metadata: None,
                client_message_id: Some(entry.id.clone()),
                content: None,
            }))
        })
        .collect()
}

/// 历史装配源（P4 §3.2.3 混合路线：前端水合兜底 + 引擎侧缓存主）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistorySource {
    /// 前端 store 已完成消息（冷启动/重启后的第一个 run）
    Frontend,
    /// 引擎侧 SessionHistoryCache（运行期连续 run 的权威增量）
    Cache,
}

/// 历史源判定：前端 history 非空 → Frontend；为空/未传但缓存有值 →
/// Cache；两者皆无 → None（现状单消息 run，向后兼容）。
fn resolve_history_source(
    history: &Option<Vec<HistoryMessage>>,
    cached: Option<Vec<HistoryMessage>>,
) -> Option<(HistorySource, Vec<HistoryMessage>)> {
    match history {
        Some(h) if !h.is_empty() => Some((HistorySource::Frontend, h.clone())),
        _ => cached.map(|messages| (HistorySource::Cache, messages)),
    }
}

/// context_window 入站 → ContextBudget（P4 §3.3.2：reserve/safety 取
/// 默认 16384/4096；T-33 在 SessionLoopOptions.context_budget 消费钳制）
fn assemble_context_budget(context_window: u32) -> ContextBudget {
    ContextBudget {
        context_window,
        ..ContextBudget::default()
    }
}

/// DEEPCHECK-06 P0（子代理预算接线）：run 装配时的预算入站解析——
/// 显式 context_window（前端/调用方下发）优先；子代理 run（spawner 路径
/// 前端参数不可达，RunTaskOptions.context_window 恒 None）按生效模型
/// catalog 窗口兜底（[crate::engine::effective_context_window]，与主会话
/// 前端 resolveContextWindow 的 catalog 兜底同源）；目录缺失 → None =
/// 不钳制（与主会话 catalog 兜底失败行为一致）。两者皆缺 → None
/// （向后兼容现状，普通 run 无窗口不钳制）。
fn resolve_context_budget(
    context_window: Option<u32>,
    subagent_config: &Option<crate::subagent_spawner::SubagentRunConfig>,
    engine: &EngineHandle,
) -> Option<ContextBudget> {
    match context_window {
        Some(window) => Some(assemble_context_budget(window)),
        None if subagent_config.is_some() => engine
            .provider_config()
            .and_then(|config| crate::engine::effective_context_window(&config))
            .map(assemble_context_budget),
        None => None,
    }
}

// ── COMPACTION-01 P0-1：压缩策略装配（session_meta 键面）────────────

/// session_meta 键（预留）：保留最近 token 预算覆盖
/// （conex-compaction 缺省 [conex_compaction::KEEP_RECENT_TOKENS_DEFAULT]）
const META_KEY_COMPACT_KEEP_RECENT_TOKENS: &str = "compact_keep_recent_tokens";
/// session_meta 键（预留）：保留最近完整回合数下限覆盖
/// （conex-compaction 缺省 [conex_compaction::MIN_RECENT_TURNS_DEFAULT]）
const META_KEY_COMPACT_MIN_RECENT_TURNS: &str = "compact_min_recent_turns";

/// session_meta 键 → [conex_compaction::compaction::CompactionPolicy]
/// （COMPACTION-01 P0-1 装配 helper：缺省 = 常量默认；键缺失 / 坏值回退
/// 默认 + warn，不 panic）。
///
/// `meta`：键 → 值读取面（生产经 `LocalDb::get_session_meta` 注入；
/// 测试注入内存表）。
fn compaction_policy_from_session_meta(
    meta: impl Fn(&str) -> Option<String>,
) -> conex_compaction::compaction::CompactionPolicy {
    let mut policy = conex_compaction::compaction::CompactionPolicy::default();
    if let Some(raw) = meta(conex_compaction::SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS) {
        match raw.trim().parse::<usize>() {
            Ok(value) if value > 0 => policy.max_summary_tokens = value,
            _ => tracing::warn!(
                key = conex_compaction::SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS,
                raw = %raw,
                default = conex_compaction::MAX_SUMMARY_TOKENS_DEFAULT,
                "压缩策略键值非法 → 回退缺省 max_summary_tokens"
            ),
        }
    }
    if let Some(raw) = meta(META_KEY_COMPACT_KEEP_RECENT_TOKENS) {
        match raw.trim().parse::<usize>() {
            Ok(value) if value > 0 => policy.keep_recent_tokens = value,
            _ => tracing::warn!(
                key = META_KEY_COMPACT_KEEP_RECENT_TOKENS,
                raw = %raw,
                default = conex_compaction::KEEP_RECENT_TOKENS_DEFAULT,
                "压缩策略键值非法 → 回退缺省 keep_recent_tokens"
            ),
        }
    }
    if let Some(raw) = meta(META_KEY_COMPACT_MIN_RECENT_TURNS) {
        match raw.trim().parse::<u32>() {
            Ok(value) if value > 0 => policy.min_recent_turns = value,
            _ => tracing::warn!(
                key = META_KEY_COMPACT_MIN_RECENT_TURNS,
                raw = %raw,
                default = conex_compaction::MIN_RECENT_TURNS_DEFAULT,
                "压缩策略键值非法 → 回退缺省 min_recent_turns"
            ),
        }
    }
    policy
}

// ── T-AB-19：run 感知后台任务管理器（owner_run_id 注入装饰器）────

/// run 感知后台任务管理器（T-AB-19 装饰器，包壳 [BackgroundTaskManager]）
///
/// 职责（方案 §7.4 T-AB-19 第 1/3 点）：
/// - **owner_run_id 注入**：工具执行链的 adopt 调用点（agent-tools
///   shell.rs:1088）构造请求时 `owner_run_id` 恒 None——本装饰器在请求
///   进入注册表前注入「当前 run 上下文」的 runId（审计与过滤用，不级联
///   杀）；请求已显式携带（非 None）时透传不改写；
/// - **L3 可选联动**：`graceful_stop_tasks_for_run`——对指定 run 的普通
///   任务（is_daemon=false）发起优雅终止（两阶段 kill）；默认不联动，
///   仅 `core_run_control` L3 force 且配置项开启时调用；
/// - **状态汇总查询面**：`summary`——core_get_status.backgroundTasks 数据源。
///
/// 上下文约定：run 开始（[core_run_task]）→ `set_current_run(run_id)`；
/// run 终态（[drive_run_loop] 收口 / [finalize_failed]）→
/// `clear_current_run(run_id)`（仅清匹配者）。**不清理注册表、不级联杀
/// 任务**——任务属会话级，registry 生命周期独立于 run（T-AB-12 只读
/// 契约升级为显式收口契约，run_end_* 测试锚定）。
///
/// 诚实边界：引擎与注册表均为进程内单例，装饰器维护「最近启动的 run」
/// 单一上下文槽；多会话并发 run 时以最近启动者为准（owner_run_id 是
/// 审计元数据粒度，不参与生命周期决策，误差不产生行为差异）。
#[derive(Debug)]
pub(crate) struct RunAwareBackgroundManager {
    /// 被包壳的注册表（None = 未接线，测试环境；adopt/list 等返回
    /// 工具未接线错误，生产路径恒 Some）
    inner: Option<Arc<dyn BackgroundTaskManager>>,
    /// 当前 run 上下文（owner_run_id 注入槽；std Mutex 不跨 await 持有）
    current_run_id: Mutex<Option<String>>,
}

impl RunAwareBackgroundManager {
    /// 新建装饰器（包壳 main.rs 注入的注册表）
    pub(crate) fn new(inner: Option<Arc<dyn BackgroundTaskManager>>) -> Self {
        Self {
            inner,
            current_run_id: Mutex::new(None),
        }
    }

    /// run 启动：登记当前 run 上下文（[core_run_task] spawn 前调用）
    pub(crate) fn set_current_run(&self, run_id: &str) {
        *self
            .current_run_id
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(run_id.to_string());
    }

    /// run 终态：释放当前 run 上下文（仅清匹配者——多会话并发 run 时
    /// 较晚启动者占槽，较早结束者不清，避免误伤仍在运行的 run）
    pub(crate) fn clear_current_run(&self, run_id: &str) {
        let mut slot = self
            .current_run_id
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if slot.as_deref() == Some(run_id) {
            *slot = None;
        }
    }

    /// 后台任务汇总（core_get_status.backgroundTasks 数据源）
    ///
    /// 口径说明（与前端状态栏 / 诊断面板展示对齐）：
    /// - `active_count`：活跃（Running）任务数——不含终态与已归档条目；
    /// - `daemon_count`：活跃守护进程数（is_daemon=true 且 Running）——
    ///   与 activeCount 同口径（「守护进程仍在运行」语义）；
    /// - `last_finished`：最近终态（全量口径取 finished_at_ms 最大；
    ///   尚无终态任务时 None）。
    ///
    /// 未接线（注册表缺失）或查询失败 → 全零缺省（展示型数据，前端
    /// 显示「无任务」而非报错）。
    pub(crate) async fn summary(&self) -> BackgroundTasksSummary {
        let Some(manager) = &self.inner else {
            return BackgroundTasksSummary::default();
        };
        match manager.list(true).await {
            Ok(tasks) => {
                let mut last_finished: Option<(u64, String, String)> = None;
                for info in &tasks {
                    if info.status == TaskState::Running {
                        continue;
                    }
                    if let Some(finished_at) = info.finished_at_ms {
                        if last_finished
                            .as_ref()
                            .is_none_or(|(max_at, _, _)| finished_at > *max_at)
                        {
                            last_finished = Some((
                                finished_at,
                                info.task_id.clone(),
                                task_state_wire_name(info.status).to_string(),
                            ));
                        }
                    }
                }
                BackgroundTasksSummary {
                    active_count: tasks
                        .iter()
                        .filter(|info| info.status == TaskState::Running)
                        .count(),
                    daemon_count: tasks
                        .iter()
                        .filter(|info| info.is_daemon && info.status == TaskState::Running)
                        .count(),
                    last_finished: last_finished.map(|(finished_at, task_id, status)| {
                        crate::core_query_commands::LastTaskTerminal {
                            task_id,
                            status,
                            finished_at_ms: finished_at as i64,
                        }
                    }),
                }
            }
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    error = %error,
                    "后台任务汇总查询失败（返回全零缺省）"
                );
                BackgroundTasksSummary::default()
            }
        }
    }

    /// T-AB-19 可选接线：对指定 run 的普通任务（is_daemon=false）发起
    /// 优雅终止（注册表两阶段 kill：优雅 → 5s → 强制）。
    ///
    /// 默认不联动：仅 `core_run_control` L3 force 且配置项
    /// `CONEX_RUN_CONTROL_L3_TASK_CANCEL` 开启时调用（职责单一，避免
    /// 误杀，对齐方案 REQ 4.3）。守护任务（is_daemon=true）与其它 run
    /// 的任务一律不碰。best-effort：单任务失败仅告警，不中断整批。
    pub(crate) async fn graceful_stop_tasks_for_run(&self, run_id: &str) {
        let Some(manager) = &self.inner else {
            return;
        };
        let tasks = match manager.list(false).await {
            Ok(tasks) => tasks,
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    run_id,
                    error = %error,
                    "L3 联动：任务查询失败（跳过联动，run 强停不受影响）"
                );
                return;
            }
        };
        for info in tasks
            .iter()
            .filter(|info| info.owner_run_id.as_deref() == Some(run_id) && !info.is_daemon)
        {
            match manager.kill(&info.task_id).await {
                Ok(result) => {
                    tracing::info!(
                        target: "run",
                        run_id,
                        task_id = %info.task_id,
                        kill = ?result,
                        "L3 联动：当前 run 的普通任务已发起优雅终止"
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        target: "run",
                        run_id,
                        task_id = %info.task_id,
                        error = %error,
                        "L3 联动：任务终止失败（best-effort 继续）"
                    );
                }
            }
        }
    }
}

/// T-AB-19 配置项（默认关闭）：L3 force 取消时是否对「当前 run 的普通
/// 任务（is_daemon=false）」发起优雅终止（两阶段 kill）。
///
/// 配置面现状：通用设置存储（config store）尚无布尔项，暂以环境变量
/// `CONEX_RUN_CONTROL_L3_TASK_CANCEL=1` 开启（进程级配置项，登记于
/// T-AB-19 交付说明；接入设置面板后改读设置项，默认值保持 false）。
fn l3_force_cancel_tasks_enabled() -> bool {
    matches!(
        std::env::var("CONEX_RUN_CONTROL_L3_TASK_CANCEL").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

/// 任务状态 wire 名（TaskState kebab-case 序列化名；汇总面用）
fn task_state_wire_name(state: TaskState) -> &'static str {
    match state {
        TaskState::Running => "running",
        TaskState::Completed => "completed",
        TaskState::Failed => "failed",
        TaskState::Killed => "killed",
    }
}

#[async_trait::async_trait]
impl BackgroundTaskManager for RunAwareBackgroundManager {
    /// adopt：注入 owner_run_id（工具链恒 None → 当前 run 上下文；
    /// 显式携带时透传不改写），其余原样转发注册表。
    async fn adopt(&self, mut req: BackgroundAdoptRequest) -> Result<BackgroundTaskRef, ToolError> {
        if req.owner_run_id.is_none() {
            req.owner_run_id = self
                .current_run_id
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
        }
        match &self.inner {
            Some(manager) => manager.adopt(req).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn list(&self, include_finished: bool) -> Result<Vec<BackgroundTaskInfo>, ToolError> {
        match &self.inner {
            Some(manager) => manager.list(include_finished).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn status(&self, task_id: &str) -> Result<agent_tools::background::BackgroundTaskStatus, ToolError> {
        match &self.inner {
            Some(manager) => manager.status(task_id).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn read_log(
        &self,
        task_id: &str,
        start_line: Option<u64>,
        max_lines: u64,
    ) -> Result<agent_tools::background::LogSlice, ToolError> {
        match &self.inner {
            Some(manager) => manager.read_log(task_id, start_line, max_lines).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn send_input(
        &self,
        task_id: &str,
        text: &str,
        append_newline: bool,
    ) -> Result<(), ToolError> {
        match &self.inner {
            Some(manager) => manager.send_input(task_id, text, append_newline).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn kill(&self, task_id: &str) -> Result<agent_tools::background::KillResult, ToolError> {
        match &self.inner {
            Some(manager) => manager.kill(task_id).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }
}

// ── CoreRunState ──────────────────────────────────────────────────

/// 核心运行状态（B6.4：进程内核心的共享状态）
///
/// main.rs 接线（集成 agent）：`app.manage(Arc::new(CoreRunState::new(...)))`；
/// restore 在 manage 之前经 `run_in_runtime` 执行 [Self::run_restore]（T08.6）。
pub struct CoreRunState {
    /// 事件存储连接（run 记录 + 事件流 + pending 输入）
    store: Arc<dyn Store>,
    /// run 管理器（注册 + 生命周期）
    run_manager: RunManager,
    /// 引擎句柄（provider 配置 + 工具注册表 + engineReady；Arc 包装——
    /// 生产 Summarizer 工厂闭包需 'static 捕获以按会话读取当前生效配置）
    engine: Arc<EngineHandle>,
    /// 全局事件桥（Tauri 通道；每 run 经 BufferedRunEventBridge 组装缓冲）
    bridge: EventBridge,
    /// 活动 run 注册表（终态移出；会话内串行守卫依据）
    active_runs: Mutex<HashMap<String, Arc<ActiveRun>>>,
    /// 状态诊断（环形 20 条 + lastError AtomicSlot，PE-04 T04.5）
    diagnostics: Arc<StatusDiagnostics>,
    /// T08.8：会话级序列号预热缓存（base_sequence_for；恢复后 seed）
    next_sequences: Mutex<HashMap<String, u64>>,
    /// T08.6 门禁：restore 完成标记（完成前 run_task 拒绝新 run，Q24 竞态）
    restore_ready: AtomicBool,
    /// 快照存储（主文件 + .prev 备份，双文件模型）
    snapshots: Arc<dyn SnapshotStore>,
    /// 快照周期（ms；session_meta `snapshot_interval_ms` 可配，默认 60s）
    snapshot_interval_ms: Mutex<u64>,
    /// 最近一次快照代数（恢复成功后的首次保存以 generation+1 续接）
    snapshot_generation: AtomicU64,
    /// T3.5 D5（F2-11 / R2 §4 修复建议 1）：快照保存互斥锁——三触发
    /// （终态 [Self::save_snapshot_now] 调用点 / 周期 [Self::spawn_snapshot_loop]
    /// / 退出 [Self::save_snapshot_blocking]）共用 [Self::save_snapshot_now]
    /// 入口，锁内完成「generation 读-改-写 + build + 落盘 + 状态回写」全
    /// 链路。根因：无锁时两路并发保存同读 G 同写 G+1（丢失更新），且轮转
    /// remove/rename 交叉（实测并发双线程下主/备份同代数 + snapshot_rename
    /// 错误）。锁为 tokio::sync::Mutex：跨 runtime 可用（退出钩子经
    /// `tauri::async_runtime::block_on` 从独立 std::thread 汇入同一锁面），
    /// 无嵌套锁面（唯一持有点），死锁风险低（AU-03 选型确认）。
    snapshot_mutex: tokio::sync::Mutex<()>,
    /// 快照保存失败显式标记（P16：core_get_status.snapshot.lastError 数据源）
    snapshot_last_error: Mutex<Option<String>>,
    /// 会话树注册表（T08.6 第 4 点；goal 模式未激活时为空数组，快照结构不变）
    sessions: Mutex<Vec<SessionRecord>>,
    /// 周期快照任务运行标记（幂等防重复启动）
    snapshot_loop_running: AtomicBool,
    /// setup 完成标记（PE-01 T01.2：main.rs setup 末尾置 true；
    /// core_get_status.initialized 数据源）
    initialized: AtomicBool,
    /// restore 是否已开始（restore.state = pending 数据源）
    restore_started: AtomicBool,
    /// restore 是否失败（restore.state = failed 数据源；失败不阻塞启动）
    restore_failed: AtomicBool,
    /// 恢复模式字面量（full-replay / snapshot-incremental；restore.mode 数据源）
    restore_mode: Mutex<Option<String>>,
    /// 快照回退说明（restore.snapshotNote 数据源；None = 未回退/无说明）
    restore_note: Mutex<Option<String>>,
    /// 本次恢复打断的 run 数（restore.interruptedCount 数据源）
    interrupted_count: Mutex<usize>,
    /// 事件流锚点（restore.lastSequence 数据源；无事件时 None）
    restore_last_sequence: Mutex<Option<u64>>,
    /// 最近一次快照写入时间（epoch ms；snapshot.writtenAt 数据源）
    snapshot_written_at: Mutex<Option<i64>>,
    /// T-29：per-session 历史缓存（P4 阶段 1-3/1-4；运行期内存态，
    /// 不落库——前端 history 为空时回退，混合路线"引擎侧缓存主"）
    session_history: SessionHistoryCache,
    /// T-AB-19：run 感知后台任务管理器（包壳 main.rs 注入的注册表——
    /// 工具链 adopt 的 owner_run_id 注入槽 + L3 可选联动 + 状态汇总
    /// 查询面；引擎侧注入同一包装实例，工具执行链 adopt 走装饰器）
    background: Arc<RunAwareBackgroundManager>,
    /// T-CF-11：跨 run steering 队列（PendingMessageQueue——定时器到期 /
    /// Cron 触发 / 子代理完成 / watchdog 兜底通知的落点；与
    /// [EngineHandle::timer_steering_queue] 同一实例，收口处非空判定 +
    /// 批量转出注入续 run）
    pending_queue: Arc<Mutex<PendingMessageQueue>>,
    /// 30 方案 P3：任务事件消费器（task_events.rs 消费面接线——与
    /// [Self::pending_queue] 同实例、bridge 直发 security-audit（域隔离
    /// 不经 engine audit_sink）；main.rs 装配轮经
    /// [Self::task_events] 注入 background 注册表）
    task_events: Arc<TaskEventConsumer>,
    /// T-CF-11：定时器活跃判定器（TimerRegistry 非空封装；None = 未接线
    /// ——收口时不因定时器续 run。生产在 [Self::new] 经
    /// [EngineHandle::timer_registry] 的 list_active 封装注入；测试可替换）
    timer_has_active: Mutex<Option<WakeSourceCheck>>,
    /// T-CF-11：enabled Cron 判定器（SchedulerRegistry 非空封装；None =
    /// 未接线——Cron 不参与续 run 判定，行为与接线前一致。30 方案 P7：
    /// 生产在 [Self::new] 内直接装配（engine.scheduler_registry() 非空
    /// 封装 has_active，对齐 timer_has_active 先例）；setter 保留测试
    /// 替换槽）
    cron_has_enabled: Mutex<Option<WakeSourceCheck>>,
    /// T-CF-11：idle 续 run 空转护栏计数（session_id → 连续无 AI 产出
    /// 的续 run 轮数；有产出清零，超 [IDLE_RESUME_MAX_EMPTY_ROUNDS] 停止）
    resume_empty_streak: Mutex<HashMap<String, u32>>,
    /// T-CF-11：idle 续 run 拉起器（生产 = [production_resume_launcher]
    /// 预装配——经 run_task_impl 复用装配拉起新 run；测试经
    /// set_resume_launcher 注入替身断言判定与注入载荷）
    resume_launcher: Mutex<Option<ResumeLauncher>>,
    /// D2 §3.4（C4 锁死）：跨 run 续 run 退避延迟注入点——测试直接驱动
    /// （不依赖 tokio pause）；None = 生产镜像 recovery.rs 常量
    /// （750→1500→3000，8s 封顶）。注入存在时 [Self::sleep_resume_backoff]
    /// 跳过真实睡眠（测试驱动模式）。
    resume_backoff: Mutex<Option<BackoffDelayFn>>,
    /// 子代理生产 spawner（T-D-13：SubagentSpawner 契约引擎侧实现；
    /// 同一实例经 EngineHandle 注入 run_subagent 工具 + 本状态持有——
    /// 注入面（launcher / db / wait 广播 / steering 队列）经
    /// [Self::finalize_subagent_spawner] 装配）
    subagent_spawner: Arc<crate::subagent_spawner::SubagentSpawnerImpl>,
    /// D3 §3.1：每会话恢复协调器（C7 权威实例；五件套装配，惰性构造——
    /// [Self::coordinator_for]；restore 后经 [Self::run_restore] 触发
    /// 构造并自动从 session_meta 恢复预算/通知/forks/needs_user）
    recovery_coordinators: Mutex<HashMap<String, Arc<Mutex<RecoveryCoordinator>>>>,
    /// D3 §3.1/§3.3：每会话会话树（restore 后 from_session_record 重建；
    /// 阶梯 3 fork 的源叶子载体；coordinator 惰性构造时缺省空树）
    session_trees: Mutex<HashMap<String, Arc<Mutex<SessionTree>>>>,
    /// D3 §3.5：跨 run 阶梯 1 重试计数（(session_id, fingerprint) → 已
    /// 重派次数；进程内记账——重启清零是阶梯 1 既有语义，不持久化）
    ladder1_retries: Mutex<HashMap<(String, String), u32>>,
    /// D6 §4.2：会话级用户停止标记（会话 → 停止时刻；用户 L2/L3 停止
    /// 写入、用户新 run 装配清除——「用户显式停止永不自动续」跨 run
    /// 语义；watcher 判定与 decide_idle_resume 共享；**不落库**——重启
    /// 后用户停止历史天然消失，watcher 恢复自动行为，重启本身不是
    /// 用户停止）
    user_stopped: Mutex<HashMap<String, u64>>,
    /// D6 §3.2：每会话唤醒 watcher 幂等持有表（会话 → watcher 实例；
    /// run_task_impl 会话首次出现 / run_restore 成功后惰性 spawn；run
    /// 收口**不销毁**——否则 AI 休眠后 watcher 也跟着没了，回到断点 2；
    /// 进程退出随 runtime 销毁，测试面经句柄 stop）
    wake_watchers: Mutex<HashMap<String, Arc<crate::wake_watcher::WakeWatcher>>>,
    /// T-42：会话级摘要协调器注册表（00-plan §6.5 R-I / 评审 02 P0-2）——
    /// 与 [Self::session_history] 同生命周期（进程级单例）：摘要任务状态
    /// （JoinHandle/退避/attempts/last_outcome）挂会话级容器，run 收口不
    /// 摧毁任务，跨 run 单飞成立；完成回调经默认回调落 compression_blocks
    /// 表（两阶段写协议阶段二，orchestrator::blocks 面）。
    summary_coordinators: Arc<session_loop::SessionSummaryCoordinatorRegistry>,
    /// T-43：会话级 Summarizer 工厂（壳层注入通道；None = 无注入——不
    /// spawn 后台摘要任务，纯 stub awaiting 永驻）。生产经
    /// [Self::set_summarizer_factory] 由 session.start / 配置加载注入；
    /// 真实 provider 调用实现属产品功能（通道本轮打通，实现挂 V2/产品面）。
    summarizer_factory: Mutex<Option<crate::engine::SummarizerFactory>>,
}

impl CoreRunState {
    /// 新建核心运行状态（store / snapshots / bridge / diagnostics 由 main.rs
    /// 接线传入；diagnostics 与 `core_get_status` 的 `State<StatusDiagnostics>`
    /// 共享同一实例，避免「写入侧与读取侧实例漂移」）
    pub fn new(
        store: Arc<dyn Store>,
        snapshots: Arc<dyn SnapshotStore>,
        bridge: EventBridge,
        diagnostics: Arc<StatusDiagnostics>,
        background_manager: Option<Arc<dyn agent_tools::background::BackgroundTaskManager>>,
    ) -> Self {
        // T-AB-19：注册表包壳为 run 感知装饰器（owner_run_id 注入 + L3
        // 可选联动 + 汇总查询面）；引擎与状态共享同一包装实例——工具执行
        // 链 adopt（agent-tools shell.rs）经引擎注入的 trait 引用走到装饰器。
        let background = Arc::new(RunAwareBackgroundManager::new(background_manager));
        // T-D-13：子代理生产 spawner 实例（注入槽为空；launcher / db /
        // wait 广播 / steering 队列经 [Self::finalize_subagent_spawner]
        // 装配——Arc 构造完成后注入，防构造期循环引用）
        let subagent_spawner = Arc::new(crate::subagent_spawner::SubagentSpawnerImpl::new());
        // T-CF-11：idle 待命唤醒源接线——跨 run steering 队列与定时器
        // 活跃判定经 EngineHandle 访问器取得（engine.rs:775-783，R-CF3
        // 装配收口预留）；SchedulerRegistry enabled 判定在下方经
        // engine.scheduler_registry() 直接装配（30 方案 P7）。
        let engine = Arc::new(EngineHandle::new_with_spawner(
            // 引擎侧注入包装实例（保持 Option 语义：未接线 = 引擎无
            // 后台任务通道，与接线前行为一致）
            background
                .inner
                .is_some()
                .then(|| Arc::clone(&background) as Arc<dyn BackgroundTaskManager>),
            // T-D-13：spawn 通道注入（run_subagent 工具接线；None =
            // run_subagent 返回 common.unsupported 降级）
            Some(Arc::clone(&subagent_spawner)
                as Arc<dyn agent_tools::tools::subagent::SubagentSpawner>),
            // D6 §3.1 段 2 + D4 §3.8 ②（W4 统一签名）：store 下转
            // LocalDb 连接注入——Some → timer/sched/wait 三 store 真适配
            // （重启恢复数据面）；None（InMemoryStore 测试替身）→ 内存版
            store.as_local_db(),
        ));
        // COMPACTION-01 P0-3（生产闭环）：真实 LLM 摘要器工厂装配——会话级
        // SummarizerFactory = production_summarizer_factory（返回
        // ProviderSummarizer：经 chat-completions 通道 + 当前 provider
        // 配置；provider 未就绪 → None → 纯 stub awaiting 语义保持）。
        // 工厂每次解析读取引擎当前生效配置——config_profile_apply 热更新后
        // 下一次 run 立即生效。T-43 通道生产注入点（session.start /
        // 配置加载 = CoreRunState::new，与 SessionHistoryCache 同生命周期）。
        let summarizer_factory =
            Some(crate::engine::production_summarizer_factory(Arc::clone(&engine)));
        let pending_queue = engine.timer_steering_queue();
        // 30 方案 P3：任务事件消费器（与 pending_queue 同实例；bridge 为
        // 本状态持有实例的克隆——security-audit 直发不经 engine audit_sink，
        // 30 文档 §9 域隔离接口约定）
        let task_events = Arc::new(TaskEventConsumer::new(
            Arc::clone(&pending_queue),
            bridge.clone(),
            String::new(), // 空串占位（任务为会话级存活，归属经 payload ownerRunId）
        ));
        let timer_registry = engine.timer_registry();
        let timer_has_active: WakeSourceCheck = Arc::new(move || {
            let registry = Arc::clone(&timer_registry);
            Box::pin(async move { !registry.list_active().await.is_empty() })
        });
        // 30 方案 P7：enabled Cron 判定器装配（对齐 timer_has_active 先例
        // ——SchedulerRegistry 非空封装：表内条目即活跃（停止/取消时已
        // 移除，sched.rs has_active 语义自洽）。None = 装配降级（引擎
        // scheduler_registry 为 None），Cron 不参与续 run 判定，行为与
        // 接线前一致（main.rs 装配轮已加 warn 提示——D-29 精神）。
        let scheduler_registry = engine.scheduler_registry();
        let cron_has_enabled: Option<WakeSourceCheck> = scheduler_registry.map(|reg| {
            let reg = Arc::clone(&reg);
            let check: WakeSourceCheck = Arc::new(move || {
                let reg = Arc::clone(&reg);
                Box::pin(async move { reg.has_active() })
            });
            check
        });
        // T-CF-11：生产续 run 拉起器预装配（trait object 叶子类型——
        // drive_run_loop 经 trait object 调用，不直接包含 run_task_impl
        // 的 opaque future，避免 auto-trait 检查递归限制；测试经
        // set_resume_launcher 覆盖替身）
        let resume_launcher = production_resume_launcher();
        // T-42：会话级摘要协调器注册表（与 session_history 同生命周期）——
        // 默认完成回调 = 落 compression_blocks 表（两阶段写协议阶段二：
        // 调度器成功后推进 summary_json/state/attempts；orchestrator
        // 同步面，回调为 FnOnce 语义直接调用；失败仅告警不阻断——块表
        // 是索引面，原文仍在事件流可回放）
        let persist_store = Arc::clone(&store);
        let summary_coordinators = Arc::new(session_loop::SessionSummaryCoordinatorRegistry::new(
            Some(Arc::new(move |outcome: session_loop::SummaryDispatchOutcome| {
                let outcome_state = match outcome.state.as_str() {
                    "committed" => conex_db::BlockState::Committed,
                    "retired" => conex_db::BlockState::Retired,
                    _ => conex_db::BlockState::Awaiting,
                };
                if let Err(error) = orchestrator::blocks::update_compression_block_summary(
                    persist_store.as_ref(),
                    &outcome.session_id,
                    &outcome.block_id,
                    outcome_state,
                    outcome.summary_json.as_deref(),
                    outcome.attempts,
                ) {
                    tracing::warn!(
                        target: "run",
                        session_id = %outcome.session_id,
                        block_id = %outcome.block_id,
                        error = %error,
                        "摘要任务完成回调落库失败（块表是索引面，原文在事件流可回放）"
                    );
                }
            }) as Arc<dyn Fn(session_loop::SummaryDispatchOutcome) + Send + Sync>),
        ));
        Self {
            store: Arc::clone(&store),
            run_manager: RunManager::new(store),
            engine,
            bridge,
            active_runs: Mutex::new(HashMap::new()),
            diagnostics,
            next_sequences: Mutex::new(HashMap::new()),
            restore_ready: AtomicBool::new(false),
            snapshots,
            snapshot_interval_ms: Mutex::new(DEFAULT_SNAPSHOT_INTERVAL_MS),
            snapshot_generation: AtomicU64::new(0),
            snapshot_mutex: tokio::sync::Mutex::new(()),
            snapshot_last_error: Mutex::new(None),
            sessions: Mutex::new(Vec::new()),
            snapshot_loop_running: AtomicBool::new(false),
            initialized: AtomicBool::new(false),
            restore_started: AtomicBool::new(false),
            restore_failed: AtomicBool::new(false),
            restore_mode: Mutex::new(None),
            restore_note: Mutex::new(None),
            interrupted_count: Mutex::new(0),
            restore_last_sequence: Mutex::new(None),
            snapshot_written_at: Mutex::new(None),
            session_history: SessionHistoryCache::new(),
            background,
            pending_queue,
            task_events,
            timer_has_active: Mutex::new(Some(timer_has_active)),
            cron_has_enabled: Mutex::new(cron_has_enabled),
            resume_empty_streak: Mutex::new(HashMap::new()),
            resume_launcher: Mutex::new(Some(resume_launcher)),
            resume_backoff: Mutex::new(None),
            subagent_spawner,
            recovery_coordinators: Mutex::new(HashMap::new()),
            session_trees: Mutex::new(HashMap::new()),
            ladder1_retries: Mutex::new(HashMap::new()),
            user_stopped: Mutex::new(HashMap::new()),
            wake_watchers: Mutex::new(HashMap::new()),
            summary_coordinators,
            summarizer_factory: Mutex::new(summarizer_factory),
        }
    }

    /// setup 完成标记（PE-01 T01.2：setup 失败 = false，不假装成功）
    pub fn initialized(&self) -> bool {
        self.initialized.load(Ordering::SeqCst)
    }

    /// 标记 setup 完成（main.rs setup 末尾调用）
    pub fn mark_initialized(&self) {
        self.initialized.store(true, Ordering::SeqCst);
    }

    /// 引擎（session-loop）就绪（provider 配置三件套齐备）
    pub fn engine_ready(&self) -> bool {
        self.engine.ready()
    }

    /// 重载引擎 provider 适配层（PS-04 T4.3 / F4 F1-01 接线：config 命令
    /// 写 store 成功后调用——重建 `HttpProviderCall`（新 key/baseUrl/model
    /// 快照）并原子交换，下一次 run 用新凭据）。
    pub(crate) fn reload_provider(&self) {
        self.engine.reload_provider();
    }

    /// restore 域状态（core_get_status.restore 数据源；F2 冻结形状）
    pub fn restore_status(&self) -> RestoreStatus {
        let state = if !self.restore_started.load(Ordering::SeqCst) {
            "pending"
        } else if self.restore_failed.load(Ordering::SeqCst) {
            "failed"
        } else {
            "done"
        };
        let mode = self
            .restore_mode
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
            .unwrap_or_default();
        let snapshot_note = self
            .restore_note
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let interrupted_count = self
            .interrupted_count
            .lock()
            .map(|guard| *guard)
            .unwrap_or_default();
        let last_sequence = self
            .restore_last_sequence
            .lock()
            .map(|guard| *guard)
            .unwrap_or_default();
        RestoreStatus {
            state,
            mode,
            snapshot_note,
            interrupted_count,
            last_sequence,
        }
    }

    /// 快照域状态（core_get_status.snapshot 数据源；F2 冻结形状）
    pub fn snapshot_status(&self) -> SnapshotStatus {
        let written_at = self
            .snapshot_written_at
            .lock()
            .map(|guard| *guard)
            .unwrap_or_default();
        SnapshotStatus {
            generation: self.snapshot_generation(),
            written_at,
            last_error: self.snapshot_last_error(),
        }
    }

    /// run 终态错误文案（无则 None；当前未接线，终态错误由
    /// core_get_run_snapshot.endReason 承载）
    pub fn run_error(&self, _run_id: &str) -> Option<String> {
        None
    }

    /// run usage 域（T-40 真实实现，R5-D3 轮末合并接线）
    ///
    /// 数据源 = runs 表 v5 列（T-39 `get_run_usage`，drive_run_loop 收口
    /// `save_run_usage` 写入）；经 [Self::local_db] 下转型取底层连接。
    /// 无 LocalDb（InMemoryStore 等测试替身）/ 无样本（sample_count == 0，
    /// 含 v4 迁移旧行）/ 读失败 → None——前端回退估算（contract 注释约定：
    /// usage 域未接线时 None）。
    pub fn run_usage(&self, run_id: &str) -> Option<RunUsage> {
        let db = self.local_db()?;
        let stats = match db.get_run_usage(run_id) {
            Ok(Some(stats)) => stats,
            Ok(None) => return None,
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    run_id,
                    error = %error,
                    "get_run_usage 读失败（usage 查询回退前端估算）"
                );
                return None;
            }
        };
        RunUsage::from_run_cache_stats(stats)
    }

    /// T-40（R5-D3 轮末合并接线 ④）：store 下转型取 [LocalDb]——run
    /// usage 数据面（get_run_usage / save_run_usage，runs 表 v5 列）经
    /// 此访问。
    ///
    /// 实现说明：生产路径 store 恒为 [orchestrator::persist::LocalDbStore]
    /// （main.rs 接线），经 [orchestrator::persist::Store::as_local_db] 返回
    /// 连接克隆（Arc +1）；非 LocalDb 实现（InMemoryStore 测试替身）保持
    /// 默认 None——usage 查询回退前端估算，不阻塞其他功能。
    pub fn local_db(&self) -> Option<LocalDb> {
        self.store.as_local_db()
    }

    /// 引擎句柄（27 方案 S5/S6 装配面访问器：run 装配块取浏览器会话槽
    /// 挂 abort 桥，browser_commands 命令面取同一进程级单例）
    pub(crate) fn engine(&self) -> Arc<EngineHandle> {
        Arc::clone(&self.engine)
    }

    /// T-43：注入会话级 Summarizer 工厂（壳层注入通道；None = 无注入——
    /// 不 spawn 后台摘要任务，纯 stub awaiting 永驻，与接线前行为一致）。
    /// **生产装配点已闭环（COMPACTION-01 P0-3）**：[Self::new] 直接装配
    /// [crate::engine::production_summarizer_factory]（真实 LLM 实现
    /// ProviderSummarizer，经 chat-completions 通道）；本 setter 保留为
    /// 测试替换槽 / 显式降级面。
    #[cfg_attr(not(test), allow(dead_code))] // 生产在 new() 内直接装配；测试替换槽
    pub(crate) fn set_summarizer_factory(&self, factory: Option<crate::engine::SummarizerFactory>) {
        *self
            .summarizer_factory
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = factory;
    }

    /// T-43：按会话解析 Summarizer（工厂注入面；无工厂 / 工厂返回 None →
    /// None——不 spawn）。per-session 实例边界（04 §7.1 隔离决议：
    /// 每会话独立 Summarizer 实例，共享 provider 客户端但无共享可变状态）。
    pub(crate) fn summarizer_for(
        &self,
        session_id: &str,
    ) -> Option<Arc<dyn conex_compaction::Summarizer>> {
        self.summarizer_factory
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(|factory| factory(session_id))
    }

    /// T-44：session_meta 配置面 → [SummaryDispatchConfig]（读取 helper；
    /// 键缺失 / 解析失败回退生产缺省——None = 生产缺省参数，与轮次 4
    /// `summary_dispatch: None` 语义一致）。
    ///
    /// 可配键（对齐 04 §9.4 T17 / 00-plan §10 轮次 6）：
    /// - `compact_summary_backoff_ms`：退避基数（JSON 数组或单数值，缺省
    ///   [1000,3000,9000]）；
    /// - `compact_summary_wall_ms`：单次调用墙钟（缺省 60000ms，P1-10）。
    /// - `compact_l1_placeholder`：L1 回退开关——**V1 启动级配置**：引擎
    ///   侧（轮次 1）已删 AgentMessage 面 L1 改 stub，运行时双态切换需
    ///   引擎支持；V1 仅读取面（[session_loop::summary_l1_placeholder]）
    ///   文档化、不改变行为，预留给 V2。
    pub(crate) fn summary_dispatch_config(&self, session_id: &str) -> Option<SummaryDispatchConfig> {
        let db = self.local_db()?;
        // 仅当任一配置键存在时构造（无键 = 生产缺省 None，行为不变）
        let has_key = [
            session_loop::META_KEY_SUMMARY_BACKOFF_MS,
            session_loop::META_KEY_SUMMARY_WALL_MS,
        ]
        .iter()
        .any(|key| {
            db.get_session_meta(key)
                .ok()
                .flatten()
                .is_some()
        });
        if !has_key {
            return None;
        }
        // L1 回退开关读取（V1 启动级：不改变行为，仅登记读取；引擎动态
        // 双态支持见 V2 挂账）
        if session_loop::summary_l1_placeholder(|key| {
            db.get_session_meta(key).ok().flatten()
        }) {
            tracing::warn!(
                target: "run",
                session_id = session_id,
                "compact_l1_placeholder=true：旧 L1 占位符回退开关为启动级配置，V1 未接线（引擎已改中性 stub），预留给 V2"
            );
        }
        Some(SummaryDispatchConfig::from_session_meta(
            |key| db.get_session_meta(key).ok().flatten(),
            session_loop::MAX_SUMMARY_ATTEMPTS,
        ))
    }

    /// COMPACTION-01 P0-1（生产闭环）：压缩策略装配——生产恒装配（LocalDb
    /// store 存在即 Some），默认 [conex_compaction::CompactionPolicy::default]
    /// （keep_recent_tokens=20000 / min_recent_turns=2 / max_summary_tokens=
    /// 1024 / tool_pair_protection=true，常量同源），并经 session_meta 键
    /// 覆盖（读取键不实现 UI；坏值回退默认 + warn，不 panic）：
    /// - `compact_summary_max_tokens`（[conex_compaction::SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS]）
    ///   → max_summary_tokens；
    /// - `compact_keep_recent_tokens` → keep_recent_tokens（预留键）；
    /// - `compact_min_recent_turns` → min_recent_turns（预留键）。
    ///
    /// 阈值键（compact_threshold_ratio / compact_critical_ratio）属双阈值
    /// 触发面（DEEPCHECK-11 P1-6 挂账），本策略面不消费。装配后预检
    /// （maybe_compact_preflight）与溢出阶梯（compression_ladder）在生产
    /// 可触发——总闸门解除焊死。
    pub(crate) fn compaction_policy_for(
        &self,
        session_id: &str,
    ) -> Option<conex_compaction::compaction::CompactionPolicy> {
        let db = self.local_db()?;
        let policy = compaction_policy_from_session_meta(|key| {
            db.get_session_meta(key).ok().flatten()
        });
        tracing::debug!(
            target: "run",
            session_id = session_id,
            keep_recent_tokens = policy.keep_recent_tokens,
            min_recent_turns = policy.min_recent_turns,
            max_summary_tokens = policy.max_summary_tokens,
            "压缩策略装配完成（P0-1：session_meta 键覆盖 / 常量默认）"
        );
        Some(policy)
    }

    /// T-42：会话级摘要协调器（跨 run 单飞容器；注册表持有——同会话
    /// 返回同一 Arc，run 收口不摧毁任务）。config 缺省 = 生产缺省退避
    /// 参数（T-44 配置面未启用时与轮次 4 语义一致）。
    pub(crate) fn summary_coordinator_for(
        &self,
        session_id: &str,
    ) -> Arc<session_loop::SessionSummaryCoordinator> {
        let config = self
            .summary_dispatch_config(session_id)
            .unwrap_or_default();
        self.summary_coordinators.get_or_create(session_id, config)
    }

    /// T-AB-19：后台任务汇总（core_get_status.backgroundTasks 数据源；
    /// 活跃任务数 / 守护进程数 / 最近终态——口径见
    /// [RunAwareBackgroundManager::summary]）
    pub async fn background_tasks_summary(&self) -> BackgroundTasksSummary {
        self.background.summary().await
    }

    /// 共享 store（查询命令 / 集成接线用）
    pub fn store(&self) -> Arc<dyn Store> {
        Arc::clone(&self.store)
    }

    /// 全局事件桥（R1-11 remote-* 审计事件发射通道：CoreStateBackend
    /// 经此拿到与 run 上下文同一 [EventBridge] 实例——远程模式降级等
    /// run 创建前动作的 security-audit 事件直发，与 emit_trash_audit
    /// 先例同通道；消费方 = server/core_backend.rs）
    pub(crate) fn event_bridge(&self) -> EventBridge {
        self.bridge.clone()
    }

    /// 30 方案 P3/P6：共享 steering 队列（与引擎
    /// [EngineHandle::timer_steering_queue] 同一实例；P6（批 3 装配轮）
    /// 经此注入 workflow 队列——消除队列双实例，对齐 [Self::store]
    /// Arc::clone 模式；消费方 = main.rs 装配轮（已接线））
    pub(crate) fn steering_queue(&self) -> Arc<Mutex<PendingMessageQueue>> {
        Arc::clone(&self.pending_queue)
    }

    /// 30 方案 P3：任务事件消费器（main.rs 装配轮接线
    /// `background_tasks.set_task_event_consumer(core_state.task_events())`——
    /// 必须在 set_event_bridge 之前调用，EventBridgeSink 构造时读取快照；
    /// 消费方 = main.rs 装配轮（已接线））
    pub(crate) fn task_events(&self) -> Arc<TaskEventConsumer> {
        Arc::clone(&self.task_events)
    }

    /// 30 方案 P6/P7：Cron 调度注册表（透传引擎句柄；None = 装配降级）。
    /// 消费方：main.rs 装配轮（P6 WorkflowBackend::set_registry）+
    /// [Self::new]（P7 cron_has_enabled 判定器装配）
    pub(crate) fn scheduler_registry(&self) -> Option<Arc<crate::sched::SchedulerRegistry>> {
        self.engine.scheduler_registry()
    }

    /// 30 方案 P4：定时器事件缓冲（main.rs drain 任务 500ms tick 取走
    /// 缓冲 → [crate::engine::forward_drained_timer_events] 转发到事件桥；
    /// 与引擎装配实例同一 Arc）
    pub(crate) fn timer_event_sink(&self) -> Arc<crate::timers::AgentEventSink> {
        self.engine.timer_event_sink()
    }

    /// 30 方案 P4：cron 事件缓冲（同 timer 的 drain 转发路径——cron-fired
    /// 单臂，cancel 走数据面 + steering 面，无 cron-cancelled 发射目标）
    pub(crate) fn scheduler_event_sink(&self) -> Arc<crate::sched::SchedEventSink> {
        self.engine.scheduler_event_sink()
    }

    /// restore 是否完成（run_task 门禁；查询命令 restore.state 数据源）
    pub fn restore_ready(&self) -> bool {
        self.restore_ready.load(Ordering::SeqCst)
    }

    // ── T-D-13：子代理 spawner 注入面装配与终态处理 ────────────────

    /// 装配 spawner 注入面（main.rs 在 Arc 构造完成后调用）：启动器
    /// （Weak 引用本状态，run 启动走 run_task_impl 同通道）、行存储
    /// （LocalDb 下转型）、wait 通道终态广播、跨 run steering 队列
    /// （主 agent 唤醒通知落点）。
    pub(crate) fn finalize_subagent_spawner(self: &Arc<Self>) {
        let launcher: Arc<dyn crate::subagent_spawner::SubagentRunLauncher> =
            Arc::new(CoreRunStateLauncher {
                state: Arc::downgrade(self),
            });
        self.subagent_spawner.init(
            Some(launcher),
            self.local_db(),
            Some(self.engine.terminal_stream()),
            Some(Arc::clone(&self.pending_queue)),
        );
    }

    /// 子代理 run 终态处理（drive_run_loop 收口调用）：终态状态映射 →
    /// spawner 统一收口（记账释放 / 行更新 / subagent-ended 发射 / wait
    /// 通道 feed / steering 通知）。
    pub(crate) async fn on_subagent_run_terminal(
        &self,
        cfg: &crate::subagent_spawner::SubagentRunConfig,
        status: conex_db::RunStatus,
    ) {
        // T-CF-13（R-CF3）：子代理终态事件到达壳层即视为一次唤醒——
        // 等待期间的关键事件源（watchdog 失联判定数据源；长等待中
        // 子代理完成事件推进 last_wakeup，防误报"无唤醒"）
        self.engine.last_wakeup().mark_wakeup();
        let state = match status {
            conex_db::RunStatus::Completed => SubagentState::Completed,
            _ => SubagentState::Failed,
        };
        self.subagent_spawner.on_subagent_terminal(cfg, state).await;
    }

    // ── D3：C7 恢复协调器装配（维度文档 D3 §3.1/§3.5）──────────────

    /// D3 §3.1：每会话恢复协调器惰性构造（幂等——同会话同实例）。
    ///
    /// 五件套（裁决 #4 完整装配一次到位，禁占位树）：
    /// - store = LocalDb（[RecoveryStore] impl 现成，recovery.rs:622）；
    /// - queue = [Self::pending_queue]（与引擎共享队列同一 Arc，
    ///   engine.timer_steering_queue 同源）；
    /// - tree = [Self::session_trees] 查 / 无则空树（fork 结构化拒绝兜底，
    ///   recovery.rs:1066-1070）；
    /// - spawner = 生产 SubagentSpawnerImpl（Arc 宽化为 trait object，
    ///   与 fork_and_reassign 调用契约一致）；
    /// - policy = 阶梯 1 跨 run 重试 max_retries=2（V3；session_meta
    ///   `recover_ladder1_max_retries` 可配，宽容解析 fail-open）。
    ///
    /// F2-27：new 的同步读（4-5 键）经专用线程执行（std::thread::scope
    /// 承接，SQLite 工作不落在 tokio worker 上）——惰性一次性构造，进程
    /// 内每会话仅一次。local_db() 为 None（测试替身 store）→ None 降级
    /// （协调器不可用，行为与接线前一致，仿 save_run_usage 先例
    /// core_run_commands.rs:2962-2964）。
    pub(crate) fn coordinator_for(
        &self,
        session_id: &str,
    ) -> Option<Arc<Mutex<RecoveryCoordinator>>> {
        // 1. 已构造 → 返回既有（幂等，同会话同实例）
        {
            let map = self
                .recovery_coordinators
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(existing) = map.get(session_id) {
                return Some(Arc::clone(existing));
            }
        }
        // 2. local_db() 为 None（测试替身 store）→ None 降级
        let Some(db) = self.local_db() else {
            return None;
        };
        // 3. 五件套装配（tree 与 coordinator 同批插入，防并发双构造）
        let tree = {
            let mut trees = self.session_trees.lock().unwrap_or_else(|e| e.into_inner());
            trees.get(session_id).cloned().unwrap_or_else(|| {
                let arc = Arc::new(Mutex::new(SessionTree::new(session_id)));
                trees.insert(session_id.to_string(), Arc::clone(&arc));
                arc
            })
        };
        let store: Arc<dyn RecoveryStore> = Arc::new(db);
        let queue = Arc::clone(&self.pending_queue);
        // Arc 宽化：生产 spawner → trait object（与 fork_and_reassign 调用
        // 契约一致；显式两步断开——编译器对 Arc::clone 的 trait object
        // 目标推断不收敛，先克隆具体类型再 as 宽化）
        let concrete = Arc::clone(&self.subagent_spawner);
        let spawner: Arc<dyn agent_tools::tools::subagent::SubagentSpawner> =
            concrete as Arc<dyn agent_tools::tools::subagent::SubagentSpawner>;
        // V3：阶梯 1 跨 run 重试次数可配键（D3 自决键；宽容解析 fail-open）
        let ladder1_max_retries = store
            .get_meta(RECOVER_LADDER1_MAX_RETRIES_KEY)
            .ok()
            .flatten()
            .and_then(|raw| raw.parse::<u32>().ok())
            .unwrap_or(RECOVER_LADDER1_MAX_RETRIES_DEFAULT);
        let policy = RecoveryRetryPolicy {
            max_retries: ladder1_max_retries,
            ..Default::default()
        };
        let session_id_owned = session_id.to_string();
        // 4. RecoveryCoordinator::new 经专用线程执行（F2-27：同步读 4-5
        //    键的 SQLite 工作不落在 tokio worker 上；new 为纯同步函数，
        //    std::thread::scope 承接——调用线程同步等待 join，一次性惰性
        //    构造，进程内每会话仅一次。不用 Handle::block_on：coordinator_for
        //    是同步 fn、被 async 上下文调用，async 上下文内 block_on 会
        //    panic（EnterRuntime 守卫））
        let constructed = std::thread::scope(|scope| {
            scope
                .spawn(move || {
                    RecoveryCoordinator::new(session_id_owned, store, queue, tree, spawner, policy)
                })
                .join()
        })
        .unwrap_or_else(|join_error| {
            Err(RecoveryError::PersistFailed {
                message: format!("恢复协调器构造线程 join 失败：{join_error:?}"),
            })
        });
        let coord = match constructed {
            Ok(coordinator) => Arc::new(Mutex::new(coordinator)),
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    session_id,
                    error = %error,
                    "恢复协调器构造失败（本会话恢复路径降级为接线前行为）"
                );
                return None;
            }
        };
        // 5. double-check：锁内重查（并发双构造时丢弃后到者）
        let mut map = self
            .recovery_coordinators
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = map.get(session_id) {
            return Some(Arc::clone(existing));
        }
        map.insert(session_id.to_string(), Arc::clone(&coord));
        Some(coord)
    }

    /// D3 §3.5：跨 run 阶梯 1 已重派次数（(session_id, fingerprint) 键；
    /// 进程内记账，重启清零——阶梯 1 不留痕是既有语义，recovery.rs:1801
    /// -1803 测试锁定）。retries 语义 = 该任务跨 run 已重试次数，与 run
    /// 内 provider_error.retries 是两套独立计数（D3 §8 决策 1）。
    fn ladder1_retry_count(&self, session_id: &str, fp: &str) -> u32 {
        self.ladder1_retries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&(session_id.to_string(), fp.to_string()))
            .copied()
            .unwrap_or(0)
    }

    /// D3 §3.5：重派成功后计数 +1（AutoRetry 实际拉起）
    fn bump_ladder1_retry(&self, session_id: &str, fp: &str) -> u32 {
        let mut map = self.ladder1_retries.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map
            .entry((session_id.to_string(), fp.to_string()))
            .or_insert(0);
        *entry += 1;
        *entry
    }

    /// D3 §3.5：spawn 失败（含 16/16/1 守卫拒绝）→ 计数推满（重入
    /// [RecoveryCoordinator::on_subagent_run_failure] 必 Escalate 上阶梯 2，
    /// 不静默、无假重试）
    fn force_ladder1_retry_max(&self, session_id: &str, fp: &str) {
        let max = self.ladder1_max_retries_config();
        let mut map = self.ladder1_retries.lock().unwrap_or_else(|e| e.into_inner());
        *map.entry((session_id.to_string(), fp.to_string())).or_insert(0) = max;
    }

    /// D3 §4.1：阶梯 1 跨 run 重试次数配置解析（可配键缺省 2；与
    /// coordinator_for 装配口径同源，保证「推满 = 必然 Escalate」判定一致）
    fn ladder1_max_retries_config(&self) -> u32 {
        let Some(db) = self.local_db() else {
            return RECOVER_LADDER1_MAX_RETRIES_DEFAULT;
        };
        db.get_session_meta(RECOVER_LADDER1_MAX_RETRIES_KEY)
            .ok()
            .flatten()
            .and_then(|raw| raw.parse::<u32>().ok())
            .unwrap_or(RECOVER_LADDER1_MAX_RETRIES_DEFAULT)
    }

    // ── D6：会话级 user_stopped + 每会话唤醒 watcher（无人值守最后一跳）──

    /// D6 §8 决策 1：设置会话级用户停止标记（用户 L2/L3 停止路径调用；
    /// 同步到该会话 watcher 实例——watcher 判定与 decide_idle_resume
    /// 共享同一跨 run 语义；不落库，重启天然消失）
    pub(crate) fn set_user_stopped(&self, session_id: &str) {
        let now = now_ms_internal();
        *self
            .user_stopped
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(session_id.to_string())
            .or_insert(0) = now;
        if let Some(watcher) = self
            .wake_watchers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
        {
            watcher.set_user_stopped_at(now);
        }
    }

    /// D6 §8 决策 1：清除会话级用户停止标记（用户新 run 装配成功后
    /// 调用——用户新 run = 显式授权恢复自动行为；idle-resume/子代理
    /// run 不写不清，停止语义跨 run 存活直到用户介入）
    pub(crate) fn clear_user_stopped(&self, session_id: &str) {
        self.user_stopped
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session_id);
        if let Some(watcher) = self
            .wake_watchers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
        {
            watcher.clear_user_stopped();
        }
    }

    /// D6 §4.2：会话级用户停止标记是否存在（decide_idle_resume 与
    /// watcher 判定共享的读面）
    pub(crate) fn is_user_stopped(&self, session_id: &str) -> bool {
        self.user_stopped
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(session_id)
    }

    /// D6 §3.2 spawn 点 1/2：每会话唤醒 watcher 惰性 spawn（幂等持有——
    /// 已存在返回 false 不重复 spawn）。注入件：
    /// - queue = [Self::pending_queue]（与 TimerRegistry / watchdog 同一
    ///   实例）；
    /// - has_active_run = active_runs 锁内同会话扫描（拉起前检查；串行
    ///   守卫由 run_task_impl 兜底拒绝并发双拉，验收 A5）；
    /// - empty_streak = [Self::resume_empty_streak] 只读（计数由收口
    ///   decide_idle_resume 维护，W2 按唤醒源区分，watcher 只读判停）；
    /// - launcher = [spawn_idle_resume_run] 包装（空 Vec 注入——队列条目
    ///   由新 run 收口时 decide_idle_resume drain，D6 §8 决策 2 路径①，
    ///   wake_watcher.rs 装配注记）。
    ///
    /// 首轮延迟 5s + 最小拉 run 间隔 10s（WakeWatcherOptions 缺省）。
    /// 无 tokio runtime（非 async 上下文）→ 跳过 spawn（对齐
    /// engine.rs:1313-1320 watchdog 先例）。
    pub(crate) fn ensure_wake_watcher(self: &Arc<Self>, session_id: &str) -> bool {
        // 幂等：已存在 → false（不重复 spawn）
        {
            let map = self.wake_watchers.lock().unwrap_or_else(|e| e.into_inner());
            if map.contains_key(session_id) {
                return false;
            }
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::debug!(
                target: "wake_watcher",
                session_id,
                "唤醒 watcher 跳过 spawn：当前上下文无 tokio runtime"
            );
            return false;
        };
        let watcher = self.build_wake_watcher(session_id);
        let started = watcher.start(&runtime);
        // 同步 user_stopped（停止标记先于 watcher 创建的场景——watcher
        // 幂等持有期间 L2/L3 停止经 set_user_stopped 同步；此处兜底
        // watcher 晚于停止创建的情形）
        if let Some(at) = self
            .user_stopped
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .copied()
        {
            watcher.set_user_stopped_at(at);
        }
        // double-check（并发双构造丢弃后到者，对齐 coordinator_for 先例）
        let mut map = self.wake_watchers.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(session_id) {
            watcher.stop();
            return false;
        }
        map.insert(session_id.to_string(), watcher);
        started
    }

    /// D6 §3.2：构造会话 watcher（注入件闭包全部经 Weak 引用——
    /// CoreRunState ↔ watcher 互相持有会构成 Arc 强引用环泄漏）
    fn build_wake_watcher(self: &Arc<Self>, session_id: &str) -> Arc<crate::wake_watcher::WakeWatcher> {
        let queue = Arc::clone(&self.pending_queue);
        let weak_active = Arc::downgrade(self);
        let has_active_run: Arc<dyn Fn(&str) -> bool + Send + Sync> = Arc::new(move |sid: &str| {
            weak_active
                .upgrade()
                .map(|state| {
                    state
                        .active_runs
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .values()
                        .any(|run| run.session_id == sid)
                })
                .unwrap_or(false)
        });
        let weak_streak = Arc::downgrade(self);
        let empty_streak: Arc<dyn Fn(&str) -> u32 + Send + Sync> = Arc::new(move |sid: &str| {
            weak_streak
                .upgrade()
                .map(|state| {
                    state
                        .resume_empty_streak
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get(sid)
                        .copied()
                        .unwrap_or(0)
                })
                .unwrap_or(0)
        });
        let weak_launcher = Arc::downgrade(self);
        let launcher: crate::wake_watcher::WakeLauncher = Arc::new(move |sid: String| {
            let weak = weak_launcher.clone();
            Box::pin(async move {
                let Some(state) = weak.upgrade() else {
                    return;
                };
                // D6 §8 决策 2 路径①：空 Vec 注入——队列条目由新 run 收口
                // 时 decide_idle_resume drain（wake_watcher.rs 装配注记）；
                // D7 摘要注入在 spawn_idle_resume_run 内统一拼接
                idle_resume::spawn_idle_resume_run(state, sid, "idle-resume", Vec::new()).await;
            })
        });
        Arc::new(crate::wake_watcher::WakeWatcher::new(
            session_id.to_string(),
            queue,
            has_active_run,
            empty_streak,
            launcher,
            crate::wake_watcher::WakeWatcherOptions::default(),
        ))
    }

    /// D6 §3.3：重启恢复条目生成（断点 3 消费端；run_restore 成功路径
    /// 调用）。对 [RestoreOutcome::interrupted] 逐条生成 steering 条目
    /// （group_id = `restore-<run_id>`，is_steering 受保护——容量挤占时
    /// 普通消息先被挤掉）：
    /// - **主 run**（非 sub-sess-* 会话）→ 恢复条目入队（watcher 首轮
    ///   延迟窗口后 / 下次收口消费），注入「上次被重启打断，请继续」
    ///   自动续跑（A3）；
    /// - **子代理 run**（sub-sess-* 前缀分流）→ 只通知主 agent 不自动
    ///   fork（裁决 #20：自动重派违反「所有子 Agent 由主 Agent 分配」
    ///   红线）；父归属经 session_agents 行 parent_session_id 解析
    ///   （D6 §8 决策 3），查不到 → 跳过通知仅日志（run-interrupted
    ///   事件已留痕）。
    ///
    /// 不消费 recover_episodes 预算（W8：唤醒源枚举为前瞻设计，预算仅
    /// error-retry 域消费；风暴防制靠合并上限 + watcher 延迟）。
    async fn enqueue_restore_entries(&self, outcome: &RestoreOutcome) {
        let subagent_records: Vec<&orchestrator::restore::InterruptedRun> = outcome
            .interrupted
            .iter()
            .filter(|record| record.session_id.starts_with(SUBAGENT_SESSION_PREFIX))
            .collect();
        let parents = if subagent_records.is_empty() {
            HashMap::new()
        } else {
            let run_ids: Vec<String> = subagent_records
                .iter()
                .map(|record| record.run_id.clone())
                .collect();
            let candidate_sessions: Vec<String> =
                outcome.sessions.iter().map(|session| session.session_id.clone()).collect();
            self.resolve_subagent_parents(&run_ids, &candidate_sessions).await
        };
        let mut queue = self.pending_queue.lock().unwrap_or_else(|e| e.into_inner());
        for record in &outcome.interrupted {
            let now = now_ms_internal();
            // 目标会话为语义注记（队列为全局共享面，无会话字段——消费
            // 方按 group_id/条目文本承载归属语义，T06.3 Q15）
            let (_target_session, text) = if record.session_id.starts_with(SUBAGENT_SESSION_PREFIX) {
                match parents.get(&record.run_id) {
                    Some(parent) => (
                        parent.clone(),
                        format!(
                            "子代理 run {} 在重启时被中断（{}），请决策：重派 / 接管 / 放弃",
                            record.run_id,
                            orchestrator::restore::INTERRUPTED_ERROR,
                        ),
                    ),
                    None => {
                        tracing::warn!(
                            target: "restore",
                            run_id = %record.run_id,
                            session_id = %record.session_id,
                            "子代理 interrupted 父归属查不到（跳过通知；run-interrupted 事件已留痕）"
                        );
                        continue;
                    }
                }
            } else {
                (record.session_id.clone(), RESTORE_MAIN_INJECT_TEXT.to_string())
            };
            // 分组去重（replace_or_enqueue：同 run 不重复堆积——重启
            // 双恢复场景仅 1 条）；带时间戳 id 保证同组替换后仍唯一
            queue.replace_or_enqueue(orchestrator::steering_queue::SteeringInputEntry {
                id: format!("{RESTORE_GROUP_PREFIX}{}-{now}", record.run_id),
                text,
                attachments: Vec::new(),
                enqueued_at: now,
                group_id: Some(format!("{RESTORE_GROUP_PREFIX}{}", record.run_id)),
                is_steering: true,
            });
        }
    }

    /// D6 §8 决策 3：子代理 run → 父会话解析（session_agents 行
    /// subagent_run_id 反查——行按父会话 id 落库，subagent_spawner.rs:296
    /// row_for；候选会话 = 恢复会话全集）。F2-27：同步 SQLite 读经
    /// spawn_blocking 执行，tokio worker 不直调。
    async fn resolve_subagent_parents(
        &self,
        run_ids: &[String],
        candidate_sessions: &[String],
    ) -> HashMap<String, String> {
        let Some(db) = self.local_db() else {
            return HashMap::new();
        };
        let targets: Vec<String> = run_ids.to_vec();
        let sessions: Vec<String> = candidate_sessions.to_vec();
        tokio::task::spawn_blocking(move || {
            let mut parents = HashMap::new();
            for session in &sessions {
                match db.load_session_agents(session) {
                    Ok(agents) => {
                        for agent in agents {
                            if targets.iter().any(|target| target == &agent.subagent_run_id) {
                                parents.insert(agent.subagent_run_id, agent.parent_session_id);
                            }
                        }
                    }
                    Err(error) => tracing::warn!(
                        target: "restore",
                        session_id = %session,
                        error = %error,
                        "恢复条目父归属扫描读取失败（跳过该会话）"
                    ),
                }
            }
            parents
        })
        .await
        .unwrap_or_default()
    }

    // ── D1/D2/D5：壳层恢复面（熔断计数 / goal_state / 退避注入）─────

    /// D1 §3.2.4：熔断闸查询（读 `provider_fail_streak` 键 count 字段；
    /// count >= 阈值 → true；fail-open：坏 JSON / 缺字段 → count=0）。
    ///
    /// 落点 ① transient_retry 入口（经 [Self::provider_fail_streak_count]
    /// 装配进 SessionLoopOptions，D1 §3.2.3）；落点 ② decide_idle_resume
    /// error 分支与 E1 续写分支（02-定夺 S2：两处共用同一查询面）。
    pub(crate) async fn circuit_breaker_is_tripped(&self, _session_id: &str) -> bool {
        let Some(db) = self.local_db() else {
            return false;
        };
        let threshold = self.provider_fail_threshold_config(&db);
        tokio::task::spawn_blocking(move || {
            let raw = db
                .get_session_meta(PROVIDER_FAIL_STREAK_KEY)
                .ok()
                .flatten();
            let streak = ProviderFailStreak::from_json(raw.as_deref());
            streak.effective_count(now_ms_internal()) >= threshold
        })
        .await
        .unwrap_or(false)
    }

    /// D1 §3.2.2（S2）：收口熔断计数更新（唯一写方；spawn_blocking 读-改-
    /// 写键）。`transient_failure = true` → 连续失败 +1（部分保留断流计入）；
    /// false → 清零（规则 C3：仅 run 以非瞬态错误收场或正常完成时执行）。
    ///
    /// 返回是否本次更新**跨过**阈值（熔断触发边沿；调用方负责发射
    /// runtime-intervention-required + recovery-escalated 观测事件）。
    pub(crate) async fn update_provider_fail_streak(
        &self,
        _session_id: &str,
        transient_failure: bool,
    ) -> bool {
        let Some(db) = self.local_db() else {
            return false;
        };
        let threshold = self.provider_fail_threshold_config(&db);
        tokio::task::spawn_blocking(move || {
            let raw = db
                .get_session_meta(PROVIDER_FAIL_STREAK_KEY)
                .ok()
                .flatten();
            let mut streak = ProviderFailStreak::from_json(raw.as_deref());
            let now = now_ms_internal();
            let before = streak.effective_count(now);
            if transient_failure {
                streak.record_failure(now);
            } else {
                streak = ProviderFailStreak::cleared(now);
            }
            if db
                .set_session_meta(PROVIDER_FAIL_STREAK_KEY, &streak.to_json())
                .is_err()
            {
                return false;
            }
            before < threshold && streak.count >= threshold
        })
        .await
        .unwrap_or(false)
    }

    /// D1 §3.1.4：熔断阈值配置解析（`provider_fail_threshold` 键，缺省 6；
    /// 与 stream_error.rs PROVIDER_FAIL_THRESHOLD 同值防漂移）
    fn provider_fail_threshold_config(&self, db: &LocalDb) -> u32 {
        db.get_session_meta(PROVIDER_FAIL_THRESHOLD_KEY)
            .ok()
            .flatten()
            .and_then(|raw| raw.parse::<u32>().ok())
            .unwrap_or(PROVIDER_FAIL_THRESHOLD_DEFAULT)
    }

    /// D1 §3.2.3：熔断计数当前值（run 装配面注入 SessionLoopOptions
    /// provider_fail_streak——transient_retry 入口闸 C1 输入；无键 → None
    /// = 不启用闸，向后兼容）
    pub(crate) async fn provider_fail_streak_count(&self, _session_id: &str) -> Option<u32> {
        let db = self.local_db()?;
        tokio::task::spawn_blocking(move || {
            let raw = db
                .get_session_meta(PROVIDER_FAIL_STREAK_KEY)
                .ok()
                .flatten();
            let streak = ProviderFailStreak::from_json(raw.as_deref());
            let count = streak.effective_count(now_ms_internal());
            (count > 0).then_some(count)
        })
        .await
        .ok()
        .flatten()
    }

    /// D1 §3.1.4（R6）：瞬态重试退避配置读取（run 装配面注入
    /// SessionLoopOptions.retry_backoff——Some 时内核退避
    /// 750ms×2^(n-1)/8s 封顶/60s 预算生产生效；None = 现状立即重试
    /// 向后兼容）。键 = `provider_retry_backoff_ms`，形状 = JSON 数组
    /// [base, max, budget] 或单值 base（宽容解析：坏值 → None fail-open，
    /// 不阻断装配）。
    pub(crate) fn retry_backoff_config(
        &self,
        _session_id: &str,
    ) -> Option<session_loop::r#loop::RetryBackoffConfig> {
        let db = self.local_db()?;
        let raw = db
            .get_session_meta(PROVIDER_RETRY_BACKOFF_MS_KEY)
            .ok()
            .flatten()?;
        parse_retry_backoff_config(&raw)
    }

    /// D5 §3.2：读 `goal_state` 键（宽容解析 fail-open：缺键 / 坏 JSON →
    /// None = 无 goal；字段级容忍由 [GoalState::from_json] 保证）
    pub(crate) async fn load_goal_state(&self, _session_id: &str) -> Option<GoalState> {
        let db = self.local_db()?;
        tokio::task::spawn_blocking(move || {
            let raw = db
                .get_session_meta(orchestrator::goal_state::GOAL_STATE_KEY)
                .ok()
                .flatten();
            GoalState::from_json(raw.as_deref())
        })
        .await
        .ok()
        .flatten()
    }

    /// D5 §3.2：写 `goal_state` 键（唯一写方 = run 收口 RoundAssessment +
    /// run_task_impl 装配覆盖；spawn_blocking 落键；失败仅告警不阻断）
    pub(crate) async fn save_goal_state(&self, _session_id: &str, state: &GoalState) {
        let Some(db) = self.local_db() else {
            return;
        };
        let json = state.to_json();
        let _ = tokio::task::spawn_blocking(move || {
            db.set_session_meta(orchestrator::goal_state::GOAL_STATE_KEY, &json)
        })
        .await;
    }

    /// D5 §3.7：最新 compression_block.summary_json 的 nextSteps 读取
    /// （fail-open：无块 / 坏 JSON → None，不阻断注入——注入主源是 goal
    /// 前缀；Schema V1 字段 nextSteps = 字符串数组）
    pub(crate) async fn read_summary_next_steps(&self, session_id: &str) -> Vec<String> {
        let Some(db) = self.local_db() else {
            return Vec::new();
        };
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || {
            db.list_blocks(&session_id, Some(1))
                .ok()
                .and_then(|blocks| blocks.into_iter().next())
                .and_then(|block| block.summary_json)
                .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                .and_then(|value| {
                    value
                        .get("nextSteps")
                        .and_then(|steps| steps.as_array())
                        .map(|steps| {
                            steps
                                .iter()
                                .filter_map(|step| step.as_str().map(String::from))
                                .collect()
                        })
                })
                .unwrap_or_default()
        })
        .await
        .unwrap_or_default()
    }

    /// E1 §3.4（T7）：续写开关键（`content_resume_enabled` 键，缺省 true
    /// = 默认开启——与用户诉求「断网自动接续最好」一致）
    async fn content_resume_enabled(&self, _session_id: &str) -> bool {
        let Some(db) = self.local_db() else {
            return true;
        };
        tokio::task::spawn_blocking(move || {
            db.get_session_meta(CONTENT_RESUME_ENABLED_KEY)
                .ok()
                .flatten()
                .and_then(|raw| raw.parse::<bool>().ok())
                .unwrap_or(true)
        })
        .await
        .unwrap_or(true)
    }

    /// D5 §3.3：收口 goal 轮次评估（唯一写方；子代理 run 不调用——守卫
    /// 在调用点 `active.subagent.is_none()`，02-定夺 S10）。
    ///
    /// 流程：load goal_state（无 goal → 不评估不写）→ assess_round 纯函数
    /// → advance 写回（spawn_blocking）→ goal-round-completed 事件发射
    /// （envelope 通道，02-定夺 B2 统一字段集）。
    pub(crate) async fn assess_goal_round(
        &self,
        active: &ActiveRun,
        reason: AgentEndReason,
        signals: &GoalRoundSignals,
        runtime_error: Option<&str>,
    ) {
        let Some(current) = self.load_goal_state(&active.session_id).await else {
            return;
        };
        let input = RoundInput {
            end_reason: reason,
            assistant_text: signals.assistant_text.clone(),
            tool_calls: signals.tool_calls.clone(),
            tool_success_count: signals.tool_success_count,
            runtime_error: runtime_error.map(String::from),
            current: current.clone(),
        };
        let assessment = assess_round(&input);
        if assessment.decision == GoalDecision::NoGoal {
            return;
        }
        let advanced = current.advance(&input, &assessment);
        self.save_goal_state(&active.session_id, &advanced).await;
        // goal-round-completed（round = 本轮序号 = 评估前 current_round + 1；
        // error 轮不递增 current_round，但 round 序号仍按本轮计）
        let event = AgentEvent::GoalRoundCompleted {
            round: current.current_round + 1,
            tool_call_count: signals.tool_call_count,
            tool_success_count: signals.tool_success_count,
            message_count: signals.message_count,
            decision: goal_decision_wire(assessment.decision),
            reason_detail: assessment.reason_detail.clone(),
            stalled_delta: assessment.stalled_delta,
            evidence: signals.tool_success_count.to_string(),
        };
        emit_envelope_event(&active.queue, &active.bridge, &active.run_id, &active.session_id, event)
            .await;
    }

    /// D2 §3.4（C4 锁死）：跨 run 退避延迟（注入点存在 → 注入函数直取
    /// 测试驱动；None → 镜像 recovery.rs 常量 750→1500→3000，8s 封顶）
    pub(crate) fn backoff_delay_for(&self, attempt: u32) -> Duration {
        if let Some(f) = self
            .resume_backoff
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            return f(attempt);
        }
        backoff_delay_ms(&RecoveryRetryPolicy::default(), attempt)
    }

    /// D2 §3.4：退避睡眠（注入点存在 = 测试驱动模式，跳过真实睡眠；
    /// 生产经 tokio::time::sleep 等待）
    pub(crate) async fn sleep_resume_backoff(&self, delay: Duration) {
        let injected = self
            .resume_backoff
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some();
        if injected {
            return;
        }
        tokio::time::sleep(delay).await;
    }

    /// D2 §3.4 + E1 §3.4：恢复预算消费（RecoveryBudget 纯函数复用零改动；
    /// 同键 `recover_episodes`、指纹域互斥；会话串行守卫下读-改-写安全，
    /// F2-27 spawn_blocking）。
    ///
    /// 上限来源：error-retry 域 = `recover_max_episodes` 键（缺省
    /// RecoveryBudget::default_limit()=3）；content-resume 域 =
    /// `content_resume_max` 键（缺省 2）。判定时消费（拉起失败不重复
    /// 消费，条目滞留由 watcher/下轮收口兜底）。
    async fn consume_resume_episode(
        &self,
        _session_id: &str,
        fp: &str,
        limit_key: &'static str,
        default_limit: u32,
    ) -> EpisodeConsume {
        let Some(db) = self.local_db() else {
            return EpisodeConsume::Denied {
                count: 0,
                max: default_limit,
            };
        };
        let fp = fp.to_string();
        let limit_key = limit_key.to_string();
        tokio::task::spawn_blocking(move || {
            let raw = db
                .get_session_meta(RECOVER_EPISODES_KEY)
                .ok()
                .flatten();
            let limit = db
                .get_session_meta(&limit_key)
                .ok()
                .flatten()
                .and_then(|raw| raw.parse::<u32>().ok())
                .unwrap_or(default_limit);
            let mut budget = RecoveryBudget::from_json(raw.as_deref(), limit);
            if !budget.can_recover(&fp) {
                return EpisodeConsume::Denied {
                    count: budget.count(&fp),
                    max: limit,
                };
            }
            let count = match budget.record_fork(&fp) {
                Ok(count) => count,
                Err(_) => {
                    return EpisodeConsume::Denied {
                        count: budget.count(&fp),
                        max: limit,
                    };
                }
            };
            if db
                .set_session_meta(RECOVER_EPISODES_KEY, &budget.to_json())
                .is_err()
            {
                return EpisodeConsume::Denied {
                    count,
                    max: limit,
                };
            }
            EpisodeConsume::Consumed(count)
        })
        .await
        .unwrap_or(EpisodeConsume::Denied {
            count: 0,
            max: default_limit,
        })
    }

    /// D3 §3.2.1/§3.2.4：任务文本还原（首条 user 消息文本；与
    /// lifecycle.rs derive_task 同源——子代理 run 首条 user 消息即任务
    /// prompt 的对话形态）。无 user 消息 → 空串（指纹退化但可运行）。
    fn first_user_text(messages: &[Arc<AgentMessage>]) -> String {
        messages
            .iter()
            .find(|m| m.role == AgentMessageRole::User)
            .map(|m| m.text().trim().to_string())
            .unwrap_or_default()
    }

    /// D3 §3.2.2：阶梯 1 收口后重派请求（裁决 #5：原 run failed
    /// reason=recovery-retry + 预算内重派新 run mode=recovery-retry；
    /// 不消费 Episode、无 steering 通知）。subagent_id 由 spawner 生成
    /// （agent_id: None，与 fork 请求同构 recovery.rs:1115-1135）——预算
    /// 指纹用原 subagent_id（D3 §8 决策 8），不受新 run id 影响。
    fn retry_spawn_request(
        cfg: &crate::subagent_spawner::SubagentRunConfig,
        ctx: &RunFailureContext,
    ) -> agent_tools::tools::subagent::SubagentSpawnRequest {
        agent_tools::tools::subagent::SubagentSpawnRequest {
            agent_id: None,
            prompt: ctx.task.clone(),
            role: None,
            capability_mode: None,
            allowed_tools: None,
            timeout_ms: None,
            description: Some("恢复阶梯 1 重派（C7，承接同一目标）".to_string()),
            mode: Some("recovery-retry".to_string()),
            parent_session_id: cfg.parent_session_id.clone(),
            parent_run_id: None,
            parent_tool_call_id: None,
            flow_node_id: None,
            is_composite: false,
            task_type: None,
            allowed_write_paths: None,
            display_label: None,
            model_override: None,
        }
    }

    /// D3 §3.2.4：RunFailureContext 还原（11 字段装配表；retries = 跨 run
    /// 阶梯 1 已重派次数——D3 §8 决策 1，**非** run 内 provider_error.retries；
    /// retry_elapsed_ms = 0（决策 3：次数判定已覆盖预算语义）；from_leaf_id
    /// = None（初始 run 无 subagent_path_json 落库，阶梯 3 结构化拒绝，
    /// subagent_spawner.rs:703）；history 字段由 D7 维度在 recovery.rs 落地
    /// 后接入（轮 2 A9 派单，数据源 = session_history.get(子代理会话)））。
    ///
    /// error_kind 取自 RunOutcome.provider_error.kind（D1 数据面；
    /// ProviderErrorSummary 为 session-loop 私有模块类型，壳层只消费
    /// 其 public 字段 kind，不命名类型）。
    fn build_run_failure_context(
        cfg: &crate::subagent_spawner::SubagentRunConfig,
        error_kind: ProviderErrorKind,
        first_user_text: &str,
        has_assistant_output: bool,
        ladder1_retries: u32,
        inject_bytes: u64,
        window_bytes: u64,
    ) -> RunFailureContext {
        RunFailureContext {
            subagent_id: cfg.subagent_id.clone(),
            subagent_run_id: cfg.subagent_run_id.clone(),
            task: first_user_text.to_string(),
            error_kind,
            retries: ladder1_retries,
            retry_elapsed_ms: 0,
            produced_content: has_assistant_output,
            from_leaf_id: None,
            started_at_ms: cfg.started_at_ms,
            inject_bytes,
            window_bytes,
        }
    }

    /// D3 §3.2.2：C7 恢复决策（子代理收口处、on_subagent_run_terminal
    /// **之前**调用；决策先行——escalate 的 steering 条目先入队，与
    /// subagent-terminal-<run_id> 终态通知共存，02 D2 裁定保留双条目）。
    ///
    /// 触发条件：active.subagent 为 Some 且终态 Failed 且
    /// RunOutcome.provider_error 有数据（D1 面）且协调器可用（local_db
    /// 装配）。返回 AutoRetry 计划（含退避 delay 与重入协调器引用）；
    /// SteeringQueued / NeedsUser 由协调器内部完成（通知入队/标记），
    /// 无需额外动作。
    async fn decide_subagent_recovery(
        &self,
        session_id: &str,
        cfg: &crate::subagent_spawner::SubagentRunConfig,
        terminal_status: &conex_db::RunStatus,
        error_kind: Option<ProviderErrorKind>,
        first_user_text: &str,
        has_assistant_output: bool,
        run_message_bytes: u64,
    ) -> Option<RecoveryPlan> {
        if terminal_status != &conex_db::RunStatus::Failed {
            return None;
        }
        let Some(error_kind) = error_kind else {
            return None;
        };
        let Some(coord) = self.coordinator_for(session_id) else {
            return None;
        };
        let fp = fingerprint(&cfg.subagent_id, first_user_text);
        let ctx = Self::build_run_failure_context(
            cfg,
            error_kind,
            first_user_text,
            has_assistant_output,
            self.ladder1_retry_count(session_id, &fp),
            // inject_bytes：重派 run 无注入内容（新 run 以任务 prompt 起头，
            // 与 fork 的「注入内容字节」语义不同源——fork 三态判定归
            // resume 命令面（D4）装配，本触发点 only 决策不消费）
            0,
            // window_bytes：本 run 消息字节合计（content_bytes 语义同源，
            // lifecycle.rs:451-458；会话窗口近似）
            run_message_bytes,
        );
        // 决策闭包经 spawn_blocking 执行（F2-27）；ctx 克隆进闭包（决策
        // 只读消费），原件随 AutoRetry 计划移交重派执行
        let ctx_for_decision = ctx.clone();
        let decision = blocking_coordinator_call(Arc::clone(&coord), move |c| {
            // on_subagent_run_failure 为无 await 的 async 方法（函数体全
            // 同步，recovery.rs:914-978），经 Handle::block_on 在 blocking
            // 线程执行（D3 §3.4.1）
            block_on_coordinator_failure(c, &ctx_for_decision)
        })
        .await;
        match decision {
            Ok(RecoveryOutcome {
                action: RecoveryAction::AutoRetry { delay, .. },
                ..
            }) => Some(RecoveryPlan::AutoRetry {
                delay,
                ctx,
                coord,
            }),
            Ok(_) => None,
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    session_id,
                    subagent_run_id = %cfg.subagent_run_id,
                    error = %error,
                    "恢复决策失败（协调器不可用，收口走接线前行为）"
                );
                None
            }
        }
    }

    /// D3 §3.2.2/§3.2.3：阶梯 1 收口后重派（裁决 #5 方案 Y）。在
    /// on_subagent_run_terminal（旧 run 记账释放）**之后**执行——spawn
    /// 守卫快照不含旧 run，无「被自己挡住」误拒（subagent_spawner.rs:
    /// 506-526、743-764 时序保证）。
    ///
    /// 顺序：退避 sleep（async 不阻塞 worker）→ 原 run end_reason 覆写
    /// recovery-retry（spawn_blocking）→ 预算内重派（mode=recovery-retry，
    /// 不消费 Episode、无 steering）→ 计数 +1；spawn 失败（含 16/16/1
    /// 守卫拒绝）→ 计数推满 + retries 推满重入 escalate（阶梯 2 通知，
    /// 不静默、无假重试）。
    async fn execute_subagent_recovery(
        &self,
        session_id: &str,
        cfg: &crate::subagent_spawner::SubagentRunConfig,
        plan: RecoveryPlan,
    ) {
        let RecoveryPlan::AutoRetry { delay, ctx, coord } = plan;
        // 退避（async sleep 不阻塞 tokio worker）
        tokio::time::sleep(delay).await;
        // 原 run failed reason 覆写（RecoveryStore::update_run_status 同步
        // → spawn_blocking 直连 LocalDb，F2-27 覆盖表新增点）
        if let Some(db) = self.local_db() {
            let run_id = ctx.subagent_run_id.clone();
            match tokio::task::spawn_blocking(move || {
                db.update_run_status(&run_id, conex_db::RunStatus::Failed, Some("recovery-retry"), None)
            })
            .await
            {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::warn!(
                        target: "run",
                        session_id,
                        subagent_run_id = %ctx.subagent_run_id,
                        error = %error,
                        "原 run end_reason 覆写 recovery-retry 失败（仅观测面）"
                    );
                }
                Err(join_error) => {
                    tracing::warn!(
                        target: "run",
                        session_id,
                        error = %join_error,
                        "原 run end_reason 覆写 spawn_blocking join 失败"
                    );
                }
            }
        }
        // 预算内重派新 run（mode=recovery-retry；不消费 Episode、无 steering）
        let request = Self::retry_spawn_request(cfg, &ctx);
        let fp = fingerprint(&ctx.subagent_id, &ctx.task);
        match self.subagent_spawner.spawn(&request).await {
            Ok(spawned) => {
                let retries = self.bump_ladder1_retry(session_id, &fp);
                tracing::info!(
                    target: "run",
                    session_id,
                    from_run_id = %ctx.subagent_run_id,
                    new_subagent_run_id = %spawned.subagent_run_id,
                    retries,
                    "恢复阶梯 1 收口后重派成功（mode=recovery-retry，不消费 Episode）"
                );
            }
            Err(error) => {
                // spawn 失败（含 16/16/1 守卫拒绝）：计数推满 + retries
                // 推满 → 重入 on_subagent_run_failure 必 Escalate（阶梯 2
                // 通知主 agent，不静默、无假重试）
                self.force_ladder1_retry_max(session_id, &fp);
                let mut escalate_ctx = ctx;
                escalate_ctx.retries = self.ladder1_retry_count(session_id, &fp);
                let run_id_for_log = escalate_ctx.subagent_run_id.clone();
                let outcome = blocking_coordinator_call(coord, move |c| {
                    block_on_coordinator_failure(c, &escalate_ctx)
                })
                .await;
                tracing::warn!(
                    target: "run",
                    session_id,
                    subagent_run_id = %run_id_for_log,
                    error = ?error,
                    reentry = ?outcome.as_ref().map(|o| o.ladder.as_str()).ok(),
                    "恢复阶梯 1 重派失败：计数推满重入 escalate（阶梯 2 通知主 agent）"
                );
            }
        }
    }

    /// E3-2（D3 §3.2.6）：子代理运行中汇报接线——收口处把本轮新增消息
    /// （assistant 文本截断 + 工具调用摘要）经 SubagentEventEmitter::emit_event
    /// （subagent-event 通道，kind=progress）发射。
    ///
    /// 职责分离：**汇报 = 观测面，唤醒 = 终态面**——运行中汇报不写
    /// steering 队列（防 16 并发唤醒风暴）；wait_for_terminal 只认
    /// subagent-ended（名单外忽略，wait_subagents.rs:378-459），语义零
    /// 改变。progress 为 Delta 背压（不落库不阻塞 drive loop，events.rs:
    /// 51-55）——事件同时经本 run 事件桥广播（信封 runId = 本 run），
    /// 前端全局消费者按信封 sessionId（父会话）路由（subagentHandlers.ts
    /// :131-144）。失败仅告警（观测面不阻断收口）。
    ///
    /// 说明：引擎单次 produce 覆盖整个 run（轮级钩子需 session-loop 侧
    /// 扩展，超出本轮文件域），逐条 assistant 消息按消息序发射近似
    /// 「轮次递进」语义。
    async fn emit_subagent_progress(
        &self,
        cfg: &crate::subagent_spawner::SubagentRunConfig,
        bridge: &Arc<BufferedRunEventBridge>,
        messages: &[Arc<AgentMessage>],
    ) {
        if messages.is_empty() {
            return;
        }
        let Some(db) = self.local_db() else {
            return;
        };
        let emitter = SubagentEventEmitter::new(Arc::new(
            orchestrator::persist::LocalDbStore::new(db),
        ));
        let emit_ctx = SubagentEmitContext {
            session_id: cfg.parent_session_id.clone(),
            parent_run_id: String::new(),
        };
        let mut turn = 0u32;
        for message in messages.iter().filter(|m| m.role == AgentMessageRole::Assistant) {
            turn += 1;
            let truncated: String = message
                .text()
                .chars()
                .take(SUBAGENT_PROGRESS_TRUNCATE_CHARS)
                .collect();
            let tool_calls: Vec<&str> = message
                .blocks
                .iter()
                .filter_map(|block| match block {
                    AgentMessageBlock::ToolCall(call) => Some(call.tool_name.as_str()),
                    _ => None,
                })
                .collect();
            let info = SubagentEventInfo {
                subagent_id: cfg.subagent_id.clone(),
                subagent_run_id: cfg.subagent_run_id.clone(),
                kind: SubagentEventKind::Progress,
                payload: Some(serde_json::json!({
                    // 载荷形状兼容前端 applySubagentEventToMessages 投影面
                    // （message-delta + text 块），最小形态 = 透传文本块
                    "type": "message-delta",
                    "block": { "type": "text", "text": truncated },
                    "turn": turn,
                    "toolCalls": tool_calls,
                })),
            };
            match emitter.emit_event(&emit_ctx, &info).await {
                Ok(sequenced) => {
                    let envelope = AgentEventEnvelope::new(
                        sequenced.event,
                        Some(cfg.subagent_run_id.clone()),
                        Some(sequenced.sequence),
                    );
                    bridge.emit(&envelope);
                }
                Err(error) => {
                    tracing::warn!(
                        target: "subagent_spawner",
                        event = "emit_progress_failed",
                        subagent_run_id = %cfg.subagent_run_id,
                        error = %error,
                        "子代理运行中汇报发射失败（观测面，不阻断收口）"
                    );
                }
            }
        }
        bridge.flush();
    }

    /// 子代理生命周期服务（T-D-09：kill_all / resume_subagent 命令面
    /// 依赖；db 与 [orchestrator::lifecycle::ForceCancelSink]（本状态实现）
    /// 装配；LocalDb 不可用（测试替身 store）→ None）。审计 01 W1：
    /// kill_subagent 工具通道（[Self::kill_subagent_via_lifecycle]）生产
    /// 消费——T-D-12 陈旧 dead_code 豁免已删除（D4 A5/T7b）
    pub(crate) fn lifecycle_service(
        self: &Arc<Self>,
    ) -> Option<orchestrator::lifecycle::SubagentLifecycleService> {
        let db = self.local_db()?;
        // Arc 宽化：CoreRunState 实现 ForceCancelSink → trait object 引用
        // （先克隆具体类型再宽化——编译器对 Arc::clone 的 trait object
        // 目标推断不收敛，显式两步断开）
        let this: Arc<CoreRunState> = Arc::clone(self);
        let control: Arc<dyn orchestrator::lifecycle::ForceCancelSink> = this;
        Some(orchestrator::lifecycle::SubagentLifecycleService::new(
            Arc::new(db),
            control,
        ))
    }

    /// 最近快照代数（查询命令 snapshot.generation 数据源）
    pub fn snapshot_generation(&self) -> u64 {
        self.snapshot_generation.load(Ordering::SeqCst)
    }

    /// 快照保存失败标记（P16：查询命令 snapshot.lastError 数据源）
    pub fn snapshot_last_error(&self) -> Option<String> {
        self.snapshot_last_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 会话级序列号 base（T08.8：预热命中缓存；未预热按库内 max+1 懒计算，
    /// 不重置为 1）
    async fn base_sequence_for(&self, session_id: &str) -> u64 {
        if let Some(next) = self
            .next_sequences
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .copied()
        {
            return next;
        }
        let max = self
            .store
            .query_events(session_id, 0)
            .await
            .map(|events| events.iter().map(|e| e.sequence).max().unwrap_or(0))
            .unwrap_or(0);
        let next = max + 1;
        self.next_sequences
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.to_string(), next);
        next
    }

    /// T08.8：恢复结果注入——逐会话预热序列号（库内 max(sequence)+1，
    /// 审计事件已落库口径自然含之；MAX 语义幂等）
    pub async fn seed_sequences(&self, outcome: &RestoreOutcome) {
        let sequencer = SessionSequencer::new(self.store.clone());
        for session in &outcome.sessions {
            let max = self
                .store
                .query_events(&session.session_id, 0)
                .await
                .map(|events| events.iter().map(|e| e.sequence).max().unwrap_or(0))
                .unwrap_or(0);
            let next = max + 1;
            if let Err(error) = sequencer.seed(&session.session_id, next).await {
                tracing::warn!(
                    target: "restore",
                    session_id = %session.session_id,
                    error = %error,
                    "seed_sequence 失败（base_sequence_for 懒计算兜底）"
                );
            }
            // 预热缓存写入（锁仅覆盖短临界区，不跨 await 持有——AA-02 并发模型）
            self.next_sequences
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session.session_id.clone(), next);
        }
    }

    /// T08.6 启动接线：restore + seed + 立即快照（main.rs 在
    /// `app.manage(CoreRunState)` 之前 run_in_runtime 执行）
    ///
    /// 失败路径：restore 返回 Err → tracing error + 诊断记录
    /// （restore.state=failed），**不阻塞启动**——run 命令照常可用
    /// （事件序列锚点由 [Self::base_sequence_for] 懒计算兜底）。
    pub async fn run_restore(self: &Arc<Self>) -> Option<RestoreOutcome> {
        self.restore_started.store(true, Ordering::SeqCst);
        match RestoreManager::new()
            .restore(self.store.as_ref(), self.snapshots.as_ref())
            .await
        {
            Ok(outcome) => {
                // 1. 序列号预热（审计事件已落库口径，T08.8）
                self.seed_sequences(&outcome).await;
                // 2. 会话树注册表水合（快照会话 ∪ run 派生会话）
                self.sessions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .extend(outcome.sessions.clone());
                // 3. 门禁放行（必须在 seed 之后：新 run 的 base 从预热值续接）
                self.restore_ready.store(true, Ordering::SeqCst);
                // 4. 恢复成功后立即保存快照（restore.rs 文档：
                //    「After successful restore (full or incremental)」）
                self.save_snapshot_now().await;
                // 恢复结果入状态域（restore_status 数据源，F2 冻结形状）
                self.restore_failed.store(false, Ordering::SeqCst);
                let mode = match outcome.mode {
                    RestoreMode::FullReplay => "full-replay",
                    RestoreMode::SnapshotIncremental => "snapshot-incremental",
                };
                *self.restore_mode.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(mode.to_string());
                *self.restore_note.lock().unwrap_or_else(|e| e.into_inner()) =
                    outcome.snapshot_note.clone();
                *self.interrupted_count.lock().unwrap_or_else(|e| e.into_inner()) =
                    outcome.interrupted.len();
                *self.restore_last_sequence.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(outcome.last_sequence);
                // D3 §3.3：逐会话重建会话树 + 构造协调器 + 重排 pending
                // 通知（树先于 coordinator 插入——coordinator_for 从
                // session_trees 取树；from_session_record 失败 → 降级空树，
                // fail-open：阶梯 1/2/4 照常、阶梯 3 fork 结构化拒绝，
                // recovery.rs:1066-1070）
                for record in &outcome.sessions {
                    let tree = SessionTree::from_session_record(record.clone()).unwrap_or_else(|e| {
                        tracing::warn!(
                            target: "restore",
                            session_id = %record.session_id,
                            error = %e,
                            "会话树重建失败（降级空树：阶梯 1/2/4 照常，fork 结构化拒绝）"
                        );
                        SessionTree::new(&record.session_id)
                    });
                    self.session_trees
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(record.session_id.clone(), Arc::new(Mutex::new(tree)));
                    // coordinator 惰性构造（new 自动恢复预算/forks/通知/
                    // needs_user，recovery.rs:855-863）
                    if let Some(coord) = self.coordinator_for(&record.session_id) {
                        // pending 通知重排入队（同步 → spawn_blocking，F2-27）
                        match blocking_coordinator_call(
                            coord,
                            |c| c.restore_steering_notifications(),
                        )
                        .await
                        {
                            Ok(reinserted) => {
                                tracing::info!(
                                    target: "restore",
                                    session_id = %record.session_id,
                                    reinserted,
                                    "恢复阶梯 2 通知重排完成（pending 条目重新入队）"
                                );
                            }
                            Err(error) => {
                                tracing::warn!(
                                    target: "restore",
                                    session_id = %record.session_id,
                                    error = %error,
                                    "恢复阶梯 2 通知重排失败（重启后该通知仅落库，主 agent 可见性降级）"
                                );
                            }
                        }
                    }
                }
                // D6-③：重启恢复条目生成（interrupted → restore-<run_id>
                // steering 条目；主 run 自动续跑，子代理只通知不自动 fork）
                self.enqueue_restore_entries(&outcome).await;
                // D6 §3.2 spawn 点 1：恢复后对恢复会话 spawn watcher——
                // 恢复条目 / 定时器补发 / 通知重排需要消费方（每会话
                // 幂等持有；子代理会话不 spawn——无 watcher 拉起语义）
                for record in &outcome.sessions {
                    if !record.session_id.starts_with(SUBAGENT_SESSION_PREFIX) {
                        self.ensure_wake_watcher(&record.session_id);
                    }
                }
                tracing::info!(
                    target: "restore",
                    mode = ?outcome.mode,
                    interrupted = outcome.interrupted.len(),
                    last_sequence = outcome.last_sequence,
                    snapshot_generation = outcome.snapshot_generation,
                    "重启恢复完成"
                );
                Some(outcome)
            }
            Err(error) => {
                tracing::error!(
                    target: "restore",
                    error = %error,
                    "重启恢复失败（不阻塞启动，懒计算兜底）"
                );
                self.diagnostics
                    .record("restore", false, Some(error.to_string()));
                self.restore_failed.store(true, Ordering::SeqCst);
                *self.restore_note.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(error.to_string());
                // 门禁放行：run 命令照常可用（懒计算兜底序列锚点）
                self.restore_ready.store(true, Ordering::SeqCst);
                None
            }
        }
    }

    /// T08.6 触发点 A/B/C 共用：保存快照（generation 续接；P16 失败显式标记）
    ///
    /// T3.5 D5（F2-11）：互斥入口——三触发（终态收口 / 周期 loop / 退出
    /// 钩子）全部汇入本函数；tokio Mutex 守卫跨 await 持有（build 内 store
    /// 查询与落盘均在锁内），generation 读-改-写原子化：任意时刻至多一路
    /// 在写，杜绝同进程并发交叉写（R2 §4：修复前两路同读 G 同写 G+1 +
    /// tmp 同名交叉写可致快照损坏）。std Mutex 锁不跨 await 持有（AA-02），
    /// 快照互斥必须用 tokio Mutex。
    pub async fn save_snapshot_now(&self) {
        let _guard = self.snapshot_mutex.lock().await;
        match self.build_and_save_snapshot().await {
            Ok(generation) => {
                self.snapshot_generation.store(generation, Ordering::SeqCst);
                *self.snapshot_last_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
                *self.snapshot_written_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or_default(),
                );
                tracing::info!(target: "restore", generation, "快照已保存");
            }
            Err(error) => {
                tracing::error!(target: "restore", error = %error, "快照保存失败（P16 显式标记）");
                *self.snapshot_last_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
            }
        }
    }

    /// 组装并保存快照（内容：会话树注册表 + 全部 runs + 逐会话 pending +
    /// last_sequence = 全会话事件 max + 逐会话锚点；快照只是近似一致，
    /// 增量重放以锚点补足）。
    ///
    /// PERSIST-02 P1-2 门禁：restore 未完成或失败时**禁止覆盖既有快照
    /// 文件**——注册表仅在 run_restore 成功路径水合（sessions.extend），
    /// 未水合时本函数会保存「0 会话 + 全部 runs + last_sequence=0」的
    /// 半水合快照覆盖主快照，下次恢复全走派生路径（branches 空、
    /// meta None），会话树分支历史永久丢失。restore 成功后立即保存
    /// （run_restore 先置 restore_ready 再调本函数）不受影响。
    async fn build_and_save_snapshot(&self) -> Result<u64, String> {
        if !self.restore_ready.load(Ordering::SeqCst) {
            return Err("restore 未完成，跳过快照保存（防半水合快照覆盖主快照）".to_string());
        }
        if self.restore_failed.load(Ordering::SeqCst) {
            return Err("restore 失败，跳过快照保存（保留既有快照文件）".to_string());
        }
        let runs = self.store.query_runs().await.map_err(|e| e.to_string())?;
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let mut pending = Vec::new();
        let mut last_sequence = 0u64;
        // PERSIST-02 P1-1：逐会话锚点（session_id → 该会话事件 max）。
        // 事件序列为会话内独立，恢复按会话自身锚点取增量，全局 max 作
        // 会话级 base 会永久跳过落后会话的快照后事件（多会话粘性错误）。
        let mut session_last_sequence: HashMap<String, u64> = HashMap::new();
        for session in &sessions {
            let events = self
                .store
                .query_events(&session.session_id, 0)
                .await
                .map_err(|e| e.to_string())?;
            let session_max = events.iter().map(|e| e.sequence).max().unwrap_or(0);
            last_sequence = last_sequence.max(session_max);
            session_last_sequence.insert(session.session_id.clone(), session_max);
            pending.extend(
                self.store
                    .load_pending_inputs(&session.session_id)
                    .await
                    .map_err(|e| e.to_string())?,
            );
        }
        let generation = self.snapshot_generation.load(Ordering::SeqCst) + 1;
        let snapshot = StateSnapshot::build(
            generation,
            last_sequence,
            sessions,
            runs,
            pending,
            session_last_sequence,
        );
        self.snapshots
            .save_snapshot(&snapshot)
            .map_err(|e| e.to_string())?;
        Ok(generation)
    }

    /// T08.6 触发点 B：周期快照（默认 60s，`snapshot_interval_ms` 可配；
    /// 仅在存在活动 run 时保存，避免空转写）。幂等（重复调用不重复启动）。
    pub fn spawn_snapshot_loop(self: &Arc<Self>) {
        if self.snapshot_loop_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let interval_ms = *this
                .snapshot_interval_ms
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let mut interval = tokio::time::interval(Duration::from_millis(interval_ms.max(1_000)));
            interval.tick().await; // 首拍立即触发（interval 首拍即完成），跳过
            loop {
                interval.tick().await;
                let has_active = this
                    .active_runs
                    .lock()
                    .map(|runs| !runs.is_empty())
                    .unwrap_or(false);
                if has_active {
                    this.save_snapshot_now().await;
                }
            }
        });
    }

    /// T08.6 触发点 C：优雅退出钩子（main.rs `RunEvent::Exit` 调用；
    /// 阻塞语义——同步事件回调内完成快照保存）
    pub fn save_snapshot_blocking(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tauri::async_runtime::block_on(async move { this.save_snapshot_now().await });
    }
}

// ── T-D-13：子代理 run 启动器（Weak 引用切断 CoreRunState 类型递归）──

/// 子代理 run 启动器生产实现：经 [crate::subagent_spawner::SubagentRunLauncher]
/// trait object 调用 [run_task_impl]（core_run_task 同通道）——spawner 在
/// CoreRunState 内（engine 注入面），run 启动回调 CoreRunState，Weak 引用
/// 避免 Arc 循环强引用（进程级单例，Weak 升级失败为启动器未装配兜底）。
#[derive(Debug)]
pub(crate) struct CoreRunStateLauncher {
    /// 状态弱引用（finalize 装配时注入；主进程存活期恒可升级）
    state: std::sync::Weak<CoreRunState>,
}

#[async_trait::async_trait]
impl crate::subagent_spawner::SubagentRunLauncher for CoreRunStateLauncher {
    async fn launch(
        &self,
        options: RunTaskOptions,
    ) -> Result<RunTaskResponse, CoreError> {
        let state = self.state.upgrade().ok_or_else(|| {
            CoreError::internal("子代理 run 启动失败：CoreRunState 已释放（启动器弱引用失效）")
        })?;
        run_task_impl(state, options).await
    }
}

// ── T-D-09/T-D-13：ForceCancelSink 接线（kill_all 的引擎侧实现）────

/// L3 强停投递（[orchestrator::lifecycle::ForceCancelSink]）：按
/// subagent_run_id 定位活动 run 的控制总线，投递 L3 `request_force_cancel`
/// （reason 携带 `subagent_force_cancel:<run_id>` 可观测标识）；无该 run
/// 的运行实例（已终态 / 重启后未恢复）→ false（调用方按未终态汇总）。
impl orchestrator::lifecycle::ForceCancelSink for CoreRunState {
    fn request_force_cancel(&self, subagent_run_id: &str, reason: &str) -> bool {
        let active = self
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(run) = active.get(subagent_run_id) else {
            return false;
        };
        // std Mutex 不跨 await 持有：投递为同步调用，锁在语句内释放
        run.control_bus
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .request_subagent_force_cancel(subagent_run_id, Some(reason));
        true
    }
}

// ── 审计 01 W1：任务连续性三通道生产接线（kill_subagent / send_message
//    工具面）────────────────────────────────────────────────────────

/// 任务连续性通道的状态适配器：以 Weak 引用切断「CoreRunState → 引擎
/// → ContinuityChannelBoard → CoreRunState」强引用环（CoreRunStateLauncher
/// 先例 :4011 同款——引擎在 CoreRunState 内，板卡在引擎内，强引用即
/// 环）。进程内 CoreRunState 恒存活（main.rs app.manage），upgrade 失败
/// 仅为防御面（结构化错误上抛，不 panic）。
///
/// 四契约合一（[ControlBusResolver] / [SubagentKillChannel] /
/// [SubagentInjectChannel] / [MainAgentMessageChannel]），经
/// [CoreRunState::finalize_continuity_channels] 绑定到引擎板卡。
pub(crate) struct ContinuityStateAdapter {
    /// 本状态弱引用（恒存活；upgrade 失败 → 结构化错误）
    state: std::sync::Weak<CoreRunState>,
}

impl std::fmt::Debug for ContinuityStateAdapter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContinuityStateAdapter").finish_non_exhaustive()
    }
}

impl CoreRunState {
    /// 按子代理 id 解析活动 run 的控制总线（send_message target=subagent
    /// 与 wait 期间 inject 共用的解析器真源）。
    ///
    /// active_runs 扫描（子代理配置 subagent_id 匹配）：活动集受
    /// 16/16/1 守卫约束（主 run 1 + 子代理 ≤16），O(n) 平凡——不引入
    /// 第二份 subagent_id → run_id 映射表（id 已在 ActiveRun.subagent
    /// 装配配置内，扫描即真源）。
    fn control_bus_for_subagent(&self, subagent_id: &str) -> Option<Arc<Mutex<ControlBus>>> {
        let active = self.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        active
            .values()
            .find(|run| {
                run.subagent
                    .as_ref()
                    .map(|cfg| cfg.subagent_id.as_str())
                    == Some(subagent_id)
            })
            .map(|run| Arc::clone(&run.control_bus))
    }

    /// 会话主 agent run 的控制总线（send_message target=self 的 followUp/
    /// steer 环目标）：活动 run 中 subagent=None（普通 run）且会话匹配。
    /// 会话内单活动 run 串行守卫下至多命中一条；无匹配（run 已收口）→
    /// None，调用方转 PendingMessageQueue 兜底。
    fn main_run_bus_for_session(&self, session_id: &str) -> Option<Arc<Mutex<ControlBus>>> {
        let active = self.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        active
            .values()
            .find(|run| run.subagent.is_none() && run.session_id == session_id)
            .map(|run| Arc::clone(&run.control_bus))
    }

    /// kill_subagent 终止通道真实现：经 SubagentLifecycleService（LocalDb
    /// 下转 + 本状态 ForceCancelSink）投递 L3 强停 + 行归一 failed；
    /// 同步 SQLite 段经 spawn_blocking 包裹（F2-27，命令面同步调用面
    /// 不落在 tokio worker 上——D4 §3.9 全表）。
    async fn kill_subagent_via_lifecycle(
        self: &Arc<Self>,
        session_id: &str,
        subagent_id: &str,
        reason: &str,
    ) -> Result<KillSubagentToolResult, String> {
        let service = self
            .lifecycle_service()
            .ok_or_else(|| "kill_subagent 未接线：LocalDb 不可用（生命周期服务未装配）".to_string())?;
        let (sid, aid, r) = (
            session_id.to_string(),
            subagent_id.to_string(),
            reason.to_string(),
        );
        let result = tokio::task::spawn_blocking(move || service.kill_subagent(&sid, &aid, &r))
            .await
            .map_err(|e| format!("kill_subagent 阻塞任务失败：{e}"))?
            .map_err(|e| e.to_string())?;
        Ok(KillSubagentToolResult {
            subagent_id: result.subagent_id,
            subagent_run_id: Some(result.subagent_run_id),
            outcome: match result.outcome {
                "killed" => KillOutcomeKind::Killed,
                _ => KillOutcomeKind::AlreadyTerminal,
            },
            force_cancel_delivered: result.force_cancel_delivered,
        })
    }

    /// send_message 子代理注入真实现：定位目标 run 控制总线 →
    /// `request_subagent_inject`（L1 steer 环，reason=`subagent_inject:<id>`，
    /// 不打断子代理流——与 wait 期间 inject 同通道同语义）；目标不可达
    /// → 结构化失败（不静默、不 panic）。
    async fn inject_to_subagent(
        &self,
        subagent_id: &str,
        message: &str,
    ) -> Result<(), String> {
        let Some(bus) = self.control_bus_for_subagent(subagent_id) else {
            return Err(format!(
                "目标子代理 {subagent_id} 的 run 控制总线不可达（无运行实例）"
            ));
        };
        // std Mutex 不跨 await 持有：注入为同步调用，锁在语句内释放
        bus.lock()
            .unwrap_or_else(|e| e.into_inner())
            .request_subagent_inject(subagent_id, message, Some("send_message_tool"));
        tracing::info!(
            target: "run",
            subagent_id,
            "send_message(target=subagent) 已送达目标 run 的 L1 steer 环"
        );
        Ok(())
    }

    /// send_message 主 agent 消息真实现（会话留档 + 入队一体完成）：
    ///
    /// 1. 构造 user 角色文本消息，metadata `{source:"main-agent"}`（与
    ///    用户消息区分——用户消息无 source 字段）；**不标记 user_touched**
    ///    （主 agent 自发消息不算用户交互，收口不因此抑制 idle 续 run）；
    /// 2. 当前 run 存活 → 经主 run 自己 ControlBus 入环：FollowUp →
    ///    `request_follow_up`（仅 idle promote 消费，不打断当前 run）；
    ///    Steer → `request_steer`（下一安全点注入，当前 run 继续）；
    /// 3. run 已收口（工具调用在收口后被重放等边角）→ PendingMessageQueue
    ///    入队 steering 条目（group_id=`main-agent-msg`，下一 run
    ///    decide_idle_resume 队列源消费——消息仍带 `kind:"steering"`
    ///    标记，来源标记以队列条目承载）。
    ///
    /// 会话留档语义：消息随 run 对话进入事件流与会话历史（运行中入环的
    /// 消息即 run 对话的一部分，收口原子替换进 SessionHistoryCache）。
    async fn deliver_main_agent_message(
        &self,
        session_id: &str,
        message: &str,
        ring: MainMessageRing,
    ) -> Result<String, String> {
        // 1. 构造留档消息（id 唯一、metadata 来源标记）
        let mut injected = crate::engine::user_message(message, None);
        injected.id = crate::engine::new_message_id("main-agent-msg");
        injected.metadata = Some(serde_json::json!({ "source": "main-agent" }));
        let message_id = injected.id.clone();
        // 2. 当前主 run 存活 → 经其控制总线入环（不打断当前 run）
        if let Some(bus) = self.main_run_bus_for_session(session_id) {
            let mut bus = bus.lock().unwrap_or_else(|e| e.into_inner());
            match ring {
                MainMessageRing::Steer => {
                    bus.request_steer(injected, Some("send_message_tool".to_string()), Some("main-agent".to_string()));
                }
                MainMessageRing::FollowUp => {
                    bus.request_follow_up(injected, Some("send_message_tool".to_string()), Some("main-agent".to_string()));
                }
            }
            tracing::info!(
                target: "run",
                session_id,
                ring = ring.as_str(),
                "send_message(target=self) 已入主 run 控制总线（会话留档 + 环注入）"
            );
            return Ok(message_id);
        }
        // 3. run 已收口 → PendingMessageQueue 兜底（下一 run 队列源消费）
        let entry = orchestrator::steering_queue::SteeringInputEntry {
            id: message_id.clone(),
            text: message.to_string(),
            attachments: Vec::new(),
            enqueued_at: now_ms_internal(),
            group_id: Some("main-agent-msg".to_string()),
            is_steering: true,
        };
        self.pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace_or_enqueue(entry);
        tracing::info!(
            target: "run",
            session_id,
            "send_message(target=self) 已入队 PendingMessageQueue（run 已收口兜底）"
        );
        Ok(message_id)
    }

    /// 审计 01 W1：任务连续性三通道生产装配（main.rs 在 Arc 构造完成后
    /// 调用，与 [Self::finalize_subagent_spawner] 同批）——把本状态的
    /// 四契约实现（ControlBusResolver / 三通道）经 [ContinuityStateAdapter]
    /// 绑定进引擎 [crate::engine::ContinuityChannelBoard]：
    ///
    /// - WaitChannel 的 inject 面（wait_subagents 运行中注入）从生产
    ///   NoopControlBusResolver 升级为真实解析（活动 run 注册表）；
    /// - kill_subagent / send_message 两工具从「通道未绑定错误」升级为
    ///   生产可用（三决策闭环工具侧闭合）。
    pub(crate) fn finalize_continuity_channels(self: &Arc<Self>) {
        let adapter = Arc::new(ContinuityStateAdapter {
            state: Arc::downgrade(self),
        });
        let board = self.engine.continuity();
        board.bind_control_bus(Arc::clone(&adapter) as Arc<dyn ControlBusResolver>);
        board.bind_kill(Arc::clone(&adapter) as Arc<dyn SubagentKillChannel>);
        board.bind_inject(Arc::clone(&adapter) as Arc<dyn SubagentInjectChannel>);
        board.bind_self_message(adapter as Arc<dyn MainAgentMessageChannel>);
        tracing::info!(
            target: "engine",
            "任务连续性三通道生产装配完成（kill_subagent / send_message 工具已接线；WaitChannel 控制总线解析器已升级）"
        );
    }
}

impl ControlBusResolver for ContinuityStateAdapter {
    fn control_bus(&self, subagent_id: &str) -> Option<Arc<Mutex<ControlBus>>> {
        self.state.upgrade()?.control_bus_for_subagent(subagent_id)
    }
}

#[async_trait::async_trait]
impl SubagentKillChannel for ContinuityStateAdapter {
    async fn kill_subagent(
        &self,
        session_id: &str,
        subagent_id: &str,
        reason: &str,
    ) -> Result<KillSubagentToolResult, String> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| "CoreRunState 已释放（进程内恒存活，防御面）".to_string())?;
        state
            .kill_subagent_via_lifecycle(session_id, subagent_id, reason)
            .await
    }
}

#[async_trait::async_trait]
impl SubagentInjectChannel for ContinuityStateAdapter {
    async fn inject(&self, subagent_id: &str, message: &str) -> Result<(), String> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| "CoreRunState 已释放（进程内恒存活，防御面）".to_string())?;
        state.inject_to_subagent(subagent_id, message).await
    }
}

#[async_trait::async_trait]
impl MainAgentMessageChannel for ContinuityStateAdapter {
    async fn deliver_self(
        &self,
        session_id: &str,
        message: &str,
        ring: MainMessageRing,
    ) -> Result<String, String> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| "CoreRunState 已释放（进程内恒存活，防御面）".to_string())?;
        state
            .deliver_main_agent_message(session_id, message, ring)
            .await
    }
}

// ── T-CF-11：会话级 idle 待命 + 自动续 run（G7 / REQ-C04 验收 1/2）──

/// T-CF-11：生产续 run 拉起器构造（CoreRunState::new 预装配；测试经
/// set_resume_launcher 覆盖替身）。
///
/// 实现经 [ResumeLauncher] trait object（`Pin<Box<dyn Future + Send>>`
/// 叶子类型）间接引用 [run_task_impl]：drive_run_loop 与 run_task_impl
/// 相互包含 opaque future 会让 auto-trait（Send）检查无法终止（Rust
/// 限制："fetching the hidden types of an opaque inside of the defining
/// scope is not supported"）——trait object 断链后检查可终止。
fn production_resume_launcher() -> ResumeLauncher {
    let launcher: ResumeLauncher = Arc::new(|state, session_id, mode, messages| {
        let state = Arc::clone(state);
        let session_id = session_id.to_string();
        let mode = mode.to_string();
        Box::pin(async move {
            idle_resume::spawn_idle_resume_run(state, session_id, &mode, messages).await;
        })
    });
    launcher
}

//
// 独立子模块（文件内）：drive_run_loop 与 run_task_impl 相互引用 opaque
// future（drive_run_loop 收口经 spawn_idle_resume_run 拉起新 run →
// run_task_impl → spawn(drive_run_loop)），同模块内递归 async fn 的
// auto-trait（Send）检查不被 Rust 支持（"fetching the hidden types of an
// opaque inside of the defining scope"）——跨模块定义后检查可终止。
mod idle_resume {
    use super::*;
    use orchestrator::steering_queue::SteeringInputEntry;

    /// 续 run 连续空转护栏上限（连续 N 次续 run 均无 AI 产出 → 停止续 run，
    /// 防空转风暴；默认 3 次）
    pub(super) const IDLE_RESUME_MAX_EMPTY_ROUNDS: u32 = 3;

    /// T-CF-11：唤醒源非空判定器（TimerRegistry 活跃 / SchedulerRegistry
    /// enabled 的判定封装；async 谓词——list_active 为 async 调用）。
    ///
    /// 生产接线：TimerRegistry 非空判定在 [CoreRunState::new] 经
    /// [EngineHandle::timer_registry] 的 list_active 封装注入；SchedulerRegistry
    /// 非空判定在 [CoreRunState::new] 经 [EngineHandle::scheduler_registry]
    /// 的 has_active 封装注入（30 方案 P7；None = 装配降级，Cron 不参与
    /// 续 run 判定，行为与接线前一致）。
    pub(crate) type WakeSourceCheck =
        Arc<dyn Fn() -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

/// T-CF-11：idle 续 run 拉起器（async；生产 = 经 [spawn_idle_resume_run]
/// 复用 run 装配拉起新 run；测试 = 注入替身断言判定与注入载荷）。
///
/// mode：续 run 类型（idle-resume / recovery-retry / content-resume /
/// goal-continue）——D2 §3.4 拉起器 mode 参数化（自动恢复类型可观测，
/// G-6）。
pub(crate) type ResumeLauncher = Arc<
    dyn Fn(
            &Arc<CoreRunState>,
            &str,
            &str,
            Vec<AgentMessage>,
        ) -> Pin<Box<dyn Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

/// 续 run 判定结果（mode + 注入消息；mode 供拉起器区分自动恢复类型）
pub(crate) struct ResumeDecision {
    /// 续 run 类型（idle-resume / recovery-retry / content-resume /
    /// goal-continue）
    pub mode: &'static str,
    /// 注入消息（队列条目批量聚合 / goal 前缀 / 续写模板）
    pub inject: Vec<AgentMessage>,
}

/// T-CF-11：idle 待命续 run 判定（drive_run_loop 收口处调用）
///
/// 续 run 条件（任一满足，02-CF 方案 T-CF-11 第 1 点）：
/// - [PendingMessageQueue] 非空（跨 run steering 条目：子代理完成、定时器
///   到期、Cron 触发、watchdog 兜底通知——条目生成侧已按 §4.8 模板拼入
///   wakeup_summary 摘要文本，注入即条目原文）；
/// - TimerRegistry 存在活跃定时器（timer_has_active 判定器非空）；
/// - enabled Cron 任务（cron_has_enabled 判定器非空）。
///
/// 不续 run（硬条件与用户语义）：
/// - abort_signal 触发（force_cancel，双保险）/ 用户消息到达后的正常收场
///   （本 run 有用户 L1 交互，user_touched）——对全部路径生效；
/// - reason = Stopped / Aborted（用户停止）永不续；MaxTurns 保守不续；
/// - error 收场（D2 分支）：非 retryable / 熔断触发 / 预算超限 → 不续；
/// - Stop 分支四源全空（队列 / 定时器 / Cron / goal_pending）→ AI 休眠
///   待用户；续 run 连续 N 次（默认 3 次）均无 AI 产出 → 停止续 run。
///
/// 三路分派（D2 §3.1 判定顺序，00 总纲 §6:140 契约）：
/// - Stop → ① E1 续写子分支（部分保留断流瞬态标注）→ ② 三源 + D5 第四源
///   goal_pending 判定；
/// - Error → retryable 分支（D2：熔断 / 预算 / 退避 / 恢复条目入队）；
/// - Stopped / Aborted / MaxTurns → 永不续。
///
/// 返回：None = 不续 run；Some(decision) = 续 run（mode + 注入消息）。
pub(crate) async fn decide_idle_resume(
    state: &CoreRunState,
    active: &ActiveRun,
    reason: AgentEndReason,
    had_ai_output: bool,
    signals: &ResumeSignals,
) -> Option<ResumeDecision> {
    // 1. 硬条件（保持，扩语义）：abort 永不续（双保险）；对 Stop 与
    //    Error 两路径均生效（01 敲定 §4 红线 2：user_touched 永不自动续）
    if active.abort_signal.is_aborted() {
        return None;
    }
    if active.user_touched.load(Ordering::SeqCst) {
        return None;
    }
    // D6 §8 决策 1：会话级 user_stopped 标记（跨 run 语义——用户显式
    // 停止后 watcher 与收口判定共享同一判停，直到用户新 run 清除；
    // 兜底 L2 协作停止 + error 收场的竞态：run 级 user_touched 在 L2
    // 路径不置位，会话级标记覆盖该窗口）
    if state.is_user_stopped(&active.session_id) {
        return None;
    }
    match reason {
        // ── 正常收场：E1 续写子分支 + 三源 + D5 goal_pending 第四源 ──
        AgentEndReason::Stop => {
            // ── E1 续写子分支（内容级续接，扩展定夺 E0 R4）──
            // 条件（E1 §2.2 全满足）：最后一条 assistant 消息为纯文本、
            // metadata.providerErrorKind ∈ 瞬态四类且 providerErrorRetryable
            // != false（D7 流中断标注，与 D1 熔断 S2 计数同数据源）、
            // 熔断未触发、续写开关开启、content-resume 预算内（上限 2）。
            if let Some(decision) = content_resume_decision(state, active, signals).await {
                return Some(decision);
            }
            // ── 四源判定：队列（首要唤醒源）/ 定时器 / Cron / goal_pending ──
            let queue_pending = {
                let queue = state
                    .pending_queue
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                queue.has_pending()
            };
            let timer_check = state
                .timer_has_active
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let timer_active = if !queue_pending {
                match timer_check {
                    Some(check) => check().await,
                    None => false,
                }
            } else {
                false
            };
            let cron_check = state
                .cron_has_enabled
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let cron_enabled = if !queue_pending && !timer_active {
                match cron_check {
                    Some(check) => check().await,
                    None => false,
                }
            } else {
                false
            };
            // D5 §3.6：goal_pending 第四源（与三源并存评估——队列条目 +
            // goal_pending 并存时注入拼接；仅三源全空时 goal 独立命中）
            let goal_state = state.load_goal_state(&active.session_id).await;
            let goal_pending = goal_state
                .as_ref()
                .map(|goal| goal.goal_pending(reason))
                .unwrap_or(false);
            if !(queue_pending || timer_active || cron_enabled || goal_pending) {
                // 四源全空：run 正常收场，AI 休眠待用户（硬条件）
                return None;
            }
            // D6-⑤（W2）：空注入轮判定 = 唤醒源 ∈ {timer, cron} && 无队列
            // 条目 && 无 goal 注入（三者同时成立 → 注入文本为空）——定时器
            // /Cron 待命是正常态，不计 streak（裁决 #21）；goal 续轮（D5
            // 四源命中）与 error 续 run（D2 error 分支）不受本判定影响，
            // 走各自独立计数路径
            let empty_inject_round = (timer_active || cron_enabled) && !queue_pending && !goal_pending;
            // 空转护栏（仅续 run 路径计数）：本 run 有 AI 产出 → 清零；
            // 否则 +1，连续 N 次（默认 3 次）无产出 → 停止续 run 并记日志。
            // W2：error 续 run 不计 streak（早退于本护栏）；goal 续轮计入
            // 空转且按 stalled 独立计数（D5 §3.4 双路径并存）
            {
                let mut streak = state
                    .resume_empty_streak
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let entry = streak.entry(active.session_id.clone()).or_insert(0);
                if had_ai_output {
                    *entry = 0;
                } else if empty_inject_round {
                    // 定时器/Cron 空注入轮不计 streak（不增不减，保持原值
                    // ——有产出轮自会清零，空注入轮不为待命代劳清零或消耗
                    // 计数，D6 §8 决策 7）
                } else {
                    *entry += 1;
                    if *entry > IDLE_RESUME_MAX_EMPTY_ROUNDS {
                        tracing::info!(
                            target: "run",
                            session_id = %active.session_id,
                            consecutive_empty = *entry,
                            limit = IDLE_RESUME_MAX_EMPTY_ROUNDS,
                            "idle 续 run 停止：连续 N 次无 AI 产出（防空转风暴）"
                        );
                        return None;
                    }
                }
            }
            // 注入拼接（D5 §3.6：队列条目在前，goal 前缀拼接其后——一条
            // 消息；仅 goal_pending → 纯前缀；仅三源 → 现状语义）
            let goal_text: Option<String> = if goal_pending {
                let next_steps = state.read_summary_next_steps(&active.session_id).await;
                goal_state
                    .as_ref()
                    .map(|goal| build_goal_continuation_prompt(goal, &next_steps))
            } else {
                None
            };
            // D5 §3.9：goal-continuation-decided（命中 goal_pending、注入
            // 拼接处发射；envelope 通道）
            if goal_pending {
                emit_goal_continuation_decided(active, &goal_state, goal_text.clone()).await;
            }
            let inject = if queue_pending {
                let mut queue = state
                    .pending_queue
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let drained = drain_pending_to_inject_messages(&mut queue, &active.session_id);
                match (drained.into_iter().next(), goal_text) {
                    (Some(mut message), Some(text)) => {
                        message.blocks.push(AgentMessageBlock::Text { text });
                        vec![message]
                    }
                    (Some(message), None) => vec![message],
                    (None, Some(text)) => vec![goal_continue_message(&active.session_id, text)],
                    (None, None) => Vec::new(),
                }
            } else if let Some(text) = goal_text {
                vec![goal_continue_message(&active.session_id, text)]
            } else {
                Vec::new()
            };
            let mode = if goal_pending {
                "goal-continue"
            } else {
                "idle-resume"
            };
            Some(ResumeDecision { mode, inject })
        }
        // ── 主 run error 收场：D2 retryable 分支 ──
        AgentEndReason::Error => {
            // 3a. 数据面：无结构化错误 / 非 retryable → 不续
            let Some(pe) = signals.provider_error.as_ref() else {
                return None;
            };
            if !pe.retryable {
                return None;
            }
            // 3b. 熔断（D1 is_tripped）→ 不续
            if state.circuit_breaker_is_tripped(&active.session_id).await {
                return None;
            }
            // 3c/3d. 任务文本 + 指纹（裁决 #8：source = "error-retry"）
            let fp = fingerprint_with_source("main", &signals.task_text, WAKE_SOURCE_ERROR_RETRY);
            // 3e. 预算消费（RecoveryBudget 纯函数复用；超限 → denied 事件
            //     + 不续）
            let attempt = match state
                .consume_resume_episode(
                    &active.session_id,
                    &fp,
                    RECOVER_MAX_EPISODES_KEY,
                    RecoveryBudget::default_limit(),
                )
                .await
            {
                EpisodeConsume::Consumed(attempt) => attempt,
                EpisodeConsume::Denied { count, max } => {
                    emit_recovery_budget_denied(active, &fp, &active.session_id, count, max)
                        .await;
                    return None;
                }
            };
            // 3f. 跨 run 退避（镜像 recovery.rs 常量；C4 注入点测试驱动）
            //     + 退避期 abort 复查（醒来不续，对齐 D1 abort 竞速语义）
            let delay = state.backoff_delay_for(attempt);
            state.sleep_resume_backoff(delay).await;
            if active.abort_signal.is_aborted() {
                return None;
            }
            // 3g. 恢复条目入队 → drain 注入 → 拉起；注入文本最小化
            //     「继续任务」（约束 C：kind/retries 走 provider-diagnostic
            //     事件 + 临时通知，不进对话、不给 AI）
            let now = now_ms_internal();
            let entry = SteeringInputEntry {
                id: format!("recovery-main-{}-{now}", active.run_id),
                text: MAIN_RESUME_INJECT_TEXT.to_string(),
                attachments: Vec::new(),
                enqueued_at: now,
                group_id: Some(format!("{RECOVER_GROUP_PREFIX}{}", active.run_id)),
                is_steering: true,
            };
            let mut queue = state
                .pending_queue
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            queue.replace_or_enqueue(entry);
            let inject = drain_pending_to_inject_messages(&mut queue, &active.session_id);
            Some(ResumeDecision {
                mode: "recovery-retry",
                inject,
            })
        }
        // ── 用户停止 / 其它：永不续（Stopped/Aborted/MaxTurns）──
        _ => None,
    }
}

/// E1 续写子分支判定（部分保留断流 → 内容级续写 run）。全部条件满足
/// 才触发（E1 §2.2 T1-T8）；预算超限 / 条件不满足 → None（半截保留交
/// 用户，不触发任何自动动作）。
async fn content_resume_decision(
    state: &CoreRunState,
    active: &ActiveRun,
    signals: &ResumeSignals,
) -> Option<ResumeDecision> {
    let last = signals.last_assistant.as_ref()?;
    // T3：纯文本消息（无 tool_calls 且文本非空——工具调用已提交不续写）
    if !last.is_plain_text {
        return None;
    }
    // T2：瞬态四类标注 + providerErrorRetryable != false（D7 标注；
    // 与 D1 熔断 S2 计数同数据源）
    let kind = last.kind?;
    if !is_transient_kind(kind) {
        return None;
    }
    if last.retryable == Some(false) {
        return None;
    }
    // T7：续写开关键（默认开启）
    if !state.content_resume_enabled(&active.session_id).await {
        return None;
    }
    // T5：熔断闸（续写是自动动作，受熔断闸约束）
    if state.circuit_breaker_is_tripped(&active.session_id).await {
        return None;
    }
    // T6：续写预算（独立指纹域 content-resume，上限 content_resume_max
    // 默认 2——比 error-retry 的 3 更紧；域互斥不挪用）
    let fp = fingerprint_with_source("main", &signals.task_text, WAKE_SOURCE_CONTENT_RESUME);
    let attempt = match state
        .consume_resume_episode(
            &active.session_id,
            &fp,
            CONTENT_RESUME_MAX_KEY,
            CONTENT_RESUME_MAX_DEFAULT,
        )
        .await
    {
        EpisodeConsume::Consumed(attempt) => attempt,
        EpisodeConsume::Denied { count, max } => {
            emit_recovery_budget_denied(active, &fp, &active.session_id, count, max).await;
            return None;
        }
    };
    // 退避 + abort 复查（对齐 error 分支 3f：预算在退避前消费）
    let delay = state.backoff_delay_for(attempt);
    state.sleep_resume_backoff(delay).await;
    if active.abort_signal.is_aborted() {
        return None;
    }
    // 注入锁定模板（E1 §3.2：测试断言绑定）；history 经 SessionHistoryCache
    // 天然含已产出前缀，不重复注入（前缀不变性，约束 B）
    let now = now_ms_internal();
    let text = format!(
        "上一轮生成中断({}),请从断点继续完成,不要重复已输出的内容",
        resume_kind_label(kind)
    );
    let entry = SteeringInputEntry {
        id: format!("recovery-main-{}-{now}", active.run_id),
        text,
        attachments: Vec::new(),
        enqueued_at: now,
        group_id: Some(format!("{RECOVER_GROUP_PREFIX}{}", active.run_id)),
        is_steering: true,
    };
    let mut queue = state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    queue.replace_or_enqueue(entry);
    let inject = drain_pending_to_inject_messages(&mut queue, &active.session_id);
    Some(ResumeDecision {
        mode: "content-resume",
        inject,
    })
}

/// D5 §3.7：goal 续轮注入消息（user 角色，metadata {kind:"goal-continue"}）
fn goal_continue_message(_session_id: &str, text: String) -> AgentMessage {
    AgentMessage {
        id: crate::engine::new_message_id("goal-continue"),
        role: AgentMessageRole::User,
        created_at: crate::engine::now_iso_utc(),
        blocks: vec![AgentMessageBlock::Text { text }],
        metadata: Some(serde_json::json!({ "kind": "goal-continue" })),
        client_message_id: None,
        content: None,
    }
}

/// D5 §3.9：goal-continuation-decided 发射（命中 goal_pending、注入拼接
/// 处；载荷对齐 TS GoalContinuationDecision：action/reason/prompt/
/// progressSignature/detail）
async fn emit_goal_continuation_decided(
    active: &ActiveRun,
    goal_state: &Option<GoalState>,
    prompt: Option<String>,
) {
    let event = AgentEvent::GoalContinuationDecided {
        action: "continue".to_string(),
        reason: "needs-continuation".to_string(),
        prompt,
        progress_signature: goal_state
            .as_ref()
            .and_then(|goal| goal.progress_signature.clone()),
        detail: None,
    };
    emit_envelope_event(&active.queue, &active.bridge, &active.run_id, &active.session_id, event)
        .await;
}

/// D2 §3.4 + E1 §3.4：恢复预算消费结果
pub(crate) enum EpisodeConsume {
    /// 消费成功（本次消费后的预算计数；跨 run 退避 attempt 输入）
    Consumed(u32),
    /// 预算耗尽（recovery-budget-denied 留痕载荷）
    Denied { count: u32, max: u32 },
}

/// D2 §3.4（W6 双发射方）：主 run 侧预算耗尽留痕（subagentRunId=None）
/// + denied 月度统计（recovery.rs:972-973）
async fn emit_recovery_budget_denied(
    active: &ActiveRun,
    fp: &str,
    session_id: &str,
    count: u32,
    max: u32,
) {
    let event = AgentEvent::RecoveryBudgetDenied {
        session_id: session_id.to_string(),
        subagent_run_id: None,
        fingerprint: fp.to_string(),
        count,
        max,
    };
    emit_envelope_event(&active.queue, &active.bridge, &active.run_id, session_id, event).await;
    conex_types::denied_stats::global_denied_stats().record_recovery_budget_denied();
}

/// D1 §3.2.2（C5）：熔断触发边沿观测事件（[Self::update_provider_fail_
/// streak] 返回 true = 本次更新跨过阈值时发射）。双事件仅观测面——
/// 不注入对话、不给 AI，UI 横幅呈现（用户约束 C，final/00 §9.3）；
/// detail=Some("circuit-trip") 语义对齐 02-定夺 W1（熔断侧 subagentRunId
/// = None、detail=Some）。
async fn emit_circuit_trip_events(active: &ActiveRun, session_id: &str) {
    let now = crate::engine::now_iso_utc();
    emit_envelope_event(
        &active.queue,
        &active.bridge,
        &active.run_id,
        session_id,
        AgentEvent::RuntimeInterventionRequired {
            session_id: session_id.to_string(),
            timestamp: now,
            reason: "circuit-trip".to_string(),
            choices: Vec::new(),
            message: "provider 连续失败已达熔断阈值，自动重试已暂停（观测面：请检查网络或配置后重试）"
                .to_string(),
        },
    )
    .await;
    emit_envelope_event(
        &active.queue,
        &active.bridge,
        &active.run_id,
        session_id,
        AgentEvent::RecoveryEscalated {
            session_id: session_id.to_string(),
            subagent_run_id: None,
            kind: "CircuitTrip".to_string(),
            retries: 0,
            elapsed_ms: 0,
            detail: Some("circuit-trip".to_string()),
        },
    )
    .await;
}

/// T-CF-11：PendingMessageQueue 条目批量转出 → 注入消息（对齐 D07 批量
/// 推送：一次续 run 承载全部条目，不逐条唤醒）。
///
/// 注入文本 = 队列条目原文（生成侧已按 §4.8 模板拼入 wakeup_summary
/// 摘要，与 prompt 并存）；多条条目按序拼接（换行分隔）为一条用户角色
/// 消息——对齐 D8「条目作为下一条用户消息注入」语义（steering_queue.rs
/// :86-106，注入消息带 `{kind:"steering"}` 元数据供下游识别）。
/// 消息 id 沿用首条条目 id 保证幂等（对齐 transfer_follow_up 的 id 沿用）。
pub(crate) fn drain_pending_to_inject_messages(
    queue: &mut PendingMessageQueue,
    _session_id: &str,
) -> Vec<AgentMessage> {
    let mut entries = queue.dequeue_all();
    if entries.is_empty() {
        return Vec::new();
    }
    // D6 §3.4：合并注入上限（评审 selection-03:220 建议 ≤16 条）——保留
    // 最新 ≤16 条（FIFO 尾部即最新；省略最旧——旧条目信息过时风险高，
    // D6 §8 决策 4），超出在文本注明省略 N 条。省略轨迹不丢：恢复域
    // 条目有 recover_notifications 落库冗余，定时器/子代理终态条目有
    // 事件表留痕——队列只承载提醒，不承载全量。
    let (kept, omitted) = if entries.len() > RESTORE_MERGE_INJECT_LIMIT {
        let split = entries.len() - RESTORE_MERGE_INJECT_LIMIT;
        let omitted = entries[..split].len();
        (entries.split_off(split), omitted)
    } else {
        (entries, 0)
    };
    let mut text = kept
        .iter()
        .map(|entry| entry.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if omitted > 0 {
        text = format!("{text}\n（其余 {omitted} 条唤醒通知省略，详情见事件流）");
    }
    // 消息 id 沿用保留集首条条目 id 保证幂等（对齐 transfer_follow_up
    // 的 id 沿用）
    let first = &kept[0];
    vec![AgentMessage {
        id: first.id.clone(),
        role: AgentMessageRole::User,
        created_at: crate::engine::now_iso_utc(),
        blocks: vec![AgentMessageBlock::Text { text }],
        metadata: Some(serde_json::json!({ "kind": "steering" })),
        client_message_id: None,
        content: None,
    }]
}

/// D7 §8 决策 1：会话树访问器（D3 session_trees 表优先——共享实例直读
/// 直写；无记录回退 [CoreRunState::sessions] 快照注册表临时重建 +
/// to_session_record 回写；无会话记录 → None 跳过——子代理会话
/// （sub-sess-*）天然无树无叶子，采集语义只落在有树会话，R8）。
/// 全程 std Mutex 锁内完成（纯内存，无 await，对齐 AA-02）。
fn with_session_tree<R>(
    state: &CoreRunState,
    session_id: &str,
    f: impl FnOnce(&mut SessionTree) -> R,
) -> Option<R> {
    {
        let trees = state.session_trees.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tree) = trees.get(session_id) {
            return Some(f(&mut tree.lock().unwrap_or_else(|e| e.into_inner())));
        }
    }
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let idx = sessions.iter().position(|record| record.session_id == session_id)?;
    let mut tree = SessionTree::from_session_record(sessions[idx].clone()).ok()?;
    let result = f(&mut tree);
    sessions[idx] = tree.to_session_record();
    Some(result)
}

/// D7 §3.1：收口采集接线（M5B；纯函数 collect_checkpoint_from_messages
/// → 写面 set_leaf_checkpoint）。三态：
/// - Ok(Some) → 写叶子（无叶子 / 写失败 → warn 不阻断）；
/// - Ok(None) → 无标记行，现状；
/// - Err → 对话内坏标记行：视为无 checkpoint，warn + 不写 + 不阻断
///   （§3.5 采集侧降级——该标记行是模型输出噪音，不中止 run 生命周期）。
pub(crate) fn collect_checkpoint_on_close(state: &CoreRunState, session_id: &str, outcome: &RunOutcome) {
    // 采集 API 收具体消息（非引用）——收口处一次 clone，与
    // to_history_messages 的收口克隆同频（每 run 一次，可接受）
    let messages: Vec<AgentMessage> = outcome.messages.iter().map(|m| m.as_ref().clone()).collect();
    match session_loop::safe_point::collect_checkpoint_from_messages(&messages) {
        Ok(Some(payload)) => {
            let written = with_session_tree(state, session_id, |tree| {
                let Some(leaf_id) = tree.current_leaf_id().map(str::to_string) else {
                    return false;
                };
                tree.set_leaf_checkpoint(&leaf_id, &payload).is_ok()
            });
            if !written.unwrap_or(false) {
                tracing::warn!(
                    target: "run",
                    session_id,
                    "checkpoint 采集命中但写面跳过/失败（无叶子或无会话记录；不阻断收口）"
                );
            }
        }
        Ok(None) => {}
        Err(error) => tracing::warn!(
            target: "run",
            session_id,
            error = %error,
            "checkpoint 采集损坏降级（对话含坏标记行；不写叶子、不阻断收口）"
        ),
    }
}

/// D7 §3.2：checkpoint 摘要注入段（spawn_idle_resume_run 注入文本拼接；
/// 三态分发——Present → 「上次检查点」摘要段（summary 截断 ≤500 字符，
/// completed/next 各 ≤5 项，§8 决策 4）；Corrupt → 降级提示不阻断；
/// Absent / 无树 → 空串（行为与现状一致，无 checkpoint 不注入）。
pub(crate) fn checkpoint_injection_section(state: &CoreRunState, session_id: &str) -> String {
    let checkpoint = with_session_tree(state, session_id, |tree| tree.read_leaf_checkpoint(None));
    match checkpoint {
        Some(conex_types::LeafCheckpointState::Present(payload)) => {
            let completed = join_limited(&payload.completed, CHECKPOINT_LIST_ITEMS_MAX, "、");
            let next = join_limited(&payload.next, CHECKPOINT_LIST_ITEMS_MAX, "、");
            format!(
                "[检查点摘要]\n上次检查点：目标「{}」。\n已完成：{}。\n摘要：{}\n下一步：{}",
                payload.target,
                if completed.is_empty() { "(无)".to_string() } else { completed },
                truncate_chars(&payload.summary, CHECKPOINT_SUMMARY_TRUNCATE_CHARS),
                if next.is_empty() { "(无)".to_string() } else { next },
            )
        }
        Some(conex_types::LeafCheckpointState::Corrupt(message)) => {
            tracing::warn!(
                target: "run",
                session_id,
                message,
                "检查点载荷损坏（降级提示，run 照常拉起）"
            );
            "(检查点损坏已忽略，按对话历史继续)".to_string()
        }
        _ => String::new(),
    }
}

/// D7 §8 决策 4：清单项拼接（取前 max 项，其余省略——注入文本长度
/// 护栏，防注意力稀释）
fn join_limited(items: &[String], max: usize, sep: &str) -> String {
    items.iter().take(max).cloned().collect::<Vec<_>>().join(sep)
}

/// D7 §8 决策 4：文本截断护栏（≤max 字符；超长截断 + 省略号「…」；
/// 按字符（char）截断不按字节，中文安全）
fn truncate_chars(text: &str, max: usize) -> String {
    let mut result: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        result.push('…');
    }
    result
}

// ── E2 F5（07 §4 卡 D）：分阶段总结壳层接线 ────────────────────────
//
// 里程碑触发（run 收口评估）+ 阶段总结产出（Summarizer 通道）+ 系统提示
// 词段注入（build_system_prompt 输出后拼接）+ checkpoint 载荷落库。
// 已触发记录选型（动态决策）：会话级 session_meta 键
// `{session_id}:compact_stage_triggered`（已触发里程碑下标集合）与
// `{session_id}:compact_stage_summaries`（阶段总结列表 {tier, markdown}）
// ——与 compact_stage_ratios 同一命名空间、跨 run 持久、无 goal_state 耦合；
// 事件面最小化（E2 §7.2「若事件总数最小化」分支）：阶段总结不新增事件
// 类型（避免 registry_drift 双面登记级联），观测面 = session_meta 键 +
// checkpoint + 日志。

/// F5：会话级已触发里程碑键（`{session_id}:compact_stage_triggered`）
fn stage_triggered_meta_key(session_id: &str) -> String {
    crate::outputs_config::session_meta_key_of(session_id, "compact_stage_triggered")
}

/// F5：会话级阶段总结列表键（`{session_id}:compact_stage_summaries`）
fn stage_summaries_meta_key(session_id: &str) -> String {
    crate::outputs_config::session_meta_key_of(session_id, "compact_stage_summaries")
}

/// F5：读取已触发里程碑下标集合（session_meta 键；缺失/坏 JSON → 空集
/// fail-open，不 panic）
pub(crate) fn stage_triggered_indices(state: &CoreRunState, session_id: &str) -> Vec<u32> {
    let Some(db) = state.local_db() else {
        return Vec::new();
    };
    db.get_session_meta(&stage_triggered_meta_key(session_id))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Vec<u32>>(&raw).ok())
        .unwrap_or_default()
}

/// F5：写入已触发里程碑下标集合（失败仅告警——下次收口按当前集合重判，
/// 幂等语义）
fn save_stage_triggered(state: &CoreRunState, session_id: &str, indices: &[u32]) {
    let Some(db) = state.local_db() else {
        return;
    };
    let raw = serde_json::to_string(indices).unwrap_or_else(|_| "[]".to_string());
    if let Err(error) = db.set_session_meta(&stage_triggered_meta_key(session_id), &raw) {
        tracing::warn!(
            target: "run",
            session_id,
            error = %error,
            "阶段里程碑标记落库失败（下次收口重判）"
        );
    }
}

/// F5：读取已产出阶段总结列表（{tier, markdown}；缺失/坏 JSON → 空）
pub(crate) fn stored_stage_summaries(state: &CoreRunState, session_id: &str) -> Vec<(String, String)> {
    let Some(db) = state.local_db() else {
        return Vec::new();
    };
    let Some(raw) = db
        .get_session_meta(&stage_summaries_meta_key(session_id))
        .ok()
        .flatten()
    else {
        return Vec::new();
    };
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|item| {
            let tier = item.get("tier")?.as_str()?.to_string();
            let markdown = item.get("markdown")?.as_str()?.to_string();
            Some((tier, markdown))
        })
        .collect()
}

/// F5：追加一条阶段总结（按 tier 幂等去重——同阶梯只存一份，防重复注入
/// 造成前缀碎片，E2 §6.5 ①/⑤ 稳定化纪律）
fn append_stage_summary(state: &CoreRunState, session_id: &str, tier: &str, markdown: &str) {
    let Some(db) = state.local_db() else {
        return;
    };
    let key = stage_summaries_meta_key(session_id);
    let mut items: Vec<serde_json::Value> = db
        .get_session_meta(&key)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Vec<serde_json::Value>>(&raw).ok())
        .unwrap_or_default();
    if items
        .iter()
        .any(|item| item.get("tier").and_then(|v| v.as_str()) == Some(tier))
    {
        return;
    }
    items.push(serde_json::json!({ "tier": tier, "markdown": markdown }));
    let raw = serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string());
    if let Err(error) = db.set_session_meta(&key, &raw) {
        tracing::warn!(
            target: "run",
            session_id,
            error = %error,
            "阶段总结存储失败（注入面不可见，checkpoint 仍可携带）"
        );
    }
}

/// F5 §6.3：系统提示词段注入——build_system_prompt 规范化输出后拼接
/// 「阶段总结：N 条」段（每阶梯 md 渲染 + tier 标注；零对话污染、天然跨
/// run 携带，E2 §6.3 主选）。读取会话级阶段总结列表；无总结 → 原样返回
/// build_system_prompt 输出（行为与接线前一致）。
pub(crate) fn assemble_system_prompt_with_stages(
    state: &CoreRunState,
    session_id: &str,
    system_prompt: Option<String>,
) -> Option<String> {
    let base = build_system_prompt(system_prompt);
    let stages = stored_stage_summaries(state, session_id);
    if stages.is_empty() {
        return base;
    }
    let mut section = format!("阶段总结：{} 条", stages.len());
    for (_, markdown) in &stages {
        section.push_str("\n\n");
        section.push_str(markdown);
    }
    match base {
        Some(base) => Some(format!("{base}\n\n{section}")),
        None => Some(section),
    }
}

/// F5：Schema V1 字符串数组字段提取（非数组/非字符串项跳过；阶段总结
/// 构造辅助）
fn stage_doc_string_array(doc: &serde_json::Value, key: &str) -> Vec<String> {
    doc.get(key)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// F5 §6.2/07 §4.1：run 收口里程碑评估（触发点 = run 收口，Stop 收场路径）。
///
/// - 输入：当前对话（outcome.messages）+ 会话级已触发集合（session_meta）；
/// - 判定：estimate（count_agent_message_tokens 启发式合计，压缩链同源
///   口径）/ window（生效模型目录窗口；目录缺失回退 ContextBudget 默认
///   64000）比例 ≥ compact_stage_ratios（默认 [0.4,0.6,0.8]，可配）中
///   首个未触发阶梯（next_pending_milestone 纯函数）；
/// - 触发：经 Summarizer 对完整对话产出 Schema V1 阶段总结（tier=stage-N、
///   droppedIds 空、custom range = 消息 id 区间）→ 存储 + checkpoint 落载荷；
/// - 失败语义：Summarizer 缺失 / 摘要失败 / 非法 JSON → 里程碑**不标记**
///   （下轮收口重试，与 F2 层 1「被动重试」同向）；标记在产出成功后写入
///   （防「假触发」）；
/// - 每阶梯只触发一次：已触发集合跨 run 持久（session_meta 键），新 run
///   重新评估时更高阶梯达标才补触发（重复触发抑制，07 §4.4 测试 1）。
pub(crate) async fn evaluate_stage_milestones(
    state: &Arc<CoreRunState>,
    session_id: &str,
    messages: &[Arc<AgentMessage>],
) {
    if messages.is_empty() {
        return;
    }
    // 里程碑阶梯（session_meta `compact_stage_ratios` 可配；键缺失回退
    // 默认 40/60/80%——stage_ratios_from_session_meta fail-open）
    let ratios = {
        let db = state.local_db();
        let meta = |key: &str| db.as_ref().and_then(|d| d.get_session_meta(key).ok().flatten());
        stage_ratios_from_session_meta(meta)
            .unwrap_or_else(|| DEFAULT_COMPACT_STAGE_RATIOS.to_vec())
    };
    // 估算（启发式 token 合计）与窗口（生效模型目录；缺目录回退默认窗口）
    let estimate: u64 = messages
        .iter()
        .map(|m| conex_compaction::count_agent_message_tokens(m) as u64)
        .sum();
    let window = state
        .engine
        .provider_config()
        .and_then(|config| crate::engine::effective_context_window(&config))
        .map(u64::from)
        .unwrap_or(u64::from(ContextBudget::default().context_window));
    let ratio = session_loop::r#loop::stage_summary::estimate_ratio(estimate, window);
    let triggered = stage_triggered_indices(state, session_id);
    let Some(index) = next_pending_milestone(ratio, &ratios, &triggered) else {
        return;
    };
    // 触发：Summarizer 解析（F1 L1：无 Summarizer → 不产出、不标记）
    let Some(summarizer) = state.summarizer_for(session_id) else {
        tracing::warn!(
            target: "run",
            session_id,
            ratio,
            "阶段里程碑达标但 LLM 摘要不可用 → 跳过（下轮收口重试）"
        );
        return;
    };
    // 完整对话 → 阶段总结（Summarizer 为同步 trait，ProviderSummarizer
    // 内部专用线程异步——收口 async 面经 spawn_blocking 隔离阻塞，与
    // save_run_usage 先例同纪律）
    let dropped: Vec<AgentMessage> = messages.iter().map(|m| m.as_ref().clone()).collect();
    let summarizer = Arc::clone(&summarizer);
    let summarize_result =
        tokio::task::spawn_blocking(move || summarizer.summarize(&dropped, None))
            .await
            .map_err(|join| format!("阶段总结任务 join 失败：{join}"));
    let text = match summarize_result {
        Ok(Ok(text)) => text,
        Ok(Err(error)) => {
            tracing::warn!(
                target: "run",
                session_id,
                error,
                "阶段总结产出失败 → 不标记（下轮收口重试）"
            );
            return;
        }
        Err(error) => {
            tracing::warn!(
                target: "run",
                session_id,
                error,
                "阶段总结任务失败 → 不标记（下轮收口重试）"
            );
            return;
        }
    };
    // Schema V1 校验 + 字段提取（goal/constraints/progress/decisions/
    // nextSteps/criticalContext）；非法输出 → 不标记（下轮重试）
    let llm_doc: serde_json::Value = match serde_json::from_str(&text) {
        Ok(doc) => doc,
        Err(error) => {
            tracing::warn!(
                target: "run",
                session_id,
                error = %error,
                "阶段总结非 Schema V1 JSON → 不标记（下轮收口重试）"
            );
            return;
        }
    };
    let tier = stage_tier(index);
    let stage_doc = build_stage_summary_document(&StageSummaryDocument {
        stage_index: index,
        block_id: format!("stage-summary-{}", index + 1),
        generation: 1,
        goal: llm_doc
            .get("goal")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        constraints: stage_doc_string_array(&llm_doc, "constraints"),
        progress: stage_doc_string_array(&llm_doc, "progress"),
        decisions: stage_doc_string_array(&llm_doc, "decisions"),
        next_steps: stage_doc_string_array(&llm_doc, "nextSteps"),
        critical_context: llm_doc
            .get("criticalContext")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        range: Some(StageSummaryRange {
            start_message_id: messages
                .first()
                .map(|m| m.id.clone())
                .unwrap_or_default(),
            end_message_id: messages.last().map(|m| m.id.clone()).unwrap_or_default(),
            message_count: messages.len() as u32,
        }),
    });
    let markdown = stage_summary_to_markdown(&stage_doc);
    // 标记已触发（产出成功后）+ 存储总结（注入面数据源；tier 幂等去重）
    let mut next_triggered = triggered;
    next_triggered.push(index);
    next_triggered.sort_unstable();
    next_triggered.dedup();
    save_stage_triggered(state, session_id, &next_triggered);
    append_stage_summary(state, session_id, &tier, &markdown);
    // checkpoint 落载荷（set_leaf_checkpoint；无树/无叶子 → 跳过不阻断，
    // 与 collect_checkpoint_on_close 同语义）
    let payload = stage_summary_to_checkpoint_payload(&stage_doc);
    let written = with_session_tree(state, session_id, |tree| {
        let Some(leaf_id) = tree.current_leaf_id().map(str::to_string) else {
            return false;
        };
        tree.set_leaf_checkpoint(&leaf_id, &payload).is_ok()
    });
    tracing::info!(
        target: "run",
        session_id,
        tier,
        message_count = messages.len(),
        checkpoint = written.unwrap_or(false),
        "阶段里程碑触发：阶段总结已产出并存储"
    );
}

/// T-CF-11：idle 续 run 拉起（收口处判定命中后调用）——复用
/// [run_task_impl] 的 run 装配拉起新 run（新 run id / 新 producer /
/// 新 ActiveRun / 新 drive_run_loop；history 回退 SessionHistoryCache，
/// 上一轮收口已缓存——历史自动续接，T-29 混合路线）。
///
/// prompt = 注入消息文本（队列条目批量聚合；仅定时器/Cron 源触发时为
/// 空文本——AI 醒来保持待命态，等待事件条目入队后经下一次收口送达）；
/// mode = 续 run 类型（D2 §3.4 mode 参数化：idle-resume / recovery-retry
/// / content-resume / goal-continue，自动恢复类型可观测，G-6）。失败仅
/// 告警不重试（下一收口再判定；空转护栏防风暴）。
pub(crate) async fn spawn_idle_resume_run(
    state: Arc<CoreRunState>,
    session_id: String,
    mode: &str,
    inject: Vec<AgentMessage>,
) {
    let mut text = inject
        .iter()
        .map(|message| message.text())
        .collect::<Vec<_>>()
        .join("\n");
    // D7 §3.2：checkpoint 摘要注入（read_leaf_checkpoint 三态分发——
    // Present 追加「上次检查点」段（摘要 ≤500 字符截断）；Corrupt 追加
    // 降级提示；Absent 不追加，行为与现状一致；不 panic、不阻断拉起。
    // 注入仅发生在中断恢复/新 run 拉起场景：该场景 run 上下文本就是
    // 重建态，前缀缓存必然失效，接受前缀变更（约束 B 权衡注记）
    let checkpoint_section = checkpoint_injection_section(&state, &session_id);
    if !checkpoint_section.is_empty() {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(&checkpoint_section);
    }
    let options = RunTaskOptions {
        run_id: crate::engine::new_message_id("idle-resume"),
        session_id: session_id.clone(),
        prompt: Some(text),
        mode: Some(mode.to_string()),
        cwd: None,
        permission_mode: None,
        client_message_id: None,
        assistant_client_message_id: None,
        system_prompt: None,
        history: None,
        context_window: None,
        parent_run_id: None,
        // T-D-13：续 run 为普通 run（子代理配置仅 spawner 构造）
        subagent_config: None,
        // D5 §3.1：续轮 run 的 goal 三字段从 goal_state 重建（不依赖
        // 前端再下发——引擎自主行为，goal_state 是权威，D5 §8 决策 7）；
        // 此处缺省 None：装配面在 [run_task_impl] 内按 mode 判定
        visible_goal: None,
        max_rounds: None,
        max_stalled_rounds: None,
    };
    if let Err(error) = run_task_impl(Arc::clone(&state), options).await {
        tracing::warn!(
            target: "run",
            session_id,
            error = %error,
            "idle 续 run 拉起失败（下一收口再判定；空转护栏防风暴）"
        );
    }
}

// ── drive_run_loop ────────────────────────────────────────────────

/// run 驱动循环（B6.1：produce → drive_outcome → emit → 终态）
///
/// 流程（T09.2 步骤 4/5：by value 零克隆）：
/// 1. `produce`（[RunProducer]）→ [RunOutcome]；
/// 2. [orchestrator::events::drive_outcome]：事件入队（sequence 会话级
///    原子分配，delta 不阻塞）+ 终态收口（run-terminal 唯一一次）；
/// 3. 事件 emit：信封 runId/sequence 注入（03 §5.3-2/6）；**T09.1 后收口
///    message-delta 跳过不双发**（实时轨已发，sequence=None；前端按
///    messageId 幂等累加）；
/// 4. cursor 发布：drive_outcome 已更新 run.cursor（终态游标 = 最后事件
///    sequence，T08.4），终态记录落库；
/// 5. 终态：移出活动注册表 + 快照（T08.6 触发点 A）；
/// 6. 错误路径：drive 失败（防御性）→ [finalize_failed]。
pub(crate) async fn drive_run_loop(
    state: Arc<CoreRunState>,
    active: Arc<ActiveRun>,
    mut producer: Box<dyn RunProducer>,
) {
    let session_id = active.session_id.clone();
    let run_id = active.run_id.clone();
    // span 约定（26-frontend-observability-audit.md：drive_run_loop 入口
    // info_span!("run", session_id, run_id)，引擎各阶段统一字段名）
    let span = tracing::info_span!("run", session_id = %session_id, run_id = %run_id);
    let _enter = span.enter();
    tracing::info!("drive_run_loop 启动");

    // 1. produce（单次即覆盖整个 run：多 turn 由 AgentSessionLoop 内部驱动；
    //    未来 goal 多轮模式在本循环续轮）
    let outcome = producer.produce().await;
    // 产出完成即释放生产者：其持有的 options（含逃逸监视配置引用 →
    // 审计桥引用）随 Drop 归还——审计落库 worker 的通道关闭时点
    // 确定性依据（收口 await 排空不依赖生产者存活，L4）
    drop(producer);
    // T-CF-11：产出信号提前捕获（outcome 随后被 drive_outcome 消费——
    // reason / turn_index / tool_call_count 为 Copy 字段，收口判定用）
    let resume_reason = outcome.reason;
    let resume_turn_index = outcome.turn_index;
    let resume_tool_calls = outcome.tool_call_count;
    // D3：C7 恢复决策输入提前捕获（outcome 随后被 drive_outcome 移动消费
    // ——selection-02 评审报告 §2.5：provider_error 必须在此同批提前提取
    // clone；任务文本与产出判定来自 messages 快照）
    let resume_provider_error = outcome.provider_error.clone();
    let first_user_text = CoreRunState::first_user_text(&outcome.messages);
    let has_assistant_output = outcome
        .messages
        .iter()
        .any(|m| m.role == AgentMessageRole::Assistant);
    // D2 §3.3 + E1 §3.3：续 run 判定数据面（与 provider_error 同批提前
    // 提取——outcome 随后被 drive_outcome 移动消费）。task_text = 会话
    // 首条非 steering user 消息（指纹输入，避免 error 续 run 的注入文本
    // 使指纹从第二次起漂移）；last_assistant = 最后一条 assistant 消息的
    // 流中断标注（E1 续写子分支触发信号，D7 §3.7）。
    let resume_task_text = main_task_text(&outcome.messages);
    let resume_last_assistant = last_assistant_provider_signal(&outcome.messages);
    // D5 §3.3：goal 收口评估输入预提取（outcome 随后被 drive_outcome
    // 移动消费——与 provider_error 同批提前提取；assess_goal_round 在
    // :4957 收口区块调用，数据面必须在此备好）
    let goal_signals = extract_goal_round_signals(&outcome.messages);
    // E3-2：子代理 run 汇报素材（仅子代理 run 捕获——主 run 不产生
    // subagent 汇报；Arc 克隆零拷贝共享同一份消息内存）
    let subagent_messages = if active.subagent.is_some() {
        outcome.messages.clone()
    } else {
        Vec::new()
    };
    // D3 §3.2.4：window_bytes（fork 三态判定的会话窗口字节；本触发点
    // 以本 run 消息字节合计近似——content_bytes 语义同源，lifecycle.rs:
    // 451-458；仅装配进 ctx，本决策不消费）
    let run_message_bytes: u64 = outcome
        .messages
        .iter()
        .map(|m| m.text().len() as u64)
        .sum();

    // T-29 收口写入（P4 阶段 1-4）：run 引擎侧收口后，把对话消息收口为
    // HistoryMessage 原子替换 SessionHistoryCache——不落库、不改写会话语义
    // （混合路线核心）；缓存 = 下次 run 的 history 参数回退源；压缩后序列
    // 随收口自然携带（缓存基线重建，P4 §3.6 I5 / C13）
    state.session_history.store(&session_id, to_history_messages(&outcome));

    // ── D7-① checkpoint 收口采集（M5B 接线：收口一次，produce 后 /
    // drive_outcome 前——outcome.messages 仍在手，借用完成后即 move；
    // finalize_failed 防御路径跳过并注释——drive 失败消息未消费属极
    // 罕见，跳过可接受，D7 §8 决策 3）。采集侧损坏 warn + 不写 + 不
    // 阻断（§3.5 降级）；子代理会话无树自动跳过（R8）──
    collect_checkpoint_on_close(&state, &session_id, &outcome);

    // ── E2 F5（07 §4 卡 D）：run 收口里程碑评估——对话长度达
    // compact_stage_ratios 阈值（默认 40/60/80%）时经 Summarizer 对完整
    // 对话产出阶段总结（tier=stage-N），存储（session_meta 注入面数据源）
    // + checkpoint 落载荷；每阶梯只触发一次（会话级已触发集合跨 run
    // 持久）。子代理 run 不评估（一次性任务，无里程碑语义——与 goal
    // 收口评估同守卫）──
    if active.subagent.is_none() {
        evaluate_stage_milestones(&state, &session_id, &outcome.messages).await;
    }

    // T-40 缓存测量收口（P5 S5 §3.2 数据流，R5-D3 轮末合并接线 ②）：
    // outcome.cache_stats 非空（tracker.finish 产物，T-36）→ 会话级状态
    // 写回（下一 run 冷缓存预警 / 模型切换检测）+ save_run_usage 落库
    // （runs 表 v5 列，T-39）——实现细节见 [write_back_cache_stats]
    if let Some(stats) = &outcome.cache_stats {
        write_back_cache_stats(&state, &session_id, &run_id, *stats).await;
    }

    // 2. drive_outcome（锁在作用域内持有，错误路径先释放再收口）
    let driven = {
        let mut run = active.handle.lock().await;
        let mut queue = active.queue.lock().await;
        drive_outcome(&mut run, &mut queue, outcome).await
    };

    let driven = match driven {
        Ok(driven) => driven,
        Err(error) => {
            // 防御性：终态不可再驱动（已有终态 / 异常收口）→ 失败收场
            tracing::error!(
                target: "run",
                error = %error,
                "drive_outcome 失败（防御性收口）"
            );
            // T-ESC-03：失败收口同样停止监视 + flush 剩余事件
            // （run 中崩溃不泄漏监视任务，REQ §5.4 风险缓解）
            let escape_handle = active
                .escape_watch
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            if let Some(mut handle) = escape_handle {
                handle.shutdown().await;
            }
            finalize_failed(&state, &active, &error.to_string()).await;
            return;
        }
    };

    // 3. 事件 emit（信封 runId/sequence 注入；缓冲桥组装背压）
    let mut report = EmitReport::default();
    let mut runtime_error: Option<String> = None;
    for sequenced in driven.events {
        // T-CF-13（R-CF3）：事件收口旁路点 mark_wakeup 接线——任何事件
        // 到达即更新 last_wakeup（watchdog 失联判定数据源；子代理等待
        // 期间有事件到达则不误报"无唤醒"）
        state.engine.last_wakeup().mark_wakeup();
        // T09.1：实时轨已发 delta，收口流 message-delta 跳过不双发
        // （序列号已分配；持久化不落库；前端按 messageId 累加，AA-06 F1）
        if active.delta_sink_active && matches!(sequenced.event, AgentEvent::MessageDelta { .. }) {
            continue;
        }
        // T04.5-1：事件桥 runtime-error 事件处写入 lastError
        if let AgentEvent::RuntimeError { error, .. } = &sequenced.event {
            runtime_error = Some(error.clone());
        }
        let envelope = AgentEventEnvelope::new(
            sequenced.event,
            Some(run_id.clone()),
            Some(sequenced.sequence),
        );
        report.add(active.bridge.emit(&envelope));
    }
    if let Some(ref error) = runtime_error {
        state
            .diagnostics
            .set_last_error(crish_payload_from_message(error));
    }
    report.add(active.bridge.flush());
    tracing::info!(
        target: "run",
        emitted = report.emitted,
        dropped = report.dropped,
        "事件发射完成（缓冲桥）"
    );

    // T-ESC-03 run 收口钩子：停止监视 + flush 剩余事件（聚合补发最后
    // 一条报告——审计经桥广播，注入经 followUp 环落会话，REQ §3.5.1）
    let escape_handle = active
        .escape_watch
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(mut handle) = escape_handle {
        handle.shutdown().await;
    }

    // 4-5. 终态：移出注册表 + 快照（T08.6 触发点 A；cursor 已由
    //      drive_outcome 维护并在 finalize 落库）
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&run_id);
    // 15-T-6（裁决 D9）：工具级审计路由收口注销（run 级桥随 run 结束
    // 释放，防 session 泄漏；与 escape_watch 句柄同生命周期收口——
    // 重复注销幂等，finalize_failed 失败路径不重复进入本函数）
    state.engine.audit_sink().unregister(&session_id);
    // L4（F12）：审计落库收口——注销即释放桥引用（sender drop 发出
    // 通道关闭信号），await worker 排空全部审计事件再报 run 终态
    // （审计底账在终态前完整落库；None = 测试驱动路径未装配）。
    // 先 take 出句柄再 await：std Mutex 锁不跨 await 持有（AA-02）
    let audit_worker = active
        .audit_persist
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(handle) = audit_worker {
        let _ = handle.await;
    }
    // T-AB-19 run 终态显式接线：**不清理后台任务注册表、不级联杀任务**
    // ——任务属会话级（registry 生命周期独立于 run，T-AB-12 只读契约升级
    // 为显式收口契约；run_end_daemon_survives / run_end_normal_task_survives
    // _no_cascade 测试锚定）。守护任务（is_daemon=true）与普通任务在 run
    // 终态后均持续运行、日志持续累积；会话切换同理不受影响。此处仅释放
    // 「当前 run」上下文（owner_run_id 注入槽，供下一 run 复用）。
    state.background.clear_current_run(&run_id);
    // T-D-13：spawner 侧 run 上下文释放（当前活动 run 定位槽）
    state.subagent_spawner.clear_current_run(&session_id, &run_id);

    // ── T-D-13：子代理 run 终态收口（记账释放 / 行更新 / subagent-ended
    // 发射 / wait 通道 feed / steering 通知）──
    // 须在 decide_idle_resume 之前完成：steering 条目入队后，收口判定
    // 「队列非空」→ 主 agent 下一 run 自动唤醒收到子代理完成通知。
    if let Some(cfg) = active.subagent.clone() {
        let terminal_status = {
            let run = active.handle.lock().await;
            run.status.clone()
        };
        // ── D3：C7 恢复触发（决策先行于既有收口——裁决 #5 语义
        //     「on_subagent_run_terminal 之前」：escalate 的 steering 条目
        //     先入队，与 subagent-terminal-<run_id> 终态通知共存）──
        // ── E3-2：子代理运行中汇报（subagent-event 通道 kind=progress；
        //     观测面，不写 steering 队列；wait 语义零改变）──
        let recovery_plan = state
            .decide_subagent_recovery(
                &session_id,
                &cfg,
                &terminal_status,
                // D1 数据面：fatal 收场填充 kind（正常 stop 收场 None）
                resume_provider_error.as_ref().map(|pe| pe.kind),
                &first_user_text,
                has_assistant_output,
                run_message_bytes,
            )
            .await;
        state
            .emit_subagent_progress(&cfg, &active.bridge, &subagent_messages)
            .await;
        // 既有收口五步（记账释放 → 行更新 → subagent-ended → wait feed →
        // steering 通知；子代理终态通知保留——C5 断言允许其存在）
        state
            .on_subagent_run_terminal(&cfg, terminal_status)
            .await;
        // ── D3：阶梯 1 收口后重派（裁决 #5：旧 run 记账已释放 → spawn
        //     守卫计数正确，无「被自己挡住」误拒；原 run failed
        //     reason=recovery-retry；预算内重派 mode=recovery-retry；
        //     不消费 Episode、无 steering）──
        if let Some(plan) = recovery_plan {
            state
                .execute_subagent_recovery(&session_id, &cfg, plan)
                .await;
        }
    }

    state.save_snapshot_now().await;
    tracing::info!(
        target: "run",
        run_id = %run_id,
        "drive_run_loop 收口（终态）：后台任务注册表未清理、任务不级联杀（T-AB-19 契约）"
    );

    // ── T-CF-11：idle 待命续 run（收口处判定；run 正常结束而非用户取消）──
    // 唤醒源：PendingMessageQueue 非空（跨 run steering 条目）/ 活跃定时器 /
    // enabled Cron（判定器注入）；三源全空 → AI 休眠待用户。队列条目批量
    // 转出注入新 run（对齐 D07 批量推送），摘要文本已由生成侧按 §4.8
    // 模板拼入条目原文。空转护栏：连续 3 次续 run 无 AI 产出 → 停止。
    //
    // T-D-13：**子代理 run 不参与 idle 待命续 run**——子代理是一次性任务，
    // 收口即完成（终态通知已由 [Self::on_subagent_run_terminal] 发出）；若
    // 子代理收口也判定 idle 续 run，会消费自己入队的 steering 条目造成
    // 自续循环（靠空转护栏刹停，浪费模型调用）。steering 条目保留在队列，
    // 由主 agent 会话的收口消费（通知链路完整）。
    if active.subagent.is_none() {
        // ── D1 §3.2.2（S2）+ D5 §3.3：收口恢复面（熔断计数 + goal
        //    轮次评估）──
        // 熔断计数（唯一写方 [Self::update_provider_fail_streak]，
        // spawn_blocking 落键）：判定顺序（D1 §3.2.2 S2 落点）——
        // 1. RunOutcome.provider_error 存在：瞬态四类（RateLimit/
        //    ServerError/Timeout/Network）→ +1；非瞬态 → 清零（C3）；
        // 2. 无 provider_error 但最后一条 assistant 消息 metadata 标注
        //    瞬态四类（部分保留断流，D7 流中断标注）→ +1（S2 补丁：
        //    「产出一点再断流」无法绕开熔断）；
        // 3. 其余（正常完成 / 无 provider 错误信号）→ 清零。
        // 子代理 run 不参与（本区块守卫）：子代理失败走 D3 恢复阶梯，
        // 熔断是主 run provider 健康信号（子代理会话键无消费方）。
        let transient_failure = match &resume_provider_error {
            Some(pe) => is_transient_kind(pe.kind),
            None => resume_last_assistant
                .as_ref()
                .map(|last| {
                    last.kind.is_some_and(is_transient_kind) && last.retryable != Some(false)
                })
                .unwrap_or(false),
        };
        if state
            .update_provider_fail_streak(&session_id, transient_failure)
            .await
        {
            // 熔断触发边沿（跨过阈值）：观测事件（D1 §3.2.2 C5——
            // runtime-intervention-required + recovery-escalated
            // detail="circuit-trip"；仅观测面，不注入对话、不给 AI）
            emit_circuit_trip_events(&active, &session_id).await;
        }
        // D5 §3.3：收口 goal 轮次评估（唯一写方 [Self::assess_goal_round]；
        // 无 goal_state 键 → 不评估不写；error 轮由 assess_round reason
        // 门禁拦截——不递增 current_round/stalled_rounds（01 敲定 §3
        // 第3条）。评估先于 decide_idle_resume：goal_pending 读面消费
        // 本轮已推进的 goal_state（收口评估 → 续轮判定同区衔接）。
        state
            .assess_goal_round(
                &active,
                resume_reason,
                &goal_signals,
                runtime_error.as_deref(),
            )
            .await;

        // D2 §3.2：判定输入组装（outcome 已移动消费，数据面在同批提取；
        // ProviderErrorSummary 为 session-loop 私有模块类型，逐字段映射）
        let resume_signals = ResumeSignals {
            task_text: resume_task_text,
            provider_error: resume_provider_error.as_ref().map(|pe| ProviderErrorFields {
                kind: pe.kind,
                retryable: pe.retryable,
                retries: pe.retries,
            }),
            last_assistant: resume_last_assistant,
        };
        if let Some(decision) = decide_idle_resume(
            &state,
            &active,
            resume_reason,
            // 「有 AI 产出」= 完成过 turn 或执行过工具（空转 run 两者皆 0）
            resume_turn_index > 0 || resume_tool_calls > 0,
            &resume_signals,
        )
        .await
        {
            tracing::info!(
                target: "run",
                session_id = %session_id,
                run_id = %run_id,
                inject_messages = decision.inject.len(),
                "idle 待命命中：自动续开一轮 run（队列条目批量注入 / 定时器 / Cron / goal / 恢复源）"
            );
            let launcher = state
                .resume_launcher
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            match launcher {
                Some(launcher) => {
                    launcher(&state, &session_id, decision.mode, decision.inject).await
                }
                None => {
                    // 防御分支：拉起器未注入（生产恒注入——CoreRunState::new
                    // 预装配生产拉起器，见 [production_resume_launcher]）。
                    // 不在此处直接引用 run_task_impl：drive_run_loop 与
                    // run_task_impl 相互包含 opaque future 会让 auto-trait
                    // 检查无法终止（Rust 限制）——经 trait object 拉起器
                    // （叶子类型）切断类型递归。未注入时跳过续 run 并记日志。
                    tracing::warn!(
                        target: "run",
                        session_id = %session_id,
                        run_id = %run_id,
                        "idle 续 run 拉起器未注入（跳过本轮续 run）"
                    );
                }
            }
        }
    }
} // drive_run_loop 收口闭
} // mod idle_resume 闭合（drive_run_loop 与 run_task_impl 的 opaque
  // future 跨模块定义 + trait object 拉起器切断类型递归，Send 检查可终止）

/// T-CF-11 / drive_run_loop 子模块 re-export（drive_run_loop 与
/// run_task_impl 相互引用 opaque future，跨模块定义后 Send 检查可终止；
/// 外层与测试经此引用）
use idle_resume::{
    EpisodeConsume, ResumeLauncher, WakeSourceCheck, assemble_system_prompt_with_stages,
    drive_run_loop,
};

/// T-40 缓存测量收口（P5 S5 §3.2 数据流，R5-D3 轮末合并接线 ②；
/// 拆分独立函数以便测试直测）：
///
/// 1. **会话级状态写回**：经 `state.engine.update_cache_session` 写入
///    EngineHandle（下一 run 冷缓存预警 / 模型切换检测数据源；内存态
///    跨 run 续接，跨重启由 runs 表 v5 列兜底，T-39）。跟踪配置缺失
///    （provider 未就绪/重载）时跳过写回——本 run 已无跟踪上下文，
///    仅告警不中断收口；
/// 2. **save_run_usage 落库**：runs 表 v5 列幂等 UPDATE（T-39；
///    core_get_run_snapshot.usage 查询数据面）。db 经 [CoreRunState::local_db]
///    从 store 下转型取得——非 LocalDb 实现（InMemoryStore 测试替身）
///    跳过落库。写路径走 `spawn_blocking`（P05：消除同步直调对 tokio
///    worker 的阻塞，与 session_commands.rs 既有模式一致）。
///
/// 失败仅告警不中断收口（usage 查询面回退前端估算，contract 约定）。
async fn write_back_cache_stats(
    state: &CoreRunState,
    session_id: &str,
    run_id: &str,
    stats: RunCacheStats,
) {
    if let Some(config) = state.engine.cache_tracking_config() {
        state.engine.update_cache_session(session_id, &stats, &config.model);
    } else {
        tracing::warn!(
            target: "run",
            run_id,
            "收口缓存统计但缓存跟踪配置缺失（跳过会话级状态写回）"
        );
    }
    let Some(db) = state.local_db() else {
        return;
    };
    let run_id_owned = run_id.to_string();
    match tokio::task::spawn_blocking(move || db.save_run_usage(&run_id_owned, stats)).await {
        Ok(Ok(())) => {}
        Ok(Err(failure)) => {
            tracing::warn!(
                target: "run",
                run_id,
                error = %failure,
                "save_run_usage 落库失败（usage 查询回退前端估算）"
            );
        }
        Err(join_error) => {
            tracing::warn!(
                target: "run",
                run_id,
                error = %join_error,
                "save_run_usage spawn_blocking join 失败（usage 查询回退前端估算）"
            );
        }
    }
}

// ── D3：F2-27 spawn_blocking 覆盖（维度文档 D3 §3.4，仿 save_run_usage
//    先例）──────────────────────────────────────────────────────────

/// F2-27 内部：on_subagent_run_failure（声明 async、函数体无 await，
/// recovery.rs:914-978）在 spawn_blocking 线程经 tokio Handle::block_on
/// 执行（无 await future 立即完成，无阻塞；futures-util 未启用 executor
/// feature，Handle::block_on 为 blocking 线程内的标准运行期模式——
/// spawn_blocking 闭包携带运行期上下文）。
fn block_on_coordinator_failure(
    c: &mut RecoveryCoordinator,
    ctx: &RunFailureContext,
) -> Result<RecoveryOutcome, RecoveryError> {
    tokio::runtime::Handle::current().block_on(c.on_subagent_run_failure(ctx))
}

/// F2-27：RecoveryStore 同步 SQLite 全走 spawn_blocking（tokio worker 不
/// 执行同步 SQLite）。coordinator 变体：持锁在 blocking 线程执行同步方法
/// ——[RecoveryCoordinator] 的纯同步方法（new / restore_steering_notifications
/// / acknowledge / report_to_user / persist_*）闭包直调；
/// on_subagent_run_failure（声明 async、函数体无 await，recovery.rs:914
/// -978）闭包内 `futures_util::executor::block_on` 执行（无 await future
/// 立即完成，无阻塞）。
async fn blocking_coordinator_call<R: Send + 'static>(
    coord: Arc<Mutex<RecoveryCoordinator>>,
    f: impl FnOnce(&mut RecoveryCoordinator) -> Result<R, RecoveryError> + Send + 'static,
) -> Result<R, RecoveryError> {
    tokio::task::spawn_blocking(move || {
        let mut c = coord.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut c)
    })
    .await
    .map_err(|join| RecoveryError::PersistFailed {
        message: format!("恢复协调器阻塞调用 join 失败：{join}"),
    })?
}

/// D5 §3.9 / D1 §3.2.2：壳层事件发射统一入口（入队持久化 + 信封 emit；
/// sequence 由 EventQueue 会话级原子分配）。goal-* 与熔断观测事件
/// （runtime-intervention-required / recovery-escalated）共用本通道——
/// envelope 带 runId + sequence（前端投影消费，02-定夺 B2）。
async fn emit_envelope_event(
    queue: &Arc<tokio::sync::Mutex<EventQueue>>,
    bridge: &Arc<BufferedRunEventBridge>,
    run_id: &str,
    session_id: &str,
    event: AgentEvent,
) {
    let mut queue = queue.lock().await;
    if let Ok(sequenced) = queue.push(session_id, event).await {
        let envelope = AgentEventEnvelope::new(
            sequenced.event,
            Some(run_id.to_string()),
            Some(sequenced.sequence),
        );
        bridge.emit(&envelope);
        bridge.flush();
    }
}

/// 错误路径收口（四源失败 / 防御性驱动失败）
///
/// - runtime-error 事件（持久化，03 §2.4 四源失败收口）；
/// - run 标记 failed（event-store-write-failed 语义，不假装可回放）；
/// - 终态事件尽力发出（run-terminal 唯一终态，03 §5.2-2）；
/// - lastError 写入（T04.5-1：finalize_failed 写入点）。
async fn finalize_failed(state: &Arc<CoreRunState>, active: &ActiveRun, message: &str) {
    // T-ESC-03：失败收口兜底停止监视 + flush（drive 错误分支已收口
    // 时此处幂等跳过——句柄经 take 已取出）
    let escape_handle = active
        .escape_watch
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(mut handle) = escape_handle {
        handle.shutdown().await;
    }

    let session_id = active.session_id.clone();
    let run_id = active.run_id.clone();
    let mut run = active.handle.lock().await;
    let mut queue = active.queue.lock().await;

    // runtime-error 事件（持久化）
    let _ = queue
        .push(
            &session_id,
            AgentEvent::RuntimeError {
                session_id: session_id.clone(),
                timestamp: crate::engine::now_iso_utc(),
                error: message.to_string(),
                retryable: None,
            },
        )
        .await;

    // run 标记 failed（不假装可回放）
    if let Err(error) = run.fail_event_store(queue.store(), message).await {
        tracing::error!(
            target: "run",
            error = %error,
            "finalize_failed：fail_event_store 失败"
        );
    }

    // 终态事件尽力发出（唯一终态事件）
    let terminal = build_run_terminal(&run, RunTerminalStatus::Failed, Some(message.to_string()));
    let sequenced = queue.push_terminal_best_effort(&session_id, terminal).await;
    let envelope = AgentEventEnvelope::new(
        sequenced.event,
        Some(run_id.clone()),
        Some(sequenced.sequence),
    );
    active.bridge.emit(&envelope);
    active.bridge.flush();

    // lastError（T04.5-1 写入点）
    state
        .diagnostics
        .set_last_error(crish_payload_from_message(message));

    drop(queue);
    drop(run);
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&run_id);
    // 15-T-6（裁决 D9）：失败收口同样注销工具级审计路由（防泄漏；
    // drive 错误分支未走 drive_run_loop 正常收口，本处兜底——重复
    // 注销幂等）
    state.engine.audit_sink().unregister(&session_id);
    // L4（F12）：失败收口同样排空审计落库 worker（注销即释放桥引用
    // 发出通道关闭信号；await 保证失败收口前审计底账完整落库；
    // None = 测试驱动路径未装配）。先 take 出句柄再 await：
    // std Mutex 锁不跨 await 持有（AA-02）
    let audit_worker = active
        .audit_persist
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(handle) = audit_worker {
        let _ = handle.await;
    }
    // T-AB-19 失败收口显式接线（与成功收口同一契约）：不清理后台任务
    // 注册表、不级联杀任务——任务属会话级；仅释放「当前 run」上下文。
    state.background.clear_current_run(&run_id);
    // T-D-13：spawner 侧 run 上下文释放 + 子代理终态收口（防御性失败
    // 路径同样归一 failed——记账释放 / 行更新 / 事件发射 / 通知面）
    state.subagent_spawner.clear_current_run(&active.session_id, &run_id);
    if let Some(cfg) = active.subagent.clone() {
        state
            .on_subagent_run_terminal(&cfg, conex_db::RunStatus::Failed)
            .await;
    }
    state.save_snapshot_now().await;
}

/// 错误文案 → CrishErrorPayload（lastError 槽载荷；77 码显式兜底）
fn crish_payload_from_message(message: &str) -> CrishErrorPayload {
    CrishError::new(codes::COMMON_UNKNOWN, message.to_string()).to_error_payload(0)
}

/// 活动 run 查找（命令入口共用）
fn active_run(state: &CoreRunState, run_id: &str) -> Result<Arc<ActiveRun>, CoreError> {
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(run_id)
        .cloned()
        .ok_or_else(|| CoreError::NotFound(format!("run 不存在或已终态：{run_id}")))
}

/// 逃逸监视根解析（30-P5 共用 helper，与 loop 装配块 with_options 解析链
/// 同源：workspace_root → cwd → 当前目录；壳层 workspace_root 恒 None，
/// 等效 cwd → current_dir）。
///
/// run 装配面的三处根解析共用本函数（单一真源，杜绝双处漂移复发——
/// 00 风险 2）：逃逸监视 spawn 根 / 共享写路径注册表根 / 子代理沙箱根。
/// None（无 cwd）时监视不启动、注册表以 current_dir 为根、run 装配不
/// panic（E2E-3 无 cwd 分支）。
fn resolve_escape_watch_root(cwd: Option<&str>) -> PathBuf {
    cwd.map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

// ── 命令：core_run_task ───────────────────────────────────────────

/// 发起一次 run（03 §3.2 A 组；返回 {runId, sessionId} 回执）
///
/// 流程：门禁（restore 完成 + engine 就绪 + 会话内串行）→ start_run →
/// EventQueue（base = 预热/懒计算 max+1，T08.8）→ 装配
/// （approval 门 / BridgeDeltaSink / SessionLoopProducer）→ spawn
/// [drive_run_loop]。system_prompt 入站经 build_system_prompt 规范化一次
/// （P1 B1：trim + 空值 → None），全链透传原始。
///
/// T-29（P4 阶段 1-3/1-4）：新增 `history`（前端 store 已完成消息，
/// 冷启动水合兜底）与 `context_window`（生效模型窗口元数据，P3 目录
/// 接线前由前端下发；T-33 预算钳制消费）。混合路线（P4 §3.2.3）：
/// 前端 history 为空/未传时回退引擎侧 SessionHistoryCache（缓存主，
/// run 收口写入的权威增量）；两者皆空 = 现状单消息 run（向后兼容）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskOptions {
    pub run_id: String,
    pub session_id: String,
    pub prompt: Option<String>,
    pub mode: Option<String>,
    pub cwd: Option<String>,
    pub permission_mode: Option<String>,
    pub client_message_id: Option<String>,
    pub assistant_client_message_id: Option<String>,
    pub system_prompt: Option<String>,
    pub history: Option<Vec<HistoryMessage>>,
    pub context_window: Option<u32>,
    /// 父 run 归属（T-D-14 权限传递层，F11 T-D-13 spawner 装配时携带）：
    /// None = 主 agent run / 无父 run（审批裁决者 = 用户，现状不变）；
    /// Some = 子代理 run 的父 run id（审批请求路由给主 agent 裁决）
    pub parent_run_id: Option<String>,
    /// 子代理 run 装配配置（T-D-13：仅引擎内部 spawner 构造；IPC 命令面
    /// 不携带——serde 缺省 None = 普通 run，装配行为与现状一致）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_config: Option<crate::subagent_spawner::SubagentRunConfig>,
    /// D5 §3.1：goal 模式三字段（serde camelCase 由结构体级
    /// rename_all 覆盖；缺省 None 向前兼容——旧前端未发字段行为与现状
    /// 一致；serde 先例 = subagent_config）。激活装配在 run_task_impl
    /// mode=="goal" 分支（缺省 max_rounds 12 / max_stalled_rounds 2）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_goal: Option<String>,
    /// D5 §3.1：goal 轮次上限（None → 引擎缺省 DEFAULT_GOAL_MAX_ROUNDS=12）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<u32>,
    /// D5 §3.1：goal 连续空转上限（None → 引擎缺省 2）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_stalled_rounds: Option<u32>,
}

#[tauri::command]
pub(crate) async fn core_run_task(
    state: tauri::State<'_, Arc<CoreRunState>>,
    options: RunTaskOptions,
) -> Result<RunTaskResponse, CoreError> {
    run_task_impl(Arc::clone(state.inner()), options).await
}

/// estop 桥装配判定（31 评审 F2 / 30 评审 H-2 邻接）：**仅主 run 装配**——
/// 子代理 run 不 reset_estop、不挂 watcher。故障链：子代理 run 被取消
/// （L3/超时/kill_all）→ watcher 触发 cancel_estop → 急停旗置位 → 主 run
/// 本 run 剩余全部 browser_* 命令被 EmergencyStop 拒绝且同 run 无复位点
/// （浏览器操作整段失效，直到下一 run 启动）。browser_* 工具已按 27 §3
/// 从子代理注册面剔除（F1，readonly.rs filter_registry_for_task_type），
/// 子代理无 estop 消费方，装配即纯风险。
fn assemble_browser_estop(
    subagent_config: &Option<crate::subagent_spawner::SubagentRunConfig>,
) -> bool {
    subagent_config.is_none()
}

/// D6 决策 1：用户发起 run 判定（自动续 run 模式不写不清 user_stopped——
/// idle-resume / recovery-retry / content-resume / goal-continue 为引擎
/// 自主行为；其余（None / task / goal 等用户下发模式）视为用户新 run，
/// 装配时清除停止标记恢复自动行为）
fn is_user_initiated_mode(mode: Option<&str>) -> bool {
    !matches!(
        mode,
        Some("idle-resume" | "recovery-retry" | "content-resume" | "goal-continue")
    )
}

/// run 任务命令体（core_run_task 与 T-CF-11 idle 续 run 共用装配路径；
/// 测试可直调，不依赖 Tauri runtime——对齐 background.rs「契约体」模式）。
/// owned Arc 参数：future 内不持有引用，保证 Send（spawn 任务内可 await）。
pub(crate) async fn run_task_impl(
    state: Arc<CoreRunState>,
    options: RunTaskOptions,
) -> Result<RunTaskResponse, CoreError> {
    let state = Arc::clone(&state);
    // 参数校验（S-15：trim + 显式 InvalidInput）
    let run_id = options.run_id.trim().to_string();
    let session_id = options.session_id.trim().to_string();
    let prompt = options.prompt;
    let mode = options.mode;
    let cwd = options.cwd;
    let permission_mode = options.permission_mode;
    let client_message_id = options.client_message_id;
    let assistant_client_message_id = options.assistant_client_message_id;
    let system_prompt = options.system_prompt;
    let history = options.history;
    let context_window = options.context_window;
    // T-D-13：子代理 run 装配配置（None = 普通 run，装配行为与现状一致）
    let subagent_config = options.subagent_config;
    // T-D-14：父 run 归属（审批裁决者路由 + spawner 侧 run 注册表——先于
    // SessionLoopOptions 遮蔽取出，避免「options 已被 move」借用错误）
    let parent_run_id = options.parent_run_id.clone();
    // D5 §3.1：goal 模式三字段（mode=="goal" 装配输入；None 缺省由
    // [GoalState::with_defaults] 落引擎缺省 12/2，D5 §3.1 缺省规则）
    let visible_goal = options.visible_goal;
    let max_rounds = options.max_rounds;
    let max_stalled_rounds = options.max_stalled_rounds;

    if run_id.is_empty() || session_id.is_empty() {
        return Err(CoreError::invalid_input("runId / sessionId 不能为空"));
    }
    // T08.6 门禁：restore 完成前拒绝新 run（Q24 竞态：杜绝「新 run 先算
    // base、restore 后写审计事件」）
    if !state.restore_ready() {
        return Err(CoreError::internal("restore in progress：等待重启恢复完成"));
    }
    // engine 未就绪（provider 配置缺失）拒绝发起
    if !state.engine.ready() {
        let reason = state
            .engine
            .ready_reason()
            .unwrap_or_else(|| "engine not ready".to_string());
        return Err(CoreError::internal(reason));
    }
    // 会话内串行守卫（同会话同时只允许一个活动 run）
    {
        let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        if active.values().any(|run| run.session_id == session_id) {
            return Err(CoreError::invalid_input(format!(
                "会话 {session_id} 已有活动 run（串行守卫）"
            )));
        }
    }
    // D6 §3.2 spawn 点 2：会话首次出现惰性 spawn watcher（幂等——已
    // 存在跳过；防重入靠本串行守卫兜底，验收 A5）。子代理 run 不
    // spawn：子代理会话无 watcher 拉起语义（收口即终态），且共享队列
    // 会让 sub-sess-* 会话 watcher 误消费主会话条目（D6 §6 风险 7）
    if subagent_config.is_none() {
        state.ensure_wake_watcher(&session_id);
    }
    // D6 决策 1：用户发起的普通 run 装配 → 清除会话级 user_stopped
    // （用户新 run = 显式授权恢复自动行为；idle-resume / 恢复类 / 子
    // 代理 run 不写不清——停止语义跨 run 存活直到用户介入）
    if subagent_config.is_none() && is_user_initiated_mode(mode.as_deref()) {
        state.clear_user_stopped(&session_id);
    }
    // D5 §3.1/§3.8：goal 模式装配分支（mode=="goal" 且 visible_goal
    // 非空才装配）。写面 = 本装配点 + 收口 RoundAssessment（唯一写方）：
    // - 新 /goal 覆盖旧 goal_state（round 计数归零、新
    //   max_rounds/max_stalled_rounds，D5 §3.8 覆盖语义）；
    // - 缺省规则：max_rounds None → 12、max_stalled_rounds None → 2
    //   （[GoalState::with_defaults]，D5 §3.1）；
    // - 其余 mode（含 goal-continue 续轮 run）不创建不清理——普通 run
    //   保留挂起 goal_state（goal 是会话级长期意图），续轮由收口推进
    //   不覆盖（D5 §3.8 模式切换）。
    let goal_started: Option<(String, u32)> = if mode.as_deref() == Some("goal") {
        if let Some(goal_text) = visible_goal.filter(|goal| !goal.trim().is_empty()) {
            let goal_state = GoalState::with_defaults(goal_text, max_rounds, max_stalled_rounds);
            let started = (goal_state.goal.clone(), goal_state.max_rounds);
            state.save_goal_state(&session_id, &goal_state).await;
            tracing::info!(
                target: "run",
                session_id = %session_id,
                run_id = %run_id,
                goal = %goal_state.goal,
                max_rounds = goal_state.max_rounds,
                "goal 模式装配：goal_state 键已初始化（新 /goal 覆盖语义）"
            );
            Some(started)
        } else {
            None
        }
    } else {
        None
    };
    // provider / 工具注册表（engine 生效配置）
    let Some(provider) = state.engine.provider() else {
        return Err(CoreError::internal("engine not ready（provider 配置缺失）"));
    };
    // T-D-13：子代理 run 的工具注册表按 task_type 默认权限集裁剪
    // （filter_registry_for_task_type，T-D-08 fail-closed 白名单）+ 剔除
    // run_subagent（T-D-02 工具面防护：子代理无派发能力，防浪费非安全
    // 边界；守卫层 NestingDenied 兜底）+ 剔除 kill_subagent / send_message
    // （D4 §3.3/§3.10 + E3：仅主 agent 工具集——子代理无关闭/消息注入
    // 能力，防「子代理伪装主 agent」；剔除决策权威位在引擎装配点，
    // filter_out_subagent_spawner 本体与锁定测试零改动）。普通 run 保持
    // 引擎共享注册表。
    let base_registry = state.engine.tool_registry();
    let tool_registry = match &subagent_config {
        Some(config) => {
            let task_type_wire = config.task_type.as_deref().unwrap_or("analysis");
            let filtered = agent_tools::readonly::filter_registry_for_task_type(
                &base_registry,
                task_type_wire,
            )
            .map_err(|error| {
                CoreError::internal(format!("子代理工具集裁剪失败：{error}"))
            })?;
            let filtered = agent_tools::readonly::filter_registry(&filtered, |name| {
                name != agent_tools::tools::subagent::SUBAGENT_SPAWNER_TOOL_NAME
                    && name != agent_tools::tools::kill_subagent::SUBAGENT_KILL_TOOL_NAME
                    && name != agent_tools::tools::send_message::SEND_MESSAGE_TOOL_NAME
            })
            .map_err(|error| {
                CoreError::internal(format!("子代理工具集剔除失败：{error}"))
            })?;
            Arc::new(filtered)
        }
        None => base_registry,
    };

    // 注册 run（queued → initializing → running，落库）
    let handle = state
        .run_manager
        .start_run(&session_id, &run_id)
        .await
        .map_err(crate::core_error::map_run_err)?;
    let handle_shared = Arc::new(tokio::sync::Mutex::new(handle));

    // 事件队列（base = 预热/懒计算 max+1，T08.8：不重置为 1）
    let base = state.base_sequence_for(&session_id).await;
    let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
        state.store.clone(),
        base,
    )));

    // 本 run 的缓冲事件桥（gate 广播 / delta sink / 收口 emit 共用）
    let bridge = Arc::new(BufferedRunEventBridge::new(
        state.bridge.clone(),
        run_id.clone(),
    ));

    // 审批门广播（approval-requested 实时预览：信封 sequence=None）
    let broadcast_bridge = Arc::clone(&bridge);
    let broadcast_run_id = run_id.clone();
    let broadcast = Box::new(move |event: AgentEvent| {
        let envelope = AgentEventEnvelope::new(event, Some(broadcast_run_id.clone()), None);
        broadcast_bridge.emit(&envelope);
        broadcast_bridge.flush();
    });
    // 死锁检测器（F9-05）待接：with_deadlock_detector 的 detector 需要
    // 「主 agent 正在 wait 该子代理」信号源——引擎侧尚无 orchestrator 子
    // 代理跟踪器的 await 态标记（approval_router.rs:41-45 自述的 F11
    // T-D-13 引擎接线未落地）。缺省 None = 恒走纯超时兜底（120s Expired），
    // 行为与现状一致；信号源落地后在此注入。
    let approval_gate = Arc::new(ApprovalGateImpl::new(
        run_id.clone(),
        session_id.clone(),
        // T-D-14：父 run 归属（子代理 run 由 spawner 携带；None = 主 agent）
        parent_run_id.clone(),
        broadcast,
        Arc::clone(&handle_shared),
        state.store.clone(),
        cwd.clone(),
    ));

    // permissionMode：full-access 不启用审批；其余（ask / plan）启用
    let approval_enabled = permission_mode.as_deref() != Some("full-access");
    let approval: Option<Arc<dyn ApprovalGate>> = if approval_enabled {
        Some(Arc::clone(&approval_gate) as Arc<dyn ApprovalGate>)
    } else {
        None
    };

    // T09.1 实时 delta 双轨：BridgeDeltaSink 注入 SessionLoopProducer
    // （core_run_commands.rs:667-716 装配，PE-09 T09.1.2 步骤 4）
    let delta_sink: Arc<dyn DeltaSink> = Arc::new(BridgeDeltaSink::new(
        Arc::clone(&bridge),
        run_id.clone(),
    ));

    // ── T-29 context_window 入站（P4 §3.3.2）──────────────────────
    // 生效模型窗口 → ContextBudget（reserve/safety 取默认）；经
    // SessionLoopOptions.context_budget 透传（T-30 装配，T-33 预算层
    // 消费钳制与预检）。DEEPCHECK-06 P0：子代理 run 的窗口入站由引擎
    // 按生效模型 catalog 解析（spawner 路径前端参数不可达，context_window
    // 恒 None——resolve_context_budget 的 subagent 兜底臂，与主会话前端
    // resolveContextWindow 的 catalog 兜底同源）。
    let context_budget = resolve_context_budget(context_window, &subagent_config, &state.engine);
    if let Some(budget) = context_budget {
        tracing::debug!(
            target: "run",
            session_id = %session_id,
            context_window = budget.context_window,
            reserve_tokens = budget.reserve_tokens,
            "context_window 入站（T-33 预算钳制消费）"
        );
    }

    // 循环选项（cwd / assistant clientMessageId / 幂等；21-log §5.2 回补）
    // P1 B1：systemPrompt 入站规范化一次（trim + 空值 → None），全链透传原始
    // P4 T-30：context_budget 装配进 options（预算钳制 + 预检压缩消费入口）

    // ── T-ESC-03 P3 装配面：逃逸监视启动钩子（run 开始）──────────
    // 监视根 = cwd（工作目录，run 驱动的工作区根）；watcher.start →
    // 消费任务 spawn（聚合 → 审计发射 + 主 agent 注入，REQ §3.5.1），
    // 句柄绑定 ActiveRun 随 run 收口（shutdown = stop + flush 剩余）。
    // 监视启动失败仅告警不阻断 run（监视是追踪面，REQ §3.6 不阻断）。
    //
    // 30-P5 时序更正（A4-H1 / C-36 假闭环消除）：判定器在本装配点直接
    // 注入（spawn_escape_watch 的 config 是值传递，装配后即就位，不再
    // 依赖 loop 侧 with_options 的配置副本）——detector 与 write_claims
    // 同一 registry 实例（双端注入成对，评审清单项）：
    // - 工具执行面声明写路径（options.write_claims 注入共享注册表）→
    //   声明覆盖静默（审计不误报）；
    // - 声明释放 / 未声明写入 → 上报（未声明写审计）。
    //
    // 15-T-6（裁决 D9）：run 级审计桥实例（工具级审计路由与逃逸监视
    // 共用——同一 run 缓冲事件桥双注入，无重复广播；注册语句见下方
    // 装配块）。L4（F12）：审计底账落库接线——持久化通道 + 单 worker
    // （按发射序 reserve + append_event 落库 events 表；句柄随
    // ActiveRun 收口 await 排空，终态前落库完成）
    let (audit_persist_tx, audit_persist_rx) = tokio::sync::mpsc::unbounded_channel();
    let audit_worker = spawn_audit_persistence(
        Arc::clone(&queue),
        session_id.clone(),
        audit_persist_rx,
    );
    let bridge_audit_sink = Arc::new(BridgeAuditSink::new(
        Arc::clone(&bridge),
        run_id.clone(),
        audit_persist_tx,
    ));
    let escape_root = resolve_escape_watch_root(cwd.as_deref());
    let control_bus = Arc::new(Mutex::new(ControlBus::new()));
    // 30-P5：共享写路径注册表（会话级，与逃逸监视根同源）——工具执行
    // 面与逃逸判定器读同一实例；loop 侧 with_options 解析链
    // （options.write_claims 优先）保持同源
    let shared_registry = Arc::new(WritePathRegistry::new(session_id.clone(), &escape_root));
    // 30-P1：每 run 新建 abort 信号（M3 契约「每 run 重建 loop + 新信号」——
    // AbortSignal 共享 AtomicBool 不可复位，跨 run 泄漏语义禁止复用；
    // 同一实例注入 ActiveRun 与 loop，L3 强停 / kill_all 经同一触发面）。
    // AbortSignal::reset 不实现（Notify 无法复位，跨 run 泄漏语义登记
    // A4-M3 邻接，以「每 run 新信号」契约兜底）
    let abort_signal = AbortSignal::new();
    // ── 27 方案 S5：browser estop 桥（M-2，run 级 abort → CDP 发送层取消）──
    // 三层信号联动（27 §1.3 表）：run 级 AbortSignal（L3 强停/用户取消）
    // → 浏览器会话槽 estop 令牌（发送层在途命令逐 id 取消 +
    // CdpError::Cancelled）+ 急停旗（新命令拒绝）。每 run 先 reset_estop
    // 换新周期——新 run 不继承上一 run 的取消态（防跨 run 毒化会话）；
    // 急停旗随下一启动周期复位（browser/mod.rs BrowserSlot::reset_estop）。
    // 并发 run 共享同一 estop 周期（最后复位者生效）：多 run 并发操作
    // 同一浏览器实例登记遗留（27 §6 P1 会话归属迁移）。
    // 31 评审 F2（P1）：装配判定见 [assemble_browser_estop]——仅主 run
    // （subagent_config = None）装配；子代理 run 不装配（杜绝「子代理
    // abort → cancel 主 run estop」故障链）。
    if assemble_browser_estop(&subagent_config) {
        let browser_slot = state.engine.browser_slot();
        browser_slot.reset_estop();
        crate::browser::spawn_browser_estop_watcher(browser_slot, abort_signal.clone());
    }
    let (escape_watch, escape_config) = if let Some(dir) = cwd.clone() {
        let root = PathBuf::from(dir);
        let config = EscapeWatchConfig::new(
            root.clone(),
            session_id.clone(),
            run_id.clone(),
            // 15-T-6：与工具级审计路由共用同一 run 级桥（同一
            // BridgeAuditSink 实例双注入，无重复广播）
            Arc::clone(&bridge_audit_sink) as AuditSink,
        )
        .with_injector(Arc::new(ControlBusInjector::new(Arc::clone(&control_bus))))
        // 30-P5：判定器在 spawn 前注入（与 write_claims 同一 registry
        // 实例——声明写静默 / 未声明上报；消除 detector 恒 None 的
        // C-36 假闭环）
        .with_detector(Arc::new(RegistryBackedDetector::new(Arc::clone(
            &shared_registry,
        ))));
        match spawn_escape_watch(root, config.clone()) {
            Ok(handle) => {
                tracing::info!(
                    target: "run",
                    run_id = %run_id,
                    "逃逸监视已启动（T-ESC-03）"
                );
                (Some(handle), Some(config))
            }
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    run_id = %run_id,
                    error = %error,
                    "逃逸监视启动失败（仅告警，run 继续）"
                );
                (None, None)
            }
        }
    } else {
        (None, None)
    };

    // ── 15-T-6（裁决 D9）：工具级审计路由注册（run 级桥）──────────
    // 工具级 security-audit（shell/delete 经 BuiltinToolConfig.audit_sink
    // 发射，接线前 NoopAuditSink 静默丢弃）经路由 sink 送达本 run 缓冲
    // 事件桥（信封注入 run_id → 前端审计面板 per-run 面实时可见，34-T7
    // 口径；L4（F12）已补落库面——审计底账经持久化 worker 写入 events
    // 表，见 [spawn_audit_persistence]）。与逃逸监视共用同一
    // BridgeAuditSink 实例（同一 run 桥双注入，无重复广播）。
    // **域隔离边界**（30 §9 最终口径）：任务域审计（10-P3
    // TaskAuditAccumulator → EventBridge 直发，operation=command-exec）
    // **不经本路由 sink**——本卡只承接工具级审计，两路均以
    // security-audit 事件形态经 run 桥到达前端，无重复无遗漏。
    // 收口注销在 drive_run_loop / finalize_failed 强制执行（防泄漏）。
    state
        .engine
        .audit_sink()
        .register(&session_id, Arc::clone(&bridge_audit_sink) as AuditSink);

    // ── T-D-13：子代理 run 装配块（默认权限集 / 提示词注入 / 配额）──
    // 普通 run（subagent_config = None）全部保持现状（None 不装配）。
    // - 写路径沙箱（T-D-08）：显式 allowed_write_paths → WritePathPolicy
    //   注册（Allowed 优先）；无显式字段且 implementation → 工作区根沙箱；
    //   其余类型工具面/配额面闭合，不注册策略（不强制越权检查）；
    // - 权限申请上下文（T-D-14）：design/review 装配配额凭证
    //   （granted=true quota=1，session_meta 后端）；
    // - 提示词注入（ContextInjector）：T-D-03 角色约束段 + C2 started_at
    //   段 + git 回退指引段 + T-D-14 权限申请指引段 + 产出目录段
    //   （主控已定产出目录时）。
    let subagent_injector: Option<ContextInjector> = None;
    let subagent_write_registry: Option<Arc<WritePathRegistry>> = None;
    let subagent_quota: Option<ExploreDocsQuotaContext> = None;
    let (subagent_write_registry, subagent_quota, subagent_injector) =
        match &subagent_config {
            None => (subagent_write_registry, subagent_quota, subagent_injector),            Some(config) => {
                // 工作区根解析链（30-P5：与 loop 装配块同源，经共用 helper
                // resolve_escape_watch_root——单一真源，杜绝双处漂移复发；
                // 壳层 workspace_root 恒 None，等效 cwd → current_dir）
                let root = resolve_escape_watch_root(cwd.as_deref());
                // 写路径沙箱装配
                let write_registry = match &config.allowed_write_paths {
                    Some(paths) => {
                        let policy = WritePathPolicy::from_entries(&root, paths.clone())
                            .map_err(|error| {
                                CoreError::internal(format!("写路径白名单解析失败：{error}"))
                            })?;
                        Some(Arc::new(
                            WritePathRegistry::new(session_id.clone(), &root)
                                .with_write_policy(policy),
                        ))
                    }
                    None => match config.task_type.as_deref() {
                        // implementation 默认 = 工作区根沙箱（Allowed 白名单）
                        Some("implementation") => Some(Arc::new(
                            WritePathRegistry::new(session_id.clone(), &root)
                                .with_write_policy(WritePathPolicy::Allowed(vec![root.clone()])),
                        )),
                        // 其余类型：工具面（只读/仅 shell）+ 配额面闭合，
                        // 不注册策略（越权检查不强制）
                        _ => None,
                    },
                };
                // 权限申请上下文（design/review 配额凭证；T-D-14）
                let quota = match config.task_type.as_deref() {
                    Some("design") | Some("review") => state.local_db().map(|db| {
                        ExploreDocsQuotaContext {
                            session_id: session_id.clone(),
                            run_id: run_id.clone(),
                            granted: true,
                            quota: 1,
                            store: Some(Arc::new(
                                conex_db::SessionMetaExploreDocsQuotaStore::new(db),
                            )),
                        }
                    }),
                    _ => None,
                };
                // 提示词注入段装配（M1 挂载形状：title + content → push）
                let mut injector = ContextInjector::new();
                // T-D-03：子代理角色约束（主 Agent run 装配点不调用——
                // 「主 Agent run 不含本段」断言的关键差异点）
                crate::engine::push_subagent_role_constraint(&mut injector);
                // C2：started_at 段 + git 回退谨慎指引（started_at 与落库同源）
                for (title, content) in agent_tools::subagent_inject::subagent_session_injections(
                    Some(config.started_at_ms),
                    agent_tools::subagent_inject::DEFAULT_REF_AGE_THRESHOLD_HOURS,
                ) {
                    injector.push(ContextInjection::new(
                        ContextInjectionKind::System,
                        title,
                        content,
                    ));
                }
                // T-D-14：权限申请指引段（任务类型 + 一句话边界参数化）
                let boundary = config
                    .task_type
                    .as_deref()
                    .and_then(agent_tools::tools::subagent::TaskType::parse)
                    .map(|t| t.boundary_summary());
                let (title, content) =
                    agent_tools::subagent_inject::permission_relay_injection(
                        config.task_type.as_deref(),
                        boundary,
                    );
                injector.push(ContextInjection::new(
                    ContextInjectionKind::System,
                    title,
                    content,
                ));
                // 产出目录段（主控已定产出目录时注入）
                if let Some(dir) = &config.output_dir {
                    let (title, content) = agent_tools::subagent_inject::output_dir_injection(dir);
                    injector.push(ContextInjection::new(
                        ContextInjectionKind::System,
                        title,
                        content,
                    ));
                }
                (write_registry, quota, Some(injector))
            }
        };

    // ── D1 §3.1.4/§3.2.3：退避与熔断配置装配（读 session_meta 键；
    //    None = 向后兼容：立即重试 / 不启用熔断闸）──
    // - retry_backoff：`provider_retry_backoff_ms` 键 → 内核退避
    //   （750ms×2^(n-1)/8s 封顶/60s 预算/Retry-After 放行）生产生效；
    // - provider_fail_streak：`provider_fail_streak` 键 count → 熔断闸
    //   C1 输入（transient_retry 入口 >= 阈值直接 fatal）。熔断计数落
    //   键在收口 [Self::update_provider_fail_streak]（唯一写方），本装配
    //   点只读注入——天然跨 run（D1 §3.2.3 装配时序）。
    let retry_backoff = state.retry_backoff_config(&session_id);
    let provider_fail_streak = state.provider_fail_streak_count(&session_id).await;

    let options = SessionLoopOptions {
        cwd: cwd.clone(),
        assistant_client_message_id: assistant_client_message_id.clone(),
        // P1 B1：systemPrompt 入站规范化一次 + E2 F5 阶段总结段注入
        // （build_system_prompt 输出后拼接「阶段总结：N 条」段——零对话
        // 污染、天然跨 run 携带，E2 §6.3 主选；无总结时行为与接线前一致）
        system_prompt: assemble_system_prompt_with_stages(&state, &session_id, system_prompt),
        context_budget,
        // D1 §3.1.4（R6）：瞬态重试退避配置（session_meta 键注入；
        // None = 现状立即重试向后兼容）
        retry_backoff,
        // D1 §3.2.3：会话级熔断计数当前值（transient_retry 入口闸 C1
        // 输入；None = 不启用闸）
        provider_fail_streak,
        // T-ESC-03：逃逸监视配置透传（装配上下文，LoopState 不消费）
        escape_watch: escape_config,
        // T-EG-05（F7）：写前自动备份中间件装配（S10b）——备份根经
        // with_defaults(None) 执行期回退工作区 `.crish-trash`，与 UI 删除
        // 命令（trash_root_for 未注入时兜底，core_run_commands.rs:2356）及
        // 工具侧 BuiltinToolConfig.trash_root（引擎装配处亦为 None）同源，
        // 保证恢复面板与写前快照落入同一回收站根；中间件链经
        // options.tool_middleware → loop/mod.rs:343 with_middleware 同步到
        // 工具执行器（消费侧循环装配由 F7 T-EG-06 负责，本处只做 options
        // 侧构造）。
        tool_middleware: vec![Arc::new(BackupMiddleware::with_defaults(None))],
        // T-D-14 权限传递层：父 run 归属透传执行器（审批请求来源判定与
        // 裁决者路由依据；None = 主 agent run，现状行为）
        parent_run_id: parent_run_id.clone(),
        // T-D-13：子代理 run 的写路径沙箱注册表（with_write_policy 装配；
        // 子代理沙箱优先，策略注册逻辑不动）；普通 run 由 None 变
        // Some(shared_registry)——30-P5：与逃逸判定器同一实例（双端注入
        // 成对：工具声明写不误报未声明）
        write_claims: subagent_write_registry
            .clone()
            .or_else(|| Some(Arc::clone(&shared_registry))),
        // T-D-13：子代理 run 的配额上下文（design/review 凭证；None =
        // 主 agent 不受配额约束，现状行为）
        explore_docs_quota: subagent_quota.clone(),
        // COMPACTION-01 P0-1（生产闭环）：压缩策略装配——默认 20000/2/1024
        // （conex-compaction 常量）经 session_meta 键覆盖（compact_summary_
        // max_tokens 等，读取键不实现 UI）；装配后预检压缩在生产可触发
        // （此前走 ..Default::default() 回落到 None，预检/溢出恒不触发）
        compaction_policy: state.compaction_policy_for(&session_id),
        // T-42/T-43/T-44（记忆韧性轮次 6）：摘要后台面三线装配——
        // - summarizer：会话级 Summarizer 工厂解析（生产工厂 = 真实 LLM
        //   实现 ProviderSummarizer，COMPACTION-01 P0-3 闭环；无注入 →
        //   None → 不 spawn，纯 stub awaiting 永驻，与接线前行为一致）；
        // - summary_dispatch：session_meta 配置面（compact_summary_backoff_ms
        //   / compact_summary_wall_ms；无键 = None = 生产缺省退避参数）；
        // - summary_coordinator：会话级协调器（跨 run 单飞 + 全局并发
        //   上限 ≤2 + 任务跨 run 存活；默认回调落 compression_blocks 表）
        summarizer: state.summarizer_for(&session_id),
        summary_dispatch: state.summary_dispatch_config(&session_id),
        summary_coordinator: Some(state.summary_coordinator_for(&session_id)),
        // Round7：笔记后端真注入（与 engine produce 双保险；同源
        // note_runtime 进程句柄 / app_dir()/workspace.db）
        note_backend: crate::note_runtime::try_backend(),
        ..SessionLoopOptions::default()
    };
    let tool_options = ToolBatchOptions {
        approval_enabled,
        // R4 T10：permission_mode 显式下传时按 dangerous 标记三态判定
        // （ask 问询 / plan 拒绝写类 / full-access 放行）；None = 既有语义
        permission_mode: permission_mode
            .as_deref()
            .map(|mode| PermissionMode::from_engine_str(Some(mode))),
        ..ToolBatchOptions::default()
    };
    // 用户消息（clientMessageId 透传，03 §5.3-4）
    let message =
        crate::engine::user_message(&prompt.unwrap_or_default(), client_message_id.as_deref());

    // ── T-29/T-30 历史参数装配（P4 §3.2.3 混合路线）───────────────
    // 前端 history（store 已完成消息）为冷启动水合兜底；为空/未传时回退
    // SessionHistoryCache（引擎侧缓存主，run 收口写入的权威增量）。
    // 产出 initial_conversation（Vec<Arc<AgentMessage>>）：前端载荷走
    // T-28 hydrate_history（过滤 + 尾部 user 截断），缓存走保真水合
    // （工具结果配对不拆散）。已由 T-30 物理接线：经
    // SessionLoopProducer::initial_conversation 字段传入 produce，
    // 由 with_initial_conversation_arc 零拷贝水合。
    let assembled_history =
        resolve_history_source(&history, state.session_history.get(&session_id));
    let initial_conversation: Option<Vec<Arc<AgentMessage>>> = assembled_history
        .as_ref()
        .map(|(source, payload)| match source {
            HistorySource::Frontend => hydrate_history(payload.clone()),
            HistorySource::Cache => cached_history_to_conversation(payload.clone()),
        });
    tracing::debug!(
        target: "run",
        session_id = %session_id,
        source = ?assembled_history.as_ref().map(|(source, _)| source),
        hydrated = initial_conversation.as_ref().map(Vec::len).unwrap_or(0),
        "历史装配完成（前端水合兜底 / 引擎缓存主）"
    );

    let producer = SessionLoopProducer::new(
        session_id.clone(),
        run_id.clone(),
        MAX_TURNS_DEFAULT,
        provider,
        tool_registry,
        options,
        tool_options,
        approval,
        Some(delta_sink),
        initial_conversation,
        message,
    )
    // T-40（P5 S5 §3.2，R5-D3 轮末合并接线 ①）：缓存测量装配——
    // with_cache_tracking：tracking 配置（provider / model / TTL，
    // engine 侧 cache_tracking_config 产出；None = 不测量，行为与现状
    // 一致）；with_cache_session：上一 run 会话缓存状态（冷缓存预警 +
    // 模型切换检测数据源，engine 侧 cache_session 按会话维护）
    .with_cache_tracking(state.engine.cache_tracking_config())
    .with_cache_session(state.engine.cache_session(&session_id))
    // T-D-13：子代理 run 的上下文注入通道（角色约束 / started_at /
    // 权限申请指引 / 产出目录段；None = 无注入，system_prompt 原样透传）
    .with_context_injector(subagent_injector)
    // 30-P1：run 控制面接线——壳层与 loop 同源（同一控制总线 + 同一
    // abort 信号实例；check_control 安全点消费，运行中 run 有真实外部
    // 终止路径：core_run_control → 总线 → run 终止，L3 ≤ 下一安全点
    // 收场）。builder 顺序契约：with_* 在 run() 前（produce 内装配，
    // loop/mod.rs with_control_bus 注释）
    .with_control_bus(Arc::clone(&control_bus))
    .with_abort_signal(abort_signal.clone());

    // T-AB-19：登记当前 run 上下文（owner_run_id 注入槽）——须在 spawn
    // drive_run_loop 之前，保证 run 内工具执行链 adopt 时已可见；run
    // 终态（drive_run_loop 收口 / finalize_failed）经 clear_current_run 释放。
    state.background.set_current_run(&run_id);
    // T-D-13：spawner 侧 run 上下文登记（深度记账 + 当前活动 run 定位——
    // 子代理 spawn 时按发起会话解析父 run；收口经 clear 释放）
    state
        .subagent_spawner
        .register_run(&run_id, &session_id, parent_run_id.clone());
    state.subagent_spawner.set_current_run(&session_id, &run_id);

    // 注册活动 run 并 spawn 驱动循环
    let active = Arc::new(ActiveRun {
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        handle: handle_shared,
        queue,
        control_bus: Arc::clone(&control_bus),
        // 30-P1：与 loop 共享同一信号实例（克隆即同一触发面；L3 强停
        // 经 ActiveRun.abort_signal 或 run_control_impl 任一入口生效）
        abort_signal: abort_signal.clone(),
        approval: approval_gate,
        bridge,
        delta_sink_active: true,
        escape_watch: Mutex::new(escape_watch),
        user_touched: AtomicBool::new(false),
        // 30-P1：spawn 句柄经 set_driver 事后登记（构造在前、spawn 在后）
        driver: Mutex::new(None),
        // T-D-13：子代理 run 装配配置随活动 run 登记（收口终态处理依据）
        subagent: subagent_config.clone(),
        // L4（F12）：审计落库 worker 句柄（收口处 take + await 排空）
        audit_persist: Mutex::new(Some(audit_worker)),
    });
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(run_id.clone(), Arc::clone(&active));
    // D5 §3.9：goal-round-started（mode=goal 装配轮 run 启动时发射；
    // round 从 1 计；载荷 goal/round/maxRounds 对齐 OrchestratorGoalRunState
    // 子集；envelope 通道，run 串行上下文）
    if let Some((goal, max_rounds)) = &goal_started {
        emit_envelope_event(
            &active.queue,
            &active.bridge,
            &active.run_id,
            &session_id,
            AgentEvent::GoalRoundStarted {
                round: 1,
                max_rounds: *max_rounds,
                goal: goal.clone(),
            },
        )
        .await;
    }

    // 30-P1 改动点 4：JoinHandle 管理——spawn 句柄存入 ActiveRun（驱动
    // 任务持同一 active 实例）；收口不 await（JoinHandle drop 即 detach，
    // tokio 语义，防挂起）；句柄供可观测与未来 join（测试经
    // driver_finished 轮询断言）
    let driver = tauri::async_runtime::spawn(drive_run_loop(
        state,
        Arc::clone(&active),
        Box::new(producer),
    ));
    active.set_driver(driver);

    tracing::info!(
        target: "run",
        session_id = %session_id,
        run_id = %run_id,
        mode = %mode.as_deref().unwrap_or("task"),
        permission_mode = %permission_mode.as_deref().unwrap_or("ask"),
        "core_run_task 已发起"
    );
    Ok(RunTaskResponse { run_id, session_id })
}

// ── 命令：core_run_control ────────────────────────────────────────

/// run 控制（03 §3.2 A 组：L0-L3 全枚举）
///
/// - `continue`（L0）：不入队（ControlBus 语义），no-op 返回 Ok；
/// - `soft_inject` / `steer` / `follow_up`（L1）：消息注入对应环，
///   不打断流（文本取 `message` 或 `payload.text`；环由 payload.kind
///   或 level 决定）；
/// - `cooperative_stop`（L2）：协作停止，等安全点收场（stopped，D1）；
/// - `force_cancel`（L3）：AbortSignal 强停 + 总线 force_cancel
///   （aborted 收场）。
#[tauri::command]
pub(crate) async fn core_run_control(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    level: String,
    message: Option<String>,
    reason: Option<String>,
    payload: Option<serde_json::Value>,
) -> Result<(), CoreError> {
    run_control_impl(state.inner(), run_id.trim(), &level, message, reason, payload).await
}

/// run 控制命令体（测试直调，不依赖 Tauri runtime；对齐 background.rs
/// 「契约体」模式）
pub(crate) async fn run_control_impl(
    state: &Arc<CoreRunState>,
    run_id: &str,
    level: &str,
    message: Option<String>,
    reason: Option<String>,
    payload: Option<serde_json::Value>,
) -> Result<(), CoreError> {
    let active = active_run(state, run_id)?;
    match level {
        // L0：继续当前 run（不入队）
        "continue" => Ok(()),
        // L1：软注入（不打断流；消息入 steer / followUp 环）
        "soft_inject" | "steer" | "follow_up" => {
            let text = message
                .or_else(|| {
                    payload
                        .as_ref()
                        .and_then(|p| p.get("text"))
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                })
                .ok_or_else(|| {
                    CoreError::invalid_input("soft_inject 需要 message / payload.text")
                })?;
            // payload.kind 优先决定环（runControlClient.ts: follow_up /
            // soft_inject / steer 变体）
            let follow_up = payload
                .as_ref()
                .and_then(|p| p.get("kind"))
                .and_then(serde_json::Value::as_str)
                .map(|kind| kind == "follow_up")
                .unwrap_or(level == "follow_up");
            let injected = crate::engine::user_message(&text, None);
            // T-CF-11：用户经 L1 注入消息 → 标记用户交互（收口判定
            // 「用户消息到达后的正常收场不触发续 run」）
            active.user_touched.store(true, Ordering::SeqCst);
            let mut bus = active
                .control_bus
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if follow_up {
                bus.request_follow_up(injected, reason, Some("ui".to_string()));
            } else {
                bus.request_steer(injected, reason, Some("ui".to_string()));
            }
            Ok(())
        }
        // L2：协作停止（等安全点，不 hard abort）
        "cooperative_stop" => {
            // D6 决策 1：用户显式停止 → 会话级 user_stopped 标记（跨 run
            // 语义——watcher 与收口判定不再自动续，直到用户新 run 清除；
            // L2 不置 run 级 user_touched，会话级标记兜底 error 收场竞态）
            state.set_user_stopped(&active.session_id);
            let mut bus = active
                .control_bus
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            bus.request_cooperative_stop(
                Some(reason.unwrap_or_else(|| "ui-stop".to_string())),
                Some("ui".to_string()),
            );
            Ok(())
        }
        // L3：强停（可立即中断；AbortSignal + 总线）
        "force_cancel" => {
            // T-CF-11：用户显式取消 → 标记用户交互（收口不续 run 双保险）
            active.user_touched.store(true, Ordering::SeqCst);
            // D6 决策 1：会话级 user_stopped 标记（跨 run 语义——残留
            // 队列条目（已到期定时器等）不得自动拉起 run，直到用户新 run）
            state.set_user_stopped(&active.session_id);
            active.abort_signal.abort();
            {
                let mut bus = active
                    .control_bus
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                bus.request_force_cancel(
                    Some(reason.unwrap_or_else(|| "ui-force-cancel".to_string())),
                    Some("ui".to_string()),
                );
            }
            // T-AB-19 L0-L3 控制总线对接：L2 / L3 **不触碰任务**——任务属
            // 会话级，run 控制只作用于 run 本身（职责单一，避免误杀，对齐
            // 方案 REQ 4.3；l3_force_cancel_keeps_tasks 测试锚定）。可选联动
            // 默认关闭（配置项 CONEX_RUN_CONTROL_L3_TASK_CANCEL，见
            // [l3_force_cancel_tasks_enabled]）：开启时 L3 force 对「当前
            // run 的普通任务（is_daemon=false）」发起优雅终止（两阶段 kill，
            // best-effort，不阻断强停）。
            if l3_force_cancel_tasks_enabled() {
                state.background.graceful_stop_tasks_for_run(&active.run_id).await;
            }
            Ok(())
        }
        other => Err(CoreError::invalid_input(format!("未知 level：{other}"))),
    }
}

// ── E2 F4（07 §3 卡 C）：手动压缩命令 core_compact_now ─────────────
//
// slash /compact（别名 /压缩 /compress，可选目标 token 数）→ 本命令。
// 链路（E2 §5.2）：会话存在性 → 活动 run 检查（busy 拒绝，不打断活动
// 流）→ 对话源（SessionHistoryCache 优先 / DB body 兜底）→ Summarizer
// 检查（F1 L1：无 → 结构化错误「LLM 摘要不可用，未压缩」）→
// CompactionEngine（StubPolicy::LlmRequired——摘要不可用不降级 stub）→
// 应用（缓存对话替换 + context-compression-start/end 事件 + 块表落库）
// → CompactNowResult。manual 不受 max_auto_compactions_per_run 限制
// （用户显式意志，00 规范红线 2「手动路径不受限」对称语义）。

/// F4：手动压缩结果（slash /compact 返回载荷；camelCase wire）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactNowResult {
    /// 压缩前 token 数（启发式口径）
    pub tokens_before: u64,
    /// 压缩后 token 数（启发式口径）
    pub tokens_after: u64,
    /// 被压缩（丢弃并进入摘要）的消息条数
    pub dropped: usize,
    /// 摘要状态（committed = LLM 摘要成功 / awaiting = 后台重试中）
    pub summary_state: String,
}

/// F4：手动压缩命令（daemon IPC；registered 面经 command_manifest 双端
/// 三处翻转 + main.rs make_handlers! 注册，registered = 注册面不变量）
#[tauri::command]
pub(crate) async fn core_compact_now(
    state: tauri::State<'_, Arc<CoreRunState>>,
    session_id: String,
    target_tokens: Option<u64>,
) -> Result<CompactNowResult, CoreError> {
    compact_now_impl(&state, session_id.trim(), target_tokens).await
}

/// F4 命令体（测试直调，不依赖 Tauri runtime；对齐 run_control_impl
/// 「契约体」模式）
pub(crate) async fn compact_now_impl(
    state: &Arc<CoreRunState>,
    session_id: &str,
    target_tokens: Option<u64>,
) -> Result<CompactNowResult, CoreError> {
    // 1. 会话存在性（内存注册表 session_trees / sessions + DB sessions 表
    //    三面检查——冷启动无内存注册表时以 DB 为权威）
    let session_exists = {
        let trees = state.session_trees.lock().unwrap_or_else(|e| e.into_inner());
        let in_trees = trees.contains_key(session_id);
        let in_sessions = {
            let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions.iter().any(|record| record.session_id == session_id)
        };
        let in_db = state
            .local_db()
            .and_then(|db| db.list_sessions().ok())
            .map(|entries| entries.iter().any(|entry| entry.id == session_id))
            .unwrap_or(false);
        in_trees || in_sessions || in_db
    };
    if !session_exists {
        return Err(CoreError::NotFound(format!("会话 {session_id} 不存在")));
    }
    // 2. 活动 run 检查（busy → 拒绝，不打断活动流；用户可待 idle 后再试）
    {
        let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        if active.values().any(|run| run.session_id == session_id) {
            return Err(CoreError::InvalidInput(format!(
                "会话 {session_id} 正在运行中，压缩命令等待空闲后执行（不打断活动流）"
            )));
        }
    }
    // 3. 预算：显式 target_tokens 或 window - reserve（预检同口径）；
    //    下限 = reserve + keep_recent（护栏：目标过小必裁掉保留段原文，
    //    语义等价不可行 → InvalidInput，E2 §5.3 护栏）。参数校验前置
    //    （对话加载之前，与 run_control_impl 的入参先验纪律一致）
    let policy = state.compaction_policy_for(session_id).unwrap_or_default();
    let window = state
        .engine
        .provider_config()
        .and_then(|config| crate::engine::effective_context_window(&config))
        .map(u64::from)
        .unwrap_or(u64::from(ContextBudget::default().context_window));
    let reserve = u64::from(ContextBudget::default().reserve_tokens);
    let keep_recent = policy.keep_recent_tokens as u64;
    let budget = match target_tokens {
        Some(target) => target,
        None => window.saturating_sub(reserve),
    };
    if budget < reserve + keep_recent {
        return Err(CoreError::InvalidInput(format!(
            "目标 token 数 {budget} 低于下限 {reserve}（reserve）+ {keep_recent}（keep_recent）"
        )));
    }
    // 4. 对话源：SessionHistoryCache 优先（引擎权威增量）；DB body 兜底
    //    （重启后冷启动——SessionMessage 与 HistoryMessage 字段一一对应，
    //    转换后走缓存同款保真水合 cached_history_to_conversation）
    let conversation = if let Some(cached) = state.session_history.get(session_id) {
        cached_history_to_conversation(cached)
    } else {
        let Some(db) = state.local_db() else {
            return Err(CoreError::Internal(
                "LocalDb 不可用，无法加载会话对话".to_string(),
            ));
        };
        let body = db
            .load_session_body(session_id)
            .map_err(|error| CoreError::Io(format!("store.load_session_body: {error}")))?;
        let history: Vec<HistoryMessage> =
            body.into_iter().map(session_message_to_history).collect();
        cached_history_to_conversation(history)
    };
    if conversation.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "会话 {session_id} 无对话内容可压缩"
        )));
    }
    // 5. Summarizer 检查（F1 L1：无 Summarizer → 不压缩、结构化错误）
    let Some(summarizer) = state.summarizer_for(session_id) else {
        return Err(CoreError::InvalidInput(
            "LLM 摘要不可用，未压缩（请配置 provider 后重试）".to_string(),
        ));
    };
    // 6. 压缩（LlmRequired：无 Summarizer / 摘要失败 → 放弃压缩，禁止
    //    纯丢弃式 stub，E2 F1）
    let engine = conex_compaction::CompactionEngine::new(budget as usize);
    let plan = engine.compact_agent_messages_with_stub_policy(
        &conversation,
        budget as usize,
        &policy,
        Some(summarizer.as_ref()),
        StubPolicy::LlmRequired,
    );
    if plan.llm_unavailable {
        return Err(CoreError::InvalidInput(
            "LLM 摘要不可用，未压缩（摘要生成失败，对话保持原样）".to_string(),
        ));
    }
    if plan.dropped_ids.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "无合法切割点，未压缩（对话过短或无 Tool 配对保护冲突，tokens_before={}）",
            plan.tokens_before
        )));
    }
    // 7. 应用：缓存对话替换（下次 run 装配即用压缩后序列）+ 事件 + 块表
    let replaced: Vec<HistoryMessage> = plan
        .messages
        .iter()
        .map(|message| to_history_message(message.as_ref()))
        .collect();
    state.session_history.store(session_id, replaced);
    let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
        state.store.clone(),
        state.base_sequence_for(session_id).await,
    )));
    let bridge = state.event_bridge();
    let now_iso = crate::engine::now_iso_utc();
    // Start 事件（触发原因 + 压缩前 token；会话级队列入队持久化 + 全局
    // 事件桥信封广播——非 run 上下文 run_id 缺省 None）
    push_emit_idle_event(
        &queue,
        &bridge,
        session_id,
        AgentEvent::ContextCompressionStart {
            session_id: session_id.to_string(),
            timestamp: now_iso.clone(),
            reason: "manual".to_string(),
            tokens_before: plan.tokens_before,
        },
    )
    .await;
    // End 事件（record 载荷 = CompactionPlan 字段；details 携带块语义键，
    // orchestrator::blocks 消费落块表，blocks.rs:96-137）
    let summary_state = if plan.summary_is_llm { "committed" } else { "awaiting" };
    let block_id = format!("compacted-summary-{}-{}", plan.generation, plan.fold_index);
    let record = ContextCompressionRecord {
        id: block_id.clone(),
        trigger: ContextCompressionTrigger::Manual,
        reason: Some(ContextCompressionReason::Manual),
        policy: None,
        summary: plan.summary.clone(),
        first_kept_message_id: plan.first_kept_message_id.clone(),
        compressed_message_ids: plan.dropped_ids.clone(),
        kept_message_ids: plan.kept_ids.clone(),
        tokens_before: plan.tokens_before,
        tokens_after: plan.tokens_after,
        threshold_tokens: Some(budget),
        created_at: now_iso.clone(),
        handoff: None,
        cache_boundary: None,
        details: Some(compaction_block_details(
            &block_id,
            plan.generation,
            (plan.fold_chain_prev > 0)
                .then(|| format!("compacted-summary-{}-{}", plan.generation, plan.fold_chain_prev))
                .as_deref(),
            iso8601_to_epoch_millis(&now_iso),
            summary_state,
        )),
    };
    let end_event = AgentEvent::ContextCompressionEnd {
        session_id: session_id.to_string(),
        timestamp: now_iso,
        result: Some(record),
        aborted: false,
        error: None,
    };
    let sequence = push_emit_idle_event(&queue, &bridge, session_id, end_event.clone()).await;
    // 块表落库（与 drive 路径同源 persist_compression_block；失败仅告警
    // ——块表是索引面，原文在事件流可回放）
    if let Some(sequence) = sequence {
        if let Err(error) = orchestrator::blocks::persist_compression_block(
            state.store.as_ref(),
            session_id,
            &end_event,
            sequence,
        )
        .await
        {
            tracing::warn!(
                target: "run",
                session_id,
                error = %error,
                "手动压缩块表落库失败（索引面，原文在事件流可回放）"
            );
        }
    }
    tracing::info!(
        target: "run",
        session_id,
        tokens_before = plan.tokens_before,
        tokens_after = plan.tokens_after,
        dropped = plan.dropped_ids.len(),
        "手动压缩完成（slash /compact）"
    );
    Ok(CompactNowResult {
        tokens_before: plan.tokens_before,
        tokens_after: plan.tokens_after,
        dropped: plan.dropped_ids.len(),
        summary_state: summary_state.to_string(),
    })
}

/// F4：空闲态事件发射（无活动 run 上下文——会话级 EventQueue 入队持久化
/// + 全局事件桥信封广播；run_id 缺省 None，前端按会话域消费）。返回事件
/// 序列号（块表落库锚点）；失败 → None（事件仅尽力而为，不阻断命令）
async fn push_emit_idle_event(
    queue: &Arc<tokio::sync::Mutex<EventQueue>>,
    bridge: &crate::core_event_bridge::EventBridge,
    session_id: &str,
    event: AgentEvent,
) -> Option<u64> {
    let mut queue = queue.lock().await;
    let sequenced = queue.push(session_id, event).await.ok()?;
    let envelope = AgentEventEnvelope::new(sequenced.event, None, Some(sequenced.sequence));
    bridge.emit_envelope(&envelope);
    Some(sequenced.sequence)
}

/// F4：DB body（SessionMessage）→ HistoryMessage（字段一一对应；再经
/// cached_history_to_conversation 保真水合为对话——与缓存路径同源）
fn session_message_to_history(message: conex_types::SessionMessage) -> HistoryMessage {
    HistoryMessage {
        id: message.id,
        sender: message.sender,
        text: message.text,
        thinking: message.thinking,
        blocks_json: message.blocks_json,
        tool_calls_json: message.tool_calls_json,
        tool_call_results_json: message.tool_call_results_json,
        status: message.status,
        timestamp: message.timestamp,
    }
}

// ── 命令：core_cancel_run ─────────────────────────────────────────

/// 取消 run（过渡双线（03 §4.2）：IPC 模式经 run-control 单线为主，
/// 本命令保留双线兼容——L2 协作 / L3 强制，模式回落走 RunEngine 语义）
///
/// T-AB-19 显式接线：取消**不清理后台任务注册表、不级联杀任务**——
/// 任务属会话级（registry 生命周期独立于 run）；run 终态（aborted /
/// cancelled）统一由 drive_run_loop 收口（含 owner_run_id 上下文释放），
/// 本命令只请求取消，不做任何任务域操作。
#[tauri::command]
pub(crate) async fn core_cancel_run(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    mode: Option<String>,
) -> Result<CancelRunResponse, CoreError> {
    cancel_run_impl(state.inner(), &run_id, mode.as_deref(), None).await
}

/// 取消 run 直调体（R1-04 REST 写面：与 core_cancel_run 同一语义——
/// L2 协作 / L3 强制；不依赖 Tauri runtime）。reason 缺省
/// "cancelled-by-user"（与 IPC 命令面行为一致）。
pub(crate) async fn cancel_run_impl(
    state: &CoreRunState,
    run_id: &str,
    mode: Option<&str>,
    reason: Option<&str>,
) -> Result<CancelRunResponse, CoreError> {
    let active = active_run(state, run_id.trim())?;
    let cancel_mode = match mode {
        Some("cooperative") => CancelMode::Cooperative,
        _ => CancelMode::Force,
    };
    let engine = ActiveRunEngine {
        active: Arc::clone(&active),
    };
    let mut handle = active.handle.lock().await;
    let path = handle
        .cancel_run(
            cancel_mode,
            Some(&engine),
            reason.unwrap_or("cancelled-by-user"),
            state.store.as_ref(),
        )
        .await
        .map_err(crate::core_error::map_run_err)?;
    drop(handle);
    tracing::info!(
        target: "run",
        run_id = %active.run_id,
        path = ?path,
        "cancel_run_impl（终态由 drive_run_loop 收口）：后台任务注册表未清理、任务不级联杀（T-AB-19 契约）"
    );
    Ok(CancelRunResponse {
        ok: true,
        run_id: active.run_id.clone(),
    })
}

// ── 命令：core_approve_tool / core_deny_tool ──────────────────────

/// 批准工具调用（03 §3.2 A 组：{ok, toolCallId, decision:'approved'}）
///
/// I-02（PE-12 T12.3）：tool_call_id 必须在待审批集合（ApprovalGateImpl
/// 校验）；审批决策送达后落地 approval-resolved（持久化，03 §5.1-10
/// 硬依赖）并实时发射（前端关闭审批卡片）。
#[tauri::command]
pub(crate) async fn core_approve_tool(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    tool_call_id: String,
    decision: Option<String>,
) -> Result<ApproveResponse, CoreError> {
    approve_tool_impl(state.inner(), &run_id, &tool_call_id, decision).await
}

/// 批准工具调用直调体（R1-04 REST 写面：与 core_approve_tool 同一
/// 语义——I-02 pending 校验 + approval-resolved 落库与实时发射；
/// 不依赖 Tauri runtime）。
pub(crate) async fn approve_tool_impl(
    state: &CoreRunState,
    run_id: &str,
    tool_call_id: &str,
    decision: Option<String>,
) -> Result<ApproveResponse, CoreError> {
    let active = active_run(state, run_id.trim())?;
    // 仅接受 approved（其余值按 InvalidInput 拒绝，杜绝伪造）
    if decision.is_some_and(|d| d != "approved") {
        return Err(CoreError::invalid_input(
            "approve 的 decision 只能为 approved",
        ));
    }
    active
        .approval
        .resolve(tool_call_id, ApprovalDecision::Approved)
        .await?;
    emit_approval_resolved(&active, tool_call_id, WireApprovalDecision::Approved).await;
    Ok(ApproveResponse {
        ok: true,
        tool_call_id: tool_call_id.to_string(),
        decision: "approved",
    })
}

/// 拒绝工具调用（03 §3.2 A 组：{ok, toolCallId, decision:'denied'}）
#[tauri::command]
pub(crate) async fn core_deny_tool(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    tool_call_id: String,
    reason: Option<String>,
) -> Result<ApproveResponse, CoreError> {
    deny_tool_impl(state.inner(), &run_id, &tool_call_id, reason.as_deref()).await
}

/// 拒绝工具调用直调体（R1-04 REST 写面：与 core_deny_tool 同一语义；
/// 不依赖 Tauri runtime；reason 缺省 "user denied"）。
pub(crate) async fn deny_tool_impl(
    state: &CoreRunState,
    run_id: &str,
    tool_call_id: &str,
    reason: Option<&str>,
) -> Result<ApproveResponse, CoreError> {
    let active = active_run(state, run_id.trim())?;
    active
        .approval
        .resolve(
            tool_call_id,
            ApprovalDecision::Denied {
                reason: reason.unwrap_or("user denied").to_string(),
            },
        )
        .await?;
    emit_approval_resolved(&active, tool_call_id, WireApprovalDecision::Denied).await;
    Ok(ApproveResponse {
        ok: true,
        tool_call_id: tool_call_id.to_string(),
        decision: "denied",
    })
}

/// 按待审批集合反查 run（R1-04：M6 C11「runId 缺失容错」——toolCallId
/// 为真键，run_id 缺失时遍历活动 run 注册表命中首个包含该 tool_call_id
/// 的 run；未命中 None）
pub(crate) fn find_run_by_pending_tool_call(
    state: &CoreRunState,
    tool_call_id: &str,
) -> Option<String> {
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|(_, active)| active.approval.contains_pending(tool_call_id))
        .map(|(run_id, _)| run_id.clone())
}

// ── P-7（R2-07 D-02 收尾）：/v1/status activeRuns / pendingApprovals 摘要 ──

/// 活动 run 摘要（P-7：/v1/status activeRuns 数据源；M6 §4.1.1 形状
/// `{runId, sessionId, status, startedAt, prompt}`；注册表 StatusResult
/// activeRuns 为可选 JsonValue[]——桌面端总是下发数组，空数组合法）。
///
/// `prompt` 兜底：runs 表无 prompt 持久化（ActiveRun 不保留 prompt，
/// D-02 判定已注记）——恒空串下发，移动端按「无摘要文本」展示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActiveRunSummary {
    /// run 标识
    pub run_id: String,
    /// 会话标识
    pub session_id: String,
    /// 状态字面量（conex-db RunStatus::as_str 口径；活动注册表内恒非终态）
    pub status: String,
    /// 创建时刻（epoch ms；RunHandle.created_at）
    pub started_at: i64,
    /// 提示词摘要（兜底恒空串——runs 表无 prompt 持久化，见结构注释）
    pub prompt: String,
}

/// 待审批摘要（P-7：/v1/status pendingApprovals 数据源；M6 §4.1.1 形状
/// `{toolCallId, toolName, runId, summary}` 子集——全量对账面为 C13
/// list_pending_approvals，本面仅首页状态卡摘要，不重复下发
/// cwd/reason/paramKeys 等 C13 全量字段）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingApprovalSummary {
    /// 工具调用 id
    pub tool_call_id: String,
    /// 工具名
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// 活动 run 摘要列表（P-7：/v1/status activeRuns 数据源；注册表活动 run
/// 为运行时真源——终态 run 收口即移出，天然只含活动 run；按 run_id 排序
/// 保证 wire 确定性）。
///
/// 锁纪律：std Mutex（active_runs）内只克隆 Arc 句柄，tokio Mutex
/// （handle）锁不跨 await 持有（future 保持 Send）。
pub(crate) async fn list_active_runs_impl(state: &CoreRunState) -> Vec<ActiveRunSummary> {
    let entries: Vec<(String, String, Arc<tokio::sync::Mutex<RunHandle>>)> = {
        let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        active
            .values()
            .map(|run| {
                (
                    run.run_id.clone(),
                    run.session_id.clone(),
                    Arc::clone(&run.handle),
                )
            })
            .collect()
    };
    let mut summaries = Vec::with_capacity(entries.len());
    for (run_id, session_id, handle) in entries {
        let guard = handle.lock().await;
        summaries.push(ActiveRunSummary {
            run_id,
            session_id,
            status: guard.status.as_str().to_string(),
            started_at: guard.created_at,
            prompt: String::new(),
        });
    }
    summaries.sort_by(|a, b| a.run_id.cmp(&b.run_id));
    summaries
}

/// 待审批摘要列表（P-7：/v1/status pendingApprovals；从 C13 全量对账
/// [list_pending_approvals_impl] 投影 M6 §4.1.1 摘要子集——单一数据源
/// 复用，无第二套 pending 查询语义；按 tool_call_id 排序保证 wire
/// 确定性）
pub(crate) fn list_pending_approval_summaries_impl(
    state: &CoreRunState,
) -> Vec<PendingApprovalSummary> {
    let mut summaries: Vec<PendingApprovalSummary> = list_pending_approvals_impl(state)
        .into_iter()
        .map(|approval| PendingApprovalSummary {
            tool_call_id: approval.tool_call_id,
            tool_name: approval.tool_name,
            run_id: approval.run_id,
            summary: approval.summary,
        })
        .collect();
    summaries.sort_by(|a, b| a.tool_call_id.cmp(&b.tool_call_id));
    summaries
}

/// 待审批对账（R1-04 / M6 C13：活动 run 审批门待审批集合快照——「已
/// 请求未裁决」的运行时真源；run 未终态天然成立（终态移出活动注册表）。
/// after_sequence 增量水位属 wire 层对账扩展，实现为全量对账（M6 C13
/// 参数可选，缺省即全量）。
pub(crate) fn list_pending_approvals_impl(state: &CoreRunState) -> Vec<PendingApproval> {
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .flat_map(|active| {
            active.approval.pending_requests().into_iter().map(move |(tool_call_id, meta)| {
                // 危险级别在字段 move 前计算（tool_name 随后移入结构体）
                let danger_level = derive_danger_level(&meta.tool_name, &meta.param_keys);
                PendingApproval {
                    request_id: format!("approval-{tool_call_id}"),
                    tool_call_id,
                    tool_name: meta.tool_name,
                    summary: Some(meta.summary),
                    cwd: Some(meta.cwd),
                    session_id: Some(meta.session_id),
                    run_id: Some(active.run_id.clone()),
                    requester_run_id: meta.requester_run_id,
                    reason: meta.reason,
                    arbiter: if meta.arbiter == "main-agent" {
                        Arbiter::MainAgent
                    } else {
                        Arbiter::User
                    },
                    requested_at: meta.requested_at_ms,
                    expires_at: meta.requested_at_ms + APPROVAL_TIMEOUT.as_millis() as u64,
                    danger_level,
                    param_keys: Some(meta.param_keys),
                }
            })
        })
        .collect()
}

/// 危险级别推导（R1-04 / M6 C13：桌面按 F2 §2.2 表推导，移动端不重算）
///
/// 轻量启发式（与前端 approvalHandlers S9 宽容解析同语义的子集）：
/// 删除类工具 / 参数含删除语义 → 2（高风险，移动端二次确认），其余
/// 常规确认 → 1。红线请求不会到达审批门（decide_with_redline 先行拒绝），
/// 此处无需红线分支。
fn derive_danger_level(tool_name: &str, param_keys: &[String]) -> u8 {
    const DESTRUCTIVE_TOOLS: [&str; 5] = [
        "shell:write",
        "shell:exec",
        "git:revert",
        "file:delete",
        "workspace:delete",
    ];
    if DESTRUCTIVE_TOOLS.contains(&tool_name) {
        return 2;
    }
    if param_keys
        .iter()
        .any(|k| k.contains("delete") || k.contains("remove") || k.contains("overwrite"))
    {
        return 2;
    }
    1
}

/// 审批历史补拉（R1-04 / M6 C14：approval-resolved 事件白名单投影——
/// events 表按事件类型过滤，不携带参数全量（同 C13 隐私红线）。
/// sessionId 提供时按会话内 sequence 水位过滤，缺省跨会话按落库时刻
/// 近似排序；limit 缺省 100、上限 500。
pub(crate) async fn approval_history_impl(
    state: &CoreRunState,
    session_id: Option<&str>,
    after_sequence: Option<u64>,
    limit: Option<u32>,
) -> Result<ApprovalHistoryResult, CoreError> {
    let limit = limit.unwrap_or(100).clamp(1, 500) as usize;
    let Some(db) = state.local_db() else {
        // 无本地库（测试替身 store）：诚实返回空历史（不编造）
        return Ok(ApprovalHistoryResult {
            items: Vec::new(),
            next_after_sequence: None,
            has_more: None,
        });
    };
    let after = after_sequence.unwrap_or(0);
    // 会话范围：显式 sessionId → 单会话；缺省 → 全部会话索引
    let session_ids: Vec<String> = match session_id {
        Some(id) if !id.trim().is_empty() => vec![id.trim().to_string()],
        _ => db.list_sessions().map_err(map_db_failure)?.into_iter().map(|s| s.id).collect(),
    };
    // 逐会话拉取 approval-resolved 事件行（(sequence, created_at, payload)；
    // created_at 为 ISO 字符串列，跨会话排序按字典序 = 时间序）
    let mut rows: Vec<(i64, String, serde_json::Value)> = Vec::new();
    for sid in &session_ids {
        let events = db
            .query_events(sid, after as i64, None)
            .map_err(map_db_failure)?;
        for event in events {
            if event.event_type != "approval-resolved" {
                continue;
            }
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload) else {
                continue; // 损坏载荷跳过（防御性，与 core_read_session_events 同口径）
            };
            rows.push((event.sequence, event.created_at, payload));
        }
    }
    // 排序：跨会话按落库时刻（单会话天然按 sequence 升序，created_at 同序）
    rows.sort_by(|a, b| a.1.cmp(&b.1));
    let has_more = rows.len() > limit;
    let page = rows.into_iter().take(limit).collect::<Vec<_>>();
    let next_after_sequence = page.last().map(|(sequence, _, _)| (*sequence).max(0) as u64);
    let items = page
        .into_iter()
        .filter_map(|(sequence, _, payload)| {
            let tool_call_id = payload
                .get("toolCallId")
                .and_then(serde_json::Value::as_str)?
                .to_string();
            let decision = serde_json::from_value(payload.get("decision").cloned().unwrap_or_default())
                .unwrap_or(conex_types::events::ApprovalDecision::Expired);
            let resolved_at = payload
                .get("timestamp")
                .and_then(serde_json::Value::as_str)
                .map(|iso| iso8601_to_epoch_millis(iso).max(0) as u64);
            Some(ApprovalHistoryItem {
                sequence: sequence.max(0) as u64,
                tool_call_id,
                tool_name: None,
                decision,
                reason: None,
                channel: Some(RemoteApprovalChannel::Mobile),
                resolved_at,
                session_id: payload
                    .get("sessionId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                run_id: payload
                    .get("runId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect();
    Ok(ApprovalHistoryResult {
        items,
        next_after_sequence,
        has_more: Some(has_more),
    })
}

/// conex-db [conex_db::DbFailure] → CoreError（本地库访问直调面通用映射）
fn map_db_failure(error: conex_db::DbFailure) -> CoreError {
    CoreError::Io(format!("本地库访问失败：{error}"))
}

/// 落地 approval-resolved 事件（持久化 + 实时发射）
async fn emit_approval_resolved(
    active: &ActiveRun,
    tool_call_id: &str,
    decision: WireApprovalDecision,
) {
    let event = AgentEvent::ApprovalResolved {
        session_id: active.session_id.clone(),
        tool_call_id: tool_call_id.to_string(),
        request_id: None,
        decision,
        timestamp: crate::engine::now_iso_utc(),
    };
    let mut queue = active.queue.lock().await;
    match queue.push(&active.session_id, event).await {
        Ok(sequenced) => {
            let envelope = AgentEventEnvelope::new(
                sequenced.event,
                Some(active.run_id.clone()),
                Some(sequenced.sequence),
            );
            active.bridge.emit(&envelope);
            active.bridge.flush();
        }
        Err(error) => {
            tracing::error!(
                target: "approval",
                run_id = %active.run_id,
                tool_call_id,
                error = %error,
                "approval-resolved 落库失败"
            );
        }
    }
}

// ── R1-04 REST 写面：只读查询直调体（服务网关 CoreStateBackend 接入；
//    不依赖 Tauri runtime——与既有 *_impl 契约体同范式）──────────────

/// 会话事件分页直调体（与 core_read_session_events 同一语义：store 游标
/// 分页 + 信封解析；after_sequence 开区间，max_events 缺省 200 夹紧 1000）
pub(crate) async fn read_session_events_impl(
    state: &CoreRunState,
    session_id: &str,
    after_sequence: Option<u64>,
    max_events: Option<u64>,
) -> Result<crate::core_query_commands::EventPage, CoreError> {
    if session_id.trim().is_empty() {
        return Err(CoreError::invalid_input("session_id 不能为空"));
    }
    let page_size = normalize_remote_page_size(max_events);
    let after = after_sequence.unwrap_or(0);
    let store = state.store();
    let events = store
        .query_events(session_id, after)
        .await
        .map_err(crate::core_error::map_store_err)?;
    let page_items: Vec<(u64, serde_json::Value)> = events
        .iter()
        .filter_map(|event| {
            let envelope: AgentEventEnvelope = serde_json::from_str(&event.payload).ok()?;
            serde_json::to_value(envelope)
                .ok()
                .map(|value| (event.sequence, value))
        })
        .collect();
    let (page, has_more) = paginate_remote(page_items, page_size);
    let next_after_sequence = page.last().map(|(seq, _)| *seq).unwrap_or(after);
    Ok(crate::core_query_commands::EventPage {
        events: page.into_iter().map(|(_, value)| value).collect(),
        next_after_sequence,
        has_more,
    })
}

/// run 事件分页直调体（与 core_read_run_events 同一语义：按信封 runId
/// 过滤的会话事件子集；sessionId 缺省从 run 记录反查）
pub(crate) async fn read_run_events_impl(
    state: &CoreRunState,
    run_id: &str,
    session_id: Option<&str>,
    after_sequence: Option<u64>,
    max_events: Option<u64>,
) -> Result<crate::core_query_commands::EventPage, CoreError> {
    if run_id.trim().is_empty() {
        return Err(CoreError::invalid_input("run_id 不能为空"));
    }
    let page_size = normalize_remote_page_size(max_events);
    let after = after_sequence.unwrap_or(0);
    let store = state.store();
    // 未提供 sessionId：从 run 记录反查（与 core_read_run_events 同语义）
    let session_id = match session_id {
        Some(id) if !id.trim().is_empty() => id.trim().to_string(),
        _ => {
            let runs = store
                .query_runs()
                .await
                .map_err(crate::core_error::map_store_err)?;
            runs.into_iter()
                .find(|run| run.run_id == run_id)
                .map(|run| run.session_id)
                .ok_or_else(|| CoreError::NotFound(format!("run not found: {run_id}")))?
        }
    };
    let events = store
        .query_events(&session_id, after)
        .await
        .map_err(crate::core_error::map_store_err)?;
    let run_events: Vec<(u64, serde_json::Value)> = events
        .iter()
        .filter_map(|event| {
            let envelope: AgentEventEnvelope = serde_json::from_str(&event.payload).ok()?;
            if envelope.run_id.as_deref() != Some(run_id) {
                return None;
            }
            serde_json::to_value(envelope)
                .ok()
                .map(|value| (event.sequence, value))
        })
        .collect();
    let (page, has_more) = paginate_remote(run_events, page_size);
    let next_after_sequence = page.last().map(|(seq, _)| *seq).unwrap_or(after);
    Ok(crate::core_query_commands::EventPage {
        events: page.into_iter().map(|(_, value)| value).collect(),
        next_after_sequence,
        has_more,
    })
}

/// run 快照直调体（与 core_get_run_snapshot 同一语义：store run 记录 +
/// usage 缓存；sessionId 提供时校验与 run 记录一致）
pub(crate) async fn get_run_snapshot_impl(
    state: &CoreRunState,
    run_id: &str,
    session_id: Option<&str>,
) -> Result<crate::core_query_commands::RunSnapshotResponse, CoreError> {
    if run_id.trim().is_empty() {
        return Err(CoreError::invalid_input("run_id 不能为空"));
    }
    let store = state.store();
    let runs = store
        .query_runs()
        .await
        .map_err(crate::core_error::map_store_err)?;
    let run = runs
        .into_iter()
        .find(|run| run.run_id == run_id)
        .ok_or_else(|| CoreError::NotFound(format!("run not found: {run_id}")))?;
    if let Some(session_id) = session_id {
        if !session_id.is_empty() && session_id != run.session_id {
            return Err(CoreError::InvalidInput(format!(
                "session_id mismatch: run {run_id} belongs to session {}, got {session_id}",
                run.session_id
            )));
        }
    }
    Ok(crate::core_query_commands::RunSnapshotResponse {
        snapshot: crate::core_query_commands::RunSnapshot {
            run_id: run.run_id.clone(),
            session_id: run.session_id.clone(),
            status: run.status.as_str().to_string(),
            cursor: run.cursor.max(0) as u64,
            created_at: run.created_at,
            updated_at: run.updated_at,
            end_reason: run.end_reason.clone(),
            error: state.run_error(run_id),
            usage: state.run_usage(run_id),
        },
    })
}

/// 会话列表直调体（LocalDb 索引直读；includeLastMessage 预览属 F5 增量
/// 面，R1-04 直调面不实现——缺省语义不变）
pub(crate) fn list_sessions_impl(
    state: &CoreRunState,
) -> Result<Vec<conex_types::SessionIndexEntry>, CoreError> {
    let Some(db) = state.local_db() else {
        return Ok(Vec::new());
    };
    db.list_sessions().map_err(map_db_failure)
}

/// 子代理 DAG 概览直调体（M6 C08 行投影：完整消息树不下发（D6 §3.3
/// N8），仅 flowDeclaration / flowState 原样 + agents 行投影
/// （agentId/status/description/summary/depth）；depth = 1——agents 表
/// 仅子代理行，主 agent 不在其中）
pub(crate) fn get_flow_snapshot_impl(
    state: &CoreRunState,
    session_id: &str,
) -> Result<serde_json::Value, CoreError> {
    if session_id.trim().is_empty() {
        return Err(CoreError::invalid_input("session_id 不能为空"));
    }
    let Some(db) = state.local_db() else {
        return Err(CoreError::NotFound(format!("会话不存在：{session_id}")));
    };
    let declaration = db
        .get_session_meta(orchestrator::flow_graph::FLOW_DECLARATION_KEY)
        .map_err(map_db_failure)?;
    let flow_state = db
        .get_session_meta(orchestrator::flow_graph::FLOW_STATE_KEY)
        .map_err(map_db_failure)?;
    let agents = db.load_session_agents(session_id).map_err(map_db_failure)?;
    let agents: Vec<serde_json::Value> = agents
        .into_iter()
        .map(|agent| {
            serde_json::json!({
                "agentId": agent.id,
                "status": agent.status,
                "description": agent.description,
                "summary": agent.summary,
                "depth": 1_u8,
            })
        })
        .collect();
    let parse_meta = |raw: Option<String>| {
        raw.and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    };
    Ok(serde_json::json!({
        "flowDeclaration": parse_meta(declaration),
        "flowState": parse_meta(flow_state),
        "agents": agents,
    }))
}

/// 页大小归一（缺省 200、夹紧 [1, 1000]，与
/// core_query_commands::normalize_max_events 同口径）
fn normalize_remote_page_size(max_events: Option<u64>) -> usize {
    max_events
        .unwrap_or(crate::core_query_commands::DEFAULT_PAGE_SIZE)
        .clamp(1, crate::core_query_commands::MAX_PAGE_SIZE) as usize
}

/// 纯分页（与 core_query_commands::paginate 同语义：全量切前 max 条）
fn paginate_remote<T>(all: Vec<T>, max: usize) -> (Vec<T>, bool) {
    if all.len() <= max {
        return (all, false);
    }
    let page = all.into_iter().take(max).collect::<Vec<_>>();
    (page, true)
}

// ── R1-04 REST 写面：设置域直调体（M6 C28/C29 的 REST T1 形态）──────

/// 设置脱敏快照直调体（M6 C28：config_get 直透——apiKey 恒空串 + last4
/// 脱敏由 config 层保证；keys 子集过滤在服务层完成）
pub(crate) fn settings_get_impl() -> Result<serde_json::Value, CoreError> {
    crate::config::config_get()
}

/// 非敏感配置更新直调体（Z0 §9.3 R1-04「配置非敏感更新」：与
/// config_update 同语义——baseUrl / model 两键可写（config store setter
/// pub(crate) 直调面），写成功后重载引擎 provider（下一次 run 用新值）。
/// credentialMode / endpoint / stream 属 config 模块私有写面，R1-04
/// **显式拒绝**（fail-closed：不静默忽略，避免「请求成功但未生效」）。
pub(crate) fn settings_update_impl(
    state: &CoreRunState,
    base_url: Option<String>,
    model: Option<String>,
    credential_mode: Option<String>,
    endpoint: Option<String>,
    stream: Option<bool>,
) -> Result<serde_json::Value, CoreError> {
    if credential_mode.is_some() || endpoint.is_some() || stream.is_some() {
        return Err(CoreError::invalid_input(
            "credentialMode / endpoint / stream 不在 REST 非敏感配置更新面（仅 baseUrl / model）",
        ));
    }
    crate::config::with_store_mut(|store| {
        if let Some(url) = base_url {
            store.set_base_url(url)?;
        }
        if let Some(m) = model {
            store.set_model(m)?;
        }
        Ok(())
    })?;
    // 与 config_update 同语义：store 写成功后重载引擎 provider
    state.reload_provider();
    crate::config::config_get()
}

// ── R1-04 REST 写面：run 发起装配辅助（桌面侧生成 id，M6 C24）──────

/// 生成 run id（桌面生成：对齐前端 `run-<base36 时间戳>-<base36 随机>`
/// 命名风格；随机段经 CSPRNG getrandom）
pub(crate) fn generate_run_id() -> String {
    let mut random = [0u8; 4];
    let _ = getrandom::getrandom(&mut random);
    format!(
        "run-{}-{}",
        base36(now_ms_internal()),
        base36(u32::from_le_bytes(random) as u64)
    )
}

/// 生成会话 id（sessionId 缺省时桌面新建会话，对齐前端 `sess-<时间戳>`
/// 命名风格）
pub(crate) fn generate_session_id() -> String {
    format!("sess-{}", base36(now_ms_internal()))
}

/// 当前 epoch ms（模块内 id 生成用；与 crate::server::now_ms 同源）
fn now_ms_internal() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// base36 编码（0-9a-z；对齐前端 `Date.now().toString(36)` 风格）
fn base36(value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut buffer = [0u8; 16];
    let mut i = 16;
    let mut v = value;
    while v > 0 {
        i -= 1;
        buffer[i] = DIGITS[(v % 36) as usize];
        v /= 36;
    }
    String::from_utf8(buffer[i..].to_vec()).expect("base36 恒为 ASCII")
}

/// 后台任务列表直调面（R1-04；未接线 → 空列表，与 summary 全零缺省
/// 同口径；TOOL_NOT_FOUND → NotFound，其余 → internal）
pub(crate) async fn list_background_tasks_impl(
    state: &CoreRunState,
) -> Result<Vec<serde_json::Value>, CoreError> {
    let tasks = state.background_manager().list_tasks().await?;
    Ok(tasks
        .into_iter()
        .map(|info| {
            serde_json::json!({
                "taskId": info.task_id,
                "command": info.command,
                "cwd": info.cwd,
                "status": serde_json::to_value(info.status).unwrap_or_default(),
                "isDaemon": info.is_daemon,
                "startedAt": info.started_at_ms,
                "exitCode": info.exit_code,
                "lineCount": info.line_count,
            })
        })
        .collect())
}

/// 任务输出补取直调面（R1-04 / M6 C07：after_line 偏移分页——read_log
/// 行范围语义；next_after_line / has_more 由 LogSlice 首末行推导）
pub(crate) async fn get_task_output_impl(
    state: &CoreRunState,
    task_id: &str,
    max_lines: Option<u32>,
    after_line: Option<u64>,
) -> Result<conex_types::device::commands::TaskOutputResult, CoreError> {
    let max_lines = max_lines.unwrap_or(200).clamp(1, 1000);
    let slice = state
        .background_manager()
        .read_task_log(task_id, after_line, max_lines as u64)
        .await?;
    let start = slice.start_line;
    let end = slice.end_line;
    let has_more = slice.truncated || end < slice.total_lines;
    Ok(conex_types::device::commands::TaskOutputResult {
        lines: slice.lines,
        truncated: slice.truncated,
        line_count: slice.total_lines,
        next_after_line: Some(if end >= start { end + 1 } else { start }),
        has_more: Some(has_more),
    })
}

// ── R1-04 REST 写面：CoreRunState 访问器 ────────────────────────────

impl CoreRunState {
    /// 状态诊断访问器（get_status 直调面——与 main.rs managed 的
    /// StatusDiagnostics 为同一实例，避免写入侧与读取侧漂移）
    pub(crate) fn status_diagnostics(&self) -> Arc<StatusDiagnostics> {
        Arc::clone(&self.diagnostics)
    }

    /// 后台任务管理器访问器（list_background_tasks / get_task_output
    /// 直调面）
    pub(crate) fn background_manager(&self) -> Arc<RunAwareBackgroundManager> {
        Arc::clone(&self.background)
    }
}

impl RunAwareBackgroundManager {
    /// 任务列表直调面（R1-04；未接线 → 空列表，与 summary 全零缺省同
    /// 口径；TOOL_NOT_FOUND → NotFound，其余 → internal）
    pub(crate) async fn list_tasks(&self) -> Result<Vec<BackgroundTaskInfo>, CoreError> {
        let Some(manager) = &self.inner else {
            return Ok(Vec::new());
        };
        manager.list(true).await.map_err(map_tool_error)
    }

    /// 任务日志直调面（R1-04：read_log 行范围语义；start_line=None 读
    /// 尾部 max_lines 行；未知任务 → NotFound）
    pub(crate) async fn read_task_log(
        &self,
        task_id: &str,
        start_line: Option<u64>,
        max_lines: u64,
    ) -> Result<LogSlice, CoreError> {
        let Some(manager) = &self.inner else {
            return Err(CoreError::NotFound(format!("任务不存在：{task_id}")));
        };
        manager
            .read_log(task_id, start_line, max_lines)
            .await
            .map_err(map_tool_error)
    }
}

/// 工具错误 → CoreError（TOOL_NOT_FOUND → NotFound，其余 → internal；
/// 与 background.rs tool_err_to_core 同语义）
fn map_tool_error(error: agent_tools::definition::ToolError) -> CoreError {
    if error.code() == codes::TOOL_NOT_FOUND {
        CoreError::NotFound(error.to_string())
    } else {
        CoreError::Internal(error.to_string())
    }
}

// ── trash 命令（I2-S5：误删恢复入口，引擎命令面）────────────────────

/// 回收站根注入配置（main.rs `app.manage`；对齐 `BuiltinToolConfig.trash_root`
/// 语义：`None` = 未注入 → 执行期回退活动工作区 `.crish-trash`，与
/// delete_file / delete_dir 工具的兜底一致——保证恢复面板与删除工具
/// 落入同一回收站根，恢复才找得到条目）。
#[derive(Debug, Clone, Default)]
pub struct TrashRootConfig {
    /// 回收站根（数据目录或显式配置根；None = 走工作区兜底）
    pub root: Option<PathBuf>,
}

/// 兜底回收站目录名（对齐 agent-tools delete.rs 的 DEFAULT_TRASH_DIR_NAME）
const DEFAULT_TRASH_DIR_NAME: &str = ".crish-trash";

/// 解析回收站根：
/// 1. 托管状态注入优先（main.rs 配置注入点，数据目录或显式根）；
/// 2. 未注入 → 活动工作区 `.crish-trash`（S3 执行期兜底语义）；
///
/// 工作区注册表不可用 → 结构化错误（不静默退化）。
/// pub(crate)：供 fs_commands/delete.rs（UI 删除命令）复用，保证
/// UI 删除与 AI 删除落入同一回收站根（S11 G2 删除接管收敛）。
pub(crate) fn trash_root_for(app: &tauri::AppHandle) -> Result<PathBuf, CoreError> {
    if let Some(config) = app.try_state::<TrashRootConfig>() {
        if let Some(root) = &config.root {
            return Ok(root.clone());
        }
    }
    let guard = crate::workspace::resolve_guard(app, "").map_err(|e| {
        CoreError::Internal(format!(
            "无法解析回收站根（工作区注册表不可用）：{}: {}",
            e.code, e.message
        ))
    })?;
    Ok(guard.root().join(DEFAULT_TRASH_DIR_NAME))
}

/// 回收站错误 → CoreError 映射（按文案归类，对齐 03 §5.3 协议）
fn map_trash_err(err: &anyhow::Error) -> CoreError {
    let msg = err.to_string();
    if msg.contains("不存在") || msg.contains("缺失") {
        CoreError::NotFound(msg)
    } else if msg.contains("非法条目") || msg.contains("拒绝覆盖") || msg.contains("校验失败") {
        CoreError::InvalidInput(msg)
    } else {
        CoreError::Io(msg)
    }
}

/// trash_list 返回（条目清单 + 回收站根；无条目时 entries 为空数组）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashListResponse {
    pub entries: Vec<conex_fs::trash::TrashEntry>,
    pub trash_root: String,
}

/// 列出回收站条目（误删恢复入口；数据源 = 回收站登记扫描，
/// 条目含路径 / 删除时间 / 类型 / 大小 / 校验和）
#[tauri::command]
pub(crate) fn trash_list(app: tauri::AppHandle) -> Result<TrashListResponse, CoreError> {
    let root = trash_root_for(&app)?;
    trash_list_at(&root)
}

/// 纯函数核心（测试直测）：按回收站根列出条目
pub(crate) fn trash_list_at(root: &std::path::Path) -> Result<TrashListResponse, CoreError> {
    let service = conex_fs::trash::TrashService::new(root);
    Ok(TrashListResponse {
        entries: service.list(),
        trash_root: root.to_string_lossy().into_owned(),
    })
}

/// trash_restore 返回（恢复成功的目标路径）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashRestoreResponse {
    pub ok: bool,
    pub original_path: String,
}

/// 按条目 id 恢复到原路径（校验 checksum 防篡改；原路径已存在拒绝覆盖；
/// 恢复失败返回结构化错误，条目保留在回收站）
#[tauri::command]
pub(crate) fn trash_restore(
    app: tauri::AppHandle,
    entry_id: String,
    session_id: Option<String>,
    state: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<TrashRestoreResponse, CoreError> {
    let root = trash_root_for(&app)?;
    // I2-S8：恢复前取条目大小（恢复成功后条目已从清单移除，必须先行）
    let size = conex_fs::trash::TrashService::new(&root)
        .list()
        .into_iter()
        .find(|e| e.id == entry_id.trim())
        .map(|e| e.size)
        .unwrap_or(0);
    let response = trash_restore_at(&root, &entry_id)?;
    // I2-S8：恢复动作审计（decision=restored；经事件桥发前端事件流，
    // sessionId 由调用方（S5 恢复面板接线）携带，缺失时仅落审计日志）
    emit_trash_audit(
        &state.bridge,
        session_id.as_deref(),
        SecurityAuditOperation::TrashRestore,
        SecurityAuditDecision::Restored,
        &response.original_path,
        size,
    );
    Ok(response)
}

/// 纯函数核心（测试直测）：按条目 id 恢复到原路径
pub(crate) fn trash_restore_at(
    root: &std::path::Path,
    entry_id: &str,
) -> Result<TrashRestoreResponse, CoreError> {
    let service = conex_fs::trash::TrashService::new(root);
    let restored = service
        .restore(entry_id.trim())
        .map_err(|e| map_trash_err(&e))?;
    Ok(TrashRestoreResponse {
        ok: true,
        original_path: restored.to_string_lossy().into_owned(),
    })
}

/// trash_purge 返回（已彻底清除的条目 id）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashPurgeResponse {
    pub ok: bool,
    pub entry_id: String,
}

/// 彻底清除条目（显式用户调用，不可恢复）
#[tauri::command]
pub(crate) fn trash_purge(
    app: tauri::AppHandle,
    entry_id: String,
    session_id: Option<String>,
    state: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<TrashPurgeResponse, CoreError> {
    let root = trash_root_for(&app)?;
    // I2-S8：清除前取条目原路径与大小（清除成功后条目已从清单移除）
    let entry = conex_fs::trash::TrashService::new(&root)
        .list()
        .into_iter()
        .find(|e| e.id == entry_id.trim());
    let (original_path, size) = entry
        .as_ref()
        .map(|e| (e.original_path.to_string_lossy().into_owned(), e.size))
        .unwrap_or_else(|| (entry_id.to_string(), 0));
    let response = trash_purge_at(&root, &entry_id)?;
    // I2-S8：清除动作审计（decision=purged；经事件桥发前端事件流）
    emit_trash_audit(
        &state.bridge,
        session_id.as_deref(),
        SecurityAuditOperation::TrashPurge,
        SecurityAuditDecision::Purged,
        &original_path,
        size,
    );
    Ok(response)
}

/// 纯函数核心（测试直测）：彻底清除条目（显式用户调用，不可恢复）
pub(crate) fn trash_purge_at(
    root: &std::path::Path,
    entry_id: &str,
) -> Result<TrashPurgeResponse, CoreError> {
    let service = conex_fs::trash::TrashService::new(root);
    service
        .purge(entry_id.trim())
        .map_err(|e| map_trash_err(&e))?;
    Ok(TrashPurgeResponse {
        ok: true,
        entry_id: entry_id.to_string(),
    })
}

/// 回收站恢复/清除动作的审计发射（I2-S8）
///
/// 发射形态：`security-audit` 信封（runId/sequence 为 None——用户级引擎
/// 命令不属 run 上下文，前端对缺失 runId 的信封放行不过滤）；`session_id`
/// 由调用方携带（S5 恢复面板接线后传入），缺失时跳过 wire-out 仅落
/// 结构化审计日志。事件落库（EventQueue append_event）属 run 上下文
/// 数据面，本命令面无会话序列上下文，登记为 I3 遗留（见方案 §2 S8）。
fn emit_trash_audit(
    bridge: &EventBridge,
    session_id: Option<&str>,
    operation: SecurityAuditOperation,
    decision: SecurityAuditDecision,
    original_path: &str,
    size_bytes: u64,
) -> EmitReport {
    let Some(session_id) = session_id else {
        tracing::info!(
            target: "security.audit",
            kind = "trash-command",
            operation = ?operation,
            decision = ?decision,
            path = original_path,
            "回收站命令审计（未携带会话上下文，跳过事件发射）"
        );
        return EmitReport::default();
    };
    let event = AgentEvent::SecurityAudit {
        session_id: session_id.to_string(),
        timestamp: now_iso_utc(),
        operation,
        targets: vec![original_path.to_string()],
        impact: ImpactAssessment {
            file_count: 1,
            total_size_bytes: size_bytes,
            directory_count: 0,
            cross_directory: false,
            flagged: false,
        },
        decision,
        permission_mode: None,
        tool_call_id: None,
    };
    let envelope = AgentEventEnvelope::new(event, None, None);
    tracing::info!(
        target: "security.audit",
        kind = "trash-command",
        session_id,
        operation = ?operation,
        decision = ?decision,
        path = original_path,
        "回收站命令审计：已发前端事件流"
    );
    bridge.emit_envelope(&envelope)
}

/// 当前 UTC 时间 ISO8601 字符串（毫秒精度；复用既有 civil_from_days
/// 换算，与 orchestrator / session-loop 同源）
fn now_iso_utc() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let (hours, mins, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    let (year, month, day) = civil_from_days((secs / 86400) as i64);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{mins:02}:{sec:02}.{millis:03}Z")
}

// ── 测试（SR-01 · 测外置 · 旁挂 core_run_commands_tests.rs · ≠ EL）──

#[cfg(test)]
#[path = "core_run_commands_tests.rs"]
mod tests;

/// 跨模块测试面 re-export（engine_tests.rs 等经
/// `crate::core_run_commands::{CONFIG_TEST_LOCK, isolate_config_store}`
/// 引用；定义在旁挂测试文件，此处 re-export 保持既有路径不 break）
#[cfg(test)]
pub(crate) use tests::{CONFIG_TEST_LOCK, isolate_config_store};
