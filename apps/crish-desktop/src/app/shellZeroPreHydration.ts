/**
 * Shell-Zero 动态事件代偿水合引擎与冷启动 SLA 预算验证器 (Wave 4 · W4-4)
 */

export const MAX_CAPTURED_EVENTS = 64;
export const SHELL_ZERO_MAX_HTML_BYTES = 60 * 1024;
export const SHELL_ZERO_MAX_LCP_MS = 80;
export const SHELL_ZERO_MAX_TTI_MS = 120;

export type PreHydrationEventType =
  'composer-input' | 'session-select' | 'shortcut-key';

export interface PreHydrationEventInput {
  readonly type: PreHydrationEventType;
  readonly text?: string;
  readonly value?: string;
  readonly sessionId?: string;
  readonly shortcut?: string;
  readonly key?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly timestamp?: number;
}

export interface CapturedPreHydrationEvent extends PreHydrationEventInput {
  readonly timestamp: number;
}

export interface PreHydrationReplayHandlers {
  readonly onComposerInput?: (mergedText: string) => void;
  readonly onSessionSelect?: (sessionId: string) => void;
  readonly onShortcutKey?: (
    shortcut: string,
    event: CapturedPreHydrationEvent
  ) => void;
}

export interface PreHydrationReplayResult {
  readonly replayedCount: number;
  readonly droppedCount: number;
  readonly mergedComposerText: string | null;
  readonly targetSessionId: string | null;
  readonly triggeredShortcuts: readonly string[];
}

export interface ShellZeroEngineOptions {
  readonly maxCapturedEvents?: number;
  readonly overflowStrategy?: 'drop-newest' | 'drop-oldest';
}

function resolveTimestamp(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit))
    return explicit;
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function normalizeShortcut(input: PreHydrationEventInput): string {
  if (typeof input.shortcut === 'string' && input.shortcut.trim()) {
    return input.shortcut.trim();
  }
  const parts: string[] = [];
  if (input.ctrlKey) parts.push('Ctrl');
  if (input.metaKey) parts.push('Meta');
  if (input.altKey) parts.push('Alt');
  if (input.shiftKey) parts.push('Shift');
  const rawKey = typeof input.key === 'string' ? input.key.trim() : '';
  if (rawKey) parts.push(rawKey.length === 1 ? rawKey.toUpperCase() : rawKey);
  return parts.join('+');
}

/**
 * Shell-Zero 早期事件代偿捕获与单帧确定性回放器
 */
export class ShellZeroPreHydrationEngine {
  public static readonly MAX_CAPTURED_EVENTS = MAX_CAPTURED_EVENTS;

  private readonly maxEvents: number;
  private readonly overflowStrategy: 'drop-newest' | 'drop-oldest';
  private queue: Array<{ seq: number; event: CapturedPreHydrationEvent }> = [];
  private hydrated = false;
  private dropped = 0;
  private nextSeq = 0;

  constructor(options?: ShellZeroEngineOptions) {
    this.maxEvents = Math.max(
      1,
      Math.floor(options?.maxCapturedEvents ?? MAX_CAPTURED_EVENTS)
    );
    this.overflowStrategy = options?.overflowStrategy ?? 'drop-newest';
  }

  public get isHydrated(): boolean {
    return this.hydrated;
  }

  public get size(): number {
    return this.queue.length;
  }

  public get droppedCount(): number {
    return this.dropped;
  }

  public getCapturedEvents(): readonly CapturedPreHydrationEvent[] {
    return this.queue.map((item) => item.event);
  }

  /** 水合前捕获早期用户事件；水合完成后直接忽略并返回 false */
  public capture(input: PreHydrationEventInput): boolean {
    if (this.hydrated || !input || typeof input !== 'object') return false;
    const normalized = this.normalizeEvent(input);
    if (!normalized) return false;

    if (this.queue.length >= this.maxEvents) {
      this.dropped += 1;
      if (this.overflowStrategy !== 'drop-oldest') return false;
      this.queue.shift();
    }

    this.queue.push({ seq: this.nextSeq++, event: normalized });
    return true;
  }

  public captureComposerInput(text: string, timestamp?: number): boolean {
    return this.capture({ type: 'composer-input', text, timestamp });
  }

  public captureSessionSelect(sessionId: string, timestamp?: number): boolean {
    return this.capture({ type: 'session-select', sessionId, timestamp });
  }

  public captureShortcutKey(shortcut: string, timestamp?: number): boolean {
    return this.capture({ type: 'shortcut-key', shortcut, timestamp });
  }

  /**
   * 单帧确定性回放：原子置位 isHydrated = true，按时间顺序合并输入文本、
   * 仅保留最后一次有效会话切换、依次触发快捷键回调，随后立即清空队列释放内存。
   */
  public drainAndReplay(
    handlers: PreHydrationReplayHandlers = {}
  ): PreHydrationReplayResult {
    this.hydrated = true;
    const snapshot = this.queue.splice(0, this.queue.length);
    snapshot.sort(
      (a, b) => a.event.timestamp - b.event.timestamp || a.seq - b.seq
    );

    const composerChunks: string[] = [];
    let targetSessionId: string | null = null;
    const shortcutEvents: CapturedPreHydrationEvent[] = [];

    for (const { event } of snapshot) {
      if (event.type === 'composer-input' && event.text) {
        composerChunks.push(event.text);
      } else if (event.type === 'session-select' && event.sessionId) {
        targetSessionId = event.sessionId;
      } else if (event.type === 'shortcut-key' && event.shortcut) {
        shortcutEvents.push(event);
      }
    }

    const mergedComposerText =
      composerChunks.length > 0 ? composerChunks.join('') : null;
    if (targetSessionId !== null) handlers.onSessionSelect?.(targetSessionId);
    if (mergedComposerText !== null) {
      handlers.onComposerInput?.(mergedComposerText);
    }

    const triggeredShortcuts: string[] = [];
    for (const sc of shortcutEvents) {
      const code = sc.shortcut!;
      triggeredShortcuts.push(code);
      handlers.onShortcutKey?.(code, sc);
    }

    return {
      replayedCount: snapshot.length,
      droppedCount: this.dropped,
      mergedComposerText,
      targetSessionId,
      triggeredShortcuts,
    };
  }

