/**
 * 归一器与生成类型漂移锁定（T-F 06 T4.1/T4.2/T4.4，对齐 04 方案步骤 5）：
 *
 * 双轨机制（eventParser.ts）：strict 生成 parser（parseEngineEvent）优先，
 * 宽容归一器（ENGINE_NORMALIZERS）兜底，legacy 信封（subagent-* / error）
 * 直出，未知 parseErr 显式登记。
 *
 * 本测试锁定四件事：
 * 1. **键集双向**：ENGINE_NORMALIZERS 键集 ∖ 4 历史别名（text-delta /
 *    run-completed / run-failed / run-cancelled）== ENGINE_EVENT_TYPES ∖ 3
 *    subagent-*（走 legacy 信封、不要求归一器）——新增事件类型缺归一器即红；
 * 2. **样本回归基线**：每条归一器选代表性样本（含边界），输出经生成 parser
 *    （parseEngineEvent）运行时校验通过 + expectTypeOf 类型级相等——事件面
 *    回归基线，后续 Rust 新枚举/新字段变更必须同步补样本；
 * 3. **静默默认值可观测**（T4.2）：非安全向兜底（normalizeRunTerminal 未知
 *    terminal / toolCategoryOr 未知 category）进兜底时有日志；安全向
 *    （security-audit operation/decision fail-closed）保留兜底 + 日志锁定；
 * 4. **深度守卫**（T4.4）：normalizeDeltaBlock / normalizeBatchCalls 257 层
 *    拒绝、256 层放行（复用生成 parser 256 层常量语义），不依赖顶层 catch。
 *
 * 有效性自证：故意改任一侧（Rust 新增事件类型不补归一器 / 删归一器 /
 * 改样本输出形状）立即红。
 */
