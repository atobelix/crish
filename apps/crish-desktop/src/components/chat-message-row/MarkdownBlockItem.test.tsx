// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import React from 'react';
import {
  MarkdownBlockItem,
  markdownBlockItemPropsEqual,
} from './MarkdownBlockItem';
import * as markdownRenderAsync from '../../api/markdownRenderAsync';
import { Priority } from '../../workers';
import type { IncrementalMarkdownUnitSnapshot } from '../../api/markdown/IncrementalMarkdownSession';

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
          unitsRef.current = [
            {
              id: 1,
              kind: 'paragraph',
              html: '<p class="md-p">incremental rendered text</p>',
            },
          ];
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
    expect(
      container.querySelector('[data-streaming="true"]')?.textContent
    ).toBe('old block');

    liveHtml = '';
    rerender(
      <MarkdownBlockItem
        text="new markdown"
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );
    expect(
      container.querySelector('[data-streaming="true"]')?.textContent
    ).toBe('');
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

  it('renders safe plaintext fallback when compilation fails for sealed block (VS-03 zero blank DOM)', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: true,
    });

    const { container, rerender } = render(
      <MarkdownBlockItem
        text="## Source text that failed to compile"
        isSealed={true}
        isLast={false}
        isStreaming={true}
      />
    );

    const block = container.querySelector('[data-sealed="true"]');
    expect(block).toBeTruthy();
    expect(block?.getAttribute('data-failed')).toBe('true');
    const fallbackText = container.querySelector('.markdown-fallback-text');
    expect(fallbackText).not.toBeNull();
    expect(fallbackText?.textContent).toBe(
      '## Source text that failed to compile'
    );
    // 纯文本节点转义渲染，绝无 HTML 注入
    expect(fallbackText?.querySelector('h2')).toBeNull();

    // Failure after streaming completes maintains safe plaintext fallback
    rerender(
      <MarkdownBlockItem
        text="## Source text that failed to compile"
        isSealed={true}
        isLast={false}
        isStreaming={false}
      />
    );
    expect(
      container.querySelector('.markdown-fallback-text')?.textContent
    ).toBe('## Source text that failed to compile');
  });

  it('handles React StrictMode double rendering without ref mutation polluting isContinuation', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: false,
    });
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockReturnValue('');

    const { container, rerender } = render(
      <React.StrictMode>
        <MarkdownBlockItem
          text="Block A"
          isSealed={false}
          isLast={true}
          isStreaming={true}
        />
      </React.StrictMode>
    );

    rerender(
      <React.StrictMode>
        <MarkdownBlockItem
          text="Block B completely different"
          isSealed={false}
          isLast={true}
          isStreaming={true}
        />
      </React.StrictMode>
    );

    expect(container.querySelector('[data-streaming="true"]')).toBeTruthy();
  });

  it('switches ordinary HTML to a React table subtree safely and preserves its row through sealing', async () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: false,
    });
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockImplementation(
      (_markdown, enabled) => (enabled ? '<p>rendered prose</p>' : '')
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

    await waitFor(() =>
      expect(container.querySelector('table')).not.toBeNull()
    );
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
    expect(
      container.querySelector('[data-streaming="false"] table')
    ).not.toBeNull();
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

  it('preserves incremental unit DOM nodes during SEALING_PENDING transition and promotes seamlessly when sealedHtml arrives', () => {
    let asyncResult = {
      html: '',
      loading: true,
      failed: false,
    };
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockImplementation(
      () => asyncResult
    );
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockImplementation(
      (_markdown, enabled, _priority, unitsRef) => {
        if (unitsRef) {
          unitsRef.current = enabled
            ? [
                {
                  id: 1,
                  kind: 'paragraph',
                  html: '<p class="md-p">Streaming paragraph content</p>',
                },
              ]
            : null;
        }
        return '';
      }
    );

    const { container, rerender } = render(
      <MarkdownBlockItem
        text="Streaming paragraph content"
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );

    const activeBlock = container.querySelector('[data-streaming="true"]');
    const activeParagraph = activeBlock?.querySelector('p.md-p');
    expect(activeParagraph).not.toBeNull();
    expect(activeParagraph?.textContent).toBe('Streaming paragraph content');
    expect(activeBlock?.getAttribute('data-has-html')).toBe('true');

    // Seal block while async sealedHtml is still pending ("") and streamingUnitsRef becomes null
    rerender(
      <MarkdownBlockItem
        text="Streaming paragraph content"
        isSealed={true}
        isLast={false}
        isStreaming={true}
      />
    );

    const pendingSealedBlock = container.querySelector('[data-sealed="true"]');
    expect(pendingSealedBlock).not.toBeNull();
    expect(pendingSealedBlock?.getAttribute('data-streaming')).toBe('false');
    expect(pendingSealedBlock?.getAttribute('data-has-html')).toBe('true');
    expect(pendingSealedBlock?.textContent).toBe('Streaming paragraph content');
    expect(pendingSealedBlock?.childNodes.length).toBe(1);
    expect(pendingSealedBlock?.querySelector('p.md-p')).toBe(activeParagraph);

    // Async sealedHtml arrives from Worker/Rust -> smooth in-place promotion
    asyncResult = {
      html: '<p class="md-p" data-authoritative="true">Streaming paragraph content</p>',
      loading: false,
      failed: false,
    };
    rerender(
      <MarkdownBlockItem
        text="Streaming paragraph content"
        isSealed={true}
        isLast={false}
        isStreaming={false}
      />
    );

    const finalBlock = container.querySelector('[data-sealed="true"]');
    const finalParagraph = finalBlock?.querySelector('p.md-p');
    expect(finalParagraph).toBe(activeParagraph);
    expect(finalParagraph?.getAttribute('data-authoritative')).toBe('true');
    expect(finalParagraph?.textContent).toBe('Streaming paragraph content');
  });

  it('C2 implicit sealing: preserves DOM content when user stops/aborts streaming (isStreaming: true -> false, isSealed: false)', () => {
    let asyncResult = {
      html: '',
      loading: true,
      failed: false,
    };
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockImplementation(
      () => asyncResult
    );
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockImplementation(
      (_markdown, enabled, _priority, unitsRef) => {
        if (unitsRef) {
          unitsRef.current = enabled
            ? [
                {
                  id: 1,
                  kind: 'paragraph',
                  html: '<p class="md-p">Aborted mid-stream text</p>',
                },
              ]
            : null;
        }
        return '';
      }
    );

    const { container, rerender } = render(
      <MarkdownBlockItem
        text="Aborted mid-stream text"
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );

    const activeParagraph = container.querySelector('p.md-p');
    expect(activeParagraph?.textContent).toBe('Aborted mid-stream text');

    // User clicks Stop: isStreaming becomes false while isSealed remains false
    rerender(
      <MarkdownBlockItem
        text="Aborted mid-stream text"
        isSealed={false}
        isLast={true}
        isStreaming={false}
      />
    );

    const abortedBlock = container.querySelector('[data-streaming="false"]');
    expect(abortedBlock).not.toBeNull();
    expect(abortedBlock?.getAttribute('data-has-html')).toBe('true');
    expect(abortedBlock?.textContent).toBe('Aborted mid-stream text');
    expect(abortedBlock?.querySelector('p.md-p')).toBe(activeParagraph);

    // When async compilation later resolves for the implicitly sealed block, it updates smoothly
    asyncResult = {
      html: '<p class="md-p" data-aborted-compiled="true">Aborted mid-stream text</p>',
      loading: false,
      failed: false,
    };
    rerender(
      <MarkdownBlockItem
        text="Aborted mid-stream text"
        isSealed={true}
        isLast={true}
        isStreaming={false}
      />
    );

    expect(abortedBlock?.querySelector('p.md-p')).toBe(activeParagraph);
    expect(
      abortedBlock
        ?.querySelector('p.md-p')
        ?.getAttribute('data-aborted-compiled')
    ).toBe('true');
  });

  it('clears locked unit snapshots when text is emptied or switched to an unrelated block', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: false,
    });
    let currentUnits: IncrementalMarkdownUnitSnapshot[] | null = [
      {
        id: 1,
        kind: 'paragraph',
        html: '<p class="md-p">First block snapshot</p>',
      },
    ];
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockImplementation(
      (_markdown, enabled, _priority, unitsRef) => {
        if (unitsRef && enabled && currentUnits) {
          unitsRef.current = currentUnits;
        }
        return '';
      }
    );

    const { container, rerender } = render(
      <MarkdownBlockItem
        text="First block snapshot"
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );
    expect(container.textContent).toBe('First block snapshot');

    // Switch to a completely different block while compilation is pending
    currentUnits = null;
    rerender(
      <MarkdownBlockItem
        text="Unrelated second block"
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );
    expect(container.textContent).toBe('');
  });
});
