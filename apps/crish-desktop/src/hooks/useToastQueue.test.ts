/**
 * useToastQueue pure helpers — enqueue / dedupe / ttl / max queue /
 * undo shape / error-only filters. No React render required.
 */
import { describe, expect, it } from 'vitest';
import type { AppToast } from '../services/ToastBus';
import {
  TOAST_MAX_QUEUE,
  TOAST_TTL_MS,
  buildUndoToastItem,
  classifyToastPolicy,
  createToastId,
  createToastItem,
  enqueueToast,
  filterErrorOnlyToastMessages,
  findDuplicateToastIndex,
  formatArchiveUndoToast,
  formatBranchUndoToast,
  formatEngineDegradeToast,
  isAllowedToast,
  isErrorToastCandidate,
  isForbiddenSuccessToast,
  isUndoToastShape,
  normalizeToastMessage,
  removeToastById,
  resolveToastTtlMs,
  shouldDropSuccessToast,
  toastDedupeKey,
  trimToastQueue,
} from './useToastQueue';

describe('constants (ttl / max queue)', () => {
  it('exports positive TTL and max queue defaults', () => {
    expect(TOAST_TTL_MS).toBe(5000);
    expect(TOAST_MAX_QUEUE).toBe(5);
    expect(TOAST_TTL_MS).toBeGreaterThan(0);
    expect(TOAST_MAX_QUEUE).toBeGreaterThanOrEqual(1);
  });

  it('resolveToastTtlMs clamps invalid and keeps positive overrides', () => {
    expect(resolveToastTtlMs()).toBe(TOAST_TTL_MS);
    expect(resolveToastTtlMs(undefined)).toBe(TOAST_TTL_MS);
    expect(resolveToastTtlMs(0)).toBe(TOAST_TTL_MS);
    expect(resolveToastTtlMs(-1)).toBe(TOAST_TTL_MS);
    expect(resolveToastTtlMs(Number.NaN)).toBe(TOAST_TTL_MS);
    expect(resolveToastTtlMs(Number.POSITIVE_INFINITY)).toBe(TOAST_TTL_MS);
    expect(resolveToastTtlMs(1.9)).toBe(1);
    expect(resolveToastTtlMs(12_000)).toBe(12_000);
  });
});

describe('normalizeToastMessage', () => {
  it('trims whitespace and treats nullish as empty', () => {
    expect(normalizeToastMessage('  复制失败  ')).toBe('复制失败');
    expect(normalizeToastMessage('\n\t')).toBe('');
    expect(normalizeToastMessage('')).toBe('');
    expect(normalizeToastMessage(undefined as unknown as string)).toBe('');
  });
});

describe('createToastId / createToastItem', () => {
  it('createToastId is deterministic with injected now/rand', () => {
    expect(createToastId(1_700_000_000_000, 'abc123')).toBe(
      'toast-1700000000000-abc123',
    );
  });

  it('createToastItem normalizes message and keeps onUndo', () => {
    const undo = () => {};
    const item = createToastItem('  导出失败  ', undo, 'toast-fixed');
    expect(item).toMatchObject({
      id: 'toast-fixed',
      message: '导出失败',
      onUndo: undo,
    });
  });

  it('createToastItem without id still yields toast- prefix', () => {
    const item = createToastItem('保存失败');
    expect(item.id.startsWith('toast-')).toBe(true);
    expect(item.message).toBe('保存失败');
    expect(item.onUndo).toBeUndefined();
  });
});

describe('toastDedupeKey / findDuplicateToastIndex', () => {
  it('keys differ by undo flag for same message', () => {
    expect(toastDedupeKey('x', false)).not.toBe(toastDedupeKey('x', true));
    expect(toastDedupeKey('  a  ', false)).toBe(toastDedupeKey('a', false));
  });

  it('finds duplicate by normalized message + undo-ness', () => {
    const queue: AppToast[] = [
      createToastItem('复制失败', undefined, 'a'),
      createToastItem('已归档: t', () => {}, 'b'),
    ];
    expect(findDuplicateToastIndex(queue, '  复制失败  ', false)).toBe(0);
    expect(findDuplicateToastIndex(queue, '已归档: t', true)).toBe(1);
    // same text but opposite undo flag → not a dupe
    expect(findDuplicateToastIndex(queue, '复制失败', true)).toBe(-1);
    expect(findDuplicateToastIndex(queue, '其他错误', false)).toBe(-1);
  });
});

