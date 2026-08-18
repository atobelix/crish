import { beforeEach, describe, expect, it, vi } from 'vitest';
import { produce } from 'immer';
import { MAX_MESSAGES_PER_SESSION } from '@crish/shared-utils/browser';
import { createSessionActions, type SessionStoreSlice } from './sessionActions';
import { buildSessionsById } from './sessionIndex';
import { exportSessionToJsonObject, exportSessionToMarkdown } from '../api/sessionExport';
import { deriveSessionTitle } from '../api/sessionTitle';
import { scheduledSessionTitle } from '../api/workflowApi';
import type { SessionMessage, SessionState } from './types';

vi.mock('../api/appMode', () => ({
  isDemoMode: () => true,
}));

function makeSession(id: string, title: string, isPinned = false, isArchived = false): SessionState {
  return {
    id,
    title,
    folder: 'general',
    isPinned,
    isArchived,
    timestamp: new Date().toISOString(),
    messages: [
      { id: 'm1', sender: 'user', text: 'Hello AI assistant', timestamp: 1000 },
      { id: 'm2', sender: 'assistant', text: 'Hello! How can I help you today?', timestamp: 2000 },
    ],
  };
}

function makeStoreState(sessions: SessionState[], activeSessionId: string): SessionStoreSlice {
  return {
    sessions,
    sessionsById: buildSessionsById(sessions),
    folderOrder: ['general'],
    activeSessionId,
    draftFolder: '',
    activeAgentId: null,
    panelAgentId: null,
    composerDrafts: {},
  };
}

