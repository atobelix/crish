/**
 * 渲染注册表 + 主题注入测试（R5-C：渲染注册表 + 主题注入）
 *
 * 覆盖（对应任务书验收）：
 * 1. 默认注册表：核心 12 类型注册齐全，resolve 命中专属渲染器；
 *    body/html_block 等未注册类型走兜底默认渲染器；
 * 2. 注册自定义块渲染器生效（真实渲染验证 DOM 产出）；
 * 3. 移除恢复：unregister 后解析与渲染回到默认行为；
 * 4. 未知类型兜底：未注册 LineType 默认渲染；
 * 5. 主题切换：setRenderTheme/getRenderTheme 存取 + 恢复默认；
 * 6. 数学渲染器注入点：mock 注入 → 计数/参数/返回值正确；
 *    空公式早退不触发注入点；恢复默认后回 KaTeX 行为。
 *
 * 纪律：全局注册的自定义渲染器与主题/数学渲染器在 afterEach 统一
 * 恢复，不污染其它测试文件（与 ruler.test.ts 同款清理协议）。
 */
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import React from 'react';
import {
  BlockRenderer,
  BlockRendererRegistry,
  DefaultBlockRenderer,
  registerBlockRenderer,
  unregisterBlockRenderer,
  resolveBlockRenderer,
  type BlockRendererComponentProps,
} from '../../src/components/BlockRenderer';
import type { LineNode, LineType } from '../../src/core/ast';
import {
  DEFAULT_RENDER_THEME,
  getMathRenderer,
  getRenderTheme,
  renderMathToHtml,
  setMathRenderer,
  setRenderTheme,
  type RenderTheme,
} from '../../src/core/renderTheme';

// React 19 act 要求显式声明测试环境（与 a11y.test.ts 同款）
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// —— 本文件注册的自定义渲染器类型（afterEach 统一清理） ——
const registeredTypes: LineType[] = [];

function registerGlobal(type: LineType, renderer: typeof DefaultBlockRenderer): void {
  registerBlockRenderer(type, renderer);
  if (!registeredTypes.includes(type)) registeredTypes.push(type);
}

afterEach(() => {
  while (registeredTypes.length > 0) {
    unregisterBlockRenderer(registeredTypes.pop()!);
  }
  // 主题与数学渲染器恢复出厂（模块级单例，必须清理防串扰）
  setRenderTheme(DEFAULT_RENDER_THEME);
  setMathRenderer(null);
});

// —— 渲染工具：jsdom 挂载 BlockRenderer 并返回容器 ——
function renderBlock(
  block: Partial<LineNode> & { type: LineType },
  extra: Partial<BlockRendererComponentProps> = {}
): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
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
        activeState: extra.activeState ?? null,
        tableId: extra.tableId,
      })
    );
  });
  return container;
}

// =====================================================================
// 1. 默认注册表与解析
// =====================================================================

describe('BlockRendererRegistry 默认注册表', () => {
  it('核心 12 类型全部注册，resolve 命中专属渲染器（非兜底）', () => {
    const coreTypes: LineType[] = [
      'empty',
      'code_fence_start',
      'code_fence_end',
      'math_fence_start',
      'math_fence_end',
      'math_block',
      'code',
      'heading',
      'hr',
      'blockquote',
      'table_separator',
      'table_row',
    ];
    for (const type of coreTypes) {
      expect(BlockRendererRegistry.has(type), `${type} 已注册`).toBe(true);
      expect(resolveBlockRenderer(type), `${type} 命中专属渲染器`).not.toBe(
        DefaultBlockRenderer
      );
    }
  });

  it('未注册类型（body/html_block）走兜底默认渲染器', () => {
    expect(resolveBlockRenderer('body')).toBe(DefaultBlockRenderer);
    expect(resolveBlockRenderer('html_block')).toBe(DefaultBlockRenderer);
  });

  it('抽查核心类型渲染产出与迁移前 class 结构一致（行为零变化证据）', () => {
    // heading：line-h1
    expect(
      renderBlock({ type: 'heading', raw: '# t', headingLevel: 1, inlineTokens: [], length: 3 }).querySelector('.line-h1')
    ).not.toBeNull();
    // hr：line-hr + hr-rendered
    const hr = renderBlock({ type: 'hr', raw: '---', length: 3 });
    expect(hr.querySelector('.line-hr .hr-rendered')).not.toBeNull();
    // empty：line-block
    expect(renderBlock({ type: 'empty', raw: '', length: 0 }).querySelector('.line-block')).not.toBeNull();
    // code_fence_start：line-code-fence-start + code-lang-pill
    const fence = renderBlock({ type: 'code_fence_start', raw: '```ts', length: 5 });
    expect(fence.querySelector('.line-code-fence-start .code-lang-pill')).not.toBeNull();
  });
});

