// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SIDEBAR_SESSION_ROW_HEIGHT } from '../../../api/sessionListWindow';
import type { SessionState } from '../../../store/types';
import {
  SessionRow,
  SESSION_ACTIONS_BTN_PX,
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
});
