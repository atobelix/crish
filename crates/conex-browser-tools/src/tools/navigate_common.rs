//! 导航公共逻辑：URL 校验、动作后门禁复核、重定向轮询收敛。
//!
//! 供 navigate / new_tab / close_tab / switch_tab / back / forward / reload
//! 调用；工具体只保留参数解析与本模块调用。

use crate::error;
use crate::exec;
use crate::helpers;
use crate::session::SessionOps;
use crate::tools::{
    page_targets, target_info, validate_tab_id, Ctx, TargetInfoLite, CDP_PAGE_GO_BACK,
    CDP_PAGE_GO_FORWARD, CDP_PAGE_NAVIGATE, CDP_PAGE_RELOAD, CDP_TARGET_ACTIVATE_TARGET,
    CDP_TARGET_CLOSE_TARGET, CDP_TARGET_CREATE_TARGET,
};
use agent_tools::definition::ToolError;
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;

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

/// 目标 URL 入参：必填 + 仅 http/https（about:blank/about:newtab 特例）。
pub(crate) fn parse_http_url(args: &Value) -> Result<Url, ToolError> {
    helpers::validate_http_url(&helpers::require_string(args, "url")?)
}

/// 可选 timeout_ms 护栏（1..120000）；通过后调用方不消费该值（现行为：仅校验）。
pub(crate) fn reject_bad_timeout_ms(args: &Value) -> Result<(), ToolError> {
    if let Some(t) = helpers::optional_u32(args, "timeout_ms")? {
        if t == 0 || t > 120_000 {
            return Err(ToolError::invalid_input(
                "timeout_ms 超出范围（1..120000 毫秒）",
            ));
        }
    }
    Ok(())
}

/// tab_id 入参：必填 + targetId 护栏（非空、≤256、无控制字符）。
pub(crate) fn parse_tab_id(args: &Value) -> Result<String, ToolError> {
    let tab_id = helpers::require_string(args, "tab_id")?;
    validate_tab_id(&tab_id, "tab_id")?;
    Ok(tab_id)
}

