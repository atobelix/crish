// Composer 测试：输入回调与发送可用态。
import { fireEvent, render } from '@testing-library/react-native';
import { Composer } from '@/presentation/ui';
import type { VoiceInputApi } from '@/adapters/asr/useVoiceInput';

const fakeVoice: VoiceInputApi = {
  phase: 'idle',
  starting: false,
  displayText: '',
  level: 0,
  gateState: null,
  gateVisible: false,
  modelTotalBytes: 240193589,
  pressStart: jest.fn(),
  pressMove: jest.fn(),
  pressEnd: jest.fn(),
  confirmDownload: jest.fn(),
  dismissGate: jest.fn(),
};

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

  it('renders no microphone without the voice wiring (honest absence)', async () => {
    const { element } = renderComposer(false);
    const view = await render(element);
    expect(view.queryByTestId('composer-mic')).toBeNull();
  });

  it('renders the hold-to-talk microphone when voice is wired', async () => {
    const view = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
        voice={fakeVoice}
      />
    );
    const mic = view.getByTestId('composer-mic');
    expect(mic.props.accessibilityLabel).toBe('按住说话');
  });
});
