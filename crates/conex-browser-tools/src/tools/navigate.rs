//! 导航类工具（8 个，17 §1.2 导航表）
//!
//! 全部导航命令发送前过导航检查点（17 §4.4：navigate/new_tab 校验目标 URL，
//! back/forward/reload 校验当前页 URL + 动作后复核）；`tab_id` 入参语义（P1
//! 多标签，15 文档 §7）：close_tab/switch_tab 统一为**真实 targetId 字符串**
//! （browser_list_tabs 输出，撤销 MVP 序号语义）；new_tab 受 MAX_TABS=8 上限
//! 约束（可配 1-16，超限返回 `tool.browser.tab_limit_exceeded`，U-12 码）。

use crate::exec;
use crate::helpers;
use crate::tools::navigate_common::{
    close_tab_by_id, history_back, history_forward, navigate_current_tab, open_new_tab,
    parse_http_url, parse_tab_id, reject_bad_timeout_ms, reload_current_tab, switch_tab_by_id,
};
use crate::tools::{Ctx, TargetInfoLite};
use agent_tools::context::ToolContext;
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use serde_json::{json, Value};
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SessionOps;
    use crate::tools::navigate_common::{tool_ctx, tool_ctx_with_max, NavigateOps};
    use agent_tools::context::create_mock_tool_context;

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

    // ---------- P1 多标签（15 文档 §7）：MAX_TABS / targetId 语义 ----------

    /// MAX_TABS 上限（验收 9.1-9）：8 个标签已满时 new_tab 返回 tab_limit_exceeded
    /// （U-12 码），createTarget 零注入；关闭一个后可再开。
    #[tokio::test]
    async fn new_tab_rejects_when_at_max_tabs() {
        let ops = NavigateOps::with_tabs(
            "https://a.example/after",
            &["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"],
        );
        let ctx = tool_ctx(ops.clone(), "192.168.1.1");
        let tool = NewTabTool::new(ctx);
        let err = tool
            .execute(
                &create_mock_tool_context(),
                json!({ "url": "https://x.example/" }),
            )
            .await
            .expect_err("8 个标签已满应拒绝");
        assert_eq!(
            err.code(),
            "tool.browser.tab_limit_exceeded",
            "错误码：{err}"
        );
        assert!(
            err.to_string().contains("MAX_TABS=8"),
            "应携带上限值：{err}"
        );
        ops.assert_not_called("Target.createTarget");
    }

    /// MAX_TABS 上限可配（1-16）：max_tabs=2 时第 3 个标签被拒绝（注入计数 2）。
    #[tokio::test]
    async fn new_tab_limit_configurable_and_injection_counted() {
        let ops = NavigateOps::with_tabs("https://a.example/after", &["T1", "T2"]);
        let ctx = tool_ctx_with_max(ops.clone(), "192.168.1.1", 2);
        let tool = NewTabTool::new(ctx);
        let err = tool
            .execute(
                &create_mock_tool_context(),
                json!({ "url": "https://x.example/" }),
            )
            .await
            .expect_err("max_tabs=2 时第 3 个标签应拒绝");
        assert_eq!(err.code(), "tool.browser.tab_limit_exceeded");
        let injected = ops
            .calls()
            .iter()
            .filter(|c| c.contains("Target.createTarget"))
            .count();
        assert_eq!(injected, 0, "超限时 createTarget 零注入");
    }

    /// P1 缺陷 F2（K6 实测修复）：new_tab 后显式 attach 接线——命令序列
    /// createTarget → attachToTarget(flatten) → 域 enable（对齐恢复路径
    /// enable_domains 顺序：Page/setLifecycle/Runtime/DOM/Network）→
    /// runIfWaitingForDebugger；新标签会话可路由（tab_session 命中）且
    /// 成为活动标签（current_tab 命中，createTarget 聚焦语义）。
    #[tokio::test]
    async fn new_tab_attaches_session_and_routes() {
        let ops = NavigateOps::new("https://a.example/after");
        let ctx = tool_ctx(ops.clone(), "192.168.1.1");
        let out = NewTabTool::new(ctx)
            .execute(
                &create_mock_tool_context(),
                json!({ "url": "https://x.example/" }),
            )
            .await
            .expect("新建标签应成功");
        assert_eq!(out["tabId"], "T9");

        // 命令序列顺序：createTarget → attachToTarget → enable 序列
        let calls = ops.calls();
        let pos = |needle: &str| {
            calls
                .iter()
                .position(|c| c.contains(needle))
                .unwrap_or_else(|| panic!("应派发 {needle}：{calls:?}"))
        };
        let p_create = pos("Target.createTarget");
        let p_attach = pos("Target.attachToTarget");
        let p_page = pos("page:S-T9:Page.enable");
        let p_life = pos("page:S-T9:Page.setLifecycleEventsEnabled");
        let p_runtime = pos("page:S-T9:Runtime.enable");
        let p_dom = pos("page:S-T9:DOM.enable");
        let p_net = pos("page:S-T9:Network.enable");
        let p_resume = pos("page:S-T9:Runtime.runIfWaitingForDebugger");
        assert!(
            p_create < p_attach
                && p_attach < p_page
                && p_page < p_life
                && p_life < p_runtime
                && p_runtime < p_dom
                && p_dom < p_net
                && p_net < p_resume,
            "attach/enable 序列顺序错误：{calls:?}"
        );
        // attachToTarget 参数面（flatten:true + 目标 targetId；JSON 键序与
        // serde Value 序列化一致，逐字段断言防键序耦合）
        let attach_call = calls
            .iter()
            .find(|c| c.contains("browser:Target.attachToTarget"))
            .expect("应派发 attachToTarget")
            .clone();
        assert!(
            attach_call.contains("\"targetId\":\"T9\"") && attach_call.contains("\"flatten\":true"),
            "attachToTarget 参数错误：{attach_call}"
        );

        // 新标签会话可路由 + 成为活动标签（F2 修复面：不再 node_gone）
        let routed = ops.tab_session("T9").expect("新标签应可路由");
        assert_eq!(routed.session, "S-T9");
        let current = ops.current_tab().expect("应有活动标签");
        assert_eq!(
            current.target_id, "T9",
            "新标签应为活动标签（createTarget 聚焦语义）"
        );

        // H4 复核面不受 attach 影响：最终 URL 收敛返回
        assert_eq!(out["finalUrl"], "https://a.example/after");
    }

    /// F2 回滚面：attach 失败（attachToTarget 未返回 sessionId）→ 关闭已创建
    /// 标签（不遗留无会话标签）+ 返回错误；createTarget 已注入。
    #[tokio::test]
    async fn new_tab_closes_tab_when_attach_fails() {
        // attachToTarget 应答缺失 sessionId：驱动侧默认实现判定失败
        let ops = NavigateOps::new("https://a.example/after");
        *ops.attach_broken.lock().unwrap_or_else(|p| p.into_inner()) = true;
        let ctx = tool_ctx(ops.clone(), "192.168.1.1");
        let err = NewTabTool::new(ctx)
            .execute(
                &create_mock_tool_context(),
                json!({ "url": "https://x.example/" }),
            )
            .await
            .expect_err("attach 失败应报错");
        assert_eq!(err.code(), "tool.execution_failed", "错误码：{err}");
        ops.assert_called("Target.createTarget");
        ops.assert_called("browser:Target.closeTarget {\"targetId\":\"T9\"}");
    }

    /// close_tab 按 targetId（字符串语义，P1）：命中目标 → closeTarget 派发；
    /// 目标不存在（target destroyed 后）→ node_gone（目标过期语义）。
    #[tokio::test]
    async fn close_tab_by_target_id_and_missing() {
        let ops = NavigateOps::with_tabs("https://a.example/after", &["T1", "T2"]);
        let ctx = tool_ctx(ops.clone(), "192.168.1.1");
        let out = CloseTabTool::new(ctx.clone())
            .execute(&create_mock_tool_context(), json!({ "tab_id": "T2" }))
            .await
            .expect("按 targetId 关闭应成功");
        assert_eq!(out["closedTabId"], "T2");
        ops.assert_called("Target.closeTarget {\"targetId\":\"T2\"}");

        // 已关闭/不存在的标签 → node_gone（不派发 closeTarget）
        let err = CloseTabTool::new(ctx)
            .execute(&create_mock_tool_context(), json!({ "tab_id": "T9" }))
            .await
            .expect_err("不存在的标签应 node_gone");
        assert_eq!(err.code(), "tool.browser.node_gone", "错误码：{err}");
        ops.assert_not_called("Target.closeTarget {\"targetId\":\"T9\"}");
    }

    /// switch_tab 按 targetId：activateTarget 派发 + 引擎活动槽显式切换
    /// （activate_tab）+ 目标标签版本即时推进（note_action_done，R-1）。
    #[tokio::test]
    async fn switch_tab_by_target_id_updates_active_and_bumps() {
        let ops = NavigateOps::with_tabs("https://a.example/after", &["T1", "T2"]);
        let ctx = tool_ctx(ops.clone(), "192.168.1.1");
        let out = SwitchTabTool::new(ctx)
            .execute(&create_mock_tool_context(), json!({ "tab_id": "T2" }))
            .await
            .expect("按 targetId 切换应成功");
        assert_eq!(out["tabId"], "T2");
        ops.assert_called("Target.activateTarget {\"targetId\":\"T2\"}");
        ops.assert_called("activate-tab:T2");
        ops.assert_called("bump:T2");

        // 目标不存在 → node_gone，不派发 activateTarget
        let err = SwitchTabTool::new(tool_ctx(ops.clone(), "192.168.1.1"))
            .execute(&create_mock_tool_context(), json!({ "tab_id": "T9" }))
            .await
            .expect_err("不存在的标签应 node_gone");
        assert_eq!(err.code(), "tool.browser.node_gone", "错误码：{err}");
        ops.assert_not_called("Target.activateTarget {\"targetId\":\"T9\"}");
    }

    /// tab_id 入参护栏：空串/超长/控制字符 → invalid_input（不派发任何命令）。
    #[tokio::test]
    async fn tab_id_argument_guards() {
        let ops = NavigateOps::with_tabs("https://a.example/after", &["T1"]);
        let ctx = tool_ctx(ops.clone(), "192.168.1.1");
        for bad in ["", "x".repeat(300).as_str(), "a\u{0}b"] {
            let err = SwitchTabTool::new(ctx.clone())
                .execute(&create_mock_tool_context(), json!({ "tab_id": bad }))
                .await
                .expect_err("非法 tab_id 应拒绝");
            assert_eq!(err.code(), "tool.invalid_input", "tab_id={bad:?}");
        }
        ops.assert_not_called("Target.activateTarget");
        ops.assert_not_called("Target.closeTarget");
    }
}
