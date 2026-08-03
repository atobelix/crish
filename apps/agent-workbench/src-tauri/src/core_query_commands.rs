//! 查询命令域（core_get_status / core_get_run_snapshot / core_read_run_events /
//! core_read_session_events / core_list_commands）—— 03 §3.2 A/B 查询面。
//!
//! 字段契约（AU-04 F2 冻结 v1，串行增量并入，严禁并行改同一函数）：
//! - **PE-01 基线**：initialized / version / engineReady / searchIndexReady / dbReady /
//!   compactionReady + `providerStatus { hasApiKey: bool|null, model, baseUrl,
//!   credentialMode }`（T01.1/T01.2 诚实化：无硬编码 true）；
//! - **PE-04 增量**（T04.5-1）：logLevel / logDir / diagnostics / lastError——
//!   `diagnostics` 为 {ts, level, message} 环形缓冲（容量 20，最旧在前；由 R1 的
//!   `status_diagnostics.rs` 维护），`lastError` 为 {kind, detail, ts}（AtomicSlot 驱动）；
//! - **PE-08 增量**（T08.6）：restore `{state, mode, snapshotNote, interruptedCount,
//!   lastSequence}` / snapshot `{generation, writtenAt, lastError}`。
//!
//! 组装：`build_status` 是**唯一**组装函数，各域以**追加参数**并入（F2 串行序），
//! 与 Tauri 解耦（纯数据组装，可单测）。`core_get_status` 从 State 取数据源后
//! 调用 `build_status`。
//!
//! 事件分页：cursor 语义 = 会话内连续 sequence（03 §5.1-2/3）；返回
//! `{ events, nextAfterSequence, hasMore }`（对齐 daemon 协议与前端
//! `sessionEventHydrate.ts` / `StreamRecovery.ts` 消费面）。

use std::sync::Arc;

use conex_types::events::{AgentEventEnvelope, RunCacheStats};
use serde::Serialize;
use tauri::State;

use crate::core_commands::{SharedCompactionState, SharedGatekeeper, SharedSearchState};
use crate::core_error::{map_store_err, CoreError};

// ⚠️ 依赖类型（由协作方定稿，当前缺失；接入后本文件即可编译）：
// - `crate::status_diagnostics::StatusDiagnostics`：**R1 重写**（PE-04 T04.5）。
//   本文件依赖其两个只读访问器（契约）：
//   `entries() -> Vec<DiagnosticEntry>`（环形 20，最旧在前）、
//   `last_error() -> Option<LastErrorEntry>`；
// - `CoreRunState`（PE-08 T08.6 定稿；main.rs `app.manage(Arc::new(...))` 接线）。
//   本文件依赖其访问器契约（见 [CoreRunState 访问器契约] 注释块）。
use crate::status_diagnostics::StatusDiagnostics;

// ===== 分页常量（S-15/S-16：显式上限，防无界查询）=====

/// 默认每页事件数（对齐 daemon read-*-events 的 maxEvents 缺省）。
pub const DEFAULT_PAGE_SIZE: u64 = 200;
/// 每页事件数上限（超出按上限截断，不报错）。
pub const MAX_PAGE_SIZE: u64 = 1000;
/// 会话 / run id 长度上限（参数校验，S-15/S-16）。
pub const ID_MAX_LEN: usize = 512;

// ===== CoreStatus 字段集（AU-04 F2 冻结 v1）=====

/// provider 配置状态（输出侧唯一名 `providerStatus`；前端解析层兼容 provider/config 只读路径）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    /// 三态：null = store 未初始化/无法判定；false = 明确无 key
    pub has_api_key: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_mode: Option<String>,
}

/// 诊断条目（PE-04 T04.5：{ts, level, message}，环形缓冲 20，最旧在前）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEntry {
    /// epoch ms
    pub ts: i64,
    /// trace / debug / info / warn / error
    pub level: String,
    pub message: String,
}

/// 最近错误（PE-04 T04.5：{kind, detail, ts}，AtomicSlot 驱动）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastErrorEntry {
    /// CoreError kind（InvalidInput / Io / NotFound / Cancelled / Encoding / Internal）
    pub kind: String,
    /// 错误详情（人读）
    pub detail: String,
    /// epoch ms
    pub ts: i64,
}

