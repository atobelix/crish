// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import styles from '../../SidebarSessionList.module.css';
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
  const createMockSession = (
    id: string,
    title: string,
    isPinned = false
  ): SessionState => ({
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

  it('GeneralSection 默认截断为 10 条，展示“查看全部 (24)”，点击后展开全部 24 条', () => {
    // 模拟现场截图中的 24 条常规会话
    const sessions = Array.from({ length: 24 }, (_, i) =>
      createMockSession(`sess_${i}`, `会话项 ${i + 1}`)
    );

    const { container, getByText, queryByText } = render(
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

    // 1. 默认只展示前 10 项，避免侧栏无限拉长
    let listItems = container.querySelectorAll('li[data-session-id]');
    expect(listItems.length).toBe(10);

    // 2. 存在“查看全部 (24)”按钮
    const toggleBtn = getByText('查看全部 (24)');
    expect(toggleBtn).not.toBeNull();

    // 3. 点击展开
    fireEvent.click(toggleBtn);
    listItems = container.querySelectorAll('li[data-session-id]');
    expect(listItems.length).toBe(24);
    expect(getByText('收起')).not.toBeNull();

    // 4. 点击收起
    fireEvent.click(getByText('收起'));
    listItems = container.querySelectorAll('li[data-session-id]');
    expect(listItems.length).toBe(10);
    expect(queryByText('查看全部 (24)')).not.toBeNull();
  });

  it('ProjectsSection：项目标题展示数量角标，项目内默认截断为 6 条，可展开收起', () => {
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

    const { container, getByText, queryByText } = render(
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

    // 1. 项目标题后零数字噪音（杜绝视觉噪音）
    const badge = container.querySelector(`.${styles.folderCount}`);
    expect(badge).toBeNull();

    // 2. 文件夹内默认截断为 6 项
    let listItems = container.querySelectorAll('li[data-session-id]');
    expect(listItems.length).toBe(6);

    // 3. 展示“查看全部 (12)”
    const toggleBtn = getByText('查看全部 (12)');
    expect(toggleBtn).not.toBeNull();

    // 4. 点击展开全部 12 项
    fireEvent.click(toggleBtn);
    listItems = container.querySelectorAll('li[data-session-id]');
    expect(listItems.length).toBe(12);
    expect(getByText('收起')).not.toBeNull();

    // 5. 点击收起恢复 6 项
    fireEvent.click(getByText('收起'));
    listItems = container.querySelectorAll('li[data-session-id]');
    expect(listItems.length).toBe(6);
    expect(queryByText('查看全部 (12)')).not.toBeNull();
  });
});
