// 伪流式管线单测：合成 PCM 帧序列 + 假 VAD（能量检出 + 静音断句语义）
// + 假识别器（以解码采样长为文本），断言 partial/final 的触发顺序、
// 节律、断句、flush 收尾与旧 partial 作废语义。
import {
  SimulatedStreamingPipeline,
  type AsrResultEvent,
  type RecognizerPort,
  type SpeechSegmentLike,
  type VadPort,
} from './simulatedStreamingPipeline';

const WINDOW = 512;
/** 假 VAD 的断句静音阈值：0.3s = 4800 采样（与规范 min_silence_duration 对齐） */
const FAKE_MIN_SILENCE_SAMPLES = 4800;

class FakeVad implements VadPort {
  private queue: SpeechSegmentLike[] = [];
  private detected = false;
  private speechBuf: number[] = [];
  private trailingSilence: number[] = [];
  private streamOffset = 0;
  private segmentStart = 0;

  acceptWaveform(samples: Float32Array): void {
    const isSpeech = samples.some((v) => Math.abs(v) > 0.5);
    if (isSpeech) {
      if (!this.detected) {
        this.detected = true;
        this.segmentStart = this.streamOffset;
        this.speechBuf = [];
        this.trailingSilence = [];
      }
      this.speechBuf.push(...this.trailingSilence, ...samples);
      this.trailingSilence = [];
    } else if (this.detected) {
      this.trailingSilence.push(...samples);
      if (this.trailingSilence.length >= FAKE_MIN_SILENCE_SAMPLES) {
        this.emitSegment();
      }
    }
    this.streamOffset += samples.length;
  }

  private emitSegment(): void {
    // 极短发声（< min_speech 0.25s）不吐段，与真 VAD 语义一致
    if (this.speechBuf.length >= 4000) {
      this.queue.push({
        start: this.segmentStart,
        samples: Float32Array.from(this.speechBuf),
      });
    }
    this.detected = false;
    this.speechBuf = [];
    this.trailingSilence = [];
  }

  isSpeechDetected(): boolean {
    return this.detected;
  }
  isEmpty(): boolean {
    return this.queue.length === 0;
  }
  front(): SpeechSegmentLike {
    const segment = this.queue[0];
    if (!segment) throw new Error('FakeVad: front() on empty queue');
    return segment;
  }
  pop(): void {
    this.queue.shift();
  }
  flush(): void {
    if (this.detected) this.emitSegment();
  }
  reset(): void {
    this.queue = [];
    this.detected = false;
    this.speechBuf = [];
    this.trailingSilence = [];
    this.streamOffset = 0;
    this.segmentStart = 0;
  }
}

class FakeRecognizer implements RecognizerPort {
  /** 历次解码的输入采样长（按执行顺序） */
  readonly decodeLengths: number[] = [];
  /** 手动模式：decode 返回待外部 resolve 的 promise（测旧 partial 作废） */
  manual = false;
  private pending: Array<() => void> = [];

  decode(samples: Float32Array): Promise<string> {
    this.decodeLengths.push(samples.length);
    const text = `len:${samples.length}`;
    if (this.manual) {
      return new Promise<string>((resolve) => {
        this.pending.push(() => resolve(text));
      });
    }
    return Promise.resolve(text);
  }

  resolveNext(): void {
    const next = this.pending.shift();
    if (next) next();
  }
  resolveAll(): void {
    while (this.pending.length > 0) this.resolveNext();
  }
}

const speechWindow = (): Float32Array => new Float32Array(WINDOW).fill(0.8);
const silenceWindow = (): Float32Array => new Float32Array(WINDOW);

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** 逐窗喂入并在每窗后让出微任务队列（模拟真机回调的时间分布） */
async function feed(
  pipeline: SimulatedStreamingPipeline,
  windows: Float32Array[]
): Promise<void> {
  for (const w of windows) {
    pipeline.accept(w);
    await tick();
  }
}

function makePipeline() {
  const vad = new FakeVad();
  const recognizer = new FakeRecognizer();
  const events: AsrResultEvent[] = [];
  const pipeline = new SimulatedStreamingPipeline({
    vad,
    recognizer,
    onResult: (e) => events.push(e),
  });
  pipeline.start();
  return { vad, recognizer, events, pipeline };
}

const repeat = (make: () => Float32Array, n: number): Float32Array[] =>
  Array.from({ length: n }, make);

