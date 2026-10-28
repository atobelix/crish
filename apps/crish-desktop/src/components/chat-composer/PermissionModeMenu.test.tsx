// @vitest-environment jsdom
/**
 * PermissionModeMenu（ui/Menu 基座迁移版）交互测试：
 * 打开/选择/Esc/键盘漫游/外点关闭
 */
import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { PermissionModeMenu } from './PermissionModeMenu';
import { layerStackService } from '@/components/ui';

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  vi.restoreAllMocks();
});

describe('PermissionModeMenu（ui/Menu 基座）', () => {
  it('点击权限胶囊打开菜单并渲染全部模式项', async () => {
    render(<PermissionModeMenu mode="ask" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /当前权限模式/ }));
    const menu = (await screen.findAllByRole('menu'))[0]!;
    expect(menu).toBeInTheDocument();
    // 权限模式至少渲染「每次询问/智能放行/完全允许」三项
    expect(menu.querySelectorAll('[role="menuitem"]').length).toBe(3);
  });

  it('点击菜单项触发 onChange 并关闭', async () => {
    const onChange = vi.fn();
    render(<PermissionModeMenu mode="ask" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /当前权限模式/ }));
    const items = await screen.findAllByRole('menuitem');
    // 点击最后一个（非当前项）
    fireEvent.click(items[items.length - 1]);
    expect(onChange).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
    );
  });

  it('Esc 关闭菜单', async () => {
    render(<PermissionModeMenu mode="ask" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /当前权限模式/ }));
    const menu = (await screen.findAllByRole('menu'))[0]!;
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
    );
  });

  it('键盘漫游：ArrowDown 聚焦下一项，Enter 选中并关闭', async () => {
    const onChange = vi.fn();
    // 当前模式取列表末位（full），打开即聚焦首项（ask）→ 必然触发变更
    render(<PermissionModeMenu mode="full" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /当前权限模式/ }));
    const menu = (await screen.findAllByRole('menu'))[0]!;
    const items = screen.getAllByRole('menuitem');
    // F7-F2 契约：打开即聚焦首项（ask）
    await waitFor(() => expect(items[0]).toHaveFocus());
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
    );
  });

  it('外点关闭：真实外点（pointerdown+click）后面板消失', async () => {
    render(<PermissionModeMenu mode="ask" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /当前权限模式/ }));
    expect(await screen.findAllByRole('menu')).not.toHaveLength(0);
    const outside = document.createElement('button');
    outside.textContent = '外部';
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside);
    fireEvent.click(outside);
    await waitFor(() =>
      expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
    );
    outside.remove();
  });

  it('点击触发器再点一次可关闭', async () => {
    render(<PermissionModeMenu mode="ask" onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: /当前权限模式/ });
    fireEvent.click(trigger);
    expect(await screen.findAllByRole('menu')).not.toHaveLength(0);
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
    );
  });

  it('pointerdown+click 药丸一次即关且不重开', async () => {
    render(<PermissionModeMenu mode="ask" onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: /当前权限模式/ });
    fireEvent.click(trigger);
    expect(await screen.findAllByRole('menu')).not.toHaveLength(0);
    fireEvent.pointerDown(trigger);
    fireEvent.pointerUp(trigger);
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
    );
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('药丸不带 no-drag 字符串 class（Composer 不在窗拖区）', () => {
    render(<PermissionModeMenu mode="ask" onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: /当前权限模式/ });
    expect(trigger.className).not.toMatch(/\bno-drag\b/);
  });

  it('外点关后再点同一药丸：本击保持关，下一次手势才开', async () => {
    render(<PermissionModeMenu mode="ask" onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: /当前权限模式/ });
    fireEvent.click(trigger);
    expect(await screen.findAllByRole('menu')).not.toHaveLength(0);
    const outside = document.createElement('button');
    outside.textContent = '外部';
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside);
    fireEvent.pointerUp(outside);
    fireEvent.click(outside);
    await waitFor(() =>
      expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
    );
    // 同一 pointer 已结束；新一次 pointerdown 清 dismissedByPointer 后可开
    fireEvent.pointerDown(trigger);
    fireEvent.pointerUp(trigger);
    fireEvent.click(trigger);
    expect((await screen.findAllByRole('menu'))[0]!).toBeInTheDocument();
    outside.remove();
  });
});
