// SR-03 · 拆分 · ≠ EL：tool_exec.rs 测试旁挂（#[path] 接线，无孤儿）
// 原 `mod tests` 整块外置（零删除）；`super` = tool_exec 门面——
// `use super::*` 消费门面私有导入与 pub(crate) re-export，形状不变。

use super::*;
use crate::hooks::{
    HookAction, HookError, HookEventKind, HookFailStrategy, HookHandler, HookRegistry,
};
use crate::safe_point::AbortSignal;
use agent_tools::context::ToolContext;
use agent_tools::definition::{Tool, ToolDefinition};
use agent_tools::middleware::ToolExecutionContext;
use agent_tools::permission::PermissionMode;
use agent_tools::registry::ToolRegistry;
use agent_tools::streaming::{ContentBlock, ToolProgress, ToolStream, ToolStreamItem};
use async_trait::async_trait;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 测试工具：echo
struct EchoTool;
#[async_trait::async_trait]
impl Tool for EchoTool {
    fn name(&self) -> &str {
        "echo"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "echo".into(),
            description: "echo input".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        Ok(args)
    }
}

/// 测试工具：慢工具（睡眠指定毫秒）
struct SlowTool {
    ms: u64,
}
#[async_trait::async_trait]
impl Tool for SlowTool {
    fn name(&self) -> &str {
        "slow"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "slow".into(),
            description: "slow tool".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        tokio::time::sleep(Duration::from_millis(self.ms)).await;
        Ok(serde_json::json!({"ok": true}))
    }
}

/// 测试工具：总是失败
struct FailTool;
#[async_trait::async_trait]
impl Tool for FailTool {
    fn name(&self) -> &str {
        "fail"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "fail".into(),
            description: "always fails".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        Err(ToolError::execution_failed("fail", "boom"))
    }
}

/// 标记 fatalOnError 的失败工具（验证工具级致命语义）
struct FailToolFatal;
#[async_trait::async_trait]
impl Tool for FailToolFatal {
    fn name(&self) -> &str {
        "failfatal"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "failfatal".into(),
            description: "always fails (fatal)".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: true,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        Err(ToolError::execution_failed("failfatal", "boom"))
    }
}

/// S1 流式测试工具：execute_stream 推送 Text/Custom/Content 进度 + 终值
///（验证 execute_stream_with_output_policy 进度回调与事件接线）
struct StreamTool {
    text_chunks: Vec<String>,
    custom: Option<(String, Value)>,
    with_content: bool,
}
#[async_trait::async_trait]
impl Tool for StreamTool {
    fn name(&self) -> &str {
        "stream"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "stream".into(),
            description: "streaming tool".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        // 流式路径不调用 execute（与 execute_stream_with_output_policy
        // 消费 execute_stream 一致）
        Err(ToolError::execution_failed("stream", "execute 不应被调用"))
    }
    async fn execute_stream(&self, _ctx: &ToolContext, _args: Value) -> ToolStream {
        let mut items = Vec::new();
        for t in &self.text_chunks {
            items.push(ToolStreamItem::Progress(ToolProgress::Text {
                text: t.clone(),
            }));
        }
        if let Some((subkind, payload)) = &self.custom {
            items.push(ToolStreamItem::Progress(ToolProgress::Custom {
                subkind: subkind.clone(),
                payload: payload.clone(),
            }));
        }
        if self.with_content {
            items.push(ToolStreamItem::Progress(ToolProgress::Content {
                blocks: vec![ContentBlock {
                    kind: "image".into(),
                    data: serde_json::json!({}),
                }],
            }));
        }
        items.push(ToolStreamItem::Terminal(Ok(
            serde_json::json!({ "final": true }),
        )));
        Box::pin(futures::stream::iter(items))
    }
}

/// S5 测钉工具（D-02 LK-01）：快照记录执行时收到的
/// ToolContext.tool_call_id（Option 原样记录，None 与空串可区分），
/// 供断言验证键源注入——工具侧读 ctx.tool_call_id 即「当前调用 id」
struct RecordingCtxTool {
    seen_call_ids: Arc<Mutex<Vec<Option<String>>>>,
}
impl RecordingCtxTool {
    fn new(seen: Arc<Mutex<Vec<Option<String>>>>) -> Self {
        Self {
            seen_call_ids: seen,
        }
    }
}
#[async_trait::async_trait]
impl Tool for RecordingCtxTool {
    fn name(&self) -> &str {
        "recording-ctx"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "recording-ctx".into(),
            description: "records ctx.tool_call_id".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        self.seen_call_ids
            .lock()
            .unwrap()
            .push(ctx.tool_call_id.clone());
        Ok(serde_json::json!({"ok": true}))
    }
}

fn registry_with(tools: Vec<Arc<dyn Tool>>) -> Arc<ToolRegistry> {
    let mut reg = ToolRegistry::new();
    for t in tools {
        reg.register(t).expect("register");
    }
    Arc::new(reg)
}

fn call(id: &str, name: &str, concurrency: ToolConcurrency) -> ToolBatchCall {
    ToolBatchCall {
        id: id.into(),
        tool_name: name.into(),
        summary: format!("call {name}"),
        input: serde_json::json!({"v": id}),
        category: conex_types::tool::ToolCategory::Internal,
        concurrency,
    }
}

fn exec_ctx() -> ToolExecCtx {
    ToolExecCtx {
        run_id: "run-1".into(),
        session_id: "sess-1".into(),
        ..Default::default()
    }
}

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
        peak >= 2 && peak <= DEFAULT_MAX_PARALLEL,
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

#[tokio::test]
async fn timeout_tool() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 500 })]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "slow", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        timeout: Duration::from_millis(50),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Timeout));
    // 超时不是 fatal（排除清单）
    assert!(out.fatal.is_none());
}

