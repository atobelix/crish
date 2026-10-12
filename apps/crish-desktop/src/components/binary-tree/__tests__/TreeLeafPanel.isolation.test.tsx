// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  renderHook,
  act,
} from '@testing-library/react';
import { TreeLeafPanel } from '../TreeLeafPanel';
import { isLeafInDraftMode } from '../treeLeafPanelModel';
import {
  useLeafScope,
  LeafScopeProvider,
} from '../../../contexts/LeafScopeContext';
import { useScopedSessionField } from '../../chat-card/useScopedSessionField';
import { useLayoutTreeStore } from '../../../store/layout-tree';
import { useSessionStore } from '../../../store/sessionStore';
import { getCompositionRoot } from '../../../app/compositionRoot';
import {
  registerBuiltInViews,
  type ViewFactoryMap,
  type ViewRenderContext,
} from '../../../services/view-registry';
import type { LayoutLeaf } from '../../../store/types';

// 测试专属子组件：用于验证 LeafScopeContext 的深层透传
const TestContextConsumer: React.FC<{ testId?: string }> = ({
  testId = 'leaf-scope-consumer',
}) => {
  const scope = useLeafScope();
  return (
    <div
      data-testid={testId}
      data-leaf-id={scope.leafId}
      data-session-id={scope.sessionId}
      data-is-active={scope.isActive ? 'true' : 'false'}
    >
      <input data-testid="scoped-composer-input" placeholder="type here" />
      <button data-testid="scoped-send-btn" type="button">
        发送
      </button>
      <button
        data-testid="scoped-close-tab-btn"
        data-tab-close="true"
        aria-label="关闭标签"
        type="button"
      >
        ×
      </button>
      <button
        data-testid="scoped-prevent-btn"
        data-prevent-leaf-activate="true"
        type="button"
      >
        阻止激活按钮
      </button>
      <button
        data-testid="scoped-close-title-btn"
        title="关闭面板"
        type="button"
      >
        关闭
      </button>
    </div>
  );
};

const testViewFactories: ViewFactoryMap = {
  chat: () =>
    React.lazy(async () => ({
      default: (ctx: ViewRenderContext) => (
        <div data-testid={`chat-view-${ctx.leafId}`}>
          <TestContextConsumer testId={`consumer-${ctx.leafId}`} />
        </div>
      ),
    })),
  overview: () =>
    React.lazy(async () => ({
      default: () => <div data-testid="overview-view">Overview</div>,
    })),
};

function createMockLeaf(
  id: string,
  tabs: Array<{ tabId: string; sessionId: string; title?: string }> = [],
  activeTabId: string = ''
): LayoutLeaf {
  return {
    type: 'leaf',
    id,
    panelId: 'chat',
    tabs: tabs as any,
    activeTabId,
    dock: {
      collapsed: true,
      openPanelIds: [],
      activePanelId: null,
      widthRatio: 0.5,
    },
  };
}

