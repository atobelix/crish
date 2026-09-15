// tests/unit/render-layer.test.ts
// P3 B5（docs/analysis/plan-A5-渲染分层.md）渲染分层：L2 GPU 合成 + L3 Canvas 接缝
//
// 覆盖（任务书三项）：
// 1. GPU 合成层（L2，方案 B+C+D）：
//    - 方案 C：行容器 contain: paint——缺省行带 virtual-row-gpu 类；
//      useGpuLayer=false 一行回退（类退化为 virtual-row 单类）；
//    - CSS 契约静态断言：.virtual-row-gpu 含 contain: paint（护栏：不含
//      contain: size——size containment 破坏行高测量协议）、
//      .virtual-row-gpu-dirty 含 will-change: transform（jsdom 不解析
//      样式表求值，走 css-contract 同款静态文本断言口径）；
//    - 方案 B：tanstack transform 绝对定位接入核实——缺省模式下行
//      style.transform 写入 translate3d 绝对值（style.top 通道不写，
//      无双写叠加），useGpuLayer=false 回 position 模式写 style.top；
//    - 方案 D：直刷 dirty 行附加 virtual-row-gpu-dirty（独立合成层），
//      flush 后类移除（dirty 清除处同步移除 will-change，层销毁）；
// 2. renderMode 缺省零变化：data-render-mode 恒 'dom'；显式 'canvas'
//    意图 + 注册 + 超阈值 + readOnly → 标记切 canvas 但行仍走 DOM 渲染
//    （Canvas 未实现零行为变化，A5 §5.2 L3 验收口径）；
// 3. RowSurface 注册位存在性：register/unregister/get/create 可调用往返。
//
// 挂载模式仿 selection-protect 测试：jsdom + FakeResizeObserver 收敛
// 虚拟化窗口 + measure 模块 mock 固定坐标。
// @vitest-environment jsdom

import './helpers/layout-fixture';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import fs from 'fs';
import path from 'path';
import {
  MarkdownEngine,
  type MarkdownEngineHandle,
} from '../../src/components/MarkdownEngine';
import {
  createEditorStore,
  type EditorStore,
} from '../../src/core/EditorStore';
import { LineOffsetTree } from '../../src/core/SegmentTree';
import {
  createDomRowSurface,
  getRowSurfaceFactory,
  registerRowSurface,
  unregisterRowSurface,
} from '../../src/core/rowSurface';

// measure 模块部分 mock（jsdom 无布局）：固定测量结果——selection-protect
// 同款模式（BlockRenderer 依赖的渲染热路径保留真实实现）
vi.mock('../../src/core/measure', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/core/measure')
  >();
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
    getGlobalIndexFromDOMNode: () => null,
    getArrowNavigationIndex: () => null,
  };
});

// React 19 act 要求显式声明测试环境（与既有测试同款）
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom 无布局/无 ResizeObserver：虚拟化容器尺寸恒 0 → tanstack 的
 * calculateRange 以 outerSize === 0 直接返回 null，行永不渲染。注入
 * 同步回调的假 ResizeObserver——observe 时立即上报固定尺寸（600×800），
 * 使虚拟化窗口在 act 内收敛（selection-protect 同款）。
 */
class FakeResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    this.cb(
      [
        {
          target: el,
          borderBoxSize: [{ blockSize: 28, inlineSize: 800 }],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver
    );
  }
  unobserve() {}
  disconnect() {}
}

// —— 挂载生命周期管理（全部挂载实例 afterEach 统一卸载，防跨用例污染）——
const mountedRoots: Root[] = [];

// jsdom 无布局：offsetHeight 恒 0 → 批量测量把行高回填为 0 → 零高行使
// tanstack 窗口范围膨胀到全文档（虚拟化失效 + resizeItem 嵌套同步更新
// 爆栈）。按真实行高常量 stub 测量读值：实测 = 预测（28px）→ 稳定点
// 护栏（|Δ| < 0.5px）跳过回填，测量立即收敛——与真实浏览器同构
// （selection-protect 同款 FakeRO 收敛语义）。
const REAL_ROW_HEIGHT = 28;
const origOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetHeight'
);

// 每例前置：ResizeObserver stub + 行高测量 stub + 行表面注册表隔离
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return REAL_ROW_HEIGHT;
    },
  });
  unregisterRowSurface('dom');
  unregisterRowSurface('canvas');
});

function mountEngine(store: EditorStore, props: Record<string, unknown> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  let handle: MarkdownEngineHandle | null = null;
  act(() => {
    root.render(
      React.createElement(MarkdownEngine, {
        store,
        ref: (r: MarkdownEngineHandle | null) => {
          handle = r;
        },
        ...props,
      })
    );
  });
  return { container, getHandle: () => handle! };
}

