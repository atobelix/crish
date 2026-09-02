/**
 * useSessionListDragHelpers.ts — 侧栏拖拽辅助函数与数据结构
 */
import type { SessionState } from '../../../store/types';
import { GENERAL_FOLDER } from '../../../api/projectStore';

export type DropPlace = 'before' | 'after';

export type DropIndicator = {
  sessionId: string;
  place: DropPlace;
};

export type SessionDragPreview = {
  sessionId: string;
  overSessionId: string | null;
  place: DropPlace;
  isPinned: boolean;
  folder: string;
};

export const DRAG_THRESHOLD_PX = 4;
export const DEFAULT_ROW_STEP_PX = 31; // 28px height + 3px gap
export const DEFAULT_TAB_STEP_PX = 154; // 150px tab max-width + 4px gap

export function applyDragPreview(
  list: SessionState[],
  preview: SessionDragPreview,
  dragSession: SessionState | null,
  listIsTarget: boolean
): SessionState[] {
  const without = list.filter((s) => s.id !== preview.sessionId);
  if (!listIsTarget) return without;

  const source =
    dragSession && dragSession.id === preview.sessionId
      ? dragSession
      : list.find((s) => s.id === preview.sessionId) || null;
  if (!source) return without;

  const virtual: SessionState = {
    ...source,
    isPinned: preview.isPinned,
    folder: preview.folder,
  };

  if (!preview.overSessionId) {
    return [...without, virtual];
  }

  const idx = without.findIndex((s) => s.id === preview.overSessionId);
  if (idx === -1) return [...without, virtual];

  const insertAt = preview.place === 'before' ? idx : idx + 1;
  const next = without.slice();
  next.splice(insertAt, 0, virtual);
  return next;
}

export function isPreviewTargetSection(
  preview: SessionDragPreview,
  kind: 'pinned' | 'general' | 'project',
  projectId?: string
): boolean {
  if (kind === 'pinned') return preview.isPinned;
  if (preview.isPinned) return false;
  if (kind === 'general') {
    return (
      preview.folder === GENERAL_FOLDER ||
      preview.folder === '会话' ||
      preview.folder === '常规会话' ||
      preview.folder === 'general' ||
      !preview.folder
    );
  }
  return Boolean(projectId && preview.folder === projectId);
}

/**
 * 原汁原味克隆当前会话行的真实 DOM 外观，并进行深层事件脱敏（杜绝 pointer-events 遮挡穿透）
 */
export function createSidebarSessionGhost(rowLi: HTMLElement, rowRect: DOMRect): HTMLDivElement {
  const ghost = rowLi.cloneNode(true) as HTMLDivElement;
  ghost.className = 'sidebar-drag-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.cssText = [
    'position: fixed',
    'left: 0',
    'top: 0',
    `width: ${Math.round(rowRect.width)}px`,
    `height: ${Math.round(rowRect.height)}px`,
    'box-sizing: border-box',
    'pointer-events: none !important',
    'z-index:var(--z-tooltip)',
    'opacity: 0.94',
    'border-radius: 8px',
    'background: var(--bg-card, #ffffff)',
    'box-shadow: 0 10px 28px rgba(0, 0, 0, 0.15), 0 3px 8px rgba(0, 0, 0, 0.08)',
    'border: 1px solid var(--border-color, rgba(0, 0, 0, 0.12))',
    'will-change: transform',
    'transform: translate3d(-9999px, -9999px, 0)',
    'margin: 0',
    'list-style: none',
  ].join(';');

  // 深度禁用内部所有子元素的指针响应与焦点
  ghost.querySelectorAll('*').forEach((n) => {
    if (n instanceof HTMLElement) {
      n.style.pointerEvents = 'none';
      n.tabIndex = -1;
    }
  });

  document.body.appendChild(ghost);
  return ghost;
}

/** 吞噬拖拽松手后的紧跟 click 事件，防止误触发列表项选中 */
export function swallowNextClick(): void {
  const handler = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('click', handler, true);
  };
  window.addEventListener('click', handler, true);
  setTimeout(() => {
    window.removeEventListener('click', handler, true);
  }, 300);
}
