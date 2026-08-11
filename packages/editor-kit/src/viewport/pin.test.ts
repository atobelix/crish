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
