# Agent-03: 窗口 Resize/Move 冻结机制重构方案

> 方案日期：2026-07-22
> 项目路径：`C:\Software\conex`
> 前置分析：`analysis/agents/agent-03-analysis.md`
> 目标版本：R3-Window-Bridge

---

## 目录

1. [设计目标](#1-设计目标)
2. [统一冻结服务的架构](#2-统一冻结服务的架构)
3. [App.tsx 修改](#3-apptsx-修改)
4. [useWindowControls.ts 重构](#4-usewindowcontrolsts-重构)
5. [useResizeFreeze.ts 重构](#5-useresizefreezets-重构)
6. [useSuspendedResizeObserver.ts 增强](#6-usesuspendedresizeobserverts-增强)
7. [shell-dragdrop.css 增强](#7-shell-dragdropcss-增强)
8. [布局容器 CSS contain 注入](#8-布局容器-css-contain-注入)
9. [测试策略](#9-测试策略)
10. [验证清单](#10-验证清单)
11. [实施路线图](#11-实施路线图)

---

## 1. 设计目标

### 1.1 核心目标

- **统一冻结信号源**：所有窗口操作（resize、move、maximize、restore）都汇入 `layoutAnimationStore` 的 `beginLayoutInteraction` / `endLayoutInteraction` 流程
- **消除信号遗漏**：窗口 resize、窗口 move、窗口 maximize/restore 全部覆盖
- **CSS 性能优化**：冻结期间利用 CSS `contain` 减少浏览器布局/绘制计算范围
- **最小侵入性**：保持 API 向后兼容，不破坏现有组件

### 1.2 非目标

- 不重构 `layoutAnimationStore` 的整体设计（其现有设计合理）
- 不引入新的第三方依赖
- 不更改现有的 `Workspace.tsx` 或 `Sidebar.tsx` 的 sash drag 冻结逻辑（这些已正确实现）
- 不重构虚拟滚动实现

### 1.3 设计原则

1. **单一真实源（Single Source of Truth）**：`layoutAnimationStore.isLayoutFrozen` 是唯一的冻结状态来源
2. **统一入口**：系统级窗口操作通过一个统一的服务（`WindowResizeBridge`）汇入 store
3. **幂等性**：重复调用 `beginLayoutInteraction` 不会导致状态异常
4. **防御性编程**：在 Tauri 环境不可用时优雅降级到 Web resize 事件
5. **最小影响**：不改变现有组件的内部逻辑，只补充丢失的冻结信号

---

## 2. 统一冻结服务的架构

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        WindowResizeBridge                            │
│                    (apps/crish-desktop/src/services/                 │
│                     WindowResizeBridge.ts)                           │
│                                                                      │
│  ┌──────────────────┐   ┌──────────────────┐   ┌─────────────────┐ │
│  │  Tauri onResize  │   │  Tauri onMoved   │   │  window.resize  │ │
│  │  (原生尺寸变化)   │   │  (原生窗口移动)   │   │  (Web fallback) │ │
│  └────────┬─────────┘   └────────┬─────────┘   └────────┬────────┘ │
│           │                      │                       │          │
│           └──────────┬───────────┘───────────────────────┘          │
│                      │                                              │
│                      ▼                                              │
│           ┌──────────────────────┐                                  │
│           │  beginLayoutInteraction('workspace-resizing')           │
│           │  + 延迟解冻定时器管理                                     │
│           └──────────────────────┘                                  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │   layoutAnimationStore          │
              │   - isLayoutFrozen: true         │
              │   - activeAnimations: Set         │
              │   - syncBodyFromActive()          │
              │   - flushCatchupTasks()           │
              └───────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                  ▼
     ┌────────────┐   ┌──────────────┐   ┌──────────────┐
     │ CSS 冻结   │   │ useResize    │   │ Suspended    │
     │ is-layout  │   │ Freeze       │   │ ResizeObsvr  │
     │ -frozen *  │   │ (debounce)   │   │ (catch-up)   │
     │ transitions│   └──────────────┘   └──────────────┘
     │ animation  │
     └────────────┘
```

### 2.2 WindowResizeBridge 服务设计

```typescript
// apps/crish-desktop/src/services/WindowResizeBridge.ts

/**
 * 窗口尺寸变化/窗口移动冻结桥。
 *
 * 统一管理来自 Tauri 原生事件和 Web resize 事件的冻结信号，
 * 汇入 layoutAnimationStore 的 beginInteraction/endInteraction 流程。
 *
 * 设计要点：
 * - 单例模式，在 App.tsx 初始化
 * - 同时绑定 Tauri onResize、onMoved 和 Web window.resize
 * - 使用 200ms 解冻 debounce，避免频繁冻结/解冻抖动
 * - 双重 rAF 解冻保护（参考 Workspace.tsx sash drag 的做法）
 * - try-catch 防御 Tauri 不可用
 */
export class WindowResizeBridge {
  private unlisteners: Array<() => void> = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private frozenType: LayoutAnimationType = 'workspace-resizing';
  private isDestroyed = false;

  /**
   * 启动桥接。
   * 应在 App 组件的 useEffect 中调用。
   */
  async start(): Promise<void> {
    if (this.isDestroyed) return;
    
    // 1. 绑定 Tauri 原生事件（如果可用）
    await this.bindTauriEvents();
    
    // 2. 绑定 Web window.resize fallback
    this.bindWebResizeFallback();
  }

  /**
   * 销毁桥接，清理所有监听和定时器。
   */
  stop(): void {
    this.isDestroyed = true;
    this.unlisteners.forEach(fn => fn());
    this.unlisteners = [];
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ── 私有方法 ──

  private async bindTauriEvents(): Promise<void> {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();

      // Tauri onResize：窗口尺寸变化
      const unsubResize = await win.onResize(() => {
        this.handleWindowChange();
      });
      this.unlisteners.push(unsubResize);

      // Tauri onMoved：窗口位置移动
      const unsubMoved = await win.onMoved(() => {
        this.handleWindowChange();
      });
      this.unlisteners.push(unsubMoved);

      // Tauri onResize 可能不覆盖窗口最大化/还原
      // 补充监听 Tauri 的系统级别事件
      try {
        const unsubResized = await win.listen('tauri://resize', () => {
          this.handleWindowChange();
        });
        this.unlisteners.push(unsubResized);
      } catch {
        // tauri:// 事件可能不存在于所有版本
      }
    } catch {
      // Tauri 不可用（浏览器环境），Web resize fallback 会覆盖
      console.info('[WindowResizeBridge] Tauri events unavailable, using Web fallback');
    }
  }

  private bindWebResizeFallback(): void {
    const handler = () => this.handleWindowChange();
    window.addEventListener('resize', handler);
    this.unlisteners.push(() => window.removeEventListener('resize', handler));
  }

  /**
   * 统一窗口变化处理：
   * - 立即冻结（如果尚未冻结）
   * - 重置解冻计时器
   */
  private handleWindowChange(): void {
    if (this.isDestroyed) return;

    const store = useLayoutAnimationStore.getState();
    
    // 如果尚未冻结，立即冻结
    if (!store.isLayoutFrozen) {
      beginLayoutInteraction(this.frozenType);
    }

    // 重置解冻计时器：每次窗口变化都重新计算
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      if (this.isDestroyed) return;
      this.scheduleThaw();
    }, 200); // 200ms 静默期后解冻
  }

  /**
   * 双重 rAF 解冻（参考 Workspace.tsx L437-443）。
   * 确保 React 完成 re-render + 浏览器完成 paint 后才解冻。
   */
  private scheduleThaw(): void {
    requestAnimationFrame(() => {
      if (this.isDestroyed) return;
      requestAnimationFrame(() => {
        if (this.isDestroyed) return;
        // 解冻前再次确认不处于窗口变化中
        endLayoutInteraction(this.frozenType);
        this.debounceTimer = null;
      });
    });
  }
}
```

### 2.3 与现有架构的兼容性

现有的 `window.resize` 监听在 App.tsx 中只管理 `window-resizing` class。新的 `WindowResizeBridge` 将与这个 class 管理**共存但不依赖**：

- `WindowResizeBridge` 负责：`beginLayoutInteraction` + 延迟解冻
- 旧的 App.tsx handler 负责：`window-resizing` class（兼容旧 CSS）
- 两个机制独立运作，通过 `is-layout-frozen` 和 `window-resizing` 分别影响不同的 CSS 规则

### 2.4 延迟冻结窗口

窗口 resize 和 move 期间，用户可能在短时间内连续操作。如果每次 resize 事件都立即冻结并 200ms 后解冻，会导致频繁的冻结切换。设计如下策略：

```
时间线：
T0:     窗口 resize 开始 → 冻结
T0+50ms: 再次 resize → 重置计时器
T0+100ms: 再次 resize → 重置计时器
T0+300ms: 无 resize → 200ms 计时器到期 → 双重 rAF → T0+316ms 解冻
```

这意味着：
- 密集 resize 期间：冻结状态持续保持，不会反复切换
- resize 停止后：约 316ms（200ms + 2 frames）后解冻
- 在 200ms 静默期内如果有新的 resize：计时器重置，解冻延后

---

## 3. App.tsx 修改

### 3.1 当前问题梳理

当前 App.tsx L463-480 的 useEffect 存在以下问题：

1. ❌ 未调用 `beginLayoutInteraction('workspace-resizing')`
2. ❌ 未监听 Tauri `onMoved` 事件
3. ❌ 100ms debounce 无双重 rAF 保护
4. ⚠️ 与 useWindowControls.ts 的重复代码

### 3.2 修改方案：集成 WindowResizeBridge

在 App.tsx 中添加 `WindowResizeBridge` 实例化和生命周期管理。

```typescript
// App.tsx — 新增 import 和 useEffect

import { WindowResizeBridge } from './services/WindowResizeBridge';

function App() {
  // ... 现有代码 ...

  // ── 新增：WindowResizeBridge 生命周期管理 ──
  useEffect(() => {
    const bridge = new WindowResizeBridge();
    bridge.start().catch((err) => {
      console.warn('[App] WindowResizeBridge start failed:', err);
    });
    return () => {
      bridge.stop();
    };
  }, []);
```

### 3.3 保留现有 window-resizing class 管理

App.tsx 原有的 L463-480 handler 保留，因为 `window-resizing` class 仍然用于兼容旧 CSS（如 `shell-dragdrop.css` 中的 `.window-resizing .main-layout`）：

```typescript
// App.tsx L463-480 — 保留（无修改）
useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const handleResize = () => {
      document.body.classList.add('window-resizing');

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        document.body.classList.remove('window-resizing');
      }, 100);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
}, []);
```

### 3.4 修改建议：增强 window-resizing 管理

可选地，将 100ms debounce 调整为与 WindowResizeBridge 同步的解冻策略：

```typescript
// App.tsx — 可选增强版本
useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const handleResize = () => {
      document.body.classList.add('window-resizing');

      if (debounceTimer) clearTimeout(debounceTimer);
      // 使用双重 rAF 保护，确保解冻前 React 完成布局
      debounceTimer = setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            document.body.classList.remove('window-resizing');
          });
        });
      }, 200);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
}, []);
```

### 3.5 try-catch 兜底

WindowResizeBridge 内部已有 try-catch 防御。在 App.tsx 层级的兜底：

```typescript
useEffect(() => {
    let bridge: WindowResizeBridge | null = null;
    
    try {
      bridge = new WindowResizeBridge();
      bridge.start();
    } catch (err) {
      // 极罕见的边界情况：import 失败或构造异常
      console.error('[App] Failed to initialize WindowResizeBridge', err);
      // 回退：至少保证基本的 Web resize 冻结
      const handler = () => {
        document.body.classList.add('window-resizing');
        setTimeout(() => document.body.classList.remove('window-resizing'), 200);
      };
      window.addEventListener('resize', handler);
      return () => window.removeEventListener('resize', handler);
    }

    return () => {
      bridge?.stop();
    };
}, []);
```

---

## 4. useWindowControls.ts 重构

### 4.1 问题

`useWindowControls.ts` 是死代码（从未被导入），但包含：
1. 与 App.tsx 重复的 `window.resize` 监听
2. 与 App.tsx 重复的 `winCtl` 函数

### 4.2 重构方案：删除

**方案：直接删除 `useWindowControls.ts` 文件。**

理由：
- 无任何组件导入此 hook
- 功能已被 App.tsx 的 inline `winCtl` 函数覆盖
- 保留此文件构成"未来可能被错误导入"的风险
- Git 历史中可恢复

```bash
git rm apps/crish-desktop/src/hooks/useWindowControls.ts
```

### 4.3 如果未来需要 window controls hook

如果未来确实需要一个可复用的窗口控制 hook，应该重新设计为：

```typescript
// apps/crish-desktop/src/hooks/useWindowControls.ts — 全新设计
import { useCallback } from 'react';
import { beginLayoutInteraction, endLayoutInteraction } from '../store/layoutAnimationStore';

