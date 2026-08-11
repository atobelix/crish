// tests/unit/stream-unmount-flush.test.ts
// W0-4 包（docs/streaming-render/00-流式渲染极致化总方案.md）：组件卸载时
// flush 直刷累积（pending 直刷文本不丢失，S-EL-06）。
//
// 背景：pendingStreamRef（MarkdownEngine.tsx，直刷会话的延迟提交缓冲）
// 累积已直写 DOM、尚未提交 store 的文本。全文件原本只有三条处理路径：
// flush（flushStreamInternal）、直写（streamAppend 成功分支）、断开兜底
// （批量测量 effect）——没有 unmount cleanup。宿主未调 streamEnd 即销毁
// 组件（切换会话/路由卸载）时，pending 直刷文本随组件 ref 一起消失、
// store 缺失该段文本（分析文档 02-渲染管线.md §2.2 缺陷 3 / §3.2）。
// 修复：useEffect cleanup 调幂等 flushStreamInternal（MarkdownEngine.tsx
// 用户操作监听 effect 之后的卸载兜底 effect）——有累积则 appendText
// 一次提交，无累积空转零开销；不做 streamEnd 的尾段合并（那是宿主职责）。
//
// 覆盖（W0-4 验收断言 S-T-0-08）：
// 1. S-T-0-08a：挂载引擎 → streamAppend 直刷若干纯文本 chunk（无换行、
//    走直刷路径：DOM 已见文本、store 未提交）→ 卸载组件 → store 文本
//    包含全部直刷文本（flush 已提交，无丢失）；
// 2. S-T-0-08b：卸载幂等——重复 unmount 无异常、无重复提交（store 文本
//    恰一份）；已 flush 后再卸载（pending 空）cleanup 空转、文本不重复。
//
// 挂载模式仿 stream-table-lock 测试：jsdom + FakeResizeObserver 收敛
// 虚拟化窗口（视口 2000px，全部测试行入窗）+ measure 模块 mock 固定
// 坐标 + offsetHeight stub（jsdom 无布局，行高固定 28px）。
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

// measure 模块部分 mock（jsdom 无布局）：固定测量结果——stream-table-lock
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
 * 行高 28px → 约 71 行入窗，本文件 1-2 行文档全部挂载——直刷依赖末行
 * 入窗拿到 tokenEl，视口必须覆盖全部行）。
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
// tanstack 窗口范围膨胀（stream-table-lock 同款收敛：实测 = 预测 → 稳定点
// 护栏跳过回填，测量立即收敛）
const REAL_ROW_HEIGHT = 28;
const origOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetHeight'
);

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return REAL_ROW_HEIGHT;
    },
  });
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
  return { container, root, getHandle: () => handle! };
}

/** 卸载单个根（可被用例多次调用；unmount 幂等性由用例自行断言） */
function unmountRoot(root: Root) {
  act(() => root.unmount());
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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('W0-4 组件卸载 flush 直刷累积（S-T-0-08）', () => {
  it('S-T-0-08a 卸载前 store 未提交、DOM 已直刷；卸载后 store 包含全部直刷文本', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { container, root, getHandle } = mountEngine(store);

    // 直刷路径：chunk 无换行、合并后纯文本 → tokenEl.textContent 命令式
    // 追加 + pendingStreamRef 累积（store 延迟提交）
    act(() => {
      getHandle().streamAppend('直刷文本');
    });
    act(() => {
      getHandle().streamAppend('追加');
    });

    // 前置断言：确走直刷路径——DOM 末行 token 已见全部直刷文本，而
    // store 文本未提交（pending 只存在组件 ref 里，是「卸载即丢」的前提）
    const tokenEl = container.querySelector('[data-token-start]');
    expect(tokenEl).not.toBeNull();
    expect(tokenEl!.textContent).toBe('seed直刷文本追加');
    expect(store.getState().getText()).toBe('seed');

    // 卸载组件（宿主未调 streamEnd 即销毁）→ unmount cleanup flush
    unmountRoot(root);

    // flush 已提交：store 文本包含全部直刷文本，无丢失、无重复
    expect(store.getState().getText()).toBe('seed直刷文本追加');
  });

  it('S-T-0-08b 重复 unmount 幂等：无异常、直刷文本只提交一份', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { root, getHandle } = mountEngine(store);

    act(() => {
      getHandle().streamAppend('直刷文本');
    });
    expect(store.getState().getText()).toBe('seed');

    // 第一次卸载：cleanup flush 提交 pending
    unmountRoot(root);
    expect(store.getState().getText()).toBe('seed直刷文本');

    // 第二次卸载：无异常（重复 unmount 安全）；cleanup 再跑时 pending
    // 已空 → 空转，文本不重复提交
    unmountRoot(root);
    expect(store.getState().getText()).toBe('seed直刷文本');
  });

  it('S-T-0-08c 已 flush 后再卸载：cleanup 空转、文本不重复', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { root, getHandle } = mountEngine(store);

    act(() => {
      getHandle().streamAppend('直刷文本');
    });
    // 宿主主动 flush（Handle.flushStream，幂等）→ pending 已提交
    act(() => {
      getHandle().flushStream();
    });
    expect(store.getState().getText()).toBe('seed直刷文本');

    // 卸载 cleanup：无 pending → 空转零开销，文本保持恰一份
    unmountRoot(root);
    expect(store.getState().getText()).toBe('seed直刷文本');
  });
});
