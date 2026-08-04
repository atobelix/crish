//! 域事件契约（Rust enum 为双端唯一事实源）
//!
//! [AgentEvent] 是 31 种域事件的 serde tagged enum（顶层 `type`），全部字段
//! serde camelCase，字段结构以 03-frontend-contract.md §1.1-1.6 清单与 §5.1
//! 硬依赖表为准。机器可读导出见 contracts/engine-events.json（事件注册表），
//! 前端 TS 类型与解析器由 scripts/generate-engine-bindings.mjs 生成，落点
//! packages/shared-types/src/generated/engine/**；注册表与 enum 的一致性由
//! tests/registry_drift.rs 锁定——新增/变更事件必须同步注册表与生成产物。
//!
//! 顶层 `runId` / `sequence` / `schemaVersion` 不在事件体内，由 emit 层统一
//! 注入（03 §5.1-2/3、§5.3-2；schemaVersion 见 PE-03 T03.10 / PE-12 T12.5，
//! 演进登记在 docs/rust-rewrite/33-event-schema-changelog.md）：见 [AgentEventEnvelope]。

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::impact::ImpactAssessment;
use crate::message::{AgentMessage, AgentMessageBlock};
use crate::session::AgentEndReason;
use crate::tool::{
    ContextCompressionRecord, ProviderDiagnostic, RuntimeCheckpointRecord,
    RuntimeCheckpointRestoreRecord, ToolBatchCall, ToolBatchResult, ToolProgressUpdate,
};

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

/// 审批放行行为（wire 值为 allow/deny/ask，lowercase）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionBehavior {
    /// 允许
    Allow,
    /// 拒绝
    Deny,
    /// 询问
    Ask,
}

/// 审批决策（behavior 携带放行行为；reason/metadata 可选）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub behavior: PermissionBehavior,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

// ── 安全审计域（I2-S8：高危操作审计事件 payload 枚举）──

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
    /// 未声明写入（T-ESC-02：工具外写文件——脚本逃逸监视判定出的
    /// 未声明变更；decision 取 Denied 语义：非引擎批准路径的操作。
    /// 事件体结构零改动，targets 承载变更路径、impact.file_count 承载
    /// 聚合数，见 REQ-逃逸追踪分析 §3.2）
    #[serde(rename = "undeclared-write")]
    UndeclaredWrite,
}

/// 审计处置决策（`security-audit.decision`，wire lowercase）
///
/// 覆盖任务卡两组取值：删除接管/重定向（redirected）、红线与形态拦截
/// （blocked）、审批三态（approved/denied）、恢复动作（restored/purged）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecurityAuditDecision {
    /// 被红线/形态拦截（未执行）
    Blocked,
    /// 已批准执行
    Approved,
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

// ── 子代理域（I5-M7：C8 事件契约；Rust 侧三事件产出）──

/// 子代理事件类别（`subagent-event.event.kind`，wire kebab-case）
///
/// 背压分级随类别走（04 报告 1e）：progress 为 Delta 级可丢增量，
/// message/tool 为 Soft 级尽力投递（分类入事件注册表 kindBackpressure，
/// registry_drift 护栏锁定）。
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

/// 子代理事件结构化负载（`subagent-event.event`，前端 subagentHandlers.ts:38-42
/// 把整个 event 对象透传给 onSubagentEvent 回调）
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
///
/// 与前端 status 判定正则对齐（subagentHandlers.ts:50-56）：cancel/stop/abort
/// → stopped、fail/error → failed、其余 → completed。Rust 只发规范值
/// completed/failed/cancelled（cancelled 命中前端 /cancel/ 分支映射为 stopped
/// 展示），不产生 stopped 值（M2 状态映射：stopped 仅保留为 legacy 展示字段）。
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

