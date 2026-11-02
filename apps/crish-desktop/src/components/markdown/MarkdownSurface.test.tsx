// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownSurface } from './MarkdownSurface';

vi.mock('./islands/IslandPortal', () => ({
  IslandPortal: (props: {
    name: string;
    source: string;
    displayMode?: boolean;
  }) => (
    <span
      data-testid="island"
      data-name={props.name}
      data-source={props.source}
      data-display={String(props.displayMode ?? false)}
    />
  ),
}));

describe('MarkdownSurface', () => {
  it('注入 HTML 并补齐 tooltip / callout / footnote 的 i18n 文案', () => {
    const { container } = render(
      <MarkdownSurface
        html={`
          <button data-tooltip-key="markdown.code.copy"></button>
          <div data-callout-title="note">raw</div>
          <a data-footnote-backref></a>
        `}
      />
    );

    const button = container.querySelector<HTMLElement>(
      '[data-tooltip-key="markdown.code.copy"]'
    )!;
    expect(button.getAttribute('data-tooltip')).toBeTruthy();
    expect(button.getAttribute('aria-label')).toBe(
      button.getAttribute('data-tooltip')
    );

    const callout = container.querySelector<HTMLElement>(
      '[data-callout-title="note"]'
    )!;
    expect(callout.textContent).not.toBe('raw');
    expect(callout.textContent).toBeTruthy();

    const backref = container.querySelector<HTMLElement>(
      '[data-footnote-backref]'
    )!;
    expect(backref.getAttribute('aria-label')).toBeTruthy();
  });

  it('识别 math / mermaid Island 并透传源文本', () => {
    render(
      <MarkdownSurface
        html={`
          <div class="md-math-block" data-md-island="math" data-tex="x^2"></div>
          <div class="md-code-block">
            <div data-island-slot="mermaid"></div>
            <span class="md-code-line">graph TD</span>
            <span class="md-code-line">A--&gt;B</span>
          </div>
        `}
      />
    );

    const islands = screen.getAllByTestId('island');
    expect(islands).toHaveLength(2);
    const byName = new Map(
      islands.map((node) => [node.getAttribute('data-name'), node])
    );
    expect(byName.get('math')?.getAttribute('data-source')).toBe('x^2');
    expect(byName.get('math')?.getAttribute('data-display')).toBe('true');
    expect(byName.get('mermaid')?.getAttribute('data-source')).toBe(
      'graph TD\nA-->B'
    );
  });

  it('活跃流式块跳过 Island 注水', () => {
    render(
      <MarkdownSurface
        isActive
        html={`<div data-md-island="math" data-tex="x"></div>`}
      />
    );
    expect(screen.queryAllByTestId('island')).toHaveLength(0);
  });

  it('无 island 占位时不渲染 portal', () => {
    render(<MarkdownSurface html="<p>plain</p>" />);
    expect(screen.queryAllByTestId('island')).toHaveLength(0);
  });

  it('追加代码行时保留未变化行节点身份（增量补丁）', () => {
    const codeHtml = (lines: string[]) =>
      `<div class="md-code-block"><pre class="md-code-pre"><code>${lines
        .map(
          (line, i) =>
            `<span class="md-code-line" data-line="${i + 1}">${line}</span>`
        )
        .join('')}</code></pre></div>`;
    const { container, rerender } = render(
      <MarkdownSurface html={codeHtml(['one', 'two'])} />
    );
    const root = container.querySelector('div.md-rendered')!;
    const line1 = root.querySelector('[data-line="1"]');
    const line2 = root.querySelector('[data-line="2"]');

    rerender(<MarkdownSurface html={codeHtml(['one', 'two', 'three'])} />);
    expect(root.querySelector('[data-line="1"]')).toBe(line1);
    expect(root.querySelector('[data-line="2"]')).toBe(line2);
    expect(root.querySelector('[data-line="3"]')?.textContent).toBe('three');
  });

  it('纯文本增长复用同一文本节点追加（增量补丁）', () => {
    const { container, rerender } = render(
      <MarkdownSurface html="<p>abc</p>" />
    );
    const root = container.querySelector('div.md-rendered')!;
    const paragraph = root.querySelector('p')!;
    const textNode = paragraph.firstChild;

    rerender(<MarkdownSurface html="<p>abcdef</p>" />);
    expect(root.querySelector('p')).toBe(paragraph);
    expect(paragraph.firstChild).toBe(textNode);
    expect(paragraph.textContent).toBe('abcdef');
  });

  it('表格新增行时保留既有行节点（增量补丁）', () => {
    const tableHtml = (rows: number) =>
      `<table><tbody>${Array.from(
        { length: rows },
        (_, i) => `<tr><td>r${i}</td></tr>`
      ).join('')}</tbody></table>`;
    const { container, rerender } = render(
      <MarkdownSurface html={tableHtml(2)} />
    );
    const root = container.querySelector('div.md-rendered')!;
    const firstRow = root.querySelector('tr');

    rerender(<MarkdownSurface html={tableHtml(3)} />);
    expect(root.querySelector('tr')).toBe(firstRow);
    expect(root.querySelectorAll('tr')).toHaveLength(3);
  });

  it('结构变化时整节点替换（增量补丁）', () => {
    const { container, rerender } = render(
      <MarkdownSurface html="<p>plain</p>" />
    );
    const root = container.querySelector('div.md-rendered')!;
    rerender(<MarkdownSurface html="<h2>plain</h2>" />);
    expect(root.querySelector('p')).toBeNull();
    expect(root.querySelector('h2')?.textContent).toBe('plain');
  });

  it('只对新增范围补跑 enhance（增量补丁）', () => {
    const { container, rerender } = render(<MarkdownSurface html="<p>a</p>" />);
    const root = container.querySelector('div.md-rendered')!;
    rerender(
      <MarkdownSurface
        html={'<p>a</p><button data-tooltip-key="markdown.code.copy"></button>'}
      />
    );
    const button = root.querySelector<HTMLElement>(
      '[data-tooltip-key="markdown.code.copy"]'
    )!;
    expect(button.getAttribute('data-tooltip')).toBeTruthy();
  });

  it('切换 as 元素时重新注入 HTML', () => {
    const { container, rerender } = render(
      <MarkdownSurface as="div" html="<p>plain</p>" />
    );
    expect(container.querySelector('div.md-rendered p')).toBeTruthy();

    rerender(<MarkdownSurface as="span" html="<p>plain</p>" />);
    expect(container.querySelector('span.md-rendered p')).toBeTruthy();
  });
});
