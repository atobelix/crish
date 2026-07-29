pub mod compaction {
    use conex_types::{CompactionResult, Message};

    pub struct CompactionEngine {
        max_tokens: usize,
    }

    impl CompactionEngine {
        pub fn new(max_tokens: usize) -> Self {
            Self { max_tokens }
        }

        /// Compact messages to fit within max_tokens budget.
        /// Strategy: keep system messages and recent messages intact;
        /// when over budget, merge oldest non-system messages into a summary placeholder.
        pub fn compact(&self, messages: &[Message]) -> CompactionResult {
            if messages.is_empty() {
                return CompactionResult {
                    messages: vec![],
                    tokens_consumed: 0,
                    cache_hit_rate_optimized: false,
                };
            }

            // Pre-compute token counts once (#5: avoid repeated count_tokens calls)
            let token_counts: Vec<usize> = messages
                .iter()
                .map(|m| super::count_tokens(&m.content))
                .collect();

            let total_tokens: usize = token_counts.iter().sum();

            // Under budget: no compaction needed
            if total_tokens <= self.max_tokens {
                return CompactionResult {
                    messages: messages.to_vec(),
                    tokens_consumed: total_tokens,
                    cache_hit_rate_optimized: true,
                };
            }

            // Over budget: compact oldest non-system messages
            let mut result_messages: Vec<Message> = Vec::new();
            let mut tokens_used: usize = 0;

            // Partition indices into system vs non-system
            let system_indices: Vec<usize> = messages.iter().enumerate()
                .filter(|(_, m)| m.role == "system")
                .map(|(i, _)| i)
                .collect();
            let non_system_indices: Vec<usize> = messages.iter().enumerate()
                .filter(|(_, m)| m.role != "system")
                .map(|(i, _)| i)
                .collect();

            // Always keep system messages
            for &idx in &system_indices {
                tokens_used += token_counts[idx];
                result_messages.push(messages[idx].clone());
            }

            // Reserve budget for recent messages (keep at least last 2 non-system messages)
            let keep_recent = non_system_indices.len().min(2);
            let recent_start = non_system_indices.len().saturating_sub(keep_recent);

            // Calculate tokens for recent messages
            let recent_tokens: usize = non_system_indices[recent_start..]
                .iter()
                .map(|&idx| token_counts[idx])
                .sum();

            // Budget available for middle messages
            let budget_for_middle = self.max_tokens
                .saturating_sub(tokens_used)
                .saturating_sub(recent_tokens);

            // Try to fit middle messages from newest to oldest
            // (#6: use continue instead of break to skip large messages and fit smaller ones)
            let middle_indices = &non_system_indices[..recent_start];
            let mut middle_kept: Vec<usize> = Vec::new();
            let mut middle_tokens: usize = 0;

            for &idx in middle_indices.iter().rev() {
                let msg_tokens = token_counts[idx];
                if middle_tokens + msg_tokens <= budget_for_middle {
                    middle_kept.push(idx);
                    middle_tokens += msg_tokens;
                }
                // continue: skip this message but try older (possibly shorter) ones
            }
            middle_kept.reverse();

            // If we dropped some middle messages, add a summary placeholder
            let dropped_count = middle_indices.len() - middle_kept.len();
            if dropped_count > 0 {
                let summary = format!(
                    "[Compacted {} earlier message(s) to fit context window]",
                    dropped_count
                );
                let summary_tokens = super::count_tokens(&summary);
                result_messages.push(Message {
                    id: format!("compacted-summary-{dropped_count}"),
                    role: "assistant".to_string(),
                    content: summary,
                    images: None,
                });
                tokens_used += summary_tokens;
            }

            // Add kept middle messages
            for &idx in &middle_kept {
                tokens_used += token_counts[idx];
                result_messages.push(messages[idx].clone());
            }

            // Add recent messages
            for &idx in &non_system_indices[recent_start..] {
                tokens_used += token_counts[idx];
                result_messages.push(messages[idx].clone());
            }

            CompactionResult {
                messages: result_messages,
                tokens_consumed: tokens_used,
                cache_hit_rate_optimized: false,
            }
        }
    }
}

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
                // Flush accumulated word characters (not including this separator)
                if word_chars > 0 {
                    tokens += (word_chars + 3) / 4; // ceil division by ~4
                    word_chars = 0;
                }
                // Separator is its own token
                tokens += 1;
            } else {
                word_chars += 1;
            }
        } else {
            // CJK and other multi-byte characters: ~1-2 tokens per character
            // Flush any pending ASCII word chars
            if word_chars > 0 {
                tokens += (word_chars + 3) / 4;
                word_chars = 0;
            }
            tokens += 1; // each non-ASCII char ≈ 1 token
        }
    }

    // Flush remaining word characters
    if word_chars > 0 {
        tokens += (word_chars + 3) / 4;
    }

    // Minimum 1 token for non-empty text
    tokens.max(1)
}

