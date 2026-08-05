//! 会话级工具执行上下文（R3 T9：Tool::execute 引入 Context）
//!
//! `ToolContext` 承载会话级数据：`session_id`、中止令牌（`abort_token`）、
//! 审批回调通道（`ask`，R4 T10 由 session-loop 接线为真实审批通道
//! [crate 外 ApprovalChannel] / full-access 自动放行 NoopAskChannel）、
//! 工作区根目录（`workspace_root`）。
//!
//! I4-M3 起另承载写路径互斥注册表（`write_claims`，None = 未接线不强制）
//! 与声明持有者（`write_claim_holder`，子代理 run id；None = 会话主身份）——
//! 写类工具经 [crate::write_paths::claim_write_guard] 声明写路径，引擎级
//! 互斥；接线由执行器按会话装配（session-loop ToolExecutor / M2 子代理
//! 执行上下文）。
//!
//! 工具不再持有 workspace_root 等会话数据（原 BuiltinToolConfig 注入），
//! 统一从 ctx 读取——R4 T10 权限规则引擎（requires_approval/dangerous
//! 判定挂 ctx.ask 通道、审批等待期支持 abort_token 取消）已接线。

use crate::definition::ToolError;
use crate::write_paths::WritePathRegistry;
use async_trait::async_trait;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 中止令牌（std 同步原语：共享 `Arc<AtomicBool>`）
///
/// tokio-util 不在依赖树，按任务书选型用 std 同步原语实现；
/// 语义对齐 TS AbortSignal 的 is_aborted。可 Clone 传递，线程安全。
/// 本层保持轻量、无 tokio 运行时绑定；会话级中止信号与批执行器
/// 的中止竞速接线（T09.9 Q21）由上层（session-loop）负责，T10
/// 审批等待期将复用本令牌取消。
#[derive(Debug, Clone, Default)]
pub struct AbortToken {
    aborted: Arc<AtomicBool>,
}

impl AbortToken {
    /// 新建未触发的中止令牌
    pub fn new() -> Self {
        Self::default()
    }

    /// 触发中止（幂等）
    pub fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
    }

    /// 是否已触发中止
    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }
}

/// 审批裁决结果（T10 权限规则引擎消费；T9 仅类型/签名就位）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskDecision {
    /// 放行执行
    Allowed,
    /// 拒绝执行（附原因）
    Denied { reason: String },
}

/// 审批回调通道（T9 占位：类型与签名就位，具体审批逻辑 T10 接线）
///
/// 发起一次审批请求并等待裁决。`tool_name` / `args` 为待审批工具调用，
/// 供裁决方构造审批请求事件（对齐 T10：approval 事件真实出站）。
#[async_trait]
pub trait AskChannel: Send + Sync + std::fmt::Debug {
    /// 发起审批请求并等待裁决
    async fn ask(
        &self,
        tool_name: &str,
        args: &serde_json::Value,
    ) -> Result<AskDecision, ToolError>;
}

/// 默认 no-op 审批通道：直接放行（未接线时的兜底行为）
///
/// T9 阶段 `ToolContext.ask` 缺省为 None（未接线）；消费方可显式注入
/// 本通道以保持「可提问」语义不变（T10 替换为真实审批实现）。
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopAskChannel;

#[async_trait]
impl AskChannel for NoopAskChannel {
    async fn ask(
        &self,
        _tool_name: &str,
        _args: &serde_json::Value,
    ) -> Result<AskDecision, ToolError> {
        Ok(AskDecision::Allowed)
    }
}

/// 审批回调（trait 对象引用；`Option<AskCallback>` = 未接线）
pub type AskCallback = Arc<dyn AskChannel>;

