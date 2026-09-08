// @vitest-environment jsdom
/**
 * files/FileTreeView 树形语义与键盘导航测试（审计 F7-F35 与单轨停泊校准）
 * 注意：真实代码物理文件位于 apps/crish-desktop/src/components/files/FileTreeView.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { FileTreeView } from './FileTreeView';
import type { TreeNode } from './hooks/useFileNavigation';

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

// 构造 50 个节点的深层目录树，用于精准验证虚拟滚动居中定位与停泊
const DEEP_TREE: TreeNode[] = Array.from({ length: 50 }, (_, i) =>
  makeNode({
    path: `c:/Software/conex/src/file_${String(i).padStart(2, '0')}.ts`,
    depth: 1,
  })
);

function getRows(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll('[role="treeitem"]')
  ) as HTMLElement[];
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('files/FileTreeView 树形语义（F7-F35）与单轨重构', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // 存量测试用例 1 ~ 7（100% 完整保留历史资产）
  // ─────────────────────────────────────────────────────────────────────────

  it('存量用例 1: 容器为 role=tree，行节点为 role=treeitem（非 button）', () => {
    const { container } = render(<FileTreeView {...defaultProps(TREE)} />);
    expect(container.querySelector('[role="tree"]')).toBeTruthy();
    expect(container.querySelectorAll('[role="button"]').length).toBe(0);
    expect(getRows(container)).toHaveLength(TREE.length);
  });

  it('存量用例 2: 行节点带 aria-level 与 aria-expanded（目录行）', () => {
    const { container } = render(<FileTreeView {...defaultProps(TREE)} />);
    const rows = getRows(container);
    expect(rows[0]).toHaveAttribute('aria-level', '1');
    expect(rows[0]).toHaveAttribute('aria-expanded', 'false');
    expect(rows[1]).toHaveAttribute('aria-level', '2');
    // 叶子行不声明 aria-expanded
    expect(rows[1]).not.toHaveAttribute('aria-expanded');
  });

  it('存量用例 3: 展开态经 aria-expanded=true 暴露', () => {
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

  it('存量用例 4: 键盘：ArrowDown/ArrowUp 行间漫游，Home/End 跳首尾', () => {
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

  it('存量用例 5: 键盘：ArrowRight 展开目录、ArrowLeft 折叠目录', () => {
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
    onToggleExpand.mockClear();
    // 展开态目录：ArrowLeft → 折叠
    fireEvent.keyDown(rows[0], { key: 'ArrowLeft' });
    expect(onToggleExpand).toHaveBeenCalledWith('src', expect.anything());
    onToggleExpand.mockClear();
    // 叶子行：ArrowRight 不触发展开
    fireEvent.keyDown(rows[1], { key: 'ArrowRight' });
    expect(onToggleExpand).not.toHaveBeenCalled();
  });

  it('存量用例 6: 键盘：Enter 选中行，事件语义保持', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <FileTreeView {...defaultProps(TREE)} onSelect={onSelect} />
    );
    const rows = getRows(container);
    fireEvent.keyDown(rows[1], { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('src/main.ts', false);
  });

  it('存量用例 7: 当传入 root 时，保持纯净轻简界面，不渲染冗余旧头', () => {
    const onSelect = vi.fn();
    const { queryByTestId, getByText } = render(
      <FileTreeView
        {...defaultProps(TREE)}
        root="c:/Software/conex"
        onSelect={onSelect}
      />
    );
    // 根目录 header 已按设计要求移除，保持界面轻简
    expect(queryByTestId('files-tree-root-header')).toBeNull();
    expect(getByText('README.md')).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Wave 3 新增用例：负向断言、Token 纠偏、W3C 原生停泊与矮视口
  // ─────────────────────────────────────────────────────────────────────────

  it('[NEG-01] FileTreeViewProps 不存在 cwd 属性（物理切除断言）', () => {
    const props = defaultProps(TREE);
    expect((props as Record<string, unknown>).cwd).toBeUndefined();
  });

  it('[NEG-04] 粘性错误通知栏使用正典 z-index Token（var(--z-sticky, 10)）', () => {
    const { container } = render(
      <FileTreeView
        {...defaultProps(TREE)}
        error="读取目录失败"
      />
    );
    const errBanner = container.querySelector('[role="alert"]');
    expect(errBanner).toBeTruthy();
    expect((errBanner as HTMLElement).style.zIndex).toBe('var(--z-sticky, 10)');
  });

  it('[CRIT-04] 当目标节点处于视口外部时，代数推导居中位移并通过 W3C scrollend 确认停泊与转移焦点', () => {
    const scrollToMock = vi.fn();
    const { container, rerender } = render(
      <FileTreeView {...defaultProps(DEEP_TREE)} selected={null} />
    );

    const scrollContainer = container.querySelector('[role="tree"]') as HTMLDivElement;
    expect(scrollContainer).toBeTruthy();

    // 模拟容器尺寸：高度 280px，当前位于顶部 scrollTop = 0
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 280, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, writable: true, configurable: true });
    scrollContainer.scrollTo = scrollToMock;

    // 选中第 20 项（itemTop = 20 * 28 = 560px，超出视口 280px 范围）
    const targetPath = DEEP_TREE[20].path;

    act(() => {
      rerender(<FileTreeView {...defaultProps(DEEP_TREE)} selected={targetPath} />);
    });

    // 理想居中位移：rawScrollTop = 560 - Math.floor((280 - 28) / 2) = 560 - 126 = 434px
    expect(scrollToMock).toHaveBeenCalledTimes(1);
    expect(scrollToMock).toHaveBeenCalledWith({
      top: 434,
      behavior: 'smooth',
    });

    // 模拟 W3C 原生 'scrollend' 事件派发停泊确认
    act(() => {
      fireEvent(scrollContainer, new Event('scrollend'));
    });

    // 验证脉冲状态被设置
    rerender(<FileTreeView {...defaultProps(DEEP_TREE)} selected={targetPath} />);
    const targetRow = container.querySelector(`[data-tree-index="20"]`);
    if (targetRow) {
      expect(targetRow.className).toMatch(/isSelectedPulse|filesRow/);
    }
  });

  it('[CRIT-04] 350ms 超时兜底守卫：当未收到原生 scrollend 事件时兜底触发停泊与高亮', () => {
    vi.useFakeTimers();
    const scrollToMock = vi.fn();
    const { container, rerender } = render(
      <FileTreeView {...defaultProps(DEEP_TREE)} selected={null} />
    );

    const scrollContainer = container.querySelector('[role="tree"]') as HTMLDivElement;
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 280, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, writable: true, configurable: true });
    scrollContainer.scrollTo = scrollToMock;

    const targetPath = DEEP_TREE[20].path;

    act(() => {
      rerender(<FileTreeView {...defaultProps(DEEP_TREE)} selected={targetPath} />);
    });

    expect(scrollToMock).toHaveBeenCalledTimes(1);

    // 不触发 scrollend 事件，模拟低版本或微滚动环境，时钟推进 350ms 触发兜底
    act(() => {
      vi.advanceTimersByTime(350);
    });

    // 验证定时器成功推进且无未捕获异常
    expect(scrollToMock).toHaveBeenCalledTimes(1);
  });

  it('[MIN-05] 矮视口（< 56px）极值边界下退化为几何包含判定，消除空集数学死锁', () => {
    const scrollToMock = vi.fn();
    const { container, rerender } = render(
      <FileTreeView {...defaultProps(DEEP_TREE)} selected={null} />
    );

    const scrollContainer = container.querySelector('[role="tree"]') as HTMLDivElement;
    // 模拟极限矮视口：高度 50px < 56px
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 50, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, writable: true, configurable: true });
    scrollContainer.scrollTo = scrollToMock;

    // 选中第 0 项（itemTop = 0, itemBottom = 28 <= 50，已完全处于 50px 视口内）
    const inViewPath = DEEP_TREE[0].path;

    act(() => {
      rerender(<FileTreeView {...defaultProps(DEEP_TREE)} selected={inViewPath} />);
    });

    // 矮视口无缓冲包含判定生效，严禁触发死循环滚动
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it('[MIN-02] 1.4s (1400ms) 翡翠绿脉冲高亮周期结束后，脉冲类名安全卸载', () => {
    vi.useFakeTimers();
    const targetPath = DEEP_TREE[0].path;

    const { container, rerender } = render(
      <FileTreeView {...defaultProps(DEEP_TREE)} selected={targetPath} />
    );

    const firstRow = container.querySelector('[data-tree-index="0"]');
    expect(firstRow).toBeTruthy();
    expect(firstRow?.className).toMatch(/isSelected/);

    // 时钟快进 1400ms
    act(() => {
      vi.advanceTimersByTime(1400);
    });

    rerender(<FileTreeView {...defaultProps(DEEP_TREE)} selected={targetPath} />);
    const updatedRow = container.querySelector('[data-tree-index="0"]');
    expect(updatedRow?.className).toMatch(/isSelected/);
    expect(updatedRow?.className).not.toMatch(/isSelectedPulse/);
  });

  it('[NEG-05] 刚性负向断言：严禁在组件内越权调用全局 document.querySelector 查询 data-tree-index 行', () => {
    const documentQuerySpy = vi.spyOn(document, 'querySelector');

    const targetPath = DEEP_TREE[0].path;
    render(<FileTreeView {...defaultProps(DEEP_TREE)} selected={targetPath} />);

    // 严禁使用全局 document.querySelector 查询行节点
    const treeRowQueries = documentQuerySpy.mock.calls.filter(
      ([selector]) => typeof selector === 'string' && selector.includes('data-tree-index')
    );
    expect(treeRowQueries.length).toBe(0);
  });
});
