// tests/unit/display-completion.test.ts
// P3 B2（docs/analysis/plan-A2-显示层补全.md 方案 B 样式预演）：
// 流式末行未闭合行内标记的显示层乐观补全——格式即时生效、数据层零
// 篡改、闭合切换零跳动（同一 DOM 节点类微调）。
//
// 覆盖（任务书验收）：
// 1. 各形态预演 class：`**text`/`*text`/`_text`/`~~text`/`` `code ``/
//    `$eq` 未闭合 → 对应 is-preview-* 类（预演样式 `<style>` 块随预演
//    挂载、随 streamEnd 卸载）；
// 2. 闭合切换零跳动：streamEnd 前内容闭合 → 同一 DOM 节点
//    （oldEl === newEl）+ 预演类消失 + 真实样式类出现（text → bold/
//    italic/code/math/strike 全形态）；
// 3. 代码块不误判：fence 内 `**` 按字面量，不预演；
// 4. `foo*bar`（词中 `*`）不误判；`**text**x`（全部配对）不误判；
//    非末行不预演；编辑态（非流式）不预演；
// 5. data-token 不变（测量零影响）：预演期间与闭合后
//    data-token-start/data-token-length 一致（无假偏移）；
// 6. undo 零影响（数据层未动）：预演期间 store 原文精确、
//    streamEnd 后单步 undo 精确回到流式前。
//
// 挂载模式仿 render-layer 测试：jsdom + FakeResizeObserver 收敛虚拟化
// 窗口 + measure 模块 mock 固定坐标。
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
import { decorateIncompleteInline } from '../../src/core/decorateIncompleteInline';

// measure 模块部分 mock（jsdom 无布局）：固定测量结果——render-layer
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
 * 使虚拟化窗口在 act 内收敛（render-layer 同款）。
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

const mountedRoots: Root[] = [];

// jsdom 无布局：offsetHeight 恒 0 → 批量测量把行高回填为 0 → 零高行使
// tanstack 窗口范围膨胀（render-layer 同款收敛：实测 = 预测 → 稳定点
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
function lastRow(
  container: HTMLElement,
  store: EditorStore
): HTMLElement {
  return rowEl(container, store.getState().getLineCount() - 1);
}

/** 建立「流式会话进行中」形态：预置基础文本 + 挂载 + streamAppend chunk */
function mountStreaming(
  baseText: string,
  chunk: string
): {
  container: HTMLElement;
  getHandle: () => MarkdownEngineHandle;
  store: EditorStore;
} {
  const store = createEditorStore();
  store.getState().setText(baseText);
  const { container, getHandle } = mountEngine(store);
  act(() => {
    getHandle().streamAppend(chunk);
  });
  return { container, getHandle, store };
}

// —— 预演形态表（plan-A2 §4 测试方案 1：各形态预演断言）——
// chunk = 追加到基础文本后的末行内容；cls = 期望预演类；
// closed = 闭合后的行内容；real = 闭合后的真实样式类。
const PREVIEW_CASES: Array<{
  chunk: string;
  cls: string;
  closed: string;
  real: string;
}> = [
  { chunk: '\n**bold', cls: 'is-preview-bold', closed: '**bold**', real: 'style-bold' },
  { chunk: '\n*em', cls: 'is-preview-italic', closed: '*em*', real: 'style-italic' },
  { chunk: '\n_under', cls: 'is-preview-italic', closed: '_under_', real: 'style-italic' },
  { chunk: '\n~~del', cls: 'is-preview-strike', closed: '~~del~~', real: 'style-strike' },
  { chunk: '\n`code', cls: 'is-preview-code', closed: '`code`', real: 'style-inline-code' },
  { chunk: '\n$eq', cls: 'is-preview-math', closed: '$eq$', real: 'style-math' },
];