#[tokio::test]
async fn cancel_siblings_strategy() {
    let reg = registry_with(vec![
        Arc::new(FailTool),
        Arc::new(EchoTool),
        Arc::new(SlowTool { ms: 0 }),
    ]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("f", "fail", ToolConcurrency::Sequential),
        call("c2", "echo", ToolConcurrency::Sequential),
        call("c3", "slow", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        fail_strategy: FailStrategy::CancelSiblings,
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    // 未标记 fatalOnError：执行失败非致命 → 兄弟工具继续执行
    assert!(out.fatal.is_none());
    assert!(out.results[1].is_ok());
    assert!(out.results[2].is_ok());
}

#[tokio::test]
async fn cancel_siblings_strategy_fatal_tool() {
    // fatalOnError 工具失败 → 致命：同批未执行项 cancelled
    let reg = registry_with(vec![
        Arc::new(FailToolFatal),
        Arc::new(EchoTool),
        Arc::new(SlowTool { ms: 0 }),
    ]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("f", "failfatal", ToolConcurrency::Sequential),
        call("c2", "echo", ToolConcurrency::Sequential),
        call("c3", "slow", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        fail_strategy: FailStrategy::CancelSiblings,
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[2].error_kind, Some(ToolErrorKind::Cancelled));
    assert!(out.fatal.is_some());
}

/// 事件序列契约断言（01 §五.6）：
/// - BatchStart 打头、BatchEnd 收尾；
/// - 每个取消项都有 ToolStart→ToolEnd 事件对（配对次数各一）；
/// - 全部结果携带真实 id / tool_name（无空 id 回退）。
fn assert_event_contract(
    calls: &[ToolBatchCall],
    results: &[ClassifiedToolResult],
    events: &[ToolEvent],
) {
    assert!(
        matches!(events.first(), Some(ToolEvent::BatchStart { .. })),
        "事件序列应以 BatchStart 打头"
    );
    assert!(
        matches!(events.last(), Some(ToolEvent::BatchEnd { .. })),
        "事件序列应以 BatchEnd 收尾"
    );
    let starts = |id: &str| {
        events
            .iter()
            .filter(|e| matches!(e, ToolEvent::ToolStart { call_id, .. } if call_id == id))
            .count()
    };
    let ends = |id: &str| {
        events
            .iter()
            .filter(|e| matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == id))
            .count()
    };
    for (i, (call, r)) in calls.iter().zip(results).enumerate() {
        assert!(!r.id.is_empty(), "结果 {i} 的 id 不得为空");
        assert!(!r.tool_name.is_empty(), "结果 {i} 的 tool_name 不得为空");
        assert_eq!(r.id, call.id, "结果 {i} 的 id 应与入参一致");
        assert_eq!(
            r.tool_name, call.tool_name,
            "结果 {i} 的 tool_name 应与入参一致"
        );
        if r.error_kind == Some(ToolErrorKind::Cancelled) {
            assert_eq!(
                starts(&r.id),
                1,
                "取消项 {i}（{}）缺 tool-start 事件对",
                r.id
            );
            assert_eq!(ends(&r.id), 1, "取消项 {i}（{}）缺 tool-end 事件对", r.id);
        }
    }
}

/// 混排用例 1：并行组致命 + 后置顺序项 → 全部未执行项取消 + 事件对齐全
#[tokio::test]
async fn cancel_siblings_mixed_parallel_fatal_then_sequential() {
    let reg = registry_with(vec![
        Arc::new(FailToolFatal),
        Arc::new(EchoTool),
        Arc::new(SlowTool { ms: 0 }),
    ]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("f", "failfatal", ToolConcurrency::Parallel),
        call("c2", "echo", ToolConcurrency::Sequential),
        call("c3", "slow", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        fail_strategy: FailStrategy::CancelSiblings,
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    // 并行组致命 → 后置两个顺序项全部取消（真实 id/tool_name）
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[1].id, "c2");
    assert_eq!(out.results[1].tool_name, "echo");
    assert_eq!(out.results[2].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[2].id, "c3");
    assert_eq!(out.results[2].tool_name, "slow");
    assert!(out.fatal.is_some());
    assert_event_contract(&calls, &out.results, &out.events);
}

/// 混排用例 2：并行组致命（join_all 全完成才判 fatal）+ 后置顺序项
/// → 组内兄弟正常完成，顺序项取消且事件对齐全
#[tokio::test]
async fn cancel_siblings_parallel_group_completes_before_fatal_judged() {
    let reg = registry_with(vec![
        Arc::new(SlowTool { ms: 20 }),
        Arc::new(FailToolFatal),
        Arc::new(EchoTool),
    ]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("c1", "slow", ToolConcurrency::Parallel),
        call("f", "failfatal", ToolConcurrency::Parallel),
        call("c3", "echo", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        fail_strategy: FailStrategy::CancelSiblings,
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    // 并行组 join_all 全完成才判 fatal：slow 兄弟仍正常完成
    assert!(out.results[0].is_ok(), "并行组兄弟应正常完成");
    assert_eq!(
        out.results[1].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    // 后置顺序项取消，携带真实 id/tool_name
    assert_eq!(out.results[2].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[2].id, "c3");
    assert_eq!(out.results[2].tool_name, "echo");
    assert!(out.fatal.is_some());
    assert_event_contract(&calls, &out.results, &out.events);
}

/// 混排用例 3：并行组致命 + 中间夹顺序项 → 中间项取消且事件对齐全
/// （AA-01 Q01 原始触发路径：calls = [failfatal(P), echo(S), slow(P)]）
#[tokio::test]
async fn cancel_siblings_mixed_middle_sequential_cancelled() {
    let reg = registry_with(vec![
        Arc::new(FailToolFatal),
        Arc::new(EchoTool),
        Arc::new(SlowTool { ms: 0 }),
    ]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("f", "failfatal", ToolConcurrency::Parallel),
        call("c2", "echo", ToolConcurrency::Sequential),
        call("c3", "slow", ToolConcurrency::Parallel),
    ];
    let opts = ToolBatchOptions {
        fail_strategy: FailStrategy::CancelSiblings,
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    // 中间顺序项 echo：未被执行 → 取消（修复前为空 id 脏数据）
    assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[1].id, "c2");
    assert_eq!(out.results[1].tool_name, "echo");
    // 并行组兄弟 slow 经 join_all 正常完成
    assert!(out.results[2].is_ok());
    assert!(out.fatal.is_some());
    assert_event_contract(&calls, &out.results, &out.events);
}

/// 混排用例 4：审批并行（T09.6/P8）——并行组 join_all 全完成才判
/// fatal：组内兄弟正常完成，后置顺序项取消且事件对齐全（与无审批
/// 并行组 `cancel_siblings_parallel_group_completes_before_fatal_judged`
/// 行为一致——审批不再把并行组退化串行）
#[tokio::test]
async fn cancel_siblings_approval_parallel_completes_before_fatal_judged() {
    let reg = registry_with(vec![
        Arc::new(FailToolFatal),
        Arc::new(SlowTool { ms: 0 }),
        Arc::new(EchoTool),
    ]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("f", "failfatal", ToolConcurrency::Parallel),
        call("c2", "slow", ToolConcurrency::Parallel),
        call("c3", "echo", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        fail_strategy: FailStrategy::CancelSiblings,
        approval_enabled: true,
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Approved,
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    // 审批并行：并行组 join_all 全完成才判 fatal——slow 兄弟正常完成
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    assert!(out.results[1].is_ok());
    assert_eq!(out.results[1].id, "c2");
    assert_eq!(out.results[1].tool_name, "slow");
    // 后置顺序项同样取消
    assert_eq!(out.results[2].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[2].id, "c3");
    assert_eq!(out.results[2].tool_name, "echo");
    assert!(out.fatal.is_some());
    assert_event_contract(&calls, &out.results, &out.events);
}

/// 成功路径回归：混排批次全部成功 → 事件序列不破坏
/// （每个工具一对 ToolStart→ToolEnd，BatchStart 打头、BatchEnd 收尾）
#[tokio::test]
async fn success_path_mixed_batch_event_sequence() {
    let reg = registry_with(vec![Arc::new(EchoTool), Arc::new(SlowTool { ms: 0 })]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("c1", "echo", ToolConcurrency::Parallel),
        call("c2", "slow", ToolConcurrency::Parallel),
        call("c3", "echo", ToolConcurrency::Sequential),
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
    assert!(out.fatal.is_none());
    assert!(out.results.iter().all(|r| !r.id.is_empty()));
    assert_event_contract(&calls, &out.results, &out.events);
}

#[tokio::test]
async fn continue_drain_strategy() {
    let reg = registry_with(vec![Arc::new(FailTool), Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("f", "fail", ToolConcurrency::Sequential),
        call("c2", "echo", ToolConcurrency::Sequential),
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
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    assert!(out.results[1].is_ok());
    // 未标记 fatalOnError：执行失败非致命
    assert!(out.fatal.is_none());
}

#[tokio::test]
async fn abort_cancels_pending() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 500 }), Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("s", "slow", ToolConcurrency::Sequential),
        call("e", "echo", ToolConcurrency::Sequential),
    ];
    let abort = AbortSignal::new();
    abort.abort();
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            Some(&abort),
        )
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::Cancelled));
}

/// Q21（T09.9）：abort-aware 竞速——模拟 60s 长工具 + 中途 abort →
/// 取消在数百 ms 内生效（不等 `options.timeout` 全长，AA-01 Q21 验收）
///
/// 修复前：abort 只在 timeout 返回后检查，60s 长工具需等满 60s；
/// 修复后：timeout future 与 abort 监听 future 竞速，abort 触发即
/// 取消等待并走取消收场。
#[tokio::test]
async fn abort_interrupts_long_running_tool_promptly() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 60_000 })]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "slow", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        timeout: Duration::from_secs(60),
        ..Default::default()
    };
    let abort = AbortSignal::new();
    // 50ms 后触发 abort（长工具仍在执行中）
    let aborter = {
        let abort = abort.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            abort.abort();
        })
    };
    let start = std::time::Instant::now();
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, Some(&abort))
        .await;
    let elapsed = start.elapsed();
    aborter.await.expect("aborter 不应 panic");

    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[0].error_message.as_deref(), Some("aborted"));
    assert!(
        elapsed.as_millis() < 2000,
        "取消应在数百 ms 内生效（不等 60s timeout），实际 {elapsed:?}"
    );
}

/// Q21（T09.9）对照：无 abort 时 timeout 语义不回归——超时仍以
/// tool.timeout 收场（竞速只加速 abort，不缩短正常执行窗口）
#[tokio::test]
async fn timeout_still_wins_without_abort() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 60_000 })]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "slow", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        timeout: Duration::from_millis(80),
        ..Default::default()
    };
    let abort = AbortSignal::new();
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, Some(&abort))
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Timeout));
    assert!(!abort.is_aborted(), "未触发 abort 的对照场景");
}

/// 测试工具：大输出（200 字符文本，验证输出预算截断）
struct BigOutputTool;
#[async_trait::async_trait]
impl Tool for BigOutputTool {
    fn name(&self) -> &str {
        "big"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "big".into(),
            description: "big output".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        Ok(serde_json::json!({ "text": "a".repeat(200) }))
    }
}