describe('Session History Management', () => {
  let state: SessionStoreSlice;

  const dispatchAction = (actionFn: (actions: ReturnType<typeof createSessionActions>) => void) => {
    state = produce(state, (draft) => {
      const actions = createSessionActions((updater) => {
        updater(draft);
      });
      actionFn(actions);
    });
  };

  beforeEach(() => {
    const s1 = makeSession('s1', 'First Session', false);
    const s2 = makeSession('s2', 'Second Session', false);
    state = makeStoreState([s1, s2], 's1');
  });

  describe('Session Pinning & Unpinning', () => {
    it('pins and unpins session by ID', () => {
      dispatchAction((a) => a.pinSession('s1'));
      expect(state.sessionsById['s1'].isPinned).toBe(true);

      dispatchAction((a) => a.unpinSession('s1'));
      expect(state.sessionsById['s1'].isPinned).toBe(false);
    });

    it('batch pins and unpins all sessions in a folder', () => {
      dispatchAction((a) => a.pinFolderSessions('general'));
      expect(state.sessions.find((s) => s.id === 's1')?.isPinned).toBe(true);
      expect(state.sessions.find((s) => s.id === 's2')?.isPinned).toBe(true);

      dispatchAction((a) => a.unpinFolderSessions('general'));
      expect(state.sessions.find((s) => s.id === 's1')?.isPinned).toBe(false);
      expect(state.sessions.find((s) => s.id === 's2')?.isPinned).toBe(false);
    });
  });

  describe('Session Archiving & Unarchiving', () => {
    it('archives session and switches active session if archived was active', () => {
      dispatchAction((a) => a.archiveSession('s1'));
      expect(state.sessionsById['s1'].isArchived).toBe(true);
      expect(state.activeSessionId).toBe('s2');

      dispatchAction((a) => a.unarchiveSession('s1'));
      expect(state.sessionsById['s1'].isArchived).toBe(false);
    });
  });

  describe('Session Branching', () => {
    it('branches a session creating a new session with cloned messages', () => {
      dispatchAction((a) => a.branchSession('s1', 'Branched Conversation'));
      expect(state.activeSessionId).toContain('sess-branch-');

      const branched = state.sessionsById[state.activeSessionId];
      expect(branched).toBeDefined();
      expect(branched.title).toBe('Branched Conversation');
      expect(branched.branchParentId).toBe('s1');
      expect(branched.messages).toHaveLength(2);
      expect(branched.messages[0].text).toBe('Hello AI assistant');
    });
  });

  describe('Session Auto Title Generation', () => {
    it('generates concise Chinese title from user prompt', () => {
      const title1 = deriveSessionTitle('请帮忙审视代码覆盖度并编写自动化测试');
      expect(title1).toBeDefined();
      expect(title1.length).toBeGreaterThan(0);
      expect(title1.length).toBeLessThanOrEqual(28);

      const scheduledTitle = scheduledSessionTitle('每日代码巡检');
      expect(scheduledTitle).toBe('定时 · 每日代码巡检');
    });
  });

  describe('Session Export Formatting', () => {
    it('exports session to JSON format', () => {
      const session = makeSession('s1', 'Export Test');
      const exportedJson = exportSessionToJsonObject(session);

      expect(exportedJson.session.id).toBe('s1');
      expect(exportedJson.session.title).toBe('Export Test');
      expect(exportedJson.session.messages).toHaveLength(2);
    });

    it('exports session to Markdown format with timestamps and roles', () => {
      const session = makeSession('s1', 'Markdown Export');
      const mdStr = exportSessionToMarkdown(session);

      expect(mdStr).toContain('# Markdown Export');
      expect(mdStr).toContain('Hello AI assistant');
      expect(mdStr).toContain('Hello! How can I help you today?');
    });
  });

  // ── C8 历史栈溢出/边界测试扩充 ──────────────────────────────────────────────
  describe('History Stack Overflow & Boundary (C8)', () => {
    it('addMessage triggers truncation at MAX_MESSAGES_PER_SESSION boundary (FIFO eviction)', () => {
      // 构造一个已达到上限的消息列表
      const messages: SessionMessage[] = [];
      for (let i = 0; i < MAX_MESSAGES_PER_SESSION; i++) {
        messages.push({
          id: `m${i}`,
          sender: i % 2 === 0 ? 'user' : 'assistant',
          text: `msg ${i}`,
          timestamp: i,
        });
      }
      const sess: SessionState = {
        id: 'overflow',
        title: 'Overflow Session',
        folder: 'general',
        isPinned: false,
        isArchived: false,
        timestamp: new Date().toISOString(),
        messages,
      };
      const slice: SessionStoreSlice = {
        sessions: [sess],
        sessionsById: buildSessionsById([sess]),
        folderOrder: ['general'],
        activeSessionId: 'overflow',
        draftFolder: '',
        activeAgentId: null,
        panelAgentId: null,
        composerDrafts: {},
      };
      let state = slice;
      const dispatchAction = (
        actionFn: (actions: ReturnType<typeof createSessionActions>) => void
      ) => {
        state = produce(state, (draft) => {
          const actions = createSessionActions((updater) => updater(draft));
          actionFn(actions);
        });
      };

      // 追加第 501 条消息 → 触发 truncateMessagesForAppend 淘汰最旧
      dispatchAction((a) =>
        a.addMessage('ws', 'overflow', {
          id: 'm500',
          sender: 'user',
          text: '第 501 条',
          timestamp: 500,
        })
      );

      const result = state.sessionsById['overflow'];
      expect(result.messages.length).toBeLessThanOrEqual(
        MAX_MESSAGES_PER_SESSION
      );
      // 新消息存在
      expect(
        result.messages.find((m) => m.id === 'm500')
      ).toBeDefined();
      // 最旧的 m0 被淘汰
      expect(result.messages.find((m) => m.id === 'm0')).toBeUndefined();
    });

    it('branchSession on empty session (no messages) produces empty branch without crash', () => {
      const emptySess: SessionState = {
        id: 'empty-src',
        title: '空会话',
        folder: 'general',
        isPinned: false,
        isArchived: false,
        timestamp: new Date().toISOString(),
        messages: [],
      };
      let state: SessionStoreSlice = {
        sessions: [emptySess],
        sessionsById: buildSessionsById([emptySess]),
        folderOrder: ['general'],
        activeSessionId: 'empty-src',
        draftFolder: '',
        activeAgentId: null,
        panelAgentId: null,
        composerDrafts: {},
      };
      const dispatchAction = (
        actionFn: (actions: ReturnType<typeof createSessionActions>) => void
      ) => {
        state = produce(state, (draft) => {
          const actions = createSessionActions((updater) => updater(draft));
          actionFn(actions);
        });
      };

      dispatchAction((a) => a.branchSession('empty-src', '空分叉'));
      const branched = state.sessionsById[state.activeSessionId];
      expect(branched).toBeDefined();
      expect(branched.title).toBe('空分叉');
      expect(branched.branchParentId).toBe('empty-src');
      expect(branched.messages).toHaveLength(0);
    });

    it('export empty session (no messages, no agents) produces valid export with empty=true', () => {
      const emptySess: SessionState = {
        id: 'export-empty',
        title: '空导出',
        folder: 'general',
        isPinned: false,
        isArchived: false,
        timestamp: new Date().toISOString(),
        messages: [],
      };
      const json = exportSessionToJsonObject(emptySess);
      expect(json.session.empty).toBe(true);
      expect(json.session.messages).toEqual([]);
      expect(json.session.id).toBe('export-empty');

      const md = exportSessionToMarkdown(emptySess);
      expect(md).toContain('# 空导出');
      expect(md).toContain('（无消息）');
    });

    it('deriveSessionTitle on empty string returns empty or fallback (title boundary)', () => {
      const t = deriveSessionTitle('');
      // 空输入不得产生长标题或抛异常
      expect(typeof t).toBe('string');
      expect(t.length).toBeLessThanOrEqual(28);
    });

    it('session with messages at exactly MAX_MESSAGES_PER_SESSION does not crash on branch', () => {
      const messages: SessionMessage[] = [];
      for (let i = 0; i < MAX_MESSAGES_PER_SESSION; i++) {
        messages.push({
          id: `bm${i}`,
          sender: i % 2 === 0 ? 'user' : 'assistant',
          text: `branch msg ${i}`,
          timestamp: i,
        });
      }
      const fullSess: SessionState = {
        id: 'full-src',
        title: '满会话',
        folder: 'general',
        isPinned: false,
        isArchived: false,
        timestamp: new Date().toISOString(),
        messages,
      };
      let state: SessionStoreSlice = {
        sessions: [fullSess],
        sessionsById: buildSessionsById([fullSess]),
        folderOrder: ['general'],
        activeSessionId: 'full-src',
        draftFolder: '',
        activeAgentId: null,
        panelAgentId: null,
        composerDrafts: {},
      };
      const dispatchAction = (
        actionFn: (actions: ReturnType<typeof createSessionActions>) => void
      ) => {
        state = produce(state, (draft) => {
          const actions = createSessionActions((updater) => updater(draft));
          actionFn(actions);
        });
      };

      dispatchAction((a) => a.branchSession('full-src', '满分叉'));
      const branched = state.sessionsById[state.activeSessionId];
      expect(branched).toBeDefined();
      // 分叉克隆全部消息，不截断
      expect(branched.messages.length).toBe(MAX_MESSAGES_PER_SESSION);
      expect(branched.messages[0].text).toBe('branch msg 0');
      expect(branched.messages[MAX_MESSAGES_PER_SESSION - 1].text).toBe(
        `branch msg ${MAX_MESSAGES_PER_SESSION - 1}`
      );
    });
  });
});
