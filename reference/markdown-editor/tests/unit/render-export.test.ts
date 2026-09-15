// tests/unit/render-export.test.ts
// B4 导出与复制（docs/analysis/plan-P2-执行方案.md B4 / status-P3 N4/N5/N9）
//
// 覆盖（对应任务书验收）：
// 1. renderToHtml 投影器：与 astToHtml 一致性（同文档输出等价——除 math
//    占位差异，一致性红线）；math 真实渲染（KaTeX 默认注入 + mock 渲染器
//    确定性断言）；引擎扩展语法（mark/spoiler/footnote/checkbox）语义映射；
// 2. fence lang 渲染器注册表（N4）：默认 json/diff/log 出厂注册；自定义
//    注册/覆盖/移除恢复；BlockRenderer fence 分支按 lang 分发（未注册 lang
//    走默认代码渲染）；内置渲染器冒烟（json 着色/diff 红绿/log 级别）；
// 3. 代码块复制按钮 + 公式复制按钮（N5）：fence 首行内容锚点、点击经
//    navigator.clipboard 复制整块 raw / LaTeX 源（jsdom clipboard mock）；
// 4. 只读复制为 Markdown（N9）：DOM 选区 → 源码偏移映射（data-token-start
//    /data-sub-offset）→ getText 切片；MarkdownEngine readOnly onCopy 端到端
//    （拦截默认渲染文本复制，剪贴板写入源码）。
//
// 纪律：全局注册的自定义 lang 渲染器/数学渲染器/主题在 afterEach 统一恢复，
// 不污染其它测试文件（与 render-registry.test.ts 同款清理协议）。
// @vitest-environment jsdom

import './helpers/layout-fixture';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import { MarkdownParser } from '../../src/core/parser';
import type { CodeState } from '../../src/core/parser';
import { astToHtml } from '../commonmark/astToHtml';
import {
  renderToHtml,
  domRangeToSourceOffsets,
  selectionToMarkdown,
} from '../../src/core/renderToHtml';
import { BlockRenderer } from '../../src/components/BlockRenderer';
import {
  FenceLangRendererRegistry,
  registerFenceLangRenderer,
  unregisterFenceLangRenderer,
  resolveFenceLangRenderer,
  type FenceLangRendererProps,
} from '../../src/components/BlockRenderer';
import { MarkdownEngine } from '../../src/components/MarkdownEngine';
import { createEditorStore } from '../../src/core/EditorStore';
import {
  clearMathRenderCache,
  setMathRenderer,
} from '../../src/core/renderTheme';
import type { LineNode } from '../../src/core/ast';

// measure 模块依赖真实 DOM 布局（jsdom 无布局），统一 mock 固定坐标
// （HiddenInput 只消费 getCoordinatesFromIndex / toContainerCoords）——
// 用 importOriginal 展开保留 checkIsActive 等渲染热路径真实实现
// （BlockRenderer 依赖，drag-select.test.ts 同款模式）
vi.mock('../../src/core/measure', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/core/measure')
  >();
  return {
    ...actual,
    getCoordinatesFromIndex: (i: number) => ({
      top: 0,
      left: i * 10,
      height: 20,
      bottom: 20,
    }),
    toContainerCoords: (rect: { top: number; left: number; height: number }) => ({
      top: rect.top,
      left: rect.left,
      height: rect.height,
      bottom: rect.height,
    }),
    getGlobalIndexFromDOMNode: () => null,
    getArrowNavigationIndex: () => null,
  };
});

// React 19 act 要求显式声明测试环境（与 a11y.test.ts 同款）
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom 无布局/无 ResizeObserver：虚拟化容器尺寸恒 0 → tanstack 的
 * calculateRange 以 outerSize === 0 直接返回 null，行永不渲染。注入
 * 同步回调的假 ResizeObserver——observe 时立即上报固定尺寸（600×800），
 * 使虚拟化窗口在 act 内收敛（observe 发生于 _willUpdate 布局效应）。
 */
class FakeResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    // 同步回调：滚动容器（600 高 → 虚拟化窗口收敛）与已测量行
    // （28 高 → 行尺寸稳定）都立即上报固定尺寸；entry.target 必须
    // 携带（virtual-core 的测量观察器读取 target 的 data-index）
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

// —— 剪贴板 mock（navigator.clipboard，代码块/公式复制按钮消费）——
let clipboardMock: { writeText: ReturnType<typeof vi.fn> };

beforeEach(() => {
  clipboardMock = { writeText: vi.fn(() => Promise.resolve()) };
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    writable: true,
    value: clipboardMock,
  });
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  while (mountedRoots.length > 0) {
    const root = mountedRoots.pop()!;
    act(() => root.unmount());
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  // 数学渲染器/缓存恢复出厂（模块级单例，必须清理防串扰）
  setMathRenderer(null);
  clearMathRenderCache();
  // 清自定义 lang 注册（内置 json/diff/log 出厂注册不动）
  for (const lang of [...FenceLangRendererRegistry.keys()]) {
    if (!['json', 'diff', 'log'].includes(lang)) {
      unregisterFenceLangRenderer(lang);
    }
  }
});

// —— 渲染工具 ——

/** 挂载 BlockRenderer（含显式 store 实例，fence 上下文订阅消费） */
function mountBlock(
  block: Partial<LineNode> & { type: LineNode['type'] },
  extra: {
    index?: number;
    lineOffset?: number;
    store?: ReturnType<typeof createEditorStore>;
  } = {}
): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  const fullBlock: LineNode = {
    id: 't',
    raw: '',
    inlineTokens: [],
    length: 0,
    localOffset: 0,
    ...block,
  };
  act(() => {
    root.render(
      React.createElement(BlockRenderer, {
        block: fullBlock,
        index: extra.index ?? 0,
        lineOffset: extra.lineOffset ?? 0,
        activeState: null,
        store: extra.store,
      })
    );
  });
  return container;
}

/** store 初始化 + 取行节点（parseLine 同渲染路径） */
function storeWithText(text: string) {
  const store = createEditorStore();
  store.getState().setText(text);
  return store;
}

function lineNode(
  store: ReturnType<typeof createEditorStore>,
  idx: number,
  codeState: CodeState
): LineNode {
  const s = store.getState();
  return MarkdownParser.parseLine(
    s.getLine(idx),
    s.lineOffsets.getOffset(idx),
    codeState
  );
}

/** 行全局偏移（与 LineItem 传 BlockRenderer 的 lineOffset 一致） */
function offsetOf(store: ReturnType<typeof createEditorStore>, idx: number): number {
  return store.getState().lineOffsets.getOffset(idx);
}

/** 点击元素（act 包裹：按钮点击含 copied 状态更新） */
function click(el: Element) {
  act(() => {
    el.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
  });
}

// =====================================================================
// 1. renderToHtml 投影器（B4 N5）
// =====================================================================

