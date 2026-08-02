import { beforeEach, describe, expect, it, vi } from 'vitest';
import { produce } from 'immer';
import { createSessionActions, type SessionStoreSlice } from './sessionActions';
import { buildSessionsById } from './sessionIndex';
import { exportSessionToJsonObject, exportSessionToMarkdown } from '../api/sessionExport';
import { deriveSessionTitle } from '../api/sessionTitle';
import { scheduledSessionTitle } from '../api/workflowApi';
import type { SessionState } from './types';

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
});