/// T06.4.2：output_budget_bytes 从 ToolBatchOptions 透传——超预算输出被
/// 截断（summarize 语义）；默认 None 不截断（行为不变）
#[tokio::test]
async fn output_budget_bytes_truncates_large_output() {
    let reg = registry_with(vec![Arc::new(BigOutputTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "big", ToolConcurrency::Sequential)];
    // 预算 50 字节：截断生效
    let opts = ToolBatchOptions {
        output_budget_bytes: Some(50),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert!(out.results[0].is_ok());
    let truncated = out.results[0]
        .output
        .get("json")
        .and_then(|j| j.get("contextBudget"))
        .and_then(|c| c.get("truncated"))
        .and_then(|v| v.as_bool());
    assert_eq!(truncated, Some(true), "预算内应截断并带 contextBudget 标记");
    // 默认 None：不截断（输出为工具原始返回对象，未被 summarize 改写）
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    assert_eq!(
        out.results[0]
            .output
            .get("text")
            .and_then(|t| t.as_str())
            .map(str::len),
        Some(200),
        "默认无预算不截断"
    );
}

/// T06.4.4：with_idempotency_opt 开关翻转（Some 注入 / None 移除）
#[test]
fn idempotency_opt_toggles_guard() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let mut exec = ToolExecutor::new(reg);
    assert!(!exec.idempotency_enabled());
    exec = exec.with_idempotency_opt(Some(Arc::new(
        agent_tools::idempotency::ToolIdempotencyGuard::new(),
    )));
    assert!(exec.idempotency_enabled());
    exec = exec.with_idempotency_opt(None);
    assert!(!exec.idempotency_enabled());
}

/// 测试审批门
struct MockApproval {
    decision: ApprovalDecision,
}
#[async_trait::async_trait]
impl ApprovalGate for MockApproval {
    async fn request_approval(
        &self,
        _call_id: &str,
        _tool_name: &str,
        _args: &Value,
        _requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        self.decision.clone()
    }
}

/// 记录审批请求顺序的测试门（T09.6：决策逐个按组序发起断言）
struct RecordingApproval {
    order: Arc<std::sync::Mutex<Vec<String>>>,
}
#[async_trait::async_trait]
impl ApprovalGate for RecordingApproval {
    async fn request_approval(
        &self,
        call_id: &str,
        _tool_name: &str,
        _args: &Value,
        _requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        self.order
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(call_id.to_string());
        ApprovalDecision::Approved
    }
}

/// 阻塞审批门：等待 release 通知后才返回决策（abort 中断审批测试用）
struct BlockingApproval {
    release: Arc<tokio::sync::Notify>,
    order: Arc<std::sync::Mutex<Vec<String>>>,
}
#[async_trait::async_trait]
impl ApprovalGate for BlockingApproval {
    async fn request_approval(
        &self,
        call_id: &str,
        _tool_name: &str,
        _args: &Value,
        _requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        self.order
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(call_id.to_string());
        self.release.notified().await;
        ApprovalDecision::Approved
    }
}

/// 按 call_id 选择性拒绝的测试门（并行组内单项被拒场景）
struct DenySomeApproval {
    deny: String,
}
#[async_trait::async_trait]
impl ApprovalGate for DenySomeApproval {
    async fn request_approval(
        &self,
        call_id: &str,
        _tool_name: &str,
        _args: &Value,
        _requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        if call_id == self.deny {
            ApprovalDecision::Denied {
                reason: "no".into(),
            }
        } else {
            ApprovalDecision::Approved
        }
    }
}

/// 按序返回决策的测试门（T10：批级审批通过 → 重试审批拒绝场景）
struct SequenceApproval {
    decisions: std::sync::Mutex<VecDeque<ApprovalDecision>>,
}

impl SequenceApproval {
    fn new(decisions: Vec<ApprovalDecision>) -> Self {
        Self {
            decisions: std::sync::Mutex::new(VecDeque::from(decisions)),
        }
    }
}

#[async_trait::async_trait]
impl ApprovalGate for SequenceApproval {
    async fn request_approval(
        &self,
        _call_id: &str,
        _tool_name: &str,
        _args: &Value,
        _requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        self.decisions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pop_front()
            .unwrap_or(ApprovalDecision::Approved)
    }
}

/// 挂起审批门：永不返回决策（模拟审批卡片丢失 / 事件桥断连——
/// 只模拟「审批不响应」，超时/abort 收敛必须由内核 select!/timeout
/// 真实完成，PS-04 T4.2 防作弊条款 2）
struct PendingApproval;

#[async_trait::async_trait]
impl ApprovalGate for PendingApproval {
    async fn request_approval(
        &self,
        _call_id: &str,
        _tool_name: &str,
        _args: &Value,
        _requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        std::future::pending().await
    }
}

/// 前 hang_after 次问询返回 Approved，之后挂起（requires_approval
/// 重试审批挂起测试用：批级审批先通过，重试审批不响应）
struct HangAfterApprovals {
    hang_after: usize,
    consulted: AtomicUsize,
}

impl HangAfterApprovals {
    fn new(hang_after: usize) -> Self {
        Self {
            hang_after,
            consulted: AtomicUsize::new(0),
        }
    }
}

#[async_trait::async_trait]
impl ApprovalGate for HangAfterApprovals {
    async fn request_approval(
        &self,
        _call_id: &str,
        _tool_name: &str,
        _args: &Value,
        _requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        let n = self.consulted.fetch_add(1, Ordering::SeqCst);
        if n < self.hang_after {
            ApprovalDecision::Approved
        } else {
            std::future::pending().await
        }
    }
}

/// 记录请求方身份的测试门（T-D-14：断言子代理请求透传 requester）
struct RequesterRecordingApproval {
    decision: ApprovalDecision,
    received: Arc<std::sync::Mutex<Option<ApprovalRequester>>>,
}
#[async_trait::async_trait]
impl ApprovalGate for RequesterRecordingApproval {
    async fn request_approval(
        &self,
        _call_id: &str,
        _tool_name: &str,
        _args: &Value,
        requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        *self.received.lock().unwrap() = requester.cloned();
        self.decision.clone()
    }
}

/// 测试工具：恒返回 tool.requires_approval（T10 ApprovalRequired 分类）
struct AlwaysRequiresApprovalTool;

#[async_trait::async_trait]
impl Tool for AlwaysRequiresApprovalTool {
    fn name(&self) -> &str {
        "always_approval"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "always_approval".into(),
            description: "always requires approval".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: true,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        Err(ToolError::new(
            "tool.requires_approval",
            "command requires approval",
        ))
    }
}

/// 测试工具：首调返回 tool.requires_approval，次调成功
/// （T10：用户同意后重试执行该工具调用）
#[derive(Clone)]
struct ApprovalOnceTool {
    calls: Arc<AtomicUsize>,
}

impl ApprovalOnceTool {
    fn new() -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }
    fn call_count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl Tool for ApprovalOnceTool {
    fn name(&self) -> &str {
        "approval_once"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "approval_once".into(),
            description: "first call requires approval".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: true,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            Err(ToolError::new(
                "tool.requires_approval",
                "command requires approval",
            ))
        } else {
            Ok(args)
        }
    }
}

/// 测试工具：dangerous 标记且执行成功（T10 权限判定消费 dangerous）
struct DangerousTool;

#[async_trait::async_trait]
impl Tool for DangerousTool {
    fn name(&self) -> &str {
        "dangerous_tool"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "dangerous_tool".into(),
            description: "dangerous but succeeds".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: true,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        Ok(args)
    }
}

#[tokio::test]
async fn approval_denied_is_not_fatal() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Denied {
            reason: "no".into(),
        },
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
    assert!(out.fatal.is_none());
    // 事件含 approval-requested
    assert!(out
        .events
        .iter()
        .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })));
}

#[tokio::test]
async fn approval_approved_executes() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Approved,
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert!(out.results[0].is_ok());
    assert!(out.fatal.is_none());
}

#[tokio::test]
async fn approval_expired_not_fatal() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Expired,
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalExpired)
    );
    assert!(out.fatal.is_none());
}

/// T09.6/P8：审批开启时并行组恢复并行——5×50ms 慢工具批耗时远小于
/// 串行（串行退化 ≈ 5×50ms = 250ms）。B4 并发上限（默认 4）下 5 个
/// 工具拆 2 波 ≈ 100ms 量级，断言阈值取 180ms（2 波上界 ~130ms 与
/// 串行 250ms 之间的安全中线，证明并行仍生效且并发有界）
#[tokio::test]
async fn approval_parallel_executes_concurrently() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 50 })]);
    let exec = ToolExecutor::new(reg);
    let calls = (0..5)
        .map(|i| call(&format!("p{i}"), "slow", ToolConcurrency::Parallel))
        .collect::<Vec<_>>();
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Approved,
    };
    let start = std::time::Instant::now();
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    let elapsed = start.elapsed();
    assert!(out.results.iter().all(|r| r.is_ok()));
    assert!(
        elapsed.as_millis() < 180,
        "审批并行批耗应远小于串行 250ms（B4 上限 4 → 2 波 ~100ms），实际 {elapsed:?}"
    );
}

/// T09.6/P8：审批并行组事件顺序与决策顺序——每项保持
/// tool-start → approval-requested → tool-end；审批逐个按组序发起
#[tokio::test]
async fn approval_parallel_event_order_preserved() {
    let reg = registry_with(vec![Arc::new(EchoTool), Arc::new(SlowTool { ms: 0 })]);
    let exec = ToolExecutor::new(reg);
    let ids = ["p0", "p1", "p2"];
    let calls = ids
        .iter()
        .map(|id| call(id, "echo", ToolConcurrency::Parallel))
        .collect::<Vec<_>>();
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let gate = Arc::new(RecordingApproval {
        order: Arc::clone(&order),
    });
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
        .await;
    // 审批逐个按组序发起
    assert_eq!(
        *order.lock().unwrap(),
        ids.iter().map(|s| s.to_string()).collect::<Vec<_>>()
    );
    // 每项事件顺序：tool-start 先于 approval-requested 先于 tool-end
    let start_pos = |id: &str| {
        out.events
            .iter()
            .position(|e| matches!(e, ToolEvent::ToolStart { call_id, .. } if call_id == id))
            .unwrap()
    };
    let approval_pos = |id: &str| {
        out.events
            .iter()
            .position(
                |e| matches!(e, ToolEvent::ApprovalRequested { call_id, .. } if call_id == id),
            )
            .unwrap()
    };
    let end_pos = |id: &str| {
        out.events
            .iter()
            .position(|e| matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == id))
            .unwrap()
    };
    for id in ids {
        assert!(
            start_pos(id) < approval_pos(id),
            "{id}: tool-start 应先于 approval-requested"
        );
        assert!(
            approval_pos(id) < end_pos(id),
            "{id}: approval-requested 应先于 tool-end"
        );
    }
}

/// T09.6/P8：并行组中单项被拒 → 该项 user_denied 不执行，其余项并行执行
#[tokio::test]
async fn approval_parallel_denied_skips_execution() {
    let reg = registry_with(vec![Arc::new(EchoTool), Arc::new(SlowTool { ms: 0 })]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("p0", "echo", ToolConcurrency::Parallel),
        call("p1", "echo", ToolConcurrency::Parallel),
        call("p2", "echo", ToolConcurrency::Parallel),
    ];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let gate = Arc::new(DenySomeApproval {
        deny: "p1".to_string(),
    });
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
        .await;
    assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::UserDenied));
    assert!(out.results[0].is_ok());
    assert!(out.results[2].is_ok());
    assert!(out.fatal.is_none());
}

