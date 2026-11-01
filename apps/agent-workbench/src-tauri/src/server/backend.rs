//! 服务层与核心命令的桥接契约（D2 §4.3「ApiBackend trait」）
//!
//! - **纯 trait**：只依赖 conex-types / serde / [ServerError]，不引用任何
//!   crate:: 内部模块——router 测试可直接编译挂内存后端全量
//!   驱动（D2 §13 测试隔离关键）；
//! - **命令体直调**：R1-03/04 的 `CoreStateBackend` 实现本 trait，方法内
//!   直调既有 `*_impl` 契约体（`core_get_status` / `core_get_run_snapshot` /
//!   `core_read_session_events` / `core_read_run_events` / `list_sessions` /
//!   `workbench_list_background_tasks` / `workbench_get_background_task_output` /
//!   `get_flow_snapshot` / `core_list_commands` / `core_search_files` 查询面等，
//!   均为「测试可直调、不依赖 Tauri runtime」的实现函数）；
//! - 方法签名以 conex-types `device/commands.rs` 的跨端命令类型为准
//!   （M6 §4 各域命令），入参转换与 CoreError 映射在实现层完成；
//! - R1-03 全量登记 **F1 监控域 10 条只读命令**（C01-C10，M6 §4.1，
//!   Z0 §9.3 R1-03「只读面先行」）；R1-04 增补写面（run 控制 / 审批）。
//! - R1-03 新增的 5 条方法带**缺省实现**（返回 internal 未接线）——
//!   并行任务（R1-05 ws.rs 等）的既有 mock 无需感知新方法即可编译；
//!   CoreStateBackend 覆盖为真实直调。

use conex_device_protocol::commands::{
    SettingsConfirmParams, SettingsConfirmResult, SwitchWorkspaceParams, SwitchWorkspaceResult,
    TaskOutputParams, TaskOutputResult, WorkspaceEntry,
};
use conex_device_protocol::{
    ApprovalHistoryParams, ApprovalHistoryResult, ApproveParams, ApproveResult, AssetUrlParams,
    AssetUrlResult, CancelRunParams, CancelRunResult, DeleteSessionParams, DenyParams,
    DeviceErrorCode, EventPageParams, EventPageResult, FlowSnapshotParams, FlowSnapshotResult,
    GetSettingsParams, GetSettingsResult, ListCommandsResult, ListDirParams, ListDirResult,
    ListModelsParams, ListModelsResult, ListPendingApprovalsParams, ListPendingApprovalsResult,
    ListSessionsParams, ListSessionsResult, ListSkillsParams, ListSkillsResult, ListTasksParams,
    ListTasksResult, ListWorkspacesParams, ListWorkspacesResult, OkResult, PauseAutomationParams,
    PauseAutomationResult, ReadFileParams, ReadFileResult, RenameSessionParams, RunControlParams,
    RunControlResult, RunEventsParams, RunSnapshotParams, RunSnapshotResult, RunTaskParams,
    RunTaskResult, SearchFilesParams, SearchFilesResult, SearchIndexResult, SetActiveModelParams,
    SetActiveModelResult, SetSessionArchivedParams, SetSessionPinnedParams,
};
use serde_json::Value;

use crate::server::ServerError;

/// 工作区文件只读操作（由装配面注入 Tauri AppHandle 实现；CoreStateBackend
/// 只依赖本 trait，保持 server 层可测试、不直接依赖 tauri runtime）。
pub trait WorkspaceOps: Send + Sync {
    fn list_workspaces(&self) -> Result<Vec<WorkspaceEntry>, ServerError>;
    fn switch_workspace(&self, path: &str) -> Result<String, ServerError>;
    fn list_dir(
        &self,
        workspace_root: Option<&str>,
        path: Option<&str>,
    ) -> Result<ListDirResult, ServerError>;
    fn read_file(
        &self,
        workspace_root: Option<&str>,
        path: &str,
        max_lines: Option<u32>,
        start_line: Option<u64>,
    ) -> Result<ReadFileResult, ServerError>;
}

