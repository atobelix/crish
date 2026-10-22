//! 历史导航类工具：navigate/back/forward/reload（自 navigate.rs 平移）。

use crate::exec;
use crate::helpers;
use crate::tools::Ctx;
use crate::tools::navigate_common::{
    history_back, history_forward, navigate_current_tab, parse_http_url, reject_bad_timeout_ms,
    reload_current_tab,
};
use agent_tools::context::ToolContext;
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;

/// browser_navigate：导航当前标签页（导航检查点先行，17 §4.4）。
pub(crate) struct NavigateTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl NavigateTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_navigate".to_string(),
                description: "导航当前标签页到目标 URL（仅 http/https；域名过门禁校验，17 §4）。返回导航后实际 URL、标题与快照版本。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "目标 URL（仅 http/https，about:blank 特例）" },
                        "timeout_ms": { "type": "number", "description": "可选，命令超时（毫秒，1..120000）" }
                    },
                    "required": ["url"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for NavigateTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_navigate", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["url", "timeout_ms"])?;
        let url = parse_http_url(&args)?;
        reject_bad_timeout_ms(&args)?;
        navigate_current_tab(&self.ctx, ops, &url).await
    }
}

/// browser_back：历史后退（动作后门禁复核，14 §7.1 ③）。
pub(crate) struct BackTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl BackTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_back".to_string(),
                description: "历史后退一页；返回后退后 URL、标题与快照版本。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for BackTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_back", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &[])?;
        history_back(&self.ctx, ops).await
    }
}

/// browser_forward：历史前进（动作后门禁复核，14 §7.1 ③）。
pub(crate) struct ForwardTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl ForwardTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_forward".to_string(),
                description: "历史前进一页；返回前进后 URL、标题与快照版本。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for ForwardTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_forward", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &[])?;
        history_forward(&self.ctx, ops).await
    }
}

/// browser_reload：刷新当前页（ignore_cache 可选）。
pub(crate) struct ReloadTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl ReloadTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_reload".to_string(),
                description: "刷新当前标签页；ignoreCache=true 时绕过缓存。返回刷新后 URL 与标题。"
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "ignore_cache": { "type": "boolean", "description": "可选，是否绕过缓存加载（缺省 false）" }
                    },
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for ReloadTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_reload", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["ignore_cache"])?;
        let ignore_cache = helpers::optional_bool(&args, "ignore_cache")?.unwrap_or(false);
        reload_current_tab(&self.ctx, ops, ignore_cache).await
    }
}
