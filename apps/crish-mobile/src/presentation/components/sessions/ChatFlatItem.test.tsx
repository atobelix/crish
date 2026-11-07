// ChatFlatItem 状态派生纯函数测试：运行中 > 待审批 > 已完成 的优先级不变量。
import { fireEvent, render } from '@testing-library/react-native';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { ChatFlatItem, chatStatusOf } from './ChatFlatItem';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-9',
    title: '平铺会话',
    updatedAt: 2_000,
    receivedAtMs: 1_000,
    lastReadSequence: 0,
    unreadCount: 0,
    activeRunIds: [],
    pendingApprovalCount: 0,
    completedAtMs: null,
    lastRunFailedAtMs: null,
    ...overrides,
  } as SessionSummary;
}

describe('chatStatusOf', () => {
  it('无活动 run 且无待审批 → done', () => {
    expect(chatStatusOf({ activeRunIds: [], pendingApprovalCount: 0 })).toBe(
      'done'
    );
  });

  it('有待审批 → pending', () => {
    expect(chatStatusOf({ activeRunIds: [], pendingApprovalCount: 1 })).toBe(
      'pending'
    );
  });

  it('有活动 run → running（优先于待审批）', () => {
    expect(
      chatStatusOf({ activeRunIds: ['r-1'], pendingApprovalCount: 2 })
    ).toBe('running');
    expect(
      chatStatusOf({ activeRunIds: ['r-1'], pendingApprovalCount: 0 })
    ).toBe('running');
  });
});

describe('ChatFlatItem 短按与长按', () => {
  it('短按进入会话，长按才打开菜单', async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const view = await render(
      <ChatFlatItem
        session={session()}
        snippet="摘要"
        nowMs={3_000}
        onPress={onPress}
        onLongPress={onLongPress}
      />
    );
    const row = view.getByTestId('chat-item-s-9');
    await fireEvent.press(row);
    expect(onPress).toHaveBeenCalledWith('s-9');
    expect(onLongPress).not.toHaveBeenCalled();
    await fireEvent(row, 'longPress');
    expect(onLongPress).toHaveBeenCalledWith('s-9');
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
