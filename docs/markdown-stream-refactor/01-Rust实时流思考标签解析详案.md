# 01-分维实现详案：Rust 实时流思考标签解析与状态机设计

> **所属战役**：`docs/markdown-stream-refactor/`  
> **核心目标**：在 Rust 协议解析层实时拦截并剥离模型内嵌的 `<think>` / `<thought>` 标签，精准分流 `ThoughtDelta` 与 `TextDelta`，彻底根除推理文字逃逸至正文。  
> **涉及文件**：
> - `crates/agent-provider/src/parse/think_tags.rs` (新建通用模块)
> - `crates/agent-provider/src/parse/chat_core.rs` (修改集成)
> - `crates/agent-provider/src/parse/gemini_core.rs` (修改集成)
> - `crates/agent-provider/src/parse/think_tags_tests.rs` (新建单元测试)

---

## 1. 核心状态机架构设计：`StreamingTagExtractor`

为了在任意 Token 切割粒度下（甚至单个字符跨 Chunk）实现 $O(1)$ 时间复杂度、零拷贝/最小拷贝的标签识别，设计 4 状态确定性有限状态机（DFA）：

```
                  ┌──────────── '<' ───────────┐
                  ▼                            │
          ┌───────────────┐            ┌───────────────┐
          │  State::Text  │ ─── 字符 ──> │ MatchingOpen  │
          └───────────────┘            └───────────────┘
                  ▲                            │
                  │                        完全匹配开标签
               完全匹配闭标签                     │
                  │                            ▼
          ┌───────────────┐            ┌───────────────┐
          │ MatchingClose │ <─── '<' ── │ State::Think  │
          └───────────────┘            └───────────────┘
```

### 状态定义与滑动前瞻缓冲

```rust
pub enum TagState {
    /// 当前处于普通正文段落
    Text,
    /// 遇到了 '<'，正在前瞻匹配开标签（如 "<think>" / "<thought>" / "<thinking>"）
    MatchingOpen,
    /// 当前处于思考链内部
    Thinking,
    /// 思考链中遇到了 '<'，正在前瞻匹配闭标签（如 "</think>" / "</thought>"）
    MatchingClose,
}

pub struct StreamingTagExtractor {
    state: TagState,
    /// 前瞻滑动缓冲区（最大容量 16 字节，涵盖最长 "</thinking>"）
    lookahead_buf: String,
    /// 标记刚闭合思考标签，自适应消费紧随其后的首个换行符 '\n'
    strip_leading_newline: bool,
}
```

---

## 2. 跨 Chunk 边界处理算法

### 核心推进算法逻辑 (`push_chunk`)

1. **增量字符扫描**：
   - 逐字符遍历输入的 `chunk`。
2. **前瞻缓冲入队**：
   - 在 `Text` 态遇到 `'<'` $\to$ 跃迁至 `MatchingOpen`，字符压入 `lookahead_buf`。
   - 在 `Thinking` 态遇到 `'<'` $\to$ 跃迁至 `MatchingClose`，字符压入 `lookahead_buf`。
3. **前缀有效性校验**：
   - 检查 `lookahead_buf` 是否为支持标签（`<think>` / `<thought>` / `<thinking>` 及其闭合版）的**合法前缀**。
   - **完全匹配成功**：
     - 开标签匹配 $\to$ 丢弃标签本身，跃迁至 `Thinking` 态。
     - 闭标签匹配 $\to$ 丢弃标签本身，标记 `strip_leading_newline = true`，跃迁至 `Text` 态。
   - **前缀不匹配（虚假标签回滚）**：
     - 若在 `MatchingOpen` 遇到例如 `"<table"` $\to$ 判定非思考标签，将 `lookahead_buf` 内已累积的字符作为普通 `TextDelta` 吐出，重置缓冲区并跃迁回 `Text`。
     - 若在 `MatchingClose` 遇到例如 `"<code"` $\to$ 将 `lookahead_buf` 字符作为 `ThoughtDelta` 吐出，跃迁回 `Thinking`。
4. **流结束冲刷 (`finish`)**：
   - 当 LLM SSE 流正常结束或异常截断时，调用 `extractor.finish()`。
   - 若 `lookahead_buf` 中仍残留未闭合的虚假前缀字符，根据当前状态将其分别冲刷为最后的 `TextDelta` 或 `ThoughtDelta`，确保零丢字。

---

## 3. 提供方解析器集成方案

### 3.1 `chat_core.rs` 集成

```rust
// ChatStreamParser 结构体装配
pub struct ChatStreamParser {
    // ... 既有字段 ...
    tag_extractor: StreamingTagExtractor,
}

// 在 parse_chunk 的 delta.content 处理路径：
if let Some(content) = non_empty_string(delta.get("content")) {
    let pieces = self.tag_extractor.push_chunk(content);
    for piece in pieces {
        match piece {
            ExtractedPiece::Text(t) => {
                events.push(ProviderStreamEvent::TextDelta { text: t });
            }
            ExtractedPiece::Thought(th) => {
                events.push(ProviderStreamEvent::ThoughtDelta {
                    text: th,
                    redacted: None,
                });
            }
        }
    }
}
```

### 3.2 优先级判定契约

```
[显式字段 reasoning_content / reasoning / thinking] ──> (最高优先级，直接 ThoughtDelta)
                          │ (不存在时)
                          ▼
[content 字段] ──> StreamingTagExtractor 流式状态机 ──> ThoughtDelta / TextDelta 分流
```

---

## 4. 交付验收断言

- **断言 1**：输入 `"<thi"` + `"nk>hello</th"` + `"ink>world"`，严格产出 1 个 `ThoughtDelta("hello")` 与 1 个 `TextDelta("world")`，`<think>` 标签 0 泄露。
- **断言 2**：输入 `"1 < 2 and 3 > 2"`，严格产出纯 `TextDelta`，虚假前缀回滚无丢字。
- **断言 3**：`cargo test -p conex-agent-provider` 单元测试 100% 通过。
