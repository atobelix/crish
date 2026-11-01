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

  it('G1 快捷条：注入 contextBar 时渲染项目/权限胶囊并回调，未注入则不渲染', async () => {
    const onWorkspacePress = jest.fn();
    const onPermissionPress = jest.fn();
    const view = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
        contextBar={{
          workspaceLabel: 'conex',
          permissionLabel: '智能放行',
          onWorkspacePress,
          onPermissionPress,
        }}
      />
    );
    expect(view.getByText('conex')).toBeTruthy();
    expect(view.getByText('智能放行')).toBeTruthy();
    await fireEvent.press(view.getByTestId('composer-workspace'));
    await fireEvent.press(view.getByTestId('composer-permission'));
    expect(onWorkspacePress).toHaveBeenCalledTimes(1);
    expect(onPermissionPress).toHaveBeenCalledTimes(1);

    const { element } = renderComposer(false);
    const plain = await render(element);
    expect(plain.queryByTestId('composer-workspace')).toBeNull();
    expect(plain.queryByTestId('composer-permission')).toBeNull();
    expect(plain.queryByTestId('composer-model')).toBeNull();
  });

  it('G1 展开行模型钮：注入 model 时存在（标签 + 点击回调）', async () => {
    const onPress = jest.fn();
    const view = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
        model={{ label: '默认模型', onPress }}
      />
    );
    expect(view.getByText('默认模型')).toBeTruthy();
    // 展开行收起时 pointerEvents 关闭（不可点）；聚焦输入进入展开形态后可点
    await fireEvent(view.getByTestId('composer'), 'focus');
    await fireEvent.press(view.getByTestId('composer-model'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('G5b 纯附件可发：无文字 + hasAttachments 时右槽出发送盘并可提交；未注入则不出', async () => {
    const onSubmit = jest.fn();
    const withAttachments = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={onSubmit}
        canSubmit
        editable
        hasAttachments
      />
    );
    await fireEvent.press(withAttachments.getByTestId('composer-send'));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    const without = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit
        editable
      />
    );
    expect(without.queryByTestId('composer-send')).toBeNull();
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
