/**
 * ui/Dialog 目录内私有焦点圈定基元（PE-05 T05.1.3, WO-21）
 *
 * 引用计数沙盒与白名单隔离（WO-21 / SPEC-03 / Plan-09）：
 * 1. 建立 FocusTrapIsolationManager 原生 Map<Element, number> inert 引用计数状态机；
 * 2. 精确隔离当前 activeTrapElement 自身，多层嵌套时父级 Dialog 被正确 inert 冻结；
 * 3. 白名单旁路：Radix Popper、Tooltip、Toast 以及自研 Select/Combobox 浮层不打上 aria-hidden / inert；
 * 4. Tab / Shift+Tab 循环锁定与边界 wrap-around 冒泡阻断，支持自研浮层内部焦点豁免。
 */
import React, {
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';

export interface FocusTrapProps {
  children: ReactNode;
  /** 是否启用 focus trap */
  active: boolean;
  /** 指定初始聚焦元素；不传则自动查找容器内第一个可交互元素 */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable]',
].join(', ');

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter((el) => {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

interface InertSnapshot {
  hadAriaHidden: boolean;
  originalAriaHidden: string | null;
  hadInert: boolean;
}

class FocusTrapIsolationManager {
  private static instance: FocusTrapIsolationManager;
  private trapStack: HTMLElement[] = [];
  private inertCounts = new Map<Element, number>();
  private snapshots = new Map<Element, InertSnapshot>();

  static getInstance(): FocusTrapIsolationManager {
    if (!FocusTrapIsolationManager.instance) {
      FocusTrapIsolationManager.instance = new FocusTrapIsolationManager();
    }
    return FocusTrapIsolationManager.instance;
  }

  private isWhitelisted(node: Element): boolean {
    if (
      node.hasAttribute('data-radix-popper-content-wrapper') ||
      node.getAttribute('data-tooltip-portal') === 'true' ||
      node.getAttribute('data-toast-container') === 'true' ||
      node.classList.contains('radix-popper-content-wrapper') ||
      node.classList.contains('toaster') ||
      node.id === 'toast-portal' ||
      node.id === 'tooltip-portal' ||
      // 🌟 Plan-09 自研 Select / Combobox 原子浮层白名单放行
      node.getAttribute('data-slot') === 'select-content' ||
      node.getAttribute('data-slot') === 'combobox-content' ||
      node.getAttribute('role') === 'listbox' ||
      node.hasAttribute('data-floating-layer') ||
      node.querySelector?.(
        '[data-slot="select-content"], [data-slot="combobox-content"], [role="listbox"], [data-floating-layer]'
      ) != null
    ) {
      return true;
    }
    return false;
  }

  pushTrap(trapEl: HTMLElement): void {
    this.trapStack.push(trapEl);
    this.applyIsolation();
  }

  popTrap(trapEl: HTMLElement): void {
    const idx = this.trapStack.lastIndexOf(trapEl);
    if (idx !== -1) {
      this.trapStack.splice(idx, 1);
    }
    this.applyIsolation();
  }

  private restoreNode(node: Element): void {
    const snap = this.snapshots.get(node);
    if (snap) {
      this.snapshots.delete(node);
      if (snap.hadAriaHidden) {
        if (snap.originalAriaHidden != null) {
          node.setAttribute('aria-hidden', snap.originalAriaHidden);
        } else {
          node.removeAttribute('aria-hidden');
        }
      } else {
        node.removeAttribute('aria-hidden');
      }
      if (!snap.hadInert) {
        node.removeAttribute('inert');
      }
    } else {
      node.removeAttribute('aria-hidden');
      node.removeAttribute('inert');
    }
  }

  private applyIsolation(): void {
    const activeTrap =
      this.trapStack.length > 0
        ? this.trapStack[this.trapStack.length - 1]
        : null;
    if (!activeTrap) {
      for (const [node] of Array.from(this.inertCounts.entries())) {
        this.restoreNode(node);
      }
      this.inertCounts.clear();
      this.snapshots.clear();
      return;
    }

    const currentInertTargets = new Set<Element>();
    const docBody = document.body;

    // 1. document.body 层级的所有非包含 activeTrap 的子元素
    if (docBody) {
      for (const child of Array.from(docBody.children)) {
        if (child === activeTrap || child.contains(activeTrap)) continue;
        if (this.isWhitelisted(child)) continue;
        currentInertTargets.add(child);
      }
    }

    // 2. 如果 activeTrap 在某一容器内嵌套，沿 DOM 树向上处理同层兄弟
    let curr: HTMLElement | null = activeTrap.parentElement;
    while (curr && curr !== docBody) {
      for (const child of Array.from(curr.children)) {
        if (child === activeTrap || child.contains(activeTrap)) continue;
        if (this.isWhitelisted(child)) continue;
        currentInertTargets.add(child);
      }
      curr = curr.parentElement;
    }

    // 3. 释放已不需要 inert 的节点
    for (const [node, count] of Array.from(this.inertCounts.entries())) {
      if (!currentInertTargets.has(node)) {
        if (count <= 1) {
          this.inertCounts.delete(node);
          this.restoreNode(node);
        } else {
          this.inertCounts.set(node, count - 1);
        }
      }
    }

    // 4. 对当前需要 inert 的目标施加状态并记录快照
    for (const target of currentInertTargets) {
      const prevCount = this.inertCounts.get(target) || 0;
      this.inertCounts.set(target, prevCount + 1);

      if (prevCount === 0) {
        if (!this.snapshots.has(target)) {
          this.snapshots.set(target, {
            hadAriaHidden: target.hasAttribute('aria-hidden'),
            originalAriaHidden: target.getAttribute('aria-hidden'),
            hadInert: target.hasAttribute('inert'),
          });
        }
        target.setAttribute('aria-hidden', 'true');
        target.setAttribute('inert', '');
      }
    }
  }
}

export function FocusTrap({
  children,
  active,
  initialFocusRef,
}: FocusTrapProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const manager = FocusTrapIsolationManager.getInstance();
    manager.pushTrap(container);

    const target =
      initialFocusRef?.current && container.contains(initialFocusRef.current)
        ? initialFocusRef.current
        : getFocusableElements(container)[0];
    target?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (!containerRef.current) return;

      const focusable = getFocusableElements(containerRef.current);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const activeEl = document.activeElement;

      // 如果当前焦点位于自研或白名单浮层内部，交由浮层自身键盘状态机处理
      if (
        activeEl &&
        activeEl.closest?.(
          '[data-slot="select-content"], [data-slot="combobox-content"], [role="listbox"], [data-radix-popper-content-wrapper], [data-floating-layer]'
        )
      ) {
        return;
      }

      if (e.shiftKey) {
        if (activeEl === first || !containerRef.current.contains(activeEl)) {
          e.preventDefault();
          e.stopPropagation();
          last.focus();
        }
      } else {
        if (activeEl === last || !containerRef.current.contains(activeEl)) {
          e.preventDefault();
          e.stopPropagation();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      manager.popTrap(container);
    };
  }, [active, initialFocusRef]);

  return (
    <div
      ref={containerRef}
      data-focus-trap="true"
      style={{ display: 'contents' }}
    >
      {children}
    </div>
  );
}
