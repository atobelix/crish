//! BG2 宿主适配：session-loop 的 [ToolBackgroundHost] 接缝 →
//! [ToolBackgroundRegistry]
//!
//! 薄转发层：DTO 映射（登记请求 → NewToolBackgroundTask）+ 准入
//! 分类映射（RegisterOutcome → ToolBackgroundAdmission），不引入
//! 第二套语义。实例与 `tool_task` 查询面共享同一注册表单例
//! （装配见 engine_handle：查询注入 BuiltinToolConfig、宿主经
//! EngineHandle::tool_background_host 注入 ToolBatchOptions）。

use std::sync::Arc;

use agent_tools::context::AbortToken;
use agent_tools::tools::tool_task::ToolTaskState;
use async_trait::async_trait;
use session_loop::tool_events::{
    ClassifiedToolResult, ToolBackgroundAdmission, ToolBackgroundHost,
    ToolBackgroundRegistration,
};

use super::registry::{NewToolBackgroundTask, RegisterOutcome, ToolBackgroundRegistry};

/// 注册表宿主适配（见模块头注）
#[derive(Debug)]
pub struct RegistryBackgroundHost {
    registry: Arc<ToolBackgroundRegistry>,
}

impl RegistryBackgroundHost {
    pub fn new(registry: Arc<ToolBackgroundRegistry>) -> Self {
        Self { registry }
    }

    /// 共享的注册表单例（BG3 的事件/唤醒/级联取消接线面）
    pub fn registry(&self) -> &Arc<ToolBackgroundRegistry> {
        &self.registry
    }
}

#[async_trait]
impl ToolBackgroundHost for RegistryBackgroundHost {
    fn find_inflight(
        &self,
        session_id: &str,
        tool_name: &str,
        args_digest: &str,
    ) -> Option<String> {
        self.registry
            .find_inflight(session_id, tool_name, args_digest)
    }

    fn inflight_elapsed_ms(&self, call_id: &str, now_ms: u64) -> Option<u64> {
        let status = self.registry.status(call_id, now_ms)?;
        match status.state {
            ToolTaskState::Running => status
                .started_at_ms
                .map(|start| now_ms.saturating_sub(start)),
            ToolTaskState::Queued => Some(now_ms.saturating_sub(status.queued_at_ms)),
            _ => None,
        }
    }

    fn register(&self, task: ToolBackgroundRegistration) -> ToolBackgroundAdmission {
        let registration = self.registry.register(NewToolBackgroundTask {
            call_id: task.call_id,
            session_id: task.session_id,
            run_id: task.run_id,
            tool_name: task.tool_name,
            args_digest: task.args_digest,
            parent_token: task.parent_token,
            now_ms: task.now_ms,
            // v1 只读工具转后台，不涉及写路径声明（注册表槽位口径）
            write_claim: None,
        });
        match registration.outcome {
            RegisterOutcome::Admitted => ToolBackgroundAdmission::Admitted,
            RegisterOutcome::Queued => ToolBackgroundAdmission::Queued,
            RegisterOutcome::AlreadyExists => ToolBackgroundAdmission::AlreadyExists,
        }
    }

    fn entry_token(&self, call_id: &str) -> Option<AbortToken> {
        self.registry.entry_token(call_id)
    }

    async fn wait_admitted(&self, call_id: &str) -> bool {
        self.registry.wait_admitted(call_id).await
    }

    fn attach_handle(&self, call_id: &str, handle: tokio::task::JoinHandle<()>) -> bool {
        self.registry.attach_handle(call_id, handle)
    }

