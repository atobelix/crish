use super::super::*;
use super::fixture::*;
use crate::hooks::{
    HookAction, HookError, HookEvent, HookEventKind, HookFailStrategy, HookHandler, HookRegistry,
};
use agent_tools::definition::Tool;
use conex_types::tool::ToolConcurrency;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// 插件钩子测试替身：记录 tool.post 事件（tool_name, is_error）
pub(super) struct SpyHook {
    pub(super) name: String,
    pub(super) posts: Arc<Mutex<Vec<(String, bool)>>>,
    pub(super) action: Option<HookAction>,
    pub(super) err: Option<HookError>,
}

impl SpyHook {
    pub(super) fn observing(name: &str) -> Self {
        Self {
            name: name.to_string(),
            posts: Arc::new(Mutex::new(Vec::new())),
            action: None,
            err: None,
        }
    }

    pub(super) fn blocking(name: &str) -> Self {
        Self {
            name: name.to_string(),
            posts: Arc::new(Mutex::new(Vec::new())),
            action: Some(HookAction::Block {
                reason: "钩子拦截".into(),
            }),
            err: None,
        }
    }

    pub(super) fn failing(name: &str) -> Self {
        Self {
            name: name.to_string(),
            posts: Arc::new(Mutex::new(Vec::new())),
            action: None,
            err: Some(HookError::new("hook boom")),
        }
    }

    pub(super) fn posts(&self) -> Vec<(String, bool)> {
        self.posts.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

#[async_trait::async_trait]
impl HookHandler for SpyHook {
    fn name(&self) -> &str {
        &self.name
    }
    async fn handle(&self, event: &HookEvent) -> Result<HookAction, HookError> {
        if let HookEvent::ToolPost {
            tool_name,
            is_error,
            ..
        } = event
        {
            self.posts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((tool_name.clone(), *is_error));
        }
        if let Some(err) = &self.err {
            return Err(err.clone());
        }
        Ok(self.action.clone().unwrap_or(HookAction::Continue))
    }
}

/// 插件钩子测试替身（tool.error 版）：记录 (tool_name, error 文案)
pub(super) struct ToolErrorSpyHook {
    pub(super) name: String,
    pub(super) errors: Arc<Mutex<Vec<(String, String)>>>,
}

#[async_trait::async_trait]
impl HookHandler for ToolErrorSpyHook {
    fn name(&self) -> &str {
        &self.name
    }
    async fn handle(&self, event: &HookEvent) -> Result<HookAction, HookError> {
        if let HookEvent::ToolError {
            tool_name, error, ..
        } = event
        {
            self.errors
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((tool_name.clone(), error.clone()));
        }
        Ok(HookAction::Continue)
    }
}

#[tokio::test]
async fn hook_tool_pre_block_prevents_execution() {
    let tool = Arc::new(CountingEchoTool {
        calls: Arc::new(AtomicUsize::new(0)),
    });
    let reg = registry_with(vec![Arc::clone(&tool) as Arc<dyn Tool>]);
    let registry = HookRegistry::new();
    registry.register(
        HookEventKind::ToolPre,
        HookFailStrategy::Swallow,
        Arc::new(SpyHook::blocking("blocker")) as Arc<dyn HookHandler>,
    );
    let exec = ToolExecutor::new(reg).with_hooks(Some(Arc::new(registry)));
    let calls = vec![call("c1", "countecho", ToolConcurrency::Sequential)];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    let r = &out.results[0];
    assert_eq!(r.error_kind, Some(ToolErrorKind::ExecutionFailed));
    assert!(
        r.error_message
            .as_deref()
            .unwrap_or_default()
            .contains("tool.pre 钩子阻止"),
        "tool.pre 阻止文案：{:?}",
        r.error_message
    );
    assert_eq!(
        tool.calls.load(Ordering::SeqCst),
        0,
        "tool.pre 阻止时工具不执行"
    );
}

#[tokio::test]
async fn hook_tool_post_receives_success_and_failure() {
    let reg = registry_with(vec![Arc::new(EchoTool), Arc::new(FailTool)]);
    let registry = HookRegistry::new();
    let spy = Arc::new(SpyHook::observing("spy"));
    registry.register(
        HookEventKind::ToolPost,
        HookFailStrategy::Swallow,
        Arc::clone(&spy) as Arc<dyn HookHandler>,
    );
    let exec = ToolExecutor::new(reg).with_hooks(Some(Arc::new(registry)));
    let calls = vec![
        call("c1", "echo", ToolConcurrency::Sequential),
        call("c2", "fail", ToolConcurrency::Sequential),
    ];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    assert!(out.results[0].is_ok());
    assert_eq!(
        out.results[1].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    assert_eq!(
        spy.posts(),
        vec![("echo".to_string(), false), ("fail".to_string(), true),],
        "tool.post 应广播成功与失败事件（含 is_error 标记）"
    );
}

#[tokio::test]
async fn hook_tool_pre_propagate_failure_blocks_tool() {
    let tool = Arc::new(CountingEchoTool {
        calls: Arc::new(AtomicUsize::new(0)),
    });
    let reg = registry_with(vec![Arc::clone(&tool) as Arc<dyn Tool>]);
    let registry = HookRegistry::new();
    registry.register(
        HookEventKind::ToolPre,
        HookFailStrategy::Propagate,
        Arc::new(SpyHook::failing("fail")) as Arc<dyn HookHandler>,
    );
    let exec = ToolExecutor::new(reg).with_hooks(Some(Arc::new(registry)));
    let calls = vec![call("c1", "countecho", ToolConcurrency::Sequential)];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    let r = &out.results[0];
    assert_eq!(r.error_kind, Some(ToolErrorKind::ExecutionFailed));
    assert!(
        r.error_message
            .as_deref()
            .unwrap_or_default()
            .contains("propagate"),
        "propagate 失败应降级为阻止（批继续）：{:?}",
        r.error_message
    );
    assert_eq!(
        tool.calls.load(Ordering::SeqCst),
        0,
        "propagate 失败时工具不执行"
    );
}

/// tool.error 广播：工具执行失败（isError 分支）追加广播，
/// 成功不广播；载荷携带错误文案
#[tokio::test]
async fn hook_tool_error_broadcasts_on_failure_only() {
    let reg = registry_with(vec![Arc::new(EchoTool), Arc::new(FailTool)]);
    let registry = HookRegistry::new();
    let spy = Arc::new(ToolErrorSpyHook {
        name: "error-spy".into(),
        errors: Arc::new(Mutex::new(Vec::new())),
    });
    registry.register_observe(
        HookEventKind::ToolError,
        HookFailStrategy::Swallow,
        Arc::clone(&spy) as Arc<dyn HookHandler>,
    );
    let exec = ToolExecutor::new(reg).with_hooks(Some(Arc::new(registry)));
    let calls = vec![
        call("c1", "echo", ToolConcurrency::Sequential),
        call("c2", "fail", ToolConcurrency::Sequential),
    ];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    assert!(out.results[0].is_ok());
    assert_eq!(
        out.results[1].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    let errors = spy.errors.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(
        errors.as_slice(),
        &[(
            "fail".to_string(),
            "[tool.execution_failed] 工具 fail 执行失败：boom".to_string()
        )],
        "tool.error 只广播失败调用（携带错误文案）"
    );
}
