//! 域事件契约（Rust enum 为双端唯一事实源）
//!
//! [AgentEvent] 是 49 种域事件的 serde tagged enum（顶层 `type`），全部字段
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
    /// 远程来源触达被禁命令面（D5 §6.2 remote-source-attempt：
    /// 白名单拒绝 + 命令级 Forbidden 的审计可见性，TH-11；targets
    /// 承载打码后的命令名，decision 恒 blocked）
    #[serde(rename = "remote-source-attempt")]
    RemoteSourceAttempt,
    /// 远程 run 权限模式降级（D5 §6.2 remote-mode-downgrade：
    /// full-access 申请被降级为 ask，TH-12 直接缓解；targets 承载
    /// runId（run 创建前为空）、permission_mode 记录降级前申请值，
    /// decision 取 blocked 语义——降级动作已记录）
    #[serde(rename = "remote-mode-downgrade")]
    RemoteModeDowngrade,
    /// 远程单一确认（D5 §4.4 remote-only 审计标记：桌面不在场时
    /// 移动端单方批准，事后追责可区分单方批准与双轨批准；
    /// decision 取 approved 语义——单方批准已放行）
    #[serde(rename = "remote-only")]
    RemoteOnly,
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

// ── 事件策略三决策（D-04 PC-05：分类唯一事实源，单一 event_policy()
//    同一 match 产出三正交决策，消灭 event_class / event_backpressure /
//    drop_class_of 三套分类漂移；注册表每条目扩展三字段，registry_drift
//    三字段双向锁定）──

/// 持久化决策（事件面是否落库；与背压分级正交——同背压可不同持久化：
/// task-output=Delta+NoPersist、subagent-progress=Delta+NoPersist，
/// 而 message-delta=Delta+NoPersist 却桥丢帧 Soft，三决策不同构）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistenceDecision {
    /// 落库（EventQueue::push 同步等待 store 持久化）
    Persist,
    /// 不落库（增量/实时轨，不阻塞 drive loop）
    NoPersist,
}

/// 桥丢帧优先级（缓冲层水位语义；由壳层 buffer.rs 迁入 conex-types，
/// 单一类型零映射——禁壳层依赖倒挂）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropClass {
    /// 可丢（唯一：message-delta；message-end 全文兜底）
    Soft,
    /// 永不丢（terminal / 审批 / 工具 / message-end 等）
    Critical,
}

/// 单一事件策略：同一 match 产出三正交决策（背压 + 持久化 + 桥丢帧），
/// 新增事件只改 [event_policy] 一处，注册表/消费方随 registry_drift
/// 三字段锁定同步。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventPolicy {
    /// 实时桥投递保证（注册表 backpressure 字段）
    pub backpressure: BackpressureLevel,
    /// 是否落库（事件面持久化）
    pub persist: PersistenceDecision,
    /// 缓冲层丢帧分级
    pub bridge_priority: DropClass,
}

impl EventPolicy {
    /// 三值正交构造（同处定义，杜绝分头散落）
    pub const fn new(
        backpressure: BackpressureLevel,
        persist: PersistenceDecision,
        bridge_priority: DropClass,
    ) -> Self {
        Self { backpressure, persist, bridge_priority }
    }
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
    // ── 权限传递层（T-D-14，用户定夺「权限申请传递层」落地）──
    // 新增字段全 Option + serde 缺省，向后兼容（旧载荷缺省可读、缺省不
    // 序列化）；随载荷 jsonb 落库，无 schema 变更（调研-权限传递层.md §4.2）。
    /// 请求方 run 归属（None = 主 agent run；Some = 子代理 run id）——
    /// 裁决者路由依据（子代理来源 → 主 agent 裁决；主 agent 来源 → 用户）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requester_run_id: Option<String>,
    /// 子代理申请理由（提示词协议要求「需要更高权限时说明理由」；
    /// 主 agent 裁决面展示与审计用；主 agent 自身请求恒 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
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

/// 49 种域事件（tagged enum，双端契约唯一事实源）
///
/// 顶层 `type` 为事件名（kebab-case），事件字段全部 camelCase；
/// 字段清单与类型映射见 contracts/engine-events.json（事件注册表），
/// 前端 TS 由生成脚本产出（见模块文档）。
/// 2026-08-05 T-CF-04 定时器域兼容新增 2 变体（timer-fired/timer-cancelled），
/// 38 → 40；同日 T-CF-08 cron 域兼容新增 1 变体（cron-fired），40 → 41；
/// 2026-08-11 任务连续性方案恢复域 + goal 域兼容新增 8 变体
/// （recovery-* ×5 + goal-* ×3），41 → 49（D8 事件登记，编号 42-49）。
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
        /// 轮次序号（G4 / 04 §5.2-5：多轮 run 前端按 turnIndex 分段合并，
        /// 消灭 hydrate「只剩末轮文本」；与 turn-start/turn-end 同值）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_index: Option<u32>,
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

