// 触觉门面单测：设置门（默认关）/ 原生桥短脉冲映射 / 强度三档缩放 /
// 原生缺失降级 expo-haptics / Reduce Motion 静默 / 原生失败吞掉。
import { AccessibilityInfo } from 'react-native';
import * as Haptics from 'expo-haptics';

jest.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: {
    Success: 'success',
    Warning: 'warning',
    Error: 'error',
  },
  selectionAsync: jest.fn(async () => undefined),
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
}));

jest.mock('crish-haptics', () => ({
  getCrishHapticsNative: jest.fn(),
}));

import { getCrishHapticsNative } from 'crish-haptics';
import { __resetHapticsForTest, haptics, resolveHapticSpec } from './haptics';
import { settingsStore } from '@/domain/store/settingsStore';
import {
  defaultSettingsGroups,
  type HapticsStrength,
} from '@/domain/store/settingsReducers';

const getNativeMock = getCrishHapticsNative as jest.Mock;

const nativeFake = {
  capabilities: jest.fn(() => ({
    sdkInt: 31,
    hasVibrator: true,
    hasAmplitudeControl: false,
  })),
  oneShot: jest.fn(() => true),
  waveform: jest.fn(() => true),
  cancel: jest.fn(),
};

const flushMicrotasks = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

function setHapticsPrefs(enabled: boolean, strength: HapticsStrength): void {
  settingsStore.setState({
    groups: {
      ...defaultSettingsGroups(),
      haptics: { enabled, strength },
    },
    hydrated: true,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetHapticsForTest();
  // 缺省：原生桥在场（主路径）；设置回默认（关）
  getNativeMock.mockReturnValue(nativeFake);
  setHapticsPrefs(false, 'standard');
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(false);
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() } as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('haptics 门面 · 设置门（2026-11-03 裁决：默认关）', () => {
  it('默认关：五语义全静默（原生与 expo 均不发声）', () => {
    haptics.selection();
    haptics.tap();
    haptics.snap();
    haptics.success();
    haptics.failure();
    expect(nativeFake.oneShot).not.toHaveBeenCalled();
    expect(nativeFake.waveform).not.toHaveBeenCalled();
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it('开启后运行时改回关 → 立即静默（门面实时咨询 store）', () => {
    setHapticsPrefs(true, 'standard');
    haptics.selection();
    expect(nativeFake.oneShot).toHaveBeenCalledTimes(1);
    setHapticsPrefs(false, 'standard');
    haptics.selection();
    expect(nativeFake.oneShot).toHaveBeenCalledTimes(1);
  });
});

describe('haptics 门面 · 原生桥映射（标准档）', () => {
  beforeEach(() => {
    setHapticsPrefs(true, 'standard');
  });

  it('selection/tap/snap → oneShot 短脉冲', () => {
    haptics.selection();
    expect(nativeFake.oneShot).toHaveBeenCalledWith(10, 110);
    haptics.tap();
    expect(nativeFake.oneShot).toHaveBeenCalledWith(12, 140);
    haptics.snap();
    expect(nativeFake.oneShot).toHaveBeenCalledWith(18, 190);
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });

  it('success/failure → waveform 双脉冲', () => {
    haptics.success();
    expect(nativeFake.waveform).toHaveBeenCalledWith(
      [0, 14, 55, 20],
      [0, 150, 0, 210]
    );
    haptics.failure();
    expect(nativeFake.waveform).toHaveBeenCalledWith(
      [0, 20, 60, 20],
      [0, 205, 0, 205]
    );
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });
});

describe('resolveHapticSpec · 强度三档缩放表', () => {
  it('标准档 = 基准规格原值', () => {
    expect(resolveHapticSpec('selection', 'standard')).toEqual({
      kind: 'oneshot',
      durationMs: 10,
      amplitude: 110,
    });
    expect(resolveHapticSpec('success', 'standard')).toEqual({
      kind: 'waveform',
      timings: [0, 14, 55, 20],
      amplitudes: [0, 150, 0, 210],
    });
  });

  it('轻档：amplitude ×0.55 / 时长 ×0.8（停振段与 0 延迟不缩放）', () => {
    expect(resolveHapticSpec('selection', 'light')).toEqual({
      kind: 'oneshot',
      durationMs: 8,
      amplitude: 61,
    });
    expect(resolveHapticSpec('snap', 'light')).toEqual({
      kind: 'oneshot',
      durationMs: 14,
      amplitude: 105,
    });
    expect(resolveHapticSpec('success', 'light')).toEqual({
      kind: 'waveform',
      timings: [0, 11, 44, 16],
      amplitudes: [0, 83, 0, 116],
    });
  });

  it('强档：amplitude ×1.45（255 封顶）/ 时长 ×1.15', () => {
    expect(resolveHapticSpec('selection', 'strong')).toEqual({
      kind: 'oneshot',
      durationMs: 12,
      amplitude: 160,
    });
    expect(resolveHapticSpec('snap', 'strong')).toEqual({
      kind: 'oneshot',
      durationMs: 21,
      amplitude: 255,
    });
    expect(resolveHapticSpec('failure', 'strong')).toEqual({
      kind: 'waveform',
      timings: [0, 23, 69, 23],
      amplitudes: [0, 255, 0, 255],
    });
  });

  it('门面按当前强度发声（轻档 selection → oneShot(8, 61)）', () => {
    setHapticsPrefs(true, 'light');
    haptics.selection();
    expect(nativeFake.oneShot).toHaveBeenCalledWith(8, 61);
  });
});

describe('haptics 门面 · 原生缺失降级 expo-haptics', () => {
  beforeEach(() => {
    getNativeMock.mockReturnValue(null);
    setHapticsPrefs(true, 'standard');
  });

  it('selection → selectionAsync', () => {
    haptics.selection();
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it('tap → impact Light；snap → impact Medium', () => {
    haptics.tap();
    expect(Haptics.impactAsync).toHaveBeenCalledWith('light');
    haptics.snap();
    expect(Haptics.impactAsync).toHaveBeenCalledWith('medium');
  });

  it('success → notification Success；failure → notification Error', () => {
    haptics.success();
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
    haptics.failure();
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('error');
  });
});

describe('haptics 门面 · 静默纪律', () => {
  it('Reduce Motion 开启后全部静默（设置开启亦然）', async () => {
    setHapticsPrefs(true, 'standard');
    jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(true);
    // 首个调用启动监听并缓存 RM 状态（该次仍发声，属已知的一次性窗口）
    haptics.selection();
    await flushMicrotasks();
    jest.clearAllMocks();
    getNativeMock.mockReturnValue(nativeFake);
    haptics.selection();
    haptics.snap();
    haptics.success();
    haptics.failure();
    expect(nativeFake.oneShot).not.toHaveBeenCalled();
    expect(nativeFake.waveform).not.toHaveBeenCalled();
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it('原生发声抛错被静默吞掉，且不回退 expo（一动作至多一次）', () => {
    setHapticsPrefs(true, 'standard');
    nativeFake.oneShot.mockImplementation(() => {
      throw new Error('vibrator dead');
    });
    expect(() => haptics.selection()).not.toThrow();
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
    nativeFake.oneShot.mockReset();
    nativeFake.oneShot.mockReturnValue(true);
  });

  it('expo 兼容路径调用失败被静默吞掉，不抛错', async () => {
    getNativeMock.mockReturnValue(null);
    setHapticsPrefs(true, 'standard');
    (Haptics.selectionAsync as jest.Mock).mockRejectedValue(
      new Error('no haptics')
    );
    expect(() => haptics.selection()).not.toThrow();
    await flushMicrotasks();
  });
});
