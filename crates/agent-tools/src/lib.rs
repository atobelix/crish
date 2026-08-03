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
//! - `tools`：内置工具（fs / shell / search / diff，B5.2），
//!   复用 conex-fs 路径安全、conex-sandbox 命令门禁、conex-search 模糊搜索、conex-diff
//! - `mcp`：MCP 桥（B5.4）——server 配置管理（servers）与 stdio 客户端桥（bridge），
//!   远端 MCP 工具经名称前缀适配为 Tool 进入统一执行器

pub mod context;
pub mod audit;
pub mod backup;
pub mod definition;
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
pub mod tools;
pub mod write_paths;

pub use context::{
    create_mock_tool_context, AbortToken, AskCallback, AskChannel, AskDecision, NoopAskChannel,
    ToolContext,
};
pub use audit::{
    security_audit_event, AuditSink, NoopAuditSink, RecordingAuditSink, SecurityAuditSink,
};
pub use definition::{default_input_schema, Tool, ToolDefinition, ToolError};
pub use executor::{execute_with_output_policy, ExecutorContext, ToolExecutionPolicy, ToolResult};
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
    AfterExecuteResult, BeforeExecuteResult, ToolExecutionContext, ToolMiddleware,
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
// I4-M4（C2 创建时间注入 + git 回退谨慎指引）：注入内容模块——started_at
// 注入段 / 续跑不刷新解析 / git 回退指引固定文案 / ref 年代判定，经 M1
// 注入点只读挂载（engine.rs build_context 主体归 C10，M4 不并写）
pub use subagent_inject::{
    git_revert_caution_section, iso8601_from_epoch_ms, ref_older_than_threshold,
    resolve_started_at, started_at_section, subagent_session_injections,
    DEFAULT_REF_AGE_THRESHOLD_HOURS, DYNAMIC_MARKER, REVERT_CAUTION_TITLE,
    STARTED_AT_SECTION_TITLE,
};
pub use tools::{
    register_builtin_tools, register_builtin_tools_with_config, BuiltinToolConfig,
};
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
