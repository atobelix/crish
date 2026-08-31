// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { hasTableBlock } from '../../../api/markdown/tableProbe';
import { resolveMaxHeight } from '../../../hooks/chat-stream/usePinnedScroll';
import { MarkdownBlockItem } from '../MarkdownBlockItem';
import { StreamingTableContainer } from '../StreamingTableContainer';
import styles from '../StreamingTableContainer.module.css';
import * as markdownRenderAsync from '../../../api/markdownRenderAsync';

vi.mock('../../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: vi.fn(() => ({
    html: '',
    loading: false,
    failed: false,
  })),
}));

vi.mock('../../../store/storeAccess', () => ({
  useSettingsField: vi.fn(() => 2),
}));

describe('1. hasTableBlock 高性能探针断言', () => {
  it('正确识别标准 GFM 表格定界行', () => {
    const text = '| Header A | Header B |\n| :--- | ---: |\n| 1 | 2 |';
    expect(hasTableBlock(text)).toBe(true);
  });

  it('流式中间态分隔行前缀判定', () => {
    const text = '| Header A | Header B |\n| --- | --- |';
    expect(hasTableBlock(text)).toBe(true);
  });

  it('普通文本或仅包含管道符的非表格文本不应误判', () => {
    expect(hasTableBlock('')).toBe(false);
    expect(hasTableBlock('普通段落\n---\n分割线')).toBe(false);
    expect(hasTableBlock('这是带有 | 管道符的普通句子')).toBe(false);
  });
});

describe('2. resolveMaxHeight 属性解析断言', () => {
  it('正确解析数值与字符串高度', () => {
    expect(resolveMaxHeight(480)).toBe('480px');
    expect(resolveMaxHeight('50vh')).toBe('50vh');
    expect(resolveMaxHeight(0)).toBeUndefined();
    expect(resolveMaxHeight('none')).toBeUndefined();
    expect(resolveMaxHeight(undefined)).toBeUndefined();
  });
});

describe('3. MarkdownBlockItem Caret 动态抑制与表格标记断言', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(markdownRenderAsync.useAsyncMarkdownHtml).mockReturnValue({
      html: '',
      loading: false,
      failed: false,
    });
  });

  it('当处于活跃流式状态且包含表格时，必须注入 suppressCaret 类与 data-contains-table', () => {
    const tableText = '| Col 1 | Col 2 |\n| --- | --- |\n| Val 1 | Val 2 |';
    const { container } = render(
      <MarkdownBlockItem
        text={tableText}
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );

    const rootEl = container.firstElementChild as HTMLElement;
    expect(rootEl).not.toBeNull();
    expect(rootEl.classList.contains('suppressCaret')).toBe(true);
    expect(rootEl.getAttribute('data-contains-table')).toBe('true');
  });

  it('普通流式文本块不应添加 suppressCaret 类', () => {
    const plainText = '这是一段普通的流式输出文本';
    const { container } = render(
      <MarkdownBlockItem
        text={plainText}
        isSealed={false}
        isLast={true}
        isStreaming={true}
      />
    );

    const rootEl = container.firstElementChild as HTMLElement;
    expect(rootEl).not.toBeNull();
    expect(rootEl.classList.contains('suppressCaret')).toBe(false);
    expect(rootEl.getAttribute('data-contains-table')).toBe('false');
  });
});

describe('4. StreamingTableContainer 契约与视口动效 Token 断言', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollTo = vi.fn(function (this: HTMLElement, opts: ScrollToOptions | number, y?: number) {
      if (typeof opts === 'object' && opts.top !== undefined) {
        this.scrollTop = opts.top;
      } else if (typeof opts === 'number') {
        this.scrollTop = y ?? 0;
      }
    });
  });

  it('正确挂载 data-table-streaming 契约属性并支持动态切换', () => {
    const { container, rerender } = render(
      <StreamingTableContainer isStreaming={true}>
        <table data-testid="test-table">
          <thead>
            <tr>
              <th>Col A</th>
              <th>Col B</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Cell A</td>
              <td>Cell B</td>
            </tr>
          </tbody>
        </table>
      </StreamingTableContainer>
    );

    const rootEl = container.firstElementChild as HTMLElement;
    expect(rootEl).not.toBeNull();
    expect(rootEl.getAttribute('data-table-streaming')).toBe('true');
    expect(rootEl.classList.contains(styles.tableContainerRoot)).toBe(true);

    const table = screen.getByTestId('test-table');
    expect(table).not.toBeNull();

    // 切换为非流式状态
    rerender(
      <StreamingTableContainer isStreaming={false}>
        <table data-testid="test-table">
          <thead>
            <tr>
              <th>Col A</th>
              <th>Col B</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Cell A</td>
              <td>Cell B</td>
            </tr>
          </tbody>
        </table>
      </StreamingTableContainer>
    );
    expect(rootEl.getAttribute('data-table-streaming')).toBe('false');
  });

  it('视口容器包含极简滚动与渲染隔离类名，并正确应用 maxHeight 限制', () => {
    const { container } = render(
      <StreamingTableContainer maxHeight={360}>
        <table>
          <thead>
            <tr>
              <th>Header 1</th>
              <th>Header 2</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Data 1</td>
              <td>Data 2</td>
            </tr>
          </tbody>
        </table>
      </StreamingTableContainer>
    );

    const viewportEl = container.querySelector(`.${styles.tableScrollViewport}`) as HTMLElement;
    expect(viewportEl).not.toBeNull();
    expect(viewportEl.style.maxHeight).toBe('360px');
  });

  it('当 maxHeight 为 undefined 或 0 时不设置 style.maxHeight', () => {
    const { container } = render(
      <StreamingTableContainer maxHeight={0}>
        <table>
          <tbody>
            <tr>
              <td>Data</td>
            </tr>
          </tbody>
        </table>
      </StreamingTableContainer>
    );

    const rootEl = container.firstElementChild as HTMLElement;
    const viewportEl = rootEl.firstElementChild as HTMLElement;
    expect(viewportEl.style.maxHeight).toBe('');
  });

  it('合并自定义 className 属性', () => {
    const { container } = render(
      <StreamingTableContainer className="custom-table-class">
        <div>Content</div>
      </StreamingTableContainer>
    );

    const rootEl = container.firstElementChild as HTMLElement;
    expect(rootEl.classList.contains('custom-table-class')).toBe(true);
  });

  it('确保无死选择器 td[data-streaming] 残留，单元格自身不挂载私有流式属性', () => {
    const { container } = render(
      <StreamingTableContainer isStreaming={true}>
        <table>
          <tbody>
            <tr>
              <td>Cell 1</td>
              <td>Cell 2</td>
            </tr>
          </tbody>
        </table>
      </StreamingTableContainer>
    );

    const lastTd = container.querySelector('tbody tr:last-child td:last-child');
    expect(lastTd).not.toBeNull();
    expect(lastTd?.hasAttribute('data-streaming')).toBe(false);
    expect(lastTd?.hasAttribute('data-table-streaming')).toBe(false);
  });
});
