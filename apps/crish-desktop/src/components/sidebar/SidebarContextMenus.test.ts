import { describe, expect, it } from 'vitest';
import {
  archiveUndoToastMessage,
  branchUndoToastMessage,
  BRANCH_TITLE_SUFFIX,
  clampContextMenuPosition,
} from './SidebarContextMenus';

describe('SidebarContextMenus toast + position helpers', () => {
  it('archive/branch undo toasts match toast policy prefixes', () => {
    expect(archiveUndoToastMessage('某会话')).toBe('已归档: 某会话');
    expect(branchUndoToastMessage('某会话')).toBe('已分叉: 某会话');
    expect(archiveUndoToastMessage('测试')).toMatch(/^已归档:/);
    expect(branchUndoToastMessage('测试')).toMatch(/^已分叉:/);
  });

  it('branch title suffix is stable for list display', () => {
    expect(`会话${BRANCH_TITLE_SUFFIX}`).toBe('会话 - 分支');
  });

  it('clamps menu coords inside viewport padding', () => {
    const iw = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const ih = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    // 强制走 0→1280×800 fallback，避免 jsdom 异常大视口
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 0,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 0,
    });
    try {
      const nearOrigin = clampContextMenuPosition(-20, -10, 160, 200);
      expect(nearOrigin.x).toBe(8);
      expect(nearOrigin.y).toBe(8);

      const far = clampContextMenuPosition(99999, 99999, 160, 200);
      expect(far.x).toBe(1280 - 160 - 8);
      expect(far.y).toBe(800 - 200 - 8);

      const mid = clampContextMenuPosition(100, 120, 160, 200);
      expect(mid.x).toBe(100);
      expect(mid.y).toBe(120);
      expect(mid.transformOrigin).toMatch(/top|bottom/);
    } finally {
      if (iw) Object.defineProperty(window, 'innerWidth', iw);
      if (ih) Object.defineProperty(window, 'innerHeight', ih);
    }
  });
});
