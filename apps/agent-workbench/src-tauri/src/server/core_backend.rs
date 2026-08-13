//! CoreStateBackend：ApiBackend 的真实实现（R1-04：REST T1 写面直调
//! 既有 `*_impl` 契约体，不建第二套运行语义——D2 §11-B / AU2 审计点 3）
//!
//! - **写面**（run_task / run_control / cancel_run / approve / deny /
//!   list_pending_approvals / approval_history / settings_get /
//!   settings_set）：直调 core_run_commands 的直调体（不依赖 Tauri
//!   runtime），CoreError → [ServerError] 经单一真源映射
//!   （`DeviceErrorCode::from_core_error`，M6 §6.2.3）；
//! - **只读面**（R1-03 登记的 C01-C10）：同范式接入——能直调契约体的
//!   直调，数据源不可得的字段诚实降级（search_index_ready /
//!   compaction_ready 由装配方经 builder 注入，缺省 false）；
//! - 构造：`CoreStateBackend::new(Arc::clone(&core_state))`（main.rs
//!   装配面注入 [ServerState]，见 server/mod.rs router 装配）。

use std::sync::Arc;

use conex_types::device::{
    ApprovalHistoryParams, ApprovalHistoryResult, ApproveParams, ApproveResult, CancelRunParams,
    CancelRunResult, DenyParams, DeviceErrorCode, EventPageParams, EventPageResult,
    FileSearchHit, FlowSnapshotParams, FlowSnapshotResult, GetSettingsParams, GetSettingsResult,
    ListCommandsResult, ListPendingApprovalsParams, ListPendingApprovalsResult, ListSessionsParams,
    ListSessionsResult, ListTasksParams, ListTasksResult, PauseAutomationParams,
    PauseAutomationResult, PermissionMode, RunControlLevel, RunControlParams, RunControlResult,
    RunEventsParams, RunSnapshotParams, RunSnapshotResult, RunTaskParams, RunTaskResult,
    SearchFilesParams, SearchFilesResult, SearchIndexResult, SettingsConfirmAction,
    SettingsConfirmParams, SettingsConfirmResult, SettingsConfirmStatus,
};
use conex_types::events::{AgentEvent, AgentEventEnvelope, SecurityAuditDecision, SecurityAuditOperation};
use conex_types::impact::ImpactAssessment;

use conex_search::fuzzy::FuzzyMatcher;
use conex_search::search::{search_files, search_files_parallel};

use crate::core_event_bridge::EventBridge;

use crate::core_run_commands::{
    approval_history_impl, approve_tool_impl, cancel_run_impl, deny_tool_impl,
    find_run_by_pending_tool_call, generate_run_id, generate_session_id, get_flow_snapshot_impl,
    get_run_snapshot_impl, get_task_output_impl, list_active_runs_impl,
    list_background_tasks_impl, list_pending_approval_summaries_impl, list_pending_approvals_impl,
    list_sessions_impl, read_run_events_impl, read_session_events_impl, run_control_impl,
    run_task_impl, settings_get_impl, settings_update_impl, CoreRunState, RunTaskOptions,
};
use crate::core_commands::SharedSearchState;
use crate::server::backend::{ApiBackend, SettingsUpdateParams};
use crate::server::ServerError;

/// C21 远程面 query 上限（注册表契约 1-256；桌面命令面 core_search_files
/// 为 1024——两承载面各自口径，R2-07 总则「注册表为准」）
const SEARCH_QUERY_MAX_LEN_REMOTE: usize = 256;

/// C21 搜索并行阈值（对齐 core_commands::SEARCH_PARALLEL_THRESHOLD=1000——
/// 大索引走并行匹配，小索引走顺序匹配，同引擎口径）
const SEARCH_PARALLEL_THRESHOLD: usize = 1000;

/// 命令后端（R1-04 注入 ServerState；持有引擎核心状态与只读面就绪标记）
pub struct CoreStateBackend {
    /// 引擎核心运行状态（store / 引擎 / 活动 run 注册表）
    core: Arc<CoreRunState>,
    /// 搜索索引就绪（装配面注入 SharedSearchState 事实；缺省 false =
    /// 未接线诚实降级，与骨架期能力位口径一致）
    search_index_ready: bool,
    /// 压缩能力接线标记（同上）
    compaction_ready: bool,
    /// C21 搜索索引（与命令面 SharedSearchState 同一实例；None = 未接线，
    /// search_files 返回 cmd.engine_not_ready 诚实降级）
    search_state: Option<Arc<SharedSearchState>>,
    /// C21 搜索索引根（索引构建时的 canonical 工作区根；relPath 剥离
    /// 依据——与 search_state 配套注入）
    search_root: Option<String>,
}

impl CoreStateBackend {
    /// 新建后端（只读面就绪标记缺省 false；装配方可经 builder 注入）
    // R1-04 备注：main.rs 装配面注入消费（R1-04 主任务）——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn new(core: Arc<CoreRunState>) -> Self {
        Self {
            core,
            search_index_ready: false,
            compaction_ready: false,
            search_state: None,
            search_root: None,
        }
    }

    /// 注入搜索索引就绪事实（SharedSearchState 文件数 > 0 推断）
    // R1-04 备注：装配面消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_search_index_ready(mut self, ready: bool) -> Self {
        self.search_index_ready = ready;
        self
    }

    /// 注入压缩能力接线标记（SharedCompactionState）
    // R1-04 备注：装配面消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_compaction_ready(mut self, ready: bool) -> Self {
        self.compaction_ready = ready;
        self
    }

    /// 注入 C21 搜索索引（R2-12c：main.rs 装配面将命令面同实例
    /// SharedSearchState 注入——与 search_index_ready 同源事实；
    /// 未注入时 search_files 返回 cmd.engine_not_ready 诚实降级）
    // R2-12c 备注：main.rs 装配面消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_search_state(mut self, state: Arc<SharedSearchState>) -> Self {
        self.search_state = Some(state);
        self
    }

    /// 注入 C21 搜索索引根（R2-12c：索引构建时的 canonical 工作区根；
    /// relPath 剥离依据——与 with_search_state 配套注入）
    // R2-12c 备注：main.rs 装配面消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_search_root(mut self, root: impl Into<String>) -> Self {
        self.search_root = Some(root.into());
        self
    }

    /// 全局事件桥（R1-11：remote-* 审计事件发射通道；main.rs 装配面经此
    /// 挂接 ServerState.audit_bridge——router 白名单拒绝分支（remote-source-
    /// attempt）与 run 装配面（remote-mode-downgrade）共用同一桥实例）
    // R1-11 备注：main.rs 装配消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn event_bridge(&self) -> EventBridge {
        self.core.event_bridge()
    }

    /// CoreError → ServerError（单一真源映射，M6 §6.2.3）
    fn map_core(error: conex_types::CoreError) -> ServerError {
        ServerError::from_core_error(&error)
    }

    /// 索引绝对路径 → 注册表 relPath：剥离搜索根前缀（若已注入），
    /// 统一 `/` 分隔符（跨端契约；未注入根时回传索引原路径——装配面
    /// 应与 with_search_state 配套注入 with_search_root）
    fn rel_path_for(&self, path: &str) -> String {
        let normalized = path.replace('\\', "/");
        if let Some(root) = &self.search_root {
            let root_norm = root.replace('\\', "/").trim_end_matches('/');
            if let Some(stripped) = normalized.strip_prefix(root_norm) {
                // 目录边界锚定：剥离后须为空或以 `/` 开头——防
                // "C:/proj" 误剥 "C:/projects/x.rs"（字符串前缀 ≠ 目录前缀）
                if stripped.is_empty() || stripped.starts_with('/') {
                    return stripped.trim_start_matches('/').to_string();
                }
            }
        }
        normalized
    }
}