// =====================================================================
// 2. 自定义块渲染器：注册生效 / 移除恢复 / 兜底
// =====================================================================

describe('自定义块渲染器注册', () => {
  const customRenderer = (props: BlockRendererComponentProps) =>
    React.createElement(
      'div',
      { className: 'custom-renderer', 'data-raw': props.block.raw },
      `自定义:${props.block.raw}`
    );

  it('注册后渲染生效：自定义组件输出替换默认渲染', () => {
    registerGlobal('body', customRenderer);
    const container = renderBlock({ type: 'body', raw: 'hello', length: 5 });
    const el = container.querySelector('.custom-renderer');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('data-raw')).toBe('hello');
    expect(container.textContent).toContain('自定义:hello');
  });

  it('同名注册即替换（markdown-it at 语义）', () => {
    registerGlobal('body', customRenderer);
    registerGlobal('body', (props) =>
      React.createElement('div', { className: 'custom-renderer-v2' }, `v2:${props.block.raw}`)
    );
    expect(resolveBlockRenderer('body')).not.toBe(DefaultBlockRenderer);
    expect(renderBlock({ type: 'body', raw: 'x', length: 1 }).textContent).toBe('v2:x');
  });

  it('unregister 后移除恢复：解析与渲染都回默认 body 行为', () => {
    registerGlobal('body', customRenderer);
    expect(unregisterBlockRenderer('body')).toBe(true);
    // 未注册类型删除返回 false
    expect(unregisterBlockRenderer('body')).toBe(false);
    expect(resolveBlockRenderer('body')).toBe(DefaultBlockRenderer);
    // 渲染回默认：无 .custom-renderer，恢复 .line-block 容器
    const container = renderBlock({ type: 'body', raw: 'hello', inlineTokens: [], length: 5 });
    expect(container.querySelector('.custom-renderer')).toBeNull();
    expect(container.querySelector('.line-block')).not.toBeNull();
  });

  it('注册核心类型可覆盖默认渲染器；移除后恢复默认', () => {
    registerGlobal('hr', (props) =>
      React.createElement('div', { className: 'custom-hr' }, `HR:${props.block.raw}`)
    );
    expect(renderBlock({ type: 'hr', raw: '---', length: 3 }).textContent).toBe('HR:---');
    unregisterBlockRenderer('hr');
    // 移除后恢复默认注册表渲染器（hr 专属，非兜底；默认注册表不被永久改写）
    expect(resolveBlockRenderer('hr')).not.toBe(DefaultBlockRenderer);
    expect(renderBlock({ type: 'hr', raw: '---', length: 3 }).querySelector('.hr-rendered')).not.toBeNull();
  });

  it('未知类型兜底：html_block 默认渲染（line-block 容器）', () => {
    const container = renderBlock({ type: 'html_block', raw: '<div>x</div>', length: 11 });
    expect(container.querySelector('.line-block')).not.toBeNull();
  });
});

// =====================================================================
// 3. 主题切换
// =====================================================================