describe('undo toast shape', () => {
  it('formatArchiveUndoToast / formatBranchUndoToast match policy prefixes', () => {
    expect(formatArchiveUndoToast('某会话')).toBe('已归档: 某会话');
    expect(formatBranchUndoToast('某会话 - 分支')).toBe('已分叉: 某会话 - 分支');
    expect(formatArchiveUndoToast('  ')).toBe('已归档: 会话');
    expect(formatBranchUndoToast('')).toBe('已分叉: 会话');
  });

  it('isUndoToastShape recognizes archive/branch only', () => {
    expect(isUndoToastShape('已归档: x')).toBe(true);
    expect(isUndoToastShape('已分叉: y')).toBe(true);
    expect(isUndoToastShape('已打开设置')).toBe(false);
    expect(isUndoToastShape('导出失败')).toBe(false);
  });

  it('buildUndoToastItem requires onUndo and is policy-show when shaped', () => {
    const undo = () => {};
    const msg = formatArchiveUndoToast('测试');
    const item = buildUndoToastItem(msg, undo, 'u1');
    expect(item.onUndo).toBe(undo);
    expect(item.id).toBe('u1');
    expect(classifyToastPolicy(item.message, item.onUndo)).toBe('show');
    expect(shouldDropSuccessToast(item.message, item.onUndo)).toBe(false);
    // bare archive text without onUndo is still allowed by pattern (not forbidden success)
    expect(isForbiddenSuccessToast(msg)).toBe(false);
  });
});

describe('error-only filters', () => {
  it('isErrorToastCandidate allows errors, drops success/empty', () => {
    expect(isErrorToastCandidate('导出失败')).toBe(true);
    expect(isErrorToastCandidate('引擎未连接（本机已保存）')).toBe(true);
    expect(isErrorToastCandidate('已保存')).toBe(false);
    expect(isErrorToastCandidate('正在同步…')).toBe(false);
    expect(isErrorToastCandidate('')).toBe(false);
    expect(isErrorToastCandidate('   ')).toBe(false);
  });

  it('filterErrorOnlyToastMessages strips success spam and blanks', () => {
    const out = filterErrorOnlyToastMessages([
      '已复制',
      '复制失败',
      '',
      '  保存失败  ',
      '已打开设置',
      '请先打开项目后再切换到项目作用域',
      '正在获取模型列表…',
      '当前已是最新版本',
      '单价已保存 · x',
    ]);
    expect(out).toEqual([
      '复制失败',
      '保存失败',
      '请先打开项目后再切换到项目作用域',
    ]);
  });

  it('allowed patterns stay tight: 没有可* errors, not 没有可用更新 status', () => {
    expect(isAllowedToast('没有可复制的正文')).toBe(true);
    expect(isAllowedToast('没有可重新生成的内容')).toBe(true);
    // 状态类：不应因宽松 /没有可/ 被记为 allowed
    expect(isAllowedToast('没有可用更新')).toBe(false);
    expect(isForbiddenSuccessToast('当前已是最新版本')).toBe(true);
  });

  it('engine degrade formatter stays error-leading (not success spam)', () => {
    const msg = formatEngineDegradeToast('timeout');
    expect(isErrorToastCandidate(msg)).toBe(true);
    expect(isForbiddenSuccessToast(msg)).toBe(false);
  });
});

