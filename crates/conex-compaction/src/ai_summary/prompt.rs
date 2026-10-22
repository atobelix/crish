//! 摘要提示词构建与退化摘要判定（从 ai_summary.rs 纯搬迁）

use conex_types::{AgentMessage, AgentMessageBlock};

use crate::summary_document::validate_summary_document;

/// 渲染单条消息为摘要提示词片段（text/tool-call/tool-result 三通道，
/// thought 不入提示——思考过程不诱导模型复述）
fn render_message_text(message: &AgentMessage) -> String {
    let mut out = String::new();
    for block in &message.blocks {
        match block {
            AgentMessageBlock::Text { text } => out.push_str(text),
            AgentMessageBlock::Thought { .. } => {}
            AgentMessageBlock::ToolCall(call) => {
                out.push_str(&format!(
                    "\n[工具调用] {} 入参：{}",
                    call.tool_name, call.input
                ));
            }
            AgentMessageBlock::ToolResult {
                tool_name,
                output,
                is_error,
                ..
            } => {
                let mut body = String::new();
                if let Some(text) = &output.text {
                    body.push_str(text);
                }
                if let Some(json) = &output.json {
                    body.push_str(&json.to_string());
                }
                if !body.is_empty() {
                    body = format!("：{body}");
                }
                out.push_str(&format!(
                    "\n[工具结果] {tool_name}{body}{}",
                    if *is_error { "（错误）" } else { "" }
                ));
            }
            AgentMessageBlock::Image(img) => {
                let alt = img.alt.as_deref().unwrap_or("图片");
                out.push_str(&format!("\n[图片] {alt}"));
            }
        }
    }
    out
}

/// 构建摘要提示词（被丢弃消息 + 既有摘要迭代合并；输出要求为
/// **Schema V1 JSON 文档**（[crate::summary_document::SUMMARY_REQUIRED_FIELDS]
/// 12 字段），与引擎同步路径 / 后台调度的 JSON 契约单轨对齐
/// （COMPACTION-01 P1-C：引擎契约单轨 Schema V1 JSON；忠实按本提示
/// 输出的 LLM 结果经 validate_summary_document 校验后落库）。
/// 调用方把结果经 [crate::summary_document::validate_summary_document]
/// 校验后渲染落库。
///
/// 引导纪律（对齐 opencode SUMMARY_TEMPLATE 与 DEEPCHECK-11 §1）：
/// 不提及「上下文被压缩」；保留精确路径 / 符号 / 命令 / 错误串，不可改写。
pub fn build_summarize_prompt(dropped: &[AgentMessage], existing: Option<&str>) -> String {
    let mut out = String::new();
    out.push_str(
        "你负责为对话中被压缩的历史消息生成结构化压缩摘要。\
         输出必须是**单个合法 JSON 对象**（Schema V1），不得输出其他任何内容\
         （不要使用代码块围栏，不要附加说明文字）。\
         以下 12 个字段全部必须出现（字符串字段无内容写空字符串，数组字段无内容写空数组）：\n\n",
    );
    out.push_str("- schemaVersion：1（整数）\n");
    out.push_str("- blockId：占位字符串（写 \"summary\" 即可）\n");
    out.push_str("- generation：1（整数）\n");
    out.push_str("- droppedIds：被压缩消息 id 数组（可空）\n");
    out.push_str("- height：1（整数）\n");
    out.push_str("- tier：\"chunk\"（固定值）\n");
    out.push_str("- goal：目标一句话（字符串）\n");
    out.push_str("- constraints：约束数组（可空）\n");
    out.push_str("- progress：已完成要点数组（每条 ≤ 30 字）\n");
    out.push_str("- decisions：关键决策数组（每条 ≤ 50 字）\n");
    out.push_str("- nextSteps：待办 / 下一步数组（可空）\n");
    out.push_str("- criticalContext：关键上下文数组——精确路径 / 符号 / 命令 / 错误串必须逐字保留，不可改写（可空）\n\n");
    out.push_str("只输出压缩摘要 JSON 文档本身，不附加其他说明；条目保持精炼；不要提及“上下文被压缩”这件事。\n\n");
    if let Some(existing) = existing {
        if !existing.trim().is_empty() {
            out.push_str("## 既有摘要（合并进新摘要，不要重复既有内容）\n");
            out.push_str(existing);
            out.push_str("\n\n");
        }
    }
    out.push_str("## 待摘要的历史消息\n");
    for message in dropped {
        out.push_str(&format!(
            "\n[{}] {}\n",
            role_name(message.role),
            render_message_text(message)
        ));
    }
    out
}

