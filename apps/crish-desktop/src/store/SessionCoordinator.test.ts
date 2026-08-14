import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SessionCoordinator, deleteSessionCascade } from './SessionCoordinator';
import { useSessionStore } from './sessionStore';
import { useStreamingStore } from './streamingStore';
import { useTerminalStore } from './terminalStore';
import * as snapshotsBridge from './messageSnapshotsBridge';
import type { SessionState } from './types';

describe('SessionCoordinator', () => {
  beforeEach(() => {
    // Reset stores
    useStreamingStore.setState({ byKey: {} });
    useTerminalStore.setState({
      terminalBySession: {},
      terminalLines: [],
      activeTerminalSessionId: null,
    });
  });

  it('cascades deletion across sessionStore, streamingStore, snapshots, and terminalStore', () => {
    const s1: SessionState = {
      id: 'sess-1',
      title: 'Session 1',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };
    const s2: SessionState = {
      id: 'sess-2',
      title: 'Session 2',
      createdAt: 2000,
      updatedAt: 2000,
      messages: [],
    };

    // 1. Setup sessionStore
    useSessionStore.setState({
      sessions: [s1, s2],
      sessionsById: { 'sess-1': s1, 'sess-2': s2 },
      activeSessionId: 'sess-1',
    });

    // 2. Setup streamingStore
    useStreamingStore.getState().setStreamText('sess-1', 'm1', 'Stream text 1');
    useStreamingStore.getState().setStreamText('sess-2', 'm2', 'Stream text 2');

    // 3. Setup terminalStore
    useTerminalStore.getState().addTerminalLine('Line in sess 1', 'sess-1');
    useTerminalStore.getState().addTerminalLine('Line in sess 2', 'sess-2');

    // 4. Spy on messageSnapshotsBridge
    const clearSnapshotsSpy = vi.spyOn(
      snapshotsBridge,
      'clearMessageSnapshots'
    );

    // 5. Execute cascade deletion
    const deleted = deleteSessionCascade('sess-1');

    expect(deleted).toBe(true);

    // Assert sessionStore cleaned
    const remainingSessions = useSessionStore.getState().sessions;
    expect(remainingSessions.map((s) => s.id)).toEqual(['sess-2']);
    expect(useSessionStore.getState().sessionsById['sess-1']).toBeUndefined();

    // Assert streamingStore cleaned
    expect(
      useStreamingStore.getState().getStreamText('sess-1', 'm1')
    ).toBeUndefined();
    expect(useStreamingStore.getState().getStreamText('sess-2', 'm2')).toBe(
      'Stream text 2'
    );

    // Assert terminalStore cleaned
    expect(
      useTerminalStore.getState().terminalBySession['sess-1']
    ).toBeUndefined();
    expect(
      useTerminalStore.getState().terminalBySession['sess-2']
    ).toBeDefined();

    // Assert snapshots bridge called
    expect(clearSnapshotsSpy).toHaveBeenCalledWith('sess-1');

    clearSnapshotsSpy.mockRestore();
  });

  it('sessionStore.deleteSession 生产路径直接触发 streamingStore 级联清理 (A-07)', () => {
    const s1: SessionState = {
      id: 'sess-cascade-1',
      title: 'Session Cascade',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };
    useSessionStore.setState({
      sessions: [s1],
      sessionsById: { 'sess-cascade-1': s1 },
      activeSessionId: 'sess-cascade-1',
    });

    useStreamingStore
      .getState()
      .setStreamText('sess-cascade-1', 'm1', 'Ghost stream to clean');

    expect(
      useStreamingStore.getState().getStreamText('sess-cascade-1', 'm1')
    ).toBe('Ghost stream to clean');

    const removed = useSessionStore.getState().deleteSession('sess-cascade-1');
    expect(removed).toBe(true);

    // streamingStore 中对应会话的流被彻底清空
    expect(
      useStreamingStore.getState().getStreamText('sess-cascade-1', 'm1')
    ).toBeUndefined();
    expect(
      Object.keys(useStreamingStore.getState().byKey).filter((k) =>
        k.startsWith('sess-cascade-1::')
      ).length
    ).toBe(0);
  });

  it('handles empty and non-existent session ids gracefully', () => {
    expect(SessionCoordinator.deleteSessionCascade('')).toBe(false);
    expect(SessionCoordinator.deleteSessionCascade('non-existent-id')).toBe(
      false
    );
  });
});
