# 维度一指导方案：消息列表、Pretext 缓存、Re-render 隔离与样式规范重构指南 (01-CHAT-LIST-AND-PRETEXT-REFACTOR-GUIDE)

> **文档编号**: CX-GUIDE-001  
> **版本**: v1.0 Final  
> **关联源码**: `apps/crish-desktop/src/components/ChatMessageList.tsx` / `ChatMessageRow.tsx` / `useTextMeasure.ts` / `ChatToolCallBlock.tsx`  
> **核心目标**: 彻底清理 `useBubbleShrinkWidth` 带来的 DOM 强排死循环；构建全局 Pretext `PreparedText` LRU 缓存池；修复 `expandedTools` 与 `togglePin` 引发的视口消息 100% 级联重绘陷阱；为沉重组件补充 `React.memo` 隔离；治理 Rule 1 原生 `title` 属性违规。

---

## 一、 问题定位与根源剖析

在之前的深入审查中，Agent 1 定位到了消息列表与文本测算模块的 **4 大严重缺陷与 2 大级联重绘陷阱**：

```text
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           消息列表 4 大严重缺陷与 2 大级联陷阱                            │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. `useBubbleShrinkWidth` 依然挂载在 `ChatMessageRow.tsx:275, 520`：                    │
│    在 `useTextMeasure.ts:97, 127` 回调中同步读取 `clientWidth`，引发 Forced Reflow 死循环│
│ 2. Pretext `prepare()` 未做全局 LRU 缓存：                                              │
│    `ChatMessageList.tsx:598` 每次 resize/scroll 均对所有 pending 消息调用 `prepare()`      │
│ 3. 核心列表组件 `ChatMessageRow.tsx` 未包裹 `React.memo` 比较隔离                       │
│ 4. 级联重绘陷阱 1 (`expandedTools` 引用更新)：                                           │
│    用户展开/收起任意工具，`toolStackProps` 生成新引用，导致视口内所有 Assistant 行 Re-render│
│ 5. 级联重绘陷阱 2 (`togglePin` 依赖 `pinnedIdSet`)：                                     │
│    Pin/Unpin 任意消息，`togglePin` 引用变动，导致视口内 100% User & Assistant 行 Re-render │
│ 6. 违规使用原生 HTML `title="..."` 属性 (违反 User Rule 1)                                │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、 详细改进方案与代码改造规范

### 1. 彻底废除 `useBubbleShrinkWidth` 并转向 CSS 原生 `fit-content`

#### (1) 代码清理与接口废弃 (`apps/crish-desktop/src/hooks/useTextMeasure.ts`)
* **操作指令**：完全移除 `useBubbleShrinkWidth` 函数，不再在任何地方给消息气泡绑定 `ResizeObserver` 或读取 `clientWidth`。
* **文件改造**:
```typescript
// apps/crish-desktop/src/hooks/useTextMeasure.ts
import { useMemo, useRef, useEffect } from 'react';
import { prepare, layout } from '@chenglou/pretext';
import type { PreparedText } from '@chenglou/pretext';

