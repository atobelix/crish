# Rust 协议层与标签状态机严苛挑刺审查报告

> **审查范围**：
> - `crates/agent-provider/src/parse/think_tags.rs`
> - `crates/agent-provider/src/parse/chat_core.rs`
> - `crates/agent-provider/src/parse/gemini_core.rs`
> - `crates/session-loop/src/loop/handlers/streaming.rs`
> - `crates/session-loop/src/stream.rs`
>
> **审查基准**：只记录缺陷、漏洞、时序 Bug、Panic 风险、内存/性能隐患与协议契约偏离，严禁套话与正面评价。

---

## 目录
1. [【致命】纯思考流判空崩溃、元数据丢弃与 Abort 抢救归零 (`stream.rs` / `consume/mod.rs`)](#1-致命纯思考流判空崩溃元数据丢弃与-abort-抢救归零)
2. [【严重】`thoughtBlocks` 字段漏检、时序块强制重排与 Delta 碎片爆炸 (`streaming.rs`)](#2-严重thoughtblocks-字段漏检时序块强制重排与-delta-碎片爆炸)
3. [【严重】异名闭标签劫持、状态复用悬挂、回车符静默吞噬与回退缺陷 (`think_tags.rs`)](#3-严重异名闭标签劫持状态复用悬挂回车符静默吞噬与回退缺陷)
4. [【严重】错误帧/阻断帧到达时前瞻缓冲区静默丢弃与假死缺陷 (`chat_core.rs` / `gemini_core.rs`)](#4-严重错误帧阻断帧到达时前瞻缓冲区静默丢弃与假死缺陷)
5. [【隐患】内存多重放大分配、无界流 OOM 与 `drain()` $O(K^2)$ 搬移隐患](#5-隐患内存多重放大分配无界流-oom-与-draink2-搬移隐患)
6. [【排查】潜在 Panic 点、`.unwrap()` / `.expect()` 与 UTF-8 多字节边界排查清单](#6-排查潜在-panic-点unwrap--expect-与-utf-8-多字节边界排查清单)
7. [【清单】协议层与状态机缺陷索引表](#7-清单协议层与状态机缺陷索引表)

---

## 1. 【致命】纯思考流判空崩溃、元数据丢弃与 Abort 抢救归零

### 缺陷 1.1：`has_content` 忽略 `aggregate.thought`，导致纯思考流被判定为 Empty / 丢弃元数据
- **涉及源码**：
  - [`crates/session-loop/src/stream.rs:398`](file:///c:/Software/conex/crates/session-loop/src/stream.rs#L398)
  - [`crates/session-loop/src/stream.rs:438`](file:///c:/Software/conex/crates/session-loop/src/stream.rs#L438)
  - [`crates/agent-provider/src/consume/mod.rs:321`](file:///c:/Software/conex/crates/agent-provider/src/consume/mod.rs#L321)
- **代码现场**：
  ```rust
  // stream.rs:398 & stream.rs:438
  let has_content = !aggregate.text.is_empty() || !aggregate.tool_calls.is_empty();
  if !has_content && aggregate.error.is_none() {
      return ConsumeResult {
          response: ProviderOutput::Empty,
          diagnostics: aggregate.diagnostics,
          metadata: Value::Null, // <-- 致命：清空了全部元数据！
      };
  }
  if !has_content {
      let message = aggregate.error.unwrap_or_default();
      return ConsumeResult {
          response: ProviderOutput::stream_error(classify_stream_error(&message)),
          diagnostics: aggregate.diagnostics,
          metadata: Value::Null, // <-- 致命：清空了全部元数据！
      };
  }
  ```
- **机理与后果**：
  1. `has_content` 只检查了 `text` 与 `tool_calls`，**完全遗漏了 `thought` 与 `thought_blocks`**。
  2. **正常完成场景**：当推理模型（如 DeepSeek-R1、o1/o3、Gemini Flash Thinking）仅产出了思考流，正文尚未生成即结束（例如思考预算耗尽或自然停顿）时，`has_content` 返回 `false`，导致响应被错误归类为 `ProviderOutput::Empty`，且 `metadata` 被强置为 `Value::Null`。上层 `streaming.rs:291` 收到 `Empty` 后误判为需要 Steering 注入或触发“steering 已禁用，空响应无法恢复”致命退出。模型生成的数千 token 思考过程被彻底抹杀。
  3. **流中错误场景**：若模型在深度思考过程中发生网络断开、超时或服务端报错（尚未输出正文），`has_content` 判定为 `false`，直接进入 `StreamError` 分支，`metadata` 同样变为 `Value::Null`，违反 RFC 01 D6（内容保留原则），已收到的全部思考内容被物理销毁。

### 缺陷 1.2：Abort 抢救 (Partial Salvage) 在纯思考状态下完全失效
- **涉及源码**：[`crates/session-loop/src/stream.rs:437-458`](file:///c:/Software/conex/crates/session-loop/src/stream.rs#L437-L458)
- **代码现场**：
  ```rust
  fn finish_after_abort(aggregate: Aggregate, accounting: CacheAccounting) -> ConsumeResult {
      let has_content = !aggregate.text.is_empty() || !aggregate.tool_calls.is_empty();
      if !has_content {
          let message = aggregate.error.unwrap_or_else(|| "aborted".to_string());
          return ConsumeResult {
              response: ProviderOutput::stream_error(ClassifiedStreamError {
                  kind: ProviderErrorKind::Aborted,
                  message,
                  retryable: false,
                  retry_after_ms: None,
              }),
              diagnostics: aggregate.diagnostics,
              metadata: Value::Null,
          };
      }
      // ...
  }
  ```
- **机理与后果**：用户在模型思考阶段触发中断（Ctrl+C / Abort），`finish_after_abort` 因 `has_content == false` 直接将响应打为 `StreamError` 并丢弃 `metadata`，导致思考阶段的中断无法进行 Partial Salvage，前端界面上原本正在流式打印的思考文字在中断瞬间全部消失。

---

## 2. 【严重】`thoughtBlocks` 字段漏检、时序块强制重排与 Delta 碎片爆炸

### 缺陷 2.1：`build_assistant_message` 破坏多模态/图文/思考交错的时间序列，强制硬编码块顺序
- **涉及源码**：[`crates/session-loop/src/loop/handlers/streaming.rs:597-623`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L597-L623)
- **代码现场**：
  ```rust
  fn build_assistant_message(
      consumed: &ConsumeResult,
      message_id: &str,
      text: String,
      tool_calls: Vec<ToolCallBlock>,
      client_message_id: Option<&str>,
  ) -> AgentMessage {
      let mut blocks: Vec<AgentMessageBlock> = Vec::new();
      // 1. 全部 Thought 块先塞入
      if let Some(blocks_value) = consumed
          .metadata
          .get("thoughtBlocks")
          .and_then(|v| v.as_array())
      {
          for block in blocks_value {
              if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                  blocks.push(AgentMessageBlock::Thought {
                      text: text.to_string(),
                      redacted: block.get("redacted").and_then(|v| v.as_bool()),
                  });
              }
          }
      }
      // 2. 全部 Text 拼接后作为一个单块塞入
      if !text.is_empty() {
          blocks.push(AgentMessageBlock::Text { text });
      }
      // 3. 全部 ToolCall 塞入
      for call in tool_calls {
          blocks.push(AgentMessageBlock::ToolCall(call));
      }
      // ...
  }
  ```
- **机理与后果**：
  1. 当流中出现交错序列（例如：`<think>思考1</think>正文1<think>思考2</think>正文2` 或 `正文1 -> ToolCall -> 正文2`），`stream.rs` 中在 `push` 时将正文无脑拼接成单个 `aggregate.text`，而在 `build_assistant_message` 中又将全部思考块置顶，使得组装出的 `blocks` 永远是 `[Thought..., Text, ToolCall...]`。
  2. 真实的时序结构被不可逆地破坏，`正文1` 和 `正文2` 的隔离丢失，思考块与正文块的相对位置完全颠倒。

### 缺陷 2.2：脱敏思考块（`redacted: true`）因 `text` 字段缺失被静默丢弃
- **涉及源码**：[`crates/session-loop/src/loop/handlers/streaming.rs:605-610`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L605-L610)
- **代码现场**：
  ```rust
  for block in blocks_value {
      if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
          blocks.push(AgentMessageBlock::Thought {
              text: text.to_string(),
              redacted: block.get("redacted").and_then(|v| v.as_bool()),
          });
      }
  }
  ```
- **机理与后果**：
  部分上游协议（如 OpenAI Responses / Anthropic Redacted Reasoning）可能仅下发 `redacted: true` 标记或附带占位空文本。若 `block` 中无 `text` 字段或 `text` 为空/null，`block.get("text")` 返回 `None`，整个脱敏思考块被直接 `continue` 跳过并静默丢弃，导致安全审计/脱敏占位元数据丢失。

### 缺陷 2.3：`thoughtBlocks` 逐 Delta 碎裂未合并，导致 `AgentMessage.blocks` 膨胀数百倍并引发收口轨重发异常
- **涉及源码**：
  - [`crates/session-loop/src/stream.rs:288-290`](file:///c:/Software/conex/crates/session-loop/src/stream.rs#L288-L290)
  - [`crates/session-loop/src/loop/handlers/streaming.rs:695-710`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/streaming.rs#L695-L710)
- **代码现场**：
  ```rust
  // stream.rs:288-290
  ProviderStreamEvent::ThoughtDelta { text, redacted } => {
      self.thought.push_str(&text);
      self.thought_blocks.push(ThoughtBlock { text, redacted }); // <-- 每一个 Delta token 都推一个元素！
  }

  // streaming.rs:695-710
  fn emit_message_deltas(state: &mut LoopState, message: &AgentMessage) {
      let session_id = state.machine.context().session_id.clone();
      for block in &message.blocks {
          if matches!(block, AgentMessageBlock::Text { .. } | AgentMessageBlock::Thought { .. }) {
              state.events.push(AgentEvent::MessageDelta {
                  session_id: session_id.clone(),
                  timestamp: conex_shared::time::now_iso_utc(),
                  message_id: message.id.clone(),
                  block: block.clone(),
              });
          }
      }
  }
  ```
- **机理与后果**：
  1. `stream.rs` 中每次收到 `ThoughtDelta`，都向 `thought_blocks` 新增一个只有 1~2 个字符的 `ThoughtBlock`。
  2. `streaming.rs` 将这些成百上千个微型块原样转成 `message.blocks` 中的 `AgentMessageBlock::Thought`。
  3. `commit_message_with_deltas` 调用 `emit_message_deltas` 时，对于 `Thought`，它会连续发射数百个单字 `MessageDelta`；而对于 `Text`，它却发射一个包含全文的超大 `MessageDelta`。
  4. 数据结构极度不一致：`Text` 是聚合态，`Thought` 却被永久保留为 Delta 碎屑态，严重破坏了 `AgentMessage` 作为终态持久化实体的契约。

---

## 3. 【严重】异名闭标签劫持、状态复用悬挂、回车符静默吞噬与回退缺陷

### 缺陷 3.1：`finish_pieces` 遗留 `TagState::Thinking` 悬挂状态，导致实例复用时闭标签配对被异名闭标签提前劫持
- **涉及源码**：[`crates/agent-provider/src/parse/think_tags.rs:171-189`](file:///c:/Software/conex/crates/agent-provider/src/parse/think_tags.rs#L171-L189)
- **代码现场**：
  ```rust
  pub fn finish_pieces(&mut self) -> Vec<ExtractedPiece> {
      let mut pieces = Vec::new();
      if !self.lookahead_buf.is_empty() {
          match self.state {
              TagState::MatchingOpen | TagState::Text => {
                  pieces.push(ExtractedPiece::Text(std::mem::take(&mut self.lookahead_buf)));
                  self.state = TagState::Text;
              }
              TagState::MatchingClose | TagState::Thinking => {
                  pieces.push(ExtractedPiece::Thought(std::mem::take(&mut self.lookahead_buf)));
                  self.state = TagState::Thinking; // <-- 保持在 Thinking
              }
          }
      }
      self.lookahead_buf.clear();
      self.active_tag_index = None; // <-- 激活标签被清空！
      self.strip_leading_newline = false;
      pieces
  }
  ```
- **机理与后果**：
  1. 当状态机在处于 `TagState::Thinking` 且 `lookahead_buf` 为空时调用了 `finish_pieces()`，`self.state` 保持为 `TagState::Thinking`，而 `active_tag_index` 被置为 `None`。
  2. 若该状态机实例被重用消费后续文本（或在长连接中未显式 `reset()`）：
     ```rust
     // think_tags.rs:250-256
     let exact_match = if let Some(idx) = self.active_tag_index {
         self.tags.get(idx).is_some_and(|t| self.lookahead_buf == t.close)
     } else {
         self.tags.iter().any(|t| t.close == self.lookahead_buf) // <-- 任意闭标签均可匹配！
     };
     ```
  3. 因为 `active_tag_index` 为 `None`，原本因 `<think>` 开启的思考流，在遇到 `</thought>` 或 `</thinking>` 时会被立即匹配成功并提前关闭，**思考流被异名闭标签非法截断劫持**。

### 缺陷 3.2：`strip_leading_newline` 状态机遇孤立 `\r` 时状态未复位，造成连续 `\r` 与格式静默吞噬
- **涉及源码**：[`crates/agent-provider/src/parse/think_tags.rs:114-122`](file:///c:/Software/conex/crates/agent-provider/src/parse/think_tags.rs#L114-L122)
- **代码现场**：
  ```rust
  if self.strip_leading_newline {
      if ch == '\r' {
          continue; // <-- 缺陷：未将 strip_leading_newline 置为 false！
      }
      self.strip_leading_newline = false;
      if ch == '\n' {
          continue;
      }
  }
  ```
- **机理与后果**：
  1. 若标签后的文本出现连续回车符（如 `\r\r\n`）或非标准换行（如经典 Mac 格式 `\r`），第一个 `\r` 触发 `continue` 后，`strip_leading_newline` 依然保持 `true`。
  2. 第二个 `\r` 再次被直接丢弃。
  3. 若后续紧跟非换行字符，由于 `strip_leading_newline` 仍为 `true`，其后第一个字符若巧合为 `\n` 则被误吞；所有前导 `\r` 均被无条件抹除。

### 缺陷 3.3：无嵌套标签栈，内部相同开标签导致单闭标签提前退流与正文污染
- **涉及源码**：[`crates/agent-provider/src/parse/think_tags.rs:137-148`](file:///c:/Software/conex/crates/agent-provider/src/parse/think_tags.rs#L137-L148)
- **机理与后果**：
  状态机未实现栈深度（Depth Counter）。若模型输出包含嵌套标签（例如提示词中包含 `<think> 模型思考中：<think>嵌套思考</think> 继续思考 </think>`）：
  第一个 `</think>` 匹配成功后，状态机立即跃迁回 `TagState::Text`，将后续的 `继续思考 </think>` 全部作为正文输出，且多余的 `</think>` 成为正文垃圾字符泄漏给用户。

### 缺陷 3.4：严格大小写与空格敏感，不兼容带属性或变体标签
- **涉及源码**：[`crates/agent-provider/src/parse/think_tags.rs:16-29`](file:///c:/Software/conex/crates/agent-provider/src/parse/think_tags.rs#L16-L29)
- **机理与后果**：
  仅硬编码了 `<think>`、`<thought>`、`<thinking>`。当上游模型或代理产出带属性标签（如 `<thought id="1">`、`<think >`、`<think\n>`）或大写标签（如 `<THINK>`）时，状态机在前瞻失败后直接将其作为普通文本吐出，思考标签完全失效并原文泄露到正文中。

---

## 4. 【严重】错误帧/阻断帧到达时前瞻缓冲区静默丢弃与假死缺陷

### 缺陷 4.1：`chat_core.rs` 遇到错误帧立即终止，未冲刷 `tag_extractor` 与 `collector`
- **涉及源码**：[`crates/agent-provider/src/parse/chat_core.rs:75-87`](file:///c:/Software/conex/crates/agent-provider/src/parse/chat_core.rs#L75-L87)
- **代码现场**：
  ```rust
  // 1. 错误帧 → 立即终止（02 §2.2 步骤 2）；error_kind 按错误帧文案分类
  if let Some(error) = provider_body_error(&payload) {
      let kind = stream_error_kind(&error);
      events.push(ProviderStreamEvent::Stop {
          reason: StopReason::Error,
          error: Some(error),
          error_kind: Some(kind),
          usage: None,
      });
      self.stream.extend(events.clone())?;
      self.terminated = true; // <-- 终止置位
      return Ok(events);      // <-- 未调用 tag_extractor.finish() 与 collector.finish()！
  }
  ```
- **机理与后果**：
  1. 当流式过程中收到包含 `error` 对象的帧时，状态机立即置 `terminated = true` 并返回。
  2. 此时 `tag_extractor.lookahead_buf` 中暂存的前瞻字符（如 `<thi` 或 `</thi`）以及 `collector` 中已合并但尚未 flush 的局部工具调用参数**被全部抛弃**。
  3. 由于 `self.terminated` 为 `true`，后续即使上层调用 `finish()`，也会在第 182 行 `if self.terminated { return Ok(Vec::new()); }` 被拦截，残留缓冲区永远无法被救回。

### 缺陷 4.2：`gemini_core.rs` 阻断帧与错误帧同样丢弃前瞻缓冲区
- **涉及源码**：[`crates/agent-provider/src/parse/gemini_core.rs:103-133`](file:///c:/Software/conex/crates/agent-provider/src/parse/gemini_core.rs#L103-L133)
- **机理与后果**：
  在 `gemini_payload_error` 和 `prompt_block_reason` 分支中，直接构建 `ProviderStreamEvent::Stop` 并标记 `self.terminated = true`，同样跳过了 `self.tag_extractor.finish()`，造成缓冲区内容丢失。

### 缺陷 4.3：`chat_core.rs` 中 `delta.is_none()` 在收到空对象 `delta: {}` 时兜底失效
- **涉及源码**：[`crates/agent-provider/src/parse/chat_core.rs:154-159`](file:///c:/Software/conex/crates/agent-provider/src/parse/chat_core.rs#L154-L159)
- **代码现场**：
  ```rust
  // 无 delta 时 message.content 兜底正文（对齐 runtime:provider-openai-chat.ts:128-130）
  if delta.is_none() {
      if let Some(text) = non_empty_string(message.get("content")) {
          let extracted = self.tag_extractor.push_text(text);
          events.extend(extracted);
      }
  }
  ```
- **机理与后果**：
  部分 OpenAI 兼容代理在非流式格式混入时，会同时返回 `delta: {}` 和 `message: { content: "...", tool_calls: [...] }`。
  由于 `delta` 存在（解析为 `Some(Map)`），`delta.is_none()` 判定为 `false`，导致 `message.content` 的兜底逻辑被彻底跳过，正文内容被静默丢弃。

### 缺陷 4.4：混合流中工具调用事件产出时序倒挂
- **涉及源码**：
  - [`crates/agent-provider/src/parse/chat_core.rs:126-130`](file:///c:/Software/conex/crates/agent-provider/src/parse/chat_core.rs#L126-L130)
  - [`crates/agent-provider/src/parse/chat_core.rs:143-151`](file:///c:/Software/conex/crates/agent-provider/src/parse/chat_core.rs#L143-L151)
- **机理与后果**：
  `delta.tool_calls` 通过 `self.collector.merge(raw)` 暂存，直到流结束 `finish()` 时才统一产出；而 `choice.message.tool_calls` 却在 `push_frame` 阶段通过 `parse_full_tool_call` 立即 `events.push`。若某一异常流先输出 `delta.tool_calls` 增量片段，后混入 `message.tool_calls`，两者产出的事件时间戳与顺序将严重倒挂。

---

## 5. 【隐患】内存多重放大分配、无界流 OOM 与 `drain()` $O(K^2)$ 搬移隐患

### 缺陷 5.1：`session-loop/src/stream.rs` 缺失缓冲区最大容量硬顶（无界 OOM 攻击面）
- **涉及源码**：[`crates/session-loop/src/stream.rs:283-322`](file:///c:/Software/conex/crates/session-loop/src/stream.rs#L283-L322)
- **机理与后果**：
  对比 `agent-provider/src/consume/mod.rs`（设置了 `MAX_AGGREGATE_TEXT_BYTES = 64MiB` 硬顶限制并在超限时返回 `StreamError`），`session-loop/src/stream.rs` 的 `Aggregate::push` **完全没有任何字节数或元素数量上限限制**。
  若上游 Provider 返回无限长流或慢速 Flood 攻击，`aggregate.text`、`aggregate.thought` 和 `aggregate.thought_blocks` 将无限申请堆内存，直至宿主进程崩溃 (OOM Kill)。

### 缺陷 5.2：思考文本单流内 5~6 次深克隆与序列化放大
- **涉及链路**：
  1. `stream.rs`: `self.thought.push_str(&text)` 复制一次；
  2. `stream.rs`: `self.thought_blocks.push(ThoughtBlock { text, redacted })` 克隆第二次；
  3. `stream.rs`: `metadata.insert("thoughtBlocks", serde_json::to_value(&aggregate.thought_blocks))` 序列化并分配第三次（生成整棵 JSON AST）；
  4. `streaming.rs`: `build_assistant_message` 从 JSON 中 `text.to_string()` 克隆第四次；
  5. `streaming.rs`: `emit_message_deltas` 中 `block.clone()` 克隆第五次。
- **后果**：思考流包含数万 token 时，内存瞬时分配峰值达到实际文本大小的 5 倍以上，并带来大量微小堆内存碎片。

### 缺陷 5.3：`think_tags.rs` 中 `drain(..char_len)` 循环前瞻造成 $O(K^2)$ 内存拷贝
- **涉及源码**：
  - [`crates/agent-provider/src/parse/think_tags.rs:235`](file:///c:/Software/conex/crates/agent-provider/src/parse/think_tags.rs#L235)
  - [`crates/agent-provider/src/parse/think_tags.rs:287`](file:///c:/Software/conex/crates/agent-provider/src/parse/think_tags.rs#L287)
- **代码现场**：
  ```rust
  if let Some(first_char) = self.lookahead_buf.chars().next() {
      current_text_batch.push(first_char);
      let char_len = first_char.len_utf8();
      self.lookahead_buf.drain(..char_len); // <-- String 前端频繁移除导致整体内存向前 memmove
  }
  ```
- **机理与后果**：
  在标签匹配失败回退时，每次只弹出首字符并对其余字符串执行 `drain` 搬移。若前瞻缓冲区填满长前缀（例如 `<think-not-a-tag>`），循环内将频繁触发内存移动，属于典型的低效状态机实现。

---

## 6. 【排查】潜在 Panic 点、`.unwrap()` / `.expect()` 与 UTF-8 多字节边界排查清单

### 6.1 `unwrap()` / `expect()` 隐患排查
| 文件与行号 | 代码模式 | 风险评估 | 触发场景与防范建议 |
| :--- | :--- | :--- | :--- |
| `streaming.rs:100` | `.expect("consume_stream：无流错误时必有收口结果")` | **低** | 依赖 `consume_stream` 的返回值互斥契约，若未来内部重构引入分支疏漏将导致 Loop 线程 Panic。建议替换为 `ok_or(LoopError::...)`。 |
| `streaming.rs:449` | `.expect("build_request 前必须已构建工具快照")` | **中** | 依赖调用方必须先调用 `ensure_tools_snapshot`。若任何重构路径绕过该前置函数调用 `build_request`，直接导致 Panic。 |
| `stream.rs:836-839` | `breakdown["miss"].as_u64().unwrap()` | **零** (测试代码) | 位于 `#[cfg(test)]` 内，不影响生产运行。 |
| `stream.rs:921` | `serde_json::to_value(breakdown).unwrap()` | **零** (测试代码) | 位于 `#[cfg(test)]` 内。 |

### 6.2 UTF-8 多字节切片与越界排查
- **审查结论**：
  - `think_tags.rs:234-235` 与 `286-287` 采用 `first_char.len_utf8()` 计算字节偏移后进行 `drain(..char_len)`，避免了跨字符切片，**不存在多字节 UTF-8 切片 Panic**。
  - `stream.rs` 与 `streaming.rs` 中均使用标准迭代器与 `String` 方法，未发现非法裸切片 `&str[a..b]` 操作。
- **残余风险**：
  - 流式分帧层若将多字节字符截断在不同的 SSE 帧数据中，由于 `StreamingTagExtractor::push_chunk` 接收的是 `&str`（Rust 保证合法 UTF-8），若底层分帧未处理好多字节拼接会导致分帧层反序列化失败，但本状态机层本身未见越界 Panic 漏洞。

---

## 7. 【清单】协议层与状态机缺陷索引表

| 缺陷编号 | 所在文件及位置 | 严重等级 | 缺陷类型 | 核心影响 |
| :--- | :--- | :--- | :--- | :--- |
| **DEF-01** | `session-loop/src/stream.rs:398` | **P0 致命** | 逻辑丢失 | 纯思考流被误判为 `Empty`，`metadata` 彻底抹除 |
| **DEF-02** | `session-loop/src/stream.rs:438` | **P0 致命** | 状态失效 | 思考流中断时 Partial Salvage 彻底归零失效 |
| **DEF-03** | `session-loop/src/loop/handlers/streaming.rs:599` | **P1 严重** | 协议破坏 | 强制重排为 `[Thought, Text, ToolCall]`，破坏交错时序 |
| **DEF-04** | `session-loop/src/loop/handlers/streaming.rs:605` | **P1 严重** | 字段遗漏 | 缺少 `text` 字段的脱敏思考块被静默丢弃 |
| **DEF-05** | `session-loop/src/stream.rs:289` | **P1 严重** | 架构缺陷 | `ThoughtBlock` 逐 Delta 碎裂未合并，块数量膨胀数百倍 |
| **DEF-06** | `agent-provider/src/parse/think_tags.rs:184` | **P1 严重** | 状态悬挂 | 状态机退出后遗留 `Thinking` 且清空激活标签，引发异名闭标签劫持 |
| **DEF-07** | `agent-provider/src/parse/chat_core.rs:85` | **P1 严重** | 缓存丢弃 | 错误帧到达时未 flush `tag_extractor` 与 `collector`，数据永久丢失 |
| **DEF-08** | `agent-provider/src/parse/gemini_core.rs:113` | **P1 严重** | 缓存丢弃 | Gemini 错误/阻断帧到达时丢弃前瞻缓冲区 |
| **DEF-09** | `agent-provider/src/parse/chat_core.rs:154` | **P1 严重** | 兼容失效 | `delta: {}` 导致非流式 `message.content` 兜底失效丢字 |
| **DEF-10** | `agent-provider/src/parse/think_tags.rs:116` | **P2 中等** | 状态机缺陷 | 遇到连续 `\r` 未复位标记，导致换行符吞噬 |
| **DEF-11** | `session-loop/src/stream.rs:283` | **P2 中等** | 内存隐患 | 缺失 64MiB 缓冲区上限硬顶，存在慢速流 OOM 风险 |
| **DEF-12** | `agent-provider/src/parse/think_tags.rs:235` | **P3 轻微** | 性能隐患 | `drain(..char_len)` 循环前瞻造成 $O(K^2)$ 内存频繁重排 |
