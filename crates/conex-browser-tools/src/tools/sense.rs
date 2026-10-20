//! 感知类工具（5 个，17 §1.2 感知表；全部只读，dangerous=false）

use crate::error;
use crate::exec;
use crate::helpers;
use crate::tools::{resolve_tab, validate_tab_id, Ctx, CDP_PAGE_CAPTURE_SCREENSHOT};
use agent_tools::context::ToolContext;
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use conex_browser::action::{ActionErrorKind, WaitCondition, WaitOptions};
use conex_browser::snapshot::budget::BudgetConfig;
use serde_json::{json, Value};
use std::sync::Arc;

/// 可选 tab_id（targetId 字符串语义，P1）入参解析：校验后返回，缺省 = 活动标签。
fn optional_tab_id(args: &Value) -> Result<Option<String>, ToolError> {
    let tab_id = helpers::optional_string(args, "tab_id")?;
    if let Some(id) = &tab_id {
        validate_tab_id(id, "tab_id")?;
    }
    Ok(tab_id)
}

/// browser_snapshot：感知快照（紧凑文本树 + 索引；只读，脱敏，17 §1.2）。
pub(crate) struct SnapshotTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl SnapshotTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_snapshot".to_string(),
                description: "采集当前标签页的可交互快照（紧凑文本树 + [N] 元素索引，密码字段脱敏）。树中 [N] 索引用于交互类工具（browser_click/browser_type 等的 ref 参数）。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string", "description": "可选，标签 targetId（browser_list_tabs 输出；缺省 = 当前活动标签）" },
                        "max_depth": { "type": "number", "description": "可选，树深度预算覆盖（1..128；缺省用配置预算）" },
                        "max_elements": { "type": "number", "description": "可选，元素数预算覆盖（1..50000；缺省用配置预算）" },
                        "max_text": { "type": "number", "description": "可选，单节点文本预算覆盖（1..2000000；缺省用配置预算）" }
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
impl Tool for SnapshotTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_snapshot", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["tab_id", "max_depth", "max_elements", "max_text"])?;
        // P1 多标签：tab_id = targetId 字符串（缺省 = 活动标签）；路由失败 → node_gone
        let tab_id = optional_tab_id(&args)?;
        let max_depth = helpers::optional_u32(&args, "max_depth")?;
        let max_elements = helpers::optional_u32(&args, "max_elements")?;
        let max_text = helpers::optional_u32(&args, "max_text")?;
        if max_depth.is_some_and(|d| d == 0 || d > 128) {
            return Err(ToolError::invalid_input("max_depth 超出范围（1..128）"));
        }
        if max_elements.is_some_and(|e| e == 0 || e > 50_000) {
            return Err(ToolError::invalid_input(
                "max_elements 超出范围（1..50000）",
            ));
        }
        if max_text.is_some_and(|t| t == 0 || t > 2_000_000) {
            return Err(ToolError::invalid_input("max_text 超出范围（1..2000000）"));
        }
        let budgets = BudgetConfig {
            max_depth: max_depth
                .map(|d| d as usize)
                .unwrap_or(self.ctx.budgets.max_depth),
            max_tree_nodes: max_elements
                .map(|e| e as usize)
                .unwrap_or(self.ctx.budgets.max_tree_nodes),
            max_text_len: max_text
                .map(|t| t as usize)
                .unwrap_or(self.ctx.budgets.max_text_len),
            ..self.ctx.budgets
        };
        // P1：快照按 tab_id 路由（缺省活动标签；感知面与动作面同口径）
        let tab = resolve_tab(ops, tab_id.as_deref())?;
        let view = ops
            .capture_snapshot(&tab.target_id, &tab.session, budgets)
            .await?;
        Ok(json!({
            "ok": true,
            "snapshotVersion": view.snapshot_version,
            "tree": view.tree,
            "warnings": view.warnings,
        }))
    }
}

