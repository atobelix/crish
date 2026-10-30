use super::super::*;
use super::fixture::*;
use agent_tools::context::ToolContext;
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use conex_types::tool::ToolConcurrency;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[tokio::test]
async fn single_tool_success() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    assert_eq!(out.results.len(), 1);
    assert!(out.results[0].is_ok());
    assert_eq!(out.results[0].id, "c1");
    assert!(out.fatal.is_none());
    // 事件序列
    assert!(matches!(out.events[0], ToolEvent::BatchStart { .. }));
    assert!(matches!(out.events[1], ToolEvent::ToolStart { .. }));
    assert!(matches!(out.events[2], ToolEvent::ToolEnd { .. }));
    assert!(matches!(out.events[3], ToolEvent::BatchEnd { .. }));
}

/// S5 测钉（D-02 LK-01）：工具执行时 ToolContext.tool_call_id == 当前
/// call.id——键源在 exec_single.rs 唯一生产构造点注入（与
/// ExecutorContext.tool_call_id 同源）；连续两个调用逐个注入不串键
#[tokio::test]
async fn tool_context_tool_call_id_injected_from_current_call() {
    let seen: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let reg = registry_with(vec![Arc::new(RecordingCtxTool::new(Arc::clone(&seen)))]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("call-1", "recording-ctx", ToolConcurrency::Sequential),
        call("call-2", "recording-ctx", ToolConcurrency::Sequential),
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
    assert!(out.results.iter().all(|r| r.is_ok()));
    // S5：快照记录 → getter → 断言——每个调用注入自己的 call.id
    let snapshot = seen.lock().unwrap();
    assert_eq!(
        snapshot.as_slice(),
        &[Some("call-1".to_string()), Some("call-2".to_string())]
    );
}

/// S5 测钉（D-02 LK-01）：未接线路径 tool_call_id 恒 None——mock 工厂
/// 与 ToolContext::new 便捷构造均不注入（非工具调用上下文）
#[test]
fn tool_context_tool_call_id_none_on_unwired_paths() {
    let mock = agent_tools::context::create_mock_tool_context();
    assert!(mock.tool_call_id.is_none(), "mock 工厂未接线应为 None");
    let fresh = ToolContext::new("sess-unwired", std::path::PathBuf::from("."));
    assert!(fresh.tool_call_id.is_none(), "便捷构造未接线应为 None");
}

/// BC11-4 测钉：工具执行时 ToolContext.compression_store 真实注入
#[tokio::test]
async fn tool_context_compression_store_injected_from_exec_ctx() {
    use agent_tools::compression_store::{BlockContent, BlockHit, CompressionContextStore};

    #[derive(Debug)]
    struct DummyStore;
    impl CompressionContextStore for DummyStore {
        fn search_blocks(&self, _s: &str, _q: &str, _l: usize) -> Result<Vec<BlockHit>, String> {
            Ok(vec![])
        }
        fn decompress_block(&self, _s: &str, _b: &str) -> Result<Option<BlockContent>, String> {
            Ok(None)
        }
    }

    struct CheckStoreTool {
        has_store: Arc<Mutex<bool>>,
    }
    #[async_trait::async_trait]
    impl Tool for CheckStoreTool {
        fn name(&self) -> &str {
            "check-store"
        }
        fn definition(&self) -> &ToolDefinition {
            static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            DEF.get_or_init(|| ToolDefinition {
                name: "check-store".into(),
                description: "checks compression_store presence".into(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: false,
            })
        }
        async fn execute(&self, ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
            *self.has_store.lock().unwrap() = ctx.compression_store.is_some();
            Ok(serde_json::json!({"ok": true}))
        }
    }

    let has_store = Arc::new(Mutex::new(false));
    let reg = registry_with(vec![Arc::new(CheckStoreTool {
        has_store: Arc::clone(&has_store),
    })]);
    let exec = ToolExecutor::new(reg);
    let mut ctx = exec_ctx();
    ctx.compression_store = Some(Arc::new(DummyStore));

    let calls = vec![call(
        "call-store-1",
        "check-store",
        ToolConcurrency::Sequential,
    )];
    let _ = exec
        .execute_batch(&calls, &ctx, None, &ToolBatchOptions::default(), None)
        .await;
    assert!(
        *has_store.lock().unwrap(),
        "compression_store 必须从 ToolExecCtx 真实注入到 ToolContext"
    );
}

/// S1 流式执行契约（R1 tool-update 死契约删除后）：流式工具仍经
/// execute_stream_with_output_policy 消费（Terminal 终值收口），但进度
/// 不再入事件链——事件序列收缩为 BatchStart → ToolStart → ToolEnd →
/// BatchEnd（无 tool-progress；终值仍由 ToolEnd 承载）
#[tokio::test]
async fn streaming_execution_keeps_terminal_without_progress_events() {
    let reg = registry_with(vec![Arc::new(StreamTool {
        text_chunks: vec!["第一块".into(), "第二块".into()],
        custom: Some(("phase".into(), serde_json::json!({ "step": 1 }))),
        with_content: true,
    })]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "stream", ToolConcurrency::Sequential)];
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
    assert_eq!(out.results[0].output["final"], true);
    // 事件序列：BatchStart → ToolStart → ToolEnd → BatchEnd（进度事件
    // 已随 tool-update 死契约删除，不再出站）
    let kinds: Vec<&str> = out
        .events
        .iter()
        .map(|e| match e {
            ToolEvent::BatchStart { .. } => "batch-start",
            ToolEvent::ToolStart { .. } => "tool-start",
            ToolEvent::ToolEnd { .. } => "tool-end",
            ToolEvent::BatchEnd { .. } => "batch-end",
            _ => "other",
        })
        .collect();
    assert_eq!(
        kinds,
        vec!["batch-start", "tool-start", "tool-end", "batch-end"],
        "流式执行事件链不含进度事件（R1 tool-update 删除）"
    );
}

#[tokio::test]
async fn unknown_tool() {
    let reg = registry_with(vec![]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "nope", ToolConcurrency::Sequential)];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::NotFound));
    // 未知工具：未标记 fatalOnError → 非致命（错误喂回模型继续）
    assert!(out.fatal.is_none());
}

