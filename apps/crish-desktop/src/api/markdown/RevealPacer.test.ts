/**
 * RevealPacer 回放夹具与验收指标（R11）。
 *
 * 确定性回放：假帧时钟（60fps）+ 脚本化到达形态，逐帧采样
 * (t, arrived, revealed)，按《流式显现平滑分析》§四口径断言：
 * - 显现速率变异系数 CV ≤0.35（散文）/ ≤0.5（突发，泄空相位内计）；
 * - 单帧增量 p95 ≤150 字、硬顶 ≤420 字（字形簇不可分的整簇落帧除外）；
 * - 饥饿（有待显现文本却零增量）≤300ms；
 * - 短回复（≤ 啮合门槛）零附加延迟；收尾 snap / 泄空按口径完成；
 * - 切点 grapheme 安全：任一帧的已显现前缀都落在字形簇边界上。
 * CV 以 250ms 窗口的显现量计（人眼对节律的积分尺度），逐帧增量
 * 另以 p95 / 硬顶约束——窗口定义与豁免范围在各用例内注明。
 */
import { describe, expect, it } from 'vitest';
import { RevealPacer } from './RevealPacer';
import {
  TEXT_REVEAL_PACING,
  THINKING_REVEAL_PACING,
  type RevealPacingProfile,
} from '../../utils/revealPacing';

const FRAME_MS = 1000 / 60;
const WINDOW_FRAMES = 15; // 250ms @60fps

interface ArrivalEvent {
  atMs: number;
  chunk: string;
}

interface FrameSample {
  t: number;
  arrived: number;
  revealed: number;
}

const PROSE_UNIT = '流式显现的节奏需要保持平滑均匀，\n不能忽快忽慢地跳动。';
const CODE_UNIT = 'const value = computeSomething(argument, { flag: true });\n';

function makeText(totalChars: number, unit: string = PROSE_UNIT): string {
  let out = '';
  while (out.length < totalChars) out += unit;
  return out.slice(0, totalChars);
}

/** 等速滴流到达脚本：每 intervalMs 到达 chunkChars 字 */
function dripEvents(
  chunkChars: number,
  intervalMs: number,
  totalChars: number,
  unit: string = PROSE_UNIT,
  startAtMs = 0
): ArrivalEvent[] {
  const full = makeText(totalChars, unit);
  const events: ArrivalEvent[] = [];
  let sent = 0;
  let t = startAtMs;
  while (sent < totalChars) {
    const n = Math.min(chunkChars, totalChars - sent);
    events.push({ atMs: t, chunk: full.slice(sent, sent + n) });
    sent += n;
    t += intervalMs;
  }
  return events;
}

function runReplay(opts: {
  events: ArrivalEvent[];
  profile?: RevealPacingProfile;
  durationMs: number;
  finishAtMs?: number;
}): { pacer: RevealPacer; samples: FrameSample[]; fullText: string } {
  const pacer = new RevealPacer(opts.profile ?? TEXT_REVEAL_PACING);
  const samples: FrameSample[] = [];
  let arrived = '';
  let evIdx = 0;
  let finished = false;
  const frameCount = Math.floor(opts.durationMs / FRAME_MS);
  for (let k = 0; k <= frameCount; k++) {
    const t = k * FRAME_MS;
    while (evIdx < opts.events.length && opts.events[evIdx]!.atMs <= t) {
      arrived += opts.events[evIdx]!.chunk;
      evIdx++;
    }
    const streaming = opts.finishAtMs === undefined || t < opts.finishAtMs;
    pacer.noteArrived(arrived, t, streaming);
    if (opts.finishAtMs !== undefined && !finished && t >= opts.finishAtMs) {
      pacer.finish(t);
      finished = true;
    }
    pacer.tick(t);
    samples.push({
      t,
      arrived: arrived.length,
      revealed: pacer.revealedLength,
    });
  }
  return { pacer, samples, fullText: arrived };
}

function incrementsOf(samples: FrameSample[]): number[] {
  return samples.map((s, i) =>
    i === 0 ? 0 : s.revealed - samples[i - 1]!.revealed
  );
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1)
  );
  return sorted[idx]!;
}

/** 250ms 窗口显现量（每 15 帧一窗） */
function windowedReveal(increments: number[]): number[] {
  const windows: number[] = [];
  for (let i = 0; i + WINDOW_FRAMES <= increments.length; i += WINDOW_FRAMES) {
    let sum = 0;
    for (let j = i; j < i + WINDOW_FRAMES; j++) sum += increments[j]!;
    windows.push(sum);
  }
  return windows;
}

