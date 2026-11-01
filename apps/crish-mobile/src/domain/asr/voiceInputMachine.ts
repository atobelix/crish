// 语音输入交互状态机 + 文本合并（纯函数，与 UI / 原生解耦，单测覆盖）。
//
// 对齐 01 文档 W-D 与用户引擎规范（2026-11-01）：
// - 阶段机：idle → recording ⇄ cancelling → finishing → idle；
//   按住开始录音，上滑越过阈值进入 cancelling，滑回则恢复 recording；
//   松手按所在阶段决定提交或丢弃。
// - 文本合并：confirmedText（final 定稿累积）与 partialText（当前句临时）
//   分离；partial 只覆盖当前句，final 追加进 confirmed 并清空 partial。
import type { AsrResultEvent } from './simulatedStreamingPipeline';

/** 语音交互阶段 */
export type VoicePhase = 'idle' | 'recording' | 'cancelling' | 'finishing';

/** 上滑取消位移阈值（px）：上滑超过该距离判定为「想取消」 */
export const VOICE_CANCEL_SLIDE_THRESHOLD_PX = 80;

/**
 * 手势位移 → 阶段迁移（仅 recording / cancelling 之间流转）：
 * - recording 且上滑过阈值 → cancelling；
 * - cancelling 且滑回阈值内 → recording；
 * - 其余阶段 / 位移不跨阈值 → 保持原阶段。
 */
export function voicePhaseForTranslation(
  phase: VoicePhase,
  translationY: number,
  thresholdPx: number = VOICE_CANCEL_SLIDE_THRESHOLD_PX
): VoicePhase {
  if (phase !== 'recording' && phase !== 'cancelling') return phase;
  return translationY <= -thresholdPx ? 'cancelling' : 'recording';
}

/** 松手结局：submit = 收尾并提交；discard = 丢弃本次录音；ignore = 非录音态松手 */
export type VoiceReleaseOutcome = 'submit' | 'discard' | 'ignore';

export function voiceReleaseOutcome(phase: VoicePhase): VoiceReleaseOutcome {
  if (phase === 'recording') return 'submit';
  if (phase === 'cancelling') return 'discard';
  return 'ignore';
}

/** 识别文本双轨状态（规范：定稿与临时分离） */
export interface VoiceTextState {
  /** 已定稿累积文本（final 逐句追加） */
  confirmedText: string;
  /** 当前句临时文本（partial 覆盖，final 后清空） */
  partialText: string;
}

export const EMPTY_VOICE_TEXT: VoiceTextState = {
  confirmedText: '',
  partialText: '',
};

/** 合并一条识别结果（partial 覆盖当前句；final 追加定稿并清 partial） */
export function applyAsrResult(
  state: VoiceTextState,
  event: AsrResultEvent
): VoiceTextState {
  if (event.isFinal) {
    return {
      confirmedText: state.confirmedText + event.text,
      partialText: '',
    };
  }
  return { confirmedText: state.confirmedText, partialText: event.text };
}

/** 浮层展示文本（定稿 + 当前句临时，连续呈现） */
export function voiceDisplayText(state: VoiceTextState): string {
  return state.confirmedText + state.partialText;
}

/**
 * 松手提交文本：以定稿为准；若定稿为空但仍有未定稿的当前句
 * （极短促发声未及成段时），以当前句兜底，避免整句丢失。
 */
export function voiceFinalText(state: VoiceTextState): string {
  const combined = state.confirmedText + state.partialText;
  return combined.trim();
}

/**
 * 波形电平：Float32 采样块的 RMS 归一化到 [0,1]（带轻微增益便于小声量可视）。
 * 纯函数，供浮层 5 柱波形与单测共用。
 */
export function waveformLevelOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.min(1, rms * 3);
}