describe('renderTheme 主题注入', () => {
  it('默认主题 = 现有 CSS 变量值（出厂态）', () => {
    const theme = getRenderTheme();
    expect(theme).toBe(DEFAULT_RENDER_THEME);
    expect(theme.colors.textPrimary).toBe('var(--text-primary)');
    expect(theme.colors.bg).toBe('var(--bg-theme)');
    expect(theme.fonts.mono).toBe('var(--font-mono)');
  });

  it('setRenderTheme 整体替换；getRenderTheme 返回最新主题', () => {
    const custom: RenderTheme = {
      colors: {
        bg: 'hsl(200 30% 20%)',
        textPrimary: 'hsl(200 10% 90%)',
        textSecondary: 'hsl(200 6% 70%)',
        textMuted: 'hsl(200 6% 55%)',
        selectionBg: 'hsl(200 30% 40% / 0.5)',
        borderSubtle: 'hsl(200 10% 30%)',
        borderMedium: 'hsl(200 10% 35%)',
        borderFocus: 'hsl(200 20% 55%)',
        yellowText: 'hsl(45 80% 70%)',
      },
      fonts: { mono: 'JetBrains Mono, monospace' },
      radius: { small: '2px', medium: '6px' },
      lineHeight: 1.8,
    };
    setRenderTheme(custom);
    expect(getRenderTheme()).toBe(custom);
    expect(getRenderTheme().lineHeight).toBe(1.8);
    // 恢复默认
    setRenderTheme(DEFAULT_RENDER_THEME);
    expect(getRenderTheme()).toBe(DEFAULT_RENDER_THEME);
  });
});

// =====================================================================
// 4. 数学渲染器注入点
// =====================================================================

describe('setMathRenderer 注入点', () => {
  it('mock 注入后 renderMathToHtml 转发：计数/参数/返回值', () => {
    const mock = vi.fn((formula: string, display: boolean) => `MOCK[${formula}|${display}]`);
    setMathRenderer(mock);
    expect(renderMathToHtml('a+b', true)).toBe('MOCK[a+b|true]');
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith('a+b', true);
    expect(renderMathToHtml('c', false)).toBe('MOCK[c|false]');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('空公式早退：不触发注入点（历史语义保留）', () => {
    const mock = vi.fn(() => 'x');
    setMathRenderer(mock);
    expect(renderMathToHtml('', false)).toBe('');
    expect(mock).not.toHaveBeenCalled();
  });

  it('块级渲染（math_block）与行内渲染（math token）都走注入点', () => {
    const mock = vi.fn(() => '<span class="mock-math">M</span>');
    setMathRenderer(mock);
    // 块级：MathBlock 默认注册表渲染器调用 renderMathToHtml(trim 后公式, true)
    renderBlock({ type: 'math_block', raw: '$$a+b$$', length: 8 });
    expect(mock).toHaveBeenCalledWith('$$a+b$$', true);
    // 行内：InlineRenderer math token（heading 行承载 $x$）
    const mathToken = {
      type: 'math' as const,
      raw: '$x$',
      content: 'x',
      localOffset: 0,
      length: 3,
    };
    const heading: LineNode = {
      id: 'h',
      type: 'heading',
      raw: '$x$',
      headingLevel: 1,
      inlineTokens: [mathToken],
      length: 3,
      localOffset: 0,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(BlockRenderer, {
          block: heading,
          index: 0,
          lineOffset: 0,
          activeState: null,
        })
      );
    });
    expect(mock).toHaveBeenCalledWith('x', false);
    expect(container.querySelector('.mock-math')).not.toBeNull();
  });

  it('setMathRenderer(null) 恢复默认：回 KaTeX 行为', () => {
    setMathRenderer(() => 'NOT-KATEX');
    expect(renderMathToHtml('e=mc^2', false)).toBe('NOT-KATEX');
    setMathRenderer(null);
    // 默认实现产出 KaTeX 标记（renderToString 产物含 katex class）
    expect(getMathRenderer()).toBeTypeOf('function');
    expect(renderMathToHtml('e=mc^2', false)).toContain('katex');
    // 非法公式：KaTeX throwOnError: false 渲染 katex-error 占位（不抛异常）
    expect(renderMathToHtml('\\invalid\\x \\', false)).toContain('katex-error');
  });
});
