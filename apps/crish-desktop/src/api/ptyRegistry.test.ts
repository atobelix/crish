import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PtyRegistry,
  bindSessionPty,
  ensurePtyForSession,
  findSessionByPtyId,
  getSessionPty,
  hasSessionPty,
  killAllPtys,
  killPtyForSession,
  listBoundSessionIds,
  normalizePtyId,
  normalizeSessionId,
  ptyRegistry,
  registerPtyBinding,
  registerPtyHandlers,
  resetPtyRegistryForTests,
  takeSessionPty,
} from './ptyRegistry';

afterEach(() => {
  resetPtyRegistryForTests();
});

// ── 纯 map ────────────────────────────────────────────────────────

describe('normalize ids', () => {
  it('trims and rejects empty', () => {
    expect(normalizeSessionId('  s1  ')).toBe('s1');
    expect(normalizeSessionId('')).toBeNull();
    expect(normalizeSessionId(null)).toBeNull();
    expect(normalizePtyId('  p1  ')).toBe('p1');
    expect(normalizePtyId('   ')).toBeNull();
  });
});

describe('bindSessionPty / getSessionPty / takeSessionPty (pure)', () => {
  it('bind → get → take 解绑且返回 ptyId', () => {
    let map = new Map<string, string>();
    map = bindSessionPty(map, 's1', 'pty-a');
    expect(getSessionPty(map, 's1')).toBe('pty-a');
    expect(hasSessionPty(map, 's1')).toBe(true);

    const { map: next, ptyId } = takeSessionPty(map, 's1');
    expect(ptyId).toBe('pty-a');
    expect(getSessionPty(next, 's1')).toBeUndefined();
    // 原 map 不可变语义：bind/take 返回新 map，入参可被实现拷贝
    expect(getSessionPty(next, 's1')).toBeUndefined();
  });

  it('重绑覆盖同 session', () => {
    let map = bindSessionPty(new Map(), 's1', 'pty-old');
    map = bindSessionPty(map, 's1', 'pty-new');
    expect(getSessionPty(map, 's1')).toBe('pty-new');
    expect(listBoundSessionIds(map)).toEqual(['s1']);
  });

  it('空 id 不写入', () => {
    const empty = new Map<string, string>();
    expect(bindSessionPty(empty, '', 'pty-a').size).toBe(0);
    expect(bindSessionPty(empty, 's1', '  ').size).toBe(0);
  });

  it('多 session 独立：kill/take A 保留 B', () => {
    let map = bindSessionPty(new Map(), 'sA', 'pty-A');
    map = bindSessionPty(map, 'sB', 'pty-B');
    expect(listBoundSessionIds(map).sort()).toEqual(['sA', 'sB']);

    const { map: afterA, ptyId } = takeSessionPty(map, 'sA');
    expect(ptyId).toBe('pty-A');
    expect(getSessionPty(afterA, 'sA')).toBeUndefined();
    expect(getSessionPty(afterA, 'sB')).toBe('pty-B');
  });

  it('findSessionByPtyId 反查', () => {
    const map = bindSessionPty(new Map(), 's1', 'pty-x');
    expect(findSessionByPtyId(map, 'pty-x')).toBe('s1');
    expect(findSessionByPtyId(map, 'missing')).toBeUndefined();
  });

  it('take 无绑定 → undefined', () => {
    const { map, ptyId } = takeSessionPty(new Map(), 'ghost');
    expect(ptyId).toBeUndefined();
    expect(map.size).toBe(0);
  });
});

// ── PtyRegistry 实例 ──────────────────────────────────────────────

describe('PtyRegistry', () => {
  it('bind/get/take/clear', () => {
    const r = new PtyRegistry();
    r.bind('s1', 'p1');
    r.bind('s2', 'p2');
    expect(r.size).toBe(2);
    expect(r.get('s1')).toBe('p1');
    expect(r.take('s1')).toBe('p1');
    expect(r.has('s1')).toBe(false);
    expect(r.get('s2')).toBe('p2');
    r.clear();
    expect(r.size).toBe(0);
  });

  it('snapshot 是拷贝', () => {
    const r = new PtyRegistry();
    r.bind('s1', 'p1');
    const snap = r.snapshot();
    r.bind('s2', 'p2');
    expect(snap.has('s2')).toBe(false);
    expect(r.has('s2')).toBe(true);
  });
});

// ── 生命周期 ensure / kill ────────────────────────────────────────

