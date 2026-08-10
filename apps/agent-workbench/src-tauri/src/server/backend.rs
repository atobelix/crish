//! 服务层与核心命令的桥接契约（D2 §4.3「ApiBackend trait」）
//!
//! - **纯 trait**：只依赖 conex-types / serde / [ServerError]，不引用任何
//!   crate:: 内部模块——router 测试可经 #[path] 独立编译挂内存后端全量
//!   驱动（D2 §13 测试隔离关键）；
//! - **命令体直调**：R1-03/04 的 `CoreStateBackend` 实现本 trait，方法内
//!   直调既有 `*_impl` 契约体（`run_task_impl` / `run_control_impl` /
//!   `core_cancel_run` / `core_approve_tool` / `core_deny_tool` /
//!   `core_query_commands` 查询面等，均为「测试可直调、不依赖 Tauri
//!   runtime」的实现函数，core_run_commands.rs:3062 / :3640）；
//! - 方法签名以 conex-types `device/commands.rs` 的跨端命令类型为准
//!   （M6 §4 各域命令），入参转换（如 `RunTaskParams` → 壳侧
//!   `RunTaskOptions`）与 CoreError 映射在实现层完成；
//! - 骨架期登记 R1 REST T1 面（只读 + run 控制 + 审批）；R1-03/04 按
//!   暴露分级表增补。

use conex_types::device::{
    ApproveParams, ApproveResult, CancelRunParams, CancelRunResult, EventPageParams,
    EventPageResult, ListCommandsResult, ListSessionsParams, ListSessionsResult,
    RunControlParams, RunControlResult, RunSnapshotParams, RunSnapshotResult,
    RunTaskParams, RunTaskResult,
};

use crate::server::ServerError;

/// 服务命令后端（纯 trait，供 axum handler 委托）
// R1-02 备注：实现方 = R1-03/04 CoreStateBackend——dead_code 静音
// （测试构建以 MockBackend 全方法覆盖）
#[cfg_attr(not(test), allow(dead_code))]
#[async_trait::async_trait]
pub trait ApiBackend: Send + Sync {
    /// 状态查询（GET /v1/status；对应 core_get_status）
    async fn get_status(&self) -> Result<serde_json::Value, ServerError>;

    /// 发起 run（POST /v1/runs；对应 run_task_impl）
    async fn run_task(&self, params: RunTaskParams) -> Result<RunTaskResult, ServerError>;

    /// run 控制（POST /v1/runs/{id}/control；对应 run_control_impl，
    /// L0 继续 / L1 软注入 / L2 协作停止 / L3 强制取消）
    async fn run_control(&self, params: RunControlParams) -> Result<RunControlResult, ServerError>;

    /// 取消 run（POST /v1/runs/{id}/cancel；对应 core_cancel_run）
    async fn cancel_run(&self, params: CancelRunParams) -> Result<CancelRunResult, ServerError>;

    /// 审批批准（POST /v1/runs/{id}/approve；对应 core_approve_tool；
    /// I-02 防伪造不变——toolCallId 为真键）
    async fn approve(&self, params: ApproveParams) -> Result<ApproveResult, ServerError>;

    /// 审批拒绝（POST /v1/runs/{id}/deny；对应 core_deny_tool）
    async fn deny(&self, params: ApproveParams) -> Result<ApproveResult, ServerError>;

    /// 会话列表（GET /v1/sessions；对应 list_sessions）
    async fn list_sessions(
        &self,
        params: ListSessionsParams,
    ) -> Result<ListSessionsResult, ServerError>;

    /// 事件分页（GET /v1/sessions/{id}/events；对应
    /// core_read_session_events，游标语义与 WS 续传重放同契约）
    async fn read_session_events(
        &self,
        params: EventPageParams,
    ) -> Result<EventPageResult, ServerError>;

    /// run 快照（GET /v1/runs/{id}/snapshot；对应 core_get_run_snapshot）
    async fn get_run_snapshot(
        &self,
        params: RunSnapshotParams,
    ) -> Result<RunSnapshotResult, ServerError>;

    /// 命令清单（GET /v1/commands；对应 core_list_commands，manifest
    /// 原样透传——移动端动态发现能力面）
    async fn list_commands(&self) -> Result<ListCommandsResult, ServerError>;
}