/// 模型域操作（G2/W-B：全局默认模型读写；由装配面注入 Tauri AppHandle
/// 实现——与桌面「设置 → 模型」页读写同一份统一模型树
/// `UnifiedModelsConfig`，不另建移动端专用模型表；CoreStateBackend
/// 只依赖本 trait，保持 server 层可测试、不直接依赖 tauri runtime）
pub trait ModelsOps: Send + Sync {
    fn list_models(&self) -> Result<ListModelsResult, ServerError>;
    fn set_active_model(
        &self,
        provider_id: &str,
        model_id: &str,
    ) -> Result<SetActiveModelResult, ServerError>;
}

/// 会话操作域（G3：改名/置顶/归档/删除；由装配面注入 Tauri AppHandle
/// 实现——作用于桌面宿主会话存储（SharedDb 的 LocalDb sessions 表），
/// 与桌面侧栏同一存储层同一语义，不另建移动端专用会话表；
/// CoreStateBackend 只依赖本 trait，保持 server 层可测试）
pub trait SessionsOps: Send + Sync {
    fn rename_session(&self, session_id: &str, title: &str) -> Result<OkResult, ServerError>;
    fn set_session_pinned(&self, session_id: &str, pinned: bool) -> Result<OkResult, ServerError>;
    fn set_session_archived(
        &self,
        session_id: &str,
        archived: bool,
    ) -> Result<OkResult, ServerError>;
    fn delete_session(&self, session_id: &str) -> Result<OkResult, ServerError>;
}

/// 技能域操作（G7：技能目录只读浏览；由装配面注入 Tauri AppHandle
/// 实现——读宿主技能发现 `workbench_discover_skills`，与桌面
/// 「设置 → 扩展 → 技能」页同一发现真源，不另建移动端技能表；
/// 技能启停生效值是桌面 webview 本地状态（localStorage），宿主无
/// 数据面，故本域只有只读列表、无启停写面；CoreStateBackend 只
/// 依赖本 trait，保持 server 层可测试）
pub trait SkillsOps: Send + Sync {
    fn list_skills(&self) -> Result<ListSkillsResult, ServerError>;
}

/// 非敏感配置更新载荷（PUT /v1/settings；R1-04 直调 config_update 的
/// wire 形状——camelCase 与既有 Tauri 命令面一致，跨端不造第二套 DTO；
/// credentialMode / endpoint / stream 不在 R1-04 直调面（config store
/// 私有写面），请求带出 → cmd.denied）
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdateParams {
    /// 引擎 base URL（非敏感）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// 生效模型名（非敏感）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 凭据模式（R1-04 拒绝字段）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_mode: Option<String>,
    /// provider 端点（R1-04 拒绝字段）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// 流式开关（R1-04 拒绝字段）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
}

/// 服务命令后端（纯 trait，供 axum handler 委托）
// R1-02 备注：实现方 = R1-03/04 CoreStateBackend——dead_code 静音
// （测试构建以 MockBackend 全方法覆盖）
#[cfg_attr(not(test), allow(dead_code))]
#[async_trait::async_trait]
pub trait ApiBackend: Send + Sync {
    // ── F1 监控域只读面（C01-C10；R1-03 全量登记，M6 §4.1）──

    /// C01 状态查询（GET /v1/status；对应 core_get_status，D2 §8.2
    /// 「直透」：返回 CoreStatus 裁剪子集的 JSON——实现层负责 M6 C01
    /// 裁剪口径（logDir 不下发、lastError 只透 kind+detail），REST 层
    /// 原样透传）
    async fn get_status(&self) -> Result<serde_json::Value, ServerError>;

    /// C02 run 快照（GET /v1/runs/{id}/snapshot；对应
    /// core_get_run_snapshot；usage 无样本时置 null，状态字面量透传）
    async fn get_run_snapshot(
        &self,
        params: RunSnapshotParams,
    ) -> Result<RunSnapshotResult, ServerError>;

    /// C03 会话事件分页（GET /v1/sessions/{id}/events；对应
    /// core_read_session_events，游标语义与 WS 续传重放同契约——
    /// afterSequence 开区间 + maxEvents，返回 EventPage）
    async fn read_session_events(
        &self,
        params: EventPageParams,
    ) -> Result<EventPageResult, ServerError>;

