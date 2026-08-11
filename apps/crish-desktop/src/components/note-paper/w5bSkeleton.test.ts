/**
 * W5-B-S Skeleton 包标识常量测
 *
 * 防止去 `-S` 冒充 Strict；会计锚点可证伪。
 */
import { describe, expect, it } from 'vitest';
import {
  W5B_SKELETON_BOUNDARY,
  W5B_SKELETON_PACKAGE_ID,
  W5B_SKELETON_TRACK,
} from './w5bSkeleton';

describe('W5-B-S Skeleton 包标识', () => {
  it('包 ID 必须带 -S（禁止去 -S 冒充 Strict）', () => {
    expect(W5B_SKELETON_PACKAGE_ID).toBe('W5-B-S');
    expect(W5B_SKELETON_PACKAGE_ID.endsWith('-S')).toBe(true);
    expect(W5B_SKELETON_PACKAGE_ID).not.toBe('W5-B');
  });

  it('轨为 skeleton', () => {
    expect(W5B_SKELETON_TRACK).toBe('skeleton');
  });

  it('边界句声明 ≠ Strict / ≠ EL', () => {
    expect(W5B_SKELETON_BOUNDARY).toMatch(/W5-B-S/);
    expect(W5B_SKELETON_BOUNDARY).toMatch(/Skeleton/i);
    expect(W5B_SKELETON_BOUNDARY).toMatch(/≠ Strict|≠EL|挂载≠EL/i);
  });
});
