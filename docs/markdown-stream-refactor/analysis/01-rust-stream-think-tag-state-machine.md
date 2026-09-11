# Rust 流式解析层 `<think>` 状态机与跨 Chunk 分割边界算法深度设计

> **文件路径**：`docs/markdown-stream-refactor/analysis/01-rust-stream-think-tag-state-machine.md`
> **所属战役**：Markdown 真流式渲染与正文退化根治战役 (`docs/markdown-stream-refactor/`)
> **权威副本与纪律**：`AGENTS.md` / `.agents/LOGIC_PLAN_NO_RETREAT.md`
> **核心目标**：根除正文界面纯文字化、推理逃逸为正文、多轮文字重复、Blocks 破坏性覆盖四大顽疾，在 Rust 实时流式解析层构筑 100% 确定性的思考标签状态机与协同契约。

---

## 一、背景诊断与根因穿透

### 1.1 现状缺陷表象与危害
在当前的 Conex / Crish 系统中，用户在与具备推理能力的模型（如 DeepSeek-R1、Qwen-QwQ、Ollama 本地模型、Gemini 2.0 Flash Thinking、以及各类 OpenAI 兼容网关）交互时，存在以下严重劣化体验：
1. **推理逃逸（Reasoning Escape）**：模型生成的 `<think>...</think>` 或 `<thought>...</thought>` 原始标签未被实时识别与剥离，逃逸为 `ProviderStreamEvent::TextDelta`，直接混入正文区。正文被大段模型自言自语（“Let me think...”, “首先分析用户的需求...”）污染，破坏排版与整洁度。
2. **跨 Token/Chunk 割裂（Token Fragmentation）**：流式传输以 SSE 帧到达，网络分片极其随机。例如 `<thi` 在 Frame 1、`nk>` 在 Frame 2；或 `</th` 在 Frame A、`ink>` 在 Frame B。传统的逐帧正则匹配或朴素字符串替换在跨帧边界下彻底失效，导致前半段 `<thi` 先行作为正文喷射，后续无法追回。
3. **多轮文字重复（Multi-turn Duplication）**：在多轮会话（`turnIndex > 0`）或重试恢复场景下，由于 `streaming.rs` 中实时轨（`DeltaSink`）与收口轨（`commit_message_with_deltas`）在历史回放与当前轮合并上的语义模糊，导致正文被整段重复叠加。
4. **Blocks 结构丢失**：流式结束后生成的 `AgentMessage.blocks` 与元数据 `metadata.thoughtBlocks` 存在同步盲区，前端时间线更新时发生破坏性全量覆盖，丢失工具卡片与思考折叠历史。

### 1.2 现有资产代码勘察与断层分析

通过对当前代码库核心资产的逐行勘察，定位到以下关键架构断层：

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   现有架构断层与逃逸链路                                  │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. crates/agent-provider/src/parse/chat_core.rs                                         │
│    delta.content 盲目推入 TextDelta:                                                    │
│    if let Some(text) = non_empty_string(delta.get("content")) {                         │
│        events.push(ProviderStreamEvent::TextDelta { text: text.to_owned() });           │
│    }                                                                                    │
│    ▲ 缺陷：仅依赖 delta.reasoning_content 显式 JSON 字段；对内嵌于 content 的标签 0 拦截!  │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ 2. crates/agent-provider/src/parse/gemini_core.rs                                       │
│    仅当 part.thought == true 时分流 ThoughtDelta，若代理内嵌 <thought> 于 text 则完全穿透  │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ 3. crates/session-loop/src/loop/handlers/streaming.rs                                   │
│    双轨事件分发机制缺乏严格的轮次隔离标尺，收口轨 emit_message_deltas 与实时轨 live_sink    │
│    在前端合并策略不当时极易诱发重复渲染                                                   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

#### A. `crates/agent-provider/src/parse/chat_core.rs`
- **代码断层**：在 `push_frame` 阶段（Lines 106-122），解析器仅读取 `delta.content` 并无条件构造 `ProviderStreamEvent::TextDelta`。虽然有对 `reasoning_content` / `reasoning` / `thinking` / `thought` 字段的读取，但对 DeepSeek-R1 / Ollama 等将 `<think>` 标签直接输出在 `content` 字符串内的场景完全不具备过滤与剥离能力。
- **后果**：所有 `<think>` 标签及其中间内容均作为普通正文流入下游。

#### B. `crates/agent-provider/src/parse/gemini_core.rs`
- **代码断层**：在 `push_frame` 阶段（Lines 153-170），仅通过 `part.get("thought") == Some(true)` 区分思考。当第三方 Gemini 中转代理或自定义提示词触发内联 `<thought>` 时，依然走正文分支（Lines 163-170）。

