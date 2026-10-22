use serde::{Deserialize, Serialize};

use super::enums::{PageDirection, StatusInclude};
use crate::device::version::ManifestEntry;

// ── F1 监控域：参数与响应 ──

/// C01 参数（全可选；include 指定聚合项）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusQuery {
    /// 需要聚合的卡片项
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<Vec<StatusInclude>>,
}

/// C01 响应（裁剪自 CoreStatus；logDir 默认不下发）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    /// 核心状态已初始化
    pub initialized: bool,
    /// 应用版本
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 引擎就绪
    pub engine_ready: bool,
    /// 数据库就绪
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_ready: Option<bool>,
    /// 搜索索引就绪
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_index_ready: Option<bool>,
    /// 压缩就绪
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_ready: Option<bool>,
    /// provider 状态（hasApiKey/model/credentialMode）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_status: Option<serde_json::Value>,
    /// 日志级别
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
    /// 环形诊断（≤20 条）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Vec<serde_json::Value>>,
    /// 最近错误（仅透传 kind + detail）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<serde_json::Value>,
    /// 恢复状态
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore: Option<serde_json::Value>,
    /// 后台任务摘要
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_tasks: Option<serde_json::Value>,
    /// 活跃 run 列表
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_runs: Option<Vec<serde_json::Value>>,
    /// 待审批列表
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_approvals: Option<Vec<serde_json::Value>>,
}

/// C02 参数
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshotParams {
    /// run id
    pub run_id: String,
    /// 会话 id（可选，供校验）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// C02 响应（snapshot = RunSnapshot 裁剪子集）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshotResult {
    /// run 快照（status/cursor/usage 等）
    pub snapshot: serde_json::Value,
}

/// C03 参数（同步面主查询；断线续传 events.resume 的 body 为本类型子集）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPageParams {
    /// 会话 id
    pub session_id: String,
    /// 开区间游标（缺省 0 = 从会话头拉取）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_sequence: Option<u64>,
    /// 页大小（缺省 200，上限 1000）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_events: Option<u32>,
    /// 分页方向（缺省 forward）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<PageDirection>,
}

/// C04 参数
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventsParams {
    /// run id
    pub run_id: String,
    /// 会话 id（可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 开区间游标
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_sequence: Option<u64>,
    /// 页大小
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_events: Option<u32>,
}

/// C03/C04 响应（EventPage 契约；D3 §7.5）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPageResult {
    /// 裁剪后扁平事件 JSON 列表
    pub events: Vec<serde_json::Value>,
    /// 下一续传游标
    pub next_after_sequence: u64,
    /// 是否还有更多
    pub has_more: bool,
    /// 服务端该会话当前 max（游标推进判断）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_sequence: Option<u64>,
}

/// C05 参数
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsParams {
    /// 携带 ≤80 字符最后消息预览
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_last_message: Option<bool>,
}

/// C05 响应（索引条目 = SessionIndexEntry 原样）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsResult {
    /// 会话索引条目（≤1000）
    pub sessions: Vec<crate::SessionIndexEntry>,
}

/// C06 参数（空）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksParams {}

/// C06 响应（任务摘要；不携带输出内容）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksResult {
    /// 任务摘要列表（含已结束任务）
    pub tasks: Vec<serde_json::Value>,
}

/// C07 参数（任务输出补取）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutputParams {
    /// 任务 id
    pub task_id: String,
    /// 行数上限（缺省 200，上限 1000）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_lines: Option<u32>,
    /// 从第 N 行继续取
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_line: Option<u64>,
}

/// C07 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutputResult {
    /// 输出行（单行 ≤5000 字符）
    pub lines: Vec<String>,
    /// 是否截断
    pub truncated: bool,
    /// 累计行数
    pub line_count: u64,
    /// 下一行游标
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_after_line: Option<u64>,
    /// 是否还有更多
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_more: Option<bool>,
}

/// C08 参数
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSnapshotParams {
    /// 会话 id
    pub session_id: String,
}

/// C08 响应（flow = 子代理 DAG 概览；完整消息树不下发）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSnapshotResult {
    /// 流程快照（flowDeclaration/flowState/agents 行投影）
    pub flow: serde_json::Value,
}

/// C09 参数（空）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCommandsParams {}

/// C09 响应（能力发现；manifest 原样透传）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCommandsResult {
    /// 命令清单契约版本（semver）
    pub contract_version: String,
    /// 命令条目
    pub commands: Vec<ManifestEntry>,
}

/// C10 参数（空）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexParams {}

/// C10 响应（仅索引就绪状态；全文搜索不暴露）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexResult {
    /// 索引就绪
    pub ready: bool,
    /// 索引状态（totalFiles/lastBuiltAt 等）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<serde_json::Value>,
}