/// browser_screenshot：页面截图（只读；审计不落图片数据，17 §6.2）。
pub(crate) struct ScreenshotTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl ScreenshotTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_screenshot".to_string(),
                description: "截取当前标签页画面（base64 编码）。format 支持 png/jpeg；full_page=true 截全页。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string", "description": "可选，标签 targetId（缺省 = 当前活动标签）" },
                        "format": { "type": "string", "description": "可选，png|jpeg（缺省 png）" },
                        "full_page": { "type": "boolean", "description": "可选，整页截图（缺省 false）" }
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
impl Tool for ScreenshotTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_screenshot", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["tab_id", "format", "full_page"])?;
        let tab_id = optional_tab_id(&args)?;
        let format =
            helpers::optional_string(&args, "format")?.unwrap_or_else(|| "png".to_string());
        let full_page = helpers::optional_bool(&args, "full_page")?.unwrap_or(false);
        let mime_type = match format.as_str() {
            "png" => "image/png",
            "jpeg" => "image/jpeg",
            other => {
                return Err(ToolError::invalid_input(format!(
                    "format 仅支持 png/jpeg，收到 {other}"
                )))
            }
        };
        // P1：截图按 tab_id 路由（缺省活动标签）
        let tab = resolve_tab(ops, tab_id.as_deref())?;
        let value = ops
            .send_page(
                &tab.session,
                CDP_PAGE_CAPTURE_SCREENSHOT,
                json!({
                    "format": format,
                    "captureBeyondViewport": full_page,
                    "fromSurface": true,
                }),
            )
            .await?;
        let data = value.get("data").and_then(Value::as_str).ok_or_else(|| {
            ToolError::execution_failed("browser_screenshot", "captureScreenshot 未返回 data")
        })?;
        Ok(json!({
            "ok": true,
            "mimeType": mime_type,
            "dataBase64": data,
        }))
    }
}

