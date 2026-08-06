# 架构评审报告：Tiptap 迁移方案

## 1. 组件树注入与集成 (Component Tree Injection)
**评估结论：高度可行且重构成本低**
- **Props 契约兼容性**：`TiptapComposerField.tsx` 定义的接口 (`TiptapComposerFieldProps`) 是旧有 `<ComposerField />` Props 的超集。在 `ChatComposer.tsx` 中可以直接平滑替换原组件，这种开闭原则（OCP）降低了对父级上下文树的破坏风险。
- **模块化解耦与代码门禁**：方案将复杂功能下放到特定的子钩子和子组件中 (`useTiptapEditor.ts`, `SlashMenuOverlay.tsx`, `TiptapKeymap.ts`)，能够严格遵循 `.agents/AGENTS.md` 规定的单文件 <= 500 行规则，不会因集成 Tiptap 导致大组件（上帝组件）的诞生。
- **焦点捕获与焦点盾 (Focus Shield)**：通过 `e.preventDefault()` 阻止 Slash 弹出菜单项点击时可能造成的 WebView2 ContentEditable 焦点流失，并合理运用 `@floating-ui/react` 和规定的 `var(--z-popover, 200)` 层次，UI 注入的架构非常稳健。

## 2. Store 状态流转 (Store State Flow)
**评估结论：维持了高内聚与序列化安全**
- **Markdown 作为第一公民**：利用 `tiptap-markdown` 在 ProseMirror 节点与普通字符串间建立双向同步，确保 `useLayoutStore` 中的 `composerDrafts` 只需存储原生的 Markdown 字符串。这避免了 Zustand store 被复杂的不可序列化 JSON/DOM 节点污染。
- **与业务和 IPC 层的无缝对接**：因为输出依旧是纯文本与附件（`ChatAttachment[]` 依托 `sessionRuntimeRegistry`），现有的排队机制 (`ChatQueuePanel`)、`buildMultimodalFromAttachments` 载荷构造以及 `streamAssistantResponseApi` 引擎调用**完全不需要修改**。
- **L2/L3 中断状态延续**：L2 (单次协作停止) 和 L3 (长按强制阻断) 的控制流都在 `TiptapComposerField` 外层闭环，与编辑器内部状态正交，完美契合现有的状态转移模型。

## 3. 关键边缘场景处理
- **IME 竞态保护**：方案提出的 `isComposingJustEndedRef` 50ms 压制窗能够完美处理 Windows Chromium 常见的输入法 `compositionend` 与 `Enter` 连发问题，是一个扎实的底层防御。
- **CodeBlock 与快捷键拦截**：专门在 `TiptapKeymap.ts` 处理代码块内 Enter 阻止发送的问题，这是提升开发人员交互体验的关键，架构上将其与 UI 逻辑分离非常合理。

## 4. 评审建议与风险点 (Risks & Recommendations)
1. **渲染序列化开销**：`onChange` 触发频率可能较高，即便有 350ms 的外部 Draft 持久化防抖，但每次按键都触发 `tiptap-markdown` 完整反序列化可能会在超大文本（几百行）时产生 Typing Latency，建议在后续进行极端字数下的 Profiling 性能监控。
2. **CSS 初始化注入**：ProseMirror 原生节点 (如 `taskList`, `heading`) 不自带样式。必须在 `TiptapComposerField.module.css` 提供完整的原子/基础样式覆盖，否则渲染会变成 Plain text 外观。

**总结**：Tiptap 迁移方案与现有 React / Zustand 架构兼容度极高，充分吸收了 Conex 的防过度设计和解耦规则，整体集成可行性极强。建议准予执行。