// 移除 useBubbleShrinkWidth 及其内部的 ResizeObserver 与 clientWidth 强排逻辑
```

#### (2) 消息行样式替换 (`apps/crish-desktop/src/components/ChatMessageRow.tsx`)
* **代码修改**：彻底移除 `userBubbleWidth` 与 `assistantBubbleWidth` 的计算，直接移除内联 `style={{ maxWidth: ... }}`，完全交由 CSS 原生排版。
* **修改前 (问题代码)**:
```typescript
// 错误示例：依赖 useBubbleShrinkWidth 与 DOM 读取
const userBubbleWidth = useBubbleShrinkWidth(displayText, userBubbleFont, userRowRef, 32);
return <div className={styles.userBubble} style={{ maxWidth: userBubbleWidth ?? undefined }}>{displayText}</div>;
```
* **修改后 (重构规范代码)**:
```typescript
// 正确示例：0ms JS 算力，纯 CSS 弹性宽度
return <div className={styles.userBubble}>{displayText}</div>;
```

#### (3) CSS 样式治理 (`apps/crish-desktop/src/components/ChatMessageRow.module.css`)
```css
.userBubble {
  background: color-mix(in srgb, var(--bg-secondary) 88%, #e8e8e6 12%);
  color: var(--text-primary);
  border-radius: 20px 20px var(--radius-xs) 20px;
  padding: 12px 16px;
  word-break: normal;
  overflow-wrap: break-word;
  white-space: pre-wrap;
  width: fit-content;
  max-width: 100%;
}

.assistantBody {
  width: 100%;
  max-width: 100%;
  overflow-wrap: break-word;
}
```

---

### 2. Pretext 全局 LRU 结构缓存机制 (`pretextCache.ts`)

#### (1) 建立 `PreparedText` 内存缓存池 (`apps/crish-desktop/src/api/pretextCache.ts`)
* **核心原则**：确保每条消息一生只调用 **1 次 `prepare()`**，后续在 resize / 滚动时热路径仅运行 **0.0002ms 纯算术 `layout(prepared, width, lineHeight)`**。

```typescript
// apps/crish-desktop/src/api/pretextCache.ts
import { prepare, type PreparedText } from '@chenglou/pretext';

interface CacheEntry {
  prepared: PreparedText;
  textLength: number;
  font: string;
}

class PretextCacheManager {
  private cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  /**
   * 获取或创建 PreparedText 句柄
   * @param id 消息唯一的 id
   * @param text 消息正文文本
   * @param font 字体测量配置字符串 (如 "14px Inter")
   */
  public getOrCreate(id: string, text: string, font: string): PreparedText | null {
    if (!text || !font) return null;

    const cacheKey = `${id}:${text.length}:${font}`;
    const existing = this.cache.get(cacheKey);
    if (existing) {
      // LRU 刷置队尾
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, existing);
      return existing.prepared;
    }

    try {
      const prepared = prepare(text, font, { whiteSpace: 'pre-wrap' });
      if (this.cache.size >= this.maxEntries) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) this.cache.delete(oldestKey);
      }
      this.cache.set(cacheKey, { prepared, textLength: text.length, font });
      return prepared;
    } catch {
      return null;
    }
  }

  public clear(): void {
    this.cache.clear();
  }
}

export const globalPretextCache = new PretextCacheManager(1000);
```

#### (2) 改造 `ChatMessageList.tsx` 预估高度热路径
```typescript
// apps/crish-desktop/src/components/ChatMessageList.tsx
import { globalPretextCache } from '../api/pretextCache';
import { layout } from '@chenglou/pretext';

// 在预计算批处理 processChunk 中：
const processChunk = () => {
  for (const msg of pendingBatch) {
    const text = msg.text || '';
    if (!text) continue;

    // 优先从 LRU 缓存获取 PreparedText (0ms)
    const prepared = globalPretextCache.getOrCreate(msg.id, text, pretextFont);
    if (prepared && containerWidth > 0) {
      // 仅运行 0.0002ms 纯算术 layout
      const h = layout(prepared, containerWidth, 20).height;
      manager.setEstimated(msgIndex, Math.max(MESSAGE_ESTIMATED_ROW_HEIGHT, h));
    }
  }
};
```

#### (3) 修复 `useTextMeasure.ts` 中的 `clearPrepared` 全局误杀
* **修改前 (错误代码)**:
```typescript
const clearPrepared = () => {
  preparedRef.current = null;
  clearCache(); // ❌ 错误：这会清空 @chenglou/pretext 底层全部 Canvas Glyph 字体缓存
};
```
* **修改后 (正确代码)**:
```typescript
const clearPrepared = () => {
  preparedRef.current = null;
  // 仅清空应用层实例引用，禁止调用底层全局 clearCache()
};
```

---

### 3. 解决两级层叠 Re-render 陷阱与补全组件 `React.memo`

#### (1) 解决陷阱 1：`expandedTools` 引用引发的全视口 Assistant 行重绘
* **根源**：`ChatMessageList` 的 `toolStackProps` 将整个 `expandedTools` 对象字典传入，每次展开任意工具卡片，对象引用变动导致 `assistantRowPropsEqual` 校验失效。
* **重构方案**：将 `expandedTools` 的展开状态粒度下沉至按 `sessionId` + `toolId` 订阅，或在 `toolStackProps` 中仅传递稳定无状态 Handler，由 `ChatToolStack` 内部通过 Zustand / Context 校验展开状态。

```typescript
// ChatMessageList.tsx
// 修改后：为 ChatToolStack 提供稳定 selector 依赖
const isToolExpanded = useCallback((toolId: string) => {
  return Boolean(expandedToolsRef.current[toolId]);
}, []);
```

#### (2) 解决陷阱 2：`togglePin` 依赖 `pinnedIdSet` 引发 100% 消息行重绘
* **根源**：`togglePin` 的 `useCallback` 依赖数组写了 `[pinnedIdSet]`，每次 Pin/Unpin 消息，`togglePin` 引用变动，导致所有消息行的 `prev.onTogglePin === next.onTogglePin` 均为 `false`。
* **重构方案**：使用 `useRef` 保存最新的 `pinnedIdSet`，保持 `togglePin` 函数句柄在应用生命周期内全局恒定不变。

```typescript
// ChatMessageList.tsx
const pinnedIdSetRef = useRef(pinnedIdSet);
pinnedIdSetRef.current = pinnedIdSet;

