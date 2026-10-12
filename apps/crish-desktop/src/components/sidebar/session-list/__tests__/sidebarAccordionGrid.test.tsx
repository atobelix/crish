// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import styles from '../../SidebarSessionList.module.css';
import { PinnedSection } from '../PinnedSection';
import { ProjectsSection } from '../ProjectsSection';
import { GeneralSection } from '../GeneralSection';
import type { SessionState } from '../../../../store/types';
import type { ProjectEntry } from '../../../../api/projectStore';

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

describe('侧栏手风琴 CSS Grid 平滑收缩与 DOM hidden 解耦测试', () => {
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
    <li key={s.id} data-session-id={s.id}>
      {s.title}
    </li>
  );

  it('PinnedSection 折叠与展开态均零 hidden 属性，由 data-expanded 与 CSS Grid 负责自然收折', () => {
    const session = createMockSession('p1', '置顶会话', true);

    // 折叠态
    const { container, rerender } = render(
      <PinnedSection
        pinnedSessions={[session]}
        pinnedCollapsed={true}
        pinnedZoneRef={{ current: null }}
        dragOverPinned={false}
        filterType="all"
        onTogglePinned={vi.fn()}
        onMoveSessionRealtime={vi.fn()}
        renderSessionItem={renderItemMock}
      />
    );

    const accordionCollapsed = container.querySelector(
      `.${styles.accordionWrapper}`
    );
    expect(accordionCollapsed).not.toBeNull();
    expect(accordionCollapsed?.getAttribute('data-expanded')).toBe('false');
    expect(accordionCollapsed?.hasAttribute('hidden')).toBe(false);

    // 展开态
    rerender(
      <PinnedSection
        pinnedSessions={[session]}
        pinnedCollapsed={false}
        pinnedZoneRef={{ current: null }}
        dragOverPinned={false}
        filterType="all"
        onTogglePinned={vi.fn()}
        onMoveSessionRealtime={vi.fn()}
        renderSessionItem={renderItemMock}
      />
    );

    const accordionExpanded = container.querySelector(
      `.${styles.accordionWrapper}`
    );
    expect(accordionExpanded).not.toBeNull();
    expect(accordionExpanded?.getAttribute('data-expanded')).toBe('true');
    expect(accordionExpanded?.hasAttribute('hidden')).toBe(false);
  });

  it('ProjectsSection 主区与文件夹折叠态均零 hidden 属性，由 data-expanded 控制', () => {
    const project: ProjectEntry = {
      id: 'proj_1',
      name: '测试项目',
      path: 'C:/Software/test',
      addedAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    const sess = createMockSession('p_sess_1', '项目对话');

    const { container, rerender } = render(
      <ProjectsSection
        data={{
          projects: [project],
          collapsedProjects: { proj_1: true }, // 文件夹折叠
          projectsSectionCollapsed: true, // 主区折叠
          byProjectId: { proj_1: [sess] },
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

    const accordions = container.querySelectorAll(
      `.${styles.accordionWrapper}`
    );
    expect(accordions.length).toBe(2);
    // 外层主区
    expect(accordions[0].getAttribute('data-expanded')).toBe('false');
    expect(accordions[0].hasAttribute('hidden')).toBe(false);
    // 内层文件夹
    expect(accordions[1].getAttribute('data-expanded')).toBe('false');
    expect(accordions[1].hasAttribute('hidden')).toBe(false);

    // 展开态
    rerender(
      <ProjectsSection
        data={{
          projects: [project],
          collapsedProjects: { proj_1: false }, // 文件夹展开
          projectsSectionCollapsed: false, // 主区展开
          byProjectId: { proj_1: [sess] },
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

    const accordionsExp = container.querySelectorAll(
      `.${styles.accordionWrapper}`
    );
    expect(accordionsExp.length).toBe(2);
    expect(accordionsExp[0].getAttribute('data-expanded')).toBe('true');
    expect(accordionsExp[0].hasAttribute('hidden')).toBe(false);
    expect(accordionsExp[1].getAttribute('data-expanded')).toBe('true');
    expect(accordionsExp[1].hasAttribute('hidden')).toBe(false);
  });

  it('GeneralSection 折叠与展开态均零 hidden 属性，由 data-expanded 与 CSS Grid 负责自然收折', () => {
    const session = createMockSession('g1', '常规会话');

    // 折叠态
    const { container, rerender } = render(
      <GeneralSection
        generalSessions={[session]}
        generalCollapsed={true}
        generalWindowEnabled={false}
        generalRenderRange={{ windowed: false, start: 0, end: 1, total: 1 }}
        generalListRef={{ current: null }}
        onToggleGeneral={vi.fn()}
        onSortBtnClick={vi.fn()}
        onMoveSessionRealtime={vi.fn()}
        renderSessionItem={renderItemMock}
      />
    );

    const accordion = container.querySelector(`.${styles.accordionWrapper}`);
    expect(accordion).not.toBeNull();
    expect(accordion?.getAttribute('data-expanded')).toBe('false');
    expect(accordion?.hasAttribute('hidden')).toBe(false);

    // 展开态
    rerender(
      <GeneralSection
        generalSessions={[session]}
        generalCollapsed={false}
        generalWindowEnabled={false}
        generalRenderRange={{ windowed: false, start: 0, end: 1, total: 1 }}
        generalListRef={{ current: null }}
        onToggleGeneral={vi.fn()}
        onSortBtnClick={vi.fn()}
        onMoveSessionRealtime={vi.fn()}
        renderSessionItem={renderItemMock}
      />
    );

    const accordionExp = container.querySelector(`.${styles.accordionWrapper}`);
    expect(accordionExp).not.toBeNull();
    expect(accordionExp?.getAttribute('data-expanded')).toBe('true');
    expect(accordionExp?.hasAttribute('hidden')).toBe(false);
  });
});
