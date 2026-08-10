//! browser_evaluate：受限求值工具（17 文档 §3，R-6 全套；危险级 + 能力位默认关）

use crate::error;
use crate::exec;
use crate::helpers;
use crate::tools::{validate_tab_id, Ctx};
use agent_tools::context::ToolContext;
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use conex_browser::action::evaluate::{dispatch_evaluate, EvaluateRequest, EVAL_TIMEOUT_MS};
use serde_json::{json, Value};
use std::sync::Arc;

/// browser_evaluate：受限求值（只读白名单代理 `__crish_read`，三层校验）。
/// 危险级：dangerous=true（17 §3.3 Ask 审批）；能力位 `SensitiveCapabilities.evaluate`
/// 默认关——未开启直接 Deny（零 CDP 命令，17 §2.3 红线语义）。
pub(crate) struct EvaluateTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl EvaluateTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_evaluate".to_string(),
                description: "在页面隔离世界执行只读受限求值（白名单代理 __crish_read：attr/text/rect/formValue/all/state）。静态词法 + 运行时隔离 + 结果预算三层校验，任何写入/网络/构造面拒绝。需要显式开启能力位并逐次审批。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "expression": { "type": "string", "description": "受限求值表达式（仅 __crish_read 白名单 API + 只读表达式，≤8KB）" },
                        "tab_id": { "type": "string", "description": "可选，标签 targetId（browser_list_tabs 输出；缺省 = 当前活动标签）" },
                        "timeout_ms": { "type": "number", "description": "可选，求值硬限毫秒（上限 2000；缺省 2000）" }
                    },
                    "required": ["expression"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for EvaluateTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        // 统一管线（急停 → 会话就绪 → 门禁；R-9 gating）
        let _ops = exec::run_browser_action(tctx, "browser_evaluate", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["expression", "tab_id", "timeout_ms"])?;

        // 能力位红线（17 §2.3）：未显式开启 → Deny（零 CDP 命令）
        if !self.ctx.sensitive.evaluate {
            return Err(error::capability_disabled("browser_evaluate"));
        }

        // expression 必填
        let expression = helpers::optional_string(&args, "expression")?
            .ok_or_else(|| ToolError::invalid_input("expression 必填"))?;
        // tab_id 可选（targetId 语义，P1）
        let tab_id = helpers::optional_string(&args, "tab_id")?;
        if let Some(id) = &tab_id {
            validate_tab_id(id, "tab_id")?;
        }
        let timeout_ms = helpers::optional_u32(&args, "timeout_ms")?.unwrap_or(EVAL_TIMEOUT_MS);
        if timeout_ms == 0 || timeout_ms > EVAL_TIMEOUT_MS {
            return Err(ToolError::invalid_input(format!(
                "timeout_ms 超限（1..{EVAL_TIMEOUT_MS}）"
            )));
        }

        let session = self
            .ctx
            .session
            .as_ref()
            .ok_or_else(|| error::unwired("browser_evaluate"))?;

        // 会话路由（per-tab；缺省活动标签）
        let session_id = match tab_id.as_deref() {
            Some(tid) => session
                .tab_session(tid)
                .map(|r| r.session.clone())
                .ok_or_else(|| error::node_gone(format!("browser_evaluate：标签 {tid} 不存在或已关闭")))?,
            None => session
                .current_tab()
                .map(|r| r.session.clone())
                .map_err(|_| error::not_ready("browser_evaluate：无活动标签页"))?,
        };

        // 执行器（受限求值入口）；未接线 → unwired
        let executor = session
            .executor(&session_id)
            .ok_or_else(|| error::unwired("browser_evaluate"))?;

        // 三层校验执行（词法 → 隔离世界 → 结果预算；17 §3.2）
        let request = EvaluateRequest {
            expression,
            element: None,
            timeout_ms,
        };
        let result = dispatch_evaluate(&executor, &request).await.map_err(|e| {
            // 原语层拒绝 → 工具层映射（17 §1.3：eval_forbidden 语义由错误消息携带）
            ToolError::execution_failed(
                "browser_evaluate",
                format!("受限求值被拒（{:?}）：{}", e.kind, e.message),
            )
        })?;

        // 审计占位（17 §3.3 全量审计在引擎侧 SecurityAuditSink；此处 tracing 先行）
        let size = result
            .as_ref()
            .map(|v| serde_json::to_string(v).map(|s| s.len()).unwrap_or(0))
            .unwrap_or(0);
        tracing::info!(
            tool = "browser_evaluate",
            expr_len = request.expression.len(),
            result_size = size,
            "受限求值执行完成"
        );

        Ok(json!({ "result": result, "meta": { "result_size": size } }))
    }
}
