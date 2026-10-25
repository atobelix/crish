//! 标签页类工具：list_tabs/new_tab/close_tab/switch_tab（自 navigate.rs 平移）。

use crate::exec;
use crate::helpers;
use crate::tools::navigate_common::{
    close_tab_by_id, open_new_tab, parse_http_url, parse_tab_id, switch_tab_by_id,
};
use crate::tools::{Ctx, TargetInfoLite};
use agent_tools::context::ToolContext;
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

/// browser_list_tabs：列出全部标签页（只读）。
pub(crate) struct ListTabsTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl ListTabsTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_list_tabs".to_string(),
                description: "列出当前浏览器实例的全部标签页（tabId/url/title/active）。只读。"
                    .to_string(),
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
impl Tool for ListTabsTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_list_tabs", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &[])?;
        let targets = super::page_targets(ops).await?;
        let current = ops.current_tab().map(|r| r.target_id).ok();
        let tabs: Vec<Value> = targets
            .iter()
            .map(|t: &TargetInfoLite| {
                json!({
                    "tabId": t.target_id,
                    "url": t.url,
                    "title": t.title,
                    "active": Some(t.target_id.as_str()) == current.as_deref(),
                })
            })
            .collect();
        Ok(json!({ "ok": true, "tabs": tabs }))
    }
}

/// browser_new_tab：新建标签页（导航检查点先行）。
pub(crate) struct NewTabTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl NewTabTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_new_tab".to_string(),
                description:
                    "新建标签页并打开目标 URL（仅 http/https；域名过门禁校验）。返回新标签页 id。"
                        .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "目标 URL（仅 http/https，about:blank 特例）" },
                        "background": { "type": "boolean", "description": "可选，后台打开不激活（MVP 接线注记：忽略）" }
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
impl Tool for NewTabTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_new_tab", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["url", "background"])?;
        let url = parse_http_url(&args)?;
        // background 语义（Target.createTarget 无背景面）MVP 忽略，P1 接线
        let _background = helpers::optional_bool(&args, "background")?;
        open_new_tab(&self.ctx, ops, &url).await
    }
}

/// browser_close_tab：关闭标签页（审计面：关闭动作本身入审计由引擎侧 M-4 接线）。
pub(crate) struct CloseTabTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl CloseTabTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_close_tab".to_string(),
                description: "按标签 targetId（browser_list_tabs 输出）关闭标签页。返回被关闭标签 id 与剩余标签数。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string", "description": "标签 targetId（browser_list_tabs 输出）" }
                    },
                    "required": ["tab_id"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for CloseTabTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_close_tab", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["tab_id"])?;
        let tab_id = parse_tab_id(&args)?;
        close_tab_by_id(ops, &tab_id).await
    }
}

/// browser_switch_tab：切换活动标签（tab_id = targetId 字符串语义，P1）。
pub(crate) struct SwitchTabTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl SwitchTabTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_switch_tab".to_string(),
                description: "按标签 targetId（browser_list_tabs 输出）切换活动标签。返回目标标签 id/URL/标题；切换后目标标签快照版本推进（旧快照失效，需重新快照）。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string", "description": "标签 targetId（browser_list_tabs 输出）" }
                    },
                    "required": ["tab_id"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for SwitchTabTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_switch_tab", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["tab_id"])?;
        let tab_id = parse_tab_id(&args)?;
        switch_tab_by_id(ops, &tab_id).await
    }
}
