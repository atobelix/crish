//! agent-tools —— 工具注册表与内置工具（任务书 B5.1 / B5.2 / B5.3）
//!
//! 本 crate 是工具执行域（B5）的骨架与内置工具实现：
//! - `definition`：ToolDefinition（声明）与 Tool trait（执行面）、ToolError
//! - `permission`：权限规则引擎（R4 T10）——dangerous / requires_approval +
//!   permissionMode 三态判定（Allow / Deny / NeedsApproval）
//! - `context`：ToolContext 会话级执行上下文（session_id / abort_token / ask /
//!   workspace_root，R3 T9 引入，T10 权限引擎消费）
//! - `registry`：ToolRegistry 注册表（注册/查找/列出，保序）
//! - `middleware`：ToolMiddleware 前置/后置钩子抽象与示例后置实现。
//!   生产消费方：session-loop ToolExecutor（审批通过后、执行前接链，
//!   优先级语义见 docs/multi-agent-repair/06-tool-middleware-hook-接线决策.md）
//! - `backup`：删除前自动备份中间件（I3-S10b）——写类工具执行前复制快照
//!   进回收站域（TrashService::snapshot），失败即 Block（安全优先）
//! - `output`：工具输出结构化——序列化（text 优先）与预算截断（B5.3）
//! - `idempotency`：工具幂等守卫——已执行结果去重（B5.3）
//! - `executor`：最小工具执行器——单工具执行 + 输出策略 + 幂等检查（B5.3，供 B3.5 消费）
//! - `streaming`：S1 流式输出协议——ToolStream / ToolProgress / 构造助手
//!   （TOOLS-01 §3.1，[Progress*, Terminal] 流形状与执行器流式消费路径）
//! - `tools`：内置工具（fs / shell / search / diff，B5.2），
//!   复用 conex-fs 路径安全、conex-sandbox 命令门禁、conex-search 模糊搜索、conex-diff
//! - `mcp`：MCP 桥（B5.4）——server 配置管理（servers）与 stdio 客户端桥（bridge），
//!   远端 MCP 工具经名称前缀适配为 Tool 进入统一执行器

pub mod context;
pub mod audit;
pub mod background;
pub mod backup;
// T-40（记忆韧性轮次 5）：压缩块只读访问契约（CompressionContextStore
// trait + BlockHit/BlockContent）——agent-tools 定义、引擎侧（conex-db /
// orchestrator）实现注入；search_context / decompress_context 消费本契约，
// 生产代码保持叶子依赖（不引入 conex-db）
pub mod compression_store;
// W4-A/B/F + Round7：笔记后端契约（NoteBackend trait + MemoryNoteBackend）——
// 引擎侧实现注入；query_blocks / document_outline / document_get_md /
// document_apply_md / send_to_note / block_batch / block_insert /
// block_update / block_delete / block_move 消费本契约，
// 生产代码保持叶子依赖（不引入 doc-collab/store）
pub mod note_backend;
// W4-B/F：笔记工具审批名单（safe / write × plan|ask|full）
pub mod note_permission;
// W4-F：safeActions × Effects × Source **表驱动**矩阵起点（A-AGT-06）
// ≠ EL-05；≠ W6-E；≠ A-AGT 全表关闭
pub mod note_action_matrix;
pub mod definition;
pub mod explore_quota;
pub mod executor;
pub mod idempotency;
pub mod mcp;
pub mod middleware;
pub mod output;
pub mod permission;
pub mod readonly;
pub mod registry;
pub mod revert;
pub mod revert_guard;
pub mod subagent_inject;
pub mod streaming;
pub mod tools;
pub mod write_paths;

