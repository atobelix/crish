// ApprovalBadge 组件测试（R2-04 任务书第 2 点：会话角标）：
// 计数显示（count > 0 → 「N 待审批」风险色胶囊）、count ≤ 0 不渲染（诚实化 M4 §4.1）、
// 可交互（onPress 点击跳转审批列表）
// 注：@testing-library/react-native v14 render/fireEvent 为异步 API，全部 await
import { fireEvent, render, screen } from '@testing-library/react-native';
import ApprovalBadge from './ApprovalBadge';

describe('ApprovalBadge（会话审批角标，R2-04-02）', () => {
  it('count ≤ 0 不渲染（诚实化：无数据不显示 0，M4 §4.1）', async () => {
    await render(<ApprovalBadge count={0} />);
    expect(screen.queryByTestId('approval-badge')).toBeNull();
  });

  it('count > 0 显示「N 待审批」胶囊', async () => {
    await render(<ApprovalBadge count={3} />);
    expect(screen.getByTestId('approval-badge')).toBeTruthy();
    expect(screen.getByText('3 待审批')).toBeTruthy();
  });

  it('缺省 onPress 为非交互视图，不产生 button 语义', async () => {
    await render(<ApprovalBadge count={2} />);
    const badge = screen.getByTestId('approval-badge');
    expect(badge.props.accessibilityRole).not.toBe('button');
  });

  it('onPress 提供点击（跳转审批列表）', async () => {
    const onPress = jest.fn();
    await render(<ApprovalBadge count={1} onPress={onPress} />);
    await fireEvent.press(screen.getByTestId('approval-badge'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