/**
 * 窗口控制 hook。
 * 与 WindowResizeBridge 配合，所有窗口操作都触发冻结。
 */
export function useWindowControls() {
  const winCtl = useCallback(async (action: 'minimize' | 'toggleMaximize' | 'close') => {
    try {
      const mod = await import('@tauri-apps/api/window');
      const win = mod.getCurrentWindow();
      
      if (action === 'minimize') {
        await win.minimize();
        return;
      }
      
      // 最大化/还原/关闭操作可能改变窗口尺寸
      // 提前冻结布局，防止动画期间的回调触发
      beginLayoutInteraction('workspace-resizing');
      
      if (action === 'toggleMaximize') {
        if (await win.isMaximized()) await win.unmaximize();
        else await win.maximize();
      } else {
        await win.close();
      }
      
      // 最大化/还原动画完成后解冻
      // 注意：close 可能不会执行到这里
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            endLayoutInteraction('workspace-resizing');
          });
        });
      }, 300);
    } catch {
      /* window controls unavailable outside Tauri */
    }
  }, []);

  return { winCtl };
}
```

但这个重构在当前阶段**不推荐**，因为现有 App.tsx 的 inline `winCtl` 功能完整，不应该为了复用而增加复杂度。

---

## 5. useResizeFreeze.ts 重构

### 5.1 当前状态评估

当前实现已经是订阅 store 的正确模式（不再使用独立的 MutationObserver）：

```typescript
export function useResizeFreeze(debounceMs = 150): { isResizing: boolean } {
  const isLayoutFrozen = useLayoutAnimationStore((s) => s.isLayoutFrozen);
  const [isResizing, setIsResizing] = useState(isLayoutFrozen);

  useEffect(() => {
    if (isLayoutFrozen) {
      setIsResizing(true);
      return;
    }
    const timer = window.setTimeout(() => {
      if (!useLayoutAnimationStore.getState().isLayoutFrozen) {
        setIsResizing(false);
      }
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [isLayoutFrozen, debounceMs]);

  return { isResizing };
}
```

### 5.2 增强方案

**目标：** 在保持 API 兼容的前提下，增强稳定性。

```typescript
// useResizeFreeze.ts — 重构版本
import { useEffect, useState, useRef } from 'react';
import { useLayoutAnimationStore } from '../store/layoutAnimationStore';

/**
 * 订阅 layoutAnimationStore.isLayoutFrozen，供高昂计算暂缓执行。
 *
 * 增强说明：
 * - isResizing 在解冻后保持 debounceMs 毫秒的延迟，防止首帧抖动
 * - 使用 ref 读取最新的 debounceMs，避免闭包陷阱
 * - 在 WindowResizeBridge 接管后，isLayoutFrozen 已经包含窗口 resize/move 信号
 * - 不再需要额外的窗口事件监听
 */
export function useResizeFreeze(debounceMs = 150): { isResizing: boolean } {
  const isLayoutFrozen = useLayoutAnimationStore((s) => s.isLayoutFrozen);
  const [isResizing, setIsResizing] = useState(isLayoutFrozen);
  const debounceMsRef = useRef(debounceMs);

  // 同步 ref，避免 effect 闭包中的 stale value
  useEffect(() => {
    debounceMsRef.current = debounceMs;
  }, [debounceMs]);

  useEffect(() => {
    if (isLayoutFrozen) {
      setIsResizing(true);
      return;
    }

    const timer = window.setTimeout(() => {
      // 解冻 debounce 期间若再次冻结，以最新 store 为准
      if (!useLayoutAnimationStore.getState().isLayoutFrozen) {
        setIsResizing(false);
      }
    }, debounceMsRef.current);

    return () => window.clearTimeout(timer);
  }, [isLayoutFrozen]); // 移除 debounceMs 依赖，通过 ref 读取

  return { isResizing };
}
```

### 5.3 移除不必要的双重守卫

当前 ChatMessageList.tsx 中的双重守卫：
```typescript
if (isResizing || useLayoutAnimationStore.getState().isLayoutFrozen || ...)
```

由于 `isResizing` 已经订阅了 `isLayoutFrozen`，当 `isLayoutFrozen` 为 true 时 `isResizing` 也为 true，所以 `isResizing` 已经足够。但双重守卫有助于防御 debounce 窗口期内 `isResizing` 尚未更新而 `isLayoutFrozen` 已经为 false 的情况。

**建议：保留双重守卫**，因为：
- 它没有性能开销（短路求值）
- 防御了 debounce 窗口期的边界情况
- 即使 `useResizeFreeze` 的实现有 bug，`isLayoutFrozen` 直接检查提供了第二层保护

### 5.4 使用场景扩展

当前只有 `ChatMessageList` 使用 `useResizeFreeze`。建议以下组件也使用：

1. **FilesCard** (FilesCard.tsx L92)：目前直接检查 `isLayoutFrozen`，可以改用 `useResizeFreeze`
2. **VirtualList** (VirtualList.tsx L54)：目前无冻结感知，可以添加
3. **useVirtualScroll** (useVirtualScroll.ts L76)：目前无冻结感知，可以添加
4. **useAutoGrowTextarea** (useAutoGrowTextarea.ts L140)：目前无冻结感知，可以添加

但这些扩展属于 P2 优先级，不影响窗口 resize/move 冻结的核心修复。

---

## 6. useSuspendedResizeObserver.ts 增强

### 6.1 当前状态

`useSuspendedResizeObserver` 是一个精心设计的 hook，提供了：
1. 冻结期间挂起 ResizeObserver 回调
2. Catch-up 任务注册（解冻时批量执行）
3. rAF 节流（非冻结时）

但目前只有 TerminalCard 使用它。在 WindowResizeBridge 修复后，`isLayoutFrozen` 在窗口 resize/move 期间为 true，所有使用 `useSuspendedResizeObserver` 的组件将自动受益。

### 6.2 增强方案

**目标：** 将 `useSuspendedResizeObserver` 推广到更多使用点，并增强其稳定性。

```typescript
// useSuspendedResizeObserver.ts — 增强版本
import { useEffect, useRef } from 'react';
import { useLayoutAnimationStore } from '../store/layoutAnimationStore';

export interface UseSuspendedResizeObserverOptions {
  /** 任务唯一标识（用于 Catch-up 队列去重） */
  taskKey: string;
  /** Resize 触发时的回调 */
  onResize: (entry?: ResizeObserverEntry) => void;
  /** 关联的 DOM 节点引用 */
  targetRef: React.RefObject<HTMLElement | null>;
  /** 是否禁用此 observer */
  disabled?: boolean;
  /** 是否启用 catch-up（默认 true）。某些场景（如文本测算）应禁用 catch-up
   *  因为 catch-up 会丢失中间状态 */
  enableCatchup?: boolean;
}

/**
 * 动画感知型 ResizeObserver：
 * 当全局 isLayoutFrozen === true 时，
 * 彻底挂起中途高频 resize 回调，将终态测量注册至 Catch-up 队列，动画结束后单次刷新。
 *
 * 增强说明：
 * - 新增 enableCatchup 选项，允许调用者选择是否使用 catch-up
 * - 在挂起期间仍捕获最新 entry，但仅注册一次 catch-up 任务（覆盖，节省内存）
 * - 支持 SuspendedResizeObserverOptions.error 回调
 */
export function useSuspendedResizeObserver({
  taskKey,
  onResize,
  targetRef,
  disabled = false,
  enableCatchup = true,
}: UseSuspendedResizeObserverOptions): void {
  const registerCatchupTask = useLayoutAnimationStore((s) => s.registerCatchupTask);
  const unregisterCatchupTask = useLayoutAnimationStore((s) => s.unregisterCatchupTask);
  const latestOnResize = useRef(onResize);
  const latestEntryRef = useRef<ResizeObserverEntry | null>(null);

  useEffect(() => {
    latestOnResize.current = onResize;
  }, [onResize]);

  useEffect(() => {
    if (disabled) return;
    const el = targetRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    let rafId: number | null = null;

    const observer = new ResizeObserver((entries) => {
      const isFrozen = useLayoutAnimationStore.getState().isLayoutFrozen;

      if (isFrozen) {
        if (!enableCatchup) {
          // 禁用 catch-up：直接跳过
          return;
        }
        
        // 保存最新 entry，用于 catch-up
        latestEntryRef.current = entries[0];
        
        // 注册 catch-up 任务（覆盖同 key 的旧任务）
        registerCatchupTask(taskKey, () => {
          const entry = latestEntryRef.current;
          if (entry) {
            latestOnResize.current(entry);
            latestEntryRef.current = null;
          }
        });
      } else {
        // 非挂起阶段：使用 rAF 节流回调
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          latestOnResize.current(entries[0]);
        });
      }
    });

    observer.observe(el);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      unregisterCatchupTask(taskKey);
      latestEntryRef.current = null;
    };
  }, [targetRef, taskKey, disabled, registerCatchupTask, unregisterCatchupTask, enableCatchup]);
}
```

### 6.3 迁移策略

将以下 ResizeObserver 使用点迁移到 `useSuspendedResizeObserver`：

| 当前文件 | 当前方式 | 迁移优先级 | 理由 |
|---|---|---|---|
| ChatMessageList.tsx (L639) | 原生 RO + isLayoutFrozen 检查 | P1 | 已有冻结感知，接入 catch-up |
| FilesCard.tsx (L92) | 原生 RO + isLayoutFrozen 检查 | P1 | 已有冻结感知，接入 catch-up |
| VirtualList.tsx (L54) | 原生 RO，无冻结感知 | P2 | 通用组件，需要谨慎评估 |
| useVirtualScroll.ts (L76) | 原生 RO，无冻结感知 | P2 | ChatMessageList 内部使用 |
| useVirtualDiffScroll.ts (L12) | 原生 RO，无冻结感知 | P2 | 通用组件 |
| ChatToolCallBlock.tsx (L232) | 原生 RO，无冻结感知 | P2 | 局部组件 |
| SidebarSessionList.tsx (L268) | 原生 RO，无冻结感知 | P2 | 侧栏虚拟列表 |
| useAutoGrowTextarea.ts (L140) | 原生 RO，无冻结感知 | P3 | textarea 自增长 |
| useTextMeasure.ts (L127) | 原生 RO，无冻结感知 | P3 | 可能已废弃 |

### 6.4 Catch-up 任务的最佳实践

**适合使用 catch-up 的场景**（如 TerminalCard fit）：
- 回调执行昂贵（如 xterm.js fit()）
- 回调对中间状态不敏感（fit() 只需要最终尺寸）
- 解冻后执行一次即可

**不适合使用 catch-up 的场景**（如文本测算）：
- 需要实时响应每个尺寸变化
- catch-up 会丢失中间状态，导致测算不连续
- 使用 `enableCatchup = false` 或跳过所有冻结期间的回调

---

## 7. shell-dragdrop.css 增强

### 7.1 当前问题

窗口 move 时没有任何 body class 被设置，导致 iframe/webview 的 pointer-events 未被屏蔽。虽然 CSS 规则本身已经覆盖了所有可能的 class（见 L113-125），但触发条件缺失。

### 7.2 增强方案

**不需要修改 CSS 规则本身**，因为规则已经覆盖了 `is-layout-frozen` 等 class。在 WindowResizeBridge 修复后，`is-layout-frozen` 会在窗口 resize 和 move 时都被设置，所以 iframe/webview 的 pointer-events 会自动被屏蔽。

但如果需要额外加固，可以添加更广泛的规则：

```css
/* shell-dragdrop.css — 新增：窗口操作期间屏蔽所有内部指针事件 */
/* 当 body 处于任何窗口操作状态时，所有子元素的 pointer-events 被强制 */
body.window-resizing,
body.window-resizing *,
body.window-moving,      /* 新增：如果未来需要独立 class */
body.window-moving * {
  pointer-events: none !important;
}
```

不过 `pointer-events: none` 覆盖所有元素过于激进，会导致按钮无法点击。所以**不推荐**这种全局覆盖。

### 7.3 推荐：只增强 iframe/webview 屏蔽

当前 CSS 规则已经完善，唯一的缺失是新增的 `window-moving` class（如果引入）。建议：

```css
/* shell-dragdrop.css — 如果引入 window-moving class */
body.window-moving iframe,
body.window-moving webview {
  pointer-events: none !important;
}
```

但更好的做法是**不引入新 class**，而是让 Tauri 的 `onMoved` 事件通过 `beginLayoutInteraction` 设置 `is-layout-frozen`，这个 class 已经包含在现有 CSS 规则中。

---

## 8. 布局容器 CSS contain 注入

### 8.1 方案设计

在冻结期间，通过 JavaScript 向主要布局容器注入 `contain: layout paint`，在解冻时移除。

```typescript
// 在 WindowResizeBridge 中添加 CSS contain 注入