pub use context::{
    create_mock_tool_context, AbortToken, AskCallback, AskChannel, AskDecision, NoopAskChannel,
    ToolContext,
};
pub use audit::{
    security_audit_event, AuditSink, NoopAuditSink, RecordingAuditSink, SecurityAuditSink,
};
// T-AB-02（后台任务契约，冻结接口 #1/#2）：trait 与数据结构导出——
// 壳层（A3 注册表）与 R-AB2 工具面按冻结形状消费
pub use background::{
    BackgroundAdoptRequest, BackgroundTaskInfo, BackgroundTaskManager, BackgroundTaskRef,
    BackgroundTaskStatus, KillResult, LogSlice, ResourceSample, TaskState,
};
pub use definition::{default_input_schema, Tool, ToolDefinition, ToolError};
pub use executor::{
    execute_stream_with_output_policy, execute_with_output_policy, ExecutorContext,
    ToolExecutionPolicy, ToolResult,
};
// S1（TOOLS-01 §3.1.3）：流式输出协议冻结面——ToolStream 类型签名与
// ToolStreamItem/ToolProgress 形状，消费方（执行器/A2 事件映射）按此导入
pub use streaming::{
    terminal_only, with_progress, ContentBlock, ToolProgress, ToolStream, ToolStreamItem,
};
pub use permission::{
    decide, decide_command_with_revert, PermissionMode, PermissionVerdict,
};
pub use idempotency::{
    domain_for, execution_key, IdempotencyContext, IdempotencyDecision, IdempotencyStore,
    ToolIdempotencyGuard,
};
pub use mcp::{
    McpClientBridge, McpServerConfig, McpServerRuntimeState, McpServerSession, McpServerStore,
    McpToolAdapter, McpToolInfo, McpTransport,
};
pub use middleware::{
    AfterExecuteResult, BeforeExecuteResult, MiddlewareTimeoutConfig, ToolExecutionContext,
    ToolMiddleware,
};
pub use backup::{default_backup_tools, BackupMiddleware, BUILTIN_BACKUP_TOOLS};
// T06.3 Q18：RecordingMiddleware / RecordingRecord 仅测试使用（生产零
// 引用），导出面标注 #[cfg(test)]
#[cfg(test)]
pub use middleware::{RecordingMiddleware, RecordingRecord};
pub use output::{
    budget_text_for_context, output_size, stringify_tool_output, summarize, BudgetedText,
    OutputSize, SummarizedOutput, ToolOutputBudgetOptions,
};
pub use registry::ToolRegistry;
pub use revert::{
    InMemoryRevertCounterStore, RevertArea, RevertAssessor, RevertCounterSnapshot,
    RevertCounterStore, RevertPolicy, RevertTarget, RevertThresholds, SemanticRevertAssessor,
    DEFAULT_REVERT_MAX_FILES, DEFAULT_REVERT_MAX_LINES, DEFAULT_REVERT_MAX_REF_AGE_HOURS,
    REVERT_APPROVER, REVERT_GATE_GUIDANCE, SESSION_META_KEY_REVERT_MAX_FILES,
    SESSION_META_KEY_REVERT_MAX_LINES, SESSION_META_KEY_REVERT_MAX_REF_AGE_HOURS,
    SESSION_META_KEY_REVERT_STREAK_COUNT, SESSION_META_KEY_REVERT_STREAK_LAST_AT,
};
// I3-S7（C4 连续回退计数）：时窗归零 / 第 2 次必审批判定 / 统一回退护栏
// （面积 + 连续合并），接线契约见 revert_guard 模块文档（S6 判定点挂载）
pub use revert_guard::{
    combine_revert_gate, evaluate_streak, guard_reasons, now_unix, parse_window_seconds,
    RevertCounterGuard, RevertGuardOutcome, RevertGuardReason, StreakVerdict,
    DEFAULT_REVERT_WINDOW_SECONDS, REVERT_WINDOW_SECONDS_KEY,
};
// I4-M4（C2 创建时间注入 + git 回退谨慎指引）+ F5 EG（REQ-E03 注释保留
// 注入段）：注入内容模块——started_at 注入段 / 续跑不刷新解析 / git 回退
// 指引固定文案 / ref 年代判定 / 注释保留固定文案，经 M1 注入点只读挂载
// （engine.rs build_context 主体归 C10，M4 不并写）
pub use subagent_inject::{
    comment_preservation_section, git_revert_caution_section, iso8601_from_epoch_ms,
    ref_older_than_threshold, resolve_started_at, started_at_section, subagent_session_injections,
    COMMENT_PRESERVATION_TITLE, DEFAULT_REF_AGE_THRESHOLD_HOURS, DYNAMIC_MARKER,
    REVERT_CAUTION_TITLE, STARTED_AT_SECTION_TITLE,
};
pub use note_backend::{
    apply_result_json, block_batch_result_json, MemoryNoteBackend, NoteApplyMdRequest,
    NoteApplyMdResult, NoteApplyMode, NoteBackend, NoteBackendError, NoteBackendHandle,
    NoteBatchTokens, NoteBlockBatchRequest, NoteBlockBatchResult, NoteBlockDeleteRequest,
    NoteBlockDeleteResult, NoteBlockInsertRequest, NoteBlockInsertResult, NoteBlockMoveRequest,
    NoteBlockMoveResult, NoteBlockOp, NoteBlockOpKind, NoteBlockOpPreview, NoteBlockUpdateRequest,
    NoteBlockUpdateResult,
    NoteLossyItem, NoteLossyReport, NoteOutline, NoteOutlineNode, NoteQueryBlockHit,
    NoteQueryBlocksParams, NoteQueryBlocksResult, DEFAULT_BATCH_TOKEN_TTL,
};
pub use note_permission::{
    decide_note_tool, is_note_safe_tool, is_note_tool, is_note_write_tool, plan_denies_note_tool,
    NOTE_SAFE_TOOLS, NOTE_WRITE_TOOLS,
};
pub use note_action_matrix::{
    decide_from_matrix, has_local_write, is_matrix_safe, lookup_action, plan_denies_matrix_tool,
    safe_tool_names, write_tool_names, ActionEffect, ActionSource, NoteActionRow,
    NOTE_ACTION_MATRIX,
};
pub use tools::{
    register_builtin_tools, register_builtin_tools_with_config, BuiltinToolConfig,
};
// T-CF-05（G5 契约面 / REQ-C01）：定时器契约导出——引擎侧 TimerRegistry
// 适配（T-CF-06）与注册面按冻结形状消费；工具类本身为 crate 内注册面专用
// （对齐 wait_subagents / subagent 先例，不导出）。[TimerCondition] /
// [TimerHandle] 属 conex-types timer 模块（§4.1 冻结承载），引擎侧直接走
// conex_types::timer 导入，不在本 crate 重复 re-export
pub use tools::set_timer::{TimerChannel, TimerError, MAX_TIMER_DURATION_SECONDS};
// I4-M3（写路径互斥与只读裁剪）：write_paths 引擎级互斥 + readonly 只读
// 子代理工具集裁剪；claim_write_guard 为 crate 内部工具接线助手，不导出
pub use readonly::{
    filter_readonly_registry, READONLY_TOOL_NAMES, WRITE_TOOL_NAMES,
};
pub use write_paths::{
    validate_write_path, ClaimMode, WriteClaimGuard, WritePathClaim, WritePathConflict,
    WritePathRegistry, DEFAULT_CLAIM_TTL_MS,
};

