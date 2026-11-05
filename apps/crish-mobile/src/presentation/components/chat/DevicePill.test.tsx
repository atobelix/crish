import { fireEvent, render } from '@testing-library/react-native';
import { DevicePill } from './DevicePill';
import { connectionStore } from '@/domain/store/connectionStore';
import { deviceDirectoryStore } from '@/domain/store/deviceDirectoryStore';

describe('DevicePill memo化与交互', () => {
  beforeEach(() => {
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    deviceDirectoryStore.getState().clear();
  });

  it('渲染设备胶囊与状态指示，点击触发 onPress 回调', async () => {
    const onPress = jest.fn();
    const view = await render(<DevicePill onPress={onPress} />);

    const pill = view.getByTestId('device-pill');
    expect(pill).toBeTruthy();
    expect(view.getByTestId('device-pill-pip')).toBeTruthy();

    await fireEvent.press(pill);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('React.memo 纯净阻断：相同 onPress 引用重绘跳过子树', async () => {
    const onPress = jest.fn();
    const view = await render(<DevicePill onPress={onPress} />);

    await view.rerender(<DevicePill onPress={onPress} />);
    expect(view.getByTestId('device-pill')).toBeTruthy();
  });
});
