# A-R2-05: useBubbleShrinkWidth 移除后 CSS 替代方案验证

## 旧调用位置

- `useBubbleShrinkWidth` 原在 `ChatMessageRow.tsx` 中被调用（用户气泡 + 助手气泡各一处）
- 引入路径：`import { useBubbleShrinkWidth, ... } from '../hooks/useTextMeasure'`
- **现状**：该 import 已移除，仅保留 `usePreparedText`（行 48）；全文 grep 无 `useBubbleShrinkWidth` / `maxWidth` / `bubbleRef` 残留

## CSS 替代方案

### 用户气泡 (`ChatMessageRow.module.css:61-77`)
```css
.userBubble {
  width: fit-content;     /* 替代 JS 计算的精确宽度 */
  max-width: 100%;        /* 父容器约束上限 */
}
```

### 助手消息体 (`ChatMessageRow.module.css:108-117`)
```css
.assistantBody {
  width: 100%;
  max-width: 100%;
  min-width: 0;
}
```

### 外部宽度约束
用户气泡区域受 `.userStack` 约束（行 53-59）：
```css
.userStack {
  max-width: min(78%, 560px);
}
```
响应式下（≤720px）进一步放宽：
```css
.userStack, .userBubble {
  max-width: min(92%, 100%);
}
```

## 确认

- `width: fit-content` ✅ — 用户气泡已设定，内容自适应宽度
- `max-width: 100%` ✅ — 两者均已设定，防止溢出父容器
- 无 JS `maxWidth` 内联样式残留 ✅
- 无 `useBubbleShrinkWidth` 函数调用或 import ✅

## TypeScript 编译结果

```
npx tsc --noEmit --project apps/crish-desktop/tsconfig.json
→ 无输出（编译通过，零错误）
```
