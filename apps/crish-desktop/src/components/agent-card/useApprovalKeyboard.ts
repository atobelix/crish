import { useEffect, useRef } from 'react';
import { useLeafScope } from '../../contexts/LeafScopeContext';

export interface UseApprovalKeyboardOptions {
  rootRef: React.RefObject<HTMLDivElement | null>;
  allowBtnRef: React.RefObject<HTMLButtonElement | null>;
  confirmArmed: boolean;
  busy: boolean;
  msgId: string;
  toolId?: string | undefined;
  onDisarm: () => void;
  onEnterAllow: () => void;
}

function isEditingInput(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (
    el.isContentEditable ||
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('contenteditable') === ''
  ) {
    return true;
  }
  return Boolean(
    el.closest?.(
      'input, textarea, [contenteditable="true"], [contenteditable=""]'
    )
  );
}

/**
 * 审批卡键盘交互与焦点管理 Hook：
 * - 组件挂载与卡片切换时若当前分屏激活且无打字，根节点自动聚焦（绝不后台强抢前台焦点）；
 * - 二次确认武装时主按钮自动聚焦；
 * - Esc 键安全解除二次确认武装（仅响应卡片内焦点或所属激活分屏）；
 * - Enter 快捷键触发允许操作（textarea/编辑器内部正常换行，不拦截）；
 * - Tab / Shift+Tab 焦点陷阱（Focus Trap），确保无障碍键盘导航在卡片内循环。
 */
export function useApprovalKeyboard({
  rootRef,
  allowBtnRef,
  confirmArmed,
  busy,
  msgId,
  toolId,
  onDisarm,
  onEnterAllow,
}: UseApprovalKeyboardOptions): void {
  const scope = useLeafScope();

  const onDisarmRef = useRef(onDisarm);
  onDisarmRef.current = onDisarm;

  const onEnterAllowRef = useRef(onEnterAllow);
  onEnterAllowRef.current = onEnterAllow;

  // 1. mount 时若属于当前激活分屏且用户不在输入，自动聚焦到卡片根；后台分屏绝不强抢打字焦点
  useEffect(() => {
    if (!scope.isActive) return;
    const t = window.setTimeout(() => {
      if (!scope.isActive) return;
      if (isEditingInput(document.activeElement)) return;
      rootRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(t);
  }, [rootRef, msgId, toolId, scope.isActive]);

  // 2. Esc：取消「再次确认」武装，不提交拒绝
  useEffect(() => {
    if (!confirmArmed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (e.isComposing || (e as any).keyCode === 229) return;
      const root = rootRef.current;
      if (!root) return;

      const active = document.activeElement;
      const isFocusedInCard = active && root.contains(active);
      // 若焦点在外部：仅当所属分屏为激活分屏且用户未在其他输入框打字时才响应
      if (!isFocusedInCard) {
        if (!scope.isActive || isEditingInput(active)) return;
      }

      const target =
        e.target instanceof HTMLElement
          ? e.target
          : active instanceof HTMLElement
            ? active
            : null;
      if (target && target !== document.body && !root.contains(target)) {
        return; // 外部元素处于焦点态，严禁拦截全局按键
      }
      e.preventDefault();
      e.stopPropagation();
      onDisarmRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirmArmed, rootRef, scope.isActive]);

  // 3. Focus trap：Tab / Shift+Tab 在卡片内循环，不漂回页面其他元素
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last!.focus({ preventScroll: true });
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first!.focus({ preventScroll: true });
        }
      }
    };
    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
  }, [rootRef, confirmArmed]);

  // 4. Enter 快捷键：武装状态下触发允许，未武装时武装。
  // 注意：textarea 与 contentEditable 内 Enter 仍换行（不阻止默认行为），仅在卡片内或按钮焦点时触发。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      if (e.isComposing || (e as any).keyCode === 229) return;
      const root = rootRef.current;
      if (!root) return;
      const target =
        e.target instanceof HTMLElement
          ? e.target
          : document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      if (!target || !root.contains(target)) return;
      if (isEditingInput(target)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onEnterAllowRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [rootRef]);

  // 5. 武装后把焦点移到主允许按钮，降低误触其它控件概率（受激活态与输入守卫保护）
  useEffect(() => {
    if (!confirmArmed || busy) return;
    if (!scope.isActive) return;
    const t = window.setTimeout(() => {
      if (!scope.isActive) return;
      if (isEditingInput(document.activeElement)) return;
      allowBtnRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(t);
  }, [allowBtnRef, confirmArmed, busy, scope.isActive]);
}
