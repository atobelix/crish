/**
 * useTablistKeyboard — role="tablist" 的键盘导航（WAI-ARIA 自动激活模式）。
 *
 * 单一实现，PaneHeader 会话标签条与 LeafToolTabStrip 工具标签条共用：
 * - ArrowLeft / ArrowRight 循环移动焦点并激活；
 * - Home / End 跳转首尾并激活；
 * - Enter / Space 激活当前聚焦标签。
 * 激活即回调 onActivate，调用方负责真实切换与 aria-selected 跟随。
 */

import { useCallback, useRef, type KeyboardEvent, type RefObject } from 'react';

export interface TablistKeyboardOptions {
  /** 标签项选择器（相对容器） */
  tabSelector: string;
  /** 从标签元素读出 tabId */
  readTabId: (el: Element) => string | null;
  /** 激活回调 */
  onActivate: (tabId: string) => void;
}

export function useTablistKeyboard(
  ref: RefObject<HTMLElement | null>,
  options: TablistKeyboardOptions
): (e: KeyboardEvent<HTMLElement>) => void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  return useCallback((e: KeyboardEvent<HTMLElement>) => {
    const { tabSelector, readTabId, onActivate } = optionsRef.current;
    const container = ref.current;
    if (!container) return;

    const isMoveKey =
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'Home' ||
      e.key === 'End';
    const isActivateKey = e.key === 'Enter' || e.key === ' ';
    if (!isMoveKey && !isActivateKey) return;

    const tabs = Array.from(
      container.querySelectorAll<HTMLElement>(tabSelector)
    );
    if (tabs.length === 0) return;

    const focusedIndex = tabs.findIndex((t) => t === document.activeElement);

    if (isActivateKey) {
      e.preventDefault();
      if (focusedIndex >= 0) {
        const targetTab = tabs[focusedIndex];
        if (targetTab) {
          const id = readTabId(targetTab);
          if (id) onActivate(id);
        }
      }
      return;
    }

    e.preventDefault();
    let nextIndex: number;
    if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = tabs.length - 1;
    } else if (e.key === 'ArrowLeft') {
      nextIndex = focusedIndex <= 0 ? tabs.length - 1 : focusedIndex - 1;
    } else {
      nextIndex =
        focusedIndex < 0 || focusedIndex >= tabs.length - 1
          ? 0
          : focusedIndex + 1;
    }

    const next = tabs[nextIndex];
    if (!next) return;
    next.focus();
    const id = readTabId(next);
    if (id) onActivate(id);
  }, [ref]);
}