/// 事件背压级别（M7 三级分类，04 报告 1e「Delta→Soft→Critical，delta 可丢、
/// terminal 必达」落地；先例：buffer.rs DropClass 两级——非 delta 全 Critical）
///
/// - [BackpressureLevel::Delta]：增量可丢（message-delta、subagent-event 的
///   progress 类），非持久化不阻塞 drive loop；
/// - [BackpressureLevel::Soft]：尽力投递（subagent-event 的 message/tool 类），
///   可丢弃重发；
/// - [BackpressureLevel::Critical]：必达（subagent-started/subagent-ended、
///   终态、审批、审计等），落库不丢。
///
/// 分类静态可判定（不许运行时拍脑袋）：写入事件注册表每事件 backpressure
/// 字段，registry_drift 护栏把本函数与注册表双向锁定。
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

/// 权限请求（approval-requested.request 载荷）
///
/// 前端硬依赖（03 §5.1-9）：`request.toolCallId` 与 `request.toolName`
/// 必填，`parameters` 为参数包（前端兼容 parameters/input 别名）。
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
}

/// approval-resolved 决策规范值（03 §5.3-3：Rust 只发
/// 'approved'|'denied'|'expired' 字符串；前端也兼容
/// {behavior: allow|deny|ask} 对象形态，C3.2 后由 ApprovalHandler 内联解析）
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

// ── 缓存测量域载荷（P5 S3 §3.1.2/§3.1.3 新增；仅测量展示，不干预循环）──

/// run 级缓存统计（P5 §3.1.2；`RunOutcome.cache_stats` 与
/// `cache-stats-updated.stats` 共用同一类型，T-36 tracker.finish() 产出）
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCacheStats {
    /// 输入 token（Included 系已含缓存；Excluded 系不含）
    pub prompt_tokens: u64,
    /// 输出 token
    pub completion_tokens: u64,
    /// 总 token
    pub total_tokens: u64,
    /// 缓存命中读取 token
    pub cache_read_tokens: u64,
    /// 缓存写入 token
    pub cache_write_tokens: u64,
    /// 未命中输入 token（服务端直报优先，否则按口径推导）
    pub cache_miss_tokens: u64,
    /// 有真实 usage 的 turn 数（0 = 无样本，前端隐藏而非显示 0%）
    pub sample_count: u64,
    /// 命中率 = cache_read / input_total（input_total == 0 → None，前端隐藏）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hit_ratio: Option<f64>,
    /// 写入占比 = cache_write / input_total
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_ratio: Option<f64>,
    /// 本 run 审计出的浪费量（detectMiss 累计）
    pub missed_tokens: u64,
    /// 缓存温暖截止（now + ttl_for(provider, model)）；前端据此驱动冷缓存预警
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warm_until_ms: Option<u64>,
}

/// 缓存 miss 归因分类（jcode 10 类收缩为 8 类；wire kebab-case，P5 §3.1.1）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MissAttribution {
    /// 基线模型 ≠ 当前模型（pi：不豁免，正常计费应计数）
    ModelSwitch,
    /// 基线代数内发生过压缩（P4 事件；重置后不计 miss，此为历史归因）
    Compaction,
    /// 签名对比：system/tools/messages 哈希变化（harness 自伤）
    PrefixChanged,
    /// idleMs ≥ ttl_for(provider, model)（P3 TTL 表）
    IdleTtlExpired,
    /// 无基线 / 跨会话（正常首次）
    Cold,
    /// 报告过缓存但本轮 read == 0（jcode ZeroRead）
    ZeroRead,
    /// 命中率低于阈值且不属于上述类（jcode LowRead）
    LowRead,
    /// 无法归类（兜底）
    Unknown,
}