/// restore 域状态（PE-08 T08.6，F2 冻结形状）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreStatus {
    /// pending / done / failed（failed 不阻塞启动，run 命令照常可用）
    pub state: &'static str,
    /// full-replay / snapshot-incremental；pending 时为空串
    pub mode: String,
    /// 快照回退说明（None = 未回退/无说明）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_note: Option<String>,
    /// 本次恢复打断的 run 数（in-flight → interrupted）
    pub interrupted_count: usize,
    /// 事件流锚点（lastSequence 增量流；无事件时 0）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sequence: Option<u64>,
}

/// snapshot 域状态（PE-08 T08.6，F2 冻结形状）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotStatus {
    /// 已加载快照代数（无快照 = 0）
    pub generation: u64,
    /// 快照写入时间（epoch ms；未保存过 = None）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub written_at: Option<i64>,
    /// 最近一次快照保存失败（P16 显式标记；None = 无失败）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// core_get_status 返回体（AU-04 F2 冻结 v1，serde camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    /// setup 完成标记（PE-01 T01.2 真实化：setup 失败 = false，不假装成功）
    pub initialized: bool,
    /// 壳版本（CARGO_PKG_VERSION）
    pub version: String,
    /// 引擎（session-loop）就绪
    pub engine_ready: bool,
    /// 搜索索引就绪（真实化：文件数 > 0 推断）
    pub search_index_ready: bool,
    /// 会话数据库就绪（SharedDb 真实值）
    pub db_ready: bool,
    /// 压缩能力接线标记（PE-01 T01.2：未接线 = false）
    pub compaction_ready: bool,
    pub provider_status: ProviderStatus,
    // ── PE-04 增量（T04.5-1）──
    /// 当前生效日志级别（conex_telemetry::current_level 同源）
    pub log_level: String,
    /// 日志文件层目录（面板可展示路径）
    pub log_dir: String,
    /// 最近诊断（环形 20，最旧在前；前端展示时自行 reverse）
    pub diagnostics: Vec<DiagnosticEntry>,
    /// 最近错误（AtomicSlot；None = 无错误记录）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<LastErrorEntry>,
    // ── PE-08 增量（T08.6）──
    pub restore: RestoreStatus,
    pub snapshot: SnapshotStatus,
}

/// 组装 CoreStatus（**唯一**组装函数；F2 串行序：PE-01 → PE-04 → PE-08 以追加参数并入，
/// 与 Tauri 解耦，纯数据组装可单测）。
#[allow(clippy::too_many_arguments)]
pub fn build_status(
    // PE-01 基线（T01.1 / T01.2）
    initialized: bool,
    version: String,
    engine_ready: bool,
    search_index_ready: bool,
    db_ready: bool,
    compaction_ready: bool,
    provider_status: ProviderStatus,
    // PE-04 增量（T04.5-1）
    log_level: String,
    log_dir: String,
    diagnostics: Vec<DiagnosticEntry>,
    last_error: Option<LastErrorEntry>,
    // PE-08 增量（T08.6）
    restore: RestoreStatus,
    snapshot: SnapshotStatus,
) -> CoreStatus {
    CoreStatus {
        initialized,
        version,
        engine_ready,
        search_index_ready,
        db_ready,
        compaction_ready,
        provider_status,
        log_level,
        log_dir,
        diagnostics,
        last_error,
        restore,
        snapshot,
    }
}

/// 从配置存储组装 providerStatus（PE-01 T01.1；无硬编码，三态如实）。
///
/// `has_api_key` 语义：`effective_api_key()` 返回 `None`（store 未初始化 / 锁失败 /
/// 明确无 key）时投影为 `None`（无法判定），`Some(k)` 时按 `!k.is_empty()` 判定。
fn provider_status_from_config() -> ProviderStatus {
    let api_key = crate::config::effective_api_key();
    ProviderStatus {
        has_api_key: Some(api_key.as_deref().is_some_and(|k| !k.is_empty())),
        model: crate::config::effective_model(),
        base_url: crate::config::effective_api_base_url(),
        credential_mode: Some(crate::config::effective_credential_mode()),
    }
}

/// 日志目录（PE-04 T04.5-1：logDir 数据源）。
///
/// 与 main.rs 初始化 `conex_telemetry::FileConfig` 时使用的目录保持一致
/// （`app_dir()/logs`）；app_dir 解析失败时返回空串（前端面板显示「未知」）。
fn log_dir() -> String {
    match crate::host_paths::app_dir() {
        Ok(dir) => dir.join("logs").to_string_lossy().to_string(),
        Err(_) => String::new(),
    }
}

