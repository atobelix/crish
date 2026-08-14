/**
 * 快照桥单测锁（P0-1 防静默回归第一道防线）。
 *
 * 断言：未注入时 save/clear 保持现状 no-op 语义（不抛错、无副作用）；
 * 注入后 save 真实入栈、clear 真实清空；重复注入幂等（最后一次为准）。
 *
 * 注意：桥的 _ops 为模块级单例且无解绑 API，测试 1 必须在任何注入之前
 * （未注入态不可恢复），同文件 it 按声明顺序串行执行，顺序依赖成立。
 */
import { describe, expect, it } from 'vitest';
import type { SessionMessage } from './types';
import { MessageSnapshots } from '../api/MessageSnapshots';
import { VirtualScrollManager } from '../api/VirtualScrollManager';
import {
  bindMessageSnapshotsOps,
  clearMessageSnapshots,
  registerActiveVsm,
  unregisterActiveVsm,
  saveMessageSnapshot,
  saveSessionSnapshot,
  type SnapshotSaveEntry,
} from './messageSnapshotsBridge';

function msg(id: string, text = id): SessionMessage {
  return {
    id,
    sender: id.startsWith('a') ? 'assistant' : 'user',
    text,
    timestamp: 1,
  };
}

function makeEntry(
  sessionId: string,
  messages: SessionMessage[]
): SnapshotSaveEntry {
  return {
    sessionId,
    operation: 'withdraw',
    messages,
    diffFilePaths: [],
    timestamp: Date.now(),
    description: '撤回消息',
  };
}

