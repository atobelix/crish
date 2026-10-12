// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import * as markdownRenderAsync from '../../api/markdownRenderAsync';
import { THINKING_PREVIEW_CHARS } from './narrativeModel';
import { ThinkingBlock } from './ThinkingBlock';

vi.mock('../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: vi.fn(),
  useStreamingMarkdownHtml: vi.fn(),
}));

const richMarkdown =
  '# Markdown title\n\n**bold phrase**\n\n```ts\nconst value = 1;\n```';
const richHtml =
  '<h1 class="md-h1">Markdown title</h1><p><strong>bold phrase</strong></p><pre><code>const value = 1;</code></pre>';

function renderTestMarkdown(markdown: string): string {
  if (markdown === richMarkdown) return richHtml;
  if (!markdown) return '';
  let html = markdown.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a class="md-a" href="$2">$1</a>'
  );
  return `<p>${html}</p>`;
}

describe('ThinkingBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockImplementation(
      (markdown) => ({
        html: renderTestMarkdown(markdown),
        loading: false,
        failed: false,
      })
    );
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockImplementation(
      (markdown, enabled) => (enabled ? renderTestMarkdown(markdown) : '')
    );
  });

  afterEach(() => {
    cleanup();
  });

  const long = '思'.repeat(80);

  it('默认只有预览、无全文节点', () => {
    const { container } = render(<ThinkingBlock content={long} />);
    expect(container.querySelector('[data-flow-thinking-full]')).toBeNull();
    expect(
      container.querySelector('[data-flow-thinking-preview]')
    ).not.toBeNull();
    expect(container.textContent ?? '').not.toContain(long);
    const preview = container.querySelector('[data-flow-thinking-preview]');
    expect((preview?.textContent ?? '').length).toBeLessThanOrEqual(
      THINKING_PREVIEW_CHARS + 8
    );
  });

  it('展开才挂全文', () => {
    const { container } = render(<ThinkingBlock content={long} />);
    fireEvent.click(screen.getByRole('button', { name: /思考过程/ }));
    const full = container.querySelector('[data-flow-thinking-full]');
    expect(full).not.toBeNull();
    expect(full?.textContent).toBe(long);
    expect(container.querySelector('[data-flow-thinking-preview]')).toBeNull();
  });

  it('live 计时 1Hz，卸载 clearInterval', () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(window, 'setInterval');
    const clearSpy = vi.spyOn(window, 'clearInterval');
    const { container, unmount } = render(
      <ThinkingBlock content="正在想" isLive />
    );
    expect(setSpy.mock.calls.some((c) => c[1] === 1000)).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toMatch(/1s/);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    setSpy.mockRestore();
    clearSpy.mockRestore();
    vi.useRealTimers();
  });

  it('defaultOpen=true 初始挂全文；false 只有预览', () => {
    const open = render(<ThinkingBlock content={long} defaultOpen />);
    expect(
      open.container.querySelector('[data-flow-thinking-full]')
    ).not.toBeNull();
    expect(
      open.container.querySelector('[data-flow-expanded="true"]')
    ).not.toBeNull();
    expect(
      open.container.querySelector('[data-flow-thinking-preview]')
    ).toBeNull();
    open.unmount();

    const closed = render(<ThinkingBlock content={long} defaultOpen={false} />);
    expect(
      closed.container.querySelector('[data-flow-thinking-full]')
    ).toBeNull();
    expect(
      closed.container.querySelector('[data-flow-expanded="false"]')
    ).not.toBeNull();
    expect(
      closed.container.querySelector('[data-flow-thinking-preview]')
    ).not.toBeNull();
  });

  it.each([
    { label: 'non-live preview', isLive: false, open: false },
    { label: 'non-live expanded body', isLive: false, open: true },
    { label: 'live preview', isLive: true, open: false },
    { label: 'live expanded body', isLive: true, open: true },
  ])(
    '$label only inserts renderer-produced Markdown HTML',
    ({ isLive, open }) => {
      const { container } = render(
        <ThinkingBlock
          content={richMarkdown}
          preview={richMarkdown}
          isLive={isLive}
          defaultOpen={open}
        />
      );
      const view = container.querySelector(
        open
          ? '[data-flow-thinking-full]'
          : '[data-flow-thinking-preview-content]'
      );

      expect(view?.querySelector('h1')?.textContent).toBe('Markdown title');
      expect(view?.querySelector('strong')?.textContent).toBe('bold phrase');
      expect(view?.querySelector('pre code')?.textContent).toBe(
        'const value = 1;'
      );
      expect(view?.innerHTML).toBe(richHtml);
      expect(view?.textContent).not.toContain('# Markdown title');
      expect(view?.textContent).not.toContain('**bold phrase**');
      expect(view?.textContent).not.toContain('```');
    }
  );

  it('live preview keeps existing Markdown DOM nodes while the active paragraph grows', () => {
    const { container, rerender } = render(
      <ThinkingBlock content="" preview="**first**" isLive />
    );
    const view = container.querySelector(
      '[data-flow-thinking-preview-content]'
    );
    const paragraph = view?.querySelector('p');
    const strong = view?.querySelector('strong');

    rerender(<ThinkingBlock content="" preview="**first grows**" isLive />);

    expect(view?.querySelector('p')).toBe(paragraph);
    expect(view?.querySelector('strong')).toBe(strong);
    expect(strong?.textContent).toBe('first grows');
    expect(view?.textContent).not.toContain('**');
  });

  it('live preview and expanded body each receive an incremental unit session', () => {
    const preview = render(<ThinkingBlock content="**live preview**" isLive />);
    const previewCall = vi
      .mocked(markdownRenderAsync.useStreamingMarkdownHtml)
      .mock.calls.find(([, enabled]) => enabled);
    expect(previewCall?.[3]).toBeDefined();
    expect(preview.container.textContent).not.toContain('**live preview**');
    preview.unmount();

    vi.clearAllMocks();
    const expanded = render(
      <ThinkingBlock content="## **live body**" isLive defaultOpen />
    );
    const fullCall = vi
      .mocked(markdownRenderAsync.useStreamingMarkdownHtml)
      .mock.calls.find(([, enabled]) => enabled);
    expect(fullCall?.[3]).toBeDefined();
    expect(expanded.container.textContent).not.toContain('## **live body**');
  });

  it.each([
    { label: 'non-live preview', isLive: false, open: false },
    { label: 'non-live expanded body', isLive: false, open: true },
    { label: 'live preview', isLive: true, open: false },
    { label: 'live expanded body', isLive: true, open: true },
  ])('$label stays blank while rendering is pending', ({ isLive, open }) => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: true,
      failed: false,
    });
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockReturnValue('');

    const { container } = render(
      <ThinkingBlock
        content={richMarkdown}
        preview={richMarkdown}
        isLive={isLive}
        defaultOpen={open}
      />
    );
    const view = container.querySelector(
      open
        ? '[data-flow-thinking-full]'
        : '[data-flow-thinking-preview-content]'
    );

    expect(view?.innerHTML).toBe('');
    expect(view?.textContent).toBe('');
  });

  it.each([
    { label: 'non-live preview', isLive: false, open: false },
    { label: 'non-live expanded body', isLive: false, open: true },
    { label: 'live preview', isLive: true, open: false },
    { label: 'live expanded body', isLive: true, open: true },
  ])('$label stays blank when rendering fails', ({ isLive, open }) => {
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: true,
    });
    vi.mocked(markdownRenderAsync.useStreamingMarkdownHtml).mockReturnValue('');

    const { container } = render(
      <ThinkingBlock
        content={richMarkdown}
        preview={richMarkdown}
        isLive={isLive}
        defaultOpen={open}
      />
    );
    const view = container.querySelector(
      open
        ? '[data-flow-thinking-full]'
        : '[data-flow-thinking-preview-content]'
    );

    expect(view?.innerHTML).toBe('');
    expect(view?.textContent).toBe('');
  });

  it('已挂载块不随 defaultOpen 变化改开合（仅新渲染生效）', () => {
    const { container, rerender } = render(
      <ThinkingBlock content={long} defaultOpen={false} />
    );
    expect(container.querySelector('[data-flow-thinking-full]')).toBeNull();
    rerender(<ThinkingBlock content={long} defaultOpen />);
    expect(container.querySelector('[data-flow-thinking-full]')).toBeNull();
    expect(
      container.querySelector('[data-flow-expanded="false"]')
    ).not.toBeNull();
  });

  it('无放大查阅器按钮，无原生 title（查阅器已随 thoughtInspectorStore 移除）', () => {
    const { container } = render(
      <ThinkingBlock content={long} messageId="m1" />
    );
    expect(container.querySelector('[title]')).toBeNull();
    expect(screen.queryByLabelText('查看完整思考链')).toBeNull();
    // 查阅器入口不得回归（store 已删除，禁止重新引入悬浮放大入口）
    expect(container.querySelector('[data-thought-inspector]')).toBeNull();
    expect(container.querySelector('[data-flow-inspector]')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /放大|查阅|完整思考链/ })
    ).toBeNull();
  });

  describe('md-rendered 命名空间与安全外链导航', () => {
    it('折叠预览与展开全文容器均挂载 md-rendered 类名', () => {
      const closed = render(
        <ThinkingBlock content="思考预览内容" defaultOpen={false} />
      );
      const previewEl = closed.container.querySelector(
        '[data-flow-thinking-preview-content]'
      );
      expect(previewEl).not.toBeNull();
      expect(previewEl?.classList.contains('md-rendered')).toBe(true);
      closed.unmount();

      const open = render(
        <ThinkingBlock content="思考全文内容" defaultOpen={true} />
      );
      const fullEl = open.container.querySelector('[data-flow-thinking-full]');
      expect(fullEl).not.toBeNull();
      expect(fullEl?.classList.contains('md-rendered')).toBe(true);
      open.unmount();
    });

    it('点击外部 HTTPS 链接通过 handleSafeExternalLinkClick 安全唤起 window.open', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      const { container } = render(
        <ThinkingBlock
          content="参考文档：[Conex 官网](https://example.com/docs)"
          defaultOpen
        />
      );
      const link = container.querySelector('a');
      expect(link).not.toBeNull();

      const notPrevented = fireEvent.click(link!);
      expect(notPrevented).toBe(false);
      expect(openSpy).toHaveBeenCalledWith(
        'https://example.com/docs',
        '_blank',
        'noopener,noreferrer'
      );
      openSpy.mockRestore();
    });

    it('折叠预览中点击外部链接同样走安全唤起', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      const { container } = render(
        <ThinkingBlock
          content="全文 [链接](https://example.com/full)"
          preview="预览 [链接](https://example.com/preview)"
          defaultOpen={false}
        />
      );
      const link = container.querySelector(
        '[data-flow-thinking-preview-content] a'
      );
      expect(link).not.toBeNull();

      const notPrevented = fireEvent.click(link!);
      expect(notPrevented).toBe(false);
      expect(openSpy).toHaveBeenCalledWith(
        'https://example.com/preview',
        '_blank',
        'noopener,noreferrer'
      );
      openSpy.mockRestore();
    });

    it('javascript: 恶意链接阻止默认行为且不调用 window.open', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      const { container } = render(
        <ThinkingBlock
          content="恶意注入：[点击测试](javascript:alert(1))"
          defaultOpen
        />
      );
      const link = container.querySelector('a');
      expect(link).not.toBeNull();

      const notPrevented = fireEvent.click(link!);
      expect(notPrevented).toBe(false);
      expect(openSpy).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });

    it('相对路径与页内锚点不触发 window.open', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      const { container } = render(
        <ThinkingBlock content="内部跳转：[章节一](#sec-1)" defaultOpen />
      );
      const link = container.querySelector('a');
      expect(link).not.toBeNull();

      fireEvent.click(link!);
      expect(openSpy).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });

    it('提供 onLinkClick 时优先委托给回调并阻止原生导航', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      const onLinkClick = vi.fn();
      const { container } = render(
        <ThinkingBlock
          content="外部参考：[文档](https://example.com)"
          defaultOpen
          onLinkClick={onLinkClick}
        />
      );
      const link = container.querySelector('a');
      expect(link).not.toBeNull();

      const notPrevented = fireEvent.click(link!);
      expect(notPrevented).toBe(false);
      expect(onLinkClick).toHaveBeenCalledWith('https://example.com');
      expect(openSpy).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });
  });
});
