// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { MarkdownBlockItem, markdownBlockItemPropsEqual } from './MarkdownBlockItem';
import * as markdownRenderAsync from '../../api/markdownRenderAsync';
import { Priority } from '../../workers';

vi.mock('../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: vi.fn(),
  useStreamingMarkdownHtml: vi.fn(() => ''),
  parseMarkdownToHtmlAsync: vi.fn(async (markdown: string) =>
    markdown.includes('| ---')
      ? '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
      : '<p>rendered prose</p>'
  ),
}));

vi.mock('../../store/storeAccess', () => ({
  useSettingsField: vi.fn(() => 2),
}));

describe('MarkdownBlockItem component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders compiled Markdown HTML for the active tail without exposing source markers', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: false,
    });
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockReturnValue(
      '<h2>Typing <strong>active</strong> tail</h2>'
    );

    const { container } = render(
      <MarkdownBlockItem
        text="## Typing **active** tail"
        virtualClosedText="## Typing **active** tail**"
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );

    const blockEl = container.querySelector('[data-streaming="true"]');
    expect(blockEl).toBeTruthy();
    expect(blockEl?.getAttribute('data-sealed')).toBe('false');
    expect(blockEl?.innerHTML).toBe(
      '<h2>Typing <strong>active</strong> tail</h2>'
    );
    expect(blockEl?.textContent).not.toContain('##');
    expect(blockEl?.textContent).not.toContain('**');
  });

  it('marks rendered incremental unit snapshots as HTML without using the legacy HTML string', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: false,
    });
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockImplementation(
      (_markdown, enabled, _priority, unitsRef) => {
        if (enabled && unitsRef) {
          unitsRef.current = [{
            id: 1,
            kind: 'paragraph',
            html: '<p class="md-p">incremental rendered text</p>',
          }];
        }
        return '';
      }
    );

    const { container } = render(
      <MarkdownBlockItem
        text="incremental rendered text"
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );

    const blockEl = container.querySelector('[data-streaming="true"]');
    expect(blockEl?.getAttribute('data-has-html')).toBe('true');
    expect(blockEl?.innerHTML).toBe(
      '<p class="md-p">incremental rendered text</p>'
    );
  });

  it('keeps the active tail blank instead of exposing Markdown while compilation is pending', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: false,
    });
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockReturnValue('');

    const { container } = render(
      <MarkdownBlockItem
        text="## Heading **still arriving"
        virtualClosedText="## Heading **still arriving**"
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );

    const blockEl = container.querySelector('[data-streaming="true"]');
    expect(blockEl?.textContent).toBe('');
  });

  it('does not reuse active HTML from a different Markdown block', () => {
    let liveHtml = '<p>old block</p>';
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: false,
    });
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockImplementation(
      () => liveHtml
    );

    const { container, rerender } = render(
      <MarkdownBlockItem
        text="old markdown"
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );
    expect(container.querySelector('[data-streaming="true"]')?.textContent).toBe(
      'old block'
    );

    liveHtml = '';
    rerender(
      <MarkdownBlockItem
        text="new markdown"
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );
    expect(container.querySelector('[data-streaming="true"]')?.textContent).toBe('');
  });

  it('keeps sealed block blank instead of exposing Markdown while compilation is pending', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: true,
      failed: false,
    });

    const { container } = render(
      <MarkdownBlockItem
        text="Sealed paragraph waiting for Rust compilation"
        isSealed={true}
        isLast={false}
        isStreaming={true}
      />
    );

    const blockEl = container.querySelector('[data-sealed="true"]');
    expect(blockEl).toBeTruthy();
    // Strictly NO skeleton line
    expect(container.querySelector('.skeletonLine')).toBeNull();
    // HTML 未就绪：禁止把 Markdown 源码画出来（打开历史不闪源码）
    expect(blockEl?.textContent).toBe('');
    expect((blockEl as HTMLElement).style.visibility).not.toBe('hidden');
  });

  it('injects compiled HTML seamlessly once Rust compilation finishes', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '<p class="md-p">Compiled Rich HTML</p>',
      loading: false,
      failed: false,
    });

    const { container } = render(
      <MarkdownBlockItem
        text="Paragraph text"
        isSealed={true}
        isLast={false}
        isStreaming={true}
      />
    );

    const blockEl = container.querySelector('[data-sealed="true"]');
    expect(blockEl?.innerHTML).toBe('<p class="md-p">Compiled Rich HTML</p>');
    expect(blockEl?.getAttribute('data-has-html')).toBe('true');
  });

  it('never exposes Markdown source when compilation fails, including during streaming', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: true,
    });

    const { container, rerender } = render(
      <MarkdownBlockItem
        text="## Source **must never appear**"
        isSealed={true}
        isLast={false}
        isStreaming={true}
      />
    );

    const block = container.querySelector('[data-sealed="true"]');
    expect(block?.textContent).toBe('');
    expect(container.querySelector('pre.md-text-fallback')).toBeNull();

    // Failure after streaming completes obeys the same no-source boundary.
    rerender(
      <MarkdownBlockItem
        text="## Source **must never appear**"
        isSealed={true}
        isLast={false}
        isStreaming={false}
      />
    );
    expect(block?.textContent).toBe('');
    expect(container.querySelector('pre.md-text-fallback')).toBeNull();
  });

  it('switches ordinary HTML to a React table subtree safely and preserves its row through sealing', async () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: false,
    });
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockImplementation(
      (_markdown, enabled) => enabled ? '<p>rendered prose</p>' : ''
    );

    const tableText = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const { container, rerender } = render(
      <MarkdownBlockItem
        text="ordinary paragraph"
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );
    const originalParagraph = container.querySelector('p');
    expect(originalParagraph?.textContent).toBe('rendered prose');

    rerender(
      <MarkdownBlockItem
        text={tableText}
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );

    await waitFor(() => expect(container.querySelector('table')).not.toBeNull());
    const streamedRow = container.querySelector('tbody tr');
    expect(streamedRow).not.toBeNull();
    expect(originalParagraph?.isConnected).toBe(false);

    rerender(
      <MarkdownBlockItem
        text={tableText}
        isSealed={true}
        isLast={true}
        isStreaming={true}
      />
    );

    expect(container.querySelector('tbody tr')).toBe(streamedRow);
    expect(container.querySelector('[data-streaming="false"] table')).not.toBeNull();
  });

  it('returns null when text is empty', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: false,
    });

    const { container } = render(
      <MarkdownBlockItem
        text=""
        isSealed={true}
        isLast={false}
        isStreaming={false}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('markdownBlockItemPropsEqual correctly identifies identical props to skip re-renders', () => {
    const prev = {
      text: 'Hello world',
      virtualClosedText: 'Hello world',
      isSealed: true,
      isLast: false,
      isStreaming: true,
      priority: Priority.High,
    };

    const nextSame = { ...prev };
    expect(markdownBlockItemPropsEqual(prev, nextSame)).toBe(true);

    const nextDiffText = { ...prev, text: 'Hello new world' };
    expect(markdownBlockItemPropsEqual(prev, nextDiffText)).toBe(false);

    const nextDiffSealed = { ...prev, isSealed: false };
    expect(markdownBlockItemPropsEqual(prev, nextDiffSealed)).toBe(false);
  });

  it('keeps TURBO mode, hides source while pending, and shows compiled HTML when ready', () => {
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockReturnValue('');
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: false,
    });

    const turboSnapshot = {
      instantRate: 2000,
      smoothedRate: 2000,
      tokenRate: 526,
      tier: 'TURBO' as const,
      staggerStepMs: 0,
      animationDurationMs: 0,
      allowWordSpans: false,
    };

    const { container, rerender } = render(
      <MarkdownBlockItem
        text="**High throughput turbo streaming** chunk 1"
        isSealed={false}
        isLast={true}
        isStreaming={true}
        rateSnapshot={turboSnapshot}
      />
    );

    const blockEl = container.querySelector('[data-streaming="true"]');
    expect(blockEl).toBeTruthy();
    expect(blockEl?.getAttribute('data-turbo')).toBe('true');
    expect(blockEl?.textContent).toBe('');

    // Streaming more tokens in TURBO mode
    rerender(
      <MarkdownBlockItem
        text="**High throughput turbo streaming** chunk 1 and chunk 2"
        isSealed={false}
        isLast={true}
        isStreaming={true}
        rateSnapshot={turboSnapshot}
      />
    );

    expect(blockEl?.childNodes.length).toBe(0);
    expect(blockEl?.textContent).toBe('');

    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockReturnValue(
      '<p><strong>High throughput turbo streaming</strong> chunk 1 and chunk 2, still parsing</p>'
    );
    rerender(
      <MarkdownBlockItem
        text="**High throughput turbo streaming** chunk 1 and chunk 2, still parsing"
        isSealed={false}
        isLast={true}
        isStreaming={true}
        rateSnapshot={turboSnapshot}
      />
    );

    expect(blockEl?.getAttribute('data-turbo')).toBe('true');
    const compiledParagraph = blockEl?.querySelector('p');
    expect(compiledParagraph).not.toBeNull();
    expect(blockEl?.innerHTML).toBe(
      '<p><strong>High throughput turbo streaming</strong> chunk 1 and chunk 2, still parsing</p>'
    );
    expect(blockEl?.textContent).not.toContain('**');

    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockReturnValue(
      '<p><strong>High throughput turbo streaming</strong> chunk 1, chunk 2, and chunk 3</p>'
    );
    rerender(
      <MarkdownBlockItem
        text="**High throughput turbo streaming** chunk 1, chunk 2, and chunk 3"
        isSealed={false}
        isLast={true}
        isStreaming={true}
        rateSnapshot={turboSnapshot}
      />
    );

    expect(blockEl?.querySelector('p')).toBe(compiledParagraph);
    expect(blockEl?.textContent).toContain('chunk 3');
    expect(blockEl?.textContent).not.toContain('**');
  });

  it('TC-TRE-08: 块级渲染模式冻结：活跃块流式期间 TURBO 模式不发生块内异构退化', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: false,
    });

    const turboSnapshot = {
      instantRate: 2000,
      smoothedRate: 2000,
      tokenRate: 526,
      tier: 'TURBO' as const,
      staggerStepMs: 0,
      animationDurationMs: 0,
      allowWordSpans: false,
    };

    const crawlSnapshot = {
      instantRate: 10,
      smoothedRate: 10,
      tokenRate: 2.6,
      tier: 'CRAWL' as const,
      staggerStepMs: 40,
      animationDurationMs: 120,
      allowWordSpans: true,
    };

    const { container, rerender } = render(
      <MarkdownBlockItem
        text="Active block starting in TURBO"
        isSealed={false}
        isLast={true}
        isStreaming={true}
        rateSnapshot={turboSnapshot}
      />
    );

    const blockEl = container.querySelector('[data-streaming="true"]');
    expect(blockEl?.getAttribute('data-turbo')).toBe('true');

    // Subsequent tick drops rate to CRAWL, but active tail keeps its frozen TURBO mode
    rerender(
      <MarkdownBlockItem
        text="Active block continuing after rate drop"
        isSealed={false}
        isLast={true}
        isStreaming={true}
        rateSnapshot={crawlSnapshot}
      />
    );

    expect(blockEl?.getAttribute('data-turbo')).toBe('true');
  });
});

