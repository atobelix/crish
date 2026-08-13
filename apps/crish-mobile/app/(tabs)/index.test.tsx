// 首页通知入口（铃铛）测试（R2-04 部分 5：入口跳转 + 未读角标联动）
// 覆盖：角标 = notificationStore.unreadCount（>0 显示，99+ 收敛）/ hydrated 前置（水合完成前
// 不显示角标）/ 点击 → /notifications / 未读变化即时刷新
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import {
  notificationStore,
  resetNotificationsForTest,
} from '@/domain/store/notificationStore';
import DashboardScreen from './index';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

const pushMock = router.push as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  resetNotificationsForTest();
  notificationStore.setState({ hydrated: true });
});

describe('首页通知入口（R2-04 部分 5）', () => {
  it('无未读 → 不显示角标（诚实化，M4 §4.1）', async () => {
    await render(<DashboardScreen />);
    expect(screen.getByTestId('notification-entry')).toBeTruthy();
    expect(screen.queryByTestId('notification-entry-badge')).toBeNull();
  });

  it('有未读 → 角标显示计数；点击入口 → router.push(/notifications)', async () => {
    notificationStore.getState().ingest(
      {
        id: 'approval-requested:tc-1',
        kind: 'approval-requested',
        toolCallId: 'tc-1',
        runId: null,
        seq: null,
        title: '需要确认：shell 命令',
        body: null,
        route: 'crish://approval/tc-1',
      },
      Date.now()
    );
    notificationStore.getState().ingest(
      {
        id: 'run-terminal:run-1',
        kind: 'run-ended',
        toolCallId: null,
        runId: 'run-1',
        seq: null,
        title: 'run 完成',
        body: null,
        route: null,
      },
      Date.now()
    );
    await render(<DashboardScreen />);

    const badge = screen.getByTestId('notification-entry-badge');
    expect(badge).toBeTruthy();
    expect(badge).toHaveTextContent('2');

    await fireEvent.press(screen.getByTestId('notification-entry'));
    expect(pushMock).toHaveBeenCalledWith('/notifications');
  });

  it('未读 > 99 收敛为 99+（F1 §4.8）', async () => {
    const st = notificationStore.getState();
    for (let i = 0; i < 100; i += 1) {
      st.ingest(
        {
          id: `n-${i}`,
          kind: 'run-ended',
          toolCallId: null,
          runId: `run-${i}`,
          seq: null,
          title: `通知 ${i}`,
          body: null,
          route: null,
        },
        Date.now() + i
      );
    }
    await render(<DashboardScreen />);
    expect(screen.getByTestId('notification-entry-badge')).toHaveTextContent(
      '99+'
    );
  });

  it('水合完成前不显示角标（避免误导，notificationStore 注记）', async () => {
    notificationStore.setState({ hydrated: false });
    notificationStore.getState().ingest(
      {
        id: 'approval-requested:tc-1',
        kind: 'approval-requested',
        toolCallId: 'tc-1',
        runId: null,
        seq: null,
        title: '需要确认：shell 命令',
        body: null,
        route: 'crish://approval/tc-1',
      },
      Date.now()
    );
    await render(<DashboardScreen />);
    expect(screen.queryByTestId('notification-entry-badge')).toBeNull();
  });

  it('未读变化即时刷新角标（store 订阅）', async () => {
    await render(<DashboardScreen />);
    expect(screen.queryByTestId('notification-entry-badge')).toBeNull();

    await act(async () => {
      notificationStore.getState().ingest(
        {
          id: 'approval-requested:tc-2',
          kind: 'approval-requested',
          toolCallId: 'tc-2',
          runId: null,
          seq: null,
          title: '新审批',
          body: null,
          route: 'crish://approval/tc-2',
        },
        Date.now()
      );
    });

    expect(screen.getByTestId('notification-entry-badge')).toHaveTextContent(
      '1'
    );
  });
});
