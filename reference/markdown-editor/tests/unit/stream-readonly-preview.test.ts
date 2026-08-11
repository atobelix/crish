// tests/unit/stream-readonly-preview.test.ts
// W2-1（docs/streaming-render/00 总方案 S-T-2-01，D-1/D-5）：
// 只读流式会话下的 A2 软渲染预演（display-completion 的可编辑路径
// 回归由 display-completion.test.ts 承担；本文件覆盖换源后的新场景）：
// 只读快路径（streamOp 恒 null，streamActive 照常置位）中未闭合
// `**text` / `` `code `` 行的 is-preview-* 类预演保持不变——旧判定
// （streamOp !== null）在该场景会失效，是本包的行为变化点，预演必须
// 在 streamActive 下成立（S-EL-08 / S-T-2-01）。
//
// 覆盖：
// 1. S-T-2-01a/b：只读流式会话（createEditorStore({readOnly:true}) +
//    readOnly prop）中 `**bold`/`` `code `` 未闭合 → is-preview-bold/
//    is-preview-code 类存在、标记原文保留、数据层零篡改；
// 2. 门禁语义：预演期间 store.streamOp === null（快路径跳记账）且
//    streamActive === true（信号照常）；
// 3. S-T-2-01c：streamEnd（stop-flush）→ 预演类消失 + streamActive
//    置 false（收口契约）；
// 4. 只读快路径经引擎句柄驱动的一致性：多 chunk 注入 + flush + streamEnd
//    → 文本精确 / verifyConsistency / 无 undo op / 无 changeLog。
//
// 挂载模式仿 display-completion.test.ts（jsdom + FakeResizeObserver +
// measure mock 固定坐标；本文件不测表格，无需 scrollWidth stub）。
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

// measure 模块部分 mock（jsdom 无布局）：固定测量结果（display-completion
// 同款模式——BlockRenderer 依赖的渲染热路径保留真实实现）
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

/** jsdom 无布局/无 ResizeObserver：虚拟化容器尺寸恒 0 → tanstack 的
 * calculateRange 以 outerSize === 0 直接返回 null，行永不渲染。注入
 * 同步回调的假 ResizeObserver（display-completion 同款参数——28px 视口
 * 使 2-3 行文档的全部行入窗挂载，预演断言依赖末行已挂载）。 */
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

const mountedRoots: Root[] = [];

// jsdom 无布局：offsetHeight 恒 0 → 批量测量把行高回填为 0 → 零高行使
// tanstack 窗口范围膨胀（display-completion 同款收敛：实测 = 预测 → 稳定
// 点护栏跳过回填，测量立即收敛）
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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** 行容器取数（data-index 定位） */
function rowEl(container: HTMLElement, index: number): HTMLElement {
  return container.querySelector(`[data-index="${index}"]`) as HTMLElement;
}

/** 当前文档末行（流式追加目标行） */
function lastRow(container: HTMLElement, store: EditorStore): HTMLElement {
  return rowEl(container, store.getState().getLineCount() - 1);
}

/** 建立「只读流式会话」形态：只读 store + 只读引擎 + streamAppend chunk */
function mountReadOnlyStreaming(
  baseText: string,
  chunk: string
): {
  container: HTMLElement;
  getHandle: () => MarkdownEngineHandle;
  store: EditorStore;
} {
  const store = createEditorStore({ readOnly: true });
  store.getState().setText(baseText);
  const { container, getHandle } = mountEngine(store, { readOnly: true });
  act(() => {
    getHandle().streamAppend(chunk);
    // W1-1（D-4）：降级 chunk 入帧聚合缓冲（rAF 帧边界提交）——预演
    // 断言前显式 flush（提交时点适配：store/DOM 收敛不等待 rAF）
    getHandle().flushStream();
  });
  return { container, getHandle, store };
}