    // ── 任务域（T-AB-17：AB 命令执行与后台任务，01 方案 §4.5 七事件冻结
    //    契约；背压分级入注册表，registry_drift 护栏锁定；runId 由 emit 层
    //    信封注入 = 发起 run）──

    /// 后台任务启动（adopt 成功；Critical 必达落库；ownerRunId 供
    /// orchestrator 按来源过滤——主 agent 与其派发的子 agent run 看到的
    /// 任务按来源归组，T-AB-18 可见性消费）
    #[serde(rename = "task-started", rename_all = "camelCase")]
    TaskStarted {
        session_id: String,
        /// 任务 id（后台任务注册表主键）
        task_id: String,
        /// 命令摘要（人读，含 argv 摘要；T-AB-18 审计 command 摘要字段）
        command: String,
        /// 工作目录
        cwd: String,
        /// 发起 run id（任务归属来源：主 agent run / 子 agent run）
        owner_run_id: String,
        /// 是否守护进程（run 终态后仍持续运行）
        is_daemon: bool,
    },
    /// 任务输出增量（Delta 可丢不落库；转发器节流推送 60ms，继承旧
    /// task-output 语义；line 或 chunk 二选一）
    #[serde(rename = "task-output", rename_all = "camelCase")]
    TaskOutput {
        session_id: String,
        /// 任务 id
        task_id: String,
        /// 单行输出（不含行尾换行；line 或 chunk 二选一）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line: Option<String>,
        /// 输出块（行语义不可分时使用）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        chunk: Option<String>,
        /// 累计行数（转发器行数索引，供前端进度展示）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line_count: Option<u64>,
    },
    /// 任务资源心跳（Delta 可丢不落库；仅启用 resourceMonitor 的任务由
    /// 采样 loop 发射）
    #[serde(rename = "task-heartbeat", rename_all = "camelCase")]
    TaskHeartbeat {
        session_id: String,
        /// 任务 id
        task_id: String,
        /// 资源摘要（CPU 百分比 / RSS 字节 / 最近输出时间等，采样端组装）
        resource: serde_json::Value,
    },
    /// 任务疑似卡死（Soft 尽力投递并留痕；健康判定转 Suspicious 时发射，
    /// 非终态可重复；通知文案「任务 <id> 疑似卡死（<M> 秒无输出）」）
    #[serde(rename = "task-suspicious", rename_all = "camelCase")]
    TaskSuspicious {
        session_id: String,
        /// 任务 id
        task_id: String,
        /// 静默时长（毫秒）
        silence_ms: u64,
        /// 最近一次输出时间（epoch 毫秒）
        last_output_at_ms: u64,
    },
    /// 任务自然退出且退出码为 0（Critical 必达落库；唤醒摘要
    /// 「任务 <id> 已完成，退出码 0」）
    #[serde(rename = "task-completed", rename_all = "camelCase")]
    TaskCompleted {
        session_id: String,
        /// 任务 id
        task_id: String,
        /// 退出码（0 = 成功）
        exit_code: i32,
        /// 运行时长（毫秒）
        duration_ms: u64,
        /// 累计行数
        line_count: u64,
    },
    /// 任务自然退出且退出码非 0（Critical 必达落库；C7 恢复阶梯衔接源，
    /// 唤醒摘要「任务 <id> 异常退出（exit code N），附最后 20 行日志」）
    #[serde(rename = "task-failed", rename_all = "camelCase")]
    TaskFailed {
        session_id: String,
        /// 任务 id
        task_id: String,
        /// 退出码（非 0）
        exit_code: i32,
        /// 日志尾部（最后 20 行，read_log 尾部读取产出）
        tail: Vec<String>,
        /// 运行时长（毫秒）
        duration_ms: u64,
    },
    /// 任务已被终止（kill 成功含两阶段升级；Critical 必达落库；唤醒摘要
    /// 「任务 <id> 已被终止」）
    #[serde(rename = "task-killed", rename_all = "camelCase")]
    TaskKilled {
        session_id: String,
        /// 任务 id
        task_id: String,
        /// 是否强制终止（两阶段升级后为 true）
        via_force: bool,
        /// 终止诊断（附加说明；可选）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diagnostics: Option<String>,
    },

