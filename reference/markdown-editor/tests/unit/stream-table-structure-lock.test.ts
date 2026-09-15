// tests/unit/stream-table-structure-lock.test.ts
// W1-3（docs/streaming-render/00 流式渲染极致化总方案 D-2 三态协议）：
// 流式表格结构定型锁宽——分隔行到达即锁 + grow-only 修正（只增不减）。
//
// 背景（R-1 断言演进，00 总方案 §4.3）：W0-2 修复「流式尾表提前锁宽」
// 后，流式会话中表格完全不锁宽（内容自适应，flex 1 1 0% 全列等宽）；
// W1-3 在此之上引入「结构定型（表头+分隔行落库）即锁」——锁宽时机 =
// 分隔行落库（结构证据），非表格闭合；后续数据行超宽 → 逐列 grow-only
// 修正（只增不减，避免收窄跳变）；表格闭合后不再变化。分隔行到达前
// 计数 0 属 S-T-0-03 演进语义（stream-table-lock.test.ts），本文件聚焦
// 到达后与持续修正。
//
// 覆盖（W1-3 验收断言 S-T-1-05 / S-T-1-07 / S-T-1-08 / S-T-1-09）：
// 1. S-T-1-05：流式会话中表头+分隔行落库（结构定型）→ setTableWidths
//    计数 = 1（分隔行到达即锁，按已见行测宽）；
// 2. S-T-1-07：锁宽后数据行超宽 → 列宽 grow-only 更新（逐列只增不减；
//    单列超宽只更新该列；收窄行零写入）；
// 3. S-T-1-08：长表（50 行）流式输出中，分隔行滚出可见窗口（视口
//    模拟 + 滚动跟随）后数据行继续到达 → 锁宽与修正仍生效（表格段
//    定位经 store 行视图，不依赖分隔行可见；测宽进度停住等挂载补测）；
// 4. S-T-1-09：非流式（setText 闭合表格）行为与 W0-2 前一致（既有
//    闭合定型路径零变化；本包逻辑只在 streamOp !== null 时进入）。
//
// 挂载模式仿 stream-table-lock.test.ts（W0-2 测试资产）：jsdom +
// FakeResizeObserver 收敛虚拟化窗口 + measure 模块 mock 固定坐标 +
// helpers/test-env 的 stubScrollWidth（R-10 协议；S-T-1-07 以 cell 文本
// 长度驱动列宽，自然产生单列超宽/收窄的确定性测量）。S-T-1-08 复用
// stream-follow-scroll.test.ts 的滚动几何 stub（scrollHeight = 基底 +
// 28px × 行数）与用户滚动模拟（原 setter + scroll 事件 + rAF 帧推进）。
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
      bottom: rect.bottom,
    }),
    getGlobalIndexFromDOMNode: () => null,
    getArrowNavigationIndex: () => null,
  };
});

// React 19 act 要求显式声明测试环境（与既有测试同款）
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 视口高度（S-T-1-08 缩为 200px 使长表滚动中分隔行滚出窗口；其余用例
// 2000px 全部测试行入窗）。FakeResizeObserver observe 时读当前值。
let VIEWPORT_HEIGHT = 2000;

/**
 * jsdom 无布局/无 ResizeObserver：虚拟化容器尺寸恒 0 → tanstack 的
 * calculateRange 以 outerSize === 0 直接返回 null，行永不渲染。注入
 * 同步回调的假 ResizeObserver——observe 时立即上报固定尺寸（宽 800、
 * 高 VIEWPORT_HEIGHT，行高 28px），使虚拟化窗口在 act 内收敛。
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
          borderBoxSize: [{ blockSize: VIEWPORT_HEIGHT, inlineSize: 800 }],
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
// tanstack 窗口范围膨胀（display-completion 同款收敛：实测 = 预测 →
// 稳定点护栏跳过回填，测量立即收敛）
const REAL_ROW_HEIGHT = 28;
const origOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetHeight'
);

// scrollWidth stub（R-10 协议）：jsdom 恒 0，锁宽测宽依赖确定性测量值。
// 每用例独立安装（固定列宽 / 文本长度驱动 / 动态变量）
let restoreScrollWidth: () => void = () => {};

// 真实 setTableWidths（模块加载时捕获；spy 委托它写入锁宽状态，
// afterEach 恢复原 action 防止跨文件污染）
const realSetTableWidths = useTableStore.getState().setTableWidths;

// S-T-1-08 滚动几何（stream-follow-scroll.test.ts 同款）：
// scrollHeight/clientHeight 原型 descriptor 快照（afterEach 恢复）
const ORIG_SCROLL_TOP = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'scrollTop'
)!;
const ORIG_SCROLL_HEIGHT = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'scrollHeight'
)!;
// 固定视口高度（与 S-T-1-08 的 VIEWPORT_HEIGHT=200 一致）
const CLIENT_HEIGHT = 200;
// 内容高度基底（容器 padding/margin 等非行高成分，对齐 estimateSize 28px/行）
const GEOM_BASE = 100;

beforeEach(() => {
  VIEWPORT_HEIGHT = 2000;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return REAL_ROW_HEIGHT;
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
  Object.defineProperty(Element.prototype, 'scrollTop', ORIG_SCROLL_TOP);
  Object.defineProperty(Element.prototype, 'scrollHeight', ORIG_SCROLL_HEIGHT);
  restoreScrollWidth();
  vi.useRealTimers();
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

/** 流式注入 helper：含换行 chunk 入帧聚合缓冲 + 显式 flush 提交
 *（提交时点可控，等效一次流式提交；stream-follow-scroll 同款） */
