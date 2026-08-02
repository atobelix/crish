//! 域事件契约（Rust enum 为双端唯一事实源）
//!
//! [AgentEvent] 是 24 种域事件的 serde tagged enum（顶层 `type`），全部字段
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

/// 24 种域事件（tagged enum，双端契约唯一事实源）
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
            /// 全部事件类型名（enum 声明顺序，与事件注册表编号 1-24 一一对应）
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
