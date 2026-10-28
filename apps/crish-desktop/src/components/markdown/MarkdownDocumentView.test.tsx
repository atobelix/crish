// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import React from 'react';
import {
  MarkdownDocumentView,
  parsePathAndLocation,
} from './MarkdownDocumentView';
import * as markdownRenderAsync from '../../api/markdownRenderAsync';

vi.mock('../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: vi.fn(),
}));

vi.mock('../diff/VirtualPlainCodeViewer', () => ({
  VirtualPlainCodeViewer: vi.fn(({ content, filePath, wordWrap }: any) => (
    <div
      data-testid="virtual-code-viewer"
      data-filepath={filePath}
      data-wordwrap={String(wordWrap)}
    >
      {content}
    </div>
  )),
}));

describe('MarkdownDocumentView 架构契约与立体验证测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '<p>Hello world</p>',
      loading: false,
      failed: false,
    });
  });

  describe('parsePathAndLocation 纯逻辑解析算法', () => {
    it('正确解析 #L 锚点行号', () => {
      expect(parsePathAndLocation('src/app.ts#L42')).toEqual({
        cleanPath: 'src/app.ts',
        line: 42,
        col: undefined,
      });
      expect(parsePathAndLocation('src/app.ts#L42-L60')).toEqual({
        cleanPath: 'src/app.ts',
        line: 42,
        col: undefined,
      });
    });

    it('正确解析 :line:col 与 :line 冒号行号', () => {
      expect(parsePathAndLocation('crates/core/lib.rs:18:5')).toEqual({
        cleanPath: 'crates/core/lib.rs',
        line: 18,
        col: 5,
      });
      expect(parsePathAndLocation('crates/core/lib.rs:18')).toEqual({
        cleanPath: 'crates/core/lib.rs',
        line: 18,
        col: undefined,
      });
    });

    it('无行号时原样返回 cleanPath', () => {
      expect(parsePathAndLocation('docs/README.md')).toEqual({
        cleanPath: 'docs/README.md',
        line: undefined,
        col: undefined,
      });
      expect(parsePathAndLocation('C:\\Software\\project\\main.ts')).toEqual({
        cleanPath: 'C:\\Software\\project\\main.ts',
        line: undefined,
        col: undefined,
      });
    });
  });

  describe('大文件前置硬熔断契约', () => {
    it('当 content 长度超过 largeFileThreshold 时，向 useAsyncMarkdownHtml 传空串并挂载 VirtualPlainCodeViewer', () => {
      const hugeContent = 'a'.repeat(300 * 1024); // 300KB > 256KB
      const { container } = render(
        <MarkdownDocumentView
          content={hugeContent}
          filePath="large-document.md"
          largeFileThreshold={256 * 1024}
          wordWrap={true}
        />
      );

      // 验证严格阻断：给 useAsyncMarkdownHtml 传递空串
      expect(markdownRenderAsync.useAsyncMarkdownHtml).toHaveBeenCalledWith(
        '',
        expect.anything()
      );

      // 验证挂载 VirtualPlainCodeViewer
      const viewer = container.querySelector(
        '[data-testid="virtual-code-viewer"]'
      );
      expect(viewer).toBeTruthy();
      expect(viewer?.getAttribute('data-filepath')).toBe('large-document.md');
      expect(viewer?.getAttribute('data-wordwrap')).toBe('true');

      // 验证虚拟化视口仍渲染且无冗余提示横幅
      const banner = container.querySelector('[role="status"]');
      expect(banner).toBeNull();
      expect(container.querySelector('.md-large-file-banner')).toBeNull();
    });

    it('当 content 长度小于 threshold 时，正常调用 useAsyncMarkdownHtml 并渲染 HTML', () => {
      const normalContent = '# Normal Title\n\nSome body text';
      const { container } = render(
        <MarkdownDocumentView
          content={normalContent}
          largeFileThreshold={256 * 1024}
        />
      );

      expect(markdownRenderAsync.useAsyncMarkdownHtml).toHaveBeenCalledWith(
        normalContent,
        expect.anything()
      );
      const rendered = container.querySelector('.md-rendered.conex-markdown');
      expect(rendered).toBeTruthy();
      expect(rendered?.innerHTML).toBe('<p>Hello world</p>');
    });
  });

  describe('挂载结构与 CSS 原生 tab-size', () => {
    it('挂载结构包含 md-rendered conex-markdown 以及 data-md-variant', () => {
      const { container } = render(
        <MarkdownDocumentView
          content="Test"
          variant="chat"
          className="custom-cls"
        />
      );

      const root = container.querySelector(
        '.md-rendered.conex-markdown.custom-cls'
      );
      expect(root).toBeTruthy();
      expect(root?.getAttribute('data-md-variant')).toBe('chat');
      // CSS 原生 tab-size 替代
      expect((root as HTMLElement)?.style.tabSize).toBe(
        'var(--md-code-tab-size, 2)'
      );
    });

    it('默认 variant 为 document', () => {
      const { container } = render(<MarkdownDocumentView content="Test" />);
      const root = container.querySelector('.md-rendered');
      expect(root?.getAttribute('data-md-variant')).toBe('document');
    });

    it('failed 时平滑降级为 pre.md-text-fallback 达成 Zero-CLS', () => {
      vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
        html: '',
        loading: false,
        failed: true,
      });

      const { container } = render(
        <MarkdownDocumentView content="# Failed to render" />
      );

      const fallbackPre = container.querySelector('pre.md-text-fallback');
      expect(fallbackPre).toBeTruthy();
      expect(fallbackPre?.textContent).toBe('# Failed to render');
    });

    it('空内容且提供 emptyPlaceholder 时优雅呈现', () => {
      const { container } = render(
        <MarkdownDocumentView content="" emptyPlaceholder="暂无内容" />
      );

      const emptyEl = container.querySelector('.md-empty-placeholder');
      expect(emptyEl).toBeTruthy();
      expect(emptyEl?.textContent).toBe('暂无内容');
    });
  });

  describe('容器级事件委托与功能连通', () => {
    it('拦截 .md-code-copy 按钮，写入剪贴板，挂载 .is-copied 与文案，1500ms 后复位', async () => {
      vi.useFakeTimers();
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: writeTextMock },
      });

      vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
        html: `
          <div class="md-code-block">
            <button type="button" class="md-code-copy">复制</button>
            <pre class="md-code-pre"><code>console.log('hello');</code></pre>
          </div>
        `,
        loading: false,
        failed: false,
      });

      const onCopyFeedback = vi.fn();
      const { container } = render(
        <MarkdownDocumentView
          content="```js\nconsole.log('hello');\n```"
          onCopyFeedback={onCopyFeedback}
        />
      );

      const copyBtn = container.querySelector('.md-code-copy') as HTMLElement;
      expect(copyBtn).toBeTruthy();

      await act(async () => {
        fireEvent.click(copyBtn);
      });

      expect(writeTextMock).toHaveBeenCalledWith("console.log('hello');");
      expect(copyBtn.classList.contains('is-copied')).toBe(true);
      expect(copyBtn.textContent).toBe('已复制');
      expect(onCopyFeedback).toHaveBeenCalledWith(
        'success',
        "console.log('hello');"
      );

      // 1500ms 复位
      act(() => {
        vi.advanceTimersByTime(1500);
      });

      expect(copyBtn.classList.contains('is-copied')).toBe(false);
      expect(copyBtn.textContent).toBe('复制');

      vi.useRealTimers();
    });

    it('拦截 .md-path-link 按钮，拆解 data-path 并触发 onOpenPath 与全局事件', () => {
      const onOpenPath = vi.fn();
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

      vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
        html: `
          <p>
            参考文件：
            <button type="button" class="md-path-link" data-path="apps/crish-desktop/src/main.ts:42:10">
              main.ts:42:10
            </button>
          </p>
        `,
        loading: false,
        failed: false,
      });

      const { container } = render(
        <MarkdownDocumentView
          content="`main.ts:42:10`"
          onOpenPath={onOpenPath}
        />
      );

      const pathBtn = container.querySelector('.md-path-link') as HTMLElement;
      expect(pathBtn).toBeTruthy();

      fireEvent.click(pathBtn);

      expect(onOpenPath).toHaveBeenCalledWith('apps/crish-desktop/src/main.ts');
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'crish-open-file',
          detail: {
            path: 'apps/crish-desktop/src/main.ts',
            line: 42,
            col: 10,
          },
        })
      );
    });

    it('拦截 a.md-a 外部链接，通过系统浏览器安全打开', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
        html: `<p><a class="md-a" href="https://example.com/doc">文档</a></p>`,
        loading: false,
        failed: false,
      });

      const { container } = render(
        <MarkdownDocumentView content="[文档](https://example.com/doc)" />
      );

      const anchor = container.querySelector('a.md-a') as HTMLElement;
      expect(anchor).toBeTruthy();

      await act(async () => {
        fireEvent.click(anchor);
      });

      expect(openSpy).toHaveBeenCalledWith(
        'https://example.com/doc',
        '_blank',
        'noopener,noreferrer'
      );
      openSpy.mockRestore();
    });

    it('§7.1 大小写 HTTPS:// 外链走 sanitize/isSafeHref 并 window.open', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
        html: `<p><a class="md-a" href="HTTPS://example.com/Upper">文档</a></p>`,
        loading: false,
        failed: false,
      });

      const { container } = render(
        <MarkdownDocumentView content="[文档](HTTPS://example.com/Upper)" />
      );

      const anchor = container.querySelector('a.md-a') as HTMLAnchorElement;
      expect(anchor).toBeTruthy();

      await act(async () => {
        fireEvent.click(anchor);
      });

      expect(openSpy).toHaveBeenCalledWith(
        'HTTPS://example.com/Upper',
        '_blank',
        'noopener,noreferrer'
      );
      openSpy.mockRestore();
    });

    it('§7.1 大小写 MAILTO: 外链走 sanitize/isSafeHref 并 window.open', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
        html: `<p><a class="md-a" href="MAILTO:dev@example.com">邮件</a></p>`,
        loading: false,
        failed: false,
      });

      const { container } = render(
        <MarkdownDocumentView content="[邮件](MAILTO:dev@example.com)" />
      );

      const anchor = container.querySelector('a.md-a') as HTMLAnchorElement;
      expect(anchor).toBeTruthy();

      await act(async () => {
        fireEvent.click(anchor);
      });

      expect(openSpy).toHaveBeenCalledWith(
        'MAILTO:dev@example.com',
        '_blank',
        'noopener,noreferrer'
      );
      openSpy.mockRestore();
    });

    it('§7.1 javascript: 不安全链 preventDefault 且不 window.open', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
        html: `<p><a class="md-a" href="javascript:alert(1)">坏链</a></p>`,
        loading: false,
        failed: false,
      });

      const { container } = render(
        <MarkdownDocumentView content="[坏链](javascript:alert(1))" />
      );

      const anchor = container.querySelector('a.md-a') as HTMLAnchorElement;
      expect(anchor).toBeTruthy();

      let defaultPrevented = false;
      await act(async () => {
        const evt = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
        });
        anchor.dispatchEvent(evt);
        defaultPrevented = evt.defaultPrevented;
      });

      // fireEvent 路径再验一遍
      await act(async () => {
        fireEvent.click(anchor);
      });

      expect(openSpy).not.toHaveBeenCalled();
      expect(defaultPrevented).toBe(true);
      openSpy.mockRestore();
    });

    it('§7.1 未知 scheme 不安全链不 window.open', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
        html: `<p><a class="md-a" href="foo:bar">未知</a></p>`,
        loading: false,
        failed: false,
      });

      const { container } = render(
        <MarkdownDocumentView content="[未知](foo:bar)" />
      );

      const anchor = container.querySelector('a.md-a') as HTMLAnchorElement;
      await act(async () => {
        fireEvent.click(anchor);
      });

      expect(openSpy).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });

    it('§7.1 相对路径与 #锚点不外开 window.open', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
        html: `
          <p><a class="md-a" href="./local.md">本地</a></p>
          <p><a class="md-a" href="#section">锚点</a></p>
        `,
        loading: false,
        failed: false,
      });

      const { container } = render(
        <MarkdownDocumentView content="[本地](./local.md) [#](#section)" />
      );

      const anchors = container.querySelectorAll('a.md-a');
      expect(anchors.length).toBe(2);

      await act(async () => {
        fireEvent.click(anchors[0]!);
        fireEvent.click(anchors[1]!);
      });

      expect(openSpy).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });

    it('§7.1 源码契约：生产点击轨不含 startsWith 启发式', () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, './MarkdownDocumentView.tsx'),
        'utf8'
      );
      expect(src).toMatch(/sanitizeUrlCandidate/);
      expect(src).toMatch(/isSafeHref/);
      expect(src).not.toMatch(/startsWith\(['"]http:\/\//);
      expect(src).not.toMatch(/startsWith\(['"]https:\/\//);
      expect(src).not.toMatch(/startsWith\(['"]mailto:/);
    });
  });

  describe('ScrollArea 原生滚动基建与 footerSlot 契约', () => {
    it('当 variant 为 document 时，默认由内置 ScrollArea 承载滚动并挂载 .md-document-scroll-root', () => {
      const { container } = render(
        <MarkdownDocumentView content="# Document Scroll" variant="document" />
      );

      const scrollRoot = container.querySelector('.md-document-scroll-root');
      expect(scrollRoot).toBeTruthy();

      const innerRendered = scrollRoot?.querySelector(
        '.md-rendered[data-md-variant="document"]'
      );
      expect(innerRendered).toBeTruthy();
    });

    it('当 variant 为 chat 或 scrollable 为 false 时，不包裹 ScrollArea', () => {
      const { container } = render(
        <MarkdownDocumentView content="Chat message" variant="chat" />
      );

      expect(container.querySelector('.md-document-scroll-root')).toBeNull();
      expect(
        container.querySelector('.md-rendered[data-md-variant="chat"]')
      ).toBeTruthy();
    });

    it('渲染 footerSlot 并支持 onScroll 事件监听', () => {
      const onScroll = vi.fn();
      const { container } = render(
        <MarkdownDocumentView
          content="# Title"
          variant="document"
          onScroll={onScroll}
          footerSlot={
            <button type="button" data-testid="load-more-btn">
              加载更多
            </button>
          }
        />
      );

      const loadMoreBtn = container.querySelector(
        '[data-testid="load-more-btn"]'
      );
      expect(loadMoreBtn).toBeTruthy();

      const viewport = container.querySelector('[class*="viewport"]');
      if (viewport) {
        fireEvent.scroll(viewport, { target: { scrollTop: 50 } });
        expect(onScroll).toHaveBeenCalled();
      }
    });
  });
});
