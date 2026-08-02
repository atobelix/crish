//! 工具中间件（对齐 TS 端 tools/tool-middleware.ts 精简 Hook 体系）
//!
//! TS 红线禁令 7 后仅保留三个钩子：beforeExecute / onResult / onError。
//! 本模块先定接口（ToolMiddleware trait，三个钩子均有默认空实现）；
//! 后置钩子示例实现 [RecordingMiddleware] 仅测试使用（T06.3 Q18：
//! 生产零引用，整体标注 #[cfg(test)]）。

use crate::definition::{Tool, ToolError};
use async_trait::async_trait;
use serde_json::Value;
// Arc/Mutex 仅 RecordingMiddleware（#[cfg(test)]）使用（T06.3 Q18）
#[cfg(test)]
use std::sync::{Arc, Mutex};

/// 工具执行上下文（对齐 TS ToolExecutionContext 最小子集）
#[derive(Debug, Clone, Default)]
pub struct ToolExecutionContext {
    /// 会话标识
    pub session_id: Option<String>,
    /// 运行标识
    pub run_id: Option<String>,
    /// 本次工具调用标识（审批/事件联动用）
    pub tool_call_id: Option<String>,
    /// 工作目录
    pub cwd: Option<String>,
}

/// 前置钩子返回结果（对齐 TS MiddlewareBeforeResult）
pub enum BeforeExecuteResult {
    /// 放行执行；携带修改后的入参（None 表示原样透传）
    Proceed { modified_input: Option<Value> },
    /// 阻止执行并附原因
    Block { reason: String },
}

/// 后置结果钩子返回结果（对齐 TS MiddlewareAfterResult）
pub enum AfterExecuteResult {
    /// 透传工具原始输出
    Passthrough,
    /// 替换为中间件提供的输出
    Replace(Value),
}

/// 工具中间件接口
///
/// 三个钩子按需覆盖（默认空实现）：
/// - before_execute：执行前拦截/改写入参（审批类中间件落点，B5.4/B3.5 联动）
/// - on_result：执行成功后观察/改写输出
/// - on_error：执行失败后观察（仅记录，不吞错）
#[async_trait]
pub trait ToolMiddleware: Send + Sync {
    /// 中间件名称（日志与调试用）
    fn name(&self) -> &str;

    /// 执行前钩子
    async fn before_execute(
        &self,
        tool: &dyn Tool,
        input: Value,
        ctx: &ToolExecutionContext,
    ) -> Result<BeforeExecuteResult, ToolError> {
        let _ = (tool, input, ctx);
        Ok(BeforeExecuteResult::Proceed {
            modified_input: None,
        })
    }

    /// 执行成功后置钩子（可改写输出）
    async fn on_result(
        &self,
        tool: &dyn Tool,
        input: &Value,
        output: Value,
        ctx: &ToolExecutionContext,
    ) -> Result<AfterExecuteResult, ToolError> {
        let _ = (tool, input, output, ctx);
        Ok(AfterExecuteResult::Passthrough)
    }

    /// 执行失败后置钩子（仅观察）
    async fn on_error(
        &self,
        tool: &dyn Tool,
        input: &Value,
        error: &ToolError,
        ctx: &ToolExecutionContext,
    ) -> Result<(), ToolError> {
        let _ = (tool, input, error, ctx);
        Ok(())
    }
}

/// 一条执行记录（RecordingMiddleware 收集）
///
/// T06.3 Q18：仅测试使用（生产零引用），整体标注 #[cfg(test)]
#[cfg(test)]
#[derive(Debug, Clone)]
pub enum RecordingRecord {
    /// 执行成功（携带输出）
    Result { tool_name: String, output: Value },
    /// 执行失败（携带错误消息）
    Error { tool_name: String, message: String },
}

