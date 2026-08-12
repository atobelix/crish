//! 工具域与诊断/压缩/检查点类型（契约注册表 contracts/engine-events.json 的
//! tool 载荷；TS 端由 scripts/generate-engine-bindings.mjs 生成）
//!
//! 本模块是 conex-types 的工具类型唯一源，供 agent-provider / agent-tools /
//! agent-core 复用。字段名 serde camelCase，与前端契约 03 §5.1 表逐项对齐。

use serde::{Deserialize, Serialize};

use crate::error::ProviderErrorKind;

/// 工具类别（对齐 ToolCategory）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolCategory {
    /// 终端类
    Terminal,
    /// 文件系统类
    Filesystem,
    /// 网络类
    Network,
    /// MCP 服务器工具
    Mcp,
    /// 技能类
    Skill,
    /// 子代理类
    Agent,
    /// 内部工具
    Internal,
}

/// 工具并发模式（对齐 ToolConcurrency）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolConcurrency {
    /// 可并行执行
    Parallel,
    /// 串行执行
    Sequential,
    /// 独占执行（与同批次其他工具互斥）
    Exclusive,
}

/// 工具输出附属产物类别（对齐 ToolArtifact.kind）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolArtifactKind {
    /// 文件产物
    File,
    /// 差异补丁产物
    Diff,
    /// 图片产物
    Image,
    /// 链接产物
    Link,
    /// 日志产物
    Log,
}

/// 工具输出产物（对齐 ToolArtifact）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifact {
    pub kind: ToolArtifactKind,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// 工具输出（对齐 ToolOutput：text / json / artifacts 三选一承载）
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<Vec<ToolArtifact>>,
}

impl ToolOutput {
    /// 空输出
    pub fn empty() -> Self {
        Self::default()
    }

    /// 纯文本输出
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: Some(text.into()),
            json: None,
            artifacts: None,
        }
    }

    /// 是否完全没有有效内容
    pub fn is_empty(&self) -> bool {
        self.text.is_none() && self.json.is_none() && self.artifacts.is_none()
    }
}

/// 单次工具调用（批量批内一项，对齐 ToolBatchCall）
///
/// 前端硬依赖（03 §5.1-7）：`tool-start.call.id/toolName` 必填，
/// 入参以 `input` 序列化（前端兼容 arguments/args/parameters/input 别名）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolBatchCall {
    /// 工具调用 id，前端协议失败判定键
    pub id: String,
    /// 工具名，前端协议失败判定键
    pub tool_name: String,
    /// 人读摘要
    pub summary: String,
    /// 结构化入参（JSON 对象）
    pub input: serde_json::Value,
    pub category: ToolCategory,
    pub concurrency: ToolConcurrency,
}

/// 单次工具调用结果（对齐 ToolBatchResult）
///
/// 前端硬依赖（03 §5.1-8）：`tool-end.result.id/toolCallId`、`output`、
/// `isError` 必填；无 id 的 tool-end 前端直接丢弃。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolBatchResult {
    pub id: String,
    pub tool_name: String,
    pub output: ToolOutput,
    pub is_error: bool,
    /// 执行耗时（毫秒）
    pub duration_ms: u64,
}

/// 工具执行进度增量（对齐 ToolProgressUpdate）
///
/// 预留：前端 partialToolArgs 消费 `update.metadata.kind === 'tool-args-delta'`
/// 的增量参数流（03 §1.4）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolProgressUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// provider 诊断阶段（对齐 ProviderDiagnostic.phase）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderDiagnosticPhase {
    /// 请求发出前
    #[default]
    RequestStart,
    /// 收到响应头
    ResponseStart,
    /// SSE 首个字节到达
    SseFirstByte,
    /// 重试发生
    Retry,
    /// 请求层错误
    RequestError,
    /// 流正常结束
    StreamEnd,
    /// 端点回退
    EndpointFallback,
    /// 传输层回退
    TransportFallback,
    /// 模型选定
    ModelSelected,
    /// 请求模型与响应模型不一致
    ModelMismatch,
    /// 工具调用解析失败（缺 name / 零捕获，02 §五.4/#6）
    InvalidToolCall,
}

/// system 提示词接线方式（对齐 systemPromptWireMode）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemPromptWireMode {
    /// 原生 system 角色
    NativeSystemRole,
    /// user-prefix 前缀注入
    UserPrefix,
}

/// provider 运行诊断（对齐 ProviderDiagnostic）
///
/// 经 `provider-diagnostic` 事件广播；前端仅 logInternalError（03 §1.6）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDiagnostic {
    pub phase: ProviderDiagnosticPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<ProviderErrorKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunks: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configured_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_mismatch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_requested: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt_wire_mode: Option<SystemPromptWireMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_system_role: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt_present: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_message_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rewritten_system_message_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_role_counts: Option<serde_json::Value>,
    /// 工具调用解析失败时的部分载荷（对齐 partial）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial: Option<serde_json::Value>,
}

