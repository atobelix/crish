// @vitest-environment jsdom
/**
 * SettingsQuickMenu（ui/Menu 基座迁移版）交互测试：
 * 打开/Esc 还原焦点/键盘漫游/外点关闭不抢焦点
 */
import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { SettingsQuickMenu } from './SettingsQuickMenu';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('SettingsQuickMenu（ui/Menu 基座）', () => {
  it('点击设置按钮打开菜单并渲染主题段与快捷入口', async () => {
    render(<SettingsQuickMenu />);
    fireEvent.click(screen.getByTestId('settings-button'));
    const menu = await screen.findByRole('menu', { name: '快捷设置' });
    expect(menu).toBeInTheDocument();
    expect(screen.getByText('外观')).toBeInTheDocument();
    expect(screen.getByText('模型与密钥')).toBeInTheDocument();
    expect(screen.getByText('全部设置')).toBeInTheDocument();
  });

  it('Esc 关闭菜单并还原焦点到触发按钮', async () => {
    render(<SettingsQuickMenu />);
    const trigger = screen.getByTestId('settings-button');
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu', { name: '快捷设置' });
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('键盘漫游：ArrowDown 循环聚焦（主题 radio → 入口项）', async () => {
    render(<SettingsQuickMenu />);
    fireEvent.click(screen.getByTestId('settings-button'));
    const menu = await screen.findByRole('menu', { name: '快捷设置' });
    // 打开后已聚焦首个可操作控件（浅色主题）
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    // 至少移动到第一个快捷入口
    expect(screen.getByTestId('quick-settings-models')).toHaveFocus();
  });

  it('外点关闭后不把焦点强加给触发按钮', async () => {
    render(<SettingsQuickMenu />);
    fireEvent.click(screen.getByTestId('settings-button'));
    await screen.findByRole('menu', { name: '快捷设置' });
    const outside = document.createElement('button');
    outside.textContent = '外部按钮';
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.pointerDown(outside);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(document.activeElement).not.toBe(screen.getByTestId('settings-button'));
    outside.remove();
  });
});
