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

/// 内部输出汇聚抽象：消除 `push_text` / `finish` 中先构造 `Vec<ExtractedPiece>`
/// 再二次分配 `Vec<ProviderStreamEvent>` 的中间堆开销。
trait PieceSink: Sized {
    fn from_text(text: String) -> Self;
    fn from_thought(text: String) -> Self;

    #[inline]
    fn single_text(text: String) -> Vec<Self> {
        vec![Self::from_text(text)]
    }

    #[inline]
    fn single_thought(text: String) -> Vec<Self> {
        vec![Self::from_thought(text)]
    }
}

impl PieceSink for ExtractedPiece {
    #[inline]
    fn from_text(text: String) -> Self {
        ExtractedPiece::Text(text)
    }

    #[inline]
    fn from_thought(text: String) -> Self {
        ExtractedPiece::Thought(text)
    }
}

impl PieceSink for ProviderStreamEvent {
    #[inline]
    fn from_text(text: String) -> Self {
        ProviderStreamEvent::TextDelta { text }
    }

    #[inline]
    fn from_thought(text: String) -> Self {
        ProviderStreamEvent::ThoughtDelta {
            text,
            redacted: None,
        }
    }
}

impl StreamingTagExtractor {
    pub fn new(tags: &'static [TagPair]) -> Self {
        Self {
            state: TagState::Text,
            // 惰性零分配：无跨 Chunk 标签前缀时不分配堆内存
            lookahead_buf: String::new(),
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

    /// 消费一个文本块，产出提取的片段列表（同 `push_chunk`）
    #[inline]
    pub fn feed(&mut self, chunk: &str) -> Vec<ExtractedPiece> {
        self.push_chunk(chunk)
    }

    /// 消费一个文本块，产出提取的片段列表
    #[inline]
    pub fn push_chunk(&mut self, chunk: &str) -> Vec<ExtractedPiece> {
        self.push_into(chunk)
    }

    /// 消费文本并直接转换为 ProviderStreamEvent（无中间 Vec<ExtractedPiece> 二次分配）
    #[inline]
    pub fn push_text(&mut self, text: &str) -> Vec<ProviderStreamEvent> {
        self.push_into(text)
    }

    /// 流终止收尾：冲刷剩余缓冲区并返回 ExtractedPiece 列表
    #[inline]
    pub fn finish_pieces(&mut self) -> Vec<ExtractedPiece> {
        self.finish_into()
    }

    /// 流终止收尾：冲刷剩余缓冲区并返回 ProviderStreamEvent 列表
    #[inline]
    pub fn finish(&mut self) -> Vec<ProviderStreamEvent> {
        self.finish_into()
    }

    /// 重置状态机到初始状态
    pub fn reset(&mut self) {
        self.state = TagState::Text;
        self.lookahead_buf.clear();
        self.active_tag_index = None;
        self.strip_leading_newline = false;
    }

    /// 消除标签后紧随的首个换行符（`\r\n` 或 `\n`），全程在 `&str` 切片上零拷贝推进
    #[inline]
    fn consume_leading_newline<'a>(&mut self, mut rest: &'a str) -> &'a str {
        while let Some(after_cr) = rest.strip_prefix('\r') {
            rest = after_cr;
        }
        if rest.is_empty() {
            return "";
        }
        self.strip_leading_newline = false;
        if let Some(after_lf) = rest.strip_prefix('\n') {
            rest = after_lf;
        }
        rest
    }

