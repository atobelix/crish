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
import {
  HiddenInput,
  indexFromClientPoint,
  estimateLineIndexFromContentY,
  predictColumn,
  DRAG_THRESHOLD_PX,
  type IndexDataLayer,
  type MountedLineGeom,
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

// 行元素：data-* 定位属性 + 视口坐标 rect mock
function makeRow(index: number, start: number, length: number, top: number) {
  const el = document.createElement('div');
  el.setAttribute('data-index', String(index));
  el.setAttribute('data-line-start', String(start));
  el.setAttribute('data-line-length', String(length));
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top,
      left: 0,
      right: 500,
      bottom: top + ROW_HEIGHT,
      height: ROW_HEIGHT,
      width: 500,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }),
  });
  return el;
}

// 容器 rect mock（视口坐标：top/left 为 0，高度 = 已挂载行总高）
function mockContainerRect(el: HTMLElement, height: number) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top: 0,
      left: 0,
      right: 500,
      bottom: height,
      height,
      width: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

// 当前测试挂载的 React root（afterEach 必须 unmount——否则组件监听器
// （window mousemove/mouseup）残留触发旧组件 setState，产生 act 警告与
// 状态污染）
let mountedRoot: Root | null = null;

// 挂载 HiddenInput 到 body 下容器（containerRef 指向该容器），并构造前 n 行
// 的挂载行 DOM（rect mock 注入几何；其余行视为虚拟化视口外未挂载）。
// 显式设 fontSize=14px 使列预测字宽确定（14 × 0.6 = 8.4 等宽）。
function mountWithRows(text: string, mountCount?: number) {
  const lines = text.split('\n');
  const n = mountCount ?? lines.length;
  const container = document.createElement('div');
  container.style.fontSize = '14px';
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  mountedRoot = root;
  const containerRef = {
    current: container,
  } as React.RefObject<HTMLDivElement | null>;
  act(() => {
    root.render(React.createElement(HiddenInput, { containerRef }));
  });
  act(() => {
    useEditorStore.getState().setText(text);
  });
  let offset = 0;
  for (let i = 0; i < n; i++) {
    container.appendChild(makeRow(i, offset, lines[i].length, i * ROW_HEIGHT));
    offset += lines[i].length + 1;
  }
  mockContainerRect(container, n * ROW_HEIGHT);
  return {
    container,
    root,
    getTextarea: () =>
      container.querySelector('textarea') as HTMLTextAreaElement,
  };
}

// 不构造行 DOM 的简单挂载（Shift 接线等不依赖行几何的用例）
function mountPlain() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  mountedRoot = root;
  const containerRef = {
    current: container,
  } as React.RefObject<HTMLDivElement | null>;
  act(() => {
    root.render(React.createElement(HiddenInput, { containerRef }));
  });
  return {
    container,
    root,
    getTextarea: () =>
      container.querySelector('textarea') as HTMLTextAreaElement,
  };
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
function makeDataLayer(lines: string[]): IndexDataLayer {
  const lengths = lines.map((l) => l.length + 1);
  return {
    getLine: (i: number) => lines[i],
    getLineCount: () => lines.length,
    lineOffsets: new LineOffsetTree(lengths),
  };
}

describe('R4-G 拖选纯几何：predictColumn（R2-F 列保持复用）', () => {
  const W = { ascii: 8.4, cjk: 16.8 };

  it('relX ≤ 0 回行首；空行回行首', () => {
    expect(predictColumn('hello', 0, W)).toBe(0);
    expect(predictColumn('hello', -5, W)).toBe(0);
    expect(predictColumn('', 10, W)).toBe(0);
  });

  it('等宽 ASCII：按累加宽度逼近最近列', () => {
    expect(predictColumn('hello', 8.4, W)).toBe(1);
    expect(predictColumn('hello', 8.4 * 2, W)).toBe(2);
    expect(predictColumn('hello', 8.4 * 2 + 1, W)).toBe(2);
  });

  it('超出行宽回行尾', () => {
    expect(predictColumn('hello', 1000, W)).toBe(5);
    expect(predictColumn('hello', 8.4 * 5, W)).toBe(5);
  });

  it('全角混排：全角占 2 倍宽但计 1 列', () => {
    // '中a'：中 = 16.8（2 列宽但 1 列位）、a = 8.4
    expect(predictColumn('中a', 16.8, W)).toBe(1); // '中' 之后
    expect(predictColumn('中a', 16.8 + 8.4, W)).toBe(2); // 行尾
    expect(predictColumn('中a', 8.4, W)).toBe(0); // 等距归前（p=0 dist 与 p=1 相等）
    expect(predictColumn('中a', 12, W)).toBe(1); // 偏向 '中' 后侧
  });

  it('Tab 按 4 倍等宽近似', () => {
    expect(predictColumn('a\tb', 8.4, W)).toBe(1);
    expect(predictColumn('a\tb', 8.4 + 4 * 8.4, W)).toBe(2);
  });
});