/// 路径是否绝对路径（Unix `/` / Windows `\` 开头或盘符 `C:\` / `C:/`；
/// F4 §7.2：手机端只传相对路径，绝对路径请求按 cmd.invalid 拒绝）
fn is_absolute_path(path: &str) -> bool {
    if path.starts_with('/') || path.starts_with('\\') {
        return true;
    }
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// C21 root 组件序列匹配（索引路径为绝对路径、root 为相对路径——按
/// 完整组件序列匹配，目录边界锚定防前缀误匹配；搜索索引仅覆盖工作区，
/// 无跨根误报）
fn hit_path_within_root(hit_path: &str, root: &str) -> bool {
    let root_norm = root.replace('\\', "/").trim_matches('/');
    if root_norm.is_empty() {
        return true;
    }
    let hit_norm = hit_path.replace('\\', "/");
    hit_norm.starts_with(&format!("{root_norm}/"))
        || hit_norm.contains(&format!("/{root_norm}/"))
        || hit_norm.ends_with(&format!("/{root_norm}"))
}

// ── R1-10 安全测试面：远程装配与双轨路由纯函数（T-07 / T-08 / T-14）──
//
// 远程来源判定机制（R1-10 确认）：REST/WS 服务面即远程面——桌面本地操作
// 走 Tauri IPC，入站网络请求一律视为远程来源（D2 §8 / D5 §4.3「远程网关
// 不暴露 Tauri IPC」）；deviceId 身份注入（source=deviceId）留 §8.2
// 装配层扩展，本面先落地远程/本地的行为边界。

/// 远程权限模式上限装配（R1-10 T-08 / D5 §4.6.1）：min(requested, Ask)——
/// 远程不存在 full-access（TH-12 直接缓解）；ask / plan 原样；None 原样。
/// 返回（生效模式, 是否降级）——降级时调用方必须发 remote-mode-downgrade
/// 审计标记（D5 §8.2 / §9.2 矩阵：approve/operate × full-access → ask 降级）。
pub(crate) fn apply_remote_mode(requested: Option<PermissionMode>) -> (Option<PermissionMode>, bool) {
    match requested {
        Some(PermissionMode::FullAccess) => (Some(PermissionMode::Ask), true),
        other => (other, false),
    }
}

/// remote-mode-downgrade 审计标记常量（D5 §8.2：降级动作发该审计；
/// R1-10 结构化日志先行，R1-11 D-5 收口后经
/// [emit_remote_mode_downgrade_audit] 双写升级为 AgentEvent::SecurityAudit
/// 事件发射——标记载荷形状不变，测试锁定）
pub(crate) const REMOTE_MODE_DOWNGRADE_AUDIT_MARKER: &str = "remote-mode-downgrade";

/// remote-* 审计事件构造（R1-11 D-5 收口：D5 §6.2 载荷形状——operation +
/// targets + decision + permission_mode；信封 runId/sequence 不注入，
/// 对齐 emit_trash_audit 先例（core_run_commands.rs）——run 创建前 /
/// 无会话上下文的远程动作，前端对缺失 runId 的信封放行不过滤）
fn remote_audit_event(
    session_id: &str,
    operation: SecurityAuditOperation,
    targets: Vec<String>,
    decision: SecurityAuditDecision,
    permission_mode: Option<String>,
) -> AgentEvent {
    AgentEvent::SecurityAudit {
        session_id: session_id.to_string(),
        timestamp: crate::engine::now_iso_utc(),
        operation,
        targets,
        impact: ImpactAssessment::default(),
        decision,
        permission_mode,
        tool_call_id: None,
    }
}

/// 发射 remote-* 审计（双写：结构化审计日志 + SecurityAudit 事件——红线
/// 7「全部远程动作 remote-* 审计打码」的端到端事件面；bridge 为 None
/// （事件总线未接线）时降级为纯结构化日志，与 R1-10 行为一致）
fn emit_remote_audit(
    bridge: Option<&EventBridge>,
    session_id: &str,
    operation: SecurityAuditOperation,
    targets: Vec<String>,
    decision: SecurityAuditDecision,
    permission_mode: Option<String>,
) {
    tracing::info!(
        target: "security.audit",
        kind = "remote-action",
        operation = ?operation,
        decision = ?decision,
        targets = ?targets,
        session_id,
        "远程动作审计（结构化日志 + SecurityAudit 事件双写）"
    );
    let Some(bridge) = bridge else {
        return;
    };
    let envelope = AgentEventEnvelope::new(
        remote_audit_event(session_id, operation, targets, decision, permission_mode),
        None,
        None,
    );
    bridge.emit_envelope(&envelope);
}

/// 远程 run 权限模式降级审计发射（R1-10 T-08 → R1-11 事件级：full-access
/// → ask 降级动作；双写：结构化日志 + SecurityAudit(remote-mode-downgrade)，
/// targets 承载 runId（run 创建前为空串）、permission_mode 记录降级前
/// 申请值 full-access——D5 §6.2 载荷形状 / §6.2「permission_mode 如实
/// 记录（记录降级前申请值）」；decision 取 blocked 语义：降级动作已记录）
pub(crate) fn emit_remote_mode_downgrade_audit(
    bridge: Option<&EventBridge>,
    run_id: &str,
    session_id: &str,
) {
    emit_remote_audit(
        bridge,
        session_id,
        SecurityAuditOperation::RemoteModeDowngrade,
        vec![run_id.to_string()],
        SecurityAuditDecision::Blocked,
        Some("full-access".to_string()),
    );
}

/// 远程审批双轨路由（R1-10 T-14 / D5 §4.4 纯函数）：
/// - 桌面端本地用户在场 → 双轨确认（[RemoteApprovalRoute::Dual]）：移动端
///   确认 + 桌面端弹窗确认，任一方拒绝即拒绝（防手机离身/被他人持有时
///   桌面端无人察觉地批准）；
/// - 桌面不在场（无人值守）→ 移动端单一确认（[RemoteApprovalRoute::RemoteOnly]），
///   审计标记 remote-only（事后追责可区分单方批准与双轨批准）。
/// 「桌面在场」判定由引擎侧装配注入，缺省 false = 保守模式（D5 §4.4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemoteApprovalRoute {
    /// 双轨确认：移动端 + 桌面端弹窗（任一方拒绝即拒绝）
    Dual,
    /// 移动端单一确认（无人值守；审计标记 remote-only）
    RemoteOnly,
}

/// remote-only 审计标记（D5 §4.4：区分「手机端单方批准」与「双轨批准」）
pub(crate) const REMOTE_ONLY_AUDIT_MARKER: &str = "remote-only";

/// 双轨裁决路由纯函数（R1-10 T-14：desktop_user_present 由装配面注入，
/// 缺省 false = 无人值守按 remote-only 处理）
pub(crate) fn route_remote_approval(desktop_user_present: bool) -> RemoteApprovalRoute {
    if desktop_user_present {
        RemoteApprovalRoute::Dual
    } else {
        RemoteApprovalRoute::RemoteOnly
    }
}

/// 双轨裁决合成（R1-10 T-14：任一方拒绝即拒绝——仅双方均批准才放行）
pub(crate) fn combine_dual_decisions(mobile_approved: bool, desktop_approved: bool) -> bool {
    mobile_approved && desktop_approved
}

/// remote-source-attempt 审计标记载荷（R1-10 T-07 / D5 §4.5 第三层：
/// 密钥命令面触达；规范载荷 = operation + 命令名 + blocked 决策——测试
/// 锁定标记形状，发射侧（router 白名单拒绝分支）携带同一内容）
pub(crate) fn remote_source_attempt_marker(command: &str) -> String {
    format!(
        "operation=remote-source-attempt;command={command};decision=blocked"
    )
}

/// 发射 remote-source-attempt 审计（R1-10 T-07 → R1-11 事件级：远程来源
/// 触达被禁命令面；双写：结构化日志 + SecurityAudit(remote-source-attempt)，
/// targets 承载命令名、decision 恒 blocked——D5 §6.2 载荷形状；命令串
/// 中的敏感形态（令牌 / 配对码 / provider key）经
/// [conex_telemetry::redact::redact_text] 打码后再入事件与日志——红线 7
/// 「remote-* 审计打码」断言锚（T-06 零明文口径同源））
pub(crate) fn emit_remote_source_attempt_audit(bridge: Option<&EventBridge>, command: &str) {
    let redacted = conex_telemetry::redact::redact_text(command);
    emit_remote_audit(
        bridge,
        "",
        SecurityAuditOperation::RemoteSourceAttempt,
        vec![redacted.clone()],
        SecurityAuditDecision::Blocked,
        None,
    );
    tracing::info!(
        target: "security.audit",
        kind = "remote-command",
        operation = "remote-source-attempt",
        command = %redacted,
        decision = "blocked",
        "远程来源触达被禁命令面（白名单拒绝 + 审计标记，敏感形态已打码）"
    );
}

/// 发射 remote-only 审计（D5 §4.4：桌面不在场时移动端单方批准——审计
/// 标记使事后追责可区分单方批准与双轨批准；双写：结构化日志 +
/// SecurityAudit(remote-only)，decision 取 approved 语义：单方批准已
/// 放行。装配点 = R2 远程网关双轨裁决落地面（当前无生产调用，测试直
/// 接覆盖事件形状））
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn emit_remote_only_audit(bridge: Option<&EventBridge>, session_id: &str) {
    emit_remote_audit(
        bridge,
        session_id,
        SecurityAuditOperation::RemoteOnly,
        vec![],
        SecurityAuditDecision::Approved,
        None,
    );
    tracing::info!(
        target: "security.audit",
        kind = "remote-approval",
        operation = %REMOTE_ONLY_AUDIT_MARKER,
        session_id,
        "远程单一确认（无人值守 remote-only 审计标记）"
    );
}

#[async_trait::async_trait]
impl ApiBackend for CoreStateBackend {
    // ── F1 监控域只读面（R1-03 登记；R1-04 直调接入）──

