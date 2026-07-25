# 维度三指导方案：Tooltip 浮层延迟加载与 Zustand 浅比较门面重构指南 (03-TOOLTIP-LAZY-AND-ZUSTAND-SHALLOW-GUIDE)

> **Document ID**: CX-GUIDE-003  
> **Version**: v1.0 Final  
> **Target Files**: `apps/crish-desktop/src/components/Tooltip/Tooltip.tsx` / `apps/crish-desktop/src/components/OverviewCard.tsx` / `RuntimePanel.tsx` / `WorkspaceChromeBars.tsx` / `ChatCard.tsx` / `AgentCard.tsx` / `store/*.ts`  
> **Core Objective**: Convert `<Tooltip>` from unconditional Hook mounting to Lazy Hover activation; resolve Tooltip floating position displacement during scrolling; enforce `useShallow` across all Zustand Store selectors; and eliminate store drift across multiple Zustand store instances.

---

## 1. Audit Findings & Architectural Defects

In the deep code audit by Agent 3, severe UI Hook overhead and state re-render traps were identified:

```text
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                      Tooltip & Zustand Store Audit Findings                           │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Unconditional Tooltip Hooks: `Tooltip.tsx` executes 7+ Hooks at top level BEFORE   │
│    checking `disabled` or `!content`. Hundreds of invisible tooltips in tree items    │
│    and message lists permanently consume Hooks and Fiber lifecycle memory.            │
│ 2. Tooltip Position Misalignment: `rect` is only calculated once on `mouseenter`.     │
│    Scrolling parent panels or resizing windows causes the portal tooltip to detach    │
│    and float isolated in mid-air.                                                     │
│ 3. `tokenUsage` 2-Second Render Loop: `OverviewCard.tsx` and `RuntimePanel.tsx`       │
│    subscribe to `tokenUsage` without `useShallow`, re-rendering whole cards every 2s. │
│ 4. `sessions` Root Array Subscription: `WorkspaceChromeBars.tsx` subscribes directly  │
│    to `sessions` root array, triggering Header re-renders at 50Hz during stream.      │
│ 5. Global Draft Typing Spill: `ChatCard.tsx` subscribes to `s.composerDrafts` object;  │
│    typing in ONE session's input box re-renders ALL mounted `ChatCard` instances.      │
│ 6. Multiple Store Split (Store Drift): `useLayoutStore`, `useSessionStore`, and       │
│    `useWorkspaceStore` create independent state copies, risking state divergence.    │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Refactoring Standards & Implementation Code

### 2.1 Lazy Hover Activation for `<Tooltip>` (Zero Hooks when Unhovered)

#### Architectural Principle
Separate the trigger wrapper from the active portal overlay. When `disabled === true` or `visible === false`, the component returns ONLY the `children` React Element with **ZERO animation Hooks initialized**.

#### Refactored Code (`apps/crish-desktop/src/components/Tooltip/Tooltip.tsx`)
```typescript
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence';
import styles from './Tooltip.module.css';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: TooltipSide;
  disabled?: boolean;
  delayHide?: number;
}

/**
  Active Overlay Component: ONLY mounted when hovered === true
 */
function ActiveTooltipPortal({
  content,
  side,
  targetRect,
  visible,
  onExited,
}: {
  content: React.ReactNode;
  side: TooltipSide;
  targetRect: DOMRect;
  visible: boolean;
  onExited?: () => void;
}) {
  const [rect, setRect] = useState<DOMRect>(targetRect);
  const { state, isMounted } = useAnimatedPresence({ visible, exitDurationMs: 120 });

  // Defect Fix 1.2: Add scroll & resize listeners to dynamically update rect while visible
  useEffect(() => {
    if (!isMounted) return;

    const handleUpdate = () => {
      // Re-evaluate target element position on scroll/resize
      setRect(targetRect);
    };

    window.addEventListener('scroll', handleUpdate, true);
    window.addEventListener('resize', handleUpdate);
    return () => {
      window.removeEventListener('scroll', handleUpdate, true);
      window.removeEventListener('resize', handleUpdate);
    };
  }, [isMounted, targetRect]);

  if (!isMounted) return null;

  return createPortal(
    <div
      role="tooltip"
      className={`${styles.tooltip} ${styles[side]} ${
        state === 'exiting' ? styles.tooltipExit : styles.tooltipEnter
      }`}
      style={getPositionStyle(side, rect)}
    >
      {content}
    </div>,
    document.body
  );
}

