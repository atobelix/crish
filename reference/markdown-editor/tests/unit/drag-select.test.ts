// tests/unit/drag-select.test.ts
// R4-G 拖选状态机测试（04 编辑深度扩展 §3.3 方案 3：CM6 MouseSelection 简化版）
//
// 覆盖（任务书五项）：
// 1. 起点：mousedown 记起点 → mousemove 超阈值（DRAG_THRESHOLD_PX）激活拖选，
//    锚点 = 按下位置定位的光标位（拖选起点 = 点击后光标位）；
// 2. 扩展：连续 mousemove 持续更新 head（store.moveHead），anchor 不动；
// 3. 反向拖选：head 越过 anchor 后选区翻转但方向保持（anchor/head 模型）；
// 4. 阈值区分点击/拖选：3px 内 mousemove 不激活（纯点击场景零副作用）；
// 5. 视口外估算：拖出可见区 → 边缘滚动步进 + 目标行未挂载时行几何估算
//    （R2-F 列保持思路复用）→ head 更新到估算位；
// 6. 跳过场景：表格 Excel 交互区 / composition 期间 / 已有 DOM 选区不接管；
// 7. Shift 方向键接线（R4-B 登记点）：Left/Right 走 extendSelectionByDirection、
//    Up/Down 走 moveHead（垂直扩展行级），反向扩展第二次方向正确。
// 纯几何函数（predictColumn / estimateLineIndexFromContentY / indexFromClientPoint）
// 直接单测；组件级 jsdom 序列模拟 mousedown/mousemove/mouseup。
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import { useEditorStore } from '../../src/core/EditorStore';
import { LineOffsetTree } from '../../src/core/SegmentTree';
import { getArrowNavigationIndex } from '../../src/core/measure';
import { viewportFixture, type ViewportFixture } from './viewport-fixture';
import { indexFromClientPoint } from '../../src/core/editorViewport';
import {
  HiddenInput,
  DRAG_THRESHOLD_PX,
} from '../../src/components/HiddenInput';

// measure 模块部分 mock：jsdom 无布局，固定测量结果（coords 恒非 null →
// textarea 渲染、拖选监听注册）；getGlobalIndexFromDOMNode 保留真实实现
// （拖选精确路径测试）；getArrowNavigationIndex 默认 null（Shift+Up/Down
// 测试内 vi.mocked 覆写）。
vi.mock('../../src/core/measure', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/measure')>();
  return {
    ...actual,
    getCoordinatesFromIndex: () => ({ top: 0, left: 0, height: 20, bottom: 20 }),
    toContainerCoords: (rect: {
      top: number;
      left: number;
      height: number;
    }) => ({
      top: rect.top,
      left: rect.left,
      height: rect.height,
      bottom: rect.height,
    }),
    getArrowNavigationIndex: vi.fn(() => null),
  };
});

// React 19 act 要求显式声明测试环境（与 ime-composition 测试同款）
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 重置 store 到初始单行空文档（与既有测试同款）
function resetStore() {
  useEditorStore.setState({
    lines: [''],
    lineOffsets: new LineOffsetTree([0]),
    codeBlockState: ['none'],
    textLength: 0,
    cursorPos: 0,
    selectionStart: 0,
    selectionEnd: 0,
    undoStack: [],
    redoStack: [],
  });
}

// —— DOM 构造辅助（jsdom 无布局：rect 显式注入）——

const ROW_HEIGHT = 28;
let mountedRoot: Root | null = null;
const activeFixtures: ViewportFixture[] = [];

function makeFixture(text: string, options: Parameters<typeof viewportFixture>[1] = {}) {
  const fixture = viewportFixture(text, options);
  activeFixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot!.unmount());
  mountedRoot = null;
  for (const fixture of activeFixtures.splice(0)) fixture.dispose();
  window.getSelection()?.removeAllRanges();
});

// 行高由真实 HeightMap 保存；浏览器命中与 DOM 映射使用明确的原生夹具。
function mountWithRows(text: string, mountCount?: number) {
  const count = mountCount ?? text.split('\n').length;
  const fixture = makeFixture(text, {
    store: useEditorStore, height: count * ROW_HEIGHT,
    mounted: Array.from({ length: count }, (_, index) => index),
  });
  const container = fixture.container;
  const host = document.createElement('div');
  container.append(host);
  const root = createRoot(host);
  mountedRoot = root;
  const containerRef = { current: container };
  let version = 0;
  const layout = () => act(() => root.render(React.createElement(HiddenInput, {
    containerRef, store: useEditorStore, layoutDeps: String(++version),
  })));
  layout();
  return { container, root, fixture, layout, getTextarea: () => host.querySelector('textarea')! };
}

