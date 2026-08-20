// @vitest-environment jsdom
/**
 * T4.2（R-05）：会话级订阅短路测试。
 *
 * 非活跃会话的任何变更（工具快照/审批/subagent 事件 immer patch）不再
 * 触发本会话 selector 重求值与组件重渲染；活跃会话变更正常响应。
 */
import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useSessionStore } from '../../store/sessionStore';
import { useScopedSessionField } from './useScopedSessionField';
import type { SessionState } from '../store/types';

function seedStore(): void {
  useSessionStore.setState((st) => {
    st.sessionsById = {
      'sess-a': {
        id: 'sess-a',
        title: '会话 A',
        folder: '对话',
        isPinned: false,
        isArchived: false,
        timestamp: 't0',
        messages: [{ id: 'a1', sender: 'user', timestamp: 1, text: 'A 消息' }],
        agents: [],
      },
      'sess-b': {
        id: 'sess-b',
        title: '会话 B',
        folder: '对话',
        isPinned: false,
        isArchived: false,
        timestamp: 't0',
        messages: [{ id: 'b1', sender: 'user', timestamp: 2, text: 'B 消息' }],
        agents: [],
      },
    } as Record<string, SessionState>;
    st.activeSessionId = 'sess-a';
  });
}

beforeEach(() => {
  seedStore();
});

describe('useScopedSessionField 会话级订阅短路（T4.2）', () => {
  it('非活跃会话 patch：selector 不重求值、组件不重渲染', () => {
    const selectorSpy = vi.fn(
      (s: SessionState | undefined) => s?.messages?.length ?? 0
    );
    const resolveA = (s: { activeSessionId: string }) =>
      'sess-a' as string;

    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount++;
      return useScopedSessionField(resolveA, selectorSpy);
    });
    expect(result.current).toBe(1);
    expect(selectorSpy).toHaveBeenCalledTimes(1);
    renderCount = 0;
    selectorSpy.mockClear();

    // 非活跃会话 B 的消息变更（immer patch）→ 短路：selector 零调用、零渲染
    act(() => {
      useSessionStore.setState((st) => {
        st.sessionsById['sess-b']!.messages!.push({
          id: 'b2',
          sender: 'assistant',
          timestamp: 3,
          text: 'B 新增',
        });
      });
    });
    expect(selectorSpy).not.toHaveBeenCalled();
    expect(renderCount).toBe(0);
    expect(result.current).toBe(1);
  });

  it('活跃会话 patch：正常重求值与重渲染', () => {
    const selectorSpy = vi.fn(
      (s: SessionState | undefined) => s?.messages?.length ?? 0
    );
    const resolveA = (s: { activeSessionId: string }) =>
      'sess-a' as string;

    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount++;
      return useScopedSessionField(resolveA, selectorSpy);
    });
    renderCount = 0;
    selectorSpy.mockClear();

    act(() => {
      useSessionStore.setState((st) => {
        st.sessionsById['sess-a']!.messages!.push({
          id: 'a2',
          sender: 'assistant',
          timestamp: 4,
          text: 'A 新增',
        });
      });
    });
    expect(selectorSpy).toHaveBeenCalledTimes(1);
    expect(renderCount).toBe(1);
    expect(result.current).toBe(2);
  });

  it('activeSessionId 变更（prop 缺省）→ 重求值（sid 解析随 active 切换）', () => {
    const selectorSpy = vi.fn(
      (s: SessionState | undefined) => s?.title ?? ''
    );
    // 无 prop：sid = activeSessionId
    const resolveActive = (s: { activeSessionId: string }) => s.activeSessionId;

    const { result } = renderHook(() =>
      useScopedSessionField(resolveActive, selectorSpy)
    );
    expect(result.current).toBe('会话 A');
    selectorSpy.mockClear();

    act(() => {
      useSessionStore.setState((st) => {
        st.activeSessionId = 'sess-b';
      });
    });
    expect(selectorSpy).toHaveBeenCalledTimes(1);
    expect(result.current).toBe('会话 B');
  });

  it('消息正文变更但引用未变（不可能发生）与同值场景不重复求值', () => {
    // 同引用 patch（immer 不可能产生，防御断言）：selector 缓存命中
    const selectorSpy = vi.fn(
      (s: SessionState | undefined) => s?.title ?? ''
    );
    const { result } = renderHook(() =>
      useScopedSessionField(
        (s: { activeSessionId: string }) => 'sess-a',
        selectorSpy
      )
    );
    expect(result.current).toBe('会话 A');
    selectorSpy.mockClear();
    // 无关字段（folderOrder）变更 → 短路
    act(() => {
      useSessionStore.setState((st) => {
        st.folderOrder = ['对话'];
      });
    });
    expect(selectorSpy).not.toHaveBeenCalled();
    expect(result.current).toBe('会话 A');
  });
});
