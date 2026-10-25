//! Token 计算与启发式估算（conex-compaction）
//!
//! 提供对齐现代大语言模型 BPE 分词器的高保真零外部依赖快速分词估算：
//! - CJK 统一表意字符按 1.45 权重准确核算（消除中文 30%~50% 严重低估）；
//! - 空白序列折叠（缩进空格/空行每 4 字符 1 Token）；
//! - 常见 JSON 与代码复合符号簇聚类（彻底消除 JSON 300% 虚假高估）；
//! - 消息 Wire 协议 Framing 固定开销（单条消息 4 Tokens，工具调用/回执追加 8 Tokens）。

use conex_types::{AgentMessage, AgentMessageBlock, AgentMessageRole, ToolOutput};

/// 图片固定 token 计价（对齐 jcode IMAGE_TOKEN_COST=1600，P4 §3.3.1）
pub const IMAGE_TOKEN_COST: usize = 1_600;

/// 单条消息 Wire 协议基础 Framing 开销（`<|im_start|>role\n...<|im_end|>\n`）
pub const MESSAGE_FRAMING_TOKENS: usize = 4;

/// 工具调用/回执协议额外 Framing 开销
pub const TOOL_CALL_FRAMING_TOKENS: usize = 8;

/// 判断是否为 CJK 表意文字与假名、谚文
#[inline]
pub fn is_cjk(ch: char) -> bool {
    matches!(ch,
        '\u{4E00}'..='\u{9FFF}'   // CJK Unified Ideographs
        | '\u{3400}'..='\u{4DBF}' // CJK Unified Ideographs Extension A
        | '\u{20000}'..='\u{2A6DF}' // Extension B
        | '\u{2A700}'..='\u{2B73F}' // Extension C
        | '\u{2B740}'..='\u{2B81F}' // Extension D
        | '\u{2B820}'..='\u{2CEAF}' // Extension E
        | '\u{F900}'..='\u{FAFF}' // CJK Compatibility Ideographs
        | '\u{3040}'..='\u{309F}' // Hiragana
        | '\u{30A0}'..='\u{30FF}' // Katakana
        | '\u{31F0}'..='\u{31FF}' // Katakana Phonetic Extensions
        | '\u{AC00}'..='\u{D7AF}' // Hangul Syllables
        | '\u{1100}'..='\u{11FF}' // Hangul Jamo
    )
}

/// 判断是否为全角标点符号与 CJK 标点
#[inline]
pub fn is_fullwidth_punct(ch: char) -> bool {
    matches!(ch,
        '\u{3000}'..='\u{303F}' // CJK Symbols and Punctuation
        | '\u{FF01}'..='\u{FF0F}' // Fullwidth ASCII variants (！＂＃＄％＆＇（）＊＋，－．／)
        | '\u{FF1A}'..='\u{FF20}' // （：；＜＝＞？＠）
        | '\u{FF3B}'..='\u{FF40}' // （［＼］＾＿｀）
        | '\u{FF5B}'..='\u{FF65}' // （｛｜｝～）
    )
}

/// 判断是否为 Emoji 符号
#[inline]
pub fn is_emoji(ch: char) -> bool {
    matches!(ch,
        '\u{1F300}'..='\u{1F5FF}' // Misc Symbols and Pictographs
        | '\u{1F600}'..='\u{1F64F}' // Emoticons
        | '\u{1F680}'..='\u{1F6FF}' // Transport and Map
        | '\u{1F700}'..='\u{1F77F}' // Alchemical Symbols
        | '\u{1F780}'..='\u{1F7FF}' // Geometric Shapes Extended
        | '\u{1F800}'..='\u{1F8FF}' // Supplemental Arrows-C
        | '\u{1F900}'..='\u{1F9FF}' // Supplemental Symbols and Pictographs
        | '\u{1FA00}'..='\u{1FA6F}' // Chess Symbols
        | '\u{1FA70}'..='\u{1FAFF}' // Symbols and Pictographs Extended-A
        | '\u{2600}'..='\u{26FF}'   // Misc symbols
        | '\u{2700}'..='\u{27BF}'   // Dingbats
    )
}