// ===== CoreRunState 访问器契约 =====
//
// `CoreRunState`（PE-08 T08.6 定稿，main.rs `app.manage(Arc::new(...))` 接线）。
// 本文件只依赖以下方法（R1/PE-08 按此契约实现，签名以本注释为唯一约定）：
// - `store(&self) -> Arc<dyn Store>`：共享事件存储（与 RunManager::store 同型）；
// - `initialized(&self) -> bool`：setup 完成标记（PE-01 T01.2）；
// - `engine_ready(&self) -> bool`：引擎（session-loop）就绪；
// - `restore_status(&self) -> RestoreStatus`：restore 域状态（PE-08 T08.6）；
// - `snapshot_status(&self) -> SnapshotStatus`：快照域状态（PE-08 T08.6）；
// - `run_error(&self, run_id: &str) -> Option<String>`：run 终态错误文案（无则 None）；
// - `run_usage(&self, run_id: &str) -> Option<RunUsage>`：usage 域（未接线时 None）。
use crate::core_run_commands::CoreRunState;

/// core_get_status：核心状态查询（03 §3.2 B；无硬编码 true 字段）。
///
/// 数据源全部来自 State / 静态存储（main.rs 接线）：
/// - `core`（Arc<CoreRunState>）：initialized / engineReady / restore / snapshot；
/// - `diagnostics`（Arc<StatusDiagnostics>，R1；main.rs 与 CoreRunState 共享
///   同一实例，避免写入侧与读取侧漂移）：diagnostics / lastError；
/// - `gatekeeper`（SharedGatekeeper）：就绪诊断预留接入点（当前仅占位，未消费）；
/// - `compaction`（SharedCompactionState，PE-01 T01.2）：compactionReady；
/// - `search`（SharedSearchState）：searchIndexReady（文件数 > 0 推断）；
/// - `db`（SharedDb）：dbReady。
#[tauri::command]
pub fn core_get_status(
    core: State<'_, Arc<CoreRunState>>,
    diagnostics: State<'_, Arc<StatusDiagnostics>>,
    _gatekeeper: State<'_, SharedGatekeeper>,
    compaction: State<'_, SharedCompactionState>,
    search: State<'_, SharedSearchState>,
    db: State<'_, crate::session_commands::SharedDb>,
) -> Result<CoreStatus, CoreError> {
    let search_index_ready = search
        .files
        .read()
        .map(|files| !files.is_empty())
        .unwrap_or(false);
    Ok(build_status(
        core.initialized(),
        env!("CARGO_PKG_VERSION").to_string(),
        core.engine_ready(),
        search_index_ready,
        db.db_ready(),
        compaction.is_ready(),
        provider_status_from_config(),
        conex_telemetry::current_level(),
        log_dir(),
        // StatusDiagnostics 产 SubsystemDiagnostic（subsystem/ready/message/updatedAt，
        // R1 形状），映射为 wire 形状 DiagnosticEntry（ts/level/message，F2 冻结；
        // level 侧以子系统名承载，前端按 levelLabel 展示）
        diagnostics
            .entries()
            .into_iter()
            .map(|entry| DiagnosticEntry {
                ts: entry.updated_at,
                level: entry.subsystem,
                message: entry.message.unwrap_or_default(),
            })
            .collect(),
        // lastError 映射：CrishErrorPayload（77 码）→ LastErrorEntry {kind, detail, ts}
        diagnostics.last_error().map(|payload| LastErrorEntry {
            kind: payload.code,
            detail: payload.message,
            ts: payload.timestamp,
        }),
        core.restore_status(),
        core.snapshot_status(),
    ))
}

// ===== 事件分页（core_read_session_events / core_read_run_events）=====

/// 事件分页返回（对齐 daemon read-*-events 协议：前端 `sessionEventHydrate.ts`
/// `{events, nextAfterSequence, hasMore}` 消费面）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    /// 本页事件（AgentEventEnvelope 扁平 JSON：`{type, runId, sequence, schemaVersion, ...}`，
    /// 按 sequence 升序）
    pub events: Vec<serde_json::Value>,
    /// 下一页游标（本页最后一条事件 sequence；空页 = 入参 after_sequence）
    pub next_after_sequence: u64,
    /// 是否还有更多事件
    pub has_more: bool,
}

