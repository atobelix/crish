// tests/unit/stream-follow-scroll.test.ts
// W1-2 滚动跟随三态 + M2c 复位锁死回归（docs/streaming-render/00 总方案
// W1-2 包：S-T-1-03 / S-T-1-04 / M2c 回归）。
//
// 覆盖（任务书三项）：
// 1. S-T-1-03（R-13 定量）：流式注入（多 chunk 高频提交，计数等效 60s）
//    期间引擎主动 scrollTop 修改 ≤ 2 次（初始化贴底 + 恢复贴底）——
//    用 Element.prototype.scrollTop setter wrap 计数；
// 2. S-T-1-04：用户上滚离开尾部（scroll 事件）→ 注入 30s 等效无主动
//    修改；用户滚回尾部 20px 内 → 恢复主动修改（内容增量超阈值才滚）；
// 3. M2c 回归：注入期间 scrollTop 不被复位锁死——用户位置保持（此前
//    HiddenInput 光标滚动跟随在流式会话中把 scrollTop 抢拉到光标行，
//    perf 实测 253027→3513 锁死；修复 = 流式门禁短路，见
//    HiddenInput.tsx updateCoords）。
//
// 挂载模式仿 selection-protect.test.ts：jsdom + FakeResizeObserver 收敛
// 虚拟化窗口 + measure 模块 mock 固定坐标（HiddenInput 光标测量路径）。
// jsdom 无布局：scrollHeight/clientHeight 恒 0 → 引擎跟随判据
// （scrollHeight - scrollTop - clientHeight > FOLLOW_EDGE_PX）永不满足，
// 测试对滚动容器 stub 动态内容高度（28px × 行数 + 基底）模拟真实几何；
// scrollTop setter 原型 wrap 计数，原 setter 供「用户滚动模拟」绕过
// 计数（用户手势不是引擎主动修改）。
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

// measure 模块部分 mock：jsdom 无布局，固定测量结果（HiddenInput /
// CursorLayer / SelectionHighlight 只消费几何函数——selection-protect
// 同款模式；getCoordinatesFromIndex 固定 rect 使「无流式门禁」时光标
// 越界滚动分支必然触发 scrollTop = 0 的抢拉，M2c 回归可测）。
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

// —— 原型 descriptor 快照（afterEach 恢复，防跨用例污染）——
const ORIG_SCROLL_TOP = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'scrollTop'
)!;
const ORIG_SCROLL_HEIGHT = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'scrollHeight'
)!;

// 固定视口高度（FakeResizeObserver 上报 800 内容高；跟随判定口径统一）
const CLIENT_HEIGHT = 800;
// 内容高度基底（容器 padding/margin 等非行高成分，对齐 estimateSize 28px/行）
const GEOM_BASE = 100;