function streamInject(handle: MarkdownEngineHandle, lines: string[]) {
  act(() => {
    for (const ln of lines) {
      handle.streamAppend(ln);
    }
    handle.flushStream();
  });
}

// —— S-T-1-08 滚动模拟设施（stream-follow-scroll.test.ts 同款）——

/** 滚动容器（引擎 parentRef 容器） */
function scroller(): HTMLElement {
  return document.querySelector('.editor-scroll-container')! as HTMLElement;
}

/** stub 滚动几何：容器 scrollHeight = 基底 + 28px × 行数（动态随内容
 * 增长）、clientHeight = 200（视口高），模拟真实浏览器滚动几何 */
function stubScrollGeometry(store: EditorStore) {
  const contentHeight = () =>
    GEOM_BASE + REAL_ROW_HEIGHT * store.getState().getLineCount();
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) {
      if (this.classList?.contains('editor-scroll-container')) {
        return contentHeight();
      }
      return ORIG_SCROLL_HEIGHT.get!.call(this);
    },
  });
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: Element) {
      if (this.classList?.contains('editor-scroll-container')) {
        return CLIENT_HEIGHT;
      }
      return 0;
    },
  });
  return contentHeight;
}

/** 用户滚动模拟：走原 scrollTop setter（非引擎主动修改）+ 派发 scroll
 * 事件 → tanstack observer rAF 合并 → 帧推进驱动虚拟窗口更新 */
function userScrollToBottom(contentHeight: () => number) {
  act(() => {
    const el = scroller();
    ORIG_SCROLL_TOP.set!.call(el, contentHeight() - CLIENT_HEIGHT);
    el.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(16);
  });
}

/** cell 文本长度 × 10 驱动的 scrollWidth（确定性：单列超宽/收窄自然产生） */
function textLengthWidth(this: HTMLElement): number {
  return (this.textContent ?? '').length * 10;
}