describe('renderToHtml 投影器', () => {
  it('与 astToHtml 一致性：无 math 文档输出完全等价（双实现同步红线）', () => {
    const md = [
      '# 标题',
      '',
      '段落一 **加粗** 与 `代码` 与 ~~删除~~ 与 ==高亮== 与 ||剧透|| 与 [^1] 与 <kbd>K</kbd>',
      '',
      '> 引用文本',
      '',
      '- 项一',
      '- 项二',
      '- [x] 已完成',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '    a simple',
      '      indented code',
      '',
      '<div class="x">hi</div>',
      '',
      '---',
      '',
      '[链接](/url "title") 与 ![图](/img.png)',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');
    const doc = MarkdownParser.parse(md);
    expect(renderToHtml(doc)).toBe(astToHtml(doc));
  });

  it('与 astToHtml 一致性：列表/引用/表格/围栏组合文档等价', () => {
    const md = [
      '> 列表内引用',
      '',
      '3. first',
      '4. second',
      '',
      '> > 嵌套引用',
      '> > # 标题',
      '',
      '```',
      '// 注释',
      'const x = 1;',
      '```',
    ].join('\n');
    const doc = MarkdownParser.parse(md);
    expect(renderToHtml(doc)).toBe(astToHtml(doc));
  });

  it('math：占位 → KaTeX 真实渲染（默认注入点，与 astToHtml 差异仅限 math）', () => {
    const md = ['行内 $E=mc^2$ 公式', '', '$$', '\\int_0^1 x\\,dx', '$$'].join('\n');
    const doc = MarkdownParser.parse(md);
    const placeholder = astToHtml(doc);
    const rendered = renderToHtml(doc);
    // astToHtml 保持占位（CommonMark 无 math 语义，显式暴露差异）
    expect(placeholder).toContain('<span class="math">');
    // renderToHtml 升级为 KaTeX 实际渲染（默认注入点输出 katex 标记）
    expect(rendered).toContain('class="math math-rendered"');
    expect(rendered).toContain('katex');
    // 公式体文本进入输出（KaTeX 渲染结果含源文本）
    expect(rendered).toContain('E=mc^2');
  });

  it('math 渲染经 renderTheme 注入点（mock 渲染器确定性断言）', () => {
    const md = ['行内 $x^2$ 与块级', '', '$$', 'E=mc^2', '$$'].join('\n');
    const doc = MarkdownParser.parse(md);
    const mock = vi.fn(
      (formula: string, display: boolean) => `MOCK[${formula}|${display}]`
    );
    setMathRenderer(mock);
    const html = renderToHtml(doc);
    // 行内 math：raw 非 $$ 开头 → inline（display=false）；块级围栏 → display=true
    expect(html).toContain('MOCK[x^2|false]');
    expect(html).toContain('MOCK[E=mc^2|true]');
    expect(mock).toHaveBeenCalledWith('x^2', false);
    expect(mock).toHaveBeenCalledWith('E=mc^2', true);
  });

  it('引擎扩展语法映射为语义 HTML（mark/spoiler/footnote/checkbox）', () => {
    // 注：列表任务行（- [x]）的 checkbox 语义在 list_task 标记 token 内，
    // 不产出独立 checkbox token——此处用正文行内的 [x]/[ ] 验证映射
    const md = ['==高亮== 与 ||剧透|| 与 [^1] 与 [x] 与 [ ]'].join('\n');
    const doc = MarkdownParser.parse(md);
    const html = renderToHtml(doc);
    expect(html).toContain('<mark>高亮</mark>');
    expect(html).toContain('<span class="spoiler">剧透</span>');
    expect(html).toContain('<span class="footnote">1</span>');
    expect(html).toContain('<input type="checkbox" checked="" disabled="" />');
    expect(html).toContain('<input type="checkbox" disabled="" />');
  });
});

// =====================================================================
// 2. fence lang 渲染器注册表（B4 N4）
// =====================================================================

describe('fence lang 渲染器注册表', () => {
  it('默认出厂注册 json/diff/log；未注册 lang 解析为 null', () => {
    expect(resolveFenceLangRenderer('json')).not.toBeNull();
    expect(resolveFenceLangRenderer('diff')).not.toBeNull();
    expect(resolveFenceLangRenderer('log')).not.toBeNull();
    expect(resolveFenceLangRenderer('js')).toBeNull();
    expect(resolveFenceLangRenderer('ts')).toBeNull();
  });

  it('自定义注册/覆盖/移除恢复（markdown-it at 语义）', () => {
    const custom = (p: FenceLangRendererProps) =>
      React.createElement('span', { className: 'custom-lang-renderer' }, `自定义:${p.lineText}`);
    registerFenceLangRenderer('mylang', custom);
    expect(resolveFenceLangRenderer('mylang')).toBe(custom);
    const custom2 = (p: FenceLangRendererProps) =>
      React.createElement('span', { className: 'custom-lang-renderer-v2' }, `v2:${p.lineText}`);
    registerFenceLangRenderer('mylang', custom2);
    expect(resolveFenceLangRenderer('mylang')).toBe(custom2);
    // 移除 → 未注册（删除条目）
    expect(unregisterFenceLangRenderer('mylang')).toBe(true);
    expect(resolveFenceLangRenderer('mylang')).toBeNull();
    // 未注册移除返回 false
    expect(unregisterFenceLangRenderer('mylang')).toBe(false);
    // 内置 lang 移除恢复出厂（条目不删除）
    expect(unregisterFenceLangRenderer('json')).toBe(true);
    expect(resolveFenceLangRenderer('json')).not.toBeNull();
  });

  it('BlockRenderer fence 分支按 lang 分发：注册 lang 走专用渲染器', () => {
    const store = storeWithText('```json\n{"a": 1}\n```');
    const container = mountBlock(lineNode(store, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store, 1),
      store,
    });
    expect(container.querySelector('[data-fence-lang]')).not.toBeNull();
    expect(container.querySelector('[data-lang-renderer="json"]')).not.toBeNull();
    expect(container.querySelector('[data-fence-lang="json"]')).not.toBeNull();
  });

  it('未注册 lang（ts）走默认代码渲染（无 lang 渲染容器）', () => {
    const store = storeWithText('```ts\nconst a = 1;\n```');
    const container = mountBlock(lineNode(store, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store, 1),
      store,
    });
    expect(container.querySelector('[data-fence-lang]')).toBeNull();
    expect(container.querySelector('.line-code')).not.toBeNull();
  });

  it('自定义 lang 渲染器分发 + props 契约（lines/lineIndex/lineText/lineOffset）', () => {
    const store = storeWithText('```mylang\nline one\nline two\n```');
    const received: FenceLangRendererProps[] = [];
    const collector = (p: FenceLangRendererProps) => {
      received.push(p);
      return React.createElement(
        'span',
        { className: 'collector-out' },
        `L${p.lineIndex}:${p.lineText}`
      );
    };
    registerFenceLangRenderer('mylang', collector);
    const container = mountBlock(lineNode(store, 2, 'code'), {
      index: 2,
      lineOffset: offsetOf(store, 2),
      store,
    });
    expect(container.querySelector('.collector-out')?.textContent).toBe('L1:line two');
    expect(received[0]).toMatchObject({
      lang: 'mylang',
      lines: ['line one', 'line two'],
      lineIndex: 1,
      lineText: 'line two',
      lineOffset: offsetOf(store, 2),
    });
  });

  it('内置渲染器冒烟：json 键名着色 / diff 红绿 / log 级别着色', () => {
    // json：键名字符串带蓝色 span
    const jsonStore = storeWithText('```json\n{"a": 1}\n```');
    const jc = mountBlock(lineNode(jsonStore, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(jsonStore, 1),
      store: jsonStore,
    });
    expect(jc.querySelector('[data-lang-renderer="json"]')).not.toBeNull();
    // diff：+ 行 diff-add / - 行 diff-del / 上下文无前缀类
    const diffStore = storeWithText('```diff\n+ added\n- removed\n ctx\n```');
    const pc = mountBlock(lineNode(diffStore, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(diffStore, 1),
      store: diffStore,
    });
    expect(pc.querySelector('[data-lang-renderer="diff"][data-diff-class="add"]')).not.toBeNull();
    const mc = mountBlock(lineNode(diffStore, 2, 'code'), {
      index: 2,
      lineOffset: offsetOf(diffStore, 2),
      store: diffStore,
    });
    expect(mc.querySelector('[data-lang-renderer="diff"][data-diff-class="del"]')).not.toBeNull();
    const cc = mountBlock(lineNode(diffStore, 3, 'code'), {
      index: 3,
      lineOffset: offsetOf(diffStore, 3),
      store: diffStore,
    });
    expect(cc.querySelector('[data-lang-renderer="diff"][data-diff-class="context"]')).not.toBeNull();
    // log：ERROR 行 error 级 / INFO 行 info 级
    const logStore = storeWithText('```log\n2026-08-10 12:00:00 ERROR boom\n[INFO] ok\n```');
    const ec = mountBlock(lineNode(logStore, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(logStore, 1),
      store: logStore,
    });
    expect(ec.querySelector('[data-lang-renderer="log"][data-log-level="error"]')).not.toBeNull();
    const ic = mountBlock(lineNode(logStore, 2, 'code'), {
      index: 2,
      lineOffset: offsetOf(logStore, 2),
      store: logStore,
    });
    expect(ic.querySelector('[data-lang-renderer="log"][data-log-level="info"]')).not.toBeNull();
  });
});