afterEach(() => {
  for (const r of mountedRoots) {
    act(() => r.unmount());
  }
  mountedRoots.length = 0;
  document.body.innerHTML = '';
  // 还原行高测量读值（恢复原型链原有描述符）
  if (origOffsetHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      'offsetHeight',
      origOffsetHeight
    );
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)
      .offsetHeight;
  }
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// 行容器取数（data-index 定位，行高模型回填前 index 即稳定）
function rowEl(container: HTMLElement, index: number): HTMLElement {
  return container.querySelector(
    `[data-index="${index}"]`
  ) as HTMLElement;
}

// CSS 契约静态文本（jsdom 不解析样式表求值——css-contract 同款口径）
const INDEX_CSS = fs.readFileSync(
  path.resolve(__dirname, '../../src/index.css'),
  'utf-8'
);

describe('P3 B5 GPU 合成层（L2：方案 B+C+D）', () => {
  it('1a 方案 C：缺省行带 virtual-row-gpu（contain: paint 类，全员开启）', () => {
    const store = createEditorStore();
    store.getState().setText('alpha\nbeta\ngamma');
    const { container } = mountEngine(store);
    const rows = container.querySelectorAll('.virtual-row');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.className).toContain('virtual-row-gpu');
    }
  });

  it('1b 一行回退：useGpuLayer=false → 行类退化为 virtual-row 单类', () => {
    const store = createEditorStore();
    store.getState().setText('alpha\nbeta\ngamma');
    const { container } = mountEngine(store, { useGpuLayer: false });
    const rows = container.querySelectorAll('.virtual-row');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.className).not.toContain('virtual-row-gpu');
      expect(r.className).not.toContain('virtual-row-gpu-dirty');
    }
  });

  it('1c CSS 契约静态断言：contain: paint 存在、contain: size 护栏、dirty 行 will-change 存在', () => {
    // .virtual-row-gpu 规则块：含 contain: paint，且严禁 contain: size
    // （size containment 使行盒尺寸脱离内容，直接破坏行高测量协议与
    // oracle 校准——A5 §2.3 风险，零容忍）
    const gpuBlock = INDEX_CSS.match(/\.virtual-row-gpu\s*\{([^}]*)\}/);
    expect(gpuBlock).not.toBeNull();
    expect(gpuBlock![1]).toContain('contain: paint');
    expect(gpuBlock![1]).not.toContain('size');
    // .virtual-row-gpu-dirty 规则块：will-change: transform 独立合成层
    const dirtyBlock = INDEX_CSS.match(/\.virtual-row-gpu-dirty\s*\{([^}]*)\}/);
    expect(dirtyBlock).not.toBeNull();
    expect(dirtyBlock![1]).toContain('will-change: transform');
  });

  it('1d 方案 B 接入核实：缺省 transform 模式写 translate3d 绝对值、top 通道不写（无双写叠加）', () => {
    const store = createEditorStore();
    store.getState().setText('alpha\nbeta');
    const { container } = mountEngine(store);
    // 行位置经 tanstack directDomUpdates transform 模式命令式写入：
    // translate3d(0, start, 0) 绝对值（A5 §2.2 与 react-virtual esm
    // applyDirectStyles 核实：transform/position 二选一互斥，绝不同写）
    const row = rowEl(container, 0);
    expect(row.style.transform).toContain('translate3d(0, 0px, 0)');
    expect(row.style.top).toBe('');
    // 第二行位置 = 首行高——jsdom 无布局（offsetHeight 恒 0），高度数值
    // 不可断言；以「绝对像素值」形态断言（非增量 delta、非空 translate）
    const row1 = rowEl(container, 1);
    expect(row1.style.transform).toMatch(/^translate3d\(0, \d+px, 0\)$/);
    expect(row1.style.top).toBe('');
  });

  it('1e 方案 B 回退：useGpuLayer=false 回 position 模式写 style.top（transform 通道不写）', () => {
    const store = createEditorStore();
    store.getState().setText('alpha\nbeta');
    const { container } = mountEngine(store, { useGpuLayer: false });
    const row = rowEl(container, 0);
    expect(row.style.top).toBe('0px');
    expect(row.style.transform).toBe('');
  });

  it('1f 方案 D：直刷 dirty 行附加 virtual-row-gpu-dirty，flush 后类移除（will-change 同步销毁）', () => {
    const store = createEditorStore();
    store.getState().setText('hello');
    const { container, getHandle } = mountEngine(store);

    act(() => {
      getHandle().streamAppend(' world');
    });
    // 直刷证据：store 滞后、DOM 已直写（selection-protect 同款断言）
    expect(store.getState().getText()).toBe('hello');
    expect(
      container.querySelector('[data-token-start]')?.textContent
    ).toBe('hello world');
    // dirty 是渲染期属性（直刷命令式写 DOM 不触发 React 渲染）：强制
    // 重渲染暴露标记 + 独立合成层类（模拟直刷期间光标移动的场景）
    act(() => {
      store.getState().setCursorPos(1);
    });
    const dirtyRow = rowEl(container, 0);
    expect(dirtyRow.getAttribute('data-streaming-dirty')).toBe('true');
    expect(dirtyRow.className).toContain('virtual-row-gpu-dirty');
    // 非 dirty 行不带独立层类（独立层仅限 dirty 行，dirtyRefs 恒 ≤ 1）
    expect(dirtyRow.className).toContain('virtual-row-gpu');

    // flush 收口：dirty 清除处同步移除 will-change（类移除 → 层销毁），
    // 行退回 contain: paint 常规 GPU 态
    act(() => {
      getHandle().flushStream();
    });
    expect(container.querySelector('[data-streaming-dirty]')).toBeNull();
    expect(dirtyRow.className).not.toContain('virtual-row-gpu-dirty');
    expect(dirtyRow.className).toContain('virtual-row-gpu');
    expect(store.getState().getText()).toBe('hello world');
  });
});

