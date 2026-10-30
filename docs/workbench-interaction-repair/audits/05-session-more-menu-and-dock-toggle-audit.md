# 会话列表 More 菜单弹出、SmartPanel 切换与 LayerStack 互斥机制源码级审计报告

> **审计专家**：浮层堆栈与交互冲突审计专家（LayerStack & Menu Reviewer）  
> **审计提交**：`commit f6ae63f5ff5431128c31202eeadfccfb42f8e17f`  
> **对比基准**：`f6ae63f5f^` (上一版本)  
> **战役工作区**：`docs/workbench-interaction-repair/`  
> **关联详案**：[`05-session-more-menu-and-dock-toggle-plan.md`](../05-session-more-menu-and-dock-toggle-plan.md)  
> **审计日期**：2026-10-29  
> **审计结论**：**【条件性通过，伴随高危交互回归需要立即修复（CONDITIONAL PASS WITH CRITICAL/MAJOR FINDINGS）】**

---

## 一、审查目标与改动范围回顾

本次审计聚焦桌面端工作台左侧栏会话项在「点击 More (···) 按钮弹出上下文菜单、右键唤起菜单、全局 LayerStack 浮层调度互斥排他、外部手势交互与键盘无障碍导航」的完整链路，执行深层源码级穿透与运行期时序审计。

### 1. 涉及的核心文件与改动
1. **`apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx`**：会话右键与更多操作上下文菜单适配器（`commit f6ae63f5f` 关键修改点）。
2. **`apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.tsx`**：原生纯 Portal 浮层渲染容器与其键盘导航钩子 `hooks/useKeyboardNav.ts`。
3. **`apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.tsx`**：内嵌 Radix Popover 与内部层注册的高阶展开面板。
4. **`apps/crish-desktop/src/components/ui/index.ts`**：原子设计系统统一导出桶（Barrel Export）。
5. **`apps/crish-desktop/src/components/sidebar/useSidebarContextMenu.ts`**：侧栏会话上下文菜单状态机、物理坐标钳位与 Exclusive 开关守卫。
6. **`apps/crish-desktop/src/components/ui/Menu/menuOpenGuard.ts`**：防重入与外点反弹抑制门闩（`shouldSuppressMenuReopen`, `toggleExclusiveMenu`）。
7. **`apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackManager.ts` & `layerStackDom.ts`**：全局浮层单核状态机、LIFO 退栈与外点命中探测算法。
8. **`apps/crish-desktop/src/components/sidebar/SidebarContextMenus.exclusive.test.tsx`**：排他层栈防回归单元测试套件。
9. **`docs/workbench-interaction-repair/05-session-more-menu-and-dock-toggle-plan.md`**：本次战役设计规范与契约详案。

### 2. 精确 Diff 审查 (`git show f6ae63f5f -- SessionContextMenu.tsx`)
```diff
diff --git a/apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx b/apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx
index 41d0465eb..ab2d3a746 100644
--- a/apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx
+++ b/apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx
@@ -1,10 +1,7 @@
 import React, { useMemo } from 'react';
 
-import {
-  SmartPanel,
-  type MenuItem,
-  useLayerRegistration,
-} from '@/components/ui';
+import { SmartPanel, type MenuItem } from '../ui/SmartPanel';
+import { useLayerRegistration } from '@/components/ui';
 import type {
   SessionContextMenuState,
   SessionMenuAction,
@@ -44,7 +41,6 @@ export const SessionContextMenu: React.FC<SessionContextMenuProps> = ({
       dismissible: true,
       onDismiss: () => onCloseContextMenu?.(),
       elementRef: menuRef,
-      anchorRef: contextMenuTriggerRef,
       restoreFocusTarget: contextMenuTriggerRef?.current ?? undefined,
     },
     isOpen
```

---

## 二、审计结论总表（Scorecard & Executive Summary）

### 1. 核心审查维度评分表