#### C. `crates/session-loop/src/stream.rs` & `streaming.rs`
- **代码断层**：`stream.rs` 内的 `Aggregate` 收集 `text` 和 `thought_blocks`。但如果 provider 层面产出的 `ProviderStreamEvent` 本身就错把思考标为 `TextDelta`，消费层 `ConsumeBuilder` 与最终构建消息的 `build_assistant_message` 将发生“垃圾进、垃圾出”（Garbage In, Garbage Out），将思考文本持久化为 `AgentMessageBlock::Text`，正文永久性被污染。

---

## 二、架构目标与效果锁（Effect Locks）

根据战役总方针，本设计必须严格锁定以下 4 项效果指标：

| 效果锁编号 | 名称 | 严格定义与验收标准 |
|:---|:---|:---|
| **效果锁 1** | **无推理逃逸** | 所有内嵌在 `content` 或 `text` 中的 `<think>...</think>`、`<thought>...</thought>`、`<thinking>...</thinking>` 标签及内部思考内容，在 Rust 流式第一站被 100% 实时剥离并转义为 `ProviderStreamEvent::ThoughtDelta`；正文 `TextDelta` 中绝对不包含任何思考标签或思考字符。 |
| **效果锁 2** | **零延迟边界流式** | 跨 Token、跨 Chunk、跨帧的标签边界处理时间复杂度为 $O(1)$，内存开销上限为 $O(\text{MaxTagLen}) \le 16\text{ Bytes}$，在非标签区域保持 0 拷贝与零缓冲延迟实时下发。 |
| **效果锁 3** | **绝对幂等零重复** | 严格规范 `streaming.rs` 中的 `delta_to_message_event`（实时轨）与 `build_assistant_message` / `commit_message_with_deltas`（收口轨）的协同边界，基于单调递增 `message_id` 与 `turn_index` 保证多轮会话重入与重试场景下的绝对幂等。 |
| **效果锁 4** | **Blocks 结构完备** | 保证流式结束时 `AgentMessage.blocks` 中 `Thought` 块、`Text` 块、`ToolCall` 块顺序清晰、元数据与明文双向一致，为前端折叠面板提供原生结构支撑。 |

---

## 三、流式标签提取状态机（`StreamingTagExtractor`）详细设计

### 3.1 状态机模型与状态定义

为了在流式字符/字节流中实时分辨正文与思考，并在遇到潜在标签时进行安全前瞻（Lookahead）与回滚（Rollback），设计 4 状态确定性有限状态机（DFA）：

```
                  ┌──────────────────────────────────────────────┐
                  │                                              │
                  ▼                                              │ Mismatch Rollback
        ┌───────────────────┐     '<' detected     ┌────────────────────────┐ (Flush TextDelta)
        │                   │ ───────────────────> │                        │
──────> │    State::Text    │                      │   State::MatchingOpen  │
        │  (Emit TextDelta) │ <─────────────────── │  (Buffer Lookahead)    │
        └───────────────────┘  Full open tag match └────────────────────────┘
                  ▲                                              │
                  │                                              │ Tag Matched
                  │                                              ▼
                  │                                ┌────────────────────────┐
                  │                                │                        │
                  │                                │    State::Thinking     │
                  │                                │  (Emit ThoughtDelta)   │
                  │                                └────────────────────────┘
                  │                                              │
                  │                                              │ '<' detected
                  │                                              ▼
        ┌───────────────────┐  Full close match    ┌────────────────────────┐
        │                   │ <─────────────────── │                        │
        │   Transition to   │                      │  State::MatchingClose  │
        │    State::Text    │ ───────────────────> │  (Buffer Lookahead)    │
        └───────────────────┘  Mismatch Rollback   └────────────────────────┘
                               (Flush ThoughtDelta)
```

#### 状态语义说明

1. **`State::Text`（默认正文态）**：
   - 处于正文输出阶段。
   - 输入普通字符：直接作为 `ProviderStreamEvent::TextDelta` 输出。
   - 输入 `<` 字符：不立即输出，转入 `State::MatchingOpen`，并将 `<` 压入滑动缓冲区 `lookahead_buf`。

