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
  it('handles bottom region as pure recording regardless of X translation', () => {
    // 靠近输入框下方区域（Y > -30）：无论向左滑、向右滑还是在原地，全都是发送
    expect(voicePhaseForTranslation2D('recording', -60, 0)).toBe('recording');
    expect(voicePhaseForTranslation2D('recording', 60, 0)).toBe('recording');
    expect(voicePhaseForTranslation2D('recording', 0, 0)).toBe('recording');
    expect(voicePhaseForTranslation2D('recording', -80, -10)).toBe('recording');

    // 处于 cancelling 或 editing 时，只要手指滑回下方区域，立即恢复 recording 发送态
    expect(voicePhaseForTranslation2D('cancelling', -60, 0)).toBe('recording');
    expect(voicePhaseForTranslation2D('editing', 60, 0)).toBe('recording');
  });

  it('handles upper region three-column topology (left cancelling, center recording, right editing)', () => {
    const activeY = -60; // 向上滑动超过 -30px 阈值，进入胶囊识别高度

    // 1. 左列（X <= -42）：进入 cancelling 撤销态
    expect(voicePhaseForTranslation2D('recording', -43, activeY)).toBe(
      'cancelling'
    );
    expect(voicePhaseForTranslation2D('recording', -42, activeY)).toBe(
      'cancelling'
    );
    // 在中间走廊维持 recording
    expect(voicePhaseForTranslation2D('recording', -30, activeY)).toBe(
      'recording'
    );

    // 迟滞走廊：在 cancelling 态下，需跨过 -26px 阈值（如 -20px）才退回 recording
    expect(voicePhaseForTranslation2D('cancelling', -30, activeY)).toBe(
      'cancelling'
    );
    expect(voicePhaseForTranslation2D('cancelling', -20, activeY)).toBe(
      'recording'
    );

    // 2. 右列（X >= 42）：进入 editing 编辑态
    expect(voicePhaseForTranslation2D('recording', 43, activeY)).toBe(
      'editing'
    );
    expect(voicePhaseForTranslation2D('recording', 42, activeY)).toBe(
      'editing'
    );
    // 在中间走廊维持 recording
    expect(voicePhaseForTranslation2D('recording', 30, activeY)).toBe(
      'recording'
    );

    // 迟滞走廊：在 editing 态下，需跨过 26px 阈值（如 20px）才退回 recording
    expect(voicePhaseForTranslation2D('editing', 30, activeY)).toBe('editing');
    expect(voicePhaseForTranslation2D('editing', 20, activeY)).toBe(
      'recording'
    );

    // 3. 中列（-26 < X < 26）：无论向上滑动多高，永远保持 recording 发送态
    expect(voicePhaseForTranslation2D('recording', 0, -60)).toBe('recording');
    expect(voicePhaseForTranslation2D('recording', 0, -120)).toBe('recording');
    expect(voicePhaseForTranslation2D('recording', 0, -240)).toBe('recording');
  });

  it('Y-axis hysteresis: upper zone entered at -30, exited at -16 (isomorphic to X 42/26)', () => {
    // recording 在进入线之上（-30 < Y <= 0 的下方区）维持发送，不入上方区
    expect(voicePhaseForTranslation2D('recording', -60, -20)).toBe('recording');
    expect(voicePhaseForTranslation2D('recording', -60, -29)).toBe('recording');
    // 越过进入线（Y <= -30）+ 左列 → cancelling
    expect(voicePhaseForTranslation2D('recording', -60, -30)).toBe(
      'cancelling'
    );
    expect(voicePhaseForTranslation2D('recording', -60, -31)).toBe(
      'cancelling'
    );

    // 迟滞带（-30 < Y <= -16）：已在上方区的阶段不因越过 -30 就翻转，
    // 仍按 X 拓扑判定（左列维持 cancelling、右列维持 editing）
    expect(voicePhaseForTranslation2D('cancelling', -60, -20)).toBe(
      'cancelling'
    );
    expect(voicePhaseForTranslation2D('cancelling', -60, -17)).toBe(
      'cancelling'
    );
    expect(voicePhaseForTranslation2D('editing', 60, -20)).toBe('editing');
    // 迟滞带内 X 若已退回走廊，仍可按 X 迟滞退回 recording
    expect(voicePhaseForTranslation2D('cancelling', 0, -20)).toBe('recording');

    // 回到退出线以内（Y > -16）：无论 X 在哪列，一律退回下方发送态
    expect(voicePhaseForTranslation2D('cancelling', -60, -16)).toBe(
      'cancelling'
    );
    expect(voicePhaseForTranslation2D('cancelling', -60, -15)).toBe(
      'recording'
    );
    expect(voicePhaseForTranslation2D('editing', 60, -15)).toBe('recording');

    // 边界往返不翻转：在 -30 线附近上下抖动（-31 ↔ -29），阶段保持
    expect(voicePhaseForTranslation2D('cancelling', -60, -31)).toBe(
      'cancelling'
    );
    expect(voicePhaseForTranslation2D('cancelling', -60, -29)).toBe(
      'cancelling'
    );
    expect(voicePhaseForTranslation2D('cancelling', -60, -31)).toBe(
      'cancelling'
    );
  });

  it('strictly protects editing region from false cancelling triggers at high vertical displacements', () => {
    // 铁律：用户手在右侧编辑区时，即便向上大幅度滑动（例如 Y = -180px），坚决保持 editing，绝不允许变成 cancelling
    expect(voicePhaseForTranslation2D('recording', 60, -80)).toBe('editing');
    expect(voicePhaseForTranslation2D('recording', 60, -150)).toBe('editing');
    expect(voicePhaseForTranslation2D('editing', 60, -200)).toBe('editing');
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