/// 会话级工具执行上下文（Tool::execute 新签名入参，R3 T9）
#[derive(Debug, Clone)]
pub struct ToolContext {
    /// 会话标识（幂等域与事件关联用）
    pub session_id: String,
    /// 中止令牌（工具执行 / 审批等待期间可自查 `is_aborted`）
    pub abort_token: AbortToken,
    /// 审批回调通道（T10 接线；None = 未接线，按放行语义兜底）
    pub ask: Option<AskCallback>,
    /// 工作区根目录：路径类工具相对路径解析与越界校验基准
    pub workspace_root: PathBuf,
    /// 写路径互斥注册表（I4-M3：None = 未接线，写工具不强制互斥；
    /// 接线由执行器按会话装配，M2 子代理执行上下文注入）
    pub write_claims: Option<Arc<WritePathRegistry>>,
    /// 写声明持有者（I4-M3：子代理 run id；None = 会话主身份 session_id，
    /// 用于工具执行期声明归属——同持有者声明不互斥）
    pub write_claim_holder: Option<String>,
    /// 探索类文档配额上下文（I6-M11 C5：read-only 子代理写文档配额检查；
    /// None = 非探索类或未接线，不检查）
    pub explore_docs_quota: Option<ExploreDocsQuotaContext>,
    /// 后台任务管理器（T-AB-02：None = 未接线，shell 超时保持「树杀」现状；
    /// 参照 write_claims 注入模式，由执行器按会话装配；工具执行期优先
    /// 读本字段，回退 BuiltinToolConfig.background_manager）
    pub background: Option<Arc<dyn crate::background::BackgroundTaskManager>>,
    /// 产出目录解析服务（T-EG-08 REQ-G01：None = 未接线，resolve_output_dir
    /// 返回 common.unsupported 结构化错误；引擎侧装配 OutputWorkspace 后
    /// 注入——对齐 explore_docs_quota 的会话级注入模式）
    pub output_dir: Option<Arc<dyn crate::tools::output_dir::OutputDirResolver>>,
    /// 会话日志根目录（T-AB-03：同步命令截断落盘
    /// `<log_root>/sessions/<session_id>/<ts>-<seq>.log`；None = 截断不落盘，
    /// 仅返回截断结果无 logPath，不失败）
    pub log_root: Option<PathBuf>,
}

/// 探索类文档配额检查上下文（C5，I6-M11）
///
/// 语义：探索类（capabilityMode=read-only 或 researcher 角色）子代理每会话
/// 至多写 1 份文档，且必须由主 agent 显式分配（spawn 时给配额凭证）。
/// 超配额返回结构化错误，run 不中断。持久化经 [crate::explore_quota::ExploreDocsQuotaStore]
/// 后端（引擎侧以 session_meta 实现）注入。
#[derive(Debug, Clone)]
pub struct ExploreDocsQuotaContext {
    /// 会话标识（配额按会话计数，多 run 共享）
    pub session_id: String,
    /// 当前 run 标识（消耗计数时登记 last consumer run）
    pub run_id: String,
    /// 配额凭证（spawn 时主 agent 注入；false = 未分配，拒绝写文档）
    pub granted: bool,
    /// 配额上限（默认 1，可配）
    pub quota: u32,
    /// 配额计数后端（None = 无持久化，按零消耗检查）
    pub store: Option<Arc<dyn crate::explore_quota::ExploreDocsQuotaStore>>,
}

impl ToolContext {
    /// 新建会话上下文（未触发中止令牌、未接线审批通道、未接线写路径互斥）
    pub fn new(session_id: impl Into<String>, workspace_root: PathBuf) -> Self {
        Self {
            session_id: session_id.into(),
            abort_token: AbortToken::new(),
            ask: None,
            workspace_root,
            write_claims: None,
            write_claim_holder: None,
            explore_docs_quota: None,
            background: None,
            output_dir: None,
            log_root: None,
        }
    }
}

/// 测试工厂：各工具测试注入的默认会话上下文
///
/// - session_id 固定 mock 值；
/// - workspace_root 为当前目录（路径类测试用
///   `ToolContext { workspace_root: <ws>, ..create_mock_tool_context() }`
///   覆盖）；
/// - abort_token 未触发；ask 未接线（放行语义）。
pub fn create_mock_tool_context() -> ToolContext {
    ToolContext {
        session_id: "mock-session".to_string(),
        abort_token: AbortToken::new(),
        ask: None,
        workspace_root: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        write_claims: None,
        write_claim_holder: None,
        explore_docs_quota: None,
        background: None,
        output_dir: None,
        log_root: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn abort_token_starts_unaborted_and_flips() {
        let token = AbortToken::new();
        assert!(!token.is_aborted());
        token.abort();
        assert!(token.is_aborted());
        // 幂等触发
        token.abort();
        assert!(token.is_aborted());
        // Clone 共享同一标志
        let clone = token.clone();
        assert!(clone.is_aborted());
    }

    #[tokio::test]
    async fn noop_ask_channel_allows() {
        let channel = NoopAskChannel;
        let decision = channel.ask("shell_command", &json!({ "command": "git push" })).await.unwrap();
        assert_eq!(decision, AskDecision::Allowed);
    }

    #[test]
    fn mock_context_factory_shapes() {
        let ctx = create_mock_tool_context();
        assert_eq!(ctx.session_id, "mock-session");
        assert!(!ctx.abort_token.is_aborted());
        assert!(ctx.ask.is_none());
        assert!(ctx.workspace_root.is_absolute() || !ctx.workspace_root.as_os_str().is_empty());

        // ToolContext::new 便捷构造
        let ctx = ToolContext::new("sess-1", PathBuf::from("C:/work"));
        assert_eq!(ctx.session_id, "sess-1");
        assert_eq!(ctx.workspace_root, PathBuf::from("C:/work"));
    }
}
