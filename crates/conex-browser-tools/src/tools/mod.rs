//! 工具族注册清单与共享面（维度 17 §1.2 工具总表，MVP 子集 23 个）
//!
//! 命名空间隔离（17 §5.1）：自研工具统一 `browser_*` 前缀，与 MCP 桥
//! `mcp_<server>__*` 天然互斥（registry.rs 同名返回 `tool.version_conflict` 的保护
//! 同样生效）；注册次序与 MCP 工具无依赖（`register_runtime` 幂等跳过已并入的同名项）。
//!
//! MVP 子集（R-13 §8.2 第 7 项「browser_* 工具子集」）：
//! - 导航 8：navigate/back/forward/reload/list_tabs/new_tab/close_tab/switch_tab；
//! - 感知 5：snapshot/screenshot/wait_for/get_url/get_title；
//! - 交互 8（全 dangerous=true）：click/type/key/scroll/hover/drag/select_option/upload；
//! - 调试 2（只读）：console/network。
//!
//! 未注册（MVP 边界）：browser_evaluate（17 §3 白名单面 P1 落地；执行路径未接线
//! 错误构造见 `error::unwired`）与剪贴板 2（面板 UI 桥，M-7，P1）。

pub(crate) mod debug;
pub(crate) mod eval;
pub(crate) mod interact;
pub(crate) mod navigate;
pub(crate) mod sense;

use crate::error;
use crate::session::SessionOps;
use agent_tools::definition::{Tool, ToolError};
use agent_tools::registry::ToolRegistry;
use conex_browser::action::gate::DomainGate;
use conex_browser::action::ElementRef;
use conex_browser::snapshot::budget::BudgetConfig;
use conex_browser::SessionRef;
use serde_json::{json, Value};
use std::sync::Arc;

// CDP 方法名（本 crate 常量面；与 conex-browser cdp::domains::names 互补）
pub(crate) const CDP_PAGE_NAVIGATE: &str = "Page.navigate";
pub(crate) const CDP_PAGE_GO_BACK: &str = "Page.goBack";
pub(crate) const CDP_PAGE_GO_FORWARD: &str = "Page.goForward";
pub(crate) const CDP_PAGE_RELOAD: &str = "Page.reload";
pub(crate) const CDP_PAGE_CAPTURE_SCREENSHOT: &str = "Page.captureScreenshot";
pub(crate) const CDP_TARGET_GET_TARGETS: &str = "Target.getTargets";
pub(crate) const CDP_TARGET_GET_TARGET_INFO: &str = "Target.getTargetInfo";
pub(crate) const CDP_TARGET_CREATE_TARGET: &str = "Target.createTarget";
pub(crate) const CDP_TARGET_CLOSE_TARGET: &str = "Target.closeTarget";
pub(crate) const CDP_TARGET_ACTIVATE_TARGET: &str = "Target.activateTarget";

/// 标签目标信息（Target.getTargets/getTargetInfo 消费面；MVP 自建反序列化，
/// 不依赖 conex-browser 内部域结构，防跨 crate 内部面耦合）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TargetInfoLite {
    pub target_id: String,
    #[serde(rename = "type")]
    pub target_type: String,
    pub title: String,
    pub url: String,
}

/// Target.getTargets 结果消费面。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GetTargetsLite {
    pub target_infos: Vec<TargetInfoLite>,
}

/// 工具共享上下文（会话 + 门禁 + 能力位 + 预算；register 时构造注入各工具）。
pub(crate) struct Ctx {
    pub session: Option<Arc<dyn SessionOps>>,
    pub gate: Arc<dyn DomainGate>,
    pub sensitive: crate::SensitiveCapabilities,
    pub budgets: BudgetConfig,
    /// 标签数量上限（15 文档 §7.3 MAX_TABS 裁决：默认 8，可配 1-16；
    /// 超限 new_tab 返回 `tool.browser.tab_limit_exceeded`，U-12 码）
    pub max_tabs: usize,
}

