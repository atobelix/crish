// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChangesSection } from '../ChangesSection';
import { useSessionStore } from '../../../../store/sessionStore';
import type { GitStatusResult } from '../../../../api/gitApi';

describe('ChangesSection — 会话改动面板组件化集成测试', () => {
  const mockGitWith51Files: GitStatusResult = {
    found: true,
    branch: 'refactor/architecture',
    clean: false,
    stagedCount: 0,
    unstagedCount: 51,
    conflictedCount: 0,
    files: Array.from({ length: 51 }, (_, i) => ({
      path: `src/modified_file_${i + 1}.ts`,
      status: 'M',
      additions: 10,
      deletions: 2,
    })),
  };

  beforeEach(() => {
    useSessionStore.setState({
      activeSessionId: 'sess-empty',
      sessions: [
        {
          id: 'sess-empty',
          title: '空白新会话',
          folder: 'conex',
          isPinned: false,
          isArchived: false,
          timestamp: new Date().toISOString(),
          messages: [],
        },
      ],
      sessionsById: {
        'sess-empty': {
          id: 'sess-empty',
          title: '空白新会话',
          folder: 'conex',
          isPinned: false,
          isArchived: false,
          timestamp: new Date().toISOString(),
          messages: [],
        },
      },
    });
  });

  it('默认模式为当前会话，即使 Git 仓库有 51 个改动，依然呈现纯净空态', () => {
    render(
      <ChangesSection
        open={true}
        git={mockGitWith51Files}
        gitLoading={false}
        branch="refactor/architecture"
        openingPath={null}
        actionErr={null}
        gitHelp={null}
        onToggle={vi.fn()}
        onRefreshGit={vi.fn()}
        onOpenGitFile={vi.fn()}
        onOpenPanel={vi.fn()}
      />
    );

    // 1. 标题为改动，但绝对没有强行拼接 (refactor/architecture)
    const headerBtn = document.getElementById('overview-sec-files');
    expect(headerBtn).toBeTruthy();
    expect(headerBtn?.textContent).not.toContain('refactor/architecture');

    // 2. 呈现纯净空状态，而不是 51 个 Git 改动
    expect(screen.getByText('当前对话暂无文件改动')).toBeTruthy();
    expect(screen.queryByText('src/modified_file_1.ts')).toBeNull();

    // 3. 界面纯净，不留多余下挂按钮
    expect(screen.queryByRole('button', { name: /查看工作区/i })).toBeNull();
  });

  it('在 SegmentedControl 切换至 Git 仓库时，才展示工作区未提交修改与分支名', async () => {
    render(
      <ChangesSection
        open={true}
        git={mockGitWith51Files}
        gitLoading={false}
        branch="refactor/architecture"
        openingPath={null}
        actionErr={null}
        gitHelp={null}
        onToggle={vi.fn()}
        onRefreshGit={vi.fn()}
        onOpenGitFile={vi.fn()}
        onOpenPanel={vi.fn()}
      />
    );

    // 通过官方 Select 点击切换为未提交
    const selectTrigger = screen.getByRole('combobox');
    fireEvent.click(selectTrigger);
    const unstagedOption = await screen.findByRole('option', { name: /未提交/i });
    fireEvent.click(unstagedOption);

    // 此时展示 Git 仓库改动
    expect(screen.getByText('modified_file_1.ts')).toBeTruthy();
  });
});
