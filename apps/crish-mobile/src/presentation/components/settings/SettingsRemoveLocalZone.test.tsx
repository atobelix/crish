// SettingsRemoveLocalZone 组件测试（R2-06，R2UX-06-06 移除本机双保险）：
// 双保险确认（标题+后果+danger 主按钮+取消）/ 取消与遮罩不执行 / 确认执行一次 /
// 焦点初始落取消（actions 顺序）/ 移除中防双点
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  REMOVE_LOCAL_DIALOG_DESCRIPTION,
  REMOVE_LOCAL_DIALOG_TITLE,
  removeLocalDialogActions,
} from './SettingsRemoveLocalZone';
import SettingsRemoveLocalZone from './SettingsRemoveLocalZone';

describe('removeLocalDialogActions（R2UX-06-06 焦点不落危险按钮）', () => {
  it('取消在前、危险主按钮在后（初始焦点/读屏顺序落取消）', () => {
    const confirm = jest.fn();
    const cancel = jest.fn();
    const actions = removeLocalDialogActions(confirm, cancel);
    expect(actions.map((a) => a.label)).toEqual([
      '取消',
      REMOVE_LOCAL_DIALOG_TITLE,
    ]);
    expect(actions[0]!.variant).toBe('secondary');
    expect(actions[0]!.testID).toBe('settings-remove-cancel');
    expect(actions[1]!.variant).toBe('danger');
    expect(actions[1]!.testID).toBe('settings-remove-confirm');
  });
});

describe('SettingsRemoveLocalZone', () => {
  it('危险区：按钮 + 后果说明', async () => {
    await render(<SettingsRemoveLocalZone onConfirm={jest.fn()} />);
    expect(screen.getByTestId('settings-remove-local')).toBeTruthy();
    expect(
      screen.getByText(
        '解除与桌面端的配对，并清空本机的配对数据；移除后需重新配对。'
      )
    ).toBeTruthy();
  });

  it('双保险：弹窗含标题 + 后果（解除配对/清空本地数据/需重新配对）', async () => {
    await render(<SettingsRemoveLocalZone onConfirm={jest.fn()} />);
    await fireEvent.press(screen.getByTestId('settings-remove-local'));
    expect(screen.getByTestId('settings-remove-dialog')).toBeTruthy();
    // 弹窗标题 + 危险区标题/按钮均含「移除本机」→ 多处匹配（弹窗打开后 ≥2 处）
    expect(
      screen.getAllByText(REMOVE_LOCAL_DIALOG_TITLE).length
    ).toBeGreaterThan(0);
    expect(screen.getByText(REMOVE_LOCAL_DIALOG_DESCRIPTION)).toBeTruthy();
    expect(REMOVE_LOCAL_DIALOG_DESCRIPTION).toContain('解除本机与桌面端的配对');
    expect(REMOVE_LOCAL_DIALOG_DESCRIPTION).toContain('清空本机的配对数据');
    expect(REMOVE_LOCAL_DIALOG_DESCRIPTION).toContain('需重新配对');
  });

  it('取消 → 弹窗关闭且不执行确认', async () => {
    const onConfirm = jest.fn();
    await render(<SettingsRemoveLocalZone onConfirm={onConfirm} />);
    await fireEvent.press(screen.getByTestId('settings-remove-local'));
    await fireEvent.press(screen.getByTestId('settings-remove-cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId('settings-remove-dialog')).toBeNull();
  });

  it('遮罩点击 → 等价取消，不执行确认', async () => {
    const onConfirm = jest.fn();
    await render(<SettingsRemoveLocalZone onConfirm={onConfirm} />);
    await fireEvent.press(screen.getByTestId('settings-remove-local'));
    await fireEvent.press(screen.getByTestId('dialog-backdrop'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId('settings-remove-dialog')).toBeNull();
  });

  it('确认 → onConfirm 恰调用一次，弹窗关闭', async () => {
    const onConfirm = jest.fn(async () => {});
    await render(<SettingsRemoveLocalZone onConfirm={onConfirm} />);
    await fireEvent.press(screen.getByTestId('settings-remove-local'));
    await fireEvent.press(screen.getByTestId('settings-remove-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('settings-remove-dialog')).toBeNull();
  });

  it('移除中防双点：onConfirm 挂起时按钮 loading 禁用，重复打开被拦截', async () => {
    let resolveConfirm: (() => void) | undefined;
    const onConfirm = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        })
    );
    await render(<SettingsRemoveLocalZone onConfirm={onConfirm} />);
    await fireEvent.press(screen.getByTestId('settings-remove-local'));
    await fireEvent.press(screen.getByTestId('settings-remove-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const button = screen.getByTestId('settings-remove-local');
    expect(button.props.accessibilityState.disabled).toBe(true);
    // 移除中再次点危险区按钮 → 弹窗不打开（guard 拦截）
    await fireEvent.press(button);
    expect(screen.queryByTestId('settings-remove-dialog')).toBeNull();
    // 完成后可再次操作
    await actResolve(resolveConfirm);
  });
});

/** 手动 resolve 挂起的 onConfirm 并等待收尾（act 包装，避免 finally setState 未包裹警告） */
async function actResolve(resolve: (() => void) | undefined): Promise<void> {
  await act(async () => {
    resolve?.();
    await Promise.resolve();
  });
}
