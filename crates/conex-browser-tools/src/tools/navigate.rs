//! 导航类工具（8 个，17 §1.2 导航表）
//!
//! 全部导航命令发送前过导航检查点（17 §4.4：navigate/new_tab 校验目标 URL，
//! back/forward/reload 校验当前页 URL + 动作后复核）；`tab_id` 入参语义：
//! MVP 单标签 + 标签列表序号（1 起始，browser_list_tabs 输出序），P1 多标签
//! 以真实 targetId 字符串统一（遗留注记）。

use crate::error;
use crate::exec;
use crate::helpers;
use crate::session::SessionOps;
use crate::tools::{
    Ctx, TargetInfoLite, CDP_PAGE_GO_BACK, CDP_PAGE_GO_FORWARD, CDP_PAGE_NAVIGATE, CDP_PAGE_RELOAD,
    CDP_TARGET_ACTIVATE_TARGET, CDP_TARGET_CLOSE_TARGET, CDP_TARGET_CREATE_TARGET,
};
use agent_tools::context::ToolContext;
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

/// 导航后动作复核（14 §7.1 ③）：URL 变化后重新过门禁，拒绝则回退并报 gate_blocked。
async fn verify_after_navigation(
    ctx: &Ctx,
    ops: &dyn SessionOps,
    tab: &conex_browser::SessionRef,
    before: Option<&str>,
    after: Option<&str>,
) -> Result<(), ToolError> {
    if let (Some(after_url), Some(before_url)) = (after, before) {
        if after_url != before_url {
            if let Err(denial) = ctx.gate.check(after_url) {
                let _ = ops
                    .send_page(&tab.session, CDP_PAGE_GO_BACK, json!({}))
                    .await;
                return Err(error::gate_blocked(
                    after_url,
                    &format!("{}（已回退到上一页面）", denial.reason),
                ));
            }
        }
    }
    Ok(())
}

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
        let url = helpers::validate_http_url(&helpers::require_string(&args, "url")?)?;
        if let Some(t) = helpers::optional_u32(&args, "timeout_ms")? {
            if t == 0 || t > 120_000 {
                return Err(ToolError::invalid_input(
                    "timeout_ms 超出范围（1..120000 毫秒）",
                ));
            }
        }
        // 导航检查点（17 §4.4）：Page.navigate 发送之前
        exec::check_navigation_url(self.ctx.gate.as_ref(), url.as_str())?;
        let tab = ops.current_tab()?;
        let result = ops
            .send_page(
                &tab.session,
                CDP_PAGE_NAVIGATE,
                json!({ "url": url.as_str() }),
            )
            .await?;
        if let Some(err_text) = result.get("errorText").and_then(Value::as_str) {
            if !err_text.is_empty() {
                return Err(ToolError::execution_failed(
                    "browser_navigate",
                    format!("导航失败：{err_text}"),
                ));
            }
        }
        let (title, actual) = super::target_info(ops, &tab.target_id).await?;
        Ok(json!({
            "ok": true,
            "url": actual.unwrap_or_else(|| url.to_string()),
            "title": title.unwrap_or_default(),
            "snapshotVersion": ops.snapshot_version(&tab.target_id),
        }))
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
        let tab = ops.current_tab()?;
        let (_, before) = super::target_info(ops, &tab.target_id).await?;
        if let Some(u) = &before {
            exec::check_navigation_url(self.ctx.gate.as_ref(), u)?;
        }
        ops.send_page(&tab.session, CDP_PAGE_GO_BACK, json!({}))
            .await?;
        let (title, after) = super::target_info(ops, &tab.target_id).await?;
        verify_after_navigation(&self.ctx, ops, &tab, before.as_deref(), after.as_deref()).await?;
        Ok(json!({
            "ok": true,
            "url": after.unwrap_or_default(),
            "title": title.unwrap_or_default(),
            "snapshotVersion": ops.snapshot_version(&tab.target_id),
        }))
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
        let tab = ops.current_tab()?;
        let (_, before) = super::target_info(ops, &tab.target_id).await?;
        if let Some(u) = &before {
            exec::check_navigation_url(self.ctx.gate.as_ref(), u)?;
        }
        ops.send_page(&tab.session, CDP_PAGE_GO_FORWARD, json!({}))
            .await?;
        let (title, after) = super::target_info(ops, &tab.target_id).await?;
        verify_after_navigation(&self.ctx, ops, &tab, before.as_deref(), after.as_deref()).await?;
        Ok(json!({
            "ok": true,
            "url": after.unwrap_or_default(),
            "title": title.unwrap_or_default(),
            "snapshotVersion": ops.snapshot_version(&tab.target_id),
        }))
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
        let tab = ops.current_tab()?;
        let (_, before) = super::target_info(ops, &tab.target_id).await?;
        if let Some(u) = &before {
            exec::check_navigation_url(self.ctx.gate.as_ref(), u)?;
        }
        ops.send_page(
            &tab.session,
            CDP_PAGE_RELOAD,
            json!({ "ignoreCache": ignore_cache }),
        )
        .await?;
        let (title, after) = super::target_info(ops, &tab.target_id).await?;
        verify_after_navigation(&self.ctx, ops, &tab, before.as_deref(), after.as_deref()).await?;
        Ok(json!({
            "ok": true,
            "url": after.unwrap_or_default(),
            "title": title.unwrap_or_default(),
        }))
    }
}

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
        let url = helpers::validate_http_url(&helpers::require_string(&args, "url")?)?;
        // background 语义（Target.createTarget 无背景面）MVP 忽略，P1 接线
        let _background = helpers::optional_bool(&args, "background")?;
        // 导航检查点（17 §4.4）：Target.createTarget 发送之前
        exec::check_navigation_url(self.ctx.gate.as_ref(), url.as_str())?;
        let value = ops
            .send_browser(CDP_TARGET_CREATE_TARGET, json!({ "url": url.as_str() }))
            .await?;
        let tab_id = value
            .get("targetId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ToolError::execution_failed("browser_new_tab", "createTarget 未返回 targetId")
            })?;
        Ok(json!({
            "ok": true,
            "tabId": tab_id,
            "url": url.to_string(),
        }))
    }
}

