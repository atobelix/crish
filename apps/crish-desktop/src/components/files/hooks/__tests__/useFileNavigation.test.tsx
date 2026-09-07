// @vitest-environment jsdom
/**
 * useFileNavigation 测试（批次 4.1 更新，04-detail §2.1.2 行为变更清单）：
 * confirmNavigation 签名不变（Promise<boolean>，5 个调用点零改动）；
 * 确认→true 继续 / 取消→false 不继续；非 dirty 不弹窗（条件不变量）。
 * 注意：useFileNavigation 使用 ConfirmDialog Promise 桥，渲染物经
 * confirmGateView 暴露——弹窗两路径用宿主 Harness 渲染后交互结算。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, renderHook, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';
import { useFileNavigation } from '../useFileNavigation';
import * as workspaceFsApi from '../../../../api/workspaceFsApi';
import * as projectStore from '../../../../api/projectStore';

/** 宿主 Harness：渲染 hook 的 confirmGateView（等价 FilesCard 的挂载方式） */
function Harness({ dirty }: { dirty: boolean }) {
  const nav = useFileNavigation(() => dirty);
  return (
    <div>
      {nav.confirmGateView}
      <button
        type="button"
        onClick={() => {
          void nav.confirmNavigation().then((ok) => {
            window.__navResult = ok;
          });
        }}
      >
        触发导航
      </button>
    </div>
  );
}

declare global {
  interface Window {
    __navResult?: boolean;
  }
}

function openDialog() {
  fireEvent.click(screen.getByText('触发导航'));
  return screen.getByRole('alertdialog');
}

async function settle(action: 'confirm' | 'cancel') {
  fireEvent.click(
    action === 'confirm'
      ? screen.getByRole('button', { name: '继续切换' })
      : screen.getByRole('button', { name: '取消' })
  );
  await act(async () => {});
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.__navResult;
});

describe('useFileNavigation', () => {
  describe('isDirty', () => {
    it('returns false when getIsDirty is not provided', () => {
      const { result } = renderHook(() => useFileNavigation());
      expect(result.current.isDirty()).toBe(false);
    });

    it('returns false when getIsDirty returns false', () => {
      const { result } = renderHook(() => useFileNavigation(() => false));
      expect(result.current.isDirty()).toBe(false);
    });

    it('returns true when getIsDirty returns true', () => {
      const { result } = renderHook(() => useFileNavigation(() => true));
      expect(result.current.isDirty()).toBe(true);
    });

    it('reflects updated getIsDirty value via ref', () => {
      const getIsDirty = vi.fn(() => false);
      const { result } = renderHook(() => useFileNavigation(getIsDirty));
      expect(result.current.isDirty()).toBe(false);

      getIsDirty.mockReturnValue(true);
      expect(result.current.isDirty()).toBe(true);
    });
  });

  describe('confirmNavigation', () => {
    it('returns true without opening dialog when not dirty', async () => {
      render(<Harness dirty={false} />);
      fireEvent.click(screen.getByText('触发导航'));
      await act(async () => {});
      expect(window.__navResult).toBe(true);
      // 条件不变量：未 dirty 时不弹窗
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('shows confirm dialog and resolves true when dirty → 确认继续', async () => {
      render(<Harness dirty />);
      const dialog = openDialog();
      expect(dialog).toHaveAttribute('role', 'alertdialog');
      // 原 confirm 全文入 description
      expect(
        document.getElementById(dialog.getAttribute('aria-describedby')!)
      ).toHaveTextContent('当前文件未保存，切换将丢失修改，是否继续？');
      await settle('confirm');
      expect(window.__navResult).toBe(true);
    });

    it('resolves false when dirty → 取消（不继续）', async () => {
      render(<Harness dirty />);
      openDialog();
      await settle('cancel');
      expect(window.__navResult).toBe(false);
    });
  });

  describe('revealPath 路径漫游与祖先级联展开', () => {
    it('对工作区内部文件级联展开所有祖先目录，并保持根目录完整不被冲掉', async () => {
      vi.spyOn(workspaceFsApi, 'resolveWorkspacePath').mockImplementation((p) =>
        p.replace(/\\/g, '/')
      );
      vi.spyOn(workspaceFsApi, 'listDirectory').mockImplementation(
        async (dir) => {
          const d = dir.replace(/\\/g, '/');
          if (d === 'C:/project') {
            return [
              {
                name: 'skill',
                path: 'C:/project/skill',
                isDir: true,
                size: 0,
                mtime: 0,
              },
              {
                name: 'README.md',
                path: 'C:/project/README.md',
                isDir: false,
                size: 100,
                mtime: 0,
              },
            ];
          }
          if (d === 'C:/project/skill') {
            return [
              {
                name: 'design',
                path: 'C:/project/skill/design',
                isDir: true,
                size: 0,
                mtime: 0,
              },
            ];
          }
          if (d === 'C:/project/skill/design') {
            return [
              {
                name: 'jakub-skills',
                path: 'C:/project/skill/design/jakub-skills',
                isDir: true,
                size: 0,
                mtime: 0,
              },
              {
                name: 'apple-design.md',
                path: 'C:/project/skill/design/apple-design.md',
                isDir: false,
                size: 200,
                mtime: 0,
              },
            ];
          }
          return [];
        }
      );

      vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue('C:/project');

      const { result } = renderHook(() => useFileNavigation());

      await act(async () => {
        result.current.setCwd('C:/project');
        await result.current.revealPath(
          'C:/project/skill/design/apple-design.md'
        );
      });


      // 验证根目录保持为 C:/project，未被暴力截断为 C:/project/skill/design
      expect(result.current.cwd).toBe('C:/project');
      // 验证祖先目录均已被级联展开
      expect(result.current.expanded['C:/project/skill']).toBeDefined();
      expect(result.current.expanded['C:/project/skill/design']).toBeDefined();
    });
  });
});