/// browser_wait_for：等待条件满足（element/text/url/network_idle；R-5 条件面）。
pub(crate) struct WaitForTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl WaitForTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_wait_for".to_string(),
                description: "等待条件满足：condition=element（ref 快照索引）/text（页面纯文本子串）/url（当前 URL 子串，纯字符串匹配）/network_idle（网络空闲）。禁止 CSS selector 与 JS 表达式入参（R-5）。超时返回 matched=false（非致命，供模型调整策略）。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string", "description": "可选，标签 targetId（缺省 = 当前活动标签）" },
                        "condition": { "type": "string", "description": "element|text|url|network_idle" },
                        "ref": { "type": "number", "description": "condition=element 时的快照索引 [N]" },
                        "text": { "type": "string", "description": "condition=text 时的页面纯文本子串" },
                        "url": { "type": "string", "description": "condition=url 时的 URL 纯字符串子串" },
                        "timeout_ms": { "type": "number", "description": "可选，等待超时（毫秒，1..120000；缺省元素/文本 10s，其余 30s）" }
                    },
                    "required": ["condition"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for WaitForTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_wait_for", &self.ctx.session).await?;
        helpers::reject_unknown(
            &args,
            &["tab_id", "condition", "ref", "text", "url", "timeout_ms"],
        )?;
        let tab_id = optional_tab_id(&args)?;
        let condition = helpers::require_string(&args, "condition")?;
        let timeout_ms = helpers::optional_u32(&args, "timeout_ms")?;
        if timeout_ms.is_some_and(|t| t == 0 || t > 120_000) {
            return Err(ToolError::invalid_input(
                "timeout_ms 超出范围（1..120000 毫秒）",
            ));
        }
        // R-5 条件面：仅快照索引与纯文本/URL 字符串；无 selector/表达式入参面
        let cond = match condition.as_str() {
            "element" => {
                let index = helpers::optional_u64(&args, "ref")?.ok_or_else(|| {
                    ToolError::invalid_input("condition=element 时必须提供 ref（快照索引）")
                })?;
                if index >= u64::from(u32::MAX) {
                    return Err(ToolError::invalid_input("ref 超出快照索引范围"));
                }
                WaitCondition::Element {
                    index: index as usize,
                }
            }
            "text" => {
                let text = helpers::optional_string(&args, "text")?
                    .ok_or_else(|| ToolError::invalid_input("condition=text 时必须提供 text"))?;
                if text.chars().count() > 2048 {
                    return Err(ToolError::invalid_input("text 超长（> 2048 字符）"));
                }
                helpers::validate_no_control_chars(&text, "text")?;
                WaitCondition::Text(text)
            }
            "url" => {
                let url = helpers::optional_string(&args, "url")?
                    .ok_or_else(|| ToolError::invalid_input("condition=url 时必须提供 url"))?;
                if url.chars().count() > 2048 {
                    return Err(ToolError::invalid_input("url 超长（> 2048 字符）"));
                }
                helpers::validate_no_control_chars(&url, "url")?;
                WaitCondition::Url { contains: url }
            }
            "network_idle" => WaitCondition::NetworkIdle { quiet_ms: 500 },
            other => {
                return Err(ToolError::invalid_input(format!(
                    "condition 仅支持 element/text/url/network_idle，收到 {other}"
                )))
            }
        };
        // P1：wait_for 作用标签由 tab_id 指定（缺省活动标签；等待器内部按
        // WaitOptions.tab_id 路由到对应会话）
        let tab = resolve_tab(ops, tab_id.as_deref())?;
        let opts = WaitOptions::for_condition(&cond, tab.target_id.clone());
        let opts = if let Some(t) = timeout_ms {
            opts.with_timeout_ms(t)
        } else {
            opts
        };
        match ops.wait_for(cond, opts).await {
            Ok(success) => {
                tracing::debug!(
                    navigated = success.navigated,
                    page_changed = success.page_changed,
                    "browser_wait_for 条件满足"
                );
                Ok(json!({
                    "ok": true,
                    "matched": true,
                    "snapshotVersion": ops.snapshot_version(&tab.target_id),
                }))
            }
            // 14 §6.2：等待超时非致命，作为结果喂回模型（matched=false）
            Err(e) if e.kind == ActionErrorKind::Timeout => Ok(json!({
                "ok": true,
                "matched": false,
                "snapshotVersion": ops.snapshot_version(&tab.target_id),
                "reason": "等待超时（条件未满足）",
            })),
            Err(e) => Err(error::map_action_error("browser_wait_for", e)),
        }
    }
}

/// browser_get_url：当前标签页 URL（只读）。
pub(crate) struct GetUrlTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl GetUrlTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_get_url".to_string(),
                description: "读取当前标签页的当前 URL。只读。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string", "description": "可选，标签 targetId（缺省 = 当前活动标签）" }
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
impl Tool for GetUrlTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_get_url", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["tab_id"])?;
        let tab_id = optional_tab_id(&args)?;
        let tab = resolve_tab(ops, tab_id.as_deref())?;
        let (_, url) = super::target_info(ops, &tab.target_id).await?;
        Ok(json!({ "ok": true, "url": url.unwrap_or_default() }))
    }
}

/// browser_get_title：当前标签页标题（只读）。
pub(crate) struct GetTitleTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl GetTitleTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_get_title".to_string(),
                description: "读取当前标签页的页面标题。只读。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string", "description": "可选，标签 targetId（缺省 = 当前活动标签）" }
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
impl Tool for GetTitleTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_get_title", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["tab_id"])?;
        let tab_id = optional_tab_id(&args)?;
        let tab = resolve_tab(ops, tab_id.as_deref())?;
        let (title, _) = super::target_info(ops, &tab.target_id).await?;
        Ok(json!({ "ok": true, "title": title.unwrap_or_default() }))
    }
}