#[tokio::test]
async fn parallel_readonly_tools() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 50 }), Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("p1", "slow", ToolConcurrency::Parallel),
        call("p2", "echo", ToolConcurrency::Parallel),
    ];
    let start = std::time::Instant::now();
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    let elapsed = start.elapsed();
    // 并行：总耗时接近单工具（50ms）而非 100ms+
    assert!(elapsed.as_millis() < 95, "parallel took {elapsed:?}");
    assert!(out.results.iter().all(|r| r.is_ok()));
}

/// B4 并发上限：默认值（4）生效——批 16 个 Parallel 慢工具，并发峰值
/// ≤ 默认上限（且 ≥2，证明计数点观测到真实并行，而非退化为串行）；
/// 批尾活跃计数归零（permit/计数无泄漏）
#[tokio::test]
async fn parallel_group_concurrency_peak_bounded_by_default() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 25 })]);
    let exec = ToolExecutor::new(reg);
    let calls = (0..16)
        .map(|i| call(&format!("p{i}"), "slow", ToolConcurrency::Parallel))
        .collect::<Vec<_>>();
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    let peak = exec.concurrency_obs().peak();
    assert!(
        (2..=DEFAULT_MAX_PARALLEL).contains(&peak),
        "16 工具批默认并发峰值应 ∈ [2, {DEFAULT_MAX_PARALLEL}]，实际 {peak}"
    );
    assert!(out.results.iter().all(|r| r.is_ok()), "全部工具应成功");
    assert_eq!(out.results.len(), 16, "结果数与入参一致");
    assert_eq!(
        exec.concurrency_obs().active(),
        0,
        "批完成后活跃计数应归零（计数点无泄漏）"
    );
}

/// B4 并发上限：max_parallel=1 生效——16 个 Parallel 工具被信号量
/// 串行化，并发峰值恰为 1（严格排队，不拒绝、不砍批）
#[tokio::test]
async fn parallel_group_max_parallel_one_serializes() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 10 })]);
    let exec = ToolExecutor::new(reg);
    let calls = (0..16)
        .map(|i| call(&format!("p{i}"), "slow", ToolConcurrency::Parallel))
        .collect::<Vec<_>>();
    let opts = ToolBatchOptions {
        max_parallel: Some(1),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert_eq!(
        exec.concurrency_obs().peak(),
        1,
        "max_parallel=1 时并发峰值应为 1"
    );
    assert!(
        out.results.iter().all(|r| r.is_ok()),
        "排队等待不拒绝，全部成功"
    );
    assert_eq!(out.results.len(), 16);
    assert_eq!(exec.concurrency_obs().active(), 0);
}

/// B4 并发上限：max_parallel=4 显式配置生效——峰值 ≤ 4（且 ≥2 证明
/// 并行仍发生），与默认行为一致
#[tokio::test]
async fn parallel_group_max_parallel_four_caps_peak() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 25 })]);
    let exec = ToolExecutor::new(reg);
    let calls = (0..16)
        .map(|i| call(&format!("p{i}"), "slow", ToolConcurrency::Parallel))
        .collect::<Vec<_>>();
    let opts = ToolBatchOptions {
        max_parallel: Some(4),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    let peak = exec.concurrency_obs().peak();
    assert!(
        (2..=4).contains(&peak),
        "max_parallel=4 时并发峰值应 ∈ [2, 4]，实际 {peak}"
    );
    assert!(out.results.iter().all(|r| r.is_ok()));
    assert_eq!(exec.concurrency_obs().active(), 0);
}
