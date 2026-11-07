// 触觉反馈单一门面（手感基建批，交互审计 D2 / 工程审计 M-2）：
// 全仓禁止直引 expo-haptics / crish-haptics（静态守卫
// src/__tests__/feelInfra.guard.test.ts 钉死），一切触感只经本门面的语义
// 函数发声，便于全局关停与口径审计。
//
// 语义点表（指南「Haptics are punctuation」）：
// - selection() 选择 tick —— 开关切换、单选项切换（SettingsSwitch）
// - tap()       轻触确认 —— 一般轻量确认（低频预留语义）、远程发送受理
//               （R6：受理即震，ACK 不再叠加）
// - snap()      吸附 —— SlideToConfirm 过阈确认吸附、Sheet 手势下滑吸附关闭
// - success()   成功 —— 本地发送被受理（R6：发送链路单次触感的受理语义）、
//               审批允许
// - failure()   失败 —— 审批拒绝、发送失败（远程拒绝 / 本地未配置或超限）
//
// 纪律：一次用户动作至多一次触感（R6 发送链路：按压处不发触感，受理点
// 统一发声，失败以 failure 收尾）、与视觉反馈同帧、永不作唯一反馈、
// 滚动与循环中禁止触发。
//
// 设置门（2026-11-03 用户裁决）：震感由设置组 haptics 控制，**默认关**——
// 未开启时全门面静默；强度三档（轻/标准/强）同组持久化，本门面是唯一
// 消费面。静默条件另含：web 端、系统 Reduce Motion 开启、原生调用失败
// （jest 等环境）——全部静默吞掉：触感永不阻塞业务、永不抛错。
//
// 发声路径（同日 P40 实测选型）：主路径 = 本地原生桥 crish-haptics 直达
// VibrationEffect 短脉冲（华为 P40 的 HAL 不上报 amplitude 控制能力、
// 无预定义 effect 支持声明；而 expo-haptics 的 Android 映射把 selection
// 落成 50ms、impact 落成 ≈43ms，马达启停迟滞下读作长嗡）。强度映射同时
// 缩放 amplitude 与时长：amplitude 被采纳时强度分档，被忽略时时长差
// 仍可感知。原生桥缺失的壳（未含本模块的构建）才降级 expo-haptics
// 旧映射（无强度分档，属兼容路径而非口径）。
import { AccessibilityInfo, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { getCrishHapticsNative } from 'crish-haptics';
import { settingsStore } from '@/domain/store/settingsStore';
import type {
  HapticsPrefs,
  HapticsStrength,
} from '@/domain/store/settingsReducers';

let reduceMotionOn = false;
let trackingStarted = false;

/** 懒启动 Reduce Motion 监听（模块级单例，首个触感调用时挂载） */
function trackReduceMotion(): void {
  if (trackingStarted) return;
  trackingStarted = true;
  AccessibilityInfo.isReduceMotionEnabled()
    .then((value) => {
      reduceMotionOn = value;
    })
    .catch(() => undefined);
  try {
    AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      reduceMotionOn = value;
    });
  } catch {
    // 原生模块缺失（jest 等）：保持默认不静默
  }
}

/** 语义键（与下方 haptics 对象的方法一一对应） */
export type HapticSemantic =
  'selection' | 'tap' | 'snap' | 'success' | 'failure';

/** 发声规格：单次脉冲或波形（timings/amplitudes 等长，0 = 停振段） */
export type HapticSpec =
  | { kind: 'oneshot'; durationMs: number; amplitude: number }
  | { kind: 'waveform'; timings: number[]; amplitudes: number[] };

/**
 * 标准档基准规格：全语义压在短脉冲带（10–20ms）——与 expo-haptics 旧映射
 * 的 43–50ms 拉开代差，这是「短、脆」的主来源；success/failure 用双脉冲
 * 波形区分语义（间隔段 amplitude=0）。
 */
