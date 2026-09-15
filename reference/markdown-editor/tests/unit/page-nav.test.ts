// @vitest-environment jsdom
/** 翻页按视口像素位移与权威 HeightMap 定位，字符落点另等原生 DOM 命中。 */
import { afterEach, describe, it, expect } from 'vitest';
import { createEditorStore } from '../../src/core/EditorStore';
import { pageDestination } from '../../src/core/editing/viewportNavigation';
import { viewportFixture, type ViewportFixture } from './viewport-fixture';

const fixtures: ViewportFixture[] = [];
function view(options: Parameters<typeof viewportFixture>[1] = {}) {
  const fixture = viewportFixture(Array(200).fill('abcdef').join('\n'), { height: 280, mounted: [], ...options });
  fixtures.push(fixture);
  return fixture;
}
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.dispose(); });

describe('PageUp/PageDown 真实视口目标', () => {
  it('PageDown 从光标所在视觉位置向下一屏，保留目标行内位置', () => {
    const fixture = view();
    fixture.container.scrollTop = 2800;
    expect(pageDestination(fixture.container, fixture.viewport, 154, 'down')).toEqual({
      line: 115, direction: 'down', withinLine: 14,
    });
  });

  it('PageUp 与向下翻页使用同一像素位移口径', () => {
    const fixture = view();
    fixture.container.scrollTop = 2800;
    expect(pageDestination(fixture.container, fixture.viewport, 154, 'up')).toEqual({
      line: 95, direction: 'up', withinLine: 14,
    });
  });

  it('文档首的上翻目标由高度表钳制到首行', () => {
    const fixture = view();
    expect(pageDestination(fixture.container, fixture.viewport, 14, 'up')?.line).toBe(0);
  });

  it('文档尾的下翻目标由高度表钳制到末行', () => {
    const fixture = view();
    fixture.container.scrollTop = 5320;
    expect(pageDestination(fixture.container, fixture.viewport, 266, 'down')?.line).toBe(199);
  });

  it('非均匀行高定位到确切目标，不再用顶底行号差估计页行数', () => {
    const fixture = view({ height: 560, heights: Array.from({ length: 200 }, (_, i) => i % 10 === 3 ? 84 : 28) });
    fixture.container.scrollTop = 840;
    expect(pageDestination(fixture.container, fixture.viewport, 100, 'up')).toEqual({
      line: 11, direction: 'up', withinLine: 16,
    });
  });

  it('没有挂载行也不虚构首行；没有视口高度则明确等待布局', () => {
    const fixture = view();
    fixture.container.scrollTop = 2800;
    expect(pageDestination(fixture.container, fixture.viewport, 154, 'up')?.line).toBe(95);
    const unavailable = view({ height: 0 });
    expect(pageDestination(unavailable.container, unavailable.viewport, 0, 'down')).toBeNull();
  });

  it('滚动处于行中间时仍保留像素位置，不额外多跳一屏', () => {
    const fixture = view();
    fixture.container.scrollTop = 294;
    expect(pageDestination(fixture.container, fixture.viewport, 0, 'down')).toEqual({
      line: 20, direction: 'down', withinLine: 14,
    });
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
