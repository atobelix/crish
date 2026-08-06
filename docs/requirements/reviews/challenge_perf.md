# 性能挑战报告：Tiptap AST 在高频更新与流式场景下的开销评估

**审查目标**：Tiptap Chat Composer Migration (`TIPTAP_MIGRATION_REQUIREMENTS.md`)
**评估维度**：极高并发流式输出、AST 解析开销、主线程阻塞风险

## 1. 致命缺陷（Fatal Flaw）：绝对禁止用于流式输出渲染
**风险点**：虽然文档主要针对输入框（Composer），但若在架构演进中，试图将 Tiptap 及其 AST 引擎复用于聊天列表（UI Session）的**AI 极高并发流式输出（Streaming Output）渲染**，将是灾难性的架构错误。
**原因分析**：
- ProseMirror / Tiptap 的底层状态是不可变的树结构（AST）。在极高并发的流式输出（`onChunk` 频繁触发）下，每个 Token 的追加如果触发 `tiptap-markdown` 的解析器，会导致 `Markdown -> JSON AST -> ProseMirror 状态树重建 -> DOM 更新` 的全链路同步执行。
- 这种高频的全量/半全量解析会极大地阻塞主线程，导致 UI 彻底卡死和严重的掉帧（Jank）。
**结论与建议**：AI 的流式输出展示必须继续使用轻量级的增量 Markdown 渲染器（如基于 marked 的增量解析），**严格禁止**在流式响应区使用 Tiptap Editor。

## 2. 核心性能瓶颈：Composer 内部的同步序列化开销
**风险点**：文档 **3.6 节** 规定：“*Whenever the ProseMirror document updates, editor.storage.markdown.getMarkdown() converts the current node tree to a clean Markdown string passed to onChange(markdownText).*”
**原因分析**：
- 如果用户在输入框中粘贴了极长文本（或多层级的复杂 Block 结构），用户的**每一个击键（Keystroke）**都会触发 ProseMirror 的 `update` 事件。
- 在 `update` 中同步调用 `getMarkdown()` 进行整个 AST 到 Markdown 字符串的全量序列化，时间复杂度与文档长度成正比，会导致输入出现明显延迟（Input Lag）。
**优化建议**：
1. **解耦 onChange 与序列化**：不要在每次击键时同步执行 `getMarkdown()`。
2. **按需/防抖序列化**：将 Markdown 的序列化过程移入 `350ms` 的防抖逻辑（Draft Persistence）中，或仅在触发 `onSend`、`flushComposerDraft` 时进行一次最终序列化。
3. 对外暴露的 `onChange` 仅传递内部状态或变更标记，避免传递全量计算的序列化大字符串。

## 3. 拖拽与内存膨胀风险
**风险点**：文档要求支持 Notion 风格的全局拖拽（Drag-and-Drop）与任务列表交互。
**原因分析**：Tiptap 在处理大型列表时的拖拽重排涉及复杂的节点切片（Node Slices）计算。如果 Composer 缺乏输入字符/Block 数量的硬性上限控制，恶意或意外的大规模粘贴（例如几万行日志）会瞬间撑爆 ProseMirror 的内存占用。
**优化建议**：
- 在 `TiptapComposerFieldProps` 或 `useTiptapEditor` 中强制引入**最大字符数/Block数截断保护**。超过阈值的输入应被强制转换为附件文件（如 `.txt` 附件），而非作为内联文本解析。
