import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, SessionState } from './types';
import {
  BootHoldBarrier,
  DeltaWriteBarrier,
  EmptySanitizeBarrier,
  performThreeWaySessionMerge,
  syncOrthogonalSessionSubtrees,
  type PersistableStoreState,
} from './store-persistence';
import { initStorePersistence } from './layout-helpers/store-persistence';
import {
  isSessionTombstoned,
  markSessionTombstone,
  sessionCascadeCancellation,
} from './sessionCascadeCancellation';
import {
  createPreHydrationQueue,
  UnifiedAppHydrationCoordinator,
} from '../app/UnifiedAppHydrationCoordinator';

const mockPersistAllSessions = vi.fn(() => Promise.resolve());
const mockHydrateSessionsFromRust = vi.fn();
const mockEnsureMigrated = vi.fn(() => Promise.resolve());
const mockRunMigrationCleanupIfNeeded = vi.fn(() => Promise.resolve());

vi.mock('../api/appMode', () => ({
  isDemoMode: () => false,
}));

vi.mock('../api/sessionPersistence', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../api/sessionPersistence')>();
  return {
    ...actual,
    ensureMigrated: () => mockEnsureMigrated(),
    hydrateSessionsFromRust: () => mockHydrateSessionsFromRust(),
    persistAllSessions: (...args: unknown[]) => mockPersistAllSessions(...args),
    runMigrationCleanupIfNeeded: () => mockRunMigrationCleanupIfNeeded(),
  };
});

function makeMessage(id: string, content: string, timestamp = 1000): Message {
  return {
    id,
    role: 'user',
    content,
    timestamp: String(timestamp),
  };
}

function makeSession(
  id: string,
  title: string,
  messages: Message[] = [],
  overrides: Partial<SessionState> = {}
): SessionState {
  return {
    id,
    title,
    messages,
    agents: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  } as SessionState;
}

