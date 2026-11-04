/**
 * 批 B ⑱ 阅读锚点持久化：存取往返、恢复裁决、去重口径。
 * 恢复红线：跟随态记录永不参与恢复（打开仍直达真底，R12 不回退）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isSameReadingAnchor,
  readReadingAnchor,
  resolveAnchorTargetScrollTop,
  resolveRestoreAnchor,
  writeReadingAnchor,
  type SavedReadingAnchor,
} from './readingAnchorStore';
import { READING_ANCHOR_PREFIX } from '../../utils/storageKeys';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';

const record = (
  over: Partial<SavedReadingAnchor> = {}
): SavedReadingAnchor => ({
  anchor: { key: 'm-42', top: -120 },
  following: false,
  updatedAt: 1700000000000,
  ...over,
});

describe('readingAnchorStore（批 B ⑱）', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('write → read 往返一致，键名走 storageKeys 注册前缀', () => {
    writeReadingAnchor('sess-1', record());
    expect(
      window.localStorage.getItem(`${READING_ANCHOR_PREFIX}sess-1`)
    ).not.toBeNull();
    expect(readReadingAnchor('sess-1')).toEqual(record());
  });

  it('无记录 / 空 sessionId → null', () => {
    expect(readReadingAnchor('nope')).toBeNull();
    expect(readReadingAnchor(null)).toBeNull();
    expect(readReadingAnchor(undefined)).toBeNull();
    expect(readReadingAnchor('')).toBeNull();
  });

  it('损坏 JSON / 形态非法 → null（不抛错）', () => {
    window.localStorage.setItem(`${READING_ANCHOR_PREFIX}bad`, '{oops');
    expect(readReadingAnchor('bad')).toBeNull();
    window.localStorage.setItem(
      `${READING_ANCHOR_PREFIX}bad2`,
      JSON.stringify({ anchor: { key: 1, top: 'x' }, following: false })
    );
    expect(readReadingAnchor('bad2')).toBeNull();
    window.localStorage.setItem(
      `${READING_ANCHOR_PREFIX}bad3`,
      JSON.stringify({ anchor: { key: 'm', top: 0 } })
    );
    expect(readReadingAnchor('bad3')).toBeNull();
  });

  it('恢复裁决：仅非跟随态返回锚点；跟随态 / 无记录 → null', () => {
    expect(resolveRestoreAnchor(record())).toEqual({ key: 'm-42', top: -120 });
    expect(resolveRestoreAnchor(record({ following: true }))).toBeNull();
    expect(resolveRestoreAnchor(null)).toBeNull();
  });

  it('落点口径：前缀和 − 锚点偏移，下限钳 0；无锚点/key 失效 → null', () => {
    const vsm = {
      getOrder: () => ['m1', 'm2', 'm3'],
      getOffset: (i: number) => [0, 100, 260][i] ?? 0,
    } as unknown as VirtualScrollManager;
    expect(resolveAnchorTargetScrollTop(vsm, { key: 'm3', top: -40 })).toBe(
      300
    );
    expect(resolveAnchorTargetScrollTop(vsm, { key: 'm2', top: 10 })).toBe(90);
    expect(resolveAnchorTargetScrollTop(vsm, { key: 'm1', top: 30 })).toBe(0);
    expect(resolveAnchorTargetScrollTop(vsm, null)).toBe(null);
    expect(
      resolveAnchorTargetScrollTop(vsm, { key: 'gone', top: 0 })
    ).toBeNull();
  });

  it('去重口径：key/following 同且 |Δtop| < 1px 视为等值', () => {
    expect(isSameReadingAnchor(record(), record())).toBe(true);
    expect(
      isSameReadingAnchor(
        record(),
        record({ anchor: { key: 'm-42', top: -120.5 } })
      )
    ).toBe(true);
    expect(
      isSameReadingAnchor(
        record(),
        record({ anchor: { key: 'm-42', top: -118 } })
      )
    ).toBe(false);
    expect(
      isSameReadingAnchor(
        record(),
        record({ anchor: { key: 'm-9', top: -120 } })
      )
    ).toBe(false);
    expect(isSameReadingAnchor(record(), record({ following: true }))).toBe(
      false
    );
    expect(isSameReadingAnchor(null, record())).toBe(false);
    expect(isSameReadingAnchor(null, null)).toBe(true);
  });
});