    fn settle(&self, call_id: &str, result: ClassifiedToolResult, now_ms: u64) -> bool {
        self.registry.settle(call_id, result, now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_background::store::InMemoryToolBackgroundStore;
    use agent_tools::definition::{Tool, ToolDefinition, ToolError};
    use agent_tools::registry::ToolRegistry;
    use conex_types::tool::{ToolBatchCall, ToolCategory, ToolConcurrency};
    use session_loop::tool_events::ToolBatchOptions;
    use session_loop::tool_exec::{ToolExecCtx, ToolExecutor};
    use serde_json::Value;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn real_now() -> u64 {
        conex_shared::time::now_millis()
    }

    fn host_and_registry() -> (Arc<RegistryBackgroundHost>, Arc<ToolBackgroundRegistry>) {
        let registry = Arc::new(ToolBackgroundRegistry::new(Arc::new(
            InMemoryToolBackgroundStore::new(),
        )));
        let host = Arc::new(RegistryBackgroundHost::new(Arc::clone(&registry)));
        (host, registry)
    }

    fn registration(call_id: &str) -> ToolBackgroundRegistration {
        ToolBackgroundRegistration {
            call_id: call_id.to_string(),
            session_id: "sess-1".to_string(),
            run_id: Some("run-1".to_string()),
            tool_name: "bgslow".to_string(),
            args_digest: "bgslow:0123".to_string(),
            parent_token: AbortToken::new(),
            now_ms: real_now(),
        }
    }

    /// 适配往返：登记 → 在途命中/已运行时长/子令牌 → 落定 →
    /// 注册表结果视图与直执同构（输出原样可查、终态后不在途）
    #[tokio::test]
    async fn adapter_roundtrip_against_real_registry() {
        let (host, registry) = host_and_registry();
        let admission = host.register(registration("c1"));
        assert_eq!(admission, ToolBackgroundAdmission::Admitted);
        assert_eq!(
            host.find_inflight("sess-1", "bgslow", "bgslow:0123"),
            Some("c1".to_string())
        );
        assert!(host.inflight_elapsed_ms("c1", real_now()).is_some());
        assert!(host.entry_token("c1").is_some());
        // 同 callId 重复登记幂等
        assert_eq!(
            host.register(registration("c1")),
            ToolBackgroundAdmission::AlreadyExists
        );
        let result = ClassifiedToolResult::ok(
            "c1",
            "bgslow",
            serde_json::json!({ "done": true }),
            123,
        );
        assert!(host.settle("c1", result, real_now()));
        let view = registry.result("c1").expect("落定后可查");
        assert!(view.result_ready);
        assert_eq!(view.output, Some(serde_json::json!({ "done": true })));
        assert_eq!(
            host.find_inflight("sess-1", "bgslow", "bgslow:0123"),
            None,
            "终态条目不再算在途"
        );
        assert!(host.inflight_elapsed_ms("c1", real_now()).is_none());
    }

    /// 资格慢工具（测试本地定义：阈值 50ms，执行回显入参）
    struct SlowEchoTool {
        def: ToolDefinition,
        sleep_ms: u64,
        started: Arc<AtomicUsize>,
        finished: Arc<AtomicUsize>,
    }

    impl SlowEchoTool {
        fn new(sleep_ms: u64) -> (Arc<Self>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
            let started = Arc::new(AtomicUsize::new(0));
            let finished = Arc::new(AtomicUsize::new(0));
            let tool = Arc::new(Self {
                def: ToolDefinition {
                    name: "bgslow".to_string(),
                    description: "bg slow echo".to_string(),
                    input_schema: serde_json::json!({ "type": "object" }),
                    dangerous: false,
                    fatal_on_error: false,
                    background_after_ms: Some(50),
                },
                sleep_ms,
                started: Arc::clone(&started),
                finished: Arc::clone(&finished),
            });
            (tool, started, finished)
        }
    }

    #[async_trait::async_trait]
    impl Tool for SlowEchoTool {
        fn name(&self) -> &str {
            &self.def.name
        }
        fn definition(&self) -> &ToolDefinition {
            &self.def
        }
        async fn execute(
            &self,
            _ctx: &agent_tools::context::ToolContext,
            args: Value,
        ) -> Result<Value, ToolError> {
            self.started.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(self.sleep_ms)).await;
            self.finished.fetch_add(1, Ordering::SeqCst);
            Ok(serde_json::json!({ "echo": args, "done": true }))
        }
    }

    fn exec_ctx() -> ToolExecCtx {
        ToolExecCtx {
            run_id: "run-1".into(),
            session_id: "sess-1".into(),
            ..Default::default()
        }
    }

    fn arg_call(id: &str, concurrency: ToolConcurrency) -> ToolBatchCall {
        ToolBatchCall {
            id: id.into(),
            tool_name: "bgslow".into(),
            summary: format!("call {id}"),
            input: serde_json::json!({ "v": id }),
            category: ToolCategory::Internal,
            concurrency,
        }
    }

    fn executor_with(
        tool: Arc<SlowEchoTool>,
        host: &Arc<RegistryBackgroundHost>,
    ) -> (ToolExecutor, ToolBatchOptions) {
        let mut reg = ToolRegistry::new();
        reg.register(tool as Arc<dyn Tool>).expect("register");
        let exec = ToolExecutor::new(Arc::new(reg));
        let opts = ToolBatchOptions {
            timeout: Duration::from_secs(60),
            tool_background: Some(host.clone() as Arc<dyn ToolBackgroundHost>),
            max_parallel: Some(8),
            ..Default::default()
        };
        (exec, opts)
    }

    /// 执行器 × 真注册表：detach 后注册表 Running；同参第二轮去重
    /// 占位指向首条；落定后结果经注册表可查且与输出同构
    #[tokio::test(start_paused = true)]
    async fn executor_detach_and_dedup_against_real_registry() {
        let (host, registry) = host_and_registry();
        let (tool, _started, _finished) = SlowEchoTool::new(10_000);
        let (exec, opts) = executor_with(tool, &host);
        let exec = Arc::new(exec);
        let calls = vec![arg_call("c1", ToolConcurrency::Sequential)];
        let ctx = exec_ctx();
        let handle = {
            let exec = Arc::clone(&exec);
            let calls = calls.clone();
            let ctx = ctx.clone();
            let opts = opts.clone();
            tokio::spawn(async move { exec.execute_batch(&calls, &ctx, None, &opts, None).await })
        };
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(60)).await;
        let out = handle.await.unwrap();
        assert_eq!(out.results[0].output["mode"], "background");
        assert_eq!(registry.counts().running_total, 1);

        // 同参第二轮（不同 callId）：去重占位指向 c1，不重复登记
        let calls2 = vec![{
            let mut c = arg_call("c2", ToolConcurrency::Sequential);
            c.input = serde_json::json!({ "v": "c1" });
            c
        }];
        let out2 = exec
            .execute_batch(&calls2, &exec_ctx(), None, &opts, None)
            .await;
        assert_eq!(out2.results[0].output["callId"], "c1");
        assert_eq!(registry.counts().running_total, 1);

        tokio::time::advance(Duration::from_millis(11_000)).await;
        tokio::task::yield_now().await;
        let view = registry.result("c1").expect("落定可查");
        assert!(view.result_ready);
        assert_eq!(
            view.output,
            Some(serde_json::json!({ "echo": { "v": "c1" }, "done": true }))
        );
    }