describe('W1-3 流式表格结构定型锁宽（S-T-1-05 / S-T-1-07 / S-T-1-08 / S-T-1-09）', () => {
  it('S-T-1-05 流式会话中表头+分隔行落库（结构定型）→ setTableWidths 计数 = 1', () => {
    const spy = installLockSpy();
    restoreScrollWidth = stubScrollWidth(() => 100);
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);

    // 表头落库（分隔行未到达——无结构证据，不锁；S-T-0-03 演进语义）
    streamInject(getHandle(), ['\n| a | b |']);
    expect(spy).toHaveBeenCalledTimes(0);

    // 分隔行落库（结构定型证据）→ 立即按已见行测宽锁定
    streamInject(getHandle(), ['\n| --- | --- |']);
    expect(spy).toHaveBeenCalledTimes(1);
    // tableId = 首个 | 行 index（seed 占第 0 行，表头第 1 行 → table-1）
    expect(spy.mock.calls[0][0]).toBe('table-1');
    // 表头+分隔行两行测宽逐列 max（固定 stub 100）
    expect(spy.mock.calls[0][1]).toEqual([100, 100]);
    // 锁宽落库（spy 委托真实实现）
    expect(useTableStore.getState().tableWidths['table-1']).toEqual([100, 100]);
  });

  it('S-T-1-07 锁宽后数据行超宽 → 列宽 grow-only 更新（只增不减；收窄行零写入）', () => {
    const spy = installLockSpy();
    // 文本长度×10（cell textContent 含边界空格，实测：' a '=30、' --- '=50、
    // ' 单列超宽 '=60、' 超宽内容列 '=70）→ 结构定型锁 [50, 50]
    // （表头 30 与分隔行 50 逐列 max——分隔行 cell 参与测宽，与既有路径同款）
    restoreScrollWidth = stubScrollWidth(
      textLengthWidth as unknown as () => number
    );
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);

    streamInject(getHandle(), ['\n| a | b |', '\n| --- | --- |']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useTableStore.getState().tableWidths['table-1']).toEqual([50, 50]);

    // 单列超宽数据行：第 0 列 ' 单列超宽 '（60）> 50 → 只增该列；
    // 第 1 列 ' 短 '（30）< 50 → 保持
    streamInject(getHandle(), ['\n| 单列超宽 | 短 |']);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0]).toBe('table-1');
    expect(spy.mock.calls[1][1]).toEqual([60, 50]);
    expect(useTableStore.getState().tableWidths['table-1']).toEqual([60, 50]);

    // 另一列超宽：第 1 列 ' 超宽内容列 '（70）> 50 → 只增该列
    // （第 0 列 ' 超 '=30 < 60 不动）
    streamInject(getHandle(), ['\n| 超 | 超宽内容列 |']);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(useTableStore.getState().tableWidths['table-1']).toEqual([60, 70]);

    // 收窄行（30/30 < 60/70）→ grow-only 不缩宽，零写入（计数保持）
    streamInject(getHandle(), ['\n| a | b |']);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(useTableStore.getState().tableWidths['table-1']).toEqual([60, 70]);
  });

  it('S-T-1-08 长表（50 行）流式输出：分隔行滚出窗口后锁宽与修正仍生效', () => {
    const spy = installLockSpy();
    // S-T-1-08 专用：视口 200px（约 7 行可见）+ 滚动几何 stub + 帧时钟
    // stub（stream-frame-batch 同款：rAF = setTimeout 16ms，滚动后帧推进
    // 驱动 tanstack 窗口更新；afterEach 统一恢复真实时钟）
    VIEWPORT_HEIGHT = 200;
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(cb, 16)
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    // 动态列宽变量：普通数据行 100，超宽行 150/200，收窄行 50
    let colWidth = 100;
    restoreScrollWidth = stubScrollWidth(() => colWidth);
    const store = createEditorStore();
    store.getState().setText('seed');
    const { container, getHandle } = mountEngine(store);
    const contentHeight = stubScrollGeometry(store);

    // 结构定型：表头+分隔行落库 → 锁宽（分隔行到达即锁，不依赖滚动）
    streamInject(getHandle(), ['\n| a | b |', '\n| --- | --- |']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useTableStore.getState().tableWidths['table-1']).toEqual([100, 100]);

    // 长表主体：46 行数据行到达（锁宽值保持，无超宽零写入）
    const dataLines = [];
    for (let i = 0; i < 46; i++) dataLines.push(`\n| 数据${i} | 行${i} |`);
    streamInject(getHandle(), dataLines);
    expect(spy).toHaveBeenCalledTimes(1);
    // 滚动到底部跟随（用户手势）→ 分隔行（行 2）滚出可见窗口
    userScrollToBottom(contentHeight);
    const mountedIndexes = Array.from(
      container.querySelectorAll('[data-index]'),
      (el) => Number((el as HTMLElement).getAttribute('data-index'))
    );
    expect(mountedIndexes).not.toContain(2);

    // 分隔行滚出窗口后，超宽数据行继续到达 → grow-only 修正仍生效
    colWidth = 150;
    streamInject(getHandle(), ['\n| 超宽内容 | 超宽内容 |']);
    userScrollToBottom(contentHeight);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(useTableStore.getState().tableWidths['table-1']).toEqual([150, 150]);

    // 再更宽 → 继续 grow
    colWidth = 200;
    streamInject(getHandle(), ['\n| 更宽内容 | 更宽内容 |']);
    userScrollToBottom(contentHeight);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(useTableStore.getState().tableWidths['table-1']).toEqual([200, 200]);

    // 收窄行到达 → 零写入（计数保持，列宽不缩）
    colWidth = 50;
    streamInject(getHandle(), ['\n| 窄 | 窄 |']);
    userScrollToBottom(contentHeight);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(useTableStore.getState().tableWidths['table-1']).toEqual([200, 200]);

    // 长表完整性：seed + 表头 + 分隔 + 46 + 3 = 52 行
    expect(store.getState().getLineCount()).toBe(52);
  });

  it('S-T-1-09 非流式（setText 闭合表格）行为与 W0-2 前一致（编辑路径零侵入）', () => {
    const spy = installLockSpy();
    // 文本长度×10：闭合定型应测到全量已挂载行（含超宽数据行）
    restoreScrollWidth = stubScrollWidth(
      textLengthWidth as unknown as () => number
    );
    const store = createEditorStore();
    // 非流式整文一次性 setText：表格后接正文（真闭合信号）
    store
      .getState()
      .setText('| a | b |\n| --- | --- |\n| 单列超宽 | 短 |\n\n正文');
    mountEngine(store);
    expect(store.getState().streamOp).toBeNull();
    // 既有闭合定型路径：一次性锁宽（计数 1，非流式行为不变——
    // 流式分支逻辑不进入，本包零侵入）
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('table-0');
    // 表头 ' a '=30 / 分隔 ' --- '=50 / 超宽 ' 单列超宽 '=60、' 短 '=30
    // → 闭合定型测全量已挂载行，逐列 max [60, 50]
    expect(spy.mock.calls[0][1]).toEqual([60, 50]);
    expect(useTableStore.getState().tableWidths['table-0']).toEqual([60, 50]);
  });
});