function cv(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance =
    values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/** 饥饿：流活跃期内「有待显现文本却零增量」的连续帧跨度（ms） */
function maxStarvationMs(
  samples: FrameSample[],
  activeUntilMs: number
): number {
  const increments = incrementsOf(samples);
  let run = 0;
  let worst = 0;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!;
    const lagDuringFrame = s.arrived - samples[i - 1]!.revealed;
    if (s.t < activeUntilMs && lagDuringFrame > 0 && increments[i] === 0) {
      run++;
      worst = Math.max(worst, run);
    } else {
      run = 0;
    }
  }
  return worst * FRAME_MS;
}

function expectMonotonePrefix(samples: FrameSample[]): void {
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    expect(s.revealed).toBeLessThanOrEqual(s.arrived);
    if (i > 0) {
      expect(s.revealed).toBeGreaterThanOrEqual(samples[i - 1]!.revealed);
    }
  }
}

describe('回放 · 散文（慢速 80 字/s 与快速 600 字/s）', () => {
  it('慢速散文：CV ≤0.35、单帧 p95 ≤150、饥饿 ≤300ms', () => {
    const events = dripEvents(8, 100, 2_400);
    const { samples } = runReplay({
      events,
      durationMs: 30_500,
      finishAtMs: 30_000,
    });
    expectMonotonePrefix(samples);
    const increments = incrementsOf(samples);
    // CV 只计流活跃期的整窗：截到收尾帧为止（snap 帧不入），
    // 并跳过啮合前的透传窗（t<3000ms，约前 12 窗）
    const finishIdx = samples.findIndex((s) => s.t >= 30_000);
    const windows = windowedReveal(increments.slice(0, finishIdx));
    const active = windows.slice(12);
    expect(cv(active)).toBeLessThanOrEqual(0.35);
    expect(percentile(increments, 0.95)).toBeLessThanOrEqual(150);
    expect(maxStarvationMs(samples, 30_000)).toBeLessThanOrEqual(300);
    // 收尾：余量小，snap 后与到达一致且其后零落帧
    const last = samples[samples.length - 1]!;
    expect(last.revealed).toBe(last.arrived);
  });

  it('快速散文：CV ≤0.35、p95 ≤150、稳态字符滞后 ≤3000', () => {
    const events = dripEvents(30, 50, 7_200);
    // 收尾泄空时长由 0.7→1.0s，留更多缓冲时间（12000+1200=13200ms）
    const { samples } = runReplay({
      events,
      durationMs: 13_500,
      finishAtMs: 12_000,
    });
    expectMonotonePrefix(samples);
    const increments = incrementsOf(samples);
    // 同上：截到收尾帧、跳过啮合前与啮合爬升窗（前 3 窗 ≈ 750ms）
    const finishIdx = samples.findIndex((s) => s.t >= 12_000);
    const windows = windowedReveal(increments.slice(0, finishIdx));
    const active = windows.slice(3);
    expect(cv(active)).toBeLessThanOrEqual(0.35);
    expect(percentile(increments, 0.95)).toBeLessThanOrEqual(150);
    expect(maxStarvationMs(samples, 12_000)).toBeLessThanOrEqual(300);
    // 稳态滞后（到达中段抽样）远小于 3000 上限
    const mid = samples[Math.floor(samples.length / 2)]!;
    expect(mid.arrived - mid.revealed).toBeLessThanOrEqual(3_000);
    const last = samples[samples.length - 1]!;
    expect(last.revealed).toBe(last.arrived);
  });
});

