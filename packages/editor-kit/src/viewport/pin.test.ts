/**
 * pin：composing 未 pin → 失败；焦点 + composing 通过
 */
import { describe, expect, it } from 'vitest';
import {
  assertComposingPinned,
  assertUnmountAllowed,
  buildPinSet,
  ensureComposingPinned,
  filterUnmountCandidates,
  PinViolationError,
  planScrollUnmount,
  validatePinSnapshot,
} from './pin';

describe('buildPinSet', () => {
  it('焦点 + composing 自动并入 pin', () => {
    const pinned = buildPinSet({
      focusId: 'focus-1',
      composingIds: ['comp-1'],
    });
    expect(pinned.has('focus-1')).toBe(true);
    expect(pinned.has('comp-1')).toBe(true);
    expect(pinned.size).toBe(2);
  });

  it('extraPinned 合并去重', () => {
    const pinned = buildPinSet({
      focusId: 'a',
      composingIds: ['a'],
      extraPinned: ['b', 'a'],
    });
    expect([...pinned].sort()).toEqual(['a', 'b']);
  });
});

describe('ensureComposingPinned / assertComposingPinned', () => {
  it('composing 未 pin → 失败 Result', () => {
    const pinned = new Set(['other']);
    const r = ensureComposingPinned(pinned, ['comp-x']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('composing_not_pinned');
      expect(r.blockId).toBe('comp-x');
    }
  });

  it('composing 未 pin → assert 抛 PinViolationError', () => {
    expect(() =>
      assertComposingPinned(new Set(['a']), ['comp-missing'])
    ).toThrow(PinViolationError);
  });

  it('焦点 + composing 均在 pin → 通过', () => {
    const pinned = buildPinSet({
      focusId: 'f',
      composingIds: ['c'],
    });
    expect(ensureComposingPinned(pinned, ['c']).ok).toBe(true);
    expect(() => assertComposingPinned(pinned, ['c'])).not.toThrow();
    const snap = validatePinSnapshot({
      pinned,
      focusId: 'f',
      composingIds: ['c'],
    });
    expect(snap.ok).toBe(true);
  });
});

describe('assertUnmountAllowed', () => {
  it('卸载焦点块 = 违规', () => {
    const pinned = buildPinSet({ focusId: 'focus-1' });
    expect(() =>
      assertUnmountAllowed('focus-1', {
        focusId: 'focus-1',
        pinned,
      })
    ).toThrow(PinViolationError);

    try {
      assertUnmountAllowed('focus-1', { focusId: 'focus-1', pinned });
    } catch (e) {
      expect(e).toBeInstanceOf(PinViolationError);
      expect((e as PinViolationError).code).toBe('unmount_focus');
    }
  });

  it('卸载 composing 块 = 违规', () => {
    const pinned = buildPinSet({ composingIds: ['c1'] });
    expect(() =>
      assertUnmountAllowed('c1', {
        composingIds: new Set(['c1']),
        pinned,
      })
    ).toThrow(/composing/);
  });

  it('非 pin 块允许卸载', () => {
    const pinned = buildPinSet({ focusId: 'f' });
    expect(() =>
      assertUnmountAllowed('other', {
        focusId: 'f',
        pinned,
      })
    ).not.toThrow();
  });

  it('filterUnmountCandidates throw 模式拒绝焦点', () => {
    const pinned = buildPinSet({ focusId: 'f', composingIds: ['c'] });
    expect(() =>
      filterUnmountCandidates(
        ['a', 'f'],
        {
          focusId: 'f',
          composingIds: ['c'],
          pinned,
        },
        'throw'
      )
    ).toThrow(PinViolationError);

    const allowed = filterUnmountCandidates(
      ['a', 'f', 'c', 'b'],
      { focusId: 'f', composingIds: ['c'], pinned },
      'filter'
    );
    expect(allowed.sort()).toEqual(['a', 'b']);
  });
});

describe('planScrollUnmount (DOM Pinning & IME Protection)', () => {
  it('候选集模式：拦截 IME 组合态正在输入的块与焦点块，保持 DOM Pinning', () => {
    const pinned = buildPinSet({
      focusId: 'focus-node',
      composingIds: ['ime-active'],
    });
    const plan = planScrollUnmount(
      ['node-1', 'ime-active', 'node-2', 'focus-node', 'node-3'],
      {
        focusId: 'focus-node',
        composingIds: ['ime-active'],
        pinned,
      }
    );

    expect(plan.retained.sort()).toEqual(['focus-node', 'ime-active'].sort());
    expect(plan.allowed.sort()).toEqual(['node-1', 'node-2', 'node-3'].sort());
  });

  it('DOM PinMap 模式：将 activeId 标记为 retained，其余节点允许卸载', () => {
    const pinMap = new Map<string, HTMLElement>();
    const dummyEl = {} as HTMLElement;
    pinMap.set('dom-1', dummyEl);
    pinMap.set('dom-composing', dummyEl);
    pinMap.set('dom-3', dummyEl);

    const plan = planScrollUnmount(pinMap, 'dom-composing');
    expect(plan.retained).toEqual(['dom-composing']);
    expect(plan.allowed.sort()).toEqual(['dom-1', 'dom-3'].sort());
  });

  it('DOM PinMap 模式：未传入 activeId 时所有节点均可安全卸载', () => {
    const pinMap = new Map<string, HTMLElement>();
    const dummyEl = {} as HTMLElement;
    pinMap.set('dom-1', dummyEl);
    pinMap.set('dom-2', dummyEl);

    const plan = planScrollUnmount(pinMap);
    expect(plan.retained).toEqual([]);
    expect(plan.allowed.sort()).toEqual(['dom-1', 'dom-2'].sort());
  });
});
