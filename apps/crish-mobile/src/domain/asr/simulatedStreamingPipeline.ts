// 伪流式离线 ASR 管线（sherpa-onnx Simulated Streaming 架构的 TS 实现）。
//
// 架构（用户引擎规范 2026-11-01，刚性）：
// - 采集 16kHz / 单声道 / Float32[-1,1]，以 512 采样 window 步进喂 Silero VAD；
// - 未检出人声时滚动保留最近 10 个 window（320ms）作 pre-roll，防吞字头；
// - 检出人声后累积当前句 buffer，每 200ms 对整个 buffer 重解码 → partial 回调；
// - VAD 吐出片段（停顿超 min_silence 或满 max_speech）→ 对 front.samples 做
//   最终解码 → final 回调，随后清 buffer；
// - 主动停止时 vad.flush() 并跑完队列收尾最后半句，不丢尾音。
//
// 本类只依赖 VadPort / RecognizerPort 两个注入端口，不感知原生细节：
// 生产环境由 Android 本地模块适配，测试环境由假实现 / node 绑定适配。
// 解码串行化：所有解码任务挂一条 promise 链按序执行；partial 携带代际号，
// 代际推进（final / stop / reset）后调度的旧 partial 在执行时被丢弃，
// 保证事件顺序恒为「若干 partial → final」，绝不 final 之后再冒旧 partial。

/** 采样率（规范锁定 16kHz） */
export const ASR_SAMPLE_RATE = 16000;
/** VAD 喂入窗口（规范锁定 512 采样 = 32ms） */
export const VAD_WINDOW_SIZE = 512;
/** pre-roll 保留窗口数（规范锁定 10 个 window = 320ms） */
export const PRE_ROLL_WINDOWS = 10;
/** partial 解码节律（规范锁定 200ms = 3200 采样 @16kHz） */
export const PARTIAL_INTERVAL_SAMPLES = 3200;

/** VAD 吐出的语音片段（start 为全流采样偏移，samples 为该片段采样） */
export interface SpeechSegmentLike {
  start: number;
  samples: Float32Array;
}

/** VAD 端口（与 sherpa-onnx Vad 的 Kotlin / C / node API 一一对应） */
export interface VadPort {
  acceptWaveform(samples: Float32Array): void;
  isSpeechDetected(): boolean;
  isEmpty(): boolean;
  front(): SpeechSegmentLike;
  pop(): void;
  flush(): void;
  reset(): void;
}

/** 识别器端口：对一段完整采样做离线解码，返回文本（空串 = 无可识别内容） */
export interface RecognizerPort {
  decode(samples: Float32Array, sampleRate: number): Promise<string>;
}

/** 识别结果事件：isFinal=false 为当前句临时结果，true 为定稿 */
export interface AsrResultEvent {
  text: string;
  isFinal: boolean;
}

export interface SimulatedStreamingPipelineOptions {
  vad: VadPort;
  recognizer: RecognizerPort;
  onResult: (event: AsrResultEvent) => void;
  onError?: (error: unknown) => void;
  sampleRate?: number;
  windowSize?: number;
  preRollWindows?: number;
  partialIntervalSamples?: number;
}

export class SimulatedStreamingPipeline {
  private readonly vad: VadPort;
  private readonly recognizer: RecognizerPort;
  private readonly onResult: (event: AsrResultEvent) => void;
  private readonly onError: (error: unknown) => void;
  private readonly sampleRate: number;
  private readonly windowSize: number;
  private readonly preRollLimit: number;
  private readonly partialIntervalSamples: number;

  /** 尚未凑满一个 window 的采样残留 */
  private inbox: Float32Array = new Float32Array(0);
  /** pre-roll 环形保留（未检出人声时的最近若干 window） */
  private preRoll: Float32Array[] = [];
  /** 当前句累积采样（检出人声后，含 pre-roll 前置） */
  private utterance: Float32Array[] = [];
  private utteranceLength = 0;
  private inSpeech = false;
  /** 距上次 partial 调度以来新增的采样数 */
  private samplesSincePartial = 0;
  /** 解码串行链（保证事件顺序） */
  private decodeChain: Promise<void> = Promise.resolve();
  /** 代际号：final / stop / reset 时推进，作废已调度的旧 partial */
  private generation = 0;
  private stopped = true;

  constructor(options: SimulatedStreamingPipelineOptions) {
    this.vad = options.vad;
    this.recognizer = options.recognizer;
    this.onResult = options.onResult;
    this.onError = options.onError ?? (() => undefined);
    this.sampleRate = options.sampleRate ?? ASR_SAMPLE_RATE;
    this.windowSize = options.windowSize ?? VAD_WINDOW_SIZE;
    this.preRollLimit = options.preRollWindows ?? PRE_ROLL_WINDOWS;
    this.partialIntervalSamples =
      options.partialIntervalSamples ?? PARTIAL_INTERVAL_SAMPLES;
  }

  /** 开始一轮采集（清空上一轮残留状态；VAD 本体复位由 start 调用方负责亦可） */
  start(): void {
    this.resetState();
    this.stopped = false;
  }

