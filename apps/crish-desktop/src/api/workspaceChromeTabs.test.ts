import { beforeEach, describe, expect, it } from 'vitest';
import { GENERAL_FOLDER } from './projectStore';
import {
  activeWorkspaceTabId,
  buildSessionTabsForWorkspace,
  buildWorkspaceTabs,
  closeSessionTab,
  currentWorkspaceFolderKey,
  openSessionTab,
  pruneOpenSessionTabs,
  sessionBelongsToWorkspace,
  OPEN_SESSION_TABS_KEY,
} from './workspaceChromeTabs';

describe('workspaceChromeTabs', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* node without ls */
    }
  });

  it('currentWorkspaceFolderKey falls back to GENERAL_FOLDER', () => {
    expect(currentWorkspaceFolderKey(null)).toBe(GENERAL_FOLDER);
    expect(currentWorkspaceFolderKey('')).toBe(GENERAL_FOLDER);
    expect(currentWorkspaceFolderKey('proj-1')).toBe('proj-1');
  });

  it('buildWorkspaceTabs appends general 对话', () => {
    const tabs = buildWorkspaceTabs([
      {
        id: 'p1',
        name: 'demo',
        path: 'C:/demo',
        addedAt: 1,
        lastOpenedAt: 2,
      },
    ]);
    expect(tabs.map((t) => t.id)).toEqual(['p1', GENERAL_FOLDER]);
    expect(tabs[1]?.kind).toBe('general');
    expect(activeWorkspaceTabId(null)).toBe(GENERAL_FOLDER);
    expect(activeWorkspaceTabId('p1')).toBe('p1');
  });

  it('sessionBelongsToWorkspace matches folder', () => {
    expect(sessionBelongsToWorkspace(undefined, GENERAL_FOLDER)).toBe(true);
    expect(sessionBelongsToWorkspace(GENERAL_FOLDER, GENERAL_FOLDER)).toBe(true);
    expect(sessionBelongsToWorkspace('p1', 'p1')).toBe(true);
    expect(sessionBelongsToWorkspace('p1', GENERAL_FOLDER)).toBe(false);
  });

  it('openSessionTab appends without reordering on re-focus', () => {
    if (typeof localStorage === 'undefined') return;
    openSessionTab('p1', 's1');
    openSessionTab('p1', 's2');
    openSessionTab('p1', 's3');
    // 打开顺序：s1, s2, s3（追加末尾，不把 active 拉到队首）
    expect(closeSessionTab('p1', 's3', 's3').ids).toEqual(['s1', 's2']);
    // 再点 s1：顺序不变
    openSessionTab('p1', 's1');
    openSessionTab('p1', 's2');
    const closed = closeSessionTab('p1', 's1', 's1');
    expect(closed.ids).toEqual(['s2']);
    expect(closed.nextActiveId).toBe('s2');
  });

  it('pruneOpenSessionTabs drops missing ids', () => {
    if (typeof localStorage === 'undefined') return;
    openSessionTab(GENERAL_FOLDER, 'a');
    openSessionTab(GENERAL_FOLDER, 'b');
    const next = pruneOpenSessionTabs(GENERAL_FOLDER, new Set(['b']));
    expect(next).toEqual(['b']);
    expect(localStorage.getItem(OPEN_SESSION_TABS_KEY)).toContain('b');
  });

  it('buildSessionTabsForWorkspace filters by folder and open order', () => {
    const map = new Map([
      ['s1', { title: '一', folder: 'p1' }],
      ['s2', { title: '二', folder: 'p1', isPinned: true }],
      ['s3', { title: '三', folder: GENERAL_FOLDER }],
    ]);
    const tabs = buildSessionTabsForWorkspace('p1', ['s2', 's1', 's3', 'missing'], map);
    expect(tabs.map((t) => t.sessionId)).toEqual(['s2', 's1']);
    expect(tabs[0]?.pinned).toBe(true);
  });
});
