// tests/unit/stream-lang-lazy.test.ts
// W2-3（C2）LangRenderer O(块) lines 重建惰性化
// （docs/streaming-render/00-流式渲染极致化总方案.md：S-T-2-06）
//
// 覆盖：
// - S-T-2-06：千行代码块「两次渲染同一块不重复构建」——同一围栏区间内
//   多次渲染（滚动入窗不同行 / 同行为新挂载重渲染）只构建一次整块
//   lines 数组，后续渲染缓存命中（数组引用 === + 区间 getLine 调用数
//   不随块大小增长）；区间内内容编辑 / 区间边界变化 / undo 恢复均正确
//   失效重建（内容最新、无陈旧缓存）。
// - 回归：json/diff/log 三个出厂渲染器经 CodeBlock 全链路输出不变
//   （外链快照断言；既有 render-export.test.ts 门禁回归兜底）。
// - lines 语义不变：块引用前缀剥离（> 前缀行）与旧内联循环逐位一致。
//
// 纪律：与 stream-soft-render.test.ts 同款挂载协议（jsdom + 显式 store
// 实例 + afterEach 统一卸载）；注册的自定义 lang 渲染器 afterEach 卸载，
// 不污染全局注册表。
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import { MarkdownParser } from '../../src/core/parser';
import type { CodeState } from '../../src/core/parser';
import {
  BlockRenderer,
  registerFenceLangRenderer,
  unregisterFenceLangRenderer,
  type FenceLangRendererProps,
} from '../../src/components/BlockRenderer';
import { createEditorStore } from '../../src/core/EditorStore';
import type { LineNode } from '../../src/core/ast';

// React 19 act 要求显式声明测试环境（与 stream-soft-render.test.ts 同款）
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// —— 挂载生命周期管理（全部挂载实例 afterEach 统一卸载，防跨用例污染）——
const mountedRoots: Root[] = [];
const registeredLangs: string[] = [];

afterEach(() => {
  while (mountedRoots.length > 0) {
    const root = mountedRoots.pop()!;
    act(() => root.unmount());
  }
  while (registeredLangs.length > 0) {
    unregisterFenceLangRenderer(registeredLangs.pop()!);
  }
  document.body.innerHTML = '';
});

// —— 渲染工具（与 stream-soft-render.test.ts 同款）——

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

/** store 初始化（setText 走渲染同路径状态机，fence 开闭状态随之维护） */
function storeWithText(text: string) {
  const store = createEditorStore();
  store.getState().setText(text);
  return store;
}

/** 取行节点（parseLine 同渲染路径：code 状态 = 代码块内容行） */
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
function offsetOf(
  store: ReturnType<typeof createEditorStore>,
  idx: number
): number {
  return store.getState().lineOffsets.getOffset(idx);
}

/** 注册探针 lang 渲染器：捕获每次收到的 lines 数组引用（缓存命中 =
 *  同一引用，重建 = 新引用）。返回捕获列表（每次渲染 push 一条）。 */
function registerProbeLang(): FenceLangRendererProps['lines'][] {
  const captured: FenceLangRendererProps['lines'][] = [];
  registerFenceLangRenderer('probe', (props) => {
    captured.push(props.lines);
    return React.createElement(
      'span',
      { 'data-lang-renderer': 'probe' },
      props.lineText
    );
  });
  registeredLangs.push('probe');
  return captured;
}

// —— 快照颜色归一化（W2-3 回归断言）——
// jsdom 的 style 序列化把源码字面量 hsl(...) 输出为 rgb(...)（CSSOM 规范
// 行为），外链快照若按源码字面量精确比较必然失败；归一化把 hsl()/rgb()
// 一律换算为规范 rgb 三元组（hsl→rgb 标准公式，与 jsdom 解析结果逐位
// 一致）再比较——结构、颜色语义（三色）与顺序的断言强度不变，仅消除
// 「序列化格式」这一非语义差异。
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) =>
    ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [
    Math.round(255 * f(0)),
    Math.round(255 * f(8)),
    Math.round(255 * f(4)),
  ];
}

