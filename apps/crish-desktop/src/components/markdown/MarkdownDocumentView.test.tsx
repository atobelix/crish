// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownDocumentView } from './MarkdownDocumentView';

vi.mock('./MarkdownBlockList', () => ({
  MarkdownBlockList: (props: { chunks: { text: string }[] }) => (
    <div data-testid="static-list">{props.chunks.length}</div>
  ),
}));

vi.mock('./VirtualMarkdownBlockList', () => ({
  VirtualMarkdownBlockList: (props: { chunks: { text: string }[] }) => (
    <div data-testid="virtual-list">{props.chunks.length}</div>
  ),
}));

describe('MarkdownDocumentView', () => {
  it('小文档走静态块列表', () => {
    render(
      <MarkdownDocumentView
        content={'# Title\n\nfirst paragraph\n\nsecond paragraph'}
        scrollable={false}
      />
    );
    expect(screen.getByTestId('static-list')).toBeTruthy();
    expect(screen.queryByTestId('virtual-list')).toBeNull();
  });

  it('超过 128KB 走窗口化列表（不再退化为纯文本）', () => {
    const block = 'x'.repeat(200);
    const content = Array.from(
      { length: 700 },
      (_, i) => `para ${i} ${block}`
    ).join('\n\n');
    expect(content.length).toBeGreaterThan(128 * 1024);

    render(<MarkdownDocumentView content={content} scrollable={false} />);
    expect(screen.getByTestId('virtual-list')).toBeTruthy();
    expect(screen.queryByTestId('static-list')).toBeNull();
  });

  it('空内容渲染占位符', () => {
    render(
      <MarkdownDocumentView
        content={'   '}
        emptyPlaceholder="no content"
        scrollable={false}
      />
    );
    expect(screen.getByText('no content')).toBeTruthy();
  });

  it('静态列表按聚合 chunk 渲染并透传 document variant', () => {
    const { container } = render(
      <MarkdownDocumentView
        content={'one\n\n```\ncode\n```\n\ntwo'}
        filePath="docs/readme.md"
        scrollable={false}
      />
    );
    expect(screen.getByTestId('static-list').textContent).toBe('1');
    const root = container.querySelector<HTMLElement>('.md-document-root');
    expect(root?.getAttribute('data-md-variant')).toBe('document');
    expect(root?.getAttribute('data-file-path')).toBe('docs/readme.md');
  });
});