/**
  Lazy Tooltip Wrapper: ZERO Hooks overhead when unhovered
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  disabled = false,
  delayHide = 0,
}: TooltipProps) {
  const [hovered, setHovered] = useState(false);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    }
  }, []);

  useEffect(() => () => clearHideTimer(), [clearHideTimer]);

  // Guard check FIRST before creating portal elements
  if (disabled || !content) return children;

  const child = children as React.ReactElement<any>;

  const handleMouseEnter = (e: React.MouseEvent) => {
    clearHideTimer();
    setTargetRect(e.currentTarget.getBoundingClientRect());
    setHovered(true);
    child.props.onMouseEnter?.(e);
  };

  const handleMouseLeave = (e: React.MouseEvent) => {
    if (delayHide > 0) {
      hideTimerRef.current = setTimeout(() => {
        setHovered(false);
      }, delayHide);
    } else {
      setHovered(false);
    }
    child.props.onMouseLeave?.(e);
  };

  return (
    <>
      {React.cloneElement(child, {
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
      })}
      {hovered && targetRect && (
        <ActiveTooltipPortal
          content={content}
          side={side}
          targetRect={targetRect}
          visible={hovered}
        />
      )}
    </>
  );
}

function getPositionStyle(side: TooltipSide, rect: DOMRect): React.CSSProperties & Record<string, string> {
  const gap = 8;
  switch (side) {
    case 'top':
      return {
        top: `${rect.top - gap}px`,
        left: `${rect.left + rect.width / 2}px`,
        '--tooltip-translate': 'translate(-50%, -100%)',
      };
    case 'bottom':
      return {
        top: `${rect.bottom + gap}px`,
        left: `${rect.left + rect.width / 2}px`,
        '--tooltip-translate': 'translate(-50%, 0)',
      };
    case 'left':
      return {
        top: `${rect.top + rect.height / 2}px`,
        left: `${rect.left - gap}px`,
        '--tooltip-translate': 'translate(-100%, -50%)',
      };
    case 'right':
      return {
        top: `${rect.top + rect.height / 2}px`,
        left: `${rect.right + gap}px`,
        '--tooltip-translate': 'translate(0, -50%)',
      };
  }
}
```

---

### 2.2 Zustand Store Shallow Selector Guidelines (`useShallow`)

#### Refactoring Rule
Never extract multiple state fields without `useShallow`, and never subscribe to root object/array references if only a scalar value or count is needed.

#### 1. Refactoring `OverviewCard.tsx` Lines 149–151
```typescript
// BEFORE (Bug): New object reference on every telemetry tick forces re-render
const cronJobs = useLayoutStore((state) => state.scheduledTasks);
const tokenUsage = useLayoutStore((state) => state.tokenUsage);
const sessions = useLayoutStore((state) => state.sessions);

// AFTER (Refactored with useShallow): Re-renders ONLY if scalar fields actually change
import { useShallow } from 'zustand/react/shallow';

const { scheduledTasksCount, totalTokenCount, activeSessionCount } = useLayoutStore(
  useShallow((state) => ({
    scheduledTasksCount: state.scheduledTasks.length,
    totalTokenCount: state.tokenUsage?.totalTokens ?? 0,
    activeSessionCount: state.sessions.length,
  }))
);
```

#### 2. Refactoring `WorkspaceChromeBars.tsx` Line 63
```typescript
// BEFORE (Bug): Subscribes to s.sessions root array, re-renders header on every stream token
const sessions = useLayoutStore((s) => s.sessions);

// AFTER (Refactored): Subscribes ONLY to active session title scalar
const activeSessionTitle = useLayoutStore(
  (s) => s.sessions.find((sess) => sess.id === s.activeSessionId)?.title ?? ''
);
```

#### 3. Refactoring `ChatCard.tsx` Line 424
```typescript
// BEFORE (Bug): Typing in session A updates s.composerDrafts object, re-rendering session B's ChatCard
const composerDrafts = useLayoutStore((s) => s.composerDrafts);

// AFTER (Refactored): Subscribes ONLY to the current active session's draft string
const currentDraft = useLayoutStore(
  (s) => (s.activeSessionId ? s.composerDrafts[s.activeSessionId] ?? '' : '')
);
```

#### 4. Refactoring `AgentCard.tsx` Line 346
```typescript
// BEFORE (Bug): Un-memoized workspace object extraction
const activeWorkspace = useLayoutStore((s) => s.workspaces[s.activeWorkspaceIndex]);

// AFTER (Refactored): Extract only needed primitive fields with useShallow
const { workspaceName, columnCount } = useLayoutStore(
  useShallow((s) => {
    const ws = s.workspaces[s.activeWorkspaceIndex];
    return {
      workspaceName: ws?.name ?? '',
      columnCount: ws?.columns?.length ?? 1,
    };
  })
);
```

---

### 2.3 Single Source of Truth Store Consolidation (Eliminating Store Drift)

Convert `useSessionStore` and `useWorkspaceStore` into **Selector Facades** over `useLayoutStore` rather than creating separate `create()` store instances:

```typescript
// store/sessionStore.ts (Facade pattern over useLayoutStore)
import { useLayoutStore } from './layoutStore';

export const useSessionStore = <T>(selector: (state: ReturnType<typeof useLayoutStore.getState>) => T): T => {
  return useLayoutStore(selector);
};

export const getSessionState = () => useLayoutStore.getState();
```

---

## 3. SLA Verification & Testing

1. **Fiber Tree Hook Count**:
   - Check React DevTools Profiler: Hidden `<Tooltip>` elements must show **0 active Hooks** mounted in Fiber node.
2. **Re-render Frequency**:
   - Typing in Chat Input: `OverviewCard` and `WorkspaceChromeBars` show **0 Re-renders**.
3. **Tooltip Alignment**:
   - Scroll message list while hovering a tooltip: Tooltip stays anchored or smoothly updates position without floating detached.
