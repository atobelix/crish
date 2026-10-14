// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SIDEBAR_SESSION_ROW_HEIGHT } from '../../../api/sessionListWindow';
import type { SessionState } from '../../../store/types';
import {
  SessionRow,
  SESSION_ACTIONS_BTN_PX,
  getSessionCleanTitle,
  type SessionRowProps,
} from './SessionRow';

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    id: 'sess-1',
    title: '测试会话',
    folder: 'general',
    isPinned: false,
    isArchived: false,
    timestamp: '2026-08-01T00:00:00.000Z',
    messages: [],
    ...overrides,
  };
}

function renderRow(overrides?: Partial<SessionRowProps>) {
  const onSelectSession = vi.fn();
  const onContextMenuSession = vi.fn();
  const onStartSessionDrag = vi.fn();
  const onStartRename = vi.fn();
  const onCommitRename = vi.fn();
  const onRenameDraftChange = vi.fn();
  const renameInputRef = React.createRef<HTMLInputElement>();
  const session = makeSession();
  const utils = render(
    <ul>
      <SessionRow
        rowHeight={SIDEBAR_SESSION_ROW_HEIGHT}
        session={{
          s: session,
          activeSessionId: 'other',
          searchQuery: '',
          isDraggingThis: false,
          isRenaming: false,
          isDraggable: true,
        }}
        rename={{
          renameDraft: '',
          renameInputRef,
          onRenameDraftChange,
          onStartRename,
          onCommitRename,
        }}
        actions={{
          onSelectSession,
          onContextMenuSession,
          onStartSessionDrag,
        }}
        {...overrides}
      />
    </ul>
  );
  return {
    ...utils,
    onSelectSession,
    onContextMenuSession,
    onStartSessionDrag,
    session,
  };
}

afterEach(() => {
  cleanup();
});