describe('trimToastQueue / removeToastById', () => {
  const mk = (id: string): AppToast => createToastItem(`err-${id}`, undefined, id);

  it('trimToastQueue is no-op under max', () => {
    const q = [mk('1'), mk('2')];
    expect(trimToastQueue(q, 5)).toEqual({ next: q, evictedIds: [] });
  });

  it('trimToastQueue FIFO-evicts oldest when over max', () => {
    const q = [mk('1'), mk('2'), mk('3'), mk('4')];
    const { next, evictedIds } = trimToastQueue(q, 2);
    expect(evictedIds).toEqual(['1', '2']);
    expect(next.map((t) => t.id)).toEqual(['3', '4']);
  });

  it('trimToastQueue clamps invalid max to at least 1', () => {
    const q = [mk('a'), mk('b')];
    const { next, evictedIds } = trimToastQueue(q, 0);
    expect(next).toHaveLength(1);
    expect(evictedIds).toEqual(['a']);
    expect(next[0]!.id).toBe('b');
  });

  it('removeToastById drops matching id only', () => {
    const q = [mk('a'), mk('b'), mk('c')];
    expect(removeToastById(q, 'b').map((t) => t.id)).toEqual(['a', 'c']);
    expect(removeToastById(q, 'missing')).toHaveLength(3);
  });
});