/**
 * jsdom 无布局/无 ResizeObserver：虚拟化容器尺寸恒 0 → tanstack 的
 * calculateRange 以 outerSize === 0 直接返回 null，行永不渲染。注入
 * 同步回调的假 ResizeObserver——observe 时立即上报固定尺寸（600×800），
 * 使虚拟化窗口在 act 内收敛（render-export 同款）。
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

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  for (const r of mountedRoots) {
    act(() => r.unmount());
  }
  mountedRoots.length = 0;
  document.body.innerHTML = '';
  // 恢复原型 descriptor（scrollTop 计数 wrap / scrollHeight 几何 stub）
  Object.defineProperty(Element.prototype, 'scrollTop', ORIG_SCROLL_TOP);
  Object.defineProperty(Element.prototype, 'scrollHeight', ORIG_SCROLL_HEIGHT);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function mountEngine(store: EditorStore) {
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
      })
    );
  });
  return { container, getHandle: () => handle! };
}

// 滚动容器（引擎 parentRef 容器，跟随/计数作用对象）
function scroller(): HTMLElement {
  return document.querySelector('.editor-scroll-container')! as HTMLElement;
}

// —— 滚动几何 stub 工厂 ——
// jsdom 无布局：scrollHeight/clientHeight 恒 0。stub 滚动容器为动态
// 内容高度（28px × 当前行数 + GEOM_BASE），模拟真实浏览器的滚动几何
// （注入后 scrollHeight 随内容增长，与真实浏览器一致）。
function stubScrollGeometry(store: EditorStore) {
  const contentHeight = () => GEOM_BASE + 28 * store.getState().getLineCount();
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

// —— scrollTop 主动修改计数 wrap ——
// 原型 setter wrap：仅统计滚动容器上的赋值（引擎贴底跟随的物理直写）。
// 返回 userSet = 「用户滚动模拟」（走原 setter + 派发 scroll 事件——
// 用户手势不是引擎主动修改，不入计数）。
function wrapScrollTopCounter() {
  let count = 0;
  const writes: number[] = [];
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return ORIG_SCROLL_TOP.get!.call(this);
    },
    set(this: Element, v: number) {
      if (this.classList?.contains('editor-scroll-container')) {
        count++;
        writes.push(v);
      }
      return ORIG_SCROLL_TOP.set!.call(this, v);
    },
  });
  return {
    count: () => count,
    writes: () => writes,
    userSet(el: HTMLElement, v: number) {
      ORIG_SCROLL_TOP.set!.call(el, v);
      el.dispatchEvent(new Event('scroll'));
    },
  };
}

// 流式注入 helper：带换行 chunk（走 StreamBuffer 帧聚合 + flushStream
// 显式提交——提交时点可控，不依赖 jsdom rAF；等效「一次流式提交」）
function streamInject(handle: MarkdownEngineHandle, lines: string[]) {
  act(() => {
    for (const ln of lines) {
      handle.streamAppend(ln);
    }
    handle.flushStream();
  });
}

const INIT_LINES = 30;

function makeInitStore(): EditorStore {
  const store = createEditorStore();
  const arr = new Array(INIT_LINES);
  for (let i = 0; i < INIT_LINES; i++)
    arr[i] = `初始文档第 ${i} 行：稳定正文内容。`;
  store.getState().setText(arr.join('\n'));
  return store;
}

describe('W1-2 滚动跟随（S-T-1-03 / S-T-1-04 / M2c 回归）', () => {
  it('S-T-1-03：60s 等效注入内引擎主动 scrollTop 修改 ≤2（初始化 + 恢复贴底）', () => {
    const store = makeInitStore();
    const { getHandle } = mountEngine(store);
    const contentHeight = stubScrollGeometry(store);
    const counter = wrapScrollTopCounter();
    const el = scroller();
    const maxTop = () => contentHeight() - CLIENT_HEIGHT;

    // 初始：视口距底部 = contentHeight(940) - 0 - 800 = 140 > 20（视口未贴底）
    // ——首次流式提交即「初始化贴底」滚动 1 次（R-13 计数第 1 次）
    streamInject(getHandle(), ['\n初始化注入行']);
    expect(counter.count()).toBe(1);
    expect(el.scrollTop).toBe(contentHeight());

    // 用户上滚离开尾部（距底 > 20px）→ 跟随暂停
    counter.userSet(el, maxTop() - 100);
    const userTop = el.scrollTop;
    expect(counter.count()).toBe(1);

    // 60s 等效：高频多 chunk 注入（计数口径，每 chunk 一次提交）——
    // paused 期间引擎不得主动修改 scrollTop（scrollTop 保持上滚时的值）
    for (let i = 0; i < 100; i++) {
      streamInject(getHandle(), [`\n暂停期间注入第 ${i} 行`]);
    }
    expect(counter.count()).toBe(1);
    expect(el.scrollTop).toBe(userTop);

    // 用户滚回尾部（距底 0）→ 恢复跟随；新提交把尾部推出视口 → 贴底 1 次
    //（R-13 计数第 2 次）
    counter.userSet(el, maxTop());
    streamInject(getHandle(), ['\n恢复后注入行']);
    expect(counter.count()).toBe(2);
    expect(el.scrollTop).toBe(contentHeight());

    // 注入内容完整（文本顺序 = 到达顺序）
    expect(store.getState().getLineCount()).toBe(INIT_LINES + 1 + 100 + 1);
  });

  it('S-T-1-04：上滚后注入 30s 等效无主动修改；滚回尾部 20px 内恢复', () => {
    const store = makeInitStore();
    const { getHandle } = mountEngine(store);
    const contentHeight = stubScrollGeometry(store);
    const counter = wrapScrollTopCounter();
    const el = scroller();
    const maxTop = () => contentHeight() - CLIENT_HEIGHT;

    // 先贴底（初始化跟随），后续计数只针对「上滚暂停」段
    streamInject(getHandle(), ['\n初始化行']);
    counter.userSet(el, maxTop());

    // 用户上滚离开尾部（距底 100px > 20）→ 暂停
    counter.userSet(el, maxTop() - 100);
    const userTop = el.scrollTop;
    const baseline = counter.count();

    // 30s 等效：60 次提交，paused 期间零主动修改（位置保持）
    for (let i = 0; i < 60; i++) {
      streamInject(getHandle(), [`\n阅读期注入第 ${i} 行`]);
    }
    expect(counter.count()).toBe(baseline);
    expect(el.scrollTop).toBe(userTop);

    // 用户滚回「尾部 20px 内」（距底 10px ≤ 20）→ 恢复跟随状态；
    // 新提交把尾部推出视口（距底 = 10 + 28 = 38 > 20）→ 贴底跟随
    //（恢复后的首次主动修改）
    counter.userSet(el, maxTop() - 10);
    streamInject(getHandle(), ['\n回到尾部后注入']);
    expect(counter.count()).toBe(baseline + 1);
    expect(el.scrollTop).toBe(contentHeight());
  });

  it('M2c 回归：注入期间 scrollTop 不被复位锁死（用户位置保持 + 恢复跟随）', () => {
    const store = makeInitStore();
    const { getHandle } = mountEngine(store);
    const contentHeight = stubScrollGeometry(store);
    const counter = wrapScrollTopCounter();
    const el = scroller();
    const maxTop = () => contentHeight() - CLIENT_HEIGHT;

    // 用户滚动到文档中部阅读（距底 2000px）——此前 M2c 失真的场景
    //（perf suite：注入 24ms 内 scrollTop 253027→3513 被光标跟随抢拉）
    counter.userSet(el, maxTop() - 2000);
    const userTop = el.scrollTop;
    const baseline = counter.count();

    // 注入期间（HiddenInput 光标滚动跟随 + 引擎跟随评估都不得抢滚动）：
    // HiddenInput 侧——store 每帧提交触发 updateCoords effect 重跑，
    // 流式门禁（streamOp 非空）短路光标越界滚动（修复前会抢拉到光标行）；
    // 引擎侧——follow 状态为 paused（距底 > 20），提交后评估不滚。
    for (let i = 0; i < 50; i++) {
      streamInject(getHandle(), [`\n注入保持第 ${i} 行`]);
    }
    expect(counter.count()).toBe(baseline);
    expect(el.scrollTop).toBeCloseTo(userTop, 0);
    // 用户位置的内容（中部行）仍在视口内——注入不把用户顶走
    expect(store.getState().getLineCount()).toBe(INIT_LINES + 50);

    // 用户滚回尾部 → 注入 → 正常贴底跟随（scrollTop 随内容增长，不锁死）
    counter.userSet(el, maxTop());
    streamInject(getHandle(), ['\n回到尾部后注入']);
    expect(el.scrollTop).toBe(contentHeight());
  });
});
