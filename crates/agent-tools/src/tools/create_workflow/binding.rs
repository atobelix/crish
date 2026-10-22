//! create_workflow 入参别名解析与会话绑定推导（自 create_workflow.rs 纯搬迁）

use super::{EXECUTION_MODE_CURRENT, EXECUTION_MODE_CURRENT_SESSION, EXECUTION_MODE_ISOLATED};
use crate::context::ToolContext;
use serde_json::Value;

/// 解析可选字符串参数（兼容主 key 与备选 alias key）
pub(super) fn optional_string_with_aliases(args: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(val) = super::optional_string(args, key) {
            return Some(val);
        }
    }
    None
}

/// 推导目标会话绑定与执行模式：
/// 返回 `(target_session_id, execution_mode, target_mode)`
pub(super) fn resolve_session_binding(
    ctx: &ToolContext,
    raw_exec_mode: Option<&str>,
    raw_target_sid: Option<&str>,
) -> (Option<String>, String, String) {
    let mode_norm = raw_exec_mode.map(str::trim).filter(|s| !s.is_empty());
    let target_trimmed = raw_target_sid.map(str::trim);

    // 1. 显式声明 execution_mode / targetMode 为 isolated
    if let Some(m) = mode_norm {
        if m.eq_ignore_ascii_case(EXECUTION_MODE_ISOLATED) || m.eq_ignore_ascii_case("independent")
        {
            return (
                None,
                EXECUTION_MODE_ISOLATED.to_string(),
                EXECUTION_MODE_ISOLATED.to_string(),
            );
        }
    }

    // 2. 显式传入 target_session_id / targetSessionId
    if let Some(t) = target_trimmed {
        if t.eq_ignore_ascii_case(EXECUTION_MODE_ISOLATED)
            || t.eq_ignore_ascii_case("independent")
            || t.eq_ignore_ascii_case("none")
        {
            return (
                None,
                EXECUTION_MODE_ISOLATED.to_string(),
                EXECUTION_MODE_ISOLATED.to_string(),
            );
        }
        if !t.is_empty() {
            return (
                Some(t.to_string()),
                EXECUTION_MODE_CURRENT_SESSION.to_string(),
                EXECUTION_MODE_CURRENT.to_string(),
            );
        }
        // target_session_id 显式传空串且未显式指定 current_session/current 时，视为 isolated
        let explicitly_current = mode_norm.is_some_and(|m| {
            m.eq_ignore_ascii_case(EXECUTION_MODE_CURRENT_SESSION)
                || m.eq_ignore_ascii_case(EXECUTION_MODE_CURRENT)
        });
        if !explicitly_current {
            return (
                None,
                EXECUTION_MODE_ISOLATED.to_string(),
                EXECUTION_MODE_ISOLATED.to_string(),
            );
        }
    }

    // 3. 在有效会话上下文中调用（或显式指定 current_session / current）→ 自动绑定 ctx.session_id
    let ctx_sid = ctx.session_id.trim();
    if !ctx_sid.is_empty() {
        (
            Some(ctx_sid.to_string()),
            EXECUTION_MODE_CURRENT_SESSION.to_string(),
            EXECUTION_MODE_CURRENT.to_string(),
        )
    } else {
        (
            None,
            EXECUTION_MODE_ISOLATED.to_string(),
            EXECUTION_MODE_ISOLATED.to_string(),
        )
    }
}
