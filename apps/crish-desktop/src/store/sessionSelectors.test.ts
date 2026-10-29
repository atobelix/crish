// @vitest-environment jsdom
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { useSessionStore } from './sessionStore';
import {
  useSessionMessages,
  useSessionMessageCount,
  useSessionAgents,
  useSessionTitle,
  useSessionFolder,
  useSessionIsPinned,
  useActiveSessionId,
  selectSession,
  selectSessionMessages,
  selectSessionMessageCount,
  selectSessionAgents,
  selectSessionTitle,
  selectSessionFolder,
  selectSessionIsPinned,
  selectActiveSessionId,
  EMPTY_MESSAGES,
  EMPTY_AGENTS,
} from './sessionSelectors';
import type { SessionState, SessionMessage, SessionAgent } from './types';

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

function createMockAgent(
  id: string,
  parentSessionId: string,
  description = 'Test Agent',
  status: 'running' | 'completed' = 'running'
): SessionAgent {
  return {
    id,
    subagentRunId: `run-${id}`,
    parentSessionId,
    parentRunId: `parent-run-${parentSessionId}`,
    description,
    mode: 'general',
    status,
    messages: [],
    startedAt: 1700000000000,
  };
}

/** 按插入顺序写入唯一源。 */
function installSessions(sessions: SessionState[]): void {
  useSessionStore.setState((st) => {
    const sessionsById: Record<string, SessionState> = {};
    const sessionOrder: string[] = [];
    for (const sess of sessions) {
      sessionsById[sess.id] = sess;
      sessionOrder.push(sess.id);
    }
    st.sessionsById = sessionsById;
    st.sessionOrder = sessionOrder;
  });
}

