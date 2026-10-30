use conex_types::device::commands::{
    SettingsConfirmAction, SettingsConfirmParams, SettingsConfirmResult, SettingsConfirmStatus,
};
use conex_types::device::commands::{SwitchWorkspaceParams, SwitchWorkspaceResult};
use conex_types::device::{
    ApprovalHistoryParams, ApprovalHistoryResult, ApproveParams, ApproveResult, CancelRunParams,
    CancelRunResult, DenyParams, DeviceErrorCode, EventPageParams, EventPageResult,
    FlowSnapshotParams, FlowSnapshotResult, GetSettingsParams, GetSettingsResult, ListCommandsResult,
    ListDirParams, ListDirResult, ListPendingApprovalsParams, ListPendingApprovalsResult,
    ListSessionsParams, ListSessionsResult, ListTasksParams, ListTasksResult, ListWorkspacesParams,
    ListWorkspacesResult, PauseAutomationParams, PauseAutomationResult, ReadFileParams,
    ReadFileResult, RunControlLevel, RunControlParams, RunControlResult, RunEventsParams,
    RunSnapshotParams, RunSnapshotResult, RunTaskParams, RunTaskResult, SearchFilesParams,
    SearchFilesResult, SearchIndexResult,
};

use crate::run_ipc::{settings_get_impl, settings_update_impl};
use crate::server::backend::{ApiBackend, SettingsUpdateParams};
use crate::server::ServerError;
use conex_run::run::{
    approval_history_impl, approve_tool_impl, cancel_run_impl, deny_tool_impl,
    get_flow_snapshot_impl, get_run_snapshot_impl, get_task_output_impl,
    list_background_tasks_impl, list_pending_approvals_impl, list_sessions_impl,
    read_run_events_impl, read_session_events_impl, run_control_impl,
};

use super::state::{resolve_approval_run_id, resolve_deny_run_id};
use super::CoreStateBackend;

#[async_trait::async_trait]
impl ApiBackend for CoreStateBackend {
    // ── F1 监控域只读面（R1-03 登记；R1-04 直调接入）──

    /// C01 状态查询：build_status 纯函数组装（M6 C01 裁剪口径——
    /// logDir 不下发；diagnostics / lastError 与 GUI 共享同一
    /// StatusDiagnostics 实例）
    async fn get_status(&self) -> Result<serde_json::Value, ServerError> {
        self.execute_get_status().await
    }