describe('SessionRow 点击 / 更多钮', () => {
  it('点击行调用 onSelectSession，不打开菜单', () => {
    const { onSelectSession, onContextMenuSession } = renderRow();
    fireEvent.click(screen.getByTestId('sidebar-session-item'));
    expect(onSelectSession).toHaveBeenCalledWith('sess-1');
    expect(onContextMenuSession).not.toHaveBeenCalled();
  });

  it('合成 click（无 button）仍能选中会话', () => {
    const { onSelectSession } = renderRow();
    const row = screen.getByTestId('sidebar-session-item');
    fireEvent.click(row, { button: undefined });
    expect(onSelectSession).toHaveBeenCalledWith('sess-1');
  });

  it('更多钮高度小于行高，点击开菜单且不选中行', () => {
    const { onSelectSession, onContextMenuSession } = renderRow();
    const more = screen.getByTestId('session-more-button');
    expect(SESSION_ACTIONS_BTN_PX).toBeLessThan(SIDEBAR_SESSION_ROW_HEIGHT);
    expect(more.style.height).toBe(`${SESSION_ACTIONS_BTN_PX}px`);
    expect(more.style.maxHeight).toBe(`${SESSION_ACTIONS_BTN_PX}px`);
    fireEvent.click(more);
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(onContextMenuSession).toHaveBeenCalledTimes(1);
    const ev = onContextMenuSession.mock.calls[0]![0] as React.MouseEvent;
    expect(ev.button).toBe(0);
  });

  it('更多钮 pointerdown 不启动行拖拽', () => {
    const { onStartSessionDrag } = renderRow();
    fireEvent.pointerDown(screen.getByTestId('session-more-button'), {
      button: 0,
    });
    expect(onStartSessionDrag).not.toHaveBeenCalled();
  });

  it('同分区重名后缀只展示在行内，不改标题文本', () => {
    renderRow({
      session: {
        s: makeSession(),
        activeSessionId: 'other',
        searchQuery: '',
        isDraggingThis: false,
        isRenaming: false,
        isDraggable: true,
        titleHint: '登录接口超时',
      },
    });
    expect(screen.getByTestId('session-title-hint')).toHaveTextContent(
      '登录接口超时'
    );
    expect(screen.getByTestId('sidebar-session-item')).toHaveAttribute(
      'aria-label',
      '测试会话（登录接口超时）'
    );
    expect(screen.getByText('测试会话')).toBeTruthy();
  });

  it('没有重名后缀时不渲染 hint', () => {
    renderRow();
    expect(screen.queryByTestId('session-title-hint')).toBeNull();
  });

  it('每行只渲染一个时间标签（紧凑格式，无日期 + 相对时间并列）', () => {
    const { container } = renderRow();
    const row = screen.getByTestId('sidebar-session-item');
    const times = row.querySelectorAll('time');
    expect(times).toHaveLength(1);
    expect(container.querySelectorAll('[data-session-time]')).toHaveLength(1);
    const label = times[0]?.textContent ?? '';
    expect(label).toMatch(
      /^(刚刚|\d+分|\d+时|\d+天|\d+\/\d+|\d{2}\/\d+\/\d+)$/
    );
    // 行内不应再出现第二个日期 / 时间文案
    const textCol = row.textContent ?? '';
    expect(textCol.split(label).length - 1).toBe(1);
    expect(textCol).not.toMatch(/\d+月\d+日/);
  });

  it('行 pointerdown 左键启动拖拽（不 preventDefault，后续 click 仍可选中）', () => {
    const { onStartSessionDrag, onSelectSession } = renderRow();
    const row = screen.getByTestId('sidebar-session-item');
    fireEvent.pointerDown(row, { button: 0 });
    expect(onStartSessionDrag).toHaveBeenCalled();
    fireEvent.click(row, { button: 0 });
    expect(onSelectSession).toHaveBeenCalledWith('sess-1');
  });

  it('右键走 onContextMenuSession，不选中', () => {
    const { onSelectSession, onContextMenuSession } = renderRow();
    fireEvent.contextMenu(screen.getByTestId('sidebar-session-item'));
    expect(onContextMenuSession).toHaveBeenCalled();
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('普通会话直接渲染纯净标题，不渲染分支徽标', () => {
    renderRow();
    const row = screen.getByTestId('sidebar-session-item');
    expect(row.textContent).toContain('测试会话');
    expect(row.querySelector('[data-icon="git-branch"]')).toBeNull();
  });

  it('分支会话渲染纯净标题，不渲染绿色 GitBranch 图标，且标题不带 "分支: " 纯文本前缀', () => {
    const branchSession = makeSession({
      id: 'sess-branch',
      title: '分析代码架构 - 分支',
      branchParentId: 'sess-parent',
    });
    renderRow({
      session: {
        s: branchSession,
        activeSessionId: 'other',
        searchQuery: '',
        isDraggingThis: false,
        isRenaming: false,
        isDraggable: true,
      },
    });
    const row = screen.getByTestId('sidebar-session-item');
    expect(row.textContent).toContain('分析代码架构');
    expect(row.textContent).not.toContain('分支:');
    expect(row.getAttribute('aria-label')).toContain('分支会话：分析代码架构');
    expect(row.querySelector('[data-icon="git-branch"]')).toBeNull();
  });

  describe('SessionRow 单一菜单出口契约测试（消灭双重幽灵菜单）', () => {
    it('点击更多按钮派发单一 onContextMenuSession 事件，且绝不挂载本地 session-row-panel', () => {
      const { onContextMenuSession } = renderRow();
      const moreBtn = screen.getByTestId('session-more-button');
      fireEvent.click(moreBtn);

      // 核心断言 1：仅触发单一全局 onContextMenuSession
      expect(onContextMenuSession).toHaveBeenCalledTimes(1);
      expect(onContextMenuSession.mock.calls[0]![1]).toBe('sess-1');

      // 核心断言 2：DOM 中绝对不存在本地冗余的 session-row-panel
      expect(screen.queryByTestId('session-row-panel')).toBeNull();
    });

    it('右键行派发单一 onContextMenuSession 事件，且绝不挂载本地 session-row-panel', () => {
      const { onContextMenuSession } = renderRow();
      const row = screen.getByTestId('sidebar-session-item');
      fireEvent.contextMenu(row, { clientX: 150, clientY: 300 });

      expect(onContextMenuSession).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('session-row-panel')).toBeNull();
    });
  });

  describe('getSessionCleanTitle 纯逻辑中立分支后缀清洗', () => {
    it('验证对中文分支 "我的会话 - 分支" 能够干净剥离得到 "我的会话"', () => {
      expect(getSessionCleanTitle('我的会话 - 分支')).toBe('我的会话');
      expect(getSessionCleanTitle('分析代码架构 - 分支')).toBe('分析代码架构');
      expect(getSessionCleanTitle('临时探索 — 分支')).toBe('临时探索');
      expect(getSessionCleanTitle('任务规划 – 分支')).toBe('任务规划');
    });

    it('验证对英文分支 "My Chat - branch" 能够干净剥离得到 "My Chat"', () => {
      expect(getSessionCleanTitle('My Chat - branch')).toBe('My Chat');
      expect(getSessionCleanTitle('My Chat - Branch')).toBe('My Chat');
      expect(getSessionCleanTitle('Feature Branch - BRANCH')).toBe(
        'Feature Branch'
      );
      expect(getSessionCleanTitle('Refactor – branch')).toBe('Refactor');
      expect(getSessionCleanTitle('Security Fix — branch')).toBe(
        'Security Fix'
      );
    });

    it('验证对普通会话 "普通会话标题" 不受影响', () => {
      expect(getSessionCleanTitle('普通会话标题')).toBe('普通会话标题');
      expect(getSessionCleanTitle('Simple Chat Title')).toBe(
        'Simple Chat Title'
      );
    });

    it('验证直接传入 SessionState 对象亦能正确清洗', () => {
      const zhSession = makeSession({ title: '项目调研 - 分支' });
      const enSession = makeSession({ title: 'Architecture Review - branch' });
      const normalSession = makeSession({ title: '常规日常会话' });

      expect(getSessionCleanTitle(zhSession)).toBe('项目调研');
      expect(getSessionCleanTitle(enSession)).toBe('Architecture Review');
      expect(getSessionCleanTitle(normalSession)).toBe('常规日常会话');
    });

    it('英文分支会话在 SessionRow 中正常渲染纯净标题', () => {
      const enBranchSession = makeSession({
        id: 'sess-en-branch',
        title: 'Security Audit - Branch',
        branchParentId: 'sess-parent',
      });
      renderRow({
        session: {
          s: enBranchSession,
          activeSessionId: 'other',
          searchQuery: '',
          isDraggingThis: false,
          isRenaming: false,
          isDraggable: true,
        },
      });
      const row = screen.getByTestId('sidebar-session-item');
      expect(row.textContent).toContain('Security Audit');
      expect(row.textContent).not.toContain('Branch');
    });
  });
});