/// T09.6/P8：审批等待期间 abort → 已发起审批保留决策，剩余项不再
/// 发起审批并全部以取消收场（与顺序路径逐项 abort 前置检查一致）
#[tokio::test]
async fn approval_parallel_abort_skips_remaining_approvals() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 0 })]);
    let exec = ToolExecutor::new(reg);
    let calls = (0..3)
        .map(|i| call(&format!("a{i}"), "slow", ToolConcurrency::Parallel))
        .collect::<Vec<_>>();
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let release = Arc::new(tokio::sync::Notify::new());
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let gate = Arc::new(BlockingApproval {
        release: Arc::clone(&release),
        order: Arc::clone(&order),
    });
    let abort = AbortSignal::new();
    let aborter = {
        let abort = abort.clone();
        let release = Arc::clone(&release);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            abort.abort();
            release.notify_waiters();
        })
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, Some(&abort))
        .await;
    aborter.await.expect("aborter 不应 panic");
    // 仅首个审批被发起（abort 后不再发起剩余审批）
    assert_eq!(order.lock().unwrap().as_slice(), &["a0".to_string()]);
    // 全部以取消收场
    assert!(out
        .results
        .iter()
        .all(|r| r.error_kind == Some(ToolErrorKind::Cancelled)));
    assert!(out
        .results
        .iter()
        .all(|r| r.error_message.as_deref() == Some("aborted")));
}

// ── F1-02（PS-04 T4.2）：批级审批挂起红测试 ──
// 缺陷：三个 `gate.request_approval(...).await` 裸挂起（顺序路径 /
// 并行组审批循环 / requires_approval 重试），abort 信号在审批等待
// 期间无法打断 run，run 无限悬挂（F1-02）。

/// T4.2-R3（红，顺序路径 abort 竞速）：审批门挂起不返回 + abort 置位
/// → 批执行必须**立即**收敛为取消（不等待 gate）。修复前裸挂起，
/// abort 无法打断，外层 tokio timeout 触发（红）
#[tokio::test]
async fn approval_hang_sequential_abort_race_converges() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let gate = Arc::new(PendingApproval);
    let abort = AbortSignal::new();
    // 50ms 后触发 abort（审批仍挂起中）
    let aborter = {
        let abort = abort.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            abort.abort();
        })
    };
    let start = std::time::Instant::now();
    let out = tokio::time::timeout(
        Duration::from_secs(2),
        exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, Some(&abort)),
    )
    .await
    .expect("审批挂起必须被 abort 竞速收敛（不得悬挂）");
    let elapsed = start.elapsed();
    aborter.await.expect("aborter 不应 panic");
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[0].error_message.as_deref(), Some("aborted"));
    assert!(
        elapsed.as_millis() < 1000,
        "abort 竞速应在数百 ms 内生效（不等 gate 不响应窗口），实际 {elapsed:?}"
    );
}

/// T4.2-R3（红，并行组 abort 竞速）：并行组审批循环挂起 + abort →
/// 全组有限时间收敛为取消（不悬挂），approval-requested 全组先发
/// 事件顺序契约保持
#[tokio::test]
async fn approval_hang_parallel_group_abort_race_converges() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("p0", "echo", ToolConcurrency::Parallel),
        call("p1", "echo", ToolConcurrency::Parallel),
    ];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let gate = Arc::new(PendingApproval);
    let abort = AbortSignal::new();
    let aborter = {
        let abort = abort.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            abort.abort();
        })
    };
    let start = std::time::Instant::now();
    let out = tokio::time::timeout(
        Duration::from_secs(2),
        exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, Some(&abort)),
    )
    .await
    .expect("并行组审批挂起必须被 abort 竞速收敛（不得悬挂）");
    let elapsed = start.elapsed();
    aborter.await.expect("aborter 不应 panic");
    // 全部以取消收场（无决策 = abort 中断，复用既有取消路径）
    assert!(out
        .results
        .iter()
        .all(|r| r.error_kind == Some(ToolErrorKind::Cancelled)));
    assert!(
        elapsed.as_millis() < 1000,
        "并行组 abort 竞速应在数百 ms 内收敛，实际 {elapsed:?}"
    );
    // approval-requested 全组先发契约保持（等待前已全部广播）
    let approvals = out
        .events
        .iter()
        .filter(|e| matches!(e, ToolEvent::ApprovalRequested { .. }))
        .count();
    assert!(approvals >= 1, "审批请求事件应先于等待发出");
}

/// T4.2-R4（红，requires_approval 重试路径 abort 竞速）：批级审批
/// 通过 → 工具返回 ApprovalRequired → 重试审批挂起 + abort → 有限
/// 时间收敛为取消（修复前 :1140 裸挂起，红）
#[tokio::test]
async fn requires_approval_retry_hang_abort_race_converges() {
    let reg = registry_with(vec![Arc::new(AlwaysRequiresApprovalTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    // 首次问询（批级审批）通过，重试审批挂起
    let gate = Arc::new(HangAfterApprovals::new(1));
    let abort = AbortSignal::new();
    let aborter = {
        let abort = abort.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            abort.abort();
        })
    };
    let start = std::time::Instant::now();
    let out = tokio::time::timeout(
        Duration::from_secs(2),
        exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, Some(&abort)),
    )
    .await
    .expect("重试审批挂起必须被 abort 竞速收敛（不得悬挂）");
    let elapsed = start.elapsed();
    aborter.await.expect("aborter 不应 panic");
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
    assert!(
        elapsed.as_millis() < 1000,
        "重试审批 abort 竞速应在数百 ms 内收敛，实际 {elapsed:?}"
    );
}

/// T4.2-R1（绿，顺序路径超时）：审批门挂起不返回 + 测试注入短超时
/// → 批执行在超时内收敛为 Expired（内核 timeout 真实收敛，外层
/// tokio timeout 不触发）
#[tokio::test]
async fn approval_wait_times_out_when_gate_hangs() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        approval_timeout: Some(Duration::from_millis(50)),
        ..Default::default()
    };
    let gate = Arc::new(PendingApproval);
    let start = std::time::Instant::now();
    let out = tokio::time::timeout(
        Duration::from_secs(2),
        exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None),
    )
    .await
    .expect("审批挂起必须被超时收敛（不得悬挂）");
    let elapsed = start.elapsed();
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalExpired),
        "超时应复用 Expired 分支"
    );
    assert!(
        elapsed.as_millis() < 1000,
        "超时应在内核审批超时附近收敛，实际 {elapsed:?}"
    );
    // 非致命：喂回模型继续
    assert!(out.fatal.is_none());
    // G-9：超时 → Expired 权威语义落库——approval-resolved(expired)
    // 事件进批事件流，顺序契约：
    // approval-requested → approval-resolved → tool-end
    let req = out
        .events
        .iter()
        .position(|e| matches!(e, ToolEvent::ApprovalRequested { call_id, .. } if call_id == "c1"))
        .expect("应有 approval-requested");
    let resolved = out
        .events
        .iter()
        .position(|e| {
            matches!(e, ToolEvent::ApprovalResolved { call_id, decision }
                    if call_id == "c1" && *decision == ApprovalDecision::Expired)
        })
        .expect("超时应收敛为 approval-resolved(expired) 落库");
    let end = out
        .events
        .iter()
        .position(|e| matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == "c1"))
        .expect("应有 tool-end");
    assert!(
        req < resolved && resolved < end,
        "approval-resolved(expired) 应位于 approval-requested 与 tool-end 之间"
    );
}

/// T4.2-R2（绿，并行组超时）：审批门挂起 + 短超时 → 全组收敛为
/// Expired，无悬挂；approval-requested 全组先发事件顺序契约保持
#[tokio::test]
async fn approval_wait_parallel_group_timeout_converges() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("p0", "echo", ToolConcurrency::Parallel),
        call("p1", "echo", ToolConcurrency::Parallel),
    ];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        approval_timeout: Some(Duration::from_millis(50)),
        ..Default::default()
    };
    let gate = Arc::new(PendingApproval);
    let out = tokio::time::timeout(
        Duration::from_secs(2),
        exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None),
    )
    .await
    .expect("并行组审批挂起必须被超时收敛（不得悬挂）");
    assert!(out
        .results
        .iter()
        .all(|r| r.error_kind == Some(ToolErrorKind::ApprovalExpired)));
    // approval-requested 全组先发契约保持（等待前已全部广播）
    let approvals = out
        .events
        .iter()
        .filter(|e| matches!(e, ToolEvent::ApprovalRequested { .. }))
        .count();
    assert_eq!(approvals, 2, "全组审批请求应先于等待发出");
    assert!(out.fatal.is_none());
    // G-9：超时 → Expired 权威语义落库——每项一条
    // approval-resolved(expired)，位于本项 approval-requested 与
    // tool-end 之间
    let resolved = out
        .events
        .iter()
        .filter(|e| {
            matches!(
                e,
                ToolEvent::ApprovalResolved {
                    decision: ApprovalDecision::Expired,
                    ..
                }
            )
        })
        .count();
    assert_eq!(
        resolved, 2,
        "并行组超时每项都应落一条 approval-resolved(expired)"
    );
    for id in ["p0", "p1"] {
        let req = out
            .events
            .iter()
            .position(
                |e| matches!(e, ToolEvent::ApprovalRequested { call_id, .. } if call_id == id),
            )
            .unwrap_or_else(|| panic!("{id} 应有 approval-requested"));
        let res = out
            .events
            .iter()
            .position(|e| {
                matches!(e, ToolEvent::ApprovalResolved { call_id, decision }
                        if call_id == id && *decision == ApprovalDecision::Expired)
            })
            .unwrap_or_else(|| panic!("{id} 应有 approval-resolved(expired)"));
        let end = out
            .events
            .iter()
            .position(|e| matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == id))
            .unwrap_or_else(|| panic!("{id} 应有 tool-end"));
        assert!(
            req < res && res < end,
            "{id} 的 approval-resolved(expired) 应位于 approval-requested 与 tool-end 之间"
        );
    }
}

