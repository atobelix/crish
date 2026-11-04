// useSmoothKeyboardTimelineLinkage 动力学控制器单元测试（方案 19 核心）
import { renderHook } from '@testing-library/react-native';
import { useSmoothKeyboardTimelineLinkage } from './useSmoothKeyboardTimelineLinkage';
import { useKeyboardHandler } from 'react-native-keyboard-controller';
import { scrollTo } from 'react-native-reanimated';

jest.mock('react-native-keyboard-controller', () => ({
  useKeyboardHandler: jest.fn(),
}));

describe('useSmoothKeyboardTimelineLinkage - 120fps 满帧平滑动力学控制器 (方案 19)', () => {
  let capturedHandler: any = null;
  const mockScrollTo = scrollTo as jest.MockedFunction<typeof scrollTo>;

  beforeEach(() => {
    jest.clearAllMocks();
    (useKeyboardHandler as jest.Mock).mockImplementation((handler: any) => {
      capturedHandler = handler;
    });
  });

  it('场景 1：满页吸底状态（follow=true 且在底部），随键盘 1:1 连续平滑推升并在收起时严格对称回退', async () => {
    const mockRef = { current: {} } as any;
    const { result } = await renderHook(() =>
      useSmoothKeyboardTimelineLinkage(mockRef, {
        follow: true,
        overlayHeight: 138,
        gap: 20,
        headerClearance: 112,
      })
    );

    // 初始视口几何状态：视口 800，内容 1500，滚动 700（触底状态：1500 - (700+800) = 0 <= 48）
    result.current.notifyLayout(800);
    result.current.notifyContentHeight(1500);
    result.current.notifyScroll(700, 800, 1500);

    // 1. 键盘开始弹起（高度 300dp）
    capturedHandler.onStart({
      height: 300,
      progress: 0,
      duration: 250,
      target: 1,
    });
    expect(result.current.isEligibleForLift.value).toBe(true);
    expect(result.current.maxDisplacement.value).toBe(300);

    // 2. 逐帧连续平滑插值 (progress: 0 -> 0.5 -> 1.0)
    capturedHandler.onMove({
      height: 150,
      progress: 0.5,
      duration: 250,
      target: 1,
    });
    // initialScrollY (700) + 300 * 0.5 = 850
    expect(mockScrollTo).toHaveBeenLastCalledWith(mockRef, 0, 850, false);

    capturedHandler.onMove({
      height: 300,
      progress: 1.0,
      duration: 250,
      target: 1,
    });
    // initialScrollY (700) + 300 * 1.0 = 1000
    expect(mockScrollTo).toHaveBeenLastCalledWith(mockRef, 0, 1000, false);

    // 3. 键盘收起：对称连续回滚 (progress: 1.0 -> 0.5 -> 0.0)
    capturedHandler.onStart({
      height: 0,
      progress: 1.0,
      duration: 250,
      target: 1,
    });
    capturedHandler.onMove({
      height: 150,
      progress: 0.5,
      duration: 250,
      target: 1,
    });
    // 严格回滚至 850，绝对零度反向冲顶！
    expect(mockScrollTo).toHaveBeenLastCalledWith(mockRef, 0, 850, false);

    capturedHandler.onMove({
      height: 0,
      progress: 0.0,
      duration: 250,
      target: 1,
    });
    // 归零回滚至 700
    expect(mockScrollTo).toHaveBeenLastCalledWith(mockRef, 0, 700, false);

    // 4. 键盘完全关闭落定
    capturedHandler.onEnd({
      height: 0,
      progress: 0.0,
      duration: 250,
      target: 1,
    });
    expect(result.current.isEligibleForLift.value).toBe(false);
  });

  it('场景 2：短对话未触及键盘区域时自动保护保持静止，绝不被推入顶部状态栏', async () => {
    const mockRef = { current: {} } as any;
    const { result } = await renderHook(() =>
      useSmoothKeyboardTimelineLinkage(mockRef, {
        follow: true,
        overlayHeight: 138,
        gap: 20,
        headerClearance: 112,
      })
    );

    // 短对话几何：视口 800，单条消息高 150，输入框 138。
    // 可用空闲区域 FreeSpace = 800 - 150 - 138 = 512dp > 键盘高度 (300dp)
    result.current.notifyLayout(800);
    result.current.notifyContentHeight(150);
    result.current.notifyScroll(0, 800, 150);

    capturedHandler.onStart({
      height: 300,
      progress: 0,
      duration: 250,
      target: 1,
    });

    // 短对话防护生效：保持静止，位移为 0
    expect(result.current.isEligibleForLift.value).toBe(false);
    expect(result.current.maxDisplacement.value).toBe(0);

    // onMove 期间零滚动调用，消息永远优雅停留在上半区，绝不窜入状态栏！
    capturedHandler.onMove({
      height: 150,
      progress: 0.5,
      duration: 250,
      target: 1,
    });
    capturedHandler.onMove({
      height: 300,
      progress: 1.0,
      duration: 250,
      target: 1,
    });
    expect(mockScrollTo).not.toHaveBeenCalled();
  });

  it('场景 3：中等长度对话，仅推升溢出差额（e.height - FreeSpace）', async () => {
    const mockRef = { current: {} } as any;
    const { result } = await renderHook(() =>
      useSmoothKeyboardTimelineLinkage(mockRef, {
        follow: true,
        overlayHeight: 138,
        gap: 20,
        headerClearance: 112,
      })
    );

    // 视口 800，内容高 600，输入框 138。
    // FreeSpace = 800 - 600 - 138 = 62dp < 300dp
    // 所需推升差额 = 300 - 62 = 238dp
    result.current.notifyLayout(800);
    result.current.notifyContentHeight(600);
    result.current.notifyScroll(0, 800, 600);

    capturedHandler.onStart({
      height: 300,
      progress: 0,
      duration: 250,
      target: 1,
    });

    expect(result.current.isEligibleForLift.value).toBe(true);
    expect(result.current.maxDisplacement.value).toBe(238);

    capturedHandler.onMove({
      height: 300,
      progress: 1.0,
      duration: 250,
      target: 1,
    });
    // 0 + 238 * 1.0 = 238
    expect(mockScrollTo).toHaveBeenLastCalledWith(mockRef, 0, 238, false);
  });

  it('场景 4：历史翻阅态（follow=false），视口锁定静止，零滚动介入', async () => {
    const mockRef = { current: {} } as any;
    const { result } = await renderHook(() =>
      useSmoothKeyboardTimelineLinkage(mockRef, {
        follow: false, // 用户正在翻看历史记录
        overlayHeight: 138,
        gap: 20,
        headerClearance: 112,
      })
    );

    result.current.notifyLayout(800);
    result.current.notifyContentHeight(2000);
    result.current.notifyScroll(300, 800, 2000);

    capturedHandler.onStart({
      height: 300,
      progress: 0,
      duration: 250,
      target: 1,
    });
    expect(result.current.isEligibleForLift.value).toBe(false);

    capturedHandler.onMove({
      height: 300,
      progress: 1.0,
      duration: 250,
      target: 1,
    });
    expect(mockScrollTo).not.toHaveBeenCalled();
  });
});
