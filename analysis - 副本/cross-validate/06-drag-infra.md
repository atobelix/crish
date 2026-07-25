# Cross-06: 拖拽基础设施审计

审计日期：2026-07-22
审计范围：拖拽遮罩层工具集 + 列/组 Resize Hook + Workspace 集成 + CSS 样式
相关文件：
- `apps/crish-desktop/src/utils/dragOverlay.ts`（未追踪 untracked）
- `apps/crish-desktop/src/hooks/useColumnResize.ts`（未追踪 untracked）
- `apps/crish-desktop/src/components/Workspace.tsx`（已修改）
- `apps/crish-desktop/src/styles/shell/shell-dragdrop.css`
- `apps/crish-desktop/src/store/layoutAnimationStore.ts`
- `apps/crish-desktop/src/components/DropIndicatorLayer.tsx`

---

## 1. dragOverlay.ts 实现

**文件状态**：新文件，56 行，未追踪（untracked）

### 1.1 导出函数清单

| 函数 | 存在 | 说明 |
|------|------|------|
| `createDragOverlay(cursor)` | ✅ | 创建 `global-drag-overlay` div，fixed 全视口、z-index 99999、contain:strict |
| `removeDragOverlay(overlay)` | ✅ | 安全移除（检查 parentNode） |
| `createGlobalCursorStyle(cursor)` | ✅ | 创建 `<style id="global-drag-cursor">`，内容 `* { cursor: xxx !important; }` |
| `removeGlobalCursorStyle(style)` | ✅ | 安全移除 |
| `disableIframePointerEvents()` | ✅ | 查询 `iframe, webview, object, embed`，设 `pointer-events: none`，返回 restore fn |

### 1.2 VS Code 模式验证

- **createGlobalCursorStyle** — ✅ 符合 VS Code sash 策略：`* { cursor: xxx !important; }` 覆盖全局光标，优先级最高。
- **disableIframePointerEvents** — ✅ 遍历 `document.querySelectorAll('iframe, webview, object, embed')`，收集原始值，设 `none`，返回闭包批量恢复。标准实现。

### 1.3 潜在问题

- **无错误保护**：如果 `querySelectorAll` 返回的 iframe 在拖拽期间被移除，restore 闭包会静默操作 detached 元素（无报错，因为内部有 `try {} catch {}`，但是可能 dirty style）。当前实现中 `restoreFns` 已包裹 `try {} catch {}`，可接受。
- **style.id 硬编码**：`createGlobalCursorStyle` 使用 `style.id = 'global-drag-cursor'`，如果同页面有两个独立拖拽逻辑同时存在（极低概率），会发生 id 冲突。可接受。

---

## 2. useColumnResize 集成

**文件状态**：新文件，177 行，未追踪（untracked）

### 2.1 导出接口

```typescript
export function useColumnResize(wsId: string): {
  handleColResizerPointerDown: (e: React.PointerEvent, colIdx: number) => void;
  handleGroupResizerPointerDown: (e: React.PointerEvent, colIdx: number, groupIdx: number) => void;
}
```

### 2.2 实现要点检查

| 检查项 | 状态 | 详情 |
|--------|------|------|
| import dragOverlay 工具 | ✅ | createDragOverlay / removeDragOverlay / createGlobalCursorStyle / removeGlobalCursorStyle / disableIframePointerEvents |
| import layoutAnimationStore | ✅ | beginLayoutInteraction / endLayoutInteraction |
| 创建遮罩层 + CSS 光标 + 禁用 iframe | ✅ | handleColResizerPointerDown 和 handleGroupResizerPointerDown 均正确调用 |
| 遮罩层接收 pointermove（替代 setPointerCapture） | ✅ | `overlay.addEventListener('pointermove', handlePointerMove)` — 不是 window |
| pointerup/cancel 注册在 window | ✅ | 确保即使指针离开遮罩层也能结束拖拽 |
| ended 防重入 | ✅ | `let ended = false; if (ended) return; ended = true;` |
| dragOverlay 移除 | ✅ | endResize 成功路径中调用 removeDragOverlay |
| iframe 恢复 | ✅ | endResize 成功路径中调用 restoreIframes() |
| 全局光标样式移除 | ✅ | endResize 成功路径中调用 removeGlobalCursorStyle |
| beginLayoutInteraction / endLayoutInteraction | ✅ | 成功路径 + 错误路径均调用 |
| 双重 rAF 解冻 | ✅ | 成功路径：`rAF(() => rAF(() => endLayoutInteraction(...)))` |
| try/finally | ❌ | 使用 try/catch，非 try/finally |

