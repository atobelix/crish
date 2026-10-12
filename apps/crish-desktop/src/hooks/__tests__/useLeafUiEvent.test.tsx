// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { LeafScopeProvider } from '../../contexts/LeafScopeContext';
import { useLeafUiEvent, onScopedUiEvent } from '../useLeafUiEvent';
import { emitUiEvent, dispatchUiEvent } from '../../api/uiEvents';
import { useSessionStore } from '../../store/sessionStore';

describe('useLeafUiEvent & onScopedUiEvent 定址化作用域隔离测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({ activeSessionId: 'session-global' });
  });

  const createWrapper = (
    leafId: string,
    sessionId: string,
    isActive: boolean
  ) => {
    const rootRef = { current: document.createElement('div') };
    const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
      <LeafScopeProvider
        leafId={leafId}
        sessionId={sessionId}
        isActive={isActive}
        leafRootRef={rootRef}
      >
        {children}
      </LeafScopeProvider>
    );
    return Wrapper;
  };

  describe('1. 携带 sessionId 的定址事件路由断言', () => {
    it('retract-backfill 仅命中匹配 sessionId 的分屏，另一分屏零触发', () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      renderHook(() => useLeafUiEvent('retract-backfill', handlerA), {
        wrapper: createWrapper('leaf-1', 'session-a', true),
      });
      renderHook(() => useLeafUiEvent('retract-backfill', handlerB), {
        wrapper: createWrapper('leaf-2', 'session-b', false),
      });

      act(() => {
        emitUiEvent('retract-backfill', {
          sessionId: 'session-a',
          text: '旧输入 A',
        });
      });

      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerA).toHaveBeenCalledWith({
        sessionId: 'session-a',
        text: '旧输入 A',
      });
      expect(handlerB).not.toHaveBeenCalled();

      act(() => {
        emitUiEvent('retract-backfill', {
          sessionId: 'session-b',
          text: '旧输入 B',
        });
      });

      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerB).toHaveBeenCalledTimes(1);
      expect(handlerB).toHaveBeenCalledWith({
        sessionId: 'session-b',
        text: '旧输入 B',
      });
    });

    it('retry-failed-turn 仅命中匹配 sessionId 的分屏，杜绝双分屏并发重发', () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      renderHook(() => useLeafUiEvent('retry-failed-turn', handlerA), {
        wrapper: createWrapper('leaf-1', 'session-a', true),
      });
      renderHook(() => useLeafUiEvent('retry-failed-turn', handlerB), {
        wrapper: createWrapper('leaf-2', 'session-b', false),
      });

      act(() => {
        emitUiEvent('retry-failed-turn', {
          sessionId: 'session-b',
          userMsgId: 'user-msg-b1',
        });
      });

      expect(handlerA).not.toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalledTimes(1);
      expect(handlerB).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-b',
          userMsgId: 'user-msg-b1',
        })
      );
    });

    it('thinking-title-changed 仅更新匹配 sessionId 的分屏', () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      renderHook(() => useLeafUiEvent('thinking-title-changed', handlerA), {
        wrapper: createWrapper('leaf-1', 'session-a', true),
      });
      renderHook(() => useLeafUiEvent('thinking-title-changed', handlerB), {
        wrapper: createWrapper('leaf-2', 'session-b', false),
      });

      act(() => {
        emitUiEvent('thinking-title-changed', {
          sessionId: 'session-a',
        });
      });

      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerB).not.toHaveBeenCalled();
    });
  });

  describe('2. 携带 leafId 的定址事件路由断言', () => {
    it('open-tool-panel 携带 leafId 时精准路由，即使目标为非激活分屏', () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      renderHook(() => useLeafUiEvent('open-tool-panel', handlerA), {
        wrapper: createWrapper('leaf-1', 'session-a', true),
      });
      renderHook(() => useLeafUiEvent('open-tool-panel', handlerB), {
        wrapper: createWrapper('leaf-2', 'session-b', false),
      });

      act(() => {
        emitUiEvent('open-tool-panel', {
          panelId: 'files',
          leafId: 'leaf-2',
        });
      });

      expect(handlerA).not.toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalledTimes(1);
      expect(handlerB).toHaveBeenCalledWith({
        panelId: 'files',
        leafId: 'leaf-2',
      });
    });

    it('toggle-right-panel 携带 leafId 时仅目标叶响应', () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      renderHook(() => useLeafUiEvent('toggle-right-panel', handlerA), {
        wrapper: createWrapper('leaf-1', 'session-a', true),
      });
      renderHook(() => useLeafUiEvent('toggle-right-panel', handlerB), {
        wrapper: createWrapper('leaf-2', 'session-b', false),
      });

      act(() => {
        dispatchUiEvent('toggle-right-panel', { leafId: 'leaf-1' });
      });

      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerB).not.toHaveBeenCalled();
    });

    it('stop-generation 携带 leafId 时仅目标分屏终止，不影响正在流式输出的邻屏', () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      renderHook(() => useLeafUiEvent('stop-generation', handlerA), {
        wrapper: createWrapper('leaf-1', 'session-a', true),
      });
      renderHook(() => useLeafUiEvent('stop-generation', handlerB), {
        wrapper: createWrapper('leaf-2', 'session-b', false),
      });

      act(() => {
        emitUiEvent('stop-generation', { leafId: 'leaf-2' });
      });

      expect(handlerA).not.toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalledTimes(1);
    });
  });

  describe('3. 无参全局广播事件路由断言（快捷键/顶栏菜单）', () => {
    it('toggle-msg-filter 无参广播仅由激活分屏消费', () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      renderHook(() => useLeafUiEvent('toggle-msg-filter', handlerA), {
        wrapper: createWrapper('leaf-1', 'session-a', true),
      });
      renderHook(() => useLeafUiEvent('toggle-msg-filter', handlerB), {
        wrapper: createWrapper('leaf-2', 'session-b', false),
      });

      act(() => {
        emitUiEvent('toggle-msg-filter');
      });

      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerB).not.toHaveBeenCalled();
    });

    it('open-project-picker 无参广播仅激活分屏弹出窗口', () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      renderHook(() => useLeafUiEvent('open-project-picker', handlerA), {
        wrapper: createWrapper('leaf-1', 'session-a', false),
      });
      renderHook(() => useLeafUiEvent('open-project-picker', handlerB), {
        wrapper: createWrapper('leaf-2', 'session-b', true),
      });

      act(() => {
        emitUiEvent('open-project-picker');
      });

      expect(handlerA).not.toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalledTimes(1);
    });

    it('focus-composer 无参广播仅激活分屏响应聚焦', () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      renderHook(() => useLeafUiEvent('focus-composer', handlerA), {
        wrapper: createWrapper('leaf-1', 'session-a', true),
      });
      renderHook(() => useLeafUiEvent('focus-composer', handlerB), {
        wrapper: createWrapper('leaf-2', 'session-b', false),
      });

      act(() => {
        emitUiEvent('focus-composer');
      });

      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerB).not.toHaveBeenCalled();
    });

    it('export-session-md 与 open-conversation-rewind 无参广播仅当前焦点分屏导出/回溯', () => {
      const exportA = vi.fn();
      const exportB = vi.fn();
      const rewindA = vi.fn();
      const rewindB = vi.fn();

      renderHook(() => useLeafUiEvent('export-session-md', exportA), {
        wrapper: createWrapper('leaf-1', 'session-a', true),
      });
      renderHook(() => useLeafUiEvent('export-session-md', exportB), {
        wrapper: createWrapper('leaf-2', 'session-b', false),
      });
      renderHook(() => useLeafUiEvent('open-conversation-rewind', rewindA), {
        wrapper: createWrapper('leaf-1', 'session-a', true),
      });
      renderHook(() => useLeafUiEvent('open-conversation-rewind', rewindB), {
        wrapper: createWrapper('leaf-2', 'session-b', false),
      });

      act(() => {
        emitUiEvent('export-session-md');
        emitUiEvent('open-conversation-rewind');
      });

      expect(exportA).toHaveBeenCalledTimes(1);
      expect(exportB).not.toHaveBeenCalled();
      expect(rewindA).toHaveBeenCalledTimes(1);
      expect(rewindB).not.toHaveBeenCalled();
    });

    it('clear-current-session 无参广播仅清空激活分屏', () => {
      const clearA = vi.fn();
      const clearB = vi.fn();

      renderHook(() => useLeafUiEvent('clear-current-session', clearA), {
        wrapper: createWrapper('leaf-1', 'session-a', true),
      });
      renderHook(() => useLeafUiEvent('clear-current-session', clearB), {
        wrapper: createWrapper('leaf-2', 'session-b', false),
      });

      act(() => {
        emitUiEvent('clear-current-session');
      });

      expect(clearA).toHaveBeenCalledTimes(1);
      expect(clearB).not.toHaveBeenCalled();
    });
  });

  describe('4. Guard-1 向后兼容测试（脱离 LeafScopeProvider 的单窗口/单元测试场景）', () => {
    it('未包裹 Provider 时，匹配全局 activeSessionId 的事件正常放行', () => {
      useSessionStore.setState({ activeSessionId: 'session-legacy' });
      const handler = vi.fn();

      renderHook(() => useLeafUiEvent('retract-backfill', handler));

      act(() => {
        emitUiEvent('retract-backfill', {
          sessionId: 'session-legacy',
          text: '回填文本',
        });
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        sessionId: 'session-legacy',
        text: '回填文本',
      });
    });

    it('未包裹 Provider 时，非当前全局会话事件被拦截', () => {
      useSessionStore.setState({ activeSessionId: 'session-legacy' });
      const handler = vi.fn();

      renderHook(() => useLeafUiEvent('retract-backfill', handler));

      act(() => {
        emitUiEvent('retract-backfill', {
          sessionId: 'other-session',
          text: '其他文本',
        });
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('命令式 onScopedUiEvent 支持纯函数动态上下文提取', () => {
      let currentSid = 's1';
      const handler = vi.fn();

      const off = onScopedUiEvent('retry-failed-turn', handler, () => ({
        sessionId: currentSid,
      }));

      act(() => {
        emitUiEvent('retry-failed-turn', { sessionId: 's1', userMsgId: 'm1' });
      });
      expect(handler).toHaveBeenCalledTimes(1);

      // 动态切换上下文
      currentSid = 's2';
      act(() => {
        emitUiEvent('retry-failed-turn', { sessionId: 's1', userMsgId: 'm1' });
      });
      expect(handler).toHaveBeenCalledTimes(1);

      act(() => {
        emitUiEvent('retry-failed-turn', { sessionId: 's2', userMsgId: 'm2' });
      });
      expect(handler).toHaveBeenCalledTimes(2);

      off();
    });
  });
});