describe('回放 · 倾泻与巨型块', () => {
  it('3 秒静默后 4000 字倾泻：不整帧倾倒、泄空相位 CV ≤0.5、随后跟随慢速尾流', () => {
    const head = dripEvents(10, 100, 200, PROSE_UNIT, 0);
    const burst: ArrivalEvent[] = [{ atMs: 3_000, chunk: makeText(4_000) }];
    const tail = dripEvents(10, 100, 600, PROSE_UNIT, 3_100);
    const events = [...head, ...burst, ...tail];
    const { samples } = runReplay({
      events,
      durationMs: 9_500,
      finishAtMs: 9_100,
    });
    expectMonotonePrefix(samples);
    const increments = incrementsOf(samples);
    // 倾泻帧本身受单帧硬顶约束，绝不一帧吐完
    const burstIdx = samples.findIndex((s) => s.arrived >= 4_200);
    expect(increments[burstIdx]!).toBeLessThanOrEqual(420);
    expect(Math.max(...increments)).toBeLessThanOrEqual(420);
    // 泄空相位（倾泻后滞后回到目标前的整窗）速率恒定 → CV 低
    const burstFrame = burstIdx;
    const drainWindows: number[] = [];
    for (
      let i = burstFrame;
      i + WINDOW_FRAMES <= samples.length && drainWindows.length < 3;
      i += WINDOW_FRAMES
    ) {
      let sum = 0;
      for (let j = i; j < i + WINDOW_FRAMES; j++) sum += increments[j]!;
      if (sum < 200) break; // 已泄空完毕的窗不计
      drainWindows.push(sum);
    }
    expect(drainWindows.length).toBeGreaterThanOrEqual(2);
    expect(cv(drainWindows)).toBeLessThanOrEqual(0.5);
    expect(maxStarvationMs(samples, 9_100)).toBeLessThanOrEqual(300);
    const last = samples[samples.length - 1]!;
    expect(last.revealed).toBe(last.arrived);
  });

  it('60KB 代码块：全程受追赶封顶匀速排空，单帧不越硬顶、无饥饿', () => {
    const events = dripEvents(2_000, 100, 60_000, CODE_UNIT);
    const { samples } = runReplay({
      events,
      durationMs: 13_000,
      finishAtMs: 3_000,
    });
    expectMonotonePrefix(samples);
    const increments = incrementsOf(samples);
    expect(Math.max(...increments)).toBeLessThanOrEqual(420);
    // 到达期（0.5s–3s）单帧 p95 ≤150（追赶 5200 字/s ≈ 87 字/帧）
    const during = increments.slice(30, 180);
    expect(percentile(during, 0.95)).toBeLessThanOrEqual(150);
    expect(maxStarvationMs(samples, 3_000)).toBeLessThanOrEqual(300);
    // 到达结束后以追赶速率持续泄空直至收敛（大余量按封顶泄空，
    // 不受 0.7s 泄空时长的瞬时倾倒——总量决定总时长）
    const last = samples[samples.length - 1]!;
    expect(last.revealed).toBe(last.arrived);
    const settledIdx = samples.findIndex(
      (s, i) => i > 200 && s.revealed >= s.arrived && s.arrived >= 60_000
    );
    expect(settledIdx).toBeGreaterThan(0);
  });
});

describe('回放 · 思考爆发-停顿（思考档）与短回复', () => {
  it('爆发-停顿交替：停顿期不冻结、预留慢慢泄掉，收尾收敛', () => {
    const events: ArrivalEvent[] = [];
    for (let b = 0; b < 6; b++) {
      events.push({ atMs: b * 900, chunk: makeText(350).slice(0, 350) });
    }
    const { samples } = runReplay({
      events,
      profile: THINKING_REVEAL_PACING,
      durationMs: 6_500,
      finishAtMs: 5_400,
    });
    expectMonotonePrefix(samples);
    expect(maxStarvationMs(samples, 5_400)).toBeLessThanOrEqual(300);
    // 吸收态：滞后全程有界（爆发型到达被整流吸收，不滚雪球）
    const maxLag = Math.max(...samples.map((s) => s.arrived - s.revealed));
    expect(maxLag).toBeLessThanOrEqual(900);
    const last = samples[samples.length - 1]!;
    expect(last.revealed).toBe(last.arrived);
  });

  it('短回复（120 字 ≤ 门槛）：从不啮合，逐帧恒等到达（零附加延迟）', () => {
    const events = dripEvents(20, 100, 120);
    const { pacer, samples } = runReplay({
      events,
      durationMs: 1_500,
      finishAtMs: 600,
    });
    expect(pacer.isEngaged).toBe(false);
    for (const s of samples) {
      expect(s.revealed).toBe(s.arrived);
    }
  });
});