/// 标签序号 → 目标（1 起始列表序号，MVP 语义；越界 → invalid_input）。
async fn target_by_seq(ops: &dyn SessionOps, seq: u64) -> Result<TargetInfoLite, ToolError> {
    if seq == 0 {
        return Err(ToolError::invalid_input(
            "tab_id 为 1 起始的标签列表序号（browser_list_tabs 输出序）",
        ));
    }
    let targets = super::page_targets(ops).await?;
    if seq as usize > targets.len() {
        return Err(ToolError::invalid_input(format!(
            "标签序号 {seq} 越界（当前 {} 个标签页）",
            targets.len()
        )));
    }
    Ok(targets
        .into_iter()
        .nth(seq as usize - 1)
        .expect("越界检查后序号必命中"))
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
                description: "按标签序号（1 起始，browser_list_tabs 输出序）关闭标签页。返回被关闭标签 id 与剩余标签数。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "number", "description": "标签序号（1 起始；MVP 单标签语义的列表序号，P1 多标签统一）" }
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
        let seq = helpers::require_u64(&args, "tab_id")?;
        let target = target_by_seq(ops, seq).await?;
        let value = ops
            .send_browser(
                CDP_TARGET_CLOSE_TARGET,
                json!({ "targetId": &target.target_id }),
            )
            .await?;
        if value.get("success").and_then(Value::as_bool) == Some(false) {
            return Err(ToolError::execution_failed(
                "browser_close_tab",
                "closeTarget 返回 success=false",
            ));
        }
        let remaining = super::page_targets(ops).await?.len();
        Ok(json!({
            "ok": true,
            "closedTabId": target.target_id,
            "remainingTabs": remaining,
        }))
    }
}

/// browser_switch_tab：切换活动标签。
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
                description: "按标签序号（1 起始，browser_list_tabs 输出序）切换活动标签。返回目标标签 id/URL/标题。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "number", "description": "标签序号（1 起始；MVP 单标签语义的列表序号，P1 多标签统一）" }
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
        let seq = helpers::require_u64(&args, "tab_id")?;
        let target = target_by_seq(ops, seq).await?;
        ops.send_browser(
            CDP_TARGET_ACTIVATE_TARGET,
            json!({ "targetId": &target.target_id }),
        )
        .await?;
        let (title, url) = super::target_info(ops, &target.target_id).await?;
        Ok(json!({
            "ok": true,
            "tabId": target.target_id,
            "url": url.unwrap_or_default(),
            "title": title.unwrap_or_default(),
        }))
    }
}