// 不需要几何的键盘语义仍使用独立输入宿主。
function mountPlain() {
  return mountWithRows(useEditorStore.getState().getText());
}

// —— 鼠标事件派发辅助（mousedown 挂容器 / mousemove、mouseup 挂 window）——
function fireMouseDown(el: Element, x: number, y: number) {
  el.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    })
  );
}

function fireMouseMove(x: number, y: number) {
  window.dispatchEvent(
    new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    })
  );
}

function fireMouseUp(x: number, y: number) {
  window.dispatchEvent(
    new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    })
  );
}

function fireKeyDown(ta: HTMLTextAreaElement, key: string, shiftKey: boolean) {
  ta.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      shiftKey,
      bubbles: true,
      cancelable: true,
    })
  );
}

// 由文本行数组构造数据层（行 i 偏移 = 前缀累计，与 store 行偏移语义一致）

describe('R4-G 原生横向命中：保留原字宽场景的操作语义', () => {
  it('文字之前命中可见首端；编辑器之外不猜位置；空正文保留唯一边界', () => {
    const view = makeFixture('hello');
    view.fragments(0, [{ from: 0, to: 5, x: 30, y: 0, height: 28, stops: [0, 8.4, 16.8, 25.2, 33.6, 42] }]);
    expect(indexFromClientPoint(0, 14, view.container)).toBe(0);
    expect(indexFromClientPoint(-5, 14, view.container)).toBeNull();
    const empty = makeFixture('', { left: 600 });
    expect(indexFromClientPoint(610, 14, empty.container)).toBe(0);
  });

  it('ASCII 定位消费浏览器实际字符边界', () => {
    const view = makeFixture('hello');
    view.fragments(0, [{ from: 0, to: 5, x: 0, y: 0, height: 28, stops: [0, 8.4, 16.8, 25.2, 33.6, 42] }]);
    expect(indexFromClientPoint(8.4, 14, view.container)).toBe(1);
    expect(indexFromClientPoint(16.8, 14, view.container)).toBe(2);
    expect(indexFromClientPoint(17.8, 14, view.container)).toBe(2);
  });

  it('行内右侧空白命中行尾，越过编辑器边界则返回未命中', () => {
    const view = makeFixture('hello');
    expect(indexFromClientPoint(499, 14, view.container)).toBe(5);
    expect(indexFromClientPoint(50, 14, view.container)).toBe(5);
    expect(indexFromClientPoint(1000, 14, view.container)).toBeNull();
  });

  it('中文与拉丁混排由原生实际位置决定，不使用统一宽字符倍数', () => {
    const view = makeFixture('中a');
    view.fragments(0, [{ from: 0, to: 2, x: 0, y: 0, height: 28, stops: [0, 16.8, 25.2] }]);
    expect(indexFromClientPoint(16.8, 14, view.container)).toBe(1);
    expect(indexFromClientPoint(25.2, 14, view.container)).toBe(2);
    expect(indexFromClientPoint(8.4, 14, view.container)).toBe(0);
    expect(indexFromClientPoint(12, 14, view.container)).toBe(1);
  });

  it('Tab 的停靠由浏览器布局决定，不固定为四个字符前进量', () => {
    const view = makeFixture('a\tb');
    view.fragments(0, [{ from: 0, to: 3, x: 0, y: 0, height: 28, stops: [0, 8.4, 33.6, 42] }]);
    expect(indexFromClientPoint(8.4, 14, view.container)).toBe(1);
    expect(indexFromClientPoint(33.6, 14, view.container)).toBe(2);
  });
});

