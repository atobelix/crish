// 通知中心页组件测试（R2-04 部分 5：store 接线 + 未读管理 + 深链）
// 覆盖：水合前加载态 / 空态 / 列表渲染（store 排序透传）/ 行点击 → markRead + 深链跳转 /
// 无深链目标仅已读 / 全部已读（按钮显隐 + 未读归零）/ 返回
// 注：@testing-library/react-native v14 render/fireEvent 为异步 API，全部 await
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  notificationStore,
  resetNotificationsForTest,
} from '@/domain/store/notificationStore';
import type { InAppNotification } from '@/domain/store/notificationReducers';
import NotificationCenterScreen from './notificationCenterScreen';

const NOW = 1_800_000_000_000;

function makeItem(
  overrides: Partial<InAppNotification> = {}
): InAppNotification {
  return {
    id: 'approval-requested:tc-1',
    kind: 'approval-requested',
    toolCallId: 'tc-1',
    runId: null,
    seq: null,
    title: '需要确认：shell 命令',
    body: 'rm -rf 高危操作',
    route: 'crish://approval/tc-1',
    status: 'shown',
    receivedAt: NOW,
    ...overrides,
  };
}

/** 重置 store 并置水合完成（避免首帧加载态干扰列表断言） */
function resetHydrated() {
  resetNotificationsForTest();
  notificationStore.setState({ hydrated: true });
}

function seed(item: InAppNotification) {
  notificationStore.getState().ingest(item, item.receivedAt);
}

beforeEach(() => {
  resetHydrated();
});

describe('NotificationCenterScreen 状态分支', () => {
  it('水合完成前显示加载态（不展示列表/空态，避免误导）', async () => {
    resetNotificationsForTest();
    await render(<NotificationCenterScreen onOpenNotification={jest.fn()} />);
    expect(screen.getByTestId('notification-loading')).toBeTruthy();
    expect(screen.queryByTestId('notification-empty')).toBeNull();
  });

  it('空态：无通知显示「暂无通知」与说明文案', async () => {
    await render(<NotificationCenterScreen onOpenNotification={jest.fn()} />);
    expect(screen.getByTestId('notification-empty')).toBeTruthy();
    expect(screen.getByText('暂无通知')).toBeTruthy();
  });
});

describe('NotificationCenterScreen 列表渲染', () => {
  it('渲染通知行（类型徽章 + 标题 + 正文 + 相对时间），store receivedAt 降序透传', async () => {
    seed(makeItem({ id: 'n-1', receivedAt: NOW }));
    seed(makeItem({ id: 'n-2', receivedAt: NOW + 3000 }));
    seed(makeItem({ id: 'n-3', receivedAt: NOW + 1000 }));

    await render(<NotificationCenterScreen onOpenNotification={jest.fn()} />);

    expect(screen.getByTestId('notification-list')).toBeTruthy();
    const rows = screen
      .getAllByTestId(/^notification-row-/)
      .map((el) => el.props.testID as string);
    // store 排序：receivedAt 降序（新在前，n-2 > n-3 > n-1）
    expect(rows).toEqual([
      'notification-row-n-2',
      'notification-row-n-3',
      'notification-row-n-1',
    ]);
  });
});

describe('NotificationCenterScreen 行点击（深链 + 已读）', () => {
  it('点击通知行 → markRead（未读归零）+ onOpenNotification(白名单路径)', async () => {
    const onOpen = jest.fn();
    seed(makeItem({ id: 'approval-requested:tc-1' }));
    await render(<NotificationCenterScreen onOpenNotification={onOpen} />);
    expect(notificationStore.getState().unreadCount).toBe(1);

    await fireEvent.press(
      screen.getByTestId('notification-row-approval-requested:tc-1')
    );

    // 点击即已读（M5 语义 shown → resolved）
    expect(notificationStore.getState().unreadCount).toBe(0);
    expect(notificationStore.getState().items[0]!.status).toBe('resolved');
    // 深链翻译（D7 §7.4 / M4 §4.3：crish://approval/tc-1 → /approval/tc-1）
    expect(onOpen).toHaveBeenCalledWith('/approval/tc-1');
  });

  it('无深链目标（route 缺失且无字段兜底）→ 仅已读不跳转', async () => {
    const onOpen = jest.fn();
    seed(
      makeItem({
        id: 'timer-fired:t-1',
        kind: 'timer-fired',
        title: '定时器到期',
        route: null,
        toolCallId: null,
        runId: null,
      })
    );
    await render(<NotificationCenterScreen onOpenNotification={onOpen} />);

    await fireEvent.press(
      screen.getByTestId('notification-row-timer-fired:t-1')
    );

    expect(notificationStore.getState().unreadCount).toBe(0);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('NotificationCenterScreen 未读管理', () => {
  it('有未读时显示「全部已读」，点击后未读归零且按钮消失', async () => {
    seed(makeItem({ id: 'a-1' }));
    seed(makeItem({ id: 'a-2', receivedAt: NOW + 1000 }));
    await render(<NotificationCenterScreen onOpenNotification={jest.fn()} />);
    expect(screen.getByTestId('mark-all-read')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('mark-all-read'));

    expect(notificationStore.getState().unreadCount).toBe(0);
    expect(
      notificationStore.getState().items.every((n) => n.status === 'resolved')
    ).toBe(true);
    expect(screen.queryByTestId('mark-all-read')).toBeNull();
  });

  it('无未读时不显示「全部已读」', async () => {
    seed(makeItem({ id: 'r-1', status: 'resolved' }));
    await render(<NotificationCenterScreen onOpenNotification={jest.fn()} />);
    expect(screen.queryByTestId('mark-all-read')).toBeNull();
  });
});

describe('NotificationCenterScreen 返回', () => {
  it('点击返回 → onBack', async () => {
    const onBack = jest.fn();
    seed(makeItem({ id: 'n-1' }));
    await render(
      <NotificationCenterScreen
        onBack={onBack}
        onOpenNotification={jest.fn()}
      />
    );

    await fireEvent.press(screen.getByTestId('header-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationCenterScreen 列表响应 store 变更', () => {
  it('ingest 新通知 → 列表即时出现（store 订阅）', async () => {
    await render(<NotificationCenterScreen onOpenNotification={jest.fn()} />);
    expect(screen.getByTestId('notification-empty')).toBeTruthy();

    await act(async () => {
      seed(makeItem({ id: 'n-live' }));
    });

    expect(screen.queryByTestId('notification-empty')).toBeNull();
    expect(screen.getByTestId('notification-row-n-live')).toBeTruthy();
  });
});
