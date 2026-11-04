// 语音交互状态机 + 文本合并纯函数单测。
import type { AsrResultEvent } from './simulatedStreamingPipeline';
import {
  applyAsrResult,
  EMPTY_VOICE_TEXT,
  voiceDisplayText,
  voiceFinalText,
  voicePhaseForTranslation,
  voicePhaseForTranslation2D,
  voiceReleaseOutcome,
  waveformLevelOf,
} from './voiceInputMachine';

describe('voicePhaseForTranslation', () => {
  it('moves recording -> cancelling past the slide threshold and back', () => {
    expect(voicePhaseForTranslation('recording', -81)).toBe('cancelling');
    expect(voicePhaseForTranslation('recording', -80)).toBe('cancelling');
    expect(voicePhaseForTranslation('recording', -79)).toBe('recording');
    expect(voicePhaseForTranslation('cancelling', -20)).toBe('recording');
    expect(voicePhaseForTranslation('cancelling', -120)).toBe('cancelling');
  });

  it('leaves non-recording phases untouched', () => {
    expect(voicePhaseForTranslation('idle', -200)).toBe('idle');
    expect(voicePhaseForTranslation('finishing', -200)).toBe('finishing');
  });
});

describe('voicePhaseForTranslation2D', () => {
  it('handles left-slide to cancel with hysteresis buffer', () => {
    // 划过 58px 进入 cancelling
    expect(voicePhaseForTranslation2D('recording', -59, 0)).toBe('cancelling');
    expect(voicePhaseForTranslation2D('recording', -58, 0)).toBe('cancelling');
    // 在 58px 以内保持 recording
    expect(voicePhaseForTranslation2D('recording', -50, 0)).toBe('recording');

    // 在 cancelling 下，必须滑回 -42px 以内才退回 recording
    expect(voicePhaseForTranslation2D('cancelling', -50, 0)).toBe('cancelling');
    expect(voicePhaseForTranslation2D('cancelling', -40, 0)).toBe('recording');
  });

  it('handles right-slide to edit with hysteresis buffer', () => {
    // 划过 58px 进入 editing
    expect(voicePhaseForTranslation2D('recording', 59, 0)).toBe('editing');
    expect(voicePhaseForTranslation2D('recording', 58, 0)).toBe('editing');
    expect(voicePhaseForTranslation2D('recording', 50, 0)).toBe('recording');

    // 在 editing 下，必须滑回 42px 以内才退回 recording
    expect(voicePhaseForTranslation2D('editing', 50, 0)).toBe('editing');
    expect(voicePhaseForTranslation2D('editing', 40, 0)).toBe('recording');
  });

  it('preserves vertical upward cancel threshold as fallback', () => {
    expect(voicePhaseForTranslation2D('recording', 0, -85)).toBe('cancelling');
  });
});

describe('voiceReleaseOutcome', () => {
  it('maps phases to submit / discard / edit / ignore', () => {
    expect(voiceReleaseOutcome('recording')).toBe('submit');
    expect(voiceReleaseOutcome('cancelling')).toBe('discard');
    expect(voiceReleaseOutcome('editing')).toBe('edit');
    expect(voiceReleaseOutcome('idle')).toBe('ignore');
    expect(voiceReleaseOutcome('finishing')).toBe('ignore');
  });
});

describe('text merge (confirmed vs partial)', () => {
  const partial = (text: string): AsrResultEvent => ({ text, isFinal: false });
  const final = (text: string): AsrResultEvent => ({ text, isFinal: true });

  it('partial overwrites only the current utterance', () => {
    let s = applyAsrResult(EMPTY_VOICE_TEXT, partial('开饭'));
    s = applyAsrResult(s, partial('开饭时间'));
    expect(s).toEqual({ confirmedText: '', partialText: '开饭时间' });
    expect(voiceDisplayText(s)).toBe('开饭时间');
  });

  it('final appends into confirmed and clears partial; sentences accumulate', () => {
    let s = applyAsrResult(EMPTY_VOICE_TEXT, partial('开饭时间'));
    s = applyAsrResult(s, final('开饭时间。'));
    expect(s).toEqual({ confirmedText: '开饭时间。', partialText: '' });
    s = applyAsrResult(s, partial('下午五点'));
    expect(voiceDisplayText(s)).toBe('开饭时间。下午五点');
    s = applyAsrResult(s, final('下午五点。'));
    expect(voiceFinalText(s)).toBe('开饭时间。下午五点。');
  });

  it('final text falls back to the partial when nothing is confirmed yet', () => {
    const s = applyAsrResult(EMPTY_VOICE_TEXT, partial('还没定稿'));
    expect(voiceFinalText(s)).toBe('还没定稿');
    expect(voiceFinalText(EMPTY_VOICE_TEXT)).toBe('');
  });
});

describe('waveformLevelOf', () => {
  it('maps silence to 0 and loud speech near 1', () => {
    expect(waveformLevelOf(new Float32Array(512))).toBe(0);
    expect(waveformLevelOf(new Float32Array(0))).toBe(0);
    const loud = waveformLevelOf(new Float32Array(512).fill(0.5));
    expect(loud).toBeGreaterThan(0.9);
    const quiet = waveformLevelOf(new Float32Array(512).fill(0.05));
    expect(quiet).toBeGreaterThan(0);
    expect(quiet).toBeLessThan(0.5);
  });
});
