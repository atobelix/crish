//! 实时流式思考标签解析状态机（B2.5 / Markdown Stream Refactor）
//!
//! 支持 `<think>...</think>` / `<thought>...</thought>` / `<thinking>...</thinking>`
//! 保证跨 Chunk 分割不漏字、不逃逸、回滚无损。

use crate::events::ProviderStreamEvent;

/// 思考标签配对
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TagPair {
    pub open: &'static str,
    pub close: &'static str,
}

/// 默认支持的思考标签集合
pub const DEFAULT_TAGS: &[TagPair] = &[
    TagPair {
        open: "<think>",
        close: "</think>",
    },
    TagPair {
        open: "<thought>",
        close: "</thought>",
    },
    TagPair {
        open: "<thinking>",
        close: "</thinking>",
    },
];

pub const SUPPORTED_TAGS: &[TagPair] = DEFAULT_TAGS;

/// 状态机状态枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TagState {
    /// 当前处于普通正文段落
    #[default]
    Text,
    /// 遇到了 '<'，正在前瞻匹配开标签（如 "<think>" / "<thought>" / "<thinking>"）
    MatchingOpen,
    /// 当前处于思考链内部
    Thinking,
    /// 思考链中遇到了 '<'，正在前瞻匹配闭标签（如 "</think>" / "</thought>" / "</thinking>"）
    MatchingClose,
}

/// 兼容别名
pub type ExtractorState = TagState;
pub type ThinkTagState = TagState;
pub type ThinkTagStateMachine = StreamingTagExtractor;

/// 提取出的片段类型
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtractedPiece {
    Text(String),
    Thought(String),
}

impl ExtractedPiece {
    pub fn into_stream_event(self) -> ProviderStreamEvent {
        match self {
            ExtractedPiece::Text(text) => ProviderStreamEvent::TextDelta { text },
            ExtractedPiece::Thought(text) => ProviderStreamEvent::ThoughtDelta {
                text,
                redacted: None,
            },
        }
    }
}

/// 流式思考标签提取状态机
#[derive(Debug)]
pub struct StreamingTagExtractor {
    state: TagState,
    lookahead_buf: String,
    tags: &'static [TagPair],
    active_tag_index: Option<usize>,
    strip_leading_newline: bool,
}

impl Default for StreamingTagExtractor {
    fn default() -> Self {
        Self::new(DEFAULT_TAGS)
    }
}

impl StreamingTagExtractor {
    pub fn new(tags: &'static [TagPair]) -> Self {
        Self {
            state: TagState::Text,
            lookahead_buf: String::with_capacity(32),
            tags,
            active_tag_index: None,
            strip_leading_newline: false,
        }
    }

    /// 当前是否处于思考流态
    pub fn is_thinking(&self) -> bool {
        matches!(self.state, TagState::Thinking | TagState::MatchingClose)
    }

    /// 获取当前状态机状态
    pub fn state(&self) -> TagState {
        self.state
    }

    /// 消费一个文本块，产出提取的片段列表
    pub fn push_chunk(&mut self, chunk: &str) -> Vec<ExtractedPiece> {
        let mut pieces = Vec::new();
        let mut current_text_batch = String::new();
        let mut current_thought_batch = String::new();

        for ch in chunk.chars() {
            // 处理标签后首个换行符消除逻辑（\r\n 或 \n）
            if self.strip_leading_newline {
                if ch == '\r' {
                    continue;
                }
                self.strip_leading_newline = false;
                if ch == '\n' {
                    continue;
                }
            }

            match self.state {
                TagState::Text => {
                    if ch == '<' {
                        self.lookahead_buf.push(ch);
                        self.state = TagState::MatchingOpen;
                    } else {
                        current_text_batch.push(ch);
                    }
                }
                TagState::MatchingOpen => {
                    self.lookahead_buf.push(ch);
                    self.process_matching_open(&mut pieces, &mut current_text_batch);
                }
                TagState::Thinking => {
                    if ch == '<' {
                        self.lookahead_buf.push(ch);
                        self.state = TagState::MatchingClose;
                    } else {
                        current_thought_batch.push(ch);
                    }
                }
                TagState::MatchingClose => {
                    self.lookahead_buf.push(ch);
                    self.process_matching_close(&mut pieces, &mut current_thought_batch);
                }
            }
        }

        if !current_text_batch.is_empty() {
            pieces.push(ExtractedPiece::Text(current_text_batch));
        }
        if !current_thought_batch.is_empty() {
            pieces.push(ExtractedPiece::Thought(current_thought_batch));
        }

        pieces
    }