/// run 执行统计（usage 域；前端 `parseRunSnapshotUsage` 消费面）。
///
/// P5 S5 / T-40：缓存字段扩展（cacheMissTokens / hitRatio / writeRatio /
/// missedTokens / warmUntilMs，T-47 前端 `fetchRunSnapshotUsage` 透出面）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunUsage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
    /// 有真实样本的次数（0 = 无真实样本，调用方回退估算）
    #[serde(default)]
    pub sample_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    /// 缓存未命中输入（服务端直报优先，否则按 C9 口径推导）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_miss_tokens: Option<u64>,
    /// 命中率 = cache_read / input_total（input_total == 0 → None，前端隐藏）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hit_ratio: Option<f64>,
    /// 写入占比 = cache_write / input_total
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_ratio: Option<f64>,
    /// 本 run 审计出的浪费量（detectMiss 累计；0 = 无浪费）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missed_tokens: Option<u64>,
    /// 缓存温暖截止（epoch ms；前端据此驱动冷缓存提示；None = 无 TTL 数据）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warm_until_ms: Option<u64>,
}

impl RunUsage {
    /// 从 run 级缓存统计映射为快照 usage（P5 S5 / T-40；数据源 =
    /// `RunOutcome.cache_stats`（tracker.finish 产物）或 conex-db
    /// `get_run_usage`（runs 表 v5 列，T-39）——两者同型）。
    ///
    /// - `sample_count == 0` → None（「无样本 → 前端隐藏而非 0% 误导」，
    ///   P5 §3.1.2 / T-39 `get_run_usage` 同口径）；
    /// - hit_ratio / write_ratio 不直接透传（DB 落库不存派生值，T-39），
    ///   统一按 C9 恒等式重算：`input_total = miss + read + write`；
    ///   `input_total == 0` → None。
    #[allow(dead_code)] // T-40 轮末合并：CoreRunState::run_usage 消费（core_run_commands.rs）
    pub fn from_run_cache_stats(stats: RunCacheStats) -> Option<RunUsage> {
        if stats.sample_count == 0 {
            return None;
        }
        let input_total = stats
            .cache_miss_tokens
            .saturating_add(stats.cache_read_tokens)
            .saturating_add(stats.cache_write_tokens);
        let ratio = |part: u64| (input_total != 0).then(|| part as f64 / input_total as f64);
        Some(RunUsage {
            prompt_tokens: stats.prompt_tokens,
            completion_tokens: stats.completion_tokens,
            total_tokens: stats.total_tokens,
            sample_count: stats.sample_count,
            cache_read_tokens: Some(stats.cache_read_tokens),
            cache_write_tokens: Some(stats.cache_write_tokens),
            cache_miss_tokens: Some(stats.cache_miss_tokens),
            hit_ratio: ratio(stats.cache_read_tokens),
            write_ratio: ratio(stats.cache_write_tokens),
            missed_tokens: Some(stats.missed_tokens),
            warm_until_ms: stats.warm_until_ms,
        })
    }
}

/// run 快照（`{snapshot: {...}}` 包装；对齐 daemon get-run-snapshot 协议——
/// `StreamRecovery` / `parseRunSnapshotUsage` 均先读 `res.snapshot`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshotResponse {
    pub snapshot: RunSnapshot,
}

/// run 快照本体（status 字面量对齐 conex-db `RunStatus::as_str`：queued / running /
/// completed / failed / cancelled / ...）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub run_id: String,
    pub session_id: String,
    pub status: String,
    /// 事件序列游标（已分配最大 sequence）
    pub cursor: u64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
    /// 终态错误文案（failed 收场时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// usage 域（引擎未接线统计时缺省）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<RunUsage>,
}

/// 参数校验：session_id 非空 + 长度上限（S-15/S-16，显式 InvalidInput）。
fn require_session_id(session_id: &str) -> Result<(), CoreError> {
    if session_id.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "session_id must not be empty".to_string(),
        ));
    }
    if session_id.len() > ID_MAX_LEN {
        return Err(CoreError::InvalidInput(format!(
            "session_id too long (max {ID_MAX_LEN})"
        )));
    }
    Ok(())
}