describe('R4-G 纵向定位：宿主 HeightMap 是唯一行号真源', () => {
  it('已挂载区间使用半开行盒，边界归属于下一行', () => {
    const view = makeFixture('a\nb\nc\nd\ne', { mounted: [0, 1, 2] });
    const at = view.viewport.lineAtClientY;
    expect([10, 28, 29, 35, 56, 83, 84].map(at)).toEqual([0, 1, 1, 1, 2, 2, 3]);
  });

  it('视口上方按权威偏移钳制到文档首行', () => {
    const view = makeFixture('a\nb\nc\nd\ne');
    expect(view.viewport.lineAtClientY(-14)).toBe(0);
    expect(view.viewport.lineAtClientY(-100)).toBe(0);
  });

  it('视口下方按完整行高表定位，不能从最后挂载行向外推算', () => {
    const view = makeFixture('a\nb\nc\nd\ne', { mounted: [0, 1, 2] });
    expect(view.viewport.lineAtClientY(200)).toBe(4);
    expect(view.viewport.lineAtClientY(112)).toBe(4);
    expect(view.viewport.lineAtClientY(84)).toBe(3);
    expect(view.viewport.lineAtClientY(500)).toBe(4);
  });

  it('非均匀行高的未挂载区间仍使用实际高度表', () => {
    const view = makeFixture(Array(10).fill('x').join('\n'), {
      heights: [10, 10, 56, 28, 20, 40, 16, 80, 12, 28], mounted: [2, 3],
    });
    expect(view.viewport.lineAtClientY(20)).toBe(2);
    expect(view.viewport.lineAtClientY(-10)).toBe(0);
    expect(view.viewport.lineAtClientY(200)).toBe(7);
  });

  it('无挂载行仍可定位目标行，但字符位置必须等待真实 DOM', () => {
    const view = makeFixture('a\nb\nc', { mounted: [] });
    expect(view.viewport.lineAtClientY(50)).toBe(1);
    expect(indexFromClientPoint(10, 50, view.container)).toBeNull();
    const empty = makeFixture('', { left: 600 });
    expect(empty.viewport.lineAtClientY(50)).toBe(0);
  });
});

describe('R4-G 坐标到源码：indexFromClientPoint', () => {
  it('原生命中直接映射 token 起始与节点边界', () => {
    const view = makeFixture('hello');
    expect(indexFromClientPoint(20, 14, view.container)).toBe(2);
    expect(view.viewport.flushPending).toHaveBeenCalledOnce();
  });

  it('原生命中缺失时返回 null，不把失败转换为猜出的源码位置', () => {
    const view = makeFixture('aaa\nbbb');
    vi.mocked((document as any).caretPositionFromPoint).mockReturnValue(null);
    expect(indexFromClientPoint(0, 42, view.container)).toBeNull();
  });

  it('真实挂载行的行首行尾和跨行命中保持准确', () => {
    const view = makeFixture('aaa\nbbb\nccc');
    expect(indexFromClientPoint(0, 42, view.container)).toBe(4);
    expect(indexFromClientPoint(100, 42, view.container)).toBe(7);
    expect(indexFromClientPoint(0, 14, view.container)).toBe(0);
    expect(indexFromClientPoint(0, 70, view.container)).toBe(8);
  });

  it('视口外没有原生命中时不制造末行行尾', () => {
    const view = makeFixture('aaa\nbbb\nccc');
    expect(indexFromClientPoint(100, 100, view.container)).toBeNull();
  });

  it('未挂载目标先无字符位置，挂载后同一坐标准确映射', () => {
    const view = makeFixture('aaa\nbbb\nccc\nddd', { mounted: [0, 1], height: 140 });
    expect(indexFromClientPoint(0, 98, view.container)).toBeNull();
    view.mount([0, 1, 3]);
    expect(indexFromClientPoint(0, 98, view.container)).toBe(12);
  });
});