    /// C04 run 事件分页（GET /v1/runs/{id}/events；对应
    /// core_read_run_events；run 事件 = 会话事件按 runId 过滤的子集；
    /// 缺省 = 未接线 internal——CoreStateBackend 覆盖为真实直调）
    async fn read_run_events(
        &self,
        _params: RunEventsParams,
    ) -> Result<EventPageResult, ServerError> {
        Err(ServerError::internal(
            "read_run_events 未接线（CoreStateBackend 由 R1-04 注入）",
        ))
    }

    /// C05 会话列表（GET /v1/sessions；对应 list_sessions；
    /// includeLastMessage 预览截断 80 字符）
    async fn list_sessions(
        &self,
        params: ListSessionsParams,
    ) -> Result<ListSessionsResult, ServerError>;

    /// C06 后台任务列表（GET /v1/tasks；对应
    /// workbench_list_background_tasks；gui 面白名单特批，M6 §4.1.6；
    /// 缺省 = 未接线 internal——CoreStateBackend 覆盖为真实直调）
    async fn list_background_tasks(
        &self,
        _params: ListTasksParams,
    ) -> Result<ListTasksResult, ServerError> {
        Err(ServerError::internal(
            "list_background_tasks 未接线（CoreStateBackend 由 R1-04 注入）",
        ))
    }

    /// C07 任务输出补取（GET /v1/tasks/{id}/output；对应
    /// workbench_get_background_task_output；afterLine 偏移分页；
    /// 缺省 = 未接线 internal——CoreStateBackend 覆盖为真实直调）
    async fn get_task_output(
        &self,
        _params: TaskOutputParams,
    ) -> Result<TaskOutputResult, ServerError> {
        Err(ServerError::internal(
            "get_task_output 未接线（CoreStateBackend 由 R1-04 注入）",
        ))
    }

    /// C08 子代理 DAG 概览（GET /v1/sessions/{id}/flow；对应
    /// get_flow_snapshot；完整消息树不下发，仅行投影；
    /// 缺省 = 未接线 internal——CoreStateBackend 覆盖为真实直调）
    async fn get_flow_snapshot(
        &self,
        _params: FlowSnapshotParams,
    ) -> Result<FlowSnapshotResult, ServerError> {
        Err(ServerError::internal(
            "get_flow_snapshot 未接线（CoreStateBackend 由 R1-04 注入）",
        ))
    }

    /// C09 命令清单（GET /v1/commands；对应 core_list_commands，manifest
    /// 原样透传——移动端动态发现能力面）
    async fn list_commands(&self) -> Result<ListCommandsResult, ServerError>;

    /// C10 搜索索引就绪状态（GET /v1/search/index；对应 core_search_files
    /// 的 ready/state 子集；全文搜索不暴露，M6 §4.1.10 / AU1 P2-12；
    /// 缺省 = 未接线 internal——CoreStateBackend 覆盖为真实直调）
    async fn get_search_index(&self) -> Result<SearchIndexResult, ServerError> {
        Err(ServerError::internal(
            "get_search_index 未接线（CoreStateBackend 由 R1-04 注入）",
        ))
    }

    // ── F5 会话域 / F2 审批域写面（R1-04 接线；此处仅登记契约）──

    /// 发起 run（POST /v1/runs；对应 run_task_impl；runId 桌面生成，
    /// sessionId 缺省 = 新建会话，M6 C24）
    async fn run_task(&self, params: RunTaskParams) -> Result<RunTaskResult, ServerError>;

    /// run 控制（POST /v1/runs/{id}/control；对应 run_control_impl，
    /// L0 继续 / L1 软注入 / L2 协作停止 / L3 强制取消）
    async fn run_control(&self, params: RunControlParams) -> Result<RunControlResult, ServerError>;

    /// 取消 run（POST /v1/runs/{id}/cancel；对应 cancel_run_impl；
    /// 重复取消无副作用——终态拒绝幂等，M6 C26）
    async fn cancel_run(&self, params: CancelRunParams) -> Result<CancelRunResult, ServerError>;