describe('messageSnapshotsBridge — 接线行为锁', () => {
  it('未注入时 save/clear 不抛错且无副作用（调用面兼容现状）', () => {
    const sessionId = 's-none';
    const entry = makeEntry(sessionId, [msg('u1'), msg('a1')]);
    expect(() => {
      saveMessageSnapshot(sessionId, entry, { afterMessages: [msg('u1')] });
      clearMessageSnapshots(sessionId);
    }).not.toThrow();
  });

  it('注入后 save 真实入栈（append-tail withdraw 形态）', () => {
    const snapshots = new MessageSnapshots();
    bindMessageSnapshotsOps({
      save: (sessionId, entry, options) =>
        snapshots.save(sessionId, entry, {
          afterMessages: options?.afterMessages ?? [],
        }),
      clearSession: (sessionId) => snapshots.clearSession(sessionId),
    });

    const sessionId = 's-save';
    const prev = [msg('u1'), msg('a1'), msg('u2'), msg('a2')];
    const after = [msg('u1'), msg('a1')];
    const ret = saveMessageSnapshot(sessionId, makeEntry(sessionId, prev), {
      afterMessages: after,
    });

    expect(ret).toBeUndefined(); // 包装函数契约：返回 void
    expect(snapshots.getStack(sessionId)).toHaveLength(1);
    expect(snapshots.peekDelta(sessionId)).toEqual({
      startIndex: 2,
      removedCount: 0,
      inserted: [msg('u2'), msg('a2')],
    });
  });

  it('注入后 clear 清空，且对不存在会话幂等不抛错', () => {
    const snapshots = new MessageSnapshots();
    bindMessageSnapshotsOps({
      save: (sessionId, entry, options) =>
        snapshots.save(sessionId, entry, {
          afterMessages: options?.afterMessages ?? [],
        }),
      clearSession: (sessionId) => snapshots.clearSession(sessionId),
    });

    const sessionId = 's-clear';
    saveMessageSnapshot(
      sessionId,
      makeEntry(sessionId, [msg('u1'), msg('a1'), msg('u2')]),
      {
        afterMessages: [msg('u1'), msg('a1')],
      }
    );
    saveMessageSnapshot(
      sessionId,
      makeEntry(sessionId, [msg('u1'), msg('a1')]),
      {
        afterMessages: [msg('u1')],
      }
    );
    expect(snapshots.getStack(sessionId)).toHaveLength(2);

    clearMessageSnapshots(sessionId);
    expect(snapshots.getStack(sessionId)).toHaveLength(0);

    expect(() => clearMessageSnapshots('s-ghost')).not.toThrow();
  });

  it('重复注入幂等：不同实例以最后一次为准，同实例重复绑定不报错', () => {
    const instanceA = new MessageSnapshots();
    const instanceB = new MessageSnapshots();
    const opsA: Parameters<typeof bindMessageSnapshotsOps>[0] = {
      save: (sessionId, entry, options) =>
        instanceA.save(sessionId, entry, {
          afterMessages: options?.afterMessages ?? [],
        }),
      clearSession: (sessionId) => instanceA.clearSession(sessionId),
    };
    const opsB: Parameters<typeof bindMessageSnapshotsOps>[0] = {
      save: (sessionId, entry, options) =>
        instanceB.save(sessionId, entry, {
          afterMessages: options?.afterMessages ?? [],
        }),
      clearSession: (sessionId) => instanceB.clearSession(sessionId),
    };

    bindMessageSnapshotsOps(opsA);
    expect(() => bindMessageSnapshotsOps(opsA)).not.toThrow(); // 同实例重复绑定幂等

    saveMessageSnapshot(
      's-rebind',
      makeEntry('s-rebind', [msg('u1'), msg('a1')]),
      {
        afterMessages: [msg('u1')],
      }
    );
    expect(instanceA.getStack('s-rebind')).toHaveLength(1);

    bindMessageSnapshotsOps(opsB); // 替换：以最后一次为准
    saveMessageSnapshot(
      's-rebind',
      makeEntry('s-rebind', [msg('u1'), msg('a1')]),
      {
        afterMessages: [msg('u1')],
      }
    );
    expect(instanceB.getStack('s-rebind')).toHaveLength(1); // 新绑定生效
    expect(instanceA.getStack('s-rebind')).toHaveLength(1); // 旧实例不再接收
  });

  it('自动捕获已注册 VSM 的实测高度并在 delta 中持久化', () => {
    const snapshots = new MessageSnapshots();
    bindMessageSnapshotsOps({
      save: (sessionId, entry, options) =>
        snapshots.save(sessionId, entry, {
          afterMessages: options?.afterMessages ?? [],
          heightMap: options?.heightMap,
        }),
      clearSession: (sessionId) => snapshots.clearSession(sessionId),
    });

    const sessionId = 's-vsm-capture';
    const vsm = new VirtualScrollManager(120);
    vsm.syncOrder(['u1', 'a1']);
    vsm.setActual('u1', 65);
    vsm.setActual('a1', 750);

    registerActiveVsm(sessionId, vsm);

    const prev = [msg('u1'), msg('a1')];
    const after = [msg('u1')];

    saveMessageSnapshot(sessionId, makeEntry(sessionId, prev), {
      afterMessages: after,
    });

    const delta = snapshots.peekDelta(sessionId);
    expect(delta?.heightMap).toEqual({
      a1: 750,
    });

    unregisterActiveVsm(sessionId);
  });

  it('saveSessionSnapshot 辅助函数正常工作', () => {
    const snapshots = new MessageSnapshots();
    bindMessageSnapshotsOps({
      save: (sessionId, entry, options) =>
        snapshots.save(sessionId, entry, {
          afterMessages: options?.afterMessages ?? [],
          heightMap: options?.heightMap,
        }),
      clearSession: (sessionId) => snapshots.clearSession(sessionId),
    });

    const sessionId = 's-sess-helper';
    const prev = [msg('u1'), msg('a1')];
    const after = [msg('u1')];
    const vsm = new VirtualScrollManager(120);
    vsm.setActual('a1', 820);

    saveSessionSnapshot(sessionId, 'withdraw', prev, after, vsm);

    const delta = snapshots.peekDelta(sessionId);
    expect(delta?.heightMap).toEqual({ a1: 820 });
  });
});
