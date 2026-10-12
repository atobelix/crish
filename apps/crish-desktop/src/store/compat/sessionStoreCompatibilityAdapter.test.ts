import { describe, expect, it } from 'vitest';
import {
  createCompatibleSessionView,
  createSessionsByIdCompatibilityProxy,
  createCompatibleSessionsList,
  type SessionMeta,
} from './sessionStoreCompatibilityAdapter';
import type { SessionMessage, SessionAgent } from '../types';

function makeMessage(id: string, text = 'hello'): SessionMessage {
  return {
    id,
    sender: 'user',
    text,
    timestamp: 1700000000000,
  };
}

function makeAgent(id: string, name = 'Worker Agent'): SessionAgent {
  return {
    id,
    subagentRunId: `run-${id}`,
    parentSessionId: 'sess-parent',
    parentRunId: 'run-parent',
    description: name,
    mode: 'general',
    status: 'completed',
    messages: [],
    startedAt: 1700000000000,
  };
}

describe('sessionStoreCompatibilityAdapter', () => {
  describe('createCompatibleSessionView', () => {
    it('combines meta, messages, and agents into a valid SessionState composite view', () => {
      const meta: SessionMeta = {
        id: 'sess-1',
        title: 'Session One',
        folder: 'Dev Project',
        isPinned: true,
        isArchived: false,
        timestamp: '2026-10-12T10:00:00.000Z',
      };
      const messages = [makeMessage('m1', 'first message')];
      const agents = [makeAgent('a1', 'Subagent 1')];

      const view = createCompatibleSessionView(meta, messages, agents);

      expect(view.id).toBe('sess-1');
      expect(view.title).toBe('Session One');
      expect(view.folder).toBe('Dev Project');
      expect(view.isPinned).toBe(true);
      expect(view.isArchived).toBe(false);
      expect(view.timestamp).toBe('2026-10-12T10:00:00.000Z');
      expect(view.messages).toBe(messages);
      expect(view.messages).toHaveLength(1);
      expect(view.agents).toBe(agents);
      expect(view.agents).toHaveLength(1);
    });

    it('provides safe fallback defaults for omitted optional properties in meta', () => {
      const minimalMeta: SessionMeta = {
        id: 'sess-min',
        title: 'Minimal Session',
        createdAt: '2026-10-12T08:00:00.000Z',
      };

      const view = createCompatibleSessionView(minimalMeta);

      expect(view.id).toBe('sess-min');
      expect(view.title).toBe('Minimal Session');
      expect(view.folder).toBe('常规会话');
      expect(view.isPinned).toBe(false);
      expect(view.isArchived).toBe(false);
      expect(view.timestamp).toBe('2026-10-12T08:00:00.000Z');
      expect(view.messages).toEqual([]);
      expect(view.agents).toEqual([]);
    });

    it('ensures explicitly passed messages and agents override any stale messages/agents in meta', () => {
      const staleMeta = {
        id: 'sess-stale',
        title: 'Stale Session',
        messages: [makeMessage('stale-m', 'should be discarded')],
        agents: [makeAgent('stale-a', 'should be discarded')],
      } as unknown as SessionMeta;

      const freshMessages = [makeMessage('fresh-m', 'fresh message')];
      const freshAgents = [makeAgent('fresh-a', 'fresh agent')];

      const view = createCompatibleSessionView(
        staleMeta,
        freshMessages,
        freshAgents
      );

      expect(view.messages).toBe(freshMessages);
      expect(view.messages[0]?.id).toBe('fresh-m');
      expect(view.agents).toBe(freshAgents);
      expect(view.agents?.[0]?.id).toBe('fresh-a');
    });

    it('preserves specialized fields such as pinnedMessageIds, goalMode, importMeta', () => {
      const richMeta: SessionMeta = {
        id: 'sess-rich',
        title: 'Rich Session',
        pinnedMessageIds: ['m10', 'm20'],
        pinnedMessageColors: { m10: '#ff0000' },
        goalMode: {
          active: true,
          goal: 'Build test suite',
          iteration: 1,
        },
        importMeta: {
          source: 'claude-code',
          sourceSessionId: 'cc-123',
        },
      };

      const view = createCompatibleSessionView(richMeta);

      expect(view.pinnedMessageIds).toEqual(['m10', 'm20']);
      expect(view.pinnedMessageColors).toEqual({ m10: '#ff0000' });
      expect(view.goalMode?.active).toBe(true);
      expect(view.goalMode?.goal).toBe('Build test suite');
      expect(view.importMeta?.source).toBe('claude-code');
    });
  });

  describe('createSessionsByIdCompatibilityProxy', () => {
    const metaById: Record<string, SessionMeta> = {
      'sess-alpha': {
        id: 'sess-alpha',
        title: 'Alpha Session',
        folder: 'Project A',
        isPinned: false,
        isArchived: false,
        timestamp: '2026-10-12T01:00:00.000Z',
      },
      'sess-beta': {
        id: 'sess-beta',
        title: 'Beta Session',
        folder: 'Project B',
        isPinned: true,
        isArchived: false,
        timestamp: '2026-10-12T02:00:00.000Z',
      },
    };

    const messagesBySessionId: Record<string, SessionMessage[]> = {
      'sess-alpha': [makeMessage('m-alpha-1', 'Alpha Hello')],
      'sess-beta': [
        makeMessage('m-beta-1', 'Beta Hello'),
        makeMessage('m-beta-2', 'Beta World'),
      ],
    };

    const agentsBySessionId: Record<string, SessionAgent[]> = {
      'sess-alpha': [makeAgent('agent-alpha', 'Alpha Worker')],
      'sess-beta': [],
    };

    it('correctly reads existing sessions and stitches meta, messages, agents', () => {
      const proxy = createSessionsByIdCompatibilityProxy(
        metaById,
        messagesBySessionId,
        agentsBySessionId
      );

      const alpha = proxy['sess-alpha'];
      expect(alpha).toBeDefined();
      expect(alpha?.id).toBe('sess-alpha');
      expect(alpha?.title).toBe('Alpha Session');
      expect(alpha?.folder).toBe('Project A');
      expect(alpha?.messages).toHaveLength(1);
      expect(alpha?.messages[0]?.text).toBe('Alpha Hello');
      expect(alpha?.agents).toHaveLength(1);
      expect(alpha?.agents?.[0]?.description).toBe('Alpha Worker');

      const beta = proxy['sess-beta'];
      expect(beta).toBeDefined();
      expect(beta?.id).toBe('sess-beta');
      expect(beta?.isPinned).toBe(true);
      expect(beta?.messages).toHaveLength(2);
      expect(beta?.agents).toEqual([]);
    });

    it('returns undefined for non-existent session IDs', () => {
      const proxy = createSessionsByIdCompatibilityProxy(
        metaById,
        messagesBySessionId,
        agentsBySessionId
      );

      expect(proxy['sess-non-existent']).toBeUndefined();
      expect(proxy['']).toBeUndefined();
    });

    it('handles Symbol properties and prototype access without error', () => {
      const proxy = createSessionsByIdCompatibilityProxy(
        metaById,
        messagesBySessionId,
        agentsBySessionId
      );

      const customSym = Symbol('testSymbol');
      expect(
        (proxy as Record<string | symbol, unknown>)[customSym]
      ).toBeUndefined();
      expect(proxy[Symbol.toStringTag as unknown as string]).toBeUndefined();
      expect(Object.prototype.toString.call(proxy)).toBe('[object Object]');

      // Built-in properties/methods on Object prototype
      expect(proxy['constructor']).toBe(Object);
      expect(typeof proxy['toString']).toBe('function');
    });

    it('strictly checks session existence via "in" operator (has trap)', () => {
      const proxy = createSessionsByIdCompatibilityProxy(
        metaById,
        messagesBySessionId,
        agentsBySessionId
      );

      expect('sess-alpha' in proxy).toBe(true);
      expect('sess-beta' in proxy).toBe(true);
      expect('sess-gamma' in proxy).toBe(false);
      expect('constructor' in proxy).toBe(false);
      expect('toString' in proxy).toBe(false);
      expect('valueOf' in proxy).toBe(false);

      const sym = Symbol('custom');
      expect(sym in proxy).toBe(false);
    });

    it('supports Object.keys, Object.values, Object.entries and for...in enumeration', () => {
      const proxy = createSessionsByIdCompatibilityProxy(
        metaById,
        messagesBySessionId,
        agentsBySessionId
      );

      const keys = Object.keys(proxy);
      expect(keys).toEqual(['sess-alpha', 'sess-beta']);

      const values = Object.values(proxy);
      expect(values).toHaveLength(2);
      expect(values[0]?.id).toBe('sess-alpha');
      expect(values[1]?.id).toBe('sess-beta');

      const entries = Object.entries(proxy);
      expect(entries).toHaveLength(2);
      expect(entries[0]?.[0]).toBe('sess-alpha');
      expect(entries[0]?.[1]?.title).toBe('Alpha Session');

      const forInKeys: string[] = [];
      for (const k in proxy) {
        forInKeys.push(k);
      }
      expect(forInKeys).toEqual(['sess-alpha', 'sess-beta']);
    });

    it('provides valid PropertyDescriptor with enumerable and configurable: true', () => {
      const proxy = createSessionsByIdCompatibilityProxy(
        metaById,
        messagesBySessionId,
        agentsBySessionId
      );

      const desc = Object.getOwnPropertyDescriptor(proxy, 'sess-alpha');
      expect(desc).toBeDefined();
      expect(desc?.enumerable).toBe(true);
      expect(desc?.configurable).toBe(true);
      expect(desc?.value).toBeDefined();
      expect(desc?.value.id).toBe('sess-alpha');
      expect(desc?.value.title).toBe('Alpha Session');

      const missingDesc = Object.getOwnPropertyDescriptor(
        proxy,
        'sess-missing'
      );
      expect(missingDesc).toBeUndefined();
    });

    it('supports JSON.stringify serialization via ownKeys and getOwnPropertyDescriptor', () => {
      const proxy = createSessionsByIdCompatibilityProxy(
        metaById,
        messagesBySessionId,
        agentsBySessionId
      );

      const jsonStr = JSON.stringify(proxy);
      const parsed = JSON.parse(jsonStr);

      expect(parsed['sess-alpha']).toBeDefined();
      expect(parsed['sess-alpha'].id).toBe('sess-alpha');
      expect(parsed['sess-beta']).toBeDefined();
      expect(parsed['sess-beta'].id).toBe('sess-beta');
      expect(parsed['sess-missing']).toBeUndefined();
    });
  });

  describe('Isolation and immutability (no pollution between sessions)', () => {
    it('ensures updating one session messages leaves other session objects and references completely unpolluted', () => {
      const metaById: Record<string, SessionMeta> = {
        'sess-1': {
          id: 'sess-1',
          title: 'Session 1',
          timestamp: '2026-10-12T00:00:00Z',
        },
        'sess-2': {
          id: 'sess-2',
          title: 'Session 2',
          timestamp: '2026-10-12T00:00:00Z',
        },
      };

      const originalMessages1: SessionMessage[] = [makeMessage('m1', 'Msg 1')];
      const originalMessages2: SessionMessage[] = [makeMessage('m2', 'Msg 2')];

      const messagesBySessionId: Record<string, SessionMessage[]> = {
        'sess-1': originalMessages1,
        'sess-2': originalMessages2,
      };

      const agentsBySessionId: Record<string, SessionAgent[]> = {
        'sess-1': [],
        'sess-2': [],
      };

      const proxy = createSessionsByIdCompatibilityProxy(
        metaById,
        messagesBySessionId,
        agentsBySessionId
      );

      // Verify baseline
      const session2Before = proxy['sess-2']!;
      expect(session2Before.messages).toBe(originalMessages2);
      expect(session2Before.messages).toHaveLength(1);

      // Mutate/update ONLY session-1 messages (simulate high-frequency streaming)
      const updatedMessages1: SessionMessage[] = [
        ...originalMessages1,
        makeMessage('m1-stream', 'Token streaming chunk'),
      ];
      messagesBySessionId['sess-1'] = updatedMessages1;

      // Access session-2 again
      const session2After = proxy['sess-2']!;

      // Assert session-2 is 100% untouched
      expect(session2After.messages).toBe(originalMessages2);
      expect(session2After.messages).toHaveLength(1);
      expect(session2After.messages[0]?.id).toBe('m2');
      expect(session2After.title).toBe('Session 2');

      // Assert session-1 has received the new message
      const session1After = proxy['sess-1']!;
      expect(session1After.messages).toBe(updatedMessages1);
      expect(session1After.messages).toHaveLength(2);
      expect(session1After.messages[1]?.id).toBe('m1-stream');

      // Assert metaById was never mutated or cloned
      expect(metaById['sess-1']?.title).toBe('Session 1');
      expect(metaById['sess-2']?.title).toBe('Session 2');
    });

    it('ensures immutable update to messagesBySessionId dictionary isolates sessions properly', () => {
      const metaById: Record<string, SessionMeta> = {
        's-left': { id: 's-left', title: 'Left Pane Session' },
        's-right': { id: 's-right', title: 'Right Pane Session' },
      };

      const leftMsgs: SessionMessage[] = [makeMessage('l1', 'left')];
      const rightMsgs: SessionMessage[] = [makeMessage('r1', 'right')];

      const state1 = {
        metaById,
        messagesBySessionId: {
          's-left': leftMsgs,
          's-right': rightMsgs,
        },
      };

      const proxy1 = createSessionsByIdCompatibilityProxy(
        state1.metaById,
        state1.messagesBySessionId
      );

      // State 2: left session gets a new message, right session is untouched
      const newLeftMsgs = [...leftMsgs, makeMessage('l2', 'new left')];
      const state2 = {
        metaById: state1.metaById, // metaById completely unchanged
        messagesBySessionId: {
          ...state1.messagesBySessionId,
          's-left': newLeftMsgs,
        },
      };

      const proxy2 = createSessionsByIdCompatibilityProxy(
        state2.metaById,
        state2.messagesBySessionId
      );

      // Right session messages array in proxy2 is referentially identical to state1
      expect(proxy2['s-right']?.messages).toBe(rightMsgs);
      expect(proxy2['s-right']?.messages).toHaveLength(1);

      // Left session messages array in proxy2 reflects the update
      expect(proxy2['s-left']?.messages).toBe(newLeftMsgs);
      expect(proxy2['s-left']?.messages).toHaveLength(2);
    });
  });

  describe('createCompatibleSessionsList', () => {
    it('creates an ordered SessionState array matching sessionIds and skipping unknown IDs', () => {
      const metaById: Record<string, SessionMeta> = {
        s1: { id: 's1', title: 'First' },
        s2: { id: 's2', title: 'Second' },
      };
      const messagesBySessionId = {
        s1: [makeMessage('m1', 'msg1')],
      };

      const list = createCompatibleSessionsList(
        ['s2', 's-unknown', 's1'],
        metaById,
        messagesBySessionId
      );

      expect(list).toHaveLength(2);
      expect(list[0]?.id).toBe('s2');
      expect(list[0]?.title).toBe('Second');
      expect(list[0]?.messages).toEqual([]);
      expect(list[1]?.id).toBe('s1');
      expect(list[1]?.title).toBe('First');
      expect(list[1]?.messages).toHaveLength(1);
    });
  });
});