/// 检查点类别（对齐 RuntimeCheckpointKind）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeCheckpointKind {
    /// 工作区检查点
    WorkspaceCheckpoint,
    /// git 检查点
    GitCheckpoint,
    /// 文件快照
    FileSnapshot,
}

/// 检查点记录（对齐 RuntimeCheckpointRecord）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCheckpointRecord {
    pub id: String,
    pub kind: RuntimeCheckpointKind,
    pub label: String,
    pub tool_call_id: String,
    pub tool_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// 检查点恢复记录（对齐 RuntimeCheckpointRestoreRecord）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCheckpointRestoreRecord {
    pub checkpoint_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    /// 已恢复的文件
    pub restored: Vec<String>,
    /// 已删除的文件
    pub deleted: Vec<String>,
    /// 跳过的文件
    pub skipped: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// 上下文压缩触发点（对齐 ContextCompressionTrigger）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextCompressionTrigger {
    /// 自动触发
    Auto,
    /// 用户消息边界触发（E2 F3：hold → compact → append，压缩发生在
    /// 用户消息入队之前——用户消息 100% 保留、必在发送序列尾部）
    UserMessage,
    /// 分阶段总结触发（E2 F5：对话长度达里程碑阈值 estimate/window ≥
    /// [0.4, 0.6, 0.8] 时对完整对话产出阶段总结——tier="stage-N"、不入
    /// 丢弃段；每阶梯对话生命周期内只触发一次，随
    /// context-compression-end 的 result.trigger 登记）
    Stage,
    /// 发送前预检
    Preflight,
    /// 手动触发
    Manual,
    /// 阈值触发
    Threshold,
    /// 溢出触发
    Overflow,
    /// 空闲触发
    Idle,
    /// 不完整触发
    Incomplete,
    /// 交接触发
    Handoff,
}

/// 上下文压缩原因（对齐 ContextCompressionReason）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextCompressionReason {
    Manual,
    /// 用户消息边界（E2 F3，与 trigger=UserMessage 同源）
    UserMessage,
    /// 分阶段总结（E2 F5，与 trigger=Stage 同源：里程碑阈值触发）
    Stage,
    Threshold,
    Overflow,
    Idle,
    Incomplete,
    Handoff,
}

/// 压缩策略层（对齐 ContextCompressionPolicyTier）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextCompressionPolicyTier {
    /// 手动
    Manual,
    /// 主动式
    Proactive,
    /// 恢复式
    Recovery,
    /// 后台式
    Background,
    /// 交接
    Handoff,
}

/// 压缩策略动作（对齐 ContextCompressionPolicyAction）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContextCompressionPolicyAction {
    /// 执行压缩
    Compact,
    /// 提升为交接
    PromoteHandoff,
}

/// 压缩策略元数据（对齐 ContextCompressionPolicyMetadata）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextCompressionPolicyMetadata {
    pub tier: ContextCompressionPolicyTier,
    pub action: ContextCompressionPolicyAction,
    pub forced: bool,
    pub threshold_exceeded: bool,
    pub provider_retry: bool,
}

/// 缓存失效目标（对齐 ContextCompressionCacheBoundaryMetadata.invalidates）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompressionCacheInvalidation {
    /// prompt 稳定前缀
    PromptStablePrefix,
    /// 消息历史
    MessageHistory,
    /// 用量基线
    UsageBaseline,
    /// 易变上下文
    VolatileContext,
}

/// 压缩交接元数据（对齐 ContextCompressionHandoffMetadata）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextCompressionHandoffMetadata {
    pub trigger: ContextCompressionTrigger,
    pub reason: ContextCompressionReason,
    pub tier: ContextCompressionPolicyTier,
    pub action: ContextCompressionPolicyAction,
    pub provider_retry: bool,
    pub summary: String,
    pub compressed_message_count: u32,
    pub kept_message_count: u32,
    pub tokens_before: u64,
    pub tokens_after: u64,
    pub threshold_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_kept_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_user_message_id: Option<String>,
    #[serde(default)]
    pub completed_task_summaries: Vec<String>,
    #[serde(default)]
    pub pending_tasks: Vec<String>,
    #[serde(default)]
    pub session_events: Vec<String>,
    #[serde(default)]
    pub file_snapshot_hints: Vec<String>,
    #[serde(default)]
    pub recent_successful_commands: Vec<String>,
    #[serde(default)]
    pub recent_failed_diagnostics: Vec<String>,
}

/// 压缩缓存边界元数据（对齐 ContextCompressionCacheBoundaryMetadata）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextCompressionCacheBoundaryMetadata {
    /// 恒定字面量 "context-compression-cache-boundary"
    #[serde(default = "default_cache_boundary_kind")]
    pub kind: String,
    /// 恒定版本 1
    #[serde(default = "default_cache_boundary_version")]
    pub version: u8,
    pub stable_prefix_hash: String,
    pub cache_key: String,
    pub structured_summary_cache_key: String,
    pub structured_summary_stable_hash: String,
    pub invalidates: Vec<CompressionCacheInvalidation>,
    pub invalidation_reason: ContextCompressionReason,
    pub compressed_message_ids: Vec<String>,
    pub kept_message_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_kept_message_id: Option<String>,
}