fn role_name(role: conex_types::AgentMessageRole) -> &'static str {
    match role {
        conex_types::AgentMessageRole::System => "系统",
        conex_types::AgentMessageRole::User => "用户",
        conex_types::AgentMessageRole::Assistant => "助手",
        conex_types::AgentMessageRole::Tool => "工具",
    }
}

/// Critical Context 多态渲染器（BC05-6：根除关键信息静默蒸发）
///
/// 全面支持数组（`- item`）、对象键值（`- key: value`）与多行字符串多态解析，
/// 确保模型输出的结构化 criticalContext 100% 确定性保真投影到 Markdown，
/// 杜绝出现空白标题。
pub fn push_critical_context(out: &mut String, doc: &serde_json::Value) {
    let Some(val) = doc.get("criticalContext") else {
        return;
    };
    match val {
        // 契约正规态：数组形式（逐条渲染为无序列表）
        serde_json::Value::Array(items) => {
            for item in items {
                match item {
                    serde_json::Value::String(s) => {
                        let trimmed = s.trim();
                        if !trimmed.is_empty() {
                            out.push_str("- ");
                            out.push_str(trimmed);
                            out.push('\n');
                        }
                    }
                    serde_json::Value::Object(map) => {
                        // 兼容对象条目：{ "path": "...", "desc": "..." } 等键值对
                        let mut parts = Vec::new();
                        for (k, v) in map {
                            if let Some(str_val) = v.as_str() {
                                parts.push(format!("{k}: {str_val}"));
                            } else {
                                parts.push(format!("{k}: {v}"));
                            }
                        }
                        if !parts.is_empty() {
                            out.push_str("- ");
                            out.push_str(&parts.join(", "));
                            out.push('\n');
                        }
                    }
                    other => {
                        let s = other.to_string();
                        let trimmed = s.trim();
                        if !trimmed.is_empty() {
                            out.push_str("- ");
                            out.push_str(trimmed);
                            out.push('\n');
                        }
                    }
                }
            }
        }
        // 兼容态：顶层对象键值直接作为 criticalContext
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                out.push_str("- ");
                out.push_str(k);
                out.push_str(": ");
                if let Some(str_val) = v.as_str() {
                    out.push_str(str_val);
                } else {
                    out.push_str(&v.to_string());
                }
                out.push('\n');
            }
        }
        // 兼容态：纯文本多行字符串
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                for line in trimmed.lines() {
                    let l = line.trim();
                    if !l.is_empty() {
                        if !l.starts_with('-') && !l.starts_with('*') {
                            out.push_str("- ");
                        }
                        out.push_str(l);
                        out.push('\n');
                    }
                }
            }
        }
        _ => {}
    }
}

// ── 退化摘要判定（对齐 grok MIN_SUMMARY_SEED_CHARS = 500）──

/// 空/过短摘要判定：字符数（含空白剔除后）低于下限视为退化（瞬态），
/// 走重试；下限默认 [MIN_SUMMARY_SEED_CHARS_DEFAULT]
pub fn is_degenerate_summary(text: &str, min_chars: usize) -> bool {
    text.trim().chars().count() < min_chars
}

/// 摘要可接受性判定：非退化（字符数达标）**或**为合法 Schema V1 JSON 文档
/// （COMPACTION-01 P1-C：引擎契约单轨 JSON 后，短而完整的 JSON 文档
/// （如超短会话）不得被字符下限误杀）。
pub fn is_acceptable_summary(text: &str, min_chars: usize) -> bool {
    !is_degenerate_summary(text, min_chars) || validate_summary_document(text, usize::MAX).is_ok()
}