2. **`State::MatchingOpen`（开标签前瞻匹配态）**：
   - 缓冲区已持有以 `<` 开头的若干字符。
   - 检查 `lookahead_buf` 是否精确匹配任何已注册的开标签（如 `<think>`, `<thought>`, `<thinking>`）：
     - **精确匹配成功**：丢弃缓冲区内的开标签内容（不向前端暴露标签字符），切换状态至 `State::Thinking`，清空缓冲区，并置位 `trim_leading_newline = true`（可选消除标签后紧随的第一个换行符）。
     - **属于某开标签的前缀**（如 `<th` 是 `<think>` 的前缀）：保持在 `State::MatchingOpen`，暂停向下游发射，等待下一字符/chunk。
     - **不匹配任何开标签的前缀**（如遇到 `<thin_` 或 `<a` 或 `<table`）：**触发回滚（Rollback）**！将 `lookahead_buf` 中的全部字符作为 `ProviderStreamEvent::TextDelta` 立即冲刷（Flush）向下游，清空缓冲区，状态回退至 `State::Text`。

3. **`State::Thinking`（思考内容提取态）**：
   - 处于思考内容输出阶段。
   - 输入普通字符：直接作为 `ProviderStreamEvent::ThoughtDelta { text, redacted: None }` 输出。
   - 输入 `<` 字符：不立即输出，转入 `State::MatchingClose`，并将 `<` 压入 `lookahead_buf`。

4. **`State::MatchingClose`（闭标签前瞻匹配态）**：
   - 缓冲区已持有在思考态下捕获的以 `<` 开头的字符（如 `</`, `</t`, `</th`）。
   - 检查 `lookahead_buf` 是否精确匹配对应的闭标签（如 `</think>`, `</thought>`, `</thinking>`）：
     - **精确匹配成功**：丢弃缓冲区内的闭标签内容，切换状态回 `State::Text`，清空缓冲区，置位 `trim_leading_newline = true`。
     - **属于某闭标签的前缀**（如 `</th` 是 `</think>` 的前缀）：保持在 `State::MatchingClose`，暂停发射，等待后续 chunk。
     - **不匹配任何闭标签的前缀**（如遇到 `</div` 或 `< 3`）：**触发回滚（Rollback）**！将 `lookahead_buf` 中的全部字符作为 `ProviderStreamEvent::ThoughtDelta` 立即冲刷向下游，清空缓冲区，状态回退至 `State::Thinking`。

5. **流终止收尾（`finish`）**：
   - 若流在 `State::MatchingOpen` 异常结束：将 `lookahead_buf` 剩余内容作为 `TextDelta` 冲刷。
   - 若流在 `State::MatchingClose` 异常结束：将 `lookahead_buf` 剩余内容作为 `ThoughtDelta` 冲刷。
   - 重置内部缓冲区与状态。

---

## 四、跨 Chunk 分割边界与滑动缓冲算法

### 4.1 边界分割挑战场景穷举

在现实大模型 SSE 流中，Token 切分点是完全不可预测的。以下是状态机必须正确处理的边界极端情况：

```
场景 1: 单标签被逐字切碎
Chunk 1: "<"
Chunk 2: "t"
Chunk 3: "h"
Chunk 4: "i"
Chunk 5: "n"
Chunk 6: "k"
Chunk 7: ">"
Chunk 8: "Reasoning content..."

场景 2: 闭标签跨越 Chunk 边界与正文粘连
Chunk A: "Step 1 complete. </th"
Chunk B: "ink>The answer is 42."

场景 3: 虚假前缀与回滚（False Alarm）
Chunk X: "In math, 3 < thin"
Chunk Y: "kness of the material"
=> 期望: Chunk X 暂停 "< thin", Chunk Y 判定不匹配后，立即将 "< thin" + "kness..." 完整作为 TextDelta 输出。

场景 4: 多重思考块（Multi-block Thinking）
Chunk 1: "<think>Plan A</think>"
Chunk 2: "Some text"
Chunk 3: "<think>Plan B</think>"
Chunk 4: "Final answer"
```

### 4.2 滑动缓冲与快速判定算法

为了实现零堆分配开销和极限吞吐，标签匹配采用预编译前缀集与固定容量小缓冲：

```rust
pub struct TagPair {
    pub open: &'static str,
    pub close: &'static str,
}

pub const SUPPORTED_TAGS: &[TagPair] = &[
    TagPair { open: "<think>", close: "</think>" },
    TagPair { open: "<thought>", close: "</thought>" },
    TagPair { open: "<thinking>", close: "</thinking>" },
];
```

#### 前缀判定逻辑（Prefix Matching Logic）
设当前滑动缓冲区内容为字符串切片 $S = \text{lookahead\_buf.as\_str()}$：
1. **开标签前缀检查**：
   $$\text{isOpenPrefix}(S) \iff \exists T \in \text{SUPPORTED\_TAGS}, \, T.\text{open}.\text{starts\_with}(S)$$
