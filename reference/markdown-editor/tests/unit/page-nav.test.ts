/**
 * P2-A1 键盘增强（任务 3 验收）：PageUp/PageDown 翻页 + Ctrl+Home/End 文档首尾
 *
 * - pageNavigationTarget 纯函数（HiddenInput.tsx 导出）：视口顶/底行 ± 页行数
 *   的目标行计算（已挂载行几何 = HeightMap.indexAt 像素→行的 DOM 等价实现），
 *   覆盖各种视口位置/边界/空挂载；
 * - Ctrl+Home/End 的 store 层语义（HiddenInput 分支为 setCursorPos(0) /
 *   setCursorPos(textLength) 薄封装，此处验证落点与边界行为）。
 */
import { describe, it, expect } from 'vitest';
import { createEditorStore } from '../../src/core/EditorStore';
import {
  pageNavigationTarget,
  type MountedLineGeom,
} from '../../src/components/HiddenInput';

/** 构造连续挂载行几何：index 从 0 起、行高固定、top 从 baseTop 起 */
function rows(
  count: number,
  height: number,
  baseTop = 0
): MountedLineGeom[] {
  const out: MountedLineGeom[] = [];
  for (let i = 0; i < count; i++) {
    const top = baseTop + i * height;
    out.push({
      index: i,
      start: 0,
      length: 0,
      left: 0,
      top,
      bottom: top + height,
      height,
    });
  }
  return out;
}

/** 视口从某行开始（scrollTop 对齐行边界）时的挂载子集（虚拟化窗口） */
function viewportRows(
  all: MountedLineGeom[],
  fromIdx: number,
  toIdx: number
): MountedLineGeom[] {
  return all.filter((m) => m.index >= fromIdx && m.index <= toIdx);
}

describe('pageNavigationTarget（PageUp/PageDown 目标行计算）', () => {
  // 200 行、行高 28、scrollTop=2800 → 视口顶行 100，clientHeight 280 → 底行 109
  const all = rows(200, 28);

  it('PageDown：目标行 = 视口底行 + 页行数', () => {
    const mounted = viewportRows(all, 95, 110); // 视口覆盖 [95, 110]
    const target = pageNavigationTarget('down', 2800, 280, 200, mounted);
    // 视口顶行 = 第一个 bottom > 2800 的行 = 100（top 2800, bottom 2828）
    // 视口底行 = 最后一个 top < 3080 的行 = 109（top 3052 < 3080, bottom 3080）
    // 页行数 = 109 - 100 = 9 → 目标 109 + 9 = 118
    expect(target).toBe(118);
  });

  it('PageUp：目标行 = 视口顶行 − 页行数', () => {
    const mounted = viewportRows(all, 95, 110);
    const target = pageNavigationTarget('up', 2800, 280, 200, mounted);
    expect(target).toBe(100 - 9);
  });

  it('文档首：PageUp 收敛到 0（视口已在首屏）', () => {
    const mounted = viewportRows(all, 0, 10);
    // scrollTop 0：视口顶行 0，页行数 = 10 → max(0, 0-10) = 0
    expect(pageNavigationTarget('up', 0, 280, 200, mounted)).toBe(0);
  });

  it('文档尾：PageDown 收敛到 lineCount-1（视口已在末屏）', () => {
    const mounted = viewportRows(all, 190, 199);
    // 视口底行 199，页行数 = 9 → min(199, 199+9) = 199
    expect(pageNavigationTarget('down', 5320, 280, 200, mounted)).toBe(199);
  });

  it('行高不均匀（多行块）：页行数按顶底行号差近似，仍收敛', () => {
    // 混合行高：普通 28 + 代码块 84（3 倍高）
    const mixed: MountedLineGeom[] = [];
    let top = 0;
    for (let i = 0; i < 60; i++) {
      const h = i % 10 === 3 ? 84 : 28; // 每 10 行一个 3 倍高行
      mixed.push({ index: i, start: 0, length: 0, left: 0, top, bottom: top + h, height: h });
      top += h;
    }
    // scrollTop 840：顶行 = 第一个 bottom > 840 的行
    const target = pageNavigationTarget('up', 840, 560, 60, mixed);
    expect(target).toBeGreaterThanOrEqual(0);
    expect(target).toBeLessThanOrEqual(59);
  });

  it('边界：lineCount 0 / 挂载空 → 0', () => {
    expect(pageNavigationTarget('down', 0, 280, 0, [])).toBe(0);
    expect(pageNavigationTarget('up', 0, 280, 100, [])).toBe(0);
  });

  it('边界：scrollTop 处于两行之间（非对齐）时顶行取覆盖行', () => {
    const mounted = viewportRows(all, 10, 20);
    // scrollTop = 10*28 + 14 = 294（第 10 行中段）：第一个 bottom > 294 = 行 10；
    // 视口底 = 294 + 280 = 574：最后一个 top < 574 = 行 20 → 页行数 10
    // PageDown 目标 = 20 + 10 = 30
    expect(pageNavigationTarget('down', 294, 280, 200, mounted)).toBe(30);
  });
});

describe('Ctrl+Home / Ctrl+End 文档首尾（store 层等价语义）', () => {
  it('Ctrl+End：光标到 textLength（文档尾），Ctrl+Home：到 0（文档首）', () => {
    const store = createEditorStore();
    store.getState().setText('line1\nline2\nline3');
    // 注：getState() 每次取最新 state（store 方法经 dispatchSet 合并
    // 产生新 state，旧快照字段读取过时），统一重新取
    const textLen = store.getState().textLength;
    // Ctrl+End 分支等价操作：fastCursorMove(textLength) → setCursorPos
    store.getState().setCursorPos(textLen);
    expect(store.getState().cursorPos).toBe('line1\nline2\nline3'.length);
    expect(store.getState().selectionStart).toBe(store.getState().cursorPos);
    // Ctrl+Home 分支等价操作：fastCursorMove(0)
    store.getState().setCursorPos(0);
    expect(store.getState().cursorPos).toBe(0);
  });

  it('边界：空文档 Ctrl+Home/End 均落 0', () => {
    const store = createEditorStore();
    store.getState().setCursorPos(store.getState().textLength);
    expect(store.getState().cursorPos).toBe(0);
    store.getState().setCursorPos(0);
    expect(store.getState().cursorPos).toBe(0);
  });

  it('尾部换行文档：Ctrl+End 落在 textLength（末空行末尾）', () => {
    const store = createEditorStore();
    store.getState().setText('a\n');
    store.getState().setCursorPos(store.getState().textLength);
    expect(store.getState().cursorPos).toBe(2); // 'a\n' 长度 2
  });
});