    // ── 定时器域（T-CF-04：02-CF 方案 §4.1/§4.7 定时器事件；runId 由
    //     emit 层信封注入——定时器事件无 run 归属，发射时置空串或
    //     timer-<id> 伪 runId，见 [AgentEventEnvelope::run_id] 描述；唤醒走
    //     steering 面而非事件面，事件仅实时轨广播、不落库（R-22，R-CF3
    //     翻转点），触发痕迹的持久事实源 = session_meta timer_<id> +
    //     steering 条目 + 续 run 事件链（§4.7 读取面声明））──

    /// 定时器到期（TimerRegistry 到期触发；Critical 实时桥必达——仅实时
    /// 轨广播、不落库（R-22，R-CF3 翻转点）；唤醒摘要「<prompt>（定时器
    /// <id> 已到期）」，T-CF-12）
    #[serde(rename = "timer-fired", rename_all = "camelCase")]
    TimerFired {
        session_id: String,
        /// 定时器 id（timer-<seq>）
        timer_id: String,
        /// 到期注入的提示内容
        prompt: String,
        /// 触发时刻（epoch 毫秒）
        fired_at_ms: u64,
    },
    /// 定时器已取消（早退命中 / AI 显式取消；Soft 尽力投递——仅实时轨
    /// 广播、不落库（R-22，R-CF3 翻转点）；reason 规范值 early-exit|cancelled）
    #[serde(rename = "timer-cancelled", rename_all = "camelCase")]
    TimerCancelled {
        session_id: String,
        /// 定时器 id（timer-<seq>）
        timer_id: String,
        /// 取消原因（early-exit|cancelled）
        reason: String,
        /// 取消时刻（epoch 毫秒）
        cancelled_at_ms: u64,
    },

    // ── cron 域（T-CF-08：02-CF 方案 §4.4/§4.7 cron 触发事件；runId 由
    //     emit 层信封注入——cron 事件无 run 归属，发射时置空串或
    //     cron-<id> 伪 runId，见 [AgentEventEnvelope::run_id] 描述；唤醒走
    //     steering 面而非事件面，事件仅实时轨广播、不落库（R-22，R-CF3
    //     翻转点），触发痕迹的持久事实源 = session_meta + steering 条目 +
    //     续 run 事件链（§4.7 读取面声明）；唤醒摘要「<prompt>（cron <id>
    //     第 <n> 次触发）」，T-CF-12）──

    /// cron 已触发（SchedulerRegistry 触发；Critical 实时桥必达——仅实时
    /// 轨广播、不落库（R-22，R-CF3 翻转点）；AI 实际唤醒走 steering
    /// 条目，事件与唤醒解耦）
    #[serde(rename = "cron-fired", rename_all = "camelCase")]
    CronFired {
        session_id: String,
        /// cron 任务 id（cron-<seq>）
        cron_id: String,
        /// 每次触发的通知内容
        prompt: String,
        /// 表达式原文（回显）
        expression: String,
        /// 触发次数（从 1 起计）
        iteration: u64,
        /// 触发时刻（epoch 毫秒）
        fired_at_ms: u64,
    },

