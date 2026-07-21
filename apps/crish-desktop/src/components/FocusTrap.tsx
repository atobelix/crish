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
      for (const child of parent.children) {
        if (child !== container) {
          originalValues.current.set(child, child.getAttribute('aria-hidden'));
          child.setAttribute('aria-hidden', 'true');
          if ('inert' in HTMLElement.prototype) {
            (child as any).inert = true;
          }
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
      if ('inert' in HTMLElement.prototype) {
        (el as any).inert = false;
      }
    }
    originalValues.current.clear();
  }, []);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const target =
      initialFocusRef?.current ?? getFocusableElements(container)[0];
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
          last.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      deactivate();
    };
  }, [active, initialFocusRef, activate, deactivate]);

  return <div ref={containerRef}>{children}</div>;
}

export { FocusTrap };
export type { FocusTrapProps };
