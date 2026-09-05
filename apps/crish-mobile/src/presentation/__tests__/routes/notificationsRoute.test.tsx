// 通知中心路由测试（R2-04 部分 5）：配对守卫 / 返回 → router.back / 深链跳转 → router.push
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { authStore } from '@/domain/store/authStore';
import {
  notificationStore,
  resetNotificationsForTest,
} from '@/domain/store/notificationStore';
import NotificationsRoute from '../../../../app/notifications';

jest.mock('expo-router', () => ({
  Redirect: () => null,
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

const pushMock = router.push as jest.Mock;
const backMock = router.back as jest.Mock;

/** 置为已配对态（路由守卫放行） */
async function pair() {
  await act(async () => {
    await authStore
      .getState()
      .onPaired(
        { deviceId: 'dev-1', desktopId: 'hub-1', host: '10.0.2.2' },
        { issuedAt: 0, ttlMs: 1000 }
      );
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  resetNotificationsForTest();
  notificationStore.setState({ hydrated: true });
  authStore.getState().revokeLocal();
  await act(async () => {
    authStore.setState({ hydrated: true });
  });
});

describe('通知中心路由（R2-04 部分 5）', () => {
  it('未配对 → 重定向配对页（不渲染通知中心）', async () => {
    await render(<NotificationsRoute />);
    expect(screen.queryByText('通知中心')).toBeNull();
  });

  it('已配对 → 渲染通知中心；返回 → router.back', async () => {
    await pair();
    await render(<NotificationsRoute />);
    expect(screen.getByTestId('notification-empty')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('header-back'));
    expect(backMock).toHaveBeenCalledTimes(1);
  });

  it('点击通知行 → 深链 router.push(翻译路径)（审批 → /approval/{toolCallId}）', async () => {
    await pair();
    notificationStore.getState().ingest(
      {
        id: 'approval-requested:tc-9f3a',
        kind: 'approval-requested',
        toolCallId: 'tc-9f3a',
        runId: null,
        seq: null,
        title: '需要确认：shell 命令',
        body: null,
        route: 'crish://approval/tc-9f3a',
      },
      Date.now()
    );
    await render(<NotificationsRoute />);

    await fireEvent.press(
      screen.getByTestId('notification-row-approval-requested:tc-9f3a')
    );
    expect(pushMock).toHaveBeenCalledWith('/approval/tc-9f3a');
  });
});
