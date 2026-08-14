//! Token 计算与启发式估算（conex-compaction）

use conex_types::{AgentMessage, AgentMessageBlock, ToolOutput};

/// 图片固定 token 计价（对齐 jcode IMAGE_TOKEN_COST=1600，P4 §3.3.1：
/// base64 按 len/4 计数会高估真实上下文约 100 倍，必须固定计价；
/// AgentMessage 当前无图片块，此常量供未来图片块 / 旧面迁移使用）
pub const IMAGE_TOKEN_COST: usize = 1_600;

/// Estimate token count using a tiktoken-inspired heuristic.
/// Approximation: ~4 characters per token for English text,
/// with adjustments for whitespace, punctuation, and CJK characters.
pub fn count_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }

    let mut tokens: usize = 0;
    let mut word_chars: usize = 0;

    for ch in text.chars() {
        if ch.is_ascii() {
            if ch.is_whitespace() || ch.is_ascii_punctuation() {
                // 约 4 字符折 1 token（向上取整）
                if word_chars > 0 {
                    tokens += word_chars.div_ceil(4);
                    word_chars = 0;
                }
                // Separator is its own token
                tokens += 1;
            } else {
                word_chars += 1;
            }
        } else {
            // CJK 等非 ASCII 字符：约 1-2 token/字符
            // 先刷出待结算的 ASCII 单词字符
            if word_chars > 0 {
                tokens += word_chars.div_ceil(4);
                word_chars = 0;
            }
            tokens += 1; // each non-ASCII char ≈ 1 token
        }
    }

    // 刷新剩余单词字符（向上取整）
    if word_chars > 0 {
        tokens += word_chars.div_ceil(4);
    }

    // Minimum 1 token for non-empty text
    tokens.max(1)
}

/// 单条 AgentMessage 的块级 token 估算（对齐 `to_chat_messages`
/// 序列化形态，P4 §3.3.1）
///
/// - `Text` / `Thought` → [count_tokens] 正文；
/// - `ToolCall` → 工具名 + 入参 JSON 折算（对齐 pi estimateMessageTokens
///   的 name + arguments，pi-cache-analysis.md:82）；
/// - `ToolResult` → 工具名 + 输出折算（text / json / artifacts 三通道，
///   与 wire 序列化口径一致）。
pub fn count_agent_message_tokens(message: &AgentMessage) -> usize {
    message
        .blocks
        .iter()
        .map(|block| match block {
            AgentMessageBlock::Text { text } => count_tokens(text),
            AgentMessageBlock::Thought { text, .. } => count_tokens(text),
            AgentMessageBlock::ToolCall(call) => {
                count_tokens(&call.tool_name) + count_tokens(&call.input.to_string())
            }
            AgentMessageBlock::ToolResult {
                tool_name, output, ..
            } => count_tokens(tool_name) + count_tool_output_tokens(output),
        })
        .sum()
}

/// 工具输出折算（text / json / artifacts 三通道字符折算）
pub fn count_tool_output_tokens(output: &ToolOutput) -> usize {
    let mut tokens = 0usize;
    if let Some(text) = &output.text {
        tokens += count_tokens(text);
    }
    if let Some(json) = &output.json {
        tokens += count_tokens(&json.to_string());
    }
    if let Some(artifacts) = &output.artifacts {
        for artifact in artifacts {
            tokens += count_tokens(&artifact.title);
            if let Some(uri) = &artifact.uri {
                tokens += count_tokens(uri);
            }
            if let Some(text) = &artifact.text {
                tokens += count_tokens(text);
            }
            if let Some(metadata) = &artifact.metadata {
                tokens += count_tokens(&metadata.to_string());
            }
        }
    }
    tokens
}