2. **开标签完全匹配检查**：
   $$\text{isOpenExact}(S) \iff \exists T \in \text{SUPPORTED\_TAGS}, \, T.\text{open} == S$$
3. **闭标签前缀检查**：
   $$\text{isClosePrefix}(S) \iff \exists T \in \text{SUPPORTED\_TAGS}, \, T.\text{close}.\text{starts\_with}(S)$$
4. **闭标签完全匹配检查**：
   $$\text{isCloseExact}(S) \iff \exists T \in \text{SUPPORTED\_TAGS}, \, T.\text{close} == S$$

由于最大闭标签长度 `</thinking>` 仅为 11 字节，缓冲区容量设为 16 字节即可容纳任意前缀匹配，整个判定在 CPU L1 Cache 中以常量时间 $O(1)$ 完成。

---

## 五、Rust 参考实现与集成接线

### 5.1 `StreamingTagExtractor` 核心模块实现

以下为生产级、具备完整错误防御和边界回滚能力的 Rust 实现：

```rust
//! crates/agent-provider/src/parse/tag_extractor.rs
//!
//! 实时流式标签剥离状态机：支持 <think>...</think> / <thought>...</thought> / <thinking>...</thinking>
//! 保证跨 Chunk 分割不漏字、不逃逸、回滚无损。

use crate::events::ProviderStreamEvent;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractorState {
    /// 正常正文态
    Text,
    /// 匹配开标签前瞻态
    MatchingOpen,
    /// 思考内容态
    Thinking,
    /// 匹配闭标签前瞻态
    MatchingClose,
}

#[derive(Debug, Clone)]
pub struct TagPair {
    pub open: &'static str,
    pub close: &'static str,
}

pub const DEFAULT_TAGS: &[TagPair] = &[
    TagPair { open: "<think>", close: "</think>" },
    TagPair { open: "<thought>", close: "</thought>" },
    TagPair { open: "<thinking>", close: "</thinking>" },
];

#[derive(Debug)]
pub struct StreamingTagExtractor {
    state: ExtractorState,
    lookahead_buf: String,
    tags: &'static [TagPair],
    active_tag_index: Option<usize>,
    /// 是否过滤紧随标签后的单个首换行（美化排版）
    trim_leading_newline: bool,
}

impl Default for StreamingTagExtractor {
    fn default() -> Self {
        Self::new(DEFAULT_TAGS)
    }
}

impl StreamingTagExtractor {
    pub fn new(tags: &'static [TagPair]) -> Self {
        Self {
            state: ExtractorState::Text,
            lookahead_buf: String::with_capacity(32),
            tags,
            active_tag_index: None,
            trim_leading_newline: false,
        }
    }

    /// 当前是否处于思考流态
    pub fn is_thinking(&self) -> bool {
        matches!(self.state, ExtractorState::Thinking | ExtractorState::MatchingClose)
    }

    /// 处理输入的文本增量，实时产出分解后的事件序列
    pub fn push_text(&mut self, text: &str) -> Vec<ProviderStreamEvent> {
        let mut events = Vec::new();
        let mut current_text_batch = String::new();
        let mut current_thought_batch = String::new();

        macro_rules! flush_batches {
            () => {
                if !current_text_batch.is_empty() {
                    events.push(ProviderStreamEvent::TextDelta {
                        text: std::mem::take(&mut current_text_batch),
                    });
                }
                if !current_thought_batch.is_empty() {
                    events.push(ProviderStreamEvent::ThoughtDelta {
                        text: std::mem::take(&mut current_thought_batch),
                        redacted: None,
                    });
                }
            };
        }

        for ch in text.chars() {
            // 处理标签后首个换行符消除逻辑
            if self.trim_leading_newline {
                self.trim_leading_newline = false;
                if ch == '\n' {
                    continue;
                }
            }

            match self.state {
                ExtractorState::Text => {
                    if ch == '<' {
                        flush_batches!();
                        self.lookahead_buf.push(ch);
                        self.state = ExtractorState::MatchingOpen;
                    } else {
                        current_text_batch.push(ch);
                    }
                }
                ExtractorState::MatchingOpen => {
                    self.lookahead_buf.push(ch);
                    // 1. 检查是否完全匹配某个开标签
                    if let Some(idx) = self.tags.iter().position(|t| t.open == self.lookahead_buf) {
                        flush_batches!();
                        self.lookahead_buf.clear();
                        self.state = ExtractorState::Thinking;
                        self.active_tag_index = Some(idx);
                        self.trim_leading_newline = true;
                    }
                    // 2. 检查是否仍是某个开标签的前缀
                    else if self.tags.iter().any(|t| t.open.starts_with(&self.lookahead_buf)) {
                        // 维持 MatchingOpen，继续缓冲
                    }
                    // 3. 匹配失败，触发回滚
                    else {
                        flush_batches!();
                        // 将缓冲的字符连同当前字符作为正文冲刷
                        current_text_batch.push_str(&self.lookahead_buf);
                        self.lookahead_buf.clear();
                        self.state = ExtractorState::Text;
                    }
                }
                ExtractorState::Thinking => {
                    if ch == '<' {
                        flush_batches!();
                        self.lookahead_buf.push(ch);
                        self.state = ExtractorState::MatchingClose;
                    } else {
                        current_thought_batch.push(ch);
                    }
                }
                ExtractorState::MatchingClose => {
                    self.lookahead_buf.push(ch);
                    let target_close = self
                        .active_tag_index
                        .map(|idx| self.tags[idx].close);

                    // 1. 检查是否完全匹配闭标签
                    let exact_match = match target_close {
                        Some(close) => self.lookahead_buf == close,
                        None => self.tags.iter().any(|t| t.close == self.lookahead_buf),
                    };

                    if exact_match {
                        flush_batches!();
                        self.lookahead_buf.clear();
                        self.state = ExtractorState::Text;
                        self.active_tag_index = None;
                        self.trim_leading_newline = true;
                    }
                    // 2. 检查是否仍是闭标签前缀
                    else {
                        let is_prefix = match target_close {
                            Some(close) => close.starts_with(&self.lookahead_buf),
                            None => self.tags.iter().any(|t| t.close.starts_with(&self.lookahead_buf)),
                        };

                        if is_prefix {
                            // 维持 MatchingClose，继续缓冲
                        } else {
                            // 3. 匹配失败，回滚为思考内容
                            flush_batches!();
                            current_thought_batch.push_str(&self.lookahead_buf);
                            self.lookahead_buf.clear();
                            self.state = ExtractorState::Thinking;
                        }
                    }
                }
            }
        }

        flush_batches!();
        events
    }

    /// 流结束收口：冲刷剩余缓冲区
    pub fn finish(&mut self) -> Vec<ProviderStreamEvent> {
        let mut events = Vec::new();
        if self.lookahead_buf.is_empty() {
            return events;
        }

        match self.state {
            ExtractorState::MatchingOpen | ExtractorState::Text => {
                events.push(ProviderStreamEvent::TextDelta {
                    text: std::mem::take(&mut self.lookahead_buf),
                });
                self.state = ExtractorState::Text;
            }
            ExtractorState::MatchingClose | ExtractorState::Thinking => {
                events.push(ProviderStreamEvent::ThoughtDelta {
                    text: std::mem::take(&mut self.lookahead_buf),
                    redacted: None,
                });
                self.state = ExtractorState::Thinking;
            }
        }

        self.lookahead_buf.clear();
        self.active_tag_index = None;
        self.trim_leading_newline = false;
        events
    }
}
```

