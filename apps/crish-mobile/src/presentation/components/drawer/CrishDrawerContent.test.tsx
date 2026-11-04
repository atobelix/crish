// 抽屉内容测试：底部身份行头像接线（2026-11-02 用户投诉钉案）。
// 旧实现手搓首字盘、从不消费 profile.avatarUrl——登录后账号有头像而
// 抽屉仍是默认。本套钉住：登录态显示真实头像图；无头像才落首字占位。
import { render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import { accountStore } from '@/domain/store/accountStore';
import type { AccountProfile, AccountUser } from '@/domain/types/account';
import { CrishDrawerContent } from './CrishDrawerContent';

jest.mock('expo-router', () => ({
  usePathname: () => '/',
  router: { navigate: jest.fn(), push: jest.fn() },
}));

jest.mock('@/adapters/viewmodels/useSessionListVm', () => ({
  useSessionListVm: () => ({
    partition: 'local',
    partitionLabel: '本机',
    today: [],
    earlier: [],
    query: '',
    setQuery: jest.fn(),
    windows: { stale: false },
    remoteTotal: 0,
    localTotal: 0,
    hasSessions: false,
    connected: false,
    refresh: jest.fn(),
    syncStatus: 'ok',
    lastReconcileAt: null,
    localHydrated: true,
  }),
}));

jest.mock('@/presentation/components/sessions/useSessionOpsController', () => ({
  useSessionOpsController: () => ({
    layer: null,
    openActions: jest.fn(),
  }),
}));

jest.mock(
  '@/presentation/components/sessions/useLocalThreadOpsController',
  () => ({
    useLocalThreadOpsController: () => ({
      layer: null,
      openActions: jest.fn(),
    }),
  })
);

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

const USER: AccountUser = { id: 'u1', email: 'ming@b.co', name: '小明' };

function profileWith(avatarUrl: string | null): AccountProfile {
  return {
    accountId: 'u1',
    email: 'ming@b.co',
    displayName: '小明',
    avatarUrl,
    avatarFileId: null,
    bio: '',
    profileUpdatedAt: null,
  };
}

describe('CrishDrawerContent 身份行头像', () => {
  afterEach(() => {
    accountStore.setState({ user: null, profile: null, status: 'loggedOut' });
  });

  it('登录且 profile 有头像 → 渲染真实头像图片（绝对地址原样）', async () => {
    accountStore.setState({
      user: USER,
      profile: profileWith('https://cdn.example.com/avatar.png'),
      status: 'loggedIn',
    });
    const view = await render(<CrishDrawerContent />, { wrapper: Wrapper });
    const avatar = view.getByTestId('drawer-avatar');
    expect(avatar.props.source).toEqual({
      uri: 'https://cdn.example.com/avatar.png',
    });
    // 会话区标题呈现当前分区目标名（分区口径：身份在此一处）
    expect(view.getByTestId('drawer-partition-label')).toBeTruthy();
    expect(view.getByText('本机')).toBeTruthy();
  });

  it('登录但无头像 → 首字占位（不是图片）', async () => {
    accountStore.setState({
      user: USER,
      profile: profileWith(null),
      status: 'loggedIn',
    });
    const view = await render(<CrishDrawerContent />, { wrapper: Wrapper });
    const avatar = view.getByTestId('drawer-avatar');
    expect(avatar.props.source).toBeUndefined();
    expect(view.getByText('小')).toBeTruthy();
    expect(view.getByText('小明')).toBeTruthy();
  });

  it('未登录 → 占位名与首字，不出图片', async () => {
    accountStore.setState({ user: null, profile: null, status: 'loggedOut' });
    const view = await render(<CrishDrawerContent />, { wrapper: Wrapper });
    const avatar = view.getByTestId('drawer-avatar');
    expect(avatar.props.source).toBeUndefined();
    expect(view.getByText('本地用户')).toBeTruthy();
  });
});

describe('CrishDrawerContent 纯净轻量化视觉（去底色钉案）', () => {
  it('搜索胶囊融入抽屉底板，动作按钮与选项行通透在位', async () => {
    const view = await render(<CrishDrawerContent />, { wrapper: Wrapper });
    const pill = view.getByTestId('drawer-search-pill');
    expect(pill.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ backgroundColor: 'rgba(0, 0, 0, 0.03)' }),
      ])
    );
    // 顶部动作按钮与底部按钮均通透在位（variant="plain"）
    expect(view.getByTestId('drawer-scan')).toBeTruthy();
    expect(view.getByTestId('drawer-notifications')).toBeTruthy();
    expect(view.getByTestId('drawer-settings')).toBeTruthy();
    expect(view.getByTestId('drawer-new-chat')).toBeTruthy();
  });
});