    /// 审批批准（POST /v1/approval/{toolCallId}/approve；对应
    /// approve_tool_impl；I-02 防伪造不变——toolCallId 为真键，runId
    /// 缺失按待审批集合反查；重复决策 → cmd.approval_mismatch 409）
    async fn approve(&self, params: ApproveParams) -> Result<ApproveResult, ServerError>;

    /// 审批拒绝（POST /v1/approval/{toolCallId}/deny；对应 deny_tool_impl；
    /// reason ≤256 字符，缺省 "user denied"）
    async fn deny(&self, params: DenyParams) -> Result<ApproveResult, ServerError>;

    /// C13 待审批对账（GET /v1/approvals/pending；活动 run 审批门待审批
    /// 集合快照——「已请求未裁决」实时真源；after_sequence 增量水位为
    /// wire 层扩展，缺省 = 全量对账；
    /// 缺省 = 未接线 internal——CoreStateBackend 覆盖为真实直调）
    async fn list_pending_approvals(
        &self,
        _params: ListPendingApprovalsParams,
    ) -> Result<ListPendingApprovalsResult, ServerError> {
        Err(ServerError::internal(
            "list_pending_approvals 未接线（CoreStateBackend 由 R1-04 注入）",
        ))
    }

    /// C14 审批历史（GET /v1/approvals/history；approval-resolved 事件
    /// 白名单投影，按 sequence 水位补拉；
    /// 缺省 = 未接线 internal——CoreStateBackend 覆盖为真实直调）
    async fn approval_history(
        &self,
        _params: ApprovalHistoryParams,
    ) -> Result<ApprovalHistoryResult, ServerError> {
        Err(ServerError::internal(
            "approval_history 未接线（CoreStateBackend 由 R1-04 注入）",
        ))
    }

    /// C28 设置脱敏快照（GET /v1/settings；config_get 直透——apiKey 恒
    /// 空串 + last4；keys 子集过滤；
    /// 缺省 = 未接线 internal——CoreStateBackend 覆盖为真实直调）
    async fn settings_get(
        &self,
        _params: GetSettingsParams,
    ) -> Result<GetSettingsResult, ServerError> {
        Err(ServerError::internal(
            "settings_get 未接线（CoreStateBackend 由 R1-04 注入）",
        ))
    }

    /// C29 非敏感配置更新（PUT /v1/settings；config_update 同语义；
    /// credentialMode / endpoint / stream 明确拒绝；
    /// 缺省 = 未接线 internal——CoreStateBackend 覆盖为真实直调）
    async fn settings_set(
        &self,
        _params: SettingsUpdateParams,
    ) -> Result<GetSettingsResult, ServerError> {
        Err(ServerError::internal(
            "settings_set 未接线（CoreStateBackend 由 R1-04 注入）",
        ))
    }

    // ── R2-12c 新增面：F4 文件域 C21/C22 + F6 设置域 C30/C31 ──

    /// C21 递归文件名搜索（GET /v1/search/files；对应引擎
    /// core_search_files 搜索逻辑——共享搜索索引 + conex-search 模糊
    /// 匹配，结果钳制 100 条；
    /// 缺省 = 未接线 internal——CoreStateBackend 覆盖为真实直调
    /// （需装配面注入 SharedSearchState + 工作区根））
    async fn search_files(
        &self,
        _params: SearchFilesParams,
    ) -> Result<SearchFilesResult, ServerError> {
        Err(ServerError::internal(
            "search_files 未接线（CoreStateBackend 由 R2-12c 注入；需装配面注入搜索索引）",
        ))
    }

    /// C22 资源 URL（GET /v1/assets/url；F4 §5.4 HTTP 资源代理 +
    /// 10 分钟令牌未实现——命令面占位：恒 501 cmd.unknown 诚实降级
    /// （开放问题 14.4-4 网络域评审后接线）；本缺省即占位语义，各实现
    /// 方默认继承）
    async fn asset_url(&self, _params: AssetUrlParams) -> Result<AssetUrlResult, ServerError> {
        Err(ServerError::protocol(
            DeviceErrorCode::CmdUnknown,
            "资源 URL 代理未实现（F4 §5.4：HTTP 资源代理 + 10 分钟令牌；开放问题 14.4-4 评审后接线）",
        ))
    }

