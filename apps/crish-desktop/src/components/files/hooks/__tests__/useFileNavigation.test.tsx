// @vitest-environment jsdom
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.__navResult;
});

describe('useFileNavigation 单轨收敛与祖先展开 Hook 验证', () => {
  describe('isDirty 脏状态判定', () => {
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

  describe('ConfirmGate 安全门契约完整性', () => {
    it('非脏状态下直接放行且不弹出对话框', async () => {
      render(<Harness dirty={false} />);
      fireEvent.click(screen.getByText('触发导航'));
      await act(async () => {});
      expect(window.__navResult).toBe(true);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('脏状态下拦截并展示未保存提示，点击继续切换放行', async () => {
      render(<Harness dirty={true} />);
      fireEvent.click(screen.getByText('触发导航'));
      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveTextContent('当前文件未保存，切换将丢失修改，是否继续？');

      fireEvent.click(screen.getByRole('button', { name: '继续切换' }));
      await act(async () => {});
      expect(window.__navResult).toBe(true);
    });

    it('脏状态下点击取消则拒绝导航', async () => {
      render(<Harness dirty={true} />);
      fireEvent.click(screen.getByText('触发导航'));
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      await act(async () => {});
      expect(window.__navResult).toBe(false);
    });
  });

  describe('revealPath 祖先并发补拉与单轨不变量', () => {
    it('Windows 反斜杠深层路径能够正确并发补拉各级祖先，并保证规范键 100% 命中', async () => {
      vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue('C:/repo');

      vi.spyOn(workspaceFsApi, 'resolveWorkspacePath').mockImplementation((p) =>
        p.replace(/\\/g, '/')
      );
      vi.spyOn(workspaceFsApi, 'assertWorkspacePath').mockImplementation((p) => {
        return p.replace(/\\/g, '/');
      });

      vi.spyOn(workspaceFsApi, 'listDirectory').mockImplementation(async (dir) => {
        const norm = dir.replace(/\\/g, '/').toLowerCase();
        if (norm === 'c:/repo') {
          return [
            { name: 'apps', path: 'C:/repo/apps', isDir: true },
            { name: 'package.json', path: 'C:/repo/package.json', isDir: false },
          ];
        }
        if (norm === 'c:/repo/apps') {
          return [
            { name: 'crish-desktop', path: 'C:/repo/apps/crish-desktop', isDir: true },
          ];
        }
        if (norm === 'c:/repo/apps/crish-desktop') {
          return [
            { name: 'src', path: 'C:/repo/apps/crish-desktop/src', isDir: true },
          ];
        }
        if (norm === 'c:/repo/apps/crish-desktop/src') {
          return [
            { name: 'App.tsx', path: 'C:/repo/apps/crish-desktop/src/App.tsx', isDir: false },
          ];
        }
        return [];
      });

      const { result } = renderHook(() => useFileNavigation());

      let ok: boolean = false;
      await act(async () => {
        ok = await result.current.revealPath('C:\\repo\\apps\\crish-desktop\\src\\App.tsx');
      });

      expect(ok).toBe(true);
      expect(result.current.root).toBe('C:/repo');

      // 验证各级祖先全部注入 expanded 字典，键恒为规范格式（正斜杠）
      expect(
        result.current.expanded['c:/repo/apps'] || result.current.expanded['C:/repo/apps']
      ).toBeDefined();
      expect(
        result.current.expanded['c:/repo/apps/crish-desktop'] ||
          result.current.expanded['C:/repo/apps/crish-desktop']
      ).toBeDefined();
      expect(
        result.current.expanded['c:/repo/apps/crish-desktop/src'] ||
          result.current.expanded['C:/repo/apps/crish-desktop/src']
      ).toBeDefined();

      // 验证 flatTree 成功递归展开至目标文件 App.tsx
      const flatPaths = result.current.flatTree.map((node) =>
        node.path.replace(/\\/g, '/').toLowerCase()
      );
      expect(flatPaths).toContain('c:/repo/apps/crish-desktop/src/app.tsx');
    });

    it('传入工作区外部路径时安全返回 false，绝不篡改树根与当前展开状态', async () => {
      vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue('C:/repo');
      vi.spyOn(workspaceFsApi, 'assertWorkspacePath').mockImplementation(() => {
        throw new Error('访问被拒绝：路径超出工作区安全边界');
      });

      const { result } = renderHook(() => useFileNavigation());

      let ok: boolean = true;
      await act(async () => {
        ok = await result.current.revealPath('D:\\outside\\evil.txt');
      });

      expect(ok).toBe(false);
      expect(result.current.root).toBe('C:/repo');
      expect(result.current.error).toBe('访问被拒绝：路径超出工作区安全边界');
    });
  });

  describe('【CRIT-03 根治断言】祖先并发补拉异常回写与错误状态机', () => {
    it('当部分直系祖先拉取因权限失败，成功项原子写入 expanded，失败项收集回写 setError', async () => {
      vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue('C:/repo');
      vi.spyOn(workspaceFsApi, 'resolveWorkspacePath').mockImplementation((p) =>
        p.replace(/\\/g, '/')
      );
      vi.spyOn(workspaceFsApi, 'assertWorkspacePath').mockImplementation((p) =>
        p.replace(/\\/g, '/')
      );

      vi.spyOn(workspaceFsApi, 'listDirectory').mockImplementation(async (dir) => {
        const norm = dir.replace(/\\/g, '/').toLowerCase();
        if (norm === 'c:/repo') {
          return [{ name: 'secure', path: 'C:/repo/secure', isDir: true }];
        }
        if (norm === 'c:/repo/secure') {
          // 模拟第一级拉取成功
          return [{ name: 'hidden', path: 'C:/repo/secure/hidden', isDir: true }];
        }
        if (norm === 'c:/repo/secure/hidden') {
          // 模拟第二级权限拒绝
          throw new Error('EACCES: permission denied');
        }
        return [];
      });

      const { result } = renderHook(() => useFileNavigation());

      let ok: boolean = false;
      await act(async () => {
        ok = await result.current.revealPath('C:/repo/secure/hidden/secret.txt');
      });

      // 部分成功时仍然展开已成功的节点
      expect(ok).toBe(true);
      expect(result.current.expanded['c:/repo/secure']).toBeDefined();
      // 核心断言（CRIT-03）：严禁吞咽异常，必须真实写回 setError！
      expect(result.current.error).toContain('部分祖先目录无法展开');
      expect(result.current.error).toContain('EACCES: permission denied');
    });

    it('当所有未展开祖先拉取全部失败时，返回 false 且聚合回写 setError', async () => {
      vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue('C:/repo');
      vi.spyOn(workspaceFsApi, 'resolveWorkspacePath').mockImplementation((p) =>
        p.replace(/\\/g, '/')
      );
      vi.spyOn(workspaceFsApi, 'assertWorkspacePath').mockImplementation((p) =>
        p.replace(/\\/g, '/')
      );

      vi.spyOn(workspaceFsApi, 'listDirectory').mockImplementation(async (dir) => {
        const norm = dir.replace(/\\/g, '/').toLowerCase();
        if (norm === 'c:/repo') {
          return [{ name: 'broken', path: 'C:/repo/broken', isDir: true }];
        }
        throw new Error('IO error: disk unreadable');
      });

      const { result } = renderHook(() => useFileNavigation());

      let ok: boolean = true;
      await act(async () => {
        ok = await result.current.revealPath('C:/repo/broken/file.txt');
      });

      expect(ok).toBe(false);
      expect(result.current.error).toContain('部分祖先目录无法展开: IO error: disk unreadable');
    });
  });

  describe('【MIN-04 根治断言】flatTree 深度熔断与符号链接防环', () => {
    it('当目录树存在软链接循环引用时，防环机制保证不会死循环溢出', async () => {
      vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue('C:/repo');
      const { result } = renderHook(() => useFileNavigation());

      // 构造循环引用的 expanded 字典：a -> b -> a
      await act(async () => {
        result.current.setEntries([
          { name: 'folderA', path: 'c:/repo/a', isDir: true },
        ]);
        result.current.setExpanded({
          'c:/repo/a': [{ name: 'folderB', path: 'c:/repo/b', isDir: true }],
          'c:/repo/b': [{ name: 'loopToA', path: 'c:/repo/a', isDir: true }],
        });
      });

      // 验证 flatTree useMemo 不会陷入死循环崩溃
      expect(result.current.flatTree).toBeDefined();
      const nodePaths = result.current.flatTree.map((n) => n.path);
      // visitedPaths 只挡递归展开、不挡节点发射：a 从 entries 发射一次（depth 0）、经 b 回环再发射一次（depth 2）即止
      expect(nodePaths.filter((p) => p === 'c:/repo/a').length).toBeLessThanOrEqual(2);
      expect(nodePaths.filter((p) => p === 'c:/repo/b').length).toBe(1);
      // 环路被拦截：递归深度严格有界（0 → 1 → 2），绝不无限递归
      const maxDepth = Math.max(...result.current.flatTree.map((n) => n.depth));
      expect(maxDepth).toBeLessThanOrEqual(2);
    });

    it('当目录层级超过 MAX_DEPTH = 32 时强制熔断截断', async () => {
      vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue('C:/repo');
      const { result } = renderHook(() => useFileNavigation());

      // 构造超深嵌套字典（深度 40）
      const mockExpanded: Record<string, workspaceFsApi.FsDirEntry[]> = {};
      for (let i = 0; i < 40; i++) {
        mockExpanded[`c:/repo/d${i}`] = [
          { name: `d${i + 1}`, path: `c:/repo/d${i + 1}`, isDir: true },
        ];
      }

      await act(async () => {
        result.current.setEntries([
          { name: 'd0', path: 'c:/repo/d0', isDir: true },
        ]);
        result.current.setExpanded(mockExpanded);
      });

      // 断言最大深度严格受到 32 熔断限制
      const maxRenderedDepth = Math.max(
        ...result.current.flatTree.map((n) => n.depth)
      );
      expect(maxRenderedDepth).toBeLessThanOrEqual(32);
    });
  });

  describe('refresh 单轨刷新与树根绝对锁定', () => {
    it('调用 refresh() 时强制仅刷新工作区根目录，重置 expanded', async () => {
      vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue('C:/repo');
      const listDirSpy = vi.spyOn(workspaceFsApi, 'listDirectory').mockResolvedValue([
        { name: 'src', path: 'C:/repo/src', isDir: true },
      ]);

      const { result } = renderHook(() => useFileNavigation());

      await act(async () => {
        result.current.setExpanded({ 'c:/repo/src': [] });
        await result.current.refresh();
      });

      expect(listDirSpy).toHaveBeenCalledWith(expect.stringMatching(/^[cC]:\/repo$/));
      expect(result.current.root).toBe('C:/repo');
      expect(result.current.expanded).toEqual({});
    });
  });

  describe('【NEG-01 刚性负向断言】彻底物理删除 cwd、setCwd 与 goUp', () => {
    it('[NEG-01] Hook 返回值中绝对不存在 cwd、setCwd 与 goUp 属性', () => {
      const { result } = renderHook(() => useFileNavigation());
      const hookReturn = result.current as Record<string, unknown>;

      // 刚性负向断言：废弃属性在运行时必须为 undefined
      expect(hookReturn.cwd).toBeUndefined();
      expect(hookReturn.setCwd).toBeUndefined();
      expect(hookReturn.goUp).toBeUndefined();

      // 正向完整性校验：核心合法字段全部完备
      expect(hookReturn.root).toBeDefined();
      expect(hookReturn.entries).toBeDefined();
      expect(hookReturn.expanded).toBeDefined();
      expect(hookReturn.flatTree).toBeDefined();
      expect(hookReturn.toggleExpand).toBeDefined();
      expect(hookReturn.revealPath).toBeDefined();
      expect(hookReturn.refresh).toBeDefined();
    });
  });
});