describe('P3 B5 Canvas 预留接缝（L3：renderMode + RowSurface）', () => {
  it('2a renderMode 缺省 dom：data-render-mode 恒 dom（默认零行为变化）', () => {
    const store = createEditorStore();
    store.getState().setText('alpha\nbeta');
    const { container } = mountEngine(store);
    expect(
      container.querySelector('[data-render-mode]')?.getAttribute(
        'data-render-mode'
      )
    ).toBe('dom');
  });

  it('2b canvas 意图未注册 → 回落 dom（Canvas 未实现时登记语义，DOM 回退兜底）', () => {
    const store = createEditorStore();
    store.getState().setText('alpha\nbeta');
    // readOnly + 显式 canvas 意图，但注册表空 → 回落 dom
    const { container } = mountEngine(store, {
      readOnly: true,
      renderMode: 'canvas',
    });
    expect(
      container.querySelector('[data-render-mode]')?.getAttribute(
        'data-render-mode'
      )
    ).toBe('dom');
  });

  it('2c 全条件满足（readOnly + 超阈值 + 已注册）→ 标记切 canvas 但行仍 DOM 渲染（零行为变化）', () => {
    const store = createEditorStore();
    // 5 万行以上（A5 §3.1 建议阈值，CANVAS_LINE_COUNT_THRESHOLD = 50_000）。
    // 注意：setText 超 1000 行走分块加载路径（异步分批，FIRST_CHUNK_LINES），
    // 单元测试直接经 setState 构造双段存储形态（mainLines + LineOffsetTree），
    // 与 store 初始化路径（EditorStore.ts:1595）同构、行数精确可控。
    const N = 50_001;
    store.setState({
      mainLines: new Array(N).fill('a'),
      streamTail: [],
      mainCodeState: new Array(N).fill('none'),
      streamTailCodeState: [],
      mainFenceLines: [],
      streamTailFenceLines: [],
      lineOffsets: new LineOffsetTree(new Array(N).fill(1)),
      textLength: N * 2 - 1,
      cursorPos: 0,
      selectionStart: 0,
      selectionEnd: 0,
      anchorPos: 0,
      headPos: 0,
      assoc: 'before',
      undoStack: [],
      redoStack: [],
      changeLog: [],
      version: 0,
      streamOp: null,
      lastUserEditTime: 0,
    });
    expect(store.getState().getLineCount()).toBe(N);
    registerRowSurface('canvas', () =>
      createDomRowSurface(document.createElement('div'))
    );
    const { container } = mountEngine(store, {
      readOnly: true,
      renderMode: 'canvas',
    });
    expect(
      container.querySelector('[data-render-mode]')?.getAttribute(
        'data-render-mode'
      )
    ).toBe('canvas');
    // Canvas 未实现：行渲染仍走 LineItem DOM 通道（行为零变化，不崩）
    const rows = container.querySelectorAll('.virtual-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rowEl(container, 0).className).toContain('virtual-row-gpu');
  });

  it('3a RowSurface 注册位存在性：register/unregister/get/create 往返可调用', () => {
    const factory = () =>
      createDomRowSurface(document.createElement('div'));
    expect(getRowSurfaceFactory('canvas')).toBeNull();
    registerRowSurface('canvas', factory);
    expect(getRowSurfaceFactory('canvas')).toBe(factory);
    // 注册后引擎判定可消费（readOnly + 超阈值 → canvas，与 2c 同链路）
    expect(
      getRowSurfaceFactory('canvas')!(document.createElement('div')).mode
    ).toBe('dom');
    unregisterRowSurface('canvas');
    expect(getRowSurfaceFactory('canvas')).toBeNull();
  });
});