describe('enqueueToast (policy + dedupe + max)', () => {
  it('drops empty and success without onUndo', () => {
    expect(enqueueToast([], '')).toEqual({ kind: 'drop', reason: 'drop-empty' });
    expect(enqueueToast([], '   ')).toEqual({ kind: 'drop', reason: 'drop-empty' });
    expect(enqueueToast([], '已保存')).toEqual({
      kind: 'drop',
      reason: 'drop-success',
    });
    expect(enqueueToast([], '已打开定时任务')).toEqual({
      kind: 'drop',
      reason: 'drop-success',
    });
    expect(enqueueToast([], '正在检查更新…')).toEqual({
      kind: 'drop',
      reason: 'drop-success',
    });
  });

  it('enqueues error messages', () => {
    const r = enqueueToast([], '导出失败', undefined, { id: 'e1' });
    expect(r.kind).toBe('enqueue');
    if (r.kind !== 'enqueue') return;
    expect(r.item).toMatchObject({ id: 'e1', message: '导出失败' });
    expect(r.next).toHaveLength(1);
    expect(r.evictedIds).toEqual([]);
  });

  it('enqueues undo path even when text looks like success archive', () => {
    const undo = () => {};
    const msg = formatArchiveUndoToast('会话A');
    const r = enqueueToast([], msg, undo, { id: 'u1' });
    expect(r.kind).toBe('enqueue');
    if (r.kind !== 'enqueue') return;
    expect(r.item.onUndo).toBe(undo);
    expect(isUndoToastShape(r.item.message)).toBe(true);
  });

  it('dedupes identical error message (no stack) and reports refresh TTL', () => {
    const first = enqueueToast([], '复制失败', undefined, { id: 'e1' });
    expect(first.kind).toBe('enqueue');
    if (first.kind !== 'enqueue') return;
    expect(first.ttlMs).toBe(TOAST_TTL_MS);
    const second = enqueueToast(first.next, '  复制失败  ');
    expect(second).toEqual({
      kind: 'dedupe',
      existingId: 'e1',
      refreshTtlMs: TOAST_TTL_MS,
    });
  });

  it('dedupe with custom ttlMs refreshes that TTL; onUndo patch returns next', () => {
    const undo1 = () => {};
    const undo2 = () => {};
    const msg = formatArchiveUndoToast('会话A');
    const first = enqueueToast([], msg, undo1, { id: 'u1', ttlMs: 3000 });
    expect(first.kind).toBe('enqueue');
    if (first.kind !== 'enqueue') return;
    expect(first.ttlMs).toBe(3000);

    const sameUndo = enqueueToast(first.next, msg, undo1, { ttlMs: 3000 });
    expect(sameUndo).toEqual({
      kind: 'dedupe',
      existingId: 'u1',
      refreshTtlMs: 3000,
    });

    const patched = enqueueToast(first.next, msg, undo2, { ttlMs: 3000 });
    expect(patched.kind).toBe('dedupe');
    if (patched.kind !== 'dedupe') return;
    expect(patched.existingId).toBe('u1');
    expect(patched.refreshTtlMs).toBe(3000);
    expect(patched.next).toBeDefined();
    expect(patched.next![0]!.onUndo).toBe(undo2);
    expect(patched.next![0]!.id).toBe('u1');
  });

  it('does not dedupe error vs undo with same text', () => {
    const undo = () => {};
    // craft same text on both paths (edge); keys must differ by undo flag
    const q: AppToast[] = [createToastItem('特殊', undefined, 'e')];
    // '特殊' is not forbidden success → show without undo
    const r = enqueueToast(q, '特殊', undo, { id: 'u' });
    expect(r.kind).toBe('enqueue');
    if (r.kind !== 'enqueue') return;
    expect(r.next).toHaveLength(2);
    expect(r.ttlMs).toBe(TOAST_TTL_MS);
  });

  it('drops residual success/status leaks (quick-menu / models / fonts / update)', () => {
    const leaks = [
      '当前已是最新版本',
      '单价已保存 · gpt-4o',
      '供应商已启用',
      '供应商已关闭',
      '界面字体已是「宋体」',
      '代码字体已是「Consolas」',
      '已是默认字体',
      '无需更新',
      '检查完成',
      '最新版本',
    ];
    for (const m of leaks) {
      expect(enqueueToast([], m), m).toEqual({
        kind: 'drop',
        reason: 'drop-success',
      });
    }
  });

  it('invalid ttlMs on enqueue falls back to TOAST_TTL_MS', () => {
    const r = enqueueToast([], '导出失败', undefined, { id: 'e', ttlMs: 0 });
    expect(r.kind).toBe('enqueue');
    if (r.kind !== 'enqueue') return;
    expect(r.ttlMs).toBe(TOAST_TTL_MS);
  });

  it('caps at TOAST_MAX_QUEUE and reports evicted ids (FIFO)', () => {
    let queue: AppToast[] = [];
    for (let i = 0; i < TOAST_MAX_QUEUE; i++) {
      const r = enqueueToast(queue, `失败 ${i}`, undefined, { id: `id-${i}` });
      expect(r.kind).toBe('enqueue');
      if (r.kind === 'enqueue') queue = r.next;
    }
    expect(queue).toHaveLength(TOAST_MAX_QUEUE);

    const overflow = enqueueToast(queue, '失败 overflow', undefined, {
      id: 'id-new',
    });
    expect(overflow.kind).toBe('enqueue');
    if (overflow.kind !== 'enqueue') return;
    expect(overflow.evictedIds).toEqual(['id-0']);
    expect(overflow.next).toHaveLength(TOAST_MAX_QUEUE);
    expect(overflow.next[0]!.id).toBe('id-1');
    expect(overflow.next[TOAST_MAX_QUEUE - 1]!.id).toBe('id-new');
  });

  it('respects custom maxQueue option', () => {
    const a = enqueueToast([], '失败 A', undefined, { id: 'a', maxQueue: 2 });
    expect(a.kind).toBe('enqueue');
    if (a.kind !== 'enqueue') return;
    const b = enqueueToast(a.next, '失败 B', undefined, { id: 'b', maxQueue: 2 });
    expect(b.kind).toBe('enqueue');
    if (b.kind !== 'enqueue') return;
    const c = enqueueToast(b.next, '失败 C', undefined, { id: 'c', maxQueue: 2 });
    expect(c.kind).toBe('enqueue');
    if (c.kind !== 'enqueue') return;
    expect(c.evictedIds).toEqual(['a']);
    expect(c.next.map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('success with onUndo is not dropped by policy (gate allows; product still should use archive/branch shape)', () => {
    const undo = () => {};
    // shouldDropSuccessToast returns false when onUndo present
    expect(shouldDropSuccessToast('已保存', undo)).toBe(false);
    const r = enqueueToast([], '已保存', undo, { id: 'x' });
    expect(r.kind).toBe('enqueue');
  });
});