/// 31 种域事件（tagged enum，双端契约唯一事实源）
///
/// 顶层 `type` 为事件名（kebab-case），事件字段全部 camelCase；
/// 字段清单与类型映射见 contracts/engine-events.json（事件注册表），
/// 前端 TS 由生成脚本产出（见模块文档）。
///
/// 跨进程序列化是主用途，事件按值短暂传递，变体间内存差异非热点，
/// 故不装箱（装箱会破坏调用方 API 形态），显式允许 large_enum_variant。
/// 例外：message-start / message-end 的正文载荷经 [Arc] 承载（PE-09 T09.3.2，
/// serde 对 `Arc<T>` 按 `T` 序列化，持久化 JSON **逐字节不变**）——对话与
/// 事件同享一份消息内存，消除 record_message 每消息 2 次全文深克隆（AA-06 P4）。
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum AgentEvent {
    // ── Agent 域（03 §1.1）──
    /// run 启动
    #[serde(rename = "agent-start", rename_all = "camelCase")]
    AgentStart {
        session_id: String,
        /// ISO8601 时间戳
        timestamp: String,
    },
    /// run 结束；reason 必填，error 可选（03 §5.1-12）
    #[serde(rename = "agent-end", rename_all = "camelCase")]
    AgentEnd {
        session_id: String,
        timestamp: String,
        reason: AgentEndReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },

    // ── Turn 域（03 §1.2）──
    /// 一轮开始
    #[serde(rename = "turn-start", rename_all = "camelCase")]
    TurnStart {
        session_id: String,
        turn_index: u32,
        timestamp: String,
    },
    /// 一轮结束（toolCallCount 供观测）
    #[serde(rename = "turn-end", rename_all = "camelCase")]
    TurnEnd {
        session_id: String,
        turn_index: u32,
        timestamp: String,
        tool_call_count: u32,
    },

    // ── Message 域（03 §1.3，前端强依赖）──
    /// 消息开始（水合投影以 message-end 为准；载荷 Arc 化，PE-09 T09.3.2）
    #[serde(rename = "message-start", rename_all = "camelCase")]
    MessageStart {
        session_id: String,
        message: Arc<AgentMessage>,
    },
    /// 增量正文/思考块（硬依赖 03 §5.1-4/5：block.text、messageId）
    #[serde(rename = "message-delta", rename_all = "camelCase")]
    MessageDelta {
        session_id: String,
        timestamp: String,
        message_id: String,
        block: AgentMessageBlock,
    },
    /// 消息终态全文（硬依赖 03 §5.1-6：message.role/content/blocks +
    /// clientMessageId 稳定 id；载荷 Arc 化，PE-09 T09.3.2）
    #[serde(rename = "message-end", rename_all = "camelCase")]
    MessageEnd {
        session_id: String,
        message: Arc<AgentMessage>,
    },

    // ── Tool 域（03 §1.4，前端强依赖）──
    /// 单工具调用开始（硬依赖 03 §5.1-7：call.id/toolName）
    #[serde(rename = "tool-start", rename_all = "camelCase")]
    ToolStart {
        session_id: String,
        batch_id: String,
        call: ToolBatchCall,
        timestamp: String,
    },
    /// 工具执行进度增量（预留：tool-args-delta 增量参数流）
    #[serde(rename = "tool-update", rename_all = "camelCase")]
    ToolUpdate {
        session_id: String,
        batch_id: String,
        tool_call_id: String,
        update: ToolProgressUpdate,
        timestamp: String,
    },
    /// 单工具调用结束（硬依赖 03 §5.1-8：result.id/toolCallId/output/isError）
    #[serde(rename = "tool-end", rename_all = "camelCase")]
    ToolEnd {
        session_id: String,
        batch_id: String,
        result: ToolBatchResult,
        timestamp: String,
    },
    /// 工具批量开始（前端显式 ignore）
    #[serde(rename = "tool-batch-start", rename_all = "camelCase")]
    ToolBatchStart {
        session_id: String,
        batch_id: String,
        timestamp: String,
        summary: String,
        calls: Vec<ToolBatchCall>,
    },
    /// 工具批量结束（前端显式 ignore）
    #[serde(rename = "tool-batch-end", rename_all = "camelCase")]
    ToolBatchEnd {
        session_id: String,
        batch_id: String,
        timestamp: String,
        calls: Vec<ToolBatchResult>,
    },
    /// 工具入参修复记录（validation/repair 流程）
    #[serde(rename = "tool-input-repaired", rename_all = "camelCase")]
    ToolInputRepaired {
        session_id: String,
        timestamp: String,
        tool_call_id: String,
        tool_name: String,
        notes: Vec<String>,
    },

    // ── 压缩域（03 §1.6）──
    /// 上下文压缩开始
    #[serde(rename = "context-compression-start", rename_all = "camelCase")]
    ContextCompressionStart {
        session_id: String,
        timestamp: String,
        reason: String,
        tokens_before: u64,
    },
    /// 上下文压缩结束（aborted 标志；error 可选）
    #[serde(rename = "context-compression-end", rename_all = "camelCase")]
    ContextCompressionEnd {
        session_id: String,
        timestamp: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<ContextCompressionRecord>,
        aborted: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },

    // ── 诊断/审批/检查点域（03 §1.5-1.6）──
    /// provider 运行诊断（前端仅 logInternalError）
    #[serde(rename = "provider-diagnostic", rename_all = "camelCase")]
    ProviderDiagnostic {
        session_id: String,
        timestamp: String,
        diagnostic: ProviderDiagnostic,
    },
    /// 运行期观测性错误（不直接 finish，等 run-terminal/agent-end 收口；
    /// retryable 只表「可重试」，与收场 reason 正交，01 §五.10）
    #[serde(rename = "runtime-error", rename_all = "camelCase")]
    RuntimeError {
        session_id: String,
        timestamp: String,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retryable: Option<bool>,
    },
    /// steering 注入/诊断消息
    #[serde(rename = "runtime-steering", rename_all = "camelCase")]
    RuntimeSteering {
        session_id: String,
        timestamp: String,
        reason: String,
        message: AgentMessage,
    },
    /// 需人工介入（choices 为候选动作；事件照发但 run 以 stop 收场，01 D9）
    #[serde(rename = "runtime-intervention-required", rename_all = "camelCase")]
    RuntimeInterventionRequired {
        session_id: String,
        timestamp: String,
        reason: String,
        choices: Vec<String>,
        message: String,
    },
    /// 审批请求（硬依赖 03 §5.1-9：request.toolCallId/toolName/parameters）
    #[serde(rename = "approval-requested", rename_all = "camelCase")]
    ApprovalRequested {
        session_id: String,
        request: PermissionRequest,
        timestamp: String,
    },
    /// 审批结果（硬依赖 03 §5.1-10：toolCallId + decision 规范值；
    /// requestId 保留兼容，03 §5.3-3）
    #[serde(rename = "approval-resolved", rename_all = "camelCase")]
    ApprovalResolved {
        session_id: String,
        tool_call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        decision: ApprovalDecision,
        timestamp: String,
    },
    /// 检查点已创建
    #[serde(rename = "checkpoint-created", rename_all = "camelCase")]
    CheckpointCreated {
        session_id: String,
        timestamp: String,
        checkpoint: RuntimeCheckpointRecord,
    },
    /// 检查点已恢复
    #[serde(rename = "checkpoint-restored", rename_all = "camelCase")]
    CheckpointRestored {
        session_id: String,
        timestamp: String,
        restore: RuntimeCheckpointRestoreRecord,
    },
    /// run 终态（硬依赖 03 §5.1-11/16：terminal + error；runId 必须存在）
    #[serde(rename = "run-terminal", rename_all = "camelCase")]
    RunTerminal {
        session_id: String,
        run_id: String,
        timestamp: String,
        terminal: RunTerminalStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },

    // ── 缓存测量域（P5 S3 §3.1.3 新增；仅测量展示，不干预循环）──
    /// run 收口时发出的会话级缓存统计快照（runId 由信封注入，不占事件体；
    /// 发射策略：run 收口经收口轨发一次，不按 turn 刷屏）
    #[serde(rename = "cache-stats-updated", rename_all = "camelCase")]
    CacheStatsUpdated {
        session_id: String,
        timestamp: String,
        stats: RunCacheStats,
    },
    /// 缓存浪费审计命中（阈值：missed_tokens ≥ 20_000 或 missed_cost ≥ $0.1
    /// 才发射；attribution 为 kebab-case 归因分类）
    #[serde(rename = "cache-waste-alert", rename_all = "camelCase")]
    CacheWasteAlert {
        session_id: String,
        timestamp: String,
        attribution: MissAttribution,
        missed_tokens: u64,
        idle_ms: u64,
        model_changed: bool,
        /// 预估浪费金额（USD；engine 按 P3 价格估算后填充，None = 无价格数据）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        missed_cost_usd: Option<f64>,
    },
    /// 冷缓存预警（Rust 只在 run 启动、cold_cache_check 命中时发一次；
    /// 空闲期间的提示由前端 warmUntilMs tick 驱动，不后台轮询）
    #[serde(rename = "cold-cache-warning", rename_all = "camelCase")]
    ColdCacheWarning {
        session_id: String,
        timestamp: String,
        ttl_seconds: u64,
        idle_ms: u64,
        /// 预估重发 token = 上次请求 input_total
        resend_estimate_tokens: u64,
    },

    // ── 安全审计域（I2-S8：高危操作审计事件）──
    /// 高危操作审计（删除接管/重定向/恢复/红线拦截；影响面载荷供 S9
    /// 审批弹窗与审计面板；runId 由 emit 层经信封注入，不占事件体）
    #[serde(rename = "security-audit", rename_all = "camelCase")]
    SecurityAudit {
        session_id: String,
        timestamp: String,
        /// 审计操作类别（delete/trash-restore/trash-purge/git-revert/command-exec）
        operation: SecurityAuditOperation,
        /// 目标路径列表
        targets: Vec<String>,
        /// 影响面（文件数/总大小/目录数/跨目录/谨慎标记）
        impact: ImpactAssessment,
        /// 处置决策（blocked/approved/denied/redirected/restored/purged）
        decision: SecurityAuditDecision,
        /// 权限模式（ask/full-access/plan；emit 层可注入，工具侧为 None）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        permission_mode: Option<String>,
        /// 工具调用 id（工具侧发射时填充；None = 非工具上下文，如引擎命令）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
    },

    // ── 子代理域（I5-M7：C8 事件契约；runId 由信封注入 = 父 run）──
    /// 子代理启动（run_subagent spawn；前端消费 subagentId/subagentRunId/
    /// parentRunId（信封 runId）/parentToolCallId/description/mode，
    /// subagentHandlers.ts:17-26；role/capabilityMode/startedAt 供状态展示）
    #[serde(rename = "subagent-started", rename_all = "camelCase")]
    SubagentStarted {
        session_id: String,
        subagent_id: String,
        subagent_run_id: String,
        /// 子代理角色（对齐 shared-types subagent.ts SubagentRole）
        role: String,
        /// 能力模式（readonly/read-write 等，工具集裁剪依据 M3）
        capability_mode: String,
        /// ISO8601 时间戳（首次创建时间，M4 started_at 同源；@dynamic 动态字段）
        started_at: String,
        /// 人读描述（前端缺省 '协作 agent'）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        /// 调度模式（research/research_single/solve/write，前端缺省 research）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
        /// 父 run 发起 spawn 的工具调用 id
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
    },
    /// 子代理过程事件（event 为结构化负载，前端整体透传给 onSubagentEvent；
    /// 背压分级随 kind：progress=Delta、message/tool=Soft）
    #[serde(rename = "subagent-event", rename_all = "camelCase")]
    SubagentEvent {
        session_id: String,
        subagent_id: String,
        subagent_run_id: String,
        event: SubagentEventPayload,
    },
    /// 子代理结束（status 规范值 completed/failed/cancelled，前端正则映射
    /// stopped/failed/completed；Critical 级必达落库）
    #[serde(rename = "subagent-ended", rename_all = "camelCase")]
    SubagentEnded {
        session_id: String,
        subagent_id: String,
        subagent_run_id: String,
        status: SubagentEndStatus,
        /// 收尾摘要（可选）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        /// ISO8601 时间戳
        ended_at: String,
    },
}

