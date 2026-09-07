/**
 * newNoteBlockId 单测（audit-repair-202609 · T7）：
 * 产出必须是合法 UUID v4（引擎 BlockId::parse 硬约束）。
 */
import { describe, expect, it } from 'vitest';
import { isUuidV4, newNoteBlockId } from './noteBlockId';

describe('newNoteBlockId', () => {
  it('produces_valid_uuid_v4', () => {
    for (let i = 0; i < 50; i++) {
      const id = newNoteBlockId();
      expect(isUuidV4(id)).toBe(true);
    }
  });

  it('ids_are_unique_across_calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(newNoteBlockId());
    }
    expect(seen.size).toBe(200);
  });
});
