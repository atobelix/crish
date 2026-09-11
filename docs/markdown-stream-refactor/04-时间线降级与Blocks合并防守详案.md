# 04-分维实现详案：时间线降级与 Blocks 合并防守详案

> **所属战役**：`docs/markdown-stream-refactor/`
> **核心目标**：根除多轮交互时 `updateMessageTimeline` 对历史思考块与工具卡片的破坏性覆盖，设计 Turn-Aware 三元锚点保全算法与前端 Markdown 免疫防御层。
> **涉及文件**：
> - `apps/crish-desktop/src/api/tool-presentation/timelineNormalizer.ts` (深度防御防守)
> - `apps/crish-desktop/src/store/sessionMessageActionsTools.ts` (多轮合并算法)
> - `apps/crish-desktop/src/api/messageProjection.ts` (投影层映射)

---

## 1. Blocks 破坏性覆盖根因与三元锚点算法

### 原有缺陷

`sessionMessageActionsTools.ts` 中的 `updateMessageTimeline` 直接调用 `normalizeAssistantTimeline` 并以全量覆盖形式赋值 `hit.message.blocks = n.blocks`。当第 2 轮工具收口时，若上游只返回了第 2 轮的块，第 1 轮的 `tool_call` 与 `thought` 块被直接覆盖抹去，导致历史时间线卡片蒸发。

### 核心算法：`reconcileAssistantMessageBlocks`

引入以 `(turnIndex, blockType, id)` 为三元组槽位的保全合并算法：

```typescript
export function reconcileAssistantMessageBlocks(
  existingBlocks: MessageTimelineBlock[] | undefined,
  incomingBlocks: MessageTimelineBlock[]
): MessageTimelineBlock[] {
  if (!existingBlocks || existingBlocks.length === 0) {
    return incomingBlocks;
  }

  const result: MessageTimelineBlock[] = [];
  const existingMap = new Map<string, MessageTimelineBlock>();

  // 1. 注册既有持久块（重点保护 thought 与 tool_call）
  for (const b of existingBlocks) {
    const key = `${b.turnIndex ?? 0}:${b.type}:${b.id ?? ''}`;
    existingMap.set(key, b);
  }

  // 2. 融合 incoming blocks
  for (const b of incomingBlocks) {
    const key = `${b.turnIndex ?? 0}:${b.type}:${b.id ?? ''}`;
    if (existingMap.has(key)) {
      // 相同槽位：更新内容
      result.push({ ...existingMap.get(key)!, ...b });
      existingMap.delete(key);
    } else {
      result.push(b);
    }
  }

  // 3. 追加未被覆盖的历史工具与思考块（防止丢块）
  for (const [, orphan] of existingMap) {
    if (orphan.type === 'tool_call' || orphan.type === 'thought') {
      result.push(orphan);
    }
  }

  // 4. 按轮次与物理逻辑排序：[Thought_k] -> [ToolCalls_k] -> [Text_k]
  return result.sort((a, b) => {
    const turnA = a.turnIndex ?? 0;
    const turnB = b.turnIndex ?? 0;
    if (turnA !== turnB) return turnA - turnB;
    const order = { thought: 1, tool_call: 2, text: 3 };
    return (order[a.type] ?? 9) - (order[b.type] ?? 9);
  });
}
```

---

## 2. 前端深度防御机制：`parseInlineThoughtAndTextSafely`

作为 Rust 状态机的二级防守网，前端在降级解析 `msg.text` 时必须确保**Markdown 代码栅栏免疫（Code Fence Immunity）**：

1. **扫描并保护代码栅栏**：在执行正则提取 `<think>` 之前，先扫描所有的 ```` ``` ```` 与 `` ` `` 区域。
2. **禁止误伤技术文档**：若 `<think>` 出现在代码块内部（例如用户在写教程演示 think 标签），严禁将其作为真实思考块抽离，保护 Markdown 语法完整性。
3. **未闭合流式开放标签回退**：对流式中途尚未闭合的 `<think>` 标签，自动标记为 `isStreaming: true` 的思考块，防止未完成的思考内容瞬时外溢。

---

## 3. 交付验收断言

- **断言 1**：在 5 轮复杂的 Agent 工具调用与思考交互后，最终消息时间线中包含全部 5 轮的 `ThoughtBlock` 与 `ToolCallCard`，无任何历史卡片丢失。
- **断言 2**：若模型在 Markdown 代码块中输出 ```` ```xml <think>sample</think> ``` ````，前端代码高亮正常显示，不产生虚假思考面板。