/** 单个 style 颜色值归一化为规范 rgb 字符串（hsl 空格语法与 rgb 均可） */
function normalizeColorValue(value: string): string {
  const hsl = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(
    value.trim()
  );
  if (hsl) {
    const [r, g, b] = hslToRgb(
      parseFloat(hsl[1]),
      parseFloat(hsl[2]),
      parseFloat(hsl[3])
    );
    return `rgb(${r}, ${g}, ${b})`;
  }
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value.trim());
  if (rgb) return `rgb(${rgb[1]}, ${rgb[2]}, ${rgb[3]})`;
  return value;
}

/** HTML 字符串级颜色归一化：替换全部 style 颜色值（快照断言入口） */
function normalizeColorHtml(html: string): string {
  return html.replace(
    /color:\s*(hsl\([^)]*\)|rgb\([^)]*\))/g,
    (_m, c: string) => `color: ${normalizeColorValue(c)}`
  );
}

// =====================================================================
// W2-3 S-T-2-06：千行块重复渲染不重建整块 lines（缓存命中）
// =====================================================================

describe('W2-3 惰性 lines 缓存（S-T-2-06）', () => {
  it('千行块滚动入窗/重复渲染缓存命中：同一数组引用 + 区间 getLine 调用数不随块大小增长', async () => {
    const contentLines = Array.from(
      { length: 1000 },
      (_, i) => `{"n": ${i + 1}}`
    );
    const store = storeWithText(
      '```probe\n' + contentLines.join('\n') + '\n```'
    );
    // setText 对 > FIRST_CHUNK_LINES(1000) 行文档走分块加载（EditorStore
    // 大文件路径）：首块 1000 行同步载入，续块（含 fence_end）经定时器
    // 异步续载——fence_end 未达时 useFenceContext 判未闭合围栏返回 null，
    // 渲染器不触发。等文档全量行数（1000 内容 + 2 围栏行 = 1002）就绪
    // 再挂载，fence 闭合后 probe 渲染器才会被调用。
    await vi.waitFor(() => {
      expect(store.getState().getLineCount()).toBe(1002);
    });
    const captured = registerProbeLang();

    // 行节点先建（parseLine 内部也会 getLine，不计入区间构建口径）
    const block1 = lineNode(store, 1, 'code');
    const block500 = lineNode(store, 500, 'code');
    const s = store.getState();
    const getLineSpy = vi.spyOn(s, 'getLine');

    // 首次渲染（首条内容行）：整块构建一次 → 区间内 getLine 调用 ≈ 1000
    mountBlock(block1, { index: 1, lineOffset: offsetOf(store, 1), store });
    expect(captured.length).toBe(1);
    expect(captured[0].length).toBe(1000);
    expect(getLineSpy.mock.calls.length).toBeGreaterThanOrEqual(1000);

    // 滚动入窗渲染行 500：缓存命中 → 同一数组引用、区间 getLine 调用不增长
    getLineSpy.mockClear();
    mountBlock(block500, {
      index: 500,
      lineOffset: offsetOf(store, 500),
      store,
    });
    expect(captured.length).toBe(2);
    expect(captured[1]).toBe(captured[0]);
    expect(getLineSpy.mock.calls.length).toBeLessThan(50);

    // 再次渲染行 1（新挂载重渲染）：仍是同一引用（不重建）
    mountBlock(block1, { index: 1, lineOffset: offsetOf(store, 1), store });
    expect(captured[2]).toBe(captured[0]);

    // 内容正确性抽查
    expect(captured[0][0]).toBe('{"n": 1}');
    expect(captured[0][999]).toBe('{"n": 1000}');

    getLineSpy.mockRestore();
  });

  it('区间内内容编辑失效重建；undo 恢复同样失效（version 盲区不受影响）', () => {
    const contentLines = Array.from(
      { length: 200 },
      (_, i) => `{"n": ${i + 1}}`
    );
    const store = storeWithText(
      '```probe\n' + contentLines.join('\n') + '\n```'
    );
    const captured = registerProbeLang();

    mountBlock(lineNode(store, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store, 1),
      store,
    });
    const idA = captured[0];
    expect(idA.length).toBe(200);

    // 区间内内容编辑（无换行插入 → 区间不变，仅行文本变化）
    store.getState().setCursorPos(offsetOf(store, 3));
    store.getState().insertText('// EDITED ');
    mountBlock(lineNode(store, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store, 1),
      store,
    });
    // 引用变化 → 失效重建：新数组 + 内容最新 + 区间不变
    expect(captured[1]).not.toBe(idA);
    expect(captured[1].length).toBe(200);
    expect(captured[1][2]).toBe('// EDITED {"n": 3}');

    // undo 恢复（version 不递增，数组引用必变）：重建 + 内容复原（无陈旧缓存）
    store.getState().undo();
    mountBlock(lineNode(store, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store, 1),
      store,
    });
    expect(captured[2]).not.toBe(captured[1]);
    expect(captured[2][2]).toBe('{"n": 3}');
  });

  it('区间边界变化（围栏内插入新行 → contentEnd 位移）换键重建', () => {
    const contentLines = Array.from(
      { length: 200 },
      (_, i) => `{"n": ${i + 1}}`
    );
    const store = storeWithText(
      '```probe\n' + contentLines.join('\n') + '\n```'
    );
    const captured = registerProbeLang();

    mountBlock(lineNode(store, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store, 1),
      store,
    });
    const idA = captured[0];
    expect(idA.length).toBe(200);

    // 在 fence_end 行首插入 'extra\n' → 新内容行，fence_end 后移
    store.getState().setCursorPos(offsetOf(store, 201));
    store.getState().insertText('extra\n');
    mountBlock(lineNode(store, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store, 1),
      store,
    });
    // 键变化（contentEnd 201 → 202）→ 重建：行数 +1 且新行内容正确
    expect(captured[1]).not.toBe(idA);
    expect(captured[1].length).toBe(201);
    expect(captured[1][200]).toBe('extra');
  });
});