/// T4.2-R4（绿，requires_approval 重试路径超时）：批级审批通过 →
/// 工具返回 ApprovalRequired → 重试审批挂起 + 短超时 → ApprovalExpired
/// 收敛（:1140 点位不再裸挂起）
#[tokio::test]
async fn requires_approval_retry_hang_times_out() {
    let reg = registry_with(vec![Arc::new(AlwaysRequiresApprovalTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        approval_timeout: Some(Duration::from_millis(50)),
        ..Default::default()
    };
    // 首次问询（批级审批）通过，重试审批挂起
    let gate = Arc::new(HangAfterApprovals::new(1));
    let out = tokio::time::timeout(
        Duration::from_secs(2),
        exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None),
    )
    .await
    .expect("重试审批挂起必须被超时收敛（不得悬挂）");
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalExpired),
        "重试审批超时应收敛为 ApprovalExpired：{:?}",
        out.results[0]
    );
    assert!(out.fatal.is_none());
    // G-9：超时 → Expired 权威语义落库——requires_approval 重试路径
    // 同样落 approval-resolved(expired)（首次问询通过不落 resolved，
    // 只有超时决策落；本路径事件仅一条）
    let resolved = out
        .events
        .iter()
        .filter(|e| {
            matches!(
                e,
                ToolEvent::ApprovalResolved {
                    decision: ApprovalDecision::Expired,
                    ..
                }
            )
        })
        .count();
    assert_eq!(
        resolved, 1,
        "重试审批超时应落一条 approval-resolved(expired)"
    );
}

// ── R4 T10：真实审批事件（requires_approval / dangerous / permissionMode）──

/// T10 回归：tool.requires_approval 不再落入软拒绝分类，归类为
/// ApprovalRequired 透传审批状态（无审批门时）
#[tokio::test]
async fn requires_approval_is_not_soft_deny_without_gate() {
    let reg = registry_with(vec![Arc::new(AlwaysRequiresApprovalTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalRequired),
        "requires_approval 应分类为 ApprovalRequired"
    );
    assert_ne!(
        out.results[0].error_kind,
        Some(ToolErrorKind::SoftDeny),
        "不再折叠为 SoftDeny"
    );
    assert_eq!(
        out.results[0].error_kind.map(|k| k.error_code()),
        Some("tool.requires_approval")
    );
    // 审批/控制类错误永不致命
    assert!(out.fatal.is_none());
}

/// T10：requires_approval 产生真实审批请求（走 gate），用户同意后
/// 重试执行该工具调用
#[tokio::test]
async fn requires_approval_approved_then_retries_execution() {
    let tool = ApprovalOnceTool::new();
    let reg = registry_with(vec![Arc::new(tool.clone())]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "approval_once", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Approved,
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    // 批级审批通过 → 工具首调 requires_approval → ApprovalRequired →
    // 真实审批（gate 再次问询）→ 用户同意 → 重试执行成功
    assert!(out.results[0].is_ok(), "重试后应成功：{:?}", out.results[0]);
    assert_eq!(tool.call_count(), 2, "工具应被重试执行（共 2 次）");
    // 两次审批请求均产生 approval-requested 事件（批级 + 重试）
    let approvals = out
        .events
        .iter()
        .filter(|e| matches!(e, ToolEvent::ApprovalRequested { .. }))
        .count();
    assert_eq!(approvals, 2);
    assert!(out.fatal.is_none());
}

/// T10：requires_approval 重试审批被拒绝 → 明确拒绝结果（Denied 语义）
#[tokio::test]
async fn requires_approval_denied_returns_user_denied() {
    let tool = AlwaysRequiresApprovalTool;
    let reg = registry_with(vec![Arc::new(tool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    // 批级审批通过（首问），重试审批拒绝（次问）
    let gate = SequenceApproval::new(vec![
        ApprovalDecision::Approved,
        ApprovalDecision::Denied {
            reason: "no".into(),
        },
    ]);
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
    assert!(out.results[0]
        .error_message
        .as_deref()
        .unwrap_or_default()
        .contains("user denied: no"));
    // 拒绝非致命（喂回模型，Denied 语义）
    assert!(out.fatal.is_none());
}

/// T10：requires_approval 重试审批过期 → ApprovalExpired
#[tokio::test]
async fn requires_approval_expired_returns_approval_expired() {
    let tool = AlwaysRequiresApprovalTool;
    let reg = registry_with(vec![Arc::new(tool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let gate = SequenceApproval::new(vec![ApprovalDecision::Approved, ApprovalDecision::Expired]);
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalExpired)
    );
}

/// T10 消费 dangerous：ask 模式仅危险工具进审批，安全工具直接执行
#[tokio::test]
async fn permission_ask_mode_routes_only_dangerous_to_approval() {
    let reg = registry_with(vec![Arc::new(DangerousTool), Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("c1", "dangerous_tool", ToolConcurrency::Parallel),
        call("c2", "echo", ToolConcurrency::Parallel),
    ];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let gate = Arc::new(RecordingApproval {
        order: Arc::clone(&order),
    });
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
        .await;
    // 仅 dangerous 项发起审批；echo 直接执行
    assert_eq!(*order.lock().unwrap(), vec!["c1".to_string()]);
    assert!(out.results.iter().all(|r| r.is_ok()));
    // approval-requested 事件仅对应危险项
    let approvals: Vec<&str> = out
        .events
        .iter()
        .filter_map(|e| match e {
            ToolEvent::ApprovalRequested { call_id, .. } => Some(call_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(approvals, vec!["c1"]);
}

/// T10 消费 dangerous：ask 模式危险项被用户拒绝 → UserDenied 不执行
#[tokio::test]
async fn permission_ask_mode_denied_dangerous_skips_execution() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Denied {
            reason: "no".into(),
        },
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
}

/// T10 消费 dangerous：plan 模式写类（dangerous）工具拒绝且不弹窗
#[tokio::test]
async fn permission_plan_mode_denies_dangerous_tools() {
    let reg = registry_with(vec![Arc::new(DangerousTool), Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("c1", "dangerous_tool", ToolConcurrency::Sequential),
        call("c2", "echo", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Plan),
        ..Default::default()
    };
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let gate = Arc::new(RecordingApproval {
        order: Arc::clone(&order),
    });
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
        .await;
    // plan 模式：写类工具直接拒绝（Denied 语义），安全工具放行
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
    assert!(out.results[0]
        .error_message
        .as_deref()
        .unwrap_or_default()
        .contains("permission denied"));
    assert!(out.results[1].is_ok());
    // 不发起任何审批（不弹窗）
    assert!(order.lock().unwrap().is_empty(), "plan 模式不应发起审批");
    assert!(!out
        .events
        .iter()
        .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })));
    assert!(out.fatal.is_none());
}

/// T10 消费 dangerous：plan 模式并行组——写类拒绝、安全项并行执行
#[tokio::test]
async fn permission_plan_parallel_denies_dangerous_runs_safe() {
    let reg = registry_with(vec![Arc::new(DangerousTool), Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("c1", "dangerous_tool", ToolConcurrency::Parallel),
        call("c2", "echo", ToolConcurrency::Parallel),
        call("c3", "echo", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Plan),
        ..Default::default()
    };
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let gate = Arc::new(RecordingApproval {
        order: Arc::clone(&order),
    });
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
    assert!(out.results[1].is_ok());
    assert!(out.results[2].is_ok());
    assert!(order.lock().unwrap().is_empty());
    assert!(out.fatal.is_none());
}

/// T10 消费 dangerous：full-access 模式危险工具直接放行（无审批）
#[tokio::test]
async fn permission_full_access_allows_dangerous_tools() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: false,
        permission_mode: Some(PermissionMode::FullAccess),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert!(out.results[0].is_ok(), "full-access 放行危险工具");
    assert!(!out
        .events
        .iter()
        .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })));
}

/// T10：显式 ask 模式但无审批门 → 危险项透传需审批状态（不静默执行）
#[tokio::test]
async fn permission_ask_without_gate_passes_through_approval_required() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: false,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalRequired),
        "无审批基础设施时不应静默执行危险工具"
    );
}

// ── W4-B：笔记写工具经 session-loop 审批矩阵接线 ──────────────────

/// W4-B：plan 模式拒绝真实 `document_apply_md`（不弹窗、不执行 backend）
#[tokio::test]
async fn w4b_plan_mode_denies_document_apply_md() {
    use agent_tools::register_builtin_tools;
    let mut reg = ToolRegistry::new();
    register_builtin_tools(&mut reg).expect("register builtins");
    let exec = ToolExecutor::new(Arc::new(reg));
    let calls = vec![ToolBatchCall {
        id: "c-note-write".into(),
        tool_name: "document_apply_md".into(),
        summary: "note write".into(),
        input: serde_json::json!({ "doc_id": "d", "markdown": "x" }),
        category: conex_types::tool::ToolCategory::Internal,
        concurrency: ToolConcurrency::Sequential,
    }];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Plan),
        ..Default::default()
    };
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let gate = Arc::new(RecordingApproval {
        order: Arc::clone(&order),
    });
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::UserDenied),
        "plan 必须拒绝笔记写：{:?}",
        out.results[0]
    );
    assert!(out.results[0]
        .error_message
        .as_deref()
        .unwrap_or_default()
        .contains("permission denied"));
    assert!(order.lock().unwrap().is_empty(), "plan 不得弹审批窗");
    assert!(out.fatal.is_none());
}