    // ── 恢复域（任务连续性方案：recovery-* ×5；载荷 = orchestrator
    //     recovery.rs append_event 实际 payload 的基元镜像（契约镜像模式，
    //     不引入 payload struct——registry_drift 可达性护栏）；sessionId 为
    //     事件行级列，读侧合成信封（D8 §3.2）；runId 由 emit 层信封注入；
    //     背压全 Critical（append_event 落库必达，数据面））──

    /// 恢复阶梯升级留痕（阶梯 1 → 阶梯 2 的边界证据；双发射方（02-定夺
    /// W1）：子代理侧 subagentRunId=Some、detail=None；熔断侧（D1）
    /// subagentRunId=None、detail=Some("circuit-trip")）
    #[serde(rename = "recovery-escalated", rename_all = "camelCase")]
    RecoveryEscalated {
        session_id: String,
        /// 子代理 run id（熔断侧 None）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent_run_id: Option<String>,
        /// 升级原因（如 Timeout 的 Debug 形态）
        kind: String,
        /// 阶梯 1 已重试次数
        retries: u32,
        /// 重试耗时（epoch 毫秒）
        elapsed_ms: u64,
        /// 附加详情（熔断侧 Some("circuit-trip")）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// 阶梯 2 steering 通知留痕（RecoveryNotification serde camelCase 镜像）
    #[serde(rename = "recovery-steering", rename_all = "camelCase")]
    RecoverySteering {
        session_id: String,
        /// 子代理 id
        subagent_id: String,
        /// 子代理 run id
        subagent_run_id: String,
        /// 操作指纹（报表聚合依据）
        fingerprint: String,
        /// 阶梯 1 已重试次数
        retries: u32,
        /// 剩余状态（上行时的 run 状态摘要）
        remaining_status: String,
        /// 是否仍未处理（acknowledge 置 false；重启只重排 pending 条目）
        pending: bool,
        /// 创建时间（epoch 毫秒）
        created_at_ms: u64,
    },
    /// 阶梯 3 fork 重分配留痕（ForkRecord 字段镜像；contextMode 为
    /// ForkContextMode wire 值 verbatim/summarized/new，String 承载）
    #[serde(rename = "recovery-fork", rename_all = "camelCase")]
    RecoveryFork {
        session_id: String,
        /// 操作指纹
        fingerprint: String,
        /// 子代理 id
        subagent_id: String,
        /// 原 run id（置 failed 的 run）
        from_run_id: String,
        /// 原 run 的会话树叶子 id（fork 起点）
        from_leaf_id: String,
        /// 新 run id（fork 分支承接同一目标）
        new_run_id: String,
        /// 新 run 的会话树叶子 id
        new_leaf_id: String,
        /// fork 三态上下文继承模式（verbatim/summarized/new）
        context_mode: String,
    },
    /// 阶梯 4 上报用户留痕（UserReport 基元字段镜像；attempts 尝试明细
    /// 不在事件面，前端失败卡片经 recovery-escalated/run 终态取数）
    #[serde(rename = "recovery-report", rename_all = "camelCase")]
    RecoveryReport {
        session_id: String,
        /// 子代理 id
        subagent_id: String,
        /// 当前 run id
        subagent_run_id: String,
        /// 停摆时间（epoch 毫秒）
        stuck_at_ms: u64,
        /// 建议怎么办（固定指引文案）
        suggestion: String,
    },
    /// 恢复预算拒绝留痕（双发射方（02-定夺 W6）：D2 主 run 侧
    /// subagentRunId=None；D3 子代理侧预算拒绝 subagentRunId=Some）
    #[serde(rename = "recovery-budget-denied", rename_all = "camelCase")]
    RecoveryBudgetDenied {
        session_id: String,
        /// 子代理 run id（D2 主 run 侧 None）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent_run_id: Option<String>,
        /// 操作指纹
        fingerprint: String,
        /// 已消费次数
        count: u32,
        /// 预算上限
        max: u32,
    },

    // ── goal 域（任务连续性方案：goal-* ×3；D5 RoundAssessment 发射；
    //     envelope 事件不列 sessionId 变体字段——会话归属在事件行
    //     session_id 列，读侧信封已含，02-定夺 B2/S9 约定；
    //     runId 由 emit 层信封注入）──

    /// goal 新一轮开始（round 从 1 计）
    #[serde(rename = "goal-round-started", rename_all = "camelCase")]
    GoalRoundStarted {
        /// 轮次（从 1 计）
        round: u32,
        /// 最大轮数
        max_rounds: u32,
        /// 目标文本
        goal: String,
    },
    /// goal 一轮完成（02-定夺 B2 统一单一字段集；decision 为 D5
    /// GoalDecision wire 值 Continue/Completed/NoProgress/Blocked/NoGoal，
    /// String 承载；stalledDelta 表达本轮增量，stalled 总数在 goal_state 键）
    #[serde(rename = "goal-round-completed", rename_all = "camelCase")]
    GoalRoundCompleted {
        /// 轮次（从 1 计）
        round: u32,
        /// 本轮工具调用次数
        tool_call_count: u32,
        /// 本轮工具成功次数
        tool_success_count: u32,
        /// 本轮消息数
        message_count: u32,
        /// 本轮判定（Continue/Completed/NoProgress/Blocked/NoGoal）
        decision: String,
        /// 判定依据明细
        reason_detail: String,
        /// 本轮 stalled 增量
        stalled_delta: u32,
        /// 证据（工具批指纹等）
        evidence: String,
    },
    /// goal 续轮决策（载荷对齐 TS GoalContinuationDecision：
    /// orchestration.ts:38-44；prompt 为续轮注入文本）
    #[serde(rename = "goal-continuation-decided", rename_all = "camelCase")]
    GoalContinuationDecided {
        /// 决策动作（continue/complete/stop 等）
        action: String,
        /// 决策原因
        reason: String,
        /// 续轮注入提示（可选）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        /// 进度签名（可选）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        progress_signature: Option<String>,
        /// 附加详情（可选）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
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
            /// 全部事件类型名（enum 声明顺序，与事件注册表编号 1-49 一一对应）
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
    TaskStarted => "task-started",
    TaskOutput => "task-output",
    TaskHeartbeat => "task-heartbeat",
    TaskSuspicious => "task-suspicious",
    TaskCompleted => "task-completed",
    TaskFailed => "task-failed",
    TaskKilled => "task-killed",
    TimerFired => "timer-fired",
    TimerCancelled => "timer-cancelled",
    CronFired => "cron-fired",
    RecoveryEscalated => "recovery-escalated",
    RecoverySteering => "recovery-steering",
    RecoveryFork => "recovery-fork",
    RecoveryReport => "recovery-report",
    RecoveryBudgetDenied => "recovery-budget-denied",
    GoalRoundStarted => "goal-round-started",
    GoalRoundCompleted => "goal-round-completed",
    GoalContinuationDecided => "goal-continuation-decided",
}

/// 单一事件策略（D-04 PC-05：分类唯一事实源）——同一 match 产出
/// 三正交决策（背压 / 持久化 / 桥丢帧），新增事件只改本函数一处；
/// 与事件注册表三字段（backpressure / persist / bridgePriority）
/// 一一对应，registry_drift 护栏三字段双向锁定。
///
/// 定案表（D-04 §3.3，PC-05/PC-01/PC-02 共用，漂移清零后逐事件显式化）：
/// - message-delta = Delta + NoPersist + Soft（增量可丢，message-end 全文兜底）；
/// - subagent progress = Delta + NoPersist + Critical（缓冲不丢）；
///   message/tool = Soft + Persist + Critical（尽力落库，既有语义）；
/// - task-output / task-heartbeat = Delta + **NoPersist** + Critical
///   （PC-02 定案：事实源 = 任务日志文件 / .samples.jsonl）；
/// - task-suspicious = Soft + **NoPersist** + Critical（PC-02 定案：
///   notifier + .samples.jsonl + 终态落库）；
/// - timer-fired / cron-fired = Critical + **NoPersist** + Critical
///   （PC-01 定案：实时桥必达语义保留，持久化决策正交独立声明——
///   「仅实时轨，R-CF3 翻转点」= 事件体 sessionId 非空 + 无 run 持久化
///   通道就绪）；
/// - timer-cancelled = Soft + **NoPersist** + Critical（PC-01 定案）；
/// - task 终态 4（started/completed/failed/killed）= Critical + Persist +
///   Critical（PC-02 定案，D-01 规范化落库点）；
/// - 其余 Critical 族（agent/turn/tool/message-end/审批/审计/subagent
///   started-ended/goal/recovery/run-terminal 等）= Critical + Persist + Critical。
pub fn event_policy(event: &AgentEvent) -> EventPolicy {
    match event {
        // message-delta：增量可丢 + 不落库 + 桥 Soft（message-end 全文兜底，
        // 丢帧不丢 message-end——03 §5.3-6 契约）
        AgentEvent::MessageDelta { .. } => EventPolicy::new(
            BackpressureLevel::Delta,
            PersistenceDecision::NoPersist,
            DropClass::Soft,
        ),
        // subagent-event：kind 级背压（progress=Delta 可丢不落库、
        // message/tool=Soft 尽力落库），桥缓冲一律不丢
        AgentEvent::SubagentEvent { event, .. } => match event.kind {
            SubagentEventKind::Progress => EventPolicy::new(
                BackpressureLevel::Delta,
                PersistenceDecision::NoPersist,
                DropClass::Critical,
            ),
            SubagentEventKind::Message | SubagentEventKind::Tool => EventPolicy::new(
                BackpressureLevel::Soft,
                PersistenceDecision::Persist,
                DropClass::Critical,
            ),
        },
        // 任务域增量（01 方案 §4.5 表）：output/heartbeat=Delta 可丢不落库
        // （事实源 = 任务日志文件 / .samples.jsonl，PC-02 定案）、
        // suspicious=Soft 尽力投递不落库（notifier + .samples.jsonl +
        // 终态落库，PC-02 定案）
        AgentEvent::TaskOutput { .. } | AgentEvent::TaskHeartbeat { .. } => EventPolicy::new(
            BackpressureLevel::Delta,
            PersistenceDecision::NoPersist,
            DropClass::Critical,
        ),
        AgentEvent::TaskSuspicious { .. } => EventPolicy::new(
            BackpressureLevel::Soft,
            PersistenceDecision::NoPersist,
            DropClass::Critical,
        ),
        // 任务终态 4 事件：Critical 必达落库（PC-02 定案，D-01 规范化落库点）
        AgentEvent::TaskStarted { .. }
        | AgentEvent::TaskCompleted { .. }
        | AgentEvent::TaskFailed { .. }
        | AgentEvent::TaskKilled { .. } => EventPolicy::new(
            BackpressureLevel::Critical,
            PersistenceDecision::Persist,
            DropClass::Critical,
        ),
        // 定时器/cron 域（02-CF 方案 §4.7）：实时桥必达（Critical 分级语义
        // 保留 = 实时桥必达），持久化正交独立声明 = 不落库（仅实时轨，
        // R-CF3 翻转点；唤醒走 steering 面而非事件面，事件仅数据面）
        AgentEvent::TimerFired { .. } | AgentEvent::CronFired { .. } => EventPolicy::new(
            BackpressureLevel::Critical,
            PersistenceDecision::NoPersist,
            DropClass::Critical,
        ),
        AgentEvent::TimerCancelled { .. } => EventPolicy::new(
            BackpressureLevel::Soft,
            PersistenceDecision::NoPersist,
            DropClass::Critical,
        ),
        // 恢复域（D8：recovery-* ×5 全 Critical——append_event 落库必达，
        // 数据面）与 goal 域（goal-* ×3 全 Critical——对齐 timer-fired 先例，
        // 数据面，唤醒走 steering 面）：必达落库
        AgentEvent::RecoveryEscalated { .. }
        | AgentEvent::RecoverySteering { .. }
        | AgentEvent::RecoveryFork { .. }
        | AgentEvent::RecoveryReport { .. }
        | AgentEvent::RecoveryBudgetDenied { .. }
        | AgentEvent::GoalRoundStarted { .. }
        | AgentEvent::GoalRoundCompleted { .. }
        | AgentEvent::GoalContinuationDecided { .. } => EventPolicy::new(
            BackpressureLevel::Critical,
            PersistenceDecision::Persist,
            DropClass::Critical,
        ),
        // 其余 Critical 族（agent/turn/tool/message-end/审批/审计/
        // subagent started-ended/run-terminal 等）：必达落库
        _ => EventPolicy::new(
            BackpressureLevel::Critical,
            PersistenceDecision::Persist,
            DropClass::Critical,
        ),
    }
}

/// 事件 → 背压级别（D-04 PC-05 薄壳：单一分类事实源 [event_policy] 唯一
/// 实现三决策，本函数仅投影 backpressure——保持 device/events.rs 的
/// event_is_sync_eligible、fanout/ws 等既有调用面零改动）
pub fn event_backpressure(event: &AgentEvent) -> BackpressureLevel {
    event_policy(event).backpressure
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
/// `traceId`（S2 分布式追踪最小面，2026-08-13-wave 维度 5）为**可选**字段：
/// run 启动装配面生成 per-run trace_id，经缓冲事件桥注入（wire 键 `traceId`，
/// camelCase 与 runId/sequence 一致）；缺省 None = 无 run 上下文（定时器/cron
/// 域事件）或旧帧向后兼容——`schema_version` 不升（D-05 §二 S2 完成定义②）。
/// 前端 transport 对事件 payload 逐字透传（不按 HTTP 头实现——Tauri IPC
/// 无 HTTP 头语义，D-05 §四）。
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
    /// 事件归属 run id（emit 层注入；缺失时前端放行不过滤但多 run 并发
    /// 过滤失效）。定时器域事件（timer-fired/timer-cancelled）与 cron 域
    /// 事件（cron-fired）无 run 归属，发射方置空串或 `timer-<id>` /
    /// `cron-<id>` 伪 runId（02-CF 方案 §4.7 定稿）——前端按 timerId/cronId
    /// 消费，不依赖 runId 分组。timer/cron 事件仅实时轨广播、不落库
    /// （本战役定案 R-22）；完整落库依赖会话化前置（R-CF3 登记后续战役，
    /// 翻转点 = 事件体 sessionId 非空 + 无 run 持久化通道就绪）。
    pub run_id: Option<String>,
    pub sequence: Option<u64>,
    /// 信封 schema 版本（wire 层注入，camelCase `schemaVersion`；当前恒为 1）
    pub schema_version: u32,
    /// run 级追踪 id（S2 分布式追踪最小面；wire 键 `traceId`，可选字段——
    /// 旧帧无该键解析为 None，向后兼容；None 兼容既有事件语义）
    pub trace_id: Option<String>,
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
        if let Some(trace_id) = &self.trace_id {
            map.insert("traceId".into(), serde_json::json!(trace_id));
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
        // S2：traceId 可选字段——旧帧缺省 None，向后兼容（schema_version 不升）
        let trace_id = map
            .get("traceId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
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
            trace_id,
        })
    }
}

impl AgentEventEnvelope {
    /// 构造信封（schema 版本默认取当前 [EVENT_ENVELOPE_SCHEMA_VERSION]；
    /// trace_id 缺省 None——S2 起 run 级 trace 经 [Self::with_trace_id] 注入）
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
            trace_id: None,
        }
    }

    /// 注入 run 级 trace_id（S2 分布式追踪最小面：缓冲事件桥 emit 层单点
    /// 注入；调用方仅在信封 trace_id 为 None 时覆盖，显式携带者原样保留）
    pub fn with_trace_id(mut self, trace_id: Option<String>) -> Self {
        self.trace_id = trace_id;
        self
    }

    /// 事件类型名（顶层 `type` 值；委托 [AgentEvent::type_name]）
    pub fn type_name(&self) -> &'static str {
        self.event.type_name()
    }
}