/// 事件类型名宏：由同一份变体名 → wire 名清单展开出
/// [AgentEvent::type_name] 与 [AgentEvent::ALL_TYPE_NAMES] 两处，
/// 保证「取类型名」与「全量清单」永不漂移（新增事件变体在此登记即可，
/// 编译期要求补 arm；并同步 contracts/engine-events.json 注册表，
/// 由 tests/registry_drift.rs 锁定）。
macro_rules! engine_event_type_names {
    ($($variant:ident => $name:literal),+ $(,)?) => {
        impl AgentEvent {
            /// 事件类型名（顶层 `type` 值，kebab-case）
            ///
            /// 与 serde tag（[`AgentEventEnvelope`] 序列化的顶层 `type` 字段）同源，
            /// 供落库等只取类型名的路径复用，避免为取类型名构造信封克隆整个事件。
            pub fn type_name(&self) -> &'static str {
                match self {
                    $(AgentEvent::$variant { .. } => $name,)+
                }
            }
        }

        impl AgentEvent {
            /// 全部事件类型名（enum 声明顺序，与事件注册表编号 1-27 一一对应）
            pub const ALL_TYPE_NAMES: &'static [&'static str] = &[$($name),+];
        }
    };
}

engine_event_type_names! {
    AgentStart => "agent-start",
    AgentEnd => "agent-end",
    TurnStart => "turn-start",
    TurnEnd => "turn-end",
    MessageStart => "message-start",
    MessageDelta => "message-delta",
    MessageEnd => "message-end",
    ToolStart => "tool-start",
    ToolUpdate => "tool-update",
    ToolEnd => "tool-end",
    ToolBatchStart => "tool-batch-start",
    ToolBatchEnd => "tool-batch-end",
    ToolInputRepaired => "tool-input-repaired",
    ContextCompressionStart => "context-compression-start",
    ContextCompressionEnd => "context-compression-end",
    ProviderDiagnostic => "provider-diagnostic",
    RuntimeError => "runtime-error",
    RuntimeSteering => "runtime-steering",
    RuntimeInterventionRequired => "runtime-intervention-required",
    ApprovalRequested => "approval-requested",
    ApprovalResolved => "approval-resolved",
    CheckpointCreated => "checkpoint-created",
    CheckpointRestored => "checkpoint-restored",
    RunTerminal => "run-terminal",
    CacheStatsUpdated => "cache-stats-updated",
    CacheWasteAlert => "cache-waste-alert",
    ColdCacheWarning => "cold-cache-warning",
    SecurityAudit => "security-audit",
    SubagentStarted => "subagent-started",
    SubagentEvent => "subagent-event",
    SubagentEnded => "subagent-ended",
}