/// W4-B：plan 模式放行笔记只读 `query_blocks`（safe 边界）
#[tokio::test]
async fn w4b_plan_mode_allows_query_blocks_safe() {
    use agent_tools::register_builtin_tools;
    let mut reg = ToolRegistry::new();
    register_builtin_tools(&mut reg).expect("register builtins");
    let exec = ToolExecutor::new(Arc::new(reg));
    let calls = vec![ToolBatchCall {
        id: "c-note-read".into(),
        tool_name: "query_blocks".into(),
        summary: "note read".into(),
        input: serde_json::json!({ "doc_id": "d" }),
        category: conex_types::tool::ToolCategory::Internal,
        concurrency: ToolConcurrency::Sequential,
    }];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Plan),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    // plan 下只读应执行（未接线 backend → ok=false unwired，非 user_denied）
    assert!(
        out.results[0].error_kind.is_none(),
        "plan 不得拒 safe 读：{:?}",
        out.results[0]
    );
    let out_val = &out.results[0].output;
    assert_eq!(out_val["ok"], false);
    assert_eq!(out_val["reason"], "note_backend_unwired");
}

/// W4-B：ask 模式 + 用户拒绝 → document_apply_md 得 user_denied
#[tokio::test]
async fn w4b_ask_mode_denied_document_apply_md_user_denied() {
    use agent_tools::register_builtin_tools;
    let mut reg = ToolRegistry::new();
    register_builtin_tools(&mut reg).expect("register builtins");
    let exec = ToolExecutor::new(Arc::new(reg));
    let calls = vec![ToolBatchCall {
        id: "c-note-deny".into(),
        tool_name: "document_apply_md".into(),
        summary: "note write denied".into(),
        input: serde_json::json!({ "doc_id": "d", "markdown": "blocked" }),
        category: conex_types::tool::ToolCategory::Internal,
        concurrency: ToolConcurrency::Sequential,
    }];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Denied {
            reason: "user said no notes".into(),
        },
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::UserDenied),
        "ask 拒绝 → user_denied：{:?}",
        out.results[0]
    );
    assert!(
        out.results[0]
            .error_message
            .as_deref()
            .unwrap_or_default()
            .contains("user said no notes")
            || out.results[0]
                .error_message
                .as_deref()
                .unwrap_or_default()
                .contains("user denied")
    );
    assert!(out.fatal.is_none());
}

/// T10 集成：dangerous shell 工具经权限判定进入审批（Approved 后执行），
/// ApprovalChannel 的审批事件进入批事件流
#[tokio::test]
async fn permission_ask_mode_approval_channel_events_in_batch_stream() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Approved,
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert!(out.results[0].is_ok());
    // 事件顺序契约：tool-start → approval-requested → tool-end
    let start = out
        .events
        .iter()
        .position(|e| matches!(e, ToolEvent::ToolStart { call_id, .. } if call_id == "c1"))
        .unwrap();
    let approval = out
        .events
        .iter()
        .position(|e| matches!(e, ToolEvent::ApprovalRequested { call_id, .. } if call_id == "c1"))
        .unwrap();
    let end = out
        .events
        .iter()
        .position(|e| matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == "c1"))
        .unwrap();
    assert!(start < approval && approval < end, "审批事件顺序契约被破坏");
}

// ── I3-S6：C3 大面积回退审批（判定点集成，04 C3 验收 1/3/5 对齐）──

/// 固定面积评估器（测试注入）
#[derive(Debug)]
struct FixedAreaAssessor(agent_tools::revert::RevertArea);

impl agent_tools::revert::RevertAssessor for FixedAreaAssessor {
    fn assess(
        &self,
        _target: &agent_tools::revert::RevertTarget,
    ) -> agent_tools::revert::RevertArea {
        self.0.clone()
    }
}

fn revert_policy(area: agent_tools::revert::RevertArea) -> agent_tools::revert::RevertPolicy {
    agent_tools::revert::RevertPolicy::default().with_assessor(Arc::new(FixedAreaAssessor(area)))
}

fn large_area() -> agent_tools::revert::RevertArea {
    agent_tools::revert::RevertArea {
        file_count: Some(25),
        line_count: Some(1200),
        cross_directory: true,
        ref_age_seconds: Some(36 * 3600),
    }
}

fn small_area() -> agent_tools::revert::RevertArea {
    agent_tools::revert::RevertArea {
        file_count: Some(2),
        line_count: Some(40),
        cross_directory: false,
        ref_age_seconds: Some(3600),
    }
}

/// 携带命令文本入参的工具调用（C3 判定点从 input.command 取命令）
fn command_call(id: &str, name: &str, command: &str) -> ToolBatchCall {
    ToolBatchCall {
        id: id.into(),
        tool_name: name.into(),
        summary: format!("call {name}"),
        input: serde_json::json!({ "command": command }),
        category: conex_types::tool::ToolCategory::Internal,
        concurrency: ToolConcurrency::Sequential,
    }
}

/// C3 验收 5 + full-access 不豁免：full-access 下大面积回退且无审批门 →
/// 阈值检查仍生效（CommandPolicy 兜底：结构化拒绝，不做无限等待），
/// 工具不执行、run 非致命
#[tokio::test]
async fn full_access_large_revert_refused_without_gate() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
    let calls = vec![command_call("c1", "echo", "git checkout abc1234")];
    let opts = ToolBatchOptions {
        approval_enabled: false,
        permission_mode: Some(PermissionMode::FullAccess),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalRequired),
        "full-access 下大面积回退不得静默执行"
    );
    let msg = out.results[0].error_message.as_deref().unwrap_or_default();
    assert!(msg.contains("大面积 git 回退需用户审批"), "拒绝文案：{msg}");
    assert!(msg.contains("缩小回退范围或改用单文件修复"), "指引：{msg}");
    assert!(msg.contains("full-access 不豁免"), "不豁免声明：{msg}");
    // 工具未执行：EchoTool 若执行必成功（is_ok），拒绝态即证明未执行
    assert!(out.fatal.is_none(), "拒绝不是引擎故障");
}

/// C3 验收 1：ask 模式大面积回退产生审批请求（approval-requested 事件），
/// 审批人 = 用户（门裁决）；Denied → 结构化拒绝、工具不执行
#[tokio::test]
async fn ask_large_revert_denied_after_approval_request() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
    let calls = vec![command_call("c1", "echo", "git reset --hard HEAD~30")];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Denied {
            reason: "no".into(),
        },
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
    assert!(
        out.events
            .iter()
            .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })),
        "审批请求必须真实发出（用户裁决入口）"
    );
    assert!(out.fatal.is_none(), "拒绝不崩溃、run 状态正常");
}

/// C3 验收 1 通过路径：用户批准后大面积回退才执行
#[tokio::test]
async fn ask_large_revert_approved_then_executes() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
    let calls = vec![command_call("c1", "echo", "git checkout abc1234")];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Approved,
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert!(out.results[0].is_ok(), "用户批准后才执行");
}

/// C3 验收 3：面积低于全部阈值 → full-access 放行（零打扰，无审批事件）
#[tokio::test]
async fn full_access_small_revert_executes_without_approval() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(small_area()));
    let calls = vec![command_call(
        "c1",
        "echo",
        "git restore --source=HEAD~1 src/main.rs",
    )];
    let opts = ToolBatchOptions {
        approval_enabled: false,
        permission_mode: Some(PermissionMode::FullAccess),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert!(out.results[0].is_ok(), "小面积回退零打扰");
    assert!(!out
        .events
        .iter()
        .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })));
}

/// 分支切换（非回退形态）不被 C3 门禁拦截：full-access 直接执行
#[tokio::test]
async fn checkout_branch_switch_not_gated() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
    let calls = vec![command_call("c1", "echo", "git checkout main")];
    let opts = ToolBatchOptions {
        approval_enabled: false,
        permission_mode: Some(PermissionMode::FullAccess),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert!(out.results[0].is_ok(), "分支切换不是回退，C3 不拦截");
}

/// 无命令文本入参（非命令类工具）不受 C3 门禁影响（既有语义不变）
#[tokio::test]
async fn non_command_input_not_gated() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: false,
        permission_mode: Some(PermissionMode::FullAccess),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert!(out.results[0].is_ok(), "非命令入参按既有矩阵放行");
}

// ── 中间件链 + 插件钩子接线（ToolMiddleware 真实扩展点 + HookRegistry）──
// 优先级语义：审批优先于中间件（拒绝/过期不进入中间件链）；中间件
// Block 只拦截「审批已通过」的调用（详见模块头注与决策文档）。

/// 计数工具：每次执行自增并原样返回入参（验证中间件/钩子修改与阻止）
struct CountingEchoTool {
    calls: Arc<AtomicUsize>,
}
#[async_trait]
impl Tool for CountingEchoTool {
    fn name(&self) -> &str {
        "countecho"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "countecho".into(),
            description: "count then echo".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(args)
    }
}

/// 修改入参的中间件：为 {"v": "x"} 追加后缀（验证 before 链可改输入）
struct PrefixMiddleware {
    name: String,
    suffix: String,
}
#[async_trait]
impl ToolMiddleware for PrefixMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn before_execute(
        &self,
        _tool: &dyn Tool,
        mut input: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<BeforeExecuteResult, ToolError> {
        if let Some(v) = input.get_mut("v") {
            if let Some(s) = v.as_str() {
                *v = Value::String(format!("{s}{}", self.suffix));
            }
        }
        Ok(BeforeExecuteResult::Proceed {
            modified_input: Some(input),
        })
    }
}

