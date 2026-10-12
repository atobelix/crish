/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  collapseSourceRows,
  computeRowShiftOffsets,
} from './sessionListDragShift';

describe('computeRowShiftOffsets', () => {
  it('同容器向下拖：源与目标之间的行上移一格', () => {
    // 其余 4 行，源原在下标 1，目标插到下标 3
    expect(computeRowShiftOffsets(4, 1, 3, true, 31)).toEqual([0, -31, -31, 0]);
  });
  it('同容器向上拖：目标与源之间的行下移一格', () => {
    expect(computeRowShiftOffsets(4, 3, 1, true, 31)).toEqual([0, 31, 31, 0]);
  });
  it('同容器原位：不位移', () => {
    expect(computeRowShiftOffsets(3, 1, 1, true, 31)).toEqual([0, 0, 0]);
  });
  it('跨容器：目标位置及之后的行下移一格', () => {
    expect(computeRowShiftOffsets(3, -1, 1, false, 31)).toEqual([0, 31, 31]);
  });
  it('跨容器追加到末尾：不位移', () => {
    expect(computeRowShiftOffsets(2, -1, 2, false, 31)).toEqual([0, 0]);
  });
});

describe('collapseSourceRows', () => {
  it('源容器里找不到被拖拽行时不做任何位移', () => {
    const wrap = document.createElement('div');
    const ul = document.createElement('ul');
    wrap.appendChild(ul);
    const fold = document.createElement('div');
    fold.className = 'foldToggleRow';
    wrap.appendChild(fold);
    // jsdom 没有布局：行都不可见，所以原位置找不到，折叠行也不应被动
    expect(collapseSourceRows(ul, 's1', 31, 'foldToggleRow')).toEqual([]);
    expect(fold.style.transform).toBe('');
  });
});
