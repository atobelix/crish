//! 事件域公共载荷与枚举（字段语义以 `contracts/engine-events.json` 为准）。

use serde::{Deserialize, Serialize};

/// run 终态（03 §5.1-11：'completed'|'cancelled'|'failed'，前端 zod 拼写
/// 兼容分支依赖 Rust 只发规范值，03 §5.3-3）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunTerminalStatus {
    /// 正常完成
    Completed,
    /// 用户取消
    Cancelled,
    /// 失败
    Failed,
}

/// 时间线截断原因（`timeline-truncate.reason`，事件域 retraction；wire kebab-case）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TimelineTruncateReason {
    /// 用户 UI 主动撤回
    UserRequested,
    /// 错误回滚触发的截断（扩展点 D 预留）
    ErrorRollback,
}

/// 审计操作类别（`security-audit.operation`，wire kebab-case）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecurityAuditOperation {
    /// 删除（delete_file / delete_dir / shell 删除形态重定向）
    Delete,
    /// 回收站条目恢复（trash_restore）
    TrashRestore,
    /// 回收站条目彻底清除（trash_purge）
    TrashPurge,
    /// git 回退（git-revert 形态，预留供 S6 面积审计）
    GitRevert,
    /// 命令执行（command-exec 形态，红线拦截等）
    CommandExec,
    /// 未声明写入（工具外写文件：脚本逃逸监视判定出的未声明变更）
    #[serde(rename = "undeclared-write")]
    UndeclaredWrite,
    /// 远程来源触达被禁命令面
    #[serde(rename = "remote-source-attempt")]
    RemoteSourceAttempt,
    /// 远程 run 权限模式降级
    #[serde(rename = "remote-mode-downgrade")]
    RemoteModeDowngrade,
    /// 远程单一确认
    #[serde(rename = "remote-only")]
    RemoteOnly,
}

/// 审计处置决策（`security-audit.decision`，wire lowercase）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecurityAuditDecision {
    /// 被红线/形态拦截（未执行）
    Blocked,
    /// 已批准执行
    Approved,
    /// 直接放行执行
    Allowed,
    /// 被拒绝
    Denied,
    /// 已重定向到删除接管接口（未物理删除，可恢复）
    Redirected,
    /// 回收站条目已恢复
    Restored,
    /// 回收站条目已彻底清除
    Purged,
}

/// 工具元数据（审批请求附带）
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_read_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fatal_on_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<String>,
}

/// 子代理事件类别（`subagent-event.event.kind`，wire kebab-case）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SubagentEventKind {
    /// 进度增量（背压 Delta 级：可丢不落库）
    Progress,
    /// 消息（背压 Soft 级：尽力投递，可丢弃重发）
    Message,
    /// 工具活动（背压 Soft 级：尽力投递）
    Tool,
}

/// 子代理事件结构化负载（`subagent-event.event`）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubagentEventPayload {
    /// 事件类别（progress/message/tool）
    pub kind: SubagentEventKind,
    /// 类别负载（progress 携带进度片段、message 携带消息、tool 携带工具摘要）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

/// 子代理终态（`subagent-ended.status`，wire lowercase）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentEndStatus {
    /// 正常完成
    Completed,
    /// 失败
    Failed,
    /// 被取消/终止（前端映射为 stopped 展示）
    Cancelled,
}

/// 事件背压级别（M7 三级分类）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackpressureLevel {
    /// 增量可丢
    Delta,
    /// 尽力投递
    Soft,
    /// 必达（落库不丢）
    Critical,
}

/// 持久化决策（与背压分级正交）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistenceDecision {
    /// 落库（EventQueue::push 同步等待 store 持久化）
    Persist,
    /// 不落库（增量/实时轨，不阻塞 drive loop）
    NoPersist,
}

/// 桥丢帧优先级（缓冲层水位语义）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropClass {
    /// 可丢（唯一：message-delta；message-end 全文兜底）
    Soft,
    /// 永不丢（terminal / 审批 / 工具 / message-end 等）
    Critical,
}

/// 单一事件策略：同一 match 产出三正交决策（背压 + 持久化 + 桥丢帧）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventPolicy {
    pub backpressure: BackpressureLevel,
    pub persist: PersistenceDecision,
    pub bridge_priority: DropClass,
}

impl EventPolicy {
    pub const fn new(
        backpressure: BackpressureLevel,
        persist: PersistenceDecision,
        bridge_priority: DropClass,
    ) -> Self {
        Self {
            backpressure,
            persist,
            bridge_priority,
        }
    }
}

/// 权限请求（approval-requested.request 载荷）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    pub session_id: String,
    pub cwd: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub parameters: serde_json::Value,
    pub summary: String,
    pub tool_metadata: ToolMetadata,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    /// 请求方 run 归属（None = 主 agent run；Some = 子代理 run id）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requester_run_id: Option<String>,
    /// 子代理申请理由（主 agent 裁决面展示与审计用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// approval-resolved 决策规范值（Rust 只发 approved|denied|expired）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalDecision {
    /// 已批准
    Approved,
    /// 已拒绝
    Denied,
    /// 已过期
    Expired,
}

/// run 级缓存统计（`RunOutcome.cache_stats` 与 `cache-stats-updated.stats` 共用）
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCacheStats {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_miss_tokens: u64,
    /// 有真实 usage 的 turn 数（0 = 无样本）
    pub sample_count: u64,
    /// 命中率 = cache_read / input_total（input_total == 0 → None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hit_ratio: Option<f64>,
    /// 写入占比 = cache_write / input_total
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_ratio: Option<f64>,
    /// 本 run 审计出的浪费量（detectMiss 累计）
    pub missed_tokens: u64,
    /// 缓存温暖截止（now + ttl_for(provider, model)）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warm_until_ms: Option<u64>,
}

/// 缓存 miss 归因分类（wire kebab-case）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MissAttribution {
    /// 基线模型 ≠ 当前模型
    ModelSwitch,
    /// 基线代数内发生过压缩
    Compaction,
    /// 签名对比：system/tools/messages 哈希变化
    PrefixChanged,
    /// idleMs ≥ ttl_for(provider, model)
    IdleTtlExpired,
    /// 无基线 / 跨会话（正常首次）
    Cold,
    /// 报告过缓存但本轮 read == 0
    ZeroRead,
    /// 命中率低于阈值且不属于上述类
    LowRead,
    /// 无法归类（兜底）
    Unknown,
}

/// 单轮 usage 载荷（`turn-end.usage` 可选字段）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_miss_tokens: u64,
}
