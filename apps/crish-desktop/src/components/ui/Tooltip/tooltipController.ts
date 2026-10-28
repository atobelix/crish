/**
 * Tooltip 全局单槽控制器：同时 visible ≤ 1；滚动 / resize / blur / 菜单开立刻全灭。
 * 每颗实例只登记 hide，占槽时后来者关掉前者。
 * 纯声明式状态管理，严禁任何 DOM removeChild Monkey-patch 或 el.remove() 强拆。
 */
import { layerStackManager } from '../internal/layer-stack/LayerStackManager';

/** 意图停留：未满此时长离开则从未显示（300–400ms 口径） */
export const DEFAULT_DELAY_SHOW_MS = 350;

type HideFn = () => void;

interface TooltipEntry {
  hide: HideFn;
  cancelPending: () => void;
}

const registry = new Map<string, TooltipEntry>();
let activeId: string | null = null;
let listenersAttached = false;
let floatingObserver: MutationObserver | null = null;
const listenerCleanups: Array<() => void> = [];

function isFloatingActiveAttr(): boolean {
  if (typeof document === 'undefined') return false;
  return (
    document.documentElement.getAttribute('data-floating-active') === 'true' ||
    document.body?.getAttribute('data-floating-active') === 'true'
  );
}

/** 菜单开着 / 静默窗 / DOM 广播：提示必须静音。内部调用 isTooltipSilenced()。 */
export function isTooltipMuted(): boolean {
  return layerStackManager.isTooltipSilenced() || isFloatingActiveAttr();
}

export function registerTooltipInstance(
  id: string,
  hide: HideFn,
  cancelPending: () => void = () => {}
): () => void {
  registry.set(id, { hide, cancelPending });
  ensureDismissListeners();
  return () => {
    registry.delete(id);
    if (activeId === id) activeId = null;
  };
}

/** 取消所有正在等待显示（排队未弹出）的 Tooltip 定时器 */
export function cancelAllPendingTooltips(exceptId?: string): void {
  for (const [id, entry] of registry.entries()) {
    if (id !== exceptId) {
      entry.cancelPending();
    }
  }
}

/** 后来者占槽。菜单静音中拒绝占槽；一旦占槽，灭掉所有其他提示，确保全局 ≤ 1 */
export function claimTooltipSlot(id: string): boolean {
  if (isTooltipMuted()) return false;
  cancelAllPendingTooltips(id);
  // 状态机互斥：遍历所有 registered entry，灭掉除 id 以外的一切实例
  for (const [otherId, entry] of registry.entries()) {
    if (otherId !== id) {
      entry.hide();
    }
  }
  activeId = id;
  return true;
}

export function releaseTooltipSlot(id: string): void {
  if (activeId === id) activeId = null;
}

export function hideAllTooltips(): void {
  activeId = null;
  const snapshot = [...registry.values()];
  for (const entry of snapshot) {
    entry.cancelPending();
    entry.hide();
  }
}

function ensureDismissListeners(): void {
  if (listenersAttached || typeof window === 'undefined') return;
  listenersAttached = true;

  const dismiss = () => hideAllTooltips();
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
  };
  const onDocMouseLeave = (e: MouseEvent) => {
    if (!e.relatedTarget) dismiss();
  };

  window.addEventListener('scroll', dismiss, true);
  window.addEventListener('app:window-resize-settled', dismiss);
  window.addEventListener('blur', dismiss);
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', dismiss, true);
  document.addEventListener('click', dismiss, true);
  document.addEventListener('contextmenu', dismiss, true);
  document.documentElement.addEventListener('mouseleave', onDocMouseLeave);

  const onVisibility = () => {
    if (document.visibilityState !== 'visible') dismiss();
  };
  document.addEventListener('visibilitychange', onVisibility);

  listenerCleanups.push(() => {
    window.removeEventListener('scroll', dismiss, true);
    window.removeEventListener('app:window-resize-settled', dismiss);
    window.removeEventListener('blur', dismiss);
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', dismiss, true);
    document.removeEventListener('click', dismiss, true);
    document.removeEventListener('contextmenu', dismiss, true);
    document.documentElement.removeEventListener('mouseleave', onDocMouseLeave);
    document.removeEventListener('visibilitychange', onVisibility);
  });

  if (typeof MutationObserver !== 'undefined') {
    floatingObserver = new MutationObserver(() => {
      if (isTooltipMuted()) hideAllTooltips();
    });
    const opts: MutationObserverInit = {
      attributes: true,
      attributeFilter: ['data-floating-active'],
    };
    floatingObserver.observe(document.documentElement, opts);
    if (document.body) floatingObserver.observe(document.body, opts);
  }
}

/** 测试收尾：清槽并卸全局监听，避免用例互串 */
export function resetTooltipControllerForTests(): void {
  hideAllTooltips();
  registry.clear();
  activeId = null;
  for (const off of listenerCleanups) off();
  listenerCleanups.length = 0;
  listenersAttached = false;
  floatingObserver?.disconnect();
  floatingObserver = null;
}
