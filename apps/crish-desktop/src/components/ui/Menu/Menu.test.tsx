/**
 * ui/Menu 基座测试：双模 open、键盘漫游、Esc 关闭、a11y
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { Menu } from './Menu';
import styles from './Menu.module.css';

const TRIGGER_TEXT = '菜单触发器';

/** 双模受控示例：外部 open + onOpenChange 桥接 */
function ControlledMenu({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      trigger={<button type="button">{TRIGGER_TEXT}</button>}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
      options={[
        { id: 'a', label: '选项甲' },
        { id: 'b', label: '选项乙' },
        { id: 'c', label: '选项丙', disabled: true },
      ]}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ui/Menu', () => {
  it('点击触发器打开面板并渲染选项', async () => {
    render(<Menu trigger={<button type="button">{TRIGGER_TEXT}</button>} options={[{ id: 'a', label: '选项甲' }]} />);
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const item = await screen.findByRole('menuitem', { name: /选项甲/ });
    expect(item).toBeInTheDocument();
  });

  it('菜单项带 disabled/danger 语义类', async () => {
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        options={[
          { id: 'a', label: '普通项' },
          { id: 'b', label: '禁用项', disabled: true },
          { id: 'c', label: '危险项', danger: true },
        ]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const normal = await screen.findByRole('menuitem', { name: /普通项/ });
    const disabled = screen.getByRole('menuitem', { name: /禁用项/ });
    const danger = screen.getByRole('menuitem', { name: /危险项/ });
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveClass(styles.menuItemDisabled);
    expect(danger).toHaveClass(styles.menuItemDanger);
    expect(normal).not.toHaveClass(styles.menuItemDanger);
  });

  it('点击选项触发 onSelect 并关闭面板', async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        onSelect={onSelect}
        options={[{ id: 'a', label: '选项甲' }, { id: 'b', label: '选项乙' }]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const item = await screen.findByRole('menuitem', { name: /选项乙/ });
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith('b', expect.objectContaining({ id: 'b', label: '选项乙' }));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('键盘漫游：ArrowDown 跳过 disabled、Enter 选中', async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        onSelect={onSelect}
        options={[
          { id: 'a', label: '选项甲' },
          { id: 'b', label: '禁用乙', disabled: true },
          { id: 'c', label: '选项丙' },
        ]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const content = await screen.findByRole('menu');
    // 初始：focusedIndex=-1；一次 ArrowDown 落在索引 0
    fireEvent.keyDown(content, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /选项甲/ })).toHaveFocus();
    // 再 ArrowDown：跳过 disabled 的索引 1，落在索引 2
    fireEvent.keyDown(content, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /选项丙/ })).toHaveFocus();
    // Enter 选中
    fireEvent.keyDown(content, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('c', expect.objectContaining({ id: 'c' }));
  });

  it('ArrowUp 反向漫游', async () => {
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        options={[{ id: 'a', label: '选项甲' }, { id: 'b', label: '选项乙' }]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const content = await screen.findByRole('menu');
    fireEvent.keyDown(content, { key: 'ArrowUp' });
    // 从 -1 上翻 → 回绕到最后一个（索引 1）
    expect(screen.getByRole('menuitem', { name: /选项乙/ })).toHaveFocus();
  });

  it('Esc 关闭面板并重置漫游索引', async () => {
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        options={[{ id: 'a', label: '选项甲' }]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const content = await screen.findByRole('menu');
    fireEvent.keyDown(content, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('受控 open/onOpenChange 双模桥接', async () => {
    const onOpenChange = vi.fn();
    render(<ControlledMenu onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const item = await screen.findByRole('menuitem', { name: /选项甲/ });
    expect(onOpenChange).toHaveBeenCalledWith(true);
    fireEvent.click(item);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('面板带 aria-modal 与标题', async () => {
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        title="菜单标题"
        options={[{ id: 'a', label: '选项甲' }]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const content = await screen.findByText('菜单标题');
    expect(content.parentElement).toHaveAttribute('aria-modal', 'true');
  });

  it('trigger 事件保留：原 onClick 与防冒泡同时生效', async () => {
    const originalOnClick = vi.fn();
    const onOuterClick = vi.fn();
    render(
      <div onClick={onOuterClick}>
        <Menu
          trigger={<button type="button" onClick={originalOnClick}>{TRIGGER_TEXT}</button>}
          options={[{ id: 'a', label: '选项甲' }]}
        />
      </div>
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    expect(originalOnClick).toHaveBeenCalledTimes(1);
    expect(onOuterClick).not.toHaveBeenCalled();
    await screen.findByRole('menuitem', { name: /选项甲/ });
  });
});
