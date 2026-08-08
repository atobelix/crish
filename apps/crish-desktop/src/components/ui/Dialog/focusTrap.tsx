/**
 * ui/Dialog 目录内私有焦点圈定基元（PE-05 T05.1.3）
 *
 * 从 `components/FocusTrap.tsx` 提炼（ui 原子层禁止依赖业务组件目录）。
 * 行为保持一致：Tab/Shift+Tab 循环 + 惰性 inert/aria-hidden 旁路
 * （对容器同级兄弟元素隐藏，使屏幕阅读器与焦点序不逃逸）。
 */
import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react';

interface FocusTrapProps {
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

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

function FocusTrap({ children, active, initialFocusRef }: FocusTrapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const originalValues = useRef<Map<Element, string | null>>(new Map());

  const activate = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const parent = container.parentElement;
    if (parent) {
      for (const child of Array.from(parent.children)) {
        if (child === container) continue;
        // F7 F5：跳过其他已开 Dialog 的 FocusTrap 容器——嵌套/并发弹窗
        // 的 portal 是 body 兄弟节点，若被外层旁路 inert/aria-hidden，
        // 内层弹窗将完全不可交互（时序错位风险）
        if (child.hasAttribute('data-focus-trap')) continue;
        originalValues.current.set(child, child.getAttribute('aria-hidden'));
        child.setAttribute('aria-hidden', 'true');
        if ('inert' in HTMLElement.prototype && 'inert' in child) {
          (child as HTMLElement & { inert: boolean }).inert = true;
        }
      }
    }
  }, []);

  const deactivate = useCallback(() => {
    for (const [el, val] of originalValues.current) {
      if (val === null) {
        el.removeAttribute('aria-hidden');
      } else {
        el.setAttribute('aria-hidden', val);
      }
      if ('inert' in HTMLElement.prototype && 'inert' in el) {
        (el as HTMLElement & { inert: boolean }).inert = false;
      }
    }
    originalValues.current.clear();
  }, []);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    // F7 F6：initialFocusRef 指向容器外/已卸载元素时不聚焦（焦点会逃逸出
    // trap，Tab 循环与 inert 旁路全部失效）——回退到容器内首个可交互元素
    const target =
      initialFocusRef?.current &&
      container.contains(initialFocusRef.current)
        ? initialFocusRef.current
        : getFocusableElements(container)[0];
    target?.focus();

    activate();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusableElements(container);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last!.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first!.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      deactivate();
    };
  }, [active, initialFocusRef, activate, deactivate]);

  // data-focus-trap 标记：供同级 FocusTrap 的 inert 旁路识别（F7 F5）
  return <div ref={containerRef} data-focus-trap>{children}</div>;
}

export { FocusTrap };
export type { FocusTrapProps };
