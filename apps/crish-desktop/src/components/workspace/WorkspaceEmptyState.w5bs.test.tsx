// @vitest-environment jsdom
/**
 * WorkspaceEmptyState · W5-B-S Skeleton 可点预览壳入口
 *
 * 完成定义：
 * - 可点「打开笔记纸面（预览壳）」→ NotePaperPanel 静默假数据
 * - DOM 显式 package-id=W5-B-S / track=skeleton
 * - 关闭可回空态
 * - **≠** EL 关闭；**≠** W5-B Strict
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';
import {
  W5B_SKELETON_PACKAGE_ID,
  W5B_SKELETON_TRACK,
} from '../note-paper/w5bSkeleton';

describe('WorkspaceEmptyState · W5-B-S 可点预览壳', () => {
  it('空态按钮携带 Skeleton 包锚并可打开预览壳', () => {
    render(<WorkspaceEmptyState wsId="ws-preview-1" />);

    const openBtn = screen.getByTestId('open-note-paper-preview');
    expect(openBtn).toHaveAttribute('data-package-id', W5B_SKELETON_PACKAGE_ID);
    expect(openBtn.getAttribute('aria-label') ?? '').toMatch(
      /W5-B-S|Skeleton/i
    );

    fireEvent.click(openBtn);

    const host = screen.getByTestId('note-paper-preview-host');
    expect(host).toHaveAttribute('data-note-paper-preview', 'true');
    expect(host).toHaveAttribute('data-package-id', W5B_SKELETON_PACKAGE_ID);
    expect(host).toHaveAttribute('data-track', W5B_SKELETON_TRACK);

    const panel = screen.getByTestId('note-paper-panel');
    expect(panel).toHaveAttribute('data-package-id', W5B_SKELETON_PACKAGE_ID);
    expect(panel).toHaveAttribute('data-track', W5B_SKELETON_TRACK);
    expect(panel).toHaveAttribute('data-source', 'silent');
    expect(panel).toHaveAttribute('data-surface', 'note-paper');
    expect(panel).toHaveAttribute('data-doc-id', 'preview-ws-preview-1');
    // 静默假数据 6 块
    expect(panel).toHaveAttribute('data-block-count', '6');

    // 不创建行级权威
    expect(panel.querySelector('[data-lines]')).toBeNull();
  });

  it('关闭预览壳回到空态入口', () => {
    render(<WorkspaceEmptyState wsId="ws-close" />);
    fireEvent.click(screen.getByTestId('open-note-paper-preview'));
    expect(screen.getByTestId('note-paper-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('note-paper-close'));
    expect(screen.queryByTestId('note-paper-panel')).toBeNull();
    expect(screen.getByTestId('open-note-paper-preview')).toBeInTheDocument();
  });

  it('footer 声明 Skeleton 与挂载≠EL（禁止假关 EL-01）', () => {
    render(<WorkspaceEmptyState wsId="ws-footer" />);
    fireEvent.click(screen.getByTestId('open-note-paper-preview'));
    const footer = screen.getByTestId('note-paper-footer');
    expect(footer.textContent).toMatch(/W5-B-S/);
    expect(footer.textContent).toMatch(/Skeleton/i);
    expect(footer.textContent).toMatch(/挂载≠EL-01/);
  });
});
