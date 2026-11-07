// 语音输入交互状态机 + 文本合并（纯函数，与 UI / 原生解耦，单测覆盖）。
//
// 对齐 01 文档 W-D 与用户引擎规范（2026-11-01）：
// - 阶段机：idle → recording ⇄ cancelling → finishing → idle；
//   按住开始录音，上滑越过阈值进入 cancelling，滑回则恢复 recording；
//   松手按所在阶段决定提交或丢弃。
// - 文本合并：confirmedText（final 定稿累积）与 partialText（当前句临时）
//   分离；partial 只覆盖当前句，final 追加进 confirmed 并清空 partial。
import type { AsrResultEvent } from './simulatedStreamingPipeline';

/** 语音交互阶段：支持中央发送、左滑撤销与右滑编辑 */
export type VoicePhase =
  'idle' | 'recording' | 'cancelling' | 'editing' | 'finishing';

/** 上滑取消位移阈值（px）：上滑超过该距离判定为「想取消」（兼容纯 1D 模式） */
export const VOICE_CANCEL_SLIDE_THRESHOLD_PX = 80;

/** 左右胶囊热区咬合与走廊迟滞防抖阈值（px） */
export const VOICE_ZONE_ENTER_THRESHOLD_X = 42;
export const VOICE_ZONE_EXIT_THRESHOLD_X = 26;

/** 下方发送区与上方三分扇区垂直分界线（px，进入线）：手指上滑越过该线进入上方区；向下滑动或在输入框附近均为发送 */
export const VOICE_VERTICAL_ACTIVE_THRESHOLD_Y = -30;

/** Y 向迟滞退出线（px）：已在上方区（cancelling/editing）时，手指向下回到该线以内才退回下方发送区——与进入线（-30）构成迟滞带，与 X 向 42/26 同构 */
export const VOICE_VERTICAL_EXIT_THRESHOLD_Y = -16;

/**
 * 手势位移 → 阶段迁移（1D 兼容模式）：
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

/**
 * 双轴手势位移 → 阶段迁移（用户裁决：下方全发送 + 上方三列空间拓扑）：
 * - 下方区域（translationY > -30px）：手指靠近输入框，全域均为发送（'recording'）；
 * - 上方区域（translationY <= -30px）：三分列拓扑，撤销与编辑两边各占一半，中间为发送走廊：
 *   1. 左列（左滑 <= -enterThresholdX）：进入撤销（'cancelling'）；退回中间走廊须跨过 -exitThresholdX；
 *   2. 中列（-exitThresholdX < translationX < exitThresholdX）：保持发送（'recording'）；无论滑动多高均不误触发撤销；
 *   3. 右列（右滑 >= enterThresholdX）：进入编辑（'editing'）；退回中间走廊须跨过 exitThresholdX；
 * - Y 向迟滞（与 X 向同构）：自下方进入上方区须越过进入线（-30）；已在
 *   上方区（cancelling/editing）退回下方只须回到退出线（-16）以内。两线
 *   之间的迟滞带内维持上方区拓扑判定——-30 线附近停留不再逐采样翻转
 *   阶段（整幅换色 + prevPhase 震感连环触发的根源，2026-11-05 返工补齐）。
 * - 铁律：右半区及中间走廊上方绝对禁止识别为撤销！杜绝向右上滑动时误取消。
 */
export function voicePhaseForTranslation2D(
  phase: VoicePhase,
  translationX: number,
  translationY: number,
  enterThresholdX: number = VOICE_ZONE_ENTER_THRESHOLD_X,
  exitThresholdX: number = VOICE_ZONE_EXIT_THRESHOLD_X,
  verticalThresholdY: number = VOICE_VERTICAL_ACTIVE_THRESHOLD_Y,
  verticalExitThresholdY: number = VOICE_VERTICAL_EXIT_THRESHOLD_Y
): VoicePhase {
  if (phase !== 'recording' && phase !== 'cancelling' && phase !== 'editing') {
    return phase;
  }

  // 1. 下方区域（接近输入框本体）：无论是左是右，一律为发送态。
  //    判定线带迟滞：recording 看进入线，已在上方区看退出线（见头注）
  const lowerZoneLine =
    phase === 'recording' ? verticalThresholdY : verticalExitThresholdY;
  if (translationY > lowerZoneLine) {
    return 'recording';
  }

  // 2. 上方区域（滑动至胶囊高度）：严格按三列划分，绝不跨列误触发
  if (phase === 'recording') {
    if (translationX <= -enterThresholdX) {
      return 'cancelling'; // 左列：撤销
    }
    if (translationX >= enterThresholdX) {
      return 'editing'; // 右列：编辑
    }
    return 'recording'; // 中列：发送走廊
  }

  if (phase === 'cancelling') {
    // 从左列退回中列
    if (translationX > -exitThresholdX) {
      // 若一口气滑入右列，无缝迁移至编辑
      if (translationX >= enterThresholdX) {
        return 'editing';
      }
      return 'recording';
    }
    return 'cancelling';
  }

  if (phase === 'editing') {
    // 从右列退回中列
    if (translationX < exitThresholdX) {
      // 若一口气滑入左列，无缝迁移至撤销
      if (translationX <= -enterThresholdX) {
        return 'cancelling';
      }
      return 'recording';
    }
    return 'editing';
  }

  return phase;
}

/** 松手结局：submit = 收尾并提交；discard = 丢弃本次录音；edit = 回填输入框供二次打字；ignore = 非录音态松手 */
export type VoiceReleaseOutcome = 'submit' | 'discard' | 'edit' | 'ignore';

export function voiceReleaseOutcome(phase: VoicePhase): VoiceReleaseOutcome {
  if (phase === 'recording') return 'submit';
  if (phase === 'cancelling') return 'discard';
  if (phase === 'editing') return 'edit';
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
