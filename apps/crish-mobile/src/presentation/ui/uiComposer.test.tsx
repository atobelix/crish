// Composer 测试：输入回调与发送可用态。
import { fireEvent, render } from '@testing-library/react-native';
import { Composer } from '@/presentation/ui';

function renderComposer(canSubmit: boolean) {
  const onSubmit = jest.fn();
  const onChangeText = jest.fn();
  const element = (
    <Composer
      testID="composer"
      value={canSubmit ? '跑测试' : ''}
      placeholder="给电脑发一条指令"
      onChangeText={onChangeText}
      onSubmit={onSubmit}
      canSubmit={canSubmit}
      editable
    />
  );
  return { element, onSubmit, onChangeText };
}

describe('Composer', () => {
  it('forwards text and blocks submit when not allowed', async () => {
    const { element, onSubmit, onChangeText } = renderComposer(false);
    const view = await render(element);
    await fireEvent.changeText(view.getByTestId('composer'), '跑测试');
    await fireEvent.press(view.getByTestId('composer-send'));
    expect(onChangeText).toHaveBeenCalledWith('跑测试');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits when allowed', async () => {
    const { element, onSubmit } = renderComposer(true);
    const view = await render(element);
    await fireEvent.press(view.getByTestId('composer-send'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
