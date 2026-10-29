//! 会话级工具执行上下文（R3 T9：Tool::execute 引入 Context）
//!
//! `ToolContext` 承载会话级数据：`session_id`、中止令牌（`abort_token`，
//! 执行器以 run 级信号的子令牌注入，父中止即级联）、工作区根目录
//! （`workspace_root`）。审批裁决不经工具上下文：放行判定唯一入口在
//! session-loop `exec_verdict::call_verdict`，等待审批由执行器审批门承担。
//!
//! I4-M3 起另承载写路径互斥注册表（`write_claims`，None = 未接线不强制）
//! 与声明持有者（`write_claim_holder`，子代理 run id；None = 会话主身份）——
//! 写类工具经 [crate::write_paths::claim_write_guard] 声明写路径，引擎级
//! 互斥；接线由执行器按会话装配（session-loop ToolExecutor / M2 子代理
//! 执行上下文）。
//!
//! 工具不再持有 workspace_root 等会话数据（原 BuiltinToolConfig 注入），
//! 统一从 ctx 读取。

use crate::permission::PermissionMode;
use crate::write_paths::WritePathRegistry;
use std::future::{poll_fn, Future};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::Poll;
use tokio::sync::Notify;

/// 中止令牌：Clone 共享同一中止状态，支持父子级联。
///
/// - 同步状态查询（[Self::is_aborted]）与零轮询异步等待（[Self::wait_aborted]）；
/// - [Self::child_of] 派生子令牌：父中止 ⇒ 子视为已中止且其等待方被唤醒；
///   子中止不回传父。级联由子令牌持有父引用、在查询/等待时沿链判定实现——
///   不派生后台监听任务，生命周期随令牌 drop 自然结束。
#[derive(Debug, Clone, Default)]
pub struct AbortToken {
    state: Arc<AbortState>,
}

/// 单个令牌节点的中止状态（`parent` 为级联来源）
#[derive(Debug, Default)]
struct AbortState {
    aborted: AtomicBool,
    notify: Notify,
    parent: Option<AbortToken>,
}

impl AbortToken {
    /// 新建未触发的根令牌
    pub fn new() -> Self {
        Self::default()
    }

    /// 派生 `parent` 的子令牌（父已中止则子创建即为已中止）
    pub fn child_of(parent: &AbortToken) -> Self {
        Self {
            state: Arc::new(AbortState {
                parent: Some(parent.clone()),
                ..AbortState::default()
            }),
        }
    }

    /// 触发中止（幂等；广播唤醒本令牌及其后代令牌上的等待方）
    pub fn abort(&self) {
        self.state.aborted.store(true, Ordering::SeqCst);
        self.state.notify.notify_waiters();
    }

    /// 本令牌或任一祖先令牌已触发中止
    pub fn is_aborted(&self) -> bool {
        self.chain()
            .any(|state| state.aborted.load(Ordering::SeqCst))
    }

