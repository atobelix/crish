//! 工具中间件（对齐 TS 端 tools/tool-middleware.ts 精简 Hook 体系）
//!
//! TS 红线禁令 7 后仅保留三个钩子：beforeExecute / onResult / onError。
//! 本模块定义接口（ToolMiddleware trait，三个钩子均有默认空实现）；
//! 后置钩子示例实现 [RecordingMiddleware] 仅测试使用（T06.3 Q18 曾标注
//! 生产零引用；后接线为真实扩展点——session-loop ToolExecutor 消费本
//! trait，RecordingMiddleware 仍保持 #[cfg(test)]）。
//!
//! 生产消费方：crates/session-loop/src/tool_exec.rs（审批通过后、执行前
//! 运行 before_execute 链，执行后运行 on_result / on_error 链；优先级
//! 语义与决策记录见 docs/multi-agent-repair/06-tool-middleware-hook-接线决策.md）。

use crate::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use serde_json::Value;
use std::time::Duration;
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

/// 中间件钩子超时配置（E4：06 遗留 :148-152 收口）
///
/// 三个执行钩子（before_execute / on_result / on_error）统一包
/// `tokio::time::timeout` 竞速窗口，超时语义对齐 06 文档「中间件自身
/// 错误语义」表：
/// - `before_execute` 超时 → 视为 Err → **Block**（守门者报错 = 不放行，06:57）；
/// - `on_result` 超时 → 日志 + 降级透传原输出（06:58）；
/// - `on_error` 超时 → 日志（06:59）。
///
/// 默认值 = 「宽松放行」语义（2000/2000/1000ms）：快中间件不受影响，
/// 只有挂死 handler 才会被竞速收口。执行器经
/// `ToolExecutor::with_middleware_timeouts` 注入（session-loop）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MiddlewareTimeoutConfig {
    /// before_execute 超时（默认 2000ms）
    pub before_execute: Duration,
    /// on_result 超时（默认 2000ms）
    pub on_result: Duration,
    /// on_error 超时（默认 1000ms）
    pub on_error: Duration,
}

impl Default for MiddlewareTimeoutConfig {
    fn default() -> Self {
        Self {
            before_execute: Duration::from_millis(2000),
            on_result: Duration::from_millis(2000),
            on_error: Duration::from_millis(1000),
        }
    }
}

/// 工具中间件接口
///
/// 四个钩子按需覆盖（默认空实现）：
/// - on_definition：工具定义构建时改写（同步链，挂 ToolRegistry::list_definitions 构建点）
/// - before_execute：执行前拦截/改写入参（审批类中间件落点，B5.4/B3.5 联动）
/// - on_result：执行成功后观察/改写输出
/// - on_error：执行失败后观察（仅记录，不吞错）
///
/// 串行化语义（E4 内容 4，06 遗留 :153 文档化）：中间件链本就**顺序执行**
/// （determinism，ref-analysis 03 Top 6）——并行工具组内每项独立走链、
/// 中间件实例跨项共享，trait 已要求 Send + Sync（实例须自持线程安全
/// 状态）；on_definition 同链顺序改写，改写结果确定。
#[async_trait]
pub trait ToolMiddleware: Send + Sync {
    /// 中间件名称（日志与调试用）
    fn name(&self) -> &str;

    /// 定义改写钩子（同步；默认空实现 no-op）。
    ///
    /// 挂载点 = `ToolRegistry::list_definitions()` 构建工具清单时（引擎给
    /// provider 发 schema 前，ref-analysis 03 Top 1「生成时改写」语义——
    /// 按 (provider, model) 动态裁剪的未来点位与此共享）。可改写
    /// `description` 与 `input_schema`；实现必须幂等（同一工具定义可被
    /// 多次构建改写，重入结果一致）。
    fn on_definition(&self, _def: &mut ToolDefinition) {}