---

### 5.2 在 `crates/agent-provider/src/parse/chat_core.rs` 中的接入设计

将 `StreamingTagExtractor` 嵌入 `ChatCompletionsParser`，确保：
1. **显式思考字段优先**（`reasoning_content` 等）。
2. **正文 `content` 经状态机过滤**，自动剥离内嵌 `<think>`。
3. **收口阶段 `finish` 自动 flush 剩余缓冲区**。

```rust
// 修改 crates/agent-provider/src/parse/chat_core.rs

use super::tag_extractor::StreamingTagExtractor;

#[derive(Debug, Default)]
pub struct ChatCompletionsParser {
    stream: StreamParser,
    collector: ToolCallCollector,
    finish_reason: Option<StopReason>,
    usage: Option<ProviderUsage>,
    terminated: bool,
    /// 新增：内嵌思考标签实时提取器
    tag_extractor: StreamingTagExtractor,
}

impl ChatCompletionsParser {
    pub fn push_frame(
        &mut self,
        frame: &SseFrame,
    ) -> Result<Vec<ProviderStreamEvent>, StreamParseError> {
        if self.terminated {
            return Ok(Vec::new());
        }
        let Some(data) = frame.data.as_deref() else {
            return Ok(Vec::new());
        };
        let Ok(payload) = serde_json::from_str::<Value>(data) else {
            return Ok(Vec::new());
        };
        let mut events = Vec::new();

        // 1. 错误帧处理 (保持既有逻辑)...
        // 2. usage 处理 (保持既有逻辑)...
        // 3. choice 处理 (保持既有逻辑)...

        // 4. delta 内容精准提取与分流
        let delta = choice.get("delta").and_then(Value::as_object);
        if let Some(delta) = delta {
            // A. 原生显式 reasoning_content 字段（最高优先级）
            if let Some(thought) = non_empty_string(delta.get("reasoning_content"))
                .or_else(|| non_empty_string(delta.get("reasoning")))
                .or_else(|| non_empty_string(delta.get("thinking")))
                .or_else(|| non_empty_string(delta.get("thinking_delta")))
                .or_else(|| non_empty_string(delta.get("thought")))
            {
                events.push(ProviderStreamEvent::ThoughtDelta {
                    text: thought.to_owned(),
                    redacted: None,
                });
            }

            // B. 正文 content 通过标签状态机过滤
            if let Some(raw_content) = non_empty_string(delta.get("content")) {
                let extracted_events = self.tag_extractor.push_text(raw_content);
                events.extend(extracted_events);
            }

            // C. tool_calls 增量合并 (保持既有逻辑)...
        }

        // 5. 非流式格式 message.content 兜底处理
        let message = choice.get("message").and_then(Value::as_object);
        if let Some(message) = message {
            // 工具调用处理 (保持既有逻辑)...
            if delta.is_none() {
                if let Some(text) = non_empty_string(message.get("content")) {
                    let extracted_events = self.tag_extractor.push_text(text);
                    events.extend(extracted_events);
                }
            }
        }

        self.stream.extend(events.clone())?;
        Ok(events)
    }

    pub fn finish(&mut self) -> Result<Vec<ProviderStreamEvent>, StreamParseError> {
        if self.terminated {
            return Ok(Vec::new());
        }
        let mut events = Vec::new();

        // 1. 冲刷标签状态机未决的缓冲区
        let remaining_tag_events = self.tag_extractor.finish();
        events.extend(remaining_tag_events);

        // 2. tool_call flush (保持既有逻辑)...
        // 3. 构造唯一 stop 事件 (保持既有逻辑)...

        self.stream.extend(events.clone())?;
        self.terminated = true;
        Ok(events)
    }
}
```

