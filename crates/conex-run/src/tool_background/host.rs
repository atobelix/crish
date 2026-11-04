//! BG2 宿主适配：session-loop 的 [ToolBackgroundHost] 接缝 →
//! [ToolBackgroundRegistry]
//!
//! 薄转发层：DTO 映射（登记请求 → NewToolBackgroundTask）+ 准入
//! 分类映射（RegisterOutcome → ToolBackgroundAdmission），不引入
//! 第二套语义。实例与 `tool_task` 查询面共享同一注册表单例
//! （装配见 engine_handle：查询注入 BuiltinToolConfig、宿主经
//! EngineHandle::tool_background_host 注入 ToolBatchOptions）。
//!
//! BG3 发射纪律（本层是 tool-backgrounded / tool-settled 的唯一
//! 发射点）：每次发射都紧跟一次**成功**的状态迁移且至多一次——
//! register 获槽（Admitted）/ wait_admitted 获槽返回 true →
//! tool-backgrounded（宿主侧已发集合去重，两路只发其一）；
//! settle 返回 true → tool-settled；取消收口（单条 cancel 与
//! 批量 cancel_run / close_session）不经 settle 迁移，必须经本层的
//! cancel_and_notify / cancel_run_and_notify / close_session_and_notify
//! 包装发射 tool-settled(cancelled)——**注册表的裸 cancel /
//! cancel_run / close_session 不得被生产代码直调**（直调 = 静默
//! 无事件，见包装方法注释）。
//! sink 缺省 None（无头 / 测试装配）：不发射，迁移语义不变。

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use agent_tools::context::AbortToken;
use agent_tools::tools::tool_task::ToolTaskState;
use async_trait::async_trait;
use conex_types::events::ToolSettledStatus;
use session_loop::tool_events::{
    ClassifiedToolResult, ToolBackgroundAdmission, ToolBackgroundHost,
    ToolBackgroundRegistration,
};

use super::events::{
    cancelled_tool_batch_result, settled_status_of, tool_batch_result_from_classified,
    ToolBackgroundCallSummary, ToolBackgroundEventSink,
};
use super::registry::{NewToolBackgroundTask, RegisterOutcome, ToolBackgroundRegistry};

/// 注册表宿主适配（见模块头注）
#[derive(Debug)]
pub struct RegistryBackgroundHost {
    registry: Arc<ToolBackgroundRegistry>,
    /// BG3 事件 sink（可选；装配经 [Self::with_event_sink] 注入）
    event_sink: Option<Arc<dyn ToolBackgroundEventSink>>,
    /// tool-backgrounded 已发 callId 集合（登记直通与排队获槽两路
    /// 发射点的幂等闸——同一 callId 只发一次）
    backgrounded_emitted: Mutex<HashSet<String>>,
}

impl RegistryBackgroundHost {
    pub fn new(registry: Arc<ToolBackgroundRegistry>) -> Self {
        Self {
            registry,
            event_sink: None,
            backgrounded_emitted: Mutex::new(HashSet::new()),
        }
    }

    /// 注入 BG3 事件 sink（装配面：EngineHandle 在每次构造宿主时
    /// 附着 CoreRunState 的桥 sink 单例——宿主是逐调用构造的薄壳，
    /// sink 必须经本构造口注入而非字段后改）
    pub fn with_event_sink(mut self, sink: Arc<dyn ToolBackgroundEventSink>) -> Self {
        self.event_sink = Some(sink);
        self
    }

    /// 共享的注册表单例（BG3 的事件/唤醒/级联取消接线面）
    pub fn registry(&self) -> &Arc<ToolBackgroundRegistry> {
        &self.registry
    }

    /// tool-backgrounded 发射（幂等：已发集合先行占用，重复调用
    /// 静默跳过）；elapsed = 注册表口径已运行时长（now − 登记时刻，
    /// 与 BG2 占位信封 elapsedMs 的宿主侧同源值——排队时长以
    /// wait_admitted 的 now 计入）
    fn emit_backgrounded(&self, summary: &ToolBackgroundCallSummary, now_ms: u64) {
        let Some(sink) = &self.event_sink else {
            return;
        };
        {
            let mut emitted = self
                .backgrounded_emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if !emitted.insert(summary.call_id.clone()) {
                return;
            }
        }
        let elapsed_ms = self
            .registry
            .status(&summary.call_id, now_ms)
            .map(|status| now_ms.saturating_sub(status.queued_at_ms))
            .unwrap_or(0);
        sink.on_backgrounded(summary, elapsed_ms);
    }

