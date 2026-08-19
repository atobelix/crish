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
    fireEvent.click(screen.getByRole('button', { name: '移除附件 src/report.md' }));
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

  it('无 onOpenPath 时回落 openFileInPanel', () => {
    openFileInPanel.mockClear();
    render(
      <ComposerAttachmentBar
        attachments={[{ name: 'lib.rs' }]}
        onRemoveAttachment={() => undefined}
      />
    );
    fireEvent.click(screen.getByText('lib.rs'));
    expect(openFileInPanel).toHaveBeenCalledWith('lib.rs');
  });
});
