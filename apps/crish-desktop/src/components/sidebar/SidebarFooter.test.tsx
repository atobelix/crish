// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SidebarFooter } from './SidebarFooter';
import { UserProfileCard } from './UserProfileCard';
import { useSettingsUiStore } from '../../store/settingsUiStore';
import { useAuthStore } from '../../store/authStore';
import { useAccountUiStore } from '../../store/accountUiStore';
import { AUTH_BASE_URL } from '../../api/authApi';

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

    // 左列用户卡片：纯净单行昵称，无工作空间副文本与头像状态标点
    const userCard = screen.getByTestId('user-profile-card');
    expect(userCard).toBeInTheDocument();
    expect(screen.getByText('未登录')).toBeInTheDocument();
    expect(screen.queryByText('Conex Workspace')).toBeNull();
    expect(screen.queryByLabelText('在线')).toBeNull();

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
    expect(screen.queryByText('My Workspace')).toBeNull();

    const cardBtn = screen.getByTestId('user-profile-card');
    fireEvent.click(cardBtn);

    const menu = await screen.findByRole('menu');
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

  it('UserProfileCard 消费 useI18n 注入 roleLabel 与 tooltip (带 fallback)', () => {
    render(<UserProfileCard username="tester" />);
    const cardBtn = screen.getByTestId('user-profile-card');
    expect(cardBtn).toHaveAttribute('data-role', '访客用户');
    expect(cardBtn).toHaveAttribute('data-tooltip', '设置导航');
    expect(cardBtn).toHaveAttribute(
      'aria-label',
      '用户卡片：tester (访客用户)，点击打开设置导航'
    );
    expect(cardBtn).not.toHaveAttribute('title');
  });
});

describe('UserProfileCard 头像：账户入口与展示', () => {
  const signedInUser = { id: 'u1', email: 'lin@example.com', name: 'Lin' };

  beforeEach(() => {
    // 已初始化：避免卡片挂载时 initSession 覆盖测试设定的登录态
    useAuthStore.setState({
      initialized: true,
      isLoggedIn: false,
      user: null,
      profile: null,
    });
    useAccountUiStore.setState({ view: 'changePassword', loginOpen: false });
    useSettingsUiStore.setState({ showSettingsOverlay: false });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState({ isLoggedIn: false, user: null, profile: null });
    useAccountUiStore.setState({ view: 'overview', loginOpen: false });
    useSettingsUiStore.setState({ showSettingsOverlay: false });
  });

  it('未登录：中性占位头像，点击直登（应用级登录弹窗单实例），不打开设置', () => {
    render(<UserProfileCard />);
    const avatar = screen.getByTestId('user-avatar-button');
    expect(avatar).toHaveAttribute('data-avatar', 'placeholder');
    expect(avatar).toHaveAttribute('aria-label', '登录或注册 Crish 账号');
    expect(screen.getByText('未登录')).toBeInTheDocument();

    fireEvent.click(avatar);

    // 未登录直登：登录弹窗由 AppGlobalDialogs 单实例挂载（loginOpen 驱动），
    // 本组件树不渲染 dialog；设置浮层不打开（账户分区入口是登录后路径）
    expect(useAccountUiStore.getState().loginOpen).toBe(true);
    const settings = useSettingsUiStore.getState();
    expect(settings.showSettingsOverlay).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('已登录无头像图：显示首字母圆与账号名，点击同样进入「账户」', () => {
    useAuthStore.setState({ isLoggedIn: true, user: signedInUser });
    render(<UserProfileCard />);
    const avatar = screen.getByTestId('user-avatar-button');
    expect(avatar).toHaveAttribute('data-avatar', 'account');
    expect(avatar).toHaveAttribute('aria-label', '在设置中管理账号');
    expect(avatar).toHaveTextContent('L');
    expect(screen.getByText('Lin')).toBeInTheDocument();

    fireEvent.click(avatar);
    expect(useSettingsUiStore.getState().settingsActiveTab).toBe('profile');
    expect(useSettingsUiStore.getState().showSettingsOverlay).toBe(true);
  });

  it('已登录有头像图：相对路径拼账号中心地址，加载失败回落首字母', () => {
    useAuthStore.setState({
      isLoggedIn: true,
      user: signedInUser,
      profile: {
        accountId: 'u1',
        email: 'lin@example.com',
        displayName: '林',
        avatarUrl: '/avatars/u1.png',
        bio: '',
      },
    });
    render(<UserProfileCard />);
    const avatar = screen.getByTestId('user-avatar-button');
    const img = avatar.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', `${AUTH_BASE_URL}/avatars/u1.png`);
    expect(screen.getByText('林')).toBeInTheDocument();

    fireEvent.error(img as HTMLImageElement);
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar).toHaveTextContent('林');
  });

  it('点击名字仍打开快捷设置菜单，不切换「账户」', async () => {
    render(<UserProfileCard />);
    fireEvent.click(screen.getByTestId('user-profile-card'));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(useSettingsUiStore.getState().showSettingsOverlay).toBe(false);
  });
});
