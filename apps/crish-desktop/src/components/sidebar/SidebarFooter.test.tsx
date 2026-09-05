// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SidebarFooter } from './SidebarFooter';
import { UserProfileCard } from './UserProfileCard';
import { useSettingsUiStore } from '../../store/settingsUiStore';

describe('SidebarFooter 双列底栏与 UserProfileCard 交互测试', () => {
  const onShowToast = vi.fn();
  const setUpdateAvailableState = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    useSettingsUiStore.setState({ showSettingsOverlay: false });
  });

  it('底栏渲染左列 UserProfileCard 和右列 SettingsIconButton', () => {
    render(
      <SidebarFooter
        onShowToast={onShowToast}
        setUpdateAvailableState={setUpdateAvailableState}
      />
    );

    // 左列用户卡片
    const userCard = screen.getByTestId('user-profile-card');
    expect(userCard).toBeInTheDocument();
    expect(screen.getByText('orange')).toBeInTheDocument();
    expect(screen.getByText('Conex Workspace')).toBeInTheDocument();

    // 在线绿点
    expect(screen.getByLabelText('在线')).toBeInTheDocument();

    // 右列独立齿轮按钮
    const gearBtn = screen.getByTestId('sidebar-settings-gear-btn');
    expect(gearBtn).toBeInTheDocument();
  });

  it('连续点击齿轮在设置浮层与主界面之间切换', () => {
    useSettingsUiStore.setState({ showSettingsOverlay: false });

    render(
      <SidebarFooter
        onShowToast={onShowToast}
        setUpdateAvailableState={setUpdateAvailableState}
      />
    );

    const gearBtn = screen.getByTestId('sidebar-settings-gear-btn');
    expect(gearBtn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(gearBtn);
    expect(useSettingsUiStore.getState().showSettingsOverlay).toBe(true);
    expect(gearBtn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(gearBtn);
    expect(useSettingsUiStore.getState().showSettingsOverlay).toBe(false);
    expect(gearBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('点击左列 UserProfileCard 触发 SettingsQuickMenu 快捷菜单', async () => {
    render(
      <UserProfileCard
        onShowToast={onShowToast}
        username="test-user"
        workspaceName="My Workspace"
      />
    );

    expect(screen.getByText('test-user')).toBeInTheDocument();
    expect(screen.getByText('My Workspace')).toBeInTheDocument();

    const cardBtn = screen.getByTestId('user-profile-card');
    fireEvent.click(cardBtn);

    const menu = await screen.findByRole('menu', { name: '快捷设置' });
    expect(menu).toBeInTheDocument();
    expect(screen.getByText('外观')).toBeInTheDocument();
    expect(screen.getByText('模型与密钥')).toBeInTheDocument();
    expect(screen.getByText('全部设置')).toBeInTheDocument();
  });

  it('updateAvailable 为 true 时渲染脉冲更新角标与更新按钮', () => {
    render(
      <SidebarFooter
        updateAvailable={true}
        onShowToast={onShowToast}
        setUpdateAvailableState={setUpdateAvailableState}
      />
    );

    // 更新按钮
    const updateBtn = screen.getByRole('button', { name: '安装更新' });
    expect(updateBtn).toBeInTheDocument();

    // 脉冲角标
    expect(screen.getByLabelText('新版本可用提示')).toBeInTheDocument();
  });

});
