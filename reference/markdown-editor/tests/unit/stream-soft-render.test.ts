// tests/unit/stream-soft-render.test.ts
// W0-3（C5）软渲染复用三色 token（docs/streaming-render/00-流式渲染极致化总方案.md：
// S-EL-03 / S-T-0-04 / S-T-0-05，R-9 裁决 = jsdom DOM 序列化比较）
//
// 覆盖：
// - S-T-0-04：fence 未闭合（软渲染）代码行渲染输出含 keyword/comment/string
//   三色 class（parseCodeLine 已生成的 token 经 InlineRenderer 渲染，不再
//   纯文本零高亮）；软渲染标记 is-soft-render 与行级 data-token 覆盖保留
//   （测量/选区依赖，BlockRenderer.tsx 软渲染分支）。
// - S-T-0-05：同一行文本在闭合前（软渲染）与闭合后（常规路径）的 DOM 序列化
//   diff：仅容器差异（is-soft-render class + 行级包裹 span），token 结构
//   逐位一致——软/硬渲染同源同色，闭合切换零跳变的可验证依据。
// - S-T-0-07 联动：display-completion（预演补全）不触碰代码行渲染路径，
//   既有 display-completion / render-export 断言经门禁回归覆盖。
//
// 纪律：与 render-export.test.ts 同款挂载协议（jsdom + 显式 store 实例 +
// afterEach 统一卸载），不污染全局单例。
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import { MarkdownParser } from '../../src/core/parser';
import type { CodeState } from '../../src/core/parser';
import { BlockRenderer } from '../../src/components/BlockRenderer';
import { createEditorStore } from '../../src/core/EditorStore';
import type { LineNode } from '../../src/core/ast';

// React 19 act 要求显式声明测试环境（与 render-export.test.ts 同款）
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// —— 挂载生命周期管理（全部挂载实例 afterEach 统一卸载，防跨用例污染）——
const mountedRoots: Root[] = [];

afterEach(() => {
  while (mountedRoots.length > 0) {
    const root = mountedRoots.pop()!;
    act(() => root.unmount());
  }
  document.body.innerHTML = '';
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

// =====================================================================
// W0-3 S-T-0-04：软渲染复用三色 token（fence 未闭合即高亮）
// =====================================================================

describe('W0-3 软渲染三色 token（S-T-0-04）', () => {
  it('fence 未闭合代码行渲染含 keyword/comment/string 三色 class（不再纯文本）', () => {
    const lineText = 'const s = "abc" // 注释';
    const store = storeWithText('```ts\n' + lineText);
    const container = mountBlock(lineNode(store, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store, 1),
      store,
    });

    // 软渲染语义保留：is-soft-render 标记 + line-code 等宽容器
    const lineCode = container.querySelector('.line-code')!;
    expect(lineCode.classList.contains('is-soft-render')).toBe(true);

    // 渲染内容 = parseCodeLine 三色 token（不再是 {block.raw} 纯文本）
    const wrapper = container.querySelector('.code-soft-text')!;
    expect(wrapper).not.toBeNull();
    expect(wrapper.textContent).toBe(lineText);
    expect(wrapper.querySelector('.token-keyword')?.textContent).toBe('const');
    expect(wrapper.querySelector('.token-string')?.textContent).toBe('"abc"');
    expect(wrapper.querySelector('.token-comment')?.textContent).toBe(
      '// 注释'
    );

    // 行级 data-token 覆盖保留（测量/选区依赖：整行跨度回退命中）
    expect(wrapper.getAttribute('data-token-start')).toBe(
      String(offsetOf(store, 1))
    );
    expect(wrapper.getAttribute('data-token-length')).toBe(
      String(lineText.length)
    );
  });

  it('流式增长过程 token 偏移随行全局偏移平移（data-token-start 与常规路径一致）', () => {
    // 非首内容行（行首有前一行），行级偏移必须落到真实全局偏移
    const store = storeWithText('```ts\n// header\nconst y = 2');
    const container = mountBlock(lineNode(store, 2, 'code'), {
      index: 2,
      lineOffset: offsetOf(store, 2),
      store,
    });
    const keyword = container.querySelector('.code-soft-text .token-keyword')!;
    // const 在第 2 行行首，token 偏移 = 行全局偏移
    expect(keyword.getAttribute('data-token-start')).toBe(
      String(offsetOf(store, 2))
    );
    expect(keyword.textContent).toBe('const');
  });
});

// =====================================================================
// W0-3 S-T-0-05：闭合切换零跳变（DOM 序列化 diff）
// =====================================================================

describe('W0-3 闭合切换 DOM 序列化 diff（S-T-0-05）', () => {
  it('同一行文本软/硬渲染 token 结构逐位一致，仅容器差异（is-soft-render）', () => {
    const lineText = 'const s = "abc" // 注释';
    // 闭合前：fence 未闭合 → 软渲染分支
    const softStore = storeWithText('```ts\n' + lineText);
    // 闭合后：fence 完整 → 常规路径（InlineRenderer token 高亮）
    const closedStore = storeWithText('```ts\n' + lineText + '\n```');

    const softContainer = mountBlock(lineNode(softStore, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(softStore, 1),
      store: softStore,
    });
    const closedContainer = mountBlock(lineNode(closedStore, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(closedStore, 1),
      store: closedStore,
    });

    // 容器差异：软渲染多 is-soft-render 标记 + 行级包裹 span
    const softLineCode = softContainer.querySelector('.line-code')!;
    const closedLineCode = closedContainer.querySelector('.line-code')!;
    expect(softLineCode.classList.contains('is-soft-render')).toBe(true);
    expect(closedLineCode.classList.contains('is-soft-render')).toBe(false);
    const softWrapper = softContainer.querySelector('.code-soft-text');
    expect(softWrapper).not.toBeNull();
    expect(closedContainer.querySelector('.code-soft-text')).toBeNull();

    // token 结构 diff：软渲染包裹 span 内与常规路径直接子级的 token 序列化一致
    //（同源同色 + key=起始偏移 → React 原地更新类/内容，闭合切换零跳变）
    const softTokens = Array.from(
      softWrapper!.querySelectorAll('[data-token-start]')
    ).map((el) => el.outerHTML);
    const closedTokens = Array.from(
      closedContainer.querySelectorAll('[data-token-start]')
    ).map((el) => el.outerHTML);
    expect(softTokens.length).toBeGreaterThanOrEqual(3);
    expect(softTokens).toEqual(closedTokens);
    // 行文本一致性：软渲染包裹 span 全文 = 闭合容器 token 序列拼接
    //（闭合容器还含复制按钮 label，不能整容器 textContent 直接比）
    const closedTokenText = Array.from(
      closedContainer.querySelectorAll('[data-token-start]')
    )
      .map((el) => el.textContent)
      .join('');
    expect(softWrapper!.textContent).toBe(closedTokenText);
  });

  it('软渲染空代码行不丢文本（0 长度 text token 原样渲染）', () => {
    // parseCodeLine 空行产出单条 0 长度 text token（覆盖守恒），软渲染
    // 经 InlineRenderer 渲染为空 span，行高由 virtual-row min-height
    //（G6.5 契约 28px）维持，不产生可见退化
    const store = storeWithText('```ts\n\n');
    const container = mountBlock(lineNode(store, 1, 'code'), {
      index: 1,
      lineOffset: offsetOf(store, 1),
      store,
    });
    const wrapper = container.querySelector('.code-soft-text')!;
    expect(wrapper).not.toBeNull();
    expect(wrapper.textContent).toBe('');
    expect(container.querySelector('.line-code.is-soft-render')).not.toBeNull();
  });
});
