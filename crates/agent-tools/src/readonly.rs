//! 只读子代理工具集裁剪（I4-M3 内容 3：Reasonix ReadOnlySubagentToolRegistry 落地）
//!
//! capabilityMode = read-only 的子代理（researcher 类）只允许只读工具：
//! 其工具集剔除全部写类（write_file / delete_file / delete_dir /
//! shell_command），仅保留 read_file / list_dir / file_stat / grep_search /
//! fuzzy_find / diff_text。比提示词纪律可靠——执行层根本拿不到写工具。
//!
//! 裁剪语义为**白名单**（fail-closed）：不在 [READONLY_TOOL_NAMES] 内的
//! 工具一律剔除（含未来新增的未分类工具），防止新写工具漏网。
//!
//! 挂接点：M2 run_subagent spawn 时按 capabilityMode 选择工具注册表
//! （[filter_readonly_registry]），shell_command 不进入只读集——bash
//! 副作用无法静态预知，删除形态重定向不能覆盖全部写形态，故整体剔除。

use crate::definition::ToolError;
use crate::registry::ToolRegistry;

/// 写类工具名单（只读子代理整体剔除）
pub const WRITE_TOOL_NAMES: [&str; 4] = [
    "write_file",
    "delete_file",
    "delete_dir",
    "shell_command",
];

/// 只读工具白名单（仅保留这些工具）
pub const READONLY_TOOL_NAMES: [&str; 6] = [
    "read_file",
    "list_dir",
    "file_stat",
    "grep_search",
    "fuzzy_find",
    "diff_text",
];

/// 按只读白名单裁剪注册表（fail-closed：白名单外的工具全部剔除）
///
/// 返回新注册表，原注册表不受影响。注册失败在源注册表名称唯一的前提下
/// 不可能发生（白名单 ⊆ 源工具集，名称不重复），`?` 透传保持诚实。
pub fn filter_readonly_registry(registry: &ToolRegistry) -> Result<ToolRegistry, ToolError> {
    let mut filtered = ToolRegistry::new();
    for tool in registry.list() {
        if READONLY_TOOL_NAMES.contains(&tool.name()) {
            filtered.register(tool)?;
        }
    }
    Ok(filtered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::EchoTool;
    use crate::tools::register_builtin_tools;
    use std::sync::Arc;

    #[test]
    fn filter_readonly_keeps_only_readonly_tools() {
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).unwrap();

        let ro = filter_readonly_registry(&reg).unwrap();
        assert_eq!(
            ro.len(),
            READONLY_TOOL_NAMES.len(),
            "只读子代理工具集应为全部只读工具"
        );
        let names: Vec<String> = ro
            .list_definitions()
            .iter()
            .map(|d| d.name.clone())
            .collect();
        let mut expected: Vec<String> = READONLY_TOOL_NAMES
            .iter()
            .map(|n| n.to_string())
            .collect();
        expected.sort();
        assert_eq!(names, expected);
    }

    #[test]
    fn filter_readonly_drops_all_write_tools() {
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).unwrap();
        let ro = filter_readonly_registry(&reg).unwrap();
        for name in WRITE_TOOL_NAMES {
            assert!(!ro.has(name), "{name} 必须从只读工具集剔除");
        }
        for name in READONLY_TOOL_NAMES {
            assert!(ro.has(name), "{name} 必须保留在只读工具集");
        }
    }

    #[test]
    fn filter_readonly_drops_unknown_tools_fail_closed() {
        // 未知工具（非白名单）一律剔除：白名单语义防未来新写工具漏网
        let mut reg = ToolRegistry::new();
        reg.register(Arc::new(EchoTool::new("mystery_write_tool"))).unwrap();
        register_builtin_tools(&mut reg).unwrap();
        let ro = filter_readonly_registry(&reg).unwrap();
        assert!(!ro.has("mystery_write_tool"));
        assert_eq!(ro.len(), READONLY_TOOL_NAMES.len());
    }

    #[test]
    fn filter_does_not_mutate_source_registry() {
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).unwrap();
        let before = reg.len();
        let _ = filter_readonly_registry(&reg).unwrap();
        assert_eq!(reg.len(), before, "裁剪必须返回新注册表，不改动原表");
        assert!(reg.has("write_file"));
    }

    #[test]
    fn filter_readonly_tool_names_are_valid_builtin_names() {
        // 名单一致性护栏：白名单/黑名单均命中既有内置工具名
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).unwrap();
        for name in WRITE_TOOL_NAMES.iter().chain(READONLY_TOOL_NAMES.iter()) {
            assert!(reg.has(name), "{name} 必须存在于内置工具集");
        }
    }
}