/// 事件 → 背压级别（静态可判定，04 报告 1e；与事件注册表 backpressure 字段
/// 一一对应，registry_drift 护栏双向锁定；先例 buffer.rs drop_class_of——
/// 非 delta 全 Critical）
///
/// 分级规则：
/// - Delta（可丢）：message-delta（既有非持久化语义）、subagent-event 的
///   progress 类；
/// - Soft（尽力）：subagent-event 的 message/tool 类；
/// - Critical（必达）：其余全部（含 subagent-started/subagent-ended、终态、
///   审批、审计等）。
pub fn event_backpressure(event: &AgentEvent) -> BackpressureLevel {
    match event {
        AgentEvent::MessageDelta { .. } => BackpressureLevel::Delta,
        AgentEvent::SubagentEvent { event, .. } => match event.kind {
            SubagentEventKind::Progress => BackpressureLevel::Delta,
            SubagentEventKind::Message | SubagentEventKind::Tool => BackpressureLevel::Soft,
        },
        _ => BackpressureLevel::Critical,
    }
}

/// 子代理事件类别 → 背压级别（`subagent-event` 的 kind 级分类；
/// progress=Delta 可丢、message/tool=Soft 尽力；与注册表 kindBackpressure
/// 字段对应，registry_drift 护栏锁定）
pub fn subagent_event_kind_backpressure(kind: SubagentEventKind) -> BackpressureLevel {
    match kind {
        SubagentEventKind::Progress => BackpressureLevel::Delta,
        SubagentEventKind::Message | SubagentEventKind::Tool => BackpressureLevel::Soft,
    }
}

