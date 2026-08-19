/**
 * Tooltip 全局单槽：同时 visible ≤ 1；滚动 / resize / blur / 菜单开立刻全灭。
 * 每颗实例只登记 hide，占槽时后来者关掉前者。
 */
import { layerStackManager } from '../internal/layer-stack/LayerStackManager';

/** 意图停留：未满此时长离开则从未显示（300–400ms 口径） */
export const DEFAULT_DELAY_SHOW_MS = 350;

type HideFn = () => void;

const hiders = new Map<string, HideFn>();
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

export function registerTooltipInstance(id: string, hide: HideFn): () => void {
  hiders.set(id, hide);
  ensureDismissListeners();
  return () => {
    hiders.delete(id);
    if (activeId === id) activeId = null;
  };
}

/** 后来者占槽。菜单静音中拒绝占槽。 */
export function claimTooltipSlot(id: string): boolean {
  if (isTooltipMuted()) return false;
  if (activeId && activeId !== id) {
    hiders.get(activeId)?.();
  }
  activeId = id;
  return true;
}

export function releaseTooltipSlot(id: string): void {
  if (activeId === id) activeId = null;
}

export function hideAllTooltips(): void {
  const snapshot = [...hiders.values()];
  activeId = null;
  for (const hide of snapshot) hide();
}

function ensureDismissListeners(): void {
  if (listenersAttached || typeof window === 'undefined') return;
  listenersAttached = true;

  const dismiss = () => hideAllTooltips();

  window.addEventListener('scroll', dismiss, true);
  window.addEventListener('resize', dismiss);
  window.addEventListener('blur', dismiss);
  document.addEventListener('pointerdown', dismiss, true);
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') dismiss();
  };
  document.addEventListener('visibilitychange', onVisibility);

  listenerCleanups.push(() => {
    window.removeEventListener('scroll', dismiss, true);
    window.removeEventListener('resize', dismiss);
    window.removeEventListener('blur', dismiss);
    document.removeEventListener('pointerdown', dismiss, true);
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
  hiders.clear();
  activeId = null;
  for (const off of listenerCleanups) off();
  listenerCleanups.length = 0;
  listenersAttached = false;
  floatingObserver?.disconnect();
  floatingObserver = null;
}