    /// 消费文本并直接转换为 ProviderStreamEvent
    pub fn push_text(&mut self, text: &str) -> Vec<ProviderStreamEvent> {
        self.push_chunk(text)
            .into_iter()
            .map(ExtractedPiece::into_stream_event)
            .collect()
    }

    /// 流终止收尾：冲刷剩余缓冲区并返回 ExtractedPiece 列表
    pub fn finish_pieces(&mut self) -> Vec<ExtractedPiece> {
        let mut pieces = Vec::new();
        if !self.lookahead_buf.is_empty() {
            match self.state {
                TagState::MatchingOpen | TagState::Text => {
                    pieces.push(ExtractedPiece::Text(std::mem::take(
                        &mut self.lookahead_buf,
                    )));
                    self.state = TagState::Text;
                }
                TagState::MatchingClose | TagState::Thinking => {
                    pieces.push(ExtractedPiece::Thought(std::mem::take(
                        &mut self.lookahead_buf,
                    )));
                    self.state = TagState::Thinking;
                }
            }
        }
        self.lookahead_buf.clear();
        self.active_tag_index = None;
        self.strip_leading_newline = false;
        pieces
    }

    /// 流终止收尾：冲刷剩余缓冲区并返回 ProviderStreamEvent 列表
    pub fn finish(&mut self) -> Vec<ProviderStreamEvent> {
        self.finish_pieces()
            .into_iter()
            .map(ExtractedPiece::into_stream_event)
            .collect()
    }

    /// 重置状态机到初始状态
    pub fn reset(&mut self) {
        self.state = TagState::Text;
        self.lookahead_buf.clear();
        self.active_tag_index = None;
        self.strip_leading_newline = false;
    }

    fn process_matching_open(
        &mut self,
        pieces: &mut Vec<ExtractedPiece>,
        current_text_batch: &mut String,
    ) {
        while !self.lookahead_buf.is_empty() {
            // 1. 完全匹配开标签
            if let Some(idx) = self.tags.iter().position(|t| t.open == self.lookahead_buf) {
                if !current_text_batch.is_empty() {
                    pieces.push(ExtractedPiece::Text(std::mem::take(current_text_batch)));
                }
                self.lookahead_buf.clear();
                self.state = TagState::Thinking;
                self.active_tag_index = Some(idx);
                self.strip_leading_newline = true;
                return;
            }

            // 2. 属于某开标签的前缀
            if self
                .tags
                .iter()
                .any(|t| t.open.starts_with(&self.lookahead_buf))
            {
                self.state = TagState::MatchingOpen;
                return;
            }

            // 3. 匹配失败，弹出首字符作为正文，继续考察剩余缓冲区
            if let Some(first_char) = self.lookahead_buf.chars().next() {
                current_text_batch.push(first_char);
                let char_len = first_char.len_utf8();
                self.lookahead_buf.drain(..char_len);
            } else {
                break;
            }
        }
        self.state = TagState::Text;
    }

    fn process_matching_close(
        &mut self,
        pieces: &mut Vec<ExtractedPiece>,
        current_thought_batch: &mut String,
    ) {
        while !self.lookahead_buf.is_empty() {
            // 1. 完全匹配闭标签（当 active_tag_index 为 Some(idx) 时，严格只允许匹配对应闭标签）
            let exact_match = if let Some(idx) = self.active_tag_index {
                self.tags
                    .get(idx)
                    .is_some_and(|t| self.lookahead_buf == t.close)
            } else {
                self.tags.iter().any(|t| t.close == self.lookahead_buf)
            };

            if exact_match {
                if !current_thought_batch.is_empty() {
                    pieces.push(ExtractedPiece::Thought(std::mem::take(
                        current_thought_batch,
                    )));
                }
                self.lookahead_buf.clear();
                self.state = TagState::Text;
                self.active_tag_index = None;
                self.strip_leading_newline = true;
                return;
            }

            // 2. 属于某闭标签的前缀
            let is_prefix = if let Some(idx) = self.active_tag_index {
                self.tags
                    .get(idx)
                    .is_some_and(|t| t.close.starts_with(&self.lookahead_buf))
            } else {
                self.tags
                    .iter()
                    .any(|t| t.close.starts_with(&self.lookahead_buf))
            };

            if is_prefix {
                self.state = TagState::MatchingClose;
                return;
            }

            // 3. 匹配失败，弹出首字符作为思考内容，继续考察剩余缓冲区
            if let Some(first_char) = self.lookahead_buf.chars().next() {
                current_thought_batch.push(first_char);
                let char_len = first_char.len_utf8();
                self.lookahead_buf.drain(..char_len);
            } else {
                break;
            }
        }
        self.state = TagState::Thinking;
    }
}

#[cfg(test)]
#[path = "think_tags_tests.rs"]
mod tests;