const CONTAIN_TARGETS = [
  '.main-layout',
  '.workspace-column',
  '.sidebar-wrapper',
];

function injectContain(): void {
  if (typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.id = 'window-resize-contain';
  style.textContent = CONTAIN_TARGETS.map(selector => `
    body.is-layout-frozen ${selector} {
      contain: layout paint !important;
    }
  `).join('\n');
  document.head.appendChild(style);
}

function removeContain(): void {
  const style = document.getElementById('window-resize-contain');
  if (style) style.remove();
}
```

### 8.2 在 WindowResizeBridge 中的集成

```typescript
private handleWindowChange(): void {
    if (this.isDestroyed) return;

    const store = useLayoutAnimationStore.getState();
    
    if (!store.isLayoutFrozen) {
      beginLayoutInteraction(this.frozenType);
      injectContain(); // 注入 CSS contain
    }

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      if (this.isDestroyed) return;
      this.scheduleThaw();
    }, 200);
}

private scheduleThaw(): void {
    requestAnimationFrame(() => {
      if (this.isDestroyed) return;
      requestAnimationFrame(() => {
        if (this.isDestroyed) return;
        endLayoutInteraction(this.frozenType);
        removeContain(); // 移除 CSS contain
        this.debounceTimer = null;
      });
    });
}
```

### 8.3 CSS 文件方案（替代 JS 注入）

如果倾向于静态 CSS，也可以直接添加到 `shell-dragdrop.css`：

```css
/* shell-dragdrop.css — CSS contain 优化 */
body.is-layout-frozen .main-layout,
body.is-layout-frozen .workspace-column,
body.is-layout-frozen .sidebar-wrapper,
body.resizing-active .main-layout,
body.resizing-active .workspace-column,
body.resizing-active .sidebar-wrapper,
body.window-resizing .main-layout,
body.window-resizing .workspace-column,
body.window-resizing .sidebar-wrapper {
  contain: layout paint;
}
```

**优点：** 静态 CSS，无运行时开销
**缺点：** 会增加 CSS 文件大小；`contain: layout paint` 可能影响特定布局（需要测试）

### 8.4 风险缓解

`contain: layout paint` 可能的影响：
1. **position: fixed 子元素**：containment 创建新的 containing block，fixed 元素会相对于容器定位而非视口 → 需要检查是否有 fixed 元素在这些容器内
2. **溢出裁剪**：paint containment 会裁剪溢出内容 → 确认这些容器本身是否有 `overflow: hidden`（通常 workspace-column 已有）
3. **Stacking context 变化**：可能影响 z-index 层级

**建议在实施前进行：**
- 在窗口中打开开发工具，手动添加 `contain: layout paint !important` 到 `.main-layout`，检查布局是否异常
- 在窗口中打开开发工具，手动添加 `contain: layout paint !important` 到 `.workspace-column`，检查布局是否异常
- 检查是否有 dialog/dropdown/popover 使用 `position: fixed`

**安全兜底：** 如果 `contain` 导致问题，回退到不使用；核心修复（beginLayoutInteraction）已足够解决冻结问题，contain 只是性能优化。

---

## 9. 测试策略

### 9.1 单元测试

#### 9.1.1 WindowResizeBridge 测试

```typescript
// apps/crish-desktop/src/services/__tests__/WindowResizeBridge.test.ts

