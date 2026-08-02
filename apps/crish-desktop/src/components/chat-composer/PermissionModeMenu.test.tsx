/**
 * PermissionModeMenu（ui/Menu 基座迁移版）交互测试：
 * 打开/选择/Esc/键盘漫游/外点关闭
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { PermissionModeMenu } from './PermissionModeMenu';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PermissionModeMenu（ui/Menu 基座）', () => {
  it('点击权限胶囊打开菜单并渲染全部模式项', async () => {
    render(<PermissionModeMenu mode="ask" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /当前权限模式/ }));
    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    // 权限模式至少渲染「允许/询问/拒绝」等项
    expect(menu.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(1);
  });

  it('点击菜单项触发 onChange 并关闭', async () => {
    const onChange = vi.fn();
    render(<PermissionModeMenu mode="ask" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /当前权限模式/ }));
    const items = await screen.findAllByRole('menuitem');
    // 点击最后一个（非当前项）
    fireEvent.click(items[items.length - 1]);
    expect(onChange).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('Esc 关闭菜单', async () => {
    render(<PermissionModeMenu mode="ask" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /当前权限模式/ }));
    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('键盘漫游：ArrowDown 聚焦下一项，Enter 选中并关闭', async () => {
    const onChange = vi.fn();
    // 当前模式取列表末位（full），ArrowDown 落在首项（ask）→ 必然触发变更
    render(<PermissionModeMenu mode="full" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /当前权限模式/ }));
    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('外点关闭：真实外点（pointerdown+click）后面板消失', async () => {
    render(<PermissionModeMenu mode="ask" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /当前权限模式/ }));
    await screen.findByRole('menu');
    const outside = document.createElement('button');
    outside.textContent = '外部';
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside);
    fireEvent.click(outside);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    outside.remove();
  });

  it('点击触发器再点一次可关闭', async () => {
    render(<PermissionModeMenu mode="ask" onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: /当前权限模式/ });
    fireEvent.click(trigger);
    await screen.findByRole('menu');
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});
