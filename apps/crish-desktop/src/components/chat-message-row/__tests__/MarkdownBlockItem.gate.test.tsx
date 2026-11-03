// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  overrides: new Map<
    string,
    { html: string; truncated: boolean; loading: boolean; failed: boolean }
  >(),
}));

vi.mock('../../../api/markdown/useMarkdownRender', () => {
  const empty = {
    html: '',
    truncated: false,
    loading: false,
    failed: false,
  };
  return {
    useMarkdownResult: vi.fn((markdown: string) => {
      const override = hoisted.overrides.get(markdown);
      if (override) return override;
      return markdown ? { ...empty, html: `S:${markdown}` } : { ...empty };
    }),
    useMarkdownPrewarm: vi.fn(),
  };
});

vi.mock('../../markdown/MarkdownSurface', () => ({
  MarkdownSurface: ({
    html,
    className,
  }: {
    html: string;
    className?: string;
  }) => (
    <div data-testid="md-surface" className={className}>
      {html}
    </div>
  ),
}));

import { MarkdownBlockItem } from '../MarkdownBlockItem';

function tailProps(text: string) {
  return { text, isSealed: false, isLast: true, isStreaming: true };
}

describe('MarkdownBlockItem · R13 completion gate', () => {
  it('renders nothing while a fence is unclosed, then the sealed form at stream end', () => {
    const { container, rerender } = render(
      <MarkdownBlockItem {...tailProps('```ts\nconst x = 1;')} />
    );
    expect(container.innerHTML).toBe('');

    rerender(
      <MarkdownBlockItem {...tailProps('```ts\nconst x = 1;\nconst y = 2;')} />
    );
    expect(container.innerHTML).toBe('');

    // 流结束：整条消息走静态全量路径，围栏以最终形态出现（中断兜底同理）。
    rerender(
      <MarkdownBlockItem
        text={'```ts\nconst x = 1;\nconst y = 2;\n```'}
        isSealed
        isLast
        isStreaming={false}
      />
    );
    expect(container.textContent).toContain(
      'S:```ts\nconst x = 1;\nconst y = 2;\n```'
    );
  });

  it('never shows a table header as prose, nor a half-written row', () => {
    const { container, rerender } = render(
      <MarkdownBlockItem {...tailProps('| A | B |')} />
    );
    expect(container.innerHTML).toBe('');

    rerender(<MarkdownBlockItem {...tailProps('| A | B |\n| ---')} />);
    expect(container.innerHTML).toBe('');

    const base = '| A | B |\n| --- | --- |';
    rerender(<MarkdownBlockItem {...tailProps(`${base}\n| 1`)} />);
    expect(container.textContent).toContain(`S:${base}`);
    expect(container.textContent).not.toContain('| 1');

    rerender(<MarkdownBlockItem {...tailProps(`${base}\n| 1 | 2 |\n| 3`)} />);
    expect(container.textContent).toContain('| 1 | 2 |');
    expect(container.textContent).not.toContain('| 3');
  });

  it('streams prose through the static path as it grows', () => {
    const { container, rerender } = render(
      <MarkdownBlockItem {...tailProps('hello wor')} />
    );
    expect(container.textContent).toContain('S:hello wor');

    rerender(<MarkdownBlockItem {...tailProps('hello world')} />);
    expect(container.textContent).toContain('S:hello world');
  });

  it('bridges with the last presented HTML while the extended prefix loads', () => {
    const { container, rerender } = render(
      <MarkdownBlockItem {...tailProps('first')} />
    );
    expect(container.textContent).toContain('S:first');

    hoisted.overrides.set('first\nsecond', {
      html: '',
      truncated: false,
      loading: true,
      failed: false,
    });
    rerender(<MarkdownBlockItem {...tailProps('first\nsecond')} />);
    // 新前缀结果未到达：桥接旧 HTML，不闪退、不露源码。
    expect(container.textContent).toContain('S:first');

    hoisted.overrides.delete('first\nsecond');
    // 结果到达后组件内部状态更新会驱动重渲（mock 无异步状态，这里用
    // className 变化绕过 memo 相等判定，模拟那次重渲）。
    rerender(
      <MarkdownBlockItem {...tailProps('first\nsecond')} className="arrived" />
    );
    expect(container.textContent).toContain('S:first\nsecond');
  });
});
