// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import mermaid from 'mermaid';
import { MathIsland } from './MathIsland';
import { MermaidIsland } from './MermaidIsland';

vi.mock('katex', () => ({
  default: {
    renderToString: vi.fn((source: string) => {
      if (source === 'boom') throw new Error('katex failed');
      return '<span class="katex">math</span>';
    }),
  },
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, source: string) => {
      if (source === 'boom') throw new Error('mermaid failed');
      return {
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><text>ok</text></svg>',
      };
    }),
  },
}));

describe('MathIsland', () => {
  it('懒加载 KaTeX 并渲染 HTML', async () => {
    render(<MathIsland source="x^2" displayMode />);
    await waitFor(() =>
      expect(document.querySelector('.md-math-rendered')).toBeTruthy()
    );
    const node = document.querySelector<HTMLElement>('.md-math-rendered')!;
    expect(node.className).toContain('md-math-rendered-block');
    expect(node.innerHTML).toContain('katex');
  });

  it('KaTeX 失败时回退源码', async () => {
    render(<MathIsland source="boom" displayMode={false} />);
    await waitFor(() =>
      expect(document.querySelector('[data-math-failed="true"]')).toBeTruthy()
    );
    expect(document.querySelector('.md-math-fallback')?.textContent).toBe(
      'boom'
    );
  });
});

describe('MermaidIsland', () => {
  it('渲染 SVG 并清洗脚本；host 状态为 ready', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<MermaidIsland source="graph TD" host={host} />);

    await waitFor(() =>
      expect(document.querySelector('.md-mermaid-rendered')).toBeTruthy()
    );
    const node = document.querySelector<HTMLElement>('.md-mermaid-rendered')!;
    expect(node.querySelector('svg')).toBeTruthy();
    expect(node.querySelector('script')).toBeNull();
    expect(node.textContent).toContain('ok');
    expect(host.dataset.mermaidState).toBe('ready');
    expect(vi.mocked(mermaid.initialize)).toHaveBeenCalledWith(
      expect.objectContaining({
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      })
    );
  });

  it('Mermaid 失败时展示源码并标记 error', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<MermaidIsland source="boom" host={host} />);

    await waitFor(() =>
      expect(
        document.querySelector('[data-mermaid-failed="true"]')
      ).toBeTruthy()
    );
    expect(screen.getByText('boom')).toBeTruthy();
    expect(host.dataset.mermaidState).toBe('error');
  });
});
