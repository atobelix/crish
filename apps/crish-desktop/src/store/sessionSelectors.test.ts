// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { useSessionStore } from './sessionStore';
import {
  useSessionMeta,
  useSessionMessages,
  useSessionMessageCount,
  useSessionTitle,
  useSessionFolder,
  useSessionIsPinned,
  useActiveSessionId,
  selectSessionMeta,
  selectSessionMessages,
  selectSessionMessageCount,
  selectSessionTitle,
  selectSessionFolder,
  selectSessionIsPinned,
  selectActiveSessionId,
  clearSessionSelectorsCache,
  EMPTY_MESSAGES,
} from './sessionSelectors';
import type { SessionState, SessionMessage } from './types';

function createMockMessage(
  id: string,
  text: string,
  sender: 'user' | 'assistant' = 'assistant'
): SessionMessage {
  return {
    id,
    sender,
    text,
    timestamp: 1700000000000,
    blocks: [{ type: 'text', content: text }],
  };
}

function createMockSession(
  id: string,
  title: string,
  messages: SessionMessage[] = []
): SessionState {
  return {
    id,
    title,
    folder: '常规会话',
    isPinned: false,
    isArchived: false,
    timestamp: '2026-10-12T10:00:00.000Z',
    messages,
    agents: [],
  };
}

