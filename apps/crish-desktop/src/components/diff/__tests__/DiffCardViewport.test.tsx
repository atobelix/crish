// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffCardGitActions } from '../DiffCardGitActions';
import { VirtualPlainCodeViewer } from '../VirtualPlainCodeViewer';
import { DiffCardUnifiedView } from '../DiffCardUnifiedView';
import type { FileDiff } from '../../../store/types';
import styles from '../DiffCard.module.css';

describe('DiffCard 视口契约与 Commit CTA 断言套件', () => {
  it('DiffCardUnifiedView 使用弹性视口类 .scrollParent', () => {
    const f: FileDiff = {
      filePath: 'src/app.ts',
      status: 'modified',
      changes: [{ type: 'normal', content: 'console.log("hi");' }],
    };
    const renderItems = [
      {
        isCollapsedPlaceholder: false as const,
        index: 0,
        item: { change: f.changes[0]!, globalIdx: 0 },
      },
    ];

    const { container } = render(
      <DiffCardUnifiedView f={f} renderItems={renderItems} onExpandBlock={vi.fn()} />
    );

    const scrollEl = container.querySelector(`.${styles.scrollParent}`);
    expect(scrollEl).not.toBeNull();
  });

  it('VirtualPlainCodeViewer 纯源码模式使用全视口类 .plainScrollParent', () => {
    const { container } = render(
      <VirtualPlainCodeViewer content="const a = 1;" filePath="src/app.ts" />
    );

    const plainScrollEl = container.querySelector(`.${styles.plainScrollParent}`);
    expect(plainScrollEl).not.toBeNull();
  });

  it('DiffCardGitActions: 空信息且无暂存文件时，Commit 按钮禁用；有暂存或有信息时启用', () => {
    const { rerender } = render(
      <DiffCardGitActions
        open={true}
        commitMsg=""
        commitLoading={false}
        pushLoading={false}
        stagedCount={0}
        unstagedCount={1}
        onToggle={vi.fn()}
        onCommitMsgChange={vi.fn()}
        onCommit={vi.fn()}
        onPush={vi.fn()}
      />
    );

    const commitBtn = screen.getByRole('button', { name: /暂存并提交/i });
    expect(commitBtn.getAttribute('disabled')).not.toBeNull();

    // 当有暂存文件时，按钮启用
    rerender(
      <DiffCardGitActions
        open={true}
        commitMsg=""
        commitLoading={false}
        pushLoading={false}
        stagedCount={1}
        unstagedCount={0}
        onToggle={vi.fn()}
        onCommitMsgChange={vi.fn()}
        onCommit={vi.fn()}
        onPush={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /提交已暂存/i }).getAttribute('disabled')).toBeNull();
  });
});
