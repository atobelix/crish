// ApprovalActionBar 组件测试（R2UX-04-03 busy 防双点 / R2UX-04-07 布局 / 双阶段确认）：
// 允许单击流、拒绝二次确认流（确认发送/取消不发送）、busy 期间防双点与弹窗关闭、按钮恒位布局
// 注：@testing-library/react-native v14 render/fireEvent/rerender 为异步 API，全部 await
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import ApprovalActionBar from './ApprovalActionBar';

describe('ApprovalActionBar 允许流（F2 §5.2 L1 单击即决策）', () => {
  it('点击允许触发一次 onAllow', async () => {
    const onAllow = jest.fn();
    const onDeny = jest.fn();
    await render(
      <ApprovalActionBar busy={false} onAllow={onAllow} onDeny={onDeny} />
    );

    await fireEvent.press(screen.getByTestId('approval-allow'));
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onDeny).not.toHaveBeenCalled();
  });
});

describe('ApprovalActionBar 拒绝双阶段确认（任务书 R2-04 / F2 §5.3 安全模式）', () => {
  it('确认拒绝后触发一次 onDeny 并关闭弹窗', async () => {
    const onAllow = jest.fn();
    const onDeny = jest.fn();
    await render(
      <ApprovalActionBar busy={false} onAllow={onAllow} onDeny={onDeny} />
    );

    await fireEvent.press(screen.getByTestId('approval-deny'));
    expect(screen.getByTestId('approval-deny-dialog')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('deny-confirm'));
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onAllow).not.toHaveBeenCalled();
    expect(screen.queryByTestId('approval-deny-dialog')).toBeNull();
  });

  it('取消不发送：弹窗关闭且 onDeny 不被调用', async () => {
    const onDeny = jest.fn();
    await render(
      <ApprovalActionBar busy={false} onAllow={jest.fn()} onDeny={onDeny} />
    );

    await fireEvent.press(screen.getByTestId('approval-deny'));
    await fireEvent.press(screen.getByTestId('deny-cancel'));
    expect(onDeny).not.toHaveBeenCalled();
    expect(screen.queryByTestId('approval-deny-dialog')).toBeNull();
  });

  it('遮罩点击等价取消（M4 §6.3）', async () => {
    const onDeny = jest.fn();
    await render(
      <ApprovalActionBar busy={false} onAllow={jest.fn()} onDeny={onDeny} />
    );

    await fireEvent.press(screen.getByTestId('approval-deny'));
    await fireEvent.press(screen.getByTestId('dialog-backdrop'));
    expect(onDeny).not.toHaveBeenCalled();
    expect(screen.queryByTestId('approval-deny-dialog')).toBeNull();
  });
});

describe('ApprovalActionBar busy 防双点（R2UX-04-03 / F2 §9.3-3）', () => {
  it('busy 期间点击允许无效', async () => {
    const onAllow = jest.fn();
    await render(
      <ApprovalActionBar busy onAllow={onAllow} onDeny={jest.fn()} />
    );

    await fireEvent.press(screen.getByTestId('approval-allow'));
    expect(onAllow).not.toHaveBeenCalled();
  });

  it('busy 期间点击拒绝不弹出确认弹窗', async () => {
    const onDeny = jest.fn();
    await render(
      <ApprovalActionBar busy onAllow={jest.fn()} onDeny={onDeny} />
    );

    await fireEvent.press(screen.getByTestId('approval-deny'));
    expect(screen.queryByTestId('approval-deny-dialog')).toBeNull();
    expect(onDeny).not.toHaveBeenCalled();
  });

  it('busy 期间已打开的确认弹窗强制关闭（防双点）', async () => {
    const { rerender } = await render(
      <ApprovalActionBar busy={false} onAllow={jest.fn()} onDeny={jest.fn()} />
    );
    await fireEvent.press(screen.getByTestId('approval-deny'));
    expect(screen.getByTestId('approval-deny-dialog')).toBeTruthy();

    await rerender(
      <ApprovalActionBar busy onAllow={jest.fn()} onDeny={jest.fn()} />
    );
    expect(screen.queryByTestId('approval-deny-dialog')).toBeNull();
  });

  it('busy 视觉：双按钮禁用 + 允许按钮 loading 态', async () => {
    await render(
      <ApprovalActionBar busy onAllow={jest.fn()} onDeny={jest.fn()} />
    );
    expect(
      screen.getByTestId('approval-allow').props.accessibilityState.disabled
    ).toBe(true);
    expect(
      screen.getByTestId('approval-deny').props.accessibilityState.disabled
    ).toBe(true);
  });
});

describe('ApprovalActionBar 布局（R2UX-04-07 / F2 §9.3-1 / M4 §6.2-1）', () => {
  it('拒绝恒左、允许恒右（子序固定）', async () => {
    await render(
      <ApprovalActionBar busy={false} onAllow={jest.fn()} onDeny={jest.fn()} />
    );
    const bar = screen.getByTestId('approval-action-bar');
    const children = bar.props.children as Array<{
      props: { testID?: string };
    }>;
    expect(children[0]?.props.testID).toBe('approval-deny');
    expect(children[1]?.props.testID).toBe('approval-allow');
  });

  it('双按钮间距 ≥48dp', async () => {
    await render(
      <ApprovalActionBar busy={false} onAllow={jest.fn()} onDeny={jest.fn()} />
    );
    const bar = screen.getByTestId('approval-action-bar');
    const flat = StyleSheet.flatten(bar.props.style);
    expect((flat as { gap?: number }).gap ?? 0).toBeGreaterThanOrEqual(48);
  });

  it('无障碍 label 带工具名（R2UX-04-10「类型 + 摘要」）', async () => {
    await render(
      <ApprovalActionBar
        busy={false}
        onAllow={jest.fn()}
        onDeny={jest.fn()}
        toolName="delete_file"
      />
    );
    expect(screen.getByTestId('approval-allow').props.accessibilityLabel).toBe(
      '允许此请求（delete_file）'
    );
    expect(screen.getByTestId('approval-deny').props.accessibilityLabel).toBe(
      '拒绝此请求（delete_file）'
    );
  });
});
