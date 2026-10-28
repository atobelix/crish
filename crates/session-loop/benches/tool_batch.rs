//! PE-09 T09.7 基准：工具批量执行（P8）
//!
//! 场景：并行组 5 × 50ms 慢工具——无审批 vs 审批（执行模型 A：
//! 审批逐个 await → 通过后执行阶段 join_all 并行）。
//!
//! 指标：批总耗时。对照 G6：审批开启时并行组若退化为串行，批耗时 ≈
//! 5 × 50ms = 250ms；Arc 化并行恢复后应 ≈ max(工具耗时) ≈ 50ms + 审批链。
//! 审批门为「立批」（0 延迟），隔离审批等待成本、聚焦执行并行度。
//!
//! 运行：`cargo bench -p session-loop --bench tool_batch`
//! 快速模式：`cargo bench -p session-loop --bench tool_batch -- --measurement-time 1 --warm-up-time 0.2`

use std::sync::Arc;
use std::time::Duration;

use agent_tools::definition::{Tool, ToolDefinition};
use agent_tools::registry::ToolRegistry;
use conex_types::tool::{ToolBatchCall, ToolCategory, ToolConcurrency};
use criterion::{criterion_group, criterion_main, Criterion};
use session_loop::tool_events::{
    ApprovalDecision, ApprovalGate, ApprovalRequester, ToolBatchOptions,
};
use session_loop::tool_exec::{ToolExecCtx, ToolExecutor};

/// 慢工具（50ms 模拟真实 I/O 工具；输出小）
struct SlowTool {
    delay_ms: u64,
}

#[async_trait::async_trait]
impl Tool for SlowTool {
    fn name(&self) -> &str {
        "slow_tool"
    }

    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "slow_tool".to_string(),
            description: "基准用慢工具（模拟真实 I/O 延迟）".to_string(),
            input_schema: serde_json::json!({ "type": "object" }),
            dangerous: false,
            fatal_on_error: false,
        })
    }

    async fn execute(
        &self,
        _ctx: &agent_tools::context::ToolContext,
        _args: serde_json::Value,
    ) -> Result<serde_json::Value, agent_tools::definition::ToolError> {
        tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
        Ok(serde_json::json!({ "ok": true }))
    }
}

/// 立批审批门（0 延迟批准：隔离审批等待，聚焦执行并行度）
struct InstantApprovalGate;

#[async_trait::async_trait]
impl ApprovalGate for InstantApprovalGate {
    async fn request_approval(
        &self,
        _call_id: &str,
        _tool_name: &str,
        _args: &serde_json::Value,
        _requester: Option<&ApprovalRequester>,
        _reason: Option<&str>,
    ) -> ApprovalDecision {
        ApprovalDecision::Approved
    }
}

/// 建工具注册表（注册慢工具）
fn registry() -> Arc<ToolRegistry> {
    let mut registry = ToolRegistry::new();
    registry
        .register(Arc::new(SlowTool { delay_ms: 50 }))
        .expect("注册慢工具");
    Arc::new(registry)
}

/// 构造并行组调用（5 × 同工具）
fn calls() -> Vec<ToolBatchCall> {
    (0..5)
        .map(|i| ToolBatchCall {
            id: format!("call-{i}"),
            tool_name: "slow_tool".to_string(),
            summary: format!("慢工具调用 {i}"),
            input: serde_json::json!({}),
            category: ToolCategory::Skill,
            concurrency: ToolConcurrency::Parallel,
        })
        .collect()
}

/// 建 runtime（criterion 无异步 bencher，block_on 包装）
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Runtime::new().expect("建 tokio runtime")
}

fn bench_tool_batch(c: &mut Criterion) {
    let rt = runtime();
    let mut group = c.benchmark_group("tool_batch/5x50ms");
    group.sample_size(30);
    group.measurement_time(Duration::from_secs(5));

    // 无审批并行（基线：应 ≈ 50ms，测试断言 <95ms 的对应面）
    group.bench_function("no_approval_parallel", |b| {
        b.iter_batched(
            || (registry(), calls()),
            |(registry, calls)| {
                let executor = ToolExecutor::new(registry);
                let ctx = ToolExecCtx {
                    run_id: "r1".into(),
                    session_id: "s1".into(),
                    cwd: None,
                    parent_run_id: None,
                    workspace_root: None,
                    write_claims: None,
                    explore_docs_quota: None,
                    output_dir: None,
                    note_backend: None,
                    background: None,
                    log_root: None,
                    ..Default::default()
                };
                let options = ToolBatchOptions {
                    timeout: Duration::from_secs(10),
                    ..ToolBatchOptions::default()
                };
                let outcome =
                    rt.block_on(executor.execute_batch(&calls, &ctx, None, &options, None));
                criterion::black_box(&outcome);
            },
            criterion::BatchSize::SmallInput,
        );
    });

    // 审批模式（执行模型 A：立批 + 并行执行阶段；应仍 ≈ 50ms）
    group.bench_function("approval_model_a", |b| {
        b.iter_batched(
            || (registry(), calls()),
            |(registry, calls)| {
                let executor = ToolExecutor::new(registry);
                let ctx = ToolExecCtx {
                    run_id: "r1".into(),
                    session_id: "s1".into(),
                    cwd: None,
                    parent_run_id: None,
                    workspace_root: None,
                    write_claims: None,
                    explore_docs_quota: None,
                    output_dir: None,
                    note_backend: None,
                    background: None,
                    log_root: None,
                    ..Default::default()
                };
                let options = ToolBatchOptions {
                    timeout: Duration::from_secs(10),
                    permission_mode: Some(conex_types::PermissionMode::Full),
                    ..ToolBatchOptions::default()
                };
                let gate = Arc::new(InstantApprovalGate);
                let outcome =
                    rt.block_on(executor.execute_batch(&calls, &ctx, Some(gate), &options, None));
                criterion::black_box(&outcome);
            },
            criterion::BatchSize::SmallInput,
        );
    });

    group.finish();
}

criterion_group!(benches, bench_tool_batch);
criterion_main!(benches);
