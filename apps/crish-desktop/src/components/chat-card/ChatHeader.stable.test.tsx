// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ChatHeader } from './ChatHeader';
import { useLayoutStore } from '../../store/layoutStore';
import type { SessionState } from '../../store/types';

describe('ChatHeader 空会话常驻顶栏与零跳变 (Task 5)', () => {
  beforeEach(() => {
    useLayoutStore.setState((st) => {
      st.sessionsById = {
        'empty-session': {
          id: 'empty-session',
          title: '空白会话',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: '2026-08-15',
          messages: [],
          agents: [],
        } as unknown as SessionState,
        'active-session': {
          id: 'active-session',
          title: '已有消息会话',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: '2026-08-15',
          messages: [{ id: 'm1', sender: 'user', timestamp: 1, text: 'Hello' }],
          agents: [],
        } as unknown as SessionState,
      };
      st.activeSessionId = 'empty-session';
    });
  });

  it('当 messages 为空数组时，ChatHeader 依然稳定渲染且无搜索按钮，data-has-messages 为 false', () => {
    const { getByTestId, queryByTestId } = render(
      <ChatHeader
        mainSurface="chat"
        showMsgFilter={false}
        localMsgFilter=""
        setLocalMsgFilter={vi.fn()}
        setShowMsgFilter={vi.fn()}
        displayCount={0}
        totalCount={0}
        inputRef={{ current: null }}
        activeSessionId="empty-session"
      />
    );

    const toolbar = getByTestId('chat-toolbar');
    expect(toolbar).toBeDefined();
    expect(toolbar.getAttribute('data-has-messages')).toBe('false');
    expect(queryByTestId('chat-toggle-search')).toBeNull();
  });

  it('当 messages 包含消息时，ChatHeader 渲染搜索按钮，data-has-messages 为 true', () => {
    const { getByTestId } = render(
      <ChatHeader
        mainSurface="chat"
        showMsgFilter={false}
        localMsgFilter=""
        setLocalMsgFilter={vi.fn()}
        setShowMsgFilter={vi.fn()}
        displayCount={1}
        totalCount={1}
        inputRef={{ current: null }}
        activeSessionId="active-session"
      />
    );

    const toolbar = getByTestId('chat-toolbar');
    expect(toolbar).toBeDefined();
    expect(toolbar.getAttribute('data-has-messages')).toBe('true');
    expect(getByTestId('chat-toggle-search')).toBeDefined();
  });
});