describe('SimulatedStreamingPipeline', () => {
  it('emits partials on a 200ms cadence then exactly one final per segment', async () => {
    const { events, pipeline, recognizer } = makePipeline();
    await feed(pipeline, [
      ...repeat(silenceWindow, 5),
      ...repeat(speechWindow, 30),
      ...repeat(silenceWindow, 12),
    ]);
    await pipeline.whenIdle();

    const kinds = events.map((e) => (e.isFinal ? 'F' : 'p')).join('');
    expect(kinds).toMatch(/^p+F$/);
    // final 解码的是 VAD 片段采样（30 窗人声 = 15360，不含尾随静音）
    const lastEvent = events[events.length - 1];
    expect(lastEvent?.text).toBe('len:15360');
    // partial 解码长度单调递增，且首个 partial 含 pre-roll（5 窗静音）
    const partialLengths = recognizer.decodeLengths.slice(0, -1);
    expect(partialLengths.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < partialLengths.length; i++) {
      expect(partialLengths[i] ?? 0).toBeGreaterThan(
        partialLengths[i - 1] ?? 0
      );
    }
    // 首 partial：起始句 3072 采样（pre-roll 2560 + 首窗 512）后再累积
    // ≥3200 采样触发 → 长度落在 [6272, 6784]
    expect(partialLengths[0]).toBeGreaterThanOrEqual(6272);
    expect(partialLengths[0]).toBeLessThanOrEqual(6784);
  });

  it('splits two utterances separated by silence into two ordered finals', async () => {
    const { events, pipeline } = makePipeline();
    await feed(pipeline, [
      ...repeat(speechWindow, 16),
      ...repeat(silenceWindow, 12),
      ...repeat(speechWindow, 16),
      ...repeat(silenceWindow, 12),
    ]);
    await pipeline.whenIdle();
    await pipeline.stop();

    const finals = events.filter((e) => e.isFinal);
    expect(finals).toHaveLength(2);
    expect(finals[0]?.text).toBe('len:8192');
    expect(finals[1]?.text).toBe('len:8192');
    // 顺序不变量：第二句 partial 不得出现在第一句 final 之前
    const firstFinalIdx = events.findIndex((e) => e.isFinal);
    const secondFinalIdx = events.findIndex(
      (e, i) => e.isFinal && i > firstFinalIdx
    );
    expect(secondFinalIdx).toBe(events.length - 1);
  });

  it('stop() flushes the trailing half-sentence into a final', async () => {
    const { events, pipeline } = makePipeline();
    await feed(pipeline, repeat(speechWindow, 16));
    await pipeline.stop();
    const finals = events.filter((e) => e.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.text).toBe('len:8192');
    expect(events[events.length - 1]?.isFinal).toBe(true);
  });

  it('produces no events for pure silence', async () => {
    const { events, pipeline } = makePipeline();
    await feed(pipeline, repeat(silenceWindow, 20));
    await pipeline.stop();
    expect(events).toHaveLength(0);
  });

  it('re-windows unaligned chunks before feeding the VAD', async () => {
    const { events, pipeline } = makePipeline();
    // 把「16 窗人声」拼成整块后以 1000 采样非对齐粒度喂入
    const all = new Float32Array(WINDOW * 16).fill(0.8);
    for (let i = 0; i < all.length; i += 1000) {
      pipeline.accept(all.slice(i, i + 1000));
      await tick();
    }
    await pipeline.stop();
    const finals = events.filter((e) => e.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.text).toBe('len:8192');
  });

  it('drops a stale partial that resolves after the segment final', async () => {
    const { events, pipeline, recognizer } = makePipeline();
    recognizer.manual = true;
    // 人声累积到触发首个 partial（解码 promise 悬挂）
    await feed(pipeline, repeat(speechWindow, 10));
    expect(recognizer.decodeLengths.length).toBeGreaterThanOrEqual(1);
    // 静音断句 → final 入链；此时放行悬挂的 partial 解码
    await feed(pipeline, repeat(silenceWindow, 12));
    // 解码链按序推进：partial 被放行后 final 的 decode 才会被调用并悬挂，
    // 需多轮「放行 + 让出队列」把整条链推完
    for (let i = 0; i < 20; i++) {
      recognizer.resolveAll();
      await tick();
    }
    await pipeline.whenIdle();
    await pipeline.stop();

    const partialAfterFinal = events.some(
      (e, i) => !e.isFinal && events.some((f, j) => f.isFinal && j < i)
    );
    expect(partialAfterFinal).toBe(false);
    expect(events.filter((e) => e.isFinal)).toHaveLength(1);
  });
});
