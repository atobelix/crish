import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_COLLAPSE_PX,
  SIDEBAR_RESIZER_HIT_PX,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarExpandedWidth,
  shouldCollapseSidebar,
} from './sidebarHelpers';

describe('侧栏宽手感（参考折叠 120 + [160, 480]，默认 260）', () => {
  it('常量', () => {
    expect(SIDEBAR_RESIZER_HIT_PX).toBe(6);
    expect(SIDEBAR_COLLAPSE_PX).toBe(120);
    expect(SIDEBAR_WIDTH_MIN).toBe(160);
    expect(SIDEBAR_WIDTH_MAX).toBe(480);
    expect(SIDEBAR_WIDTH_DEFAULT).toBe(260);
  });

  it('展开钳 [160, 480]', () => {
    expect(clampSidebarExpandedWidth(100)).toBe(160);
    expect(clampSidebarExpandedWidth(200)).toBe(200);
    expect(clampSidebarExpandedWidth(500)).toBe(480);
    expect(clampSidebarExpandedWidth(Number.NaN)).toBe(260);
  });

  it('<120 折叠；≥120 不折（随后再钳到 ≥160）', () => {
    expect(shouldCollapseSidebar(119)).toBe(true);
    expect(shouldCollapseSidebar(120)).toBe(false);
    expect(shouldCollapseSidebar(260)).toBe(false);
  });
});