describe('sessionSelectors (Wave 3 W3-2)', () => {
  beforeEach(() => {
    useSessionStore.setState((st) => {
      st.sessionsById = {};
      st.sessionOrder = [];
      st.activeSessionId = '';
      st.folderOrder = ['常规会话'];
      st.activeAgentId = null;
      st.panelAgentId = null;
      st.composerDrafts = {};
      st.draftFolder = '';
      st.hydrationComplete = true;
    });
  });

  describe('选择器纯函数', () => {
    it('标题、目录和置顶以标量读取，标识、归档态和时间戳仍从会话本体读取', () => {
      const msg1 = createMockMessage('m1', 'hello');
      const sess1 = createMockSession('sess-1', '会话一', [msg1]);
      sess1.isPinned = true;
      sess1.folder = '测试目录';

      installSessions([sess1]);

      const state = useSessionStore.getState();
      const session = selectSession('sess-1')(state);
      expect(session).toBeDefined();
      expect(session?.id).toBe('sess-1');
      expect(session?.isArchived).toBe(false);
      expect(session?.timestamp).toBe('2026-10-12T10:00:00.000Z');

      const title = selectSessionTitle('sess-1')(state);
      const folder = selectSessionFolder('sess-1')(state);
      const pinned = selectSessionIsPinned('sess-1')(state);
      expect(title).toBe('会话一');
      expect(selectSessionTitle(state, 'sess-1')).toBe(title);
      expect(folder).toBe('测试目录');
      expect(selectSessionFolder(state, 'sess-1')).toBe(folder);
      expect(pinned).toBe(true);
      expect(selectSessionIsPinned(state, 'sess-1')).toBe(pinned);

      // 标量不是消息数组，也不是子代理数组
      expect(typeof title).toBe('string');
      expect(typeof folder).toBe('string');
      expect(typeof pinned).toBe('boolean');
      expect(selectSessionMessages('sess-1')(state)).toHaveLength(1);
      expect(selectSessionMessages(state, 'sess-1')).toHaveLength(1);
      expect(selectSessionAgents('sess-1')(state)).toBe(EMPTY_AGENTS);
    });

    it('不存在的会话不返回会话本体，目录为空，标题与置顶走默认值', () => {
      const state = useSessionStore.getState();
      expect(selectSession('non-existent')(state)).toBeUndefined();
      expect(selectSessionTitle('non-existent')(state)).toBe('');
      expect(selectSessionTitle(state, 'non-existent')).toBe('');
      expect(selectSessionFolder('non-existent')(state)).toBeUndefined();
      expect(selectSessionFolder(state, 'non-existent')).toBeUndefined();
      expect(selectSessionIsPinned('non-existent')(state)).toBe(false);
      expect(selectSessionIsPinned(state, 'non-existent')).toBe(false);
    });

    it('消息流式推送时标题、目录和置顶保持全等', () => {
      const msg1 = createMockMessage('m1', 'initial text');
      const sess1 = createMockSession('sess-1', '流式测试', [msg1]);

      installSessions([sess1]);

      const stateBefore = useSessionStore.getState();
      const titleBefore = selectSessionTitle('sess-1')(stateBefore);
      const folderBefore = selectSessionFolder('sess-1')(stateBefore);
      const pinnedBefore = selectSessionIsPinned('sess-1')(stateBefore);

      stateBefore.updateMessageText('sess-1', 'm1', 'initial text + token 1');
      const stateAfter1 = useSessionStore.getState();
      expect(selectSessionTitle('sess-1')(stateAfter1)).toBe(titleBefore);
      expect(selectSessionTitle(stateAfter1, 'sess-1')).toBe(titleBefore);
      expect(selectSessionFolder('sess-1')(stateAfter1)).toBe(folderBefore);
      expect(selectSessionFolder(stateAfter1, 'sess-1')).toBe(folderBefore);
      expect(selectSessionIsPinned('sess-1')(stateAfter1)).toBe(pinnedBefore);
      expect(selectSessionIsPinned(stateAfter1, 'sess-1')).toBe(pinnedBefore);
      expect(titleBefore).toBe('流式测试');

      stateAfter1.updateMessageThinking('sess-1', 'm1', 'thinking chunk...');
      const stateAfter2 = useSessionStore.getState();
      expect(selectSessionTitle('sess-1')(stateAfter2)).toBe(titleBefore);
      expect(selectSessionFolder(stateAfter2, 'sess-1')).toBe(folderBefore);
      expect(selectSessionIsPinned(stateAfter2, 'sess-1')).toBe(pinnedBefore);
    });

    it('重命名只更新标题，目录和置顶保持全等', () => {
      const msg1 = createMockMessage('m1', 'hello');
      const sess1 = createMockSession('sess-1', '旧标题', [msg1]);

      installSessions([sess1]);

      const stateBefore = useSessionStore.getState();
      const titleBefore = selectSessionTitle('sess-1')(stateBefore);
      const folderBefore = selectSessionFolder('sess-1')(stateBefore);
      const pinnedBefore = selectSessionIsPinned('sess-1')(stateBefore);
      expect(titleBefore).toBe('旧标题');

      useSessionStore.getState().renameSession('sess-1', '新标题');

      const stateAfter = useSessionStore.getState();
      const titleAfter = selectSessionTitle('sess-1')(stateAfter);
      expect(titleAfter).not.toBe(titleBefore);
      expect(titleAfter).toBe('新标题');
      expect(selectSessionTitle(stateAfter, 'sess-1')).toBe('新标题');
      expect(selectSessionFolder('sess-1')(stateAfter)).toBe(folderBefore);
      expect(selectSessionIsPinned(stateAfter, 'sess-1')).toBe(pinnedBefore);
      expect(selectSession('sess-1')(stateAfter)?.id).toBe('sess-1');
    });

    it('多会话隔离：向某一会话追加消息时，其他会话的消息、标题、目录和置顶保持全等', () => {
      const sess1 = createMockSession('sess-1', '会话1', [
        createMockMessage('m1-1', 'msg1'),
      ]);
      const sess2 = createMockSession('sess-2', '会话2', [
        createMockMessage('m2-1', 'msg2'),
      ]);

      installSessions([sess1, sess2]);

      const state0 = useSessionStore.getState();
      const sess1MessagesBefore = selectSessionMessages('sess-1')(state0);
      const sess2MessagesBefore = selectSessionMessages('sess-2')(state0);
      const sess2Before = selectSession('sess-2')(state0);
      const sess2TitleBefore = selectSessionTitle('sess-2')(state0);
      const sess2FolderBefore = selectSessionFolder('sess-2')(state0);
      const sess2PinnedBefore = selectSessionIsPinned('sess-2')(state0);

      state0.addMessage('ws-1', 'sess-1', createMockMessage('m1-2', 'msg2'));

      const state1 = useSessionStore.getState();
      const sess1MessagesAfter = selectSessionMessages('sess-1')(state1);
      const sess2MessagesAfter = selectSessionMessages('sess-2')(state1);

      expect(sess1MessagesAfter).not.toBe(sess1MessagesBefore);
      expect(sess1MessagesAfter).toHaveLength(2);
      expect(selectSessionMessages(state1, 'sess-1')).toBe(sess1MessagesAfter);

      expect(sess2MessagesAfter).toBe(sess2MessagesBefore);
      expect(selectSessionMessages(state1, 'sess-2')).toBe(sess2MessagesBefore);
      expect(selectSession('sess-2')(state1)).toBe(sess2Before);
      expect(selectSessionTitle('sess-2')(state1)).toBe(sess2TitleBefore);
      expect(selectSessionTitle(state1, 'sess-2')).toBe(sess2TitleBefore);
      expect(selectSessionFolder('sess-2')(state1)).toBe(sess2FolderBefore);
      expect(selectSessionFolder(state1, 'sess-2')).toBe(sess2FolderBefore);
      expect(selectSessionIsPinned('sess-2')(state1)).toBe(sess2PinnedBefore);
      expect(selectSessionIsPinned(state1, 'sess-2')).toBe(sess2PinnedBefore);
    });

    it('selectSessionMessages 当会话不存在时返回全局不可变常量 EMPTY_MESSAGES', () => {
      const state = useSessionStore.getState();
      const messages1 = selectSessionMessages('invalid-1')(state);
      const messages1Dual = selectSessionMessages(state, 'invalid-1');
      const messages2 = selectSessionMessages('invalid-2')(state);

      expect(messages1).toBe(EMPTY_MESSAGES);
      expect(messages1Dual).toBe(EMPTY_MESSAGES);
      expect(messages2).toBe(EMPTY_MESSAGES);
      expect(messages1).toHaveLength(0);
      expect(Object.isFrozen(messages1)).toBe(true);
    });

    it('selectSessionMessageCount 有正文时取数组长度，空正文回退至 messageCount', () => {
      const sessWithMessages = createMockSession('sess-1', '有正文', [
        createMockMessage('m1', 'a'),
        createMockMessage('m2', 'b'),
      ]);
      const sessLazyShell = createMockSession('sess-lazy', '懒加载壳');
      sessLazyShell.messages = [];
      sessLazyShell.messageCount = 42;

      installSessions([sessWithMessages, sessLazyShell]);

      const state = useSessionStore.getState();
      expect(selectSessionMessageCount('sess-1')(state)).toBe(2);
      expect(selectSessionMessageCount(state, 'sess-1')).toBe(2);
      expect(selectSessionMessageCount('sess-lazy')(state)).toBe(42);
      expect(selectSessionMessageCount(state, 'sess-lazy')).toBe(42);
      expect(selectSessionMessageCount('not-found')(state)).toBe(0);
      expect(selectSessionMessageCount(state, 'not-found')).toBe(0);
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

      installSessions([sess1]);

      const state = useSessionStore.getState();
      expect(selectSessionTitle('sess-1')(state)).toBe('原子标量标题');
      expect(selectSessionTitle(state, 'sess-1')).toBe('原子标量标题');
      expect(selectSessionFolder('sess-1')(state)).toBe('项目A');
      expect(selectSessionFolder(state, 'sess-1')).toBe('项目A');
      expect(selectSessionIsPinned('sess-1')(state)).toBe(true);
      expect(selectSessionIsPinned(state, 'sess-1')).toBe(true);

      expect(selectSessionTitle('not-found')(state)).toBe('');
      expect(selectSessionTitle(state, '')).toBe('');
      expect(selectSessionFolder('not-found')(state)).toBeUndefined();
      expect(selectSessionFolder(state, '')).toBeUndefined();
      expect(selectSessionIsPinned('not-found')(state)).toBe(false);
      expect(selectSessionIsPinned(state, '')).toBe(false);
    });

    it('selectSessionAgents 返回当前会话的 agents 数组，会话不存在或无 agents 时返回不可变常量 EMPTY_AGENTS', () => {
      const sess1 = createMockSession('sess-1', '会话一');
      const agent1 = createMockAgent('ag-1', 'sess-1', '探索子代理');
      sess1.agents = [agent1];

      const sess2 = createMockSession('sess-2', '会话二');
      delete sess2.agents;

      installSessions([sess1, sess2]);

      const state = useSessionStore.getState();
      const agents1 = selectSessionAgents('sess-1')(state);
      expect(agents1).toEqual([agent1]);
      expect(selectSessionAgents(state, 'sess-1')).toBe(agents1);
      expect(agents1[0]?.id).toBe('ag-1');

      const agents2 = selectSessionAgents('sess-2')(state);
      expect(agents2).toBe(EMPTY_AGENTS);

      const agentsNonExistent = selectSessionAgents('non-existent')(state);
      expect(agentsNonExistent).toBe(EMPTY_AGENTS);
      expect(selectSessionAgents(state, 'non-existent')).toBe(EMPTY_AGENTS);
      expect(Object.isFrozen(agentsNonExistent)).toBe(true);

      const agentsEmptyId = selectSessionAgents('')(state);
      expect(agentsEmptyId).toBe(EMPTY_AGENTS);
      expect(selectSessionAgents(state, '')).toBe(EMPTY_AGENTS);
    });

    it('高频消息推流时 selectSessionAgents 保持引用一致', () => {
      const msg1 = createMockMessage('m1', 'hello');
      const agent1 = createMockAgent('ag-1', 'sess-1', '代码编写');
      const sess1 = createMockSession('sess-1', '流式隔离测试', [msg1]);
      sess1.agents = [agent1];

      installSessions([sess1]);

      const stateBefore = useSessionStore.getState();
      const agentsBefore = selectSessionAgents('sess-1')(stateBefore);

      stateBefore.updateMessageText('sess-1', 'm1', 'token 1 token 2');
      const stateAfter1 = useSessionStore.getState();
      const agentsAfter1 = selectSessionAgents('sess-1')(stateAfter1);
      expect(agentsAfter1).toBe(agentsBefore);
      expect(selectSessionAgents(stateAfter1, 'sess-1')).toBe(agentsBefore);

      stateAfter1.updateMessageThinking('sess-1', 'm1', 'thinking...');
      const stateAfter2 = useSessionStore.getState();
      const agentsAfter2 = selectSessionAgents('sess-1')(stateAfter2);
      expect(agentsAfter2).toBe(agentsBefore);
      expect(selectSessionAgents(stateAfter2, 'sess-1')).toBe(agentsBefore);
    });
  });

  describe('细粒度订阅与重渲染', () => {
    it('侧边栏仅监听 useSessionTitle 时，消息流式推送不会触发侧边栏组件重渲染', () => {
      const msg1 = createMockMessage('m1', 'initial text');
      const sess1 = createMockSession('sess-1', '侧边栏测试', [msg1]);

      installSessions([sess1]);

      let sidebarRenderCount = 0;
      let chatRenderCount = 0;

      function SidebarRow({ sessionId }: { sessionId: string }) {
        const title = useSessionTitle(sessionId);
        sidebarRenderCount++;
        return React.createElement(
          'div',
          { 'data-testid': 'sidebar-row' },
          title
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

      expect(sidebarRenderCount).toBe(1);
      expect(chatRenderCount).toBe(1);
      expect(screen.getByTestId('sidebar-row').textContent).toBe('侧边栏测试');
      expect(screen.getByTestId('msg-m1').textContent).toBe('initial text');

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

      expect(sidebarRenderCount).toBe(1);
      expect(chatRenderCount).toBe(1 + chunks.length);
      expect(screen.getByTestId('msg-m1').textContent).toBe(
        'initial text final response complete'
      );

      act(() => {
        useSessionStore.getState().renameSession('sess-1', '改名后的标题');
      });

      expect(sidebarRenderCount).toBe(2);
      expect(screen.getByTestId('sidebar-row').textContent).toBe(
        '改名后的标题'
      );
      expect(chatRenderCount).toBe(1 + chunks.length);
    });

    it('多个会话共存时，对会话 1 推流不会引发会话 2 的标题与消息视图重渲染', () => {
      const sess1 = createMockSession('sess-1', '会话一', [
        createMockMessage('m1', 'hello 1'),
      ]);
      const sess2 = createMockSession('sess-2', '会话二', [
        createMockMessage('m2', 'hello 2'),
      ]);

      installSessions([sess1, sess2]);

      let sess2SidebarRenders = 0;
      let sess2ChatRenders = 0;

      function Sess2Sidebar() {
        const title = useSessionTitle('sess-2');
        sess2SidebarRenders++;
        return React.createElement('div', null, title);
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

      for (let i = 0; i < 10; i++) {
        act(() => {
          useSessionStore
            .getState()
            .updateMessageText('sess-1', 'm1', `token-${i}`);
        });
      }

      expect(sess2SidebarRenders).toBe(1);
      expect(sess2ChatRenders).toBe(1);
    });

    it('useSessionMessageCount 仅在消息数量变化时触发重渲染，流式内容变更不触发', () => {
      const msg1 = createMockMessage('m1', 'hello');
      const sess1 = createMockSession('sess-1', '计数测试', [msg1]);

      installSessions([sess1]);

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

      act(() => {
        useSessionStore
          .getState()
          .updateMessageText('sess-1', 'm1', 'hello streaming update');
      });

      expect(countRenderCount).toBe(1);

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

      installSessions([sessA, sessB]);
      useSessionStore.setState((st) => {
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

      act(() => {
        useSessionStore.getState().setActiveSessionId('sess-B');
      });

      expect(activeRenders).toBe(2);
      expect(screen.getByTestId('active-id').textContent).toBe('sess-B');

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

      installSessions([sess1]);

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

      act(() => {
        useSessionStore.getState().renameSession('sess-1', '更新后标题');
      });

      expect(titleRenderCount).toBe(2);
      expect(folderRenderCount).toBe(1);
      expect(pinnedRenderCount).toBe(1);
      expect(screen.getByTestId('scalar-title').textContent).toBe('更新后标题');

      act(() => {
        useSessionStore
          .getState()
          .moveSessionRealtime('sess-1', null, '目标目录', false);
      });

      expect(titleRenderCount).toBe(2);
      expect(folderRenderCount).toBe(2);
      expect(pinnedRenderCount).toBe(1);
      expect(screen.getByTestId('scalar-folder').textContent).toBe('目标目录');

      act(() => {
        useSessionStore.getState().pinSession('sess-1');
      });

      expect(titleRenderCount).toBe(2);
      expect(folderRenderCount).toBe(2);
      expect(pinnedRenderCount).toBe(2);
      expect(screen.getByTestId('scalar-pinned').textContent).toBe('pinned');
    });

    it('useSessionAgents 仅在当前会话的 agents 真正变动时触发重渲染，消息流式推流与元数据变更保持 0 重渲染', () => {
      const msg1 = createMockMessage('m1', 'hello');
      const agent1 = createMockAgent('ag-1', 'sess-1', '初始子代理');
      const sess1 = createMockSession('sess-1', '会话1', [msg1]);
      sess1.agents = [agent1];

      const sess2 = createMockSession('sess-2', '会话2', [
        createMockMessage('m2', 'sess-2 msg'),
      ]);
      sess2.agents = [];

      installSessions([sess1, sess2]);

      let overviewRenderCount = 0;

      function OverviewAgentsObserver({ sessionId }: { sessionId: string }) {
        const agents = useSessionAgents(sessionId);
        overviewRenderCount++;
        return React.createElement(
          'div',
          { 'data-testid': 'overview-agents' },
          agents.map((a) =>
            React.createElement(
              'span',
              { key: a.id, 'data-testid': `agent-${a.id}` },
              a.description
            )
          )
        );
      }

      render(
        React.createElement(OverviewAgentsObserver, { sessionId: 'sess-1' })
      );

      expect(overviewRenderCount).toBe(1);
      expect(screen.getByTestId('agent-ag-1').textContent).toBe('初始子代理');

      act(() => {
        useSessionStore
          .getState()
          .updateMessageText('sess-1', 'm1', 'token chunk 1');
        useSessionStore
          .getState()
          .updateMessageText('sess-1', 'm1', 'token chunk 2');
        useSessionStore
          .getState()
          .updateMessageThinking('sess-1', 'm1', 'thinking chunk');
      });

      expect(overviewRenderCount).toBe(1);

      act(() => {
        useSessionStore.getState().renameSession('sess-1', '新标题');
        useSessionStore.getState().pinSession('sess-1');
      });

      expect(overviewRenderCount).toBe(1);

      act(() => {
        useSessionStore.setState((st) => {
          const s2 = st.sessionsById['sess-2'];
          if (s2) {
            s2.agents = [createMockAgent('ag-2', 'sess-2', 'sess-2 子代理')];
          }
        });
      });

      expect(overviewRenderCount).toBe(1);

      // 元素相同但数组是新引用时，订阅者按引用重绘一次
      act(() => {
        useSessionStore.setState((st) => {
          const s1 = st.sessionsById['sess-1'];
          if (s1?.agents) {
            s1.agents = [...s1.agents];
          }
        });
      });

      expect(overviewRenderCount).toBe(2);

      act(() => {
        useSessionStore.setState((st) => {
          const s1 = st.sessionsById['sess-1'];
          if (s1) {
            s1.agents = [
              agent1,
              createMockAgent('ag-new', 'sess-1', '新子代理'),
            ];
          }
        });
      });

      expect(overviewRenderCount).toBe(3);
      expect(screen.getByTestId('agent-ag-new').textContent).toBe('新子代理');
    });
  });

  describe('单轨架构锁死', () => {
    it('过渡期伪兼容适配层 sessionStoreCompatibilityAdapter.ts 已物理下线', () => {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const adapterPath = join(
        currentDir,
        'compat',
        'sessionStoreCompatibilityAdapter.ts'
      );
      const adapterTestPath = join(
        currentDir,
        'compat',
        'sessionStoreCompatibilityAdapter.test.ts'
      );

      expect(existsSync(adapterPath)).toBe(false);
      expect(existsSync(adapterTestPath)).toBe(false);
    });
  });
});
