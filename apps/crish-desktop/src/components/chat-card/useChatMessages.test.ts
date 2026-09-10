// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../store/sessionStore';
import { useChatMessages } from './useChatMessages';
import type { SessionMessage, SessionState } from '../../store/types';

function makeMsg(
  id: string,
  text: string,
  status?: SessionMessage['status'],
  timestamp: number = 1
): SessionMessage {
  return {
    id,
    sender: 'user',
    timestamp,
    text,
    status,
  } as SessionMessage;
}

function makeStateCarrierMsg(id: string, text: string, stateKey: string): SessionMessage {
  return {
    id,
    sender: 'user',
    timestamp: 1,
    text,
    _contextCarrier: true,
    _carrierKey: stateKey,
  } as SessionMessage;
}

describe('useChatMessages', () => {
  beforeEach(() => {
    useSessionStore.setState((st) => {
      st.sessionsById = {
        'sess-1': {
          id: 'sess-1',
          title: '会话 1',
          folder: '对话',
          isPinned: false,
          isArchived: false,
          timestamp: 't0',
          messages: [
            makeMsg('m1', 'hello world'),
            makeMsg('m2', 'foo bar'),
          ],
          agents: [],
        } as unknown as SessionState,
      };
      st.activeSessionId = 'sess-1';
    });
  });

  it('无过滤器时 displayMessages 包含全部消息', () => {
    const { result } = renderHook(() =>
      useChatMessages({
        resolveSessionId: (s) => s.activeSessionId,
        activeSessionId: 'sess-1',
        localMsgFilter: '',
        mainSurface: 'chat',
      })
    );

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.displayMessages).toHaveLength(2);
    expect(result.current.displayMessages[0]?.id).toBe('m1');
    expect(result.current.displayMessages[1]?.id).toBe('m2');
    expect(result.current.isProcessing).toBe(false);
  });

  it('关键词过滤生效且只返回命中消息', () => {
    const { result } = renderHook(() =>
      useChatMessages({
        resolveSessionId: (s) => s.activeSessionId,
        activeSessionId: 'sess-1',
        localMsgFilter: 'hello',
        mainSurface: 'chat',
      })
    );

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.displayMessages).toHaveLength(1);
    expect(result.current.displayMessages[0]?.id).toBe('m1');
    expect(result.current.emptyKind).toBeNull();
  });

  it('存在 processing 状态消息时 isProcessing 为 true', () => {
    useSessionStore.setState((st) => {
      st.sessionsById['sess-1']!.messages = [
        makeMsg('m1', 'hello'),
        makeMsg('m2', 'generating...', 'processing'),
      ];
    });

    const { result } = renderHook(() =>
      useChatMessages({
        resolveSessionId: (s) => s.activeSessionId,
        activeSessionId: 'sess-1',
        localMsgFilter: '',
        mainSurface: 'chat',
      })
    );

    expect(result.current.isProcessing).toBe(true);
  });

  it('对状态载体消息正确执行去重 (dedupeStateCarrierMessages)', () => {
    useSessionStore.setState((st) => {
      st.sessionsById['sess-1']!.messages = [
        makeStateCarrierMsg('c1', '切换到模型 A', 'model_switch'),
        makeMsg('m1', 'user request'),
        makeStateCarrierMsg('c2', '切换到模型 B', 'model_switch'),
      ];
    });

    const { result } = renderHook(() =>
      useChatMessages({
        resolveSessionId: (s) => s.activeSessionId,
        activeSessionId: 'sess-1',
        localMsgFilter: '',
        mainSurface: 'chat',
      })
    );

    expect(result.current.messages).toHaveLength(3);
    // 载体去重后只保留最后一条同一 carrierKey 的消息
    expect(result.current.displayMessages.some((m) => m.id === 'c2')).toBe(true);
  });

  it('乱序 messages 输入时 displayMessages 按 (timestamp,id) 有序（防御性排序兜底）', () => {
    // 构造乱序：ts 3 → 1 → 2（同 ts 时用 id 做 tiebreak）
    useSessionStore.setState((st) => {
      st.sessionsById['sess-1']!.messages = [
        makeMsg('m3', 'third', undefined, 300),
        makeMsg('m1', 'first', undefined, 100),
        makeMsg('m2', 'second', undefined, 200),
      ];
    });

    const { result } = renderHook(() =>
      useChatMessages({
        resolveSessionId: (s) => s.activeSessionId,
        activeSessionId: 'sess-1',
        localMsgFilter: '',
        mainSurface: 'chat',
      })
    );

    expect(result.current.displayMessages.map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
  });

  it('已序 messages 输入时 displayMessages 顺序不变（稳定排序不打乱）', () => {
    useSessionStore.setState((st) => {
      st.sessionsById['sess-1']!.messages = [
        makeMsg('m1', 'a', undefined, 100),
        makeMsg('m2', 'b', undefined, 200),
        makeMsg('m3', 'c', undefined, 300),
      ];
    });

    const { result } = renderHook(() =>
      useChatMessages({
        resolveSessionId: (s) => s.activeSessionId,
        activeSessionId: 'sess-1',
        localMsgFilter: '',
        mainSurface: 'chat',
      })
    );

    expect(result.current.displayMessages.map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
  });
});
