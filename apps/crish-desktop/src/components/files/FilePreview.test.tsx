// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FilePreview } from './FilePreview';

vi.mock('../diff/VirtualPlainCodeViewer', () => ({
  VirtualPlainCodeViewer: ({
    content,
    filePath,
    wordWrap,
  }: {
    content: string;
    filePath: string;
    wordWrap?: boolean;
  }) => (
    <div
      data-testid="virtual-plain-code-viewer"
      data-wordwrap={String(wordWrap)}
    >
      Plain code for {filePath}: {content}
    </div>
  ),
}));

describe('FilePreview 渲染与虚拟源码展示', () => {
  const defaultFileProps = {
    selected: 'src/main.ts',
    kind: 'text',
    isMd: false,
    canEdit: true,
  };

  const defaultPreviewProps = {
    view: 'detail' as const,
    content: 'const greeting = "hello world";',
    editBuf: 'const greeting = "hello world";',
    editing: false,
    dirty: false,
    error: '',
    detailLoading: false,
    truncated: false,
    lineBudget: 1000,
    loadingMore: false,
    mdMode: 'source' as const,
    assetUrl: null,
    canLoadMore: false,
  };

  const defaultActionsProps = {
    onLoadMore: vi.fn(),
    onEditBufChange: vi.fn(),
    onError: vi.fn(),
    onOpenFile: vi.fn(),
  };

  it('1. 文本/代码预览模式下渲染 VirtualPlainCodeViewer 并开启自动换行', () => {
    render(
      <FilePreview
        file={defaultFileProps}
        preview={defaultPreviewProps}
        actions={defaultActionsProps}
      />
    );

    const viewer = screen.getByTestId('virtual-plain-code-viewer');
    expect(viewer).toBeDefined();
    expect(viewer.getAttribute('data-wordwrap')).toBe('true');
    expect(viewer.textContent).toContain('src/main.ts');
    expect(viewer.textContent).toContain('const greeting = "hello world";');
  });

  it('2. 编辑状态下渲染 FileEditor 而非 VirtualPlainCodeViewer', () => {
    render(
      <FilePreview
        file={defaultFileProps}
        preview={{ ...defaultPreviewProps, editing: true }}
        actions={defaultActionsProps}
      />
    );

    expect(screen.queryByTestId('virtual-plain-code-viewer')).toBeNull();
    const editor = screen.getByRole('textbox', { name: '源码编辑区域' });
    expect(editor).toBeDefined();
    expect(editor.parentElement?.className).toContain('editorWrapper');
  });

  it('3. 未选择文件时展示预览空态提示', () => {
    render(
      <FilePreview
        file={{ ...defaultFileProps, selected: null }}
        preview={defaultPreviewProps}
        actions={defaultActionsProps}
      />
    );

    expect(screen.getByText('预览')).toBeDefined();
    expect(screen.queryByText('在左侧选择文件')).toBeNull();
    expect(screen.queryByTestId('virtual-plain-code-viewer')).toBeNull();
  });

  it('4. canLoadMore 为 true 时渲染继续加载行按钮', () => {
    render(
      <FilePreview
        file={defaultFileProps}
        preview={{ ...defaultPreviewProps, canLoadMore: true, lineBudget: 500 }}
        actions={defaultActionsProps}
      />
    );

    const loadMoreBtn = screen.getByRole('button', {
      name: '继续加载（已 500 行）',
    });
    expect(loadMoreBtn).toBeDefined();
  });

  it('5. 当 wordWrap 设置为 false 时，正确传递给 VirtualPlainCodeViewer', () => {
    render(
      <FilePreview
        file={defaultFileProps}
        preview={{ ...defaultPreviewProps, wordWrap: false }}
        actions={defaultActionsProps}
      />
    );

    const viewer = screen.getByTestId('virtual-plain-code-viewer');
    expect(viewer.getAttribute('data-wordwrap')).toBe('false');
  });

  it('6. 当 isFormatted 为 true 时，优先呈现 formattedContent', () => {
    render(
      <FilePreview
        file={defaultFileProps}
        preview={{
          ...defaultPreviewProps,
          content: '{"raw":"one-line"}',
          isFormatted: true,
          formattedContent: '{\n  "raw": "one-line"\n}',
        }}
        actions={defaultActionsProps}
      />
    );

    const viewer = screen.getByTestId('virtual-plain-code-viewer');
    expect(viewer.textContent).toContain('{\n  "raw": "one-line"\n}');
  });
});