/// 按入参 block 标记阻止执行的中间件
struct BlockingMiddleware {
    name: String,
}
#[async_trait]
impl ToolMiddleware for BlockingMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn before_execute(
        &self,
        _tool: &dyn Tool,
        input: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<BeforeExecuteResult, ToolError> {
        if input.get("block").and_then(Value::as_bool) == Some(true) {
            Ok(BeforeExecuteResult::Block {
                reason: "策略拦截".into(),
            })
        } else {
            Ok(BeforeExecuteResult::Proceed {
                modified_input: None,
            })
        }
    }
}

/// 替换输出的中间件（验证 on_result 改写）
struct ReplaceMiddleware {
    name: String,
    replacement: Value,
}
#[async_trait]
impl ToolMiddleware for ReplaceMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn on_result(
        &self,
        _tool: &dyn Tool,
        _input: &Value,
        _output: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<AfterExecuteResult, ToolError> {
        Ok(AfterExecuteResult::Replace(self.replacement.clone()))
    }
}

/// 恒失败的 on_result 中间件（验证降级透传）
struct FailingAfterMiddleware {
    name: String,
}
#[async_trait]
impl ToolMiddleware for FailingAfterMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn on_result(
        &self,
        _tool: &dyn Tool,
        _input: &Value,
        _output: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<AfterExecuteResult, ToolError> {
        Err(ToolError::execution_failed("failing-after", "after boom"))
    }
}

/// 记录 on_error 调用的中间件（验证失败观察）
struct ErrorSpyMiddleware {
    name: String,
    seen: Arc<Mutex<Vec<String>>>,
}
#[async_trait]
impl ToolMiddleware for ErrorSpyMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn on_error(
        &self,
        _tool: &dyn Tool,
        _input: &Value,
        error: &ToolError,
        _ctx: &ToolExecutionContext,
    ) -> Result<(), ToolError> {
        self.seen
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(error.to_string());
        Ok(())
    }
}

/// 计数 before_execute 调用的中间件（审批优先级验证用）
struct CallCounterMiddleware {
    name: String,
    calls: Arc<AtomicUsize>,
}
#[async_trait]
impl ToolMiddleware for CallCounterMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn before_execute(
        &self,
        _tool: &dyn Tool,
        _input: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<BeforeExecuteResult, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(BeforeExecuteResult::Proceed {
            modified_input: None,
        })
    }
}

/// 插件钩子测试替身：记录 tool.post 事件（tool_name, is_error）
struct SpyHook {
    name: String,
    posts: Arc<Mutex<Vec<(String, bool)>>>,
    action: Option<HookAction>,
    err: Option<HookError>,
}

impl SpyHook {
    fn observing(name: &str) -> Self {
        Self {
            name: name.to_string(),
            posts: Arc::new(Mutex::new(Vec::new())),
            action: None,
            err: None,
        }
    }

    fn blocking(name: &str) -> Self {
        Self {
            name: name.to_string(),
            posts: Arc::new(Mutex::new(Vec::new())),
            action: Some(HookAction::Block {
                reason: "钩子拦截".into(),
            }),
            err: None,
        }
    }

    fn failing(name: &str) -> Self {
        Self {
            name: name.to_string(),
            posts: Arc::new(Mutex::new(Vec::new())),
            action: None,
            err: Some(HookError::new("hook boom")),
        }
    }

    fn posts(&self) -> Vec<(String, bool)> {
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

fn block_call(id: &str, name: &str) -> ToolBatchCall {
    let mut c = call(id, name, ToolConcurrency::Sequential);
    c.input = serde_json::json!({ "v": id, "block": true });
    c
}

#[tokio::test]
async fn middleware_before_chain_modifies_input() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(PrefixMiddleware {
        name: "prefix".into(),
        suffix: "-mw".into(),
    })]);
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
    assert!(out.results[0].is_ok());
    // EchoTool 原样返回入参 → 中间件修改后的入参可见
    assert_eq!(
        out.results[0].output.get("v"),
        Some(&Value::String("c1-mw".into())),
        "before 链应修改入参"
    );
}

#[tokio::test]
async fn middleware_before_block_prevents_execution() {
    let tool = Arc::new(CountingEchoTool {
        calls: Arc::new(AtomicUsize::new(0)),
    });
    let reg = registry_with(vec![Arc::clone(&tool) as Arc<dyn Tool>]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(BlockingMiddleware {
        name: "blocker".into(),
    })]);
    let calls = vec![block_call("c1", "countecho")];
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
            .contains("被中间件 blocker 阻止"),
        "阻止文案应携带中间件名：{:?}",
        r.error_message
    );
    assert_eq!(tool.calls.load(Ordering::SeqCst), 0, "被阻止的工具不应执行");
}

#[tokio::test]
async fn middleware_on_result_replace_output() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(ReplaceMiddleware {
        name: "replacer".into(),
        replacement: serde_json::json!({ "wrapped": true }),
    })]);
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
    assert_eq!(
        out.results[0].output,
        serde_json::json!({ "wrapped": true })
    );
}

#[tokio::test]
async fn middleware_on_error_observes_failure() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let reg = registry_with(vec![Arc::new(FailTool)]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(ErrorSpyMiddleware {
        name: "spy".into(),
        seen: Arc::clone(&seen),
    })]);
    let calls = vec![call("c1", "fail", ToolConcurrency::Sequential)];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    let msgs = seen.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(msgs.len(), 1);
    assert!(msgs[0].contains("boom"));
}

#[tokio::test]
async fn middleware_on_result_error_degrades_to_passthrough() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(FailingAfterMiddleware {
        name: "failing".into(),
    })]);
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
    // 后置钩子错误：记录日志并降级透传原输出（不改变已完成的执行结果）
    assert!(out.results[0].is_ok(), "on_result 失败应降级透传原输出");
    assert_eq!(out.results[0].output, serde_json::json!({ "v": "c1" }));
}

#[tokio::test]
async fn middleware_empty_chain_is_noop() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_middleware(Vec::new());
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
    assert!(out.results[0].is_ok());
    assert_eq!(out.results[0].output, serde_json::json!({ "v": "c1" }));
}

/// 审批优先于中间件：拒绝时不进入中间件链，通过后中间件参与执行
#[tokio::test]
async fn middleware_runs_after_approval_gate() {
    let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };

    // 审批拒绝：中间件 before_execute 不被调用（审批优先语义）
    let counter = Arc::new(AtomicUsize::new(0));
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(CallCounterMiddleware {
        name: "counter".into(),
        calls: Arc::clone(&counter),
    })]);
    let gate = MockApproval {
        decision: ApprovalDecision::Denied {
            reason: "no".into(),
        },
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
    assert_eq!(counter.load(Ordering::SeqCst), 0, "审批拒绝时中间件不参与");

    // 审批通过：中间件进入执行面
    let counter2 = Arc::new(AtomicUsize::new(0));
    let reg2 = registry_with(vec![Arc::new(DangerousTool)]);
    let exec2 = ToolExecutor::new(reg2).with_middleware(vec![Arc::new(CallCounterMiddleware {
        name: "counter".into(),
        calls: Arc::clone(&counter2),
    })]);
    let gate2 = MockApproval {
        decision: ApprovalDecision::Approved,
    };
    let out2 = exec2
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate2)), &opts, None)
        .await;
    assert!(out2.results[0].is_ok());
    assert_eq!(
        counter2.load(Ordering::SeqCst),
        1,
        "审批通过后中间件参与执行"
    );
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

// ── E4：middleware 超时竞速窗口（06 遗留 :148-152 收口）──────────

/// 慢 before_execute 中间件：sleep 后放行（超时竞速断言用）
struct SlowBeforeMiddleware {
    name: String,
    sleep_ms: u64,
}
#[async_trait]
impl ToolMiddleware for SlowBeforeMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn before_execute(
        &self,
        _tool: &dyn Tool,
        input: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<BeforeExecuteResult, ToolError> {
        tokio::time::sleep(Duration::from_millis(self.sleep_ms)).await;
        Ok(BeforeExecuteResult::Proceed {
            modified_input: Some(input),
        })
    }
}

/// 慢 on_result / on_error 中间件：sleep 后透传（超时降级断言用）
struct SlowAfterMiddleware {
    name: String,
    sleep_ms: u64,
}
#[async_trait]
impl ToolMiddleware for SlowAfterMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn on_result(
        &self,
        _tool: &dyn Tool,
        _input: &Value,
        _output: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<AfterExecuteResult, ToolError> {
        tokio::time::sleep(Duration::from_millis(self.sleep_ms)).await;
        Ok(AfterExecuteResult::Passthrough)
    }
}

/// before_execute 超时 → 视为 Err → Block（守门者报错 = 不放行，
/// 06:57）：工具未执行、结果 ExecutionFailed、文案含中间件名与超时
#[tokio::test]
async fn middleware_before_timeout_blocks_tool() {
    let tool = Arc::new(CountingEchoTool {
        calls: Arc::new(AtomicUsize::new(0)),
    });
    let reg = registry_with(vec![Arc::clone(&tool) as Arc<dyn Tool>]);
    let timeouts = MiddlewareTimeoutConfig {
        before_execute: Duration::from_millis(1),
        ..MiddlewareTimeoutConfig::default()
    };
    let exec = ToolExecutor::new(reg)
        .with_middleware(vec![Arc::new(SlowBeforeMiddleware {
            name: "slow".into(),
            sleep_ms: 300,
        })])
        .with_middleware_timeouts(timeouts);
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
            .contains("slow"),
        "超时阻止文案应携带中间件名：{:?}",
        r.error_message
    );
    assert!(
        r.error_message
            .as_deref()
            .unwrap_or_default()
            .contains("超时"),
        "超时阻止文案应标注超时：{:?}",
        r.error_message
    );
    assert_eq!(
        tool.calls.load(Ordering::SeqCst),
        0,
        "超时阻止时工具不应执行"
    );
}