/// 注册全部 browser_* 工具（幂等：同名重复注册跳过，17 §1.4）。
pub(crate) fn register_all(registry: &ToolRegistry, ctx: Arc<Ctx>) -> Result<(), ToolError> {
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(navigate::NavigateTool::new(ctx.clone())),
        Arc::new(navigate::BackTool::new(ctx.clone())),
        Arc::new(navigate::ForwardTool::new(ctx.clone())),
        Arc::new(navigate::ReloadTool::new(ctx.clone())),
        Arc::new(navigate::ListTabsTool::new(ctx.clone())),
        Arc::new(navigate::NewTabTool::new(ctx.clone())),
        Arc::new(navigate::CloseTabTool::new(ctx.clone())),
        Arc::new(navigate::SwitchTabTool::new(ctx.clone())),
        Arc::new(sense::SnapshotTool::new(ctx.clone())),
        Arc::new(sense::ScreenshotTool::new(ctx.clone())),
        Arc::new(sense::WaitForTool::new(ctx.clone())),
        Arc::new(sense::GetUrlTool::new(ctx.clone())),
        Arc::new(sense::GetTitleTool::new(ctx.clone())),
        Arc::new(interact::ClickTool::new(ctx.clone())),
        Arc::new(interact::TypeTool::new(ctx.clone())),
        Arc::new(interact::KeyTool::new(ctx.clone())),
        Arc::new(interact::ScrollTool::new(ctx.clone())),
        Arc::new(interact::HoverTool::new(ctx.clone())),
        Arc::new(interact::DragTool::new(ctx.clone())),
        Arc::new(interact::SelectOptionTool::new(ctx.clone())),
        Arc::new(interact::UploadTool::new(ctx.clone())),
        Arc::new(debug::ConsoleTool::new(ctx.clone())),
        Arc::new(debug::NetworkTool::new(ctx.clone())),
        Arc::new(eval::EvaluateTool::new(ctx.clone())),
    ];
    for tool in tools {
        if !registry.has(tool.name()) {
            registry.register_runtime(tool)?;
        }
    }
    Ok(())
}

/// 页面类型目标列表（Target.getTargets → 过滤 page；列表序 = tab_id 序号语义）。
pub(crate) async fn page_targets(ops: &dyn SessionOps) -> Result<Vec<TargetInfoLite>, ToolError> {
    let value = ops.send_browser(CDP_TARGET_GET_TARGETS, json!({})).await?;
    let result: GetTargetsLite = serde_json::from_value(value).map_err(|e| {
        ToolError::execution_failed("browser_list_tabs", format!("getTargets 结果解析失败：{e}"))
    })?;
    Ok(result
        .target_infos
        .into_iter()
        .filter(|t| t.target_type == "page")
        .collect())
}

/// 目标实时信息（标题 + URL；Target.getTargetInfo）。
pub(crate) async fn target_info(
    ops: &dyn SessionOps,
    target_id: &str,
) -> Result<(Option<String>, Option<String>), ToolError> {
    let value = ops
        .send_browser(CDP_TARGET_GET_TARGET_INFO, json!({ "targetId": target_id }))
        .await?;
    let info = value.get("targetInfo");
    let title = info
        .and_then(|t| t.get("title"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let url = info
        .and_then(|t| t.get("url"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok((title, url))
}

/// 快照索引 → 元素引用（共享缓存解析；无缓存快照 → stale_snapshot，
/// 索引缺失 → node_gone，17 §1.3 码表）。
pub(crate) fn resolve_ref(
    ops: &dyn SessionOps,
    tab: &SessionRef,
    index: u64,
) -> Result<ElementRef, ToolError> {
    if index >= u64::from(u32::MAX) {
        return Err(ToolError::invalid_input(format!(
            "ref 超出快照索引范围：{index}"
        )));
    }
    let version = ops.snapshot_version(&tab.target_id);
    match ops.element_meta(&tab.target_id, version, index as u32)? {
        Some(meta) => Ok(ElementRef {
            index: index as usize,
            backend_node_id: meta.backend_node_id,
        }),
        None => Err(error::node_gone(format!(
            "快照索引 [{index}] 在当前快照（v{version}）中不存在（元素过期，请重新快照）"
        ))),
    }
}

// —— P1 多标签：tab_id（targetId 语义）路由辅助面 ——

/// tab_id 入参校验（targetId 字符串：非空、长度 ≤ 256、无控制字符护栏）。
pub(crate) fn validate_tab_id(tab_id: &str, what: &str) -> Result<(), ToolError> {
    if tab_id.is_empty() || tab_id.chars().count() > 256 {
        return Err(ToolError::invalid_input(format!(
            "{what} 非法（targetId 非空且 ≤ 256 字符）"
        )));
    }
    crate::helpers::validate_no_control_chars(tab_id, what)
}

/// 目标标签会话解析（P1 多标签统一入口，15 §7.1）：
/// - 缺省（None）= 当前活动标签（MVP 语义向后兼容）；
/// - 指定 tab_id（targetId 语义）= 经会话路由表解析——标签已关闭/未 attach
///   → `tool.browser.node_gone`（目标过期，14 §5.1 TargetClosed 同源）。
pub(crate) fn resolve_tab(
    ops: &dyn SessionOps,
    tab_id: Option<&str>,
) -> Result<SessionRef, ToolError> {
    match tab_id {
        None => ops.current_tab(),
        Some(id) => ops.tab_session(id).ok_or_else(|| {
            error::node_gone(format!(
                "标签 {id} 不存在或已关闭（请先 browser_list_tabs 确认后重试）"
            ))
        }),
    }
}
