//! 唯一分析入口。一次拆段，合并语义分类与智能裁决。
//!
//! 红线只来自语义分类或智能拒绝理由。静态正则命中只影响门禁地板
//! （[`Assessment::floor_verdict`]），不改变权限裁决。

use crate::classify::{classify_semantics, redline, smart_decision, ApprovalReason, CommandClass};
use crate::verdict::{GatekeeperResult, PermissionVerdict, RedlineReason, WorkspaceCtx};

pub use crate::classify::Segment;

const SEMANTICS_REDLINE: &str =
    "系统毁灭性操作已被安全策略严格阻断（Redline）：语义分类判定为确定性毁灭目标";

/// 整行命令的一次分析结果。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Assessment {
    pub segments: Vec<Segment>,
    pub overall: CommandClass,
    pub redline: Option<RedlineReason>,
    pub approval: Vec<ApprovalReason>,
    pub pure_read_only: bool,
    pub delete_targets: Vec<String>,
    pub has_indirect_delete: bool,
    pub git_revert_forms: Vec<String>,
    pub decoded_payload: Option<String>,
    /// 原始命令行。地板裁决用它做静态模式匹配，不再拆一次。
    pub source: String,
}

/// 全仓唯一分析入口。
pub fn assess(command_line: &str) -> Assessment {
    let semantics = classify_semantics(command_line);
    let smart = smart_decision(command_line, &semantics.segments);
    let denial = if let Some(message) = smart.deny_reason {
        Some(RedlineReason::new(message))
    } else if redline::is_redline(&semantics) {
        Some(RedlineReason::new(SEMANTICS_REDLINE))
    } else {
        None
    };
    let approval = match smart.approval {
        Some(reason) => vec![reason],
        None => Vec::new(),
    };
    let pure_read_only = denial.is_none() && approval.is_empty() && smart.pure_read_only;
    Assessment {
        segments: semantics.segments,
        overall: semantics.overall,
        redline: denial,
        approval,
        pure_read_only,
        delete_targets: semantics.delete_targets,
        has_indirect_delete: semantics.has_indirect_delete,
        git_revert_forms: semantics.git_revert_forms,
        decoded_payload: semantics.decoded_payload,
        source: command_line.to_string(),
    }
}

impl Assessment {
    pub fn permission_verdict(&self) -> PermissionVerdict {
        crate::verdict::permission_of(self)
    }

    pub fn floor_verdict(&self, ctx: Option<&WorkspaceCtx<'_>>) -> GatekeeperResult {
        let gate = &crate::gatekeeper::SHARED_GATEKEEPER;
        let blocked_hit = gate.pattern_error().is_some() || gate.patterns().is_match(&self.source);
        let approval_hit = gate.approval_is_match(&self.source);
        crate::verdict::floor_of(
            self,
            gate.pattern_error(),
            blocked_hit,
            approval_hit,
            ctx.copied(),
        )
    }
}
