//! 命令安全裁决：权限三态与门禁地板。
//!
//! `permission_of` / `floor_of` 写成自由函数，不写 `impl crate::assess::Assessment`。
//! 同 crate 的固有 impl 并不违反孤儿规则（孤儿规则只约束 trait impl），
//! 但 Assessment 定义在 `assess`。把方法挂到该类型上会让裁决逻辑脱离本模块。
//! 自由函数只读公开字段，调用处使用完整路径。
//!
//! 字段按即将落地的 `crate::assess::Assessment` 读取（本文件不定义该类型）：
//! `redline`、`approval`、`overall`、`segments[].class`、`has_indirect_delete`、`delete_targets`。

use serde::{Deserialize, Serialize};

/// 红线原因。文案是静态字符串，审计日志经 [`RedlineReason::as_str`] 引用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedlineReason {
    message: &'static str,
}

impl RedlineReason {
    /// 跨模块构造入口。`message` 保持私有，避免调用方改写已发布的原因。
    pub const fn new(message: &'static str) -> Self {
        Self { message }
    }

    pub fn as_str(&self) -> &str {
        self.message
    }
}

/// 工作区上下文。cwd 是否落在 workspace_root 内，按路径成分比较。
#[derive(Debug, Clone, Copy)]
pub struct WorkspaceCtx<'a> {
    pub cwd: &'a str,
    pub workspace_root: &'a str,
}

/// 门禁对调用方暴露的三态。`Blocked` 永不降级。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GatekeeperResult {
    Allowed,
    Blocked,
    RequiresApproval,
}

/// 单条命令的权限裁决。优先级：红线拒绝 > 审批列表第一条 > 放行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionVerdict {
    Allow,
    RequireApproval(crate::classify::ApprovalReason),
    Deny(RedlineReason),
}

/// 红线优先；否则取 `approval` 第一条；都没有则放行。
pub(crate) fn permission_of(assessment: &crate::assess::Assessment) -> PermissionVerdict {
    if let Some(reason) = assessment.redline.clone() {
        return PermissionVerdict::Deny(reason);
    }
    if let Some(reason) = assessment.approval.first() {
        return PermissionVerdict::RequireApproval(reason.clone());
    }
    PermissionVerdict::Allow
}

/// 语义裁决、静态正则与工作区上下文合成门禁地板。
///
/// - `pattern_error` 有值、`redline` 有值，或 blocked 正则命中 → [`GatekeeperResult::Blocked`]
/// - 否则整体或任一段为 Dangerous、间接删除、`Indirect` 且删除目标非空、或 approval 正则命中
///   → [`GatekeeperResult::RequiresApproval`]
/// - 否则 [`GatekeeperResult::Allowed`]
/// - `ctx.cwd` 不在 `ctx.workspace_root` 内且当前结果是 Allowed 时，升为 RequiresApproval
/// - Blocked 在升档判断之前返回，永不降级
pub(crate) fn floor_of(
    assessment: &crate::assess::Assessment,
    pattern_error: Option<&str>,
    blocked_hit: bool,
    approval_hit: bool,
    ctx: Option<WorkspaceCtx<'_>>,
) -> GatekeeperResult {
    if pattern_error.is_some() || assessment.redline.is_some() || blocked_hit {
        return GatekeeperResult::Blocked;
    }

    let overall_dangerous = matches!(
        &assessment.overall,
        crate::classify::CommandClass::Dangerous
    );
    let segment_dangerous = assessment
        .segments
        .iter()
        .any(|segment| matches!(&segment.class, crate::classify::CommandClass::Dangerous));
    let indirect_with_targets =
        matches!(&assessment.overall, crate::classify::CommandClass::Indirect)
            && !assessment.delete_targets.is_empty();
    let dangerous = overall_dangerous
        || segment_dangerous
        || assessment.has_indirect_delete
        || indirect_with_targets
        || approval_hit;

    let result = if dangerous {
        GatekeeperResult::RequiresApproval
    } else {
        GatekeeperResult::Allowed
    };

    if let Some(ctx) = ctx {
        if result == GatekeeperResult::Allowed
            && !path_within_workspace(ctx.cwd, ctx.workspace_root)
        {
            return GatekeeperResult::RequiresApproval;
        }
    }
    result
}

/// 路径成分级包含。先把 `\` 换成 `/`，再做 ASCII 小写（不做 Unicode 大小写折叠）。
/// 空成分忽略。`C:/project_evil` 与 `C:/project` 不是同一成分，不算包含。
fn path_within_workspace(cwd: &str, workspace_root: &str) -> bool {
    let cwd_key = normalize_path_key(cwd);
    let root_key = normalize_path_key(workspace_root);
    let cwd_parts = path_parts(&cwd_key);
    let root_parts = path_parts(&root_key);
    cwd_parts.len() >= root_parts.len() && cwd_parts[..root_parts.len()] == root_parts[..]
}

fn normalize_path_key(path: &str) -> String {
    path.replace('\\', "/").to_ascii_lowercase()
}

fn path_parts(normalized: &str) -> Vec<&str> {
    normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .collect()
}