/// on_result 超时 → 日志 + 降级透传原输出（06:58）
#[tokio::test]
async fn middleware_on_result_timeout_degrades_to_passthrough() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let timeouts = MiddlewareTimeoutConfig {
        on_result: Duration::from_millis(1),
        ..MiddlewareTimeoutConfig::default()
    };
    let exec = ToolExecutor::new(reg)
        .with_middleware(vec![Arc::new(SlowAfterMiddleware {
            name: "slow-after".into(),
            sleep_ms: 300,
        })])
        .with_middleware_timeouts(timeouts);
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
    assert!(out.results[0].is_ok(), "on_result 超时应降级透传原输出");
    assert_eq!(out.results[0].output, serde_json::json!({ "v": "c1" }));
}

/// on_error 超时 → 仅日志（06:59）：原错误结果保持（不吞错）
#[tokio::test]
async fn middleware_on_error_timeout_keeps_error_result() {
    let reg = registry_with(vec![Arc::new(FailTool)]);
    let timeouts = MiddlewareTimeoutConfig {
        on_error: Duration::from_millis(1),
        ..MiddlewareTimeoutConfig::default()
    };
    let exec = ToolExecutor::new(reg)
        .with_middleware(vec![Arc::new(SlowAfterMiddleware {
            name: "slow-error".into(),
            sleep_ms: 300,
        })])
        .with_middleware_timeouts(timeouts);
    let calls = vec![call("c1", "fail", ToolConcurrency::Sequential)];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    // 工具失败结果原样保持（on_error 超时只影响观察链，不改变结果）
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    assert!(out.results[0]
        .error_message
        .as_deref()
        .unwrap_or_default()
        .contains("boom"));
}

/// 默认超时 = 宽松放行：快中间件在默认竞速窗口内正常通过（现有
/// 中间件语义不受引入超时窗口影响）
#[tokio::test]
async fn middleware_default_timeouts_allow_fast_hooks() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(PrefixMiddleware {
        name: "prefix".into(),
        suffix: "-ok".into(),
    })]);
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
    assert!(out.results[0].is_ok(), "默认超时下快中间件正常放行");
    assert_eq!(
        out.results[0].output.get("v"),
        Some(&Value::String("c1-ok".into()))
    );
}

/// 超时窗口内 abort 可取消：before 链执行期间 abort 触发 →
/// 调用取消（Cancelled），工具不执行
#[tokio::test]
async fn middleware_before_abort_cancels_call() {
    let tool = Arc::new(CountingEchoTool {
        calls: Arc::new(AtomicUsize::new(0)),
    });
    let reg = registry_with(vec![Arc::clone(&tool) as Arc<dyn Tool>]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(SlowBeforeMiddleware {
        name: "slow".into(),
        sleep_ms: 300,
    })]);
    let sig = AbortSignal::new();
    let abort = sig.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        abort.abort();
    });
    let calls = vec![call("c1", "countecho", ToolConcurrency::Sequential)];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            Some(&sig),
        )
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(
        tool.calls.load(Ordering::SeqCst),
        0,
        "abort 取消后工具不应执行"
    );
}

// ── tool.error 广播（E1 第二批承接；tool-end isError 分支）────────

/// 插件钩子测试替身（tool.error 版）：记录 (tool_name, error 文案)
struct ToolErrorSpyHook {
    name: String,
    errors: Arc<Mutex<Vec<(String, String)>>>,
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

// ── T-D-14 权限传递层：子代理审批链路 ──

/// 子代理上下文（有父 run 归属）+ 危险工具入参（含申请理由保留键）
fn subagent_ctx() -> ToolExecCtx {
    ToolExecCtx {
        run_id: "run-sub-1".into(),
        session_id: "sess-1".into(),
        parent_run_id: Some("run-main".into()),
        ..Default::default()
    }
}

/// 申请→主 agent 放行链路：子代理 run 内工具触发 NeedsApproval →
/// gate 收到 requester（run_id = 子代理 run id + reason）→ 主 agent
/// 裁决 Approved → 工具执行成功、approval-requested 事件携带请求方
#[tokio::test]
async fn subagent_approval_flow_reaches_gate_with_requester_and_executes() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let received = Arc::new(std::sync::Mutex::new(None));
    let gate = Arc::new(RequesterRecordingApproval {
        decision: ApprovalDecision::Approved,
        received: Arc::clone(&received),
    });
    let calls = vec![ToolBatchCall {
        id: "c1".into(),
        tool_name: "dangerous_tool".into(),
        summary: "子代理越界写".into(),
        input: serde_json::json!({
            "path": "outside.md",
            "approval_reason": "需要写入默认范围外的报告目录",
        }),
        category: conex_types::tool::ToolCategory::Filesystem,
        concurrency: ToolConcurrency::Sequential,
    }];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &subagent_ctx(), Some(gate), &opts, None)
        .await;
    // 工具执行成功（主 agent 放行）
    assert!(out.results[0].is_ok(), "结果: {:?}", out.results[0]);
    assert!(out.fatal.is_none());
    // gate 收到 requester：run_id = 子代理 run id + reason
    let requester = received
        .lock()
        .unwrap()
        .clone()
        .expect("gate 必收到 requester");
    assert_eq!(
        requester.run_id, "run-sub-1",
        "requester.run_id 应为子代理 run id"
    );
    assert_eq!(
        requester.reason.as_deref(),
        Some("需要写入默认范围外的报告目录"),
        "requester.reason 应透传申请理由"
    );
    // approval-requested 事件齐全且携带请求方
    let requested = out
        .events
        .iter()
        .find(|e| matches!(e, ToolEvent::ApprovalRequested { .. }))
        .expect("应有 approval-requested 事件");
    match requested {
        ToolEvent::ApprovalRequested { requester, .. } => {
            assert_eq!(
                requester.as_ref().map(|r| r.run_id.as_str()),
                Some("run-sub-1")
            );
            assert_eq!(
                requester.as_ref().and_then(|r| r.reason.as_deref()),
                Some("需要写入默认范围外的报告目录")
            );
        }
        _ => unreachable!(),
    }
}

/// 拒绝路径：主 agent 裁决 Denied → 子代理收到 UserDenied，错误文案
/// 含「主 agent 拒绝」与「回报主 agent」指引（对齐 explore_quota 断言面）
#[tokio::test]
async fn subagent_denied_carries_relay_guidance() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let gate = Arc::new(RequesterRecordingApproval {
        decision: ApprovalDecision::Denied {
            reason: "写入范围超出默认集".into(),
        },
        received: Arc::new(std::sync::Mutex::new(None)),
    });
    let calls = vec![ToolBatchCall {
        id: "c1".into(),
        tool_name: "dangerous_tool".into(),
        summary: "子代理越界写".into(),
        input: serde_json::json!({ "path": "outside.md", "approval_reason": "需要越界写入" }),
        category: conex_types::tool::ToolCategory::Filesystem,
        concurrency: ToolConcurrency::Sequential,
    }];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &subagent_ctx(), Some(gate), &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
    let message = out.results[0].error_message.as_deref().unwrap_or("");
    assert!(message.contains("主 agent 拒绝"), "message: {message}");
    assert!(message.contains("回报主 agent"), "message: {message}");
    assert!(message.contains("写入范围超出默认集"), "message: {message}");
    // 拒绝非致命（run 不中断）
    assert!(out.fatal.is_none());
}

/// 不回归：主 agent run（无父 run）审批 requester=None → 既有
/// 「user denied: …」文案（UI 流程零回归）
#[tokio::test]
async fn main_agent_approval_requester_none_and_legacy_denied_text() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let received = Arc::new(std::sync::Mutex::new(None));
    let gate = Arc::new(RequesterRecordingApproval {
        decision: ApprovalDecision::Denied {
            reason: "no".into(),
        },
        received: Arc::clone(&received),
    });
    let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
        .await;
    // gate 收到 requester = None（主 agent run 不携带子代理身份）
    assert!(
        received.lock().unwrap().is_none(),
        "主 agent run 审批 requester 应为 None"
    );
    // 既有拒绝文案不变（无「回报主 agent」注入）
    let message = out.results[0].error_message.as_deref().unwrap_or("");
    assert_eq!(message, "user denied: no");
    assert!(!message.contains("回报主 agent"), "message: {message}");
}

/// 超时：主 agent 不裁决 → Expired → 子代理 run 不中断（非致命）、
/// 工具返回 approval_expired
#[tokio::test]
async fn subagent_approval_expired_does_not_interrupt_run() {
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg);
    let gate = Arc::new(RequesterRecordingApproval {
        decision: ApprovalDecision::Expired,
        received: Arc::new(std::sync::Mutex::new(None)),
    });
    let calls = vec![ToolBatchCall {
        id: "c1".into(),
        tool_name: "dangerous_tool".into(),
        summary: "子代理越界写".into(),
        input: serde_json::json!({ "path": "outside.md", "approval_reason": "需要越界写入" }),
        category: conex_types::tool::ToolCategory::Filesystem,
        concurrency: ToolConcurrency::Sequential,
    }];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &subagent_ctx(), Some(gate), &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalExpired),
        "超时 → 工具返回 approval_expired"
    );
    assert!(
        out.fatal.is_none(),
        "approval_expired 非致命：子代理 run 不中断"
    );
}
