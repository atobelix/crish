/**
 * 编辑会话注册表单测（R2-a① · 统一输入流收敛战役）
 *
 * 覆盖：open/commit/invalidate 生命周期、rev 推进、失效广播（事件总线）。
 * 验收对齐详案-R2 §1.1①：open 声明持有（无竞态建会话、记录 baseRev）；
 * commit 推进 rev + 清会话 + 广播失效（订阅方刷新）；invalidate 外部失效
 * → 编辑面立即失效；commit 带 expectRev 不符 → 冲突上报不静默 LWW（CT-01）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EditSessionRegistry,
  commitEditSession,
  defaultEditSessionRegistry,
  invalidateEditSession,
  isEditSessionOpen,
  openEditSession,
} from './index';

describe('EditSessionRegistry · R2-a① 编辑会话生命周期', () => {
  let registry: EditSessionRegistry;

  beforeEach(() => {
    registry = new EditSessionRegistry();
  });

  it('open 建立会话并记录 baseRev（无竞态）', () => {
    const r = registry.open('blk-1', 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session).toMatchObject({ objectId: 'blk-1', baseRev: 3 });
    expect(registry.isOpen('blk-1')).toBe(true);
    expect(registry.get('blk-1')?.baseRev).toBe(3);
  });

  it('open 重复持有 → already_open，保留首个 baseRev（首个持有者为准）', () => {
    registry.open('blk-1', 3);
    const r = registry.open('blk-1', 9);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('already_open');
    expect(r.session.baseRev).toBe(3);
    expect(registry.get('blk-1')?.baseRev).toBe(3);
  });

  it('open 广播 opened 事件（含 baseRev）', () => {
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.open('blk-1', 5);
    expect(listener).toHaveBeenCalledWith({
      type: 'opened',
      objectId: 'blk-1',
      baseRev: 5,
    });
  });

  it('commit 无会话 → not_open（无副作用、无事件）', () => {
    const listener = vi.fn();
    registry.subscribe(listener);
    const r = registry.commit('blk-ghost');
    expect(r).toEqual({ ok: false, code: 'not_open' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('commit 成功：清会话 + rev 推进（baseRev+1）+ committed 广播', () => {
    const events: unknown[] = [];
    registry.subscribe((e) => events.push(e));
    registry.open('blk-1', 3);
    const r = registry.commit('blk-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.committedRev).toBe(4); // rev 单调 +1（对齐 CT-01）
    expect(registry.isOpen('blk-1')).toBe(false);
    expect(events).toContainEqual({
      type: 'committed',
      objectId: 'blk-1',
      committedRev: 4,
    });
  });

  it('commit 带 expectRev 匹配 → 成功', () => {
    registry.open('blk-1', 3);
    const r = registry.commit('blk-1', { expectRev: 3 });
    expect(r.ok).toBe(true);
  });

  it('commit 带 expectRev 不符 → rev_conflict：不静默 LWW、会话保留、无 committed 事件', () => {
    const events: unknown[] = [];
    registry.subscribe((e) => events.push(e));
    registry.open('blk-1', 3);
    const r = registry.commit('blk-1', { expectRev: 8 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('rev_conflict');
    expect(r.expectRev).toBe(8);
    expect(r.baseRev).toBe(3);
    // 冲突不上报成功、不清会话——调用方决定重试或 invalidate
    expect(registry.isOpen('blk-1')).toBe(true);
    expect(
      events.some((e) => (e as { type?: string }).type === 'committed')
    ).toBe(false);
  });

  it('baseRev 缺省（未接线真实 rev）→ committedRev 占位 0', () => {
    registry.open('blk-0');
    const r = registry.commit('blk-0');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.committedRev).toBe(0);
  });

  it('invalidate 有会话：清会话 + invalidated 广播（reason + hadSession）', () => {
    const events: unknown[] = [];
    registry.subscribe((e) => events.push(e));
    registry.open('blk-1', 3);
    const r = registry.invalidate('blk-1', 'truncate');
    expect(r).toEqual({ ok: true, hadSession: true });
    expect(registry.isOpen('blk-1')).toBe(false);
    expect(events).toContainEqual({
      type: 'invalidated',
      objectId: 'blk-1',
      reason: 'truncate',
      hadSession: true,
    });
  });

  it('invalidate 无会话：仍广播（hadSession=false），订阅方可统一刷新', () => {
    const events: unknown[] = [];
    registry.subscribe((e) => events.push(e));
    const r = registry.invalidate('blk-ghost', 'withdraw');
    expect(r).toEqual({ ok: true, hadSession: false });
    expect(events).toContainEqual({
      type: 'invalidated',
      objectId: 'blk-ghost',
      reason: 'withdraw',
      hadSession: false,
    });
  });

  it('订阅/退订生命周期', () => {
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    registry.open('a');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    registry.open('b');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('多对象独立：提交 A 不影响 B 的会话', () => {
    registry.open('blk-a', 1);
    registry.open('blk-b', 2);
    registry.commit('blk-a');
    expect(registry.isOpen('blk-a')).toBe(false);
    expect(registry.isOpen('blk-b')).toBe(true);
  });

  it('activeCount / listActive / clearAll', () => {
    registry.open('a');
    registry.open('b');
    expect(registry.activeCount()).toBe(2);
    expect(
      registry
        .listActive()
        .map((s) => s.objectId)
        .sort()
    ).toEqual(['a', 'b']);
    registry.clearAll();
    expect(registry.activeCount()).toBe(0);
  });

  it('committed 广播后订阅方 isOpen 已关闭（订阅方刷新语义）', () => {
    // 「提交并失效——广播失效（订阅方刷新）」：订阅者在 committed 事件里
    // 读到的是已关闭的会话态，可直接刷新投影。
    const seen: boolean[] = [];
    registry.subscribe((e) => {
      if (e.type === 'committed') seen.push(registry.isOpen(e.objectId));
    });
    registry.open('blk-1', 2);
    registry.commit('blk-1');
    expect(seen).toEqual([false]);
  });
});

describe('默认单例便捷 API · R2-a①', () => {
  beforeEach(() => {
    defaultEditSessionRegistry.clearAll();
  });

  it('open/commit/invalidate/isOpen 便捷函数走同一单例', () => {
    const r = openEditSession('obj-1', 7);
    expect(r.ok).toBe(true);
    expect(isEditSessionOpen('obj-1')).toBe(true);
    const c = commitEditSession('obj-1');
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.committedRev).toBe(8);
    expect(isEditSessionOpen('obj-1')).toBe(false);
    const inv = invalidateEditSession('obj-1', 'collab-conflict');
    expect(inv).toEqual({ ok: true, hadSession: false });
  });
});
