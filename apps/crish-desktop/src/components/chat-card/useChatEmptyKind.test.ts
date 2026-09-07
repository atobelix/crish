// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useChatEmptyKind } from './useChatEmptyKind';
import { PENDING_DRAFT_SESSION_ID } from '../../store/draftSession';
import type { SessionMessage } from '../../store/types';

function msg(id: string, text: string): SessionMessage {
  return {
    id,
    sender: 'user',
    timestamp: 1,
    text,
  } as SessionMessage;
}

describe('useChatEmptyKind', () => {
  it('有会话、零消息、水合中：emptyKind 仍是 session-empty', () => {
    const { result } = renderHook(() =>
      useChatEmptyKind({
        activeSessionId: 'sess-remote-1',
        messages: [],
        localMsgFilter: '',
        mainSurface: 'chat',
        hydratedFromEngine: false,
        engineCursor: 12,
        engineLastRunId: 'run-1',
      })
    );
    expect(result.current.messagesLoading).toBe(true);
    expect(result.current.emptyKind).toBe('session-empty');
    expect(result.current.onEmptySurface).toBe(true);
  });

  it('草稿会话不进 loading，直接欢迎面', () => {
    const { result } = renderHook(() =>
      useChatEmptyKind({
        activeSessionId: PENDING_DRAFT_SESSION_ID,
        messages: [],
        localMsgFilter: '',
        mainSurface: 'chat',
        hydratedFromEngine: false,
        engineCursor: undefined,
        engineLastRunId: undefined,
      })
    );
    expect(result.current.messagesLoading).toBe(false);
    expect(result.current.emptyKind).toBe('session-empty');
  });

  it('本地 mint 且无引擎游标：不挡欢迎面', () => {
    const { result } = renderHook(() =>
      useChatEmptyKind({
        activeSessionId: 'sess-123',
        messages: [],
        localMsgFilter: '',
        mainSurface: 'chat',
        hydratedFromEngine: undefined,
        engineCursor: undefined,
        engineLastRunId: undefined,
      })
    );
    expect(result.current.messagesLoading).toBe(false);
    expect(result.current.emptyKind).toBe('session-empty');
  });

  it('无会话 → no-session', () => {
    const { result } = renderHook(() =>
      useChatEmptyKind({
        activeSessionId: null,
        messages: [],
        localMsgFilter: '',
        mainSurface: 'chat',
        hydratedFromEngine: undefined,
        engineCursor: undefined,
        engineLastRunId: undefined,
      })
    );
    expect(result.current.emptyKind).toBe('no-session');
    expect(result.current.messagesLoading).toBe(false);
  });

  it('有消息且过滤无命中 → filter-empty', () => {
    const { result } = renderHook(() =>
      useChatEmptyKind({
        activeSessionId: 'sess-1',
        messageCount: 1,
        displayCount: 0,
        localMsgFilter: 'zzzz',
        mainSurface: 'chat',
        hydratedFromEngine: true,
        engineCursor: 1,
        engineLastRunId: 'run-1',
      })
    );
    expect(result.current.messagesLoading).toBe(false);
    expect(result.current.emptyKind).toBe('filter-empty');
  });
});
