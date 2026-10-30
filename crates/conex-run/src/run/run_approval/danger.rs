//! 审批危险级别推导（自 run_approval.rs 拆出；纯函数，行为零变化）。
//!
//! 经 run_approval.rs `pub use danger::derive_danger_level;` 保持原公开路径
//! （`run_approval::derive_danger_level`）与签名不变。

/// 危险级别推导（R1-04 / M6 C13：桌面按 F2 §2.2 表推导，移动端不重算）
///
/// 轻量启发式（与前端 approvalHandlers S9 宽容解析同语义的子集）：
/// 删除类工具 / 参数含删除语义 → 2（高风险，移动端二次确认），其余
/// 常规确认 → 1。红线请求不会到达审批门（exec_verdict 裁决中心对红线
/// 任何模式先行 Deny），此处无需红线分支。
pub fn derive_danger_level(tool_name: &str, param_keys: &[String]) -> u8 {
    const DESTRUCTIVE_TOOLS: [&str; 5] = [
        "shell:write",
        "shell:exec",
        "git:revert",
        "file:delete",
        "workspace:delete",
    ];
    if DESTRUCTIVE_TOOLS.contains(&tool_name) {
        return 2;
    }
    if param_keys
        .iter()
        .any(|k| k.contains("delete") || k.contains("remove") || k.contains("overwrite"))
    {
        return 2;
    }
    1
}
