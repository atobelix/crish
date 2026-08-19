import { describe, expect, it } from 'vitest';
import {
  permissionBarMoreCount,
  permissionBarMoreLabel,
  shouldRenderPermissionBar,
} from './permissionBarModel';

describe('permissionBarModel', () => {
  it('还有 N = pending - 1；单条不显示', () => {
    expect(permissionBarMoreCount(0)).toBe(0);
    expect(permissionBarMoreCount(1)).toBe(0);
    expect(permissionBarMoreCount(3)).toBe(2);
    expect(permissionBarMoreCount(Number.NaN)).toBe(0);
    expect(permissionBarMoreCount(-2)).toBe(0);
  });

  it('还有 N 文案', () => {
    expect(permissionBarMoreLabel(0)).toBeNull();
    expect(permissionBarMoreLabel(2)).toBe('还有 2');
    expect(permissionBarMoreLabel(Number.NaN)).toBeNull();
  });

  it('无 pending 或无首条 id 不渲染', () => {
    expect(shouldRenderPermissionBar(1, 'tc-1')).toBe(true);
    expect(shouldRenderPermissionBar(0, 'tc-1')).toBe(false);
    expect(shouldRenderPermissionBar(2, '')).toBe(false);
    expect(shouldRenderPermissionBar(2, '  ')).toBe(false);
  });
});