    /// C01 状态查询：build_status 纯函数组装（M6 C01 裁剪口径——
    /// logDir 不下发；diagnostics / lastError 与 GUI 共享同一
    /// StatusDiagnostics 实例）
    async fn get_status(&self) -> Result<serde_json::Value, ServerError> {
        use crate::core_query_commands::{
            build_status, DiagnosticEntry, LastErrorEntry, ProviderStatus,
        };
        let diagnostics = self.core.status_diagnostics();
        // providerStatus 三态如实（config 全局 store 直读）
        let api_key = crate::config::effective_api_key();
        let provider_status = ProviderStatus {
            has_api_key: Some(api_key.as_deref().is_some_and(|k| !k.is_empty())),
            model: crate::config::effective_model(),
            base_url: crate::config::effective_api_base_url(),
            credential_mode: Some(crate::config::effective_credential_mode()),
        };
        // 日志目录与 core_get_status 同源（app_dir()/logs）
        let log_dir = crate::host_paths::app_dir()
            .map(|dir| dir.join("logs").to_string_lossy().to_string())
            .unwrap_or_default();
        let status = build_status(
            self.core.initialized(),
            env!("CARGO_PKG_VERSION").to_string(),
            self.core.engine_ready(),
            self.search_index_ready,
            self.core.local_db().is_some(),
            self.compaction_ready,
            provider_status,
            conex_telemetry::current_level(),
            log_dir,
            diagnostics
                .entries()
                .into_iter()
                .map(|entry| DiagnosticEntry {
                    ts: entry.updated_at,
                    level: entry.subsystem,
                    message: entry.message.unwrap_or_default(),
                })
                .collect(),
            diagnostics.last_error().map(|payload| LastErrorEntry {
                kind: payload.code,
                detail: payload.message,
                ts: payload.timestamp,
            }),
            self.core.restore_status(),
            self.core.snapshot_status(),
            self.core.background_tasks_summary().await,
            // P-7（R2-07 D-02 收尾）：activeRuns / pendingApprovals 摘要
            // 注入——活动 run 注册表 + 审批门 pending 集合（复用 C13
            // 对账公共方法，M6 §4.1.1 摘要形状）
            list_active_runs_impl(&self.core).await,
            list_pending_approval_summaries_impl(&self.core),
        );
        serde_json::to_value(status)
            .map_err(|e| ServerError::internal(format!("状态序列化失败：{e}")))
    }

    /// C02 run 快照（usage 无样本置 null 的裁剪由 run_usage 缓存口径保证）
    async fn get_run_snapshot(
        &self,
        params: RunSnapshotParams,
    ) -> Result<RunSnapshotResult, ServerError> {
        let response =
            get_run_snapshot_impl(&self.core, &params.run_id, params.session_id.as_deref())
                .await
                .map_err(Self::map_core)?;
        let snapshot = serde_json::to_value(response.snapshot)
            .map_err(|e| ServerError::internal(format!("run 快照序列化失败：{e}")))?;
        Ok(RunSnapshotResult { snapshot })
    }

    /// C03 会话事件分页（EventPage 契约；游标语义与 WS 续传重放同源）
    async fn read_session_events(
        &self,
        params: EventPageParams,
    ) -> Result<EventPageResult, ServerError> {
        let page = read_session_events_impl(
            &self.core,
            &params.session_id,
            params.after_sequence,
            params.max_events.map(u64::from),
        )
        .await
        .map_err(Self::map_core)?;
        // latestSequence = 服务端该会话当前 max（游标推进判断；M6 C03）
        let store = self.core.store();
        let latest_sequence = store
            .query_events(&params.session_id, 0)
            .await
            .ok()
            .and_then(|all| all.last().map(|event| event.sequence));
        Ok(EventPageResult {
            events: page.events,
            next_after_sequence: page.next_after_sequence,
            has_more: page.has_more,
            latest_sequence,
        })
    }

    /// C04 run 事件分页（按信封 runId 过滤的会话事件子集）
    async fn read_run_events(
        &self,
        params: RunEventsParams,
    ) -> Result<EventPageResult, ServerError> {
        let page = read_run_events_impl(
            &self.core,
            &params.run_id,
            params.session_id.as_deref(),
            params.after_sequence,
            params.max_events.map(u64::from),
        )
        .await
        .map_err(Self::map_core)?;
        Ok(EventPageResult {
            events: page.events,
            next_after_sequence: page.next_after_sequence,
            has_more: page.has_more,
            latest_sequence: None,
        })
    }

    /// C05 会话列表（includeLastMessage 预览属 F5 增量面，缺省语义）
    async fn list_sessions(
        &self,
        _params: ListSessionsParams,
    ) -> Result<ListSessionsResult, ServerError> {
        let sessions = list_sessions_impl(&self.core).map_err(Self::map_core)?;
        Ok(ListSessionsResult { sessions })
    }

    /// C06 后台任务列表（摘要；不携带输出内容，M6 §4.1.6）
    async fn list_background_tasks(
        &self,
        _params: ListTasksParams,
    ) -> Result<ListTasksResult, ServerError> {
        let tasks = list_background_tasks_impl(&self.core)
            .await
            .map_err(Self::map_core)?;
        Ok(ListTasksResult { tasks })
    }

    /// C07 任务输出补取（afterLine 偏移分页）
    async fn get_task_output(
        &self,
        params: conex_types::device::commands::TaskOutputParams,
    ) -> Result<conex_types::device::commands::TaskOutputResult, ServerError> {
        get_task_output_impl(
            &self.core,
            &params.task_id,
            params.max_lines,
            params.after_line,
        )
        .await
        .map_err(Self::map_core)
    }

    /// C08 子代理 DAG 概览（行投影，完整消息树不下发，D6 §3.3 N8）
    async fn get_flow_snapshot(
        &self,
        params: FlowSnapshotParams,
    ) -> Result<FlowSnapshotResult, ServerError> {
        let flow =
            get_flow_snapshot_impl(&self.core, &params.session_id).map_err(Self::map_core)?;
        Ok(FlowSnapshotResult { flow })
    }