  /**
   * 喂入任意长度的采样块（麦克风回调粒度不保证对齐），内部重组为
   * windowSize 的整窗步进喂 VAD。同步执行 VAD，解码异步串行。
   */
  accept(samples: Float32Array): void {
    if (this.stopped || samples.length === 0) return;
    const merged = new Float32Array(this.inbox.length + samples.length);
    merged.set(this.inbox, 0);
    merged.set(samples, this.inbox.length);
    let offset = 0;
    while (merged.length - offset >= this.windowSize) {
      const window = merged.slice(offset, offset + this.windowSize);
      offset += this.windowSize;
      this.processWindow(window);
    }
    this.inbox = merged.slice(offset);
  }

  /**
   * 主动停止：vad.flush() 让 VAD 吐出进行中的片段，跑完队列收尾；
   * 若 VAD 未成段但本地 buffer 仍有累积（极短促发声），直接对 buffer
   * 做最终解码，保证最后半句不丢。返回时所有已调度解码均已完成。
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // inbox 中不足一窗的残留并入当前句（尾音防丢）；未检出人声时丢弃
    if (this.inSpeech && this.inbox.length > 0) {
      this.utterance.push(this.inbox);
      this.utteranceLength += this.inbox.length;
    }
    this.inbox = new Float32Array(0);
    try {
      this.vad.flush();
    } catch (error) {
      this.onError(error);
    }
    this.drainSegments();
    if (this.inSpeech && this.utteranceLength > 0) {
      const rest = this.concatUtterance();
      this.clearUtterance();
      this.scheduleFinal(rest);
    }
    this.generation += 1;
    await this.decodeChain;
  }

  /** 彻底复位（页面销毁 / 取消时）：作废未执行 partial，清全部缓冲 */
  reset(): void {
    this.stopped = true;
    this.resetState();
  }

  /** 等待已调度的全部解码完成（测试与收尾用） */
  async whenIdle(): Promise<void> {
    await this.decodeChain;
  }

  private resetState(): void {
    this.generation += 1;
    this.inbox = new Float32Array(0);
    this.preRoll = [];
    this.clearUtterance();
    this.samplesSincePartial = 0;
    try {
      this.vad.reset();
    } catch (error) {
      this.onError(error);
    }
  }

  private clearUtterance(): void {
    this.utterance = [];
    this.utteranceLength = 0;
    this.inSpeech = false;
    this.samplesSincePartial = 0;
  }

  private concatUtterance(): Float32Array {
    const out = new Float32Array(this.utteranceLength);
    let offset = 0;
    for (const chunk of this.utterance) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  private processWindow(window: Float32Array): void {
    this.vad.acceptWaveform(window);
    if (!this.inSpeech) {
      if (this.vad.isSpeechDetected()) {
        // 人声起始：pre-roll 前置 + 当前窗，构成当前句初始 buffer
        this.inSpeech = true;
        this.utterance = [...this.preRoll, window];
        this.utteranceLength =
          this.preRoll.reduce((sum, chunk) => sum + chunk.length, 0) +
          window.length;
        this.preRoll = [];
        // partial 节律自人声起始计：每新增 partialIntervalSamples 再解码一次
        this.samplesSincePartial = 0;
      } else {
        this.preRoll.push(window);
        if (this.preRoll.length > this.preRollLimit) this.preRoll.shift();
      }
    } else {
      this.utterance.push(window);
      this.utteranceLength += window.length;
      this.samplesSincePartial += window.length;
      if (this.samplesSincePartial >= this.partialIntervalSamples) {
        this.samplesSincePartial = 0;
        this.schedulePartial(this.concatUtterance(), this.generation);
      }
    }
    this.drainSegments();
  }

  /** 跑完 VAD 片段队列：每段做最终解码并清当前句状态 */
  private drainSegments(): void {
    let guard = 0;
    while (!this.vad.isEmpty() && guard < 64) {
      guard += 1;
      const segment = this.vad.front();
      this.vad.pop();
      if (segment.samples.length > 0) {
        this.scheduleFinal(segment.samples.slice());
      }
      this.clearUtterance();
      this.preRoll = [];
      this.generation += 1;
    }
  }

  private schedulePartial(samples: Float32Array, generation: number): void {
    this.decodeChain = this.decodeChain.then(async () => {
      if (generation !== this.generation) return; // 已被 final/stop 作废
      try {
        const text = await this.recognizer.decode(samples, this.sampleRate);
        if (generation !== this.generation) return;
        if (text.length > 0) this.onResult({ text, isFinal: false });
      } catch (error) {
        this.onError(error);
      }
    });
  }

  private scheduleFinal(samples: Float32Array): void {
    this.decodeChain = this.decodeChain.then(async () => {
      try {
        const text = await this.recognizer.decode(samples, this.sampleRate);
        if (text.length > 0) this.onResult({ text, isFinal: true });
      } catch (error) {
        this.onError(error);
      }
    });
  }
}

export default SimulatedStreamingPipeline;