    fn push_into<S: PieceSink>(&mut self, chunk: &str) -> Vec<S> {
        if chunk.is_empty() {
            return Vec::new();
        }

        let mut rest = if self.strip_leading_newline {
            let trimmed = self.consume_leading_newline(chunk);
            if trimmed.is_empty() {
                return Vec::new();
            }
            trimmed
        } else {
            chunk
        };

        // 快速直通路径：无未决前瞻缓冲且不含 '<' 时，跳过状态机循环与临时缓冲直接发射
        if self.lookahead_buf.is_empty() && !rest.as_bytes().contains(&b'<') {
            return match self.state {
                TagState::Text | TagState::MatchingOpen => S::single_text(rest.to_owned()),
                TagState::Thinking | TagState::MatchingClose => S::single_thought(rest.to_owned()),
            };
        }

        let mut pieces: Vec<S> = Vec::new();
        let mut current_text_batch = String::new();
        let mut current_thought_batch = String::new();

        while !rest.is_empty() {
            if self.strip_leading_newline {
                rest = self.consume_leading_newline(rest);
                if rest.is_empty() {
                    break;
                }
            }

            match self.state {
                TagState::Text => {
                    let mut search_pos = 0;
                    let mut transitioned = false;
                    while let Some(rel_pos) = rest[search_pos..].find('<') {
                        let pos = search_pos + rel_pos;
                        let candidate = &rest[pos..];

                        // 1. 原地切片完整匹配开标签（零 lookahead_buf 拷贝）
                        if let Some(idx) =
                            self.tags.iter().position(|t| candidate.starts_with(t.open))
                        {
                            let open_tag = self.tags[idx].open;
                            let before = &rest[..pos];
                            if !current_text_batch.is_empty() {
                                current_text_batch.push_str(before);
                                pieces.push(S::from_text(std::mem::take(&mut current_text_batch)));
                            } else if !before.is_empty() {
                                pieces.push(S::from_text(before.to_owned()));
                            }
                            self.state = TagState::Thinking;
                            self.active_tag_index = Some(idx);
                            self.strip_leading_newline = true;
                            rest = &candidate[open_tag.len()..];
                            transitioned = true;
                            break;
                        }

                        // 2. 切片尾部属于某开标签前缀（仅跨 Chunk 边界时写入 lookahead_buf）
                        if self.tags.iter().any(|t| t.open.starts_with(candidate)) {
                            let before = &rest[..pos];
                            if !before.is_empty() {
                                current_text_batch.push_str(before);
                            }
                            self.lookahead_buf.push_str(candidate);
                            self.state = TagState::MatchingOpen;
                            rest = "";
                            transitioned = true;
                            break;
                        }

                        // 3. 普通 '<'（如数学符号 "1 < 2" 或非思考 HTML 标签），原地跳过零拷贝
                        search_pos = pos + 1;
                    }

                    if !transitioned {
                        if current_text_batch.is_empty()
                            && pieces.is_empty()
                            && current_thought_batch.is_empty()
                        {
                            return S::single_text(rest.to_owned());
                        }
                        current_text_batch.push_str(rest);
                        break;
                    }
                }
                TagState::MatchingOpen => {
                    let ch = rest.chars().next().expect("rest is non-empty");
                    rest = &rest[ch.len_utf8()..];
                    self.lookahead_buf.push(ch);
                    self.process_matching_open(&mut pieces, &mut current_text_batch);
                }
                TagState::Thinking => {
                    let mut search_pos = 0;
                    let mut transitioned = false;
                    while let Some(rel_pos) = rest[search_pos..].find('<') {
                        let pos = search_pos + rel_pos;
                        let candidate = &rest[pos..];

                        // 1. 原地切片完整匹配对应闭标签（零 lookahead_buf 拷贝）
                        let matched_close_len = if let Some(idx) = self.active_tag_index {
                            self.tags.get(idx).and_then(|t| {
                                candidate.starts_with(t.close).then_some(t.close.len())
                            })
                        } else {
                            self.tags
                                .iter()
                                .find(|t| candidate.starts_with(t.close))
                                .map(|t| t.close.len())
                        };

                        if let Some(close_len) = matched_close_len {
                            let before = &rest[..pos];
                            if !current_thought_batch.is_empty() {
                                current_thought_batch.push_str(before);
                                pieces.push(S::from_thought(std::mem::take(
                                    &mut current_thought_batch,
                                )));
                            } else if !before.is_empty() {
                                pieces.push(S::from_thought(before.to_owned()));
                            }
                            self.state = TagState::Text;
                            self.active_tag_index = None;
                            self.strip_leading_newline = true;
                            rest = &candidate[close_len..];
                            transitioned = true;
                            break;
                        }

                        // 2. 切片尾部属于对应闭标签前缀（仅跨 Chunk 边界时写入 lookahead_buf）
                        let is_prefix = if let Some(idx) = self.active_tag_index {
                            self.tags
                                .get(idx)
                                .is_some_and(|t| t.close.starts_with(candidate))
                        } else {
                            self.tags.iter().any(|t| t.close.starts_with(candidate))
                        };

                        if is_prefix {
                            let before = &rest[..pos];
                            if !before.is_empty() {
                                current_thought_batch.push_str(before);
                            }
                            self.lookahead_buf.push_str(candidate);
                            self.state = TagState::MatchingClose;
                            rest = "";
                            transitioned = true;
                            break;
                        }

                        // 3. 思考链内的非匹配 '<'（如 "</div>" 或异名闭标签），原地跳过零拷贝
                        search_pos = pos + 1;
                    }

                    if !transitioned {
                        if current_thought_batch.is_empty()
                            && pieces.is_empty()
                            && current_text_batch.is_empty()
                        {
                            return S::single_thought(rest.to_owned());
                        }
                        current_thought_batch.push_str(rest);
                        break;
                    }
                }
                TagState::MatchingClose => {
                    let ch = rest.chars().next().expect("rest is non-empty");
                    rest = &rest[ch.len_utf8()..];
                    self.lookahead_buf.push(ch);
                    self.process_matching_close(&mut pieces, &mut current_thought_batch);
                }
            }
        }

        if !current_text_batch.is_empty() {
            pieces.push(S::from_text(current_text_batch));
        }
        if !current_thought_batch.is_empty() {
            pieces.push(S::from_thought(current_thought_batch));
        }

        pieces
    }