describe('WindowResizeBridge', () => {
  let bridge: WindowResizeBridge;

  beforeEach(() => {
    // Reset layoutAnimationStore
    useLayoutAnimationStore.setState({
      activeAnimations: new Set(),
      isLayoutFrozen: false,
    });
    bridge = new WindowResizeBridge();
  });

  afterEach(() => {
    bridge.stop();
  });

  describe('start()', () => {
    it('在非 Tauri 环境应绑定 Web resize fallback', async () => {
      await bridge.start();
      expect(window._listeners?.resize).toBeDefined();
    });

    it('不应重复绑定', async () => {
      await bridge.start();
      const listenerCount = window._listenerCount?.resize || 0;
      await bridge.start();
      expect(window._listenerCount?.resize).toBe(listenerCount);
    });
  });

  describe('窗口 resize 时', () => {
    it('应调用 beginLayoutInteraction', async () => {
      const spy = jest.spyOn(layoutAnimationStore, 'beginLayoutInteraction');
      await bridge.start();
      window.dispatchEvent(new Event('resize'));
      expect(spy).toHaveBeenCalledWith('workspace-resizing');
    });

    it('应设置 isLayoutFrozen = true', async () => {
      await bridge.start();
      window.dispatchEvent(new Event('resize'));
      expect(useLayoutAnimationStore.getState().isLayoutFrozen).toBe(true);
    });
  });

  describe('窗口 move 时（Tauri onMoved）', () => {
    it('应调用 beginLayoutInteraction', async () => {
      // 模拟 Tauri onMoved
      const spy = jest.spyOn(layoutAnimationStore, 'beginLayoutInteraction');
      // 在非 Tauri 环境下，不测试 onMoved（因为它是异步 import 的）
      // 但可以测试 handleWindowChange 直接调用
      (bridge as any).handleWindowChange();
      expect(spy).toHaveBeenCalledWith('workspace-resizing');
    });
  });

  describe('解冻', () => {
    it('应在 200ms 静默期 + 双重 rAF 后解冻', async () => {
      jest.useFakeTimers();
      await bridge.start();
      window.dispatchEvent(new Event('resize'));
      
      expect(useLayoutAnimationStore.getState().isLayoutFrozen).toBe(true);
      
      // 200ms 内应有新的 resize，重置计时器
      jest.advanceTimersByTime(50);
      window.dispatchEvent(new Event('resize'));
      
      // 快进到 200ms
      jest.advanceTimersByTime(200);
      // 此时应已调度双重 rAF
      // 执行 rAF
      jest.advanceTimersByTime(16);
      expect(useLayoutAnimationStore.getState().isLayoutFrozen).toBe(true);
      
      // 第二个 rAF
      jest.advanceTimersByTime(16);
      expect(useLayoutAnimationStore.getState().isLayoutFrozen).toBe(false);
      
      jest.useRealTimers();
    });
  });

  describe('stop()', () => {
    it('应清理所有监听和定时器', async () => {
      const unlisteners = bridge['unlisteners'];
      const unlistenSpies = unlisteners.map(fn => jest.fn(fn));
      
      bridge.stop();
      
      expect(bridge['isDestroyed']).toBe(true);
      expect(bridge['unlisteners'].length).toBe(0);
    });
  });

  describe('错误处理', () => {
    it('Tauri import 失败时应降级到 Web fallback', async () => {
      // 模拟 import 失败
      jest.spyOn(window, 'addEventListener').mockImplementationOnce(() => {
        throw new Error('Import failed');
      });
      
      // 不应抛出异常
      await expect(bridge.start()).resolves.not.toThrow();
    });
  });
});
```

#### 9.1.2 useResizeFreeze 测试增强

```typescript
// apps/crish-desktop/src/hooks/__tests__/useResizeFreeze.test.ts

