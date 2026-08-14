import { useEffect, useRef } from 'react';

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

/**
 * 审批卡键盘交互与焦点管理 Hook：
 * - 组件挂载与卡片切换时根节点自动聚焦；
 * - 二次确认武装时主按钮自动聚焦；
 * - Esc 键安全解除二次确认武装；
 * - Enter 快捷键触发允许操作（textarea 内部正常换行，不拦截）；
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
  const onDisarmRef = useRef(onDisarm);
  onDisarmRef.current = onDisarm;

  const onEnterAllowRef = useRef(onEnterAllow);
  onEnterAllowRef.current = onEnterAllow;

  // 1. mount 时自动聚焦到卡片根，键盘用户立即可达
  useEffect(() => {
    const t = window.setTimeout(() => {
      rootRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(t);
  }, [rootRef, msgId, toolId]);

  // 2. Esc：取消「再次确认」武装，不提交拒绝
  useEffect(() => {
    if (!confirmArmed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (e.isComposing || (e as any).keyCode === 229) return;
      const root = rootRef.current;
      if (!root) return;
      const target =
        e.target instanceof HTMLElement
          ? e.target
          : document.activeElement instanceof HTMLElement
            ? document.activeElement
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
  }, [confirmArmed, rootRef]);

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
      if (
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        target.contentEditable === 'true' ||
        target.contentEditable === '' ||
        Boolean(
          target.closest?.(
            '[contenteditable="true"], [contenteditable=""], [contenteditable]:not([contenteditable="false"])'
          )
        )
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onEnterAllowRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [rootRef]);

  // 5. 武装后把焦点移到主允许按钮，降低误触其它控件概率
  useEffect(() => {
    if (!confirmArmed || busy) return;
    const t = window.setTimeout(() => {
      allowBtnRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(t);
  }, [allowBtnRef, confirmArmed, busy]);
}
