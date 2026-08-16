/**
 * editSessionConsumer 消费端适配单测（R2 后半执行位 · R2a 落盘后对齐）：
 * - open/commit/invalidate/isOpen 薄委托 R2a editSession 便捷函数；
 * - reason 语义与 R2a `EditSessionInvalidateReason` 对齐（withdraw/truncate/
 *   collab-conflict/external）；
 * - invalidateEditObjects 批量失效（幂等、空集合跳过）；
 * - 空 objectId 防御（不触达注册表）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const editSessionMocks = vi.hoisted(() => ({
  openEditSession: vi.fn(),
  commitEditSession: vi.fn(),
  invalidateEditSession: vi.fn(),
  isEditSessionOpen: vi.fn(),
}));

vi.mock('../editSession', () => ({
  openEditSession: editSessionMocks.openEditSession,
  commitEditSession: editSessionMocks.commitEditSession,
  invalidateEditSession: editSessionMocks.invalidateEditSession,
  isEditSessionOpen: editSessionMocks.isEditSessionOpen,
}));

import {
  editSessionConsumer,
  invalidateEditObjects,
} from './editSessionConsumer';

describe('editSessionConsumer（R2a 编辑会话抽象消费端 · 薄委托）', () => {
  beforeEach(() => {
    editSessionMocks.openEditSession.mockClear();
    editSessionMocks.commitEditSession.mockClear();
    editSessionMocks.invalidateEditSession.mockClear();
    editSessionMocks.isEditSessionOpen.mockClear();
  });

  it('open 委托 openEditSession(objectId, baseRev?)', () => {
    editSessionConsumer.open('block-1', 7);
    expect(editSessionMocks.openEditSession).toHaveBeenCalledWith('block-1', 7);

    editSessionMocks.openEditSession.mockClear();
    editSessionConsumer.open('block-2');
    expect(editSessionMocks.openEditSession).toHaveBeenCalledWith(
      'block-2',
      undefined
    );
  });

  it('commit 委托 commitEditSession(objectId, { expectRev })；ok 映射 boolean', () => {
    editSessionMocks.commitEditSession.mockReturnValueOnce({
      ok: true,
      session: { objectId: 'b', openedAtMs: 1 },
      committedRev: 8,
    });
    expect(editSessionConsumer.commit('b', 7)).toBe(true);
    expect(editSessionMocks.commitEditSession).toHaveBeenCalledWith('b', {
      expectRev: 7,
    });

    editSessionMocks.commitEditSession.mockReturnValueOnce({
      ok: false,
      code: 'rev_conflict',
      expectRev: 7,
      baseRev: 5,
    });
    expect(editSessionConsumer.commit('b', 7)).toBe(false);

    // 无 expectRev → options 缺省（exactOptionalPropertyTypes 兼容）
    editSessionMocks.commitEditSession.mockClear();
    editSessionMocks.commitEditSession.mockReturnValueOnce({
      ok: true,
      session: { objectId: 'b', openedAtMs: 1 },
      committedRev: 0,
    });
    expect(editSessionConsumer.commit('b')).toBe(true);
    expect(editSessionMocks.commitEditSession).toHaveBeenCalledWith(
      'b',
      undefined
    );
  });

  it('invalidate 委托 invalidateEditSession(objectId, reason)（R2a 语义对齐）', () => {
    editSessionConsumer.invalidate('m1', 'truncate');
    expect(editSessionMocks.invalidateEditSession).toHaveBeenCalledWith(
      'm1',
      'truncate'
    );
    editSessionConsumer.invalidate('m2', 'withdraw');
    expect(editSessionMocks.invalidateEditSession).toHaveBeenCalledWith(
      'm2',
      'withdraw'
    );
    editSessionConsumer.invalidate('b1', 'collab-conflict');
    expect(editSessionMocks.invalidateEditSession).toHaveBeenCalledWith(
      'b1',
      'collab-conflict'
    );
  });

  it('isOpen 委托 isEditSessionOpen', () => {
    editSessionMocks.isEditSessionOpen.mockReturnValueOnce(true);
    expect(editSessionConsumer.isOpen('b1')).toBe(true);
    expect(editSessionMocks.isEditSessionOpen).toHaveBeenCalledWith('b1');
  });

  it('invalidateEditObjects：批量广播，空集合跳过', () => {
    invalidateEditObjects([], 'truncate');
    expect(editSessionMocks.invalidateEditSession).not.toHaveBeenCalled();

    invalidateEditObjects(['m1', 'm2'], 'truncate');
    expect(editSessionMocks.invalidateEditSession).toHaveBeenCalledTimes(2);
    expect(editSessionMocks.invalidateEditSession).toHaveBeenNthCalledWith(
      1,
      'm1',
      'truncate'
    );
    expect(editSessionMocks.invalidateEditSession).toHaveBeenNthCalledWith(
      2,
      'm2',
      'truncate'
    );
  });

  it('空 objectId 防御：不触达注册表', () => {
    editSessionConsumer.open('', 1);
    editSessionConsumer.commit('');
    editSessionConsumer.invalidate('', 'external');
    editSessionConsumer.isOpen('');
    expect(editSessionMocks.openEditSession).not.toHaveBeenCalled();
    expect(editSessionMocks.commitEditSession).not.toHaveBeenCalled();
    expect(editSessionMocks.invalidateEditSession).not.toHaveBeenCalled();
    expect(editSessionMocks.isEditSessionOpen).not.toHaveBeenCalled();
  });
});