    /// 执行前钩子
    async fn before_execute(
        &self,
        _tool: &dyn Tool,
        _input: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<BeforeExecuteResult, ToolError> {
        Ok(BeforeExecuteResult::Proceed {
            modified_input: None,
        })
    }

    /// 执行成功后置钩子（可改写输出）
    async fn on_result(
        &self,
        _tool: &dyn Tool,
        _input: &Value,
        _output: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<AfterExecuteResult, ToolError> {
        Ok(AfterExecuteResult::Passthrough)
    }

    /// 执行失败后置钩子（仅观察）
    async fn on_error(
        &self,
        _tool: &dyn Tool,
        _input: &Value,
        _error: &ToolError,
        _ctx: &ToolExecutionContext,
    ) -> Result<(), ToolError> {
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
        let mut records = self.records.lock().unwrap_or_else(|e| {
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
        let mut records = self.records.lock().unwrap_or_else(|e| {
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
        // R3 T9：中间件上下文 → 会话级 ToolContext（session_id / cwd 为
        // 可选字段，缺失时回退空串与当前目录）
        let tool_ctx = crate::context::ToolContext {
            session_id: ctx.session_id.clone().unwrap_or_default(),
            abort_token: crate::context::AbortToken::new(),
            ask: None,
            workspace_root: ctx
                .cwd
                .clone()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
                }),
            permission_mode: crate::permission::PermissionMode::default(),
            write_claims: None,
            write_claim_holder: None,
            explore_docs_quota: None,
            // T-AB-02/03：中间件执行路径不接线后台管理器与日志根（None）
            background: None,
            // 中间件执行路径不接线产出目录解析服务（None，对齐 T-EG-08）
            output_dir: None,
            log_root: None,
            // T-40（记忆韧性轮次 5）：中间件执行路径不接线压缩块服务
            compression_store: None,
            // W4-A/B：中间件执行路径不接线笔记后端
            note_backend: None,
            // D-02 LK-01：中间件直连路径无工具调用上下文（None）
            tool_call_id: None,
            task_type: None,
        };
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
        let output = match tool.execute(&tool_ctx, current.clone()).await {
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
            match m
                .on_result(tool, &current, final_output.clone(), ctx)
                .await?
            {
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

    // ── E4：on_definition 第 4 钩子 + 超时默认（03 方案 E4 内容 1/3）──

    /// 测试用定义改写中间件：给 description 追加后缀（链序断言用）
    struct DescriptionSuffixMiddleware {
        name: String,
        suffix: String,
    }

    impl ToolMiddleware for DescriptionSuffixMiddleware {
        fn name(&self) -> &str {
            &self.name
        }

        fn on_definition(&self, def: &mut crate::definition::ToolDefinition) {
            def.description = format!("{}{}", def.description, self.suffix);
        }
    }

    /// on_definition 可改写工具定义（description 与 input_schema）
    #[test]
    fn on_definition_rewrites_tool_definition() {
        let mw = DescriptionSuffixMiddleware {
            name: "suffixer".to_string(),
            suffix: "（改写）".to_string(),
        };
        let mut def = crate::definition::ToolDefinition {
            name: "shell_run".to_string(),
            description: "运行命令".to_string(),
            input_schema: json!({ "type": "object" }),
            dangerous: false,
            fatal_on_error: false,
        };
        mw.on_definition(&mut def);
        assert_eq!(def.description, "运行命令（改写）");
        // name 与 schema 不被误伤（只改 description）
        assert_eq!(def.name, "shell_run");
        assert_eq!(def.input_schema, json!({ "type": "object" }));
    }

    /// 默认空实现 no-op：定义原样保留（空链语义）
    #[test]
    fn on_definition_default_is_noop() {
        let recorder = RecordingMiddleware::new("noop");
        let mut def = crate::definition::ToolDefinition {
            name: "x".to_string(),
            description: "原始描述".to_string(),
            input_schema: json!({ "type": "object" }),
            dangerous: false,
            fatal_on_error: false,
        };
        let original = def.clone();
        recorder.on_definition(&mut def);
        assert_eq!(def, original, "未覆盖 on_definition 的中间件不改写定义");
    }

    /// 链序确定性：多个中间件按注册顺序依次改写（determinism）
    #[test]
    fn on_definition_chain_applies_in_registration_order() {
        let first = DescriptionSuffixMiddleware {
            name: "first".to_string(),
            suffix: "|1".to_string(),
        };
        let second = DescriptionSuffixMiddleware {
            name: "second".to_string(),
            suffix: "|2".to_string(),
        };
        let mut def = crate::definition::ToolDefinition {
            name: "x".to_string(),
            description: "base".to_string(),
            input_schema: json!({ "type": "object" }),
            dangerous: false,
            fatal_on_error: false,
        };
        let chain: Vec<&dyn ToolMiddleware> = vec![&first, &second];
        for mw in chain {
            mw.on_definition(&mut def);
        }
        assert_eq!(def.description, "base|1|2", "改写必须按链序顺序生效");
    }

    /// 超时默认值 = 宽松放行（before/on_result 2000ms、on_error 1000ms）
    #[test]
    fn middleware_timeout_defaults_are_permissive() {
        let defaults = MiddlewareTimeoutConfig::default();
        assert_eq!(defaults.before_execute, Duration::from_millis(2000));
        assert_eq!(defaults.on_result, Duration::from_millis(2000));
        assert_eq!(defaults.on_error, Duration::from_millis(1000));
    }
}
