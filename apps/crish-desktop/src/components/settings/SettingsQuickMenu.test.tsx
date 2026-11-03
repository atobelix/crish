// @vitest-environment jsdom
/**
 * SettingsQuickMenu：打开/Esc 还原焦点/键盘漫游/外点关闭；
 * 身份行（头像+名/邮箱+退出登录）、主题走基座子菜单（RadioItem）、检查更新行。
 */
import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsQuickMenu } from './SettingsQuickMenu';
import { useSettingsUiStore } from '../../store/settingsUiStore';
import { useAuthStore } from '../../store/authStore';
import { resetThemeStore } from '../../api/themeStore';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  resetThemeStore();
  document.documentElement.removeAttribute('data-theme');
  useSettingsUiStore.setState({ showSettingsOverlay: false });
  useAuthStore.setState({
    initialized: true,
    isLoggedIn: false,
    user: null,
    profile: null,
  });
});

function loginAsTestUser() {
  useAuthStore.setState({
    initialized: true,
    isLoggedIn: true,
    user: { id: 'u1', email: 'test@example.com', name: 'test-user' },
    profile: null,
  });
}

describe('SettingsQuickMenu（ui/Menu 基座）', () => {
  it('点击设置按钮打开菜单并渲染主题行与快捷入口', async () => {
    render(<SettingsQuickMenu />);
    fireEvent.click(screen.getByTestId('settings-button'));
    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(screen.getByTestId('quick-settings-theme')).toBeInTheDocument();
    expect(screen.getByText('主题')).toBeInTheDocument();
    expect(screen.getByText('模型与密钥')).toBeInTheDocument();
    expect(screen.getByText('外观与字体')).toBeInTheDocument();
    // 「全部设置」已改名为「设置」
    expect(screen.getByTestId('quick-settings-all')).toHaveTextContent('设置');
    expect(screen.queryByText('全部设置')).toBeNull();
    // 外观分区标签 + 胶囊已删除
    expect(screen.queryByText('外观')).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    // 检查更新行在位
    expect(screen.getByTestId('quick-settings-updates')).toHaveTextContent(
      '检查更新'
    );
  });

  it('主题走基座子菜单：展开后 RadioItem 选中态，点深色即换肤且不主动关闭级联以便预览', async () => {
    render(<SettingsQuickMenu />);
    fireEvent.click(screen.getByTestId('settings-button'));
    await screen.findByRole('menu');
    expect(document.querySelector('.ui-segment')).toBeNull();
    expect(document.querySelector('.ui-segment-item')).toBeNull();
    // 主题行当前值 = 浅色
    expect(screen.getByTestId('quick-settings-theme')).toHaveTextContent(
      '浅色'
    );
    fireEvent.click(screen.getByTestId('quick-settings-theme'));
    const light = await screen.findByTestId(
      'quick-settings-theme-light',
      {},
      { timeout: 3000 }
    );
    await screen.findByTestId('quick-settings-theme-dark');
    expect(light).toHaveAttribute('role', 'menuitemradio');
    expect(light).toHaveAttribute('aria-label', '浅色主题');
    expect(light).toHaveAttribute('aria-checked', 'true');
    const dark = screen.getByTestId('quick-settings-theme-dark');
    expect(dark).toHaveAttribute('aria-label', '深色主题');
    expect(dark).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(dark);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    // 级联面板不主动关闭，方便用户即时调试与预览
    expect(screen.queryAllByRole('menu').length).toBeGreaterThan(0);
  });

  it('菜单 CSS 不写 999 胶囊、不用 --bg-primary 挖坑', () => {
    const css = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        'SettingsQuickMenu.module.css'
      ),
      'utf8'
    );
    expect(css).not.toMatch(/999px/);
    expect(css).not.toMatch(/ui-segment-item/);
    expect(css).not.toMatch(/--bg-primary/);
  });

  it('Esc 关闭菜单并还原焦点到触发按钮', async () => {
    render(<SettingsQuickMenu />);
    const trigger = screen.getByTestId('settings-button');
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('键盘漫游：ArrowDown 循环聚焦到入口项', async () => {
    render(<SettingsQuickMenu />);
    fireEvent.click(screen.getByTestId('settings-button'));
    const menu = await screen.findByRole('menu');
    const modelsItem = screen.getByTestId('quick-settings-models');
    for (let i = 0; i < 10 && document.activeElement !== modelsItem; i += 1) {
      fireEvent.keyDown(document.activeElement ?? menu, { key: 'ArrowDown' });
    }
    expect(modelsItem).toHaveFocus();
  });

  it('登录态身份行：头像首字母 + 用户名（不显邮箱） + 退出钮，ArrowDown 可达退出钮', async () => {
    loginAsTestUser();
    render(<SettingsQuickMenu />);
    fireEvent.click(screen.getByTestId('settings-button'));
    const menu = await screen.findByRole('menu');
    const account = screen.getByTestId('quick-settings-account');
    expect(account).toHaveTextContent('test-user');
    expect(account).not.toHaveTextContent('test@example.com');
    expect(account).toHaveTextContent('T');
    const signOut = screen.getByTestId('quick-settings-signout');
    expect(signOut).toHaveTextContent('退出登录');
    expect(menu).toContainElement(signOut);
    // 打开后焦点落首项（账号行）；持续 ↓ 漫游应能到达退出钮
    await waitFor(() => expect(account).toHaveFocus());
    for (let i = 0; i < 10 && document.activeElement !== signOut; i += 1) {
      fireEvent.keyDown(document.activeElement ?? account, {
        key: 'ArrowDown',
      });
    }
    expect(signOut).toHaveFocus();
  });

  it('点退出登录：关菜单并弹出现有确认弹窗，取消后仍保持登录', async () => {
    loginAsTestUser();
    render(<SettingsQuickMenu />);
    fireEvent.click(screen.getByTestId('settings-button'));
    await screen.findByRole('menu');
    fireEvent.click(screen.getByTestId('quick-settings-signout'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    );
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
  });

  it('检查更新行：点击后走真实检查并关闭菜单（jsdom 无后端，如实失败不崩）', async () => {
    render(<SettingsQuickMenu />);
    fireEvent.click(screen.getByTestId('settings-button'));
    await screen.findByRole('menu');
    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-settings-updates'));
    });
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    );
  });

  it('外点关闭后不把焦点强加给触发按钮', async () => {
    render(<SettingsQuickMenu />);
    fireEvent.click(screen.getByTestId('settings-button'));
    await screen.findByRole('menu');
    const outside = document.createElement('button');
    outside.textContent = '外部按钮';
    document.body.appendChild(outside);
    outside.focus();
    await act(async () => {
      fireEvent.pointerDown(outside);
    });
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    );
    expect(document.activeElement).not.toBe(
      screen.getByTestId('settings-button')
    );
    outside.remove();
  });
});