describe('R4-G 拖选状态机（组件级 mousedown/mousemove/mouseup 序列）', () => {
  beforeEach(() => {
    resetStore();
    delete (document as any).caretRangeFromPoint;
  });

  afterEach(() => {
    if (mountedRoot) {
      act(() => {
        mountedRoot.unmount();
      });
      mountedRoot = null;
    }
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('起点 + 扩展：mousedown 定位锚点，mousemove 更新 head，anchor 不动', () => {
    const { container } = mountWithRows('aaa\nbbb\nccc');
    act(() => {
      fireMouseDown(container, 0, 42); // 行 1 左缘
    });
    act(() => {
      fireMouseMove(100, 42); // 超阈值 → 激活；行 1 行尾
    });
    let s = useEditorStore.getState();
    expect(s.anchorPos).toBe(4); // 拖选起点 = mousedown 位置（行 1 行首）
    expect(s.headPos).toBe(7); // 行 1 行尾（4+3）
    expect(s.cursorPos).toBe(7);
    expect(s.selectionStart).toBe(4);
    expect(s.selectionEnd).toBe(7);
    // 拖选期间原生选区抑制（引擎自绘高亮替代）
    expect(container.style.userSelect).toBe('none');
    // 连续扩展：行 2 行首
    act(() => {
      fireMouseMove(0, 70);
    });
    s = useEditorStore.getState();
    expect(s.anchorPos).toBe(4);
    expect(s.headPos).toBe(8);
    expect(s.selectionStart).toBe(4);
    expect(s.selectionEnd).toBe(8);
    // mouseup 结算：抑制解除
    act(() => {
      fireMouseUp(0, 70);
    });
    expect(container.style.userSelect).toBe('');
  });

  it('反向拖选：head 越过 anchor，选区翻转但方向保持', () => {
    const { container } = mountWithRows('aaa\nbbb\nccc');
    act(() => {
      fireMouseDown(container, 0, 42);
    });
    act(() => {
      fireMouseMove(100, 70); // 激活并扩展到行 2
    });
    let s = useEditorStore.getState();
    expect(s.anchorPos).toBe(4);
    expect(s.headPos).toBe(11); // 行 2 行尾
    // 反向拖回行 0
    act(() => {
      fireMouseMove(0, 14);
    });
    s = useEditorStore.getState();
    expect(s.anchorPos).toBe(4); // 锚点依旧固定
    expect(s.headPos).toBe(0);
    expect(s.cursorPos).toBe(0);
    expect(s.selectionStart).toBe(0);
    expect(s.selectionEnd).toBe(4);
    act(() => {
      fireMouseUp(0, 14);
    });
  });

  it('阈值区分点击/拖选：3px 内不激活（纯点击零副作用），超阈值激活', () => {
    const { container } = mountWithRows('aaa\nbbb\nccc');
    act(() => {
      fireMouseDown(container, 0, 42);
    });
    // 移动 ≤ 3px（dx²+dy² = 2 ≤ 9）：视为点击，store 无变化
    act(() => {
      fireMouseMove(1, 43);
    });
    let s = useEditorStore.getState();
    expect(s.cursorPos).toBe(0); // setText 后光标未动
    expect(s.selectionStart).toBe(0);
    expect(s.selectionEnd).toBe(0);
    expect(s.anchorPos).toBe(0);
    expect(container.style.userSelect).toBe('');
    // 超阈值（dx²+dy² = 10 > 9）：激活拖选
    act(() => {
      fireMouseMove(3, 43);
    });
    s = useEditorStore.getState();
    expect(s.anchorPos).toBe(4); // mousedown(0,42) 定位行 1 行首
    expect(s.headPos).toBe(4);
    expect(s.cursorPos).toBe(4);
    expect(container.style.userSelect).toBe('none');
    // 阈值常量：DRAG_THRESHOLD_PX = 3（与实现一致）
    expect(DRAG_THRESHOLD_PX).toBe(3);
    act(() => {
      fireMouseUp(3, 43);
    });
    expect(container.style.userSelect).toBe('');
  });

  it('视口外拖选等待权威目标挂载，释放鼠标后仍完成最后的真实命中', () => {
    const { container, fixture, layout } = mountWithRows(
      'aaa\nbbb\nccc\nddd\neee\nfff\nggg\nhhh\niii\njjj',
      3 // 只挂载前 3 行，其余视口外未挂载
    );
    act(() => {
      fireMouseDown(container, 0, 42); // 行 1 左缘
    });
    act(() => {
      fireMouseMove(0, 500); // 越出容器底（mock 高 84）
    });
    let s = useEditorStore.getState();
    // 当前没有目标 DOM，只保留锚点与待完成坐标，不跳到猜测的文档末行。
    expect(s.anchorPos).toBe(4);
    expect(s.headPos).toBe(4);
    expect(s.cursorPos).toBe(4);
    expect(s.selectionStart).toBe(4);
    expect(s.selectionEnd).toBe(4);
    expect(fixture.viewport.revealLine).toHaveBeenLastCalledWith(4);
    act(() => {
      fireMouseUp(0, 500);
    });
    expect(container.style.userSelect).toBe('');
    fixture.mount([1, 4]);
    layout();
    s = useEditorStore.getState();
    expect(s.anchorPos).toBe(4);
    expect(s.headPos).toBe(16);
    expect(s.selectionEnd).toBe(16);
  });

  it('视口上方拖选：边缘原生命中保持文档首行边界', () => {
    const { container } = mountWithRows('aaa\nbbb\nccc');
    act(() => {
      fireMouseDown(container, 0, 70); // 行 2
    });
    act(() => {
      fireMouseMove(0, -50); // 容器上方
    });
    const s = useEditorStore.getState();
    expect(s.anchorPos).toBe(8); // 行 2 行首
    expect(s.headPos).toBe(0); // clamp 到行 0
    expect(s.selectionStart).toBe(0);
    expect(s.selectionEnd).toBe(8);
    act(() => {
      fireMouseUp(0, -50);
    });
  });

  it('表格 Excel 交互区 mousedown 不接管', () => {
    const { container } = mountWithRows('aaa\nbbb\nccc');
    const tableRow = document.createElement('div');
    tableRow.className = 'line-table-row';
    container.appendChild(tableRow);
    act(() => {
      fireMouseDown(tableRow, 0, 42);
    });
    act(() => {
      fireMouseMove(100, 100);
    });
    let s = useEditorStore.getState();
    expect(s.cursorPos).toBe(0); // setText 后光标未动
    expect(s.selectionStart).toBe(0);
    expect(s.anchorPos).toBe(0);
    expect(container.style.userSelect).toBe('');
    act(() => {
      fireMouseUp(100, 100);
    });
    // 后续容器内拖选不受污染（状态未残留）
    act(() => {
      fireMouseDown(container, 0, 42);
    });
    act(() => {
      fireMouseMove(100, 70);
    });
    s = useEditorStore.getState();
    expect(s.anchorPos).toBe(4);
    expect(s.headPos).toBe(11);
    act(() => {
      fireMouseUp(100, 70);
    });
  });

  it('composition 期间 mousedown 不接管（R4-C IME 状态机）', () => {
    const { container, getTextarea } = mountWithRows('aaa\nbbb\nccc');
    act(() => {
      getTextarea().dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true })
      );
    });
    act(() => {
      fireMouseDown(container, 0, 42);
    });
    act(() => {
      fireMouseMove(100, 100);
    });
    const s = useEditorStore.getState();
    expect(s.cursorPos).toBe(0);
    expect(s.selectionStart).toBe(0);
    expect(s.anchorPos).toBe(0);
    expect(container.style.userSelect).toBe('');
    act(() => {
      fireMouseUp(100, 100);
    });
  });

  it('已有 DOM 文本选区时 mousedown 不接管（原生选区路径保留）', () => {
    const { container } = mountWithRows('aaa\nbbb\nccc');
    const textNode = document.createTextNode('fake-selection');
    container.appendChild(textNode);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    expect(sel?.toString()).toBe('fake');
    act(() => {
      fireMouseDown(container, 0, 42);
    });
    act(() => {
      fireMouseMove(100, 100);
    });
    const s = useEditorStore.getState();
    expect(s.cursorPos).toBe(0);
    expect(s.selectionStart).toBe(0);
    expect(s.anchorPos).toBe(0);
    act(() => {
      fireMouseUp(100, 100);
    });
  });
});

