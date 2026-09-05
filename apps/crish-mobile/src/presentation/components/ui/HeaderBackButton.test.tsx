import { fireEvent, render, screen } from '@testing-library/react-native';
import HeaderBackButton from './HeaderBackButton';

describe('HeaderBackButton 统一返回按钮', () => {
  it('默认渲染 ‹ 图标与 header-back testID，点击触发 onPress', async () => {
    const onPress = jest.fn();
    await render(<HeaderBackButton onPress={onPress} />);

    const button = screen.getByTestId('header-back');
    expect(button).toBeTruthy();
    expect(screen.getByText('‹')).toBeTruthy();

    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('支持自定义 label、testID 与 accessibilityLabel', async () => {
    const onPress = jest.fn();
    await render(
      <HeaderBackButton
        onPress={onPress}
        label="‹ 返回"
        testID="custom-back"
        accessibilityLabel="返回上一级"
      />
    );

    const button = screen.getByTestId('custom-back');
    expect(button).toBeTruthy();
    expect(screen.getByText('‹ 返回')).toBeTruthy();
    expect(button.props.accessibilityLabel).toBe('返回上一级');

    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