  private normalizeEvent(
    input: PreHydrationEventInput
  ): CapturedPreHydrationEvent | null {
    const timestamp = resolveTimestamp(input.timestamp);
    if (input.type === 'composer-input') {
      const raw = input.text ?? input.value ?? '';
      return typeof raw === 'string' && raw.length > 0
        ? { type: 'composer-input', text: raw, timestamp }
        : null;
    }
    if (input.type === 'session-select') {
      const sessionId =
        typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
      return sessionId
        ? { type: 'session-select', sessionId, timestamp }
        : null;
    }
    if (input.type === 'shortcut-key') {
      const shortcut = normalizeShortcut(input);
      return shortcut
        ? { ...input, type: 'shortcut-key', shortcut, timestamp }
        : null;
    }
    return null;
  }
}

export interface ShellZeroColdStartMetricsInput {
  readonly shellHtmlBytes: number;
  readonly lcpMs?: number;
  readonly lcp?: number;
  readonly ttiMs?: number;
  readonly tti?: number;
}

export interface ShellZeroColdStartSlaBudgets {
  readonly maxShellHtmlBytes?: number;
  readonly maxLcpMs?: number;
  readonly maxTtiMs?: number;
}

export interface ShellZeroSlaViolation {
  readonly metric: 'shellHtmlBytes' | 'lcpMs' | 'ttiMs';
  readonly actual: number;
  readonly budget: number;
  readonly message: string;
}

export interface ShellZeroColdStartSlaReport {
  readonly passed: boolean;
  readonly compliant: boolean;
  readonly checks: {
    readonly shellHtmlBytesOk: boolean;
    readonly lcpOk: boolean;
    readonly ttiOk: boolean;
  };
  readonly metrics: {
    readonly shellHtmlBytes: number;
    readonly lcpMs: number;
    readonly ttiMs: number;
  };
  readonly budgets: Required<ShellZeroColdStartSlaBudgets>;
  readonly violations: readonly ShellZeroSlaViolation[];
  readonly diagnostics: readonly string[];
}

/** 校验静态外壳字节数 <= 60KB、LCP <= 80ms、TTI <= 120ms */
export function verifyShellZeroColdStartSla(
  input: ShellZeroColdStartMetricsInput,
  customBudgets?: ShellZeroColdStartSlaBudgets
): ShellZeroColdStartSlaReport {
  const maxShellHtmlBytes =
    customBudgets?.maxShellHtmlBytes ?? SHELL_ZERO_MAX_HTML_BYTES;
  const maxLcpMs = customBudgets?.maxLcpMs ?? SHELL_ZERO_MAX_LCP_MS;
  const maxTtiMs = customBudgets?.maxTtiMs ?? SHELL_ZERO_MAX_TTI_MS;

  const shellHtmlBytes = input.shellHtmlBytes;
  const lcpMs = input.lcpMs ?? input.lcp ?? Number.NaN;
  const ttiMs = input.ttiMs ?? input.tti ?? Number.NaN;

  const isOk = (val: number, max: number): boolean =>
    Number.isFinite(val) && val >= 0 && val <= max;
  const shellHtmlBytesOk = isOk(shellHtmlBytes, maxShellHtmlBytes);
  const lcpOk = isOk(lcpMs, maxLcpMs);
  const ttiOk = isOk(ttiMs, maxTtiMs);

  const violations: ShellZeroSlaViolation[] = [];
  const diagnostics: string[] = [];
  if (!shellHtmlBytesOk) {
    const msg = `静态壳超标: ${shellHtmlBytes}B > ${maxShellHtmlBytes}B`;
    violations.push({
      metric: 'shellHtmlBytes',
      actual: shellHtmlBytes,
      budget: maxShellHtmlBytes,
      message: msg,
    });
    diagnostics.push(msg);
  }
  if (!lcpOk) {
    const msg = `LCP 超标: ${lcpMs}ms > ${maxLcpMs}ms`;
    violations.push({
      metric: 'lcpMs',
      actual: lcpMs,
      budget: maxLcpMs,
      message: msg,
    });
    diagnostics.push(msg);
  }
  if (!ttiOk) {
    const msg = `TTI 超标: ${ttiMs}ms > ${maxTtiMs}ms`;
    violations.push({
      metric: 'ttiMs',
      actual: ttiMs,
      budget: maxTtiMs,
      message: msg,
    });
    diagnostics.push(msg);
  }

  const passed = shellHtmlBytesOk && lcpOk && ttiOk;
  if (passed) {
    diagnostics.push(
      `SLA 达标: shell=${shellHtmlBytes}B, LCP=${lcpMs}ms, TTI=${ttiMs}ms`
    );
  }

  return {
    passed,
    compliant: passed,
    checks: { shellHtmlBytesOk, lcpOk, ttiOk },
    metrics: { shellHtmlBytes, lcpMs, ttiMs },
    budgets: { maxShellHtmlBytes, maxLcpMs, maxTtiMs },
    violations,
    diagnostics,
  };
}