const BASE_SPECS: Record<HapticSemantic, HapticSpec> = {
  selection: { kind: 'oneshot', durationMs: 10, amplitude: 110 },
  tap: { kind: 'oneshot', durationMs: 12, amplitude: 140 },
  snap: { kind: 'oneshot', durationMs: 18, amplitude: 190 },
  success: {
    kind: 'waveform',
    timings: [0, 14, 55, 20],
    amplitudes: [0, 150, 0, 210],
  },
  failure: {
    kind: 'waveform',
    timings: [0, 20, 60, 20],
    amplitudes: [0, 205, 0, 205],
  },
};

/** 强度三档缩放（amplitude × / 时长 ×，双轨同向） */
const TIER_SCALE: Record<
  HapticsStrength,
  { amplitude: number; duration: number }
> = {
  light: { amplitude: 0.55, duration: 0.8 },
  standard: { amplitude: 1, duration: 1 },
  strong: { amplitude: 1.45, duration: 1.15 },
};

function scaleAmplitude(amplitude: number, factor: number): number {
  if (amplitude === 0) return 0; // 停振段不缩放
  return Math.min(255, Math.max(24, Math.round(amplitude * factor)));
}

function scaleDuration(durationMs: number, factor: number): number {
  if (durationMs === 0) return 0; // 波形起始 0 延迟不缩放
  return Math.max(6, Math.round(durationMs * factor));
}

/** 语义 × 强度 → 发声规格（纯函数，单测钉死映射表） */
export function resolveHapticSpec(
  semantic: HapticSemantic,
  strength: HapticsStrength
): HapticSpec {
  const base = BASE_SPECS[semantic];
  const scale = TIER_SCALE[strength];
  if (base.kind === 'oneshot') {
    return {
      kind: 'oneshot',
      durationMs: scaleDuration(base.durationMs, scale.duration),
      amplitude: scaleAmplitude(base.amplitude, scale.amplitude),
    };
  }
  return {
    kind: 'waveform',
    timings: base.timings.map((t) => scaleDuration(t, scale.duration)),
    amplitudes: base.amplitudes.map((a) => scaleAmplitude(a, scale.amplitude)),
  };
}

/** 兼容路径：原生桥缺失时的 expo-haptics 旧映射（无强度分档） */
function fireFallback(semantic: HapticSemantic): Promise<void> {
  switch (semantic) {
    case 'selection':
      return Haptics.selectionAsync();
    case 'tap':
      return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    case 'snap':
      return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    case 'success':
      return Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success
      );
    case 'failure':
      return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  }
}

function readPrefs(): HapticsPrefs | null {
  try {
    return settingsStore.getState().groups.haptics;
  } catch {
    return null; // store 异常时按关处理（默认关口径的保守侧）
  }
}

function fire(semantic: HapticSemantic): void {
  if (Platform.OS === 'web') return;
  trackReduceMotion();
  if (reduceMotionOn) return;
  const prefs = readPrefs();
  if (prefs === null || !prefs.enabled) return;
  const native = getCrishHapticsNative();
  if (native !== null) {
    try {
      const spec = resolveHapticSpec(semantic, prefs.strength);
      if (spec.kind === 'oneshot') {
        native.oneShot(spec.durationMs, spec.amplitude);
      } else {
        native.waveform(spec.timings, spec.amplitudes);
      }
    } catch {
      // 原生发声失败静默：不影响业务路径
    }
    return;
  }
  try {
    void fireFallback(semantic).catch(() => undefined);
  } catch {
    // 触感失败静默：不影响业务路径
  }
}

export const haptics = {
  /** 选择 tick：开关/单选切换 */
  selection(): void {
    fire('selection');
  },
  /** 轻触：一般轻量确认 */
  tap(): void {
    fire('tap');
  },
  /** 吸附：滑动确认过阈、Sheet 手势关闭落位 */
  snap(): void {
    fire('snap');
  },
  /** 成功：发送成功、审批允许 */
  success(): void {
    fire('success');
  },
  /** 失败：审批拒绝 */
  failure(): void {
    fire('failure');
  },
};

/** 测试收口：复位模块级静默状态（生产代码禁止调用） */
export function __resetHapticsForTest(): void {
  reduceMotionOn = false;
  trackingStarted = false;
}

export default haptics;