    fn finish_into<S: PieceSink>(&mut self) -> Vec<S> {
        let pieces = if !self.lookahead_buf.is_empty() {
            match self.state {
                TagState::MatchingOpen | TagState::Text => {
                    self.state = TagState::Text;
                    S::single_text(std::mem::take(&mut self.lookahead_buf))
                }
                TagState::MatchingClose | TagState::Thinking => {
                    self.state = TagState::Thinking;
                    S::single_thought(std::mem::take(&mut self.lookahead_buf))
                }
            }
        } else {
            Vec::new()
        };
        self.active_tag_index = None;
        self.strip_leading_newline = false;
        pieces
    }

    fn process_matching_open<S: PieceSink>(
        &mut self,
        pieces: &mut Vec<S>,
        current_text_batch: &mut String,
    ) {
        let mut cursor = 0;
        while cursor < self.lookahead_buf.len() {
            let remaining = &self.lookahead_buf[cursor..];
            // 1. 完全匹配开标签
            if let Some(idx) = self.tags.iter().position(|t| t.open == remaining) {
                if cursor > 0 {
                    current_text_batch.push_str(&self.lookahead_buf[..cursor]);
                }
                if !current_text_batch.is_empty() {
                    pieces.push(S::from_text(std::mem::take(current_text_batch)));
                }
                self.lookahead_buf.clear();
                self.state = TagState::Thinking;
                self.active_tag_index = Some(idx);
                self.strip_leading_newline = true;
                return;
            }

            // 2. 属于某开标签的前缀
            if self.tags.iter().any(|t| t.open.starts_with(remaining)) {
                if cursor > 0 {
                    current_text_batch.push_str(&self.lookahead_buf[..cursor]);
                    self.lookahead_buf.drain(..cursor);
                }
                self.state = TagState::MatchingOpen;
                return;
            }

            // 3. 匹配失败，游标前移首字符，避免逐字符 drain 引发 O(N^2) 搬移
            if let Some(first_char) = remaining.chars().next() {
                cursor += first_char.len_utf8();
            } else {
                break;
            }
        }
        if !self.lookahead_buf.is_empty() {
            current_text_batch.push_str(&self.lookahead_buf);
            self.lookahead_buf.clear();
        }
        self.state = TagState::Text;
    }

    fn process_matching_close<S: PieceSink>(
        &mut self,
        pieces: &mut Vec<S>,
        current_thought_batch: &mut String,
    ) {
        let mut cursor = 0;
        while cursor < self.lookahead_buf.len() {
            let remaining = &self.lookahead_buf[cursor..];
            // 1. 完全匹配闭标签（当 active_tag_index 为 Some(idx) 时，严格只允许匹配对应闭标签）
            let exact_match = if let Some(idx) = self.active_tag_index {
                self.tags.get(idx).is_some_and(|t| remaining == t.close)
            } else {
                self.tags.iter().any(|t| t.close == remaining)
            };

            if exact_match {
                if cursor > 0 {
                    current_thought_batch.push_str(&self.lookahead_buf[..cursor]);
                }
                if !current_thought_batch.is_empty() {
                    pieces.push(S::from_thought(std::mem::take(current_thought_batch)));
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
                    .is_some_and(|t| t.close.starts_with(remaining))
            } else {
                self.tags.iter().any(|t| t.close.starts_with(remaining))
            };

            if is_prefix {
                if cursor > 0 {
                    current_thought_batch.push_str(&self.lookahead_buf[..cursor]);
                    self.lookahead_buf.drain(..cursor);
                }
                self.state = TagState::MatchingClose;
                return;
            }

            // 3. 匹配失败，游标前移首字符，避免逐字符 drain 引发 O(N^2) 搬移
            if let Some(first_char) = remaining.chars().next() {
                cursor += first_char.len_utf8();
            } else {
                break;
            }
        }
        if !self.lookahead_buf.is_empty() {
            current_thought_batch.push_str(&self.lookahead_buf);
            self.lookahead_buf.clear();
        }
        self.state = TagState::Thinking;
    }
}

#[cfg(test)]
#[path = "think_tags_tests.rs"]
mod tests;
