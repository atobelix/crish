// 呼吸点（S4）结构口径：周期与桌面 1.6s 同值；默认 7dp 品牌色圆点，
// 圆角 = 直径/2 实值；尺寸/颜色可覆盖。动画本身（呼吸/Reduce Motion
// 静态）在 jest 桩下无语义，真机口径由组件内共享信号保证。
import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { RUNNING_PULSE_PERIOD_MS, RunningPulseDot } from './RunningPulseDot';

describe('RunningPulseDot', () => {
  it('呼吸周期与桌面 1.6s 口径同值', () => {
    expect(RUNNING_PULSE_PERIOD_MS).toBe(1600);
  });

  it('默认 7dp 圆点：圆角 = 直径/2 实值、品牌色', async () => {
    const view = await render(<RunningPulseDot testID="pulse-dot" />);
    const style = StyleSheet.flatten(view.getByTestId('pulse-dot').props.style);
    expect(style.width).toBe(7);
    expect(style.height).toBe(7);
    expect(style.borderRadius).toBe(3.5);
    expect(typeof style.backgroundColor).toBe('string');
    expect(style.backgroundColor).not.toBe('#123456');
  });

  it('尺寸/颜色可覆盖', async () => {
    const view = await render(
      <RunningPulseDot testID="pulse-dot" size={10} color="#123456" />
    );
    const style = StyleSheet.flatten(view.getByTestId('pulse-dot').props.style);
    expect(style.width).toBe(10);
    expect(style.height).toBe(10);
    expect(style.borderRadius).toBe(5);
    expect(style.backgroundColor).toBe('#123456');
  });
});