const togglePin = useCallback((msgId: string) => {
  const currentSet = pinnedIdSetRef.current;
  if (currentSet.has(msgId)) {
    unpinMessage(msgId);
  } else {
    pinMessage(msgId);
  }
}, [unpinMessage, pinMessage]); // 移除 pinnedIdSet 依赖，保持 togglePin 引用永久稳定！
```

#### (3) 补全沉重子组件的 `React.memo` 隔离
针对 `ChatToolStack`、`CompactToolRow`、`ToolResultBody`、`BatchApprovalBar`、`AsyncMarkdownBlock`、`ChangeOverviewCard` 进行全量 `React.memo` 包裹：

```typescript
// ChatToolCallBlock.tsx
export const ChatToolStack = React.memo(ChatToolStackInner, (prev, next) => {
  return (
    prev.toolCalls === next.toolCalls &&
    prev.sessionId === next.sessionId &&
    prev.isThinking === next.isThinking
  );
});

// ChatMessageRow.tsx
export const AsyncMarkdownBlock = React.memo(AsyncMarkdownBlockInner, (prev, next) => {
  return prev.text === next.text && prev.isStreaming === next.isStreaming;
});
```

---

### 4. 治理 Rule 1 样式规范 (清理原生 HTML `title` 属性)

扫描并替换 `ApprovalAskCard.tsx`、`ChatEmptyState.tsx`、`ChatStatusRibbons.tsx` 中所有的原生 `title="..."` 属性，统一使用 custom `<Tooltip>`：

```tsx
// 修改前 (违规代码)
<div className={styles.riskBadge} title={riskMeta?.riskReason}>

// 修改后 (符合 Rule 1 规范)
<Tooltip content={riskMeta?.riskReason}>
  <div className={styles.riskBadge}>...</div>
</Tooltip>
```

---

## 三、 验收测试与 SLA 指标门禁

完成上述重构后，需执行以下测试验证：

1. **类型与语法校验**：
   ```bash
   npm run check:desktop
   ```
2. **单元测试回归**：
   ```bash
   npm run test
   ```
3. **SLA 性能验收标准**：
   - **Forced Reflow**：在 DevTools Performance 观察，Resize 窗口时 `Forced Synchronous Layout` 计数为 **0**。
   - **Pretext `prepare()` 命中率**：重复滚动与窗口 Resize 时，`prepare()` 调用次数固定为消息总条数 N（无重复调用），热路径 100% 走 `layout()`。
   - **Pin 点击卡顿**：点击固定消息时，只有被固定和被取消固定的消息行触发 Re-render，视口内其他消息行 **0 Re-render**。
