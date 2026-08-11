// tests/unit/stream-table-lock.test.ts
// W0-2（docs/streaming-render/00 流式渲染极致化总方案）：
// 修复「流式尾表提前锁宽」bug——流式会话进行中（streamOp !== null），
// 表格为文档尾段（nextLn === null）时不触发内容定型锁宽。
//
// 背景：表格定型 effect（MarkdownEngine.tsx 表格段，P3 B4）判定「表格
// 已闭合」的条件含 nextLn === null（表格是文档尾）——但流式尾段
// nextLn === null 是常态（后续 chunk 尚未到达），旧实现把「表格是流式
// 尾段」当成「表格已闭合」：分隔行+表头落库后的下一次 effect 运行即锁宽，
// 列宽锁死在表头一行的宽度，且 !tableWidths 守卫使真闭合后永不重定型。
//
// 覆盖（W0-2 验收断言 S-T-0-03 / S-T-0-06，R-1 断言演进表）：
// 1. S-T-0-03：流式会话中（streamAppend 驱动，streamOp 非空）表格为
//    尾段时，setTableWidths 不被调用（计数 0）——分隔行+表头落库、
//    数据行到达、表格仍为尾段期间全程 0（修复前 = 1，锁死表头宽）；
//    streamEnd（streamOp 置 null）后真闭合定型一次（计数 1）。
// 2. S-T-0-06：非流式（streamOp === null）闭合表格路径不变——普通
//    setText 后 effect 照常锁宽（含表格为文档尾的 nextLn === null 情形，
//    行为保持）。
//
// 挂载模式仿 display-completion / render-layer 测试：jsdom +
// FakeResizeObserver 收敛虚拟化窗口（视口 2000px，全部测试行入窗）+
// measure 模块 mock 固定坐标 + scrollWidth stub（jsdom 恒 0，锁宽测宽
// 依赖它——stub 为固定列宽使测宽循环确定性产出 [CELL_WIDTH, ...]）。
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import {
  MarkdownEngine,
  type MarkdownEngineHandle,
} from '../../src/components/MarkdownEngine';
import {
  createEditorStore,
  type EditorStore,
} from '../../src/core/EditorStore';
import { useTableStore } from '../../src/core/TableStore';

// measure 模块部分 mock（jsdom 无布局）：固定测量结果——display-completion
// 同款模式（BlockRenderer 依赖的渲染热路径保留真实实现）
vi.mock('../../src/core/measure', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/measure')>();
  return {
    ...actual,
    getCoordinatesFromIndex: () => ({
      top: 0,
      left: 0,
      height: 20,
      bottom: 20,
    }),
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
 * 同步回调的假 ResizeObserver——observe 时立即上报固定尺寸（2000×800，
 * 行高 28px → 约 71 行入窗，本文件 4-5 行文档全部挂载——锁宽扫描依赖
 * 分隔行入窗，视口必须覆盖表格全部行）。
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
          borderBoxSize: [{ blockSize: 2000, inlineSize: 800 }],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver
    );
  }
  unobserve() {}
  disconnect() {}
}

const mountedRoots: Root[] = [];

// jsdom 无布局：offsetHeight 恒 0 → 批量测量把行高回填为 0 → 零高行使
// tanstack 窗口范围膨胀（display-completion 同款收敛：实测 = 预测 → 稳定点
// 护栏跳过回填，测量立即收敛）
const REAL_ROW_HEIGHT = 28;
const origOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetHeight'
);
// jsdom 无布局：scrollWidth 恒 0 → 锁宽测宽循环 colWidths 恒空 →
// setTableWidths 永不触发，无法断言定型行为；stub 固定列宽，使测宽循环
// 确定性产出 [CELL_WIDTH, ...]（R-10 scrollWidth stub 协议方向）
const CELL_WIDTH = 100;
const origScrollWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollWidth'
);

// 真实 setTableWidths（模块加载时捕获；spy 委托它写入锁宽状态，
// afterEach 恢复原 action 防止跨文件污染）
const realSetTableWidths = useTableStore.getState().setTableWidths;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return REAL_ROW_HEIGHT;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return CELL_WIDTH;
    },
  });
  // 表格锁宽状态复位（用例间隔离）
  useTableStore.setState({ ...useTableStore.getState(), tableWidths: {} });
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
  if (origScrollWidth) {
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollWidth',
      origScrollWidth
    );
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)
      .scrollWidth;
  }
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // 恢复真实 setTableWidths + 清空锁宽状态
  useTableStore.setState({
    ...useTableStore.getState(),
    setTableWidths: realSetTableWidths,
    tableWidths: {},
  });
});