describe('R4-G 拖选纯几何：estimateLineIndexFromContentY（视口内命中 + 视口外估算）', () => {
  const mounted3: MountedLineGeom[] = [
    { index: 0, start: 0, length: 3, left: 0, top: 0, bottom: 28, height: 28 },
    { index: 1, start: 4, length: 3, left: 0, top: 28, bottom: 56, height: 28 },
    { index: 2, start: 8, length: 3, left: 0, top: 56, bottom: 84, height: 28 },
  ];

  it('视口内：命中包含 Y 的行（分界线归上侧行）', () => {
    expect(estimateLineIndexFromContentY(10, 5, mounted3)).toBe(0);
    expect(estimateLineIndexFromContentY(28, 5, mounted3)).toBe(0); // 行 0 底边
    expect(estimateLineIndexFromContentY(29, 5, mounted3)).toBe(1);
    expect(estimateLineIndexFromContentY(35, 5, mounted3)).toBe(1);
    expect(estimateLineIndexFromContentY(56, 5, mounted3)).toBe(1); // 行 1 底边
    expect(estimateLineIndexFromContentY(83, 5, mounted3)).toBe(2);
    expect(estimateLineIndexFromContentY(84, 5, mounted3)).toBe(2); // 行 2 底边
  });

  it('视口上方：首行几何向上推算，clamp 到 0', () => {
    expect(estimateLineIndexFromContentY(-14, 5, mounted3)).toBe(0);
    expect(estimateLineIndexFromContentY(-100, 5, mounted3)).toBe(0);
  });

  it('视口下方：末行几何向下推算（虚拟化断选修复），clamp 到 lineCount-1', () => {
    // Y=200：below = floor((200-84)/28) = 4 → 2+4 = 6 → clamp 4（lineCount 5）
    expect(estimateLineIndexFromContentY(200, 5, mounted3)).toBe(4);
    // Y=112：below = floor(28/28) = 1 → 3
    expect(estimateLineIndexFromContentY(112, 5, mounted3)).toBe(3);
    // Y=84 边界：below = 0 → 2
    expect(estimateLineIndexFromContentY(84, 5, mounted3)).toBe(2);
    // 大文档 10 行：Y=500 → below = 14 → 2+14 = 16 → clamp 9
    expect(estimateLineIndexFromContentY(500, 10, mounted3)).toBe(9);
  });

  it('多行块行高差异：按边界行实际高估算（滚动后精确命中接管）', () => {
    const multi: MountedLineGeom[] = [
      { index: 2, start: 8, length: 3, left: 0, top: 0, bottom: 56, height: 56 },
      { index: 3, start: 12, length: 3, left: 0, top: 56, bottom: 84, height: 28 },
    ];
    expect(estimateLineIndexFromContentY(20, 10, multi)).toBe(2);
    expect(estimateLineIndexFromContentY(-10, 10, multi)).toBe(1); // 高 56 → 向上 1 行
    expect(estimateLineIndexFromContentY(200, 10, multi)).toBe(7); // 3+floor(116/28)
  });

  it('边界：无已挂载行 / 空文档回退 0', () => {
    expect(estimateLineIndexFromContentY(50, 5, [])).toBe(0);
    expect(estimateLineIndexFromContentY(50, 0, mounted3)).toBe(0);
  });
});

