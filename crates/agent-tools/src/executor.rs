//! 最小工具执行器（任务书 B5.3：单工具执行 + 输出策略 + 幂等检查）
//!
//! agent-tools 此前无执行器模块，本任务建立最小执行器供 B3.5 消费：
//! - 单工具执行（Tool trait 直接调用，未做并发/批次调度，留给 B3.5）
//! - 输出预算策略（summarize 截断 + 标记字段）
//! - 幂等检查（ToolIdempotencyGuard：同域同参去重，输出带 deduplicated 标记）
//!
//! 语义来源：05 §2.3 输出预算、05 §5.5 工具幂等（stream-recovery.test.ts:188-229）。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolError};
use crate::idempotency::{IdempotencyContext, IdempotencyDecision, ToolIdempotencyGuard};
use crate::output::{stringify_tool_output, summarize};
use crate::streaming::{ToolProgress, ToolStreamItem};
use conex_types::error::codes;
use futures_util::StreamExt;
use serde_json::Value;
use std::sync::Arc;
use std::time::Instant;

/// 执行上下文（对齐 middleware::ToolExecutionContext 最小子集）
#[derive(Debug, Clone, Default)]
pub struct ExecutorContext {
    /// 运行标识（幂等域一半）
    pub run_id: String,
    /// 会话标识（幂等域一半）
    pub session_id: String,
    /// 本次工具调用标识（事件/审批联动用）
    pub tool_call_id: Option<String>,
    /// 工作目录
    pub cwd: Option<String>,
}

/// 执行策略：输出预算 + 幂等开关
#[derive(Debug, Clone, Copy)]
pub struct ToolExecutionPolicy {
    /// 输出预算（字节）；None 表示不截断
    pub output_budget_bytes: Option<usize>,
    /// 是否启用幂等检查（需传入 guard 才会生效）
    pub idempotency: bool,
}

impl Default for ToolExecutionPolicy {
    fn default() -> Self {
        Self {
            output_budget_bytes: None,
            idempotency: true,
        }
    }
}

/// 单工具执行结果
#[derive(Debug, Clone)]
pub struct ToolResult {
    /// 结构化输出（预算截断时被改写为 text+json.contextBudget+artifacts 形状）
    pub output: Value,
    /// 序列化文本（stringify_tool_output 结果，供上层直接投喂模型）
    pub text: String,
    /// 是否被预算截断
    pub truncated: bool,
    /// 是否因幂等去重而未真正执行
    pub deduplicated: bool,
    /// 执行耗时（毫秒；去重未执行时为 0）
    pub duration_ms: u64,
}