describe('sessionSelectors (Wave 3 W3-2)', () => {
  beforeEach(() => {
    clearSessionSelectorsCache();
    useSessionStore.setState((st) => {
      st.sessions = [];
      st.sessionsById = {};
      st.activeSessionId = '';
      st.folderOrder = ['常规会话'];
      st.activeAgentId = null;
      st.panelAgentId = null;
      st.composerDrafts = {};
      st.draftFolder = '';
      st.hydrationComplete = true;
    });
  });

  afterEach(() => {
    clearSessionSelectorsCache();
  });

  describe('Pure Selectors (选择器纯函数与缓存机制)', () => {
    it('selectSessionMeta 返回解耦后的纯元数据切片，不携带高频 messages 和 agents', () => {
      const msg1 = createMockMessage('m1', 'hello');
      const sess1 = createMockSession('sess-1', '会话一', [msg1]);
      sess1.isPinned = true;
      sess1.folder = '测试目录';

      useSessionStore.setState((st) => {
        st.sessions = [sess1];
        st.sessionsById = { [sess1.id]: sess1 };
      });

      const meta = selectSessionMeta('sess-1')(useSessionStore.getState());
      expect(meta).toBeDefined();
      expect(meta?.id).toBe('sess-1');
      expect(meta?.title).toBe('会话一');
      expect(meta?.folder).toBe('测试目录');
      expect(meta?.isPinned).toBe(true);
      expect(meta?.isArchived).toBe(false);
      expect(meta?.timestamp).toBe('2026-10-12T10:00:00.000Z');

      // 物理切除断言：元数据对象上不包含 messages 和 agents
      expect((meta as any).messages).toBeUndefined();
      expect((meta as any).agents).toBeUndefined();
    });

    it('selectSessionMeta 对不存在的会话返回 undefined', () => {
      const meta = selectSessionMeta('non-existent')(
        useSessionStore.getState()
      );
      expect(meta).toBeUndefined();
    });

    it('当会话进行消息流式推送（updateMessageText / updateMessageThinking）时，selectSessionMeta 返回值引用保持严格一致', () => {
      const msg1 = createMockMessage('m1', 'initial text');
      const sess1 = createMockSession('sess-1', '流式测试', [msg1]);

      useSessionStore.setState((st) => {
        st.sessions = [sess1];
        st.sessionsById = { [sess1.id]: sess1 };
      });

      const stateBefore = useSessionStore.getState();
      const metaBefore = selectSessionMeta('sess-1')(stateBefore);

      // 模拟流式 Token 追加推送
      stateBefore.updateMessageText('sess-1', 'm1', 'initial text + token 1');
      const stateAfter1 = useSessionStore.getState();
      const metaAfter1 = selectSessionMeta('sess-1')(stateAfter1);

      // 验证引用绝对一致 (toBe)，杜绝 Object.is 判定失败导致的无效重渲染
      expect(metaAfter1).toBe(metaBefore);
      expect(metaAfter1?.title).toBe('流式测试');

      // 继续模拟思考块流式推送
      stateAfter1.updateMessageThinking('sess-1', 'm1', 'thinking chunk...');
      const stateAfter2 = useSessionStore.getState();
      const metaAfter2 = selectSessionMeta('sess-1')(stateAfter2);

      expect(metaAfter2).toBe(metaBefore);
    });

    it('当会话元数据（如标题重命名）变更时，selectSessionMeta 精准返回新引用与最新值', () => {
      const msg1 = createMockMessage('m1', 'hello');
      const sess1 = createMockSession('sess-1', '旧标题', [msg1]);

      useSessionStore.setState((st) => {
        st.sessions = [sess1];
        st.sessionsById = { [sess1.id]: sess1 };
      });

      const metaBefore = selectSessionMeta('sess-1')(
        useSessionStore.getState()
      );
      expect(metaBefore?.title).toBe('旧标题');

      // 重命名会话
      useSessionStore.getState().renameSession('sess-1', '新标题');

      const metaAfter = selectSessionMeta('sess-1')(useSessionStore.getState());
      expect(metaAfter).not.toBe(metaBefore);
      expect(metaAfter?.title).toBe('新标题');
      expect(metaAfter?.id).toBe('sess-1');
    });

    it('多会话隔离：当某会话新增消息时，其他会话的 selectSessionMessages 与 selectSessionMeta 保持严格引用一致', () => {
      const sess1 = createMockSession('sess-1', '会话1', [
        createMockMessage('m1-1', 'msg1'),
      ]);
      const sess2 = createMockSession('sess-2', '会话2', [
        createMockMessage('m2-1', 'msg2'),
      ]);

      useSessionStore.setState((st) => {
        st.sessions = [sess1, sess2];
        st.sessionsById = {
          [sess1.id]: sess1,
          [sess2.id]: sess2,
        };
      });

      const state0 = useSessionStore.getState();
      const sess1MessagesBefore = selectSessionMessages('sess-1')(state0);
      const sess2MessagesBefore = selectSessionMessages('sess-2')(state0);
      const sess2MetaBefore = selectSessionMeta('sess-2')(state0);

      // 仅向 sess-1 追加新消息
      state0.addMessage('ws-1', 'sess-1', createMockMessage('m1-2', 'msg2'));

      const state1 = useSessionStore.getState();
      const sess1MessagesAfter = selectSessionMessages('sess-1')(state1);
      const sess2MessagesAfter = selectSessionMessages('sess-2')(state1);
      const sess2MetaAfter = selectSessionMeta('sess-2')(state1);

      // sess-1 消息数组引用更新
      expect(sess1MessagesAfter).not.toBe(sess1MessagesBefore);
      expect(sess1MessagesAfter).toHaveLength(2);

      // sess-2 消息数组与元数据引用严格不变 (===)
      expect(sess2MessagesAfter).toBe(sess2MessagesBefore);
      expect(sess2MetaAfter).toBe(sess2MetaBefore);
    });

    it('selectSessionMessages 当会话不存在时返回全局不可变常量 EMPTY_MESSAGES', () => {
      const messages1 = selectSessionMessages('invalid-1')(
        useSessionStore.getState()
      );
      const messages2 = selectSessionMessages('invalid-2')(
        useSessionStore.getState()
      );

      expect(messages1).toBe(EMPTY_MESSAGES);
      expect(messages2).toBe(EMPTY_MESSAGES);
      expect(messages1).toHaveLength(0);
      expect(Object.isFrozen(messages1)).toBe(true);
    });

    it('selectSessionMessageCount 正确统计消息数量，未水合时回退至 messageCount', () => {
      const sessWithMessages = createMockSession('sess-1', '有正文', [
        createMockMessage('m1', 'a'),
        createMockMessage('m2', 'b'),
      ]);
      const sessLazyShell: SessionState = {
        id: 'sess-lazy',
        title: '懒加载壳',
        folder: '常规会话',
        isPinned: false,
        isArchived: false,
        timestamp: '2026-10-12T10:00:00.000Z',
        messages: undefined as any,
        messageCount: 42,
      };

      useSessionStore.setState((st) => {
        st.sessions = [sessWithMessages, sessLazyShell];
        st.sessionsById = {
          [sessWithMessages.id]: sessWithMessages,
          [sessLazyShell.id]: sessLazyShell,
        };
      });

      const state = useSessionStore.getState();
      expect(selectSessionMessageCount('sess-1')(state)).toBe(2);
      expect(selectSessionMessageCount('sess-lazy')(state)).toBe(42);
      expect(selectSessionMessageCount('not-found')(state)).toBe(0);
    });

    it('selectActiveSessionId 正确反映活跃会话', () => {
      useSessionStore.setState((st) => {
        st.activeSessionId = 'active-xyz';
      });

      expect(selectActiveSessionId(useSessionStore.getState())).toBe(
        'active-xyz'
      );
    });

    it('selectSessionTitle / selectSessionFolder / selectSessionIsPinned 准确提取原子标量并对不存在会话回退默认值', () => {
      const sess1 = createMockSession('sess-1', '原子标量标题');
      sess1.folder = '项目A';
      sess1.isPinned = true;

      useSessionStore.setState((st) => {
        st.sessions = [sess1];
        st.sessionsById = { [sess1.id]: sess1 };
      });

      const state = useSessionStore.getState();
      expect(selectSessionTitle('sess-1')(state)).toBe('原子标量标题');
      expect(selectSessionFolder('sess-1')(state)).toBe('项目A');
      expect(selectSessionIsPinned('sess-1')(state)).toBe(true);

      // 不存在或空 sessionId 的安全回退
      expect(selectSessionTitle('not-found')(state)).toBe('');
      expect(selectSessionTitle('')(state)).toBe('');
      expect(selectSessionFolder('not-found')(state)).toBeUndefined();
      expect(selectSessionFolder('')(state)).toBeUndefined();
      expect(selectSessionIsPinned('not-found')(state)).toBe(false);
      expect(selectSessionIsPinned('')(state)).toBe(false);
    });
  });

  describe('React Hooks & Precise Re-render Invariants (细粒度订阅与重渲染拦截验证)', () => {
    it('侧边栏仅监听 useSessionMeta 时，消息流式推送不会触发侧边栏组件重渲染', () => {
      const msg1 = createMockMessage('m1', 'initial text');
      const sess1 = createMockSession('sess-1', '侧边栏测试', [msg1]);

      useSessionStore.setState((st) => {
        st.sessions = [sess1];
        st.sessionsById = { [sess1.id]: sess1 };
      });

      let sidebarRenderCount = 0;
      let chatRenderCount = 0;

      function SidebarRow({ sessionId }: { sessionId: string }) {
        const meta = useSessionMeta(sessionId);
        sidebarRenderCount++;
        return React.createElement(
          'div',
          { 'data-testid': 'sidebar-row' },
          meta?.title
        );
      }

      function ChatView({ sessionId }: { sessionId: string }) {
        const messages = useSessionMessages(sessionId);
        chatRenderCount++;
        return React.createElement(
          'div',
          { 'data-testid': 'chat-view' },
          messages.map((m) =>
            React.createElement(
              'span',
              { key: m.id, 'data-testid': `msg-${m.id}` },
              m.text
            )
          )
        );
      }

      function TestApp() {
        return React.createElement(
          'div',
          null,
          React.createElement(SidebarRow, { sessionId: 'sess-1' }),
          React.createElement(ChatView, { sessionId: 'sess-1' })
        );
      }

      render(React.createElement(TestApp));

      // 初始首屏挂载渲染 1 次
      expect(sidebarRenderCount).toBe(1);
      expect(chatRenderCount).toBe(1);
      expect(screen.getByTestId('sidebar-row').textContent).toBe('侧边栏测试');
      expect(screen.getByTestId('msg-m1').textContent).toBe('initial text');

      // 模拟多轮高频流式 Token 到达（连续 5 个 chunk）
      const chunks = [
        'initial text chunk 1',
        'initial text chunk 2',
        'initial text chunk 3',
        'initial text chunk 4',
        'initial text final response complete',
      ];

      for (const chunk of chunks) {
        act(() => {
          useSessionStore.getState().updateMessageText('sess-1', 'm1', chunk);
        });
      }

      // 关键核心断言：
      // 1. 侧边栏组件重渲染次数仍然为 1（完全没有发生重渲染！）
      expect(sidebarRenderCount).toBe(1);
      // 2. 对话视图组件正常按需更新渲染了 5 次流式更新
      expect(chatRenderCount).toBe(1 + chunks.length);
      // 3. 视图内容呈现最新的流式文本
      expect(screen.getByTestId('msg-m1').textContent).toBe(
        'initial text final response complete'
      );

      // 现在触发真正的元数据变更（重命名）
      act(() => {
        useSessionStore.getState().renameSession('sess-1', '改名后的标题');
      });

      // 侧边栏精准响应元数据更新（重渲染计数增至 2）
      expect(sidebarRenderCount).toBe(2);
      expect(screen.getByTestId('sidebar-row').textContent).toBe(
        '改名后的标题'
      );
      // 对话消息组件没有被干扰（依旧为之前的次数）
      expect(chatRenderCount).toBe(1 + chunks.length);
    });

    it('多个会话共存时，对会话 1 推流不会引发会话 2 的侧边栏与消息视图重渲染', () => {
      const sess1 = createMockSession('sess-1', '会话一', [
        createMockMessage('m1', 'hello 1'),
      ]);
      const sess2 = createMockSession('sess-2', '会话二', [
        createMockMessage('m2', 'hello 2'),
      ]);

      useSessionStore.setState((st) => {
        st.sessions = [sess1, sess2];
        st.sessionsById = {
          [sess1.id]: sess1,
          [sess2.id]: sess2,
        };
      });

      let sess2SidebarRenders = 0;
      let sess2ChatRenders = 0;

      function Sess2Sidebar() {
        const meta = useSessionMeta('sess-2');
        sess2SidebarRenders++;
        return React.createElement('div', null, meta?.title);
      }

      function Sess2Chat() {
        const messages = useSessionMessages('sess-2');
        sess2ChatRenders++;
        return React.createElement('div', null, messages.length);
      }

      render(
        React.createElement(
          'div',
          null,
          React.createElement(Sess2Sidebar),
          React.createElement(Sess2Chat)
        )
      );

      expect(sess2SidebarRenders).toBe(1);
      expect(sess2ChatRenders).toBe(1);

      // 向 sess-1 连续推送流式内容
      for (let i = 0; i < 10; i++) {
        act(() => {
          useSessionStore
            .getState()
            .updateMessageText('sess-1', 'm1', `token-${i}`);
        });
      }

      // sess-2 的组件一次都没被惊扰！
      expect(sess2SidebarRenders).toBe(1);
      expect(sess2ChatRenders).toBe(1);
    });

    it('useSessionMessageCount 仅在消息数量变化时触发重渲染，流式内容变更不触发', () => {
      const msg1 = createMockMessage('m1', 'hello');
      const sess1 = createMockSession('sess-1', '计数测试', [msg1]);

      useSessionStore.setState((st) => {
        st.sessions = [sess1];
        st.sessionsById = { [sess1.id]: sess1 };
      });

      let countRenderCount = 0;

      function MessageCountBadge({ sessionId }: { sessionId: string }) {
        const count = useSessionMessageCount(sessionId);
        countRenderCount++;
        return React.createElement(
          'span',
          { 'data-testid': 'count-badge' },
          count
        );
      }

      render(React.createElement(MessageCountBadge, { sessionId: 'sess-1' }));

      expect(countRenderCount).toBe(1);
      expect(screen.getByTestId('count-badge').textContent).toBe('1');

      // 流式修改文本：长度不变，不触发重渲染
      act(() => {
        useSessionStore
          .getState()
          .updateMessageText('sess-1', 'm1', 'hello streaming update');
      });

      expect(countRenderCount).toBe(1);

      // 新增一条消息：长度从 1 变 2，精准触发 1 次重渲染
      act(() => {
        useSessionStore
          .getState()
          .addMessage('ws-1', 'sess-1', createMockMessage('m2', 'world'));
      });

      expect(countRenderCount).toBe(2);
      expect(screen.getByTestId('count-badge').textContent).toBe('2');
    });

    it('useActiveSessionId 仅在 activeSessionId 变更时触发更新', () => {
      const sessA = createMockSession('sess-A', '会话A');
      const sessB = createMockSession('sess-B', '会话B');

      useSessionStore.setState((st) => {
        st.sessions = [sessA, sessB];
        st.sessionsById = {
          [sessA.id]: sessA,
          [sessB.id]: sessB,
        };
        st.activeSessionId = 'sess-A';
      });

      let activeRenders = 0;

      function ActiveIndicator() {
        const activeId = useActiveSessionId();
        activeRenders++;
        return React.createElement(
          'span',
          { 'data-testid': 'active-id' },
          activeId
        );
      }

      render(React.createElement(ActiveIndicator));

      expect(activeRenders).toBe(1);
      expect(screen.getByTestId('active-id').textContent).toBe('sess-A');

      // 切换活跃会话
      act(() => {
        useSessionStore.getState().setActiveSessionId('sess-B');
      });

      expect(activeRenders).toBe(2);
      expect(screen.getByTestId('active-id').textContent).toBe('sess-B');

      // 设置相同活跃会话：不触发重渲染
      act(() => {
        useSessionStore.getState().setActiveSessionId('sess-B');
      });

      expect(activeRenders).toBe(2);
    });

    it('useSessionTitle / useSessionFolder / useSessionIsPinned 在消息流式追加期间保持 0 重渲染，仅在各自标量字段变化时独立更新', () => {
      const msg1 = createMockMessage('m1', 'initial stream');
      const sess1 = createMockSession('sess-1', '初始标题', [msg1]);
      sess1.folder = '初始目录';
      sess1.isPinned = false;

      useSessionStore.setState((st) => {
        st.sessions = [sess1];
        st.sessionsById = { [sess1.id]: sess1 };
      });

      let titleRenderCount = 0;
      let folderRenderCount = 0;
      let pinnedRenderCount = 0;

      function TitleCell({ sessionId }: { sessionId: string }) {
        const title = useSessionTitle(sessionId);
        titleRenderCount++;
        return React.createElement(
          'span',
          { 'data-testid': 'scalar-title' },
          title
        );
      }

      function FolderCell({ sessionId }: { sessionId: string }) {
        const folder = useSessionFolder(sessionId);
        folderRenderCount++;
        return React.createElement(
          'span',
          { 'data-testid': 'scalar-folder' },
          folder ?? ''
        );
      }

      function PinnedCell({ sessionId }: { sessionId: string }) {
        const isPinned = useSessionIsPinned(sessionId);
        pinnedRenderCount++;
        return React.createElement(
          'span',
          { 'data-testid': 'scalar-pinned' },
          isPinned ? 'pinned' : 'unpinned'
        );
      }

      render(
        React.createElement(
          'div',
          null,
          React.createElement(TitleCell, { sessionId: 'sess-1' }),
          React.createElement(FolderCell, { sessionId: 'sess-1' }),
          React.createElement(PinnedCell, { sessionId: 'sess-1' })
        )
      );

      expect(titleRenderCount).toBe(1);
      expect(folderRenderCount).toBe(1);
      expect(pinnedRenderCount).toBe(1);
      expect(screen.getByTestId('scalar-title').textContent).toBe('初始标题');
      expect(screen.getByTestId('scalar-folder').textContent).toBe('初始目录');
      expect(screen.getByTestId('scalar-pinned').textContent).toBe('unpinned');

      // 1. 高频流式更新正文、思考块与追加新消息：三个标量组件均保持 0 重渲染
      for (let i = 0; i < 5; i++) {
        act(() => {
          useSessionStore
            .getState()
            .updateMessageText('sess-1', 'm1', `stream chunk ${i}`);
          useSessionStore
            .getState()
            .updateMessageThinking('sess-1', 'm1', `thinking ${i}`);
        });
      }
      act(() => {
        useSessionStore
          .getState()
          .addMessage(
            'ws-1',
            'sess-1',
            createMockMessage('m2', 'next message')
          );
      });

      expect(titleRenderCount).toBe(1);
      expect(folderRenderCount).toBe(1);
      expect(pinnedRenderCount).toBe(1);

      // 2. 仅修改 title：只有 TitleCell 重渲染，FolderCell 与 PinnedCell 保持 0 额外重渲染
      act(() => {
        useSessionStore.getState().renameSession('sess-1', '更新后标题');
      });

      expect(titleRenderCount).toBe(2);
      expect(folderRenderCount).toBe(1);
      expect(pinnedRenderCount).toBe(1);
      expect(screen.getByTestId('scalar-title').textContent).toBe('更新后标题');

      // 3. 仅修改 folder：只有 FolderCell 重渲染，TitleCell 与 PinnedCell 不受影响
      act(() => {
        useSessionStore
          .getState()
          .moveSessionRealtime('sess-1', null, '目标目录', false);
      });

      expect(titleRenderCount).toBe(2);
      expect(folderRenderCount).toBe(2);
      expect(pinnedRenderCount).toBe(1);
      expect(screen.getByTestId('scalar-folder').textContent).toBe('目标目录');

      // 4. 仅修改 isPinned：只有 PinnedCell 重渲染，TitleCell 与 FolderCell 不受影响
      act(() => {
        useSessionStore.getState().pinSession('sess-1');
      });

      expect(titleRenderCount).toBe(2);
      expect(folderRenderCount).toBe(2);
      expect(pinnedRenderCount).toBe(2);
      expect(screen.getByTestId('scalar-pinned').textContent).toBe('pinned');
    });
  });
});
