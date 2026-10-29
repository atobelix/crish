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

  it('切换 as 元素时重新注入 HTML', () => {
    const { container, rerender } = render(
      <MarkdownSurface as="div" html="<p>plain</p>" />
    );
    expect(container.querySelector('div.md-rendered p')).toBeTruthy();

    rerender(<MarkdownSurface as="span" html="<p>plain</p>" />);
    expect(container.querySelector('span.md-rendered p')).toBeTruthy();
  });
});
