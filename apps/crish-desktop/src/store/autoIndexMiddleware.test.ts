import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  withAutoIndex,
  sessionsIdKey,
  buildSessionsMap,
  type SessionsAwareState,
} from './autoIndexMiddleware';

type TestSession = { id: string; title: string; n?: number };

type TestState = SessionsAwareState & {
  sessions: TestSession[];
  sessionsById: Record<string, TestSession>;
  bump: number;
  addSession: (s: TestSession) => void;
  renameSession: (id: string, title: string) => void;
  replaceSessionsArrayOnly: () => void;
  removeSession: (id: string) => void;
  bumpOnly: () => void;
};

function createTestStore(initial: TestSession[] = []) {
  return create<TestState>()(
    withAutoIndex(
      immer((set) => ({
        sessions: initial,
        sessionsById: buildSessionsMap(initial) as Record<string, TestSession>,
        bump: 0,
        addSession: (s) =>
          set((state) => {
            state.sessions.push(s);
            // 故意不写 sessionsById — 交给 middleware 在 id 集合变化时重建
          }),
        renameSession: (id, title) =>
          set((state) => {
            const hit = state.sessions.find((x) => x.id === id);
            if (hit) hit.title = title;
            // 同 id 集合：middleware 不应重建 map
          }),
        replaceSessionsArrayOnly: () =>
          set((state) => {
            // 同 id 列表，仅换数组引用（模拟 message-actions 的 sync 模式）
            state.sessions = [...state.sessions];
          }),
        removeSession: (id) =>
          set((state) => {
            state.sessions = state.sessions.filter((x) => x.id !== id);
          }),
        bumpOnly: () =>
          set((state) => {
            state.bump += 1;
          }),
      }))
    )
  );
}

describe('withAutoIndex', () => {
  it('sessionsIdKey is order-sensitive and skips empty ids', () => {
    expect(sessionsIdKey([{ id: 'a' }, { id: 'b' }])).toBe('a\0b');
    expect(sessionsIdKey([{ id: 'b' }, { id: 'a' }])).toBe('b\0a');
    expect(sessionsIdKey([{ id: '' }, { id: 'a' }])).toBe('a');
  });

  it('rebuilds sessionsById when a session is added (id set change)', () => {
    const store = createTestStore([{ id: 'a', title: 'A' }]);
    expect(store.getState().sessionsById.a?.title).toBe('A');
    expect(store.getState().sessionsById.b).toBeUndefined();

    store.getState().addSession({ id: 'b', title: 'B' });

    const st = store.getState();
    expect(st.sessions.map((s) => s.id)).toEqual(['a', 'b']);
    expect(st.sessionsById.b?.title).toBe('B');
    // 与数组元素同一引用
    expect(st.sessionsById.b).toBe(st.sessions[1]);
  });

  it('rebuilds sessionsById when a session is removed', () => {
    const store = createTestStore([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ]);
    store.getState().removeSession('a');
    const st = store.getState();
    expect(st.sessionsById.a).toBeUndefined();
    expect(st.sessionsById.b?.title).toBe('B');
  });

  it('rebinds sessionsById values when only session content changes', () => {
    const store = createTestStore([{ id: 'a', title: 'A' }]);

    store.getState().renameSession('a', 'A2');

    const st = store.getState();
    // id 集合未变，但 map 值必须指向当前 sessions 元素（非陈旧对象）
    expect(st.sessionsById.a?.title).toBe('A2');
    expect(st.sessionsById.a).toBe(st.sessions.find((s) => s.id === 'a'));
  });

  it('does not rebuild when sessions array ref changes but id set is unchanged', () => {
    const store = createTestStore([{ id: 'a', title: 'A' }]);
    const mapBefore = store.getState().sessionsById;

    store.getState().replaceSessionsArrayOnly();

    expect(store.getState().sessionsById).toStrictEqual(mapBefore);
  });

  it('does not rebuild on unrelated field updates', () => {
    const store = createTestStore([{ id: 'a', title: 'A' }]);
    const mapBefore = store.getState().sessionsById;
    store.getState().bumpOnly();
    expect(store.getState().sessionsById).toBe(mapBefore);
    expect(store.getState().bump).toBe(1);
  });

  it('notifies subscribers of sessionsById when id set changes (no silent mutation)', () => {
    const store = createTestStore([{ id: 'a', title: 'A' }]);
    const seen: string[][] = [];
    const unsub = store.subscribe((s) => {
      seen.push(Object.keys(s.sessionsById).sort());
    });

    store.getState().addSession({ id: 'b', title: 'B' });
    unsub();

    expect(seen.length).toBe(1);
    const last = seen[seen.length - 1]!;
    expect(last).toEqual(['a', 'b']);
  });

  it('dispatches atomically in a single notification without double dispatch', () => {
    const store = createTestStore([{ id: 'a', title: 'A' }]);
    let callCount = 0;
    const unsub = store.subscribe(() => {
      callCount += 1;
      const state = store.getState();
      // On every single dispatch, sessions and sessionsById must be in sync
      expect(state.sessions.length).toBe(
        Object.keys(state.sessionsById).length
      );
      expect(state.sessionsById.b?.title).toBe('B');
    });

    store.getState().addSession({ id: 'b', title: 'B' });
    unsub();

    expect(callCount).toBe(1);
  });
});