---

### 5.3 在 `crates/agent-provider/src/parse/gemini_core.rs` 中的接入设计

Gemini 协议同样挂载 `StreamingTagExtractor`，彻底解决未打标 `thought: true` 但正文输出 `<thought>` 标签的穿透问题：

```rust
// 修改 crates/agent-provider/src/parse/gemini_core.rs

// 在 parts 遍历循环中：
if part.get("thought").and_then(Value::as_bool) == Some(true) {
    if let Some(text) = non_empty_string(part.get("text")) {
        self.emitted_content = true;
        events.push(ProviderStreamEvent::ThoughtDelta {
            text: text.to_owned(),
            redacted: None,
        });
    }
    continue;
}

if let Some(text) = non_empty_string(part.get("text")) {
    self.emitted_content = true;
    // 使用 tag_extractor 进行正文/思考流式切分
    let extracted = self.tag_extractor.push_text(text);
    events.extend(extracted);
    continue;
}
```

---

## 六、`session-loop` 协同契约与多轮幂等性设计

### 6.1 双轨事件架构与全链路协同图

在 `session-loop` 中，为了兼顾**前端实时极速渲染（Zero Lag）**与**持久化数据完整性（Consistency）**，采用了双轨架构。必须严格理清两轨的职责分工：

```
                              [ProviderStreamEvent Stream]
                                            │
                                            ▼
                        ┌───────────────────────────────────────┐
                        │    streaming.rs: consume_stream()     │
                        └───────────────────────────────────────┘
                                     │             │
                    (实时轨 - Live Track)           (收口聚合轨 - Aggregate Track)
                                     │             │
                 delta_to_message_event()          │ builder.push(event)
                                     │             │
                                     ▼             ▼
                           ┌─────────────────┐ ┌───────────────────────┐
                           │    LiveSink     │ │    ConsumeBuilder     │
                           │  (MessageDelta) │ │   (Aggregate State)   │
                           └─────────────────┘ └───────────────────────┘
                                     │             │
                           [WebSocket / Tauri]     │ builder.finish()
                                     │             ▼
                                     │   ┌───────────────────────────┐
                                     │   │       ConsumeResult       │
                                     │   │ (text, thoughtBlocks, ..) │
                                     │   └───────────────────────────┘
                                     │             │
                                     │             ▼
                                     │   ┌───────────────────────────┐
                                     │   │  build_assistant_message  │
                                     │   │  (Thought/Text/Tool Blocks│
                                     │   └───────────────────────────┘
                                     │             │
                                     │             ▼
                                     │   ┌───────────────────────────┐
                                     │   │ commit_message_with_deltas│
                                     │   │ (MessageStart -> MessageEnd│
                                     │   └───────────────────────────┘
                                     │             │
                                     ▼             ▼
                           ┌─────────────────────────────────────────┐
                           │      Frontend / Workbench UI Store      │
                           │ (Real-time delta apply + Final Replace) │
                           └─────────────────────────────────────────┘
```