// =====================================================================
// W2-3 回归：出厂 lang 渲染器输出不变（外链快照断言）
// =====================================================================

describe('W2-3 回归：json/diff/log 渲染器输出不变', () => {
  it('json 渲染器输出快照不变（键名蓝 / 字符串绿 / 数值紫 / 布尔橙 / 标点灰）', () => {
    const store = storeWithText('```json\n{"a": 1, "b": true, "c": "x"}\n```');
    const container = mountBlock(lineNode(store, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store, 1),
      store,
    });
    expect(
      normalizeColorHtml(
        container.querySelector('[data-lang-renderer="json"]')?.outerHTML ?? ''
      )
    ).toBe(
      normalizeColorHtml(
        '<span data-lang-renderer="json" style="white-space: pre;"><span style="color: hsl(0 0% 55%);">{</span><span style="color: hsl(200 60% 55%);">"a"</span><span style="color: hsl(0 0% 55%);">:</span> <span style="color: hsl(260 50% 60%);">1</span><span style="color: hsl(0 0% 55%);">,</span> <span style="color: hsl(200 60% 55%);">"b"</span><span style="color: hsl(0 0% 55%);">:</span> <span style="color: hsl(30 80% 55%);">true</span><span style="color: hsl(0 0% 55%);">,</span> <span style="color: hsl(200 60% 55%);">"c"</span><span style="color: hsl(0 0% 55%);">:</span> <span style="color: hsl(120 35% 50%);">"x"</span><span style="color: hsl(0 0% 55%);">}</span></span>'
      )
    );
  });

  it('diff 渲染器输出快照不变（+ 绿 / - 红 / @@ 青 / 上下文无色）', () => {
    const store = storeWithText(
      '```diff\n+ added line\n- removed line\n@@ -1,2 +1,2 @@\n  context line\n```'
    );
    const add = mountBlock(lineNode(store, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store, 1),
      store,
    });
    expect(
      normalizeColorHtml(
        add.querySelector('[data-diff-class="add"]')?.outerHTML ?? ''
      )
    ).toBe(
      normalizeColorHtml(
        '<span data-lang-renderer="diff" data-diff-class="add" style="white-space: pre; color: hsl(120 60% 42%);">+ added line</span>'
      )
    );
    const del = mountBlock(lineNode(store, 2, 'code'), {
      index: 2,
      lineOffset: offsetOf(store, 2),
      store,
    });
    expect(
      normalizeColorHtml(
        del.querySelector('[data-diff-class="del"]')?.outerHTML ?? ''
      )
    ).toBe(
      normalizeColorHtml(
        '<span data-lang-renderer="diff" data-diff-class="del" style="white-space: pre; color: hsl(0 65% 50%);">- removed line</span>'
      )
    );
    const hunk = mountBlock(lineNode(store, 3, 'code'), {
      index: 3,
      lineOffset: offsetOf(store, 3),
      store,
    });
    expect(
      normalizeColorHtml(
        hunk.querySelector('[data-diff-class="hunk"]')?.outerHTML ?? ''
      )
    ).toBe(
      normalizeColorHtml(
        '<span data-lang-renderer="diff" data-diff-class="hunk" style="white-space: pre; color: hsl(200 70% 45%);">@@ -1,2 +1,2 @@</span>'
      )
    );
    const ctx = mountBlock(lineNode(store, 4, 'code'), {
      index: 4,
      lineOffset: offsetOf(store, 4),
      store,
    });
    expect(
      normalizeColorHtml(
        ctx.querySelector('[data-diff-class="context"]')?.outerHTML ?? ''
      )
    ).toBe(
      normalizeColorHtml(
        '<span data-lang-renderer="diff" data-diff-class="context" style="white-space: pre;">  context line</span>'
      )
    );
  });

  it('log 渲染器输出快照不变（时间戳弱化 + 级别着色）', () => {
    const store = storeWithText(
      '```log\n2026-08-11 10:00:00.123 ERROR boom\n2026-08-11 10:00:01 INFO ok\nplain line\n```'
    );
    const err = mountBlock(lineNode(store, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store, 1),
      store,
    });
    expect(
      normalizeColorHtml(
        err.querySelector('[data-log-level="error"]')?.outerHTML ?? ''
      )
    ).toBe(
      normalizeColorHtml(
        '<span data-lang-renderer="log" data-log-level="error" style="white-space: pre;"><span style="color: hsl(0 0% 60%);">2026-08-11 10:00:00.123</span><span style="color: hsl(0 65% 50%);"> ERROR boom</span></span>'
      )
    );
    const info = mountBlock(lineNode(store, 2, 'code'), {
      index: 2,
      lineOffset: offsetOf(store, 2),
      store,
    });
    expect(
      normalizeColorHtml(
        info.querySelector('[data-log-level="info"]')?.outerHTML ?? ''
      )
    ).toBe(
      normalizeColorHtml(
        '<span data-lang-renderer="log" data-log-level="info" style="white-space: pre;"><span style="color: hsl(0 0% 60%);">2026-08-11 10:00:01</span><span style="color: hsl(200 70% 45%);"> INFO ok</span></span>'
      )
    );
    const plain = mountBlock(lineNode(store, 3, 'code'), {
      index: 3,
      lineOffset: offsetOf(store, 3),
      store,
    });
    expect(
      normalizeColorHtml(
        plain.querySelector('[data-log-level="other"]')?.outerHTML ?? ''
      )
    ).toBe(
      normalizeColorHtml(
        '<span data-lang-renderer="log" data-log-level="other" style="white-space: pre;">plain line</span>'
      )
    );
  });
});

// =====================================================================
// W2-3 lines 语义不变（块引用前缀剥离）
// =====================================================================

describe('W2-3 lines 语义不变（块引用前缀剥离）', () => {
  it('块引用围栏内容行经惰性构建剥 > 前缀（与旧内联循环逐位一致）', () => {
    const store = storeWithText('> ```probe\n> {"a": 1}\n> {"b": 2}\n> ```');
    const captured = registerProbeLang();
    mountBlock(lineNode(store, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store, 1),
      store,
    });
    expect(captured[0]).toEqual(['{"a": 1}', '{"b": 2}']);
  });
});
