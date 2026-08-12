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
    CancelRunResult, DenyParams, EventPageParams, EventPageResult, FlowSnapshotParams,
    FlowSnapshotResult, GetSettingsParams, GetSettingsResult, ListCommandsResult,
    ListPendingApprovalsParams, ListPendingApprovalsResult, ListSessionsParams, ListSessionsResult,
    ListTasksParams, ListTasksResult, PermissionMode, RunControlLevel, RunControlParams,
    RunControlResult, RunEventsParams, RunSnapshotParams, RunSnapshotResult, RunTaskParams,
    RunTaskResult, SearchIndexResult,
};
use conex_types::events::{AgentEvent, AgentEventEnvelope, SecurityAuditDecision, SecurityAuditOperation};
use conex_types::impact::ImpactAssessment;

use crate::core_event_bridge::EventBridge;

use crate::core_run_commands::{
    approval_history_impl, approve_tool_impl, cancel_run_impl, deny_tool_impl,
    find_run_by_pending_tool_call, generate_run_id, generate_session_id, get_flow_snapshot_impl,
    get_run_snapshot_impl, get_task_output_impl, list_background_tasks_impl,
    list_pending_approvals_impl, list_sessions_impl, read_run_events_impl,
    read_session_events_impl, run_control_impl, run_task_impl, settings_get_impl,
    settings_update_impl, CoreRunState, RunTaskOptions,
};
use crate::server::backend::{ApiBackend, SettingsUpdateParams};
use crate::server::ServerError;

/// 命令后端（R1-04 注入 ServerState；持有引擎核心状态与只读面就绪标记）
pub struct CoreStateBackend {
    /// 引擎核心运行状态（store / 引擎 / 活动 run 注册表）
    core: Arc<CoreRunState>,
    /// 搜索索引就绪（装配面注入 SharedSearchState 事实；缺省 false =
    /// 未接线诚实降级，与骨架期能力位口径一致）
    search_index_ready: bool,
    /// 压缩能力接线标记（同上）
    compaction_ready: bool,
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
}
