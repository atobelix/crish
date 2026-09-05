// @vitest-environment jsdom
/**
 * NoteSidebarDrawer · 笔记抽屉管理侧栏与像素级会话项对齐测试套件
 *
 * 验证规范：
 * 1. 列表项像素级对齐 SidebarSessionList 规范（28px 高、8px 圆角、纯净底色与柔和选中态、彻底切除“139 块”技术名词）；
 * 2. 标题单行省略，平时显示微光相对时间，hover / focus 时原地淡入操作按钮；
 * 3. 抽屉收起按钮采用项目原生 IconSidebarLeft，保全关键 testid（note-sidebar-create-btn, note-sidebar-close-btn）；
 * 4. 行内重命名（F2 / 点击重命名按钮 / Enter 保存 / Escape 取消 / 失焦保存）；
 * 5. 删除二次确认与物理删除联动；
 * 6. 搜索输入与空状态提示。
 */
import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NoteSidebarDrawer } from './NoteSidebarDrawer';
import type { NoteDocumentMeta } from '../../api/noteDocumentContracts';
import styles from './NoteSidebarDrawer.module.css';

afterEach(() => {
  cleanup();
});

const mockDocs: NoteDocumentMeta[] = [
  {
    id: 'doc-1',
    title: '架构重构规划',
    updatedAt: Date.now() - 1000 * 60 * 5, // 5 分钟前
    blockCount: 42,
  },
  {
    id: 'doc-2',
    title: '用户界面设计规范',
    updatedAt: Date.now() - 1000 * 60 * 60 * 3, // 3 小时前
    blockCount: 139,
  },
];

function renderDrawer(props: Partial<React.ComponentProps<typeof NoteSidebarDrawer>> = {}) {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    documents: mockDocs,
    activeDocId: 'doc-1',
    onSelectDoc: vi.fn(),
    onCreateDoc: vi.fn(),
    onRenameDoc: vi.fn(),
    onDeleteDoc: vi.fn(),
    searchQuery: '',
    onSearchChange: vi.fn(),
  };

  return render(<NoteSidebarDrawer {...defaultProps} {...props} />);
}

