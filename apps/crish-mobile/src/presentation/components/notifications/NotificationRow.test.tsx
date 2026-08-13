// NotificationRow 组件测试（R2-04 部分 5）：类型徽章（审批/事件/系统）/ 标题/正文/相对时间
// 渲染 / 未读标记（a11y 未读·已读双通道）/ 正文可空 / 点击回调
// 注：@testing-library/react-native v14 render/fireEvent/rerender 为异步 API，全部 await
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { InAppNotification } from '@/domain/store/notificationReducers';
import { NotificationRow } from './NotificationRow';

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

describe('NotificationRow 渲染', () => {
  it('渲染类型徽章 + 标题 + 正文 + 相对时间（kind 前缀 → 审批/事件/系统）', async () => {
    await render(
      <NotificationRow
        item={makeItem({ id: 'n-1' })}
        nowMs={NOW + 5 * 60_000}
        onPress={jest.fn()}
      />
    );
    expect(screen.getByTestId('notification-row-n-1')).toBeTruthy();
    expect(screen.getByText('审批')).toBeTruthy();
    expect(screen.getByTestId('notification-title')).toHaveTextContent(
      '需要确认：shell 命令'
    );
    expect(screen.getByTestId('notification-body')).toHaveTextContent(
      'rm -rf 高危操作'
    );
    expect(screen.getByTestId('notification-time')).toHaveTextContent(
      '5 分钟前'
    );
  });

  it('事件/系统 kind → 对应徽章文案', async () => {
    await render(
      <>
        <NotificationRow
          item={makeItem({ id: 'e-1', kind: 'task-failed', title: '任务失败' })}
          nowMs={NOW}
          onPress={jest.fn()}
        />
        <NotificationRow
          item={makeItem({
            id: 's-1',
            kind: 'security-audit',
            title: '安全审计',
          })}
          nowMs={NOW}
          onPress={jest.fn()}
        />
      </>
    );
    expect(screen.getByText('事件')).toBeTruthy();
    expect(screen.getByText('系统')).toBeTruthy();
  });

  it('正文为空（null）不渲染正文行', async () => {
    await render(
      <NotificationRow
        item={makeItem({ id: 'n-1', body: null })}
        nowMs={NOW}
        onPress={jest.fn()}
      />
    );
    expect(screen.queryByTestId('notification-body')).toBeNull();
  });

  it('未读（shown）：读屏含「未读」；已读（resolved）：读屏含「已读」', async () => {
    const { rerender } = await render(
      <NotificationRow
        item={makeItem({ id: 'n-1' })}
        nowMs={NOW}
        onPress={jest.fn()}
      />
    );
    expect(
      screen.getByTestId('notification-row-n-1').props.accessibilityLabel
    ).toContain('未读');

    await rerender(
      <NotificationRow
        item={makeItem({ id: 'n-1', status: 'resolved' })}
        nowMs={NOW}
        onPress={jest.fn()}
      />
    );
    expect(
      screen.getByTestId('notification-row-n-1').props.accessibilityLabel
    ).toContain('已读');
  });

  it('点击行 → onPress(item)', async () => {
    const onPress = jest.fn();
    const item = makeItem({ id: 'n-1' });
    await render(<NotificationRow item={item} nowMs={NOW} onPress={onPress} />);

    await fireEvent.press(screen.getByTestId('notification-row-n-1'));
    expect(onPress).toHaveBeenCalledWith(item);
  });
});