    /// C30 桌面确认请求回执（POST /v1/settings/confirm；R1-04 直调面
    /// 无确认通道（D-13）——query → expired / withdraw → withdrawn
    /// 幂等回执；
    /// 缺省 = 未接线 internal——CoreStateBackend 覆盖为真实回执）
    async fn settings_confirm(
        &self,
        _params: SettingsConfirmParams,
    ) -> Result<SettingsConfirmResult, ServerError> {
        Err(ServerError::internal(
            "settings_confirm 未接线（CoreStateBackend 由 R2-12c 注入）",
        ))
    }

    /// C31 暂停定时自动执行（POST /v1/settings/pause-automation；直调
    /// SchedulerRegistry 暂停开关——一次性指令不改变持久化配置；
    /// 缺省 = 未接线 internal——CoreStateBackend 覆盖为真实直调）
    async fn pause_automation(
        &self,
        _params: PauseAutomationParams,
    ) -> Result<PauseAutomationResult, ServerError> {
        Err(ServerError::internal(
            "pause_automation 未接线（CoreStateBackend 由 R2-12c 注入）",
        ))
    }

    // ── F4 文件域读命令（移动端伴侣必需；写面不暴露）──

    /// C16 目录列表（path 相对活动工作区根；workspaceRoot 缺省 = 活动根）
    async fn list_dir(&self, _params: ListDirParams) -> Result<ListDirResult, ServerError> {
        Err(ServerError::internal(
            "list_dir 未接线（需要装配 WorkspaceOps）",
        ))
    }

    /// C17 文本文件预览（≤1MB / 行数上限）
    async fn read_file(&self, _params: ReadFileParams) -> Result<ReadFileResult, ServerError> {
        Err(ServerError::internal(
            "read_file 未接线（需要装配 WorkspaceOps）",
        ))
    }

    /// C19 已授权工作区列表
    async fn list_workspaces(
        &self,
        _params: ListWorkspacesParams,
    ) -> Result<ListWorkspacesResult, ServerError> {
        Err(ServerError::internal(
            "list_workspaces 未接线（需要装配 WorkspaceOps）",
        ))
    }

    /// C20 切换活动工作区（只允许已授权根）
    async fn switch_workspace(
        &self,
        _params: SwitchWorkspaceParams,
    ) -> Result<SwitchWorkspaceResult, ServerError> {
        Err(ServerError::internal(
            "switch_workspace 未接线（需要装配 WorkspaceOps）",
        ))
    }

    /// C38 可选模型列表 + 当前全局默认（G2/W-B；桌面统一模型树投影）
    async fn list_models(
        &self,
        _params: ListModelsParams,
    ) -> Result<ListModelsResult, ServerError> {
        Err(ServerError::internal(
            "list_models 未接线（需要装配 ModelsOps）",
        ))
    }

    /// C39 切换全局默认模型（G2/W-B；持久化到桌面同一真源并经同一
    /// 发布链通知桌面 UI 与引擎后续 run）
    async fn set_active_model(
        &self,
        _params: SetActiveModelParams,
    ) -> Result<SetActiveModelResult, ServerError> {
        Err(ServerError::internal(
            "set_active_model 未接线（需要装配 ModelsOps）",
        ))
    }

    /// C40 会话改名（G3；宿主按桌面标题规范化同口径清洗后落库）
    async fn rename_session(&self, _params: RenameSessionParams) -> Result<OkResult, ServerError> {
        Err(ServerError::internal(
            "rename_session 未接线（需要装配 SessionsOps）",
        ))
    }

    /// C41 置顶/取消置顶（G3；is_pinned 定向写，幂等）
    async fn set_session_pinned(
        &self,
        _params: SetSessionPinnedParams,
    ) -> Result<OkResult, ServerError> {
        Err(ServerError::internal(
            "set_session_pinned 未接线（需要装配 SessionsOps）",
        ))
    }