/// 后置钩子示例实现：记录工具执行结果与错误
///
/// 演示 on_result/on_error 两个后置钩子的接法与数据流；
/// before_execute 保持默认放行。记录可经 `records()` 读取（测试/审计）。
///
/// T06.3 Q18：生产零引用（grep 证实），整体标注 #[cfg(test)]；
/// 锁 expect（139/157）已由 PE-07 T07.6 改为恢复模式（A 模式，不 panic）。
#[cfg(test)]
pub struct RecordingMiddleware {
    name: String,
    records: Arc<Mutex<Vec<RecordingRecord>>>,
}

#[cfg(test)]
impl RecordingMiddleware {
    /// 新建记录中间件
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            records: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// 已收集的记录
    pub fn records(&self) -> Vec<RecordingRecord> {
        self.records
            .lock()
            .unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式（Q18 处置）：锁中毒恢复，不 panic 且可继续读
                tracing::error!("记录中间件锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .clone()
    }
}

#[cfg(test)]
#[async_trait]
impl ToolMiddleware for RecordingMiddleware {
    fn name(&self) -> &str {
        &self.name
    }

    async fn on_result(
        &self,
        tool: &dyn Tool,
        _input: &Value,
        output: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<AfterExecuteResult, ToolError> {
        let mut records = self
            .records
            .lock()
            .unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式（Q18 处置）：锁中毒恢复，不 panic
                tracing::error!("记录中间件锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            });
        records.push(RecordingRecord::Result {
            tool_name: tool.name().to_string(),
            output,
        });
        Ok(AfterExecuteResult::Passthrough)
    }

    async fn on_error(
        &self,
        tool: &dyn Tool,
        _input: &Value,
        error: &ToolError,
        _ctx: &ToolExecutionContext,
    ) -> Result<(), ToolError> {
        let mut records = self
            .records
            .lock()
            .unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式（Q18 处置）：锁中毒恢复，不 panic
                tracing::error!("记录中间件锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            });
        records.push(RecordingRecord::Error {
            tool_name: tool.name().to_string(),
            message: error.to_string(),
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::definition::ToolError;
    use crate::test_support::EchoTool;
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Arc;

    /// 简化执行器：按中间件链依次跑前置钩子→执行→后置钩子
    async fn run_chain(
        tool: &dyn Tool,
        input: Value,
        chain: &[Arc<dyn ToolMiddleware>],
        ctx: &ToolExecutionContext,
    ) -> Result<Value, ToolError> {
        let mut current = input;
        for m in chain {
            match m.before_execute(tool, current.clone(), ctx).await? {
                BeforeExecuteResult::Proceed { modified_input } => {
                    if let Some(v) = modified_input {
                        current = v;
                    }
                }
                BeforeExecuteResult::Block { reason } => {
                    return Err(ToolError::new(
                        "tool.execution_failed",
                        format!("被中间件阻止：{reason}"),
                    ));
                }
            }
        }
        let output = match tool.execute(current.clone()).await {
            Ok(v) => v,
            Err(e) => {
                for m in chain {
                    m.on_error(tool, &current, &e, ctx).await?;
                }
                return Err(e);
            }
        };
        let mut final_output = output;
        for m in chain {
            match m.on_result(tool, &current, final_output.clone(), ctx).await? {
                AfterExecuteResult::Passthrough => {}
                AfterExecuteResult::Replace(v) => final_output = v,
            }
        }
        Ok(final_output)
    }

    /// 测试用输出改写中间件：把输出替换为固定值
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

    /// 测试用拦截中间件：按入参内容决定放行或阻止
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
                    reason: "测试阻止".to_string(),
                })
            } else {
                Ok(BeforeExecuteResult::Proceed {
                    modified_input: None,
                })
            }
        }
    }

    fn ctx() -> ToolExecutionContext {
        ToolExecutionContext {
            session_id: Some("s1".to_string()),
            run_id: Some("r1".to_string()),
            tool_call_id: Some("c1".to_string()),
            cwd: Some("C:\\work".to_string()),
        }
    }

    #[tokio::test]
    async fn after_hooks_record_result() {
        let tool = EchoTool::new("echo");
        let recorder = Arc::new(RecordingMiddleware::new("recorder"));
        let chain: Vec<Arc<dyn ToolMiddleware>> = vec![recorder.clone()];

        let out = run_chain(&tool, json!({ "msg": "hi" }), &chain, &ctx())
            .await
            .unwrap();
        assert_eq!(out, json!({ "echo": { "msg": "hi" } }));

        let records = recorder.records();
        assert_eq!(records.len(), 1);
        match &records[0] {
            RecordingRecord::Result { tool_name, output } => {
                assert_eq!(tool_name, "echo");
                assert_eq!(output, &json!({ "echo": { "msg": "hi" } }));
            }
            RecordingRecord::Error { .. } => panic!("不应记录为错误"),
        }
    }

    #[tokio::test]
    async fn after_hooks_record_error() {
        let tool = EchoTool::new("echo");
        let recorder = Arc::new(RecordingMiddleware::new("recorder"));

        // 直接验证 on_error 钩子：手动构造错误并跑失败分支
        let err = ToolError::execution_failed("echo", "模拟失败");
        recorder
            .on_error(&tool, &json!({}), &err, &ctx())
            .await
            .unwrap();

        let records = recorder.records();
        assert_eq!(records.len(), 1);
        match &records[0] {
            RecordingRecord::Error { tool_name, message } => {
                assert_eq!(tool_name, "echo");
                assert!(message.contains("模拟失败"));
            }
            RecordingRecord::Result { .. } => panic!("不应记录为结果"),
        }
    }

    #[tokio::test]
    async fn after_hook_can_replace_output() {
        let tool = EchoTool::new("echo");
        let replacer = Arc::new(ReplaceMiddleware {
            name: "replacer".to_string(),
            replacement: json!({ "wrapped": true }),
        });
        let chain: Vec<Arc<dyn ToolMiddleware>> = vec![replacer];

        let out = run_chain(&tool, json!({ "msg": "hi" }), &chain, &ctx())
            .await
            .unwrap();
        assert_eq!(out, json!({ "wrapped": true }));
    }

    #[tokio::test]
    async fn before_hook_can_block_execution() {
        let tool = EchoTool::new("echo");
        let blocker = Arc::new(BlockingMiddleware {
            name: "blocker".to_string(),
        });
        let chain: Vec<Arc<dyn ToolMiddleware>> = vec![blocker];

        // 未触发拦截时正常放行
        let out = run_chain(&tool, json!({ "msg": "ok" }), &chain, &ctx())
            .await
            .unwrap();
        assert_eq!(out, json!({ "echo": { "msg": "ok" } }));

        // 触发拦截时返回阻止错误
        let err = run_chain(&tool, json!({ "block": true }), &chain, &ctx())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("被中间件阻止"));
    }

