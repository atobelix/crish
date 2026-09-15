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
// R-1 断言演进（00 总方案 §4.3，W1-3 落地后）：
// - S-T-0-03 语义限定为「分隔行**到达前**」计数 = 0（W0-2 修复核心保留：
//   无结构证据不锁宽、不锁死表头宽）；分隔行落库后锁宽计数 = 1 属
//   S-T-1-05（结构定型即锁，stream-table-structure-lock.test.ts）；
// - S-T-0-03b（streamEnd 后真闭合定型一次）在 W1-3 下流式期间若已提交
//   则锁宽已发生（分隔行落库帧），streamEnd 后因已锁不重测，计数保持。
//
// 覆盖（W0-2 验收断言 S-T-0-03 / S-T-0-06，R-1 断言演进表）：
// 1. S-T-0-03：流式会话中（streamAppend 驱动，streamOp 非空）分隔行
//    到达前 setTableWidths 计数 0（修复前 = 1，锁死表头宽）；分隔行
//    落库后计数 1（S-T-1-05 同语义的演进过渡验证）。
// 2. S-T-0-03b：非流式闭合路径不变——streamEnd（streamOp 置 null）后
//    表格闭合定型一次（计数 1），测得全量行宽。
// 3. S-T-0-06：非流式（streamOp === null）闭合表格路径不变——普通
//    setText 后 effect 照常锁宽（含表格为文档尾的 nextLn === null 情形，
//    行为保持）。
//
// 挂载模式仿 display-completion / render-layer 测试：jsdom +
// FakeResizeObserver 收敛虚拟化窗口（视口 2000px，全部测试行入窗）+
// measure 模块 mock 固定坐标 + scrollWidth stub（jsdom 恒 0，锁宽测宽
// 依赖它——stub 为固定列宽使测宽循环确定性产出 [CELL_WIDTH, ...]）。
// @vitest-environment jsdom

import './helpers/layout-fixture';
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
import { stubScrollWidth } from './helpers/test-env';

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
// 确定性产出 [CELL_WIDTH, ...]（R-10 scrollWidth stub 协议，统一走
// helpers/test-env 的 stubScrollWidth——beforeEach 安装、afterEach 恢复）
const CELL_WIDTH = 100;
let restoreScrollWidth: () => void = () => {};

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
  restoreScrollWidth = stubScrollWidth(() => CELL_WIDTH);
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
  restoreScrollWidth();
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
  it('S-T-0-03 流式会话中分隔行到达前：setTableWidths 计数 0（R-1 演进语义限定）', () => {
    const spy = installLockSpy();
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    // 流式会话：表头行落库（分隔行未到达——无表格结构证据，不得锁宽；
    // W0-2 修复核心保留：流式尾段 nextLn === null 不触发提前锁宽）
    act(() => {
      getHandle().streamAppend('\n| a | b |');
    });
    // W1-1（D-4）：降级 chunk 入帧聚合缓冲——断言前显式 flush 提交
    act(() => {
      getHandle().flushStream();
    });
    const s = store.getState();
    // 前置条件：流式会话进行中 + 表格确为文档尾段（nextLn === null 场景）
    expect(s.streamOp).not.toBeNull();
    expect(s.getLineCount()).toBe(2);
    expect(s.getLine(1)).toBe('| a | b |');
    expect(s.getLine(2)).toBeUndefined();
    // R-1 断言演进（docs/streaming-render/00 §4.3）：W1-3 落地后 S-T-0-03
    // 语义限定为「分隔行到达前」计数 0（修复前 = 1——旧实现把流式尾段
    // 当闭合即锁，锁死在表头宽）
    expect(spy).toHaveBeenCalledTimes(0);
    expect(useTableStore.getState().tableWidths).toEqual({});
    // 分隔行落库（结构定型证据）→ 结构定型锁宽 1 次（与 S-T-1-05 同
    // 语义；此处验证 W0-2「全程 0」向 W1-3「分隔行到达即锁」的演进
    // 过渡——§4.3 演进表两包断言按 Wave 时序各自有效）
    act(() => {
      getHandle().streamAppend('\n| --- | --- |');
    });
    act(() => {
      getHandle().flushStream();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    // tableId = 首个 | 行 index（seed 占第 0 行，表头第 1 行 → table-1）
    expect(spy.mock.calls[0][0]).toBe('table-1');
    expect(spy.mock.calls[0][1]).toEqual([CELL_WIDTH, CELL_WIDTH]);
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
    // W1-3 演进说明：append 仅入帧聚合缓冲（未 flush 提交），此时间点
    // store 无表格结构 → 计数 0（W1-3 的「分隔行到达即锁」需提交后
    // effect 运行才触发；缓冲内累积在 streamEnd 一并提交）
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
