/**
 * 附件发丝卡：横滑条、类型图标、点开走叶、移除不打开、无原生 title。
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ComposerAttachmentBar } from './ComposerAttachmentBar';

const openFileInPanel = vi.fn();

vi.mock('../../api/filePanelOpener', () => ({
  openFileInPanel: (...args: unknown[]) => openFileInPanel(...args),
  registerFileViewerOpener: vi.fn(),
}));

describe('ComposerAttachmentBar（S4 附件卡）', () => {
  it('横滑列表 + 类型图标，无原生 title', () => {
    const { container } = render(
      <ComposerAttachmentBar
        attachments={[
          { name: 'src/a.ts' },
          { name: 'notes.md', text: '# hi' },
          { name: 'shot.png', mime: 'image/png' },
        ]}
        onRemoveAttachment={() => undefined}
      />
    );
    const strip = screen.getByTestId('composer-attach-strip');
    expect(strip.getAttribute('role')).toBe('list');
    const cards = screen.getAllByTestId('composer-attach-card');
    expect(cards).toHaveLength(3);
    expect(cards[0]?.getAttribute('data-attach-kind')).toBe('code');
    expect(cards[1]?.getAttribute('data-attach-kind')).toBe('text');
    expect(cards[2]?.getAttribute('data-attach-kind')).toBe('image');
    expect(container.querySelectorAll('[title]').length).toBe(0);
  });

  it('点卡走 onOpenPath，点移除不打开', () => {
    const onOpenPath = vi.fn();
    const onRemove = vi.fn();
    render(
      <ComposerAttachmentBar
        attachments={[{ name: 'src/report.md', text: 'x' }]}
        onRemoveAttachment={onRemove}
        onOpenPath={onOpenPath}
      />
    );
    fireEvent.click(screen.getByText('src/report.md'));
    expect(onOpenPath).toHaveBeenCalledTimes(1);
    expect(onOpenPath).toHaveBeenCalledWith('src/report.md');
    fireEvent.click(
      screen.getByRole('button', { name: '移除附件 src/report.md' })
    );
    expect(onRemove).toHaveBeenCalledWith('src/report.md');
    expect(onOpenPath).toHaveBeenCalledTimes(1);
  });

  it('中键点击附件卡移除，不打开', () => {
    const onOpenPath = vi.fn();
    const onRemove = vi.fn();
    render(
      <ComposerAttachmentBar
        attachments={[{ name: 'src/mid.md', text: 'x' }]}
        onRemoveAttachment={onRemove}
        onOpenPath={onOpenPath}
      />
    );
    fireEvent(
      screen.getByTestId('composer-attach-card'),
      new MouseEvent('auxclick', { button: 1, bubbles: true })
    );
    expect(onRemove).toHaveBeenCalledWith('src/mid.md');
    expect(onOpenPath).not.toHaveBeenCalled();
  });

  it('优先消费 thumbnailUrl 并渲染正方形缩略图', () => {
    render(
      <ComposerAttachmentBar
        attachments={[
          {
            name: 'photo.png',
            dataUrl: 'data:image/png;base64,rawdata',
            thumbnailUrl: 'data:image/webp;base64,thumbdata',
            status: 'ready',
          },
        ]}
        onRemoveAttachment={() => undefined}
      />
    );
    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toBe('data:image/webp;base64,thumbdata');
    expect(img.getAttribute('alt')).toBe('photo.png');
  });

  it('展示解析与上传进度徽标及边框 SVG', () => {
    render(
      <ComposerAttachmentBar
        attachments={[
          {
            name: 'large_data.csv',
            status: 'parsing',
            progress: 36,
          },
          {
            name: 'uploading_cat.png',
            dataUrl: 'data:image/png;base64,cat',
            status: 'parsing',
            progress: 38,
          },
        ]}
        onRemoveAttachment={() => undefined}
      />
    );
    const badges = screen.getAllByText(/3[68]%/);
    expect(badges).toHaveLength(2);
    expect(screen.getByLabelText('上传解析进度 36%')).toBeTruthy();
    expect(screen.getByLabelText('上传解析进度 38%')).toBeTruthy();
    const svgs = document.querySelectorAll('svg rect[stroke-dashoffset]');
    expect(svgs.length).toBe(2);
  });

  it('渲染选区批注卡片带引用图标与格式规范', () => {
    render(
      <ComposerAttachmentBar
        attachments={[
          {
            name: 'main.rs',
            path: 'src/main.rs',
            annotation: {
              id: 'ann-1',
              selectedText: 'fn main() {}',
              comment: '重构入口',
            },
          },
        ]}
        onRemoveAttachment={() => undefined}
      />
    );
    const card = screen.getByTestId('composer-attach-card');
    expect(card.getAttribute('data-attach-kind')).toBe('annotation');
    expect(
      card.querySelector('[data-icon="message-square-quote"]')
    ).not.toBeNull();
    expect(screen.getByText('main.rs')).toBeTruthy();
  });

  it('图片附件展示为纯圆角缩略图无文件名，非图片附件展示为横向微卡片', () => {
    const { container } = render(
      <ComposerAttachmentBar
        attachments={[
          {
            name: 'cat.png',
            dataUrl: 'data:image/png;base64,cat',
            status: 'ready',
          },
          {
            name: 'presentation.pptx',
            path: '/path/to/presentation.pptx',
            status: 'ready',
          },
        ]}
        onRemoveAttachment={() => undefined}
      />
    );
    const cards = screen.getAllByTestId('composer-attach-card');
    expect(cards).toHaveLength(2);

    // 图片卡片：包含纯图样式，不包含文本文件名节点
    expect(cards[0]?.className).toMatch(/attachChipImage/);
    expect(cards[0]?.querySelector('.attachName')).toBeNull();
    expect(cards[0]?.querySelector('img')).toBeTruthy();

    // 文档卡片：包含横向微卡片样式，包含文件名与格式徽标
    expect(cards[1]?.className).toMatch(/fileCardHorizontal/);
    expect(cards[1]?.querySelector('.file-name')?.textContent).toBe(
      'presentation.pptx'
    );
    expect(screen.getByText(/PPTX/)).toBeTruthy();
  });

  it('模型无视觉能力时，图片与复杂文档在卡片左上角渲染橙色感叹号预警角标', () => {
    render(
      <ComposerAttachmentBar
        attachments={[
          {
            name: 'photo.png',
            dataUrl: 'data:image/png;base64,photo',
            status: 'ready',
          },
          {
            name: 'code.ts',
            path: '/src/code.ts',
            status: 'ready',
          },
        ]}
        onRemoveAttachment={() => undefined}
      />
    );
    const warnBadges = screen.getAllByTestId('composer-attach-warn-badge');
    expect(warnBadges).toHaveLength(1);
    expect(warnBadges[0]?.getAttribute('aria-label')).toContain(
      '当前模型不支持多模态视觉解析'
    );
  });
});
