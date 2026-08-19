import { describe, expect, it } from 'vitest';
import {
  archiveUndoToastMessage,
  branchUndoToastMessage,
  BRANCH_TITLE_SUFFIX,
} from './SidebarContextMenus';

// 坐标钳位单测已随 T05.3.1 收敛到 ui/Menu/position.test.ts（clampPosition/measureMenu）

describe('SidebarContextMenus toast helpers', () => {
  it('archive/branch undo toasts match toast policy prefixes', () => {
    expect(archiveUndoToastMessage('某会话')).toBe('已归档: 某会话');
    expect(branchUndoToastMessage('某会话')).toBe('已分叉: 某会话');
    expect(archiveUndoToastMessage('测试')).toMatch(/^已归档:/);
    expect(branchUndoToastMessage('测试')).toMatch(/^已分叉:/);
  });

  it('branch title suffix is stable for list display', () => {
    expect(`会话${BRANCH_TITLE_SUFFIX}`).toBe('会话 - 分支');
  });

  it('toast 文案吃展示标题，不回退「未命名会话」字面', () => {
    expect(archiveUndoToastMessage('新会话')).toBe('已归档: 新会话');
    expect(branchUndoToastMessage('新会话')).toBe('已分叉: 新会话');
    expect(archiveUndoToastMessage('某会话')).not.toMatch(/未命名会话/);
  });
});
