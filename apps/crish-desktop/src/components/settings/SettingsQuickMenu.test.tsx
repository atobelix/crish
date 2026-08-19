// @vitest-environment jsdom
/**
 * SettingsQuickMenu：打开/Esc 还原焦点/键盘漫游/外点关闭；外观段走 SegmentedControl
 */
import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsQuickMenu } from './SettingsQuickMenu';
import { useSettingsUiStore } from '../../store/settingsUiStore';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  useSettingsUiStore.setState({ showSettingsOverlay: false });
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

  it('外观段走 SegmentedControl，无 .ui-segment 死皮', async () => {
    render(<SettingsQuickMenu />);
    fireEvent.click(screen.getByTestId('settings-button'));
    await screen.findByRole('menu', { name: '快捷设置' });
    expect(document.querySelector('.ui-segment')).toBeNull();
    expect(document.querySelector('.ui-segment-item')).toBeNull();
    const group = screen.getByRole('radiogroup', { name: '外观' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '浅色主题' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    fireEvent.click(screen.getByRole('radio', { name: '深色主题' }));
    expect(screen.getByRole('radio', { name: '深色主题' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('外观段 CSS 不写 999 胶囊、不用 --bg-primary 挖坑', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'SettingsQuickMenu.module.css'),
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
    const menu = await screen.findByRole('menu', { name: '快捷设置' });
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('键盘漫游：ArrowDown 循环聚焦（主题 radio → 入口项）', async () => {
    render(<SettingsQuickMenu />);
    fireEvent.click(screen.getByTestId('settings-button'));
    const menu = await screen.findByRole('menu', { name: '快捷设置' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
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
    await act(async () => {
      fireEvent.pointerDown(outside);
    });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(document.activeElement).not.toBe(screen.getByTestId('settings-button'));
    outside.remove();
  });
});
