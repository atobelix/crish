# Agent 1 详细审查文档：消息列表与 Pretext DOM / 性能瓶颈

## 一、 审查结论摘要

1. **`useBubbleShrinkWidth` 遗留与布局强排 (Layout Thrashing)**：
   - `useBubbleShrinkWidth` 依然**在代码中活跃使用**，存在于 `src/hooks/useTextMeasure.ts` (L75-141)，并被 `ChatMessageRow.tsx` 在用户气泡 (L275) 与助手气泡 (L520) 中无差别调用。
   - 每个挂载的消息行都独立创建 `ResizeObserver` 实例。
   - `compute()` 中直接读取 DOM 属性 `containerRef.current.clientWidth` (L97)，在 ResizeObserver/Effect 异步回调中触发**强制同步布局重排 (Forced Synchronous Reflow)**。

2. **Pretext `prepare()` 缺乏高效缓存机制与高昂重复调用**：
   - `ChatMessageList.tsx` 的预估高度逻辑 (L565-637) 在 `containerWidth` 或 `visibleMessages` 变动时，于 `requestIdleCallback` 循环中直接调用 `prepare(text, pretextFont)` (L597)，**没有任何 Map/LRU 缓存**。
   - `AsyncMarkdownBlock` (ChatMessageRow.tsx L957) 在流式推流（文字逐字增加）时，对整段文字频繁调用 `prepare()`；其 `useLayoutEffect` 中包含 `parentElement.clientWidth` 强排。
   - `ToolResultBody` (ChatToolCallBlock.tsx L205) 在渲染/Resize 时重复调用非缓存的 `prepareWithSegments`。
   - `useTextMeasure.ts` (L55) 中的 `clearPrepared()` 会强行调用全局 `clearCache()`，误杀全局 Glyph 缓存。

3. **核心组件 `React.memo` 缺失与全列表层叠 Re-render (Cascading Re-renders)**：
   - **子组件缺少 memo**：`ChatToolStack` (ChatToolCallBlock.tsx L809)、`CompactToolRow` (L326)、`ToolResultBody` (L145)、`BatchApprovalBar` (L684)、`AsyncMarkdownBlock` (ChatMessageRow.tsx L950)、`ChangeOverviewCard` (ChangeOverviewCard.tsx L86) 均**未被 `React.memo` 包裹**。
   - **层叠失效陷阱 1（`expandedTools` 引用变动）**：用户展开/收起任意一条工具时，`ChatMessageList.tsx` 更新 `expandedToolsBySession`，导致 `toolStackProps` 产生新引用。`assistantRowPropsEqual` 比较 `a.expandedTools === b.expandedTools` 结果为 `false`，**导致视口内所有 `ChatAssistantMessageRow` 全部重新渲染**。
   - **层叠失效陷阱 2（`togglePin` 依赖 `pinnedIdSet`）**：`togglePin` useCallback 依赖 `pinnedIdSet`，固定/取消固定任意消息时 `togglePin` 引用改变，`userRowPropsEqual` 与 `assistantRowPropsEqual` 全部失效，**导致 100% 视口消息行全量 Re-render**。

4. **违反 Rule 1 样式规范**：
   - `ApprovalAskCard.tsx` (L412, L430, L442, L469)、`ChatEmptyState.tsx` (L348) 等处存在原生 `title="..."` 属性，未统一使用 `<Tooltip>` 组件。

---

## 二、 详细排查点记录与代码分析

### 1. `useBubbleShrinkWidth` 彻底审查

| 文件名 | 行号 | 问题描述 | 性能与逻辑影响 |
| :--- | :--- | :--- | :--- |
| `src/hooks/useTextMeasure.ts` | Line 75-141 | `useBubbleShrinkWidth` 函数未被清理，内部封装了独立的 `ResizeObserver` (Line 127) 与 300ms 定时器 debounce | 消息列表中每条 Row 都会挂载一个 `ResizeObserver` 监听器，DOM 节点增多时 Listener 开销显著增加。 |
| `src/hooks/useTextMeasure.ts` | Line 97 | `const chatColMax = containerRef.current.clientWidth;` 在 `compute` 中同步读取 `clientWidth` | 属于典型 DOM Layout Thrashing（布局强排）。在 ResizeObserver 或 State 更新回调中读取 `clientWidth` 会迫使浏览器立即重新计算样式与排版。 |
| `src/hooks/useTextMeasure.ts` | Line 100 | `const prepared = prepareWithSegments(text, font);` | 每次 compute 均重新对完整文本进行 Pretext 分段测量，无任何缓存机制。 |
| `src/hooks/useTextMeasure.ts` | Line 107 | `if (!cancelled) setBubbleWidth(optimal);` | 每次 DOM Resize 触发 `setBubbleWidth` 状态变更，直接引发对应消息行的组件 Re-render。 |
| `src/components/ChatMessageRow.tsx` | Line 40 | `import { useBubbleShrinkWidth, ... } from '../hooks/useTextMeasure';` | 保持导入。 |
| `src/components/ChatMessageRow.tsx` | Line 275 | `ChatUserMessageRowInner` 中调用 `useBubbleShrinkWidth(displayText, userBubbleFont, userRowRef, 32)` | 所有 User 消息行均受上述布局强排与 ResizeObserver 开销影响。 |
| `src/components/ChatMessageRow.tsx` | Line 520 | `ChatAssistantMessageRowInner` 中调用 `useBubbleShrinkWidth(assistantPlainText, assistantBubbleFont, assistantRowRef, 0)` | 所有 Assistant 消息行均受上述布局强排与 ResizeObserver 开销影响。 |

---

### 2. Pretext `prepare()` 缓存机制与高昂重复调用审查

