// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, renderHook, screen, act } from '@testing-library/react';
import React from 'react';
import { StreamingMarkdownView } from './StreamingMarkdownView';
import { MarkdownBlockItem } from './MarkdownBlockItem';
import { useStreamingBlocks } from './useStreamingBlocks';
import * as markdownRenderAsync from '../../api/markdownRenderAsync';

vi.mock('../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: vi.fn(),
  useStreamingMarkdownHtml: vi.fn(() => ''),
  parseMarkdownToHtmlAsync: vi.fn(),
}));

vi.mock('../../store/storeAccess', () => ({
  useSettingsField: vi.fn(() => 2),
}));

describe('StreamingMarkdownView & MarkdownBlockItem & useStreamingBlocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useStreamingBlocks Hook', () => {
    it('returns empty blocks when input is empty', () => {
      function TestComp({ text, isStreaming }: { text: string; isStreaming: boolean }) {
        const { blocks } = useStreamingBlocks(text, isStreaming, 'msg-1');
        return <div data-count={blocks.length} />;
      }
      const { container } = render(<TestComp text="" isStreaming={true} />);
      expect(container.firstChild).toHaveAttribute('data-count', '0');
    });

    it('identifies sealed blocks and active tail block during streaming', () => {
      const text = '# Title\n\nParagraph 1.\n\nActive paragraph in progress';
      let capturedBlocks: any[] = [];

      function TestComp({ text, isStreaming }: { text: string; isStreaming: boolean }) {
        const { blocks } = useStreamingBlocks(text, isStreaming, 'msg-1');
        capturedBlocks = blocks;
        return null;
      }

      render(<TestComp text={text} isStreaming={true} />);

      expect(capturedBlocks.length).toBeGreaterThanOrEqual(3);
      // Historical blocks are sealed
      expect(capturedBlocks[0].isSealed).toBe(true);
      expect(capturedBlocks[1].isSealed).toBe(true);
      // Last block is active tail
      expect(capturedBlocks[capturedBlocks.length - 1].isSealed).toBe(false);
    });

    it('marks all blocks as sealed when streaming is finished', () => {
      const text = '# Title\n\nParagraph 1.\n\nFinal paragraph.';
      let capturedBlocks: any[] = [];

      function TestComp({ text, isStreaming }: { text: string; isStreaming: boolean }) {
        const { blocks } = useStreamingBlocks(text, isStreaming, 'msg-1');
        capturedBlocks = blocks;
        return null;
      }

      render(<TestComp text={text} isStreaming={false} />);

      expect(capturedBlocks.length).toBeGreaterThanOrEqual(3);
      expect(capturedBlocks.every((b) => b.isSealed)).toBe(true);
    });

    it('reuses sealed block object references across streaming updates (0 re-render guarantee)', () => {
      const { result, rerender } = renderHook(
        ({ text, isStreaming }: { text: string; isStreaming: boolean }) =>
          useStreamingBlocks(text, isStreaming, 'msg-1'),
        {
          initialProps: {
            text: '# Fixed Title\n\nFixed Paragraph.\n\nTyping...',
            isStreaming: true,
          },
        }
      );

      const firstPass = result.current.blocks;

      rerender({
        text: '# Fixed Title\n\nFixed Paragraph.\n\nTyping... more characters',
        isStreaming: true,
      });

      const secondPass = result.current.blocks;

      expect(firstPass.length).toBeGreaterThanOrEqual(3);
      expect(firstPass.length).toBe(secondPass.length);

      // All sealed historical blocks (0 .. N-2) MUST have strictly identical object references
      for (let i = 0; i < firstPass.length - 1; i += 1) {
        expect(firstPass[i]).toBe(secondPass[i]);
      }

      // The last active tail block reference is new because its text changed
      const lastIdx = firstPass.length - 1;
      expect(firstPass[lastIdx]).not.toBe(secondPass[lastIdx]);
    });
  });

  describe('MarkdownBlockItem double-buffered promotion', () => {
    it('renders compiled active tail HTML and never exposes the Markdown source', () => {
      vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
        html: '',
        loading: false,
        failed: false,
      });
      vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockReturnValue(
        '<p>Typing active tail...</p>'
      );

      const { container } = render(
        <MarkdownBlockItem
          text="**Typing active tail...**"
          virtualClosedText="**Typing active tail...**"
          isSealed={false}
          isLast={true}
          isStreaming={true}
        />
      );

      const blockEl = container.querySelector('[data-streaming="true"]');
      expect(blockEl).toBeTruthy();
      expect(blockEl?.getAttribute('data-sealed')).toBe('false');
      expect(blockEl?.innerHTML).toBe('<p>Typing active tail...</p>');
      expect(blockEl?.textContent).not.toContain('**');
    });

    it('keeps sealed block blank instead of exposing Markdown while compilation is pending', () => {
      // Mock pending Rust compilation state
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

    it('does not expose Markdown source when compilation fails', () => {
      vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
        html: '',
        loading: false,
        failed: true,
      });

      const { container } = render(
        <MarkdownBlockItem
          text="## Source **must never appear**"
          isSealed={true}
          isLast={false}
          isStreaming={false}
        />
      );

      const block = container.querySelector('[data-sealed="true"]');
      expect(block?.textContent).toBe('');
      expect(container.querySelector('pre.md-text-fallback')).toBeNull();
    });
  });

  describe('StreamingMarkdownView container', () => {
    it('renders list of blocks correctly during streaming', () => {
      vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockImplementation((text) => {
        if (!text) return { html: '', loading: false, failed: false };
        return {
          html: `<div class="compiled">${text}</div>`,
          loading: false,
          failed: false,
        };
      });

      const content = '# Heading\n\nParagraph text.\n\nTyping active tail...';
      vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockReturnValue(
        '<p>Typing active tail...</p>'
      );
      const { container } = render(
        <StreamingMarkdownView
          content={content}
          isStreaming={true}
          messageId="test-msg"
        />
      );

      const root = container.querySelector('[data-streaming="true"]');
      expect(root).toBeTruthy();

      const sealedBlocks = container.querySelectorAll('[data-sealed="true"]');
      expect(sealedBlocks.length).toBeGreaterThanOrEqual(2);

      const activeBlock = container.querySelector('[data-sealed="false"]');
      expect(activeBlock).toBeTruthy();
      expect(activeBlock?.innerHTML).toBe('<p>Typing active tail...</p>');
    });

    it('returns null when content is empty', () => {
      const { container } = render(
        <StreamingMarkdownView
          content=""
          isStreaming={false}
          messageId="test-msg"
        />
      );
      expect(container.firstChild).toBeNull();
    });

    it('sets data-tier on the root element according to rate estimator tier', () => {
      vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
        html: '',
        loading: false,
        failed: false,
      });

      const { container, rerender } = render(
        <StreamingMarkdownView
          content="Initial text chunk"
          isStreaming={true}
          messageId="test-msg"
        />
      );

      const root = container.querySelector('.conex-streaming-root');
      expect(root).toBeTruthy();
      // Cold start sample 1 defaults to NORMAL
      expect(root?.getAttribute('data-tier')).toBe('NORMAL');

      // Sample 2
      rerender(
        <StreamingMarkdownView
          content={"Initial text chunk" + " A".repeat(1000)}
          isStreaming={true}
          messageId="test-msg"
        />
      );
      // Cold start sample 2 still defaults to NORMAL
      expect(root?.getAttribute('data-tier')).toBe('NORMAL');

      // Sample 3 (Cold start complete, extreme high throughput burst)
      rerender(
        <StreamingMarkdownView
          content={"Initial text chunk" + " A".repeat(2000)}
          isStreaming={true}
          messageId="test-msg"
        />
      );

      expect(root?.getAttribute('data-tier')).toBe('TURBO');
    });
  });
});