describe('NoteSidebarDrawer · 像素级对齐会话项与去噪验证套件', () => {
  it('抽屉展开与收起样式类名正确', () => {
    const { rerender } = renderDrawer({ isOpen: true });
    const drawer = screen.getByTestId('note-sidebar-drawer');
    expect(drawer).toHaveClass(styles.isOpen);
    expect(drawer).not.toHaveClass(styles.isClosed);

    rerender(
      <NoteSidebarDrawer
        isOpen={false}
        onClose={vi.fn()}
        documents={mockDocs}
        activeDocId="doc-1"
        onSelectDoc={vi.fn()}
        onCreateDoc={vi.fn()}
        onRenameDoc={vi.fn()}
        onDeleteDoc={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
      />
    );
    expect(drawer).toHaveClass(styles.isClosed);
  });

  it('列表项严格对齐 SessionItem 规范：包含 sessionItem 类，active 态包含 active 类，无任何 139 块等技术名词徽章', () => {
    renderDrawer({ activeDocId: 'doc-1' });

    const item1 = screen.getByTestId('note-card-doc-1');
    const item2 = screen.getByTestId('note-card-doc-2');

    // 对齐 sessionItem 类
    expect(item1).toHaveClass(styles.sessionItem);
    expect(item2).toHaveClass(styles.sessionItem);

    // activeDocId 高亮选中态
    expect(item1).toHaveClass(styles.active);
    expect(item2).not.toHaveClass(styles.active);

    // 标题文本单行展示
    expect(item1).toHaveTextContent('架构重构规划');
    expect(item2).toHaveTextContent('用户界面设计规范');

    // 负向测试：绝对禁止技术名词“139 块”或“42 块”泄漏在 DOM 中！
    expect(screen.queryByText(/139\s*块/)).toBeNull();
    expect(screen.queryByText(/42\s*块/)).toBeNull();
    expect(screen.queryByText(/块/)).toBeNull();
  });

  it('保全关键测试桩：新建笔记按钮 note-sidebar-create-btn 与收起按钮 note-sidebar-close-btn', () => {
    const onCreateDoc = vi.fn();
    const onClose = vi.fn();

    renderDrawer({ onCreateDoc, onClose });

    const createBtn = screen.getByTestId('note-sidebar-create-btn');
    expect(createBtn).toBeInTheDocument();
    fireEvent.click(createBtn);
    expect(onCreateDoc).toHaveBeenCalledTimes(1);

    const closeBtn = screen.getByTestId('note-sidebar-close-btn');
    expect(closeBtn).toBeInTheDocument();
    // 验证收起按钮内包含 svg (IconSidebarLeft)
    expect(closeBtn.querySelector('svg')).toBeInTheDocument();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点击列表项或回车触发 onSelectDoc', () => {
    const onSelectDoc = vi.fn();
    renderDrawer({ onSelectDoc });

    const item2 = screen.getByTestId('note-card-doc-2');
    fireEvent.click(item2);
    expect(onSelectDoc).toHaveBeenCalledWith('doc-2');

    fireEvent.keyDown(item2, { key: 'Enter', code: 'Enter' });
    expect(onSelectDoc).toHaveBeenCalledWith('doc-2');
  });

  it('支持行内重命名：通过 F2 键启动，按 Enter 提交修改', () => {
    const onRenameDoc = vi.fn();
    renderDrawer({ onRenameDoc });

    const item1 = screen.getByTestId('note-card-doc-1');
    fireEvent.keyDown(item1, { key: 'F2', code: 'F2' });

    const input = screen.getByRole('textbox', { name: '重命名笔记' });
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('架构重构规划');

    fireEvent.change(input, { target: { value: '全新架构详案' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onRenameDoc).toHaveBeenCalledWith('doc-1', '全新架构详案');
    expect(screen.queryByRole('textbox', { name: '重命名笔记' })).toBeNull();
  });

  it('支持行内重命名：失焦（blur）自动保存重命名', () => {
    const onRenameDoc = vi.fn();
    renderDrawer({ onRenameDoc });

    const item1 = screen.getByTestId('note-card-doc-1');
    fireEvent.keyDown(item1, { key: 'F2', code: 'F2' });

    const input = screen.getByRole('textbox', { name: '重命名笔记' });
    fireEvent.change(input, { target: { value: '失焦自动保存' } });
    fireEvent.blur(input);

    expect(onRenameDoc).toHaveBeenCalledWith('doc-1', '失焦自动保存');
  });

  it('行内重命名：按 Escape 取消重命名不触发回调', () => {
    const onRenameDoc = vi.fn();
    renderDrawer({ onRenameDoc });

    const item1 = screen.getByTestId('note-card-doc-1');
    fireEvent.keyDown(item1, { key: 'F2', code: 'F2' });

    const input = screen.getByRole('textbox', { name: '重命名笔记' });
    fireEvent.change(input, { target: { value: '取消的标题' } });
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });

    expect(onRenameDoc).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: '重命名笔记' })).toBeNull();
  });

  it('点击操作栏重命名按钮可进入编辑态', () => {
    renderDrawer();

    const renameBtns = screen.getAllByRole('button', { name: '重命名' });
    expect(renameBtns.length).toBe(2);

    fireEvent.click(renameBtns[0]);
    expect(screen.getByRole('textbox', { name: '重命名笔记' })).toBeInTheDocument();
  });

  it('删除操作二次确认弹窗：点击取消不删除，点击确认执行物理删除', () => {
    const onDeleteDoc = vi.fn();
    renderDrawer({ onDeleteDoc });

    const deleteBtns = screen.getAllByRole('button', { name: '删除笔记' });
    expect(deleteBtns.length).toBe(2);

    // 1. 点击删除按钮弹出二次确认浮层
    fireEvent.click(deleteBtns[0]);
    expect(screen.getByText('确认删除笔记？')).toBeInTheDocument();

    // 2. 点击取消
    const cancelBtn = screen.getByRole('button', { name: '取消' });
    fireEvent.click(cancelBtn);
    expect(screen.queryByText('确认删除笔记？')).toBeNull();
    expect(onDeleteDoc).not.toHaveBeenCalled();

    // 3. 再次点击并确认删除
    fireEvent.click(deleteBtns[0]);
    const confirmBtn = screen.getByTestId('confirm-delete-btn');
    fireEvent.click(confirmBtn);
    expect(onDeleteDoc).toHaveBeenCalledWith('doc-1');
    expect(screen.queryByText('确认删除笔记？')).toBeNull();
  });

  it('搜索输入响应与空状态展现', () => {
    const onSearchChange = vi.fn();
    const { rerender } = renderDrawer({ onSearchChange, searchQuery: '' });

    const searchInput = screen.getByRole('searchbox', { name: '搜索笔记' });
    fireEvent.change(searchInput, { target: { value: '架构' } });
    expect(onSearchChange).toHaveBeenCalledWith('架构');

    // 空列表状态测试
    rerender(
      <NoteSidebarDrawer
        isOpen={true}
        onClose={vi.fn()}
        documents={[]}
        activeDocId=""
        onSelectDoc={vi.fn()}
        onCreateDoc={vi.fn()}
        onRenameDoc={vi.fn()}
        onDeleteDoc={vi.fn()}
        searchQuery="未命中"
        onSearchChange={vi.fn()}
      />
    );
    expect(screen.getByText('未找到匹配的笔记')).toBeInTheDocument();

    rerender(
      <NoteSidebarDrawer
        isOpen={true}
        onClose={vi.fn()}
        documents={[]}
        activeDocId=""
        onSelectDoc={vi.fn()}
        onCreateDoc={vi.fn()}
        onRenameDoc={vi.fn()}
        onDeleteDoc={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
      />
    );
    expect(screen.getByText('暂无笔记，点击上方“+”新建')).toBeInTheDocument();
  });
});
