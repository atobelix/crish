/**
 * B5 bidi 渲染接线测试（jsdom 断言 dir 属性）
 *
 * 覆盖（对应任务书验收）：
 * - 整行 RTL（body 行 / 列表行）：DefaultBlockRenderer 行容器
 *   .line-block 设 dir="rtl"；
 * - LTR 行不设 dir（行为零变化）；
 * - 标题行 RTL：.line-hN 行容器设 dir="rtl"；
 * - blockquote 内 RTL 内容：.blockquote-rendered 渲染体设 dir="rtl"
 *   （前缀 span 保持无 dir）；
 * - 空行/无内容行不设 dir。
 *
 * 设计说明：isRtlLine 为弱类型扫描（Bidi.ts），LTR 行快速路径零开销；
 * rtl 在 BlockRenderer memo 顶层计算一次并随 props 传入（行不变不重算）。
 */
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import React from 'react';
import { BlockRenderer } from '../../src/components/BlockRenderer';
import type { LineNode, InlineNode } from '../../src/core/ast';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 渲染工具：jsdom 挂载 BlockRenderer 并返回容器（render-registry 同款） */
function renderBlock(
  block: Partial<LineNode> & { type: LineNode['type'] },
  inlineTokens: InlineNode[] = []
): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const fullBlock: LineNode = {
    id: 't',
    raw: '',
    inlineTokens,
    length: 0,
    localOffset: 0,
    ...block,
  } as LineNode;
  act(() => {
    root.render(
      React.createElement(BlockRenderer, {
        block: fullBlock,
        index: 0,
        lineOffset: 0,
        activeState: null,
      })
    );
  });
  return container;
}

/** 行内 text token（覆盖守恒不相关，仅占位渲染） */
function textToken(raw: string): InlineNode {
  return { type: 'text', raw, content: raw, localOffset: 0, length: raw.length };
}

const HEBREW = 'שלום עולם'; // 希伯来文（强 RTL）
const ARABIC = 'مرحبا بالعالم'; // 阿拉伯文（强 RTL）
const PLAIN = 'hello world';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('B5 bidi 渲染接线（dir 属性）', () => {
  it('整行 RTL（body 行）：.line-block 设 dir="rtl"', () => {
    const container = renderBlock(
      { type: 'body', raw: HEBREW, length: HEBREW.length },
      [textToken(HEBREW)]
    );
    const line = container.querySelector('.line-block');
    expect(line).not.toBeNull();
    expect(line?.getAttribute('dir')).toBe('rtl');
  });

  it('整行 RTL（阿拉伯文）：dir="rtl"', () => {
    const container = renderBlock(
      { type: 'body', raw: ARABIC, length: ARABIC.length },
      [textToken(ARABIC)]
    );
    expect(container.querySelector('.line-block')?.getAttribute('dir')).toBe('rtl');
  });

  it('LTR 行不设 dir（行为零变化）', () => {
    const container = renderBlock(
      { type: 'body', raw: PLAIN, length: PLAIN.length },
      [textToken(PLAIN)]
    );
    expect(container.querySelector('.line-block')?.getAttribute('dir')).toBeNull();
  });

  it('混合行（LTR + RTL 段）：整行 dir="rtl"', () => {
    const raw = `abc ${HEBREW} def`;
    const container = renderBlock({ type: 'body', raw, length: raw.length }, [
      textToken(raw),
    ]);
    expect(container.querySelector('.line-block')?.getAttribute('dir')).toBe('rtl');
  });

  it('标题行 RTL：.line-h1 设 dir="rtl"；LTR 标题不设', () => {
    const hebrewHeading = `# ${HEBREW}`;
    const hRtl = renderBlock(
      { type: 'heading', raw: hebrewHeading, headingLevel: 1, length: hebrewHeading.length },
      [textToken(HEBREW)]
    );
    expect(hRtl.querySelector('.line-h1')?.getAttribute('dir')).toBe('rtl');
    const hLtr = renderBlock(
      { type: 'heading', raw: '# title', headingLevel: 1, length: 7 },
      [textToken('title')]
    );
    expect(hLtr.querySelector('.line-h1')?.getAttribute('dir')).toBeNull();
  });

  it('blockquote 内 RTL 内容：.blockquote-rendered 设 dir="rtl"，前缀 span 不设', () => {
    const raw = `> ${HEBREW}`;
    const container = renderBlock(
      { type: 'blockquote', raw, length: raw.length },
      [textToken(HEBREW)]
    );
    expect(container.querySelector('.blockquote-rendered')?.getAttribute('dir')).toBe('rtl');
    expect(container.querySelector('.blockquote-source')?.getAttribute('dir')).toBeNull();
  });

  it('blockquote 纯 LTR 内容不设 dir（前缀为 ASCII，整行检测与内容检测等价）', () => {
    const raw = '> plain quote';
    const container = renderBlock({ type: 'blockquote', raw, length: raw.length }, [
      textToken('plain quote'),
    ]);
    expect(container.querySelector('.blockquote-rendered')?.getAttribute('dir')).toBeNull();
  });

  it('空行/无内容行不设 dir', () => {
    const container = renderBlock({ type: 'empty', raw: '', length: 0 });
    expect(container.querySelector('.line-block')?.getAttribute('dir')).toBeNull();
  });

  it('代码行不设 dir（代码保持 LTR 基线，bidi 接线不触碰代码块）', () => {
    const raw = 'const x = 1;';
    const container = renderBlock(
      { type: 'code', raw, length: raw.length },
      [textToken(raw)]
    );
    expect(container.querySelector('.line-code')?.getAttribute('dir')).toBeNull();
  });
});
