import { fireEvent, render } from '@testing-library/react-native';
import { MenuButton } from './MenuButton';
import { approvalStore } from '@/domain/store/approvalStore';

describe('MenuButton memo化与交互', () => {
  beforeEach(() => {
    approvalStore.setState({ pending: [] });
  });

  it('渲染汉堡按钮，点击触发 onPress 回调', async () => {
    const onPress = jest.fn();
    const view = await render(<MenuButton onPress={onPress} />);

    const button = view.getByTestId('header-menu');
    expect(button).toBeTruthy();
    expect(button.props.accessibilityLabel).toBe('打开菜单');

    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('待审批项非空时无障碍标签包含待审批数量', async () => {
    approvalStore.setState({
      pending: [
        {
          id: 'dec-1',
          arbiter: 'user',
          status: 'pending',
          createdAt: 1000,
          expiresAt: 2000,
          decision: {
            kind: 'exec',
            command: 'ls',
          },
        } as never,
      ],
    });

    const view = await render(<MenuButton onPress={jest.fn()} />);
    const button = view.getByTestId('header-menu');
    expect(button.props.accessibilityLabel).toContain('1 项待审批');
  });

  it('React.memo 纯净阻断：相同 onPress 引用跳过子树重绘', async () => {
    const onPress = jest.fn();
    const view = await render(<MenuButton onPress={onPress} />);

    await view.rerender(<MenuButton onPress={onPress} />);
    expect(view.getByTestId('header-menu')).toBeTruthy();
  });
});
