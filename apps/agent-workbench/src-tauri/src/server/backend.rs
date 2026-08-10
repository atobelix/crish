//! 服务层与核心命令的桥接契约（D2 §4.3「ApiBackend trait」）
//!
//! - **纯 trait**：只依赖 conex-types / serde / [ServerError]，不引用任何
//!   crate:: 内部模块——router 测试可经 #[path] 独立编译挂内存后端全量
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

use conex_types::device::commands::{TaskOutputParams, TaskOutputResult};
use conex_types::device::{
    ApprovalHistoryParams, ApprovalHistoryResult, ApproveParams, ApproveResult, CancelRunParams,
    CancelRunResult, DenyParams, EventPageParams, EventPageResult, FlowSnapshotParams,
    FlowSnapshotResult, GetSettingsParams, GetSettingsResult, ListCommandsResult,
    ListPendingApprovalsParams, ListPendingApprovalsResult, ListSessionsParams, ListSessionsResult,
    ListTasksParams, ListTasksResult, RunControlParams, RunControlResult, RunEventsParams,
    RunSnapshotParams, RunSnapshotResult, RunTaskParams, RunTaskResult, SearchIndexResult,
};

use crate::server::ServerError;

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
}