### 2.3 关键差异：旧代码 vs 新代码

| 维度 | 旧代码（HEAD Workspace.tsx 内联） | 新代码（useColumnResize.ts） |
|------|------|------|
| 事件接收 | `window.addEventListener('pointermove', ...)` | `overlay.addEventListener('pointermove', ...)` |
| 全局遮罩层 | ❌ 无 | ✅ createDragOverlay |
| iframe 禁用 | ❌ 无 | ✅ disableIframePointerEvents |
| 全局 `* { cursor }` 样式 | ❌ 仅 `document.body.style.cursor` | ✅ createGlobalCursorStyle |
| 状态管理 | `document.body.classList.add('resizing-active')` | ✅ beginLayoutInteraction('workspace-resizing') |
| 双重 rAF 解冻 | ❌ 无 | ✅ rAF→rAF→endLayoutInteraction |
| try/catch | ❌ 无 | ✅ 有 |
| ended 防重入 | ❌ 无 | ✅ 有 |

### 2.4 问题

#### 问题 A: catch 块遗漏资源清理（严重）

```typescript
// 当前 catch 块：
catch (err) {
  console.error('[useColumnResize] endResize error', err);
  endLayoutInteraction('workspace-resizing');
  document.body.style.cursor = '';
  removeDragOverlay(overlay);
  // ❌ 未调用 restoreIframes()
  // ❌ 未调用 removeGlobalCursorStyle(cursorStyle)
}
```

如果 endResize 成功路径中某行提前抛出异常（例如 `resizeColumns` 或 `resizeGroups` 调用失败），则 iframe 保持 `pointer-events: none`，全局 `* { cursor: xxx !important; }` 残留在 `<head>` 中，直到用户刷新页面。

**修复方案**：改为 try/finally 或将缺失的 restore 调用加入 catch。

#### 问题 B: 错误路径缺少双重 rAF

成功路径使用 `rAF(() => rAF(() => endLayoutInteraction(...)))` 延迟解冻，让 React 在下一帧 settle。但错误路径直接在 catch 中同步调用 `endLayoutInteraction`，绕过此机制。虽然错误路径是异常情况，但解冻时机不一致可能导致偶发布局闪烁。

**修复方案**：catch 块也使用双重 rAF，或抽离为统一 `thawAfterResize()` 函数。

#### 问题 C: 缺少 focusThisWorkspace（轻度）

旧 Workspace.tsx 的 `handleColResizerPointerDown` 在拖拽开始时调用 `focusThisWorkspace()`。新 hook 未做此操作。在拆分工作区模式下，点击非活动工作区的 splitter 不会自动切换焦点，可能造成键盘导航与视觉焦点不一致。

**修复方案**：在 `handleColResizerPointerDown` 和 `handleGroupResizerPointerDown` 中调用 focusThisWorkspace。但 hook 需要接收 focus callback 参数，增加接口复杂度。也可由 Workspace.tsx 的 `onPointerDownCapture` 处理（已在容器层存在）。

当前容器层的 `onPointerDownCapture={focusThisWorkspace}` 应该已经覆盖此场景（事件捕获阶段触发），所以实际影响有限。**低优先级**。

---

## 3. Workspace.tsx 修改状态

### 3.1 行数变化

| 指标 | 值 |
|------|------|
| 旧文件行数 (HEAD) | 717 行 |
| 新文件行数 (工作树) | 524 行 |
| **净减少** | **-193 行** |
| diff 统计 | +142 / -403（包含新增 WorkspaceDropIndicator 组件） |

### 3.2 改动清单

#### 已移除
- **内联 `handleColResizerPointerDown`**（约 40 行）→ 迁移至 useColumnResize.ts
- **内联 `handleGroupResizerPointerDown`**（约 45 行）→ 迁移至 useColumnResize.ts
- **复杂 drag preview 列/组可见性逻辑**（约 80 行 `renderedColumns` 中 `shouldCollapseSourceGroup`/`isPlaceholderGroup` 等）→ 由浮层 WorkspaceDropIndicator + DropIndicatorLayer 替代
- **废弃的 placeholder 组渲染**（约 30 行 `isPlaceholderGroup` 分支）
- **`Plus` lucide-react 导入** — 不再使用