    /// C02 run 快照（usage 无样本置 null 的裁剪由 run_usage 缓存口径保证）
    async fn get_run_snapshot(
        &self,
        params: RunSnapshotParams,
    ) -> Result<RunSnapshotResult, ServerError> {
        let response =
            get_run_snapshot_impl(self.core(), &params.run_id, params.session_id.as_deref())
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
            self.core(),
            &params.session_id,
            params.after_sequence,
            params.max_events.map(u64::from),
        )
        .await
        .map_err(Self::map_core)?;
        // latestSequence = 服务端该会话当前 max（游标推进判断；M6 C03）
        let store = self.core().store();
        let latest_sequence = store
            .query_events(&params.session_id, 0, None)
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
            self.core(),
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
        let sessions = list_sessions_impl(self.core()).map_err(Self::map_core)?;
        Ok(ListSessionsResult { sessions })
    }

    /// C06 后台任务列表（摘要；不携带输出内容，M6 §4.1.6）
    async fn list_background_tasks(
        &self,
        _params: ListTasksParams,
    ) -> Result<ListTasksResult, ServerError> {
        let tasks = list_background_tasks_impl(self.core())
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
            self.core(),
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
            get_flow_snapshot_impl(self.core(), &params.session_id).map_err(Self::map_core)?;
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
        // C21 接线后：注入的共享搜索状态为实时事实源（命令面重建索引 →
        // 本端点立即可见，与 core_get_status 同源）；未注入时回退装配面
        // 注入的就绪快照（启动时空索引 → false 诚实降级）
        let ready = match &self.search_state {
            Some(state) => state
                .files
                .read()
                .map(|files| !files.is_empty())
                .unwrap_or(false),
            None => self.search_index_ready,
        };
        Ok(SearchIndexResult { ready, state: None })
    }

    // ── F5 会话域 / F2 审批域 / F6 设置域写面（R1-04 真实直调）──

    /// C24 发起 run（runId 桌面生成；sessionId 缺省 = 新建会话并落索引，
    /// M6 C24；clientMessageId 幂等由 run_task_impl 既有语义保证）
    async fn run_task(&self, params: RunTaskParams) -> Result<RunTaskResult, ServerError> {
        self.execute_run_task(params).await
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
            self.core(),
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
        let response = cancel_run_impl(self.core(), &params.run_id, None, params.reason.as_deref())
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
        let run_id = resolve_approval_run_id(self.core(), &params)?;
        let response = approve_tool_impl(self.core(), &run_id, &params.tool_call_id, None)
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
        let run_id = resolve_deny_run_id(self.core(), &params)?;
        let response = deny_tool_impl(
            self.core(),
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
        let approvals = list_pending_approvals_impl(self.core());
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
            self.core(),
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
            self.core(),
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
        self.execute_search_files(params).await
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
        let registry = self.core().scheduler_registry().ok_or_else(|| {
            ServerError::protocol(
                DeviceErrorCode::CmdEngineNotReady,
                "调度器未装配（Cron 注册表未接线）",
            )
        })?;
        let paused_until = registry.pause_for(u64::from(duration_sec));
        Ok(PauseAutomationResult {
            ok: true,
            paused_until,
        })
    }

    // ── F4 文件域读命令（移动端伴侣；阻塞 IO 下沉 spawn_blocking）──

    async fn list_dir(&self, params: ListDirParams) -> Result<ListDirResult, ServerError> {
        let ops = self.workspace_ops().ok_or_else(|| {
            ServerError::protocol(DeviceErrorCode::CmdEngineNotReady, "工作区操作未装配")
        })?;
        tokio::task::spawn_blocking(move || {
            ops.list_dir(params.workspace_root.as_deref(), params.path.as_deref())
        })
        .await
        .map_err(|error| ServerError::internal(format!("list_dir 任务失败：{error}")))?
    }

    async fn read_file(&self, params: ReadFileParams) -> Result<ReadFileResult, ServerError> {
        let ops = self.workspace_ops().ok_or_else(|| {
            ServerError::protocol(DeviceErrorCode::CmdEngineNotReady, "工作区操作未装配")
        })?;
        tokio::task::spawn_blocking(move || {
            ops.read_file(
                params.workspace_root.as_deref(),
                &params.path,
                params.max_lines,
                params.start_line,
            )
        })
        .await
        .map_err(|error| ServerError::internal(format!("read_file 任务失败：{error}")))?
    }

    async fn list_workspaces(
        &self,
        _params: ListWorkspacesParams,
    ) -> Result<ListWorkspacesResult, ServerError> {
        let ops = self.workspace_ops().ok_or_else(|| {
            ServerError::protocol(DeviceErrorCode::CmdEngineNotReady, "工作区操作未装配")
        })?;
        let workspaces = tokio::task::spawn_blocking(move || ops.list_workspaces())
            .await
            .map_err(|error| ServerError::internal(format!("list_workspaces 任务失败：{error}")))??;
        Ok(ListWorkspacesResult { workspaces })
    }

    async fn switch_workspace(
        &self,
        params: SwitchWorkspaceParams,
    ) -> Result<SwitchWorkspaceResult, ServerError> {
        let ops = self.workspace_ops().ok_or_else(|| {
            ServerError::protocol(DeviceErrorCode::CmdEngineNotReady, "工作区操作未装配")
        })?;
        let active_root =
            tokio::task::spawn_blocking(move || ops.switch_workspace(&params.path))
                .await
                .map_err(|error| {
                    ServerError::internal(format!("switch_workspace 任务失败：{error}"))
                })??;
        Ok(SwitchWorkspaceResult {
            ok: true,
            active_root,
        })
    }
}
