// 按压反馈共享原语行为测试（按压过渡统一批的验证资产）：
// - usePressFade 三种消费形态的**未按压初值**与**按压终值**（jest reanimated
//   mock 语义：withTiming 直接返回目标值、useAnimatedStyle 渲染期求值——
//   pressIn 后经 rerender 断言 animated style 的落值）；
// - 防回潮意义：本文件钉住「120ms 过渡原语」的输出语义，任何把过渡改瞬时
//   （pressProgress 语义破坏）或改 pressOpacity 取值的改动在此现形。
//   源码纪律（禁瞬时写法）由 pressFeedback.guard.test.ts 钉，两层互补。
import { Pressable, StyleSheet, Text } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import Animated from 'react-native-reanimated';
import { lightTheme } from '@/adapters/platform/theme';
import { usePressFade } from './pressFeedback';

function OverlayProbe({ target }: { target: string }) {
  const press = usePressFade();
  return (
    <Pressable
      testID={target}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
    >
      <Animated.View
        testID={`${target}-overlay`}
        style={[StyleSheet.absoluteFill, press.overlayStyle]}
      />
      <Animated.View testID={`${target}-fade`} style={press.fadeStyle}>
        <Text>fade</Text>
      </Animated.View>
      <Animated.View testID={`${target}-scale`} style={press.pressScaleStyle}>
        <Text>scale</Text>
      </Animated.View>
    </Pressable>
  );
}

function flat(node: { props: { style?: unknown } }): Record<string, unknown> {
  return StyleSheet.flatten(node.props.style as never) ?? {};
}

describe('usePressFade：按压过渡原语输出语义', () => {
  it('未按压初值：叠层透明、整件不透明、缩放 1', async () => {
    const view = await render(<OverlayProbe target="probe" />);
    expect(flat(await view.findByTestId('probe-overlay')).opacity).toBe(0);
    expect(flat(await view.findByTestId('probe-fade')).opacity).toBe(1);
    expect(flat(await view.findByTestId('probe-scale')).transform).toEqual([
      { scale: 1 },
    ]);
  });

  it('按压终值（pressIn + 重渲染）：叠层全显、整件 pressOpacity、缩放 pressScale', async () => {
    const view = await render(<OverlayProbe target="probe" />);
    await act(async () => {
      fireEvent(await view.findByTestId('probe'), 'pressIn');
    });
    view.rerender(<OverlayProbe target="probe" />);
    const { pressOpacity, pressScale } = lightTheme.motion;
    expect(flat(await view.findByTestId('probe-overlay')).opacity).toBe(1);
    expect(flat(await view.findByTestId('probe-fade')).opacity).toBe(
      pressOpacity
    );
    expect(flat(await view.findByTestId('probe-scale')).transform).toEqual([
      { scale: pressScale },
    ]);
  });

  it('抬起（pressOut + 重渲染）：三种形态回到未按压值（120ms 过渡的终态语义）', async () => {
    const view = await render(<OverlayProbe target="probe" />);
    await act(async () => {
      fireEvent(await view.findByTestId('probe'), 'pressIn');
    });
    view.rerender(<OverlayProbe target="probe" />);
    await act(async () => {
      fireEvent(await view.findByTestId('probe'), 'pressOut');
    });
    view.rerender(<OverlayProbe target="probe" />);
    expect(flat(await view.findByTestId('probe-overlay')).opacity).toBe(0);
    expect(flat(await view.findByTestId('probe-fade')).opacity).toBe(1);
    expect(flat(await view.findByTestId('probe-scale')).transform).toEqual([
      { scale: 1 },
    ]);
  });
});
