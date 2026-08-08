/**
 * ui/Menu 基座测试：双模 open、键盘漫游、Esc 关闭、a11y
 */
// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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

  it('键盘漫游：初始落首项、ArrowDown 跳过 disabled、Enter 选中', async () => {
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
    // F7-F2：打开后初始焦点落首个未禁用项（ARIA menu 模式）
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: /选项甲/ })).toHaveFocus()
    );
    // ArrowDown：跳过 disabled 的索引 1，落在索引 2
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

  it('非模态菜单不声明 aria-modal，面板标题正常渲染（F7-F2）', async () => {
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        title="菜单标题"
        options={[{ id: 'a', label: '选项甲' }]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const content = await screen.findByText('菜单标题');
    // 非模态菜单声明 aria-modal 会切断后台内容的 SR 读取（F7-F2）
    expect(content.parentElement).not.toHaveAttribute('aria-modal');
    expect(content.parentElement).toHaveClass(styles.menuContent);
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

  it('打开即聚焦首项：无需按键即可直接 Enter 选中（F7-F2）', async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        onSelect={onSelect}
        options={[{ id: 'a', label: '选项甲' }, { id: 'b', label: '选项乙' }]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const content = await screen.findByRole('menu');
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: /选项甲/ })).toHaveFocus()
    );
    fireEvent.keyDown(content, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('a', expect.objectContaining({ id: 'a' }));
  });

  it('受控模式无内部写回：打开后不产生额外渲染（F7-F3）', async () => {
    const renderItem = vi.fn((option: { id: string; label: string }) => (
      <button key={option.id} type="button" role="menuitem">
        {option.label}
      </button>
    ));
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        open={true}
        onOpenChange={() => {}}
        renderItem={renderItem}
        options={[{ id: 'a', label: '选项甲' }]}
      />
    );
    await screen.findByRole('menuitem', { name: /选项甲/ });
    // 外部受控时内部状态不得再被 useEffect 写回（双模 OR + 同步链 = 多一次渲染）
    expect(renderItem).toHaveBeenCalledTimes(1);
  });

  it('受控模式关闭信号不被内部状态重开（F7-F3）', async () => {
    function ControlledWithLateClose() {
      const [open, setOpen] = useState(false);
      return (
        <Menu
          trigger={<button type="button">{TRIGGER_TEXT}</button>}
          open={open}
          onOpenChange={setOpen}
          options={[{ id: 'a', label: '选项甲' }]}
        />
      );
    }
    render(<ControlledWithLateClose />);
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    await screen.findByRole('menuitem', { name: /选项甲/ });
    // 模拟父级延迟关闭：onOpenChange(false) 后父级仍持 true 一段时间
    // 受控模式下菜单是否关闭只由父级 open 决定，内部不得悄悄重开
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    );
  });

  it('漫游焦点滚动跟随：scrollIntoView({block: nearest})（F7-F4）', async () => {
    const scrollIntoView = vi.fn();
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(
      scrollIntoView
    );
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        options={[{ id: 'a', label: '选项甲' }, { id: 'b', label: '选项乙' }]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const content = await screen.findByRole('menu');
    scrollIntoView.mockClear();
    fireEvent.keyDown(content, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: /选项乙/ })).toHaveFocus()
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.calls[0]?.[0]).toEqual({ block: 'nearest' });
  });
});
