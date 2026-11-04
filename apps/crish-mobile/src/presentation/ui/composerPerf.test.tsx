// Composer 子簇 memo 化（C-PERF）：逐键回显时宿主逐渲染重造
// model/contextBar 对象字面量，旧形态下第二行/快捷条/发送盘整簇
// 逐键重渲染。本套件以「计数型 Icon 替身」统计子簇函数执行次数
// 钉口径：子簇每次真渲染必经其 Icon 叶子，memo 跳过时叶子零调用；
// props（基元 + 稳定跳板）未变时 rerender 不得再执行子簇；语义量
// 真变（标签/canSubmit）时必须执行（memo 不是冻结）。
// （Profiler 口径在本脚手架下连 Profiler 自身提交也计数，不可用，
// 故走叶子计数。）
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import Composer, {
  AttachButton,
  ComposerContextBar,
  ComposerSecondRow,
  SendButton,
} from './Composer';

let mockIconRenders = 0;

jest.mock('./Icon', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    default: function MockIcon() {
      mockIconRenders += 1;
      return React.createElement(View);
    },
  };
});

beforeEach(() => {
  mockIconRenders = 0;
});

describe('ComposerSecondRow memo（C-PERF）', () => {
  it('props 未变时 rerender 子簇零执行；标签变时执行', async () => {
    const props = {
      label: 'gpt-6-luna',
      dimmed: 1,
      showAttach: true,
      attachDisabled: false,
      onModelPress: () => {},
      onAttachPress: () => {},
      testID: 'composer',
    };
    const view = await render(<ComposerSecondRow {...props} />);
    const afterMount = mockIconRenders;
    expect(afterMount).toBeGreaterThan(0);
    // 逐键等价重渲染 ×3：同 props → 整行跳过
    for (let i = 0; i < 3; i += 1) {
      await view.rerender(<ComposerSecondRow {...props} />);
    }
    expect(mockIconRenders).toBe(afterMount);
    // 模型标签真变 → 必须执行（呈现跟随语义量）
    await view.rerender(<ComposerSecondRow {...props} label="gpt-6-pro" />);
    expect(mockIconRenders).toBeGreaterThan(afterMount);
  });
});

describe('SendButton / AttachButton memo（C-PERF）', () => {
  it('SendButton：canSubmit 未变子簇零执行，翻转时执行', async () => {
    const onSubmit = () => {};
    const view = await render(
      <SendButton canSubmit testID="composer" onSubmit={onSubmit} />
    );
    const afterMount = mockIconRenders;
    expect(afterMount).toBeGreaterThan(0);
    await view.rerender(
      <SendButton canSubmit testID="composer" onSubmit={onSubmit} />
    );
    expect(mockIconRenders).toBe(afterMount);
    await view.rerender(
      <SendButton canSubmit={false} testID="composer" onSubmit={onSubmit} />
    );
    expect(mockIconRenders).toBeGreaterThan(afterMount);
  });

  it('AttachButton：dimmed/disabled 未变子簇零执行', async () => {
    const onPress = () => {};
    const view = await render(
      <AttachButton dimmed={1} disabled={false} onPress={onPress} />
    );
    const afterMount = mockIconRenders;
    expect(afterMount).toBeGreaterThan(0);
    await view.rerender(
      <AttachButton dimmed={1} disabled={false} onPress={onPress} />
    );
    expect(mockIconRenders).toBe(afterMount);
  });
});

describe('ComposerContextBar memo（C-PERF）', () => {
  it('标签与回调未变时 rerender 子簇零执行', async () => {
    const props = {
      workspaceLabel: 'conex',
      permissionLabel: '智能放行',
      onWorkspacePress: () => {},
      onPermissionPress: () => {},
      testID: 'composer',
    };
    const view = await render(<ComposerContextBar {...props} />);
    const afterMount = mockIconRenders;
    expect(afterMount).toBeGreaterThan(0);
    await view.rerender(<ComposerContextBar {...props} />);
    expect(mockIconRenders).toBe(afterMount);
  });
});

describe('Composer 动效与多行自适应性能（方案 05）', () => {
  it('多行文字换行时高度瞬时同步，无人工延迟补间且无硬件纹理冲突', async () => {
    const view = await render(
      <Composer
        testID="composer"
        value=""
        onChangeText={() => {}}
        onSubmit={() => {}}
        canSubmit={false}
        editable
      />
    );
    const input = view.getByTestId('composer');
    // 模拟多行文本排版高度变更：从单行变两行（42px）
    await fireEvent(input, 'contentSizeChange', {
      nativeEvent: { contentSize: { width: 300, height: 42 } },
    });
    const wrap = view.getByTestId('composer-input-wrap');
    const flatStyle = StyleSheet.flatten(wrap.props.style);
    expect(flatStyle.height).toBe(42);

    // 验证 Composer shell 容器已移除 renderToHardwareTextureAndroid，杜绝 FBO 频繁重建与显存抖动
    const tree = view.toJSON();
    const hasHardwareTexture = JSON.stringify(tree).includes(
      'renderToHardwareTextureAndroid'
    );
    expect(hasHardwareTexture).toBe(false);
  });
});
