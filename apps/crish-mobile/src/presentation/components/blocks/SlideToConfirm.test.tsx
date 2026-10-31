// SlideToConfirm 组件测试（实现波总方案 F2：Reanimated worklet 手势形态）
// - 判定语义：slideReleaseDecision 纯函数全量覆盖（阈值确认 / 未达回弹 / 边界）；
// - 渲染形态：滑轨 + 滑块 + 文案；armed 态由 worklet 反应驱动（jest 桩不跑
//   UI 线程，armed 翻转与触发回调的真机语义由集中验收清单承担）；
// - reduce-motion 降级：滑轨改「允许」按钮 + 两段式确认弹窗全链路；
// - busy 锁定：disabled 传透 + 弹窗文案。
import { AccessibilityInfo } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import {
  SLIDE_THUMB_SIZE,
  slideReleaseDecision,
  slideUsableWidth,
  default as SlideToConfirm,
} from './SlideToConfirm';

beforeAll(() => {
  // reduce-motion 探测：永不 resolve → 稳定走滑轨形态（降级路径测试用 reduceMotion prop 注入）
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockReturnValue(new Promise(() => {}) as never);
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() } as never);
});

describe('slideReleaseDecision（抬起判定纯函数）', () => {
  it('未达阈值 → rebound', () => {
    expect(slideReleaseDecision(0)).toBe('rebound');
    expect(slideReleaseDecision(0.69)).toBe('rebound');
  });

  it('达到阈值 → confirm；100% 仍为 confirm（抬起触发，不自动触发）', () => {
    expect(slideReleaseDecision(0.7)).toBe('confirm');
    expect(slideReleaseDecision(1)).toBe('confirm');
  });

  it('阈值可注入', () => {
    expect(slideReleaseDecision(0.5, 0.5)).toBe('confirm');
    expect(slideReleaseDecision(0.4, 0.5)).toBe('rebound');
  });
});

describe('slideUsableWidth / SLIDE_THUMB_SIZE', () => {
  it('可滑动距离 = 轨道 - 滑块，未测量（<=0）时为 0', () => {
    expect(slideUsableWidth(300)).toBe(300 - SLIDE_THUMB_SIZE);
    expect(slideUsableWidth(0)).toBe(0);
    expect(slideUsableWidth(20)).toBe(0);
  });
});

describe('SlideToConfirm 渲染形态', () => {
  it('滑轨 + 滑块 + 默认文案 + 无障碍标注', async () => {
    await render(<SlideToConfirm onConfirm={() => {}} />);
    expect(screen.getByTestId('slide-to-confirm')).toBeTruthy();
    expect(screen.getByTestId('slide-thumb')).toBeTruthy();
    expect(screen.getByTestId('slide-label')).toHaveTextContent('滑动以允许');
    expect(screen.getByTestId('slide-to-confirm').props.accessibilityRole).toBe(
      'button'
    );
  });

  it('busy 锁定：accessibilityState.disabled 传透', async () => {
    await render(<SlideToConfirm onConfirm={() => {}} disabled />);
    expect(
      screen.getByTestId('slide-to-confirm').props.accessibilityState
    ).toMatchObject({ disabled: true });
  });

  it('reduce-motion 降级：两段式确认（允许按钮 → 确认框 → 确认放行触发一次）', async () => {
    const onConfirm = jest.fn();
    const view = await render(
      <SlideToConfirm onConfirm={onConfirm} reduceMotion />
    );
    await fireEvent.press(view.getByTestId('slide-allow-button'));
    expect(view.getByTestId('slide-confirm-dialog')).toBeTruthy();
    await fireEvent.press(view.getByTestId('slide-confirm-cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    await fireEvent.press(view.getByTestId('slide-allow-button'));
    await fireEvent.press(view.getByTestId('slide-confirm-accept'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('busy 锁定下两段式确认不触发', async () => {
    const onConfirm = jest.fn();
    const view = await render(
      <SlideToConfirm onConfirm={onConfirm} disabled reduceMotion />
    );
    await fireEvent.press(view.getByTestId('slide-allow-button'));
    expect(view.queryByTestId('slide-confirm-dialog')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
