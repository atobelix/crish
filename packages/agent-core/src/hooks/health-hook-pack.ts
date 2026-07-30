/**
 * D2-2 health-hook-pack lite：内置 observe-only 健康信号。
 *
 * 通过 LifecycleHookRegistry.observe 记录 turn/tool/context.compact 计数与时长；
 * **永不** block / terminate，不影响工具与 run 语义。
 *
 * 无外部进程、无 IO；进程内计数供单测 / dev snapshot。
 *
 * @see docs/hooks.md
 * @see docs/plans/2026-07-system-architecture-control-master-plan.md §13 / Round D2-2
 */

import type {
  ContextCompactEndPayload,
  LifecycleHookRegistry,
  LifecycleUnsubscribe,
  ToolPostPayload,
  TurnEndPayload,
  TurnStartPayload,
} from './lifecycle-hooks';

// ─── Snapshot ──────────────────────────────────────────────

export interface HealthSnapshot {
  /** turn.start 次数 */
  turnStartCount: number;
  /** turn.end 次数 */
  turnEndCount: number;
  /** tool.pre 次数 */
  toolPreCount: number;
  /** tool.post 次数 */
  toolPostCount: number;
  /** tool.post 且 isError 次数 */
  toolErrorCount: number;
  /**
   * pre 后尚未 post 的调用数（block 跳过 post，或仍在执行中）。
   * 稳定跑完后 ≈ 被 block 的工具数。
   */
  toolOpenCount: number;
  /**
   * 估算 block 率：toolOpenCount / toolPreCount（pre=0 时为 0）。
   * 完成态下反映 block；有 in-flight 时会偏高。
   */
  toolBlockRate: number;
  /** 已完成 turn 的时长总和（ms） */
  turnDurationMsTotal: number;
  /** 已完成 turn 的平均时长（ms）；无完成 turn 时为 null */
  turnDurationMsAvg: number | null;
  /** 最近一次完成 turn 的时长（ms） */
  lastTurnDurationMs: number | null;
  /** 连续 tool 错误次数（成功 post 清零） */
  consecutiveToolErrors: number;
  /** 历史最大连续 tool 错误 */
  maxConsecutiveToolErrors: number;
  /** context.compact.start 次数（W6-8 / W7-1） */
  compactStartCount: number;
  /** context.compact.end 次数（含 success + abort） */
  compactEndCount: number;
  /** context.compact.end 且 aborted 次数 */
  compactAbortCount: number;
  /** 最近一次 compact end 的 durationMs（payload 无则 null） */
  lastCompactDurationMs: number | null;
}

function emptySnapshot(): HealthSnapshot {
  return {
    turnStartCount: 0,
    turnEndCount: 0,
    toolPreCount: 0,
    toolPostCount: 0,
    toolErrorCount: 0,
    toolOpenCount: 0,
    toolBlockRate: 0,
    turnDurationMsTotal: 0,
    turnDurationMsAvg: null,
    lastTurnDurationMs: null,
    consecutiveToolErrors: 0,
    maxConsecutiveToolErrors: 0,
    compactStartCount: 0,
    compactEndCount: 0,
    compactAbortCount: 0,
    lastCompactDurationMs: null,
  };
}

// ─── Pack ──────────────────────────────────────────────────

/**
 * 内置健康观测包：register → 只 observe；getHealthSnapshot / reset / dispose。
 */
export class HealthHookPack {
  private turnStartCount = 0;
  private turnEndCount = 0;
  private toolPreCount = 0;
  private toolPostCount = 0;
  private toolErrorCount = 0;
  private turnDurationMsTotal = 0;
  private lastTurnDurationMs: number | null = null;
  private consecutiveToolErrors = 0;
  private maxConsecutiveToolErrors = 0;
  private compactStartCount = 0;
  private compactEndCount = 0;
  private compactAbortCount = 0;
  private lastCompactDurationMs: number | null = null;

  /** sessionId:turnIndex → startedAt ms */
  private readonly turnStartedAt = new Map<string, number>();
  /** toolCallId → true while awaiting post */
  private readonly openToolCalls = new Set<string>();

  private unsubs: LifecycleUnsubscribe[] = [];
  private attached = false;

