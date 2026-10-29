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

use agent_provider::models::CredentialRef;
use tauri::State;

use crate::core_commands::{SharedCompactionState, SharedGatekeeper, SharedSearchState};
use conex_run::core_error::{map_store_err, CoreError};

// ⚠️ 依赖类型（由协作方定稿，当前缺失；接入后本文件即可编译）：
// - `conex_run::status_diagnostics::StatusDiagnostics`：**R1 重写**（PE-04 T04.5）。
//   本文件依赖其两个只读访问器（契约）：
//   `entries() -> Vec<DiagnosticEntry>`（环形 20，最旧在前）、
//   `last_error() -> Option<LastErrorEntry>`；
// - `CoreRunState`（PE-08 T08.6 定稿；main.rs `app.manage(Arc::new(...))` 接线）。
//   本文件依赖其访问器契约（见 [CoreRunState 访问器契约] 注释块）。
use conex_run::status_diagnostics::StatusDiagnostics;

// ===== 查询契约类型与纯解析面（已下沉 conex-run::core_query）==========
// 类型（CoreStatus / EventPage / RunUsage / RunSnapshot 族）与纯解析函数
// （parse_envelopes / require_* / paginate 等）真源 = `conex_run::core_query`；
// 本文件只保留 Tauri 命令薄壳与 build_status 组装（依赖宿主 log_dir /
// 配置单例）。

pub(crate) use conex_run::core_query::{
    normalize_max_events, paginate, parse_envelopes, require_run_id, require_session_id,
    warn_parse_stats, BackgroundTasksSummary, CoreStatus, DiagnosticEntry, EventPage,
    LastCrashInfo, LastErrorEntry, ProviderStatus, RestoreStatus, RunSnapshot, RunSnapshotResponse,
    SnapshotStatus,
};

/// 组装 CoreStatus（**唯一**组装函数；F2 串行序：PE-01 → PE-04 → PE-08 以追加参数并入，
/// 与 Tauri 解耦，纯数据组装可单测）。
// G2 允许理由（clippy::too_many_arguments）：参数为状态快照聚合注入（基线
// 标志/提供方状态/诊断/恢复/快照/后台任务汇总等，随 F2 串行序追加并入），
// 各参数来源独立，收缩将退化为全局态或拆分 struct 而收益低。
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
    // T-AB-19 增量（run 生命周期整合：后台任务汇总）
    background_tasks: BackgroundTasksSummary,
    // P-7 增量（R2-07 D-02 收尾：activeRuns / pendingApprovals 摘要）
    active_runs: Vec<ActiveRunSummary>,
    pending_approvals: Vec<PendingApprovalSummary>,
    // T5-1b 增量（崩溃台账：进程内崩溃标记；None = 无 panic）
    last_crash: Option<LastCrashInfo>,
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
        background_tasks,
        active_runs,
        pending_approvals,
        last_crash,
    }
}

/// 从统一配置解析组装 providerStatus（PE-01 T01.1；无硬编码，三态如实）。
///
/// `has_api_key` 语义：活动模型未解析（`Ok(None)` = 用户未选择 / `Err` = 配置未就绪）
/// 时整体投影为 `None`（无法判定），解析成功时按凭据是否缺省判定。
pub(crate) fn provider_status_from_config() -> ProviderStatus {
    let resolved = match crate::config::resolve_active_model() {
        Ok(Some(resolved)) => resolved,
        // Ok(None) = 用户未选择活动模型；Err = 配置未就绪；二者均如实投影为 None。
        Ok(None) | Err(_) => {
            return ProviderStatus {
                has_api_key: None,
                model: None,
                base_url: None,
                credential_mode: None,
            };
        }
    };
    let has_api_key = Some(!resolved.api_key.as_str().is_empty());
    let model = Some(resolved.model.id.clone());
    let base_url = resolved.provider.base_url.clone();
    let credential_mode = match resolved.provider.api_key_ref.as_deref() {
        Some(reference) => match CredentialRef::parse(reference) {
            Ok(CredentialRef::Dpapi(_)) => "dpapi",
            Ok(CredentialRef::Env(_)) => "env",
            Err(_) => "invalid",
        },
        None => "unset",
    };
    ProviderStatus {
        has_api_key,
        model,
        base_url,
        credential_mode: Some(credential_mode.to_string()),
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
use conex_run::run::{ActiveRunSummary, CoreRunState, PendingApprovalSummary};

/// core_get_status：核心状态查询（03 §3.2 B；无硬编码 true 字段）。
///
/// 数据源全部来自 State / 静态存储（main.rs 接线）：
/// - `core`（Arc<CoreRunState>）：initialized / engineReady / restore /
///   snapshot / backgroundTasks（T-AB-19：后台任务汇总，异步查询注册表）；
/// - `diagnostics`（Arc<StatusDiagnostics>，R1；main.rs 与 CoreRunState 共享
///   同一实例，避免写入侧与读取侧漂移）：diagnostics / lastError；
/// - `gatekeeper`（SharedGatekeeper）：就绪诊断预留接入点（当前仅占位，未消费）；
/// - `compaction`（SharedCompactionState，PE-01 T01.2）：compactionReady；
/// - `search`（Arc<SharedSearchState>，C21 托管形态：main.rs manage Arc，本地
///   服务后端经 Arc clone 共享同一实例）：searchIndexReady（文件数 > 0 推断）；
/// - `db`（SharedDb）：dbReady。
#[tauri::command]
pub async fn core_get_status(
    core: State<'_, Arc<CoreRunState>>,
    diagnostics: State<'_, Arc<StatusDiagnostics>>,
    _gatekeeper: State<'_, SharedGatekeeper>,
    compaction: State<'_, SharedCompactionState>,
    search: State<'_, Arc<SharedSearchState>>,
    db: State<'_, crate::session_commands::SharedDb>,
) -> Result<CoreStatus, CoreError> {
    let search_index_ready = search
        .files
        .read()
        .map(|files| !files.is_empty())
        .unwrap_or(false);
    // engineReady（core.engine_ready()）语义注记（T5-1：假就绪修正）——
    // 仅指 provider 配置三件套（baseUrl/model/apiKey）齐备，**非运行时
    // 健康探针**；引擎崩溃感知由前端心跳（fetchEngineLiveStatus 连续失败
    // 判死）+ 本响应 lastCrash 崩溃台账承担，engineReady 不得再被当作
    // 崩溃真源。
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
        core.background_tasks_summary().await,
        // P-7（R2-07 D-02 收尾）：activeRuns / pendingApprovals 摘要——
        // GUI 命令面与 /v1/status 共用同一组装函数，同步下发
        conex_run::run::list_active_runs_impl(&core).await,
        conex_run::run::list_pending_approval_summaries_impl(&core),
        // T5-1b：崩溃台账读出面（conex-telemetry 进程内标记；leaf crate
        // 边界——不新增 Tauri State，标记本身即进程级真源）
        conex_telemetry::last_crash_marker().map(|marker| LastCrashInfo {
            file_name: marker.file_name,
            timestamp_ms: marker.timestamp_ms,
        }),
    ))
}

