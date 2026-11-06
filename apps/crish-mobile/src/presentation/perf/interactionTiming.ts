// 交互里程碑计时（窄域，MBP 验收用）。
//
// 只记录离散手势与挂载边界的毫秒差，例如按下、发出打开请求、内容完成布局。
// 不在逐 token、逐帧回调里记点。没有真实「已经看见」的完成信号时，完成相位
// 只能是 request 或 mount，不得把这段时间说成用户可见等待。
//
// 默认仅在开发构建开启，或显式轻量开关取值为 "1" 时启用。
// 生产默认：开关关闭，开始、记点、结束都是空操作，不分配记录、不打日志、
// 不触发渲染。记录里只有静态名称、相位和毫秒，不采集令牌、票据或设备标识。
import { createLogger, scrubLogString } from '@/adapters/platform/logger';

export type InteractionPhase = 'press' | 'request' | 'mount' | 'visible';

export interface InteractionMark {
  phase: InteractionPhase;
  elapsedMs: number;
}

export interface InteractionRecord {
  name: string;
  durationMs: number;
  completion: InteractionPhase;
  /** 只有完成相位为可见时才表示看见；请求与挂载只是生命周期。 */
  visibility: 'visible' | 'not-visible';
  marks: readonly InteractionMark[];
}

export interface InteractionHandle {
  mark(phase: InteractionPhase): void;
  /** 结束并返回记录。关闭或重复结束时返回 null。 */
  end(completion: InteractionPhase): InteractionRecord | null;
  /** 放弃本次跨度，不留记录、不打日志（短按未进入长按即走这里）。 */
  cancel(): void;
}

const log = createLogger('interaction-timing');
const RING_LIMIT = 16;

let enabledOverride: boolean | null = null;
let nowFn: () => number = () => Date.now();
let sinkOverride: ((line: string) => void) | null = null;
const ring: InteractionRecord[] = [];

function devDefault(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

/** 当前是否记录。生产默认关；CRISH_INTERACTION_TIMING 仅认 "0" / "1"。 */
export function isInteractionTimingEnabled(): boolean {
  if (enabledOverride !== null) return enabledOverride;
  const flag = process.env.CRISH_INTERACTION_TIMING;
  if (flag === '0') return false;
  if (flag === '1') return true;
  return devDefault();
}

function visibilityOf(completion: InteractionPhase): InteractionRecord['visibility'] {
  return completion === 'visible' ? 'visible' : 'not-visible';
}

const noopHandle: InteractionHandle = {
  mark() {},
  end() {
    return null;
  },
  cancel() {},
};

class ActiveSpan implements InteractionHandle {
  private readonly startedAtMs: number;
  private readonly marks: InteractionMark[] = [];
  private closed = false;

  constructor(private readonly name: string) {
    this.startedAtMs = nowFn();
  }

  mark(phase: InteractionPhase): void {
    if (this.closed) return;
    const elapsedMs = Math.max(0, nowFn() - this.startedAtMs);
    this.marks.push({ phase, elapsedMs });
  }

  end(completion: InteractionPhase): InteractionRecord | null {
    if (this.closed) return null;
    this.closed = true;
    const durationMs = Math.max(0, nowFn() - this.startedAtMs);
    if (!this.marks.some((mark) => mark.phase === completion)) {
      this.marks.push({ phase: completion, elapsedMs: durationMs });
    }
    const record: InteractionRecord = {
      name: this.name,
      durationMs,
      completion,
      visibility: visibilityOf(completion),
      marks: this.marks,
    };
    ring.push(record);
    if (ring.length > RING_LIMIT) ring.shift();
    emit(record);
    return record;
  }

  cancel(): void {
    this.closed = true;
  }
}

function emit(record: InteractionRecord): void {
  const line = scrubLogString(
    `${record.name} ${record.completion} ${record.durationMs}ms ${record.visibility}`
  );
  if (sinkOverride) {
    sinkOverride(line);
    return;
  }
  log.debug(line, {
    marks: record.marks.map((mark) => ({
      phase: mark.phase,
      elapsedMs: mark.elapsedMs,
    })),
  });
}

/** 开始一段离散交互。关闭时返回共享空句柄，调用方无需分支。 */
export function beginInteraction(name: string): InteractionHandle {
  if (!isInteractionTimingEnabled()) return noopHandle;
  return new ActiveSpan(name);
}

/** 测试隔离：覆盖开关、时钟与输出；不传参恢复默认。 */
export function configureInteractionTimingForTest(options?: {
  enabled?: boolean | null;
  now?: (() => number) | null;
  sink?: ((line: string) => void) | null;
}): void {
  enabledOverride = options?.enabled ?? null;
  nowFn = options?.now ?? (() => Date.now());
  sinkOverride = options?.sink ?? null;
  ring.length = 0;
}

export function readInteractionRecordsForTest(): readonly InteractionRecord[] {
  return ring.slice();
}