### 6.2 关键协同契约

#### 1. `delta_to_message_event` 契约
- **职责**：仅负责将原始 `ProviderStreamEvent::TextDelta` 与 `ProviderStreamEvent::ThoughtDelta` 实时包装为 `AgentEvent::MessageDelta`。
- **不变量**：
  - `block` 字段严格映射为 `AgentMessageBlock::Text { text }` 或 `AgentMessageBlock::Thought { text, redacted }`。
  - 必须绑定预先分配的 `assistant_message_id`，且在整个流生命周期内保持恒定。
  - 绝不产出 `ToolCall` 或 `Stop` 相关的 Delta。

#### 2. `build_assistant_message` 契约
- **职责**：流终结时，从 `ConsumeResult` 聚合状态构造最终的静态 `AgentMessage`。
- **Block 排布顺序固定律**：
  $$\text{Blocks} = [\text{ThoughtBlocks}\dots] \mathbin{\Vert} [\text{Text (if non-empty)}] \mathbin{\Vert} [\text{ToolCallBlocks}\dots]$$
- **双向一致性**：`message.blocks` 中的 `Thought` 块内容与 `metadata.thought` / `metadata.thoughtBlocks` 100% 同源对齐。

### 6.3 多轮文字重复与覆盖问题的根因与根治策略

#### 根因剖析
在先前的版本中，前端收到 `MessageStart` / `MessageDelta` / `MessageEnd` 时存在两种典型冲突逻辑：
1. **多轮 Delta 串染**：前端状态池在收到 `MessageDelta` 时未基于 `message_id` 建立独立的分桶（Buffer），而是直接向当前活动的会话文本进行 `+=` 拼接。当重试或多轮交互触发时，旧轮次的缓存未清空，导致“旧正文 + 新正文”双重打印。
2. **收口轨重复发射被重复消费**：`commit_message_with_deltas` 为了让收口事件流自闭合，在内存中执行了 `emit_message_deltas`。如果前端既监听了实时 live_sink，又无差别监听了收口轨的 `MessageDelta`，将导致全部文本恰好呈现 2 倍重复。

#### 根治策略
1. **Message ID 绝对绑定**：在 `streaming.rs` 开头由 `new_message_id("assistant")` 统一生成唯一 ID，所有实时 Delta、Start、End 事件强绑此 ID。
2. **Turn Index 显式标定**：`MessageEnd` 必须携带 `turn_index: Some(state.machine.context().turn_index)`。
3. **前端消费铁律（配合本设计）**：
   - 实时阶段：前端仅以 `(session_id, message_id)` 为键追加增量。
   - 收口阶段：`MessageEnd` 到达时，以携带的完整 `AgentMessage.blocks` 原子替换掉该 `message_id` 下的临时 Delta 累加值，彻底消灭字符漂移与重复。

---

## 七、单元测试用例设计与断言矩阵

为确保 `StreamingTagExtractor` 与 `ChatCompletionsParser` 的 100% 正确性，设计以下覆盖所有边界条件的单元测试套件：

### 7.1 标签状态机单元测试用例清单

