import { act, fireEvent, render } from '@testing-library/react-native';
import { Pressable, Text, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import {
  useTimelineBottomInset,
  OVERLAY_INSET_TRAILING_MS,
  type UseTimelineBottomInsetOptions,
  type UseTimelineBottomInsetResult,
} from './useTimelineBottomInset';
import { useKeyboardHeight } from '@/adapters/platform/useKeyboardHeight';

jest.mock('@/adapters/platform/useKeyboardHeight', () => ({
  useKeyboardHeight: jest.fn(() => 0),
}));

let probeResult: UseTimelineBottomInsetResult | null = null;

function Probe(props: UseTimelineBottomInsetOptions) {
  const result = useTimelineBottomInset(props);
  probeResult = result;
  return (
    <View testID="probe-container">
      <Text testID="inset">{result.timelineBottomInset}</Text>
      <Text testID="overlay">{result.overlayHeight}</Text>
      <Text testID="floating">{result.floatingHeight}</Text>
      <Pressable
        testID="fire-zero"
        onPress={() => {
          result.handleOverlayLayout({
            nativeEvent: { layout: { height: 0, width: 390, x: 0, y: 0 } },
          } as LayoutChangeEvent);
        }}
      />
      <Pressable
        testID="fire-negative"
        onPress={() => {
          result.handleOverlayLayout({
            nativeEvent: { layout: { height: -20, width: 390, x: 0, y: 0 } },
          } as LayoutChangeEvent);
        }}
      />
      <Pressable
        testID="fire-165"
        onPress={() => {
          result.handleOverlayLayout({
            nativeEvent: { layout: { height: 165, width: 390, x: 0, y: 0 } },
          } as LayoutChangeEvent);
        }}
      />
      <Pressable
        testID="fire-195"
        onPress={() => {
          result.handleOverlayLayout({
            nativeEvent: { layout: { height: 195, width: 390, x: 0, y: 0 } },
          } as LayoutChangeEvent);
        }}
      />
    </View>
  );
}

describe('useTimelineBottomInset', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useKeyboardHeight as jest.Mock).mockReturnValue(0);
    probeResult = null;
  });

  it('初次挂载（未收到 onLayout）时根据配置精确估算，保证尾部留有充足空间', async () => {
    await render(
      <Probe
        bottomSafeArea={34}
        hasModelControl={true}
        hasContextBar={true}
        hasAttachments={false}
        gap={20}
      />
    );

    // 98 (两行) + 27 (快捷条) + 8 (top) + 34 (bottom) + 6 (bleed) = 173 浮层估算高
    // 173 + 20 (gap) = 193 底部 inset
    expect(probeResult?.overlayHeight).toBe(173);
    expect(probeResult?.timelineBottomInset).toBe(193);
    expect(probeResult?.floatingHeight).toBe(173);
  });

  it('单行形态（未注入模型）时基础高取 composerMin (52px)', async () => {
    await render(
      <Probe
        bottomSafeArea={0}
        hasModelControl={false}
        hasContextBar={false}
        gap={20}
      />
    );

    // 52 (单行) + 8 (top) + 8 (bottom 兜底) + 6 (bleed) = 74 浮层估算高
    // 74 + 20 = 94
    expect(probeResult?.overlayHeight).toBe(74);
    expect(probeResult?.timelineBottomInset).toBe(94);
  });

  it('首帧布局事件汇报 height <= 0 时刚性过滤，严禁覆盖有效保底值', async () => {
    const view = await render(
      <Probe bottomSafeArea={34} hasModelControl={true} gap={20} />
    );

    const initialInset = probeResult?.timelineBottomInset;
    expect(initialInset).toBeGreaterThan(100);

    // 模拟初次挂载时 React Native 绝对定位容器上报 height: 0
    await fireEvent.press(view.getByTestId('fire-zero'));
    expect(probeResult?.timelineBottomInset).toBe(initialInset);

    // 负数与非有限值同样被拦截
    await fireEvent.press(view.getByTestId('fire-negative'));
    expect(probeResult?.timelineBottomInset).toBe(initialInset);
  });

  it('收到有效实测高度时立即更新（消除 90ms 滞后）', async () => {
    const view = await render(
      <Probe bottomSafeArea={34} hasModelControl={true} gap={20} />
    );

    // 首个有效测量立即落值
    await fireEvent.press(view.getByTestId('fire-165'));

    expect(probeResult?.overlayHeight).toBe(165);
    expect(probeResult?.timelineBottomInset).toBe(185); // 165 + 20

    // 后续尺寸变化立即同步落值，无 90ms 滞后
    await fireEvent.press(view.getByTestId('fire-195'));

    expect(probeResult?.overlayHeight).toBe(195);
    expect(probeResult?.timelineBottomInset).toBe(215); // 195 + 20
  });

  it('键盘弹起时 floatingHeight 包含 keyboardHeight 供 EdgeFade 消费，但 timelineBottomInset 保持纯净', async () => {
    (useKeyboardHeight as jest.Mock).mockReturnValue(336);

    await render(
      <Probe
        bottomSafeArea={34}
        hasModelControl={true}
        hasContextBar={true}
        gap={20}
      />
    );

    // 173 (浮层) + 336 (键盘) = 509 (floatingHeight，供 EdgeFade 消费)
    // overlayHeight 保持为纯物理浮层高度 173，不受键盘高度影响，专供 ScrollToBottomButton 消费
    expect(probeResult?.overlayHeight).toBe(173);
    expect(probeResult?.floatingHeight).toBe(509);
    // timelineBottomInset 严格不含键盘高度，由 KeyboardChatScrollView 接管键盘平移
    expect(probeResult?.timelineBottomInset).toBe(193);
  });

  it('包含附件条展开时带入 ATTACHMENT_STRIP_HEIGHT (68px)', async () => {
    await render(
      <Probe
        bottomSafeArea={34}
        hasModelControl={true}
        hasAttachments={true}
        gap={20}
      />
    );

    // 基础 98 + 8 + 34 = 140 min
    // 140 + 68 + 6 = 214 估算
    // 214 + 20 = 234
    expect(probeResult?.overlayHeight).toBe(214);
    expect(probeResult?.timelineBottomInset).toBe(234);
  });

  it('R11 离散提交：动画中间帧（不足一步）不落状态，尾帧精确落定', async () => {
    const view = await render(
      <Probe bottomSafeArea={34} hasModelControl={true} gap={20} />
    );
    // 直接驱动布局事件序列（0 → 68 收展动画帧）
    const fireHeight = async (h: number) => {
      await act(async () => {
        probeResult?.handleOverlayLayout({
          nativeEvent: { layout: { height: h, width: 390, x: 0, y: 0 } },
        } as LayoutChangeEvent);
      });
    };
    const waitTrailing = () =>
      new Promise((resolve) =>
        setTimeout(resolve, OVERLAY_INSET_TRAILING_MS + 20)
      );

    // 收展动画帧：10、15、23、30、38、45、52、60、68
    await fireHeight(10); // 首次提交
    expect(probeResult?.overlayHeight).toBe(10);
    await fireHeight(15); // Δ5 < 8：不落
    expect(probeResult?.overlayHeight).toBe(10);
    await fireHeight(23); // Δ13 ≥ 8：落
    expect(probeResult?.overlayHeight).toBe(23);
    await fireHeight(30); // Δ7 < 8：不落
    await fireHeight(38); // Δ15 ≥ 8：落
    expect(probeResult?.overlayHeight).toBe(38);
    await fireHeight(45); // Δ7：不落
    await fireHeight(52); // Δ14：落
    expect(probeResult?.overlayHeight).toBe(52);
    await fireHeight(60); // Δ8：落
    expect(probeResult?.overlayHeight).toBe(60);
    await fireHeight(68); // Δ8：落
    expect(probeResult?.overlayHeight).toBe(68);

    // 动画停后尾帧：68 已精确提交，trailing 到期为 no-op
    await waitTrailing();
    expect(probeResult?.overlayHeight).toBe(68);

    // 收尾停在 62（未跨步）：不立即落，trailing 精确提交
    await fireHeight(62); // Δ6 < 8：不落（挂起）
    expect(probeResult?.overlayHeight).toBe(68);
    await waitTrailing();
    expect(probeResult?.overlayHeight).toBe(62);
    await view.unmount();
  });

  it('R11 稳态：单次提交后重复同值布局事件零广播（<1 收敛守卫）', async () => {
    const view = await render(
      <Probe bottomSafeArea={34} hasModelControl={true} gap={20} />
    );
    const fireHeight = async (h: number) => {
      await act(async () => {
        probeResult?.handleOverlayLayout({
          nativeEvent: { layout: { height: h, width: 390, x: 0, y: 0 } },
        } as LayoutChangeEvent);
      });
    };
    await fireHeight(173);
    expect(probeResult?.overlayHeight).toBe(173);
    // 同值重复回报：不重设状态、无尾帧挂起
    await fireHeight(173);
    await fireHeight(173.5);
    expect(probeResult?.overlayHeight).toBe(173);
    await view.unmount();
  });
});