| 审查维度 | 评级 | 结论核心摘要 |
| :--- | :---: | :--- |
| **1. 互斥驱逐根因（Layer Eviction）** | **PASS** | 切回原生 `../ui/SmartPanel` 成功斩断了 `SmartExpandablePanel` 内部派生的二次注册（`dropdown-menu`），彻底消除了挂载瞬间 `evictExclusivePeers` 自杀式清退问题；但 `@/components/ui/index.ts` 仍残留别名遮蔽暗礁。 |
| **2. 触发点与外部手势（Trigger & Pointer Gestures）** | <font color="#d93025">**FAIL (Critical)**</font> | **产生严重交互倒退**：因删除了 `anchorRef: contextMenuTriggerRef`，当菜单已展开时再次点击同一个 More 按钮（`···`），`pointerdown` 误判为外部点击并提前销毁菜单，后续 `click` 因缺少 `anchor` 无法抑制反弹重开，**导致再次点击 More 按钮无法收起菜单（瞬间关了又开）**。 |
| **3. 无障碍与键盘焦点（A11y & Focus）** | <font color="#f29900">**WARN (Major)**</font> | `SmartPanel` 的 `useKeyboardNav` 存在**分隔符偏移（Off-by-divider）索引错位漏洞**：`focusedIndex` 计入了 `divider`，但 DOM 查询器排除了 `separator`，导致方向键导航越过第一个分割线后**视觉焦点与 DOM 焦点发生错位**，导航到底部时 DOM 焦点彻底丢失；且 Tab 键未拦截导致焦点逃逸。 |
| **4. 单元测试针对性（Unit Test Rigour）** | <font color="#f29900">**WARN (Major)**</font> | **存在严重假绿（Fake Green）**：Plan 05 设计的挂载防自杀测试**从未合入测试套件**；已有的 11 个测试中，测试 7 手工 Mock 了已被删除的 `anchorRef`，测试 9 纯内存调用函数绕过了 DOM 手势，测试 10 在 `pointerup` 后刻意截断未模拟真实的 `click` 事件。 |

### 2. 缺陷统计矩阵

- **【Critical 致命阻断】**：1 项（再次点击 More 按钮无法关闭菜单，反弹重开）
- **【Major 架构/功能缺陷】**：3 项（`useKeyboardNav` 菜单分隔符焦点索引错位；测试套件存在假绿且缺失防自杀断言；`@/components/ui` 桶文件别名遮蔽未清除）
- **【Minor 边界/体验隐患】**：2 项（Tab 键穿透逃逸；右键打开时 Esc 还原焦点目标非可聚焦元素）
- **【Suggestion 优化建议】**：2 项（统一 `LayerStack` 触发器防抖手势；测试补充真实全手势宏任务管线）

---

## 三、四大核心审查维度源码级深度剖析

### 维度 1：互斥驱逐根因（Layer Eviction Analysis）