/// 单工具执行 + 输出策略 + 幂等检查（B3.5 消费入口）
///
/// 流程：
/// 1. 幂等检查（policy.idempotency 且传入 guard）：已执行 → 直接返回
///    deduplicated 结果（不执行工具）
/// 2. 执行工具（R3 T9：携带会话级 ToolContext，失败返回 ToolError，
///    且不记录幂等键，允许重试）
/// 3. 输出预算：超出 budget_bytes 时截断并附加 contextBudget 标记字段
/// 4. 记录幂等键（成功执行后；store 先写、失败不写内存——record 失败
///    返回错误，同进程重试走执行路径重新执行，11-T6 语义）
pub async fn execute_with_output_policy(
    tool: &dyn Tool,
    args: Value,
    tool_ctx: &ToolContext,
    ctx: &ExecutorContext,
    guard: Option<&ToolIdempotencyGuard>,
    policy: &ToolExecutionPolicy,
) -> Result<ToolResult, ToolError> {
    let started = Instant::now();

    if policy.idempotency {
        if let Some(guard) = guard {
            let idem_ctx = build_idempotency_context(ctx, tool.name(), &args);
            if let IdempotencyDecision::Deduplicated { key } =
                guard.check(&idem_ctx, &args).await?
            {
                let output = serde_json::json!({
                    "text": format!("Tool call already executed; skipped re-execution (key: {key})"),
                    "json": { "deduplicated": true, "key": key },
                });
                return Ok(ToolResult {
                    text: stringify_tool_output(&output),
                    output,
                    truncated: false,
                    deduplicated: true,
                    duration_ms: 0,
                });
            }
        }
    }

    let output = tool.execute(tool_ctx, args.clone()).await?;

    let (output, truncated) = match policy.output_budget_bytes {
        Some(budget) => {
            let summarized = summarize(&output, budget);
            if summarized.truncated {
                (summarized.value, true)
            } else {
                (output, false)
            }
        }
        None => (output, false),
    };

    if policy.idempotency {
        if let Some(guard) = guard {
            let idem_ctx = build_idempotency_context(ctx, tool.name(), &args);
            // 记录失败（如 store 持久化失败）直接传播错误：工具已执行，
            // 但幂等键未写内存——重试不命中去重、重新执行（11-T6 语义）
            guard.record(&idem_ctx, &args).await?;
        }
    }

    Ok(ToolResult {
        text: stringify_tool_output(&output),
        output,
        truncated,
        deduplicated: false,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// S1：流式执行 + 输出策略 + 幂等 + 进度回调（TOOLS-01 §3.1.4）
///
/// 与旧路径 [execute_with_output_policy] 的差异点（旧函数保持不动供直连
/// 调用方使用）：
/// 1. 幂等 check：命中 → 返回 deduplicated 终值且**零 Progress**（D3：
///    Progress 不参与幂等键，幂等只按 Terminal 终值记录）；
/// 2. 消费 execute_stream：Progress → 经 progress 回调转发（None = 丢弃），
///    并做 abort 检查——中止即停止消费（流被 drop，已发 Progress 保留），
///    返回 runtime.aborted 错误且不记录幂等键；
///    Terminal → 取终值（Err 原样传播），走既有 summarize 截断；
/// 3. 幂等 record：与旧路径一致（失败/中断不记录）。
pub async fn execute_stream_with_output_policy(
    tool: &dyn Tool,
    args: Value,
    tool_ctx: &ToolContext,
    ctx: &ExecutorContext,
    guard: Option<&ToolIdempotencyGuard>,
    policy: &ToolExecutionPolicy,
    progress: Option<Arc<dyn Fn(ToolProgress) + Send + Sync>>,
) -> Result<ToolResult, ToolError> {
    let started = Instant::now();

    if policy.idempotency {
        if let Some(guard) = guard {
            let idem_ctx = build_idempotency_context(ctx, tool.name(), &args);
            if let IdempotencyDecision::Deduplicated { key } =
                guard.check(&idem_ctx, &args).await?
            {
                let output = serde_json::json!({
                    "text": format!("Tool call already executed; skipped re-execution (key: {key})"),
                    "json": { "deduplicated": true, "key": key },
                });
                return Ok(ToolResult {
                    text: stringify_tool_output(&output),
                    output,
                    truncated: false,
                    deduplicated: true,
                    duration_ms: 0,
                });
            }
        }
    }

    let mut stream = tool.execute_stream(tool_ctx, args.clone()).await;
    let mut terminal: Option<Result<Value, ToolError>> = None;
    while let Some(item) = stream.next().await {
        // abort 检查：中止后停止消费（drop 流即取消），已发 Progress 保留
        if tool_ctx.abort_token.is_aborted() {
            break;
        }
        match item {
            ToolStreamItem::Progress(p) => {
                if let Some(cb) = &progress {
                    cb(p);
                }
            }
            ToolStreamItem::Terminal(result) => {
                terminal = Some(result);
                // Terminal 恒为末项，短路收口
                break;
            }
        }
    }

    let output = match terminal {
        Some(Ok(output)) => output,
        Some(Err(e)) => return Err(e),
        None => {
            // 流在 Terminal 前收口：中止（runtime.aborted）或流实现违反不变式
            return Err(if tool_ctx.abort_token.is_aborted() {
                ToolError::new(
                    codes::RUNTIME_ABORTED,
                    format!("工具 {} 执行被中止", tool.name()),
                )
            } else {
                ToolError::execution_failed(tool.name(), "流在 Terminal 前收口（违反流不变式）")
            });
        }
    };

    let (output, truncated) = match policy.output_budget_bytes {
        Some(budget) => {
            let summarized = summarize(&output, budget);
            if summarized.truncated {
                (summarized.value, true)
            } else {
                (output, false)
            }
        }
        None => (output, false),
    };

    if policy.idempotency {
        if let Some(guard) = guard {
            let idem_ctx = build_idempotency_context(ctx, tool.name(), &args);
            // 记录失败（如 store 持久化失败）直接传播错误：同旧路径 11-T6 语义
            guard.record(&idem_ctx, &args).await?;
        }
    }

    Ok(ToolResult {
        text: stringify_tool_output(&output),
        output,
        truncated,
        deduplicated: false,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// 从执行上下文与入参构造幂等上下文
///
/// snapshotTag 取入参携带值（如 edit 类工具的 snapshotTag 字段），
/// 作为文件状态类工具的更精确键；ctx 无需显式提供。
/// 键素材另附加「目标存在性」探针（F7 遗留 2 接线）：路径类工具同参对
/// 「已存在/不存在」文件的结果不同（如 write_file overwrite=false →
/// tool.file_exists），参数 hash 键须含目标当前存在状态，否则同一键会掩盖
/// 结果差异。check 与 record 各自实时探测：record 记录的是执行后的状态，
/// 重试时状态一致则去重、状态翻转（如外部删除后重试）则重新执行。
fn build_idempotency_context(ctx: &ExecutorContext, tool_name: &str, args: &Value) -> IdempotencyContext {
    IdempotencyContext {
        run_id: ctx.run_id.clone(),
        session_id: ctx.session_id.clone(),
        tool_name: tool_name.to_string(),
        snapshot_tag: args.get("snapshotTag").and_then(Value::as_str).map(String::from),
        extra_key_material: path_existence_markers(ctx, args),
    }
}

/// 目标存在性键素材：对带 path / target_file 入参的工具，以 cwd 为基准解析
/// 目标路径并探测存在状态；cwd 缺失时返回空（行为与未接线一致，纯增量）。
fn path_existence_markers(ctx: &ExecutorContext, args: &Value) -> Vec<String> {
    let Some(cwd) = &ctx.cwd else {
        return Vec::new();
    };
    let mut markers = Vec::new();
    for key in ["path", "target_file"] {
        if let Some(raw) = args.get(key).and_then(Value::as_str) {
            // join 遇绝对路径自动替换基准（write_file schema 允许绝对路径）
            let target = std::path::Path::new(cwd).join(raw);
            markers.push(format!("{key}:exists={}", target.exists()));
        }
    }
    markers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::definition::{Tool, ToolDefinition};
    use crate::idempotency::IdempotencyStore;
    use async_trait::async_trait;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// 测试用计数工具：记录调用次数，输出 text
    struct CountingTool {
        def: ToolDefinition,
        calls: Arc<AtomicUsize>,
    }

    impl CountingTool {
        fn new() -> Self {
            Self {
                def: ToolDefinition {
                    name: "counter".to_string(),
                    description: "计数工具".to_string(),
                    input_schema: json!({ "type": "object", "properties": {} }),
                    dangerous: false,
                    fatal_on_error: false,
                },
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn call_count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl Tool for CountingTool {
        fn name(&self) -> &str {
            &self.def.name
        }

        fn definition(&self) -> &ToolDefinition {
            &self.def
        }

        async fn execute(
            &self,
            _ctx: &crate::context::ToolContext,
            args: Value,
        ) -> Result<Value, ToolError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(json!({ "text": format!("called {n}: {args}") }))
        }
    }

    /// 测试用失败工具：始终返回执行错误
    struct FailingTool {
        def: ToolDefinition,
        calls: Arc<AtomicUsize>,
    }

    impl FailingTool {
        fn new() -> Self {
            Self {
                def: ToolDefinition {
                    name: "failing".to_string(),
                    description: "失败工具".to_string(),
                    input_schema: json!({ "type": "object", "properties": {} }),
                    dangerous: false,
                    fatal_on_error: false,
                },
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    #[async_trait]
    impl Tool for FailingTool {
        fn name(&self) -> &str {
            &self.def.name
        }

        fn definition(&self) -> &ToolDefinition {
            &self.def
        }

        async fn execute(
            &self,
            _ctx: &crate::context::ToolContext,
            _args: Value,
        ) -> Result<Value, ToolError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(ToolError::execution_failed("failing", "模拟失败"))
        }
    }

    fn ctx() -> ExecutorContext {
        ExecutorContext {
            run_id: "run-1".to_string(),
            session_id: "sess-1".to_string(),
            tool_call_id: Some("call-1".to_string()),
            cwd: None,
        }
    }

    fn tool_ctx() -> crate::context::ToolContext {
        crate::context::create_mock_tool_context()
    }

    #[tokio::test]
    async fn execute_single_tool_basic() {
        let tool = CountingTool::new();
        let result = execute_with_output_policy(
            &tool,
            json!({ "msg": "hi" }),
            &tool_ctx(),
            &ctx(),
            None,
            &ToolExecutionPolicy::default(),
        )
        .await
        .unwrap();
        assert!(!result.deduplicated);
        assert!(!result.truncated);
        assert_eq!(result.text, "called 1: {\"msg\":\"hi\"}");
        assert_eq!(result.output["text"], "called 1: {\"msg\":\"hi\"}");
        assert_eq!(tool.call_count(), 1);
    }

    #[tokio::test]
    async fn idempotent_second_call_is_deduplicated() {
        let tool = CountingTool::new();
        let guard = ToolIdempotencyGuard::new();
        let policy = ToolExecutionPolicy::default();
        let args = json!({ "path": "a.txt" });

        let first = execute_with_output_policy(&tool, args.clone(), &tool_ctx(), &ctx(), Some(&guard), &policy)
            .await
            .unwrap();
        assert!(!first.deduplicated);
        assert_eq!(tool.call_count(), 1);

        let second = execute_with_output_policy(&tool, args, &tool_ctx(), &ctx(), Some(&guard), &policy)
            .await
            .unwrap();
        assert!(second.deduplicated);
        // 未真正执行
        assert_eq!(tool.call_count(), 1);
        // 输出带 deduplicated 标记与键
        assert_eq!(second.output["json"]["deduplicated"], true);
        assert!(second.output["json"]["key"].as_str().unwrap().starts_with("counter:"));
        assert!(second.text.contains("skipped re-execution"));
    }

    #[tokio::test]
    async fn idempotent_different_args_execute_normally() {
        let tool = CountingTool::new();
        let guard = ToolIdempotencyGuard::new();
        let policy = ToolExecutionPolicy::default();

        execute_with_output_policy(&tool, json!({ "path": "a.txt" }), &tool_ctx(), &ctx(), Some(&guard), &policy)
            .await
            .unwrap();
        let second =
            execute_with_output_policy(&tool, json!({ "path": "b.txt" }), &tool_ctx(), &ctx(), Some(&guard), &policy)
                .await
                .unwrap();
        assert!(!second.deduplicated);
        assert_eq!(tool.call_count(), 2);
    }

    #[tokio::test]
    async fn clear_reenables_execution() {
        let tool = CountingTool::new();
        let guard = ToolIdempotencyGuard::new();
        let policy = ToolExecutionPolicy::default();
        let args = json!({ "path": "a.txt" });

        execute_with_output_policy(&tool, args.clone(), &tool_ctx(), &ctx(), Some(&guard), &policy)
            .await
            .unwrap();
        let second = execute_with_output_policy(&tool, args.clone(), &tool_ctx(), &ctx(), Some(&guard), &policy)
            .await
            .unwrap();
        assert!(second.deduplicated);

        guard.clear("run-1:sess-1");
        let third = execute_with_output_policy(&tool, args, &tool_ctx(), &ctx(), Some(&guard), &policy)
            .await
            .unwrap();
        assert!(!third.deduplicated);
        assert_eq!(tool.call_count(), 2);
    }

    #[tokio::test]
    async fn budget_truncation_applies_and_preserves_artifacts() {
        let big = Arc::new(BigOutputTool::new());
        let result = execute_with_output_policy(
            big.as_ref(),
            json!({}),
            &tool_ctx(),
            &ctx(),
            None,
            &ToolExecutionPolicy {
                output_budget_bytes: Some(50),
                idempotency: false,
            },
        )
        .await
        .unwrap();
        assert!(result.truncated);
        assert!(!result.deduplicated);
        assert!(result.output["text"].as_str().unwrap().contains("characters omitted"));
        // 标记字段生效
        assert_eq!(result.output["json"]["contextBudget"]["truncated"], true);
        // artifacts 原样保留
        assert_eq!(result.output["artifacts"], json!([{ "kind": "file", "title": "big" }]));
    }

    #[tokio::test]
    async fn no_budget_means_no_truncation() {
        let big = Arc::new(BigOutputTool::new());
        let result = execute_with_output_policy(
            big.as_ref(),
            json!({}),
            &tool_ctx(),
            &ctx(),
            None,
            &ToolExecutionPolicy {
                output_budget_bytes: None,
                idempotency: false,
            },
        )
        .await
        .unwrap();
        assert!(!result.truncated);
        assert_eq!(result.text.len(), 200);
    }

    #[tokio::test]
    async fn deduplicated_result_not_affected_by_budget() {
        let tool = CountingTool::new();
        let guard = ToolIdempotencyGuard::new();
        let policy = ToolExecutionPolicy {
            output_budget_bytes: Some(10),
            idempotency: true,
        };
        let args = json!({ "path": "a.txt" });

        let first = execute_with_output_policy(&tool, args.clone(), &tool_ctx(), &ctx(), Some(&guard), &policy)
            .await
            .unwrap();
        assert!(first.truncated);
        let second = execute_with_output_policy(&tool, args, &tool_ctx(), &ctx(), Some(&guard), &policy)
            .await
            .unwrap();
        assert!(second.deduplicated);
        assert!(!second.truncated);
        assert_eq!(tool.call_count(), 1);
    }

    #[tokio::test]
    async fn failed_execution_returns_error_and_is_not_recorded() {
        let tool = FailingTool::new();
        let guard = ToolIdempotencyGuard::new();
        let policy = ToolExecutionPolicy::default();
        let args = json!({ "path": "a.txt" });

        let err = execute_with_output_policy(&tool, args.clone(), &tool_ctx(), &ctx(), Some(&guard), &policy)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("模拟失败"));

        // 失败不记录：再次执行仍走执行路径（重新抛错，而非返回 deduplicated）
        let err2 = execute_with_output_policy(&tool, args, &tool_ctx(), &ctx(), Some(&guard), &policy)
            .await
            .unwrap_err();
        assert!(err2.to_string().contains("模拟失败"));
    }

    #[tokio::test]
    async fn idempotency_disabled_ignores_guard() {
        let tool = CountingTool::new();
        let guard = ToolIdempotencyGuard::new();
        let policy = ToolExecutionPolicy {
            output_budget_bytes: None,
            idempotency: false,
        };
        let args = json!({ "path": "a.txt" });

        execute_with_output_policy(&tool, args.clone(), &tool_ctx(), &ctx(), Some(&guard), &policy)
            .await
            .unwrap();
        let second = execute_with_output_policy(&tool, args, &tool_ctx(), &ctx(), Some(&guard), &policy)
            .await
            .unwrap();
        assert!(!second.deduplicated);
        assert_eq!(tool.call_count(), 2);
    }

    /// F7 遗留 2：目标存在性探针——同 path 入参，文件「不存在 → 创建 → 重试」
    /// 键素材翻转（exists=false → exists=true），不共享键、重试重新执行；
    /// 文件状态未翻转的重试仍按原键去重。
    #[tokio::test]
    async fn path_existence_marker_splits_keys_on_state_flip() {
        let tool = CountingTool::new();
        let root = std::env::temp_dir().join(format!(
            "agent_tools_idem_probe_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("a.txt");

        let guard = ToolIdempotencyGuard::new();
        let policy = ToolExecutionPolicy::default();
        let exec_ctx = ExecutorContext {
            cwd: Some(root.to_string_lossy().into_owned()),
            ..ctx()
        };
        let args = json!({ "path": "a.txt" });

        // 首次：文件不存在 → 执行（键素材 exists=false）
        let first = execute_with_output_policy(&tool, args.clone(), &tool_ctx(), &exec_ctx, Some(&guard), &policy)
            .await
            .unwrap();
        assert!(!first.deduplicated);
        assert_eq!(tool.call_count(), 1);

        // 外部创建目标（模拟文件状态翻转）→ 重试键素材 exists=true，
        // 与已记录键（exists=false）不同 → 重新执行而非去重
        std::fs::write(&target, "x").unwrap();
        let second = execute_with_output_policy(&tool, args.clone(), &tool_ctx(), &exec_ctx, Some(&guard), &policy)
            .await
            .unwrap();
        assert!(!second.deduplicated, "状态翻转后不得去重");
        assert_eq!(tool.call_count(), 2);

        // 状态不再翻转 → 第三次命中已记录键（exists=true）去重
        let third = execute_with_output_policy(&tool, args, &tool_ctx(), &exec_ctx, Some(&guard), &policy)
            .await
            .unwrap();
        assert!(third.deduplicated, "状态一致应去重");
        assert_eq!(tool.call_count(), 2);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// F7 遗留 2 对照：cwd 缺失时不附加探针，键与既有实现一致
    /// （无 cwd 的执行上下文行为不受影响）
    #[tokio::test]
    async fn path_existence_marker_absent_without_cwd() {
        let tool = CountingTool::new();
        let guard = ToolIdempotencyGuard::new();
        let policy = ToolExecutionPolicy::default();
        let args = json!({ "path": "a.txt" });

        execute_with_output_policy(&tool, args.clone(), &tool_ctx(), &ctx(), Some(&guard), &policy)
            .await
            .unwrap();
        let second = execute_with_output_policy(&tool, args, &tool_ctx(), &ctx(), Some(&guard), &policy)
            .await
            .unwrap();
        assert!(second.deduplicated);
        assert_eq!(tool.call_count(), 1);
    }

    /// 测试用大输出工具：返回 200 字符文本 + artifacts
    struct BigOutputTool {
        def: ToolDefinition,
    }

    impl BigOutputTool {
        fn new() -> Self {
            Self {
                def: ToolDefinition {
                    name: "big".to_string(),
                    description: "大输出工具".to_string(),
                    input_schema: json!({ "type": "object", "properties": {} }),
                    dangerous: false,
                    fatal_on_error: false,
                },
            }
        }
    }

    #[async_trait]
    impl Tool for BigOutputTool {
        fn name(&self) -> &str {
            &self.def.name
        }

        fn definition(&self) -> &ToolDefinition {
            &self.def
        }

        async fn execute(
            &self,
            _ctx: &crate::context::ToolContext,
            _args: Value,
        ) -> Result<Value, ToolError> {
            Ok(json!({
                "text": "a".repeat(200),
                "artifacts": [{ "kind": "file", "title": "big" }]
            }))
        }
    }

    /// 测试用内存持久化实现（模拟跨进程 store 共享，验证“结果落盘”）
    struct FakeStore {
        keys: Mutex<HashMap<String, Vec<String>>>,
    }

    #[async_trait]
    impl IdempotencyStore for FakeStore {
        // PE-07 T07.6：下列 2 处 expect 属测试专属 store（cfg(test)），非运行时路径，
        // 按任务书「测试 expect 保留但标注」处置，保持不动。
        async fn load_keys(&self, domain: &str) -> Result<Vec<String>, ToolError> {
            Ok(self
                .keys
                .lock()
                .expect("测试 store 锁中毒后不可恢复")
                .get(domain)
                .cloned()
                .unwrap_or_default())
        }

        async fn append_key(&self, domain: &str, key: &str) -> Result<(), ToolError> {
            self.keys
                .lock()
                .expect("测试 store 锁中毒后不可恢复")
                .entry(domain.to_string())
                .or_default()
                .push(key.to_string());
            Ok(())
        }
    }

    #[tokio::test]
    async fn execution_result_persisted_via_store() {
        let store = Arc::new(FakeStore {
            keys: Mutex::new(HashMap::new()),
        });
        let guard = ToolIdempotencyGuard::with_store(store.clone());
        let tool = CountingTool::new();
        let args = json!({ "path": "a.txt" });

        let result =
            execute_with_output_policy(&tool, args.clone(), &tool_ctx(), &ctx(), Some(&guard), &ToolExecutionPolicy::default())
                .await
                .unwrap();
        assert!(!result.deduplicated);

        // 结果落盘：store 中已有该域键
        let keys = store.load_keys("run-1:sess-1").await.unwrap();
        assert_eq!(keys.len(), 1);
        assert!(keys[0].starts_with("counter:"));

        // 新守卫（模拟重启）共享同一 store：同参执行被去重
        let guard2 = ToolIdempotencyGuard::with_store(store.clone());
        let second =
            execute_with_output_policy(&tool, args, &tool_ctx(), &ctx(), Some(&guard2), &ToolExecutionPolicy::default())
                .await
                .unwrap();
        assert!(second.deduplicated);
        assert_eq!(tool.call_count(), 1);
    }

    /// 测试用故障注入 store：前 N 次 append_key 返回错误（模拟幂等记录
    /// 持久化失败），之后恢复为正常追加；统计 append 调用次数供断言。
    struct FlakyAppendStore {
        keys: Mutex<HashMap<String, Vec<String>>>,
        failures_left: Mutex<usize>,
        append_calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl IdempotencyStore for FlakyAppendStore {
        // 测试专属 store（cfg(test)）同 FakeStore 处置：expect 保留但标注
        async fn load_keys(&self, domain: &str) -> Result<Vec<String>, ToolError> {
            Ok(self
                .keys
                .lock()
                .expect("测试 store 锁中毒后不可恢复")
                .get(domain)
                .cloned()
                .unwrap_or_default())
        }

        async fn append_key(&self, domain: &str, key: &str) -> Result<(), ToolError> {
            self.append_calls.fetch_add(1, Ordering::SeqCst);
            let mut left = self
                .failures_left
                .lock()
                .expect("测试 store 锁中毒后不可恢复");
            if *left > 0 {
                *left -= 1;
                return Err(ToolError::new(
                    "test.append_injected_failure",
                    "模拟幂等记录持久化失败",
                ));
            }
            self.keys
                .lock()
                .expect("测试 store 锁中毒后不可恢复")
                .entry(domain.to_string())
                .or_default()
                .push(key.to_string());
            Ok(())
        }
    }

    /// 11-T6 判据①扩展：首次执行成功后幂等记录落盘失败 → 整体返回错误
    /// （错误文案含「已执行但持久化失败」）；同进程重试内存无键 → 走执行
    /// 路径重新执行（结果标记 deduplicated=false + 二次执行计数），而非
    /// 假去重；记录成功后第三次同参调用去重。
    #[tokio::test]
    async fn execution_result_persisted_via_store_retries_after_append_failure() {
        let store = Arc::new(FlakyAppendStore {
            keys: Mutex::new(HashMap::new()),
            failures_left: Mutex::new(1),
            append_calls: Arc::new(AtomicUsize::new(0)),
        });
        let guard = ToolIdempotencyGuard::with_store(store.clone());
        let tool = CountingTool::new();
        let args = json!({ "path": "a.txt" });

        // 首次：工具执行成功，但幂等记录落盘失败 → 返回错误而非假成功
        let err = execute_with_output_policy(
            &tool,
            args.clone(),
            &tool_ctx(),
            &ctx(),
            Some(&guard),
            &ToolExecutionPolicy::default(),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("幂等记录持久化失败"), "错误文案须含持久化失败语义");
        assert_eq!(tool.call_count(), 1);

        // 重试：内存无键（store 未落盘）→ 走执行路径重新执行
        let retry = execute_with_output_policy(
            &tool,
            args.clone(),
            &tool_ctx(),
            &ctx(),
            Some(&guard),
            &ToolExecutionPolicy::default(),
        )
        .await
        .unwrap();
        assert!(!retry.deduplicated, "store 失败后的重试不得被去重");
        assert_eq!(tool.call_count(), 2);

        // 第三次：记录已成功落盘 → 同参去重
        let third = execute_with_output_policy(
            &tool,
            args,
            &tool_ctx(),
            &ctx(),
            Some(&guard),
            &ToolExecutionPolicy::default(),
        )
        .await
        .unwrap();
        assert!(third.deduplicated, "store 记录成功后同参应去重");
        assert_eq!(tool.call_count(), 2);
        // 落盘调用共 2 次：首次失败注入 + 重试成功（新守卫懒加载不追加）
        assert_eq!(store.append_calls.load(Ordering::SeqCst), 2);
    }

    /// 轮询等待断言条件成立（上限 5 秒，避免 abort 时序测试的竞态）
    async fn wait_for(cond: impl Fn() -> bool) {
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(5);
        while !cond() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "等待条件超时（5 秒）"
            );
            tokio::task::yield_now().await;
        }
    }

    /// 测试用流式工具：覆盖 execute_stream，推送 3 条进度后给出终值
    struct StreamingTool {
        def: ToolDefinition,
        calls: Arc<AtomicUsize>,
    }

    impl StreamingTool {
        fn new() -> Self {
            Self {
                def: ToolDefinition {
                    name: "streamer".to_string(),
                    description: "流式输出工具".to_string(),
                    input_schema: json!({ "type": "object", "properties": {} }),
                    dangerous: false,
                    fatal_on_error: false,
                },
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn call_count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl Tool for StreamingTool {
        fn name(&self) -> &str {
            &self.def.name
        }

        fn definition(&self) -> &ToolDefinition {
            &self.def
        }

        async fn execute(
            &self,
            _ctx: &crate::context::ToolContext,
            _args: Value,
        ) -> Result<Value, ToolError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(json!({ "text": "streamed once" }))
        }

        async fn execute_stream(
            &self,
            _ctx: &crate::context::ToolContext,
            _args: Value,
        ) -> crate::streaming::ToolStream {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let count = self.calls.clone();
            let progress = futures_util::stream::iter(vec![
                ToolProgress::Text {
                    text: "第一块".to_string(),
                },
                ToolProgress::Text {
                    text: "第二块".to_string(),
                },
                ToolProgress::Custom {
                    subkind: "phase".to_string(),
                    payload: json!({ "step": 2 }),
                },
            ]);
            let terminal = async move {
                Ok(json!({ "text": format!("streamed {}", count.load(Ordering::SeqCst)) }))
            };
            crate::streaming::with_progress(progress, terminal)
        }
    }

    /// 测试用闸门流式工具：第一块进度即推即到，第二块进度须等测试经
    /// gate 放行——abort 时序测试由此精确控制「流中途」的节奏；终值为
    /// 固定 json。每次 execute_stream 独立走一遍闸门。
    #[derive(Clone)]
    struct GatedStreamTool {
        def: ToolDefinition,
        gate: Arc<tokio::sync::Notify>,
    }

    impl GatedStreamTool {
        fn new() -> Self {
            Self {
                def: ToolDefinition {
                    name: "gated_stream".to_string(),
                    description: "闸门流式工具".to_string(),
                    input_schema: json!({ "type": "object", "properties": {} }),
                    dangerous: false,
                    fatal_on_error: false,
                },
                gate: Arc::new(tokio::sync::Notify::new()),
            }
        }
    }

    #[async_trait]
    impl Tool for GatedStreamTool {
        fn name(&self) -> &str {
            &self.def.name
        }

        fn definition(&self) -> &ToolDefinition {
            &self.def
        }

        async fn execute(
            &self,
            _ctx: &crate::context::ToolContext,
            _args: Value,
        ) -> Result<Value, ToolError> {
            Err(ToolError::execution_failed(
                "gated_stream",
                "流式工具不提供一次性执行",
            ))
        }

        async fn execute_stream(
            &self,
            _ctx: &crate::context::ToolContext,
            _args: Value,
        ) -> crate::streaming::ToolStream {
            let gate = self.gate.clone();
            let progress = futures_util::stream::unfold(0u8, move |step| {
                let gate = gate.clone();
                async move {
                    match step {
                        0 => Some((
                            ToolProgress::Text {
                                text: "第一块".to_string(),
                            },
                            1,
                        )),
                        1 => {
                            // 等待测试放行（abort 时序测试的闸门）
                            gate.notified().await;
                            Some((
                                ToolProgress::Text {
                                    text: "第二块".to_string(),
                                },
                                2,
                            ))
                        }
                        _ => None,
                    }
                }
            });
            let terminal = async { Ok(json!({ "text": "final" })) };
            crate::streaming::with_progress(progress, terminal)
        }
    }

    /// S1 验收：未实现 execute_stream 的工具（EchoTool 测试替身）经
    /// 流式消费路径输出与旧路径逐字节一致（默认实现包 execute）。
    #[tokio::test]
    async fn streaming_default_impl_matches_legacy_output() {
        use crate::test_support::EchoTool;

        let tool = EchoTool::new("echo");
        let policy = ToolExecutionPolicy::default();
        let args = json!({ "msg": "hi" });

        let legacy = execute_with_output_policy(&tool, args.clone(), &tool_ctx(), &ctx(), None, &policy)
            .await
            .unwrap();
        let streamed = execute_stream_with_output_policy(&tool, args, &tool_ctx(), &ctx(), None, &policy, None)
            .await
            .unwrap();

        assert_eq!(streamed.text, legacy.text, "流式路径 text 须与旧路径一致");
        assert_eq!(streamed.output, legacy.output, "流式路径 output 须与旧路径一致");
        assert_eq!(streamed.deduplicated, legacy.deduplicated);
        assert_eq!(streamed.truncated, legacy.truncated);
    }

    /// S1 验收：流式工具经 execute_stream_with_output_policy 消费——
    /// Progress 按序经回调转发，Terminal 终值透传为结果。
    #[tokio::test]
    async fn streaming_forwards_progress_and_terminal() {
        let tool = StreamingTool::new();
        let guard = ToolIdempotencyGuard::new();
        let policy = ToolExecutionPolicy::default();
        let forwarded = Arc::new(Mutex::new(Vec::<ToolProgress>::new()));
        let forwarded_task = forwarded.clone();

        let result = execute_stream_with_output_policy(
            &tool,
            json!({ "msg": "hi" }),
            &tool_ctx(),
            &ctx(),
            Some(&guard),
            &policy,
            Some(Arc::new(move |p| forwarded_task.lock().unwrap().push(p))),
        )
        .await
        .unwrap();

        assert!(!result.deduplicated);
        assert_eq!(tool.call_count(), 1, "execute_stream 一次调用");

        // 3 条 Progress 按序转发
        let fwd = forwarded.lock().unwrap();
        assert_eq!(fwd.len(), 3);
        assert!(matches!(&fwd[0], ToolProgress::Text { text } if text == "第一块"));
        assert!(matches!(&fwd[1], ToolProgress::Text { text } if text == "第二块"));
        assert!(matches!(&fwd[2], ToolProgress::Custom { subkind, .. } if subkind == "phase"));
        drop(fwd);

        // 终值透传（聚合结果）
        assert_eq!(result.output["text"], "streamed 1");
    }

    /// S1 验收（D3）：幂等键按 Terminal 终值记录——同参二次调用命中去重，
    /// 返回 deduplicated 终值且**零 Progress**（Progress 不参与幂等键）。
    #[tokio::test]
    async fn streaming_idempotent_second_call_deduplicates_with_zero_progress() {
        let tool = StreamingTool::new();
        let guard = ToolIdempotencyGuard::new();
        let policy = ToolExecutionPolicy::default();
        let args = json!({ "path": "a.txt" });
        let forwarded = Arc::new(Mutex::new(Vec::<ToolProgress>::new()));

        let first = execute_stream_with_output_policy(
            &tool,
            args.clone(),
            &tool_ctx(),
            &ctx(),
            Some(&guard),
            &policy,
            Some(Arc::new({
                let forwarded = forwarded.clone();
                move |p| forwarded.lock().unwrap().push(p)
            })),
        )
        .await
        .unwrap();
        assert!(!first.deduplicated);
        assert_eq!(tool.call_count(), 1);
        assert_eq!(forwarded.lock().unwrap().len(), 3, "首次执行转发全部进度");

        // 同参二次调用：命中幂等键 → 零 Progress、工具不再执行
        let forwarded2 = Arc::new(Mutex::new(Vec::<ToolProgress>::new()));
        let forwarded2_task = forwarded2.clone();
        let second = execute_stream_with_output_policy(
            &tool,
            args,
            &tool_ctx(),
            &ctx(),
            Some(&guard),
            &policy,
            Some(Arc::new(move |p| forwarded2_task.lock().unwrap().push(p))),
        )
        .await
        .unwrap();
        assert!(second.deduplicated, "同参应去重");
        assert_eq!(tool.call_count(), 1, "去重不得执行工具");
        assert_eq!(forwarded2.lock().unwrap().len(), 0, "去重路径零 Progress");
        assert!(second.text.contains("skipped re-execution"));
    }

    /// S1 验收：Progress 不参与幂等键——不同入参幂等键不同，二次调用
    /// 正常执行并推送进度。
    #[tokio::test]
    async fn streaming_different_args_execute_normally() {
        let tool = StreamingTool::new();
        let guard = ToolIdempotencyGuard::new();
        let policy = ToolExecutionPolicy::default();

        execute_stream_with_output_policy(
            &tool,
            json!({ "path": "a.txt" }),
            &tool_ctx(),
            &ctx(),
            Some(&guard),
            &policy,
            None,
        )
        .await
        .unwrap();
        let second = execute_stream_with_output_policy(
            &tool,
            json!({ "path": "b.txt" }),
            &tool_ctx(),
            &ctx(),
            Some(&guard),
            &policy,
            None,
        )
        .await
        .unwrap();
        assert!(!second.deduplicated, "不同入参幂等键不同，应执行");
        assert_eq!(tool.call_count(), 2);
    }

    /// S1 验收：Terminal(Err) 原样传播（默认实现包 execute 失败路径），
    /// 且失败不记录幂等键（同参重试仍走执行路径重新抛错）。
    #[tokio::test]
    async fn streaming_terminal_error_is_propagated_and_not_recorded() {
        let tool = FailingTool::new();
        let guard = ToolIdempotencyGuard::new();
        let policy = ToolExecutionPolicy::default();
        let args = json!({ "path": "a.txt" });

        let err = execute_stream_with_output_policy(
            &tool,
            args.clone(),
            &tool_ctx(),
            &ctx(),
            Some(&guard),
            &policy,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("模拟失败"));

        // 失败不记录：同参重试仍走执行路径（重新抛错，而非返回 deduplicated）
        let err2 = execute_stream_with_output_policy(
            &tool,
            args,
            &tool_ctx(),
            &ctx(),
            Some(&guard),
            &policy,
            None,
        )
        .await
        .unwrap_err();
        assert!(err2.to_string().contains("模拟失败"));
    }

    /// S1 验收：输出预算应用于 Terminal 终值（截断语义与旧路径一致）
    #[tokio::test]
    async fn streaming_budget_truncation_applies_to_terminal_value() {
        let big = Arc::new(BigOutputTool::new());
        let result = execute_stream_with_output_policy(
            big.as_ref(),
            json!({}),
            &tool_ctx(),
            &ctx(),
            None,
            &ToolExecutionPolicy {
                output_budget_bytes: Some(50),
                idempotency: false,
            },
            None,
        )
        .await
        .unwrap();
        assert!(result.truncated);
        assert!(result.output["text"].as_str().unwrap().contains("characters omitted"));
        assert_eq!(result.output["json"]["contextBudget"]["truncated"], true);
    }

    /// S1 验收（§3.1.8 abort）：流中途 abort → 流被 drop（drop 即取消），
    /// 已发 Progress 保留、中止后不再转发；返回 runtime.aborted 且不记录
    /// 幂等键（重试重新执行，成功后按终值记录，再同参则去重）。
    #[tokio::test]
    async fn streaming_abort_interrupts_stream_and_skips_record() {
        let tool = GatedStreamTool::new();
        let guard = ToolIdempotencyGuard::new();
        let policy = ToolExecutionPolicy::default();
        let args = json!({ "path": "a.txt" });

        let abort_ctx = tool_ctx();
        let forwarded = Arc::new(Mutex::new(Vec::<ToolProgress>::new()));
        let forwarded_task = forwarded.clone();
        // 任务专属副本：async move 按值捕获，测试侧继续持有原实例用于
        // 触发中止与幂等重试
        let task_tool = tool.clone();
        let task_args = args.clone();
        let task_ctx = abort_ctx.clone();

        let handle = tokio::spawn(async move {
            let result = execute_stream_with_output_policy(
                &task_tool,
                task_args,
                &task_ctx,
                &ctx(),
                Some(&guard),
                &policy,
                Some(Arc::new(move |p| forwarded_task.lock().unwrap().push(p))),
            )
            .await;
            (result, guard)
        });

        // 第一块进度无需闸门即被转发
        wait_for(|| forwarded.lock().unwrap().len() == 1).await;

        // 流中途（执行器已取走第一块、正等第二块）触发中止，再放行闸门
        abort_ctx.abort_token.abort();
        tool.gate.notify_one();

        let (result, guard) = handle.await.unwrap();
        let err = result.unwrap_err();
        assert_eq!(err.code(), codes::RUNTIME_ABORTED, "中止应收口为 runtime.aborted");

        // 已发 Progress 保留（第一块），中止后不再转发（第二块被丢弃）
        {
            let fwd = forwarded.lock().unwrap();
            assert_eq!(fwd.len(), 1, "abort 后已发 Progress 保留、后续不转发");
        }

        // 幂等未记录：同参重试（新工具实例同键、新 ToolContext 未中止）
        // 走执行路径而非去重；预放行闸门避免重试挂起
        let tool2 = GatedStreamTool::new();
        tool2.gate.notify_one();
        let retry = execute_stream_with_output_policy(
            &tool2,
            args.clone(),
            &tool_ctx(),
            &ctx(),
            Some(&guard),
            &policy,
            None,
        )
        .await
        .unwrap();
        assert!(!retry.deduplicated, "中止未记录幂等键，重试应重新执行");
        assert_eq!(retry.output["text"], "final");

        // 重试成功后幂等键按终值记录：第三次同参去重（D3 按 Terminal 记录）
        let third = execute_stream_with_output_policy(
            &tool2,
            args,
            &tool_ctx(),
            &ctx(),
            Some(&guard),
            &policy,
            None,
        )
        .await
        .unwrap();
        assert!(third.deduplicated, "终值记录后同参应去重");
    }
}
