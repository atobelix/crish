/**
 * S6：附件卡只加打开叶回调，不重做皮。
 */
// @vitest-environment jsdom
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ComposerAttachmentBar } from './ComposerAttachmentBar';
import { pathFromFileOpenClickTarget } from '../../api/filePanelOpener';

describe('ComposerAttachmentBar 打开叶', () => {
  it('点附件名抽出路径，点移除不打开', () => {
    const onRemove = vi.fn();
    render(
      <ComposerAttachmentBar
        attachments={[{ name: 'src/report.md', text: '内容' }]}
        onRemoveAttachment={onRemove}
      />
    );
    const chip = document.querySelector(
      '[data-file-open-path="src/report.md"]'
    ) as HTMLElement | null;
    expect(chip).toBeTruthy();
    expect(pathFromFileOpenClickTarget(chip)).toBe('src/report.md');
    const remove = screen.getByRole('button', {
      name: '移除附件 src/report.md',
    });
    expect(pathFromFileOpenClickTarget(remove)).toBeNull();
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledWith('src/report.md');
  });
});
