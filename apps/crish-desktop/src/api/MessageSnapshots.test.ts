import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../store/types';

type LiveSession = { id: string; messages: SessionMessage[] };

const liveById: Record<string, LiveSession> = {};

vi.mock('../store/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      sessions: Object.values(liveById),
      sessionsById: liveById,
    }),
  },
}));

import {
  MessageSnapshots,
  applyDelta,
  computeDiff,
  estimateBytes,
  estimateDeltaBytes,
} from './MessageSnapshots';
import { VirtualScrollManager } from './VirtualScrollManager';

function msg(
  id: string,
  text = id,
  extra?: Partial<SessionMessage>
): SessionMessage {
  return {
    id,
    sender: id.startsWith('a') ? 'assistant' : 'user',
    text,
    timestamp: 1,
    ...extra,
  };
}

function setLive(sessionId: string, messages: SessionMessage[]): void {
  liveById[sessionId] = { id: sessionId, messages };
}

describe('computeDiff / applyDelta', () => {
  it('suffix withdraw: only stores truncated tail', () => {
    const prev = [msg('u1'), msg('a1'), msg('u2'), msg('a2')];
    const after = [msg('u1'), msg('a1')];
    const diff = computeDiff(prev, after);
    expect(diff).toEqual({
      startIndex: 2,
      removedCount: 0,
      inserted: [msg('u2'), msg('a2')],
    });
    expect(applyDelta(diff, after).map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ]);
  });

  it('middle delete: only stores local segment', () => {
    const prev = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e')];
    const after = [msg('a'), msg('b'), msg('e')];
    const diff = computeDiff(prev, after);
    expect(diff.startIndex).toBe(2);
    expect(diff.removedCount).toBe(0);
    expect(diff.inserted.map((m) => m.id)).toEqual(['c', 'd']);
    expect(applyDelta(diff, after).map((m) => m.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('middle replace: removedCount and inserted are local', () => {
    const prev = [msg('a'), msg('b', 'old'), msg('c')];
    const after = [msg('a'), msg('b2', 'new'), msg('c')];
    const diff = computeDiff(prev, after);
    expect(diff.startIndex).toBe(1);
    expect(diff.removedCount).toBe(1);
    expect(diff.inserted.map((m) => m.id)).toEqual(['b']);
    expect(applyDelta(diff, after).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('full replace with no common prefix degrades to near-full inserted', () => {
    const prev = [msg('x'), msg('y')];
    const after = [msg('p'), msg('q'), msg('r')];
    const diff = computeDiff(prev, after);
    expect(diff.startIndex).toBe(0);
    expect(diff.removedCount).toBe(3);
    expect(diff.inserted.map((m) => m.id)).toEqual(['x', 'y']);
    expect(applyDelta(diff, after).map((m) => m.id)).toEqual(['x', 'y']);
  });

  it('identical lists yield empty patch', () => {
    const list = [msg('a'), msg('b')];
    const diff = computeDiff(list, list);
    expect(diff).toEqual({ startIndex: 2, removedCount: 0, inserted: [] });
    expect(applyDelta(diff, list)).toEqual(list);
  });
});

describe('MessageSnapshots', () => {
  let snaps: MessageSnapshots;

  beforeEach(() => {
    snaps = new MessageSnapshots();
    for (const k of Object.keys(liveById)) delete liveById[k];
  });

  it('save stores local reverse delta for append-tail withdraw (not full copy)', () => {
    const sessionId = 's1';
    const prev = [
      msg('u1', 'hello'),
      msg('a1', 'world'),
      msg('u2', 'bye'),
      msg('a2', 'ok'),
    ];
    const after = [msg('u1', 'hello'), msg('a1', 'world')];
    setLive(sessionId, after);

    snaps.save(
      sessionId,
      {
        sessionId,
        operation: 'withdraw',
        messages: prev,
        diffFilePaths: [],
        timestamp: Date.now(),
        description: '撤回消息',
      },
      { afterMessages: after }
    );

    const delta = snaps.peekDelta(sessionId);
    expect(delta).not.toBeNull();
    expect(delta!.startIndex).toBe(2);
    expect(delta!.removedCount).toBe(0);
    expect(delta!.inserted.map((m) => m.id)).toEqual(['u2', 'a2']);
    // 不得默认塞全量
    expect(delta!.inserted.length).toBeLessThan(prev.length);
  });

  it('save middle-delete only keeps changed segment', () => {
    const sessionId = 's-mid';
    const prev = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e')];
    const after = [msg('a'), msg('b'), msg('e')];
    setLive(sessionId, after);

    snaps.save(
      sessionId,
      {
        sessionId,
        operation: 'withdraw',
        messages: prev,
        diffFilePaths: [],
        timestamp: 1,
      },
      { afterMessages: after }
    );

    const delta = snaps.peekDelta(sessionId)!;
    expect(delta.inserted.map((m) => m.id)).toEqual(['c', 'd']);
    expect(delta.inserted.length).toBe(2);
  });

  it('undo restores full messages correctly', () => {
    const sessionId = 's-undo';
    const prev = [msg('u1'), msg('a1'), msg('u2'), msg('a2')];
    const after = [msg('u1'), msg('a1')];
    setLive(sessionId, after);

    snaps.save(
      sessionId,
      {
        sessionId,
        operation: 'withdraw',
        messages: prev,
        pinnedMessageIds: ['u1'],
        diffFilePaths: ['src/a.ts'],
        timestamp: 10,
        description: '撤回消息',
      },
      { afterMessages: after }
    );

    const entry = snaps.undo(sessionId);
    expect(entry).not.toBeNull();
    expect(entry!.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(entry!.pinnedMessageIds).toEqual(['u1']);
    expect(entry!.diffFilePaths).toEqual(['src/a.ts']);
    expect(entry!.description).toBe('撤回消息');
    expect(snaps.undo(sessionId)).toBeNull();
  });

  it('chained undo restores step by step', () => {
    const sessionId = 's-chain';
    const m0 = [msg('a'), msg('b'), msg('c'), msg('d')];
    const m1 = [msg('a'), msg('b'), msg('c')];
    const m2 = [msg('a'), msg('b')];

    snaps.save(
      sessionId,
      {
        sessionId,
        operation: 'withdraw',
        messages: m0,
        diffFilePaths: [],
        timestamp: 1,
      },
      { afterMessages: m1 }
    );
    snaps.save(
      sessionId,
      {
        sessionId,
        operation: 'withdraw',
        messages: m1,
        diffFilePaths: [],
        timestamp: 2,
      },
      { afterMessages: m2 }
    );

    setLive(sessionId, m2);
    const first = snaps.undo(sessionId)!;
    expect(first.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);

    setLive(sessionId, first.messages);
    const second = snaps.undo(sessionId)!;
    expect(second.messages.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('peek / getStack rebuild full message views', () => {
    const sessionId = 's-view';
    const m0 = [msg('a'), msg('b'), msg('c')];
    const m1 = [msg('a'), msg('b')];
    const m2 = [msg('a')];

    snaps.save(
      sessionId,
      {
        sessionId,
        operation: 'withdraw',
        messages: m0,
        diffFilePaths: [],
        timestamp: 1,
      },
      { afterMessages: m1 }
    );
    snaps.save(
      sessionId,
      {
        sessionId,
        operation: 'withdraw',
        messages: m1,
        diffFilePaths: [],
        timestamp: 2,
      },
      { afterMessages: m2 }
    );
    setLive(sessionId, m2);

    const peek = snaps.peek(sessionId)!;
    expect(peek.messages.map((m) => m.id)).toEqual(['a', 'b']);

    const stack = snaps.getStack(sessionId);
    expect(stack).toHaveLength(2);
    expect(stack[0].messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(stack[1].messages.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('drops oldest when stack depth exceeds 20', () => {
    const sessionId = 's-depth';
    const base = [msg('keep')];

    for (let i = 0; i < 25; i++) {
      const prev = [...base, msg(`x${i}`, `text-${i}`)];
      const after = base.slice();
      snaps.save(
        sessionId,
        {
          sessionId,
          operation: 'withdraw',
          messages: prev,
          diffFilePaths: [],
          timestamp: i + 1,
          description: `snap-${i}`,
        },
        { afterMessages: after }
      );
    }

    setLive(sessionId, base);
    const stack = snaps.getStack(sessionId);
    expect(stack.length).toBe(snaps.getMaxStackDepth());
    // 最旧的 0..4 应被丢弃；保留 5..24
    expect(stack[0].description).toBe('snap-5');
    expect(stack[stack.length - 1].description).toBe('snap-24');
  });

  it('enforces 5MB hard memory limit by evicting oldest globally', () => {
    const bigText = 'Z'.repeat(600_000); // ~1.2MB per message under estimateBytes
    const sessions = ['mem-a', 'mem-b', 'mem-c'];

    for (let i = 0; i < 12; i++) {
      const sid = sessions[i % sessions.length];
      const prev = [msg('head'), msg(`big-${i}`, bigText)];
      const after = [msg('head')];
      snaps.save(
        sid,
        {
          sessionId: sid,
          operation: 'withdraw',
          messages: prev,
          diffFilePaths: [],
          timestamp: i + 1,
          description: `big-${i}`,
        },
        { afterMessages: after }
      );
    }

    expect(snaps.getTotalMemoryBytes()).toBeLessThanOrEqual(
      snaps.getMaxMemoryBytes()
    );
    expect(snaps.getTotalMemoryBytes()).toBeGreaterThan(0);

    // 仍应保留若干较新条目
    let totalEntries = 0;
    for (const sid of sessions) {
      totalEntries += snaps.getStack(sid).length;
      setLive(sid, [msg('head')]);
    }
    expect(totalEntries).toBeGreaterThan(0);
    expect(totalEntries).toBeLessThan(12);

    // 最旧应已被剔除：big-0 不应再出现
    const allDesc = sessions.flatMap((sid) => {
      setLive(sid, [msg('head')]);
      return snaps.getStack(sid).map((e) => e.description);
    });
    expect(allDesc).not.toContain('big-0');
  });

  it('totalMemoryBytes never goes negative after undo/clear', () => {
    const sessionId = 's-mem-clamp';
    const prev = [msg('a'), msg('b', 'x'.repeat(1000))];
    const after = [msg('a')];
    snaps.save(
      sessionId,
      {
        sessionId,
        operation: 'withdraw',
        messages: prev,
        diffFilePaths: [],
        timestamp: 1,
      },
      { afterMessages: after }
    );
    setLive(sessionId, after);
    snaps.undo(sessionId);
    expect(snaps.getTotalMemoryBytes()).toBe(0);

    snaps.save(
      sessionId,
      {
        sessionId,
        operation: 'withdraw',
        messages: prev,
        diffFilePaths: [],
        timestamp: 2,
      },
      { afterMessages: after }
    );
    snaps.clearSession(sessionId);
    expect(snaps.getTotalMemoryBytes()).toBe(0);

    snaps.save(
      sessionId,
      {
        sessionId,
        operation: 'withdraw',
        messages: prev,
        diffFilePaths: [],
        timestamp: 3,
      },
      { afterMessages: after }
    );
    snaps.clearAll();
    expect(snaps.getTotalMemoryBytes()).toBe(0);
  });

  it('estimateBytes scales with inserted text payload', () => {
    const small = estimateBytes({
      sessionId: 's',
      operation: 'withdraw',
      inserted: [msg('a', 'hi')],
      diffFilePaths: [],
    });
    const large = estimateBytes({
      sessionId: 's',
      operation: 'withdraw',
      inserted: [msg('a', 'x'.repeat(50_000))],
      diffFilePaths: [],
    });
    expect(large).toBeGreaterThan(small + 40_000);
  });

  it('estimateBytes and estimateDeltaBytes scale with heightMap entries', () => {
    const withoutMap = estimateBytes({
      sessionId: 's',
      operation: 'withdraw',
      inserted: [msg('a', 'hi')],
      diffFilePaths: [],
    });
    const withMap = estimateBytes({
      sessionId: 's',
      operation: 'withdraw',
      inserted: [msg('a', 'hi')],
      diffFilePaths: [],
      heightMap: { a: 800, b: 200, c: 350 },
    });
    expect(withMap).toBe(withoutMap + 3 * 24);

    const deltaBytes1 = estimateDeltaBytes({
      startIndex: 0,
      removedCount: 0,
      inserted: [msg('a', 'hi')],
    });
    const deltaBytes2 = estimateDeltaBytes({
      startIndex: 0,
      removedCount: 0,
      inserted: [msg('a', 'hi')],
      heightMap: { a: 800, b: 200 },
    });
    expect(deltaBytes2).toBe(deltaBytes1 + 2 * 24);
  });

  it('computeDiff and save capture heightMap for inserted segment', () => {
    const sessionId = 's-height';
    const prev = [msg('u1'), msg('a1'), msg('u2'), msg('a2')];
    const after = [msg('u1'), msg('a1')];
    const heightMap: Record<string, number> = {
      u1: 60,
      a1: 800,
      u2: 90,
      a2: 650,
    };

    const diff = computeDiff(prev, after, heightMap);
    expect(diff.heightMap).toBeDefined();
    expect(diff.heightMap).toEqual({
      u2: 90,
      a2: 650,
    });

    snaps.save(
      sessionId,
      {
        sessionId,
        operation: 'withdraw',
        messages: prev,
        diffFilePaths: [],
        timestamp: 100,
      },
      {
        afterMessages: after,
        heightMap,
      }
    );

    const peeked = snaps.peekDelta(sessionId);
    expect(peeked?.heightMap).toEqual({
      u2: 90,
      a2: 650,
    });
  });

  it('撤销操作回灌 heightMap，VSM 保持实测高度，杜绝 120px 暴跌', () => {
    const vsm = new VirtualScrollManager(120);
    const msg1: SessionMessage = {
      id: 'm1',
      sender: 'assistant',
      text: '高度 800px 的卡片',
      status: 'completed',
    };
    const msg2: SessionMessage = {
      id: 'm2',
      sender: 'user',
      text: '普通消息',
      status: 'completed',
    };

    vsm.syncOrder(['m1', 'm2']);
    vsm.setActual('m1', 800);
    vsm.setActual('m2', 100);

    // 模拟删除 m1 操作并保存快照
    const heightMap: Record<string, number> = { m1: 800, m2: 100 };
    const delta = computeDiff([msg1, msg2], [msg2], heightMap);

    // 模拟应用状态变为仅有 [msg2] 并清空 VSM 内存
    const afterMessages = [msg2];
    vsm.clear();
    vsm.syncOrder(['m2']);
    vsm.setActual('m2', 100);

    // 执行 Undo
    const restoredMessages = applyDelta(delta, afterMessages);
    expect(restoredMessages.map((m) => m.id)).toEqual(['m1', 'm2']);

    // 回灌高度映射
    if (delta.heightMap) {
      vsm.hydrateHeightMap(delta.heightMap);
    }
    vsm.syncOrder(restoredMessages.map((m) => m.id));

    // 断言：m1 的高度由 heightMap 精确还原为 800px，未回退至 120px
    expect(vsm.getHeight('m1')).toBe(800);
    expect(vsm.getOffset(0)).toBe(0);
    expect(vsm.getOffset(1)).toBe(800); // m2 的偏移量精确保持在 800px
  });
});
