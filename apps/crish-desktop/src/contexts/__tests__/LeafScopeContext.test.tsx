// @vitest-environment jsdom
import React, { useRef } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import {
  LeafScopeProvider,
  useLeafScope,
  useScopedSessionId,
  shouldConsumeScopedEvent,
} from '../LeafScopeContext';
import { useSessionStore } from '../../store/sessionStore';

describe('LeafScopeContext', () => {
  beforeEach(() => {
    useSessionStore.setState({
      activeSessionId: 'global-active-session',
      sessionsById: {},
    });
  });

  describe('useLeafScope', () => {
    it('在未包裹 LeafScopeProvider 时返回默认作用域', () => {
      const { result } = renderHook(() => useLeafScope());

      expect(result.current.inLeafScope).toBe(false);
      expect(result.current.leafId).toBeNull();
      expect(result.current.sessionId).toBeNull();
      expect(result.current.isActive).toBe(true);
      expect(result.current.openTool).toBeNull();
      expect(typeof result.current.queryWithinLeaf).toBe('function');
    });

    it('在包裹 LeafScopeProvider 时返回真实叶子作用域', () => {
      const openToolSpy = vi.fn();
      const rootRef: React.RefObject<HTMLElement | null> = {
        current: document.createElement('div'),
      };

      const wrapper: React.FC<{ children: React.ReactNode }> = ({
        children,
      }) => (
        <LeafScopeProvider
          leafId="leaf-test-1"
          sessionId="sess-test-1"
          isActive={false}
          leafRootRef={rootRef}
          openTool={openToolSpy}
        >
          {children}
        </LeafScopeProvider>
      );

      const { result } = renderHook(() => useLeafScope(), { wrapper });

      expect(result.current.inLeafScope).toBe(true);
      expect(result.current.leafId).toBe('leaf-test-1');
      expect(result.current.sessionId).toBe('sess-test-1');
      expect(result.current.isActive).toBe(false);
      expect(result.current.leafRootRef).toBe(rootRef);

      result.current.openTool?.('terminal');
      expect(openToolSpy).toHaveBeenCalledWith('terminal');
    });

    it('queryWithinLeaf 优先在 leafRootRef 子树内查找元素', () => {
      const rootEl = document.createElement('div');
      const innerChild = document.createElement('span');
      innerChild.className = 'scoped-target';
      rootEl.appendChild(innerChild);

      const outsideChild = document.createElement('span');
      outsideChild.className = 'scoped-target';
      document.body.appendChild(outsideChild);

      const rootRef = { current: rootEl };

      const wrapper: React.FC<{ children: React.ReactNode }> = ({
        children,
      }) => (
        <LeafScopeProvider
          leafId="leaf-query"
          sessionId="sess-query"
          isActive={true}
          leafRootRef={rootRef}
        >
          {children}
        </LeafScopeProvider>
      );

      const { result } = renderHook(() => useLeafScope(), { wrapper });
      const found =
        result.current.queryWithinLeaf<HTMLSpanElement>('.scoped-target');

      expect(found).toBe(innerChild);
      expect(found).not.toBe(outsideChild);

      document.body.removeChild(outsideChild);
    });

    it('queryWithinLeaf 在 leafRootRef 为空时通过 data-leaf-id 属性查找', () => {
      const leafDiv = document.createElement('div');
      leafDiv.setAttribute('data-leaf-id', 'leaf-fallback');
      const child = document.createElement('button');
      child.className = 'btn-in-leaf';
      leafDiv.appendChild(child);
      document.body.appendChild(leafDiv);

      const rootRef = { current: null };

      const wrapper: React.FC<{ children: React.ReactNode }> = ({
        children,
      }) => (
        <LeafScopeProvider
          leafId="leaf-fallback"
          sessionId="sess-fallback"
          isActive={true}
          leafRootRef={rootRef}
        >
          {children}
        </LeafScopeProvider>
      );

      const { result } = renderHook(() => useLeafScope(), { wrapper });
      const found =
        result.current.queryWithinLeaf<HTMLButtonElement>('.btn-in-leaf');

      expect(found).toBe(child);

      document.body.removeChild(leafDiv);
    });
  });

  describe('useScopedSessionId', () => {
    it('显式传入 explicitSessionId 时拥有最高优先级', () => {
      const rootRef = { current: null };
      const wrapper: React.FC<{ children: React.ReactNode }> = ({
        children,
      }) => (
        <LeafScopeProvider
          leafId="leaf-1"
          sessionId="provider-session-id"
          isActive={true}
          leafRootRef={rootRef}
        >
          {children}
        </LeafScopeProvider>
      );

      const { result } = renderHook(
        () => useScopedSessionId('explicit-override-id'),
        { wrapper }
      );

      expect(result.current).toBe('explicit-override-id');
    });

    it('未传 explicitSessionId 但处于 Provider 内时使用 provider.sessionId', () => {
      const rootRef = { current: null };
      const wrapper: React.FC<{ children: React.ReactNode }> = ({
        children,
      }) => (
        <LeafScopeProvider
          leafId="leaf-1"
          sessionId="scoped-session-id"
          isActive={true}
          leafRootRef={rootRef}
        >
          {children}
        </LeafScopeProvider>
      );

      const { result } = renderHook(() => useScopedSessionId(), { wrapper });

      expect(result.current).toBe('scoped-session-id');
    });

    it('未包裹 Provider 且未传 explicitSessionId 时自动回退全局 store.activeSessionId', () => {
      useSessionStore.setState({ activeSessionId: 'global-store-session' });

      const { result } = renderHook(() => useScopedSessionId());

      expect(result.current).toBe('global-store-session');
    });

    it('显式传入空字符串或 null 时依次向下回退', () => {
      const rootRef = { current: null };
      const wrapper: React.FC<{ children: React.ReactNode }> = ({
        children,
      }) => (
        <LeafScopeProvider
          leafId="leaf-1"
          sessionId="provider-session-id"
          isActive={true}
          leafRootRef={rootRef}
        >
          {children}
        </LeafScopeProvider>
      );

      const { result: nullResult } = renderHook(
        () => useScopedSessionId(null),
        { wrapper }
      );
      expect(nullResult.current).toBe('provider-session-id');

      const { result: emptyResult } = renderHook(() => useScopedSessionId(''), {
        wrapper,
      });
      expect(emptyResult.current).toBe('provider-session-id');
    });
  });

  describe('shouldConsumeScopedEvent', () => {
    it('事件显式指定 sessionId 时必须严格匹配 target.sessionId', () => {
      const matching = shouldConsumeScopedEvent(
        { sessionId: 'session-alpha' },
        { sessionId: 'session-alpha', leafId: 'leaf-1', isActive: true }
      );
      expect(matching).toBe(true);

      const mismatching = shouldConsumeScopedEvent(
        { sessionId: 'session-beta' },
        { sessionId: 'session-alpha', leafId: 'leaf-1', isActive: true }
      );
      expect(mismatching).toBe(false);
    });

    it('事件显式指定 leafId 时必须严格匹配 target.leafId', () => {
      const matching = shouldConsumeScopedEvent(
        { leafId: 'leaf-alpha' },
        { sessionId: 'session-1', leafId: 'leaf-alpha', isActive: true }
      );
      expect(matching).toBe(true);

      const mismatching = shouldConsumeScopedEvent(
        { leafId: 'leaf-beta' },
        { sessionId: 'session-1', leafId: 'leaf-alpha', isActive: true }
      );
      expect(mismatching).toBe(false);
    });

    it('Guard-1: 当 target.sessionId 为空且未包裹 Provider 时，回退比对全局 activeSessionId', () => {
      useSessionStore.setState({ activeSessionId: 'global-active-1' });

      // 事件的目标与全局 store 吻合 -> 放行
      const matchesStore = shouldConsumeScopedEvent(
        { sessionId: 'global-active-1' },
        { sessionId: null, leafId: null }
      );
      expect(matchesStore).toBe(true);

      // 事件的目标与全局 store 不吻合 -> 拦截
      const mismatchesStore = shouldConsumeScopedEvent(
        { sessionId: 'other-session' },
        { sessionId: null, leafId: null }
      );
      expect(mismatchesStore).toBe(false);
    });

    it('Guard-1: 当 target.sessionId 为空且 store 也为空时（裸测试环境），默认放行', () => {
      useSessionStore.setState({ activeSessionId: '' });

      const allowed = shouldConsumeScopedEvent(
        { sessionId: 'any-session' },
        { sessionId: null, leafId: null }
      );
      expect(allowed).toBe(true);
    });

    it('无目标的广播事件：仅由当前 isActive === true 的子窗口消费', () => {
      // 激活窗口消费广播
      const activeConsumed = shouldConsumeScopedEvent(
        {},
        { sessionId: 'sess-1', leafId: 'leaf-1', isActive: true }
      );
      expect(activeConsumed).toBe(true);

      // 非激活窗口拦截广播
      const inactiveBlocked = shouldConsumeScopedEvent(
        {},
        { sessionId: 'sess-2', leafId: 'leaf-2', isActive: false }
      );
      expect(inactiveBlocked).toBe(false);
    });

    it('无目标且 target 未提供 isActive 时，回退至比对全局 activeSessionId', () => {
      useSessionStore.setState({ activeSessionId: 'target-sid' });

      const matches = shouldConsumeScopedEvent(null, {
        sessionId: 'target-sid',
      });
      expect(matches).toBe(true);

      const notMatches = shouldConsumeScopedEvent(null, {
        sessionId: 'other-sid',
      });
      expect(notMatches).toBe(false);
    });
  });
});
