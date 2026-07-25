import { findDropTargetCardEl } from './pointer-state';

export function detachListeners(params: {
  targetEl: HTMLElement;
  pointerId: number;
  handlePointerMove: (e: PointerEvent) => void;
  finishPointer: (ev?: Event) => void;
}): void {
  window.removeEventListener('pointermove', params.handlePointerMove);
  window.removeEventListener('pointerup', params.finishPointer);
  window.removeEventListener('pointercancel', params.finishPointer);
  params.targetEl.removeEventListener('lostpointercapture', params.finishPointer);
  try {
    if (params.targetEl.hasPointerCapture?.(params.pointerId)) {
      params.targetEl.releasePointerCapture(params.pointerId);
    }
  } catch {
    /* ignore */
  }
}

export function animateOverlayAway(
  overlay: HTMLDivElement,
  cardId: string,
  preferredGroupId: string | null
): void {
  document.body.classList.remove('dragging-card');
  requestAnimationFrame(() => {
    const targetCardDOM = findDropTargetCardEl(cardId, preferredGroupId);
    if (targetCardDOM) {
      const destRect = targetCardDOM.getBoundingClientRect();
      overlay.classList.add('drag-overlay-animate-away');
      overlay.style.transform = `translate3d(${destRect.left}px, ${destRect.top}px, 0)`;
      overlay.style.width = `${destRect.width}px`;
      overlay.style.height = `${Math.min(destRect.height, 160)}px`;
      overlay.style.opacity = '0.2';
      window.setTimeout(() => overlay.remove(), 280);
    } else {
      overlay.classList.add('drag-overlay-fade-out');
      window.setTimeout(() => overlay.remove(), 200);
    }
  });
}
