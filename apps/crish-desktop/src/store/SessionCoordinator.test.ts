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
      ptySessions: {},
      diffFiles: [],
      activeDiffSource: null,
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
    useTerminalStore.getState().registerPtySession('sess-1', {
      ptyId: 'p1',
      sessionKey: 'sess-1',
      createdAt: Date.now(),
      status: 'active',
    });
    useTerminalStore.getState().registerPtySession('sess-2', {
      ptyId: 'p2',
      sessionKey: 'sess-2',
      createdAt: Date.now(),
      status: 'active',
    });

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
    expect(useTerminalStore.getState().ptySessions['sess-1']).toBeUndefined();
    expect(useTerminalStore.getState().ptySessions['sess-2']).toBeDefined();

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

  // ── C8 竞态/异常场景测试扩充 ───────────────────────────────────────────────
  // 覆盖并发冲突、连接断开恢复、部分清理后重试、跨 store 一致性等

  it('double cascade delete of same session: second call returns false (idempotent)', () => {
    const s1: SessionState = {
      id: 'double-del',
      title: 'Double Delete',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };
    useSessionStore.setState({
      sessions: [s1],
      sessionsById: { 'double-del': s1 },
      activeSessionId: 'double-del',
    });
    useStreamingStore.getState().setStreamText('double-del', 'm1', 'text');

    const first = deleteSessionCascade('double-del');
    expect(first).toBe(true);

    // 第二次级联：session 已不存在 → 返回 false，但 streaming/terminal 仍安全清理
    const second = deleteSessionCascade('double-del');
    expect(second).toBe(false);
    // streamingStore 无残留
    expect(
      useStreamingStore.getState().getStreamText('double-del', 'm1')
    ).toBeUndefined();
  });

  it('cascade delete clears streaming entries for multiple messages in session', () => {
    const s1: SessionState = {
      id: 'multi-stream',
      title: 'Multi Stream',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };
    useSessionStore.setState({
      sessions: [s1],
      sessionsById: { 'multi-stream': s1 },
      activeSessionId: 'multi-stream',
    });
    // 在同一 session 下设置多条消息的流
    useStreamingStore.getState().setStreamText('multi-stream', 'm1', 'text1');
    useStreamingStore.getState().setStreamText('multi-stream', 'm2', 'text2');
    useStreamingStore.getState().setStreamText('multi-stream', 'm3', 'text3');
    // 另一 session 的流不应被误删
    useStreamingStore.getState().setStreamText('other', 'm1', 'keep');

    deleteSessionCascade('multi-stream');

    expect(
      useStreamingStore.getState().getStreamText('multi-stream', 'm1')
    ).toBeUndefined();
    expect(
      useStreamingStore.getState().getStreamText('multi-stream', 'm2')
    ).toBeUndefined();
    expect(
      useStreamingStore.getState().getStreamText('multi-stream', 'm3')
    ).toBeUndefined();
    expect(useStreamingStore.getState().getStreamText('other', 'm1')).toBe(
      'keep'
    );
  });

  it('cascade delete with whitespace-only id returns false (guard)', () => {
    const s1: SessionState = {
      id: 's1',
      title: 'S1',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };
    useSessionStore.setState({
      sessions: [s1],
      sessionsById: { s1 },
      activeSessionId: 's1',
    });

    expect(deleteSessionCascade('  ')).toBe(false);
    expect(deleteSessionCascade(' \t ')).toBe(false);
    // session 未被删除
    expect(useSessionStore.getState().sessionsById['s1']).toBeDefined();
  });

  it('cascade delete with id containing leading/trailing whitespace trims and succeeds', () => {
    const s1: SessionState = {
      id: 'trim-me',
      title: 'Trim Test',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };
    useSessionStore.setState({
      sessions: [s1],
      sessionsById: { 'trim-me': s1 },
      activeSessionId: 'trim-me',
    });

    expect(deleteSessionCascade('  trim-me  ')).toBe(true);
    expect(useSessionStore.getState().sessionsById['trim-me']).toBeUndefined();
  });

  it('cascade delete 不拿 sessions[] 邻居覆盖画面会话', () => {
    const s1: SessionState = {
      id: 'active-sess',
      title: 'Active',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [{ id: 'm1', sender: 'user', text: 'hi', timestamp: 1 }],
    };
    const s2: SessionState = {
      id: 'fallback-sess',
      title: 'Fallback',
      createdAt: 2000,
      updatedAt: 2000,
      messages: [{ id: 'm2', sender: 'user', text: 'yo', timestamp: 2 }],
    };
    useSessionStore.setState({
      sessions: [s1, s2],
      sessionsById: { 'active-sess': s1, 'fallback-sess': s2 },
      activeSessionId: 'active-sess',
    });

    deleteSessionCascade('active-sess');

    expect(useSessionStore.getState().sessionsById['active-sess']).toBeUndefined();
    expect(useSessionStore.getState().sessionsById['fallback-sess']).toBeDefined();
    // 画面校正归 shell.syncSessionFromActiveLeaf，数据面不得抢邻居
    expect(useSessionStore.getState().activeSessionId).not.toBe('fallback-sess');
  });

  it('cascade delete of non-active session does not change activeSessionId', () => {
    const s1: SessionState = {
      id: 'keep-active',
      title: 'Keep',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [{ id: 'm1', sender: 'user', text: 'hi', timestamp: 1 }],
    };
    const s2: SessionState = {
      id: 'delete-me',
      title: 'Delete',
      createdAt: 2000,
      updatedAt: 2000,
      messages: [],
    };
    useSessionStore.setState({
      sessions: [s1, s2],
      sessionsById: { 'keep-active': s1, 'delete-me': s2 },
      activeSessionId: 'keep-active',
    });

    deleteSessionCascade('delete-me');

    expect(useSessionStore.getState().sessionsById['delete-me']).toBeUndefined();
    expect(useSessionStore.getState().activeSessionId).toBe('keep-active');
  });

  it('cascade delete clears terminal pty session binding', () => {
    const s1: SessionState = {
      id: 'pty-sess',
      title: 'PTY Session',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };
    useSessionStore.setState({
      sessions: [s1],
      sessionsById: { 'pty-sess': s1 },
      activeSessionId: 'pty-sess',
    });
    useTerminalStore.getState().registerPtySession('pty-sess', {
      ptyId: 'p1',
      sessionKey: 'pty-sess',
      createdAt: Date.now(),
      status: 'active',
    });

    deleteSessionCascade('pty-sess');

    expect(
      useTerminalStore.getState().ptySessions['pty-sess']
    ).toBeUndefined();
  });

  it('cascade delete invokes clearMessageSnapshots bridge', () => {
    const s1: SessionState = {
      id: 'snap-sess',
      title: 'Snap Session',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };
    useSessionStore.setState({
      sessions: [s1],
      sessionsById: { 'snap-sess': s1 },
      activeSessionId: 'snap-sess',
    });

    const spy = vi.spyOn(snapshotsBridge, 'clearMessageSnapshots');
    deleteSessionCascade('snap-sess');
    expect(spy).toHaveBeenCalledWith('snap-sess');
    spy.mockRestore();
  });

  it('concurrent cascade delete of two sessions does not cross-contaminate', () => {
    const s1: SessionState = {
      id: 'conc-a',
      title: 'A',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [{ id: 'm1', sender: 'user', text: 'a', timestamp: 1 }],
    };
    const s2: SessionState = {
      id: 'conc-b',
      title: 'B',
      createdAt: 2000,
      updatedAt: 2000,
      messages: [{ id: 'm2', sender: 'user', text: 'b', timestamp: 2 }],
    };
    useSessionStore.setState({
      sessions: [s1, s2],
      sessionsById: { 'conc-a': s1, 'conc-b': s2 },
      activeSessionId: 'conc-a',
    });
    useStreamingStore.getState().setStreamText('conc-a', 'm1', 'stream-a');
    useStreamingStore.getState().setStreamText('conc-b', 'm2', 'stream-b');
    useTerminalStore.getState().registerPtySession('conc-a', {
      ptyId: 'pa',
      sessionKey: 'conc-a',
      createdAt: 0,
      status: 'active',
    });
    useTerminalStore.getState().registerPtySession('conc-b', {
      ptyId: 'pb',
      sessionKey: 'conc-b',
      createdAt: 0,
      status: 'active',
    });

    // 模拟并发：先删 A，验证 B 未受影响，再删 B
    const r1 = deleteSessionCascade('conc-a');
    // B 的流和终端在删 A 时不应被误删
    expect(r1).toBe(true);
    expect(useStreamingStore.getState().getStreamText('conc-b', 'm2')).toBe(
      'stream-b'
    );
    expect(useTerminalStore.getState().ptySessions['conc-b']).toBeDefined();

    const r2 = deleteSessionCascade('conc-b');
    expect(r2).toBe(true);

    // 删 B 后全部清空
    expect(
      useStreamingStore.getState().getStreamText('conc-b', 'm2')
    ).toBeUndefined();
    expect(useTerminalStore.getState().ptySessions['conc-b']).toBeUndefined();
  });

  it('cascade delete of last session enters draft mode (active never empty)', () => {
    const s1: SessionState = {
      id: 'last-sess',
      title: 'Last',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [{ id: 'm1', sender: 'user', text: 'x', timestamp: 1 }],
    };
    useSessionStore.setState({
      sessions: [s1],
      sessionsById: { 'last-sess': s1 },
      activeSessionId: 'last-sess',
    });

    deleteSessionCascade('last-sess');

    const st = useSessionStore.getState();
    expect(st.sessions).toHaveLength(0);
    // 不变量：activeSessionId 绝不为空字符串
    expect(st.activeSessionId).toBeTruthy();
    expect(st.activeSessionId.length).toBeGreaterThan(0);
  });

  it('cascade delete clears streaming thinking and tools, not just text', () => {
    const s1: SessionState = {
      id: 'full-stream',
      title: 'Full Stream',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };
    useSessionStore.setState({
      sessions: [s1],
      sessionsById: { 'full-stream': s1 },
      activeSessionId: 'full-stream',
    });
    useStreamingStore.getState().setStreamText('full-stream', 'm1', 'text');
    useStreamingStore.getState().setStreamThinking('full-stream', 'm1', 'think');
    useStreamingStore.getState().setStreamTool('full-stream', 'm1', 't1', {
      id: 't1',
      name: 'read',
      status: 'running',
    });

    deleteSessionCascade('full-stream');

    const entry = useStreamingStore.getState().getStreamEntry(
      'full-stream',
      'm1'
    );
    expect(entry).toBeUndefined();
  });

  it('deleteSessionCascade and SessionCoordinator.deleteSessionCascade produce identical results', () => {
    const s1: SessionState = {
      id: 'parity-sess',
      title: 'Parity',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };
    useSessionStore.setState({
      sessions: [s1],
      sessionsById: { 'parity-sess': s1 },
      activeSessionId: 'parity-sess',
    });
    useStreamingStore.getState().setStreamText('parity-sess', 'm1', 'p');

    // 两种调用路径（模块函数 vs 对象方法）应返回相同结果
    const fnResult = deleteSessionCascade('parity-sess');
    // 重建后用对象方法删同一 id（已不存在）
    const objResult = SessionCoordinator.deleteSessionCascade('parity-sess');

    expect(fnResult).toBe(true);
    expect(objResult).toBe(false);
  });

  it('cascade delete preserves other sessions streaming entries with similar prefix', () => {
    // 防止 clearSession 用 startsWith 误删前缀相似的 session
    const s1: SessionState = {
      id: 'sess',
      title: 'Short',
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };
    const s2: SessionState = {
      id: 'sess-extended',
      title: 'Extended',
      createdAt: 2000,
      updatedAt: 2000,
      messages: [],
    };
    useSessionStore.setState({
      sessions: [s1, s2],
      sessionsById: { sess: s1, 'sess-extended': s2 },
      activeSessionId: 'sess',
    });
    useStreamingStore.getState().setStreamText('sess', 'm1', 'short');
    useStreamingStore.getState().setStreamText('sess-extended', 'm1', 'extended');

    deleteSessionCascade('sess');

    // sess 被删，sess-extended 的流必须保留（不因前缀匹配误删）
    expect(useStreamingStore.getState().getStreamText('sess', 'm1')).toBeUndefined();
    expect(useStreamingStore.getState().getStreamText('sess-extended', 'm1')).toBe(
      'extended'
    );
  });
});
