// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { DiffCardUnifiedView } from '../DiffCardUnifiedView';
import { DiffCardSplitView } from '../DiffCardSplitView';
import { VirtualPlainCodeViewer } from '../VirtualPlainCodeViewer';
import type { FileDiff } from '../../../store/types';

describe('DiffCard 语法高亮断言套件', () => {
  it('DiffCardUnifiedView: 传入 .ts 文件时，代码行渲染 hljs 语法高亮标签，彻底废除 diff 纯文本伪传参', () => {
    const f: FileDiff = {
      filePath: 'src/core/auth.ts',
      status: 'modified',
      changes: [
        { type: 'addition', content: 'export const token: string = "secret";' },
      ],
    };
    const renderItems = [
      {
        isCollapsedPlaceholder: false as const,
        index: 0,
        item: {
          change: f.changes[0]!,
          globalIdx: 0,
          newLine: 1,
        },
      },
    ];

    const { container } = render(
      <DiffCardUnifiedView f={f} renderItems={renderItems} onExpandBlock={vi.fn()} />
    );

    const html = container.innerHTML;
    expect(html).toContain('hljs-keyword'); // "export", "const" 被着色
    expect(html).toContain('hljs-string');  // "secret" 被着色
  });

  it('DiffCardSplitView: 传入 .rs 文件时，代码行渲染 hljs 语法高亮标签', () => {
    const f: FileDiff = {
      filePath: 'src/lib.rs',
      status: 'modified',
      changes: [
        { type: 'deletion', content: 'pub fn old_calc() -> u32 { 10 }' },
        { type: 'addition', content: 'pub fn new_calc() -> u32 { 42 }' },
      ],
    };
    const renderItems = [
      {
        isCollapsedPlaceholder: false as const,
        index: 0,
        pair: {
          left: {
            change: f.changes[0]!,
            oldLine: 1,
          },
          right: {
            change: f.changes[1]!,
            newLine: 1,
          },
        },
      },
    ];

    const { container } = render(
      <DiffCardSplitView f={f} renderItems={renderItems} onExpandBlock={vi.fn()} />
    );

    const html = container.innerHTML;
    expect(html).toContain('hljs-keyword'); // "pub", "fn" 被着色
    expect(html).toContain('hljs-number');  // "10", "42" 被着色
  });

  it('VirtualPlainCodeViewer: 纯源码视图渲染正确语言语法高亮', () => {
    const { container } = render(
      <VirtualPlainCodeViewer
        content={'function testFunc(): boolean {\n  return true;\n}'}
        filePath="src/test.ts"
      />
    );

    const html = container.innerHTML;
    expect(html).toContain('hljs-keyword'); // "function", "return"
    expect(html).toContain('hljs-title');   // "testFunc"
  });
});
