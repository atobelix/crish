//! 类型面（SR-06a-4 拆分 · executor.rs `#[path]` 接线）：执行上下文 /
//! 执行策略 / 执行结果三个数据形状，门面 re-export 维持公开符号。

use serde_json::Value;

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
