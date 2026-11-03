// @vitest-environment jsdom
/**
 * FileTreeContextMenu 契约：文件/目录条目集与真能力回调接线。
 * （资源管理器/系统打开等 API 条目只断言存在，不在 jsdom 内触发 Tauri 命令。）
 * 查询一律收进本菜单容器（data-testid）并用精确无障碍名——全量运行下
 * 同 worker 其它菜单的 DOM 会串扰文档级正则查询。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from '@testing-library/react';
import { FileTreeContextMenu } from './FileTreeContextMenu';
import { layerStackService } from '@/components/ui';
import type { HostOpener } from '../../api/hostOpenersApi';
import type { TreeNode } from './hooks/useFileNavigation';

const fileNode = {
  path: 'C:/ws/src/main.ts',
  name: 'main.ts',
  isDir: false,
  depth: 1,
} as TreeNode;

const dirNode = {
  path: 'C:/ws/src',
  name: 'src',
  isDir: true,
  depth: 0,
} as TreeNode;

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  vi.restoreAllMocks();
});

async function renderMenu(ui: React.ReactElement) {
  render(ui);
  const menu = await screen.findByTestId('file-tree-context-menu');
  return within(menu);
}

describe('FileTreeContextMenu', () => {
  it('文件节点：打开/系统默认打开/资源管理器/复制路径条目齐全，回调按 path 定向', async () => {
    const onOpen = vi.fn();
    const onCopyPath = vi.fn();
    const items = await renderMenu(
      <FileTreeContextMenu
        node={fileNode}
        x={10}
        y={10}
        anchorEl={null}
        isExpanded={false}
        fileOpeners={[]}
        onClose={vi.fn()}
        onOpen={onOpen}
        onCopyPath={onCopyPath}
      />
    );
    expect(items.getByRole('menuitem', { name: '打开' })).toBeInTheDocument();
    expect(
      items.getByRole('menuitem', { name: '用系统默认打开' })
    ).toBeInTheDocument();
    expect(
      items.getByRole('menuitem', { name: '在资源管理器中显示' })
    ).toBeInTheDocument();
    // 无宿主打开器时不渲染「打开方式」子菜单
    expect(
      items.queryByRole('menuitem', { name: '打开方式' })
    ).not.toBeInTheDocument();

    fireEvent.click(items.getByRole('menuitem', { name: '复制相对路径' }));
    expect(onCopyPath).toHaveBeenCalledWith('C:/ws/src/main.ts', 'rel');

    fireEvent.click(items.getByRole('menuitem', { name: '打开' }));
    expect(onOpen).toHaveBeenCalledWith('C:/ws/src/main.ts', false);
  });

  it('目录节点：展开/折叠与复制路径，无文件专属条目', async () => {
    const onOpen = vi.fn();
    const items = await renderMenu(
      <FileTreeContextMenu
        node={dirNode}
        x={10}
        y={10}
        anchorEl={null}
        isExpanded={false}
        fileOpeners={[]}
        onClose={vi.fn()}
        onOpen={onOpen}
        onCopyPath={vi.fn()}
      />
    );
    const expandItem = items.getByRole('menuitem', { name: '展开' });
    expect(
      items.queryByRole('menuitem', { name: '用系统默认打开' })
    ).not.toBeInTheDocument();
    fireEvent.click(expandItem);
    expect(onOpen).toHaveBeenCalledWith('C:/ws/src', true);
  });

  it('有打开器时渲染「打开方式」子菜单触发器', async () => {
    const items = await renderMenu(
      <FileTreeContextMenu
        node={fileNode}
        x={10}
        y={10}
        anchorEl={null}
        isExpanded={false}
        fileOpeners={[
          { id: 'vscode', displayName: 'VS Code' } as unknown as HostOpener,
        ]}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onCopyPath={vi.fn()}
      />
    );
    expect(
      items.getByRole('menuitem', { name: '打开方式' })
    ).toBeInTheDocument();
  });
});