describe('useResizeFreeze', () => {
  // ... 现有测试 ...

  describe('与 WindowResizeBridge 集成', () => {
    it('窗口 resize 时应返回 isResizing = true', () => {
      // 模拟窗口 resize
      useLayoutAnimationStore.getState().startAnimation('workspace-resizing');
      
      const { result } = renderHook(() => useResizeFreeze(150));
      expect(result.current.isResizing).toBe(true);
    });

    it('窗口 resize 暂停后 150ms debounce 解冻', () => {
      jest.useFakeTimers();
      
      useLayoutAnimationStore.getState().startAnimation('workspace-resizing');
      const { result } = renderHook(() => useResizeFreeze(150));
      expect(result.current.isResizing).toBe(true);
      
      useLayoutAnimationStore.getState().endAnimation('workspace-resizing');
      
      // 解冻后应立即触发 state 更新
      act(() => {
        jest.advanceTimersByTime(150);
      });
      
      expect(result.current.isResizing).toBe(false);
      jest.useRealTimers();
    });
  });
});
```

### 9.2 集成测试

```typescript
// 测试窗口 resize 时：
// 1. App 组件加载 → WindowResizeBridge 初始化
// 2. 窗口 resize → store.isLayoutFrozen 应为 true
// 3. ResizeObserver 回调应被挂起 → 无 setContainerWidth 调用
// 4. 停止 resize 后 200ms → 双重 rAF 后解冻