describe('TreeLeafPanel 天然隔离与焦点激活（Dimension 01）', () => {
  beforeEach(() => {
    registerBuiltInViews(testViewFactories);
    useLayoutTreeStore.setState({ activeLeafId: 'leaf-1' });
    useSessionStore.setState({
      activeSessionId: 'sess-1',
      sessionsById: {
        'sess-1': {
          id: 'sess-1',
          title: '会话 1',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: 't1',
          messages: [],
          agents: [],
        } as any,
        'sess-2': {
          id: 'sess-2',
          title: '会话 2',
          folder: '默认',
          isPinned: false,
          isArchived: false,
          timestamp: 't2',
          messages: [],
          agents: [],
        } as any,
      },
      draftFolder: '默认',
    });

    const root = getCompositionRoot();
    (root.shell as any) = {
      activateTab: vi.fn(),
      focusLeaf: vi.fn(),
      addTab: vi.fn(),
      removeTab: vi.fn(),
    };
  });

  describe('支柱一与支柱二：草稿态 SSOT（B-01）', () => {
    it('isLeafInDraftMode 以 leaf.activeTabId === "" 或 leaf.tabs.length === 0 为唯一真理', () => {
      const emptyTabLeaf = createMockLeaf('leaf-empty', [], '');
      expect(isLeafInDraftMode(emptyTabLeaf)).toBe(true);

      const draftWithTabsLeaf = createMockLeaf(
        'leaf-tabs',
        [{ tabId: 'tab-1', sessionId: 'sess-1' }],
        ''
      );
      expect(isLeafInDraftMode(draftWithTabsLeaf)).toBe(true);

      const activeTabLeaf = createMockLeaf(
        'leaf-active',
        [{ tabId: 'tab-1', sessionId: 'sess-1' }],
        'tab-1'
      );
      expect(isLeafInDraftMode(activeTabLeaf)).toBe(false);
    });

    it('草稿态分屏不受全局 activeSessionId 切换影响，维持草稿 ID 不变', () => {
      const leafDraft = createMockLeaf('leaf-draft', [], '');
      expect(isLeafInDraftMode(leafDraft)).toBe(true);

      // 全局切换到会话 2
      useSessionStore.setState({ activeSessionId: 'sess-2' });

      // 叶子草稿态完全由自身状态决定，依然为 true
      expect(isLeafInDraftMode(leafDraft)).toBe(true);
    });

    it('TreeLeafPanel 渲染草稿分屏时，容器 data-session-id 稳定为 __pending_draft__:${leaf.id}', async () => {
      const leafDraft = createMockLeaf('leaf-draft-99', [], '');

      render(
        <TreeLeafPanel
          leaf={leafDraft}
          rect={{ x: 0, y: 0, width: 0.5, height: 1 }}
          isActive={false}
        />
      );

      await screen.findByTestId('consumer-leaf-draft-99');
      const panel = document.querySelector('[data-leaf-id="leaf-draft-99"]');
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute('data-session-id')).toBe(
        '__pending_draft__:leaf-draft-99'
      );
    });
  });

  describe('支柱二：捕获阶段自动激活（A-01）与销毁白名单排除', () => {
    it('在非激活分屏点击输入框或发送按钮时，捕获阶段自动同步 activeLeaf 与 activeSessionId', async () => {
      const leaf2 = createMockLeaf(
        'leaf-2',
        [{ tabId: 'tab-2', sessionId: 'sess-2' }],
        'tab-2'
      );

      const setActiveLeafSpy = vi.spyOn(
        useLayoutTreeStore.getState(),
        'setActiveLeaf'
      );
      const setActiveSessionIdSpy = vi.spyOn(
        useSessionStore.getState(),
        'setActiveSessionId'
      );

      render(
        <TreeLeafPanel
          leaf={leaf2}
          rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
          isActive={false}
        />
      );

      const input = await screen.findByTestId('scoped-composer-input');
      expect(input).toBeTruthy();

      // 用户直接点击非激活分屏的输入框
      fireEvent.pointerDown(input);

      expect(setActiveLeafSpy).toHaveBeenCalledWith('leaf-2');
      expect(setActiveSessionIdSpy).toHaveBeenCalledWith('sess-2');
    });

    it('点击 [data-tab-close] 销毁按钮时跳过激活，不抢夺前台焦点', async () => {
      const leaf2 = createMockLeaf(
        'leaf-2',
        [{ tabId: 'tab-2', sessionId: 'sess-2' }],
        'tab-2'
      );

      const setActiveLeafSpy = vi.spyOn(
        useLayoutTreeStore.getState(),
        'setActiveLeaf'
      );

      render(
        <TreeLeafPanel
          leaf={leaf2}
          rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
          isActive={false}
        />
      );

      const closeBtn = await screen.findByTestId('scoped-close-tab-btn');
      fireEvent.pointerDown(closeBtn);

      expect(setActiveLeafSpy).not.toHaveBeenCalled();
    });

    it('点击 [data-prevent-leaf-activate="true"] 时跳过激活', async () => {
      const leaf2 = createMockLeaf(
        'leaf-2',
        [{ tabId: 'tab-2', sessionId: 'sess-2' }],
        'tab-2'
      );

      const setActiveLeafSpy = vi.spyOn(
        useLayoutTreeStore.getState(),
        'setActiveLeaf'
      );

      render(
        <TreeLeafPanel
          leaf={leaf2}
          rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
          isActive={false}
        />
      );

      const preventBtn = await screen.findByTestId('scoped-prevent-btn');
      fireEvent.pointerDown(preventBtn);

      expect(setActiveLeafSpy).not.toHaveBeenCalled();
    });

    it('点击 title="关闭面板" 按钮时跳过激活', async () => {
      const leaf2 = createMockLeaf(
        'leaf-2',
        [{ tabId: 'tab-2', sessionId: 'sess-2' }],
        'tab-2'
      );

      const setActiveLeafSpy = vi.spyOn(
        useLayoutTreeStore.getState(),
        'setActiveLeaf'
      );

      render(
        <TreeLeafPanel
          leaf={leaf2}
          rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
          isActive={false}
        />
      );

      const closeTitleBtn = await screen.findByTestId('scoped-close-title-btn');
      fireEvent.pointerDown(closeTitleBtn);

      expect(setActiveLeafSpy).not.toHaveBeenCalled();
    });

    it('幂等短路：若当前叶子已激活且 activeSessionId 已对齐，不重复触发 store dispatch', async () => {
      const leaf1 = createMockLeaf(
        'leaf-1',
        [{ tabId: 'tab-1', sessionId: 'sess-1' }],
        'tab-1'
      );

      useLayoutTreeStore.setState({ activeLeafId: 'leaf-1' });
      useSessionStore.setState({ activeSessionId: 'sess-1' });

      const setActiveLeafSpy = vi.spyOn(
        useLayoutTreeStore.getState(),
        'setActiveLeaf'
      );
      const setActiveSessionIdSpy = vi.spyOn(
        useSessionStore.getState(),
        'setActiveSessionId'
      );

      render(
        <TreeLeafPanel
          leaf={leaf1}
          rect={{ x: 0, y: 0, width: 0.5, height: 1 }}
          isActive={true}
        />
      );

      const input = await screen.findByTestId('scoped-composer-input');
      fireEvent.pointerDown(input);

      expect(setActiveLeafSpy).not.toHaveBeenCalled();
      expect(setActiveSessionIdSpy).not.toHaveBeenCalled();
    });
  });

  describe('支柱一：LeafScopeProvider 子树透传', () => {
    it('子树内的组件无需 prop drilling 即可读取本叶作用域', async () => {
      const leaf = createMockLeaf(
        'leaf-scope-test',
        [{ tabId: 'tab-x', sessionId: 'sess-x' }],
        'tab-x'
      );

      render(
        <TreeLeafPanel
          leaf={leaf}
          rect={{ x: 0, y: 0, width: 0.5, height: 1 }}
          isActive={true}
        />
      );

      const consumer = await screen.findByTestId('consumer-leaf-scope-test');
      expect(consumer.getAttribute('data-leaf-id')).toBe('leaf-scope-test');
      expect(consumer.getAttribute('data-session-id')).toBe('sess-x');
      expect(consumer.getAttribute('data-is-active')).toBe('true');
    });
  });

  describe('useScopedSessionField 跨分屏切换短路隔离（A-10）', () => {
    it('非活跃分屏的 useScopedSessionField 在切换全局 activeSessionId 时严格短路不重算', () => {
      const selectorSpy = vi.fn((s: any) => s?.title ?? '');
      const rootRef = { current: null };

      const wrapper: React.FC<{ children: React.ReactNode }> = ({
        children,
      }) => (
        <LeafScopeProvider
          leafId="leaf-inactive"
          sessionId="sess-2"
          isActive={false}
          leafRootRef={rootRef}
        >
          {children}
        </LeafScopeProvider>
      );

      let renderCount = 0;
      const { result } = renderHook(
        () => {
          renderCount++;
          return useScopedSessionField((s) => s.activeSessionId, selectorSpy);
        },
        { wrapper }
      );

      expect(result.current).toBe('会话 2');
      expect(selectorSpy).toHaveBeenCalledTimes(1);

      renderCount = 0;
      selectorSpy.mockClear();

      // 全局 activeSessionId 在另一个分屏切换为 sess-1
      act(() => {
        useSessionStore.setState({ activeSessionId: 'sess-1' });
      });

      // 非活跃分屏由于已绑定 sess-2，且 sess-2 引用未变，严格短路：零重求值、零重渲染
      expect(selectorSpy).not.toHaveBeenCalled();
      expect(renderCount).toBe(0);
      expect(result.current).toBe('会话 2');
    });
  });
});
