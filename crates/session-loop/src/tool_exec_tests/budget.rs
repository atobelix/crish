use super::super::*;
use super::fixture::*;
use agent_tools::context::ToolContext;
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use conex_types::tool::ToolConcurrency;
use serde_json::Value;
use std::sync::Arc;

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

/// 测试工具：超默认预算输出（> TOOL_OUTPUT_BUDGET_BYTES_DEFAULT=64KiB）
/// ——验证默认 Some 预算截断语义（U-OUT-RS N7）
struct HugeOutputTool;
#[async_trait::async_trait]
impl Tool for HugeOutputTool {
    fn name(&self) -> &str {
        "huge"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDefinition {
            name: "huge".into(),
            description: "huge output over default budget".into(),
            input_schema: serde_json::json!({"type": "object"}),
            dangerous: false,
            fatal_on_error: false,
        })
    }
    async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        // 128KiB > 默认 64KiB 预算 → 必触发 contextBudget.truncated
        Ok(serde_json::json!({ "text": "a".repeat(128 * 1024) }))
    }
}

/// T06.4.2 / U-OUT-RS：output_budget_bytes 从 ToolBatchOptions 透传——
/// 超预算输出被截断（summarize 语义）；显式 None 不截断（测试注入合法）；
/// 默认 Some(TOOL_OUTPUT_BUDGET_BYTES_DEFAULT) 时大输出 truncated=true（N7）
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
    // 显式 None：不截断（输出为工具原始返回对象，未被 summarize 改写）
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions {
                output_budget_bytes: None,
                ..Default::default()
            },
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
        "显式 None 无预算不截断"
    );
}

/// U-OUT-RS / N6：ToolBatchOptions::default() 为 Some(TOOL_OUTPUT_BUDGET_BYTES_DEFAULT)——
/// 防测试/旁路装配漏网无预算（旧路径 None）
#[test]
fn tool_batch_options_default_output_budget_is_some() {
    let default = ToolBatchOptions::default();
    assert_eq!(
        default.output_budget_bytes,
        Some(conex_shared::perf_budget::TOOL_OUTPUT_BUDGET_BYTES_DEFAULT),
        "默认 output_budget_bytes 必须为 Some(TOOL_OUTPUT_BUDGET_BYTES_DEFAULT)（U-OUT-RS N6）"
    );
}

/// U-OUT-RS / N7：默认预算下大输出 truncated=true（跨层探针：executor
/// → ClassifiedToolResult.output 含 contextBudget.truncated 标记，贯穿
/// ToolEnd 出口——映射到 ToolOutput 后 json.contextBudget 仍可见）
#[tokio::test]
async fn default_output_budget_truncates_oversize_output() {
    // BigOutputTool 返回 200 字符 text；默认预算 64KiB 不触发——用极小
    // 显式预算验证默认 Some 路径的截断语义等价；再用超默认预算的输出
    // 验证默认 Some 确实生效（截断发生）
    let reg = registry_with(vec![Arc::new(HugeOutputTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "huge", ToolConcurrency::Sequential)];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(), // 默认 Some(64KiB)
            None,
        )
        .await;
    assert!(out.results[0].is_ok());
    let truncated = out.results[0]
        .output
        .get("json")
        .and_then(|j| j.get("contextBudget"))
        .and_then(|c| c.get("truncated"))
        .and_then(|v| v.as_bool());
    assert_eq!(
        truncated,
        Some(true),
        "默认 Some 预算下超限输出必须带 contextBudget.truncated=true（N7 透传）"
    );
}

/// U-OUT-RS / REL-2：执行器出口 Arc——ClassifiedToolResult.output 与
/// ToolEvent::ToolEnd.output 共享同一 Arc（ptr 相等 = 深 clone 次数 0
/// 在出口装配点；映射到 AgentEvent 时才一次深 clone 收口）
#[tokio::test]
async fn tool_end_exit_arc_shares_same_allocation() {
    let reg = registry_with(vec![Arc::new(BigOutputTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "big", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        output_budget_bytes: Some(50),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert!(out.results[0].is_ok());
    // 找到 ToolEnd 事件
    let tool_end = out
        .events
        .iter()
        .find_map(|e| match e {
            ToolEvent::ToolEnd {
                call_id, output, ..
            } if call_id == "c1" => Some(output),
            _ => None,
        })
        .expect("必须存在 tool-end 事件");
    // Arc::ptr_eq：出口层共享同一分配（浅 clone 而非深 clone）
    assert!(
        Arc::ptr_eq(tool_end, &out.results[0].output),
        "ToolEnd.output 与 ClassifiedToolResult.output 必须共享同一 Arc（出口 Arc 探针）"
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