describe('R4-G Shift 方向键接线（R4-B 登记点）', () => {
  beforeEach(() => {
    resetStore();
    delete (document as any).caretRangeFromPoint;
  });

  afterEach(() => {
    if (mountedRoot) {
      act(() => {
        mountedRoot.unmount();
      });
      mountedRoot = null;
    }
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('Shift+Left：anchor 不动、head 左移（grapheme 粒度）', () => {
    mountPlain();
    act(() => {
      useEditorStore.getState().setText('Hello World');
      useEditorStore.getState().setSelection(3, 3);
    });
    const ta = document.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      fireKeyDown(ta, 'ArrowLeft', true);
    });
    let s = useEditorStore.getState();
    expect(s.anchorPos).toBe(3);
    expect(s.headPos).toBe(2);
    expect(s.selectionStart).toBe(2);
    expect(s.selectionEnd).toBe(3);
    act(() => {
      fireKeyDown(ta, 'ArrowLeft', true);
    });
    s = useEditorStore.getState();
    expect(s.anchorPos).toBe(3);
    expect(s.headPos).toBe(1);
    expect(s.selectionStart).toBe(1);
    expect(s.selectionEnd).toBe(3);
  });

  it('反向扩展第二次方向正确（R4-B 用例复用：Shift+Left ×2 后 Shift+Right）', () => {
    mountPlain();
    act(() => {
      useEditorStore.getState().setText('Hello World');
      useEditorStore.getState().setSelection(3, 3);
    });
    const ta = document.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      fireKeyDown(ta, 'ArrowLeft', true);
      fireKeyDown(ta, 'ArrowLeft', true);
    });
    let s = useEditorStore.getState();
    expect(s.anchorPos).toBe(3);
    expect(s.headPos).toBe(1);
    expect(s.selectionStart).toBe(1);
    expect(s.selectionEnd).toBe(3);
    // 反向第二次：head 1 → 2，anchor 仍 3——旧启发式（selectionStart ===
    // cursorPos ? newPos : selectionStart）在此场景会把 anchor 错设为 1
    act(() => {
      fireKeyDown(ta, 'ArrowRight', true);
    });
    s = useEditorStore.getState();
    expect(s.anchorPos).toBe(3);
    expect(s.headPos).toBe(2);
    expect(s.cursorPos).toBe(2);
    expect(s.selectionStart).toBe(2);
    expect(s.selectionEnd).toBe(3);
  });

  it('Shift+Right 扩展与文档边界幂等', () => {
    mountPlain();
    act(() => {
      useEditorStore.getState().setText('abc');
      useEditorStore.getState().setSelection(3, 3);
    });
    const ta = document.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      fireKeyDown(ta, 'ArrowRight', true); // 已到文末：空操作
    });
    const s = useEditorStore.getState();
    expect(s.anchorPos).toBe(3);
    expect(s.headPos).toBe(3);
  });

  it('Shift+Up/Down 垂直扩展：行级——head 移到目标行，anchor 保持', () => {
    const { getTextarea } = mountPlain();
    act(() => {
      useEditorStore.getState().setText('aaa\nbbb\nccc');
      useEditorStore.getState().setCursorPos(7); // 行 1 'bbb' 内
    });
    const ta = getTextarea();
    // 目标行行首（列保持由 getArrowNavigationIndex 完成，此处 mock 结果）
    vi.mocked(getArrowNavigationIndex).mockReturnValue(4); // 行 1 行首
    act(() => {
      fireKeyDown(ta, 'ArrowUp', true);
    });
    let s = useEditorStore.getState();
    expect(s.anchorPos).toBe(7);
    expect(s.headPos).toBe(4);
    expect(s.cursorPos).toBe(4);
    expect(s.selectionStart).toBe(4);
    expect(s.selectionEnd).toBe(7);
    // 反向：Shift+Down 到行 2 行首——anchor 依旧 7
    vi.mocked(getArrowNavigationIndex).mockReturnValue(8);
    act(() => {
      fireKeyDown(ta, 'ArrowDown', true);
    });
    s = useEditorStore.getState();
    expect(s.anchorPos).toBe(7);
    expect(s.headPos).toBe(8);
    expect(s.selectionStart).toBe(7);
    expect(s.selectionEnd).toBe(8);
  });

  it('无选区时 Shift+Up：anchor = 起点 = 光标，head 到目标行', () => {
    const { getTextarea } = mountPlain();
    act(() => {
      useEditorStore.getState().setText('aaa\nbbb\nccc');
      useEditorStore.getState().setCursorPos(7);
    });
    const ta = getTextarea();
    vi.mocked(getArrowNavigationIndex).mockReturnValue(0); // 行 0 行首
    act(() => {
      fireKeyDown(ta, 'ArrowUp', true);
    });
    const s = useEditorStore.getState();
    expect(s.anchorPos).toBe(7);
    expect(s.headPos).toBe(0);
    expect(s.selectionStart).toBe(0);
    expect(s.selectionEnd).toBe(7);
  });

  it('纯方向键（无 Shift）回归：移动光标并折叠选区', () => {
    const { getTextarea } = mountPlain();
    act(() => {
      useEditorStore.getState().setText('Hello World');
      useEditorStore.getState().setSelection(3, 8);
    });
    const ta = getTextarea();
    act(() => {
      fireKeyDown(ta, 'ArrowRight', false);
    });
    const s = useEditorStore.getState();
    expect(s.cursorPos).toBe(8);
    expect(s.anchorPos).toBe(8);
    expect(s.headPos).toBe(8);
    expect(s.selectionStart).toBe(8);
    expect(s.selectionEnd).toBe(8);
  });
});