// =====================================================================
// 3. 代码块/公式复制按钮（B4 N5）
// =====================================================================

describe('复制按钮', () => {
  it('代码块复制：fence 首行内容锚点按钮，点击复制整块 raw（navigator.clipboard）', () => {
    const store = storeWithText('```ts\nconst a = 1;\nconst b = 2;\n```');
    const container = mountBlock(lineNode(store, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store, 1),
      store,
    });
    const btn = container.querySelector('[data-copy-button="code"]');
    expect(btn).not.toBeNull();
    click(btn!);
    expect(clipboardMock.writeText).toHaveBeenCalledTimes(1);
    expect(clipboardMock.writeText).toHaveBeenCalledWith(
      'const a = 1;\nconst b = 2;'
    );
  });

  it('非首行内容行不渲染复制按钮（避免逐行噪音）', () => {
    const store = storeWithText('```ts\nconst a = 1;\nconst b = 2;\n```');
    const container = mountBlock(lineNode(store, 2, 'code'), {
      index: 2,
      lineOffset: offsetOf(store, 2),
      store,
    });
    expect(container.querySelector('[data-copy-button="code"]')).toBeNull();
  });

  it('缩进代码行 / 未闭合围栏（软渲染）无复制按钮', () => {
    // 缩进代码（indent_code 状态）：非 fence 内容，无上下文
    const store = storeWithText('    const a = 1;\n');
    const c1 = mountBlock(lineNode(store, 0, 'indent_code'), {
      index: 0,
      lineOffset: offsetOf(store, 0),
      store,
    });
    expect(c1.querySelector('[data-copy-button="code"]')).toBeNull();
    // 未闭合围栏：软渲染，无按钮
    const store2 = storeWithText('```ts\nconst a = 1;');
    const c2 = mountBlock(lineNode(store2, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store2, 1),
      store: store2,
    });
    expect(c2.querySelector('[data-copy-button="code"]')).toBeNull();
    expect(c2.querySelector('.is-soft-render')).not.toBeNull();
  });

  it('公式复制：常驻预览所在的起始围栏复制完整 LaTeX 源', () => {
    const store = storeWithText('$$\nE=mc^2\n$$');
    const container = mountBlock(lineNode(store, 0, 'math_fence_start'), {
      index: 0,
      lineOffset: offsetOf(store, 0),
      store,
    });
    const btn = container.querySelector('[data-copy-button="math"]');
    expect(btn).not.toBeNull();
    click(btn!);
    expect(clipboardMock.writeText).toHaveBeenCalledWith('E=mc^2');
  });

  it('未闭合 math 围栏（软渲染）无公式复制按钮', () => {
    const store = storeWithText('$$\nE=mc^2');
    const container = mountBlock(lineNode(store, 0, 'math_fence_start'), {
      index: 0,
      lineOffset: offsetOf(store, 0),
      store,
    });
    expect(container.querySelector('[data-copy-button="math"]')).toBeNull();
    expect(container.querySelector('.is-soft-render')).not.toBeNull();
  });
});

