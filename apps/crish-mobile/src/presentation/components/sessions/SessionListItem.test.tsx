// 远端会话行状态徽标（批 D）：单槽优先级 待审批 > 运行中 > 失败；
// 失败 = 上一轮运行失败打点（lastRunFailedAtMs），呈现为危险色
// 图标 + 「失败」弱文字；已完成态无徽标（内容净化裁决）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { SessionListItem, sessionRowBadge } from './SessionListItem';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-1',
    title: '会话标题',
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

describe('sessionRowBadge 单槽裁决', () => {
  it('待审批优先于运行中与失败', () => {
    expect(
      sessionRowBadge(
        session({
          pendingApprovalCount: 2,
          activeRunIds: ['r-1'],
          lastRunFailedAtMs: 5_000,
        })
      )
    ).toBe('approval');
  });

  it('运行中优先于失败（失败打点在新 run 开始时已被数据面清零，此为呈现层兜底）', () => {
    expect(
      sessionRowBadge(
        session({ activeRunIds: ['r-1'], lastRunFailedAtMs: 5_000 })
      )
    ).toBe('running');
  });

  it('只有失败打点 → failed；干净会话 → none', () => {
    expect(sessionRowBadge(session({ lastRunFailedAtMs: 5_000 }))).toBe(
      'failed'
    );
    expect(sessionRowBadge(session())).toBe('none');
    expect(sessionRowBadge(session({ completedAtMs: 5_000 }))).toBe('none');
  });
});

describe('SessionListItem 失败呈现', () => {
  it('失败徽标在位、无障碍标签带「上次运行失败」', async () => {
    const view = await render(
      <SessionListItem
        session={session({ lastRunFailedAtMs: 5_000 })}
        onPress={jest.fn()}
      />
    );
    expect(view.getByTestId('session-failed-badge')).toBeTruthy();
    expect(view.getByText('失败')).toBeTruthy();
    expect(
      view.getByTestId('session-row-s-1').props.accessibilityLabel
    ).toContain('上次运行失败');
  });

  it('待审批时不呈现失败徽标（单槽）', async () => {
    const view = await render(
      <SessionListItem
        session={session({ pendingApprovalCount: 1, lastRunFailedAtMs: 5_000 })}
        onPress={jest.fn()}
      />
    );
    expect(view.getByTestId('session-approval-badge')).toBeTruthy();
    expect(view.queryByTestId('session-failed-badge')).toBeNull();
  });

  it('短按进入会话，长按才打开菜单', async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const view = await render(
      <SessionListItem
        session={session()}
        onPress={onPress}
        onLongPress={onLongPress}
      />
    );
    const row = view.getByTestId('session-row-s-1');
    // 真 Pressable 把阈值交给 usePressability，宿主上看不到。
    // 行必须把共享常量原样传下去（常量本身是 500，见 useSessionRowActions 测试）。
    const source = readFileSync(join(__dirname, 'SessionListItem.tsx'), 'utf8');
    expect(source).toContain('delayLongPress={rowActions.delayLongPress}');
    await fireEvent.press(row);
    expect(onPress).toHaveBeenCalledWith('s-1');
    expect(onLongPress).not.toHaveBeenCalled();
    await fireEvent(row, 'pressIn');
    await fireEvent(row, 'pressOut');
    expect(onLongPress).not.toHaveBeenCalled();
    await fireEvent(row, 'longPress');
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith('s-1');
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('SessionListItem 纯净视觉（去底色钉案）', () => {
  it('未选中状态下背景色恒为 transparent，文字字重为 500', async () => {
    const view = await render(
      <SessionListItem
        session={session({ id: 's-view-1', title: '用户调研会话' })}
        selected={false}
        onPress={jest.fn()}
      />
    );
    const row = view.getByTestId('session-row-s-view-1');
    expect(StyleSheet.flatten(row.props.style).backgroundColor).toBe(
      'transparent'
    );
    const title = view.getByText('用户调研会话');
    const flatTitleStyle = StyleSheet.flatten(title.props.style);
    expect(flatTitleStyle.fontWeight).toBe('500');
  });

  it('选中状态下背景色仍为 transparent，绝不添加 fillSelected 浅灰底色，字重提至 600', async () => {
    const view = await render(
      <SessionListItem
        session={session({ id: 's-view-2', title: '深度对齐会话' })}
        selected={true}
        onPress={jest.fn()}
      />
    );
    const row = view.getByTestId('session-row-s-view-2');
    expect(StyleSheet.flatten(row.props.style).backgroundColor).toBe(
      'transparent'
    );
    // 选中态纯视觉字阶加粗断言
    const title = view.getByText('深度对齐会话');
    const flatTitleStyle = StyleSheet.flatten(title.props.style);
    expect(flatTitleStyle.fontWeight).toBe('600');
  });
});