describe('ensurePtyForSession', () => {
  it('无 handler 且无绑定 → null', async () => {
    await expect(ensurePtyForSession('s1')).resolves.toBeNull();
  });

  it('已绑定则复用，不调 spawn', async () => {
    const spawn = vi.fn(async () => 'pty-new');
    registerPtyHandlers({ spawn });
    registerPtyBinding('s1', 'pty-existing');
    await expect(ensurePtyForSession('s1')).resolves.toBe('pty-existing');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawn 成功后写入 registry', async () => {
    registerPtyHandlers({
      spawn: async (sid) => `pty-for-${sid}`,
    });
    await expect(ensurePtyForSession('sess-9')).resolves.toBe('pty-for-sess-9');
    expect(ptyRegistry.get('sess-9')).toBe('pty-for-sess-9');
  });

  it('spawn 抛错 → null 且不留绑定', async () => {
    registerPtyHandlers({
      spawn: async () => {
        throw new Error('boom');
      },
    });
    await expect(ensurePtyForSession('s1')).resolves.toBeNull();
    expect(ptyRegistry.has('s1')).toBe(false);
  });

  it('空 session → null', async () => {
    registerPtyHandlers({ spawn: async () => 'p' });
    await expect(ensurePtyForSession('  ')).resolves.toBeNull();
  });
});

describe('killPtyForSession', () => {
  it('解绑并调用 kill handler', async () => {
    const kill = vi.fn(async () => {});
    registerPtyHandlers({ kill });
    registerPtyBinding('s1', 'pty-1');

    await expect(killPtyForSession('s1')).resolves.toBe('pty-1');
    expect(kill).toHaveBeenCalledWith('pty-1', 's1');
    expect(ptyRegistry.has('s1')).toBe(false);
  });

  it('无绑定 → undefined，不调 kill', async () => {
    const kill = vi.fn(async () => {});
    registerPtyHandlers({ kill });
    await expect(killPtyForSession('s1')).resolves.toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
  });

  it('multi-unit：kill A 保留 B', async () => {
    const killed: string[] = [];
    registerPtyHandlers({
      kill: async (ptyId, sid) => {
        killed.push(`${sid}:${ptyId}`);
      },
    });
    registerPtyBinding('sA', 'pty-A');
    registerPtyBinding('sB', 'pty-B');

    await killPtyForSession('sA');
    expect(killed).toEqual(['sA:pty-A']);
    expect(ptyRegistry.get('sB')).toBe('pty-B');
    expect(ptyRegistry.has('sA')).toBe(false);
  });

  it('kill handler 抛错仍保持解绑', async () => {
    registerPtyHandlers({
      kill: async () => {
        throw new Error('kill failed');
      },
    });
    registerPtyBinding('s1', 'pty-1');
    await expect(killPtyForSession('s1')).resolves.toBe('pty-1');
    expect(ptyRegistry.has('s1')).toBe(false);
  });
});

describe('killAllPtys', () => {
  it('清空全部绑定', async () => {
    const kill = vi.fn(async () => {});
    registerPtyHandlers({ kill });
    registerPtyBinding('s1', 'p1');
    registerPtyBinding('s2', 'p2');
    const killed = await killAllPtys();
    expect(killed.sort()).toEqual(['s1', 's2']);
    expect(ptyRegistry.size).toBe(0);
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it('空 registry no-op（app exit 安全）', async () => {
    const kill = vi.fn(async () => {});
    registerPtyHandlers({ kill });
    await expect(killAllPtys()).resolves.toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('策略 A：ensure 复用 + kill 必 take', () => {
  it('ensure 两次同一 session 只 spawn 一次（xterm 不得再造孤儿）', async () => {
    const spawn = vi.fn(async (sid: string) => `pty-${sid}`);
    registerPtyHandlers({ spawn });
    const a = await ensurePtyForSession('sess-x');
    const b = await ensurePtyForSession('sess-x');
    expect(a).toBe('pty-sess-x');
    expect(b).toBe('pty-sess-x');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(ptyRegistry.get('sess-x')).toBe('pty-sess-x');
  });

  it('kill 先 take 再 kill：二次 kill 无绑定 no-op', async () => {
    const kill = vi.fn(async () => {});
    registerPtyHandlers({ kill });
    registerPtyBinding('s1', 'pty-1');
    await killPtyForSession('s1');
    await killPtyForSession('s1');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(ptyRegistry.has('s1')).toBe(false);
  });

  it('unbind（进程自退出）不解 kill handler，仅清 map', () => {
    const kill = vi.fn(async () => {});
    registerPtyHandlers({ kill });
    registerPtyBinding('s1', 'pty-1');
    expect(ptyRegistry.unbind('s1')).toBe('pty-1');
    expect(ptyRegistry.has('s1')).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