#### 已新增
- **`useColumnResize` 导入 + 解构**（3 行）
- **`WorkspaceDropIndicator` 组件**（约 80 行）— 用 `useLayoutEffect` 计算 drop preview 的 fixed 几何，单一浮层
- **`DropIndicatorLayer` 集成**（1 行：`<DropIndicatorLayer wsId={ws.id} />`）
- **`DropPreviewState` 类型导入、`computeDropIndicatorBox`、`resolveTabBarHeight`、`DEFAULT_TAB_BAR_H` 导入**
- **`renderedColumns` 简化实现** — 不再包含 drag 可见性逻辑，契约 §3 合规（不 splice placeholder）

#### 保持不变
- **`resizeColumns` / `resizeGroups`** store selector — 仍被 `nudgeColumnByKey` / `nudgeGroupByKey` / Home/End 键盘处理使用
- **splitter UI 结构** — col-splitter / group-splitter 的 DOM 结构和 aria 属性不变
- **workspace 容器属性 / aria 标签 / 读屏 live region**

### 3.3 setPointerCapture 审计

旧代码未使用 `setPointerCapture`。新代码也未引入。指针事件管理升级路径为：

```
旧: window.addEventListener('pointermove', ...)  [无遮罩]
新: overlay.addEventListener('pointermove', ...)  [有遮罩 + iframe 禁用]
```

使用全视口遮罩层接收 pointermove，效果等价于 `setPointerCapture`，且额外提供光标覆盖和 iframe 屏蔽能力。**正确实现**。

### 3.4 冻结/解冻时序

```
pointerdown:
  → beginLayoutInteraction('workspace-resizing')  // body 加 is-layout-frozen + resizing-active + is-resizing
  → createDragOverlay + disableIframePointerEvents + createGlobalCursorStyle

pointerup / pointercancel:
  → 清理事件监听器
  → removeDragOverlay + restoreIframes + removeGlobalCursorStyle
  → resizeColumns/resizeGroups (store 写入)
  → 清除 style.width
  → rAF(() => rAF(() => {
      endLayoutInteraction('workspace-resizing')  // body 移除 class
      document.body.style.cursor = ''
    }))
```

双重 rAF 确保：
1. 第一帧：React 批量处理 store 更新 + 重渲染
2. 第二帧：CSS transition/animation 恢复前布局已稳定

**时序正确**。

---

## 4. shell-dragdrop.css 样式验证

### 4.1 核心选择器存在性

| 选择器/规则 | 状态 | 位置 |
|------------|------|------|
| `.global-drag-overlay` | ✅ | line 156-165 |
| `body.is-layout-frozen * { transition: none !important; }` | ✅ | line 7-24 |
| `body.is-resizing iframe { pointer-events: none !important; }` | ✅ | line 148-153 |
| `body.is-layout-frozen .workspace-canvas { contain: layout style; }` | ✅ | line 169-183 |
| `.drop-indicator` | ✅ | line 30-44 |
| `.drop-indicator-layer` | ✅ | line 186-192 |
| `.drop-indicator-line-v` / `.drop-indicator-line-h` | ✅ | line 195-214 |
| `.drop-indicator-merge` / `.drop-indicator-split` | ✅ | line 217-236 |
| `.drop-indicator-col-preview` | ✅ | line 239-248 |
| `.card-tab` / `.drag-overlay-preview-card` | ✅ | line 82-110 |
| `body.dragging-card, body.dragging-card * { cursor: grabbing !important; }` | ✅ | line 113-116 |
| `.tab-insert-line` | ✅ | line 56-64 |
| `.drag-ghost-hidden` | ✅ | line 138-141 |

### 4.2 冗余检查

- **`body.is-layout-frozen iframe/webview`** 规则出现两次（line 124-135 和 line 144-153），语义相同但作用于不同 body class 集合。重复但不冲突。应合并以降低维护成本。
- **`.tab-placeholder-indicator` 隐藏规则**（line 67-78）——历史残留，可清理。

---

## 5. 契约 §3 / §5 合规性

### 5.1 §3：不 splice placeholder 列/组

- ✅ `renderedColumns` 不再包含 `shouldCollapseSourceGroup` 或 `isPlaceholderGroup` 逻辑
- ✅ WorkspaceDropIndicator 使用 `useLayoutEffect` 计算 `fixed` 几何，不修改 DOM 树
- ✅ DropIndicatorLayer 使用 `createPortal` 渲染在 `document.body` 中
- ✅ 标题注释明确声明"禁止 splice placeholder 列/组"