describe('W2-1 S-T-2-01 只读流式会话 A2 预演保持（streamActive 门禁）', () => {
  it('1a `**text` 未闭合：is-preview-bold 存在、原文保留、streamOp null 且 streamActive true', () => {
    const { container, store } = mountReadOnlyStreaming('hello', '\n**bold');
    const row = lastRow(container, store);
    // 预演类存在（样式即时生效）——旧 streamOp 门禁在只读快路径下
    // streamOp 恒 null，此断言即「换源到 streamActive」的行为验证点
    const previewSpan = row.querySelector<HTMLElement>('.is-preview-bold');
    expect(previewSpan, '`**bold` 应命中 is-preview-bold').not.toBeNull();
    // 数据层零篡改：标记字符原文仍在 DOM
    expect(previewSpan!.textContent).toBe('**bold');
    // 门禁语义：快路径跳记账（streamOp 恒 null）+ 信号照常（streamActive true）
    const s = store.getState();
    expect(s.streamOp).toBeNull();
    expect(s.streamActive).toBe(true);
    // 数据层原文精确
    expect(s.getText()).toBe('hello\n**bold');
  });

  it('1b `` `code `` 未闭合：is-preview-code 存在（同门禁语义）', () => {
    const { container, store } = mountReadOnlyStreaming('hello', '\n`code');
    const row = lastRow(container, store);
    const previewSpan = row.querySelector<HTMLElement>('.is-preview-code');
    expect(previewSpan, '`code` 应命中 is-preview-code').not.toBeNull();
    // 标记字符原文保留（display-completion 1a 同口径：` 随预演段保留）
    expect(previewSpan!.textContent).toBe('`code');
    expect(store.getState().streamOp).toBeNull();
    expect(store.getState().streamActive).toBe(true);
  });

  it('1c streamEnd（stop-flush）：预演类消失、streamActive 置 false（收口契约）', () => {
    const { container, getHandle, store } = mountReadOnlyStreaming(
      'hello',
      '\n**bold'
    );
    const row = lastRow(container, store);
    expect(row.querySelector('.is-preview-bold')).not.toBeNull();
    act(() => {
      getHandle().streamEnd();
    });
    const rowAfter = lastRow(container, store);
    expect(rowAfter.querySelector('.is-preview-bold')).toBeNull();
    // 内容保持（未闭合行仍按 text 渲染原文，无样式伪造）
    expect(rowAfter.textContent).toBe('**bold');
    const s = store.getState();
    expect(s.streamActive).toBe(false);
    expect(s.streamOp).toBeNull();
    expect(s.getText()).toBe('hello\n**bold');
  });

  it('1d 只读快路径经引擎驱动的一致性：多 chunk 注入 + streamEnd → 文本/树/记账全绿', () => {
    const store = createEditorStore({ readOnly: true });
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store, { readOnly: true });
    act(() => {
      getHandle().streamAppend('\n| a | b |');
      getHandle().streamAppend('\n| --- | --- |');
      getHandle().streamAppend('\n| 1 | 2 |');
      getHandle().streamAppend('\nbody');
      getHandle().flushStream();
    });
    let s = store.getState();
    expect(s.streamOp).toBeNull();
    expect(s.streamActive).toBe(true);
    expect(s.getText()).toBe('seed\n| a | b |\n| --- | --- |\n| 1 | 2 |\nbody');
    expect(s.verifyConsistency()).toBe(true);
    act(() => {
      getHandle().streamEnd();
    });
    s = store.getState();
    expect(s.streamActive).toBe(false);
    expect(s.streamOp).toBeNull();
    // 只读会话零记账：stop-flush 不生成 op / 不写日志 / 不 bump version
    expect(s.undoStack.length).toBe(0);
    expect(s.redoStack.length).toBe(0);
    expect(s.changeLog.length).toBe(0);
    expect(s.version).toBe(0);
    expect(s.getText()).toBe('seed\n| a | b |\n| --- | --- |\n| 1 | 2 |\nbody');
    expect(s.verifyConsistency()).toBe(true);
  });

  it('1e 误判防护在只读快路径下同样成立：`foo*bar`（词中 `*`）不预演', () => {
    const { container, store } = mountReadOnlyStreaming('foo', '*bar');
    const row = lastRow(container, store);
    expect(row.querySelector('[class*="is-preview-"]')).toBeNull();
    expect(row.textContent).toBe('foo*bar');
    expect(store.getState().getText()).toBe('foo*bar');
    act(() => {
      // 收口（防残留）
    });
  });
});
