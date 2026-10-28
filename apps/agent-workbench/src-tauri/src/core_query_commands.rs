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
mod tests {
    use super::*;
    use agent_provider::models::PricingUnit;
    use conex_run::core_error::CoreError;
    use conex_run::core_query::{
        LastTaskTerminal, RunUsage, DEFAULT_PAGE_SIZE, ID_MAX_LEN, MAX_PAGE_SIZE,
    };
    use conex_types::events::RunCacheStats;

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
            BackgroundTasksSummary {
                active_count: 3,
                daemon_count: 1,
                last_finished: Some(LastTaskTerminal {
                    task_id: "task-9".to_string(),
                    status: "completed".to_string(),
                    finished_at_ms: 1_700_000_000_003,
                }),
            },
            // P-7（R2-07 D-02 收尾）：activeRuns / pendingApprovals 摘要
            vec![ActiveRunSummary {
                run_id: "r-1".to_string(),
                session_id: "s-1".to_string(),
                status: "running".to_string(),
                started_at: 1_700_000_000_004,
                // prompt 兜底：runs 表无 prompt 持久化，恒空串
                prompt: String::new(),
            }],
            vec![PendingApprovalSummary {
                tool_call_id: "tc-9".to_string(),
                tool_name: "shell:write".to_string(),
                run_id: Some("r-1".to_string()),
                summary: Some("npm test 需要执行权限".to_string()),
            }],
            // T5-1b：崩溃台账（进程内 panic 崩溃标记）
            Some(LastCrashInfo {
                file_name: "crash-20260816-120000-main.log".to_string(),
                timestamp_ms: 1_700_000_000_005,
            }),
        );
        let json = serde_json::to_value(&status).unwrap();
        // 基线字段 camelCase
        assert_eq!(json["initialized"], true);
        assert_eq!(json["version"], "0.1.0");
        assert_eq!(json["engineReady"], true);
        assert_eq!(json["searchIndexReady"], true);
        assert_eq!(json["dbReady"], true);
        assert_eq!(
            json["compactionReady"], false,
            "未接线压缩 = false（诚实化）"
        );
        // providerStatus（PE-01 T01.1）
        assert_eq!(json["providerStatus"]["hasApiKey"], false);
        assert_eq!(json["providerStatus"]["credentialMode"], "direct");
        assert!(
            json["providerStatus"].get("model").is_none(),
            "None 字段跳过"
        );
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
        // T-AB-19 增量（后台任务汇总）
        assert_eq!(json["backgroundTasks"]["activeCount"], 3);
        assert_eq!(json["backgroundTasks"]["daemonCount"], 1);
        assert_eq!(json["backgroundTasks"]["lastFinished"]["taskId"], "task-9");
        assert_eq!(
            json["backgroundTasks"]["lastFinished"]["status"],
            "completed"
        );
        assert_eq!(
            json["backgroundTasks"]["lastFinished"]["finishedAtMs"],
            1_700_000_000_003_i64
        );
        // P-7 增量（activeRuns / pendingApprovals；M6 §4.1.1 形状）
        assert_eq!(json["activeRuns"][0]["runId"], "r-1");
        assert_eq!(json["activeRuns"][0]["sessionId"], "s-1");
        assert_eq!(json["activeRuns"][0]["status"], "running");
        assert_eq!(json["activeRuns"][0]["startedAt"], 1_700_000_000_004_i64);
        assert_eq!(json["activeRuns"][0]["prompt"], "", "prompt 兜底恒空串");
        assert_eq!(json["pendingApprovals"][0]["toolCallId"], "tc-9");
        assert_eq!(json["pendingApprovals"][0]["toolName"], "shell:write");
        assert_eq!(json["pendingApprovals"][0]["runId"], "r-1");
        assert_eq!(
            json["pendingApprovals"][0]["summary"],
            "npm test 需要执行权限"
        );
        // T5-1b 增量（崩溃台账）
        assert_eq!(
            json["lastCrash"]["fileName"],
            "crash-20260816-120000-main.log"
        );
        assert_eq!(json["lastCrash"]["timestampMs"], 1_700_000_000_005_i64);
        // 不得出现 snake_case 键
        for key in [
            "search_index_ready",
            "db_ready",
            "compaction_ready",
            "provider_status",
            "log_level",
            "log_dir",
            "last_error",
            "background_tasks",
            "active_count",
            "daemon_count",
            "last_finished",
            "active_runs",
            "pending_approvals",
            "last_crash",
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
            BackgroundTasksSummary::default(),
            Vec::new(),
            Vec::new(),
            None,
        );
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["initialized"], false);
        assert_eq!(json["providerStatus"]["hasApiKey"], serde_json::Value::Null);
        assert_eq!(json["diagnostics"], serde_json::json!([]));
        assert!(
            json.get("lastError").is_none(),
            "无错误记录时 lastError 缺省"
        );
        assert_eq!(json["restore"]["state"], "pending");
        assert!(json["restore"].get("lastSequence").is_none());
        assert_eq!(json["snapshot"]["generation"], 0);
        assert_eq!(json["backgroundTasks"]["activeCount"], 0, "未接线汇总 = 0");
        assert_eq!(json["backgroundTasks"]["daemonCount"], 0);
        assert!(
            json["backgroundTasks"].get("lastFinished").is_none(),
            "无终态任务时 lastFinished 缺省"
        );
        // P-7：空态 activeRuns / pendingApprovals 下发空数组（注册表可选
        // 字段——桌面端总是下发数组，空数组合法）
        assert_eq!(json["activeRuns"], serde_json::json!([]));
        assert_eq!(json["pendingApprovals"], serde_json::json!([]));
        // T5-1b：无崩溃标记时 lastCrash 缺省（诚实化，不下发 null）
        assert!(
            json.get("lastCrash").is_none(),
            "无崩溃标记时 lastCrash 缺省"
        );
    }

    /// T-AB-19：后台任务汇总 wire 形状（camelCase + lastFinished 缺省规则）
    #[test]
    fn background_tasks_summary_serializes_camel_case() {
        let summary = BackgroundTasksSummary {
            active_count: 2,
            daemon_count: 1,
            last_finished: Some(LastTaskTerminal {
                task_id: "task-3".to_string(),
                status: "killed".to_string(),
                finished_at_ms: 1_700_000_000_010,
            }),
        };
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["activeCount"], 2);
        assert_eq!(json["daemonCount"], 1);
        assert_eq!(json["lastFinished"]["taskId"], "task-3");
        assert_eq!(json["lastFinished"]["status"], "killed");
        assert_eq!(json["lastFinished"]["finishedAtMs"], 1_700_000_000_010_i64);
        assert!(json.get("active_count").is_none(), "不得出现 snake_case 键");

        let empty = BackgroundTasksSummary::default();
        let json = serde_json::to_value(&empty).unwrap();
        assert_eq!(json["activeCount"], 0);
        assert!(json.get("lastFinished").is_none(), "缺省值跳过序列化");
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
                run_id: None,
                created_at: "2026-01-01 00:00:00.001".to_string(),
            },
            PersistedEvent {
                session_id: "s1".to_string(),
                sequence: 2,
                event_type: "agent-start".to_string(),
                payload: "not-json".to_string(),
                run_id: None,
                created_at: "2026-01-01 00:00:00.002".to_string(),
            },
        ];
        let (parsed, stats) = parse_envelopes(&events);
        assert_eq!(parsed.len(), 1, "损坏载荷跳过");
        assert_eq!(parsed[0].0, 1);
        assert_eq!(parsed[0].1["runId"], "r1");
        assert_eq!(parsed[0].1["sequence"], 1);
        assert_eq!(parsed[0].1["schemaVersion"], 1);
        assert_eq!(stats.corrupt_skipped, 1, "态 1 计数不静默");
        assert_eq!(stats.typed, 1);
        assert_eq!(stats.synthesized, 0);
    }

    /// DM-06 态 3：无 type 标签的合法 JSON（run-interrupted / recovery-*
    /// 镜像 / legacy 行）→ D8 合成 fallback，wire 含
    /// type/runId/sequence/schemaVersion/sessionId 五键 + 原始字段透传
    /// （消灭 G-02/G-20 读侧静默丢弃）。
    #[test]
    fn parse_envelopes_fallback_synthesizes_body_only_rows() {
        use orchestrator::persist::PersistedEvent;
        let events = vec![
            // run-interrupted 直写镜像（restore_manager 形状：InterruptedRun
            // record，payload 自带 run_id/session_id 键但**无顶层 type 键**）
            PersistedEvent {
                session_id: "s1".to_string(),
                sequence: 5,
                event_type: "run-interrupted".to_string(),
                payload: r#"{"run_id":"r-9","session_id":"s1","previous_status":"running","status":"failed","reason":"daemon-restarted","error":"connection reset","timestamp":"2026-08-14T00:00:00Z"}"#.to_string(),
                run_id: None,
                created_at: "2026-08-14 00:00:00.005".to_string(),
            },
            // recovery-escalated 直写镜像（recovery.rs 形状：
            // {subagentRunId, kind, retries, elapsedMs}，无顶层 type 键）
            PersistedEvent {
                session_id: "s1".to_string(),
                sequence: 6,
                event_type: "recovery-escalated".to_string(),
                payload: r#"{"subagentRunId":"sr-1","kind":"ladder1","retries":2,"elapsedMs":1500}"#.to_string(),
                run_id: None,
                created_at: "2026-08-14 00:00:00.006".to_string(),
            },
        ];
        let (parsed, stats) = parse_envelopes(&events);
        assert_eq!(parsed.len(), 2, "镜像行全部透出，不丢弃");
        assert_eq!(stats.synthesized, 2, "态 3a 合成计数");
        assert_eq!(stats.typed, 0, "镜像非 typed，不进态 2");
        assert_eq!(stats.corrupt_skipped, 0);

        // run-interrupted：五键 + 原始字段透传（type 键 = 列 event_type 权威）
        let interrupted = &parsed[0].1;
        assert_eq!(interrupted["type"], "run-interrupted");
        assert_eq!(interrupted["runId"], "r-9", "run_id 键映射为 runId");
        assert_eq!(interrupted["sequence"], 5, "sequence 列权威回填");
        assert_eq!(interrupted["schemaVersion"], 1);
        assert_eq!(interrupted["sessionId"], "s1");
        assert_eq!(interrupted["status"], "failed", "原始字段透传");
        assert_eq!(interrupted["reason"], "daemon-restarted");
        assert_eq!(interrupted["run_id"], "r-9", "原始键保留（透传不删键）");

        // recovery-* 镜像：五键 + subagentRunId 映射为 runId（归属推断）
        let escalated = &parsed[1].1;
        assert_eq!(escalated["type"], "recovery-escalated");
        assert_eq!(escalated["runId"], "sr-1", "subagentRunId 映射为 runId");
        assert_eq!(escalated["sequence"], 6);
        assert_eq!(escalated["schemaVersion"], 1);
        assert_eq!(escalated["sessionId"], "s1");
        assert_eq!(escalated["kind"], "ladder1", "原始字段透传");
        assert_eq!(escalated["retries"], 2);
    }

    /// DM-06 态 2/态 3：sequence 列权威回填（G-05）——旧行 payload 无
    /// sequence 键时，wire sequence == 行级列值（typed 与 fallback 双路径）。
    #[test]
    fn parse_envelopes_sequence_backfilled() {
        use orchestrator::persist::PersistedEvent;
        let events = vec![
            // 旧帧 typed 信封：无 sequence 键（缺省解析 None → 列回填）
            PersistedEvent {
                session_id: "s1".to_string(),
                sequence: 11,
                event_type: "agent-start".to_string(),
                payload: r#"{"type":"agent-start","sessionId":"s1","runId":"r1","schemaVersion":1,"timestamp":"2026-01-01T00:00:00Z"}"#.to_string(),
                run_id: None,
                created_at: "2026-01-01 00:00:00.011".to_string(),
            },
            // fallback 镜像：无 sequence 键 → 列回填
            PersistedEvent {
                session_id: "s1".to_string(),
                sequence: 12,
                event_type: "run-interrupted".to_string(),
                payload: r#"{"run_id":"r-9","status":"failed"}"#.to_string(),
                run_id: None,
                created_at: "2026-01-01 00:00:00.012".to_string(),
            },
        ];
        let (parsed, _stats) = parse_envelopes(&events);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].1["sequence"], 11, "typed 旧帧列权威回填");
        assert_eq!(parsed[1].1["sequence"], 12, "fallback 列权威回填");
    }

    /// DM-06 态 3b：合法 JSON 但非对象（数组/标量）→ rawPayload 包装显式
    /// 透出（标注 skippable 形态），不静默丢弃，计数走 passthrough。
    #[test]
    fn parse_envelopes_passthrough_non_object_rows() {
        use orchestrator::persist::PersistedEvent;
        let events = vec![
            PersistedEvent {
                session_id: "s1".to_string(),
                sequence: 21,
                event_type: "legacy-weird".to_string(),
                payload: r#"[1,2,3]"#.to_string(),
                run_id: None,
                created_at: "2026-01-01 00:00:00.021".to_string(),
            },
            PersistedEvent {
                session_id: "s1".to_string(),
                sequence: 22,
                event_type: "legacy-weird".to_string(),
                payload: r#""plain string""#.to_string(),
                run_id: None,
                created_at: "2026-01-01 00:00:00.022".to_string(),
            },
        ];
        let (parsed, stats) = parse_envelopes(&events);
        assert_eq!(parsed.len(), 2, "非对象行也透出，不丢弃");
        assert_eq!(stats.passthrough, 2, "态 3b 计数");
        assert_eq!(stats.synthesized, 0);
        assert_eq!(parsed[0].1["type"], "legacy-weird");
        assert_eq!(parsed[0].1["sequence"], 21);
        assert_eq!(parsed[0].1["rawPayload"], serde_json::json!([1, 2, 3]));
        assert_eq!(parsed[1].1["rawPayload"], "plain string");
    }

    /// DM-07 P3 收口（态 2）：typed 信封 runId 取值 = payload 优先，缺失时
    /// run_id 列兜底——列已就绪（DM-01/DM-03），与 SQL by_run 过滤口径一致；
    /// 列不覆盖 payload 既有 runId（legacy 行诚实兼容，不回写）。
    #[test]
    fn parse_envelopes_column_backfills_typed_runid() {
        use orchestrator::persist::PersistedEvent;
        let events = vec![
            // 态 2a：payload 无 runId 键 + 列 Some → 列兜底填充 wire runId
            PersistedEvent {
                session_id: "s1".to_string(),
                sequence: 31,
                event_type: "agent-start".to_string(),
                payload: r#"{"type":"agent-start","sessionId":"s1","schemaVersion":1,"timestamp":"2026-01-01T00:00:00Z"}"#.to_string(),
                run_id: Some("r-c1".to_string()),
                created_at: "2026-01-01 00:00:00.031".to_string(),
            },
            // 态 2b：payload 有 runId + 列不同 → payload 优先（不覆盖）
            PersistedEvent {
                session_id: "s1".to_string(),
                sequence: 32,
                event_type: "agent-start".to_string(),
                payload: r#"{"type":"agent-start","sessionId":"s1","runId":"r-payload","schemaVersion":1,"timestamp":"2026-01-01T00:00:00Z"}"#.to_string(),
                run_id: Some("r-column".to_string()),
                created_at: "2026-01-01 00:00:00.032".to_string(),
            },
        ];
        let (parsed, stats) = parse_envelopes(&events);
        assert_eq!(parsed.len(), 2);
        assert_eq!(stats.typed, 2);
        assert_eq!(parsed[0].1["runId"], "r-c1", "payload 缺 runId → 列兜底");
        assert_eq!(
            parsed[1].1["runId"], "r-payload",
            "payload 有 runId → 列不覆盖"
        );
    }

    /// DM-07 P3 收口（态 3）：fallback 合成 runId 取值顺序 = payload runId
    /// 键 → run_id 列 → 镜像键推断（列优先于镜像键）。
    #[test]
    fn parse_envelopes_fallback_column_priority() {
        use orchestrator::persist::PersistedEvent;
        let events = vec![
            // 3a：payload 无 runId 键、列 Some、payload 有 subagentRunId → 列优先
            PersistedEvent {
                session_id: "s1".to_string(),
                sequence: 41,
                event_type: "recovery-escalated".to_string(),
                payload: r#"{"subagentRunId":"sr-1","kind":"ladder1","retries":2}"#.to_string(),
                run_id: Some("r-col".to_string()),
                created_at: "2026-01-01 00:00:00.041".to_string(),
            },
            // 3b：payload 有 runId 键 + 列不同 → payload 优先
            PersistedEvent {
                session_id: "s1".to_string(),
                sequence: 42,
                event_type: "run-interrupted".to_string(),
                payload: r#"{"runId":"r-p","run_id":"r-mirror","status":"failed"}"#.to_string(),
                run_id: Some("r-col".to_string()),
                created_at: "2026-01-01 00:00:00.042".to_string(),
            },
            // 3c：payload 无 runId、列 None → 镜像键推断兜底（既有行为保持）
            PersistedEvent {
                session_id: "s1".to_string(),
                sequence: 43,
                event_type: "recovery-escalated".to_string(),
                payload: r#"{"subagentRunId":"sr-2","kind":"ladder2","retries":1}"#.to_string(),
                run_id: None,
                created_at: "2026-01-01 00:00:00.043".to_string(),
            },
        ];
        let (parsed, stats) = parse_envelopes(&events);
        assert_eq!(parsed.len(), 3);
        assert_eq!(stats.synthesized, 3);
        assert_eq!(parsed[0].1["runId"], "r-col", "列优先于镜像键推断");
        assert_eq!(parsed[1].1["runId"], "r-p", "payload runId 键优先于列");
        assert_eq!(parsed[2].1["runId"], "sr-2", "无列无 payload → 镜像键兜底");
    }

    /// DM-06 读取面集成：直写镜像（run-interrupted / recovery-*，无 type
    /// 标签）真实落库（conex-db LocalDb 写面）后，读侧经
    /// query_events → parse_envelopes 可读回（wire 五键齐全）——「库里躺着
    /// 读不出」关闭（G-20/G-02 读侧部分）。
    #[test]
    fn mirror_rows_written_by_direct_path_are_readable() {
        let db = conex_db::LocalDb::open_in_memory().expect("内存库");
        db.insert_session("s1", "s1").expect("会话");
        // 直写面落库（对齐 restore_manager / recovery.rs 裸镜像形态：无 type 键；
        // run_id 列 None——存量/直写面列级归属未注入前读侧经镜像键推断）
        db.append_event(
            "s1",
            1,
            "run-interrupted",
            r#"{"run_id":"r-9","session_id":"s1","previous_status":"running","status":"failed","reason":"daemon-restarted"}"#,
            None,
        )
        .expect("run-interrupted 落库");
        db.append_event(
            "s1",
            2,
            "recovery-escalated",
            r#"{"subagentRunId":"sr-1","kind":"ladder1","retries":2,"elapsedMs":1500}"#,
            None,
        )
        .expect("recovery-escalated 落库");
        // typed 信封正常行对照（落库后读回也应正常）
        db.append_event(
            "s1",
            3,
            "agent-start",
            r#"{"type":"agent-start","sessionId":"s1","sequence":3,"schemaVersion":1,"runId":"r1","timestamp":"2026-01-01T00:00:00Z"}"#,
            Some("r1"),
        )
        .expect("typed 信封落库");

        let store = orchestrator::persist::LocalDbStore::new(db);
        // Store trait 方法调用需 trait 在作用域（trait 方法非固有方法）
        use orchestrator::persist::Store as _;
        let events = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(store.query_events("s1", 0, None))
            .expect("读回");
        assert_eq!(events.len(), 3, "三行全部可读");

        let (parsed, stats) = parse_envelopes(&events);
        assert_eq!(parsed.len(), 3, "读侧零静默丢弃");
        assert_eq!(stats.synthesized, 2, "两镜像行走 D8 合成");
        assert_eq!(stats.typed, 1);
        assert_eq!(stats.corrupt_skipped, 0);

        // run-interrupted 行可读且五键齐全
        let interrupted = &parsed[0].1;
        assert_eq!(interrupted["type"], "run-interrupted");
        assert_eq!(interrupted["runId"], "r-9");
        assert_eq!(interrupted["sequence"], 1);
        assert_eq!(interrupted["schemaVersion"], 1);
        assert_eq!(interrupted["sessionId"], "s1");
        // recovery-* 行可读且五键齐全
        let escalated = &parsed[1].1;
        assert_eq!(escalated["type"], "recovery-escalated");
        assert_eq!(escalated["runId"], "sr-1");
        assert_eq!(escalated["sequence"], 2);
        assert_eq!(escalated["schemaVersion"], 1);
        assert_eq!(escalated["sessionId"], "s1");
        // typed 行正常（sequence 列权威回填保持）
        assert_eq!(parsed[2].1["sequence"], 3);
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
        let value = conex_run::core_query::envelope_to_value(&envelope).expect("序列化");
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
        let usage = RunUsage::from_run_cache_stats(usage_stats(), None).expect("有样本必须映射");
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
        assert!(RunUsage::from_run_cache_stats(stats, None).is_none());
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
        let usage = RunUsage::from_run_cache_stats(stats, None).expect("有样本必须映射");
        assert_eq!(usage.cache_read_tokens, Some(0));
        assert_eq!(usage.hit_ratio, None, "input_total == 0 → 占比隐藏");
        assert_eq!(usage.write_ratio, None);
        assert_eq!(usage.warm_until_ms, None);
    }

    /// T5.6 宿主入账测（plans/05 §7.2）：live 单价 + 固定 usage →
    /// `RunUsage.cost.formatted_total` 等于引擎手算；改价再 settle 字符串变；
    /// 未定价 → cost None；四价 0 无阶梯 → 免费；CNY → ¥。
    #[test]
    fn run_usage_cost_equals_pricing_engine_and_three_states() {
        use agent_provider::models::catalog_types::{CurrencyKind, ModelPricingSpec};
        let stats = usage_stats();
        let pricing = ModelPricingSpec {
            currency: CurrencyKind::Usd,
            unit: PricingUnit::PerMillionTokens,
            input: Some(3.0),
            output: Some(9.0),
            cache_read: Some(0.1),
            cache_write: Some(0.0),
            per_image: None,
            tiers: vec![],
        };
        // prompt=1_000 / cache_read=800 → 输入段 200×3/1M=0.0006 + 输出 50×9/1M=0.00045
        // + cache_read 800×0.1/1M=0.00008 → 0.00113 → 引擎格式化 "$0.001130"
        let usage = RunUsage::from_run_cache_stats(stats, Some(&pricing)).expect("有定价必须出账");
        let engine_cost = agent_provider::pricing::PricingEngine::calculate_cost(
            &Some(pricing.clone()),
            stats.prompt_tokens,
            stats.completion_tokens,
            stats.cache_read_tokens,
            stats.cache_write_tokens,
        )
        .expect("引擎必须出账");
        assert_eq!(
            usage.cost.as_ref().map(|c| c.formatted_total.clone()),
            Some(engine_cost.formatted_total.clone()),
            "宿主账必须与引擎字符串字节一致"
        );

        // 改价（input 3.0 → 30.0）→ 字符串变，token 字段不变
        let mut priced2 = pricing.clone();
        priced2.input = Some(30.0);
        let usage2 = RunUsage::from_run_cache_stats(stats, Some(&priced2)).expect("改价后必须出账");
        assert_ne!(
            usage2.cost.as_ref().map(|c| c.formatted_total.clone()),
            usage.cost.as_ref().map(|c| c.formatted_total.clone()),
            "改 live 单价后 formatted_total 必须变"
        );
        assert_eq!(usage2.prompt_tokens, usage.prompt_tokens, "token 不变");

        // 未定价 → cost None（不是 0）
        let unpriced = RunUsage::from_run_cache_stats(stats, None).expect("有样本");
        assert!(unpriced.cost.is_none(), "无定价 → cost None");

        // 四价 0 无阶梯 → 免费（新契约：缺单价与显式免费不同——样本含
        // cache_read 用量，cache_read 必须显式 Some(0.0)，缺价+有用量 =
        // 未定价返回 None 而非 0）
        let free = ModelPricingSpec {
            currency: CurrencyKind::Usd,
            unit: PricingUnit::PerMillionTokens,
            input: Some(0.0),
            output: Some(0.0),
            cache_read: Some(0.0),
            cache_write: Some(0.0),
            per_image: None,
            tiers: vec![],
        };
        let free_usage = RunUsage::from_run_cache_stats(stats, Some(&free)).expect("有样本");
        let free_cost = free_usage.cost.expect("免费模型必须出账");
        assert!(free_cost.is_free);
        assert_eq!(free_cost.formatted_total, "免费");

        // CNY → ¥ 前缀（无硬编码 $）
        let cny = ModelPricingSpec {
            currency: CurrencyKind::Cny,
            unit: PricingUnit::PerMillionTokens,
            input: Some(3.0),
            output: Some(9.0),
            // 样本含 cache_read 用量：缺该维度单价 = 未定价（新契约），
            // 显式 0 才是「免费维度」
            cache_read: Some(0.0),
            cache_write: Some(0.0),
            per_image: None,
            tiers: vec![],
        };
        let cny_usage = RunUsage::from_run_cache_stats(stats, Some(&cny)).expect("有样本");
        assert!(
            cny_usage
                .cost
                .as_ref()
                .is_some_and(|c| c.formatted_total.starts_with('¥')),
            "CNY 账必须带 ¥ 前缀"
        );
    }
}
