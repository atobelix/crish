/**
 * 全局拖拽遮罩层工具集。
 * 参考 VS Code sash.ts 的 iframe 屏蔽 + CSS 全局光标覆盖策略。
 */

/** 创建覆盖全视口的透明遮罩层 */
export function createDragOverlay(cursor: string): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'global-drag-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: var(--z-drag-overlay);
    cursor: ${cursor};
    pointer-events: auto;
    contain: strict;
  `;
  overlay.setAttribute('data-drag-overlay', 'true');
  document.body.appendChild(overlay);
  return overlay;
}

/** 移除遮罩层 */
export function removeDragOverlay(overlay: HTMLElement | null): void {
  if (overlay && overlay.parentNode) {
    overlay.parentNode.removeChild(overlay);
  }
}

/** VS Code 风格：全局 CSS 光标覆盖 */
export function createGlobalCursorStyle(cursor: string): HTMLStyleElement {
  const style = document.createElement('style');
  style.id = 'global-drag-cursor';
  style.textContent = `* { cursor: ${cursor} !important; }`;
  document.head.appendChild(style);
  return style;
}

/** 移除全局光标样式 */
export function removeGlobalCursorStyle(style: HTMLStyleElement | null): void {
  if (style && style.parentNode) {
    style.parentNode.removeChild(style);
  }
}

/** VS Code 风格：禁用所有 iframe 的指针事件 */
export function disableIframePointerEvents(): () => void {
  const iframes = document.querySelectorAll<HTMLElement>('iframe, webview, object, embed');
  const restoreFns: (() => void)[] = [];
  iframes.forEach((el) => {
    const original = el.style.pointerEvents;
    el.style.pointerEvents = 'none';
    restoreFns.push(() => { el.style.pointerEvents = original || ''; });
  });
  return () => { restoreFns.forEach(fn => { try { fn(); } catch { /* 单个恢复失败不阻断其余 */ } }); };
}