// ===== 事件查询命令（分页契约类型与纯解析面已下沉 conex_run::core_query）=====

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
    // DM-07：limit 下推（page_size + 1 判 has_more，SQL 层 LIMIT，修复
    // O(n) 全量读出 + 全量 serde）——has_more 以原始行数判断（corrupt 行
    // 跳过不缩小「其后仍有行」的判断），游标 = 页内末事件全局 sequence
    let events = store
        .query_events(&session_id, after, Some(page_size as u64 + 1))
        .await
        .map_err(map_store_err)?;

    let (page_items, stats) = parse_envelopes(&events);
    warn_parse_stats("read_session_events", &session_id, &stats);
    let page = paginate(page_items, page_size).0;
    let has_more = events.len() > page_size;
    let next_after_sequence = page.last().map(|(seq, _)| *seq).unwrap_or(after);

    Ok(EventPage {
        events: page.into_iter().map(|(_, value)| value).collect(),
        next_after_sequence,
        has_more,
    })
}

/// core_read_run_events：分页读取单个 run 的事件流（按 run_id 列归属过滤）。
///
/// 入参对齐 daemon read-run-events：`runId` / `sessionId`（可选，缺省从 run 记录反查）/
/// `afterSequence` / `maxEvents`。
///
/// ## 事件归属契约（三分类 · DM-08 唯一执行面，F-04）
///
/// events 表行按 run_id 列分三类归属，run 查询的命中面如下：
/// - **run 收尾区**：同一 runId 的终态后尾事件（审计排空 audit_worker.await /
///   子代理收尾 subagent-ended）归属该 run，查询返回区间 = [run 首事件,
///   收尾区末事件]，「run-terminal 是流尾」为陈旧断言——正确语义是
///   「run-terminal 是该 run 主体流的流尾，收尾区以同 runId 续排」；
/// - **轮次域（goal-*）**：goal-round-started / goal-round-completed /
///   goal-continuation-decided 三事件跨 run 边界，run_id 列为 NULL，按 run
///   查询**不命中**（R-06 裁决 C-2，04 PC-07 口径）；
/// - **会话域（空闲态）**：runId=None（手动压缩等空闲态事件）归会话域，
///   按会话查询返回，按 run 查询不命中。
///
/// ## 排序契约（R-08 / DM-08）
///
/// **排序唯一依据 = sequence**（会话级全局单调，跨 run 不重置）；created_at
/// 仅作展示不作排序键；payload 内 timestamp 与行级 created_at 为时钟双源
/// 并存，均不参与排序（前端按 sequence 消费）。
///
/// F-03（DM-07）：**T-F 06 退役登记撤销——IPC 面恢复激活**（main.rs
/// COMMAND_REGISTRY + command_manifest registered=true 同步恢复，注册态
/// 不得静默再退役）。实现统一委托 [conex_run::run::read_run_events_impl]
/// （server 直调体同源，避免双实现漂移）：SQL 按 run_id 列过滤 + 全链含
/// tail + goal-* 轮次域排除 + limit 下推 + 游标 = 页末全局 sequence。
#[tauri::command]
pub async fn core_read_run_events(
    run_id: String,
    session_id: Option<String>,
    after_sequence: Option<u64>,
    max_events: Option<u64>,
    core: State<'_, Arc<CoreRunState>>,
) -> Result<EventPage, CoreError> {
    require_run_id(&run_id)?;
    conex_run::run::read_run_events_impl(
        &core,
        &run_id,
        session_id.as_deref(),
        after_sequence,
        max_events,
    )
    .await
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
mod tests;
