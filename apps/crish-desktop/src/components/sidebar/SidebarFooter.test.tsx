// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SidebarFooter } from './SidebarFooter';
import { UserProfileCard } from './UserProfileCard';
import { useLayoutStore } from '../../api/store-access/componentAccess';

describe('SidebarFooter 双列底栏与 UserProfileCard 交互测试', () => {
  const onShowToast = vi.fn();
  const setUpdateAvailableState = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
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

  it('点击右列独立齿轮按钮直接调用 openSettings() 直达设置中心', () => {
    const openSettingsSpy = vi.fn();
    useLayoutStore.setState({ openSettings: openSettingsSpy });

    render(
      <SidebarFooter
        onShowToast={onShowToast}
        setUpdateAvailableState={setUpdateAvailableState}
      />
    );

    const gearBtn = screen.getByTestId('sidebar-settings-gear-btn');
    fireEvent.click(gearBtn);

    expect(openSettingsSpy).toHaveBeenCalledTimes(1);
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