    #[tokio::test]
    async fn middleware_defaults_are_noop() {
        // 空链：不加任何中间件时直接执行
        let tool = EchoTool::new("echo");
        let chain: Vec<Arc<dyn ToolMiddleware>> = Vec::new();
        let out = run_chain(&tool, json!({ "msg": "hi" }), &chain, &ctx())
            .await
            .unwrap();
        assert_eq!(out, json!({ "echo": { "msg": "hi" } }));
    }

    // ── PE-07 T07.6 用例 3：锁中毒恢复（Q18 处置验证） ──

    #[tokio::test]
    async fn poisoned_recording_middleware_recovers_without_panic() {
        let recorder = Arc::new(RecordingMiddleware::new("recorder"));
        crate::test_support::poison_std_lock(&recorder.records);
        // 毒化后 on_result / on_error 不 panic 且继续记录（恢复模式）
        let tool = EchoTool::new("echo");
        let chain: Vec<Arc<dyn ToolMiddleware>> = vec![recorder.clone()];
        let out = run_chain(&tool, json!({ "msg": "hi" }), &chain, &ctx())
            .await
            .unwrap();
        assert_eq!(out, json!({ "echo": { "msg": "hi" } }));
        let err = ToolError::execution_failed("echo", "模拟失败");
        recorder
            .on_error(&tool, &json!({}), &err, &ctx())
            .await
            .unwrap();
        let records = recorder.records();
        assert_eq!(records.len(), 2);
    }
}
