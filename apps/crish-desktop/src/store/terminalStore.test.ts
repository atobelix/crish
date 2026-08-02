/**
 * terminalStore 单测：terminal 缓冲镜像 / 会话隔离 / diff 缓冲 coherence。
 * 操作全局 singleton 后复位，避免污染其他域 store 测试。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useTerminalStore, type TerminalStore } from './terminalStore';
import type { FileDiff } from './types';

function makeDiff(filePath: string): FileDiff {
  return {
    filePath,
    additions: 1,
    deletions: 0,
    changes: [{ type: 'addition', content: '+x' }],
  };
}

beforeEach(() => {
  useTerminalStore.setState({
    terminalBySession: {},
    activeTerminalSessionId: null,
    terminalLines: [],
    diffFiles: [],
    activeDiffSource: null,
  });
});

describe('terminalStore — terminal buffers', () => {
  it('initial shape is safe (buffers empty, mirror empty)', () => {
    const s = useTerminalStore.getState();
    expect(Array.isArray(s.terminalLines)).toBe(true);
    expect(s.terminalBySession).toEqual({});
    expect(s.activeTerminalSessionId).toBeNull();
  });

  it('addTerminalLine without sessionId targets active session and mirrors it', () => {
    const s = useTerminalStore.getState();
    s.setActiveTerminalSession('s1');
    s.addTerminalLine('line-a');
    let st = useTerminalStore.getState();
    expect(st.terminalBySession.s1).toEqual(['line-a']);
    expect(st.terminalLines).toEqual(['line-a']);

    // 显式非活动会话：写缓冲，不碰镜像
    s.addTerminalLine('line-b', 's2');
    st = useTerminalStore.getState();
    expect(st.terminalBySession.s2).toEqual(['line-b']);
    expect(st.terminalLines).toEqual(['line-a']);
  });

  it('addTerminalLine without any active session falls back to _global', () => {
    const s = useTerminalStore.getState();
    s.addTerminalLine('hello');
    const st = useTerminalStore.getState();
    expect(st.terminalBySession._global).toEqual(['hello']);
    expect(st.terminalLines).toEqual(['hello']);
  });

  it('addTerminalLines appends in order and mirrors', () => {
    const s = useTerminalStore.getState();
    s.setActiveTerminalSession('s1');
    s.addTerminalLines(['a', 'b', 'c'], 's1');
    const st = useTerminalStore.getState();
    expect(st.terminalBySession.s1).toEqual(['a', 'b', 'c']);
    expect(st.terminalLines).toEqual(['a', 'b', 'c']);

    // 非法输入 no-op
    s.addTerminalLines([] as string[], 's1');
    s.addTerminalLines(null as unknown as string[], 's1');
    expect(useTerminalStore.getState().terminalBySession.s1).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('clearTerminalLines clears only the target session buffer', () => {
    const s = useTerminalStore.getState();
    s.setActiveTerminalSession('s1');
    s.addTerminalLine('keep', 's2');
    s.addTerminalLine('drop', 's1');
    s.clearTerminalLines('s1');
    const st = useTerminalStore.getState();
    expect(st.terminalBySession.s1).toEqual([]);
    expect(st.terminalBySession.s2).toEqual(['keep']);
    expect(st.terminalLines).toEqual([]);
  });

  it('setActiveTerminalSession switches mirror without dropping buffers', () => {
    const s = useTerminalStore.getState();
    s.setActiveTerminalSession('a');
    s.addTerminalLine('from-a');
    s.setActiveTerminalSession('b');
    s.addTerminalLine('from-b');
    let st = useTerminalStore.getState();
    expect(st.terminalLines).toEqual(['from-b']);

    s.setActiveTerminalSession('a');
    st = useTerminalStore.getState();
    expect(st.terminalLines).toEqual(['from-a']);
  });

  it('removeTerminalSession deletes buffer; clears mirror when active', () => {
    const s = useTerminalStore.getState();
    s.setActiveTerminalSession('a');
    s.addTerminalLine('x', 'a');
    s.addTerminalLine('y', 'b');
    s.removeTerminalSession('b');
    expect(useTerminalStore.getState().terminalBySession.b).toBeUndefined();
    expect(useTerminalStore.getState().terminalLines).toEqual(['x']);

    s.removeTerminalSession('a');
    const st = useTerminalStore.getState();
    expect(st.terminalBySession.a).toBeUndefined();
    expect(st.terminalLines).toEqual([]);
  });

  it('pruneTerminalSessions keeps only valid ids', () => {
    const s = useTerminalStore.getState();
    s.setActiveTerminalSession('keep');
    s.addTerminalLine('k1', 'keep');
    s.addTerminalLine('g1', 'ghost');
    s.addTerminalLine('g2', 'other');
    s.pruneTerminalSessions(['keep']);
    const st = useTerminalStore.getState();
    expect(st.terminalBySession.keep).toEqual(['k1']);
    expect(st.terminalBySession.ghost).toBeUndefined();
    expect(st.terminalBySession.other).toBeUndefined();
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
    // 置 null 不清历史列表（与旧语义一致）
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

describe('terminalStore — persistence boundary', () => {
  it('does not persist transient buffers (no localStorage key)', () => {
    const s = useTerminalStore.getState();
    s.addTerminalLine('x');
    s.pushDiffFile(makeDiff('a.ts'));
    expect(
      localStorage.getItem('crish-terminal-v1')
    ).toBeNull();
  });
});

export type { TerminalStore };