    /// C09 命令清单（manifest 原样透传——移动端动态发现能力面）
    async fn list_commands(&self) -> Result<ListCommandsResult, ServerError> {
        let manifest = crate::command_manifest::core_list_commands().map_err(Self::map_core)?;
        let commands = manifest
            .commands
            .iter()
            .map(|entry| {
                let surface = match entry.surface {
                    "engine" => conex_types::device::CommandSurface::Engine,
                    "gui" => conex_types::device::CommandSurface::Gui,
                    other => {
                        return Err(ServerError::internal(format!(
                            "manifest 含未知 surface：{other}"
                        )))
                    }
                };
                Ok(conex_types::device::ManifestEntry {
                    name: entry.name.to_string(),
                    family: entry.family.to_string(),
                    surface,
                    registered: entry.registered,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ListCommandsResult {
            contract_version: manifest.contract_version.to_string(),
            commands,
        })
    }

    /// C10 搜索索引就绪状态（ready/state 子集；全文搜索不暴露，
    /// M6 §4.1.10；就绪事实由装配面注入）
    async fn get_search_index(&self) -> Result<SearchIndexResult, ServerError> {
        Ok(SearchIndexResult {
            ready: self.search_index_ready,
            state: None,
        })
    }

    // ── F5 会话域 / F2 审批域 / F6 设置域写面（R1-04 真实直调）──

    /// C24 发起 run（runId 桌面生成；sessionId 缺省 = 新建会话并落索引，
    /// M6 C24；clientMessageId 幂等由 run_task_impl 既有语义保证）
    async fn run_task(&self, params: RunTaskParams) -> Result<RunTaskResult, ServerError> {
        let prompt = params.prompt.trim();
        if prompt.is_empty() {
            return Err(ServerError::protocol(
                conex_types::device::DeviceErrorCode::CmdInvalid,
                "prompt 不能为空",
            ));
        }
        if params.prompt.len() > 262_144 {
            return Err(ServerError::protocol(
                conex_types::device::DeviceErrorCode::CmdInvalid,
                "prompt 超过 256 KiB 上限（超限走流上传 promptRef，M6 §8.1）",
            ));
        }
        // 会话归属：显式 sessionId → 沿用；缺省 → 新建会话（标题 = prompt
        // 前缀，对齐桌面 commitDraftIfNeeded 语义）
        let session_id = match params.session_id.as_deref() {
            Some(id) if !id.trim().is_empty() => id.trim().to_string(),
            _ => {
                let id = generate_session_id();
                if let Some(db) = self.core.local_db() {
                    let title = prompt.chars().take(30).collect::<String>();
                    let title = if title.is_empty() {
                        "新会话".to_string()
                    } else {
                        title
                    };
                    db.insert_session(&id, &title)
                        .map_err(|e| ServerError::io(format!("新建会话落库失败：{e}")))?;
                }
                id
            }
        };
        // R1-10 T-08：远程 run 权限模式装配——full-access 恒降级 ask
        // （远程不存在 full-access，D5 §4.6.1 / TH-12 直接缓解）；降级发
        // remote-mode-downgrade 审计标记。history 为既有 HistoryMessage
        // 镜像（移动端一般省略，桌面 SessionHistoryCache 兜底）
        let (mode_clamped, mode_downgraded) = apply_remote_mode(params.permission_mode);
        let permission_mode = mode_clamped.map(|mode| match mode {
            PermissionMode::Ask => "ask".to_string(),
            PermissionMode::Plan => "plan".to_string(),
            PermissionMode::FullAccess => "full-access".to_string(),
        });
        if mode_downgraded {
            emit_remote_mode_downgrade_audit(Some(&self.core.event_bridge()), "", &session_id);
        }
        let history = params
            .history
            .map(|values| {
                values
                    .into_iter()
                    .filter_map(|value| {
                        serde_json::from_value::<conex_types::HistoryMessage>(value).ok()
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|list| !list.is_empty());
        let options = RunTaskOptions {
            run_id: generate_run_id(),
            session_id,
            prompt: Some(params.prompt),
            mode: params.mode,
            cwd: params.cwd,
            permission_mode,
            client_message_id: params.client_message_id,
            assistant_client_message_id: None,
            system_prompt: None,
            history,
            context_window: None,
            parent_run_id: None,
            subagent_config: None,
            // D5 §3.1：goal 三字段（远程 run 命令缺省 None，与旧命令面一致）
            visible_goal: None,
            max_rounds: None,
            max_stalled_rounds: None,
        };
        let response = run_task_impl(Arc::clone(&self.core), options)
            .await
            .map_err(Self::map_core)?;
        Ok(RunTaskResult {
            run_id: response.run_id,
            session_id: response.session_id,
        })
    }

    /// C25 run 控制（L0 继续 / L1 软注入 / L2 协作停止 / L3 强制取消；
    /// 路径 runId 优先——body 携带的 runId 以路径值为准）
    async fn run_control(&self, params: RunControlParams) -> Result<RunControlResult, ServerError> {
        let level = match params.level {
            RunControlLevel::Continue => "continue",
            RunControlLevel::SoftInject => "soft_inject",
            RunControlLevel::CooperativeStop => "cooperative_stop",
            RunControlLevel::ForceCancel => "force_cancel",
        };
        run_control_impl(
            &self.core,
            &params.run_id,
            level,
            None,
            params.reason,
            params.payload,
        )
        .await
        .map_err(Self::map_core)?;
        Ok(RunControlResult { ok: true })
    }

    /// C26 取消 run（重复取消无副作用——终态拒绝幂等，M6 C26）
    async fn cancel_run(&self, params: CancelRunParams) -> Result<CancelRunResult, ServerError> {
        let response = cancel_run_impl(&self.core, &params.run_id, None, params.reason.as_deref())
            .await
            .map_err(Self::map_core)?;
        Ok(CancelRunResult {
            ok: response.ok,
            run_id: response.run_id,
        })
    }

    /// C11 审批批准（I-02 pending 校验；toolCallId 为真键，runId 缺失
    /// 按待审批集合反查；重复决策 → 命中 resolve 的 NotFound → 映射
    /// cmd.approval_mismatch 409，不改状态机）
    async fn approve(&self, params: ApproveParams) -> Result<ApproveResult, ServerError> {
        let run_id = resolve_approval_run_id(&self.core, &params)?;
        let response = approve_tool_impl(&self.core, &run_id, &params.tool_call_id, None)
            .await
            .map_err(Self::map_core)?;
        Ok(ApproveResult {
            ok: response.ok,
            tool_call_id: response.tool_call_id,
            decision: conex_types::events::ApprovalDecision::Approved,
        })
    }

    /// C12 审批拒绝（语义与 approve 同；reason ≤256 字符，缺省
    /// "user denied"）
    async fn deny(&self, params: DenyParams) -> Result<ApproveResult, ServerError> {
        let run_id = resolve_deny_run_id(&self.core, &params)?;
        let response = deny_tool_impl(
            &self.core,
            &run_id,
            &params.tool_call_id,
            params.reason.as_deref(),
        )
        .await
        .map_err(Self::map_core)?;
        Ok(ApproveResult {
            ok: response.ok,
            tool_call_id: response.tool_call_id,
            decision: conex_types::events::ApprovalDecision::Denied,
        })
    }

    /// C13 待审批对账（活动 run 审批门待审批集合快照；after_sequence
    /// 增量水位为 wire 层扩展——R1-04 实现为全量对账）
    async fn list_pending_approvals(
        &self,
        _params: ListPendingApprovalsParams,
    ) -> Result<ListPendingApprovalsResult, ServerError> {
        let approvals = list_pending_approvals_impl(&self.core);
        Ok(ListPendingApprovalsResult {
            approvals,
            latest_sequence: None,
        })
    }

    /// C14 审批历史（approval-resolved 事件白名单投影，按水位补拉）
    async fn approval_history(
        &self,
        params: ApprovalHistoryParams,
    ) -> Result<ApprovalHistoryResult, ServerError> {
        approval_history_impl(
            &self.core,
            params.session_id.as_deref(),
            params.after_sequence,
            params.limit,
        )
        .await
        .map_err(Self::map_core)
    }

    /// C28 设置脱敏快照（config_get 直透；keys 白名单子集过滤——
    /// 请求键不在快照字段内则忽略，M6 C28）
    async fn settings_get(
        &self,
        params: GetSettingsParams,
    ) -> Result<GetSettingsResult, ServerError> {
        let settings = settings_get_impl().map_err(Self::map_core)?;
        let settings = match params.keys {
            Some(keys) if !keys.is_empty() => {
                let mut filtered = serde_json::Map::new();
                if let Some(object) = settings.as_object() {
                    for key in keys {
                        if let Some(value) = object.get(&key) {
                            filtered.insert(key, value.clone());
                        }
                    }
                }
                serde_json::Value::Object(filtered)
            }
            _ => settings,
        };
        Ok(GetSettingsResult { settings })
    }

    /// C29 非敏感配置更新（直调 settings_update_impl；credentialMode /
    /// endpoint / stream 显式拒绝 cmd.invalid）
    async fn settings_set(
        &self,
        params: SettingsUpdateParams,
    ) -> Result<GetSettingsResult, ServerError> {
        let settings = settings_update_impl(
            &self.core,
            params.base_url,
            params.model,
            params.credential_mode,
            params.endpoint,
            params.stream,
        )
        .map_err(Self::map_core)?;
        Ok(GetSettingsResult { settings })
    }

    /// C21 递归文件名搜索（对齐注册表 SearchFilesParams/Result；复用
    /// 引擎 core_search_files 的搜索逻辑——同一搜索索引
    /// （SharedSearchState）+ conex-search 模糊匹配 + 并行阈值，远程
    /// 面差异：query 1-256（注册表契约）、maxResults 缺省 100 钳制
    /// 100（注册表钳制）、root 相对路径按组件边界过滤、relPath 相对
    /// 搜索根输出）
    async fn search_files(
        &self,
        params: SearchFilesParams,
    ) -> Result<SearchFilesResult, ServerError> {
        let query = params.query.trim().to_string();
        if query.is_empty() {
            return Err(ServerError::protocol(
                DeviceErrorCode::CmdInvalid,
                "query 不能为空（注册表 1-256）",
            ));
        }
        if query.chars().count() > SEARCH_QUERY_MAX_LEN_REMOTE {
            return Err(ServerError::protocol(
                DeviceErrorCode::CmdInvalid,
                format!(
                    "query 超过 {SEARCH_QUERY_MAX_LEN_REMOTE} 字符上限（注册表契约）"
                ),
            ));
        }
        let root = params
            .root
            .map(|root| root.trim().to_string())
            .filter(|root| !root.is_empty());
        if let Some(root) = &root {
            if is_absolute_path(root) {
                return Err(ServerError::protocol(
                    DeviceErrorCode::CmdInvalid,
                    "root 必须为相对路径（F4 §7.2：手机端不传绝对路径）",
                ));
            }
        }
        let state = self.search_state.as_ref().ok_or_else(|| {
            ServerError::protocol(
                DeviceErrorCode::CmdEngineNotReady,
                "搜索索引未接线（装配面注入 SharedSearchState 后可用）",
            )
        })?;
        let files = state
            .files
            .read()
            .map_err(|e| ServerError::internal(format!("search index lock: {e}")))?
            .clone();
        let limit = params.max_results.unwrap_or(100).clamp(1, 100) as usize;
        let hits = tokio::task::spawn_blocking(move || {
            let matcher = FuzzyMatcher::new(false);
            let mut hits = if files.len() >= SEARCH_PARALLEL_THRESHOLD {
                search_files_parallel(&query, &files, limit, &matcher)
            } else {
                search_files(&query, &files, limit, &matcher)
            };
            if let Some(root) = &root {
                hits.retain(|hit| hit_path_within_root(&hit.path, root));
            }
            hits
        })
        .await
        .map_err(|e| ServerError::internal(format!("search task failed: {e}")))?;
        let results = hits
            .into_iter()
            .map(|hit| FileSearchHit {
                rel_path: self.rel_path_for(&hit.path),
                // 搜索索引只存路径（无 kind/size 元数据）——注册表
                // optional 字段缺省合法（少发送可选字段即合法）
                kind: None,
                size: None,
            })
            .collect();
        Ok(SearchFilesResult { results })
    }

    /// C30 桌面确认请求回执（R1-04 直调面无确认通道——D-13：settings
    /// 直接生效、无 pending/confirmRequestId 下发；F6 §8.3 桌面确认
    /// 通道待 M6 §12.4 接线。本面实现为**确认回执**：query 任意 id →
    /// expired（桌面端无待确认请求记录）；withdraw → withdrawn（撤回
    /// 已不存在 = 幂等成功，R2-11 §11「撤回已撤回 = 成功，天然」））
    async fn settings_confirm(
        &self,
        params: SettingsConfirmParams,
    ) -> Result<SettingsConfirmResult, ServerError> {
        if params.confirm_request_id.trim().is_empty() {
            return Err(ServerError::protocol(
                DeviceErrorCode::CmdInvalid,
                "confirmRequestId 不能为空",
            ));
        }
        Ok(match params.action {
            SettingsConfirmAction::Withdraw => SettingsConfirmResult {
                status: SettingsConfirmStatus::Withdrawn,
                reason: Some(
                    "桌面端无待确认请求记录；撤回幂等成功（R1-04 直调面直接生效，F6 §8.3 确认通道待接线）"
                        .to_string(),
                ),
            },
            SettingsConfirmAction::Query => SettingsConfirmResult {
                status: SettingsConfirmStatus::Expired,
                reason: Some(
                    "桌面端无待确认请求记录（R1-04 直调面直接生效；F6 §8.3 桌面确认通道待 M6 §12.4 接线）"
                        .to_string(),
                ),
            },
        })
    }

    /// C31 暂停定时自动执行（自动化 = 定时任务 SchedulerRegistry；F6
    /// §8.2「受限触发」一次性指令——不改变持久化配置，暂停为内存态
    /// 重启不恢复；durationSec 缺省 3600、钳制 [60, 86400]（注册表
    /// 契约，桌面端钳制）；重复暂停刷新 pausedUntil）
    async fn pause_automation(
        &self,
        params: PauseAutomationParams,
    ) -> Result<PauseAutomationResult, ServerError> {
        let duration_sec = params.duration_sec.unwrap_or(3600).clamp(60, 86400);
        let registry = self.core.scheduler_registry().ok_or_else(|| {
            ServerError::protocol(
                DeviceErrorCode::CmdEngineNotReady,
                "调度器未装配（Cron 注册表未接线）",
            )
        })?;
        let paused_until = registry.pause_for(duration_sec);
        Ok(PauseAutomationResult {
            ok: true,
            paused_until,
        })
    }
}

/// 审批 run 归属解析（M6 C11：runId 提供 → 沿用；缺失 → 按待审批
/// 集合反查；两者皆无 → cmd.approval_mismatch 409——与 resolve 冲突
/// 语义一致，避免伪造审批请求落入 404 的歧义）
fn resolve_approval_run_id(
    core: &CoreRunState,
    params: &ApproveParams,
) -> Result<String, ServerError> {
    match params.run_id.as_deref() {
        Some(run_id) if !run_id.trim().is_empty() => Ok(run_id.trim().to_string()),
        _ => find_run_by_pending_tool_call(core, &params.tool_call_id).ok_or_else(|| {
            ServerError::protocol(
                conex_types::device::DeviceErrorCode::CmdApprovalMismatch,
                format!("tool_call_id 不在待审批集合：{}", params.tool_call_id),
            )
        }),
    }
}

/// deny 的 run 归属解析（与 [resolve_approval_run_id] 同语义）
fn resolve_deny_run_id(core: &CoreRunState, params: &DenyParams) -> Result<String, ServerError> {
    match params.run_id.as_deref() {
        Some(run_id) if !run_id.trim().is_empty() => Ok(run_id.trim().to_string()),
        _ => find_run_by_pending_tool_call(core, &params.tool_call_id).ok_or_else(|| {
            ServerError::protocol(
                conex_types::device::DeviceErrorCode::CmdApprovalMismatch,
                format!("tool_call_id 不在待审批集合：{}", params.tool_call_id),
            )
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── R1-10 T-08：远程权限模式上限（D5 §4.6.1 / §9.2 矩阵）──

    /// full-access 申报 → 恒降级 ask（min(requested, Ask) 截断）并返回
    /// 降级标记（驱动 remote-mode-downgrade 审计）；ask / plan / None 原样
    #[test]
    fn t08_apply_remote_mode_clamps_full_access_to_ask() {
        assert_eq!(
            apply_remote_mode(Some(PermissionMode::FullAccess)),
            (Some(PermissionMode::Ask), true),
            "full-access 必须降级 ask + 降级标记"
        );
        assert_eq!(
            apply_remote_mode(Some(PermissionMode::Ask)),
            (Some(PermissionMode::Ask), false)
        );
        assert_eq!(
            apply_remote_mode(Some(PermissionMode::Plan)),
            (Some(PermissionMode::Plan), false),
            "plan 不降级（D5 §4.6.1：Plan 不变）"
        );
        assert_eq!(apply_remote_mode(None), (None, false));
    }

    /// 降级审计标记常量形状（remote-mode-downgrade；§8.2 命名冻结）
    #[test]
    fn t08_remote_mode_downgrade_audit_marker_shape() {
        assert_eq!(REMOTE_MODE_DOWNGRADE_AUDIT_MARKER, "remote-mode-downgrade");
    }

    // ── R1-10 T-14：双轨确认路由纯函数（D5 §4.4）──

    /// 桌面在线 → 双轨（移动端 + 桌面端弹窗）
    #[test]
    fn t14_dual_track_route_when_desktop_present() {
        assert_eq!(route_remote_approval(true), RemoteApprovalRoute::Dual);
    }

    /// 无人值守（缺省 false = 保守模式）→ RemoteOnly + remote-only 审计标记
    #[test]
    fn t14_unattended_routes_to_remote_only_marker() {
        assert_eq!(route_remote_approval(false), RemoteApprovalRoute::RemoteOnly);
        assert_eq!(REMOTE_ONLY_AUDIT_MARKER, "remote-only");
    }

    /// 双轨裁决合成：任一方拒绝即拒绝——仅双方均批准才放行
    #[test]
    fn t14_dual_decision_either_party_denies_rejects() {
        assert!(
            combine_dual_decisions(true, true),
            "移动端 + 桌面端均批准 → 放行"
        );
        assert!(
            !combine_dual_decisions(true, false),
            "桌面端拒绝 → 双轨拒绝"
        );
        assert!(
            !combine_dual_decisions(false, true),
            "移动端拒绝 → 双轨拒绝"
        );
        assert!(!combine_dual_decisions(false, false));
    }

    // ── R1-10 T-07：remote-source-attempt 审计标记（D5 §4.5 第三层）──

    /// 标记载荷形状：operation=remote-source-attempt + 命令名 + blocked 决策
    /// （发射侧结构化审计日志携带同一内容——审计断言锚）
    #[test]
    fn t07_remote_source_attempt_marker_shape() {
        let marker = remote_source_attempt_marker("config_secret_reveal");
        assert!(marker.contains("operation=remote-source-attempt"));
        assert!(marker.contains("command=config_secret_reveal"));
        assert!(marker.contains("decision=blocked"));
    }

    // ── R1-11 D-5 收口：remote-* 事件级审计发射（红线 7 端到端可验）──

    /// 记录型发射器（事件桥测试替身，对齐 core_run_commands 测试先例）
    #[derive(Default)]
    struct RecordingEmitter(std::sync::Mutex<Vec<String>>);

    impl crate::core_event_bridge::Emitter for RecordingEmitter {
        fn emit(&self, _channel: &str, payload: &str) {
            self.0.lock().unwrap().push(payload.to_string());
        }
    }

    fn recording_bridge() -> (EventBridge, Arc<RecordingEmitter>) {
        let emitter = Arc::new(RecordingEmitter::default());
        let bridge = EventBridge::new(
            "workbench-run-event",
            Arc::clone(&emitter) as Arc<dyn crate::core_event_bridge::Emitter>,
        );
        (bridge, emitter)
    }

    /// 从记录载荷解析 security-audit 信封（恰一条；runId 不注入——
    /// 远程动作 run 创建前 / 无会话上下文）
    fn recorded_security_audit(emitter: &RecordingEmitter) -> AgentEvent {
        let recorded = emitter.0.lock().unwrap();
        assert_eq!(recorded.len(), 1, "必须恰好发射一条 security-audit");
        let envelope: AgentEventEnvelope =
            serde_json::from_str(&recorded[0]).expect("信封 JSON 可解析");
        assert_eq!(envelope.run_id, None, "runId 不注入（run 创建前/无会话）");
        envelope.event
    }

    /// remote-mode-downgrade 事件载荷（D5 §6.2：operation +
    /// blocked 决策 + 降级前模式 + targets 承载 runId）
    #[test]
    fn t08_remote_mode_downgrade_emits_security_audit_event() {
        let (bridge, emitter) = recording_bridge();
        emit_remote_mode_downgrade_audit(Some(&bridge), "run-42", "s1");
        let AgentEvent::SecurityAudit {
            operation,
            targets,
            decision,
            permission_mode,
            session_id,
            ..
        } = recorded_security_audit(&emitter)
        else {
            panic!("应为 SecurityAudit 事件");
        };
        assert_eq!(operation, SecurityAuditOperation::RemoteModeDowngrade);
        assert_eq!(decision, SecurityAuditDecision::Blocked, "降级动作决策 = blocked（记录降级）");
        assert_eq!(permission_mode.as_deref(), Some("full-access"), "permission_mode 记录降级前申请值");
        assert_eq!(targets, vec!["run-42".to_string()], "targets 承载 runId");
        assert_eq!(session_id, "s1");
    }

    /// remote-mode-downgrade 事件 wire 形状（kebab-case operation 序列化）
    #[test]
    fn t08_remote_mode_downgrade_event_wire_shape() {
        let (bridge, emitter) = recording_bridge();
        emit_remote_mode_downgrade_audit(Some(&bridge), "", "s1");
        let recorded = emitter.0.lock().unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&recorded[0]).expect("信封 JSON 可解析");
        // 信封 flatten 序列化：type/事件体字段在顶层（AgentEventEnvelope
        // serialize 把事件体字段并入顶层 map——对齐既有信封契约）
        assert_eq!(json["type"], "security-audit");
        assert_eq!(json["operation"], "remote-mode-downgrade");
        assert_eq!(json["decision"], "blocked");
        assert_eq!(json["permissionMode"], "full-access");
    }

    /// remote-source-attempt 事件载荷（D5 §6.2：operation + 命令名 +
    /// blocked 决策；命令含令牌形态时事件载荷打码——红线 7 断言锚）
    #[test]
    fn t07_remote_source_attempt_emits_redacted_audit_event() {
        let (bridge, emitter) = recording_bridge();
        emit_remote_source_attempt_audit(Some(&bridge), "config_secret_reveal");
        let AgentEvent::SecurityAudit {
            operation,
            targets,
            decision,
            ..
        } = recorded_security_audit(&emitter)
        else {
            panic!("应为 SecurityAudit 事件");
        };
        assert_eq!(operation, SecurityAuditOperation::RemoteSourceAttempt);
        assert_eq!(decision, SecurityAuditDecision::Blocked);
        assert_eq!(targets, vec!["config_secret_reveal".to_string()]);
    }

    /// 打码断言：命令串携带 43 字符 base64url 令牌形态时，事件载荷与
    /// 标记载荷均无明文形态（redact_text 打码——红线 7 / T-06 零明文
    /// 口径同源；scan_sensitive 扫描事件载荷零命中）
    #[test]
    fn t07_remote_source_attempt_redacts_token_in_payload() {
        let token = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE";
        assert_eq!(token.chars().count(), 43, "测试令牌须为 43 字符 base64url 形态");
        let command = format!("config_secret_get token={token}");
        let (bridge, emitter) = recording_bridge();
        emit_remote_source_attempt_audit(Some(&bridge), &command);
        // 事件载荷（信封 + 事件体全量文本）零敏感形态
        let recorded = emitter.0.lock().unwrap();
        assert!(
            conex_telemetry::redact::scan_sensitive(&recorded[0]).is_empty(),
            "事件载荷不得含令牌/配对码明文形态：{}",
            recorded[0]
        );
        assert!(
            !recorded[0].contains(&token),
            "事件载荷不得含令牌原文"
        );
        // 标记载荷同源打码（发射侧与标记共用同一 redact 输入）
        let marker = remote_source_attempt_marker(&conex_telemetry::redact::redact_text(&command));
        assert!(
            !marker.contains(&token),
            "标记载荷不得含令牌原文"
        );
    }

    /// remote-only 事件载荷（D5 §4.4：无人值守移动端单方批准标记）
    #[test]
    fn t14_remote_only_emits_security_audit_event() {
        let (bridge, emitter) = recording_bridge();
        emit_remote_only_audit(Some(&bridge), "s1");
        let AgentEvent::SecurityAudit {
            operation,
            decision,
            session_id,
            ..
        } = recorded_security_audit(&emitter)
        else {
            panic!("应为 SecurityAudit 事件");
        };
        assert_eq!(operation, SecurityAuditOperation::RemoteOnly);
        assert_eq!(decision, SecurityAuditDecision::Approved, "单方批准已放行 → approved");
        assert_eq!(session_id, "s1");
    }

    /// 事件总线未接线（None）时降级纯结构化日志：不发事件不 panic
    /// （与 R1-10 行为一致，router 未装配桥的场景）
    #[test]
    fn t07_remote_audit_none_bridge_degrades_to_log_only() {
        emit_remote_source_attempt_audit(None, "config_secret_reveal");
        emit_remote_mode_downgrade_audit(None, "", "s1");
        emit_remote_only_audit(None, "s1");
    }

    // ── R1-11 G-5 红线 2 装配断言：远程 run 申报 full-access（真实装配链）──

    /// 会话索引条目（测试会话；对齐 core_run_commands 测试先例）
    fn g5_test_session_entry(id: &str) -> conex_types::SessionIndexEntry {
        conex_types::SessionIndexEntry {
            id: id.to_string(),
            title: format!("会话 {id}"),
            folder: String::new(),
            is_pinned: false,
            is_archived: false,
            branch_parent_id: None,
            timestamp: "2026-08-05T00:00:00.000Z".to_string(),
            updated_at: 1,
            message_count: 0,
            pinned_message_ids: None,
            engine_cursor: Some(0),
            engine_last_run_id: None,
            hydrated_from_engine: Some(true),
        }
    }

    /// 轮询事件桥载荷出现指定 operation 的 security-audit（窗口内未到
    /// 则 panic——不静默降级；对齐 core_run_commands wait_for_audit_operation
    /// 先例）
    async fn g5_wait_audit_operation(
        emitter: &Arc<RecordingEmitter>,
        operation: &str,
        window: std::time::Duration,
    ) {
        let deadline = std::time::Instant::now() + window;
        loop {
            let payloads = emitter.0.lock().unwrap().clone();
            if payloads
                .iter()
                .filter(|p| p.contains("security-audit"))
                .any(|p| p.contains(operation))
            {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "审计 {operation} 未在窗口内发射"
            );
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
    }

    /// 红线 2 装配断言（R1-11 §3 / D5 §10.3-2 / T-08 端到端）：远程 run
    /// 申报 full-access → 经真实装配链（CoreStateBackend::run_task →
    /// run_task_impl 完整 run loop，TestProvider 引擎注入）降级 ask +
    /// RemoteModeDowngrade 审计事件发射。审计断言 = SecurityAudit
    /// (remote-mode-downgrade) 事件载荷（blocked + permission_mode 记录
    /// 降级前申请值 full-access）；装配断言 = 降级后的 run 正常发起并
    /// 收口（agent-end 落库——生效 ask 进入 run 装配，D5 §4.6.1
    /// min(requested, Ask) 截断不破坏 run 执行链）
    #[tokio::test]
    async fn t08_redline2_full_access_run_emits_downgrade_audit_end_to_end() {
        use agent_provider::config::Endpoint;
        use session_loop::provider::ProviderCall;
        use session_loop::stream::{ProviderStreamEvent, StopReason};
        use session_loop::testing::TestProvider;

        let (bridge, emitter) = recording_bridge();
        let db = conex_db::LocalDb::open_in_memory().expect("内存库");
        db.upsert_session_entry(&g5_test_session_entry("s1"))
            .expect("会话条目");
        static G5_TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = G5_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let snapshots: Arc<dyn orchestrator::restore::SnapshotStore> = Arc::new(
            orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
                "conex_redline2_{}_{seq}_snapshot.json",
                std::process::id()
            ))),
        );
        let state = Arc::new(crate::core_run_commands::CoreRunState::new(
            Arc::new(orchestrator::persist::LocalDbStore::new(db.clone())),
            snapshots,
            bridge,
            Arc::new(crate::status_diagnostics::StatusDiagnostics::new()),
            None,
        ));
        // TestProvider 引擎注入（完整 run loop 装配；脚本 = 单轮文本收口）
        let provider = Arc::new(TestProvider::new(vec![
            ProviderStreamEvent::text("远程 run 收口。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ]));
        let routed: Arc<dyn ProviderCall> = provider;
        let config = crate::engine::EngineProviderConfig {
            base_url: "http://test.local/v1".to_string(),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-flash".to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: std::collections::BTreeMap::new(),
        };
        state.engine().inject_provider_for_test(routed, config);
        state.run_restore().await;

        // 远程 run 申报 full-access → 经装配面（REST 直调同构）
        let backend = CoreStateBackend::new(Arc::clone(&state));
        let result = backend
            .run_task(RunTaskParams {
                session_id: Some("s1".to_string()),
                prompt: "远程 run（full-access 申报）".to_string(),
                prompt_ref: None,
                mode: None,
                cwd: None,
                permission_mode: Some(PermissionMode::FullAccess),
                history: None,
                client_message_id: None,
            })
            .await;
        assert!(result.is_ok(), "降级后的 run 必须正常发起：{result:?}");

        // 审计断言：RemoteModeDowngrade 事件发射（blocked + 降级前值）
        g5_wait_audit_operation(
            &emitter,
            "remote-mode-downgrade",
            std::time::Duration::from_secs(5),
        )
        .await;
        let payloads = emitter.0.lock().unwrap().clone();
        let downgrades = payloads
            .iter()
            .filter(|p| p.contains("remote-mode-downgrade"))
            .collect::<Vec<_>>();
        assert_eq!(downgrades.len(), 1, "降级审计必须恰发射一次");
        let envelope: conex_types::events::AgentEventEnvelope =
            serde_json::from_str(downgrades[0]).expect("信封 JSON 可解析");
        let conex_types::events::AgentEvent::SecurityAudit {
            operation,
            decision,
            permission_mode,
            ..
        } = envelope.event
        else {
            panic!("应为 SecurityAudit 事件");
        };
        assert_eq!(
            operation,
            conex_types::events::SecurityAuditOperation::RemoteModeDowngrade
        );
        assert_eq!(decision, conex_types::events::SecurityAuditDecision::Blocked);
        assert_eq!(
            permission_mode.as_deref(),
            Some("full-access"),
            "permission_mode 记录降级前申请值"
        );

        // 装配断言：生效 ask 下 run 正常收口（agent-end 事件落库——降级
        // 不破坏 run 执行链，D5 §4.6.1）
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let events = db.query_events("s1", 0, Some(500)).expect("事件查询");
            if events.iter().any(|event| event.event_type == "agent-end") {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "agent-end 未在窗口内落库——run 未正常收口"
            );
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
    }

    // ── R2-12c：C21/C30/C31 真实直调面（CoreStateBackend）──

    /// 测试用 CoreRunState（真实引擎路径——scheduler_registry 装配为
    /// Some；对齐 core_run_commands 测试先例）
    fn r2_test_core_state() -> Arc<CoreRunState> {
        static R2_TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let (bridge, _emitter) = recording_bridge();
        let seq = R2_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let db = conex_db::LocalDb::open_in_memory().expect("内存库");
        let snapshots: Arc<dyn orchestrator::restore::SnapshotStore> = Arc::new(
            orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
                "conex_r2_12c_{}_{seq}_snapshot.json",
                std::process::id()
            ))),
        );
        Arc::new(CoreRunState::new(
            Arc::new(orchestrator::persist::LocalDbStore::new(db)),
            snapshots,
            bridge,
            Arc::new(crate::status_diagnostics::StatusDiagnostics::new()),
            None,
        ))
    }

    /// C21 搜索后端（注入索引 + 工作区根）
    fn search_backend(files: Vec<String>, root: Option<&str>) -> CoreStateBackend {
        let state = Arc::new(crate::core_commands::SharedSearchState {
            files: std::sync::RwLock::new(Arc::new(files)),
        });
        let mut backend = CoreStateBackend::new(r2_test_core_state()).with_search_state(state);
        if let Some(root) = root {
            backend = backend.with_search_root(root.to_string());
        }
        backend
    }

    /// C21：命中映射（relPath 剥离工作区根 + 统一 `/`；kind/size 缺省
    /// None——搜索索引只存路径，注册表 optional 字段缺省合法）
    #[tokio::test]
    async fn r2_12_search_files_maps_hits_to_relative_paths() {
        let backend = search_backend(
            vec![
                "C:/proj/src/main.rs".to_string(),
                "C:/proj/README.md".to_string(),
            ],
            Some("C:/proj"),
        );
        let result = backend
            .search_files(SearchFilesParams {
                query: "main".to_string(),
                root: None,
                max_results: None,
            })
            .await
            .expect("搜索应成功");
        assert_eq!(result.results.len(), 1);
        assert_eq!(result.results[0].rel_path, "src/main.rs");
        assert_eq!(result.results[0].kind, None);
        assert_eq!(result.results[0].size, None);
    }

    /// C21：root 相对路径按组件边界过滤（root=src → 仅 src 子树命中；
    /// 目录边界锚定——根目录的 main.rs 与 docs/ 下 main 均不误命中）
    #[tokio::test]
    async fn r2_12_search_files_filters_by_relative_root() {
        let backend = search_backend(
            vec![
                "C:/proj/src/main.rs".to_string(),
                "C:/proj/src/lib.rs".to_string(),
                "C:/proj/docs/main-guide.md".to_string(),
                "C:/proj/main.rs".to_string(),
            ],
            Some("C:/proj"),
        );
        let result = backend
            .search_files(SearchFilesParams {
                query: "main".to_string(),
                root: Some("src".to_string()),
                max_results: Some(10),
            })
            .await
            .expect("搜索应成功");
        let paths: Vec<&str> = result.results.iter().map(|h| h.rel_path.as_str()).collect();
        assert_eq!(paths, vec!["src/main.rs"], "root=src 仅命中 src 子树：{paths:?}");
    }

    /// C21：校验面（空 query / 超长 query / 绝对 root / 索引未接线）
    #[tokio::test]
    async fn r2_12_search_files_validation_errors() {
        let backend = search_backend(
            vec!["C:/proj/src/main.rs".to_string()],
            Some("C:/proj"),
        );
        let cases = [
            (
                "query 为空",
                SearchFilesParams {
                    query: "  ".to_string(),
                    root: None,
                    max_results: None,
                },
            ),
            (
                "query 超长（>256）",
                SearchFilesParams {
                    query: "x".repeat(257),
                    root: None,
                    max_results: None,
                },
            ),
            (
                "root 绝对路径",
                SearchFilesParams {
                    query: "main".to_string(),
                    root: Some("C:/proj/src".to_string()),
                    max_results: None,
                },
            ),
        ];
        for (label, params) in cases {
            let err = backend.search_files(params).await.expect_err("应拒绝");
            assert_eq!(err.device_code(), DeviceErrorCode::CmdInvalid, "{label}");
        }
        // 索引未接线 → cmd.engine_not_ready（诚实降级）
        let unwired = CoreStateBackend::new(r2_test_core_state());
        let err = unwired
            .search_files(SearchFilesParams {
                query: "main".to_string(),
                root: None,
                max_results: None,
            })
            .await
            .expect_err("未接线应拒绝");
        assert_eq!(err.device_code(), DeviceErrorCode::CmdEngineNotReady);
    }

    /// C21：maxResults 钳制 [1, 100]（注册表桌面端钳制）
    #[tokio::test]
    async fn r2_12_search_files_clamps_max_results() {
        let files: Vec<String> = (0..150).map(|i| format!("C:/proj/f{i}.rs")).collect();
        let backend = search_backend(files, Some("C:/proj"));
        let result = backend
            .search_files(SearchFilesParams {
                query: "f".to_string(),
                root: None,
                max_results: Some(10_000),
            })
            .await
            .expect("搜索应成功");
        assert_eq!(result.results.len(), 100, "maxResults 超限钳制到 100");
        let result = backend
            .search_files(SearchFilesParams {
                query: "f".to_string(),
                root: None,
                max_results: Some(0),
            })
            .await
            .expect("搜索应成功");
        assert_eq!(result.results.len(), 1, "maxResults 钳制下限 1");
    }

    /// C30：设置确认回执（query → expired / withdraw → withdrawn；
    /// 空 confirmRequestId → cmd.invalid）
    #[tokio::test]
    async fn r2_12_settings_confirm_receipts() {
        let backend = CoreStateBackend::new(r2_test_core_state());
        let withdrawn = backend
            .settings_confirm(SettingsConfirmParams {
                confirm_request_id: "req-1".to_string(),
                action: SettingsConfirmAction::Withdraw,
            })
            .await
            .expect("撤回应成功");
        assert_eq!(withdrawn.status, SettingsConfirmStatus::Withdrawn);
        assert!(withdrawn.reason.is_some(), "撤回回执应携带原因（回执语义）");
        let queried = backend
            .settings_confirm(SettingsConfirmParams {
                confirm_request_id: "req-1".to_string(),
                action: SettingsConfirmAction::Query,
            })
            .await
            .expect("查询应成功");
        assert_eq!(queried.status, SettingsConfirmStatus::Expired);
        assert!(queried.reason.is_some(), "查询回执应携带原因（回执语义）");
        let err = backend
            .settings_confirm(SettingsConfirmParams {
                confirm_request_id: "  ".to_string(),
                action: SettingsConfirmAction::Query,
            })
            .await
            .expect_err("空 id 应拒绝");
        assert_eq!(err.device_code(), DeviceErrorCode::CmdInvalid);
    }

    /// C31：暂停定时自动执行（真实 scheduler 装配链——缺省 3600、
    /// 钳制 [60, 86400]、重复暂停刷新 pausedUntil）
    #[tokio::test]
    async fn r2_12_pause_automation_via_real_scheduler() {
        let state = r2_test_core_state();
        assert!(
            state.scheduler_registry().is_some(),
            "真实引擎路径调度器应已装配"
        );
        let backend = CoreStateBackend::new(Arc::clone(&state));
        let before = crate::server::now_ms();
        let result = backend
            .pause_automation(PauseAutomationParams { duration_sec: None })
            .await
            .expect("暂停应成功");
        assert!(result.ok);
        assert!(
            result.paused_until >= before + 3600 * 1000,
            "缺省 durationSec=3600"
        );
        let registry = state.scheduler_registry().expect("调度器");
        assert_eq!(registry.pause_deadline(), Some(result.paused_until));
        // 钳制：<60 → 60；>86400 → 86400（注册表契约，桌面端钳制）
        let min = backend
            .pause_automation(PauseAutomationParams { duration_sec: Some(5) })
            .await
            .expect("钳制下限");
        let expected_min = before + 60 * 1000;
        assert!(min.paused_until >= expected_min, "钳制下限 60s：{min:?}");
        assert!(min.paused_until <= expected_min + 5_000, "钳制下限 60s（含余量）：{min:?}");
        let max = backend
            .pause_automation(PauseAutomationParams { duration_sec: Some(999_999) })
            .await
            .expect("钳制上限");
        let expected_max = before + 86400 * 1000;
        assert!(max.paused_until >= expected_max, "钳制上限 86400s：{max:?}");
        assert!(max.paused_until <= expected_max + 5_000, "钳制上限 86400s（含余量）：{max:?}");
        // 重复暂停刷新 pausedUntil（R2-11 §11）
        let refreshed = backend
            .pause_automation(PauseAutomationParams { duration_sec: Some(120) })
            .await
            .expect("刷新");
        assert!(refreshed.paused_until < max.paused_until, "刷新应覆盖旧截止");
        assert_eq!(registry.pause_deadline(), Some(refreshed.paused_until));
    }

    /// C22：资源 URL 占位（ApiBackend 缺省实现 = 501 cmd.unknown——
    /// F4 §5.4 资源代理未实现，诚实降级不捏造 URL）
    #[tokio::test]
    async fn r2_12_asset_url_placeholder_not_implemented() {
        let backend = CoreStateBackend::new(r2_test_core_state());
        let err = backend
            .asset_url(conex_types::device::AssetUrlParams {
                path: "docs/x.png".to_string(),
                kind: conex_types::device::AssetKind::Image,
            })
            .await
            .expect_err("占位端点必须返回错误");
        assert_eq!(err.device_code(), DeviceErrorCode::CmdUnknown);
    }

    // ── P-7（R2-07 D-02 收尾）：/v1/status activeRuns / pendingApprovals ──

    /// 空态接线：get_status 响应必须包含 activeRuns / pendingApprovals
    /// 数组（注册表 StatusResult 可选字段——桌面端总是下发数组，
    /// 空数组合法，移动端解析宽容；D-02「缺省合法」面）
    #[tokio::test]
    async fn p7_status_empty_state_includes_active_runs_and_pending_approvals() {
        let backend = CoreStateBackend::new(r2_test_core_state());
        let status = backend.get_status().await.expect("get_status");
        assert_eq!(
            status["activeRuns"],
            serde_json::json!([]),
            "空态 activeRuns = 空数组"
        );
        assert_eq!(
            status["pendingApprovals"],
            serde_json::json!([]),
            "空态 pendingApprovals = 空数组"
        );
    }

    /// 端到端：真实 run（write_file 危险工具 + ask 权限模式）→ 审批门
    /// pending 注册 + run 停 awaiting-approval → get_status 的
    /// activeRuns / pendingApprovals 均非空且字段形状 = M6 §4.1.1
    /// （activeRuns：runId/sessionId/status/startedAt + prompt 兜底空串；
    /// pendingApprovals：toolCallId/toolName/runId/summary）
    #[tokio::test]
    async fn p7_status_includes_active_runs_and_pending_approvals_end_to_end() {
        use agent_provider::config::Endpoint;
        use session_loop::provider::ProviderCall;
        use session_loop::stream::{ProviderStreamEvent, StopReason};
        use session_loop::testing::TestProvider;

        let state = r2_test_core_state();
        // TestProvider：文本 + 危险工具 write_file 调用（ask 模式 →
        // NeedsApproval → 审批门 request_approval；测试不裁决 → run 停在
        // awaiting-approval 保持活动——activeRuns/pendingApprovals 双非空）
        let provider = Arc::new(TestProvider::new(vec![
            ProviderStreamEvent::text("写入文件。"),
            ProviderStreamEvent::tool_call(
                Some("call-p7".to_string()),
                "write_file",
                serde_json::json!({ "path": "x.md", "content": "p7" }),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ]));
        let routed: Arc<dyn ProviderCall> = provider;
        let config = crate::engine::EngineProviderConfig {
            base_url: "http://test.local/v1".to_string(),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-flash".to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: std::collections::BTreeMap::new(),
        };
        state.engine().inject_provider_for_test(routed, config);
        state.run_restore().await;

        let backend = CoreStateBackend::new(Arc::clone(&state));
        let result = backend
            .run_task(RunTaskParams {
                session_id: Some("s1".to_string()),
                prompt: "写入文件".to_string(),
                prompt_ref: None,
                mode: None,
                cwd: None,
                permission_mode: Some(PermissionMode::Ask),
                history: None,
                client_message_id: None,
            })
            .await
            .expect("run 应发起（ask 权限模式）");

        // 轮询 get_status 直到 pendingApprovals 非空（工具调用 → 审批门
        // pending 注册；run 未裁决保持活动，activeRuns 同时非空）
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let status = loop {
            let value = backend.get_status().await.expect("get_status");
            let pending = value["pendingApprovals"]
                .as_array()
                .map(Vec::len)
                .unwrap_or(0);
            let active = value["activeRuns"].as_array().map(Vec::len).unwrap_or(0);
            if pending > 0 && active > 0 {
                break value;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "审批未在窗口内进入 pending：{value}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };
        // activeRuns 形状（M6 §4.1.1；wire 排序 = run_id 字典序）
        assert_eq!(status["activeRuns"][0]["runId"], result.run_id);
        assert_eq!(status["activeRuns"][0]["sessionId"], "s1");
        let run_status = status["activeRuns"][0]["status"]
            .as_str()
            .expect("status 应为字符串");
        assert!(
            ["queued", "initializing", "running", "awaiting-approval"].contains(&run_status),
            "活动 run 状态应在非终态集合内：{run_status}"
        );
        assert!(
            status["activeRuns"][0]["startedAt"].as_i64().is_some(),
            "startedAt 应为 epoch ms"
        );
        assert_eq!(
            status["activeRuns"][0]["prompt"],
            "",
            "prompt 兜底恒空串（runs 表无 prompt 持久化）"
        );
        // pendingApprovals 形状（M6 §4.1.1；wire 排序 = tool_call_id 字典序）
        assert_eq!(status["pendingApprovals"][0]["toolCallId"], "call-p7");
        assert_eq!(status["pendingApprovals"][0]["toolName"], "write_file");
        assert_eq!(status["pendingApprovals"][0]["runId"], result.run_id);
        assert_eq!(
            status["pendingApprovals"][0]["summary"],
            "call write_file",
            "审批门摘要（format!(\"call {{tool_name}}\")）透传"
        );
        // 收尾：取消 run（L3）释放审批等待（APPROVAL_TIMEOUT 120s
        // 超时不阻塞测试收尾；终态后 active_runs 移出注册表）
        let cancelled = backend
            .cancel_run(CancelRunParams {
                run_id: result.run_id.clone(),
                reason: Some("p7 测试收尾".to_string()),
            })
            .await;
        assert!(cancelled.is_ok(), "取消 run 收尾：{cancelled:?}");
    }
}