  /** 将 observe-only handlers 挂到 registry（可重复调用；已 attach 则 no-op） */
  register(registry: LifecycleHookRegistry): this {
    if (this.attached) return this;
    this.attached = true;

    this.unsubs.push(
      registry.observe('turn.start', (p) => {
        this.onTurnStart(p);
      }),
    );
    this.unsubs.push(
      registry.observe('turn.end', (p) => {
        this.onTurnEnd(p);
      }),
    );
    this.unsubs.push(
      registry.observe('tool.pre', (p) => {
        this.toolPreCount += 1;
        this.openToolCalls.add(p.toolCallId);
      }),
    );
    this.unsubs.push(
      registry.observe('tool.post', (p) => {
        this.onToolPost(p);
      }),
    );
    // W7-1: context.compact.* observe-only（不 block）
    this.unsubs.push(
      registry.observe('context.compact.start', () => {
        this.compactStartCount += 1;
      }),
    );
    this.unsubs.push(
      registry.observe('context.compact.end', (p) => {
        this.onCompactEnd(p);
      }),
    );

    return this;
  }

  /** 取消 observe 订阅（计数保留，可再 register 到新 registry） */
  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.attached = false;
  }

  /** 清零计数与 open 集合（不取消订阅） */
  reset(): void {
    this.turnStartCount = 0;
    this.turnEndCount = 0;
    this.toolPreCount = 0;
    this.toolPostCount = 0;
    this.toolErrorCount = 0;
    this.turnDurationMsTotal = 0;
    this.lastTurnDurationMs = null;
    this.consecutiveToolErrors = 0;
    this.maxConsecutiveToolErrors = 0;
    this.compactStartCount = 0;
    this.compactEndCount = 0;
    this.compactAbortCount = 0;
    this.lastCompactDurationMs = null;
    this.turnStartedAt.clear();
    this.openToolCalls.clear();
  }

  getHealthSnapshot(): HealthSnapshot {
    const open = this.openToolCalls.size;
    const pre = this.toolPreCount;
    const completedTurns = this.turnEndCount;
    return {
      turnStartCount: this.turnStartCount,
      turnEndCount: this.turnEndCount,
      toolPreCount: pre,
      toolPostCount: this.toolPostCount,
      toolErrorCount: this.toolErrorCount,
      toolOpenCount: open,
      toolBlockRate: pre > 0 ? open / pre : 0,
      turnDurationMsTotal: this.turnDurationMsTotal,
      turnDurationMsAvg: completedTurns > 0 ? this.turnDurationMsTotal / completedTurns : null,
      lastTurnDurationMs: this.lastTurnDurationMs,
      consecutiveToolErrors: this.consecutiveToolErrors,
      maxConsecutiveToolErrors: this.maxConsecutiveToolErrors,
      compactStartCount: this.compactStartCount,
      compactEndCount: this.compactEndCount,
      compactAbortCount: this.compactAbortCount,
      lastCompactDurationMs: this.lastCompactDurationMs,
    };
  }

  private onTurnStart(p: TurnStartPayload): void {
    this.turnStartCount += 1;
    this.turnStartedAt.set(turnKey(p.sessionId, p.turnIndex), Date.now());
  }

  private onTurnEnd(p: TurnEndPayload): void {
    this.turnEndCount += 1;
    const key = turnKey(p.sessionId, p.turnIndex);
    const started = this.turnStartedAt.get(key);
    if (started !== undefined) {
      const duration = Math.max(0, Date.now() - started);
      this.turnDurationMsTotal += duration;
      this.lastTurnDurationMs = duration;
      this.turnStartedAt.delete(key);
    }
  }

  private onToolPost(p: ToolPostPayload): void {
    this.toolPostCount += 1;
    this.openToolCalls.delete(p.toolCallId);
    if (p.isError) {
      this.toolErrorCount += 1;
      this.consecutiveToolErrors += 1;
      if (this.consecutiveToolErrors > this.maxConsecutiveToolErrors) {
        this.maxConsecutiveToolErrors = this.consecutiveToolErrors;
      }
    } else {
      this.consecutiveToolErrors = 0;
    }
  }

  private onCompactEnd(p: ContextCompactEndPayload): void {
    this.compactEndCount += 1;
    if (p.aborted) {
      this.compactAbortCount += 1;
    }
    if (p.durationMs !== undefined) {
      this.lastCompactDurationMs = p.durationMs;
    }
  }
}

function turnKey(sessionId: string, turnIndex: number): string {
  return `${sessionId}:${turnIndex}`;
}

// ─── Factory ───────────────────────────────────────────────

/**
 * 注册内置 health observe hooks，返回 pack（可 getHealthSnapshot / reset / dispose）。
 *
 * 仅 observe，不参与 block/stop/terminate。
 */
export function registerBuiltinHealthHooks(registry: LifecycleHookRegistry): HealthHookPack {
  const pack = new HealthHookPack();
  pack.register(registry);
  return pack;
}

/** 空快照（测试 / 文档示例） */
export function emptyHealthSnapshot(): HealthSnapshot {
  return emptySnapshot();
}
