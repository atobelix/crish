// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MarkdownSurface } from './MarkdownSurface';

vi.mock('katex', () => ({
  default: {
    renderToString: (source: string) => `<span class="katex">${source}</span>`,
  },
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>graph</text></svg>',
    })),
  },
}));

describe('MarkdownSurface · real Island portals', () => {
  it('Math / Mermaid portal 异步更新不触发 React removeChild 崩溃', async () => {
    const html = `
      <div class="md-math-block" data-md-island="math" data-tex="x^2"></div>
      <div class="md-code-block">
        <div data-island-slot="mermaid"></div>
        <span class="md-code-line">graph TD</span>
      </div>
    `;

    const { container, rerender } = render(<MarkdownSurface html={html} />);

    await waitFor(() =>
      expect(container.querySelector('.md-math-rendered')).toBeTruthy()
    );
    await waitFor(() =>
      expect(container.querySelector('.md-mermaid-rendered svg')).toBeTruthy()
    );

    // 换源重渲染：旧 portal 卸载 + 新 portal 挂载
    rerender(
      <MarkdownSurface
        html={`
          <div class="md-math-block" data-md-island="math" data-tex="y^2"></div>
          <div class="md-code-block">
            <div data-island-slot="mermaid"></div>
            <span class="md-code-line">graph LR</span>
          </div>
        `}
      />
    );

    await waitFor(() =>
      expect(
        container.querySelector('.md-math-rendered')?.textContent
      ).toContain('y^2')
    );
  });
});