/// 当前页 URL 过导航检查点（back/forward/reload 发送前）。
async fn check_current_page_url(
    ctx: &Ctx,
    ops: &dyn SessionOps,
    target_id: &str,
) -> Result<Option<String>, ToolError> {
    let (_, before) = target_info(ops, target_id).await?;
    if let Some(u) = &before {
        exec::check_navigation_url(ctx.gate.as_ref(), u)?;
    }
    Ok(before)
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
                if let Err(e) = ops
                    .send_page(&tab.session, CDP_PAGE_GO_BACK, json!({}))
                    .await
                {
                    tracing::warn!("门禁拒绝后 GoBack 回退失败（页面停留在违规 URL）：{e}");
                }
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
    let mut info = target_info(ops, target_id).await?;
    if poll {
        for _ in 0..REDIRECT_POLLS {
            if info.1.as_deref() == Some(requested) {
                tokio::time::sleep(REDIRECT_POLL_INTERVAL).await;
                info = target_info(ops, target_id).await?;
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
                    if let Err(e) = ops.send_page(session, CDP_PAGE_GO_BACK, json!({})).await {
                        tracing::warn!("门禁拒绝后 GoBack 回退失败（页面停留在违规 URL）：{e}");
                    }
                    "已回退到上一页面"
                }
                AfterRollback::CloseTab { target_id } => {
                    if let Err(e) = ops
                        .send_browser(CDP_TARGET_CLOSE_TARGET, json!({ "targetId": target_id }))
                        .await
                    {
                        tracing::warn!("门禁拒绝后关闭新标签页失败（标签遗留）：{e}");
                    }
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

/// 标签 targetId（targetId 字符串语义，P1）→ 目标信息。
/// 未找到（标签已关闭/不存在）→ node_gone（目标过期，14 §5.1 同源）。
async fn target_by_id(ops: &dyn SessionOps, tab_id: &str) -> Result<TargetInfoLite, ToolError> {
    let targets = page_targets(ops).await?;
    match targets.into_iter().find(|t| t.target_id == tab_id) {
        Some(target) => Ok(target),
        None => Err(error::node_gone(format!(
            "标签 {tab_id} 不存在或已关闭（请先 browser_list_tabs 确认后重试）"
        ))),
    }
}

/// 导航当前标签：门禁先行 → Page.navigate → errorText 检查 → H4 复核。
pub(crate) async fn navigate_current_tab(
    ctx: &Ctx,
    ops: &dyn SessionOps,
    url: &Url,
) -> Result<Value, ToolError> {
    // 导航检查点（17 §4.4）：Page.navigate 发送之前
    exec::check_navigation_url(ctx.gate.as_ref(), url.as_str())?;
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
        ctx,
        ops,
        &tab.target_id,
        url.as_str(),
        false,
        AfterRollback::GoBack {
            session: &tab.session,
        },
    )
    .await?;
    Ok(json!({
        "ok": true,
        "url": actual.unwrap_or_else(|| url.to_string()),
        "title": title.unwrap_or_default(),
        "snapshotVersion": ops.snapshot_version(&tab.target_id),
    }))
}

/// back/forward 共用：当前页门禁 → 历史命令 → 动作后复核。
async fn run_history_step(
    ctx: &Ctx,
    ops: &dyn SessionOps,
    method: &'static str,
) -> Result<Value, ToolError> {
    let tab = ops.current_tab()?;
    let before = check_current_page_url(ctx, ops, &tab.target_id).await?;
    ops.send_page(&tab.session, method, json!({})).await?;
    let (title, after) = target_info(ops, &tab.target_id).await?;
    verify_after_navigation(ctx, ops, &tab, before.as_deref(), after.as_deref()).await?;
    Ok(json!({
        "ok": true,
        "url": after.unwrap_or_default(),
        "title": title.unwrap_or_default(),
        "snapshotVersion": ops.snapshot_version(&tab.target_id),
    }))
}

pub(crate) async fn history_back(ctx: &Ctx, ops: &dyn SessionOps) -> Result<Value, ToolError> {
    run_history_step(ctx, ops, CDP_PAGE_GO_BACK).await
}

pub(crate) async fn history_forward(ctx: &Ctx, ops: &dyn SessionOps) -> Result<Value, ToolError> {
    run_history_step(ctx, ops, CDP_PAGE_GO_FORWARD).await
}

/// 刷新当前页：当前页门禁 → Page.reload → 动作后复核（输出不含 snapshotVersion）。
pub(crate) async fn reload_current_tab(
    ctx: &Ctx,
    ops: &dyn SessionOps,
    ignore_cache: bool,
) -> Result<Value, ToolError> {
    let tab = ops.current_tab()?;
    let before = check_current_page_url(ctx, ops, &tab.target_id).await?;
    ops.send_page(
        &tab.session,
        CDP_PAGE_RELOAD,
        json!({ "ignoreCache": ignore_cache }),
    )
    .await?;
    let (title, after) = target_info(ops, &tab.target_id).await?;
    verify_after_navigation(ctx, ops, &tab, before.as_deref(), after.as_deref()).await?;
    Ok(json!({
        "ok": true,
        "url": after.unwrap_or_default(),
        "title": title.unwrap_or_default(),
    }))
}

/// 新建标签：MAX_TABS → 门禁 → createTarget → attach（失败关页回滚）→ H4 轮询复核。
pub(crate) async fn open_new_tab(
    ctx: &Ctx,
    ops: &dyn SessionOps,
    url: &Url,
) -> Result<Value, ToolError> {
    // MAX_TABS 上限（15 文档 §7.3 裁决 + U-12 码）：createTarget 之前计数
    // 注入检查——超限返回 tab_limit_exceeded，不派发任何命令
    let current = page_targets(ops).await?.len();
    if current >= ctx.max_tabs {
        return Err(error::tab_limit_exceeded(ctx.max_tabs));
    }
    // 导航检查点（17 §4.4）：Target.createTarget 发送之前
    exec::check_navigation_url(ctx.gate.as_ref(), url.as_str())?;
    let value = ops
        .send_browser(CDP_TARGET_CREATE_TARGET, json!({ "url": url.as_str() }))
        .await?;
    let tab_id = value
        .get("targetId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ToolError::execution_failed("browser_new_tab", "createTarget 未返回 targetId")
        })?;
    // P1 缺陷 F2（K6 实测，2026-08）：Chrome 151 的 createTarget **不触发
    // attachedToTarget 事件** → 新标签无 CDP 会话 → per-tab 快照/动作
    // node_gone。修复：createTarget 后显式 attach_tab（attachToTarget
    // flatten:true + 域 enable，对齐恢复路径 enable_domains 顺序）——
    // 会话经 BrowserSession 确定性登记（RealSession）或 attachedToTarget
    // 事件落地（驱动侧默认实现），随后 H4 复核与用户操作即可路由。
    // 活动标签语义：新标签**成为活动标签**（createTarget 默认聚焦新标签，
    // background 参数 MVP 忽略；与 SessionAttached「最新附着者即活动」一致），
    // 无需 switch 即可直接操作。attach 失败（目标已关闭等）→ 关闭已创建
    // 标签回滚（不遗留无会话标签）并返回错误。
    if let Err(e) = ops.attach_tab(tab_id).await {
        if let Err(rb) = ops
            .send_browser(CDP_TARGET_CLOSE_TARGET, json!({ "targetId": tab_id }))
            .await
        {
            tracing::warn!(
                "attach 失败回滚：关闭新标签页失败（可能遗留无会话标签）：{rb}（attach 错误：{e}）"
            );
        }
        return Err(e);
    }
    // H4 动作后门禁复核：createTarget 返回时新页导航仍在途，302 重定向
    // 可能把白名单内 URL 带往内网/保留段——轮询收敛最终 URL 后复核，
    // 违例关闭新标签并返回 gate_blocked
    let (_, actual) = verify_navigate_after(
        ctx,
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

pub(crate) async fn close_tab_by_id(
    ops: &dyn SessionOps,
    tab_id: &str,
) -> Result<Value, ToolError> {
    let target = target_by_id(ops, tab_id).await?;
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
    let remaining = page_targets(ops).await?.len();
    Ok(json!({
        "ok": true,
        "closedTabId": target.target_id,
        "remainingTabs": remaining,
    }))
}

pub(crate) async fn switch_tab_by_id(
    ops: &dyn SessionOps,
    tab_id: &str,
) -> Result<Value, ToolError> {
    let target = target_by_id(ops, tab_id).await?;
    ops.send_browser(
        CDP_TARGET_ACTIVATE_TARGET,
        json!({ "targetId": &target.target_id }),
    )
    .await?;
    // P1：activateTarget 无 SessionAttached 事件——引擎活动槽显式切换；
    // 失败（路由表无该标签）→ node_gone（目标过期）
    ops.activate_tab(tab_id)?;
    // R-1：切换本身是 AI 动作——目标标签即时 +1（旧快照失效 → 强制重快照，
    // 15 §7.2「AI 主动切换不吊销令牌，动作前按需重快照」）
    ops.note_action_done(tab_id);
    let (title, url) = target_info(ops, &target.target_id).await?;
    Ok(json!({
        "ok": true,
        "tabId": target.target_id,
        "url": url.unwrap_or_default(),
        "title": title.unwrap_or_default(),
        "snapshotVersion": ops.snapshot_version(&target.target_id),
    }))
}

#[cfg(test)]
pub(crate) use self::fixtures::{tool_ctx, tool_ctx_with_max, NavigateOps};

#[cfg(test)]
mod fixtures {
    use super::*;
    use crate::session::{ConsoleEntry, NetworkEntry, SnapshotView};
    use async_trait::async_trait;
    use conex_browser::action::gate::{DomainGate, GateDenial};
    use conex_browser::action::{
        ActionError, ActionRequest, ActionSuccess, ElementMeta, WaitCondition, WaitOptions,
    };
    use conex_browser::snapshot::budget::BudgetConfig;
    use conex_browser::SessionRef;
    use std::sync::{Arc, Mutex};

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
    /// （模拟 302 重定向后的落地 URL）+ 可配 page 目标列表（MAX_TABS 计数面）。
    /// F2 面：attachToTarget 应答会话并模拟事件驱动登记（created 活动标签
    /// 语义——attach 后 current_tab/tab_session 命中新标签）。
    pub(crate) struct NavigateOps {
        log: Mutex<Vec<String>>,
        info_url: String,
        tab_ids: Mutex<Vec<String>>,
        created: Mutex<Option<String>>,
        /// F2 回滚面开关：attachToTarget 应答缺失 sessionId（模拟 attach 失败）
        pub(crate) attach_broken: Mutex<bool>,
    }

    impl NavigateOps {
        pub(crate) fn new(info_url: &str) -> Arc<Self> {
            Arc::new(NavigateOps {
                log: Mutex::new(Vec::new()),
                info_url: info_url.to_string(),
                tab_ids: Mutex::new(Vec::new()),
                created: Mutex::new(None),
                attach_broken: Mutex::new(false),
            })
        }
        pub(crate) fn with_tabs(info_url: &str, tab_ids: &[&str]) -> Arc<Self> {
            let ops = NavigateOps::new(info_url);
            *ops.tab_ids.lock().unwrap_or_else(|p| p.into_inner()) =
                tab_ids.iter().map(|t| t.to_string()).collect();
            ops
        }
        pub(crate) fn calls(&self) -> Vec<String> {
            self.log.lock().unwrap_or_else(|p| p.into_inner()).clone()
        }
        pub(crate) fn assert_called(&self, needle: &str) {
            assert!(
                self.calls().iter().any(|c| c.contains(needle)),
                "应调用 {needle}：{:?}",
                self.calls()
            );
        }
        pub(crate) fn assert_not_called(&self, needle: &str) {
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
            // F2：attach 后新标签成为活动标签（模拟事件驱动面 SessionAttached
            // 登记——createTarget 聚焦新标签 + 「最新附着者即活动」语义）
            if let Some(tid) = self
                .created
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone()
            {
                return Ok(SessionRef {
                    target_id: tid.clone(),
                    session: format!("S-{tid}"),
                });
            }
            Ok(SessionRef {
                target_id: "T1".to_string(),
                session: "S1".to_string(),
            })
        }
        fn tab_session(&self, tab_id: &str) -> Option<SessionRef> {
            // F2：新标签经 attach 后可路由（模拟事件登记落表；其余标签无路由）
            if self
                .created
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_deref()
                == Some(tab_id)
            {
                return Some(SessionRef {
                    target_id: tab_id.to_string(),
                    session: format!("S-{tab_id}"),
                });
            }
            None
        }
        fn activate_tab(&self, tab_id: &str) -> Result<(), ToolError> {
            self.log
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(format!("activate-tab:{tab_id}"));
            Ok(())
        }
        fn note_action_done(&self, tab_id: &str) {
            self.log
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(format!("bump:{tab_id}"));
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
                "Target.attachToTarget" => {
                    // F2：应答会话 + 模拟 attachedToTarget 事件驱动的登记
                    // （created 活动标签 + tab_session 路由命中）；
                    // attach_broken 时应答缺失 sessionId（回滚面）
                    let tid = params
                        .get("targetId")
                        .and_then(Value::as_str)
                        .unwrap_or("T9")
                        .to_string();
                    if *self.attach_broken.lock().unwrap_or_else(|p| p.into_inner()) {
                        return Ok(json!({}));
                    }
                    *self.created.lock().unwrap_or_else(|p| p.into_inner()) = Some(tid);
                    Ok(json!({ "sessionId": "S-T9" }))
                }
                "Target.getTargets" => {
                    let ids = self.tab_ids.lock().unwrap_or_else(|p| p.into_inner());
                    Ok(json!({
                        "targetInfos": ids.iter().map(|id| json!({
                            "targetId": id,
                            "type": "page",
                            "title": "页",
                            "url": "https://a.example/"
                        })).collect::<Vec<_>>()
                    }))
                }
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
    pub(crate) fn tool_ctx(ops: Arc<NavigateOps>, denied_host: &'static str) -> Arc<Ctx> {
        tool_ctx_with_max(ops, denied_host, 8)
    }

    pub(crate) fn tool_ctx_with_max(
        ops: Arc<NavigateOps>,
        denied_host: &'static str,
        max_tabs: usize,
    ) -> Arc<Ctx> {
        Arc::new(Ctx {
            session: Some(ops),
            gate: Arc::new(StubGate { denied_host }),
            sensitive: crate::SensitiveCapabilities::default(),
            budgets: BudgetConfig::active(),
            max_tabs,
        })
    }
}