/// 事件信封（emit 层统一注入 runId/sequence/schemaVersion，03 §5.3-2/6）
///
/// 序列化为**扁平**顶层 JSON：`{ type, runId, sequence, schemaVersion, sessionId,
/// ...事件字段 }`，与 daemon WS 广播同构（03 §3.1）。`runId` 缺失时前端放行不过滤
/// （eventUtils.ts:21），但多 run 并发过滤失效；`sequence` 是重放去重
/// 与游标的唯一依据（03 §5.1-2/3）。`run-terminal` 的 runId 必须填充
/// （03 §5.1-16；其事件体内的 runId 字段与信封注入值一致，03 §5.3-2）。
///
/// `schemaVersion` 是信封（wire）层的 schema 版本（PE-03 T03.10 / PE-12 T12.5），
/// 与事件字段演进无关：缺省视为 1（无该字段的旧帧照常解析，[`AgentEvent`] 本身
/// 不携带版本字段，域类型纯净）。当前唯一版本为 1；字段演进走
/// 33-event-schema-changelog.md 的 minor/major 规则登记。
///
/// 说明：因 `run-terminal` 事件自身携带 runId 字段，与信封注入字段同名，
/// serde flatten 会触发「重复字段」冲突，故序列化/反序列化经
/// `serde_json::Value` 手工合并实现：注入值覆盖同名事件字段。
#[derive(Debug, Clone, PartialEq)]
pub struct AgentEventEnvelope {
    pub event: AgentEvent,
    pub run_id: Option<String>,
    pub sequence: Option<u64>,
    /// 信封 schema 版本（wire 层注入，camelCase `schemaVersion`；当前恒为 1）
    pub schema_version: u32,
}