    /// 批量收口后的 tool-settled(cancelled) 扇出（cancel_run /
    /// close_session 包装共用）：只对真正被本次调用带入终态的
    /// callId 发射；时长取结果视图（cancel_run 后条目留存可查，
    /// close_session 后已清除 → 0，文案语义不依赖时长）
    fn emit_cancelled_set(
        &self,
        summaries: &[ToolBackgroundCallSummary],
        cancelled_ids: &[String],
    ) {
        let Some(sink) = &self.event_sink else {
            return;
        };
        for summary in summaries
            .iter()
            .filter(|s| cancelled_ids.contains(&s.call_id))
        {
            let duration_ms = self
                .registry
                .result(&summary.call_id)
                .and_then(|view| view.duration_ms)
                .unwrap_or(0);
            let result = cancelled_tool_batch_result(summary, duration_ms);
            sink.on_settled(summary, ToolSettledStatus::Cancelled, &result);
        }
    }

    /// 单条取消 + BG3 事件扇出（UI 单取消的**唯一**合规入口，
    /// 同 [Self::cancel_run_and_notify] 的纪律：注册表裸 cancel
    /// 本身不发事件，直调即静默——BG5 命令面曾直调注册表，单取消
    /// 无 tool-settled(cancelled) 回注亦无落定唤醒，2026-11-02
    /// 整波收口改经本包装）。摘要在取消前取证，发射在迁移成功后；
    /// 返回与注册表 cancel 同值（true = 在途且已取消收口）
    pub fn cancel_and_notify(&self, call_id: &str, now_ms: u64) -> bool {
        let summary = self.registry.entry_summary(call_id);
        let cancelled = self.registry.cancel(call_id, now_ms);
        if cancelled {
            if let Some(summary) = summary {
                self.emit_cancelled_set(&[summary], &[call_id.to_string()]);
            }
        }
        cancelled
    }
    /// 按 run 批量取消 + BG3 事件扇出（run 停止级联的**唯一**
    /// 合规入口：注册表 cancel_run 本身不发事件，直调即静默）。
    /// 摘要在取消前取证，发射在迁移成功后——返回实取消 callId 列表
    /// （与注册表 cancel_run 同值）
    pub fn cancel_run_and_notify(&self, run_id: &str, now_ms: u64) -> Vec<String> {
        let summaries = self.registry.unsettled_summaries_for_run(run_id);
        let cancelled = self.registry.cancel_run(run_id, now_ms);
        self.emit_cancelled_set(&summaries, &cancelled);
        cancelled
    }

