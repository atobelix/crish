// @vitest-environment jsdom
/**
 * NotePaperPanel 挂载壳单测（**W5-B-S Skeleton** · B-01/B-02/A-SURF-08 · 半 transport）
 *
 * 轨：Skeleton；**≠** W5-B Strict；**≠** EL 关闭。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BlockChromeModel, createSilentFixture } from '@crish/block-paper';
import { createMemoryNoteTransport } from '../../api/noteApi';
import { NotePaperPanel } from './NotePaperPanel';
import { EDITOR_SURFACE_NOTE_PAPER } from './editorSurface';
import { W5B_SKELETON_PACKAGE_ID, W5B_SKELETON_TRACK } from './w5bSkeleton';

describe('NotePaperPanel · W5-B-S Skeleton', () => {
  it('渲染 surface=note-paper 与静默块列表 + Skeleton 包锚', () => {
    const { container } = render(
      <NotePaperPanel docId="doc-test" blockCount={4} />
    );
    const panel = screen.getByTestId('note-paper-panel');
    expect(panel).toHaveAttribute('data-surface', EDITOR_SURFACE_NOTE_PAPER);
    expect(panel).toHaveAttribute('data-package-id', W5B_SKELETON_PACKAGE_ID);
    expect(panel).toHaveAttribute('data-track', W5B_SKELETON_TRACK);
    expect(panel).toHaveAttribute('data-doc-id', 'doc-test');
    expect(panel).toHaveAttribute('data-block-count', '4');
    expect(panel).toHaveAttribute('data-silent-level', 'L0');
    expect(panel).toHaveAttribute('data-source', 'silent');

    expect(screen.getByTestId('note-paper-silent').textContent).toMatch(/L0/);
    expect(screen.getByTestId('note-paper-count').textContent).toMatch(/4/);

    // 块 id 列表可测
    const rows = container.querySelectorAll('[data-block-id]');
    expect(rows.length).toBe(4);
    expect(rows[0]).toHaveAttribute('data-block-id', 'b-0001');
    expect(rows[3]).toHaveAttribute('data-block-id', 'b-0004');

    // 默认把手 hidden（L0 静默）
    for (const row of rows) {
      expect(row).toHaveAttribute('data-handle', 'hidden');
    }
  });

  it('hover 时把手状态变为 hover（静默按需 chrome）', () => {
    render(<NotePaperPanel blockCount={2} />);
    const row = screen.getByTestId('note-block-b-0001');
    expect(row).toHaveAttribute('data-handle', 'hidden');
    fireEvent.mouseEnter(row);
    expect(row).toHaveAttribute('data-handle', 'hover');
    fireEvent.mouseLeave(row);
    expect(row).toHaveAttribute('data-handle', 'hidden');
  });

  it('可注入 fixture / chrome，空文档不抛', () => {
    const fixture = createSilentFixture(0, { docId: 'empty-doc' });
    const chrome = new BlockChromeModel();
    render(<NotePaperPanel fixture={fixture} chrome={chrome} title="空投影" />);
    expect(screen.getByTestId('note-paper-panel')).toHaveAttribute(
      'data-doc-id',
      'empty-doc'
    );
    expect(screen.getByTestId('note-paper-empty')).toBeInTheDocument();
    expect(screen.getByText('空投影')).toBeInTheDocument();
  });

  it('不创建 lines[] 权威：DOM 无 data-lines / 行级 store 属性', () => {
    const { container } = render(<NotePaperPanel blockCount={3} />);
    const panel = screen.getByTestId('note-paper-panel');
    // 无行级权威相关 data 属性
    expect(panel.querySelector('[data-lines]')).toBeNull();
    expect(panel.querySelector('[data-editor-store]')).toBeNull();
    expect(container.querySelectorAll('[data-block-id]').length).toBe(3);
    // surface 正确
    expect(panel).toHaveAttribute('data-surface', 'note-paper');
  });

  it('footer 声明 W5-B-S Skeleton 与挂载≠交付', () => {
    render(<NotePaperPanel blockCount={1} />);
    const footer = screen.getByTestId('note-paper-footer');
    expect(footer.textContent).toMatch(/W5-B-S/);
    expect(footer.textContent).toMatch(/Skeleton/i);
    expect(footer.textContent).toMatch(/挂载≠EL-01/);
    expect(footer.textContent).toMatch(/note-paper/);
    expect(footer.textContent).toMatch(/静默假数据/);
  });

  it('半 transport（Memory）：apply 后 refreshToken 刷新块列表', async () => {
    const mem = createMemoryNoteTransport();
    const { rerender } = render(
      <NotePaperPanel
        docId="doc-panel-tr"
        transport={mem}
        refreshToken={0}
        title="transport 投影"
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-panel')).toHaveAttribute(
        'data-source',
        'transport'
      );
    });
    expect(screen.getByTestId('note-paper-empty')).toBeInTheDocument();

    await mem.applyMd({
      docId: 'doc-panel-tr',
      markdown: '# Panel Title\n\npanel body',
      intentId: 'panel-apply-1',
    });

    rerender(
      <NotePaperPanel
        docId="doc-panel-tr"
        transport={mem}
        refreshToken={1}
        title="transport 投影"
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-count').textContent).toMatch(/2/);
    });
    expect(screen.getByTestId('note-paper-panel')).toHaveAttribute(
      'data-block-count',
      '2'
    );
    expect(screen.queryByTestId('note-paper-empty')).toBeNull();
    // 至少出现一个 transport 块 id（mem-block-*）
    expect(
      document.querySelector('[data-block-id^="mem-block-"]')
    ).not.toBeNull();
  });

  it('半 transport：点击刷新按钮可加载写后块', async () => {
    const mem = createMemoryNoteTransport();
    render(
      <NotePaperPanel
        docId="doc-btn-refresh"
        transport={mem}
        refreshToken={0}
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-refresh')).toBeInTheDocument();
    });

    await mem.applyMd({
      docId: 'doc-btn-refresh',
      markdown: 'after click refresh',
    });
    fireEvent.click(screen.getByTestId('note-paper-refresh'));

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-count').textContent).toMatch(/1/);
    });
    expect(screen.getByText('after click refresh')).toBeInTheDocument();
  });
});