/// 事件信封 wire schema 版本（PE-03 T03.10 / PE-12 T12.5）
///
/// v1 = 当前 24 事件基线（33-event-schema-changelog.md）；反序列化时缺省补 1，
/// 保证无该字段的旧帧解析后 schema_version 不为零。
pub const EVENT_ENVELOPE_SCHEMA_VERSION: u32 = 1;

impl serde::Serialize for AgentEventEnvelope {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        use serde::ser::Error as _;
        let mut value =
            serde_json::to_value(&self.event).map_err(S::Error::custom)?;
        let map = value
            .as_object_mut()
            .ok_or_else(|| S::Error::custom("事件必须序列化为 JSON 对象"))?;
        if let Some(run_id) = &self.run_id {
            map.insert("runId".into(), serde_json::json!(run_id));
        }
        if let Some(sequence) = self.sequence {
            map.insert("sequence".into(), serde_json::json!(sequence));
        }
        map.insert(
            "schemaVersion".into(),
            serde_json::json!(self.schema_version),
        );
        map.serialize(serializer)
    }
}

impl<'de> serde::Deserialize<'de> for AgentEventEnvelope {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        let value = serde_json::Value::deserialize(deserializer)?;
        let map = value
            .as_object()
            .ok_or_else(|| D::Error::custom("事件信封必须是 JSON 对象"))?;
        // 事件体保留顶层 runId（run-terminal 依赖它），其余事件忽略该键
        let event = AgentEvent::deserialize(value.clone()).map_err(D::Error::custom)?;
        let run_id = map.get("runId").and_then(serde_json::Value::as_str).map(str::to_string);
        let sequence = map.get("sequence").and_then(serde_json::Value::as_u64);
        // 旧帧无 schemaVersion 字段时缺省补 1（PE-03 T03.10：向后兼容）
        let schema_version = map
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(EVENT_ENVELOPE_SCHEMA_VERSION);
        Ok(Self {
            event,
            run_id,
            sequence,
            schema_version,
        })
    }
}

impl AgentEventEnvelope {
    /// 构造信封（schema 版本默认取当前 [EVENT_ENVELOPE_SCHEMA_VERSION]）
    pub fn new(
        event: AgentEvent,
        run_id: Option<String>,
        sequence: Option<u64>,
    ) -> Self {
        Self {
            event,
            run_id,
            sequence,
            schema_version: EVENT_ENVELOPE_SCHEMA_VERSION,
        }
    }

    /// 事件类型名（顶层 `type` 值；委托 [AgentEvent::type_name]）
    pub fn type_name(&self) -> &'static str {
        self.event.type_name()
    }
}
