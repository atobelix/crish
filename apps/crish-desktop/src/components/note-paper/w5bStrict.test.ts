/**
 * W5-B Strict 包标识常量测
 *
 * 防止与 Skeleton 常量混淆；会计锚点可证伪。
 * 测名前缀 w5b_strict_*（包完成定义）。
 */
import { describe, expect, it } from 'vitest';
import {
  W5B_STRICT_BOUNDARY,
  W5B_STRICT_PACKAGE_ID,
  W5B_STRICT_TRACK,
} from './w5bStrict';
import { W5B_SKELETON_PACKAGE_ID, W5B_SKELETON_TRACK } from './w5bSkeleton';

describe('W5-B Strict 包标识 · w5b_strict_constants', () => {
  it('w5b_strict_package_id_is_W5-B_without_S', () => {
    expect(W5B_STRICT_PACKAGE_ID).toBe('W5-B');
    expect(W5B_STRICT_PACKAGE_ID.endsWith('-S')).toBe(false);
    expect(W5B_STRICT_PACKAGE_ID).not.toBe(W5B_SKELETON_PACKAGE_ID);
  });

  it('w5b_strict_track_is_strict', () => {
    expect(W5B_STRICT_TRACK).toBe('strict');
    expect(W5B_STRICT_TRACK).not.toBe(W5B_SKELETON_TRACK);
  });

  it('w5b_strict_boundary_declares_demo_neq_EL_and_S5', () => {
    expect(W5B_STRICT_BOUNDARY).toMatch(/W5-B/);
    expect(W5B_STRICT_BOUNDARY).toMatch(/Strict/i);
    expect(W5B_STRICT_BOUNDARY).toMatch(/可演示≠EL-01|≠EL-01/);
    expect(W5B_STRICT_BOUNDARY).toMatch(/EL-08/);
    expect(W5B_STRICT_BOUNDARY).toMatch(/W5-C|S5/);
  });
});