import {
  beforeEach,
  afterEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import { ENGINE_NORMALIZERS, parseBridgeEvent } from './eventParser';
import {
  ENGINE_EVENT_TYPES,
  parseEngineEvent,
  type EngineEvent,
} from '../../../../../../packages/shared-types/src/generated/engine';

/** 历史别名（宽容形态映射到 canonical 类型，不要求出现在生成类型键集） */
const HISTORICAL_ALIASES: readonly string[] = [
  'text-delta',
  'run-completed',
  'run-failed',
  'run-cancelled',
];
/** subagent-* 走 legacy 信封（eventParser.ts:901-903），不要求归一器 */
const LEGACY_TYPES: readonly string[] = [
  'subagent-started',
  'subagent-event',
  'subagent-ended',
];

/** 每条归一器的代表性样本输入（宽容形态：缺信封字段，强制走归一器路径） */
const NORMALIZER_SAMPLES: Record<string, Record<string, unknown>> = {
  'agent-start': { type: 'agent-start', sessionId: 's1', timestamp: 't1' },
  'agent-end': {
    type: 'agent-end',
    sessionId: 's1',
    timestamp: 't1',
    reason: 'stop',
  },
  'turn-start': {
    type: 'turn-start',
    sessionId: 's1',
    turnIndex: 0,
    timestamp: 't1',
  },
  'turn-end': {
    type: 'turn-end',
    sessionId: 's1',
    turnIndex: 0,
    timestamp: 't1',
    toolCallCount: 0,
  },
  'message-start': {
    type: 'message-start',
    sessionId: 's1',
    message: { id: 'm1', role: 'assistant', createdAt: 't1', blocks: [] },
  },
  'message-delta': {
    type: 'message-delta',
    messageId: 'm1',
    block: { type: 'text', text: 'hi' },
  },
  'text-delta': { type: 'text-delta', text: 'hi' },
  'message-end': {
    type: 'message-end',
    sessionId: 's1',
    message: {
      id: 'm1',
      role: 'assistant',
      createdAt: 't1',
      content: 'hi',
      blocks: [],
    },
  },
  'tool-start': {
    type: 'tool-start',
    batchId: 'b1',
    call: { id: 'tc1', toolName: 'read' },
  },
  'tool-update': {
    type: 'tool-update',
    batchId: 'b1',
    toolCallId: 'tc1',
    update: { partialArgs: '{}' },
  },
  'tool-end': {
    type: 'tool-end',
    batchId: 'b1',
    result: { id: 'tc1', output: 'ok' },
  },
  'tool-batch-start': {
    type: 'tool-batch-start',
    batchId: 'b1',
    summary: 's',
    calls: [{ id: 'tc1', toolName: 'read' }],
  },
  'tool-batch-end': {
    type: 'tool-batch-end',
    batchId: 'b1',
    calls: [{ id: 'tc1', output: 'ok' }],
  },
  'tool-input-repaired': {
    type: 'tool-input-repaired',
    toolCallId: 'tc1',
    toolName: 'read',
    notes: ['n'],
  },
  'context-compression-start': {
    type: 'context-compression-start',
    sessionId: 's1',
    timestamp: 't1',
    reason: 'r',
    tokensBefore: 1,
  },
  'context-compression-end': {
    type: 'context-compression-end',
    sessionId: 's1',
    timestamp: 't1',
    aborted: false,
  },
  'provider-diagnostic': {
    type: 'provider-diagnostic',
    sessionId: 's1',
    timestamp: 't1',
    diagnostic: { phase: 'request-start' },
  },
  'runtime-error': {
    type: 'runtime-error',
    sessionId: 's1',
    timestamp: 't1',
    error: 'boom',
  },
  'runtime-steering': {
    type: 'runtime-steering',
    sessionId: 's1',
    timestamp: 't1',
    reason: 'r',
    message: { id: 'm1', role: 'assistant', createdAt: 't1', blocks: [] },
  },
  'runtime-intervention-required': {
    type: 'runtime-intervention-required',
    sessionId: 's1',
    timestamp: 't1',
    reason: 'r',
    choices: ['a'],
    message: 'm',
  },
  'approval-requested': {
    type: 'approval-requested',
    sessionId: 's1',
    timestamp: 't1',
    request: { toolCallId: 'tc1', toolName: 'read', parameters: {} },
  },
  'approval-resolved': {
    type: 'approval-resolved',
    sessionId: 's1',
    timestamp: 't1',
    toolCallId: 'tc1',
    decision: 'approved',
  },
  'checkpoint-created': {
    type: 'checkpoint-created',
    sessionId: 's1',
    timestamp: 't1',
    checkpoint: {
      id: 'c1',
      kind: 'workspace-checkpoint',
      label: 'l',
      toolCallId: 'tc1',
      toolName: 'checkpoint',
    },
  },
  'checkpoint-restored': {
    type: 'checkpoint-restored',
    sessionId: 's1',
    timestamp: 't1',
    restore: {
      checkpointId: 'c1',
      toolCallId: 'tc1',
      toolName: 'checkpoint',
      restored: [],
      deleted: [],
      skipped: [],
    },
  },
  'run-terminal': { type: 'run-terminal', terminal: 'completed' },
  'run-completed': { type: 'run-completed', terminal: 'completed' },
  'run-failed': { type: 'run-failed' },
  'run-cancelled': { type: 'run-cancelled' },
  'cache-stats-updated': {
    type: 'cache-stats-updated',
    sessionId: 's1',
    stats: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  },
  'cache-waste-alert': {
    type: 'cache-waste-alert',
    sessionId: 's1',
    attribution: 'context',
    missedTokens: 1,
    idleMs: 1,
    modelChanged: false,
  },
  'cold-cache-warning': {
    type: 'cold-cache-warning',
    sessionId: 's1',
    ttlSeconds: 1,
    idleMs: 1,
    resendEstimateTokens: 1,
  },
  'security-audit': {
    type: 'security-audit',
    sessionId: 's1',
    operation: 'delete',
    targets: ['a'],
    impact: {},
    decision: 'blocked',
  },
  'task-started': {
    type: 'task-started',
    taskId: 't1',
    command: 'cmd',
    cwd: '.',
    ownerRunId: 'r1',
    isDaemon: false,
  },
  'task-output': { type: 'task-output', taskId: 't1', line: 'l' },
  'task-heartbeat': {
    type: 'task-heartbeat',
    taskId: 't1',
    resource: { cpu: 1 },
  },
  'task-suspicious': {
    type: 'task-suspicious',
    taskId: 't1',
    silenceMs: 1,
    lastOutputAtMs: 1,
  },
  'task-completed': {
    type: 'task-completed',
    taskId: 't1',
    exitCode: 0,
    durationMs: 1,
    lineCount: 1,
  },
  'task-failed': {
    type: 'task-failed',
    taskId: 't1',
    exitCode: 1,
    tail: ['x'],
    durationMs: 1,
  },
  'task-killed': { type: 'task-killed', taskId: 't1', viaForce: false },
  'timer-fired': {
    type: 'timer-fired',
    timerId: 'tm1',
    prompt: 'p',
    firedAtMs: 1,
  },
  'timer-cancelled': {
    type: 'timer-cancelled',
    timerId: 'tm1',
    reason: 'cancelled',
    cancelledAtMs: 1,
  },
  'cron-fired': {
    type: 'cron-fired',
    cronId: 'c1',
    prompt: 'p',
    expression: '* * * * *',
    iteration: 1,
    firedAtMs: 1,
  },
  // ── 连续性域 8 事件（D8 登记面 41→49；样本与 events-v1 fixture 同形）──
  'recovery-escalated': {
    type: 'recovery-escalated',
    sessionId: 's1',
    subagentRunId: 'r1',
    kind: 'timeout',
    retries: 2,
    elapsedMs: 1500,
  },
  'recovery-steering': {
    type: 'recovery-steering',
    sessionId: 's1',
    subagentId: 'a1',
    subagentRunId: 'r1',
    fingerprint: 'fp-1',
    retries: 1,
    remainingStatus: 'queued',
    pending: true,
    createdAtMs: 1,
  },
  'recovery-fork': {
    type: 'recovery-fork',
    sessionId: 's1',
    fingerprint: 'fp-1',
    subagentId: 'a1',
    fromRunId: 'r1',
    fromLeafId: 'l1',
    newRunId: 'r2',
    newLeafId: 'l2',
    contextMode: 'verbatim',
  },
  'recovery-report': {
    type: 'recovery-report',
    sessionId: 's1',
    subagentId: 'a1',
    subagentRunId: 'r1',
    stuckAtMs: 1,
    suggestion: 'retry',
  },
  'recovery-budget-denied': {
    type: 'recovery-budget-denied',
    sessionId: 's1',
    subagentRunId: 'r1',
    fingerprint: 'fp-1',
    count: 3,
    max: 2,
  },
  'goal-round-started': {
    type: 'goal-round-started',
    sessionId: 's1',
    round: 1,
    maxRounds: 12,
    goal: 'fix build',
  },
  'goal-round-completed': {
    type: 'goal-round-completed',
    sessionId: 's1',
    round: 1,
    toolCallCount: 2,
    toolSuccessCount: 1,
    messageCount: 3,
    decision: 'Continue',
    reasonDetail: '',
    stalledDelta: 0,
    evidence: '',
  },
  'goal-continuation-decided': {
    type: 'goal-continuation-decided',
    sessionId: 's1',
    action: 'continue',
    reason: 'in-progress',
    prompt: '继续',
  },
};

describe('T-F 06 T4.1：归一器键集与生成事件类型双向锁定', () => {
  it('归一器键集 ∖ 历史别名 == ENGINE_EVENT_TYPES ∖ legacy（subagent-*）', () => {
    const normalizerKeys = new Set(Object.keys(ENGINE_NORMALIZERS));
    const canonicalKeys = new Set(
      ENGINE_EVENT_TYPES.filter((t) => !LEGACY_TYPES.includes(t))
    );
    for (const alias of HISTORICAL_ALIASES) {
      expect(
        normalizerKeys.has(alias),
        `历史别名 ${alias} 必须保留在归一器表`
      ).toBe(true);
      normalizerKeys.delete(alias);
    }
    // 新增事件类型若缺归一器 → 红（把「新增事件流程」从人肉检查变测试强制）
    const missing = [...canonicalKeys].filter((k) => !normalizerKeys.has(k));
    expect(
      missing,
      `生成类型新增事件缺归一器：${missing.join(', ')}（必须补归一器 + 样本）`
    ).toEqual([]);
    // 归一器侧多出的 canonical 键（生成类型已删除 → 归一器需同步删）
    const extra = [...normalizerKeys].filter((k) => !canonicalKeys.has(k));
    expect(
      extra,
      `归一器表含已删除/未登记事件：${extra.join(', ')}（需同步删除）`
    ).toEqual([]);
    // legacy 三键走 legacy 信封，不要求归一器（显式声明）
    for (const t of LEGACY_TYPES) {
      expect(ENGINE_EVENT_TYPES).toContain(t);
    }
  });

  it('每条归一器代表性样本 → parseBridgeEvent ok 且 type 匹配', () => {
    for (const [type, raw] of Object.entries(NORMALIZER_SAMPLES)) {
      const r = parseBridgeEvent(raw);
      expect(r.ok, `归一器样本 ${type} 应解析成功`).toBe(true);
      if (r.ok && r.data.kind === 'engine') {
        expect(r.data.event.type, `样本 ${type} 的 canonical 类型`).toBe(
          type === 'text-delta'
            ? 'message-delta'
            : type.startsWith('run-completed') ||
                type.startsWith('run-failed') ||
                type.startsWith('run-cancelled')
              ? 'run-terminal'
              : type
        );
      }
    }
  });

  it('样本输出经生成 parser 运行时校验通过（事件面回归基线）', () => {
    for (const [type, raw] of Object.entries(NORMALIZER_SAMPLES)) {
      const r = parseBridgeEvent(raw);
      expect(r.ok, `样本 ${type} 解析`).toBe(true);
      if (!r.ok || r.data.kind !== 'engine') continue;
      const event = r.data.event;
      const parsed = parseEngineEvent(event);
      expect(
        parsed.ok,
        `样本 ${type} 输出必须通过生成 parser（形状漂移即红）：${
          parsed.ok ? '' : parsed.error
        }`
      ).toBe(true);
    }
  });

  it('expectTypeOf：归一器输出与生成 EngineEvent 联合类型相等（类型级双端）', () => {
    // 每个归一器样本输出都必须落在生成 EngineEvent 联合内（编译期强制，
    // 手写归一器形状与生成类型漂移立即红）
    for (const [_type, raw] of Object.entries(NORMALIZER_SAMPLES)) {
      const r = parseBridgeEvent(raw);
      expect(r.ok).toBe(true);
      if (r.ok && r.data.kind === 'engine') {
        const event = r.data.event;
        expectTypeOf(event).toMatchTypeOf<EngineEvent>();
      }
    }
  });
});

describe('T-F 06 T4.2：静默默认值可观测（非安全向显式登记）', () => {
  // logInternalError 实现 = console.warn（userFacingErrors.ts:244-249），
  // 以 console.warn spy 观测「进兜底时有日志」。
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizeRunTerminal 未知 terminal → 日志后回退 completed（不再静默）', () => {
    const r = parseBridgeEvent({
      type: 'run-terminal',
      terminal: 'mystery-status',
    });
    expect(console.warn).toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.event.type).toBe('run-terminal');
      // 回退值 completed 仍是规范值（消费方宽容度：不破坏生成类型）
      expect((r.data.event as { terminal?: string }).terminal).toBe(
        'completed'
      );
    }
  });

  it('toolCategoryOr 未知 category → 日志后回退 terminal（不再静默）', () => {
    const r = parseBridgeEvent({
      type: 'tool-batch-start',
      calls: [{ id: 'tc1', toolName: 'read', category: 'mystery-cat' }],
    });
    expect(console.warn).toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });

  it('security-audit 安全向 fail-closed 保留兜底（operation→command-exec / decision→denied）', () => {
    // 安全向兜底行为不变（fail-closed）：未知值仍回退 command-exec / denied
    const r = parseBridgeEvent({
      type: 'security-audit',
      operation: 'mystery-op',
      decision: 'mystery-decision',
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      const e = r.data.event as {
        operation?: string;
        decision?: string;
      };
      expect(e.operation).toBe('command-exec');
      expect(e.decision).toBe('denied');
    }
  });
});