describe('Stage 10 · 3-Way Session Merge & Triple Write Barrier', () => {
  beforeEach(() => {
    sessionCascadeCancellation.tombstoneSessionIds.clear();
    vi.clearAllMocks();
  });

  describe('performThreeWaySessionMerge (O(|L| + |R|) Set-Theoretic Merge)', () => {
    it('preserves newly created local sessions AND restores all 50 SQLite historical sessions on slow disk', () => {
      const localNew = makeSession('local-new-1', 'New Local Session', [
        makeMessage('m-local-1', 'hello world'),
      ]);
      const remoteHistory: SessionState[] = Array.from({ length: 50 }, (_, i) =>
        makeSession(`disk-hist-${i + 1}`, `Historical #${i + 1}`, [
          makeMessage(`m-disk-${i + 1}`, `saved content ${i + 1}`),
        ])
      );

      const result = performThreeWaySessionMerge([], [localNew], remoteHistory);

      expect(result.mergedSessions).toHaveLength(51);
      expect(result.preservedLocalNewCount).toBe(1);
      expect(result.addedFromRemoteCount).toBe(50);
      expect(result.mergedSessions[0]?.id).toBe('local-new-1');
      expect(result.mergedById['local-new-1']?.messages).toHaveLength(1);
      expect(result.mergedById['disk-hist-50']?.title).toBe('Historical #50');
    });

    it('supports both 2/3-argument and 4-argument overload signatures seamlessly', () => {
      const sLocal = makeSession('s-1', 'Local S1', []);
      const sRemote1 = makeSession('s-1', 'Remote S1', [
        makeMessage('m-1', 'from disk'),
      ]);
      const sRemote2 = makeSession('s-2', 'Remote S2', [
        makeMessage('m-2', 'also from disk'),
      ]);

      const res2Arg = performThreeWaySessionMerge(
        [sLocal],
        [sRemote1, sRemote2]
      );
      expect(res2Arg.mergedSessions).toHaveLength(2);
      expect(res2Arg.filledBodiesCount).toBe(1);
      expect(res2Arg.addedFromRemoteCount).toBe(1);
      expect(res2Arg.mergedById['s-1']?.messages).toHaveLength(1);
    });

    it('merges overlapping sessions with causal message deduplication when both local and remote have messages', () => {
      const m1 = makeMessage('msg-1', 'history 1', 100);
      const m2 = makeMessage('msg-2', 'history 2', 200);
      const m3 = makeMessage('msg-3', 'new user prompt during boot', 300);

      const localSession = makeSession('shared-session', 'Updated Title', [
        m1,
        m3,
      ]);
      const remoteSession = makeSession('shared-session', 'Old Title', [
        m1,
        m2,
      ]);

      const result = performThreeWaySessionMerge(
        ['shared-session'],
        [localSession],
        [remoteSession]
      );

      expect(result.mergedSessions).toHaveLength(1);
      const merged = result.mergedById['shared-session'];
      expect(merged).toBeDefined();
      expect(merged?.title).toBe('Updated Title');
      expect(merged?.messages.map((m) => m.id)).toEqual([
        'msg-1',
        'msg-2',
        'msg-3',
      ]);
      expect(result.filledBodiesCount).toBe(1);
    });

    it('filters out tombstoned sessions from both local and remote sets to prevent zombie resurrection', () => {
      markSessionTombstone('deleted-session-1');
      markSessionTombstone('deleted-session-2');

      const localSessions = [
        makeSession('deleted-session-1', 'Zombie Local'),
        makeSession('active-local', 'Active Local'),
      ];
      const remoteSessions = [
        makeSession('deleted-session-1', 'Zombie Remote 1'),
        makeSession('deleted-session-2', 'Zombie Remote 2'),
        makeSession('active-remote', 'Active Remote'),
      ];

      const result = performThreeWaySessionMerge(
        [],
        localSessions,
        remoteSessions,
        isSessionTombstoned
      );

      expect(result.mergedSessions.map((s) => s.id)).toEqual([
        'active-local',
        'active-remote',
      ]);
      expect(result.mergedById['deleted-session-1']).toBeUndefined();
      expect(result.mergedById['deleted-session-2']).toBeUndefined();
      expect(result.skippedTombstonedCount).toBeGreaterThanOrEqual(2);
    });

    it('does not resurrect sessions that were present in baseIds (B) and deleted from localSessions (L)', () => {
      const baseIds = new Set(['s-base-deleted', 's-base-kept']);
      const localSessions = [makeSession('s-base-kept', 'Kept')];
      const remoteSessions = [
        makeSession('s-base-deleted', 'Deleted in L'),
        makeSession('s-base-kept', 'Kept'),
        makeSession('s-remote-only', 'Historical Not In Base'),
      ];

      const result = performThreeWaySessionMerge(
        baseIds,
        localSessions,
        remoteSessions
      );

      expect(result.mergedSessions.map((s) => s.id)).toEqual([
        's-base-kept',
        's-remote-only',
      ]);
      expect(result.skippedTombstonedCount).toBe(1);
    });
  });

  describe('Triple Write Barrier (BootHoldBarrier / DeltaWriteBarrier / EmptySanitizeBarrier)', () => {
    it('BootHoldBarrier holds persistence while hydrationComplete is false', () => {
      expect(BootHoldBarrier.shouldHold({ hydrationComplete: false })).toBe(
        true
      );
      expect(BootHoldBarrier.shouldHold({ hydrationComplete: true })).toBe(
        false
      );
    });

    it('DeltaWriteBarrier detects single-session dirty mutations and skips no-op writes', () => {
      const barrier = new DeltaWriteBarrier();
      const s1 = makeSession('s1', 'Session 1', [makeMessage('m1', 'hi')]);
      const s2 = makeSession('s2', 'Session 2', [makeMessage('m2', 'yo')]);

      barrier.seedFromSessions([s1, s2], 's1', ['folder-a']);

      // Unchanged state -> hasChanges: false
      const noOpDelta = barrier.computeDelta([s1, s2], 's1', ['folder-a']);
      expect(noOpDelta.hasChanges).toBe(false);
      expect(noOpDelta.dirtySessionIds).toEqual([]);

      // Mutate only s2 -> dirtySessionIds === ['s2']
      const s2Modified = makeSession('s2', 'Session 2', [
        makeMessage('m2', 'yo'),
        makeMessage('m3', 'new reply'),
      ]);
      const dirtyDelta = barrier.computeDelta([s1, s2Modified], 's1', [
        'folder-a',
      ]);
      expect(dirtyDelta.hasChanges).toBe(true);
      expect(dirtyDelta.dirtySessionIds).toEqual(['s2']);
      expect(dirtyDelta.removedSessionIds).toEqual([]);
    });

    it('EmptySanitizeBarrier blocks empty session array overwrite unless all persisted sessions are tombstoned', () => {
      const knownIds = new Set(['s-persisted-1', 's-persisted-2']);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(EmptySanitizeBarrier.shouldBlockEmptyWrite([], knownIds)).toBe(
        true
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('FATAL_CORRUPTION_GUARD')
      );

      // If user explicitly tombstoned all known sessions, empty write is permitted
      markSessionTombstone('s-persisted-1');
      markSessionTombstone('s-persisted-2');
      expect(EmptySanitizeBarrier.shouldBlockEmptyWrite([], knownIds)).toBe(
        false
      );

      warnSpy.mockRestore();
    });
  });

  describe('initStorePersistence Slow-Disk Race Integration', () => {
    it('merges local session created during boot window with delayed SQLite historical sessions without data loss', async () => {
      let resolveHydrate!: (val: {
        sessions: SessionState[];
        activeSessionId: string;
        folderOrder: string[];
      }) => void;
      mockHydrateSessionsFromRust.mockReturnValueOnce(
        new Promise((r) => {
          resolveHydrate = r;
        })
      );

      const listeners = new Set<(state: PersistableStoreState) => void>();
      const state: PersistableStoreState = {
        sessions: [],
        sessionsById: {},
        activeSessionId: '',
        folderOrder: [],
        hydrationComplete: false,
        activeAgentId: null,
        panelAgentId: null,
        metaById: {},
        messagesBySessionId: {},
        agentsBySessionId: {},
        sessionOrder: [],
      };

      const store = {
        getState: () => state,
        setState: (
          updater:
            | PersistableStoreState
            | Partial<PersistableStoreState>
            | ((s: PersistableStoreState) => void)
        ) => {
          if (typeof updater === 'function') {
            updater(state);
          } else {
            Object.assign(state, updater);
          }
          for (const l of listeners) l(state);
        },
        subscribe: (l: (s: PersistableStoreState) => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        setActiveSessionId: vi.fn((id: string) => {
          state.activeSessionId = id;
        }),
      };

      const cleanup = initStorePersistence(store);

      // User creates a new session BEFORE SQLite responds
      const fastLocal = makeSession('fast-local-session', 'Created At Boot', [
        makeMessage('m-fast', 'quick question'),
      ]);
      store.setState((s) => {
        s.sessions = [fastLocal];
        s.sessionsById = { [fastLocal.id]: fastLocal };
        s.activeSessionId = fastLocal.id;
        syncOrthogonalSessionSubtrees(s, s.sessions);
      });

      // BootHoldBarrier must hold persistence while hydrationComplete === false
      expect(mockPersistAllSessions).not.toHaveBeenCalled();

      // Now slow SQLite responds with 3 historical sessions
      resolveHydrate({
        sessions: [
          makeSession('hist-1', 'History 1', [makeMessage('mh1', 'old 1')]),
          makeSession('hist-2', 'History 2', [makeMessage('mh2', 'old 2')]),
          makeSession('hist-3', 'History 3', [makeMessage('mh3', 'old 3')]),
        ],
        activeSessionId: 'hist-1',
        folderOrder: ['work'],
      });

      await new Promise((r) => setTimeout(r, 30));

      expect(state.hydrationComplete).toBe(true);
      expect(state.sessions.map((s) => s.id)).toEqual([
        'fast-local-session',
        'hist-1',
        'hist-2',
        'hist-3',
      ]);
      expect(state.sessionOrder).toEqual([
        'fast-local-session',
        'hist-1',
        'hist-2',
        'hist-3',
      ]);
      expect(state.messagesBySessionId?.['hist-2']?.[0]?.content).toBe('old 2');
      expect(mockPersistAllSessions).toHaveBeenCalledTimes(1);

      cleanup();
    });
  });

  describe('Pre-Hydration Bounded Ring Queue (Capacity 32 & Causal Replay)', () => {
    it('enforces strict ring buffer capacity of 32 and replays in causal timestamp order', () => {
      const queue = createPreHydrationQueue(32);

      for (let i = 1; i <= 40; i += 1) {
        queue.push({
          type: 'click',
          action: `action-${i}`,
          timestamp: i === 35 ? 5 : i * 10,
        });
      }

      expect(queue.events).toHaveLength(32);
      expect(queue.droppedCount).toBe(8);

      const replayed: string[] = [];
      const drained = queue.release((events) => {
        for (const e of events) {
          if (e.action) replayed.push(e.action);
        }
      });

      expect(drained).toHaveLength(32);
      // action-35 had timestamp 5, so causal sorting places it first among retained events (9..40)
      expect(replayed[0]).toBe('action-35');
      expect(replayed[1]).toBe('action-9');
      expect(replayed[replayed.length - 1]).toBe('action-40');
      expect(queue.events).toHaveLength(0);
    });

    it('replays global __CRISH_PRE_HYDRATION_QUEUE__ via UnifiedAppHydrationCoordinator', () => {
      UnifiedAppHydrationCoordinator.resetInstanceForTests();
      const coordinator = UnifiedAppHydrationCoordinator.getInstance();
      const queue = createPreHydrationQueue(32);
      queue.push({ type: 'keydown', action: 'new-session', timestamp: 20 });
      queue.push({ type: 'focusin', action: 'focus-composer', timestamp: 10 });

      (
        window as unknown as {
          __CRISH_PRE_HYDRATION_QUEUE__?: ReturnType<
            typeof createPreHydrationQueue
          >;
        }
      ).__CRISH_PRE_HYDRATION_QUEUE__ = queue;

      const actions: string[] = [];
      const drained = coordinator.replayPreHydrationQueue((evt) => {
        if (evt.action) actions.push(evt.action);
      });

      expect(drained).toHaveLength(2);
      expect(actions).toEqual(['focus-composer', 'new-session']);
    });
  });
});
