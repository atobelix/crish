import { createRef } from 'react';
import { TextInput } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { lightTokens } from '@/adapters/platform/theme';
import Input from './Input';

describe('Input 原子组件（AGENTS.md §13）', () => {
  it('渲染输入框及 label 与 error', async () => {
    await render(
      <Input
        label="用户名"
        error="用户名不能为空"
        placeholder="请输入用户名"
        testID="test-input"
      />
    );

    expect(screen.getByText('用户名')).toBeTruthy();
    expect(screen.getByText('用户名不能为空')).toBeTruthy();
    expect(screen.getByTestId('test-input')).toBeTruthy();
  });

  it('聚焦与失焦状态切换 border 颜色（柔和焦点态，~5.8% 混入）', async () => {
    await render(
      <Input
        placeholder="请输入"
        testID="test-input"
      />
    );

    const input = screen.getByTestId('test-input');
    // 初始状态为 hairlineStrong
    expect(input.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          borderColor: lightTokens.hairlineStrong,
        }),
      ])
    );

    // 聚焦状态切换为 focusBorder
    await fireEvent(input, 'focus');
    expect(input.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          borderColor: lightTokens.focusBorder,
        }),
      ])
    );

    // 失焦状态恢复为 hairlineStrong
    await fireEvent(input, 'blur');
    expect(input.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          borderColor: lightTokens.hairlineStrong,
        }),
      ])
    );
  });

  it('错误状态优先展示 colorError 边框', async () => {
    await render(
      <Input
        error="格式错误"
        testID="test-input"
      />
    );

    const input = screen.getByTestId('test-input');
    expect(input.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          borderColor: lightTokens.colorError,
        }),
      ])
    );

    // 即使聚焦仍保持 error 边框
    await fireEvent(input, 'focus');
    expect(input.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          borderColor: lightTokens.colorError,
        }),
      ])
    );
  });

  it('禁用态（editable=false）呈现半透明弱化', async () => {
    await render(
      <Input
        editable={false}
        testID="test-input"
      />
    );

    const input = screen.getByTestId('test-input');
    expect(input.props.editable).toBe(false);
    expect(input.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          opacity: 0.5,
        }),
      ])
    );
  });

  it('支持 ref 转发', async () => {
    const ref = createRef<TextInput>();
    await render(<Input ref={ref} testID="test-input" />);
    expect(ref.current).toBeTruthy();
  });
});