#[cfg(test)]
pub(crate) mod test_support {
    //! 测试共用的示例工具（echo）与锁毒化注入工具，验证 execute 闭环

    use crate::definition::{Tool, ToolDefinition, ToolError};
    use async_trait::async_trait;

    /// 毒化 std `Mutex`（PE-07 T07.6 测试注入）：在持锁线程内 panic，
    /// 使锁进入中毒状态（PoisonError 注入），验证恢复式处理不 panic。
    pub(crate) fn poison_std_lock<T: std::marker::Send>(lock: &std::sync::Mutex<T>) {
        let _ = std::panic::catch_unwind(|| {
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    let _guard = lock.lock().unwrap();
                    panic!("模拟持锁 panic（毒化锁）");
                });
            });
        });
    }

    /// 毒化 std `RwLock`（PE-07 T07.6 测试注入）：持写锁线程内 panic，
    /// 使读/写路径均进入中毒状态，验证恢复式处理不 panic。
    pub(crate) fn poison_rw_lock<T: std::marker::Send + std::marker::Sync>(
        lock: &std::sync::RwLock<T>,
    ) {
        let _ = std::panic::catch_unwind(|| {
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    let _guard = lock.write().unwrap();
                    panic!("模拟持锁 panic（毒化锁）");
                });
            });
        });
    }

    /// 测试用 echo 工具：把入参原样包进 {"echo": ...} 返回
    pub(crate) struct EchoTool {
        pub(crate) def: ToolDefinition,
    }

    impl EchoTool {
        pub(crate) fn new(name: &str) -> Self {
            Self {
                def: ToolDefinition {
                    name: name.to_string(),
                    description: "回显入参".to_string(),
                    input_schema: serde_json::json!({ "type": "object", "properties": {} }),
                    dangerous: false,
                    fatal_on_error: false,
                },
            }
        }
    }

    #[async_trait]
    impl Tool for EchoTool {
        fn name(&self) -> &str {
            &self.def.name
        }

        fn definition(&self) -> &ToolDefinition {
            &self.def
        }

        async fn execute(
            &self,
            _ctx: &crate::context::ToolContext,
            args: serde_json::Value,
        ) -> Result<serde_json::Value, ToolError> {
            Ok(serde_json::json!({ "echo": args }))
        }
    }
}
