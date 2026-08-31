// @vitest-environment jsdom
/**
 * files/FileTreeView 树形语义与键盘导航测试（审计 F7-F35）
 *
 * 缺陷：行是 role="button" + tabIndex 0，无 role="tree"/aria-level/
 * aria-expanded/aria-selected；展开钮 tabIndex=-1（焦点不可达）；
 * 键盘仅 Enter，无 ArrowUp/Down/Home/End 行间漫游——
 * 数千文件列表键盘只能逐 Tab 扫整树。
 *
 * 修复契约（ARIA tree pattern）：
 * 1. 容器 role="tree"，行 role="treeitem" + aria-level/aria-expanded；
 * 2. 键盘：↑↓ 行间漫游、Home/End 跳首尾、→ 展开、← 折叠、Enter 选中。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { FileTreeView } from './FileTreeView';
import type { TreeNode } from './FileSearchFilter';

function makeNode(partial: Partial<TreeNode> & { path: string }): TreeNode {
  return {
    name: partial.path.split('/').pop() ?? partial.path,
    isDir: false,
    depth: 0,
    ...partial,
  } as TreeNode;
}

function defaultProps(flatTree: TreeNode[]) {
  return {
    flatTree,
    selected: null,
    expanded: {},
    loading: false,
    error: '',
    filter: '',
    filterMode: false,
    gitStatusMap: {},
    onSelect: vi.fn(),
    onToggleExpand: vi.fn(),
    onDoubleClick: vi.fn(),
    onFilterChange: vi.fn(),
    onFilterModeToggle: vi.fn(),
    onErrorDismiss: vi.fn(),
  };
}

const TREE: TreeNode[] = [
  makeNode({ path: 'src', isDir: true, depth: 0 }),
  makeNode({ path: 'src/main.ts', depth: 1 }),
  makeNode({ path: 'src/util', isDir: true, depth: 1 }),
  makeNode({ path: 'src/util/helper.ts', depth: 2 }),
  makeNode({ path: 'README.md', depth: 0 }),
];

function getRows(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll('[role="treeitem"]')
  ) as HTMLElement[];
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('files/FileTreeView 树形语义（F7-F35）', () => {
  it('容器为 role=tree，行节点为 role=treeitem（非 button）', () => {
    const { container } = render(<FileTreeView {...defaultProps(TREE)} />);
    expect(container.querySelector('[role="tree"]')).toBeTruthy();
    expect(container.querySelectorAll('[role="button"]').length).toBe(0);
    expect(getRows(container)).toHaveLength(TREE.length);
  });

  it('行节点带 aria-level 与 aria-expanded（目录行）', () => {
    const { container } = render(<FileTreeView {...defaultProps(TREE)} />);
    const rows = getRows(container);
    expect(rows[0]).toHaveAttribute('aria-level', '1');
    expect(rows[0]).toHaveAttribute('aria-expanded', 'false');
    expect(rows[1]).toHaveAttribute('aria-level', '2');
    // 叶子行不声明 aria-expanded
    expect(rows[1]).not.toHaveAttribute('aria-expanded');
  });

  it('展开态经 aria-expanded=true 暴露', () => {
    const { container } = render(
      <FileTreeView
        {...defaultProps(TREE)}
        expanded={{ 'src': true, 'src/util': true }}
      />
    );
    const rows = getRows(container);
    expect(rows[0]).toHaveAttribute('aria-expanded', 'true');
    expect(rows[2]).toHaveAttribute('aria-expanded', 'true');
  });

  it('键盘：ArrowDown/ArrowUp 行间漫游，Home/End 跳首尾', () => {
    const { container } = render(<FileTreeView {...defaultProps(TREE)} />);
    const rows = getRows(container);
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1], { key: 'ArrowUp' });
    expect(rows[0]).toHaveFocus();
    fireEvent.keyDown(rows[0], { key: 'End' });
    expect(rows[rows.length - 1]).toHaveFocus();
    fireEvent.keyDown(rows[rows.length - 1], { key: 'Home' });
    expect(rows[0]).toHaveFocus();
  });

  it('键盘：ArrowRight 展开目录、ArrowLeft 折叠目录', () => {
    const onToggleExpand = vi.fn();
    const { container } = render(
      <FileTreeView
        {...defaultProps(TREE)}
        expanded={{ 'src': true }}
        onToggleExpand={onToggleExpand}
      />
    );
    const rows = getRows(container);
    // 折叠态目录：ArrowRight → 展开
    fireEvent.keyDown(rows[2], { key: 'ArrowRight' });
    expect(onToggleExpand).toHaveBeenCalledWith('src/util', expect.anything());
    // 展开态目录：ArrowLeft → 折叠
    onToggleExpand.mockClear();
    fireEvent.keyDown(rows[0], { key: 'ArrowLeft' });
    expect(onToggleExpand).toHaveBeenCalledWith('src', expect.anything());
    // 叶子行：ArrowRight 不触发展开
    onToggleExpand.mockClear();
    fireEvent.keyDown(rows[1], { key: 'ArrowRight' });
    expect(onToggleExpand).not.toHaveBeenCalled();
  });

  it('键盘：Enter 选中行，事件语义保持', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <FileTreeView {...defaultProps(TREE)} onSelect={onSelect} />
    );
    const rows = getRows(container);
    fireEvent.keyDown(rows[1], { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('src/main.ts', false);
  });

  it('当传入 root 时，树顶部固化渲染 Project Root Header 容器 (📁 conex)', () => {
    const onSelect = vi.fn();
    const { getByTestId } = render(
      <FileTreeView
        {...defaultProps(TREE)}
        root="c:/Software/conex"
        onSelect={onSelect}
      />
    );
    const header = getByTestId('files-tree-root-header');
    expect(header).toBeTruthy();
    expect(header.textContent).toContain('conex');
    expect(header.textContent).toContain('c:/Software/conex');

    fireEvent.click(header);
    expect(onSelect).toHaveBeenCalledWith('c:/Software/conex', true);
  });
});