fn default_cache_boundary_kind() -> String {
    "context-compression-cache-boundary".to_string()
}

fn default_cache_boundary_version() -> u8 {
    1
}

/// 上下文压缩记录（对齐 ContextCompressionRecord）
///
/// 作为 `context-compression-end` 事件的 `result` 载荷。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextCompressionRecord {
    pub id: String,
    pub trigger: ContextCompressionTrigger,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<ContextCompressionReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<ContextCompressionPolicyMetadata>,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_kept_message_id: Option<String>,
    #[serde(default)]
    pub compressed_message_ids: Vec<String>,
    #[serde(default)]
    pub kept_message_ids: Vec<String>,
    pub tokens_before: u64,
    pub tokens_after: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold_tokens: Option<u64>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<ContextCompressionHandoffMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_boundary: Option<ContextCompressionCacheBoundaryMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

/// 压缩块 details 扩展载荷构造（T-17，00-plan §10 轮次 2）。
///
/// 语义：`ContextCompressionRecord.details` 为自由 JSON（既有 coversUpToTurn /
/// degraded / summaryAttempts 键，ai_summary.rs 构造），本函数补「块语义」
/// 五键（camelCase，对齐 01 §4.3）：blockId / generation / prevBlockId /
/// droppedAtMs / summaryState。调用方（session-loop 轮次 4 织入面 /
/// orchestrator 轮次 2 读面）把本载荷与既有键合并后写入 details——
/// 字段级扩展不动事件类型枚举与注册表（R-H：不新增事件类型）。
///
/// `summary_state` 字面量对齐块表 state 列：awaiting | committed | retired。
pub fn compaction_block_details(
    block_id: &str,
    generation: u32,
    prev_block_id: Option<&str>,
    dropped_at_ms: i64,
    summary_state: &str,
) -> serde_json::Value {
    serde_json::json!({
        "blockId": block_id,
        "generation": generation,
        "prevBlockId": prev_block_id,
        "droppedAtMs": dropped_at_ms,
        "summaryState": summary_state,
    })
}

#[cfg(test)]
mod tests {
    use super::{compaction_block_details, ContextCompressionRecord};

    /// T-17 shape 回环：details 扩展键 camelCase 齐全、可并入既有 details
    /// 合并面、record 序列化不破坏（details 为 None 时缺省兼容）。
    #[test]
    fn compaction_block_details_shape_camel_case_roundtrip() {
        let value = compaction_block_details(
            "compacted-summary-1-2",
            1,
            Some("compacted-summary-1-1"),
            1_752_000_000_000,
            "awaiting",
        );
        assert_eq!(value.get("blockId"), Some(&serde_json::json!("compacted-summary-1-2")));
        assert_eq!(value.get("generation"), Some(&serde_json::json!(1)));
        assert_eq!(value.get("prevBlockId"), Some(&serde_json::json!("compacted-summary-1-1")));
        assert_eq!(value.get("droppedAtMs"), Some(&serde_json::json!(1_752_000_000_000i64)));
        assert_eq!(value.get("summaryState"), Some(&serde_json::json!("awaiting")));
        // camelCase 断言：snake_case 键不得出现
        assert!(value.get("block_id").is_none());
        assert!(value.get("prev_block_id").is_none());
        assert!(value.get("summary_state").is_none());

        // 与既有 details 键（coversUpToTurn 等）合并回环
        let merged = serde_json::json!({
            "coversUpToTurn": 3,
            "degraded": false,
            "summaryAttempts": 1,
            "droppedCount": 2,
        });
        let combined = {
            let mut m = merged.clone();
            for (k, v) in value.as_object().unwrap() {
                m[k] = v.clone();
            }
            m
        };
        assert_eq!(combined.get("blockId").unwrap(), &serde_json::json!("compacted-summary-1-2"));
        assert_eq!(combined.get("coversUpToTurn").unwrap(), &serde_json::json!(3));
        // 序列化回环：details 可随 record 落 JSON 且读回一致
        let json = serde_json::to_string(&serde_json::json!({ "details": combined })).unwrap();
        let back: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(back["details"]["summaryState"], "awaiting");
        assert_eq!(back["details"]["prevBlockId"], "compacted-summary-1-1");
    }

    /// 既有构造点默认 details: None 保持兼容（events_schema_version 基线
    /// 41 变体 fixture 依赖该形状；本测试钉死 None 缺省可序列化）。
    #[test]
    fn record_details_none_default_remains_compatible() {
        let record = serde_json::from_str::<ContextCompressionRecord>(r#"{
            "id": "c-1",
            "trigger": "threshold",
            "summary": "摘要",
            "compressedMessageIds": ["m1"],
            "keptMessageIds": ["m2"],
            "tokensBefore": 100,
            "tokensAfter": 10,
            "createdAt": "2026-08-08T00:00:00.000Z"
        }"#)
        .unwrap();
        assert!(record.details.is_none(), "旧载荷缺省 details 可读且为 None");
    }
}
