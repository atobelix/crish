// @vitest-environment jsdom
import React, { lazy } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TreeLeafPanel } from '../TreeLeafPanel';
import type { LayoutLeaf } from '../../../store/layout-tree/types';
import {
  registerBuiltInViews,
  type ViewFactoryMap,
  type ViewRenderContext,
} from '../../../services/view-registry';
import { useLayoutTreeStore } from '../../../store/layout-tree';

// 拦截 ChatCard，暴露接收到的 sessionId
vi.mock('../../chat-card/ChatCard', () => ({
  ChatCard: (props: { sessionId?: string }) => (
    <div data-testid="mock-chat-card" data-session-id={props.sessionId || ''}>
      ChatCardContent
    </div>
  ),
}));

const stubFactory = () =>
  (() => null) as unknown as React.ComponentType<ViewRenderContext>;
const testFactories: ViewFactoryMap = {
  chat: () =>
    lazy(() =>
      import('../../chat-card/ChatCard').then((m) => ({
        default: (ctx: ViewRenderContext) => (
          <m.ChatCard sessionId={ctx.sessionId} />
        ),
      }))
    ),
  files: stubFactory,
  'file-viewer': stubFactory,
  composer: stubFactory,
  'diff-viewer': stubFactory,
  'model-selector': stubFactory,
  settings: stubFactory,
  'mcp-servers': stubFactory,
  'token-usage': stubFactory,
};

describe('TreeLeafPanel 默认会话激活与零点击渲染 (Zero-Click Suite)', () => {
  beforeEach(() => {
    registerBuiltInViews(testFactories);
    useLayoutTreeStore.setState((s) => ({
      ...s,
      activeLeafId: 'leaf-test-1',
    }));
  });

  it('CASE-1: 当 Leaf 拥有 Tabs 但 activeTabId 为空时，处于草稿新建态（渲染草稿容器，条带标签无选中）', async () => {
    const draftLeaf: LayoutLeaf = {
      type: 'leaf',
      id: 'leaf-test-1',
      panelId: 'chat',
      tabs: [
        {
          tabId: 'tab-101',
          sessionId: 'sess-real-1',
          title: '会话一',
          workspaceKey: 'conex',
        },
        {
          tabId: 'tab-102',
          sessionId: 'sess-real-2',
          title: '会话二',
          workspaceKey: 'conex',
        },
      ],
      activeTabId: '', // 用户加号新建草稿态
    };

    render(
      <TreeLeafPanel
        leaf={draftLeaf}
        rect={{ x: 0, y: 0, width: 0.5, height: 1 }}
        isActive={false} // 后台未聚焦窗格
      />
    );

    // 1. 等待 SlotOutlet 完成异步 lazy 挂载
    await waitFor(() => {
      expect(screen.getByTestId('mock-chat-card')).toBeInTheDocument();
    });

    const card = screen.getByTestId('mock-chat-card');
    // 2. 断言 ChatCard 正确挂载，并接收到本叶草稿 sessionId
    expect(card.getAttribute('data-session-id')).toBe(
      '__pending_draft__:leaf-test-1'
    );

    // 3. 断言顶栏 PaneHeader 的标签均未选中（处于新草稿态）
    const tab1 = screen.getByRole('tab', { name: '会话一' });
    expect(tab1.getAttribute('aria-selected')).toBe('false');
  });

  it('CASE-2: 真正无 Tab 的纯空叶节点（tabs: []），合法回退至草稿新会话', async () => {
    const emptyLeaf: LayoutLeaf = {
      type: 'leaf',
      id: 'leaf-test-empty',
      panelId: 'chat',
      tabs: [],
      activeTabId: '',
    };

    render(
      <TreeLeafPanel
        leaf={emptyLeaf}
        rect={{ x: 0.5, y: 0, width: 0.5, height: 1 }}
        isActive={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('mock-chat-card')).toBeInTheDocument();
    });

    const card = screen.getByTestId('mock-chat-card');
    expect(card.getAttribute('data-session-id')).toBe(
      '__pending_draft__:leaf-test-empty'
    );
  });

  it('CASE-3: 当 activeTabId 命中第 2 个 Tab 时，保持选中第 2 个 Tab', async () => {
    const normalLeaf: LayoutLeaf = {
      type: 'leaf',
      id: 'leaf-test-normal',
      panelId: 'chat',
      tabs: [
        {
          tabId: 'tab-201',
          sessionId: 'sess-real-1',
          title: '会话一',
          workspaceKey: 'conex',
        },
        {
          tabId: 'tab-202',
          sessionId: 'sess-real-2',
          title: '会话二',
          workspaceKey: 'conex',
        },
      ],
      activeTabId: 'tab-202',
    };

    render(
      <TreeLeafPanel
        leaf={normalLeaf}
        rect={{ x: 0, y: 0, width: 1, height: 1 }}
        isActive={true}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('mock-chat-card')).toBeInTheDocument();
    });

    const card = screen.getByTestId('mock-chat-card');
    expect(card.getAttribute('data-session-id')).toBe('sess-real-2');

    const tab2 = screen.getByRole('tab', { name: '会话二' });
    expect(tab2.getAttribute('aria-selected')).toBe('true');
  });

  it('CASE-4: 当 activeTabId 指向不存在的无效 Tab 时，自愈回退到第 0 个 Tab', async () => {
    const invalidLeaf: LayoutLeaf = {
      type: 'leaf',
      id: 'leaf-test-invalid',
      panelId: 'chat',
      tabs: [
        {
          tabId: 'tab-301',
          sessionId: 'sess-real-first',
          title: '会话首项',
          workspaceKey: 'conex',
        },
      ],
      activeTabId: 'tab-ghost-not-found',
    };

    render(
      <TreeLeafPanel
        leaf={invalidLeaf}
        rect={{ x: 0, y: 0, width: 1, height: 1 }}
        isActive={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('mock-chat-card')).toBeInTheDocument();
    });

    const card = screen.getByTestId('mock-chat-card');
    expect(card.getAttribute('data-session-id')).toBe('sess-real-first');
  });
});