/** 安装 setTableWidths 计数 spy（委托真实实现，锁宽状态照常写入） */
function installLockSpy() {
  const spy = vi.fn((tableId: string, widths: number[]) => {
    realSetTableWidths(tableId, widths);
  });
  useTableStore.setState({ ...useTableStore.getState(), setTableWidths: spy });
  return spy;
}

describe('W0-2 流式尾表提前锁宽修复（S-T-0-03 / S-T-0-06）', () => {
  it('S-T-0-03 流式会话中表格为尾段：全程 setTableWidths 计数 0（不提前锁宽、不锁死表头宽）', () => {
    const spy = installLockSpy();
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    // 流式会话：表头 → 分隔行 → 数据行，全程表格为文档尾段
    // （chunk 含 \n 或 | → 常规 append 路径，streamOp 落账）
    act(() => {
      getHandle().streamAppend('\n| a | b |');
    });
    act(() => {
      getHandle().streamAppend('\n| --- | --- |');
    });
    act(() => {
      getHandle().streamAppend('\n| 1 | 2 |');
    });
    const s = store.getState();
    // 前置条件：流式会话进行中 + 表格确为文档尾段（nextLn === null 场景）
    expect(s.streamOp).not.toBeNull();
    expect(s.getLineCount()).toBe(4);
    expect(s.getLine(3)).toBe('| 1 | 2 |');
    expect(s.getLine(4)).toBeUndefined();
    // 修复断言：分隔行+表头落库、数据行到达后均未锁宽
    // （修复前：分隔行落库后下一次 effect 运行即锁 1 次，锁死在表头宽）
    expect(spy).toHaveBeenCalledTimes(0);
    expect(useTableStore.getState().tableWidths).toEqual({});
  });

  it('S-T-0-03b 流式会话结束（streamEnd → streamOp 置 null）后真闭合定型一次，测得全量行宽', () => {
    const spy = installLockSpy();
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    act(() => {
      getHandle().streamAppend('\n| a | b |');
    });
    act(() => {
      getHandle().streamAppend('\n| --- | --- |');
    });
    act(() => {
      getHandle().streamAppend('\n| 1 | 2 |');
    });
    // 流式期间不锁宽（S-T-0-03 语义）
    expect(spy).toHaveBeenCalledTimes(0);
    // streamEnd：flushStreamTail 合并尾段 + streamOp 置 null → deps 变化
    // → effect 重跑 → 表格为文档尾（nextLn === null）且非流式 → 正常定型
    act(() => {
      getHandle().streamEnd();
    });
    expect(store.getState().streamOp).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    // tableId = 首个 | 行 index（seed 占第 0 行，表头第 1 行 → table-1）
    expect(spy.mock.calls[0][0]).toBe('table-1');
    // 2 列表格：scrollWidth stub 固定列宽 → 逐列 max = [100, 100]
    expect(spy.mock.calls[0][1]).toEqual([CELL_WIDTH, CELL_WIDTH]);
    // 锁宽落库（spy 委托真实实现）
    expect(useTableStore.getState().tableWidths['table-1']).toEqual([
      CELL_WIDTH,
      CELL_WIDTH,
    ]);
  });

  it('S-T-0-06 非流式闭合表格路径不变：setText 后表格定型照常锁宽', () => {
    const spy = installLockSpy();
    const store = createEditorStore();
    // 非流式：整文一次性 setText（streamOp === null），表格后接正文行
    // （nextLn 为 body → 真闭合信号，非尾段占位）
    store.getState().setText('| a | b |\n| --- | --- |\n\n正文');
    mountEngine(store);
    expect(store.getState().streamOp).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    // tableId = 首个 | 行 index（表头第 0 行 → table-0）
    expect(spy.mock.calls[0][0]).toBe('table-0');
    expect(spy.mock.calls[0][1]).toEqual([CELL_WIDTH, CELL_WIDTH]);
    expect(useTableStore.getState().tableWidths['table-0']).toEqual([
      CELL_WIDTH,
      CELL_WIDTH,
    ]);
  });

  it('S-T-0-06b 非流式表格为文档尾（nextLn === null）：照常锁宽（行为保持）', () => {
    const spy = installLockSpy();
    const store = createEditorStore();
    // 非流式 + 表格为文档尾：nextLn === null 仍是闭合证据（非流式会话
    // 中无「后续 chunk 未到达」歧义）——W0-2 只修流式，此处行为不变
    store.getState().setText('| a | b |\n| --- | --- |');
    mountEngine(store);
    expect(store.getState().streamOp).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('table-0');
    expect(spy.mock.calls[0][1]).toEqual([CELL_WIDTH, CELL_WIDTH]);
  });
});