describe('P3 B2 显示层乐观补全（plan-A2 方案 B 样式预演）', () => {
  it('1a 各形态预演：流式末行未闭合标记追加 is-preview-* 类（标记原文保留，零新 token）', () => {
    for (const c of PREVIEW_CASES) {
      const { container, getHandle, store } = mountStreaming('hello', c.chunk);
      const row = lastRow(container, store);
      // 预演类存在（样式即时生效）
      const previewSpan = row.querySelector<HTMLElement>(`.${c.cls}`);
      expect(
        previewSpan,
        `${c.chunk} 应命中 ${c.cls}`
      ).not.toBeNull();
      // 数据层零篡改：标记字符原文仍在 DOM（未闭合行按 text token
      // 渲染，预演只是类叠加——无 syntax-hidden 结构、无假偏移）
      expect(previewSpan!.textContent).toBe(c.chunk.slice(1));
      // 预演样式定义随预演挂载（`<style>` 块与真实 style-* 族同参数）
      expect(row.querySelector('style')?.textContent).toContain(
        c.cls
      );
      act(() => {
        getHandle().streamEnd();
      });
    }
  });

  it('1b 闭合切换零跳动：同一 DOM 节点（oldEl === newEl），预演类消失、真实样式类出现', () => {
    for (const c of PREVIEW_CASES) {
      const { container, getHandle, store } = mountStreaming('hello', c.chunk);
      const row = lastRow(container, store);
      const previewEl = row.querySelector<HTMLElement>(`.${c.cls}`);
      expect(previewEl, `${c.chunk} 预演节点应存在`).not.toBeNull();
      const tokenStart = previewEl!.getAttribute('data-token-start');

      // 闭合：追加闭标记（同一次流式会话内）
      act(() => {
        getHandle().streamAppend(c.closed.slice(c.chunk.length - 1));
      });
      const rowAfter = lastRow(container, store);
      const closedEl = rowAfter.querySelector<HTMLElement>(`.${c.real}`);
      expect(closedEl, `${c.closed} 应渲染 ${c.real}`).not.toBeNull();
      // 同一 DOM 节点：React 按 start 键复用（预演 span 原地切换为真实样式）
      expect(closedEl, `${c.closed} 闭合切换应为同一节点`).toBe(previewEl);
      // 预演类消失
      expect(previewEl!.className).not.toContain('is-preview-');
      // data-token 不变（测量零影响）：start 恒等（测量锚点无假偏移）；
      // length 随源码增长更新为「该阶段真实 token 长度」（预演无伪造）
      expect(previewEl!.getAttribute('data-token-start')).toBe(tokenStart);
      expect(previewEl!.getAttribute('data-token-length')).toBe(
        String(c.closed.length)
      );
      // 数据层原文精确（闭合后含闭标记；chunk 自带换行保留）
      expect(store.getState().getText()).toBe(`hello\n${c.closed}`);
      // 预演样式块随闭合移除
      expect(lastRow(container, store).querySelector('style')).toBeNull();
      act(() => {
        getHandle().streamEnd();
      });
    }
  });

  it('1c 预演期间 store 原文精确（数据层零篡改）：' + '`**bold` 流式进行中 getText 与原文本逐字一致', () => {
    const { container, store } = mountStreaming('hello', '\n**bold');
    const row = lastRow(container, store);
    expect(row.querySelector('.is-preview-bold')).not.toBeNull();
    // 数据层未动：预演只是渲染期派生，store 原文含未闭合标记
    expect(store.getState().getText()).toBe('hello\n**bold');
    // 渲染文本 = 原文（无 syntax-hidden 结构——未闭合行按 text 渲染；
    // 取 token span 文本，<style> 预演样式块不计入）
    expect(
      row.querySelector('[data-token-start]')?.textContent
    ).toBe('**bold');
  });

  it('2a streamEnd 收口：预演类消失、`<style>` 预演样式块卸载（流式结束 → 常规渲染）', () => {
    const { container, getHandle, store } = mountStreaming('hello', '\n**bold');
    const row = lastRow(container, store);
    expect(row.querySelector('.is-preview-bold')).not.toBeNull();
    act(() => {
      getHandle().streamEnd();
    });
    const rowAfter = lastRow(container, store);
    expect(rowAfter.querySelector('.is-preview-bold')).toBeNull();
    expect(rowAfter.querySelector('style')).toBeNull();
    // 内容保持（未闭合行仍按 text 渲染原文，无样式伪造）
    expect(rowAfter.textContent).toBe('**bold');
    expect(store.getState().getText()).toBe('hello\n**bold');
  });

  it('3a 代码块不误判：fence 内 `**` 是字面量，不预演', () => {
    const store = createEditorStore();
    store.getState().setText('```\n**code');
    const { container, getHandle } = mountEngine(store);
    // 流式追加到代码行（codeState = 'code' → decorate 短路）
    act(() => {
      getHandle().streamAppend('x');
    });
    const row = rowEl(container, 1);
    expect(row.querySelector('[class*="is-preview-"]')).toBeNull();
    // 内容按代码原文渲染（等宽，标记字面量）
    expect(row.textContent).toBe('**codex');
    expect(store.getState().getText()).toBe('```\n**codex');
    act(() => {
      getHandle().streamEnd();
    });
  });

  it('4a 误判防护：`foo*bar`（词中 `*`）不预演', () => {
    const { container, store } = mountStreaming('foo', '*bar');
    const row = lastRow(container, store);
    expect(row.querySelector('[class*="is-preview-"]')).toBeNull();
    expect(row.textContent).toBe('foo*bar');
    expect(store.getState().getText()).toBe('foo*bar');
  });

  it('4b 误判防护：`**text**x`（标记全部配对）不预演', () => {
    const { container, store } = mountStreaming('hello', '\n**bold**x');
    const row = lastRow(container, store);
    expect(row.querySelector('[class*="is-preview-"]')).toBeNull();
    // 已闭合的 bold 按真实样式渲染（`x` 为普通文本）
    expect(row.querySelector('.style-bold')).not.toBeNull();
  });

  it('4c 作用范围：非末行不预演（预演仅限流式进行中的文档末行）', () => {
    const { container, store } = mountStreaming('hello', '\n**bold\nnormal');
    // 末行 = 'normal'（无标记）；'**bold' 行（index 1）非末行 → 不预演
    const nonTailRow = rowEl(container, 1);
    expect(nonTailRow.querySelector('[class*="is-preview-"]')).toBeNull();
    expect(nonTailRow.textContent).toBe('**bold');
  });

  it('4d 作用范围：编辑态（非流式会话）不预演', () => {
    const store = createEditorStore();
    store.getState().setText('**bold');
    const { container } = mountEngine(store);
    const row = rowEl(container, 0);
    expect(row.querySelector('[class*="is-preview-"]')).toBeNull();
    expect(row.textContent).toBe('**bold');
  });

  it('5a undo 零影响：streamEnd 后单步 undo 精确回到流式前（预演不动数据层）', () => {
    const { container, getHandle, store } = mountStreaming('hello', '\n**bold');
    expect(lastRow(container, store).querySelector('.is-preview-bold')).not.toBeNull();
    act(() => {
      getHandle().streamEnd();
    });
    expect(store.getState().getText()).toBe('hello\n**bold');
    // 单步 undo（R3-A：流式会话合并为单个 meta:'stream' op）→ 流式前
    act(() => {
      store.getState().undo();
    });
    expect(store.getState().getText()).toBe('hello');
    expect(store.getState().getLineCount()).toBe(1);
  });
});

