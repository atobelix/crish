/**
 * sessionDrag1DGeometry.ts — 1D 轴向同构动力学几何与纯数学位移引擎
 * 
 * 规范：X 轴（水平 TabStrip）与 Y 轴（垂直 SessionList）通用同构计算
 * 特征：纯函数、零副作用、双向对称守恒、1/3 滞后防抖
 */

export interface Axis1DItemSpan {
  id: string;
  start: number; // left (X) or top (Y)
  end: number;   // right (X) or bottom (Y)
  size: number;  // width (X) or height (Y)
  el?: HTMLElement;
}

/** 读取元素当前的 translateY 像素值 */
export function readTranslateY(el: HTMLElement): number {
  const tr = getComputedStyle(el).transform;
  if (!tr || tr === 'none') return 0;
  try {
    return new DOMMatrix(tr).m42 || 0;
  } catch {
    const m = /matrix\(([^)]+)\)/.exec(tr);
    if (!m?.[1]) return 0;
    const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
    return Number.isFinite(parts[5]) ? parts[5]! : 0;
  }
}

/** 读取元素当前的 translateX 像素值 */
export function readTranslateX(el: HTMLElement): number {
  const tr = getComputedStyle(el).transform;
  if (!tr || tr === 'none') return 0;
  try {
    return new DOMMatrix(tr).m41 || 0;
  } catch {
    const m = /matrix\(([^)]+)\)/.exec(tr);
    if (!m?.[1]) return 0;
    const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
    return Number.isFinite(parts[4]) ? parts[4]! : 0;
  }
}

export interface Compute1DOffsetsInput {
  /** 目标容器中现有项总数（已排除源项） */
  itemCount: number;
  /** 源项在目标容器内的原始下标；跨容器或从外部拖入时为 null */
  sourceIndex: number | null;
  /** 当前计算出的目标插入位置 (0 <= insertIndex <= itemCount) */
  insertIndex: number;
  /** 单个槽位的位移步长 (像素) S = size + gap */
  shiftStep: number;
}

/**
 * 纯数学 1D 位移向量计算函数（X/Y 轴同构闭环）
 * 
 * - 同列表内部重排序（sourceIndex !== null）：双向对称补偿
 *   - 向后拖动 (insertIndex > sourceIndex)：区间 [sourceIndex, insertIndex) 的项向前补位 (-shiftStep)
 *   - 向前拖动 (insertIndex < sourceIndex)：区间 [insertIndex, sourceIndex) 的项向后腾位 (+shiftStep)
 * - 跨列表/跨分区拖入（sourceIndex === null）：单向腾位
 *   - 区间 [insertIndex, itemCount) 的项统一向后腾位 (+shiftStep)
 *   - 末尾追加 (insertIndex === itemCount)：所有项位移恒为 0
 */
export function compute1DShiftOffsets(input: Compute1DOffsetsInput): number[] {
  const { itemCount, sourceIndex, insertIndex, shiftStep } = input;
  const offsets = new Array<number>(itemCount).fill(0);
  if (itemCount <= 0 || !Number.isFinite(shiftStep) || shiftStep <= 0) return offsets;

  const validInsert = Math.max(0, Math.min(insertIndex, itemCount));

  if (sourceIndex !== null && sourceIndex >= 0 && sourceIndex < itemCount + 1) {
    // 情况 A：同列表内部重排序（源项保留原位占位）
    if (validInsert > sourceIndex) {
      // 向后拖：中间被跨越的项目向前补位
      for (let i = sourceIndex; i < validInsert && i < itemCount; i++) {
        offsets[i] = -shiftStep;
      }
    } else if (validInsert < sourceIndex) {
      // 向前拖：中间被跨越的项目向后腾位
      for (let i = validInsert; i < sourceIndex && i < itemCount; i++) {
        offsets[i] = shiftStep;
      }
    }
  } else {
    // 情况 B：跨列表拖入（目标列表无源项占位）
    for (let i = validInsert; i < itemCount; i++) {
      offsets[i] = shiftStep;
    }
  }

  return offsets;
}

/** 方向感知型 1/3 滞后容差插入点解算 */
export function compute1DInsertIndex(
  items: readonly Axis1DItemSpan[],
  pointerPos: number,
  pointerDelta: number
): number {
  const count = items.length;
  if (count === 0) return 0;

  const first = items[0]!;
  if (pointerPos < first.start) return 0;

  const last = items[count - 1]!;
  if (pointerPos > last.end) return count;

  for (let i = 0; i < count; i++) {
    const item = items[i]!;
    if (pointerPos >= item.start && pointerPos <= item.end) {
      const size = Math.max(1, item.size);
      const thresholdRatio = 1 / 3;

      if (pointerDelta >= 0) {
        // 正向移动（向右/向下）：深入超过 1/3 则后插
        return pointerPos >= item.start + size * thresholdRatio ? i + 1 : i;
      } else {
        // 反向移动（向左/向上）：回退超过 1/3 则前插
        return pointerPos <= item.end - size * thresholdRatio ? i : i + 1;
      }
    }
  }

  return count;
}