    /// 异步等待本令牌或任一祖先触发中止（已触发立即返回，零轮询）
    pub async fn wait_aborted(&self) {
        // 先登记链上全部 Notified（创建即可接收 notify_waiters），再复查状态：
        // 登记与复查之间发生的 abort 必被已登记的等待方接住，不丢唤醒。
        let mut waiters: Vec<Pin<Box<tokio::sync::futures::Notified<'_>>>> = self
            .chain()
            .map(|state| Box::pin(state.notify.notified()))
            .collect();
        if self.is_aborted() {
            return;
        }
        poll_fn(|cx| {
            if waiters
                .iter_mut()
                .any(|waiter| waiter.as_mut().poll(cx).is_ready())
            {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
        .await;
    }

    /// 自本节点起沿父链向上的状态序列
    fn chain(&self) -> impl Iterator<Item = &AbortState> {
        std::iter::successors(Some(&*self.state), |state| {
            state.parent.as_ref().map(|parent| &*parent.state)
        })
    }
}

/// 会话级工具执行上下文（Tool::execute 新签名入参，R3 T9）
#[derive(Debug, Clone)]
pub struct ToolContext {
    /// 会话标识（幂等域与事件关联用）
    pub session_id: String,
    /// 中止令牌（工具执行 / 审批等待期间可自查 `is_aborted`）
    pub abort_token: AbortToken,
    /// 工作区根目录：路径类工具相对路径解析与越界校验基准
    pub workspace_root: PathBuf,
    /// 当前生效的权限模式（上下文记录用；**工具不得据此自行判定放行**——
    /// 放行裁决唯一入口 = `session-loop::exec_verdict::call_verdict`）
    pub permission_mode: PermissionMode,
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
    /// 压缩块只读访问服务（T-40 / 00-plan §7：None = 未接线，
    /// search_context / decompress_context 返回 common.unsupported 结构化
    /// 错误；引擎侧以 conex-db compression_blocks 实现
    /// [crate::compression_store::CompressionContextStore] 后注入——
    /// 对齐 output_dir 的 Option + dyn trait 执行期装配模式，生产代码
    /// 保持叶子依赖，会话作用域由实现方绑定）
    pub compression_store: Option<Arc<dyn crate::compression_store::CompressionContextStore>>,
    /// 笔记后端（W4-A/B + Round7：None = 未接线，query_blocks /
    /// document_outline / document_get_md / document_apply_md / send_to_note
    /// 返回 `note_backend_unwired` 占位；引擎侧实现
    /// [crate::note_backend::NoteBackend] 后注入——**禁止** agent-tools
    /// 硬依赖 conex-doc-collab / workspace-store，保持叶子依赖）
    pub note_backend: Option<Arc<dyn crate::note_backend::NoteBackend>>,
    /// 工具调用 id（D-02 LK-01：唯一生产构造点在引擎工具执行单点
    /// `exec_single.rs` 注入 `call.id`；工具侧审计/发射时填充；
    /// None = 非工具调用上下文（mock/测试/引擎命令直连））
    pub tool_call_id: Option<String>,
    /// 子代理任务类型（task_type：commit / implementation / analysis 等；None = 主 agent 或未指定，BC10-6）
    pub task_type: Option<String>,
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
    /// 新建会话上下文（未触发中止令牌、未接线写路径互斥）
    pub fn new(session_id: impl Into<String>, workspace_root: PathBuf) -> Self {
        Self {
            session_id: session_id.into(),
            abort_token: AbortToken::new(),
            workspace_root,
            permission_mode: PermissionMode::default(),
            write_claims: None,
            write_claim_holder: None,
            explore_docs_quota: None,
            background: None,
            output_dir: None,
            log_root: None,
            compression_store: None,
            note_backend: None,
            tool_call_id: None,
            task_type: None,
        }
    }
}

/// 测试工厂：各工具测试注入的默认会话上下文
///
/// - session_id 固定 mock 值；
/// - workspace_root 为当前目录（路径类测试用
///   `ToolContext { workspace_root: <ws>, ..create_mock_tool_context() }`
///   覆盖）；
/// - abort_token 未触发。
pub fn create_mock_tool_context() -> ToolContext {
    ToolContext {
        session_id: "mock-session".to_string(),
        abort_token: AbortToken::new(),
        workspace_root: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        permission_mode: PermissionMode::default(),
        write_claims: None,
        write_claim_holder: None,
        explore_docs_quota: None,
        background: None,
        output_dir: None,
        log_root: None,
        compression_store: None,
        note_backend: None,
        tool_call_id: None,
        task_type: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// R1：父中止 ⇒ 子已中止，且子上的等待方 100ms 内被唤醒
    #[tokio::test]
    async fn child_token_follows_parent_abort_and_wakes_waiter() {
        let parent = AbortToken::new();
        let child = AbortToken::child_of(&parent);
        let waiter = {
            let child = child.clone();
            tokio::spawn(async move { child.wait_aborted().await })
        };
        tokio::task::yield_now().await;
        assert!(!child.is_aborted());
        parent.abort();
        assert!(child.is_aborted());
        tokio::time::timeout(std::time::Duration::from_millis(100), waiter)
            .await
            .expect("父中止后子令牌等待方应在 100ms 内返回")
            .expect("等待任务不应 panic");
    }

    /// R1：子中止不影响父
    #[test]
    fn child_abort_does_not_propagate_to_parent() {
        let parent = AbortToken::new();
        let child = AbortToken::child_of(&parent);
        child.abort();
        assert!(child.is_aborted());
        assert!(!parent.is_aborted());
    }

    /// R1：自已中止的父派生的子令牌创建即为已中止，等待立即返回
    #[tokio::test]
    async fn child_of_aborted_parent_starts_aborted() {
        let parent = AbortToken::new();
        parent.abort();
        let child = AbortToken::child_of(&parent);
        assert!(child.is_aborted());
        tokio::time::timeout(std::time::Duration::from_millis(100), child.wait_aborted())
            .await
            .expect("已中止令牌的等待应立即返回");
    }

    /// 多级级联：祖父中止唤醒孙令牌等待方
    #[tokio::test]
    async fn grandparent_abort_wakes_grandchild_waiter() {
        let root = AbortToken::new();
        let grandchild = AbortToken::child_of(&AbortToken::child_of(&root));
        let waiter = {
            let grandchild = grandchild.clone();
            tokio::spawn(async move { grandchild.wait_aborted().await })
        };
        tokio::task::yield_now().await;
        root.abort();
        tokio::time::timeout(std::time::Duration::from_millis(100), waiter)
            .await
            .expect("祖先中止后孙令牌等待方应在 100ms 内返回")
            .expect("等待任务不应 panic");
    }

    /// 级联不留存活引用：子令牌 drop 后父状态仅剩自身持有
    #[test]
    fn dropped_child_releases_parent() {
        let parent = AbortToken::new();
        let child = AbortToken::child_of(&parent);
        assert_eq!(Arc::strong_count(&parent.state), 2);
        drop(child);
        assert_eq!(Arc::strong_count(&parent.state), 1);
    }

    #[test]
    fn mock_context_factory_shapes() {
        let ctx = create_mock_tool_context();
        assert_eq!(ctx.session_id, "mock-session");
        assert!(!ctx.abort_token.is_aborted());
        assert!(ctx.workspace_root.is_absolute() || !ctx.workspace_root.as_os_str().is_empty());

        // ToolContext::new 便捷构造
        let ctx = ToolContext::new("sess-1", PathBuf::from("C:/work"));
        assert_eq!(ctx.session_id, "sess-1");
        assert_eq!(ctx.workspace_root, PathBuf::from("C:/work"));
    }
}
