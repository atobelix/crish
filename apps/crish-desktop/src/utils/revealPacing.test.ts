/**
 * revealPacing 速度域（R11 / AN4 共建）纯函数测试。
 *
 * 钉住的跨案契约：速度域常数（稳态 / 追赶 / 单帧硬顶 / 啮合门槛）、
 * 目标滞后钳制、速率的封顶与防饥饿下限、切点偏好序。
 */
import { describe, expect, it } from 'vitest';
import {
  pickRevealCutEnd,
  revealPacingProfile,
  revealRateCharsPerSec,
  targetLagChars,
  TEXT_REVEAL_PACING,
  THINKING_REVEAL_PACING,
} from './revealPacing';

describe('速度域常数（R11 / AN4 共建契约，改值须两案共同裁决）', () => {
  it('正文档：稳态 2600 / 追赶 5200 / 单帧硬顶 420 / 啮合门槛 240', () => {
    expect(TEXT_REVEAL_PACING.steadyCapCharsPerSec).toBe(2_600);
    expect(TEXT_REVEAL_PACING.catchUpCapCharsPerSec).toBe(5_200);
    expect(TEXT_REVEAL_PACING.frameHardCapChars).toBe(420);
    expect(TEXT_REVEAL_PACING.engageThresholdChars).toBe(240);
    expect(TEXT_REVEAL_PACING.targetLagSeconds).toBe(0.35);
    expect(TEXT_REVEAL_PACING.targetLagMinChars).toBe(80);
    expect(TEXT_REVEAL_PACING.targetLagMaxChars).toBe(700);
    expect(TEXT_REVEAL_PACING.finishSnapChars).toBe(300);
  });

  it('思考档：同策略异参数——目标滞后 0.5s、封顶 3600 / 6800，其余与正文共享', () => {
    expect(THINKING_REVEAL_PACING.targetLagSeconds).toBe(0.5);
    expect(THINKING_REVEAL_PACING.steadyCapCharsPerSec).toBe(3_600);
    expect(THINKING_REVEAL_PACING.catchUpCapCharsPerSec).toBe(6_800);
    expect(THINKING_REVEAL_PACING.engageThresholdChars).toBe(
      TEXT_REVEAL_PACING.engageThresholdChars
    );
    expect(THINKING_REVEAL_PACING.frameHardCapChars).toBe(
      TEXT_REVEAL_PACING.frameHardCapChars
    );
    expect(revealPacingProfile('thinking')).toBe(THINKING_REVEAL_PACING);
    expect(revealPacingProfile('text')).toBe(TEXT_REVEAL_PACING);
  });
});

describe('targetLagChars', () => {
  it('= clamp(EWMA × 时间常数, 80, 700)', () => {
    expect(targetLagChars(TEXT_REVEAL_PACING, 0)).toBe(80);
    expect(targetLagChars(TEXT_REVEAL_PACING, 100)).toBe(80);
    expect(targetLagChars(TEXT_REVEAL_PACING, 1_000)).toBe(350);
    expect(targetLagChars(TEXT_REVEAL_PACING, 2_000)).toBe(700);
    expect(targetLagChars(TEXT_REVEAL_PACING, 99_999)).toBe(700);
    expect(targetLagChars(THINKING_REVEAL_PACING, 1_000)).toBe(500);
  });
});

describe('revealRateCharsPerSec', () => {
  it('无滞后恒为 0', () => {
    expect(revealRateCharsPerSec(TEXT_REVEAL_PACING, 1_000, 0)).toBe(0);
    expect(revealRateCharsPerSec(TEXT_REVEAL_PACING, 1_000, -5)).toBe(0);
  });

  it('滞后等于目标时速率 = EWMA（匀速跟随）', () => {
    const target = targetLagChars(TEXT_REVEAL_PACING, 600);
    expect(revealRateCharsPerSec(TEXT_REVEAL_PACING, 600, target)).toBe(600);
  });

  it('滞后高于目标时比例加速，但不越稳态封顶', () => {
    const rate = revealRateCharsPerSec(TEXT_REVEAL_PACING, 600, 2_500);
    expect(rate).toBeGreaterThan(600);
    expect(rate).toBeLessThanOrEqual(2_600);
  });

  it('滞后越过追赶门槛（2600）后启用追赶封顶 5200', () => {
    // 修正速率（≈7278）高于两档各自的追赶封顶 → 封顶值即结果
    expect(revealRateCharsPerSec(TEXT_REVEAL_PACING, 2_500, 5_000)).toBe(5_200);
    // 同输入下思考档走自己的追赶封顶
    expect(revealRateCharsPerSec(THINKING_REVEAL_PACING, 2_500, 5_000)).toBe(
      6_800
    );
    // 未饱和时返回修正速率本身（思考档 600/5000：600 + (5000−300)/0.9）
    expect(
      revealRateCharsPerSec(THINKING_REVEAL_PACING, 600, 5_000)
    ).toBeCloseTo(5_822.22, 1);
  });

  it('防饥饿下限：EWMA 与比例修正都趋零时，有滞后也保底 30 字/s', () => {
    expect(revealRateCharsPerSec(TEXT_REVEAL_PACING, 0, 10)).toBe(30);
    expect(revealRateCharsPerSec(TEXT_REVEAL_PACING, 50, 10)).toBe(30);
  });
});

describe('pickRevealCutEnd', () => {
  const identitySafe = (_text: string, end: number) => end;

  it('预算够到文末时直接落文末', () => {
    const text = 'abc def';
    expect(pickRevealCutEnd(text, 0, 100, identitySafe)).toBe(7);
  });

  it('偏好后段内的行尾：切点落在 \\n 之后', () => {
    const text = 'aaaa bbbb\ncccc dddd eeee';
    // 预算 14 → hardEnd=14（'cccc' 中段），后段窗口 [8,14] 内有 \n@9
    expect(pickRevealCutEnd(text, 0, 14, identitySafe)).toBe(10);
  });

  it('无行尾时退到空白之后', () => {
    const text = 'aaaa bbbb cccc dddd';
    expect(pickRevealCutEnd(text, 0, 12, identitySafe)).toBe(10);
  });

  it('无自然边界时走 grapheme 安全切点（注入函数决定）', () => {
    const text = 'abcdefghij';
    const safe = (_t: string, end: number) => end - 1;
    expect(pickRevealCutEnd(text, 0, 6, safe)).toBe(5);
  });

  it('只在后 40% 窗口内找边界：窗口外的行尾不牺牲速率', () => {
    // \n 在下标 2（切后为 3），预算 20 → 窗口起点 12，\n 在窗口外
    const text = 'aa\n' + 'b'.repeat(30);
    expect(pickRevealCutEnd(text, 0, 20, identitySafe)).toBe(20);
  });

  it('maxAdvance ≤ 0 时原地不动（不保证推进，推进由调用方兜底）', () => {
    expect(pickRevealCutEnd('abc', 1, 0, identitySafe)).toBe(1);
  });
});