### 5.2 §5：iframe pointer-events 屏蔽

- ✅ CSS 层：`body.is-layout-frozen iframe` + `body.is-resizing iframe` 等
- ✅ JS 层：`disableIframePointerEvents()` 运行时遍历覆盖
- ✅ CSS 选择器涵盖 `iframe, webview, object, embed`
- ⚠️ JS 层仅覆盖 `iframe, webview, object, embed`，与 CSS 一致

---

## 6. 剩余问题

### P0 — 无

### P1 — 资源泄漏：catch 块遗漏 restoreIframes 和 removeGlobalCursorStyle

```typescript
// 修复方案 — useColumnResize.ts endResize 的 catch 块
catch (err) {
  console.error('[useColumnResize] endResize error', err);
  restoreIframes();          // ⊕
  removeGlobalCursorStyle(cursorStyle);  // ⊕
  endLayoutInteraction('workspace-resizing');
  document.body.style.cursor = '';
  removeDragOverlay(overlay);
}
```

### P2 — 错误路径缺少双重 rAF

catch 块直接同步调用 `endLayoutInteraction`，与成功路径的双重 rAF 行为不一致。建议抽离为：

```typescript
function thawAfterResize() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      endLayoutInteraction('workspace-resizing');
      document.body.style.cursor = '';
    });
  });
}
```

在成功和错误路径中统一调用。

### P3 — 文件未提交

`dragOverlay.ts` 和 `useColumnResize.ts` 均为 untracked 文件。如果工作树被重置（`git checkout -- .` 或 `git restore`），这两个文件将永久丢失。应尽早 `git add`。

### P4 — workspace-resizing 类型注册确认

`layoutAnimationStore.ts` 的 `TYPE_BODY_CLASSES` 中 `workspace-resizing` 映射到 `['resizing-active', 'is-resizing']`。这两个 class 在 `shell-dragdrop.css` 中用于禁用 transition 和 iframe pointer-events。链路完整。

### P5 — focusThisWorkspace 回归（轻度）

容器层 `onPointerDownCapture={focusThisWorkspace}` 已在。如果事件捕获阶段正常触发，则不构成 bug。但如果用户点击的 splitter 在 shadow DOM 或其他隔离边界内，捕获可能被绕过。建议在 useColumnResize hook 中增加可选的 `onStart` callback。

---

## 7. 修复方案优先级

| 优先级 | 问题 | 操作 | 预计工时 |
|--------|------|------|----------|
| P1 | catch 块遗漏 restoreIframes / removeGlobalCursorStyle | 在 useColumnResize.ts 两个 catch 块中添加缺失的 restore 调用 | 5 分钟 |
| P2 | 错误路径缺少双重 rAF | 抽离统一 thawAfterResize 函数，两端调用 | 10 分钟 |
| P3 | 文件未提交 | `git add` 两个新文件 | 1 分钟 |
| P4 | CSS 冗余（重复 iframe 规则、.tab-placeholder-indicator） | 清理 shell-dragdrop.css 重复规则 | 10 分钟 |
| P5 | focusThisWorkspace 回归 | 在 useColumnResize 中增加可选 onStart callback 或确认容器捕获有效 | 15 分钟 |

### 立即操作建议

```bash
# 1. 暂存新文件
git add apps/crish-desktop/src/utils/dragOverlay.ts apps/crish-desktop/src/hooks/useColumnResize.ts

# 2. 修复 catch 块
#    useColumnResize.ts:86-90 和 :165-169 — 两个 endResize 的 catch 块
#    添加 restoreIframes() 和 removeGlobalCursorStyle(cursorStyle)
```

---

## 8. 结论

拖拽基础设施实现整体质量良好。dragOverlay.ts 实现了完整的 VS Code 风格全局遮罩层 + 光标覆盖 + iframe 屏蔽三件套。useColumnResize.ts 成功将 Workspace.tsx 的内联 resize 逻辑抽取为可测试 hook，同时增加了旧代码缺失的冻结/解冻管理和资源安全。Workspace.tsx 净减 193 行，结构更清晰。

**核心隐患**：两个 endResize 的 catch 块遗漏了 `restoreIframes()` 和 `removeGlobalCursorStyle()`，在异常路径会造成 iframe 指针事件永久禁用 + `<style>` 标签残留。这是 P1 级问题，建议立即修复后提交。
