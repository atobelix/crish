// apps/crish-mobile/src/presentation/components/blocks/CitationPill.test.tsx
// CitationPill 引证胶囊单元测试：
// 1. 结构与可访问性：验证渲染 [index] 微型标识、accessibilityRole="button" 与无障碍描述；
// 2. 交互与触感：点击触发 haptics.selection() 轻微震动与 onPress 回调；
// 3. 联动高亮：highlighted 为 true 时产生高对比度微混样式；
// 4. 按压动效：pressIn / pressOut 配合 usePressFade 输出过渡样式。

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';
import { CitationPill } from './CitationPill';
import { haptics } from '@/adapters/platform/haptics';
import { lightTheme } from '@/adapters/platform/theme';
import type { CitationItem } from '@crish/shared-types';

jest.mock('@/adapters/platform/haptics', () => ({
  haptics: {
    selection: jest.fn(),
    tap: jest.fn(),
    snap: jest.fn(),
    success: jest.fn(),
    failure: jest.fn(),
  },
}));

function flat(node: { props: { style?: unknown } }): Record<string, unknown> {
  return StyleSheet.flatten(node.props.style as never) ?? {};
}

describe('CitationPill · 引证胶囊组件', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('正确渲染 [1] 微型标识与可访问性属性', async () => {
    await render(<CitationPill index={1} />);

    const pill = screen.getByTestId('citation-pill-1');
    expect(pill).toBeTruthy();
    expect(pill.props.accessibilityRole).toBe('button');
    expect(pill.props.accessibilityLabel).toBe('引用来源 1');

    expect(screen.getByText('[1]')).toBeTruthy();
  });

  it('支持自定义 testID', async () => {
    await render(<CitationPill index={2} testID="custom-cite-pill" />);
    expect(screen.getByTestId('custom-cite-pill')).toBeTruthy();
    expect(screen.getByText('[2]')).toBeTruthy();
  });

  it('点击胶囊触发 haptics.selection() 与 onPress 回调', async () => {
    const onPressMock = jest.fn();
    const citation: CitationItem = {
      index: 1,
      sourceId: 'src-1',
      title: '示例网页',
      url: 'https://example.com',
      domain: 'example.com',
    };

    await render(
      <CitationPill index={1} citation={citation} onPress={onPressMock} />
    );

    const pill = screen.getByTestId('citation-pill-1');
    await act(async () => {
      fireEvent.press(pill);
    });

    expect(haptics.selection).toHaveBeenCalledTimes(1);
    expect(onPressMock).toHaveBeenCalledTimes(1);
    expect(onPressMock).toHaveBeenCalledWith(1, citation);
  });

  it('未提供 onPress 时点击依然触发 haptics 触感', async () => {
    await render(<CitationPill index={3} />);

    const pill = screen.getByTestId('citation-pill-3');
    await act(async () => {
      fireEvent.press(pill);
    });

    expect(haptics.selection).toHaveBeenCalledTimes(1);
  });

  it('联动高亮模式下背景与边框呈现高对比度微混色', async () => {
    const { rerender } = await render(
      <CitationPill index={1} highlighted={false} />
    );

    const normalPill = screen.getByTestId('citation-pill-1');
    const normalStyle = flat(normalPill);
    expect(normalStyle.backgroundColor).toBe(lightTheme.colors.surfaceGrouped);
    expect(normalStyle.borderColor).toBe(lightTheme.colors.hairline);

    await rerender(<CitationPill index={1} highlighted={true} />);

    const highlightedPill = screen.getByTestId('citation-pill-1');
    const highlightedStyle = flat(highlightedPill);
    expect(highlightedStyle.backgroundColor).toBe(
      lightTheme.colors.fillPressed
    );
    expect(highlightedStyle.borderColor).toBe(lightTheme.colors.brand);

    const textNode = screen.getByText('[1]');
    const textStyle = flat(textNode);
    expect(textStyle.color).toBe(lightTheme.colors.brand);
  });

  it('支持按压过渡微透明动效', async () => {
    const { rerender } = await render(<CitationPill index={4} />);

    let pill = screen.getByTestId('citation-pill-4');
    expect(flat(pill).opacity).toBe(1);

    await act(async () => {
      fireEvent(pill, 'pressIn');
    });
    await rerender(<CitationPill index={4} />);
    pill = screen.getByTestId('citation-pill-4');
    expect(flat(pill).opacity).toBe(lightTheme.motion.pressOpacity);

    await act(async () => {
      fireEvent(pill, 'pressOut');
    });
    await rerender(<CitationPill index={4} />);
    pill = screen.getByTestId('citation-pill-4');
    expect(flat(pill).opacity).toBe(1);
  });

  it('支持传递自定义外部与文字样式', async () => {
    const customContainerStyle: ViewStyle = { opacity: 0.9 };
    await render(
      <CitationPill
        index={5}
        style={customContainerStyle}
        textStyle={{ letterSpacing: 1 }}
      />
    );

    const pill = screen.getByTestId('citation-pill-5');
    expect(flat(pill).opacity).toBe(0.9);

    const textNode = screen.getByText('[5]');
    expect(flat(textNode).letterSpacing).toBe(1);
  });
});
