// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { GeneralSection } from '../GeneralSection';
import { ProjectsSection } from '../ProjectsSection';
import type { SessionState } from '../../../../store/types';
import type { ProjectEntry } from '../../../../api/projectStore';

// Mock compositionRoot & uiEvents
vi.mock('../../../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({
    shell: {
      openNewDraftTab: vi.fn(),
    },
  }),
}));

vi.mock('../../../../api/uiEvents', () => ({
  emitUiEvent: vi.fn(),
}));

describe('侧栏所见即所得自然流式布局结构不变量 (WYSIWYG Flow Invariants)', () => {
  const createMockSession = (id: string, title: string, isPinned = false): SessionState => ({
    id,
    title,
    isPinned,
    folder: '对话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  });

  const renderItemMock = (s: SessionState) => (
    <li key={s.id} data-session-id={s.id} className="session-item-wrap">
      {s.title}
    </li>
  );

  it('GeneralSection 所见即所得：24 条会话全量渲染，零截断、零“查看全部”按钮', () => {
    // 模拟现场截图中的 24 条常规会话
    const sessions = Array.from({ length: 24 }, (_, i) =>
      createMockSession(`sess_${i}`, `会话项 ${i + 1}`)
    );

    const { container, queryByText } = render(
      <GeneralSection
        generalSessions={sessions}
        generalCollapsed={false}
        generalWindowEnabled={false}
        generalRenderRange={{ windowed: false, start: 0, end: 24, total: 24 }}
        generalListRef={{ current: null }}
        onToggleGeneral={vi.fn()}
        onSortBtnClick={vi.fn()}
        onMoveSessionRealtime={vi.fn()}
        renderSessionItem={renderItemMock}
      />
    );

    // 1. 24 项全部挂载到 DOM，所见即所得
    const listItems = container.querySelectorAll('li[data-session-id]');
    expect(listItems.length).toBe(24);

    // 2. 彻底不存在“查看全部 (24)”或“收起”按钮
    expect(queryByText(/查看全部/)).toBeNull();
    expect(queryByText(/收起/)).toBeNull();

    // 3. ul 内部不存在非法的内嵌手风琴 div
    const ul = container.querySelector('ul[data-drop-zone="general"]');
    expect(ul).not.toBeNull();
    const innerDivs = ul?.querySelectorAll('div');
    expect(innerDivs?.length ?? 0).toBe(0);
  });

  it('ProjectsSection 所见即所得：文件夹内 12 条会话全量流式展开，零截断', () => {
    const project: ProjectEntry = {
      id: 'proj_1',
      name: '核心项目',
      path: 'C:/Software/core',
      addedAt: Date.now(),
      lastOpenedAt: Date.now(),
    };

    const projectSessions = Array.from({ length: 12 }, (_, i) =>
      createMockSession(`proj_sess_${i}`, `项目会话 ${i + 1}`)
    );

    const { container, queryByText } = render(
      <ProjectsSection
        data={{
          projects: [project],
          collapsedProjects: { proj_1: false }, // 展开
          projectsSectionCollapsed: false,
          byProjectId: { proj_1: projectSessions },
        }}
        actions={{
          onToggleProjectsSection: vi.fn(),
          onToggleProjectCollapsed: vi.fn(),
          onOpenProject: vi.fn(),
          onMoveSessionRealtime: vi.fn(),
          renderSessionItem: renderItemMock,
        }}
      />
    );

    // 1. 12 项全部流式挂载
    const listItems = container.querySelectorAll('li[data-session-id]');
    expect(listItems.length).toBe(12);

    // 2. 彻底不存在“查看全部”按钮
    expect(queryByText(/查看全部/)).toBeNull();
  });
});