    /// C42 归档/取消归档（G3；is_archived 定向写，幂等）
    async fn set_session_archived(
        &self,
        _params: SetSessionArchivedParams,
    ) -> Result<OkResult, ServerError> {
        Err(ServerError::internal(
            "set_session_archived 未接线（需要装配 SessionsOps）",
        ))
    }

    /// C43 删除会话（G3；真删 + 产出进回收站，守卫与桌面孤儿清理豁免同源）
    async fn delete_session(&self, _params: DeleteSessionParams) -> Result<OkResult, ServerError> {
        Err(ServerError::internal(
            "delete_session 未接线（需要装配 SessionsOps）",
        ))
    }

    /// C44 技能目录列表（G7；宿主技能发现投影，只读——启停在桌面端管理）
    async fn list_skills(
        &self,
        _params: ListSkillsParams,
    ) -> Result<ListSkillsResult, ServerError> {
        Err(ServerError::internal(
            "list_skills 未接线（需要装配 SkillsOps）",
        ))
    }

    /// 跨端命令通用分发（WS `remote.<cmd>` / REST 共用；命令名 = 白名单后缀）。
    /// 默认实现覆盖全部已接线命令；未登记命令返回 `cmd.unknown`。
    async fn dispatch_remote_command(
        &self,
        cmd: &str,
        params: Value,
    ) -> Result<Value, ServerError> {
        fn parse<T: serde::de::DeserializeOwned>(
            value: Value,
            name: &str,
        ) -> Result<T, ServerError> {
            serde_json::from_value(value).map_err(|error| {
                ServerError::protocol(
                    DeviceErrorCode::CmdInvalid,
                    format!("{name} 参数非法：{error}"),
                )
            })
        }
        fn encode<T: serde::Serialize>(value: T, name: &str) -> Result<Value, ServerError> {
            serde_json::to_value(value)
                .map_err(|error| ServerError::internal(format!("{name} 序列化失败：{error}")))
        }

        match cmd {
            "getStatus" => self.get_status().await,
            "getRunSnapshot" => {
                let result = self.get_run_snapshot(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "readSessionEvents" => {
                let result = self.read_session_events(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "readRunEvents" => {
                let result = self.read_run_events(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "listSessions" => {
                let result = self.list_sessions(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "listBackgroundTasks" => {
                let result = self.list_background_tasks(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "getTaskOutput" => {
                let result = self.get_task_output(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "getFlowSnapshot" => {
                let result = self.get_flow_snapshot(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "listCommands" => {
                let result = self.list_commands().await?;
                encode(result, cmd)
            }
            "getSearchIndex" => {
                let result = self.get_search_index().await?;
                encode(result, cmd)
            }
            "runTask" => {
                let result = self.run_task(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "runControl" => {
                let result = self.run_control(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "cancelRun" => {
                let result = self.cancel_run(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "approve" => {
                let result = self.approve(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "deny" => {
                let result = self.deny(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "listPendingApprovals" => {
                let result = self.list_pending_approvals(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "approvalHistory" => {
                let result = self.approval_history(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "getSettings" => {
                let result = self.settings_get(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "searchFiles" => {
                let result = self.search_files(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "listDir" => {
                let result = self.list_dir(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "readFile" => {
                let result = self.read_file(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "listWorkspaces" => {
                let result = self.list_workspaces(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "switchWorkspace" => {
                let result = self.switch_workspace(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "listModels" => {
                let result = self.list_models(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "setActiveModel" => {
                let result = self.set_active_model(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "renameSession" => {
                let result = self.rename_session(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "setSessionPinned" => {
                let result = self.set_session_pinned(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "setSessionArchived" => {
                let result = self.set_session_archived(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "deleteSession" => {
                let result = self.delete_session(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "listSkills" => {
                let result = self.list_skills(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "settingsConfirm" => {
                let result = self.settings_confirm(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            "pauseAutomation" => {
                let result = self.pause_automation(parse(params, cmd)?).await?;
                encode(result, cmd)
            }
            other => Err(ServerError::protocol(
                DeviceErrorCode::CmdUnknown,
                format!("Unsupported remote command: {other}"),
            )),
        }
    }
}
