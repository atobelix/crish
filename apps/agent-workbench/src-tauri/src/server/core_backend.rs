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
    ListTasksParams, ListTasksResult, RunControlLevel, RunControlParams, RunControlResult,
    RunEventsParams, RunSnapshotParams, RunSnapshotResult, RunTaskParams, RunTaskResult,
    SearchIndexResult,
};

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

    /// CoreError → ServerError（单一真源映射，M6 §6.2.3）
    fn map_core(error: conex_types::CoreError) -> ServerError {
        ServerError::from_core_error(&error)
    }
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
        // 权限模式 wire 映射（full-access 移动端不可改——协议面不提供
        // 该选项，M6 C24）；history 为既有 HistoryMessage 镜像（移动端
        // 一般省略，桌面 SessionHistoryCache 兜底）
        let permission_mode = params.permission_mode.map(|mode| match mode {
            conex_types::device::PermissionMode::Ask => "ask".to_string(),
            conex_types::device::PermissionMode::Plan => "plan".to_string(),
            conex_types::device::PermissionMode::FullAccess => "full-access".to_string(),
        });
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