// 测试窗口最大化时：
// 1. winCtl('toggleMaximize') 调用
// 2. Tauri 窗口尺寸变化 → store.isLayoutFrozen 应为 true
// 3. 动画完成 → 自动解冻

// 测试 Tauri 不可用时：
// 1. WindowResizeBridge 在浏览器环境启动
// 2. window.resize 事件绑定成功
// 3. 窗口 resize → store.isLayoutFrozen 正确设置
```

### 9.3 手动测试清单

参见第 10 节验证清单。

---

## 10. 验证清单

### 10.1 开发环境验证

| # | 验证项 | 预期结果 | 状态 |
|---|---|---|---|
| 1 | 启动应用，WindowResizeBridge 初始化 | 控制台无错误，`start()` 执行成功 | |
| 2 | 调整浏览器窗口宽度 | body 添加 `window-resizing` class，解冻后移除 | |
| 3 | 调整浏览器窗口高度 | `isLayoutFrozen` 在 resize 期间为 true | |
| 4 | 快速连续 resize | 解冻延迟 200ms + 双重 rAF 后执行 | |
| 5 | resize 停止后 | CSS contain 被移除，解冻 | |

### 10.2 Tauri 环境验证

| # | 验证项 | 预期结果 | 状态 |
|---|---|---|---|
| 6 | 在 Tauri 桌面应用中启动 | 控制台无错误 | |
| 7 | 拖拽标题栏移动窗口 | `isLayoutFrozen` 在移动期间为 true | |
| 8 | 拖拽窗口右下角 resize | `isLayoutFrozen` 在 resize 期间为 true | |
| 9 | 点击最大化按钮 | `isLayoutFrozen` 在动画期间为 true | |
| 10 | 从最大化还原窗口 | `isLayoutFrozen` 在动画期间为 true | |
| 11 | 窗口移动时点击 iframe 区域 | iframe 无法获取焦点（pointer-events: none） | |

### 10.3 Consumer 验证

| # | 验证项 | 预期结果 | 状态 |
|---|---|---|---|
| 12 | ChatMessageList 在窗口 resize 时不更新 containerWidth | Pretext 计算暂停 | |
| 13 | TerminalCard 在窗口 resize 时不执行 fit() | fit() 被挂起 | |
| 14 | TerminalCard 在窗口 resize 停止后自动 fit() | catch-up 任务执行 fit() | |
| 15 | FilesCard 在窗口 resize 时不更新 containerHeight | 冻结检查生效 | |
| 16 | ChatMessageList 行高测量在窗口 resize 时不回写 | setActual 不被调用 | |

### 10.4 退化测试

| # | 验证项 | 预期结果 | 状态 |
|---|---|---|---|
| 17 | Workspace.tsx sash drag 不受影响 | `beginLayoutInteraction` 按预期工作 | |
| 18 | Sidebar 拖宽不受影响 | `beginLayoutInteraction` 按预期工作 | |
| 19 | Tab 拖拽不受影响 | `beginLayoutInteraction` 按预期工作 | |
| 20 | 浏览器环境回退正常 | `window.resize` fallback 绑定成功 | |
| 21 | 浏览器环境窗口 resize | `beginLayoutInteraction` 被调用 | |
| 22 | 快速切换 Tab 后窗口 resize | 无异常状态 | |

### 10.5 性能验证

| # | 验证项 | 工具 | 预期结果 | 状态 |
|---|---|---|---|---|
| 23 | 窗口 resize 期间 Performance 面板无 Forced Reflow | Chrome DevTools Performance | FPS > 30 | |
| 24 | 窗口 move 期间 ResizeObserver 回调被挂起 | Chrome DevTools Performance | 回调计数为 0 | |
| 25 | CSS contain 注入后 Layout 范围缩小 | Chrome DevTools Rendering | Layout 仅发生在容器内 | |
| 26 | 长时间运行无内存泄漏 | Chrome DevTools Memory | Heap 稳定 | |

### 10.6 边界条件验证

| # | 验证项 | 预期结果 | 状态 |
|---|---|---|---|
| 27 | 应用卸载时 WindowResizeBridge.stop() 被调用 | 所有监听清理 | |
| 28 | 窗口最小化/恢复后 resize 处理正常 | 无异常 | |
| 29 | 多显示器拖拽（位置变化但尺寸不变） | `onMoved` 触发，冻结生效 | |
| 30 | 意外异常后不造成永久冻结 | `scheduleThaw` 兜底执行 | |

---

## 11. 实施路线图

### 11.1 分步实施

```
Phase 1: 核心修复 (1-2天)
├── P0-1: 创建 WindowResizeBridge 服务
│   ├── services/WindowResizeBridge.ts
│   ├── Tauri onResize + onMoved 监听
│   ├── Web resize fallback
│   └── 200ms debounce + 双重 rAF 解冻
├── P0-2: App.tsx 集成 WindowResizeBridge
│   ├── import + useEffect 生命周期
│   ├── 保留现有 window-resizing class 管理
│   └── try-catch 兜底
└── P0-3: 删除 useWindowControls.ts 死代码
    ├── 确认无导入
    └── git rm