describe('R4-G 坐标 → 索引：indexFromClientPoint', () => {
  afterEach(() => {
    delete (document as any).caretRangeFromPoint;
    document.body.innerHTML = '';
  });

  it('精确路径：caretRangeFromPoint 命中 → token 起始 + 节点内偏移', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mockContainerRect(container, ROW_HEIGHT);
    const row = makeRow(0, 0, 5, 0);
    const token = document.createElement('span');
    token.setAttribute('data-token-start', '0');
    token.setAttribute('data-token-length', '5');
    const textNode = document.createTextNode('hello');
    token.appendChild(textNode);
    row.appendChild(token);
    container.appendChild(row);

    const range = document.createRange();
    range.setStart(textNode, 2);
    range.collapse(true);
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => range,
    });

    const data = makeDataLayer(['hello']);
    expect(indexFromClientPoint(10, 10, container, data)).toBe(2);
  });

  it('精确路径返回 null 时回退几何（防御：命中测试失败不抛错）', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mockContainerRect(container, ROW_HEIGHT * 3);
    for (let i = 0; i < 3; i++) {
      container.appendChild(makeRow(i, i * 4, 3, i * ROW_HEIGHT));
    }
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => null,
    });
    const data = makeDataLayer(['aaa', 'bbb', 'ccc']);
    expect(indexFromClientPoint(0, 42, container, data)).toBe(4);
  });

  it('几何回退（无布局环境/未命中）：视口内行命中 + 列预测', () => {
    const container = document.createElement('div');
    container.style.fontSize = '14px';
    document.body.appendChild(container);
    mockContainerRect(container, ROW_HEIGHT * 3);
    for (let i = 0; i < 3; i++) {
      container.appendChild(makeRow(i, i * 4, 3, i * ROW_HEIGHT));
    }
    const data = makeDataLayer(['aaa', 'bbb', 'ccc']);
    // 行 1 行首（relX 0 → 列 0）
    expect(indexFromClientPoint(0, 42, container, data)).toBe(4);
    // 行 1 行尾（clientX 100 超行宽 25.2 → 列 3）
    expect(indexFromClientPoint(100, 42, container, data)).toBe(7);
    // 行 0
    expect(indexFromClientPoint(0, 14, container, data)).toBe(0);
    // 行 2 行首
    expect(indexFromClientPoint(0, 70, container, data)).toBe(8);
  });

  it('几何回退：视口外（容器下方）估算末行行尾', () => {
    const container = document.createElement('div');
    container.style.fontSize = '14px';
    document.body.appendChild(container);
    mockContainerRect(container, ROW_HEIGHT * 3);
    for (let i = 0; i < 3; i++) {
      container.appendChild(makeRow(i, i * 4, 3, i * ROW_HEIGHT));
    }
    const data = makeDataLayer(['aaa', 'bbb', 'ccc']);
    // Y=100 超容器底 84 → 末行（行 2）；clientX 100 → 列 3 → 8+3=11（文末）
    expect(indexFromClientPoint(100, 100, container, data)).toBe(11);
  });

  it('未挂载行（视口外目标）：行几何估算到行首', () => {
    const container = document.createElement('div');
    container.style.fontSize = '14px';
    document.body.appendChild(container);
    mockContainerRect(container, ROW_HEIGHT * 3);
    for (let i = 0; i < 3; i++) {
      container.appendChild(makeRow(i, i * 4, 3, i * ROW_HEIGHT));
    }
    const data = makeDataLayer(['aaa', 'bbb', 'ccc', 'ddd']);
    // 行 3 未挂载：Y=100 → below = 0 → 末行 2；Y=140 → below = 2 → 行 3
    expect(indexFromClientPoint(0, 140, container, data)).toBe(12);
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

  it('视口外拖选：边缘滚动步进 + 行几何估算（虚拟化断选修复）', () => {
    const { container } = mountWithRows(
      'aaa\nbbb\nccc\nddd\neee\nfff\nggg\nhhh\niii\njjj',
      3 // 只挂载前 3 行，其余视口外未挂载
    );
    act(() => {
      fireMouseDown(container, 0, 42); // 行 1 左缘
    });
    act(() => {
      fireMouseMove(0, 500); // 越出容器底（mock 高 84）
    });
    const s = useEditorStore.getState();
    // 锚点 = mousedown 位置（行 1 行首 4）；head = 估算末行行首（行 9 → 4×9）
    expect(s.anchorPos).toBe(4);
    expect(s.headPos).toBe(36);
    expect(s.cursorPos).toBe(36);
    expect(s.selectionStart).toBe(4);
    expect(s.selectionEnd).toBe(36);
    act(() => {
      fireMouseUp(0, 500);
    });
    expect(container.style.userSelect).toBe('');
  });

  it('视口上方拖选：向上估算 clamp 到文档首行', () => {
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