describe('收尾与分叉', () => {
  it('收尾 snap：余量 ≤300 时 finish 当帧全显（此前仍在定速中）', () => {
    const events = dripEvents(8, 100, 600);
    const { samples } = runReplay({
      events,
      durationMs: 8_000,
      finishAtMs: 7_500,
    });
    const finishIdx = samples.findIndex((s) => s.t >= 7_500);
    const before = samples[finishIdx - 1]!;
    expect(before.revealed).toBeLessThan(before.arrived);
    expect(before.arrived - before.revealed).toBeLessThanOrEqual(300);
    const atFinish = samples[finishIdx]!;
    expect(atFinish.revealed).toBe(atFinish.arrived);
  });

  it('收尾泄空：中等余量按 余量/0.7s 匀速泄空，不 snap 倾倒、≤900ms 完成', () => {
    const events: ArrivalEvent[] = [{ atMs: 100, chunk: makeText(4_000) }];
    const { samples } = runReplay({
      events,
      durationMs: 1_600,
      finishAtMs: 400,
    });
    const finishIdx = samples.findIndex((s) => s.t >= 400);
    const atFinish = samples[finishIdx]!;
    expect(atFinish.revealed).toBeLessThan(atFinish.arrived); // 未倾倒
    const settled = samples.find(
      (s, i) => i > finishIdx && s.revealed >= s.arrived
    )!;
    expect(settled).toBeDefined();
    expect(settled.t - 400).toBeLessThanOrEqual(900);
    const drainIncrements = incrementsOf(samples).slice(
      finishIdx,
      samples.indexOf(settled) + 1
    );
    expect(percentile(drainIncrements, 0.95)).toBeLessThanOrEqual(150);
  });

  it('非前缀分叉（重试改写全文）：snap 复位，后续增长重新啮合', () => {
    const pacer = new RevealPacer(TEXT_REVEAL_PACING);
    pacer.noteArrived('', 0, true);
    pacer.noteArrived(makeText(3_000), 100, true);
    for (let t = 116; t <= 300; t += FRAME_MS) pacer.tick(t);
    expect(pacer.revealedLength).toBeLessThan(3_000);
    const rewritten = '完全不同的新回答，从零开始书写。'.repeat(20);
    pacer.noteArrived(rewritten, 316, true);
    expect(pacer.revealedLength).toBe(rewritten.length);
    expect(pacer.isEngaged).toBe(false);
    // 后续增长越过门槛后重新啮合定速
    pacer.noteArrived(rewritten + makeText(1_000), 400, true);
    expect(pacer.isEngaged).toBe(true);
    expect(pacer.revealedLength).toBeLessThan(pacer.arrivedLength);
  });

  it('长帧间隔（切后台 5s）：单帧增量仍不越硬顶', () => {
    const pacer = new RevealPacer(TEXT_REVEAL_PACING);
    pacer.noteArrived('', 0, true);
    pacer.noteArrived(makeText(10_000), 100, true);
    pacer.tick(116);
    const before = pacer.revealedLength;
    pacer.tick(116 + 5_000);
    expect(pacer.revealedLength - before).toBeLessThanOrEqual(420);
  });
});

describe('减动效旁路与 grapheme 安全', () => {
  it('prefers-reduced-motion：到达恒等显现，tick 不改变', () => {
    const pacer = new RevealPacer(TEXT_REVEAL_PACING);
    pacer.setReducedMotion(true);
    pacer.noteArrived('', 0, true);
    pacer.noteArrived(makeText(5_000), 50, true);
    expect(pacer.revealedLength).toBe(5_000);
    expect(pacer.needsFrame).toBe(false);
    pacer.tick(100);
    expect(pacer.revealedLength).toBe(5_000);
  });

  it('emoji / 组合符文本：任一帧已显现前缀都落在字形簇边界上', () => {
    const unit = '分析完成👨‍👩‍👧‍👦，café 中的 é 由 é 组合，🇨🇳旗帜与✓符号。';
    const full = makeText(4_800, unit);
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const boundaries = new Set<number>([0]);
    for (const part of seg.segment(full)) {
      boundaries.add(part.index + part.segment.length);
    }
    const events = dripEvents(400, 40, 4_800, unit);
    const { samples } = runReplay({
      events,
      durationMs: 2_500,
      finishAtMs: 1_200,
    });
    for (const s of samples) {
      expect(boundaries.has(s.revealed)).toBe(true);
    }
    const last = samples[samples.length - 1]!;
    expect(last.revealed).toBe(last.arrived);
  });

  it('到达停顿（长考）：EWMA 衰减后预留以保底速率泄空，不永久扣住', () => {
    const events = dripEvents(30, 50, 2_400);
    // 到达在 4s 结束但流保持开启（长考停顿），10s 后才 finish
    const { samples } = runReplay({
      events,
      durationMs: 10_500,
      finishAtMs: 10_000,
    });
    expect(maxStarvationMs(samples, 10_000)).toBeLessThanOrEqual(300);
    // 停顿深处（9.5s）：滞后应已泄至仅剩极小尾巴
    const deep = samples.find((s) => s.t >= 9_500)!;
    expect(deep.arrived - deep.revealed).toBeLessThanOrEqual(40);
  });
});