describe('T-F 06 T4.4：宽容路径深度守卫（256 层放行 / 257 层拒绝）', () => {
  function deepJson(depth: number): unknown {
    let v: unknown = 'leaf';
    for (let i = 0; i < depth; i++) v = { child: v };
    return v;
  }

  it('normalizeDeltaBlock：深层载荷（256 层嵌套 text，总深 257）回退空 text 块（不抛、不依赖顶层 catch）', () => {
    const r = parseBridgeEvent({
      type: 'message-delta',
      block: { type: 'text', text: deepJson(256) as unknown as string },
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      const block = (
        r.data.event as { block?: { type?: string; text?: string } }
      ).block;
      expect(block?.type).toBe('text');
      expect(block?.text).toBe('');
    }
  });

  it('normalizeDeltaBlock：255 层嵌套 text（总深 256）放行（边界语义对齐生成 parser）', () => {
    const r = parseBridgeEvent({
      type: 'message-delta',
      block: { type: 'text', text: deepJson(255) as unknown as string },
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect((r.data.event as { block?: { type?: string } }).block?.type).toBe(
        'text'
      );
    }
  });

  it('normalizeBatchCalls：深层载荷（300 层 input）回退 null（调用方回退空数组 + 日志）', () => {
    const r = parseBridgeEvent({
      type: 'tool-batch-start',
      calls: [{ id: 'tc1', toolName: 'read', input: deepJson(300) }],
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect((r.data.event as { calls?: unknown }).calls).toEqual([]);
    }
  });

  it('normalizeBatchCalls：正常浅载荷放行（深度守卫不误伤正常载荷）', () => {
    const input = deepJson(50);
    const r = parseBridgeEvent({
      type: 'tool-batch-start',
      calls: [{ id: 'tc1', toolName: 'read', input }],
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect((r.data.event as { calls?: unknown[] }).calls).toHaveLength(1);
    }
  });
});
