//! 统一执行管线（17 §1.4 `run_browser_action` 的 MVP 子集）
//!
//! 完整六步（急停 → 门禁 → 权限 → 审批 → 执行 → 审计）中 MVP 落地：
//! ① 急停（ctx.abort_token 自查，17 §6.4 ①，`tool.browser.cancelled`）；
//! ② 会话就绪（27 方案 S1/D-B：`ensure_ready` 惰性启动/重连 + 同步
//!    `readiness` 恢复期 gating，R-9，`tool.browser.not_ready`）；
//! ③ 执行（导航面门禁由导航工具在发送前调 [check_navigation_url] 先行，§4.4；
//!    动作面门禁由 `ActionExecutor` 注入的门禁执行，§2.2 流水线第 1 步）。
//!
//! 留接线面（P1 补齐，17 §1.4 完整版）：
//! - ④ 权限判定/审批：dangerous 标记 + agent-tools 既有 PermissionMode 体系在
//!   执行器侧判定（本 crate 不改动）；工具层审批通道（ctx.ask）不在此管线拦截；
//! - ⑤ 审计出站（M-4，17 §6.1）：SecurityAuditSink 接线在引擎侧，MVP 以结构化
//!   tracing 日志占位（脱敏纪律：不落敏感值）。

use crate::error;
use crate::session::SessionOps;
use agent_tools::context::ToolContext;
use agent_tools::definition::ToolError;
use conex_browser::action::gate::DomainGate;
use std::sync::Arc;

/// 统一执行管线（MVP 简化）：急停 → 会话就绪 → 返回会话操作面。
///
/// 全部工具统一经本入口（17 §1.4「全部工具共用统一执行器」的 MVP 形态）；
/// 返回的 `&dyn SessionOps` 供工具体执行具体动作（门禁/动作面检查点在工具体或
/// ActionExecutor 内）。
pub(crate) async fn run_browser_action<'s>(
    ctx: &ToolContext,
    tool_name: &str,
    session: &'s Option<Arc<dyn SessionOps>>,
) -> Result<&'s dyn SessionOps, ToolError> {
    // ① 急停检查（17 §6.4 ①）：中止令牌已触发 → 结构化 cancelled，不执行
    if ctx.abort_token.is_aborted() {
        return Err(error::cancelled());
    }
    // ② 会话就绪（R-9 gating + 27 方案 S1/D-B）：ensure_ready 为惰性会话
    //    入口（引擎侧 LazySessionOps：未启动则启动、端点漂移则重连，M-2
    //    桥会话面）；readiness 保留恢复期（Launching/Crashed/Stopping）
    //    同步 gating——两层串行，工具面 23 个工具零改动
    let ops = session
        .as_ref()
        .ok_or_else(|| error::not_ready("浏览器会话未注入（BrowserToolsConfig.session）"))?;
    ops.ensure_ready().await.map_err(error::not_ready)?;
    ops.readiness().map_err(error::not_ready)?;
    // ③ 执行（④审批/⑤审计留接线，见模块头）
    tracing::debug!(tool = tool_name, session = %ctx.session_id, "browser 工具执行");
    Ok(ops.as_ref())
}

/// 导航检查点（17 §4.4）：CDP 导航命令发送前对目标 URL 全流程校验。
pub(crate) fn check_navigation_url(gate: &dyn DomainGate, url: &str) -> Result<(), ToolError> {
    gate.check(url)
        .map_err(|d| error::gate_blocked(&d.url, &d.reason))
}
