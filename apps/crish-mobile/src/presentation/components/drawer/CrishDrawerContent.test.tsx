// 抽屉内容测试：底部身份行头像接线（2026-11-02 用户投诉钉案）与
// 方案 08 抽屉闭合静默门（绝缘退栈返回重绘风暴，保护转场 120fps 满帧）。
import { act, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import { accountStore } from '@/domain/store/accountStore';
import type { AccountProfile, AccountUser } from '@/domain/types/account';
import { lightTheme } from '@/adapters/platform/theme';
import { CrishDrawerContent, isMainScreenRoute } from './CrishDrawerContent';

let mockPathname = '/';
jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  router: { navigate: jest.fn(), push: jest.fn() },
}));

const mockVmRows = [
  {
    kind: 'local' as const,
    id: 'lth-1',
    updatedAt: 1,
    thread: {
      id: 'lth-1',
      title: '测试线程',
      titleSource: 'derived' as const,
      preview: '',
      modelRef: null,
      createdAt: 1,
      updatedAt: 1,
    },
    streaming: false,
    failed: false,
  },
];

const mockRefresh = jest.fn();
const mockSetQuery = jest.fn();
const mockOpenSessionActions = jest.fn();
const mockOpenLocalThreadActions = jest.fn();

const mockSessionListVm = {
  partition: 'local' as const,
  partitionLabel: '本机',
  today: mockVmRows,
  earlier: [],
  query: '',
  setQuery: mockSetQuery,
  windows: { stale: false },
  remoteTotal: 0,
  localTotal: mockVmRows.length,
  hasSessions: true,
  connected: false,
  refresh: mockRefresh,
  syncStatus: 'ok' as const,
  lastReconcileAt: null,
  localHydrated: true,
};

const mockUseSessionListVm = jest.fn((_nowMs: number) => mockSessionListVm);

jest.mock('@/adapters/viewmodels/useSessionListVm', () => ({
  useSessionListVm: (nowMs: number) => mockUseSessionListVm(nowMs),
}));

let mockLocalRowRenders = 0;
jest.mock('@/presentation/components/sessions/LocalSessionListItem', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    LocalSessionListItem: () => {
      mockLocalRowRenders += 1;
      return React.createElement(View, { testID: 'mock-local-row' });
    },
  };
});

jest.mock('@/presentation/components/sessions/useSessionOpsController', () => ({
  useSessionOpsController: () => ({
    layer: null,
    openActions: mockOpenSessionActions,
  }),
}));

jest.mock(
  '@/presentation/components/sessions/useLocalThreadOpsController',
  () => ({
    useLocalThreadOpsController: () => ({
      layer: null,
      openActions: mockOpenLocalThreadActions,
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
  afterEach(async () => {
    await act(async () => {
      accountStore.setState({ user: null, profile: null, status: 'loggedOut' });
    });
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

describe('CrishDrawerContent 按钮微气垫与纯白质感（方案 12 钉案）', () => {
  it('动作按钮全面恢复 floating 白底圆盘微气垫形态，搜索胶囊纯白在位', async () => {
    const view = await render(<CrishDrawerContent />, { wrapper: Wrapper });
    const pill = view.getByTestId('drawer-search-pill');
    expect(pill.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ backgroundColor: lightTheme.colors.surface }),
      ])
    );

    const buttonIds = [
      'drawer-scan',
      'drawer-notifications',
      'drawer-search-cancel',
      'drawer-settings',
      'drawer-new-chat',
    ];

    for (const testId of buttonIds) {
      const button = view.getByTestId(testId);
      expect(button).toBeTruthy();
      // 验证外层尺寸为 40dp (theme.size.iconButton)
      expect(button.props.style).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            width: lightTheme.size.iconButton,
            height: lightTheme.size.iconButton,
          }),
        ])
      );
      // 验证包含圆盘填充节点（borderRadius === 20 且包含背景色）
      const disc = button.children.find((child: any) => {
        const styles = Array.isArray(child?.props?.style)
          ? child.props.style
          : [child?.props?.style];
        return styles.some(
          (s: any) =>
            s &&
            s.borderRadius === lightTheme.size.iconButton / 2 &&
            s.backgroundColor
        );
      });
      expect(disc).toBeTruthy();
    }

    // 整树零 elevation、零 shadow*
    const rootJson = JSON.stringify(view.toJSON());
    expect(rootJson).not.toMatch(/"elevation":/);
    expect(rootJson).not.toMatch(/"shadow(Color|Offset|Opacity|Radius)":/);
  });
});

describe('CrishDrawerContent 闭合静默门（08 方案流畅度保护）', () => {
  beforeEach(() => {
    mockLocalRowRenders = 0;
    mockPathname = '/settings';
    mockUseSessionListVm.mockClear();
  });

  it('抽屉闭合状态下，路由变化（从 /settings 切换回对话）不触发列表项重排重绘与时钟刷新', async () => {
    // 1. 在 /settings 页面下挂载抽屉（闭合态 isOpen = false）
    mockPathname = '/settings';
    const view = await render(<CrishDrawerContent isOpen={false} />, {
      wrapper: Wrapper,
    });
    expect(mockLocalRowRenders).toBe(1);
    const initialNowMs = mockUseSessionListVm.mock.calls[0]?.[0];

    // 2. 模拟用户点击返回：路由在闭合态下瞬间从 /settings 变更为会话 /thread/lth-1
    mockPathname = '/thread/lth-1';
    await act(async () => {
      view.rerender(<CrishDrawerContent isOpen={false} />);
    });

    // 绝缘断言：
    // - 闭合态对 usePathname 变化绝缘，clock 时钟未被刷新（nowMs 保持不变）
    // - 闭合态不计算选区（selected 为 null），DrawerSessionList memo 生效，LocalSessionListItem 的渲染计数维持为 1（0 次多余重绘）
    const secondNowMs =
      mockUseSessionListVm.mock.calls[
        mockUseSessionListVm.mock.calls.length - 1
      ]?.[0];
    expect(secondNowMs).toBe(initialNowMs);
    expect(mockLocalRowRenders).toBe(1);

    // 3. 模拟手势拉开或点击菜单展开抽屉（isOpen 变为 true）
    await act(async () => {
      view.rerender(<CrishDrawerContent isOpen={true} />);
    });

    // 展开激活断言：展开后真正同步当前路由并激活列表渲染（selected 变为选中态）
    expect(mockLocalRowRenders).toBeGreaterThan(1);
  });

  it('isMainScreenRoute 工具函数正确识别主屏与子路由', () => {
    expect(isMainScreenRoute('/')).toBe(true);
    expect(isMainScreenRoute('/session/s-1')).toBe(true);
    expect(isMainScreenRoute('/thread/t-1')).toBe(true);
    expect(isMainScreenRoute('/settings')).toBe(false);
    expect(isMainScreenRoute('/settings-theme')).toBe(false);
    expect(isMainScreenRoute('/account')).toBe(false);
    expect(isMainScreenRoute('/approvals')).toBe(false);
    expect(isMainScreenRoute(null)).toBe(false);
  });
});