Phase 2: 消费者增强 (1-2天)
├── P1-1: useSuspendedResizeObserver 增强
│   ├── enableCatchup 选项
│   ├── 最新 entry 捕获
│   └── 测试用例增强
├── P1-2: ChatMessageList 行高测量添加冻结守卫
│   └── 新增 isLayoutFrozen 检查
└── P1-3: FilesCard 切换到 useSuspendedResizeObserver

Phase 3: CSS 性能优化 (1天)
├── P2-1: 冻结期间 CSS contain 注入
│   ├── injectContain/removeContain 方法
│   ├── 主要容器选择器确定
│   └── 风险验证
├── P2-2: 窗口 resize debounce 增强
│   └── 双重 rAF 保护 window-resizing class 移除
└── P2-3: CSS contain 效果测试
    └── Performance 面板验证

Phase 4: 测试与验证 (1天)
├── 单元测试
│   ├── WindowResizeBridge.test.ts
│   └── useResizeFreeze.test.ts 增强
├── 集成测试
│   └── App.test.tsx 增强
└── 手动验证清单
    └── 全部 30 项验证
```

### 11.2 文件变更清单

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `src/services/WindowResizeBridge.ts` | **新建** | 窗口冻结桥服务 |
| `src/App.tsx` | 修改 | 集成 WindowResizeBridge，保留现有 resize handler |
| `src/hooks/useWindowControls.ts` | **删除** | 死代码清理 |
| `src/hooks/useResizeFreeze.ts` | 修改 | 增强 debounce ref 管理，移除 debounceMs 依赖 |
| `src/hooks/useSuspendedResizeObserver.ts` | 修改 | 新增 enableCatchup 选项，最新 entry 捕获 |
| `src/styles/shell/shell-dragdrop.css` | 修改（可选） | 添加 CSS contain 或 window-moving class 规则 |
| `src/services/__tests__/WindowResizeBridge.test.ts` | **新建** | 单元测试 |
| `src/hooks/__tests__/useResizeFreeze.test.ts` | 修改 | 新增集成测试 |

### 11.3 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| Tauri onMoved 事件频繁触发导致频繁冻结切换 | 中 | 低 | 200ms debounce 吸收频繁事件 |
| CSS contain 破坏 fixed 定位 | 低 | 中 | 事先测试，不加 `size` containment |
| 双重 rAF 解冻在低帧率下响应慢 | 低 | 低 | 最低保证 30fps (~66ms) |
| WindowResizeBridge 在 SSR 中执行 | 低 | 低 | `typeof document === 'undefined'` 守卫 |
| Tauri API 在不同版本中签名不同 | 中 | 中 | try-catch 防御，Web fallback |

### 11.4 回退计划

如果 WindowResizeBridge 在某个 Tauri 版本中出现问题：

1. **立即回退**：注释掉 App.tsx 中 WindowResizeBridge 的 useEffect，恢复为只使用 Web resize fallback
2. **保留增强**：useResizeFreeze 和 useSuspendedResizeObserver 的增强无需回退
3. **渐进修复**：定位具体问题（如 Tauri 事件 API 兼容性），修复后重新启用

回退后的状态（窗口 move 无冻结）与当前状态一致，不会引入新的退化。