describe('decorateIncompleteInline 纯函数（plan-A2 §3 边界）', () => {
  it('各形态：`**text`/`*text`/`_text`/`~~text`/`` `code ``/`$eq` 未闭合 → 预演提示', () => {
    expect(decorateIncompleteInline('**text', true)).toEqual({
      previewStart: 2,
      hint: 'bold',
    });
    expect(decorateIncompleteInline('*text', true)).toEqual({
      previewStart: 1,
      hint: 'italic',
    });
    expect(decorateIncompleteInline('_text', true)).toEqual({
      previewStart: 1,
      hint: 'italic',
    });
    expect(decorateIncompleteInline('~~text', true)).toEqual({
      previewStart: 2,
      hint: 'strike',
    });
    expect(decorateIncompleteInline('`text', true)).toEqual({
      previewStart: 1,
      hint: 'code',
    });
    expect(decorateIncompleteInline('$eq', true)).toEqual({
      previewStart: 1,
      hint: 'math',
    });
    expect(decorateIncompleteInline('$$eq', true)).toEqual({
      previewStart: 2,
      hint: 'math',
    });
  });

  it('嵌套：只预演「最后未配对开标记」之后的文本', () => {
    // `**a *b`：最后未配对开标记是 `*`（italic）
    expect(decorateIncompleteInline('**a *b', true)).toEqual({
      previewStart: 5,
      hint: 'italic',
    });
    // `**a *b* c**` 全部配对 → 不预演
    expect(decorateIncompleteInline('**a *b* c**', true)).toEqual({});
    // `x **bold`：闭结构在前，仅预演末段
    expect(decorateIncompleteInline('x **bold', true)).toEqual({
      previewStart: 4,
      hint: 'bold',
    });
  });

  it('误判防护：`foo*bar`（词中 `*`）不预演；`**text**x` 全部配对不预演', () => {
    expect(decorateIncompleteInline('foo*bar', true)).toEqual({});
    expect(decorateIncompleteInline('**text**x', true)).toEqual({});
    expect(decorateIncompleteInline('**text**', true)).toEqual({});
    expect(decorateIncompleteInline('`text`', true)).toEqual({});
    expect(decorateIncompleteInline('$a$', true)).toEqual({});
    expect(decorateIncompleteInline('foo_bar_baz', true)).toEqual({});
  });

  it('作用范围：非流式末行/代码语义行不预演', () => {
    expect(decorateIncompleteInline('**text', false)).toEqual({});
    expect(decorateIncompleteInline('**text', true, 'code')).toEqual({});
    expect(decorateIncompleteInline('**text', true, 'indent_code')).toEqual({});
    expect(decorateIncompleteInline('**text', true, 'math_block')).toEqual({});
    // 'none'/缺省照常预演
    expect(decorateIncompleteInline('**text', true, 'none')).toEqual({
      previewStart: 2,
      hint: 'bold',
    });
  });

  it('转义：`\\**bold` 中首 `*` 按字面量（预演从第二 `*` 起）', () => {
    expect(decorateIncompleteInline('\\**bold', true)).toEqual({
      previewStart: 3,
      hint: 'italic',
    });
    // 转义的闭标记不闭合：`**bold\\*` 仍预演 bold
    expect(decorateIncompleteInline('**bold\\*', true)).toEqual({
      previewStart: 2,
      hint: 'bold',
    });
  });

  it('等长 run 配对：`` `a``b` `` 整体闭合不预演；`` `a`` `` 未闭合预演 code', () => {
    expect(decorateIncompleteInline('`a``b`', true)).toEqual({});
    expect(decorateIncompleteInline('`a``', true)).toEqual({
      previewStart: 1,
      hint: 'code',
    });
  });
});