    /// 容量与级联：同会话 5 个 detach（上限 4）→ 1 个排队且不被
    /// 驱动；取消一个运行条目 → 排队条目获槽并最终落定
    #[tokio::test(start_paused = true)]
    async fn queue_full_then_cancel_admits_queued() {
        let (host, registry) = host_and_registry();
        let (tool, started, finished) = SlowEchoTool::new(10_000);
        let (exec, opts) = executor_with(tool, &host);
        let calls: Vec<ToolBatchCall> = (1..=5)
            .map(|i| arg_call(&format!("c{i}"), ToolConcurrency::Parallel))
            .collect();
        let ctx = exec_ctx();
        let handle = tokio::spawn(async move {
            exec.execute_batch(&calls, &ctx, None, &opts, None).await
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(100)).await;
        let out = handle.await.unwrap();
        assert!(
            out.results.iter().all(|r| r.is_ok()),
            "5 个调用全部占位收口"
        );
        let counts = registry.counts();
        assert_eq!(counts.running_total, 4, "会话上限 4 个运行");
        assert_eq!(counts.queued_total, 1, "第 5 个排队");
        // 执行体在 detach 前已在环启动（5 个都已开始），排队条目
        // 的判据是「不得被继续驱动」：完成计数必须为 0
        assert_eq!(started.load(Ordering::SeqCst), 5);
        assert_eq!(
            finished.load(Ordering::SeqCst),
            0,
            "排队条目的执行单元不得被驱动推进"
        );
        // 取消 c1：槽位释放 → 排队条目获槽被驱动
        assert!(registry.cancel("c1", real_now()));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(11_000)).await;
        tokio::task::yield_now().await;
        // c2..c5 全部跑完；c1 被硬 abort 中途丢弃、永不完成
        assert_eq!(finished.load(Ordering::SeqCst), 4);
        let counts = registry.counts();
        assert_eq!(counts.running_total, 0);
        assert_eq!(counts.queued_total, 0);
        let c1 = registry.result("c1").expect("c1 视图");
        assert_eq!(c1.state, ToolTaskState::Cancelled);
        assert!(!c1.result_ready);
        for i in 2..=5 {
            let view = registry
                .result(&format!("c{i}"))
                .expect("其余条目落定可查");
            assert!(view.result_ready, "c{i} 应落定");
        }
    }

    /// run 级联取消留痕（BG3 接线点）：cancel_run 按 run 归属批量
    /// 终态化条目；包装任务的迟到 settle 被拒，结果不落表
    #[tokio::test(start_paused = true)]
    async fn cancel_run_cascade_rejects_late_settle() {
        let (host, registry) = host_and_registry();
        let (tool, _started, _finished) = SlowEchoTool::new(10_000);
        let (exec, opts) = executor_with(tool, &host);
        let calls = vec![arg_call("c1", ToolConcurrency::Sequential)];
        let ctx = exec_ctx();
        let handle = tokio::spawn(async move {
            exec.execute_batch(&calls, &ctx, None, &opts, None).await
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(60)).await;
        let out = handle.await.unwrap();
        assert_eq!(out.results[0].output["mode"], "background");
        let cancelled = registry.cancel_run("run-1", real_now());
        assert_eq!(cancelled, vec!["c1".to_string()]);
        // 推进足够时长：包装任务即使跑完，settle 也必须被拒
        tokio::time::advance(Duration::from_millis(11_000)).await;
        tokio::task::yield_now().await;
        let view = registry.result("c1").expect("c1 视图");
        assert_eq!(view.state, ToolTaskState::Cancelled);
        assert!(!view.result_ready);
        assert!(host.entry_token("c1").is_none(), "终态条目令牌收回");
    }
}
