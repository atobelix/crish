//! 能力位：工具面分级、父子链钳制、运行时升降级。
//!
//! 与权限（PermissionMode）正交：
//! - 权限决定「要不要审批」；
//! - 能力决定「工具能不能用」。
//!
//! 默认值由任务类型给出（`TaskType::default_capability`），spawn 只能收窄；
//! 父级可在运行中 `grant`（受父自身能力上限钳制），子级降级立即生效。

use std::sync::{Arc, RwLock};

use crate::task::SubagentCapabilityMode;

/// 只读工具白名单（唯一真源；`agent-tools/readonly.rs` 复用）
pub const READONLY_TOOL_NAMES: [&str; 12] = [
    "read_file",
    "list_dir",
    "file_stat",
    "grep_search",
    "fuzzy_find",
    "diff_text",
    "project_tree",
    "search_context",
    "decompress_context",
    "query_blocks",
    "document_outline",
    "document_get_md",
];

/// 写文件工具（需要 ReadWrite 及以上）
pub const WRITE_TOOL_NAMES: [&str; 4] = [
    "write_file",
    "multi_replace_file_content",
    "delete_file",
    "delete_dir",
];

/// 命令执行工具（需要 Execute 及以上）
pub const EXECUTE_TOOL_NAMES: [&str; 1] = ["shell_command"];

/// 通信工具（与能力档无关，任何子代理都必须可用——否则只读代理无法上报/求助）
pub const COMMUNICATION_TOOL_NAMES: [&str; 3] = [
    "report_progress",
    "ask_parent",
    "request_capability",
];

/// 工具所需能力档
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolRequirement {
    /// 只读
    Read,
    /// 写文件
    Write,
    /// 执行命令
    Execute,
}

/// 工具 → 所需能力档。
///
/// 未知工具按 Write 处理（fail-closed：只读代理不可调用未分类工具；
/// ReadWrite 及以上可用）。新增执行类工具必须登记到 [EXECUTE_TOOL_NAMES]。
pub fn tool_requirement(tool_name: &str) -> ToolRequirement {
    if COMMUNICATION_TOOL_NAMES.contains(&tool_name) {
        ToolRequirement::Read
    } else if EXECUTE_TOOL_NAMES.contains(&tool_name) {
        ToolRequirement::Execute
    } else if WRITE_TOOL_NAMES.contains(&tool_name) {
        ToolRequirement::Write
    } else if READONLY_TOOL_NAMES.contains(&tool_name) {
        ToolRequirement::Read
    } else {
        ToolRequirement::Write
    }
}

/// 能力档是否允许某工具
pub fn allows_tool(mode: SubagentCapabilityMode, tool_name: &str) -> bool {
    match tool_requirement(tool_name) {
        ToolRequirement::Read => true,
        ToolRequirement::Write => mode.allows_write(),
        ToolRequirement::Execute => mode.allows_execute(),
    }
}

/// 能力拒绝文案（结构化、可执行）
pub fn denial_message(tool_name: &str, mode: SubagentCapabilityMode) -> String {
    let needed = match tool_requirement(tool_name) {
        ToolRequirement::Read => "read-only",
        ToolRequirement::Write => "read-write",
        ToolRequirement::Execute => "execute",
    };
    format!(
        "agent.capability_denied: 工具 {tool_name} 需要 {needed} 能力，当前为 {}。\
         请让主 agent 授予能力（grant_capability）或改用只读方案完成剩余任务。",
        mode.as_str()
    )
}

/// 运行时能力单元（主 agent root = All；子代理挂父链）
#[derive(Debug)]
pub struct CapabilityCell {
    own: RwLock<SubagentCapabilityMode>,
    parent: Option<Arc<CapabilityCell>>,
}

impl CapabilityCell {
    /// 主 agent 根单元（默认 All；主 agent 不受能力 gate 限制）
    pub fn root(mode: SubagentCapabilityMode) -> Arc<Self> {
        Arc::new(Self {
            own: RwLock::new(mode),
            parent: None,
        })
    }

    /// 子代理单元：`requested` 为 spawn 默认/显式值，可被父级钳制
    pub fn child(parent: Arc<Self>, requested: SubagentCapabilityMode) -> Arc<Self> {
        Arc::new(Self {
            own: RwLock::new(requested),
            parent: Some(parent),
        })
    }

    /// 当前有效能力（父链钳制）
    pub fn effective(&self) -> SubagentCapabilityMode {
        let own = *self.own.read().unwrap_or_else(|e| e.into_inner());
        match self.parent.as_ref() {
            Some(parent) => own.clamp_to_parent(parent.effective()),
            None => own,
        }
    }

    /// 设置自身能力（父级授权/降级；effective 仍受父链钳制）
    pub fn set(&self, mode: SubagentCapabilityMode) {
        *self.own.write().unwrap_or_else(|e| e.into_inner()) = mode;
    }

    /// 当前是否允许工具
    pub fn allows_tool(&self, tool_name: &str) -> bool {
        allows_tool(self.effective(), tool_name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_denies_write_and_execute() {
        assert!(allows_tool(SubagentCapabilityMode::ReadOnly, "read_file"));
        assert!(!allows_tool(SubagentCapabilityMode::ReadOnly, "write_file"));
        assert!(!allows_tool(SubagentCapabilityMode::ReadOnly, "shell_command"));
        assert!(
            !allows_tool(SubagentCapabilityMode::ReadOnly, "unknown_new_tool"),
            "未知工具按写类 fail-closed"
        );
    }

    #[test]
    fn read_write_allows_write_but_not_execute() {
        assert!(allows_tool(SubagentCapabilityMode::ReadWrite, "write_file"));
        assert!(!allows_tool(
            SubagentCapabilityMode::ReadWrite,
            "shell_command"
        ));
        assert!(allows_tool(SubagentCapabilityMode::Execute, "shell_command"));
    }

    #[test]
    fn parent_caps_child_and_upgrade_bounded_by_parent() {
        let parent = CapabilityCell::root(SubagentCapabilityMode::ReadOnly);
        let child = CapabilityCell::child(Arc::clone(&parent), SubagentCapabilityMode::All);
        assert_eq!(child.effective(), SubagentCapabilityMode::ReadOnly);
        parent.set(SubagentCapabilityMode::ReadWrite);
        assert_eq!(child.effective(), SubagentCapabilityMode::ReadWrite);
        child.set(SubagentCapabilityMode::Execute);
        assert_eq!(
            child.effective(),
            SubagentCapabilityMode::ReadWrite,
            "子级不能超过父级"
        );
    }

    #[test]
    fn child_downgrade_is_immediate() {
        let parent = CapabilityCell::root(SubagentCapabilityMode::All);
        let child = CapabilityCell::child(Arc::clone(&parent), SubagentCapabilityMode::Execute);
        assert!(child.allows_tool("shell_command"));
        child.set(SubagentCapabilityMode::ReadOnly);
        assert!(!child.allows_tool("shell_command"));
        assert!(!child.allows_tool("write_file"));
    }
}
