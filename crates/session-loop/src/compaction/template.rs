//! 上下文槽位模板与中性 Stub 规范 (Context Slot Templates & Neutral Stub)
//!
//! 依据 `03-context-and-resilience-improvement.md` §六（§6.1）与 §七（§7.1）：
//! - Slot 2: Pinned Global Anchor (全局锚定区 = Slot 2.1 不可变环境 + Slot 2.2 不可变决策账本)
//! - Slot 3: 中性 Stub 占位符规范 (Neutral Stub Specification)
//!
//! ## KV Cache 保护铁律
//! 在当前 Run 生命周期内，Slot 0 至 Slot 3 的全部字节在首回合确定后**严格冻结**，
//! 严禁任何形式的动态热替换（In-Flight Hot-Swap）。
//! 中性 Stub 占位符一旦生成，在当前 Run 内存中保持字节级绝对稳定，100% 保护大模型前缀缓存。

/// 生成 Schema V1 标准中性 Stub 占位符文本（对齐 P-05 §4.2）
///
/// 对大模型语义中性、不误导推断，清晰标注归档代际与交互条数，
/// 并指明全文已持久化，可通过 `decompress_context` 精准调阅。
pub fn render_neutral_stub(generation: u32, dropped_count: usize) -> String {
    format!(
        "[上下文压缩记录：已归档历史第 {generation} 代共 {dropped_count} 条交互。\n\
        包含历史执行目标、约束及工具调用详情。原始全文已持久化，可随时通过 decompress_context 调阅。]"
    )
}

/// 渲染 Slot 2 全局锚定区内容（Slot 2.1 不可变环境 + Slot 2.2 不可变决策账本）
pub fn render_slot2_global_anchor(environment_context: &str, ledger_markdown: &str) -> String {
    let mut out = String::with_capacity(environment_context.len() + ledger_markdown.len() + 256);
    out.push_str("# [全局锚定上下文 (Slot 2: Pinned Global Anchor)]\n\n");

    if !environment_context.trim().is_empty() {
        out.push_str("## [环境基准 (Slot 2.1: Environment Baseline)]\n");
        out.push_str(environment_context.trim());
        out.push_str("\n\n");
    }

    if !ledger_markdown.trim().is_empty() {
        out.push_str(ledger_markdown.trim());
        out.push('\n');
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_neutral_stub_rendering() {
        let stub = render_neutral_stub(3, 42);
        assert!(stub.contains("已归档历史第 3 代共 42 条交互"));
        assert!(stub.contains("decompress_context"));
    }

    #[test]
    fn test_slot2_global_anchor() {
        let env = "OS: Windows 11\nWorkspace: C:\\Software\\conex";
        let ledger = "### 1. 安全红线\n- [REDLINE]: 严禁打补丁";
        let anchor = render_slot2_global_anchor(env, ledger);
        assert!(anchor.contains("Slot 2: Pinned Global Anchor"));
        assert!(anchor.contains("OS: Windows 11"));
        assert!(anchor.contains("[REDLINE]: 严禁打补丁"));
    }
}