/// 参数校验：run_id 非空 + 长度上限。
fn require_run_id(run_id: &str) -> Result<(), CoreError> {
    if run_id.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "run_id must not be empty".to_string(),
        ));
    }
    if run_id.len() > ID_MAX_LEN {
        return Err(CoreError::InvalidInput(format!(
            "run_id too long (max {ID_MAX_LEN})"
        )));
    }
    Ok(())
}

/// 归一化 max_events：缺省 DEFAULT_PAGE_SIZE，夹紧到 [1, MAX_PAGE_SIZE]。
fn normalize_max_events(max_events: Option<u64>) -> usize {
    max_events
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE) as usize
}

/// 把持久化事件行解析为 (sequence, AgentEventEnvelope)（损坏载荷跳过，防御性——
/// 写入时已校验，损坏只可能是磁盘故障，跳过不中断整页读取）。
fn parse_envelopes(events: &[orchestrator::persist::PersistedEvent]) -> Vec<(u64, AgentEventEnvelope)> {
    events
        .iter()
        .filter_map(|event| {
            let envelope: AgentEventEnvelope = serde_json::from_str(&event.payload).ok()?;
            Some((event.sequence, envelope))
        })
        .collect()
}

/// 信封 → 扁平 wire JSON（`{type, runId, sequence, schemaVersion, ...事件字段}`）。
fn envelope_to_value(envelope: &AgentEventEnvelope) -> Option<serde_json::Value> {
    serde_json::to_value(envelope).ok()
}

/// 纯分页：从全量（已按 sequence 升序）切出前 `max_events` 条，返回 (页, hasMore)。
fn paginate<T>(all: Vec<T>, max_events: usize) -> (Vec<T>, bool) {
    if all.len() <= max_events {
        return (all, false);
    }
    let page = all.into_iter().take(max_events).collect::<Vec<_>>();
    (page, true)
}

/// core_read_session_events：分页读取会话事件流（03 §3.2 B；cursor = after_sequence）。
///
/// 入参对齐 daemon read-session-events：`sessionId` / `afterSequence` / `maxEvents`。
#[tauri::command]
pub async fn core_read_session_events(
    session_id: String,
    after_sequence: Option<u64>,
    max_events: Option<u64>,
    core: State<'_, Arc<CoreRunState>>,
) -> Result<EventPage, CoreError> {
    require_session_id(&session_id)?;
    let page_size = normalize_max_events(max_events);
    let after = after_sequence.unwrap_or(0);

    let store = core.store();
    let events = store
        .query_events(&session_id, after)
        .await
        .map_err(map_store_err)?;

    let page_items: Vec<(u64, serde_json::Value)> = parse_envelopes(&events)
        .into_iter()
        .filter_map(|(seq, envelope)| envelope_to_value(&envelope).map(|v| (seq, v)))
        .collect();
    let (page, has_more) = paginate(page_items, page_size);
    let next_after_sequence = page.last().map(|(seq, _)| *seq).unwrap_or(after);

    Ok(EventPage {
        events: page.into_iter().map(|(_, value)| value).collect(),
        next_after_sequence,
        has_more,
    })
}

/// core_read_run_events：分页读取单个 run 的事件流（按信封 runId 过滤）。
///
/// 入参对齐 daemon read-run-events：`runId` / `sessionId`（可选，缺省从 run 记录反查）/
/// `afterSequence` / `maxEvents`。
#[tauri::command]
pub async fn core_read_run_events(
    run_id: String,
    session_id: Option<String>,
    after_sequence: Option<u64>,
    max_events: Option<u64>,
    core: State<'_, Arc<CoreRunState>>,
) -> Result<EventPage, CoreError> {
    require_run_id(&run_id)?;
    let page_size = normalize_max_events(max_events);
    let after = after_sequence.unwrap_or(0);

    let store = core.store();
    let session_id = match session_id {
        Some(id) if !id.trim().is_empty() => id,
        _ => {
            // 未提供 sessionId：从 run 记录反查（run.not_found 语义）
            let runs = store.query_runs().await.map_err(map_store_err)?;
            runs.into_iter()
                .find(|run| run.run_id == run_id)
                .map(|run| run.session_id)
                .ok_or_else(|| CoreError::NotFound(format!("run not found: {run_id}")))?
        }
    };

    let events = store
        .query_events(&session_id, after)
        .await
        .map_err(map_store_err)?;

    let run_events: Vec<(u64, serde_json::Value)> = parse_envelopes(&events)
        .into_iter()
        .filter(|(_, envelope)| envelope.run_id.as_deref() == Some(run_id.as_str()))
        .filter_map(|(seq, envelope)| envelope_to_value(&envelope).map(|v| (seq, v)))
        .collect();
    let (page, has_more) = paginate(run_events, page_size);
    let next_after_sequence = page.last().map(|(seq, _)| *seq).unwrap_or(after);

    Ok(EventPage {
        events: page.into_iter().map(|(_, value)| value).collect(),
        next_after_sequence,
        has_more,
    })
}

