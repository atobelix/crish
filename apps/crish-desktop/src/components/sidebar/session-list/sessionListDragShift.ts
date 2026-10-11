/**
 * sessionListDragShift.ts — 侧栏会话拖拽时的行位移计算与应用
 *
 * 从 useSessionListDrag.ts 拆出（行数门禁），行为与原内联实现逐句一致：
 * - computeRowShiftOffsets：纯函数，按源/目标下标算出每一行的 translateY 偏移；
 * - shiftRowsForDrag：在目标容器内应用位移；跨分组时把源分组中原位置之后的行
 *   （以及「查看全部」折叠行）向上补位，避免源与目标同时出现空行。
 */
import type { DropPlace } from './useSessionListDragHelpers';

const SHIFT_TRANSITION = 'transform 120ms cubic-bezier(0.2, 0, 0, 1)';

/** 容器内当前可见的会话行（隐藏或零高度的行不参与位移）。 */
export function collectVisibleRows(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('li[data-session-id]')).filter(
    (r) => r.offsetParent !== null && r.getBoundingClientRect().height > 0
  );
}

/**
 * 每个「其余行」（已排除被拖拽行）的偏移量。
 * 同容器：源与目标之间的行向源方向移动一格；跨容器：目标位置及之后的行下移一格。
 */
export function computeRowShiftOffsets(
  otherCount: number,
  srcIdx: number,
  targetIdx: number,
  isSameContainer: boolean,
  stepPx: number
): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < otherCount; i++) {
    let offset = 0;
    if (isSameContainer && srcIdx >= 0) {
      if (targetIdx > srcIdx) {
        if (i >= srcIdx && i < targetIdx) offset = -stepPx;
      } else if (targetIdx < srcIdx) {
        if (i >= targetIdx && i < srcIdx) offset = stepPx;
      }
    } else if (i >= targetIdx) {
      offset = stepPx;
    }
    offsets.push(offset);
  }
  return offsets;
}

function applyRowShift(el: HTMLElement, offset: number): void {
  el.style.transition = SHIFT_TRANSITION;
  el.style.transform = offset !== 0 ? `translateY(${offset}px)` : '';
}

/** 跨分组拖拽：源分组中原位置之后的行与折叠切换行向上收缩一格，返回被位移的元素。 */
export function collapseSourceRows(
  sourceContainer: Element,
  sessionId: string,
  stepPx: number,
  foldToggleClass: string | undefined
): HTMLElement[] {
  const shifted: HTMLElement[] = [];
  const allSourceRows = collectVisibleRows(sourceContainer);
  const origIdx = allSourceRows.findIndex((r) => r.getAttribute('data-session-id') === sessionId);
  if (origIdx < 0) return shifted;
  for (let i = 0; i < allSourceRows.length; i++) {
    const sRow = allSourceRows[i]!;
    if (sRow.getAttribute('data-session-id') === sessionId) continue;
    if (i > origIdx) {
      sRow.style.transition = SHIFT_TRANSITION;
      sRow.style.transform = `translateY(-${stepPx}px)`;
      shifted.push(sRow);
    }
  }
  // 若源容器内有折叠切换按钮（如「查看全部」），亦同步向上收缩
  const foldBtn = sourceContainer.parentElement?.querySelector(`.${foldToggleClass}`) as HTMLElement | null;
  if (foldBtn) {
    foldBtn.style.transition = SHIFT_TRANSITION;
    foldBtn.style.transform = `translateY(-${stepPx}px)`;
    shifted.push(foldBtn);
  }
  return shifted;
}

export type ShiftRowsForDragArgs = {
  activeContainer: HTMLElement;
  sourceContainer: Element | null;
  sessionId: string;
  overId: string | null;
  place: DropPlace;
  stepPx: number;
  /** CSS Module 类名（与原内联实现一致，直接拼进选择器）。 */
  foldToggleClass: string | undefined;
};

/** 应用一帧拖拽位移，返回本帧被位移的全部元素（调用方据此复位上一帧多出来的元素）。 */
export function shiftRowsForDrag(args: ShiftRowsForDragArgs): HTMLElement[] {
  const { activeContainer, sourceContainer, sessionId, overId, place, stepPx, foldToggleClass } = args;
  const allTargetRows = collectVisibleRows(activeContainer);
  const isSameContainer = Boolean(sourceContainer && activeContainer.contains(sourceContainer));
  const otherRows = allTargetRows.filter((r) => r.getAttribute('data-session-id') !== sessionId);
  const srcIdx = isSameContainer
    ? allTargetRows.findIndex((r) => r.getAttribute('data-session-id') === sessionId)
    : -1;
  let targetIdx = otherRows.length;
  if (overId) {
    const matchIdx = otherRows.findIndex((r) => r.getAttribute('data-session-id') === overId);
    if (matchIdx >= 0) targetIdx = place === 'before' ? matchIdx : matchIdx + 1;
  }
  const offsets = computeRowShiftOffsets(otherRows.length, srcIdx, targetIdx, isSameContainer, stepPx);
  const nextShifted: HTMLElement[] = [];
  otherRows.forEach((row, i) => {
    applyRowShift(row, offsets[i]!);
    nextShifted.push(row);
  });
  // 跨分组拖拽时：原分组容器下的列表项向上补位收缩空洞，避免源与目标出现双空行
  if (!isSameContainer && sourceContainer) {
    nextShifted.push(...collapseSourceRows(sourceContainer, sessionId, stepPx, foldToggleClass));
  }
  return nextShifted;
}
