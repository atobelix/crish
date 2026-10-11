// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as markdownRenderAsync from '../../api/markdownRenderAsync';
import { InlineAgentThinkingFold } from './InlineAgentThinkingFold';

vi.mock('../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: vi.fn(),
  useStreamingMarkdownHtml: vi.fn(),
}));

vi.mock('../../store/storeAccess', () => ({
  useSettingsField: vi.fn(() => 2),
}));

const renderSafeHtml = (markdown: string): string => {
  if (markdown.includes('# Thinking title')) {
    return '<h1>Thinking title</h1>';
  }
  if (markdown.includes('**Readable**')) {
    return '<p><strong>Readable</strong> thought.</p>';
  }
  if (markdown.includes('const answer = 42;')) {
    return '<pre><code>const answer = 42;</code></pre>';
  }
  return `<p>${markdown}</p>`;
};

describe('InlineAgentThinkingFold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: false,
    });
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockReturnValue('');
  });

  it('shows renderer HTML for headings, bold text, and fenced code while live', () => {
    const renderResult = (markdown: string) => ({
      html: renderSafeHtml(markdown),
      loading: false,
      failed: false,
    });
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockImplementation(
      (markdown) => renderResult(markdown)
    );
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockImplementation(
      (markdown, enabled) => (enabled ? renderSafeHtml(markdown) : '')
    );

    const source =
      '# Thinking title\n\n**Readable** thought.\n\n```ts\nconst answer = 42;\n```';
    const { container } = render(
      <InlineAgentThinkingFold thinkingText={source} isLive />
    );

    const details = container.querySelector('details');
    const body = container.querySelector('[data-testid="inline-agent-thinking-body"]');
    expect(details?.open).toBe(true);
    expect(body?.querySelector('h1')?.textContent).toBe('Thinking title');
    expect(body?.querySelector('strong')?.textContent).toBe('Readable');
    expect(body?.querySelector('pre code')?.textContent).toBe(
      'const answer = 42;'
    );
    expect(body?.textContent).toContain('Thinking title');
    expect(body?.textContent).toContain('Readable thought.');
    expect(body?.innerHTML).not.toContain('# Thinking title');
    expect(body?.innerHTML).not.toContain('**Readable**');
    expect(body?.innerHTML).not.toContain('```');
  });

  it('keeps Markdown source blank while rendering is pending', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: true,
      failed: false,
    });
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockReturnValue('');

    const source = '# Pending title\n\n**Pending bold** text';
    const { container } = render(
      <InlineAgentThinkingFold thinkingText={source} isLive />
    );

    const body = container.querySelector('[data-testid="inline-agent-thinking-body"]');
    expect(body?.textContent).toBe('');
    expect(body?.innerHTML).not.toContain('# Pending title');
    expect(body?.innerHTML).not.toContain('**Pending bold**');
  });

  it('keeps completed thoughts collapsed until the summary is opened', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '<p>Readable completed thought.</p>',
      loading: false,
      failed: false,
    });

    const { container } = render(
      <InlineAgentThinkingFold thinkingText="Readable completed thought." />
    );
    const details = container.querySelector('details');
    const summary = container.querySelector('summary');

    expect(details?.open).toBe(false);
    fireEvent.click(summary!);
    expect(details?.open).toBe(true);
    expect(
      container.querySelector('[data-testid="inline-agent-thinking-body"]')
        ?.textContent
    ).toBe(
      'Readable completed thought.'
    );
  });
});
