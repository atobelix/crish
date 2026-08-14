//! 结构化 Markdown 摘要模板渲染（conex-compaction）

use conex_types::AgentMessage;

/// 结构化摘要模板（P4 §3.4.3）：Goal / Constraints / Progress / Key
/// Decisions / Next Steps / Critical Context 六节，无内容节写 `(none)`。
///
/// L2 摘要实现方（session-loop / 壳层注入的 [crate::plan::Summarizer]）以本模板为输出
/// 格式基准；L1 静态路径使用简洁占位符（既有模板）。
pub fn structured_summary_template(dropped: &[AgentMessage], existing: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(existing) = existing {
        out.push_str(existing);
        out.push_str("\n\n");
    }
    for section in [
        "Goal",
        "Constraints",
        "Progress",
        "Key Decisions",
        "Next Steps",
        "Critical Context",
    ] {
        out.push_str("## ");
        out.push_str(section);
        out.push_str("\n(none)\n\n");
    }
    out.push_str(&format!(
        "## 来源\n本次压缩丢弃 {} 条消息（详见压缩事件 droppedIds）",
        dropped.len()
    ));
    out
}