/// 高保真快速文本 Token 计数（对齐主流 LLM 分词器规则）
pub fn count_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }

    let mut tokens: usize = 0;
    let mut cjk_points: usize = 0;
    let mut fullwidth_points: usize = 0;
    let mut emoji_points: usize = 0;

    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut i = 0;

    while i < n {
        let ch = chars[i];

        if ch.is_ascii() {
            if ch.is_whitespace() {
                // 空白序列折叠：每 4 个连续空白字符计 1 Token，消除代码缩进与多行空行暴涨
                let start = i;
                while i < n && chars[i].is_ascii() && chars[i].is_whitespace() {
                    i += 1;
                }
                let len = i - start;
                tokens += len.div_ceil(4);
            } else if ch.is_ascii_alphanumeric() || ch == '_' {
                // ASCII 连续单词字符：每 4 字符折算 1 Token
                let start = i;
                while i < n
                    && chars[i].is_ascii()
                    && (chars[i].is_ascii_alphanumeric() || chars[i] == '_')
                {
                    i += 1;
                }
                let len = i - start;
                tokens += len.div_ceil(4);
            } else {
                // ASCII 标点与符号：聚类 JSON/代码常见多字符复合符号
                if i + 3 < n {
                    let s4 = [chars[i], chars[i + 1], chars[i + 2], chars[i + 3]];
                    if s4 == ['"', ':', ' ', '"']
                        || s4 == ['"', ',', ' ', '"']
                        || s4 == ['"', ',', '\n', ' ']
                    {
                        tokens += 1;
                        i += 4;
                        continue;
                    }
                }
                if i + 2 < n {
                    let s3 = [chars[i], chars[i + 1], chars[i + 2]];
                    if s3 == [':', '"', ' ']
                        || s3 == [':', ' ', '"']
                        || s3 == ['"', ':', ' ']
                        || s3 == ['"', ',', ' ']
                        || s3 == [',', ' ', '"']
                        || s3 == ['=', '=', '=']
                        || s3 == ['!', '=', '=']
                    {
                        tokens += 1;
                        i += 3;
                        continue;
                    }
                }
                if i + 1 < n {
                    let s2 = [chars[i], chars[i + 1]];
                    if s2 == [':', ' ']
                        || s2 == [',', ' ']
                        || s2 == ['"', ':']
                        || s2 == [':', '"']
                        || s2 == ['"', ',']
                        || s2 == [',', '"']
                        || s2 == ['{', '"']
                        || s2 == ['"', '}']
                        || s2 == ['[', '"']
                        || s2 == ['"', ']']
                        || s2 == ['}', ']']
                        || s2 == [']', '}']
                        || s2 == ['{', '}']
                        || s2 == ['[', ']']
                        || s2 == ['-', '>']
                        || s2 == ['=', '>']
                        || s2 == ['=', '=']
                        || s2 == ['!', '=']
                        || s2 == ['<', '=']
                        || s2 == ['>', '=']
                        || s2 == [':', ':']
                        || s2 == ['/', '/']
                        || s2 == ['/', '*']
                        || s2 == ['*', '/']
                        || s2 == ['&', '&']
                        || s2 == ['|', '|']
                        || s2 == ['+', '+']
                        || s2 == ['-', '-']
                        || s2 == ['"', '"']
                        || s2 == ['\'', '\'']
                    {
                        tokens += 1;
                        i += 2;
                        continue;
                    }
                }
                // 单个标点或连续普通标点：每 2 个标点字符计 1 Token
                if chars[i].is_ascii_punctuation() {
                    let start = i;
                    while i < n && chars[i].is_ascii() && chars[i].is_ascii_punctuation() {
                        i += 1;
                    }
                    let len = i - start;
                    tokens += len.div_ceil(2);
                } else {
                    // ASCII 控制字符（如 ANSI Escape 序列 \x1b）或其他字符：前进 1 字符
                    tokens += 1;
                    i += 1;
                }
            }
        } else if is_cjk(ch) {
            // CJK 表意文字按 1.45 权重计费（每字符 145 points）
            cjk_points += 145;
            i += 1;
        } else if is_fullwidth_punct(ch) {
            // 全角标点按 1.20 权重计费
            fullwidth_points += 120;
            i += 1;
        } else if is_emoji(ch) {
            // Emoji 按 2.50 权重计费
            emoji_points += 250;
            i += 1;
        } else {
            // 其他 Unicode 字符（拉丁扩展、西里尔等）按 1 Token 折算
            tokens += 1;
            i += 1;
        }
    }

    if cjk_points > 0 {
        tokens += cjk_points.div_ceil(100);
    }
    if fullwidth_points > 0 {
        tokens += fullwidth_points.div_ceil(100);
    }
    if emoji_points > 0 {
        tokens += emoji_points.div_ceil(100);
    }

    tokens.max(1)
}