#[cfg(test)]
mod tests {
    use super::compaction::CompactionEngine;
    use super::count_tokens;
    use conex_types::Message;

    fn msg(id: &str, role: &str, content: &str) -> Message {
        Message {
            id: id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            images: None,
        }
    }

    #[test]
    fn count_tokens_empty() {
        assert_eq!(count_tokens(""), 0);
    }

    #[test]
    fn count_tokens_simple_word() {
        // "hello" = 5 chars → ~1-2 tokens
        let tokens = count_tokens("hello");
        assert!(tokens >= 1 && tokens <= 3);
    }

    #[test]
    fn count_tokens_sentence() {
        // A sentence with spaces and punctuation
        let tokens = count_tokens("Hello, world! This is a test.");
        assert!(tokens >= 5); // at least word count
        assert!(tokens <= 20); // reasonable upper bound
    }

    #[test]
    fn count_tokens_cjk() {
        // CJK characters should each be ~1 token
        let tokens = count_tokens("你好世界");
        assert!(tokens >= 4);
    }

    #[test]
    fn count_tokens_long_text() {
        let text = "word ".repeat(100);
        let tokens = count_tokens(&text);
        // ~100 words * ~1.5 tokens/word ≈ 150 tokens
        assert!(tokens >= 100);
        assert!(tokens <= 300);
    }

    #[test]
    fn compact_empty_messages() {
        let engine = CompactionEngine::new(1000);
        let result = engine.compact(&[]);
        assert!(result.messages.is_empty());
        assert_eq!(result.tokens_consumed, 0);
    }

    #[test]
    fn compact_under_budget_no_change() {
        let engine = CompactionEngine::new(10000);
        let messages = vec![
            msg("1", "system", "You are helpful."),
            msg("2", "user", "Hello"),
            msg("3", "assistant", "Hi there!"),
        ];
        let result = engine.compact(&messages);
        assert_eq!(result.messages.len(), 3);
        assert!(result.cache_hit_rate_optimized);
    }

    #[test]
    fn compact_over_budget_compresses_oldest() {
        let engine = CompactionEngine::new(20);
        let messages = vec![
            msg("1", "system", "System prompt"),
            msg("2", "user", "First message with quite a lot of content that takes many tokens to represent"),
            msg("3", "assistant", "First response with quite a lot of content that takes many tokens to represent"),
            msg("4", "user", "Second message with substantial content for testing purposes"),
            msg("5", "assistant", "Second response with substantial content for testing purposes"),
            msg("6", "user", "Latest question"),
            msg("7", "assistant", "Latest answer"),
        ];
        let result = engine.compact(&messages);

        // Should have fewer messages than input
        assert!(result.messages.len() < messages.len());
        // System message should be preserved
        assert!(result.messages.iter().any(|m| m.role == "system"));
        // Recent messages should be preserved
        assert!(result.messages.iter().any(|m| m.content == "Latest question"));
        assert!(result.messages.iter().any(|m| m.content == "Latest answer"));
        // Should have a compaction summary
        assert!(result.messages.iter().any(|m| m.content.contains("Compacted")));
    }

    #[test]
    fn compact_preserves_system_messages() {
        let engine = CompactionEngine::new(30);
        let messages = vec![
            msg("s1", "system", "System A"),
            msg("s2", "system", "System B"),
            msg("u1", "user", "A very long user message that exceeds the budget significantly"),
            msg("a1", "assistant", "A very long assistant response"),
            msg("u2", "user", "Recent"),
        ];
        let result = engine.compact(&messages);
        let system_count = result.messages.iter().filter(|m| m.role == "system").count();
        assert_eq!(system_count, 2);
    }

    #[test]
    fn compact_single_message_over_budget() {
        let engine = CompactionEngine::new(5);
        let messages = vec![
            msg("1", "user", "This is a very long message that far exceeds the token budget"),
        ];
        let result = engine.compact(&messages);
        // Should still return something (the recent message is kept)
        assert!(!result.messages.is_empty());
    }
}