#### 1.1 历史自杀式驱逐时序追踪
在 `c18eeb80804cf9d5f96c928e17678dfd776323ef`（`[BATCH-WORKSPACE-SHELL]`）提交中，`SessionContextMenu.tsx` 错误地将导入变更为：
```tsx
import { SmartPanel, type MenuItem, useLayerRegistration } from '@/components/ui';
```
在 [`apps/crish-desktop/src/components/ui/index.ts:30`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/index.ts#L30) 中：
```ts
export * from './SmartExpandablePanel/index';
// SmartExpandablePanel/index.ts:
export { SmartExpandablePanel, SmartExpandablePanel as SmartPanel } from './SmartExpandablePanel';
```
导致运行时挂载的是 `SmartExpandablePanel`。

其内部调用链如下：
1. `SessionContextMenu` 渲染，外部显式调用 `useLayerRegistration({ id: 'sidebar-session-context-menu', type: 'context-menu' })`；
2. JSX 挂载 `<SmartPanel />`，实质为 `SmartExpandablePanel`；
3. `SmartExpandablePanel` 内部自动执行其自身的 `useLayerRegistration({ id: panelId, type: 'dropdown-menu' })`；
4. `LayerStackManager.register` 触发 `evictExclusivePeers`：
   ```ts
   // layerStackDom.ts:188-219
   export function findExclusivePeersToDismiss(incoming, layers) {
     if (!isExclusivePeerLayerType(incoming.type)) return [];
     // 'dropdown-menu' 与 'context-menu' 同属于 EXCLUSIVE_PEER_LAYER_TYPES
     // 两者既无父子 parentId 拓扑关系，也无 DOM 包含关系
     toDismiss.push(peer.id); // 命中 'sidebar-session-context-menu'
   }
   ```
5. `LayerStackManager` 判定同级冲突，向宿主层下发 `dismissLayer('sidebar-session-context-menu', 'programmatic')`；
6. `SessionContextMenu` 的 `onDismiss` 触发，调用 `onCloseContextMenu?.()` -> `setContextMenu(null)`；
7. 宿主在单帧内即被自杀式清退卸载，呈现为**点击 More 按钮无任何反应或微秒级闪烁**。

#### 1.2 本次提交 `f6ae63f5f` 的根因消除有效性
定位至 [`apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx:3-4`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx#L3-L4)：
```tsx
import { SmartPanel, type MenuItem } from '../ui/SmartPanel';
import { useLayerRegistration } from '@/components/ui';
```
- **架构穿透**：`../ui/SmartPanel` 指向原生纯 Portal 原语 [`apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.tsx)。
- **源码实证**：经逐行审查 `SmartPanel.tsx`（共 259 行），该组件内部**完全没有引入或调用 `useLayerRegistration`**。它仅使用 `createPortal` 挂载 DOM，并通过原生的 `position: fixed` 与坐标计算呈现。
- **审计结论**：**通过**。浮层层栈中现在仅存在唯一的 `sidebar-session-context-menu`（`type: 'context-menu'`），从根源上消除了同级自杀式驱逐。

#### 1.3 残留架构暗礁：桶文件别名污染（Major 缺陷）
审查 [`apps/crish-desktop/src/components/ui/index.ts:30`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/index.ts#L30) 发现：
```ts
export * from './SmartExpandablePanel/index';
```
而 `SmartExpandablePanel/index.ts` 依然保有 `export { SmartExpandablePanel as SmartPanel }`。
这意味着 `@/components/ui` 这个全局桶仍然向外暴露了具有遮蔽性的假冒 `SmartPanel`。后续任何开发者或 IDE 自动补全导入时，一旦手滑选择 `@/components/ui`，自杀式驱逐将立刻死灰复燃！必须对 Barrel 导出进行物理清理。

---

### 维度 2：触发点与外部手势冲突（Trigger & Pointer Gestures）

在本次提交中，作者在修改 import 的同时，附带删除了 `anchorRef: contextMenuTriggerRef`：
```diff
-      anchorRef: contextMenuTriggerRef,
```
经审查，该删除引发了严重的交互倒退与逻辑断裂。

#### 2.1 场景 A：右键点击其他会话行（正常关闭并打开新菜单）
- **时序追踪**：
  1. 用户在会话 1 打开菜单；
  2. 用户在会话 2 所在行右键单击；
  3. 浏览器派发 `pointerdown`（`button: 2`）至会话 2 行节点；
  4. `LayerStackManager.handlePointerDown` 捕获事件，执行 `scanLayersForOutsidePointer`：
     - target（会话 2 行）不在会话 1 的 `menuRef` 内；
     - 触发对会话 1 菜单的退栈清退：`onDismiss('outside-pointer')` -> 会话 1 菜单关闭；
  5. 浏览器继续派发 `contextmenu` 事件；
  6. 会话 2 的 `handleContextMenu` 响应，判定 `e.button === 2`，绕过 `toggleExclusiveMenu`，执行 `openThis()`；
  7. 会话 2 的菜单正常挂载并重新登记 layer。
- **结论**：**右键切换功能正常**。

#### 2.2 场景 B：左键点击外部空白区域/聊天区/输入框（平滑关闭）
- **时序追踪**：
  1. 用户左键点击聊天区域或空白背景；
  2. `pointerdown` 命中背景节点；
  3. `scanLayersForOutsidePointer` 检测到 target 既不在 `menuRef` 中，也不在 `anchorRef` 中；
  4. `dismissLayer('sidebar-session-context-menu', 'outside-pointer')` 触发；
  5. `onCloseContextMenu()` 被调用，`setContextMenu(null)` 清空状态，菜单平滑退出。
- **结论**：**外点关闭功能正常**。

#### 2.3 场景 C：再次点击同一个 More 按钮（`···`）——【Critical 致命阻断】
**这是本次提交引入的最严重缺陷。用户点击 More 按钮展开菜单后，再次点击该按钮意图收起菜单时，菜单无法收起！**

##### 物理时序断裂过程分析：
在标准浏览器中，用户左键单击一个按钮的物理事件流为：  
`pointerdown` $\rightarrow$ `mousedown` $\rightarrow$ `pointerup` $\rightarrow$ `mouseup` $\rightarrow$ `click`。

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Btn as 会话 More 按钮 (···)
    participant LSM as LayerStackManager
    participant Menu as SessionContextMenu
    participant Guard as menuOpenGuard / useSidebarContextMenu

    Note over Menu: 初始状态：菜单已打开 (isOpen=true, contextMenu!={...})
    User->>Btn: 鼠标左键按下 (pointerdown)
    
    rect rgb(255, 235, 235)
    Note over LSM: 步骤 1：LayerStack 全局捕获阶段拦截 pointerdown
    LSM->>LSM: scanLayersForOutsidePointer(layers, target=Btn)
    Note over LSM: 关键断裂点：layer.anchorRef 为 undefined！<br/>Btn 不在 menuRef 中，且 anchorEl 为 null！<br/>=> LSM 将 Btn 判定为“外部点击 (Outside Pointer)”！
    LSM->>LSM: 创建快照 snapshot: { anchor: null, target: Btn }
    LSM->>LSM: dismissLayer('sidebar-session-context-menu', 'outside-pointer')
    LSM->>Menu: 执行 onDismiss() -> onCloseContextMenu()
    Menu->>Guard: setContextMenu(null)
    end

    Note over Menu: 菜单提前被销毁卸载 (Unmounted)！
    
    User->>Btn: 鼠标抬起与单击 (click)
    Btn->>Guard: 触发 onClick -> handleContextMenu(e, sessionId)
    
    rect rgb(255, 245, 230)
    Note over Guard: 步骤 2：Exclusive 切换判定
    Guard->>Guard: isMoreTrigger = true, e.button = 0
    Guard->>Guard: 检查当前状态：contextMenu?.sessionId === sessionId
    Note over Guard: 因步骤 1 已将 contextMenu 置为 null！<br/>=> open 参数传入 false！
    Guard->>Guard: 调用 toggleExclusiveMenu(open=false, setOpen, triggerEl=Btn)
    end
    
    rect rgb(255, 230, 230)
    Note over Guard: 步骤 3：反弹重开抑制门闩失效
    Guard->>LSM: wasTriggerClickAfterDismiss(triggerEl=Btn)
    LSM->>LSM: isAnchorTriggerMatch(snapshot, triggerEl=Btn)
    Note over LSM: 核心致命行 (layerStackDom.ts:326):<br/>if (snapshot.anchor && snapshot.anchor.contains(...))<br/>因步骤 1 中 snapshot.anchor 恒等于 null！<br/>=> isAnchorTriggerMatch 判定失败，返回 false！<br/>=> shouldSuppressMenuReopen 返回 false (未抑制)！
    Guard->>Guard: if (open) setOpen(false); else setOpen(true);
    Guard->>Guard: 执行 else 分支：setOpen(true) -> openThis()！
    Guard->>Menu: 重新装载 setContextMenu(nextMenuState)！
    end

    Note over User,Menu: 最终现场：用户本意是收起菜单，结果菜单在 pointerdown 关掉后立刻在 click 被重新打开！
```

##### 源码实证：
1. 定位至 [`layerStackDom.ts:274-278`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/internal/layer-stack/layerStackDom.ts#L274-L278)：
   ```ts
   const anchorEl = resolveElement(layer.anchorRef);
   if (anchorEl && anchorEl.contains(target)) {
     hitAnchorTarget = target;
     continue; // 若 anchorEl 存在且包含点击目标，不会视作外点驱逐！
   }
   ```
   **断裂证据**：因 `anchorRef` 被删，`anchorEl` 为 `null`，点击 More 按钮被无辜归入 `layersToDismiss`！
2. 定位至 [`layerStackDom.ts:457-464`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/internal/layer-stack/layerStackDom.ts#L457-L464)：
   ```ts
   this.dismissedByPointer = createDismissedByPointerSnapshot(
     event.pointerId,
     topLayer.id,
     resolveElement(topLayer.anchorRef), // 记录为 null！
     target,
     now
   );
   ```
3. 定位至 [`layerStackDom.ts:324-337`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/internal/layer-stack/layerStackDom.ts#L324-L337)：
   ```ts
   export function isAnchorTriggerMatch(snapshot, triggerEl) {
     const anchor = snapshot.anchor;
     // 致命门禁：若 anchor 为 null，整个判定短路返回 false！
     if (
       anchor &&
       anchor.isConnected &&
       (anchor === triggerEl || anchor.contains(triggerEl) || ...)
     ) {
       return true;
     }
     return false;
   }
   ```
4. 定位至 [`menuOpenGuard.ts:14-22`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/menuOpenGuard.ts#L14-L22)：
   ```ts
   export function toggleExclusiveMenu(open, setOpen, triggerEl) {
     if (shouldSuppressMenuReopen(triggerEl)) return; // 无法抑制！
     if (open) setOpen(false);
     else setOpen(true); // 执行此处，重新展开！
   }
   ```

**审计结论**：删除 `anchorRef: contextMenuTriggerRef` 破坏了排他层栈与触发器的联动不变量。必须立刻恢复 `anchorRef: contextMenuTriggerRef`！

---

### 维度 3：无障碍与键盘焦点管理（A11y & Focus Management）

#### 3.1 `useKeyboardNav` 分隔符偏移导致的焦点错位（Off-by-divider Bug）——【Major 缺陷】
定位至 [`apps/crish-desktop/src/components/ui/SmartPanel/hooks/useKeyboardNav.ts:50-59`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/hooks/useKeyboardNav.ts#L50-L59)：
```ts
// Sync DOM focus and scroll into view
useEffect(() => {
  if (focusedIndex >= 0 && contentRef.current) {
    const itemElements = contentRef.current.querySelectorAll<HTMLElement>(
      '[role="menuitem"], [role="menuitemcheckbox"], [role="option"]'
    );
    const target = itemElements[focusedIndex]; // 致命的下标直通假设！
    target?.focus();
    target?.scrollIntoView?.({ block: 'nearest' });
  }
}, [focusedIndex, contentRef]);
```

##### 错位机制实证分析：
在 `SessionContextMenu.tsx:49-124` 中，菜单定义了 13 个项，其中包括 3 个分割线：
- `[0]` open-current (`menuitem`)
- `[1]` open-split (`menuitem`)
- `[2]` open-new (`menuitem`)
- `[3]` div-1 (`divider`, 渲染为 `<div role="separator">`)
- `[4]` rename (`menuitem`)
- `[5]` pin (`menuitem`)
- `[6]` archive (`menuitem`)
- `[7]` branch (`menuitem`)
- `[8]` div-2 (`divider`, `separator`)
- `[9]` copy-id (`menuitem`)
- `[10]` delete (`menuitem`)
- `[11]` div-3 (`divider`, `separator`)
- `[12]` export (`menuitem`)

在 DOM 中，`querySelectorAll` 仅筛选 `[role="menuitem"]`，返回的 NodeList 仅包含 10 个按钮元素：
- `itemElements[0]` $\rightarrow$ open-current
- `itemElements[1]` $\rightarrow$ open-split
- `itemElements[2]` $\rightarrow$ open-new
- `itemElements[3]` $\rightarrow$ rename (对应 flatNavItems[4])
- `itemElements[4]` $\rightarrow$ pin (对应 flatNavItems[5])
- ...
- `itemElements[9]` $\rightarrow$ export (对应 flatNavItems[12])

而在 `useKeyboardNav.ts` 中：
- `validIndices` 计算出的索引是基于 `flatNavItems` 的：`[0, 1, 2, 4, 5, 6, 7, 9, 10, 12]`；
- 当用户聚焦在 `rename` 时，`focusedIndex = 4`；
- React 渲染层通过 `flatNavItems[focusedIndex]?.id === entry.id` 判定高亮，因此界面上**视觉高亮框在 `rename` 上**；
- 但 DOM 聚焦逻辑执行了 `target = itemElements[4]`，将真实光标聚焦到了 **`pin`（置顶）** 上！
- 当用户继续按向下键导航到最后的 `delete`（`focusedIndex = 10`）和 `export`（`focusedIndex = 12`）时，`itemElements[10]` 与 `itemElements[12]` 为 **`undefined`**！
- 此时 `target?.focus()` 静默失效，**DOM 焦点彻底丢失回落至 body**！

#### 3.2 Tab 键逃逸与孤魂浮层（Minor 隐患）
经审查 `useKeyboardNav.ts:61-142`，该 hook 处理了 `Escape`, `ArrowDown`, `ArrowUp`, `Home`, `End`, `ArrowRight`, `ArrowLeft`, `Enter`, `Space`，但**完全没有处理 `Tab` 键**。  
- `SmartItemRow.tsx:89` 设置了 `tabIndex={isFocused ? 0 : -1}`。
- 当用户在菜单展开状态下按下 `Tab` 键时，焦点直接穿透 Portal 容器跳出，落到主界面外部不可预测的输入框或按钮上；
- 此时 `SmartPanel` 依然保持打开状态，既未捕获 Tab 循环，也未在失焦时关闭，形成界面悬浮孤魂。
- **规范要求**：在 WAI-ARIA Menu 规范中，菜单内按 `Tab` 键应收起菜单并归位焦点，或阻止 Tab 跳出。

#### 3.3 Escape 键与焦点平滑还原
- 在 `useKeyboardNav.ts:77-80` 与 `LayerStackManager` 中均对 `Escape` 实现了消费与退栈。
- `SessionContextMenu.tsx:44` 传递了 `restoreFocusTarget: contextMenuTriggerRef?.current ?? undefined`。
- **审查表现**：
  - 左键 More 按钮打开时，按 Escape 能够平滑将焦点交还给 More 按钮；
  - 但当通过**右键点击会话行**打开菜单时，`contextMenuTriggerRef.current` 是会话行的外层 `div`（`data-testid="sidebar-session-item"`）。该 `div` 默认没有 `tabIndex`，执行 `restoreFocusTarget.focus()` 会被浏览器静默忽略，焦点回退至 `document.body`。

---

### 维度 4：单元测试针对性与假绿剖析（Unit Test Rigour）

审查 [`apps/crish-desktop/src/components/sidebar/SidebarContextMenus.exclusive.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.exclusive.test.tsx) 的 11 个测试用例，发现多处测试设计脱节与假绿现象：

#### 4.1 Plan 05 规划的防自杀测试被彻底遗漏
在详案 [`05-session-more-menu-and-dock-toggle-plan.md:430-475`](file:///c:/Software/conex/docs/workbench-interaction-repair/05-session-more-menu-and-dock-toggle-plan.md#L430-L475) 中明确设计了核心防回归用例：
```tsx
it('SessionContextMenu 首次挂载时不应发生内部互斥自杀（onClose 不被调用）', async () => { ... });
```
该用例用于断言挂载时 `onClose` 未被触发，且 `layers` 中不存在 `dropdown-menu`。  
**审计现场**：在 `commit f6ae63f5f` 的提交物中，**该测试完全没有被合入 `SidebarContextMenus.exclusive.test.tsx`**！全仓 grep 仅在文档中存在该字样。提交信息中的“补充防回归单元测试”属于宣传与代码脱节。

#### 4.2 测试 7：手工注入 Mock 数据的假绿（Fake Green in Test 7）
定位至 `SidebarContextMenus.exclusive.test.tsx:187-219`：
```tsx
it('左键更多：外点关后同一 trigger 不重开', () => {
  ...
  layerStackService.register({
    id: SESSION_CONTEXT_MENU_LAYER_ID,
    type: 'context-menu',
    dismissible: true,
    onDismiss: () => undefined,
    elementRef: { current: content },
    anchorRef: { current: btn }, // 致命的假绿根源：手工注入了 anchorRef！
  });
  ...
  expect(shouldSuppressMenuReopen(btn)).toBe(true);
});
```
- **假绿根因**：该测试测试的是 `useSidebarContextMenu` hook 与 `layerStackService` 的纯逻辑，但在测试中它**没有渲染 `SessionContextMenu` 组件**，而是**由测试用例自己注册了一个虚假的 Layer**！
- 在这个虚假的 Layer 中，测试作者手工写了 `anchorRef: { current: btn }`；
- 然而在真正的组件 `SessionContextMenu.tsx` 中，`anchorRef` 已经被删除了！
- 因此，测试 7 绿得毫无价值，它掩盖了真实组件中 `anchorRef` 缺失导致反弹抑制失效的严重 Bug。

#### 4.3 测试 9：绕过浏览器手势管线的纯内存调用（Fake Green in Test 9）
定位至 `SidebarContextMenus.exclusive.test.tsx:258-282`：
```tsx
it('左键同一会话已开则写死关闭（禁止 !prev）', () => {
  ...
  act(() => {
    result.current.handleContextMenu(fakeMouseEvent(btn, { button: 0 }), 'sess-1');
  });
  expect(result.current.contextMenu?.sessionId).toBe('sess-1');

  act(() => {
    result.current.handleContextMenu(fakeMouseEvent(btn, { button: 0 }), 'sess-1');
  });
  expect(result.current.contextMenu).toBeNull();
});
```
- **假绿根因**：连续两次直接调用 `handleContextMenu`，完全绕过了 DOM 事件分发。真实用户点击必定先产生 `pointerdown`，而正是 `pointerdown` 会把 `contextMenu` 置为 `null` 导致后续 `click` 误判为从关闭到打开！测试 9 在真机环境中根本无法复现其预期的行为。

#### 4.4 测试 10：刻意截断的手势假绿（Incomplete Gesture in Test 10）
定位至 `SidebarContextMenus.exclusive.test.tsx:284-323`：
```tsx
it('pointerdown 外点关（完整手势）', async () => {
  ...
  fireEvent.pointerDown(btn);
  fireEvent.pointerUp(btn);
  await waitFor(() => expect(result.current.contextMenu).toBeNull());
  // 刻意在此停止，没有派发 click(btn)！
});
```
- **假绿根因**：测试用例命名标榜为“完整手势”，但只派发了 `pointerDown` 和 `pointerUp`，**唯独缺失了点击事件的终点 `click`**。如果在 `pointerUp` 之后补齐 `fireEvent.click(btn)`，该测试就会当场暴露出菜单重新弹出的致命故障！测试用例的截断使得故障被掩盖。

---

## 四、缺陷清单与客观定级

### 【Critical 致命阻断】
- **DEF-01：再次点击会话 More 按钮无法关闭菜单（点击反弹重开）**
  - **对应位置**：[`SessionContextMenu.tsx:41-46`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx#L41-L46)
  - **触发场景**：用户左键点击 `···` 展开菜单后，再次点击 `···` 试图收起菜单。
  - **复现机制**：因 `useLayerRegistration` 缺少 `anchorRef: contextMenuTriggerRef`，`pointerdown` 判定为外部点击将菜单关闭，且记录快照中 `anchor` 为 `null`；紧随其后的 `click` 事件触发时 `contextMenu` 已为 `null`，且反弹抑制检查因缺少 `anchor` 失效，导致菜单立刻重新打开。

### 【Major 架构/功能缺陷】
- **DEF-02：`useKeyboardNav` 分隔符下标错位致使 DOM 键盘焦点漂移与丢失**
  - **对应位置**：[`SmartPanel/hooks/useKeyboardNav.ts:50-59`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/hooks/useKeyboardNav.ts#L50-L59)
  - **触发场景**：键盘用户使用上下方向键浏览菜单项。
  - **复现机制**：菜单项数组包含 3 个 `type: 'divider'`，而 DOM 查询器仅抓取 `[role="menuitem"]`。越过第一个分割线后，`itemElements[focusedIndex]` 取得的是后一个菜单项，导致 DOM 焦点与视觉焦点错位；到达底部时索引越界（10、12），DOM 焦点直接丢失。
- **DEF-03：单元测试套件存在假绿且缺失 Plan 05 防自杀核心回归断言**
  - **对应位置**：[`SidebarContextMenus.exclusive.test.tsx:187-323`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.exclusive.test.tsx#L187-L323)
  - **表现**：测试 7 手工硬编码 Mock `anchorRef`，测试 10 截断未测试完整 `click`，测试 9 绕过真实 DOM 事件链；Plan 05 §V.1 规划的 `SessionContextMenu 首次挂载时不应发生内部互斥自杀` 测试未合入。
- **DEF-04：`@/components/ui/index.ts` 依然导出 `SmartExpandablePanel as SmartPanel`**
  - **对应位置**：[`apps/crish-desktop/src/components/ui/index.ts:30`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/index.ts#L30)
  - **隐患**：全局桶导出污染，后续重构时 IDE 极易再次自动补全错误的导入路径，埋下二次自杀式驱逐地雷。

### 【Minor 边界/体验隐患】
- **DEF-05：Tab 键未拦截导致焦点从浮层穿透逃逸**
  - **对应位置**：[`SmartPanel/hooks/useKeyboardNav.ts:61-142`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/hooks/useKeyboardNav.ts#L61-L142)
  - **表现**：菜单打开时按下 Tab 键，光标逃逸至背景工作区，浮层保持悬浮孤立。
- **DEF-06：右键打开菜单按 Esc 键退栈时焦点还原目标不可聚焦**
  - **对应位置**：[`SessionContextMenu.tsx:44`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx#L44)
  - **表现**：右键点击会话行打开菜单时，`contextMenuTriggerRef.current` 为非可聚焦的 `div` 节点，按 Esc 退出后焦点丢失回落至 `body`。

---

## 五、精准修复方案与源码落地指引

针对上述审计指出的问题，给出确凿的落地代码修复方案：

### 1. 修复 DEF-01：恢复 `SessionContextMenu.tsx` 中的 `anchorRef` 登记
定位至 [`apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx:37-47`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx#L37-L47)，将 `anchorRef` 补回：

```tsx
  useLayerRegistration(
    {
      id: SESSION_CONTEXT_MENU_LAYER_ID,
      type: 'context-menu',
      dismissible: true,
      onDismiss: () => onCloseContextMenu?.(),
      elementRef: menuRef,
      anchorRef: contextMenuTriggerRef, // 必须恢复！赋予 LayerStack 识别触发器的能力
      restoreFocusTarget: contextMenuTriggerRef?.current ?? undefined,
    },
    isOpen
  );
```

### 2. 修复 DEF-02：修复 `useKeyboardNav.ts` 中的 DOM 元素映射计算
定位至 [`apps/crish-desktop/src/components/ui/SmartPanel/hooks/useKeyboardNav.ts:50-59`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/hooks/useKeyboardNav.ts#L50-L59)，重构 DOM 焦点同步逻辑，按 item 的真实 ID 查找，或过滤出可聚焦 item 的对应下标：

```ts
  // Sync DOM focus and scroll into view (精确基于 item ID 匹配，根除 divider 错位)
  useEffect(() => {
    if (focusedIndex >= 0 && contentRef.current) {
      const curItem = items[focusedIndex];
      if (!curItem || curItem.type === 'divider' || curItem.type === 'group') return;

      const target = contentRef.current.querySelector<HTMLElement>(
        `[data-action="${curItem['data-action'] || curItem.id}"]`
      );
      if (target) {
        target.focus();
        target.scrollIntoView?.({ block: 'nearest' });
      }
    }
  }, [focusedIndex, items, contentRef]);
```

### 3. 修复 DEF-03：补齐防自杀断言与全手势测试
在 [`SidebarContextMenus.exclusive.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.exclusive.test.tsx) 中补齐两项刚性测试：

```tsx
it('SessionContextMenu 首次挂载时不应发生内部互斥自杀（onClose 不被调用）', async () => {
  const menuRef = React.createRef<HTMLDivElement>();
  const triggerRef = React.createRef<HTMLButtonElement>();
  const onClose = vi.fn();

  render(
    <>
      <button ref={triggerRef} type="button" data-testid="session-more-button">更多</button>
      <SessionContextMenu
        contextMenu={{ x: 100, y: 200, sessionId: 'test-1', isMoreButton: true }}
        menuRef={menuRef}
        isPinned={false}
        onSessionAction={vi.fn()}
        onCloseContextMenu={onClose}
        contextMenuTriggerRef={triggerRef}
      />
    </>
  );

  expect(await screen.findByTestId('session-context-menu')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();

  const layers = layerStackService.getLayers();
  expect(layers.filter((l) => l.id === SESSION_CONTEXT_MENU_LAYER_ID)).toHaveLength(1);
  expect(layers.filter((l) => l.type === 'dropdown-menu')).toHaveLength(0);
});

it('用户再次点击同一个 More 按钮时应平滑收起菜单（完整 pointerdown->click 手势）', async () => {
  const { result } = renderHook(() =>
    useSidebarContextMenu({ setSortDropdownOpen: vi.fn() })
  );
  const btn = document.createElement('button');
  btn.dataset.testid = 'session-more-button';
  document.body.append(btn);

  // 1. 首次点击打开
  act(() => {
    result.current.handleContextMenu(fakeMouseEvent(btn, { button: 0 }), 'sess-toggle');
  });
  expect(result.current.contextMenu).not.toBeNull();

  const { rerender } = render(
    <SessionContextMenu
      contextMenu={result.current.contextMenu!}
      menuRef={result.current.menuRef}
      isPinned={false}
      onSessionAction={vi.fn()}
      onCloseContextMenu={() => result.current.setContextMenu(null)}
      contextMenuTriggerRef={result.current.contextMenuTriggerRef}
    />
  );

  // 2. 模拟真实用户的完整再次点击 (pointerdown -> pointerup -> click)
  fireEvent.pointerDown(btn);
  fireEvent.pointerUp(btn);
  act(() => {
    result.current.handleContextMenu(fakeMouseEvent(btn, { button: 0 }), 'sess-toggle');
  });

  // 核心断言：菜单必须彻底收起为 null，绝不能反弹重开！
  await waitFor(() => expect(result.current.contextMenu).toBeNull());
  rerender(<></>);
  btn.remove();
});
```

### 4. 修复 DEF-04：清理 `@/components/ui/SmartExpandablePanel` 别名
在 `apps/crish-desktop/src/components/ui/SmartExpandablePanel/index.ts` 中移除 `SmartExpandablePanel as SmartPanel` 这一易混淆别名，或在统一桶 `ui/index.ts` 中将原生纯面板以 `SmartPanel` 正名显式导出，斩断隐式别名陷阱。

---

## 六、总结与后续行动建议

1. **核心价值确认**：将 `SessionContextMenu` 切换为原生纯 `SmartPanel`，方向完全正确，成功清除了导致会话菜单无法弹出的双层注册互斥自杀根本原因。
2. **严防“治一经损一经”**：在清理过程中不经意剔除的 `anchorRef`，导致了排他层调度机制的核心门闩失效，引发再次点击 More 按钮无法关闭菜单的高频交互倒退。
3. **贯彻立体验证**：单元测试绝不能通过手工 Mock 关键上下文或截断真实手势来骗取全绿。必须按照详案要求合入挂载防自杀与全手势再次点击收起两项刚性测试。
