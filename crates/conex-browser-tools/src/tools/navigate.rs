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
use std::time::Duration;

/// 导航后最终 URL 收敛轮询参数（H4：createTarget 返回时新页导航仍在途，
/// 302 重定向未落地时 URL 与请求一致——短轮询至多等待收敛后复核）。
const REDIRECT_POLLS: u32 = 5;
const REDIRECT_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// 动作后复核的违例回退动作（navigate 回退历史；new_tab 关闭新标签）。
enum AfterRollback<'a> {
    /// 回退到上一页面（Page.goBack，会话面）
    GoBack { session: &'a str },
    /// 关闭新标签（Target.closeTarget，浏览器面；建页即违例无历史可回退）
    CloseTab { target_id: &'a str },
}

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

/// H4 动作后门禁复核（browser_navigate / browser_new_tab 接入面）：
/// 导航动作完成后重新读取目标最终 URL 并过门禁——302 重定向可把白名单内请求
/// 带往内网/保留段，前置检查无法覆盖。
///
/// - `requested`：门禁已放行的请求 URL；最终 URL 与其不同时才触发复核
///   （相同 = 已前置校验，无需重复判定）；
/// - `poll`：new_tab 用（createTarget 返回时新页导航仍在途，URL 未变化时短轮询
///   等待 302 收敛）；navigate 的导航提交语义已携带最终 URL，传 false；
/// - 违例：执行 `rollback` 回退后返回 `tool.browser.gate_blocked`；
/// - 返回最终 (title, url) 供调用方组织输出（含 302 后的真实落地 URL）。
async fn verify_navigate_after(
    ctx: &Ctx,
    ops: &dyn SessionOps,
    target_id: &str,
    requested: &str,
    poll: bool,
    rollback: AfterRollback<'_>,
) -> Result<(Option<String>, Option<String>), ToolError> {
    let mut info = super::target_info(ops, target_id).await?;
    if poll {
        for _ in 0..REDIRECT_POLLS {
            if info.1.as_deref() == Some(requested) {
                tokio::time::sleep(REDIRECT_POLL_INTERVAL).await;
                info = super::target_info(ops, target_id).await?;
            } else {
                break;
            }
        }
    }
    let Some(after_url) = info.1.as_deref() else {
        return Ok(info);
    };
    if after_url != requested {
        if let Err(denial) = ctx.gate.check(after_url) {
            let rollback_note = match rollback {
                AfterRollback::GoBack { session } => {
                    let _ = ops
                        .send_page(session, CDP_PAGE_GO_BACK, json!({}))
                        .await;
                    "已回退到上一页面"
                }
                AfterRollback::CloseTab { target_id } => {
                    let _ = ops
                        .send_browser(CDP_TARGET_CLOSE_TARGET, json!({ "targetId": target_id }))
                        .await;
                    "已关闭新标签页"
                }
            };
            return Err(error::gate_blocked(
                after_url,
                &format!("{}（{rollback_note}）", denial.reason),
            ));
        }
    }
    Ok(info)
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
        // H4 动作后门禁复核：302 重定向可能把白名单内 URL 带往内网/保留段——
        // 导航提交已携带最终 URL（服务端跳转在提交前完成），读取后复核，
        // 违例回退上一页并返回 gate_blocked
        let (title, actual) = verify_navigate_after(
            &self.ctx,
            ops,
            &tab.target_id,
            url.as_str(),
            false,
            AfterRollback::GoBack { session: &tab.session },
        )
        .await?;
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
        // H4 动作后门禁复核：createTarget 返回时新页导航仍在途，302 重定向
        // 可能把白名单内 URL 带往内网/保留段——轮询收敛最终 URL 后复核，
        // 违例关闭新标签并返回 gate_blocked
        let (_, actual) = verify_navigate_after(
            &self.ctx,
            ops,
            tab_id,
            url.as_str(),
            true,
            AfterRollback::CloseTab { target_id: tab_id },
        )
        .await?;
        Ok(json!({
            "ok": true,
            "tabId": tab_id,
            "url": url.to_string(),
            "finalUrl": actual.unwrap_or_else(|| url.to_string()),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{ConsoleEntry, NetworkEntry, SnapshotView};
    use agent_tools::context::create_mock_tool_context;
    use conex_browser::action::gate::{DomainGate, GateDenial};
    use conex_browser::action::{
        ActionError, ActionRequest, ActionSuccess, ElementMeta, WaitCondition, WaitOptions,
    };
    use conex_browser::snapshot::budget::BudgetConfig;
    use conex_browser::SessionRef;
    use std::sync::Mutex;

    /// 确定性门禁替身：host 命中 denied_host 一律拒绝（零 DNS 依赖，CI 稳定）。
    struct StubGate {
        denied_host: &'static str,
    }

    impl DomainGate for StubGate {
        fn check(&self, url: &str) -> Result<(), GateDenial> {
            let host = url::Url::parse(url)
                .expect("测试 URL 应合法")
                .host_str()
                .map(str::to_string);
            if host.as_deref() == Some(self.denied_host) {
                return Err(GateDenial {
                    url: url.to_string(),
                    reason: format!("测试拒绝：{url}"),
                });
            }
            Ok(())
        }
    }

    /// 记录型会话替身：记录全部命令 + 可配 Target.getTargetInfo 最终 URL
    /// （模拟 302 重定向后的落地 URL）。
    struct NavigateOps {
        log: Mutex<Vec<String>>,
        info_url: String,
    }

    impl NavigateOps {
        fn new(info_url: &str) -> Arc<Self> {
            Arc::new(NavigateOps {
                log: Mutex::new(Vec::new()),
                info_url: info_url.to_string(),
            })
        }
        fn calls(&self) -> Vec<String> {
            self.log.lock().unwrap_or_else(|p| p.into_inner()).clone()
        }
        fn assert_called(&self, needle: &str) {
            assert!(
                self.calls().iter().any(|c| c.contains(needle)),
                "应调用 {needle}：{:?}",
                self.calls()
            );
        }
        fn assert_not_called(&self, needle: &str) {
            assert!(
                !self.calls().iter().any(|c| c.contains(needle)),
                "不应调用 {needle}：{:?}",
                self.calls()
            );
        }
    }

    #[async_trait]
    impl SessionOps for NavigateOps {
        fn readiness(&self) -> Result<(), String> {
            Ok(())
        }
        fn current_tab(&self) -> Result<SessionRef, ToolError> {
            Ok(SessionRef {
                target_id: "T1".to_string(),
                session: "S1".to_string(),
            })
        }
        async fn send_page(
            &self,
            session: &str,
            method: &str,
            params: Value,
        ) -> Result<Value, ToolError> {
            self.log
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(format!("page:{session}:{method} {params}"));
            Ok(json!({ "frameId": "F1" }))
        }
        async fn send_browser(&self, method: &str, params: Value) -> Result<Value, ToolError> {
            self.log
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(format!("browser:{method} {params}"));
            match method {
                "Target.createTarget" => Ok(json!({ "targetId": "T9" })),
                "Target.getTargets" => Ok(json!({ "targetInfos": [] })),
                "Target.getTargetInfo" => Ok(json!({
                    "targetInfo": {
                        "targetId": "T1",
                        "type": "page",
                        "title": "标题",
                        "url": self.info_url
                    }
                })),
                _ => Ok(json!({})),
            }
        }
        fn snapshot_version(&self, _tab_id: &str) -> u64 {
            7
        }
        async fn capture_snapshot(
            &self,
            _tab_id: &str,
            _session: &str,
            _budgets: BudgetConfig,
        ) -> Result<SnapshotView, ToolError> {
            Ok(SnapshotView {
                snapshot_version: 7,
                tree: String::new(),
                warnings: vec![],
            })
        }
        fn element_meta(
            &self,
            _tab_id: &str,
            _version: u64,
            _index: u32,
        ) -> Result<Option<ElementMeta>, ToolError> {
            Ok(Some(ElementMeta {
                backend_node_id: 1,
                is_password: false,
            }))
        }
        async fn execute_action(&self, _req: ActionRequest) -> Result<ActionSuccess, ActionError> {
            Ok(ActionSuccess {
                navigated: false,
                url_after: None,
                page_changed: false,
                payload: None,
            })
        }
        async fn wait_for(
            &self,
            _cond: WaitCondition,
            _opts: WaitOptions,
        ) -> Result<ActionSuccess, ActionError> {
            Ok(ActionSuccess {
                navigated: false,
                url_after: None,
                page_changed: false,
                payload: None,
            })
        }
        async fn console_entries(&self, _since_seq: u64) -> Vec<ConsoleEntry> {
            vec![]
        }
        async fn network_entries(&self, _since_seq: u64) -> Vec<NetworkEntry> {
            vec![]
        }
    }

    /// 组装工具上下文（注入记录型会话 + 拒绝指定 host 的门禁替身）。
    fn tool_ctx(ops: Arc<NavigateOps>, denied_host: &'static str) -> Arc<Ctx> {
        Arc::new(Ctx {
            session: Some(ops),
            gate: Arc::new(StubGate { denied_host }),
            sensitive: crate::SensitiveCapabilities::default(),
            budgets: BudgetConfig::active(),
        })
    }

    /// H4 主回归：navigate 到白名单内 URL，服务端 302 重定向到被禁域
    /// （内网地址）→ 动作后复核拦截：gate_blocked + 回退上一页，不返回成功结果。
    #[tokio::test]
    async fn navigate_302_to_blocked_domain_intercepted() {
        let ops = NavigateOps::new("http://192.168.1.1/admin");
        let ctx = tool_ctx(ops.clone(), "192.168.1.1");
        let tool = NavigateTool::new(ctx);
        let err = tool
            .execute(
                &create_mock_tool_context(),
                json!({ "url": "https://example.com/redir" }),
            )
            .await
            .expect_err("302 到被禁域应被拦截（H4）");
        assert_eq!(err.code(), "tool.browser.gate_blocked", "错误码：{err}");
        assert!(
            err.to_string().contains("192.168.1.1"),
            "错误应携带最终落地 URL：{err}"
        );
        ops.assert_called("page:S1:Page.navigate");
        ops.assert_called("page:S1:Page.goBack");
    }

    /// H4 主回归（new_tab）：createTarget 后新页 302 到被禁域 → gate_blocked +
    /// 关闭新标签（无历史可回退）。
    #[tokio::test]
    async fn new_tab_302_to_blocked_domain_intercepted() {
        let ops = NavigateOps::new("http://192.168.1.1/admin");
        let ctx = tool_ctx(ops.clone(), "192.168.1.1");
        let tool = NewTabTool::new(ctx);
        let err = tool
            .execute(
                &create_mock_tool_context(),
                json!({ "url": "https://example.com/redir" }),
            )
            .await
            .expect_err("新标签 302 到被禁域应被拦截（H4）");
        assert_eq!(err.code(), "tool.browser.gate_blocked", "错误码：{err}");
        ops.assert_called("browser:Target.createTarget");
        ops.assert_called("browser:Target.closeTarget");
        ops.assert_not_called("Page.goBack");
    }

    /// 正路径：最终 URL 仍在允许面 → 成功返回真实落地 URL（302 到允许域），无回退。
    #[tokio::test]
    async fn navigate_allowed_redirect_succeeds() {
        let ops = NavigateOps::new("https://a.example/after");
        let ctx = tool_ctx(ops.clone(), "192.168.1.1");
        let tool = NavigateTool::new(ctx);
        let out = tool
            .execute(
                &create_mock_tool_context(),
                json!({ "url": "https://example.com/page" }),
            )
            .await
            .expect("允许面导航应成功");
        assert_eq!(out["url"], "https://a.example/after", "返回真实落地 URL");
        assert_eq!(out["snapshotVersion"], 7);
        ops.assert_not_called("Page.goBack");
    }
}