```rust
#[cfg(test)]
mod tag_extractor_tests {
    use super::*;
    use crate::events::ProviderStreamEvent;

    fn extract_all(extractor: &mut StreamingTagExtractor, chunks: &[&str]) -> Vec<ProviderStreamEvent> {
        let mut events = Vec::new();
        for chunk in chunks {
            events.extend(extractor.push_text(chunk));
        }
        events.extend(extractor.finish());
        events
    }

    // Case 1: 标准单 Chunk 提取
    #[test]
    fn test_standard_single_chunk() {
        let mut extractor = StreamingTagExtractor::default();
        let events = extract_all(&mut extractor, &["<think>Hello thinking</think>World text"]);
        assert_eq!(
            events,
            vec![
                ProviderStreamEvent::ThoughtDelta { text: "Hello thinking".into(), redacted: None },
                ProviderStreamEvent::TextDelta { text: "World text".into() },
            ]
        );
    }

    // Case 2: 极限跨 Chunk 单字符分割（开标签与闭标签全切碎）
    #[test]
    fn test_extreme_token_fragmentation() {
        let mut extractor = StreamingTagExtractor::default();
        let chunks = &[
            "<", "t", "h", "i", "n", "k", ">",
            "P", "l", "a", "n", " ", "A",
            "<", "/", "t", "h", "i", "n", "k", ">",
            "A", "n", "s", "w", "e", "r",
        ];
        let events = extract_all(&mut extractor, chunks);

        let thoughts: String = events.iter().filter_map(|e| match e {
            ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
            _ => None,
        }).collect();

        let texts: String = events.iter().filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        }).collect();

        assert_eq!(thoughts, "Plan A");
        assert_eq!(texts, "Answer");
    }

    // Case 3: 虚假标签回滚（Rollback in Text State）
    #[test]
    fn test_false_open_tag_rollback() {
        let mut extractor = StreamingTagExtractor::default();
        // "<thin" 看起来像 "<think>"，但下一个字符是 "g"
        let chunks = &["3 < thin", "g is not tag"];
        let events = extract_all(&mut extractor, chunks);

        let texts: String = events.iter().filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        }).collect();

        assert_eq!(texts, "3 < thing is not tag");
        assert!(events.iter().all(|e| matches!(e, ProviderStreamEvent::TextDelta { .. })));
    }

    // Case 4: 思考态内的虚假闭标签回滚（Rollback in Thinking State）
    #[test]
    fn test_false_close_tag_rollback_in_thinking() {
        let mut extractor = StreamingTagExtractor::default();
        let chunks = &[
            "<think>Check 1: a </",
            "div> tag inside thought</think>Final Text",
        ];
        let events = extract_all(&mut extractor, chunks);

        let thoughts: String = events.iter().filter_map(|e| match e {
            ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
            _ => None,
        }).collect();

        let texts: String = events.iter().filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        }).collect();

        assert_eq!(thoughts, "Check 1: a </div> tag inside thought");
        assert_eq!(texts, "Final Text");
    }

    // Case 5: 流在开标签匹配中途异常终止（EOF in MatchingOpen）
    #[test]
    fn test_eof_in_matching_open() {
        let mut extractor = StreamingTagExtractor::default();
        let chunks = &["Text before <thi"];
        let events = extract_all(&mut extractor, chunks);

        let texts: String = events.iter().filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        }).collect();

        assert_eq!(texts, "Text before <thi");
    }

    // Case 6: 多重思考块支持
    #[test]
    fn test_multiple_thinking_blocks() {
        let mut extractor = StreamingTagExtractor::default();
        let chunks = &[
            "<think>Plan 1</think>Text 1",
            "<thought>Plan 2</thought>Text 2",
        ];
        let events = extract_all(&mut extractor, chunks);

        assert_eq!(
            events,
            vec![
                ProviderStreamEvent::ThoughtDelta { text: "Plan 1".into(), redacted: None },
                ProviderStreamEvent::TextDelta { text: "Text 1".into() },
                ProviderStreamEvent::ThoughtDelta { text: "Plan 2".into(), redacted: None },
                ProviderStreamEvent::TextDelta { text: "Text 2".into() },
            ]
        );
    }
}
```

---

## 八、总结与落地实施路径

### 8.1 架构收益矩阵

| 维度 | 改造前状况 | 改造后标准 |
|:---|:---|:---|
| **标签隔离度** | 依赖提供商 JSON 字段，正文严重被 `<think>` 污染 | **100% 状态机物理剥离**，正文 0 思考字符逃逸 |
| **流式流畅度** | 跨帧切碎导致标签泄露或正则延迟 | **$O(1)$ 零延迟滑动缓冲**，极速响应 |
| **多轮稳定性** | 多轮历史累积时偶发文字翻倍重复 | **Message ID + Turn Index 强约束**，绝对幂等 |
| **结构完整度** | 前端覆盖时 Blocks 丢失 | **Thought / Text / ToolCall 三段式有序收口** |

### 8.2 落地文件清单与分工指令

1. **新建** `crates/agent-provider/src/parse/tag_extractor.rs`：包含 `StreamingTagExtractor` 状态机与全套单测。
2. **改造** `crates/agent-provider/src/parse/chat_core.rs`：将 `StreamingTagExtractor` 接入 `delta.content` 解析流。
3. **改造** `crates/agent-provider/src/parse/gemini_core.rs`：接入 `tag_extractor` 兜底文本部分思考剥离。
4. **验证** `crates/session-loop/src/stream.rs` & `streaming.rs`：确保 `ThoughtDelta` 顺畅转换为 `AgentMessageBlock::Thought` 并完成全链路回归测试。

---
*本文档为 Conex / Crish 战役核心设计资产，遵循 UTF-8 编码，包含完备的算法推演、架构图与代码实现，作为后续编码实现的唯一标准依照。*
