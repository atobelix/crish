// crish-haptics 本地模块的 TS 门面：惰性加载原生模块，非 Android / 原生缺失
// （jest、Web、未含本模块的壳）时返回 null，由触觉门面诚实降级到
// expo-haptics 兼容路径，绝不在导入期触碰原生导致崩溃。
import { requireNativeModule } from 'expo-modules-core';

/** 原生震感能力（真机实测口径见 CrishHapticsModule.kt 头注） */
export interface CrishHapticsCapabilities {
  /** Android API 级别 */
  sdkInt: number;
  /** 设备是否有震动器 */
  hasVibrator: boolean;
  /** HAL 是否上报 amplitude 控制能力（CAP_AMPLITUDE_CONTROL） */
  hasAmplitudeControl: boolean;
}

export interface CrishHapticsNativeModule {
  /** 能力查询（诊断与口径留痕用；门面发声路径不依赖其结果分叉） */
  capabilities(): CrishHapticsCapabilities;
  /**
   * 单次脉冲：时长 ms + amplitude 1–255（≤0 = 系统默认强度）。
   * 返回 true 表示已发声（无震动器 / 参数非法时 false）。
   */
  oneShot(durationMs: number, amplitude: number): boolean;
  /**
   * 波形：timings 与 amplitudes 必须等长（amplitude 0 = 停振段），不循环。
   * 返回 true 表示已发声。
   */
  waveform(timings: number[], amplitudes: number[]): boolean;
  /** 取消正在进行的震动 */
  cancel(): void;
}

let cached: CrishHapticsNativeModule | null | undefined;

export function getCrishHapticsNative(): CrishHapticsNativeModule | null {
  if (cached !== undefined) return cached;
  try {
    cached = requireNativeModule<CrishHapticsNativeModule>('CrishHaptics');
  } catch {
    cached = null;
  }
  return cached;
}

export function isCrishHapticsAvailable(): boolean {
  return getCrishHapticsNative() !== null;
}

export default getCrishHapticsNative;
