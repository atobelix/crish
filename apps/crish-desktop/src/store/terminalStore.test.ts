/**
 * terminalStore 单测：PTY 会话元数据注册表 + diff 缓冲 coherence（DIM-07）。
 * 操作全局 singleton 后复位，避免污染其他域 store 测试。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  useTerminalStore,
  type TerminalStore,
  type PtySessionMeta,
} from './terminalStore';
import type { FileDiff } from './types';

function makeDiff(filePath: string): FileDiff {
  return {
    filePath,
    additions: 1,
    deletions: 0,
    changes: [{ type: 'addition', content: '+x' }],
  };
}

function makePtyMeta(sessionKey: string, ptyId: string): PtySessionMeta {
  return {
    ptyId,
    sessionKey,
    createdAt: Date.now(),
    status: 'active',
  };
}

beforeEach(() => {
  useTerminalStore.setState({
    ptySessions: {},
    diffFiles: [],
    activeDiffSource: null,
  });
});

describe('terminalStore — PTY sessions & isolation', () => {
  it('does not contain fake terminalLines in store (INV-TERM-01)', () => {
    const s = useTerminalStore.getState();
    expect((s as any).terminalLines).toBeUndefined();
    expect((s as any).addTerminalLine).toBeUndefined();
    expect(s.ptySessions).toEqual({});
  });

  it('registers and removes PTY sessions cleanly', () => {
    const s = useTerminalStore.getState();
    s.registerPtySession('s1', makePtyMeta('s1', 'pty-1'));
    s.registerPtySession('s2', makePtyMeta('s2', 'pty-2'));

    let st = useTerminalStore.getState();
    expect(st.ptySessions['s1']?.ptyId).toBe('pty-1');
    expect(st.ptySessions['s2']?.ptyId).toBe('pty-2');

    s.removePtySession('s1');
    st = useTerminalStore.getState();
    expect(st.ptySessions['s1']).toBeUndefined();
    expect(st.ptySessions['s2']?.ptyId).toBe('pty-2');
  });

  it('pruneTerminalSessions removes invalid sessions', () => {
    const s = useTerminalStore.getState();
    s.registerPtySession('keep', makePtyMeta('keep', 'pty-keep'));
    s.registerPtySession('ghost', makePtyMeta('ghost', 'pty-ghost'));

    s.pruneTerminalSessions(['keep']);
    const st = useTerminalStore.getState();
    expect(st.ptySessions['keep']?.ptyId).toBe('pty-keep');
    expect(st.ptySessions['ghost']).toBeUndefined();
  });
});

describe('terminalStore — diff buffers', () => {
  it('setActiveDiffSource upserts into diffFiles and sets active', () => {
    const s = useTerminalStore.getState();
    s.setActiveDiffSource(makeDiff('a.ts'));
    const st = useTerminalStore.getState();
    expect(st.activeDiffSource?.filePath).toBe('a.ts');
    expect(st.diffFiles.map((f) => f.filePath)).toEqual(['a.ts']);
    s.setActiveDiffSource(null);
    expect(useTerminalStore.getState().activeDiffSource).toBeNull();
    expect(useTerminalStore.getState().diffFiles).toHaveLength(1);
  });

  it('setDiffFiles / removeDiffFile keep activeDiffSource coherent', () => {
    const s = useTerminalStore.getState();
    const a = makeDiff('a.ts');
    const b = { ...makeDiff('b.ts'), deletions: 1 };
    s.setDiffFiles([a, b]);
    expect(useTerminalStore.getState().activeDiffSource?.filePath).toBe('a.ts');
    s.removeDiffFile('a.ts');
    expect(useTerminalStore.getState().activeDiffSource?.filePath).toBe('b.ts');
    s.removeDiffFile('b.ts');
    expect(useTerminalStore.getState().activeDiffSource).toBeNull();
    expect(useTerminalStore.getState().diffFiles).toEqual([]);
  });

  it('setDiffFiles supports functional updates and clamps non-arrays', () => {
    const s = useTerminalStore.getState();
    s.setDiffFiles([makeDiff('a.ts')]);
    s.setDiffFiles((prev) => [...prev, makeDiff('b.ts')]);
    expect(useTerminalStore.getState().diffFiles).toHaveLength(2);
    s.setDiffFiles('nope' as unknown as FileDiff[]);
    expect(useTerminalStore.getState().diffFiles).toEqual([]);
    expect(useTerminalStore.getState().activeDiffSource).toBeNull();
  });

  it('pushDiffFile replaces same-path entry (upsert) and activates it', () => {
    const s = useTerminalStore.getState();
    s.pushDiffFile(makeDiff('a.ts'));
    const updated = { ...makeDiff('a.ts'), additions: 9 };
    s.pushDiffFile(updated);
    const st = useTerminalStore.getState();
    expect(st.diffFiles).toHaveLength(1);
    expect(st.diffFiles[0]!.additions).toBe(9);
    expect(st.activeDiffSource?.additions).toBe(9);
  });
});

export type { TerminalStore };
