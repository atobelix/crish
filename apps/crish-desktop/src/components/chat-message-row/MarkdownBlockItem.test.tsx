// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { MarkdownBlockItem, markdownBlockItemPropsEqual } from './MarkdownBlockItem';
import * as markdownRenderAsync from '../../api/markdownRenderAsync';
import { Priority } from '../../workers';

vi.mock('../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: vi.fn(),
}));

vi.mock('../../store/storeAccess', () => ({
  useSettingsField: vi.fn(() => 2),
}));

describe('MarkdownBlockItem component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders active tail block with text content in DOM and streaming attributes', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: false,
    });

    const { container } = render(
      <MarkdownBlockItem
        text="Typing active tail..."
        virtualClosedText="Typing active tail... (closed)"
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );

    const blockEl = container.querySelector('[data-streaming="true"]');
    expect(blockEl).toBeTruthy();
    expect(blockEl?.getAttribute('data-sealed')).toBe('false');
    // Active tail displays virtualClosedText
    expect(blockEl?.textContent).toBe('Typing active tail... (closed)');
  });

  it('maintains draft text shim without rendering skeleton during async compilation pending', () => {
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

  it('renders safe fallback pre element when compilation fails and no html is returned', () => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: true,
    });

    const { container } = render(
      <MarkdownBlockItem
        text="Fallback plain text content"
        isSealed={true}
        isLast={false}
        isStreaming={false}
      />
    );

    const preFallback = container.querySelector('pre.md-text-fallback');
    expect(preFallback).toBeTruthy();
    expect(preFallback?.textContent).toBe('Fallback plain text content');
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

  it('switches to TURBO mode with single native TextNode and data-turbo="true" when rateSnapshot tier is TURBO', () => {
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
        text="High throughput turbo streaming chunk 1"
        isSealed={false}
        isLast={true}
        isStreaming={true}
        rateSnapshot={turboSnapshot}
      />
    );

    const blockEl = container.querySelector('[data-streaming="true"]');
    expect(blockEl).toBeTruthy();
    expect(blockEl?.getAttribute('data-turbo')).toBe('true');
    expect(blockEl?.childNodes.length).toBe(1);
    expect(blockEl?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(blockEl?.textContent).toBe('High throughput turbo streaming chunk 1');

    // Streaming more tokens in TURBO mode
    rerender(
      <MarkdownBlockItem
        text="High throughput turbo streaming chunk 1 and chunk 2"
        isSealed={false}
        isLast={true}
        isStreaming={true}
        rateSnapshot={turboSnapshot}
      />
    );

    expect(blockEl?.childNodes.length).toBe(1);
    expect(blockEl?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(blockEl?.textContent).toBe('High throughput turbo streaming chunk 1 and chunk 2');
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