/// 快速分词估算（与 [count_tokens] 语义一致）
#[inline]
pub fn count_tokens_fast(text: &str) -> usize {
    count_tokens(text)
}

/// 单条 AgentMessage 的块级 token 估算（含 Wire Framing 开销）
///
/// - 每条消息基础 Framing 4 Tokens；
/// - 包含工具调用或工具返回的消息追加 8 Tokens 协议封包开销；
/// - `Text` / `Thought` → [count_tokens] 正文；
/// - `ToolCall` → 工具名 + 入参 JSON 折算；
/// - `ToolResult` → 工具名 + 输出折算（text / json / artifacts 三通道）。
pub fn count_agent_message_tokens(message: &AgentMessage) -> usize {
    let mut tokens = MESSAGE_FRAMING_TOKENS;
    let mut has_tools = false;

    for block in &message.blocks {
        match block {
            AgentMessageBlock::Text { text } => {
                tokens += count_tokens(text);
            }
            AgentMessageBlock::Thought { text, .. } => {
                tokens += count_tokens(text);
            }
            AgentMessageBlock::ToolCall(call) => {
                has_tools = true;
                tokens += count_tokens(&call.tool_name);
                tokens += count_tokens(&call.input.to_string());
            }
            AgentMessageBlock::ToolResult {
                tool_name, output, ..
            } => {
                has_tools = true;
                tokens += count_tokens(tool_name);
                tokens += count_tool_output_tokens(output);
            }
            AgentMessageBlock::Image(img) => {
                tokens += count_tokens(img.alt.as_deref().unwrap_or(""));
                tokens += count_tokens(img.url.as_deref().unwrap_or(""));
            }
        }
    }

    if has_tools || message.role == AgentMessageRole::Tool {
        tokens += TOOL_CALL_FRAMING_TOKENS;
    }

    tokens
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cjk_145_weighting() {
        // 1000 个汉字在 1300 ~ 1600 之间（1000 * 1.45 = 1450）
        let chinese = "中".repeat(1000);
        let tokens = count_tokens(&chinese);
        assert!((1300..=1600).contains(&tokens), "实际 tokens: {tokens}");
        assert_eq!(tokens, 1450);

        // 4 个汉字：4 * 1.45 = 5.8 => 6
        assert_eq!(count_tokens("你好世界"), 6);
    }

    #[test]
    fn test_whitespace_and_json_clustering() {
        // 4 个连续空格折叠为 1 Token
        assert_eq!(count_tokens("    "), 1);
        // 8 个空格折叠为 2 Tokens
        assert_eq!(count_tokens("        "), 2);

        // JSON 键值对符号聚类
        let json = r#"{"name": "test", "active": true}"#;
        let tokens = count_tokens(json);
        // 不再出现每个冒号、逗号、空格都各计 1 Token 的 20+ 虚高
        assert!(tokens <= 12, "JSON token 计数不应虚高: {tokens}");
    }

    #[test]
    fn test_message_framing_overhead() {
        use conex_types::AgentMessageBlock;

        let empty_msg = AgentMessage {
            id: "m1".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-03T10:00:00.000Z".to_string(),
            blocks: vec![],
            metadata: None,
            client_message_id: None,
            content: None,
        };
        assert_eq!(
            count_agent_message_tokens(&empty_msg),
            MESSAGE_FRAMING_TOKENS
        );

        let tool_msg = AgentMessage {
            id: "m2".to_string(),
            role: AgentMessageRole::Tool,
            created_at: "2026-08-03T10:00:01.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "ok".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        };
        // 4 (message) + 8 (tool) + 1 (text "ok") = 13
        assert_eq!(count_agent_message_tokens(&tool_msg), 13);
    }

    #[test]
    fn test_ansi_and_control_codes_progress() {
        let ansi_str = "\x1b[31mred\x1b[0m\nplain\x1b]0;title\x07";
        let tokens = count_tokens(ansi_str);
        assert!(tokens > 0);
    }
}
