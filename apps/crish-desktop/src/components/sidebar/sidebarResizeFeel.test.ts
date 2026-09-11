import { beforeEach, describe, expect, it } from 'vitest';
import {
  SIDEBAR_COLLAPSE_PX,
  SIDEBAR_RESIZER_HIT_PX,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarExpandedWidth,
  shouldCollapseSidebar,
  loadSidebarListPrefs,
  saveSidebarListPrefs,
  loadSidebarSectionsState,
  saveSidebarSectionsState,
  SIDEBAR_LIST_PREFS_KEY,
  SIDEBAR_SECTIONS_KEY,
} from './sidebarHelpers';
import { safeRemoveItem } from '../../api/localStorageApi';

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

describe('侧栏列表偏好与分区状态（收敛至 runtimeCache）', () => {
  beforeEach(() => {
    safeRemoveItem(SIDEBAR_LIST_PREFS_KEY);
    safeRemoveItem(SIDEBAR_SECTIONS_KEY);
  });

  it('loadSidebarListPrefs 在无数据时返回默认值', () => {
    const prefs = loadSidebarListPrefs();
    expect(prefs).toEqual({
      sortType: 'active',
      groupType: 'folder',
      filterType: 'all',
    });
  });

  it('saveSidebarListPrefs 保存后 loadSidebarListPrefs 可正确恢复', () => {
    saveSidebarListPrefs({
      sortType: 'name',
      groupType: 'none',
      filterType: 'pinned',
    });
    const prefs = loadSidebarListPrefs();
    expect(prefs).toEqual({
      sortType: 'name',
      groupType: 'none',
      filterType: 'pinned',
    });
  });

  it('loadSidebarSectionsState 在无数据时返回默认值', () => {
    const state = loadSidebarSectionsState();
    expect(state).toEqual({
      pinned: false,
      general: false,
      projects: false,
      projectIds: {},
    });
  });

  it('saveSidebarSectionsState 保存后 loadSidebarSectionsState 可正确恢复', () => {
    saveSidebarSectionsState({
      pinned: true,
      general: true,
      projects: false,
      projectIds: { 'proj-1': true, 'proj-2': false },
    });
    const state = loadSidebarSectionsState();
    expect(state).toEqual({
      pinned: true,
      general: true,
      projects: false,
      projectIds: { 'proj-1': true, 'proj-2': false },
    });
  });
});