/// core_get_run_snapshot：查询 run 快照（状态 / 游标 / 终态 / usage）。
///
/// 返回 `{ snapshot: RunSnapshot }`（对齐 daemon get-run-snapshot 协议；
/// `sessionId` 可选，提供时校验与 run 记录一致）。
#[tauri::command]
pub async fn core_get_run_snapshot(
    run_id: String,
    session_id: Option<String>,
    core: State<'_, Arc<CoreRunState>>,
) -> Result<RunSnapshotResponse, CoreError> {
    require_run_id(&run_id)?;

    let store = core.store();
    let runs = store.query_runs().await.map_err(map_store_err)?;
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

    Ok(RunSnapshotResponse {
        snapshot: RunSnapshot {
            run_id: run.run_id.clone(),
            session_id: run.session_id.clone(),
            status: run.status.as_str().to_string(),
            cursor: run.cursor as u64,
            created_at: run.created_at,
            updated_at: run.updated_at,
            end_reason: run.end_reason.clone(),
            error: core.run_error(&run_id),
            usage: core.run_usage(&run_id),
        },
    })
}

// ===== core_list_commands（注册表单一化，PE-03 T03.1）=====
//
// 实现唯一真源在 `command_manifest.rs`（COMMAND_MANIFEST 常量 + `core_list_commands`
// 命令本体），main.rs 直接引用该真源注册（G11a：本文件原重导出无消费方，已删）。

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_error::CoreError;

    #[test]
    fn build_status_serializes_to_camel_case() {
        let status = build_status(
            true,
            "0.1.0".to_string(),
            true,
            true,
            true,
            false,
            ProviderStatus {
                has_api_key: Some(false),
                model: None,
                base_url: None,
                credential_mode: Some("direct".to_string()),
            },
            "info".to_string(),
            r"C:\logs".to_string(),
            vec![DiagnosticEntry {
                ts: 1_700_000_000_000,
                level: "error".to_string(),
                message: "disk full".to_string(),
            }],
            Some(LastErrorEntry {
                kind: "Io".to_string(),
                detail: "store.append_event: disk full".to_string(),
                ts: 1_700_000_000_001,
            }),
            RestoreStatus {
                state: "done",
                mode: "full-replay".to_string(),
                snapshot_note: None,
                interrupted_count: 2,
                last_sequence: Some(41),
            },
            SnapshotStatus {
                generation: 1,
                written_at: Some(1_700_000_000_002),
                last_error: None,
            },
        );
        let json = serde_json::to_value(&status).unwrap();
        // 基线字段 camelCase
        assert_eq!(json["initialized"], true);
        assert_eq!(json["version"], "0.1.0");
        assert_eq!(json["engineReady"], true);
        assert_eq!(json["searchIndexReady"], true);
        assert_eq!(json["dbReady"], true);
        assert_eq!(json["compactionReady"], false, "未接线压缩 = false（诚实化）");
        // providerStatus（PE-01 T01.1）
        assert_eq!(json["providerStatus"]["hasApiKey"], false);
        assert_eq!(json["providerStatus"]["credentialMode"], "direct");
        assert!(json["providerStatus"].get("model").is_none(), "None 字段跳过");
        // PE-04 增量
        assert_eq!(json["logLevel"], "info");
        assert_eq!(json["logDir"], r"C:\logs");
        assert_eq!(json["diagnostics"][0]["ts"], 1_700_000_000_000_i64);
        assert_eq!(json["diagnostics"][0]["level"], "error");
        assert_eq!(json["diagnostics"][0]["message"], "disk full");
        assert_eq!(json["lastError"]["kind"], "Io");
        assert_eq!(json["lastError"]["detail"], "store.append_event: disk full");
        assert_eq!(json["lastError"]["ts"], 1_700_000_000_001_i64);
        // PE-08 增量
        assert_eq!(json["restore"]["state"], "done");
        assert_eq!(json["restore"]["mode"], "full-replay");
        assert_eq!(json["restore"]["interruptedCount"], 2);
        assert_eq!(json["restore"]["lastSequence"], 41);
        assert_eq!(json["snapshot"]["generation"], 1);
        assert_eq!(json["snapshot"]["writtenAt"], 1_700_000_000_002_i64);
        // 不得出现 snake_case 键
        for key in [
            "search_index_ready",
            "db_ready",
            "compaction_ready",
            "provider_status",
            "log_level",
            "log_dir",
            "last_error",
        ] {
            assert!(json.get(key).is_none(), "不得出现 snake_case 键 {key}");
        }
    }

    #[test]
    fn build_status_defaults_are_honest() {
        let status = build_status(
            false,
            "0.1.0".to_string(),
            false,
            false,
            false,
            false,
            ProviderStatus {
                has_api_key: None,
                model: None,
                base_url: None,
                credential_mode: None,
            },
            "info".to_string(),
            String::new(),
            Vec::new(),
            None,
            RestoreStatus {
                state: "pending",
                mode: String::new(),
                snapshot_note: None,
                interrupted_count: 0,
                last_sequence: None,
            },
            SnapshotStatus {
                generation: 0,
                written_at: None,
                last_error: None,
            },
        );
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["initialized"], false);
        assert_eq!(json["providerStatus"]["hasApiKey"], serde_json::Value::Null);
        assert_eq!(json["diagnostics"], serde_json::json!([]));
        assert!(json.get("lastError").is_none(), "无错误记录时 lastError 缺省");
        assert_eq!(json["restore"]["state"], "pending");
        assert!(json["restore"].get("lastSequence").is_none());
        assert_eq!(json["snapshot"]["generation"], 0);
    }

    #[test]
    fn normalize_max_events_clamps() {
        assert_eq!(normalize_max_events(None), DEFAULT_PAGE_SIZE as usize);
        assert_eq!(normalize_max_events(Some(0)), 1);
        assert_eq!(normalize_max_events(Some(500)), 500);
        assert_eq!(normalize_max_events(Some(10_000)), MAX_PAGE_SIZE as usize);
    }

    #[test]
    fn paginate_splits_pages() {
        let all: Vec<u64> = (1..=10).collect();
        let (page, has_more) = paginate(all.clone(), 4);
        assert_eq!(page, vec![1, 2, 3, 4]);
        assert!(has_more);
        let (page, has_more) = paginate(all.clone(), 10);
        assert_eq!(page, all);
        assert!(!has_more);
        let (page, has_more) = paginate::<u64>(vec![], 4);
        assert!(page.is_empty());
        assert!(!has_more);
    }

    #[test]
    fn require_ids_validate() {
        assert!(require_session_id("s1").is_ok());
        assert!(require_session_id("  ").is_err());
        assert!(require_run_id("").is_err());
        let long = "x".repeat(ID_MAX_LEN + 1);
        match require_run_id(&long) {
            Err(CoreError::InvalidInput(detail)) => assert!(detail.contains("too long")),
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn parse_envelopes_skips_corrupt_payloads() {
        use orchestrator::persist::PersistedEvent;
        let events = vec![
            PersistedEvent {
                session_id: "s1".to_string(),
                sequence: 1,
                event_type: "agent-start".to_string(),
                payload: r#"{"type":"agent-start","sessionId":"s1","sequence":1,"schemaVersion":1,"runId":"r1","timestamp":"2026-01-01T00:00:00Z"}"#.to_string(),
            },
            PersistedEvent {
                session_id: "s1".to_string(),
                sequence: 2,
                event_type: "agent-start".to_string(),
                payload: "not-json".to_string(),
            },
        ];
        let parsed = parse_envelopes(&events);
        assert_eq!(parsed.len(), 1, "损坏载荷跳过");
        assert_eq!(parsed[0].0, 1);
        assert_eq!(parsed[0].1.run_id.as_deref(), Some("r1"));
        assert_eq!(parsed[0].1.sequence, Some(1));
        assert_eq!(parsed[0].1.schema_version, 1);
    }

    #[test]
    fn envelope_roundtrips_to_flat_wire_json() {
        use conex_types::events::{AgentEvent, AgentEventEnvelope};
        let envelope = AgentEventEnvelope::new(
            AgentEvent::AgentStart {
                session_id: "s1".to_string(),
                timestamp: "2026-01-01T00:00:00Z".to_string(),
            },
            Some("r1".to_string()),
            Some(7),
        );
        let value = envelope_to_value(&envelope).expect("序列化");
        assert_eq!(value["type"], "agent-start");
        assert_eq!(value["runId"], "r1");
        assert_eq!(value["sequence"], 7);
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["sessionId"], "s1");
    }

    // ── P5 S5 / T-40：run_usage 真实返回（RunUsage 缓存字段映射）──────

    /// 构造测试用 run 级缓存统计（tracker.finish / DB get_run_usage 同型）
    fn usage_stats() -> RunCacheStats {
        RunCacheStats {
            prompt_tokens: 1_000,
            completion_tokens: 50,
            total_tokens: 1_050,
            cache_read_tokens: 800,
            cache_write_tokens: 100,
            cache_miss_tokens: 100,
            sample_count: 1,
            // 落库读回不存派生值（T-39：hit_ratio 一律 None）——映射层
            // 必须按 C9 恒等式重算，不能透传
            hit_ratio: None,
            write_ratio: None,
            missed_tokens: 2_000,
            warm_until_ms: Some(61_000),
        }
    }

    /// T-40：from_run_cache_stats 全字段映射——原始计数透传 + hitRatio /
    /// writeRatio 按 C9 恒等式重算（input_total = miss + read + write）
    #[test]
    fn run_usage_from_cache_stats_maps_all_fields() {
        let usage = RunUsage::from_run_cache_stats(usage_stats()).expect("有样本必须映射");
        assert_eq!(usage.prompt_tokens, 1_000);
        assert_eq!(usage.completion_tokens, 50);
        assert_eq!(usage.total_tokens, 1_050);
        assert_eq!(usage.sample_count, 1);
        assert_eq!(usage.cache_read_tokens, Some(800));
        assert_eq!(usage.cache_write_tokens, Some(100));
        assert_eq!(usage.cache_miss_tokens, Some(100));
        // 800 / (100 + 800 + 100) = 0.8
        assert_eq!(usage.hit_ratio, Some(0.8));
        // 100 / 1000 = 0.1
        assert_eq!(usage.write_ratio, Some(0.1));
        assert_eq!(usage.missed_tokens, Some(2_000));
        assert_eq!(usage.warm_until_ms, Some(61_000));

        // wire 形状：camelCase（T-47 前端 fetchRunSnapshotUsage 消费面）
        let value = serde_json::to_value(&usage).unwrap();
        assert_eq!(value["cacheReadTokens"], 800);
        assert_eq!(value["cacheWriteTokens"], 100);
        assert_eq!(value["cacheMissTokens"], 100);
        assert_eq!(value["hitRatio"], 0.8);
        assert_eq!(value["writeRatio"], 0.1);
        assert_eq!(value["missedTokens"], 2_000);
        assert_eq!(value["warmUntilMs"], 61_000);
        assert!(
            value.get("cache_read_tokens").is_none(),
            "不得出现 snake_case 键"
        );
    }

    /// T-40：无样本（sample_count == 0）→ None（前端隐藏而非 0% 误导，
    /// P5 §3.1.2；与 T-39 get_run_usage 同口径）
    #[test]
    fn run_usage_from_cache_stats_none_without_samples() {
        let stats = RunCacheStats {
            sample_count: 0,
            ..Default::default()
        };
        assert!(RunUsage::from_run_cache_stats(stats).is_none());
    }

    /// T-40：input_total == 0（无任何输入侧数据）→ hitRatio / writeRatio
    /// None（前端隐藏而非显示 0%）
    #[test]
    fn run_usage_from_cache_stats_ratio_none_when_zero_input() {
        let stats = RunCacheStats {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cache_miss_tokens: 0,
            sample_count: 1,
            ..Default::default()
        };
        let usage = RunUsage::from_run_cache_stats(stats).expect("有样本必须映射");
        assert_eq!(usage.cache_read_tokens, Some(0));
        assert_eq!(usage.hit_ratio, None, "input_total == 0 → 占比隐藏");
        assert_eq!(usage.write_ratio, None);
        assert_eq!(usage.warm_until_ms, None);
    }
}