    /// 会话关闭收口 + BG3 事件扇出（会话关闭的**唯一**合规入口，
    /// 同 [Self::cancel_run_and_notify] 的纪律）。摘要必须在收口前
    /// 取证（close_session 移除条目并清除落盘记录）
    pub fn close_session_and_notify(&self, session_id: &str, now_ms: u64) -> Vec<String> {
        let summaries = self.registry.unsettled_summaries_for_session(session_id);
        let cancelled = self.registry.close_session(session_id, now_ms);
        self.emit_cancelled_set(&summaries, &cancelled);
        cancelled
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
        // BG3：身份摘要在 DTO 移动前留存（Admitted 发射点用）
        let summary = ToolBackgroundCallSummary {
            session_id: task.session_id.clone(),
            call_id: task.call_id.clone(),
            tool_name: task.tool_name.clone(),
        };
        let now_ms = task.now_ms;
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
            RegisterOutcome::Admitted => {
                // BG3：登记即获槽 = 后台化迁移点（执行槽位已定，
                // elapsed 为注册表口径 ≈0——真实已运行时长在占位
                // 信封侧，见 events.rs 接缝注释）
                self.emit_backgrounded(&summary, now_ms);
                ToolBackgroundAdmission::Admitted
            }
            RegisterOutcome::Queued => ToolBackgroundAdmission::Queued,
            RegisterOutcome::AlreadyExists => ToolBackgroundAdmission::AlreadyExists,
        }
    }

    fn entry_token(&self, call_id: &str) -> Option<AbortToken> {
        self.registry.entry_token(call_id)
    }

    async fn wait_admitted(&self, call_id: &str) -> bool {
        let admitted = self.registry.wait_admitted(call_id).await;
        if admitted {
            // BG3：排队获槽 = 后台化迁移点（与 register 直通路经
            // 已发集合互斥，同 callId 只发一次）；now 取真实时钟——
            // wait_admitted 无 now 入参，注册表自身时间戳亦由调用方
            // 传入，此处以真实时钟补齐发射口径（queued_at 锚点差）
            if let Some(summary) = self.registry.entry_summary(call_id) {
                let now_ms = conex_shared::time::now_millis();
                self.emit_backgrounded(&summary, now_ms);
            }
        }
        admitted
    }

    fn attach_handle(&self, call_id: &str, handle: tokio::task::JoinHandle<()>) -> bool {
        self.registry.attach_handle(call_id, handle)
    }

    fn settle(&self, call_id: &str, result: ClassifiedToolResult, now_ms: u64) -> bool {
        // BG3：摘要与同构结果在迁移前备好（迁移后条目可能被有界
        // 淘汰，且终态分类必须取自原始分类结果而非注册表二分态）
        let summary = self.registry.entry_summary(call_id);
        let status = settled_status_of(&result);
        let batch_result = tool_batch_result_from_classified(&result);
        let settled = self.registry.settle(call_id, result, now_ms);
        if settled {
            // 迁移成功后恰好一次发射（重复 settle 返回 false 天然
            // 不发——先落定者胜与恰好一次同源）
            if let (Some(sink), Some(summary)) = (&self.event_sink, &summary) {
                sink.on_settled(summary, status, &batch_result);
            }
        }
        settled
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
    // ── BG3 发射验收（记录型 sink：真实注册表 + 真实宿主，只在
    // 出站 sink 边界打点；发射纪律见模块头注）──

    /// 记录型事件 sink（出站边界记录调用，不 mock 被测迁移链）
    #[derive(Debug, Default)]
    struct RecordingSink {
        backgrounded: Mutex<Vec<(String, String, u64)>>,
        settled: Mutex<Vec<(String, ToolSettledStatus, conex_types::tool::ToolBatchResult)>>,
    }

    impl RecordingSink {
        fn backgrounded_count(&self) -> usize {
            self.backgrounded.lock().unwrap().len()
        }
        fn settled_count(&self) -> usize {
            self.settled.lock().unwrap().len()
        }
    }

    impl ToolBackgroundEventSink for RecordingSink {
        fn on_backgrounded(&self, summary: &ToolBackgroundCallSummary, elapsed_ms: u64) {
            self.backgrounded.lock().unwrap().push((
                summary.session_id.clone(),
                summary.call_id.clone(),
                elapsed_ms,
            ));
        }
        fn on_settled(
            &self,
            summary: &ToolBackgroundCallSummary,
            status: ToolSettledStatus,
            result: &conex_types::tool::ToolBatchResult,
        ) {
            self.settled.lock().unwrap().push((
                summary.call_id.clone(),
                status,
                result.clone(),
            ));
        }
    }

    fn sink_host() -> (
        RegistryBackgroundHost,
        Arc<ToolBackgroundRegistry>,
        Arc<RecordingSink>,
    ) {
        let registry = Arc::new(ToolBackgroundRegistry::new(Arc::new(
            InMemoryToolBackgroundStore::new(),
        )));
        let sink = Arc::new(RecordingSink::default());
        let host = RegistryBackgroundHost::new(Arc::clone(&registry))
            .with_event_sink(sink.clone() as Arc<dyn ToolBackgroundEventSink>);
        (host, registry, sink)
    }

    /// BG3 验收 1：登记即获槽 → backgrounded 恰好一次；重复登记
    /// （AlreadyExists）不重复发
    #[test]
    fn bg3_register_admitted_emits_backgrounded_exactly_once() {
        let (host, _registry, sink) = sink_host();
        assert_eq!(
            host.register(registration("c1")),
            ToolBackgroundAdmission::Admitted
        );
        assert_eq!(sink.backgrounded_count(), 1);
        assert_eq!(
            host.register(registration("c1")),
            ToolBackgroundAdmission::AlreadyExists
        );
        assert_eq!(sink.backgrounded_count(), 1, "重复登记不得重复发射");
        let events = sink.backgrounded.lock().unwrap();
        assert_eq!(events[0].0, "sess-1");
        assert_eq!(events[0].1, "c1");
    }

    /// BG3 验收 1b：排队登记不发；wait_admitted 获槽后发恰好一次
    /// （两路发射点经已发集合互斥，总数恒为 1）
    #[tokio::test]
    async fn bg3_queued_then_wait_admitted_emits_backgrounded_once() {
        let (host, _registry, sink) = sink_host();
        // 每会话并发 4：前四条直通获槽并发射 backgrounded
        for id in ["q1", "q2", "q3", "q4"] {
            assert_eq!(
                host.register(registration(id)),
                ToolBackgroundAdmission::Admitted
            );
        }
        assert_eq!(sink.backgrounded_count(), 4);
        // 第五条排队：登记不发
        assert_eq!(
            host.register(registration("q5")),
            ToolBackgroundAdmission::Queued
        );
        assert_eq!(sink.backgrounded_count(), 4, "排队登记不得发射 backgrounded");
        // 落定一条腾槽 → q5 被提升；wait_admitted 返回 true 时发射
        let ok = ClassifiedToolResult::ok("q1", "bgslow", Value::Null, 1);
        assert!(host.settle("q1", ok, real_now()));
        assert!(host.wait_admitted("q5").await, "腾槽后 q5 必须获槽");
        assert_eq!(
            sink.backgrounded_count(),
            5,
            "q5 获槽发射恰好一次（4 直通 + 1 排队获槽）"
        );
        let q5_count = sink
            .backgrounded
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, call_id, _)| call_id == "q5")
            .count();
        assert_eq!(q5_count, 1);
    }

    /// BG3 验收 2：落定 → settled 恰好一次且结果同构；重复 settle
    /// （先落定者胜被拒）不再发射
    #[test]
    fn bg3_settle_emits_settled_exactly_once_with_isomorphic_result() {
        let (host, _registry, sink) = sink_host();
        host.register(registration("c1"));
        let ok = ClassifiedToolResult::ok(
            "c1",
            "bgslow",
            serde_json::json!({ "done": true }),
            123,
        );
        assert!(host.settle("c1", ok, real_now()));
        assert_eq!(sink.settled_count(), 1);
        {
            let events = sink.settled.lock().unwrap();
            let (call_id, status, result) = &events[0];
            assert_eq!(call_id, "c1");
            assert_eq!(*status, ToolSettledStatus::Ok);
            assert!(!result.is_error);
            assert_eq!(result.duration_ms, 123);
            assert_eq!(
                result.output.json,
                Some(serde_json::json!({ "done": true })),
                "settled 结果与 tool-end 载荷同构（输出透传）"
            );
        }
        let late = ClassifiedToolResult::ok("c1", "bgslow", Value::Null, 1);
        assert!(!host.settle("c1", late, real_now()), "重复 settle 必须被拒");
        assert_eq!(sink.settled_count(), 1, "被拒的重复 settle 不得发射");
    }

    /// BG3 验收 3：cancel_run_and_notify → 每个在飞 call 发射一条
    /// settled(cancelled)；其后的迟到 settle 被拒且不发事件
    #[test]
    fn bg3_cancel_run_notify_emits_cancelled_per_inflight_call() {
        let (host, _registry, sink) = sink_host();
        host.register(registration("c1"));
        host.register(registration("c2"));
        let cancelled = host.cancel_run_and_notify("run-1", real_now());
        assert_eq!(cancelled.len(), 2);
        assert_eq!(sink.settled_count(), 2);
        for (_, status, result) in sink.settled.lock().unwrap().iter() {
            assert_eq!(*status, ToolSettledStatus::Cancelled);
            assert!(result.is_error);
            assert_eq!(
                result.output.text.as_deref(),
                Some(crate::tool_background::registry::CANCELLED_NOTE),
                "取消结果文案与注册表留痕同源"
            );
        }
        let late = ClassifiedToolResult::ok("c1", "bgslow", Value::Null, 1);
        assert!(!host.settle("c1", late, real_now()));
        assert_eq!(sink.settled_count(), 2, "迟到 settle 不得补发");
    }

    /// BG3 验收 4：close_session_and_notify → 会话内在飞 call 发射
    /// settled(cancelled)，他会话不受影响
    #[test]
    fn bg3_close_session_notify_emits_cancelled_for_session_calls() {
        let (host, registry, sink) = sink_host();
        host.register(registration("c1"));
        let mut other = registration("c9");
        other.session_id = "sess-2".to_string();
        other.args_digest = "bgslow:9999".to_string();
        host.register(other);
        let cancelled = host.close_session_and_notify("sess-1", real_now());
        assert_eq!(cancelled, vec!["c1".to_string()]);
        assert_eq!(sink.settled_count(), 1);
        assert_eq!(
            sink.settled.lock().unwrap()[0].1,
            ToolSettledStatus::Cancelled
        );
        // 他会话条目仍在飞（未被会话收口波及）
        assert!(registry.status("c9", real_now()).is_some());
        assert_eq!(
            registry
                .status("c9", real_now())
                .map(|s| s.state),
            Some(ToolTaskState::Running)
        );
    }

    /// BG3 验收 6（整波收口补）：cancel_and_notify → 在途条目
    /// 发射恰好一条 settled(cancelled) 且结果与注册表留痕同源；
    /// 已终态条目再取消返回 false 且不发射
    #[test]
    fn bg3_cancel_notify_emits_cancelled_once_for_inflight_call() {
        let (host, _registry, sink) = sink_host();
        host.register(registration("c1"));
        assert!(host.cancel_and_notify("c1", real_now()));
        assert_eq!(sink.settled_count(), 1);
        {
            let events = sink.settled.lock().unwrap();
            let (call_id, status, result) = &events[0];
            assert_eq!(call_id, "c1");
            assert_eq!(*status, ToolSettledStatus::Cancelled);
            assert!(result.is_error);
            assert_eq!(
                result.output.text.as_deref(),
                Some(crate::tool_background::registry::CANCELLED_NOTE)
            );
        }
        assert!(
            !host.cancel_and_notify("c1", real_now()),
            "已终态再取消必须返回 false"
        );
        assert_eq!(sink.settled_count(), 1, "落空的取消不得发射");
        assert!(!host.cancel_and_notify("missing", real_now()));
        assert_eq!(sink.settled_count(), 1);
    }
    /// BG3 验收 5：冷启动合成——落盘-only 未落定记录经
    /// registry.synthesize_outcome_unknown 变终态（供 run_restore
    /// 逐条发射 outcome-unknown 用），同会话二次合成幂等为空
    #[test]
    fn bg3_cold_start_synthesis_from_persisted_unsettled() {
        use crate::tool_background::store::{
            ToolBackgroundRecord, ToolBackgroundStore,
        };
        let store = Arc::new(InMemoryToolBackgroundStore::new());
        let record = ToolBackgroundRecord {
            call_id: "cold-1".to_string(),
            session_id: "sess-cold".to_string(),
            run_id: Some("run-old".to_string()),
            tool_name: "bgslow".to_string(),
            state: ToolTaskState::Running,
            queued_at_ms: 100,
            started_at_ms: Some(120),
            settled_at_ms: None,
            duration_ms: None,
            output: None,
            error_code: None,
            error_message: None,
        };
        store.put_record(&record).unwrap();
        let registry = ToolBackgroundRegistry::new(store);
        let synthesized = registry.synthesize_outcome_unknown("sess-cold", 5_000);
        assert_eq!(synthesized.len(), 1, "落盘未落定记录必须被合成");
        let rec = &synthesized[0];
        assert_eq!(rec.state, ToolTaskState::OutcomeUnknown);
        assert_eq!(
            rec.error_message.as_deref(),
            Some(crate::tool_background::registry::OUTCOME_UNKNOWN_NOTE)
        );
        assert_eq!(rec.settled_at_ms, Some(5_000));
        assert_eq!(rec.duration_ms, Some(5_000 - 120), "时长 = 落定时刻 − 开始时刻");
        // 合成后记录已终态：二次合成无原料
        assert!(registry
            .synthesize_outcome_unknown("sess-cold", 6_000)
            .is_empty());
    }

}
