import { describe, it, expect, beforeEach } from 'vitest';
import { applyCompressionSummaryToStore } from '../sessionCompressionApply';
import { useSessionStore } from '../sessionStore';
import type { SessionMessage, SessionState } from '../types';

/**
 * Mirror of isRecord from apps/crish-desktop/src/store/sessionCompressionApply.ts:16
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function createDummyMessage(id: string, metadata?: unknown): SessionMessage {
  return {
    id,
    role: 'assistant',
    text: `Message ${id}`,
    timestamp: Date.now(),
    metadata,
  };
}

function createSession(
  id: string,
  messages: SessionMessage[] = []
): SessionState {
  return {
    id,
    title: `Session ${id}`,
    messages,
    messagesHydrated: true,
    hydratedFromEngine: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as SessionState;
}

describe('Adversarial Stress Test: sessionCompressionApply & isRecord', () => {
  const sessionId = 'test-session-adversarial';

  beforeEach(() => {
    useSessionStore.setState({
      sessions: [],
      sessionsById: {},
      activeSessionId: sessionId,
    });
  });

  describe('1. isRecord predicate against hostile and edge-case inputs', () => {
    it('rejects null and undefined', () => {
      expect(isRecord(null)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
    });

    it('rejects primitive numbers, strings, booleans, symbols, and bigints', () => {
      expect(isRecord(0)).toBe(false);
      expect(isRecord(42)).toBe(false);
      expect(isRecord(-1)).toBe(false);
      expect(isRecord(NaN)).toBe(false);
      expect(isRecord(Infinity)).toBe(false);
      expect(isRecord('')).toBe(false);
      expect(isRecord('hello world')).toBe(false);
      expect(isRecord(true)).toBe(false);
      expect(isRecord(false)).toBe(false);
      expect(isRecord(Symbol())).toBe(false);
      expect(isRecord(Symbol('hostile'))).toBe(false);
      expect(isRecord(BigInt(100))).toBe(false);
      expect(isRecord(123n)).toBe(false);
    });

    it('rejects arrays (empty, populated, sparse, nested)', () => {
      expect(isRecord([])).toBe(false);
      expect(isRecord([1, 2, 3])).toBe(false);
      expect(isRecord(new Array(10))).toBe(false);
      expect(isRecord(['nested', ['array']])).toBe(false);
    });

    it('rejects functions and class constructors', () => {
      expect(isRecord(() => {})).toBe(false);
      expect(isRecord(function named() {})).toBe(false);
      expect(isRecord(async () => {})).toBe(false);
      expect(isRecord(class Dummy {})).toBe(false);
    });

    it('accepts plain and complex object instances without throwing', () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1, b: 'two' })).toBe(true);
      expect(isRecord(Object.create(null))).toBe(true);
      expect(isRecord(Object.create({ prototypeProp: true }))).toBe(true);
      expect(isRecord(Object.freeze({ frozen: true }))).toBe(true);
      expect(isRecord(Object.seal({ sealed: true }))).toBe(true);
      expect(isRecord(Object.preventExtensions({ nonExtensible: true }))).toBe(
        true
      );
    });

    it('safely handles circular object references without infinite recursion', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      circular.nested = { loop: circular };
      expect(isRecord(circular)).toBe(true);
      expect(isRecord(circular.nested)).toBe(true);
    });

    it('does not evaluate property getters when checking isRecord', () => {
      let getterCalled = false;
      const getterObj = {
        get boom() {
          getterCalled = true;
          throw new Error('Getter must not be evaluated during isRecord!');
        },
      };

      expect(() => isRecord(getterObj)).not.toThrow();
      expect(isRecord(getterObj)).toBe(true);
      expect(getterCalled).toBe(false);
    });

    it('safely handles proxies with throwing get traps without invoking get', () => {
      const hostileProxy = new Proxy(
        {},
        {
          get() {
            throw new Error('Proxy get trap must not be triggered!');
          },
        }
      );

      expect(() => isRecord(hostileProxy)).not.toThrow();
      expect(isRecord(hostileProxy)).toBe(true);
    });
  });

  describe('2. applyCompressionSummaryToStore under hostile and unexpected conditions', () => {
    it('safely no-ops if session does not exist in store', () => {
      const summaryMsg = createDummyMessage('summary-block-1');
      expect(() => {
        applyCompressionSummaryToStore(
          'non-existent-session',
          'summary-block-1',
          summaryMsg,
          []
        );
      }).not.toThrow();

      const state = useSessionStore.getState();
      expect(state.sessions).toHaveLength(0);
    });

    it('safely initializes messages array in sessions[] if session.messages is undefined', () => {
      const sess = createSession(
        sessionId,
        undefined as unknown as SessionMessage[]
      );
      delete (sess as Partial<SessionState>).messages;

      useSessionStore.setState({
        sessions: [sess],
        sessionsById: { [sessionId]: sess },
      });

      const summaryMsg = createDummyMessage('summary-block-1');
      expect(() => {
        applyCompressionSummaryToStore(
          sessionId,
          'summary-block-1',
          summaryMsg,
          []
        );
      }).not.toThrow();

      const updatedSess = useSessionStore.getState().sessions[0];
      expect(updatedSess.messages).toBeDefined();
      expect(updatedSess.messages).toHaveLength(1);
      expect(updatedSess.messages[0].id).toBe('summary-block-1');
    });

    it('updates in-place when blockId matches an existing message in the session', () => {
      const existingSummary = createDummyMessage('summary-block-1');
      existingSummary.text = 'Initial summary text';
      const normalMsg = createDummyMessage('normal-msg-1');

      const sess = createSession(sessionId, [existingSummary, normalMsg]);
      useSessionStore.setState({
        sessions: [sess],
        sessionsById: { [sessionId]: sess },
      });

      const replacementSummary = createDummyMessage('summary-block-1');
      replacementSummary.text = 'Updated summary text';
      replacementSummary.metadata = { isCompactedSummary: true, version: 2 };

      applyCompressionSummaryToStore(
        sessionId,
        'summary-block-1',
        replacementSummary,
        []
      );

      const updatedSess = useSessionStore.getState().sessions[0];
      expect(updatedSess.messages).toHaveLength(2);
      expect(updatedSess.messages[0].id).toBe('summary-block-1');
      expect(updatedSess.messages[0].text).toBe('Updated summary text');
      expect(updatedSess.messages[0].metadata).toEqual({
        isCompactedSummary: true,
        version: 2,
      });
    });

    it('processes message filtering with hostile metadata without throwing or corrupting messages', () => {
      const circularMeta: Record<string, unknown> = {};
      circularMeta.self = circularMeta;

      // Note: getter that returns safely without throwing
      const safeGetterMeta = {
        get customProp() {
          return 'evaluated-safely';
        },
        isCompactedSummary: false,
      };

      const hostileMessages: SessionMessage[] = [
        createDummyMessage('msg-drop-1', 'will-be-dropped'),
        createDummyMessage('compacted-summary-old', {
          isCompactedSummary: true,
        }),
        createDummyMessage('msg-null-meta', null),
        createDummyMessage('msg-undef-meta', undefined),
        createDummyMessage('msg-number-meta', 42),
        createDummyMessage('msg-string-meta', 'unexpected string metadata'),
        createDummyMessage('msg-bool-meta', true),
        createDummyMessage('msg-symbol-meta', Symbol('meta')),
        createDummyMessage('msg-array-meta', ['a', 'b']),
        createDummyMessage('msg-empty-obj', {}),
        createDummyMessage('msg-null-proto', Object.create(null)),
        createDummyMessage('msg-circular', circularMeta),
        createDummyMessage('msg-falsy-flag', { isCompactedSummary: false }),
        createDummyMessage('msg-truthy-str-flag', {
          isCompactedSummary: 'true',
        }),
        createDummyMessage('msg-safe-getter', safeGetterMeta),
      ];

      const sess = createSession(sessionId, hostileMessages);
      useSessionStore.setState({
        sessions: [sess],
        sessionsById: { [sessionId]: sess },
      });

      const newSummary = createDummyMessage('summary-block-new');
      newSummary.metadata = { isCompactedSummary: true };

      expect(() => {
        applyCompressionSummaryToStore(
          sessionId,
          'summary-block-new',
          newSummary,
          ['msg-drop-1'] // droppedIds
        );
      }).not.toThrow();

      const resultMsgs = useSessionStore.getState().sessions[0].messages;

      // msg-drop-1 must be dropped
      expect(resultMsgs.some((m) => m.id === 'msg-drop-1')).toBe(false);

      // summary-block-new must be inserted before the first kept normal message
      const summaryIdx = resultMsgs.findIndex(
        (m) => m.id === 'summary-block-new'
      );
      expect(summaryIdx).toBeGreaterThanOrEqual(0);

      // compacted-summary-old should precede summary-block-new
      const oldSummaryIdx = resultMsgs.findIndex(
        (m) => m.id === 'compacted-summary-old'
      );
      expect(oldSummaryIdx).toBe(0);
      expect(summaryIdx).toBe(1);

      // All hostile metadata messages must be retained unharmed
      expect(resultMsgs.some((m) => m.id === 'msg-null-meta')).toBe(true);
      expect(resultMsgs.some((m) => m.id === 'msg-undef-meta')).toBe(true);
      expect(resultMsgs.some((m) => m.id === 'msg-number-meta')).toBe(true);
      expect(resultMsgs.some((m) => m.id === 'msg-circular')).toBe(true);
      expect(resultMsgs.some((m) => m.id === 'msg-null-proto')).toBe(true);
      expect(resultMsgs.some((m) => m.id === 'msg-safe-getter')).toBe(true);
    });

    it('demonstrates empirical behavior when a hostile getter throws on isCompactedSummary', () => {
      const explosiveMessage: SessionMessage = {
        id: 'msg-explosive',
        role: 'assistant',
        text: 'boom',
        timestamp: Date.now(),
        metadata: {
          get isCompactedSummary() {
            throw new Error(
              'Explosive getter on isCompactedSummary triggered!'
            );
          },
        },
      };

      const sess = createSession(sessionId, [explosiveMessage]);
      useSessionStore.setState({
        sessions: [sess],
        sessionsById: { [sessionId]: sess },
      });

      const newSummary = createDummyMessage('summary-block-boom');

      // Direct property access in JavaScript evaluates getters;
      // if hostile input defines a throwing getter on isCompactedSummary,
      // it throws during findIndex as expected in JS.
      expect(() => {
        applyCompressionSummaryToStore(
          sessionId,
          'summary-block-boom',
          newSummary,
          []
        );
      }).toThrow('Explosive getter on isCompactedSummary triggered!');

      // Verify transaction rollback: state.sessions is not corrupted in an intermediate half-written state
      const state = useSessionStore.getState().sessions[0];
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].id).toBe('msg-explosive');
    });

    it('demonstrates empirical behavior when Immer auto-freeze encounters a throwing getter on metadata', () => {
      const explosiveOtherProp: SessionMessage = {
        id: 'msg-explosive-other',
        role: 'assistant',
        text: 'boom-other',
        timestamp: Date.now(),
        metadata: {
          get otherProp() {
            throw new Error('Throwing getter evaluated by Immer freeze!');
          },
          isCompactedSummary: false,
        },
      };

      const sess = createSession(sessionId, [explosiveOtherProp]);
      useSessionStore.setState({
        sessions: [sess],
        sessionsById: { [sessionId]: sess },
      });

      const newSummary = createDummyMessage('summary-block-freeze');

      // Immer recursively freezes all enumerable properties of state objects upon commit;
      // any throwing enumerable getter on metadata will trigger during freeze.
      expect(() => {
        applyCompressionSummaryToStore(
          sessionId,
          'summary-block-freeze',
          newSummary,
          []
        );
      }).toThrow('Throwing getter evaluated by Immer freeze!');
    });

    it('empirically verifies rebindSessionById synchronizes sessionsById in applyCompressionSummaryToStore', () => {
      const existingSummary = createDummyMessage('summary-block-1');
      existingSummary.text = 'Initial summary text';
      const normalMsg = createDummyMessage('normal-msg-1');

      const sess = createSession(sessionId, [existingSummary, normalMsg]);
      useSessionStore.setState({
        sessions: [sess],
        sessionsById: { [sessionId]: sess },
      });

      const replacementSummary = createDummyMessage('summary-block-1');
      replacementSummary.text = 'Updated summary text';
      replacementSummary.metadata = { isCompactedSummary: true, version: 2 };

      applyCompressionSummaryToStore(
        sessionId,
        'summary-block-1',
        replacementSummary,
        []
      );

      const state = useSessionStore.getState();

      // Canonical sessions[] is updated:
      expect(state.sessions[0].messages[0].text).toBe('Updated summary text');

      // sessionsById map is rebound via rebindSessionById(state, sessionId, sess)
      // to ensure sessionsById synchronizes with canonical sessions[].
      expect(state.sessionsById[sessionId]?.messages?.[0]?.text).toBe(
        'Updated summary text'
      );
    });
  });
});