| 文件名 | 行号 | 问题描述 | 性能与逻辑影响 |
| :--- | :--- | :--- | :--- |
| `src/components/ChatMessageList.tsx` | Line 597 | `const prepared = prepare(text, pretextFont);` 在 `requestIdleCallback` (`processChunk`) 批处理中循环调用 | 消息列表未渲染节点进行高度预估时，对每条消息正文直接调用 `prepare()`，**没有应用层 Map / Cache 机制**。容器宽度调整 (Resize) 或 `visibleMessages` 变化时，所有 pending 消息会重复触发高昂的 `prepare()` 算法。 |
| `src/components/ChatMessageRow.tsx` | Line 957 | `AsyncMarkdownBlock` 内调用 `usePreparedText({ text, font })` | 虽 `usePreparedText` 内部有 `useMemo`，但流式输出（Stream Processing）期间 `text` 频繁增长，每次推流均会重新对增长后的长文本调用 `prepare()`。 |
| `src/components/ChatMessageRow.tsx` | Line 965 | `useLayoutEffect` 中读取 `skeletonRef.current.parentElement?.clientWidth` | 在 React 渲染 Layout 阶段强制读取 DOM 宽度，再次引发 Forced Synchronous Reflow。 |
| `src/components/ChatToolCallBlock.tsx` | Line 205 | `ToolResultBody` 内 `budget` `useMemo` 中调用 `prepareWithSegments(full, fontConfig.fontStr, { whiteSpace: 'pre-wrap' })` | 展开工具输出体时，绕过了 `usePreparedText` 的 memo 结果，每次宽度变化或 output 更新均对完整工具输出文本重新解析 segments，缺乏缓存。 |
| `src/hooks/useTextMeasure.ts` | Line 55 | `clearPrepared` 中调用全局 `clearCache()` | `clearCache()` 为 `@chenglou/pretext` 的全局清空方法。若单组件卸载或手动调用 `clearPrepared()`，会抹掉全应用已缓存的 Glyph Font 测量数据，导致全局测量性能骤降。 |

---

### 3. 核心组件 `React.memo` 缺失与全列表层叠 Re-render 审查

| 文件名 | 行号 | 问题描述 | 性能与逻辑影响 |
| :--- | :--- | :--- | :--- |
| `src/components/ChatToolCallBlock.tsx` | Line 809 | `export const ChatToolStack: React.FC<ChatToolStackProps>` **未包裹 `React.memo`** | 每次父级 `ChatAssistantMessageRow` 重新渲染时，包含的所有 `ChatToolStack` 无条件重新渲染。 |
| `src/components/ChatToolCallBlock.tsx` | Line 326 | `function CompactToolRow` **未包裹 `React.memo`** | 工具行内部无 memo 隔离。 |
| `src/components/ChatToolCallBlock.tsx` | Line 145 | `function ToolResultBody` **未包裹 `React.memo`** | 工具输出展开体无 memo 隔离。 |
| `src/components/ChatToolCallBlock.tsx` | Line 684 | `function BatchApprovalBar` **未包裹 `React.memo`** | 批量审批栏无 memo 隔离。 |
| `src/components/ChatMessageRow.tsx` | Line 950 | `function AsyncMarkdownBlock` **未包裹 `React.memo`** | Markdown 异步渲染块无 memo 隔离，导致 Stream 或 Row 更新时多次触发 Bridge push。 |
| `src/components/ChangeOverviewCard.tsx` | Line 86 | `export const ChangeOverviewCard: React.FC<ChangeOverviewCardProps>` **未包裹 `React.memo`** | 改动概览卡片无 memo 隔离。 |
| `src/components/ChatMessageList.tsx` | Line 150, 499 | `toolStackProps` 依赖 `expandedTools`，而 `expandedTools` 由 `expandedToolsBySession` 生成（Line 150） | **【层叠 Re-render 缺陷 1】**：用户展开/收起任何一条工具 Call 时，`expandedTools` 引用更新 -> `toolStackProps` 引用更新 -> `assistantRowPropsEqual` 中 `a.expandedTools === b.expandedTools` 判 `false` -> **视口内所有 Assistant 消息行全部被强制 Re-render**。 |
| `src/components/ChatMessageList.tsx` | Line 304 | `const togglePin = useCallback(..., [activeSessionId, pinnedIdSet, pinMessage, unpinMessage])` 依赖 `pinnedIdSet` | **【层叠 Re-render 缺陷 2】**：用户 Pin/Unpin 任意一条消息时，`pinnedIdSet` 变化 -> `togglePin` 引用变化 -> `userRowPropsEqual` 与 `assistantRowPropsEqual` 的 `prev.onTogglePin === next.onTogglePin` 均判 `false` -> **视口内 100% 的消息行（User & Assistant）全部被强制 Re-render**。 |
| `src/components/ChatMessageList.tsx` | Line 831, 856 | `onShowToast={onShowToast}` 等 Handler 作为函数 Props 直传 | 若上层父组件（如 ChatCard）未对 `onShowToast` 等 Handler 进行 `useCallback` 稳定化，将直接穿透 `userRowPropsEqual` 与 `assistantRowPropsEqual`。 |

---

### 4. 用户规则 (User Rules - AGENTS.md) 违规检查

* **Rule 1: Tooltips / Hover Tips**
  - **违规隐患**：
    - `ApprovalAskCard.tsx` (Line 412: `title={zoneTitle}`, Line 430: `title={riskMeta?.riskReason}`)
    - `ChatEmptyState.tsx` (Line 348: `title={item.prompt}`)
    - `ChatStatusRibbons.tsx` (Line 781, 812, 820, 870 处使用原生 `title`)