// =====================================================================
// 4. readOnly 复制为 Markdown（N9）
// =====================================================================

describe('readOnly 复制为 Markdown（N9）', () => {
  it('domRangeToSourceOffsets：普通 token + 样式 token 子偏移精确映射（跨行）', () => {
    // 行 0：'hello'（token 0..5）；行 1：'**bold**'（token 5..13，子偏移结构）
    const row0 = document.createElement('div');
    row0.setAttribute('data-line-start', '0');
    row0.setAttribute('data-line-length', '5');
    const t0 = document.createElement('span');
    t0.setAttribute('data-token-start', '0');
    t0.setAttribute('data-token-length', '5');
    t0.textContent = 'hello';
    row0.appendChild(t0);
    const row1 = document.createElement('div');
    row1.setAttribute('data-line-start', '5');
    row1.setAttribute('data-line-length', '8');
    const t1 = document.createElement('span');
    t1.setAttribute('data-token-start', '5');
    t1.setAttribute('data-token-length', '8');
    const pre = document.createElement('span');
    pre.setAttribute('data-sub-offset', '0');
    pre.textContent = '**';
    const mid = document.createElement('span');
    mid.setAttribute('data-sub-offset', '2');
    mid.textContent = 'bold';
    const suf = document.createElement('span');
    suf.setAttribute('data-sub-offset', '6');
    suf.textContent = '**';
    t1.append(pre, mid, suf);
    row1.appendChild(t1);
    document.body.append(row0, row1);

    // 选区：'hello' 偏移 1 → 'bold' 偏移 2（源码 [1, 5+2+2)）
    const range = document.createRange();
    range.setStart(t0.firstChild!, 1);
    range.setEnd(mid.firstChild!, 2);
    expect(domRangeToSourceOffsets(range)).toEqual({ from: 1, to: 9 });
  });

  it('domRangeToSourceOffsets：元素子节点偏移 / KaTeX 整 token / 映射失败', () => {
    const row = document.createElement('div');
    row.setAttribute('data-line-start', '0');
    row.setAttribute('data-line-length', '20');
    const a = document.createElement('span');
    a.setAttribute('data-token-start', '0');
    a.setAttribute('data-token-length', '5');
    a.textContent = 'aaaaa';
    // KaTeX 合成内容：math wrapper 内 math-preview 无子偏移 → 整 token 边界
    const mathWrap = document.createElement('span');
    mathWrap.setAttribute('data-token-start', '5');
    mathWrap.setAttribute('data-token-length', '8');
    mathWrap.setAttribute('data-source-role', 'atomic');
    const preview = document.createElement('span');
    preview.setAttribute('data-source-role', 'preview');
    preview.textContent = 'x+y';
    mathWrap.appendChild(preview);
    const br = document.createElement('br');
    row.append(a, mathWrap, br);
    document.body.appendChild(row);

    // 元素容器 offset=0（第 0 子节点前）→ 递归到行 0 起点
    const r1 = document.createRange();
    r1.setStart(row, 0);
    r1.setEnd(a.firstChild!, 2);
    expect(domRangeToSourceOffsets(r1)).toEqual({ from: 0, to: 2 });

    // KaTeX 内部：起始 → token 起点 5，结束 → token 终点 13（整 token 语义）
    const r2 = document.createRange();
    r2.setStart(preview.firstChild!, 1);
    r2.setEnd(preview.firstChild!, 3);
    expect(domRangeToSourceOffsets(r2)).toEqual({ from: 5, to: 13 });

    // 元素末尾（offset = 全部子节点之后）→ 最后子节点结束（br → 行级兜底）
    const r3 = document.createRange();
    r3.setStart(a.firstChild!, 1);
    r3.setEnd(row, row.childNodes.length);
    const span3 = domRangeToSourceOffsets(r3);
    expect(span3).not.toBeNull();
    expect(span3!.from).toBe(1);
    expect(span3!.to).toBeGreaterThanOrEqual(1);

    // 映射失败：无任何 data-* 的游离节点 → null
    const stray = document.createElement('span');
    stray.textContent = 'zz';
    document.body.appendChild(stray);
    const r4 = document.createRange();
    r4.setStart(stray.firstChild!, 1);
    r4.setEnd(stray.firstChild!, 2);
    expect(domRangeToSourceOffsets(r4)).toBeNull();
  });

  it('selectionToMarkdown：折叠选区/无 range/无法映射返回 null；正常选区切源码', () => {
    const row = document.createElement('div');
    row.setAttribute('data-line-start', '0');
    row.setAttribute('data-line-length', '5');
    const span = document.createElement('span');
    span.setAttribute('data-token-start', '0');
    span.setAttribute('data-token-length', '5');
    span.textContent = 'hello';
    row.appendChild(span);
    document.body.appendChild(row);

    const getText = () => 'hello';
    const range = document.createRange();
    range.setStart(span.firstChild!, 1);
    range.setEnd(span.firstChild!, 4);
    const fakeSel = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
    };
    expect(selectionToMarkdown(fakeSel, getText)).toBe('ell');
    // 折叠选区 → null
    expect(
      selectionToMarkdown(
        { isCollapsed: true, rangeCount: 1, getRangeAt: () => range },
        getText
      )
    ).toBeNull();
    // 无 range → null
    expect(
      selectionToMarkdown(
        { isCollapsed: false, rangeCount: 0, getRangeAt: () => range },
        getText
      )
    ).toBeNull();
  });

  it('MarkdownEngine readOnly onCopy：DOM 选区 → 剪贴板写入 Markdown 源码（拦截默认渲染文本复制）', () => {
    const store = createEditorStore();
    store.getState().setText('第一行\n**加粗**\n第三行');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
      root.render(React.createElement(MarkdownEngine, { store, readOnly: true }));
    });

    // 虚拟化行已渲染（jsdom 无布局：假 ResizeObserver 上报尺寸收敛窗口）
    expect(container.querySelectorAll('.virtual-row').length).toBeGreaterThan(0);

    // 行 0 文本 token（data-token-start=0）；行 1 '**加粗**' 的加粗内容
    // 由嵌套子 token 渲染（data-token-start=6，源码偏移 4+2）——子 token
    // 文本节点即源码内容（映射走内层 token 起始 + 文本偏移）
    const row0Token = container.querySelector('[data-token-start="0"]');
    const boldInner = container.querySelector('[data-token-start="6"]');
    expect(row0Token).not.toBeNull();
    expect(boldInner).not.toBeNull();

    // 构建原生选区：行 0 '第一行' 偏移 1 → 行 1 '加粗' 偏移 2
    // 源码区间 [1, 6+2) = [1, 8) → '一行\n**加粗'
    const sel = document.getSelection();
    expect(sel).not.toBeNull();
    sel!.removeAllRanges();
    const range = document.createRange();
    range.setStart(row0Token!.firstChild!, 1);
    range.setEnd(boldInner!.firstChild!, 2);
    sel!.addRange(range);

    // 派发 copy（jsdom ClipboardEvent 无 clipboardData，属性注入兜底）
    const dt = { setData: vi.fn() };
    const ev = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: dt });
    act(() => {
      container.querySelector('.editor-container')!.dispatchEvent(ev);
    });

    // readOnly 拦截默认复制：剪贴板写入 Markdown 源码
    expect(dt.setData).toHaveBeenCalledWith('text/plain', '一行\n**加粗');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('编辑态 onCopy 保持既有行为：store 选区 → 源码切片（重构回归护栏）', () => {
    const store = createEditorStore();
    store.getState().setText('hello world');
    store.getState().setSelection(0, 5);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
      root.render(React.createElement(MarkdownEngine, { store }));
    });

    // 既有语义：处理器以原生选区非折叠为闸门，切片取自 store 选区——
    // 先构造原生选区（行 0 文本 token），再派发 copy
    const token = container.querySelector('[data-token-start="0"]');
    expect(token).not.toBeNull();
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(token!.firstChild!, 1);
    range.setEnd(token!.firstChild!, 3);
    sel.addRange(range);

    const dt = { setData: vi.fn() };
    const ev = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: dt });
    act(() => {
      container.querySelector('.editor-container')!.dispatchEvent(ev);
    });
    expect(dt.setData).toHaveBeenCalledWith('text/plain', 'hello');
    expect(ev.defaultPrevented).toBe(true);
  });
});

